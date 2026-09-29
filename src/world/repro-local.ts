import type { Person, World } from './index.js';
import type { PlaceView } from '../shared/types.js';
import { depositoRecargable } from './agua.js';
import { demographicTraits } from './demography.js';
import { localRandom } from './genetics.js';
import { primeroCerca, filtrarCerca } from './indice-puntos.js';
import { BROKEN_CONDITION, blueprintAffordances } from './inventions.js';
import { paramsOf } from './params.js';
import { vecinos } from './rejilla.js';
import { tileAt } from './spatial.js';

/**
 * REPRO-LOCAL v2 (D2', ley candidata 2026-09-28, `poblacion.reproLocal`).
 * Regla corregida de `critica-d2-20260928.md` §"Regla corregida":
 *
 * - Sin casamentero global: con la ley activa cada pareja elegible cria en su lugar, en
 *   orden rotado por `localRandom(seed, tick)` (sin ranking mundial por afinidad), y
 *   `nacimientosPorComprobacion` queda como anticorrupcion (`TOPE_NACIMIENTOS_VENTANA`).
 * - Freno por pareja en su lugar L (disco R = 12): T_p = `fertilityCooldown`_p * m_L, con
 *   m_L = min(1 + (phiref/phi_L)^2, 8) si C_L > 0 (1 si C_L = 0: NEUTRAL sin informacion),
 *   y ademas m_L *= (1 + 4*s_L), anticipacion corporal (fraccion de adultos del disco con
 *   sed > 0,45). El tope 8 va sobre el termino de llenado (lectura literal de la regla).
 * - S_L = agua bebida visible (teselas activas + cisternas funcionales, cada cisterna una
 *   vez); C_L = 1 por tesela-deposito recargable (MISMO predicado que el motor) + capacidad
 *   de las cisternas funcionales con agua > 0,1 (riesgo 2 de la critica, declarado: una
 *   cisterna con <= 0,1 de agua no cuenta ni en S ni en C). Solo teselas activas.
 * - El freno vive DENTRO de `reproductiveReadiness` (family.ts), cacheado por lugar y
 *   ventana, para que la conducta (reunion, provision, cortejo) lo vea.
 * - Sin azar nuevo (la rotacion deriva de seed+tick) y sin estados de generacion. Los frenos
 *   de la ventana vigente viven en `world.reproLocal` (PERSISTIDO: clonar, guardar y restaurar
 *   a mitad de ventana reutilizan los mismos valores; sin estado oculto de modulo). Con la ley
 *   apagada el campo no existe (identidad bit a bit). Si cambian `intervalo`/`phiref` a mitad de
 *   ventana, la ronda se recalcula; otros params a mitad de ventana se ven en la siguiente.
 * - Instrumento S2/S3 (solo lectura, `InstrumentoReproLocal`): cada llamada a
 *   `multiplicadorLugar` (hit o miss) cuenta una evaluacion con su m en un sidecar por mundo
 *   (heredado en `cloneWorld`, auto-podado, jamas en el mundo: no toca digestos); cada
 *   nacimiento por la via local anota el phi de su lugar. La ronda guarda {m, phi} para que
 *   la foto de fertiles reuse el phi que vio la ley.
 */

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** Radio del disco del lugar (vision 7 + radioLugar 4 + 1). */
export const REPRO_LOCAL_RADIO = 12;
/** Tope del termino de llenado (el corporal multiplica despues). */
export const REPRO_LOCAL_TOPE_M = 8;
/** Exponente del freno por llenado. */
export const REPRO_LOCAL_EXPONENTE = 2;
/** Peso de la anticipacion corporal. */
export const REPRO_LOCAL_PESO_CORPORAL = 4;
/** Sed que marca a un adulto como sediento para s_L. */
export const REPRO_LOCAL_UMBRAL_SED = 0.45;
/** Agua minima para que una cisterna cuente como deposito visible. */
export const REPRO_LOCAL_UMBRAL_CISTERNA = 0.1;
/** Anticorrupcion con la ley activa (el cupo deja de regular). */
export const TOPE_NACIMIENTOS_VENTANA = 10000;

export interface LlenadoLugar { s: number; c: number; phi: number | null; adultos: number; sedientos: number; }

/**
 * Agua y gente visibles en el disco del lugar. Pura y sin cache: la cache esta en
 * `multiplicadorLugar` (una vez por lugar y ventana). Solo teselas activas (`tileAt`
 * devuelve undefined fuera de ellas y no cuentan ni en S ni en C).
 */
export function llenadoLugar(world: World, place: Pick<PlaceView, 'x' | 'y'>): LlenadoLugar {
  const params = paramsOf(world);
  let s = 0, c = 0;
  for (let dy = -REPRO_LOCAL_RADIO; dy <= REPRO_LOCAL_RADIO; dy++) {
    for (let dx = -REPRO_LOCAL_RADIO; dx <= REPRO_LOCAL_RADIO; dx++) {
      if (dx * dx + dy * dy > REPRO_LOCAL_RADIO * REPRO_LOCAL_RADIO) continue;
      const tile = tileAt(world, { x: place.x + dx, y: place.y + dy });
      if (!tile) continue;
      s += tile.drinkingWater ?? 0;
      if (depositoRecargable(world.seed, tile.x, tile.y, tile, params.agua.cuencas)) c += 1;
    }
  }
  // Cisternas funcionales del disco, cada una una vez (NO una por tesela: una cisterna en el
  // borde contaria dos veces si se sumara `waterAvailable` por tesela). Solo cuentan con agua
  // > 0,1: una cisterna recien construida y vacia no baja phi ni frena (critica, riesgo 2).
  const cisternas = filtrarCerca(world.structures, place, REPRO_LOCAL_RADIO + 1, st => distance(place, st) <= REPRO_LOCAL_RADIO && st.condition > BROKEN_CONDITION && tileAt(world, st)?.terrain === 'shelter' && blueprintAffordances(st.components).waterCapacity > 0 && st.water > REPRO_LOCAL_UMBRAL_CISTERNA);
  for (const st of cisternas) {
    s += st.water;
    c += blueprintAffordances(st.components).waterCapacity;
  }
  const cuerpo = params.cuerpo;
  let adultos = 0, sedientos = 0;
  for (const otro of vecinos(world, place, REPRO_LOCAL_RADIO + 1, p => p.role === 'neighbor' && distance(place, p) <= REPRO_LOCAL_RADIO, 'repro-local')) {
    if (otro.demography.age < demographicTraits(otro.genome, cuerpo).maturityAge) continue;
    adultos++;
    if (otro.thirst > REPRO_LOCAL_UMBRAL_SED) sedientos++;
  }
  return { s, c, phi: c > 0 ? s / c : null, adultos, sedientos };
}

/**
 * Freno m_L del lugar, calculado una vez por lugar y ventana de `intervalo` pasos y guardado
 * en `world.reproLocal` (ronda vigente): la primera evaluacion de la ventana fija el valor y
 * las siguientes lo reutilizan, tambien tras `cloneWorld` o restaurar una instantanea, porque
 * viaja con el mundo (instantaneas, clones y digestos lo incluyen).
 */
export function multiplicadorLugar(world: World, place: Pick<PlaceView, 'id' | 'x' | 'y'>, phiRef: number, intervalo: number): number {
  const ventana = Math.floor(world.tick / intervalo);
  let ronda = world.reproLocal;
  if (!ronda || ronda.ventana !== ventana || ronda.intervalo !== intervalo || ronda.phiRef !== phiRef) {
    ronda = { ventana, intervalo, phiRef, frenos: {} };
    world.reproLocal = ronda;
  }
  const previo = ronda.frenos[place.id];
  if (previo !== undefined) { registrarEvaluacionM(world, ventana, previo.m); return previo.m; }
  const { s, c, adultos, sedientos } = llenadoLugar(world, place);
  const phi = c > 0 ? s / c : null;
  const sL = adultos > 0 ? sedientos / adultos : 0;
  const base = c > 0 ? Math.min(1 + (phiRef / (s / c)) ** REPRO_LOCAL_EXPONENTE, REPRO_LOCAL_TOPE_M) : 1;
  const m = base * (1 + REPRO_LOCAL_PESO_CORPORAL * sL);
  ronda.frenos[place.id] = { m, phi };
  registrarEvaluacionM(world, ventana, m);
  return m;
}

/** Cubos del histograma S2 de m: [==1, (1,1.5], (1.5,2], (2,4], (4,8], >8]. */
export const HIST_M_CUBOS = 6;
export interface VentanaInstrumento { nEval: number; histM: [number, number, number, number, number, number]; phiNacimientos: (number | null)[]; }
function ventanaVacia(): VentanaInstrumento { return { nEval: 0, histM: [0, 0, 0, 0, 0, 0], phiNacimientos: [] }; }
/** Sidecar por mundo (jamas en el `World`: no toca digestos ni instantaneas). */
const registros = new WeakMap<World, Map<number, VentanaInstrumento>>();
/** Ventanas retenidas sin drenar (replica drena a diario; el servidor auto-poda). */
const VENTANAS_RETENIDAS = 40;
function registroDe(world: World, ventana: number): VentanaInstrumento {
  let porMundo = registros.get(world);
  if (!porMundo) { porMundo = new Map(); registros.set(world, porMundo); }
  let rec = porMundo.get(ventana);
  if (!rec) {
    rec = ventanaVacia();
    porMundo.set(ventana, rec);
    for (const w of [...porMundo.keys()]) if (w < ventana - VENTANAS_RETENIDAS) porMundo.delete(w);
  }
  return rec;
}
/** S2: una evaluacion de m_L (hit o miss de la ronda). */
function registrarEvaluacionM(world: World, ventana: number, m: number): void {
  const rec = registroDe(world, ventana);
  rec.nEval++;
  rec.histM[m <= 1 ? 0 : m <= 1.5 ? 1 : m <= 2 ? 2 : m <= 4 ? 3 : m <= 8 ? 4 : 5]++;
}
/** S3: phi del lugar en un nacimiento por la via local (null = C_L 0, sin informacion). */
export function registrarNacimientoReproLocal(world: World, place: Pick<PlaceView, 'x' | 'y'>, ventana: number): void {
  registroDe(world, ventana).phiNacimientos.push(llenadoLugar(world, place).phi);
}
/** `cloneWorld` crea un objeto nuevo cada paso: sin esto el instrumento no sobreviviria al clon. */
export function heredarRegistroReproLocal(draft: World, source: World): void {
  const previo = registros.get(source);
  if (previo) registros.set(draft, previo);
}
/** Lee ventanas (las que faltan salen vacias); no drena. */
export function leerVentanasReproLocal(world: World, ventanas: number[]): VentanaInstrumento[] {
  const porMundo = registros.get(world);
  return ventanas.map(w => porMundo?.get(w) ?? ventanaVacia());
}
/** Drena ventanas ya informadas. */
export function drenarVentanasReproLocal(world: World, ventanas: number[]): void {
  const porMundo = registros.get(world);
  if (porMundo) for (const w of ventanas) porMundo.delete(w);
}

/**
 * Freno de una persona: el de su lugar (el mismo `primeroCerca(..., radioLugar)` de
 * `reproduce`). Sin lugar cerca no hay informacion y la ley es neutra (m = 1).
 */
export function multiplicadorPersona(world: World, person: Person, phiRef: number, radioLugar: number, intervalo: number): number {
  const place = primeroCerca(world.places, person, radioLugar + 1, p => distance(person, p) <= radioLugar);
  if (!place) return 1;
  return multiplicadorLugar(world, place, phiRef, intervalo);
}

/** Indice inicial del recorrido de `reproduce` con la ley activa (derivado de seed+tick). */
export function inicioRotado(n: number, seed: number, tick: number): number {
  if (n <= 0) return 0;
  return Math.floor(localRandom(seed, `repro-local:${tick}`)() * n);
}
