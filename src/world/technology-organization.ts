import type { OrganizationAnalysis, OrganizationExecution, OrganizationObservation, OrganizationProcess, OrganizationQuantity } from '../shared/organization.js';
import type { Composition, ResourceMass, TechnologyCheckpoint, TechnologyExecution, TechnologyKnowledge, TechnologyRecipe, TechnologyState } from '../shared/technology.js';
import { analyzeOrganization } from './organization.js';
import { assertTechnologyCheckpoint, technologyHistoryGap } from './technology-checkpoint.js';
import { resolveTechnologyRecipe, withArchiveReadBatch } from './technology-catalogue.js';

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
const quantities = (values: Stock): OrganizationQuantity[] => {
  const result: OrganizationQuantity[] = [];
  for (const [resourceId, amount] of values) if (amount > 0) result.push({ resourceId, amount });
  return result.length > 1 ? result.sort((a, b) => a.resourceId.localeCompare(b.resourceId)) : result;
};
const anyPositive = (values: Stock): boolean => { for (const amount of values.values()) if (amount > 0) return true; return false; };
/** Igualdad de existencias con la ausencia como 0: recorre cada mapa una vez, sin claves combinadas. */
const equals = (a: Stock, b: Stock): boolean => {
  for (const [id, amount] of a) if ((b.get(id) ?? 0) !== amount) return false;
  for (const [id, amount] of b) if (!a.has(id) && amount !== 0) return false;
  return true;
};
const physicalStock = (items: readonly { recipeId: string | null; mass: number }[], residue: Composition): Stock => {
  const result: Stock = new Map();
  for (const item of items) {
    const id = item.recipeId ? `recipe:${item.recipeId}` : 'unclassified';
    result.set(id, (result.get(id) ?? 0) + item.mass);
  }
  if (residue.wood) result.set('residue:wood', residue.wood);
  if (residue.stone) result.set('residue:stone', residue.stone);
  if (residue.water) result.set('residue:water', residue.water);
  return result;
};
const actorStock = (actor: { technology: { items: readonly { recipeId: string | null; mass: number }[]; residue: Composition } }): Stock =>
  physicalStock(actor.technology.items, actor.technology.residue);
/** Misma comprobación que antes, sin `Map` ni arreglos temporales cuando el inventario es pequeño. */
const SMALL_INVENTORY = 4;
const samePhysicalStock = (opening: TechnologyCheckpoint['inventories'][number], actor: TechnologyOrganizationActor): boolean => {
  const current = actor.technology.items, expected = opening.items;
  if (current.length !== expected.length) return false;
  if (current.length > SMALL_INVENTORY) {
    const items = new Map(current.map(item => [item.id, item]));
    return items.size === expected.length && sameResidue(opening.residue, actor.technology.residue) &&
      expected.every(item => sameItem(items.get(item.id), item));
  }
  // Un `id` repetido en el inventario actual invalida la comparación (equivale a `items.size !== length`).
  for (let i = 1; i < current.length; i++) for (let j = 0; j < i; j++) if (current[i]!.id === current[j]!.id) return false;
  if (!sameResidue(opening.residue, actor.technology.residue)) return false;
  for (const item of expected) {
    let found: (typeof current)[number] | undefined;
    for (const candidate of current) if (candidate.id === item.id) { found = candidate; break; }
    if (!sameItem(found, item)) return false;
  }
  return true;
};
const sameResidue = (a: Composition, b: Composition): boolean => a.wood === b.wood && a.stone === b.stone && a.water === b.water;
const sameItem = (current: TechnologyOrganizationActor['technology']['items'][number] | undefined, item: TechnologyCheckpoint['inventories'][number]['items'][number]): boolean =>
  current?.recipeId === item.recipeId && current.mass === item.mass &&
  current.composition.wood === item.composition.wood && current.composition.stone === item.composition.stone && current.composition.water === item.composition.water;
const hash = (value: string): string => {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return (result >>> 0).toString(16);
};

interface AdaptedObservation { observation: OrganizationObservation; diagnostics: string[]; }

/**
 * Build a bounded material observation from explicit transaction envelopes. The
 * process list contains observed stoichiometric realizations in this receipt window,
 * not the resident recipe cache or the lifetime archive. Cold definitions only verify
 * receipts; they cannot extend the observation or establish delivery between sites.
 */
export function observeTechnologyOrganization(state: TechnologyState, actors: readonly TechnologyOrganizationActor[], tick: number): AdaptedObservation {
  const diagnostics: string[] = [], history = state.history as FlowRecord[];
  let checkpoint = state.checkpoint;
  try { assertTechnologyCheckpoint(state, tick); } catch { diagnostics.push('invalid-opening-checkpoint'); checkpoint = undefined; }
  if (!checkpoint) diagnostics.push('missing-opening-checkpoint');
  if (technologyHistoryGap(state)) diagnostics.push('execution-ledger-gap');
  const allEvents = new Map<string, FlowRecord>();
  for (const event of history) allEvents.set(event.id, event);
  const parentByChild = new Map<string, string>();
  for (const parent of history) for (const childId of parent.nestedExecutionIds ?? []) {
    if (parentByChild.has(childId)) diagnostics.push(`multiple-transaction-parents:${childId}`);
    parentByChild.set(childId, parent.id);
  }
  // The checkpoint is the END of its tick. Its opening is never inferred from
  // a later receipt or current inventory, including after a history gap.
  const startTick = checkpoint ? checkpoint.tick + 1 : tick + 1;
  if (startTick > tick) diagnostics.push('no-complete-epoch');
  const selected = checkpoint ? history.filter(event => Number(event.id.slice(8)) > checkpoint.executionCounter) : [];
  for (const event of selected) if (event.tick < startTick || event.tick > tick) diagnostics.push(`execution-outside-epoch:${event.id}`);
  const selectedIds = new Set(selected.map(event => event.id));
  const envelopes = selected.filter(event => !parentByChild.has(event.id));
  const currentActors = new Map<string, TechnologyOrganizationActor>();
  for (const actor of actors) currentActors.set(actor.id, actor);
  if (currentActors.size !== actors.length) diagnostics.push('duplicate-current-actor');
  const openingByActor = new Map<string, Stock>(), closingByActor = new Map<string, Stock>();
  const initialInventoryByActor = new Map<string, TechnologyCheckpoint['inventories'][number]>();
  for (const inventory of checkpoint?.inventories ?? []) {
    // Ninguna existencia del mapa de cierre se muta in situ: solo se sustituye entera, así que comparte el de apertura.
    const opening = physicalStock(inventory.items, inventory.residue);
    openingByActor.set(inventory.actorId, opening); closingByActor.set(inventory.actorId, opening);
    initialInventoryByActor.set(inventory.actorId, inventory);
  }
  if (checkpoint && (currentActors.size !== checkpoint.inventories.length || checkpoint.inventories.some(inventory => !currentActors.has(inventory.actorId)))) diagnostics.push('checkpoint-roster-change');
  const lastKind = new Map<string, string>();
  const imported: Stock = new Map(), exported: Stock = new Map();
  const unknownOpening = new Set<string>(), unknownClosing = new Set<string>();
  const actorsWithEnvelope = new Set<string>();
  const resolvedRecipes = new Map<string, TechnologyRecipe | undefined>();
  const resolveColdRecipe = (id: string): TechnologyRecipe | undefined => {
    if (resolvedRecipes.has(id)) return resolvedRecipes.get(id);
    const recipe = resolveTechnologyRecipe({ technology: state, tick }, id, { cache: false });
    resolvedRecipes.set(id, recipe);
    return recipe;
  };
  withArchiveReadBatch({ technology: state, tick }, () => {
  for (const event of envelopes) {
    actorsWithEnvelope.add(event.actorId);
    const before = stock(event.balance.opening), after = stock(event.balance.closing);
    if (!openingByActor.has(event.actorId)) {
      diagnostics.push(`unobserved-opening-stock:${event.actorId}`);
      for (const id of before.keys()) unknownOpening.add(id);
    }
    const previous = closingByActor.get(event.actorId);
    if (previous && !equals(previous, before)) diagnostics.push(`unlogged-stock-change:${event.actorId}`);
    closingByActor.set(event.actorId, after); lastKind.set(event.actorId, event.kind);
    add(imported, stock(event.balance.externalInputs)); add(exported, stock(event.balance.externalLoss));
    const expected = new Map(before);
    add(expected, stock(event.balance.externalInputs)); add(expected, stock(event.balance.externalLoss), -1);
    const externalMovement = (event.kind as string) === 'estate' || (event.kind as string) === 'transfer';
    if (!externalMovement) { add(expected, stock(event.inputs), -1); add(expected, stock(event.outputs)); }
    for (const childId of event.nestedExecutionIds ?? []) {
      const child = allEvents.get(childId);
      if (!child || !selectedIds.has(childId)) diagnostics.push(`missing-nested-execution:${childId}`);
      else if (child.actorId !== event.actorId || child.tick !== event.tick || (child.kind !== 'use' && child.kind !== 'recycle')) diagnostics.push(`invalid-nested-execution:${childId}`);
      else { add(expected, stock(child.inputs), -1); add(expected, stock(child.outputs)); }
    }
    if (!equals(expected, after)) diagnostics.push(`transaction-resource-mismatch:${event.id}`);
    if (event.success && (event.kind === 'research' || event.kind === 'craft')) {
      const recipe = event.recipeId ? resolveColdRecipe(event.recipeId) : undefined;
      if (!recipe || recipe.tick > event.tick || recipe.signature !== event.programSignature) diagnostics.push(`unverified-recipe:${event.id}`);
      else if (recipe.program.steps.filter(step => step.requiredCatalyst).length !== event.catalysts.filter(catalyst => catalyst.required).length) diagnostics.push(`missing-required-catalyst:${event.id}`);
    }
  }
  });
  // Estate and paired transfers describe movement across the scope, not manufacture.
  // Paired internal flows cancel; an incomplete pair remains an explicit import/loss.
  const transfers = new Map<string, FlowRecord[]>();
  for (const event of envelopes) if ((event.kind as string) === 'transfer') {
    if (!event.transferId) diagnostics.push(`missing-transfer-id:${event.id}`);
    else { const pair = transfers.get(event.transferId); if (pair) pair.push(event); else transfers.set(event.transferId, [event]); }
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
      diagnostics.push(`unobserved-opening-stock:${actor.id}`);
      for (const id of actual.keys()) unknownOpening.add(id);
    } else if (!actorsWithEnvelope.has(actor.id)) {
      const initial = initialInventoryByActor.get(actor.id)!;
      if (!samePhysicalStock(initial, actor)) diagnostics.push(`unlogged-physical-stock-change:${actor.id}`);
    }
    closingByActor.set(actor.id, actual);
  }
  for (const [actorId, last] of closingByActor) if (!currentActors.has(actorId)) {
    // An explicit estate or completed transfer can close a departed actor's stock.
    // Disappearance alone cannot explain where remaining material went.
    const kind = lastKind.get(actorId);
    if ((kind !== 'estate' && kind !== 'transfer') || anyPositive(last)) {
      diagnostics.push(`missing-current-actor:${actorId}`);
      for (const id of last.keys()) unknownClosing.add(id);
    }
  }
  const processes: OrganizationProcess[] = [], executions: OrganizationExecution[] = [];
  const canonicalProcesses = new Map<string, OrganizationProcess>(), signaturesById = new Map<string, string>();
  const recipeProcesses = new Map<string, string>(), lineage = new Map<string, string[]>();
  const convert = (event: FlowRecord, input: Stock, output: Stock, catalysts: OrganizationExecution['catalysts'], required: string[]) => {
    // Un insumo y un producto positivos ya implican material: no hace falta una tercera pasada.
    const productive = event.success && anyPositive(input) && anyPositive(output) && (event.kind !== 'use' || event.benefit > 0);
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
    if ((event.kind as string) === 'estate' || (event.kind as string) === 'transfer') continue;
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
  const resourceIds = new Set<string>(raw);
  for (const id of opening.keys()) resourceIds.add(id);
  for (const id of closing.keys()) resourceIds.add(id);
  for (const id of imported.keys()) resourceIds.add(id);
  for (const id of exported.keys()) resourceIds.add(id);
  for (const event of executions) {
    for (const item of event.inputs) resourceIds.add(item.resourceId);
    for (const item of event.outputs) resourceIds.add(item.resourceId);
    for (const item of event.catalysts) resourceIds.add(item.resourceId);
  }
  const resources = sorted(resourceIds);
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
