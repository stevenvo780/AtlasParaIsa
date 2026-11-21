import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../src/server/store.js';
import { encodeSnapshotTileRows } from '../src/server/snapshot.js';
import { SNAPSHOT_PAGE_TILES } from '../src/server/snapshot-parts.js';
import { bindWorldContext, createWorld, stepWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { paramsOf, parseParams } from '../src/world/params.js';
import { ResidentTopologyOwner } from '../src/world/soa/topologia.js';
import { activate, worldContext } from '../src/world/spatial.js';

/** Last commit before the save fast paths: the persisted bytes must not change at all. */
const BASE = 'f53bdc9';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_FILES = ['src/server/store.ts', 'src/server/snapshot.ts', 'src/server/snapshot-parts.ts', 'src/shared/exact-json.ts'];
type StoreClass = typeof Store;

/** The baseline persistence modules, run against the CURRENT world modules (same WeakMaps and laws).
 * `.mts` keeps them ESM; every other import resolves to the absolute path of the current source. */
async function baselineStore(): Promise<StoreClass | null> {
  const sources = new Map<string, string>();
  try {
    for (const file of BASELINE_FILES) sources.set(file, execFileSync('git', ['show', `${BASE}:${file}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return null; }
  const directory = mkdtempSync(join(tmpdir(), 'atlas-store-baseline-'));
  process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
  const copy = (file: string) => join(directory, file.replaceAll('/', '__').replace(/\.ts$/, '.mts'));
  for (const [file, body] of sources) {
    const rewritten = body.replace(/(from\s+['"])(\.[^'"]+)(['"])/g, (_match, prefix: string, relative: string, suffix: string) => {
      const target = resolve(ROOT, dirname(file), relative).slice(ROOT.length + 1).replace(/\.js$/, '.ts');
      const url = sources.has(target) ? pathToFileURL(copy(target)).href : pathToFileURL(resolve(ROOT, dirname(file), relative)).href;
      return `${prefix}${url}${suffix}`;
    });
    writeFileSync(copy(file), rewritten);
  }
  return (await import(pathToFileURL(copy('src/server/store.ts')).href) as { Store: StoreClass }).Store;
}
const Baseline = await baselineStore();

const params = parseParams('persistencia.cadaTicks=100,persistencia.ventanaEventosTicks=2400,limites.chunks=512,limites.teselasActivas=131072');

function resident(world: World): World {
  const owner = new ResidentTopologyOwner();
  world.tiles = owner.tiles(world.tiles.map(tile => owner.tile(tile)));
  bindWorldContext(world, { ...worldContext(world), tileOwnership: owner });
  return world;
}

/** Deterministic outward ring of chunks around the first inhabitant, until `count` active tiles. */
function grow(world: World, count: number): void {
  const anchor = world.people[0]!;
  for (let ring = 1; world.tiles.length < count; ring++)
    for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++)
      if (Math.max(Math.abs(dx), Math.abs(dy)) === ring && world.tiles.length < count) activate(world, anchor.x + dx * 16, anchor.y + dy * 16);
}

/** Every durable table, byte for byte, except the wall-clock `saved_at`. */
function durable(store: Store): string {
  const tables = store.db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[];
  return JSON.stringify(tables.map(({ name }) => [name, (store.db.prepare(`SELECT * FROM main."${name}" ORDER BY rowid`).all() as Record<string, unknown>[])
    .map(row => Object.entries(row).filter(([key]) => !(name === 'snapshots' && key === 'saved_at')))]));
}

function laboratory(t: TestContext, Implementation: StoreClass, options: { snapshotInlineTileLimit?: number }) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-store-parity-')), path = join(directory, 'world.sqlite');
  const store = new Implementation(path, options);
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  return { path, store };
}

interface Scenario { name: string; residentTiles: boolean; inlineLimit?: number; tiles?: number; saves: number }
const scenarios: Scenario[] = [
  { name: 'en línea', residentTiles: false, saves: 12 },
  { name: 'en línea con ResidentTopologyOwner', residentTiles: true, saves: 12 },
  { name: 'paginado (umbral 0) con ResidentTopologyOwner', residentTiles: true, inlineLimit: 0, saves: 12 },
  { name: 'paginado por tamaño (40 000 teselas) con ResidentTopologyOwner', residentTiles: true, tiles: 40_000, saves: 4 },
];

for (const scenario of scenarios) {
  test(`guardado: bytes idénticos a ${BASE} — ${scenario.name}`, { skip: Baseline ? false : `sin el commit ${BASE}` }, t => {
    const options = scenario.inlineLimit === undefined ? {} : { snapshotInlineTileLimit: scenario.inlineLimit };
    const before = laboratory(t, Baseline!, options), after = laboratory(t, Store, options);
    const worlds = [createWorld(2002, params), createWorld(2002, params)].map(world => scenario.residentTiles ? resident(world) : world);
    for (let save = 0; save < scenario.saves; save++) {
      for (const [index, world] of worlds.entries()) {
        if (save > 0) for (let tick = 0; tick < paramsOf(world).persistencia.cadaTicks; tick++) stepWorld(world, []);
        if (scenario.tiles) grow(world, scenario.tiles);
        (index === 0 ? before : after).store.save(world);
      }
      assert.equal(digestoCanonico(worlds[1]!), digestoCanonico(worlds[0]!), `mismo mundo tras el guardado ${save}`);
      assert.equal(durable(after.store), durable(before.store), `mismas filas durables tras el guardado ${save}`);
    }
    const paged = (after.store.db.prepare('SELECT COUNT(*) AS n FROM snapshot_parts').get() as { n: number }).n > 0;
    assert.equal(paged, scenario.inlineLimit === 0 || !!scenario.tiles, 'el escenario ejercita el transporte que nombra');
    // Cold load, crossed: each implementation reads the other's file to the same world.
    const committed = digestoCanonico(worlds[1]!);
    before.store.close(); after.store.close();
    for (const [Implementation, path] of [[Store, before.path], [Store, after.path], [Baseline!, after.path]] as const) {
      const reader = new Implementation(path, { ...options, readOnly: true });
      try { assert.equal(digestoCanonico(reader.load()!.world), committed, 'la carga fría reconstruye el mundo guardado'); }
      finally { reader.close(); }
    }
  });
}

/** External damage applied identically to both files just before a paged save. Each case names the
 * outcome the baseline produces, so it proves that it reaches the guard it is about. */
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
/** The first page the next save of `world` writes: a planted row under its digest is a reused page. */
function nextPage(world: World): { digest: string; body: string } {
  const body = JSON.stringify(encodeSnapshotTileRows(world.tiles.slice(0, SNAPSHOT_PAGE_TILES)));
  return { digest: sha256(body), body };
}
/** Slot 2 becomes `body` (an SQL expression over slot 0's row), sealed with the digest of what node:sqlite reads. */
function backup(store: Store, body: string): void {
  store.db.exec(`INSERT OR REPLACE INTO snapshots SELECT 2,${body},'',0 FROM snapshots WHERE slot=0`);
  const read = (store.db.prepare('SELECT body FROM snapshots WHERE slot=2').get() as { body: string | Uint8Array }).body;
  store.db.prepare('UPDATE snapshots SET digest=? WHERE slot=2').run(sha256(read));
}
/** Pages no readable manifest references: zero once collection ran, the previous checkpoint's when it held back. */
function orphans(store: Store): number {
  const referenced = new Set<string>();
  for (const { body } of store.db.prepare('SELECT body FROM snapshots').all() as { body: unknown }[]) {
    try { for (const page of (JSON.parse(String(body)) as { tiles: { pages: { digest: string }[] } }).tiles.pages) referenced.add(page.digest); }
    catch { /* an unreadable backup references nothing provable */ }
  }
  return (store.db.prepare('SELECT digest FROM snapshot_parts').all() as { digest: string }[]).filter(row => !referenced.has(row.digest)).length;
}
const invalidUtf8InName = `CAST(substr(CAST(body AS BLOB),1,instr(CAST(body AS BLOB),CAST('"name":"' AS BLOB))+7)||x'ff'
  ||substr(CAST(body AS BLOB),instr(CAST(body AS BLOB),CAST('"name":"' AS BLOB))+8) AS TEXT)`;
const damages: [string, { error?: RegExp; collected?: boolean }, (store: Store, world: World) => void][] = [
  ['página reutilizada con otro cuerpo', { error: /existing page disagrees/ }, (store, world) => {
    const page = nextPage(world);
    store.db.prepare('INSERT INTO snapshot_parts VALUES (?,?)').run(page.digest, `${page.body} `);
  }],
  ['página reutilizada guardada como BLOB', { error: /existing page disagrees/ }, (store, world) => {
    const page = nextPage(world);
    store.db.prepare('INSERT INTO snapshot_parts VALUES (?,?)').run(page.digest, Buffer.from(page.body));
  }],
  ['página reutilizada en mayúsculas bajo COLLATE NOCASE', { error: /existing page disagrees/ }, (store, world) => {
    store.db.exec(`CREATE TABLE parts_nocase (digest TEXT PRIMARY KEY NOT NULL, body TEXT COLLATE NOCASE NOT NULL);
      INSERT INTO parts_nocase SELECT digest,body FROM snapshot_parts; DROP TABLE snapshot_parts; ALTER TABLE parts_nocase RENAME TO snapshot_parts;`);
    const page = nextPage(world);
    store.db.prepare('INSERT INTO snapshot_parts VALUES (?,?)').run(page.digest, page.body.toUpperCase());
  }],
  ['respaldo con NUL tras un manifiesto completo', { collected: true }, store => backup(store, 'body||char(0)')],
  ['respaldo con NUL cuyo digest es el del texto truncado', { collected: false }, store => backup(store, "substr(body,1,64)||char(0)||'x'")],
  ['respaldo con UTF-8 inválido dentro de un nombre', { collected: true }, store => backup(store, invalidUtf8InName)],
  ['respaldo con UTF-8 inválido ilegible', { collected: false }, store => backup(store, "CAST(x'7bc3287d' AS TEXT)")],
  ['respaldo como BLOB UTF-8 válido', { collected: true }, store => backup(store, 'CAST(body AS BLOB)')],
  ['respaldo íntegro: copia del slot 0', { collected: true }, store => store.db.exec('INSERT OR REPLACE INTO snapshots SELECT 2,body,digest,saved_at FROM snapshots WHERE slot=0')],
  ['respaldo con digest roto', { collected: false }, store => store.db.exec("INSERT OR REPLACE INTO snapshots SELECT 2,body,'0',saved_at FROM snapshots WHERE slot=0")],
];
for (const [label, expected, damage] of damages) {
  test(`guardado paginado tras daño externo idéntico a ${BASE}: ${label}`, { skip: Baseline ? false : `sin el commit ${BASE}` }, t => {
    const before = laboratory(t, Baseline!, { snapshotInlineTileLimit: 0 }), after = laboratory(t, Store, { snapshotInlineTileLimit: 0 });
    const outcomes = [before, after].map(({ store }) => {
      const world = resident(createWorld(2002, params));
      const advance = () => { for (let tick = 0; tick < 100; tick++) stepWorld(world, []); };
      // Three distinct checkpoints: the next save leaves the oldest one's pages unreferenced.
      store.save(world); advance(); store.save(world); advance(); store.save(world); advance();
      damage(store, world);
      let error: string | null = null;
      try { store.save(world); } catch (caught) { error = (caught as Error).message; }
      return { error, tables: durable(store), orphans: orphans(store) };
    });
    if (expected.error) assert.match(outcomes[0]!.error ?? '', expected.error, 'la base rechaza el guardado en esta guarda');
    else {
      assert.equal(outcomes[0]!.error, null);
      assert.equal(outcomes[0]!.orphans === 0, expected.collected, expected.collected ? 'la base recolecta' : 'la base retiene las páginas');
    }
    assert.equal(outcomes[1]!.error, outcomes[0]!.error, 'el mismo rechazo (o el mismo éxito)');
    assert.equal(outcomes[1]!.tables, outcomes[0]!.tables, 'las mismas filas durables después');
  });
}

/** ms/save, both implementations on the same world state, a few ticks apart. Informative, not a gate. */
for (const tiles of [12_288, 40_000]) {
  test(`guardado: banco ANTES/DESPUÉS a ${tiles} teselas`, { skip: Baseline ? false : `sin el commit ${BASE}` }, t => {
    const rounds = 5, timings: Record<string, number[]> = { antes: [], despues: [] };
    const labs = { antes: laboratory(t, Baseline!, {}), despues: laboratory(t, Store, {}) };
    const worlds = { antes: resident(createWorld(2002, params)), despues: resident(createWorld(2002, params)) };
    for (let round = 0; round <= rounds; round++) {
      for (const side of ['antes', 'despues'] as const) {
        const world = worlds[side];
        if (round > 0) for (let tick = 0; tick < 20; tick++) stepWorld(world, []);
        grow(world, tiles);
        const start = performance.now();
        labs[side].store.save(world);
        if (round > 0) timings[side]!.push(performance.now() - start);
      }
      assert.equal(durable(labs.despues.store), durable(labs.antes.store));
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;
    t.diagnostic(`${tiles} teselas (${worlds.despues.tiles.length} activas, ${worlds.despues.people.length} habitantes): `
      + `antes ${median(timings.antes!).toFixed(1)} ms/save, después ${median(timings.despues!).toFixed(1)} ms/save`);
  });
}
