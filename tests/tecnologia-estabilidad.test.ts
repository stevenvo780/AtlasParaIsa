import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.js';
import { assertWorld, createWorld, stepWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { digestoSin } from '../scripts/lab/rendimiento.js';
import {
  DEFAULT_PARAMS,
  HISTORICAL_PARAMS,
  PARAM_DESCRIPTORS,
  PARAM_RANGES,
  paramsOf,
  parseParams,
  setParams,
} from '../src/world/params.js';
import {
  assertTechnology,
  defaultTechnologyState,
  initialTechnologyKnowledge,
  materialCapacities,
  programSignature,
  projectTechnology,
  proposeTechnologyProgram,
  researchTechnology,
  technologyOpportunity,
  technologyWorkCost,
  toolCapacities,
  type TechnologyActor,
  type TechnologyHost,
  type TechnologyProgram,
} from '../src/world/technology.js';
import { resolveTechnologyRecipe, technologyCatalogueTotals } from '../src/world/technology-catalogue.js';
import { filaInstantanea, laboratorio, reescribirInstantanea, type ConLimpieza } from './lib/store.js';
import { PROGRAMA_FILO as edge, proyectoInvestigacion } from './lib/escenas.js';

const lab = (t: ConLimpieza) => laboratorio(t, 'atlas-tec-estab-');
const CANDIDATO = 'tecnologia.dosisCuanto=250,tecnologia.mejoraLocal=0.05,tecnologia.enfriamiento=300,tecnologia.evitarNoOp=true';

function scene(seed = 51926, paramsText?: string) {
  const actor = (id: string): TechnologyActor => ({
    id, x: 0, y: 0, energy: 1, fatigue: 0, hunger: 0.1, thirst: 0.1, curiosity: 0.9,
    materials: { wood: 12, stone: 8 }, skills: {}, technology: initialTechnologyKnowledge(),
  });
  const a = actor('a'), b = actor('b');
  const host: TechnologyHost = {
    seed, tick: 0, people: [a, b], technology: defaultTechnologyState(),
    tiles: [{ x: 0, y: 0, drinkingWater: 0.2 }],
  };
  if (paramsText !== undefined) setParams(host, parseParams(paramsText));
  return { host, a, b };
}

function runProgram(host: TechnologyHost, actor: TechnologyActor, program: TechnologyProgram, parents: string[] = []): boolean {
  actor.technology.project = proyectoInvestigacion(structuredClone(program), host.tick, parents);
  let result = false;
  for (let n = 0; actor.technology.project && n < 400; n++) {
    host.tick++;
    if ('demographyDynamics' in host) {
      const world = host as World;
      for (const person of world.people) person.demography.age = world.tick - person.bornAt;
    }
    result = researchTechnology(host, actor);
  }
  return result;
}

// ── (1) Q5: reproducibilidad de digestoCanonico con defaults históricos ──────────────────────────
// V23: sin digestos dorados con valor fijo. Misma semilla, un hilo, sin tarjeta, con Store temporal
// guardado antes del tick 1 y 1.200 ticks: dos corridas de lo mismo dan el mismo digesto físico (se quitan
// de la forma hasheada las claves que con su valor histórico no actúan).
test('Q5: reproducibilidad de digestoCanonico en 2 semillas (7, 42) × 1200 pasos con valores históricos', { timeout: 600_000 }, t => {
  assert.deepEqual(HISTORICAL_PARAMS.tecnologia, { dosisCuanto: 0, mejoraLocal: 0, enfriamiento: 45, evitarNoOp: false, efectosHerramientas: false });
  assert.deepEqual(DEFAULT_PARAMS.tecnologia, HISTORICAL_PARAMS.tecnologia, 'Constitución II: DEFAULT_PARAMS nace en valores históricos');

  const correr = (seed: number, base: typeof HISTORICAL_PARAMS): string => {
    const { store } = lab(t);
    const world = createWorld(seed, base);
    store.save(world);
    for (let tick = 1; tick <= 1200; tick++) stepWorld(world);
    return digestoSin(world, ['tecnologia', 'poblacion.natalidadVecindad', 'poblacion.radioVecindadNatalidad', 'conducta.politicaPeso'], 11);
  };
  for (const seed of [7, 42] as const) {
    for (const [modo, base] of [['historicos', HISTORICAL_PARAMS], ['defaults', DEFAULT_PARAMS]] as const)
      assert.equal(correr(seed, base), correr(seed, base), `semilla ${seed} (${modo}): dos corridas, mismo digesto físico`);
  }
});

// ── (2) Conservación exacta de masa ───────────────────────────────────────────────────────────
test('conservación exacta de masa (massError === 0) en intentos aceptados, rechazados por mejoraLocal y fallidos físicamente', t => {
  const { host, a } = scene(51926, CANDIDATO);

  // (a) Intento aceptado (gen 1 útil: cutting > 0.6)
  assert.equal(runProgram(host, a, edge), true);
  assert.equal(host.technology.recipeCounter, 1);
  assert.equal(projectTechnology(host).dynamics.massError, 0);
  assertTechnology(host);

  // (b) Intento rechazado por puerta local mejoraLocal (gen 2 no-op con cool añadido: más trabajo, misma capacidad)
  const dominated: TechnologyProgram = {
    inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
    steps: [...edge.steps, { op: 'cool', intensity: 1 }],
  };
  const residueBefore = a.technology.residue.stone;
  assert.equal(runProgram(host, a, dominated, ['recipe-1']), false);
  assert.equal(host.technology.recipeCounter, 1, 'rechazado por mejoraLocal no registra receta');
  assert.equal(a.technology.residue.stone, residueBefore + 1000, 'toda la materia del intento rechazado vuelve a residuo');
  assert.equal(projectTechnology(host).dynamics.massError, 0);
  assertTechnology(host);

  // (c) Intento fallido físicamente (consume combustible y materia)
  const physicalFail: TechnologyProgram = {
    inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
    steps: [{ op: 'heat', intensity: 4 }, { op: 'weave', intensity: 4 }],
  };
  assert.equal(runProgram(host, a, physicalFail), false);
  assert.equal(projectTechnology(host).dynamics.massError, 0);
  assertTechnology(host);

  // (d) Simulación real con Store y paquete candidato completo
  const { store } = lab(t);
  const world = createWorld(42, parseParams(CANDIDATO));
  store.save(world);
  for (let tick = 1; tick <= 1200; tick++) {
    stepWorld(world);
    if (tick % 300 === 0) store.save(world);
  }
  assert.equal(projectTechnology(world).dynamics.massError, 0);
  assertWorld(world);
});

// ── (3) B1: cuantización dosisCuanto=250 ──────────────────────────────────────────────────────
test('B1: dosisCuanto=250 cuantiza masas desgastadas 347 vs 348 a la misma propuesta y programSignature', () => {
  const setup = (dosisCuanto: number, wornMass: number, kind: 'residue' | 'product') => {
    const { host, a } = scene(9001, `tecnologia.dosisCuanto=${dosisCuanto}`);
    a.materials = { wood: 0, stone: 0 };
    host.tiles = [{ x: 0, y: 0, drinkingWater: 0 }];
    if (kind === 'residue') {
      a.technology.residue.stone = wornMass;
      host.technology.ledger.imported.stone = wornMass;
    } else {
      a.materials.stone = 1;
      assert.equal(runProgram(host, a, edge), true);
      a.materials.stone = 0;
      const item = a.technology.items[0]!;
      const wear = item.mass - wornMass;
      item.composition.stone -= wear;
      item.mass = wornMass;
      a.technology.residue.stone = 0;
      host.technology.ledger.imported.stone = wornMass;
      a.technology.attempts = 7;
    }
    return { host, a };
  };

  // Residuo desgastado: 347 vs 348 → ambos proponen 250 con dosisCuanto=250
  const r347 = setup(250, 347, 'residue'), r348 = setup(250, 348, 'residue');
  const pr347 = proposeTechnologyProgram(r347.host, r347.a)!, pr348 = proposeTechnologyProgram(r348.host, r348.a)!;
  assert.equal(pr347.program.inputs[0]!.source, 'residue');
  assert.equal(pr347.program.inputs[0]!.mass, 250);
  assert.equal(pr348.program.inputs[0]!.mass, 250);
  assert.equal(programSignature(pr347.program), programSignature(pr348.program));

  // Producto desgastado: 347 vs 348 → ambos proponen 250 con dosisCuanto=250
  const p347 = setup(250, 347, 'product'), p348 = setup(250, 348, 'product');
  const pp347 = proposeTechnologyProgram(p347.host, p347.a)!, pp348 = proposeTechnologyProgram(p348.host, p348.a)!;
  const prodInput347 = pp347.program.inputs.find(i => i.source === 'product')!;
  const prodInput348 = pp348.program.inputs.find(i => i.source === 'product')!;
  assert.ok(prodInput347 && prodInput348, 'debe proponer el producto desgastado');
  assert.equal(prodInput347.mass, 250);
  assert.equal(prodInput348.mass, 250);
  assert.equal(programSignature(pp347.program), programSignature(pp348.program));

  // Control histórico (dosisCuanto=0): 347 vs 348 generan firmas distintas
  const h347 = setup(0, 347, 'residue'), h348 = setup(0, 348, 'residue');
  const ph347 = proposeTechnologyProgram(h347.host, h347.a)!, ph348 = proposeTechnologyProgram(h348.host, h348.a)!;
  assert.equal(ph347.program.inputs[0]!.mass, 347);
  assert.equal(ph348.program.inputs[0]!.mass, 348);
  assert.notEqual(programSignature(ph347.program), programSignature(ph348.program));
});

// ── (4) B2: redescubrimiento pagado conservado ────────────────────────────────────────────────
test('B2: redescubrimiento pagado con mejoraLocal=0.05 conserva id, inventorId, tick, parents y generation (incluido desde archivo SQLite)', t => {
  const { store } = lab(t);
  const world = createWorld(51926, parseParams('tecnologia.mejoraLocal=0.05'));
  store.save(world);

  const inventor = world.people[2]!, rediscoverer = world.people[3]!;
  for (const person of [inventor, rediscoverer]) {
    person.materials = { wood: 12, stone: 8 };
    person.energy = 1; person.fatigue = 0; person.hunger = 0.1; person.thirst = 0.1;
  }

  // Gen 1 inventada por `inventor`
  assert.equal(runProgram(world, inventor, edge), true);
  const gen1 = resolveTechnologyRecipe(world, 'recipe-1')!;
  assert.equal(gen1.inventorId, inventor.id);
  const gen1Tick = gen1.tick;

  // Gen 2 inventada por `inventor` (compone producto gen 1 + madera → nueva función cultivation)
  const gen2Program: TechnologyProgram = {
    inputs: [{ source: 'product', recipeId: gen1.id, mass: 250 }, { source: 'raw', material: 'wood', mass: 1000 }],
    steps: [{ op: 'combine', intensity: 4 }, { op: 'form', shape: 'rod', intensity: 4 }],
  };
  assert.equal(runProgram(world, inventor, gen2Program, [gen1.id]), true);
  const gen2 = resolveTechnologyRecipe(world, 'recipe-2')!;
  assert.equal(gen2.generation, 2);
  assert.deepEqual(gen2.parents, [gen1.id]);
  const gen2Tick = gen2.tick;

  // Guardar en Store y expulsar de la memoria local y caché residente
  store.save(world);
  inventor.technology.knownRecipes = [];
  world.technology.recipes = [];

  // `rediscoverer` (sin conocerla) redescubre gen 1 pagando materiales y trabajo
  assert.equal(rediscoverer.technology.knownRecipes.includes(gen1.id), false);
  const recipesBefore = world.technology.recipeCounter;
  assert.equal(runProgram(world, rediscoverer, edge), true);
  assert.equal(world.technology.recipeCounter, recipesBefore, 'redescubrir no crea una definición duplicada');
  assert.ok(rediscoverer.technology.knownRecipes.includes(gen1.id));
  assert.equal(rediscoverer.technology.items.at(-1)?.recipeId, gen1.id);

  const afterGen1 = resolveTechnologyRecipe(world, gen1.id)!;
  assert.equal(afterGen1.id, gen1.id);
  assert.equal(afterGen1.inventorId, inventor.id);
  assert.equal(afterGen1.tick, gen1Tick);
  assert.deepEqual(afterGen1.parents, []);
  assert.equal(afterGen1.generation, 1);
  assert.equal(afterGen1.manufactured, 2);

  // `rediscoverer` también redescubre gen 2 desde el archivo SQLite
  assert.equal(runProgram(world, rediscoverer, gen2Program, [gen1.id]), true);
  assert.equal(world.technology.recipeCounter, recipesBefore);
  const afterGen2 = resolveTechnologyRecipe(world, gen2.id)!;
  assert.equal(afterGen2.id, gen2.id);
  assert.equal(afterGen2.inventorId, inventor.id);
  assert.equal(afterGen2.tick, gen2Tick);
  assert.deepEqual(afterGen2.parents, [gen1.id]);
  assert.equal(afterGen2.generation, 2);
  assert.equal(afterGen2.manufactured, 2);
  assert.equal(projectTechnology(world).dynamics.massError, 0);
  assertWorld(world);
});

// ── (5) B2 puerta local, Pareto por trabajo y refuerzo negativo en stepWorld ──────────────────
test('B2: mutación no-op/dominada no registra receta, devuelve masa a residuo y aplica refuerzo negativo; dominancia Pareto por trabajo sí se acepta', () => {
  // (a) Rechazo local + dominancia Pareto por trabajo en escena unitaria
  const { host, a } = scene(777, 'tecnologia.mejoraLocal=0.05');
  const bloatedEdge: TechnologyProgram = {
    inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
    steps: [{ op: 'form', shape: 'edge', intensity: 4 }, { op: 'abrade', intensity: 3 }, { op: 'cool', intensity: 1 }],
  };
  assert.equal(runProgram(host, a, bloatedEdge), true);
  assert.equal(host.technology.recipeCounter, 1);
  const parentWork = technologyWorkCost(bloatedEdge);

  // Mutación estrictamente dominada (más cara, misma capacidad)
  const worse: TechnologyProgram = {
    inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
    steps: [...bloatedEdge.steps, { op: 'cool', intensity: 2 }],
  };
  const itemsBefore = a.technology.items.length, failuresBefore = host.technology.ledger.failures;
  const residueBefore = a.technology.residue.stone;
  assert.equal(runProgram(host, a, worse, ['recipe-1']), false);
  assert.equal(host.technology.recipeCounter, 1);
  assert.equal(a.technology.items.length, itemsBefore);
  assert.equal(host.technology.ledger.failures, failuresBefore + 1);
  assert.equal(a.technology.residue.stone, residueBefore + 1000);
  const lastExec = host.technology.history.at(-1)!;
  assert.equal(lastExec.recipeId, null);
  assert.equal(lastExec.success, false);
  assert.equal(projectTechnology(host).dynamics.massError, 0);
  assertTechnology(host);

  // Dominancia Pareto por coste de trabajo (sin `cool(1)`: mismas capacidades, estrictamente menor coste)
  const leanerEdge: TechnologyProgram = {
    inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
    steps: [{ op: 'form', shape: 'edge', intensity: 4 }, { op: 'abrade', intensity: 3 }],
  };
  assert.ok(technologyWorkCost(leanerEdge) < parentWork);
  assert.equal(runProgram(host, a, leanerEdge, ['recipe-1']), true);
  assert.equal(host.technology.recipeCounter, 2, 'dominancia Pareto por menor trabajo debe aceptarse');
  assertTechnology(host);

  // (b) Refuerzo negativo (-0.12) a través de stepWorld (src/world/index.ts:1066)
  const runOutcomeCase = (mejoraLocal: number) => {
    const world: World = createWorld(51926, parseParams(`tecnologia.mejoraLocal=${mejoraLocal}`));
    const person = world.people[2]!;
    person.materials = { wood: 12, stone: 8 };
    person.energy = 1; person.fatigue = 0; person.hunger = 0.05; person.thirst = 0.05;
    assert.equal(runProgram(world, person, edge), true);
    person.materials = { wood: 12, stone: 8 };
    person.energy = 1; person.fatigue = 0; person.hunger = 0.05; person.thirst = 0.05;
    const dominated: TechnologyProgram = {
      inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
      steps: [...edge.steps, { op: 'cool', intensity: 1 }],
    };
    const project = proyectoInvestigacion(dominated, world.tick, ['recipe-1']);
    project.progress = project.requiredWork - 1;
    person.technology.project = project;
    person.action = 'research';
    person.target = { x: person.x, y: person.y };
    person.decisionAt = world.tick + 100;
    const key = `${person.intentContext}:research`;
    person.values[key] = 0;
    const recipesBefore = world.technology.recipeCounter;
    stepWorld(world);
    return { valueAfter: person.values[key] ?? 0, recipesDelta: world.technology.recipeCounter - recipesBefore };
  };

  const control = runOutcomeCase(0), gated = runOutcomeCase(0.05);
  assert.equal(control.recipesDelta, 1);
  assert.ok(control.valueAfter > 0, 'histórico premia (+0.12) el no-op');
  assert.equal(gated.recipesDelta, 0);
  assert.ok(gated.valueAfter < 0, 'con mejoraLocal > 0, el ensayo estéril recibe refuerzo negativo (-0.12)');
});

// ── (5b) B3 y B4: enfriamiento, craft prioritario, atenuación y evitarNoOp ────────────────────
test('B3 y B4: enfriamiento=300, no saltar craft por attempts%3, atenuación de research con inventario lleno y filtro evitarNoOp', () => {
  // B3: enfriamiento y craft en attempts % 3 === 0
  const { host: hHist, a: aHist } = scene(101);
  const { host: hNew, a: aNew } = scene(101, CANDIDATO);
  for (const [host, a] of [[hHist, aHist], [hNew, aNew]] as const) {
    assert.equal(runProgram(host, a, edge), true);
    a.technology.items = []; // herramienta perdida; conoce recipe-1 y tiene piedra
    a.technology.attempts = 3; // divisible por 3
    a.technology.lastAttempt = host.tick;
  }
  // A dt = 100: histórico ya despertó pero salta craft (attempts%3===0 → research); candidato aún en enfriamiento (100 < 300)
  hHist.tick += 100; hNew.tick += 100;
  assert.equal(technologyOpportunity(hHist, aHist)?.kind, 'research', 'histórico salta craft en attempts % 3 === 0');
  assert.equal(technologyOpportunity(hNew, aNew), undefined, 'candidato respeta enfriamiento=300');

  // A dt = 300: candidato elige craft sin saltarlo por attempts % 3 === 0
  hNew.tick += 200;
  const oppCraft = technologyOpportunity(hNew, aNew);
  assert.equal(oppCraft?.kind, 'craft');
  assert.equal(oppCraft?.recipeId, 'recipe-1');

  // B3: atenuación ×0.35 con inventario lleno y herramienta útil (>= 0.4)
  const { host: hFull, a: aFull } = scene(102, CANDIDATO);
  assert.equal(runProgram(hFull, aFull, edge), true);
  assert.ok(toolCapacities(aFull).cutting >= 0.4);
  hFull.tick += 400;
  const scoreOpen = technologyOpportunity(hFull, aFull)!.score;
  while (aFull.technology.items.length < hFull.technology.budgets.maxItems) {
    aFull.technology.items.push(structuredClone(aFull.technology.items[0]!));
  }
  const scoreFull = technologyOpportunity(hFull, aFull)!.score;
  assert.ok(Math.abs(scoreFull - scoreOpen * 0.35) < 1e-12, `esperado ${scoreOpen * 0.35}, obtenido ${scoreFull}`);

  // B4: evitarNoOp=true reduce drásticamente pasos localmente no-op obvios en propuestas nuevas
  const countNoOps = (evitarNoOp: boolean) => {
    const { host, a } = scene(2026, `tecnologia.evitarNoOp=${evitarNoOp}`);
    host.tiles = [{ x: 0, y: 0, drinkingWater: 0 }];
    let noOps = 0;
    for (let attempt = 0; attempt < 200; attempt++) {
      a.technology.attempts = attempt;
      const proposal = proposeTechnologyProgram(host, a);
      assert.ok(proposal);
      const { inputs, steps } = proposal.program;
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]!, prior = steps.slice(0, i);
        if (s.op === 'cool' && !prior.some(p => p.op === 'heat')) noOps++;
        if (s.op === 'separate' && inputs.length === 1 && inputs[0]!.source === 'raw' && !prior.some(p => p.op === 'combine')) noOps++;
        const prev = i > 0 ? steps[i - 1]! : undefined;
        if (prev && prev.op === s.op && prev.shape === s.shape && prev.material === s.material) noOps++;
      }
    }
    return noOps;
  };
  const noOpsOff = countNoOps(false), noOpsOn = countNoOps(true);
  assert.ok(noOpsOff > 40, `sin evitarNoOp debe haber no-ops frecuentes (medido: ${noOpsOff})`);
  assert.ok(noOpsOn < noOpsOff * 0.1, `con evitarNoOp=true deben caer drásticamente (${noOpsOn} vs ${noOpsOff})`);
});

// ── (6) Espacio abierto: generaciones > 3 y nuevas clases funcionales sin tope fijo ───────────
test('espacio abierto: mejoras sucesivas reales crean generaciones > 3 y múltiples clases funcionales con el paquete candidato', t => {
  const { store } = lab(t);
  const world = createWorld(51926, parseParams(CANDIDATO));
  store.save(world);
  const actor = world.people[2]!;
  const refill = () => {
    actor.materials = { wood: 12, stone: 8 };
    actor.energy = 1; actor.fatigue = 0; actor.hunger = 0.05; actor.thirst = 0.05;
  };

  // Gen 1: filo básico de piedra (intensity 1)
  refill();
  const g1: TechnologyProgram = {
    inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
    steps: [{ op: 'form', shape: 'edge', intensity: 1 }],
  };
  assert.equal(runProgram(world, actor, g1), true);
  assert.equal(resolveTechnologyRecipe(world, 'recipe-1')!.generation, 1);

  // Gen 2: mejora real de corte (intensity 4 + abrade) sobre gen 1
  refill();
  const g2: TechnologyProgram = {
    inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
    steps: [{ op: 'form', shape: 'edge', intensity: 4 }, { op: 'abrade', intensity: 4 }],
  };
  assert.equal(runProgram(world, actor, g2, ['recipe-1']), true);
  assert.equal(resolveTechnologyRecipe(world, 'recipe-2')!.generation, 2);

  // Gen 3: herramienta compuesta de cultivo (producto gen 2 + madera → nueva función cultivation)
  refill();
  const g3: TechnologyProgram = {
    inputs: [{ source: 'product', recipeId: 'recipe-2', mass: 250 }, { source: 'raw', material: 'wood', mass: 1000 }],
    steps: [{ op: 'combine', intensity: 4 }, { op: 'form', shape: 'rod', intensity: 4 }],
  };
  assert.equal(runProgram(world, actor, g3, ['recipe-2']), true);
  assert.equal(resolveTechnologyRecipe(world, 'recipe-3')!.generation, 3);

  // Gen 4: recipiente hueco a partir de producto gen 3 + piedra (nueva función storage)
  refill();
  const g4: TechnologyProgram = {
    inputs: [{ source: 'product', recipeId: 'recipe-3', mass: 250 }, { source: 'raw', material: 'stone', mass: 1000 }],
    steps: [{ op: 'combine', intensity: 3 }, { op: 'compress', intensity: 4 }, { op: 'form', shape: 'hollow', intensity: 4 }],
  };
  assert.equal(runProgram(world, actor, g4, ['recipe-3']), true);
  assert.equal(resolveTechnologyRecipe(world, 'recipe-4')!.generation, 4);

  // Gen 5: tejido aislante / unión a partir de producto gen 4 + madera (nueva función binding/insulation)
  refill();
  const g5: TechnologyProgram = {
    inputs: [{ source: 'product', recipeId: 'recipe-4', mass: 250 }, { source: 'raw', material: 'wood', mass: 1000 }],
    steps: [{ op: 'combine', intensity: 3 }, { op: 'weave', intensity: 4 }, { op: 'form', shape: 'sheet', intensity: 4 }],
  };
  assert.equal(runProgram(world, actor, g5, ['recipe-4']), true);
  assert.equal(resolveTechnologyRecipe(world, 'recipe-5')!.generation, 5);

  const totals = technologyCatalogueTotals(world);
  assert.ok(totals.maxGeneration > 3, `generacionMaxima esperada > 3, obtenida ${totals.maxGeneration}`);
  assert.ok(totals.functionalDiversity >= 4, `diversidadFuncional esperada >= 4, obtenida ${totals.functionalDiversity}`);
  assert.ok(materialCapacities(actor.technology.items.at(-1)!).binding > 0.12);
  assert.equal(projectTechnology(world).dynamics.massError, 0);
  store.save(world);
  assertWorld(world);
});

// ── (7) Persistencia de parámetros y compatibilidad con instantáneas antiguas ─────────────────
test('persistencia: parseParams valida tecnologia.*, Store.save/load los conserva y snapshots sin la clave cargan históricos', t => {
  assert.deepEqual(PARAM_RANGES['tecnologia.dosisCuanto'], [0, 1000]);
  assert.deepEqual(PARAM_RANGES['tecnologia.mejoraLocal'], [0, 1]);
  assert.deepEqual(PARAM_RANGES['tecnologia.enfriamiento'], [1, 2400]);
  assert.equal(PARAM_DESCRIPTORS['tecnologia.evitarNoOp']!.kind, 'boolean');

  const parsed = parseParams(CANDIDATO);
  assert.deepEqual(parsed.tecnologia, { dosisCuanto: 250, mejoraLocal: 0.05, enfriamiento: 300, evitarNoOp: true, efectosHerramientas: false, obrasPorPropiedades: false });

  for (const invalid of [
    'tecnologia.dosisCuanto=-1',
    'tecnologia.dosisCuanto=1001',
    'tecnologia.dosisCuanto=12.5',
    'tecnologia.mejoraLocal=-0.01',
    'tecnologia.mejoraLocal=1.1',
    'tecnologia.enfriamiento=0',
    'tecnologia.enfriamiento=2401',
    'tecnologia.enfriamiento=45.5',
    'tecnologia.evitarNoOp=1',
    'tecnologia.evitarNoOp=si',
  ]) {
    assert.throws(() => parseParams(invalid), Error, invalid);
  }

  // Roundtrip Store.save / Store.load con parámetros candidatos
  const { store, path } = lab(t);
  const world = createWorld(51926, parsed);
  store.save(world);
  const digest = digestoCanonico(world);
  store.close();

  const reopened = new Store(path);
  try {
    const loaded = reopened.load()!.world;
    assert.deepEqual(paramsOf(loaded).tecnologia, parsed.tecnologia);
    assert.equal(digestoCanonico(loaded), digest);
  } finally {
    reopened.close();
  }

  // Instantánea antigua sin la clave `tecnologia` → carga con valores históricos exactos
  const { store: legacyStore, path: legacyPath } = lab(t);
  legacyStore.save(createWorld(51926));
  const saved = JSON.parse(filaInstantanea(legacyStore).body) as { params: Record<string, unknown> };
  delete saved.params.tecnologia;
  reescribirInstantanea(legacyStore, JSON.stringify(saved));
  legacyStore.close();

  const reopenedLegacy = new Store(legacyPath);
  try {
    const loadedLegacy = reopenedLegacy.load()!.world;
    assert.deepEqual(paramsOf(loadedLegacy).tecnologia, {
      dosisCuanto: 0,
      mejoraLocal: 0,
      enfriamiento: 45,
      evitarNoOp: false,
      efectosHerramientas: false,
      obrasPorPropiedades: false,
    });
  } finally {
    reopenedLegacy.close();
  }

  // TechnologyHost sintético sin setParams usa los valores históricos
  const { host, a } = scene(333);
  a.technology.lastAttempt = 0;
  host.tick = 45;
  assert.ok(technologyOpportunity(host, a) !== undefined, 'host sintético usa enfriamiento histórico 45');
});
