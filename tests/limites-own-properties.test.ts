import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorld } from '../src/world/index.js';
import { DEFAULT_PARAMS, assertWorldLimits, paramsOf, setParams, type WorldParams } from '../src/world/params.js';
import { Store } from '../src/server/store.js';

const configured = (): WorldParams['limites'] => ({ ...DEFAULT_PARAMS.limites });
const invalid: readonly [string, () => WorldParams['limites']][] = [
  ['modo heredado y clave extra', () => {
    const { aplicacion, ...limits } = configured();
    return Object.assign(Object.create({ aplicacion }), limits, { unexpected: 1 }) as WorldParams['limites'];
  }],
  ['modo propio no enumerable', () => Object.defineProperty(configured(), 'aplicacion', { enumerable: false })],
  ['número propio no enumerable', () => Object.defineProperty(configured(), 'chunks', { enumerable: false })],
  ['clave extra no enumerable', () => Object.defineProperty(configured(), 'unexpected', { value: 1 })],
  ['símbolo extra', () => Object.assign(configured(), { [Symbol('unexpected')]: 1 })],
];

for (const [label, make] of invalid) {
  test(`límites: ${label} se rechaza antes de asociar parámetros`, () => {
    const world = createWorld(), before = paramsOf(world), limits = make();
    assert.throws(() => assertWorldLimits(limits, true), /Límites/);
    assert.throws(() => setParams(world, { ...DEFAULT_PARAMS, limites: limits }), /Límites/);
    assert.equal(paramsOf(world), before);
  });
  for (const paged of [false, true]) test(`límites: mutación con ${label} no confirma snapshot ${paged ? 'paginado' : 'inline'}`, () => {
    const store = new Store(':memory:', { snapshotInlineTileLimit: paged ? 0 : 32768 }), world = createWorld();
    const params = { ...DEFAULT_PARAMS, limites: configured() };
    setParams(world, params);
    try {
      store.save(world);
      const tables = (): unknown => store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
        .map(row => [row.name, store.db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}" ORDER BY rowid`).all()]);
      const before = tables(), journal = structuredClone(world.chronicleJournal), retired = structuredClone(world.retiredChunks);
      params.limites = make();
      assert.throws(() => store.save(world), /Límites/);
      assert.equal(store.db.isTransaction, false);
      assert.deepEqual(tables(), before);
      assert.deepEqual(world.chronicleJournal, journal);
      assert.deepEqual(world.retiredChunks, retired);
    } finally { store.close(); }
  });
}

for (const nullPrototype of [false, true]) test(`límites: propiedades propias enumerables válidas, prototipo ${nullPrototype ? 'null' : 'Object'}`, () => {
  const limits = Object.assign(Object.create(nullPrototype ? null : Object.prototype), configured()) as WorldParams['limites'];
  assertWorldLimits(limits, true);
  const { aplicacion: _mode, ...numeric } = limits;
  assertWorldLimits(numeric);
  const world = createWorld(), store = new Store(':memory:');
  try {
    setParams(world, { ...DEFAULT_PARAMS, limites: limits }); store.save(world);
    assert.deepEqual(paramsOf(store.load()!.world).limites, configured());
  } finally { store.close(); }
});
