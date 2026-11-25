/**
 * V16 — calidad tecnológica emergente (carril 1). Tres leyes, todas opcionales:
 *  1. `tecnologia.mejoraLocal > 0`: la puerta de descubrimiento nunca acepta lotes inertes y exige novedad
 *     funcional genuina (`isGenuineFunctionalNovelty`) o dominancia Pareto por trabajo (`technology.ts`).
 *  2. Ventana residente ponderada por utilidad (`technology-catalogue.ts`) con esa ley o con
 *     `tecnologia.efectosHerramientas`; LRU estricto en todo lo demás.
 *  3. `tecnologia.efectosHerramientas`: abrigo, ataduras, corte y desbaste tienen efecto físico (caza, obra,
 *     reparación, intemperie) con desgaste material real y beneficio medido.
 * Con `mejoraLocal = 0` y `efectosHerramientas = false` el mundo es el de antes bit a bit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChronicleEvent } from '../src/shared/types.js';
import { assertWorld, createWorld, stepWorld, tileAt, type World } from '../src/world/index.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';
import { digestoSin } from '../scripts/lab/rendimiento.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, parseParams, setParams } from '../src/world/params.js';
import {
  assertTechnology, CAPABILITIES, constructionWorkFactor, consumeConstructionTools, consumeHuntingTools, consumeInsulationTools,
  defaultTechnologyState, huntingWorkFactor, initialTechnologyKnowledge, materialCapacities, portableInsulationPower, projectTechnology,
  researchTechnology, technologyOpportunity, technologyWorkCost, toolCapacities, toolEffectsEnabled,
  type Capability, type MaterialBatch, type TechnologyActor, type TechnologyHost, type TechnologyProgram,
} from '../src/world/technology.js';
import {
  bindTechnologyCatalogue, enableTechnologyCatalogue, resolveTechnologyRecipe, technologyCatalogueTotals, updateTechnologyRecipeStats,
  withRecipeSession, type TechnologyCatalogueReader,
} from '../src/world/technology-catalogue.js';
import { analyzeTechnologicalComplexity } from '../src/world/tecnologia-complejidad.js';
import { BROKEN_CONDITION, blueprintCost, completeConstruction, constructionCost, repair } from '../src/world/inventions.js';
import type { TechnologyRecipe, TechnologyState } from '../src/shared/technology.js';
import { laboratorio } from './lib/store.js';
import { PROGRAMA_FILO as edge, proyectoInvestigacion } from './lib/escenas.js';

const raw = (material: 'wood' | 'stone', mass = 1000) => ({ source: 'raw' as const, material, mass });
/** Capa o manta tejida: abrigo (`insulation`) y atadura (`binding`). */
const CAPA: TechnologyProgram = { inputs: [raw('wood')], steps: [{ op: 'weave', intensity: 4 }, { op: 'form', shape: 'sheet', intensity: 4 }] };
/** Piedra compactada: desbaste (`abrasion`). */
const MUELA: TechnologyProgram = { inputs: [raw('stone')], steps: [{ op: 'compress', intensity: 4 }] };
/** Lote inerte: madera granulada, ninguna capacidad llega a 0,12. */
const INERTE: TechnologyProgram = { inputs: [raw('wood')], steps: [{ op: 'form', shape: 'granular', intensity: 4 }] };
/** Microvariante del filo: la misma función con una compresión más floja. */
const MICRO: TechnologyProgram = { inputs: [raw('stone')], steps: [{ op: 'form', shape: 'edge', intensity: 4 }, { op: 'compress', intensity: 1 }] };

const maxCap = (capacities: Record<Capability, number>) => Math.max(...CAPABILITIES.map(c => capacities[c]));

function scene(seed: number, paramsText?: string) {
  const a: TechnologyActor = {
    id: 'a', x: 0, y: 0, energy: 1, fatigue: 0, hunger: 0.1, thirst: 0.1, curiosity: 0.9,
    materials: { wood: 12, stone: 8 }, skills: {}, technology: initialTechnologyKnowledge(),
  };
  const host: TechnologyHost = { seed, tick: 0, people: [a], technology: defaultTechnologyState(), tiles: [{ x: 0, y: 0, drinkingWater: 0.2 }] };
  if (paramsText !== undefined) setParams(host, parseParams(paramsText));
  return { host, a };
}
function refill(actor: TechnologyActor): void {
  actor.materials = { wood: 12, stone: 8 }; actor.energy = 1; actor.fatigue = 0; actor.hunger = 0.05; actor.thirst = 0.05;
}
/** Termina un proyecto pagado (o, sin programa, la investigación que el actor proponga). */
function runProgram(host: TechnologyHost, actor: TechnologyActor, program?: TechnologyProgram, parents: string[] = []): boolean {
  if (program) actor.technology.project = proyectoInvestigacion(structuredClone(program), host.tick, parents);
  let result = false;
  for (let n = 0; n < 400; n++) {
    host.tick++;
    if ('demographyDynamics' in host) for (const person of (host as World).people) person.demography.age = host.tick - person.bornAt;
    result = researchTechnology(host, actor);
    if (!actor.technology.project) break;
  }
  return result;
}
const itemOf = (actor: TechnologyActor, recipeId: string): MaterialBatch => actor.technology.items.find(item => item.recipeId === recipeId)!;
const stock = (actor: TechnologyActor) => actor.technology.items.reduce((n, item) => n + item.mass, 0) + actor.technology.residue.wood + actor.technology.residue.stone + actor.technology.residue.water;

// ── (1) Leyes neutras = control ──────────────────────────────────────────────────────────────────
// V23: sin digestos dorados con valor fijo. Con las leyes nuevas en sus valores neutros, el mundo coincide
// con el control corrido en la propia prueba (los params base sin tocar): misma semilla, un hilo, sin
// tarjeta, con Store (guardado al crear), dos corridas de lo mismo dan el mismo digesto.
test('neutras: con mejoraLocal=0 y efectosHerramientas=false el mundo es el del control y es reproducible (2 semillas × 1200 pasos)', { timeout: 600_000 }, t => {
  const neutras = 'tecnologia.mejoraLocal=0,tecnologia.efectosHerramientas=false';
  assert.equal(HISTORICAL_PARAMS.tecnologia.mejoraLocal, 0); assert.equal(HISTORICAL_PARAMS.tecnologia.efectosHerramientas, false);
  assert.equal(DEFAULT_PARAMS.tecnologia.mejoraLocal, 0); assert.equal(DEFAULT_PARAMS.tecnologia.efectosHerramientas, false);
  const correr = (seed: number, base: typeof HISTORICAL_PARAMS, explicitas: boolean): string => {
    const { store } = laboratorio(t, 'atlas-v16-tec-');
    const world = createWorld(seed, explicitas ? parseParams(neutras, base) : base);
    store.save(world);
    for (let tick = 1; tick <= 1200; tick++) stepWorld(world);
    return digestoSin(world, ['tecnologia', 'poblacion.natalidadVecindad', 'poblacion.radioVecindadNatalidad', 'conducta.politicaPeso'], 11);
  };
  for (const seed of [7, 42] as const) {
    for (const [modo, base] of [['historicos', HISTORICAL_PARAMS], ['defaults', DEFAULT_PARAMS]] as const) {
      const control = correr(seed, base, false);
      assert.equal(correr(seed, base, true), control, `semilla ${seed} (${modo}): leyes neutras explícitas = control`);
    }
  }
});

test('paridad: sin las leyes, ningún ayudante de herramientas cambia nada (factor 1, sin desgaste, sin recibos)', () => {
  const { host, a } = scene(9);
  for (const program of [edge, CAPA, MUELA]) { refill(a); assert.equal(runProgram(host, a, program), true); }
  assert.equal(toolEffectsEnabled(host), false);
  const before = JSON.stringify({ technology: host.technology, actor: a });
  assert.equal(huntingWorkFactor(host, a), 1);
  assert.equal(constructionWorkFactor(host, a), 1);
  consumeHuntingTools(host, a, 0.4); consumeConstructionTools(host, a, 30); consumeInsulationTools(host, a, 0.2);
  assert.equal(JSON.stringify({ technology: host.technology, actor: a }), before);
  // Lectura pura: la capa existe aunque la ley esté apagada.
  assert.ok(portableInsulationPower(a) > 0.9);
});

// ── (2) Puerta de descubrimiento con mejoraLocal ─────────────────────────────────────────────────
test('mejoraLocal=0.08: un lote inerte (máx. capacidad < 0,12) nunca se registra; su materia vuelve a residuo', () => {
  const control = scene(11, 'tecnologia.mejoraLocal=0');
  assert.equal(runProgram(control.host, control.a, INERTE), true, 'sin puerta, el lote inerte se registra');
  assert.ok(maxCap(control.host.technology.recipes[0]!.capacities) < 0.12);

  const { host, a } = scene(11, 'tecnologia.mejoraLocal=0.08');
  const residue = a.technology.residue.wood, failures = host.technology.ledger.failures;
  assert.equal(runProgram(host, a, INERTE), false);
  assert.equal(host.technology.recipeCounter, 0);
  assert.equal(a.technology.items.length, 0);
  assert.equal(host.technology.ledger.failures, failures + 1);
  assert.ok(a.technology.residue.wood >= residue + 900, 'el producto rechazado vuelve como residuo físico');
  assert.equal(projectTechnology(host).dynamics.massError, 0);
  assertTechnology(host);
});

test('mejoraLocal=0.08: una microvariante del mismo filo se rechaza; la dominancia Pareto por trabajo sigue aceptándose', () => {
  for (const [mejora, expected] of [[0, 2], [0.08, 1]] as const) {
    const { host, a } = scene(12, `tecnologia.mejoraLocal=${mejora}`);
    assert.equal(runProgram(host, a, edge), true);
    refill(a);
    assert.equal(runProgram(host, a, MICRO, ['recipe-1']), mejora === 0, `mejoraLocal=${mejora}`);
    assert.equal(host.technology.recipeCounter, expected);
    assert.equal(projectTechnology(host).dynamics.massError, 0);
    assertTechnology(host);
  }
  // Mismas capacidades por estrictamente menos trabajo: progreso real aunque no cambie la función.
  const { host, a } = scene(777, 'tecnologia.mejoraLocal=0.08');
  const bloated: TechnologyProgram = { inputs: [raw('stone')], steps: [{ op: 'form', shape: 'edge', intensity: 4 }, { op: 'abrade', intensity: 3 }, { op: 'cool', intensity: 1 }] };
  const leaner: TechnologyProgram = { inputs: [raw('stone')], steps: [{ op: 'form', shape: 'edge', intensity: 4 }, { op: 'abrade', intensity: 3 }] };
  assert.equal(runProgram(host, a, bloated), true);
  assert.ok(technologyWorkCost(leaner) < technologyWorkCost(bloated));
  refill(a);
  assert.equal(runProgram(host, a, leaner, ['recipe-1']), true);
  assert.equal(host.technology.recipeCounter, 2);
  assertTechnology(host);
});

test('mejoraLocal=0.08: la investigación libre deja de producir ruido combinatorio sin perder clases funcionales', () => {
  const campaign = (mejora: number) => {
    const { host, a } = scene(2026, `tecnologia.mejoraLocal=${mejora}`);
    for (let attempt = 0; attempt < 400; attempt++) { refill(a); runProgram(host, a); }
    assert.equal(projectTechnology(host).dynamics.massError, 0);
    assertTechnology(host);
    const recipes = host.technology.recipes;
    return { recipes: recipes.length, inert: recipes.filter(r => maxCap(r.capacities) < 0.12).length, summary: analyzeTechnologicalComplexity(recipes) };
  };
  const open = campaign(0), gated = campaign(0.08);
  assert.ok(open.inert > 0, `sin puerta hay lotes inertes registrados (${open.inert})`);
  assert.equal(gated.inert, 0, 'con la puerta, ninguno');
  assert.ok(gated.recipes <= open.recipes * 0.5, `recetas: ${gated.recipes} con puerta frente a ${open.recipes} sin ella`);
  assert.ok(gated.summary.distinctFunctionalProfiles >= open.summary.distinctFunctionalProfiles * 0.9,
    `clases funcionales: ${gated.summary.distinctFunctionalProfiles} frente a ${open.summary.distinctFunctionalProfiles}`);
  assert.equal(gated.summary.maxGeneration, open.summary.maxGeneration, 'la profundidad de las cadenas se conserva');
});

test('mejoraLocal=0.08: los saltos funcionales reales de varias generaciones siguen aceptándose (filo → azada → vasija → tejido)', t => {
  const { store } = laboratorio(t, 'atlas-v16-tec-');
  const world = createWorld(51926, parseParams('tecnologia.mejoraLocal=0.08'));
  store.save(world);
  const actor = world.people[2]!;
  const chain: [TechnologyProgram, string[]][] = [
    [{ inputs: [raw('stone')], steps: [{ op: 'form', shape: 'edge', intensity: 1 }] }, []],
    [{ inputs: [raw('stone')], steps: [{ op: 'form', shape: 'edge', intensity: 4 }, { op: 'abrade', intensity: 4 }] }, ['recipe-1']],
    [{ inputs: [{ source: 'product', recipeId: 'recipe-2', mass: 250 }, raw('wood')], steps: [{ op: 'combine', intensity: 4 }, { op: 'form', shape: 'rod', intensity: 4 }] }, ['recipe-2']],
    [{ inputs: [{ source: 'product', recipeId: 'recipe-3', mass: 250 }, raw('stone')], steps: [{ op: 'combine', intensity: 3 }, { op: 'compress', intensity: 4 }, { op: 'form', shape: 'hollow', intensity: 4 }] }, ['recipe-3']],
    [{ inputs: [{ source: 'product', recipeId: 'recipe-4', mass: 250 }, raw('wood')], steps: [{ op: 'combine', intensity: 3 }, { op: 'weave', intensity: 4 }, { op: 'form', shape: 'sheet', intensity: 4 }] }, ['recipe-4']],
  ];
  for (const [index, [program, parents]] of chain.entries()) {
    refill(actor);
    assert.equal(runProgram(world, actor, program, parents), true, `generación ${index + 1}`);
    const recipe = resolveTechnologyRecipe(world, `recipe-${index + 1}`, { cache: false })!;
    assert.equal(recipe.generation, index + 1);
    assert.ok(maxCap(recipe.capacities) >= 0.12);
  }
  const totals = technologyCatalogueTotals(world);
  assert.equal(totals.maxGeneration, 5);
  assert.ok(totals.functionalDiversity >= 4);
  assert.equal(projectTechnology(world).dynamics.massError, 0);
  store.save(world);
  assertWorld(world);
});

// ── (3) Ventana residente ponderada por utilidad ─────────────────────────────────────────────────
function receta(n: number): TechnologyRecipe {
  return { id: `recipe-${n}`, name: `R${n}`, program: { inputs: [raw('wood')], steps: [{ op: 'form', intensity: 1 + n % 4, shape: 'rod' }] },
    signature: `firma-${n}`, parents: [], generation: 1, inventorId: 'p-1', tick: 0, x: 0, y: 0, novelty: 'both',
    capacities: { cutting: (n % 6) / 5, storage: 0, insulation: 0, cultivation: 0, binding: 0, abrasion: 0 }, uses: 0, utility: 0, manufactured: 0 };
}
/** `total` recetas archivadas, las `ventana` últimas residentes; `usos` fija los usos de cada una. */
function catalogo(total: number, ventana: number, usos: (n: number) => number, paramsText?: string) {
  const state: TechnologyState = defaultTechnologyState();
  state.recipes = Array.from({ length: total }, (_, i) => ({ ...receta(i + 1), uses: usos(i + 1) }));
  state.recipeCounter = total;
  enableTechnologyCatalogue(state, { committedThrough: total, memoryCapacity: Math.min(256, ventana) });
  state.budgets.maxRecipes = ventana;
  const archivo = new Map(state.recipes.map(recipe => [recipe.id, structuredClone(recipe)]));
  state.recipes = state.recipes.slice(-ventana).map(recipe => structuredClone(recipe));
  const reader: TechnologyCatalogueReader = { resolve: id => { const r = archivo.get(id); return r ? structuredClone(r) : null; }, findBySignature: () => null, freshCopies: true };
  bindTechnologyCatalogue(state, reader);
  // El libro tiene que cuadrar con los usos que ya traen las recetas.
  state.ledger.toolUses = state.catalogue!.totals.uses;
  const host = { technology: state, tick: 10 };
  if (paramsText !== undefined) setParams(host, parseParams(paramsText));
  return host;
}
const ids = (host: { technology: TechnologyState }) => host.technology.recipes.map(r => r.id);

test('ventana residente: con las leyes, la variante fresca sin usos no desaloja lo usado; sin ellas, LRU estricto', () => {
  // Ventana [5 6 7 8] (5 y 8 usadas): mitad antigua [5 6]; la 6 nunca se usó.
  const usos = (n: number) => n === 5 || n === 8 ? 3 : 0;
  for (const [paramsText, expected] of [
    [undefined, ['recipe-6', 'recipe-7', 'recipe-8', 'recipe-1']],
    ['tecnologia.mejoraLocal=0,tecnologia.efectosHerramientas=false', ['recipe-6', 'recipe-7', 'recipe-8', 'recipe-1']],
    ['tecnologia.mejoraLocal=0.08', ['recipe-5', 'recipe-7', 'recipe-8', 'recipe-1']],
    ['tecnologia.efectosHerramientas=true', ['recipe-5', 'recipe-7', 'recipe-8', 'recipe-1']],
  ] as const) {
    const host = catalogo(8, 4, usos, paramsText);
    assert.deepEqual(ids(host), ['recipe-5', 'recipe-6', 'recipe-7', 'recipe-8']);
    resolveTechnologyRecipe(host, 'recipe-1');
    assert.deepEqual(ids(host), expected, String(paramsText));
  }
  // Sin receta sin usos en la mitad antigua, sale la más antigua, como siempre (la mitad nueva no cuenta).
  const host = catalogo(8, 4, n => n <= 6 ? 2 : 0, 'tecnologia.mejoraLocal=0.08');
  resolveTechnologyRecipe(host, 'recipe-1');
  assert.deepEqual(ids(host), ['recipe-6', 'recipe-7', 'recipe-8', 'recipe-1']);
});

test('ventana residente ponderada: la sesión de resolución y el camino de siempre dan la misma ventana, toque a toque', () => {
  let n = 2027;
  const random = () => { n ^= n << 13; n >>>= 0; n ^= n >>> 17; n ^= n << 5; n >>>= 0; return n / 4294967296; };
  for (const ventana of [8, 9, 1, 2]) {
    const usos = (k: number) => k % 3 === 0 ? 1 : 0;
    const sesion = catalogo(60, ventana, usos, 'tecnologia.mejoraLocal=0.08'), suelta = catalogo(60, ventana, usos, 'tecnologia.mejoraLocal=0.08');
    for (let lote = 0; lote < 120; lote++) {
      const toques = Array.from({ length: 1 + Math.floor(random() * 12) }, () => `recipe-${1 + Math.floor(random() * 60)}`);
      withRecipeSession(sesion, () => { for (const id of toques) resolveTechnologyRecipe(sesion, id); });
      for (const id of toques) resolveTechnologyRecipe(suelta, id);
      assert.deepEqual(ids(sesion), ids(suelta), `ventana ${ventana}, lote ${lote}`);
      const usada = `recipe-${1 + Math.floor(random() * 60)}`;
      updateTechnologyRecipeStats(sesion, usada, { uses: 1, utility: 0.5 }); updateTechnologyRecipeStats(suelta, usada, { uses: 1, utility: 0.5 });
      assert.deepEqual(ids(sesion), ids(suelta), `ventana ${ventana}, lote ${lote} (estadística)`);
      assert.ok(sesion.technology.recipes.length <= ventana);
    }
  }
});

// ── (4) Efectos físicos de las herramientas ─────────────────────────────────────────────────────
function toolkit(seed: number, paramsText = 'tecnologia.efectosHerramientas=true') {
  const { host, a } = scene(seed, paramsText);
  for (const program of [edge, CAPA, MUELA]) { refill(a); assert.equal(runProgram(host, a, program), true); }
  const powers = toolCapacities(a);
  assert.ok(powers.cutting > 0.8 && powers.binding > 0.8 && powers.insulation > 0.9 && powers.abrasion > 0.6, JSON.stringify(powers));
  return { host, a, powers };
}
const recipeStats = (host: TechnologyHost, id: string) => { const r = resolveTechnologyRecipe(host, id, { cache: false })!; return { uses: r.uses, utility: r.utility }; };

test('caza: lanza y lazo acortan el trabajo y, al usarse, se desgastan conservando la masa y anotan utilidad real', () => {
  const { host, a, powers } = toolkit(21);
  const factor = huntingWorkFactor(host, a);
  assert.ok(Math.abs(factor - (1 - Math.min(0.32, powers.cutting * 0.2 + powers.binding * 0.16))) < 1e-12);
  assert.ok(factor < 0.75, `la caza con herramientas es más rápida (${factor})`);
  const spear = itemOf(a, 'recipe-1'), snare = itemOf(a, 'recipe-2'), before = { spear: spear.mass, snare: snare.mass, stock: stock(a), uses: host.technology.ledger.toolUses };
  consumeHuntingTools(host, a, 0.3);
  assert.ok(spear.mass < before.spear && snare.mass < before.snare, 'la punta y el lazo pierden masa');
  assert.equal(stock(a), before.stock, 'el desgaste pasa al residuo del actor: ni se crea ni se pierde masa');
  assert.equal(host.technology.ledger.toolUses, before.uses + 2);
  assert.ok(recipeStats(host, 'recipe-1').utility > 0 && recipeStats(host, 'recipe-2').utility > 0);
  consumeHuntingTools(host, a, 0);
  assert.equal(host.technology.ledger.toolUses, before.uses + 2, 'una caza sin presa no usa herramientas');
  assert.equal(projectTechnology(host).dynamics.massError, 0);
  assertTechnology(host);
});

test('obra: ataduras, carpintería y cantería acortan el trabajo y sólo se desgastan cuando ahorran trabajo de verdad', () => {
  const { host, a, powers } = toolkit(22);
  const factor = constructionWorkFactor(host, a);
  assert.ok(Math.abs(factor - (1 - Math.min(0.35, powers.binding * 0.16 + powers.cutting * 0.12 + powers.abrasion * 0.12))) < 1e-12);
  assert.ok(factor < 0.7, `la obra con herramientas es más corta (${factor})`);
  const uses = host.technology.ledger.toolUses, total = stock(a);
  consumeConstructionTools(host, a, 0);
  assert.equal(host.technology.ledger.toolUses, uses, 'sin ahorro no hay uso');
  consumeConstructionTools(host, a, 28);
  assert.equal(host.technology.ledger.toolUses, uses + 3);
  assert.equal(stock(a), total);
  for (const id of ['recipe-1', 'recipe-2', 'recipe-3']) assert.ok(recipeStats(host, id).utility > 0, id);
  assert.equal(projectTechnology(host).dynamics.massError, 0);
  assertTechnology(host);
});

test('intemperie: la capa tejida abriga, se desgasta al proteger y anota el daño evitado', () => {
  const { host, a } = toolkit(23);
  const capa = itemOf(a, 'recipe-2'), mass = capa.mass, total = stock(a);
  assert.ok(portableInsulationPower(a) > 0.9);
  consumeInsulationTools(host, a, 0.004);
  assert.ok(capa.mass < mass); assert.equal(stock(a), total);
  assert.ok(Math.abs(recipeStats(host, 'recipe-2').utility - 0.004) < 1e-12);
  assert.equal(portableInsulationPower({ ...a, technology: { ...a.technology, items: a.technology.items.filter(i => i !== capa) } }), 0, 'sin capa no hay abrigo');
  assert.equal(projectTechnology(host).dynamics.massError, 0);
  assertTechnology(host);
});

test('usos locales: con la ley, la cadena aprendida hacia una capa se fabrica aunque aquí no haya madera ni piedra que recoger', () => {
  for (const efectos of [false, true]) {
    const { host, a } = scene(9, `tecnologia.efectosHerramientas=${efectos}`);
    host.tiles = [{ x: 0, y: 0, drinkingWater: 0, terrain: 'meadow', moisture: 0, wood: 0, stone: 0 }];
    refill(a); assert.equal(runProgram(host, a, edge), true);
    const capa: TechnologyProgram = { inputs: [{ source: 'product', recipeId: 'recipe-1', mass: 250 }, raw('wood')],
      steps: [{ op: 'combine', intensity: 3 }, { op: 'weave', intensity: 4 }, { op: 'form', shape: 'sheet', intensity: 4 }] };
    refill(a); assert.equal(runProgram(host, a, capa, ['recipe-1']), true);
    assert.ok(materialCapacities(itemOf(a, 'recipe-2')).insulation > 0.8);
    // Pierde sus objetos (pasan a residuo: la masa se conserva) y aún está en el enfriamiento de investigación.
    for (const item of a.technology.items) for (const m of ['wood', 'stone', 'water'] as const) a.technology.residue[m] += item.composition[m];
    a.technology.items = []; refill(a); a.technology.lastAttempt = host.tick;
    const opportunity = technologyOpportunity(host, a);
    if (efectos) assert.deepEqual([opportunity?.kind, opportunity?.recipeId], ['craft', 'recipe-1'], 'primer paso de la cadena hacia el abrigo');
    else assert.equal(opportunity, undefined, 'sin la ley el abrigo no es un uso local');
    assertTechnology(host);
  }
});

function emitFor(world: World) {
  return (event: Omit<ChronicleEvent, 'id' | 'tick'>): ChronicleEvent => { const result = recordChronicleEvent(world, event); world.events.push(result); return result; };
}
/** Un constructor con capa, filo y muela, en una tesela libre para levantar el plano base. */
function obra(efectos: boolean) {
  const world = createWorld(51926, parseParams(`tecnologia.efectosHerramientas=${efectos}`)), person = world.people[2]!;
  for (const program of [edge, CAPA, MUELA]) { refill(person); assert.equal(runProgram(world, person, program), true); }
  const tile = world.tiles.find(t => t.terrain !== 'water' && t.terrain !== 'shelter'
    && !world.places.some(p => Math.hypot(p.x - t.x, p.y - t.y) < 6) && !world.structures.some(s => Math.hypot(s.x - t.x, s.y - t.y) < 2))!;
  person.x = tile.x; person.y = tile.y; person.target = { x: tile.x, y: tile.y };
  person.materials = { wood: 12, stone: 8 }; person.blueprintId = null;
  return { world, person, tile: tileAt(world, tile)!, emit: emitFor(world) };
}

test('construcción: con la ley basta el trabajo acortado; el ahorro medido desgasta las herramientas y es su beneficio', () => {
  const off = obra(false), on = obra(true);
  const cost = blueprintCost(['frame', 'roof']);
  assert.deepEqual(constructionCost(on.world, on.person), cost, 'el plano y su coste no cambian');
  const factor = constructionWorkFactor(on.world, on.person);
  assert.ok(factor < 0.7);
  const reduced = Math.ceil(cost.work * factor);
  off.person.work = reduced;
  assert.equal(completeConstruction(off.world, off.person, off.tile, off.emit), null, 'sin la ley, el trabajo acortado no alcanza');

  const before = { uses: on.world.technology.ledger.toolUses, stock: stock(on.person), utility: technologyCatalogueTotals(on.world).utility };
  on.person.work = reduced;
  const structure = completeConstruction(on.world, on.person, on.tile, on.emit);
  assert.ok(structure, 'con herramientas, la obra se completa con el trabajo acortado');
  assert.deepEqual(on.person.materials, { wood: 12 - cost.wood, stone: 8 - cost.stone }, 'los materiales del plano se pagan enteros');
  assert.equal(on.person.work, 0);
  assert.equal(on.world.technology.ledger.toolUses, before.uses + 3, 'atadura, filo y muela');
  assert.equal(stock(on.person), before.stock);
  assert.ok(technologyCatalogueTotals(on.world).utility > before.utility);
  assert.match(on.world.events.at(-1)!.cause, /ahorraron/);
  // Quien llega con el trabajo completo no ahorró nada: obra igual que siempre y sin desgaste.
  const full = obra(true), uses = full.world.technology.ledger.toolUses;
  full.person.work = cost.work;
  assert.ok(completeConstruction(full.world, full.person, full.tile, full.emit));
  assert.equal(full.world.technology.ledger.toolUses, uses);
  for (const world of [on.world, full.world]) { assert.equal(projectTechnology(world).dynamics.massError, 0); assertWorld(world); }
});

test('reparación: ataduras y muela devuelven más condición con la misma madera y trabajo, con desgaste y beneficio exactos', () => {
  for (const efectos of [false, true]) {
    const { world, person, tile, emit } = obra(efectos);
    person.work = blueprintCost(['frame', 'roof']).work;
    const structure = completeConstruction(world, person, tile, emit)!;
    assert.ok(structure);
    structure.condition = BROKEN_CONDITION; person.work = 30; person.materials.wood = 2;
    const binding = toolCapacities(person).binding, abrasion = toolCapacities(person).abrasion;
    const uses = world.technology.ledger.toolUses, total = stock(person), utility = technologyCatalogueTotals(world).utility;
    assert.equal(repair(world, person, structure, emit), true);
    assert.equal(person.materials.wood, 1); assert.equal(person.work, 0);
    if (!efectos) {
      assert.ok(Math.abs(structure.condition - (BROKEN_CONDITION + 0.4)) < 1e-12);
      assert.equal(world.technology.ledger.toolUses, uses);
    } else {
      const gain = structure.condition - (BROKEN_CONDITION + 0.4);
      assert.ok(gain > 0.3 && gain <= 0.25 * (binding + abrasion) + 1e-12, `condición extra ${gain}`);
      assert.equal(world.technology.ledger.toolUses, uses + 2);
      assert.equal(stock(person), total);
      assert.ok(Math.abs(technologyCatalogueTotals(world).utility - utility - gain) < 1e-9, 'el beneficio es exactamente la condición añadida');
      assert.match(world.events.at(-1)!.cause, /Ataduras y piedra desbastada/);
    }
    assert.equal(projectTechnology(world).dynamics.massError, 0);
    assertWorld(world);
  }
});

test('mundo con ambas leyes: 1200 pasos con Store conservan la masa y validan el mundo', t => {
  const { store } = laboratorio(t, 'atlas-v16-tec-');
  const world = createWorld(42, parseParams('tecnologia.mejoraLocal=0.08,tecnologia.efectosHerramientas=true'));
  store.save(world);
  for (let tick = 1; tick <= 1200; tick++) { stepWorld(world); if (tick % 300 === 0) store.save(world); }
  const dynamics = projectTechnology(world).dynamics;
  assert.equal(dynamics.massError, 0);
  assert.ok(dynamics.toolUses > 0);
  for (const recipe of world.technology.recipes) assert.ok(maxCap(recipe.capacities) >= 0.12, recipe.id);
  assertWorld(world);
});
