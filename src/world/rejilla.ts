import type { Person, World } from './index.js';

/**
 * Rejilla efímera de personas (T141): la vía de las consultas «vecinos a ≤ r» del camino de decisión.
 * Sólo existe dentro de `conRejilla` (lo abre `stepWorld`): fuera de un paso las consultas son el
 * recorrido lineal de siempre, para que una mutación manual nunca deje un índice obsoleto.
 *   vecinos      ≡ world.people.filter(pred)   (mismos objetos, orden de slot)
 *   primerVecino ≡ world.people.find(pred)     (el menor slot que cumple)
 * siempre que `pred` implique |Δx| ≤ alcance y |Δy| ≤ alcance (los llamadores dan radio + 1). Cada
 * celda de `LADO` casillas enlaza sus slots en orden creciente y la consulta fusiona esas listas con
 * un montículo; el predicado se evalúa con las posiciones actuales.
 * Se construye en O(P) en la primera consulta del paso y sigue exacta porque dentro del paso:
 * `move` es el único escritor de x/y y avisa con `personaMovida` (reubica el slot en orden); un
 * nacimiento sólo alarga el arreglo (se anexan los slots nuevos); una muerte lo reemplaza entero
 * (identidad nueva ⇒ se reconstruye). Coordenadas no finitas, personas repetidas o un rango con más
 * casillas que habitantes caen al recorrido lineal, idéntico por definición. Nada de esto entra en el
 * mundo ni en su digesto.
 */
const LADO = 4;
const MAXIMO = 2 ** 23;
const VACIO = -1;

export interface CentroRejilla { readonly x: number; readonly y: number }
export type PredicadoPersona = (person: Person) => boolean;

interface Indice {
  people: Person[];
  length: number;
  valido: boolean;
  celdas: Map<number, number>;
  cabezas: Int32Array;
  colas: Int32Array;
  siguiente: Int32Array;
  anterior: Int32Array;
  celdaPorSlot: Int32Array;
  slotPorPersona: Map<Person, number>;
}

interface Ambito { profundidad: number; indice?: Indice }

const ambitos = new WeakMap<World, Ambito>();
const desactivadas = new WeakMap<World, number>();
const contadores = new WeakMap<World, Map<string, number>>();

const casilla = (value: number): number => Math.floor(value / LADO);
const clave = (cx: number, cy: number): number => (cx + MAXIMO) * (2 * MAXIMO) + (cy + MAXIMO);
const coordenadaValida = (value: number): boolean => Number.isFinite(value) && Math.abs(casilla(value)) < MAXIMO;

function enteros(capacidad: number): Int32Array {
  const result = new Int32Array(Math.max(1, capacidad));
  result.fill(VACIO);
  return result;
}

function ampliar(source: Int32Array, capacidad: number): Int32Array {
  if (source.length >= capacidad) return source;
  let length = source.length;
  while (length < capacidad) length *= 2;
  const result = enteros(length);
  result.set(source);
  return result;
}

function asegurarCeldas(indice: Indice, capacidad: number): void {
  indice.cabezas = ampliar(indice.cabezas, capacidad);
  indice.colas = ampliar(indice.colas, capacidad);
}

function asegurarSlots(indice: Indice, capacidad: number): void {
  indice.siguiente = ampliar(indice.siguiente, capacidad);
  indice.anterior = ampliar(indice.anterior, capacidad);
  indice.celdaPorSlot = ampliar(indice.celdaPorSlot, capacidad);
}

function celdaDe(indice: Indice, person: Person): number | undefined {
  if (!coordenadaValida(person.x) || !coordenadaValida(person.y)) return;
  const key = clave(casilla(person.x), casilla(person.y));
  let cell = indice.celdas.get(key);
  if (cell === undefined) {
    cell = indice.celdas.size;
    asegurarCeldas(indice, cell + 1);
    indice.celdas.set(key, cell);
  }
  return cell;
}

function anexar(indice: Indice, slot: number, person: Person): boolean {
  if (indice.slotPorPersona.has(person)) return false;
  const cell = celdaDe(indice, person);
  if (cell === undefined) return false;
  asegurarSlots(indice, slot + 1);
  const tail = indice.colas[cell]!;
  indice.celdaPorSlot[slot] = cell;
  indice.anterior[slot] = tail;
  indice.siguiente[slot] = VACIO;
  if (tail === VACIO) indice.cabezas[cell] = slot;
  else indice.siguiente[tail] = slot;
  indice.colas[cell] = slot;
  indice.slotPorPersona.set(person, slot);
  return true;
}

function construir(people: Person[]): Indice {
  const indice: Indice = {
    people,
    length: 0,
    valido: true,
    celdas: new Map(),
    cabezas: enteros(Math.min(Math.max(1, people.length), 16)),
    colas: enteros(Math.min(Math.max(1, people.length), 16)),
    siguiente: enteros(people.length),
    anterior: enteros(people.length),
    celdaPorSlot: enteros(people.length),
    slotPorPersona: new Map(),
  };
  for (let slot = 0; slot < people.length; slot++) {
    const person = people[slot];
    if (!(slot in people) || !person || typeof person !== 'object' || !anexar(indice, slot, person)) {
      indice.valido = false;
      break;
    }
    indice.length++;
  }
  indice.length = people.length;
  return indice;
}

function sincronizar(world: World, ambito: Ambito): Indice {
  let indice = ambito.indice;
  if (!indice || indice.people !== world.people || world.people.length < indice.length) {
    indice = construir(world.people);
    ambito.indice = indice;
    return indice;
  }
  if (world.people.length > indice.length) {
    if (indice.valido) for (let slot = indice.length; slot < world.people.length; slot++) {
      const person = world.people[slot];
      if (!(slot in world.people) || !person || typeof person !== 'object' || !anexar(indice, slot, person)) {
        indice.valido = false;
        break;
      }
    }
    indice.length = world.people.length;
  }
  return indice;
}

interface Rango { x0: number; x1: number; y0: number; y1: number }

function rango(centro: CentroRejilla, alcance: number, poblacion: number): Rango | undefined {
  if (!(Number.isFinite(centro.x) && Number.isFinite(centro.y) && Number.isFinite(alcance) && alcance >= 0)) return;
  const x0 = casilla(centro.x - alcance), x1 = casilla(centro.x + alcance);
  const y0 = casilla(centro.y - alcance), y1 = casilla(centro.y + alcance);
  if (!(Math.abs(x0) < MAXIMO && Math.abs(x1) < MAXIMO && Math.abs(y0) < MAXIMO && Math.abs(y1) < MAXIMO)) return;
  const columnas = x1 - x0 + 1, filas = y1 - y0 + 1;
  // Un radio grande o una población dispersa no puede costar más que el filtro original.
  if (columnas * filas > Math.max(1, poblacion)) return;
  return { x0, x1, y0, y1 };
}

function subir(heap: number[], value: number): void {
  let index = heap.length;
  heap.push(value);
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (heap[parent]! <= value) break;
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = value;
}

function extraer(heap: number[]): number {
  const first = heap[0]!, last = heap.pop()!;
  if (heap.length === 0) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && heap[right]! < heap[left]! ? right : left;
    if (heap[child]! >= last) break;
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = last;
  return first;
}

function candidatas(indice: Indice, range: Rango): number[] {
  const heap: number[] = [];
  for (let cx = range.x0; cx <= range.x1; cx++) for (let cy = range.y0; cy <= range.y1; cy++) {
    const cell = indice.celdas.get(clave(cx, cy));
    if (cell === undefined) continue;
    const head = indice.cabezas[cell]!;
    if (head !== VACIO) subir(heap, head);
  }
  return heap;
}

// Sólo cuenta si una prueba lo pidió (`reiniciarConsultasRejillaParaPruebas`): el paso no paga el recuento.
function registrar(world: World, etiqueta: string | undefined): void {
  const worldCounters = etiqueta ? contadores.get(world) : undefined;
  if (worldCounters) worldCounters.set(etiqueta!, (worldCounters.get(etiqueta!) ?? 0) + 1);
}

export function conRejilla<R>(world: World, fn: () => R): R {
  let ambito = ambitos.get(world);
  if (!ambito) { ambito = { profundidad: 0 }; ambitos.set(world, ambito); }
  ambito.profundidad++;
  try { return fn(); }
  finally {
    ambito.profundidad--;
    if (ambito.profundidad === 0) ambitos.delete(world);
  }
}

export function vecinos(world: World, centro: CentroRejilla, alcance: number, pred: PredicadoPersona, etiqueta?: string): Person[] {
  const ambito = ambitos.get(world);
  if (!ambito || (desactivadas.get(world) ?? 0) > 0) return world.people.filter(pred);
  const indice = sincronizar(world, ambito), range = indice.valido ? rango(centro, alcance, world.people.length) : undefined;
  if (!range) return world.people.filter(pred);
  registrar(world, etiqueta);
  const heap = candidatas(indice, range), result: Person[] = [];
  while (heap.length) {
    const slot = extraer(heap), next = indice.siguiente[slot]!;
    if (pred(world.people[slot]!)) result.push(world.people[slot]!);
    if (next !== VACIO) subir(heap, next);
  }
  return result;
}

export function primerVecino(world: World, centro: CentroRejilla, alcance: number, pred: PredicadoPersona, etiqueta?: string): Person | undefined {
  const ambito = ambitos.get(world);
  if (!ambito || (desactivadas.get(world) ?? 0) > 0) return world.people.find(pred);
  const indice = sincronizar(world, ambito), range = indice.valido ? rango(centro, alcance, world.people.length) : undefined;
  if (!range) return world.people.find(pred);
  registrar(world, etiqueta);
  const heap = candidatas(indice, range);
  while (heap.length) {
    const slot = extraer(heap), next = indice.siguiente[slot]!;
    if (pred(world.people[slot]!)) return world.people[slot];
    if (next !== VACIO) subir(heap, next);
  }
  return undefined;
}

/** Notifica el único cambio de posición del motor, después de escribir `x`/`y`. */
export function personaMovida(world: World, person: Person): void {
  const ambito = ambitos.get(world);
  if (!ambito?.indice || (desactivadas.get(world) ?? 0) > 0) return;
  const indice = sincronizar(world, ambito);
  if (!indice.valido) return;
  const slot = indice.slotPorPersona.get(person);
  if (slot === undefined || indice.people[slot] !== person) { indice.valido = false; return; }
  const destination = celdaDe(indice, person);
  if (destination === undefined) { indice.valido = false; return; }
  const origin = indice.celdaPorSlot[slot]!;
  if (origin === destination) return;

  const previous = indice.anterior[slot]!, next = indice.siguiente[slot]!;
  if (previous === VACIO) indice.cabezas[origin] = next; else indice.siguiente[previous] = next;
  if (next === VACIO) indice.colas[origin] = previous; else indice.anterior[next] = previous;

  let before = VACIO, after = indice.cabezas[destination]!;
  while (after !== VACIO && after < slot) { before = after; after = indice.siguiente[after]!; }
  indice.celdaPorSlot[slot] = destination;
  indice.anterior[slot] = before;
  indice.siguiente[slot] = after;
  if (before === VACIO) indice.cabezas[destination] = slot; else indice.siguiente[before] = slot;
  if (after === VACIO) indice.colas[destination] = slot; else indice.anterior[after] = slot;
}

/** Ganchos de prueba: nunca forman parte del mundo ni de su digesto. */
export function sinRejillaParaPruebas<R>(world: World, fn: () => R): R {
  desactivadas.set(world, (desactivadas.get(world) ?? 0) + 1);
  try { return fn(); }
  finally {
    const depth = (desactivadas.get(world) ?? 1) - 1;
    if (depth === 0) desactivadas.delete(world); else desactivadas.set(world, depth);
  }
}

export function reiniciarConsultasRejillaParaPruebas(world: World): void { contadores.set(world, new Map()); }
export function consultasRejillaParaPruebas(world: World): ReadonlyMap<string, number> { return new Map(contadores.get(world)); }
