# Evidencia "ANTES" — SC-004 (Gini de recursos por región / regiones sin agua superficial)

- Commit medido: `027c0e9cb080f52f9e5bf21b3985878a1e8e087e` (HEAD al iniciar el encargo). Nota: mientras corrían las 4 réplicas en paralelo, el repo avanzó a `fe91d949685d54f42b49d8f603524303a008b620` (2 commits: `a02faa1` T033/T034 módulos visuales puros, `fe91d94` VACUUM INTO en el backup) — verificado con `git diff --stat 027c0e9..HEAD` que **ningún** fichero de `src/world/*.ts` ni `src/shared/types.ts` cambió (solo `.specify/workflows/fase12-vida-servidor.js` y `tasks.md`), así que esta evidencia sigue siendo válida para `027c0e9`.
- Semillas: 4821, 51926, 12345, 20260905 (4 réplicas, 10 días = 24.000 pasos cada una, en paralelo)
- Regiones = chunks de 16×16 (`CHUNK_SIZE`) sobre las tiles activas cargadas en cada mundo.
- Criterio SC-004: Gini de recursos por región ≥ 0,35 **y** ≥ 30 % de regiones sin agua superficial; distancia media a agua > 6 celdas.
- Media/desv. de food, vegetation, fertility, moisture calculadas solo sobre celdas de tierra (terrain ≠ 'water'); Gini de food/wood por región suma todas las celdas (tierra + agua) de cada región.

## Tabla por día (mediana entre las 4 semillas)

| Día | Tick | Tiles | Regiones | Habit. | food>0.1 | food>0.3 | food>0.6 | food media±desv | veg media±desv | fertility media±desv | moisture media±desv | tierra c/agua potable | Gini food/región | Gini wood/región | regiones sin agua superficial | dist. media a agua |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | 1536 | 6 | 16 | 77.0% | 0.0% | 0.0% | 0.112 ± 0.037 | 0.398 ± 0.109 | 0.430 ± 0.049 | 0.383 ± 0.045 | 3.1% | 0.154 | 0.503 | 0.0% | 3.24 |
| 1 | 2400 | 6144 | 24 | 22 | 85.4% | 4.8% | 0.0% | 0.176 ± 0.093 | 0.502 ± 0.161 | 0.475 ± 0.104 | 0.657 ± 0.165 | 3.2% | 0.225 | 0.552 | 0.0% | 3.43 |
| 2 | 4800 | 10752 | 42 | 24 | 97.0% | 58.9% | 3.3% | 0.355 ± 0.160 | 0.680 ± 0.169 | 0.540 ± 0.144 | 0.844 ± 0.094 | 3.3% | 0.243 | 0.537 | 0.0% | 3.26 |
| 3 | 7200 | 11904 | 47 | 26 | 97.6% | 79.5% | 46.9% | 0.532 ± 0.211 | 0.787 ± 0.174 | 0.591 ± 0.159 | 0.654 ± 0.174 | 4.7% | 0.213 | 0.664 | 0.0% | 3.28 |
| 4 | 9600 | 13056 | 51 | 31 | 97.5% | 78.9% | 46.6% | 0.542 ± 0.252 | 0.778 ± 0.184 | 0.636 ± 0.183 | 0.456 ± 0.188 | 5.4% | 0.265 | 0.676 | 0.0% | 3.17 |
| 5 | 12000 | 13056 | 51 | 32 | 98.9% | 88.3% | 63.3% | 0.642 ± 0.230 | 0.836 ± 0.165 | 0.683 ± 0.192 | 0.814 ± 0.142 | 4.5% | 0.201 | 0.665 | 0.0% | 3.46 |
| 6 | 14400 | 14976 | 59 | 32 | 98.2% | 89.0% | 74.1% | 0.710 ± 0.239 | 0.879 ± 0.158 | 0.735 ± 0.199 | 0.900 ± 0.141 | 8.3% | 0.189 | 0.647 | 0.7% | 3.62 |
| 7 | 16800 | 14208 | 56 | 32 | 100.0% | 93.3% | 79.3% | 0.778 ± 0.216 | 0.912 ± 0.124 | 0.760 ± 0.197 | 0.932 ± 0.078 | 7.5% | 0.160 | 0.622 | 0.0% | 3.13 |
| 8 | 19200 | 14336 | 56 | 32 | 99.8% | 91.0% | 81.0% | 0.770 ± 0.226 | 0.886 ± 0.163 | 0.796 ± 0.203 | 0.700 ± 0.114 | 10.0% | 0.139 | 0.554 | 0.0% | 3.30 |
| 9 | 21600 | 14720 | 58 | 32 | 97.5% | 93.1% | 79.7% | 0.778 ± 0.253 | 0.897 ± 0.166 | 0.814 ± 0.210 | 0.923 ± 0.093 | 7.5% | 0.162 | 0.521 | 0.0% | 3.19 |
| 10 | 24000 | 13312 | 52 | 30 | 100.0% | 94.3% | 80.9% | 0.812 ± 0.231 | 0.915 ± 0.123 | 0.849 ± 0.190 | 0.767 ± 0.157 | 6.8% | 0.133 | 0.504 | 0.8% | 3.00 |

## Lectura (5 líneas)

1. La comida se satura (>90 % de celdas de tierra con food>0,3) en el **día 7**; la fracción con food>0,1 ya ronda 77.0% desde el día 0 por el highland inicial sin agua.
2. El Gini de comida por región pasa de **0.154** (día 0) a **0.133** (día 10) — NO cumple el umbral ≥0,35 del SC-004 al día 10.
3. La fracción de regiones sin agua superficial pasa de 0.0% (día 0) a 0.8% (día 10) — NO cumple el umbral ≥30 % del SC-004; la distancia media a agua potable en el día 10 es 3.00 celdas (umbral >6).
4. Con las reglas actuales (`ecology()` regenera vegetación/comida cada 10 ticks en toda celda de tierra sin capacidad de carga por bioma, y la fertilidad no decae), el sistema tiende a **homogeneizar** el paisaje en vez de mantener regiones diferenciadas: por eso food y fertility se disparan hacia la saturación mientras el Gini de comida se mantiene relativamente bajo.
5. **Veredicto SC-004 hoy**: NO CUMPLE — el Gini de comida no alcanza 0,35 y no hay ≥30 % de regiones sin agua superficial al día 10; el agua potable (manantiales/charcas) aparece dispersa en casi todos los chunks del entorno de partida, dejando muy pocas regiones realmente secas.
