/**
 * Dobles mínimos de la arena (A) y la química (Q) para probar el carril P sin esperar a sus carriles, y una piscina de
 * prueba (M1) para medir el reparto entre hilos. La arena vive en SAB para que los workers la compartan, y es estricta:
 * cualquier cantidad o calor no entero, negativo o no finito es un error (I3), y `aplicar` exige dH = ΔE (I2).
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { NE } from '../../src/shared/naturaleza.js';
import type { SustanciaId } from '../../src/shared/materia.js';
import {
  Parte, type ArenaMateria, type Ecuacion, type LoteRef, type Pedido, type Reaccion, type ServicioQuimico, type Sustancia,
} from '../../src/world/materia/tipos.js';
import type { CtxPaso } from '../../src/world/materia/paso.js';
import { manejador, type TrabajoPaso } from '../../src/world/materia/paso-worker.js';

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

// ── Química de prueba ────────────────────────────────────────────────────────────────────────────────────

/** Átomos por elemento (H C N O P Si Ca Fe). */
const at = (h: number, c: number, n: number, o: number): Uint8Array => Uint8Array.from([h, c, n, o, 0, 0, 0, 0]);

const sust = (id: number, atomos: Uint8Array, energia: number, masa: number, tEbullicion: number, densidad: number): Sustancia => ({
  id, clase: 1, enlaces: new Uint16Array(0), atomos, masa, energia,
  prop: { r: 0, dMedia: 0, tFusion: 0, tEbullicion, qOxidacion: 0, dureza: 0, tenacidad: 0, flexibilidad: 0, polaridad: 0, densidad, color: 0 },
});

/** Sustancias de prueba con energías enteras inventadas (solo importa que las ecuaciones conserven átomos). */
export const S = { A: 1, O2: 2, CO2: 3, H2O: 4, D: 5, X: 6, Y: 7 } as const;
const SUSTANCIAS: Sustancia[] = [
  sust(S.A, at(2, 1, 0, 1), -1500, 30, Infinity, 1.5),  // CH₂O, unidad
  sust(S.O2, at(0, 0, 0, 2), -494, 32, 90, 1.14),
  sust(S.CO2, at(0, 1, 0, 2), -1406, 44, 195, 1.5),
  sust(S.H2O, at(2, 0, 0, 1), -874, 18, 371, 1),
  sust(S.D, at(4, 2, 0, 2), -3050, 60, Infinity, 1.5),  // dímero de A
  sust(S.X, at(0, 0, 2, 0), -900, 28, 77, 0.8),
  sust(S.Y, at(0, 0, 1, 0), -460, 14, 77, 0.8),
];

/** `niveles`: los ℓ en que la reacción baja la energía libre; como en Q, una reacción y su inversa nunca coinciden. */
export interface RecetaReaccion {
  a: SustanciaId; b: SustanciaId; salidas: [SustanciaId, number][]; ea: number; catalisis: -1 | 0 | 1 | 2; niveles?: [number, number];
}

/** Combustión A + O₂ → CO₂ + H₂O; dimerización A + A → D hasta ℓ = 7 (< 800 K) y su inversa D → 2A (endotérmica)
 * desde ℓ = 8; X → 2Y (exotérmica, familia C–N, con la barrera de 98 que κ del suelo anula). */
export const RECETA: RecetaReaccion[] = [
  { a: S.A, b: S.O2, salidas: [[S.CO2, 1], [S.H2O, 1]], ea: 173, catalisis: 0 },
  { a: S.A, b: S.A, salidas: [[S.D, 1]], ea: 90, catalisis: 2, niveles: [0, 7] },
  { a: S.D, b: 0, salidas: [[S.A, 2]], ea: 120, catalisis: 2, niveles: [8, 15] },
  { a: S.X, b: 0, salidas: [[S.Y, 2]], ea: 98, catalisis: 1 },
];

export class QuimicaDoble implements ServicioQuimico {
  readonly tabla = new Map<SustanciaId, Sustancia>(SUSTANCIAS.map(s => [s.id, s]));
  readonly #reacciones = new Map<string, Omit<Reaccion, 'nivelT'> & { niveles: [number, number] }>();
  consultas = 0;
  constructor(receta: readonly RecetaReaccion[] = RECETA) {
    for (const r of receta) {
      const entradas = r.b === 0 ? [{ id: r.a, nu: 1 }] : r.a === r.b ? [{ id: r.a, nu: 2 }] : [{ id: r.a, nu: 1 }, { id: r.b, nu: 1 }];
      const salidas = r.salidas.map(([id, nu]) => ({ id, nu }));
      const energia = (l: { id: number; nu: number }[]) => l.reduce((s, e) => s + e.nu * this.tabla.get(e.id)!.energia, 0);
      this.#reacciones.set(clave(r.a, r.b), { a: r.a, b: r.b, entradas, salidas, dH: energia(salidas) - energia(entradas), ea: r.ea, catalisis: r.catalisis, niveles: r.niveles ?? [0, 15] });
    }
  }
  internar(): SustanciaId { throw new Error('el doble no interna'); }
  sustancia(id: SustanciaId): Readonly<Sustancia> { return this.tabla.get(id)!; }
  reaccion(a: SustanciaId, b: SustanciaId, nivelT: number): Reaccion | null {
    this.consultas++;
    const r = this.#reacciones.get(clave(a, b)) ?? this.#reacciones.get(clave(b, a));
    if (!r || nivelT < r.niveles[0] || nivelT > r.niveles[1]) return null;
    const { niveles: _, ...reaccion } = r;
    return { ...reaccion, nivelT };
  }
}
const clave = (a: number, b: number) => `${a},${b}`;

// ── Arena de prueba ──────────────────────────────────────────────────────────────────────────────────────

const RANURAS = 8;
const entero = (v: number, que: string): number => {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`I3: ${que} = ${v} no es un entero seguro ≥ 0`);
  return v;
};

export interface BuffersArena { esp: SharedArrayBuffer; cant: SharedArrayBuffer; calor: SharedArrayBuffer }
export const buffersArena = (lotes: number): BuffersArena => ({
  esp: new SharedArrayBuffer(lotes * RANURAS * 4), cant: new SharedArrayBuffer(lotes * RANURAS * 8), calor: new SharedArrayBuffer(lotes * 8),
});

export class ArenaDoble implements ArenaMateria {
  readonly esp: Uint32Array; readonly cant: Float64Array; readonly cal: Float64Array;
  readonly n: number;
  constructor(readonly buffers: BuffersArena, readonly quimica: QuimicaDoble) {
    this.esp = new Uint32Array(buffers.esp); this.cant = new Float64Array(buffers.cant); this.cal = new Float64Array(buffers.calor);
    this.n = this.cal.length;
  }
  #ranura(l: LoteRef, id: SustanciaId, crear: boolean): number {
    let libre = -1;
    for (let r = l * RANURAS; r < (l + 1) * RANURAS; r++) {
      if (this.esp[r] === id) return r;
      if (libre < 0 && this.esp[r] === 0) libre = r;
    }
    if (!crear) return -1;
    if (libre < 0) throw new Error('el doble no tiene desborde');
    this.esp[libre] = id;
    return libre;
  }
  #sumar(l: LoteRef, id: SustanciaId, delta: number): void {
    const r = this.#ranura(l, id, true);
    this.cant[r] = entero(this.cant[r]! + delta, `cant(${l}, ${id})`);
    if (this.cant[r] === 0) this.esp[r] = 0;
  }
  poner(l: LoteRef, id: SustanciaId, cuantos: number): void { this.#sumar(l, id, cuantos - this.cuantos(l, id)); }
  ponerCalor(l: LoteRef, j: number): void { this.cal[l] = entero(j, `calor(${l})`); }
  atomos(l: LoteRef): number {
    let n = 0;
    for (let r = l * RANURAS; r < (l + 1) * RANURAS; r++) if (this.esp[r]) n += this.cant[r]! * this.quimica.sustancia(this.esp[r]!).atomos.reduce((s, v) => s + v, 0);
    return n;
  }
  /** I1 e I2 del doble: átomos por elemento y energía química + calor de los lotes dados, en bigint. */
  balance(lotes: Iterable<LoteRef>): bigint[] {
    const t = Array.from({ length: NE + 1 }, () => 0n);
    for (const l of lotes) {
      for (let r = l * RANURAS; r < (l + 1) * RANURAS; r++) {
        if (!this.esp[r]) continue;
        const s = this.quimica.sustancia(this.esp[r]!), q = BigInt(this.cant[r]!);
        for (let e = 0; e < NE; e++) t[e]! += q * BigInt(s.atomos[e]!);
        t[NE]! += q * BigInt(s.energia);
      }
      t[NE]! += BigInt(this.cal[l]!);
    }
    return t;
  }

  especies(l: LoteRef, ids: Uint32Array): number {
    let n = 0;
    for (let r = l * RANURAS; r < (l + 1) * RANURAS; r++) if (this.esp[r]) { if (n < ids.length) ids[n] = this.esp[r]!; n++; }
    return n;
  }
  cuantos(l: LoteRef, id: SustanciaId): number { const r = this.#ranura(l, id, false); return r < 0 ? 0 : this.cant[r]!; }
  calor(l: LoteRef): number { return this.cal[l]!; }
  vivo(l: LoteRef): boolean { return l >= 0 && l < this.n; }
  propio(l: LoteRef): boolean { return this.vivo(l); }

  aplicar(l: LoteRef, e: Ecuacion, veces: number): number {
    entero(veces, 'veces');
    const energia = (lista: Ecuacion['entradas']) => lista.reduce((s, x) => s + x.nu * this.quimica.sustancia(x.id).energia, 0);
    if (e.dH !== energia(e.salidas) - energia(e.entradas)) throw new Error('I2: dH no es la diferencia de energías');
    let v = veces;
    for (const x of e.entradas) v = Math.min(v, Math.floor(this.cuantos(l, x.id) / x.nu));
    if (e.dH > 0) v = Math.min(v, Math.floor(this.cal[l]! / e.dH));
    if (v === 0) return 0;
    for (const x of e.entradas) this.#sumar(l, x.id, -v * x.nu);
    for (const x of e.salidas) this.#sumar(l, x.id, v * x.nu);
    this.cal[l] = entero(this.cal[l]! - v * e.dH, `calor(${l})`);
    return v;
  }
  moverParte(de: LoteRef, a: LoteRef, p: Pedido): number {
    if (p.parte !== Parte.Exacta) throw new Error('el doble solo mueve partes exactas');
    entero(p.cuantos, 'cuantos');
    const n = Math.min(p.cuantos, this.cuantos(de, p.esp));
    if (n === 0) return 0;
    const atomosEsp = this.quimica.sustancia(p.esp).atomos.reduce((s, v) => s + v, 0);
    const j = Math.floor(Number(BigInt(this.cal[de]!) * BigInt(n * atomosEsp) / BigInt(this.atomos(de))));
    this.#sumar(de, p.esp, -n); this.#sumar(a, p.esp, n);
    this.cal[de] = entero(this.cal[de]! - j, 'calor'); this.cal[a] = entero(this.cal[a]! + j, 'calor');
    return n;
  }
  moverCalor(de: LoteRef, a: LoteRef, j: number): number {
    entero(j, 'j');
    const m = Math.min(j, this.cal[de]!);
    this.cal[de] = entero(this.cal[de]! - m, 'calor'); this.cal[a] = entero(this.cal[a]! + m, 'calor');
    return m;
  }
  mover(t: { de: LoteRef; a: LoteRef; esp: SustanciaId; cuantos: number }): number {
    entero(t.cuantos, 'cuantos');
    const n = Math.min(t.cuantos, this.cuantos(t.de, t.esp));
    if (n > 0) { this.#sumar(t.de, t.esp, -n); this.#sumar(t.a, t.esp, n); }
    return n;
  }
  nuevo(): LoteRef { throw new Error('no usado'); }
  liberar(): void { throw new Error('no usado'); }
  adoptar(): void { throw new Error('no usado'); }
  lotes(): number { throw new Error('no usado'); }
  vista(): never { throw new Error('no usado'); }
  formar(): void { throw new Error('no usado'); }
  garantizar(): Float64Array { throw new Error('no usado'); }
  abonar(): void { throw new Error('no usado'); }
  fuente(): void { throw new Error('no usado'); }
  sumidero(): Float64Array { throw new Error('no usado'); }
}

export const ctxDoble = (arena: ArenaDoble, semilla: number): CtxPaso => ({ arena, quimica: arena.quimica, azar: azarSembrado(semilla) });

// ── Piscina de prueba ────────────────────────────────────────────────────────────────────────────────────

/** N workers que abren la arena doble sobre los mismos SAB y corren `manejador` de paso-worker por despacho. */
export class PiscinaDoble {
  readonly #workers: Worker[];
  constructor(readonly hilos: number, arena: BuffersArena, semilla: number) {
    this.#workers = Array.from({ length: hilos }, (_, h) => new Worker(new URL(import.meta.url), {
      workerData: { pasoDoble: true, arena, semilla: semilla + h },
    }));
  }
  /** Un despacho; devuelve la pared (ms) y Σ veces aplicadas. */
  async correr(buffers: TrabajoPaso['buffers'], params: TrabajoPaso['params']): Promise<{ ms: number; veces: number }> {
    const inicio = performance.now();
    const respuestas = await Promise.all(this.#workers.map((w, workerIndex) => new Promise<number>((resolver, fallar) => {
      w.once('message', (m: { veces?: number; error?: string }) => m.error ? fallar(new Error(m.error)) : resolver(m.veces!));
      w.postMessage({ buffers, params, workerIndex });
    })));
    return { ms: performance.now() - inicio, veces: respuestas.reduce((s, v) => s + v, 0) };
  }
  cerrar(): Promise<number[]> { return Promise.all(this.#workers.map(w => w.terminate())); }
}

if (!isMainThread && (workerData as { pasoDoble?: boolean } | null)?.pasoDoble) {
  const { arena, semilla } = workerData as { arena: BuffersArena; semilla: number };
  const correr = manejador(() => ctxDoble(new ArenaDoble(arena, new QuimicaDoble()), semilla));
  parentPort!.on('message', (t: TrabajoPaso) => {
    try { parentPort!.postMessage({ veces: correr(t) }); }
    catch (e) { parentPort!.postMessage({ error: e instanceof Error ? e.stack : String(e) }); }
  });
}
