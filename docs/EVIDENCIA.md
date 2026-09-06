# Evidencia vigente

Fecha de corte: **6 de septiembre de 2026**. El servicio privado ejecuta **V5 `7d8777c`, SQLite 4**, con reglas/protocolo 5. La publicación se verificó a las **01:46:49 UTC**, con un mundo nuevo por decisión de Steven y el anterior archivado. Están activos el núcleo corporal compartido, las transiciones materiales del suelo, el catálogo resoluble y la memoria técnica local. Dos clientes comprobaron acceso, avance y un estado compartido con cámaras independientes. Las réplicas de veinticinco días pertenecen al cierre biológico anterior `6d0e53b`; no incluyen este catálogo ni acreditan mantenimiento material. El transporte de agua V6 sigue separado del servicio publicado.

Este documento conserva resultados y límites frente al [objetivo rector](../GOAL.md); [REGLAS](REGLAS.md) define mecanismos, [CIENCIA](CIENCIA.md) su interpretación y [CONSTRUCCION](CONSTRUCCION.md#arquitectura-de-autonomía-avances-y-trabajo-pendiente) el estado de arquitectura y trabajo pendiente. Git conserva los cierres anteriores, sin documentos históricos paralelos.

## Afinación tras el colapso del mundo observado

Por indicación de Steven, se suspendió la publicación V6 y la incorporación de funciones para investigar supervivencia, construcción y legibilidad. El candidato conjunto `9b40f4d` había pasado **517/517 Node, 18/18 navegador compilado, typecheck, build y smoke**; esos gates no probaron estabilidad demográfica. El [manifiesto](../artifacts/release-v6.json) permanece conservado y el servicio sigue en `7d8777c`. No se reinició ni modificó su mundo para ocultar el incidente.

La captura coherente de las **03:20:10 UTC del 6 de septiembre**, semilla `51926`, corresponde al paso **53.004**, día visible **23** y **22,085 días transcurridos**. Se validó con el Store de la fuente publicada, dentro de una transacción de lectura declarada al verificador; el hash de la copia quedó idéntico. Hay 10.370 eventos correlativos completos, un evento técnico de reinicio separado, 32 legados, 979 definiciones y 3.914 recibos tecnológicos. **No hubo órdenes ni gestos de usuario.** [Informe agregado](../artifacts/refinement-day22/report.json), [serie demográfica sin nombres](../artifacts/refinement-day22/demographic-events.json) y [analizador reproducible](../artifacts/refinement-day22/analyze.mjs).

| Resultado observado | Evidencia |
|---|---|
| Balance demográfico | 16 iniciales + 18 nacimientos − 32 muertes = **2 vivos**. Solo quedan S e I, protegidos y con salud 0,05. |
| Inicio del colapso | 14 muertes por deshidratación entre los pasos 13.045 y 15.039, días 6 y 7; una muerte por exposición en 16.734. Trece muertes por sed ocurrieron dentro del intervalo sin lluvia 10.200–15.000. |
| Pérdida del recambio | Último nacimiento en 13.200, día 6. Las 17 muertes posteriores por senescencia terminaron en 41.241, día 18. Ningún individuo de generación 2 dejó descendencia registrada. |
| Persistencia del problema | 11.763 pasos, aproximadamente 4,9 días, con solo las identidades protegidas. Su permanencia no acredita autonomía demográfica. |
| Construcción | 102 estructuras en la unión de regiones conocidas: tres iniciales y 99 construidas; 20 activas y 82 archivadas, dos rotas. Solo una no tiene beneficio histórico registrado. El contador de beneficio no mide ocupación, visitas ni personas distintas. |
| Producción tras el colapso | Se crearon al menos diez estructuras en los días 19–22, después de morir el último habitante mortal. La necesidad marginal de nuevas obras requiere revisión. |
| Reservas e intercambio | El archivo registra 91,20 unidades de lluvia recogida, 0,694 de alimento almacenado y **cero alimento retirado de graneros**. Hay 2.794 acciones de cooperación y 2.617 enseñanzas registradas; estos acumulados no garantizan satisfacción de necesidades. |

La [gráfica de población, causas y construcción](../artifacts/refinement-day22/population-diagnosis.png), disponible también en [SVG](../artifacts/refinement-day22/population-diagnosis.svg), reconstruye hechos archivados; no es un contrafactual causal. La ventana `history` de 96 muestras solo cubre los pasos 47.280–52.980, aproximadamente 2,4 días, y ya había perdido el inicio del colapso. Los stocks finales no permiten deducir cuánta agua podía alcanzar un habitante cuando murió. Las regiones archivadas tienen relojes diferentes; su suma tampoco es un inventario global simultáneo. Los legados no conservan hambre, sed, acción, reservas ni daño acumulado de cada paso. La reproducción causal y las comparaciones de supervivencia permanecen pendientes de cierre.

La revisión visual del mismo build usó dos clientes, **1440×900 y 390×844**, sin órdenes, errores JavaScript ni cambio de simulación; sus sesiones propias se cerraron. Las capturas de navegador son posteriores, pasos 56.390–56.460, día 24, y se distinguen de la copia física anterior. Se comprobó que las copas ocultan edificios y que el inspector móvil muestra primero el agua del suelo, dejando las reservas de la cisterna bajo el pliegue. La unión física contiene 1.211 árboles sin copa pero con madera, frente a solo cuatro tocones de madera cero: la representación repetitiva de ramas no permite inferir tala. [Vista de estructuras](../artifacts/refinement-day22/before-desktop-structures.png), [ramaje](../artifacts/refinement-day22/before-desktop-bareStanding.png), [inspector móvil](../artifacts/refinement-day22/before-mobile-structure-inspector.png) y [métricas visuales](../artifacts/refinement-day22/before-physical-metrics.json).

Fable 5.1 aportó una crítica textual mediante la ruta disponible `claude/fable`. La [adjudicación GPT-6](../artifacts/refinement-day22/before-fable-critique.json) conserva y rechaza sus inferencias incorrectas sobre depósitos vacíos, número de sprites y altura del ramaje. No se atribuye acceso a Mythos, ni se presenta esa crítica como verificación del producto corregido.

## Base biológica de las pruebas largas

Cierre de código **`6d0e53b`**, con interfaz de cosecha y reserva `a89353e`. Es la base de los experimentos largos y del mundo que después se actualizó. Integra cosecha física, preparación con pareja conocida y apta, protección de reserva con excepción por hambre urgente y acercamiento mediante percepción local y confianza mutua. Las condiciones y costes están en [REGLAS](REGLAS.md#herencia-práctica-y-descendencia).

| Comprobación | Resultado y alcance |
|---|---|
| Tipos | `npm run typecheck` aprobado sobre el cierre corregido. |
| Pruebas Node | **269/269**, cero fallos, cancelaciones y omisiones, **138,800 s**. [Log final](../artifacts/node-v5-provision-final.log). |
| Navegador | **14/14 Playwright**, cero fallos y omisiones, **55,9 s**, sobre cliente y backend compilados: escritorio, móvil emulado, acceso, reconexión, órdenes, fauna, genealogía, cosecha, procedimientos y legado. [Log](../artifacts/e2e-v5-provision.log). |
| Compilación aislada | Cliente y servidor en `/tmp/atlas-v5-release`: **31 archivos, 559918 bytes**, de `6d0e53b`. SHA256 del listado ordenado de hashes y rutas: `933f11c77633d78965d3260c9f975f80bcdbecfd8af2b7406d13ebffffd691e8`. Revalidado sin cambios después de E2E. [Manifiesto](../artifacts/build-v5-provision.json). |
| Smoke aislado | Entrypoint compilado, CLI de credencial, HTTP privado, avance autónomo, reinicio tras `SIGKILL`, sesión persistida, revocación y salida ordenada: todos verdaderos. [Resultado del cierre biológico](../artifacts/smoke-v5-provision.json). |

Para E2E se copió temporalmente la suite, sustituyendo solo las rutas de importación por módulos compilados; la lógica y las fuentes del repositorio permanecieron intactas. La cosecha comprobó progreso sin aumento anticipado de reserva, débito real de **0,01** para llenar **0,24 → 0,25**, ausencia de alivio directo del hambre y retorno a autonomía tras una tarea. Node y navegador coincidieron con el experimento largo: sus duraciones no son comparaciones de rendimiento del servidor.

La revisión independiente cerró tres defectos reproducidos: reutilización de ID al retroceder el contador de nacimientos, órdenes de investigar/fabricar omitidas de la lista admitida y un parentesco cuya fecha de nacimiento era posterior a la muerte del progenitor. La comprobación focal final pasó **17/17** pruebas de linaje y persistencia. Una sonda sobre SQLite temporal verificó rollback después de insertar un legado y antes del snapshot, reintento sin pérdida de la cola, lectura de identidad según fecha y recuperación anterior en copia sin modificar el origen.

## Tres días con commit en cada paso

[soak-v5-provision.json](../artifacts/soak-v5-provision.json): semilla **51926**, **7200 pasos**, tres días del modelo, sin navegador ni órdenes. El motor clona un borrador y confirma SQLite en cada paso. Duración **279,228 s**, CPU **252,328 s**, cero fallos; reinicio y copia final iguales al mundo observado. El [registro de ejecución](../artifacts/soak-v5-provision.execution.json) confirma **salida 0**.

| Medida | Resultado |
|---|---|
| Paso completo con commit | p50 **29,245 ms**, p95 **77,545 ms**, máximo **529,650 ms** |
| Memoria y datos | RSS máximo **392,926 MiB**; snapshot máximo **2743036 bytes**; vista máxima **820579 bytes**; base final **41648128 bytes** |
| Población y sociedad | **29 vivos, trece nacimientos, cero muertes humanas**, tres comunidades, 24 de 29 con otros habitantes a siete celdas; 600 cooperaciones: 504 enseñanzas, veinte trueques y 76 ayudas de construcción |
| Recursos recogidos | 10,6865 unidades de alimento, 388,9943 de madera y 235 de piedra del modelo |
| Fauna | 386 nacimientos, 103 muertes, 73 depredaciones, cinco cazas humanas; 373 animales activos al final, máximo observado 410 |
| Consumo animal | 183,1482 unidades de agua y 202,2595 de biomasa del modelo |
| Construcción | Dieciocho ensayos, ocho planos nuevos aceptados, diecinueve edificios de diseños nuevos, 27 estructuras activas; 2,2245 unidades de lluvia captada |
| Tecnología | 188 intentos, 78 fallos, noventa recetas, generación tecnológica máxima diecinueve, 35 productos actuales |
| Uso material | 181 usos de herramientas, utilidad observada 30,4491, 58 reutilizaciones de productos en recibos retenidos, error de masa tecnológica **0** |
| Territorio | 79 regiones descubiertas, 26 asentamientos, máximo 34 regiones y 8704 celdas activas; 128 regiones y 290 revisiones archivadas |

No hubo conflictos, cultivo, reparaciones ni retiros de granero; sí 0,02125 unidades depositadas. Esta trayectoria llegó a segunda generación humana sin muertes; no prueba todavía recambio de vidas ni expulsión de identidades del caché.

La ventana de organización **3782–7200** es incompleta por inventarios iniciales no observados: balance sin verificar, **cero componentes mantenidas acreditadas**, frontera no modelada. El error de masa global igual a cero no reconstruye esos inventarios ni permite sustituir evidencia desconocida por éxito.

Los 28 archivos de aplicación identificados en el artefacto coinciden con el cierre corregido y el experimento largo; se conserva además el hash del script de soak. No mide navegador, doce clientes, máximo de fauna permitido ni varios días reales. El máximo de paso tampoco permite prometer 100 ms constantes. El [soak anterior](../artifacts/soak-v5.json) pertenece a otras reglas de preparación y no se presenta como medición de la versión activa.

## Quince y veinticinco días: continuidad y límites materiales

La observación extendida [evolution-v5-extended.json](../artifacts/evolution-v5-extended.json) completó dos réplicas secuenciales hasta **60000 pasos**, veinticinco días del modelo por semilla, del **21:09:33 al 21:21:36 UTC**. Su [registro de ejecución](../artifacts/evolution-v5-extended.execution.json) confirma **salida 0**. Los **32 hashes de fuentes** coinciden al inicio y al final y con el código **`6d0e53b`**. No hubo gestos, nacimientos forzados, recargas ni cambio de semilla.

Usó mundo mutable, **SQLite cada 120 pasos y muestras cada 1200**: 501 guardados por réplica. Veinticinco días equivalen a cien minutos del modelo, no a veinticinco días reales. La cadencia difiere del servicio, que prepara y confirma cada paso; esta prueba no mide rendimiento de producción ni latencia de commit por paso.

| Resultado a veinticinco días | Semilla 51926 | Semilla 20260905 |
|---|---:|---:|
| Vecinos vivos / población total | **30 / 32** | **13 / 15** |
| Nacimientos / muertes | **51 / 35** | **48 / 49** |
| Vecinos fundadores vivos | **0** | **0** |
| Mayor generación humana observada y viva al cierre | **8** | **8** |
| Primer paso de extinción vecinal | Ninguno | Ninguno |
| Causas de muerte | 33 senescencia, 1 deshidratación, 1 exposición | 30 senescencia, **15 deshidratación**, 4 exposición |
| Recetas / generación tecnológica máxima | **256 / 23** | **256 / 29** |
| Usos de herramientas / beneficio observado del modelo | 1019 / 194,7622 | 340 / 19,3427 |
| Error de masa tecnológica | **0** | **0** |
| Identidades fallecidas archivadas / fuera del caché | **35 / 1** | **49 / 8** |
| Reinicio real en 30000 / carga final / copia iguales | Sí / sí / sí | Sí / sí / sí |

Los vecinos finales pertenecen a generaciones nuevas después de morir todos los fundadores mortales; S e I mantienen su protección externa. Se observa reemplazo generacional dentro de ambas trayectorias, con consecuencias ambientales: **quince muertes por deshidratación en la segunda semilla**. La continuidad observada no elimina esa presión hídrica ni acredita supervivencia indefinida, selección natural aislada o transmisión completa de oficios. Ambos catálogos alcanzaron 256 recetas y ese límite detiene nuevas propuestas.

A diferencia de la observación de quince días, la extensión sí dejó **identidades persistidas fuera del caché**. Se comprobaron los archivos y sus hashes en la copia, con igualdad de mundo al reiniciar, cargar y copiar. El observador acumulado no perdió recibos; sigue siendo instrumentación experimental, distinta del búfer reciente del servicio. Las bases temporales se retiraron después de verificarlas. No se probó caída entre commits de 120 pasos.

Las ventanas de organización a veinticinco días son **26210–60000** y **18217–60000**. La primera permanece incompleta por inventario inicial no observado; la segunda tiene balance verificado. **Ninguna acredita componentes mantenidas.** Un balance de masa global exacto, una ventana equilibrada y una red que repone sus condiciones de funcionamiento son resultados diferentes. La frontera permanece sin modelar y `autopoiesisEstablished` es falso.

La comparación necesaria para evaluar la corrección alimentaria conserva semillas, quince días y ausencia de rescates:

| Resultado a quince días, anterior → corregido | Semilla 51926 | Semilla 20260905 |
|---|---:|---:|
| Vecinos vivos al final | **0 → 11** | **0 → 21** |
| Nacimientos / muertes | 2 / 16 → 23 / 26 | 0 / 14 → 35 / 28 |
| Mayor generación humana observada | 1 → 5 | 0 → 5 |
| Primer paso sin vecinos | 30988 → ninguno | 27227 → ninguno |

La [base anterior](../artifacts/evolution-v5.json) conserva 31 hashes iguales entre inicio y final. La [observación corregida de quince días](../artifacts/evolution-v5-provision.json), del 20:49:17 al 20:58:56 UTC, conserva 32 hashes y comprobó reapertura en 18000, carga final y copia. Sus legados cabían íntegros en el caché y sus dos ventanas materiales eran incompletas. El cambio conjunto de preparación, reserva y acercamiento respalda la mejora observada; no separa la contribución de cada mecanismo. La base anterior tuvo una componente histórica mantenida en una réplica que terminó sin vecinos: ese indicador no sustituye continuidad demográfica ni conocimiento disponible al final.

**La anomalía del primer experimento corregido de quince días permanece abierta:** su JSON figura `completed`, con ambos pasos finales y comprobantes de reinicio y copia, pero el ejecutor informó **143**, de causa indeterminada. El [registro original](../artifacts/evolution-v5-provision.execution.json) conserva la discrepancia; no se atribuye salida limpia a aquel proceso. La salida **0** corresponde exclusivamente al nuevo experimento de veinticinco días.

## Interfaz y rendimiento gráfico

Escena equivalente: **1440 × 900, DPR 1, 4928 celdas, veinte habitantes, mil animales en movimiento, doce estructuras y cien cuadros medidos**. Comparación [anterior](../artifacts/render-v5-before-default-moving.json) → [V5](../artifacts/render-v5-after-default-moving.json):

| Medida | Anterior | V5 |
|---|---:|---:|
| FPS efectivos | 56,07 | 56,86 |
| CPU de dibujo media | 13,217 ms | 13,143 ms |
| CPU de dibujo p95 | 20,2 ms | 18,4 ms |
| Caché gráfica final | 5439488 bytes | 5373952 bytes |

Chromium identificó **SwiftShader**, con alternativa Canvas 2D; no verificó GPU física. Las mediciones pertenecen al renderer sintético y no garantizan 60 FPS de toda la aplicación. Las GPU del servidor no ejecutan la simulación.

Capturas locales del cierre `6d0e53b`: [escritorio](../artifacts/desktop-fullscreen-v5.png), [móvil emulado](../artifacts/mobile-fullscreen-v5.png), [cosecha](../artifacts/forage-before-v5.png), [reserva recibida](../artifacts/forage-after-v5.png), [procedimientos](../artifacts/procedures-v5.png), [legado](../artifacts/legacy-v5.png), [día](../artifacts/daylight-v5.png) y [noche con lluvia](../artifacts/night-rain-v5.png). Se inspeccionaron seis capturas del cierre y sus hashes están en el manifiesto del build. Son pruebas locales, distintas de las capturas privadas de la sección siguiente y de la interfaz candidata nueva. La comparación gráfica anterior no se repitió sobre la cosecha.

## Servicio privado V5 y archivo V4

**V5 se activó el 5 de septiembre a las 21:08:00 UTC**, en **https://172.26.0.4:3443**, con la misma credencial existente verificada. Se inició un mundo nuevo autorizado y se conservaron íntegros el mundo y el build V4 en un directorio privado de corte. El mundo anterior estaba en el paso **58807**, con dieciocho habitantes y dos comunidades. Se verificaron los bytes del build archivado y del instalado. [Registro de activación](../artifacts/cutover-v5.json).

La comprobación de Chromium a las **21:08:14 UTC** recibió protocolo **5** y avance **126 → 136**: dieciséis habitantes, todos con otro a siete celdas, dos comunidades de tres y cinco miembros, diecinueve animales visibles y 84 animales en regiones activas. Todavía no había nacimientos ni cooperación en ese comienzo. Pantalla completa **1440 × 900** desde **0,0**, acceso anónimo **401**, contraseña existente válida, inspección de fauna y **cero errores JavaScript**. El [JSON original del comienzo](../artifacts/live-preview-v5.json) permanece intacto; no se sustituye por datos posteriores.

El [seguimiento de las 21:21:44 UTC](../artifacts/live-preview-v5-followup.json) registró **8170 → 8197**, **31 habitantes**, tres comunidades, acceso anónimo **401**, la misma contraseña válida, **cero gestos y cero errores JavaScript**. Verificó el hash sin cambios del informe original. Las rutas de [mundo](../artifacts/live-world-v5.png), [fauna](../artifacts/live-fauna-v5.png), [comunidades](../artifacts/live-communities-v5.png) y [rendimiento](../artifacts/live-performance-v5.png) contienen ahora capturas de este seguimiento; sus hashes y procedencia están en el informe nuevo.

La inspección registró una franja vacía mientras la cámara esperaba una región: cobertura recibida **76,36% → 100%** en **973 ms**, con las 1785 celdas pedidas presentes también en vistas posteriores. [Espera](../artifacts/live-viewport-pending-v5.png) y [cámara estabilizada](../artifacts/live-viewport-settled-v5.png) pertenecen a esa observación. Fue un hueco transitorio de respuesta en el recorrido inspeccionado; no se modificaron fuentes para corregirlo ni se acredita ausencia del fenómeno en todos los recorridos. Estos son sondeos puntuales del servicio, no varios días reales de operación.

**No fue una migración exitosa del estado V4.** A las 20:28 UTC, una copia SQLite coherente del mundo anterior pasó `quick_check` y verificación de digests, pero tanto su snapshot **36207** como el anterior **36206** contenían **12,8565 unidades de madera** frente a una cota de doce. V5 lo rechazó antes de migrar y el lector del build V4 también rechazó esa copia. Recuperar aquel punto anterior no resuelve el defecto; conservar un archivo íntegro no lo vuelve recargable. La activación conserva materia e historia archivadas sin aplicar un recorte silencioso para validar. [Informe saneado de compatibilidad](../artifacts/migration-v5.json).

Servidor y TLS usan sesiones propias `carta-isa-world` y `carta-isa-https`; su salud fue verificada tras la activación. Cerrar la terminal no las cierra; no se ha acreditado reinicio automático del contenedor. Credenciales, bases y copias permanecen fuera del repositorio y de los prompts externos. El mundo V3 previo también permanece archivado según el [corte V4](../artifacts/cutover-v4.json).

## Archivo, ecología e interfaz verificados

El código de esta publicación anterior fue **`bf6431b`**. El [manifiesto de release](../artifacts/release-next.json) conserva el mismo commit al inicio y final, **53 fuentes de aplicación y 37 archivos compilados, 648569 bytes**, idénticos a `c7796ec`. Solo cambió un fixture E2E; no cambió la aplicación. Integra servidor `c3cf1de`, paisaje `fdbab78` e interfaz `c7796ec`. Reglas y protocolo siguen en 5. SQLite 4 añade origen de cobertura y archivo tecnológico; aquella versión no amplía el catálogo de 256 recetas ni conecta el ayudante de memoria finita al aprendizaje. [CONSTRUCCION](CONSTRUCCION.md#arquitectura-de-autonomía-avances-y-trabajo-pendiente) conserva el estado de los siete frentes.

| Comprobación | Resultado y alcance |
|---|---|
| Aperturas físicas | El cierre previo `61fb27d` pasó **282/282** Node, sin fallos, cancelaciones ni omisiones, **129,459 s**; incluye trece controles nuevos de checkpoint. La revisión independiente cerró la frontera tick/serial. [Log](../artifacts/node-v5-checkpoints.log). |
| Servidor, archivo e índice ecológico | **Typecheck y Node, salida 0: 365/365**, cero fallos, cancelaciones y omisiones, **145,387 s**, sobre `c3cf1de`. Incluye diario pendiente, primitivas de archivo, Store y equivalencia ecológica. [Log global](../artifacts/node-archive-ecology-full.log). Todavía no incluye las nuevas pruebas del paisaje integrado después. |
| Paisaje y selección | **8/8 pruebas focales**, cero fallos u omisiones, **1,214 s**, sobre el candidato integrado. Cubren escala/recursos, estados del suelo, componentes y condición, cuerpo legible, selección opaca y destino geográfico. El estado autoritativo queda igual. [Log](../artifacts/landscape-next-tests.log) e [inspección](../artifacts/landscape-next-state-inspection.json). |
| Interfaz conjunta | **16/16 E2E, 65,427 s**, cero fallos, omisiones o pruebas inestables, usando servidor y cliente compilados del candidato; los dieciséis fixtures usan SQLite 4. [Resultados](../artifacts/interface-next-e2e.json) y [log](../artifacts/interface-next-e2e.log). Incluye navegación, foco, móvil emulado, controles, genealogía persistida y destino geográfico. |
| Compilación | Typecheck, build de cliente y build de servidor terminaron con salida 0. El [manifiesto](../artifacts/release-next.json) identifica fuentes, archivos, hashes y las veintitrés capturas de QA. |
| Rendimiento CPU | Perfiles completos y comparaciones del kernel terminados, con fuentes fijadas y paridad exacta. Mejora condicionada al paso ecológico; no se atribuye la variación de SQLite al kernel. [Resultados y límites](#perfiles-cpu-y-límites-de-aceleración). |
| Smoke compilado | [smoke-next.json](../artifacts/smoke-next.json), **22:34:40 UTC**, fuente `c7796ec`: entrada de servidor compilada y cliente exacto verificados; acceso privado, CLI de credenciales y revocación, avance autónomo, sesión persistida, salida ordenada y recuperación tras `SIGKILL` comprobados. No es una activación privada. |
| Migración en copia | [Sonda real](../artifacts/migration-archive-real.json) completada: SQLite 3→4 sobre respaldo del V5, treinta pasos durables comparados y recarga iguales. El mundo activo y el respaldo original permanecen intactos. Alcance detallado debajo. |
| Activación | Salida 0 y estado `upgraded`, sin reiniciar mundo ni revocar sesiones. La comprobación privada posterior usa el mismo acceso. Detalle en [actualización sin reiniciar el mundo](#actualización-sin-reiniciar-el-mundo). |

El primer intento del E2E integrado tuvo quince pruebas aprobadas y una fallida. El [control causal](../artifacts/interface-next-genealogy-diagnostic-scalars.json) encontró una reserva inicial **0.3** superior al máximo **0.25**; el guardado tras iniciar sesión rechazaba el fixture inválido. Con 0.25, el mismo compilado conserva diecisiete personas, un nacimiento y recarga válida hasta el paso 122. Se corrigió únicamente el fixture y se añadieron validación del estado y comprobación persistida de la genealogía. La suite completa posterior pasó; no se debilitó el validador ni se modificó la aplicación para ocultar el fallo.

Capturas del candidato, **con datos sintéticos y sin representar el servicio privado**: [pantalla completa](../artifacts/interface-next-desktop-fullscreen.png), [estadísticas](../artifacts/interface-next-desktop-stats.png), [tareas en móvil pequeño](../artifacts/interface-next-tasks-small-mobile.png), [genealogía](../artifacts/interface-next-genealogy.png), [comunidades](../artifacts/interface-next-communities.png) y [procedimientos](../artifacts/interface-next-procedures.png). La escena gráfica [anterior](../artifacts/landscape-next-detail-before.png) y [posterior](../artifacts/landscape-next-detail-after.png) conserva el mismo fixture: escala y componentes más legibles, estados de suelo distintos y contraste corporal entre copas. Su manifiesto no acredita teléfono físico, una nueva medición de rendimiento ni GPU del servidor.

El [respaldo previo al archivo tecnológico](../artifacts/backup-before-technology-archive.json), del **22:02:19 UTC**, conserva una copia coherente de **335831040 bytes** del V5 real: paso **31195**, diecisiete habitantes, esquema 3, 256 recetas y 1417 ejecuciones, con 1161 recibos ya descartados del búfer. El lector anterior la valida y el origen permanece intacto.

La [migración real en copia](../artifacts/migration-archive-real.json), del **22:26:04 al 22:26:17 UTC**, comparó la referencia `6d0e53b` con el servidor candidato `c3cf1de`. Completó **treinta pasos durables, sin órdenes**, hasta **31225**, con diecisiete personas: estados físicos exactamente iguales en la comparación y recarga final exacta. La lectura inicial no cambió esquema ni estado físico. La copia migrada usa SQLite 4; **no se abrió la base activa** y el hash del respaldo original permanece igual.

El archivo resultante conserva **256 definiciones, 257 versiones de estadísticas y 257 ejecuciones**. Declara `startsAfter: 1161`, `committedThrough: 1418` y cero pendientes. Ese origen conserva explícitamente el hueco de 1161 recibos anteriores; los 257 archivados no reconstruyen ni certifican las ventanas perdidas. Esta compatibilidad V5/SQLite 3→4 no corrige el V4 inválido ni demuestra continuidad larga del candidato.

Los checkpoints son prospectivos: no cambian recursos, decisiones o azar ni reparan retrospectivamente los intervalos desconocidos. El origen durable acredita desde dónde se preservan recibos; no implica repetición física de la historia, causalidad completa o reposición de herramientas. No hay nuevas réplicas largas del conjunto actualizado.

## Perfiles CPU y límites de aceleración

La [comparación por revisión](../artifacts/performance-v6-20260905-kernel/revision-comparison.json) contrasta `2286b94` —SQLite 4 antes del índice— con `c3cf1de`, en tres escenarios sintéticos de semilla 51926. Ejecuta clonación, motor y guardado reales con `synchronous=FULL`, conservando exactamente el mundo final y las filas tecnológicas. Contra la referencia SQLite 3 `3ada669`, la física coincide al excluir únicamente los metadatos nuevos del diario. Los perfiles finales fueron secuenciales después de terminar las suites, en un host compartido; son muestras cortas, sin navegador ni conexiones. La carga dispersa mueve dieciséis humanos durante su preparación y no representa una población espontánea media. [Método, controles y exclusiones](../artifacts/performance-v6-20260905-pinned/design-review.txt).

| Media de `stepWorld` solo en pasos ecológicos | Sin índice | Con índice | Observaciones por versión |
|---|---:|---:|---:|
| Compacto | 6,18 ms | 5,37 ms | 24 |
| Evolucionado | 8,81 ms | 7,55 ms | 24 |
| Disperso | 38,93 ms | 31,10 ms | 12 |

En los **120 pasos dispersos completos**, el motor promedió **17,71 → 17,34 ms**: la ecología corre cada diez pasos. La transacción total pasó de **124,78 a 88,18 ms**, pero el guardado cambió de **92,42 a 55,77 ms** con el mismo Store y estado durable. Esa variación de I/O domina la diferencia: **no se atribuye una aceleración total del 29 % al kernel** ni coste cero al nuevo archivo. La carga no saturó el catálogo ni produjo más de 256 recibos; el coste máximo del archivo sigue sin medir.

Se realizaron además **1080 comparaciones ecológicas exactas**: tres tamaños, tres frecuencias de reconstrucción y 120 actualizaciones, incluyendo `cloneWorld` y comprobación de coordenadas. En disperso con topología estable, clonación más ecología pasó de **28,96 a 15,85 ms**. Con reconstrucción en cada actualización, evolucionado pasó de **8,24 a 8,30 ms**, sin ahorro discernible; compacto, de **4,30 a 4,25 ms**. Trasladar coordenadas provoca caché fría como control adverso: no representa una migración válida del mundo con todos sus metadatos. El prototipo numérico inicial midió **13,72 → 4,09 ms** por actualización ecológica aislada de 16384 celdas; esos tiempos no se confunden con el motor completo ni con el índice integrado.

El prototipo temporal de escritura en worker comparó ochenta pasos sobre la referencia fija: estado y recarga iguales, **93,32 ms/paso síncrono frente a 175,31 en worker**. Redujo el atraso de un temporizador de diagnóstico, pero no mejoró capacidad de avance; no es una prueba de FPS y no se integró. Un primer perfil con fuentes mutando y otro solapado con la suite fueron excluidos; las repeticiones válidas y sus límites están identificados en el informe.

El control de territorio remoto conservó celdas, hash y edades animales al archivar y reactivar: confirma la política de congelación actual. No se ejecutó un kernel GPU, no se midió aceleración con las dos GPU ni carga sostenida de doce clientes. Estos artefactos llevan un nombre experimental que incluye `v6`; **aquella aplicación medida usaba reglas/protocolo 5**.

## Actualización sin reiniciar el mundo

La [activación](../artifacts/upgrade-next-activation.json) terminó con **salida 0**, estado `upgraded` y fase `verified`. El código `bf6431b` coincide al inicio y al final. La hora **22:54:46.133 UTC** se basa en la fecha de modificación del ledger final verificado, declarada en el artefacto. La comprobación inmediatamente anterior al reemplazo confirmó que no había cambiado el estado durable. Se conservó el paso **61809** al cargar el mundo actualizado; la siguiente observación alcanzó **61851**. SQLite pasó de 3 a 4, con `worldReset: false` y `sessionsRevoked: false`.

El [preflight](../artifacts/upgrade-next-preflight.json) observó **cuatro sesiones** y la activación comprobó su conservación, junto a los mismos archivos privados de acceso. Base SQLite 3, build anterior y script de actualización permanecen en un archivo privado identificado en el artefacto; los hashes del build anterior coinciden antes y después. El build histórico se contrastó con la release retenida; no dispone de un `sourceEnd` histórico verificado, limitación que el registro conserva. No se corrigió materia, repobló el mundo ni cambió la contraseña para completar la actualización.

El script revisado tiene SHA256 `5f6157a007e02a3f5b1967f3983197c0f1d2f58351e28c0055b3225a66b96a4c`. El lease SQLite `world.lock` excluye otra instancia del servidor; **no bloquea los CLI independientes de acceso/almacenamiento ni SQL directo**. Se comprobó puntualmente ausencia de esos procesos y se contrastaron datos durables antes del reemplazo, sin atribuir atomicidad universal a renombrar archivos. Tras intentar arrancar el backend, un fallo debe conservar SQLite 4 y detener solo servicios propios: no restaurar SQLite 3 sobre un mundo que pudo avanzar. [README](../README.md#actualizar-conservando-el-mundo) reúne el límite operativo.

La [sonda privada posterior](../artifacts/live-next.json), del **22:55:33 al 22:55:38 UTC**, comprobó **https://172.26.0.4:3443**, la misma contraseña existente, **401 sin sesión** y protocolo 5. Observó pasos **62367 → 62380**, **32 habitantes y dos comunidades**, con **cero órdenes enviadas y cero errores JavaScript**. La escena ocupa **1440 × 900**; el móvil emulado **390 × 844** no desborda el documento. Son observaciones posteriores, distintas del paso de corte.

Capturas del mundo privado actualizado: [paisaje](../artifacts/live-next-world.png), [habitante](../artifacts/live-next-person.png), [estadísticas](../artifacts/live-next-statistics.png), [comunidades](../artifacts/live-next-communities.png) y [móvil](../artifacts/live-next-mobile.png). La inspección encontró navegación y fichas legibles a pantalla completa. El bosque continúa visualmente muy denso: la mejora de escala y contraste no acredita arte final ni una reducción física de recursos. No se probó un teléfono físico.

## Núcleo corporal compartido en el código

Los commits **`425f8ce` y `a26fb51`** centralizan la fisiología y las acciones corporales en `body.ts`. El segundo conecta movimiento, trabajo, comida, bebida, descanso y alimento de la caza humanos; la fauna usa el mismo núcleo con sus tasas. Conservan las ecuaciones y el orden de cálculo anteriores. No cambian esquema, protocolo, unidades ni la política de regiones archivadas. Están incluidos en la publicación privada `7d8777c`.

La integración pasó **31/31 pruebas focales** de cuerpo y fauna, sin omisiones, y typecheck. Las nueve pruebas de cuerpo incluyen un oráculo de aritmética anterior durante 1200 pasos para humanos, herbívoros y depredadores, además de rutas reales de consumo local, marcha, trabajo y descanso humanos. La [suite Node del árbol de integración](../artifacts/body-shared-integration-node.log) pasó **376/376**, sin fallos ni omisiones, en **111,523 s**; el commit no se fijó al comienzo de esa ejecución, por lo que este resultado no se presenta como gate de una release congelada. El [informe corporal](../artifacts/body-shared-validation.json) separa el baseline de nueve pruebas sobre `a26fb51`, cinco ablaciones detectadas en rutas humanas y una prueba suplementaria aislada para el estrés por privación. Su comparación animal de 2400 pasos conserva estado y eventos exactamente frente a `e171a774`, sin nacimientos en esas escenas.

Compartir las operaciones evita divergencias entre implementaciones corporales. Por sí solo no añade selección nueva, más autonomía, aceleración ni una demostración de mantenimiento material; esas capacidades conservan sus criterios en [GOAL](../GOAL.md).

## Paisaje posterior y base de catálogo

El paisaje **`c5d46aa`**, integrado como **`ade03c9`**, reemplaza la cuadrícula de manchas y cruces por transiciones de suelo basadas en humedad, fertilidad, vegetación y tránsito recibidos. La interpolación utiliza vecinos reales; una celda agotada no recibe cobertura viva de otra, ni una celda sin tránsito dibuja desgaste prestado. Conserva las existencias, los árboles y su escala. El inspector diferencia «Destino actual» autónomo y «Destino de la tarea». [Comparación anterior](../artifacts/material-ground-before.png) y [posterior](../artifacts/material-ground-after.png), con la misma escena y cámara.

Sobre la rama aislada `c5d46aa`, **11/11 pruebas focales**, **16/16 E2E**, typecheck y build pasaron. Los E2E duraron **58,638 s** y usaron datos sintéticos; no certifican una activación del mundo privado ni un teléfono físico. Los controles incluyen invalidación por vecinos, mutaciones de las celdas, agotamiento, evicción, selección y etiquetas. No se ha medido una mejora de rendimiento ni reducido la densidad física del bosque. [Manifiesto del paisaje](../artifacts/material-ground-validation.json).

La base de catálogo de `d9ebdb4` está integrada al Store y al ciclo autónomo de `7d8777c`, publicado junto con este paisaje. Las pruebas de rama anteriores conservan su alcance; la activación y su comprobación real se registran más abajo.

## Catálogo resoluble y memoria local

La versión **`7d8777c`**, posterior a la integración `614b25d`, separa archivo durable, caché de detalles y memoria personal. El Store confirma definiciones, estadísticas, recibos y estado en la misma transacción; libera pendientes después del COMMIT. El contexto no serializable acompaña clones, carga y servidor para resolver instrucciones archivadas. Con Store, 256 limita los detalles residentes y 32 la memoria local por defecto, sin que alcanzar esas cantidades o la generación 32 detenga la asignación de nuevas recetas. El mundo independiente sin archivo conserva sus límites explícitos. Las leyes y el espacio de programas siguen siendo finitos; quitar estos frenos no demuestra evolución abierta.

La validación fijada a este commit pasó **443/443 pruebas Node**, sin fallos ni omisiones, en **102,748 s**, además de typecheck y compilación aislada. Pasaron también **16/16 E2E en 55,6 s** con cliente y servidor compilados; únicamente se redirigieron las importaciones del harness aislado al servidor compilado para compartir el mismo contexto del mundo. El smoke del ejecutable verificó acceso privado, avance autónomo, reinicio tras `SIGKILL`, sesión conservada, revocación y salida limpia en datos temporales. Las 59 fuentes comprobadas permanecieron iguales; el build contiene **39 archivos, 699823 bytes**. [Manifiesto](../artifacts/catalogue-release.json), [Node](../artifacts/catalogue-release-node.log), [navegador](../artifacts/catalogue-release-e2e.log) y [smoke](../artifacts/catalogue-release-smoke.json). Ese mismo build se publicó con el mundo nuevo documentado abajo. Entre los controles integrados:

| Control | Resultado y alcance |
|---|---|
| Archivo mayor que la memoria | Un laboratorio suministrado completa **257 programas pagados**, con caché y memoria de dos entradas, commits periódicos, recargas y sesión sintética conservada. Las instrucciones elegidas comparten función: no son 257 usos materiales nuevos. |
| Genealogía material | **40 generaciones pagadas** consumen el producto real anterior y resuelven ancestros fríos; el stock original de piedra aporta 2000 unidades de masa. El laboratorio repone energía y condiciones de trabajo, por lo que no acredita autonomía. |
| Aprendizaje y pérdida | La resolución del archivo no concede instrucciones, práctica ni autoría. Se conservan referencias conocidas fuera de caché, enseñanza local y redescubrimiento con costes; prácticas sin soporte se retiran conforme a la memoria finita. |
| Fallos y recuperación | Revocación, entrada duplicada, autor inválido, prefijo incompleto, estadísticas falsas y rollback no producen confirmaciones parciales. Un fallo de caché posterior al COMMIT no convierte un guardado durable en un falso fracaso. La recuperación anterior rechaza metadatos pendientes falsificados. |
| Historia verificable | Se recorren definiciones y estadísticas para comprobar genealogía, autores, secuencia y cobertura. Los certificados se invalidan ante escrituras externas, cambios de esquema y rollback; el resumen JS usa un bitmap fijo y contadores, aunque SQLite puede necesitar memoria o disco temporal para ordenar. |

Gemini 3.1 Pro (High), mediante la ruta Gemini disponible, propuso dos contraejemplos en una revisión estática. Se reprodujo la admisión de una receta con programa distinto y etiqueta «función nueva» falsa: [reproducción anterior](../artifacts/catalogue-novelty-reproduction.json). Los guards de registro y archivo ahora contrastan esa etiqueta con las funciones previas, incluso fuera de caché y con un digest recalculado. Las tres regresiones del archivo fallaron antes del arreglo; el [control de registro](../artifacts/catalogue-register-negative-control.json) también detecta el defecto sobre `614b25d`. La etiqueta histórica `function` sólo se admite cuando corresponde a una primera aparición.

La otra sugerencia —dos cambios de estadísticas confirmados por separado en el mismo tick— no resultó alcanzable en el flujo actual: el servidor acumula las acciones de un paso y guarda una vez; reinicio y autenticación no vuelven a modificar sus estadísticas. Una revisión nativa y ocho pruebas del servidor comprobaron esos límites. Se mantiene la inmutabilidad histórica; invocar manualmente APIs internas fuera de ese contrato sigue pudiendo provocar un rechazo. Estas revisiones no son una garantía exhaustiva.

Una continuación autónoma de **600 pasos**, sobre una copia cerrada del mundo real, pasó de **61809 a 62409**, de **256 a 262 programas** y de generación máxima **23 a 24**. Completó diez ensayos, seis exitosos y cuatro fallidos, y 22 recibos nuevos con 293 unidades de trabajo. No recibió órdenes, recursos ni programas del observador. Guardó cada paso y recuperó exactamente el mundo en los pasos 62109 y 62409. La [ejecución de `614b25d`](../artifacts/catalogue-autonomy-614.json) y la [repetición con los guards de `7d8777c`](../artifacts/catalogue-autonomy-7d8777c.json) tienen iguales descubrimientos, catálogos, balances, muestras y resúmenes de recibos: [paridad](../artifacts/catalogue-autonomy-parity.json). No se compararon individualmente todos los cuerpos de recibos entre ambos commits.

La diversidad funcional permaneció en **48**. Hubo nueve usos y dos beneficios positivos, sin atribuirlos a los seis programas nuevos. Los 32 habitantes sobrevivieron esa ventana sin nacimientos; no es una prueba demográfica larga ni de recambio autosostenido. El paso inicial conservó materia, identidades y proyectos; activar la memoria finita retiró **79 instrucciones, 71 entradas de práctica y cuatro recuerdos de enseñanza**. Por tanto, no se promete identidad con el comportamiento anterior al olvido. Se conservaron los cuatro registros de sesión por conteo, sin probar su autenticación en esta copia. Fuentes y respaldo original quedaron intactos. El [script](../artifacts/catalogue-autonomy-script.mjs) fija fuente, archivo cerrado y límites; las duraciones aceleradas no miden la latencia del servicio privado.

La interfaz integrada en `17b6c88` distingue descubrimientos globales, detalles recibidos e instrucciones recordadas por cada habitante. Puede mostrar una identidad conocida cuyo detalle está fuera de caché, y actualiza el inspector cuando sólo cambia la memoria; poseer un objeto no concede su procedimiento. [Memoria](../artifacts/catalog-ui-memory.png), [detalle parcial](../artifacts/catalog-ui-partial.png) y [controles focales](../artifacts/catalog-ui-validation.json). Las once pruebas y capturas de esa rama no acreditan teléfono físico ni activación del servicio.

## Publicación con mundo nuevo

El **6 de septiembre, a las 01:46:49.719 UTC**, se publicó `7d8777c` en **https://172.26.0.4:3443**, siguiendo la [política de nuevas versiones de pruebas](../README.md#nuevas-versiones-de-pruebas). El mundo preparado fue exactamente `createWorld(51926)` guardado y recargado por su Store: **paso cero, dieciséis habitantes, cero recetas y ningún registro heredado de sesiones, órdenes o archivos**. Conserva los recuerdos sintéticos, recursos y evento inicial normales del generador. El arranque añade su evento habitual de pausa de preparación; no importa historia anterior. Antes de abrir TLS se comprobó avance **0 → 6**. [Registro de publicación](../artifacts/catalogue-fresh-activation.json).

El mundo anterior quedó en **156383**, con **32 habitantes, 256 recetas, cinco sesiones y seis entradas**. Se verificaron todas sus tablas y su estado contra una copia cerrada; el archivo conserva además la base original y el build correspondiente. La base nueva usa otro archivo. Contraseña, credencial, certificado, clave TLS y archivo de lock conservaron contenido e identidad. Las sesiones anteriores quedaron en su archivo y no se trasladaron: para volver a entrar se usa la misma contraseña.

La primera operación se detuvo **antes de reemplazar la base o arrancar el backend**, con salida **1**. El checkpoint de SQLite desde otra conexión incrementó `data_version` sin cambiar las filas, lo que produjo un falso positivo en el control inicial. La comparación independiente de todas las tablas confirmó que el mundo seguía exactamente igual al respaldo. Se reprodujo el comportamiento en SQLite temporal y se corrigió el control para comparar mundo y tablas completas, recalibrando el contador después del checkpoint propio y rechazando escrituras externas reales. [Interrupción y comprobación](../artifacts/catalogue-fresh-interruption.json).

La continuación explícita del **mismo** registro terminó con salida **0**. Reutilizó el mundo preparado, el respaldo y los builds; conservó el fallo original dentro del registro y no volvió a preparar otro mundo. La revisión GPT-6 y **19/19 controles sintéticos** aprobaron la continuación acotada. Un intento de arrancar el backend impide restaurar una base antigua o bajar el build. Una [comprobación posterior](../artifacts/catalogue-fresh-noop.json) reconoció la publicación existente sin reiniciar su mundo. [Controles](../artifacts/catalogue-fresh-resume-controls.json) y [procedimiento exacto](../artifacts/catalogue-fresh-operation.mjs). Es un procedimiento fijado a esta publicación, no un CLI general; no simula una caída física del sistema operativo ni excluye escritores SQL externos mediante el lease del servidor.

Chromium comprobó el servicio entre **01:47:08.730 y 01:47:11.277 UTC**: contraseña existente válida, **401 sin sesión**, **cero órdenes y cero errores JavaScript**. Los dos clientes observaron **199 → 220** y **206 → 220**, con dieciséis habitantes y dos comunidades. Coincidieron en tres pasos compartidos, incluyendo estado de habitantes y tecnología, mientras una cámara viajaba a terreno distante y la otra permanecía en el inicio. Pantalla completa sin desbordes en **1440 × 900** y **390 × 844**; se cerraron ambas sesiones de prueba. [Resultado](../artifacts/catalogue-fresh-browser.json), [escritorio](../artifacts/catalogue-fresh-desktop.png) y [móvil emulado](../artifacts/catalogue-fresh-mobile.png).

Se inspeccionaron las dos capturas: la interfaz ocupa toda la pantalla y los controles son legibles, pero el bosque continúa demasiado denso y oculta gran parte del suelo. Esta publicación no acredita una reducción física de árboles, un teléfono real, supervivencia prolongada del mundo nuevo ni uso de GPU del servidor.

## Transporte de agua V6 integrado

La rama aislada `feature/contained-water-integrated`, fuente **`eefbbe2`**, conecta contenido líquido, preparación autónoma y su inspector. Pasaron **496/496 Node**, **17/17 E2E con cliente y servidor compilados**, typecheck y build; fuentes y compilados conservaron sus hashes al terminar. La revisión GPT-6 independiente del planificador pasó nueve pruebas focales y dos controles adicionales: continuidad exacta en ocho puntos de guardado durante el llenado y una fuente parcial sin doble cobro. No revisó su propia implementación de interfaz ni repitió las observaciones largas. [Validación integrada](../artifacts/water-v6-integrated-evidence.json), [manifiesto](../artifacts/water-v6-integrated-manifest.json) y [revisión](../artifacts/water-v6-planning-review.json).

Tres semillas durante **7200 pasos cada una**, sin órdenes ni objetos o programas suministrados, produjeron 55 objetos con capacidad suficiente, trece llenados y tres consumos portátiles. El balance agregado en cuantos fue **10468 llenados = 2619 consumidos + 7208 perdidos + 641 contenidos**; hubo 793 acciones de trabajo y 0,2661716 de energía gastada. Los consumos se observaron lejos de la fuente, hasta dieciséis celdas; el baseline tuvo cero llenados y consumos portátiles. Las pérdidas incluyen fugas y derrames, por lo que el resultado no demuestra una mejora ecológica general ni mayor supervivencia. El inspector distingue contenido, capacidad y fuga prevista; se observaron preparación, progreso y contenido real en móvil emulado. [Experimento y límites](../artifacts/water-v6-autonomy-evidence.json), [baseline](../artifacts/water-v6-autonomy-baseline.json) y [candidato](../artifacts/water-v6-autonomy-candidate.json).

La integración en la línea principal **`95ff0d2`** conserva iguales los **120 archivos de fuentes, pruebas y configuración** comparados con `eefbbe2`; las diferencias pertenecen a documentación y al cambio preexistente de `.gitignore`. No se repitieron las suites por una fusión que conserva exactamente esos archivos. Los **39 archivos del build activo** permanecieron idénticos a V5 `7d8777c`; integrar fuentes no reemplazó el build ni el mundo. [Comprobación de integración](../artifacts/water-v6-main-integration.json).

**V6 está integrado y no publicado:** la instancia privada sigue siendo V5 `7d8777c`. [REGLAS](REGLAS.md#agua-contenida-y-preparación-autónoma), [CONSTRUCCION](CONSTRUCCION.md#contrato-v6-de-agua-contenida) y [EXPERIENCIA](EXPERIENCIA.md#participación-de-isa) definen contrato, persistencia y lectura del inspector. La próxima publicación de pruebas comenzará un mundo nuevo según la política vigente.

El smoke compilado posterior de `eefbbe2` comprobó acceso, avance, reinicio tras `SIGKILL`, sesión conservada, revocación y salida limpia, con datos temporales. Sus 42 archivos compilados conservaron los hashes. [Resultado](../artifacts/water-v6-compiled-smoke.json).

## Claros físicos y lectura del paisaje

`7fff2f3`, integrado en la línea principal, cambia la génesis de madera y su representación. En **36864 celdas, nueve regiones y tres semillas**, solo difieren madera y feature; los demás campos iniciales coinciden exactamente. La ventana forestal inicial de semilla 51926 pasa de **4096 a 917 celdas con madera**, y de **39543 a 8808 unidades**. La cobertura opaca del árbol completo, incluyendo tronco, pasa de **79,31 a 24,42 %** en escritorio y de **79,92 a 27,11 %** en móvil, a igual cámara y escala. Es una medida raster, sin equivalencia a cobertura botánica real. [Manifiesto y doce capturas](../artifacts/forest-validation.json).

Pasaron **503/503 Node**, **17/17 E2E compilados**, typecheck y build sobre el commit fijado. La primera pasada concurrente tuvo 15/17 con dos capturas sin conexión; los dos escenarios pasaron después y la suite completa serial pasó sin modificar fuente o fixtures. No se aisló una única causa para los rojos. La revisión independiente pasó seis controles focales, conservó exactamente 1536 celdas antiguas tras inicialización y SQLite —1220 con madera fuera de las nuevas parcelas— y comparó 1024 celdas en los límites técnicos. Todavía faltan observaciones largas de autonomía con esta disponibilidad menor de madera y publicación privada.

## Identidad del mundo y regreso del navegador

`8565624`, integrado en la línea principal, distingue ejecuciones aunque tengan la misma semilla y origen. La comprobación focal final pasó **5/5** y la del servidor anterior al último guard **23/23**. Pasaron typecheck, build, smoke del entrypoint compilado y **18/18 E2E con cliente compilado y servidor TypeScript de la misma fuente**. El escenario nuevo conserva acceso y visita tras reiniciar la base y vuelve a presentar la carta después de crear otra, incluso si esta ya supera el paso visitado. [Informe](../artifacts/world-instance-validation.json) y [navegador final](../artifacts/world-instance-e2e-final.log).

La primera suite concurrente pasó 17/18 y falló un resultado de caza mientras la captura mostraba reconexión. Se conservó ese [log](../artifacts/world-instance-e2e.log); la repetición serial no cambió el fixture ni corrigió la aplicación para ocultar ese fallo. La revisión independiente sí detectó otro defecto reproducible: el arranque rotaba el checkpoint anterior antes de rechazar una identidad malformada. El guard final rechaza antes de escribir y conserva exactamente las once tablas del control. No se atribuye aún una ejecución de suite completa a la combinación final de todas las ramas ni se ha publicado esta capacidad.

## Comparación física de CPU y ambas GPU

El benchmark **`ee073d4`**, con física fijada a `95ff0d2`, utilizó el Ryzen 9 9950X3D y CUDA real en **RTX 5070 Ti de 16 GiB y RTX 2060 de 6 GiB**. Comparó seis tamaños, de 256 a un millón de celdas, durante ocho actualizaciones consecutivas por tamaño: referencia Node, arrays locales, cuatro y ocho workers, GPU 0, GPU 1 y ambas. Los 336 registros de ejecución incluyen **288 comparaciones de alternativas con igualdad exacta Float64** frente a la referencia. FMA quedó desactivado. El driver y NVRTC 12.9.86 temporales, con hashes, están en los [artefactos](../artifacts/compute-ecology-20260906/result.json).

| Celdas | Node | Cuatro workers | Ocho workers | RTX 5070 Ti | RTX 2060 | Ambas GPU |
|---:|---:|---:|---:|---:|---:|---:|
| 256 | 0,195 ms | 0,286 ms | 0,252 ms | 0,471 ms | 0,446 ms | 0,589 ms |
| 4096 | 0,435 ms | 0,457 ms | 1,302 ms | 1,865 ms | 1,430 ms | 1,951 ms |
| 1000000 | 412,168 ms | 355,033 ms | 408,459 ms | 1137,219 ms | 1264,783 ms | 1309,059 ms |

Son medianas de siete invocaciones posteriores a la primera: incluyen clonación de celdas, comprobación de coordenadas, conversiones, ejecución, transferencias y ensamblado. Arranque, generación y topología inicial se registran aparte. El intervalo de kernel de la RTX 5070 Ti fue 0,466 ms para un millón de celdas; ese intervalo aislado no representa el coste de obtener un mundo actualizado. La variación de clonación y GC impide atribuir la ventaja aparente de workers grandes al paralelismo. No se incluyeron cuerpos, actualización base de recursos, mundo completo, proyección ni SQLite, y el host no fue exclusivo. [Fases y límites](../artifacts/compute-ecology-20260906/analysis.json). **Se conserva el kernel CPU actual; no se integra este puente CUDA en el runtime.**

La revisión independiente recalculó 42 resúmenes y cerró dos fallos del harness: ausencia de Python que no terminaba el cierre, y escritura bloqueada a un hijo que quedaba fuera del timeout. El código final **`a4fd0a1`** limita envío y respuesta juntos y escala el cierre solo del proceso propio; pasó **9/9 pruebas con ambas GPU, sin skips**, además de typecheck. Los controles incluyen hijos sin lectura que ignoran SIGTERM, cierre repetido y Python ausente. La física y el código CUDA no cambiaron; la matriz de tiempos no se repitió y sigue atribuida a `ee073d4`. [Validación final](../artifacts/compute-ecology-20260906/final-validation.json) y [pruebas](../artifacts/compute-ecology-20260906/tests-final.tap). Sin `COMPUTE_NVRTC`, los tres controles CUDA indican explícitamente que no verificaron paridad GPU.

## Trabajo y pruebas pendientes

La comparación alimentaria, el soak con commit por paso y la extensión a veinticinco días están completados dentro de sus alcances anteriores. La publicación privada `7d8777c` amplía el catálogo y conecta memoria local; faltan observaciones largas y multisemilla con esa memoria, recambio de herramientas y mantenimiento material reciente. El servicio y el código integrado mantienen ecología lejana congelada; el benchmark CUDA comprobado no forma parte de la simulación del servidor. El transporte de agua contenido está integrado y validado en la línea principal V6, todavía sin publicar.

No se han probado teléfono físico, Safari/iOS, lector de pantalla, varios días reales, doce clientes bajo carga sostenida, miles de habitantes, fallo físico de disco ni cálculo ecológico en GPU. La voz final y los recuerdos reales siguen pendientes. No se acreditan conciencia, autopoiesis biológica, efecto Baldwin ni evolución abierta.

Los comandos reproducibles y la política de artefactos están en [README](../README.md#desarrollo-y-comprobaciones). Los JSON y capturas conservan el detalle; las cifras interpretadas permanecen aquí. Las revisiones anteriores se consultan en Git.
