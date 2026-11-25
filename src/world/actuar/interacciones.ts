import { type World, type Person, MAX_HABITS, RADIUS, TICKS_PER_DAY } from '../mundo/tipos.js';
import { distance, clamp } from '../mundo/geometria.js';
import { outcome } from '../decision/personas.js';
import { addEvent, remember } from '../mundo/crear.js';
import { placeById } from '../decision/sentidos.js';
import { ensurePersonPolicy } from '../decision/politica-persona.js';
import { primeroCerca } from '../indice-puntos.js';
import { vecinos } from '../rejilla.js';
import { availableToShare } from '../family.js';
import { bond } from '../society.js';
import { chunkKey } from '../terrain.js';
import { ley, paramsOf } from '../params.js';
import { updatePolicyPlasticity } from '../politica.js';
import { pedidoComida } from '../materia/cuerpo.js';
import { Rol } from '../materia/tipos.js';
import { ctxMateriaDe, refDeOrganismo, type Aplicado, type CtxLey, type CtxLeyMateria, type Ley } from '../motor/acceso.js';
import {
  CAMPOS_CUERPO, CUERPO_ANCHO, Clase, REF_NULA, TipoIntento, genDe, refDe, slotDe,
  type Intento, type Ref, type Slot,
} from '../motor/contratos.js';
import { cercanos } from '../motor/vecinos.js';

const PORCION_COMPARTIDA_KG = 0.025;
const PORCION_AL_DIGESTIVO = new Float64Array([Rol.Digestivo, 0]);
const COLUMNA_COMPANIA = 'interacciones.compania';

export const leyInteracciones: Ley = {
  id: 'm5', interruptor: 'intentos', sustituye: ['encuentros'],
  columnas: [[COLUMNA_COMPANIA, 'u8', 1]],
  F4: encuentrosPorFrente,
  F6: publicarCompania,
  aplicar: { Vincular: aplicarVinculo },
};

export function share(world: World, donor: Person): void {
  if (ley(world, 'intentos')) {
    compartirPorIntento(ctxMateriaDe(world), donor);
    return;
  }
  if (donor.inventory < 0.025 || donor.hunger >= 0.5 || world.tick - donor.lastShared < 30) return;
  const place = primeroCerca(world.places, donor, 4, p => distance(donor, p) <= 3);
  const recipient = vecinos(world, donor, 3, p => p.id !== donor.id && p.hunger > 0.27 && distance(p, donor) <= 2, 'share:recipient').sort((a, b) => b.hunger - a.hunger)[0];
  if (!place || !recipient || !availableToShare(world, donor, recipient)) return;
  donor.inventory = clamp(donor.inventory - 0.025, 0.25);
  donor.energy = clamp(donor.energy - 0.001);
  recipient.hunger = clamp(recipient.hunger - 0.12);
  recipient.energy = clamp(recipient.energy + 0.03);
  donor.lastShared = world.tick;
  bond(world, donor, recipient, 0.1);
  outcome(world, donor, 'share', 0.16);
  place.gatherings = Math.min(1_000_000, place.gatherings + 1);
  const archivedPlace = world.chunks[chunkKey(place.x, place.y)]?.places.find(p => p.id === place.id);
  if (archivedPlace) archivedPlace.gatherings = place.gatherings;
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
  for (const observer of vecinos(world, donor, 4, observer => !(observer.id === donor.id || distance(observer, donor) > 3), 'share:observers')) {
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


export function encounters(world: World): void {
  if (ley(world, 'intentos')) return;
  const s = world.people.find(p => p.role === 'S');
  const i = world.people.find(p => p.role === 'I');
  if (!s || !i) return;
  const params = paramsOf(world), { vinculoEncuentro } = params.social;
  if (vinculoEncuentro > 0) {
    const separation = distance(s, i);
    if (separation <= RADIUS) {
      s.partnerMemory = { x: i.x, y: i.y, tick: world.tick };
      i.partnerMemory = { x: s.x, y: s.y, tick: world.tick };
    } else if (world.tick % 120 === 0) {
      if (separation <= params.poblacion.radioCortejo) {
        const mid = { x: Math.round((s.x + i.x) / 2), y: Math.round((s.y + i.y) / 2), tick: world.tick };
        s.partnerMemory = { ...mid }; i.partnerMemory = { ...mid };
      } else {
        // Si se alejaron más allá del radio social, ambos convergen al claro compartido para reencontrarse.
        const origin = placeById(world, 'claro') ?? { x: 0, y: 0 };
        s.partnerMemory = { x: origin.x, y: origin.y, tick: world.tick };
        i.partnerMemory = { x: origin.x, y: origin.y, tick: world.tick };
      }
    }
  }
  if (distance(s, i) > 1.5 || s.action === 'retreat' || i.action === 'retreat' || s.socialLoad > 0.8 || i.socialLoad > 0.8) return;
  if (!(s.action === 'approach' || s.action === 'accompany' || s.action === 'rest' || s.action === 'share') || !(i.action === 'approach' || i.action === 'accompany' || i.action === 'rest' || i.action === 'share')) return;
  for (const person of [s, i]) {
    // Shared pauses reduce exertion; they do not create food or erase hunger.
    person.fatigue = clamp(person.fatigue - 0.0006);
    person.energy = clamp(person.energy + 0.00025 * clamp((1 - person.hunger) / 0.5));
    person.socialLoad = clamp(person.socialLoad + 0.002);
    person.closeness = clamp(person.closeness - 0.0018);
  }
  if (world.tick - s.lastMeeting < 240) return;
  const elapsed = s.lastMeeting > 0 ? world.tick - s.lastMeeting : 0;
  s.lastMeeting = world.tick; i.lastMeeting = world.tick;
  if (vinculoEncuentro > 0) {
    s.partnerMemory = { x: s.x, y: s.y, tick: world.tick };
    i.partnerMemory = { x: i.x, y: i.y, tick: world.tick };
    bond(world, s, i, 0.08);
    if (world.adaptationEnabled && params.conducta.politicaPeso > 0 && !params.conducta.aprendizajeCausal) {
      for (const person of [s, i]) {
        const { plasticity } = ensurePersonPolicy(world, person);
        updatePolicyPlasticity(plasticity, 'cooperate', 0.18, person.genome.learningRate * 0.35);
      }
    }
  }
  const place = primeroCerca(world.places, s, 4, p => distance(s, p) <= 3);
  const reunion = vinculoEncuentro > 0 && elapsed >= TICKS_PER_DAY;
  const event = addEvent(world, {
    kind: 'meeting', actors: [s.id, i.id], source: 'simulation', x: s.x, y: s.y,
    text: reunion
      ? `Tras ${(elapsed / TICKS_PER_DAY).toFixed(1)} días en caminos separados, S e I volvieron a encontrarse${place ? ` en ${place.name}` : ''} y compartieron una pausa.`
      : 'S e I compartieron una pausa. Después podrán volver a sus propios caminos.',
    cause: 'Cercanía percibida, disposición de ambos y una acción de compañía; la pausa reduce cansancio, sin producir alimento.',
  });
  for (const person of [s, i]) remember(person, world, reunion ? 'Un reencuentro tras caminos distintos ayudó a recuperar el ritmo.' : 'Una pausa acompañada ayudó a recuperar el ritmo.', event.id, place?.id);
}

function aportarVinculo(persona: Person, id: string, aumento: number): void {
  persona.bonds[id] = clamp((persona.bonds[id] ?? 0.2) + aumento);
}

function enviarVinculo(c: CtxLey, de: Ref, s: Slot, aumento: number): void {
  const f = c.frente;
  c.buzon.enviar(f.dueno[s], {
    tipo: TipoIntento.Vincular, de, a: refDe(s, f.gen[s]), nonce: c.id('nonce'),
    celda: REF_NULA, lote: REF_NULA, materia: null, dato: new Float64Array([aumento]), bytes: null,
  });
}

function aplicarVinculo(c: CtxLey, i: Intento): Aplicado {
  const f = c.frente, de = slotDe(i.de);
  const receptor = c.personas.get(slotDe(i.a));
  const aumento = i.dato?.[0];
  if (!receptor || i.de === REF_NULA || de >= f.alta || f.gen[de] !== genDe(i.de) ||
      aumento === undefined || !Number.isFinite(aumento)) return 'rechazo';
  const id = c.idDe(f.uid[de]);
  if (!id) return 'rechazo';
  aportarVinculo(receptor, id, aumento);
  return 'hecho';
}

function compartirPorIntento(c: CtxLeyMateria, donante: Person): void {
  if (!donante.cuerpo || donante.hunger >= 0.5 || c.tick - donante.lastShared < 30) return;
  const de = refDeOrganismo(c, donante);
  if (de === REF_NULA) return;
  const lugar = primeroCerca(c.mundo.places, donante, 4, p => distance(donante, p) <= 3);
  if (!lugar) return;

  const f = c.frente, propio = slotDe(de);
  let s = REF_NULA, hambre = 0.27, empates = 0;
  cercanos(c, donante.x, donante.y, 2, Clase.Persona, candidato => {
    if (candidato === propio || f.dueno[candidato] < 0) return;
    const h = f.cuerpo[candidato * CUERPO_ANCHO + CAMPOS_CUERPO.hambre];
    if (h > hambre) {
      s = candidato;
      hambre = h;
      empates = 1;
    } else if (s !== REF_NULA && h === hambre && c.azar() * ++empates < 1) {
      s = candidato;
    }
  });
  if (s === REF_NULA) return;
  const id = c.idDe(f.uid[s]);
  if (!id) return;
  const celda = c.terreno.celda(f.x[s], f.y[s]);
  if (celda < 0) return;
  const pedido = pedidoComida(c, donante.cuerpo, PORCION_COMPARTIDA_KG);
  const asegurar = (lote: number) => c.materia.propio(lote) ? c.materia.garantizar(lote, pedido, c.libro) : null;
  let materia: Float64Array | null = null;
  for (const lote of donante.carga ?? []) {
    materia = asegurar(lote);
    if (materia?.length) break;
  }
  if (!materia?.length) materia = asegurar(donante.cuerpo.reserva);
  if (!materia?.length) return;

  c.buzon.enviar(f.dueno[s], {
    tipo: TipoIntento.Dar, de, a: refDe(s, f.gen[s]), celda, lote: REF_NULA, nonce: c.id('nonce'),
    materia, dato: PORCION_AL_DIGESTIVO, bytes: null,
  });
  donante.lastShared = c.tick;
  outcome(c.mundo, donante, 'share', 0.16);
  const evento = c.suceso({
    kind: 'care', actors: [donante.id, id], x: donante.x, y: donante.y, source: 'simulation',
    text: `${donante.name} ofreció alimento en ${lugar.name}.`,
    cause: 'Iniciativa propia, hambre local y una porción debitada del lote que llevaba.',
  });
  remember(donante, c.mundo, `Ofreció alimento en ${lugar.name}.`, evento, lugar.id);
}

function enCompania(p: Person): boolean {
  return p.socialLoad <= 0.8 && (p.action === 'approach' || p.action === 'accompany' || p.action === 'rest' || p.action === 'share');
}

function publicarCompania(c: CtxLey): void {
  const columna = c.escritura.u8(COLUMNA_COMPANIA);
  for (const [s, persona] of c.personas) {
    if (persona.role === 'S' || persona.role === 'I') columna[s] = enCompania(persona) ? 1 : 0;
  }
}

function encuentrosPorFrente(c: CtxLey): void {
  const f = c.frente, compania = f.col(COLUMNA_COMPANIA);
  const { params, mundo, tick } = c, { vinculoEncuentro } = params.social;
  for (const [s, p] of c.personas) {
    if (p.role !== 'S' && p.role !== 'I') continue;
    const otroId = p.role === 'S' ? 'i' : 's';
    const otro = c.ref(c.uidDe(otroId));
    if (otro === REF_NULA || f.vivo[s] !== 1) continue;
    const a = slotDe(otro);
    if (a >= f.alta || f.vivo[a] !== 1 || f.gen[a] !== genDe(otro) || f.dueno[a] < 0) continue;

    const separacion = Math.hypot(f.x[a] - f.x[s], f.y[a] - f.y[s]);
    if (vinculoEncuentro > 0) {
      if (separacion <= RADIUS) {
        p.partnerMemory = { x: f.x[a], y: f.y[a], tick };
      } else if (tick % 120 === 0) {
        const punto = separacion <= params.poblacion.radioCortejo
          ? { x: Math.round((f.x[a] + f.x[s]) / 2), y: Math.round((f.y[a] + f.y[s]) / 2) }
          : c.globales.lugares.get('claro') ?? { x: 0, y: 0 };
        p.partnerMemory = { x: punto.x, y: punto.y, tick };
      }
    }
    if (separacion > 1.5 || !compania[s] || !compania[a]) continue;
    p.fatigue = clamp(p.fatigue - 0.0006);
    p.socialLoad = clamp(p.socialLoad + 0.002);
    p.closeness = clamp(p.closeness - 0.0018);
    if (tick - p.lastMeeting < 240) continue;
    const desde = p.lastMeeting > 0 ? tick - p.lastMeeting : 0;
    p.lastMeeting = tick;
    if (vinculoEncuentro > 0) {
      p.partnerMemory = { x: p.x, y: p.y, tick };
      if (p.role === 'S') {
        aportarVinculo(p, otroId, 0.08);
        enviarVinculo(c, refDe(s, f.gen[s]), a, 0.08);
      }
      if (mundo.adaptationEnabled && params.conducta.politicaPeso > 0 && !params.conducta.aprendizajeCausal) {
        const { plasticity } = ensurePersonPolicy(mundo, p);
        updatePolicyPlasticity(plasticity, 'cooperate', 0.18, p.genome.learningRate * 0.35);
      }
    }
    if (p.role === 'S') {
      const lugar = primeroCerca(mundo.places, p, 4, l => distance(p, l) <= 3);
      const reunion = vinculoEncuentro > 0 && desde >= TICKS_PER_DAY;
      const evento = c.suceso({
        kind: 'meeting', actors: [p.id, otroId], source: 'simulation', x: p.x, y: p.y,
        text: reunion
          ? `Tras ${(desde / TICKS_PER_DAY).toFixed(1)} días en caminos separados, S e I volvieron a encontrarse${lugar ? ` en ${lugar.name}` : ''} y compartieron una pausa.`
          : 'S e I compartieron una pausa. Después podrán volver a sus propios caminos.',
        cause: 'Cercanía percibida, disposición de ambos y una acción de compañía; la pausa reduce cansancio, sin producir alimento.',
      });
      remember(p, mundo, reunion ? 'Un reencuentro tras caminos distintos ayudó a recuperar el ritmo.' : 'Una pausa acompañada ayudó a recuperar el ritmo.', evento, lugar?.id);
    }
  }
}
