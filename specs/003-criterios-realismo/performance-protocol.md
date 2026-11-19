# T023 — protocolo C22 de paridad y coste integral

Estado: **DISEÑO DOCUMENTAL, BENCHMARKS NO EJECUTADOS**. Autor rendimiento Sol high,
cuenta secundaria autorizada. Ownership exclusivo de este archivo y
[durability-protocol.md](durability-protocol.md). T023 permanece sin marcar para
revisión del integrador y root. No se implementan backends, observadores, evaluador,
perfiles, leyes o instrumentos; no se ejecutan mundos, suites ni builds.

## Autoridad y alcance después de G0

Fuentes: [GOAL](../../GOAL.md),
[constitución](../../.specify/memory/constitution.md),
[REGLAS](../../docs/REGLAS.md), [EVIDENCIA](../../docs/EVIDENCIA.md),
[canon C20–C22](../../docs/CRITERIOS-REALISMO.md#c20--b12--límites-demográficos-y-causas-del-freno),
[contratos v3](contracts/README.md), [plan](plan.md) y [tasks](tasks.md).
Se leyó el PLAN recuperado de main en
`/datos/workspaces/personal/AtlasParaIsa/PLAN.md`, R6/R7 y registro G0; no se lo
reescribe. Constitución worktree/main con SHA256 idéntico
`e9aeee368c44fb706b6bb55221a9568ba1dd031252993ca68c207bf6c3d3cda0`.

La fuente válida G0 es
`/datos/tmp-atlas-lab/orquestacion-20261003/revision-criterios/ROOT-G0-DECISION-v3.md`,
SHA256 `658605e0d5f52d626def8169cf0e39f3d6477dbbbcb7c0573e7f85a0137b410c`,
con peer `REVISION-R1-v3.md`,
SHA256 `d085aa80eb01573b4a2f913403f7b9191627433d99e70e5d5397b773a50815d2`,
y formal v3 sobre los mismos pins. R1-FROZEN-v3 preserva 87 inputs:
fingerprint `8cf50919f02508a4f8d834a153c3d125d319e9f61f98726d0683be6dda0431f0`,
agregado `3989c066ea4c850cb8e4222a58a709fe0bbb7eaf2a5da8eb070aebb3f3a98467`;
manifiesto de archivo `faaac25fb0ace210103eb5a19f12b4be8a0fac009b4635a6bb9a9a880714ef54`.
El GO es contractual y permite redactar T022/T023 con ownership disjunto. No
acepta C22, no sella números provisionales ni ejecuta los 48+8 diseños. Este
archivo queda fuera de los 87 pins originales; no recalcular su manifiesto.

La ejecución será posterior, coordinada por root tras preregistro revisado,
disponibilidad demostrada de workloads/backends/instrumentos y admisión fresca.
G1 del integrador y G2 de los observadores siguen sus gates propios; este texto
no los cierra ni autoriza arrancar autores reservados.

## Cuatro subgates que deben mantenerse separadas

| Subgate C22 | Comparación y oráculo | Qué puede concluir |
|---|---|---|
| `tick-parity` | Mismo tick, estado inicial, inputs físicos y entradas/decisiones del gobernador; digesto físico y archivo por tick | Igualdad bit a bit; primera diferencia material y su causa. 6 semillas ×1200 es sólo paridad instrumental G2 |
| `host-capacity` | Gobernador real con relojes de pared y carga medidos; traza de p95/política/decisión por host | Capacidad observada hasta freno hardware con población/teselas/tickHz; entradas diferentes pueden producir poblaciones distintas |
| `complete-cost` | Trayectorias/escenas equivalentes, misma fidelidad, coste completo servidor+Store+cliente+red | Costes/extremos/budgets por escenario y cuello de botella real |
| `backend-selection` | CPU de referencia, multinúcleo y GPU con todas las transferencias/copies/render y coste de arranque | Adoptar sólo mejora integral fiel; rechazar regresión puede satisfacer selección sin incorporar GPU |

No sustituir estos carriles por sorting de JSON, un promedio, kernel rápido, unit
pass o una sola curva. **6×1200 no es panel candidato de 8**, línea base de 60d,
ni comparación de capacidad C20 de 100 días. C20 conserva su horizonte heredado
1 vs28 hilos/100d y causalidad de todos los frenos. Si el presupuesto permite sólo
24 CPU propias en torre, no ejecutar 28 como si estuvieran admitidas: la celda
queda pendiente/UNKNOWN hasta reserva explícita suficiente.

## Umbrales heredados, provisionales y límites operativos

No se añaden números de aceptación ni se calibran mirando una candidata favorable.
El [perfil v3](contracts/thresholds.v3.json) conserva `NOT_GRANTED` y su condición
provisional. Preregistrar controles antes de candidatas y obtener decisión root
sobre cifras provisionales; no cambiar canon/perfil desde este protocolo.

| Exigencia actual | Clase / aplicación |
|---|---|
| Igualdad bit a bit de estado/archivo a inputs iguales | HEREDADA; no relajable con tolerancia numérica para declarar paridad |
| p95 paso completo <50 ms con32 habitantes | HEREDADA, constitución V; fijar escena/cadencia/guardado y coste íntegro |
| `state` <122880 bytes y escritorio ≥55fps, escena32 | HEREDADA spec001; informar viewport, DPR, modalidad, payload lógico y wire; no usar bytes comprimidos para ocultar payload grande |
| 30min reales después de60s warmup | B14/R1 PROVISIONAL; separar cold/warm y registrar todos los outliers posteriores |
| 1/12 cámaras; 1/28 hilos; GPU individual y conjunta | Matriz del canon; ejecución sujeta a reserva real y backend disponible, sin fingir soporte |
| Ahorro integral ≥10%, sin empeorar p95 cola ni bytes de red comparables | B14 PROVISIONAL; métricas/unidad/frontera congeladas antes de selección |
| RAM/disco/egress/colas/carga/transferencias | Medición obligatoria; no inventar nuevos límites de aceptación absolutos |
| Límites de CPU/RAM/time/output/log de cada job | Admisión operativa de esta sesión; parar al límite no demuestra techo hardware del modelo |

Un servidor headless no tiene FPS de navegador: registrar NA en el soporte y
`fieldCoverage` apropiada (missing/unknown con motivo si el wire no expresa NA),
conservando medidas válidas de servidor. La calidad integral sigue parcial hasta
el carril browser; no invalidar datos de servidor por FPS ausente. Kernel sin
warmup es un fragmento de costo parcial/UNKNOWN del carril warm, no un rechazo
estructural de todo el bundle ni PASS C22. Un presupuesto heredado incumplido con
medición válida es FAIL de su subgate, no se borra por otras carencias.

## Lo que los instrumentos actuales realmente ofrecen

| Fuente actual | Utilidad comprobable por lectura | Brecha para C22 integral |
|---|---|---|
| `src/server/app.ts`, `AppOptions.monotonicNow`, runtime/fases | Clon/reserva, simulación, save, proyección, broadcast, RSS, snapshot, tickHz, gobernador y flujos WS | `stepMs` cierra antes de gobernador/resolve/broadcast; `projectionMs` es una medición, no suma de todas las cámaras; falta contabilidad integral |
| `src/server/store.ts` y archivos diarios/paginados | Save, retención, deep validation/checkpoints y archivos reales | NORMAL por defecto; FULL requiere configuración explícita de copia y recibo, sin editar público ni fuente |
| `src/world/digesto.ts` | Ordena claves de objetos, conserva arrays y -0, incluye world/params | Residente+pendientes; no lee archivo persistido del host. Hace falta vector independiente del archivo |
| `scripts/lab/replica.ts`, `lab:replica` | Store temporal, params/seed y métricas diarias; modo `--gobernador servidor` | No stream de replay por tick ni coste browser/red. No equivale al gobernador de app |
| `scripts/curva-techo.mts`, `techo` | Escala habitantes/teselas hasta presupuesto con RollingStepPerformance/Store | `--hilos`/`--gpu` registrados no acreditan backend; instrumento advierte paso serial, no prueba multinúcleo/GPU integrados |
| `scripts/benchmark-store.ts` | Copia SOURCE readonly, controles de Store, round trips y comparación | Microbenchmark parcial, no cliente/red ni campañas sustained; no asumir FULL sin recibo |
| `scripts/compute-ecology-benchmark.mjs` y fuentes enlazadas | Kernel ecológico CPU/workers, GPU separadas/conjunta si NVRTC disponible; arranque/transferencias y diferencia | Kernel, no stepWorld completo/Store/fauna/red/render; 4/8 workers del banco no equivalen a28 hilos del mundo |
| `scripts/benchmark-ws-deflate.ts`, `scripts/bench/benchmark-render.ts` | Bancos parciales de transporte/render disponibles en árbol | Necesitan fijar disponibilidad, escena/trayectoria/versión y presupuesto; no forman por existir un harness completo |

En réplica `--gobernador servidor`, el código importa y llama a
`decideReproduction`; la app usa `Gobernador.decidir`, incluida política `techo`,
estado/histéresis y override manual. Registrar esa diferencia como **brecha de
equivalencia**, aunque un comentario diga «imita servidor». `--techo-lab` es otra
intervención determinista y se declara como tal. No resolver la brecha cambiando
réplica/app en este ownership ni silenciando el gobernador.

El inventario externo
`/datos/tmp-atlas-lab/orquestacion-20261003/revision-criterios/INVENTARIO-C21-C22.md`
reúne antecedentes V5/v6/V13, controles FULL históricos y curvas bajo contención.
No hay recibo actual de coste sostenido o límite hardware en esta redacción.
`firstBackup:null` del contrato 30-09 no implica ausencia actual de respaldos.
Tiempos históricos y suites no se transfieren a candidato/host de hoy.

## Preregistro antes de selección

Congelar un plan con ID/hash antes de medir candidatas. Registrar el registro de
semillas previo, semillas usadas/nuevas/reservadas, número total planeado y
denominador; no sustituir semillas abortadas por otras sin conservarlas y declarar
el cambio. Los paneles descriptivo6/candidato8/G2 y C20 largo tienen manifests
separados. La comparación de backend reutiliza exactamente los inputs del par;
no afirma novedad de semillas del microbenchmark existente (fija51926).

Campos necesarios del plan:

1. SHA de código y hashes de cada fuente/config/lock/instrumento, Node/tsx/TS/V8/
   SQLite/compiladores workers/NVRTC/CUDA, flags de compilación y precisión, drivers,
   backend solicitado **y realmente utilizado**; dependencia no disponible →
   UNKNOWN, sin instalación implícita. Volver a cotejar hashes al cierre.
2. Fixture/workload inicial propio con version/hash, `stateVersion`, limitsProfile
   heredado y huecos UNKNOWN, seed/params/RNG/IDs; disponibilidad y constructor
   comprobables. No copiar mundo público, auth/password ni curar legado manualmente.
3. Escena: población real, mortales/protegidos, fauna, teselas activas/dormidas,
   catálogo/archivo/recibos/crónica y tamaño; cámara(s), recorrido por tick, viewport,
   DPR/modalidad, red/latencia/bandwidth/compresión, conexiones/suscripción y órdenes.
4. Inputs físicos ordenados por fuente y tick, entrada del gobernador y prioridad
   de gates, política/cadencia/techo/manual y origen de cada reloj; apertura excluida,
   cierre incluido. Hashes de traza vinculados a run/epoch/source en índice explícito.
5. Host real: CPU/modelo/topología/hilos afinidad/cgroup, RAM física/permitida,
   almacenamiento/fs/disco, GPU por UUID/PCI y memoria/driver, carga y concurrencia,
   gobernador CPU/temperatura/clocks si observables; monitor y recibo de admisión.
6. Orden de brazos fijado/balanceado antes de datos, número de repeticiones,
   duración/plazos, warmup/cold definido por proceso/caché/contexto, ventanas de
   inclusión, política de faltantes/outliers/aborto, métricas/criterios y oráculo.
7. Presupuesto agregado propio, reserva para servicios/laboratorios, límites
   tiempo/output/log/disco/colas/VRAM, stop y cierre. Capacidad de laboratorio no
   garantiza presupuesto de servicio: medir ambos en sus carriles declarados.

Una escena de la misma población con historia/archivo distinto no es equivalente.
Para pares que evolucionen, comparar al mismo tick una trayectoria e inputs
iguales; para capacity host con trayectorias distintas, etiquetar por escena y
demostrar equivalencia pertinente sin atribuir «speedup» a menos trabajo. No
ocultar simulación diferida, regiones congeladas o pérdida de fidelidad.

## Relojes, gobernador, paridad y conservación

Separar tres fuentes: reloj físico `world.tick` (2400 ticks/día), reloj monotónico
real de cada host para coste, y entradas/decisiones deterministas del gobernador
para replay. `Date.now` de timestamps/pausas no es tiempo simulado ni oráculo de
latencia. `performance.now` de fases no debe consumir el reloj inyectado de app.

En paridad, congelar el estado del gobernador (incluidos techo/histéresis/manual),
presupuesto/política y traza por tick de medición/decisión, no sólo un flag final.
Al replay alimentar **las mismas entradas** al mismo código/orden de decisión para
ambos brazos; la instrumentación usa reloj independiente. Medir el overhead real
aparte, sin permitir que cambie inadvertidamente la ley de nacimientos. La traza
reproducida es intervención declarada, no benchmark del gobernador real.
Si no hay replay soportado, la celda queda UNKNOWN; no afirmar que desactivar el
gobernador resuelve G2 en condición de servidor.

G2 compara 6×1200 **cada tick**, instrumentos activos/inactivos, mismo estado/
inputs/RNG/IDs, digesto físico más manifiesto de archivo cuando corresponda;
registrar primera diferencia, path/value y cuándo aparece en inputs/decisión.
No ordenar arrays de personas/teselas/acciones para hacerlos coincidir. El
digesto residente actual conserva orden y exige hashes de archivo aparte.
Los hashes de tiempos/host/cámara operativos se archivan separadamente con
exclusiones explícitas; no excluir gobernador efectivo, inventarios, contenido,
parentesco, autoría o historia porque difieren.

En capacity dejar gobernador real con reloj del host: guardar p95/ventana/decisión,
política/techo y override junto a cada tick. Igual tick y entradas distintas no
autoriza pedir igual digesto. Si la primera divergencia ya aparece con inputs
iguales es FAIL de paridad; si faltan entradas es UNKNOWN; si empieza con traza
de gobernador distinta se informa capacidad sin certificar paridad entre hosts.

El oráculo de fidelidad añade ledger manual independiente de conservación,
unidades/quanta, stocks/flows/consumo/regeneración/residuos y transferID una vez,
S/I incluidos en balances. Cotejar historia/recibos/IDs archivados, no sólo floats
del kernel. El evaluador no genera el expected. Controles adversos preregistrados:
kernel rápido con transporte caro, contenido omitido, doble transferencia, orden
de arrays alterado, archivo recortado y cambio de gobernador por reloj. Deben
refutar una adopción engañosa. Ausencia de datos no eleva FAIL a PASS.

## Frontera y medición del coste completo

Registrar muestras crudas con start/end monotónicos, tick/scene/backend/case,
unidad y dependencia para evitar suma de tramos solapados. Medir:

| Componente | Medición exigida |
|---|---|
| Arranque/cold | Proceso, carga/validación/migración de copia, JIT/compilación, contexto GPU/topología, alloc/upload y primera respuesta; cachés declaradas |
| Paso/CPU | Clon o reserva/rollback, simulación por fases, gobernador, resolución de órdenes, GC/colas/event-loop y tiempo completo; user/system CPU de todos los procesos/threads |
| Store FULL y archivo | Save real `synchronous=FULL` en copia, stringify/partes/hashes/flush/fsync, retención/rotación/checkpoint/revisión profunda, carga/recarga/backup y crecimiento de db/WAL/SHM/archivos |
| Proyección/transporte | Todas las cámaras, serialización/compresión, broadcast y colas, IPC/workers, bytes ambas direcciones y tiempos de ACK/RTT, reconexión, retries y backpressure |
| GPU | Preparación/packing/copy, HtoD/kernel sincronizado/DtoH, halo/interGPU, buffers/VRAM, montaje y IPC; arranque/compilación amortizados con horizonte explícito |
| Cliente/render | Recepción/descompresión/parse/memoria, proyección cliente si existe, render CPU/GPU/fps/frame times, input latency, vista/DPR/calidad; browser separado de compute GPU |
| Recursos | RSS/heap/picos y pendiente temporal, RAM agregada workers/python/clientes, VRAM de cada GPU, bytes disco asignado/lógico/libre/crecimiento, IOPS/CPU/red/egress y backlog |

FULL es un carril explícito de referencia, no una afirmación sobre producción.
El harness futuro de copia deberá configurar/verificar el PRAGMA de la conexión
correcta, registrar su valor real y mantenerlo en todos los brazos comparados.
Comparar NORMAL actual en otro carril etiquetado si se preregistra; no usar cambio
de durabilidad para atribuir mejora a GPU. No editar Store/público aquí.

`runtime.stepMs` actual termina antes del resto del callback; el presupuesto
heredado debe informar ese tramo y el tramo ampliado completo con definiciones
visibles. Medir una ventana end-to-end hasta estado entregado/renderizado cuando
corresponda; declarar trabajo en paralelo y no sumar percentiles de fases.
Distribuciones por escena/rango: n, p50/p95/p99, máximo, muestras crudas; nearest
rank `sort[ceil(p*n)-1]`. `tickHz = pasos terminados/(fin último−inicio primero)`;
incluye último paso. Las estadísticas diarias actuales de réplica o tickHz runtime
no se renombran como ese estimador sin recalcular desde datos crudos.

Seleccionar la métrica primaria de coste completo antes de candidatas: tiempo de
pared para misma trayectoria completa, con CPU-segundos/RAM/red/disco/VRAM y colas
como guardas separadas, sin índice ponderado improvisado. Informar cold y steady
state sin amortización oculta. `completeSaving=(CPU−backend)/CPU` sólo con costeCPU
válido/no nulo y frontera/unidad idénticas; con denominador0/faltante→UNKNOWN.
No ocultar p99/máximos o congestión detrás de p50 favorable. Render y transferencias
forman parte del coste cuando la ruta los requiere; medir aunque anulen el speedup.

## Matriz de campañas y hardware

Cada celda recibe un caso independiente con la plantilla que sigue. Cruces
inviables permanecen explícitos, no se reducen los denominadores.

| Campaña/casos | Workload y variantes planeadas | Expected manual y decisión |
|---|---|---|
| P22-G2 / 6×1200 | Instrumento on/off, misma traza, CPU referencia, luego backend disponible | Digesto físico por tick y archivo exactos; falta replay/fixture→UNKNOWN. Gate técnico separado |
| P22-COLD | Cada escena/backend en proceso/contexto nuevos, carga/archivo/JIT | Cold completo reportado; no usar primer kernel caliente como arranque |
| P22-SUSTAIN | Escena32 y escenas envejecidas/archivo grande/carga dispersa; 30min tras60s warmup provisionales, cold aparte | Coste íntegro/colas/memoria/disco/extremos; escena no disponible→UNKNOWN, sin reemplazo favorable |
| P22-SCALE-P / P22-SCALE-T | Escalones de población y teselas hasta freno de hardware, archivo y retención reales | Recibo de freno y cuello de botella; escalón censurado por presupuesto de lab no es límite hardware |
| P22-CAM | 1/12 cámaras, cámara1/cámara2 distintas, recorrido fijado, conexiones rápidas/lentas/reconnect | Más visores no multiplican simulación; proyección/red/render completos y tick común; cobertura faltante→UNKNOWN |
| P22-CPU | Serial y multinúcleo real, hilos solicitados vs activos y Amdahl/serial measured | Igual trayectoria/fidelidad, IPC/barreras incluidos; pedir N sin backend no da PASS |
| P22-GPU-A | Torre RTX 5070 Ti 16 GiB, dispositivo identificado por UUID/PCI | Kernel y ruta completa comparables; reject si costo integral regresa |
| P22-GPU-B | Torre RTX 2060 6 GiB, igual workload cuando cabe | No reducir fidelidad/escena para acomodarla sin nueva celda; OOM/indisponible→UNKNOWN de cobertura |
| P22-GPU-AB | Ambas GPU con partición/halos/reparto documentados | Incluir copias duplicadas, transferencias, imbalance y total VRAM; comparar misma trayectoria |
| P22-BROWSER | Escena32/viewport fijo y recorridos equivalentes, modo completo/ligero separados | ≥55fps heredado donde aplica; render/CPU/GPU/red reales. Headless→NA cliente, coste servidor válido parcial |
| P22-ADVERSE | Kernel rápido+transfer cost caro/copy/render, contención host, alias de input/traza incorrecta | Oráculo manual rechaza speedup falso; invalidar equivalencia no es éxito |
| P22-C20-LONG | Comparación C20 1vs28 hilos/100d, oportunidades y gates completos | Carril posterior separado; cupo software demostrado→FAIL C20 no límite hardware; no inferirlo de P22-G2 |

CPU multicore se evalúa en ambos equipos con los backends disponibles. Fedora
carece de GPU dedicada para cómputo; su iGPU se declara aparte para render si es
observable, no sustituye las dos NVIDIA de torre. Medir hardware real/driver/VRAM
antes de la corrida: esta identificación de recursos autorizados no es un sondeo
actual ni garantía de disponibilidad. Las opciones del microbenchmark no prueban
un backend integrado de app.

Escalado debe distinguir freno por p95 hardware, límite anticorrupción/admisión,
VRAM/RAM/disco, fin de workload, recursos de campaña y cupo de software. El cupo
global de40 nacimientos/día es `SOFTWARE_LIMITED`, jamás techo hardware. Guardar
oportunidades/rechazos y todos los gates, incluidos not-reached y períodos sin
intentos; prioridad viene de fuente SHA/orden, no de deducción por nacimientos.
No quitar cupo o fabricar nacimientos para hacer favorable el benchmark de mundo
vivo. Workloads sintéticos de escala se declaran como preparación/intervención,
separados del crecimiento espontáneo y sujetos a ledger material válido.

## Recibo por caso, fallos y cierre

```text
caseId, campaignId, fixture/input version+hash, source/runtime/compiler/driver pins
before: initial components+manualLedger, scene, seed, physical/governor trace hashes
trigger: begin cold|warm|sustained|scale|camera|backend or preregistered adverse input
expectedManual: fidelity/stock/history, cost boundary, canonical/provisional gates
observables: raw intervals, digests EACH tick, archive, CPU/GPU/RAM/disc/red/client
close: final components+hashes, source unchanged, owned processes closed, outputs kept
classification: PASS|FAIL|UNKNOWN, invalid inputs separate, first mismatch/limits
resourceStop: R22 admission receipt, CPU/RAM/VRAM/time/output/log, reason and last tick
```

Todas las filas heredan esos campos y R22; completar los valores antes del caso.
Son artefactos de soporte, no nuevos campos de schema. Mapear partes observables a
`digest`, `cost`, `host-scene`, `physical-inputs`, `governor-trace`,
`component-manifest`, `run-manifest`, `source-metadata`; `evidenceIndex` explícito
con schema/kind/hash/run/epoch/rol y sourceRefs. `cost` sin FPS o warmup mantiene
coverage parcial tipada, no `complete` falsa. El evaluador futuro podrá consumir
el bundle validado, pero el ledger/expected/coste de referencia son independientes.

No disponible → UNKNOWN con motivo; presupuesto violado en una medición válida o
adopción de regresión integral → FAIL; fidelidad divergente a igual input → FAIL.
Entradas con hashes/version/binding contradictorios → inválidas, sin sustituirlas
por cero. En aborto preservar FAIL sustentado y declarar UNKNOWN del resto. Reportar
total planeadas/completas/abortadas/no disponibles y subgates separadas; ningún
«promedio de aprobadas» borra la cobertura faltante.

## Comandos existentes y pseudollamadas futuras

**No ejecutados.** Ejemplos posteriores sólo tras admisión, source congelado,
dependencias locales ya disponibles y fixtures/variables resueltos. No instalar.
`C22_RUN` es una raíz temporal nueva propia; `TMPDIR` creado propio es obligatorio.
No usar rutas públicas como SOURCE ni directorios por defecto compartidos.

```bash
export CARTA_DATA_DIR="$C22_RUN/data"
export TMPDIR="$C22_RUN/tmp"
# Microbenchmark Store parcial; no garantiza FULL ni C22 integral por sí solo.
node --import tsx scripts/benchmark-store.ts "$C22_RUN/fixture.sqlite" "$C22_RUN/store-current" current "$C22_ROUNDS"
# Curva serial actual: opciones hilos/gpu NO prueban backend integrado.
npm run techo -- --seed "$C22_SEED" --hilos 1 --escala habitantes --hasta "$C22_MAX_SCALE" --salida "$C22_RUN/scale-people"
# Réplica diagnóstica; no es replay G2 ni gobernador equivalente de app.
npm run lab:replica -- --seed "$C22_SEED" --dias "$C22_DAYS" --gobernador servidor --salida "$C22_RUN/replica"
# Kernel parcial de ecología, CPU/workers, GPU sólo con NVRTC comprobado.
node --import tsx scripts/compute-ecology-benchmark.mjs --output "$C22_RUN/ecology-cpu" --sizes "$C22_SIZES" --repetitions "$C22_REPETITIONS"
node --import tsx scripts/compute-ecology-benchmark.mjs --output "$C22_RUN/ecology-gpu" --nvrtc "$C22_NVRTC" --sizes "$C22_SIZES" --repetitions "$C22_REPETITIONS"
```

Las variables tienen rangos admitidos por cada CLI; fijarlos en preregistro, no
copiar defaults masivos. El banco ecology mide GPU0/GPU1/conjunta si están
disponibles: conciliar índices con UUID/modelo reales. Ausencia de NVRTC sin GPU
se registra como omisión, nunca se simula mejora. Ninguno de estos comandos mide
30min de servicio integral o fidelidad archivada por tick automáticamente.

```text
PSEUDOLLAMADAS — harness futuro, NO disponible por este documento:
admitOwnedCampaign(preregisteredPlan, freshHostReceipt, R22)
materializeOwnSyntheticWorkload(manualLedger, versions, newRoot) -> inputHashes
recordAppGovernorAndPhysicalInputs(pinnedApp, ownWorkload) -> indexedTraces
replaySameTickParity(onOffOrBackendPair, sameTraces) -> perTickAndArchiveDiff
measureFullSaveSustainedAndScale(scene, backend, clocks, FULL, clientRoute)
compareIndependentFidelityAndFullCost(rawSamples, manualExpected, frozenThresholds)
closeOwnedCampaignPreservingEvidence() -> closureReceipt
```

Faltan harness integral, replay de gobernador de app, export por tick del archivo,
configuración FULL comprobable, supervisor agregado, unificación de muestras
cliente/red/GPU y workloads envejecidos propios fijados. No afirmar que existen
por listar sus nombres. Si kernel/workers existen pero app carece de backend,
se conserva evidencia parcial del kernel y UNKNOWN de integración; implementarlos
será otro alcance/ownership, sin editar archivos ajenos ahora.

## R22 — admisión, recursos y paradas

Autorización de sesión: Fedora ≤100% sobre 20 threads y 38 GiB de RAM física,
GPU integrada Intel; pool propio FULL configurado 20 CPU/24 GiB. P0.c START2 es
un panel de cuatro ejecuciones running, sin cierre según corte
`2026-10-04T04:07Z`, con reserva FULL del pool completo **agregada** de
20 CPU/24 GiB/output 40 GiB. No iniciar benchmark concurrente suponiendo que
sobran 20 CPU. Torre ≤80% CPU global sobre 32 threads/125 GiB de RAM física,
slice propia **agregada** ≤24 CPU/32 GiB, incluidos todos los servidores
sintéticos, workers/python, clientes, profiling, backup/compresión/monitor.
G1 full suite en torre figura activo desde `2026-10-04T04:13:38Z`, con reserva
8 CPU/16 GiB/output 8 GiB y concurrencia 4; no acredita PASS ni deja otra
slice24/32 íntegra. Son cortes comunicados, no garantías futuras de estado o
disponibilidad. Los pools propios configurados son más conservadores que la
autorización de host; no fijan un límite permanente del usuario sobre toda la
RAM. Reservas actuales, ciencia y servicio público se preservan. Este documento
no crea capacidad libre ni admisión; cualquier inicio exige preflight fresco y
recibo verificable. Las GPU tienen VRAM nominal de 16 GiB (RTX 5070 Ti) y
6 GiB (RTX 2060); medir VRAM libre real y autorizar cuota propia antes de usar,
sin ocupar buffers ajenos ni hacer OOM para hallar el techo.

Cada caso fija techo temporal/output/log/disco/WAL/backups/RAM/VRAM antes de
arrancar; no son thresholds de aceptación nuevos. Monitoriza presupuesto y carga
ajena durante la corrida. Sin monitor, recibo fresco, rutas o stop verificable,
no se inicia. Al cruzar límites, competir con el público, perder trazas o agotar
workload, parar sólo PIDs propios; conservar samples/digests/último tick/razón,
censurar capacidad como UNKNOWN o límite de campaña, no atribuirla al hardware.
No matar jobs ajenos ni borrar outputs para repetir una candidata favorable.

Warmup no se ejecuta mientras se corre una suite del mismo presupuesto para
luego comparar como host quieto. Fijar concurrencia en plan y medirla. FULL suites
futuras sólo en worktree con TMPDIR/output temporal propios y budget actual propio,
coordinadas por integrador; esta tarea documental no ejecuta suites/builds ni
autoriza nuevos consumos. Revisión root posterior recibe hashes, matriz completa,
resultados parciales y límites, sin promesa de hardware infinito ni escala no medida.
