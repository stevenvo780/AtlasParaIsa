# T024 — protocolo de experiencia C23

Estado: **PLAN SINTÉTICO; no ejecutado; revisión independiente pendiente**. Autoría por asignación explícita: Sol high, cuenta secundaria; cuota no verificada, sin cambio de cuenta ni delegación. Base de código `bb483260b2489fe62b113d620e5f56e5f3676dbc`. Propiedad de este autor limitada a este archivo y [method-protocol.md](method-protocol.md). T024 permanece sin marcar.

Fecha de preparación documental: `2026-10-03T23:02:24-05:00` (`2026-10-04T04:02:24Z`). Es fecha de redacción, no de sesión, aceptación, reserva ni ejecución.

## Autoridad y evidencia disponible

Rigen [GOAL](../../GOAL.md), la [constitución](../../.specify/memory/constitution.md), [REGLAS](../../docs/REGLAS.md), [EXPERIENCIA](../../docs/EXPERIENCIA.md), [EVIDENCIA](../../docs/EVIDENCIA.md), el [canon C23](../../docs/CRITERIOS-REALISMO.md#c23--b15--carta-agencia-y-experiencia), [tasks T024](tasks.md) y el [contrato v3](contracts/README.md). C1–C8 y la tendencia C8 siguen congelados. Los números nuevos C9–C24 son candidatos del [perfil provisional](contracts/thresholds.v3.json), no aceptación científica ni canon nuevo. Este protocolo no los recalibra.

La decisión externa `/datos/tmp-atlas-lab/orquestacion-20261003/revision-criterios/ROOT-G0-DECISION-v3.md`, SHA256 `658605e0d5f52d626def8169cf0e39f3d6477dbbbcb7c0573e7f85a0137b410c`, libera **G0 contractual** después de peer y formal v3. El original archivado conserva 87 pins y un control en `R1-FROZEN-v3-MANIFEST.json`, SHA256 `faaac25fb0ace210103eb5a19f12b4be8a0fac009b4635a6bb9a9a880714ef54`; no se regenera para incluir estos protocolos. Los avisos NO-GO anteriores en documentos congelados son históricos respecto de esa decisión. G1 aún no está acreditado PASS en esta entrega; redactar después de G0 no habilita ejecución ni demuestra implementación.

No se encontró `AGENTS.md` en las rutas ancestrales comprobadas ni en la feature; se consultó la guía existente `CLAUDE.md`. Main y HEAD coinciden en la base indicada; `docs/CRITERIOS-REALISMO.md` pertenece a esta feature y aún no existe en main. Se inspeccionó código como fuente, sin ejecutarlo ni abrir datos privados.

| Fuente local de esta redacción | SHA256 de bytes leídos |
|---|---|
| GOAL.md | `0d22ec39ca1088afca917a6043027c0482aa7381d8dc295ca45e8cd6cbf4d06d` |
| .specify/memory/constitution.md | `e9aeee368c44fb706b6bb55221a9568ba1dd031252993ca68c207bf6c3d3cda0` |
| docs/CRITERIOS-REALISMO.md | `9f863c563b67d488af38a5653d7c381b33f02a3c4b8148722ec82981f79624ca` |
| contracts/thresholds.v3.json | `d99e24ee85f379164c1dd0d351a0cdb204d8bf1dda0e446abd70cfe582e4b7cb` |
| contracts/README.md | `1975f0ce79d7651eb359affb8a67c89a059f9acf7a5d6479c389a82a2e2bcce5` |
| src/client/game.ts | `7708695a85c131d754dd11ffa1f420d0c208cffb89a9c53f3d240e41e46f65fc` |
| src/client/world-shell.ts | `009026c067043895eba96d041191ff3db05e12a7d20a01d4d382592e8a960c20` |
| docs/EXPERIENCIA.md | `27dd8d0874b27524b1c88c854d5d504ad0403b9147136208460c50b8a8b59718` |

Estos hashes identifican fuentes de diseño; no son `contentHash` de la carta ni recibos de Steven. Un preregistro futuro deberá fijar también todos los módulos transitivos de interfaz, física, render y datos de escena utilizados.

## Separación de sesiones y contenido

**Sesión técnica sintética:** operadores/revisores prueban tareas, accesibilidad y causalidad con contenido ficticio rotulado y manifiesto sin datos íntimos. Una persona revisora técnica puede reportar observaciones; `technical-reviewer` y `synthetic-oracle` nunca conceden autorización personal. Una maqueta puede ensayar controles, pero no acredita causalidad de World, continuidad o consumo.

**Sesión personal real:** sólo Steven revisa texto de carta, S/I, lugares significativos, recuerdos reales y voz. Los modelos no generan, reescriben ni sustituyen texto personal; no se adjuntan conversaciones ni se extrae biografía al laboratorio. La sesión y sus artefactos privados quedan locales y fuera de entradas de LLM. Un operador de confianza puede custodiar metadata y constatar el acto humano; no decidir, firmar ni simular una aceptación por Steven.

Esta entrega sólo diseña la primera sesión y el procedimiento de recibo de la segunda. No usa contraseña pública, credenciales, datos de producción ni servicios de carta/recuerdos. Una futura ejecución necesita un laboratorio nuevo, propio y aislado con contenido exclusivamente sintético y autenticación propia según las reglas existentes, sin modificar auth pública. No copiar estados privados para convertirlos en fixtures.

## Fuente de las tareas y capacidades ausentes

Las rutas se eligieron después de inspeccionar [world-shell.ts](../../src/client/world-shell.ts), [game.ts](../../src/client/game.ts), [inspector-view.ts](../../src/client/inspector-view.ts), [technology-art.ts](../../src/client/technology-art.ts), [linaje-view.ts](../../src/client/linaje-view.ts), [cronica.ts](../../src/client/cronica.ts), [visit-memory.ts](../../src/client/visit-memory.ts), [landscape.ts](../../src/client/landscape.ts) y [types.ts](../../src/shared/types.ts). El diseño se vincula a los frentes de GOAL: agencia, continuidad, territorio, herencia/saber, procesos materiales e interfaz.

`game.ts` distingue entrar en modo Dirigir de emitir una orden: salir de ese modo con Escape no prueba que el servidor retiró una orden vigente. La tarea de autonomía usa `[data-order="auto"]` y exige estado/recibo fuente. `visit-memory.ts` resume visitas del cliente; no prueba continuidad durable del backend. `inspector-view.ts` distingue reserva de cisterna y usos acumulados de ocupación, y repertorio recordado de objeto transportado. Esos textos son hipótesis de legibilidad, no garantía de ledger completo.

En las rutas cliente/tipos inspeccionadas no se encontró chat conversacional implementado. La crónica no se declara chat. La tarea de chat queda prevista como brecha GOAL/alcance solicitado, **UNKNOWN/MISSING_CAPABILITY**, con futura definición de producto pendiente; no se inventa conversación ni se incorpora proveedor LLM. El proyecto visible es un plano/blueprint, separado del procedimiento técnico y de su ejecución material.

## Laboratorio, escenas y entradas a congelar antes de ejecutar

El integrador/revisor fijará un manifiesto `synthetic=true` con sourceSHA y hashes de módulos, build, escena inicial completa, params resueltos, seed técnica aún sin seleccionar, RNG por subsistema, reloj/época, traza de entradas y gobernador, backend gráfico, cámara, contenido ficticio, IDs y coordenadas. Los alias siguientes son requisitos de escena, **no objetos afirmados como existentes**: `human-A`, `human-B`, `animal-A`, `resource-A`, `structure-A`, `recipe-A`, `blueprint-A`, `cause-event-A`, `parent-A`, `child-A`, tres contextos de memoria y un encuentro. Resolver cada alias contra el manifiesto antes de sellar. Si falta un elemento, mantener la tarea planeada UNKNOWN; no escoger otro después de ver un resultado favorable.

Ese manifiesto de diseño y los fixtures conservan `synthetic=true`. Contenido ficticio y evidencia fabricada son dimensiones distintas: una futura sesión puede usar escenas ficticias y producir datos observados de World/runtime. Sólo un operador con procedencia verificable puede identificar esos nuevos artefactos de ejecución como evidencia observada, `synthetic=false` conforme al contrato, manteniendo el contenido de prueba rotulado. No convertir fixtures/expected en evidencia empírica cambiándoles un flag. Cualquier fixture `synthetic=true` permanece oráculo técnico, sin PASS científico ni recibo personal real.

Cada acción del guion registra orden ordinal, objetivo ID/coordenadas, método teclado/táctil/puntero, input exacto, tick de envío, ACK/rechazo y tick fuente de efecto. Cámaras y paneles son entradas de cliente; no avanzan física. La reproducibilidad de una trayectoria exige mismos inputs físicos y gobernador al mismo tick, además de misma semilla/estado. Una secuencia de clicks en tiempo real sin ticks registrados no garantiza replay determinista.

Dos capas de evidencia futuras: (a) capturas/guion sintéticos verifican comprensión y manejo; (b) World y runtime del laboratorio deberán producir estados, eventos y recibos reales del motor con contenido sintético para probar causa/consumo/continuidad. Una imagen, contador de UI o mock no sustituye (b). Ninguna se ha obtenido aquí. Fuente ausente, ventana histórica cortada o dato no expuesto se reporta UNKNOWN, sin inventar fisiología, causalidad ni rendimiento.

## Dispositivos y cobertura prevista

| ID planeado | Sesión física | Registro requerido y estado actual |
|---|---|---|
| D-F | Desktop Fedora, teclado y puntero | CPU/RAM/GPU/pantalla/OS/navegador/versiones/DPR/modo/acceso local; disponibles sólo como contexto declarado, ejecución UNKNOWN |
| D-T | Desktop torre, teclado y puntero | Mismos campos y carga contemporánea, backend gráfico verificado; ejecución UNKNOWN |
| D-M | Teléfono físico, si se consigue y verifica | Modelo/OS/navegador, pantalla, orientación, tacto, DPR y recibo del operador de dispositivo real; disponibilidad UNKNOWN |

Los tres dispositivos permanecen en el denominador previsto; un teléfono no disponible se registra UNKNOWN, no se elimina. Emulación móvil complementaria no ocupa D-M ni concede PASS de teléfono. Plan: al menos 30 minutos reales por dispositivo y todas las tareas siguientes; 30 minutos, mínimo 10 tareas, 3 pares de memoria, 1 de encuentro y 0 bloqueos críticos son tamaños **PROVISIONAL**, heredados del diseño C23, aún sin validación empírica. No se fijan ahora nuevos mínimos numéricos de FPS ni cuotas de éxito personal.

Antes de cada sesión registrar viewport CSS real, resolución, zoom, tamaño de texto, navegador, orientación y modo normal/ligero. Repetir tareas de lectura/control con ampliación de texto y teclado; registrar foco, orden Tab, nombres accesibles, navegación de pestañas, retorno del foco al cerrar, visibilidad del destino y del ACK. Rotar teléfono y abrir paneles con teclado virtual; medir oclusión del canvas, recorte y scroll. Un bloqueo crítico impide completar una tarea esencial, recuperar foco/control o leer un dato causal requerido; reportar evidencia y juicio humano técnico. La ausencia de bloqueo sólo se acredita tras tareas cubiertas.

## Guion manual por dispositivo

Todas las filas están **planeadas/UNKNOWN**. Registrar resultados por fila y dispositivo, incluidos fallos, abortos y no disponibles. No rellenar el resultado esperado como resultado observado.

| ID | Acción e input que fijará el manifiesto | Ruta/control real | Evidencia y refutación |
|---|---|---|---|
| E01 | Recorrer cámara a `resource-A`, variar zoom y regresar al origen | `#landscape`, `#tile-form`, `#zoom-in`, `#zoom-out`, `#map-reset`; landscape | Cámara/viewport antes y después, tick común; moverse no crea stock ni altera tiempo físico |
| E02 | Buscar y seleccionar `human-A`, seguirlo y cancelar seguimiento | `#population-toggle`, `#population-search`, `#follow-toggle` | Selección, desplazamiento de cámara y estado de seguimiento; seguir no dirige |
| E03 | Activar Dirigir y enviar movimiento a celda admisible fijada | `#direct-toggle`, canvas WASD desktop/objetivo táctil, game | Orden/ACK y trayectoria fuente con coste; intención sin ACK no es ejecución |
| E04 | Pulsar Autonomía después de E03; usar Escape sólo como comparación UI | `[data-order="auto"]`, controlMode y person-controls | ACK y orden retirada, nuevas decisiones autónomas; Escape sólo local no basta |
| E05 | Inspeccionar `animal-A` y causa local de su acción | Población pestaña fauna, inspector; life-art | ID/especie/estado recibido, acción y alcance; campo faltante se declara desconocido |
| E06 | Inspeccionar `resource-A`, capa agua y humedad | `#observation-layer`, inspector de casilla | Distinguir agua potable/suelo/biomasa y existencias finitas; no inferir agua de cisterna |
| E07 | Leer `structure-A`, reserva/condición y uso histórico | structureCard en inspector-view | Contrastar stock, débito/servicio y beneficio con recibos; cisterna vacía y uses>0 no implican agua ni ocupación |
| E08 | Abrir `recipe-A` y su ejecución/materiales | `[data-recipe]`, technologyPane/recipeCard, game conexión a demanda | Entrada/producto/coste y detalle fuente; procedimiento conocido no equivale a objeto poseído |
| E09 | Leer parentesco de `child-A` y buscar `parent-A` | Historia, inheritedAndLearned, linaje-view | ID/edad/generación/origen; separar edad modelada de nacimiento observado y huecos de historia |
| E10 | Abrir crónica y causa de `cause-event-A` | `#chronicle-button`, cronica, world-evidence | Acción/evento/causa y ventana; episodio ausente no reconstruido desde un total |
| E11 | Comparar genes, habilidades y repertorio de `human-A` | Ahora/Equipo/Historia, inheritedAndLearned | Herencia vs práctica/enseñanza; repertorio a demanda desconocido no se convierte en lista vacía |
| E12 | Elegir memoria sample fijada, usar gesto Recordar y leer efecto | `[data-gesture="remember"]`, `#memory-select`, `#gesture-send` | Sample explícito, ACK/contexto/evento; recordar no fuerza compañía ni escena |
| E13 | Leer `blueprint-A`, autor, ascendencia, coste y obra vinculada | Cuaderno de proyectos, blueprintCard; game | Plano distinto de receta y de función probada; ventana de proyectos recientes no inventario completo |
| E14 | Abrir paneles Vida/Territorio/Comunidades/Tecnología/Rendimiento y capas | stats-drawer/data-stats, game/charts/gobernador-view | Causa, unidad, ventana, datos ausentes; FPS navegador distinto de paso servidor y ocupación GPU |
| E15 | Salir del visor local y volver durante ventana prefijada sin órdenes de rescate | connection, visit-memory, resumen de regreso | Runtime global entre visitas/época y hechos reales sintéticos; resumen cliente solo no acredita mundo autónomo |
| E16 | Revisar disponibilidad de chat y sus causas/alcance | Sin control localizado en las rutas inspeccionadas | UNKNOWN/MISSING_CAPABILITY; conservar brecha, no usar crónica ni texto inventado como chat |

Secuencia temporal propuesta para ≥30 minutos, fijada antes de datos: minutos 0–5 identificación/viewport/exploración; 5–10 seguir/dirigir/autonomía; 10–20 inspectores/genes/saber/memoria/proyectos; 20–25 crónica/capas/paneles y captura de rendimiento; 25–30 retorno/accesibilidad/chat y cierre. Si hay demora, extender y registrar duración real; no declarar todas las tareas completas por cumplir el tiempo. El intervalo sin visor de E15 debe fijarse con ticks y runtime antes de empezar; su resultado no sustituye continuidad biológica de 60/100 días.

Capturas futuras exclusivamente sintéticas: inicio/viewport, estado Dirigir+ACK, Autonomía+ACK, cisterna vacía, procedimiento/proyecto, parentesco/causa, memoria rotulada, panel de rendimiento, vista móvil normal/ligera y regreso. Cada captura tiene ID, SHA256, dispositivo, tarea, instante RFC3339 con zona, tick/época, sourceSHA y autor operador. El ledger escrito distingue observado, missing y not-applicable justificado; capturas no prueban por sí solas campos fuera de vista. No capturar sesión íntima ni mandar mensajes externos.

## Pares sintéticos de agencia y encuentro

Fuente de mecanismo: [src/world/index.ts](../../src/world/index.ts), memories de inicio y puntuación contextual de `choose()`. Tres pares a diseñar sobre copias iguales de una escena de laboratorio antes de outcomes: M1 `partner-tired`/accompany (`sample-accompany`); M2 `shelter-tired`/rest (`sample-rest`); M3 `food-hungry`/eat (`sample-harvest`). Control irrelevante disponible `sample-distant`, contexto `irrelevant`. Un cuarto contexto opcional `rain-shelter` no reemplaza un par fallido. Los parámetros fisiológicos son los del SHA, no valores de una persona real.

En cada par, fijar estado/entradas/clock/RNG idénticos salvo el único recuerdo intervenido; conservar peso/roles/ubicación según contraste aprobado y documentar exactamente qué campo cambia. No comparar simplemente dos memorias con pesos/acciones distintos y atribuirlo a pertinencia. Exigir roles, lugar y umbrales de relevancia de la fuente, candidatos alcanzables y oportunidad real de elección; escoger esa escena antes de correr, sin optimizar después para obtener una acción favorable. El diseño definitivo de estado y diferencias mínimas necesita revisión técnica.

Capturar motivo, candidatos/puntuación si expuestos, acción elegida, evento fuente y efecto ejecutado. El oráculo manual debe predecir de la ley el efecto de pertinencia y el control irrelevante; sin introspección requerida, MISSING_FIELD. Una preferencia que cambia sin cambiar motivo/acción según el alcance C23 no se presenta como par conforme. Cuerpo, clima, balance y entradas extra diferentes invalidan la atribución. Recuerdos pertinentes que no vencen otras necesidades son resultados a conservar, no razón para mover pesos después.

Un par adicional N1 de encuentro compara copia con oportunidad de cercanía/acciones compatibles frente a control emparejado sin esa oportunidad, intervención local revisada y pagada. Trazar movimiento, proximidad, acciones de ambos, evento y efecto conforme a la ley: alivio de fatiga/actividad no crea alimento ni acredita afecto real. Si no existe evento o no se puede intervenir limpiamente, UNKNOWN; una escena forzada no demuestra agencia. Un fixture `synthetic-review-oracle` prueba lógica técnica, nunca otorga consentimiento personal ni evidencia de World ejecutado.

## Recibo personal real y autorización individual

Antes de presentar contenido a Steven, un custodio local autorizado prepara el **inventario completo** de lo realmente incorporado al hash actual: carta, representación S/I, lugares, cada recuerdo real y dependencias de contenido/autoría. El denominador de recuerdos es el conjunto completo incorporado, no `authorizedMemoryIds`. Conciliar manifiestos de incorporación, componentes y dependencias contra artefactos privados completos sin exportar sus textos. Lo incompleto queda UNKNOWN aunque todos los IDs listados estén autorizados. Un recuerdo real incorporado acreditado sin autorización vigente demuestra FAIL; un inventario completo vacío puede acreditar la prohibición sin recuerdos, pero no revisión personal.

Metadata mínima local: ID opaco, tipo/scope, hash de bytes, hash de contenido completo y sus dependencias, autor fuente real, procedencia/source-metadata, fecha RFC3339 con zona, versión/sourceSHA y referencia local de incorporación. Autoría desconocida se conserva como desconocida; el nombre del operador no sustituye al autor personal. Hashes, IDs y paths no públicos también requieren custodia; los artefactos privados no entran a LLM.

Steven revisa el contenido real correspondiente al manifiesto y toma una decisión **explícita** por recuerdo y para el conjunto carta/S/I. El recibo se genera únicamente desde esa decisión humana comprobada por sesión local u operador de confianza, con `authority=Steven`, `decision=accepted/rejected/pending`, `contentHash`, `at`, `localReceiptId` y `provenanceRef`. Cada `memory-authorization` enlaza además `memoryId`, `memoryHash` y el mismo `contentHash`; `personal-receipt` enlaza `realMemoryInventoryRef` y su resumen `authorizedMemoryIds` conciliado. Se usan los tipos del [evidence schema](contracts/evidence.schema.json), sin añadir firmas ficticias ni alterar schemas. No se incluye texto íntimo en recibos exportables.

No se crea aquí una plantilla rellenada con accepted, firma, nombre de recibo o timestamp de revisión. Hash de documento, checkbox, tarea cumplida, tiempo de uso o campo `source=approved` del UI **no autentican** a Steven. El operador verifica origen/identidad y timestamp contra el acto local, conserva el recibo verificable y sólo traduce su metadata al contrato. Si no puede verificarlo, UNKNOWN/PERSONAL_REVIEW_PENDING; el evaluador no emite aceptación ni firma. `synthetic=true` sólo permite ensayar lógica técnica y jamás recibo personal válido, aunque un ejemplo del contrato diga Steven.

Cambio de texto, bytes, recuerdo, autoría, procedencia o dependencia incorporada invalida la autorización previa para el contenido actual: nuevo inventario/hash y nueva revisión explícita. No trasladar una aceptación del recuerdo antiguo al nuevo ni reusar recibo de otra versión. La renovación puede conservar referencias históricas, sin declararlas vigentes. Rechazo válido de Steven → FAIL personal; pending/ausente/no verificable → UNKNOWN. Ninguna conformidad técnica cancela ese rechazo.

## Coste y reporte futuro

Para FPS/render overhead, repetir una traza de cámara sobre las mismas vistas de escena y tick: modo normal/ligero, paneles cerrados/abiertos, instrumento apagado/encendido, capturas apagadas/encendidas. Fijar orden/repeticiones/warmup y ventana antes de resultados; no inventar umbral de rendimiento C23. Registrar muestras de intervalos de frame, FPS efectivo y CPU por cuadro, backend, viewport y coste adicional como diferencias respecto de su referencia. CPU de dibujo no es ocupación GPU. Guardar también paso/p95/guardado/proyección/bytes/red/RSS del runtime en sus propias unidades y reloj. Sin muestras o referencia, overhead UNKNOWN; UI mostrando un último valor no acredita distribución. La comparación formal de paridad/coste corresponde a C22 y a su autor disjunto.

Panel futuro con todas las tareas×D-F/D-T/D-M y pares M1–M3/N1: `planned`, `pass`, `fail`, `unknown`, `total`, con `pass+fail+unknown=total=planned`, calidad/cobertura y censurados aparte. Emitir `C23.synthetic-agency`, `C23.device-tasks`, `C23.personal-review` separadas. Mostrar tanto infracción válida como dependencias ausentes; no PASS del criterio por un universal vacío. `acceptanceStatus=NOT_GRANTED` identifica conformidad técnica al perfil provisional, no aprobación del proyecto.

Situación de esta entrega: las tres subgates **UNKNOWN**; sesión/World/runtime/dispositivos/recibo no ejecutados, inventario real no auditado, cobertura no medida. Pendientes concretos: revisión documental por otro autor/integrador; manifiesto sintético, escena/inputs/oráculos sellados; decisiones de accesibilidad/muestra/coste; teléfono físico; evidencia de runtime del laboratorio autorizado; definición de chat; inventario y revisión personal exclusivamente Steven. Ninguno se cierra por entregar este plan.
