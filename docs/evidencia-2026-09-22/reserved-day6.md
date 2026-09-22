# Corte provisional reservado

Foto única: 2026-09-22 09:39:43 UTC. Fuente: `artifacts/coherence-20260922/reserved-long/batch-2026-09-22T09-21-07-615Z`; copia JSON congelada `/tmp/atlas-reserved-long-inspection.json` (218 ficheros, cero errores de lectura). Sin polling.

64 ejecuciones previstas (32 pares semillas 1000–1031), 24 iniciadas (12 pares 1000–1011), 40 en cola, ninguna completa. Últimos días baseline/candidate: 1000 7/8; 1001 7/7; 1002 7/8; 1003 6/8; 1004 6/7; 1005 6/7; 1006 8/8; 1007 11/21; 1008 7/7; 1009 7/7; 1010 7/6; 1011 7/7. El horizonte común de los doce pares es día 6 (tick 14400), no 30 días.

## Comparación común día 6 (sumas de doce réplicas, baseline → candidata)

- Población mortal viva: 376 → 347; nacimientos acumulados: 242 → 200; muertes: 34 → 21. Causas: sed 32 → 15, exposición 2 → 6, hambre/senescencia 0 → 0. Fundadores mortales vivos: 143 → 153.
- Todos los baseline tienen descendencia; candidata tiene 11/12 con descendencia y seed 1007 sin nacimientos. Máxima generación mortal viva 3 en ambos conjuntos; distribución máxima por réplica baseline: g1=2,g2=3,g3=7; candidata g0=1,g2=4,g3=7.
- Cooperación acumulada: 25679 → 3439; enseñanza 24705 → 2559; intercambio 391 → 356; ayuda constructiva 561 → 518; otras 22 → 6. Conflictos 3 → 0.
- Usos útiles sumados en las seis ventanas completas: 7326 → 8755; beneficio registrado 976.9872 → 1358.2303; usos de inventor ajeno 1430 → 1932; usos con enseñanza aún recordada al cierre de cada ventana 930 → 1394. Menos actos de enseñanza no equivalen aquí a menor uso útil; estos pares incluyen todas las correcciones juntas y no aíslan la causalidad de una regla.
- Sólo ventana del día 6: usos útiles 2030 → 2314; beneficio 266.3965 → 326.7884; de inventor ajeno 358 → 463; enseñanza recordada 238 → 375.

## Indicio a investigar

Candidata 1007: cero nacimientos días 1–21; 3–4 individuos fisiológicamente aptos en cierres diarios 1–8; deja de haber aptos desde día 9; extinción mortal observada al día 13. Muertes finales: 4 sed, 1 exposición, 9 senescencia. Baseline 1007 tiene 3 nacimientos y 9 mortales vivos en su último día disponible (11); al mismo día 11 candidata conserva 4 mortales. La aptitud individual no prueba existencia de pareja local, confianza mutua, reservas ni lugar; falta observar esos gates antes de atribuir un bug. Próximo diagnóstico aislado: seed 1007, compatibilidad/localidad/reservas y trayectoria anterior a senescencia.

## Instrumentación y límites

Las 24 ejecuciones declaran métrica v2 e instrumentHash idéntico `5da6ca99421bc9f4009e8491edc953e1434e9ae028485095aff45c6a56306777`, un único conjunto de parámetros; cada brazo declara su hash físico estable. No hay failure.json en la foto. Las 187 observaciones diarias cumplen población = 16+nacimientos−muertes, causas sumadas = muertes, mortales = población−2, births duplicado coherente, desglose de cooperación exacto y ventanas completas de 2400 ticks. No prueba terminación ni verificación del hash al final (pendiente por diseño).

`durableActivityMetrics` cuenta usos SQL de todas las personas, incluidos S/I protegidos, mientras vecinos/generaciones son mortales solamente. Por eso candidata 1007 registra 17 usos en día 21 con cero mortales: no es una resurrección ni continuidad cultural mortal demostrada. `usosConEnsenanzaRecordada` consulta memoria viva al cierre, omite aprendices ya muertos y memorias olvidadas; es una observación conservadora, no tasa completa de transmisión. Contadores cooperativos son acumulados; usos/beneficio son por ventana. Recetas distintas no deben sumarse como catálogo único. `neighborsReady` no cuenta parejas y no incluye el gate separado de comida portátil. No hay estratificación de uso por mortal/protegido ni causas detalladas de fracaso reproductivo en estos JSON.

Laboratorio usa stepWorld + SQLite, sin gobernador, scheduler, clientes ni red; 24 procesos concurrentes. No se extrae conclusión de performance ni se extrapola resultado a 30 días o a las veinte semillas aún en cola.
