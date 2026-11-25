import { OLVIDO_RECETA, TAU_RECETA_APRENDIZAJE, TAU_RECETA_BASE } from '../shared/naturaleza.js';
import type { RecetaRecordada, TechnologyKnowledge, TecnicaPersona } from '../shared/technology.js';
import { TICKS_PER_DAY } from './mundo/tipos.js';

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

const knownIndexes = new WeakMap<string[], { ids: string[]; known: ReadonlySet<string> }>();
function knownIndex(ids: string[]): ReadonlySet<string> {
  const cached = knownIndexes.get(ids);
  if (cached) {
    // Mismo contenido que la copia validada: se compara índice a índice, sin cierre ni iterador.
    const seen = cached.ids, length = ids.length;
    if (seen.length === length) {
      let i = 0;
      while (i < length && seen[i] === ids[i]) i++;
      if (i === length) return cached.known;
    }
  }
  const known = new Set<string>();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    if (!recipeId(id) || known.has(id)) fail();
    known.add(id);
  }
  knownIndexes.set(ids, { ids: ids.slice(), known });
  return known;
}

/** Validate every mutable field before pruning. The index also checks in-place array edits. */
function assertMemory(knowledge: TechnologyKnowledge, id?: string): ReadonlySet<string> {
  if (!record(knowledge) || (id !== undefined && !recipeId(id))) fail();
  const knownRecipes = knowledge.knownRecipes;
  if (!Array.isArray(knownRecipes) || knownRecipes.length > 256) fail();
  const known = knownIndex(knownRecipes);
  const items = knowledge.items;
  if (!Array.isArray(items)) fail();
  for (let n = 0; n < items.length; n++) {
    const item: unknown = items[n];
    if (!record(item) || (item.recipeId !== null && !recipeId(item.recipeId))) fail();
  }
  if (!Array.isArray(knowledge.learnedFrom) || !record(knowledge.competence)) fail();
  const learnedFrom = knowledge.learnedFrom;
  for (let n = 0; n < learnedFrom.length; n++) {
    const learned: unknown = learnedFrom[n];
    if (!record(learned) || !recipeId(learned.recipeId) || !known.has(learned.recipeId) ||
      typeof learned.teacherId !== 'string' || !learned.teacherId.length || learned.teacherId.length > 100 || !integer(learned.tick)) fail();
  }
  const competence = knowledge.competence;
  for (const key in competence) {
    if (!Object.hasOwn(competence, key)) continue;
    const practice: unknown = competence[key];
    if (!recipeId(key) || !record(practice) || !integer(practice.attempts) || !integer(practice.successes) ||
      practice.successes > practice.attempts || !integer(practice.work) || typeof practice.benefit !== 'number' ||
      !Number.isFinite(practice.benefit) || practice.benefit < 0) fail();
  }
  return known;
}

/** Work in progress pins instructions, never grants them to an unfamiliar holder. */
export function technologyProjectPins(knowledge: TechnologyKnowledge): string[] {
  const project = knowledge.project;
  return project ? [...new Set([...(project.recipeId ? [project.recipeId] : []), ...project.parents])] : [];
}

/** Forget practice once neither instructions, an artifact nor a paid project supports it. */
export function pruneTechnologyCompetence(knowledge: TechnologyKnowledge): void {
  const known = assertMemory(knowledge), pins = knowledge.project ? technologyProjectPins(knowledge) : undefined;
  for (const id in knowledge.competence) {
    if (!Object.hasOwn(knowledge.competence, id) || known.has(id) || pins?.includes(id)) continue;
    if (!knowledge.items.some(item => item.recipeId === id)) delete knowledge.competence[id];
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

// ── V23 (`v23.tecnica`): memoria de recetas con olvido ───────────────────────────────────────────────────
// Sin capacidad fija: lo que alguien recuerda es la tasa con que usa sus recetas por τ (leyes-opus §3d).

/** Estado técnico vacío de una persona con la ley encendida. */
export const nuevaTecnica = (): TecnicaPersona => ({ recetas: [], proceso: null, avanzadoEn: -1, intentos: 0, ultimoIntento: -Number.MAX_SAFE_INTEGER });

/** τ_m en ticks: TAU_RECETA_BASE + TAU_RECETA_APRENDIZAJE·learningRate días (heredable por el gen de aprendizaje). */
export const tauRecetaTicks = (learningRate: number): number =>
  (TAU_RECETA_BASE + TAU_RECETA_APRENDIZAJE * Math.max(0, learningRate)) * TICKS_PER_DAY;

/** Fuerza de una receta: fuerza ← fuerza·e^(−Δt/τ) desde la última vez que se usó, enseñó o aprendió (allí valía 1). */
export const fuerzaReceta = (r: Pick<RecetaRecordada, 'usada'>, tick: number, tau: number): number =>
  Math.exp(-Math.max(0, tick - r.usada) / tau);

/** Ticks sin uso tras los que una receta baja de OLVIDO_RECETA: τ·ln(1/OLVIDO_RECETA). */
export const vidaReceta = (tau: number): number => tau * Math.log(1 / OLVIDO_RECETA);

export const recetaRecordada = (t: TecnicaPersona, id: number): RecetaRecordada | undefined => t.recetas.find(r => r.id === id);

/** Recuerda (o refresca) una receta con fuerza 1: al inventarla, fabricarla, aprenderla o enseñarla. El vector y la
 * generación son los de la última vez que se hizo o se aprendió. */
export function recordarReceta(t: TecnicaPersona, r: RecetaRecordada): RecetaRecordada {
  const previa = recetaRecordada(t, r.id);
  if (!previa) { t.recetas.push(r); return r; }
  previa.usada = Math.max(previa.usada, r.usada);
  if (r.vector.length) previa.vector = r.vector;
  previa.generacion = Math.min(previa.generacion, r.generacion);
  return previa;
}

/** Pone a 1 la fuerza de una receta que ya se recuerda. */
export function usarReceta(t: TecnicaPersona, id: number, tick: number): boolean {
  const r = recetaRecordada(t, id);
  if (r) r.usada = Math.max(r.usada, tick);
  return r !== undefined;
}

/** Olvida las recetas cuya fuerza bajó de OLVIDO_RECETA (limpieza numérica, no una capacidad) y devuelve sus ids. */
export function olvidarRecetas(t: TecnicaPersona, tick: number, tau: number): number[] {
  const vida = vidaReceta(tau), olvidadas: number[] = [];
  let j = 0;
  for (const r of t.recetas) {
    if (tick - r.usada > vida) olvidadas.push(r.id);
    else t.recetas[j++] = r;
  }
  t.recetas.length = j;
  return olvidadas;
}
