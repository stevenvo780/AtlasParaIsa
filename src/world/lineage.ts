import type { ChronicleEvent } from '../shared/types.js';
import type { LegacyRecord, DemographicDeathCause } from '../shared/demography.js';
import type { Person, World } from './index.js';
import { assertGenome } from './genetics.js';
import { demographicTraits, updateDemography } from './demography.js';
import { tileAt } from './spatial.js';
import { BROKEN_CONDITION } from './inventions.js';

export const RECENT_LEGACY_COUNT = 32;
export const MAX_LEGACY_CACHE = 600;
const CAUSES: readonly DemographicDeathCause[] = ['starvation', 'dehydration', 'exposure', 'senescence'];
const TRAIT_KEYS = ['resilience', 'foodDemand', 'waterDemand', 'maturityAge', 'fertilityCooldown', 'senescenceStart', 'maximumAge'] as const;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length < 50 && !/[\s\u0000-\u001f\u007f]/.test(value);
const keysAre = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = (): never => { throw new Error('Registro de identidad o población inválido.'); };

/** Validates an archived identity at an explicit historical boundary. Parent existence is
 * resolved by the host against live identities and SQLite, never by silently inventing ancestors. */
export function assertLegacyRecord(value: unknown, atTick: number): asserts value is LegacyRecord {
  if (!integer(atTick) || !object(value) || !keysAre(value, ['id', 'name', 'role', 'generation', 'parents', 'bornAt', 'diedAt', 'cause', 'genome', 'traits', 'communityId'])
    || !identifier(value.id) || typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 80 || /[\u0000-\u001f\u007f]/.test(value.name)
    || !['S', 'I', 'neighbor'].includes(String(value.role)) || !integer(value.generation)
    || !Array.isArray(value.parents) || !value.parents.every(identifier) || value.parents.includes(value.id) || new Set(value.parents).size !== value.parents.length
    || (value.generation === 0 ? value.parents.length !== 0 : value.parents.length !== 2)
    || typeof value.bornAt !== 'number' || !Number.isSafeInteger(value.bornAt) || !integer(value.diedAt) || value.bornAt > value.diedAt || value.diedAt > atTick
    || !Number.isSafeInteger(value.diedAt - value.bornAt)
    || !CAUSES.includes(value.cause as DemographicDeathCause) || !object(value.genome) || !object(value.traits)
    || !(value.communityId === null || identifier(value.communityId))) fail();
  const record = value as unknown as LegacyRecord;
  if (!keysAre(record.genome as unknown as Record<string, unknown>, ['generation', 'parents', 'learningRate', 'cooperation', 'mutations', 'alleles'])
    || !keysAre(record.traits as unknown as Record<string, unknown>, TRAIT_KEYS)) fail();
  assertGenome(record.genome);
  if (record.generation !== record.genome.generation || record.parents.length !== record.genome.parents.length
    || record.parents.some((id, index) => id !== record.genome.parents[index])) fail();
  const expression = demographicTraits(record.genome);
  if (TRAIT_KEYS.some(key => record.traits[key] !== expression[key])) fail();
  if (record.cause === 'senescence' && record.diedAt - record.bornAt < expression.senescenceStart) fail();
}

/** Only dead references need a legacy row; living parent/inventor identities are in the snapshot. */
export function referencedLegacy(world: World): Set<string> {
  const required = new Set<string>();
  for (const person of world.people) for (const parent of person.genome.parents) required.add(parent);
  for (const blueprint of world.blueprints) if (blueprint.inventorId !== null) required.add(blueprint.inventorId);
  for (const recipe of world.technology.recipes) required.add(recipe.inventorId);
  for (const person of world.people) required.delete(person.id);
  return required;
}

function identityValue(record: LegacyRecord): string {
  return JSON.stringify([record.id, record.name, record.role, record.generation, record.parents, record.bornAt, record.diedAt, record.cause,
    record.genome.generation, record.genome.parents, record.genome.learningRate, record.genome.cooperation, record.genome.mutations, record.genome.alleles,
    TRAIT_KEYS.map(key => record.traits[key]), record.communityId]);
}

/** Prunes only the read cache. The pending immutable archive queue is never shortened here. */
export function retainLegacy(world: World): void {
  const required = referencedLegacy(world), records = new Map<string, LegacyRecord>();
  for (const source of [world.legacy, world.retiredLegacy]) {
    const seen = new Set<string>();
    for (const record of source) {
      assertLegacyRecord(record, world.tick);
      const previous = records.get(record.id);
      if (seen.has(record.id) || previous && identityValue(previous) !== identityValue(record)) fail();
      seen.add(record.id); records.set(record.id, record);
    }
  }
  const newest = [...records.values()].sort((a, b) => b.diedAt - a.diedAt || a.id.localeCompare(b.id));
  const recent = new Set(newest.slice(0, RECENT_LEGACY_COUNT).map(record => record.id));
  const retained = newest.filter(record => required.has(record.id) || recent.has(record.id));
  if (retained.length > MAX_LEGACY_CACHE) throw new Error('Las referencias vivas exceden el límite del caché de identidades; no se descartaron ancestros requeridos.');
  world.legacy = retained;
}

export function assertPopulation(world: World): void {
  if (!integer(world.tick) || !Array.isArray(world.people) || !Array.isArray(world.legacy) || !Array.isArray(world.retiredLegacy) || world.legacy.length > MAX_LEGACY_CACHE) fail();
  const alive = new Set<string>();
  for (const person of world.people) {
    const state = person.demography;
    if (!identifier(person.id) || alive.has(person.id) || !object(state) || !keysAre(state, ['age', 'health', 'vitality', 'deathCause'])
      || !integer(state.age) || state.age !== world.tick - person.bornAt || !unit(state.health) || state.health === 0 || !unit(state.vitality) || state.deathCause !== null) fail();
    alive.add(person.id);
  }
  const cache = new Map<string, LegacyRecord>(), pending = new Map<string, LegacyRecord>();
  for (const [records, index] of [[world.legacy, cache], [world.retiredLegacy, pending]] as const) for (const record of records) {
    assertLegacyRecord(record, world.tick);
    if (alive.has(record.id) || index.has(record.id)) fail();
    index.set(record.id, record);
  }
  for (const [id, record] of pending) if (cache.has(id) && identityValue(cache.get(id)!) !== identityValue(record)) fail();
  const dynamics = world.demographyDynamics;
  if (!object(dynamics) || !keysAre(dynamics, ['deaths', 'causes', 'foodLost', 'woodLost', 'stoneLost']) || !integer(dynamics.deaths)
    || !object(dynamics.causes) || !keysAre(dynamics.causes, CAUSES) || CAUSES.some(cause => !integer(dynamics.causes[cause]))
    || CAUSES.reduce((sum, cause) => sum + dynamics.causes[cause], 0) !== dynamics.deaths
    || ['foodLost', 'woodLost', 'stoneLost'].some(key => typeof dynamics[key as keyof typeof dynamics] !== 'number'
      || !Number.isFinite(dynamics[key as keyof typeof dynamics]) || (dynamics[key as keyof typeof dynamics] as number) < 0)
    || dynamics.deaths < new Set([...cache.keys(), ...pending.keys()]).size) fail();
}

export interface PopulationCallbacks {
  emit: (event: Omit<ChronicleEvent, 'id' | 'tick'>) => ChronicleEvent;
  /** Owns every estate transfer/loss. All simultaneous deaths have been marked before it runs. */
  beforeDeath?: (world: World, person: Person) => void;
}

function carriesEstate(person: Person): boolean {
  return person.inventory > 0 || person.materials.wood > 0 || person.materials.stone > 0
    || person.technology.items.some(item => item.mass > 0) || Object.values(person.technology.residue).some(mass => mass > 0);
}

/** One post-action tick. Bodies are evaluated simultaneously; this module creates neither
 * descendants nor resources, and a vacant population slot does not itself create a replacement. */
export function advancePopulation(world: World, callbacks: PopulationCallbacks): void {
  const archived = new Set([...world.legacy, ...world.retiredLegacy].map(record => record.id));
  if (world.people.some(person => archived.has(person.id))) throw new Error('Una identidad fallecida reapareció entre los habitantes vivos.');
  const transitions = world.people.map(person => {
    const tile = tileAt(world, person);
    const shelter = world.shelterBenefitEnabled && tile?.terrain === 'shelter' ? Math.max(0, ...world.structures
      .filter(structure => structure.x === person.x && structure.y === person.y && structure.condition > BROKEN_CONDITION && structure.components.includes('roof'))
      .map(structure => structure.condition)) : 0;
    return { person, transition: updateDemography({ state: person.demography, traits: demographicTraits(person.genome),
      hunger: person.hunger, thirst: person.thirst, fatigue: person.fatigue, energy: person.energy },
    { exposure: world.weather === 'rain' ? 1 : 0, shelter, protected: person.role === 'S' || person.role === 'I' }, 1) };
  });
  const dying = transitions.filter(result => result.transition.death !== null).sort((a, b) => a.person.id.localeCompare(b.person.id));
  if (!callbacks.beforeDeath && dying.some(result => carriesEstate(result.person))) throw new Error('Falta una liquidación explícita de los recursos del fallecido.');
  const records = dying.map(({ person, transition }): LegacyRecord => ({ id: person.id, name: person.name, role: person.role,
    generation: person.genome.generation, parents: [...person.genome.parents], bornAt: person.bornAt, diedAt: world.tick,
    cause: transition.death!, genome: structuredClone(person.genome), traits: demographicTraits(person.genome), communityId: person.communityId }));
  for (const record of records) assertLegacyRecord(record, world.tick);
  for (const { person, transition } of transitions) person.demography = transition.state;
  for (const { person } of dying) callbacks.beforeDeath?.(world, person);
  if (dying.length) {
    const departed = new Set(dying.map(result => result.person.id));
    world.people = world.people.filter(person => !departed.has(person.id));
    for (const person of world.people) for (const id of departed) delete person.bonds[id];
    const alive = new Set(world.people.map(person => person.id));
    for (const community of world.communities) community.members = community.members.filter(id => alive.has(id));
    world.communities = world.communities.filter(community => community.members.length > 0);
    const communities = new Set(world.communities.map(community => community.id));
    for (const person of world.people) if (person.communityId !== null && !communities.has(person.communityId)) person.communityId = null;
    for (const record of records) {
      world.legacy.push(record); world.retiredLegacy.push(record);
      world.demographyDynamics.deaths++; world.demographyDynamics.causes[record.cause]++;
      const person = dying.find(result => result.person.id === record.id)!.person;
      callbacks.emit({ kind: 'death', actors: [record.id], x: person.x, y: person.y, source: 'simulation',
        text: `Terminó la vida simulada de ${record.name}.`,
        cause: `Causa del modelo: ${record.cause}; evaluación posterior a las acciones. Su identidad y parentesco se conservan; no aparece un sustituto ni recursos nuevos.` });
    }
  }
  retainLegacy(world);
}
