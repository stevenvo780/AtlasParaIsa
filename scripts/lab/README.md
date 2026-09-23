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
  Sin `--params`, corre con `DEFAULT_PARAMS` (el comportamiento actual).
- `--salida <dir>` (obligatorio): directorio donde se escriben `dia-NNN.json` (uno por día) y, al
  terminar, `replica.json`. Se crea si no existe.
- `--gobernador no|servidor` (opcional, por defecto `no`): ver «Gobernador consciente del servidor»
  más abajo. `no` es EXACTAMENTE el comportamiento de siempre (salida bit a bit idéntica); pasar
  explícitamente `no` es equivalente a omitir la bandera.

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
   consume todavía; esta réplica es el primer consumidor.
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

`identidad.ts` da los digestos de control (51926 por defecto a 2400 pasos; 7 y 42 con las leyes de la etapa 1
a 4800). `alterna.ts` importa los DOS árboles en el mismo proceso, carga cada uno su copia de la base y los
avanza por bloques alternados de 10 pasos: la CPU propia de cada bloque ve la misma carga de la torre (con carga
60–100 los mismos pasos cuestan 2–3 veces más CPU que a carga 20, así que dos corridas separadas no se pueden
comparar), y al final exige el mismo `digestoCanonico`. Aun así una razón por debajo de ~3 % es ruido: para
atribuir mejoras pequeñas, perfil V8 (`cpuprof.ts`) y la fracción del paso de cada función.
`tests/rendimiento-identidad.test.ts` fija además el digesto del mundo de 230 habitantes (semilla 3, día 12,25)
tras 600 pasos; se omite si falta la instantánea (`ATLAS_MUNDO_ALTO`).

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
