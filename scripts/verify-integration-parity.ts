/** Control conjunto: familia V8 frente a la integración de configuración y validadores.
 * node --import tsx scripts/verify-integration-parity.ts BASELINE_DIRECTORY [ticks=1200]
 * El digesto completo incluye la configuración y permanece sin cambios. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorld, cloneWorld, stepWorld, type World } from '../src/world/index.js';
import { parseParams } from '../src/world/params.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { Store } from '../src/server/store.js';

const baseline = resolve(process.argv[2] ?? ''), ticks = Number(process.argv[3] ?? 1200);
assert.ok(process.argv[2] && Number.isSafeInteger(ticks) && ticks > 0, 'Uso: BASELINE_DIRECTORY [ticks positivos]');
const baseWorld = await import(pathToFileURL(join(baseline, 'src/world/index.ts')).href) as typeof import('../src/world/index.js');
const baseParams = await import(pathToFileURL(join(baseline, 'src/world/params.ts')).href) as typeof import('../src/world/params.js');
const baseDigest = await import(pathToFileURL(join(baseline, 'src/world/digesto.ts')).href) as typeof import('../src/world/digesto.js');
const baseStore = await import(pathToFileURL(join(baseline, 'src/server/store.ts')).href) as typeof import('../src/server/store.js');
const hash = (body: Buffer) => createHash('sha256').update(body).digest('hex');
/** Sólo el control físico: preserva bits numéricos, undefined, orden y aliases.
 * v8.serialize no es canónico: el mismo 0 puede codificarse como entero o double. */
function physicalBytes(world: World): Buffer {
  const seen = new Map<object, number>();
  const encode = (value: unknown): unknown => {
    if (value === undefined) return ['undefined'];
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
    if (typeof value === 'number') {
      const bytes = Buffer.allocUnsafe(8); bytes.writeDoubleBE(value); return ['number', bytes.toString('hex')];
    }
    assert.equal(typeof value, 'object');
    const object = value as Record<string, unknown>;
    if (seen.has(object)) return ['ref', seen.get(object)];
    seen.set(object, seen.size);
    return [Array.isArray(object) ? ['array', object.length] : 'object', Object.keys(object).map(key => [key, encode(object[key])])];
  };
  return Buffer.from(JSON.stringify(encode(world)));
}
function sourceHashes(root: string): Record<string, string> {
  const source = join(root, 'src'), result: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.ts')) result[relative(source, path)] = hash(readFileSync(path));
    }
  };
  visit(source); return result;
}
const sources = { baseline: sourceHashes(baseline), candidate: sourceHashes(process.cwd()) };
const changed = [...new Set([...Object.keys(sources.baseline), ...Object.keys(sources.candidate)])]
  .filter(key => sources.baseline[key] !== sources.candidate[key]).sort();
assert.deepEqual(changed, ['server/store.ts', 'shared/param-syntax.ts', 'world/digesto.ts', 'world/params.ts'], 'sólo los cuatro módulos revisados pueden diferir de la familia V8');
const directory = mkdtempSync(join(tmpdir(), 'atlas-integration-parity-')), results: object[] = [];
const reserved = 'motor.hilos=8,motor.gpu=[1,0],motor.clonPorPaso=false,motor.soaTerreno=true,motor.particionarPersonas=true,motor.orden=adversarial,persistencia.paginasSucias=true,red.deltas=true,limites.comunidades=12';
try {
  for (const seed of [1, 51926, 20260905]) for (const options of ['', reserved]) {
    const id = `${seed}-${options ? 'reserved' : 'defaults'}`;
    const oldStore = new baseStore.Store(join(directory, `${id}-baseline.sqlite`)), store = new Store(join(directory, `${id}-candidate.sqlite`));
    try {
      let a = baseWorld.createWorld(seed, baseParams.parseParams('persistencia.cadaTicks=20'));
      let b = createWorld(seed, parseParams(`persistencia.cadaTicks=20${options ? `,${options}` : ''}`));
      oldStore.save(a); store.save(b);
      const check = (left: World, right: World): void => {
        assert.deepEqual(right, left, `${id}: estado completo en tick ${left.tick}`);
        assert.deepEqual(physicalBytes(right), physicalBytes(left), `${id}: orden, undefined y bits del estado`);
      };
      check(a, b);
      for (let tick = 1; tick <= ticks; tick++) {
        baseWorld.stepWorld(a); stepWorld(b);
        if (tick % 20 === 0 || tick === ticks) { oldStore.save(a); store.save(b); }
        if (tick % 120 === 0 || tick === ticks) {
          check(a, b);
          const before = physicalBytes(b), draftA = baseWorld.cloneWorld(a), draftB = cloneWorld(b);
          baseWorld.stepWorld(draftA); stepWorld(draftB); check(draftA, draftB);
          assert.deepEqual(physicalBytes(b), before, 'descartar un clon conserva el confirmado');
        }
        if (tick % 600 === 0 || tick === ticks) { a = oldStore.load()!.world; b = store.load()!.world; check(a, b); }
      }
      const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'snapshots' ORDER BY name").all() as { name: string }[];
      assert.deepEqual(oldStore.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'snapshots' ORDER BY name").all(), tables);
      for (const { name } of tables) {
        assert.match(name, /^[a-z_]+$/);
        assert.deepEqual(store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),
          oldStore.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(), `${id}: archivo durable ${name}`);
      }
      const baselineDigest = baseDigest.digestoCanonico(a), candidateDigest = digestoCanonico(b);
      assert.notEqual(candidateDigest, baselineDigest, 'el digesto completo conserva los nuevos parámetros');
      results.push({ seed, mode: options ? 'reserved' : 'defaults', ticks, physicalSha256: hash(physicalBytes(b)), equalArchiveTables: tables.map(t => t.name), baselineDigest, candidateDigest });
    } finally { oldStore.close(); store.close(); }
  }
  assert.deepEqual(sourceHashes(baseline), sources.baseline); assert.deepEqual(sourceHashes(process.cwd()), sources.candidate);
  console.log(JSON.stringify({ baseline, node: process.version, changed, sources, results }, null, 2));
} finally { rmSync(directory, { recursive: true, force: true }); }
