import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createWorld, stepWorld } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { parseParams, setParams } from '../src/world/params.js';
import { ResidentTopologyOwner } from '../src/world/soa/topologia.js';
import { worldStatistics } from '../src/world/statistics.js';
import { constructionSite, depositMaterials, storedMaterialsNear, repairOpportunity } from '../src/world/inventions.js';

const OPEN = 'poblacion.natalidadVecindad=true,social.maxComunidades=0,limites.aplicacion=parametros,limites.chunks=65536,limites.teselasActivas=16777216,limites.comunidades=16777216,limites.fauna=100663296,construccion.modular=true,construccion.poliminosYSinergia=true,terreno.caminosFisicos=true,quimica.emergente=true,motor.soaTerreno=true,motor.particionarPersonas=true';
test('dos corridas de un hilo y semilla fija reproducen el mundo en ambos regímenes', () => {
  for (const seed of [51926, 7]) for (const config of ['', OPEN]) {
    const params = parseParams(config ? config + ',motor.hilos=1' : 'motor.hilos=1');
    const primero = createWorld(seed, params);
    const segundo = createWorld(seed, params);
    for (let tick = 0; tick < 240; tick++) { stepWorld(primero); stepWorld(segundo); }
    assert.equal(digestoCanonico(primero), digestoCanonico(segundo));
  }
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
  const measure = (fn: () => void): string => {
    fn(); const start = performance.now();
    for (let i = 0; i < 20; i++) fn();
    return ((performance.now() - start) / 20).toFixed(3);
  };
  const costs: Record<string, string | number> = {
    pages: world.tiles.length / 256,
    inventionsMs: measure(() => { for (const p of world.people) { constructionSite(world, p); storedMaterialsNear(world, p); repairOpportunity(world, p); } }),
    inventionsBuilderMs: measure(() => { for (const p of world.people) {
      const action = p.action; p.action = 'build'; depositMaterials(world, p, world.structures[0]!); p.action = action;
    } }),
    worldStatisticsMs: measure(() => { world.tick++; worldStatistics(world); }),
  };
  t.diagnostic(JSON.stringify(costs));
});
