import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertWorld, cloneWorld, closePersonasParallelPools, closePolicyGpuBatchers, createWorld,
  migrateWorld, RULES_VERSION, stepWorld, type World,
} from '../src/world/index.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { gpuNvrtcAvailable } from '../src/world/gpu/puente.js';
import { policyGpuBatcherStatus } from '../src/world/gpu/politica-gpu.js';
import { DEFAULT_PARAMS, paramsOf, parseParams, setParams } from '../src/world/params.js';
import { policyDiversity } from '../src/world/politica.js';
import { analyzeTechnologicalComplexity } from '../src/world/tecnologia-complejidad.js';
import { activate, tileAt } from '../src/world/spatial.js';
import { demographicTraits } from '../src/world/demography.js';
import { updateCommunities } from '../src/world/society.js';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import { Store } from '../src/server/store.js';

after(async () => {
  closePolicyGpuBatchers();
  await closePersonasParallelPools();
  await closeEcosystemWorkers();
});

const V12_OPEN_LAWS = [
  'poblacion.natalidadVecindad=true',
  'poblacion.radioVecindadNatalidad=16',
  'social.radioConvivencia=12',
  'social.disolucion=1',
  'social.maxComunidades=0',
  'conducta.aptitud=0.35',
  'conducta.politicaPeso=0.35',
  'tecnologia.evitarNoOp=true',
  'tecnologia.dosisCuanto=50',
  'tecnologia.enfriamiento=240',
].join(',');

function digestoSinMotor(world: World): string {
  const copia = cloneWorld(world);
  const params = structuredClone(paramsOf(copia));
  Object.assign(params.motor, { hilos: 1, orden: 'natural', gpu: [], soaTerreno: false, particionarPersonas: false });
  setParams(copia, params);
  return digestoCanonico(copia);
}

test('V12: hostOpenWorldParams activa todos los chips y todas las leyes de evolución abierta', () => {
  const params = hostOpenWorldParams(DEFAULT_PARAMS, {
    cpuThreads: () => 32,
    totalRamBytes: () => 128 * 1024 ** 3,
    nvrtcAvailable: () => true,
    nvidiaSmi: () => '0\n1\n',
    memory: () => ({ fisicaBytes: 128 * 1024 ** 3, heapBytes: 8 * 1024 ** 3 }),
  });
  assert.equal(params.motor.hilos, 28);
  assert.deepEqual(params.motor.gpu, [0, 1]);
  assert.equal(params.motor.soaTerreno, true);
  assert.equal(params.motor.particionarPersonas, true);
  assert.equal(params.motor.clonPorPaso, true);
  assert.equal(params.gobernador.politica, 'techo');
  assert.equal(params.gobernador.presupuestoMs, 100);
  assert.equal(params.recursos.capacidadBosque, 0.65);
  assert.equal(params.recursos.capacidadPastizal, 0.45);
  assert.equal(params.recursos.velocidadRegeneracion, 0.55);
  assert.equal(params.agua.cuencas, 0.3);
  assert.equal(params.agua.memoria, 0.65);
  assert.equal(params.poblacion.natalidadVecindad, true);
  assert.equal(params.poblacion.radioVecindadNatalidad, 16);
  assert.equal(params.social.radioConvivencia, 12);
  assert.equal(params.social.disolucion, 1);
  assert.equal(params.social.maxComunidades, 0);
  assert.equal(params.social.derivaCultural, 1);
  assert.equal(params.social.vinculoEncuentro, 1);
  assert.equal(params.conducta.aptitud, 0.35);
  assert.equal(params.conducta.politicaPeso, 1.15);
  assert.equal(params.conducta.politicaAutonomia, 0.65);
  assert.equal(params.tecnologia.evitarNoOp, true);
  assert.equal(params.tecnologia.dosisCuanto, 100);
  assert.equal(params.tecnologia.mejoraLocal, 0.08);
  assert.equal(params.tecnologia.enfriamiento, 240);
  assert.equal(params.tecnologia.efectosHerramientas, true);
});

test('V12: paridad bit a bit en evolución abierta entre serie, particionarPersonas (1/4/28 hilos, adversarial/inverso)', () => {
  const run = (motor: string) => {
    const world = createWorld(51926, parseParams(`${V12_OPEN_LAWS},${motor}`));
    const pasosParalelos: number[] = [];
    for (let t = 0; t < 180; t++) {
      stepWorld(world, [], {
        personasExecution: { onStep: diag => { pasosParalelos.push(diag.hilos); } },
      });
    }
    assertWorld(world);
    return { world, pasosParalelos };
  };

  const serie = run('motor.hilos=1,motor.particionarPersonas=false,motor.soaTerreno=false');
  const part1 = run('motor.hilos=1,motor.particionarPersonas=true,motor.soaTerreno=true');
  const part4Adv = run('motor.hilos=4,motor.particionarPersonas=true,motor.soaTerreno=true,motor.orden=adversarial');
  const part28Inv = run('motor.hilos=28,motor.particionarPersonas=true,motor.soaTerreno=true,motor.orden=inverso');

  assert.equal(serie.pasosParalelos.length, 0);
  assert.ok(part28Inv.pasosParalelos.length >= 30, 'debe despachar la fase personas en cada paso de movimiento');
  assert.ok(part28Inv.pasosParalelos.every(h => h === 28), 'debe correr en los 28 hilos configurados');

  const dSerie = digestoSinMotor(serie.world);
  assert.equal(digestoSinMotor(part1.world), dSerie, 'hilos=1 particionarPersonas=true debe ser bit a bit idéntico');
  assert.equal(digestoSinMotor(part4Adv.world), dSerie, 'hilos=4 adversarial debe ser bit a bit idéntico');
  assert.equal(digestoSinMotor(part28Inv.world), dSerie, 'hilos=28 inverso debe ser bit a bit idéntico');
});

test('V12: paridad bit a bit CPU vs GPU [0] vs Dual-GPU [0,1] con política evolutiva y ecología CUDA activas', { skip: !gpuNvrtcAvailable() }, () => {
  const run = (motor: string) => {
    const world = createWorld(51926, parseParams(`${V12_OPEN_LAWS},${motor}`));
    for (let t = 0; t < 120; t++) stepWorld(world);
    assertWorld(world);
    return world;
  };
  const cpu = run('motor.hilos=1,motor.particionarPersonas=false,motor.gpu=[]');
  const gpu0 = run('motor.hilos=4,motor.particionarPersonas=true,motor.soaTerreno=true,motor.gpu=[0]');
  const gpu01 = run('motor.hilos=28,motor.particionarPersonas=true,motor.soaTerreno=true,motor.gpu=[0,1]');

  const dCpu = digestoSinMotor(cpu);
  assert.equal(digestoSinMotor(gpu0), dCpu, 'GPU [0] + 4 hilos debe ser bit a bit idéntico a CPU');
  assert.equal(digestoSinMotor(gpu01), dCpu, 'Dual-GPU [0,1] + 28 hilos debe ser bit a bit idéntico a CPU');
  const status01 = policyGpuBatcherStatus([0, 1]);
  assert.equal(status01?.backend, 'gpu', `esperado backend gpu para [0,1], recibido: ${JSON.stringify(status01)}`);
});

test('V12: evolución real, no-herencia Baldwin de plasticidad, diversidad de políticas y round-trip SQLite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-v12-store-'));
  let store: Store | undefined;
  try {
    const world = createWorld(42, parseParams(`${V12_OPEN_LAWS},motor.clonPorPaso=false`));
    // Perturbamos la plasticidad adquirida de los fundadores para comprobar que jamás pasa al ADN de las crías.
    for (const p of world.people) {
      assert.ok(p.policy && p.policyPlasticity, 'fundadores V12 con politicaPeso>0 deben iniciar política y plasticidad');
      p.policyPlasticity.bias.fill(0.42);
      p.policyPlasticity.trace.fill(0.8);
    }
    for (let t = 0; t < 1200; t++) stepWorld(world);
    assertWorld(world);
    assert.ok(world.birthCounter > 0, 'semilla 42 debe tener nacimientos en 1200 pasos');
    const children = world.people.filter(p => p.genome.generation > 0);
    assert.ok(children.length > 0, 'debe haber descendientes vivos');
    for (const child of children) {
      assert.ok(child.policy, 'cada cría hereda su red de política');
      assert.ok(child.policyPlasticity, 'cada cría inicia su plasticidad propia');
      // Ninguna cría nace con el sesgo adquirido 0.42 copiado de sus padres.
      assert.ok(child.policyPlasticity.bias.every(b => Math.abs(b) < 0.4), 'la plasticidad adquirida no se hereda (Baldwin, no Lamarck)');
    }
    const diversity = policyDiversity(world.people.map(p => p.policy!));
    assert.ok(Number.isFinite(diversity) && diversity > 0.05, `diversidad de políticas esperada > 0.05, medida=${diversity}`);
    const tech = analyzeTechnologicalComplexity(world.technology.recipes);
    assert.ok(Number.isFinite(tech.meanGeneration) && tech.totalRecipes === world.technology.recipes.length);

    store = new Store(join(dir, 'world.sqlite'));
    store.save(world);
    store.close();
    store = new Store(join(dir, 'world.sqlite'));
    const loaded = store.load()!.world;
    assert.equal(loaded.version, RULES_VERSION);
    assert.equal(digestoCanonico(loaded), digestoCanonico(world), 'round-trip SQLite conserva políticas y plasticidad bit a bit');
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V12: natalidad local rompe el cuello global de 2/120 ticks entre aldeas separadas y maxComunidades=0 elimina el techo de 8', () => {
  const buildVillages = (natalidadVecindad: boolean) => {
    const world = createWorld(7, parseParams(
      `poblacion.natalidadVecindad=${natalidadVecindad},poblacion.radioVecindadNatalidad=16,poblacion.exigeComunidad=false,social.maxComunidades=0`,
    ));
    world.tick = 119; // el siguiente paso es tick=120 (ventana de reproducción)
    // Creamos 4 aldeas separadas por 48 celdas (> 16), cada una con un par fértil y suelo fértil.
    const coords = [{ x: 10, y: 10 }, { x: 58, y: 10 }, { x: 10, y: 58 }, { x: 58, y: 58 }];
    const baseNeighbors = world.people.filter(p => p.role === 'neighbor').slice(0, 8);
    // Retiramos a los demás vecinos del rango fértil para aislar los 4 pares exactos.
    for (const p of world.people) {
      if (p.role === 'neighbor' && !baseNeighbors.includes(p)) p.inventory = 0;
    }
    coords.forEach((c, idx) => {
      activate(world, c.x, c.y);
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const tile = tileAt(world, { x: c.x + dx, y: c.y + dy });
        if (tile) { tile.terrain = 'meadow'; tile.food = 0.6; tile.drinkingWater = 0.5; }
      }
      world.places.push({ id: `village-${idx}`, name: `Aldea ${idx}`, x: c.x, y: c.y, description: 'Aldea', gatherings: 0 });
      const a = baseNeighbors[idx * 2]!;
      const b = baseNeighbors[idx * 2 + 1]!;
      a.x = c.x; a.y = c.y; a.target = { x: c.x, y: c.y };
      b.x = c.x + 1; b.y = c.y; b.target = { x: c.x + 1, y: c.y };
      for (const p of [a, b]) {
        const dt = demographicTraits(p.genome, paramsOf(world).cuerpo);
        p.inventory = 0.22; p.hunger = 0.05; p.thirst = 0.05; p.fatigue = 0.05; p.energy = 0.95;
        p.demography.health = 1; p.demography.vitality = 1; p.demography.age = dt.maturityAge + 200;
        p.bornAt = world.tick - p.demography.age;
        p.lastBirth = world.tick - dt.fertilityCooldown - 100;
        p.action = 'rest';
        p.decisionAt = 500;
      }
      a.bonds[b.id] = 0.9;
      b.bonds[a.id] = 0.9;
    });
    stepWorld(world);
    return world;
  };

  const globalCapped = buildVillages(false);
  const localUncapped = buildVillages(true);
  assert.equal(globalCapped.birthCounter, 2, 'sin natalidadVecindad el cupo global recorta a 2 nacimientos aunque haya 4 aldeas fértiles');
  assert.equal(localUncapped.birthCounter, 4, 'con natalidadVecindad las 4 aldeas separadas conciben en paralelo (4 nacimientos simultáneos)');

  // maxComunidades=0 elimina el techo artificial de 8 comunidades (solo limita la admisión del host).
  const worldCom = createWorld(7, parseParams('social.maxComunidades=0,limites.comunidades=64'));
  worldCom.tick = 120;
  const allNeighbors = worldCom.people.filter(p => p.role === 'neighbor');
  const trio = allNeighbors.slice(0, 3);
  const keepers = allNeighbors.slice(3, 11); // 8 vecinos distintos sostienen 8 comunidades existentes
  assert.equal(keepers.length, 8);
  for (let i = 0; i < 8; i++) {
    const holder = keepers[i]!;
    const cid = `community-${i + 1}`;
    holder.communityId = cid;
    holder.x = 50 + i * 20; holder.y = 50;
    activate(worldCom, holder.x, holder.y);
    worldCom.communities.push({
      id: cid, name: `Círculo ${i + 1}`, x: holder.x, y: holder.y, color: '#9dc8ae',
      members: [holder.id], culture: { sharing: 0.5, stewardship: 0.5, openness: 0.5 }, formedAt: 0, cooperation: 0, disputes: 0,
    });
  }
  worldCom.communityCounter = 8;
  for (const p of trio) {
    p.x = worldCom.places[0]!.x; p.y = worldCom.places[0]!.y;
    p.communityId = null; p.culture = { sharing: 0.5, stewardship: 0.5, openness: 0.5 };
    for (const q of trio) if (q !== p) p.bonds[q.id] = 0.9;
  }
  updateCommunities(worldCom, ev => ({ id: 'evt-test', tick: worldCom.tick, ...ev }));
  assert.equal(worldCom.communities.length, 9, 'con social.maxComunidades=0 se puede fundar la comunidad #9 sin techo de 8');

  // Validación: V11 corrupta con campo policy no pasa migrateWorld
  const v11WithPolicy = createWorld(7);
  v11WithPolicy.version = 11;
  v11WithPolicy.people[0]!.policy = { weights: new Array(212).fill(0) };
  assert.throws(() => migrateWorld(v11WithPolicy), 'un snapshot V11 no puede colar campos exclusivos de V12');
});
