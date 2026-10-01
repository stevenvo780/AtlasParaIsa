# Objetivo 8 A — cifras de todas las réplicas canónicas accesibles

Corte descriptivo, sin evaluador ni veredicto. **42 identidades únicas y 2.428 diarios**: 12 del panel principal COM-D′ y 30 de cupo (5 brazos × 6 semillas). Cierres de 60 días: 35; parciales al corte: 7. Cupo: 23 cierres de 60 días y 7 parciales, **no una evaluación final**. Fuente de cifras `/datos/tmp-atlas-lab/balance/codex8-laboratorio-cifras.json`, SHA256 `c37dd1f725b0a32075c5cebd8e60f7531c5e4400256826afe1699f04a9be29c0`. Estado/condición/usos/depósitos por estructura: **NO OBSERVABLES en 42/42**, no cero.

## Copias y cortes declarados

| Corte | Fuente | Réplicas | JSON usados y verificados | Copia UTC | SHA256 manifest |
|---|---|---:|---:|---|---|
| A | com-d-panel/torre-primario | 12 | 732 | 2026-10-01T03:20:06.271678+00:00→2026-10-01T03:20:06.614550+00:00 | `3a748c2bf15903c3014007225e6515e4b97909a494b39ef29021492dce47484d` |
| B | cupo-cribado/fix | 13 | 701 | 2026-10-01T03:32:19.506135+00:00→2026-10-01T03:32:20.041367+00:00 | `722cf5cc263c6a9501c49dc545f9a134d71757ea0e5305e498ec91f105d12439` |
| C | cupo-canónicas-adicionales | 17 | 1030 | 2026-10-01T03:49:04.493313+00:00→2026-10-01T03:49:04.958202+00:00 | `1a7d0ddbc49d1217fc11228c994838a46dd2d8a399da6cb7e28b3a26801966c4` |

A/B no se actualizaron al añadir C. Sus 25 réplicas conservaron **exactamente** puntos, valores diarios y estadísticas de la entrega previa. C añade 17 identidades, 1.014 diarios y 16 replica.json, con estabilidad de todas las fuentes comprobada durante su copia. Las fechas de corte difieren; no se inventa un instante mundial simultáneo.

Prioridad del recálculo completo: runtime `codex8-runtime/codex8-python`, nice19, scheduler0, CPUs6–31 tanto al inicio 2026-10-01T03:53:57.628751+00:00 como al final 2026-10-01T03:53:58.969186+00:00. Solo se fijó la prioridad del proceso propio. Antes, un guard detectó nice15 y abortó; esa desviación y los guards posteriores quedan conservados en JSON.

Entrega previa13fix preservada: `codex8-laboratorio-cifras-prev13.json` SHA256 `cf013150fde3124307e821eea13c4d1564f7dceea2ab832ec48bb07546c39d06` y `codex8-laboratorio-borrador-prev13.md` SHA256 `dbfe308930b4effa370c002f5ca853448f53d65017d895752e5a9cb701cb1734`.

## Cobertura y deduplicación de cupo

Se identifican exactamente 30 pares (brazo, semilla) de CUPO2/6/20/COM12/COM12C20 × 8101–8106, a partir del preregistro y adenda (`datos-lab/cupo-cribado/PRERREGISTRO.md:10–13,26–30`). Las 13 copias fix prevalecen en esas 13 identidades. Las 17 adicionales son 10 originales no reemplazadas, 6 COM12 del portátil y la continuación legacy-cache/CUPO20-8101. **0 canónicas accesibles quedan sin medir.**

CUPO20-8101 aporta 54 días desde legacy-cache; sus 34 días originales son un prefijo que no se agrega. Los relanzamientos y copias históricas tampoco añaden semillas. No se ejecuta ni se sustituye la auditoría de paridad/evaluador cupo.

| Fuentes históricas excluidas | Directorios | Diarios en inventario anterior | Motivo |
|---|---:|---:|---|
| original_replaced_prefix_excluded | 8 | 300 | prefijos reemplazados; incluyeoriginalCUPO20-8101 |
| historical_failed_copy_excluded | 5 | 238 | -muerta-*; no identidades adicionales |
| determinism_or_alternate_copy_excluded | 3 | 38 | alternativas/cotejos de portátil |

| Fuente excluida | Días | Último | replica.json |
|---|---:|---:|---|
| cupo-cribado/CUPO20-8101 | 34 | 34 | no |
| cupo-cribado/CUPO20-8103 | 31 | 31 | no |
| cupo-cribado/CUPO20-8105 | 40 | 40 | no |
| cupo-cribado/CUPO20-8106 | 36 | 36 | no |
| cupo-cribado/CUPO6-8101 | 36 | 36 | no |
| cupo-cribado/CUPO6-8103 | 38 | 38 | no |
| cupo-cribado/CUPO6-8105 | 43 | 43 | no |
| cupo-cribado/CUPO6-8106 | 42 | 42 | no |
| cupo-cribado/fix/COM12C20-8101-muerta-d57 | 57 | 57 | no |
| cupo-cribado/fix/COM12C20-8103-muerta-d40 | 40 | 40 | no |
| cupo-cribado/fix/COM12C20-8106-muerta-d46 | 46 | 46 | no |
| cupo-cribado/fix/CUPO20-8103-muerta-d38 | 38 | 38 | no |
| cupo-cribado/fix/CUPO20-8105-muerta-d57 | 57 | 57 | no |
| cupo-cribado/portatil/DETCHK-CUPO2-8101 | 3 | 3 | sí |
| legacy-cache/CUPO20-8101-heap16-laptop | 31 | 31 | no |
| legacy-cache/CUPO20-8101-laptop | 4 | 4 | no |

El inventario histórico se conserva del corte UTC 03:44:02 y no se vuelve a sondear. Allí la fuente fix ya tenía COM12C20-8101 d39; **ese diario sigue excluido** porque la copia B cerró d38. No se mezclan datos posteriores en el corte anterior.

## Definiciones y denominadores

- Temprano = d1–10; tardío = últimos 10 días completos disponibles por réplica. **Descripción, no ventanas ni criterios preregistrados.** Los parciales tienen edades finales distintas.
- Catálogo creado es acumulativo; distintas en uso/usos útiles son diarios en `(tick-2400,tick]`. Las medias de10d no son unión de recetas. `scripts/lab/replica.ts:105–127`; `scripts/lab/metrics.ts:40–66`.
- Solo se cuentan usos mecánicos `kind=use`, exitosos, con beneficio > 0; se excluye bebida portátil `kind=water` que sí acredita recipe.uses. `scripts/lab/metrics.ts:50–53`; `src/world/technology-water.ts:289–297`.
- Madera/piedra son stocks transversales medios de vecinos con edad ≥ 5 días; en las 42 réplicas d1/d2 son null. La media material temprana usa **8 días (d3–10)** y tardía **10/10 días**; no se imputa 0. No son consumos, flujos o stocks totales. `scripts/lab/instrumentos.ts:395–397`.
- CambiosHogar reinicia cada día: adopta incluye sustitución de coordenadas y pierde transición a null. No mide casas abandonadas. `scripts/lab/instrumentos.ts:348–354,450–451`.
- RepertorioAbierto rarefacciona 100 usos útiles, clases según 6 capacidades ≥ 0,2; null si N < 100. Medias solo sobre días medibles, indicando su n. `scripts/lab/instrumentos.ts:103–147`.
- Todos los grupos tienen 6 réplicas; media de grupo con igual peso por réplica. Una fracción usada en 1 día/catálogo histórico **no** es fracción histórica de nunca utilizadas.

## Recetas y usos por réplica

| Réplica | Corte; cierre | Creadas d1 | Creadas d20 | Creadas último | Distintas/día primeros10→últimos10 | Usos útiles/día primeros10→últimos10 | % catálogo usado último día |
|---|---|---:|---:|---:|---|---|---:|
| CDC-9501 | A; 60/60; completa | 127 | 19004 | 98880 | 145.8→663.2 (d51–60) | 385.5→1 624.8 | 0.660 |
| CDC-9502 | A; 60/60; completa | 154 | 17099 | 143762 | 143.4→1 499.4 (d51–60) | 416.8→4 080.5 | 0.912 |
| CDC-9503 | A; 60/60; completa | 17 | 9599 | 115480 | 92.1→1 171.4 (d51–60) | 234.7→2 995.2 | 0.762 |
| CDC-9504 | A; 60/60; completa | 50 | 7981 | 126194 | 81.3→1 448.6 (d51–60) | 185.3→3 735.1 | 0.869 |
| CDC-9505 | A; 60/60; completa | 55 | 11405 | 86724 | 85.7→480.7 (d51–60) | 195.6→1 121.1 | 0.642 |
| CDC-9506 | A; 60/60; completa | 86 | 13788 | 152825 | 105.3→1 776.2 (d51–60) | 299.4→5 114.4 | 1.368 |
| CDD-9501 | A; 60/60; completa | 127 | 18811 | 102921 | 150.1→536.8 (d51–60) | 405.7→1 228.0 | 0.597 |
| CDD-9502 | A; 60/60; completa | 165 | 17208 | 163457 | 126.8→1 753.5 (d51–60) | 327.7→4 681.8 | 0.968 |
| CDD-9503 | A; 60/60; completa | 19 | 10959 | 113794 | 94.5→1 074.0 (d51–60) | 223.3→3 111.2 | 0.744 |
| CDD-9504 | A; 60/60; completa | 39 | 10532 | 135307 | 87.8→1 552.5 (d51–60) | 214.3→4 295.4 | 0.810 |
| CDD-9505 | A; 60/60; completa | 63 | 11650 | 98300 | 98.0→779.7 (d51–60) | 230.0→1 924.2 | 0.958 |
| CDD-9506 | A; 60/60; completa | 86 | 15488 | 153050 | 107.5→1 583.4 (d51–60) | 314.2→5 043.4 | 1.123 |
| COM12-8101 | C; 60/60; completa | 108 | 18433 | 153675 | 103.9→1 320.4 (d51–60) | 262.7→3 308.3 | 1.053 |
| COM12-8102 | C; 60/60; completa | 88 | 10016 | 70814 | 108.2→766.7 (d51–60) | 291.9→2 109.0 | 1.037 |
| COM12-8103 | C; 60/60; completa | 119 | 13720 | 114521 | 113.0→1 018.9 (d51–60) | 262.8→2 604.3 | 0.768 |
| COM12-8104 | C; 60/60; completa | 114 | 19762 | 52832 | 150.4→135.1 (d51–60) | 403.9→297.8 | 0.087 |
| COM12-8105 | C; 60/60; completa | 90 | 18924 | 95113 | 163.2→722.0 (d51–60) | 425.9→1 668.5 | 0.778 |
| COM12-8106 | C; 60/60; completa | 191 | 18952 | 158136 | 131.5→1 314.4 (d51–60) | 341.5→3 361.1 | 0.740 |
| COM12C20-8101 | B; 38/60; parcial | 116 | 20785 | 212664 | 104.7→4 991.5 (d29–38) | 262.8→13 770.8 | 2.218 |
| COM12C20-8102 | B; 60/60; completa | 78 | 12801 | 116883 | 88.1→976.8 (d51–60) | 229.6→2 580.2 | 0.996 |
| COM12C20-8103 | B; 47/60; parcial | 116 | 22313 | 369958 | 127.9→6 084.8 (d38–47) | 342.8→17 026.9 | 1.888 |
| COM12C20-8104 | B; 60/60; completa | 127 | 23845 | 54231 | 158.9→78.1 (d51–60) | 401.5→158.6 | 0.059 |
| COM12C20-8105 | B; 60/60; completa | 114 | 19841 | 323794 | 166.7→5 520.3 (d51–60) | 475.6→14 979.9 | 2.032 |
| COM12C20-8106 | B; 46/60; parcial | 191 | 18507 | 363272 | 130.7→8 109.5 (d37–46) | 348.4→21 837.2 | 2.333 |
| CUPO2-8101 | C; 60/60; completa | 110 | 10413 | 105392 | 88.1→1 089.7 (d51–60) | 231.4→3 002.9 | 1.292 |
| CUPO2-8102 | C; 60/60; completa | 91 | 13377 | 66972 | 114.9→443.3 (d51–60) | 315.9→1 007.8 | 0.657 |
| CUPO2-8103 | C; 60/60; completa | 114 | 12283 | 109088 | 101.0→861.4 (d51–60) | 257.3→2 089.3 | 0.512 |
| CUPO2-8104 | C; 60/60; completa | 114 | 18746 | 50291 | 138.2→178.7 (d51–60) | 374.7→487.1 | 0.274 |
| CUPO2-8105 | C; 60/60; completa | 95 | 17351 | 111717 | 142.4→963.9 (d51–60) | 394.1→2 634.5 | 0.833 |
| CUPO2-8106 | C; 60/60; completa | 182 | 17823 | 133632 | 156.0→1 090.1 (d51–60) | 418.3→2 713.4 | 0.735 |
| CUPO20-8101 | C; 54/60; parcial | 109 | 17842 | 419779 | 81.6→7 059.8 (d45–54) | 198.7→21 965.0 | 1.600 |
| CUPO20-8102 | C; 60/60; completa | 87 | 12190 | 90859 | 115.3→1 091.2 (d51–60) | 338.5→3 089.1 | 1.337 |
| CUPO20-8103 | B; 47/60; parcial | 115 | 22151 | 358803 | 135.4→6 991.3 (d38–47) | 394.1→20 161.1 | 2.184 |
| CUPO20-8104 | C; 60/60; completa | 127 | 22686 | 53776 | 156.4→50.7 (d51–60) | 390.4→101.9 | 0.007 |
| CUPO20-8105 | B; 47/60; parcial | 119 | 19998 | 228477 | 139.3→4 206.4 (d38–47) | 394.9→12 889.9 | 2.178 |
| CUPO20-8106 | B; 49/60; parcial | 182 | 18514 | 413067 | 153.7→7 530.8 (d40–49) | 402.9→19 891.9 | 1.947 |
| CUPO6-8101 | B; 60/60; completa | 109 | 17900 | 280441 | 81.6→3 140.2 (d51–60) | 198.7→8 565.3 | 1.446 |
| CUPO6-8102 | C; 60/60; completa | 87 | 13181 | 82039 | 115.3→1 390.2 (d51–60) | 338.5→4 107.9 | 2.116 |
| CUPO6-8103 | B; 60/60; completa | 115 | 22222 | 263800 | 135.4→2 851.2 (d51–60) | 394.1→8 240.5 | 0.817 |
| CUPO6-8104 | C; 60/60; completa | 127 | 23090 | 55909 | 156.4→69.5 (d51–60) | 390.4→132.8 | 0.059 |
| CUPO6-8105 | B; 60/60; completa | 119 | 17619 | 194449 | 139.3→2 213.3 (d51–60) | 394.9→6 608.5 | 1.392 |
| CUPO6-8106 | B; 60/60; completa | 182 | 18465 | 324729 | 153.7→3 228.0 (d51–60) | 402.9→7 912.6 | 0.905 |

El catálogo no mide prácticas actuales; el uso diario excluye insumos que alimentan una nueva receta y bebida portátil. Los porcentajes no permiten afirmar «nunca usado».

## Reservas y cambios de hogar

| Réplica | Madera d3–10→últimos10 | Piedra d3–10→últimos10 | Adopta/día primeros10→últimos10 | Pierde/día primeros10→últimos10 | Adopta/pierde total observado |
|---|---|---|---|---|---|
| CDC-9501 | 4.359→1.389 | 1.939→0.404 | 49.000→390.700 | 20.700→166.800 | 18508/9491 |
| CDC-9502 | 5.306→2.117 | 3.527→0.995 | 32.600→328.400 | 16.600→135.400 | 15735/8060 |
| CDC-9503 | 4.078→1.818 | 1.965→1.442 | 22.100→286.100 | 12.000→135.900 | 13561/7083 |
| CDC-9504 | 3.159→1.506 | 2.621→0.690 | 24.800→231.600 | 11.100→111.300 | 10433/6008 |
| CDC-9505 | 2.172→0.478 | 2.225→0.228 | 30.600→196.800 | 16.300→92.500 | 10389/5995 |
| CDC-9506 | 3.357→2.988 | 3.083→1.839 | 23.200→544.000 | 14.200→273.100 | 17888/10199 |
| CDD-9501 | 4.664→1.045 | 2.292→0.310 | 41.700→315.100 | 18.300→154.900 | 18141/9857 |
| CDD-9502 | 4.004→2.609 | 3.027→1.118 | 39.900→291.200 | 25.300→133.000 | 14805/7760 |
| CDD-9503 | 3.419→1.608 | 2.185→1.249 | 28.100→283.300 | 13.800→127.200 | 14988/8737 |
| CDD-9504 | 2.991→1.798 | 2.326→0.819 | 27.600→173.800 | 10.600→69.500 | 11809/6267 |
| CDD-9505 | 2.696→0.797 | 3.012→0.445 | 22.600→275.100 | 9.300→146.900 | 12663/7558 |
| CDD-9506 | 3.481→2.289 | 2.842→1.358 | 33.600→443.800 | 26.000→193.400 | 17909/9445 |
| COM12-8101 | 2.598→1.788 | 3.529→1.088 | 48.400→330.600 | 30.000→167.100 | 14988/8309 |
| COM12-8102 | 2.966→0.601 | 1.250→0.247 | 16.300→322.300 | 7.600→156.000 | 13456/7583 |
| COM12-8103 | 3.698→1.079 | 1.632→0.573 | 20.900→197.500 | 1.300→54.100 | 15619/7470 |
| COM12-8104 | 3.116→0.074 | 2.818→0.099 | 42.900→152.100 | 33.800→98.100 | 10503/7505 |
| COM12-8105 | 4.647→0.997 | 1.673→0.356 | 53.700→379.800 | 32.600→143.900 | 18685/8852 |
| COM12-8106 | 4.200→1.021 | 2.134→0.536 | 35.700→294.700 | 20.000→150.800 | 15258/7680 |
| COM12C20-8101 | 2.491→3.121 | 3.601→1.888 | 45.800→2 144.200 | 28.700→1 395.100 | 33028/21311 |
| COM12C20-8102 | 3.245→0.303 | 1.427→0.113 | 15.500→903.000 | 5.500→639.300 | 26710/18360 |
| COM12C20-8103 | 4.693→2.370 | 2.307→1.345 | 29.300→3 531.000 | 13.500→2 264.500 | 74706/44497 |
| COM12C20-8104 | 3.412→0.026 | 3.116→0.000 | 36.800→118.500 | 25.700→73.700 | 10735/7293 |
| COM12C20-8105 | 4.333→1.332 | 1.904→0.491 | 59.700→4 154.900 | 42.500→2 359.400 | 85198/50516 |
| COM12C20-8106 | 4.067→1.816 | 2.175→1.252 | 39.700→3 023.500 | 23.500→1 889.300 | 56501/35736 |
| CUPO2-8101 | 2.968→1.581 | 3.306→0.696 | 33.900→285.000 | 25.400→141.000 | 11101/6188 |
| CUPO2-8102 | 4.076→0.361 | 2.251→0.152 | 34.100→269.300 | 15.400→102.600 | 13531/7322 |
| CUPO2-8103 | 4.324→0.757 | 2.424→0.310 | 20.700→131.400 | 6.800→35.200 | 12145/5989 |
| CUPO2-8104 | 3.169→0.080 | 2.780→0.093 | 43.800→234.400 | 27.300→159.300 | 9974/6937 |
| CUPO2-8105 | 3.588→0.839 | 2.022→0.260 | 50.500→389.500 | 29.900→167.400 | 19525/9197 |
| CUPO2-8106 | 4.378→1.352 | 2.777→1.172 | 27.100→292.800 | 15.000→129.300 | 12711/6097 |
| CUPO20-8101 | 1.825→2.281 | 3.907→1.080 | 43.600→3 494.100 | 31.900→2 327.400 | 78018/49761 |
| CUPO20-8102 | 4.118→0.347 | 1.895→0.128 | 22.600→1 408.400 | 13.300→942.500 | 26671/19034 |
| CUPO20-8103 | 5.448→1.988 | 2.456→1.043 | 51.200→3 499.000 | 25.800→2 219.600 | 75835/44334 |
| CUPO20-8104 | 3.061→0.024 | 2.797→0.000 | 49.000→92.900 | 31.200→76.000 | 12337/8535 |
| CUPO20-8105 | 4.461→1.299 | 2.134→0.427 | 55.800→1 703.000 | 32.600→1 090.100 | 40548/25669 |
| CUPO20-8106 | 4.293→2.364 | 2.832→1.555 | 28.000→2 637.600 | 15.400→1 503.000 | 68083/38728 |
| CUPO6-8101 | 1.825→1.581 | 3.907→0.817 | 43.600→1 025.000 | 31.900→498.700 | 37832/20994 |
| CUPO6-8102 | 4.118→0.616 | 1.895→0.191 | 22.600→1 129.000 | 13.300→758.800 | 19522/13868 |
| CUPO6-8103 | 5.448→0.918 | 2.456→0.312 | 51.200→523.000 | 25.800→155.500 | 36914/17587 |
| CUPO6-8104 | 3.061→0.020 | 2.797→0.000 | 49.000→92.100 | 31.200→75.000 | 11074/8504 |
| CUPO6-8105 | 4.461→1.025 | 2.134→0.365 | 55.800→993.900 | 32.600→466.800 | 39710/21788 |
| CUPO6-8106 | 4.293→1.272 | 2.832→1.033 | 28.000→907.000 | 15.400→515.800 | 38149/19201 |

Stocks positivos pueden coexistir con consumos y reposición; sin flujos/edad por lote no se prueba acumulación sin consumo. Transiciones de home prueban dinámica personal, pero no desocupación física de una casa.

## Repertorio útil rarefactado

| Réplica | ClasesR100 primeros10→últimos10 | Días medibles primero/último | RecetasR100 primeros10→últimos10 | Hill2 clases primero→último |
|---|---|---|---|---|
| CDC-9501 | 19.90→24.42 | 9/10; 10/10 | 65.12→86.05 | 11.14→13.19 |
| CDC-9502 | 21.07→27.07 | 9/10; 10/10 | 59.50→92.89 | 10.64→17.53 |
| CDC-9503 | 18.99→25.61 | 8/10; 10/10 | 59.46→90.09 | 8.98→15.09 |
| CDC-9504 | 22.74→26.42 | 6/10; 10/10 | 62.84→92.37 | 12.91→15.59 |
| CDC-9505 | 19.53→26.16 | 7/10; 10/10 | 62.14→85.73 | 8.85→17.39 |
| CDC-9506 | 18.04→26.33 | 9/10; 10/10 | 54.20→91.29 | 9.42→16.31 |
| CDD-9501 | 19.12→27.51 | 9/10; 10/10 | 65.57→84.90 | 10.29→15.74 |
| CDD-9502 | 21.26→26.60 | 9/10; 10/10 | 60.39→92.95 | 11.58→15.31 |
| CDD-9503 | 19.28→23.78 | 8/10; 10/10 | 61.04→87.88 | 9.91→12.52 |
| CDD-9504 | 19.48→25.50 | 8/10; 10/10 | 61.83→90.62 | 9.86→14.25 |
| CDD-9505 | 19.06→25.41 | 7/10; 10/10 | 65.06→87.15 | 10.10→15.22 |
| CDD-9506 | 17.59→25.81 | 9/10; 10/10 | 54.61→88.72 | 9.66→14.72 |
| COM12-8101 | 20.07→27.86 | 7/10; 10/10 | 63.34→93.76 | 10.83→17.54 |
| COM12-8102 | 20.96→27.56 | 10/10; 10/10 | 59.09→87.54 | 12.02→17.15 |
| COM12-8103 | 22.45→26.35 | 8/10; 10/10 | 67.01→89.36 | 12.62→14.43 |
| COM12-8104 | 20.85→23.08 | 9/10; 9/10 | 66.34→65.27 | 12.28→13.82 |
| COM12-8105 | 20.28→27.14 | 9/10; 10/10 | 66.05→88.21 | 9.87→15.34 |
| COM12-8106 | 20.88→27.91 | 9/10; 10/10 | 65.22→93.53 | 10.91→19.52 |
| COM12C20-8101 | 19.24→26.15 | 6/10; 10/10 | 64.28→90.26 | 8.63→13.58 |
| COM12C20-8102 | 21.45→29.59 | 9/10; 10/10 | 57.45→90.82 | 13.01→20.30 |
| COM12C20-8103 | 20.57→26.34 | 9/10; 10/10 | 62.37→91.18 | 10.91→12.94 |
| COM12C20-8104 | 20.02→21.38 | 9/10; 3/10 | 69.13→78.24 | 10.82→9.89 |
| COM12C20-8105 | 21.03→29.33 | 9/10; 10/10 | 65.75→91.82 | 10.14→18.54 |
| COM12C20-8106 | 20.90→26.45 | 9/10; 10/10 | 64.82→92.90 | 11.22→14.63 |
| CUPO2-8101 | 20.53→27.42 | 6/10; 10/10 | 60.09→90.33 | 9.17→17.76 |
| CUPO2-8102 | 21.07→25.51 | 10/10; 10/10 | 58.46→86.39 | 12.01→13.29 |
| CUPO2-8103 | 22.77→25.19 | 8/10; 10/10 | 62.76→89.76 | 14.09→14.91 |
| CUPO2-8104 | 20.68→24.66 | 9/10; 10/10 | 64.67→71.30 | 12.06→13.76 |
| CUPO2-8105 | 21.68→26.48 | 9/10; 10/10 | 64.36→89.72 | 9.33→15.20 |
| CUPO2-8106 | 20.05→24.30 | 9/10; 10/10 | 67.08→90.36 | 11.05→13.38 |
| CUPO20-8101 | 15.51→26.93 | 7/10; 10/10 | 58.38→92.48 | 6.80→16.95 |
| CUPO20-8102 | 22.03→27.86 | 9/10; 10/10 | 61.31→89.35 | 13.15→16.90 |
| CUPO20-8103 | 21.08→26.30 | 9/10; 10/10 | 61.01→92.48 | 12.72→13.49 |
| CUPO20-8104 | 20.96→21.35 | 9/10; 3/10 | 69.31→73.23 | 10.75→10.92 |
| CUPO20-8105 | 23.32→29.18 | 9/10; 10/10 | 62.55→92.82 | 14.16→16.91 |
| CUPO20-8106 | 20.10→23.42 | 9/10; 10/10 | 67.11→93.71 | 11.18→10.67 |
| CUPO6-8101 | 15.51→26.97 | 7/10; 10/10 | 58.38→93.41 | 6.80→17.42 |
| CUPO6-8102 | 22.03→26.75 | 9/10; 10/10 | 61.31→89.78 | 13.15→17.06 |
| CUPO6-8103 | 21.08→25.57 | 9/10; 10/10 | 61.01→93.47 | 12.72→11.89 |
| CUPO6-8104 | 20.96→23.98 | 9/10; 3/10 | 69.31→74.20 | 10.75→13.64 |
| CUPO6-8105 | 23.32→26.79 | 9/10; 10/10 | 62.55→89.22 | 14.16→15.96 |
| CUPO6-8106 | 20.10→24.11 | 9/10; 10/10 | 67.11→94.86 | 11.18→12.94 |

## Grupos: descripción sin evaluación

| Grupo | Completas/parciales(de6) | Último día mín–máx | Catálogo último, media | Distintas/día primeros10→últimos10 | Usos útiles/día primeros10→últimos10 | Madera d3–10→últimos10 | Piedra d3–10→últimos10 |
|---|---|---|---:|---|---|---|---|
| CDC | 6/0 | 60–60 | 120 644.2 | 108.93→1 173.25 | 286.22→3 111.85 | 3.74→1.72 | 2.56→0.93 |
| CDD | 6/0 | 60–60 | 127 804.8 | 110.78→1 213.32 | 285.87→3 380.67 | 3.54→1.69 | 2.61→0.88 |
| CUPO2 | 6/0 | 60–60 | 96 182.0 | 123.43→771.18 | 331.95→1 989.17 | 3.75→0.83 | 2.59→0.45 |
| CUPO6 | 6/0 | 60–60 | 200 227.8 | 130.28→2 148.73 | 353.25→5 927.93 | 3.87→0.91 | 2.67→0.45 |
| CUPO20 | 2/4 | 47–60 | 260 793.5 | 130.28→4 488.37 | 353.25→13 016.48 | 3.87→1.38 | 2.67→0.71 |
| COM12 | 6/0 | 60–60 | 107 515.2 | 128.37→879.58 | 331.45→2 224.83 | 3.54→0.93 | 2.17→0.48 |
| COM12C20 | 3/3 | 38–60 | 240 133.7 | 129.50→4 293.50 | 343.45→11 725.60 | 3.71→1.49 | 2.42→0.85 |

Medias transversales descendentes entre estas ventanas: madera **7/7 grupos**, piedra **7/7 grupos**. Eso describe reservas, no demuestra consumo de un lote ni descarta stocks locales duraderos. Los catálogos y los números diarios de uso cuentan magnitudes diferentes. Comparar brazos requiere además poblaciones/edades/ventanas equivalentes; aquí no se adjudica efecto causal.

## Observabilidad y validación

- Condición/edad/usos por estructura, depósitos de graneros/cisternas, ruinas, ocupación y períodos sin uso: **0 observaciones instrumentadas entre 2.428 diarios; NO OBSERVABLES**, no estado 0.
- No se puede recuperar uso por casa/día ni proporción histórica nunca usada desde estos diarios. Las recetas usadas como insumos y la bebida portátil requieren otro instrumento si se quiere una medida completa.
- Revisión proporcional: verificación SHA de todas las copias usadas, continuidad 1→último, tick = 2400 × día, ventanaActividad exacta diaria, monotonía de creación, coherencia replica.json, 30 pares brazo/semilla únicos y reproducción exacta de 25 resúmenes previos.
- No evaluadores, no simulaciones, no inspección de procesos/servicios y ninguna espera por nuevos días. El panel cupo sigue siendo un **corte descriptivo con 7 parciales**, aunque se hayan cubierto todas las identidades.
