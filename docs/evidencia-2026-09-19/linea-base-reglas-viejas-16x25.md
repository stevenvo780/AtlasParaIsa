# Línea base — reglas actuales (commit 10ac5c1)

**Aviso de integridad — leer antes de usar estos números.** El repositorio recibió commits en vivo de un workflow `/speckit-implement` concurrente en la misma rama `001-mundo-solido-masivo` durante toda la ventana de este barrido (2026-09-19 09:48–10:55 aprox.), incluyendo cambios de reglas que tocan senescencia, reproducción, genética y capacidad de carga del entorno (T010–T013). Este laboratorio importa el código por ruta absoluta al working tree compartido, así que solo son fiables como "reglas de 10ac5c1" las réplicas cuyo proceso importó el código ANTES de que aterrizara cualquier commit relevante. Las 14 réplicas del barrido sincronizado (lanzadas juntas a las 09:57:08) cumplen eso — se verificó que los 4 commits que ya habían aterrizado en ese momento (`2af0c97`,`b6f94cd`,`1619c6b`,`c6125da`) son irrelevantes para la demografía (backup, cabecera de login, módulo de parámetros aún no conectado a la demografía, y una optimización de rendimiento en `animals.ts` que no cambia el resultado). Las semillas 1009 y 1011 se reintentaron más tarde, ya con T013 (y para 1009, también T010–T012) aterrizados, así que NO se usan aquí.

Semillas 1000..1015, 25 días simulados cada una (TICKS_PER_DAY=2400 → 60000 pasos), Store SQLite temporal adjunto por réplica (P3). Réplicas completas y válidas para la línea base: 14/16 (excluidas: 1009, 1011).

## Réplicas excluidas del análisis

- seed 1009: 3/25 días — excluida: reintento lanzado después de que aterrizaran commits de reglas (repo mutado en vivo por otro workflow), no representa 10ac5c1 (último error: `Error: Invalid technology opening checkpoint.`)
- seed 1011: 25/25 días — excluida: reintento lanzado después de que aterrizaran commits de reglas (repo mutado en vivo por otro workflow), no representa 10ac5c1

Se excluyen de las medianas y sumas de abajo para no contaminarlas.

## Población y fundadores vivos por día (mediana / p10 / p90 entre réplicas)

| Día | Población mediana | Población p10 | Población p90 | Fundadores vivos mediana | Fundadores p10 | Fundadores p90 | n réplicas |
|---|---|---|---|---|---|---|---|
| 1 | 22 | 20 | 23 | 16 | 16 | 16 | 14 |
| 2 | 26 | 21 | 28 | 16 | 16 | 16 | 14 |
| 3 | 31 | 24 | 32 | 16 | 16 | 16 | 14 |
| 4 | 32 | 27 | 32 | 16 | 16 | 16 | 14 |
| 5 | 32 | 28 | 32 | 16 | 16 | 16 | 14 |
| 6 | 32 | 30 | 32 | 16 | 16 | 16 | 14 |
| 7 | 32 | 32 | 32 | 16 | 16 | 16 | 14 |
| 8 | 32 | 32 | 32 | 16 | 15 | 16 | 14 |
| 9 | 32 | 31 | 32 | 15.5 | 14 | 16 | 14 |
| 10 | 31 | 28 | 32 | 11 | 9 | 14 | 14 |
| 11 | 28.5 | 25 | 32 | 8 | 6 | 12 | 14 |
| 12 | 24 | 21 | 26 | 3 | 2 | 4 | 14 |
| 13 | 20.5 | 17 | 26 | 2 | 2 | 2 | 14 |
| 14 | 17 | 11 | 24 | 2 | 2 | 2 | 14 |
| 15 | 14 | 10 | 23 | 2 | 2 | 2 | 14 |
| 16 | 12.5 | 6 | 24 | 2 | 2 | 2 | 14 |
| 17 | 13 | 6 | 28 | 2 | 2 | 2 | 14 |
| 18 | 15 | 6 | 32 | 2 | 2 | 2 | 14 |
| 19 | 17 | 6 | 32 | 2 | 2 | 2 | 14 |
| 20 | 18.5 | 6 | 32 | 2 | 2 | 2 | 14 |
| 21 | 20 | 6 | 32 | 2 | 2 | 2 | 14 |
| 22 | 23 | 5 | 32 | 2 | 2 | 2 | 14 |
| 23 | 25.5 | 2 | 32 | 2 | 2 | 2 | 14 |
| 24 | 29 | 2 | 32 | 2 | 2 | 2 | 14 |
| 25 | 31.5 | 2 | 32 | 2 | 2 | 2 | 14 |

## Primera muerte

Día de la primera muerte (mediana entre las 14 réplicas con al menos una muerte en 25 días): **9.5**.
Detalle por réplica: seed 1000=10, seed 1001=9, seed 1002=9, seed 1003=10, seed 1004=10, seed 1005=10, seed 1006=10, seed 1007=2, seed 1008=9, seed 1010=8, seed 1012=10, seed 1013=9, seed 1014=9, seed 1015=11.

## Extinción (colapso a población=2, solo S e I protegidos)

3/14 réplicas colapsan a población=2 dentro de los 25 días. Mediana del día de colapso: **23**.
Detalle por réplica: seed 1000=no extinguida en 25 días, seed 1001=no extinguida en 25 días, seed 1002=no extinguida en 25 días, seed 1003=no extinguida en 25 días, seed 1004=23, seed 1005=no extinguida en 25 días, seed 1006=no extinguida en 25 días, seed 1007=no extinguida en 25 días, seed 1008=25, seed 1010=no extinguida en 25 días, seed 1012=no extinguida en 25 días, seed 1013=23, seed 1014=no extinguida en 25 días, seed 1015=no extinguida en 25 días.

## Muertes por causa, acumuladas al día 25 (suma de las 14 réplicas)

| Causa | Muertes |
|---|---|
| starvation | 0 |
| dehydration | 2 |
| exposure | 0 |
| senescence | 494 |
| **total** | **496** |

## Rendimiento

- ms/paso p50 global (mediana de las medianas diarias): 15.153 ms
- ms/paso p95 global (percentil 95 de los p95 diarios): 122.995 ms
- Tiempo de pared total sumado (14 réplicas válidas): 19204.0 s — máximo de una réplica: 1789.1 s

## Lectura (5 líneas)

1. **0 muertes hasta ~día 7**: 13/14 réplicas siguen con 0 muertes acumuladas en el día 7 (mediana de muertes acumuladas en día 7: 0).
2. **Población 16→32 (tope)**: la mediana de población pasa de 16 (día 0) a 32 en el día 7 y toca el tope (32) hacia el día 4.
3. **Ola de senescencia**: la primera muerte aparece (mediana) en el día 9.5; las causas acumuladas al día 25 son starvation=0, dehydration=2, exposure=0, senescence=494 (total 496).
4. **Extinción hacia el día ~15**: 3/14 réplicas colapsan a población=2 (solo S e I, protegidos) dentro de los 25 días simulados; mediana del día de colapso: 23.
5. **Conclusión**: la hipótesis de docs/REVISION-2026-09-19.md §1 queda PARCIALMENTE CONFIRMADA/REFUTADA por esta línea base (commit 10ac5c1, 14/16 réplicas completas, semillas 1000-1015, 25 días simulados cada una).
