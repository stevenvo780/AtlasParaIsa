# Evidencia vigente

Fecha de corte: **5 de septiembre de 2026**. El servicio privado ejecuta **V5 `6d0e53b`, SQLite 3**, con mundo nuevo y acceso conservado; el V4 inválido quedó archivado íntegro. Dos réplicas de veinticinco días conservaron vecinos de octava generación, sin extinción vecinal. Persisten saturación tecnológica y mantenimiento material sin acreditar. **MAIN `c7796ec`, SQLite 4, es candidato sin desplegar**: archivo, aperturas e índice ecológico de `c3cf1de`, más paisaje e interfaz renovados. Conserva reglas/protocolo 5. Las réplicas largas no incluyen estos cambios. La activación inicial V5 no fue una migración exitosa del estado V4.

Este documento conserva resultados y límites frente al [objetivo rector](../GOAL.md); [REGLAS](REGLAS.md) define mecanismos, [CIENCIA](CIENCIA.md) su interpretación y [CONSTRUCCION](CONSTRUCCION.md#arquitectura-de-autonomía-avances-y-trabajo-pendiente) el estado de arquitectura y trabajo pendiente. Git conserva los cierres anteriores, sin documentos históricos paralelos.

## V5 activo: alcance de la verificación

Cierre de código **`6d0e53b`**, con interfaz de cosecha y reserva `a89353e`. Integra cosecha física de alimento, preparación con pareja conocida y apta, protección de la reserva con excepción por hambre urgente y acercamiento mediante percepción local y confianza mutua. Las condiciones y costes están en [REGLAS](REGLAS.md#herencia-práctica-y-descendencia).

| Comprobación | Resultado y alcance |
|---|---|
| Tipos | `npm run typecheck` aprobado sobre el cierre corregido. |
| Pruebas Node | **269/269**, cero fallos, cancelaciones y omisiones, **138,800 s**. [Log final](../artifacts/node-v5-provision-final.log). |
| Navegador | **14/14 Playwright**, cero fallos y omisiones, **55,9 s**, sobre cliente y backend compilados: escritorio, móvil emulado, acceso, reconexión, órdenes, fauna, genealogía, cosecha, procedimientos y legado. [Log](../artifacts/e2e-v5-provision.log). |
| Compilación aislada | Cliente y servidor en `/tmp/atlas-v5-release`: **31 archivos, 559918 bytes**, de `6d0e53b`. SHA256 del listado ordenado de hashes y rutas: `933f11c77633d78965d3260c9f975f80bcdbecfd8af2b7406d13ebffffd691e8`. Revalidado sin cambios después de E2E. [Manifiesto](../artifacts/build-v5-provision.json). |
| Smoke aislado | Entrypoint compilado, CLI de credencial, HTTP privado, avance autónomo, reinicio tras `SIGKILL`, sesión persistida, revocación y salida ordenada: todos verdaderos. [Resultado actual](../artifacts/smoke-v5-provision.json). |

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

## Candidato de archivo, ecología e interfaz

MAIN **`c7796ec` no está desplegado**. Integra servidor `c3cf1de`, paisaje `fdbab78` e interfaz `c7796ec`; los dos últimos provienen de `be76477` y `756ac0e` en worktree aislado. Reglas y protocolo siguen en 5. El esquema SQLite 4 registra origen de cobertura y archivo tecnológico; no amplía el catálogo de 256 recetas ni conecta aún el ayudante de memoria finita al aprendizaje. [CONSTRUCCION](CONSTRUCCION.md#arquitectura-de-autonomía-avances-y-trabajo-pendiente) conserva el estado de los siete frentes.

| Comprobación | Resultado y alcance |
|---|---|
| Aperturas físicas | El cierre previo `61fb27d` pasó **282/282** Node, sin fallos, cancelaciones ni omisiones, **129,459 s**; incluye trece controles nuevos de checkpoint. La revisión independiente cerró la frontera tick/serial. [Log](../artifacts/node-v5-checkpoints.log). |
| Servidor, archivo e índice ecológico | **Typecheck y Node, salida 0: 365/365**, cero fallos, cancelaciones y omisiones, **145,387 s**, sobre `c3cf1de`. Incluye diario pendiente, primitivas de archivo, Store y equivalencia ecológica. [Log global](../artifacts/node-archive-ecology-full.log). Todavía no incluye las nuevas pruebas del paisaje integrado después. |
| Paisaje y selección | **8/8 pruebas focales**, incluidas dos nuevas, y typecheck en la rama aislada. Cubren escala/recursos, estados del suelo, componentes y condición, cuerpo legible, selección opaca y destino geográfico. No cambia el estado autoritativo. |
| Interfaz conjunta | **16/16 E2E, 59,1 s**, en worktree con las fuentes finales de interfaz y paisaje. **La suite del build exacto integrado sigue pendiente de cierre.** El control de genealogía identificó un fixture con reserva 0.3 frente al máximo 0.25: el guardado tras iniciar sesión rechazaba ese estado. Con 0.25, el mismo compilado conserva diecisiete personas y un nacimiento y valida guardado y recarga hasta el paso 122. La corrección corresponde al fixture y no debilita el validador; falta repetir el conjunto de dieciséis pruebas. |
| Rendimiento ecológico completo | Pendiente de una ventana de medición aislada; equivalencia y uso de un índice no prueban mejora de tiempo. |
| Smoke compilado | [smoke-next.json](../artifacts/smoke-next.json), **22:34:40 UTC**, fuente `c7796ec`: entrada de servidor compilada y cliente exacto verificados; acceso privado, CLI de credenciales y revocación, avance autónomo, sesión persistida, salida ordenada y recuperación tras `SIGKILL` comprobados. No es una activación privada. |
| Migración en copia | [Sonda real](../artifacts/migration-archive-real.json) completada: SQLite 3→4 sobre respaldo del V5, treinta pasos durables comparados y recarga iguales. El mundo activo y el respaldo original permanecen intactos. Alcance detallado debajo. |
| Despliegue | Pendiente; el servicio conserva `6d0e53b` y SQLite 3. Smoke y compatibilidad en copia no cierran por sí solos QA ni autorizan atribuir una activación. |

El [respaldo previo al archivo tecnológico](../artifacts/backup-before-technology-archive.json), del **22:02:19 UTC**, conserva una copia coherente de **335831040 bytes** del V5 real: paso **31195**, diecisiete habitantes, esquema 3, 256 recetas y 1417 ejecuciones, con 1161 recibos ya descartados del búfer. El lector anterior la valida y el origen permanece intacto.

La [migración real en copia](../artifacts/migration-archive-real.json), del **22:26:04 al 22:26:17 UTC**, comparó la referencia `6d0e53b` con el servidor candidato `c3cf1de`. Completó **treinta pasos durables, sin órdenes**, hasta **31225**, con diecisiete personas: estados físicos exactamente iguales en la comparación y recarga final exacta. La lectura inicial no cambió esquema ni estado físico. La copia migrada usa SQLite 4; **no se abrió la base activa** y el hash del respaldo original permanece igual.

El archivo resultante conserva **256 definiciones, 257 versiones de estadísticas y 257 ejecuciones**. Declara `startsAfter: 1161`, `committedThrough: 1418` y cero pendientes. Ese origen conserva explícitamente el hueco de 1161 recibos anteriores; los 257 archivados no reconstruyen ni certifican las ventanas perdidas. Esta compatibilidad V5/SQLite 3→4 no corrige el V4 inválido ni demuestra continuidad larga del candidato.

Los checkpoints son prospectivos: no cambian recursos, decisiones o azar ni reparan retrospectivamente los intervalos desconocidos. El origen durable acredita desde dónde se preservan recibos; no implica repetición física de la historia, causalidad completa o reposición de herramientas. No hay nuevas réplicas largas del conjunto candidato.

## Trabajo y pruebas pendientes

La comparación alimentaria, el soak con commit por paso, la extensión a veinticinco días y la activación `6d0e53b` están completados dentro de sus alcances. Quedan continuidad fuera de esas trayectorias, transmisión aprendida, recambio de herramientas y mantenimiento material reciente; el candidato de archivo no resuelve esas propiedades por estar guardado.

No se han probado teléfono físico, Safari/iOS, lector de pantalla, varios días reales, doce clientes bajo carga sostenida, miles de habitantes, fallo físico de disco ni cálculo ecológico en GPU. La voz final y los recuerdos reales siguen pendientes. No se acreditan conciencia, autopoiesis biológica, efecto Baldwin ni evolución abierta.

Los comandos reproducibles y la política de artefactos están en [README](../README.md#desarrollo-y-comprobaciones). Los JSON y capturas conservan el detalle; las cifras interpretadas permanecen aquí. Las revisiones anteriores se consultan en Git.
