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

En la torre, cada dominio L3 agrupa ocho núcleos físicos. El de 96 MiB corresponde a `0–7,16–23` y el de 32 MiB a `8–15,24–31`. Los dos dominios comparten 125 GiB de RAM. La 5070 Ti tiene enlace PCIe x16 directo y la 2060 dispone de x4 a través del chipset. Cada GPU tiene su propia VRAM y comparte el tráfico a RAM con los otros dispositivos. `/datos` está en un RAID de NVMe. Separar allí dos carpetas ayuda a medir y retener archivos por separado. Para medir independencia física entre cinta y guardado hay que usar otro volumen NVMe. El HDD de `/mnt/Data2` queda para respaldos. Las esperas de disco, la presión de RAM y las transferencias CUDA se registran por separado para identificar qué domina la latencia.

## Escala y resolución

Una región residente conserva sus entidades individuales. Una región que espera eventos mantiene identidad, inventarios y el siguiente tick material relevante. Una región fría se archiva con su último tick aplicado y el saldo de frontera. Se reactiva antes de consumir un evento que pueda afectarla. Los saltos temporales de una ley necesitan un avance equivalente o una aproximación explícita, comparada con una ventana de resolución completa. La cámara consulta el resultado de la simulación y nunca agenda el despertar de una región.

Reportar habitantes persistidos, residentes y activos durante la misma ventana. Con 2.400 ticks por día y un objetivo ilustrativo de un día simulado por hora, un millón de agentes activos en 16 núcleos deja 24 µs ideales de CPU por agente y tick. El presupuesto real es menor por comunicación, memoria y persistencia. Que un conjunto de datos de un millón quepa en RAM o disco acredita capacidad de almacenamiento. La capacidad de simulación requiere medir trabajo útil, conservación y continuidad en esa escala.

## Flujo de integración y pruebas

- Construcción en paralelo con archivos disjuntos. CPU y localidad, percepción residente, persistencia y banco reproducible. La agenda territorial empieza con orden lógico y reactivación verificables antes de conectarla al mundo. Codex aplica cambios y Grok audita supuestos, bancos y trazas. Reservar Opus para un bloqueo que requiera revisión excepcional.
- Integración breve. Ejecutar `bash scripts/check-v24-hardware.sh` para ambos typechecks y los controles focales de la rama. `--cuda` añade pruebas breves de percepción en hardware con `COMPUTE_NVRTC`. Medir ventanas cortas emparejadas desde los mismos estados de prueba. Guardar SHA, parámetros, semillas, afinidad, carga, p50/p95/p99, tiempos de cálculo y espera, bytes movidos, memoria, retardo de guardado y colas de cinta. Reutilizar estados compatibles con las leyes bajo prueba.
- Campaña larga en un candidato integrado. Comparar uno y varios dueños, 5070 Ti y ambas tarjetas en la configuración ganadora de CPU. Separar densidad y superficie activa. Elevar población solo tras confirmar balances, migraciones, cinta y recarga en el punto previo. Incluir demografía sin intervención en semillas fijas, además de la prueba de servidor en turbo.

## Componentes disponibles para el laboratorio

- `CARTA_PERCEPCION_RESIDENTE=1` reutiliza páginas y ventanas CUDA con un dueño. `CARTA_PERCEPCION_COSTE=1` prueba CPU y las tarjetas elegibles por tamaño de lote y conserva sus tiempos medidos. Con `CARTA_PERCEPCION_DUENOS=1` y la química en CPU, dos dueños comparten el corredor de la tarjeta configurada si hay una. Con dos tarjetas, cada dueño tiene su propio corredor. Un brazo de laboratorio puede usar más dueños CPU y pasar `duenosPercepcionGpu` para asignar un dueño global a cada tarjeta en el orden de `gpu`. Los contadores publican el dueño asociado a cada ranura. Cada corredor admite un despacho a la vez, invalida por generación y permite que el dueño retome el trabajo en CPU dentro del mismo tick ante ocupación o fallo. El modo CUDA del motor se fija para su vida y un cambio exige arrancar otra instancia.
- `scripts/perf/banco-motor-v24.mts` compara dueños reales sobre una siembra o una copia SQLite sellada de laboratorio. Conserva las mediciones brutas y registra ocupación por chunk al salir del calentamiento y al cerrar cada brazo. Una lista `afinidad` permite delimitar las CPU Linux por brazo y comprobar la máscara efectiva. Los hilos pueden moverse dentro de esa máscara. `scripts/lab/localidad-cpu.mts` evalúa repartos alternativos con trazas reales y costes calibrados.
- Con corredor, `CARTA_PERCEPCION_COSTE_DUENOS=1` permite escoger por plan, tamaño y dueño a partir del coste medido hasta validar la respuesta. Las caídas y los resultados que la CPU rechaza quedan fuera del aprendizaje. El banco registra cada tarjeta por separado, distingue la elección de CPU por coste de una caída y acredita una tanda CUDA cuando el motor acepta la respuesta en F2.
- Un brazo puede asignar `gruposPercepcionGpu` para que varios dueños compartan el corredor de una tarjeta. Cada dueño tiene un despacho pendiente como máximo y cada tarjeta procesa su propia cola. Un plazo agotado con la tarjeta vigente devuelve el cálculo a CPU en el mismo paso. El dueño recompone sus espejos en el siguiente envío. El banco distingue vencimientos en cola, vencimientos durante el tránsito y fallos de canal. Para acreditar un brazo agrupado exige una respuesta aceptada por cada dueño asignado.
- Con `"perfilPaso": true`, el banco guarda tiempos de pared y espera del coordinador por tramo, tiempos por dueño y el cierre del paso. Las esperas pueden solaparse con el trabajo de un dueño. CPU y RSS del proceso corresponden a Node. El banco conserva tiempos y contadores de los brazos con caídas de GPU y los excluye de las aceleraciones. La comparación CUDA con siembra requiere calentamiento previo. Los 50 ms de tránsito del corredor empiezan al publicar el paquete. La preparación conserva su propia medida y se incluye en el coste completo. `CARTA_PERCEPCION_TRAZA=1` registra la preparación, el transporte y la respuesta para una sonda corta.
- `CARTA_CINTA_DIR` admite una carpeta absoluta dedicada en un volumen independiente. Grabador, lector y respaldo deben recibir el mismo valor. La ruta predeterminada sigue junto a `world.sqlite`.
- La agenda territorial ordena vencimientos lógicos. `Store.guardar` admite un corte y lo confirma en la misma transacción que el mundo, ligado al tick, la época y la materia guardada. La activación automática y el avance multiescala de las leyes siguen pendientes.
- La ecología material consulta las páginas residentes cuya fase vence en el tick. El índice conserva el orden de despacho anterior y se reconstruye al cambiar el dueño, la topología o la cadencia. La química y el balance siguen sus pasos habituales.
- Las vistas privadas de terreno se asignan por página activa y se descartan al retirarla o cederla. Los vecinos siguen consultando las columnas compartidas. La carga de 3.000 identificadores históricos consumió 5,36 MiB de buffers en la representación anterior y 0,23 MiB en la nueva en una sonda aislada. La identidad y los enlaces de los lotes materiales siguen residentes.
- Las teselas materiales contiguas se consultan mediante el desplazamiento dentro de su página. Solo las páginas activas con huecos mantienen un índice. Los rangos abandonados se reutilizan al cambiar de página o dueño. El retiro habitual conserva el estado material necesario para reabrir la región y contabilizar sus reservas.
- El checkpoint material mide y escribe en dos pasadas para evitar retener la composición de todas las páginas en el heap. La carga indexada restaura lotes por ranura mediante posiciones compactas. El formato y el orden se conservan. En las decisiones de comida y bebida, el dueño reutiliza las celdas de la ventana de percepción cuando su terreno coincide con el de la arena, y lee cantidades vigentes tras comprobar propiedad.
- El movimiento de origen entero usa tres buffers reutilizables por hilo para la búsqueda local. Conserva el recorrido cardinal, el orden de lectura del terreno, los desvíos costeros y el máximo de 2.048 nodos.
- Una elección reutiliza el provecho de cada sustancia para la carga, las teselas y los depósitos que evalúa. Cada candidato lee las cantidades vigentes, y la primera consulta química de cada sustancia conserva el orden de la búsqueda.
- La decisión comprueba primero si puede haber un depósito de obra dentro de su disco. Cuando lo hay, conserva las consultas de dueño, generación, stock y desempate de cada celda. Los filtros espaciales de rectángulos dispersos visitan solo casillas ocupadas en el mismo orden. Durante la actuación se leen solo los campos corporales que esa fase consume. Las observaciones todavía reciben la vista completa.

### Materia fría

Con un dueño y guardado completo, `CARTA_MATERIA_FRIA_DIR` habilita un directorio temporal privado dentro de la ruta absoluta indicada. Al retirarse una región elegible, la composición de Suelo y Vida pasa al archivo y sus buffers físicos quedan disponibles para reutilización. El terreno conserva sus referencias, Agua, Aire y los depósitos de mar y cielo. Una garantía de aire puede abonarse durante el retiro. Antes de activar la región o de modificar un lote frío, el dueño recupera la página y comprueba su huella. Si falla una escritura, el dueño conserva el material en RAM y suspende nuevos retiros físicos.

El guardado completo incluye todos los lotes y las garantías. La recarga desde SQLite puede reconstruir el directorio temporal sin reservar composición residente para las páginas que el archivo confirma completas, desocupadas y fuera de las garantías pendientes. El saldo incluye la composición fría sin releerla para cada inventario. Si falta la confirmación del terreno o un destino pendiente es ambiguo, se conserva la composición en RAM. El cierre ordinario elimina el directorio privado. Una terminación abrupta puede dejarlo en el volumen.

Con ocho páginas activas y ochenta archivadas, la recarga fría aparcó 78 páginas y redujo la arena de 14,3 a 5,0 MB. La identidad, el balance y el VMAT coincidieron después del primer guardado y al regresar al terreno. En ese ensayo el tiempo hasta completar el guardado inicial pasó de 413–512 a 600–655 ms y el RSS al terminar subió de 194–195 a 200 MB. El flag sigue siendo de laboratorio. Hay que medir tanto la arena como el RSS total, las lecturas al guardar y la latencia al volver a una región.

Una región dormida puede recibir vapor desde otra activa. Cuerpos archivados y mensajes en vuelo también pueden conservar referencias a lotes. Para desalojar el contenido de una página se necesita un índice de lotes por región y generación, un límite de residencia que admita el aire de frontera y un guardado que confirme juntos el contenido desalojado y los intercambios pendientes. La activación debe restaurar el conjunto antes de que una ley use la página. El primer control compara átomos, energía, identidades y efectos de frontera antes y después de desalojar, reiniciar y reactivar el mismo mundo. El control de escala mide el pico de RAM con una cantidad constante de regiones activas y un recorrido histórico creciente.

El guardado mide las composiciones frías por página sin abrir sus archivos. Después agrupa la escritura por página y ordena las ranuras dentro de cada grupo, con el mismo VMAT. En el mismo fixture contó 78 lecturas para 78 páginas y completó el arranque con guardado inicial en 484–519 ms, frente a 491–511 ms en caliente. El escaneo de identidades y el volumen durable todavía crecen con el terreno histórico. Antes de extender el piloto a varios dueños, hay que verificar la cesión de páginas, el vapor de frontera y los destinos de los mensajes en una barrera común.

### Capacidad del guardado y de la arena

El guardado anterior paginaba las teselas y serializaba juntas las personas. Tres guardados maduros midieron aproximadamente 9.700–10.800 caracteres por persona. Con ese promedio, el límite de cadena del Node de la torre se habría alcanzado hacia 50.000–55.000 personas. El guardado completo ahora forma páginas de personas y fauna desde cada objeto, con un objetivo de 4 MiB por página y páginas individuales para registros que lo superen. Los lectores actuales aceptan guardados anteriores y validan orden, digestos y recuperación.

El anfitrión dimensiona la reserva virtual de lotes al abrir el motor. Usa un octavo de la menor de la RAM física y el límite de cgroup, a razón de hasta 228 bytes por ranura lógica contando composición y desborde. Esto deja margen para el heap, las copias GPU y la caché de archivos. El máximo probado en la torre x64 es 2²⁶ ranuras. En x64 y arm64 también se comprueba el ancho máximo del buffer que admite Node. Los anfitriones pequeños y motores sin ese perfil conservan la reserva histórica de 2²³. Los buffers crecen en F0 según el uso real y la misma holgura por lote vivo y página nueva. El mismo límite se aplica al contenido físico del piloto frío.

En una sonda aislada Node declaró columnas crecibles para 2²⁶ ranuras, preparó 1.024 y usó una. El tamaño virtual del proceso subió de 2,89 a 11,11 GB frente a 2²³, con RSS de 69 MB en ambos casos. La sonda comprueba el margen de direcciones virtuales de esa configuración. Con la reserva histórica, F0 alcanzaría su límite cerca de 4,19 millones de lotes vivos. La reserva de la torre eleva ese límite a unos 33,55 millones antes de contar las activaciones del paso.

SQLite de la torre limita una fila a mil millones de bytes. Desde 4 MiB de bloques de materia, el guardado escribe partes de hasta 4 MiB y conserva un manifiesto por slot. La misma transacción confirma la materia, el mundo y su agenda. Para el guardado medido de 32,75 MB, el pico de RSS hasta guardar pasó de 425 a 395–397 MiB y la escritura tardó 548–556 ms frente a 467–479 ms. La verificación y la recarga reprodujeron el mismo estado.

La recarga desde un manifiesto recorre sus partes en orden y valida cada SHA-256, el SHA-256 del VMAT, el CRC y el saldo. Conserva las páginas como vistas sobre los tramos. En dos repeticiones por versión sobre el mismo SQLite de laboratorio, el mayor buffer respaldando páginas pasó de 32,75 MB a 4 MiB. Coincidieron el tick y las huellas del mundo y del VMAT. La lectura de Store tardó 462–484 ms frente a 478–514 ms, con picos de RSS de 163–198 MiB frente a 191–224 MiB. Las páginas siguen retenidas hasta cargar el motor y las consultas de prefijo de los BLOB legados pueden materializar el cuerpo dentro de SQLite.

A la densidad de la siembra de 8.000, un millón requeriría al menos 23,7 millones de lotes bajo la misma mezcla territorial y corporal. Con la media de 5,85 MB para 46.603 lotes, el VMAT ocuparía unos 2,97 GB. Falta medir la recarga perezosa de páginas, la RAM comprometida y el tiempo por paso a esa escala.

La crónica del coordinador incorpora las altas de cada dueño en orden. Una sonda en Node 22.23.3 rechazó la llamada anterior con 125.000 argumentos y anexó un millón de entradas con el recorrido nuevo. La sonda cubre la forma de anexar. El arranque de un motor de esa población requiere también medir el directorio de organismos, el reparto y los buzones. La época natural reserva 4.194.304 filas combinadas para fauna y personas, incluidas las bajas que esperan reciclaje. El tamaño de la política por fila y la reconstrucción del índice por dueño intervienen en su coste efectivo.

## Ventana de ocho dueños con CUDA

Una siembra de 32.000 habitantes, seis pasos de calentamiento y ocho medidos por brazo, usó los núcleos físicos 0–7 del mismo dominio L3. Los p95 de los dos bloques, en milisegundos, fueron 827 y 849 en CPU, 817 y 830 con la 5070 Ti en el dueño 2, y 785 y 926 con la 5070 Ti en el dueño 2 y la 2060 en el 5. En el reparto inverso, la 2060 perdió el canal durante el calentamiento de una repetición. El motor completó esa ventana en CPU para el dueño afectado y el banco excluyó ese brazo de las aceleraciones. Los ocho brazos conservaron el saldo y cerraron con cero violaciones. En el segundo bloque se recuperó el control CPU antes de repetir la ventana de la 5070 Ti, tras el vencimiento global del lanzador.

La percepción CUDA aportó trabajo aceptado en ambos patrones de reparto. El tiempo medio de la 5070 Ti cruzó el del control y el resultado con dos tarjetas varió entre repeticiones. Por ello la asignación queda como opción de laboratorio. Las huellas de cierre de varios dueños pueden divergir entre brazos.

## Directorio de ranuras vivas

`CARTA_INDICE_UID=1` habilita en el banco una tabla compartida de ranuras por UID. Cada dueño lee la generación en el mismo frente que consulta. El coordinador compara las columnas de vida y UID entre ambos lados al publicar, y reconstruye el índice si cambia su contenido o el número de ranuras. Durante el paso, los dueños leen el frente anterior. Tras una baja, la referencia caduca al cambiar de frente y la ranura se recupera con otra generación. Una cesión cambia el dueño de la fila.

En una sonda serial con un millón de filas y ocho lectores, el índice ocupó 8 MiB compartidos frente a 348 MiB de heap que retuvieron ocho mapas. El motor con ocho dueños cerró cuatro corridas de 64.000 habitantes sembrados con 63.978 mortales, saldo exacto y cero violaciones. Con el índice, la media del paso fue de 1.269–1.383 ms frente a 1.283–1.403 ms en base. El p95 fue de 1.693–1.806 frente a 1.579–1.644 ms. Se conserva como opción de laboratorio por el coste de cola observado. La sonda del índice mide solo la representación y la consulta de identidades.

## Reparto inicial ponderado

Un brazo con `repartoInicial: "poblacion"` usa tramos contiguos del orden Morton y pondera cada página inicial por uno más su número de personas. La asignación se calcula al abrir la época, antes de la incorporación de halos. El experimento conserva la misma afinidad CPU y los ajustes del mundo para ambos brazos.

A 64.000 habitantes sembrados y ocho dueños, la media del paso fue de 1.332 ms con carga uniforme y 1.240 ms con ponderación. El p95 pasó de 1.606 a 1.493 ms en los ocho pasos medidos. La mediana del dueño crítico en actuación pasó de 443 a 403 ms y los pares vecinos de frontera de 479 a 478. A 32.000 habitantes, la media cambió de 906 a 899 ms y el p95 de 1.407 a 1.376 ms en 24 pasos. El dueño crítico en actuación subió de 314 a 342 ms y los pares de frontera de 479 a 490. Los cuatro brazos conservaron el balance. Las ventanas cortas y la distinta respuesta de actuación mantienen la ponderación como opción de laboratorio.

## Escritura y recuperación a escala

Un SQLite sellado al tick 12 con 63.980 personas y 11.140 animales ocupó 594,2 MB. Store escribió el corte en 8,57 s y lo leyó en 6,43 s. La reconstrucción posterior del motor tomó 6,59 s y se verificó un paso con ocho dueños. Coincidieron las huellas de SQLite y VMAT, el orden de los UID y el saldo. La confirmación de una copia de ese archivo con el origen en caché tomó 0,25–0,32 s en NVMe y 5,89–5,99 s en HDD. Ese tiempo de copia excluye codificación, validación y arranque.

En siete páginas de personas se midieron 28,6 MB en JSON, de los cuales 16,9 MB eran las políticas. Sus 212 pesos por persona ocuparon 7,0 MB en Float64 con los mismos valores. La compresión de toda la muestra con gzip nivel 1 ocupó 16,2 MB y recuperó los mismos bytes. Ambas sondas midieron representación, antes de integrar un formato de guardado.

### Políticas Float64 en el guardado completo

`CARTA_SNAPSHOT_PACKED_PEOPLE=1` habilita la escritura de `snapshot-parts-v3` en el servidor y en la pasarela con worker. Para bibliotecas se elige con `StoreOptions.snapshotPackedPeople`. Las páginas de personas guardan JSON UTF-8 para los atributos y un bloque Float64 little-endian para las políticas del ancho actual. Una máscara marca las filas que usan el bloque. Las demás filas conservan sus campos en JSON. Cada página conserva un SHA-256 y un recuento de bytes y filas. El lector actualizado reconoce las tres versiones con cualquiera de los modos de escritura.

En cuatro corridas alternadas sobre un corte de 63.980 personas, el SQLite confirmado pasó de 594,2 a 442,5 MB. Las páginas de personas pasaron de 443,5 a 292,0 MB. En la mediana, Store escribió en 4,70 s frente a 6,37 s y reabrió en 5,32 s frente a 6,83 s. El pico de RSS en lectura varió entre corridas y su mediana subió un 3,2 %. Coincidieron los 13.563.760 pesos, las huellas de las personas en su orden, la materia y los archivos adjuntos. Una reapertura adicional con el Store predeterminado avanzó del tick 12 al 13 con ocho dueños y saldo exacto en ambos cortes.

### Reanudación con 128.000 habitantes sembrados

Un ensayo sintético de 640×384 usó ocho núcleos físicos del mismo L3, reparto inicial por población y cuatro pasos de calentamiento. De los ocho pasos medidos, la media fue 2,91 s y el máximo 3,23 s. Al tick 12, el escenario tenía 127.962 personas, 10.952 animales y 1.026 páginas activas, con entre 15.908 y 16.129 personas por dueño.

Reunir el corte tomó 8,50 s y escribirlo en Store 11,22 s. El SQLite confirmado en NVMe ocupó 779,1 MB. Un proceso aparte leyó el guardado con Store predeterminado en 10,35 s, verificó el archivo, 27.127.944 pesos, el orden de filas y los 120,9 MB de VMAT, y avanzó al tick 13 con ocho dueños. El libro de átomos y energía cerró en ambos cortes. El pico del grupo de control fue 13,87 GiB. Las marcas comprueban una ventana corta de cálculo y recuperación. La evolución demográfica se mide aparte con el panel natural.

### Apertura del motor en una pasada

Al abrir una época, el coordinador separa terreno, personas, fauna y estructuras por la página que las contiene. Visita cada colección una vez y entrega las páginas en el orden anterior. En un par sobre el mismo guardado de 128.000 sembrados, reconstruir el motor pasó de 12,39 a 6,66 s y el pico de RSS del proceso de 9.535 a 7.969 MiB. El primer paso tardó 5,57 y 5,49 s. Esas medidas separan la apertura de la carga de Store y de la ejecución del paso.

Ambos brazos cerraron el saldo, el reparto y los censos del paso 13. Sus SHA posteriores al paso difirieron. Los controles de apertura cotejaron el remanente local y el contenido deserializado de los 854 mensajes remotos, en el mismo orden y destino. Coincidieron esos controles. V8 puede codificar arreglos equivalentes de dos formas. Al cargar en paralelo, las altas y los lotes pueden recibir ranuras en distinto orden antes del primer paso. La comparación acredita el contenido del reparto de apertura y el balance de reanudación.

### Tiempo de verificación

La huella canónica agrupa hasta 1.024 números ordinarios por tanda, tras leer cada posición. El formato conserva los huecos, el signo de cero y los rechazos de números no finitos. En un par de lecturas del mismo SQLite de 63.980 personas, el cálculo del SHA-256 pasó de 8,98 a 8,23 s, con la misma huella. El pico de RSS de cada proceso ocurrió durante su carga. Una caché de orden de campos se descartó porque no redujo el coste de forma reproducible y sí elevó el pico de memoria.

### Afinidad y coste de publicar el frente

Tres aperturas del mismo SQLite de 128.000 midieron los ticks 17–24 con balance exacto y cero violaciones. En la torre con carga de laboratorio, ocho dueños en la L3 de 96 MiB tardaron 4,09 s por paso en promedio y 5,95 s en el mayor de los ocho pasos. Ocho repartidos entre ambas L3 tardaron 6,21 y 8,39 s. Doce repartidos tardaron 4,73 y 6,33 s. El plazo global interrumpió el brazo de doce después del tick 23 y se repitió ese brazo por separado. Son ventanas cortas que incluyen la planificación del sistema y el tráfico compartido.

Con ocho dueños en la L3 grande, la mediana del dueño más lento fue de 1,20 s en actuación, 1,18 s en aplicación y 0,23 s en percepción. Una sonda aparte midió la publicación completa de la tabla compartida con 138.914 ranuras asignadas. Copiar 32,37 MB y publicar llevó 3,67 ms en promedio y representó como máximo el 0,142 % del paso. En esta escena, las mejoras de actuación y aplicación tienen mayor margen sobre la latencia total que optimizar la copia del frente.

### Vecinos de radio corto

El perfil de V8 sobre el dueño 0 del corte de 128.000 atribuyó a la búsqueda de vecinos 1.244 de las 1.576 muestras de convivencia. Las consultas de personas en radio de hasta dos celdas agrupan las ranuras de una página en subceldas de cuatro por cuatro. La visita sigue el orden anterior de páginas y ranuras, con la misma prueba de distancia.

Un par con el mismo SQLite y ocho dueños en la L3 grande midió seis pasos tras calentar dos. La mediana de aplicación del dueño crítico bajó de 1.221 a 335 ms. La del paso bajó de 3,15 a 2,21 s y el pico de RSS subió de 6.548 a 6.878 MiB. Ambos brazos cerraron el saldo exacto con 127.944 personas y 1.026 páginas. Sus trayectorias de fauna difirieron.
