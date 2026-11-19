# T146 — Prefix-sum de los NUEVE contadores de identidad en el coordinador

**Rama**: `sprint/t146-identidades-20261119` · **Base**: `5935aea`
**Alcance cumplido**: funciones puras del coordinador + helpers de renumeración, sin cablear
`index.ts`/`society.ts` (eso es T145/Gate E.1). Ningún comportamiento por defecto cambia:
ningún helper nuevo se llama desde el camino de hoy y `motor.hilos=1` no se toca.

## Ficheros tocados (aislamiento estricto)

| Fichero | Cambio |
|---|---|
| `src/world/paralelo/identidades.ts` (nuevo) | Coordinador puro: clave total, stable sort, prefix-sum por contador y por transacción, formatos de id |
| `src/world/technology-execution.ts` | `technologyExecutionSerial` + `renumberTechnologyExecutionBlock` (bloque contiguo de una transacción, mutando los objetos compartidos por `history`/`journal.pending`) |
| `src/world/technology.ts` | `renumberTechnologyTransactionBlocks`: renumera `id` + `nestedExecutionIds` + `catalysts[].executionId`, reordena `history`/`journal.pending`, deriva `executionCounter` y valida con `assertTechnologyJournal` |
| `src/world/technology-catalogue.ts` | `renumberTechnologyRecipes`: copias con `recipe-N` contiguos, `parents` remapeados y sufijo del nombre actualizado; el original no se toca |
| `src/world/inventions.ts` | `identityBaseFromArchive(world, 'blueprint'\|'structure')`: base efectiva reutilizando `nextIdentity`/`techoDelArchivo` (T140), sin asignar |
| `tests/identidades.test.ts` (nuevo) | 10 tests (ver abajo) |
| `specs/002-mundo-ilimitado/informes/T146-report.md` | Este informe |

No tocados, por aislamiento: `src/world/index.ts`, `src/world/society.ts`, `src/world/halo.ts`,
`src/server/*`, `tasks.md` (la casilla T146 la marca el Gate E al integrar, no esta rama).

## Qué se implementó

- **Clave total** `(tick, fase, regionMorton, actorSlot, secuenciaLocal)`
  (`ClaveOrdenIdentidad`/`compararClaveIdentidad`). Empate exacto dentro de un contador =
  error, nunca desempate por llegada. Sin `Atomics` para ids y sin hashes `seed:tick:pos`.
- **`asignarIdentidades(candidatos, confirmados, { descubiertosPrevios })`**: agrupa por
  contador, ordena estable, cuenta por `regionMorton` y aplica el prefix-sum de esos conteos
  sobre el contador confirmado (desplazamiento por región + posición intra-región). Devuelve
  asignaciones reasociables por `indice`/`referencia` y los nueve contadores resultantes.
- **Los nueve contadores** (nombre real → formato): `birthCounter→descendant-N`,
  `communityCounter→community-N`, `eventCounter→eN`, `discoveredChunks` (sin id),
  `executionCounter→process-N`, `itemCounter→product-N`, `recipeCounter→recipe-N`,
  `blueprintCounter→blueprint-N`, `structureCounter→structure-N`.
- **`discoveredChunks`**: deduplica por `chunkKey` contra `descubiertosPrevios` y dentro del
  propio lote; solo la primera aparición en orden total es la transición `false→true` que
  suma (`descubrimientoNuevo`, `serial` = ordinal resultante; duplicados: `serial/id null`).
- **Unidad atómica = TRANSACCIÓN** (`asignarTransaccionesEjecucion`): el prefix-sum corre
  sobre `cantidadEjecuciones` (anidadas + cierre), así cada transacción recibe un bloque
  contiguo `[inicioSerial, finSerial]`. `renumberTechnologyTransactionBlocks` aplica ese
  bloque a `id`, `nestedExecutionIds` y `catalysts[].executionId` (una referencia fuera de
  su bloque lanza), incorpora al `history`/`journal.pending` lo que falte —sin reincorporar
  a `pending` lo ya confirmado—, ordena ambos por serial y deja
  `executionCounter = historyDropped + history.length`, con `serial === previousSerial + 1`.

## Contrato de integración para T145 / Gate E.1 (en `index.ts`/`society.ts`)

1. Los workers emiten `CandidatoIdentidad { contador, clave, chunkKey?, referencia? }` y no
   incrementan ningún contador (regla 13). `fase` es el ordinal de la fase del paso en su
   orden serial de hoy; `regionMorton` sale de la partición del actor/celda; `actorSlot` es
   el slot estable; `secuenciaLocal` numera las emisiones de ese actor en esa fase.
2. Tras la barrera, el coordinador construye `confirmados` desde el mundo
   (`world.birthCounter`, `world.communityCounter`, `world.eventCounter`,
   `world.discoveredChunks`, `world.technology.{execution,item,recipe}Counter`) y, para
   `blueprint`/`structure`, desde `identityBaseFromArchive(world, …)`; si este devuelve
   `undefined` (sufijo corrupto/desbordado) el paso se aborta sin asignar, como hace hoy
   `nextIdentity`. Para `discovered` pasa además el conjunto de `chunkKey` ya descubiertos.
3. Aplicación por contador, usando el serial asignado y no solo la cadena: nacimiento
   (`descendant-N` es también la semilla de `inheritGenome` y de nombre/`heading`),
   comunidad (el nombre sale de `localRandom(seed, id)` y el color de `serial % 4`),
   evento (id `eN` aceptado por el diario de crónica en vez de `++eventCounter`),
   descubrimiento (solo `descubrimientoNuevo` pone `chunk.discovered = true`;
   `world.discoveredChunks = contadores.discoveredChunks`), producto (`product-N`).
4. Tecnología: agrupar por transacción, `asignarTransaccionesEjecucion` y después
   `renumberTechnologyTransactionBlocks(state, [{ executions, firstSerial }])`; cerrar con
   `assertTechnology` + `assertTechnologyJournal`. Recetas: `renumberTechnologyRecipes`
   antes de registrar, dejando `state.recipeCounter = serialAsignado − 1` al registrar cada
   una en orden total (es lo que `registerTechnologyRecipe` exige). Planos/obras fijan
   `world.blueprintCounter`/`world.structureCounter` a los contadores resultantes.

## Pruebas y resultados medidos

`tests/identidades.test.ts` (10/10):

- 5 nacimientos simultáneos en 3 regiones dan `descendant-11…15` exactos con llegadas de
  1, 8 y 28 workers y orden adversarial (mapa referencia→id idéntico en las cuatro).
- Los nueve contadores asignan su formato desde contadores previos no cero y devuelven los
  nueve contadores incrementados; ida y vuelta id↔serial por contador.
- Clave repetida, `discovered` sin `chunkKey` y clave negativa lanzan.
- `discoveredChunks`: deduplicación por `chunkKey` + conocidos previos en las cuatro
  llegadas (5 → 8, con duplicados en `null`).
- Compatibilidad: mundo con `blueprint-37`/`structure-41` en un chunk retirado
  (`techoDelArchivo`) y contadores bajos asigna `blueprint-38`/`structure-42` sin reutilizar
  ninguno; `blueprint-base` no cuenta; sufijo corrupto ⇒ base `undefined`.
- Dos crafteos anidados simultáneos (catalizador `binding` obligatorio) construidos en
  hosts aislados desde el mismo contador, fusionados en ambos órdenes de llegada: secuencia
  de `history` idéntica, bloques contiguos sin huecos, `nestedExecutionIds ===
  catalysts[].executionId` dentro del bloque, `assertTechnology` y
  `assertTechnologyJournal` verdes.
- `renumberTechnologyRecipes`/`renumberTechnologyExecutionBlock`: contigüidad exigida,
  `parents` remapeados, originales intactos.
- **Control `motor.hilos=1`**: `createWorld(51926)` + 1 200 pasos ⇒ contadores
  `{birth 7, community 3, event 370, discovered 5, execution 227, item 106, recipe 85,
  blueprint 3, structure 0}` y `digestoCanonico =
  95c577d0c6690a3cedd0027da3b8130a4d05a88c2e1b9837720f24339a6bdc61`, idéntico al baseline
  medido sobre la base `5935aea` antes de cualquier cambio.

Verificación ejecutada en este worktree:

- `npm run typecheck` — verde (0 errores).
- `npx tsx --test tests/identidades.test.ts tests/indices.test.ts tests/technology.test.ts tests/halo-radios.test.ts` — **43/43, 0 fallos**.
- No se ejecutó `npm test` completo ni `npm run build` (prohibido en esta tarea).

## Determinismo

El hardware no puede cambiar el resultado de este cambio: la asignación depende solo de la
clave total por contenido y de los contadores confirmados —ni del número de workers, ni de
su orden de llegada, ni de `Atomics`— y con 1 hilo reproduce exactamente la secuencia y el
digesto de hoy.
