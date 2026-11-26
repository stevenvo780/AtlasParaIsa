/**
 * Índice espacial de arreglos de puntos que no se mueven: lugares y estructuras (sprint noche-perf2
 * 2026-09-22). Con ~230 habitantes cada decisión recorría TODOS los lugares (144) y estructuras (134)
 * para quedarse con los que están a pocas celdas: el filtro de obra de `choose` hacía 108 000
 * distancias por paso y `functionalNear` revisaba 131 000 estructuras, y ambos crecen con la población
 * y la edad del mundo (k≈1,9–2,5).
 *
 * El índice agrupa las POSICIONES del arreglo en casillas de `LADO` celdas y va asociado a la identidad
 * y la longitud del arreglo, como `tileAt`: lugares y estructuras sólo crecen por `push` o se
 * reemplazan enteros (`filter` al retirar regiones), y sus coordenadas no cambian nunca. Cada consulta
 * recibe el predicado EXACTO de siempre y un `alcance` tal que el predicado implica |Δx| ≤ alcance y
 * |Δy| ≤ alcance (los llamadores dan el radio + 1, así el redondeo de `Math.hypot` no importa); se miran
 * las casillas de [c − alcance, c + alcance] en cada eje. Dentro de cada casilla las posiciones están en
 * orden creciente, así que:
 *   algunoCerca  = arreglo.some(pred)     (predicado puro: el orden no cambia la respuesta)
 *   primeroCerca = arreglo.find(pred)     (la menor posición que cumple, sin ordenar nada)
 *   filtrarCerca = arreglo.filter(pred)   (mismos elementos, mismo orden: sumas y sort estable iguales)
 * Si algún elemento no es un objeto con coordenadas numéricas finitas (o fuera de ±2^23 casillas), o la
 * consulta no es finita, se recorre el arreglo entero como siempre.
 */
export interface Punto { readonly x: number; readonly y: number }

const LADO = 4;
const MAXIMO = 2 ** 23;
const SPAN = 2 * MAXIMO;
// Clave SMI de 30 bits para casillas en [-16 384, 16 383] (coordenadas en [-65 536, 65 535]):
// evita empaquetar dobles (HeapNumber) en el Map en el 99,99 % de los mundos reales.
const SMI_BIAS = 16_384;
const SMI_SPAN = 32_768;
interface Indice {
  length: number;
  celdas: Map<number, number[]> | null;
  celdasOrdenadas?: Float64Array;
  smi: boolean;
  minCx: number;
  maxCx: number;
  minCy: number;
  maxCy: number;
}
const indices = new WeakMap<readonly Punto[], Indice>();
// Caché de los dos arreglos más consultados (`world.structures` y `world.places`) para evitar el
// lookup del WeakMap en cada consulta (misma regla de invalidación: identidad + longitud).
let memoP1: readonly Punto[] | undefined, memoI1: Indice | undefined;
let memoP2: readonly Punto[] | undefined, memoI2: Indice | undefined;
// Scratch reutilizable de posiciones para `filtrarCerca` (guarda de reentrancia para predicados).
let scratchPos = new Int32Array(256);
let scratchBusy = false;
// LADO es potencia de dos: la división es exacta y la casilla también. Para un entero int32,
// `v >> 2` es la misma división con suelo; cualquier otro número va por la fórmula de siempre.
const casilla = (v: number): number => v === (v | 0) ? v >> 2 : Math.floor(v / LADO);
const clave = (cx: number, cy: number): number => (cx + MAXIMO) * SPAN + (cy + MAXIMO);

function obtenerIndice(puntos: readonly Punto[]): Indice {
  if (puntos === memoP1 && memoI1 && memoI1.length === puntos.length) return memoI1;
  if (puntos === memoP2 && memoI2 && memoI2.length === puntos.length) return memoI2;
  let indice = indices.get(puntos);
  if (!indice || indice.length !== puntos.length) {
    let mapa: Map<number, number[]> | null = new Map();
    let smi = true;
    let minCx = MAXIMO, maxCx = -MAXIMO, minCy = MAXIMO, maxCy = -MAXIMO;
    for (let i = 0; i < puntos.length; i++) {
      const punto = puntos[i];
      if (!(i in puntos) || !punto || typeof punto !== 'object' || typeof punto.x !== 'number' || typeof punto.y !== 'number') { mapa = null; break; }
      const cx = casilla(punto.x), cy = casilla(punto.y);
      if (!(Math.abs(cx) < MAXIMO && Math.abs(cy) < MAXIMO)) { mapa = null; break; }
      if (cx < minCx) minCx = cx;
      if (cx > maxCx) maxCx = cx;
      if (cy < minCy) minCy = cy;
      if (cy > maxCy) maxCy = cy;
      if (smi && (cx < -SMI_BIAS || cx >= SMI_BIAS || cy < -SMI_BIAS || cy >= SMI_BIAS)) {
        const grande = new Map<number, number[]>();
        for (const [oldKey, lista] of mapa) {
          const ocx = (oldKey >>> 15) - SMI_BIAS, ocy = (oldKey & 32767) - SMI_BIAS;
          grande.set(clave(ocx, ocy), lista);
        }
        mapa = grande;
        smi = false;
      }
      const k = smi ? (((cx + SMI_BIAS) << 15) | (cy + SMI_BIAS)) : clave(cx, cy);
      const lista = mapa.get(k);
      if (lista) lista.push(i); else mapa.set(k, [i]);
    }
    indice = { length: puntos.length, celdas: mapa, smi, minCx, maxCx, minCy, maxCy };
    indices.set(puntos, indice);
  }
  memoP2 = memoP1; memoI2 = memoI1;
  memoP1 = puntos; memoI1 = indice;
  return indice;
}

// Los tres recorridos visitan las casillas en el mismo orden `cx` exterior, `cy` interior de
// siempre (el orden de llamada del predicado no cambia), acotando el bucle al rectángulo ocupado
// (saltar casillas vacías no cambia ninguna llamada al predicado) y avanzando la clave por
// incrementos exactos —en SMI de 30 bits cuando todas las casillas caben en [-16 384, 16 383].
export function algunoCerca<T extends Punto>(puntos: readonly T[], centro: Punto, alcance: number, pred: (punto: T) => boolean): boolean {
  if (puntos.length === 0) return false;
  const ind = obtenerIndice(puntos), mapa = ind.celdas;
  if (!mapa || !(Number.isFinite(centro.x) && Number.isFinite(centro.y) && Number.isFinite(alcance) && alcance >= 0)) {
    return puntos.some(punto => pred(punto));
  }
  const x0 = casilla(centro.x - alcance), x1 = casilla(centro.x + alcance);
  const y0 = casilla(centro.y - alcance), y1 = casilla(centro.y + alcance);
  if (!(Math.abs(x0) < MAXIMO && Math.abs(x1) < MAXIMO && Math.abs(y0) < MAXIMO && Math.abs(y1) < MAXIMO)) {
    return puntos.some(punto => pred(punto));
  }
  const cx0 = x0 > ind.minCx ? x0 : ind.minCx, cx1 = x1 < ind.maxCx ? x1 : ind.maxCx;
  const cy0 = y0 > ind.minCy ? y0 : ind.minCy, cy1 = y1 < ind.maxCy ? y1 : ind.maxCy;
  if (cx0 > cx1 || cy0 > cy1) return false;
  const paso = ind.smi ? SMI_SPAN : SPAN;
  let claveFila = ind.smi ? (((cx0 + SMI_BIAS) << 15) | (cy0 + SMI_BIAS)) : clave(cx0, cy0);
  for (let cx = cx0; cx <= cx1; cx++, claveFila += paso) {
    let k = claveFila;
    for (let cy = cy0; cy <= cy1; cy++, k++) {
      const lista = mapa.get(k);
      if (lista) for (let j = 0; j < lista.length; j++) if (pred(puntos[lista[j]!]!)) return true;
    }
  }
  return false;
}
export function primeroCerca<T extends Punto>(puntos: readonly T[], centro: Punto, alcance: number, pred: (punto: T) => boolean): T | undefined {
  if (puntos.length === 0) return undefined;
  const ind = obtenerIndice(puntos), mapa = ind.celdas;
  if (!mapa || !(Number.isFinite(centro.x) && Number.isFinite(centro.y) && Number.isFinite(alcance) && alcance >= 0)) {
    return puntos.find(punto => pred(punto));
  }
  const x0 = casilla(centro.x - alcance), x1 = casilla(centro.x + alcance);
  const y0 = casilla(centro.y - alcance), y1 = casilla(centro.y + alcance);
  if (!(Math.abs(x0) < MAXIMO && Math.abs(x1) < MAXIMO && Math.abs(y0) < MAXIMO && Math.abs(y1) < MAXIMO)) {
    return puntos.find(punto => pred(punto));
  }
  const cx0 = x0 > ind.minCx ? x0 : ind.minCx, cx1 = x1 < ind.maxCx ? x1 : ind.maxCx;
  const cy0 = y0 > ind.minCy ? y0 : ind.minCy, cy1 = y1 < ind.maxCy ? y1 : ind.maxCy;
  if (cx0 > cx1 || cy0 > cy1) return undefined;
  let mejor = -1;
  const paso = ind.smi ? SMI_SPAN : SPAN;
  let claveFila = ind.smi ? (((cx0 + SMI_BIAS) << 15) | (cy0 + SMI_BIAS)) : clave(cx0, cy0);
  for (let cx = cx0; cx <= cx1; cx++, claveFila += paso) {
    let k = claveFila;
    for (let cy = cy0; cy <= cy1; cy++, k++) {
      const lista = mapa.get(k);
      if (lista) for (let j = 0; j < lista.length; j++) {
        const i = lista[j]!;
        if (mejor >= 0 && i >= mejor) break; // lista creciente: nada de aquí mejora lo hallado
        if (pred(puntos[i]!)) { mejor = i; break; }
      }
    }
  }
  return mejor >= 0 ? puntos[mejor] : undefined;
}
/** Optional distinct caller-owned result; default calls still return a fresh mutable array. */
function filtrarEn<T extends Punto>(puntos: readonly T[], pred: (punto: T) => boolean, out?: T[]): T[] {
  const result = out ?? [];
  result.length = 0;
  for (let i = 0; i < puntos.length; i++) if (i in puntos && pred(puntos[i]!)) result.push(puntos[i]!);
  return result;
}

/** En un rectángulo disperso omite las casillas vacías y conserva el orden de llamada del recorrido por filas. */
function filtrarDisperso<T extends Punto>(puntos: readonly T[], mapa: ReadonlyMap<number, number[]>,
  claves: Float64Array, inicio: number, fin: number, paso: number, pred: (punto: T) => boolean, out: T[]): T[] {
  const minColumna = inicio % paso, maxColumna = fin % paso;
  const posiciones: number[] = [];
  for (const k of claves) {
    if (k > fin) break;
    if (k < inicio) continue;
    const columna = k % paso;
    if (columna < minColumna || columna > maxColumna) continue;
    for (const i of mapa.get(k)!) if (pred(puntos[i]!)) posiciones.push(i);
  }
  posiciones.sort((a, b) => a - b);
  out.length = posiciones.length;
  for (let i = 0; i < posiciones.length; i++) out[i] = puntos[posiciones[i]!]!;
  return out;
}

export function filtrarCerca<T extends Punto>(puntos: readonly T[], centro: Punto, alcance: number, pred: (punto: T) => boolean, out?: T[]): T[] {
  if (out) out.length = 0;
  if (puntos.length === 0) return out ?? [];
  const ind = obtenerIndice(puntos), mapa = ind.celdas;
  if (!mapa || !(Number.isFinite(centro.x) && Number.isFinite(centro.y) && Number.isFinite(alcance) && alcance >= 0)) {
    return filtrarEn(puntos, pred, out);
  }
  const x0 = casilla(centro.x - alcance), x1 = casilla(centro.x + alcance);
  const y0 = casilla(centro.y - alcance), y1 = casilla(centro.y + alcance);
  if (!(Math.abs(x0) < MAXIMO && Math.abs(x1) < MAXIMO && Math.abs(y0) < MAXIMO && Math.abs(y1) < MAXIMO)) {
    return filtrarEn(puntos, pred, out);
  }
  const cx0 = x0 > ind.minCx ? x0 : ind.minCx, cx1 = x1 < ind.maxCx ? x1 : ind.maxCx;
  const cy0 = y0 > ind.minCy ? y0 : ind.minCy, cy1 = y1 < ind.maxCy ? y1 : ind.maxCy;
  if (cx0 > cx1 || cy0 > cy1) return out ?? [];
  const paso = ind.smi ? SMI_SPAN : SPAN;
  let claveFila = ind.smi ? (((cx0 + SMI_BIAS) << 15) | (cy0 + SMI_BIAS)) : clave(cx0, cy0);
  // El recorrido disperso comprueba la columna de cada clave. Solo compensa si sobran muchas casillas vacías.
  if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 4 * mapa.size) {
    const claves = ind.celdasOrdenadas ??= Float64Array.from(mapa.keys()).sort();
    const ultima = claveFila + (cx1 - cx0) * paso + cy1 - cy0;
    return filtrarDisperso(puntos, mapa, claves, claveFila, ultima, paso, pred, out ?? []);
  }
  let count = 0, i0 = -1, i1 = -1, ultimo = -1, ordenado = true;
  const useScratch = !scratchBusy;
  let dynPos: number[] | null = null;
  if (useScratch) scratchBusy = true;
  try {
    for (let cx = cx0; cx <= cx1; cx++, claveFila += paso) {
      let k = claveFila;
      for (let cy = cy0; cy <= cy1; cy++, k++) {
        const lista = mapa.get(k);
        if (!lista) continue;
        for (let j = 0; j < lista.length; j++) {
          const i = lista[j]!;
          if (!pred(puntos[i]!)) continue;
          if (count === 0) { i0 = i; ultimo = i; count = 1; }
          else if (count === 1) { i1 = i; if (i < ultimo) ordenado = false; ultimo = i; count = 2; }
          else {
            if (count === 2) {
              if (useScratch) { scratchPos[0] = i0; scratchPos[1] = i1; }
              else dynPos = [i0, i1];
            }
            if (i < ultimo) ordenado = false;
            ultimo = i;
            if (useScratch) {
              if (count >= scratchPos.length) {
                const next = new Int32Array(scratchPos.length * 2);
                next.set(scratchPos);
                scratchPos = next;
              }
              scratchPos[count] = i;
            } else {
              dynPos!.push(i);
            }
            count++;
          }
        }
      }
    }
    const resultado = out ?? new Array<T>(count);
    resultado.length = count;
    if (count === 0) return resultado;
    if (count === 1) { resultado[0] = puntos[i0]!; return resultado; }
    if (count === 2) { resultado[0] = puntos[ordenado ? i0 : i1]!; resultado[1] = puntos[ordenado ? i1 : i0]!; return resultado; }
    if (useScratch) {
      if (!ordenado) {
        if (count <= 32) {
          for (let a = 1; a < count; a++) {
            const v = scratchPos[a]!;
            let b = a - 1;
            while (b >= 0 && scratchPos[b]! > v) { scratchPos[b + 1] = scratchPos[b]!; b--; }
            scratchPos[b + 1] = v;
          }
        } else {
          scratchPos.subarray(0, count).sort();
        }
      }
      for (let j = 0; j < count; j++) resultado[j] = puntos[scratchPos[j]!]!;
    } else {
      if (!ordenado) dynPos!.sort((a, b) => a - b);
      for (let j = 0; j < count; j++) resultado[j] = puntos[dynPos![j]!]!;
    }
    return resultado;
  } finally {
    if (useScratch) scratchBusy = false;
  }
}
