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

/** Rango de casillas [x0, x1] × [y0, y1] que contiene todo punto a ≤ `alcance` en cada eje de `centro`,
 * o `null` para recorrer el arreglo entero. */
interface Rango { mapa: Map<number, number[]>; x0: number; x1: number; y0: number; y1: number }
function rango(puntos: readonly Punto[], centro: Punto, alcance: number): Rango | null {
  const mapa = celdas(puntos);
  if (!mapa || !(Number.isFinite(centro.x) && Number.isFinite(centro.y) && Number.isFinite(alcance) && alcance >= 0)) return null;
  // |p − c| ≤ a  ⇒  casilla(c − a) ≤ casilla(p) ≤ casilla(c + a) (floor es monótona).
  const x0 = casilla(centro.x - alcance), x1 = casilla(centro.x + alcance), y0 = casilla(centro.y - alcance), y1 = casilla(centro.y + alcance);
  if (!(Math.abs(x0) < MAXIMO && Math.abs(x1) < MAXIMO && Math.abs(y0) < MAXIMO && Math.abs(y1) < MAXIMO)) return null;
  return { mapa, x0, x1, y0, y1 };
}

export function algunoCerca<T extends Punto>(puntos: readonly T[], centro: Punto, alcance: number, pred: (punto: T) => boolean): boolean {
  const r = rango(puntos, centro, alcance);
  if (!r) return puntos.some(punto => pred(punto));
  for (let cx = r.x0; cx <= r.x1; cx++) for (let cy = r.y0; cy <= r.y1; cy++) {
    const lista = r.mapa.get(clave(cx, cy));
    if (lista) for (const i of lista) if (pred(puntos[i]!)) return true;
  }
  return false;
}
export function primeroCerca<T extends Punto>(puntos: readonly T[], centro: Punto, alcance: number, pred: (punto: T) => boolean): T | undefined {
  const r = rango(puntos, centro, alcance);
  if (!r) return puntos.find(punto => pred(punto));
  let mejor = -1;
  for (let cx = r.x0; cx <= r.x1; cx++) for (let cy = r.y0; cy <= r.y1; cy++) {
    const lista = r.mapa.get(clave(cx, cy));
    if (lista) for (const i of lista) {
      if (mejor >= 0 && i >= mejor) break; // lista creciente: nada de aquí mejora lo hallado
      if (pred(puntos[i]!)) { mejor = i; break; }
    }
  }
  return mejor >= 0 ? puntos[mejor] : undefined;
}
export function filtrarCerca<T extends Punto>(puntos: readonly T[], centro: Punto, alcance: number, pred: (punto: T) => boolean): T[] {
  const r = rango(puntos, centro, alcance);
  if (!r) return puntos.filter(punto => pred(punto));
  const posiciones: number[] = [];
  for (let cx = r.x0; cx <= r.x1; cx++) for (let cy = r.y0; cy <= r.y1; cy++) {
    const lista = r.mapa.get(clave(cx, cy));
    if (lista) for (const i of lista) if (pred(puntos[i]!)) posiciones.push(i);
  }
  if (posiciones.length > 1) posiciones.sort((a, b) => a - b);
  return posiciones.map(i => puntos[i]!);
}
