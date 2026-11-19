import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPhysicalOperation,
  defaultTechnologyState,
  programSignature,
  rawMaterial,
  type Capability,
  type TechnologyProgram,
  type TechnologyRecipe,
} from '../src/world/technology.js';
import {
  ACTIVE_CAPABILITY_THRESHOLD,
  DEFAULT_NOVELTY_TOLERANCE,
  DEFAULT_WATER_RECEIPT_COMPACTION_CAP,
  activeCapabilities,
  analyzeTechnologicalComplexity,
  analyzeTechnologyStateComplexity,
  batchFunctionalProfile,
  functionalProfileKey,
  isCompositeRecipe,
  isGenuineFunctionalNovelty,
  shouldCompactWaterReceipt,
} from '../src/world/tecnologia-complejidad.js';

function caps(partial: Partial<Record<Capability, number>>): Record<Capability, number> {
  return {
    cutting: 0,
    storage: 0,
    insulation: 0,
    cultivation: 0,
    binding: 0,
    abrasion: 0,
    ...partial,
  };
}

function makeRecipe(options: {
  id: string;
  capacities: Partial<Record<Capability, number>>;
  generation?: number;
  parents?: string[];
  program?: TechnologyProgram;
  signature?: string;
}): TechnologyRecipe {
  const program: TechnologyProgram = options.program ?? {
    inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
    steps: [{ op: 'form', intensity: 3, shape: 'edge' }],
  };
  return {
    id: options.id,
    name: `receta ${options.id}`,
    program,
    signature: options.signature ?? `${programSignature(program)}#${options.id}`,
    parents: options.parents ?? [],
    generation: options.generation ?? 1,
    inventorId: 'p-1',
    tick: 10,
    x: 0,
    y: 0,
    novelty: 'both',
    capacities: caps(options.capacities),
    uses: 0,
    utility: 0,
    manufactured: 1,
  };
}

test('perfiles funcionales: orden canónico, umbral activo e integración con MaterialBatch real', () => {
  assert.deepEqual(activeCapabilities(caps({ abrasion: 0.4, cutting: 0.25, storage: 0.099 })), ['cutting', 'abrasion']);
  assert.equal(functionalProfileKey(caps({ abrasion: 0.4, cutting: 0.25 })), 'cutting+abrasion');
  assert.equal(functionalProfileKey(caps({ cutting: ACTIVE_CAPABILITY_THRESHOLD })), 'cutting');
  assert.equal(functionalProfileKey(caps({ cutting: 0.05, storage: 0.02 })), 'inert');

  // Producto físico real obtenido con las leyes de `technology.ts`.
  const stone = rawMaterial('stone', 1000);
  const formed = applyPhysicalOperation({ op: 'form', intensity: 4, shape: 'edge' }, [stone]);
  assert.equal(formed.success, true);
  assert.ok(formed.product);
  assert.equal(batchFunctionalProfile(formed.product!), 'cutting+abrasion');
});

test('isCompositeRecipe: distingue cadenas compuestas reales de mutaciones lineales sobre materia prima', () => {
  const gen1Raw = makeRecipe({ id: 'recipe-1', generation: 1, parents: [], capacities: { cutting: 0.4 } });
  const linearMutation = makeRecipe({
    id: 'recipe-2',
    generation: 2,
    parents: ['recipe-1'],
    capacities: { cutting: 0.41 },
    program: { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'form', intensity: 4, shape: 'edge' }] },
  });
  const productChain = makeRecipe({
    id: 'recipe-3',
    generation: 2,
    parents: ['recipe-1'],
    capacities: { cutting: 0.6 },
    program: {
      inputs: [{ source: 'product', recipeId: 'recipe-1', mass: 800 }],
      steps: [{ op: 'abrade', intensity: 3 }],
    },
  });
  const multiParentComposite = makeRecipe({
    id: 'recipe-4',
    generation: 2,
    parents: ['recipe-1', 'recipe-2'],
    capacities: { cutting: 0.55, binding: 0.3 },
    program: {
      inputs: [{ source: 'raw', material: 'wood', mass: 1000 }, { source: 'raw', material: 'stone', mass: 1000 }],
      steps: [{ op: 'combine', intensity: 3 }],
    },
  });
  const bogusNoParents = makeRecipe({ id: 'recipe-5', generation: 5, parents: [], capacities: { cutting: 0.5 } });
  const bogusSelfParent = makeRecipe({ id: 'recipe-6', generation: 3, parents: ['recipe-6'], capacities: { cutting: 0.5 } });

  assert.equal(isCompositeRecipe(gen1Raw), false);
  assert.equal(isCompositeRecipe(linearMutation), false);
  assert.equal(isCompositeRecipe(productChain), true);
  assert.equal(isCompositeRecipe(multiParentComposite), true);
  assert.equal(isCompositeRecipe(bogusNoParents), false);
  assert.equal(isCompositeRecipe(bogusSelfParent), false);
});

test('isGenuineFunctionalNovelty: detecta clase nueva, mejora >= tolerance y profundidad compuesta real', () => {
  const inert = makeRecipe({ id: 'recipe-0', capacities: { cutting: 0.03 } });
  const baseCutter = makeRecipe({ id: 'recipe-1', capacities: { cutting: 0.40 }, generation: 1 });

  // Receta inerte nunca es novedad funcional, ni siquiera en catálogo vacío.
  assert.equal(isGenuineFunctionalNovelty(inert, []), false);
  assert.equal(isGenuineFunctionalNovelty(baseCutter, []), true);

  // Firma duplicada nunca es novedad.
  const duplicateSig = makeRecipe({
    id: 'recipe-dup',
    capacities: { cutting: 0.90 },
    signature: baseCutter.signature,
  });
  assert.equal(isGenuineFunctionalNovelty(duplicateSig, [baseCutter]), false);

  // Nueva combinación de capacidades activas.
  const vessel = makeRecipe({ id: 'recipe-2', capacities: { storage: 0.55 } });
  const combo = makeRecipe({ id: 'recipe-3', capacities: { cutting: 0.35, storage: 0.35 } });
  assert.equal(isGenuineFunctionalNovelty(vessel, [baseCutter]), true);
  assert.equal(isGenuineFunctionalNovelty(combo, [baseCutter, vessel]), true);

  // Mejora real >= tolerance (incluyendo frontera exacta en coma flotante 0.40 → 0.45).
  const microVariant = makeRecipe({ id: 'recipe-4', capacities: { cutting: 0.44 } });
  const realUpgrade = makeRecipe({ id: 'recipe-5', capacities: { cutting: 0.45 } });
  assert.equal(isGenuineFunctionalNovelty(microVariant, [baseCutter], DEFAULT_NOVELTY_TOLERANCE), false);
  assert.equal(isGenuineFunctionalNovelty(realUpgrade, [baseCutter], DEFAULT_NOVELTY_TOLERANCE), true);
  assert.equal(isGenuineFunctionalNovelty(microVariant, [baseCutter], 0.03), true);

  // Mutación lineal de generación alta SIN composición ni mejora: rechazada.
  const spamGen4 = makeRecipe({
    id: 'recipe-6',
    generation: 4,
    parents: ['recipe-1'],
    capacities: { cutting: 0.41 },
    program: { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'cool', intensity: 1 }] },
  });
  assert.equal(isGenuineFunctionalNovelty(spamGen4, [baseCutter]), false);

  // Cadena compuesta real de mayor generación en la misma clase: aceptada una vez, no sus microvariantes.
  const compositeGen2 = makeRecipe({
    id: 'recipe-7',
    generation: 2,
    parents: ['recipe-1'],
    capacities: { cutting: 0.42 },
    program: {
      inputs: [{ source: 'product', recipeId: 'recipe-1', mass: 500 }],
      steps: [{ op: 'abrade', intensity: 2 }],
    },
  });
  assert.equal(isGenuineFunctionalNovelty(compositeGen2, [baseCutter, spamGen4]), true);

  const compositeGen2Spam = makeRecipe({
    id: 'recipe-8',
    generation: 2,
    parents: ['recipe-1'],
    capacities: { cutting: 0.43 },
    program: {
      inputs: [{ source: 'product', recipeId: 'recipe-1', mass: 600 }],
      steps: [{ op: 'abrade', intensity: 2 }],
    },
  });
  assert.equal(isGenuineFunctionalNovelty(compositeGen2Spam, [baseCutter, compositeGen2]), false);

  const compositeGen3 = makeRecipe({
    id: 'recipe-9',
    generation: 3,
    parents: ['recipe-7'],
    capacities: { cutting: 0.44 },
    program: {
      inputs: [{ source: 'product', recipeId: 'recipe-7', mass: 500 }],
      steps: [{ op: 'abrade', intensity: 3 }],
    },
  });
  assert.equal(isGenuineFunctionalNovelty(compositeGen3, [baseCutter, compositeGen2]), true);

  // Ancestría incoherente (generación hija <= padre existente) no recibe bono compuesto.
  const incoherent = makeRecipe({
    id: 'recipe-10',
    generation: 2,
    parents: ['recipe-9'],
    capacities: { cutting: 0.41 },
    program: {
      inputs: [{ source: 'product', recipeId: 'recipe-9', mass: 500 }],
      steps: [{ op: 'abrade', intensity: 1 }],
    },
  });
  assert.equal(isGenuineFunctionalNovelty(incoherent, [baseCutter, compositeGen3]), false);
});

test('analyzeTechnologicalComplexity: sin inflación por spam de microvariantes, O(R) y permutación-invariante', () => {
  assert.deepEqual(analyzeTechnologicalComplexity([]), {
    totalRecipes: 0,
    distinctFunctionalProfiles: 0,
    maxGeneration: 0,
    compositeChainCount: 0,
    meanGeneration: 0,
    complexityScore: 0,
  });

  // Recetas inertes no inflan perfiles ni puntuación.
  const inertSpam = Array.from({ length: 150 }, (_, i) => makeRecipe({
    id: `recipe-${i + 1}`,
    capacities: { cutting: 0.02, storage: 0.01 },
    generation: 1,
  }));
  const inertSummary = analyzeTechnologicalComplexity(inertSpam);
  assert.equal(inertSummary.totalRecipes, 150);
  assert.equal(inertSummary.distinctFunctionalProfiles, 0);
  assert.equal(inertSummary.complexityScore, 0);

  // 1 herramienta real vs la misma + 1 000 microvariantes redundantes.
  const cutter = makeRecipe({ id: 'recipe-1', capacities: { cutting: 0.45 }, generation: 1 });
  const baseline = analyzeTechnologicalComplexity([cutter]);
  assert.equal(baseline.distinctFunctionalProfiles, 1);
  assert.equal(baseline.compositeChainCount, 0);
  assert.equal(baseline.complexityScore, 1.45);

  const microvariants = Array.from({ length: 1000 }, (_, i) => makeRecipe({
    id: `recipe-${i + 2}`,
    capacities: { cutting: 0.35 + (i % 11) * 0.01 }, // máx 0.45, nunca supera al cutter
    generation: 1 + (i % 7),
    parents: i > 0 ? [`recipe-${i + 1}`] : [],
    program: { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }], steps: [{ op: 'form', intensity: 2, shape: 'edge' }] },
  }));
  const withSpam = analyzeTechnologicalComplexity([cutter, ...microvariants]);
  assert.equal(withSpam.totalRecipes, 1001);
  assert.equal(withSpam.distinctFunctionalProfiles, 1);
  assert.equal(withSpam.compositeChainCount, 0);
  assert.equal(withSpam.complexityScore, baseline.complexityScore, '1000 microvariantes redundantes no inflan complexityScore');

  // Progreso genuino: mejora de calidad, nuevo perfil y cadena compuesta aumentan complexityScore.
  const betterCutter = makeRecipe({
    id: 'recipe-better',
    capacities: { cutting: 0.80 },
    generation: 2,
    parents: ['recipe-1'],
    program: { inputs: [{ source: 'product', recipeId: 'recipe-1', mass: 800 }], steps: [{ op: 'abrade', intensity: 4 }] },
  });
  const vessel = makeRecipe({ id: 'recipe-vessel', capacities: { storage: 0.70 }, generation: 1 });
  const wovenComposite = makeRecipe({
    id: 'recipe-woven',
    capacities: { binding: 0.65, insulation: 0.70 },
    generation: 3,
    parents: ['recipe-better', 'recipe-vessel'],
    program: {
      inputs: [{ source: 'product', recipeId: 'recipe-better', mass: 400 }, { source: 'product', recipeId: 'recipe-vessel', mass: 400 }],
      steps: [{ op: 'combine', intensity: 3 }, { op: 'weave', intensity: 4 }],
    },
  });

  const s1 = analyzeTechnologicalComplexity([cutter, betterCutter]);
  const s2 = analyzeTechnologicalComplexity([cutter, betterCutter, vessel]);
  const s3 = analyzeTechnologicalComplexity([cutter, betterCutter, vessel, wovenComposite]);
  assert.ok(s1.complexityScore > baseline.complexityScore);
  assert.ok(s2.complexityScore > s1.complexityScore);
  assert.ok(s3.complexityScore > s2.complexityScore);
  assert.equal(s3.distinctFunctionalProfiles, 3);
  assert.equal(s3.compositeChainCount, 2);
  assert.equal(s3.maxGeneration, 3);
  assert.equal(s3.meanGeneration, (1 + 2 + 1 + 3) / 4);

  // Invariante bit a bit frente a permutaciones del orden de entrada.
  const reversed = analyzeTechnologicalComplexity([wovenComposite, vessel, betterCutter, cutter]);
  assert.deepEqual(reversed, s3);

  // `analyzeTechnologyStateComplexity` deduplica `recipes` y `catalogue.pending`.
  const state = defaultTechnologyState();
  state.recipes = [cutter, vessel];
  state.catalogue = {
    version: 1,
    committedThrough: 1,
    pending: [vessel, betterCutter],
    totals: { recipes: 3, maxGeneration: 2, manufactured: 3, uses: 0, utility: 0, functionalDiversity: 2 },
    functions: [],
    memoryCapacity: 32,
  };
  assert.deepEqual(analyzeTechnologyStateComplexity(state), s2);
});

test('shouldCompactWaterReceipt: compacta solo recibos rutinarios de agua al alcanzar el tope', () => {
  assert.equal(shouldCompactWaterReceipt('water', DEFAULT_WATER_RECEIPT_COMPACTION_CAP - 1), false);
  assert.equal(shouldCompactWaterReceipt('water', DEFAULT_WATER_RECEIPT_COMPACTION_CAP), true);
  assert.equal(shouldCompactWaterReceipt('water', DEFAULT_WATER_RECEIPT_COMPACTION_CAP + 500), true);

  for (const routineKind of ['water', 'water:leak', 'water:carry', 'leak', 'carry']) {
    assert.equal(shouldCompactWaterReceipt(routineKind, 99, 100), false, routineKind);
    assert.equal(shouldCompactWaterReceipt(routineKind, 100, 100), true, routineKind);
    assert.equal(shouldCompactWaterReceipt(routineKind, 0, 0), true, `${routineKind} con cap=0`);
  }

  for (const criticalKind of ['research', 'craft', 'use', 'recycle', 'estate', 'transfer', 'water:spill', '', 'unknown']) {
    assert.equal(shouldCompactWaterReceipt(criticalKind, 1_000_000, 10), false, criticalKind);
  }

  // Entradas numéricas inválidas no compactan.
  assert.equal(shouldCompactWaterReceipt('water', -1, 10), false);
  assert.equal(shouldCompactWaterReceipt('water', Number.NaN, 10), false);
  assert.equal(shouldCompactWaterReceipt('water', 100, -5), false);
  assert.equal(shouldCompactWaterReceipt('water', 100, Number.NaN), false);
});
