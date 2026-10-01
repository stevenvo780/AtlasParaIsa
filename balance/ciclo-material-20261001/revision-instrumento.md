# Revisión independiente de instrumento material — objetivo 9

**Estado vigente 2026-10-01T08:05:48.701Z: entrega documental/revisión terminada; QA/typecheck PASS; puerta A NO CUMPLIDA por coste; B sólo diseño, sin ley ni aceptación biológica.**

**Fase 1 completada: 0 bugs confirmados pendientes en el código revisado. Puerta A: NO CUMPLIDA todavía; identidad/coste/typecheck/suite requieren evidencia final.** No se emite PASS de la entrega completa a partir de los 16 tests focales.

Se leyeron completos `codex-goal-9.md`, las prohibiciones del objetivo 8, el módulo nuevo, los tres diffs de hooks y los 16 tests. Se revisó el log real `codex9-material-focused.log`: 16 tests, 16 PASS, 0 FAIL, 0 SKIP, 1.551,300447 ms. Esa ejecución la realizó el implementador; este revisor no repitió su suite ni ejecutó una simulación redundante. El SHA de cada fuente inspeccionada queda en [revision-instrumento.json](revision-instrumento.json).

## Findings ordenados por severidad

Sin findings P0/P1/P2 confirmados pendientes en esta fase. No se presentan hipótesis de uso indebido de la API como bugs reproducidos. Las puertas pendientes se conservan separadas de la corrección del código.

## Evidencia de corrección y límites

| Frente | Evidencia inspeccionada | Resultado de fase 1 |
|---|---|---|
| Estado externo | `src/world/material-observer.ts:29–33,132–141`; registros y capturas en Map/WeakMap, scalars copiados, sin campos añadidos a World o WorldContext | No se encontraron escrituras del observador a World, RNG, journals o esquema persistido. Exportar devuelve copias independientes; test congelado en `tests/material-observer.test.ts:224–231`. |
| Usos y usuarios | `src/world/inventions.ts:367–372,387–391,413–416,450–453`; `material-observer.ts:64–70,195–198` | Comida/agua conservan cantidad retirada y beneficio original del contador, descanso su beneficio normalizado; nunca se deben sumar como una unidad material común. Usuarios distintos se separan en mortales/protegidos/desconocidos. Traslado de comida sin uso solo actualiza stock. Tests `:48–84`. |
| Exposición vs desgaste | `material-observer.ts:4–8,151–153,187–189,250–267`; hooks `spatial.ts:142–145,209–211` | Exposición es duración residente `[from,to)`. Activarse a tick2400 puede producir wear real en2400 con cero exposición transcurrida; son variables distintas. Dormido no gana exposición. Tests `:114–142`. |
| Cruce y reparación mismo tick | `inventions.ts:463–465,475–479,499`; `material-observer.ts:167–174,183–193` | Se registran orden, mínimo, cruces de ≤0,1 y cero y débito 1 madera/30 trabajo; la reparación posterior no borra el cruce. Tests `:86–112`. |
| Clones, descarte y rollback | `material-observer.ts:35–47,218–240`; hooks `index.ts:1418,1495,1511` | El clon comparte la cola inmutable hasta el punto de bifurcación; se aplican solo los eventos del camino confirmado. Descarte no modifica medidas confirmadas; rollback restaura cola pendiente. Revertir una medición ya confirmada se rechaza explícitamente. Tests `:174–211`. |
| Día/ventana | `material-observer.ts:33,106–113,257–268` | Día1 contiene eventos `(0,2400]`;2401 es día2. La duración residente usa el intervalo de reloj complementario, sin convertir activación en un tick de exposición. Parcialidad y huecos se declaran. Tests `:127–142,213–222`. |
| Store, carga y archivo | `material-observer.ts:201–216`; `tests/material-observer.test.ts:244–275` | Una carga inicia otro tramo; no se inventa exposición entre cierres separados. Store puede vaciar pending sin borrar los registros externos ya capturados. El archivo no cargado se mantiene desconocido y el historial inicial es censurado. |
| Ruina y salvamento potencial | `material-observer.ts:87–101,116–117,142–153`; tests `:144–172` | Se distinguen rotura y condición cero. `explicitRuinInModel=false` y `recoveryImplemented=false` reconocen que la ley B no existe todavía. Salvamento es límite nominal del coste, no material recuperado; coste original de legacy es null, y solo construcción observada acredita pago. |

La cobertura declarada se limita a estructuras residentes, pending y activaciones observadas; las ediciones directas de material fuera de hooks no están cubiertas (`material-observer.ts:1–9,97–101`). No se presume observación global retrospectiva del archivo ni historial diario anterior al inicio. `ingest` confirma un camino: el caller debe confirmar después de aceptar el paso; una medición confirmada no admite rollback posterior. La cadena de usos mide servicios registrados, no visitas ni ocupación continua.

## Puertas y revisión posterior requerida

| Puerta | Estado al cerrar fase 1 | Evidencia necesaria |
|---|---|---|
| Identidad ≥6 semillas×1200 pasos frente a base bb483260 | NO CUMPLIDA / pendiente | Runner y protocolo final congelados; identidad canónica completa y SQLite lógico, fuente base independiente y guardas reales. Los120 pasos del test focal con hooks desactivados no reemplazan ese contraste. |
| Coste ≤1% | NO CUMPLIDA / pendiente | Protocolo v2 EVENTOS vigente, no la v1 superada. Semillas17001–17006, dos familias, ABBA/BAAB y dos rondas:96 mundos/115200 pasos. Datos crudos y recálculo del límite superior95% CPU+wall por familia, incluyendo trabajo observado/exporte/serialización según protocolo. Un CI o recursos/coverage fallido es NO CUMPLIDA. |
| Pruebas/typecheck/suite | Parcial:16 tests focales PASS; typecheck y suite pendientes | Logs finales reales con SHA y recursos. La suite del integrador no se duplica. |
| Diseño B sin implementación | Pendiente de requisitos | Revisar el documento cuando esté listo: deterioro dormido determinista, ruina/desmontaje pagados, pérdidas ambientales, localidad/sin topes, identidad exacta ley=0, cribado20d con semillas nuevas y control V13, riesgos/refutación. La crítica formal de la ley la solicitará el orquestador antes de implementar. |

Ningún resultado futuro previsto se registra como medido. La revisión del protocolo/runner/datos se incorporará en una fase posterior, con los SHA que efectivamente se congelen. El revisor no creó FIN, no alteró producción/reglas/preregistros, no accedió a servicios/datos vivos y no lanzó otros agentes.

## Actualización previa a datos — 2026-10-01T06:17:18.638Z

Revisado el diff de `src/world/halo.ts:577–585`, el scanner `tests/halo-radios.test.ts:296–421` y el log `codex9-halo-focused.log`. La exclusión nombra sólo `createMaterialObserver`; no excluye los hooks invocados durante el paso. Las lecturas de estructuras residentes y pendientes ocurren al adjuntar el mundo en la fábrica. Sin hallazgo bloqueante confirmado en este cambio. Log ajeno inspeccionado: **8 pruebas, 8 PASS, 0 fail**, 4148,155432 ms; no repetí las pruebas ni la suite.

La documentación `docs/CICLO-MATERIAL-INSTRUMENTO.md` distingue usos de visitas, unidades de beneficio, exposición de evaluaciones, ruina no implementada y salvamento nominal de recuperación efectiva. No afirma aceptación de la puerta.

**Puerta A: NO CUMPLIDA.** V3, runner y datos finales todavía pendientes; los resultados v1 comunicados (1635 PASS, 1 fail, 9 skipped) no acreditan la suite final. El diseño B aún no está presente. No ejecuté trayectorias ni benchmarks ni evalué el protocolo obsoleto como evidencia de aceptación.

## Protocolo V3 y runner parcial — 2026-10-01T06:25:06.516Z

V1 preservado por SHA; V2 coincide con el SHA de `supersedes` en V3. Comparación independiente JSON V2/V3: cambian sólo `schema`, `frozenAt`, `sourceFreeze`, `supersedes`, `sourceAllowlist`; estadísticas, semillas, fixtures y umbrales permanecen iguales. Manifiesto baseline: 67 fuentes verificadas contra sus SHA y tar coincide con SHA declarado. La procedencia del tar respecto del objeto Git sigue pendiente de verificación independiente.

Revisados `scripts/lab/validar-ciclo-material.ts:5` (imports), `:56` (guardas), `:67` (protocolo), `:95` (fuentes), `:120` (fixture), `:149` (reloj de guardado restaurado por finally), `:154` (todas las tablas SQLite, orden por todas las columnas) y `:168` (NDJSON por fila, buffer 64 KiB, apertura exclusiva, escrituras parciales). Sin hallazgo bloqueante confirmado en este tramo. **No hay PASS global del runner**: ejecución, comprobación de cobertura, estadísticas y selftest todavía pendientes. No se generaron datos ni trayectorias.

## Procedencia Git y diseño B — 2026-10-01T06:30:42.328Z

Baseline PASS: `git get-tar-commit-id` confirma `bb483260b2489fe62b113d620e5f56e5f3676dbc`; regenerado `git archive bb483260b2489fe62b113d620e5f56e5f3676dbc src/world src/shared src/server package.json tsconfig.json` en el worktree propio en lectura. Stream y tar existente son byte a byte idénticos, SHA **37785411452a3bd8b6d4ea4127527160921c052b2c81ac3b9f047688373571c1**. Procedencia del baseline cerrada. Un primer lector Node produjo EPIPE al enviar el tar completo a la utilidad que termina tras leer la cabecera; status0/stdout correcto preservados en JSON. Repetición con cabecera PASS. No hubo datos reales ni escritura en el intento fallido.

Diseño B leído completo, SHA **edf3ef8711a73e2339a2999ad6d82af89dfee0d188a8bb7ef601f2b7007af08b**: catch-up puro determinista O(1) por obra (20–44); ruina y desmontaje local pagado sin crédito doble (46–60); pérdidas ambientales con escalas/restos exactos (62–86); localidad sin nuevos topes y ley0 sin claves nuevas en parámetros efectivos ni estado (88–94); panel propuesto8 pares/20d, control V13 y semillas candidatas sin afirmar virginidad (96–118); riesgos demográficos, coste/determinismo dormido y decisiones pendientes (120–133). No afirma implementación, ensayos ni aceptación.

Recálculo independiente: **25 comparaciones nominales, 0 diferencias**: tasas,20d/4800 revisiones, pérdida mixta3.312.000.000, condición seca0,136, cruces3215/5000 revisiones, ventanas4/10d y2,571/6,429d, saldos de desmontaje y768.000 pasos propuestos. Las observaciones iniciales coinciden con objetivo8; no se convierten archivos de relojes distintos en balance simultáneo. Referencias clave verificadas: clima `index.ts:260`, esfuerzo `:1083`, orden `:1242`, coste `inventions.ts:25`, desgaste `:478`, legacy `terrain.ts:25`, humedad `:104`, params en digesto `digesto.ts:30`, escalas `technology.ts:27`/`material-affordances.ts:5`. Los rangos históricos de inventions corresponden al baseline antes de hooks.

B PASS de completitud/correctitud revisada; referencia API corregida. **Esta revisión no es la crítica formal de la ley futura ni su aprobación.** Puerta A NO CUMPLIDA mientras runner/datos/checks finales pendientes.

## Runner completo y launcher: antes de barrera — 2026-10-01T06:35:26.651Z

Revisados bucle y análisis `validar-ciclo-material.ts:208–468`: quartetos independientes, orden ABBA/BAAB fijo por bloque, ingest antes del guardado, exports/serialización y cierre cobrados, digestos fuera del denominador, warmup excluido,96 mundos/115.200 pasos requeridos. Identidad de los cuatro brazos y de rondas repetidas; hash de todas las tablas SQLite. Bootstrap jerárquico sobre6 semillas y2 rondas,10000 réplicas, estadístico log(Bsum/Asum), CI95 bilateral y extremo superior≤1% en CPU y wall de cada familia. **0 bugs estadísticos confirmados**. No ejecuté trayectorias, benchmark ni selftest duplicado.

Barrera todavía pendiente: refuerzo pedido por parent de topología8+8 y exposición activa/dormida por brazo; selftest con guardas válidas aún no leído. El intento directo comunicado falló finalnice−4 y no se considera PASS. Los selftests escritos usan pasos falsos para verificar orden y sólo inicializan fixtures reales; no constituyen la puerta1200 pasos.

Launcher `run_guarded.mjs:12–83` leído: establece nice19 una vez para todos sus hilos, después de2s sin hijo/cómputo medido. Luego lee nice/afinidad de /proc para hilos del árbol observado cada0,5s y aborta; no intercepta getpriority ni repara durante trabajo. Explicita el límite temporal del muestreo. Faltan logs válidos de la ruta efectiva y evidencia de LD_PRELOAD ausente si no se usa. **Puerta A NO CUMPLIDA; barrera no liberada por esta revisión.**

Trazabilidad: mientras el worker terminaba el refuerzo, al registrar SHA el runner ya tenía517 líneas, SHA `4d8b6dfdf3ca640af7c9f922f7458243d9470a6030d1ddaf925789464625e78d`. El análisis de arriba corresponde al tramo leído de468 líneas. **Ese SHA nuevo aún no está completamente revisado ni aprobado**: delta final pendiente.

## Delta congelado: aprobación estática — 2026-10-01T06:38:35.348Z

Runner completo517 líneas releído, incluyendo tramo220–287 que la salida larga truncó; SHA inicial y final **4d8b6dfdf3ca640af7c9f922f7458243d9470a6030d1ddaf925789464625e78d** estable. **PASS estático,0 bugs bloqueantes confirmados.** Topología8activos+8dormidos ahora comprobada para cada brazo A/B antes del primer guardado; duración mínima independiente[0,1), marcas tick0/1/final y medición completa B para16IDs sin huecos. El archivo consultado es sólo chunk100,100; IDs1–8 retirados a otro archivo generan unknown y FAIL conservador. Ese límite no puede producir PASS falso.

Launcher actual SHA **26ea519ae9e94566da078928004551ffb36bf8d62c906e32c43dfe2295aeb60f**: único delta revisado es metadata de booleans LD_PRELOAD/init. Smoke settling6s leído: **PASS**,14 muestras,182 hilos examinados,0incidencias,6,038538106s, todos los hilos finales nice19/CPU6–31. Registra prioridad entrada15 y previa a establecimiento−4, ambas anteriores al lanzamiento del hijo; no se presentan como guardas válidas del cómputo. Muestreo0,5s conserva su límite explícito.

**Barrera aprobable cuando exista selftest actual PASS con guardas y entorno sin LD_PRELOAD**; falta leer esa evidencia, no se infiere éxito del fuente ni del smoke. La aceptación A continúa **NO CUMPLIDA** hasta datos/checks finales.

## Barrera previa a datos aprobada — 2026-10-01T06:40:13.868Z

Selftest V4 real leído y validado, no repetido: **PASS**,7 grupos de checks,12 pares de fixtures,**0 llamadas reales a stepWorld**, code0,2,212367104s. Wrapper:6 muestras,90 hilos examinados,0incidencias; LD_PRELOAD ausente/initfalse. Guardas internas inicial/final nice19,CPU6–31,TMPDIR correcto. Comprobados otra vez 135 SHA de fuentes baseline/candidato, SHA del protocolo/runtime y runner congelado `4d8b6dfdf3ca640af7c9f922f7458243d9470a6030d1ddaf925789464625e78d`. Evidencia `runner-selftest-v4.json/log` y SHA completos guardados en JSON de revisión. Intentos previos fallidos se conservan y no sustituyen este resultado.

**Barrera PASS** para el único panel preregistrado96mundos/115.200 pasos, más600pasos warmup excluidos. No ampliar muestra, seleccionar rondas/semillas ni excluir wall. La puerta A sigue **NO CUMPLIDA** hasta comprobar identidad completa, cobertura y recursos del panel, upper95CI≤1% para CPU y wall en cada familia, y checks finales. Limitaciones: muestreo de recursos0,5s; GC/interferencia de un proceso;6clusters; media jornada simulada; cobertura final sólo archivo100,100 puede causar FAIL conservador; I/O buffered sin fsync. Suite con preload se evalúa por separado del benchmark. Esta aprobación no es aceptación de la ley futura.

## Resultado real: recálculo independiente — 2026-10-01T07:50:14.739Z

**Puerta A NO CUMPLIDA por coste**, reproducida desde datos crudos con analítica independiente (sin importar evaluador ni ejecutar trayectorias). 10811 comparaciones numéricas y 18765 estructurales;0diferencias. 96 mundos medidos,115.200 pasos,24cuartetos,2304 bloques;2mundos/600pasos warmup excluidos. 484 checkpoints mundo+SQLite,422 comparaciones de identidad entre brazos/rondas,49 exports B y 50 brazos stressed (incluye warmup). Fuentes inicio/fin iguales y 135 SHA de fuentes actuales iguales a los registrados.

|Familia|Métrica|Estimación %|CI95 %|Puerta≤1%|
|---|---|---:|---|---|
|fresh|cpuMs|1.048574|[-0.195089, 2.436460]|NO CUMPLIDA|
|fresh|wallMs|-0.563573|[-4.989921, 4.819635]|NO CUMPLIDA|
|material-stressed|cpuMs|-0.678931|[-2.068123, 0.756224]|PASS|
|material-stressed|wallMs|1.681770|[-3.285849, 7.770796]|NO CUMPLIDA|

Bootstrap propio con aritmética BigInt para RNG LCG32:10000 remuestreos jerárquicos de6semillas y2rondas, cuartetos enteros; cifras coinciden. Fresh CPU y stressed wall tienen estimación>1%; las CI de esos dos y fresh wall no permiten acreditar≤1%. Stressed CPU sí cumple. No se elimina wall ni se amplía panel tras el resultado.

681guardas internas y wrapper7516muestras/105.210hilos examinados:0incidencias,LD_PRELOADausente. Wrapper conserva code1/validfalse; causa científica, sin señal, deriva, timeout ni fallo parcial. Tiempo operativo3757,963578108s<7200: no se necesitó traspaso de supervisor. Cobertura8activos+8dormidos, lowerbounds[0,1),16IDs B y estados físicos/uses finales conciliados; ningún estado final desconocido. Usos no se convierten en visitas, exposición no en frames, costes nominales no en material recuperado.

Límite verificable: 5630 registros NDJSON se reconstruyeron; 4505134 bytes y SHA de stream son valores crudos registrados, porque los archivos temporales ya fueron eliminados. No afirmo relectura de esos bytes. Las pruebas finales/suite pertenecen al parent y siguen pendientes. Evidencia completa `codex9-verificacion-gate-final.json`, SHA `ebcf54dd5e662a8da081368f93108b368b8a1a8e2ab99ed7acf148ab50e4fd99`. **No aprobar entrega A ni declarar objetivo9 cumplido.**

Hallazgo que bloquea aceptación: el requisito de coste≤1% por familia/métrica no está acreditado. Evidencia y reproducción anteriores. No es un bug confirmado del motor. Las estimaciones>1% no prueban exceso concluyente porque sus CI cruzan el umbral; el criterio upper95CI≤1% falla igualmente. Mantener NO CUMPLIDA y panel fijo; no corregir mediante exclusión ni ampliar datos.

Analítica propia: wrapper `codex9-final-recalc-v1.json` code0/validtrue,0incidencias,0,338423231s,LD_PRELOADausente; hijo guardó nice19/CPU6–31 al inicio/fin. Verificador SHA `54a8080879f36cd997cb47c96b6ac40c032c130a543dc01ceaa82e7afb3dfd84`. Comparaciones numéricas: tolerancia1e−12×max(1,|actual|,|esperado|); el veredicto upperCI≤0,01 se compara directamente.

## Cierre QA y entrega documental — 2026-10-01T08:05:48.701Z

Wrapper nocturno leído completo, SHA **285a9f7c103765edc85edb2b49ddcedfa78d67fd85dcb81d4771091e86e8f458**. Política heredada del objetivo8:00:00≤hora America/Bogota<07:00, NI19 en todos los hilos observados y máscara no vacía⊆CPU0–31; comprobaciones inicial/cada0,5s/final, aborto por ventana/deadline, sin reparación durante cómputo. Sólo QA; no cambia run_guarded, V3, runner ni el benchmark de CPU6–31.

`npm test` exacto, script vigente comprobado: **1645 pruebas =1636 PASS +9 skipped;0fail/cancelled/todo**, TAP369.724,378847ms. Se contaron1645 líneas ok consecutivas,9SKIP y0not ok. Wrapper válido code0,370,216954931s,741muestras/116.894hilos examinados,0incidencias,sin LD_PRELOAD. Omisiones explícitas:4pruebas opt-in escala/tiempo,3CUDA sin NVRTC,2sin snapshot histórico. No se presentan como pruebas aprobadas.

`npm run typecheck` exacto (`tsc --noEmit`): **PASS/code0**, wrapper válido1,115552599s,4muestras/176hilos examinados,0incidencias,sin LD_PRELOAD. 135 SHA baseline/candidato y runner todavía coinciden con fuentes del gate. Intentos anteriores abortados/fallidos se conservan. Logs/resultados y SHA completos en `codex9-verificacion-qa-final.json`, SHA `09739a528b8b908dac7364ed1827bd0951fd80a5342b4c5827e1ebd838b9b6f4`. No repetí pruebas ni simulaciones.

**Entrega documental y revisión terminadas**, con resultado científico negativo preservado. **Puerta A NO CUMPLIDA por coste** pese a identidad/cobertura/recursos/QA/typecheck PASS. B es diseño completo propuesto: sin ley implementada, sin aceptación biológica y sin sustituir la crítica formal futura del orquestador. FIN/commit/limpieza los gestiona el parent; esta revisión no los ejecuta.
