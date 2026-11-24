/**
 * V18 — Demografía y linaje sin picos de latencia (Lane 5).
 *
 * Tres garantías, cada una contra una referencia que no depende del código optimizado:
 * 1. Determinismo bit a bit: `digestoCanonico` de escenarios con lluvia, refugios techados, abrigos
 *    portátiles, muertes de las cuatro causas, envejecimiento y legados es el que daba el código anterior
 *    a V18 (huellas capturadas con `af88d13`, antes de editar `lineage.ts`/`demography.ts`).
 * 2. Fail-closed: la copia LITERAL del código anterior (`original*`, abajo) es el oráculo. Para cada
 *    entrada —válida, corrupta o mutada en sitio entre dos llamadas— el código vigente tiene que aceptar
 *    lo mismo y lanzar el mismo tipo de error con el mismo mensaje.
 * 3. Coste: un paso de `advancePopulation` con 3 000 habitantes, 2 500 legados citados, 200 pendientes,
 *    600 refugios techados y lluvia, medido y acotado.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { DemographicActor, DemographicDeathCause, DemographicEnvironment, DemographicState, DemographicTraits,
  DemographicTransition, LegacyRecord, LongevityLaw, SenescenceLaw } from '../src/shared/demography.js';
import { DEMOGRAPHY_TICKS_PER_DAY, longevityAges } from '../src/shared/demography.js';
import type { StructureView } from '../src/shared/life.js';
import type { ChronicleEvent } from '../src/shared/types.js';
import { stringifyExact } from '../src/shared/exact-json.js';
import { createWorld, stepWorld, type Person, type World } from '../src/world/index.js';
import { demographicTraits, exposureDamage, initialDemography, updateDemography } from '../src/world/demography.js';
import { assertGenome, founderGenome, localRandom } from '../src/world/genetics.js';
import { BROKEN_CONDITION } from '../src/world/inventions.js';
import { advancePopulation, assertLegacyRecord, assertPopulation, referencedLegacy, retainLegacy, RECENT_LEGACY_COUNT } from '../src/world/lineage.js';
import { DEFAULT_PARAMS, paramsOf, parseParams, type WorldParams } from '../src/world/params.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { researchTechnology, technologyWorkCost } from '../src/world/technology.js';
import { advanceTechnologyCheckpoint } from '../src/world/technology-checkpoint.js';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';

// ───────────────────────────── Oráculo: código anterior a V18, literal ─────────────────────────────
// Copia de `src/world/lineage.ts` y `src/world/demography.ts` en `af88d13`. No se optimiza: es la
// definición de «exactamente como antes».

const O_CAUSES: readonly DemographicDeathCause[] = ['starvation', 'dehydration', 'exposure', 'senescence'];
const O_TRAIT_KEYS = ['resilience', 'foodDemand', 'waterDemand', 'maturityAge', 'fertilityCooldown', 'senescenceStart', 'maximumAge'] as const;
const O_GENOME_TRAIT_KEYS = ['resilience', 'foodDemand', 'waterDemand', 'maturityAge', 'fertilityCooldown'] as const;
const oObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const oUnit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const oInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const oIdentifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length < 50 && !/[\s\u0000-\u001f\u007f]/.test(value);
const oKeysAre = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const oFail = (): never => { throw new Error('Registro de identidad o población inválido.'); };

function originalDemographicTraits(genome: { alleles: readonly number[] }, longevity: Readonly<LongevityLaw> = DEFAULT_PARAMS.cuerpo): DemographicTraits {
  const nonNegative = (value: number) => Number.isFinite(value) && value >= 0;
  if (!Array.isArray(genome.alleles) || genome.alleles.length !== 14 || !genome.alleles.every(oUnit)) throw new RangeError('Alelos demográficos inválidos.');
  if (!(nonNegative(longevity.longevidadBaseDias) && nonNegative(longevity.longevidadPorResiliencia) && nonNegative(longevity.longevidadPorActividad)
    && nonNegative(longevity.senescenciaInicioFraccion))) throw new RangeError('Ley de longevidad inválida.');
  const resilience = (genome.alleles[8]! + genome.alleles[9]!) / 2;
  const activity = (genome.alleles[4]! + genome.alleles[5]!) / 2;
  const { maturityAge, senescenceStart, maximumAge } = longevityAges(resilience, activity, longevity);
  if (!(maturityAge < senescenceStart && senescenceStart < maximumAge)) {
    throw new RangeError(`Ley de longevidad degenerada: madurez ${maturityAge}, inicio de vejez ${senescenceStart}, edad máxima ${maximumAge} ticks. Revisa cuerpo.longevidad* y cuerpo.senescenciaInicioFraccion.`);
  }
  return { resilience, foodDemand: 0.85 + resilience * 0.4 + activity * 0.2,
    waterDemand: 1.15 - resilience * 0.35 + activity * 0.15,
    maturityAge,
    fertilityCooldown: Math.round((0.8 + resilience * 0.5 + activity * 0.1) * DEMOGRAPHY_TICKS_PER_DAY),
    senescenceStart, maximumAge };
}

function originalAssertLegacyRecord(value: unknown, atTick: number): asserts value is LegacyRecord {
  if (!oInteger(atTick) || !oObject(value) || !oKeysAre(value, ['id', 'name', 'role', 'generation', 'parents', 'bornAt', 'diedAt', 'cause', 'genome', 'traits', 'communityId'])
    || !oIdentifier(value.id) || typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 80 || /[\u0000-\u001f\u007f]/.test(value.name)
    || !['S', 'I', 'neighbor'].includes(String(value.role)) || !oInteger(value.generation)
    || !Array.isArray(value.parents) || !value.parents.every(oIdentifier) || value.parents.includes(value.id) || new Set(value.parents).size !== value.parents.length
    || (value.generation === 0 ? value.parents.length !== 0 : value.parents.length !== 2)
    || typeof value.bornAt !== 'number' || !Number.isSafeInteger(value.bornAt) || !oInteger(value.diedAt) || value.bornAt > value.diedAt || value.diedAt > atTick
    || !Number.isSafeInteger(value.diedAt - value.bornAt)
    || !O_CAUSES.includes(value.cause as DemographicDeathCause) || !oObject(value.genome) || !oObject(value.traits)
    || !(value.communityId === null || oIdentifier(value.communityId))) oFail();
  const record = value as unknown as LegacyRecord;
  if (!oKeysAre(record.genome as unknown as Record<string, unknown>, ['generation', 'parents', 'learningRate', 'cooperation', 'mutations', 'alleles'])
    || !oKeysAre(record.traits as unknown as Record<string, unknown>, O_TRAIT_KEYS)) oFail();
  assertGenome(record.genome);
  if (record.generation !== record.genome.generation || record.parents.length !== record.genome.parents.length
    || record.parents.some((id, index) => id !== record.genome.parents[index])) oFail();
  const expression = originalDemographicTraits(record.genome);
  if (O_GENOME_TRAIT_KEYS.some(key => record.traits[key] !== expression[key])) oFail();
  if (!oInteger(record.traits.senescenceStart) || !oInteger(record.traits.maximumAge)
    || record.traits.maturityAge >= record.traits.senescenceStart || record.traits.senescenceStart >= record.traits.maximumAge) oFail();
  if (record.cause === 'senescence' && record.diedAt - record.bornAt < record.traits.senescenceStart) oFail();
}

function originalIdentityValue(record: LegacyRecord): string {
  return stringifyExact([record.id, record.name, record.role, record.generation, record.parents, record.bornAt, record.diedAt, record.cause,
    record.genome.generation, record.genome.parents, record.genome.learningRate, record.genome.cooperation, record.genome.mutations, record.genome.alleles,
    O_TRAIT_KEYS.map(key => record.traits[key]), record.communityId]);
}

function originalRetainLegacy(world: World): void {
  const required = referencedLegacy(world), records = new Map<string, LegacyRecord>();
  for (const source of [world.legacy, world.retiredLegacy]) {
    const seen = new Set<string>();
    for (const record of source) {
      originalAssertLegacyRecord(record, world.tick);
      const previous = records.get(record.id);
      if (seen.has(record.id) || previous && originalIdentityValue(previous) !== originalIdentityValue(record)) oFail();
      seen.add(record.id); records.set(record.id, record);
    }
  }
  const newest = [...records.values()].sort((a, b) => b.diedAt - a.diedAt || a.id.localeCompare(b.id));
  const recent = new Set(newest.slice(0, RECENT_LEGACY_COUNT).map(record => record.id));
  const retained = newest.filter(record => required.has(record.id) || recent.has(record.id));
  world.legacy = retained;
}

function originalAssertPopulation(world: World): void {
  if (!oInteger(world.tick) || !Array.isArray(world.people) || !Array.isArray(world.legacy) || !Array.isArray(world.retiredLegacy)) oFail();
  const alive = new Set<string>();
  for (const person of world.people) {
    const state = person.demography;
    if (!oIdentifier(person.id) || alive.has(person.id) || !oObject(state) || !oKeysAre(state, ['age', 'health', 'vitality', 'deathCause'])
      || !oInteger(state.age) || state.age !== world.tick - person.bornAt || !oUnit(state.health) || state.health === 0 || !oUnit(state.vitality) || state.deathCause !== null) oFail();
    alive.add(person.id);
  }
  const cache = new Map<string, LegacyRecord>(), pending = new Map<string, LegacyRecord>();
  for (const [records, index] of [[world.legacy, cache], [world.retiredLegacy, pending]] as const) for (const record of records) {
    originalAssertLegacyRecord(record, world.tick);
    if (alive.has(record.id) || index.has(record.id)) oFail();
    index.set(record.id, record);
  }
  for (const [id, record] of pending) if (cache.has(id) && originalIdentityValue(cache.get(id)!) !== originalIdentityValue(record)) oFail();
  const dynamics = world.demographyDynamics;
  if (!oObject(dynamics) || !oKeysAre(dynamics, ['deaths', 'causes', 'foodLost', 'woodLost', 'stoneLost']) || !oInteger(dynamics.deaths)
    || !oObject(dynamics.causes) || !oKeysAre(dynamics.causes, O_CAUSES) || O_CAUSES.some(cause => !oInteger(dynamics.causes[cause]))
    || O_CAUSES.reduce((sum, cause) => sum + dynamics.causes[cause], 0) !== dynamics.deaths
    || ['foodLost', 'woodLost', 'stoneLost'].some(key => typeof dynamics[key as keyof typeof dynamics] !== 'number'
      || !Number.isFinite(dynamics[key as keyof typeof dynamics]) || (dynamics[key as keyof typeof dynamics] as number) < 0)
    || dynamics.deaths < new Set([...cache.keys(), ...pending.keys()]).size) oFail();
}

const O_MAX_DT = DEMOGRAPHY_TICKS_PER_DAY, O_HEALTH_FLOOR = 0.05, O_VITALITY_FLOOR = 0.08, O_WEAR = 0.8, O_RELIEF = 0.4;
const oClamp = (value: number) => Math.max(0, Math.min(1, value));
const oNonNegative = (value: number) => Number.isFinite(value) && value >= 0;
const oPositiveSafe = (value: number) => Number.isSafeInteger(value) && value > 0;
function originalValidate(actor: DemographicActor, environment: DemographicEnvironment, dt: number): void {
  const state = actor.state, traits = actor.traits, law = environment.senescence;
  if (!Number.isFinite(dt) || dt < 0 || dt > O_MAX_DT || !state || !traits
    || !(oUnit(actor.hunger) && oUnit(actor.thirst) && oUnit(actor.energy) && oUnit(actor.fatigue) && oUnit(state.health) && oUnit(state.vitality)
      && oUnit(environment.exposure) && oUnit(environment.shelter) && oUnit(traits.resilience))
    || typeof environment.protected !== 'boolean' || !Number.isFinite(state.age) || state.age < 0 || state.age + dt > Number.MAX_SAFE_INTEGER
    || (actor.id !== undefined && (typeof actor.id !== 'string' || actor.id.length === 0))
    || (environment.seed !== undefined && !Number.isInteger(environment.seed))
    || (environment.tick !== undefined && !Number.isFinite(environment.tick))
    || (law !== undefined && (typeof law !== 'object' || law === null
      || !(oNonNegative(law.riesgoSenescenciaDiario) && oNonNegative(law.riesgoSenescenciaPendiente))
      || !oUnit(law.cuidadoReduceRiesgo)))
    || (state.deathCause !== null && !O_CAUSES.includes(state.deathCause)) || ((state.health === 0) !== (state.deathCause !== null))
    || !Number.isFinite(traits.foodDemand) || traits.foodDemand <= 0 || traits.foodDemand > 3
    || !Number.isFinite(traits.waterDemand) || traits.waterDemand <= 0 || traits.waterDemand > 3
    || !(oPositiveSafe(traits.maturityAge) && oPositiveSafe(traits.fertilityCooldown) && oPositiveSafe(traits.senescenceStart) && oPositiveSafe(traits.maximumAge))
    || traits.maturityAge >= traits.senescenceStart || traits.senescenceStart >= traits.maximumAge) throw new RangeError('Estado, entorno o intervalo demográfico inválido.');
}
function oEligible(actor: DemographicActor, state: DemographicState): boolean {
  return state.deathCause === null && state.age >= actor.traits.maturityAge && state.age < actor.traits.senescenceStart
    && state.health >= 0.55 && state.vitality >= 0.5 && actor.hunger <= 0.45 && actor.thirst <= 0.45 && actor.energy >= 0.6 && actor.fatigue <= 0.65;
}
function oSenescenceDamage(startAge: number, endAge: number, traits: Readonly<DemographicTraits>): number {
  const width = traits.maximumAge - traits.senescenceStart;
  const primitive = (age: number) => Math.pow(Math.max(0, Math.min(age, traits.maximumAge) - traits.senescenceStart), 3) / (3 * width * width);
  return (primitive(endAge) - primitive(startAge)) * O_WEAR / DEMOGRAPHY_TICKS_PER_DAY;
}
function oMortalityRisk(startAge: number, endAge: number, traits: Readonly<DemographicTraits>, care: number, law: Readonly<SenescenceLaw>): number {
  const a0 = Math.max(startAge, traits.senescenceStart), a1 = Math.max(endAge, traits.senescenceStart);
  const rate = law.riesgoSenescenciaDiario, slope = law.riesgoSenescenciaPendiente;
  if (a1 <= a0 || rate <= 0) return 0;
  const geneRelief = 1 - traits.resilience * O_RELIEF;
  let hazard: number;
  if (slope <= Number.EPSILON) hazard = rate * geneRelief * (a1 - a0) / DEMOGRAPHY_TICKS_PER_DAY;
  else {
    const exponent = (age: number) => slope * ((age - traits.maximumAge) / traits.maximumAge - law.cuidadoReduceRiesgo * care);
    if (exponent(a1) >= 700) return 1;
    const span = Math.exp(exponent(a1)) - Math.exp(exponent(a0));
    if (!(span > 0)) return 0;
    hazard = rate * geneRelief * (traits.maximumAge / (DEMOGRAPHY_TICKS_PER_DAY * slope)) * span;
  }
  if (!(hazard > 0)) return 0;
  return Number.isFinite(hazard) ? oClamp(1 - Math.exp(-hazard)) : 1;
}
function originalUpdateDemography(actor: DemographicActor, environment: DemographicEnvironment, dt = 1): DemographicTransition {
  originalValidate(actor, environment, dt);
  const state = { ...actor.state }, damage = { starvation: 0, dehydration: 0, exposure: 0, senescence: 0 };
  if (state.deathCause !== null) return { state, death: state.deathCause, preventedDeath: null, offspringEligible: false, senescenceRisk: 0, damage };
  if (dt === 0) return { state, death: null, preventedDeath: null, offspringEligible: oEligible(actor, state), senescenceRisk: 0, damage };
  const days = dt / DEMOGRAPHY_TICKS_PER_DAY, traits = actor.traits, law = environment.senescence;
  const { id } = actor, { seed, tick } = environment;
  if (id === undefined || seed === undefined || tick === undefined || law === undefined) {
    throw new RangeError('Avanzar un cuerpo exige id, semilla, tick y ley de senescencia explícitos.');
  }
  const hungry = oClamp((actor.hunger - 0.72) / 0.28), thirsty = oClamp((actor.thirst - 0.7) / 0.3);
  const exposure = environment.exposure * (1 - environment.shelter), resistance = 1 - traits.resilience * 0.7;
  const nourishment = oClamp((0.65 - actor.hunger) / 0.55) * oClamp((0.6 - actor.thirst) / 0.5);
  const recovery = nourishment * (0.15 + actor.energy * 0.2) * (1 - actor.fatigue * 0.5);
  const strain = hungry * 0.65 * traits.foodDemand + thirsty * traits.waterDemand + exposure * resistance * 0.2
    + actor.fatigue * (1 - actor.energy) * 0.08;
  state.vitality = oClamp(state.vitality + (recovery - strain) * days);
  const care = oClamp(actor.state.health * actor.state.vitality);
  const vulnerability = 1 + (1 - (actor.state.vitality + state.vitality) / 2) * 0.75;
  damage.starvation = hungry * hungry * 1.3 * traits.foodDemand * days * vulnerability;
  damage.dehydration = thirsty * thirsty * 2 * traits.waterDemand * days * vulnerability;
  damage.exposure = exposure * resistance * 0.48 * days * vulnerability;
  state.age += dt;
  damage.senescence = oSenescenceDamage(actor.state.age, state.age, traits);
  const aging = oClamp((state.age - traits.senescenceStart) / (traits.maximumAge - traits.senescenceStart));
  const healing = nourishment * actor.energy * state.vitality * 0.08 * (1 - aging) * days;
  state.health = oClamp(state.health + healing - (0 + damage.starvation + damage.dehydration + damage.exposure + damage.senescence));
  let death: DemographicDeathCause | null = null;
  const senescenceRisk = oMortalityRisk(actor.state.age, state.age, traits, care, law);
  if (state.health <= 0) death = [...O_CAUSES].sort((a, b) => damage[b] - damage[a])[0]!;
  else if (senescenceRisk > 0 && localRandom(seed, `senescence:${id}:${tick}`)() < senescenceRisk) {
    damage.senescence += state.health; state.health = 0; death = 'senescence';
  }
  if (death && environment.protected) {
    state.health = Math.max(O_HEALTH_FLOOR, state.health); state.vitality = Math.max(O_VITALITY_FLOOR, state.vitality);
    return { state, death: null, preventedDeath: death, offspringEligible: false, senescenceRisk, damage };
  }
  if (death) { state.deathCause = death; state.vitality = 0; }
  return { state, death, preventedDeath: null, offspringEligible: oEligible(actor, state), senescenceRisk, damage };
}

// ───────────────────────────────────────── Utilidades ─────────────────────────────────────────

type Outcome = { ok: true; value: unknown } | { ok: false; error: string };
function outcome(fn: () => unknown): Outcome {
  try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, error: `${(error as Error).constructor.name}: ${(error as Error).message}` }; }
}
/** Mismo veredicto (y mismo valor, con `-0` y `NaN` distinguidos por `deepStrictEqual`). */
function sameOutcome(label: string, current: () => unknown, original: () => unknown): Outcome {
  const a = outcome(current), b = outcome(original);
  assert.deepStrictEqual(a, b, `${label}: el código vigente no da el veredicto del código anterior`);
  return a;
}
function mulberry32(seed: number) {
  return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function emitFor(world: World) {
  return (event: Omit<ChronicleEvent, 'id' | 'tick'>): ChronicleEvent => {
    const result = { ...event, id: `e${++world.eventCounter}`, tick: world.tick }; world.events.push(result); return result;
  };
}
/** Liquidación controlada (como en tests/lineage.test.ts): lo no heredado se contabiliza como pérdida. */
function settle(host: World, person: Person) {
  host.demographyDynamics.foodLost += person.inventory; host.demographyDynamics.woodLost += person.materials.wood; host.demographyDynamics.stoneLost += person.materials.stone;
  person.inventory = 0; person.materials.wood = person.materials.stone = 0;
}
function legacyRecord(seed: number, index: number, diedAt: number, bornAt = diedAt - 3000): LegacyRecord {
  const id = `dead-${seed}-${index}`;
  const genes = founderGenome(seed, id, { curiosity: 0.5, sociability: 0.5, industriousness: (index % 7) / 7, care: 0.5, resilience: (index % 11) / 11 });
  return { id, name: `Antecesor ${index}`, role: 'neighbor', generation: 0, parents: [], bornAt, diedAt,
    cause: (['starvation', 'dehydration', 'exposure'] as const)[index % 3]!, genome: genes, traits: demographicTraits(genes), communityId: index % 4 ? null : `c-${index % 9}` };
}
function structure(id: string, x: number, y: number, condition: number, components: StructureView['components']): StructureView {
  return { id, x, y, blueprintId: 'blueprint-base', name: id, components, condition, water: 0, food: 0, uses: 0, builtAt: 0, builderId: null };
}
/** Capa tejida fabricada por las leyes físicas (como tests/v16-insulation-demography.test.ts). */
function grantCloak(world: World, person: Person) {
  person.materials.wood = 4; person.energy = 1; person.fatigue = 0;
  const program = {
    inputs: [{ source: 'raw' as const, material: 'wood' as const, mass: 1000 }],
    steps: [{ op: 'form' as const, intensity: 4 as const, shape: 'sheet' as const }, { op: 'weave' as const, intensity: 4 as const }, { op: 'weave' as const, intensity: 4 as const }],
  };
  person.technology.project = { kind: 'research', program, parents: [], recipeId: null, progress: 0, requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: world.tick };
  for (let i = 0; i < 60 && person.technology.project; i++) researchTechnology(world, person);
  advanceTechnologyCheckpoint(world.technology, world.people, world.tick);
  assert.ok(person.technology.items.length > 0, 'la capa debe fabricarse');
}

/** Población sintética para `advancePopulation`: edades mezcladas (jóvenes, adultos y viejos cerca de la
 * edad máxima), cuerpos con hambre/sed que empeoran, protegidos S/I, refugios con techo sano, roto y sin
 * techo, abrigos portátiles, legados citados por padres vivos y cola pendiente compartida. */
function populate(world: World, seed: number, count: number, options: { cloaks: number; dead: number; shelters: number; pending: number }) {
  const random = mulberry32(seed), templates = world.people;
  world.tick = 9600; world.communities = []; world.weather = 'rain'; world.shelterBenefitEnabled = true;
  const land = world.tiles.filter(tile => tile.terrain !== 'water');
  const shelterCells = land.slice(0, options.shelters);
  for (const tile of shelterCells) tile.terrain = 'shelter';
  const openCells = land.slice(options.shelters);
  world.structures = [];
  shelterCells.forEach((cell, k) => {
    world.structures.push(structure(`roof-${k}`, cell.x, cell.y, 0.2 + 0.75 * random(), ['frame', 'roof']));
    if (k % 3 === 0) world.structures.push(structure(`roof-low-${k}`, cell.x, cell.y, 0.1 + 0.2 * random(), ['frame', 'roof']));
    if (k % 5 === 1) world.structures.push(structure(`broken-${k}`, cell.x, cell.y, BROKEN_CONDITION, ['frame', 'roof']));
    if (k % 7 === 2) world.structures.push(structure(`roofless-${k}`, cell.x, cell.y, 0.99, ['frame']));
  });
  const dead = Array.from({ length: options.dead }, (_, index) => legacyRecord(seed, index, 4000 + Math.floor(index * 5000 / Math.max(1, options.dead)) + (index % 3)));
  const people: Person[] = [];
  for (let k = 0; k < count; k++) {
    const person = structuredClone(templates[k % templates.length]!);
    if (k >= 2) { person.role = 'neighbor'; }
    else person.role = k === 0 ? 'S' : 'I';
    person.id = `v-${seed}-${k}`; person.name = `Habitante ${k}`;
    person.genome = founderGenome(seed, person.id, { curiosity: random(), sociability: random(), industriousness: random(), care: random(), resilience: random() });
    if (dead.length >= 2 && k % 4 !== 3) {
      const a = dead[(k * 7) % dead.length]!.id, b = dead[(k * 13 + 1) % dead.length]!.id;
      if (a !== b) person.genome = { ...person.genome, generation: 1, parents: [a, b] };
    }
    const traits = demographicTraits(person.genome, DEFAULT_PARAMS.cuerpo);
    const band = k % 6;
    const age = band === 0 ? Math.floor(traits.maximumAge * (1.6 + 0.4 * random())) : band === 1 ? traits.senescenceStart + Math.floor(random() * 300)
      : 300 + Math.floor(random() * 2000);
    person.bornAt = world.tick - age;
    // Banda 3: cuerpos frágiles (a la intemperie si k es impar), para que la lluvia mate por exposición.
    person.demography = { ...initialDemography(age), health: band === 3 ? 0.01 + 0.08 * random() : 0.25 + 0.75 * random(), vitality: 0.3 + 0.7 * random() };
    person.hunger = k % 5 === 0 ? 0.85 + 0.15 * random() : 0.1 + 0.4 * random();
    person.thirst = k % 7 === 0 ? 0.8 + 0.2 * random() : 0.1 + 0.4 * random();
    person.fatigue = random() * 0.8; person.energy = 0.2 + 0.8 * random();
    person.inventory = k % 9 === 0 ? 0.3 : 0; person.materials = { wood: k % 11 === 0 ? 2 : 0, stone: 0 };
    person.communityId = null; person.bonds = {};
    const cell = k % 2 === 0 ? shelterCells[k % shelterCells.length]! : openCells[k % openCells.length]!;
    person.x = cell.x; person.y = cell.y; person.target = { x: cell.x, y: cell.y };
    people.push(person);
  }
  for (let k = 0; k < count; k++) for (let j = 1; j <= 3; j++) people[k]!.bonds[people[(k + j * 17) % count]!.id] = 0.2 + 0.1 * j;
  world.people = people;
  world.legacy = [...dead];
  world.retiredLegacy = dead.slice(-options.pending);
  world.demographyDynamics.deaths = world.demographyDynamics.causes.starvation = dead.length;
  for (let k = 0; k < options.cloaks; k++) {
    const person = people[1 + 2 * k]!; // posiciones impares: a la intemperie
    const { hunger, thirst, fatigue, energy, materials } = person;
    grantCloak(world, person);
    Object.assign(person, { hunger, thirst, fatigue, energy, materials: { ...materials } });
  }
}

interface Escenario { digest: string; deaths: number; causes: World['demographyDynamics']['causes']; people: number; legacy: number; wornCloaks: number }
function escenario(seed: number, params: WorldParams, ticks = 300): Escenario {
  const world = createWorld(seed, params), cloaks = paramsOf(world).tecnologia.efectosHerramientas ? 6 : 0;
  populate(world, seed, 48, { cloaks, dead: 40, shelters: 12, pending: 10 });
  const emit = emitFor(world), masses = () => world.people.reduce((sum, person) => sum + person.technology.items.reduce((s, item) => s + item.mass, 0), 0);
  const before = masses();
  for (let t = 1; t <= ticks; t++) {
    world.tick++;
    world.weather = t % 7 < 5 ? 'rain' : 'clear';
    world.people.forEach((person, slot) => { if (slot % 3 === 2) { person.hunger = Math.min(1, person.hunger + 0.003); person.thirst = Math.min(1, person.thirst + 0.0025); } });
    advancePopulation(world, { emit, beforeDeath: settle });
  }
  assertPopulation(world); originalAssertPopulation(world);
  return { digest: digestoCanonico(world), deaths: world.demographyDynamics.deaths, causes: { ...world.demographyDynamics.causes },
    people: world.people.length, legacy: world.legacy.length, wornCloaks: before - masses() };
}
const OPEN = (() => {
  const base = hostOpenWorldParams(DEFAULT_PARAMS, { cpuThreads: () => 4, totalRamBytes: () => 32 * 1024 ** 3, nvrtcAvailable: () => false, nvidiaSmi: () => null });
  return parseParams({ motor: { ...base.motor, hilos: 1, gpu: [], particionarPersonas: false } }, base);
})();
const DEFAULT_TOOLS = parseParams('tecnologia.efectosHerramientas=true', DEFAULT_PARAMS);
const OPEN_SHORT = parseParams('cuerpo.longevidadBaseDias=4', OPEN);
const SEEDS = [11, 431, 51926] as const;

/** Huellas del código anterior (`af88d13`), capturadas antes de editar. */
const GOLDEN_ESCENARIO: Record<string, string> = {
  'default/11': '6d452dd7d075bcb4534132cb55e5360b9e5e31b39f7596724e740b3fa1ab4ef2',
  'default/431': '586f565337b85c97d89f489302fb117b45a23d7b2ac523248e66ed1e00f36f7e',
  'default/51926': 'c90ecf23fd5260312607854173ad26b5e9d6ea18f313058337f0fa01809fd07f',
  'default+herramientas/11': '4e47e00490f130430c2fa3437f896f29b0e4e086bf091e50509f1a1fbbf7e93d',
  'default+herramientas/431': '1d781f2fce3cc4b474686d2cc753f8221bb8b22d891f570a4807642b18a17369',
  'default+herramientas/51926': 'e288fdc24f6b732b0323874864e8b40a5382af1040af6f6515ff37de92194787',
  'openWorld/11': '813159ee65bdbb67fd1ccb0800a565d753deef41e48184241d44643c71655c62',
  'openWorld/431': 'a8d64fbf6681d445b373f1e2ca9105d5ad90e0850185150c5bf0a09e4631e081',
  'openWorld/51926': '14913efd69b97cf0977a9a7be7c42a10e0523176011ea334ca48d35530259539',
};
const GOLDEN_MUNDO: Record<string, string> = {
  'default/11': '04eccae9f6fff9bce0ee9ba14a4579eb93d96b83eba76252b0c63b27f202bd0a',
  'default/431': '06970b808b833c01a4e94bf14f17ae67b37c45fd910988db8bf28e62dea34aa3',
  'default/51926': '7d70c818adac9efbc90a91d50b4bed6fadd9d9c97fe36bd6a7cce996e304c4d5',
  // `openWorld-corta` activa derivaCultural=1 (fisión Dunbar, stewardship y proceduralPersonName V18).
  'openWorld-corta/11': 'f06462e0e34a1f2b07199de9d94ad822043dc0aa199e0eb2ff55e5be119e0ea4',
  'openWorld-corta/431': '371e0495628af29c878292bc6cc4d75aee4771e3b5d31616ffb4cf00e2b4bb44',
  'openWorld-corta/51926': '5a52c5c5b54b2409e90f92157e327d9bb0c72526bd5ffde466086980251badb9',
};
const capture = process.env.V18_CAPTURE === '1';

// ─────────────────────────────────────── 1. Determinismo ───────────────────────────────────────

// paridad histórica: cuarentena V23
test.skip('V18 determinismo: advancePopulation con lluvia, refugios, abrigos, muertes y vejez da el digestoCanonico de siempre (3 semillas × 300 pasos × 3 leyes)', t => {
  const seen: Record<string, unknown> = {};
  for (const [name, params] of [['default', DEFAULT_PARAMS], ['default+herramientas', DEFAULT_TOOLS], ['openWorld', OPEN]] as const) for (const seed of SEEDS) {
    const key = `${name}/${seed}`, result = escenario(seed, params);
    seen[key] = result;
    if (capture) t.diagnostic(`${key} ${JSON.stringify(result)}`);
    assert.ok(result.deaths > 46, `${key}: el escenario debe matar (${result.deaths})`);
    assert.ok(result.causes.senescence > 0 && result.causes.dehydration + result.causes.exposure > 0 && result.causes.starvation > 40, `${key}: varias causas (${JSON.stringify(result.causes)})`);
    if (name !== 'default') assert.ok(result.wornCloaks > 0, `${key}: los abrigos deben desgastarse (${result.wornCloaks})`);
    if (!capture) assert.equal(result.digest, GOLDEN_ESCENARIO[key], `${key}: cambió el mundo`);
  }
  t.diagnostic(JSON.stringify(seen));
  if (capture) t.diagnostic(`GOLDEN_ESCENARIO=${JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, (v as Escenario).digest])))}`);
});

// paridad histórica: cuarentena V23
test.skip('V18 determinismo: mundos completos (stepWorld) con DEFAULT_PARAMS y hostOpenWorldParams de longevidad corta dan el digestoCanonico de siempre', t => {
  const seen: Record<string, string> = {};
  for (const [name, params] of [['default', DEFAULT_PARAMS], ['openWorld-corta', OPEN_SHORT]] as const) for (const seed of SEEDS) {
    const world = createWorld(seed, params);
    for (let tick = 0; tick < 300; tick++) stepWorld(world);
    const key = `${name}/${seed}`; seen[key] = digestoCanonico(world);
    if (!capture) assert.equal(seen[key], GOLDEN_MUNDO[key], `${key}: cambió el mundo`);
  }
  t.diagnostic(`GOLDEN_MUNDO=${JSON.stringify(seen)}`);
});

test('V18 exposición evitada: exposureDamage coincide bit a bit con damage.exposure de updateDemography (20 000 cuerpos, todas las ramas)', () => {
  const random = mulberry32(18), law = DEFAULT_PARAMS.cuerpo;
  const pick = (values: readonly number[]) => values[Math.floor(random() * values.length)]!;
  const edge = [0, -0, 1, 0.5, Number.MIN_VALUE, 1 - Number.EPSILON / 2, 0.72, 0.7, 0.65, 0.6];
  for (let k = 0; k < 20_000; k++) {
    const genome = founderGenome(k, `x-${k}`, { curiosity: random(), sociability: random(), industriousness: random(), care: random(), resilience: random() });
    const traits = demographicTraits(genome, law);
    const r = () => random() < 0.2 ? pick(edge) : random();
    const dead = random() < 0.03;
    const actor: DemographicActor = { id: `x-${k}`, traits, hunger: r(), thirst: r(), energy: r(), fatigue: r(),
      state: dead ? { age: 100, health: 0, vitality: 0, deathCause: 'exposure' } : { age: Math.floor(random() * traits.maximumAge * 1.3), health: random() < 0.1 ? 1 : r() || 0.5, vitality: r(), deathCause: null } };
    const environment: DemographicEnvironment = { exposure: random() < 0.8 ? 1 : r(), shelter: r(), protected: random() < 0.2, seed: k, tick: k * 3, senescence: law };
    const dt = random() < 0.05 ? 0 : random() < 0.9 ? 1 : 1 + Math.floor(random() * 239);
    const full = originalUpdateDemography(actor, environment, dt).damage.exposure;
    assert.ok(Object.is(exposureDamage(actor, environment, dt), full), `cuerpo ${k}: ${exposureDamage(actor, environment, dt)} != ${full}`);
    assert.ok(Object.is(updateDemography(actor, environment, dt).damage.exposure, full));
  }
  // Y rechaza lo mismo que updateDemography.
  const genome = founderGenome(1, 'bad', { curiosity: 0.5, sociability: 0.5, industriousness: 0.5, care: 0.5, resilience: 0.5 });
  const good: DemographicActor = { id: 'bad', traits: demographicTraits(genome), hunger: 0.2, thirst: 0.2, energy: 0.8, fatigue: 0.1, state: initialDemography(500) };
  const env: DemographicEnvironment = { exposure: 1, shelter: 0.3, protected: false, seed: 1, tick: 1, senescence: law };
  for (const [actor, environment, dt] of [
    [{ ...good, hunger: Number.NaN }, env, 1], [good, { ...env, shelter: 1.5 }, 1], [good, { ...env, shelter: -0.1 }, 1], [good, env, 241], [good, env, -1],
    [{ ...good, id: undefined }, env, 1], [good, { ...env, seed: undefined }, 1], [good, { ...env, senescence: undefined }, 1], [{ ...good, id: '' }, env, 1],
  ] as [DemographicActor, DemographicEnvironment, number][]) {
    sameOutcome('exposureDamage inválido', () => exposureDamage(actor, environment, dt), () => originalUpdateDemography(actor, environment, dt).damage.exposure);
  }
});

// ─────────────────────────────────────── 2. Fail-closed ───────────────────────────────────────

function validRecord(): LegacyRecord { return legacyRecord(431, 4, 5, -4800); }
type Mutation = [string, (record: Record<string, any>) => void];
const RECORD_MUTATIONS: Mutation[] = [
  ['sin cambios', () => {}],
  ...(['id', 'name', 'role', 'generation', 'parents', 'bornAt', 'diedAt', 'cause', 'genome', 'traits', 'communityId'] as const).map((key): Mutation => [`falta ${key}`, r => { delete r[key]; }]),
  ['clave extra', r => { r.privateHistory = 'x'; }],
  ['clave extra no enumerable', r => { Object.defineProperty(r, 'hidden', { value: 1, enumerable: false }); }],
  ['clave obligatoria no enumerable', r => { const v = r.name; delete r.name; Object.defineProperty(r, 'name', { value: v, enumerable: false }); }],
  ['no enumerable + extra enumerable', r => { const v = r.name; delete r.name; Object.defineProperty(r, 'name', { value: v, enumerable: false }); r.extra = 1; }],
  ['prototipo ajeno heredado', r => { Object.setPrototypeOf(r, { inherited: 1, id: 'proto' }); }],
  ['prototipo nulo', r => { Object.setPrototypeOf(r, null); }],
  ['clave símbolo', r => { r[Symbol('s') as unknown as string] = 1; }],
  ['id vacío', r => { r.id = ''; }], ['id 50', r => { r.id = 'x'.repeat(50); }], ['id 49', r => { r.id = 'x'.repeat(49); }],
  ['id con espacio', r => { r.id = 'a b'; }], ['id con control', r => { r.id = 'a\u0007'; }], ['id con DEL', r => { r.id = 'a\u007f'; }], ['id con NBSP', r => { r.id = 'a b'; }],
  ['id número', r => { r.id = 5; }], ['id String objeto', r => { r.id = new String('abc'); }],
  ['name vacío', r => { r.name = ''; }], ['name 80', r => { r.name = 'n'.repeat(80); }], ['name 81', r => { r.name = 'n'.repeat(81); }],
  ['name control', r => { r.name = 'a\nb'; }], ['name con espacio', r => { r.name = 'Ana María'; }], ['name número', r => { r.name = 7; }],
  ['role S', r => { r.role = 'S'; }], ['role I', r => { r.role = 'I'; }], ['role malo', r => { r.role = 'king'; }],
  ['role objeto con toString', r => { r.role = { toString: () => 'S' }; }], ['role array', r => { r.role = ['neighbor']; }],
  ['generation -1', r => { r.generation = -1; }], ['generation 1.5', r => { r.generation = 1.5; }], ['generation NaN', r => { r.generation = Number.NaN; }],
  ['generation "0"', r => { r.generation = '0'; }], ['generation -0', r => { r.generation = -0; }],
  ['parents no array', r => { r.parents = 'ab'; }], ['parents con padre con generación 0', r => { r.parents = ['p-a', 'p-b']; }],
  ['hijo válido', r => { r.generation = 1; r.parents = ['p-a', 'p-b']; r.genome = { ...r.genome, generation: 1, parents: ['p-a', 'p-b'] }; }],
  ['hijo padres duplicados', r => { r.generation = 1; r.parents = ['p-a', 'p-a']; r.genome = { ...r.genome, generation: 1, parents: ['p-a', 'p-a'] }; }],
  ['hijo padre él mismo', r => { r.generation = 1; r.parents = [r.id, 'p-b']; r.genome = { ...r.genome, generation: 1, parents: [r.id, 'p-b'] }; }],
  ['hijo un padre', r => { r.generation = 1; r.parents = ['p-a']; r.genome = { ...r.genome, generation: 1, parents: ['p-a'] }; }],
  ['hijo padres en otro orden', r => { r.generation = 1; r.parents = ['p-a', 'p-b']; r.genome = { ...r.genome, generation: 1, parents: ['p-b', 'p-a'] }; }],
  ['hijo generación distinta', r => { r.generation = 2; r.parents = ['p-a', 'p-b']; r.genome = { ...r.genome, generation: 1, parents: ['p-a', 'p-b'] }; }],
  // Arrays dispersos: `every`/`some` se saltan los huecos; el veredicto tiene que ser el de siempre.
  ['hijo padres dispersos', r => { r.generation = 1; const p = ['', 'p-b']; delete (p as unknown[])[0]; r.parents = p; r.genome = { ...r.genome, generation: 1, parents: ['p-x', 'p-b'] }; }],
  ['hijo padre id inválido', r => { r.generation = 1; r.parents = ['p a', 'p-b']; r.genome = { ...r.genome, generation: 1, parents: ['p a', 'p-b'] }; }],
  ['bornAt 1.5', r => { r.bornAt = 1.5; }], ['bornAt "1"', r => { r.bornAt = '1'; }], ['bornAt -0', r => { r.bornAt = -0; }], ['bornAt > diedAt', r => { r.bornAt = 6; }],
  ['bornAt enorme negativo', r => { r.bornAt = -Number.MAX_SAFE_INTEGER; r.diedAt = 5; }],
  ['diedAt futuro', r => { r.diedAt = 6; }], ['diedAt -0', r => { r.diedAt = -0; r.bornAt = -10; }], ['diedAt -1', r => { r.diedAt = -1; r.bornAt = -10; }],
  ['diedAt Infinity', r => { r.diedAt = Number.POSITIVE_INFINITY; }], ['diedAt NaN', r => { r.diedAt = Number.NaN; }],
  ['cause mala', r => { r.cause = 'war'; }], ['cause senescencia joven', r => { r.cause = 'senescence'; }],
  ['cause senescencia vieja', r => { r.cause = 'senescence'; r.bornAt = r.diedAt - r.traits.senescenceStart; }],
  ['cause senescencia 1 tick antes', r => { r.cause = 'senescence'; r.bornAt = r.diedAt - r.traits.senescenceStart + 1; }],
  ['communityId vacía', r => { r.communityId = ''; }], ['communityId válida', r => { r.communityId = 'c-1'; }], ['communityId undefined', r => { r.communityId = undefined; }],
  ['genome null', r => { r.genome = null; }], ['genome array', r => { r.genome = []; }], ['genome clave extra', r => { r.genome.extra = 1; }],
  ['genome sin mutations', r => { delete r.genome.mutations; }],
  ['alelos 13', r => { r.genome.alleles.pop(); }], ['alelos 15', r => { r.genome.alleles.push(0.5); }], ['alelos no array', r => { r.genome.alleles = { length: 14 }; }],
  ['alelo 8 NaN', r => { r.genome.alleles[8] = Number.NaN; }], ['alelo 0 > 1', r => { r.genome.alleles[0] = 1.0000001; }], ['alelo 12 < 0', r => { r.genome.alleles[12] = -1e-300; }],
  ['alelo 3 -0', r => { r.genome.alleles[3] = -0; }], ['alelo 3 "0.5"', r => { r.genome.alleles[3] = '0.5'; }], ['alelo 11 Infinity', r => { r.genome.alleles[11] = Number.POSITIVE_INFINITY; }],
  ['alelo 8 cambia (rasgos discordantes)', r => { r.genome.alleles[8] = r.genome.alleles[8] === 0.25 ? 0.5 : 0.25; }],
  ['alelo 12 cambia (rasgo no demográfico)', r => { r.genome.alleles[12] = r.genome.alleles[12] === 0.25 ? 0.5 : 0.25; }],
  ['alelo 12 hueco', r => { delete r.genome.alleles[12]; }], ['alelo 8 hueco', r => { delete r.genome.alleles[8]; }],
  ['mutations 15', r => { r.genome.mutations = 15; }], ['learningRate 0.03', r => { r.genome.learningRate = 0.03; }], ['cooperation 1.1', r => { r.genome.cooperation = 1.1; }],
  ['genome.generation 1', r => { r.genome.generation = 1; }],
  ['traits null', r => { r.traits = null; }], ['traits clave extra', r => { r.traits.extra = 1; }], ['traits sin maximumAge', r => { delete r.traits.maximumAge; }],
  ['foodDemand + 1 ULP', r => { r.traits.foodDemand += Number.EPSILON; }], ['waterDemand distinto', r => { r.traits.waterDemand += 0.01; }],
  ['resilience como string', r => { r.traits.resilience = String(r.traits.resilience); }], ['fertilityCooldown + 1', r => { r.traits.fertilityCooldown += 1; }],
  ['maturityAge + 1', r => { r.traits.maturityAge += 1; }],
  ['senescenceStart 1.5', r => { r.traits.senescenceStart = 1.5; }], ['senescenceStart -0 imposible', r => { r.traits.senescenceStart = -0; }],
  ['senescenceStart <= madurez', r => { r.traits.senescenceStart = r.traits.maturityAge; }], ['maximumAge <= senescenceStart', r => { r.traits.maximumAge = r.traits.senescenceStart; }],
  ['ley de longevidad ajena (rasgos de vejez libres)', r => { r.traits.senescenceStart += 37; r.traits.maximumAge += 101; }],
  ['record null', () => {}],
];

test('V18 fail-closed: assertLegacyRecord da el veredicto de siempre para cada corrupción (claves, prototipos, padres, fechas, genoma, rasgos)', () => {
  let accepted = 0, rejected = 0;
  for (const [label, change] of RECORD_MUTATIONS) for (const atTick of [5, 6, 0, -1, 1.5, Number.NaN]) {
    const a = structuredClone(validRecord()) as unknown as Record<string, any>, b = structuredClone(validRecord()) as unknown as Record<string, any>;
    change(a); change(b);
    const result = sameOutcome(`${label} @${atTick}`, () => assertLegacyRecord(label === 'record null' ? null : a, atTick), () => originalAssertLegacyRecord(label === 'record null' ? null : b, atTick));
    if (result.ok) accepted++; else rejected++;
  }
  for (const value of [undefined, null, 0, 'record', [], [validRecord()], new Map(), () => validRecord()]) {
    sameOutcome(`valor ${String(value)}`, () => assertLegacyRecord(value, 5), () => originalAssertLegacyRecord(value, 5));
  }
  assert.ok(accepted > 10 && rejected > 300, `cobertura: ${accepted} aceptados, ${rejected} rechazados`);
});

test('V18 fail-closed: demographicTraits y updateDemography dan el valor o el RangeError de siempre (alelos, leyes, estados, entornos)', () => {
  const genome = () => structuredClone(founderGenome(7, 'g', { curiosity: 0.3, sociability: 0.6, industriousness: 0.2, care: 0.9, resilience: 0.7 }));
  const hole = () => { const g = genome(); delete (g.alleles as unknown[])[11]; return g; };
  const holeCore = () => { const g = genome(); delete (g.alleles as unknown[])[8]; return g; };
  const genomes: [string, () => { alleles: unknown }][] = [
    ['válido', genome], ['13 alelos', () => ({ alleles: genome().alleles.slice(0, 13) })],
    ['15 alelos', () => ({ alleles: [...genome().alleles, 0.5] })], ['hueco no demográfico', () => ({ alleles: hole().alleles })],
    ['hueco demográfico', () => ({ alleles: holeCore().alleles })],
    ['alelo NaN', () => ({ alleles: Object.assign([...genome().alleles], { 2: Number.NaN }) })],
    ['alelo -0', () => ({ alleles: Object.assign([...genome().alleles], { 8: -0, 9: -0 }) })],
    ['alelo 1+ε', () => ({ alleles: Object.assign([...genome().alleles], { 13: 1 + Number.EPSILON }) })],
    ['alelo string', () => ({ alleles: Object.assign([...genome().alleles], { 4: '0.5' }) })],
    ['alelos no array', () => ({ alleles: { length: 14 } })], ['alelos null', () => ({ alleles: null })],
    ['alelos array-like tipado', () => ({ alleles: Float64Array.from([...genome().alleles]) })],
  ];
  const laws: [string, LongevityLaw][] = [
    ['default', DEFAULT_PARAMS.cuerpo], ['corta', parseParams('cuerpo.longevidadBaseDias=4', DEFAULT_PARAMS).cuerpo],
    ['base NaN', { ...DEFAULT_PARAMS.cuerpo, longevidadBaseDias: Number.NaN }], ['pendiente negativa', { ...DEFAULT_PARAMS.cuerpo, longevidadPorResiliencia: -1 }],
    ['actividad Infinity', { ...DEFAULT_PARAMS.cuerpo, longevidadPorActividad: Number.POSITIVE_INFINITY }], ['fracción -0', { ...DEFAULT_PARAMS.cuerpo, senescenciaInicioFraccion: -0 }],
    ['degenerada', { ...DEFAULT_PARAMS.cuerpo, longevidadBaseDias: 0, longevidadPorResiliencia: 0 }],
  ];
  for (const [gl, make] of genomes) for (const [ll, law] of laws) {
    sameOutcome(`demographicTraits ${gl}/${ll}`, () => demographicTraits(make() as { alleles: number[] }, law), () => originalDemographicTraits(make() as { alleles: number[] }, law));
  }
  sameOutcome('demographicTraits sin ley', () => demographicTraits(genome()), () => originalDemographicTraits(genome()));

  const traits = demographicTraits(genome());
  const base = (): DemographicActor => ({ id: 'b', traits: { ...traits }, hunger: 0.3, thirst: 0.2, energy: 0.7, fatigue: 0.2, state: { age: traits.senescenceStart + 400, health: 0.6, vitality: 0.7, deathCause: null } });
  const env = (): DemographicEnvironment => ({ exposure: 1, shelter: 0.25, protected: false, seed: 3, tick: 99, senescence: { ...DEFAULT_PARAMS.cuerpo } });
  type Case = [string, (a: any, e: any) => void, number?];
  const cases: Case[] = [
    ['válido', () => {}], ['dt 0', () => {}, 0], ['dt 240', () => {}, 240], ['dt 241', () => {}, 241], ['dt -0', () => {}, -0], ['dt NaN', () => {}, Number.NaN],
    ['hambre NaN', a => { a.hunger = Number.NaN; }], ['sed 1.1', a => { a.thirst = 1.1; }], ['energía -0', a => { a.energy = -0; }], ['fatiga string', a => { a.fatigue = '0.1'; }],
    ['salud 0 viva', a => { a.state.health = 0; }], ['muerto coherente', a => { a.state.health = 0; a.state.deathCause = 'exposure'; }],
    ['muerto causa mala', a => { a.state.health = 0; a.state.deathCause = 'war'; }], ['muerto con salud', a => { a.state.deathCause = 'exposure'; }],
    ['edad -1', a => { a.state.age = -1; }], ['edad enorme', a => { a.state.age = Number.MAX_SAFE_INTEGER; }], ['edad Infinity', a => { a.state.age = Number.POSITIVE_INFINITY; }],
    ['sin estado', a => { a.state = undefined; }], ['sin rasgos', a => { a.traits = null; }], ['id vacío', a => { a.id = ''; }], ['id número', a => { a.id = 3; }], ['sin id', a => { delete a.id; }],
    ['exposición 2', (_, e) => { e.exposure = 2; }], ['techo NaN', (_, e) => { e.shelter = Number.NaN; }], ['protegido string', (_, e) => { e.protected = 'yes'; }],
    ['protegido', (_, e) => { e.protected = true; }], ['semilla 1.5', (_, e) => { e.seed = 1.5; }], ['sin semilla', (_, e) => { delete e.seed; }],
    ['tick Infinity', (_, e) => { e.tick = Number.POSITIVE_INFINITY; }], ['sin tick', (_, e) => { delete e.tick; }], ['sin ley', (_, e) => { delete e.senescence; }],
    ['ley null', (_, e) => { e.senescence = null; }], ['ley riesgo negativo', (_, e) => { e.senescence.riesgoSenescenciaDiario = -1; }],
    ['ley cuidado 2', (_, e) => { e.senescence.cuidadoReduceRiesgo = 2; }], ['ley pendiente 0', (_, e) => { e.senescence.riesgoSenescenciaPendiente = 0; }],
    ['foodDemand 0', a => { a.traits.foodDemand = 0; }], ['waterDemand 3.1', a => { a.traits.waterDemand = 3.1; }], ['resilience NaN', a => { a.traits.resilience = Number.NaN; }],
    ['madurez 0', a => { a.traits.maturityAge = 0; }], ['descanso 1.5', a => { a.traits.fertilityCooldown = 1.5; }], ['vejez = máximo', a => { a.traits.senescenceStart = a.traits.maximumAge; }],
    ['hambre letal', a => { a.hunger = 1; a.thirst = 1; a.state.health = 0.001; }], ['hambre letal protegida', (a, e) => { a.hunger = 1; a.state.health = 0.001; e.protected = true; }],
    ['empate de daños', a => { a.hunger = 1; a.thirst = 1; a.state.health = 1e-9; a.traits.foodDemand = a.traits.waterDemand = 1; }],
    ['vejez extrema', a => { a.state.age = a.traits.maximumAge * 3; }],
  ];
  for (const [label, change, dt = 1] of cases) {
    const a1 = base(), e1 = env(), a2 = base(), e2 = env(); change(a1, e1); change(a2, e2);
    sameOutcome(`updateDemography ${label}`, () => updateDemography(a1, e1, dt), () => originalUpdateDemography(a2, e2, dt));
    assert.deepStrictEqual(a1, a2, `${label}: updateDemography no debe mutar su entrada`);
  }
  const random = mulberry32(99);
  for (let k = 0; k < 5000; k++) {
    const a = base(), e = env();
    a.hunger = random(); a.thirst = random(); a.energy = random(); a.fatigue = random();
    a.state = { age: Math.floor(random() * traits.maximumAge * 1.5), health: random() || 1, vitality: random(), deathCause: null };
    e.shelter = random(); e.exposure = random() < 0.5 ? 1 : random(); e.protected = random() < 0.1; e.tick = k;
    const dt = 1 + Math.floor(random() * 3);
    sameOutcome(`updateDemography aleatorio ${k}`, () => updateDemography(a, e, dt), () => originalUpdateDemography(a, e, dt));
  }
});

/** Mundo mínimo de linaje: lo único que leen `retainLegacy`/`assertPopulation`/`referencedLegacy`. */
function lineageWorld(seed = 5) {
  const world = createWorld(seed); world.communities = [];
  populate(world, seed, 40, { cloaks: 0, dead: 120, shelters: 4, pending: 30 });
  // La cola pendiente comparte objetos con la caché, como tras una muerte y tras `cloneWorld`.
  return world;
}
function compareRetain(label: string, world: World) {
  const twin = structuredClone({ tick: world.tick, people: world.people, blueprints: world.blueprints, technology: world.technology, legacy: world.legacy, retiredLegacy: world.retiredLegacy }) as unknown as World;
  const retired = world.retiredLegacy, twinRetired = twin.retiredLegacy, beforeLegacy = [...world.legacy], twinBefore = [...twin.legacy];
  const a = outcome(() => retainLegacy(world)), b = outcome(() => originalRetainLegacy(twin));
  assert.deepStrictEqual(a, b, `${label}: veredicto distinto`);
  assert.equal(stringifyExact(world.legacy), stringifyExact(twin.legacy), `${label}: legado distinto`);
  // Mismas referencias: cada fila retenida es el mismo objeto (de la caché o de la cola) que elige el original.
  const origin = (record: LegacyRecord, legacy: LegacyRecord[], queue: LegacyRecord[]) => `${legacy.indexOf(record)}/${queue.indexOf(record)}`;
  assert.deepEqual(world.legacy.map(r => origin(r, beforeLegacy, retired)), twin.legacy.map(r => origin(r, twinBefore, twinRetired)), `${label}: procedencia distinta`);
  assert.equal(world.retiredLegacy, retired, `${label}: la cola pendiente no se reemplaza`);
  return a;
}

test('V18 fail-closed: retainLegacy detecta mutaciones en sitio entre llamadas y conserva orden y procedencia exactos', () => {
  const world = lineageWorld();
  assert.equal(compareRetain('inicial', world).ok, true);
  assert.ok(world.legacy.length > RECENT_LEGACY_COUNT);
  assert.ok(world.retiredLegacy.some(record => world.legacy.includes(record)), 'la cola comparte referencias con la caché');
  const shared = world.retiredLegacy.find(record => world.legacy.includes(record))!;
  type Step = [string, () => (() => void)];
  const steps: Step[] = [
    ['alelo demográfico en sitio', () => { const v = shared.genome.alleles[8]!; shared.genome.alleles[8] = v === 0.3 ? 0.4 : 0.3; return () => { shared.genome.alleles[8] = v; }; }],
    ['alelo 0 fuera de rango en sitio', () => { const r = world.legacy[0]!, v = r.genome.alleles[0]!; r.genome.alleles[0] = 1.5; return () => { r.genome.alleles[0] = v; }; }],
    ['rasgo +1 ULP en sitio', () => { const r = world.legacy[3]!, v = r.traits.foodDemand; r.traits.foodDemand = v + Number.EPSILON; return () => { r.traits.foodDemand = v; }; }],
    ['vejez antes del inicio', () => { const r = world.legacy[1]!, v = r.cause; r.cause = 'senescence'; return () => { r.cause = v; }; }],
    ['fecha futura', () => { const r = world.legacy[2]!, v = r.diedAt; r.diedAt = world.tick + 1; return () => { r.diedAt = v; }; }],
    ['bornAt > diedAt', () => { const r = world.legacy[2]!, v = r.bornAt; r.bornAt = r.diedAt + 1; return () => { r.bornAt = v; }; }],
    ['clave extra en sitio', () => { const r = world.legacy[4]! as unknown as Record<string, unknown>; r.extra = 1; return () => { delete r.extra; }; }],
    ['clave borrada en sitio', () => { const r = world.legacy[4]! as unknown as Record<string, unknown>, v = r.communityId; delete r.communityId; return () => { r.communityId = v; }; }],
    ['padres duplicados en sitio', () => { const r = world.legacy[5]!, v = r.parents; r.generation = 1; r.parents = ['x-1', 'x-1']; return () => { r.generation = 0; r.parents = v; }; }],
    ['genoma con prototipo raro', () => { const r = world.legacy[6]!, p = Object.getPrototypeOf(r.genome); Object.setPrototypeOf(r.genome, { mutations: 1 }); return () => { Object.setPrototypeOf(r.genome, p); }; }],
    ['copia distinta idéntica en la caché', () => { const i = world.legacy.indexOf(shared), v = world.legacy[i]!; world.legacy[i] = structuredClone(v); return () => { world.legacy[i] = v; }; }],
    ['copia con otro nombre en la caché', () => { const i = world.legacy.indexOf(shared), v = world.legacy[i]!; world.legacy[i] = { ...structuredClone(v), name: 'Otra' }; return () => { world.legacy[i] = v; }; }],
    ['copia con otro alelo no demográfico', () => { const i = world.legacy.indexOf(shared), v = world.legacy[i]!, c = structuredClone(v); c.genome.alleles[12] = c.genome.alleles[12] === 0.2 ? 0.3 : 0.2; world.legacy[i] = c; return () => { world.legacy[i] = v; }; }],
    ['copia con -0 en vez de 0', () => { const i = world.legacy.indexOf(shared), v = world.legacy[i]!, c = structuredClone(v); c.genome.alleles[13] = c.genome.alleles[13] === 0 ? -0 : c.genome.alleles[13]!; c.bornAt = Object.is(c.bornAt, 0) ? -0 : c.bornAt; world.legacy[i] = c; return () => { world.legacy[i] = v; }; }],
    ['copia con padres de otro array igual', () => { const i = world.legacy.indexOf(shared), v = world.legacy[i]!; world.legacy[i] = { ...v, parents: [...v.parents], genome: { ...v.genome, parents: [...v.genome.parents], alleles: [...v.genome.alleles] }, traits: { ...v.traits } }; return () => { world.legacy[i] = v; }; }],
    ['copia con rasgos en otro orden de claves', () => { const i = world.legacy.indexOf(shared), v = world.legacy[i]!, t = v.traits; world.legacy[i] = { ...v, traits: { maximumAge: t.maximumAge, senescenceStart: t.senescenceStart, fertilityCooldown: t.fertilityCooldown, maturityAge: t.maturityAge, waterDemand: t.waterDemand, foodDemand: t.foodDemand, resilience: t.resilience } }; return () => { world.legacy[i] = v; }; }],
    ['duplicado dentro de la caché', () => { const v = world.legacy[0]!; world.legacy.push(v); return () => { world.legacy.pop(); }; }],
    ['duplicado dentro de la cola', () => { const v = world.retiredLegacy[0]!; world.retiredLegacy.push(v); return () => { world.retiredLegacy.pop(); }; }],
    ['fila de la cola ausente de la caché', () => { const i = world.legacy.indexOf(shared), v = world.legacy[i]!; world.legacy.splice(i, 1); return () => { world.legacy.splice(i, 0, v); }; }],
    ['empate de fecha con ids que ordena localeCompare', () => {
      const rows = world.legacy.slice(0, 3), dates = rows.map(r => r.diedAt), ids = rows.map(r => r.id);
      rows.forEach((r, k) => { r.diedAt = world.tick - 1; r.id = ['dead-Ä', 'dead-a', 'dead-B'][k]!; });
      return () => rows.forEach((r, k) => { r.diedAt = dates[k]!; r.id = ids[k]!; });
    }],
    ['nada', () => () => {}],
  ];
  let rejected = 0;
  for (const [label, mutate] of steps) {
    // Lo que no es un campo del registro (qué objeto ocupa cada fila) se restaura entero: si la mutación
    // validó, `retainLegacy` ya reconstruyó `world.legacy`.
    const legacyBefore = [...world.legacy], retiredBefore = [...world.retiredLegacy];
    const restore = mutate();
    const result = compareRetain(label, world);
    if (!result.ok) rejected++;
    restore();
    world.legacy = legacyBefore; world.retiredLegacy.length = 0; world.retiredLegacy.push(...retiredBefore);
    assert.equal(compareRetain(`${label} (restaurado)`, world).ok, true, `${label}: restaurado debe volver a validar`);
  }
  assert.ok(rejected >= 12, `deben rechazarse las corrupciones (${rejected})`);
  // Una identidad archivada que reaparece viva se rechaza antes de tocar nada.
  const ghost = { ...structuredClone(world.people[3]!), id: world.legacy[0]!.id };
  world.people.push(ghost); const deaths = world.demographyDynamics.deaths;
  assert.throws(() => advancePopulation(world, { emit: emitFor(world), beforeDeath: settle }), /fallecida reapareció/);
  assert.equal(world.demographyDynamics.deaths, deaths);
  world.people.pop();
  const ghostPending = { ...structuredClone(world.people[3]!), id: world.retiredLegacy.at(-1)!.id };
  world.people.push(ghostPending);
  assert.throws(() => advancePopulation(world, { emit: emitFor(world), beforeDeath: settle }), /fallecida reapareció/);
});

test('V18 fail-closed: assertPopulation da el veredicto de siempre', () => {
  const world = lineageWorld(9);
  retainLegacy(world);
  type Change = [string, (w: World) => void];
  const changes: Change[] = [
    ['válido', () => {}],
    ['tick 1.5', w => { w.tick = 1.5; }], ['people no array', w => { (w as unknown as Record<string, unknown>).people = {}; }],
    ['retiredLegacy no array', w => { (w as unknown as Record<string, unknown>).retiredLegacy = null; }],
    ['id duplicado vivo', w => { w.people.push({ ...w.people[0]!, demography: { ...w.people[0]!.demography } }); }],
    ['edad discordante', w => { w.people[0]!.demography.age++; }], ['salud 0', w => { w.people[0]!.demography.health = 0; }],
    ['vitalidad 2', w => { w.people[1]!.demography.vitality = 2; }], ['estado con clave extra', w => { (w.people[1]!.demography as unknown as Record<string, unknown>).x = 1; }],
    ['muerto vivo', w => { w.people[0]!.id = w.legacy[0]!.id; }], ['muerto pendiente vivo', w => { w.people[0]!.id = w.retiredLegacy[0]!.id; }],
    ['fila duplicada en caché', w => { w.legacy.push(w.legacy[0]!); }], ['fila duplicada en cola', w => { w.retiredLegacy.push(w.retiredLegacy[0]!); }],
    ['cola con contenido distinto', w => { w.retiredLegacy[0] = { ...w.retiredLegacy[0]!, name: 'Otra' }; }],
    ['cola con copia idéntica', w => { w.retiredLegacy[0] = structuredClone(w.retiredLegacy[0]!); }],
    ['cola con fila sólo pendiente', w => { w.retiredLegacy.push(legacyRecord(9, 9999, w.tick - 1)); w.demographyDynamics.deaths++; w.demographyDynamics.causes.exposure++; }],
    ['muertes de menos', w => { w.demographyDynamics.deaths = w.demographyDynamics.causes.starvation = 1; }],
    ['muertes sin causa', w => { w.demographyDynamics.deaths++; }], ['pérdida negativa', w => { w.demographyDynamics.foodLost = -1; }],
    ['pérdida NaN', w => { w.demographyDynamics.woodLost = Number.NaN; }], ['dinámica con clave extra', w => { (w.demographyDynamics as unknown as Record<string, unknown>).x = 0; }],
    ['registro corrupto', w => { w.legacy[2]!.traits.resilience += 0.01; }],
  ];
  for (const [label, change] of changes) {
    const a = structuredClone(world), b = structuredClone(world); change(a); change(b);
    sameOutcome(`assertPopulation ${label}`, () => assertPopulation(a), () => originalAssertPopulation(b));
  }
});

// ─────────────────────────────────────── 3. Coste ───────────────────────────────────────

const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const p95 = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!; };

test('V18 coste: advancePopulation con 3 000 habitantes, 2 500 legados citados, 200 pendientes, 600 refugios y lluvia', t => {
  const world = createWorld(20261122, DEFAULT_TOOLS);
  const land = world.tiles.filter(tile => tile.terrain !== 'water').length;
  assert.ok(land >= 900, `hacen falta teselas de tierra (${land})`);
  populate(world, 20261122, 3000, { cloaks: 1, dead: 2500, shelters: 600, pending: 200 });
  // 299 capas más, copias de la fabricada: el abrigo no depende de quién lo hizo.
  const cloak = world.people[1]!.technology.items[0]!;
  for (let k = 1; k < 300; k++) world.people[1 + 2 * k]!.technology.items = [{ ...structuredClone(cloak), id: `${cloak.id}-copia-${k}` }];
  // Cuerpos sanos y jóvenes: el coste medido es el de un paso corriente, no el de una mortandad.
  for (const person of world.people) {
    person.hunger = 0.2; person.thirst = 0.2; person.fatigue = 0.1; person.energy = 0.9;
    person.demography = { ...person.demography, age: 1000 + (person.demography.age % 500), health: 0.95, vitality: 0.95 };
    person.bornAt = world.tick - person.demography.age;
  }
  retainLegacy(world);
  assert.ok(world.legacy.length >= 2400, `los legados citados se conservan (${world.legacy.length})`);
  assert.equal(world.retiredLegacy.length, 200);
  assert.ok(world.structures.length >= 600);
  // Tres ventanas de 20 pasos tras 10 de calentamiento; cuenta la mejor mediana, porque la suite corre en
  // paralelo con la carga de la torre y una ventana sola mide también a los vecinos.
  const emit = emitFor(world), windows: number[][] = [[], [], []], retains: number[] = [];
  for (let step = 0; step < 70; step++) {
    world.tick++;
    const start = performance.now(); advancePopulation(world, { emit, beforeDeath: settle }); const end = performance.now();
    if (step >= 10) windows[Math.floor((step - 10) / 20)]!.push(end - start);
    const r0 = performance.now(); retainLegacy(world); retains.push(performance.now() - r0);
  }
  const steps = windows.reduce((best, window) => median(window) < median(best) ? window : best);
  const report = { habitantes: world.people.length, legado: world.legacy.length, pendientes: world.retiredLegacy.length, estructuras: world.structures.length,
    medianasPorVentanaMs: windows.map(window => +median(window).toFixed(3)),
    advancePopulation: { medianaMs: +median(steps).toFixed(3), p95Ms: +p95(steps).toFixed(3), maxMs: +Math.max(...steps).toFixed(3) },
    retainLegacy: { medianaMs: +median(retains).toFixed(3), p95Ms: +p95(retains).toFixed(3), maxMs: +Math.max(...retains).toFixed(3) } };
  t.diagnostic(`V18 demografía ${JSON.stringify(report)}`);
  assert.ok(world.people.length > 2900, 'sin mortandad en el paso medido');
  if (!capture) assert.ok(median(steps) < 15, `advancePopulation debe costar < 15 ms/paso con 3 000 habitantes (mediana ${median(steps).toFixed(2)} ms)`);
});
