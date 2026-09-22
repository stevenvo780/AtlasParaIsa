/**
 * Selección sin ordenar (sprint noche-perf 2026-09-22). Las leyes eligen muchas veces con
 * `xs.filter(keep).sort(compare)[0]` (o `.slice(0, 2)`): ordenan todo para quedarse con uno o dos.
 * `Array.prototype.sort` es estable (ES2019), así que cuando `compare` es un preorden total
 * consistente —como todos los comparadores de las leyes: diferencias de números finitos (el signo de
 * `a - b` entre doubles finitos es exactamente el de la comparación) encadenadas con `||`— sus
 * primeros elementos están determinados: el menor y, entre iguales, el que aparece antes. Estas
 * funciones devuelven exactamente esos elementos en una pasada, reemplazando sólo ante una mejora
 * ESTRICTA. `keep` y `compare` deben ser puros (lo son en todas las llamadas): aquí se intercalan en
 * vez de filtrar primero y ordenar después, y `compare` se evalúa menos veces.
 */
export function primero<T>(items: readonly T[], compare: (a: T, b: T) => number, keep?: (item: T) => boolean): T | undefined {
  let best: T | undefined, found = false;
  for (const item of items) {
    if (keep && !keep(item)) continue;
    if (!found || compare(item, best as T) < 0) { best = item; found = true; }
  }
  return best;
}

/** Igual que `primero`, pero pregunta `keep` sólo a quien mejoraría estrictamente al actual: para
 * filtros caros (p. ej. recorrer todos los lugares o estructuras). Un elemento que no mejora no
 * puede ser el resultado pase o no el filtro, así que el resultado es el mismo. */
export function primeroConFiltroCaro<T>(items: readonly T[], compare: (a: T, b: T) => number, keep: (item: T) => boolean): T | undefined {
  let best: T | undefined, found = false;
  for (const item of items) {
    if (found && !(compare(item, best as T) < 0)) continue;
    if (keep(item)) { best = item; found = true; }
  }
  return best;
}

/** Los dos primeros de `items.filter(keep).sort(compare)`, en ese orden (lo que daría `.slice(0, 2)`). */
export function primerosDos<T>(items: readonly T[], compare: (a: T, b: T) => number, keep?: (item: T) => boolean): T[] {
  let first: T | undefined, second: T | undefined, count = 0;
  for (const item of items) {
    if (keep && !keep(item)) continue;
    if (count === 0) { first = item; count = 1; }
    else if (compare(item, first as T) < 0) { second = first; first = item; count = Math.min(2, count + 1); }
    else if (count === 1 || compare(item, second as T) < 0) { second = item; count = 2; }
  }
  return count === 0 ? [] : count === 1 ? [first as T] : [first as T, second as T];
}
