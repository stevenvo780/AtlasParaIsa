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

## Rendimiento

Con `persistencia.cadaTicks = 1` (el valor por defecto, igual que producción hoy), guardar en cada
tick cuesta caro: ~32 ms/tick medidos en esta torre (un día completo, ~78 s). Para barridos grandes
(T017/T018) conviene pasar `--params "persistencia.cadaTicks=200"` (o el valor que se calibre en
T031) para acelerar sin dejar de ejercitar el guardado periódico con `Store`; los tests de este
fichero usan `persistencia.cadaTicks=300` por la misma razón.

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
