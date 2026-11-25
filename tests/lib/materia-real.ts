/**
 * Piezas reales de materia para las pruebas de P y L (enmienda 1): la arena de A (`ArenaLotes`) y la química de Q
 * (`crearServicioQuimico`, modo inmediato, con las sustancias base del laboratorio). Solo son dobles la memoria paginada
 * en SAB crecibles y el terreno (dueño por chunk), que pone M1 y no existe en esta rama; la piscina de workers que corre
 * `manejador` de paso-worker es de M1 y abre en cada hilo la misma arena real sobre los mismos SAB.
 */
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { CAPACIDAD_ATOMO, NE } from '../../src/shared/naturaleza.js';
import type { SustanciaId } from '../../src/shared/materia.js';
import { ArenaLotes, LOTES_POR_BLOQUE, type MemoriaMateria } from '../../src/world/materia/arena.js';
import { cargarSustancias, crearServicioQuimico, serializarSustancias, type ServicioQuimicoImpl } from '../../src/world/materia/servicio.js';
import { Rol, libroVacio, type Libro, type LoteRef, type ServicioQuimico } from '../../src/world/materia/tipos.js';
import type { CtxPaso } from '../../src/world/materia/paso.js';
import { manejador, type TrabajoPaso } from '../../src/world/materia/paso-worker.js';
import type { Elements } from '../../src/world/soa/arena.js';
import { registrarSustanciasBase } from '../../scripts/lab-materia.mjs';

/** mulberry32: el azar sembrado de las pruebas. */
export function azarSembrado(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Memoria paginada de prueba (M1) ──────────────────────────────────────────────────────────────────────

type SAB = SharedArrayBuffer & { grow(bytes: number): void };
const SAB = SharedArrayBuffer as unknown as new(bytes: number, opciones: { maxByteLength: number }) => SAB;
type Columna = { memoria: SAB; ancho: number; fill: number };
type ConstructorColumna<T extends Elements> = { new (buffer: SharedArrayBuffer): T; readonly BYTES_PER_ELEMENT: number };
export type DescriptorMemoria = { control: Int32Array; libres: Int32Array; columnas: Map<string, Columna>; maximo: number };

const enteros = (cantidad: number) => new Int32Array(new SharedArrayBuffer(cantidad * Int32Array.BYTES_PER_ELEMENT));

/** Columnas crecibles en SAB (hasta `maximo` páginas), reservas con CAS y crecimiento en barrera, como la `PageArena` de M1. */
export class MemoriaPrueba implements MemoriaMateria {
  readonly descriptor: DescriptorMemoria;
  constructor(d: DescriptorMemoria | number) {
    this.descriptor = typeof d === 'number' ? { control: enteros(3), libres: enteros(d), columnas: new Map(), maximo: d } : d;
  }

  field<T extends Elements>(nombre: string, Tipo: ConstructorColumna<T>, perPage: number, fill = 0): T {
    assert.equal(fill, 0, 'el doble solo amplía columnas inicializadas a cero');
    const { columnas, control } = this.descriptor, ancho = Tipo.BYTES_PER_ELEMENT * perPage;
    let columna = columnas.get(nombre);
    if (!columna) {
      const memoria = new SAB(Atomics.load(control, 2) * ancho, { maxByteLength: this.descriptor.maximo * ancho });
      columna = { memoria, ancho, fill };
      columnas.set(nombre, columna);
    }
    assert.equal(columna.ancho, ancho);
    assert.equal(columna.fill, fill);
    return new Tipo(columna.memoria);
  }

  get slots(): number { return Atomics.load(this.descriptor.control, 0); }

  reserve(): number {
    const { control, libres } = this.descriptor;
    for (;;) {
      const disponibles = Atomics.load(control, 1);
      if (disponibles === 0) break;
      if (Atomics.compareExchange(control, 1, disponibles, disponibles - 1) === disponibles) return libres[disponibles - 1]!;
    }
    const slot = Atomics.add(control, 0, 1);
    assert.ok(slot < Atomics.load(control, 2), 'el coordinador reserva capacidad en barrera');
    return slot;
  }

  release(slot: number): void {
    const { control, libres } = this.descriptor;
    libres[Atomics.add(control, 1, 1)] = slot;
  }

  crecer(capacidad: number): void {
    const { columnas, control } = this.descriptor;
    for (const { memoria, ancho } of columnas.values()) memoria.grow(capacidad * ancho);
    Atomics.store(control, 2, capacidad);
  }
}

/** Lo que comparten los hilos: las tres memorias y el dueño de cada chunk (chunk i del hilo i % hilos). */
export interface MemoriaArena {
  lotes: DescriptorMemoria; desborde: DescriptorMemoria; paginas: DescriptorMemoria; duenoChunk: Int16Array;
}

export function memoriaDe(chunks: number, capacidad: number, hilos = 1): MemoriaArena {
  const bloques = Math.ceil(capacidad / LOTES_POR_BLOQUE) * LOTES_POR_BLOQUE;
  const lotes = new MemoriaPrueba(bloques), desborde = new MemoriaPrueba(capacidad * 4), paginas = new MemoriaPrueba(chunks);
  lotes.crecer(bloques);
  desborde.crecer(capacidad * 4);
  paginas.crecer(chunks);
  const duenoChunk = new Int16Array(new SharedArrayBuffer(chunks * Int16Array.BYTES_PER_ELEMENT));
  for (let i = 0; i < chunks; i++) duenoChunk[paginas.reserve()] = i % hilos;
  return { lotes: lotes.descriptor, desborde: desborde.descriptor, paginas: paginas.descriptor, duenoChunk };
}

/** La arena real de un hilo sobre la memoria compartida. Las columnas deben existir antes de `crecer` (las crea la primera
 * arena de cada memoria, que se abre en el hilo principal antes de los workers). */
export function arenaDe(m: MemoriaArena, hilo: number, quimica: Pick<ServicioQuimico, 'sustancia'>, agua: SustanciaId): ArenaLotes {
  return new ArenaLotes({
    lotes: new MemoriaPrueba(m.lotes), desborde: new MemoriaPrueba(m.desborde), paginas: new MemoriaPrueba(m.paginas), hilo, quimica,
    terreno: { chunkDe: celda => Math.floor(celda / 256), duenoChunk: m.duenoChunk },
    agua,
    digerible: () => 0,
  });
}

// ── Un mundo de materia real para una prueba ─────────────────────────────────────────────────────────────

export type Base = ReturnType<typeof registrarSustanciasBase>;
export type Contenido = Partial<Record<keyof Base, number>>;

export interface MateriaReal {
  quimica: ServicioQuimicoImpl;
  S: Base;
  memoria: MemoriaArena;
  arena: ArenaLotes;
  /** Cuenta de fuentes y sumideros declarados: el saldo de la arena debe ser siempre fuentes − sumideros. */
  libro: Libro;
  /** Lote nuevo (sin celda, del hilo 0) con `contenido` y el calor entero de T, declarado como fuente. */
  lote(contenido: Contenido, T: number, rol?: Rol): LoteRef;
  /** Saldo esperado: Σ fuentes − Σ sumideros, en bigint (átomos por elemento y energía, ARQ-materia I1/I2). */
  esperado(): bigint[];
  ctx(semilla: number, quimica?: ServicioQuimico): CtxPaso;
  atomos(l: LoteRef): number;
  cerrar(): Promise<void>;
}

export function materiaReal(opciones: { capacidad?: number; chunks?: number; hilos?: number } = {}): MateriaReal {
  const quimica = crearServicioQuimico({ modo: 'inmediato' });
  const S = registrarSustanciasBase(quimica);
  const memoria = memoriaDe(opciones.chunks ?? 1, opciones.capacidad ?? 1024, opciones.hilos ?? 1);
  const arena = arenaDe(memoria, 0, quimica, S.H2O);
  const libro = libroVacio();
  const atomosDe = (id: SustanciaId) => quimica.sustancia(id).atomos.reduce((s, v) => s + v, 0);
  const atomos = (l: LoteRef) => {
    let ids = new Uint32Array(16), n = arena.especies(l, ids);
    if (n > ids.length) n = arena.especies(l, ids = new Uint32Array(n));
    let total = 0;
    for (const id of ids.subarray(0, n)) total += arena.cuantos(l, id) * atomosDe(id);
    return total;
  };
  return {
    quimica, S, memoria, arena, libro, atomos,
    lote(contenido, T, rol = Rol.Objeto) {
      const l = arena.nuevo(rol, -1, 0);
      const pares: number[] = [];
      let n = 0;
      for (const [k, q] of Object.entries(contenido)) {
        if (!q) continue;
        const id = S[k as keyof Base];
        pares.push(id, q);
        n += q * atomosDe(id);
      }
      const calor = Math.round(T * CAPACIDAD_ATOMO * n);
      if (calor > 0) pares.push(0, calor);
      if (pares.length) arena.fuente(l, Float64Array.from(pares), libro);
      return l;
    },
    esperado: () => Array.from({ length: NE + 1 }, (_, i) => BigInt(libro.fuentes[i]!) - BigInt(libro.sumideros[i]!)),
    ctx: (semilla, q = quimica) => ({ arena, quimica: q, azar: azarSembrado(semilla) }),
    cerrar: () => quimica.cerrar(),
  };
}

// ── Piscina de prueba (M1) ───────────────────────────────────────────────────────────────────────────────

/** N workers que abren la arena real sobre los mismos SAB, cada uno como el hilo dueño de su índice, y corren `manejador`
 * de paso-worker. Cada uno tiene su química inmediata cargada del registro de `quimica` (`cargarSustancias`): los mismos
 * ids, y los productos nuevos que encuentre ya están si la mezcla pasó antes por el hilo principal (en el mundo, Q es
 * un servicio único y esto no hace falta). */
export class PiscinaReal {
  readonly #workers: Worker[];
  constructor(readonly hilos: number, memoria: MemoriaArena, quimica: ServicioQuimicoImpl, semilla: number) {
    const registro = serializarSustancias(quimica);
    this.#workers = Array.from({ length: hilos }, (_, h) => new Worker(new URL(import.meta.url), {
      workerData: { pasoReal: true, memoria, registro, semilla: semilla + h, hilo: h },
    }));
  }
  /** Un despacho; devuelve la pared (ms) y Σ lotes avanzados. */
  async correr(buffers: TrabajoPaso['buffers'], params: TrabajoPaso['params']): Promise<{ ms: number; lotes: number }> {
    const inicio = performance.now();
    const respuestas = await Promise.all(this.#workers.map((w, workerIndex) => new Promise<number>((resolver, fallar) => {
      w.once('message', (m: { lotes?: number; error?: string }) => m.error ? fallar(new Error(m.error)) : resolver(m.lotes!));
      w.postMessage({ buffers, params, workerIndex });
    })));
    return { ms: performance.now() - inicio, lotes: respuestas.reduce((s, v) => s + v, 0) };
  }
  cerrar(): Promise<number[]> { return Promise.all(this.#workers.map(w => w.terminate())); }
}

if (!isMainThread && (workerData as { pasoReal?: boolean } | null)?.pasoReal) {
  const { memoria, registro, semilla, hilo } = workerData as { memoria: MemoriaArena; registro: Uint8Array; semilla: number; hilo: number };
  const quimica = cargarSustancias(registro, { modo: 'inmediato' });
  const arena = arenaDe(memoria, hilo, quimica, registrarSustanciasBase(quimica).H2O);
  const correr = manejador(() => ({ arena, quimica, azar: azarSembrado(semilla) }));
  parentPort!.on('message', (t: TrabajoPaso) => {
    try { parentPort!.postMessage({ lotes: correr(t) }); }
    catch (e) { parentPort!.postMessage({ error: e instanceof Error ? e.stack : String(e) }); }
  });
}
