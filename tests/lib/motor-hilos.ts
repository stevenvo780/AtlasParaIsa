// Cuerpo de cálculo de las pruebas del núcleo del motor (M1): cada hilo de la `Piscina` recibe los mismos
// datos y hace el papel de su prueba. El coordinador (hilo 0) verifica y deja los fallos en `errores`.
import { threadId } from 'node:worker_threads';
import { conectarBuzon, type MemoriaBuzones } from '../../src/world/motor/buzon.js';
import { Contadores } from '../../src/world/motor/contadores.js';
import { TipoIntento, type Intento } from '../../src/world/motor/contratos.js';
import { RegistroContenido, type MemoriaRegistro } from '../../src/world/motor/registro.js';
import type { Libro } from '../../src/world/materia/tipos.js';
import { PageArena, type ArenaCompartida } from '../../src/world/soa/arena.js';
import { ArenaTerreno, type TerrenoCompartido } from '../../src/world/soa/terreno.js';

export type Fase = (fase: number) => void;

/** Índices de `errores`: el coordinador los lee al final de cada prueba. */
export const ERR = { perdidos: 0, duplicados: 1, alterados: 2, desordenados: 3, lecturas: 4, vistas: 5, ajenos: 6, recibidos: 7 } as const;

// ── Buzones ──────────────────────────────────────────────────────────────────────────────────────────────

/** Una cola por fase de envío: Global en F0 (cola F0), Migrante en F1 (M), Dar en F2 (A), Concedido en F6 (B). */
export const ENVIOS = [
  { cola: 'F0', fase: 0, tipo: TipoIntento.Global },
  { cola: 'M', fase: 1, tipo: TipoIntento.Migrante },
  { cola: 'A', fase: 2, tipo: TipoIntento.Dar },
  { cola: 'B', fase: 6, tipo: TipoIntento.Concedido },
] as const;

export interface DatosBuzones {
  prueba: 'buzones';
  memoria: MemoriaBuzones;
  hilos: number;
  porTick: number;
  ticks: number;
  /** Productores que terminaron su envío de F0 y de F1, acumulado entre ticks. */
  hechos: Int32Array;
  errores: Int32Array;
}

/** El contenido de cada mensaje sale de (emisor, cola, secuencia): así el receptor detecta cualquier alteración. */
export function mensaje(de: number, cola: number, seq: number): Intento {
  return {
    tipo: ENVIOS[cola]!.tipo, de, a: seq, celda: seq ^ de, lote: seq * 3 + cola, nonce: (de * 4 + cola) * 2 ** 26 + seq,
    materia: seq % 3 === 0 ? null : Float64Array.from({ length: seq % 7 }, (_, k) => seq * 10 + k + de / 128),
    dato: seq % 2 === 0 ? null : Float64Array.of(de, seq, -0.5),
    bytes: seq % 5 === 0 ? null : Uint8Array.from({ length: seq % 11 }, (_, k) => (seq + k + de) & 255),
  };
}

export function mismoMensaje(i: Intento, esperado: Intento): boolean {
  const igual = (x: ArrayLike<number> | null, y: ArrayLike<number> | null) =>
    x === null ? y === null : y !== null && x.length === y.length && Array.from(x).every((v, k) => Object.is(v, y[k]));
  return i.tipo === esperado.tipo && i.a === esperado.a && i.celda === esperado.celda && i.lote === esperado.lote
    && i.nonce === esperado.nonce && igual(i.materia, esperado.materia) && igual(i.dato, esperado.dato) && igual(i.bytes, esperado.bytes);
}

function azarDe(semilla: number): () => number {
  let s = semilla >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 2 ** 32; };
}

function buzones(hilo: number, d: DatosBuzones): Fase {
  const buzon = conectarBuzon(d.memoria, hilo, azarDe(hilo + 1));
  const total = d.porTick * d.ticks;
  const vistos = hilo === 0 ? new Uint8Array(ENVIOS.length * d.hilos * total) : null;
  const ultimo = hilo === 0 ? new Float64Array(2 * d.hilos).fill(-1) : null;
  const enviados = new Int32Array(ENVIOS.length);
  let tick = -1;

  const recibir = (cola: number) => (i: Intento) => {
    const de = i.de, seq = i.a;
    if (!Number.isInteger(de) || de < 0 || de >= d.hilos || !Number.isInteger(seq) || seq < 0 || seq >= total
      || i.tipo !== ENVIOS[cola]!.tipo) { Atomics.add(d.errores, ERR.alterados, 1); return; }
    if (!mismoMensaje(i, mensaje(de, cola, seq))) Atomics.add(d.errores, ERR.alterados, 1);
    const k = (cola * d.hilos + de) * total + seq;
    if (vistos![k]) Atomics.add(d.errores, ERR.duplicados, 1);
    vistos![k] = 1;
    Atomics.add(d.errores, ERR.recibidos, 1);
    // F0 y M conservan el orden de reserva: cada emisor llega en su orden de envío.
    if (cola < 2) {
      if (seq <= ultimo![cola * d.hilos + de]!) Atomics.add(d.errores, ERR.desordenados, 1);
      ultimo![cola * d.hilos + de] = seq;
    }
  };

  const producir = (cola: number) => {
    if (tick >= d.ticks) return;
    for (let n = 0; n < d.porTick; n++) {
      const i = mensaje(hilo, cola, enviados[cola]!++);
      buzon.enviar(0, i);
      // `enviar` copia: el emisor puede reutilizar sus arrays en cuanto vuelve.
      i.materia?.fill(NaN); i.dato?.fill(NaN); i.bytes?.fill(0);
      if (hilo === 0 && n % 64 === 0) vaciarConcurrente(cola);
    }
  };

  // El coordinador vacía mientras los demás siguen enviando a la misma cola.
  const vaciarConcurrente = (cola: number) => {
    if (cola === 0) buzon.vaciar('F0', recibir(0));
    else if (cola === 1) buzon.vaciar('M', recibir(1));
  };

  return fase => {
    if (fase === 0) tick++;
    const cola = ENVIOS.findIndex(e => e.fase === fase);
    if (hilo !== 0) {
      if (cola >= 0) producir(cola);
      if (cola === 0 || cola === 1) Atomics.add(d.hechos, cola, 1);
      return;
    }
    if (fase === 1) buzon.vaciar('B', recibir(3));
    if (cola >= 0) producir(cola);
    if (cola === 0 || cola === 1) {
      const meta = (tick + 1) * (d.hilos - 1);
      while (Atomics.load(d.hechos, cola) < meta) vaciarConcurrente(cola);
      vaciarConcurrente(cola);
    }
    if (fase === 5) buzon.vaciar('A', recibir(2));
    if (fase === 1 && tick === d.ticks) {
      let perdidos = 0;
      for (const v of vistos!) perdidos += v ^ 1;
      Atomics.store(d.errores, ERR.perdidos, perdidos);
    }
  };
}

// ── Fallos ───────────────────────────────────────────────────────────────────────────────────────────────

export interface DatosFallos {
  prueba: 'fallos';
  modo: 'muere' | 'lanza' | 'cuelga' | 'coordinador';
  /** Escrituras de los hilos durante la fase que falla: tras el cierre no puede moverse. */
  contador: Int32Array;
}

function fallos(hilo: number, d: DatosFallos): Fase {
  return fase => {
    if (fase !== 1) return;
    const hasta = performance.now() + 300;
    if (hilo === 0) {
      if (d.modo === 'coordinador') throw new Error('fallo de prueba en el coordinador');
      // El hilo víctima muere o se cuelga mientras el coordinador aún no espera en la barrera.
      while (performance.now() < hasta);
      return;
    }
    if (hilo === 1 && d.modo === 'muere') process.exit(7);
    if (hilo === 1 && d.modo === 'lanza') throw new Error('fallo de prueba en el hilo 1');
    if (hilo === 1 && d.modo === 'cuelga') for (;;) Atomics.add(d.contador, 0, 1);
    while (performance.now() < hasta) Atomics.add(d.contador, 0, 1);
  };
}

// ── Memoria crecible ─────────────────────────────────────────────────────────────────────────────────────

export const BLOQUE = 256;
export const BYTES_LOTE = 120;
/** Índices de `control`: ranuras publicadas por el coordinador y si sigue creciendo. */
export const CTL = { publicadas: 0, creciendo: 1, paginas: 2 } as const;

export interface DatosCrecimiento {
  prueba: 'crecimiento';
  arena: ArenaCompartida;
  terreno: TerrenoCompartido;
  control: Int32Array;
  errores: Int32Array;
  /** Ranuras que reserva cada hilo en F1. */
  porHilo: number;
  /** Rondas de crecimiento del coordinador en F0. */
  rondas: number;
}

export const valorDe = (s: number) => s + 0.5;
export const byteDe = (s: number, k: number) => (s * 31 + k) & 255;
export const alturaDe = (px: number, py: number, local: number) => px * 1000 + py + local / 256;

function crecimiento(hilo: number, d: DatosCrecimiento): Fase {
  if (hilo === 0) return () => {};
  // Vistas tomadas una sola vez al conectar, como hace la arena de materia: deben seguir la longitud.
  const arena = PageArena.conectar(d.arena), terreno = ArenaTerreno.conectar(d.terreno);
  const valor = arena.field('valor', Float64Array, 1);
  const lote = arena.field('lote', Uint8Array, BYTES_LOTE);
  const dueno = arena.field('dueno', Int32Array, 1, -1);
  const altura = terreno.campo('altura');
  const propias: number[] = [];
  return fase => {
    const comprobar = () => {
      const publicadas = Atomics.load(d.control, CTL.publicadas);
      if (valor.length < publicadas || lote.length < publicadas * BYTES_LOTE) Atomics.add(d.errores, ERR.vistas, 1);
      for (let s = 0; s < publicadas; s += 7) if (valor[s] !== valorDe(s)) Atomics.add(d.errores, ERR.lecturas, 1);
      // Vista fija por bloque de 256 lotes, como `columnasLote` de la materia.
      const bloques = Math.floor(publicadas / BLOQUE);
      if (bloques > 0) {
        const b = (hilo * 13) % bloques;
        const vista = new Uint8Array(lote.buffer, lote.byteOffset + b * BLOQUE * BYTES_LOTE, BLOQUE * BYTES_LOTE);
        const s = b * BLOQUE + (hilo % BLOQUE);
        if (vista[(s - b * BLOQUE) * BYTES_LOTE + 3] !== byteDe(s, 3)) Atomics.add(d.errores, ERR.lecturas, 1);
      }
      const paginas = Atomics.load(d.control, CTL.paginas);
      for (let p = 0; p < paginas; p += 5) {
        const c = terreno.celda(p * 16 + 3, -16 + 2);
        if (c < 0 || altura[c] !== alturaDe(p, -1, 2 * 16 + 3)) Atomics.add(d.errores, ERR.lecturas, 1);
      }
    };
    if (fase === 0) {
      do comprobar(); while (Atomics.load(d.control, CTL.creciendo) === 1);
      comprobar();
    } else if (fase === 1) {
      for (let n = 0; n < d.porHilo; n++) {
        const s = arena.reserve();
        dueno[s] = hilo;
        propias.push(s);
      }
    } else if (fase === 2) {
      for (const s of propias.splice(0)) {
        if (dueno[s] !== hilo) Atomics.add(d.errores, ERR.ajenos, 1);
        dueno[s] = -1;
        arena.release(s);
      }
    }
  };
}

// ── Registro, contadores y libros ────────────────────────────────────────────────────────────────────────

export interface DatosGlobales {
  prueba: 'globales';
  registro: MemoriaRegistro;
  contadores: BigUint64Array;
  libros: Libro[];
  /** Por hilo, `porHilo` ids de registro y luego `porHilo` nonces. */
  salida: Float64Array;
  porHilo: number;
}

/** La mitad de los contenidos los comparten todos los hilos; la otra mitad es propia de cada uno. */
export const contenido = (hilo: number, j: number) =>
  new TextEncoder().encode(j % 2 === 0 ? `comun-${j}` : `propio-${hilo}-${j}`);

function globales(hilo: number, d: DatosGlobales): Fase {
  const registro = new RegistroContenido(d.registro);
  const contadores = new Contadores(d.contadores);
  return fase => {
    if (fase !== 0) return;
    const base = hilo * 2 * d.porHilo;
    for (let j = 0; j < d.porHilo; j++) {
      d.salida[base + j] = registro.insertar(contenido(hilo, j));
      d.salida[base + d.porHilo + j] = contadores.id('nonce');
    }
    d.libros[hilo]!.fuentes[1] = hilo + 1;
    d.libros[hilo]!.enVuelo[0] = threadId;
  };
}

export type DatosHilos = DatosBuzones | DatosFallos | DatosCrecimiento | DatosGlobales;

export function crear(hilo: number, datos: DatosHilos): Fase {
  switch (datos.prueba) {
    case 'buzones': return buzones(hilo, datos);
    case 'fallos': return fallos(hilo, datos);
    case 'crecimiento': return crecimiento(hilo, datos);
    case 'globales': return globales(hilo, datos);
  }
}
