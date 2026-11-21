/**
 * Fase de decisión de la fauna (`choose` de `src/world/animals.ts`) sobre `SharedArrayBuffer`.
 *
 * Es el cuerpo de cálculo que corre en cada worker de `StaticWorkerPool` (y, con `hilos = 1`, en el
 * propio hilo del coordinador). `choose` es de solo lectura sobre el terreno (`state.tile`), sobre los
 * ocupantes (`state.occupants`, `state.counts`) y sobre TODOS los demás animales; sólo escribe en el
 * animal que decide (`action`, `target`, `reason`, `preyId`, `work`, `lastDecision`, `memory`). Aquí
 * cada animal debido escribe únicamente su fila de salida (`dueSlot`): no hay carreras ni `Atomics`.
 * No lee relojes, ni la máquina, ni azar del proceso (T171).
 *
 * Paridad con `animals.ts` (mismo recorrido, mismos desempates, mismas fórmulas en el mismo orden):
 * · `localTiles`: rombo `|dx| + |dy| ≤ 2 + ⌊percepción·4⌋`, `dy` exterior y `dx` interior, teselas
 *   presentes del hábitat (pez: `water`; resto: ni `water` ni `shelter`).
 * · `near`: ocupantes de cada celda visible en ese orden y, dentro de la celda, en el orden de
 *   `state.occupants`; fuera el propio id (rango canónico igual) y los de salud ≤ 0.
 * · `primerosDos` literal sobre lo visible y `remember` literal sobre una copia local de la memoria
 *   (lo que viene después en `choose` lee la memoria ya actualizada).
 * · amenazas, huida (`safety`), recursos (visibles + recuerdos vigentes fuera de lo visible), agua,
 *   alimento, presa (`distancia || canonical`), descanso y novedad (`hash` FNV + mezcla de 32 bits
 *   sobre la cadena exacta `${id}:${x},${y}:${⌊tick/60⌋}`).
 * `xs.sort(cmp)[0]` se evalúa como `primero(xs, cmp)`: los comparadores de `choose` son preórdenes
 * totales consistentes (diferencias de enteros o de doubles finitos encadenadas con `||`) y
 * `Array.prototype.sort` es estable, así que el primero ordenado es el primer mínimo en el orden de
 * entrada (misma justificación que `orden.ts`).
 *
 * La salida no copia coordenadas ni valores: referencia la tesela (`índice en world.tiles`), el
 * recuerdo (posición en la memoria ya actualizada), la presa (fila de la tabla de animales) o el
 * propio animal. `applyFaunaChooseOutputs` (fauna-motor.ts) lee esos objetos reales, así que `target`,
 * los recuerdos (`food`, `water`, `-0` incluidos) y `preyId` son por construcción los de `choose`.
 */
import type { StaticRegion } from './particion.js';
import type { StaticWorkerHandlerJob } from './piscina.js';

export const LADO_PAGINA = 16;
export const CELDAS_POR_PAGINA = LADO_PAGINA * LADO_PAGINA;

/** Copias literales de `animals.ts` (`MEMORY_TTL` no se exporta; las otras dos se comprueban en la prueba). */
export const MEMORIA_TTL = 480;
export const MAX_MEMORIA_ANIMAL = 12;
export const MAX_ANIMALES_POR_CELDA = 6;

/** Especies en el orden de `animals.ts`; 255 = desconocida. */
export const ESPECIES = ['hare', 'deer', 'boar', 'fish', 'wolf', 'fox'] as const;
export const ESPECIE = Object.fromEntries(ESPECIES.map((s, i) => [s, i])) as { readonly [S in typeof ESPECIES[number]]: number };
export const ESPECIE_DESCONOCIDA = 255;
/** Código de especie (sin búsquedas por nombre: nunca resuelve claves heredadas de `Object.prototype`). */
export function codigoEspecie(especie: string): number {
  switch (especie) {
    case 'hare': return 0; case 'deer': return 1; case 'boar': return 2; case 'fish': return 3; case 'wolf': return 4; case 'fox': return 5;
    default: return ESPECIE_DESCONOCIDA;
  }
}
const LIEBRE = ESPECIE.hare, CIERVO = ESPECIE.deer, JABALI = ESPECIE.boar, PEZ = ESPECIE.fish, LOBO = ESPECIE.wolf, ZORRO = ESPECIE.fox;

/** Acciones en el orden de `ACTIONS` de `animals.ts`. */
export const ACCIONES_FAUNA = ['roam', 'graze', 'drink', 'rest', 'hunt', 'flee'] as const;
export const ACCION_FAUNA = Object.fromEntries(ACCIONES_FAUNA.map((a, i) => [a, i])) as { readonly [A in typeof ACCIONES_FAUNA[number]]: number };
/** Razón de cada acción, literal de `choose`. */
export const RAZONES_FAUNA: readonly string[] = [
  'Explora celdas cercanas y evita recorridos que recuerda.',
  'El hambre orienta su camino hacia crecimiento vegetal finito.',
  'La sed orienta su camino hacia agua percibida o recordada.',
  'El agotamiento requiere una pausa; descansar no elimina hambre ni sed.',
  'Persigue una presa individual visible; alimentarse exige alcanzarla.',
  'Percibe un depredador cercano y se aleja físicamente de su alcance.',
];

/** Banderas por celda. */
export const CELDA_PRESENTE = 1, CELDA_AGUA = 2, CELDA_REFUGIO = 4, CELDA_OCEANO = 8, CELDA_CRECIMIENTO = 16;

/** Columnas Float64 de la tabla de animales vivos (`tablaF64[campo · capTabla + fila]`). */
export const TF = { x: 0, y: 1, carnivory: 2, health: 3 } as const;
export const NTF = 4;
/** Columnas Int32 de la tabla. */
export const TI = { especie: 0, rango: 1 } as const;
export const NTI = 2;

/** Columnas Float64 de entrada por animal debido. */
export const DF = { x: 0, y: 1, hunger: 2, thirst: 3, energy: 4, fatigue: 5, perception: 6, carnivory: 7 } as const;
export const NDF = 8;
/** Columnas Int32 de entrada por animal debido. */
export const DI = { especie: 0, rango: 1, memorias: 2, idInicio: 3, idLongitud: 4 } as const;
export const NDI = 5;
/** Campos Float64 por recuerdo (`memoriaF64[(slot · capMemoria + k) · NMF + campo]`). */
export const MF = { x: 0, y: 1, tick: 2, food: 3, water: 4 } as const;
export const NMF = 5;

/** Columnas Int32 de salida por animal debido (escritura exclusiva por `dueSlot`). */
export const SO = {
  accion: 0, destinoTipo: 1, destinoRef: 2, presa: 3, recuerdos: 4,
  recuerdo0Tesela: 5, recuerdo0Visitado: 6, recuerdo1Tesela: 7, recuerdo1Visitado: 8,
} as const;
export const NSO = 9;
/** `destinoTipo`: el propio animal, una tesela (índice en `world.tiles`), un recuerdo (posición en la
 * memoria ya actualizada por los `remember` de este `choose`) o una presa (fila de la tabla). */
export const DESTINO_PROPIO = 0, DESTINO_TESELA = 1, DESTINO_RECUERDO = 2, DESTINO_PRESA = 3;

/** Nombres de los SAB del despacho. */
export const BUFFERS_FAUNA = [
  'paginasX', 'paginasY', 'paginasSlot', 'celdaFlags', 'celdaCrecimiento', 'celdaVegetacion', 'celdaHumedad', 'celdaAguaPotable',
  'celdaTesela', 'celdaInicio', 'celdaCuenta', 'celdaOcupados', 'ocupantes', 'tablaF64', 'tablaI32',
  'dueF64', 'dueI32', 'memoriaF64', 'memoriaVisitado', 'idCaracteres', 'salidaI32',
] as const;
export type BuffersFauna = Record<typeof BUFFERS_FAUNA[number], SharedArrayBuffer>;

/** Parámetros del despacho: escalares estructurados. */
export interface ParamsFauna {
  capTabla: number;
  capDue: number;
  due: number;
  capMemoria: number;
  hashMask: number;
  seed: number;
  tick: number;
}

export interface VistaFauna {
  paginasX: Int32Array; paginasY: Int32Array; paginasSlot: Int32Array;
  flags: Uint8Array; crecimiento: Float64Array; vegetacion: Float64Array; humedad: Float64Array; aguaPotable: Float64Array;
  tesela: Int32Array; inicio: Int32Array; cuenta: Int32Array; ocupados: Int32Array; ocupantes: Int32Array;
  tf: Float64Array; ti: Int32Array; df: Float64Array; di: Int32Array; mf: Float64Array; mv: Uint8Array; id: Uint16Array;
  so: Int32Array; params: ParamsFauna;
}

export function crearVistaFauna(buffers: Readonly<Record<string, SharedArrayBuffer>>, params: ParamsFauna): VistaFauna {
  return {
    paginasX: new Int32Array(buffers.paginasX!), paginasY: new Int32Array(buffers.paginasY!), paginasSlot: new Int32Array(buffers.paginasSlot!),
    flags: new Uint8Array(buffers.celdaFlags!), crecimiento: new Float64Array(buffers.celdaCrecimiento!),
    vegetacion: new Float64Array(buffers.celdaVegetacion!), humedad: new Float64Array(buffers.celdaHumedad!),
    aguaPotable: new Float64Array(buffers.celdaAguaPotable!), tesela: new Int32Array(buffers.celdaTesela!),
    inicio: new Int32Array(buffers.celdaInicio!), cuenta: new Int32Array(buffers.celdaCuenta!), ocupados: new Int32Array(buffers.celdaOcupados!),
    ocupantes: new Int32Array(buffers.ocupantes!), tf: new Float64Array(buffers.tablaF64!), ti: new Int32Array(buffers.tablaI32!),
    df: new Float64Array(buffers.dueF64!), di: new Int32Array(buffers.dueI32!), mf: new Float64Array(buffers.memoriaF64!),
    mv: new Uint8Array(buffers.memoriaVisitado!), id: new Uint16Array(buffers.idCaracteres!), so: new Int32Array(buffers.salidaI32!), params,
  };
}

/** Hash de página determinista: el mismo esquema que `personas-worker.ts`. */
export function hashPagina(px: number, py: number, mask: number): number {
  let h = Math.imul(px, 0x9e3779b1) ^ Math.imul(py ^ 0x5bd1e995, 0x85ebca77);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return h & mask;
}

/** Ranura de la página `(px, py)` o −1 si no está cargada. */
export function buscarPagina(vista: VistaFauna, px: number, py: number): number {
  const mask = vista.params.hashMask;
  for (let h = hashPagina(px, py, mask); ; h = (h + 1) & mask) {
    const slot = vista.paginasSlot[h]!;
    if (slot < 0) return -1;
    if (vista.paginasX[h] === px && vista.paginasY[h] === py) return slot;
  }
}

/** Rango de enteros que admite el hash de páginas (`>> 4` exacto y clave de página < 2^53); cubre de
 * sobra `MAX_COORDINATE` (10^7). Fuera de él no hay teselas empaquetadas. */
export const COORDENADA_PAGINABLE = 2 ** 25;
export const paginable = (v: number): boolean => Number.isInteger(v) && v >= -COORDENADA_PAGINABLE && v < COORDENADA_PAGINABLE;

/** Celda global de `(x, y)` o −1 si no hay tesela (equivale a `state.tile(x, y) === undefined`). */
export function celdaDe(vista: VistaFauna, x: number, y: number): number {
  if (!paginable(x) || !paginable(y)) return -1;
  const slot = buscarPagina(vista, x >> 4, y >> 4);
  if (slot < 0) return -1;
  const celda = slot * CELDAS_POR_PAGINA + ((y & 15) << 4) + (x & 15);
  return vista.flags[celda]! & CELDA_PRESENTE ? celda : -1;
}

/** Copia literal de `hash` de `animals.ts`. */
export function hashFauna(seed: number, text: string): number {
  let n = seed >>> 0;
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return (n ^ (n >>> 16)) >>> 0;
}

// ── Scratch por hilo (cada worker y el coordinador tienen el suyo; nunca se comparte) ──────

/** Arreglos tipados que crecen geométricamente cuando un animal necesita más sitio. */
let capVisibles = 0;
let visX = new Float64Array(0), visY = new Float64Array(0), visCelda = new Int32Array(0), visAdyacente = new Uint8Array(0);
let capCercanos = 0;
let cercanos = new Int32Array(0);
let capAmenazas = 0;
let amenazaX = new Float64Array(0), amenazaY = new Float64Array(0);
let capMem = 0;
let memX = new Float64Array(0), memY = new Float64Array(0), memT = new Float64Array(0), memF = new Float64Array(0), memW = new Float64Array(0);
let memV = new Uint8Array(0), memNueva = new Int32Array(0);
let capRecursos = 0;
/** Recurso: −1 − índice visible, o el índice del recuerdo (≥ 0). */
let recRef = new Int32Array(0);
let recX = new Float64Array(0), recY = new Float64Array(0), recF = new Float64Array(0), recW = new Float64Array(0);

const crecer = (actual: number, necesario: number): number => Math.max(necesario, actual * 2, 16);
function asegurarVisibles(n: number): void {
  if (n <= capVisibles) return;
  capVisibles = crecer(capVisibles, n);
  visX = new Float64Array(capVisibles); visY = new Float64Array(capVisibles); visCelda = new Int32Array(capVisibles); visAdyacente = new Uint8Array(capVisibles);
}
function asegurarCercanos(n: number): void {
  if (n <= capCercanos) return;
  const nuevo = new Int32Array(capCercanos = crecer(capCercanos, n)); nuevo.set(cercanos); cercanos = nuevo;
}
function asegurarAmenazas(n: number): void {
  if (n <= capAmenazas) return;
  capAmenazas = crecer(capAmenazas, n);
  const x = new Float64Array(capAmenazas), y = new Float64Array(capAmenazas);
  x.set(amenazaX); y.set(amenazaY); amenazaX = x; amenazaY = y;
}
function asegurarMemoria(n: number): void {
  if (n <= capMem) return;
  capMem = crecer(capMem, n);
  memX = new Float64Array(capMem); memY = new Float64Array(capMem); memT = new Float64Array(capMem);
  memF = new Float64Array(capMem); memW = new Float64Array(capMem); memV = new Uint8Array(capMem); memNueva = new Int32Array(capMem);
}
function asegurarRecursos(n: number): void {
  if (n <= capRecursos) return;
  capRecursos = crecer(capRecursos, n);
  recRef = new Int32Array(capRecursos); recX = new Float64Array(capRecursos); recY = new Float64Array(capRecursos);
  recF = new Float64Array(capRecursos); recW = new Float64Array(capRecursos);
}

/** Ventana de páginas resueltas para el rombo del animal: evita el hash en el bucle de `localTiles`. */
let ventana = new Int32Array(0);
let ventanaPx0 = 0, ventanaPy0 = 0, ventanaAncho = 0;
function cargarVentana(vista: VistaFauna, cx: number, cy: number, radio: number): void {
  const px0 = (cx - radio) >> 4, px1 = (cx + radio) >> 4, py0 = (cy - radio) >> 4, py1 = (cy + radio) >> 4;
  ventanaPx0 = px0; ventanaPy0 = py0; ventanaAncho = px1 - px0 + 1;
  const n = ventanaAncho * (py1 - py0 + 1);
  if (ventana.length < n) ventana = new Int32Array(crecer(ventana.length, n));
  for (let py = py0; py <= py1; py++) for (let px = px0; px <= px1; px++) ventana[(py - py0) * ventanaAncho + (px - px0)] = buscarPagina(vista, px, py);
}
function celdaVentana(vista: VistaFauna, x: number, y: number): number {
  const slot = ventana[((y >> 4) - ventanaPy0) * ventanaAncho + ((x >> 4) - ventanaPx0)]!;
  if (slot < 0) return -1;
  const celda = slot * CELDAS_POR_PAGINA + ((y & 15) << 4) + (x & 15);
  return vista.flags[celda]! & CELDA_PRESENTE ? celda : -1;
}

/** `habitat(animal, tile)`. */
const habitat = (pez: boolean, flags: number): boolean => pez ? (flags & CELDA_AGUA) !== 0 : (flags & (CELDA_AGUA | CELDA_REFUGIO)) === 0;
/** `edible(depredador, presa)`: sólo especie y carnivoría del depredador; `!(c < 0.6)` conserva NaN. */
function comestible(especieDepredador: number, carnivoria: number, especiePresa: number): boolean {
  if (carnivoria < 0.6 || especieDepredador === especiePresa) return false;
  return especieDepredador === LOBO ? especiePresa === LIEBRE || especiePresa === CIERVO || especiePresa === JABALI || especiePresa === ZORRO
    : especieDepredador === ZORRO ? especiePresa === LIEBRE : false;
}
/** `waterAt(animal, tile)`. */
const aguaEn = (vista: VistaFauna, pez: boolean, celda: number): number =>
  pez ? vista.humedad[celda]! : vista.flags[celda]! & CELDA_OCEANO ? 0 : vista.aguaPotable[celda]!;
/** `tile.growth ?? 0`. */
const crecimientoO0 = (vista: VistaFauna, celda: number): number => vista.flags[celda]! & CELDA_CRECIMIENTO ? vista.crecimiento[celda]! : 0;
/** `tile.growth ?? tile.vegetation`. */
const alimentoEn = (vista: VistaFauna, celda: number): number =>
  vista.flags[celda]! & CELDA_CRECIMIENTO ? vista.crecimiento[celda]! : vista.vegetacion[celda]!;

// ── `choose` por animal ────────────────────────────────────────────────────────────────

/** Decisión completa de un animal debido: escribe solo su fila de salida. */
export function decidirAnimal(vista: VistaFauna, slot: number): void {
  const { df, di, tf, ti, so, params } = vista, cap = params.capDue, tick = params.tick;
  const ax = df[DF.x * cap + slot]!, ay = df[DF.y * cap + slot]!;
  const percepcion = df[DF.perception * cap + slot]!, carnivoria = df[DF.carnivory * cap + slot]!;
  const especie = di[DI.especie * cap + slot]!, rangoPropio = di[DI.rango * cap + slot]!, pez = especie === PEZ;
  const distancia = (x: number, y: number): number => Math.abs(x - ax) + Math.abs(y - ay);

  // `localTiles`.
  const radio = 2 + Math.floor(percepcion * 4);
  let visibles = 0;
  if (radio >= 0) {
    asegurarVisibles(2 * radio * radio + 2 * radio + 1);
    cargarVentana(vista, ax, ay, radio);
    for (let dy = -radio; dy <= radio; dy++) for (let dx = -radio; dx <= radio; dx++) {
      if (Math.abs(dx) + Math.abs(dy) > radio) continue;
      const x = ax + dx, y = ay + dy, celda = celdaVentana(vista, x, y);
      if (celda < 0 || !habitat(pez, vista.flags[celda]!)) continue;
      visX[visibles] = x; visY[visibles] = y; visCelda[visibles] = celda; visibles++;
    }
  }

  // `near`: ocupantes vivos de lo visible, sin el propio id.
  let numCercanos = 0;
  const capT = params.capTabla;
  for (let v = 0; v < visibles; v++) {
    const celda = visCelda[v]!, inicio = vista.inicio[celda]!, fin = inicio + vista.cuenta[celda]!;
    asegurarCercanos(numCercanos + fin - inicio);
    for (let k = inicio; k < fin; k++) {
      const fila = vista.ocupantes[k]!;
      if (ti[TI.rango * capT + fila] !== rangoPropio && tf[TF.health * capT + fila]! > 0) cercanos[numCercanos++] = fila;
    }
  }
  // `threats`: sólo importan sus posiciones (`safety` toma el mínimo).
  const alcanceAmenaza = 1 + Math.floor(percepcion * 5);
  let amenazas = 0;
  for (let i = 0; i < numCercanos; i++) {
    const fila = cercanos[i]!, x = tf[TF.x * capT + fila]!, y = tf[TF.y * capT + fila]!;
    if (!comestible(ti[TI.especie * capT + fila]!, tf[TF.carnivory * capT + fila]!, especie) || !(distancia(x, y) <= alcanceAmenaza)) continue;
    asegurarAmenazas(amenazas + 1);
    amenazaX[amenazas] = x; amenazaY[amenazas] = y; amenazas++;
  }
  // `adjacent`.
  for (let v = 0; v < visibles; v++) {
    visAdyacente[v] = distancia(visX[v]!, visY[v]!) === 1 && vista.ocupados[visCelda[v]!]! < MAX_ANIMALES_POR_CELDA ? 1 : 0;
  }

  // Memoria local (copia de la de entrada).
  const capM = params.capMemoria, base = slot * capM;
  let memorias = di[DI.memorias * cap + slot]!;
  asegurarMemoria(memorias + 2);
  for (let k = 0; k < memorias; k++) {
    const o = (base + k) * NMF;
    memX[k] = vista.mf[o + MF.x]!; memY[k] = vista.mf[o + MF.y]!; memT[k] = vista.mf[o + MF.tick]!;
    memF[k] = vista.mf[o + MF.food]!; memW[k] = vista.mf[o + MF.water]!; memV[k] = vista.mv[base + k]!;
  }
  /** `remember(animal, tile, tick, visited)` sobre la copia local. */
  const recordar = (v: number, visitado: boolean): void => {
    const tx = visX[v]!, ty = visY[v]!, celda = visCelda[v]!;
    let existente = false;
    for (let k = 0; k < memorias; k++) if (memX[k] === tx && memY[k] === ty) { existente = memV[k] === 1; break; }
    let n = 0;
    for (let k = 0; k < memorias; k++) {
      if ((memX[k] === tx && memY[k] === ty) || !(tick - memT[k]! <= MEMORIA_TTL)) continue;
      memX[n] = memX[k]!; memY[n] = memY[k]!; memT[n] = memT[k]!; memF[n] = memF[k]!; memW[n] = memW[k]!; memV[n] = memV[k]!; n++;
    }
    memX[n] = tx; memY[n] = ty; memT[n] = tick; memF[n] = alimentoEn(vista, celda); memW[n] = aguaEn(vista, pez, celda);
    memV[n] = visitado || existente ? 1 : 0; n++;
    if (n > MAX_MEMORIA_ANIMAL) {
      for (let k = 1; k < n; k++) { memX[k - 1] = memX[k]!; memY[k - 1] = memY[k]!; memT[k - 1] = memT[k]!; memF[k - 1] = memF[k]!; memW[k - 1] = memW[k]!; memV[k - 1] = memV[k]!; }
      n--;
    }
    memorias = n;
  };

  // `primerosDos(visible, …)` literal y sus `remember`.
  const comparaRecuerdo = (a: number, b: number): number => {
    const ca = visCelda[a]!, cb = visCelda[b]!;
    return (aguaEn(vista, pez, cb) + crecimientoO0(vista, cb)) - (aguaEn(vista, pez, ca) + crecimientoO0(vista, ca))
      || distancia(visX[a]!, visY[a]!) - distancia(visX[b]!, visY[b]!) || visY[a]! - visY[b]! || visX[a]! - visX[b]!;
  };
  let primero = -1, segundo = -1, cuantos = 0;
  for (let v = 0; v < visibles; v++) {
    const celda = visCelda[v]!;
    if (!(crecimientoO0(vista, celda) > 0.05 || aguaEn(vista, pez, celda) > 0.005)) continue;
    if (cuantos === 0) { primero = v; cuantos = 1; }
    else if (comparaRecuerdo(v, primero) < 0) { segundo = primero; primero = v; cuantos = Math.min(2, cuantos + 1); }
    else if (cuantos === 1 || comparaRecuerdo(v, segundo) < 0) { segundo = v; cuantos = 2; }
  }
  const o = slot * NSO;
  so[o + SO.recuerdos] = cuantos;
  so[o + SO.recuerdo0Tesela] = -1; so[o + SO.recuerdo0Visitado] = 0; so[o + SO.recuerdo1Tesela] = -1; so[o + SO.recuerdo1Visitado] = 0;
  if (cuantos >= 1) {
    const visitado = distancia(visX[primero]!, visY[primero]!) === 0;
    so[o + SO.recuerdo0Tesela] = vista.tesela[visCelda[primero]!]!; so[o + SO.recuerdo0Visitado] = visitado ? 1 : 0;
    recordar(primero, visitado);
  }
  if (cuantos === 2) {
    const visitado = distancia(visX[segundo]!, visY[segundo]!) === 0;
    so[o + SO.recuerdo1Tesela] = vista.tesela[visCelda[segundo]!]!; so[o + SO.recuerdo1Visitado] = visitado ? 1 : 0;
    recordar(segundo, visitado);
  }

  let accion: number = ACCION_FAUNA.roam, destinoTipo = DESTINO_PROPIO, destinoRef = -1, presa = -1;
  const destinoVisible = (v: number): void => { destinoTipo = DESTINO_TESELA; destinoRef = vista.tesela[visCelda[v]!]!; };
  if (amenazas) {
    const seguridad = (x: number, y: number): number => {
      let min = Infinity;
      for (let i = 0; i < amenazas; i++) min = Math.min(min, Math.abs(amenazaX[i]! - x) + Math.abs(amenazaY[i]! - y));
      return min;
    };
    let escape = -1, seguridadEscape = 0;
    for (let v = 0; v < visibles; v++) {
      if (!visAdyacente[v]) continue;
      const s = seguridad(visX[v]!, visY[v]!);
      if (escape < 0 || (seguridadEscape - s || visY[v]! - visY[escape]! || visX[v]! - visX[escape]!) < 0) { escape = v; seguridadEscape = s; }
    }
    accion = ACCION_FAUNA.flee;
    if (escape >= 0 && seguridadEscape > seguridad(ax, ay)) destinoVisible(escape);
  } else {
    // `resources`: lo visible y los recuerdos vigentes, con tesela, fuera de lo visible.
    asegurarRecursos(visibles + memorias);
    let recursos = 0;
    for (let v = 0; v < visibles; v++) {
      const celda = visCelda[v]!;
      recRef[recursos] = -1 - v; recX[recursos] = visX[v]!; recY[recursos] = visY[v]!;
      recF[recursos] = alimentoEn(vista, celda); recW[recursos] = aguaEn(vista, pez, celda); recursos++;
    }
    for (let k = 0; k < memorias; k++) {
      const mx = memX[k]!, my = memY[k]!;
      if (!(tick - memT[k]! <= MEMORIA_TTL)) continue;
      const celda = celdaDe(vista, mx, my);
      if (celda < 0) continue;
      // `visibleCells.has(cell(m))`: el recuerdo cae en el rombo sobre una tesela del hábitat.
      if (distancia(mx, my) <= radio && habitat(pez, vista.flags[celda]!)) continue;
      recRef[recursos] = k; recX[recursos] = mx; recY[recursos] = my; recF[recursos] = memF[k]!; recW[recursos] = memW[k]!; recursos++;
    }
    let agua = -1, comida = -1;
    for (let r = 0; r < recursos; r++) {
      const x = recX[r]!, y = recY[r]!;
      if (recW[r]! > 0.001 && (agua < 0 || (distancia(x, y) - distancia(recX[agua]!, recY[agua]!) || recW[agua]! - recW[r]!
        || y - recY[agua]! || x - recX[agua]!) < 0)) agua = r;
      if (recF[r]! > 0.001 && (comida < 0 || (distancia(x, y) - distancia(recX[comida]!, recY[comida]!) || recF[comida]! - recF[r]!
        || y - recY[comida]! || x - recX[comida]!) < 0)) comida = r;
    }
    for (let i = 0; i < numCercanos; i++) {
      const fila = cercanos[i]!;
      if (!comestible(especie, carnivoria, ti[TI.especie * capT + fila]!)) continue;
      if (presa < 0) { presa = fila; continue; }
      const d = distancia(tf[TF.x * capT + fila]!, tf[TF.y * capT + fila]!) - distancia(tf[TF.x * capT + presa]!, tf[TF.y * capT + presa]!);
      const ra = ti[TI.rango * capT + fila]!, rb = ti[TI.rango * capT + presa]!;
      if ((d || (ra < rb ? -1 : ra > rb ? 1 : 0)) < 0) presa = fila;
    }
    const destinoRecurso = (r: number): void => {
      const ref = recRef[r]!;
      if (ref < 0) destinoVisible(-1 - ref); else { destinoTipo = DESTINO_RECUERDO; destinoRef = ref; }
    };
    const hunger = df[DF.hunger * cap + slot]!, thirst = df[DF.thirst * cap + slot]!;
    if (thirst > 0.42 && agua >= 0) { accion = ACCION_FAUNA.drink; destinoRecurso(agua); presa = -1; }
    else if (hunger > 0.38 && presa >= 0) { accion = ACCION_FAUNA.hunt; destinoTipo = DESTINO_PRESA; destinoRef = presa; }
    else {
      presa = -1;
      if (hunger > 0.38 && carnivoria < 0.6 && comida >= 0) { accion = ACCION_FAUNA.graze; destinoRecurso(comida); }
      else if (df[DF.energy * cap + slot]! < 0.4 || df[DF.fatigue * cap + slot]! > 0.55) accion = ACCION_FAUNA.rest;
      else {
        // Novedad de cada adyacente (`novelty`), con la cadena exacta del `hash` real.
        let id = '';
        const idInicio = di[DI.idInicio * cap + slot]!, idFin = idInicio + di[DI.idLongitud * cap + slot]!;
        for (let k = idInicio; k < idFin; k++) id += String.fromCharCode(vista.id[k]!);
        const bucket = Math.floor(tick / 60);
        const novedad = (v: number): number => {
          const x = visX[v]!, y = visY[v]!;
          let visita = -1;
          for (let k = 0; k < memorias; k++) if (memV[k] && memX[k] === x && memY[k] === y) { visita = k; break; }
          return (visita >= 0 ? Math.min(1, (tick - memT[visita]!) / MEMORIA_TTL) : 2) + hashFauna(params.seed, `${id}:${x},${y}:${bucket}`) / 4294967296 * 0.2;
        };
        let mejor = -1, mejorNovedad = 0;
        for (let v = 0; v < visibles; v++) {
          if (!visAdyacente[v]) continue;
          const n = novedad(v);
          if (mejor < 0 || (mejorNovedad - n || visY[v]! - visY[mejor]! || visX[v]! - visX[mejor]!) < 0) { mejor = v; mejorNovedad = n; }
        }
        if (mejor >= 0) destinoVisible(mejor);
      }
    }
  }
  so[o + SO.accion] = accion; so[o + SO.destinoTipo] = destinoTipo; so[o + SO.destinoRef] = destinoRef;
  so[o + SO.presa] = accion === ACCION_FAUNA.hunt ? presa : -1;
}

/** Ejecuta `choose` sobre los rangos `[begin, end)` de los animales debidos de `regiones[desde, hasta)`. */
export function ejecutarRegionesFauna(vista: VistaFauna, regiones: readonly StaticRegion[], desde = 0, hasta = regiones.length): void {
  for (let r = desde; r < hasta; r++) {
    const region = regiones[r]!;
    for (let slot = region.begin; slot < region.end; slot++) decidirAnimal(vista, slot);
  }
}

/** Export del worker para `StaticWorkerPool`. */
export function faunaChooseWorker(job: StaticWorkerHandlerJob<ParamsFauna>): void {
  ejecutarRegionesFauna(crearVistaFauna(job.buffers, job.params), job.regions);
}
