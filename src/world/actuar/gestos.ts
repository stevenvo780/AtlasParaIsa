import { type World, RADIUS, COOLDOWN, type Person, TICKS_PER_DAY } from '../mundo/tipos.js';
import { distance, clamp } from '../mundo/geometria.js';
import { addEvent, walkable, remember } from '../mundo/crear.js';
import type { Gesture, GestureResult } from '../../shared/types.js';
import { validCoordinate, tileAt } from '../spatial.js';
import { cancelTechnologyProject } from '../technology.js';
import type { DivineWhisperRequest, DivineWhisper, DivineWhisperIntent } from '../../shared/worldmap.js';
import { enqueueWhisper, type WhisperFadeReason, stepWhispers, stepWhispersCon, WHISPER_CHECK_TICKS, RADIO_AUDIBLE,
  whisperView, type OyentesSusurro, type WhisperPersonLike, type WhisperRecord } from '../whispers.js';
import { escuchaDe } from '../genetics.js';
import { deserialize, serialize } from 'node:v8';
import { ley } from '../params.js';
import { ctxSi, type Aplicado, type CtxF0, type CtxLey } from '../motor/acceso.js';
import { CAMPOS_CUERPO, CUERPO_ANCHO, Clase, REF_NULA, TipoIntento, slotDe, type Intento, type Ref } from '../motor/contratos.js';
import { cercanos, cuantosCerca } from '../motor/vecinos.js';


export function applyGesture(world: World, gesture: Gesture, order: number): GestureResult {
  const result = (accepted: boolean, message: string): GestureResult => ({ id: gesture.id, accepted, tick: world.tick, order, message });
  if (!validCoordinate(gesture.x) || !validCoordinate(gesture.y)) return result(false, 'Elige un destino dentro del rango de coordenadas.');
  const c = ley(world, 'intentos') ? ctxSi(world) : undefined;
  if (gesture.kind === 'command') {
    const person = world.people.find(p => p.id === gesture.agentId);
    const valida = !!gesture.order && ['move', 'explore', 'gather', 'farm', 'build', 'rest', 'hunt', 'drink', 'cooperate', 'invent', 'repair', 'research', 'craft', 'forage', 'auto'].includes(gesture.order);
    if (!person && c && valida && gesture.agentId) {
      // Con dueños, la persona puede estar en otro: la orden viaja como gesto a su dueño, que la aplica en su F1.
      const ref = c.ref(c.uidDe(gesture.agentId));
      if (ref === REF_NULA) return result(false, 'Habitante u orden desconocida.');
      const slot = slotDe(ref);
      if (Math.hypot((c.frente.x[slot] ?? 0) - gesture.x, (c.frente.y[slot] ?? 0) - gesture.y) > 4096) return result(false, 'El destino de una tarea debe quedar a menos de 4096 celdas.');
      enviarGesto(c, ref, { act: 'orden', order: gesture.order!, x: gesture.x, y: gesture.y });
      return result(true, gesture.order === 'auto' ? 'Retoma sus decisiones.' : 'Tarea recibida. Se desplazará por tierra y cuidará sus necesidades.');
    }
    if (!person || !valida) return result(false, 'Habitante u orden desconocida.');
    if (distance(person, gesture) > 4096) return result(false, 'El destino de una tarea debe quedar a menos de 4096 celdas.');
    aplicarOrden(world, person, gesture.order!, gesture.x, gesture.y);
    return result(true, gesture.order === 'auto' ? 'Retoma sus decisiones.' : 'Tarea recibida. Se desplazará por tierra y cuidará sus necesidades.');
  }
  const alguienVe = c ? cuantosCerca(c, gesture.x, gesture.y, RADIUS, Clase.Persona) > 0 : world.people.some(p => distance(p, gesture) <= RADIUS);
  if (!walkable(world, gesture) || !alguienVe) return result(false, 'Elige tierra a la vista de algún habitante.');
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
    despertarCerca(world, c, gesture);
  } else if (memory) {
    world.reminders = world.reminders.filter(r => r.memoryId !== memory.id);
    world.reminders.push({ memoryId: memory.id, until: world.tick + 600 });
    world.reminders = world.reminders.slice(-8);
    despertarCerca(world, c, gesture);
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
  const c = req.personId && !listener && ley(world, 'intentos') ? ctxSi(world) : undefined;
  const vivoEnOtro = !!c && c.ref(c.uidDe(req.personId!)) !== REF_NULA;
  if (req.personId && !listener && !vivoEnOtro) throw new Error('Ese habitante ya no vive en el mundo.');
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
  if (!hayPendientes(whispers)) return;
  const outcome = stepWhispers(whispers, world.people, world.tick, world.seed, (x, y) => {
    const tile = tileAt(world, { x, y });
    return tile ? tile.terrain === 'water' : undefined;
  });
  for (const { whisper, person } of outcome.heard) {
    const listener = person as Person;
    const event = addEvent(world, sucesoOido(whisper, listener, world.tick));
    remember(listener, world, RECUERDO_OIDO, event.id);
  }
  for (const { whisper, person } of outcome.fulfilled) {
    const listener = person as Person;
    const event = addEvent(world, sucesoCumplido(whisper, listener, world.tick));
    remember(listener, world, RECUERDO_CUMPLIDO, event.id);
  }
  for (const { whisper, reason } of outcome.faded) addEvent(world, sucesoDesvanecido(whisper, reason));
}

function hayPendientes(whispers: readonly WhisperRecord[]): boolean {
  for (const w of whispers) if (w.status === 'latent' || w.status === 'heard') return true;
  return false;
}

const RECUERDO_OIDO = 'Un susurro le llamó a otro lugar.';
const RECUERDO_CUMPLIDO = 'Siguió un susurro y llegó a otro lugar.';
type SucesoGesto = Parameters<typeof addEvent>[1];
type Oyente = Pick<WhisperPersonLike, 'id' | 'name' | 'x' | 'y'> & { escucha?: number; genome?: WhisperPersonLike['genome'] };
const escuchaDeOyente = (p: Oyente): number => p.escucha ?? (p.genome ? escuchaDe(p.genome) : 0);

function sucesoOido(whisper: DivineWhisper, listener: Oyente, tick: number): SucesoGesto {
  const note = whisper.note ? ` «${whisper.note}»` : '';
  return { kind: 'gesture', actors: [listener.id], x: listener.x, y: listener.y, source: 'simulation',
    text: `${listener.name} oyó un susurro${note}: una llamada a ${WHISPER_INTENT_LABEL[whisper.intent]} (${whisper.x}, ${whisper.y}).`,
    cause: `Mensaje divino ${whisper.id}, dejado en el paso ${whisper.createdTick} y oído ${tick - whisper.createdTick} pasos después, según su escucha heredada (${escuchaDeOyente(listener).toFixed(2)}) y lo tranquilo que estaba su cuerpo. Irá en cuanto su cuerpo no tenga una necesidad aguda, y puede olvidarlo por el camino.` };
}
function sucesoCumplido(whisper: DivineWhisper, listener: Oyente, tick: number): SucesoGesto {
  return { kind: 'gesture', actors: [listener.id], x: listener.x, y: listener.y, source: 'simulation',
    text: `${listener.name} llegó al lugar del susurro (${whisper.x}, ${whisper.y}) por su propio camino.`,
    cause: `Mensaje divino ${whisper.id} cumplido en el paso ${tick}, ${tick - (whisper.heardTick ?? whisper.createdTick)} pasos después de oírlo; caminó pagando sus costes corporales.` };
}
function sucesoDesvanecido(whisper: DivineWhisper, reason: WhisperFadeReason): SucesoGesto {
  return { kind: 'gesture', actors: whisper.heardById ? [whisper.heardById] : [], x: whisper.x, y: whisper.y, source: 'simulation',
    text: reason === 'forgotten' ? `${whisper.heardByName} olvidó el susurro antes de llegar (${whisper.x}, ${whisper.y}).`
      : whisper.heardByName ? `El susurro que oyó ${whisper.heardByName} se desvaneció sin cumplirse.` : 'Un susurro se desvaneció sin que nadie lo oyera.',
    cause: `Mensaje divino ${whisper.id}: ${WHISPER_FADE_CAUSE[reason]}.` };
}

// ── V23: gestos y susurros con dueños (ley de actuar) ────────────────────────────────────────────────────

/** Columna del frente con lo que un susurro necesita de cada persona y no está en las fijas. */
export const COLUMNA_OIDO = 'act.oido';
export const CAMPOS_OIDO = { escucha: 0, fatiga: 1, explora: 2, objetivoX: 3, objetivoY: 4 } as const;
export const OIDO_ANCHO = 5;

/** Lo que viaja en un intento `Gesto` de la ley de actuar (bytes v8). */
export type GestoAct =
  | { act: 'orden'; order: string; x: number; y: number }
  | { act: 'despertar' }
  | { act: 'susurro'; que: 'oido' | 'cumplido' | 'resuelto'; registro: DivineWhisper; tick: number };

const duenoDe = (c: CtxLey, r: Ref): number => c.frente.dueno[slotDe(r)] ?? 0;

export function enviarGesto(c: CtxLey, a: Ref, g: GestoAct): void {
  c.buzon.enviar(duenoDe(c, a), { tipo: TipoIntento.Gesto, de: REF_NULA, a, celda: -1, lote: REF_NULA, nonce: c.id('nonce'),
    materia: null, dato: null, bytes: new Uint8Array(serialize(g)) });
}

/** Orden explícita sobre una persona propia (la aplica quien la tiene, venga del anfitrión o de otro dueño). */
export function aplicarOrden(world: World, person: Person, order: string, x: number, y: number,
  emitir: (e: SucesoGesto) => unknown = e => addEvent(world, e)): void {
  if (['research', 'craft'].includes(order) && person.technology.project && person.technology.project.kind !== order) cancelTechnologyProject(world, person);
  person.technology.waterPreparation = undefined;
  person.command = order === 'auto' ? null : { order: order as NonNullable<Person['command']>['order'], x, y };
  person.controlMode = person.command ? 'directed' : 'auto'; person.work = 0; person.decisionAt = world.tick;
  emitir({ kind: 'gesture', actors: [person.id], x: person.x, y: person.y, source: 'simulation', text: order === 'auto' ? `${person.name} vuelve a elegir sus tareas.` : `${person.name} recibió una tarea: ${order}.`, cause: 'Orden explícita; conserva desplazamiento físico, costes y necesidades.' });
}

/** Quien está a la vista de una invitación o un recuerdo vuelve a elegir pronto: lo propio directo, lo ajeno por gesto. */
function despertarCerca(world: World, c: CtxLey | undefined, p: { x: number; y: number }): void {
  if (!c) {
    for (const person of world.people) if (distance(person, p) <= RADIUS) person.decisionAt = Math.min(person.decisionAt, world.tick + 1);
    return;
  }
  cercanos(c, p.x, p.y, RADIUS, Clase.Persona, slot => {
    const persona = c.personas.get(slot);
    if (persona && c.frente.dueno[slot] === c.hilo) persona.decisionAt = Math.min(persona.decisionAt, world.tick + 1);
    else enviarGesto(c, c.ref(c.frente.uid[slot] ?? 0), { act: 'despertar' });
  });
}

const SIN_ALELOS = { alleles: [] as readonly number[] };

/** Una persona del frente como oyente de un susurro (lo de hace un tick: ver a los demás un tick atrás es ley). */
function oyenteDeFrente(c: CtxLey, slot: number, id: string, nombres: ReadonlyMap<string, string>): WhisperPersonLike & { escucha: number } {
  const fr = c.frente, oido = fr.col(COLUMNA_OIDO), b = slot * OIDO_ANCHO, cu = slot * CUERPO_ANCHO;
  return {
    id, name: nombres.get(id) ?? id, x: fr.x[slot] ?? 0, y: fr.y[slot] ?? 0,
    action: (oido[b + CAMPOS_OIDO.explora] ?? 0) > 0 ? 'explore' : undefined,
    target: { x: oido[b + CAMPOS_OIDO.objetivoX] ?? 0, y: oido[b + CAMPOS_OIDO.objetivoY] ?? 0 },
    hunger: fr.cuerpo[cu + CAMPOS_CUERPO.hambre] ?? 0, thirst: fr.cuerpo[cu + CAMPOS_CUERPO.sed] ?? 0,
    fatigue: oido[b + CAMPOS_OIDO.fatiga] ?? 0, genome: SIN_ALELOS, escucha: oido[b + CAMPOS_OIDO.escucha] ?? 0,
  };
}

/** Oyentes por el frente: por id con el directorio, y los regionales con el índice espacial del frente (`cercanos`). */
function oyentesDeFrente(c: CtxLey): OyentesSusurro {
  const nombres = new Map<string, string>();
  for (const p of c.mundo.people) nombres.set(p.id, p.name);
  return {
    porId(id) {
      const ref = c.ref(c.uidDe(id));
      return ref === REF_NULA ? undefined : oyenteDeFrente(c, slotDe(ref), id, nombres);
    },
    cerca(x, y, f) {
      cercanos(c, x, y, RADIO_AUDIBLE, Clase.Persona, slot => {
        const id = c.idDe(c.frente.uid[slot] ?? 0);
        if (id) f(oyenteDeFrente(c, slot, id, nombres));
      });
    },
  };
}

/**
 * F0 del coordinador (que guarda la cola de mensajes): oír, cumplir y olvidar sobre el frente. Lo que le pasa a quien oye
 * (su recuerdo, la copia del mensaje que su decisión lee) se lo aplica su dueño al recibir el gesto.
 */
export function susurrosPorFrente(c: CtxF0): void {
  const world = c.mundo, whispers = world.whispers;
  if (!whispers?.length || world.tick % WHISPER_CHECK_TICKS !== 0 || !hayPendientes(whispers)) return;
  const outcome = stepWhispersCon(whispers, oyentesDeFrente(c), world.tick, world.seed, (x, y) => {
    const celda = c.terreno.celda(x, y);
    if (celda < 0) return undefined;
    const tile = tileAt(world, { x, y });
    return tile ? tile.terrain === 'water' : undefined;
  });
  const avisar = (w: WhisperRecord, quien: string | undefined, que: 'oido' | 'cumplido' | 'resuelto') => {
    if (!quien) return;
    const ref = c.ref(c.uidDe(quien));
    if (ref !== REF_NULA) enviarGesto(c, ref, { act: 'susurro', que, registro: whisperView(w), tick: world.tick });
  };
  for (const { whisper } of outcome.heard) avisar(whisper, whisper.heardById, 'oido');
  for (const { whisper } of outcome.fulfilled) avisar(whisper, whisper.heardById, 'cumplido');
  for (const { whisper, reason } of outcome.faded) {
    c.suceso(sucesoDesvanecido(whisper, reason));
    avisar(whisper, whisper.heardById, 'resuelto');
  }
}

/** Aplicador de `Gesto` de la ley de actuar en el dueño de la persona destino. Los gestos que no son suyos pasan. */
export function aplicarGestoAct(c: CtxLey, i: Intento): Aplicado {
  if (!i.bytes) return 'paso';
  let g: GestoAct;
  try { g = deserialize(i.bytes) as GestoAct; } catch { return 'paso'; }
  if (!g || typeof g !== 'object' || !('act' in g)) return 'paso';
  const persona = c.personas.get(slotDe(i.a));
  if (!persona || persona.uid === undefined || c.ref(persona.uid) !== i.a) return 'rechazo';
  const world = c.mundo;
  if (g.act === 'despertar') { persona.decisionAt = Math.min(persona.decisionAt, world.tick + 1); return 'hecho'; }
  if (g.act === 'orden') { aplicarOrden(world, persona, g.order, g.x, g.y, e => c.suceso(e)); return 'hecho'; }
  // Susurro: la copia local del mensaje es la que lee `choose` (activeWhisperForPerson); con un solo dueño es el mismo.
  const lista = (world.whispers ??= []);
  const local = lista.find(w => w.id === g.registro.id);
  if (local) { if (local !== g.registro) Object.assign(local, g.registro); }
  else if (g.que === 'oido') lista.push({ ...g.registro });
  if (g.que === 'oido') {
    const id = c.suceso(sucesoOido(g.registro, { ...persona, escucha: escuchaDe(persona.genome) }, g.tick));
    remember(persona, world, RECUERDO_OIDO, id);
  } else if (g.que === 'cumplido') {
    const id = c.suceso(sucesoCumplido(g.registro, persona, g.tick));
    remember(persona, world, RECUERDO_CUMPLIDO, id);
  }
  return 'hecho';
}
