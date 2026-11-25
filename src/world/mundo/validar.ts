import { RULES_VERSION, type World, COOLDOWN, MAX_EVENTS, MAX_EXPERIENCES, MAX_HABITS, type WorldContext, type Person } from './tipos.js';
import type { Point } from './geometria.js';
import { walkable } from './crear.js';
import { ley, limitsOf, paramsOf, openWorldCaps, MAX_FOUNDER_AGE_TICKS } from '../params.js';
import { POPULATION_HARD_LIMIT } from '../../shared/life.js';
import { validCoordinate, bindWorldContext, worldContext } from '../spatial.js';
import { assertChemistryState, assertCompoundLots } from '../chemistry.js';
import { assertChronicleJournal } from '../chronicle-journal.js';
import { MAX_RETAINED_WHISPERS, WHISPER_INTENTS } from '../whispers.js';
import type { LegacyRecord } from '../../shared/demography.js';
import { assertLegacyRecord, assertPopulation } from '../lineage.js';
import { assertDormantTerrain, assertEcosystemTile, assertLifeState } from '../validation.js';
import { chunkKey } from '../terrain.js';
import { assertGenome } from '../genetics.js';
import type { Culture } from '../society.js';
import { assertPolicyGenome, assertPolicyPlasticity } from '../politica.js';
import type { WorldSample } from '../../shared/types.js';
import { assertTechnology } from '../technology.js';
import { resolveTechnologyRecipe } from '../technology-catalogue.js';
import { COLUMNAS_CEREBRO, GENOMA_ANCHO } from '../motor/contratos.js';
import { TOTALES_V23 } from '../totales-v23.js';

const ES_TOTAL_V23: ReadonlySet<string> = new Set(TOTALES_V23);

function esRegistro(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function esReferencia(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function esVectorFinito(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false;
  for (const numero of value) if (!Number.isFinite(numero)) return false;
  return true;
}

function assertGestacion(value: unknown, tick: number, persona: boolean): void {
  const tiempo = (n: unknown): boolean => esReferencia(n) && n <= tick;
  if (!esRegistro(value) || !esReferencia(value.embrion) || !esReferencia(value.otro)
    || !tiempo(value.inicio) || (value.bajoBasalDesde !== -1 && !tiempo(value.bajoBasalDesde))
    || !esVectorFinito(value.genoma) || value.genoma.length === 0 || value.genoma.length > GENOMA_ANCHO
    || persona && (value.genoma.length !== GENOMA_ANCHO || value.genoma.some(n => n < 0 || n > 1))
    || value.politica !== undefined && (!persona || !esVectorFinito(value.politica)
      || value.politica.length !== COLUMNAS_CEREBRO.politica)) throw new Error('Gestación inválida.');
}

function assertCuerpo(value: unknown, tick: number, persona: boolean): void {
  if (value === undefined) return;
  if (!esRegistro(value) || !esReferencia(value.tejido) || !esReferencia(value.reserva)
    || !esReferencia(value.digestivo) || !esReferencia(value.plantilla)) throw new Error('Cuerpo inválido.');
  if (value.gestacion !== undefined) assertGestacion(value.gestacion, tick, persona);
}

function assertCarga(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error('Carga de lotes inválida.');
  for (const lote of value) if (!esReferencia(lote)) throw new Error('Carga de lotes inválida.');
}


/** Reject corruption on load rather than silently replacing a world. */
export function assertCommon(value: unknown, legacy = false, expectedVersion = RULES_VERSION): asserts value is World {
  const fail = (): never => { throw new Error('Estado del mundo inválido o versión de reglas incompatible.'); };
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const num = (v: unknown, max = 1): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
  const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => num(v, max) && Number.isInteger(v);
  const str = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length <= max;
  const list = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max;
  if (!object(value) || value.version !== (legacy ? 1 : expectedVersion) || value.width !== 40 || value.height !== 28 || !integer(value.seed, 0xffffffff) || !integer(value.rng, 0xffffffff) || !integer(value.tick) || !integer(value.eventCounter) || typeof value.learningEnabled !== 'boolean' || !['rain', 'clear'].includes(String(value.weather)) || !Number.isInteger(value.lastGestureTick) || (value.lastGestureTick as number) < -COOLDOWN || (value.lastGestureTick as number) > (value.tick as number)) fail();
  const world = value as unknown as World;
  const limits = limitsOf(world, expectedVersion);
  const populationCap = Math.max(POPULATION_HARD_LIMIT, paramsOf(world).poblacion.maxima);
  const coord = (n: unknown, max: number) => legacy ? integer(n, max) : validCoordinate(n);
  const land = (p: Point) => legacy ? world.tiles.some(t => t.x === p.x && t.y === p.y && t.terrain !== 'water') : walkable(world, p);
  const placesCap = legacy ? 3 : openWorldCaps(world) ? Math.max(2048, limits.teselasActivas) : 2048;
  if (!list(world.tiles, legacy ? 1120 : limits.teselasActivas) || (legacy && world.tiles.length !== 1120) || !list(world.people, expectedVersion < 3 || legacy ? 16 : populationCap) || world.people.length < (expectedVersion>=5&&!legacy?2:16) || !list(world.places, placesCap) || (legacy && world.places.length !== 3) || !list(world.events, MAX_EVENTS) || !list(world.memories, 10) || !list(world.invitations, 8) || !list(world.reminders, 8)) fail();
  for (let index = 0; index < world.tiles.length; index++) {
    const tile = world.tiles[index];
    if (!object(tile) || (legacy ? tile.x !== index % 40 || tile.y !== Math.floor(index / 40) : !validCoordinate(tile.x) || !validCoordinate(tile.y)) || !['water', 'soil', 'meadow', 'shelter'].includes(String(tile.terrain)) || !num(tile.moisture) || !num(tile.vegetation) || !num(tile.food)) fail();
  }
  const ids = new Set<string>();
  for (const person of world.people) {
    if (!object(person) || !str(person.id, 50) || ids.has(person.id) || !str(person.name, 80) || !['S', 'I', 'neighbor'].includes(String(person.role)) || !coord(person.x, 39) || !coord(person.y, 27) || !land(person) || !object(person.target) || !coord(person.target.x, 39) || !coord(person.target.y, 27) || (legacy && !land(person.target)) || !str(person.color, 30) || !['explore', 'eat', 'rest', 'approach', 'accompany', 'retreat', 'share', 'gather', 'farm', 'build', 'hunt', 'drink', 'cooperate', ...(expectedVersion>=4?['invent','repair']:[]), ...(expectedVersion>=5?['research','craft','forage']:[])].includes(String(person.action)) || !str(person.reason) || !str(person.need, 100) || !(person.recentMemory === null || str(person.recentMemory)) || !integer(person.decisionAt) || !Number.isInteger(person.lastMeeting) || !Number.isInteger(person.lastShared) || !list(person.experiences, MAX_EXPERIENCES) || !list(person.habits, MAX_HABITS)) fail();
    ids.add(person.id);
    for (const key of ['energy', 'hunger', 'fatigue', 'curiosity', 'sociability', 'generosity', 'closeness', 'socialLoad'] as const) if (!num(person[key])) fail();
    if (!num(person.inventory, 0.25)) fail();
    for (const experience of person.experiences) if (!object(experience) || !integer(experience.tick, world.tick) || !str(experience.text) || !str(experience.causeId, 100) || !str(experience.placeId, 100)) fail();
    for (const habit of person.habits) {
      if (!object(habit) || !str(habit.placeId, 100) || !integer(habit.observations, 10) || !num(habit.strength) || !str(habit.demonstrator, 100) || !str(habit.sourceEvent, 100) || !integer(habit.repetitions, 1_000_000) || !list(habit.evidence, 2)) fail();
      for (const evidence of habit.evidence) if (!object(evidence) || !str(evidence.eventId, 100) || !integer(evidence.tick, world.tick) || !str(evidence.demonstrator, 100) || !str(evidence.recipient, 100) || evidence.food !== 0.025) fail();
    }
  }
  if (world.people.filter(p => p.role === 'S').length !== 1 || world.people.filter(p => p.role === 'I').length !== 1) fail();
  for (const place of world.places) if (!object(place) || !str(place.id, 100) || !str(place.name, 200) || !coord(place.x, 39) || !coord(place.y, 27) || !str(place.description) || !integer(place.gatherings, 1_000_000)) fail();
  for (const event of world.events) if (!object(event) || !str(event.id, 100) || !integer(event.tick, world.tick) || !['ecology', 'meeting', 'care', 'learning', 'memory', 'gesture', 'pause', 'discovery', 'settlement', 'cooperation', 'birth', 'community', 'conflict', 'adaptation', ...(expectedVersion>=4?['animal','invention']:[]), ...(expectedVersion>=5?['death']:[])].includes(String(event.kind)) || !list(event.actors, populationCap) || !event.actors.every(a => str(a, 100)) || !str(event.text) || !str(event.cause) || !['simulation', 'sample', 'approved'].includes(String(event.source)) || (event.x !== undefined && !coord(event.x, 39)) || (event.y !== undefined && !coord(event.y, 27))) fail();
  for (const memory of world.memories) if (!object(memory) || !str(memory.id, 100) || !str(memory.title, 200) || !str(memory.text) || !['sample', 'approved'].includes(String(memory.source)) || !world.places.some(p => p.id === memory.placeId) || !['partner-tired', 'shelter-tired', 'food-hungry', 'rain-shelter', 'irrelevant'].includes(String(memory.context)) || !['explore', 'eat', 'rest', 'approach', 'accompany', 'retreat', 'share', 'gather', 'farm', 'build', 'hunt', 'drink', 'cooperate'].includes(String(memory.action)) || !num(memory.weight) || !list(memory.roles, 2) || !memory.roles.every(role => role === 'S' || role === 'I')) fail();
  for (const invitation of world.invitations) if (!object(invitation) || !str(invitation.id, 100) || !coord(invitation.x, 39) || !coord(invitation.y, 27) || !integer(invitation.until)) fail();
  for (const reminder of world.reminders) if (!object(reminder) || !str(reminder.memoryId, 100) || !integer(reminder.until) || !world.memories.some(m => m.id === reminder.memoryId)) fail();
}


export function assertWorld(value: unknown, expectedVersion = RULES_VERSION, context?: WorldContext): asserts value is World {
  assertCommon(value, false, expectedVersion);
  const w = value;
  const validarCuerpos = ley(w, 'cuerpos') || ley(w, 'guardadoCompleto');
  const limits = limitsOf(w, expectedVersion);
  const populationCap = Math.max(POPULATION_HARD_LIMIT, paramsOf(w).poblacion.maxima);
  if (w.chemistry !== undefined) assertChemistryState(w.chemistry, w.tick);
  assertChronicleJournal(w);
  bindWorldContext(w, context ?? worldContext(w));
  const fail = (): never => { throw new Error('Estado procedural inválido.'); };
  if (w.whispers !== undefined) {
    if (!Array.isArray(w.whispers) || w.whispers.length > MAX_RETAINED_WHISPERS) fail();
    const optionalTick = (n: unknown) => n === undefined || Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= w.tick;
    for (const whisper of w.whispers) if (!whisper || typeof whisper !== 'object' || typeof whisper.id !== 'string' || whisper.id.length > 100
      || !WHISPER_INTENTS.includes(whisper.intent) || !['latent', 'heard', 'fulfilled', 'faded'].includes(whisper.status)
      || !validCoordinate(whisper.x) || !validCoordinate(whisper.y) || !Number.isSafeInteger(whisper.createdTick) || whisper.createdTick > w.tick
      || (whisper.personId !== null && typeof whisper.personId !== 'string') || typeof whisper.note !== 'string' || whisper.note.length > 120
      || !optionalTick(whisper.heardTick) || !optionalTick(whisper.resolvedTick)
      || whisper.bestDistance !== undefined && !(Number.isFinite(whisper.bestDistance) && whisper.bestDistance >= 0)
      || whisper.stalledChecks !== undefined && !(Number.isSafeInteger(whisper.stalledChecks) && whisper.stalledChecks >= 0)) fail();
  }
  // assertCommon has already rejected duplicate live IDs. Resolve live references
  // once rather than scanning the roster for every bond and recipe author.
  const alive = new Map(w.people.map(person => [person.id, person]));
  const identities = new Map<string, Person | LegacyRecord | undefined>(alive);
  const identity = (id: string): Person | LegacyRecord | undefined => {
    if (identities.has(id)) return identities.get(id);
    let person: Person | LegacyRecord | undefined = w.legacy?.find(person => person.id === id) ?? w.retiredLegacy?.find(person => person.id === id);
    if (!person && expectedVersion >= 5) {
      const archived = worldContext(w).loadLegacy?.(id, w.tick);
      if (archived) { assertLegacyRecord(archived, w.tick); if (archived.id !== id) fail(); person = archived; }
    }
    identities.set(id, person); return person;
  };
  if (!w.chunks || Array.isArray(w.chunks) || Object.keys(w.chunks).length > limits.chunks || !Array.isArray(w.retiredChunks) || !Number.isSafeInteger(w.discoveredChunks) || w.discoveredChunks < 0 || !Number.isSafeInteger(w.settlementCount) || w.settlementCount < 0 || [w.adaptationEnabled, w.noveltyEnabled, w.shelterBenefitEnabled].some(v => typeof v !== 'boolean')) fail();
  for (const chunk of w.retiredChunks) {
    assertDormantTerrain(chunk, w.tick, expectedVersion >= 3);
    if (validarCuerpos) for (const animal of chunk.animals ?? []) assertCuerpo(animal.cuerpo, w.tick, false);
  }
  const keys = new Set<string>();
  for (const tile of w.tiles) {
    if (expectedVersion >= 3) assertEcosystemTile(tile);
    const key = `${tile.x},${tile.y}`;
    if (tile.biome !== undefined && !['grassland','forest','desert','mountain','wetland','ocean'].includes(tile.biome) || tile.elevation !== undefined && (typeof tile.elevation !== 'number' || !Number.isFinite(tile.elevation) || tile.elevation < 0 || tile.elevation > 1)) fail();
    if (keys.has(key) || !w.chunks[chunkKey(tile.x, tile.y)] || (tile.wood !== undefined && (!Number.isFinite(tile.wood) || tile.wood < 0 || tile.wood > 12)) || (tile.stone !== undefined && (!Number.isFinite(tile.stone) || tile.stone < 0 || tile.stone > 8))) fail();
    keys.add(key);
  }
  for (const [key, chunk] of Object.entries(w.chunks)) {
    if (!chunk || chunk.key !== key || !Number.isInteger(chunk.cx) || !Number.isInteger(chunk.cy) || !validCoordinate(chunk.cx * 16) || !validCoordinate(chunk.cy * 16) || chunkKey(chunk.cx * 16, chunk.cy * 16) !== key || typeof chunk.discovered !== 'boolean' || !Array.isArray(chunk.places) || chunk.places.length > 32 || !Number.isSafeInteger(chunk.lastTick) || chunk.lastTick < 0 || chunk.lastTick > w.tick) fail();
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (!keys.has(`${chunk.cx * 16 + x},${chunk.cy * 16 + y}`)) fail();
    for (const place of chunk.places) {
      if (!place || typeof place.id !== 'string' || place.id.length > 100 || typeof place.name !== 'string' || place.name.length > 200 || typeof place.description !== 'string' || place.description.length > 2000 || !validCoordinate(place.x) || !validCoordinate(place.y) || chunkKey(place.x, place.y) !== key || !Number.isInteger(place.gatherings) || place.gatherings < 0 || place.gatherings > 1_000_000 || !w.places.some(p => p.id === place.id && p.x === place.x && p.y === place.y)) fail();
    }
  }
  const numericMap = (v: unknown, min: number, max: number, limit: number) => v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v).length <= limit && Object.entries(v).every(([k, n]) => k.length <= 50 && typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max);
  // Los contadores V23 se suman a los heredados (y no cuentan en su tope): sin esto, el primer mundo con cuerpos que
  // come y bebe pasa de 13 claves y ningún guardado suyo se puede leer ni (con v23.guardadoCompleto) escribir.
  const totalesValidos = (v: unknown, heredados: number): boolean => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const entradas = Object.entries(v), v23 = entradas.filter(([k]) => ES_TOTAL_V23.has(k));
    return !!numericMap(Object.fromEntries(entradas.filter(([k]) => !ES_TOTAL_V23.has(k))), 0, 1e12, heredados)
      && v23.every(([, n]) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
  };
  for (const p of w.people) {
    if (validarCuerpos) {
      assertCuerpo(p.cuerpo, w.tick, true);
      assertCarga(p.carga);
    }
    if (expectedVersion >= 3) {
      assertGenome(p.genome);
      if (p.genome.parents.length) {
        const parents = p.genome.parents.map(id => identity(id));
        if (parents.some(parent => !parent || parent.id === p.id || parent.bornAt >= p.bornAt || ('diedAt' in parent && parent.diedAt < p.bornAt) || parent.genome.generation >= p.genome.generation) || p.genome.generation !== Math.max(...parents.map(parent => parent!.genome.generation)) + 1) fail();
      }
      if (typeof p.thirst !== 'number' || !Number.isFinite(p.thirst) || p.thirst < 0 || p.thirst > 1 || !Number.isSafeInteger(p.bornAt) || p.bornAt < -MAX_FOUNDER_AGE_TICKS || p.bornAt > w.tick || !Number.isSafeInteger(p.lastBirth) || p.lastBirth < -2400 || p.lastBirth > w.tick || !Number.isSafeInteger(p.lastSocial) || p.lastSocial < -30 || p.lastSocial > w.tick || !Number.isSafeInteger(p.lastDispute) || p.lastDispute < -180 || p.lastDispute > w.tick || !Number.isSafeInteger(p.lastPracticeMemory) || p.lastPracticeMemory < 0 || p.lastPracticeMemory > w.tick || !numericMap(p.culture, 0, 1, 3) || !['sharing','stewardship','openness'].every(key => typeof p.culture[key as keyof Culture] === 'number') || !numericMap(p.bonds, 0, 1, populationCap) || Object.keys(p.bonds).some(id => !alive.has(id)) || !(p.communityId === null || typeof p.communityId === 'string' && w.communities?.some(c => c.id === p.communityId))) fail();
    }
    if (!['ready','hungry','thirsty','tired'].includes(p.intentContext)) fail();
    if (!p.traits || !['curiosity','sociability','industriousness','care','resilience'].every(k => typeof p.traits[k as keyof typeof p.traits] === 'number') || !numericMap(p.traits, 0, 1, 5) || !numericMap(p.skills, 0, 1, expectedVersion>=5?18:15) || !numericMap(p.values, -0.3, 0.3, expectedVersion>=5?72:60) || !numericMap(p.activity, 0, 1_000_000, expectedVersion>=5?18:15) || !p.materials || !Number.isFinite(p.materials.wood) || p.materials.wood < 0 || p.materials.wood > 12 || !Number.isFinite(p.materials.stone) || p.materials.stone < 0 || p.materials.stone > 8 || !Array.isArray(p.visited) || p.visited.length > 192 || !p.visited.every(k => typeof k === 'string' && /^-?\d+,-?\d+$/.test(k)) || !Number.isFinite(p.heading) || !Number.isSafeInteger(p.work) || p.work < 0 || p.work > (expectedVersion>=4?600:90) || !Number.isSafeInteger(p.lastOutcome) || p.lastOutcome < 0 || p.lastOutcome > w.tick || !['auto','directed'].includes(p.controlMode)) fail();

    if (p.command !== null && (!p.command || !['move','explore','gather','farm','build','rest','hunt','drink','cooperate',...(expectedVersion>=4?['invent','repair']:[]), ...(expectedVersion>=5?['research','craft','forage']:[])].includes(p.command.order) || !validCoordinate(p.command.x) || !validCoordinate(p.command.y))) fail();
    if ((p.command === null) !== (p.controlMode === 'auto')) fail();
    if (p.compounds !== undefined) assertCompoundLots(p.compounds);
    if (p.policy !== undefined) {
      if (expectedVersion < 12) fail();
      assertPolicyGenome(p.policy);
    }
    if (p.policyPlasticity !== undefined) {
      if (expectedVersion < 12) fail();
      assertPolicyPlasticity(p.policyPlasticity);
      if (expectedVersion < 13 && Object.hasOwn(p.policyPlasticity, 'baseline')) fail();
    }
  }
  if (expectedVersion >= 3) {
    if (typeof w.cooperationEnabled !== 'boolean' || typeof w.reproductionEnabled !== 'boolean' || !Array.isArray(w.communities) || w.communities.length > limits.comunidades || !Number.isSafeInteger(w.communityCounter) || w.communityCounter < 0 || !Number.isSafeInteger(w.birthCounter) || w.birthCounter < 0 || !Array.isArray(w.history) || w.history.length > 96 || !totalesValidos(w.totals, expectedVersion >= 14 ? 13 : 12)) fail();
    const communityIds = new Set<string>();
    for (const c of w.communities) {
      if (!c || typeof c.id !== 'string' || c.id.length > 80 || communityIds.has(c.id) || typeof c.name !== 'string' || c.name.length > 100 || !validCoordinate(c.x) || !validCoordinate(c.y) || typeof c.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(c.color) || !Array.isArray(c.members) || c.members.length > populationCap || new Set(c.members).size !== c.members.length || !c.members.every(id => w.people.some(p => p.id === id && p.communityId === c.id)) || !numericMap(c.culture, 0, 1, 3) || !Number.isSafeInteger(c.formedAt) || c.formedAt < 0 || c.formedAt > w.tick || !Number.isSafeInteger(c.cooperation) || c.cooperation < 0 || !Number.isSafeInteger(c.disputes) || c.disputes < 0) fail();
      communityIds.add(c.id);
      if (!['sharing','stewardship','openness'].every(key => typeof c.culture[key as keyof Culture] === 'number') || w.people.some(p => p.communityId === c.id && !c.members.includes(p.id))) fail();
    }
    for (const sample of w.history) if (!numericMap(sample, 0, 1e12, 10) || !['tick','population','energy','hunger','fatigue','thirst','discoveries','settlements','cooperation','births'].every(key => typeof sample[key as keyof WorldSample] === 'number') || !Number.isSafeInteger(sample.tick) || sample.tick > w.tick || !Number.isInteger(sample.population) || sample.population < (expectedVersion>=5?2:16) || sample.population > populationCap || [sample.energy,sample.hunger,sample.fatigue,sample.thirst].some(n => n > 1)) fail();
  }
  if (expectedVersion >= 4) {
    assertLifeState(w);
    if (validarCuerpos) for (const animal of w.animals) assertCuerpo(animal.cuerpo, w.tick, false);
  }
  if(expectedVersion>=5) {
    if (expectedVersion === 5 && (Object.hasOwn(w.technology, 'water')
      || w.people.some(p => Object.hasOwn(p.technology, 'waterActionAt') || Object.hasOwn(p.technology, 'waterCarryAt') || Object.hasOwn(p.technology, 'waterPreparation') || p.technology.items.some(item => Object.hasOwn(item, 'contents')))
      || w.technology.history.some(e => Object.hasOwn(e, 'water') || e.kind === 'water')
      || w.technology.journal?.pending.some(e => Object.hasOwn(e, 'water') || e.kind === 'water')
      || w.technology.checkpoint?.inventories.some(inv => inv.items.some(item => Object.hasOwn(item, 'contents'))))) fail();
    if (expectedVersion >= 6 && !w.technology.water) fail();
    assertPopulation(w); assertTechnology(w);
    for(const person of [...w.people,...w.legacy,...w.retiredLegacy]) {
      const serial=/^descendant-([1-9]\d*)$/.exec(person.id);
      if(person.genome.generation>0&&(!serial||!Number.isSafeInteger(Number(serial[1]))||Number(serial[1])>w.birthCounter)) fail();
    }
    const ownRecipes = [...w.technology.recipes, ...(w.technology.catalogue?.pending ?? [])];
    const recipeIds = new Set(ownRecipes.map(recipe => recipe.id));
    for (const person of w.people) {
      for (const id of person.technology.knownRecipes) recipeIds.add(id);
      for (const item of person.technology.items) if (item.recipeId) recipeIds.add(item.recipeId);
      for (const id of person.technology.project?.parents ?? []) recipeIds.add(id);
    }
    for (const inventory of w.technology.checkpoint?.inventories ?? []) for (const item of inventory.items) if (item.recipeId) recipeIds.add(item.recipeId);
    for (const event of [...w.technology.history, ...(w.technology.journal?.pending ?? [])]) {
      if (event.recipeId) recipeIds.add(event.recipeId);
      for (const id of event.parentRecipeIds) recipeIds.add(id);
      for (const catalyst of event.catalysts) if (catalyst.recipeId) recipeIds.add(catalyst.recipeId);
    }
    // assertTechnology already re-checked every id here against `recipes`/`pending` (the
    // exact source of `ownRecipes`) by shape, signature and ancestry; this loop only adds
    // the author-identity check. A Map built once turns each lookup below into O(1) instead
    // of the two full-array scans `resolveTechnologyRecipe` repeats per id — the disk-backed
    // reader stays reserved for ids retired from both arrays.
    const ownRecipesById = new Map(ownRecipes.map(recipe => [recipe.id, recipe] as const));
    for (const id of recipeIds) {
      const recipe = ownRecipesById.get(id) ?? resolveTechnologyRecipe(w, id, { cache: false });
      if (!recipe) fail();
      const author = identity(recipe!.inventorId);
      if (!author || author.bornAt > recipe!.tick || ('diedAt' in author && author.diedAt < recipe!.tick)) fail();
    }
  }
}
