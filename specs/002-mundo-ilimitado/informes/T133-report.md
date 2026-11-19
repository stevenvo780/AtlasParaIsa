# T133 — Terreno dormido con la tupla compacta

Rama `sprint/t133-chunks-tupla-20261119`. Estado: implementada y verificada en su
worktree; pendiente de integración en el Gate D (T139). La casilla de `tasks.md`
no se marca: el cierre formal lo da el gate, como en el resto de la etapa D.

## Qué cambió y por qué

- `src/server/snapshot.ts`: nuevos `ARCHIVED_CHUNK_TILE_ENCODING =
  'chunk-tiles-tuple-v1'`, `encodeArchivedChunk(chunk)` y
  `decodeArchivedChunk(body)`.
  - Las teselas viajan con las mismas filas de tupla sin pérdida de
    `tiles-tuple-v1` (`encodeSnapshotTileRows`/`decodeSnapshotTileRows`,
    20 campos, opcionales presentes conservados, `-0` con `JSON.rawJSON`).
  - Optimización propia del chunk: si **todas** las teselas cumplen la
    coordenada de rejilla que `assertChunk` ya exige (`x = cx·16 + i%16`,
    `y = cy·16 + ⌊i/16⌋`, el mismo razonamiento que el SoA de T112), las dos
    primeras ranuras se omiten (fila de 18) y el decodificador las reconstruye.
    Si alguna no cumple, se escribe la tupla completa de 20: nada se pierde en
    ningún caso, incluidos chunks sintéticos fuera de rejilla.
  - Todo lo demás del chunk (`key`, `cx`, `cy`, `discovered`, `places`,
    `lastTick`, `animals`, `structures`, `lifeVersion`, …) conserva su forma
    JSON exacta de `stringifyExact`, así que las consultas SQLite sobre
    `$.animals`/`$.structures` de `Store.loadSlot` siguen funcionando sin
    cambios sobre los cuerpos nuevos.
  - `decodeArchivedChunk` acepta ambos formatos: sin `tileEncoding` devuelve
    el JSON histórico tal cual; con `chunk-tiles-tuple-v1` expande las tuplas y
    borra la marca, devolviendo exactamente las mismas claves y valores. Una
    marca desconocida falla cerrada («Explicit recovery required.»).
- `src/server/store.ts`:
  - Al archivar (`save`, bloque `retired`), el cuerpo pasa de
    `stringifyExact(chunk)` a `encodeArchivedChunk(chunk)`; el digest sigue
    siendo `sha256(body)` de los bytes efectivamente escritos.
  - `loadChunk` verifica `sha256(row.body) === row.digest` como antes y ahora
    decodifica con `decodeArchivedChunk`, por lo que lee cuerpos viejos y
    nuevos. Es el único lector de cuerpos de `chunks` en `src/`; los demás
    puntos (`loadSlot` con `json_extract` sobre animales/estructuras,
    `assertNothingNewerThan`, `previous()`/`backup` vía `loadChunk`) quedan
    compatibles sin cambios porque los campos que tocan no cambian de forma.
- `tests/store-chunks-tupla.test.ts` (nuevo): ver «Cómo se prueba».
- Compatibilidad en pruebas que leían la tabla `chunks` directamente:
  - `tests/backup-lazy-archives.test.ts`: el gancho de corrupción escribe
    `food` en la ranura de tupla que corresponda (5 en fila de 20, 3 en fila
    de 18 sin coordenadas) o en el objeto histórico.
  - `tests/snapshot-numeric-archive.test.ts`: el «caso ordinario» ya no
    conserva los bytes JSON históricos sino la tupla de T133 (misma aserción,
    nuevo formato), y la sonda de `-0` lee la fila con `decodeArchivedChunk`.

Nota sobre la dependencia declarada (T132): T132 no está integrada en esta
base, así que la tupla se aplica sobre el bloque de archivo vigente dentro de
`save()`, sin reescribirlo; cuando T132 aterrice, el punto de escritura es el
mismo y el formato no cambia.

## Cómo se prueba

`tests/store-chunks-tupla.test.ts` (4 pruebas):

1. Ida y vuelta directa de `encode/decodeArchivedChunk` con un chunk rico
   (opcionales de tesela, `-0`, animales materializados, estructuras
   `legacyStructures`, lugares): mismas claves y valores; el cuerpo histórico
   `stringifyExact(chunk)` se lee idéntico; marca futura rechazada.
2. Compatibilidad hacia atrás en SQLite: fila reescrita en formato JSON viejo
   (con su digest) ⇒ `loadChunk` idéntico y reanimación con `activate` +
   `Store.load` con el mismo `digestoCanonico` que la referencia en memoria.
3. Ida y vuelta completa: `retiredChunks` → `save` → fila con
   `tileEncoding='chunk-tiles-tuple-v1'` y `digest = sha256(body)` →
   `loadChunk` sin pérdida (animales, estructuras y lugares incluidos) →
   `Store.load` + `activate` ⇒ `digestoCanonico` idéntico al de la referencia
   reanimada desde el chunk en memoria, y distinto del previo a activar.
4. Medición de tamaño sobre la tabla `chunks` (ver cifras).

Comandos ejecutados (sin `npm test` completo, por instrucción expresa):

- `npm run typecheck` → 0 errores.
- `npx tsx --test tests/store-chunks-tupla.test.ts tests/archive.test.ts
  tests/snapshot-numeric-archive.test.ts` → 22/22.
- `npx tsx --test tests/store-chunks-tupla.test.ts
  tests/store-persistence.test.ts tests/store-guardado.test.ts
  tests/backup-lazy-archives.test.ts tests/backup-copy-validation.test.ts`
  → 45/45.
- `npx tsx --test tests/snapshot-parts.test.ts tests/regiones-vivas.test.ts
  tests/clon-acotado.test.ts tests/digesto.test.ts
  tests/snapshot-tile-fields.test.ts` → 80/80.
- El comando pedido `npx tsx --test tests/store-chunks-tupla.test.ts
  tests/store.test.ts` no puede correr literal: `tests/store.test.ts` no
  existe en este árbol (la suite de store vive en `archive.test.ts`,
  `store-persistence.test.ts` y `store-guardado.test.ts`, ejecutadas arriba).

## Cifras (ANTES / DESPUÉS con control)

Medido en la prueba 4 (6 chunks generados archivados en una tabla real):
cuerpos `chunks` con tupla = **171 279 B** frente a **452 386 B** de
`JSON.stringify(chunk)` directo ⇒ **−62,1 %** (objetivo ≥ 60 %).
Control: los mismos chunks se releen con `loadChunk` y dan `deepEqual` con el
original, y el `digestoCanonico` tras reanimar es idéntico al de la
referencia; el formato viejo da el mismo digesto que el nuevo.

## Hardware y resultado

El hardware **no** puede cambiar el resultado de este cambio: la codificación
es una función pura y exacta de los bytes del chunk (sin FP nuevo, sin
ordenación dependiente de llegada ni de hilos), y la puerta es el
`digestoCanonico`, idéntico tras archivar y reanimar en ambos formatos.
