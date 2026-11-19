/** Local helper copy; paid-return formulas and hooks preserved from pinned V1. */
import assert from 'node:assert/strict';

export const OFFICES = ['gather', 'forage', 'hunt', 'farm', 'build', 'repair', 'research', 'craft'] as const;
export type Office = typeof OFFICES[number];
export type CompletionSite = 'physical' | 'technology';
export interface ReturnPerson {
  readonly id: string;
  readonly role: string;
  readonly communityId: string | null;
}
export interface ReturnWorld {
  readonly seed: number;
  readonly tick: number;
  readonly people: readonly ReturnPerson[];
}
export interface RawReturn {
  readonly seed: number;
  readonly tick: number;
  readonly actorId: string;
  readonly office: Office;
  readonly communityId: string | null;
  readonly communityMortalsAtCompletion: number;
  readonly benefit: number;
  readonly work: number;
  readonly success: boolean;
  readonly site: CompletionSite;
}
export interface ReturnRow extends RawReturn {
  readonly schema: 'c8-paid-return-v1';
  readonly serial: number;
  readonly day: number;
  readonly paid: true;
  readonly g: number;
}
export interface CompletionContext { readonly world: ReturnWorld; readonly success: boolean; readonly site: CompletionSite; }
type Sink = (event: RawReturn) => void;
const sinks = new WeakMap<object, Sink>();

/** The sink sees only frozen scalar copies. No Person/World reference is delivered. */
export function attachReturnSink(world: object, sink: Sink): () => void {
  if (sinks.has(world)) throw new Error('A return sink is already attached to this world.');
  sinks.set(world, sink);
  return () => { if (sinks.get(world) === sink) sinks.delete(world); };
}

/** Called at the existing completed-outcome sites, before the copied learning helper's OFF guard. */
export function observeProductiveCompletion(context: CompletionContext | undefined, person: ReturnPerson,
  action: string, benefit: number, work: number): void {
  if (!context || person.role !== 'neighbor' || !(OFFICES as readonly string[]).includes(action) || work === 0) return;
  const sink = sinks.get(context.world);
  if (!sink) return;
  const { world, success, site } = context;
  const communityId = person.communityId;
  let communityMortalsAtCompletion = 0;
  if (communityId !== null) for (const member of world.people)
    if (member.role === 'neighbor' && member.communityId === communityId) communityMortalsAtCompletion++;
  sink(Object.freeze({ seed: world.seed, tick: world.tick, actorId: person.id, office: action as Office,
    communityId, communityMortalsAtCompletion, benefit, work, success, site }));
}

function validate(event: RawReturn): void {
  if (!Number.isSafeInteger(event.seed) || event.seed < 0 || !Number.isSafeInteger(event.tick) || event.tick < 1
    || typeof event.actorId !== 'string' || !event.actorId || !(OFFICES as readonly string[]).includes(event.office)
    || !(event.communityId === null || typeof event.communityId === 'string' && event.communityId.length > 0)
    || !Number.isSafeInteger(event.communityMortalsAtCompletion) || event.communityMortalsAtCompletion < 0
    || event.communityId === null && event.communityMortalsAtCompletion !== 0
    || !Number.isFinite(event.benefit) || event.benefit < 0 || !Number.isSafeInteger(event.work) || event.work < 1
    || typeof event.success !== 'boolean' || !event.success && event.benefit !== 0
    || !['physical', 'technology'].includes(event.site)) throw new Error('Invalid paid completion capture.');
  if (event.site === 'technology' && (!['research', 'craft'].includes(event.office) || event.benefit !== Number(event.success)))
    throw new Error('A technological return must count completed processes.');
  if (event.site === 'physical' && ['research', 'craft'].includes(event.office)) throw new Error('Wrong physical completion site.');
}

export function createReturnCollector(options: { seed: number; ticksPerDay?: number }) {
  const ticksPerDay = options.ticksPerDay ?? 2400;
  if (!Number.isSafeInteger(ticksPerDay) || ticksPerDay < 1) throw new Error('Invalid day length.');
  let serial = 0, lastTick = 0;
  let pending: ReturnRow[] = [];
  const totals: Record<Office, { attempts: number; successes: number; failures: number; benefit: number; work: number }>
    = Object.fromEntries(OFFICES.map(office => [office, { attempts: 0, successes: 0, failures: 0, benefit: 0, work: 0 }])) as typeof totals;
  return {
    record(event: RawReturn): void {
      validate(event);
      if (event.seed !== options.seed || event.tick < lastTick) throw new Error('Capture belongs to another seed or reverses time.');
      lastTick = event.tick;
      const row: ReturnRow = Object.freeze({ ...event, schema: 'c8-paid-return-v1', serial: ++serial,
        day: Math.floor((event.tick - 1) / ticksPerDay) + 1, paid: true, g: event.benefit / event.work });
      pending.push(row);
      const total = totals[event.office]; total.attempts++; total.successes += Number(event.success);
      total.failures += Number(!event.success); total.benefit += event.benefit; total.work += event.work;
    },
    drain(): ReturnRow[] { const rows = pending; pending = []; return rows; },
    get pendingCount(): number { return pending.length; },
    summary() { return { schema: 'c8-paid-return-summary-v1', seed: options.seed, attempts: serial,
      lastTick, byOffice: structuredClone(totals) }; },
  };
}

/** Descriptive closing census. Eligibility is the event's contemporaneous count, never this later membership. */
export function closingCommunityCensus(world: ReturnWorld, day: number) {
  const groups = new Map<string, string[]>();
  for (const person of world.people) if (person.role === 'neighbor' && person.communityId !== null) {
    const members = groups.get(person.communityId) ?? []; members.push(person.id); groups.set(person.communityId, members);
  }
  return { schema: 'c8-community-closing-v1', day, tick: world.tick,
    mortalsByCommunity: [...groups].map(([communityId, actorIds]) => ({ communityId, actorIds })) };
}

/** Pure fixtures only: no import of the engine and no stepWorld/createWorld call. */
export function runReturnSelftests() {
  const collector = createReturnCollector({ seed: 17 });
  const a: ReturnPerson = { id: 'a', role: 'neighbor', communityId: 'g' };
  const b: ReturnPerson = { id: 'b', role: 'neighbor', communityId: 'g' };
  const c: ReturnPerson = { id: 'c', role: 'neighbor', communityId: 'g' };
  const protectedPerson: ReturnPerson = { id: 'S', role: 'S', communityId: 'g' };
  const world: ReturnWorld = { seed: 17, tick: 2400, people: [a, b, c, protectedPerson] };
  Object.defineProperty(world, 'rng', { get() { throw new Error('RNG was read.'); } });
  Object.defineProperty(a, 'utilidadLocal', { get() { throw new Error('q was read.'); } });
  Object.freeze(a); Object.freeze(b); Object.freeze(c); Object.freeze(protectedPerson); Object.freeze(world.people); Object.freeze(world);
  const detach = attachReturnSink(world, collector.record);
  const context: CompletionContext = { world, success: true, site: 'physical' };
  observeProductiveCompletion(context, a, 'gather', 2, 24);
  observeProductiveCompletion({ ...context, success: false }, a, 'repair', 0, 30);
  observeProductiveCompletion(context, protectedPerson, 'gather', 1, 18);
  observeProductiveCompletion(context, a, 'invent', 1, 60);
  observeProductiveCompletion({ ...context, site: 'technology', success: false }, a, 'research', 0, 0);
  const rows = collector.drain(); assert.equal(rows.length, 2); assert.equal(rows[0]!.g, 2 / 24);
  assert.equal(rows[0]!.communityMortalsAtCompletion, 3); assert.equal(rows[0]!.day, 1);
  assert.equal(rows[1]!.g, 0); assert.equal(rows[1]!.paid, true); assert.equal(rows[1]!.success, false);
  assert.equal(Object.isFrozen(rows[0]), true); assert.equal(collector.pendingCount, 0);
  assert.deepEqual(closingCommunityCensus(world, 1).mortalsByCommunity, [{ communityId: 'g', actorIds: ['a', 'b', 'c'] }]);
  detach(); observeProductiveCompletion(context, a, 'gather', 1, 18); assert.equal(collector.pendingCount, 0);
  collector.record({ ...rows[0]!, tick: 2401, communityId: null, communityMortalsAtCompletion: 0 });
  assert.equal(collector.drain()[0]!.day, 2);
  const other = createReturnCollector({ seed: 17 });
  for (const office of OFFICES) other.record({ ...rows[0]!, office, benefit: 1, work: 40,
    site: ['research', 'craft'].includes(office) ? 'technology' : 'physical' });
  assert.ok(other.drain().every(row => row.g === 1 / 40));
  for (const patch of [{ work: 0 }, { work: 0.5 }, { benefit: NaN }, { benefit: 1, success: false },
    { site: 'technology', office: 'research', benefit: 2 }, { seed: 18 }, { tick: 0 }])
    assert.throws(() => other.record({ ...rows[0]!, ...patch } as RawReturn));
  const before = Number.MAX_SAFE_INTEGER - 1, after = Number.MAX_SAFE_INTEGER;
  assert.equal(16 + (after - before), 17); assert.equal(16 + after - before, 18);
  return { label: 'TEST_FIXTURE', scientificGateEvidence: false, valid: true, pure: true, offices: OFFICES.length, capturedFixtures: rows.length,
    checks: ['paid failure zero', 'free/protected/invent excluded', 'raw ratio', 'G3 at completion', 'day boundary',
      'frozen scalar copies', 'no q/RNG/world writes', 'drain bounded', 'invalid input abort', 'technology precision'] };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1] && process.argv[2] === '--selftest')
  console.log(JSON.stringify(runReturnSelftests()));
