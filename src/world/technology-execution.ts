import type { ResourceMass, TechnologyExecution } from '../shared/technology.js';
import type { TechnologyActor, TechnologyHost } from './technology.js';
import { journalTechnologyExecution } from './technology-journal.js';

export function technologyStock(actor: TechnologyActor): ResourceMass[] {
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
