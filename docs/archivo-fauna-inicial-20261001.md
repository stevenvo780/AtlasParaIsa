# Archivo de la primera variante FA — 2026-10-01

Estado: ARCHIVADA / NO ACCEPTED / NO INTEGRATE. Esta rama conserva la primera implementación del índice de fauna, descartada por rendimiento. No es la variante FA-lazy elegida ni una propuesta de integración. No se realizó push.

Los siete archivos del recibo de preservación SHA a1ebce535a1458c08fae4d36121dda862c10768feed05dac105a606c8283f923 se reconstruyeron sobre c4a86120745b8aa7dea2d750bece137ce3205350. Las 99 fuentes src/**/*.ts coinciden byte por byte con el manifiesto FA original SHA eb40d463078b083b95422c3fb7c327559f80983a910debd8234e721a0e8731ad, y el diff tracked también coincide. El inventario completo y los SHA históricos están en [source-manifest.json](evidencia-codex7-fauna-inicial-20261001/source-manifest.json).

Los PASS siguientes corresponden a ejecuciones históricas ya terminadas. La preservación no ejecutó compilación, typecheck, tests, perfiles ni simulaciones y no incluye node_modules ni dist.

| Evidencia histórica | Resultado y alcance |
|---|---|
| Paridad | PASS: 6 semillas × 1 200 pasos, 78 hitos, canon directo y entradas estables; motor.hilos=1. No cierra otros backends ni biología longitudinal. |
| Escenas | PASS: 700/2 000/4 500, 600 pasos por escena; canon final y secuencia tick/población/teselas iguales. Los baselines históricos tuvieron otra carga de torre; no prueban ganancia causal. |
| Suite completa | 164 archivos, 1 639 pruebas PASS, 9 skips heredados, 0 fallos/cancelaciones/todo. Las 165 guardas cubren runner y archivos gestionados, sin descendientes. Son muestras de arranque/cierre, no trazas continuas. |
| Pareado 700 | Ensayo cerrado válido de cuatro ejecuciones secuenciales, 600 pasos cada una, Inspector/h1/16 GiB. Medias wall y CPU peores que ambos controles: variante descartada por rendimiento. |

| Pareado 700 | Media wall ms/paso | Media CPU ms/paso |
|---|---:|---:|
| control-before | 142.018 | 171.335 |
| fauna | 146.691 | 178.149 |
| control-after | 129.290 | 155.579 |

Deriva control final/inicial: wall 0.910379, CPU 0.908036. Se conserva esa deriva; una sola tanda no establece reproducibilidad. Los ratios control/FA de ambas medias fueron menores que 1 frente a los dos controles.

Copias íntegras de informes cerrados:

- [codex7-personas-fauna-build-manifest-20260930.json](evidencia-codex7-fauna-inicial-20261001/codex7-personas-fauna-build-manifest-20260930.json)
- [codex7-personas-fauna-paridad-20260930.json](evidencia-codex7-fauna-inicial-20261001/codex7-personas-fauna-paridad-20260930.json)
- [codex7-personas-fauna-escenas-20260930.json](evidencia-codex7-fauna-inicial-20261001/codex7-personas-fauna-escenas-20260930.json)
- [codex7-personas-fauna-full-suite-audit-20260930.json](evidencia-codex7-fauna-inicial-20261001/codex7-personas-fauna-full-suite-audit-20260930.json)
- [codex7-personas-pareado1-n700-20260930.json](evidencia-codex7-fauna-inicial-20261001/codex7-personas-pareado1-n700-20260930.json)

El primer intento de archivo se detuvo por un chequeo mecánico de rama ausente, antes de crear un worktree; su recibo NO CUMPLIDA se conserva. El recibo externo codex7-personas-fauna-inicial-archivo-20261001-attempt2.json registra el commit final y la retirada inmediata del único worktree temporal propio. La rama conserva fuentes, pruebas, harness y documentación.
