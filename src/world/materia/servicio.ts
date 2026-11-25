/**
 * Servicio químico de un solo escritor (V23, carril Q; ARQ-materia §3.1):
 * - Registro append-only de sustancias (`SustanciaId` u32 ≥ 1, nunca reutilizado) y memo de reacciones
 *   `(a, b, nivelT)`, simétrico en `(a, b)` para `b > 0`. Los dos viven en el hilo que crea el servicio, su único escritor.
 * - En modo `'worker'` solo `productos()` corre en un hilo propio: un fallo de memo se encola sin bloquear el paso y su
 *   resultado se publica en la barrera siguiente, primero los productos internados y después la fila. `'diferido'` hace
 *   lo mismo en el hilo actual y, con `esperarBarrera`, es el modo reproducible de un hilo; `'inmediato'` es el del
 *   laboratorio. Los tres dan las mismas reacciones.
 * - Códec binario para `MateriaCheckpoint.sustancias` e invariante I4 registrada en `invariantes.ts`.
 */
import { existsSync } from 'node:fs';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { EPSILON_G, NE, S_GAS, TABLA } from '../../shared/naturaleza.js';
import { ATOMOS_POR_REACCION, ClaseSustancia, TIPOS, type SustanciaId } from '../../shared/materia.js';
import type { World } from '../index.js';
import { registrar, type Violacion } from '../registro-invariantes.js';
import type { RegistroContenido } from '../motor/registro.js';
import {
  FAMILIAS_CATALITICAS, NIVELES_T, tDeNivel,
  type Reaccion, type ServicioQuimico, type Sustancia,
} from './tipos.js';
import {
  ContextoSolver, atomosDeEnlaces, claveEnlaces, construirSustancia,
  energiaSustancia, esEnlaceCanonico, esGasA, grafoElementosConexo,
  normalizarEnlaces, productos, realizable,
  type ResultadoProductos,
} from './quimica.js';

export type ModoServicioQuimico = 'worker' | 'diferido' | 'inmediato';

export interface OpcionesServicioQuimico {
  /** 'worker': hilo propio (ARQ-materia §3.1); 'diferido': misma semántica de barrera en el hilo actual; 'inmediato': síncrono para laboratorio. */
  modo?: ModoServicioQuimico;
  registroSustancias?: RegistroContenido;
}

export interface FilaMemoQuimico {
  readonly a: SustanciaId;
  readonly b: SustanciaId;
  readonly nivelT: number;
  readonly reaccion: Reaccion | null;
}

export interface ServicioQuimicoAuditable extends ServicioQuimico {
  readonly modo: ModoServicioQuimico;
  totalSustancias(): number;
  totalMemo(): number;
  pendientes(): number;
  /** Filas del memo en orden de publicación; solo crece. */
  filasMemo(): readonly FilaMemoQuimico[];
  publicarBarrera(): number;
  esperarBarrera(): Promise<number>;
  cerrar(): Promise<void>;
}

// Clave numérica exacta para (a, b, nivelT): a, b < 2²⁴ (16,7M sustancias) → clave < 2⁵² < Number.MAX_SAFE_INTEGER.
const BASE_ID = 16_777_216;
function claveMemo(a: SustanciaId, b: SustanciaId, nivelT: number): number {
  if (a >= BASE_ID || b >= BASE_ID) throw new RangeError(`SustanciaId supera la clave numérica de 24 bits: ${a}, ${b}`);
  return (a * BASE_ID + b) * NIVELES_T + nivelT;
}

function normalizarPar(a: SustanciaId, b: SustanciaId): readonly [SustanciaId, SustanciaId] {
  return b > 0 && a > b ? [b, a] : [a, b];
}

// ── Protocolo del worker de química ─────────────────────────────────────────────────────────────────────

type MensajeAlWorker =
  | { tipo: 'resolver'; seq: number; clave: number; a: SustanciaId; b: SustanciaId; nivelT: number; enlacesA: Uint16Array; enlacesB: Uint16Array | null }
  | { tipo: 'barrera'; id: number }
  | { tipo: 'cerrar' };

interface ResultadoWorker {
  readonly seq: number;
  readonly clave: number;
  readonly a: SustanciaId;
  readonly b: SustanciaId;
  readonly nivelT: number;
  readonly resultado: ResultadoProductos | null;
}

type MensajeDelWorker =
  | ({ tipo: 'resuelto' } & ResultadoWorker)
  | { tipo: 'barrera'; id: number };

if (!isMainThread && workerData?.role === 'carta-quimica') {
  const port = parentPort!;
  const ctx = new ContextoSolver();
  port.on('message', (msg: MensajeAlWorker) => {
    try {
      if (msg.tipo === 'cerrar') {
        port.close();
        return;
      }
      if (msg.tipo === 'barrera') {
        port.postMessage({ tipo: 'barrera', id: msg.id } satisfies MensajeDelWorker);
        return;
      }
      const sustA = construirSustancia(msg.a, msg.enlacesA);
      const sustB = msg.enlacesB ? construirSustancia(msg.b, msg.enlacesB) : null;
      const resultado = productos(sustA, sustB, msg.nivelT, ctx);
      port.postMessage({
        tipo: 'resuelto',
        seq: msg.seq,
        clave: msg.clave,
        a: msg.a,
        b: msg.b,
        nivelT: msg.nivelT,
        resultado,
      } satisfies MensajeDelWorker);
    } catch (error) {
      port.close();
      throw error;
    }
  });
}

// ── Implementación del servicio de un solo escritor ─────────────────────────────────────────────────────

/** Servicios de producción (worker o diferido) vivos que ningún mundo comprueba: I4 los denuncia. */
const sinAsociar = new Set<ServicioQuimicoAuditable>();

interface TrabajoPendiente {
  readonly seq: number;
  readonly clave: number;
  readonly a: SustanciaId;
  readonly b: SustanciaId;
  readonly nivelT: number;
}

export class ServicioQuimicoImpl implements ServicioQuimicoAuditable {
  readonly modo: ModoServicioQuimico;
  private readonly registroSustancias: RegistroContenido | undefined;
  private readonly sustancias: (Readonly<Sustancia> | undefined)[] = [undefined]; // índice 0 reservado (ninguna)
  private readonly porClave = new Map<string, SustanciaId>();
  private readonly memo = new Map<number, FilaMemoQuimico>();
  private readonly filas: FilaMemoQuimico[] = [];
  private readonly enCola = new Set<number>();
  private readonly colaLocal: TrabajoPendiente[] = [];
  private readonly listos: ResultadoWorker[] = [];
  private readonly ctxLocal = new ContextoSolver();
  private seq = 0;
  private worker: Worker | null = null;
  private errorWorker: Error | null = null;
  private cerrado = false;
  private barreraSeq = 0;
  private readonly barreras = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();

  constructor(opciones: OpcionesServicioQuimico = {}) {
    this.modo = opciones.modo ?? 'worker';
    this.registroSustancias = opciones.registroSustancias;
    if (this.modo === 'worker') this.arrancarWorker();
    if (this.modo !== 'inmediato') sinAsociar.add(this);
  }

  private arrancarWorker(): void {
    let moduleURL = new URL('./servicio.js', import.meta.url);
    const sourceLoader = new URL(import.meta.url).pathname.endsWith('.ts');
    if (sourceLoader && !existsSync(moduleURL)) moduleURL = new URL('./servicio.ts', import.meta.url);
    const worker = new Worker(`
      const { workerData } = require('node:worker_threads');
      (async () => {
        if (workerData.loaderURL) (await import(workerData.loaderURL)).register();
        await import(workerData.moduleURL);
      })().catch(error => { setImmediate(() => { throw error; }); });
    `, {
      eval: true,
      execArgv: [],
      name: 'carta-quimica',
      workerData: {
        role: 'carta-quimica',
        moduleURL: moduleURL.href,
        loaderURL: sourceLoader ? import.meta.resolve('tsx/esm/api') : undefined,
      },
    });
    worker.on('message', (msg: MensajeDelWorker) => {
      if (msg.tipo === 'resuelto') {
        this.listos.push(msg);
      } else {
        const espera = this.barreras.get(msg.id);
        if (espera) {
          this.barreras.delete(msg.id);
          espera.resolve();
        }
      }
    });
    const fallar = (err: Error) => {
      if (this.cerrado || this.errorWorker) return;
      this.errorWorker = err;
      for (const [, p] of this.barreras) p.reject(err);
      this.barreras.clear();
    };
    worker.on('error', err => fallar(err instanceof Error ? err : new Error(String(err))));
    worker.on('exit', code => fallar(new Error(`El worker de química terminó sin cerrar el servicio (código ${code}).`)));
    this.worker = worker;
  }

  estaCerrado(): boolean { return this.cerrado; }

  private comprobarVivo(): void {
    if (this.errorWorker) throw this.errorWorker;
    if (this.cerrado) throw new Error('El servicio químico ya está cerrado.');
  }

  /** Interna un vector de enlaces saturado (idempotente). Solo crece y nunca reutiliza ids. */
  internar(enlaces: Uint16Array): SustanciaId {
    this.comprobarVivo();
    const canon = normalizarEnlaces(enlaces);
    const clave = claveEnlaces(canon);
    const existente = this.porClave.get(clave);
    if (existente !== undefined) return existente;
    const registro = this.registroSustancias;
    if (registro) {
      const id = 1 + registro.insertar(new Uint8Array(canon.buffer, canon.byteOffset, canon.byteLength));
      this.sustancia(id);
      return id;
    }
    const id = this.sustancias.length;
    if (id >= BASE_ID) throw new RangeError('Límite de SustanciaId alcanzado.');
    const sust = construirSustancia(id, canon);
    this.sustancias.push(sust);
    this.porClave.set(clave, id);
    return id;
  }

  sustancia(id: SustanciaId): Readonly<Sustancia> {
    if (!Number.isInteger(id) || id <= 0 || id >= BASE_ID ||
      id >= this.sustancias.length && id > this.totalSustancias()) {
      throw new RangeError(`SustanciaId inexistente: ${id}`);
    }
    // Cada dueño memoriza las sustancias que lee; la identidad de los lotes pertenece al registro compartido.
    while (this.sustancias.length <= id) {
      const siguiente = this.sustancias.length;
      const bytes = this.registroSustancias!.leer(siguiente - 1)!;
      const enlaces = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Uint16Array.BYTES_PER_ELEMENT);
      this.sustancias.push(construirSustancia(siguiente, enlaces));
      this.porClave.set(claveEnlaces(enlaces), siguiente);
    }
    return this.sustancias[id]!;
  }

  /**
   * Consulta el memo de reacciones. Simétrica en `(a, b)` si `b > 0` (`b === 0` es unaria).
   * En modo `'worker'` o `'diferido'`, un fallo encola la pareja y devuelve `undefined` hasta la barrera siguiente.
   */
  reaccion(a: SustanciaId, b: SustanciaId, nivelT: number): Reaccion | null | undefined {
    this.comprobarVivo();
    if (!Number.isInteger(nivelT) || nivelT < 0 || nivelT >= NIVELES_T) {
      throw new RangeError(`nivelT fuera de rango [0, ${NIVELES_T}): ${nivelT}`);
    }
    const sustA = this.sustancia(a);
    const sustB = b === 0 ? null : this.sustancia(b);
    const [a1, b1] = normalizarPar(a, b);
    const clave = claveMemo(a1, b1, nivelT);
    const fila = this.memo.get(clave);
    if (fila !== undefined) return fila.reaccion;

    if (this.modo === 'inmediato') {
      const sA = a1 === a ? sustA : sustB!;
      const sB = b1 === 0 ? null : (b1 === b ? sustB! : sustA);
      const res = productos(sA, sB, nivelT, this.ctxLocal);
      return this.publicarFila(clave, a1, b1, nivelT, res);
    }

    if (!this.enCola.has(clave)) {
      this.enCola.add(clave);
      const seq = ++this.seq;
      if (this.modo === 'worker') {
        const sA = a1 === a ? sustA : sustB!;
        const sB = b1 === 0 ? null : (b1 === b ? sustB! : sustA);
        this.worker!.postMessage({
          tipo: 'resolver',
          seq,
          clave,
          a: a1,
          b: b1,
          nivelT,
          enlacesA: sA.enlaces,
          enlacesB: sB ? sB.enlaces : null,
        } satisfies MensajeAlWorker);
      } else {
        this.colaLocal.push({ seq, clave, a: a1, b: b1, nivelT });
      }
    }
    return undefined;
  }

  private publicarFila(
    clave: number,
    a: SustanciaId,
    b: SustanciaId,
    nivelT: number,
    res: ResultadoProductos | null,
  ): Reaccion | null {
    let reac: Reaccion | null = null;
    if (res !== null) {
      // Regla de visibilidad (ARQ-materia §3.1): internar TODOS los productos ANTES de publicar la fila del memo.
      const salidas = Object.freeze(res.productos.map(p => Object.freeze({ id: this.internar(p.enlaces), nu: p.nu })));
      // Los coeficientes los elige Q (contrato de `Reaccion`, enmienda 1): [1, 0] sola, [p, 0] a + a, [p, q] a + b.
      const [p, q] = res.nu;
      const entradas = Object.freeze(
        b === 0 || a === b
          ? [Object.freeze({ id: a, nu: p })]
          : [Object.freeze({ id: a, nu: p }), Object.freeze({ id: b, nu: q })],
      );
      reac = Object.freeze({
        a, b, nivelT,
        entradas, salidas,
        dH: res.dH,
        ea: res.ea,
        catalisis: res.catalisis,
        paresCatalisis: res.paresCatalisis,
      });
    }
    const fila = Object.freeze({ a, b, nivelT, reaccion: reac });
    this.memo.set(clave, fila);
    this.filas.push(fila);
    this.enCola.delete(clave);
    return reac;
  }

  /**
   * Publica en la barrera todos los resultados listos (en `'diferido'`, resuelve antes la cola pendiente).
   * En `'worker'`, no bloquea: publica solo lo ya resuelto por el hilo químico en orden determinista `seq`.
   */
  publicarBarrera(): number {
    this.comprobarVivo();
    if (this.modo === 'diferido' && this.colaLocal.length > 0) {
      const lote = this.colaLocal.splice(0, this.colaLocal.length);
      for (const t of lote) {
        const sA = this.sustancia(t.a);
        const sB = t.b === 0 ? null : this.sustancia(t.b);
        const resultado = productos(sA, sB, t.nivelT, this.ctxLocal);
        this.listos.push({ seq: t.seq, clave: t.clave, a: t.a, b: t.b, nivelT: t.nivelT, resultado });
      }
    }
    if (this.listos.length === 0) return 0;
    const lote = this.listos.splice(0, this.listos.length);
    lote.sort((x, y) => x.seq - y.seq);
    let publicados = 0;
    for (const item of lote) {
      if (!this.memo.has(item.clave)) {
        this.publicarFila(item.clave, item.a, item.b, item.nivelT, item.resultado);
        publicados++;
      } else {
        this.enCola.delete(item.clave);
      }
    }
    return publicados;
  }

  /** Espera a que el worker termine todo lo encolado hasta ahora y lo publica atómicamente en la barrera. */
  async esperarBarrera(): Promise<number> {
    this.comprobarVivo();
    if (this.modo === 'worker') {
      const id = ++this.barreraSeq;
      await new Promise<void>((resolve, reject) => {
        this.barreras.set(id, { resolve, reject });
        this.worker!.postMessage({ tipo: 'barrera', id } satisfies MensajeAlWorker);
      });
    }
    return this.publicarBarrera();
  }

  totalSustancias(): number { return this.registroSustancias?.n ?? this.sustancias.length - 1; }
  totalMemo(): number { return this.memo.size; }
  pendientes(): number { return this.enCola.size; }
  filasMemo(): readonly FilaMemoQuimico[] { return this.filas; }

  async cerrar(): Promise<void> {
    if (this.cerrado) return;
    this.cerrado = true;
    sinAsociar.delete(this);
    for (const [, p] of this.barreras) p.reject(new Error('Servicio químico cerrado.'));
    this.barreras.clear();
    if (this.worker) {
      const w = this.worker;
      this.worker = null;
      try { w.postMessage({ tipo: 'cerrar' } satisfies MensajeAlWorker); } catch { /* ya cerrado */ }
      await w.terminate();
    }
  }
}

export function crearServicioQuimico(opciones?: OpcionesServicioQuimico): ServicioQuimicoImpl {
  return new ServicioQuimicoImpl(opciones);
}

// ── Serialización binaria del registro (`MateriaCheckpoint.sustancias`) ─────────────────────────────────

const MAGIA_SUSTANCIAS = 0x53555351; // 'QSUS' en little-endian
const VERSION_CODEC = 1;
const CABECERA_BYTES = 12;
const PIE_BYTES = 4;

const TABLA_CRC32 = (() => {
  const tabla = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabla[i] = c >>> 0;
  }
  return tabla;
})();

function crc32(datos: Uint8Array, fin: number): number {
  let c = 0xffffffff;
  for (let i = 0; i < fin; i++) c = TABLA_CRC32[(c ^ datos[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Codifica el registro de sustancias: cabecera (magia, versión, TIPOS.length, N), por sustancia sus pares [tipo, cuenta]
 * en u8 más su clase (u8) y su energía (i32), y un CRC32 al final. La clase y la energía no hacen falta para
 * reconstruir la sustancia: están para que cargar con otra química (otra TABLA, otras constantes de red) falle en vez
 * de cambiar en silencio la energía de cuantos que ya están en los lotes (I2).
 */
export function serializarSustancias(servicio: ServicioQuimicoAuditable): Uint8Array {
  const total = servicio.totalSustancias();
  let cuerpoBytes = 0;
  for (let id = 1; id <= total; id++) cuerpoBytes += 1 + servicio.sustancia(id).enlaces.length + 1 + 4;

  const out = new Uint8Array(CABECERA_BYTES + cuerpoBytes + PIE_BYTES);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, MAGIA_SUSTANCIAS, true);
  view.setUint16(4, VERSION_CODEC, true);
  view.setUint16(6, TIPOS.length, true);
  view.setUint32(8, total, true);

  let pos = CABECERA_BYTES;
  for (let id = 1; id <= total; id++) {
    const s = servicio.sustancia(id);
    const nPares = s.enlaces.length >>> 1;
    if (nPares > 255) throw new RangeError(`Sustancia ${s.id} supera 255 pares de enlaces.`);
    out[pos++] = nPares;
    for (let i = 0; i < s.enlaces.length; i++) {
      if (s.enlaces[i]! > 255) throw new RangeError(`Enlace fuera de u8 en sustancia ${s.id}.`);
      out[pos++] = s.enlaces[i]!;
    }
    out[pos++] = s.clase;
    view.setInt32(pos, s.energia, true);
    pos += 4;
  }
  view.setUint32(pos, crc32(out, pos), true);
  return out;
}

/** Restaura un registro desde `MateriaCheckpoint.sustancias` con los mismos `SustanciaId` 1..N, la misma clase y la
 * misma energía; cualquier diferencia, o un bit cambiado, es un error. */
export function cargarSustancias(bytes: Uint8Array, opciones?: OpcionesServicioQuimico): ServicioQuimicoImpl {
  if (bytes.byteLength < CABECERA_BYTES + PIE_BYTES) {
    throw new Error('Punto de control de sustancias truncado.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const posCrc = bytes.byteLength - PIE_BYTES;
  if (view.getUint32(posCrc, true) !== crc32(bytes, posCrc)) throw new Error('CRC32 inválido en sustancias.');
  if (view.getUint32(0, true) !== MAGIA_SUSTANCIAS) throw new Error('Cabecera inválida en sustancias.');
  if (view.getUint16(4, true) !== VERSION_CODEC) throw new Error(`Versión de códec no soportada: ${view.getUint16(4, true)}`);
  if (view.getUint16(6, true) !== TIPOS.length) {
    throw new Error(`Cantidad de TIPOS incompatible: ${view.getUint16(6, true)} ≠ ${TIPOS.length}`);
  }

  const total = view.getUint32(8, true);
  const servicio = new ServicioQuimicoImpl(opciones);
  try {
    let pos = CABECERA_BYTES;
    for (let esperadoId = 1; esperadoId <= total; esperadoId++) {
      if (pos >= posCrc) throw new Error(`Fin inesperado al leer la sustancia ${esperadoId}.`);
      const nPares = bytes[pos++]!;
      if (pos + nPares * 2 + 5 > posCrc) throw new Error(`Sustancia ${esperadoId} truncada.`);
      const enlaces = bytes.slice(pos, pos + nPares * 2);
      pos += nPares * 2;
      const enlaces16 = Uint16Array.from(enlaces);
      if (!esEnlaceCanonico(enlaces16)) throw new Error(`Enlaces no canónicos al cargar la sustancia ${esperadoId}.`);
      const id = servicio.internar(enlaces16);
      if (id !== esperadoId) throw new Error(`Sustancia duplicada o desordenada al cargar: esperado ${esperadoId}, recibido ${id}.`);
      const s = servicio.sustancia(id);
      const clase = bytes[pos++]!, energia = view.getInt32(pos, true);
      pos += 4;
      if (s.clase !== clase || s.energia !== energia) {
        throw new Error(`Química incompatible con el punto de control en la sustancia ${id}: clase ${clase} → ${s.clase}, energía ${energia} → ${s.energia}.`);
      }
    }
    if (pos !== posCrc) throw new Error('Bytes sobrantes al final del punto de control de sustancias.');
    return servicio;
  } catch (error) {
    void servicio.cerrar();
    throw error;
  }
}

// ── Invariante I4 (ARQ-materia §7) y registro en `src/world/invariantes.ts` ─────────────────────────────

const MAX_HALLAZGOS_I4 = 64;
/** Sustancias y filas que revisa cada llamada del invariante registrado: primero las nuevas, luego en rueda. */
export const PRESUPUESTO_I4 = 1024;

type Fallo = (detalle: string, contexto: Record<string, unknown>, esperado?: number, observado?: number) => void;

function revisarSustancia(servicio: ServicioQuimicoAuditable, id: SustanciaId, claves: Map<string, SustanciaId>, fallo: Fallo): void {
  let s: Readonly<Sustancia>;
  try { s = servicio.sustancia(id); }
  catch { fallo('SustanciaId faltante en el registro contiguo.', { id }); return; }

  if (s.id !== id) fallo('Identificador de sustancia incoherente.', { id }, id, s.id);
  if (!esEnlaceCanonico(s.enlaces)) fallo('Vector de enlaces no canónico.', { id });
  const clave = claveEnlaces(s.enlaces);
  const previo = claves.get(clave);
  if (previo !== undefined && previo !== id) fallo('Vector de enlaces duplicado en el registro.', { id, previo, clave });
  claves.set(clave, id);

  const atomos = atomosDeEnlaces(s.enlaces);
  if (!atomos) {
    fallo('Sustancia no saturada o con más de 8 átomos.', { id, clave });
    return;
  }
  let masaEsperada = 0;
  for (let e = 0; e < NE; e++) {
    masaEsperada += atomos[e]! * TABLA[e]!.masa;
    if (s.atomos[e] !== atomos[e]) fallo('Vector de átomos incoherente.', { id, elemento: e }, atomos[e], s.atomos[e]);
  }
  if (!grafoElementosConexo(s.enlaces, atomos)) fallo('Grafo de elementos disconexo.', { id, clave });

  const claseEsperada = realizable(s.enlaces, atomos) ? ClaseSustancia.Molecula : ClaseSustancia.Unidad;
  if (s.clase !== claseEsperada) fallo('Clase de sustancia incoherente con realizable().', { id, clave }, claseEsperada, s.clase);
  const eEsperada = energiaSustancia(s.enlaces, s.clase);
  if (!Number.isSafeInteger(s.energia) || s.energia !== eEsperada) {
    fallo('Energía de sustancia incoherente o no entera.', { id, clave }, eEsperada, s.energia);
  }
  if (!Number.isFinite(s.masa) || Math.abs(s.masa - masaEsperada) > 1e-9) {
    fallo('Masa de sustancia incoherente.', { id, clave }, masaEsperada, s.masa);
  }

  const p = s.prop;
  for (const campo of ['r', 'dMedia', 'tFusion', 'tEbullicion', 'qOxidacion', 'dureza', 'tenacidad', 'flexibilidad', 'polaridad', 'densidad'] as const) {
    if (!Number.isFinite(p[campo])) fallo('Propiedad no finita.', { id, campo, valor: p[campo] });
  }
  for (const campo of ['dureza', 'tenacidad', 'flexibilidad', 'polaridad'] as const) {
    if (p[campo] < 0 || p[campo] > 1) fallo('Propiedad unitaria fuera de [0, 1].', { id, campo, valor: p[campo] });
  }
  if (p.tFusion <= 0 || p.tEbullicion <= p.tFusion || p.densidad <= 0 || p.qOxidacion < 0) {
    fallo('Rango físico inválido en propiedades.', { id, tFusion: p.tFusion, tEbullicion: p.tEbullicion, densidad: p.densidad, qOxidacion: p.qOxidacion });
  }
  if (!Number.isInteger(p.color) || p.color < 0 || p.color > 0xffffff) fallo('Color RGB fuera de rango.', { id, color: p.color });
}

function revisarFila(servicio: ServicioQuimicoAuditable, fila: FilaMemoQuimico, fallo: Fallo): void {
  const r = fila.reaccion;
  if (r === null) return;
  if (r.a !== fila.a || r.b !== fila.b || r.nivelT !== fila.nivelT) {
    fallo('Metadatos de fila de memo incoherentes.', { fila: { a: fila.a, b: fila.b, nivelT: fila.nivelT } });
    return;
  }
  if (r.b > 0 && servicio.reaccion(r.b, r.a, r.nivelT) !== r) {
    fallo('Simetría de reaccion(a, b) rota en el memo.', { a: r.a, b: r.b, nivelT: r.nivelT });
  }
  const total = servicio.totalSustancias();
  const T = tDeNivel(r.nivelT);
  const atomosNetos = new Int32Array(NE);
  let eNeta = 0, gasNeto = 0;
  const sumar = (lado: Reaccion['entradas'], signo: 1 | -1, nombre: string): boolean => {
    for (const { id, nu } of lado) {
      if (!Number.isSafeInteger(nu) || nu <= 0 || !Number.isSafeInteger(id) || id <= 0 || id > total) {
        fallo(`${nombre} inválida en reacción.`, { a: r.a, b: r.b, id, nu });
        return false;
      }
      const s = servicio.sustancia(id);
      for (let e = 0; e < NE; e++) atomosNetos[e]! += signo * s.atomos[e]! * nu;
      eNeta += signo * s.energia * nu;
      if (esGasA(s, T)) gasNeto += signo * nu;
    }
    return true;
  };
  if (!sumar(r.salidas, 1, 'Salida') || !sumar(r.entradas, -1, 'Entrada')) return;
  // Entradas: a sola con nu 1, a + a con nu ≥ 2, a + b con nu ≥ 1 cada una, en ≤ ATOMOS_POR_REACCION átomos; ningún
  // reactivo sale intacto (sobraría).
  const ids = r.entradas.map(x => x.id), nus = r.entradas.map(x => x.nu);
  const formaOk = r.b === 0 ? ids.length === 1 && ids[0] === r.a && nus[0] === 1
    : r.a === r.b ? ids.length === 1 && ids[0] === r.a && nus[0]! >= 2
      : ids.length === 2 && ids[0] === r.a && ids[1] === r.b;
  let atomosVez = 0;
  for (const { id, nu } of r.entradas) atomosVez += nu * servicio.sustancia(id).atomos.reduce((t, n) => t + n, 0);
  if (!formaOk || atomosVez > ATOMOS_POR_REACCION) {
    fallo('Entradas de reacción fuera del contrato (coeficientes o átomos por vez).', { a: r.a, b: r.b, nivelT: r.nivelT, entradas: r.entradas, atomosVez });
  }
  if (r.salidas.some(x => x.id === r.a || x.id === r.b)) {
    fallo('Un reactivo sale intacto de su reacción.', { a: r.a, b: r.b, nivelT: r.nivelT });
  }

  for (let e = 0; e < NE; e++) {
    if (atomosNetos[e] !== 0) fallo('La fila de memo no conserva átomos.', { a: r.a, b: r.b, nivelT: r.nivelT, elemento: e }, 0, atomosNetos[e]);
  }
  if (!Number.isSafeInteger(r.dH) || r.dH !== eNeta) {
    fallo('dH de reacción incoherente con las energías.', { a: r.a, b: r.b, nivelT: r.nivelT }, eNeta, r.dH);
  }
  // Con los mismos gases a ambos lados la comparación es entera y exacta, como en `productos`.
  const dG = eNeta - T * S_GAS * gasNeto;
  if (!(dG < -EPSILON_G + (gasNeto === 0 ? 0 : 1e-9))) {
    fallo('La reacción publicada no baja la energía libre en más de ε.', { a: r.a, b: r.b, nivelT: r.nivelT, dG });
  }
  if (!Number.isFinite(r.ea) || r.ea < 0 || r.ea < r.dH) fallo('Barrera ea inválida o menor que dH.', { a: r.a, b: r.b, ea: r.ea, dH: r.dH });
  if (!(Number.isInteger(r.catalisis) && r.catalisis >= -1 && r.catalisis < FAMILIAS_CATALITICAS)) {
    fallo('Familia catalítica inválida.', { a: r.a, b: r.b, catalisis: r.catalisis });
  }
  // Enmienda 3: los pares del enlace que decide la familia, 1–3, y 0 exactamente cuando no hay familia.
  if (!(Number.isInteger(r.paresCatalisis) && r.paresCatalisis >= 0 && r.paresCatalisis <= 3 && (r.paresCatalisis === 0) === (r.catalisis === -1))) {
    fallo('Pares de catálisis inválidos.', { a: r.a, b: r.b, catalisis: r.catalisis, paresCatalisis: r.paresCatalisis });
  }
}

function recolector(tick: number): { hallazgos: Violacion[]; fallo: Fallo } {
  const hallazgos: Violacion[] = [];
  const fallo: Fallo = (detalle, contexto, esperado, observado) => {
    if (hallazgos.length < MAX_HALLAZGOS_I4) hallazgos.push({ id: 'materia.quimica.i4', gravedad: 'dura', tick, detalle, contexto, esperado, observado });
  };
  return { hallazgos, fallo };
}

/**
 * Invariante dura I4 sobre todo el registro y todo el memo (laboratorio y pruebas):
 * - Toda sustancia tiene enlaces canónicos y únicos, satura sus valencias con ≤ 8 átomos, tiene el grafo de elementos
 *   conexo, la clase de `realizable()`, la energía entera de su vector y propiedades finitas y en rango.
 * - Toda fila publicada conserva los átomos, cumple dH = ΣE_salidas − ΣE_entradas, baja la energía libre en más de ε,
 *   tiene ea ≥ max(0, dH) y es simétrica en (a, b) cuando b > 0.
 */
export function verificarI4(servicio: ServicioQuimicoAuditable, tick = 0): Violacion[] {
  const { hallazgos, fallo } = recolector(tick);
  const claves = new Map<string, SustanciaId>();
  for (let id = 1; id <= servicio.totalSustancias(); id++) revisarSustancia(servicio, id, claves, fallo);
  for (const fila of servicio.filasMemo()) revisarFila(servicio, fila, fallo);
  return hallazgos;
}

/** Por dónde va el invariante registrado en un servicio: lo nuevo se revisa entero; con el presupuesto que sobra, la rueda
 * vuelve sobre lo antiguo, así que todo se revisa otra vez cada ⌈N/PRESUPUESTO_I4⌉ llamadas. */
interface CursorI4 { sustancia: number; fila: number; ruedaSustancia: number; ruedaFila: number; claves: Map<string, SustanciaId> }
const cursores = new WeakMap<ServicioQuimicoAuditable, CursorI4>();

/** I4 con coste acotado (≤ PRESUPUESTO_I4 sustancias y filas por llamada), para el muestreador del mundo. */
export function verificarI4Acotado(servicio: ServicioQuimicoAuditable, tick = 0): Violacion[] {
  const { hallazgos, fallo } = recolector(tick);
  let c = cursores.get(servicio);
  if (!c) cursores.set(servicio, c = { sustancia: 1, fila: 0, ruedaSustancia: 1, ruedaFila: 0, claves: new Map() });

  const total = servicio.totalSustancias();
  const finNuevas = Math.min(total + 1, c.sustancia + PRESUPUESTO_I4);
  for (let id = c.sustancia; id < finNuevas; id++) revisarSustancia(servicio, id, c.claves, fallo);
  for (let n = PRESUPUESTO_I4 - (finNuevas - c.sustancia); n > 0 && c.sustancia > 1; n--) {
    if (c.ruedaSustancia >= c.sustancia) c.ruedaSustancia = 1;
    revisarSustancia(servicio, c.ruedaSustancia++, c.claves, fallo);
  }
  c.sustancia = finNuevas;

  const filas = servicio.filasMemo();
  const finFilas = Math.min(filas.length, c.fila + PRESUPUESTO_I4);
  for (let i = c.fila; i < finFilas; i++) revisarFila(servicio, filas[i]!, fallo);
  for (let n = PRESUPUESTO_I4 - (finFilas - c.fila); n > 0 && c.fila > 0; n--) {
    if (c.ruedaFila >= c.fila) c.ruedaFila = 0;
    revisarFila(servicio, filas[c.ruedaFila++]!, fallo);
  }
  c.fila = finFilas;
  return hallazgos;
}

const serviciosPorMundo = new WeakMap<World, ServicioQuimicoAuditable>();

/** Asocia un `ServicioQuimico` a un `World` para que el muestreador compruebe I4; devuelve la desasociación. */
export function asociarServicioQuimico(mundo: World, servicio: ServicioQuimicoAuditable): () => void {
  serviciosPorMundo.set(mundo, servicio);
  sinAsociar.delete(servicio);
  return () => {
    if (serviciosPorMundo.get(mundo) !== servicio) return;
    serviciosPorMundo.delete(mundo);
    if (servicio instanceof ServicioQuimicoImpl && servicio.modo !== 'inmediato' && !servicio.estaCerrado()) sinAsociar.add(servicio);
  };
}

if (isMainThread || workerData?.role !== 'carta-quimica') {
  registrar({
    id: 'materia.quimica.i4',
    carril: 'Q',
    gravedad: 'dura',
    cadaTicks: 60,
    alcance: 'global',
    comprobar: mundo => {
      const servicio = serviciosPorMundo.get(mundo);
      if (servicio) return verificarI4Acotado(servicio, mundo.tick);
      // Un servicio de producción que ningún mundo comprueba dejaría I4 sin comprobar en silencio.
      return sinAsociar.size === 0 ? [] : [{
        id: 'materia.quimica.i4', gravedad: 'dura', tick: mundo.tick,
        detalle: 'Hay un servicio químico vivo sin asociar a ningún mundo: falta asociarServicioQuimico().',
        contexto: { sinAsociar: sinAsociar.size },
      }];
    },
  });
}
