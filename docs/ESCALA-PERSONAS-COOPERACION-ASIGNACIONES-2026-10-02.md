# Cooperación: asignación diferida del Map de productos — resultado negativo

**Estado: archivado, no aceptado.** El candidato conservó la equivalencia observada, pero SHORT120 no mostró una mejora conjunta de pared y CPU frente a ambos controles MAIN. A 4500 fue más lento que MAIN antes en ambas medias; el menor coste frente a MAIN después coincide con drift del control. Las escenas de 600 pasos y la aceptación de rendimiento permanecen **NO_CUMPLIDA**. No se integra ni se publica este candidato.

## Candidato y procedencia

Base: `c4a86120745b8aa7dea2d750bece137ce3205350`, rama `sprint/escala-personas-asignaciones-20261001`. El cambio experimental retrasa el Map vacío de productos en `localRecipeInputs` cuando el constructor capturado en el arranque stock sigue siendo el nativo. Lo crea al primer input de producto o al alcanzar la iteración de productos; conserva la construcción temprana para constructores decorados posteriores y los caminos de errores cubiertos por las pruebas focales. La frontera declarada es el arranque controlado stock; no se extiende a cualquier decoración anterior a importar el módulo.

| Archivo medido, conservado sin cambios al archivar | SHA256 |
|---|---|
| `src/world/society.ts` | `f518d44e90c71eea903dd463070bc7b37b21aa1128dd0f488b0b30987592210c` |
| `tests/cooperation-allocations.test.ts` | `20fe23aecc987df62a36c817fe6c821e4da485c737fe268e1d501ae4aaa907d1` |

El stage portátil conservó 676 archivos, sólo esos dos cambios, con agregado de fuentes `423d5bc567a340d7be9fb3ac4c9101f0807ecdec661441f0b6a9cdd4c8aec37f`. El sourceFrame MAIN se obtuvo de 231 blobs Git exactos de C4. World MAIN corresponde a la referencia original; no se cambió física, parámetros, esquema, criterios ni instrumentos de medida.

## Puertas observadas

| Puerta | Resultado y alcance |
|---|---|
| Typecheck previo | **PASS**, código congelado; no repetido para este archivo histórico. |
| Build previo | **PASS**, Vite y emit de servidor cerrados con exit0; no repetidos al archivar. |
| Paridad real 6×1200 | **PASS**: 7200 pasos, 78 cortes y 6 finales, cero diferencias contra MAIN, con parámetros default. Es una puerta independiente de la suite fallida. |
| Fullsuite CI8 | **FAIL real / NO_CUMPLIDA**: sesión 22716, terminal exit1. TAP 1647: 1607 PASS, 11 FAIL, 4 CANCELLED, 25 SKIP. Los 11 fallos se clasificaron como 9 relacionados con config npm y 2 de plazos/tiempo; hubo 4 timeouts de 600000 ms. No se observó una aserción biológica fallida, pero las pruebas biológicas interrumpidas siguen sin validar. No se convierte el FAIL en PASS. |
| SHORT120×9 | **PASS_SHORT_DIAGNOSTIC_ONLY**: tres escalas × MAIN antes → candidata → MAIN después; nueve hijos exit0/signal=null. Equivalencia y limpieza cerradas. |
| Tres escenas de 600 pasos | **NO_CUMPLIDA**: no ejecutadas para este candidato. SHORT120 no reemplaza esa puerta. |
| Rendimiento aceptado | **NO_CUMPLIDA**: ninguna escala mejoró conjuntamente pared y CPU frente a ambos controles. |

El commit de archivo conserva un ensayo rechazado y sus pruebas; no acredita integración, publicación, suite completa ni casillas aceptadas. La orden de archivo excluyó nuevas suites, compilaciones y benchmarks, y no cambió los bytes de fuente/test ya medidos.

## Medición SHORT120

Host físico portátil, CPU 0–19, NI 19, SCHED_IDLE 5, E/S idle, Node 22.23.1 stock, heap 16384 MiB, hilos 1 e Inspector iguales en los nueve casos. Cada caso avanzó 120 pasos; **filas 1–20 de calentamiento y 21–120 medidas**, n=100 por brazo. Los resúmenes de 120 no se reutilizaron como estadísticas de 100. Los tiempos siguientes corresponden al paso instrumentado, no a inflación, Store.load, instrumentos finales ni limpieza.

Medias en **ms/paso**:

| Escala | Pared MAIN antes | Pared candidata | Pared MAIN después | CPU MAIN antes | CPU candidata | CPU MAIN después |
|---:|---:|---:|---:|---:|---:|---:|
| 700 | 472.420 | 474.224 | 486.124 | 580.029 | 571.927 | 607.935 |
| 2000 | 1559.200 | 1554.213 | 1559.475 | 1717.606 | 1759.232 | 1739.224 |
| 4500 | 6604.681 | 6747.822 | 6800.674 | 6953.657 | 6964.100 | 7005.799 |

Variación = 100×(candidata/control−1); positivo indica mayor coste. No se promedian los dos controles:

| Escala | Δ pared vs antes | Δ CPU vs antes | Δ pared vs después | Δ CPU vs después |
|---:|---:|---:|---:|---:|
| 700 | +0.382% | −1.397% | −2.448% | −5.923% |
| 2000 | −0.320% | +2.423% | −0.337% | +1.150% |
| 4500 | +2.167% | +0.150% | −0.777% | −0.595% |

Drift independiente del control, 100×(MAIN después/MAIN antes−1):

| Escala | Δ pared del control | Δ CPU del control |
|---:|---:|---:|
| 700 | +2.901% | +4.811% |
| 2000 | +0.018% | +1.259% |
| 4500 | +2.967% | +0.750% |

p95 en **ms/paso**, sobre las mismas 100 filas:

| Escala | Pared MAIN antes | Pared candidata | Pared MAIN después | CPU MAIN antes | CPU candidata | CPU MAIN después |
|---:|---:|---:|---:|---:|---:|---:|
| 700 | 1117.627 | 1042.816 | 1065.447 | 1520.403 | 1306.785 | 1444.402 |
| 2000 | 3876.849 | 3894.872 | 4023.346 | 4081.466 | 4689.638 | 4542.319 |
| 4500 | 9423.536 | 9571.236 | 9661.972 | 10268.851 | 9679.886 | 9753.153 |

A 700 la pared no mejora frente a MAIN antes; a 2000 sube la CPU frente a ambos; a 4500 las medias de pared/CPU suben frente a MAIN antes y bajan frente a MAIN después. El drift impide atribuir una mejora clara a 4500. El p95 de CPU menor frente a MAIN antes no compensa la falta de mejora de pared y medias frente a ambos controles. No se fija un umbral nuevo ni se atribuye significación estadística a estas variaciones.

## Equivalencia y cierre de recursos

Los tres brazos de cada escala coincidieron en canon inicial/final, ticks, población, tiles, motivos de guardado, parámetros, semilla y diarios de las 120 transiciones. La referencia MAIN original acreditó canon inicial/parámetros y conteos de 120 pasos disponibles. Su canon final y diario de 600 no se reinterpretaron como referencia final de 120. El arnés no emite un digest por transición y la colección no reconstruyó World.

| Escala | Canon final de los tres brazos |
|---:|---|
| 700 | `9e4d84fdafaedf694eef7619d7ee545fe58af481d5390899758ddbd6b2970abe` |
| 2000 | `09f414afd093e04b73d87acac84ae863a8245441c96bca73268379450bb4c3db` |
| 4500 | `de8bddaebcd31327691a05fc01407db710c81df26d6ecaba1a011560d840035b` |

La sesión 28429 terminó realmente con exit0. El driver PID 1817797 cerró a las 2026-10-02T03:05:12.489Z, después de los nueve hijos y de borrar las nueve copias RAW. La limpieza usó exclusivamente disposal-v2, postterminal, con identidad/birth/FD y recibo wx/fsync durable antes del primer unlink; no borró inputs originales. La preadmisión conservadora fue 25,040,761,843 B, por debajo del presupuesto de 40 GB, con una copia por caso.

La colección cerrada verificó 907 fuentes y 145 pins de helpers/compilados/runtime actuales exactos. Observó ausentes los nueve PIDs científicos; los journals del driver y del lector cerraron PASS. La comprobación RO final de 2026-10-02T03:13:17.670Z confirmó driver 1817797, último hijo 1999662 y lector 2070503 ausentes y directorio de copias vacío. Las comprobaciones de NI/afinidad/política/I/O son endpoints y muestras de TID con identidad, no una certificación continua; no hubo reparaciones durante las ventanas.

## Recibos cerrados

Los recibos viven en el laboratorio `/datos/tmp-atlas-lab/balance/`; los 35 recibos de SHORT se conservaron también en `codex7-portatil-escenas-host2-short-b-closed-20261002/`. No se añaden datos SQLite, credenciales ni outputs de ciencia al repositorio.

| Recibo local | SHA256 |
|---|---|
| `codex7-asignaciones-stage-manifest-20261001-a.json` | `646670016b266b0b473661edb551576dc02946c3b049ebfcb4498e7c4a3871bb` |
| `codex7-asignaciones-parity-cierre-portable1-20261001.json` | `61cd51f861cedbe035812713a60979dffc58f098b5f50fbb13fc447a26548e2c` |
| `codex7-asignaciones-ci-namespace-fail-cierre-root2suite8-v2-20261001.json` | `30b3cb72f0bbc17eac2b449d905ed8cd3a59de4e85af0a89da86e22020bcfaba` |
| `codex7-portatil-escenas-host2-short-b-closed-20261002/codex7-portatil-escenas-host2-short-b-driver.json` | `dc5b32a99e274e1cb4a7fea701095b42fd24b2150d6b681c5d789caa813dbf35` |
| `codex7-portatil-escenas-host2-short-b-closed-20261002/codex7-portatil-escenas-host2-short-b-final-collection-20261002.json` | `ee529b985d714e7576b73eb476d05766beb9ac225340f57c6e906180dc5ed01e` |
| `codex7-portatil-escenas-host2-short-b-closed-20261002/codex7-host2-resources-short-driver-b-1817797.json` | `7c6caa8266267ebba19e61c40c47aab61fb3cf9eb6e495876715a0ed9c9ce723` |
| `codex7-portatil-escenas-host2-short-b-closed-20261002/codex7-portatil-escenas-host2-short-b-n700-triple.json` | `bc53b05f772165ae05f1ac73def4a4017cffdbdeeb0e6bc05cbff48d8595e808` |
| `codex7-portatil-escenas-host2-short-b-closed-20261002/codex7-portatil-escenas-host2-short-b-n2000-triple.json` | `44bf88f056f1698c1e2bf1471b638525eaceeabf28871bb084e1f64bd6041f2b` |
| `codex7-portatil-escenas-host2-short-b-closed-20261002/codex7-portatil-escenas-host2-short-b-n4500-triple.json` | `7b76d3ea3a8464b1154d7ee62314044327fedc1b56fcc515b0de18b917eebed2` |
| `codex7-portatil-escenas-host2-short-terminal-witness-20261002-b.json` | `f8e79fb839688cdcf824771ec785025cfa5214d130461bc3c429a8c6c77b15a2` |
| `codex7-portatil-escenas-host2-short-final-quiet-20261002-b.json` | `bcd950a493e1c28f383a91a68c927ea5397acd9332d8bc13a59721ddab1f920a` |

Fuente driver `257a44a19832351612676cfe29b97fe1f90802e25667663cdebdcd1295d41efd`; collector `556d64532d68a454795082e1ab995dab1e637f91c4362d8ba7f1914d9114af9c`; lector cerrado `403c1e34dc3a696d1a0e1491972bc6d271513bd78b5668df44ea6b0a92afc212`; disposal-v2 `1cc187ee6bb81ac71a0bc6e044a27f85a7bc36b9573f60b9bb6585a6bf9367f1`. Las fuentes y helpers congelados del portátil permanecen intactos; esta operación de archivo sólo escribe el worktree de la torre y su rama experimental.
