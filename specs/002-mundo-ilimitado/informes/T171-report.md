# T171 — Revisión adversarial del diff completo en tres lentes

**Rama auditada**: `sprint/t171-auditoria-adversarial-20261119` sobre `main` (`fc5b154`).
**HEAD auditado**: `5935aea` («fix(integracion): invalida LRU en activación/retiro, fallback GPU sin NVRTC, cadencia viva y evidencia 2026-11-19»).
**Alcance del diff**: 107 ficheros, +15 258/−248: Etapas A, B, C+GPU, D, E.0, T148, F y Fase A/B integradas.
**Ficheros tocados por esta tarea** (aislamiento estricto, sin tocar `src/`):

- [tests/auditoria-reglas-motor.test.ts](../../../tests/auditoria-reglas-motor.test.ts) (nuevo): guardas permanentes de los tres lentes.
- Este informe.

**Frase sobre hardware y resultado** (regla 10 de `tasks.md`): con los defaults, el hardware
(hilos, geometría de región, SoA o GPU) **no puede cambiar el resultado del mundo**; la única
excepción deliberada y preexistente es el gobernador del anfitrión (p95 medido → `reproductionEnabled`,
ruling R17), que no es una ley de `src/world` y cuya configuración viaja en los params. Dentro del
diff se confirma **un** defecto en `src/` (F-1, severidad media, latente) y se proponen dos parches
exactos para que el coordinador los aplique en la rama principal.

## Método

1. Lectura de `AGENTS.md`, `.specify/memory/constitution.md`, las reglas 1–13 y la sección T171 de
   `tasks.md`, y del diff completo `git diff main..HEAD`.
2. Barrido estático de todo `src/world/`, `src/server/` y `scripts/compute-ecology*` por lente
   (tokens, `Atomics`, reducciones, iteración de `Set`/`Map`, banderas NVRTC), con lectura íntegra
   de los ficheros de despacho: `paralelo/{particion,barrera,piscina,guardia}.ts`,
   `ecosystem-kernel.ts`, `ecology-kernel.ts`, `soa/terreno.ts`, `gpu/{puente,reparto,autoprueba}.ts`,
   `lru.ts`, `digesto.ts`, `spatial.ts`, `technology.ts`, `governor.ts` y los dos kernels CUDA.
3. Comprobación empírica: digestos de 300 pasos en las semillas 7, 42 y 51926 ejecutados contra
   HEAD y contra un worktree separado en `main` (sondas en `/tmp`, fuera del entregable), y
   ejecución de las suites focales ya existentes (GPU real, paralelo adversarial, gobernador,
   desalojo, tuplas) más la guarda nueva.

**Nota de nomenclatura (desviación respecto al texto de la tarea)**: la tarea nombra los
interruptores de la Fase B como `cuantizarMasas`/`puertaNovedad`/`topeEspeculacion`. Esas claves
**no existen** en el código. Las claves reales en [src/world/params.ts:147](../../../src/world/params.ts#L147)
son `tecnologia.dosisCuanto` (cuantización), `tecnologia.mejoraLocal` (puerta de novedad),
`tecnologia.enfriamiento` y `tecnologia.evitarNoOp`; no hay un parámetro separado de especulación
(la especulación se atenúa vía `mejoraLocal > 0 || enfriamiento > 45` en
[src/world/technology.ts:484](../../../src/world/technology.ts#L484)). Las guardas codifican las claves reales.

---

## Lente 1 — Hardware en la regla

Pregunta: ¿puede `availableParallelism`, `os.cpus()`, `n`/hilos, un tamaño de partición
(`regionSide`, 256, 512), una capacidad medida de GPU (79/21), `Date.now`, `performance.now` o
`Math.random` entrar en una fórmula o decisión del mundo? En las leyes, no. Todo lo encontrado
vive en despacho, observabilidad o laboratorio, con dos fronteras que hay que conocer (1.5 y 1.6).

### 1.1 Sin APIs de hardware en las leyes — limpio

- No hay **ningún** uso de `availableParallelism`, `os.cpus()` ni import de `node:os` en todo
  `src/world/` (leyes, SoA, paralelo y GPU incluidos). Los únicos usos del repo están en
  laboratorio/benchmark, fuera del motor: `scripts/lab/barrido.ts:179` (concurrencia de procesos
  réplica, cada una con su mundo independiente) y `scripts/benchmark-simulation.ts:91`
  (metadatos del informe). Ninguno alimenta una ley.
- El número de hilos y los dispositivos llegan **solo** por parámetros declarados
  (`motor.hilos`, `motor.gpu` en [src/world/params.ts](../../../src/world/params.ts)), cuyo default es
  el camino de siempre (`hilos: 1`, `gpu: []`). `src/world/index.ts:275` despacha a
  `stepLocalEcology` solo si `motor.hilos > 1` o hay GPU con NVRTC disponible; si no, ejecuta el
  bucle serie histórico. La disponibilidad de NVRTC decide **qué backend corre**, nunca qué sale:
  sin NVRTC el mismo paso cae a CPU (verificado por la matriz de paridad existente).
- La única división por `workers` del árbol está en
  [src/world/paralelo/particion.ts:49](../../../src/world/paralelo/particion.ts#L49)
  (`Math.floor(ordered.length * workerIndex / workers)`): reparte la cola estática de regiones,
  no una magnitud del mundo. No existe ninguna fórmula de ley con `hilos`, `workers` o el conteo
  de dispositivos como operando.

### 1.2 Relojes y azar en las leyes — limpio

- `Math.random` no aparece en ningún fichero de `src/world/` (solo en comentarios que declaran
  su ausencia). El azar del mundo es `localRandom(seed, sal)`/`world.rng` (clima, fase serie),
  como manda la regla 3.
- `Date.now`/`performance.now` no aparecen en las leyes (`src/world/*.ts` + `src/world/soa/`).
  Los tres únicos relojes del despacho quedan en lista blanca en la guarda nueva, con su uso:
  - [src/world/paralelo/piscina.ts:142](../../../src/world/paralelo/piscina.ts#L142): `performance.now`
    mide la espera física del modo `adversarial` y alimenta `adversarialDelaysMs` del diagnóstico.
    La espera se hace con `Atomics.wait` sobre un reloj privado; no escribe valores del mundo.
  - [src/world/gpu/puente.ts:394](../../../src/world/gpu/puente.ts#L394), `:468`, `:500`:
    `Date.now` acota a 60 s la espera síncrona al subproceso GPU (y a 2 s el hook de aborto).
    Si vence, `run`/`runTick`/`flushToHost` lanzan, `EcosystemKernel` hace `abortParallel()` y
    descarta el puente: el paso **no se confirma a medias**. Un hardware lento puede hacer
    fallar un paso, nunca producir un mundo distinto en silencio.
  - [src/world/gpu/autoprueba.ts](../../../src/world/gpu/autoprueba.ts): `process.hrtime` mide el
    presupuesto de 200 ms de la autoprueba de paridad FP64. Su veredicto habilita o no un
    dispositivo; con el dispositivo deshabilitado corre la CPU y el mundo es el mismo.
- En `src/server/`, `Date.now`/`performance.now` alimentan sesiones, cadencia de emisión,
  medición de fases y el gobernador (ver 1.5). Ninguno entra en `stepWorld` ni en una ley:
  `src/server/app.ts` mide el paso ya ejecutado y decide para el paso siguiente vía gobernador.

### 1.3 Tamaños de partición (256/512) — geometría de despacho, no ley

- `regionSide: 256 | 512` ([src/world/ecosystem-kernel.ts:19](../../../src/world/ecosystem-kernel.ts#L19))
  solo agrupa páginas en regiones de trabajo. `TileStore.prepareParallel`
  ([src/world/soa/terreno.ts:253](../../../src/world/soa/terreno.ts#L253)) ordena las celdas por
  `(región, página, offset)`; cada celda se calcula exactamente una vez, lee a sus vecinas del
  frente compartido y escribe solo su ranura del fondo. Cambiar la geometría cambia el orden
  físico de escritura sobre ranuras disjuntas, no ningún operando. La suite existente
  `tests/determinismo-hardware.test.ts` compara ambas geometrías contra la referencia serie en
  cada barrera, y la guarda nueva fija la paridad serie/SoA en dos semillas.
- El `256` de `puente.ts` (celdas por página, `startSlot * 256 * f.bytes`) es el tamaño de página
  del SoA (`PAGE_CELLS`), una constante estructural del formato compartido JS/Python/CUDA, no
  una magnitud medida ni una ley.

### 1.4 Capacidad medida de GPU (79/21) — reparto confirmado como inocuo

Hay tres sitios con la capacidad medida de la torre, todos de despacho:

- [src/world/gpu/puente.ts:316](../../../src/world/gpu/puente.ts#L316): pesos `0.79 / 0.21`
  (RTX 5070 Ti / RTX 2060) para cortar los rangos de celdas por dispositivo, con redondeo a
  páginas completas para no partir ninguna página. Con cualquier otro par de dispositivos, a
  partes iguales.
- [src/world/gpu/reparto.ts:7](../../../src/world/gpu/reparto.ts#L7): `DEFAULT_GPU_THROUGHPUT`
  (2 500 000 / 680 000 celdas·ms⁻¹, el mismo ≈79/21) para `repartirPaginas` (orden Morton +
  cuotas por restos mayores, desempate por orden de dispositivo). Hoy solo lo ejercitan
  `tests/gpu-reparto.test.ts`; ningún camino de producción lo consume.
- [scripts/compute-ecology-gpu.py:182](../../../scripts/compute-ecology-gpu.py#L182): tasas
  `2_500_000 / 680_000` como partición por defecto del backend no residente cuando el cliente
  no pasa `ranges`. El cliente de autoprueba trabaja con un solo dispositivo, donde la tasa
  es irrelevante (todo el rango es suyo).

**Por qué no entra en la regla**: los kernels son por celda e independientes (ver Lente 2);
el rango solo decide qué dispositivo ejecuta cada celda sobre una VRAM replicada con halo
explícito. Evidencia ejecutada en esta revisión: `tests/gpu-puente.test.ts` incluye
«real multi-GPU page schedules 79:21, 50:50 and 100:0 are byte identical» y pasó con las dos
GPU reales de la torre (18/18 junto a reparto y autoprueba, con
`COMPUTE_NVRTC=/opt/cuda/lib64/libnvrtc.so`).

**Riesgo residual (bajo)**: los literales 0.79/0.21 y 2 500 000/680 000 describen esta torre.
En otro hardware seguirían siendo correctos (solo empeora el equilibrio de carga), pero un
lector futuro podría tomarlos por ley. Propuesta P-3 (documentación, no código de ley) al final.

### 1.5 Frontera declarada: el gobernador sí deja que el hardware limite la población

`src/server/governor.ts` decide `reproductionEnabled` desde el p95 medido del paso
(`performance.now` en el servidor). Dos mundos idénticos en máquinas con distinta velocidad
**pueden** divergir en nacimientos. No es un hallazgo del diff ni un defecto:

- Es el diseño vigente desde `main` (ruling R17 / FR-013: «el techo lo pone el hardware») y la
  constitución lo asume: el gobernador es política del anfitrión, no una ley de `src/world`.
- Su configuración viaja en params (`gobernador.presupuestoMs/senales/politica`, dentro del
  digesto), y con el default `senales: ['p95']` el diff conserva exactamente la decisión
  histórica (`decideReproduction`/`decidirConTecho`); las señales nuevas (`max`, `rss`,
  `colaRed`, `saveMs`) solo actúan si el operador las declara en `gobernador.senales`.
- La garantía bit a bit de la feature 002 cubre el motor dado el mismo
  `reproductionEnabled` paso a paso, que es lo que ejercitan las matrices de hardware
  llamando a `stepWorld` directamente.

En el servidor, además, la palanca de área está deliberadamente inhabilitada
([src/server/app.ts:327](../../../src/server/app.ts#L327): `areaHabilitada: false`), así que el
gobernador nunca solicita retirar páginas en producción: T163 no se activa solo.

### 1.6 `hardware-limits.ts`: el host resuelve límites una vez y los persiste

`src/server/hardware-limits.ts` (sin cambios en este diff) deriva los topes de admisión de un
mundo **nuevo** desde la RAM/heap del host y los persiste en sus params antes de la carga.
Una vez escritos, la ejecución no vuelve a preguntar por la máquina. Es admisión
(anticorrupción), no fórmula del mundo: conforme a T100 y a su interpretación autorizada.

---

## Lente 2 — Orden de llegada y no-asociatividad FP64

Pregunta: ¿hay reducciones, sumas FP64, desempates o asignaciones de ids que dependan de quién
termina antes? La respuesta general es no: el diseño separa «quién calcula» (paralelo) de «qué
se suma y en qué orden» (siempre serie y por contenido). El detalle, mecanismo a mecanismo:

### 2.1 Partición estática sin robo (`paralelo/particion.ts`, `paralelo/piscina.ts`)

- `partitionRegions` ordena las regiones por id con orden total
  (`compareRegionIds`: numérico, o numérico antes que texto, o lexicográfico), rechaza ids
  repetidos y rangos solapados, y corta colas contiguas por índice de worker. No hay
  *work-stealing*: cada worker recibe su cola y la agota. `inverso`/`adversarial` solo
  invierten el recorrido de la misma cola (la guarda nueva lo comprueba funcionalmente).
- En modo no natural, `piscina.ts` invoca el handler región a región en el orden de la cola
  (con esperas físicas reales en `adversarial` para forzar llegadas hostiles) y la barrera
  (`paralelo/barrera.ts`) espera a que **todos** los workers publiquen `done`/`jobError`
  antes de que el coordinador confirme. Ninguna escritura tardía puede colarse tras la
  confirmación: un `jobError` en cualquier worker aborta el paso entero.
- Los `Atomics` de la barrera y la piscina son exclusivamente enteros de control (época,
  estados, conteos de trabajos, longitudes de error). El propio
  [src/world/paralelo/barrera.ts:1](../../../src/world/paralelo/barrera.ts#L1) lo declara: «Los
  valores del mundo nunca se reducen mediante Atomics». No hay ni un `Atomics.add` sobre
  `Float64Array` en todo el árbol.

### 2.2 Los kernels escriben por celda; no hay reducciones entre celdas

- `runParallelEcology` ([src/world/ecology-kernel.ts](../../../src/world/ecology-kernel.ts)) y
  `runParallelEcosystem` ([src/world/ecosystem-kernel.ts:340](../../../src/world/ecosystem-kernel.ts#L340))
  copian frente→fondo y aplican la misma aritmética FP64 por celda que el camino serie, en el
  mismo orden de operaciones, leyendo vecinas solo del frente. La suma de «vecinas vivas» es un
  conteo entero (0–8), asociativo y exacto. Ningún worker suma magnitudes de otra celda.
- Los contadores protegidos por la regla 13 (`world.totals`, `demographyDynamics`,
  `inventionDynamics`, `animalDynamics`, `technology.ledger` y los nueve contadores de
  identidad) **no se tocan** desde workers, GPU ni kernels: el barrido por esos símbolos en
  `paralelo/`, `gpu/`, `ecology-kernel.ts`, `ecosystem-kernel.ts` y `soa/` devuelve cero
  resultados. `count()` ([src/world/statistics.ts](../../../src/world/statistics.ts)) y las
  reducciones FP64 de estadísticas/diversidad/sociedad recorren `world.people`/`world.tiles`
  en su orden del mundo, en la fase serie, con el mismo orden antes y después del diff.
- Las sumas que sí existen en el despacho son de enteros exactos (bytes subidos/descargados,
  `kernelMs` máximo con `Math.max`): conmutativas y sin error FP64.

### 2.3 La cola `woodAddedQueue`: orden de llegada contenido, sin efecto en el mundo

El único punto donde el orden de llegada existe físicamente:

- En CPU, `runParallelEcosystem` reserva posiciones con
  `woodAddedQueue[2 + Atomics.add(woodAddedQueue, 1, 1)] = slot`
  ([src/world/ecosystem-kernel.ts:414](../../../src/world/ecosystem-kernel.ts#L414)). Dos workers
  pueden encolar sus páginas en cualquier orden relativo. Cada página pertenece a una sola
  región/worker (rangos disjuntos) y el flag `woodAdded[slot]` evita duplicados dentro de la
  página, así que el **conjunto** encolado es determinista aunque la secuencia no lo sea.
- El consumidor, `TileStore.commitParallel`
  ([ src/world/soa/terreno.ts](../../../src/world/soa/terreno.ts)), valida cada página encolada
  (rango, presencia, flag, sin duplicados vía `Set`) y después procesa cada página de forma
  independiente (adjuntar el accesor `wood` a sus teselas con hueco). Adjuntar la página A
  antes que la B no cambia el estado final: ni valores FP64, ni orden de `world.tiles`, ni
  el digesto dependen de ello.
- En GPU no hay ni esa ventana: el worker JS ordena los slots ascendentes antes de escribir
  la cola ([src/world/gpu/puente.ts:242](../../../src/world/gpu/puente.ts#L242), «CPU-side
  deterministic queue, slots ascending»), y el residente Python devuelve
  `wood_slots = sorted(set(...))` por unión de dispositivos.
- El protocolo vale 1 solo si algún worker lo anuncia; `prepareParallel` reinicia
  contador y protocolo antes de cada despacho. Conclusión: orden de llegada **observado y
  neutralizado**, no un defecto.

### 2.4 Halo multi-GPU y ensamblado por dispositivos

- Residente (`scripts/compute-ecology-gpu-resident.py`): cada dispositivo corre en un hilo
  con su contexto CUDA; el hilo principal recoge los futuros **en orden de dispositivo**
  (`[f.result() for f in futs]`), nunca en orden de terminación. `woodAddedSlots` se une con
  `sorted(set(...))` y `downloadSlotsPerDevice` conserva el orden de dispositivo, que es el
  mismo orden con el que el worker JS lee el payload (por dispositivo, por campo, por tramo
  contiguo). Las sumas de bytes son enteras.
- Intercambio de halo en `tick`: antes de lanzar los kernels se copia el campo `life` del
  frente de cada dispositivo origen al **fondo** de los dispositivos que lo tienen como halo.
  Es correcto porque la pasada 1 no modifica `life` (lo copia frente→fondo), así que el halo
  que la pasada 2 lee es exactamente el `life` previo; y ambas pasadas se lanzan en la misma
  cola CUDA por dispositivo, en orden. Nota de alcance: `runTick`/`flushToHost` no tienen
  consumidor en `EcosystemKernel` hoy (el camino integrado usa `bridge.run` por pasada, con
  descarga completa); el halo por tick es API ejercitada solo por pruebas del puente.
- No residente (`scripts/compute-ecology-gpu.py`): el ensamblado escribe
  `output[:, d.begin:d.end]` iterando `devices` en orden, no al completar cada futuro.
- Los `Set`/`Map` del puente (halos, `touched`, descargas) se materializan siempre con
  `.sort((a, b) => a - b)` antes de usarse como orden de escritura o de DMA. En
  `soa/terreno.ts`, `residentModified: Set` se drena por binding y cada binding escribe solo
  su celda: el orden de drenaje no comparte estado entre bindings.

### 2.5 CUDA: FP64 con `--fmad=false`, sin fast-math, sin reducciones

- Residente: opciones NVRTC únicas y literales
  ([scripts/compute-ecology-gpu-resident.py:103](../../../scripts/compute-ecology-gpu-resident.py#L103):
  `--gpu-architecture=…`, `--fmad=false`, `--std=c++11`). Los kernels
  (`scripts/compute-ecology-resident.cu`) son por celda, sin `atomicAdd`, sin reducciones en
  árbol y sin `__syncthreads` con acumulación: cada hilo escribe solo `cell = cells[i]`.
- No residente: [scripts/compute-ecology-gpu.py:41](../../../scripts/compute-ecology-gpu.py#L41)
  compila con `--fmad=false` por defecto. Existe una rama `--test-fmad=true`
  (`GPUWorker.create(..., { testFmad })`) como **control negativo deliberado**: la autoprueba
  la rechaza («Opciones NVRTC incompatibles con paridad FP64») en
  [src/world/gpu/autoprueba.ts:107](../../../src/world/gpu/autoprueba.ts#L107). No es un camino de
  producción; la guarda nueva prohíbe que esa rama aparezca en el residente y que exista
  `fast_math` en ambos backends.
- La autoprueba compara el backend GPU contra el oráculo CPU con `Object.is` por celda
  (4096 celdas × 4 cuadrantes cuencas×decaimiento) y deshabilita el dispositivo ante la
  primera divergencia: un kernel que no reproduzca FP64 bit a bit no llega a un mundo.
- Único `sort` sensible en leyes tocado por el desalojo T163: los candidatos a retirar se
  ordenan por `(distancia Chebyshev DESC, lastTick ASC, chunkKey ASC)` en
  [src/world/spatial.ts:251](../../../src/world/spatial.ts#L251): orden total por contenido,
  independiente de la llegada y del número de personas iteradas para la distancia
  (mínimo entero, asociativo).

### 2.6 Desempates e ids

Los desempates de leyes siguen siendo los de `main` (`id.localeCompare` como último criterio,
`primero`/`primerosDos` de `orden.ts` con mejora estricta sobre el orden del mundo). El diff
no introduce asignación de ids en workers: `recipeCounter`, `animalCounter`, `birthCounter`
y demás contadores se incrementan solo en la fase serie. `repartirPaginas` desempata restos
mayores por índice de dispositivo declarado, no por terminación.

---

## Lente 3 — Cambio de mundo no declarado

Pregunta: ¿alteran el mundo por defecto, respecto a `main`, los defaults
(`DEFAULT_PARAMS`/`HISTORICAL_PARAMS`/`RULES_VERSION = 11`), la Fase B, la GPU o los workers,
la caché LRU de T163, el gobernador T162 o el formato de tuplas T133? No. Vector a vector:

### 3.1 Defaults y versión de reglas

- `RULES_VERSION` sigue siendo 11 ([src/world/index.ts:43](../../../src/world/index.ts#L43)), igual
  que en `main`: correcto, porque con los defaults ninguna ley cambia de conducta y no hay
  migración que versionar.
- El diff de `params.ts` contra `main` añade exactamente dos cosas: el bloque `tecnologia.*`
  (Fase B) y `motor.depuracion: false` (T148). `RAW_HISTORICAL` conserva todos los valores
  previos; `RAW_DEFAULTS` sigue derivándose con `RULES_10_ADOPTED` + `RULES_11_ADOPTED`, sin
  tocar ninguna de sus claves.
- Fase B en histórico: `tecnologia: { dosisCuanto: 0, mejoraLocal: 0, enfriamiento: 45, evitarNoOp: false }`
  ([src/world/params.ts:191](../../../src/world/params.ts#L191)), idéntico en `DEFAULT_PARAMS` y en
  `HISTORICAL_PARAMS`. Revisadas las cuatro ramas en `technology.ts`: con 0 la cuantización es
  identidad (`Math.min(1000, available)` como antes), con 0 la puerta acepta todo, con 45 el
  enfriamiento es el literal histórico y con `false` `nextInstruction` devuelve la primera
  instrucción sin consumir azar extra (el orden de consumo de `localRandom` es el mismo que el
  código de `main`, incluida la rama de mutación). Los hosts sintéticos sin params caen a
  `HISTORICAL_PARAMS.tecnologia` ([src/world/technology.ts:46](../../../src/world/technology.ts#L46)).
- `motor.depuracion` queda fuera del digesto a propósito
  ([src/world/digesto.ts:36](../../../src/world/digesto.ts#L36) `paramsParaDigesto`): es un
  diagnóstico (la guardia lanza si la fase de decisión escribe), con default `false` devuelve
  el mundo sin proxies y a coste cero ([src/world/paralelo/guardia.ts](../../../src/world/paralelo/guardia.ts)).

### 3.2 GPU y workers con los defaults: el camino serie de siempre

Con `motor.hilos=1`, `motor.gpu=[]` y `motor.soaTerreno=false`, `stepWorld` ejecuta la ecología
serie de `index.ts` y el kernel de objetos/SoA-opcional de siempre; ni `StaticWorkerPool` ni
`ResidentGpuBridge` se construyen. Activar hilos/GPU/SoA cambia el ejecutor, no el resultado
(Lentes 1 y 2; paridad fijada por la guarda nueva y por la matriz existente).

### 3.3 Caché LRU de T163 (`src/world/lru.ts`, `spatial.ts`)

- La LRU (capacidad 32 por mundo) **nunca es la única copia** de un chunk. `activateChunk`
  ([src/world/spatial.ts:136](../../../src/world/spatial.ts#L136)) busca primero en
  `world.retiredChunks` (pendiente en memoria), después en la LRU y por último en
  `context.loadChunk` (SQLite). Todo lo que entra en la LRU entró también en `retiredChunks`
  al retirarse, y al guardar, `Store.save` archiva esos chunks en la tabla `chunks` antes de
  vaciar `retiredChunks`. Si la LRU desaloja una entrada (la 33ª), la reanimación cae a la
  base de datos con el mismo contenido; si acierta, el contenido es la copia del retiro,
  dormida e inmutable mientras tanto. En ambos caminos se hace `structuredClone` antes de
  exponer el chunk a las leyes, y la entrada se borra al reanimar (`lru.delete(key)`).
- El orden de recencia de la LRU depende del historial de accesos, pero solo decide **qué
  copia en memoria se conserva**, nunca qué datos se reaniman: por eso un desalojo distinto
  en otra máquina no puede cambiar el mundo.
- El desalojo de páginas frías (`evictColdChunks`, [src/world/spatial.ts:271](../../../src/world/spatial.ts#L271))
  es un no-op sin presupuesto explícito, y ningún llamador de producción lo fija (solo las
  pruebas). `maintainRegions` solo lo invoca si un presupuesto quedó registrado antes.
  La restauración (`puntoDeRestauracion`) limpia la LRU para no reanimar copias anteriores
  al punto restaurado.

### 3.4 Gobernador T162 con los defaults: la decisión histórica

Con `gobernador.senales = ['p95']` (default), `gobernar` toma la vía compatible y delega en
`decidirConTecho`/`decideReproduction`, las mismas funciones puras de `main`, con histéresis
incluida. Las palancas nuevas quedan inertes: `red`/`guardado` solo espacian emisión y
guardado si su señal está declarada (y en `app.ts` la de área está inhabilitada, §1.5), y
`cadaTicksEfectivo`/`subscribeMsEfectivo` vuelven a los valores declarados fuera de rojo.
El defecto F-1 vive en el envoltorio de clase, no en esta vía por defecto; ver Hallazgos.

### 3.5 Formato de tuplas T133 (`chunk-tiles-tuple-v1`)

- `encodeArchivedChunk` ([src/server/snapshot.ts:233](../../../src/server/snapshot.ts#L233))
  escribe las teselas del chunk retirado con las mismas filas de 20 campos de
  `tiles-tuple-v1` (sin cuantizar FP64, con `-0` preservado vía `exactJsonNumber`) y el resto
  de campos con `stringifyExact`, como el cuerpo histórico. Cuando cada tesela está en su
  posición de rejilla (`cx*16 + i%16`, `cy*16 + i/16`), omite `x,y` de la fila;
  `decodeArchivedChunk` los reconstruye desde la rejilla antes de expandir la tupla. Un chunk
  fuera de rejilla conserva la fila completa de 20.
- `Store.loadChunk` acepta ambos cuerpos (histórico y tupla) y valida con `assertChunk` tras
  decodificar; el digest almacenado sigue siendo el sha256 de los bytes guardados. Es un
  cambio de **transporte**, no de mundo: la suite existente `tests/store-chunks-tupla.test.ts`
  comprueba ida y vuelta idéntica (en esta revisión: 40/40 junto a gobernador, desalojo y
  paralelo adversarial; compresión medida del cuerpo: −62,1 %).
- Los deltas de red de T135 (`src/shared/deltas.ts`, `red.deltas=false` por defecto) operan
  solo sobre vistas proyectadas para el cliente; nunca escriben el mundo.

### 3.6 Comprobación empírica contra `main` (semillas 7, 42 y 51926)

Sondas ejecutadas fuera del entregable (`/tmp/t171-digesto*.mts`): `createWorld(seed)` con
defaults y 300 `stepWorld` en HEAD (`5935aea`) y en un worktree independiente en `main`
(`fc5b154`). El mundo coincide en población y teselas en las tres semillas. El digesto crudo
difiere, y la diferencia es **solo el metadato de params**: al excluir el bloque `tecnologia`
recién declarado (y `motor.depuracion`, que el propio digesto ya excluye), los digestos de
HEAD son **byte a byte los de `main`**:

| Semilla | `main` (crudo) = HEAD (sin bloque `tecnologia`) | HEAD (crudo, con defaults) |
|---|---|---|
| 7 | `22d31d1e9dab4025498c4dc1d103265d6453fd30b34ebb18f9783c8e356242f0` | `0bee12604445d98f5e5d3a3d474da0f4b0737e84dd69130e2452a8f4ff5a3995` |
| 42 | `02253107651acac276f5d7adc339b2d185e3294152a2ec04a6e74914e8611499` | `f479cf397239eb3e80dba764c843785ee8e0b88818dd16d41b9d8bcb98a03952` |
| 51926 | `671bad62d9af6a281351575ac2bfd3d74219d3c36c0d33e4cbac8826d2b1b6af` | `89f44b2db066f5d284c229ba0ff6d7274f4aa82616db22c234f5bd8e95c8c045` |

Lectura correcta de la puerta de calidad (regla 5): la Fase B **declara** sus params, así que
el digesto completo cambia por declarar configuración —igual que ya asumía
`tests/leyes-candidatas.test.ts` con su digesto con params de `main`—, pero la trayectoria del
mundo (población, teselas y estado canónico) es idéntica a `main`. Quien compare mundos entre
versiones debe excluir el bloque declarado, no concluir que el mundo cambió.

### 3.7 Otros cambios del diff revisados sin efecto por defecto

- `digesto.ts` añade `IncrementalRegionHasher` (T117): herramienta de comparación entre
  barreras; no participa en el paso ni ordena el mundo (hash por página con ranuras en su
  orden original, claves ordenadas; FP64 exacto, sin sumas).
- `index.ts`: `cloneWorld`/`puntoDeRestauracion` pueden envolver teselas en el propietario de
  topología residente (proxies que materializan los mismos valores, claves, `undefined` y
  `-0`); sin despacho paralelo el mundo clonado es el mismo objeto lógico.
- `halo.ts` solo actualiza el inventario de alcances (declarativo); `app.ts` publica señales
  del gobernador de solo lectura y aplica deltas/palancas solo con su configuración declarada.

---

## Hallazgos

### F-1 — CONFIRMADO · severidad media (latente) · `src/server/governor.ts:356`

**Qué**: `Gobernador.gobernar()` contradice a `Gobernador.decidir()` cuando aún no hay
mediciones. `decidir` documenta y cumple «Sin mediciones todavía (primer paso) no se afirma
nada sobre el hardware y se devuelve `actual`»
([src/server/governor.ts:331](../../../src/server/governor.ts#L331)), pero `gobernar` hace:

```ts
gobernar(params, actual, poblacion, teselasActivas, tick): DecisionGobernar {
  this.decidir(params, actual, poblacion, teselasActivas, tick);
  return this.ultimaDecision ?? gobernar({ ...params, p95StepMs: this.p95StepMs, actual, poblacion }, this.gobernacion);
}
```

([src/server/governor.ts:356](../../../src/server/governor.ts#L356)). En el retorno temprano de
`decidir` (ventana vacía), `ultimaDecision` queda `null` y el envoltorio recomputa la función
pura con `p95StepMs = 0`: ventana «verde», y con política `techo` eso significa
`reproductionEnabled = true`, **aunque el mundo trajera la reproducción deshabilitada**.

**Evidencia reproducible** (sonda `/tmp/t171-gob.mts`, ejecutada en esta revisión):

```
decidir(count=0, actual=false)  = false
gobernar(count=0, actual=false) = {"reproduccion":true,"estado":"verde"}
gobernar(count=0, actual=true)  = {"reproduccion":true,"estado":"verde"}
```

**Alcance hoy**: el servidor no lo dispara, porque `app.ts` registra la medición del paso
antes de gobernar (la ventana nunca está vacía al llamar a `gobernar`), y el laboratorio usa
`decidir`. Es un defecto de contrato público: el primer llamador futuro que invoque
`gobernar` antes de registrar —o sobre un mundo cargado con `reproductionEnabled=false`—
encenderá los nacimientos en contra de lo decidido. Por eso media y no alta; por eso no
puede esperar a que alguien lo pise: la clase exporta ambos métodos como equivalentes.

**Parche exacto propuesto** (para el coordinador, en la rama principal; esta tarea no toca
`src/`). Hacer que `decidir` siempre deje una decisión coherente, o que `gobernar` sintetice
la decisión del retorno temprano en vez de recomputar con p95 = 0. Forma mínima, en
`Gobernador.gobernar` ([src/server/governor.ts:356](../../../src/server/governor.ts#L356)):

```ts
gobernar(params: ParamsDecisionGobernador, actual: boolean, poblacion: number, teselasActivas: number, tick: number): DecisionGobernar {
  const reproduccion = this.decidir(params, actual, poblacion, teselasActivas, tick);
  if (this.ultimaDecision) return this.ultimaDecision;
  // Ventana vacía o mandato manual sin decisión registrada: `decidir` ya resolvió el
  // booleano; no recomputar con p95=0, que lo invertiría en «verde».
  return {
    estado: this.estadoGobernador, palancaActiva: this.palancaActiva, senalDisparadora: this.senalDisparadora,
    senalesDisparadas: [], reproductionEnabled: reproduccion, techo: this.estado.techo, estadoTecho: this.estado,
    ventanasVerdesConsecutivas: this.ventanasVerdesConsecutivas, solicitarRetiroPaginasFrias: this.solicitarRetiroPaginasFrias,
    subscribeMsEfectivo: this.subscribeMsEfectivo, cadaTicksEfectivo: this.cadaTicksEfectivo, siguiente: this.gobernacion,
  };
}
```

Alternativa equivalente: fijar `this.ultimaDecision` en los dos retornos tempranos de
`decidir` (ventana vacía y `manualOverride`). Añadir a `tests/gobernador.test.ts` el caso
«`gobernar` sin mediciones conserva `actual=false`». La guarda T171 no lo cubre a propósito:
fijarlo en un test aquí obligaría a importar el defecto como comportamiento esperado.

### P-2 — Propuesta de endurecimiento · severidad baja · lista blanca de relojes

La guarda nueva convierte en fallo cualquier `Date.now`/`performance.now` nuevo fuera de
`paralelo/`, `gpu/` y la lista blanca nominal. Se propone al coordinador dejar el mismo
criterio escrito como comentario en `src/world/paralelo/barrera.ts` (que ya declara la regla
para `Atomics`), para que la lista blanca viva también junto al despacho y no solo en el test.

### P-3 — Propuesta de documentación · severidad baja · constantes 79/21

Anotar en [src/world/gpu/puente.ts:315](../../../src/world/gpu/puente.ts#L315) y en
[src/world/gpu/reparto.ts:7](../../../src/world/gpu/reparto.ts#L7) que los pesos son equilibrio de
carga medido en la torre y que cambiarlos no puede cambiar el mundo (la prueba multi-GPU con
repartos 79:21, 50:50 y 100:0 byte a byte idénticos es la evidencia). Sin cambio de código.

### Observaciones sin severidad (verificadas, no defectos)

- `--test-fmad=true` en `compute-ecology-gpu.py` es un control negativo con dueño
  (autoprueba); no proponer su retirada.
- `ResidentGpuBridge.runTick`/`flushToHost` y `repartirPaginas` no tienen consumidor de
  producción hoy: código de puente ejercitado por pruebas, sin efecto en el mundo servido.
- `localeCompare` como desempate final es preexistente en `main` y opera sobre ids ASCII
  (`recipe-N`, ids de persona/animal); no lo introduce este diff.

---

## Guardas permanentes añadidas

[tests/auditoria-reglas-motor.test.ts](../../../tests/auditoria-reglas-motor.test.ts) (7 pruebas):

1. **Lente 1 (leyes)**: escaneo estático de `src/world/*.ts` + `src/world/soa/` (comentarios
   excluidos) rechazando `availableParallelism`, `os.cpus`, `Math.random`, `Date.now`,
   `performance.now` e import de `node:os`.
2. **Lente 1 (despacho)**: `paralelo/` + `gpu/` sin CPU ni azar; relojes solo en la lista
   blanca justificada (`piscina.ts`, `gpu/puente.ts`, `gpu/autoprueba.ts`).
3. **Lentes 1/2 (GPU)**: ambos backends compilan con `--fmad=false`, sin `fast_math`; el
   residente sin rama `fmad=true`; las cabeceras `.cu` lo declaran.
4. **Lente 2 (partición)**: `partitionRegions` es completa, disjunta, independiente del
   orden de entrada y la inversión no mueve regiones entre workers.
5. **Lente 3 (defaults)**: `RULES_VERSION === 11`; `tecnologia` histórica en `DEFAULT_PARAMS`
   e `HISTORICAL_PARAMS`; motor, gobernador y red en su valor de siempre.
6. **Lente 3 (paridad)**: semilla 7, 120 pasos — declarar la Fase B en histórico no mueve ni
   el mundo ni su digesto; `motor.hilos=4` y `motor.soaTerreno=true` dan el mismo
   `digestoCanonico` normalizado (selectores de motor reiniciados en la copia, como en
   T117/T120) que la serie, con misma población y teselas.
7. **Lente 3 (paridad SoA)**: semilla 51926, serie frente a `motor.soaTerreno=true`.

La normalización del punto 6 es necesaria porque `digestoCanonico` incluye los params
efectivos por diseño (T101): comparar ejecuciones exige reiniciar solo los cuatro selectores
de despacho en la copia, sin tocar ninguna ley, igual que `normalizedCopy` de T117.

## Verificación ejecutada

- `npx tsx --test tests/auditoria-reglas-motor.test.ts` → **7/7 verdes** (1,6 s).
- `npm run typecheck` → **verde**.
- Focales existentes re-ejecutadas para corroborar los lentes (no forman parte del entregable):
  GPU real (`gpu-puente`, `gpu-reparto`, `gpu-autoprueba` con NVRTC) **18/18**;
  `paralelo-adversarial`, `gobernador`, `gobernador-senales`, `desalojo`,
  `store-chunks-tupla` **40/40**.
- Sondas de digesto HEAD/`main` en semillas 7, 42, 51926 (300 pasos): mundo idéntico;
  digesto igual al excluir el bloque de params declarado (tabla §3.6).
- No se ejecutó la suite completa `npm test` (regla 7 de `tasks.md`: la corre la integración)
  ni `npm run build` en este worktree de auditoría.

## Conclusión

El diff integrado respeta las reglas 2, 3, 4, 5, 6 y 13: el reparto decide quién calcula y
jamás qué sale; no hay hardware, relojes ni azar en las leyes; no hay reducciones FP64 ni
asignación de ids por orden de llegada; y el mundo por defecto tras 300 pasos es el de `main`
en las tres semillas auditadas. Queda **un** defecto confirmado por arreglar antes de publicar
(F-1, en el servidor, latente) y dos propuestas menores de documentación (P-2, P-3). El
hardware puede cambiar el resultado solo donde el proyecto ya lo declaraba: en el gobernador
del anfitrión, fuera de las leyes y con su configuración en los params.

