/**
 * Percepción por lotes (ARQ-motor §3.4): la parte regular de `choose` como función pura sobre el frente público y el
 * terreno de solo lectura. Es la referencia de CPU: la GPU (M3) la iguala por estadística y es lo que se recalcula
 * en el hilo dueño cuando una tarjeta falla o vence su plazo.
 *
 * Por actor: la ventana r = 7 con sus pasos BFS, el argmin de cada `Consulta`, el organismo de cada
 * `ConsultaOrganismo` y las utilidades del cerebro. Además de lo que fija el contrato, la CPU devuelve la ventana
 * entera (`PercepcionCpu.ventana`): la elección necesita los pasos hasta objetivos que no salen de ninguna consulta
 * (pareja, hogar, lugar, refugio, caza, exploración).
 */
import { COLUMNAS_CEREBRO, COLUMNAS_FIJAS, CEREBRO, ErrorDispositivo, REF_NULA, RASGOS_ANCHO, genDe, refDe, slotDe, type Col, type CtxLectura,
  type FrentePublico, type LotePercepcion, type Percepcion, type Percibidor, type Plan, type Terreno } from '../motor/contratos.js';
import { distance, type TileLookup } from '../mundo/geometria.js';
import { RADIUS, type Person } from '../mundo/tipos.js';
import { paramsOf, type WorldParams } from '../params.js';
import { softSign } from '../politica.js';
import { abrirBarrera, cerrarBarrera, type DestinoBarrera } from '../soa/barrera-percepcion.js';
import { conectarFrente, type FrenteCompartido } from '../soa/organismos.js';
import { organismosDe, type MundoOrganismos, type OrganismosMundo } from '../soa/organismos-mundo.js';
import type { ResidentFastAccess, TerrenoCompartido } from '../soa/terreno.js';
import { PLAN, planesPersonas } from './planes.js';
import { TerrenoPercepcion } from './terreno-percepcion.js';

type Lectura = Pick<CtxLectura, 'frente' | 'terreno'>;

// ── Ventana ──────────────────────────────────────────────────────────────────────────────────────────────

export const LADO_VENTANA = 2 * RADIUS + 1;
export const CELDAS_VENTANA = LADO_VENTANA * LADO_VENTANA;
/** `ventana[k]`: ≥ 0 pasos BFS; SIN_RUTA transitable sin ruta; FUERA fuera del disco, ausente o intransitable.
 * `k = (dy + r)·15 + dx + r`: recorrerla en orden es el orden de filas (dy, luego dx) de siempre. */
export const SIN_RUTA = -1, FUERA = -2;
export const CENTRO_VENTANA = RADIUS * LADO_VENTANA + RADIUS;
const EN_DISCO = Uint8Array.from({ length: CELDAS_VENTANA }, (_, k) => {
  const dx = k % LADO_VENTANA - RADIUS, dy = Math.floor(k / LADO_VENTANA) - RADIUS;
  return dx * dx + dy * dy <= RADIUS * RADIUS ? 1 : 0;
});
/** Distancia de cada posición de la ventana al centro: la misma que `distance(persona, tesela)`. */
export const DISTANCIA_VENTANA = Float64Array.from({ length: CELDAS_VENTANA },
  (_, k) => distance({ x: 0, y: 0 }, { x: k % LADO_VENTANA - RADIUS, y: Math.floor(k / LADO_VENTANA) - RADIUS }));

interface Filtro { datos: Col; min: number; max: number }

function filtrosTerreno(terreno: Terreno, tripletas: Float32Array): Filtro[] {
  const filtros: Filtro[] = [];
  for (let i = 0; i < tripletas.length; i += 3) filtros.push({ datos: terreno.campo(terreno.campos[tripletas[i]!]!), min: tripletas[i + 1]!, max: tripletas[i + 2]! });
  return filtros;
}

function cumple(filtros: readonly Filtro[], indice: number): boolean {
  for (let f = 0; f < filtros.length; f++) {
    const { datos, min, max } = filtros[f]!, v = datos[indice]!;
    if (!(v >= min && v <= max)) return false;
  }
  return true;
}

const cola = new Int16Array(CELDAS_VENTANA);

/**
 * Ventana r = 7 de (x, y) como `perceivedRoutes`: las celdas transitables del disco, y BFS desde el centro con los
 * vecinos en el orden (+1,0), (0,+1), (−1,0), (0,−1). El centro vale 0 aunque su celda no sea transitable.
 * Deja en `celdas[desde + k]` la celda del terreno de cada posición transitable (−1 en las demás).
 */
export function calcularVentana(terreno: Terreno, x: number, y: number, transitable: readonly Filtro[] | Float32Array,
  pasos: Int16Array, celdas: Int32Array, desde: number): void {
  const filtros = transitable instanceof Float32Array ? filtrosTerreno(terreno, transitable) : transitable;
  for (let k = 0; k < CELDAS_VENTANA; k++) {
    let c = -1;
    if (EN_DISCO[k]) {
      c = terreno.celda(x + k % LADO_VENTANA - RADIUS, y + ((k / LADO_VENTANA) | 0) - RADIUS);
      if (c >= 0 && !cumple(filtros, c)) c = -1;
    }
    celdas[desde + k] = c;
    pasos[desde + k] = c >= 0 ? SIN_RUTA : FUERA;
  }
  pasos[desde + CENTRO_VENTANA] = 0;
  cola[0] = CENTRO_VENTANA;
  let fin = 1;
  for (let i = 0; i < fin; i++) {
    const k = cola[i]!, n = pasos[desde + k]! + 1, lx = k % LADO_VENTANA;
    if (lx + 1 < LADO_VENTANA && pasos[desde + k + 1] === SIN_RUTA) { pasos[desde + k + 1] = n; cola[fin++] = k + 1; }
    if (k + LADO_VENTANA < CELDAS_VENTANA && pasos[desde + k + LADO_VENTANA] === SIN_RUTA) { pasos[desde + k + LADO_VENTANA] = n; cola[fin++] = k + LADO_VENTANA; }
    if (lx > 0 && pasos[desde + k - 1] === SIN_RUTA) { pasos[desde + k - 1] = n; cola[fin++] = k - 1; }
    if (k >= LADO_VENTANA && pasos[desde + k - LADO_VENTANA] === SIN_RUTA) { pasos[desde + k - LADO_VENTANA] = n; cola[fin++] = k - LADO_VENTANA; }
  }
}

// ── Salida ───────────────────────────────────────────────────────────────────────────────────────────────

/** Los vencidos de F2 antes de despacharlos: `PercepcionDelPaso` les da el número de despacho al lanzarlos. */
export type Vencidos = Omit<LotePercepcion, 'despacho'>;

/** La salida del contrato y, por actor, su ventana entera: pasos y celda de cada posición. */
export interface PercepcionCpu extends Percepcion { tick: number; despacho: number; readonly ventana: Int16Array; readonly ventanaCelda: Int32Array }

/** Reserva (o reutiliza si cabe) la salida de `n` actores; `compartida` la pone en SAB para que escriban otros hilos. */
export function reservarPercepcion(n: number, planes: readonly Plan[], previa?: PercepcionCpu, compartida = false): PercepcionCpu {
  const q = Math.max(0, ...planes.map(p => p.celdas.length)), v = Math.max(0, ...planes.map(p => p.organismos.length));
  const a = Math.max(0, ...planes.map(p => p.acciones));
  if (previa && previa.q === q && previa.v === v && previa.a === a && previa.ventana.length >= n * CELDAS_VENTANA) return previa;
  const cap = Math.max(n, 2 * Math.floor((previa?.ventana.length ?? 0) / CELDAS_VENTANA), 16);
  const buffer = (bytes: number) => compartida ? new SharedArrayBuffer(Math.max(8, bytes)) : new ArrayBuffer(Math.max(8, bytes));
  return {
    q, v, a, tick: -1, despacho: -1,
    celda: new Int32Array(buffer(cap * q * 4)), pasos: new Int16Array(buffer(cap * q * 2)), valor: new Float32Array(buffer(cap * q * 4)),
    organismo: new Float64Array(buffer(cap * v * 8)), utilidad: new Float32Array(buffer(cap * a * 4)),
    ventana: new Int16Array(buffer(cap * CELDAS_VENTANA * 2)), ventanaCelda: new Int32Array(buffer(cap * CELDAS_VENTANA * 4)),
  };
}

/** El eco del contrato: la salida lleva el `tick` y el `despacho` de su lote. */
export function sellar(salida: PercepcionCpu, lote: LotePercepcion): void {
  salida.tick = lote.tick;
  salida.despacho = lote.despacho;
}

// ── Organismos cercanos ──────────────────────────────────────────────────────────────────────────────────

const LADO_CASILLA = 8;
interface Casillas { tick: number; alta: number; mapa: Map<number, number[]> }
const casillasPorFrente = new WeakMap<FrentePublico, Casillas>();
/** Clave exacta en un double para |bx|, |by| < 2²⁵. */
const claveCasilla = (bx: number, by: number) => (bx + 2 ** 25) * 2 ** 26 + (by + 2 ** 25);

function casillas(frente: FrentePublico): Casillas {
  let c = casillasPorFrente.get(frente);
  if (c && c.tick === frente.tick && c.alta === frente.alta) return c;
  const mapa = new Map<number, number[]>();
  for (let s = 0; s < frente.alta; s++) {
    if (frente.vivo[s] !== 1) continue;
    const clave = claveCasilla(Math.floor(frente.x[s]! / LADO_CASILLA), Math.floor(frente.y[s]! / LADO_CASILLA));
    const lista = mapa.get(clave);
    if (lista) lista.push(s); else mapa.set(clave, [s]);
  }
  c = { tick: frente.tick, alta: frente.alta, mapa };
  casillasPorFrente.set(frente, c);
  return c;
}

const ANCHO_FIJO = new Map<string, number>(COLUMNAS_FIJAS.map(([nombre, , ancho]) => [nombre, ancho]));

/** Columna `indice` de `FrentePublico.columnas` y su ancho (las registradas lo deducen de la capacidad de `gen`). */
export function columnaFrente(frente: FrentePublico, indice: number): { datos: Col; ancho: number } {
  const nombre = frente.columnas[indice]!;
  const fijo = ANCHO_FIJO.get(nombre);
  if (fijo !== undefined) return { datos: frente[nombre as typeof COLUMNAS_FIJAS[number][0]], ancho: fijo };
  const datos = frente.col(nombre);
  return { datos, ancho: datos.length / frente.gen.length };
}

interface FiltroOrganismo { datos: Col; ancho: number; componente: number; min: number; max: number }
interface OrganismoResuelto { radio: number; clase: number; filtros: FiltroOrganismo[]; criterio: 0 | 1; valor: { datos: Col; ancho: number; componente: number } | null }

function organismoCercano(frente: FrentePublico, rejilla: Casillas, actor: number, x: number, y: number, o: OrganismoResuelto): number {
  const bx0 = Math.floor((x - o.radio) / LADO_CASILLA), bx1 = Math.floor((x + o.radio) / LADO_CASILLA);
  const by0 = Math.floor((y - o.radio) / LADO_CASILLA), by1 = Math.floor((y + o.radio) / LADO_CASILLA);
  let mejor = -1, mejorValor = 0;
  for (let bx = bx0; bx <= bx1; bx++) for (let by = by0; by <= by1; by++) {
    const lista = rejilla.mapa.get(claveCasilla(bx, by));
    if (!lista) continue;
    for (const s of lista) {
      if (s === actor || (o.clase !== 0 && frente.clase[s] !== o.clase)) continue;
      const d = Math.hypot(frente.x[s]! - x, frente.y[s]! - y);
      if (!(d <= o.radio)) continue;
      let pasa = true;
      for (const f of o.filtros) {
        const v = f.datos[s * f.ancho + f.componente]!;
        if (!(v >= f.min && v <= f.max)) { pasa = false; break; }
      }
      if (!pasa) continue;
      // Criterio 0: el más cercano; 1: el de mayor valor. Empate: el slot menor.
      const valor = o.criterio === 0 ? d : o.valor!.datos[s * o.valor!.ancho + o.valor!.componente]!;
      if (mejor < 0 || (o.criterio === 0 ? valor < mejorValor : valor > mejorValor) || (valor === mejorValor && s < mejor)) { mejor = s; mejorValor = valor; }
    }
  }
  return mejor;
}

// ── Lote ─────────────────────────────────────────────────────────────────────────────────────────────────

interface ConsultaResuelta { pesos: { datos: Col; w: number }[]; pesoDist: number; pesoPasos: number; filtros: Filtro[]; alcanzable: boolean }
interface PlanResuelto { transitable: Filtro[]; celdas: ConsultaResuelta[]; organismos: OrganismoResuelto[]; acciones: number; w: Float32Array | null }

function resolver(plan: Plan, { frente, terreno }: Lectura): PlanResuelto {
  return {
    transitable: filtrosTerreno(terreno, plan.transitable),
    celdas: plan.celdas.map(c => ({
      pesos: Array.from(c.campos, (campo, i) => ({ datos: terreno.campo(terreno.campos[campo]!), w: c.pesos[i]! })),
      pesoDist: c.pesoDist, pesoPasos: c.pesoPasos, filtros: filtrosTerreno(terreno, c.filtros), alcanzable: c.alcanzable,
    })),
    organismos: plan.organismos.map(o => {
      const filtros: FiltroOrganismo[] = [];
      for (let i = 0; i < o.filtros.length; i += 4) filtros.push({ ...columnaFrente(frente, o.filtros[i]!), componente: o.filtros[i + 1]!, min: o.filtros[i + 2]!, max: o.filtros[i + 3]! });
      return { radio: o.radio, clase: o.clase, filtros, criterio: o.criterio, valor: o.criterio === 1 ? { ...columnaFrente(frente, o.columna), componente: o.componente } : null };
    }),
    acciones: plan.acciones, w: plan.w,
  };
}

const ocultas = new Float64Array(CEREBRO.ocultas);

/** Lo que comparten los actores de una llamada: los planes resueltos contra el frente y el terreno, la rejilla de
 * organismos y las columnas del cerebro. */
interface Preparado {
  frente: FrentePublico; terreno: Terreno; planes: PlanResuelto[]; rejilla: Casillas | undefined;
  obs: Col | undefined; pol: Col | undefined; ses: Col | undefined;
}

function preparar(ctx: Lectura, planes: readonly Plan[], acciones: number): Preparado {
  const { frente, terreno } = ctx, resueltos = planes.map(p => resolver(p, ctx)), cerebro = acciones > 0;
  return {
    frente, terreno, planes: resueltos, rejilla: resueltos.some(p => p.organismos.length > 0) ? casillas(frente) : undefined,
    obs: cerebro ? frente.col('observacion') : undefined, pol: cerebro ? frente.col('politica') : undefined, ses: cerebro ? frente.col('sesgo') : undefined,
  };
}

/** Fila `i` de `salida`: el actor `slot` con su plan, percibido desde (x, y). */
function percibirActor(p: Preparado, slot: number, plan: PlanResuelto, x: number, y: number, salida: PercepcionCpu, i: number): void {
  const { frente, terreno } = p, { q, v, a } = salida, base = i * CELDAS_VENTANA;
  calcularVentana(terreno, x, y, plan.transitable, salida.ventana, salida.ventanaCelda, base);
  for (let j = 0; j < q; j++) {
    const r = i * q + j, consulta = plan.celdas[j];
    let mejor = -1, mejorClave = Infinity;
    if (consulta) for (let k = 0; k < CELDAS_VENTANA; k++) {
      const c = salida.ventanaCelda[base + k]!;
      if (c < 0) continue;
      const pasos = salida.ventana[base + k]!;
      if (pasos < 0 && (consulta.alcanzable || consulta.pesoPasos !== 0)) continue;
      if (!cumple(consulta.filtros, c)) continue;
      let clave = consulta.pesoDist * DISTANCIA_VENTANA[k]!;
      if (consulta.pesoPasos !== 0) clave += consulta.pesoPasos * pasos;
      for (const { datos, w } of consulta.pesos) clave += w * datos[c]!;
      if (mejor < 0 || clave < mejorClave) { mejor = k; mejorClave = clave; }
    }
    salida.celda[r] = mejor < 0 ? -1 : salida.ventanaCelda[base + mejor]!;
    salida.pasos[r] = mejor < 0 ? -1 : salida.ventana[base + mejor]!;
    salida.valor[r] = mejor < 0 ? Infinity : mejorClave;
  }
  for (let j = 0; j < v; j++) {
    const o = plan.organismos[j], s = o ? organismoCercano(frente, p.rejilla!, slot, x, y, o) : -1;
    salida.organismo[i * v + j] = s < 0 ? REF_NULA : refDe(s, frente.gen[s]!);
  }
  for (let j = 0; j < a; j++) salida.utilidad[i * a + j] = 0;
  if (plan.acciones > 0) cerebro(p.obs!, p.pol!, p.ses!, slot, plan, frente, salida.utilidad, i * a);
}

/**
 * Percibe los actores `[desde, hasta)` del lote y escribe sus filas de `salida`. Pura: solo lee el frente y el
 * terreno, y cada fila depende solo de ellos, así que cualquier reparto del lote entre hilos da la misma salida.
 * Las claves y los desempates son los de `choose`: Σ w·campo + pesoDist·dist (+ pesoPasos·pasos, que descarta las
 * celdas sin ruta), y gana la primera celda en orden de filas (dy, luego dx) con la clave estrictamente menor.
 */
export function percibirLote(ctx: Lectura, lote: LotePercepcion, planes: readonly Plan[], salida: PercepcionCpu, desde = 0, hasta = lote.slots.length): void {
  const p = preparar(ctx, planes, salida.a), { frente } = p;
  for (let i = desde; i < hasta; i++) {
    const slot = lote.slots[i]!;
    percibirActor(p, slot, p.planes[lote.plan[i]!]!, frente.x[slot]!, frente.y[slot]!, salida, i);
  }
}

/** Solo las ventanas de los actores `[desde, hasta)`: lo que la percepción de una tarjeta no trae (el contrato no las
 * pide) y que `choose` recorre. Pura como `percibirLote`. */
export function ventanasLote({ frente, terreno }: Lectura, lote: LotePercepcion, planes: readonly Plan[],
  salida: Pick<PercepcionCpu, 'ventana' | 'ventanaCelda'>, desde = 0, hasta = lote.slots.length): void {
  const transitable = planes.map(plan => filtrosTerreno(terreno, plan.transitable));
  for (let i = desde; i < hasta; i++) {
    const slot = lote.slots[i]!;
    calcularVentana(terreno, frente.x[slot]!, frente.y[slot]!, transitable[lote.plan[i]!]!, salida.ventana, salida.ventanaCelda, i * CELDAS_VENTANA);
  }
}

/** La percepción de una tarjeta con las ventanas de `ventanas` (que ya las tiene) o calculadas aquí. */
export function conVentanas(ctx: Lectura, lote: LotePercepcion, planes: readonly Plan[], p: Percepcion, previa: PercepcionCpu | undefined,
  ventanas?: Pick<PercepcionCpu, 'ventana' | 'ventanaCelda'>): PercepcionCpu {
  let salida = ventanas;
  if (!salida) {
    const n = lote.slots.length;
    const ventana = previa && previa.ventana.length >= n * CELDAS_VENTANA ? previa.ventana : new Int16Array(Math.max(16, 2 * n) * CELDAS_VENTANA);
    const ventanaCelda = previa && previa.ventanaCelda.length >= n * CELDAS_VENTANA ? previa.ventanaCelda : new Int32Array(ventana.length);
    salida = { ventana, ventanaCelda };
    ventanasLote(ctx, lote, planes, salida);
  }
  return { q: p.q, v: p.v, a: p.a, tick: p.tick, despacho: p.despacho, celda: p.celda, pasos: p.pasos, valor: p.valor,
    organismo: p.organismo, utilidad: p.utilidad, ventana: salida.ventana, ventanaCelda: salida.ventanaCelda };
}

/**
 * ¿Puede ser `p` (de otro percibidor, ya con ventanas de CPU) la percepción de este lote sobre esta vista? Cada celda
 * devuelta tiene que caer en la ventana de su actor, con sus pasos, y cumplir los filtros de su consulta; cada organismo,
 * vivir con la generación de su `Ref` y dentro del radio. El eco de `tick` y `despacho` descarta antes las salidas de otro
 * lote; esto atrapa las que traen el eco bien y las filas mal. No comprueba que la celda sea la mejor.
 */
export function coherente(ctx: Lectura, lote: LotePercepcion, planes: readonly Plan[], p: PercepcionCpu): boolean {
  const { frente, terreno } = ctx, resueltos = planes.map(plan => resolver(plan, ctx)), n = lote.slots.length;
  if (p.celda.length < n * p.q || p.pasos.length < n * p.q || p.organismo.length < n * p.v || p.utilidad.length < n * p.a) return false;
  for (let i = 0; i < n; i++) {
    const slot = lote.slots[i]!, plan = resueltos[lote.plan[i]!]!, ax = frente.x[slot]!, ay = frente.y[slot]!, base = i * CELDAS_VENTANA;
    for (let j = 0; j < p.q; j++) {
      const c = p.celda[i * p.q + j]!, consulta = plan.celdas[j];
      if (c < 0) continue;
      const pagina = c >> 8;
      if (!consulta || pagina >= terreno.paginas) return false;
      const dx = terreno.paginaX[pagina]! * 16 + (c & 15) - ax, dy = terreno.paginaY[pagina]! * 16 + ((c >> 4) & 15) - ay;
      if (dx < -RADIUS || dx > RADIUS || dy < -RADIUS || dy > RADIUS) return false;
      const k = (dy + RADIUS) * LADO_VENTANA + dx + RADIUS;
      if (p.ventanaCelda[base + k] !== c || p.pasos[i * p.q + j] !== p.ventana[base + k]) return false;
      if ((consulta.alcanzable || consulta.pesoPasos !== 0) && p.ventana[base + k]! < 0) return false;
      if (!cumple(consulta.filtros, c)) return false;
    }
    for (let j = 0; j < p.v; j++) {
      const ref = p.organismo[i * p.v + j]!, o = plan.organismos[j];
      if (ref === REF_NULA) continue;
      const s = slotDe(ref);
      if (!o || s === slot || s >= frente.alta || frente.vivo[s] !== 1 || frente.gen[s] !== genDe(ref)) return false;
      if (!(Math.hypot(frente.x[s]! - ax, frente.y[s]! - ay) <= o.radio)) return false;
    }
    for (let j = 0; j < plan.acciones; j++) if (!Number.isFinite(p.utilidad[i * p.a + j]!)) return false;
  }
  return true;
}

/** Red 12→8→12 de `politica.ts` (mismas operaciones FP64 y en el mismo orden) con la plasticidad dentro de la
 * última activación, como hoy; luego la tabla W por los rasgos, si el plan la trae. */
function cerebro(obs: Col, pol: Col, ses: Col, slot: number, plan: PlanResuelto, frente: FrentePublico, salida: Float32Array, desde: number): void {
  const { entradas: E, ocultas: H, acciones: A } = CEREBRO;
  const o = slot * COLUMNAS_CEREBRO.observacion, w = slot * COLUMNAS_CEREBRO.politica, b = slot * COLUMNAS_CEREBRO.sesgo;
  for (let h = 0; h < H; h++) {
    let suma = pol[w + E * H + h]!;
    for (let j = 0; j < E; j++) suma = suma + obs[o + j]! * pol[w + h * E + j]!;
    ocultas[h] = softSign(suma);
  }
  const W2 = E * H + H, B2 = W2 + H * A;
  for (let k = 0; k < A; k++) {
    let suma = pol[w + B2 + k]!;
    for (let h = 0; h < H; h++) suma = suma + ocultas[h]! * pol[w + W2 + k * H + h]!;
    let u = softSign(suma + ses[b + k]!);
    if (plan.w) for (let r = 0; r < RASGOS_ANCHO; r++) u += plan.w[k * RASGOS_ANCHO + r]! * frente.rasgos[slot * RASGOS_ANCHO + r]!;
    salida[desde + k] = u;
  }
}

/** Percibidor del hilo que llama: el modo de un hilo, y el respaldo cuando una tarjeta cae. */
export class PercibidorCpu implements Percibidor {
  readonly dispositivo = 'cpu' as const;
  #salida: PercepcionCpu | undefined;
  constructor(private readonly ctx: Lectura) {}
  lanzar(lote: LotePercepcion, planes: readonly Plan[]): void {
    this.#salida = reservarPercepcion(lote.slots.length, planes, this.#salida);
    percibirLote(this.ctx, lote, planes, this.#salida);
    sellar(this.#salida, lote);
  }
  esperar(): PercepcionCpu {
    if (!this.#salida) throw new Error('esperar sin lanzar');
    return this.#salida;
  }
}

// ── Vista del mundo ──────────────────────────────────────────────────────────────────────────────────────

/** Lo que otro hilo necesita para rehacer la vista: el terreno y el frente, compartidos sobre SAB. */
export interface DescriptorVista { terreno: TerrenoCompartido; frente: FrenteCompartido }

/**
 * Lo que perciben las personas: el frente de la tabla común de organismos (M2a), con las personas tal como empiezan la
 * fase, y el terreno del mundo (M1, `TerrenoPercepcion`). En el hilo dueño la vista sabe qué persona ocupa cada ranura;
 * otro hilo la rehace con `desde(descriptor)` y solo lee. Los percibidores la leen dentro de `lanzar` (los hilos de la
 * piscina terminan antes de que vuelva; la tarjeta copia lo que sube), así que nadie la lee mientras el dueño la escribe.
 */
export class VistaMundo implements Lectura {
  private constructor(readonly terreno: TerrenoPercepcion, private readonly leer: () => FrentePublico, readonly organismos?: OrganismosMundo) {}
  static de(organismos: OrganismosMundo, terreno: TerrenoPercepcion): VistaMundo {
    return new VistaMundo(terreno, () => organismos.tabla.lectura(), organismos);
  }
  static desde(d: DescriptorVista): VistaMundo {
    const frente = conectarFrente(d.frente);
    return new VistaMundo(TerrenoPercepcion.conectar(d.terreno), () => frente.leer());
  }
  get frente(): FrentePublico { return this.leer(); }
  get tick(): number { return this.frente.tick; }

  /** Ranura de la persona en la tabla común (−1 si aún no tiene) y persona de una ranura (solo en el hilo dueño). */
  slot(persona: Person): number { return this.organismos!.personas.slot(persona); }
  persona(slot: number): Person | undefined { return this.organismos!.personas.persona(slot) as Person | undefined; }
  get ranurasPersonas(): IterableIterator<number> { return this.organismos!.personas.ranuras; }

  /** F2: publica a `personas` en el frente si no lo están ya donde están ahora, y pone al día el terreno de los discos de
   * `discos` (índices en `personas`). */
  capturar(personas: readonly Person[], tick: number, discos: Iterable<number>, tileIn: TileLookup, fast: ResidentFastAccess | undefined): void {
    const organismos = this.organismos!;
    if (organismos.personas.sincronizar(personas) || !organismos.personas.alDia(personas)) organismos.publicar(tick, undefined, personas);
    this.terreno.empezarCaptura();
    for (const s of discos) this.terreno.capturarDisco(personas[s]!.x, personas[s]!.y, tileIn, fast);
    this.terreno.fijarCaptura();
  }
  /** ¿Tiene la ranura escritos los pesos de su ocupante de ahora? */
  pesosAlDia(slot: number): boolean { return this.organismos!.personas.pesosGen[slot] === this.frente.gen[slot]; }
  /** Pesos heredados del ocupante de la ranura. Las columnas del cerebro no tienen doble búfer: se escriben en el frente. */
  escribirPesos(slot: number, pesos: ArrayLike<number>): void {
    (this.frente.col('politica') as Float64Array).set(pesos, slot * COLUMNAS_CEREBRO.politica);
    this.organismos!.personas.pesosGen[slot] = this.frente.gen[slot]!;
  }
  /** Observación y plasticidad de la ranura para este despacho. */
  escribirEstado(slot: number, observacion: ArrayLike<number>, sesgo: ArrayLike<number>): void {
    (this.frente.col('observacion') as Float64Array).set(observacion, slot * COLUMNAS_CEREBRO.observacion);
    (this.frente.col('sesgo') as Float64Array).set(sesgo, slot * COLUMNAS_CEREBRO.sesgo);
  }
  descriptor(): DescriptorVista { return { terreno: this.terreno.compartir(), frente: this.organismos!.tabla.compartir() }; }
}

// ── Percepción del paso ──────────────────────────────────────────────────────────────────────────────────

/** Fila de percepción de una persona: dónde leerla y sobre qué terreno se calculó. */
export interface FilaPercibida { readonly salida: PercepcionCpu; readonly fila: number; readonly terreno: TerrenoPercepcion }

/** Un percibidor que puede servir a varios mundos (la piscina y las tarjetas del proceso): lee la vista que se le da. */
export interface PercibidorCompartido extends Percibidor { fuentes(vista: VistaMundo): void }

/** Plazo de una tarjeta antes de recalcular su lote en CPU (ARQ-motor §3.1, B2). */
const PLAZO_PERCEPCION_MS = 2000;

/** Cuánto rehace el dueño y cuánto le cuesta decidirlo (con `medir`): el criterio de versiones de página, que es el que
 * manda, y el de valores celda a celda de antes, evaluado sobre el mismo estado. */
export interface MedidaRevalidacion {
  filas: number; aceptadas: number; rehechasPorPagina: number; rehechasPorValor: number; fallosBarrera: number;
  sueltas: number; msPaginas: number; msValores: number; msSueltas: number;
}
const medidaVacia = (): MedidaRevalidacion => ({ filas: 0, aceptadas: 0, rehechasPorPagina: 0, rehechasPorValor: 0, fallosBarrera: 0, sueltas: 0, msPaginas: 0, msValores: 0, msSueltas: 0 });

/** Elige el percibidor del lote según `motor` (hilos y tarjetas); lo registra `despacho.ts`. */
export type ElegirPercibidor = (motor: WorldParams['motor'], cpu: PercibidorCpu) => Percibidor | PercibidorCompartido | undefined;
let elegir: ElegirPercibidor | undefined;
export function registrarPercibidores(e: ElegirPercibidor | undefined): void { elegir = e; }

/**
 * La percepción de las personas en un mundo: el lote de F2 (quienes pueden decidir en este tick, sobre el estado al
 * empezar la fase) y, para quien decide sin estar en él, o cuando su disco cambió desde la captura, una percepción
 * suelta en el momento sobre el estado vivo. Lo percibido en F2 sigue valiendo si las páginas de su disco conservan la
 * versión de la captura: toda escritura de un campo percibido durante la fase sube la de su página.
 */
export class PercepcionDelPaso {
  readonly vista: VistaMundo;
  readonly planes: Plan[];
  /** Quien percibe el lote. Sin fijarlo, el que elige `registrarPercibidores` para el `motor` del mundo en cada despacho
   * (la piscina de M1, las tarjetas de M3), o este mismo hilo. Otro percibidor lee `vista`. */
  get percibidor(): Percibidor | PercibidorCompartido { return this.#fijado ?? elegir?.(this.#motor(), this.#cpu) ?? this.#cpu; }
  set percibidor(p: Percibidor | PercibidorCompartido) { this.#fijado = p; }
  #fijado: Percibidor | PercibidorCompartido | undefined;
  readonly #motor: () => WorldParams['motor'];
  /** Con `medir`, `medida` cuenta las filas rehechas por cada criterio y lo que cuesta cada uno. */
  medir = false;
  /** Lo que lleva F2 desde que se creó: captura (frente y páginas), columnas del cerebro y despacho (lanzar, esperar,
   * ventanas que falten y comprobación), en ms de pared del hilo que simula. */
  readonly tiempos = { despachos: 0, filas: 0, capturaMs: 0, cerebroMs: 0, despachoMs: 0 };
  medida = medidaVacia();
  readonly #cpu: PercibidorCpu;
  readonly #depuracion: boolean;
  #salida: PercepcionCpu | undefined;
  #ventanas: PercepcionCpu | undefined;
  #lote = new Int32Array(0);
  #fila = new Int32Array(0);
  #tick = -1;
  #activa = false;
  #barrera: DestinoBarrera | undefined;
  #despachos = 0;
  #respaldos = 0;
  #instantanea: Float64Array[] = [];
  readonly #suelta: PercepcionCpu;

  /** `terreno`: el del dueño cuando el motor reparte el mundo (la copia de la arena compartida con su hilo). */
  constructor(mundo: MundoOrganismos, terreno?: TerrenoPercepcion) {
    const { motor } = paramsOf(mundo as never);
    this.#motor = () => paramsOf(mundo as never).motor;
    this.#depuracion = motor.depuracion;
    this.vista = VistaMundo.de(organismosDe(mundo), terreno ?? new TerrenoPercepcion(motor.depuracion));
    this.planes = planesPersonas(this.vista.terreno.campos);
    this.#cpu = new PercibidorCpu(this.vista);
    this.#suelta = reservarPercepcion(1, this.planes);
  }

  /** Despachos que hubo que recalcular en CPU porque el percibidor falló, venció o devolvió otra cosa. */
  get respaldos(): number { return this.#respaldos; }

  /** F2. Antes de lanzar, `cerebro` pone las columnas del cerebro de las ranuras del despacho. Si la tarjeta falla o
   * vence su plazo, o devuelve algo que no es de este lote, el lote entero se percibe aquí en CPU en el mismo tick. */
  percibir(personas: readonly Person[], tick: number, vencidos: Vencidos, tileIn: TileLookup, fast: ResidentFastAccess | undefined,
    cerebro: (vista: VistaMundo, despacho: LotePercepcion) => void): PercepcionCpu {
    this.cerrar();
    this.#barrera = abrirBarrera(this.vista.terreno);
    this.#activa = true;
    try { return this.#percibir(personas, tick, vencidos, tileIn, fast, cerebro); }
    catch (error) { this.cerrar(); throw error; }
  }
  #percibir(personas: readonly Person[], tick: number, vencidos: Vencidos, tileIn: TileLookup, fast: ResidentFastAccess | undefined,
    cerebro: (vista: VistaMundo, despacho: LotePercepcion) => void): PercepcionCpu {
    const { vista } = this, n = vencidos.slots.length, t = this.tiempos, inicio = performance.now();
    vista.capturar(personas, tick, vencidos.slots, tileIn, fast);
    const capturado = performance.now();
    t.despachos++; t.filas += n; t.capturaMs += capturado - inicio;
    if (this.medir) this.#fotografiar();
    if (this.#lote.length < n) this.#lote = new Int32Array(Math.max(n, 2 * this.#lote.length));
    for (let i = 0; i < n; i++) this.#lote[i] = vista.slot(personas[vencidos.slots[i]!]!);
    const despacho: LotePercepcion = { tick, despacho: ++this.#despachos, slots: this.#lote.subarray(0, n), plan: vencidos.plan };
    cerebro(vista, despacho);
    const preparado = performance.now();
    t.cerebroMs += preparado - capturado;
    let salida: PercepcionCpu;
    const percibidor = this.percibidor;
    try {
      if ('fuentes' in percibidor) percibidor.fuentes(vista);
      percibidor.lanzar(despacho, this.planes);
      const p = percibidor.esperar(PLAZO_PERCEPCION_MS);
      salida = 'ventana' in p ? p as PercepcionCpu : this.#ventanas = conVentanas(vista, despacho, this.planes, p, this.#ventanas);
      if (salida.tick !== despacho.tick || salida.despacho !== despacho.despacho)
        throw new ErrorDispositivo(percibidor.dispositivo, `salida del despacho ${salida.despacho} (tick ${salida.tick}) en el ${despacho.despacho} (tick ${tick})`);
      // Lo que viene de una tarjeta se comprueba contra las ventanas; los hilos de la piscina ejecutan este mismo código.
      if ((!('ventana' in p) || percibidor.dispositivo !== 'cpu') && !coherente(vista, despacho, this.planes, salida))
        throw new ErrorDispositivo(percibidor.dispositivo, 'salida que no casa con el lote');
    } catch (error) {
      if (!(error instanceof ErrorDispositivo) || percibidor === this.#cpu) throw error;
      this.#respaldos++;
      this.#cpu.lanzar(despacho, this.planes);
      salida = this.#cpu.esperar();
    }
    this.#salida = salida;
    t.despachoMs += performance.now() - preparado;
    const alta = vista.frente.alta;
    if (this.#fila.length < alta) this.#fila = new Int32Array(Math.max(alta, 2 * this.#fila.length));
    this.#fila.fill(-1);
    for (let i = 0; i < n; i++) this.#fila[despacho.slots[i]!] = i;
    this.#tick = tick;
    return salida;
  }
  #despachosAjenos = 0;
  #salidaAjena: PercepcionCpu | undefined;
  /**
   * Entrada pública del despacho para quien no es una persona (la fauna vencida de f): percibe `lote` (ranuras de la
   * tabla común, con sus propios `planes`) por el mismo percibidor que las personas, con la misma caída a CPU en el tick.
   * `discos` son las posiciones cuyos discos r = 7 hay que poner al día antes de lanzar. No abre la barrera de escritura
   * ni toca la fila de nadie: la salida vale hasta el siguiente despacho ajeno.
   */
  percibirLote(lote: Vencidos, planes: readonly Plan[], discos: Iterable<{ readonly x: number; readonly y: number }>,
    tileIn: TileLookup, fast: ResidentFastAccess | undefined): PercepcionCpu {
    const { vista } = this;
    for (const d of discos) vista.terreno.capturarDisco(d.x, d.y, tileIn, fast);
    const despacho: LotePercepcion = { tick: lote.tick, despacho: 2 ** 31 + ++this.#despachosAjenos, slots: lote.slots, plan: lote.plan };
    const percibidor = this.percibidor;
    try {
      if ('fuentes' in percibidor) percibidor.fuentes(vista);
      percibidor.lanzar(despacho, planes);
      const p = percibidor.esperar(PLAZO_PERCEPCION_MS);
      const salida = 'ventana' in p ? p as PercepcionCpu : this.#salidaAjena = conVentanas(vista, despacho, planes, p, this.#salidaAjena);
      if (salida.tick !== despacho.tick || salida.despacho !== despacho.despacho)
        throw new ErrorDispositivo(percibidor.dispositivo, `salida del despacho ${salida.despacho} en el ${despacho.despacho}`);
      if ((!('ventana' in p) || percibidor.dispositivo !== 'cpu') && !coherente(vista, despacho, planes, salida))
        throw new ErrorDispositivo(percibidor.dispositivo, 'salida que no casa con el lote');
      return salida;
    } catch (error) {
      if (!(error instanceof ErrorDispositivo) || percibidor === this.#cpu) throw error;
      this.#respaldos++;
      this.#cpu.lanzar(despacho, planes);
      return this.#cpu.esperar();
    }
  }

  /** Fin de la fase de personas: lo percibido deja de valer y la barrera de escritura se cierra. */
  cerrar(): void {
    if (!this.#activa) return;
    this.#activa = false;
    cerrarBarrera(this.#barrera);
    this.#barrera = undefined;
    this.vista.terreno.soltar();
  }

  /** La fila de `persona`: la del lote si sigue donde la capturó y su disco no cambió desde entonces; si no, la percibe
   * ahora sobre el estado vivo y sin cerebro (en búferes propios si `reutilizar` es falso: una decisión anidada no pisa
   * la de quien la llamó). */
  filaDe(tick: number, persona: Person, tileIn: TileLookup, fast: ResidentFastAccess | undefined, reutilizar = true): FilaPercibida {
    const { vista } = this, { terreno } = vista, frente = vista.frente;
    const slot = vista.organismos!.personas.slot(persona);
    const fila = this.#activa && this.#tick === tick && slot >= 0 ? this.#fila[slot] ?? -1 : -1;
    if (fila >= 0 && frente.x[slot] === persona.x && frente.y[slot] === persona.y && this.#vigente(persona, tileIn, fast))
      return { salida: this.#salida!, fila, terreno };
    const inicio = this.medir ? performance.now() : 0;
    const salida = reutilizar ? this.#suelta : reservarPercepcion(1, this.planes);
    // Se percibe desde donde está ahora sobre su disco al día (el frente la sigue llevando donde la capturó).
    terreno.capturarDisco(persona.x, persona.y, tileIn, fast);
    const p = preparar({ frente, terreno }, this.planes, salida.a);
    percibirActor(p, slot, p.planes[PLAN.sinCerebro]!, persona.x, persona.y, salida, 0);
    if (this.medir) { this.medida.sueltas++; this.medida.msSueltas += performance.now() - inicio; }
    return { salida, fila: 0, terreno };
  }

  /** ¿Sigue el disco de la persona como en F2? Por versiones de página; con `depuracion`, la barrera se comprueba
   * además contra los valores de ahora, y con `medir` se cuentan los dos criterios. */
  #vigente(persona: Person, tileIn: TileLookup, fast: ResidentFastAccess | undefined): boolean {
    const { terreno } = this.vista;
    if (!this.medir) {
      const vigente = terreno.vigenteDesdeCaptura(persona.x, persona.y);
      if (vigente && this.#depuracion && !terreno.coincideConMundo(persona.x, persona.y, tileIn, fast))
        throw new Error(`Barrera de percepción incompleta: el disco de ${persona.id} cambió sin subir la versión de su página (tick ${this.#tick}).`);
      return vigente;
    }
    const m = this.medida;
    let t = performance.now();
    const porPagina = terreno.vigenteDesdeCaptura(persona.x, persona.y);
    m.msPaginas += performance.now() - t;
    t = performance.now();
    const porValor = terreno.coincideConMundo(persona.x, persona.y, tileIn, fast, this.#instantanea);
    m.msValores += performance.now() - t;
    m.filas++;
    if (porPagina) m.aceptadas++; else m.rehechasPorPagina++;
    if (!porValor) m.rehechasPorValor++;
    if (porPagina && !porValor) m.fallosBarrera++;
    return porPagina;
  }

  /** Copia de lo capturado en F2, para evaluar sobre ella el criterio de valores aunque una percepción suelta ponga
   * después una página al día. */
  #fotografiar(): void {
    const { terreno } = this.vista, valores = terreno.valores;
    if (this.#instantanea.length !== valores.length || this.#instantanea[0]!.length < valores[0]!.length)
      this.#instantanea = valores.map(v => new Float64Array(v.length));
    for (const chunk of terreno.paginasCapturadas)
      for (let k = 0; k < valores.length; k++) this.#instantanea[k]!.set(valores[k]!.subarray(chunk << 8, (chunk + 1) << 8), chunk << 8);
  }
}

const porMundo = new WeakMap<object, PercepcionDelPaso>();
/** La percepción de personas de un mundo (una por mundo, creada al primer uso). */
export function percepcionDe(mundo: MundoOrganismos): PercepcionDelPaso {
  let p = porMundo.get(mundo);
  if (!p) { p = new PercepcionDelPaso(mundo); porMundo.set(mundo, p); }
  return p;
}
/** El motor de dueños liga a la parte del mundo de cada dueño su percepción (sobre la tabla y el terreno compartidos). */
export function registrarPercepcion(mundo: object, p: PercepcionDelPaso): void { porMundo.set(mundo, p); }
/** Olvida la percepción del mundo (época nueva: la tabla de organismos se rearma y la vista con ella). */
export function olvidarPercepcion(mundo: object): void { porMundo.get(mundo)?.cerrar(); porMundo.delete(mundo); }

