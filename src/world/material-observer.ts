/** Provisional measurement, outside World, its RNG, journals and persisted schema.
 * Call ingest before stepping, then after accepting a step (also before Store.save).
 * Hooks copy only small scalar records; ingest never rescans the world after attachment.
 * An un-ingested clone is a candidate: its events cannot affect confirmed measurements.
 * exposureTicks measures clock duration between active-residence marks [from,to), not
 * simulation-frame counts. stepWorld increments its clock before maintainRegions: a
 * building activated at tick t can receive its first wear evaluation at t with zero
 * elapsed residence. wearEvaluations records those actual evaluations independently.
 * Direct assignment of material fields outside the existing engine hooks is not covered. */
import type { AnclaDesgaste, StructureComponent, StructureView } from '../shared/life.js';
import { condicionProyectada, desgasteActivo } from './desgaste.js';
import type { Person, World } from './index.js';
import { blueprintCost, BROKEN_CONDITION, COMPONENTS } from './inventions.js';

const DAY = 2400;
type Cost = { wood: number; stone: number; work: number };
type UseKind = 'food' | 'water' | 'rest';
type UserClass = 'mortal' | 'protected' | 'unknown';
type State = Pick<StructureView, 'id' | 'condition' | 'water' | 'food'>;
type Identity = State & Pick<StructureView, 'x' | 'y' | 'blueprintId' | 'builtAt' | 'builderId' | 'components'>;
/** Etiqueta DESG-D (rama de laboratorio): prefijos vigentes + ancla y proyección por separado. Solo con ley=1. */
type DesgasteTag = { N: number; R: number; ancla: AnclaDesgaste | null; proyectada: number | null };
type Event = { tick: number; state: State; desgaste?: DesgasteTag } & (
  | { kind: 'built' | 'activated' | 'retired'; identity: Identity; paid?: Cost }
  | { kind: 'stock' }
  | { kind: 'wear' | 'repair'; before: number; wood: number; work: number }
  | { kind: 'use'; use: UseKind; personId: string | null; userClass: UserClass; amount: number; benefit: number }
);
interface Link { event: Event | null; previous: Link | null }
interface Capture { observer: MaterialObserver; tail: Link; discarded?: boolean; confirmations: number }
const captures = new WeakMap<World, Capture>();
const stateOf = (s: StructureView): State => ({ id: s.id, condition: s.condition, water: s.water, food: s.food });
const identityOf = (s: StructureView): Identity => ({ ...stateOf(s), x: s.x, y: s.y, blueprintId: s.blueprintId,
  builtAt: s.builtAt, builderId: s.builderId, components: [...s.components] });
const dayOf = (tick: number) => Math.max(1, Math.ceil(tick / DAY));
function append(capture: Capture, event: Event): void { if (!capture.discarded) capture.tail = { event, previous: capture.tail }; }
/** N/R del mundo + ancla copiada + q/Q proyectada; undefined con ley=0 (cero huella). */
function etiquetaDesgaste(world: World, structure: StructureView): DesgasteTag | undefined {
  if (!desgasteActivo(world)) return undefined;
  const ancla = structure.anclaDesgaste ?? null;
  const N = world.revisionesObra ?? 0, R = world.revisionesLluvia ?? 0;
  return { N, R, ancla: ancla ? { ...ancla } : null,
    proyectada: ancla ? condicionProyectada(structure.components, ancla, N, R) : null };
}

/** cloneWorld is the only candidate inheritance seam; nothing is added to WorldContext. */
export function inheritMaterialObserver(source: World, candidate: World): void {
  const capture = captures.get(source);
  if (capture && !capture.discarded) captures.set(candidate, { observer: capture.observer, tail: capture.tail, confirmations: 0 });
}
/** A world's existing rollback point also rolls back its still-unconfirmed observations. */
export function checkpointMaterialObserver(world: World): (() => void) | undefined {
  const capture = captures.get(world); if (!capture || capture.discarded) return;
  const tail = capture.tail, confirmations = capture.confirmations;
  return () => {
    if (capture.confirmations !== confirmations) throw new Error('Material observer cannot roll back an already confirmed step.');
    capture.tail = tail;
  };
}
export function observeMaterialBuilt(world: World, structure: StructureView, cost: Cost): void {
  const capture = captures.get(world); if (!capture) return;
  const identity = identityOf(structure);
  append(capture, { kind: 'built', tick: world.tick, state: identity, identity, paid: { ...cost }, desgaste: etiquetaDesgaste(world, structure) });
}
export function observeMaterialRegion(world: World, structure: StructureView, kind: 'activated' | 'retired'): void {
  const capture = captures.get(world); if (!capture) return;
  const identity = identityOf(structure);
  append(capture, { kind, tick: world.tick, state: identity, identity, desgaste: etiquetaDesgaste(world, structure) });
}
export function observeMaterialStock(world: World, structure: StructureView): void {
  const capture = captures.get(world); if (!capture) return;
  append(capture, { kind: 'stock', tick: world.tick, state: stateOf(structure), desgaste: etiquetaDesgaste(world, structure) });
}
export function observeMaterialUse(world: World, structure: StructureView, person: Person, use: UseKind, amount: number, benefit: number): void {
  const capture = captures.get(world); if (!capture || benefit <= 0) return;
  const userClass: UserClass = person.role === 'neighbor' ? 'mortal' : person.role === 'S' || person.role === 'I' ? 'protected' : 'unknown';
  append(capture, { kind: 'use', tick: world.tick, state: stateOf(structure), desgaste: etiquetaDesgaste(world, structure), use, amount, benefit,
    personId: typeof person.id === 'string' ? person.id : null, userClass });
}
export function observeMaterialCondition(world: World, structure: StructureView, kind: 'wear' | 'repair', before: number, wood = 0, work = 0): void {
  const capture = captures.get(world); if (!capture) return;
  append(capture, { kind, tick: world.tick, state: stateOf(structure), desgaste: etiquetaDesgaste(world, structure), before, wood, work });
}

export interface MaterialDailyRow {
  structureId: string; day: number; startTick: number; endTick: number;
  observedStartTick: number; observedEndTick: number; partial: boolean;
  observedTicks: number; hasObservationGap: boolean;
  exposureTicks: number; wearEvaluations: number; activationCount: number; retirementCount: number;
  uses: Record<UseKind, number>; useCountsByClass: Record<UserClass, number>;
  usersByClass: Record<UserClass, string[]>; benefitByKind: Record<UseKind, number>; amountByKind: Record<UseKind, number>;
  repairCount: number; repairWoodPaid: number; repairWorkPaid: number;
  conditionInitial: number; conditionFinal: number; conditionMinimum: number;
  brokenObserved: boolean; conditionZeroObserved: boolean; explicitRuinInModel: false;
  brokenCrossings: number; zeroCrossings: number; stockFoodFinal: number; stockWaterFinal: number;
}
export interface MaterialStructureRow {
  id: string; x: number; y: number; blueprintId: string; components: StructureComponent[]; builtAt: number; builderId: string | null;
  firstObservedTick: number; constructionSeen: boolean; historyCoverage: 'full-since-built' | 'left-censored';
  conditionInitial: number; conditionFinal: number; conditionMinimum: number;
  brokenObserved: boolean; conditionZeroObserved: boolean; explicitRuinInModel: false;
  brokenCrossings: number; zeroCrossings: number; activeExposureTicks: number; wearEvaluations: number;
  repairCount: number; repairWoodPaid: number; repairWorkPaid: number; stockFoodFinal: number; stockWaterFinal: number;
  salvagePotential: { basis: 'nominal-blueprint-cost-upper-bound'; wood: number | null; stone: number | null; work: number | null;
    originalPaidCost: Cost | null; recoveryImplemented: false };
}
export interface MaterialObserverExport {
  version: 1;
  coverage: { startTick: number | null; endTick: number | null; historyBeforeStart: 'unobserved'; unseenArchivedStructures: 'unknown';
    scope: 'resident-and-pending-chunks-plus-observed-activation';
    mutationScope: 'existing-engine-hooks; direct-material-edits-unobserved';
    observationGaps: { fromTick: number; toTick: number }[];
    attachments: { startTick: number; reason: 'initial' | 'loaded-world'; residentStructures: number; pendingDormantStructures: number }[] };
  structures: MaterialStructureRow[]; daily: MaterialDailyRow[];
}
interface Interval { from: number; to: number | null }
interface InternalDay { row: MaterialDailyRow; users: Record<UserClass, Set<string>> }
interface Entry { row: MaterialStructureRow; days: Map<number, InternalDay>; intervals: Interval[] }
const kinds = (): Record<UseKind, number> => ({ food: 0, water: 0, rest: 0 });
const classes = (): Record<UserClass, number> => ({ mortal: 0, protected: 0, unknown: 0 });
function emptyDay(id: string, day: number, state: State): MaterialDailyRow {
  return { structureId: id, day, startTick: (day - 1) * DAY, endTick: day * DAY,
    observedStartTick: 0, observedEndTick: 0, partial: true, observedTicks: 0, hasObservationGap: false,
    exposureTicks: 0, wearEvaluations: 0, activationCount: 0, retirementCount: 0,
    uses: kinds(), useCountsByClass: classes(), usersByClass: { mortal: [], protected: [], unknown: [] }, benefitByKind: kinds(), amountByKind: kinds(),
    repairCount: 0, repairWoodPaid: 0, repairWorkPaid: 0, conditionInitial: state.condition, conditionFinal: state.condition,
    conditionMinimum: state.condition, brokenObserved: state.condition <= BROKEN_CONDITION, conditionZeroObserved: state.condition === 0,
    explicitRuinInModel: false, brokenCrossings: 0, zeroCrossings: 0, stockFoodFinal: state.food, stockWaterFinal: state.water };
}
function nominalCost(components: readonly StructureComponent[]): Cost | null {
  return components.length > 0 && components.every(c => COMPONENTS.includes(c)) ? blueprintCost(components) : null;
}

export interface MaterialObserver {
  /** Attach or explicitly confirm this world. Reattaching a loaded world marks a new observation interval. */
  ingest(world: World): void;
  /** Forget an abandoned candidate without changing confirmed measurements. */
  discard(world: World): void;
  /** Independent copies: exporting neither drains events nor mutates the measured world. */
  exportRows(): MaterialObserverExport;
  /** Despertares DESG-D (rama de laboratorio): ancla y proyección por separado (crítica a.4). */
  exportDesgaste(): { version: 1; activaciones: DesgasteActivation[] };
}

/** Un despertar con ley=1: condición observada al volver + ancla + horizonte + proyección. */
export interface DesgasteActivation {
  structureId: string; tick: number; conditionAlDespertar: number; dormidaTicksPrevios: number;
  N: number; R: number; ancla: AnclaDesgaste | null; proyectada: number | null;
}

export function createMaterialObserver(): MaterialObserver {
  const entries = new Map<string, Entry>();
  const coverage: MaterialObserverExport['coverage'] = { startTick: null, endTick: null, historyBeforeStart: 'unobserved', unseenArchivedStructures: 'unknown',
    scope: 'resident-and-pending-chunks-plus-observed-activation', mutationScope: 'existing-engine-hooks; direct-material-edits-unobserved',
    observationGaps: [], attachments: [] };
  const activaciones: DesgasteActivation[] = [];
  let committed: Link = { event: null, previous: null };
  let confirmedTick: number | null = null;
  let seed: number | null = null;

  function ensure(identity: Identity, tick: number, active: boolean, paid?: Cost): Entry {
    let entry = entries.get(identity.id);
    if (!entry) {
      const nominal = nominalCost(identity.components);
      entry = { row: { id: identity.id, x: identity.x, y: identity.y, blueprintId: identity.blueprintId, components: [...identity.components],
        builtAt: identity.builtAt, builderId: identity.builderId, firstObservedTick: tick, constructionSeen: !!paid,
        historyCoverage: paid ? 'full-since-built' : 'left-censored', conditionInitial: identity.condition, conditionFinal: identity.condition,
        conditionMinimum: identity.condition, brokenObserved: identity.condition <= BROKEN_CONDITION, conditionZeroObserved: identity.condition === 0,
        explicitRuinInModel: false, brokenCrossings: 0, zeroCrossings: 0, activeExposureTicks: 0, wearEvaluations: 0,
        repairCount: 0, repairWoodPaid: 0, repairWorkPaid: 0, stockFoodFinal: identity.food, stockWaterFinal: identity.water,
        salvagePotential: { basis: 'nominal-blueprint-cost-upper-bound', wood: nominal?.wood ?? null, stone: nominal?.stone ?? null,
          work: nominal?.work ?? null, originalPaidCost: paid ? { ...paid } : null, recoveryImplemented: false } }, days: new Map(), intervals: [] };
      entries.set(identity.id, entry);
      daily(entry, tick, identity);
    }
    if (active && entry.intervals.at(-1)?.to !== null) entry.intervals.push({ from: tick, to: null });
    return entry;
  }
  function daily(entry: Entry, tick: number, state: State): InternalDay {
    const day = dayOf(tick);
    let result = entry.days.get(day);
    if (!result) {
      result = { row: emptyDay(entry.row.id, day, state), users: { mortal: new Set(), protected: new Set(), unknown: new Set() } };
      entry.days.set(day, result);
    }
    return result;
  }
  function observeCondition(row: Pick<MaterialStructureRow, 'conditionFinal' | 'conditionMinimum' | 'brokenObserved' | 'conditionZeroObserved' | 'brokenCrossings' | 'zeroCrossings'>,
    before: number, after: number, countCrossing: boolean): void {
    row.conditionFinal = after; row.conditionMinimum = Math.min(row.conditionMinimum, before, after);
    row.brokenObserved ||= before <= BROKEN_CONDITION || after <= BROKEN_CONDITION;
    row.conditionZeroObserved ||= before === 0 || after === 0;
    if (countCrossing && before > BROKEN_CONDITION && after <= BROKEN_CONDITION) row.brokenCrossings++;
    if (countCrossing && before > 0 && after === 0) row.zeroCrossings++;
  }
  function apply(event: Event): void {
    let entry = entries.get(event.state.id);
    if ('identity' in event) entry = ensure(event.identity, event.tick, event.kind !== 'retired', event.paid);
    // A hook without a prior observed identity is outside this attachment's coverage.
    if (!entry) return;
    const before = 'before' in event ? event.before : entry.row.conditionFinal;
    const day = daily(entry, event.tick, { ...event.state, condition: before }), row = day.row;
    observeCondition(entry.row, before, event.state.condition, 'before' in event);
    observeCondition(row, before, event.state.condition, 'before' in event);
    entry.row.stockFoodFinal = row.stockFoodFinal = event.state.food;
    entry.row.stockWaterFinal = row.stockWaterFinal = event.state.water;
    if (event.kind === 'retired') { const open = entry.intervals.at(-1); if (open?.to === null) open.to = event.tick; row.retirementCount++; }
    if (event.kind === 'activated') row.activationCount++;
    if (event.kind === 'activated' && event.desgaste) {
      const previa = entry.intervals.length >= 2 ? entry.intervals[entry.intervals.length - 2] : undefined;
      const finPrevio = previa?.to;
      activaciones.push({ structureId: entry.row.id, tick: event.tick, conditionAlDespertar: event.state.condition,
        dormidaTicksPrevios: typeof finPrevio === 'number' ? event.tick - finPrevio : 0,
        N: event.desgaste.N, R: event.desgaste.R, ancla: event.desgaste.ancla, proyectada: event.desgaste.proyectada });
    }
    if (event.kind === 'wear') { row.wearEvaluations++; entry.row.wearEvaluations++; }
    if (event.kind === 'repair') {
      row.repairCount++; entry.row.repairCount++;
      row.repairWoodPaid += event.wood; entry.row.repairWoodPaid += event.wood;
      row.repairWorkPaid += event.work; entry.row.repairWorkPaid += event.work;
    }
    if (event.kind === 'use') {
      row.uses[event.use]++; row.useCountsByClass[event.userClass]++;
      row.benefitByKind[event.use] += event.benefit; row.amountByKind[event.use] += event.amount;
      if (event.personId !== null) day.users[event.userClass].add(event.personId);
    }
  }
  function attach(world: World): void {
    if (seed !== null && world.seed !== seed) throw new Error('Material observer cannot join different world seeds.');
    if (confirmedTick !== null && world.tick < confirmedTick) throw new Error('Material observer cannot attach a world older than its confirmed tick.');
    // A load closes observed activity; no exposure or history is invented across the gap.
    for (const entry of entries.values()) { const open = entry.intervals.at(-1); if (open?.to === null) open.to = confirmedTick!; }
    if (confirmedTick !== null && world.tick > confirmedTick) coverage.observationGaps.push({ fromTick: confirmedTick, toTick: world.tick });
    seed = world.seed;
    coverage.startTick ??= world.tick;
    coverage.attachments.push({ startTick: world.tick, reason: confirmedTick === null ? 'initial' : 'loaded-world',
      residentStructures: world.structures.length, pendingDormantStructures: world.retiredChunks.reduce((n, c) => n + (c.structures?.length ?? 0), 0) });
    for (const structure of world.structures) { const identity = identityOf(structure); ensure(identity, world.tick, true); apply({ kind: 'stock', tick: world.tick, state: identity, desgaste: etiquetaDesgaste(world, structure) }); }
    for (const chunk of world.retiredChunks) for (const structure of chunk.structures ?? []) {
      const identity = identityOf(structure); ensure(identity, world.tick, false); apply({ kind: 'stock', tick: world.tick, state: identity, desgaste: etiquetaDesgaste(world, structure) });
    }
    committed = { event: null, previous: null };
    captures.set(world, { observer, tail: committed, confirmations: 0 });
  }
  const observer: MaterialObserver = {
    ingest(world) {
      const capture = captures.get(world);
      if (capture?.observer === observer && capture.discarded) throw new Error('Material observer cannot confirm a discarded candidate.');
      if (!capture || capture.observer !== observer) attach(world);
      else {
        if (confirmedTick !== null && world.tick < confirmedTick) throw new Error('Material observer cannot confirm a world older than its confirmed tick.');
        const events: Event[] = [];
        let cursor: Link | null = capture.tail;
        while (cursor !== committed) {
          if (!cursor) throw new Error('Material observer candidate diverged from the confirmed world.');
          if (cursor.event) events.push(cursor.event);
          cursor = cursor.previous;
        }
        for (let i = events.length - 1; i >= 0; i--) apply(events[i]!);
        // Drop the consumed chain. Captures are weak and never hold a World/structure reference.
        committed = { event: null, previous: null }; capture.tail = committed; capture.confirmations++;
      }
      confirmedTick = coverage.endTick = world.tick;
    },
    discard(world) {
      const capture = captures.get(world);
      if (capture?.observer === observer) { capture.discarded = true; capture.tail = { event: null, previous: null }; }
    },
    exportRows() {
      const structures: MaterialStructureRow[] = [], dailyRows: MaterialDailyRow[] = [];
      const until = coverage.endTick;
      if (until !== null) for (const entry of entries.values()) {
        let previous: State = { id: entry.row.id, condition: entry.row.conditionInitial,
          water: entry.days.values().next().value!.row.stockWaterFinal, food: entry.days.values().next().value!.row.stockFoodFinal };
        let totalExposure = 0;
        const exposure = new Map<number, number>();
        for (const interval of entry.intervals) {
          const end = Math.min(interval.to ?? until, until);
          for (let from = interval.from; from < end;) {
            const day = Math.floor(from / DAY) + 1, to = Math.min(end, day * DAY), ticks = to - from;
            exposure.set(day, (exposure.get(day) ?? 0) + ticks); totalExposure += ticks; from = to;
          }
        }
        for (let day = dayOf(entry.row.firstObservedTick); day <= dayOf(until); day++) {
          const observed = entry.days.get(day), row = observed ? structuredClone(observed.row) : emptyDay(entry.row.id, day, previous);
          row.observedStartTick = Math.max(row.startTick, entry.row.firstObservedTick);
          row.observedEndTick = Math.min(row.endTick, until);
          row.partial = row.observedStartTick !== row.startTick || row.observedEndTick !== row.endTick;
          row.observedTicks = Math.max(0, row.observedEndTick - row.observedStartTick);
          for (const gap of coverage.observationGaps) {
            const missing = Math.max(0, Math.min(row.observedEndTick, gap.toTick) - Math.max(row.observedStartTick, gap.fromTick));
            if (missing > 0) { row.observedTicks -= missing; row.hasObservationGap = row.partial = true; }
          }
          row.exposureTicks = exposure.get(day) ?? 0;
          if (observed) for (const userClass of ['mortal', 'protected', 'unknown'] as const) row.usersByClass[userClass] = [...observed.users[userClass]].sort();
          previous = { id: entry.row.id, condition: row.conditionFinal, water: row.stockWaterFinal, food: row.stockFoodFinal };
          dailyRows.push(row);
        }
        const row = structuredClone(entry.row); row.activeExposureTicks = totalExposure; structures.push(row);
      }
      return { version: 1, coverage: structuredClone(coverage), structures, daily: dailyRows };
    },
    exportDesgaste() {
      return { version: 1, activaciones: activaciones.map(a => ({ ...a, ancla: a.ancla ? { ...a.ancla } : null })) };
    },
  };
  return observer;
}
