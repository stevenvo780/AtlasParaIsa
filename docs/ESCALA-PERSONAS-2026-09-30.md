# Optimización algorítmica de personas

Estado al 01-10: estudio técnico completo; puerta de implementación con ganancia
**NO CUMPLIDA**. Referencia `main bb483260b2489fe62b113d620e5f56e5f3676dbc`;
rama propia `sprint/escala-personas-20260930`. El banco cerrado pasa identidad en las
tres escalas, pero ninguna candidata supera ambos controles de 4500. Las fuentes FA
de este árbol son experimentales y su dist previo está desactualizado:
**NO ACCEPTED / NO INTEGRATE**. No hay aceptación final ni FIN.

Tras la urgencia de disco del01-10 se eliminaron164,3GB de copias propias en/datos.
Sólo se retienen las entradas originales de700/2000/4500:24,916GB; los perfiles,
digestos y recibos quedan conservados. Política vigente:40GB propios de perfil
en/datos y eliminación de cada escena temporal al cerrar su uso. No se reutiliza
el helper que acumulaba copias. Las futuras mediciones usarán el mismo disco
temporal para controles y candidato.

La poda de cooperación se ensaya aislada en otra rama propia:37focales ytypecheck
PASS, diagnóstico independiente de20ticks en2000/4500 bitidéntico y36,69%/39,40%
de comprobaciones candidatas evitadas. El controlador cancelado quedaFAIL;
la colección de los cuatro casos cerrados es independiente. Esto no demuestra
ganancia de tiempo ni satisface las puertas1200/600. CI larga y rendimiento siguen
pendientes; ninguna fuente de este árbol se acepta por esos contadores.

La transferencia acredita exactamente 278 entradas TS/tests/configuración/arnés
de la candidata; no acredita compilación ni aceptación de rendimiento.

El perfil de 600 pasos en cada escena privada sitúa personas en el 63,094 %, 71,447 %
y 78,365 % del paso en las escalas aproximadas 700, 2000 y 4500. Sus medias de pared
son 91,694, 324,770 y 1908,871 ms/paso. Las escenas tienen distinta edad, territorio,
fauna e historia: estos datos describen su crecimiento, sin demostrar por sí solos
una complejidad asintótica causada únicamente por la población.

La prioridad de Steven del 30 de septiembre sustituye B ola 2 por algoritmos de
personas. T115/T117/T120 quedan detenidas en `c254f5a`, `f254d52` y `147d834`, con
sus puertas pendientes. La adenda añade el estudio de CPU multihilo determinista,
GPU y otros componentes superlineales, y exige implementar según la ganancia.

## Índice de fauna ensayado durante personas

Este mecanismo describe la candidata lazy rechazada para aceptación de escala;
la mejora parcial de2000 no autoriza integrarla. Se conservará en una rama propia.

La elección de un plan de caza recorría `world.animals` para cada celda candidata.
El índice agrupa las referencias por coordenadas en el orden del arreglo original.
Se construye en la primera consulta de la fase, devuelve una lista local filtrada
por salud y conserva los comparadores originales. Cada retirada mantiene el filtro
por ID original, incluidos todos sus duplicados, y actualiza sólo las celdas afectadas.

El ámbito síncrono se elimina en `finally`: ningún índice se reutiliza entre pasos
ni se serializa. En las rutas reales de esta fase las coordenadas y los IDs de los
animales permanecen estables; la salud se consulta en el momento de cada lectura.
Un cambio de referencia o longitud del arreglo obliga a reconstruir. Una ruta futura
que cambie coordenadas o IDs dentro del ámbito necesitará invalidación explícita.

Con A animales y Q consultas, las búsquedas pasan de O(Q×A) a O(A+Q+Σk), donde k es
el número de referencias de las celdas consultadas. La retirada global por ID y
la sincronización de fauna tras una caza conservan su coste y su comportamiento.

## Puertas y mediciones

La variante aislada lazy pasa seis semillas (`7, 51926, 104729, 20260919, 8101, 8103`)
por 1200 pasos contra la referencia: 78 cortes canónicos y seis finales idénticos.
Typecheck y suite completa pasan: 1642 pruebas, nueve omisiones heredadas y cero
fallos, después de dos intentos con fallos de temporización conservados como evidencia.
Se redujo la concurrencia de archivos a cuatro sin cambiar pruebas ni umbrales.

Cada escena usa el mismo SQLite privado, parámetros completos, 600 ticks, hilos=1,
Inspector y heap de 16 GiB. Los controles y candidatos se ejecutan secuencialmente;
se auditan fuentes, digestos, conteos, diarios y recursos efectivos. Nice=19,
afinidad 6–31, SCHED_IDLE, E/S idle y TMPDIR privado. Los snapshots de recursos
acreditan los momentos observados, sin constituir una traza continua.

| Escala | Main antes: pared/CPU ms | Índice: pared/CPU ms | Main después: pared/CPU ms | Resultado |
|---|---:|---:|---:|---|
| ~700 |221,346 /258,987|162,156 /193,758|153,754 /182,897|Identidad PASS; ganancia inconclusa por deriva|
| ~2000 |445,994 /504,490|412,332 /470,517|436,868 /495,464|Identidad PASS; mejora media observada|
| ~4500 |1987,984 /2120,608|2658,589 /2835,976|2446,815 /2631,098|Identidad PASS; rendimiento NO CUMPLIDO|

En 2000 la media de pared baja 5,62–7,55 % y la de CPU 5,03–6,73 % frente a ambos
controles; los percentiles y máximos presentan resultados mixtos. La deriva entre
controles es −2,05 % de pared y −1,79 % de CPU. En 700, la deriva es −30,54 % y
−29,38 %, respectivamente, y el índice queda entre ambos controles. Una tanda no
demuestra repetibilidad causal ni una mejora en todas las métricas. En4500 la deriva
es+23,08%pared y+24,07%CPU. Fauna, programas y lecturas empeoran ambas medias frente
a ambos controles; la deriva limita atribuir causalmente toda la diferencia al código,
pero no permite declarar ganancia ni aceptarFA para escala.

Los ensayos aislados de requisitos de cooperación y copias efímeras también pasan
sus puertas de semillas, suite y escenas700/2000/4500. En 2000, requisitos mejora
ligeramente pared y empeora CPU; copias empeora ambas medias. Se conservan esos
resultados y no se combinan por su mecanismo. En4500 programas da2680,144/2960,697ms
de pared/CPU y lecturas2866,573/3149,302ms, por encima de ambos controles.

El driver terminóPASS el2026-10-01T08:39:41.437Z; root verificó PTY92560exit0 y
PID377870ausente a09:06UTC. La colección independiente recompone3000filas,
17468comprobaciones,25artefactos y12guardas. Son puertas de identidad/auditoría;
la puerta de rendimiento queda abierta por falta de ganancia.

El confirmatorio700FA se preparó y probó sintéticamente, pero quedó
**NO RUN / CANCELLED / SUPERSEDED** tras el resultado4500. Los cuatro helpers finales
preparados pasan sus comprobaciones estáticas; el plan final sóloFA quedó
**NOT RUN / SUPERSEDED** y no es el plan vigente de aceptación. No se ejecutó ni se
aceptó una combinación final.

## Estudio ampliado

V8 atribuye a cooperación 908,667 ms/paso en la escena grande, el 59,989 % del tiempo
atribuible a personas. Padres e hijos inclusive no se suman; GC global se presenta
separado. Los vecinos ya tienen índices y el catálogo ya indexa sus pendientes
incrementalmente: no se proponen nuevos índices para sustituir recorridos inexistentes.

Ecología y kernel juntos representan 9,731 %, 6,602 % y 3,847 % del paso. El piloto
CPU de T115 acelera un kernel aislado 4,56×, con más CPU y memoria; extrapolarlo a
ambas pasadas daría aproximadamente 1,082×, 1,054× y 1,031× del paso, antes de
sobrecostes y sin una medición de T120. Fauna y checkpoint requieren separar hojas
puras, movimiento y validación antes de decidir un backend paralelo.

El prototipo CUDA mueve 136 bytes por tesela en cada dirección y añade IPC. Un tick
ecológico completo requiere devolver nueve campos numéricos del kernel y food,
80 bytes por tesela más presencia/metadatos. Los deltas y su coste durante los otros
nueve pasos todavía no se han medido. El ancho de banda compartido, la baja capacidad
FP64 de las GPU de consumo, empaquetado y sincronización determinan el punto de cruce;
la ocupación observada no reserva recursos. CUDA debe conservar `--fmad=false`.

E.1/T145 simultáneo cambia qué ve el siguiente actor dentro del tick, según el plan
vigente. No cumple la puerta bit a bit contra main. El estudio lo explica; una vía
especulativa equivalente necesitaría validar todas las lecturas y conflictos en orden.

Orden vigente: evaluar la nueva poda de cooperación; diagnóstico de checkpoint y
hojas puras de fauna; CPU compatible; GPU tras resolver transporte. La nueva candidata
desdec4a8612 vive aislada en `escala-personas-cooperacion-poda-20261001`: admisión del
grafo local después de remembered, stock limitado al dominio estable de la decisión,
fallback y poda de seis máximos conservando Math.max/NaN/±0, getters, Proxy,
intrínsecos y todos los resolver/LRU/errores. Su revisión de frontera es de diseño;
activaciónA/K, coste de admisión, ganancia y puertas completas no están acreditados.

## Atribución V8 pareada4500 cerrada

La reagregación lee sólo los tres perfiles cerrados de600pasos; dos cálculos
independientes coinciden por función y archivo, con104sourcemaps/fuentes cotejados
y nueve snapshots propiosNI19CPU6–31PASS. Conserva deltas negativos y no ejecuta
nuevas simulaciones. ValoresSELF / INCLUSIVE enmsV8/paso:

| Ruta | Main antes | Fauna | Main después |
|---|---:|---:|---:|
| choose |132,833 /1025,345|44,197 /1261,669|176,209 /1250,813|
| huntPlan |18,211 /20,698|1,142 /11,119|23,126 /26,195|
| cooperationOpportunity |1,923 /760,921|2,880 /1065,911|2,595 /918,667|
| practicedRecipeToTeach |103,220 /605,988|145,955 /858,165|125,623 /731,784|
| resolveTechnologyRecipe |25,279 /328,295|36,982 /461,500|31,021 /391,073|
| faunaEn |—|4,253 /9,095|—|
| construir |—|4,638 /4,638|—|
| retirarFauna |—|0,055 /0,131|—|

PersonasV8:1245,543/1596,998/1525,872ms/paso. GCglobal separado:
385,757/534,579/469,826ms/paso, sin atribución a personas. Caza baja inclusive y
choose bajaSELF; choose inclusive y personas crecen, con más peso también en rutas
de cooperación sin cambios. No se suman padres e hijos; construir ya está incluido
en faunaEn. MuestreoV8, relojes distintos y deriva limitan la atribución causal:
el ahorro local no acredita ganancia total.

La evidencia privada se conserva en `/datos/tmp-atlas-lab/balance/`:

- `perfil-escala-20260930.md` y `perfil-personas-v8-20260930.md`: tablas y referencias.
- `estudio-optimizacion-20260930.md`: estudio CPU/GPU/superlineal priorizado y revisiones.
- `codex7-personas-lazy-collection2000-root1-20260930.json`: recibo independiente de
  4291 comprobaciones y 25 artefactos, SHA256
  `e5b8125706cde7414aef76a447cf8732ae9c48b6b5238580ffdd2e58ee0511d3`.
- `revision-rendimiento-personas2000-20261001.md`: mejora de medias, colas mixtas y
  limitación de la escala 700.
- `codex7-personas-lazy-collection4500-root1-20261001.json`: identidad/auditoríaPASS,
  sin ganadora de rendimiento, SHA256
  `0513095e5f4f0dc6af837c95b259cfff61c382b6603dd465509b385f28aa9488`.
- `perfil-personas-v8-pareado4500-20261001.{mjs,json,md}`: helperSHA256
  `9b064a637d8f890be988338afb4292cd1c96a3f4aafac308685eca39bcf714a9`, JSONSHA256
  `b6dbec35b15ef42b902071dda99b8947153157fe4a4b47a592276e876124f1bb`, informeSHA256
  `6b231875b6f5128c9db28d65efab665f3fd291001569d0b216c8a4296c921b81`.
- `cooperacion-poda-frontera-20261001.md`: revisión del diseño, SHA256
  `4a3e99c0ea0773f674af33ddda96d72a308eb7c8e03b29acde32b96813a45798`.
- `codex7-personas-confirmatorio700-20261001.mjs`: preparado y supersedido sin
  ejecución científica, SHA256
  `e12f9830c890c4d8ef535010b5dbccdc4444f8d7e8a6db602efe5828ce1356ca`.

Contabilidad física corregida 2026-10-01T14:30:49.037Z: se liberaron 164305096704 bytes asignados únicos en/datos, incluidos los2.760.704bytes del smoke. Los169.051.217.920bytes iniciales sumaban tamaños de paths y contaban4.748.902.400bytes de dos enlaces duros a originales que siguen presentes. Los recibos de borrado originales no se alteran; corrección /datos/tmp-atlas-lab/balance/codex7-limpieza-disco-contabilidad-fisica-20261001.json, SHA256 eeefe41319b40c492f5d6df281871638c7b7449d645d3492df5403ed62fb675c.

Estado vigente 2026-10-01T15:23:29.689Z: CI3 cerrada PASS /datos/tmp-atlas-lab/balance/codex7-cooperacion-poda-ci-root1-20261001-attempt3.json, SHA256 bd72ae6889d518437b8e2789c1881b1d24e4b63510c010e5a2a95104eaa59114; typecheck nativo, Vite y emit server, suite exacta165ficheros/1653pruebas/1644PASS/9SKIP/0FAIL y manifiesto853a26b1360834139ca17795e72c50b084c378d6b292556e2eb305af84fce1a8. Paridad seis semillas×1200/78hitos/6finales: 478edf974d73b46d2853536e03bdc2748b88ee1ec2d9f9d278242482b688e461, ninguna normalización; sources/inputs/executados estables. Attempt1FAIL de recursos y attempt2FAIL por heap heredado de réplica permanecen registrados. V6 fija heap16GiB del hijo y su revisión focal independiente acredita esa herencia; CI3 valida el resultado real. El wrapper y preloader externos permanecen QUIET y en revisión RO. Sin perfiles600 ni ganancia aceptada.

Estado vigente 2026-10-01T16:19:18.878Z: ROOT2 nuevo banco vivo verificado PID1210528/sesión80301, iniciado2026-10-01T16:15:56.165Z, nuevoROOTbundle5edd867fcb5c888139eb36af7e4bb4644c35746e2febe7d6f9b2efaea5d774b2, wrapperff739. Revisión focal de runtime efectivo GO30checks/14adversarios, sin modificar mundo/CI. Escala700 comienzaMAINantes; nueve600casos seriales y eliminación de cada SQLite privada tras caso/auditoría cerrados. Originales intactos; source/helpers/params congelados. No se editará motor ni se ejecutará otraCI/física propia en paralelo. Resultados aún RUNNING, ninguna cifra de ganancia aceptada.
