import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cloneWorld, createWorld, RULES_VERSION, stepWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { paramsOf, parseParams, setParams } from '../src/world/params.js';
import { EstadoPersonasCompartido, escenaDesdeMundo } from '../src/world/paralelo/personas-motor.js';
import { ResidentTopologyOwner } from '../src/world/soa/topologia.js';
import { worldStatistics } from '../src/world/statistics.js';
import { constructionSite, depositMaterials, storedMaterialsNear, repairOpportunity } from '../src/world/inventions.js';
import { EstadoFaunaCompartido } from '../src/world/paralelo/fauna-motor.js';
import { DI } from '../src/world/paralelo/fauna-worker.js';

const OPEN = 'poblacion.natalidadVecindad=true,social.maxComunidades=0,limites.aplicacion=parametros,limites.chunks=65536,limites.teselasActivas=16777216,limites.comunidades=16777216,limites.fauna=100663296,construccion.modular=true,construccion.poliminosYSinergia=true,terreno.caminosFisicos=true,quimica.emergente=true,motor.soaTerreno=true,motor.particionarPersonas=true';
const GOLDEN: Record<string, string> = {
  // Capturados del HEAD previo a V22 Front 4, antes de optimizar los seis ficheros propios.
  'default/51926': '2b8e9989d92aa4db168af6d5383e284ce5a80c7aa2bc4abbf7a7b54034f432cb',
  // open/*: digestos de las leyes v23/V24 (química universal, caza/ganadería, morfología, sonido; RULES_VERSION 14), mundo abierto, 240 pasos.
  // Los de V22 (218b1a3b…, 147d961c…) cambiaron a propósito con las leyes v23; los de default/* siguen intactos.
  'open/51926': '2e8a623166638a4f9857600cbcb2398900ad4f3ca572fbdcb45d09e32239bc23',
  'default/7': '9bf7b3c09f36ba65c1ac37285f9fc6522e02c02137442de72110720916fa5bbd',
  'open/7': 'b4eca3749001f5db534a2b0eaf82ab8b4cbc9f26182232a6cf84b7d54ed64189',
};

function normalizedDigest(world: World): string {
  const copy = cloneWorld(world);
  const params = structuredClone(paramsOf(copy));
  params.motor.hilos = 1;
  setParams(copy, params);
  return digestoCanonico(copy);
}

test('V22: RULES_VERSION 14; 0 ULP, dos semillas y dos regímenes durante 240 pasos', () => {
  assert.equal(RULES_VERSION, 14);
  for (const seed of [51926, 7]) for (const [name, config] of [['default', ''], ['open', OPEN]] as const) {
    const serial = createWorld(seed, parseParams(config ? `${config},motor.hilos=1` : 'motor.hilos=1'));
    const parallel = createWorld(seed, parseParams(config ? `${config},motor.hilos=4` : 'motor.hilos=4'));
    for (let tick = 0; tick < 240; tick++) { stepWorld(serial); stepWorld(parallel); }
    const digest = normalizedDigest(serial);
    assert.equal(normalizedDigest(parallel), digest, `${name}/${seed}: mundo, demografía, obras, química y eventos`);
    assert.equal(digest, GOLDEN[`${name}/${seed}`], `${name}/${seed}: digesto GOLDEN (${name === 'default' ? 'histórico V8/V22' : 'leyes v23/V24'})`);
  }
});

test('V22: la paginación certificada se reutiliza y los valores dinámicos se releen', () => {
  const world = createWorld(51926);
  const owner = new ResidentTopologyOwner();
  world.tiles = owner.tiles(world.tiles.map(tile => owner.tile(tile)));
  const packed = new EstadoPersonasCompartido();
  packed.empaquetar(escenaDesdeMundo(world));
  assert.equal(packed.reutilizacionesPaginas, 0);
  packed.empaquetar(escenaDesdeMundo(world));
  assert.equal(packed.reutilizacionesPaginas, 1);
  const tile = world.tiles[0]!;
  tile.food = 0.73125;
  packed.empaquetar(escenaDesdeMundo(world));
  assert.equal(packed.reutilizacionesPaginas, 2);
  assert.ok(packed.vista().comida.includes(0.73125));
  tile.x += 16;
  packed.empaquetar(escenaDesdeMundo(world));
  assert.equal(packed.reutilizacionesPaginas, 2, 'una coordenada mutada invalida el certificado');
});

test('V22: diagnóstico de costes en una escena de 85 páginas, 81 personas y 652 animales', t => {
  const world = createWorld(51926);
  for (let i = 0; i < 240; i++) stepWorld(world);
  const templateTiles = world.tiles.slice(0, 256);
  for (let page = 0; page < 79; page++) for (const tile of templateTiles)
    world.tiles.push({ ...tile, x: tile.x + 1000 + page * 16 });
  const originalPeople = [...world.people], originalAnimals = [...world.animals], originalStructures = [...world.structures];
  while (world.people.length < 81) {
    const person = structuredClone(originalPeople[world.people.length % originalPeople.length]!);
    person.id = `bench-person-${world.people.length}`; world.people.push(person);
  }
  while (world.animals.length < 652) {
    const animal = structuredClone(originalAnimals[world.animals.length % originalAnimals.length]!);
    animal.id = `bench-animal-${world.animals.length}`; world.animals.push(animal);
  }
  while (world.structures.length < 137) {
    const index = world.structures.length, structure = originalStructures[index % originalStructures.length]!;
    world.structures.push({ ...structure, id: `bench-structure-${index}`, x: 1000 + index * 16 });
  }
  setParams(world, parseParams('construccion.modular=true'));
  world.animals.forEach((animal, index) => { animal.id = `bench-animal-${String(index).padStart(4, '0')}`; });
  const people = new EstadoPersonasCompartido(), fauna = new EstadoFaunaCompartido();
  const state = { occupants: new Map(), counts: new Map() };
  const measure = (fn: () => void): string => {
    fn(); const start = performance.now();
    for (let i = 0; i < 20; i++) fn();
    return ((performance.now() - start) / 20).toFixed(3);
  };
  const costs: Record<string, string | number> = {
    pages: world.tiles.length / 256,
    personsFullMs: measure(() => people.empaquetar(escenaDesdeMundo(world))),
    personsMoveMs: measure(() => people.empaquetarSoloMovimiento(world)),
    faunaPackMs: measure(() => fauna.empaquetar(world, world.animals.slice(0, 32), state)),
    faunaSparseDueMs: measure(() => fauna.empaquetar(world, world.animals.slice(0, 16), state)),
    inventionsMs: measure(() => { for (const p of world.people) { constructionSite(world, p); storedMaterialsNear(world, p); repairOpportunity(world, p); } }),
    inventionsBuilderMs: measure(() => { for (const p of world.people) {
      const action = p.action; p.action = 'build'; depositMaterials(world, p, world.structures[0]!); p.action = action;
    } }),
    worldStatisticsMs: measure(() => { world.tick++; worldStatistics(world); }),
  };
  const baseAnimals = [...world.animals];
  while (world.animals.length < 4096) {
    const index = world.animals.length;
    const animal = structuredClone(baseAnimals[index % baseAnimals.length]!);
    animal.id = `bench-animal-${String(index).padStart(4, '0')}`;
    world.animals.push(animal);
  }
  const due = world.animals.slice(2048, 2064);
  costs.faunaSparse4096Ms = measure(() => fauna.empaquetar(world, due, state));
  const view = fauna.vista();
  for (let i = 0; i < due.length; i++) assert.equal(view.di[DI.rango * fauna.params.capDue + i], 2048 + i);
  t.diagnostic(JSON.stringify(costs));
});
