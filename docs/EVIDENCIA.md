# Evidencia vigente

Fecha de corte: **5 de septiembre de 2026**. El servicio privado continúa en **V4**. El candidato **V5 está en corrección / sin validar autonomía prolongada**: sus pruebas de integración pasan, pero las dos réplicas de quince días pierden todos los vecinos. No se ha activado V5 ni se ha acreditado migración de la base privada actual.

Este documento conserva resultados y límites; [REGLAS](REGLAS.md) define mecanismos, [CIENCIA](CIENCIA.md) su interpretación y [CONSTRUCCION](CONSTRUCCION.md#siguiente-arquitectura-propuesta-no-implementada) el trabajo futuro. Git conserva los cierres anteriores, sin documentos históricos paralelos.

## Candidato V5: alcance de la verificación

Base de código `28aa399`, interfaz `52703f3`, corrección de copia CLI `723572b` y observador multisemilla `51371ff`. Las modificaciones posteriores de alimento y preparación familiar están fuera de estos resultados; requieren repetir los controles y la observación autónoma.

| Comprobación | Resultado y alcance |
|---|---|
| Tipos | Aprobados durante el cierre de integración; no acredita cambios posteriores. |
| Pruebas Node | **252/252**, cero fallos y omisiones, **96,393 s**. [Log](../artifacts/node-v5.log). |
| Copia CLI | **1/1** adicional: conserva esquema anterior y bytes del origen. Es posterior a la suite de 252, no otra suite global de 253. [Log](../artifacts/backup-cli-v5.log). |
| Navegador | **13 pruebas Playwright aprobadas**, según el cierre de integración: escritorio y móvil emulado, órdenes, fauna, procedimientos y legado. Capturas indicadas abajo; no equivalen a teléfono físico. |
| Compilación aislada | Cliente y servidor compilados en `/tmp/atlas-v5-release`, preservando el build del servicio V4. [Cliente](../artifacts/build-v5-client.log), [servidor](../artifacts/build-v5-server.log). |
| Smoke aislado | Entrypoint compilado, CLI de credencial, HTTP privado, avance autónomo, reinicio tras `SIGKILL`, sesión persistida, revocación y salida ordenada: todos verdaderos. [Resultado](../artifacts/smoke-v5.json). |

La revisión independiente cerró tres defectos reproducidos: reutilización de ID al retroceder el contador de nacimientos, órdenes de investigar/fabricar omitidas de la lista admitida y un parentesco cuya fecha de nacimiento era posterior a la muerte del progenitor. La comprobación focal final pasó **17/17** pruebas de linaje y persistencia. Una sonda sobre SQLite temporal verificó rollback después de insertar un legado y antes del snapshot, reintento sin pérdida de la cola, lectura de identidad según fecha y recuperación anterior en copia sin modificar el origen.

## Tres días con commit en cada paso

[soak-v5.json](../artifacts/soak-v5.json): semilla **51926**, **7200 pasos**, tres días del modelo, sin navegador ni órdenes. El motor clona un borrador y confirma SQLite en cada paso. Duración **243,11 s**, CPU **229,96 s**, cero fallos; reinicio y copia final iguales al mundo observado.

| Medida | Resultado |
|---|---|
| Paso completo con commit | p50 **27,967 ms**, p95 **64,893 ms**, máximo **639,429 ms** |
| Memoria y datos | RSS máximo **410,91 MiB**; snapshot máximo 2368821 bytes; vista máxima 1047040 bytes; base final 38219776 bytes |
| Población y sociedad | 18 vivos, dos nacimientos, cero muertes humanas, tres comunidades; 491 cooperaciones: 414 enseñanzas, 32 trueques y 45 ayudas de construcción |
| Fauna | 310 nacimientos, 159 muertes, 113 depredaciones, dos cazas humanas; 200 animales activos al final, máximo observado 401 |
| Consumo animal | 140,99 unidades de agua y 161,90 de biomasa del modelo |
| Construcción | 17 ensayos, siete planos aceptados, nueve edificios de diseños nuevos, 17 estructuras activas; 1,4589 unidades de lluvia captada |
| Tecnología | 254 intentos, 66 fallos, 139 recetas, generación tecnológica máxima 13, 65 productos actuales |
| Uso material | 156 usos de herramientas, utilidad observada 27,2289, 101 reutilizaciones de productos en recibos retenidos, error de masa tecnológica **0** |
| Territorio | 84 regiones descubiertas, catorce asentamientos, máximo 26 regiones y 6656 celdas activas; 142 regiones y 275 revisiones archivadas |

No hubo conflictos, cultivo, reparaciones ni depósitos/retiros de granero en esta trayectoria. Enseñanzas y recetas no demuestran transmisión entre varias generaciones; aquí solo nacieron dos vecinos.

La ventana de organización **3785–7200** es incompleta: cuatro actores con existencias no tienen recibo que acredite su inventario inicial. El informe incluye `incomplete-window`, `unobserved-opening-stock` y `unverified-material-balance`: balance sin verificar, **cero componentes mantenidas acreditadas**, frontera no modelada. El error de masa global igual a cero no reconstruye esos inventarios ni permite sustituir evidencia desconocida por éxito.

Los 28 hashes de fuentes del artefacto coinciden con el código `28aa399`; las fuentes comunes también coinciden con las del experimento largo siguiente. No mide navegador, doce clientes, máximo de fauna permitido ni varios días reales; su máximo de paso tampoco permite prometer 100 ms constantes.

## Quince días: resultado negativo de continuidad generacional

[evolution-v5.json](../artifacts/evolution-v5.json) ejecutó secuencialmente dos semillas hasta **36000 pasos** cada una, del 20:24:24 al 20:28:56 UTC. No hubo gestos, nacimientos forzados, recargas ni cambio de semilla. Conserva **31 hashes iguales al inicio y al final**; esa igualdad no prueba ausencia de cambios transitorios entre las dos lecturas.

Esta prueba usa mundo mutable y **SQLite cada 120 pasos**, con muestra cada 1200; realizó 301 guardados por réplica. No mide la latencia de commit por paso del servicio. Los sesenta minutos simulados por réplica tampoco son quince días de operación real.

| Resultado final | Semilla 51926 | Semilla 20260905 |
|---|---:|---:|
| Vecinos vivos / población total | **0 / 2** | **0 / 2** |
| Primer paso sin vecinos | **30988** | **27227** |
| Nacimientos / muertes | 2 / 16 | 0 / 14 |
| Causas de muerte | 15 senescencia, 1 exposición | 12 senescencia, 2 exposición |
| Mayor generación humana observada | 1 | 0 |
| Recetas / generación tecnológica | 256 / 18 | 57 / 14 |
| Fabricaciones exitosas observadas durante la réplica | 104 | 25 |
| Procesos exitosos que consumieron productos previos | 234 | 45 |
| Error de masa tecnológica | 0 | 0 |
| Tiempo real de ejecución | 159,03 s | 113,09 s |
| RSS máximo muestreado | 311,13 MiB | 319,82 MiB |
| Identidades fallecidas archivadas | 16 | 14 |

**Solo sobreviven S e I mediante su protección externa. El reemplazo generacional autónomo falla en ambas semillas.** En la primera, el catálogo llega a 256 recetas y su límite detiene nuevas propuestas. Las dos conservaron inventos y usos útiles; ninguno de esos contadores evita la extinción.

Los indicadores de organización tienen alcances distintos. La semilla 51926 acaba con ventana **18112–36000** incompleta y sin componentes mantenidas acreditadas. La semilla 20260905 tiene ventana **12483–36000** con balance verificado, una componente mantenida durante ese intervalo y dos recursos catalíticos con recambio completo. Esa ventana incluye actividad histórica de actores ya fallecidos; **no acredita una red todavía operativa al final**, ni reproducción humana, ni autopoiesis. Su coexistencia con la extinción demuestra por qué un indicador favorable de mantenimiento no basta como criterio de éxito.

El observador acumulado del experimento no perdió recibos y no detectó pares de transferencias incompletos. Es instrumentación de esta ejecución; el servicio sigue limitado a sus 256 recibos recientes. Las dos réplicas comprobaron igualdad al reabrir en el paso 18000, carga final y copia. Ninguna observó expulsión de identidades del caché: todas las vidas archivadas cabían en él. No se probó caída entre commits del experimento ni se aisló selección genética de deriva, mortalidad o efecto fundador.

## Interfaz y rendimiento gráfico del candidato

Escena equivalente: **1440 × 900, DPR 1, 4928 celdas, veinte habitantes, mil animales en movimiento, doce estructuras y cien cuadros medidos**. Comparación [anterior](../artifacts/render-v5-before-default-moving.json) → [V5](../artifacts/render-v5-after-default-moving.json):

| Medida | Anterior | V5 |
|---|---:|---:|
| FPS efectivos | 56,07 | 56,86 |
| CPU de dibujo media | 13,217 ms | 13,143 ms |
| CPU de dibujo p95 | 20,2 ms | 18,4 ms |
| Caché gráfica final | 5439488 bytes | 5373952 bytes |

Chromium identificó **SwiftShader**, con alternativa Canvas 2D; no verificó GPU física. Las mediciones pertenecen al renderer sintético y no garantizan 60 FPS de toda la aplicación. Las GPU del servidor no ejecutan la simulación.

Capturas locales del candidato: [escritorio](../artifacts/desktop-fullscreen-v5.png), [móvil emulado](../artifacts/mobile-fullscreen-v5.png), [procedimientos](../artifacts/procedures-v5.png), [legado](../artifacts/legacy-v5.png), [día](../artifacts/daylight-v5.png) y [noche con lluvia](../artifacts/night-rain-v5.png). No son capturas de una activación privada V5.

## Servicio privado V4 y compatibilidad pendiente

El último servicio activado sigue siendo **V4**, en **https://172.26.0.4:3443**, con el acceso existente. Su activación registrada fue el **5 de septiembre, 19:26:45 UTC**; el mundo V3 anterior y su build se conservaron íntegros en un directorio privado de corte. V4 empezó un mundo nuevo de semilla 51926, conforme al reinicio autorizado. [Registro de activación](../artifacts/cutover-v4.json).

La verificación de ese servicio comprobó acceso privado, avance **775 → 782**, dieciocho habitantes, dos comunidades y cero errores JavaScript. Es una observación de aquel momento, no un sondeo nuevo de este cierre documental. [Resultado](../artifacts/live-preview-v4.json), [captura](../artifacts/live-world-v4.png). El soak V4 permanece como [artefacto separado](../artifacts/soak-v4.json); sus resultados y la migración V3→V4 no acreditan V4→V5.

A las **20:28 UTC** se obtuvo una copia SQLite privada coherente, mediante lectura sin escritura del servicio V4, en el paso **36207**. SQLite pasó `quick_check` y se verificaron los digests de ambos snapshots. La validación con V5 encontró un descendiente con **12,8565 unidades de madera**, por encima de la cota 12, tanto en el estado actual como en el anterior **36206**: recuperar ese punto anterior tampoco resuelve el exceso. Se rechazó antes de migrar. [Informe saneado](../artifacts/migration-v5.json).

**No hubo migración exitosa, activación V5 ni cambio del mundo privado V4.** La compatibilidad con fixtures válidos y la corrección del CLI no resuelven este caso real. Deben conservarse materia, historia y copia íntegra; no se aplica un recorte silencioso para pasar la validación. Un comienzo nuevo autorizado con mundo y build anteriores archivados sería una operación distinta de migrar, y aún no ocurrió.

Servidor y TLS usan sesiones propias `carta-isa-world` y `carta-isa-https`. Cerrar la terminal no las cierra; no se ha acreditado reinicio automático del contenedor. Credenciales, bases y copias permanecen fuera del repositorio y de los prompts externos.

## Correcciones y pruebas pendientes

Se integraron cosecha física de comida, preparación familiar con pareja conocida y cuerpo apto, reserva protegida con excepción por hambre urgente y acercamiento para la comprobación de nacimiento. La condición de misma comunidad se mantiene para aislar la causa. Las constantes están en [REGLAS](REGLAS.md#cuerpos-elecciones-y-vínculo); **estos cambios todavía no acreditan mejora demográfica**.

La suite posterior a esa integración pasó **267/267**, cero fallos y omisiones, en **137,9875 s**. [Log](../artifacts/node-v5-provision.log). La interfaz `a89353e` pasó una prueba E2E focal de orden y reserva visible; es adicional al navegador de la base anterior. Después se unificó la confianza mutua, se acotó la percepción de lugares y se añadió reunión caminando en un lugar visible para ambos: fuentes congeladas en **`6d0e53b`**, tipos aprobados y siete pruebas focales de cosecha/reunión aprobadas. No se atribuyen estos últimos cambios a la suite de 267. La suite global final y las réplicas corregidas están en ejecución al corte; sus tiempos coinciden y no servirán como comparación de rendimiento.

El siguiente cierre exige repetir las pruebas afectadas y las réplicas autónomas con las mismas semillas, sin rescates ni reinicios de conveniencia. Debe distinguir permanencia de vecinos, reemplazo generacional, transmisión aprendida, saturación de catálogo, mantenimiento material reciente y coste de persistencia. Conservar los resultados negativos y comparar hashes impide atribuir al código corregido mediciones de la base anterior.

No se han probado teléfono físico, Safari/iOS, lector de pantalla, varios días reales, doce clientes bajo carga sostenida, miles de habitantes, fallo físico de disco ni cálculo ecológico en GPU. La voz final y los recuerdos reales siguen pendientes. No se acreditan conciencia, autopoiesis biológica, efecto Baldwin ni evolución abierta.

Los comandos reproducibles y la política de artefactos están en [README](../README.md#desarrollo-y-comprobaciones). Los JSON y capturas conservan el detalle; las cifras interpretadas permanecen aquí. Las revisiones anteriores se consultan en Git.
