# T025 — protocolo C24 method y diseño de training posterior

Estado: **PLAN; método no certificado; training no iniciado; final UNKNOWN**. Autoría por asignación explícita: Sol high, cuenta secundaria; cuota no verificada, sin fallback ni delegación. Base de código `bb483260b2489fe62b113d620e5f56e5f3676dbc`. Únicos archivos propios: éste y [experience-protocol.md](experience-protocol.md). T025 queda sin marcar hasta revisión independiente/integrador.

Fecha de preparación documental: `2026-10-03T23:02:24-05:00` (`2026-10-04T04:02:24Z`). No es fecha de preregistro, reserva, autorización, training ni cierre.

## Autoridad y separación de alcances

[GOAL](../../GOAL.md), [constitución](../../.specify/memory/constitution.md), [CIENCIA](../../docs/CIENCIA.md#neuroevolución-después-de-afinar-el-mundo), [REGLAS](../../docs/REGLAS.md), [EVIDENCIA](../../docs/EVIDENCIA.md), [canon C24](../../docs/CRITERIOS-REALISMO.md#c24--b16--método-ahora-entrenamiento-posterior), [tasks T025](tasks.md) y [contrato v3](contracts/README.md) gobiernan el diseño. La adopción de C9–C24 por objetivo12 no aprueba sus candidatos numéricos. El [perfil](contracts/thresholds.v3.json) sigue DRAFT/provisional; números y elecciones operacionales necesitan controles/revisión antes de candidatas. No modificar C1–C8 ni sustituir la tendencia C8 con catálogo, roles u otro canal favorable.

G0 contractual fue liberado por `/datos/tmp-atlas-lab/orquestacion-20261003/revision-criterios/ROOT-G0-DECISION-v3.md`, SHA256 `658605e0d5f52d626def8169cf0e39f3d6477dbbbcb7c0573e7f85a0137b410c`, tras peer/formal v3 y archivo de 87 pins originales más control. Manifiesto original SHA256 `faaac25fb0ace210103eb5a19f12b4be8a0fac009b4635a6bb9a9a880714ef54`, preservado externo; no se reescribe para documentos posteriores. G1 sigue pendiente de PASS verificable en este alcance. Los avisos NO-GO previos congelados no se reinterpretan como decisión vigente ni se editan aquí.

Las tres etapas del contrato son independientes: `C24.method` examina preregistro/procedencia/pureza/control/revisión; `C24.training` examina el experimento posterior autorizado y sus resultados; `C24.final` exige ambas conformidades y la decisión verificable de fase posterior. Method puede llegar a PASS sin training; entregar un diseño no concede ese PASS. La aceptación de GOAL exige además cierre biológico reproducible y experiencia/durabilidad/hardware/carta; no acaba por plan, tests o entrenamiento aislado. Si GOAL exige training final, permanece abierto hasta su ejecución válida y revisión.

No se encontró AGENTS.md en las rutas ancestrales comprobadas ni en la feature; se consultó CLAUDE.md. Main y HEAD coinciden en la base de código indicada; el canon C9–C24 es de la feature, aún no de main. No se ejecutan motor, bench, suites, campañas, evaluador ni entrenamiento; tampoco publicación, auth/datos públicos, cartas, commits o push.

| Fuente de diseño | SHA256 de bytes leídos |
|---|---|
| GOAL.md | `0d22ec39ca1088afca917a6043027c0482aa7381d8dc295ca45e8cd6cbf4d06d` |
| docs/REGLAS.md | `364940f5a19a85ba55f126d608b076482f56024ea9ab3e9ac9f313ba23c026c5` |
| docs/EVIDENCIA.md | `834632103946d98bcc7e956ea1496c88fc5199fd779c653d3d5aec3cf38c40ec` |
| docs/CIENCIA.md | `58ae1960ec79e047504fee58c66b9b64d48f937540cc1f26bdcf6a788197a3f3` |
| docs/CRITERIOS-REALISMO.md | `9f863c563b67d488af38a5653d7c381b33f02a3c4b8148722ec82981f79624ca` |
| contracts/thresholds.v3.json | `d99e24ee85f379164c1dd0d351a0cdb204d8bf1dda0e446abd70cfe582e4b7cb` |
| scripts/lab/criterio-terminado.mts | `dd6330067dc0c8f09ba156da04bc4342f966c892bdbafec333dd912148e98325` |
| src/world/index.ts | `1696a308a2ccc4c9891eedaf56dfd37fa59a0386a8f77e1b338f8f0e5b158228` |
| src/world/genetics.ts | `6303faa03b11d4f5d659055947955aa16ff82f75a0e8cff143d6ad336da7e12e` |

Hashes de redacción no son sello de un experimento ejecutado. El futuro cierre requiere manifiesto completo, dependencias transitivas, recibos independientes y bytes exactos de entradas/resultados; un commit por sí solo no identifica worktree sucio, datos o runtime.

## Diseño existente inspeccionado

[index.ts](../../src/world/index.ts) implementa `choose()` con percepción/rutas locales, puntuaciones de necesidades, oportunidades, recuerdos y acciones materiales. No es una red entrenada. [genetics.ts](../../src/world/genetics.ts) define siete loci diploides simulados, expresión, recombinación/mutación y RNG local reproducible por seed/identidad; no es ADN humano ni un algoritmo de selección de redes ya aprobado. [family.ts](../../src/world/family.ts), [body.ts](../../src/world/body.ts) y [demography.ts](../../src/world/demography.ts) separan capacidades, fertilidad, costes, nacimientos y mortalidad. [technology-memory.ts](../../src/world/technology-memory.ts) conserva repertorio, práctica y procedencia; [technology.ts](../../src/world/technology.ts) y [technology-execution.ts](../../src/world/technology-execution.ts) enlazan procedimientos a ejecución. [inspector-view.ts](../../src/client/inspector-view.ts) muestra diferencias heredado/aprendido/transportado, sin revelar automáticamente todo estado interno.

REGLAS documenta aprendizaje contextual `Q ← Q + α × (resultado − Q)`, habilidades, práctica y enseñanza, separados de alelos. `learningEnabled` desactiva imitación/parte de enseñanza; práctica técnica y otros cambios pueden continuar. No se usa ese booleano como prueba de «todo aprendizaje off». Nacimiento no copia repertorio completo, objetos ni experiencias de los padres; cultura inicial, genética y transmisión posterior son estados diferentes. La gramática/ascendencia de planos tampoco es genética de política.

CIENCIA propone sensibilidad ambiental separada de neuroevolución de políticas pequeñas con observación local, acciones admisibles y posibles redes recurrentes. MAP-Elites/QDax son opciones documentales pendientes, no dependencias instaladas, decisión de arquitectura o runtime verificado. Aquí no se elige biblioteca, proveedor ni modelo externo y no se realiza investigación nueva. No depender de LLM por tick, Ollama/SCITE retirados ni ruta «Opus 5.5» no verificada.

## Poblaciones, paneles y relojes que no deben mezclarse

| Alcance | Tamaño/ventana | Uso y límite |
|---|---|---|
| Paridad instrumental G2 | 6 semillas×1200 ticks | Ensayo técnico de pureza, no evidencia científica 60d |
| Línea base T019/T020 | 6 nuevas verificadas×60d | Descriptiva C1–C24; no satisface panel8 ni selecciona training |
| Panel candidato/calibración | 8 según requisito pertinente | Gate/regla separada; no convertir 5/8 en 4/6 ni elegir umbral favorable |
| Training posterior C24 | 8 reservadas×6 brazos×60d | 48 corridas previstas, reserva exclusiva sin ajuste previo; IDs todavía UNKNOWN |
| C20 | Horizonte 100d según canon/diseño002 | 60d no cierran freno demográfico a 100d |
| C8 | Tendencia con evaluador congelado | No sustituir por estabilidad, roles, catálogo o promedio de nuevos indicadores |

Los tamaños de training y mejora relativa ≥10% son **PROVISIONAL** según perfil, aunque se conserve su estructura en este diseño. Ocho semillas para distintos frentes no constituyen automáticamente la misma reserva. Días simulados usan `TICKS_PER_DAY=2400`, apertura tick0 y transiciones `(0,144000]` para 60d, bloques disjuntos de 10d. Instantes reales RFC3339 con zona y reloj monotónico de coste se registran aparte. No comparar throughput como si fuera salud biológica ni segundos reales como días del mundo.

## Auditoría de reserva antes de seleccionar IDs

R0 consultado: `/datos/tmp-atlas-lab/orquestacion-20261003/recuperacion/INVENTARIO.json`, SHA256 `3fa139538c5d26350544b2c0a6e05adb74ef197170baf16288466fdbe350af47`. Enumera corridas DESG-D60, P0.c y Muse4-sequía; leído para procedencia, no ejecutado ni validado aquí. Incluye semillas ya usadas/previstas 18101–18112, 9501–9504 y 9101–9106. **No es un inventario exhaustivo de todas las semillas conocidas.** El contexto recibido distingue 68 semillas conocidas históricas; ese número no prueba elegibilidad ni ocho reservadas. R0 y registros de campañas deben conciliarse con ese conjunto completo antes de elegir.

Procedimiento futuro obligatorio, sin elegir ahora valores numéricos:

1. Un custodio científico autorizado reúne el registro íntegro de semillas conocidas: diagnósticos, controles, ajustes, entrenamiento, evaluación, campañas completas/interrumpidas/no iniciadas, registros históricos archivados y reservas de otros autores. Captura SHA/autor/fecha/época/sourceSHA/uso/exposición y recibos de cada fuente. «Sin cierre» no equivale a «no usada».
2. Conciliar el inventario R0 con las 68 conocidas y todas las adicionales documentadas, resolver duplicados/aliases/normalización uint32 y reservas simultáneas. Registrar conjuntos de procedencia, conflictos y huecos. No deducir ausencia de uso de una búsqueda vacía, rango alto o seed aleatoria.
3. Establecer entrenamiento/ajuste, validación de desarrollo, controles descriptivos y holdout final disjuntos; definir si cualquier exposición del resultado, incluso diagnóstico/partial, contamina el holdout. En este diseño, exposición para ajustar o elegir candidato impide reserva final. Elegibilidad desconocida → UNKNOWN y no selección.
4. Aplicar un procedimiento de selección registrado antes de outcomes, independiente del desempeño, sobre el conjunto verificado elegible. Registrar algoritmo/RNG de selección, ocho IDs, fecha de reserva verificable y recibo de custodio/revisor. Sellar hash de registro y compromiso de no uso hasta final. No hay IDs elegidos en esta entrega ni afirmación de reserva.
5. Auditar contaminación al abrir final: comparar logs y manifiestos completos, acceso a resultados, usos durante entrenamiento, cambios de candidato y autorizaciones. Fuga comprobada refuta la reserva/method; cobertura insuficiente deja UNKNOWN. No sustituir una semilla fallida ni buscar ocho favorables retrospectivamente. Una nueva reserva requiere nueva época/preregistro y conserva la historia anterior.

Datos de holdout inaccesibles al ajuste/selección de modelo; el custodio conserva sus artefactos sin transferir contenido personal. El instrumento puede ser revisado con fixtures conocidos antes de candidatas, nunca con expected derivados del evaluador ni seed final usada para afinar.

## Seis brazos: estructura canónica y definiciones abiertas

El canon especifica **3 selectores (actual/neutral/aprendido)×aprendizaje on/off**. Se congela esa matriz lógica antes de outcomes; no se sustituyen por seis variantes ambientales ni por «scores booleanos». No hay definición ejecutable completa del neutral/aprendido ni del alcance on/off; todas las filas permanecen planificadas/UNKNOWN.

| Brazo lógico | Selector | Aprendizaje durante vida | Decisión necesaria y compromiso previo |
|---|---|---|---|
| A-on | Actual `choose()` del SHA fijado | on | Inventariar todos los estados Q/habilidades/práctica/imitación/enseñanza habilitados; referencia funcional, coste y sesgo actuales |
| A-off | Actual | off | Definir ablación de aprendizaje y memoria preservada sin cambiar percepción/leyes; congela canales acordados, no usar sólo learningEnabled |
| N-on | Neutral | on | Definir neutralidad de selección/variación de forma revisada y comparable; conservar acciones admisibles y aprendizaje acordado |
| N-off | Neutral | off | Misma neutralidad y ablación exacta; control de deriva con costes/materiales reales, posible pérdida de viabilidad se reporta |
| L-on | Aprendido | on | Política heredable seleccionada antes de holdout, adaptación vital definida aparte; coste adicional/memoria y riesgo de sobreajuste explícitos |
| L-off | Aprendido | off | Política heredable congelada durante vida con ablación acordada; aislar contribución de adaptación sin recompensar protecciones |

Steven o autoridad científica explícitamente autorizada deben resolver y recibir las definiciones exactas de neutralidad, selección heredable, entrenamiento y todos los canales on/off **antes de sellar brazos/ejecutar**. La aprobación científica no sustituye la autoridad personal de Steven sobre carta/S/I. Si falta definición, mantener OPEN/UNKNOWN; no inventar random uniforme, desactivar supervivencia, apagar memoria perceptiva ni llamar off a un único flag. El selector aprendido no cambia física, balances, daño, fertilidad, clima ni acceso remoto. La neutralidad no autoriza retirar costes.

Cada brazo deberá fijar política/código/hash/params, máscara de acciones y prioridades, observaciones locales y normalización, memoria inicial/dinámica, RNG separado, herencia/mutación de política y canales culturales. Mismas leyes/estado inicial/inputs exógenos por semilla salvo intervención preregistrada; las trayectorias endógenas podrán divergir por selector. No exigir digestos iguales entre políticas diferentes como prueba de comparabilidad. La paridad de instrumento/backend sí exige inputs y política iguales al mismo tick.

Todos los brazos prueban alternativas en laboratorio; esta matriz no elige ganador ni despliega modelo. La definición de costes equivalentes puede exigir limitar inferencia/modelo y asignar iguales oportunidades de evaluación; no confundir wall-time ilimitado del aprendido con presupuesto igual al selector actual.

## Decisiones que deben quedar selladas antes de training

| Decisión | Contenido verificable exigido | Estado |
|---|---|---|
| Dataset y procedencia | Fuentes científicas/sintéticas autorizadas, IDs/hashes/licencia o autorización, exclusiones, splits y epochs; nada íntimo/biográfico al modelo | OPEN |
| Encoding | Observación local, campo/unidad/rango, normalización y missingness, acciones/costes, estado recurrente/reset, precisión y ausencia de información remota | OPEN |
| Objetivo | Vector de servicio material y guardas, agregación preregistrada, oportunidad/exposición/censura y cero mérito por obras vacías | OPEN |
| Variación genética/política | Qué parámetros son heredables, recombinación/mutación/selección, tasas/bounds, población de modelos y RNG; distinto de genes corporales existentes | OPEN |
| Aprendizaje vital/cultura | Qué estados se adaptan, enseñan o conservan; canales on/off, conocimiento inicial, muerte del último conocedor/redescubrimiento pagado | OPEN |
| Beneficio/control | Funciones/unidades/ledgers, pares/ablaciones aplicadas, controles relevantes de cada selector y guardas C1–C8 | OPEN |
| Sobreajuste y selección | Semillas de desarrollo, máximo evaluaciones/tuning, selección y desempates deterministas, número de candidatos final, holdout custodiado y uso único | OPEN |
| Dependencias/modelo | Código/modelo/dataset/runtime/dependencias transitivas/algoritmo/precisión hashes y ruta instalada comprobada; sin biblioteca asumida | OPEN |
| Cómputo comparable | Hardware/memoria/disco/red/transferencias/clock/gobernador, budgets iguales y tolerancias acordadas antes de resultados | OPEN |
| Autorización | Decisión posterior de Steven, alcance material exacto, auditoría de procedencia y revisión independiente tras afinación | PENDING |

El dataset científico y todo conjunto de recuerdos/carta personal se mantienen separados. Los modelos no escriben ni modifican texto personal. Cualquier uso futuro de contenido real necesita la autorización individual y recibo local de [C23](experience-protocol.md), sin que este protocolo lo autorice; consentimiento personal no equivale a permiso de training. Prioridad previa: supervivencia, utilidad y legibilidad con evidencia coordinada, no sólo tests verdes.

## Beneficio material, novedad y controles refutables

Por función, medir servicio efectivamente aplicado a mortales no protegidos: cantidades debitadas y consumidas/preparadas, alivio corporal conforme a ley, trabajo/energía/tiempo/material de adquisición, mantenimiento y reposición. Unir `service`, stocks/flows, applied-effect, law-inputs, source-order y oportunidades/exposición mediante referencias del mismo evento/SHA; un before/after de snapshot no acredita causa. Costes fallidos, pérdidas, residuos, extinciones y censura siguen en las cuentas. Contadores de usos, acciones, generación, población final, recetas o construcción vacía no son fitness.

Congelar métrica por función/unidad y presupuesto **antes de ajustar**: beneficio material por presupuesto de trabajo/energía/material o evaluación acordado, reportando asimismo totales/exposición. No sumar agua, madera y alivio en un escalar ad hoc ni usar etiquetas PASS/FAIL como recompensa. Si se necesita escalar para selección, su conversión/ponderación, justificación y sensibilidad requieren aprobación previa; hasta entonces objetivo de training OPEN. Métricas del evaluador final no se convierten automáticamente en fitness ni oráculo.

La definición de novedad es firma funcional ejecutada y genealogía resoluble de procedimiento/producto, con consecuencias materiales, no nombre aleatorio. Catálogo y oportunidades se registran completos: propuestas, ensayos fallidos/pagados, variantes aceptadas/rechazadas, archivo, autores, ejecutores y exposición/canales donde se podía obtener servicio. Fijar descriptores de movilidad, dependencia de reservas, especialización y cooperación útil con sus controles. Sin oportunidad/ledger o con archivo no resoluble → UNKNOWN; no favorecer una política omitiendo candidatos inútiles del denominador.

S/I se incluyen en apertura/cierre/flows/consumos/transferencias del balance global. Excluir del mérito/fitness autónomo S/I y producción, trabajo, insumos o saber dependientes directa o transitivamente de protección/rescates/órdenes humanas. Trazar `protectedOriginIds`, `protectionStatus` y genealogía de dependencias; mixed/protected no acreditan autonomía y unknown impide atribución. No inventar una fracción mortal del mérito ni eliminar materia protegida para cerrar cuentas. C1–C8 conservan exactamente sus filtros históricos y SHA, sin reescribir inclusión de S/I.

Para mejora relativa usar `(beneficio_aprendido − beneficio_control)/beneficio_control` por función y normalización preregistrada, base positiva; base0 → UNKNOWN con absolutos conservados, sin epsilon. Comparar contra **cada control relevante** A/N y condiciones on/off definidas de antemano; reportar los seis brazos completos, no sólo el mejor canal. ≥10% es umbral PROVISIONAL del perfil, no aceptación nueva. Congelar hipótesis, contrastes, unidad independiente seed, estimador/intervalos, tratamiento de multiplicidad/censura y regla de panel antes de outcomes; no afirmar significancia a partir de ticks o seis controles descriptivos.

El control causal requiere pares equivalentes y diferencias preregistradas: retirar/restaurar proveedor, propiedad o enseñanza cuando corresponda, junto a copia contemporánea no intervenida, entradas/estado inicial y oportunidad comparables. Registrar debitado/efecto/ley en orden fuente, no flags `materialBenefit=true`. Intervención de diagnóstico separa su brazo del autónomo; no rescatar candidatas y contarlas como autosostenidas. Las ventanas/control/normalización se fijan antes de ver caída/recuperación. Comparación de selectores no demuestra por sí sola selección genética sobre deriva ni transmisión de saber.

Guardas: importar C1–C7 y tendencia C8 del evaluador congelado y resultados por seed/control, incluidos FAIL/UNKNOWN/censurados. El criterio provisional de no deterioro del canon no permite PASS previo convertido en FAIL/UNKNOWN ni reducir conteos; evidencia insuficiente → UNKNOWN. No reoptimizar umbral C8 ni atribuirle novedad. Si un criterio físico incumple con evidencia válida, conservar FAIL aunque training gane fitness; una laguna no se transforma en fracaso biológico observado.

## Preregistro, freeze y trazabilidad operable

Tras resolver decisiones y antes del primer dato candidato, custodio/revisor independiente sellan por SHA256 de bytes:

1. Fuentes completas (incluidos cambios no commiteados autorizados), instrumentos/observador/evaluador, oráculos manuales conocidos, profile/canon/schemas y definiciones de métricas; pureza/G1/G2/G3/G4 y decisiones previas requeridas con recibos reales, no placeholders.
2. Dataset/modelo/encoding/splits, reserva auditada, seis brazos exactos, 48 runIds planeados, iniciales/params y sus hashes, RNG de selección/entorno/política/genética/operador y política de seeds; datos de holdout inaccesibles al ajuste.
3. Entradas físicas exógenas y control climático/gobernador, reloj científico/ticks/cortes/checkpoints, algoritmo/precisión/backend, manifiestos hardware/runtime/dependencias/coste e intervenciones causales planificadas.
4. Límites recursos/output/runtime, calendario de admisión/colas, condiciones de abortar/cierre/reanudación, pérdida de historia, política de retención y comparabilidad; firma/decisión humana verificada y archivo local anterior a datos.

`preregistration` enlaza plannedRunIds/plannedSeeds/arms/profileHash/metricDefinitionsRef/budgetRef/controlPairRefs/independentReceiptRef; `method` enlaza registro/hash, seedRegistryRef/reservedSeedAuditRef, manifests, selector/learningEnabled, budget, intervenciones, revisión y priorPhaseDecisionRef/rewardDefinitionRef. El booleano `registeredBeforeData` no prueba orden: timestamps RFC3339 con zona cotejados contra recibos/archivo externo y firstDataAt real. Hash de plan sin recibo verificable no es preregistro firmado. No ejecutar expresiones documentales de fitness/law con eval/Function.

Cada corrida registra runId/epochId/rol, SHA fuente/instrumento/evaluador, seed, params resueltos/hash, estado inicial, inputs/gobernador, hardware/backend, planned/actual ventana, inicio/fin monotónicos y civiles, costes completos, estado closed/aborted/not-started y todas las intervenciones. Confirmar boot/runtime/dependencias antes del spawn, ACK de apertura al tick0 y recibo de cierre: exit status/señal, tick/duración alcanzados, integridad/hash/manifiesto de componentes/streams, ausencia de gaps o gaps explícitos, revisión independiente. Exit0 o archivo final por nombre no acreditan cierre científico.

Cambios de fuente, dataset, objetivo, procedencia, reloj, hardware o intervención después del freeze abren enmienda/época con decisión y nueva comparabilidad **antes de continuar**; no editar el preregistro para que parezca anterior ni mezclar prefijos. History-gap sólo certifica futuro y conserva la brecha anterior. Reanudar exige estado/RNG/clock/recibos verificables con misma versión; si no, nuevo run desde apertura bajo decisión coordinada, manteniendo el abortado en el panel.

## Recursos y admisión pendientes

Contexto comunicado, no sondeo live: Fedora autorizado ≤100% sobre 20 threads y 38 GiB de RAM física, GPU integrada Intel; pool propio FULL configurado 20 CPU/24 GiB. P0.c START2 es un panel de cuatro ejecuciones running, sin cierre según corte `2026-10-04T04:07Z`, con reserva FULL del pool completo **agregada** de 20 CPU/24 GiB/output 40 GiB. Torre autorizada ≤80% CPU global sobre 32 threads y 125 GiB de RAM física; pool propio agregado ≤24 CPU/32 GiB. RTX 5070 Ti 16 GiB y RTX 2060 6 GiB de VRAM, que no se suman. G1 full suite en torre figura activo desde `2026-10-04T04:13:38Z`, con reserva 8 CPU/16 GiB/output 8 GiB y concurrencia 4; no acredita PASS. Son cortes comunicados, no garantías futuras de estado o disponibilidad. Los pools propios configurados son más conservadores que la autorización de host; no fijan un límite permanente del usuario sobre toda la RAM. No suponer núcleos/hilos idénticos; inventariar capacidades/driver/backend en recibo fresco. «Opus5.5 exacto» no está verificado ni es dependencia de cómputo de este plan.

No reservar procesos ni restar capacidad a P0.c/G1 por entregar documentos; preservar reservas actuales, ciencia y servicio público. Este documento no crea capacidad libre ni admisión: cualquier inicio requiere preflight fresco y recibo verificable, respetando límites agregados y reservas vigentes. Un futuro plan debe decidir slots/concurrencia/CPU/RSS/cgroup/IO/disco/red por host, guardas y presupuesto total antes de runs, sujeto a carga/admisión actuales y prioridad de servicios. RAM total no es RSS disponible. El número de slots, duración real estimada, límite de output/logs y timeout del training posterior están **PENDING**, sin cifras inventadas a partir de benchmark ajeno.

Budget comparable registra cantidad de evaluaciones, ticks/oportunidades, trabajo material, inferencia, entrenamiento/tuning, warmup/compilación, traslados/sincronización CPU↔GPU, guardado/proyección, archivos, RAM/VRAM/IO/red y tiempo extremo/completo. GPU kernel más rápido no implica coste total mejor. [C22](performance-protocol.md#umbrales-heredados-provisionales-y-límites-operativos) exige igualdad bit a bit de la trayectoria física **completa y del archivo**, con estado inicial, política e inputs físicos/del gobernador equivalentes; una tolerancia numérica no satisface C22. Un simulador aproximado para training pertenece a un alcance posterior diferente, requiere autorización explícita y validación de fidelidad y resultados de políticas en el motor autoritativo; no acredita C22 por aproximación. C22 y C21 tienen autores propios. Gobierno dependiente de wall-clock se captura como traza exógena equivalente para comparación causal; capacidad host con distinta traza es otro ensayo, no la misma pareja.

Abortar operacionalmente por techo de output/RSS/disco, timeout, carga/admisión, runtime incorrecto, pérdida de ACK/recibo, cambio de boot/época o corrupción. Preservar artefactos/manifest de cierre y motivo, sin rellenar datos finales. Un aborto de recursos → cobertura parcial/UNKNOWN operacional, **no FAIL biológico** por no llegar a60d; una infracción física observada antes conserva FAIL válido. Extinción observada con cobertura es resultado biológico, no excusa para abortar/remover semilla. Panel P0.c conserva sus cuatro corridas planeadas y prefijos, sin declaración de4/4 cierres ni sustitución por las terminadas; esta entrega no evalúa P0.c.

## Lectura futura y cierre

Guion manual futuro: custodio confirma autorización/priorPhaseDecision y freeze; revisor confirma reserva/dependencias/recursos; operador admite runtime y apertura; operador conserva checkpoints/costes/intervenciones y cierre; revisor verifica cobertura/refs/hash; evaluador lector recibe únicamente artefactos válidos sin arrancar World; integrador publica tabla local de resultados científicos y pendientes, sin desplegar políticas. Este orden es un plan, no comandos ejecutados ni permiso de training.

Emitir todas las subgates/stages y 48 corridas previstas con `planned/pass/fail/unknown/total`, conciliación `pass+fail+unknown=total=planned`, quality/safety/censura/razones/refIDs. Mantener tablas por8 seeds×6 brazos y C1–C24; panel/calidad separado de resultado individual, referencias C1–C8 importadas sin modificación. Las seis descriptivas tienen su propia tabla; no se anuncian8 ni significancia. Reportar servicio por función/exposición, balances/dependencias y coste completo, incluso canales negativos o desconocidos. Missing fields/streams/control, ZERO_REFERENCE/NO_OPPORTUNITY/INSUFFICIENT_PANEL impiden PASS; nunca verdad vacía.

Refutaciones previstas para revisión de instrumento: conteo de obras sin servicio no mejora fitness; control0 conserva UNKNOWN relativo; fuga de holdout refuta reserva; quitar procedencia protegida no eleva autonomía; borrar ledger/cierre deja UNKNOWN; rescate oculto válido → FAIL method; temporalidad del recibo contradictoria impide sello; method conforme con training no iniciado conserva training/final UNKNOWN. Son oráculos documentales de casos sintéticos, no resultados de tests ni aceptación.

Hoy: **method UNKNOWN, training UNKNOWN/TRAINING_NOT_STARTED, final UNKNOWN; acceptanceStatus=NOT_GRANTED**. Falta revisión independiente de estos docs, cierre de instrumentos/gates pertinentes, inventario exhaustivo de semillas y ocho reservas verificadas, definición operativa de seis brazos/on-off, dataset/encoding/objetivo/variación/selección, medidas/controles/panel/estadística, presupuesto y admisión, recibos de freeze/época/runtime/cierre y autorización posterior explícita de Steven. Training sólo podrá empezar tras esa autorización y auditoría material/procedencia; validación de modelo aprendido y adopción requieren evidencia y decisión independientes posteriores. No se marca GOAL terminado por entregar T025.
