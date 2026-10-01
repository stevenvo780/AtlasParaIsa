import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/server/store.js';
import { decodeSnapshot, encodeSnapshot, SnapshotSemanticError, takeSnapshotParams } from '../src/server/snapshot.js';
import { assertWorld, createWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, paramsOf, parseParams, setParams, type WorldParams } from '../src/world/params.js';
import { filaInstantanea, laboratorio, reescribirInstantanea, todasLasTablas } from './lib/store.js';

// Perfil sintético fijado por el contrato: no es una calibración de P90.
const SYNTHETIC_GHAT = [1, 1, 1, 1, 1, 1, 1, 1];
const OFFICES = ['gather', 'forage', 'hunt', 'farm', 'build', 'repair', 'research', 'craft'] as const;
type LocalState = Partial<Record<(typeof OFFICES)[number], { q: number; intentos: number }>>;
type LearnedPerson = World['people'][number] & { utilidadLocal?: LocalState };
const STATE: LocalState = { gather: { q: 0.375, intentos: 3 }, craft: { q: 0, intentos: 1 } };

function activeParams(base: WorldParams = DEFAULT_PARAMS): WorldParams {
  return parseParams({ conducta: { utilidadLocal: 1, utilidadLocalGhat: SYNTHETIC_GHAT } }, base);
}
function fixture(): World {
  const world = createWorld(19011, activeParams());
  const person = world.people[0]! as LearnedPerson;
  person.utilidadLocal = structuredClone(STATE);
  person.work = 7; // Trabajo en curso serializable, sin ejecutar una trayectoria.
  return world;
}
function restore(body: string): World {
  const world = decodeSnapshot(body) as World;
  setParams(world, takeSnapshotParams(world));
  assertWorld(world);
  return world;
}
function hasNoNewKeys(params: WorldParams): void {
  assert.equal(Object.hasOwn(params.conducta, 'utilidadLocal'), false);
  assert.equal(Object.hasOwn(params.conducta, 'utilidadLocalGhat'), false);
}
function directParams(conduct: Record<string, unknown>): WorldParams {
  const value = structuredClone(DEFAULT_PARAMS);
  Object.assign(value.conducta, conduct);
  return value;
}

test('Ley 2′: defaults e históricos conservan su forma enumerable y su identidad', () => {
  for (const base of [DEFAULT_PARAMS, HISTORICAL_PARAMS]) {
    hasNoNewKeys(base);
    assert.deepEqual(Object.keys(base.conducta), ['habituacion', 'aptitud']);
    assert.equal(parseParams(undefined, base), base);
  }
});

test('Ley 2′: enlazar la forma histórica anterior a conducta conserva sus bytes', () => {
  const legacy = structuredClone(HISTORICAL_PARAMS) as unknown as Record<string, unknown>;
  delete legacy.conducta;
  const bytes = JSON.stringify(legacy), world = createWorld(19011);
  setParams(world, legacy as unknown as WorldParams);
  assert.equal(paramsOf(world), legacy, 'el enlace histórico conserva la identidad del llamante');
  assert.equal(JSON.stringify(paramsOf(world)), bytes);
  assert.equal(Object.hasOwn(paramsOf(world), 'conducta'), false);
  assert.doesNotThrow(() => digestoCanonico(world));
  assert.doesNotThrow(() => assertWorld(world));
});

test('Ley 2′: cero explícito desaparece en texto, JSON, diccionario y enlace directo', () => {
  const forms: (Record<string, unknown> | string)[] = [
    'conducta.utilidadLocal=0', 'conducta.utilidadLocal=-0',
    '{"conducta":{"utilidadLocal":0}}', { conducta: { utilidadLocal: 0 } },
    { 'conducta.utilidadLocal': '0' },
  ];
  for (const base of [DEFAULT_PARAMS, parseParams('social.radioConvivencia=12,social.disolucion=1,social.maxComunidades=64')]) {
    const baseline = createWorld(19012, base);
    for (const input of forms) {
      const params = parseParams(input, base);
      hasNoNewKeys(params);
      assert.deepEqual(params, base);
      assert.equal(JSON.stringify(params), JSON.stringify(base));
      const world = createWorld(19012, params);
      assert.equal(digestoCanonico(world), digestoCanonico(baseline));
      assert.equal(encodeSnapshot(world, params), encodeSnapshot(baseline, base));
    }
    const original = structuredClone(base);
    original.conducta.utilidadLocal = 0;
    const bound = createWorld(19012, original);
    assert.equal(original.conducta.utilidadLocal, 0, 'normalizar no modifica al llamante');
    hasNoNewKeys(paramsOf(bound));
    assert.deepEqual(paramsOf(bound), base);
    assert.equal(digestoCanonico(bound), digestoCanonico(baseline));
  }
});

test('Ley 2′: activación requiere un perfil positivo exacto y preserva su orden congelado', () => {
  const ordered = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16];
  for (const input of [
    { conducta: { utilidadLocal: 1, utilidadLocalGhat: ordered } },
    { 'conducta.utilidadLocal': '1', 'conducta.utilidadLocalGhat': JSON.stringify(ordered) },
    `conducta.utilidadLocal=1,conducta.utilidadLocalGhat=${JSON.stringify(ordered)}`,
  ]) {
    const params = parseParams(input);
    assert.equal(params.conducta.utilidadLocal, 1);
    assert.deepEqual(params.conducta.utilidadLocalGhat, ordered);
    assert.ok(Object.isFrozen(params));
    assert.ok(Object.isFrozen(params.conducta));
    assert.ok(Object.isFrozen(params.conducta.utilidadLocalGhat));
  }
  assert.deepEqual(activeParams().conducta.utilidadLocalGhat, SYNTHETIC_GHAT, 'escalas repetidas son válidas');
});

test('Ley 2′: parser y setParams rechazan flags y perfiles ilegales sin sustituir la ley vigente', () => {
  const sparse = Array<number>(8).fill(1); delete sparse[4];
  const invalid: Record<string, unknown>[] = [
    ...[-1, 0.5, 2, NaN, Infinity, true, null].map(utilidadLocal => ({ utilidadLocal })),
    { utilidadLocal: 1 }, { utilidadLocalGhat: SYNTHETIC_GHAT },
    { utilidadLocal: 0, utilidadLocalGhat: SYNTHETIC_GHAT },
    ...[
      SYNTHETIC_GHAT.slice(0, 7), [...SYNTHETIC_GHAT, 1], sparse,
      [0, 1, 1, 1, 1, 1, 1, 1], [-0, 1, 1, 1, 1, 1, 1, 1],
      [-1, 1, 1, 1, 1, 1, 1, 1], [NaN, 1, 1, 1, 1, 1, 1, 1],
      [Infinity, 1, 1, 1, 1, 1, 1, 1], ['1', 1, 1, 1, 1, 1, 1, 1],
      [null, 1, 1, 1, 1, 1, 1, 1], null,
    ].map(utilidadLocalGhat => ({ utilidadLocal: 1, utilidadLocalGhat })),
  ];
  const bound = {}, previous = activeParams();
  setParams(bound, previous);
  for (const conduct of invalid) {
    assert.throws(() => parseParams({ conducta: conduct }));
    assert.throws(() => setParams(bound, directParams(conduct)));
    assert.equal(paramsOf(bound), previous, 'un fallo conserva el enlace anterior');
  }
  assert.throws(() => setParams(bound, directParams({ utilidadLocal: '1', utilidadLocalGhat: SYNTHETIC_GHAT })));
  assert.throws(() => parseParams('conducta.utilidadLocal=0', previous), 'no se descarta silenciosamente un perfil activo heredado de la base');
});

test('Ley 2′: enlace directo activo aísla el perfil mutable del llamante', () => {
  const supplied = directParams({ utilidadLocal: 1, utilidadLocalGhat: [...SYNTHETIC_GHAT] });
  const world = {};
  setParams(world, supplied);
  const accepted = paramsOf(world);
  assert.notEqual(accepted, supplied);
  assert.ok(Object.isFrozen(accepted));
  assert.ok(Object.isFrozen(accepted.conducta));
  assert.ok(Object.isFrozen(accepted.conducta.utilidadLocalGhat));
  (supplied.conducta.utilidadLocalGhat as number[])[0] = 99;
  assert.deepEqual(accepted.conducta.utilidadLocalGhat, SYNTHETIC_GHAT);
  assert.equal(Object.isFrozen(supplied), false, 'no se congela el objeto ajeno');
});

test('Ley 2′: un override ajeno a la ley preserva perfil y configuración efectiva', () => {
  const base = activeParams(parseParams('social.radioConvivencia=12,social.disolucion=1,social.maxComunidades=64,persistencia.cadaTicks=300,limites.comunidades=64'));
  assert.equal(parseParams(undefined, base), base);
  const changed = parseParams('agua.cuencas=0.8', base);
  assert.deepEqual(changed.conducta, base.conducta);
  assert.equal(changed.persistencia.cadaTicks, 300);
  assert.equal(changed.limites.comunidades, 64);
  assert.deepEqual(changed.social, base.social);
});

test('Ley 2′: perfil y aprendizaje siguen cubiertos por el digesto canónico completo', () => {
  const baseline = fixture(), changedQ = fixture(), changedProfile = fixture();
  (changedQ.people[0]! as LearnedPerson).utilidadLocal!.gather!.q = 0.5;
  setParams(changedProfile, parseParams({ conducta: { utilidadLocalGhat: [2, 1, 1, 1, 1, 1, 1, 1] } }, paramsOf(changedProfile)));
  assert.notEqual(digestoCanonico(changedQ), digestoCanonico(baseline));
  assert.notEqual(digestoCanonico(changedProfile), digestoCanonico(baseline));
});

test('Ley 2′: codec restaura perfil, q, intentos y trabajo en curso sin deriva', () => {
  const original = fixture(), params = paramsOf(original);
  const restored = restore(encodeSnapshot(original, params));
  assert.deepEqual(paramsOf(restored), params);
  assert.deepEqual((restored.people[0]! as LearnedPerson).utilidadLocal, STATE);
  assert.equal(restored.people[0]!.work, 7);
  assert.equal(digestoCanonico(restored), digestoCanonico(original));
});

for (const limit of [1536, 0]) {
  test(`Ley 2′: Store restaura el perfil y aprendizaje tras cerrar, transporte ${limit ? 'inline' : 'por piezas'}`, t => {
    const options = { snapshotInlineTileLimit: limit };
    const { store, path } = laboratorio(t, 'atlas-utilidad-params-', options);
    const original = fixture();
    store.save(original);
    const expectedDigest = digestoCanonico(original), expectedParams = paramsOf(original);
    const saved = filaInstantanea(store);
    store.close();
    const reopened = new Store(path, options);
    try {
      const loaded = reopened.load()!;
      assert.equal(loaded.slot, 0);
      assert.deepEqual(paramsOf(loaded.world), expectedParams);
      assert.deepEqual((loaded.world.people[0]! as LearnedPerson).utilidadLocal, STATE);
      assert.equal(loaded.world.people[0]!.work, 7);
      assert.equal(digestoCanonico(loaded.world), expectedDigest);
      assert.deepEqual(filaInstantanea(reopened), saved, 'leer no reescribe datos');
    } finally { reopened.close(); }
  });
}

const badStoredParams: [string, (conduct: Record<string, unknown>) => void][] = [
  ['flag no entero', conduct => { conduct.utilidadLocal = 0.5; }],
  ['activación sin perfil', conduct => { delete conduct.utilidadLocalGhat; }],
  ['perfil sin ley', conduct => { delete conduct.utilidadLocal; }],
  ['perfil con ley cero', conduct => { conduct.utilidadLocal = 0; }],
  ['perfil demasiado largo', conduct => { conduct.utilidadLocalGhat = [...SYNTHETIC_GHAT, 1]; }],
  ['escala cero', conduct => { conduct.utilidadLocalGhat = [0, 1, 1, 1, 1, 1, 1, 1]; }],
  ['escala no numérica', conduct => { conduct.utilidadLocalGhat = ['1', 1, 1, 1, 1, 1, 1, 1]; }],
];
for (const [name, corrupt] of badStoredParams) {
  test(`Ley 2′: corrupción semántica (${name}) no usa respaldo ni repara SQLite`, t => {
    const { store } = laboratorio(t, 'atlas-utilidad-corrupt-');
    const original = fixture();
    store.save(original); store.save(original); // Slot 1 válido disponible.
    const backup = filaInstantanea(store, 1);
    assert.ok(backup.body);
    const record = JSON.parse(filaInstantanea(store).body) as { params: { conducta: Record<string, unknown> } };
    corrupt(record.params.conducta);
    reescribirInstantanea(store, JSON.stringify(record)); // Checksum correcto: fallo de semántica.
    const before = todasLasTablas(store);
    assert.throws(() => store.load(), error => error instanceof SnapshotSemanticError && /Invalid snapshot parameters/.test(error.message));
    assert.deepEqual(todasLasTablas(store), before);
    assert.deepEqual(filaInstantanea(store, 1), backup);
  });
}

const badState: [string, unknown][] = [
  ['q negativo', { gather: { q: -0.01, intentos: 3 } }],
  ['q mayor que uno', { gather: { q: 1.01, intentos: 3 } }],
  ['q no finito', { gather: { q: Infinity, intentos: 3 } }],
  ['contador negativo', { gather: { q: 0.5, intentos: -1 } }],
  ['contador fraccionario', { gather: { q: 0.5, intentos: 1.5 } }],
  ['contador inseguro', { gather: { q: 0.5, intentos: Number.MAX_SAFE_INTEGER + 1 } }],
  ['oficio desconocido', { sleep: { q: 0.5, intentos: 3 } }],
];
for (const [name, state] of badState) {
  test(`Ley 2′: restaurar aprendizaje corrupto (${name}) falla sin tocar SQLite`, t => {
    const { store } = laboratorio(t, 'atlas-utilidad-q-corrupt-');
    const original = fixture();
    store.save(original); store.save(original);
    const record = JSON.parse(filaInstantanea(store).body) as { people: { utilidadLocal?: unknown }[] };
    record.people[0]!.utilidadLocal = state;
    reescribirInstantanea(store, JSON.stringify(record));
    const before = todasLasTablas(store);
    assert.throws(() => store.load(), 'un respaldo sano no permite ocultar estado reconocido inválido');
    assert.deepEqual(todasLasTablas(store), before);
  });
}

test('Ley 2′: una instantánea previa sin campos nuevos sigue sin materializarlos', t => {
  const { store } = laboratorio(t, 'atlas-utilidad-off-');
  const original = createWorld(19013);
  store.save(original);
  const expected = digestoCanonico(original), body = filaInstantanea(store).body;
  const loaded = store.load()!.world;
  hasNoNewKeys(paramsOf(loaded));
  for (const person of loaded.people) assert.equal(Object.hasOwn(person, 'utilidadLocal'), false);
  assert.equal(digestoCanonico(loaded), expected);
  assert.equal(encodeSnapshot(loaded, paramsOf(loaded)), body);
});
