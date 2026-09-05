import { PROTOCOL_VERSION, type Action, type ChronicleEvent, type Gesture, type GestureResult, type MemoryView, type PersonView, type PlaceView, type Tile, type WorldView, type Viewport, type Order } from '../shared/types.js';
import { activate, maintainRegions, normalizeViewport, projectTerrain, tileAt, validCoordinate, type ChunkMeta, type WorldContext } from './spatial.js';
import { chunkKey, generateChunk, proceduralPlaceName, type Chunk } from './terrain.js';
export { tileAt, normalizeViewport } from './spatial.js';
export type { WorldContext } from './spatial.js';

export const RULES_VERSION = 2;
export const TICKS_PER_DAY = 2400;
export const MAX_EVENTS = 120;
export const MAX_EXPERIENCES = 8;
const MAX_HABITS = 3;
const RADIUS = 7;
const COOLDOWN = 30;
const clamp = (n: number, max = 1): number => Math.max(0, Math.min(max, n));
const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
interface Point { x: number; y: number; }
export interface Experience { tick: number; text: string; causeId: string; placeId: string; }
export interface Habit {
  placeId: string; observations: number; strength: number; demonstrator: string;
  sourceEvent: string; repetitions: number;
  evidence: { eventId: string; tick: number; demonstrator: string; recipient: string; food: number }[];
}
export interface Person extends PersonView {
  inventory: number; curiosity: number; sociability: number; generosity: number;
  closeness: number; socialLoad: number; target: Point; decisionAt: number;
  lastMeeting: number; lastShared: number; experiences: Experience[]; habits: Habit[];
  traits: NonNullable<PersonView['traits']>; skills: Record<string, number>; materials: { wood: number; stone: number };
  activity: Record<string, number>; values: Record<string, number>; visited: string[]; heading: number;
  command: { order: Exclude<Order, 'auto'>; x: number; y: number } | null;
  work: number; lastOutcome: number; intentContext: 'hungry' | 'tired' | 'ready'; controlMode: 'auto' | 'directed';
}
export interface Memory extends MemoryView {
  context: 'partner-tired' | 'shelter-tired' | 'food-hungry' | 'rain-shelter' | 'irrelevant';
  action: Action; weight: number; roles: ('S' | 'I')[];
}
export interface World {
  version: number; seed: number; rng: number; tick: number; width: number; height: number;
  weather: 'clear' | 'rain'; tiles: Tile[]; people: Person[]; places: PlaceView[];
  memories: Memory[]; events: ChronicleEvent[]; eventCounter: number;
  invitations: { id: string; x: number; y: number; until: number }[];
  reminders: { memoryId: string; until: number }[];
  lastGestureTick: number; learningEnabled: boolean;
  chunks: Record<string, ChunkMeta>; retiredChunks: Chunk[]; discoveredChunks: number; settlementCount: number;
  adaptationEnabled: boolean; noveltyEnabled: boolean; shelterBenefitEnabled: boolean;
}

function random(world: Pick<World, 'rng'>): number {
  world.rng = (Math.imul(world.rng, 1664525) + 1013904223) >>> 0;
  return world.rng / 4294967296;
}

export function phaseAt(tick: number): WorldView['phase'] {
  const t = tick % TICKS_PER_DAY;
  return t < 300 ? 'dawn' : t < 1500 ? 'day' : t < 1800 ? 'dusk' : 'night';
}

function walkable(world: World, p: Point): boolean {
  const tile = tileAt(world, p);
  return !!tile && tile.terrain !== 'water';
}

function addEvent(world: World, event: Omit<ChronicleEvent, 'id' | 'tick'>): ChronicleEvent {
  const result = { ...event, id: `e${++world.eventCounter}`, tick: world.tick };
  world.events.push(result);
  if (world.events.length > MAX_EVENTS) world.events.shift();
  return result;
}

function remember(person: Person, world: World, text: string, causeId: string, placeId = ''): void {
  person.experiences.push({ tick: world.tick, text, causeId, placeId });
  if (person.experiences.length > MAX_EXPERIENCES) person.experiences.shift();
  person.recentMemory = text;
}

/** A reproducible procedural territory. Identities and starting memories are fictional. */
export function createWorld(seed = 20260905): World {
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
  };
  for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 3; cx++) activate(world, cx * 16, cy * 16);
  for (const place of world.places.slice(0, 3)) {
    const tile = tileAt(world, place)!; tile.terrain = 'shelter';
    world.chunks[chunkKey(place.x, place.y)]!.places.push(place);
  }
  const names = ['S', 'I', 'Luma', 'Nilo', 'Duna', 'Bruma', 'Olmo', 'Vera', 'Tilo', 'Cora', 'Lino', 'Nara', 'Río', 'Alba', 'Mora', 'Sol'];
  const colors = ['#f4ce7a', '#e7a8b9', '#9dc8ae', '#9ebacc', '#d8ba91', '#b8a6cc'];
  for (let n = 0; n < names.length; n++) {
    const place = world.places[Math.floor(n / 6) % world.places.length]!;
    const x = place.x + n % 3 - 1;
    const y = place.y + Math.floor(n % 6 / 3) - 1;
    const traits = seededTraits(normalizedSeed, n);
    world.people.push({
      id: n === 0 ? 's' : n === 1 ? 'i' : `neighbor-${n - 1}`, name: names[n]!,
      role: n === 0 ? 'S' : n === 1 ? 'I' : 'neighbor', x, y, color: colors[n % colors.length]!,
      action: 'explore', reason: 'Observa las posibilidades cercanas.', energy: 0.78 + random(world) * 0.18,
      hunger: n === 3 || n === 5 ? 0.72 : 0.2 + random(world) * 0.28, fatigue: n === 0 ? 0.52 : 0.1 + random(world) * 0.2,
      need: 'Recorrer', recentMemory: null, inventory: 0.14,
      curiosity: traits.curiosity, sociability: traits.sociability, generosity: traits.care,
      closeness: n < 2 ? 0.55 : 0.2, socialLoad: 0, target: { x, y }, decisionAt: 0,
      lastMeeting: -300, lastShared: -60, experiences: [], habits: [],
      traits, skills: {}, materials: { wood: 0, stone: 0 }, activity: {}, values: {}, visited: [],
      heading: n * 2.399963229728653, command: null, work: 0, lastOutcome: 0, intentContext: 'ready', controlMode: 'auto',
    });
  }
  addEvent(world, { kind: 'memory', actors: [], source: 'sample', text: 'Este mundo comienza con S, I y una vecindad ficticia. Los cinco recuerdos son ejemplos, pendientes de la historia de Steven e Isa.', cause: 'Contenido sintético identificado; no se importaron conversaciones ni biografía.' });
  return world;
}

function seededTraits(seed: number, index: number): Person['traits'] {
  const state = { rng: (seed ^ Math.imul(index + 1, 2654435761)) >>> 0 };
  return { curiosity: 0.1 + random(state) * 0.85, sociability: 0.1 + random(state) * 0.85, industriousness: 0.1 + random(state) * 0.85, care: 0.05 + random(state) * 0.9, resilience: 0.1 + random(state) * 0.85 };
}

function ecology(world: World): void {
  if (world.tick % 600 === 0) {
    const previous = world.weather;
    world.weather = random(world) < 0.4 ? 'rain' : 'clear';
    if (world.weather !== previous) addEvent(world, {
      kind: 'ecology', actors: [], source: 'simulation',
      text: world.weather === 'rain' ? 'La lluvia humedece la tierra; el alimento crecerá si también hay luz.' : 'La lluvia deja paso al cielo abierto.',
      cause: 'Cambio de tiempo del generador guardado; la lluvia aporta agua, no alimento instantáneo.',
    });
  }
  if (world.tick % 10 !== 0) return;
  const phase = phaseAt(world.tick);
  const light = phase === 'day' ? 1 : phase === 'night' ? 0 : 0.4;
  for (const tile of world.tiles) {
    if (tile.terrain === 'water') continue;
    // Neighbor water is an explicit, local moisture source.
    const nearWater = [[tile.x - 1, tile.y], [tile.x + 1, tile.y], [tile.x, tile.y - 1], [tile.x, tile.y + 1]]
      .some(([x, y]) => tileAt(world, { x: x!, y: y! })?.terrain === 'water');
    tile.moisture = clamp(tile.moisture + (world.weather === 'rain' ? 0.012 : 0) + (nearWater ? 0.008 : 0) - 0.0015 - light * 0.001);
    const growth = light * tile.moisture * 0.007 * (1 - tile.vegetation);
    tile.vegetation = clamp(tile.vegetation + growth - (tile.moisture < 0.15 ? 0.0015 : 0.0001));
    tile.food = clamp(tile.food + light * tile.moisture * tile.vegetation * 0.006 * (1 - tile.food) - 0.0001);
  }
}

interface Candidate { action: Action; target: Point; score: number; reason: string; memory?: Memory; }

function choose(world: World, person: Person): void {
  const nearbyTiles = world.tiles.filter(tile => tile.terrain !== 'water' && distance(person, tile) <= RADIUS);
  const nearbyPeople = world.people.filter(other => other.id !== person.id && distance(person, other) <= RADIUS);
  const partner = nearbyPeople.find(other => person.role !== 'neighbor' && other.role !== 'neighbor');
  const candidates: Candidate[] = [{ action: 'explore', target: person.target, score: 0.33 + person.curiosity * 0.18, reason: 'Tiene energía y curiosidad por lo que hay cerca.' }];
  const food = nearbyTiles.filter(tile => tile.food > 0.025).sort((a, b) => (distance(person, a) - a.food * 2) - (distance(person, b) - b.food * 2))[0];
  if (food || person.inventory > 0.01) candidates.push({ action: 'eat', target: food ?? person, score: Math.max(0, person.hunger - 0.22) * 2.5 - (food ? distance(person, food) * 0.02 : 0), reason: 'El hambre orienta su camino hacia alimento que puede percibir.' });
  const shelter = nearbyTiles.filter(tile => tile.terrain === 'shelter').sort((a, b) => distance(person, a) - distance(person, b))[0];
  candidates.push({ action: 'rest', target: shelter ?? person, score: person.fatigue * 1.75 + (1 - person.energy) * 1.2 + (phaseAt(world.tick) === 'night' ? 0.1 : 0), reason: shelter ? 'El cansancio hace valiosa una pausa bajo techo.' : 'Necesita una pausa; no percibe un refugio cercano.' });
  const resource = nearbyTiles.filter(t => ((t.wood ?? 0) >= 1 && person.materials.wood < 12) || ((t.stone ?? 0) >= 1 && person.materials.stone < 8))
    .sort((a, b) => resourceDistance(person, a) - resourceDistance(person, b))[0];
  const workBias = person.traits.industriousness;
  const buildable = nearbyTiles.filter(t => t.terrain !== 'shelter' && t.moisture > 0.2 && t.vegetation > 0.15 && !world.places.some(p => distance(p, t) < 10))
    .sort((a, b) => distance(person, a) - distance(person, b))[0];
  if (resource && (person.materials.wood < 6 || person.materials.stone < 3)) candidates.push({ action: 'gather', target: resource, score: 0.15 + workBias * 0.4 + (!shelter ? 0.2 : 0), reason: 'Percibe materiales útiles para cultivar y levantar refugios.' });
  if (buildable && person.materials.wood >= 6 && person.materials.stone >= 3) candidates.push({ action: 'build', target: buildable, score: 0.5 + workBias * 0.45 + (!shelter ? 0.2 : 0), reason: 'Hay materiales y un lugar habitable sin refugio próximo; puede construir con trabajo.' });
  const farmland = nearbyTiles.filter(t => t.terrain !== 'shelter' && t.moisture > 0.25 && t.vegetation < 0.8).sort((a, b) => distance(person, a) - distance(person, b))[0];
  if (farmland && person.materials.wood >= 1) candidates.push({ action: 'farm', target: farmland, score: 0.12 + workBias * 0.3 + (food && food.food < 0.2 ? 0.2 : 0), reason: 'Puede preparar tierra húmeda; el alimento llegará después con agua y luz.' });
  if (partner) {
    if (person.socialLoad > 0.7 || partner.socialLoad > 0.8) {
      const space = nearbyTiles.filter(tile => distance(person, tile) <= 4).sort((a, b) => distance(partner, b) - distance(partner, a))[0]!;
      candidates.push({ action: 'retreat', target: space, score: 1.1 + person.socialLoad, reason: 'Después de compartir tiempo, busca espacio para recuperar su ritmo.' });
    } else {
      candidates.push({ action: 'approach', target: partner, score: person.closeness * (0.65 + person.sociability * 0.45), reason: 'Le apetece acercarse; puede ver al otro en las cercanías.' });
      candidates.push({ action: 'accompany', target: partner, score: 0.18 + person.sociability * 0.1 + (partner.action === 'rest' ? 0.1 : 0), reason: 'Elige compartir una pausa con quien está cerca.' });
    }
  }
  for (const invitation of world.invitations) {
    if (distance(person, invitation) <= RADIUS && person.hunger < 0.65 && person.fatigue < 0.7 && person.socialLoad < 0.7) candidates.push({ action: 'approach', target: invitation, score: 0.67 + person.sociability * 0.15, reason: 'Percibe una invitación y sus necesidades le permiten acercarse.' });
  }
  const place = world.places.find(p => distance(person, p) <= 3);
  const hungry = nearbyPeople.filter(other => distance(person, other) <= 2 && other.hunger > 0.27).sort((a, b) => b.hunger - a.hunger)[0];
  const learned = place ? person.habits.find(habit => habit.placeId === place.id && habit.strength >= 0.5) : undefined;
  if (place && hungry && person.inventory >= 0.025 && person.hunger < 0.5 && world.tick - person.lastShared >= 30) candidates.push({
    action: 'share', target: hungry, score: 0.22 + person.generosity * 1.25 + (learned ? learned.strength : 0),
    reason: learned ? `Repite en ${place.name} el cuidado que observó de otra persona.` : 'Puede compartir parte de lo que recogió con alguien que tiene hambre.',
  });
  // Learning also makes a locally known meeting place attractive; it cannot reveal distant places.
  for (const habit of person.habits) {
    const knownPlace = world.places.find(p => p.id === habit.placeId);
    const usefulVisit = knownPlace && person.inventory >= 0.025 && nearbyPeople.some(p => distance(p, knownPlace) <= 3 && p.hunger > 0.27);
    if (habit.strength >= 0.5 && knownPlace && usefulVisit && distance(person, knownPlace) <= RADIUS && person.hunger < 0.5) candidates.push({ action: 'approach', target: knownPlace, score: 0.43 + habit.strength * 0.3, reason: `Recuerda el cuidado compartido en ${knownPlace.name} y vuelve por decisión propia.` });
  }
  for (const memory of world.memories) {
    if (person.role === 'neighbor' || !memory.roles.includes(person.role)) continue;
    const memoryPlace = world.places.find(p => p.id === memory.placeId);
    if (!memoryPlace || distance(person, memoryPlace) > 4) continue;
    const relevant = memory.context === 'partner-tired' ? !!partner && partner.fatigue > 0.45 && person.socialLoad < 0.7
      : memory.context === 'shelter-tired' ? person.fatigue > 0.4
      : memory.context === 'food-hungry' ? person.hunger > 0.4
      : memory.context === 'rain-shelter' ? world.weather === 'rain' && person.fatigue > 0.2 : false;
    if (!relevant) continue;
    for (const candidate of candidates) if (candidate.action === memory.action) {
      candidate.score += memory.weight + (world.reminders.some(reminder => reminder.memoryId === memory.id) ? 0.1 : 0);
      candidate.memory = memory;
    }
  }
  for (const candidate of candidates) candidate.score += person.values[valueKey(person, candidate.action)] ?? 0;
  if (person.command && person.hunger < 0.85 && person.fatigue < 0.88 && person.energy > 0.15) {
    const command = person.command;
    const directed: Candidate = { action: command.order === 'move' ? 'explore' : command.order, target: { x: command.x, y: command.y }, score: 5, reason: `Tarea solicitada: ${command.order === 'move' ? 'ir al destino' : actionLabel(command.order)}. Conserva sus necesidades corporales.` };
    if (command.order === 'explore') directed.target = explorationTarget(world, person, nearbyTiles);
    if (command.order === 'gather' && distance(person, command) <= 2 && resource) directed.target = resource;
    candidates.push(directed);
  }
  candidates.sort((a, b) => b.score - a.score);
  const selected = candidates[0]!;
  if (selected.action === 'explore' && selected.score < 5) selected.target = explorationTarget(world, person, nearbyTiles);
  if (person.action !== selected.action || distance(person.target, selected.target) > 0) person.work = 0;
  person.action = selected.action;
  person.intentContext = person.hunger > 0.5 ? 'hungry' : person.fatigue > 0.5 ? 'tired' : 'ready';
  person.target = { x: selected.target.x, y: selected.target.y };
  person.reason = selected.memory ? `${selected.reason} Influye «${selected.memory.title}», ${selected.memory.source === 'sample' ? 'material de prueba' : 'recuerdo aprobado'}.` : selected.reason;
  person.decisionAt = world.tick + 30;
  if (selected.memory && person.recentMemory !== selected.memory.text) {
    const event = addEvent(world, { kind: 'memory', actors: [person.id], text: `${person.name} eligió ${actionLabel(selected.action)} al recordar «${selected.memory.title}».`, cause: `Contexto ${selected.memory.context}; recuerdo ${selected.memory.id}; aumenta la preferencia por ${selected.action}.`, x: person.x, y: person.y, source: selected.memory.source });
    remember(person, world, selected.memory.text, event.id, selected.memory.placeId);
  }
}

function actionLabel(action: Action): string {
  return ({ explore: 'explorar', eat: 'buscar alimento', rest: 'descansar', approach: 'acercarse', accompany: 'acompañar', retreat: 'tomar espacio', share: 'compartir alimento', gather: 'recolectar', farm: 'cultivar', build: 'construir' })[action];
}

function resourceDistance(person: Person, tile: Tile): number {
  const useful = person.materials.wood < 6 ? (tile.wood ?? 0) >= 1 : (tile.stone ?? 0) >= 1;
  return distance(person, tile) + (useful ? 0 : 20);
}
function explorationTarget(world: World, person: Person, tiles: Tile[]): Point {
  const options = tiles.filter(t => distance(person, t) >= 3 && distance(person, t) <= 6);
  const heading = { x: Math.cos(person.heading), y: Math.sin(person.heading) };
  const score = (t: Tile) => ((t.x - person.x) * heading.x + (t.y - person.y) * heading.y) * 0.2 + (world.noveltyEnabled && !person.visited.includes(`${t.x},${t.y}`) ? 2 : 0);
  return options.sort((a, b) => score(b) - score(a) || a.x - b.x || a.y - b.y)[0] ?? person;
}
function valueKey(person: Person, action: Action): string { return `${person.hunger > 0.5 ? 'hungry' : person.fatigue > 0.5 ? 'tired' : 'ready'}:${action}`; }
/** Update only after an observed outcome, including failed work. Skills require useful production. */
function outcome(world: World, person: Person, action: Action, benefit: number, useful = true): void {
  const key = `${person.intentContext}:${action}`;
  if (world.adaptationEnabled) person.values[key] = Math.max(-0.3, Math.min(0.3, (person.values[key] ?? 0) + 0.12 * (benefit - (person.values[key] ?? 0))));
  person.lastOutcome = world.tick;
  if (!useful) return;
  person.skills[action] = clamp((person.skills[action] ?? 0) + 0.008);
  person.activity[action] = Math.min(1_000_000, (person.activity[action] ?? 0) + 1);
}
function specialty(person: Person): string {
  const names: Record<string, string> = { explore: 'exploración', eat: 'recolección de alimento', rest: 'recuperación', share: 'cuidado', gather: 'materiales', farm: 'cultivo', build: 'construcción' };
  const practiced = Object.entries(person.activity).filter(([, count]) => count >= 3).sort((a, b) => b[1] - a[1]).slice(0, 2);
  return practiced.length ? practiced.map(([action]) => names[action] ?? action).join(' · ') : 'Descubriendo sus aptitudes';
}

/** Breadth-first movement takes one adjacent land cell. It never crosses water or teleports. */
function move(world: World, person: Person): void {
  if (distance(person, person.target) < 0.5) return;
  const key = (p: Point) => `${p.x},${p.y}`;
  const start = { x: person.x, y: person.y };
  const queue: Point[] = [start], previous = new Map<string, Point | null>([[key(start), null]]);
  let best = start, head = 0;
  // Bounded local BFS takes one physical step toward even a distant order.
  while (head < queue.length && head < 2048) {
    const current = queue[head++]!;
    if (distance(current, person.target) < distance(best, person.target)) best = current;
    if (distance(current, person.target) < 0.5) { best = current; break; }
    for (const next of [{ x: current.x + 1, y: current.y }, { x: current.x, y: current.y + 1 }, { x: current.x - 1, y: current.y }, { x: current.x, y: current.y - 1 }]) {
      if (Math.max(Math.abs(next.x - start.x), Math.abs(next.y - start.y)) > 24 || !walkable(world, next) || previous.has(key(next))) continue;
      previous.set(key(next), current); queue.push(next);
    }
  }
  if (best === start) {
    person.heading += 1.3; person.decisionAt = world.tick + 1;
    if (world.tick - person.lastOutcome >= 30) outcome(world, person, person.action, -0.15, false);
    person.reason = 'El terreno bloquea el paso; busca una ruta local posible.';
    if (person.command) {
      person.command = null; person.controlMode = 'auto'; person.action = 'rest'; person.target = { ...start }; person.decisionAt = world.tick + 30;
      person.reason = 'Tarea interrumpida: no encontró una ruta en el terreno cercano. Prueba un destino intermedio.';
      addEvent(world, { kind: 'gesture', actors: [person.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} interrumpió una tarea por un camino bloqueado.`, cause: 'Búsqueda local acotada sin ruta de avance; vuelve a autonomía y conserva el lugar físico.' });
    }
    return;
  }
  while (previous.get(key(best)) !== start) best = previous.get(key(best))!;
  person.x = best.x; person.y = best.y;
  person.energy = clamp(person.energy - 0.0008);
  person.fatigue = clamp(person.fatigue + 0.0007 * (1.2 - person.traits.resilience * 0.4));
  if (!person.visited.includes(key(person))) {
    person.visited.push(key(person)); person.visited = person.visited.slice(-192);
    if (person.action === 'explore') outcome(world, person, 'explore', 0.05);
  }
  if (person.command?.order === 'move' && distance(person, person.command) < 0.5) {
    person.command = null; person.controlMode = 'auto'; person.decisionAt = world.tick + 1;
    person.reason = 'Llegó al destino solicitado; retoma sus decisiones.';
  }
}

function share(world: World, donor: Person): void {
  if (donor.inventory < 0.025 || donor.hunger >= 0.5 || world.tick - donor.lastShared < 30) return;
  const place = world.places.find(p => distance(donor, p) <= 3);
  const recipient = world.people.filter(p => p.id !== donor.id && p.hunger > 0.27 && distance(p, donor) <= 2).sort((a, b) => b.hunger - a.hunger)[0];
  if (!place || !recipient) return;
  donor.inventory = clamp(donor.inventory - 0.025, 0.25);
  donor.energy = clamp(donor.energy - 0.001);
  recipient.hunger = clamp(recipient.hunger - 0.12);
  recipient.energy = clamp(recipient.energy + 0.03);
  donor.lastShared = world.tick;
  outcome(world, donor, 'share', 0.16);
  place.gatherings = Math.min(1_000_000, place.gatherings + 1);
  const habit = donor.habits.find(h => h.placeId === place.id && h.strength >= 0.5);
  if (habit) habit.repetitions = Math.min(1_000_000, habit.repetitions + 1);
  const event = addEvent(world, {
    kind: 'care', actors: [donor.id, recipient.id], x: donor.x, y: donor.y, source: 'simulation',
    text: `${donor.name} compartió alimento con ${recipient.name} en ${place.name}.${habit ? ' Repitió una costumbre observada.' : ''}`,
    cause: `Reserva de ${donor.name} −0.025; hambre de ${recipient.name} −0.12.${habit ? ` Imitación de ${habit.demonstrator}, observada en ${habit.sourceEvent}; repetición ${habit.repetitions}.` : ' Iniciativa propia y hambre local.'}`,
  });
  remember(donor, world, `Compartió alimento en ${place.name}.`, event.id, place.id);
  remember(recipient, world, `Recibió alimento de ${donor.name}.`, event.id, place.id);
  if (!world.learningEnabled) return;
  for (const observer of world.people) {
    if (observer.id === donor.id || distance(observer, donor) > 3) continue;
    let observed = observer.habits.find(h => h.placeId === place.id);
    if (!observed) {
      observed = { placeId: place.id, observations: 0, strength: 0, demonstrator: donor.id, sourceEvent: event.id, repetitions: 0, evidence: [] };
      if (observer.habits.length >= MAX_HABITS) observer.habits.shift();
      observer.habits.push(observed);
    }
    observed.observations = Math.min(10, observed.observations + 1);
    if (observed.evidence.length < 2) observed.evidence.push({ eventId: event.id, tick: world.tick, demonstrator: donor.id, recipient: recipient.id, food: 0.025 });
    if (observed.observations >= 2 && observed.strength < 0.5) {
      observed.strength = 0.65;
      const learned = addEvent(world, { kind: 'learning', actors: [...new Set([observed.demonstrator, donor.id, observer.id])], x: place.x, y: place.y, source: 'simulation', text: `${observer.name} aprendió a compartir en ${place.name}, después de observar cuidado repetido.`, cause: observed.evidence.map(e => `${e.demonstrator} compartió ${e.food} con ${e.recipient} en paso ${e.tick}, hecho ${e.eventId}`).join('; ') });
      remember(observer, world, `Aprendió a compartir de ${donor.name}.`, learned.id, place.id);
    }
  }
}

function bodyAndAction(world: World, person: Person): void {
  const tile = tileAt(world, person)!;
  person.hunger = clamp(person.hunger + 0.00027);
  person.energy = clamp(person.energy - 0.00007 - (person.hunger > 0.85 ? 0.00015 : 0));
  person.fatigue = clamp(person.fatigue + 0.00009 + (world.weather === 'rain' && tile.terrain !== 'shelter' ? 0.0001 : 0));
  person.closeness = clamp(person.closeness + 0.0001);
  person.socialLoad = clamp(person.socialLoad - 0.0008);
  const emptyFood = person.action === 'eat' && (tileAt(world, person.target)?.food ?? 0) < 0.005 && person.inventory < 0.01;
  if (world.tick >= person.decisionAt || emptyFood || (person.hunger > 0.9 && person.action !== 'eat')) choose(world, person);
  if (world.tick % 6 === 0 && !(person.action === 'accompany' && distance(person, person.target) <= 1.5)) move(world, person);
  const current = tileAt(world, person)!;
  if (person.action === 'eat') {
    const harvest = Math.min(current.food, 0.0035);
    current.food = clamp(current.food - harvest);
    current.vegetation = clamp(current.vegetation - harvest * 0.1);
    // Harvested biomass is divided between today's meal and a bounded portable reserve.
    const saved = Math.min(harvest * 0.25, 0.25 - person.inventory);
    person.inventory += saved;
    let consumed = harvest - saved;
    if (consumed < 0.001 && person.inventory > 0 && person.hunger > 0.2) {
      const carried = Math.min(person.inventory, 0.002);
      person.inventory -= carried; consumed += carried;
    }
    person.hunger = clamp(person.hunger - consumed * 4.8);
    person.energy = clamp(person.energy + consumed * 1.2);
    if (consumed > 0 && world.tick - person.lastOutcome >= 30) outcome(world, person, 'eat', consumed * 30);
    if (person.hunger < 0.12) person.decisionAt = world.tick + 1;
  }
  if (person.action === 'rest' && distance(person, person.target) < 0.5) {
    const quality = current.terrain === 'shelter' && world.shelterBenefitEnabled ? 1 : world.weather === 'rain' ? 0.2 : 0.55;
    person.fatigue = clamp(person.fatigue - 0.0018 * quality);
    // Energy is readiness for activity, not a thermodynamic measurement. Food availability limits recovery.
    person.energy = clamp(person.energy + 0.0011 * quality * clamp((1 - person.hunger) / 0.5));
  }
  if (person.action === 'share') share(world, person);
  if (['gather', 'farm', 'build'].includes(person.action) && distance(person, person.target) < 0.5) performWork(world, person, current);
  person.need = person.hunger > 0.6 ? 'Alimento' : person.fatigue > 0.55 || person.energy < 0.35 ? 'Descanso' : person.socialLoad > 0.7 ? 'Espacio propio' : person.closeness > 0.5 && person.role !== 'neighbor' ? 'Compañía' : 'Recorrer';
}

function performWork(world: World, person: Person, tile: Tile): void {
  person.energy = clamp(person.energy - 0.0003);
  person.fatigue = clamp(person.fatigue + 0.00025 * (1.2 - person.traits.resilience * 0.4));
  person.work++;
  const duration = person.action === 'build' ? 90 : person.action === 'farm' ? 45 : 18;
  if (person.work < Math.ceil(duration * (1 - (person.skills[person.action] ?? 0) * 0.25))) return;
  person.work = 0;
  let success = false;
  if (person.action === 'gather') {
    const preferred = person.materials.wood < 6 ? 'wood' : 'stone';
    for (const material of [preferred, preferred === 'wood' ? 'stone' : 'wood'] as const) {
      if ((tile[material] ?? 0) < 1 || person.materials[material] >= (material === 'wood' ? 12 : 8)) continue;
      tile[material] = (tile[material] ?? 0) - 1; person.materials[material]++; success = true; break;
    }
  } else if (person.action === 'farm' && person.materials.wood >= 1 && tile.terrain !== 'shelter' && tile.moisture > 0.2 && tile.vegetation < 0.9) {
    person.materials.wood--; tile.vegetation = clamp(tile.vegetation + 0.18); tile.terrain = 'meadow'; success = true;
  } else if (person.action === 'build' && person.materials.wood >= 6 && person.materials.stone >= 3 && tile.terrain !== 'shelter' && !world.places.some(p => distance(p, tile) < 5)) {
    person.materials.wood -= 6; person.materials.stone -= 3; tile.terrain = 'shelter'; success = true;
    const place: PlaceView = { id: `settlement-${tile.x}-${tile.y}`, name: `Refugio de ${proceduralPlaceName(world.seed, tile.x, tile.y)}`, x: tile.x, y: tile.y, description: `Construido por ${person.name}; ofrece descanso y un lugar de encuentro.`, gatherings: 0 };
    world.places.push(place); world.chunks[chunkKey(tile.x, tile.y)]!.places.push(place); world.settlementCount++;
    const event = addEvent(world, { kind: 'settlement', actors: [person.id], source: 'simulation', x: tile.x, y: tile.y, text: `${person.name} levantó ${place.name}.`, cause: 'Trabajo completado; inventario −6 madera y −3 piedra. El techo mejora el descanso local.' });
    remember(person, world, `Construyó un lugar que otros pueden utilizar.`, event.id, place.id);
  }
  outcome(world, person, person.action, success ? person.action === 'build' ? 0.3 : 0.14 : -0.2, success);
  if (!success) person.reason = 'La tarea no produjo un resultado: faltan recursos o condiciones. Esa experiencia reduce su preferencia.';
  if (person.command && ['build', 'farm'].includes(person.command.order)) { person.command = null; person.controlMode = 'auto'; }
  person.decisionAt = world.tick + 1;
}

function encounters(world: World): void {
  const s = world.people.find(p => p.role === 'S');
  const i = world.people.find(p => p.role === 'I');
  if (!s || !i || distance(s, i) > 1.5 || s.action === 'retreat' || i.action === 'retreat' || s.socialLoad > 0.8 || i.socialLoad > 0.8) return;
  if (!['approach', 'accompany', 'rest', 'share'].includes(s.action) || !['approach', 'accompany', 'rest', 'share'].includes(i.action)) return;
  for (const person of [s, i]) {
    // Shared pauses reduce exertion; they do not create food or erase hunger.
    person.fatigue = clamp(person.fatigue - 0.0006);
    person.energy = clamp(person.energy + 0.00025 * clamp((1 - person.hunger) / 0.5));
    person.socialLoad = clamp(person.socialLoad + 0.002);
    person.closeness = clamp(person.closeness - 0.0018);
  }
  if (world.tick - s.lastMeeting < 240) return;
  s.lastMeeting = world.tick; i.lastMeeting = world.tick;
  const place = world.places.find(p => distance(s, p) <= 3);
  const event = addEvent(world, { kind: 'meeting', actors: [s.id, i.id], source: 'simulation', x: s.x, y: s.y, text: 'S e I compartieron una pausa. Después podrán volver a sus propios caminos.', cause: 'Cercanía percibida, disposición de ambos y una acción de compañía; la pausa reduce cansancio, sin producir alimento.' });
  for (const person of [s, i]) remember(person, world, 'Una pausa acompañada ayudó a recuperar el ritmo.', event.id, place?.id);
}

function applyGesture(world: World, gesture: Gesture, order: number): GestureResult {
  const result = (accepted: boolean, message: string): GestureResult => ({ id: gesture.id, accepted, tick: world.tick, order, message });
  if (!validCoordinate(gesture.x) || !validCoordinate(gesture.y)) return result(false, 'Elige un destino dentro del rango de coordenadas.');
  if (gesture.kind === 'command') {
    const person = world.people.find(p => p.id === gesture.agentId);
    if (!person || !gesture.order || !['move', 'explore', 'gather', 'farm', 'build', 'rest', 'auto'].includes(gesture.order)) return result(false, 'Habitante u orden desconocida.');
    if (distance(person, gesture) > 4096) return result(false, 'El destino de una tarea debe quedar a menos de 4096 celdas.');
    person.command = gesture.order === 'auto' ? null : { order: gesture.order, x: gesture.x, y: gesture.y };
    person.controlMode = person.command ? 'directed' : 'auto'; person.work = 0; person.decisionAt = world.tick;
    addEvent(world, { kind: 'gesture', actors: [person.id], x: person.x, y: person.y, source: 'simulation', text: gesture.order === 'auto' ? `${person.name} vuelve a elegir sus tareas.` : `${person.name} recibió una tarea: ${gesture.order}.`, cause: 'Orden explícita; conserva desplazamiento físico, costes y necesidades.' });
    return result(true, gesture.order === 'auto' ? 'Retoma sus decisiones.' : 'Tarea recibida. Se desplazará por tierra y cuidará sus necesidades.');
  }
  if (!walkable(world, gesture) || !world.people.some(p => distance(p, gesture) <= RADIUS)) return result(false, 'Elige tierra a la vista de algún habitante.');
  if (!['plant', 'invite', 'remember'].includes(gesture.kind)) return result(false, 'Este gesto no existe.');
  const memory = gesture.kind === 'remember' ? world.memories.find(m => m.id === gesture.memoryId) : undefined;
  if (gesture.kind === 'remember') {
    const place = world.places.find(p => p.id === memory?.placeId);
    if (!memory || !place || distance(gesture, place) > 4) return result(false, 'Ese recuerdo necesita su lugar y un contenido disponible.');
  }
  if (world.tick - world.lastGestureTick < COOLDOWN) return result(false, 'Deja pasar tres segundos del mundo antes de otro gesto.');
  if (gesture.kind === 'plant') {
    const tile = tileAt(world, gesture)!;
    if (tile.vegetation >= 0.95) return result(false, 'Este lugar ya está cubierto de plantas.');
    tile.vegetation = clamp(tile.vegetation + 0.12);
  } else if (gesture.kind === 'invite') {
    world.invitations.push({ id: gesture.id, x: gesture.x, y: gesture.y, until: world.tick + 300 });
    world.invitations = world.invitations.slice(-8);
    for (const person of world.people) if (distance(person, gesture) <= RADIUS) person.decisionAt = Math.min(person.decisionAt, world.tick + 1);
  } else if (memory) {
    world.reminders = world.reminders.filter(r => r.memoryId !== memory.id);
    world.reminders.push({ memoryId: memory.id, until: world.tick + 600 });
    world.reminders = world.reminders.slice(-8);
    for (const person of world.people) if (distance(person, gesture) <= RADIUS) person.decisionAt = Math.min(person.decisionAt, world.tick + 1);
  }
  world.lastGestureTick = world.tick;
  const text = gesture.kind === 'plant' ? 'Una planta nueva quedó en la tierra. Necesita agua y luz para crecer.' : gesture.kind === 'invite' ? 'Quedó una invitación. Quienes la perciban decidirán si acercarse.' : `Se hizo disponible «${memory!.title}». Solo influirá si su contexto coincide.`;
  addEvent(world, { kind: 'gesture', actors: [], text, cause: gesture.kind === 'plant' ? 'Entrada explícita del gesto: vegetación +0.12, sin añadir alimento.' : gesture.kind === 'invite' ? 'Señal local durante 30 segundos del mundo; las necesidades conservan prioridad.' : `Recordatorio ${memory!.id}; preferencia contextual durante 60 segundos.`, source: gesture.kind === 'remember' ? memory!.source : 'simulation', x: gesture.x, y: gesture.y });
  return result(true, text);
}

/** One fixed 100 ms step. Browser presence and wall-clock time are never inputs. */
export function stepWorld(world: World, inputs: Gesture[] = [], context: WorldContext = {}): GestureResult[] {
  world.tick++;
  maintainRegions(world, context);
  const results = inputs.map((gesture, order) => applyGesture(world, gesture, order));
  world.invitations = world.invitations.filter(invitation => invitation.until > world.tick);
  world.reminders = world.reminders.filter(reminder => reminder.until > world.tick);
  ecology(world);
  for (const person of world.people) bodyAndAction(world, person);
  for (const person of world.people) {
    const chunk = world.chunks[chunkKey(person.x, person.y)]!;
    if (!chunk.discovered) {
      chunk.discovered = true; world.discoveredChunks++;
      const event = addEvent(world, { kind: 'discovery', actors: [person.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} descubrió ${proceduralPlaceName(world.seed, chunk.cx * 16, chunk.cy * 16)}.`, cause: 'Entró físicamente en una región que ningún habitante había recorrido; mirar con la cámara no cuenta como exploración.' });
      remember(person, world, 'Un nuevo territorio amplió los caminos posibles.', event.id);
    }
  }
  encounters(world);
  return results;
}

/** Explicit allow-list: no PRNG, habit internals, private provenance or session data cross the wire. */
export function projectWorld(world: World, viewport?: Viewport, context: WorldContext = {}): WorldView {
  const projected = projectTerrain(world, viewport, context), v = projected.viewport;
  return {
    version: PROTOCOL_VERSION, sequence: world.tick, tick: world.tick, day: Math.floor(world.tick / TICKS_PER_DAY) + 1,
    phase: phaseAt(world.tick), weather: world.weather, width: v.width, height: v.height,
    originX: v.x, originY: v.y, infinite: true, activeChunks: Object.keys(world.chunks).length, discoveredChunks: world.discoveredChunks, settlementCount: world.settlementCount,
    tiles: projected.tiles.map(t => ({ x: t.x, y: t.y, terrain: t.terrain, biome: t.biome, elevation: t.elevation, wood: t.wood, stone: t.stone, moisture: Math.round(t.moisture * 1000) / 1000, food: Math.round(t.food * 1000) / 1000, vegetation: Math.round(t.vegetation * 1000) / 1000 })),
    people: world.people.map(p => ({ id: p.id, name: p.name, role: p.role, x: p.x, y: p.y, color: p.color, action: p.action, reason: p.reason, energy: p.energy, hunger: p.hunger, fatigue: p.fatigue, need: p.need, recentMemory: p.recentMemory, traits: { ...p.traits }, skills: { ...p.skills }, materials: { ...p.materials }, specialty: specialty(p), controlMode: p.controlMode })),
    places: projected.places.map(p => ({ id: p.id, name: p.name, x: p.x, y: p.y, description: p.description, gatherings: p.gatherings })), events: world.events.map(e => ({ id: e.id, tick: e.tick, kind: e.kind, actors: [...e.actors], ...(e.x === undefined ? {} : { x: e.x }), ...(e.y === undefined ? {} : { y: e.y }), text: e.text, cause: e.cause, source: e.source })),
    memories: world.memories.map(m => ({ id: m.id, title: m.title, text: m.text, source: m.source, placeId: m.placeId })),
  };
}

/** Reject corruption on load rather than silently replacing a world. */
function assertCommon(value: unknown, legacy = false): asserts value is World {
  const fail = (): never => { throw new Error('Estado del mundo inválido o versión de reglas incompatible.'); };
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const num = (v: unknown, max = 1): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
  const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => num(v, max) && Number.isInteger(v);
  const str = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length <= max;
  const list = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max;
  if (!object(value) || value.version !== (legacy ? 1 : RULES_VERSION) || value.width !== 40 || value.height !== 28 || !integer(value.seed, 0xffffffff) || !integer(value.rng, 0xffffffff) || !integer(value.tick) || !integer(value.eventCounter) || typeof value.learningEnabled !== 'boolean' || !['rain', 'clear'].includes(String(value.weather)) || !Number.isInteger(value.lastGestureTick) || (value.lastGestureTick as number) < -COOLDOWN || (value.lastGestureTick as number) > (value.tick as number)) fail();
  const world = value as unknown as World;
  const coord = (n: unknown, max: number) => legacy ? integer(n, max) : validCoordinate(n);
  const land = (p: Point) => legacy ? world.tiles.some(t => t.x === p.x && t.y === p.y && t.terrain !== 'water') : walkable(world, p);
  if (!list(world.tiles, legacy ? 1120 : 65536) || (legacy && world.tiles.length !== 1120) || !list(world.people, 16) || world.people.length !== 16 || !list(world.places, legacy ? 3 : 2048) || (legacy && world.places.length !== 3) || !list(world.events, MAX_EVENTS) || !list(world.memories, 10) || !list(world.invitations, 8) || !list(world.reminders, 8)) fail();
  for (let index = 0; index < world.tiles.length; index++) {
    const tile = world.tiles[index];
    if (!object(tile) || (legacy ? tile.x !== index % 40 || tile.y !== Math.floor(index / 40) : !validCoordinate(tile.x) || !validCoordinate(tile.y)) || !['water', 'soil', 'meadow', 'shelter'].includes(String(tile.terrain)) || !num(tile.moisture) || !num(tile.vegetation) || !num(tile.food)) fail();
  }
  const ids = new Set<string>();
  for (const person of world.people) {
    if (!object(person) || !str(person.id, 50) || ids.has(person.id) || !str(person.name, 80) || !['S', 'I', 'neighbor'].includes(String(person.role)) || !coord(person.x, 39) || !coord(person.y, 27) || !land(person) || !object(person.target) || !coord(person.target.x, 39) || !coord(person.target.y, 27) || (legacy && !land(person.target)) || !str(person.color, 30) || !['explore', 'eat', 'rest', 'approach', 'accompany', 'retreat', 'share', 'gather', 'farm', 'build'].includes(String(person.action)) || !str(person.reason) || !str(person.need, 100) || !(person.recentMemory === null || str(person.recentMemory)) || !integer(person.decisionAt) || !Number.isInteger(person.lastMeeting) || !Number.isInteger(person.lastShared) || !list(person.experiences, MAX_EXPERIENCES) || !list(person.habits, MAX_HABITS)) fail();
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
  for (const event of world.events) if (!object(event) || !str(event.id, 100) || !integer(event.tick, world.tick) || !['ecology', 'meeting', 'care', 'learning', 'memory', 'gesture', 'pause', 'discovery', 'settlement'].includes(String(event.kind)) || !list(event.actors, 16) || !event.actors.every(a => str(a, 100)) || !str(event.text) || !str(event.cause) || !['simulation', 'sample', 'approved'].includes(String(event.source)) || (event.x !== undefined && !coord(event.x, 39)) || (event.y !== undefined && !coord(event.y, 27))) fail();
  for (const memory of world.memories) if (!object(memory) || !str(memory.id, 100) || !str(memory.title, 200) || !str(memory.text) || !['sample', 'approved'].includes(String(memory.source)) || !world.places.some(p => p.id === memory.placeId) || !['partner-tired', 'shelter-tired', 'food-hungry', 'rain-shelter', 'irrelevant'].includes(String(memory.context)) || !['explore', 'eat', 'rest', 'approach', 'accompany', 'retreat', 'share', 'gather', 'farm', 'build'].includes(String(memory.action)) || !num(memory.weight) || !list(memory.roles, 2) || !memory.roles.every(role => role === 'S' || role === 'I')) fail();
  for (const invitation of world.invitations) if (!object(invitation) || !str(invitation.id, 100) || !coord(invitation.x, 39) || !coord(invitation.y, 27) || !integer(invitation.until)) fail();
  for (const reminder of world.reminders) if (!object(reminder) || !str(reminder.memoryId, 100) || !integer(reminder.until) || !world.memories.some(m => m.id === reminder.memoryId)) fail();
}

export function assertWorld(value: unknown): asserts value is World {
  assertCommon(value);
  const w = value;
  const fail = (): never => { throw new Error('Estado procedural inválido.'); };
  if (!w.chunks || Array.isArray(w.chunks) || Object.keys(w.chunks).length > 256 || !Array.isArray(w.retiredChunks) || !Number.isSafeInteger(w.discoveredChunks) || w.discoveredChunks < 0 || !Number.isSafeInteger(w.settlementCount) || w.settlementCount < 0 || [w.adaptationEnabled, w.noveltyEnabled, w.shelterBenefitEnabled].some(v => typeof v !== 'boolean')) fail();
  const keys = new Set<string>();
  for (const tile of w.tiles) {
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
  for (const p of w.people) {
    if (!['ready','hungry','tired'].includes(p.intentContext)) fail();
    if (!p.traits || !['curiosity','sociability','industriousness','care','resilience'].every(k => typeof p.traits[k as keyof typeof p.traits] === 'number') || !numericMap(p.traits, 0, 1, 5) || !numericMap(p.skills, 0, 1, 10) || !numericMap(p.values, -0.3, 0.3, 30) || !numericMap(p.activity, 0, 1_000_000, 10) || !p.materials || !Number.isFinite(p.materials.wood) || p.materials.wood < 0 || p.materials.wood > 12 || !Number.isFinite(p.materials.stone) || p.materials.stone < 0 || p.materials.stone > 8 || !Array.isArray(p.visited) || p.visited.length > 192 || !p.visited.every(k => typeof k === 'string' && /^-?\d+,-?\d+$/.test(k)) || !Number.isFinite(p.heading) || !Number.isSafeInteger(p.work) || p.work < 0 || p.work > 90 || !Number.isSafeInteger(p.lastOutcome) || p.lastOutcome < 0 || p.lastOutcome > w.tick || !['auto','directed'].includes(p.controlMode)) fail();
    if (p.command !== null && (!p.command || !['move','explore','gather','farm','build','rest'].includes(p.command.order) || !validCoordinate(p.command.x) || !validCoordinate(p.command.y))) fail();
    if ((p.command === null) !== (p.controlMode === 'auto')) fail();
  }
}

/** Pure, validated migration; SQLite commits the converted snapshot separately and atomically. */
export function migrateWorld(value: unknown): World {
  if ((value as { version?: unknown } | null)?.version === RULES_VERSION) { assertWorld(value); return value; }
  assertCommon(value, true);
  const old = structuredClone(value);
  const world = old as World;
  world.version = RULES_VERSION; world.chunks = {}; world.retiredChunks = [];
  world.discoveredChunks = 6; world.settlementCount = 0;
  world.adaptationEnabled = true; world.noveltyEnabled = true; world.shelterBenefitEnabled = true;
  const originalTiles = new Map(world.tiles.map(t => [`${t.x},${t.y}`, t]));
  world.tiles = [];
  for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 3; cx++) {
    const chunk = generateChunk(world.seed, cx, cy);
    const { tiles, ...meta } = chunk;
    meta.discovered = true; meta.lastTick = world.tick;
    meta.places = world.places.filter(p => chunkKey(p.x, p.y) === meta.key);
    world.chunks[meta.key] = meta;
    world.tiles.push(...tiles.map(t => ({ ...t, ...originalTiles.get(`${t.x},${t.y}`) })));
  }
  world.people.forEach((p, index) => {
    p.traits = { ...seededTraits(world.seed, index), curiosity: p.curiosity, sociability: p.sociability, care: p.generosity };
    p.skills = {}; p.values = {}; p.activity = {}; p.materials = { wood: 0, stone: 0 }; p.visited = [];
    p.heading = index * 2.399963229728653; p.command = null; p.work = 0; p.lastOutcome = world.tick; p.intentContext = p.hunger > 0.5 ? 'hungry' : p.fatigue > 0.5 ? 'tired' : 'ready'; p.controlMode = 'auto';
  });
  assertWorld(world);
  return world;
}
