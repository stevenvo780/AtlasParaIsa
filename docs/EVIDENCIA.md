# Evidencia de la revisión vigente

Fecha: 5 de septiembre de 2026. **V4 está en validación; el servicio privado sigue en V3.** Este documento conserva únicamente la evidencia vigente y las comparaciones necesarias para evaluarla. Git contiene las revisiones anteriores.

## Capacidades y estado de integración

V4 integra fauna individual con necesidades compartidas, percepción, memoria, herencia, depredación y mortalidad; diseños de estructuras con componentes funcionales, costes y ascendencia cultural; hogares recordados para favorecer retorno y cooperación. El backend sigue siendo un único mundo para todos los clientes. Las reglas canónicas están en [REGLAS.md](REGLAS.md), la intención y las ideas pendientes en [PLAN.md](../PLAN.md).

La interfaz permite buscar, inspeccionar y seguir animales sin darles órdenes humanas. Muestra componentes, reservas y daño de edificios, planos y utilidad observada. Los habitantes pueden ensayar diseños y reparar. La aprobación de módulos aislados no equivale al cierre integrado.

| Comprobación V4 | Estado comprobado |
|---|---|
| Fauna, ecología y snapshot | 44 pruebas focales aprobadas tras corregir presupuesto, interacciones entre turnos y dormancia; incluidas en el cierre global. |
| Invenciones | 20 pruebas y cuatro regresiones focalizadas aprobadas tras corregir utilidad y asignación de identidades; incluidas en el cierre global. |
| Renderer | 3 pruebas aprobadas. |
| Navegador | **10/10**, cero fallos, 46,4 s; escritorio y móvil emulado. [Log](../artifacts/e2e-v4.txt). |
| Cliente y servidor compilados | Build final aislado en `/tmp/atlas-v4-release`; no reemplaza todavía la interfaz activa. [Log](../artifacts/build-v4.txt). |
| Tipos y pruebas Node globales | Typecheck aprobado; **165/165**, cero fallos y cero skips, 119,455 s. [Log](../artifacts/node-v4.log). |
| Entry point compilado | Acceso privado, avance autónomo, SIGKILL/reinicio con sesión conservada, revocación y SIGTERM aprobados en un mundo temporal. [Resultado](../artifacts/smoke-v4.json). |
| Ejecución prolongada y persistencia V4 | Pendientes; no se trasladan métricas de V3. |
| Servicio privado V4 | Todavía no activado. |

Las cifras se actualizarán con la ejecución final y sus artefactos. Los archivos nuevos de `artifacts/` están excluidos por una regla local preexistente en `.gitignore`, conservada sin modificar; los resultados principales y comandos reproducibles quedan aquí.

## Revisión independiente

Se reprodujeron cuatro defectos durante la integración:

- Activar una región con 8192 animales elevaba la población y detenía el paso. El motor ahora distingue identidades residentes y presupuesto de actividad: conserva hasta 393216 identidades, procesa hasta 8192 cuerpos por paso con rotación y hasta 1024 decisiones. La prueba con 8210 conserva todos los individuos y reparte turnos.
- La edad calculada desde el reloj global adelantaba madurez y senescencia de animales archivados. La corrección conserva edad biológica y pausa reproductiva durante dormancia. Se probó una pausa de un millón de pasos y que las cohortes no queden excluidas del calendario reproductivo.
- Un contador de estructuras retrocedido podía generar identidades duplicadas y cobrar recursos. La validación revisa contadores y archivos; el asignador reserva una identidad libre antes de cobrar. La prueba independiente de una identidad exclusivamente archivada también pasa.
- El descanso sin beneficio adicional y el agua vertida sin consumidor podían sumar utilidad de diseño. La cisterna conserva agua hasta consumo real; el descanso compara recuperación efectiva con el exterior. Los dos casos reproducidos ahora tienen usos y utilidad exactamente cero cuando no hay beneficio.

La revisión independiente **aprobó el cierre de los cuatro hallazgos**. También detectó y cerró una regresión del presupuesto: las cohortes podían impedir encuentros entre parejas. El mismo reproductor con 16384 animales ahora obtiene un nacimiento en ambos órdenes de IDs. Los receptores residentes pueden recibir interacciones de un iniciador fuera de su turno, sin metabolismo ni envejecimiento extra; los archivados siguen excluidos. Pasaron siete pruebas de snapshot y seis focales independientes, además de la suite global. El límite de 512 estructuras restringe obras nuevas, sin descartar edificios históricos al migrar o recuperar regiones; se comprobó una migración con 600 techos.

## Observación autónoma

Sondas preliminares de la semilla 51926, sin órdenes ni modificaciones del escenario, formaron comunidades, registraron cooperación y nacimientos y construyeron variantes con granero doble, hogar y cisterna. Hubo captación real de lluvia. Algunos diseños permanecieron sin construir y no se observaron depósitos o retiros de granero en esa ventana.

Estas sondas se hicieron mientras cambiaba el código y no constituyen un único experimento comparable. Los conteos definitivos y la persistencia se fijarán con la ejecución prolongada del cierre. Un nacimiento o diseño en un escenario preparado no acredita su frecuencia autónoma.

## Rendimiento gráfico

Escenario sintético: 1440 × 900, DPR 1, 4928 celdas, 1000 animales moviéndose, veinte habitantes y doce estructuras. El renderer obtuvo **59,76 FPS**, CPU de dibujo media **11,93 ms**, p95 **13,5 ms**, caché **5,19 MiB** y ninguna nueva rasterización del terreno durante la muestra.

Chromium identificó SwiftShader y utilizó Canvas 2D. Esta prueba **no verificó GPU física** ni garantiza 60 FPS en toda la aplicación. Una captura puntual de la interfaz real con paneles mostró 33,9 FPS, 42 animales y tres estructuras; es una lectura del HUD, no el promedio del benchmark.

Artefactos locales: [muestras del renderer](../artifacts/render-v4-individuals-default-moving.json), [escena de benchmark](../artifacts/render-v4-individuals-default-moving.png), [fauna en móvil emulado](../artifacts/animal-inspector-mobile-v4.png), [invenciones](../artifacts/inventions-v4.png) y [rendimiento con interfaz](../artifacts/performance-graphics-v4.png). El script `scripts/benchmark-render.ts` conserva el escenario reproducible.

Se detectaron RTX 5070 Ti y RTX 2060 en el entorno. La simulación, decisiones y SQLite usan CPU del servidor. La GPU utilizada para dibujar pertenece al navegador; no hay cálculo ecológico en las GPU del servidor.

## Mundo privado y conservación

El servicio existente está en **https://172.26.0.4:3443**, con la misma contraseña, todavía V3. Una lectura del paso 83945 confirmó la dispersión: ninguno de sus dieciséis habitantes tenía otro a siete celdas; mediana al vecino más próximo 329,43 celdas. No había comunidades ni cooperación reciente.

Se conservó una copia SQLite íntegra y privada antes de V4: `before-individual-fauna-v4-2026-09-05T18-43-22-506Z.sqlite`, paso 86991, con comprobación de integridad aprobada. Vive fuera del repositorio, en `~/.local/state/atlas-para-isa-preview`. Para concretar la solicitud de limpiar la base principal se prepara un comienzo nuevo con V4, conservando la historia anterior y la credencial. Todavía no se ha realizado ese cambio; exige terminar las pruebas de integración.

La migración de esa copia a V4 en memoria conservó **321385 valores escalares previos**, dieciséis habitantes y 16384 celdas. Materializó exactamente 2921 animales y 46 estructuras. Pasaron la validación del mundo y la pureza de cámara; el SHA256 de la base permaneció idéntico antes y después de la lectura. [Resultado local de migración](../artifacts/migration-v4.json). Esta prueba no activa V4 ni sustituye su reinicio integrado.

Servidor y TLS usan las sesiones propias `carta-isa-world` y `carta-isa-https`. Cerrar la terminal no las cierra; no se ha demostrado arranque automático tras reiniciar el contenedor. Credenciales y copias permanecen privadas.

## Colaboración y límites

GPT-6 realizó fauna, integración, cohesión, interfaz y revisión independiente en frentes con archivos disjuntos. Fable 5.1 completó una propuesta textual de búsqueda de diseños en 118,8 segundos; se adaptó a costes y contratos reales. No recibió secretos ni recuerdos personales. La simulación no necesita un LLM en ejecución.

Faltan la ejecución prolongada V4 y su activación. No se probaron teléfono físico, Safari/iOS, lector de pantalla, varios días reales, doce clientes bajo carga sostenida, miles de habitantes, fallo físico de disco ni cálculo ecológico en GPU. No se demuestra conciencia, autopoiesis biológica, efecto Baldwin o evolución ilimitada. Las fuentes y las aproximaciones están en [CIENCIA.md](CIENCIA.md).
