import type { TechnologyKnowledge } from '../shared/technology.js';

export interface RecipeMemoryOptions {
  capacity: number;
  protectedIds: readonly string[] | ReadonlySet<string>;
}
export interface RecipeMemoryResult { remembered: boolean; forgotten: string[]; }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const recipeId = (value: unknown): value is string => typeof value === 'string' && value.length <= 100 &&
  /^recipe-[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value.slice(7)));
const fail = (): never => { throw new TypeError('Invalid recipe memory input.'); };

/** Validate the fields read or changed here; physical laws remain the host's responsibility. */
function assertMemory(knowledge: TechnologyKnowledge, id: string): void {
  if (!record(knowledge) || !recipeId(id) || !Array.isArray(knowledge.knownRecipes) || knowledge.knownRecipes.length > 256 ||
    ![...knowledge.knownRecipes].every(recipeId) || new Set(knowledge.knownRecipes).size !== knowledge.knownRecipes.length ||
    !Array.isArray(knowledge.items) || ![...knowledge.items].every(item => record(item) && (item.recipeId === null || recipeId(item.recipeId))) ||
    !Array.isArray(knowledge.learnedFrom) || !record(knowledge.competence)) fail();
  for (const learned of knowledge.learnedFrom) {
    if (!record(learned) || !recipeId(learned.recipeId) || !knowledge.knownRecipes.includes(learned.recipeId) ||
      typeof learned.teacherId !== 'string' || !learned.teacherId.length || learned.teacherId.length > 100 || !integer(learned.tick)) fail();
  }
  for (const [key, practice] of Object.entries(knowledge.competence)) {
    if (!recipeId(key) || !record(practice) || !integer(practice.attempts) || !integer(practice.successes) ||
      practice.successes > practice.attempts || !integer(practice.work) || typeof practice.benefit !== 'number' ||
      !Number.isFinite(practice.benefit) || practice.benefit < 0) fail();
  }
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
