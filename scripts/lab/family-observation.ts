import type { Person, World } from '../../src/world/index.js';
import type * as Family from '../../src/world/family.js';
import type { DatabaseSync } from 'node:sqlite';

const provisioning = (p: Person) => p.role === 'neighbor' && p.action === 'forage'
  && p.reason.startsWith('Prepara alimento para una posible crianza con ');
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
type Before = Pick<Person, 'inventory' | 'energy' | 'fatigue' | 'lastOutcome' | 'decisionAt'> & { active: boolean; target: string };

/** External observer: no exports are replaced and no state is written. Net deltas
 * include all events in that tick; they are deliberately not labelled pure work costs.
 * Physical accounting is isolated in family-forage-planning.test.ts instead. */
export class FamilyObservation {
  private before = new Map<string, Before>();
  private firstExtinctionTick: number | null = null;
  private interval = this.empty();
  private empty() { return { decisions: 0, actorTicks: 0, outcomes: 0, positiveInventoryOutcomes: 0,
    netInventoryAtOutcomes: 0, netEnergyDuringActiveTicks: 0, netFatigueDuringActiveTicks: 0,
    exits: {} as Record<string, number> }; }

  begin(world: World): void {
    this.before.clear();
    for (const p of world.people) if (p.role === 'neighbor') this.before.set(p.id, {
      inventory: p.inventory, energy: p.energy, fatigue: p.fatigue, lastOutcome: p.lastOutcome,
      decisionAt: p.decisionAt, active: provisioning(p), target: `${p.target.x},${p.target.y}`,
    });
  }

  end(world: World): void {
    let mortals = 0;
    for (const p of world.people) {
      if (p.role !== 'neighbor') continue;
      mortals++;
      const before = this.before.get(p.id); if (!before) continue;
      const active = provisioning(p);
      if (active && p.decisionAt !== before.decisionAt && p.lastOutcome !== world.tick) this.interval.decisions++;
      if (active) {
        this.interval.actorTicks++;
        this.interval.netEnergyDuringActiveTicks += p.energy - before.energy;
        this.interval.netFatigueDuringActiveTicks += p.fatigue - before.fatigue;
        if (p.lastOutcome === world.tick && p.lastOutcome !== before.lastOutcome) {
          this.interval.outcomes++;
          this.interval.netInventoryAtOutcomes += p.inventory - before.inventory;
          if (p.inventory > before.inventory) this.interval.positiveInventoryOutcomes++;
        }
      }
      if (before.active && (!active || before.target !== `${p.target.x},${p.target.y}`)) {
        const key = active ? 'retargeted' : `${p.action}: ${p.reason}`;
        this.interval.exits[key] = (this.interval.exits[key] ?? 0) + 1;
      }
      this.before.delete(p.id);
    }
    for (const previous of this.before.values()) if (previous.active) this.interval.exits.death = (this.interval.exits.death ?? 0) + 1;
    if (mortals === 0) this.firstExtinctionTick ??= world.tick;
  }

  closeInterval() {
    const result = { version: 1, ...this.interval, firstExtinctionTick: this.firstExtinctionTick,
      scope: 'Tick endpoint observations. Net body/inventory deltas may include simultaneous social/reproductive events; no pure-cost attribution. Decisions completing an outcome on that same tick are excluded.' };
    this.interval = this.empty(); return result;
  }
}

/** Exact snapshots every 120 ticks, not an integral of transient opportunities. */
export function familySample(world: World, family: typeof Family) {
  const neighbors = world.people.filter(p => p.role === 'neighbor');
  const ready = neighbors.filter(p => family.reproductiveReadiness(world, p));
  const pairs = ready.flatMap((a, i) => ready.slice(i + 1).map(b => ({
    a: a.id, b: b.id, distance: distance(a, b), communities: [a.communityId, b.communityId],
    mutualTrust: Math.min(a.bonds[b.id] ?? 0, b.bonds[a.id] ?? 0), kin: family.closeKin(a, b),
    reserves: [a.inventory, b.inventory],
    nearPlace: world.places.some(place => distance(a, place) <= 4 || distance(b, place) <= 4),
  })));
  return { tick: world.tick,
    // Current reproduction preconditions; capacity/governor and birth-check cadence
    // are reported separately by the host. This does not promise an actual birth.
    completeLocalPairs: pairs.filter(p => p.distance <= 3 && p.communities.every(Boolean)
      && p.mutualTrust >= .3 && !p.kin && p.reserves.every(n => n >= .1) && p.nearPlace).length,
    neighbors: neighbors.map(p => ({ id: p.id, x: p.x, y: p.y,
    age: p.demography.age, generation: p.genome.generation, parents: p.genome.parents,
    ready: ready.includes(p), community: p.communityId, inventory: p.inventory,
    hunger: p.hunger, thirst: p.thirst, energy: p.energy, fatigue: p.fatigue,
    opportunityPartner: family.familyOpportunity(world, p)?.partner.id ?? null,
    action: p.action, reason: p.reason, target: p.target, work: p.work,
  })), pairs };
}

/** S/I remain alive by the existing law, so endpoint identity suffices to split
 * every durable useful use in the interval, including actors who died meanwhile. */
export function roleActivity(world: World, db: DatabaseSync, afterTick: number) {
  const protectedIds = new Set(world.people.filter(p => p.role !== 'neighbor').map(p => p.id));
  const result = { mortals: { uses: 0, benefit: 0 }, protected: { uses: 0, benefit: 0 } };
  for (const row of db.prepare('SELECT body FROM technology_executions WHERE tick>? AND tick<=? ORDER BY serial').iterate(afterTick, world.tick)) {
    const execution = JSON.parse(row.body as string);
    if (!execution.success || execution.kind !== 'use' || !execution.recipeId || !(execution.benefit > 0)) continue;
    const count = protectedIds.has(execution.actorId) ? result.protected : result.mortals;
    count.uses++; count.benefit += execution.benefit;
  }
  return result;
}
