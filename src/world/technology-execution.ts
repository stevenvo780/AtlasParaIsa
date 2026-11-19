import type { ResourceMass, TechnologyExecution } from '../shared/technology.js';
import type { TechnologyActor, TechnologyHost } from './technology.js';
import { journalTechnologyExecution } from './technology-journal.js';
import { emitObserved } from './observation.js';

export function technologyStock(actor: TechnologyActor): ResourceMass[] {
  const map = new Map<string, number>();
  for (const item of actor.technology.items) {
    const id = item.recipeId ? `recipe:${item.recipeId}` : 'unclassified';
    map.set(id, (map.get(id) ?? 0) + item.mass);
  }
  for (const m of ['wood', 'stone', 'water'] as const) if (actor.technology.residue[m]) map.set(`residue:${m}`, actor.technology.residue[m]);
  return [...map].map(([resourceId, mass]) => ({ resourceId, mass })).sort((a, b) => a.resourceId.localeCompare(b.resourceId));
}
export function appendTechnologyExecution(host: TechnologyHost, event: Omit<TechnologyExecution, 'id' | 'tick'>): TechnologyExecution {
  const state = host.technology, execution = { ...event, id: `process-${state.executionCounter + 1}`, tick: host.tick };
  journalTechnologyExecution(state, execution);
  state.executionCounter++;
  state.history.push(execution);
  emitObserved(host, 'technology-execution.append', () => ({ kind: 'technology-execution',
    executionId: execution.id, tick: execution.tick, actorId: execution.actorId,
    counterpartyId: execution.counterpartyId ?? null, transferId: execution.transferId ?? null,
    receiptKind: execution.kind, recipeId: execution.recipeId, programSignature: execution.programSignature,
    success: execution.success,
    inputs: execution.inputs, outputs: execution.outputs, energy: execution.energy, work: execution.work,
    benefitAtAppend: execution.benefit, nestedExecutionIds: execution.nestedExecutionIds ?? [],
    catalysts: execution.catalysts, balance: execution.balance, water: execution.water ?? null }));
  if (state.history.length > state.budgets.maxHistory) {
    const removed = state.history.length - state.budgets.maxHistory; state.history.splice(0, removed); state.historyDropped += removed;
  }
  return execution;
}
