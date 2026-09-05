import { PROTOCOL_VERSION, type Action, type ChronicleEvent, type Gesture, type GestureResult, type MemoryView, type PersonView, type PlaceView, type Terrain, type Tile, type WorldView } from '../shared/types.js';

export const RULES_VERSION = 1;
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
}

function random(world: Pick<World, 'rng'>): number {
  world.rng = (Math.imul(world.rng, 1664525) + 1013904223) >>> 0;
  return world.rng / 4294967296;
}

export function phaseAt(tick: number): WorldView['phase'] {
  const t = tick % TICKS_PER_DAY;
  return t < 300 ? 'dawn' : t < 1500 ? 'day' : t < 1800 ? 'dusk' : 'night';
}

function tileAt(world: World, p: Point): Tile | undefined {
  return p.x >= 0 && p.y >= 0 && p.x < world.width && p.y < world.height
    ? world.tiles[p.y * world.width + p.x] : undefined;
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

/** A reproducible, finite region. The identities and memories here are explicitly fictional. */
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
  };
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const river = Math.abs(x - (4 + Math.sin(y / 4) * 1.7)) < 1.1;
      const pond = ((x - 32) / 3.5) ** 2 + ((y - 21) / 2.8) ** 2 < 1;
      let terrain: Terrain = river || pond ? 'water' : random(world) < 0.14 ? 'soil' : 'meadow';
      if (world.places.some(p => Math.abs(p.x - x) <= 1 && Math.abs(p.y - y) <= 1)) terrain = 'shelter';
      const moisture = terrain === 'water' ? 1 : clamp(0.32 + random(world) * 0.38 + (x < 10 ? 0.15 : 0));
      const vegetation = terrain === 'water' ? 0 : terrain === 'soil' ? 0.08 : 0.35 + random(world) * 0.55;
      world.tiles.push({ x, y, terrain, moisture, vegetation, food: terrain === 'water' ? 0 : vegetation * (0.35 + random(world) * 0.3) });
    }
  }
  const names = ['S', 'I', 'Luma', 'Nilo', 'Duna', 'Bruma', 'Olmo', 'Vera', 'Tilo', 'Cora', 'Lino', 'Nara', 'Río', 'Alba', 'Mora', 'Sol'];
  const colors = ['#f4ce7a', '#e7a8b9', '#9dc8ae', '#9ebacc', '#d8ba91', '#b8a6cc'];
  for (let n = 0; n < names.length; n++) {
    const place = world.places[Math.floor(n / 6) % world.places.length]!;
    const x = place.x + n % 3 - 1;
    const y = place.y + Math.floor(n % 6 / 3) - 1;
    world.people.push({
      id: n === 0 ? 's' : n === 1 ? 'i' : `neighbor-${n - 1}`, name: names[n]!,
      role: n === 0 ? 'S' : n === 1 ? 'I' : 'neighbor', x, y, color: colors[n % colors.length]!,
      action: 'explore', reason: 'Observa las posibilidades cercanas.', energy: 0.78 + random(world) * 0.18,
      hunger: n === 3 || n === 5 ? 0.72 : 0.2 + random(world) * 0.28, fatigue: n === 0 ? 0.52 : 0.1 + random(world) * 0.2,
      need: 'Recorrer', recentMemory: null, inventory: 0.14,
      curiosity: n === 0 ? 0.38 : n === 1 ? 0.68 : 0.25 + random(world) * 0.6,
      sociability: n === 0 ? 0.7 : n === 1 ? 0.5 : 0.3 + random(world) * 0.4,
      generosity: n === 2 ? 0.98 : 0.08 + random(world) * 0.15,
      closeness: n < 2 ? 0.55 : 0.2, socialLoad: 0, target: { x, y }, decisionAt: 0,
      lastMeeting: -300, lastShared: -60, experiences: [], habits: [],
    });
  }
  addEvent(world, { kind: 'memory', actors: [], source: 'sample', text: 'Este mundo comienza con S, I y una vecindad ficticia. Los cinco recuerdos son ejemplos, pendientes de la historia de Steven e Isa.', cause: 'Contenido sintético identificado; no se importaron conversaciones ni biografía.' });
  return world;
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
  candidates.sort((a, b) => b.score - a.score);
  const selected = candidates[0]!;
  if (selected.action === 'explore') {
    const options = nearbyTiles.filter(tile => distance(person, tile) >= 2 && distance(person, tile) <= 4);
    // Exploration has a deterministic local stream: choosing another action must not alter future rain.
    let personSeed = world.seed ^ world.tick;
    for (const character of person.id) personSeed = Math.imul(personSeed, 31) ^ character.charCodeAt(0);
    const target = options[Math.floor(random({ rng: personSeed >>> 0 }) * options.length)];
    selected.target = target ?? person;
  }
  person.action = selected.action;
  person.target = { x: selected.target.x, y: selected.target.y };
  person.reason = selected.memory ? `${selected.reason} Influye «${selected.memory.title}», ${selected.memory.source === 'sample' ? 'material de prueba' : 'recuerdo aprobado'}.` : selected.reason;
  person.decisionAt = world.tick + 30;
  if (selected.memory && person.recentMemory !== selected.memory.text) {
    const event = addEvent(world, { kind: 'memory', actors: [person.id], text: `${person.name} eligió ${actionLabel(selected.action)} al recordar «${selected.memory.title}».`, cause: `Contexto ${selected.memory.context}; recuerdo ${selected.memory.id}; aumenta la preferencia por ${selected.action}.`, x: person.x, y: person.y, source: selected.memory.source });
    remember(person, world, selected.memory.text, event.id, selected.memory.placeId);
  }
}

function actionLabel(action: Action): string {
  return ({ explore: 'explorar', eat: 'buscar alimento', rest: 'descansar', approach: 'acercarse', accompany: 'acompañar', retreat: 'tomar espacio', share: 'compartir alimento' })[action];
}

/** Breadth-first movement takes one adjacent land cell. It never crosses water or teleports. */
function move(world: World, person: Person): void {
  if (distance(person, person.target) < 0.5 || !walkable(world, person.target)) return;
  const start = person.y * world.width + person.x;
  const goal = person.target.y * world.width + person.target.x;
  const previous = new Int32Array(world.tiles.length).fill(-1);
  const queue = new Int32Array(world.tiles.length);
  queue[0] = start; previous[start] = start;
  let head = 0, tail = 1;
  while (head < tail && previous[goal] === -1) {
    const current = queue[head++]!;
    const x = current % world.width, y = Math.floor(current / world.width);
    for (const next of [{ x: x + 1, y }, { x, y: y + 1 }, { x: x - 1, y }, { x, y: y - 1 }]) {
      const index = next.y * world.width + next.x;
      if (!walkable(world, next) || previous[index] !== -1) continue;
      previous[index] = current; queue[tail++] = index;
    }
  }
  if (previous[goal] === -1) { person.decisionAt = world.tick + 1; return; }
  let next = goal;
  while (previous[next] !== start) next = previous[next]!;
  person.x = next % world.width; person.y = Math.floor(next / world.width);
  person.energy = clamp(person.energy - 0.0008);
  person.fatigue = clamp(person.fatigue + 0.0007);
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
    if (person.hunger < 0.12) person.decisionAt = world.tick + 1;
  }
  if (person.action === 'rest' && distance(person, person.target) < 0.5) {
    const quality = current.terrain === 'shelter' ? 1 : world.weather === 'rain' ? 0.2 : 0.55;
    person.fatigue = clamp(person.fatigue - 0.0018 * quality);
    // Energy is readiness for activity, not a thermodynamic measurement. Food availability limits recovery.
    person.energy = clamp(person.energy + 0.0011 * quality * clamp((1 - person.hunger) / 0.5));
  }
  if (person.action === 'share') share(world, person);
  person.need = person.hunger > 0.6 ? 'Alimento' : person.fatigue > 0.55 || person.energy < 0.35 ? 'Descanso' : person.socialLoad > 0.7 ? 'Espacio propio' : person.closeness > 0.5 && person.role !== 'neighbor' ? 'Compañía' : 'Recorrer';
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
  if (!Number.isInteger(gesture.x) || !Number.isInteger(gesture.y) || !walkable(world, gesture)) return result(false, 'Elige una celda de tierra dentro del mapa.');
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
export function stepWorld(world: World, inputs: Gesture[] = []): GestureResult[] {
  world.tick++;
  const results = inputs.map((gesture, order) => applyGesture(world, gesture, order));
  world.invitations = world.invitations.filter(invitation => invitation.until > world.tick);
  world.reminders = world.reminders.filter(reminder => reminder.until > world.tick);
  ecology(world);
  for (const person of world.people) bodyAndAction(world, person);
  encounters(world);
  return results;
}

/** Explicit allow-list: no PRNG, habit internals, private provenance or session data cross the wire. */
export function projectWorld(world: World): WorldView {
  return {
    version: PROTOCOL_VERSION, sequence: world.tick, tick: world.tick, day: Math.floor(world.tick / TICKS_PER_DAY) + 1,
    phase: phaseAt(world.tick), weather: world.weather, width: world.width, height: world.height,
    tiles: world.tiles.map(t => ({ ...t })),
    people: world.people.map(p => ({ id: p.id, name: p.name, role: p.role, x: p.x, y: p.y, color: p.color, action: p.action, reason: p.reason, energy: p.energy, hunger: p.hunger, fatigue: p.fatigue, need: p.need, recentMemory: p.recentMemory })),
    places: world.places.map(p => ({ ...p })), events: world.events.map(e => ({ ...e, actors: [...e.actors] })),
    memories: world.memories.map(m => ({ id: m.id, title: m.title, text: m.text, source: m.source, placeId: m.placeId })),
  };
}

/** Reject corruption on load rather than silently replacing a world. */
export function assertWorld(value: unknown): asserts value is World {
  const fail = (): never => { throw new Error('Estado del mundo inválido o versión de reglas incompatible.'); };
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const num = (v: unknown, max = 1): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
  const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => num(v, max) && Number.isInteger(v);
  const str = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length <= max;
  const list = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max;
  if (!object(value) || value.version !== RULES_VERSION || value.width !== 40 || value.height !== 28 || !integer(value.seed, 0xffffffff) || !integer(value.rng, 0xffffffff) || !integer(value.tick) || !integer(value.eventCounter) || typeof value.learningEnabled !== 'boolean' || !['rain', 'clear'].includes(String(value.weather)) || !Number.isInteger(value.lastGestureTick) || (value.lastGestureTick as number) < -COOLDOWN || (value.lastGestureTick as number) > (value.tick as number)) fail();
  const world = value as unknown as World;
  if (!list(world.tiles, 1120) || world.tiles.length !== 1120 || !list(world.people, 16) || world.people.length !== 16 || !list(world.places, 3) || world.places.length !== 3 || !list(world.events, MAX_EVENTS) || !list(world.memories, 10) || !list(world.invitations, 8) || !list(world.reminders, 8)) fail();
  for (let index = 0; index < world.tiles.length; index++) {
    const tile = world.tiles[index];
    if (!object(tile) || tile.x !== index % 40 || tile.y !== Math.floor(index / 40) || !['water', 'soil', 'meadow', 'shelter'].includes(String(tile.terrain)) || !num(tile.moisture) || !num(tile.vegetation) || !num(tile.food)) fail();
  }
  const ids = new Set<string>();
  for (const person of world.people) {
    if (!object(person) || !str(person.id, 50) || ids.has(person.id) || !str(person.name, 80) || !['S', 'I', 'neighbor'].includes(String(person.role)) || !integer(person.x, 39) || !integer(person.y, 27) || !walkable(world, person) || !object(person.target) || !integer(person.target.x, 39) || !integer(person.target.y, 27) || !walkable(world, person.target) || !str(person.color, 30) || !['explore', 'eat', 'rest', 'approach', 'accompany', 'retreat', 'share'].includes(String(person.action)) || !str(person.reason) || !str(person.need, 100) || !(person.recentMemory === null || str(person.recentMemory)) || !integer(person.decisionAt) || !Number.isInteger(person.lastMeeting) || !Number.isInteger(person.lastShared) || !list(person.experiences, MAX_EXPERIENCES) || !list(person.habits, MAX_HABITS)) fail();
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
  for (const place of world.places) if (!object(place) || !str(place.id, 100) || !str(place.name, 200) || !integer(place.x, 39) || !integer(place.y, 27) || !str(place.description) || !integer(place.gatherings, 1_000_000)) fail();
  for (const event of world.events) if (!object(event) || !str(event.id, 100) || !integer(event.tick, world.tick) || !['ecology', 'meeting', 'care', 'learning', 'memory', 'gesture', 'pause'].includes(String(event.kind)) || !list(event.actors, 16) || !event.actors.every(a => str(a, 100)) || !str(event.text) || !str(event.cause) || !['simulation', 'sample', 'approved'].includes(String(event.source)) || (event.x !== undefined && !integer(event.x, 39)) || (event.y !== undefined && !integer(event.y, 27))) fail();
  for (const memory of world.memories) if (!object(memory) || !str(memory.id, 100) || !str(memory.title, 200) || !str(memory.text) || !['sample', 'approved'].includes(String(memory.source)) || !world.places.some(p => p.id === memory.placeId) || !['partner-tired', 'shelter-tired', 'food-hungry', 'rain-shelter', 'irrelevant'].includes(String(memory.context)) || !['explore', 'eat', 'rest', 'approach', 'accompany', 'retreat', 'share'].includes(String(memory.action)) || !num(memory.weight) || !list(memory.roles, 2) || !memory.roles.every(role => role === 'S' || role === 'I')) fail();
  for (const invitation of world.invitations) if (!object(invitation) || !str(invitation.id, 100) || !integer(invitation.x, 39) || !integer(invitation.y, 27) || !integer(invitation.until)) fail();
  for (const reminder of world.reminders) if (!object(reminder) || !str(reminder.memoryId, 100) || !integer(reminder.until) || !world.memories.some(m => m.id === reminder.memoryId)) fail();
}
