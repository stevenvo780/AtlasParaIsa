import type { ResourceMass, TechnologyExecution } from '../shared/technology.js';
import type { TechnologyActor, TechnologyHost } from './technology.js';
import { journalTechnologyExecution } from './technology-journal.js';

/** Orden de las líneas de `technologyStock`: `localeCompare` por `resourceId`. */
const byResourceId = (a: ResourceMass, b: ResourceMass): number => a.resourceId.localeCompare(b.resourceId);
const byResourceIdNative = (a: ResourceMass, b: ResourceMass): number => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0;
/** V18 ola 2: los `resourceId` son `recipe:<id>`, `residue:<material>` y `unclassified`; los ids de receta viven en el
 * alfabeto `a-z`, dígitos y `-`. Ahí `localeCompare` coincide con la comparación nativa de cadenas (se comprueba al cargar el
 * módulo con una muestra, por si la configuración regional del entorno reordenara letras); cualquier otro id usa `localeCompare`. */
const RECIPE_ALPHABET = /^[-0-9a-z]*$/;
const NATIVE_ORDER = (() => {
  const parts = ['', '0', '1', '9', '10', '12', '7', 'a', 'aa', 'ab', 'b', 'ch', 'll', 'z', '-', '1-2', 'a-b', 'ab-', 'recipe-1', 'recipe-10', 'recipe-2', 'recipe-9', 'x'];
  const keys = ['unclassified', 'residue:stone', 'residue:water', 'residue:wood', ...parts.map(part => `recipe:${part}`)];
  for (const a of keys) for (const b of keys) if (Math.sign(a.localeCompare(b)) !== (a < b ? -1 : a > b ? 1 : 0)) return false;
  return true;
})();
const RESIDUES = [['wood', 'residue:wood'], ['stone', 'residue:stone'], ['water', 'residue:water']] as const;

export function technologyStock(actor: TechnologyActor): ResourceMass[] {
  const items = actor.technology.items, residue = actor.technology.residue;
  // Una línea por receta distinta (en orden de aparición) y luego los residuos, como el `Map` de siempre, pero sin crear la
  // cadena `recipe:<id>` por objeto: se agrupa por el propio id y la clave se construye una vez por receta.
  const lines: ResourceMass[] = [], recipes: (string | null)[] = [];
  let native = NATIVE_ORDER;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!, recipeId = item.recipeId;
    if (recipeId && typeof recipeId !== 'string') return legacyTechnologyStock(actor); // id no cadena (forjado): clave por conversión
    const recipe = recipeId ? recipeId : null;
    let at = -1;
    for (let k = 0; k < recipes.length; k++) if (recipes[k] === recipe) { at = k; break; }
    if (at < 0) {
      recipes.push(recipe);
      if (recipe !== null && native && !RECIPE_ALPHABET.test(recipe)) native = false;
      lines.push({ resourceId: recipe !== null ? `recipe:${recipe}` : 'unclassified', mass: 0 + item.mass });
    } else lines[at]!.mass = lines[at]!.mass + item.mass;
  }
  for (const [material, resourceId] of RESIDUES) if (residue[material]) lines.push({ resourceId, mass: residue[material] });
  if (lines.length > 1) lines.sort(native ? byResourceIdNative : byResourceId);
  return lines;
}
/** La definición previa, tal cual: sólo para ids de receta que no son cadenas. */
function legacyTechnologyStock(actor: TechnologyActor): ResourceMass[] {
  const map = new Map<string, number>();
  for (const item of actor.technology.items) {
    const id = item.recipeId ? `recipe:${item.recipeId}` : 'unclassified';
    map.set(id, (map.get(id) ?? 0) + item.mass);
  }
  for (const m of ['wood', 'stone', 'water'] as const) if (actor.technology.residue[m]) map.set(`residue:${m}`, actor.technology.residue[m]);
  return [...map].map(([resourceId, mass]) => ({ resourceId, mass })).sort((a, b) => a.resourceId.localeCompare(b.resourceId));
}
/** Serial de un id `process-N`; `null` si no lo es (T146, sin asignar nada). */
export function technologyExecutionSerial(id: string): number | null {
  if (typeof id !== 'string' || !/^process-[1-9]\d*$/.test(id)) return null;
  const serial = Number(id.slice(8));
  return Number.isSafeInteger(serial) ? serial : null;
}

/**
 * T146: renumera en bloque las ejecuciones de UNA transacción a partir de
 * `firstSerial` (el que asigna el prefix-sum del coordinador). Las ejecuciones
 * deben venir en su orden de emisión y con seriales viejos contiguos; se mutan
 * los propios objetos para que `history` y `journal.pending` —que comparten
 * referencia— sigan siendo el mismo recibo. Devuelve el mapa serialViejo→nuevo
 * de este bloque; `technology.ts` lo aplica a `nestedExecutionIds`/`catalysts`.
 * No se llama en el camino por defecto (`motor.hilos=1` ya emite en orden).
 */
export function renumberTechnologyExecutionBlock(executions: readonly TechnologyExecution[], firstSerial: number): Map<number, number> {
  if (!Number.isSafeInteger(firstSerial) || firstSerial < 1) throw new RangeError('Renumeración de tecnología: firstSerial debe ser un entero seguro ≥ 1.');
  const map = new Map<number, number>();
  let previous: number | undefined;
  executions.forEach((execution, index) => {
    const old = execution ? technologyExecutionSerial(execution.id) : null;
    if (old === null || (previous !== undefined && old !== previous + 1)) throw new Error('Renumeración de tecnología: las ejecuciones de una transacción deben ser contiguas.');
    previous = old;
    const next = firstSerial + index;
    if (!Number.isSafeInteger(next)) throw new RangeError('Renumeración de tecnología: desbordamiento de serial.');
    map.set(old, next);
  });
  executions.forEach((execution, index) => { execution.id = `process-${firstSerial + index}`; });
  return map;
}

export function appendTechnologyExecution(host: TechnologyHost, event: Omit<TechnologyExecution, 'id' | 'tick'>): TechnologyExecution {
  const state = host.technology, execution = { ...event, id: `process-${state.executionCounter + 1}`, tick: host.tick };
  journalTechnologyExecution(state, execution);
  state.executionCounter++;
  state.history.push(execution);
  if (state.history.length > state.budgets.maxHistory) {
    const removed = state.history.length - state.budgets.maxHistory; state.history.splice(0, removed); state.historyDropped += removed;
  }
  return execution;
}
