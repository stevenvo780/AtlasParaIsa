Recomiendo un motor con dueños regionales de agentes y recursos en CPU, un pool persistente configurable de 16–28 workers y políticas pequeñas por lotes en la 5070 Ti con pesos residentes y canal compartido. Para el siguiente paso elegiría A. El C ensayado no ganó frente al control cercano y añade semántica de relojes locales. La segunda GPU necesita reparto heterogéneo o una tarea independiente medida: no se justifica un reparto 50/50 de este kernel.

Este es un spike de arquitectura. No implementa el motor paralelo ni valida un mundo real de 100.000 personas.

Medido el 24-11-2026, aproximadamente 13:28–14:05, America/Bogota. Rama `sprint/v23-spikes`, SHA `849a89513218f5a943421c98807bf4cfbbfc0de8`; AMD Ryzen 9 9950X3D 16-Core Processor, 16 núcleos físicos / 32 hilos lógicos, RAM 125,4 GiB; RTX 5070 Ti y RTX 2060. Node v22.23.3. Cada punto tiene tres repeticiones. Hay 291 lecturas literales de uptime junto a las ventanas/calibraciones y al crecimiento; load1 observado 29,92–87,13. Node del laboratorio corrió SCHED_IDLE; los microbenchmarks Python GPU corrieron SCHED_OTHER/nice 8. No representan capacidad del host libre ni la prioridad del servicio público.

a) Línea base real en memoria.

Usé `createWorld` y `stepWorld` sin Store, servidor, guardado, red ni clonación por tick. Parámetros abiertos del ejemplo, con SoA de terreno, un hilo, GPU desactivada y precomputación paralela de personas desactivada para obtener una referencia serial. Cada semilla creció naturalmente durante 600 segundos de reloj. Ninguna llegó a 300 ni a 3.000 personas: las poblaciones reales alcanzadas fueron 143 y 73. Los límites alternativos autorizados por el encargo sustituyen esos dos tamaños; no se añadieron habitantes artificiales.

Cada repetición avanzó 240 ticks desde un clon del mismo checkpoint natural. El clon está fuera del cronómetro; no son semillas independientes ni tres crecimientos independientes. El crecimiento calienta el motor, pero no se añadió otro calentamiento tras clonar. Se muestran medianas y rangos; no se atribuye la variación a una causa aislada.

| Magnitud | Semilla 51926 | Semilla 19103 |
| --- | --- | --- |
| Población inicial → final de ventana | 143 → 145 | 73 → 74 |
| Tick del checkpoint | 24802 | 25480 |
| Teselas / animales al acabar | 24832 / 321 | 38400 / 782 |
| Paso medio, ms/tick: mediana [mín–máx] | 25,864 [21,648–49,448] | 61,641 [41,977–119,075] |
| p95 de paso, ms: mediana [mín–máx] | 65,531 [51,084–110,152] | 157,961 [109,869–380,588] |
| Personas, µs de reloj/persona/tick | 89,46 [73,57–198,67] | 180,51 [105,78–304,77] |
| Personas, µs CPU/persona/tick | 90,83 [77,89–198,61] | 76,26 [60,80–110,24] |
| Fracción fuera de personas, mediana | 50,12 % | 81,06 % |

| Fase: mediana ms/tick | 143 personas | 73 personas |
| --- | --- | --- |
| Regiones | 0,219 | 1,607 |
| Ecología | 1,866 | 5,982 |
| Kernel ecosistema | 2,736 | 6,801 |
| Fauna y estructuras | 6,395 | 29,691 |
| Personas | 12,901 | 13,356 |
| Encuentros | 0,010 | 0,010 |
| Demografía | 0,965 | 1,475 |
| Comunidades | 0,006 | 0,032 |
| Reproducción | 0,504 | 2,140 |
| Checkpoint tecnología | 0,197 | 0,411 |
| Muestreo | 0,003 | 0,004 |
| Fuera de fases nombradas | 0,086 | 0,158 |

Las medianas de cada fase son independientes y pueden no sumar la mediana del total. El reloj CPU incluye actividad del proceso/GC y el coste del instrumento. “Personas” incluye percepción, decisión, cuerpo, acción y descubrimiento; no es una medición aislada de una llamada a choose() ni de cada decisión efectivamente tomada.

La simulación de referencia es serial al 100 %. La clasificación estática `fraccionSerial()` (~7–9 %) no mide el paralelismo actual. Si solo se acelera personas y el resto permanece igual, las fracciones restantes medianas de 50,1 % y 81,1 % implican techos orientativos de 2,00× y 1,23× aun con esa fase instantánea. Es una estimación de Amdahl, no una aceleración observada.

b) A: regiones con dueño, SAB y barrera.

112 regiones fijas de una grilla aplanada, escritura exclusiva, dos buffers, tres vecinos fijos y una lectura cercana variable. Buzones SPSC unidireccionales r→r+1, con débito antes de publicación y secuencia por tick. El coordinador usa Atomics.wait/notify. Workers persistentes; creación fuera del tiempo del tick.

Calibración contra la mediana CPU del mundo de 143 personas: 90,828 µs/persona/tick; 11.847 rondas del kernel sintético. La calibración sobre SAB/N=10.000 evita el módulo barato de potencias de dos. El coste observado A1 fue 91,225 / 89,552 / 89,251 µs/agente/tick para N=1k/10k/100k, dentro de ±2 % del objetivo.

| Workers | N=1.000 TPS | N=10.000 TPS | N=100.000 TPS | Barrera vacía ms/tick |
| --- | --- | --- | --- | --- |
| 1 | 9,293 | 0,977 | 0,0366 | 0,046 |
| 2 | 16,942 | 1,351 | 0,0737 | 0,642 |
| 4 | 24,388 | 3,285 | 0,1770 | 0,323 |
| 8 | 21,929 | 2,570 | 0,2202 | 0,695 |
| 16 | 36,201 | 3,554 | 0,3883 | 3,857 |
| 28 | 67,039 | 5,958 | 0,4038 | 2,141 |

| N | A28 TPS [mín–máx] | CPU lógicas equivalentes, mediana |
| --- | --- | --- |
| 1000 | 67,039 [59,875–73,899] | 6,15 |
| 10000 | 5,958 [5,570–6,231] | 5,41 |
| 100000 | 0,4038 [0,3920–0,5468] | 3,65 |

Los puntos grandes usaron un mínimo de dos ticks por repetición; su “p95” interno no es un percentil robusto y no se usa para decidir. La barrera vacía de 28 workers fue 2,141 ms [1,918–3,692]. Frente a los 2476,631 ms/tick de A100k representa aproximadamente 0,086 %: su coste fijo por sí solo no explica un cuello de botella de segundos.

El control final A1/N100k dio 0,07035 [0,06556–0,07267] TPS, frente a 0,03661 inicial, con el mismo coste CPU por agente. Es 1,92× más rápido. El cociente A28/A1 resulta 11,03× con la referencia inicial y 5,74× con ese control. Son cocientes observados bajo carga cambiante, no aceleraciones causales aisladas.

c) B: política 12→8→12 FP64, 212 pesos almacenados por agente.

Se reutiliza el Device/NVRTC y el forward original. Pesos en filas individuales, sin reemplazarlos por una matriz única compartida. Los datos de control tienen 97 variantes repetidas; el almacenamiento y traslado siguen siendo 212×N FP64. Memoria host pageable. Asignación inicial y compilación fuera del microbenchmark.

En esta tabla “residente” deja observaciones, pesos y salida en VRAM. “Subir+bajar” transfiere observaciones+pesos y devuelve todos los resultados cada pasada. Son latencias de pared del subproceso CUDA, con kernel separado por CUDA events en los JSONL.

| N | 5070 Ti residente ms | 5070 Ti subir+bajar ms | 2060 residente ms | 2060 subir+bajar ms |
| --- | --- | --- | --- | --- |
| 1000 | 0,037 | 0,211 | 0,060 | 2,772 |
| 10000 | 0,070 | 1,711 | 0,599 | 16,143 |
| 100000 | 0,629 | 19,894 | 10,903 | 98,613 |
| 1000000 | 6,430 | 225,734 | 100,974 | 925,132 |

El caso residente con estado que evoluciona mediante feedback sintético costó a N=1M 6,624 ms en la 5070 Ti y 112,527 ms en la 2060. La descarga de 12 resultados por agente elevó el residente estático a 18,930 y 131,740 ms. Ese feedback no implementa las acciones del mundo.

La API real Node→worker→Python/CUDA incluye validación, asignaciones por llamada, copias, IPC, transferencias y devolución. Solo preparación/JIT quedan fuera. “Pesos residentes” aún envía observaciones+slots y trae resultados en cada llamada. El archivo compartido usa el protocolo original, pero crea/mapa/unlink únicamente dentro del spike mediante selección temporal de directorio; es pagecache del filesystem, no una medición de /dev/shm ni de producción.

| N | CPU misma red ms | 5070 pipe pesos residentes ms | 5070 pipe subir todo ms | 2060 pipe pesos residentes ms | 2060 pipe subir todo ms | 5070 archivo pesos residentes ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1000 | 0,809 | 5,900 | 59,385 | 2,401 | 4,513 | 0,824 |
| 10000 | 22,814 | 18,852 | 276,826 | 4,855 | 41,635 | 1,304 |
| 100000 | 94,370 | 391,987 | 1173,736 | 38,977 | 402,186 | 8,353 |
| 1000000 | 941,306 | 1316,523 | 18824,847 | 379,536 | 3636,581 | 287,671 |

| N | Dual pipe pesos residentes ms | Dual pipe subir todo ms |
| --- | --- | --- |
| 100000 | 78,237 | 400,221 |
| 1000000 | 1435,801 | 19914,547 |

El control final 5070 Ti/N1M/pipe, sin ejecutar previamente la referencia CPU, dio 994,220 [897,634–1017,691] ms con pesos residentes y 4706,752 [4195,570–6984,910] ms subiendo todo. La variación frente al primer ensayo impide clasificar los chips por sus latencias secuenciales de IPC. La diferencia del kernel se mide por separado. Dual no demostró una ventaja estable frente al dispositivo principal.

Cruce frente a A28: con pesos residentes, B ya es más barato que el proxy A en el menor lote medido, N=1.000; el cruce inferior no fue medido. Subiendo todo por pipe en la 5070 Ti, B pierde en 1k y 10k y gana en 100k frente a la matriz A inicial: intervalo descriptivo (10.000,100.000]. Ese resultado se revierte con el control A28 cercano: a 100k A tarda 580,169 ms y B 1173,736 ms. No hay un umbral estable identificado. Además, A representa decidir+actuar sintéticos y B solo la red, así que estos cruces no prueban aceleración de choose().

Comparando trabajo idéntico, el canal por archivo es competitivo con la CPU a 1k (rangos solapados) y muestra ventaja a 10k. Su intervalo de cruce descriptivo es (1.000,10.000], condicionado a la carga y a este canal.

d) C: relojes locales sin barrera por tick.

Misma aritmética, triple buffer, dependencias simétricas con vecinos y buzones SPSC. Los dueños esperan por contadores propios y notifican solo vecinos. Hay una pausa administrativa única tras calentar para iniciar la ventana con todos quietos; no hay barrera global por tick. Ventanas de 3 segundos, más drenaje/parada incluido en el tiempo. Las TPS equivalentes se calculan como actualizaciones de agentes / N / segundo.

| N | C1 TPS | C28 TPS [mín–máx] | A28 control cercano TPS [mín–máx] | C/A cercano | Desfase global máx observado / vecino |
| --- | --- | --- | --- | --- | --- |
| 1000 | 10,8569 | 88,5380 [79,2083–89,1454] | 92,2919 [86,7642–121,3885] | 0,959 | 8 / 1 |
| 10000 | 0,9506 | 10,6807 [9,7677–14,5243] | 17,1626 [13,4798–17,9479] | 0,622 | 6 / 1 |
| 100000 | 0,1005 | 0,8503 [0,8214–0,9217] | 1,7236 [1,2195–1,8462] | 0,493 | 3 / 1 |

Todos los threads de C observados por PS eran IDL. El control cercano A28 se lanzó con la misma clase; alcanzó una mediana de 15,84 CPU lógicas equivalentes a N100k. No se demostró ocupación sostenida de los 28 workers/32 hilos.

Los máximos de desfase son observados mediante dobles capturas atómicas idénticas. Vecinos ≤1 en todas las ventanas; global observado con 28 workers: 8/6/3 ticks. Los intervalos reales de muestreo alcanzaron 119,6/125,5/311,4 ms. No son máximos continuos. La cota lógica estructural global del grafo de prueba es 14/28/56 ticks. El coste de snapshots llegó a 58,10 ms de pared por ventana; ese tiempo puede incluir preempción.

C no ganó frente al control cercano en ninguno de los tres tamaños. La carga sigue variando y el control no es un experimento aislado/intercalado; esto no refuta todas las arquitecturas asíncronas. Este C conservativo no justifica añadir relojes locales al siguiente prototipo del mundo.

e) Decisión y trabajo que no conviene hacer.

El siguiente diseño debería regionalizar también fauna/ecología y los consumos materiales; acelerar solo personas deja los techos de Amdahl anteriores. Mantener un dueño único por recurso/actor, debitando antes de publicar y acreditando una secuencia una sola vez. La GPU devuelve propuestas/puntuaciones y el dueño confirma los efectos. El determinismo entre cantidades de hilos no es necesario para esta propiedad.

Conservar pesos en VRAM y usar un canal compartido por lotes resulta la dirección respaldada para la política: a un millón, la API por archivo observada (287,671 ms) supera la referencia de la misma red monohilo (941,306 ms), aunque queda muy por encima del kernel (6,430 ms).

No conviene subir 1,792 GB de observaciones+pesos y bajar 96 MB por tick a N1M; tampoco repartir este kernel 50/50 entre GPU desiguales ni crear workers por tick. No conviene compartir World mutable sin dueños, atribuir el forward a toda choose(), interpretar el clasificador estático de fases como paralelismo ejecutado o elegir C por compararlo solo con la primera matriz A. Una tarea independiente útil para la 2060 es una propuesta pendiente de medir, no una capacidad probada aquí.

f) Alcance, controles y repetición.

Medido: dos trayectorias naturales hasta diez minutos; 240 ticks ×3 por checkpoint; matriz A completa ×3, barreras vacías, controles monohilo y A28; ambas GPU y ambas juntas, CPU equivalente, pipe y archivo; C ×3; carga, políticas de scheduling, invariantes y diferencias contra CPU. 222 repeticiones/ventanas de resultado registradas, además de iteraciones CUDA internas y calibraciones.

Estimado: límites de Amdahl y relevancia de la arquitectura para el motor completo. A/C usan un estado caliente compacto de aproximadamente 24/28 bytes por agente, frente a ~782 bytes calientes de PersonStore; no reproducen toda su presión de memoria ni su lógica. Solo hay 112 slots de frontera unidireccionales por tick, agentes inmóviles, un flujo por frontera y ninguna prueba de migración, contención multirrecurso, fallos/reintentos o catálogo durable. No se midieron mundos reales de 300/3.000, A de un millón ni el conjunto integrado CPU+GPU del mundo. Tampoco entrenamiento, render, aislamiento de carga o rendimiento del servicio público.

Conservación exacta inventarios+en tránsito, inventarios no negativos, estado finito y secuencias sin doble consumo pasan en todos los prototipos ensayados. El error máximo GPU frente a las 32 filas CPU de control fue 0 y los resultados del puente residente/subida coinciden. Eso valida estos casos, no demuestra todavía seguridad del motor completo.

`node spikes/motor/verificar.mjs` pasó; `verification.json` registra la cobertura. Sintaxis JS, Python y Bash comprobada. `LEEME.md` tiene exactamente cinco líneas y `repetir.sh` no instala dependencias. `results-summary.json` contiene medianas/rangos y todos los JSONL conservan las ventanas originales con uptime. `campaign.json` registra que los 13 PIDs principales propios comprobados ya no existen. El primer arranque corto archivado como `baseline-initial-aborted.jsonl` se interrumpió para añadir reloj CPU, no produjo ventanas de resultado y está excluido.

`git diff --exit-code` pasó y `git status --short` muestra únicamente `?? spikes/`. No hubo commits, push, builds, instalaciones ni modificaciones de datos/mundos, árbol principal, worktrees públicos o servicios. Toda escritura solicitada de código, logs y artefactos del spike está bajo `spikes/motor/`.
