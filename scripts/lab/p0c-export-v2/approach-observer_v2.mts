import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { DAY_SCHEMA, EXPORT_EPOCH, TRIP_SCHEMA, type ApproachDay, type BoundaryState, type TripTiming } from './schema_v2.mts';
/** Goal11B: external, scalar-only observer. No engine imports and no writes to World. */
type Point = { x: number; y: number };
type PersonLike = Point & { id: string; role: string; action: string; reason: string;
  decisionAt: number; target: Point; communityId: string | null; inventory: number;
  hunger: number; thirst: number; fatigue: number; energy: number;
  genome: { parents: string[] }; bonds: Record<string, number> };
export type WorldLike = { tick: number; people: PersonLike[]; places: (Point & { id: string })[] };
type Kind = 'familia' | 'hogar';
type EventLike = { x?: number; y?: number; id: string; tick: number; kind: string; actors: string[]; source?: string };
type Decision = { tick: number; actor: Body; action: string; reason: string; decisionAt: number;
  target: Point; partner?: Body; placeId: string | null };
type Body = Point & { id: string; role: string; communityId: string | null; inventory: number;
  hunger: number; thirst: number; fatigue: number; energy: number; parents: string[] };
type ShareBefore = { tick: number; donor: Body; recipient: Body; placeId: string };
type Share = ShareBefore & { eventId: string; amount: number; hungerRelief: number;
  energyGain: number; closeKin: boolean; coParent: boolean; effective: boolean };
export type Trip = TripTiming & {
  id: number; actorId: string; kind: Kind; reason: string; startTick: number;
  endTick: number | null; closure: string | null; censored: boolean; attributionCensored: boolean;
  censorTick: number | null; censorReason: string | null;
  actorCommunityStart: string | null; actorCommunityLast: string | null;
  partnerId: string | null; partnerCommunityStart: string | null; partnerCloseKinStart: boolean | null;
  partnerCoParentStart: boolean | null; target: Point; placeId: string | null;
  decisionAtStart: number; reserveStart: number; reserveEnd: number; partnerReserveEnd: number | null;
  pairReserveReadyTicks: number; startDistance: number; endDistance: number;
  minDistance: number; partnerStartDistance: number | null; partnerEndDistance: number | null;
  ticks: number; movedTicks: number; pathMoved: number; stationaryAwayTicks: number;
  stationaryAwayMovementOpportunities: number; alreadyAtDestinationTicks: number;
  waitingAtDestinationTicks: number; arrivalTick: number | null; visits: number; partnerNearTicks: number;
  sameDestinationPrevious: boolean; repeatedRun: number; repeatedWithoutObservedOutcome: boolean; loopWithoutObservedEffect: boolean;
  food: Share[]; foodContext: Share[]; births: string[]; birthContext: string[];
  cooperationEvents: string[]; partnerBondGain: number; bodyRelief: number;
  outcomeWindowEnd: number | null;
};
const hypot = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const kindOf = (action: string, reason: string): Kind | null => action !== 'approach' ? null
  : reason.startsWith('Tiene reservas') ? 'familia'
    : reason.startsWith('Vuelve a un lugar conocido') ? 'hogar' : null;
const kin = (a: Body, b: Body) => a.parents.includes(b.id) || b.parents.includes(a.id)
  || (a.parents.length > 0 && b.parents.length > 0 && a.parents.some(id => b.parents.includes(id)));
const coParent = (world: WorldLike, a: string, b: string) => world.people.some(p => p.genome.parents.includes(a) && p.genome.parents.includes(b));
const body = (p: PersonLike): Body => ({ id: p.id, role: p.role, x: p.x, y: p.y,
  communityId: p.communityId, inventory: p.inventory, hunger: p.hunger, thirst: p.thirst,
  fatigue: p.fatigue, energy: p.energy, parents: [...p.genome.parents] });
const signature = (t: Trip) => JSON.stringify([t.kind, t.target.x, t.target.y, t.partnerId, t.placeId]);
const bindings = new WeakMap<object, ApproachObserver>();
export const APPROACH_PROTOCOL = Object.freeze({ version: 1, ticksPerDay: 2400, arrivalRadius: 0.5,
  outcomeWindowAfterClose: 30, repeatedRunMinimum: 3, movementClock: 6,
  familyAttribution: 'exact selected partner id; reached frozen target; both actors within 2 of frozen target; latest matching trip only',
  homeAttribution: 'exact frozen place id plus both actors within 2 of frozen target; reached; latest matching trip only',
  window: 'event tick >= arrivalTick and <= endTick+30; active trips eligible; one share assigned once',
  noEffect: 'three consecutive uncensored mature trips to exact same destination with arrival/at-destination wait, no recorded food/context, birth/context, cooperation, positive partner bond gain, positive body relief, or observed family pair reserve readiness; broader repetition-without-outcome separate',
  causalLimit: 'temporal/spatial association, not counterfactual causation; context is not strict success' });

export function attachApproachObserver(world: object, observer: ApproachObserver): void {
  const previous = bindings.get(world);
  if (previous && previous !== observer) throw new Error('World already has a different approach observer');
  bindings.set(world, observer);
}
export function detachApproachObserver(world: object): void { bindings.delete(world); }
export function captureApproachDecision(world: WorldLike, p: PersonLike,
  selection: { partner?: PersonLike; placeId?: string }): void {
  const observer = bindings.get(world); if (!observer) return;
  const atTarget = world.places.filter(place => place.x === p.target.x && place.y === p.target.y).map(place => place.id).sort();
  observer.recordDecision({ tick: world.tick, actor: body(p), action: p.action, reason: p.reason,
    decisionAt: p.decisionAt, target: { ...p.target }, partner: selection.partner && body(selection.partner),
    placeId: selection.placeId ?? (atTarget.length === 1 ? atTarget[0] : null) });
}
export function captureApproachEvent(world: WorldLike, event: EventLike): void {
  if (event.source !== 'simulation' || !['birth', 'death', 'cooperation'].includes(event.kind)) return;
  bindings.get(world)?.recordEvent({ id: event.id, tick: event.tick, kind: event.kind,
    source: event.source, x: event.x, y: event.y, actors: [...event.actors] });
}
export function captureApproachShareBefore(world: WorldLike, donor: PersonLike, recipient: PersonLike,
  place: { id: string }): ShareBefore | undefined {
  if (!bindings.has(world)) return;
  return { tick: world.tick, donor: body(donor), recipient: body(recipient), placeId: place.id };
}
export function captureApproachEffectiveShare(world: WorldLike, donor: PersonLike, recipient: PersonLike,
  _place: { id: string }, event: { id: string }, before: ShareBefore | undefined): void {
  if (!before) return;
  const amount = before.donor.inventory - donor.inventory;
  const hungerRelief = before.recipient.hunger - recipient.hunger;
  bindings.get(world)?.recordShare({ ...before, eventId: event.id, amount, hungerRelief,
    energyGain: recipient.energy - before.recipient.energy,
    closeKin: kin(before.donor, before.recipient), coParent: coParent(world, donor.id, recipient.id),
    effective: amount > 0 && before.recipient.hunger > 0.27 && hungerRelief > 0 });
}

export class ApproachObserver {
  private tick = -1;
  private expected = -1;
  private finished = false;
  private serial = 0;
  private before = new Map<string, Body>();
  private bondsBefore = new Map<number, number>();
  private decisions: Decision[] = [];
  private shares: Share[] = [];
  private events: EventLike[] = [];
  private active = new Map<string, Trip>();
  private pending: Trip[] = [];
  private outbox: Trip[] = [];
  private previousClosed = new Map<string, string>();
  private previousMature = new Map<string, { signature: string; run: number; conservativeRun: number }>();
  private days = new Map<number, Record<string, number>>();
  private seenEvents = new Set<string>();
  private sealedDays = new Set<number>();
  constructor(readonly ticksPerDay: number = APPROACH_PROTOCOL.ticksPerDay) {
    if (!Number.isSafeInteger(ticksPerDay) || ticksPerDay < 1) throw new Error('Invalid ticksPerDay');
    for (let day = 1; day <= 60; day++) this.days.set(day, {
      'familia.closed': 0, 'hogar.closed': 0, 'familia.matured': 0, 'hogar.matured': 0,
    });
  }
  private day(tick: number) { return Math.max(1, Math.ceil(tick / this.ticksPerDay)); }
  /** Also used before changing a trip, so a rejected late closure cannot partially mutate it. */
  assertCountWritable(tick: number): void {
    if (this.sealedDays.has(this.day(tick))) throw new Error(`Approach day ${this.day(tick)} is sealed`);
  }
  private count(tick: number, key: string, n = 1) {
    this.assertCountWritable(tick);
    const day = this.day(tick), row = this.days.get(day) ?? {};
    row[key] = (row[key] ?? 0) + n; this.days.set(day, row);
  }
  beginTick(world: WorldLike): void {
    if (this.finished || this.expected !== -1) throw new Error('Unclosed/finalized approach tick');
    if (this.tick !== -1 && world.tick !== this.tick) throw new Error('Approach observation gap');
    this.expected = world.tick + 1; this.before = new Map(world.people.map(p => [p.id, body(p)]));
    this.bondsBefore.clear();
    const byId = new Map(world.people.map(p => [p.id, p]));
    for (const t of [...this.pending, ...this.active.values()]) if (t.partnerId) {
      const p = byId.get(t.actorId); if (p) this.bondsBefore.set(t.id, p.bonds[t.partnerId] ?? 0);
    }
  }
  recordDecision(event: Decision): void { this.checkHook(event.tick); this.decisions.push(event); }
  recordShare(event: Share): void { this.checkHook(event.tick); this.shares.push(event); }
  recordEvent(event: EventLike): void { this.checkHook(event.tick); this.events.push(event); }
  private checkHook(tick: number) { if (this.expected !== tick) throw new Error('Hook outside begin/end tick'); }
  discardTick(): void {
    this.expected = -1; this.before.clear(); this.bondsBefore.clear();
    this.decisions = []; this.events = []; this.shares = [];
  }
  private censor(t: Trip, tick: number, reason: string, attribution = false) {
    if (!t.censored) this.count(tick, `${t.kind}.censored`);
    t.censored = true; t.attributionCensored ||= attribution;
    if (t.censorTick === null) { t.censorTick = tick; t.censorReason = reason; }
  }
  private close(t: Trip, tick: number, reason: string, censored = false, censorTick = tick) {
    if (t.endTick !== null) return;
    this.assertCountWritable(Math.max(1, tick));
    t.closedProcessingTick = this.expected === -1 ? this.tick : this.expected;
    t.endTick = Math.max(t.startTick - 1, tick); t.closure = reason;
    t.outcomeWindowEnd = t.endTick + APPROACH_PROTOCOL.outcomeWindowAfterClose;
    const sig = signature(t); t.sameDestinationPrevious = this.previousClosed.get(t.actorId) === sig;
    this.previousClosed.set(t.actorId, sig);
    this.active.delete(t.actorId); this.pending.push(t);
    this.count(Math.max(1, tick), `${t.kind}.closed`);
    if (censored) this.censor(t, censorTick, reason);
  }
  private start(d: Decision, world: WorldLike): void {
    const kind = kindOf(d.action, d.reason); if (!kind || d.actor.role !== 'neighbor') return;
    const dist = hypot(d.actor, d.target), id = ++this.serial;
    const t: Trip = { schema: TRIP_SCHEMA, epoch: EXPORT_EPOCH, version: 2,
      closedProcessingTick: null, maturedProcessingTick: null, emittedAtTick: null, id, actorId: d.actor.id, kind, reason: d.reason, startTick: d.tick,
      endTick: null, closure: null, censored: false, attributionCensored: false, censorTick: null, censorReason: null,
      actorCommunityStart: d.actor.communityId, actorCommunityLast: d.actor.communityId,
      partnerId: d.partner?.id ?? null, partnerCommunityStart: d.partner?.communityId ?? null,
      partnerCloseKinStart: d.partner ? kin(d.actor, d.partner) : null,
      partnerCoParentStart: d.partner ? coParent(world, d.actor.id, d.partner.id) : null,
      target: { ...d.target }, placeId: d.placeId, decisionAtStart: d.decisionAt,
      reserveStart: d.actor.inventory, reserveEnd: d.actor.inventory, partnerReserveEnd: d.partner?.inventory ?? null,
      pairReserveReadyTicks: 0, startDistance: dist, endDistance: dist, minDistance: dist,
      partnerStartDistance: d.partner ? hypot(d.actor, d.partner) : null,
      partnerEndDistance: d.partner ? hypot(d.actor, d.partner) : null,
      ticks: 0, movedTicks: 0, pathMoved: 0, stationaryAwayTicks: 0,
      stationaryAwayMovementOpportunities: 0, alreadyAtDestinationTicks: 0,
      waitingAtDestinationTicks: 0, arrivalTick: dist < 0.5 ? d.tick : null, visits: dist < 0.5 ? 1 : 0, partnerNearTicks: 0,
      sameDestinationPrevious: false, repeatedRun: 0, repeatedWithoutObservedOutcome: false, loopWithoutObservedEffect: false,
      food: [], foodContext: [], births: [], birthContext: [], cooperationEvents: [],
      partnerBondGain: 0, bodyRelief: 0, outcomeWindowEnd: null };
    this.active.set(d.actor.id, t); this.count(d.tick, `${kind}.started`);
    if (kind === 'familia' && !d.partner) this.count(d.tick, 'missingOriginalPartnerHook');
    if (d.partner) this.bondsBefore.set(id, world.people.find(p => p.id === d.actor.id)?.bonds[d.partner.id] ?? 0);
  }
  private eligible(t: Trip, actorId: string, tick: number): boolean {
    return t.actorId === actorId && t.arrivalTick !== null && t.arrivalTick <= tick
      && (t.censorTick === null || tick < t.censorTick)
      && (t.endTick === null || tick <= t.endTick + 30);
  }
  private latest(actorId: string, tick: number, predicate: (t: Trip) => boolean = () => true): Trip | undefined {
    return [...this.pending, ...this.active.values()].filter(t => this.eligible(t, actorId, tick) && predicate(t))
      .sort((a, b) => b.startTick - a.startTick || b.id - a.id)[0];
  }
  endTick(world: WorldLike): void {
    if (world.tick !== this.expected) throw new Error('Incorrect approach post-step tick');
    const tick = world.tick, people = new Map(world.people.map(p => [p.id, p]));
    for (const d of this.decisions) {
      const old = this.active.get(d.actor.id);
      if (old) this.close(old, tick - 1, d.action !== 'approach' ? 'actionChanged'
        : kindOf(d.action, d.reason) !== old.kind ? 'motiveChanged'
          : hypot(d.target, old.target) > 0 || (d.partner?.id ?? null) !== old.partnerId ? 'targetChanged' : 'reselected');
      this.start(d, world);
    }
    for (const t of [...this.active.values()]) {
      const p = people.get(t.actorId);
      if (!p) { this.close(t, tick - 1, this.events.some(e => e.kind === 'death' && e.actors.includes(t.actorId))
        ? 'actorDeath' : 'actorMissing', true, tick); continue; }
      if (kindOf(p.action, p.reason) !== t.kind || hypot(p.target, t.target) > 0) {
        this.close(t, tick - 1, 'actionOrTargetChangedWithoutSelection'); continue;
      }
      let pre: Body | undefined;
      for (let i = this.decisions.length - 1; i >= 0; i--) {
        const decision = this.decisions[i]!;
        if (decision.actor.id === t.actorId) { pre = decision.actor; break; }
      }
      pre ??= this.before.get(p.id);
      if (!pre) throw new Error('Trip actor missing pre-step state');
      const preDist = hypot(pre, t.target), postDist = hypot(p, t.target), moved = hypot(pre, p);
      t.ticks++; t.pathMoved += moved; t.endDistance = postDist; t.minDistance = Math.min(t.minDistance, postDist);
      t.actorCommunityLast = p.communityId; t.reserveEnd = p.inventory;
      if (moved > 0) t.movedTicks++;
      if (preDist < 0.5) t.alreadyAtDestinationTicks++;
      if (preDist < 0.5 && postDist < 0.5 && moved === 0) t.waitingAtDestinationTicks++;
      if (preDist >= 0.5 && moved === 0) {
        t.stationaryAwayTicks++; if (tick % 6 === 0) t.stationaryAwayMovementOpportunities++;
      }
      if (postDist < 0.5 && preDist >= 0.5) { t.visits++; if (t.arrivalTick === null) t.arrivalTick = tick; }
      const partner = t.partnerId && people.get(t.partnerId);
      if (partner) {
        t.partnerEndDistance = hypot(p, partner); t.partnerReserveEnd = partner.inventory;
        if (t.partnerEndDistance <= 2) t.partnerNearTicks++;
        // These stocks show potential, not readiness/cupo availability or an actual birth.
        if (t.kind === 'familia' && p.inventory >= 0.12 && partner.inventory >= 0.1) t.pairReserveReadyTicks++;
      }
      this.count(tick, `${t.kind}.tripTicks`);
    }
    for (const p of world.people) if (p.role === 'neighbor') {
      const kind = kindOf(p.action, p.reason); if (!kind) continue;
      this.count(tick, `${kind}.approachTicks`);
      if (!this.active.has(p.id)) this.count(tick, `${kind}.unattributedApproachTicks`);
    }
    // Censor pending follow-up before accepting outcomes; absence also covers missing death hooks.
    // A decision closure stays unchanged; the separate reason/tick names follow-up censoring.
    const deadIds = new Set(this.events.filter(e => e.kind === 'death').flatMap(e => e.actors));
    for (const t of [...this.active.values(), ...this.pending]) {
      const actorDead = deadIds.has(t.actorId), partnerDead = t.partnerId !== null && deadIds.has(t.partnerId);
      const actorMissing = !people.has(t.actorId), partnerMissing = t.partnerId !== null && !people.has(t.partnerId);
      if (!(actorDead || partnerDead || actorMissing || partnerMissing)) continue;
      const reason = actorDead ? 'actorDeath' : actorMissing ? 'actorMissing'
        : partnerDead ? 'selectedPartnerDeath' : 'selectedPartnerMissing';
      if (t.endTick === null) this.close(t, tick, reason, true, tick);
      else this.censor(t, tick, reason, true);
    }
    // Positive changes are context signals, never a proof the approach caused them.
    for (const p of world.people) {
      const pre = this.before.get(p.id), t = this.latest(p.id, tick); if (!pre || !t) continue;
      t.bodyRelief += Math.max(0, pre.hunger - p.hunger) + Math.max(0, pre.thirst - p.thirst)
        + Math.max(0, pre.fatigue - p.fatigue) + Math.max(0, p.energy - pre.energy);
    }
    for (const t of [...this.pending, ...this.active.values()]) if (t.partnerId && this.eligible(t, t.actorId, tick)) {
      const p = people.get(t.actorId), prior = this.bondsBefore.get(t.id);
      if (p && prior !== undefined) t.partnerBondGain += Math.max(0, (p.bonds[t.partnerId] ?? 0) - prior);
    }
    for (const s of this.shares) {
      if (this.seenEvents.has(s.eventId)) throw new Error('Duplicate share hook'); this.seenEvents.add(s.eventId);
      this.count(tick, 'effectiveShareEvents', Number(s.effective));
      const context = this.latest(s.donor.id, tick);
      if (context) context.foodContext.push(s);
      if (!s.effective) continue;
      const strict = this.latest(s.donor.id, tick, t => t.kind === 'familia'
        ? t.partnerId === s.recipient.id && hypot(s.donor, t.target) <= 2 && hypot(s.recipient, t.target) <= 2
        : t.placeId !== null && t.placeId === s.placeId && hypot(s.donor, t.target) <= 2 && hypot(s.recipient, t.target) <= 2);
      if (strict) { strict.food.push(s); this.count(tick, `${strict.kind}.strictFoodEvents`); }
    }
    for (const e of this.events) {
      if (this.seenEvents.has(e.id)) throw new Error('Duplicate event hook'); this.seenEvents.add(e.id);
      if (e.kind === 'birth') {
        this.count(tick, 'birthEvents');
        for (const actorId of e.actors.slice(0, 2)) {
          const t = this.latest(actorId, tick); if (t) t.birthContext.push(e.id);
          const exact = this.latest(actorId, tick, row => row.kind === 'familia'
            && row.partnerId !== null && e.actors.slice(0, 2).includes(row.partnerId));
          if (exact) exact.births.push(e.id);
        }
      } else if (e.kind === 'cooperation') {
        for (const actorId of e.actors) { const t = this.latest(actorId, tick); if (t) t.cooperationEvents.push(e.id); }
      }
    }
    for (const t of [...this.pending]) if (t.outcomeWindowEnd! <= tick) this.mature(t, tick);
    this.tick = tick; this.discardTick();
  }
  private mature(t: Trip, tick: number): void {
    this.assertCountWritable(tick);
    t.maturedProcessingTick = tick;
    const eligible = !t.censored && !t.attributionCensored;
    const effects = t.foodContext.some(s => s.effective) || t.food.length > 0 || t.birthContext.length > 0
      || t.births.length > 0 || t.cooperationEvents.length > 0 || t.partnerBondGain > 0 || t.bodyRelief > 0;
    const sig = signature(t), last = this.previousMature.get(t.actorId);
    const noEffect = eligible && t.arrivalTick !== null && (t.alreadyAtDestinationTicks > 0 || t.waitingAtDestinationTicks > 0)
      && !effects;
    t.repeatedRun = noEffect ? (last?.signature === sig ? last.run + 1 : 1) : 0;
    t.repeatedWithoutObservedOutcome = t.repeatedRun >= 3;
    const conservativeRun = noEffect && t.pairReserveReadyTicks === 0
      ? (last?.signature === sig ? last.conservativeRun + 1 : 1) : 0;
    t.loopWithoutObservedEffect = conservativeRun >= 3;
    this.previousMature.set(t.actorId, { signature: sig, run: t.repeatedRun, conservativeRun });
    this.count(tick, `${t.kind}.matured`);
    this.count(tick, `${t.kind}.sumTripTicks`, t.ticks);
    this.count(tick, `${t.kind}.sumPathMoved`, t.pathMoved);
    this.count(tick, `${t.kind}.sumAlreadyAtDestinationTicks`, t.alreadyAtDestinationTicks);
    this.count(tick, `${t.kind}.sumWaitingAtDestinationTicks`, t.waitingAtDestinationTicks);
    this.count(tick, `${t.kind}.targetPlaceEntries`, t.placeId ? t.visits : 0);
    if (eligible) {
      this.count(tick, `${t.kind}.uncensoredMatured`);
      this.count(tick, `${t.kind}.strictFoodSuccess`, Number(t.food.length > 0));
      this.count(tick, `${t.kind}.strictKinFoodSuccess`, Number(t.food.some(s => s.closeKin)));
      this.count(tick, `${t.kind}.contextAnyFoodSuccess`, Number(t.foodContext.some(s => s.effective)));
      this.count(tick, `${t.kind}.contextKinFoodSuccess`, Number(t.foodContext.some(s => s.effective && s.closeKin)));
      this.count(tick, `${t.kind}.destinationKinFoodSuccess`, Number(t.foodContext.some(s => s.effective && s.closeKin
        && hypot(s.donor, t.target) <= 2 && hypot(s.recipient, t.target) <= 2 && (t.placeId === null || s.placeId === t.placeId))));
      this.count(tick, `${t.kind}.chosenPairBirthSuccess`, Number(t.births.length > 0));
      this.count(tick, `${t.kind}.loopWithoutObservedEffect`, Number(t.loopWithoutObservedEffect));
      this.count(tick, `${t.kind}.repeatedWithoutObservedOutcome`, Number(t.repeatedWithoutObservedOutcome));
      this.count(tick, `${t.kind}.pairReserveReadyTicks`, t.pairReserveReadyTicks);
    }
    this.outbox.push(structuredClone(t)); this.pending = this.pending.filter(row => row !== t);
  }
  exportDay(day: number): ApproachDay {
    const stats = { ...(this.days.get(day) ?? {}) };
    return { schema: DAY_SCHEMA, epoch: EXPORT_EPOCH, version: 2, day, ticksPerDay: this.ticksPerDay, stats,
      pendingTrips: this.pending.length, activeTrips: this.active.size,
      denominators: { tripTickCoverage: 'tripTicks / approachTicks',
        foodSuccess: 'strictFoodSuccess / uncensoredMatured; assigned to maturation day',
        kinFoodSuccess: 'strictKinFoodSuccess / uncensoredMatured',
        literalKinContext: 'contextKinFoodSuccess / uncensoredMatured; latest reached trip, temporal association only',
        literalKinAtDestination: 'destinationKinFoodSuccess / uncensoredMatured; context plus exact frozen location/place match',
        selectedPairBirth: 'chosenPairBirthSuccess / uncensoredMatured; event can associate two parent trips, not two births' },
      protocol: APPROACH_PROTOCOL };
  }
  boundaryState(day: number): BoundaryState {
    if (this.expected !== -1 || this.tick !== day * this.ticksPerDay || this.finished)
      throw new Error('Boundary state must be captured after endTick at N, before finish');
    const row = this.exportDay(day);
    return { stats: row.stats, activeTrips: row.activeTrips, pendingTrips: row.pendingTrips };
  }
  sealDay(day: number, final: boolean): void {
    if (!Number.isSafeInteger(day) || day < 1 || day > 60 || this.sealedDays.has(day)
      || this.expected !== -1 || this.tick !== day * this.ticksPerDay + (final ? 0 : 1)
      || final !== (day === 60) || this.finished !== final
      || this.sealedDays.size !== day - 1)
      throw new Error('Invalid or duplicate approach day seal');
    this.sealedDays.add(day);
  }
  exportTrips(): Trip[] {
    const rows = this.outbox; this.outbox = [];
    return rows.map(row => ({ ...row, emittedAtTick: this.tick }));
  }
  finish(world: WorldLike): void {
    if (this.finished || this.expected !== -1 || this.tick !== world.tick) throw new Error('Invalid approach finish');
    for (const t of [...this.active.values()]) this.close(t, world.tick, 'observationEnd', true);
    for (const t of [...this.pending]) {
      if (t.outcomeWindowEnd! > world.tick) this.censor(t, world.tick, 'observationEnd', true);
      this.mature(t, world.tick);
    }
    this.finished = true;
  }
}
export function createApproachObserver(options: { ticksPerDay?: number } = {}): ApproachObserver {
  return new ApproachObserver(options.ticksPerDay);
}

/** Strict transforms applied only by the owner of the external runtime copy. */
export function instrumentApproachSource(source: string): string {
  if (source.includes('/* CODEX11_APPROACH_EXTERNAL */')) throw new Error('Approach hooks already present');
  const replace = (anchor: string, replacement: string) => {
    if (source.split(anchor).length !== 2) throw new Error(`Approach source anchor missing/nonunique: ${anchor.slice(0, 100)}`);
    source = source.replace(anchor, replacement);
  };
  source = "/* CODEX11_APPROACH_EXTERNAL */\nimport { captureApproachDecision, captureApproachEvent, captureApproachShareBefore, captureApproachEffectiveShare } from " + JSON.stringify(new URL('./approach-observer_v2.mts', import.meta.url).href) + ";\n" + source;
  replace('  const result = recordChronicleEvent(world, event);',
    '  const result = recordChronicleEvent(world, event);\n  captureApproachEvent(world, result);');
  const decision = '  person.decisionAt = world.tick + (selected === restCandidate && recoverWater ? 1 : 30);';
  replace(decision, decision + "\n  captureApproachDecision(world, person, { partner: selected.action === 'approach' && selected.reason.startsWith('Tiene reservas') ? family?.partner : undefined, placeId: selected.action === 'approach' && selected.reason.startsWith('Tiene reservas') ? familyPlace?.id : undefined });");
  const before = '  if (!place || !recipient || !availableToShare(world, donor, recipient)) return;';
  replace(before, before + '\n  const approachShareBefore = captureApproachShareBefore(world, donor, recipient, place);');
  const after = '  remember(donor, world, `Compartió alimento en ${place.name}.`, event.id, place.id);';
  replace(after, '  captureApproachEffectiveShare(world, donor, recipient, place, event, approachShareBefore);\n' + after);
  return source;
}

/** Pure fixtures: never imports or calls a model. Root runs this under guard11. */
export function selftestApproachObserver() {
  const checks: string[] = [];
  const assert = (ok: unknown, label: string) => { if (!ok) throw new Error(`Approach selftest: ${label}`); checks.push(label); };
  const person = (id: string, x = 0): PersonLike => ({ id, role: 'neighbor', action: 'rest', reason: 'rest',
    x, y: 0, decisionAt: 0, target: { x: 0, y: 0 }, communityId: 'c', inventory: 0.2,
    hunger: 0.4, thirst: 0.2, fatigue: 0.2, energy: 0.6, genome: { parents: [] }, bonds: {} });
  const a = person('a'), b = person('b'); const w: WorldLike = { tick: 0, people: [a, b], places: [{ id: 'p', x: 0, y: 0 }] };
  const o = createApproachObserver({ ticksPerDay: 10 }); attachApproachObserver(w, o);
  const select = (action = 'approach', reason = 'Tiene reservas synthetic') => {
    a.action = action; a.reason = reason; a.decisionAt = w.tick + 30;
    captureApproachDecision(w, a, { partner: action === 'approach' ? b : undefined, placeId: 'p' });
  };
  const snapshot = JSON.stringify(w);
  o.beginTick(w); w.tick++; select(); o.discardTick(); w.tick--;
  // Restore the synthetic fixture after simulating an abandoned candidate, never a live world.
  Object.assign(w, JSON.parse(snapshot));
  assert(o.exportTrips().length === 0, 'abandoned provisional decision not accepted');
  // Continue with fresh fixture to keep lexical actor references explicit.
  const w2: WorldLike = { tick: 0, people: [a, b], places: [{ id: 'p', x: 0, y: 0 }] };
  a.action = 'rest'; a.reason = 'rest'; a.decisionAt = 0;
  const q = createApproachObserver({ ticksPerDay: 10 }); attachApproachObserver(w2, q);
  const advance = (f: () => void = () => {}) => { q.beginTick(w2); w2.tick++; f(); q.endTick(w2); };
  const choose = (action = 'approach') => { a.action = action; a.reason = action === 'approach' ? 'Tiene reservas synthetic' : 'rest';
    a.decisionAt = w2.tick + 30; captureApproachDecision(w2, a, { partner: action === 'approach' ? b : undefined, placeId: 'p' }); };
  advance(() => choose()); advance(() => { a.decisionAt = w2.tick + 1; });
  advance(() => choose()); advance(() => choose('rest'));
  // Food comes after the trip; no arrival inference and actual floating debit required.
  advance(() => { const pre = captureApproachShareBefore(w2, a, b, { id: 'p' });
    a.inventory -= 0.025; b.hunger -= 0.12; b.energy += 0.03;
    captureApproachEffectiveShare(w2, a, b, { id: 'p' }, { id: 'share1' }, pre); });
  for (let i = 0; i < 31; i++) advance();
  const rows = q.exportTrips();
  assert(rows.length === 2 && rows[0].ticks === 2 && rows[1].ticks === 1, 'real reselection splits trips; blocked decisionAt does not');
  assert(rows[1].food.length === 1 && rows[0].food.length === 0, 'delivery attributed once to latest exact selected recipient');
  assert(rows[1].food[0].amount > 0 && rows[1].food[0].hungerRelief > 0 && !rows[1].food[0].closeKin, 'actual float debit and need relief; reproductive target is not kin');
  assert(rows[0].pathMoved === 0 && rows[0].alreadyAtDestinationTicks === 2, 'at-destination waiting separated from movement');
  assert(rows[1].sameDestinationPrevious, 'same actor target repetition preserved');
  assert(q.exportDay(1).stats['familia.approachTicks'] === 3 && q.exportDay(1).stats['familia.tripTicks'] === 3, 'daily tick accounting preserves legacy class');
  const w3: WorldLike = { tick: 0, people: [person('x', 1), person('y')], places: [] };
  const r = createApproachObserver(); attachApproachObserver(w3, r); r.beginTick(w3); w3.tick++;
  const x = w3.people[0]; x.action = 'approach'; x.reason = 'Tiene reservas synthetic'; x.target = { x: 0, y: 0 };
  captureApproachDecision(w3, x, { partner: w3.people[1] }); x.x = 0; r.endTick(w3);
  r.finish(w3); const censored = r.exportTrips()[0];
  assert(censored.pathMoved === 1 && censored.arrivalTick === 1, 'actual path and first arrival measured');
  assert(censored.censored && censored.attributionCensored && !censored.loopWithoutObservedEffect, 'observation end censors unfinished trip and outcome window');
  const anchors = ['  const result = recordChronicleEvent(world, event);',
    '  person.decisionAt = world.tick + (selected === restCandidate && recoverWater ? 1 : 30);',
    '  if (!place || !recipient || !availableToShare(world, donor, recipient)) return;',
    '  remember(donor, world, `Compartió alimento en ${place.name}.`, event.id, place.id);'].join('\n');
  const transformed = instrumentApproachSource(anchors);
  assert(transformed.includes('family?.partner') && transformed.includes('approachShareBefore'), 'exact original decision and pre-share anchors');
  for (const text of [anchors + '\n' + anchors, anchors.replace('recordChronicleEvent', 'drift'), transformed]) {
    let rejected = false; try { instrumentApproachSource(text); } catch { rejected = true; }
    assert(rejected, 'duplicate missing or already transformed source rejected');
  }
  const unchanged = JSON.stringify(w3); r.exportDay(1); r.exportTrips();
  assert(JSON.stringify(w3) === unchanged, 'observer exports do not write serialized world');
  // Generic fixture driver uses plain records, not createWorld/stepWorld.
  const fixture = (ticksPerDay = 10) => {
    const donor = person('donor'), receiver = person('receiver');
    const world: WorldLike = { tick: 0, people: [donor, receiver], places: [{ id: 'home', x: 0, y: 0 }] };
    const observer = createApproachObserver({ ticksPerDay }); attachApproachObserver(world, observer);
    const next = (f: () => void = () => {}) => { observer.beginTick(world); world.tick++; f(); observer.endTick(world); };
    const decision = (kind: Kind | 'rest' = 'familia') => {
      donor.action = kind === 'rest' ? 'rest' : 'approach';
      donor.reason = kind === 'familia' ? 'Tiene reservas synthetic' : kind === 'hogar' ? 'Vuelve a un lugar conocido synthetic' : 'rest';
      donor.decisionAt = world.tick + 30;
      captureApproachDecision(world, donor, { partner: kind === 'familia' ? receiver : undefined, placeId: 'home' });
    };
    const share = (id: string, effective = true) => {
      const pre = captureApproachShareBefore(world, donor, receiver, { id: 'home' });
      if (effective) { donor.inventory -= 0.01; receiver.hunger -= 0.01; }
      captureApproachEffectiveShare(world, donor, receiver, { id: 'home' }, { id }, pre);
    };
    const until = (n: number) => { while (world.tick < n) next(); };
    return { donor, receiver, world, observer, next, decision, share, until };
  };
  const home = fixture(); home.receiver.genome.parents = ['donor'];
  home.next(() => home.decision('hogar')); home.next(() => home.decision('rest'));
  home.next(() => home.share('home-share')); home.until(32);
  const homeTrip = home.observer.exportTrips()[0];
  assert(homeTrip.kind === 'hogar' && homeTrip.partnerId === null && homeTrip.food[0].closeKin,
    'home food uses exact frozen place and actual recipient kin metadata');
  const boundary = fixture(); boundary.next(() => boundary.decision()); boundary.next(() => boundary.decision('rest'));
  boundary.until(30); boundary.next(() => boundary.share('at30'));
  const at30 = boundary.observer.exportTrips()[0];
  assert(at30.food.length === 1 && at30.food[0].tick === at30.endTick! + 30,
    'close plus 30 delivery accepted before maturation');
  boundary.next(() => boundary.share('at31'));
  assert(boundary.observer.exportTrips().length === 0, 'close plus 31 cannot rewrite mature trip');
  const nominal = fixture(); nominal.next(() => nominal.decision()); nominal.next(() => nominal.decision('rest'));
  nominal.next(() => nominal.share('nominal-only', false)); nominal.until(31);
  assert(nominal.observer.exportTrips()[0].food.length === 0, 'nominal event without real debit and need relief is not success');
  const reproduction = fixture(); reproduction.next(() => reproduction.decision());
  reproduction.next(() => { captureApproachEvent(reproduction.world, { id: 'birth-proof', tick: reproduction.world.tick,
    kind: 'birth', actors: ['donor', 'receiver', 'child'], source: 'simulation' }); reproduction.decision('rest'); });
  reproduction.until(31); const reproductiveTrip = reproduction.observer.exportTrips()[0];
  assert(reproductiveTrip.births[0] === 'birth-proof' && reproductiveTrip.food.length === 0
    && !reproductiveTrip.loopWithoutObservedEffect, 'actual selected-pair birth is an outcome without food delivery');
  const dead = fixture(); dead.next(() => dead.decision());
  dead.next(() => { dead.world.people = [dead.donor]; captureApproachEvent(dead.world,
    { id: 'death-proof', tick: dead.world.tick, kind: 'death', actors: ['receiver'], source: 'simulation' }); });
  dead.until(32); const deathTrip = dead.observer.exportTrips()[0];
  assert(deathTrip.censored && deathTrip.closure === 'selectedPartnerDeath', 'selected partner death is explicitly censored');
  for (const who of ['actor', 'partner'] as const) {
    const closed = fixture(); closed.next(() => closed.decision()); closed.next(() => closed.decision('rest'));
    closed.next(() => {
      const id = who === 'actor' ? closed.donor.id : closed.receiver.id;
      closed.world.people = closed.world.people.filter(p => p.id !== id);
      captureApproachEvent(closed.world, { id: `pending-${who}-death`, tick: closed.world.tick,
        kind: 'death', actors: [id], source: 'simulation' });
    });
    closed.next(() => closed.share(`post-${who}-death`)); closed.until(31);
    const trip = closed.observer.exportTrips()[0];
    assert(trip.censored && trip.attributionCensored && trip.censorTick === 3
      && trip.censorReason === (who === 'actor' ? 'actorDeath' : 'selectedPartnerDeath')
      && trip.closure === 'actionChanged' && trip.endTick === 1,
      `closed pending ${who} death censors follow-up while preserving decision closure`);
    assert(trip.food.length === 0 && trip.foodContext.length === 0 && !trip.loopWithoutObservedEffect
      && (closed.observer.exportDay(4).stats['familia.uncensoredMatured'] ?? 0) === 0,
      `closed pending ${who} death excludes later outcomes and uncensored denominator`);
    assert(closed.observer.exportDay(1).stats['familia.censored'] === 1
      && (closed.observer.exportDay(4).stats['familia.censored'] ?? 0) === 0,
      `closed pending ${who} death counted exactly once on death day`);
  }
  const missing = fixture(); missing.next(() => missing.decision()); missing.next(() => missing.decision('rest'));
  missing.next(() => { missing.world.people = [missing.donor]; }); missing.until(31);
  assert(missing.observer.exportTrips()[0].censorReason === 'selectedPartnerMissing',
    'pending partner disappearance censors even without a death event hook');
  const activeDeath = fixture(); activeDeath.next(() => activeDeath.decision());
  activeDeath.next(() => { activeDeath.world.people = [activeDeath.receiver]; captureApproachEvent(activeDeath.world,
    { id: 'active-actor-death', tick: activeDeath.world.tick, kind: 'death', actors: ['donor'], source: 'simulation' }); });
  activeDeath.until(31); const activeDeadRow = activeDeath.observer.exportTrips()[0];
  assert(activeDeadRow.censorReason === 'actorDeath' && activeDeadRow.censorTick === 2
    && activeDeath.observer.exportDay(1).stats['familia.censored'] === 1,
    'active actor death retains actual censor tick and counts once');
  const finalWindow = fixture(1); finalWindow.until(58); finalWindow.next(() => finalWindow.decision());
  finalWindow.next(() => finalWindow.decision('rest'));
  const beforeFinish = finalWindow.observer.exportDay(60); finalWindow.observer.finish(finalWindow.world);
  const afterFinish = finalWindow.observer.exportDay(60), finalWindowRow = finalWindow.observer.exportTrips()[0];
  assert((beforeFinish.stats['familia.matured'] ?? 0) === 0 && afterFinish.stats['familia.matured'] === 1
    && afterFinish.stats['familia.censored'] === 1 && afterFinish.pendingTrips === 0
    && finalWindowRow.attributionCensored && finalWindowRow.censorTick === 60 && finalWindowRow.censorReason === 'observationEnd'
    && (afterFinish.stats['familia.uncensoredMatured'] ?? 0) === 0,
    'finish before final day export includes pending-window censor and maturation in day60');
  const finalActive = fixture(1); finalActive.until(59); finalActive.next(() => finalActive.decision());
  finalActive.observer.finish(finalActive.world);
  assert(finalActive.observer.exportDay(60).stats['familia.censored'] === 1
    && finalActive.observer.exportDay(60).stats['familia.matured'] === 1,
    'final active closure and incomplete window count one censor not two');
  const loop = fixture(); loop.donor.inventory = 0.02; loop.receiver.inventory = 0.01;
  loop.next(() => loop.decision()); loop.next(() => loop.decision());
  loop.next(() => loop.decision()); loop.next(() => loop.decision('rest')); loop.until(33);
  const loopRows = loop.observer.exportTrips();
  assert(loopRows.length === 3 && loopRows[2].loopWithoutObservedEffect && loopRows[2].repeatedRun === 3,
    'three mature repeated at-destination trips without observed outcomes flag a loop');
  const reserve = fixture(); reserve.next(() => reserve.decision()); reserve.next(() => reserve.decision());
  reserve.next(() => reserve.decision()); reserve.next(() => reserve.decision('rest')); reserve.until(33);
  const reserveRows = reserve.observer.exportTrips();
  assert(reserveRows[2].repeatedWithoutObservedOutcome && reserveRows[2].pairReserveReadyTicks > 0
    && !reserveRows[2].loopWithoutObservedEffect, 'preserved reproductive reserves prevent a no-effect accusation; repetition remains observable');
  const crossed = fixture(); crossed.next(() => crossed.decision()); crossed.until(12);
  crossed.next(() => crossed.decision('rest')); crossed.until(42);
  const acrossDay = crossed.observer.exportTrips()[0];
  assert(acrossDay.startTick === 1 && acrossDay.endTick === 12 && acrossDay.ticks === 12
    && crossed.observer.exportDay(1).stats['familia.approachTicks'] === 10
    && crossed.observer.exportDay(2).stats['familia.approachTicks'] === 2,
    'day boundary preserves trip and splits daily tick counts');
  return { label: 'TEST_FIXTURE', scientificGateEvidence: false, valid: true, pure: true, checks, count: checks.length, noEngineImport: true };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url && process.argv[2] === '--selftest') {
  process.title = 'codex11approach'; console.log(JSON.stringify(selftestApproachObserver()));
}
