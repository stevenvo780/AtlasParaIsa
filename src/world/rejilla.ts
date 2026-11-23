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
const SPAN = 2 * MAXIMO;
// Clave SMI de 30 bits para casillas en [-16 384, 16 383] (coordenadas en [-65 536, 65 535]):
// evita empaquetar dobles (HeapNumber) en el Map en el 99,99 % de los mundos reales.
const SMI_BIAS = 16_384;
const SMI_SPAN = 32_768;
const VACIO = -1;

export interface CentroRejilla { readonly x: number; readonly y: number }
export type PredicadoPersona = (person: Person) => boolean;

interface Indice {
  people: Person[];
  length: number;
  valido: boolean;
  smi: boolean;
  minCx: number;
  maxCx: number;
  minCy: number;
  maxCy: number;
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
let ultimoMundo: World | undefined, ultimoAmbito: Ambito | undefined;
let desactivadasActivas = 0;
let contadoresActivos = false;
let scratchSlots = new Int32Array(256);
let scratchBusy = false;

const casilla = (v: number): number => v === (v | 0) ? v >> 2 : Math.floor(v / LADO);
const claveGrande = (cx: number, cy: number): number => (cx + MAXIMO) * SPAN + (cy + MAXIMO);

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
  const px = person.x, py = person.y;
  if (!Number.isFinite(px) || !Number.isFinite(py)) return;
  const cx = casilla(px), cy = casilla(py);
  if (!(Math.abs(cx) < MAXIMO && Math.abs(cy) < MAXIMO)) return;
  if (indice.smi && (cx < -SMI_BIAS || cx >= SMI_BIAS || cy < -SMI_BIAS || cy >= SMI_BIAS)) {
    const next = new Map<number, number>();
    for (const [oldKey, c] of indice.celdas) {
      const ocx = (oldKey >>> 15) - SMI_BIAS, ocy = (oldKey & 32767) - SMI_BIAS;
      next.set(claveGrande(ocx, ocy), c);
    }
    indice.celdas = next;
    indice.smi = false;
  }
  const key = indice.smi ? (((cx + SMI_BIAS) << 15) | (cy + SMI_BIAS)) : claveGrande(cx, cy);
  let cell = indice.celdas.get(key);
  if (cell === undefined) {
    cell = indice.celdas.size;
    asegurarCeldas(indice, cell + 1);
    indice.celdas.set(key, cell);
    if (cx < indice.minCx) indice.minCx = cx;
    if (cx > indice.maxCx) indice.maxCx = cx;
    if (cy < indice.minCy) indice.minCy = cy;
    if (cy > indice.maxCy) indice.maxCy = cy;
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
  const initCells = Math.min(Math.max(16, people.length), 1024);
  const indice: Indice = {
    people,
    length: 0,
    valido: true,
    smi: true,
    minCx: MAXIMO,
    maxCx: -MAXIMO,
    minCy: MAXIMO,
    maxCy: -MAXIMO,
    celdas: new Map(),
    cabezas: enteros(initCells),
    colas: enteros(initCells),
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

// Sólo cuenta si una prueba lo pidió (`reiniciarConsultasRejillaParaPruebas`): el paso no paga el recuento.
function registrar(world: World, etiqueta: string | undefined): void {
  const worldCounters = etiqueta ? contadores.get(world) : undefined;
  if (worldCounters) worldCounters.set(etiqueta!, (worldCounters.get(etiqueta!) ?? 0) + 1);
}

export function conRejilla<R>(world: World, fn: () => R): R {
  let ambito = world === ultimoMundo ? ultimoAmbito : ambitos.get(world);
  if (!ambito) { ambito = { profundidad: 0 }; ambitos.set(world, ambito); }
  ultimoMundo = world; ultimoAmbito = ambito;
  ambito.profundidad++;
  try { return fn(); }
  finally {
    ambito.profundidad--;
    if (ambito.profundidad === 0) {
      ambitos.delete(world);
      if (ultimoMundo === world) { ultimoMundo = undefined; ultimoAmbito = undefined; }
    }
  }
}

export function vecinos(world: World, centro: CentroRejilla, alcance: number, pred: PredicadoPersona, etiqueta?: string): Person[] {
  const ambito = world === ultimoMundo ? ultimoAmbito : ambitos.get(world);
  if (!ambito || (desactivadasActivas > 0 && (desactivadas.get(world) ?? 0) > 0)) return world.people.filter(pred);
  const indice = sincronizar(world, ambito), people = world.people;
  const cxCenter = centro.x, cyCenter = centro.y;
  if (!indice.valido || !(Number.isFinite(cxCenter) && Number.isFinite(cyCenter) && Number.isFinite(alcance) && alcance >= 0)) {
    return people.filter(pred);
  }
  const x0 = casilla(cxCenter - alcance), x1 = casilla(cxCenter + alcance);
  const y0 = casilla(cyCenter - alcance), y1 = casilla(cyCenter + alcance);
  if (!(Math.abs(x0) < MAXIMO && Math.abs(x1) < MAXIMO && Math.abs(y0) < MAXIMO && Math.abs(y1) < MAXIMO)) {
    return people.filter(pred);
  }
  // Un radio grande o una población dispersa no puede costar más que el filtro original.
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > Math.max(1, people.length)) return people.filter(pred);
  if (contadoresActivos && etiqueta) registrar(world, etiqueta);
  const cx0 = x0 > indice.minCx ? x0 : indice.minCx, cx1 = x1 < indice.maxCx ? x1 : indice.maxCx;
  const cy0 = y0 > indice.minCy ? y0 : indice.minCy, cy1 = y1 < indice.maxCy ? y1 : indice.maxCy;
  if (cx0 > cx1 || cy0 > cy1) return [];
  const celdas = indice.celdas, cabezas = indice.cabezas, siguiente = indice.siguiente;
  const paso = indice.smi ? SMI_SPAN : SPAN;
  let claveFila = indice.smi ? (((cx0 + SMI_BIAS) << 15) | (cy0 + SMI_BIAS)) : claveGrande(cx0, cy0);
  let count = 0, s0 = -1, s1 = -1, ultimo = -1, ordenado = true;
  const useScratch = !scratchBusy;
  let dynSlots: number[] | null = null;
  if (useScratch) scratchBusy = true;
  try {
    for (let cx = cx0; cx <= cx1; cx++, claveFila += paso) {
      let k = claveFila;
      for (let cy = cy0; cy <= cy1; cy++, k++) {
        const cell = celdas.get(k);
        if (cell === undefined) continue;
        for (let slot = cabezas[cell]!; slot !== VACIO; slot = siguiente[slot]!) {
          const person = people[slot]!;
          if (Math.abs(person.x - cxCenter) > alcance || Math.abs(person.y - cyCenter) > alcance) continue;
          if (!pred(person)) continue;
          if (count === 0) { s0 = slot; ultimo = slot; count = 1; }
          else if (count === 1) { s1 = slot; if (slot < ultimo) ordenado = false; ultimo = slot; count = 2; }
          else {
            if (count === 2) {
              if (useScratch) { scratchSlots[0] = s0; scratchSlots[1] = s1; }
              else dynSlots = [s0, s1];
            }
            if (slot < ultimo) ordenado = false;
            ultimo = slot;
            if (useScratch) {
              if (count >= scratchSlots.length) {
                const next = new Int32Array(scratchSlots.length * 2);
                next.set(scratchSlots);
                scratchSlots = next;
              }
              scratchSlots[count] = slot;
            } else {
              dynSlots!.push(slot);
            }
            count++;
          }
        }
      }
    }
    if (count === 0) return [];
    if (count === 1) return [people[s0]!];
    if (count === 2) return ordenado ? [people[s0]!, people[s1]!] : [people[s1]!, people[s0]!];
    const result = new Array<Person>(count);
    if (useScratch) {
      if (!ordenado) {
        if (count <= 32) {
          for (let a = 1; a < count; a++) {
            const v = scratchSlots[a]!;
            let b = a - 1;
            while (b >= 0 && scratchSlots[b]! > v) { scratchSlots[b + 1] = scratchSlots[b]!; b--; }
            scratchSlots[b + 1] = v;
          }
        } else {
          scratchSlots.subarray(0, count).sort();
        }
      }
      for (let j = 0; j < count; j++) result[j] = people[scratchSlots[j]!]!;
    } else {
      if (!ordenado) dynSlots!.sort((a, b) => a - b);
      for (let j = 0; j < count; j++) result[j] = people[dynSlots![j]!]!;
    }
    return result;
  } finally {
    if (useScratch) scratchBusy = false;
  }
}

export function primerVecino(world: World, centro: CentroRejilla, alcance: number, pred: PredicadoPersona, etiqueta?: string): Person | undefined {
  const ambito = world === ultimoMundo ? ultimoAmbito : ambitos.get(world);
  if (!ambito || (desactivadasActivas > 0 && (desactivadas.get(world) ?? 0) > 0)) return world.people.find(pred);
  const indice = sincronizar(world, ambito), people = world.people;
  const cxCenter = centro.x, cyCenter = centro.y;
  if (!indice.valido || !(Number.isFinite(cxCenter) && Number.isFinite(cyCenter) && Number.isFinite(alcance) && alcance >= 0)) {
    return people.find(pred);
  }
  const x0 = casilla(cxCenter - alcance), x1 = casilla(cxCenter + alcance);
  const y0 = casilla(cyCenter - alcance), y1 = casilla(cyCenter + alcance);
  if (!(Math.abs(x0) < MAXIMO && Math.abs(x1) < MAXIMO && Math.abs(y0) < MAXIMO && Math.abs(y1) < MAXIMO)) {
    return people.find(pred);
  }
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > Math.max(1, people.length)) return people.find(pred);
  if (contadoresActivos && etiqueta) registrar(world, etiqueta);
  const cx0 = x0 > indice.minCx ? x0 : indice.minCx, cx1 = x1 < indice.maxCx ? x1 : indice.maxCx;
  const cy0 = y0 > indice.minCy ? y0 : indice.minCy, cy1 = y1 < indice.maxCy ? y1 : indice.maxCy;
  if (cx0 > cx1 || cy0 > cy1) return undefined;
  const celdas = indice.celdas, cabezas = indice.cabezas, siguiente = indice.siguiente;
  const paso = indice.smi ? SMI_SPAN : SPAN;
  let claveFila = indice.smi ? (((cx0 + SMI_BIAS) << 15) | (cy0 + SMI_BIAS)) : claveGrande(cx0, cy0);
  let mejor = -1;
  for (let cx = cx0; cx <= cx1; cx++, claveFila += paso) {
    let k = claveFila;
    for (let cy = cy0; cy <= cy1; cy++, k++) {
      const cell = celdas.get(k);
      if (cell === undefined) continue;
      for (let slot = cabezas[cell]!; slot !== VACIO; slot = siguiente[slot]!) {
        if (mejor >= 0 && slot >= mejor) break; // lista creciente por slot
        const person = people[slot]!;
        if (Math.abs(person.x - cxCenter) > alcance || Math.abs(person.y - cyCenter) > alcance) continue;
        if (pred(person)) { mejor = slot; break; }
      }
    }
  }
  return mejor >= 0 ? people[mejor] : undefined;
}

/** Notifica el único cambio de posición del motor, después de escribir `x`/`y`. */
export function personaMovida(world: World, person: Person): void {
  const ambito = world === ultimoMundo ? ultimoAmbito : ambitos.get(world);
  if (!ambito?.indice || (desactivadasActivas > 0 && (desactivadas.get(world) ?? 0) > 0)) return;
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
  desactivadasActivas++;
  desactivadas.set(world, (desactivadas.get(world) ?? 0) + 1);
  try { return fn(); }
  finally {
    desactivadasActivas--;
    const depth = (desactivadas.get(world) ?? 1) - 1;
    if (depth === 0) desactivadas.delete(world); else desactivadas.set(world, depth);
  }
}

export function reiniciarConsultasRejillaParaPruebas(world: World): void { contadoresActivos = true; contadores.set(world, new Map()); }
export function consultasRejillaParaPruebas(world: World): ReadonlyMap<string, number> { return new Map(contadores.get(world)); }
