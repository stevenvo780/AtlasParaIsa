# T163 — Desalojo de páginas frías y caché LRU de terreno dormido

Rama `sprint/t163-desalojo-20261119`. Estado: implementada y verificada en su
worktree; pendiente de integración en el Gate F (T167). La casilla de `tasks.md`
no se marca: el cierre formal lo da el gate.

## Qué cambió y por qué

- `src/world/lru.ts` (nuevo): `ChunkLruCache`, caché LRU acotada en memoria de
  chunks dormidos (capacidad por defecto `DEFAULT_CHUNK_LRU_CAPACITY = 32`),
  con expulsión de la entrada menos recientemente usada y promoción al leer, y
  `chunkLruFor(owner)`, una caché por objeto mundo (una clave de chunk solo es
  inequívoca dentro de su mundo). Guarda referencias; quien reanima clona antes
  de exponerlas (ver abajo), así que la copia cacheada nunca se muta.
- `src/world/spatial.ts`:
  - `evictColdChunks(world, { maxActiveChunks?, maxActiveTiles? }): string[]`
    («Reducir área») retira chunks activos hasta cumplir el presupuesto,
    devolviendo las claves en orden de desalojo. Solo son candidatos los chunks
    que no contienen habitantes ni caen en el halo obligatorio de ninguna
    persona viva: el chunk de cada persona y el anillo que `maintainRegions`
    activa con `REACH = [-8, 0, 8]` (±8 celdas, ±1 chunk; desde una celda eso
    toca 2×2 chunks de 16). El orden es total y por contenido:
    `(distancia mínima Chebyshev en chunks a cualquier persona viva DESC,
    lastTick ASC, chunkKey lexicográfico ASC)`. Sin personas la distancia es
    `Infinity` para todos y mandan `lastTick` y la clave. Opciones inválidas
    (no enteros o negativos) lanzan `RangeError`. Sin presupuesto es un no-op.
  - El presupuesto queda registrado por mundo (`activeAreaBudget(world)`) y
    `maintainRegions` lo reaplica tras su retiro habitual: si una persona cruza
    una frontera se activa la página obligatoria y se retira otra fría fuera
    del halo. Sin presupuesto registrado, `maintainRegions` ejecuta exactamente
    el camino de siempre (su retiro se extrajo sin cambios a
    `retireActiveChunks`, compartido con el desalojo).
  - Nunca se fuerza el techo a costa del halo: si no quedan candidatos, el
    conjunto activo puede quedar por encima del presupuesto, pero ninguna
    página obligatoria falta y el movimiento nunca se impide.
  - Los chunks retirados pasan a `world.retiredChunks` con sus teselas,
    animales, estructuras y lugares (el mismo traspaso que ya hacía
    `maintainRegions`, incluidos los tres lugares ancla que permanecen en
    `world.places`). Al guardar, el `Store` los respalda en la tabla `chunks`
    (formato de tupla de T133, ya integrado en esta base: no hizo falta tocar
    `src/server/store.ts`), y `activate()` los reanima desde `retiredChunks`,
    desde la LRU del mundo o desde `context.loadChunk`, en ese orden.
  - `activate()` ahora consulta la LRU antes que `context.loadChunk` y cachea
    lo que este devuelve: reanimar pronto un chunk ya confirmado por el
    `Store` (que drena `retiredChunks` al guardar) no vuelve a SQLite. Como
    antes, lo reanimado se `structuredClone`a antes de exponer animales,
    estructuras y lugares a las leyes, así que la copia cacheada queda intacta.
- `src/world/halo.ts`: solo inventario. La entrada `activacion.retiro` de
  `RECORRIDOS` apunta ahora a `retireActiveChunks` (el cuerpo extraído, con los
  mismos patrones) y se añaden `activacion.haloObligatorio` y
  `activacion.distanciaFria` para las dos consultas nuevas sobre
  `world.people`. Sin esto, `tests/halo-radios.test.ts` quedaba rojo por la
  extracción; con esto vuelve a verde sin cambiar ningún radio ni `HALO_CELDAS`.

## Cómo se prueba

`tests/desalojo.test.ts` (nuevo, 6 pruebas):

1. Sin presupuesto, `evictColdChunks` es un no-op y `digestoCanonico` no
   cambia; opciones inválidas lanzan `RangeError`.
2. Una persona camina 1 000 celdas (este) con un presupuesto estricto de
   4 chunks / 1 024 teselas activas: en cada paso se activa además una página
   lejana como presión fría y, tras `maintainRegions` + desalojo, ninguna
   página obligatoria de su halo falta, hay tesela bajo la persona y el
   conjunto activo no supera el techo.
3. Orden de desalojo: cinco chunks fríos sintéticos salen exactamente en
   `['5,0', '4,-3', '4,3', '3,-3', '3,3']` — `(distancia DESC, lastTick ASC,
   key ASC)` —, ningún chunk del halo sale ni siquiera con `lastTick = 0` ni
   con un techo de 1 chunk imposible sin tocar el halo, y todos quedan en
   `retiredChunks`.
4. `ChunkLruCache(2)`: expulsa la menos reciente, promociona al leer y acota
   su tamaño; capacidad inválida lanza.
5. Reanimación con LRU: tras desalojar y drenar `retiredChunks` (lo que hace
   `Store.save` al confirmar), `activate` reanima desde la LRU sin llamar al
   lector de respaldo.
6. Persistencia sin pérdida: se activan dos chunks lejanos, se marca el estado
   de una tesela (`food = 0.123456789`), se desalojan, se guarda en un `Store`
   real (la fila de `chunks` coincide con `loadChunk`), se recarga y se
   reaniman los dos: teselas, animales, estructuras y lugares coinciden con lo
   capturado antes de desalojar y `digestoCanonico` del mundo recargado y
   reanimado es idéntico al de la referencia reanimada en memoria.

Comandos ejecutados (sin `npm test` completo, por instrucción expresa):

- `npm run typecheck` → 0 errores.
- `npx tsx --test tests/desalojo.test.ts tests/spatial-escala.test.ts
  tests/store-chunks-tupla.test.ts` → 18/18.
- `npx tsx --test tests/halo-radios.test.ts` → 8/8 (inventario, tras la
  extracción de `retireActiveChunks`).

## Cifras (ANTES / DESPUÉS con control)

- Con presupuesto: el conjunto activo queda acotado a 4 chunks = 1 024
  teselas durante los 1 000 pasos de la caminata (≈0,4 s la prueba entera),
  frente a crecer sin techo con las páginas lejanas activadas a mano en cada
  paso; el halo obligatorio está presente en el 100 % de los pasos.
- Sin presupuesto (control): `maintainRegions` da el mismo mundo que la
  implementación anterior — lo sigue probando el oráculo de
  `tests/spatial-escala.test.ts` contra la copia histórica de
  `maintainRegions`/`activate` (digestos idénticos en las semillas 7 y 51926,
  con retiros y reanimaciones reales) — y `evictColdChunks(world)` sin
  opciones no cambia el digesto.
- Memoria dormida: la LRU retiene como máximo 32 chunks por mundo; el resto
  del terreno desalojado vive en `retiredChunks` y, tras guardar, solo en la
  tabla `chunks` de SQLite.

## Hardware y resultado

El hardware **no** puede cambiar el resultado de este cambio: el orden de
desalojo es un orden total por contenido (distancia, `lastTick`, clave), la
LRU solo decide si una reanimación lee de memoria o de SQLite (el chunk
obtenido es el mismo y se clona igual), y sin presupuesto el camino es el de
siempre, con `digestoCanonico` idéntico como puerta.
