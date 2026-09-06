import type { ContainedWater, MaterialBatch, TechnologyExecution, WaterExecution, WaterLedger, WaterStock } from '../shared/technology.js';
import type { TechnologyActor, TechnologyHost } from './technology.js';
import type { BodyState } from './body.js';
import { exertBody, hydrateBody } from './body.js';
import { appendTechnologyExecution, technologyStock } from './technology-execution.js';
import { MAX_PENDING_TECHNOLOGY_EXECUTIONS } from './technology-journal.js';
import { touchKnownRecipe } from './technology-memory.js';
import { updateTechnologyRecipeStats } from './technology-catalogue.js';
import { assertWaterContents, capacityOverflowReturns, containerAffordance, DEFAULT_WATER_POLICY, flowQuantized,
  leakIntegerRemainder, WATER_QUANTA_PER_UNIT } from './material-affordances.js';

export const WATER_WORK_ENERGY = 0.00045;
export const WATER_WORK_FATIGUE = 0.00032;
export const WATER_PREPARATION_MAX_TICKS = 16;
export const WATER_RESERVE_HORIZON = 180;
type WaterActor = TechnologyActor & BodyState;
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const sum = (stock: readonly WaterStock[]): number => stock.reduce((n, line) => n + line.quanta, 0);
function fail(): never { throw new Error('Invalid contained water state or receipt.'); }
const keys = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && required.every(k => Object.hasOwn(value, k))
  && Object.keys(value).every(k => required.includes(k) || optional.includes(k));
function safe(n: number): number { if (!integer(n)) fail(); return n; }
export function emptyWaterLedger(): WaterLedger {
  return { version: 1, policyVersion: 1, filled: 0, consumed: 0, environmentalLoss: 0, work: 0, energy: 0 };
}
export function containedWaterStock(actor: TechnologyActor): WaterStock[] {
  return actor.technology.items.filter(i => (i.contents?.water ?? 0) > 0).map(i => ({ itemId: i.id, quanta: i.contents!.water }))
    .sort((a, b) => a.itemId.localeCompare(b.itemId));
}
export function containedWaterQuanta(actor: TechnologyActor): number { return sum(containedWaterStock(actor)); }
/** Raw inventories and residue also occupy the same mass scale; contents add payload. */
export function carriedTechnologyMass(actor: TechnologyActor): number {
  return actor.technology.items.reduce((n, item) => n + item.mass + (item.contents?.water ?? 0), 0)
    + Object.values(actor.technology.residue).reduce((n, mass) => n + mass, 0) + (actor.materials.wood + actor.materials.stone) * 1000;
}
export function freeWaterCarryQuanta(host: TechnologyHost, actor: TechnologyActor): number {
  const b = host.technology.budgets;
  return Math.max(0, Math.floor(b.maxItems * b.maxInputs * b.maxMassPerInput - carriedTechnologyMass(actor)));
}
export function assertContainedWater(value: unknown, tick: number): asserts value is ContainedWater {
  if (!keys(value, ['version', 'water', 'leakRemainder', 'lastTick']) || value.version !== 1 || !integer(value.lastTick) || value.lastTick > tick) fail();
  assertWaterContents(value);
}
function stock(value: unknown): value is WaterStock[] {
  if (!Array.isArray(value) || value.length > 16) return false;
  const ids = new Set<string>();
  for (const line of value) {
    if (!keys(line, ['itemId', 'quanta']) || typeof line.itemId !== 'string' || !/^product-[1-9]\d*$/.test(line.itemId)
      || !integer(Number(line.itemId.slice(8))) || ids.has(line.itemId) || !integer(line.quanta) || line.quanta === 0) return false;
    ids.add(line.itemId);
  }
  return integer(sum(value));
}
export function assertWaterExecution(event: Pick<TechnologyExecution, 'kind' | 'water' | 'work' | 'energy' | 'benefit'>): void {
  const w = event.water;
  if (w === undefined) { if (event.kind === 'water') fail(); return; }
  if (!keys(w, ['version', 'policyVersion', 'action', 'opening', 'closing', 'filled', 'consumed', 'lost', 'received', 'sent'], ['source'])
    || w.version !== 1 || w.policyVersion !== 1 || !['fill', 'drink', 'leak', 'spill', 'transfer', 'carry'].includes(w.action)
    || !stock(w.opening) || !stock(w.closing) || ![w.filled, w.consumed, w.lost, w.received, w.sent].every(integer)) fail();
  if (safe(sum(w.opening) + w.filled + w.received) !== safe(sum(w.closing) + w.consumed + w.lost + w.sent)) fail();
  if (w.action === 'transfer') {
    if (event.kind !== 'transfer' || w.filled || w.consumed || w.lost || w.received && w.sent || w.source !== undefined) fail();
  } else if (w.sent || w.received) fail();
  if (w.action === 'fill') {
    if (event.kind !== 'water' || !w.filled || w.consumed || w.lost || !keys(w.source, ['x', 'y', 'opening', 'closing'])
      || !Number.isSafeInteger(w.source.x) || !Number.isSafeInteger(w.source.y)
      || typeof w.source.opening !== 'number' || typeof w.source.closing !== 'number'
      || !Number.isFinite(w.source.opening) || w.source.opening < 0 || w.source.opening > 1
      || !Number.isFinite(w.source.closing) || w.source.closing < 0 || w.source.closing > w.source.opening
      || Math.abs(w.source.opening - w.source.closing - w.filled / WATER_QUANTA_PER_UNIT) > 1e-12
      || w.filled > DEFAULT_WATER_POLICY.flowQuantaPerTick || event.work !== 1 || event.energy !== WATER_WORK_ENERGY || event.benefit !== 0) fail();
  } else if (w.source !== undefined || w.filled) fail();
  if (w.action === 'drink') {
    if (event.kind !== 'water' || !w.consumed || w.lost || w.consumed > DEFAULT_WATER_POLICY.flowQuantaPerTick || event.work !== 1 || event.energy !== WATER_WORK_ENERGY
      || event.benefit <= 0 || Math.abs(event.benefit - w.consumed / WATER_QUANTA_PER_UNIT * 3) > 1e-12) fail();
  } else if (w.consumed) fail();
  if (w.action === 'leak' && (event.kind !== 'water' || !w.lost || event.work || event.energy || event.benefit)) fail();
  if (w.action === 'carry' && (event.kind !== 'water' || w.lost || event.work !== 1 || event.energy <= 0
    || event.energy !== sum(w.opening) / 1000 * 0.0008 || event.benefit)) fail();
  const before = new Map(w.opening.map(line => [line.itemId, line.quanta])), after = new Map(w.closing.map(line => [line.itemId, line.quanta]));
  let increases = 0, decreases = 0;
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const change = (after.get(id) ?? 0) - (before.get(id) ?? 0);
    increases += Number(change > 0); decreases += Number(change < 0);
    if (w.action === 'transfer' && change !== 0 && before.has(id) && after.has(id)) fail(); // Whole objects move; transfer cannot pour between vessels.
  }
  if (w.action === 'fill' && (increases !== 1 || decreases) || w.action === 'drink' && (decreases !== 1 || increases)
    || ['leak', 'spill'].includes(w.action) && increases || w.action === 'carry' && (increases || decreases)
    || w.action === 'transfer' && (w.sent && increases || w.received && decreases || !w.sent && !w.received && (increases || decreases))) fail();
  if (w.action === 'spill' && !['use', 'research', 'craft', 'recycle', 'estate'].includes(event.kind)) fail();
}
export function assertTechnologyWater(host: TechnologyHost): void {
  const ledger = host.technology.water;
  let current = 0;
  for (const actor of host.people) {
    for (const marker of [actor.technology.waterActionAt, actor.technology.waterCarryAt]) if (marker !== undefined && (!integer(marker) || marker > host.tick || !ledger)) fail();
    for (const item of actor.technology.items) if (item.contents !== undefined) {
      if (!ledger) fail(); assertContainedWater(item.contents, host.tick);
      if (item.contents.water > containerAffordance(item).capacityQuanta) fail();
      current = safe(current + item.contents.water);
    }
    const preparation = actor.technology.waterPreparation;
    if (preparation !== undefined) {
      if (!ledger || !keys(preparation, ['itemId', 'sourceX', 'sourceY', 'initialQuanta', 'targetQuanta', 'startedAt'])
        || !Number.isSafeInteger(preparation.sourceX) || !Number.isSafeInteger(preparation.sourceY)
        || !integer(preparation.initialQuanta) || !integer(preparation.targetQuanta) || preparation.targetQuanta <= preparation.initialQuanta
        || preparation.targetQuanta > DEFAULT_WATER_POLICY.flowQuantaPerTick * WATER_PREPARATION_MAX_TICKS
        || !integer(preparation.startedAt) || preparation.startedAt > host.tick || host.tick - preparation.startedAt > WATER_PREPARATION_MAX_TICKS
        || preparation.sourceX !== actor.x || preparation.sourceY !== actor.y
        || !actor.technology.items.some(item => item.id === preparation.itemId && preparation.targetQuanta <= containerAffordance(item).capacityQuanta)) fail();
    }
  }
  if (!ledger) {
    if (host.technology.history.some(e => e.water !== undefined) || host.technology.journal?.pending.some(e => e.water !== undefined)) fail();
    return;
  }
  assertWaterLedger(ledger, current);
  // Reconstruct only an observed complete interval. A rotated checkpoint is a
  // prospective opening, never a claim about liquid evidence that was discarded.
  const checkpoint = host.technology.checkpoint;
  if (!checkpoint || host.technology.historyDropped > checkpoint.executionCounter) return;
  const currentIds = new Set(host.people.map(actor => actor.id));
  if (currentIds.size !== checkpoint.inventories.length || checkpoint.inventories.some(inv => !currentIds.has(inv.actorId))) return;
  const stocks = new Map(checkpoint.inventories.map(inv => [inv.actorId, inv.items.filter(item => (item.contents?.water ?? 0) > 0)
    .map(item => ({ itemId: item.id, quanta: item.contents!.water })).sort((a, b) => a.itemId.localeCompare(b.itemId))]));
  const after = host.technology.history.filter(e => Number(e.id.slice(8)) > checkpoint.executionCounter);
  const nested = new Set(after.flatMap(e => e.nestedExecutionIds ?? [])), totals = { ...(checkpoint.water ?? emptyWaterLedger()) };
  const handling = new Set<string>(), carrying = new Set<string>(), transfers = new Map<string, TechnologyExecution[]>();
  const same = (a: WaterStock[], b: WaterStock[]) => JSON.stringify(a) === JSON.stringify([...b].sort((a, b) => a.itemId.localeCompare(b.itemId)));
  for (const event of after) if (!nested.has(event.id)) {
    if (!event.water) continue;
    assertWaterExecution(event);
    const action = event.water.action, key = `${event.actorId}:${event.tick}`;
    const budget = action === 'fill' || action === 'drink' ? handling : action === 'carry' ? carrying : undefined;
    if (budget) { if (budget.has(key)) fail(); budget.add(key); }
    if (action === 'transfer' && (event.water.sent || event.water.received)) {
      const pair = transfers.get(event.transferId!) ?? []; pair.push(event); transfers.set(event.transferId!, pair);
    }
    const before = stocks.get(event.actorId); if (!before || !same(before, event.water.opening)) fail();
    stocks.set(event.actorId, [...event.water.closing].sort((a, b) => a.itemId.localeCompare(b.itemId)));
    totals.filled = safe(totals.filled + event.water.filled); totals.consumed = safe(totals.consumed + event.water.consumed);
    totals.environmentalLoss = safe(totals.environmentalLoss + event.water.lost);
    if (event.kind === 'water') { totals.work = safe(totals.work + event.work); totals.energy += event.energy; }
  }
  for (const pair of transfers.values()) {
    if (pair.length !== 2) fail();
    const sent = pair.find(e => e.water!.sent > 0), received = pair.find(e => e.water!.received > 0);
    if (!sent || !received || sent.tick !== received.tick || sent.actorId !== received.counterpartyId || sent.counterpartyId !== received.actorId) fail();
    const removed = sent.water!.opening.filter(line => !sent.water!.closing.some(other => other.itemId === line.itemId));
    const added = received.water!.closing.filter(line => !received.water!.opening.some(other => other.itemId === line.itemId));
    if (!same(removed, added)) fail();
  }
  for (const actor of host.people) if (!same(stocks.get(actor.id)!, containedWaterStock(actor))) fail();
  if (totals.filled !== ledger.filled || totals.consumed !== ledger.consumed || totals.environmentalLoss !== ledger.environmentalLoss
    || totals.work !== ledger.work || Math.abs(totals.energy - ledger.energy) > 1e-12) fail();
}
export function assertWaterLedger(ledger: WaterLedger, current: number): void {
  if (!keys(ledger, ['version', 'policyVersion', 'filled', 'consumed', 'environmentalLoss', 'work', 'energy']) || ledger.version !== 1 || ledger.policyVersion !== 1
    || ![ledger.filled, ledger.consumed, ledger.environmentalLoss, ledger.work].every(integer)
    || !Number.isFinite(ledger.energy) || ledger.energy < 0 || ledger.energy > Number.MAX_SAFE_INTEGER
    || ledger.filled !== safe(current + ledger.consumed + ledger.environmentalLoss)) fail();
}
function room(host: TechnologyHost): void {
  if (!integer(host.tick) || host.technology.executionCounter >= Number.MAX_SAFE_INTEGER
    || (host.technology.journal?.pending.length ?? 0) >= MAX_PENDING_TECHNOLOGY_EXECUTIONS) fail();
}
function nextAccount(host: TechnologyHost, delta: Partial<Pick<WaterLedger, 'filled' | 'consumed' | 'environmentalLoss' | 'work' | 'energy'>>): WaterLedger {
  const ledger = host.technology.water ?? emptyWaterLedger(), next = { ...ledger };
  for (const [key, amount] of Object.entries(delta) as [keyof typeof delta, number][]) {
    const value = next[key] + amount;
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || key !== 'energy' && !integer(value)) fail();
    next[key] = value;
  }
  return next;
}
function account(host: TechnologyHost, delta: Partial<Pick<WaterLedger, 'filled' | 'consumed' | 'environmentalLoss' | 'work' | 'energy'>>): void {
  host.technology.water = nextAccount(host, delta);
}
export function waterEnvelope(actor: TechnologyActor, opening: WaterStock[], action: WaterExecution['action'],
  delta: Partial<Pick<WaterExecution, 'filled' | 'consumed' | 'lost' | 'received' | 'sent' | 'source'>> = {}): WaterExecution | undefined {
  const closing = containedWaterStock(actor);
  if (!opening.length && !closing.length && !Object.keys(delta).length) return;
  return { version: 1, policyVersion: 1, action, opening, closing, filled: 0, consumed: 0, lost: 0, received: 0, sent: 0, ...delta };
}
function record(host: TechnologyHost, actor: TechnologyActor, water: WaterExecution, work = 0, energy = 0, benefit = 0, recipeId: string | null = null): void {
  const dry = technologyStock(actor);
  appendTechnologyExecution(host, { kind: 'water', actorId: actor.id, recipeId, programSignature: '', inputs: [], outputs: [], residueMass: 0,
    work, energy, benefit, success: true, parentRecipeIds: [], catalysts: [], water,
    balance: { opening: dry, closing: dry, externalInputs: [], externalLoss: [] } });
}
/** Support changes spill excess before deletion; no water enters chemical residue. */
export function settleContainedWaterCapacity(host: TechnologyHost, item: MaterialBatch, destroy = false): number {
  if (!item.contents) return 0;
  assertContainedWater(item.contents, host.tick);
  const result = capacityOverflowReturns(item.contents, destroy ? 0 : containerAffordance(item).capacityQuanta, 0, 0);
  if (result.environmentalLossQuanta) account(host, { environmentalLoss: result.environmentalLossQuanta });
  item.contents = { ...item.contents, ...result.contents };
  return result.environmentalLossQuanta;
}
/** Called every world tick, including rest; fractional leakage is retained across saves. */
export function maintainContainedWater(host: TechnologyHost, actor: TechnologyActor): void {
  const opening = containedWaterStock(actor), changes: { item: MaterialBatch; contents: ContainedWater }[] = [];
  let lost = 0;
  for (const item of actor.technology.items) if (item.contents) {
    assertContainedWater(item.contents, host.tick);
    const affordance = containerAffordance(item), overflow = capacityOverflowReturns(item.contents, affordance.capacityQuanta, 0, 0);
    const leak = leakIntegerRemainder(overflow.contents, affordance.leakageNumerator, DEFAULT_WATER_POLICY.fixedPointDenominator, host.tick - item.contents.lastTick);
    lost = safe(lost + overflow.environmentalLossQuanta + leak.leakedQuanta);
    changes.push({ item, contents: { version: 1, ...leak.contents, lastTick: host.tick } });
  }
  if (lost) { room(host); account(host, { environmentalLoss: lost }); }
  for (const change of changes) change.item.contents = change.contents;
  if (lost) record(host, actor, waterEnvelope(actor, opening, 'leak', { lost })!);
}
function canHandle(host: TechnologyHost, actor: WaterActor): boolean {
  return host.people.includes(actor) && actor.technology.waterActionAt !== host.tick && actor.energy >= WATER_WORK_ENERGY
    && actor.fatigue <= 1 - WATER_WORK_FATIGUE && [actor.hunger, actor.thirst, actor.energy, actor.fatigue].every(n => Number.isFinite(n) && n >= 0 && n <= 1);
}
/** Backend action only: no planner or inventory lookup grants procedural knowledge. */
export function fillContainedWater(host: TechnologyHost, actor: WaterActor, itemId: string, requestedQuanta = DEFAULT_WATER_POLICY.flowQuantaPerTick): number {
  if (!integer(requestedQuanta)) fail();
  if (!canHandle(host, actor)) return 0;
  maintainContainedWater(host, actor);
  const item = actor.technology.items.find(item => item.id === itemId);
  const tile = host.tiles?.find(tile => tile.x === actor.x && tile.y === actor.y);
  if (!item || !tile || !Number.isFinite(tile.drinkingWater) || tile.drinkingWater! <= 0 || tile.drinkingWater! > 1) return 0;
  if (item.contents) assertContainedWater(item.contents, host.tick);
  const before = tile.drinkingWater!, contents = item.contents?.water ?? 0;
  const flow = flowQuantized({ sourceWater: Math.floor(before * WATER_QUANTA_PER_UNIT), destinationWater: contents,
    destinationCapacity: containerAffordance(item).capacityQuanta, requestedQuanta, carryFreeQuanta: freeWaterCarryQuanta(host, actor), elapsedTicks: 1, workAvailable: 1 });
  if (!flow.movedQuanta) return 0;
  room(host); const opening = containedWaterStock(actor), energy = flow.workSpent * WATER_WORK_ENERGY;
  account(host, { filled: flow.movedQuanta, work: flow.workSpent, energy });
  // Keep the original fractional environmental remainder; quantization only limits extraction.
  tile.drinkingWater = before - flow.movedQuanta / WATER_QUANTA_PER_UNIT;
  item.contents = { version: 1, water: flow.destinationWater, leakRemainder: item.contents?.leakRemainder ?? 0, lastTick: host.tick };
  actor.technology.waterActionAt = host.tick;
  exertBody(actor, { energy, fatigue: flow.workSpent * WATER_WORK_FATIGUE });
  record(host, actor, waterEnvelope(actor, opening, 'fill', { filled: flow.movedQuanta,
    source: { x: tile.x, y: tile.y, opening: before, closing: tile.drinkingWater } })!, flow.workSpent, energy, 0, item.recipeId);
  return flow.movedQuanta;
}
/** Hydration follows the debit, and only actual thirst relief is credited to the artifact. */
export function drinkContainedWater(host: TechnologyHost, actor: WaterActor, requestedQuanta = DEFAULT_WATER_POLICY.flowQuantaPerTick): number {
  if (!integer(requestedQuanta)) fail();
  if (!canHandle(host, actor) || actor.thirst <= 0) return 0;
  maintainContainedWater(host, actor);
  const item = actor.technology.items.find(item => (item.contents?.water ?? 0) > 0);
  if (!item) return 0;
  assertContainedWater(item.contents, host.tick);
  const requested = Math.min(requestedQuanta, Math.floor(actor.thirst / 3 * WATER_QUANTA_PER_UNIT));
  const flow = flowQuantized({ sourceWater: item.contents.water, destinationWater: 0, destinationCapacity: requested,
    requestedQuanta: requested, carryFreeQuanta: requested, elapsedTicks: 1, workAvailable: 1 });
  if (!flow.movedQuanta) return 0;
  room(host); const opening = containedWaterStock(actor), thirst = actor.thirst, energy = flow.workSpent * WATER_WORK_ENERGY;
  const ledger = nextAccount(host, { consumed: flow.movedQuanta, work: flow.workSpent, energy });
  const body = { hunger: actor.hunger, thirst, energy: actor.energy, fatigue: actor.fatigue };
  exertBody(body, { energy, fatigue: flow.workSpent * WATER_WORK_FATIGUE });
  hydrateBody(body, flow.movedQuanta / WATER_QUANTA_PER_UNIT);
  const benefit = thirst - body.thirst;
  // Archive resolution or statistics overflow must fail before the consumption
  // debit or bodily relief. All remaining assignments have been checked above.
  if (item.recipeId) {
    updateTechnologyRecipeStats(host, item.recipeId, { uses: 1, utility: benefit }); host.technology.ledger.toolUses++;
    touchKnownRecipe(actor.technology, item.recipeId);
  }
  host.technology.water = ledger;
  item.contents.water = flow.sourceWater; if (!item.contents.water) item.contents.leakRemainder = 0;
  actor.technology.waterActionAt = host.tick;
  actor.energy = body.energy; actor.fatigue = body.fatigue; actor.thirst = body.thirst;
  record(host, actor, waterEnvelope(actor, opening, 'drink', { consumed: flow.movedQuanta })!, flow.workSpent, energy, benefit, item.recipeId);
  return flow.movedQuanta;
}
/** One actual movement can pay this payload cost; an exhausted carrier cannot move it for free. */
export function payContainedWaterCarry(host: TechnologyHost, actor: WaterActor): boolean {
  if (!host.people.includes(actor)) return false;
  const water = containedWaterQuanta(actor); if (!water) return true;
  if (actor.technology.waterCarryAt === host.tick) return false;
  const energy = water / 1000 * 0.0008, fatigue = water / 1000 * 0.0007;
  if (actor.energy < energy + 0.0008 || actor.fatigue + fatigue > 1) return false;
  room(host); account(host, { work: 1, energy });
  const opening = containedWaterStock(actor);
  exertBody(actor, { energy, fatigue }); actor.technology.waterCarryAt = host.tick;
  record(host, actor, waterEnvelope(actor, opening, 'carry')!, 1, energy);
  return true;
}

/** A preparatory plan predicts only its owner's bodily demand and observed material retention.
 * No remote source, destination or recipe classification is consulted. */
export function beginWaterPreparation(host: TechnologyHost, actor: WaterActor, thirstPerTick: number): boolean {
  if (!host.technology.water || !host.people.includes(actor) || actor.technology.waterPreparation || !preparationReady(actor)
    || !Number.isFinite(thirstPerTick) || thirstPerTick <= 0) return false;
  const source = host.tiles?.find(tile => tile.x === actor.x && tile.y === actor.y);
  if (!source || (source.drinkingWater ?? 0) * WATER_QUANTA_PER_UNIT < DEFAULT_WATER_POLICY.flowQuantaPerTick) return false;
  const desired = Math.min(DEFAULT_WATER_POLICY.flowQuantaPerTick * WATER_PREPARATION_MAX_TICKS,
    Math.max(DEFAULT_WATER_POLICY.flowQuantaPerTick, Math.ceil(thirstPerTick * WATER_RESERVE_HORIZON / 3 * WATER_QUANTA_PER_UNIT)));
  const carried = containedWaterQuanta(actor);
  if (carried >= desired * 0.65) return false; // Do not chase each leaked quantum with a new filling visit.
  const choices = actor.technology.items.flatMap(item => {
    const properties = containerAffordance(item), initial = item.contents?.water ?? 0;
    const target = Math.min(properties.capacityQuanta, desired - (carried - initial), initial + freeWaterCarryQuanta(host, actor));
    const missing = target - initial;
    if (missing < DEFAULT_WATER_POLICY.flowQuantaPerTick) return [];
    const retained = leakIntegerRemainder({ water: target, leakRemainder: 0 }, properties.leakageNumerator,
      DEFAULT_WATER_POLICY.fixedPointDenominator, WATER_RESERVE_HORIZON).contents.water;
    const effort = Math.ceil(missing / DEFAULT_WATER_POLICY.quantaPerWork) * WATER_WORK_ENERGY
      + target / 1000 * 0.0008 * Math.ceil(WATER_RESERVE_HORIZON / 6);
    if (retained < DEFAULT_WATER_POLICY.flowQuantaPerTick || retained < target * 0.75 || actor.energy < 0.3 + effort) return [];
    return [{ item, initial, target, retained, effort }];
  }).sort((a, b) => b.retained / b.target - a.retained / a.target || a.effort - b.effort || a.item.id.localeCompare(b.item.id));
  const chosen = choices[0]; if (!chosen) return false;
  actor.technology.waterPreparation = { itemId: chosen.item.id, sourceX: actor.x, sourceY: actor.y,
    initialQuanta: chosen.initial, targetQuanta: chosen.target, startedAt: host.tick };
  return true;
}
function preparationReady(actor: WaterActor): boolean {
  return actor.hunger < 0.55 && actor.thirst < 0.18 && actor.fatigue < 0.6 && actor.energy > 0.35;
}
/** Every call either pays one real flow or closes the phase. The fixed target is never replenished after completion. */
export function advanceWaterPreparation(host: TechnologyHost, actor: WaterActor): { moved: number; complete: boolean } {
  const plan = actor.technology.waterPreparation;
  if (!plan) return { moved: 0, complete: true };
  const item = actor.technology.items.find(item => item.id === plan.itemId);
  const cancel = () => { delete actor.technology.waterPreparation; return { moved: 0, complete: true }; };
  if (!preparationReady(actor) || !item || actor.x !== plan.sourceX || actor.y !== plan.sourceY
    || host.tick - plan.startedAt >= WATER_PREPARATION_MAX_TICKS || (item.contents?.water ?? 0) >= plan.targetQuanta) return cancel();
  const moved = fillContainedWater(host, actor, item.id, plan.targetQuanta - (item.contents?.water ?? 0));
  const complete = !moved || (item.contents?.water ?? 0) >= plan.targetQuanta;
  if (complete) delete actor.technology.waterPreparation;
  return { moved, complete };
}
