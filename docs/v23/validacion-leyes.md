# Validación en laboratorio de las leyes v23 (sprint/v24-base 849a895) contra V22 (main a7ec79b)

Fecha: 2026-11-24. Carril de validación; no se editó código del repositorio.

## Veredicto corto

1. **No es seguro desplegar todavía como «validado».** No porque v23 empeore a V22 (no lo hace de forma detectable), sino porque el propio V22 se extingue y la validación no llegó a 60 días en las semillas que viven. Lo que sí se puede afirmar: a 15 días v23 ≥ V22 en 6 de 8 semillas y a la vez 4 de 8 semillas NUEVO y 5 de 8 CONTROL pierden a todos los mortales entre los días 20 y 31.
2. **Los «15 días» de Gemini eran 1,5 días.** `chequeo-emergencia-8389.txt:10` avanza `15 * 240` pasos = 3 600 ticks; un día son 2 400 (`TICKS_PER_DAY`, `src/world/index.ts:70`). Ese chequeo nunca vio el día 17-30 donde ocurre el colapso.
3. **La extinción de mortales es previa a v23** (ver tabla: 5 de 5 semillas de CONTROL terminadas se extinguen). Es un cuello de botella demográfico del lanzamiento con 14 fundadores, no una ley química.
4. **Con el tope de 40 min por réplica** las 4 semillas que viven (51926, 7, 19101, 19103 en NUEVO; 51926, 7, 19104 en CONTROL) llegaron solo a los días 17-26. Faltan los días 30/45/60 para ellas: es lo que bloquea una decisión firme.

## Método (reproducible)

- Lanzador único: `lab/lanzador.mjs` (importa `createWorld`/`stepWorld`/`parseParams` del brazo; sin servidor ni BD). 1 día = 2 400 ticks; censo cada 5 días y fila diaria de población (para fechar la extinción); `fin` con estado `completo` / `tope-tiempo`.
- Parámetros idénticos en ambos brazos (diferencia entre `lab/params-nuevo.json` y `lab/params-control.json`: ninguna): `hostOpenWorldParams()` + `deploymentParams(CARTA_PARAMS de publico.sh)` resueltos en la torre (modo abierto de producción: `quimica.emergente`, `construccion.modular/poliminosYSinergia`, `terreno.caminosFisicos`, natalidad por vecindad, etc.) con `motor.hilos=1`, `motor.gpu=[]` (la paridad 0 ULP entre hilos es invariante del motor; no se re-verificó aquí).
- Brazos: NUEVO = `AtlasParaIsa-anexo/worktrees/v24-base` (849a895); CONTROL = árbol principal en solo lectura (a7ec79b).
- Panel: 8 semillas × 2 brazos. Tope de 40 min de reloj por réplica.
- Cómputo: la torre estaba a carga 55-79 (qemu docker-lab ≈ 850 %, servidor público ≈ 210 %, procesos node en SCHED_IDLE): las réplicas iban a 9-45 Hz. Se usó «fedora» para varias réplicas (algunas duplicadas con la torre; código copiado a `/tmp/validacion-leyes-atlas`, ya borrado). **Torre y fedora dan filas diarias idénticas bit a bit** en las 4 réplicas duplicadas comparadas (NUEVO 19101 días 1-17, 19103 días 1-18, 7 días 1-15, 9606 días 1-11): el reparto entre máquinas no sesga.
- Una réplica por semilla y brazo: la divergencia entre brazos en una semilla puede ser caos (el RNG se consume distinto) y no efecto de ley. Por eso se razona sobre las 8 semillas juntas.

### Correcciones a las métricas de Gemini
- Días: `15 * 240` → `15 * 2400`.
- Fórmulas: `w.chemistry?.totalFormulas` no existe en el estado; `totalFormulas` es un campo de la **proyección** (`src/world/chemistry.ts:614`). El contador real es `world.chemistry.formulas.length` (vivas) y `formulaCounter` (acumuladas, `chemistry.ts:26-28`); `statistics.ts:359` usa el primero. De ahí el «0».
- Poliominós: Gemini contó `cells.length >= 3`; la estadística oficial cuenta `> 1` (`src/world/statistics.ts:354`). Aquí se informa `>1` y las celdas máximas.
- «Cazas»: se usa el acumulado `world.totals.hunts` (el `activity.hunt` por persona se pierde al morir). «Mansos» = animales con `habituation >= 0.45`; «cuidados» = suma de `tends` de animales vivos (no hay contador acumulado en el motor).

## Análisis

### (1) Extinciones y colapsos (mortales = habitantes con rol `neighbor`; S e I son inmortales y quedan siempre: `pop=2`)

| semilla | NUEVO: mortales <5 / =0 | CONTROL: mortales <5 / =0 |
|---|---|---|
| 42 | día 23 / 30 | día 17 / 27 |
| 9603 | día 24 / 31 | día 12 / 20 |
| 9606 | día 18 / 22 | día 12 / 20 |
| 19104 | día 21 / 24 | vivo a día 26 (pop 86) |
| 19101 | vivo a día 26 (pop 65, subiendo) | día 25 / 27 |
| 19103 | día 24: pop 17 y bajando | día 23 / 29 |
| 51926 | vivo a día 17 (pop 142) | vivo a día 19 (pop 131) |
| 7 | vivo a día 20 (pop 159) | vivo a día 18 (pop 138) |

- Causa en todas: **senescencia** (11-28 muertes por semilla), luego deshidratación (5-13) y exposición (2-10); no hay hambre (`starvation` = 0 en los 176 censos). Detalle en la tabla de causas.
- Mecanismo (diagnóstico `lab/diag-natalidad.mjs`, semilla 9603, ambos brazos, `lab/diagnat-*.jsonl`): los 14 fundadores nacen todos con la misma edad (≈2 días) y mueren juntos (longevidad 11-15 días, `params.ts:222`; senescencia desde el 75 %). La ventana fértil es corta (de la madurez ≈2 días a ≈8-11 días), y emparejar exige dos fértiles a ≤3 celdas con vínculo mutuo ≥0,3 (`natalidad-local.ts:37`, `radioPareja=3`). En el censo de los días 3-16 de NUEVO 9603 hubo 4-7 fértiles pero **ninguna pareja elegible** (`conSocioElegible=0` en todos los días; `fertilesConAlgunoCerca3=0` desde el día 9). Los nacimientos se congelan en 24 (NUEVO) y 7 (CONTROL) y la cohorte de segunda generación envejece sin relevo. Es un fenómeno de dispersión espacial + cohorte única, presente también en V22.
- Frente a CONTROL en la misma semilla: NUEVO pierde a los últimos mortales más tarde en 42, 9603, 9606 (+3, +11, +2 días), y sobrevive donde CONTROL se extingue en 19101 (a día 26 va subiendo) y mantiene 19103 más tiempo. En contra: **19104**, donde NUEVO colapsa (10 habitantes a día 15, 14 nacimientos) y CONTROL crece (55 habitantes, 54 nacimientos); con una réplica por brazo no se puede separar ley de caos.

### (2) Población NUEVO vs CONTROL (total, incluye S/I)

| semilla | día 15 NUEVO / CONTROL | día 30 NUEVO / CONTROL | día 60 |
|---|---|---|---|
| 51926 | 113 / 91 | — / — (cortadas en 17 / 19) | — |
| 7 | 86 / 96 | — / — (cortadas en 20 / 18) | — |
| 19101 | 40 / 23 | — / 2 | — / 2 |
| 19103 | 32 / 21 | — / 2 | — / 2 |
| 19104 | 10 / 55 | 2 / — (CONTROL cortada en 26, pop 86) | 2 / — |
| 42 | 14 / 11 | 2 / 2 | 2 / 2 |
| 9603 | 20 / 4 | 3 / 2 | 2 / 2 |
| 9606 | 8 / 4 | 2 / 2 | 2 / 2 |

NUEVO ≥ CONTROL a día 15 en 6 de 8 semillas (peor en 19104 y 7); las dos semillas grandes crecen en ambos brazos (51926 NUEVO 58→142 entre los días 8 y 17; 7 NUEVO 45→159 entre 8 y 20). **A 30 y 60 días no hay veredicto para las semillas vivas:** el tope de 40 min las cortó. Lo único comprobado a 30/60 días es que ninguna de las 5 semillas que colapsan en CONTROL ni las 4 que colapsan en NUEVO se recupera.

### (3) Poliominós: ¿por qué «0»?

- **No lo explica ningún cambio de v23.** En V22 también es 0 (CONTROL: 51926 a día 19 con 182 estructuras y 0; 19104 a día 26 con 211 estructuras y 0; 7 a día 18: 1 poliominó de 2 celdas), y NUEVO hace más: 51926 día 17: 6 poliominós (máx. 3 celdas), 7 día 20: 2, 19104 día 30: 1, 9606 día 15: 1.
- El «0» de Gemini son tres causas: 1,5 días en vez de 15 (el edificio multicelda necesita varias generaciones de planos), contar `cells >= 3` (exige ≥4 marcos: `fittingPolyomino`, `inventions.ts:131-134`, área = marcos − 1) y la métrica de fórmulas rota que desvió la lectura.
- Mecánica real: un poliominó necesita un plano con ≥3 marcos (`inventions.ts:132`, `target = n.frame - 1`) y que su factura (`polyominoCost`, `inventions.ts:119-123`, más el recargo `área²−1`) quepa en el presupuesto de un viaje + bodegas (`constructionBudget`, `inventions.ts:607`, con `CARRY = {wood:12, stone:8}`, `:572`). Diagnóstico `lab/diag-planos.mjs` (semilla 51926, días 3-15, `lab/diag-planos-*.jsonl`): en CONTROL los planos **elegidos** nunca pasan de 2 marcos (día 15: `{1:52, 2:39}`) aunque existen planos de 3-6; en NUEVO a día 9 ya hay 6 habitantes con plano de 3 marcos y 5 estructuras de 3 marcos, a día 15 `estructurasPorFrames {1:56, 2:243, 3:5, 4:1}`. Las bodegas con madera: NUEVO 383 de madera almacenada frente a 207 en CONTROL (día 15).
- Cambios de v23 que empujan hacia más poliominós (todos detrás de `quimica.emergente`): carga extra por fardo en el presupuesto (`inventions.ts:190`, `:607-610`, `:840`), el motivo «horno» que premia planos con hogar (`inventions.ts:684`, `:709`; 155 estructuras con hogar en NUEVO vs 14 en CONTROL a día 15) y el horno T2 en salones (`inventions.ts:999-1003`).
- Conclusión: **no hay regresión; la escasez de poliominós es el diseño de coste/presupuesto de V20-V22** y se resuelve con más días y más población, no con una corrección de v23.

### (4) Química

- Fórmulas: CONTROL (V22, `MAX_FORMULAS = 256`, árbol principal `chemistry.ts:34`) **se satura en 256/256** en las 3 semillas vivas (51926, 7, 19104) y se congela ahí. NUEVO (tope 512, poda por utilidad desde 496 hacia 448: `chemistry.ts:41-46`, `:455`) llega a 458-474 vivas en las semillas grandes a día 15-17 y ya lleva acumuladas 890-1 098 (51926) y 986 (7): la poda **sí** está actuando y el catálogo no se congela, pero se acerca al tope en unos 15 días con 140 habitantes, y en mundos de 1 000+ habitantes la poda será constante (coste O(n log n) por lote, ya amortizado).
- Operador dominante: **moler (`grind`)** en ambos brazos. CONTROL: moler 72-78 % en las semillas grandes (51926: moler 1 767 / lavar 410 / calentar 68 / ligar 15) y ≈90 % en las pequeñas; `heat` y `bind` casi no ocurren (0-2 en los mundos pequeños). NUEVO: 51926 → moler 3 479 (45 %), calentar 2 504 (33 %), ligar 1 247 (16 %), lavar 527 (7 %); 7 → 2 216 / 2 305 / 1 901 / 848 (31/32/26/12 %); en los mundos pequeños `bind` llega a 620 y `heat` a 727. Lavar es el menor en 6 de 8 semillas NUEVO (en 19103 y 9606 lo es calentar). Es decir, v23 activa por fin la rama térmica y de ligado que en V22 no se ejercía.
- Fabricación: NUEVO forja 419 (51926) y 816 (7) herramientas con tinte químico a día 17-20 (V22: 0).

### (5) Caza y ganadería

- **Aparecen en 8 de 8 semillas** NUEVO: mansos (hábito ≥0,45) en todas (p. ej. 51926: 659 mansos y 224 animales cuidados a día 17; 19104: 51 mansos a día 60; incluso 42: 7; 9603: 16), cazas 30-250 acumuladas, y herramientas forjadas con química. En CONTROL: cazas sí (11-210), mansos y cuidados 0 (no existen en V22).
- Matiz: en 51926 NUEVO caza menos que CONTROL (133 vs 210 a días 17-19) y en 7 más (250 vs 154); no hay señal clara de sustitución caza→cría a este tamaño de muestra. Los mansos sobreviven a la extinción de las personas (habituación por estructuras abandonadas), lo cual es un artefacto menor visible en 19104/42.

### (6) Veredicto y qué corregir

**Bloquea el despliegue (antes de publicar un mundo nuevo):**
1. Falta evidencia de supervivencia a 30-60 días en las semillas grandes. Relanzar 51926, 7, 19101 y 19103 (NUEVO) y 51926, 7, 19104 (CONTROL) con tope ≥120 min, idealmente con la torre menos cargada o en fedora (con RAM libre: hubo ≈24 GB libres a las 13:25; cada réplica con 140 habitantes ocupa ≈1,4 GB). Criterio sugerido (preregistrar): al menos 6 de 8 semillas con ≥20 mortales vivos al día 40.
2. El colapso demográfico previo (cohorte única de 14 fundadores de la misma edad + ventana fértil corta + emparejamiento a ≤3 celdas) ocurre en ≥50 % de semillas en ambos brazos. Si el mundo nuevo arranca igual que estas semillas, **se extinguirá igual que V19/V20**. Opciones a decidir por Steven (no se tocó nada): escalonar edades de los fundadores, o ampliar `poblacion.radioPareja`/ventana fértil (`cuerpo.*`, `poblacion.*`), o más fundadores. Cualquiera necesita su propio panel preregistrado.

**Puede esperar:** poliominós (no hay regresión), saturación de fórmulas (la poda funciona; vigilar coste con >1 000 habitantes), mansos persistentes tras la extinción, ajuste del reparto de operadores.

**Coste:** a 140 habitantes NUEVO corrió a 9-16 Hz bajo carga (CONTROL 11-13 Hz); no es comparable entre máquinas (el reparto no fue simétrico), así que no se afirma sobrecoste de v23. RSS ≈1,4 GB a 140 habitantes.

## Tablas (días 15/30/45/60 y último censo)

Las celdas «—» indican que la réplica terminó antes de ese día (tope de 40 min). Fuente cruda: `lab/raw/*.jsonl`, `lab/fedora/*.jsonl`; fusión de la mejor réplica por semilla y brazo: `lab/censo-final.jsonl`.

## Estado de cada réplica

| semilla | brazo | día alcanzado | estado | mortales<5 desde | mortales=0 desde | mín. mortales | Hz medio |
|---|---|---|---|---|---|---|---|
| 51926 | NUEVO | 17 | tope-tiempo | None | None | 20 | 28.9 |
| 51926 | CONTROL | 19 | tope-tiempo | None | None | 20 | 27.2 |
| 19101 | NUEVO | 26 | tope-tiempo | None | None | 19 | 32.1 |
| 19101 | CONTROL | 60 | completo | 25 | 27 | 0 | 380.8 |
| 19103 | NUEVO | 24 | tope-tiempo | None | None | 15 | 29.9 |
| 19103 | CONTROL | 60 | completo | 23 | 29 | 0 | 306.2 |
| 19104 | NUEVO | 60 | completo | 21 | 24 | 0 | 399.3 |
| 19104 | CONTROL | 26 | tope-tiempo | None | None | 16 | 34.0 |
| 7 | NUEVO | 20 | tope-tiempo | None | None | 16 | 41.4 |
| 7 | CONTROL | 18 | tope-tiempo | None | None | 17 | 23.2 |
| 42 | NUEVO | 60 | completo | 23 | 30 | 0 | 447.3 |
| 42 | CONTROL | 60 | completo | 17 | 27 | 0 | 503.5 |
| 9603 | NUEVO | 60 | completo | 24 | 31 | 0 | 404.4 |
| 9603 | CONTROL | 60 | completo | 12 | 20 | 0 | 763.6 |
| 9606 | NUEVO | 60 | completo | 18 | 22 | 0 | 1192.0 |
| 9606 | CONTROL | 60 | completo | 12 | 20 | 0 | 3327.1 |

### Población total (mortales + S/I) / nacimientos acumulados / muertes acumuladas

| semilla | brazo | d15 | d30 | d45 | d60 |
|---|---|---|---|---|---|
| 51926 | NUEVO | 113 / 115 / 18 | — | — | — |
| 51926 | CONTROL | 91 / 92 / 17 | — | — | — |
| 19101 | NUEVO | 40 / 45 / 21 | — | — | — |
| 19101 | CONTROL | 23 / 25 / 18 | 2 / 25 / 39 | 2 / 25 / 39 | 2 / 25 / 39 |
| 19103 | NUEVO | 32 / 39 / 23 | — | — | — |
| 19103 | CONTROL | 21 / 29 / 24 | 2 / 29 / 43 | 2 / 29 / 43 | 2 / 29 / 43 |
| 19104 | NUEVO | 10 / 14 / 20 | 2 / 14 / 28 | 2 / 14 / 28 | 2 / 14 / 28 |
| 19104 | CONTROL | 55 / 54 / 15 | — | — | — |
| 7 | NUEVO | 86 / 87 / 17 | — | — | — |
| 7 | CONTROL | 96 / 103 / 23 | — | — | — |
| 42 | NUEVO | 14 / 24 / 26 | 2 / 24 / 38 | 2 / 24 / 38 | 2 / 24 / 38 |
| 42 | CONTROL | 11 / 18 / 23 | 2 / 18 / 32 | 2 / 18 / 32 | 2 / 18 / 32 |
| 9603 | NUEVO | 20 / 23 / 19 | 3 / 24 / 37 | 2 / 24 / 38 | 2 / 24 / 38 |
| 9603 | CONTROL | 4 / 7 / 19 | 2 / 7 / 21 | 2 / 7 / 21 | 2 / 7 / 21 |
| 9606 | NUEVO | 8 / 9 / 17 | 2 / 9 / 23 | 2 / 9 / 23 | 2 / 9 / 23 |
| 9606 | CONTROL | 4 / 5 / 17 | 2 / 5 / 19 | 2 / 5 / 19 | 2 / 5 / 19 |

### Comunidades / estructuras / poliominós (máx. celdas) / caminos

| semilla | brazo | d15 | d30 | d45 | d60 |
|---|---|---|---|---|---|
| 51926 | NUEVO | 22 / 305 / 6 (3) / 67 | — | — | — |
| 51926 | CONTROL | 13 / 153 / 0 (1) / 71 | — | — | — |
| 19101 | NUEVO | 10 / 71 / 0 (1) / 26 | — | — | — |
| 19101 | CONTROL | 6 / 51 / 0 (1) / 13 | 0 / 6 / 0 (1) / 0 | 0 / 3 / 0 (1) / 0 | 0 / 11 / 3 (3) / 2 |
| 19103 | NUEVO | 7 / 80 / 0 (1) / 5 | — | — | — |
| 19103 | CONTROL | 4 / 24 / 0 (1) / 3 | 0 / 5 / 0 (1) / 0 | 0 / 3 / 0 (1) / 0 | 0 / 1 / 0 (1) / 0 |
| 19104 | NUEVO | 3 / 42 / 0 (1) / 4 | 0 / 9 / 1 (2) / 3 | 0 / 3 / 0 (1) / 0 | 0 / 1 / 0 (1) / 1 |
| 19104 | CONTROL | 13 / 139 / 0 (1) / 70 | — | — | — |
| 7 | NUEVO | 13 / 134 / 2 (2) / 64 | — | — | — |
| 7 | CONTROL | 13 / 171 / 0 (1) / 82 | — | — | — |
| 42 | NUEVO | 4 / 43 / 0 (1) / 34 | 0 / 12 / 0 (1) / 0 | 0 / 4 / 0 (1) / 0 | 0 / 3 / 0 (1) / 0 |
| 42 | CONTROL | 4 / 27 / 0 (1) / 0 | 0 / 4 / 0 (1) / 0 | 0 / 7 / 0 (1) / 0 | 0 / 8 / 0 (1) / 0 |
| 9603 | NUEVO | 4 / 64 / 0 (1) / 7 | 0 / 27 / 0 (1) / 0 | 0 / 2 / 0 (1) / 0 | 0 / 10 / 0 (1) / 0 |
| 9603 | CONTROL | 0 / 9 / 0 (1) / 2 | 0 / 13 / 0 (1) / 0 | 0 / 4 / 0 (1) / 0 | 0 / 1 / 0 (1) / 0 |
| 9606 | NUEVO | 1 / 22 / 1 (2) / 0 | 0 / 7 / 1 (2) / 0 | 0 / 4 / 0 (1) / 0 | 0 / 1 / 0 (1) / 0 |
| 9606 | CONTROL | 1 / 11 / 0 (1) / 0 | 0 / 5 / 0 (1) / 0 | 0 / 7 / 0 (1) / 0 | 0 / 5 / 0 (1) / 0 |

### Fórmulas vivas / acumuladas / lotes / operadores g-w-h-b

| semilla | brazo | d15 | d30 | d45 | d60 |
|---|---|---|---|---|---|
| 51926 | NUEVO | 458 / 890 / 10272 / 2866-426-2026-942 | — | — | — |
| 51926 | CONTROL | 256 / 256 / 2932 / 1311-278-31-1 | — | — | — |
| 19101 | NUEVO | 275 / 275 / 3164 / 659-268-312-608 | — | — | — |
| 19101 | CONTROL | 108 / 108 / 970 / 460-50-0-0 | 136 / 136 / 1312 / 618-76-0-0 | 139 / 139 / 1390 / 655-80-0-0 | 156 / 156 / 1696 / 796-104-0-0 |
| 19103 | NUEVO | 286 / 286 / 2782 / 695-265-179-496 | — | — | — |
| 19103 | CONTROL | 64 / 64 / 579 / 273-33-0-0 | 84 / 84 / 707 / 329-49-0-0 | 84 / 84 / 711 / 331-49-0-0 | 86 / 86 / 714 / 332-50-0-0 |
| 19104 | NUEVO | 380 / 380 / 2437 / 747-107-379-265 | 429 / 429 / 2857 / 836-111-462-353 | 434 / 434 / 3052 / 892-119-494-389 | 476 / 476 / 3735 / 980-122-587-620 |
| 19104 | CONTROL | 197 / 197 / 1452 / 681-63-25-2 | — | — | — |
| 7 | NUEVO | 454 / 598 / 7633 / 1415-479-1553-1234 | — | — | — |
| 7 | CONTROL | 256 / 256 / 3395 / 1428-338-171-30 | — | — | — |
| 42 | NUEVO | 240 / 240 / 1617 / 440-110-174-228 | 317 / 317 / 2569 / 784-150-258-304 | 342 / 342 / 2914 / 933-186-258-307 | 346 / 346 / 3007 / 974-186-258-307 |
| 42 | CONTROL | 73 / 73 / 514 / 250-14-0-0 | 93 / 93 / 663 / 318-27-0-0 | 94 / 94 / 670 / 320-30-0-0 | 101 / 101 / 715 / 338-39-0-0 |
| 9603 | NUEVO | 227 / 227 / 2368 / 666-89-397-237 | 290 / 290 / 3597 / 976-131-663-398 | 308 / 308 / 3799 / 1040-134-709-418 | 314 / 314 / 3914 / 1076-137-727-437 |
| 9603 | CONTROL | 69 / 69 / 554 / 269-16-0-0 | 70 / 70 / 556 / 270-16-0-0 | 77 / 77 / 651 / 317-17-0-0 | 81 / 81 / 712 / 347-18-0-0 |
| 9606 | NUEVO | 201 / 201 / 1221 / 370-104-94-162 | 217 / 217 / 1362 / 403-113-98-195 | 233 / 233 / 1496 / 423-117-106-241 | 239 / 239 / 1562 / 427-123-106-269 |
| 9606 | CONTROL | 88 / 88 / 534 / 255-24-0-0 | 89 / 89 / 554 / 265-24-0-0 | 89 / 89 / 554 / 265-24-0-0 | 89 / 89 / 554 / 265-24-0-0 |

### Herramientas / forjadas / cazas / animales / mansos / cuidados vivos

| semilla | brazo | d15 | d30 | d45 | d60 |
|---|---|---|---|---|---|
| 51926 | NUEVO | 418 / 393 / 115 / 1231 / 598 / 398 | — | — | — |
| 51926 | CONTROL | 438 / 0 / 162 / 629 / 0 / 0 | — | — | — |
| 19101 | NUEVO | 246 / 242 / 56 / 470 / 258 / 281 | — | — | — |
| 19101 | CONTROL | 104 / 0 / 54 / 341 / 0 / 0 | 32 / 0 / 69 / 249 / 0 / 0 | 32 / 0 / 75 / 10 / 0 / 0 | 31 / 0 / 77 / 20 / 0 / 0 |
| 19103 | NUEVO | 167 / 164 / 94 / 746 / 261 / 122 | — | — | — |
| 19103 | CONTROL | 118 / 0 / 52 / 358 / 0 / 0 | 32 / 0 / 62 / 0 / 0 / 0 | 32 / 0 / 62 / 12 / 0 / 0 | 32 / 0 / 62 / 47 / 0 / 0 |
| 19104 | NUEVO | 54 / 43 / 34 / 291 / 110 / 35 | 19 / 18 / 41 / 111 / 24 / 9 | 27 / 26 / 41 / 123 / 6 / 0 | 26 / 25 / 41 / 193 / 51 / 75 |
| 19104 | CONTROL | 241 / 0 / 73 / 996 / 0 / 0 | — | — | — |
| 7 | NUEVO | 588 / 556 / 119 / 1387 / 707 / 614 | — | — | — |
| 7 | CONTROL | 340 / 0 / 88 / 1307 / 0 / 0 | — | — | — |
| 42 | NUEVO | 64 / 63 / 38 / 567 / 266 / 75 | 24 / 24 / 38 / 71 / 4 / 3 | 32 / 32 / 38 / 12 / 6 / 5 | 32 / 32 / 38 / 148 / 7 / 2 |
| 42 | CONTROL | 76 / 0 / 22 / 204 / 0 / 0 | 25 / 0 / 22 / 4 / 0 / 0 | 28 / 0 / 23 / 3 / 0 / 0 | 32 / 0 / 23 / 49 / 0 / 0 |
| 9603 | NUEVO | 103 / 103 / 28 / 351 / 102 / 143 | 48 / 48 / 29 / 55 / 37 / 17 | 32 / 32 / 30 / 100 / 8 / 0 | 31 / 31 / 30 / 18 / 16 / 2 |
| 9603 | CONTROL | 45 / 0 / 20 / 61 / 0 / 0 | 22 / 0 / 20 / 37 / 0 / 0 | 27 / 0 / 21 / 47 / 0 / 0 | 32 / 0 / 21 / 195 / 0 / 0 |
| 9606 | NUEVO | 62 / 62 / 30 / 147 / 31 / 19 | 0 / 0 / 31 / 28 / 19 / 6 | 4 / 4 / 31 / 86 / 60 / 19 | 7 / 7 / 32 / 23 / 4 / 3 |
| 9606 | CONTROL | 22 / 0 / 11 / 103 / 0 / 0 | 2 / 0 / 11 / 0 / 0 / 0 | 7 / 0 / 11 / 0 / 0 / 0 | 12 / 0 / 11 / 0 / 0 / 0 |

### Causas principales de muerte (acumuladas)

| semilla | brazo | d15 | d30 | d45 | d60 |
|---|---|---|---|---|---|
| 51926 | NUEVO | senescence:13, exposure:3, dehydration:2 | — | — | — |
| 51926 | CONTROL | senescence:13, dehydration:3, exposure:1 | — | — | — |
| 19101 | NUEVO | senescence:16, exposure:4, dehydration:1 | — | — | — |
| 19101 | CONTROL | senescence:10, dehydration:5, exposure:3 | senescence:26, exposure:8, dehydration:5 | senescence:26, exposure:8, dehydration:5 | senescence:26, exposure:8, dehydration:5 |
| 19103 | NUEVO | senescence:13, dehydration:6, exposure:4 | — | — | — |
| 19103 | CONTROL | senescence:14, dehydration:7, exposure:3 | senescence:28, dehydration:10, exposure:5 | senescence:28, dehydration:10, exposure:5 | senescence:28, dehydration:10, exposure:5 |
| 19104 | NUEVO | senescence:13, dehydration:4, exposure:3 | senescence:18, dehydration:5, exposure:5 | senescence:18, dehydration:5, exposure:5 | senescence:18, dehydration:5, exposure:5 |
| 19104 | CONTROL | senescence:11, dehydration:2, exposure:2 | — | — | — |
| 7 | NUEVO | senescence:8, exposure:5, dehydration:4 | — | — | — |
| 7 | CONTROL | dehydration:10, senescence:9, exposure:4 | — | — | — |
| 42 | NUEVO | dehydration:12, senescence:12, exposure:2 | senescence:21, dehydration:13, exposure:4 | senescence:21, dehydration:13, exposure:4 | senescence:21, dehydration:13, exposure:4 |
| 42 | CONTROL | senescence:12, dehydration:9, exposure:2 | senescence:21, dehydration:9, exposure:2 | senescence:21, dehydration:9, exposure:2 | senescence:21, dehydration:9, exposure:2 |
| 9603 | NUEVO | dehydration:9, senescence:8, exposure:2 | senescence:17, dehydration:13, exposure:7 | senescence:18, dehydration:13, exposure:7 | senescence:18, dehydration:13, exposure:7 |
| 9603 | CONTROL | exposure:8, dehydration:6, senescence:5 | exposure:10, dehydration:6, senescence:5 | exposure:10, dehydration:6, senescence:5 | exposure:10, dehydration:6, senescence:5 |
| 9606 | NUEVO | senescence:9, dehydration:5, exposure:3 | senescence:13, dehydration:5, exposure:5 | senescence:13, dehydration:5, exposure:5 | senescence:13, dehydration:5, exposure:5 |
| 9606 | CONTROL | senescence:10, dehydration:4, exposure:3 | senescence:11, dehydration:5, exposure:3 | senescence:11, dehydration:5, exposure:3 | senescence:11, dehydration:5, exposure:3 |

### Hz de simulación (último intervalo de 5 días) / RSS MB

| semilla | brazo | d15 | d30 | d45 | d60 |
|---|---|---|---|---|---|
| 51926 | NUEVO | 8.7 / 1446 | — | — | — |
| 51926 | CONTROL | 13.1 / 1101 | — | — | — |
| 19101 | NUEVO | 20.8 / 1405 | — | — | — |
| 19101 | CONTROL | 41.1 / 855 | 353.7 / 911 | 509.6 / 911 | 491.1 / 914 |
| 19103 | NUEVO | 20.7 / 1204 | — | — | — |
| 19103 | CONTROL | 43.9 / 1274 | 564.3 / 1322 | 428.2 / 1322 | 556.7 / 1322 |
| 19104 | NUEVO | 65.3 / 1038 | 610.4 / 1115 | 534.6 / 1115 | 349.2 / 1115 |
| 19104 | CONTROL | 29.4 / 624 | — | — | — |
| 7 | NUEVO | 16.3 / 948 | — | — | — |
| 7 | CONTROL | 10.9 / 804 | — | — | — |
| 42 | NUEVO | 58.6 / 1102 | 585.3 / 1337 | 535.4 / 1335 | 629.5 / 1335 |
| 42 | CONTROL | 55.5 / 664 | 905.1 / 658 | 989.3 / 669 | 496.9 / 668 |
| 9603 | NUEVO | 59.5 / 1039 | 477.4 / 1277 | 989.2 / 1272 | 504.4 / 1271 |
| 9603 | CONTROL | 408.2 / 617 | 1111.2 / 630 | 1071.6 / 656 | 633 / 723 |
| 9606 | NUEVO | 59.7 / 1137 | 283.1 / 1157 | 1996.2 / 1159 | 3099.3 / 1159 |
| 9606 | CONTROL | 338.1 / 705 | 4223.8 / 777 | 4938.9 / 778 | 5520.4 / 751 |

### Último censo de cada réplica (día alcanzado)

| semilla | brazo | día | pop | mortales | nac. | muertes | com. | estr. | polio | caminos | fórm. vivas/acum | herr./forj. | cazas | animales | mansos | cuidados | operadores g-w-h-b |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 51926 | NUEVO | 17 | 142 | 140 | 156 | 30 | 23 | 342 | 6 (3) | 74 | 474/1098 | 443/419 | 133 | 1513 | 659 | 224 | 3479-527-2504-1247 |
| 51926 | CONTROL | 19 | 131 | 129 | 142 | 27 | 12 | 182 | 0 (1) | 101 | 256/256 | 594/0 | 210 | 948 | 0 | 0 | 1767-410-68-15 |
| 19101 | NUEVO | 26 | 65 | 63 | 99 | 50 | 14 | 100 | 0 (1) | 43 | 473/473 | 206/193 | 130 | 1068 | 265 | 130 | 1116-498-816-1551 |
| 19101 | CONTROL | 60 | 2 | 0 | 25 | 39 | 0 | 11 | 3 (3) | 2 | 156/156 | 31/0 | 77 | 20 | 0 | 0 | 796-104-0-0 |
| 19103 | NUEVO | 24 | 17 | 15 | 47 | 46 | 4 | 65 | 0 (1) | 28 | 350/350 | 61/59 | 105 | 753 | 342 | 102 | 873-381-237-919 |
| 19103 | CONTROL | 60 | 2 | 0 | 29 | 43 | 0 | 1 | 0 (1) | 0 | 86/86 | 32/0 | 62 | 47 | 0 | 0 | 332-50-0-0 |
| 19104 | NUEVO | 60 | 2 | 0 | 14 | 28 | 0 | 1 | 0 (1) | 1 | 476/476 | 26/25 | 41 | 193 | 51 | 49 | 980-122-587-620 |
| 19104 | CONTROL | 26 | 86 | 84 | 123 | 53 | 16 | 211 | 0 (1) | 142 | 256/256 | 223/0 | 187 | 930 | 0 | 0 | 1266-122-26-2 |
| 7 | NUEVO | 20 | 159 | 157 | 180 | 37 | 25 | 213 | 2 (2) | 139 | 458/986 | 899/816 | 250 | 1556 | 237 | 92 | 2216-848-2305-1901 |
| 7 | CONTROL | 18 | 138 | 136 | 160 | 38 | 20 | 202 | 1 (2) | 102 | 256/256 | 421/0 | 154 | 1694 | 0 | 0 | 1973-508-221-37 |
| 42 | NUEVO | 60 | 2 | 0 | 24 | 38 | 0 | 3 | 0 (1) | 0 | 346/346 | 32/32 | 38 | 148 | 7 | 2 | 974-186-258-307 |
| 42 | CONTROL | 60 | 2 | 0 | 18 | 32 | 0 | 8 | 0 (1) | 0 | 101/101 | 32/0 | 23 | 49 | 0 | 0 | 338-39-0-0 |
| 9603 | NUEVO | 60 | 2 | 0 | 24 | 38 | 0 | 10 | 0 (1) | 0 | 314/314 | 31/31 | 30 | 18 | 16 | 2 | 1076-137-727-437 |
| 9603 | CONTROL | 60 | 2 | 0 | 7 | 21 | 0 | 1 | 0 (1) | 0 | 81/81 | 32/0 | 21 | 195 | 0 | 0 | 347-18-0-0 |
| 9606 | NUEVO | 60 | 2 | 0 | 9 | 23 | 0 | 1 | 0 (1) | 0 | 239/239 | 7/7 | 32 | 23 | 4 | 2 | 427-123-106-269 |
| 9606 | CONTROL | 60 | 2 | 0 | 5 | 19 | 0 | 5 | 0 (1) | 0 | 89/89 | 12/0 | 11 | 0 | 0 | 0 | 265-24-0-0 |
