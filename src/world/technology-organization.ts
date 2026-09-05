import type { OrganizationAnalysis, OrganizationExecution, OrganizationObservation, OrganizationProcess, OrganizationQuantity } from '../shared/organization.js';
import type { ResourceMass, TechnologyExecution, TechnologyKnowledge, TechnologyState } from '../shared/technology.js';
import { analyzeOrganization } from './organization.js';

export interface TechnologyOrganizationActor { id: string; technology: Pick<TechnologyKnowledge, 'items' | 'residue'>; }
type Stock = Map<string, number>;
type FlowRecord = TechnologyExecution & { transferId?: string; counterpartyId?: string };
const raw = ['raw:wood', 'raw:stone', 'raw:water'];
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
const stock = (values: readonly ResourceMass[]): Stock => {
  const result: Stock = new Map();
  for (const value of values) result.set(value.resourceId, (result.get(value.resourceId) ?? 0) + value.mass);
  return result;
};
const add = (target: Stock, values: Stock, sign = 1): void => { for (const [id, amount] of values) target.set(id, (target.get(id) ?? 0) + amount * sign); };
const quantities = (values: Stock): OrganizationQuantity[] => [...values].filter(([, amount]) => amount > 0).sort(([a], [b]) => a.localeCompare(b)).map(([resourceId, amount]) => ({ resourceId, amount }));
const equals = (a: Stock, b: Stock): boolean => sorted([...a.keys(), ...b.keys()]).every(id => (a.get(id) ?? 0) === (b.get(id) ?? 0));
const actorStock = (actor: TechnologyOrganizationActor): Stock => {
  const result: Stock = new Map();
  for (const item of actor.technology.items) {
    const id = item.recipeId ? `recipe:${item.recipeId}` : 'unclassified';
    result.set(id, (result.get(id) ?? 0) + item.mass);
  }
  for (const material of ['wood', 'stone', 'water'] as const) if (actor.technology.residue[material]) result.set(`residue:${material}`, actor.technology.residue[material]);
  return result;
};
const hash = (value: string): string => {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return (result >>> 0).toString(16);
};

interface AdaptedObservation { observation: OrganizationObservation; diagnostics: string[]; }

/**
 * Build a bounded material observation from explicit transaction envelopes. The
 * catalogue contains observed stoichiometric realizations, not hypothetical yields
 * inferred from recipe names. This cannot establish delivery between physical sites.
 */
export function observeTechnologyOrganization(state: TechnologyState, actors: readonly TechnologyOrganizationActor[], tick: number): AdaptedObservation {
  const diagnostics: string[] = [], history = state.history as FlowRecord[];
  if (state.historyDropped + history.length !== state.executionCounter) diagnostics.push('execution-ledger-gap');
  const allEvents = new Map(history.map(event => [event.id, event]));
  const parentByChild = new Map<string, string>();
  for (const parent of history) for (const childId of parent.nestedExecutionIds ?? []) {
    if (parentByChild.has(childId)) diagnostics.push(`multiple-transaction-parents:${childId}`);
    parentByChild.set(childId, parent.id);
  }
  // A truncated buffer can begin inside a tick or transaction. Exclude that whole
  // tick; a later interval can be complete even though lifetime history is bounded.
  const startTick = state.historyDropped > 0 && history.length ? history[0]!.tick + 1 : 0;
  if (startTick > tick) diagnostics.push('no-complete-retained-tick');
  const selected = history.filter(event => event.tick >= startTick && event.tick <= tick);
  const selectedIds = new Set(selected.map(event => event.id));
  const envelopes = selected.filter(event => !parentByChild.has(event.id));
  const previousEnvelopes = history.filter(event => event.tick < startTick && !parentByChild.has(event.id));
  const currentActors = new Map(actors.map(actor => [actor.id, actor]));
  const openingByActor = new Map<string, Stock>(), closingByActor = new Map<string, Stock>();
  const lastKind = new Map<string, string>();
  const imported: Stock = new Map(), exported: Stock = new Map();
  const unknownOpening = new Set<string>(), unknownClosing = new Set<string>();
  for (const event of envelopes) {
    const before = stock(event.balance.opening), after = stock(event.balance.closing);
    if (!openingByActor.has(event.actorId)) openingByActor.set(event.actorId, before);
    const previous = closingByActor.get(event.actorId);
    if (previous && !equals(previous, before)) diagnostics.push(`unlogged-stock-change:${event.actorId}`);
    closingByActor.set(event.actorId, after); lastKind.set(event.actorId, event.kind);
    add(imported, stock(event.balance.externalInputs)); add(exported, stock(event.balance.externalLoss));
    const expected = new Map(before);
    add(expected, stock(event.balance.externalInputs)); add(expected, stock(event.balance.externalLoss), -1);
    const externalMovement = ['estate', 'transfer'].includes(event.kind as string);
    if (!externalMovement) { add(expected, stock(event.inputs), -1); add(expected, stock(event.outputs)); }
    for (const childId of event.nestedExecutionIds ?? []) {
      const child = allEvents.get(childId);
      if (!child || !selectedIds.has(childId)) diagnostics.push(`missing-nested-execution:${childId}`);
      else if (child.actorId !== event.actorId || child.tick !== event.tick || !['use', 'recycle'].includes(child.kind)) diagnostics.push(`invalid-nested-execution:${childId}`);
      else { add(expected, stock(child.inputs), -1); add(expected, stock(child.outputs)); }
    }
    if (!equals(expected, after)) diagnostics.push(`transaction-resource-mismatch:${event.id}`);
    if (event.success && ['research', 'craft'].includes(event.kind)) {
      const recipe = state.recipes.find(recipe => recipe.id === event.recipeId);
      if (!recipe || recipe.signature !== event.programSignature) diagnostics.push(`unverified-recipe:${event.id}`);
      else if (recipe.program.steps.filter(step => step.requiredCatalyst).length !== event.catalysts.filter(catalyst => catalyst.required).length) diagnostics.push(`missing-required-catalyst:${event.id}`);
    }
  }
  // Estate and paired transfers describe movement across the scope, not manufacture.
  // Paired internal flows cancel; an incomplete pair remains an explicit import/loss.
  const transfers = new Map<string, FlowRecord[]>();
  for (const event of envelopes) if ((event.kind as string) === 'transfer') {
    if (!event.transferId) diagnostics.push(`missing-transfer-id:${event.id}`);
    else transfers.set(event.transferId, [...transfers.get(event.transferId) ?? [], event]);
  }
  for (const [id, pair] of transfers) {
    const [a, b] = pair;
    if (pair.length !== 2 || !a || !b || a.actorId !== b.counterpartyId || b.actorId !== a.counterpartyId || a.actorId === b.actorId ||
      !equals(stock(a.balance.externalInputs), stock(b.balance.externalLoss)) || !equals(stock(b.balance.externalInputs), stock(a.balance.externalLoss))) {
      diagnostics.push(`incomplete-transfer:${id}`); continue;
    }
    add(imported, stock(a.balance.externalInputs), -1); add(imported, stock(b.balance.externalInputs), -1);
    add(exported, stock(a.balance.externalLoss), -1); add(exported, stock(b.balance.externalLoss), -1);
  }
  for (const actor of actors) {
    const actual = actorStock(actor), previous = closingByActor.get(actor.id);
    if (previous && !equals(previous, actual)) diagnostics.push(`current-stock-mismatch:${actor.id}`);
    if (!openingByActor.has(actor.id)) {
      const boundary = previousEnvelopes.filter(event => event.actorId === actor.id).at(-1);
      if (boundary) {
        const known = stock(boundary.balance.closing); openingByActor.set(actor.id, known);
        if (!equals(known, actual)) diagnostics.push(`unlogged-stock-change:${actor.id}`);
      } else if (actual.size) {
        diagnostics.push(`unobserved-opening-stock:${actor.id}`);
        for (const id of actual.keys()) unknownOpening.add(id);
      }
    }
    closingByActor.set(actor.id, actual);
  }
  for (const [actorId, last] of closingByActor) if (!currentActors.has(actorId)) {
    // An explicit estate or completed transfer can close a departed actor's stock.
    // Disappearance alone cannot explain where remaining material went.
    if (!['estate', 'transfer'].includes(lastKind.get(actorId) ?? '') || [...last.values()].some(amount => amount > 0)) {
      diagnostics.push(`missing-current-actor:${actorId}`);
      for (const id of last.keys()) unknownClosing.add(id);
    }
  }
  const processes: OrganizationProcess[] = [], executions: OrganizationExecution[] = [];
  const canonicalProcesses = new Map<string, OrganizationProcess>(), signaturesById = new Map<string, string>();
  const recipeProcesses = new Map<string, string>(), lineage = new Map<string, string[]>();
  const convert = (event: FlowRecord, input: Stock, output: Stock, catalysts: OrganizationExecution['catalysts'], required: string[]) => {
    const hasMaterial = [...input.values(), ...output.values()].some(amount => amount > 0);
    const productive = event.success && hasMaterial && [...input.values()].some(amount => amount > 0) && [...output.values()].some(amount => amount > 0) &&
      (event.kind !== 'use' || event.benefit > 0);
    let processId = `failed:${event.programSignature || event.kind}`, units = 1;
    if (productive) {
      // Keep the actual batch size: these physical laws have minimum useful masses
      // and cannot be assumed to execute at arbitrary stoichiometric scale.
      const inputs = quantities(input), outputs = quantities(output);
      const base = event.kind === 'research' || event.kind === 'craft' ? event.recipeId ?? event.programSignature : `${event.kind}:${event.recipeId ?? 'material'}`;
      const key = JSON.stringify([base, inputs, outputs, sorted(required)]);
      let process = canonicalProcesses.get(key);
      if (!process) {
        let id = `${base}#${hash(key)}`, suffix = 1;
        while (signaturesById.has(id) && signaturesById.get(id) !== key) id = `${base}#${hash(key)}-${suffix++}`;
        process = { id, inputs, outputs, catalysts: sorted(required), parents: [] };
        canonicalProcesses.set(key, process); signaturesById.set(id, key); processes.push(process);
        lineage.set(id, [...event.parentRecipeIds]);
      }
      processId = process.id;
      if ((event.kind === 'research' || event.kind === 'craft') && event.recipeId && !recipeProcesses.has(event.recipeId)) recipeProcesses.set(event.recipeId, processId);
    }
    executions.push({ id: event.id, tick: event.tick, actorId: event.actorId, processId, units,
      inputs: quantities(input), outputs: quantities(output), catalysts, success: productive });
  };
  for (const event of envelopes) {
    if (['estate', 'transfer'].includes(event.kind as string)) continue;
    const input = stock(event.inputs), output = stock(event.outputs), wear: Stock = new Map(), required: string[] = [];
    const usedChildren = new Set<string>();
    for (const catalyst of event.catalysts) {
      const child = allEvents.get(catalyst.executionId);
      const resourceId = catalyst.recipeId ? `recipe:${catalyst.recipeId}` : 'unclassified';
      if (!child || !selectedIds.has(child.id) || !event.nestedExecutionIds?.includes(child.id) || child.kind !== 'use' || child.actorId !== event.actorId ||
        stock(child.inputs).get(resourceId) !== catalyst.wear || usedChildren.has(child.id)) {
        diagnostics.push(`unverified-catalyst-receipt:${event.id}:${catalyst.executionId}`); continue;
      }
      usedChildren.add(child.id); wear.set(resourceId, (wear.get(resourceId) ?? 0) + catalyst.wear);
      add(output, stock(child.outputs));
      if (catalyst.required) required.push(resourceId);
    }
    for (const childId of event.nestedExecutionIds ?? []) {
      const child = allEvents.get(childId);
      if (!child || !selectedIds.has(child.id) || usedChildren.has(childId)) continue;
      if (child.kind === 'use') diagnostics.push(`unattributed-nested-use:${childId}`);
      // Inventory recycling is an observed side operation, not a required reactant
      // of its neighboring manufacturing recipe. Preserve it as a separate process.
      convert(child, stock(child.inputs), stock(child.outputs), [], []);
    }
    convert(event, input, output, [...wear].map(([resourceId, amount]) => ({ resourceId, wear: amount })), required);
  }
  for (const process of processes) process.parents = (lineage.get(process.id) ?? []).map(id => recipeProcesses.get(id) ?? `unobserved:${id}`);
  const opening: Stock = new Map(), closing: Stock = new Map();
  for (const value of openingByActor.values()) add(opening, value);
  for (const value of closingByActor.values()) add(closing, value);
  const resources = sorted([...raw, ...opening.keys(), ...closing.keys(), ...imported.keys(), ...exported.keys(),
    ...executions.flatMap(event => [...event.inputs.map(item => item.resourceId), ...event.outputs.map(item => item.resourceId), ...event.catalysts.map(item => item.resourceId)])]);
  const observation: OrganizationObservation = {
    window: { startTick: Math.min(startTick, tick), endTick: tick, complete: diagnostics.length === 0 }, food: [...raw], processes, executions,
    resources: resources.map(resourceId => ({ resourceId,
      openingStock: unknownOpening.has(resourceId) ? undefined : opening.get(resourceId) ?? 0,
      closingStock: unknownClosing.has(resourceId) ? undefined : closing.get(resourceId) ?? 0,
      externalInput: imported.get(resourceId) ?? 0, externalLoss: exported.get(resourceId) ?? 0,
    })),
  };
  return { observation, diagnostics: sorted(diagnostics) };
}

export function analyzeTechnologyOrganization(state: TechnologyState, actors: readonly TechnologyOrganizationActor[], tick: number): OrganizationAnalysis {
  const { observation, diagnostics } = observeTechnologyOrganization(state, actors, tick);
  const result = analyzeOrganization(observation);
  result.evidence.failures = sorted([...result.evidence.failures, ...diagnostics]);
  return result;
}
