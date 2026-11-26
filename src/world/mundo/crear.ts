import { type World, TICKS_PER_DAY, MAX_EVENTS, type Person, MAX_EXPERIENCES, RULES_VERSION, COOLDOWN } from './tipos.js';
import type { Point, TileLookup } from './geometria.js';
import type { WorldView, ChronicleEvent } from '../../shared/types.js';
import { tileLookup } from '../tile-index.js';
import { recordChronicleEvent } from '../chronicle-journal.js';
import { type WorldParams, setParams, DEFAULT_PARAMS, paramsOf } from '../params.js';
import { emptyTotals } from '../statistics.js';
import { defaultBlueprint } from '../inventions.js';
import { defaultTechnologyState, initialTechnologyKnowledge } from '../technology.js';
import { emptyWaterLedger } from '../technology-water.js';
import { activate, tileAt } from '../spatial.js';
import { chunkKey, legacyStructures } from '../terrain.js';
import { founderGenome, expressGenome, localRandom } from '../genetics.js';
import { initialCulture } from '../society.js';
import { founderPolicy, initialPolicyPlasticity } from '../politica.js';
import { initialDemography, demographicTraits } from '../demography.js';
import { captureTechnologyCheckpoint } from '../technology-checkpoint.js';
import { ctxSi } from '../motor/acceso.js';


export function random(world: Pick<World, 'rng'>): number {
  world.rng = (Math.imul(world.rng, 1664525) + 1013904223) >>> 0;
  return world.rng / 4294967296;
}


export function phaseAt(tick: number): WorldView['phase'] {
  const t = tick % TICKS_PER_DAY;
  return t < 300 ? 'dawn' : t < 1500 ? 'day' : t < 1800 ? 'dusk' : 'night';
}


export function walkable(world: World, p: Point, lookup?: TileLookup): boolean {
  const tile = (lookup ?? tileLookup(world.tiles))(p.x, p.y);
  return !!tile && tile.terrain !== 'water';
}


export function addEvent(world: World, event: Omit<ChronicleEvent, 'id' | 'tick'>): ChronicleEvent {
  // Con varios dueños, el suceso se numera con el contador compartido y llega al diario por el dueño (m4a).
  // Se comprueba por forma y no con `instanceof Dueno` para no cerrar el ciclo crear ↔ motor/contexto.
  const c = ctxSi(world) as (object & { hilos?: number; registrarSuceso?(e: Omit<ChronicleEvent, 'id' | 'tick'>): ChronicleEvent }) | undefined;
  if (c?.registrarSuceso && (c.hilos ?? 1) > 1) return c.registrarSuceso(event);
  const result = recordChronicleEvent(world, event);
  world.events.push(result);
  if (world.events.length > MAX_EVENTS) world.events.shift();
  return result;
}


/** FR-006: legible death registration. `advancePopulation` (lineage.ts) already emits place (x,y)
 * with the event; this adds tick and up to 3 prior events of the same actor, both in the narrated
 * `text` and in a structured `death` field, before the event is committed to the chronicle. The
 * short cause comes from `world.legacy`, which `advancePopulation` pushes the record to just before
 * emitting (never from parsing the free-text `cause`). */
export function deathContext(world: World, event: Omit<ChronicleEvent, 'id' | 'tick'>): Omit<ChronicleEvent, 'id' | 'tick'> {
  const actorId = event.actors[0];
  if (actorId === undefined || event.x === undefined || event.y === undefined) throw new Error('Evento de muerte sin actor o lugar.');
  const record = world.legacy.find(entry => entry.id === actorId);
  if (!record) throw new Error('Evento de muerte sin registro de legado correspondiente.');
  const previous = world.events.filter(e => e.actors.includes(actorId)).slice(-3).map(e => e.text);
  const history = previous.length ? ` Antes: ${previous.join(' · ')}.` : ' Sin episodios previos en la ventana reciente de la crónica.';
  return { ...event, text: `${event.text} Ocurrió en (${event.x}, ${event.y}), paso ${world.tick}.${history}`,
    death: { cause: record.cause, tick: world.tick, x: event.x, y: event.y, previous } };
}


export function remember(person: Person, world: World, text: string, causeId: string, placeId = ''): void {
  person.experiences.push({ tick: world.tick, text, causeId, placeId });
  if (person.experiences.length > MAX_EXPERIENCES) person.experiences.shift();
  person.recentMemory = text;
}


/** A reproducible procedural territory. Identities and starting memories are fictional. */
export function createWorld(seed = 20260905, params?: WorldParams): World {
  const normalizedSeed = seed >>> 0;
  const world: World = {
    version: RULES_VERSION, seed: normalizedSeed, rng: normalizedSeed, tick: 0,
    width: 40, height: 28, weather: 'clear', tiles: [], people: [],
    places: [
      { id: 'claro', name: 'El claro de las vueltas', x: 17, y: 13, description: 'Un lugar de prueba para encontrarse y seguir caminos propios.', gatherings: 0 },
      { id: 'refugio', name: 'La casa de la lluvia', x: 25, y: 8, description: 'El techo ayuda a descansar cuando llueve. Su uso puede aprenderse.', gatherings: 0 },
      { id: 'huerta', name: 'La huerta del borde', x: 10, y: 20, description: 'La humedad, la luz y el alimento conectan las visitas a este lugar.', gatherings: 0 },
    ],
    memories: [
      { id: 'sample-accompany', title: 'Quedarse un rato · ejemplo', text: 'Recuerdo sintético: en este claro, acompañar a alguien cansado dejó una buena experiencia.', source: 'sample', placeId: 'claro', context: 'partner-tired', action: 'accompany', weight: 0.85, roles: ['S', 'I'] },
      { id: 'sample-rest', title: 'Un techo compartido · ejemplo', text: 'Recuerdo sintético: descansar bajo un techo ayudó a recuperar el paso.', source: 'sample', placeId: 'refugio', context: 'shelter-tired', action: 'rest', weight: 0.22, roles: ['S', 'I'] },
      { id: 'sample-harvest', title: 'La huerta · ejemplo', text: 'Recuerdo sintético: encontrar alimento aquí dejó una preferencia por volver con hambre.', source: 'sample', placeId: 'huerta', context: 'food-hungry', action: 'eat', weight: 0.22, roles: ['S', 'I'] },
      { id: 'sample-rain', title: 'Esperar la lluvia · ejemplo', text: 'Recuerdo sintético: este techo hizo más cómoda una pausa durante la lluvia.', source: 'sample', placeId: 'refugio', context: 'rain-shelter', action: 'rest', weight: 0.3, roles: ['S', 'I'] },
      { id: 'sample-distant', title: 'Una estrella · ejemplo', text: 'Recuerdo sintético sin contexto activo: mirar una estrella. No cambia las decisiones de este prototipo.', source: 'sample', placeId: 'claro', context: 'irrelevant', action: 'explore', weight: 0.8, roles: ['S', 'I'] },
    ], events: [], eventCounter: 0, invitations: [], reminders: [],
    lastGestureTick: -COOLDOWN, learningEnabled: true,
    chunks: {}, retiredChunks: [], discoveredChunks: 0, settlementCount: 0,
    adaptationEnabled: true, noveltyEnabled: true, shelterBenefitEnabled: true,
    cooperationEnabled: true, reproductionEnabled: true, communities: [], communityCounter: 0, birthCounter: 0, history: [], totals: emptyTotals(),
    animals: [], animalCounter: 0, animalDynamics: { births: 0, deaths: 0, predations: 0, humanHunts: 0, waterConsumed: 0, plantConsumed: 0 },
    blueprints: [defaultBlueprint()], structures: [], blueprintCounter: 0, structureCounter: 0,
    inventionDynamics: { attempts: 0, accepted: 0, repairs: 0, waterCollected: 0, foodStored: 0, foodTaken: 0 },
    technology: { ...defaultTechnologyState(), water: emptyWaterLedger() }, legacy: [], retiredLegacy: [],
    demographyDynamics: { deaths: 0, causes: { starvation: 0, dehydration: 0, exposure: 0, senescence: 0 }, foodLost: 0, woodLost: 0, stoneLost: 0 },
  };
  // T035 ronda de arreglo (hallazgo crítico #2): los params del mundo deben fijarse ANTES de
  // activar el primer chunk — `activate()` lee `paramsOf(world).agua.cuencas` para generar las
  // teselas, y `paramsOf` solo ve lo que haya en el WeakMap para ESTE objeto `world` en ese
  // momento. Fijarlo al final (como antes) dejaba la región de partida siempre con el default
  // global sin importar el `params` recibido aquí.
  setParams(world, params ?? DEFAULT_PARAMS);
  for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 3; cx++) activate(world, cx * 16, cy * 16);
  for (const place of world.places.slice(0, 3)) {
    const tile = tileAt(world, place)!; tile.terrain = 'shelter';
    world.chunks[chunkKey(place.x, place.y)]!.places.push(place);
  }
  const names = ['S', 'I', 'Luma', 'Nilo', 'Duna', 'Bruma', 'Olmo', 'Vera', 'Tilo', 'Cora', 'Lino', 'Nara', 'Río', 'Alba', 'Mora', 'Sol'];
  const colors = ['#f4ce7a', '#e7a8b9', '#9dc8ae', '#9ebacc', '#d8ba91', '#b8a6cc'];
  const varianzaFundadores = (params ?? DEFAULT_PARAMS).genes.varianzaFundadores;
  const politicaActiva = (params ?? DEFAULT_PARAMS).conducta.politicaPeso > 0;
  // Con v23.intentos, S e I llevan la memoria del encuentro desde el principio (m5; forma estable, regla h).
  const v23 = (params ?? DEFAULT_PARAMS).v23;
  for (let n = 0; n < names.length; n++) {
    const place = world.places[Math.floor(n / 6) % world.places.length]!;
    const x = place.x + n % 3 - 1;
    const y = place.y + Math.floor(n % 6 / 3) - 1;
    const traits = seededTraits(normalizedSeed, n);
    const id = n === 0 ? 's' : n === 1 ? 'i' : `neighbor-${n - 1}`;
    world.people.push({
      id, name: names[n]!,
      role: n === 0 ? 'S' : n === 1 ? 'I' : 'neighbor', x, y, color: colors[n % colors.length]!,
      action: 'explore', reason: 'Observa las posibilidades cercanas.', energy: 0.78 + random(world) * 0.18,
      hunger: n === 3 || n === 5 ? 0.72 : 0.2 + random(world) * 0.28, fatigue: n === 0 ? 0.52 : 0.1 + random(world) * 0.2,
      need: 'Recorrer', recentMemory: null, inventory: 0.14,
      curiosity: traits.curiosity, sociability: traits.sociability, generosity: traits.care,
      closeness: n < 2 ? 0.55 : 0.2, socialLoad: 0, target: { x, y }, decisionAt: 0,
      lastMeeting: -300, lastShared: -60, experiences: [], habits: [],
      traits, skills: {}, materials: { wood: 0, stone: 0 }, activity: {}, values: {}, visited: [],
      heading: n * 2.399963229728653, command: null, work: 0, lastOutcome: 0, intentContext: 'ready', controlMode: 'auto',
      thirst: 0.15, genome: founderGenome(world.seed, id, traits, varianzaFundadores), bornAt: -4800, lastBirth: -2400, lastSocial: -30, lastDispute: -180, lastPracticeMemory: 0, culture: initialCulture(world.seed, id), communityId: null, bonds: {},
      ...(politicaActiva ? { policy: founderPolicy(world.seed, id), policyPlasticity: initialPolicyPlasticity() } : {}),
      ...(v23.intentos && n < 2 ? { partnerMemory: undefined } : {}),
      ...(v23.cohesion ? { home: undefined } : {}),
      ...(v23.natalidad && !v23.cuerpos ? { gestacion: undefined } : {}),
      ...(v23.cuerpos ? { cuerpo: undefined, carga: [] } : {}),
      technology: initialTechnologyKnowledge(v23), demography: initialDemography(4800),
    });
  }
  for (const person of world.people) {
    initializePerson(world, person, varianzaFundadores);
    // Founders and descendants express the same inherited loci. The authored
    // S/I characterization is preserved; this corrects fictional neighbors only.
    if (person.role === 'neighbor') {
      person.traits = expressGenome(person.genome);
      person.curiosity = person.traits.curiosity;
      person.sociability = person.traits.sociability;
      person.generosity = person.traits.care;
      assignFounderAge(world, person);
    }
  }
  world.technology.checkpoint = captureTechnologyCheckpoint(world.technology, world.people, world.tick, 'initial');
  world.structures.push(...legacyStructures(world.tiles, world.tick));
  addEvent(world, { kind: 'memory', actors: [], source: 'sample', text: 'Este mundo comienza con S, I y una vecindad ficticia. Los cinco recuerdos son ejemplos, pendientes de la historia de Steven e Isa.', cause: 'Contenido sintético identificado; no se importaron conversaciones ni biografía.' });
  return world;
}


export function initializePerson(world: World, person: Person, varianzaFundadores: number = paramsOf(world).genes.varianzaFundadores): void {
  person.thirst = 0.15; person.genome = founderGenome(world.seed, person.id, person.traits, varianzaFundadores);
  person.bornAt = world.tick - 4800; person.lastBirth = world.tick - 2400; person.lastSocial = -30; person.lastDispute = -180; person.lastPracticeMemory = world.tick;
  person.culture = initialCulture(world.seed, person.id); person.communityId = null; person.bonds = {};
}


/**
 * Hipótesis cohorte (2026-09-22): CONDICIÓN INICIAL, no ley. Con la edad fija de siempre (2 días) los
 * dieciséis fundadores maduran y envejecen a la vez, y la ventana fértil de toda la cohorte se cierra de
 * golpe hacia el día 8. `genes.edadFundadoresMinDias/MaxDias` reparten la edad de cada fundador mortal en
 * ese rango con una tirada local y propia (`localRandom(seed, 'edad-fundador:'+id)`: no consume el
 * generador del mundo), y la acotan por debajo del inicio de SU vejez: nadie empieza ya viejo. `bornAt`,
 * `lastBirth` (nunca antes del nacimiento) y `demography.age` se fijan juntos, así que
 * `age === tick − bornAt` sigue siendo cierto. Con el default 2..2 la tirada da exactamente 2 días
 * (4800 ticks) y `lastBirth` −2400: el mundo de siempre, bit a bit. S e I no pasan por aquí.
 */
function assignFounderAge(world: World, person: Person): void {
  const { genes, cuerpo } = paramsOf(world);
  const dias = genes.edadFundadoresMinDias + (genes.edadFundadoresMaxDias - genes.edadFundadoresMinDias) * localRandom(world.seed, `edad-fundador:${person.id}`)();
  const vejez = demographicTraits(person.genome, cuerpo).senescenceStart;
  const age = Math.min(Math.round(dias * TICKS_PER_DAY), vejez - 1);
  person.bornAt = world.tick - age;
  person.lastBirth = world.tick - Math.min(age, TICKS_PER_DAY);
  person.demography = initialDemography(age);
}


export function seededTraits(seed: number, index: number): Person['traits'] {
  const state = { rng: (seed ^ Math.imul(index + 1, 2654435761)) >>> 0 };
  return { curiosity: 0.1 + random(state) * 0.85, sociability: 0.1 + random(state) * 0.85, industriousness: 0.1 + random(state) * 0.85, care: 0.05 + random(state) * 0.9, resilience: 0.1 + random(state) * 0.85 };
}
