# Clon de mundos envejecidos: T103 sigue abierto

El clon que comparte chunks dormidos conserva el estado, pero **no alcanza** los
objetivos de T103: p50 ≤6,15 ms y p95 ≤10 ms. La medición real sustituye la inferencia
que no podía hacerse desde el fixture sintético anterior de 65536 teselas dormidas.

Se abrieron readonly tres bases de laboratorio: semilla51926 al día5 y semillas
1012/1013 al día13. La primera conserva reglas V6 en disco y migra a V7 en memoria;
las otras dos ya son V7. Se midió al cargar y tras19 pasos físicos sin guardar,
coherentes con cadencia20. No se incorporó terreno artificial ni se acumuló una
cola de cientos de pasos. Las bases y sus WAL conservaron hashes.

| Semilla / tick | Chunks pendientes | Clon completo p50/p95 ms | Clon compartido p50/p95 ms |
|---|---:|---:|---:|
| 51926 / 12000 | 0 | 18,79 / 27,55 | 19,94 / 36,93 |
| 51926 / 12019 | 4 | 23,30 / 36,84 | 20,88 / 29,28 |
| 1012 / 31200 | 0 | 22,12 / 38,99 | 24,30 / 37,73 |
| 1012 / 31219 | 2 | 21,30 / 32,55 | 20,79 / 34,14 |
| 1013 / 31200 | 0 | 25,74 / 41,32 | 25,35 / 38,42 |
| 1013 / 31219 | 4 | 35,15 / 49,30 | 33,53 / 47,00 |

Diez calentamientos y sesenta rondas por variante, orden alternado; mismo contexto,
parámetros y caché de estadísticas en ambos clones. Sólo cambia la copia de
`retiredChunks`. Los digestos de clones y mundos originales coinciden; las seis
observaciones físicas coinciden también entre las dos pasadas del instrumento.
La segunda pasada siguió a corregir una anotación TypeScript, sin cambio en su
algoritmo. Se conservan [la primera medición](evidencia-2026-09-22/clone-aged-initial.json)
y [la final](evidencia-2026-09-22/clone-aged-final.json), sin elegir sólo la más rápida.

El host estaba compartido con pruebas y simulaciones. No se forzó GC ni se aisló
una CPU; el informe separa tiempo de pared y CPU de proceso. Estas cifras no son
latencia del servidor ni reproducen el baseline histórico de10,25/14,33 ms. La
diferencia observada no justifica afirmar una mejora general cuando la cola está
vacía. El coste de otros componentes del mundo requiere medición y diseño propio.

[Instrumento](../scripts/benchmark-clone-aged.mts): acepta rutas explícitas a bases
de laboratorio, registra fuentes y hashes, y conserva los originales. Typecheck
verde; ambas ejecuciones terminaron sin discrepancias. Los controles de trayectoria
de2400 pasos y archivo de tres semillas siguen documentados por separado en
[clone-trajectory.json](evidencia-2026-09-22/clone-trajectory.json).

La corrección de copy-on-write permanece; **T103 no se cierra por aprobar paridad**.
T100/A0 y las etapas siguientes también continúan abiertas.
