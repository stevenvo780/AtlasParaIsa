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
import { COLUMNAS_CEREBRO, COLUMNAS_FIJAS, CEREBRO, Clase, ErrorDispositivo, REF_NULA, RASGOS_ANCHO, refDe, type Col, type CtxLectura, type FrentePublico,
  type LotePercepcion, type Percepcion, type Percibidor, type Plan, type Terreno, type TipoColumna } from '../motor/contratos.js';
import { distance, type TileLookup } from '../mundo/geometria.js';
import { RADIUS, type Person } from '../mundo/tipos.js';
import type { Tile } from '../../shared/types.js';
import { softSign } from '../politica.js';
import { BIOMAS, CAMPOS_PERCEPCION, COLUMNA_PROTEGIDO, PLAN, TERRENOS, planesPersonas } from './planes.js';

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

/** La salida del contrato y, por actor, su ventana entera: pasos y celda de cada posición. */
export interface PercepcionCpu extends Percepcion { readonly ventana: Int16Array; readonly ventanaCelda: Int32Array }

/** Reserva (o reutiliza si cabe) la salida de `n` actores; `compartida` la pone en SAB para que escriban otros hilos. */
export function reservarPercepcion(n: number, planes: readonly Plan[], previa?: PercepcionCpu, compartida = false): PercepcionCpu {
  const q = Math.max(0, ...planes.map(p => p.celdas.length)), v = Math.max(0, ...planes.map(p => p.organismos.length));
  const a = Math.max(0, ...planes.map(p => p.acciones));
  if (previa && previa.q === q && previa.v === v && previa.a === a && previa.ventana.length >= n * CELDAS_VENTANA) return previa;
  const cap = Math.max(n, 2 * Math.floor((previa?.ventana.length ?? 0) / CELDAS_VENTANA), 16);
  const buffer = (bytes: number) => compartida ? new SharedArrayBuffer(Math.max(8, bytes)) : new ArrayBuffer(Math.max(8, bytes));
  return {
    q, v, a,
    celda: new Int32Array(buffer(cap * q * 4)), pasos: new Int16Array(buffer(cap * q * 2)), valor: new Float32Array(buffer(cap * q * 4)),
    organismo: new Float64Array(buffer(cap * v * 8)), utilidad: new Float32Array(buffer(cap * a * 4)),
    ventana: new Int16Array(buffer(cap * CELDAS_VENTANA * 2)), ventanaCelda: new Int32Array(buffer(cap * CELDAS_VENTANA * 4)),
  };
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

function organismoCercano(frente: FrentePublico, rejilla: Casillas, actor: number, o: OrganismoResuelto): number {
  const x = frente.x[actor]!, y = frente.y[actor]!;
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

/**
 * Percibe los actores `[desde, hasta)` del lote y escribe sus filas de `salida`. Pura: solo lee el frente y el
 * terreno, y cada fila depende solo de ellos, así que cualquier reparto del lote entre hilos da la misma salida.
 * Las claves y los desempates son los de `choose`: Σ w·campo + pesoDist·dist (+ pesoPasos·pasos, que descarta las
 * celdas sin ruta), y gana la primera celda en orden de filas (dy, luego dx) con la clave estrictamente menor.
 */
export function percibirLote(ctx: Lectura, lote: LotePercepcion, planes: readonly Plan[], salida: PercepcionCpu, desde = 0, hasta = lote.slots.length): void {
  const { frente, terreno } = ctx;
  const resueltos = planes.map(p => resolver(p, ctx));
  const { q, v, a } = salida;
  const rejilla = resueltos.some(p => p.organismos.length > 0) ? casillas(frente) : undefined;
  const obs = a > 0 ? frente.col('observacion') : undefined, pol = a > 0 ? frente.col('politica') : undefined, ses = a > 0 ? frente.col('sesgo') : undefined;
  for (let i = desde; i < hasta; i++) {
    const slot = lote.slots[i]!, plan = resueltos[lote.plan[i]!]!;
    const base = i * CELDAS_VENTANA;
    calcularVentana(terreno, frente.x[slot]!, frente.y[slot]!, plan.transitable, salida.ventana, salida.ventanaCelda, base);
    for (let j = 0; j < q; j++) {
      const r = i * q + j, consulta = plan.celdas[j];
      let mejor = -1, mejorClave = Infinity;
      if (consulta) for (let k = 0; k < CELDAS_VENTANA; k++) {
        const c = salida.ventanaCelda[base + k]!;
        if (c < 0) continue;
        const p = salida.ventana[base + k]!;
        if (p < 0 && (consulta.alcanzable || consulta.pesoPasos !== 0)) continue;
        if (!cumple(consulta.filtros, c)) continue;
        let clave = consulta.pesoDist * DISTANCIA_VENTANA[k]!;
        if (consulta.pesoPasos !== 0) clave += consulta.pesoPasos * p;
        for (const { datos, w } of consulta.pesos) clave += w * datos[c]!;
        if (mejor < 0 || clave < mejorClave) { mejor = k; mejorClave = clave; }
      }
      salida.celda[r] = mejor < 0 ? -1 : salida.ventanaCelda[base + mejor]!;
      salida.pasos[r] = mejor < 0 ? -1 : salida.ventana[base + mejor]!;
      salida.valor[r] = mejor < 0 ? Infinity : mejorClave;
    }
    for (let j = 0; j < v; j++) {
      const o = plan.organismos[j], s = o ? organismoCercano(frente, rejilla!, slot, o) : -1;
      salida.organismo[i * v + j] = s < 0 ? REF_NULA : refDe(s, frente.gen[s]!);
    }
    for (let j = 0; j < a; j++) salida.utilidad[i * a + j] = 0;
    if (plan.acciones > 0) cerebro(obs!, pol!, ses!, slot, plan, frente, salida.utilidad, i * a);
  }
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
  }
  esperar(): PercepcionCpu {
    if (!this.#salida) throw new Error('esperar sin lanzar');
    return this.#salida;
  }
}

// ── Vista del mundo de la ola 1 ──────────────────────────────────────────────────────────────────────────

type Columna = Int32Array | Uint8Array | Uint16Array | Float32Array | Float64Array;
const CONSTRUCTOR: Record<TipoColumna, { new (b: SharedArrayBuffer): Columna; BYTES_PER_ELEMENT: number }> = {
  i32: Int32Array, u8: Uint8Array, u16: Uint16Array, f32: Float32Array, f64: Float64Array,
};
const REGISTRADAS: readonly (readonly [string, TipoColumna, number])[] = [
  // El cerebro en FP64: la red da entonces lo mismo que `evaluatePolicySingle` hasta el redondeo final a `utilidad`.
  [COLUMNA_PROTEGIDO, 'u8', 1], ['observacion', 'f64', COLUMNAS_CEREBRO.observacion],
  ['politica', 'f64', COLUMNAS_CEREBRO.politica], ['sesgo', 'f64', COLUMNAS_CEREBRO.sesgo],
];
const COLUMNAS_VISTA = [...COLUMNAS_FIJAS, ...REGISTRADAS];

/** Lo que otro hilo necesita para rehacer la vista: los SAB y los contadores. */
export interface DescriptorVista {
  tick: number; alta: number; paginas: number;
  columnas: Record<string, SharedArrayBuffer>; paginaX: SharedArrayBuffer; paginaY: SharedArrayBuffer; campos: SharedArrayBuffer[];
}

/** Frente de las personas en la ola 1: una fila por persona (slot = índice en `world.people` al capturar), con lo que
 * lee la percepción: posición, hambre, sed, energía, rol protegido y, para quien decide con cerebro, sus tres columnas. */
class FrenteMundo implements FrentePublico {
  tick = 0; alta = 0;
  readonly columnas = COLUMNAS_VISTA.map(([nombre]) => nombre);
  datos: Record<string, Columna> = {};
  constructor(buffers?: Record<string, SharedArrayBuffer>) {
    if (buffers) for (const [nombre, tipo] of COLUMNAS_VISTA) this.datos[nombre] = new CONSTRUCTOR[tipo](buffers[nombre]!);
    else this.reservar(16);
  }
  get gen() { return this.datos.gen!; } get vivo() { return this.datos.vivo!; } get clase() { return this.datos.clase!; }
  get uid() { return this.datos.uid!; } get dueno() { return this.datos.dueno!; } get x() { return this.datos.x!; } get y() { return this.datos.y!; }
  get chunk() { return this.datos.chunk!; } get accion() { return this.datos.accion!; } get objetivo() { return this.datos.objetivo!; }
  get decideEn() { return this.datos.decideEn!; } get cuerpo() { return this.datos.cuerpo!; } get rasgos() { return this.datos.rasgos!; }
  get genoma() { return this.datos.genoma!; } get pareja() { return this.datos.pareja!; }
  col(nombre: string): Col {
    const c = this.datos[nombre];
    if (!c) throw new Error(`Columna desconocida: ${nombre}`);
    return c;
  }
  reservar(filas: number): void {
    if (this.datos.gen && this.datos.gen.length >= filas) return;
    const cap = Math.max(filas, 2 * (this.datos.gen?.length ?? 0));
    for (const [nombre, tipo, ancho] of COLUMNAS_VISTA) this.datos[nombre] = new CONSTRUCTOR[tipo](new SharedArrayBuffer(cap * ancho * CONSTRUCTOR[tipo].BYTES_PER_ELEMENT));
  }
  capturar(personas: readonly Person[], tick: number): void {
    this.reservar(personas.length);
    this.tick = tick; this.alta = personas.length;
    const { gen, vivo, clase, uid, dueno, x, y, chunk, objetivo, decideEn, cuerpo, pareja } = this.datos;
    const protegido = this.datos[COLUMNA_PROTEGIDO]!;
    for (let s = 0; s < personas.length; s++) {
      const p = personas[s]!;
      gen![s] = 0; vivo![s] = 1; clase![s] = Clase.Persona; uid![s] = s + 1; dueno![s] = 0;
      x![s] = p.x; y![s] = p.y; chunk![s] = -1; objetivo![s] = -1; decideEn![s] = p.decisionAt; pareja![s] = -1;
      cuerpo![s * 7] = p.hunger; cuerpo![s * 7 + 1] = p.thirst ?? 0; cuerpo![s * 7 + 2] = p.energy;
      protegido[s] = p.role !== 'neighbor' ? 1 : 0;
    }
  }
}

/** Terreno capturado del mundo de la ola 1: solo los discos r = 7 de quien percibe, en páginas 16×16 con la
 * disposición de celdas del contrato y sobre SAB, para que lo lean otros hilos. Lee las teselas por sus campos, que
 * con el SoA residente son la misma memoria. */
export class TerrenoMundo implements Terreno {
  paginas = 0;
  paginaX: Int32Array<ArrayBufferLike> = new Int32Array(0); paginaY: Int32Array<ArrayBufferLike> = new Int32Array(0);
  versionPagina = new Uint32Array(0); versionVisible = new Uint32Array(0); duenoChunk = new Int16Array(0);
  readonly campos: readonly string[] = CAMPOS_PERCEPCION;
  valores: Float64Array<ArrayBufferLike>[] = [];
  /** Tesela de cada celda capturada: solo existe en el hilo que capturó. */
  teselas: (Tile | undefined)[] = [];
  #visto: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  #indice = new Map<number, number>();
  #ultimaClave = NaN; #ultimo = -1;

  constructor(d?: DescriptorVista) {
    if (!d) { this.#reservar(4); return; }
    this.paginas = d.paginas;
    this.paginaX = new Int32Array(d.paginaX); this.paginaY = new Int32Array(d.paginaY);
    this.valores = d.campos.map(b => new Float64Array(b));
    for (let c = 0; c < d.paginas; c++) this.#indice.set(claveCasilla(this.paginaX[c]!, this.paginaY[c]!), c);
  }
  #reservar(paginas: number): void {
    if (this.paginaX.length >= paginas) return;
    const cap = Math.max(paginas, 2 * this.paginaX.length);
    const sab = (bytes: number) => new SharedArrayBuffer(Math.max(8, bytes));
    const crecer = <T extends Int32Array<ArrayBufferLike> | Uint8Array<ArrayBufferLike> | Float64Array<ArrayBufferLike>>(previo: T, nuevo: T): T => { nuevo.set(previo); return nuevo; };
    this.paginaX = crecer(this.paginaX, new Int32Array(sab(cap * 4))); this.paginaY = crecer(this.paginaY, new Int32Array(sab(cap * 4)));
    this.versionPagina = new Uint32Array(cap); this.versionVisible = new Uint32Array(cap); this.duenoChunk = new Int16Array(cap);
    this.valores = CAMPOS_PERCEPCION.map((_, i) => crecer(this.valores[i] ?? new Float64Array(0), new Float64Array(sab(cap * 256 * 8))));
    this.#visto = crecer(this.#visto, new Uint8Array(cap * 256));
  }
  reiniciar(): void {
    // `terreno` = 0 marca la celda como no capturada; los demás campos se sobrescriben al capturarla.
    this.#visto.fill(0, 0, this.paginas * 256); this.valores[0]!.fill(0, 0, this.paginas * 256);
    this.teselas.length = 0; this.#indice.clear(); this.paginas = 0; this.#ultimaClave = NaN; this.#ultimo = -1;
  }
  #pagina(px: number, py: number): number {
    const clave = claveCasilla(px, py);
    if (clave === this.#ultimaClave) return this.#ultimo;
    this.#ultimaClave = clave; this.#ultimo = this.#indice.get(clave) ?? -1;
    return this.#ultimo;
  }
  celda(x: number, y: number): number {
    if ((x | 0) !== x || (y | 0) !== y) return -1;
    const pagina = this.#pagina(x >> 4, y >> 4);
    if (pagina < 0) return -1;
    const c = (pagina << 8) | ((y & 15) << 4) | (x & 15);
    return this.valores[0]![c]! > 0 ? c : -1;
  }
  chunkDe(celda: number): number { return celda >> 8; }
  campo(nombre: string): Col {
    const i = CAMPOS_PERCEPCION.indexOf(nombre as typeof CAMPOS_PERCEPCION[number]);
    if (i < 0) throw new Error(`Campo desconocido: ${nombre}`);
    return this.valores[i]!;
  }
  /** Copia las celdas del disco r = 7 de (cx, cy) que aún no estén capturadas. */
  capturarDisco(cx: number, cy: number, tileIn: TileLookup): void {
    if ((cx | 0) !== cx || (cy | 0) !== cy) return;
    this.#reservar(this.paginas + 4);   // una ventana de 15×15 toca a lo sumo 2×2 páginas
    const [terreno, bioma, comida, aguaPotable, madera, piedra, humedad, vegetacion, trafico] = this.valores as [Float64Array, Float64Array, Float64Array, Float64Array, Float64Array, Float64Array, Float64Array, Float64Array, Float64Array];
    for (let k = 0; k < CELDAS_VENTANA; k++) {
      if (!EN_DISCO[k]) continue;
      const x = cx + k % LADO_VENTANA - RADIUS, y = cy + ((k / LADO_VENTANA) | 0) - RADIUS;
      let pagina = this.#pagina(x >> 4, y >> 4);
      if (pagina < 0) {
        pagina = this.paginas++;
        this.paginaX[pagina] = x >> 4; this.paginaY[pagina] = y >> 4;
        this.#indice.set(claveCasilla(x >> 4, y >> 4), pagina);
        this.#ultimaClave = NaN;
      }
      const c = (pagina << 8) | ((y & 15) << 4) | (x & 15);
      if (this.#visto[c]) continue;
      this.#visto[c] = 1;
      const tile = tileIn(x, y);
      this.teselas[c] = tile;
      if (!tile) continue;
      terreno[c] = TERRENOS.indexOf(tile.terrain) + 1; bioma[c] = tile.biome ? BIOMAS.indexOf(tile.biome) + 1 : 0;
      comida[c] = tile.food ?? 0; aguaPotable[c] = tile.drinkingWater ?? 0; madera[c] = tile.wood ?? 0; piedra[c] = tile.stone ?? 0;
      humedad[c] = tile.moisture; vegetacion[c] = tile.vegetation; trafico[c] = tile.traffic ?? 0;
    }
  }
}

/**
 * Vista de lectura del mundo de la ola 1 para percibir (`CtxLectura` sin globales): el frente de todas las personas y
 * el terreno de los discos de quien percibe, copiados una vez por tick. La rehace otro hilo con `desde(descriptor)`.
 */
export class VistaMundo implements Lectura {
  readonly frente: FrenteMundo;
  readonly terreno: TerrenoMundo;
  /** Persona de cada slot al capturar (solo en el hilo que capturó). */
  personas: readonly Person[] = [];
  private constructor(d?: DescriptorVista) {
    this.frente = new FrenteMundo(d?.columnas);
    this.terreno = new TerrenoMundo(d);
    if (d) { this.frente.tick = d.tick; this.frente.alta = d.alta; }
  }
  static nueva(): VistaMundo { return new VistaMundo(); }
  static desde(d: DescriptorVista): VistaMundo { return new VistaMundo(d); }
  get tick(): number { return this.frente.tick; }

  /** Captura el frente de `personas` y el terreno alrededor de las de `discos` (slots). */
  capturar(personas: readonly Person[], tick: number, discos: Iterable<number>, tileIn: TileLookup): void {
    this.personas = personas;
    this.frente.capturar(personas, tick);
    this.terreno.reiniciar();
    for (const s of discos) this.terreno.capturarDisco(personas[s]!.x, personas[s]!.y, tileIn);
  }
  /** Columnas del cerebro del slot: observación, pesos heredados y plasticidad. */
  cerebro(slot: number, observacion: ArrayLike<number>, pesos: ArrayLike<number>, sesgo: ArrayLike<number>): void {
    (this.frente.datos.observacion as Float64Array).set(observacion, slot * COLUMNAS_CEREBRO.observacion);
    (this.frente.datos.politica as Float64Array).set(pesos, slot * COLUMNAS_CEREBRO.politica);
    (this.frente.datos.sesgo as Float64Array).set(sesgo, slot * COLUMNAS_CEREBRO.sesgo);
  }
  descriptor(): DescriptorVista {
    const buffer = (c: ArrayBufferView) => c.buffer as SharedArrayBuffer;
    return {
      tick: this.frente.tick, alta: this.frente.alta, paginas: this.terreno.paginas,
      columnas: Object.fromEntries(Object.entries(this.frente.datos).map(([n, c]) => [n, buffer(c)])),
      paginaX: buffer(this.terreno.paginaX), paginaY: buffer(this.terreno.paginaY), campos: this.terreno.valores.map(buffer),
    };
  }
}

// ── Percepción del paso ──────────────────────────────────────────────────────────────────────────────────

/** Fila de percepción de una persona: dónde leerla y sobre qué terreno se calculó. */
export interface FilaPercibida { readonly salida: PercepcionCpu; readonly fila: number; readonly terreno: TerrenoMundo; readonly personas: readonly Person[] }

/** Plazo de una tarjeta antes de recalcular su lote en CPU (ARQ-motor §3.1, B2). */
const PLAZO_PERCEPCION_MS = 2000;

/**
 * La percepción de las personas en un mundo: el lote de F2 (quienes pueden decidir en este tick, sobre el estado al
 * empezar la fase) y, para quien decide sin estar en él, una percepción suelta en el momento, con el mismo frente.
 */
export class PercepcionDelPaso {
  readonly vista = VistaMundo.nueva();
  readonly planes: Plan[] = planesPersonas(this.vista.terreno.campos, this.vista.frente.columnas);
  /** Quien percibe el lote; por defecto este mismo hilo. */
  percibidor: Percibidor = new PercibidorCpu(this.vista);
  #cpu = this.percibidor;
  #salida: PercepcionCpu | undefined;
  #fila = new Int32Array(0);
  #activa = false;
  readonly #suelta = { terreno: new TerrenoMundo(), salida: reservarPercepcion(1, this.planes) };

  /** F2. Antes de lanzar, `cerebro` pone las columnas del cerebro de los slots con plan `conCerebro`. */
  percibir(personas: readonly Person[], tick: number, lote: LotePercepcion, tileIn: TileLookup, cerebro: (vista: VistaMundo) => void): PercepcionCpu {
    this.vista.capturar(personas, tick, lote.slots, tileIn);
    cerebro(this.vista);
    let salida: Percepcion;
    try {
      this.percibidor.lanzar(lote, this.planes);
      salida = this.percibidor.esperar(PLAZO_PERCEPCION_MS);
    } catch (error) {
      if (!(error instanceof ErrorDispositivo) || this.percibidor === this.#cpu) throw error;
      this.#cpu.lanzar(lote, this.planes);
      salida = this.#cpu.esperar(PLAZO_PERCEPCION_MS);
    }
    if (!('ventana' in salida)) throw new Error('La percepción del lote no trae la ventana de pasos');
    this.#salida = salida as PercepcionCpu;
    if (this.#fila.length < personas.length) this.#fila = new Int32Array(Math.max(personas.length, 2 * this.#fila.length));
    this.#fila.fill(-1);
    for (let i = 0; i < lote.slots.length; i++) this.#fila[lote.slots[i]!] = i;
    this.#activa = true;
    return this.#salida;
  }
  /** Fin de la fase de personas: lo percibido deja de valer. */
  cerrar(): void { this.#activa = false; }

  /** La fila de `persona`: la del lote si sigue donde la capturó; si no, la percibe ahora sin cerebro (en búferes
   * propios si `reutilizar` es falso: una decisión anidada no pisa la de quien la llamó). */
  filaDe(personas: readonly Person[], tick: number, persona: Person, slot: number | undefined, tileIn: TileLookup, reutilizar = true): FilaPercibida {
    const { frente } = this.vista;
    if (!this.#activa || frente.tick !== tick) { this.vista.capturar(personas, tick, [], tileIn); this.#fila.fill(-1); this.#activa = false; slot = undefined; }
    if (slot === undefined || this.vista.personas[slot] !== persona) slot = this.vista.personas.indexOf(persona);
    if (slot < 0) throw new Error(`${persona.id} no está en el frente`);
    const fila = this.#fila[slot] ?? -1;
    if (fila >= 0 && frente.x[slot] === persona.x && frente.y[slot] === persona.y) return { salida: this.#salida!, fila, terreno: this.vista.terreno, personas: this.vista.personas };
    const { terreno, salida } = reutilizar ? this.#suelta : { terreno: new TerrenoMundo(), salida: reservarPercepcion(1, this.planes) };
    // Posición nueva desde la captura: el frente la sigue llevando a la antigua, así que se percibe con la de ahora.
    const x = frente.x[slot]!, y = frente.y[slot]!;
    frente.x[slot] = persona.x; frente.y[slot] = persona.y;
    terreno.reiniciar();
    terreno.capturarDisco(persona.x, persona.y, tileIn);
    percibirLote({ frente, terreno }, { tick, slots: Int32Array.of(slot), plan: Uint16Array.of(PLAN.sinCerebro) }, this.planes, salida);
    frente.x[slot] = x; frente.y[slot] = y;
    return { salida, fila: 0, terreno, personas: this.vista.personas };
  }
}

const porMundo = new WeakMap<object, PercepcionDelPaso>();
/** La percepción de personas de un mundo (una por mundo, creada al primer uso). */
export function percepcionDe(mundo: object): PercepcionDelPaso {
  let p = porMundo.get(mundo);
  if (!p) { p = new PercepcionDelPaso(); porMundo.set(mundo, p); }
  return p;
}
