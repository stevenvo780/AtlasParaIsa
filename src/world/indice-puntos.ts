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
 * |Δy| ≤ alcance (los llamadores dan el radio + 1, así el redondeo de `Math.hypot` no importa). Los
 * candidatos se visitan en orden creciente de posición, así que:
 *   algunoCerca  = arreglo.some(pred)     (predicado puro: el orden no cambia la respuesta)
 *   primeroCerca = arreglo.find(pred)     (el primero en el orden del arreglo)
 *   filtrarCerca = arreglo.filter(pred)   (mismos elementos, mismo orden: sumas y sort estable iguales)
 * Si algún elemento no es un objeto con coordenadas numéricas finitas (o fuera de ±2^23 casillas), o la
 * consulta no es finita, se recorre el arreglo entero como siempre.
 */
export interface Punto { readonly x: number; readonly y: number }

const LADO = 8;
const MAXIMO = 2 ** 23;
interface Indice { length: number; celdas: Map<number, number[]> | null }
const indices = new WeakMap<readonly Punto[], Indice>();
// LADO es potencia de dos: la división es exacta y la casilla también.
const casilla = (v: number): number => Math.floor(v / LADO);
const clave = (cx: number, cy: number): number => (cx + MAXIMO) * (2 * MAXIMO) + (cy + MAXIMO);

function celdas(puntos: readonly Punto[]): Map<number, number[]> | null {
  let indice = indices.get(puntos);
  if (!indice || indice.length !== puntos.length) {
    let mapa: Map<number, number[]> | null = new Map();
    for (let i = 0; i < puntos.length; i++) {
      const punto = puntos[i];
      if (!(i in puntos) || !punto || typeof punto !== 'object' || typeof punto.x !== 'number' || typeof punto.y !== 'number') { mapa = null; break; }
      const cx = casilla(punto.x), cy = casilla(punto.y);
      if (!(Math.abs(cx) < MAXIMO && Math.abs(cy) < MAXIMO)) { mapa = null; break; }
      const k = clave(cx, cy), lista = mapa.get(k);
      if (lista) lista.push(i); else mapa.set(k, [i]);
    }
    indice = { length: puntos.length, celdas: mapa };
    indices.set(puntos, indice);
  }
  return indice.celdas;
}

/** Posiciones (en orden creciente) de todo punto a ≤ `alcance` en cada eje de `centro`, y quizá otras. */
function candidatos(puntos: readonly Punto[], centro: Punto, alcance: number): number[] | null {
  const mapa = celdas(puntos);
  if (!mapa || !(Number.isFinite(centro.x) && Number.isFinite(centro.y) && Number.isFinite(alcance) && alcance >= 0)) return null;
  // |p − c| ≤ a  ⇒  |casilla(p) − casilla(c)| ≤ ⌊a / LADO⌋ + 1.
  const k = Math.floor(alcance / LADO) + 1, cx = casilla(centro.x), cy = casilla(centro.y);
  if (!(Math.abs(cx) + k < MAXIMO && Math.abs(cy) + k < MAXIMO)) return null;
  const salida: number[] = [];
  for (let dx = -k; dx <= k; dx++) for (let dy = -k; dy <= k; dy++) {
    const lista = mapa.get(clave(cx + dx, cy + dy));
    if (lista) for (const i of lista) salida.push(i);
  }
  return salida.sort((a, b) => a - b);
}

export function algunoCerca<T extends Punto>(puntos: readonly T[], centro: Punto, alcance: number, pred: (punto: T) => boolean): boolean {
  const lista = candidatos(puntos, centro, alcance);
  if (!lista) return puntos.some(punto => pred(punto));
  for (const i of lista) if (pred(puntos[i]!)) return true;
  return false;
}
export function primeroCerca<T extends Punto>(puntos: readonly T[], centro: Punto, alcance: number, pred: (punto: T) => boolean): T | undefined {
  const lista = candidatos(puntos, centro, alcance);
  if (!lista) return puntos.find(punto => pred(punto));
  for (const i of lista) if (pred(puntos[i]!)) return puntos[i];
  return undefined;
}
export function filtrarCerca<T extends Punto>(puntos: readonly T[], centro: Punto, alcance: number, pred: (punto: T) => boolean): T[] {
  const lista = candidatos(puntos, centro, alcance);
  if (!lista) return puntos.filter(punto => pred(punto));
  const salida: T[] = [];
  for (const i of lista) if (pred(puntos[i]!)) salida.push(puntos[i]!);
  return salida;
}
