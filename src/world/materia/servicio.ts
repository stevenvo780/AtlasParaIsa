/**
 * Servicio químico de un solo escritor (V23, carril Q; ARQ-materia §3.1):
 * - Registro append-only de sustancias (`SustanciaId` u32 ≥ 1, nunca reutilizado).
 * - Memo de reacciones `(a, b, nivelT)` con simetría en `(a, b)` para `b > 0`.
 * - En modo `'worker'` (hilo propio), los fallos de memo se encolan sin bloquear el paso y se publican en la
 *   barrera siguiente: primero se internan los productos nuevos y después se escribe la fila del memo.
 * - Códec binario compacto para `MateriaCheckpoint.sustancias` e invariante I4 registrada en `invariantes.ts`.
 */
import { existsSync } from 'node:fs';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { EPSILON_G, NE, S_GAS, TABLA } from '../../shared/naturaleza.js';
import { ATOMOS_POR_UNIDAD, ClaseSustancia, TIPOS, type SustanciaId } from '../../shared/materia.js';
import type { World } from '../index.js';
import { registrar, type Violacion } from '../invariantes.js';
import {
  NIVELES_T, tDeNivel,
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
  todasSustancias(): readonly Readonly<Sustancia>[];
  todasReacciones(): IterableIterator<FilaMemoQuimico>;
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

interface TrabajoPendiente {
  readonly seq: number;
  readonly clave: number;
  readonly a: SustanciaId;
  readonly b: SustanciaId;
  readonly nivelT: number;
}

export class ServicioQuimicoImpl implements ServicioQuimicoAuditable {
  readonly modo: ModoServicioQuimico;
  private readonly sustancias: (Readonly<Sustancia> | undefined)[] = [undefined]; // índice 0 reservado (ninguna)
  private readonly porClave = new Map<string, SustanciaId>();
  private readonly memo = new Map<number, FilaMemoQuimico>();
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
    if (this.modo === 'worker') this.arrancarWorker();
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
      if (this.cerrado) return;
      this.errorWorker = err;
      for (const [, p] of this.barreras) p.reject(err);
      this.barreras.clear();
    };
    worker.on('error', err => fallar(err instanceof Error ? err : new Error(String(err))));
    worker.on('exit', code => {
      if (!this.cerrado && code !== 0) fallar(new Error(`Worker de química terminó inesperadamente (código ${code}).`));
    });
    this.worker = worker;
  }

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
    const id = this.sustancias.length;
    if (id >= BASE_ID) throw new RangeError('Límite de SustanciaId alcanzado.');
    const sust = construirSustancia(id, canon);
    this.sustancias.push(sust);
    this.porClave.set(clave, id);
    return id;
  }

  sustancia(id: SustanciaId): Readonly<Sustancia> {
    if (!Number.isInteger(id) || id <= 0 || id >= this.sustancias.length) {
      throw new RangeError(`SustanciaId inexistente: ${id}`);
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
      const entradas = Object.freeze(
        b === 0
          ? [Object.freeze({ id: a, nu: 1 })]
          : a === b
            ? [Object.freeze({ id: a, nu: 2 })]
            : [Object.freeze({ id: a, nu: 1 }), Object.freeze({ id: b, nu: 1 })],
      );
      reac = Object.freeze({
        a, b, nivelT,
        entradas, salidas,
        dH: res.dH,
        ea: res.ea,
        catalisis: res.catalisis,
      });
    }
    this.memo.set(clave, Object.freeze({ a, b, nivelT, reaccion: reac }));
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

  totalSustancias(): number { return this.sustancias.length - 1; }
  totalMemo(): number { return this.memo.size; }
  pendientes(): number { return this.enCola.size; }
  todasSustancias(): readonly Readonly<Sustancia>[] { return this.sustancias.slice(1) as readonly Readonly<Sustancia>[]; }
  todasReacciones(): IterableIterator<FilaMemoQuimico> { return this.memo.values(); }

  async cerrar(): Promise<void> {
    if (this.cerrado) return;
    this.cerrado = true;
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

/** Codifica el registro append-only de sustancias en binario compacto con cabecera y CRC32. */
export function serializarSustancias(servicio: ServicioQuimicoAuditable): Uint8Array {
  const lista = servicio.todasSustancias();
  let cuerpoBytes = 0;
  for (const s of lista) {
    const nPares = s.enlaces.length >>> 1;
    if (nPares > 255) throw new RangeError(`Sustancia ${s.id} supera 255 pares de enlaces.`);
    cuerpoBytes += 1 + nPares * 2;
  }

  const out = new Uint8Array(CABECERA_BYTES + cuerpoBytes + PIE_BYTES);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, MAGIA_SUSTANCIAS, true);
  view.setUint16(4, VERSION_CODEC, true);
  view.setUint16(6, TIPOS.length, true);
  view.setUint32(8, lista.length, true);

  let pos = CABECERA_BYTES;
  for (const s of lista) {
    const nPares = s.enlaces.length >>> 1;
    out[pos++] = nPares;
    for (let i = 0; i < s.enlaces.length; i += 2) {
      const tipo = s.enlaces[i]!, cuenta = s.enlaces[i + 1]!;
      if (tipo > 255 || cuenta > 255) throw new RangeError(`Enlace fuera de u8 en sustancia ${s.id}: ${tipo}:${cuenta}`);
      out[pos++] = tipo;
      out[pos++] = cuenta;
    }
  }
  view.setUint32(pos, crc32(out, pos), true);
  return out;
}

/** Restaura un registro desde `MateriaCheckpoint.sustancias` conservando exactamente los `SustanciaId` 1..N. */
export function cargarSustancias(bytes: Uint8Array, opciones?: OpcionesServicioQuimico): ServicioQuimicoImpl {
  if (bytes.byteLength < CABECERA_BYTES + PIE_BYTES) {
    throw new Error('Punto de control de sustancias truncado.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIA_SUSTANCIAS) throw new Error('Cabecera inválida en sustancias.');
  if (view.getUint16(4, true) !== VERSION_CODEC) throw new Error(`Versión de códec no soportada: ${view.getUint16(4, true)}`);
  if (view.getUint16(6, true) !== TIPOS.length) {
    throw new Error(`Cantidad de TIPOS incompatible: ${view.getUint16(6, true)} ≠ ${TIPOS.length}`);
  }
  const posCrc = bytes.byteLength - PIE_BYTES;
  if (view.getUint32(posCrc, true) !== crc32(bytes, posCrc)) throw new Error('CRC32 inválido en sustancias.');

  const total = view.getUint32(8, true);
  const servicio = new ServicioQuimicoImpl(opciones);
  try {
    let pos = CABECERA_BYTES;
    for (let esperadoId = 1; esperadoId <= total; esperadoId++) {
      if (pos >= posCrc) throw new Error(`Fin inesperado al leer la sustancia ${esperadoId}.`);
      const nPares = bytes[pos++]!;
      if (pos + nPares * 2 > posCrc) throw new Error(`Sustancia ${esperadoId} truncada.`);
      const enlaces = new Uint16Array(nPares * 2);
      for (let i = 0; i < nPares * 2; i++) enlaces[i] = bytes[pos++]!;
      if (!esEnlaceCanonico(enlaces)) throw new Error(`Enlaces no canónicos al cargar la sustancia ${esperadoId}.`);
      const id = servicio.internar(enlaces);
      if (id !== esperadoId) throw new Error(`Sustancia duplicada o desordenada al cargar: esperado ${esperadoId}, recibido ${id}.`);
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

/**
 * Comprueba la invariante dura I4:
 * - Toda sustancia internada tiene enlaces canónicos, satura exactamente todas las valencias, tiene ≤ 8 átomos,
 *   grafo de elementos conexo, clase coherente con `realizable()`, energía entera exacta y propiedades finitas.
 * - Toda fila publicada del memo conserva exactamente los átomos por elemento, cumple dH = ΣE_sal − ΣE_ent,
 *   mejora la energía libre en más de EPSILON_G y es simétrica en `(a, b)` cuando `b > 0`.
 */
export function verificarI4(servicio: ServicioQuimicoAuditable, tick = 0): Violacion[] {
  const hallazgos: Violacion[] = [];
  const fallo = (detalle: string, contexto: Record<string, unknown>, esperado?: number, observado?: number): void => {
    if (hallazgos.length >= MAX_HALLAZGOS_I4) return;
    hallazgos.push({ id: 'materia.quimica.i4', gravedad: 'dura', tick, detalle, contexto, esperado, observado });
  };

  const total = servicio.totalSustancias();
  const clavesVistas = new Set<string>();

  for (let id = 1; id <= total; id++) {
    let s: Readonly<Sustancia>;
    try { s = servicio.sustancia(id); }
    catch { fallo('SustanciaId faltante en el registro contiguo.', { id }); continue; }

    if (s.id !== id) fallo('Identificador de sustancia incoherente.', { id }, id, s.id);
    if (!esEnlaceCanonico(s.enlaces)) fallo('Vector de enlaces no canónico.', { id });
    const clave = claveEnlaces(s.enlaces);
    if (clavesVistas.has(clave)) fallo('Vector de enlaces duplicado en el registro.', { id, clave });
    clavesVistas.add(clave);

    const atomos = atomosDeEnlaces(s.enlaces);
    if (!atomos) {
      fallo('Sustancia no saturada o supera 8 átomos.', { id, clave });
      continue;
    }
    let sumaAtomos = 0;
    let masaEsperada = 0;
    for (let e = 0; e < NE; e++) {
      sumaAtomos += atomos[e]!;
      masaEsperada += atomos[e]! * TABLA[e]!.masa;
      if (s.atomos[e] !== atomos[e]) fallo('Vector de átomos incoherente.', { id, elemento: e }, atomos[e], s.atomos[e]);
    }
    if (sumaAtomos < 1 || sumaAtomos > ATOMOS_POR_UNIDAD) {
      fallo('Cantidad total de átomos fuera de [1, 8].', { id }, ATOMOS_POR_UNIDAD, sumaAtomos);
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
    if (!Number.isInteger(p.color) || p.color < 0 || p.color > 0xffffff) {
      fallo('Color RGB fuera de rango.', { id, color: p.color });
    }
  }

  for (const fila of servicio.todasReacciones()) {
    const r = fila.reaccion;
    if (r === null) continue;
    if (r.a !== fila.a || r.b !== fila.b || r.nivelT !== fila.nivelT) {
      fallo('Metadatos de fila de memo incoherentes.', { fila: { a: fila.a, b: fila.b, nivelT: fila.nivelT } });
      continue;
    }
    if (r.b > 0 && servicio.reaccion(r.b, r.a, r.nivelT) !== r) {
      fallo('Simetría de reaccion(a, b) rota en el memo.', { a: r.a, b: r.b, nivelT: r.nivelT });
    }
    const atomosIn = new Int32Array(NE);
    const atomosOut = new Int32Array(NE);
    let eIn = 0, eOut = 0, gasIn = 0, gasOut = 0;
    const T = tDeNivel(r.nivelT);

    for (const { id, nu } of r.entradas) {
      if (!Number.isSafeInteger(nu) || nu <= 0 || id <= 0 || id > total) {
        fallo('Entrada inválida en reacción.', { a: r.a, b: r.b, id, nu });
        continue;
      }
      const s = servicio.sustancia(id);
      for (let e = 0; e < NE; e++) atomosIn[e]! += s.atomos[e]! * nu;
      eIn += s.energia * nu;
      if (esGasA(s, T)) gasIn += nu;
    }
    for (const { id, nu } of r.salidas) {
      if (!Number.isSafeInteger(nu) || nu <= 0 || id <= 0 || id > total) {
        fallo('Salida inválida en reacción.', { a: r.a, b: r.b, id, nu });
        continue;
      }
      const s = servicio.sustancia(id);
      for (let e = 0; e < NE; e++) atomosOut[e]! += s.atomos[e]! * nu;
      eOut += s.energia * nu;
      if (esGasA(s, T)) gasOut += nu;
    }

    for (let e = 0; e < NE; e++) {
      if (atomosIn[e] !== atomosOut[e]) {
        fallo('La fila de memo no conserva átomos.', { a: r.a, b: r.b, nivelT: r.nivelT, elemento: e }, atomosIn[e], atomosOut[e]);
      }
    }
    const dHEsperado = eOut - eIn;
    if (!Number.isSafeInteger(r.dH) || r.dH !== dHEsperado) {
      fallo('dH de reacción incoherente con las energías.', { a: r.a, b: r.b, nivelT: r.nivelT }, dHEsperado, r.dH);
    }
    const dG = (eOut - T * S_GAS * gasOut) - (eIn - T * S_GAS * gasIn);
    if (!(dG < -EPSILON_G + 1e-6)) {
      fallo('La reacción publicada no baja la energía libre en más de ε.', { a: r.a, b: r.b, nivelT: r.nivelT, dG });
    }
    if (!Number.isFinite(r.ea) || r.ea < 0) fallo('Barrera ea inválida.', { a: r.a, b: r.b, ea: r.ea });
    if (r.catalisis !== -1 && r.catalisis !== 0 && r.catalisis !== 1 && r.catalisis !== 2) {
      fallo('Familia catalítica inválida.', { a: r.a, b: r.b, catalisis: r.catalisis });
    }
  }

  return hallazgos;
}

const serviciosPorMundo = new WeakMap<World, ServicioQuimicoAuditable>();

/** Asocia un `ServicioQuimico` a un `World` para que el muestreador compruebe I4 automáticamente. */
export function asociarServicioQuimico(mundo: World, servicio: ServicioQuimicoAuditable): () => void {
  serviciosPorMundo.set(mundo, servicio);
  return () => { if (serviciosPorMundo.get(mundo) === servicio) serviciosPorMundo.delete(mundo); };
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
      return servicio ? verificarI4(servicio, mundo.tick) : [];
    },
  });
}
