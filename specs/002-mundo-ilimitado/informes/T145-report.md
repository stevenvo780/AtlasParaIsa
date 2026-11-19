# T145 (núcleo): fase B de solo lectura y fase C de confirmación ordenada

Worktree `/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/t145-reduccion-20261119`, rama
`sprint/t145-reduccion-20261119`. Alcance ejecutado: **solo el núcleo determinista puro**.
El cableado en `bodyAndAction`/`choose` detrás de `motor.particionarPersonas` queda fuera de
esta rama y se integra en Gate E.1 junto con T146/T147/T153 y T149 (ver contrato abajo).

## Ficheros tocados (aislamiento estricto)

- `src/world/paralelo/reduccion.ts` (nuevo): tipos y motor puro de `Intent`, orden canónico,
  confirmación sobre stocks finitos, migración tras la barrera y runners de fase B con T148.
- `tests/intencion-confirmacion.test.ts` (nuevo): 10 pruebas (ver «Cifras medidas»).
- `specs/002-mundo-ilimitado/informes/T145-report.md` (este informe).

No se tocó `src/world/index.ts`, `src/world/society.ts`, `src/world/animals.ts`,
`src/server/app.ts` ni `src/world/halo.ts`, ni `tasks.md` (su casilla la marca Gate E.1).

## Diseño

**`Intent`** es exactamente el registro del encargo:
`{ fase, tipoRecurso, recursoId, celdaX, celdaY, actorSlot, secuenciaLocal, cantidad, payload }`.
`validarIntent` devuelve una copia normalizada e inmutable (`cantidad + 0` elimina el `-0`) y
rechaza celdas/slots/secuencias no enteras, slots o secuencias negativas y cantidades no
finitas o negativas. `tipoRecurso` es una cadena abierta; los finitos del mundo son
`cosecha`, `agua`, `caza`, `construccion`, `reparacion`, `intercambio` y `compartir`.

**Orden canónico (fase C).** `compararIntentos` ordena por
`(celdaX, celdaY, actorSlot, secuenciaLocal)` y desempata por contenido
`(fase, tipoRecurso, recursoId, cantidad, clavePayload)`, donde `clavePayload` serializa el
payload con claves de objeto ordenadas y distingue `-0`. `ordenarIntentos` no muta la entrada.
No interviene ningún orden de llegada, recuento de hilos ni geometría: son contenido puro.

**Confirmación.** `confirmarIntentos(intentos, stocks)` copia los stocks (la entrada no se
muta), exige que cada `recursoId` nombre una sola celda por paso y que su stock exista, y
aplica en orden canónico `concedido = min(cantidad, restante)`. Garantías:

- ningún intento se pierde: hay un `ResultadoIntento` por intento recibido, con
  `concedido + denegado === cantidad`;
- ninguno se aplica dos veces: la identidad exactly-once es `(actorSlot, secuenciaLocal)`;
  una reemisión idéntica (payload igual salvo orden de claves) se marca `duplicado: true` y
  concede 0; una reemisión conflictiva (misma identidad, distinto contenido) **lanza**;
- el stock nunca cae por debajo de 0 (el `-0` resultante se normaliza a `0`).

Las concesiones parciales son la semántica de los recursos divisibles (cosecha, agua,
compartir); para recursos indivisibles (p. ej. una presa de caza) el llamador de Gate E.1
debe emitir `cantidad` en unidades enteras y tratar `denegado > 0` como pérdida del intento,
sin tocar este motor.

**Geometría.** `regionDeCelda(x, y, regionSide)` usa división por suelo (correcta con
negativos) y `mortonDeRegion` reutiliza `mortonCode` de `src/world/gpu/reparto.ts`.
`simularLlegada(intentos, { regionSide, workers, orden })` reparte regiones Morton en colas
contiguas entre workers y simula llegadas `natural`/`inverso`/`adversarial`/`mezclado`
(barajado LCG de semilla fija, sin reloj ni azar). Es un modelo de llegada para pruebas:
quién calcula, nunca qué sale (regla 2 de `tasks.md`).

**Migración.** `ordenarMigraciones(solicitudes, regionSide)` ordena por
`(regionDestinoMorton, actorSlot)` y rechaza dos migraciones del mismo slot.
`aplicarMigraciones(entidades, solicitudes, regionSide)` devuelve **copias** en ese orden
con `x/y` de destino y el `actorSlot` verificado invariable; los orígenes no se mutan.
La migración es tras la barrera: el llamador la ejecuta solo con la confirmación terminada.

**Runner de fase B.** `ejecutarFaseB(world, actorSlot, decidir)` envuelve la decisión con
`withReadOnlyDecisionGuard` de T148 (`src/world/paralelo/guardia.ts`): con
`motor.depuracion=true` la vista es el proxy profundo y una escritura fugada lanza
`… prohibida en fase B por slot N sobre <ruta>`; con `false` la vista es el propio mundo.
El runner valida que todo `Intent` emitido lleve el `actorSlot` del actor que decide.
`ejecutarFaseBGenerica(estado, actorSlot, decidir)` hace lo mismo sobre un estado sintético
siempre a través del proxy, para pruebas sin mundo completo.

## Contrato exacto de integración (Gate E.1, con T146/T147/T153/T149)

1. **Emisión (T145 cableado + T147):** `choose`/`bodyAndAction` dejan de escribir el mundo en
   la decisión; por cada acción que hoy toca un recurso finito emiten un `Intent` por actor
   con `secuenciaLocal` creciente por actor dentro del paso (0, 1, …), `celdaX/celdaY` de la
   tesela del recurso y `recursoId` estable por paso con formato libre pero único por
   recurso+celda (las pruebas usan `celda:<x>,<y>:<tipo>`). El estado de persona de T147
   (SoA) debe poder reconstruir `actorSlot` sin cambiarlo nunca.
2. **Fase B:** el coordinador llama `ejecutarFaseB(world, slot, decidir)` por actor (o su
   equivalente por worker sobre la vista replicada de solo lectura con halo
   `HALO_CELDAS = 14` de `src/world/halo.ts`). Con `motor.depuracion=true` la guardia es la
   red de la escritura fugada; su coste con `false` es cero por construcción de T148.
3. **Barrera y fase C:** recogidos los intentos de todas las regiones (cualquier llegada),
   el coordinador llama `confirmarIntentos(intentos, stocksDelPaso)`, donde `stocksDelPaso`
   se captura **antes** de la fase B desde el mundo confirmado. Solo la fase C escribe:
   aplica `concedido` por tesela/recurso en el orden de `resultados`. Si lanza (reemisión
   conflictiva, recurso en dos celdas, stock desconocido), el paso se aborta antes de
   escribir, igual que un fallo de worker aborta antes del swap en T115.
4. **T146 (identidades):** los candidatos a ids viajan como intentos/payload ordenados por
   `(tick, fase, regionMorton, actorSlot, secuenciaLocal)`; este motor ya entrega ese orden
   por actor y `regionDestinoMorton`/`mortonDeRegion` para la clave de región. Ningún worker
   incrementa contadores (regla 13); el prefix-sum queda en el coordinador tras la fase C.
5. **T153 (agregados):** las contribuciones a `world.totals` y dinámicas viajan como
   `Intent` (o payload de agregado) y el coordinador las aplica en orden
   `(actorSlot, secuenciaLocal)` — el orden que `confirmarIntentos` ya impone —, o en punto
   fijo entero; prohibido acumular FP64 por región dentro de un worker.
6. **Migración:** tras la fase C, `aplicarMigraciones` con el `regionSide` vigente mueve a
   quien cruzó de región; el `actorSlot` es invariable y es la clave de identidad en todo
   el pipeline (guardia, intentos, ids, agregados).
7. **T149:** separar decidir de escribir hace simultáneas las decisiones (cambio de reglas:
   `RULES_VERSION` siguiente y migración). A partir de ahí la puerta deja de ser «digesto
   idéntico al mundo de hoy» y pasa a ser «los 9 backends idénticos entre sí», que es lo que
   estas pruebas ejercitan a nivel de reducción; `motor.particionarPersonas=false` debe
   seguir revirtiendo al motor serial.

## Cifras medidas

- `npm run typecheck`: verde (exit 0).
- `npx tsx --test tests/intencion-confirmacion.test.ts tests/guardia-fase-b.test.ts tests/halo-radios.test.ts`:
  **27/27 verdes, 0 fallos, 0 omitidas** en 3,42 s (10 pruebas nuevas de T145 + 9 de T148 + 8 de halo).
- Cobertura de la matriz en las pruebas nuevas: competencia en la misma tesela en
  4 workers (1/2/8/28) × 3 geometrías (128/256/512) × 3 llegadas = **36 combinaciones** con
  el mismo ganador (`slot 2` concede 0,75, `slot 5` concede 0,25, `slot 7` concede 0 sobre
  stock 1); escena multicelda con `simularLlegada` en 3 × 4 × 4 = **48 combinaciones** con
  resumen idéntico; conservación exacta con `Object.is` en los **7 tipos** de recurso;
  migración en las 3 geometrías con orden `[1, 3, 7, 9]` y slots invariables.
- No se ejecutó `npm test` completo ni `npm run build`, por instrucción expresa del encargo.

**Determinismo:** con este núcleo, el hardware solo cambia la velocidad: el resultado de la
confirmación y de la migración depende únicamente del contenido de los intentos
(`celda, actorSlot, secuenciaLocal` y destino), nunca del número de hilos, del orden de
llegada de los workers ni de la geometría de partición 128/256/512.
