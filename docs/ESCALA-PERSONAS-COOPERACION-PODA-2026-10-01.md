# Cooperación: poda experimental archivada

Esta variante evita comprobar disponibilidad de instrucciones que no cambian ninguno de seis máximos, con admisión de datos ordinarios, memo local de stock y fallback. Conserva resoluciones, clones, LRU, errores, orden FP64 y limpieza de alcance al terminar personas. No tiene ganancia aceptada y no se integra en la rama principal de escala.

La fuente medida quedó quieta en base `c4a86120745b8aa7dea2d750bece137ce3205350`, digesto de perfil `a105141cc7fa32162e2e296d98407b0f478b85e7906ecb9561832118a6284b8e`. CI3 pasó typecheck, build y suite: 1644 pruebas pasan, nueve omisiones y cero fallos. Seis semillas por 1200 pasos dieron digestos idénticos a la referencia en 78 hitos y seis finales. Estas pruebas acreditan esa fuente; no prueban rendimiento.

El banco ROOT2 terminó FAIL el 2026-10-01 a las 18:16:43 UTC después de aplicar la nueva instrucción de CPUs 12–31. Su guarda histórica exigía 6–31 y queda intacta. El controlador conserva SHA256 `f7273c11b764afefbd6641d3ce45c47d8d63da6a9982e41c4350e5898fe036a1`; la puerta global de nueve casos es NO CUMPLIDA. La copia del caso interrumpido se borró tras comprobar el cierre de sus procesos. No se utilizan sus datos parciales.

Una auditoría independiente valida siete casos completos de 600 pasos: los tres de 700, los tres de 2000 y únicamente MAIN antes a 4500. Compara RAW, diarios, parámetros, conteos, digestos, fuentes, runtime, guardas históricas y disposición de cada copia. El recibo de 113815 comprobaciones está en `balance/codex7-cooperacion-poda-case-only-collection-20261001-a.json`, SHA256 `32d925b07763094b0c663c82b1bba9902e7167a81716feeb0c2333d387a30fd2`, en el laboratorio externo.

| Escala | Pared ms/paso: MAINantes → poda → MAINdespués | CPU ms/paso: MAINantes → poda → MAINdespués |
|---|---:|---:|
| 700 |179,257 →234,118 →192,575|213,737 →272,894 →227,158|
| 2000 |668,370 →974,623 →969,315|746,339 →1060,460 →985,440|

La variante no mejora las medias frente a ambos controles. La deriva de controles limita una atribución causal de regresión: pared/CPU crecen 7,43%/6,28% a 700 y 45,03%/32,04% a 2000. No hay comparación completa a 4500 ni aceptación de escala.

Los V8 cerrados atribuyen a la nueva admisión `recipePowerPruningRejection` 23,740/113,945 ms inclusive por paso a 700/2000. `field` aporta 9,982/48,423 ms SELF y `denseArray` 7,942/37,159 ms SELF. No se suman padres con hijos ni se asigna GC global. La siguiente investigación estudia amortizar la comprobación de forma mediante procedencia privada y alcance efímero, manteniendo la API mutable y todos los errores.

Inventarios, JSONL, V8, diarios y recibos permanecen en el laboratorio. Este commit archiva la implementación y el resultado incompleto/negativo para revisión; no cierra tareas de rendimiento, no publica un mundo y no constituye FIN.
