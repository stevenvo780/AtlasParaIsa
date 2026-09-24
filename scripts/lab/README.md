# Laboratorio — `scripts/lab/replica.ts`

Instrumento científico (constitución II: evidencia) para correr una simulación determinista de
N días fuera del servidor, sin navegador ni WebSocket, y medir sus leyes con cifras.

## Uso

```sh
npx tsx scripts/lab/replica.ts --seed 51926 --dias 10 --params "cuerpo.riesgoSenescenciaDiario=0.01,genes.varianzaFundadores=0.15" --salida artifacts/lab/mi-corrida
```

- `--seed N` (opcional, por defecto `51926`, la misma semilla que usan `soak.ts`/`benchmark-simulation.ts`).
- `--dias D` (opcional, por defecto `1`; entero ≥ 1). Un día son `TICKS_PER_DAY = 2400` ticks.
- `--params "a.b=1,c.d=2"` (opcional): overrides de `WorldParams` (ver `src/world/params.ts`), en el
  mismo formato que acepta `parseParams` (pares punteados separados por comas, o JSON anidado/plano).
  Sin `--params`, corre con `DEFAULT_PARAMS`: desde reglas 10, etapa 1 (2026-09-22), los defaults de un
  mundo NUEVO (cortejo 2 con radio 128, comunidad opcional, muestreo continuo, habituación 0,35). Para medir
  el mundo de antes: `--params "poblacion.cortejo=0,poblacion.radioCortejo=24,poblacion.exigeComunidad=true,poblacion.comprobacionContinua=false,conducta.habituacion=0"`
  (= `HISTORICAL_PARAMS`). `scripts/lab/digesto-control.ts` mide el digesto de una réplica sobre la base
  histórica, también en una exportación (`git archive`) de un commit anterior.
- `--salida <dir>` (obligatorio): directorio donde se escriben `dia-NNN.json` (uno por día) y, al
  terminar, `replica.json`. Se crea si no existe.
- `--gobernador no|servidor` (opcional, por defecto `no`): ver «Gobernador consciente del servidor»
  más abajo. `no` es EXACTAMENTE el comportamiento de siempre (salida bit a bit idéntica); pasar
  explícitamente `no` es equivalente a omitir la bandera.
- `--instrumentos si|no` (opcional, por defecto `si`): instrumentos de medida de solo lectura
  (conducta por tiempo y comida compartida), ver «Instrumentos de medida» más abajo. `no` da
  exactamente los `dia-NNN.json` de antes (mismas claves, mismos valores).
- `--techo-lab N` (opcional, solo dígitos, ≥ 16): techo **determinista** de laboratorio, ver «Techo de
  laboratorio» más abajo. Sin la bandera no cambia nada (ni el mundo ni las claves de salida). La
  bandera sin valor (p. ej. al final de la línea) o con un valor que no sea solo dígitos (` 18`, `1e2`,
  `0x14`, `+18`, `18.0`) es un error, no «sin techo». Incompatible con `--gobernador servidor` (error
  explícito).

## Por qué SIEMPRE hay un `Store` (hallazgo P3)

`docs/REVISION-2026-09-19.md` (P3) documenta que las leyes de tecnología dependen de si el mundo
tiene un `Store` SQLite adjunto o no. **Corrección (revisión 2026-09-19 de T016):** una versión
anterior de esta nota decía que con Store `world.technology.recipes` quedaba acotado a
`memoryCapacity=32`; es falso — verificado en `src/world/technology-catalogue.ts`, `cacheRecipe`
(línea 84) recorta `state.recipes` con `budgets.maxRecipes` (256 por defecto) **en los dos
regímenes**. Lo que de verdad diverge:

- `budgets.maxRecipes` acota **`world.technology.recipes`** (la ventana LRU residente) con y sin
  Store por igual. La diferencia entre regímenes es qué pasa cuando esa ventana se llena:
  - **Con Store** (producción real): `Store.save()` llama a `enableTechnologyCatalogue`
    (`src/server/store.ts:195`), que activa un catálogo respaldado por el archivo SQLite
    (`technology_definitions`/`technology_stats`). Las recetas evictadas de la ventana residente
    **no se pierden**: se recuperan por `catalogueReader` (`resolveTechnologyRecipe`), y
    `technologyCatalogueTotals(world)` (`src/world/technology-catalogue.ts:161`) mantiene
    `{recipes, manufactured, uses, utility, maxGeneration, functionalDiversity}` sin podar —
    `recipes` sigue a `state.recipeCounter`, que sigue creciendo más allá de 256.
  - **Sin Store**: no hay catálogo ni recuperación. Una vez `world.technology.recipes.length`
    llega a `budgets.maxRecipes`, `registerTechnologyRecipe` **falla** en vez de podar
    (`src/world/technology-catalogue.ts:131`, «standalone catalogue capacity») — la simulación deja
    de poder inventar recetas nuevas. `technologyCatalogueTotals(world)` en este régimen recalcula
    sobre la misma ventana acotada en cada llamada, así que sus totales también quedan atrapados
    en ese tope.
- `memoryCapacity` (`min(32, budgets.maxRecipes)` con Store) **no** acota `world.technology.recipes`:
  acota `person.technology.knownRecipes`/`learnedFrom`, la memoria de recetas **por persona**
  (`technologyMemoryCapacity`, usada en `src/world/technology.ts:52,407,472,597`). Sin Store,
  `technologyMemoryCapacity` devuelve `budgets.maxRecipes` (256) sin acotar — la memoria por
  persona es mucho más laxa que con Store (32).

Un laboratorio que mida sin `Store` estaría midiendo una física de tecnología **distinta** a la que
corre en `atlas.humanizar.tech`. Por eso `replica.ts`:

1. Crea un directorio temporal, fija `process.env.CARTA_DATA_DIR` a ese directorio (igual que hace
   `src/server/main.ts` en producción) y abre `new Store(path)` ahí dentro.
2. Llama a `store.save(world)` **antes de simular ningún tick**: esto activa la catalogación
   (`enableTechnologyCatalogue`) y liga el `WorldContext` (`loadChunk`, `catalogueReader`) al objeto
   `world` (`bindWorldContext`, `src/world/spatial.ts:18-22`), que `stepWorld` reutiliza automáticamente
   en cada tick siguiente porque los pasos se dan sobre el mismo `world` (sin clonar).
3. Vuelve a llamar `store.save(world)` cada `paramsOf(world).persistencia.cadaTicks` ticks (por
   defecto, cada tick — el comportamiento actual), y una última vez al terminar.
4. Borra el directorio temporal al final (`finally`); nunca toca `data/` del servidor público.

## Salida

`dia-NNN.json` (uno por día, `NNN` con 3 dígitos, `tick` = fin del día = `dia · 2400`):

```json
{
  "tick": 2400, "poblacion": 22, "nacimientos": 6,
  "muertesPorCausa": { "starvation": 0, "dehydration": 0, "exposure": 0, "senescence": 0 },
  "fundadoresVivos": 16, "generacionesVivas": 2,
  "diversidadOficios": 2.59, "recetasDistintasEnUso": 69, "diversidadFuncional": 5,
  "catalogoActivo": true, "cooperaciones": 200,
  "gini": null, "fraccionComida": null, "distanciaAgua": null,
  "p50Ms": 3.77, "p95Ms": 14.44, "rss": 245014528
}
```

- `muertesPorCausa`, `nacimientos`, `cooperaciones`, `fundadoresVivos`/`generacionesVivas` (de
  `worldStatistics(world).generations`) son **acumulados desde el inicio** de la réplica, como ya lo
  son las vistas de las que salen (`world.demographyDynamics`, `world.totals`).
- `diversidadOficios`: entropía de Shannon (bits) de `specialty()` entre los habitantes vivos, leída
  vía `projectWorld(world).people[].specialty` (la función `specialty()` no se exporta de
  `src/world/index.ts`, así que no se duplica aquí).
- `recetasDistintasEnUso`: **corregido (revisión 2026-09-19 de T016)** — ya no cuenta sobre
  `world.technology.recipes` (esa ventana residente satura en `budgets.maxRecipes`, 256, con y sin
  Store por igual: medido, día 2 con seed 51926 daba 256 en ambos regímenes). Ahora es
  `technologyCatalogueTotals(world).recipes`: con Store (el único régimen de esta réplica) es
  `world.technology.recipeCounter`, que **no** se poda al evictar la ventana y sigue creciendo
  (264 al día 2 con la misma semilla) — el número que de verdad refleja cuántas recetas distintas
  se han registrado, no el tamaño de una caché.
- `diversidadFuncional`: `technologyCatalogueTotals(world).functionalDiversity` — cuántos perfiles
  de capacidad (`Capability`: cutting/storage/insulation/cultivation/binding/abrasion, cuantizados)
  distintos se han descubierto jamás; tampoco se poda al evictar la ventana residente. Complementa a
  `recetasDistintasEnUso`: varias recetas pueden compartir el mismo perfil funcional.
- `catalogoActivo`: `catalogueEnabled(world.technology)` — instrumento directo de P3, true ⇔ el
  catálogo de producción (`enableTechnologyCatalogue`) está activo. Esta réplica SIEMPRE lo deja en
  `true`; si algún cambio futuro deja de adjuntar el `Store`, este campo (y el test que lo afirma en
  `tests/lab.test.ts`) lo detecta.
- `gini`/`fraccionComida`/`distanciaAgua`: de `worldStatistics(world)` si T013 ya añadió
  `giniRecursosPorRegion`/`fraccionCeldasConComida`/`distanciaMediaAgua`; si no, `null` (comprobación
  dinámica con `typeof`, no un import estático — no se edita `statistics.ts`).
- `p50Ms`/`p95Ms`: percentiles del coste de `stepWorld` en milisegundos reales, medidos con
  `performance.now()` **sobre los 2400 ticks de ese día** (no acumulado entre días).
- `rss`: `process.memoryUsage().rss` al final del día, en bytes.

`replica.json` (al terminar todos los días):

```json
{
  "seed": 51926, "params": { "...": "WorldParams resuelto completo" },
  "sha": "…40 hex…", "digest": "…64 hex…", "dias": 10,
  "resumen": { "poblacionInicial": 16, "poblacionFinal": 22, "...": "…" }
}
```

- `params`: el `WorldParams` **resuelto** (no la cadena `--params` cruda), para que la réplica sea
  reproducible sin depender de cómo se invocó la CLI.
- `sha`: `git rev-parse HEAD` en el momento de correr.
- `digest`: sha256 de los ficheros `.ts` de `src/world` (nombre + contenido, ordenados por nombre) —
  cambia si el código de simulación cambió, aunque el `sha` de git no se haya movido (árbol sucio).
- `resumen`: cifras finales (población inicial/final, totales acumulados, `gini`/`fraccionComida`/
  `distanciaAgua` finales) más `p50Ms`/`p95Ms` sobre **toda** la corrida y `rssMaximo`.

**Salida determinista salvo tiempos**: con la misma semilla, params y código, dos réplicas dan
exactamente los mismos valores en todas las claves salvo `p50Ms`, `p95Ms`, `rss` y `rssMaximo`
(dependen del reloj de pared y del asignador de memoria del proceso, no de la simulación).

## Gobernador consciente del servidor (`--gobernador servidor`)

Por defecto (`--gobernador no`, o sin la bandera) esta réplica corre las LEYES del mundo
(`stepWorld` sobre el mismo objeto, sin clonar) pero **no** el gobernador de población de
`src/server/app.ts` (R17: el hardware pone el límite vía `gobernador.presupuestoMs` y
`decideReproduction`). Eso es adecuado para medir ciencia pura, pero no reproduce la dinámica de
extinción del mundo público V7 (`docs/EVIDENCIA.md` §"Mundo público V7: recambio insuficiente",
`docs/ANALISIS-DINAMICAS-2026-09-21.md` §2.1): el mundo público SÍ clona por paso y SÍ apaga/reenciende
la reproducción según el p95 de los últimos 120 pasos.

`--gobernador servidor` imita `stepOnce` (`src/server/app.ts`) tick a tick:

1. Si `params.motor.clonPorPaso` (por defecto `true`): `draft = cloneWorld(world, store.context)`,
   `stepWorld(draft)`, `world = draft`. Si es `false`, `stepWorld(world)` in situ (sin clonar) —
   `motor.clonPorPaso` es un parámetro ya definido en `src/world/params.ts` que ningún motor
   consume todavía; esta réplica es el primer consumidor. **Desde PERF3 (2026-09-23) el servidor
   con `true` solo clona en los pasos con gestos** y el laboratorio no tiene gestos: para imitar el
   coste del servidor de hoy, `--params motor.clonPorPaso=false` (paso en el sitio); con `true` se mide
   el servidor anterior (ver `docs/REGLAS.md`, «Motor: reserva del paso», apartado PERF3).
2. `store.save(world)` cuando `tick % persistencia.cadaTicks === 0`, **dentro** de la ventana
   medida (igual que `stepOnce`: el coste de guardar cuenta para el presupuesto del gobernador).
3. `p95 = new RollingStepPerformance().record(stepMs)` (ventana de 120 pasos, `src/server/governor.ts`,
   el MISMO módulo que usa el servidor — no se reimplementa la política).
4. `world.reproductionEnabled = decideReproduction(p95, params.gobernador.presupuestoMs,
   world.reproductionEnabled)` — de nuevo, importado de `governor.ts`, nunca redefinido aquí.

Con `--gobernador servidor`, cada `dia-NNN.json` añade (ninguno de estos campos existe con
`--gobernador no`):

- `reproduccionActivaFraccion`: fracción de los ticks **de ese día** con `reproductionEnabled`
  (no acumulado desde el día 1: es la señal de si el gobernador estuvo cortando nacimientos hoy).
- `p95GobernadorFinal`: el p95 de la ventana de 120 pasos al final del día.
- `cloneMsP50`/`saveMsP50`: medianas de `cloneWorld`/`store.save` sobre los ticks de ese día
  (0 en `cloneMsP50` si `motor.clonPorPaso=false`).
- Ciencia barata leída del estado, sin recorridos nuevos caros:
  - `indiceDiversidad`: `{conducta, oficios, total}` de `src/world/diversidad.ts` (función real,
    la misma que cablea `src/world/statistics.ts`).
  - `cooperacionPorTipo`: `{cooperation, teaching, trade, constructionHelp, conflicts}` de
    `world.totals` (acumulados desde el inicio, como el resto de `world.totals`).
  - `comunidades`: `world.communities.length`.
  - `rasgosPorGeneracion`: media, por generación **viva**, de `resilience`/`curiosity`/
    `sociability`/`care` (`person.traits`) y `learningRate` (`person.genome`).
  - `varianzaGenetica`: varianza media de los 14 alelos (`GENE_COUNT*2`, `src/world/genetics.ts`)
    entre los vivos.
- `transmisionCultural` **no** se añade: `durableActivityMetrics` (`scripts/lab/metrics.ts`,
  ya incluido en `dailyMetrics` en ambos regímenes) no expone ningún campo con ese nombre —
  lo más cercano es `usosConEnsenanzaRecordada`, que ya viaja siempre.

`replica.json.gobernador` describe el modo usado en texto libre (antes decía siempre
"no-ejecutado"; ahora distingue "no-ejecutado" de "servidor; imita stepOnce…").

`scripts/lab/barrido.ts` acepta `--gobernador no|servidor` y lo reenvía tal cual a cada réplica del
barrido (omitido ⇒ no se pasa nada ⇒ comportamiento de siempre).

## Observador de comunidades (`observa-comunidades.ts`, hipótesis COM 2026-09-22)

`dia-NNN.json` no lleva el censo de comunidades y su conjunto de claves está fijado por
`tests/lab.test.ts`. Para medirlo sin tocar la réplica se precarga un observador:

```sh
npx tsx --import ./scripts/lab/observa-comunidades.ts scripts/lab/replica.ts --seed 42 --dias 6 --params "..." --salida DIR
```

Envuelve `Store.prototype.save` y, en cada guardado, añade una línea a `DIR/comunidades.jsonl`
(número de comunidades, fundadas en total, sin comunidad, cambios/salidas/entradas desde la
observación anterior, fundadas/disueltas y, por comunidad, miembros, distancia media y máxima al
centro y grupos espaciales a ≤ 6 celdas). Sólo lee campos planos: los `dia-NNN.json` salen
idénticos con y sin observador (comprobado contra la base de la noche, semillas 7/42/51926/1).

## Criterio de terminado (`criterio-terminado.mts`, Steven 2026-09-22)

> «En el laboratorio, la mayoría de semillas mantiene población y recambio durante al menos 60 días
> simulados con varias generaciones vivas, más de un tipo de cooperación relevante, conflictos y
> muertes con causa legible, tecnología que se transmite y diversidad de conducta creciente.»

Evalúa ese criterio sobre un conjunto de réplicas **ya producidas** (solo lee `dia-NNN.json` y
`replica.json`; no simula): un directorio con un subdirectorio `<brazo>-<semilla>` por réplica.

```sh
npx tsx scripts/lab/criterio-terminado.mts --entrada <conjunto> [--dia 60|comun] [--ventana 10] [--salida informe.json]
# p. ej. corte intermedio de un conjunto en marcha:
npx tsx scripts/lab/criterio-terminado.mts --entrada $SCRATCH/r2 --dia 10 --salida $SCRATCH/criterio-r2-d10.json
```

Por semilla, al día D (por defecto 60; `--dia comun` = último día que ya escribieron todas las no
extinguidas), con ventana = los 10 días que terminan en D. Umbrales por defecto (todos ajustables; la
justificación de cada uno está en la cabecera del script y se repite en la salida):

| # | criterio | cumple si… | banderas |
|---|---|---|---|
| C1 | supervivencia | `poblacion ≥ 16` **todos** los días de la ventana, no solo el día D (14 fundadores mortales + S e I) | `--poblacion-min` |
| C2 | recambio | nacimientos en la ventana ≥ 1 **y** `fundadoresMortalesVivos(D) ≤ 1` | `--nacimientos-min --fundadores-max` |
| C3 | varias generaciones | `generacionesMortalesVivas(D)` ≥ 3 (sin S e I, que mantienen viva la generación 0; si falta, `generacionesVivas` solo como cota: cumple si `generacionesVivas − 1 ≥ 3`, si no «desconocido» o falla). La lista debe ser de enteros ≥ 0 distintos (se cuenta un Set): basura o repetidas (`[2, 2, 2]`) ⇒ «desconocido» | `--generaciones-min` |
| C4 | cooperación variada | ≥ 2 tipos de la lista **cerrada** {teaching, trade, constructionHelp, foodShared} (otra clave de `cooperacionAcumuladaPorTipo`, p. ej. el alias `Teaching`, se informa y no cuenta), cada uno ≥ 10 % de los actos de la ventana **y** ≥ 5 actos en ella; un tipo que falta en el día base da «desconocido» | `--coop-tipos-min --coop-fraccion-min --coop-actos-min` |
| C5 | conflictos | `conflictosAcumulados` crece ≥ 1 en la ventana (si es 0 en toda la réplica lo dice) | `--conflictos-min` |
| C6 | muertes legibles | 0 muertes fuera de starvation/dehydration/exposure/senescence, ≥ 2 causas en 1..D y balance `Δpoblación = Δnacimientos − Δmuertes` desde el día 0 (16 habitantes, o `resumen.poblacionInicial`) | `--causas-min --causas-conocidas` |
| C7 | tecnología transmitida | Σ`usosDeInventorAjeno` / Σ(`usosUtiles` − `usosSinAutorResuelto`) en la ventana ≥ 0,15 y uso ajeno en ≥ 50 % de sus días. Cada día `usosDeInventorAjeno ≤ usosUtiles − usosSinAutorResuelto` (si no, «desconocido»); ningún uso útil ⇒ falla; < 20 usos con autor conocido ⇒ «desconocido» (muestra insuficiente) | `--uso-ajeno-min --dias-uso-ajeno-min --usos-con-autor-min` |
| C8 | diversidad creciente | **Preregistro v2** (ver abajo): Mann-Kendall unilateral de tendencia creciente, p < 0,05, sobre los días 5..D (≥ 10 días con dato; Var(S) con empates y corregida por autocorrelación) **y** subida de Sen (pendiente × (D − 5)) ≥ 0,02. Se mantienen: serie `diversidadConductaActiva` → `diversidadConductaTiempo` → `diversidadConducta` (las otras, secundarias), cobertura ≥ 80 % y extremos completos (si no, «desconocido»). Con huecos en el medio, «cumple» solo si se sostiene con los días que faltan en su valor más desfavorable. Índice fuera de [0, 1] ⇒ «desconocido»; serie constante ⇒ falla. Las reglas v1 (pendiente MCO «o»/«y» bloques) se informan en `valores.reglasAntiguas`, no deciden | `--subida-min --correccion-mk --dia-base-diversidad --diversidad-campo auto\|activa\|tiempo\|actividad --diversidad-regla mk\|o\|y` |

- Cada criterio es cumple / falla / **desconocido** (campo ausente): nunca se aprueba por defecto.
- Nada se decide con un día suelto: `diversidadConducta` salta ±0,1 de un día a otro en r2, así que
  C8 usa un test de tendencia sobre todo el tramo (≥ 10 días) y C1 mira toda la ventana.
- **Coherencia** (verificador de INSTR-3; cualquier fallo da «ilegible» o «desconocido», nunca «cumple»):
  el `tick` de cada `dia-NNN.json` debe existir, ser numérico y valer NNN·2400 (si no, ilegible);
  contadores y poblaciones que deciden algo (`poblacion`, `nacimientos`, `vecinosMortales`,
  `fundadores*`, `generacionesVivas`, `conflictosAcumulados`, `usos*`, `foodShared`, cada causa de
  `muertesPorCausa` y cada tipo de la lista cerrada de cooperación) deben ser enteros ≥ 0 cuando están
  (si no, ilegible); dos directorios del mismo brazo que resuelven a la misma semilla (`x-1`, `x-01`,
  `x-001`) son todos ilegibles con un error que los nombra; un acumulado que decrece (nacimientos,
  conflictos, una causa de muerte, un tipo de cooperación) da «desconocido»; el índice de diversidad
  debe estar en [0, 1]; y la comparación de bloques de las reglas v1 usa tolerancia 1e-9 (bloques
  iguales no son «crecer»).
- C8 exige cobertura: la serie evaluada (la que decide y cada secundaria) debe tener dato en ≥ 80 %
  de los días del tramo 5..D; si no, «desconocido», nunca «cumple». Cierra el hueco que encontró el
  verificador: una serie por tiempo presente solo los días 5-7 (creciente) decidía sola y aprobaba C8
  aunque la serie completa cayera.
- C8 exige además los **extremos completos** (verificador de INSTR-2): dato el día D y en todos los días
  de los dos bloques (los k primeros desde el día 5 y los k últimos); si falta alguno, «desconocido».
  Con 81 % de cobertura pero los días finales (o los más bajos) ausentes, el bloque final no se podía
  calcular y la regla «o» aprobaba solo con la pendiente de los días que quedaban. Si los huecos caen
  en el medio del tramo, una pendiente **favorable** no aprueba sola (esconder días bajos del final del
  medio la inclina): cuenta como desconocida y decide la comparación de bloques. Con la serie completa
  (lo que escribe `replica.ts`) nada de esto cambia el resultado. (Eso era la v1; en v2 los huecos del
  medio se tratan con la cota pesimista de S, ver «Preregistro v2 de C8».)
- C8 no usa igualdad exacta: dos valores a ≤ 1e-9 × máx(1, máx |valor|) son un empate para
  Mann-Kendall, su varianza y Sen; una serie de una sola clase de empate es constante ⇒ falla (0,3
  constante con 1e-15 más el día D aprobaba la v1 por pendiente 2e-17).
- Solo se aceptan ficheros `dia-NNN.json` con el nombre que escribe `replica.ts` (3 dígitos,
  `padStart(3, '0')`). Dos ficheros que resuelven al mismo día (`dia-20.json` y `dia-020.json`) o un
  nombre no canónico suelto hacen la réplica **ilegible** con un error que los nombra (los 8
  «desconocido»); antes el último leído pisaba al otro en silencio.
- `replica.ts` solo escribe las 4 causas conocidas en `muertesPorCausa`: la comprobación que de verdad
  detecta una muerte sin causa en C6 es el balance.
- **Extinguida** (algún día ≤ D con 0 `vecinosMortales`): cuenta y falla los 8. **En curso** (sin
  `replica.json` y sin dia-D) y **corta** (terminó antes de D sin extinguirse): excluidas, se dice
  cuántas y por qué día van. Una réplica que sigue corriendo pero ya escribió dia-D se evalúa. Sin
  `vecinosMortales` la extinción se lee como `poblacion ≤ 2` (S e I son inmortales). Una «en curso»
  que lleva > 3 h sin escribir (`--estancada-horas`) se avisa como posible proceso muerto.
- Veredicto por brazo (`--mayoria 0.5`): «mayoría» si cumplen los 8 ≥ 50 % de las semillas del brazo
  aunque todas las excluidas fallaran; «no mayoría» si ni contando como aprobadas las excluidas y las
  desconocidas se llega; si no, «indeterminado». También se da la fracción literal sobre evaluadas.
- Con D < 60 la salida avisa de que el corte es **provisional**: el criterio exige 60 días, así que un
  «no mayoría» al día 10 es del corte, no del criterio.
- Salida: tabla por brazo (cumplen/evaluadas por criterio y los 8 a la vez), una línea por réplica
  con el motivo de cada fallo, y el informe completo en JSON con `--salida`.

## Preregistro del criterio C8 (orquestador, noche 2026-09-22)

Decisión tomada **antes** de ver corridas largas, para que no sea elegir, a posteriori, la medida que
aprueba. «Diversidad de conducta creciente» se lee con **`diversidadConductaActiva`**: el mismo
`indiceDiversidad` (`src/world/diversidad.ts`, misma fórmula y mismos grupos del vector) con la
actividad sustituida por los ticks por acción del observador **sin `rest`**. En modo `auto` decide esa
serie si la réplica la trae; si no, `diversidadConductaTiempo`; si no, `diversidadConducta`. Las demás
series que haya se evalúan igual y se informan como secundarias: no deciden.

Por qué, serie por serie:

- **`diversidadConducta` (antigua, `person.activity`)**: `move()` suma +1 a `activity.explore` por
  **cada celda nueva**, mientras los demás oficios suman 1 por trabajo terminado. Explorar infla el
  índice: es el 45-61 % de la activity con el 10-21 % del tiempo y el «oficio dominante» de la mayoría
  (ver «Por qué el índice antiguo sobrerrepresenta explorar» más abajo).
- **`diversidadConductaTiempo` (ticks por acción)**: corrige ese sesgo pero cae en otro: descansar ocupa
  el 20-39 % del tiempo y es el oficio dominante por tiempo de casi todos, así que su componente
  `oficios` tiende a 0 y el índice mide sobre todo cuánto se descansa.
- **`diversidadConductaActiva` (ticks por acción sin `rest`)**: descansar es inactividad, no conducta.
  Quitarlo deja el reparto del tiempo **activo** entre las 17 acciones restantes, que es la lectura más
  fiel de «diversidad de conducta». Quien en el tramo observado solo descansó queda con la actividad
  vacía, igual que alguien que aún no actuó (`dominantAction` = «sin oficio aún»).

Solo se excluye `rest`: las otras 17 acciones, comer y beber incluidas, cuentan como conducta (el
preregistro no quita nada más). La decisión y la regla de cobertura (≥ 80 % de los días 5..D con
dato; si no, «desconocido») están en la cabecera de `criterio-terminado.mts` y en sus tests
(`tests/criterio-terminado.test.ts`: el caso sintético del verificador da «desconocido»; una activa
completa y creciente da «cumple» aunque tiempo y antigua caigan; una activa completa que cae da
«falla» aunque las otras dos crezcan).

## Preregistro v2 de C8 (orquestador, 2026-09-22 21:45)

Fijado **antes** de mirar C8 en los conjuntos de 60 días (y registrado en la bitácora de la noche).
La razón: la regla v1 («pendiente MCO ≥ 0 **o** media de los 10 últimos días ≥ media de los 10
primeros») aprobaba **ruido estacionario** en el ~60 % de las series: con 0,3 ± 0,1 uniforme cada día,
la pendiente de mínimos cuadrados sale ≥ 0 la mitad de las veces y la comparación de bloques otra
mitad, y la «o» suma las dos. Medido: 58 % a D = 60 (1000 series) y 180 de las 300 réplicas de ruido del
verificador de INSTR-3, que la v1 declaraba «mayoría». Un criterio que aprueba el azar no distingue un
mundo cuya conducta se diversifica de uno que no cambia.

**C8 v2** (`scripts/lab/criterio-terminado.mts`, regla `mk`, la de por defecto). Sobre la serie que
decide (activa > tiempo > actividad, sin caer a otra), días base..D (base = `--dia-base-diversidad`, 5):

1. **Mann-Kendall** de tendencia creciente, unilateral, **p < 0,05**. S = Σ_{i<j} sgn(x_j − x_i); Var(S) =
   [n(n−1)(2n+5) − Σ t(t−1)(2t+5)] / 18 con corrección por empates (empate = diferencia ≤ 1e-9);
   aproximación normal con corrección de continuidad, z = (S − 1)/√Var(S). Con n < 10 días con dato,
   «desconocido».
2. **Corrección por autocorrelación** (`--correccion-mk hamed-rao-ar1`): Var(S) × el mayor de dos
   factores, ambos acotados a ≥ 1 (una autocorrelación negativa espuria nunca estrecha la varianza):
   Hamed y Rao (1998; autocorrelaciones significativas, |ρ_k| > 1,96/√n, de los rangos del residuo sin
   tendencia x − β·t con β = Sen) y el mismo factor con un AR(1) paramétrico, ρ_k = r*^k, con r* = (n·r₁
   + 1)/(n − 4) (corrección de sesgo de Yue y Wang) del residuo, acotado a [0; 0,95]. El preregistro pedía
   añadir Hamed-Rao si el AR(1) φ = 0,7 superaba el 10 %: sin corrección daba 21-25 %, con Hamed-Rao
   solo, 15-17 % (su estimador empírico subestima la autocorrelación con n = 26-56); con el factor AR(1),
   7 %. Por eso el defecto es el mayor de los dos.
3. **Y subida de Sen** (mediana de las pendientes entre pares × (D − base)) **≥ 0,02** (`--subida-min`):
   un test significativo con una subida despreciable no es «diversidad creciente» (una serie constante
   con un 1e-6 más el día D da p ≈ 0,05 y subida 0).

Se mantienen de la v1: la elección de la serie (preregistro anterior, arriba), la cobertura ≥ 80 % de
los días base..D y los extremos completos (dato el día D y en todos los días de los bloques de k días de
cada extremo); si no, «desconocido». **Huecos en el medio**: un «cumple» debe sostenerse con los días
que faltan en su valor **más desfavorable** (cota inferior de S: cada día que falta toma el valor que
minimiza su suma de signos con los días con dato, los pares entre días que faltan cuentan −1, Var(S) con
n completo); si no, «desconocido». Así, esconder los 11 días más bajos de 30..50 de una serie de ruido
(p = 0,0099 con los días que quedan) da p pesimista 0,35 ⇒ «desconocido» (test «esconder los días
bajos»). Un índice fuera de [0, 1] o no numérico en el tramo ⇒ «desconocido».

`valores` documenta S, Var(S), z, p (y `pSinCorreccion`), `factor`, `factorHamedRao`, `factorAr1`,
`r1`, `pendienteSen`, `subida`, `pPesimista` (con huecos) y `reglasAntiguas` (estado «o» y «y» de la
v1, pendiente MCO y medias de bloques: se informan, **no deciden**). `--diversidad-regla o|y` vuelve a
decidir con la v1 solo para reproducir informes antiguos, y el informe lo avisa en cabeza.

### Calibración (`scripts/lab/calibrar-c8.mts`)

```sh
npx tsx scripts/lab/calibrar-c8.mts [--series 1000] [--semilla 20260922] [--salida calibracion.json]
```

1000 series sintéticas por caso con un PRNG determinista propio (mulberry32, una semilla por caso y
horizonte derivada de 20260922), evaluadas con la MISMA función que usa el evaluador
(`evaluarSerieDiversidad`). Tasa de C8 = «cumple» (días 5..D; ruido U(±0,1) = 0,3 ± 0,1 uniforme):

| caso | D | v2 por defecto (MK, Hamed-Rao + AR(1)) | MK, solo Hamed-Rao | MK sin corrección | v1 «o» | v1 «y» |
|---|---|---:|---:|---:|---:|---:|
| estacionaria — 0,3 ± 0,1 uniforme, independiente | 60 | 4,0 % | 4,5 % | 4,5 % | 58,1 % | 40,8 % |
| ar1 — AR(1) φ = 0,7, innovación U(±0,1) (σ marginal 0,081) | 60 | 7,2 % | 15,1 % | 23,3 % | 55,8 % | 42,0 % |
| ar1-var — AR(1) φ = 0,7, σ marginal 0,058 (= estacionaria) | 60 | 6,9 % | 16,3 % | 24,5 % | 56,0 % | 41,1 % |
| sube-0.001 — creciente 0,001/día + ruido U(±0,1) | 60 | 58,6 % | 61,7 % | 62,8 % | 99,3 % | 95,6 % |
| sube-0.003 — creciente 0,003/día + ruido U(±0,1) | 60 | 100,0 % | 100,0 % | 100,0 % | 100,0 % | 100,0 % |
| baja-0.001 — decreciente 0,001/día + ruido U(±0,1) | 60 | 0,0 % | 0,0 % | 0,0 % | 3,9 % | 0,9 % |
| paseo — informativo: paseo aleatorio 0,3 + Σ U(±0,03) (no estacionario, sin tendencia) | 60 | 19,7 % | 32,7 % | 40,0 % | 50,5 % | 46,5 % |
| satura — informativo: sube 0,2 saturando, 0,3 + 0,2·(1 − e^{−(d−5)/10}) + ruido U(±0,1) | 60 | 99,0 % | 99,2 % | 100,0 % | 100,0 % | 100,0 % |
| estacionaria — 0,3 ± 0,1 uniforme, independiente | 30 | 3,2 % | 3,7 % | 3,7 % | 54,2 % | 42,8 % |
| ar1 — AR(1) φ = 0,7, innovación U(±0,1) (σ marginal 0,081) | 30 | 7,4 % | 16,6 % | 20,9 % | 52,6 % | 45,7 % |
| ar1-var — AR(1) φ = 0,7, σ marginal 0,058 (= estacionaria) | 30 | 7,3 % | 17,4 % | 21,9 % | 54,0 % | 47,4 % |
| sube-0.001 — creciente 0,001/día + ruido U(±0,1) | 30 | 10,7 % | 12,8 % | 13,2 % | 76,8 % | 68,9 % |
| sube-0.003 — creciente 0,003/día + ruido U(±0,1) | 30 | 50,9 % | 55,6 % | 56,1 % | 98,8 % | 97,0 % |
| baja-0.001 — decreciente 0,001/día + ruido U(±0,1) | 30 | 1,2 % | 1,3 % | 1,3 % | 31,8 % | 23,1 % |
| paseo — informativo: paseo aleatorio 0,3 + Σ U(±0,03) (no estacionario, sin tendencia) | 30 | 20,9 % | 34,7 % | 39,5 % | 53,2 % | 50,8 % |
| satura — informativo: sube 0,2 saturando, 0,3 + 0,2·(1 − e^{−(d−5)/10}) + ruido U(±0,1) | 30 | 95,6 % | 97,8 % | 98,4 % | 100,0 % | 100,0 % |

Requisitos del preregistro: estacionaria independiente ≤ 7 % (**4,0 % y 3,2 %**); AR(1) φ = 0,7 ≤ 10 %
tras la corrección (**7,2 % y 7,4 %**; 6,9 % y 7,3 % con la misma varianza marginal que la
estacionaria). **Potencia para 0,003/día: 100 % a D = 60 y 51 % a D = 30** (25 días de tramo; la subida
de 0,075 queda cerca del ruido ±0,1); para 0,001/día, 59 % y 11 %. Decreciente: 0 % y 1,2 %. El test
`calibración de C8` de `tests/criterio-terminado.test.ts` recalcula la tabla y la compara con estas cifras
y con las cotas.

Límites conocidos (filas informativas, sin cota en el preregistro): un **paseo aleatorio** (no
estacionario, sin tendencia) aprueba el ~20 %: si la serie real deriva como un paseo, una deriva
ascendente es indistinguible de una tendencia con 26-56 días; la corrección lo baja del 40 % sin
corrección. Un crecimiento que **se aplana** (satura) conserva la potencia (99 % y 96 %) aunque la
corrección AR(1) lea la curvatura como autocorrelación.

## Techo de laboratorio (`--techo-lab N`, noche 2026-09-22)

`replica.ts --techo-lab N` emula la política `techo` del gobernador del servidor
(`gobernador.politica = 'techo'`, `decidirConTecho` en `src/server/governor.ts`) con el techo **ya
fijado en N**, en lugar del que dispara el p95 del paso. Antes de cada paso:

```
world.reproductionEnabled = decidirConTecho(rojo, presupuesto, población, { techo: N }).reproduccion
                          = población < N
```

con la población contada **exactamente** como la cuenta el servidor: `world.people.length`, todas las
personas vivas con S e I incluidas (`governReproduction` en `src/server/app.ts` pasa
`draft.people.length` a `gobernador.decidir`). Se reutiliza la función del servidor, no se reimplementa
(`scripts/lab/techo-lab.ts`). El servidor decide tras cada paso para el siguiente; aquí se decide antes
de cada paso sobre la misma población (la del final del paso anterior).

**Por qué**: el techo del servidor depende del reloj de pared (carga de la torre, otras réplicas en
paralelo), así que dos corridas de la misma semilla no frenan en el mismo sitio. Para corridas de 60
días **comparables** entre semillas y brazos y **reproducibles** bit a bit hace falta un techo fijo:
con él, una vez alcanzado N los nacimientos solo reponen muertes, como en el servidor bajo rojo.

**Qué NO es**: no es una ley del mundo (no toca `src/world` ni los params; solo `reproductionEnabled`,
el mismo interruptor que ya gobierna el servidor) ni un tope del servidor. El servidor sigue gobernado
por hardware (ruling R17, FR-013: sin topes fijos de población; `POPULATION_HARD_LIMIT` es solo
anticorrupción). N es una condición experimental del laboratorio y debe declararse junto a cada
resultado que la use.

**Cota que garantiza** (`techoLabCota`): solo `reproduce()` (`src/world/index.ts`) añade personas y solo
con `reproductionEnabled`; en un paso nacen como mucho `poblacion.nacimientosPorComprobacion` (2 por
defecto: el cupo menos los nacidos en la ventana de `intervaloComprobacionTicks`). Si antes del paso
hay P ≥ N no nace nadie; si P ≤ N − 1, tras el paso hay ≤ N − 1 + nacidos del paso. Por inducción, tras
cualquier paso:

```
población ≤ max(poblaciónInicial, N − 1 + nacimientosPorComprobacion)
```

Es decir, se pasa de N como mucho en los nacidos de **un** paso menos uno (los que ya estaban
decididos cuando aún había sitio). `tests/lab-techo.test.ts` lo comprueba a resolución de paso con
N = 18 en la semilla 42 (etapa 1): máximo 18 ≤ 19, reproducción habilitada el 7 % de los ticks del
día; sin techo el mismo mundo llega a 23. Dos corridas dan el mismo `digestoMundoFinal`.

Efectos colaterales, los mismos que en el servidor con el techo puesto: `reproductionEnabled = false`
también apaga la cría de fauna (`src/world/animals.ts`), el cortejo (`poblacion.cortejo`) y la
intención de reservar comida para criar (`familyOpportunity`, `src/world/family.ts`).

Salida (solo con la bandera):

- cada `dia-NNN.json`: `techoLab` (N), `reproduccionActivaFraccion` (fracción de los ticks **de ese
  día** con `reproductionEnabled`, mismo nombre que con `--gobernador servidor`) y `poblacionMaximaDia`
  (máximo de `world.people.length` tras cada paso del día);
- `replica.json`: `techoLab`, `techoLabDetalle` (`reproduccionActivaFraccion` de toda la réplica,
  `poblacionMaxima`, `cotaPoblacion`, cómo se cuenta la población) y `gobernador` lo describe.

## Instrumentos de medida (`instrumentos.ts`, ronda INSTR 2026-09-22)

Dos instrumentos **de medida**, no de mundo: solo leen `World`/`Person` y acumulan en memoria del
laboratorio (nunca en `World` ni en `Person`). Activos por defecto en `replica.ts`;
`--instrumentos no` los apaga y devuelve los `dia-NNN.json` de siempre.

### Por qué el índice antiguo sobrerrepresenta explorar

`diversidadConducta` es `indiceDiversidad` (`src/world/diversidad.ts`): media de la distancia coseno
entre vectores de conducta y de la entropía del «oficio dominante», ambos leídos de
`person.activity`. Pero `activity` no mide lo mismo para todos los oficios: `move()` llama a
`outcome('explore')` (+1 en `activity.explore`) por **cada celda nueva** que pisa quien explora,
mientras los demás oficios suman 1 por **trabajo terminado**. Cifras (verificadas por dos agentes en
la ronda EXPL, params del carril R2): semilla 42 día 2, explorar es el 44,5 % de la activity con el
10,2 % del tiempo y es el oficio dominante de 18 de 23 personas (día 4: 54 %, 22 de 26); semilla 7
día 1, el 61 % de la activity con el 21 % del tiempo, dominante en 16 de 21. Recontar explorar una
vez por tramo sobre el MISMO mundo sube el índice (día 6: semilla 2024 0,099 → 0,383; 31337 0,098 →
0,342; 42 0,198 → 0,444). Con estos instrumentos, en las 4 semillas × 4 días de abajo explorar es el
4-32 % del tiempo de los mortales y el 18-82 % de sus incrementos de activity.

### 1. Conducta por tiempo

Tras **cada** paso (`K = 1`), antes del guardado, se anota la acción (`person.action`) de cada persona
viva y se acumulan ticks por acción desde que el laboratorio la ve (tick 0 o su nacimiento). Coste
medido: 0,014-0,022 ms por paso (0,18-0,23 % de `stepWorld`), así que no hace falta muestrear. Campos
nuevos por día:

- `diversidadConductaTiempo`: **el mismo** `indiceDiversidad` (misma fórmula, mismos grupos del vector:
  tecnología, alimento, lugares) sobre vistas de las personas (`Object.create(person)`) cuya `activity`
  se sustituye por esos ticks. Solo cambia la entrada de actividad; con la `activity` original la vista
  da exactamente `worldStatistics(world).diversidad` (test). Personas: las de `world.people`, como el
  índice antiguo (incluye a S e I).
- `diversidadConductaActiva` (+ `diversidadConductaActivaComponentes`): el mismo índice con esos ticks
  **sin `rest`** (`sinDescanso`); quien solo descansó queda con la actividad vacía. Es la serie que
  decide C8 (ver «Preregistro del criterio C8»).
- `diversidadConductaTiempoComponentes` / `diversidadConductaActivaComponentes` /
  `diversidadConductaComponentes`: `{conducta, oficios}` de cada índice (su media es el total).
- `repartoTiempoPorAccion`: `{personaTicks, fracciones}` del **día** entre los vecinos mortales vivos
  en cada paso (fracciones en el orden fijo de las 18 acciones, solo las > 0).
- `repartoActividadPorAccion`: `{incrementos, fracciones}` de lo que creció `activity` ese día entre los
  mortales vivos al final del día (lo de quien murió durante el día no se cuenta): el contraste directo
  con el reparto de tiempo.
- `diversidadConducta` se conserva tal cual (compatibilidad).

**Ojo, el índice por tiempo tiene su propio sesgo**: descansar (`rest`) ocupa el 20-39 % del tiempo de
los mortales y, acumulado, es el oficio dominante por tiempo de casi todos (día 4: 32 de 34 personas en
la semilla 7, 28 de 31 en la 42, 20 de 21 en la 2024; 28 de 28 en la 42 día 3), igual que explorar lo
es por activity (15-21 personas al día 4). Su componente `oficios` colapsa (0,00 en la semilla 42 día
3) y la pendiente MCO de los días 1-4 es negativa en 3 de 4 semillas, mientras la del índice antiguo es
positiva en 3 de 4. No es «el bueno»: mide en qué se va el tiempo, no qué se produce. Por eso existe la
serie activa (sin descansar), que es la que decide C8, y el criterio informa las tres.

### 2. Comida compartida (`cooperacionAcumuladaPorTipo.foodShared`)

`share()` (`src/world/index.ts`) es la única entrega de comida entre personas vivas: el donante da 0,025
de su reserva (`inventory`) a otra persona con hambre > 0,27 a ≤ 2 celdas, junto a un lugar, y el mundo
emite **un** suceso `kind: 'care'` (único emisor de ese tipo en `src/world`). Un acto = un suceso `care`
nuevo en `world.chronicleJournal.pending` tras el paso (la serie `e<antes+1>..e<después>`; si no está
entera, la réplica falla en voz alta). Acumulado desde el tick 0 de la réplica, de cualquier donante
(S, I o vecino, como `world.totals`). **No** cuentan: la herencia al morir (`transferEstate`, suceso
`ecology`), ni depositar o tomar comida de estructuras (almacén común, no una entrega entre personas).
Contraprueba en el test: coincide con los donantes que acaban el paso con `lastShared = tick`. No
entra en `world.totals.cooperation`, así que `otrasCooperacionesAcumuladas` no cambia. Sin este instrumento
la cooperación tipificada se leía casi solo como enseñanza (79-100 % de los actos acumulados al día 4
en las semillas de abajo; «97 %» en r2); con él, compartir comida es el 43-66 % de los actos
tipificados al día 4 y C4 (corte provisional, día 4, ventana 3) pasa de 2/4 a 4/4 semillas.

### Garantía: cambia la MEDIDA, no el mundo

- `tests/instrumentos-lab.test.ts`: en proceso, dos mundos en paralelo (con y sin observador) dan el
  mismo `digestoCanonico` cada 300 pasos; por CLI, una réplica de 1 día con y sin instrumentos da el
  mismo `digestoMundoFinal` (nuevo en `replica.json`) y los mismos `dia-001.json` salvo los campos
  nuevos (y `foodShared`).
- Medición de la ronda: 4 semillas (7, 42, 2024, 31337) × 4 días con el paquete de la etapa 1: los 16
  `dia-NNN.json` coinciden campo a campo (salvo tiempos) con los de `r2/Psinagua-<semilla>`, que
  corrieron SIN instrumentos y con `Store`, sobre el árbol anterior a la optimización del paso.
- Con `--gobernador servidor` el tiempo del observador se descuenta del `stepMs` que decide el
  gobernador; ese modo depende del reloj y no es bit a bit reproducible con ni sin instrumentos.

### 3. Natalidad local (`natalidadLocal`) y fauna (`faunaTotal`), campaña NAT-L 2026-09-23

Definiciones congeladas por `docs/preregistros/2026-09-23-natalidad-local.md` (Revisión 1); las lee
`decision-natalidad.mts`. Se escriben en CTRL y en NAT: con `poblacion.natalidadLocal` = 0 los valores
de x vienen de una sonda pasiva con α = 1, calculada en `reproduce()` DESPUÉS de elegir la pareja, que
no decide nada ni consume azar.

- `natalidadLocal.nacimientosDia`: nacimientos del día que informa `reproduce()`.
- `natalidadLocal.xNacimientos` {p10, p50, p90}: x = máx(W/(α·A), F/(α·C)) en el lugar de cada
  concepción (A, C = reposición diaria de agua y comida a ≤ R; W, F = demanda diaria de las personas a
  ≤ R con `bodilyNeedRates`). Percentil = índice ⌊(n−1)·p⌋; un x infinito se ordena al final y el
  percentil que cae en él se escribe null; sin nacimientos, null.
- `natalidadLocal.xFertiles`: igual, en la posición redondeada de cada mortal con `fertile` al cierre.
- `natalidadLocal.bloqueadasPorLey`: cada `a` que la ley rechaza y cada candidato `b` que pasó `match`
  pero no el intervalo; las reevaluaciones del mismo paso vuelven a contar. 0 con α = 0.
- `natalidadLocal.kOcupado` {agua, comida}: reposición de la unión de discos de radio R alrededor de
  los mortales vivos (cada tesela y cisterna una vez); `nSobreKOcupado` = máx(W/A, F/C) con la demanda
  de TODAS las personas vivas (S e I incluidos), null si falta reposición con demanda.
- `natalidadLocal.limitante` {agua, comida}: fracción de los nacimientos del día cuyo término máximo
  fue el agua o la comida (empate: agua).
- `faunaTotal` (también con `--instrumentos no`): animales vivos de las zonas activas
  (`world.animals`, de la que `tile.fauna` es espejo) más los congelados en chunks en reposo.
- Garantía: el observador vive fuera del mundo (no se serializa); `tests/natalidad-integracion.test.ts`
  comprueba el mismo digesto con y sin él, con α = 0 y α = 1.

## Diagnóstico de disputas (`diagnostico-disputas.ts`, hipótesis CONFL 2026-09-22)

```sh
npx tsx scripts/lab/diagnostico-disputas.ts --seed 51926 --dias 5 --params "..." --salida fichero.json
```

Sigue cada evento `conflict` (el que cede es `actors[0]`): necesidad (máximo de hambre y sed) de
cada lado antes del paso, si eran de la misma comunidad, sobre qué acción se disputó (la que conserva
quien no cede), si quien cedió vuelve a la MISMA celda en los 240 pasos siguientes, cuántas disputas
más encadena en un día y si alguno de los dos muere en el día siguiente, y de qué. Sólo lee el mundo;
imprime una línea por día y un resumen al final. Midió el cerrojo que la ley `social.memoriaDisputa`
corrige (ver `docs/REGLAS.md`, §Conflicto legible).

## Rendimiento

Con `persistencia.cadaTicks = 1` (el valor por defecto, igual que producción hoy), guardar en cada
tick cuesta caro: ~32 ms/tick medidos en esta torre (un día completo, ~78 s). Para barridos grandes
(T017/T018) conviene pasar `--params "persistencia.cadaTicks=200"` (o el valor que se calibre en
T031) para acelerar sin dejar de ejercitar el guardado periódico con `Store`; los tests de este
fichero usan `persistencia.cadaTicks=300` por la misma razón.

### Perfil y control de identidad — `rendimiento.ts` (sprint noche-perf 2026-09-22)

```bash
npx tsx scripts/lab/rendimiento.ts digestos                      # digestoCanonico tras 1200/2400 pasos en 51926, 7 (leyes candidatas) y 42 (defaults)
npx tsx scripts/lab/rendimiento.ts instantanea --seed 51926 --dias 6 --salida DIR   # mundo representativo (población ~58)
npx tsx scripts/lab/rendimiento.ts perfil --desde DIR --pasos 1200                  # CPU propia por fase y paso + digestos
node --cpu-prof --import tsx scripts/lab/rendimiento.ts perfil --desde DIR --pasos 1200  # perfil por función
```

Mismo régimen que `replica.ts` (Store temporal, guardado cada `persistencia.cadaTicks`). `perfil` mide con
`process.cpuUsage` —tiempo de CPU del proceso, no reloj de pared— porque la torre suele estar cargada; compara
siempre antes/después en la misma sesión. Toda optimización del paso debe dejar el mundo bit a bit igual:
`tests/rendimiento-identidad.test.ts` fija los digestos del árbol sin optimizar (cómo se obtuvieron, en su
cabecera). Con el mundo de 6 días de la semilla 51926 (leyes candidatas), el paso bajó de 112 a 60 ms de CPU
(×1,86) sin mover un bit (digestos idénticos a 1200 y 2400 pasos).

### Escala con la población — `../perf/` (sprint noche-perf2 2026-09-22)

```bash
export TMPDIR=/datos/tmp-atlas-lab   # nunca /tmp: tiene cuota
npx tsx scripts/perf/instantaneas.ts --seed 3 --dias 3,6,9,12.25 --salida DIR   # mundos de una misma semilla a varias poblaciones
npx tsx scripts/perf/fases.ts --db DIR/d06/world.sqlite --pasos 600 [--digesto H]  # CPU propia por fase de cualquier base (se copia; el original no se toca)
node --cpu-prof --cpu-prof-dir P --import tsx scripts/perf/fases.ts --db … --pasos 300
npx tsx scripts/perf/cpuprof.ts resumen P/*.cpuprofile --pasos 300 --poblacion N --salida r.json  # ms/paso por función (línea real del .ts)
npx tsx scripts/perf/cpuprof.ts comparar chico.json grande.json                                # exponente k de cada función con N
scripts/perf/escalado.sh SALIDA chico.sqlite grande.sqlite    # todo lo anterior para dos mundos a la vez
```

`fases.ts` carga cualquier base con el `Store` del proyecto (los params viajan con el mundo), así sirve también
para copias de réplicas (`sqlite3 .backup`). `cpuprof.ts` traduce las columnas del código que tsx entrega en una
sola línea a la línea del `.ts` con los mapas de su caché (`$TMPDIR/tsx-<uid>`).

**Control de una optimización** (identidad bit a bit + CPU base/rama). Exportar SIEMPRE el commit base con
`git archive` (nunca comparar contra el propio árbol) y enlazarle `node_modules`:

```bash
git archive <base> | tar -x -C /datos/tmp-atlas-lab/perf2-base && ln -s "$PWD/node_modules" /datos/tmp-atlas-lab/perf2-base/
(cd /datos/tmp-atlas-lab/perf2-base && for c in d51926 s7 s42; do npx tsx scripts/perf/identidad.ts $c --salida REF/base-id-$c.json; done)
BASE=/datos/tmp-atlas-lab/perf2-base REF=REF bash scripts/perf/verificar.sh SALIDA [alto.sqlite] [bajo.sqlite] [pasos]
npx tsx scripts/perf/alterna.ts --base /datos/tmp-atlas-lab/perf2-base --db alto.sqlite --pasos 1200   # sólo CPU + digesto final
```

`identidad.ts` da los digestos de control (51926 con los params históricos a 2400 pasos; 7 y 42 con las leyes de la etapa 1
a 4800). `alterna.ts` importa los DOS árboles en el mismo proceso, carga cada uno su copia de la base y los
avanza por bloques alternados de 10 pasos: la CPU propia de cada bloque ve la misma carga de la torre (con carga
60–100 los mismos pasos cuestan 2–3 veces más CPU que a carga 20, así que dos corridas separadas no se pueden
comparar), y al final exige el mismo `digestoCanonico`. Aun así una razón por debajo de ~3 % es ruido: para
atribuir mejoras pequeñas, perfil V8 (`cpuprof.ts`) y la fracción del paso de cada función.
`tests/rendimiento-identidad.test.ts` fija además el digesto del mundo de 230 habitantes (semilla 3, día 12,25)
tras 600 pasos; se omite si falta la instantánea (`ATLAS_MUNDO_ALTO`).

**Reserva del paso del servidor** (`motor.clonPorPaso`: clon frente a punto de restauración):

```bash
NODE_OPTIONS=--expose-gc npx tsx scripts/perf/reserva-paso.ts --db alto.sqlite --pasos 200 --salida r.json
npx tsx scripts/perf/trayectoria-punto.ts --seed 7 --cortes 2400,4800 --salida t.json
```

`reserva-paso.ts` avanza dos copias de la base a la par (una con `cloneWorld`, otra con `puntoDeRestauracion`) y
luego desglosa la reserva (clon, punto, restaurar y sólo la copia de teselas); `trayectoria-punto.ts` corre dos
servidores reales con la receta de producción y exige el mismo mundo, en memoria y en disco. Cifras y decisión:
`docs/REGLAS.md`, «Motor: reserva del paso».

**El paso del servidor con reloj real** (PERF3, 2026-09-23): `stepMs`, `cloneMs`, `simulationMs`, `saveMs` y
pasos por segundo de `createApp`, con gestos reales opcionales y digestos cada `--cada` pasos. Se corre igual en
este árbol y en un `git archive` del commit base (se copia el script allí); los digestos deben coincidir:

```bash
TMPDIR=/datos/tmp-atlas-lab npx tsx scripts/perf/paso-servidor.ts --db publico.sqlite --pasos 600 --salida m.json
TMPDIR=/datos/tmp-atlas-lab npx tsx scripts/perf/paso-servidor.ts --db publico.sqlite --pasos 600 --planificado
TMPDIR=/datos/tmp-atlas-lab npx tsx scripts/perf/paso-servidor.ts --seed 7 --pasos 1200 --gestos 50 --salida s.json
```

Cifras: `docs/REGLAS.md`, «Motor: reserva del paso», apartado PERF3.

**La E/S entre pasos largos** (verificación del planificador de PERF3, 2026-09-23): `es-servidor.ts` levanta el
servidor real con el planificador y alarga cada paso `--lento` ms de CPU; `es-sonda.ts` (cadena HTTP, pong y
`state` por WS) y `es-cliente.ts` (como `src/client/connection.ts`, con el aborto de 10 s) lo miden desde otro
proceso. Para comparar dos árboles se corren a la vez, cada uno con su servidor:

```bash
TMPDIR=/datos/tmp-atlas-lab npx tsx scripts/perf/es-servidor.ts --lento 250 --info i.json &
TMPDIR=/datos/tmp-atlas-lab npx tsx scripts/perf/es-sonda.ts --info i.json --segundos 30 [--rtt 90] --salida s.json
TMPDIR=/datos/tmp-atlas-lab npx tsx scripts/perf/es-cliente.ts --info i.json --segundos 90 --salida c.json
pkill -TERM -f '^/usr/bin/node.*es-servidor.ts'   # deja pasos/s en i.json.srv
```

## El techo del hardware — `../curva-techo.mts` (T109)

`replica.ts` mide **leyes** (población, tecnología, cooperación…) a una escala fija; hermana con
`../curva-techo.mts` (`npm run techo -- --seed S --escala habitantes|teselas --hasta N --salida
<dir>`), que en cambio hace **crecer la escala** (habitantes o teselas activas, clonando
estructuralmente fundadores reales — no una fábrica de personas paralela) hasta que el p95 del
paso, medido con la MISMA ventana de 120 pasos y el MISMO percentil que usa el gobernador de
producción (`RollingStepPerformance`, `src/server/governor.ts`), toca `gobernador.presupuestoMs`.
Igual que aquí, SIEMPRE adjunta un `Store` temporal (P3): sin él se mediría una física de
tecnología distinta, y `persistencia.cadaTicks=1` (el guardado en cada paso) es justo lo que hace
caro «el paso» que el gobernador vigila. Escribe un `punto-NNN.json` por escalón y un `curva.json`
resumen; ver la cabecera del propio fichero para el detalle de cómo se coloca cada sintético sin
violar `assertWorld` (siempre sobre tesela transitable, nunca duplicando los roles únicos S/I).
