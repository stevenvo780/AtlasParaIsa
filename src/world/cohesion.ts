/**
 * Cohesión que emerge (carril n, `v23.cohesion`): memoria del agua, hogar y buscar compañía.
 *
 * Lo medido que resuelve (archivo/v23-orquesta/fin/0h.diagnosticos-resumen.txt): las bandas se extinguen porque la
 * segunda generación se dispersa buscando agua a ciegas y explorando por curiosidad, y madura a 25–39 celdas del adulto
 * no pariente más cercano. Aquí nada se prohíbe: cada pieza es un candidato más de `choose`, con su apetito (un rasgo
 * heredable) y su coste (la necesidad que el cuerpo acumula por el camino), que compite con comer, beber y descansar.
 *
 *  - Agua: quien no ve agua vuelve a la última que vio cuando la sed con que llegaría supera la sed que ya le haría
 *    buscarla (`umbralMemoriaAgua`); el mecanismo es el de `agua.memoria`, que la ley deja siempre encendido.
 *  - Hogar: donde nació o donde descansó bien por primera vez. Tira más cuanto más lejos está (`tiron`) y además inclina
 *    cada tramo de exploración hacia él (`anclaExploracion`): el resultado es un territorio de querencia, no una valla.
 *    El muy curioso apenas lo siente y es quien coloniza.
 *  - Compañía: quien lleva tiempo sin nadie a la vista se acerca a la persona más cercana cuya presencia percibe de
 *    lejos; la cría no se aleja de sus cuidadores, y el tirón se apaga según madura.
 *
 * Todo ocurre al decidir (cada ~30 ticks por persona): la ley no tiene ganchos por tick. A los demás se les lee por el
 * frente público si el mundo ya pasó por el motor; si no (pruebas unitarias sin motor), por la rejilla heredada.
 */
import { TAU_VINCULO } from '../shared/naturaleza.js';
import type { Candidate } from './decision/sentidos.js';
import { demographicTraits } from './demography.js';
import { HAMBRE_POR_PASO, SED_POR_PASO } from './ecologia-constantes.js';
import { ctxSi, type CtxLey, type Ley } from './motor/acceso.js';
import { Clase, REF_NULA, slotDe } from './motor/contratos.js';
import { masCercano } from './motor/vecinos.js';
import { RADIUS, TICKS_PER_DAY, type Person, type World } from './mundo/tipos.js';
import { paramsOf } from './params.js';
import { vecinos } from './rejilla.js';

// ── Constantes físicas de la ley (el integrador las reúne en shared/naturaleza.ts) ───────────────────────

/** Celdas: distancia al hogar a la que su tirón iguala al apetito de explorar de una persona media y a la que el sesgo
 * de un tramo de exploración iguala a la inercia del rumbo. Es el lado de una página (16×16). */
export const RADIO_QUERENCIA = 16;
/** Celdas: hasta dónde se percibe la presencia de otra persona (humo, voces, sendas), sin detalle. Tres páginas. */
export const ALCANCE_SENAL = 48;
/** Ticks que cuesta andar una celda (la cuenta que ya hacía la memoria del agua). */
export const PASOS_POR_CELDA = 6;
/** Sed, en [0, 1], a partir de la cual quien no ve agua sale a buscarla (el umbral que `choose` ya usaba). */
export const SED_QUE_BUSCA = 0.6;
/** Puntos de decisión: apetito de explorar de quien no tiene el rasgo (el del candidato `explore` de hoy). La cohesión
 * se mide en la misma escala que la curiosidad a la que se opone. */
export const APETITO_BASE = 0.33;
/** Puntos de decisión que añade un rasgo heredable entero (el `curiosity · 0,18` del candidato `explore`). */
export const APETITO_POR_RASGO = 0.18;
/** Puntos de decisión por celda con que un tramo de exploración prefiere seguir su rumbo (`explorationTarget`). */
export const PESO_RUMBO = 0.2;

export const leyCohesion: Ley = { id: 'n-cohesion', interruptor: 'cohesion' };

// ── Piezas puras ─────────────────────────────────────────────────────────────────────────────────────────

/** Tirón de un lugar a `d` celdas: 0 en él, 1 a `escala` celdas y nunca más de 2 (lejos no tira infinitamente). */
export const tiron = (d: number, escala: number): number => d > 0 ? 2 * d / (d + escala) : 0;

/** Umbral de sed prevista al llegar con que se emprende la vuelta al agua recordada. `memoria` es `agua.memoria`
 * (1 = la ley heredada apagada): con la cohesión nunca queda por encima de la sed que ya hace buscar. */
export const umbralMemoriaAgua = (memoria: number): number => Math.min(memoria, SED_QUE_BUSCA);

/** Soledad en [0, 1) tras `ticks` sin nadie a la vista: crece con el mismo tiempo característico con que decae un
 * vínculo (τ), así que quien ya no tiene vínculos vivos es quien más compañía busca. */
export const soledad = (ticks: number): number => ticks > 0 ? 1 - Math.exp(-ticks / (TAU_VINCULO * TICKS_PER_DAY)) : 0;

/** Madurez de una cría en [0, 1]: la que mantiene la natalidad (`crianza.madurez`, masa sobre masa adulta) o, sin ella,
 * la edad sobre la edad de madurez. */
export function madurezDe(world: World, person: Person): number {
  if (person.crianza) return Math.min(1, Math.max(0, person.crianza.madurez));
  const madurez = demographicTraits(person.genome, paramsOf(world).cuerpo).maturityAge;
  return Math.min(1, person.demography.age / madurez);
}

/** Quién cuida de alguien que aún no maduró: sus cuidadores declarados o, sin natalidad nueva, sus progenitores. */
export const cuidadoresDe = (person: Person): readonly string[] => person.crianza?.cuidadores ?? person.genome.parents;

/** Necesidad (hambre más sed, en [0, 1] cada una) que el cuerpo acumula andando `d` celdas: el coste de un candidato
 * lejano en las mismas unidades en que puntúan comer y beber. */
export function costeCamino(world: World, person: Person, d: number): number {
  const fisiologia = demographicTraits(person.genome, paramsOf(world).cuerpo);
  return d * PASOS_POR_CELDA * (HAMBRE_POR_PASO * fisiologia.foodDemand + SED_POR_PASO * fisiologia.waterDemand);
}

// ── Lectura de los demás ─────────────────────────────────────────────────────────────────────────────────

interface Punto { x: number; y: number }
const distancia = (a: Punto, b: Punto): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Fila propia en el frente, o REF_NULA si aún no está en la tabla. */
export const slotPropio = (c: CtxLey, person: Person): number => {
  if (person.uid === undefined) return REF_NULA;
  const ref = c.ref(person.uid);
  return ref === REF_NULA ? REF_NULA : slotDe(ref);
};

/** Dónde está alguien nombrado por su id de texto (un tick atrás si hay frente). `undefined` si no vive o no se sabe. */
export function dondeEsta(world: World, id: string): Punto | undefined {
  const c = ctxSi(world);
  if (c) {
    const uid = c.uidDe(id);
    if (!(uid > 0)) return undefined;
    const ref = c.ref(uid);
    if (ref === REF_NULA) return undefined;
    const s = slotDe(ref);
    return { x: c.frente.x[s]!, y: c.frente.y[s]! };
  }
  for (const other of world.people) if (other.id === id) return { x: other.x, y: other.y };
  return undefined;
}

/** La persona más cercana cuya presencia se percibe a ≤ `radio` celdas. */
function personaMasCercana(world: World, person: Person, radio: number): Punto | undefined {
  const c = ctxSi(world);
  if (c) {
    const ref = masCercano(c, person.x, person.y, radio, Clase.Persona, slotPropio(c, person), () => true, () => c.azar());
    if (ref === REF_NULA) return undefined;
    const s = slotDe(ref);
    return { x: c.frente.x[s]!, y: c.frente.y[s]! };
  }
  let mejor: Person | undefined, dMejor = Infinity;
  for (const other of vecinos(world, person, radio + 1, o => o !== person && o.id !== person.id, 'cohesion')) {
    const d = distancia(person, other);
    if (d <= radio && (d < dMejor || (d === dMejor && mejor !== undefined && other.id < mejor.id))) { mejor = other; dMejor = d; }
  }
  return mejor ? { x: mejor.x, y: mejor.y } : undefined;
}

/** El cuidador vivo más cercano de una cría, con su distancia. */
function cuidadorCercano(world: World, person: Person): { punto: Punto; d: number } | undefined {
  let mejor: { punto: Punto; d: number } | undefined;
  for (const id of cuidadoresDe(person)) {
    const punto = dondeEsta(world, id);
    if (!punto) continue;
    const d = distancia(person, punto);
    if (!mejor || d < mejor.d) mejor = { punto, d };
  }
  return mejor;
}

// ── Memoria propia de la ley ─────────────────────────────────────────────────────────────────────────────

/** Tick de la última decisión en que cada cual tuvo a alguien a la vista. Es un reloj de la decisión, no estado del
 * mundo: tras una carga arranca en `lastSocial` (el último trato que el mundo sí guarda). */
const ultimaCompania = new WeakMap<Person, number>();

/** Qué tan bien se está aquí al terminar un descanso, en [0, 1]: lo que le falta a la peor necesidad para saturar. */
const bienestar = (person: Person): number => 1 - Math.max(person.hunger, person.thirst, person.fatigue);

/** Lo que `choose` ya sabe y la cohesión necesita. */
export interface EntornoCohesion {
  /** Personas a la vista (a ≤ RADIUS) en esta decisión. */
  genteCerca: number;
}

/**
 * Candidatos de cohesión de una decisión. Anota además lo que la persona recuerda: que tuvo compañía y, si no tiene
 * hogar y acaba de descansar bien, que este sitio lo es (la sociedad heredada lo sustituye por un lugar mejor cuando
 * lo conoce y lo olvida si al volver ya no vale).
 */
export function candidatosCohesion(world: World, person: Person, entorno: EntornoCohesion): Candidate[] {
  const candidatos: Candidate[] = [];
  if (entorno.genteCerca > 0) ultimaCompania.set(person, world.tick);
  if (!person.home && person.action === 'rest') {
    const calidad = bienestar(person);
    if (calidad > 0) person.home = { x: person.x, y: person.y, quality: calidad, observedAt: world.tick };
  }
  const madurez = madurezDe(world, person);
  if (madurez < 1) {
    const cuidador = cuidadorCercano(world, person);
    if (cuidador && cuidador.d >= 1) candidatos.push({
      action: 'approach', target: cuidador.punto,
      score: (1 - madurez) * (APETITO_BASE + APETITO_POR_RASGO) * tiron(cuidador.d, RADIUS) - costeCamino(world, person, cuidador.d),
      reason: 'Aún no ha madurado y se ha alejado de quien lo cuida; vuelve a su lado.',
    });
  }
  const hogar = person.home;
  if (hogar) {
    const lejos = distancia(person, hogar);
    if (lejos >= 2) candidatos.push({
      action: 'approach', target: { x: hogar.x, y: hogar.y },
      score: (APETITO_BASE + APETITO_POR_RASGO * (1 - person.curiosity)) * tiron(lejos, RADIO_QUERENCIA) - costeCamino(world, person, lejos),
      reason: 'Se ha alejado de su hogar y la querencia tira de vuelta; compara ese tirón con sus necesidades.',
    });
  }
  if (entorno.genteCerca === 0) {
    const sola = soledad(world.tick - (ultimaCompania.get(person) ?? person.lastSocial));
    if (sola > 0) {
      const alguien = personaMasCercana(world, person, ALCANCE_SENAL);
      if (alguien) {
        const d = distancia(person, alguien);
        candidatos.push({
          action: 'approach', target: alguien,
          score: 2 * (APETITO_BASE + APETITO_POR_RASGO * person.sociability) * sola - costeCamino(world, person, d),
          reason: 'Lleva tiempo sin nadie a la vista y percibe gente a lo lejos; se acerca a buscar compañía.',
        });
      }
    }
  }
  return candidatos;
}

/** Ancla de un tramo de exploración: el punto hacia el que se inclina y cuántos puntos vale cada celda que acerca. */
export interface Ancla { x: number; y: number; peso: number }

/** Hacia dónde se inclina la exploración: la cría hacia su cuidador más cercano; los demás hacia su hogar, tanto más
 * cuanto más lejos están y cuanto menos curiosos son. */
export function anclaExploracion(world: World, person: Person): Ancla | undefined {
  const madurez = madurezDe(world, person);
  if (madurez < 1) {
    const cuidador = cuidadorCercano(world, person);
    if (cuidador) return { x: cuidador.punto.x, y: cuidador.punto.y, peso: PESO_RUMBO * (1 - madurez) * cuidador.d / RADIUS };
  }
  const hogar = person.home;
  if (!hogar) return undefined;
  return { x: hogar.x, y: hogar.y, peso: PESO_RUMBO * (1 - person.curiosity) * distancia(person, hogar) / RADIO_QUERENCIA };
}
