import type { Animal } from './animals.js';

interface FuenteFauna { animals: Animal[] }
interface Punto { x: number; y: number }
interface IndiceFauna {
  animales: Animal[];
  longitud: number;
  celdas: Map<number, Map<number, Animal[]>>;
  porId: Map<string, Set<Animal[]>>;
}
interface AmbitoFauna { indice?: IndiceFauna }
const ambitos = new WeakMap<FuenteFauna, AmbitoFauna>();

/** Ámbito síncrono de la fase personas, después del movimiento de fauna. Las coordenadas no
 * cambian durante esa fase: sólo se cazan identidades. No hay índice entre pasos ni campos nuevos
 * en el mundo. Una llamada anidada comparte el ámbito exterior y no lo retira al salir. */
export function conIndiceFauna<T>(world: FuenteFauna, ejecutar: () => T): T {
  if (ambitos.has(world)) return ejecutar();
  ambitos.set(world, {});
  try { return ejecutar(); }
  finally { ambitos.delete(world); }
}

function construir(animales: Animal[]): IndiceFauna {
  const celdas = new Map<number, Map<number, Animal[]>>(), porId = new Map<string, Set<Animal[]>>();
  for (const animal of animales) {
    // NaN nunca cumple la igualdad estricta del filtro original. ±0 sí comparten celda.
    if (Number.isNaN(animal.x) || Number.isNaN(animal.y)) continue;
    let columna = celdas.get(animal.x);
    if (!columna) { columna = new Map(); celdas.set(animal.x, columna); }
    let celda = columna.get(animal.y);
    if (!celda) { celda = []; columna.set(animal.y, celda); }
    celda.push(animal); // mismo orden e identidades que animals.filter, incluidos IDs repetidos
    let ubicaciones = porId.get(animal.id);
    if (!ubicaciones) { ubicaciones = new Set(); porId.set(animal.id, ubicaciones); }
    ubicaciones.add(celda);
  }
  return { animales, longitud: animales.length, celdas, porId };
}

/** Exactamente el filtro por coordenadas y salud anterior; el llamador conserva su sort estable.
 * Se construye sólo en la primera consulta. Reemplazar el arreglo o cambiar su longitud fuera de
 * retirarFauna invalida la lectura (por ejemplo, desde un emisor reentrante). */
export function faunaEn(world: FuenteFauna, punto: Punto): Animal[] {
  const cumple = (animal: Animal): boolean => animal.x === punto.x && animal.y === punto.y && animal.health > 0;
  const ambito = ambitos.get(world);
  if (!ambito) return world.animals.filter(cumple);
  if (Number.isNaN(punto.x) || Number.isNaN(punto.y)) return [];
  let indice = ambito.indice;
  if (!indice || indice.animales !== world.animals || indice.longitud !== world.animals.length) {
    indice = construir(world.animals); ambito.indice = indice;
  }
  return indice.celdas.get(punto.x)?.get(punto.y)?.filter(cumple) ?? [];
}

/** Conserva el filter original: se retiran TODAS las identidades con ese ID, no sólo la víctima.
 * Si el arreglo todavía es el indexado, purga únicamente sus celdas y adopta el nuevo arreglo;
 * si el emisor cambió referencia o longitud, la consulta siguiente reconstruye de la fuente real. */
export function retirarFauna(world: FuenteFauna, id: string): void {
  const anteriores = world.animals, ambito = ambitos.get(world), indice = ambito?.indice;
  world.animals = anteriores.filter(animal => animal.id !== id);
  if (!ambito || !indice) return;
  if (indice.animales !== anteriores || indice.longitud !== anteriores.length) {
    ambito.indice = undefined; return;
  }
  for (const celda of indice.porId.get(id) ?? []) {
    let salida = 0;
    for (const animal of celda) if (animal.id !== id) celda[salida++] = animal;
    celda.length = salida;
  }
  indice.porId.delete(id);
  indice.animales = world.animals; indice.longitud = world.animals.length;
}
