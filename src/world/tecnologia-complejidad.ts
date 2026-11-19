import {
  CAPABILITIES,
  materialCapacities,
  type Capability,
  type MaterialBatch,
  type TechnologyRecipe,
  type TechnologyState,
} from './technology.js';

/**
 * Señal pura y determinista de complejidad tecnológica acumulativa (T171: sin relojes, sin azar,
 * sin inspección de hardware). Separa progreso funcional y cadenas compuestas reales del ruido de
 * microvariantes redundantes, y decide cuándo compactar recibos rutinarios de agua.
 */

/** Umbral mínimo para considerar activa una capacidad física (alineado con el umbral de catalizador). */
export const ACTIVE_CAPABILITY_THRESHOLD = 0.1;

/** Mejora funcional mínima por defecto para distinguir progreso real de una microvariante. */
export const DEFAULT_NOVELTY_TOLERANCE = 0.05;

/** Tope por defecto de recibos pendientes antes de compactar recibos rutinarios de agua. */
export const DEFAULT_WATER_RECEIPT_COMPACTION_CAP = 1024;

const FLOAT_EPSILON = 1e-12;
const ROUTINE_WATER_RECEIPT_KINDS: ReadonlySet<string> = new Set([
  'water',
  'water:leak',
  'water:carry',
  'leak',
  'carry',
]);

export interface TechComplexitySummary {
  totalRecipes: number;
  distinctFunctionalProfiles: number;
  maxGeneration: number;
  compositeChainCount: number;
  meanGeneration: number;
  complexityScore: number;
}

function capabilityValue(capacities: Record<Capability, number> | undefined, capability: Capability): number {
  const value = capacities?.[capability];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(1, value) : 0;
}

function normalizedThreshold(threshold?: number): number {
  return typeof threshold === 'number' && Number.isFinite(threshold) && threshold > 0
    ? Math.min(1, threshold)
    : ACTIVE_CAPABILITY_THRESHOLD;
}

function realParentIds(recipe: TechnologyRecipe): string[] {
  if (!Array.isArray(recipe.parents) || recipe.parents.length === 0) return [];
  const seen = new Set<string>();
  const parents: string[] = [];
  for (const parent of recipe.parents) {
    if (typeof parent !== 'string') continue;
    const id = parent.trim();
    if (!id || id === recipe.id || seen.has(id)) continue;
    seen.add(id);
    parents.push(id);
  }
  return parents;
}

/** Lista canónica de capacidades activas (`>= threshold`) en orden fijo de `CAPABILITIES`. */
export function activeCapabilities(
  capacities: Record<Capability, number>,
  threshold = ACTIVE_CAPABILITY_THRESHOLD,
): Capability[] {
  const min = normalizedThreshold(threshold);
  const active: Capability[] = [];
  for (const capability of CAPABILITIES) {
    if (capabilityValue(capacities, capability) >= min) active.push(capability);
  }
  return active;
}

/** Firma canónica de clase funcional a partir de la combinación de capacidades activas (`'inert'` si no hay ninguna). */
export function functionalProfileKey(
  capacities: Record<Capability, number>,
  threshold = ACTIVE_CAPABILITY_THRESHOLD,
): string {
  const active = activeCapabilities(capacities, threshold);
  return active.length > 0 ? active.join('+') : 'inert';
}

/** Perfil funcional derivado directamente del estado físico de un lote material (`MaterialBatch`). */
export function batchFunctionalProfile(
  batch: MaterialBatch,
  threshold = ACTIVE_CAPABILITY_THRESHOLD,
): string {
  return functionalProfileKey(materialCapacities(batch), threshold);
}

/**
 * Una receta forma cadena compuesta real si tiene generación ≥ 2, padres reales válidos y además
 * reutiliza un producto previo como insumo físico (`source === 'product'`) o combina ≥ 2 padres.
 * Excluye mutaciones lineales sobre materia prima que solo incrementan `generation` sin composición.
 */
export function isCompositeRecipe(recipe: TechnologyRecipe): boolean {
  if (!Number.isSafeInteger(recipe.generation) || recipe.generation < 2) return false;
  const parents = realParentIds(recipe);
  if (parents.length === 0) return false;
  if (parents.length >= 2) return true;
  const parentSet = new Set(parents);
  const inputs = recipe.program?.inputs;
  if (!Array.isArray(inputs)) return false;
  return inputs.some(
    input => input?.source === 'product' && typeof input.recipeId === 'string' && parentSet.has(input.recipeId),
  );
}

/**
 * Comprueba si `candidate` aporta novedad funcional genuina respecto a `existing`:
 * 1) Requiere al menos una capacidad activa y no duplicar una firma de programa ya existente.
 * 2) Aporta una combinación nueva de capacidades activas (clase funcional inédita), O
 * 3) Mejora en `>= tolerance` al menos una capacidad activa respecto al máximo de `existing`
 *    en la misma clase funcional, O
 * 4) Alcanza una generación compuesta estrictamente mayor con padres reales dentro de esa clase.
 */
export function isGenuineFunctionalNovelty(
  candidate: TechnologyRecipe,
  existing: readonly TechnologyRecipe[],
  tolerance = DEFAULT_NOVELTY_TOLERANCE,
): boolean {
  const active = activeCapabilities(candidate.capacities);
  if (active.length === 0) return false;

  const tol = typeof tolerance === 'number' && Number.isFinite(tolerance) && tolerance >= 0
    ? tolerance
    : DEFAULT_NOVELTY_TOLERANCE;
  const candidateProfile = active.join('+');
  const candidateSignature = typeof candidate.signature === 'string' ? candidate.signature : '';

  let hasSameClass = false;
  let maxSameClassCompositeGen = 0;
  const bestInClass: Record<Capability, number> = {
    cutting: 0, storage: 0, insulation: 0, cultivation: 0, binding: 0, abrasion: 0,
  };
  const existingById = new Map<string, TechnologyRecipe>();

  for (const recipe of existing) {
    if (candidateSignature !== '' && recipe.signature === candidateSignature) return false;
    existingById.set(recipe.id, recipe);
    if (functionalProfileKey(recipe.capacities) !== candidateProfile) continue;
    hasSameClass = true;
    for (const capability of active) {
      const value = capabilityValue(recipe.capacities, capability);
      if (value > bestInClass[capability]) bestInClass[capability] = value;
    }
    if (isCompositeRecipe(recipe) && recipe.generation > maxSameClassCompositeGen) {
      maxSameClassCompositeGen = recipe.generation;
    }
  }

  if (!hasSameClass) return true;

  for (const capability of active) {
    const value = capabilityValue(candidate.capacities, capability);
    const best = bestInClass[capability];
    const improved = tol === 0 ? value > best + FLOAT_EPSILON : value >= best + tol - FLOAT_EPSILON;
    if (improved) return true;
  }

  if (isCompositeRecipe(candidate) && candidate.generation > maxSameClassCompositeGen) {
    const parents = realParentIds(candidate);
    const coherent = parents.every(id => {
      const parent = existingById.get(id);
      return parent === undefined || candidate.generation > parent.generation;
    });
    if (coherent) return true;
  }

  return false;
}

interface ProfileAccumulator {
  active: readonly Capability[];
  best: Record<Capability, number>;
  maxCompositeGen: number;
}

/**
 * Resume la complejidad tecnológica acumulativa de una colección de recetas en O(R) y sin inflarse
 * por microvariantes redundantes: `complexityScore` agrega por perfil funcional distinto el logro
 * pico de sus capacidades activas y la profundidad máxima de cadena compuesta alcanzada en ese perfil.
 */
export function analyzeTechnologicalComplexity(recipes: readonly TechnologyRecipe[]): TechComplexitySummary {
  const totalRecipes = recipes.length;
  if (totalRecipes === 0) {
    return {
      totalRecipes: 0,
      distinctFunctionalProfiles: 0,
      maxGeneration: 0,
      compositeChainCount: 0,
      meanGeneration: 0,
      complexityScore: 0,
    };
  }

  let maxGeneration = 0;
  let sumGeneration = 0;
  let compositeChainCount = 0;
  const profiles = new Map<string, ProfileAccumulator>();

  for (const recipe of recipes) {
    const generation = Number.isSafeInteger(recipe.generation) && recipe.generation > 0 ? recipe.generation : 0;
    if (generation > maxGeneration) maxGeneration = generation;
    sumGeneration += generation;

    const composite = isCompositeRecipe(recipe);
    if (composite) compositeChainCount++;

    const active = activeCapabilities(recipe.capacities);
    if (active.length === 0) continue;

    const key = active.join('+');
    let acc = profiles.get(key);
    if (!acc) {
      acc = {
        active,
        best: { cutting: 0, storage: 0, insulation: 0, cultivation: 0, binding: 0, abrasion: 0 },
        maxCompositeGen: 0,
      };
      profiles.set(key, acc);
    }
    for (const capability of active) {
      const value = capabilityValue(recipe.capacities, capability);
      if (value > acc.best[capability]) acc.best[capability] = value;
    }
    if (composite && generation > acc.maxCompositeGen) {
      acc.maxCompositeGen = generation;
    }
  }

  // Suma en orden canónico de perfiles (≤ 63 claves) para invariancia bit a bit ante permutaciones.
  let rawScore = 0;
  for (const key of [...profiles.keys()].sort()) {
    const acc = profiles.get(key)!;
    let peakSum = 0;
    for (const capability of acc.active) peakSum += acc.best[capability];
    const depthBonus = acc.maxCompositeGen >= 2 ? Math.log2(acc.maxCompositeGen) : 0;
    rawScore += 1 + peakSum + depthBonus;
  }

  return {
    totalRecipes,
    distinctFunctionalProfiles: profiles.size,
    maxGeneration,
    compositeChainCount,
    meanGeneration: sumGeneration / totalRecipes,
    complexityScore: Math.round(rawScore * 1e6) / 1e6,
  };
}

/** Analiza la complejidad del estado tecnológico completo combinando catálogo residente y pendientes sin duplicados. */
export function analyzeTechnologyStateComplexity(state: TechnologyState): TechComplexitySummary {
  const pending = state.catalogue?.pending;
  if (!pending || pending.length === 0) return analyzeTechnologicalComplexity(state.recipes);
  const byId = new Map<string, TechnologyRecipe>();
  for (const recipe of state.recipes) byId.set(recipe.id, recipe);
  for (const recipe of pending) byId.set(recipe.id, recipe);
  return analyzeTechnologicalComplexity([...byId.values()]);
}

/**
 * Decide de forma pura cuándo compactar recibos rutinarios de agua en mundos muy poblados para
 * evitar crecimiento innecesario de `technology_executions`. Nunca compacta recibos de investigación,
 * fabricación, uso de herramientas, reciclaje, herencia ni transferencias.
 */
export function shouldCompactWaterReceipt(
  kind: string,
  pendingCount: number,
  cap = DEFAULT_WATER_RECEIPT_COMPACTION_CAP,
): boolean {
  if (!ROUTINE_WATER_RECEIPT_KINDS.has(kind)) return false;
  if (!Number.isFinite(pendingCount) || pendingCount < 0) return false;
  if (!Number.isFinite(cap) || cap < 0) return false;
  return pendingCount >= cap;
}
