# Objetivo 9 — observación y diseño del ciclo material

**Puerta A: NO CUMPLIDA por coste.** El instrumento queda como candidato de laboratorio; no se integra ni publica. Diseño B entregado, sin implementar la ley. Identidad, cobertura, typecheck y suite pasan; el recálculo independiente confirma el resultado negativo del coste.

## Resultado medido

Baseline de `main`: `bb483260b2489fe62b113d620e5f56e5f3676dbc`, exportado por Git sin modificarlo. Candidato: `sprint/ciclo-material-20261001`. V3 se congeló antes de las trayectorias; V1 y V2 se conservan y sus sustituciones fueron anteriores a los datos. No se cambió ningún criterio, evaluador o preregistro existente.

Panel completo: seis semillas 17001–17006, dos familias, dos rondas ABBA/BAAB, cuatro brazos por grupo: **24 grupos, 96 mundos, 115.200 pasos medidos**. Calentamiento: dos mundos ×300 pasos =600, excluidos del coste. Cada trayectoria medida dura 0,5 días. Ninguna réplica de 20 o 60 días se ejecutó para este objetivo.

Identidad y cobertura: PASS en todos los grupos; comparación íntegra de mundo/parámetros y tablas SQLite en 0/300/600/900/1200 (1200 es el cierre). Incluyendo calentamiento:484 registros de checkpoint y422 comparaciones de identidad entre brazos/rondas. Las fuentes al inicio/final permanecieron iguales. El guardián registró 7.516 muestras y 105.210 comprobaciones de hilos, sin incidencias; el runner conservó 681 guardas. Muestreo de 0,5 s: una deriva o proceso íntegramente entre muestras puede escapar. No se empleó LD_PRELOAD en el benchmark. El código de salida 1 corresponde a la puerta científica fallida, sin timeout ni deriva registrada.

| Familia | Métrica | Sobrecoste estimado | IC95 % | Límite superior ≤1 % |
|---|---|---:|---:|---|
| Nuevos (`fresh`) | CPU | 1,049 % | −0,195 a 2,436 % | NO |
| Nuevos (`fresh`) | Pared | −0,564 % | −4,990 a 4,820 % | NO |
| Estresados | CPU | −0,679 % | −2,068 a 0,756 % | SÍ |
| Estresados | Pared | 1,682 % | −3,286 a 7,771 % | NO |

Estimador preregistrado: media de log((B1+B2)/(A1+A2)) por semilla/ronda, transformada con exp−1; bootstrap jerárquico fijo de 10.000 réplicas, seis semillas y dos rondas, RNG 912037. La puerta exige límite superior ≤1 % en ambas métricas y cada familia. Los intervalos anchos y las estimaciones negativas no acreditan una aceleración; no se excluyen semillas ni ruido, no se repite el panel después de ver su coste.

El coste incluye hooks, ingestión, inicialización, exportación/serialización y escritura buffered real del observador. Fixture, digestos, guardas y escritura del informe se contabilizan fuera del denominador. No hay garantía fsync ni extrapolación a producción, mundos masivos o retención de 20 días.

Recálculo independiente:10.811 comparaciones numéricas +18.765 estructurales =29.576, cero discrepancias;135 SHA de fuentes actuales conciliados. El bootstrap se reprodujo sin importar el evaluador ni ejecutar trayectorias. Se reconstruyen5.630 registros NDJSON;4.505.134 bytes y hashes de los streams son valores registrados, no releídos después de eliminar los sinks temporales. Los exports finales y las filas crudas de coste quedan conservados en `gate-v3-result.json`.

## Capacidades del instrumento

`src/world/material-observer.ts` expone `createMaterialObserver().ingest/exportRows/discard`. Registro externo a World/RNG/parámetros/crónica/SQLite: usos útiles por estructura/día y clase de actor, extracción sin uso, residencia activa y dormida, evaluaciones de desgaste, cruces de rotura y cero, reparaciones y débitos observados. Captura eventos provisionales de clones/rollback y sólo confirma el paso aceptado.

La ruina explícita permanece ausente (`explicitRuinInModel:false`); el salvamento es una cota nominal de plano (`recoveryImplemented:false`), sin transferir materia. Coste pagado y saldo remanente desconocidos se mantienen desconocidos. Exposición activa mide duración de residencia, no frames. Huecos/cargas/historia previa se declaran; no equivalen a cero uso. La retención externa de filas crece y queda por medir a escala larga.

Se modifican únicamente `src/world/index.ts`, `inventions.ts`, `spatial.ts`, `halo.ts`; se añaden el observador, sus pruebas, el runner, documentación y evidencia propia. `halo.ts` registra la fábrica en el inventario técnico de funciones fuera del paso, exigido por una prueba existente; no cambia radios, reglas ni criterios congelados.

## Diseño B

[DISENO-CICLO-MATERIAL-20261001.md](DISENO-CICLO-MATERIAL-20261001.md): deterioro cerrado por tiempo/prefijos meteorológicos enteros, sin iterar pasos dormidos; ruina/desmontaje locales con trabajo y consumibles pagados; recuperación limitada por el coste realmente debitado y pérdidas de depósitos rotos con balances exactos. Ley 0 exige ruta histórica y digestos sin diferencias, incluyendo parámetros. No añade topes fijos.

Propone ocho pares ×20 días con semillas candidatas 18001–18008 y control V13 `social.radioConvivencia=12,social.disolucion=1,social.maxComunidades=64`. Antes de preregistrar deben reservarse semillas y fijarse backend/parámetros/gobernador. Incluye predicciones/refutación de identidad, balance, recuperación útil, natalidad, alimento y coste; cubre riesgos de determinismo y chunks dormidos. La revisión realizada acredita requisitos y aritmética del documento; la crítica adversarial formal que pedirá el orquestador sigue siendo previa a una futura implementación.

## QA y trazabilidad

Pruebas focales del observador:16/16 PASS. Inventario halo:8/8 PASS. Selftest del runner:12 pares iniciales y siete grupos de comprobaciones PASS, cero llamadas reales a stepWorld. `npm run typecheck`: PASS con guarda válida,1,116s. `npm test` completo: **1645 pruebas,1636 PASS,9 skipped,0 fail/cancelled/todo**; TAP369,724s y fase guardada370,217s. Guardián final:741 muestras,116.894 comprobaciones de hilos,0 incidencias. Los9 skipped se conservan; no se presentan como pruebas ejecutadas.

Se preservan los intentos anteriores: suite-v1 tuvo un fallo de inventario corregido y supervisión inválida; suite-v2 abortó por prioridad de descendientes; suite-v3 abortó por la guarda fija6–31 ante16 hilos de afinidad0–25, todos nice19. No acreditan suite verde. El resultado final corresponde únicamente a `suite-v4-night`.

Omisiones de la suite:4 pruebas opt-in de escala/tiempos del host,3 de paridad CUDA sin NVRTC y2 sin la instantánea histórica requerida. No se activaron campañas de escala/GPU ni se reemplazó esa instantánea para este objetivo; no se acredita ese alcance con la suite ordinaria.

`suite-v4-night` usa un lanzador QA nuevo y separado: el objetivo8 heredado autoriza CPU0–31 de00:00 a07:00 Bogotá. Exige todos los hilos observados nice19 y máscara no vacía dentro de0–31, verifica `America/Bogota` en inicio/muestras/cierre y aborta fuera de la ventana o tras1200s; no repara prioridades/afinidades. Shims PATH propios conservan argumentos y entornos sanitizados, sin preload. El benchmark conserva su lanzador original, afinidad6–31, protocolo, datos y criterio de coste.

Evidencia primaria: `gate-v3-result.json`, `gate-v3-real.json/.log`, `typecheck-npm-final.json/.log`, `suite-v4-night.json/.log`, `QA-FINAL.json`, `runner-selftest-v4.json/.log`, protocolos V1/V2/V3, manifiesto de baseline, fuentes de los lanzadores y revisión independiente. [REPRODUCIR.md](REPRODUCIR.md) explica rutas y comandos. Logs completos permanecen en el laboratorio; la copia versionada conserva resultados, resúmenes y hashes. Baseline/runtime y dependencias durables se conservan fuera del repositorio; no se incluyen mundos públicos, credenciales ni binarios en el commit.

Entrega local: rama `sprint/ciclo-material-20261001`; el recibo externo `ENTREGA-LOCAL.json` registra el commit final y retiro del worktree propio. El cierre se anota en la bitácora y se marca con `/datos/tmp-atlas-lab/datos-lab/codex9-FIN`. Esto cierra la entrega solicitada con resultado negativo de la puerta A, sin aceptar el instrumento ni la ley propuesta. `main`, el público, los servicios, la carta y el trabajo ajeno permanecen intactos.
