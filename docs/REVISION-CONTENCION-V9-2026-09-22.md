# V9: contención visible durante la provisión familiar

Propuesta sobre `eaa2709b24ef02623921ba39bf32159a0892b4e1`, en la rama aislada
`sprint/family-contention-v9-20260922`. Reglas 9, protocolo 9 y SQLite 4. No se modifica
el experimento V7/V8 congelado ni se publica esta rama.

## Evidencia previa

El diagnóstico read-only está en `/tmp/atlas-family-bottleneck-20260922/report.md`.
Usa el corte ya capturado a las 11:04 UTC y dos repeticiones exactas de 1007 a 2400 ticks,
sin intervenciones, Store real cada 20: población, nacimientos, muertes y todos los
totales coinciden con el corte. La fuente V7 es
`783b2dc78b0361a51e390c2e015429a984c50f8b1b6ce73bbd941d7e4d30778d`; V8 es
`43399ac163978a1ccaf5b3f30fbbc9e3e590c99a2da0cb1365cbfd87e8d2cbde`.

1007 sí tiene parejas inicialmente aptas y no emparentadas; no existe filtro de
sexo. n2/n4 están juntos y confiados en t120, pero sólo tienen .060932/.0609485 de
reserva. V8 permite seis cosechas por .050082938, todas de n2; n4 paga 95 trabajos sin
cosecha porque cada fuente se agota antes de su turno. Al comenzar en t132 ve a n2
con 8/18 trabajos sobre el mismo stock .0064. Una tesela adyacente ofrece .007545.

Un contrafactual dirigido, sólo para verificar factibilidad, cosecha allí .007448
en t149 con movimiento y 18 trabajos reales; sin esa comida obtiene cero. Invertir
el orden de dos trabajadores empatados 17/18 invierte el ganador: no se propone
cambiar el scheduler ni resolver empates por identidad. En los retargets posteriores
el compañero aún no había anunciado su próxima elección; esa competencia futura
no se trata como información disponible.

Evitar pérdida de trabajo no garantiza un nacimiento. Las seis cosechas observadas
no cubrían el déficit conjunto .0781195 para alcanzar .1 en cada progenitor. Después
dominan dispersión, falta de confianza entre los aptos y deterioro corporal; desde
t21332 ningún fundador queda dentro de edad fértil. `share` consume una porción para
aliviar hambre/energía, sin aumentar inventario del receptor: no redistribuye reservas.

Al mismo horizonte día 6, los nacimientos V7→V8 de 1007/1012/1013 son 0→0, 10→9 y 19→20;
las muertes 4→5, 0→0 y 1→2. Las otras semillas prueban posibilidad de composición de
los requisitos, no supervivencia garantizada. Las muestras cada 120 son posteriores
al nacimiento y pueden perder las condiciones previas; el replay por tick resuelve
esa ambigüedad sólo en el primer día de 1007. No se ajusta V9 por desenlaces tardíos.

## Regla acotada y conservación

`family.ts:earlierForagerExhausts` es una consulta pura. El selector le pasa sólo
personas cercanas, duración real de trabajo, capacidad de extracción y previsión
corporal basada en las tasas existentes. Además verifica distancia local. Considera
un trabajador únicamente si ya está en la fuente, tiene trabajo pagado, acción y
destino de cosecha, y puede retirar todo el stock observado.
Los datos ajenos observados son posición, acción, destino, progreso, habilidad de
cosecha, inventario, cuerpo y plazo actual de reconsideración (`decisionAt`); el
plazo permite reconocer una reevaluación pendiente, sin revelar qué elegirá después.

La comparación usa el trabajo restante del observador como cota inferior de su
terminación: supone llegada instantánea sólo para no sobreestimar certeza sobre un
trayecto aún no realizado. El otro puede haber actuado ya en ese tick; por eso una
ventaja de un tick, igual que un empate, se deja incierta. No se consulta el orden
global de personas. La intención ajena debe durar hasta el cierre previsto y las
necesidades previstas no deben forzar una reevaluación urgente. Es una previsión
local de continuidad, no una certeza: órdenes, eventos, regeneración o interrupciones
futuras pueden cambiar el resultado.

No suma supuestas extracciones de varios competidores ni asigna una reserva a nadie.
Stock suficiente para sobrevivir a una cosecha, espacio insuficiente del trabajador,
actores lejos, tareas distintas y trabajos no iniciados no bloquean la fuente. Sólo
se aplica al motivo de reserva familiar. Comer por necesidad y la autoridad de una
orden explícita no usan esta exclusión. Se conservan costes, extracción, umbrales
corporales/reproductivos, población, carta y S/I.

V8→V9 valida primero y copia el estado, cambiando sólo la etiqueta de ley. Los
estados anteriores 6/7 siguen recorriendo las migraciones; la historia no se reescribe.
Un estado corrupto o de una versión futura se rechaza.

## Controles, ablación y alcance

`tests/family-forage-contention.test.ts` contiene nueve pruebas con variantes:
trabajo avanzado visible, falta de percepción, destino/tarea distintos, intención
caducada, urgencia, stock suficiente, capacidad limitada, trabajo propio adelantado,
empate, margen ambiguo de un tick, trabajo parcial ya perdido, orden humana, consulta
sin mutación y ausencia de alimento. La preparación del fixture paga físicamente el
trabajo observado. La alternativa guarda biomasa; no recibe energía del pronóstico.

El prefijo 1007 t131 se reconstruye desde cero con Store cada 20. Sin comando posterior
la nueva elección alcanza la alternativa, completa su cosecha y cobra >.007; cada
ganancia se coteja con la retirada simultánea del suelo. La ablación sin comida gana
cero. El cuerpo paga esfuerzo; obtener un nacimiento no es criterio de aceptación.

Typecheck y 107 focales ampliados pasan, cero omisiones, 92.8 s: familia, selección,
migración, demografía, senescencia, agua, snapshots y guardado. Revisión independiente
de `family.ts`, su cableado y las siete pruebas sin bloqueos. La suite completa
conjunta se ejecutará en integración; no se presenta este foco como suite completa.
La ablación privada conserva toda V9 y sólo
devuelve falso desde el filtro nuevo: 4 pruebas positivas fallan y 3 controles pasan.
Fuentes privadas congeladas para ese contraste:

- Candidata: `44dc821a75a06f32fd29ec7c7046007849676ee5bddd237a561db4f00874b8dd`.
- Ablación: `ff7e98c30861f8233a39b1470067d86103f43ae5a7884e9fa867dba27464f296`.

En 1007/1012/1013 a t150 la ablación y V8 coinciden en todo World, normalizando sólo
la etiqueta 9→8 para comparar. Los digests canónicos respectivos son:

- `72bbdb9ae7f73257dd1ea7946ce9c9d53b051bd2bbab734d18b49602ba350297`.
- `61918090984ae243fb28c51b867e9fbf968f83e35efc5dbded265dc56baf9262`.
- `10757d7af10fc4a3474f51a994b39a36a91fed68376f4e1ff37e6673139e7353`.

Antes de cualquier cambio de golden se midieron candidatura y ablación: ambas
conservan los tres hashes demográficos 51926 a 1/2/3 días
`32969bf8a6c5fd01`, `93a4fb6e74d7fec3`, `3e1459914a7a5078` y el agua 4821 a 1 día,
cuencas=1: `ad4b5dd88eba765a3df24ccb96296ddfcc740312f4f4842f51c2ba25a4c5270b`.
No se actualizan los hashes. Evidencia privada en `/tmp/atlas-family-v9-audit/`:
`goldens.mts`, `*-goldens.json`, `prefix-ablation.mts/json`, `ablation-tests.tap`.

El replay y los fixtures son experimentos causales cortos. No son réplicas de
sostenibilidad ni un gate del servidor. No se acredita cierre de GOAL.md ni publicación.

## Índice local y coste incremental

Un primer microperfil encontró coste evitable al recorrer todas las personas
visibles por cada fuente. Se agrupan una sola vez por celda; cada grupo conserva
su orden y el helper vuelve a comprobar los mismos predicados. El mapa es privado
de una decisión: no guarda reclamos, recursos ni conocimiento para el siguiente tick.
El índice no cambia el margen temporal ni la ley V9. Typecheck y 44 focales finales
pasan sin omisiones, incluido un control de equivalencia del índice en todas las
teselas del fixture y consulta sin mutación. Otros tres controles verifican el
contrato del laboratorio y su observación sin mutación. Las 66 comparaciones de
World completo y digest entre V9 sin/con índice coinciden: semillas 1007/1012/1013,
cada 120 ticks más prefijos 131/150, hasta 2400. No se normaliza ningún campo entre
esas dos fuentes V9. Artefacto: `/tmp/atlas-family-v9-audit/index-parity.json`.

La ablación final también conserva el índice y desactiva sólo el filtro. Fuente
`450bba6e4ac2b6710417e97eab6a954449ffc3cc7f40a8bc3f20b1f96ad0b227`:
cuatro fallos esperados y cinco controles verdes; vuelve a recuperar exactamente
los tres estados V8 a t150 (normalizando sólo la etiqueta). Se conserva en
`indexed-ablation-tests.tap` e `indexed-prefix-ablation.json`, en ese directorio.

Microperfil: 300 calentamientos y 2000 decisiones por brazo/escena, bloques alternados
de 50. Tres fuentes separadas, conservadas en `/tmp/atlas-family-v9-profile/`: ablación
de la ley, V9 inicial y V9 con índice. No confundir optimización con cambio de ley.

| Escena | CPU media ablación | CPU media V9 inicial | CPU media V9 con índice |
|---|---:|---:|---:|
|16 personas, una fuente|.179045 ms|.185970 ms|.196314 ms|
|64 personas, fuentes densas|.382973 ms|.750976 ms|.292254 ms|

El índice reduce el coste denso, pero añade algo de coste en la escena pequeña.
Incluye reinicio del actor y CPU del proceso bajo carga concurrente; no mide paso
completo, red, SQLite ni p95 del servidor. La primera medida de dos brazos también
se conserva (`microprofile-before-index.json`); el contraste común de tres brazos
está en `microprofile.json`. Fuente final con índice:
`cd11a32b26ffbce2e28c6b0e9bf97196180a1219aefb0e0577b007d669603125`.

## Contraste posterior fijado

**Resultado completado:** las seis corridas terminaron. La revisión de78 ventanas
no acredita mejora demográfica: mortales0→0,24→14 y20→20. Véanse
[resultados y límites](REVISION-CONTENCION-V9-RESULTADOS-2026-09-22.md).

Base V8 `eaa2709`, candidata V9 comprometida y copias de todas las fuentes congeladas.
Semillas 1007/1012/1013, 13 días, 31200 ticks, seis procesos a nice 10 incremental, deadline
idéntico de una hora por trabajo, `engine=world`, `persistencia.cadaTicks=20` y directorios
`CARTA_DATA_DIR` separados. Todos esos resultados anteriores ya fueron observados:
son diagnósticos, no otro conjunto de semillas reservado.

El instrumento sigue exactamente en
`12053834befc95ebedc4bf1bf4c4308ff49c040c21d233f585aa02d3f894f542` (mismos
`family-reserve.ts`, `metrics.ts`, `family-observation.ts`). La preparación y el
arranque rechazan otro hash. `scripts/lab/family-reserve-batch.ts` sólo cambia base,
versión candidata, ruta de artefactos y declaración del alcance; conserva semillas,
cadencia, métricas, procesos y deadline. Se congela junto al manifiesto antes de
ejecutar. Un error/timeout se conserva como tal; nunca se ajusta el horizonte a la
candidata. Queda fuera el gobernador: sus tiempos concurrentes no validan servidor.

El runner histórico V7/V8 congelado conserva hash
`51cca7ca31602cc40f361432bd42e65e5fab4edc4e8ba65787b1d97ed949fddb`; el nuevo V8/V9
tiene hash `a4b4717410100e216cb1c45063ac207bf51e899d727414a651f695868abfdc34`,
incluido en el commit de esta propuesta y guardado de nuevo en cada manifiesto.
Los tests conservan las aserciones de contrato, rechazo de alteraciones, timeout,
integridad y no sobrescritura; sólo actualizan las identidades de versión y ruta.

No se tocarán reglas, métrica o fuentes de la tanda después del arranque. No se
usarán nacimientos o supervivencia para afinar el margen temporal de esta regla.
El manifiesto y los resultados quedarán en `artifacts/family-contention-v9-20260922/`;
el lote V7/V8 anterior se conserva intacto.
