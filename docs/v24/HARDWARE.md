# Arquitectura de ejecución de V24

La rama de hardware parte de `f65d08c`, un punto verificable de la candidata V23. Integrará las correcciones de V23 antes de la campaña larga. El objetivo es aumentar el trabajo útil por segundo y sostener territorio y población a distintas resoluciones, preservando la historia y el balance material de la simulación.

## Un paso regional

1. Cada región tiene un dueño que escribe sus páginas. El dueño lee los eventos que vencen y una vista inmutable de los bordes vecinos. La planificación agrupa páginas contiguas, conserva afinidad a los dominios L3 y mueve trabajo cuando el ahorro de espera supera el coste de copiar y migrar.
2. El motor prepara tandas regulares de suelo, percepción y puntuaciones. Las páginas de campos que se reutilizan se mantienen en VRAM. El despacho transmite las páginas cambiadas y los índices de la tanda. Cada respuesta incluye región, versión y despacho. La CPU procesa otros interiores que ya tienen sus datos, y valida las propuestas cuando llegan.
3. Las decisiones que dependen de historia, propiedad o interacciones se resuelven en los dueños CPU. Un movimiento de frontera requiere reservar recursos en destino y recibir confirmación. Un mensaje de migración lleva generación e identidad para que repetirlo no duplique el cuerpo ni sus lotes.
4. El motor publica una época coherente. El cliente lee deltas de esa época. La persistencia recibe páginas cambiadas y sella un checkpoint de mundo y materia. La cinta encola fotogramas y su índice de manera independiente. Si un escritor se atrasa, se registra el retraso y se protege la memoria de las páginas que todavía necesita.

## Jerarquía de memoria

| Recurso | Trabajo y residencia |
|---|---|
| L3 y 16 núcleos físicos | Interiores regionales, decisión irregular y confirmación. Medir la cola del dueño más lento, el reparto entre dominios L3 y el efecto de SMT. |
| RAM | Páginas tipadas de campos y organismos activos, vistas de borde de solo lectura, colas reutilizables y estado mínimo de regiones que esperan eventos. Separar datos de cada paso de identidad, genoma e historia consultados con menor frecuencia. |
| RTX 5070 Ti, 16 GiB | Campos y lotes regulares con reutilización. Vectorizar mallas y reducciones. Usar operaciones tensoriales solo donde exista una matriz densa de puntuaciones o una política pequeña y se mida la equivalencia necesaria. |
| RTX 2060, 6 GiB | Tandas independientes cuando reduzcan la espera total. Medir colas, versiones, transferencias y caídas antes de sumar la tarjeta al paso crítico. |
| NVMe | WAL y checkpoints de mundo y materia, páginas frías indexadas y cinta con ruta configurable. La última época recuperable se conoce al confirmar su escritura. |
| HDD | Copias verificadas de épocas y segmentos ya persistidos, con restauración medida en una copia separada. |

El broker por dispositivo debe acotar memoria y cola, reutilizar buffers y descartar resultados desfasados. Si una tanda vence, el dueño conserva la entrada versionada para recuperarla en CPU. La selección de equipo se decide con tiempo de pared del paso, incluidos preparación, barreras, transferencias y recuperación. El balance de átomos y energía usa su contabilidad exacta en cualquier ruta.

## Escala y resolución

Una región residente conserva sus entidades individuales. Una región que espera eventos mantiene identidad, inventarios y el siguiente tick material relevante. Una región fría se archiva con su último tick aplicado y el saldo de frontera. Se reactiva antes de consumir un evento que pueda afectarla. Los saltos temporales de una ley necesitan un avance equivalente o una aproximación explícita, comparada con una ventana de resolución completa. La cámara consulta el resultado de la simulación y nunca agenda el despertar de una región.

Reportar habitantes persistidos, residentes y activos durante la misma ventana. Con 2.400 ticks por día y un objetivo ilustrativo de un día simulado por hora, un millón de agentes activos en 16 núcleos deja 24 µs ideales de CPU por agente y tick. El presupuesto real es menor por comunicación, memoria y persistencia. Que un conjunto de datos de un millón quepa en RAM o disco acredita capacidad de almacenamiento. La capacidad de simulación requiere medir trabajo útil, conservación y continuidad en esa escala.

## Flujo de integración y pruebas

- Construcción en paralelo con archivos disjuntos. CPU y localidad, percepción residente, persistencia y banco reproducible. La agenda territorial empieza con orden lógico y reactivación verificables antes de conectarla al mundo. Codex aplica cambios y Grok audita supuestos, bancos y trazas. Reservar Opus para un bloqueo que requiera revisión excepcional.
- Integración breve. Typecheck, controles focales de caída y conservación, y ventanas cortas emparejadas desde los mismos estados de prueba. Guardar SHA, parámetros, semillas, afinidad, carga, p50/p95/p99, tiempos de cálculo y espera, bytes movidos, memoria, retardo de guardado y colas de cinta. Reutilizar estados compatibles con las leyes bajo prueba.
- Campaña larga en un candidato integrado. Comparar uno y varios dueños, 5070 Ti y ambas tarjetas en la configuración ganadora de CPU. Separar densidad y superficie activa. Elevar población solo tras confirmar balances, migraciones, cinta y recarga en el punto previo. Incluir demografía sin intervención en semillas fijas, además de la prueba de servidor en turbo.
