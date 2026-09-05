# Evidencia vigente

Fecha de corte: **5 de septiembre de 2026, 21:08 UTC**. **V5 está activo en la revisión privada**, con mundo nuevo y acceso conservado; el V4 inválido quedó archivado íntegro. Dos réplicas corregidas de quince días conservaron once y veintiún vecinos al final. Es evidencia acotada, no continuidad indefinida; ambas redes tecnológicas conservan límites de catálogo y de observación. La activación no constituye una migración exitosa del estado V4.

Este documento conserva resultados y límites; [REGLAS](REGLAS.md) define mecanismos, [CIENCIA](CIENCIA.md) su interpretación y [CONSTRUCCION](CONSTRUCCION.md#siguiente-arquitectura-propuesta-no-implementada) el trabajo futuro. Git conserva los cierres anteriores, sin documentos históricos paralelos.

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

## Quince días: reemplazo generacional observado y límites

[evolution-v5-provision.json](../artifacts/evolution-v5-provision.json) registra dos réplicas secuenciales hasta **36000 pasos** cada una, del **20:49:17 al 20:58:56 UTC**. Conserva **32 hashes iguales al inicio y al final** y `sourceUnchanged: true`; esa igualdad no prueba ausencia de cambios transitorios entre las lecturas. No hubo gestos, nacimientos forzados, recargas ni cambio de semilla. Ambas alcanzaron el final sin un paso de extinción vecinal.

El experimento usa **mundo mutable, SQLite cada 120 pasos y muestras cada 1200**: 301 guardados por réplica. Sus quince días equivalen a sesenta minutos del modelo, no a quince días reales. La cadencia difiere del servicio, que prepara y confirma cada paso; **esta prueba no mide rendimiento de producción ni latencia de commit por paso**.

| Resultado final | Semilla 51926 | Semilla 20260905 |
|---|---:|---:|
| Vecinos vivos / población total | **11 / 13** | **21 / 23** |
| Nacimientos / muertes | **23 / 26** | **35 / 28** |
| Vecinos fundadores vivos | **0** | **0** |
| Mayor generación humana observada y viva al cierre | **5** | **5** |
| Causas de muerte | 24 senescencia, 1 deshidratación, 1 exposición | 24 senescencia, 4 exposición |
| Máxima población muestreada | 32 | 32 |
| Recetas / generación tecnológica máxima | **256 / 23** | **256 / 29** |
| Fabricaciones exitosas observadas durante la réplica | 74 | 78 |
| Procesos exitosos que consumieron productos previos | 205 | 215 |
| Usos de herramientas / beneficio observado del modelo | 917 / 173,9548 | 310 / 9,1150 |
| Error de masa tecnológica | **0** | **0** |
| Identidades fallecidas archivadas | 26 | 28 |

Los vecinos finales pertenecen a generaciones nuevas después de morir todos los fundadores mortales; S e I siguen separados por su protección externa. Esto acredita reemplazo generacional **dentro de estas dos ventanas**, sin demostrar autosostenimiento indefinido, selección natural aislada, transmisión completa de oficios ni autopoiesis. El máximo de 32 vivos sigue vigente. Ambos catálogos alcanzaron las 256 recetas y ese límite sigue deteniendo propuestas nuevas.

La comparación conserva las mismas semillas, duración y ausencia de rescates. La base anterior [evolution-v5.json](../artifacts/evolution-v5.json), con 31 hashes iguales al inicio y al final, perdió todos los vecinos. El cambio conjunto de preparación, reserva y acercamiento respalda una mejora del conjunto de reglas; no separa la contribución de cada mecanismo.

| Comparación anterior → corregida | Semilla 51926 | Semilla 20260905 |
|---|---:|---:|
| Vecinos vivos al final | **0 → 11** | **0 → 21** |
| Nacimientos / muertes | 2 / 16 → 23 / 26 | 0 / 14 → 35 / 28 |
| Mayor generación humana observada | 1 → 5 | 0 → 5 |
| Primer paso sin vecinos | 30988 → ninguno | 27227 → ninguno |

Las ventanas materiales finales corregidas son **22074–36000** y **17482–36000**, ambas incompletas por inventarios iniciales no observados. El balance de ventana sigue sin verificar y hay **cero componentes mantenidas acreditadas** en ambas. El balance tecnológico global de masa igual a cero no reconstruye esos inventarios. La base anterior tuvo una componente histórica mantenida en una réplica que acabó sin vecinos: un indicador de red favorable no sustituye continuidad demográfica ni disponibilidad actual del conocimiento. La frontera sigue sin modelarse y `autopoiesisEstablished` es falso.

El observador acumulado no perdió recibos ni detectó pares de transferencias incompletos; el servicio conserva solo sus 256 recibos recientes. Ambas réplicas verificaron igualdad al reabrir en **18000**, carga final y copia. Los legados cabían íntegros en el caché: no se observó expulsión de identidades. Las bases del experimento eran temporales y se retiraron después de verificarlas. No se probó una caída entre los commits de 120 pasos.

**Anomalía de ejecución:** el JSON quedó `completed`, contiene ambos pasos finales y el log tiene el pie de finalización; los reinicios y copias anteriores están verificados. Sin embargo, el ejecutor informó **código 143**. La causa es indeterminada y **no se registra como salida limpia del proceso**. El [registro de ejecución](../artifacts/evolution-v5-provision.execution.json) conserva esta discrepancia; no se oculta ni invalida por sí sola los comprobantes guardados.

## Interfaz y rendimiento gráfico

Escena equivalente: **1440 × 900, DPR 1, 4928 celdas, veinte habitantes, mil animales en movimiento, doce estructuras y cien cuadros medidos**. Comparación [anterior](../artifacts/render-v5-before-default-moving.json) → [V5](../artifacts/render-v5-after-default-moving.json):

| Medida | Anterior | V5 |
|---|---:|---:|
| FPS efectivos | 56,07 | 56,86 |
| CPU de dibujo media | 13,217 ms | 13,143 ms |
| CPU de dibujo p95 | 20,2 ms | 18,4 ms |
| Caché gráfica final | 5439488 bytes | 5373952 bytes |

Chromium identificó **SwiftShader**, con alternativa Canvas 2D; no verificó GPU física. Las mediciones pertenecen al renderer sintético y no garantizan 60 FPS de toda la aplicación. Las GPU del servidor no ejecutan la simulación.

Capturas locales actualizadas por la suite del candidato: [escritorio](../artifacts/desktop-fullscreen-v5.png), [móvil emulado](../artifacts/mobile-fullscreen-v5.png), [cosecha](../artifacts/forage-before-v5.png), [reserva recibida](../artifacts/forage-after-v5.png), [procedimientos](../artifacts/procedures-v5.png), [legado](../artifacts/legacy-v5.png), [día](../artifacts/daylight-v5.png) y [noche con lluvia](../artifacts/night-rain-v5.png). Se inspeccionaron seis capturas del cierre y sus hashes están en el manifiesto del build. No son capturas de una activación privada V5; la comparación gráfica anterior no se repitió sobre la cosecha.

## Servicio privado V5 y archivo V4

**V5 se activó el 5 de septiembre a las 21:08:00 UTC**, en **https://172.26.0.4:3443**, con la misma credencial existente verificada. Se inició un mundo nuevo autorizado y se conservaron íntegros el mundo y el build V4 en un directorio privado de corte. El mundo anterior estaba en el paso **58807**, con dieciocho habitantes y dos comunidades. Se verificaron los bytes del build archivado y del instalado. [Registro de activación](../artifacts/cutover-v5.json).

La comprobación de Chromium a las **21:08:14 UTC** recibió protocolo **5** y avance **126 → 136**: dieciséis habitantes, todos con otro a siete celdas, dos comunidades de tres y cinco miembros, diecinueve animales visibles y 84 animales en regiones activas. Todavía no había nacimientos ni cooperación en ese comienzo. Pantalla completa **1440 × 900** desde **0,0**, acceso anónimo **401**, contraseña existente válida, inspección de fauna y **cero errores JavaScript**. [Resultado en vivo](../artifacts/live-preview-v5.json), [mundo](../artifacts/live-world-v5.png), [fauna](../artifacts/live-fauna-v5.png), [comunidades](../artifacts/live-communities-v5.png). Es una observación del comienzo, no prueba de varios días reales ni de población estable.

**No fue una migración exitosa del estado V4.** A las 20:28 UTC, una copia SQLite coherente del mundo anterior pasó `quick_check` y verificación de digests, pero tanto su snapshot **36207** como el anterior **36206** contenían **12,8565 unidades de madera** frente a una cota de doce. V5 lo rechazó antes de migrar y el lector del build V4 también rechazó esa copia. Recuperar aquel punto anterior no resuelve el defecto; conservar un archivo íntegro no lo vuelve recargable. La activación conserva materia e historia archivadas sin aplicar un recorte silencioso para validar. [Informe saneado de compatibilidad](../artifacts/migration-v5.json).

Servidor y TLS usan sesiones propias `carta-isa-world` y `carta-isa-https`; su salud fue verificada tras la activación. Cerrar la terminal no las cierra; no se ha acreditado reinicio automático del contenedor. Credenciales, bases y copias permanecen fuera del repositorio y de los prompts externos. El mundo V3 previo también permanece archivado según el [corte V4](../artifacts/cutover-v4.json).

## Trabajo y pruebas pendientes

La comparación alimentaria, el soak con commit por paso y la activación privada están completados dentro de sus alcances. Una extensión a **veinticinco días con dos semillas** está en ejecución hacia `artifacts/evolution-v5-extended.json`, **sin resultado acreditado al corte**; las fuentes de aplicación permanecen congeladas en `6d0e53b` durante esa observación. Quedan ampliar continuidad, transmisión aprendida, recambio de herramientas y mantenimiento material reciente. Los cambios de archivo e inventarios de apertura siguen fuera de V5 activo: hay un ensayo aislado en `/tmp/atlas-opening-checkpoints`, sin integrar en main. Los siete frentes se mantienen en CONSTRUCCION; el resto conserva estado de propuesta.

No se han probado teléfono físico, Safari/iOS, lector de pantalla, varios días reales, doce clientes bajo carga sostenida, miles de habitantes, fallo físico de disco ni cálculo ecológico en GPU. La voz final y los recuerdos reales siguen pendientes. No se acreditan conciencia, autopoiesis biológica, efecto Baldwin ni evolución abierta.

Los comandos reproducibles y la política de artefactos están en [README](../README.md#desarrollo-y-comprobaciones). Los JSON y capturas conservan el detalle; las cifras interpretadas permanecen aquí. Las revisiones anteriores se consultan en Git.
