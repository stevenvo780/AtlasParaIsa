/** Columna que la ley de la fauna registra (`leyFauna.columnas`): lo que los demás leen de un animal para cazarlo,
 * ordeñarlo o evitarlo, además de las fijas. Sin columna de especie: la fauna V23 no la registra.
 *
 * Vive aparte de `soa/fauna.ts` para no depender de un ciclo: `soa/fauna` → `animals` → `ley-fauna` → `soa/fauna`. Si un
 * hilo dueño cargaba `soa/fauna` primero, `leyFauna` se evaluaba antes de que existiera `COLUMNA_FAUNA` (TDZ). */
export const COLUMNA_FAUNA = 'fauna';
export const CAMPOS_FAUNA = { miedo: 0, habituacion: 1, huella: 2, velocidad: 3 } as const;
export const FAUNA_ANCHO = 4;
