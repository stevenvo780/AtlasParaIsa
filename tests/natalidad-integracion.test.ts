import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneWorld, createWorld, puntoDeRestauracion, stepWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { digestoSin } from '../scripts/lab/rendimiento.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, paramsOf, parseParams, setParams } from '../src/world/params.js';
import { hacinamientoLocal, teselaProvision, vaciarCacheGeneracionNatalidad } from '../src/world/natalidad.js';
import { activate, maintainRegions, tileAt } from '../src/world/spatial.js';
import { chunkKey } from '../src/world/terrain.js';
import { initialDemography } from '../src/world/demography.js';
import { InstrumentosConducta } from '../scripts/lab/instrumentos.js';
import { decidirTechoLab, techoLabCota } from '../scripts/lab/techo-lab.js';
import { encodeSnapshot, readSnapshotParams } from '../src/server/snapshot.js';

const REFERENCIAS_1200 = {
  42: 'cb33c9812c89076096536ae847fd92cd2699a7fd42122bd1c1ea8f0560b85b06',
  2001: '1b6b177ded6fdf528e5a5cf10d710c8a790e530d5317356381cacac1eca3dd3d',
} as const;

for (const seed of [42, 2001] as const) test(`1–2: NAT-L apagada conserva main en ${seed}`, { timeout: 600000 }, () => {
  assert.equal(DEFAULT_PARAMS.poblacion.natalidadLocal, 0);
  assert.equal(HISTORICAL_PARAMS.poblacion.natalidadLocal, 0);
  assert.equal(DEFAULT_PARAMS.poblacion.radioProvision, 16);
  assert.equal(HISTORICAL_PARAMS.poblacion.radioProvision, 16);
  const world = createWorld(seed);
  assert.equal(Object.hasOwn(world, 'params'), false, 'los parámetros siguen fuera de World');
  for (let n = 0; n < 1200; n++) stepWorld(world);
  assert.equal(digestoSin(world, ['poblacion.natalidadLocal', 'poblacion.radioProvision']), REFERENCIAS_1200[seed]);
});

test('1: una instantánea V11 sin las claves nuevas recibe α=0 y R=16', () => {
  const world = createWorld(42), encoded = JSON.parse(encodeSnapshot(world, paramsOf(world))) as Record<string, unknown>;
  const old = structuredClone(encoded);
  const population = (old.params as Record<string, Record<string, unknown>>).poblacion!;
  delete population.natalidadLocal; delete population.radioProvision;
  const restored = readSnapshotParams(old);
  assert.equal(restored.poblacion.natalidadLocal, 0);
  assert.equal(restored.poblacion.radioProvision, 16);
  assert.equal(Object.hasOwn(world, 'natalidadLocal'), false);
});

function escena(parejas: number, alfa: number): World {
  const world = createWorld(51926, parseParams(`poblacion.natalidadLocal=${alfa},poblacion.radioProvision=16,agua.cuencas=1,poblacion.exigeComunidad=false,poblacion.comprobacionContinua=true`));
  const centro = world.places[0]!;
  for (const t of world.tiles) if (t.terrain !== 'water' && Math.hypot(t.x - centro.x, t.y - centro.y) <= 16) {
    t.feature = 'pool'; t.fertility = 1; t.moisture = 1; t.vegetation = 1; t.food = 0.8; t.drinkingWater = 0.8;
  }
  const modelo = world.people.find(p => p.role === 'neighbor')!;
  const clones = Array.from({ length: parejas * 2 }, (_, i) => {
    const p = structuredClone(modelo);
    p.id = `sintetico-${i}`; p.name = p.id; p.x = centro.x; p.y = centro.y;
    p.target = { x: p.x, y: p.y }; p.action = 'rest'; p.decisionAt = 100000;
    p.bonds = {}; p.communityId = null; p.inventory = 0.5; p.lastBirth = -100000;
    p.hunger = p.thirst = p.fatigue = 0.05; p.energy = 0.95;
    p.genome.parents = [];
    p.demography = initialDemography(4800);
    return p;
  });
  for (let i = 0; i < clones.length; i += 2) {
    clones[i]!.bonds[clones[i + 1]!.id] = 0.5;
    clones[i + 1]!.bonds[clones[i]!.id] = 0.5;
  }
  world.people = [world.people[0]!, world.people[1]!, ...clones];
  world.animals = []; world.tick = 119;
  return world;
}

test('2 y 5: la escena con 40 fértiles respeta el cupo apagado y lo supera con NAT-L', () => {
  const control = escena(20, 0), local = escena(20, 1);
  assert.ok(hacinamientoLocal(local, local.places[0]!, 16, 1) < 0.8);
  stepWorld(control); stepWorld(local);
  assert.equal(control.birthCounter, 2);
  assert.ok(local.birthCounter > 2, `nacieron ${local.birthCounter}`);
  assert.ok(local.birthCounter <= 20);
  assert.ok(local.people.filter(p => p.bornAt === 120).every(p => p.genome.parents.every(id => id.startsWith('sintetico-'))),
    'S e I cuentan como consumidores pero nunca son progenitores');
});

test('2: con α=0 la escena de 40 fértiles conserva dos nacimientos por ventana móvil durante 480 pasos', () => {
  const world = escena(20, 0), nacimientos: number[] = [];
  for (let n = 0; n < 480; n++) {
    const antes = world.birthCounter;
    stepWorld(world);
    for (let i = antes; i < world.birthCounter; i++) nacimientos.push(world.tick);
    assert.ok(nacimientos.filter(tick => tick > world.tick - 120).length <= 2, `paso ${world.tick}`);
  }
  assert.ok(nacimientos.length >= 2);
});

test('6: sin reposición de agua ni comida no hay nacimientos', () => {
  const world = escena(2, 1);
  // R=4 queda enteramente en chunks activos; la escena sólo agota esas teselas.
  setParams(world, parseParams('poblacion.radioProvision=4', paramsOf(world)));
  world.structures = [];
  for (const t of world.tiles) { t.feature = 'none'; t.biome = 'grassland'; t.moisture = t.vegetation = t.food = 0; }
  assert.equal(hacinamientoLocal(world, world.places[0]!, 4, 1), Infinity);
  stepWorld(world);
  assert.equal(world.birthCounter, 0);
});

test('3: clon y paso en sitio dan el mismo mundo con NAT-L; repetir la semilla es exacto', () => {
  const original = escena(5, 1), conClon = cloneWorld(original), enSitio = cloneWorld(original), repetido = cloneWorld(original);
  for (let n = 0; n < 3; n++) {
    const siguiente = cloneWorld(conClon); stepWorld(siguiente);
    Object.assign(conClon, siguiente); setParams(conClon, paramsOf(siguiente));
    puntoDeRestauracion(enSitio); stepWorld(enSitio);
    stepWorld(repetido);
    assert.equal(digestoCanonico(conClon), digestoCanonico(enSitio));
    assert.equal(digestoCanonico(enSitio), digestoCanonico(repetido));
  }
});

test('8: un cambio lejano al lugar y a la pareja no altera la decisión local', () => {
  const a = escena(1, 1), b = cloneWorld(a);
  const lejos = b.tiles.find(t => Math.hypot(t.x - 17, t.y - 13) > 24 && t.terrain !== 'water')!;
  assert.ok(lejos);
  lejos.feature = 'spring'; lejos.fertility = 1;
  assert.equal(hacinamientoLocal(a, a.places[0]!, 16, 1), hacinamientoLocal(b, b.places[0]!, 16, 1));
  stepWorld(a); stepWorld(b);
  assert.equal(a.birthCounter, b.birthCounter);
  assert.deepEqual(a.people.filter(p => p.bornAt === 120).map(p => p.genome.parents), b.people.filter(p => p.bornAt === 120).map(p => p.genome.parents));
});

test('localidad: activar desde lejos un chunk virgen del disco de la huerta conserva x bit a bit', () => {
  const world = createWorld(42, parseParams('poblacion.natalidadLocal=1,poblacion.radioProvision=16'));
  for (let n = 0; n < 3; n++) stepWorld(world);
  const huerta = world.places.find(place => place.id === 'huerta')!;
  const remoto = { x: 10, y: 45 }, interior = { x: 10, y: 35 };
  const key = chunkKey(interior.x, interior.y);
  assert.equal(key, chunkKey(remoto.x, remoto.y));
  assert.ok(Math.hypot(remoto.x - huerta.x, remoto.y - huerta.y) > paramsOf(world).poblacion.radioLugar + 16);
  assert.ok(Math.hypot(interior.x - huerta.x, interior.y - huerta.y) <= 16);
  assert.equal(world.chunks[key], undefined);
  assert.equal(world.retiredChunks.some(chunk => chunk.key === key), false);
  const antes = hacinamientoLocal(world, huerta, 16, 1);
  const persona = structuredClone(world.people.find(p => p.role === 'neighbor')!);
  persona.id = 'remota'; persona.x = remoto.x; persona.y = remoto.y;
  world.people.push(persona);
  maintainRegions(world);
  assert.ok(world.chunks[key]);
  assert.ok(tileAt(world, interior));
  assert.ok(Object.is(hacinamientoLocal(world, huerta, 16, 1), antes));
});

test('tesela dormida de la ley coincide con la primera activación del motor', () => {
  const world = createWorld(2001, parseParams('agua.cuencas=0.37'));
  const point = { x: 10, y: 35 }, key = chunkKey(point.x, point.y);
  assert.equal(world.chunks[key], undefined);
  const generated = teselaProvision(world, point.x, point.y)!;
  activate(world, point.x, point.y);
  const active = tileAt(world, point)!;
  assert.ok(active);
  for (const field of ['x', 'y', 'terrain', 'biome', 'moisture', 'vegetation', 'feature', 'fertility'] as const)
    assert.equal(generated[field], active[field], field);
});

test('α=1: vaciar la caché entre pasos conserva el digesto', { timeout: 600000 }, () => {
  const warm = createWorld(42, parseParams('poblacion.natalidadLocal=1'));
  const cold = cloneWorld(warm);
  for (let n = 0; n < 120; n++) stepWorld(warm);
  for (let n = 0; n < 120; n++) { vaciarCacheGeneracionNatalidad(); stepWorld(cold); }
  assert.equal(digestoCanonico(warm), digestoCanonico(cold));
});

test('9: la segunda pareja ve la cría de la primera en el mismo lugar y paso', () => {
  const world = escena(2, 1), centro = world.places[0]!;
  const alfa = hacinamientoLocal(world, centro, 16, 1) / 0.92;
  assert.ok(alfa > 0 && alfa <= 4);
  setParams(world, parseParams(`poblacion.natalidadLocal=${alfa}`, paramsOf(world)));
  assert.ok(hacinamientoLocal(world, centro, 16, alfa) < 1);
  stepWorld(world);
  assert.equal(world.birthCounter, 1);
  assert.ok(hacinamientoLocal(world, centro, 16, alfa) >= 1);
});

test('techoLabCota acota un paso con natalidad local y nacimientos múltiples', () => {
  const world = escena(5, 1), inicial = world.people.length, techo = 16;
  world.reproductionEnabled = decidirTechoLab(inicial, techo, 5000);
  assert.equal(world.reproductionEnabled, true);
  stepWorld(world);
  assert.ok(world.birthCounter > 2, 'NAT-L puede superar el cupo CTRL en un paso');
  const cota = techoLabCota(techo, inicial, paramsOf(world).poblacion.nacimientosPorComprobacion, 1);
  assert.ok(world.people.length <= cota, `${world.people.length} > ${cota}`);
  world.reproductionEnabled = decidirTechoLab(world.people.length, techo, 5000);
  if (world.people.length >= techo) assert.equal(world.reproductionEnabled, false);
});

test('12: los dos parámetros se validan en sus bordes', () => {
  for (const value of [0, 4]) assert.equal(parseParams(`poblacion.natalidadLocal=${value}`).poblacion.natalidadLocal, value);
  for (const value of [4, 32]) assert.equal(parseParams(`poblacion.radioProvision=${value}`).poblacion.radioProvision, value);
  for (const value of [-0.001, 4.001]) assert.throws(() => parseParams(`poblacion.natalidadLocal=${value}`));
  for (const value of [3.999, 32.001]) assert.throws(() => parseParams(`poblacion.radioProvision=${value}`));
});

test('13: la observación de natalidad local conserva el digesto del mundo', () => {
  const world = escena(2, 1), control = cloneWorld(world), instrumento = new InstrumentosConducta(world);
  const antes = digestoCanonico(world);
  instrumento.antesDelPaso(world);
  assert.equal(digestoCanonico(world), antes);
  stepWorld(world); instrumento.cerrar(); stepWorld(control);
  instrumento.despuesDelPaso(world);
  assert.equal(digestoCanonico(world), digestoCanonico(control));
  const metricas = instrumento.metricasDia(world);
  assert.equal(digestoCanonico(world), digestoCanonico(control));
  assert.equal(metricas.natalidadLocal.nacimientosDia, world.birthCounter);
  assert.ok(metricas.natalidadLocal.kOcupado.agua > 0);
  assert.ok(metricas.natalidadLocal.kOcupado.comida > 0);
  assert.equal(metricas.natalidadLocal.limitante.agua + metricas.natalidadLocal.limitante.comida, 1);
  instrumento.cerrar();
});

for (const alfa of [0, 1]) test(`observador conserva el digesto en 1200 pasos con alfa=${alfa}`, { timeout: 600000 }, () => {
  const inicial = createWorld(42, parseParams(`poblacion.natalidadLocal=${alfa}`));
  const observado = cloneWorld(inicial), control = cloneWorld(inicial);
  const instrumento = new InstrumentosConducta(observado);
  try {
    for (let n = 0; n < 1200; n++) {
      instrumento.antesDelPaso(observado); stepWorld(observado); instrumento.despuesDelPaso(observado);
    }
    instrumento.cerrar();
    for (let n = 0; n < 1200; n++) stepWorld(control);
    assert.equal(digestoCanonico(observado), digestoCanonico(control));
  } finally { instrumento.cerrar(); }
});

test('CTRL con sonda pasiva registra xNacimientos sin alterar los nacimientos', () => {
  const observado = escena(20, 0), control = cloneWorld(observado);
  const instrumento = new InstrumentosConducta(observado);
  try {
    stepWorld(observado);
    instrumento.despuesDelPaso(observado);
    stepWorld(control); // el clon se tomó antes de registrar el observador: no tiene
    assert.equal(observado.birthCounter, control.birthCounter);
    assert.deepEqual(observado.people.filter(p => p.bornAt === observado.tick).map(p => p.genome.parents),
      control.people.filter(p => p.bornAt === control.tick).map(p => p.genome.parents));
    const metricas = instrumento.metricasDia(observado).natalidadLocal;
    assert.equal(metricas.nacimientosDia, observado.birthCounter);
    assert.notEqual(metricas.xNacimientos.p50, null);
    assert.equal(metricas.bloqueadasPorLey, 0);
  } finally { instrumento.cerrar(); }
});
