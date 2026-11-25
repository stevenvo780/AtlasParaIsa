import type { ChronicleEvent } from '../shared/types.js';
import type { LegacyRecord, DemographicDeathCause } from '../shared/demography.js';
import type { StructureView } from '../shared/life.js';
import { stringifyExact } from '../shared/exact-json.js';
import type { Person, World } from './index.js';
import { ALLELE_COUNT, assertGenome, type Genome } from './genetics.js';
import { demographicTraits, exposureDamage, updateDemography } from './demography.js';
import { paramsOf } from './params.js';
import { tileAt } from './spatial.js';
import { BROKEN_CONDITION } from './inventions.js';
import { consumeInsulationTools, portableInsulationPower, toolEffectsEnabled } from './technology.js';

export const RECENT_LEGACY_COUNT = 32;
const CAUSES: readonly DemographicDeathCause[] = ['starvation', 'dehydration', 'exposure', 'senescence'];
/** De estos rasgos, `assertLegacyRecord` recalcula desde el genoma los cinco primeros, que sólo dependen de él,
 * aunque no haya mundo a mano. Los dos últimos —`senescenceStart` y `maximumAge`— los fija `cuerpo.longevidad*`,
 * que el laboratorio cambia por réplica (R3), así que un archivo escrito bajo otra ley no puede recalcularse; de
 * ésos se exige la coherencia estructural que `updateDemography` da por supuesta. */
const TRAIT_KEYS = ['resilience', 'foodDemand', 'waterDemand', 'maturityAge', 'fertilityCooldown', 'senescenceStart', 'maximumAge'] as const;
const RECORD_KEYS = ['id', 'name', 'role', 'generation', 'parents', 'bornAt', 'diedAt', 'cause', 'genome', 'traits', 'communityId'] as const;
const GENOME_KEYS = ['generation', 'parents', 'learningRate', 'cooperation', 'mutations', 'alleles'] as const;
const STATE_KEYS = ['age', 'health', 'vitality', 'deathCause'] as const;
const DYNAMICS_KEYS = ['deaths', 'causes', 'foodLost', 'woodLost', 'stoneLost'] as const;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const UNSAFE_ID = /[\s\u0000-\u001f\u007f]/;
/** Mismo veredicto que `UNSAFE_ID`: el ASCII imprimible sin espacio (0x21–0x7e) se decide sin la expresión
 * regular; cualquier otra unidad UTF-16 (espacios de Unicode incluidos) la sigue decidiendo ella. */
function identifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length >= 50) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return !UNSAFE_ID.test(value);
  }
  return true;
}
/** `!/[\u0000-\u001f\u007f]/.test(name)`, unidad a unidad (sin modo Unicode la clase compara unidades UTF-16). */
function printable(value: string): boolean {
  for (let i = 0; i < value.length; i++) { const code = value.charCodeAt(i); if (code < 0x20 || code === 0x7f) return false; }
  return true;
}
/** Medido (V18): `Object.keys` copia la caché de enumeración de V8 y es 3-4× más rápido que contar con `for…in`. */
const keysAre = (value: object, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = (): never => { throw new Error('Registro de identidad o población inválido.'); };

/** `['S', 'I', 'neighbor'].includes(String(role))`. */
function roleAccepted(role: unknown): boolean {
  const text = typeof role === 'string' ? role : String(role);
  return text === 'S' || text === 'I' || text === 'neighbor';
}
const causeAccepted = (cause: unknown): boolean => cause === 'starvation' || cause === 'dehydration' || cause === 'exposure' || cause === 'senescence';

/** Padres de un registro, con la semántica de siempre: `every(identifier)` y `some(...)` se saltan los huecos,
 * `includes` y `new Set` los leen como `undefined`. Devuelve si la lista es aceptable. */
function parentsAccepted(parents: unknown[], id: string, generation: number): boolean {
  const length = parents.length;
  if (generation === 0 ? length !== 0 : length !== 2) return false;
  for (let i = 0; i < length; i++) {
    const parent = parents[i];
    if (parent === id || (!identifier(parent) && i in parents)) return false;
  }
  return length === 0 || parents[0] !== parents[1];
}

/** Lo que `assertGenome` acepta sin duda (arreglos densos). `false` no rechaza: deja decidir a `assertGenome`,
 * que lanza su propio error o acepta. */
function plainGenome(genome: Genome): boolean {
  const alleles = genome.alleles, parents = genome.parents;
  if (!Array.isArray(alleles) || alleles.length !== ALLELE_COUNT || !Array.isArray(parents)) return false;
  for (let i = 0; i < ALLELE_COUNT; i++) { const allele = alleles[i]; if (!(typeof allele === 'number' && allele >= 0 && allele <= 1)) return false; }
  const generation = genome.generation, mutations = genome.mutations, learningRate = genome.learningRate, cooperation = genome.cooperation;
  if (!Number.isSafeInteger(generation) || generation < 0 || !Number.isInteger(mutations) || mutations < 0 || mutations > ALLELE_COUNT
    || !Number.isFinite(learningRate) || learningRate < 0.04 || learningRate > 0.2 || !Number.isFinite(cooperation) || cooperation < 0 || cooperation > 1) return false;
  if (parents.length === 0) return generation === 0;
  if (parents.length !== 2 || generation === 0) return false;
  const a = parents[0], b = parents[1];
  return typeof a === 'string' && typeof b === 'string' && a.length > 0 && b.length > 0 && a.length < 50 && b.length < 50 && a !== b;
}

/** Validates an archived identity at an explicit historical boundary. Parent existence is
 * resolved by the host against live identities and SQLite, never by silently inventing ancestors.
 * V18: la validación completa corre en cada llamada (nada se recuerda entre llamadas) con bucles directos y
 * sin asignaciones; acepta exactamente lo mismo y lanza los mismos errores en el mismo orden que antes. */
export function assertLegacyRecord(value: unknown, atTick: number): asserts value is LegacyRecord {
  // Mismas condiciones y en el mismo orden que siempre (todas lanzan el mismo error; el orden sólo importa
  // para lo que puede lanzar por su cuenta, como el `String(role)` de un objeto ajeno).
  if (!integer(atTick) || !object(value) || !keysAre(value, RECORD_KEYS)
    || !identifier(value.id) || typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 80 || !printable(value.name)
    || !roleAccepted(value.role) || !integer(value.generation)
    || !Array.isArray(value.parents) || !parentsAccepted(value.parents, value.id, value.generation)
    || typeof value.bornAt !== 'number' || !Number.isSafeInteger(value.bornAt) || !integer(value.diedAt) || value.bornAt > value.diedAt || value.diedAt > atTick
    || !Number.isSafeInteger(value.diedAt - value.bornAt)
    || !causeAccepted(value.cause) || !object(value.genome) || !object(value.traits)
    || !(value.communityId === null || identifier(value.communityId))) fail();
  const record = value as unknown as LegacyRecord, genome = record.genome, traits = record.traits;
  if (!keysAre(genome, GENOME_KEYS) || !keysAre(traits, TRAIT_KEYS)) fail();
  if (!plainGenome(genome)) assertGenome(genome);
  const genomeParents = genome.parents, ownParents = record.parents;
  if (record.generation !== genome.generation || ownParents.length !== genomeParents.length) fail();
  for (let i = 0; i < ownParents.length; i++) if (ownParents[i] !== genomeParents[i] && i in ownParents) fail();
  const expression = demographicTraits(genome);
  if (traits.resilience !== expression.resilience || traits.foodDemand !== expression.foodDemand || traits.waterDemand !== expression.waterDemand
    || traits.maturityAge !== expression.maturityAge || traits.fertilityCooldown !== expression.fertilityCooldown) fail();
  if (!integer(traits.senescenceStart) || !integer(traits.maximumAge)
    || traits.maturityAge >= traits.senescenceStart || traits.senescenceStart >= traits.maximumAge) fail();
  if (record.cause === 'senescence' && record.diedAt - record.bornAt < traits.senescenceStart) fail();
}

/** Only dead references need a legacy row; living parent/inventor identities are in the snapshot. */
export function referencedLegacy(world: World): Set<string> {
  const required = new Set<string>();
  for (const person of world.people) {
    for (const parent of person.genome.parents) required.add(parent);
    const progenitor = (person.cuerpo?.gestacion ?? person.gestacion)?.otroId;
    if (progenitor !== undefined) required.add(progenitor);
  }
  for (const blueprint of world.blueprints) if (blueprint.inventorId !== null) required.add(blueprint.inventorId);
  for (const recipe of world.technology.recipes) required.add(recipe.inventorId);
  for (const person of world.people) required.delete(person.id);
  return required;
}

function identityValue(record: LegacyRecord): string {
  return stringifyExact([record.id, record.name, record.role, record.generation, record.parents, record.bornAt, record.diedAt, record.cause,
    record.genome.generation, record.genome.parents, record.genome.learningRate, record.genome.cooperation, record.genome.mutations, record.genome.alleles,
    TRAIT_KEYS.map(key => record.traits[key]), record.communityId]);
}

const hasToJSON = (value: unknown): boolean => typeof (value as { toJSON?: unknown } | null)?.toJSON === 'function';
/** Arreglos que `JSON.stringify` serializa igual si sus elementos son `Object.is` uno a uno (sin `toJSON`). */
function sameArray(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length || hasToJSON(a) || hasToJSON(b)) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}
/** `identityValue(a) === identityValue(b)`. El mismo objeto, o campos `Object.is` iguales, dan la misma
 * cadena exacta; ante cualquier diferencia decide la comparación de siempre. */
function sameIdentity(a: LegacyRecord, b: LegacyRecord): boolean {
  const ga = a.genome, gb = b.genome, ta = a.traits, tb = b.traits;
  if (a === b && !hasToJSON(a.parents) && !hasToJSON(ga.parents) && !hasToJSON(ga.alleles)) return true;
  if (Object.is(a.id, b.id) && Object.is(a.name, b.name) && Object.is(a.role, b.role) && Object.is(a.generation, b.generation)
    && Object.is(a.bornAt, b.bornAt) && Object.is(a.diedAt, b.diedAt) && Object.is(a.cause, b.cause) && Object.is(a.communityId, b.communityId)
    && Object.is(ga.generation, gb.generation) && Object.is(ga.learningRate, gb.learningRate) && Object.is(ga.cooperation, gb.cooperation)
    && Object.is(ga.mutations, gb.mutations) && Object.is(ta.resilience, tb.resilience) && Object.is(ta.foodDemand, tb.foodDemand)
    && Object.is(ta.waterDemand, tb.waterDemand) && Object.is(ta.maturityAge, tb.maturityAge) && Object.is(ta.fertilityCooldown, tb.fertilityCooldown)
    && Object.is(ta.senescenceStart, tb.senescenceStart) && Object.is(ta.maximumAge, tb.maximumAge)
    && sameArray(a.parents, b.parents) && sameArray(ga.parents, gb.parents) && sameArray(ga.alleles, gb.alleles)) return true;
  return identityValue(a) === identityValue(b);
}

const newestFirst = (a: LegacyRecord, b: LegacyRecord) => b.diedAt - a.diedAt || a.id.localeCompare(b.id);

/** Prunes only the read cache. The pending immutable archive queue is never shortened here.
 * V18: cada fila de la caché y de la cola se valida entera en cada paso, como siempre; la cola comparte
 * objetos con la caché (la muerte empuja el mismo registro a las dos y `cloneWorld` conserva esa
 * identidad), y un mismo objeto no necesita serializarse para saberse igual a sí mismo. */
export function retainLegacy(world: World): void {
  const required = referencedLegacy(world), records = new Map<string, LegacyRecord>(), tick = world.tick;
  const [cache, queue] = [world.legacy, world.retiredLegacy];
  for (const record of cache) {
    assertLegacyRecord(record, tick);
    if (records.has(record.id)) fail();
    records.set(record.id, record);
  }
  const pending = new Set<string>();
  for (const record of queue) {
    assertLegacyRecord(record, tick);
    const previous = records.get(record.id);
    if (pending.has(record.id) || previous && !sameIdentity(previous, record)) fail();
    pending.add(record.id); records.set(record.id, record);
  }
  const newest = Array.from(records.values()).sort(newestFirst);
  // Los ids de `newest` son únicos (claves del mapa): «entre los RECENT_LEGACY_COUNT primeros» es su posición.
  let kept = 0;
  for (let i = 0; i < newest.length; i++) {
    const record = newest[i]!;
    if (i < RECENT_LEGACY_COUNT || required.has(record.id)) newest[kept++] = record;
  }
  newest.length = kept;
  world.legacy = newest;
}

export function assertPopulation(world: World): void {
  if (!integer(world.tick) || !Array.isArray(world.people) || !Array.isArray(world.legacy) || !Array.isArray(world.retiredLegacy)) fail();
  const alive = new Set<string>();
  for (const person of world.people) {
    const state = person.demography;
    if (!identifier(person.id) || alive.has(person.id) || !object(state) || !keysAre(state, STATE_KEYS)
      || !integer(state.age) || state.age !== world.tick - person.bornAt || !unit(state.health) || state.health === 0 || !unit(state.vitality) || state.deathCause !== null) fail();
    alive.add(person.id);
  }
  const cache = new Map<string, LegacyRecord>(), pending = new Map<string, LegacyRecord>();
  for (const [records, index] of [[world.legacy, cache], [world.retiredLegacy, pending]] as const) for (const record of records) {
    assertLegacyRecord(record, world.tick);
    if (alive.has(record.id) || index.has(record.id)) fail();
    index.set(record.id, record);
  }
  // Identidades archivadas distintas: las de la caché más las pendientes que aún no están en ella.
  let archived = cache.size;
  for (const [id, record] of pending) {
    const cached = cache.get(id);
    if (cached === undefined) archived++;
    else if (!sameIdentity(cached, record)) fail();
  }
  const dynamics = world.demographyDynamics;
  if (!object(dynamics) || !keysAre(dynamics, DYNAMICS_KEYS) || !integer(dynamics.deaths)
    || !object(dynamics.causes) || !keysAre(dynamics.causes, CAUSES) || CAUSES.some(cause => !integer(dynamics.causes[cause]))
    || CAUSES.reduce((sum, cause) => sum + dynamics.causes[cause], 0) !== dynamics.deaths
    || ['foodLost', 'woodLost', 'stoneLost'].some(key => typeof dynamics[key as keyof typeof dynamics] !== 'number'
      || !Number.isFinite(dynamics[key as keyof typeof dynamics]) || (dynamics[key as keyof typeof dynamics] as number) < 0)
    || dynamics.deaths < archived) fail();
}

export interface PopulationCallbacks {
  emit: (event: Omit<ChronicleEvent, 'id' | 'tick'>) => void;
  /** Owns every estate transfer/loss. All simultaneous deaths have been marked before it runs. */
  beforeDeath?: (world: World, person: Person) => void;
  /** Las comunidades de un heap parcial son réplicas del coordinador. */
  comunidadesGlobales?: boolean;
}

function carriesEstate(person: Person): boolean {
  return person.inventory > 0 || person.materials.wood > 0 || person.materials.stone > 0
    || person.technology.items.some(item => item.mass > 0) || Object.values(person.technology.residue).some(mass => mass > 0);
}

/** Sólo deciden el coste, nunca el resultado: muestra con que se estima el grado medio de los vínculos y
 * cuántas muertes por vínculo medio hacen falta para que recorrer las claves salga más barato que sondear
 * (medido 2026-09-23 con vínculos copiados como en `cloneState`: entre 3 y 8 según el tamaño del objeto). */
const BOND_DEGREE_SAMPLE = 64, BOND_SCAN_RATIO = 4;
function sampledBondDegree(people: readonly Person[]): number {
  const m = Math.min(BOND_DEGREE_SAMPLE, people.length);
  let keys = 0;
  for (let k = 0; k < m; k++) keys += Object.keys(people[Math.floor(k * people.length / m)]!.bonds).length;
  return m ? keys / m : 0;
}

/** T142: borra de cada superviviente sus vínculos con los fallecidos. Mismo resultado que el bucle de siempre
 * (`delete` de cada id fallecido en cada superviviente): se borran exactamente las claves propias que son ids
 * fallecidos, y borrar nunca reordena las que quedan. Sólo cambia el coste: con pocas muertes se sondea
 * (vivos × muertes consultas, y `delete` sólo donde la clave existe); con muchas, cada superviviente recorre sus
 * claves una vez (Σ claves, independiente de las muertes). La reciprocidad de `bond()`/`convivir` no sirve de
 * índice inverso: el contrato admite vínculos unidireccionales y el mundo se clona en cada paso. */
export function pruneBonds(survivors: readonly Person[], departed: readonly Person[]): void {
  if (!departed.length) return;
  const ids = new Set(departed.map(person => person.id));
  if (ids.size > BOND_SCAN_RATIO && ids.size > BOND_SCAN_RATIO * (sampledBondDegree(survivors) + 1)) {
    for (const person of survivors) {
      let hits: string[] | undefined;
      for (const id of Object.keys(person.bonds)) if (ids.has(id)) (hits ??= []).push(id);
      if (hits) for (const id of hits) delete person.bonds[id];
    }
  } else for (const person of survivors) for (const id of ids) if (Object.hasOwn(person.bonds, id)) delete person.bonds[id];
}

/** One post-action tick. Bodies are evaluated simultaneously; this module creates neither
 * descendants nor resources, and a vacant population slot does not itself create a replacement. */
export function advancePopulation(world: World, callbacks: PopulationCallbacks): void {
  const archived = new Set([...world.legacy, ...world.retiredLegacy].map(record => record.id));
  if (world.people.some(person => archived.has(person.id))) throw new Error('Una identidad fallecida reapareció entre los habitantes vivos.');
  const structuresByCell = world.shelterBenefitEnabled ? new Map<string, StructureView[]>() : null;
  if (structuresByCell) for (const structure of world.structures) {
    if (!(structure.condition > BROKEN_CONDITION && structure.components.includes('roof'))) continue;
    const key = `${structure.x},${structure.y}`, bucket = structuresByCell.get(key);
    if (bucket) bucket.push(structure); else structuresByCell.set(key, [structure]);
  }
  const toolsActive = toolEffectsEnabled(world) && world.weather === 'rain' && world.shelterBenefitEnabled;
  const cloakWear: { person: Person; avoided: number }[] = [];
  // La ley del cuerpo es la del mundo durante todo el paso (nada en este bucle la cambia).
  const cuerpo = paramsOf(world).cuerpo, exposure = world.weather === 'rain' ? 1 : 0, wearTick = world.tick % 10 === 0;
  const transitions = world.people.map(person => {
    const tile = tileAt(world, person);
    const shelter = world.shelterBenefitEnabled && tile?.terrain === 'shelter' ? Math.max(0,
      ...(structuresByCell!.get(`${person.x},${person.y}`) ?? []).map(structure => structure.condition)) : 0;
    const traits = demographicTraits(person.genome, cuerpo);
    const bodyInput = { id: person.id, state: person.demography, traits,
      hunger: person.hunger, thirst: person.thirst, fatigue: person.fatigue, energy: person.energy };
    const envBase = { exposure, shelter, protected: person.role === 'S' || person.role === 'I',
      seed: world.seed, tick: world.tick, senescence: cuerpo };
    let effectiveShelter = shelter;
    if (toolsActive && shelter < 1) {
      // Sin objetos no hay abrigo: `itemCapacities([])` da 0 en todas las capacidades.
      const insul = person.technology.items.length ? portableInsulationPower(person) : 0;
      if (insul > 0) effectiveShelter = Math.min(1, shelter + insul * 0.55);
    }
    const transition = updateDemography(bodyInput, effectiveShelter === shelter ? envBase : { ...envBase, shelter: effectiveShelter }, 1);
    if (effectiveShelter > shelter && wearTick) {
      // El daño sin abrigo: `exposureDamage` es bit a bit el `damage.exposure` de la transición sin él.
      const avoided = Math.max(0, exposureDamage(bodyInput, envBase, 1) - transition.damage.exposure);
      if (avoided > 0) cloakWear.push({ person, avoided: avoided * 10 });
    }
    return { person, transition, traits };
  });
  for (const { person, avoided } of cloakWear) consumeInsulationTools(world, person, avoided);
  const dying = transitions.filter(result => result.transition.death !== null).sort((a, b) => a.person.id.localeCompare(b.person.id));
  if (!callbacks.beforeDeath && dying.some(result => carriesEstate(result.person))) throw new Error('Falta una liquidación explícita de los recursos del fallecido.');
  // Los rasgos del registro son los que acaban de decidir la muerte: mismo genoma y misma ley.
  const records = dying.map(({ person, transition, traits }): LegacyRecord => ({ id: person.id, name: person.name, role: person.role,
    generation: person.genome.generation, parents: [...person.genome.parents], bornAt: person.bornAt, diedAt: world.tick,
    cause: transition.death!, genome: structuredClone(person.genome), traits, communityId: person.communityId }));
  for (const record of records) assertLegacyRecord(record, world.tick);
  for (const { person, transition } of transitions) person.demography = transition.state;
  for (const { person } of dying) callbacks.beforeDeath?.(world, person);
  if (dying.length) {
    const departed = new Set(dying.map(result => result.person.id));
    world.people = world.people.filter(person => !departed.has(person.id));
    pruneBonds(world.people, dying.map(result => result.person));
    if (!callbacks.comunidadesGlobales) {
      const alive = new Set(world.people.map(person => person.id));
      for (const community of world.communities) community.members = community.members.filter(id => alive.has(id));
      world.communities = world.communities.filter(community => community.members.length > 0);
      const communities = new Set(world.communities.map(community => community.id));
      for (const person of world.people) if (person.communityId !== null && !communities.has(person.communityId)) person.communityId = null;
    }
    const dyingById = new Map<string, Person>(dying.map(result => [result.person.id, result.person]));
    for (const record of records) {
      world.legacy.push(record); world.retiredLegacy.push(record);
      world.demographyDynamics.deaths++; world.demographyDynamics.causes[record.cause]++;
      const person = dyingById.get(record.id)!;
      callbacks.emit({ kind: 'death', actors: [record.id], x: person.x, y: person.y, source: 'simulation',
        text: `Terminó la vida simulada de ${record.name}.`,
        cause: `Causa del modelo: ${record.cause}; evaluación posterior a las acciones. Su identidad y parentesco se conservan; no aparece un sustituto ni recursos nuevos.` });
    }
  }
  retainLegacy(world);
}
