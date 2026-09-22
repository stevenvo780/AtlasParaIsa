import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import v8 from 'node:v8';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { stringifyExact } from '../src/shared/exact-json.js';
import { assertWorld, cloneWorld, createWorld, stepWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { LEGACY_WORLD_LIMITS, WORLD_LIMIT_KEYS, limitsOf, paramsOf, parseParams, setParams, type WorldParams } from '../src/world/params.js';

type LimitKey = typeof WORLD_LIMIT_KEYS[number];
type NumericLimits = Record<LimitKey, number>;
interface ParametersRecord { limites: NumericLimits & { aplicacion?: unknown; [key: string]: unknown }; [key: string]: unknown; }
interface SnapshotRecord {
  params: ParametersRecord;
  paramsEncoding?: string;
  limitsProfile?: NumericLimits & { version: number; aplicacion?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}
const checksum = (body: string): string => createHash('sha256').update(body).digest('hex');
const numeric = (limits: NumericLimits): NumericLimits => Object.fromEntries(WORLD_LIMIT_KEYS.map(key => [key, limits[key]])) as NumericLimits;
const mode = (params: WorldParams): unknown => (params.limites as NumericLimits & { aplicacion?: unknown }).aplicacion;

function allTables(store: Store): unknown {
  const names = store.db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[];
  return names.map(({ name }) => [name, store.db.prepare(`SELECT * FROM main."${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
}

function laboratory(t: TestContext, paged: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-limits-legacy-mode-'));
  const path = join(directory, 'world.sqlite'), options = { snapshotInlineTileLimit: paged ? 0 : 32768 };
  let current: Store | undefined = new Store(path, options);
  const close = (): void => { const previous = current; current = undefined; previous?.close(); };
  t.after(() => { close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    get store(): Store { return current!; },
    reopen(): Store { close(); current = new Store(path, options); return current; },
  };
}

function worldWithCommunities(): World {
  const world = createWorld(42, parseParams('agua.cuencas=0.8,motor.hilos=2,motor.gpu=[-0,1]'));
  for (let index = 0; index < 2; index++) {
    const members = world.people.slice(2 + index * 2, 4 + index * 2), id = `legacy-group-${index}`;
    for (const person of members) person.communityId = id;
    world.communities.push({ id, name: `Grupo ${index}`, x: members[0]!.x, y: members[0]!.y, color: '#aabbcc',
      members: members.map(person => person.id), culture: { ...members[0]!.culture }, formedAt: 0, cooperation: 0, disputes: 0 });
  }
  world.communityCounter = 2;
  assertWorld(world);
  return world;
}

/** Documento histórico independiente: objetos de tesela y params T102, sin
 * obtener el cuerpo del encoder actual ni heredar sus nuevas marcas. Store.save
 * se usa únicamente para preparar archivos y journals coherentes con el mundo. */
function legacyRecord(world: World, low: LimitKey): { record: SnapshotRecord; declared: NumericLimits; otherParams: Record<string, unknown> } {
  const params = structuredClone(paramsOf(world)) as unknown as ParametersRecord;
  delete params.limites.aplicacion;
  params.limites[low] = 1;
  const record = { ...structuredClone(world), paramsEncoding: 'params-v1', params } as unknown as SnapshotRecord;
  delete record.limitsProfile;
  delete record.tileEncoding;
  delete record.snapshotEncoding;
  const otherParams: Record<string, unknown> = { ...params }; delete otherParams.limites;
  return { record, declared: numeric(params.limites), otherParams };
}

function replaceSlot(store: Store, record: SnapshotRecord | Record<string, unknown>): void {
  const body = stringifyExact(record);
  store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body, checksum(body));
}

function storedMetadata(store: Store): SnapshotRecord {
  const row = store.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get() as { body: string; digest: string };
  assert.equal(checksum(row.body), row.digest);
  const value = JSON.parse(row.body) as SnapshotRecord;
  return value.snapshotEncoding ? value.world as SnapshotRecord : value;
}

function assertHistoricalParams(world: World, declared: NumericLimits, otherParams: Record<string, unknown>): void {
  const actual = paramsOf(world), other = { ...actual } as Record<string, unknown>; delete other.limites;
  assert.equal(mode(actual), 'historicos');
  assert.deepEqual(numeric(actual.limites), declared, 'los cuatro números T102 no se normalizan a topes históricos');
  assert.deepEqual(other, otherParams);
  assert.ok(Object.is(actual.motor.gpu[0], -0));
  assert.deepEqual(numeric(limitsOf(world)), numeric(LEGACY_WORLD_LIMITS), 'los efectivos históricos son independientes de los números declarados');
}

for (const key of WORLD_LIMIT_KEYS) {
  test(`R3: fixture histórica ${key}=1 era admisible antes de activar límites en V9`, () => {
    const world = worldWithCommunities();
    world.version = 8;
    setParams(world, parseParams({ limites: { [key]: 1 } }, paramsOf(world)));
    assertWorld(world, 8);
    assert.ok((key === 'teselasActivas' ? world.tiles.length : key === 'chunks' ? Object.keys(world.chunks).length
      : key === 'comunidades' ? world.communities.length : world.animals.length) > 1);
  });

  for (const paged of [false, true]) {
    test(`R3: legacy ${key}=1 conserva declaración, modo histórico y resto de params tras load/step/save/reopen (${paged ? 'páginas' : 'inline'})`, t => {
      const lab = laboratory(t, paged), initial = worldWithCommunities();
      lab.store.save(initial);
      const { record, declared, otherParams } = legacyRecord(initial, key);
      assert.equal(Object.hasOwn(record, 'limitsProfile'), false);
      assert.equal(Object.hasOwn(record.params.limites, 'aplicacion'), false);
      assert.ok(Array.isArray(record.tiles) && !Array.isArray(record.tiles[0]), 'las teselas de la fixture son objetos históricos');
      replaceSlot(lab.store, record);
      const before = allTables(lab.store);
      t.mock.method(os, 'totalmem', () => { throw new Error('load must not inspect physical RAM'); });
      t.mock.method(v8, 'getHeapStatistics', () => { throw new Error('load must not inspect V8 capacity'); });
      t.mock.method(process, 'constrainedMemory', () => { throw new Error('load must not inspect cgroup capacity'); });
      const reopened = lab.reopen(), loaded = reopened.load()!.world;
      assertHistoricalParams(loaded, declared, otherParams);
      assert.deepEqual(allTables(reopened), before, 'inferir modo no reescribe el archivo durante load');
      assertWorld(loaded, loaded.version, reopened.context);
      stepWorld(loaded, [], reopened.context);
      assertHistoricalParams(loaded, declared, otherParams);
      reopened.save(loaded);
      const committed = digestoCanonico(loaded), metadata = storedMetadata(reopened);
      assert.deepEqual(metadata.limitsProfile, { version: 2, aplicacion: 'historicos', ...numeric(LEGACY_WORLD_LIMITS) });
      assert.equal(metadata.params.limites.aplicacion, 'historicos');
      assert.deepEqual(numeric(metadata.params.limites), declared);
      const after = lab.reopen(), resumed = after.load()!.world;
      assertHistoricalParams(resumed, declared, otherParams);
      assert.equal(digestoCanonico(resumed), committed);
    });
  }
}

for (const paged of [false, true]) {
  test(`R3: mundo nuevo declara modo parametros y perfil v2 aun con defaults (${paged ? 'páginas' : 'inline'})`, t => {
    const lab = laboratory(t, paged), world = createWorld(42);
    assert.equal(mode(paramsOf(world)), 'parametros');
    lab.store.save(world);
    const committed = digestoCanonico(world), metadata = storedMetadata(lab.store);
    assert.deepEqual(metadata.params, paramsOf(world), 'los defaults completos se escriben con la marca de aplicación');
    assert.deepEqual(metadata.limitsProfile, { version: 2, aplicacion: 'parametros', ...numeric(paramsOf(world).limites) });
    assert.equal(digestoCanonico(lab.reopen().load()!.world), committed);
  });
}

test('R3: el modo de aplicación forma parte del digesto aunque los cuatro números y sus efectivos coincidan', () => {
  const current = createWorld(42), historical = cloneWorld(current);
  setParams(historical, parseParams({ 'limites.aplicacion': 'historicos' }, paramsOf(historical)));
  assert.deepEqual(numeric(paramsOf(current).limites), numeric(paramsOf(historical).limites));
  assert.deepEqual(numeric(limitsOf(current)), numeric(limitsOf(historical)));
  assert.notEqual(digestoCanonico(current), digestoCanonico(historical));
});

const corruptions: readonly [string, (metadata: SnapshotRecord) => void][] = [
  ['modo contradictorio aunque efectivos coincidan', metadata => { metadata.limitsProfile!.aplicacion = 'historicos'; }],
  ['históricos con perfil que copia números declarados bajos', metadata => {
    metadata.params.limites.aplicacion = 'historicos'; metadata.params.limites.fauna = 1;
    metadata.limitsProfile!.aplicacion = 'historicos'; metadata.limitsProfile!.fauna = 1;
  }],
  ['perfil contradice números del modo parametros', metadata => { metadata.limitsProfile!.fauna++; }],
  ['perfil v2 sin marca en params', metadata => { delete metadata.params.limites.aplicacion; }],
  ['marca en params sin perfil', metadata => { delete metadata.limitsProfile; }],
  ['enum de aplicación inválido', metadata => { metadata.params.limites.aplicacion = 'automatico'; }],
  ['clave de límites desconocida', metadata => { metadata.params.limites.hostRam = 1024; }],
  ['enum del perfil desconocido', metadata => { metadata.limitsProfile!.aplicacion = 'automatico'; }],
  ['clave del perfil desconocida', metadata => { metadata.limitsProfile!.hostRam = 1024; }],
];

for (const paged of [false, true]) for (const [label, corrupt] of corruptions) {
  test(`R3: ${label} falla cerrado en load y save con ALLtables intactas (${paged ? 'páginas' : 'inline'})`, t => {
    const lab = laboratory(t, paged), world = worldWithCommunities();
    lab.store.save(world); lab.store.save(world);
    const row = lab.store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as { body: string };
    const record = JSON.parse(row.body) as SnapshotRecord;
    const metadata = record.snapshotEncoding ? record.world as SnapshotRecord : record;
    metadata.params = structuredClone(paramsOf(world)) as unknown as ParametersRecord;
    metadata.params.limites.aplicacion = 'parametros';
    metadata.paramsEncoding = 'params-v1';
    metadata.limitsProfile = { version: 2, aplicacion: 'parametros', ...numeric(metadata.params.limites) };
    corrupt(metadata);
    replaceSlot(lab.store, record);
    const before = allTables(lab.store), reopened = lab.reopen();
    assert.throws(() => reopened.load(), /snapshot|limit|par[aá]metr|aplicacion/i);
    assert.equal(reopened.db.isTransaction, false);
    assert.deepEqual(allTables(reopened), before, 'load no adopta silenciosamente el slot 1 sano');
    assert.throws(() => reopened.save(world), /snapshot|limit|par[aá]metr|aplicacion/i);
    assert.equal(reopened.db.isTransaction, false);
    assert.deepEqual(allTables(reopened), before, 'save no repara marcas corruptas ni altera ninguna tabla');
  });
}

for (const mark of ['ausente', 'parametros'] as const) {
  test(`R3: perfil v1 experimental con modo ${mark} conserva interpretación parametros`, t => {
    const lab = laboratory(t, false), world = worldWithCommunities();
    lab.store.save(world);
    const params = structuredClone(paramsOf(world)) as unknown as ParametersRecord;
    if (mark === 'ausente') delete params.limites.aplicacion;
    else params.limites.aplicacion = 'parametros';
    const record = { ...structuredClone(world), paramsEncoding: 'params-v1', params,
      limitsProfile: { version: 1, ...numeric(params.limites) } } as unknown as SnapshotRecord;
    replaceSlot(lab.store, record);
    const loaded = lab.reopen().load()!.world;
    assert.equal(mode(paramsOf(loaded)), 'parametros');
    assert.deepEqual(numeric(limitsOf(loaded)), numeric(params.limites));
    assert.ok(Object.is(paramsOf(loaded).motor.gpu[0], -0));
  });
}
