import type { Capability, TechnologyCatalogueTotals, TechnologyRecipe, TechnologyState } from '../shared/technology.js';

export interface TechnologyCatalogueReader {
  resolve(id: string, atTick: number): TechnologyRecipe | null;
  findBySignature(signature: string, atTick: number): TechnologyRecipe | null;
  /** `true` sólo si `resolve` devuelve SIEMPRE un objeto nuevo, plano y sin partes compartidas con
   * nada que el anfitrión conserve (el Store: cada lectura es una copia). Entonces la resolución no
   * necesita su propio `structuredClone` defensivo (sprint noche-perf 2026-09-22). Sin la marca, se
   * clona como siempre. */
  readonly freshCopies?: boolean;
}
export interface TechnologyCatalogueHost { technology: TechnologyState; tick: number; }
export const MAX_PENDING_TECHNOLOGY_RECIPES = 65_536;
export const TECHNOLOGY_FUNCTION_WORDS = 1458; // ceil(6 ** 6 / 32)
const capabilities: readonly Capability[] = ['cutting', 'storage', 'insulation', 'cultivation', 'binding', 'abrasion'];
const readers = new WeakMap<TechnologyState, TechnologyCatalogueReader>();
function fail(message: string): never { throw new Error(`Invalid technology catalogue: ${message}.`); }
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const serial = (id: unknown): number => {
  if (typeof id !== 'string' || !/^recipe-[1-9]\d*$/.test(id)) return -1;
  const result = Number(id.slice(7)); return integer(result) ? result : -1;
};

/** Functions and connections never become part of a clonable snapshot. */
export function bindTechnologyCatalogue(state: TechnologyState, reader: TechnologyCatalogueReader): void {
  if (!reader || typeof reader.resolve !== 'function' || typeof reader.findBySignature !== 'function') fail('reader');
  readers.set(state, reader);
}
export function catalogueEnabled(state: TechnologyState): boolean { return state.catalogue !== undefined; }
export function technologyFunctionCode(values: Record<Capability, number>): number {
  let result = 0, factor = 1;
  for (const capability of capabilities) {
    const value = values?.[capability];
    if (!finite(value) || value > 1) fail('capability coordinate');
    result += Math.floor(value * 5) * factor; factor *= 6;
  }
  return result;
}
function containsFunction(words: readonly number[], code: number): boolean {
  return !!(words[code >>> 5]! & (1 << (code & 31)));
}
function addFunction(words: number[], code: number): boolean {
  if (containsFunction(words, code)) return false;
  const index = code >>> 5; words[index] = (words[index]! | (1 << (code & 31))) >>> 0; return true;
}
export function technologyFunctionCount(words: readonly number[]): number {
  let count = 0;
  for (const word of words) { let n = word >>> 0; while (n) { n = (n & (n - 1)) >>> 0; count++; } }
  return count;
}
function totalsOf(recipes: readonly TechnologyRecipe[]): TechnologyCatalogueTotals {
  const words = Array<number>(TECHNOLOGY_FUNCTION_WORDS).fill(0);
  const totals = { recipes: recipes.length, maxGeneration: 0, manufactured: 0, uses: 0, utility: 0, functionalDiversity: 0 };
  for (const recipe of recipes) {
    totals.maxGeneration = Math.max(totals.maxGeneration, recipe.generation);
    totals.manufactured += recipe.manufactured; totals.uses += recipe.uses; totals.utility += recipe.utility;
    if (addFunction(words, technologyFunctionCode(recipe.capacities))) totals.functionalDiversity++;
  }
  return totals;
}

/** Opt in only while an older snapshot still contains its complete catalogue. */
export function enableTechnologyCatalogue(state: TechnologyState,
  options: { committedThrough?: number; memoryCapacity?: number } = {}): void {
  if (catalogueEnabled(state)) return;
  const committedThrough = options.committedThrough ?? 0, memoryCapacity = options.memoryCapacity ?? Math.min(32, state.budgets.maxRecipes);
  if (!integer(committedThrough, state.recipeCounter) || !integer(memoryCapacity, 256) || !memoryCapacity ||
    state.recipes.length !== state.recipeCounter || state.recipes.length > MAX_PENDING_TECHNOLOGY_RECIPES) fail('initial coverage');
  const functions = Array<number>(TECHNOLOGY_FUNCTION_WORDS).fill(0);
  for (const [index, recipe] of state.recipes.entries()) {
    if (serial(recipe.id) !== index + 1) fail('initial recipe sequence');
    addFunction(functions, technologyFunctionCode(recipe.capacities));
  }
  state.catalogue = { version: 1, committedThrough, pending: state.recipes.filter(recipe => serial(recipe.id) > committedThrough),
    totals: totalsOf(state.recipes), functions, memoryCapacity };
}
export function technologyMemoryCapacity(state: TechnologyState): number {
  return catalogueEnabled(state) ? Math.min(state.budgets.maxRecipes, state.catalogue!.memoryCapacity) : state.budgets.maxRecipes;
}
function checkedRecipe(host: TechnologyCatalogueHost, recipe: TechnologyRecipe, expectedId?: string): TechnologyRecipe {
  if (!recipe || serial(recipe.id) < 1 || serial(recipe.id) > host.technology.recipeCounter ||
    expectedId !== undefined && recipe.id !== expectedId || !integer(recipe.tick, host.tick) ||
    !integer(recipe.generation) || !recipe.generation || typeof recipe.signature !== 'string' ||
    !integer(recipe.manufactured) || !integer(recipe.uses) || !finite(recipe.utility)) fail('resolved identity, time or statistics');
  return recipe;
}
/**
 * Índices de resolución (sprint noche-perf2 2026-09-22). Con ~230 habitantes cada paso hace ~2 300
 * resoluciones, y cada una recorría `pending` (media 289 recetas, crece hasta el guardado) y la ventana
 * residente (256) con `find`, y reconstruía la ventana entera con un bucle JS. Ahora:
 *  - `pending` sólo crece por `push` entre guardados y se REEMPLAZA por `[]` al confirmar; su índice
 *    id → PRIMERA receta con ese id (como `find`) va asociado a la identidad del arreglo y se extiende
 *    cuando crece su longitud; si encoge, se reconstruye.
 *  - la ventana (`state.recipes`) siempre se reemplaza por un arreglo nuevo en `cacheRecipe`; su índice
 *    id → receta va asociado a la identidad y longitud del arreglo vigente y `cacheRecipe` lo traslada al
 *    arreglo nuevo con los mismos cambios (fuera el id tocado, dentro al final, fuera los expulsados).
 * Un índice sólo se usa si todas las entradas son objetos con id de texto y, en la ventana, los ids son
 * únicos (lo exige `assertTechnologyCatalogueState`); si no, vuelve el recorrido lineal de siempre.
 * Misma respuesta que `find`, mismo contenido y orden de la ventana tras cada toque, mismos objetos.
 */
interface RecipeIndex { length: number; byId: Map<string, TechnologyRecipe> | null; }
const pendingIndexes = new WeakMap<TechnologyRecipe[], RecipeIndex>();
const windowIndexes = new WeakMap<TechnologyRecipe[], RecipeIndex>();
const indexable = (recipe: unknown): recipe is TechnologyRecipe =>
  !!recipe && typeof recipe === 'object' && typeof (recipe as TechnologyRecipe).id === 'string';
function pendingIndex(pending: TechnologyRecipe[]): Map<string, TechnologyRecipe> | null {
  let index = pendingIndexes.get(pending);
  if (!index || index.length > pending.length) { index = { length: 0, byId: new Map() }; pendingIndexes.set(pending, index); }
  if (index.byId && index.length < pending.length) {
    const byId = index.byId;
    for (let n = index.length; n < pending.length; n++) {
      const recipe = pending[n];
      if (!(n in pending) || !indexable(recipe)) { index.byId = null; break; }
      if (!byId.has(recipe.id)) byId.set(recipe.id, recipe);
    }
    index.length = pending.length;
  }
  return index.byId;
}
function windowIndex(recipes: TechnologyRecipe[]): Map<string, TechnologyRecipe> | null {
  let index = windowIndexes.get(recipes);
  if (!index || index.length !== recipes.length) {
    let byId: Map<string, TechnologyRecipe> | null = new Map();
    for (let n = 0; n < recipes.length; n++) {
      const recipe = recipes[n];
      if (!(n in recipes) || !indexable(recipe) || byId.has(recipe.id)) { byId = null; break; }
      byId.set(recipe.id, recipe);
    }
    index = { length: recipes.length, byId };
    windowIndexes.set(recipes, index);
  }
  return index.byId;
}
function pendingRecipe(pending: TechnologyRecipe[], id: string): TechnologyRecipe | undefined {
  const byId = pendingIndex(pending);
  return byId ? byId.get(id) : pending.find(recipe => recipe.id === id);
}
function residentRecipe(recipes: TechnologyRecipe[], id: string): TechnologyRecipe | undefined {
  const byId = windowIndex(recipes);
  return byId ? byId.get(id) : recipes.find(recipe => recipe.id === id);
}
function cacheRecipe(state: TechnologyState, recipe: TechnologyRecipe): void {
  // Replacing the array avoids extending an array currently being validated/iterated.
  const current = state.recipes, max = state.budgets.maxRecipes, byId = windowIndex(current);
  if (!byId) {
    const next: TechnologyRecipe[] = [];
    current.forEach(cached => { if (cached.id !== recipe.id) next.push(cached); });
    next.push(recipe);
    state.recipes = next.length > max ? next.slice(-max) : next;
    return;
  }
  // Ids únicos: el `filter` de siempre quita exactamente al residente con ese id, si lo hay.
  const resident = byId.get(recipe.id);
  let next = current.slice();
  if (resident !== undefined) next.splice(current.indexOf(resident), 1);
  next.push(recipe);
  if (next.length > max) {
    const kept = next.slice(-max);
    for (let n = 0; n < next.length - kept.length; n++) byId.delete(next[n]!.id);
    next = kept;
  }
  byId.delete(recipe.id);
  if (next[next.length - 1] === recipe) byId.set(recipe.id, recipe);
  windowIndexes.delete(current);
  windowIndexes.set(next, { length: next.length, byId });
  state.recipes = next;
}
export function resolveTechnologyRecipe(host: TechnologyCatalogueHost, id: string,
  options: { cache?: boolean } = {}): TechnologyRecipe | undefined {
  const state = host.technology;
  if (!catalogueEnabled(state)) return state.recipes.find(recipe => recipe.id === id);
  const number = serial(id);
  if (number < 1 || number > state.recipeCounter) return undefined;
  let recipe = pendingRecipe(state.catalogue!.pending, id) ?? residentRecipe(state.recipes, id);
  if (!recipe) {
    const reader = readers.get(state); if (!reader) fail('an archived reference requires its host reader');
    const archived = reader.resolve(id, host.tick);
    if (!archived) return undefined;
    recipe = reader.freshCopies === true ? checkedRecipe(host, archived, id) : structuredClone(checkedRecipe(host, archived, id));
  }
  checkedRecipe(host, recipe, id);
  if (options.cache !== false) cacheRecipe(state, recipe);
  return recipe;
}
export function findTechnologyRecipe(host: TechnologyCatalogueHost, signature: string): TechnologyRecipe | undefined {
  const state = host.technology;
  const local = state.catalogue?.pending.find(recipe => recipe.signature === signature) ?? state.recipes.find(recipe => recipe.signature === signature);
  if (local) return resolveTechnologyRecipe(host, local.id);
  if (!catalogueEnabled(state)) return undefined;
  const reader = readers.get(state); if (!reader) fail('signature lookup requires its host reader');
  const archived = reader.findBySignature(signature, host.tick);
  if (!archived) return undefined;
  if (archived.signature !== signature) fail('resolved signature');
  const recipe = pendingRecipe(state.catalogue!.pending, archived.id) ?? structuredClone(checkedRecipe(host, archived));
  checkedRecipe(host, recipe);
  cacheRecipe(state, recipe); return recipe;
}
export function hasTechnologyFunction(host: TechnologyCatalogueHost, capacities: Record<Capability, number>): boolean {
  const code = technologyFunctionCode(capacities), state = host.technology;
  return catalogueEnabled(state) ? containsFunction(state.catalogue!.functions, code)
    : state.recipes.some(recipe => technologyFunctionCode(recipe.capacities) === code);
}
export function registerTechnologyRecipe(host: TechnologyCatalogueHost, recipe: TechnologyRecipe): void {
  const state = host.technology, catalogue = state.catalogue;
  if (!integer(state.recipeCounter + 1) || recipe.id !== `recipe-${state.recipeCounter + 1}` ||
    !integer(recipe.tick, host.tick) || !integer(recipe.generation) || !recipe.generation ||
    recipe.manufactured !== 0 || recipe.uses !== 0 || recipe.utility !== 0) fail('new recipe allocation');
  if (findTechnologyRecipe(host, recipe.signature)) fail('duplicate program');
  const code = technologyFunctionCode(recipe.capacities);
  if (recipe.novelty !== (hasTechnologyFunction(host, recipe.capacities) ? 'program' : 'both')) fail('new recipe novelty');
  if (!catalogue) {
    if (state.recipes.length >= state.budgets.maxRecipes || recipe.generation > state.budgets.maxGeneration) fail('standalone catalogue capacity');
    state.recipeCounter++; state.recipes.push(recipe); return;
  }
  if (catalogue.pending.length >= MAX_PENDING_TECHNOLOGY_RECIPES) fail('pending recipes require a durable commit');
  state.recipeCounter++; catalogue.pending.push(recipe);
  catalogue.totals.recipes++; catalogue.totals.maxGeneration = Math.max(catalogue.totals.maxGeneration, recipe.generation);
  if (addFunction(catalogue.functions, code)) catalogue.totals.functionalDiversity++;
  cacheRecipe(state, recipe);
}
export function updateTechnologyRecipeStats(host: TechnologyCatalogueHost, id: string,
  delta: { manufactured?: number; uses?: number; utility?: number }): void {
  if (Object.keys(delta).some(key => !['manufactured', 'uses', 'utility'].includes(key)) ||
    !integer(delta.manufactured ?? 0) || !integer(delta.uses ?? 0) || !finite(delta.utility ?? 0)) fail('statistics delta');
  const state = host.technology, recipe = resolveTechnologyRecipe(host, id, { cache: false });
  if (!recipe) fail('statistics require a known definition');
  const next = { manufactured: recipe.manufactured + (delta.manufactured ?? 0), uses: recipe.uses + (delta.uses ?? 0), utility: recipe.utility + (delta.utility ?? 0) };
  if (!integer(next.manufactured) || !integer(next.uses) || !finite(next.utility)) fail('statistics overflow');
  const catalogue = state.catalogue;
  if (catalogue) {
    const pending = pendingRecipe(catalogue.pending, id) !== undefined;
    if (!pending && catalogue.pending.length >= MAX_PENDING_TECHNOLOGY_RECIPES) fail('pending statistics require a durable commit');
    const totals = { ...catalogue.totals, manufactured: catalogue.totals.manufactured + (delta.manufactured ?? 0),
      uses: catalogue.totals.uses + (delta.uses ?? 0), utility: catalogue.totals.utility + (delta.utility ?? 0) };
    if (!integer(totals.manufactured) || !integer(totals.uses) || !finite(totals.utility)) fail('aggregate statistics overflow');
    if (!pending) catalogue.pending.push(recipe);
    catalogue.totals = totals;
  }
  Object.assign(recipe, next);
  if (catalogue) cacheRecipe(state, recipe);
}
export function technologyCatalogueTotals(host: TechnologyCatalogueHost): TechnologyCatalogueTotals {
  return catalogueEnabled(host.technology) ? { ...host.technology.catalogue!.totals } : totalsOf(host.technology.recipes);
}

/** Local envelope validation; the Store independently proves the durable prefix and aggregates. */
export function assertTechnologyCatalogueState(host: TechnologyCatalogueHost): void {
  const state = host.technology, catalogue = state.catalogue;
  if (catalogue === undefined) return;
  if (!catalogue || catalogue.version !== 1 || !integer(catalogue.committedThrough, state.recipeCounter) ||
    !Array.isArray(catalogue.pending) || catalogue.pending.length > MAX_PENDING_TECHNOLOGY_RECIPES ||
    !integer(catalogue.memoryCapacity, 256) || !catalogue.memoryCapacity || !Array.isArray(catalogue.functions) ||
    catalogue.functions.length !== TECHNOLOGY_FUNCTION_WORDS) fail('state envelope');
  // for-of visits empty slots; Array.every would silently accept a sparse bitmap.
  for (const word of catalogue.functions) if (!integer(word, 0xffffffff)) fail('function bitmap');
  const totals = catalogue.totals;
  if (!totals || totals.recipes !== state.recipeCounter || !integer(totals.maxGeneration) ||
    !integer(totals.manufactured) || !integer(totals.uses) || !finite(totals.utility) ||
    totals.manufactured !== state.ledger.crafted || totals.uses !== state.ledger.toolUses ||
    totals.functionalDiversity !== technologyFunctionCount(catalogue.functions)) fail('aggregate counters');
  const ids = new Set<string>();
  for (const recipe of catalogue.pending) {
    checkedRecipe(host, recipe);
    if (ids.has(recipe.id)) fail('duplicate pending identity');
    ids.add(recipe.id);
  }
  if (state.recipeCounter - catalogue.committedThrough > catalogue.pending.length) fail('uncommitted definition gap');
  for (let n = catalogue.committedThrough + 1; n <= state.recipeCounter; n++) if (!ids.has(`recipe-${n}`)) fail('uncommitted definition gap');
  for (const recipe of state.recipes) {
    checkedRecipe(host, recipe);
    const pending = catalogue.pending.find(record => record.id === recipe.id);
    if (pending && JSON.stringify(pending) !== JSON.stringify(recipe)) fail('resident and pending record disagree');
    if (recipe.generation > totals.maxGeneration || !containsFunction(catalogue.functions, technologyFunctionCode(recipe.capacities))) fail('resident summary disagrees');
  }
}
export function technologyCatalogueStateForCommit(state: TechnologyState): TechnologyState {
  return state.catalogue === undefined ? state : { ...state, catalogue: { ...state.catalogue, committedThrough: state.recipeCounter, pending: [] } };
}
/** The host calls this only after the transaction containing definitions and statistics commits. */
export function markTechnologyCatalogueCommitted(state: TechnologyState): void {
  if (state.catalogue) { state.catalogue.committedThrough = state.recipeCounter; state.catalogue.pending = []; }
}
