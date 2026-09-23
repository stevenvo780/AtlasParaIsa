import type { TechnologyKnowledge } from '../shared/technology.js';

export interface RecipeMemoryOptions {
  capacity: number;
  protectedIds: readonly string[] | ReadonlySet<string>;
}
export interface RecipeMemoryResult { remembered: boolean; forgotten: string[]; }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const recipeIdText = (value: string): boolean => value.length <= 100 &&
  /^recipe-[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value.slice(7)));
/** Sprint noche-perf 2026-09-22: `assertMemory` valida cada paso las mismas identidades de cada
 * persona (cientos de expresiones regulares por paso). La validez es función pura del texto: se
 * recuerdan los textos ya aceptados y todo lo demás se comprueba como siempre. */
const acceptedRecipeIds = new Set<string>();
const recipeId = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  if (acceptedRecipeIds.has(value)) return true;
  if (!recipeIdText(value)) return false;
  if (acceptedRecipeIds.size >= 65_536) acceptedRecipeIds.clear();
  acceptedRecipeIds.add(value);
  return true;
};
const fail = (): never => { throw new TypeError('Invalid recipe memory input.'); };

/** Validate the fields read or changed here; physical laws remain the host's responsibility.
 * Sprint noche-perf2 2026-09-22: se llama para cada persona en cada paso (`maintainTechnologyMemory`).
 * Una sola pasada sin copias: las mismas comprobaciones que antes (`[...x].every`, `new Set(x).size`,
 * `includes`, `Object.entries`) y el mismo error en los mismos casos —todas las ramas lanzan el mismo
 * `TypeError` y ninguna tiene efectos—. Devuelve el conjunto de recetas conocidas y las claves de
 * `competence` para que la poda no las recalcule. */
function assertMemory(knowledge: TechnologyKnowledge, id?: string): { known: Set<string>; practiced: string[] } {
  if (!record(knowledge) || (id !== undefined && !recipeId(id))) fail();
  const knownRecipes = knowledge.knownRecipes;
  if (!Array.isArray(knownRecipes) || knownRecipes.length > 256) fail();
  const known = new Set<string>();
  for (let n = 0; n < knownRecipes.length; n++) {
    // Un hueco se lee como `undefined`, igual que en la copia `[...x]`: no es un id.
    const value: unknown = knownRecipes[n];
    if (!recipeId(value) || known.has(value)) fail();
    known.add(value as string);
  }
  const items = knowledge.items;
  if (!Array.isArray(items)) fail();
  for (let n = 0; n < items.length; n++) {
    const item: unknown = items[n];
    if (!record(item) || (item.recipeId !== null && !recipeId(item.recipeId))) fail();
  }
  if (!Array.isArray(knowledge.learnedFrom) || !record(knowledge.competence)) fail();
  for (const learned of knowledge.learnedFrom) {
    if (!record(learned) || !recipeId(learned.recipeId) || !known.has(learned.recipeId) ||
      typeof learned.teacherId !== 'string' || !learned.teacherId.length || learned.teacherId.length > 100 || !integer(learned.tick)) fail();
  }
  const practiced = Object.keys(knowledge.competence);
  for (const key of practiced) {
    const practice: unknown = knowledge.competence[key];
    if (!recipeId(key) || !record(practice) || !integer(practice.attempts) || !integer(practice.successes) ||
      practice.successes > practice.attempts || !integer(practice.work) || typeof practice.benefit !== 'number' ||
      !Number.isFinite(practice.benefit) || practice.benefit < 0) fail();
  }
  return { known, practiced };
}

/** Work in progress pins instructions, never grants them to an unfamiliar holder. */
export function technologyProjectPins(knowledge: TechnologyKnowledge): string[] {
  const project = knowledge.project;
  return project ? [...new Set([...(project.recipeId ? [project.recipeId] : []), ...project.parents])] : [];
}

/** Forget practice once neither instructions, an artifact nor a paid project supports it. */
export function pruneTechnologyCompetence(knowledge: TechnologyKnowledge): void {
  // Mismo conjunto que `new Set([...conocidas, ...recetas de los objetos, ...pines])` y las mismas
  // claves de `competence` (nada cambia entre la validación y la poda), sin copias intermedias.
  const { known: supported, practiced } = assertMemory(knowledge);
  for (const item of knowledge.items) if (item.recipeId) supported.add(item.recipeId);
  if (knowledge.project) for (const pin of technologyProjectPins(knowledge)) supported.add(pin);
  for (const id of practiced) if (!supported.has(id)) delete knowledge.competence[id];
}

/** Refresh instructions already held, oldest first. An unknown ID is never admitted. */
export function touchKnownRecipe(knowledge: TechnologyKnowledge, id: string): boolean {
  assertMemory(knowledge, id);
  if (!knowledge.knownRecipes.includes(id)) return false;
  knowledge.knownRecipes = [...knowledge.knownRecipes.filter(known => known !== id), id];
  return true;
}

/**
 * Bounded recency bookkeeping, called only after the host earns instructions through
 * research or teaching. This helper grants no recipe program, matter, skill, or work.
 * The caller supplies project pins explicitly; carrying an artifact does not pin its recipe.
 */
export function rememberRecipe(knowledge: TechnologyKnowledge, id: string, options: RecipeMemoryOptions): RecipeMemoryResult {
  assertMemory(knowledge, id);
  if (!record(options)) fail();
  if (!integer(options.capacity) || options.capacity < 1 || options.capacity > 256) throw new RangeError('Recipe memory capacity must be an integer from 1 to 256.');
  if (!Array.isArray(options.protectedIds) && !(options.protectedIds instanceof Set)) fail();
  const protectedIds = new Set(options.protectedIds);
  if (![...protectedIds].every(recipeId)) fail();

  const ordered = [...knowledge.knownRecipes.filter(known => known !== id), id];
  const required = Math.max(0, ordered.length - options.capacity);
  const candidates = ordered.filter(known => known !== id && !protectedIds.has(known));
  if (candidates.length < required) return { remembered: false, forgotten: [] };

  const forgotten = candidates.slice(0, required), removed = new Set(forgotten);
  const knownRecipes = ordered.filter(known => !removed.has(known));
  if (forgotten.length) {
    const owned = new Set(knowledge.items.map(item => item.recipeId));
    const competence = { ...knowledge.competence };
    for (const forgottenId of forgotten) if (!owned.has(forgottenId)) delete competence[forgottenId];
    const learnedFrom = knowledge.learnedFrom.filter(learned => !removed.has(learned.recipeId));
    knowledge.learnedFrom = learnedFrom;
    knowledge.competence = competence;
  }
  knowledge.knownRecipes = knownRecipes;
  return { remembered: true, forgotten };
}
