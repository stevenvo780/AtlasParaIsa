import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { assertWorld, createWorld, type World } from '../src/world/index.js';
import { updateCommunities } from '../src/world/society.js';
import { materializeAnimals, stepAnimals, syncFauna, type AnimalWorld } from '../src/world/animals.js';
import type { Tile } from '../src/shared/types.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, paramsOf, parseParams, setParams } from '../src/world/params.js';
import { decodeSnapshot, encodeSnapshot, takeSnapshotParams, SnapshotSemanticError } from '../src/server/snapshot.js';
import { Store } from '../src/server/store.js';
import { filaInstantanea, reescribirInstantanea } from './lib/store.js';

/** `chunks` regiones completas: la geometría estructural fija 256 teselas por chunk.
 * Los cuerpos son HETEROGÉNEOS y de alta precisión a propósito: 2 M copias de una sola
 * tesela comparten forma y valores, y medir memoria sobre ellas subestima el coste real
 * (`BYTES_PER_ACTIVE_TILE` sale de esta prueba). Cada tesela lleva sus campos opcionales y
 * fracciones irracionales derivadas de su posición, dentro de los rangos de `validation.ts`. */
function wideWorld(chunks = 257): World {
  const world = createWorld(51926, parseParams({ limites: { teselasActivas: chunks * 256, chunks, comunidades: 12 } }));
  const template = world.tiles.find(tile => tile.terrain === 'meadow')!;
  for (let cx = 100; Object.keys(world.chunks).length < chunks; cx++) {
    const cy = 100, key = `${cx},${cy}`;
    world.chunks[key] = { key, cx, cy, discovered: false, places: [], lastTick: 0 };
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const tx = cx * 16 + x, ty = cy * 16 + y, n = tx * 65537 + ty * 7919;
      const fraction = (n % 1000003) / 1000003;
      world.tiles.push({ ...template, x: tx, y: ty, fauna: 0, species: undefined,
        moisture: fraction, vegetation: 1 - fraction / 3, food: fraction / 7, growth: fraction / 11,
        fertility: 1 - fraction / 5, drinkingWater: fraction / 13, cultivation: fraction / 17,
        // `-0` a propósito: el digesto lo distingue de `0` y el códec debe conservarlo.
        traffic: n % 4 === 0 ? -0 : fraction / 19, life: fraction / 23, elevation: fraction / 29,
        wood: n % 7, stone: n % 5, variety: n % 4 });
    }
  }
  return world;
}
/** Pico de RSS del proceso (`maxRSS` viene en KiB), no el instantáneo de `memoryUsage.rss()`:
 * el instantáneo ni es el máximo ni distingue qué fase lo alcanzó. Es monótono, así que
 * leerlo tras la fase escritora da el pico de ESA fase. */
const peakRssBytes = (): number => process.resourceUsage().maxRSS * 1024;
function tables(store: Store): string {
  const names = store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[];
  const hash = createHash('sha256');
  for (const { name } of names) hash.update(name).update(JSON.stringify(store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()));
  return hash.digest('hex');
}

test('T100: 65792 teselas y 257 chunks conservan el digesto confirmado al reabrir SQLite', t => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-limits-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const world = wideWorld(), path = join(directory, 'world.sqlite');
  assert.equal(world.tiles.length, 65792); assert.equal(Object.keys(world.chunks).length, 257);
  assertWorld(world);
  const store = new Store(path);
  let digest: string;
  try {
    store.save(world); digest = digestoCanonico(world);
    const manifest = JSON.parse(filaInstantanea(store).body);
    assert.equal(manifest.snapshotEncoding, 'snapshot-parts-v1');
    assert.deepEqual(manifest.world.limitsProfile, { version: 2, ...paramsOf(world).limites });
  } finally { store.close(); }
  const reopened = new Store(path);
  try { assert.equal(digestoCanonico(reopened.load()!.world), digest); }
  finally { reopened.close(); }
});

test('T100: doce comunidades son admisibles y viajan enteras en la instantánea', () => {
  const world = createWorld(51926, parseParams('limites.comunidades=12'));
  world.communities = Array.from({ length: 12 }, (_, index) => ({ id: `test-${index}`, name: `Grupo ${index}`, x: 17, y: 13,
    color: '#ffffff', members: [], culture: { sharing: 0, stewardship: 0, openness: 0 }, formedAt: 0, cooperation: 0, disputes: 0 }));
  const store = new Store(':memory:');
  try { store.save(world); assert.equal(digestoCanonico(store.load()!.world), digestoCanonico(world)); }
  finally { store.close(); }
});

for (const key of ['teselasActivas', 'chunks', 'comunidades', 'fauna'] as const) {
  test(`T100: ${key} acepta el borde y rechaza una unidad más sin escritura`, () => {
    const world = createWorld(), store = new Store(':memory:');
    if (key === 'comunidades') world.communities = [0, 1].map(index => ({ id: `test-${index}`, name: 'Grupo', x: 17, y: 13,
      color: '#ffffff', members: [], culture: { sharing: 0, stewardship: 0, openness: 0 }, formedAt: 0, cooperation: 0, disputes: 0 }));
    const count = key === 'teselasActivas' ? world.tiles.length : key === 'chunks' ? Object.keys(world.chunks).length
      : key === 'comunidades' ? world.communities.length : world.animals.length;
    const params = parseParams({ limites: { [key]: count } }); setParams(world, params);
    try {
      store.save(world); assert.equal(digestoCanonico(store.load()!.world), digestoCanonico(world));
      const before = tables(store);
      setParams(world, parseParams({ limites: { [key]: count - 1 } }, params));
      assert.throws(() => assertWorld(world)); assert.throws(() => store.save(world));
      assert.equal(tables(store), before); assert.equal(store.db.isTransaction, false);
    } finally { store.close(); }
  });
}

for (const paged of [false, true]) for (const corruption of ['unknown', 'partial', 'contradiction', 'extra', 'legacy version'] as const) {
  test(`T100: perfil ${corruption}, ${paged ? 'páginas' : 'inline'}, falla cerrado con checksum válido`, () => {
    const world = createWorld(), store = new Store(':memory:', { snapshotInlineTileLimit: paged ? 0 : 32768 });
    try {
      store.save(world);
      const value = JSON.parse(filaInstantanea(store).body);
      const metadata = paged ? value.world : value;
      metadata.limitsProfile = { version: 2, ...DEFAULT_PARAMS.limites };
      if (corruption === 'unknown') metadata.limitsProfile.version = 3;
      if (corruption === 'partial') delete metadata.limitsProfile.fauna;
      if (corruption === 'contradiction') metadata.limitsProfile.chunks++;
      if (corruption === 'extra') metadata.limitsProfile.hostRam = 1;
      if (corruption === 'legacy version') metadata.version = 4;
      const body = JSON.stringify(value);
      reescribirInstantanea(store, body);
      const before = tables(store);
      assert.throws(() => store.load(), SnapshotSemanticError);
      assert.throws(() => store.save(world), SnapshotSemanticError);
      assert.equal(tables(store), before); assert.equal(store.db.isTransaction, false);
    } finally { store.close(); }
  });
}

test('T100: snapshot sin perfil no evade bounds históricos mediante params amplios', () => {
  const world = wideWorld(), value = JSON.parse(encodeSnapshot(world, paramsOf(world)));
  delete value.limitsProfile;
  delete value.params.limites.aplicacion;
  assert.throws(() => decodeSnapshot(JSON.stringify(value)), SnapshotSemanticError);
  value.version = 4;
  assert.throws(() => decodeSnapshot(JSON.stringify(value)), SnapshotSemanticError);
});

test('T100: perfil exacto desaparece del World y los defaults siguen siendo deterministas', () => {
  const world = createWorld(), before = digestoCanonico(world), body = encodeSnapshot(world, paramsOf(world));
  assert.deepEqual(JSON.parse(body).limitsProfile, { version: 2, ...DEFAULT_PARAMS.limites });
  const value = decodeSnapshot(body) as World, params = takeSnapshotParams(value); setParams(value, params);
  assert.equal(Object.hasOwn(value, 'limitsProfile'), false);
  assert.equal(digestoCanonico(value), before); assert.deepEqual(params, DEFAULT_PARAMS);
});

const escala = process.env.CARTA_TEST_ESCALA === '1';

test('T100: 2 097 152 teselas y 8192 chunks conservan el digesto confirmado al reabrir SQLite',
  { skip: escala ? false : 'prueba lenta: exige CARTA_TEST_ESCALA=1' }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-limits-2m-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const started = performance.now(), path = join(directory, 'world.sqlite');
  // El mundo escritor vive en su propio ámbito y se suelta antes de recargar: así el pico
  // de RSS medido aquí es el de UN mundo residente, no el de dos (escritor + recargado).
  const escritura = (() => {
    const world = wideWorld(8192);
    assert.equal(world.tiles.length, 2_097_152); assert.equal(Object.keys(world.chunks).length, 8192);
    assertWorld(world);
    const store = new Store(path);
    try {
      store.save(world);
      return { digest: digestoCanonico(world), rss: peakRssBytes(), tiles: world.tiles.length, ms: performance.now() - started };
    } finally { store.close(); }
  })();
  const lectura = performance.now();
  const reopened = new Store(path);
  try { assert.equal(digestoCanonico(reopened.load()!.world), escritura.digest); } finally { reopened.close(); }
  const bytes = statSync(path).size, heap = getHeapStatistics().heap_size_limit;
  console.log(`2M teselas: escritura ${Math.round(escritura.ms)} ms, lectura ${Math.round(performance.now() - lectura)} ms; `
    + `RSS pico del escritor ${(escritura.rss / 1048576).toFixed(0)} MiB (${(escritura.rss / escritura.tiles).toFixed(0)} B/tesela); `
    + `RSS pico del proceso ${(peakRssBytes() / 1048576).toFixed(0)} MiB; ${bytes} bytes en disco `
    + `(${(bytes / escritura.tiles).toFixed(0)} B/tesela); heap configurado ${(heap / 1048576).toFixed(0)} MiB.`);
});

/** El techo de cría animal es el límite efectivo del mundo, no una constante del binario.
 * Rebaño sintético: sin activación de chunks, la población sólo crece por reproducción. */
const meadow = (x: number, y: number): Tile => ({ x, y, terrain: 'meadow', biome: 'grassland', moisture: 0.9,
  vegetation: 0.9, growth: 0.9, food: 0.2, fauna: 0, drinkingWater: 0.9, fertility: 0.8 });
function herd(limit?: number): AnimalWorld {
  const tiles = Array.from({ length: 49 }, (_, n) => meadow(n % 7, Math.floor(n / 7)));
  const seeds: [string, number, number][] = [['a', 1, 1], ['b', 1, 1], ['c', 5, 5], ['d', 5, 5]];
  const animals = seeds.map(([suffix, x, y]) => {
    const born = materializeAnimals(42, [{ ...meadow(x, y), fauna: 1, species: 'hare' }], 0)[0]!;
    born.id += `-${suffix}`; born.hunger = 0.2; born.thirst = 0.2; born.age = 1200; born.lastBirthAge = 0;
    return born;
  });
  syncFauna(tiles, animals);
  const world: AnimalWorld = { seed: 42, tick: 0, tiles, animals, animalCounter: 0, reproductionEnabled: true,
    animalDynamics: { births: 0, deaths: 0, predations: 0, humanHunts: 0, waterConsumed: 0, plantConsumed: 0 } };
  if (limit !== undefined) setParams(world, parseParams(`limites.fauna=${limit}`));
  return world;
}
function grazed(world: AnimalWorld, ticks = 2000): number {
  let peak = world.animals.length;
  for (let n = 0; n < ticks; n++) { world.tick++; stepAnimals(world); peak = Math.max(peak, world.animals.length); }
  return peak;
}

test('T100: la capacidad de cría animal es la natural; `limites.fauna` sólo admite o lanza, nunca recorta en silencio', () => {
  assert.equal(grazed(herd()), 6);
  assert.equal(grazed(herd(6)), 6, 'un límite igual a la capacidad natural admite sin cambiar la cría');
  assert.throws(() => grazed(herd(5)), /fauna excedida/, 'por debajo de lo natural la admisión falla cerrado en vez de recortar la cría');
});

/** Trío conviviente y compatible: sólo el tope de fundación puede impedir la comunidad. */
function foundingWorld(params?: string): World {
  const world = createWorld(51926, params === undefined ? undefined : parseParams(params));
  world.tick = 0; world.cooperationEnabled = true;
  const base = world.people[0]!;
  const trio = [base, ...[1, 2].map(index => ({ ...structuredClone(base), id: `vecino-${index}`, name: `Vecino ${index}` }))];
  for (const person of trio) {
    person.communityId = null; person.x = base.x; person.y = base.y; person.culture = { ...base.culture };
    person.bonds = Object.fromEntries(trio.filter(other => other !== person).map(other => [other.id, 0.5]));
  }
  world.people = trio;
  assert.ok(world.places.some(place => Math.hypot(base.x - place.x, base.y - place.y) <= 7), 'el trío vive junto a un lugar compartido');
  return world;
}
const emit = ((event: object) => ({ ...event, id: 'evento', tick: 0 })) as unknown as Parameters<typeof updateCommunities>[1];
const filled = (world: World, count: number): World => {
  world.communities = Array.from({ length: count }, (_, index) => ({ id: `previo-${index}`, name: `Grupo ${index}`, x: 17, y: 13,
    color: '#ffffff', members: [], culture: { sharing: 0, stewardship: 0, openness: 0 }, formedAt: 0, cooperation: 0, disputes: 0 }));
  return world;
};

test('T100: con el default de hoy la fundación se detiene en ocho comunidades', () => {
  const blocked = filled(foundingWorld(), 8);
  updateCommunities(blocked, emit);
  assert.deepEqual(blocked.people.map(person => person.communityId), [null, null, null]);
  const open = filled(foundingWorld(), 7);
  updateCommunities(open, emit);
  assert.equal(new Set(open.people.map(person => person.communityId)).size, 1);
  assert.equal(open.people.every(person => !!person.communityId), true);
});

test('T100: elevar social.maxComunidades cambia la conducta de fundación; elevar limites.comunidades (admisión) no', () => {
  const world = filled(foundingWorld('social.maxComunidades=9'), 8);
  updateCommunities(world, emit);
  assert.equal(world.people.every(person => !!person.communityId), true);
  assert.equal(world.communities.length, 1);
  const admitted = filled(foundingWorld('limites.comunidades=9'), 8);
  updateCommunities(admitted, emit);
  assert.deepEqual(admitted.people.map(person => person.communityId), [null, null, null], 'la admisión no es una ley de fundación');
});
