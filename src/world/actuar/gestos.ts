import { type World, RADIUS, COOLDOWN, type Person, TICKS_PER_DAY } from '../mundo/tipos.js';
import { distance, clamp } from '../mundo/geometria.js';
import { addEvent, walkable, remember } from '../mundo/crear.js';
import type { Gesture, GestureResult } from '../../shared/types.js';
import { validCoordinate, tileAt } from '../spatial.js';
import { cancelTechnologyProject } from '../technology.js';
import type { DivineWhisperRequest, DivineWhisper, DivineWhisperIntent } from '../../shared/worldmap.js';
import { enqueueWhisper, type WhisperFadeReason, stepWhispers, WHISPER_CHECK_TICKS } from '../whispers.js';
import { escuchaDe } from '../genetics.js';


export function applyGesture(world: World, gesture: Gesture, order: number): GestureResult {
  const result = (accepted: boolean, message: string): GestureResult => ({ id: gesture.id, accepted, tick: world.tick, order, message });
  if (!validCoordinate(gesture.x) || !validCoordinate(gesture.y)) return result(false, 'Elige un destino dentro del rango de coordenadas.');
  if (gesture.kind === 'command') {
    const person = world.people.find(p => p.id === gesture.agentId);
    if (!person || !gesture.order || !['move', 'explore', 'gather', 'farm', 'build', 'rest', 'hunt', 'drink', 'cooperate', 'invent', 'repair', 'research', 'craft', 'forage', 'auto'].includes(gesture.order)) return result(false, 'Habitante u orden desconocida.');
    if (distance(person, gesture) > 4096) return result(false, 'El destino de una tarea debe quedar a menos de 4096 celdas.');
    if(['research','craft'].includes(gesture.order)&&person.technology.project&&person.technology.project.kind!==gesture.order) cancelTechnologyProject(world,person);
    delete person.technology.waterPreparation;
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


/** Lo que sólo el mundo sabe de un mensaje, sin tocarlo: el anfitrión responde 400 en el acto, antes de esperar
 * al paso que lo aplicará (y que vuelve a comprobarlo, porque el mundo pudo cambiar entre medias). */
export function validateWhisper(world: World, req: DivineWhisperRequest): Person | undefined {
  if (!validCoordinate(req.x) || !validCoordinate(req.y)) throw new Error('Coordenadas del mensaje divino fuera del mundo.');
  const listener = req.personId ? world.people.find(p => p.id === req.personId) : undefined;
  if (req.personId && !listener) throw new Error('Ese habitante ya no vive en el mundo.');
  if (tileAt(world, req)?.terrain === 'water') throw new Error('El destino del mensaje divino está en el agua.');
  return listener;
}

/**
 * V24 — Mensajes Divinos. Un mensaje se deja en el mundo entre pasos (nunca dentro de uno) y queda
 * `latent`: nadie lo oye en el acto. Lo valida el anfitrión (`parseWhisperRequest`); aquí se comprueba lo
 * que sólo el mundo sabe: que el destino sea una coordenada del mundo, que no sea agua conocida y que el
 * destinatario siga vivo. No toca el RNG del mundo.
 */
export function submitWhisper(world: World, req: DivineWhisperRequest): DivineWhisper {
  const listener = validateWhisper(world, req);
  world.whispers ??= [];
  return enqueueWhisper(world.whispers, req, world.tick, Math.floor(world.tick / TICKS_PER_DAY) + 1, listener?.name);
}

export const WHISPER_INTENT_LABEL: Record<DivineWhisperIntent, string> = {
  travel: 'viajar hasta allí', explore: 'explorar esa región', gather: 'recolectar materiales allí',
  build: 'construir allí', craft: 'trabajar un oficio allí', tend: 'cuidar a los animales de allí',
};

const WHISPER_FADE_CAUSE: Record<WhisperFadeReason, string> = {
  gone: 'quien debía oírlo ya no vive', unreachable: 'el destino no se alcanza por tierra',
  deadline: 'pasaron tres días desde que lo oyó', unheard: 'pasaron tres días sin que nadie lo oyera',
  forgotten: 'lo olvidó por el camino',
};

/** Sólo se llama con `world.whispers` no vacío (el paso de un mundo sin mensajes no llega aquí). */
export function advanceWhispers(world: World): void {
  if (world.tick % WHISPER_CHECK_TICKS !== 0) return;
  const whispers = world.whispers!;
  let pending = false;
  for (const w of whispers) if (w.status === 'latent' || w.status === 'heard') { pending = true; break; }
  if (!pending) return;
  const outcome = stepWhispers(whispers, world.people, world.tick, world.seed, (x, y) => {
    const tile = tileAt(world, { x, y });
    return tile ? tile.terrain === 'water' : undefined;
  });
  for (const { whisper, person } of outcome.heard) {
    const listener = person as Person;
    const note = whisper.note ? ` «${whisper.note}»` : '';
    const event = addEvent(world, { kind: 'gesture', actors: [listener.id], x: listener.x, y: listener.y, source: 'simulation',
      text: `${listener.name} oyó un susurro${note}: una llamada a ${WHISPER_INTENT_LABEL[whisper.intent]} (${whisper.x}, ${whisper.y}).`,
      cause: `Mensaje divino ${whisper.id}, dejado en el paso ${whisper.createdTick} y oído ${world.tick - whisper.createdTick} pasos después, según su escucha heredada (${escuchaDe(listener.genome).toFixed(2)}) y lo tranquilo que estaba su cuerpo. Irá en cuanto su cuerpo no tenga una necesidad aguda, y puede olvidarlo por el camino.` });
    remember(listener, world, 'Un susurro le llamó a otro lugar.', event.id);
  }
  for (const { whisper, person } of outcome.fulfilled) {
    const listener = person as Person;
    const event = addEvent(world, { kind: 'gesture', actors: [listener.id], x: listener.x, y: listener.y, source: 'simulation',
      text: `${listener.name} llegó al lugar del susurro (${whisper.x}, ${whisper.y}) por su propio camino.`,
      cause: `Mensaje divino ${whisper.id} cumplido en el paso ${world.tick}, ${world.tick - (whisper.heardTick ?? whisper.createdTick)} pasos después de oírlo; caminó pagando sus costes corporales.` });
    remember(listener, world, 'Siguió un susurro y llegó a otro lugar.', event.id);
  }
  for (const { whisper, reason } of outcome.faded) {
    addEvent(world, { kind: 'gesture', actors: whisper.heardById ? [whisper.heardById] : [], x: whisper.x, y: whisper.y, source: 'simulation',
      text: reason === 'forgotten' ? `${whisper.heardByName} olvidó el susurro antes de llegar (${whisper.x}, ${whisper.y}).`
        : whisper.heardByName ? `El susurro que oyó ${whisper.heardByName} se desvaneció sin cumplirse.` : 'Un susurro se desvaneció sin que nadie lo oyera.',
      cause: `Mensaje divino ${whisper.id}: ${WHISPER_FADE_CAUSE[reason]}.` });
  }
}
