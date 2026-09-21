# ¿Dio frutos el esfuerzo? Análisis escéptico de dinámicas, cooperación y complejización

**Fecha**: 2026-09-21 · **SHA del árbol**: `3e48fa5` · **Rama**: `001-mundo-solido-masivo`
**Pregunta de Steven**: «¿todo nuestro esfuerzo dio frutos? ¿realmente tenemos dinámicas complejas, los agentes cooperan y se complejizan en el tiempo?»
**Método**: solo lectura. Cuatro mundos SQLite (público vivo, extinto de 58 d, demo, reglas viejas) + 10 réplicas de laboratorio + el estado vivo por HTTPS. Scripts y SQL en el anexo (§5). Ninguna cifra de este informe es de memoria ni de impresión: todas salen de los scripts del anexo, reejecutables.

---

## 1. Veredicto honesto (10 líneas)

1. **Hay un mundo que funciona técnicamente y no hay fraude**: los contadores no se inventan, cada cooperación es una decisión con transferencia material real, y cada muerte tiene causa. Eso sí se sostiene.
2. **No hay complejización social en el tiempo.** La cooperación por habitante es una meseta (15–27 actos/día) en los cuatro mundos y en todas las épocas; no crece con los días ni con la población.
3. **La "cooperación" es, en el 97 %, una sola cosa**: enseñar. De los 10 145 actos del mundo público, 9 848 son demostraciones de habilidad, 232 ayuda de obra, 62 trueque y **3** aportes de material o turnos.
4. **Los conflictos no existen**: `conflicts = 0` en los cuatro mundos, en 58, 22, 18 y 8 días. `resourceDispute` nunca se dispara. La negociación por escasez es código muerto en la práctica.
5. **La complejización técnica es real pero débil y no acumulativa**: 190 "generaciones" de receta equivalen a pasar de 2,1 a 4,5 operaciones por programa. El 71 % de las recetas no se usa **jamás**; solo el 3,8 % está viva (usada en el último día).
6. **La transmisión cultural decae**: la fracción de fabricaciones/usos con receta de OTRO cae del 60 % (día 1) al 8–14 % (día 11–17) y al **0 %** desde el día 30 del mundo extinto.
7. **La métrica formal propia del proyecto lo dice sin rodeos**: `organization.autopoiesisEstablished = false`, `maximalRaf = []`, `constructibleFromFood = []`, `catalystReplacementCoverage = 0`. No hay ningún conjunto autocatalítico ni componente mantenido.
8. **La diversidad de conducta se DEGRADA con el día**: SC-003 exige ≥ 0,60 y las cuatro instantáneas de las reglas nuevas bajan monótonamente — 0,352 (d7,5) → 0,214 (d16,2) → **0,197** (d18,7, mundo vivo) → 0,141 (d58,5). El mundo con reglas VIEJAS marca 0,466 a los 21,9 días: **2,4× más diverso** que el nuevo.
9. **El mundo público está demográficamente muerto y el mecanismo es nuevo**: 0 nacimientos en 13,7 días simulados y 18 de 18 vecinos pasados de `senescenceStart` al día 16. El tope de 40 ya no existe; el sospechoso documentado es el **gobernador de R17** (la instantánea guarda `reproductionEnabled: false`), con la reserva de alimento como cofactor. Destino: 2 habitantes, como el mundo extinto.
10. **Artefactos a descontar**: `recetasDistintasEnUso` no son recetas en uso (es un contador monótono, ×26 sobre la realidad); `diversidadFuncional` nunca baja por definición; 188 500 de las 215 588 "ejecuciones de tecnología" (87,4 %) son contabilidad de agua; y el "58 días de supervivencia" son 29 días de un mundo con dos habitantes protegidos por ley y **estériles por ley**.

---

## 2. Tablas por métrica

### 2.1 Población y demografía

**Mundo público (`data/world.sqlite`, respaldo `world-20260921-1815-predeploy6`, reconstruido de `legacy` + `bornAt`)**

| Día | Población | Nac./día | Muertes/día | Causas | Generaciones vivas |
|---|---|---|---|---|---|
| 1 | 22 | 6 | 0 | — | 2 |
| 4 | 35 | 3 | 0 | — | 2 |
| 5 | 35 | **0** | 0 | — | 3 |
| 10 | 35 | 0 | 0 | — | 3 |
| 11 | 33 | 0 | 2 | exposición 1, senescencia 1 | 3 |
| 15 | 26 | 0 | 4 | senescencia 4 | 3 |
| 16 | 20 | 0 | 6 | senescencia 6 | 3 (0:4, 1:12, 2:4) |
| 18,7 (vivo hoy) | **11** | 0 | — | acum. 21 senesc. + 3 exp. | 3 (0:2, 1:7, 2:2) |

**Cero nacimientos desde el día 4** (19 en total, todos en los días 1–4). `birthCounter` 19 al día 16,17 y 19 al día 18,73.

**Mundo extinto de 58 días (`world-20260919-1627-extinto-dia58.sqlite`)**

| Día | 1 | 5 | 10 | 15 | 20 | 25 | 30 | 58,5 |
|---|---|---|---|---|---|---|---|---|
| Población | 22 | 40 | 40 | 31 | 10 | 4 | **2** | **2** |
| Nacimientos acum. | 6 | 24 | 24 | 26 | 26 | 26 | 26 | 26 |
| Muertes acum. | 0 | 0 | 0 | 9 | 30 | 36 | 38 | 40 |
| Actores distintos en el archivo técnico | 19 | 35 | 40 | 35 | 13 | 4 | 3 | 2 |

Última muerte: día **29,03**. Los 29 días restantes son dos habitantes: **S e I**, que (a) no pueden morir (`protected: person.role !== 'neighbor'`, `lineage.ts:134`; `demography.ts:150` revierte la muerte) y (b) no pueden reproducirse (`reproductiveReadiness` devuelve `false` si `role !== 'neighbor'`, `family.ts:43`). Muertes: 35 senescencia, 4 exposición, 1 deshidratación, 0 hambre. Edad al morir 10,8–20,1 d (media 15,9). Generación máxima entre los muertos: **2**.

**Laboratorio T032 (30 días, SIN gobernador, sin tope, `longevidadPorResiliencia=4`)**

| Día | seed-1 | seed-7 | seed-4 | seed-1 gen. vivas | seed-1 nac./día | seed-1 muertes/día |
|---|---|---|---|---|---|---|
| 1 | 22 | 18 | 18 | 2 | 6 | 0 |
| 5 | 38 | 26 | 18 | 4 | 7 | 0 |
| 10 | 28 | 35 | 12 | 6 | 4 | 8 |
| 15 | 46 | 34 | 3 | 7 | 0 | 0 |
| 20 | 108 | 42 | 3 | 10 | 18 | 3 |
| 25 | 214 | 63 | 2 | 11 | 34 | 5 |
| 28–30 | **284** (d28) | **115** (d30) | **2** (d30) | 8 (d28) | 26 | 7 |

**Estado final de las 10 réplicas de T032** (EVIDENCIA.md solo reportó las 4 que pasaron de 28 días; estas son todas):

| Réplica | Último día | Población | Generaciones vivas | Nacimientos | Muertes (sed / exp. / senesc.) |
|---|---|---|---|---|---|
| resil. 4 · seed-1 | 28 | **284** | 8 | 360 | 46 / 8 / 38 |
| resil. 4 · seed-2 | 23 | 141 | 10 | 169 | 10 / 2 / 32 |
| resil. 4 · seed-3 | 21 | 144 | 10 | 180 | 4 / 13 / 35 |
| resil. 4 · seed-4 | 30 | **2 (extinta)** | 1 | 15 | **20** / 6 / 3 |
| resil. 4 · seed-5 | 22 | 152 | 10 | 171 | 1 / 3 / 31 |
| resil. 4 · seed-6 | 29 | 130 | 9 | 179 | 9 / 10 / 46 |
| resil. 4 · seed-7 | 30 | 115 | 11 | 138 | 0 / 11 / 28 |
| resil. 4 · seed-8 | 19 | 139 | 9 | 153 | 1 / 5 / 24 |
| resil. 12 · seed-1 | 24 | 276 | 11 | 342 | 68 / 2 / 12 |
| resil. 12 · seed-2 | 12 | 72 | 6 | 58 | 1 / 0 / 1 |

Lectura: **sin gobernador y sin tope, 9 de 10 réplicas se reemplazan y crecen** (×4 a ×18 en 19–30 días, 6–11 generaciones vivas simultáneas); **1 de 10 se extingue, por sed** (seed-4: 20 de 29 muertes por deshidratación). El laboratorio **no ejecuta el gobernador**: `scripts/lab/replica.ts` y `barrido.ts` no mencionan `reproductionEnabled` ni `decideReproduction` (0 coincidencias), `createWorld` lo deja en `true` y nada en `src/world` lo apaga — solo `src/server/app.ts`. Por eso el barrido no podía detectar el fallo que sí mata al mundo público. El barrido T051 en curso (`artifacts/lab/t051-20260921-1812-30d`, 9/16 réplicas parciales al cierre) reproduce el patrón: poblaciones de 49–168 a los días 14–23, salvo seed-4 (2 vivos al día 30).

### 2.2 Cooperación — totales y **por habitante**

**Desglose real del contador `cooperation`** (cada rama de `society.ts:cooperate` incrementa `cooperation` y además su subcontador):

| Mundo | Día | `cooperation` | `teaching` | `trade` | `constructionHelp` | resto (supply + turnos) | `conflicts` |
|---|---|---|---|---|---|---|---|
| Público (vivo) | 18,7 | 10 145 | **9 848 (97,1 %)** | 62 (0,6 %) | 232 (2,3 %) | **3** | **0** |
| Extinto | 58,5 | 10 049 | 9 574 (95,3 %) | 68 | 403 | 4 | **0** |
| Demo | 7,5 | 3 320 | 3 094 (93,2 %) | 35 | 190 | 1 | **0** |
| Reglas viejas | 21,9 | 7 377 | 7 133 (96,7 %) | 77 | 162 | 5 | **0** |

**Actos de cooperación por habitante y día** (eventos de crónica `kind='cooperation'` ÷ población de ese día):

| Día | Público | Reglas viejas | Lab seed-1 (Δ`totals.cooperation`/pob) |
|---|---|---|---|
| 1 | — (crónica podada) | 9,0 | 7,0 |
| 5 | — | 7,9 | 17,8 |
| 7 | 16,6 | 11,4 | 19,8 |
| 10 | 22,7 | 21,5 | 21,3 |
| 15 | 27,0 | 10,9 | 22,8 |
| 16 | 25,6 | 14,9 | 19,7 |
| 20 | — | 14,7 | 17,6 |
| 25 | — | — | 21,5 |
| 28 | — | — | 26,7 |

**No hay tendencia creciente sostenida.** El techo estructural es 80 actos/persona/día (`world.tick - person.lastSocial < 30`, `society.ts:128`): lo observado es el 19–34 % de ese techo, constante. En el laboratorio la población se multiplica por 13 (22→284) y la intensidad per cápita se queda en la misma banda.

**Enseñanza**: 96–99 % de los eventos `cooperation` llevan el texto «Mostró … aprendió» (rama de enseñanza). **Turnos ante escasez**: **0** eventos en los cuatro mundos (el texto «acordaron turnarse» no aparece nunca). **Conflictos**: 0 eventos `kind='conflict'` en 20 976 + 25 157 + 11 064 eventos examinados.

**Comunidades** (`society.ts:updateCommunities`)

| Mundo | Comunidades | Tamaño medio | Disputas | Eventos `community` |
|---|---|---|---|---|
| Público (vivo, d18,7) | 3 | 3,7 | 0 | 0 desde el día 6 |
| Extinto (d58) | 1 | 2 | 0 | 0 |
| Demo (d7,5) | 3 | 13,0 | 0 | 0 |
| Reglas viejas (d21,9) | 1 | 16,0 | 0 | 3, todos el día 1 |

Las comunidades se forman en el día 1 y **no vuelven a cambiar**: ni escisiones, ni fusiones, ni migraciones. El mecanismo de revisión de pertenencia existe (`culturalDistance ≥ 0,3` + confianza < 0,35 + 2 alternativas) y nunca se cumple.

### 2.3 Complejidad técnica

**Profundidad de generaciones y complejidad REAL del programa (mundo extinto, 7 025 recetas)**

| Generación de la receta | n | Pasos medios del programa | Entradas medias |
|---|---|---|---|
| 1 | 454 | 2,13 | 1,15 |
| 2–5 | 596 | 2,62 | 1,23 |
| 6–10 | 627 | 3,21 | 1,26 |
| 11–25 | 1 806 | 3,44 | 1,28 |
| 26–50 | 1 726 | 3,72 | 1,31 |
| 51–100 | 999 | 4,04 | 1,32 |
| 101–150 | 482 | 4,28 | 1,35 |
| **151–191** | 335 | **4,48** | 1,33 |

**190 generaciones de descendencia = +2,35 operaciones.** La "generación" es un contador de linaje (`1 + max(generación de los padres)`), no una medida de complejidad. La complejidad real crece de forma logarítmica y prácticamente saturada.

**Serie por día (mundo extinto)**

| Día | Recetas nuevas | Gen. máx. acum. | Gen. media de las nuevas | Perfiles funcionales acum. | Suma de capacidades media |
|---|---|---|---|---|---|
| 1 | 66 | 9 | 3,58 | 11 | 0,420 |
| 5 | 232 | 41 | 8,09 | 88 | 0,718 |
| 10 | 469 | 48 | 18,29 | 274 | 0,986 |
| 15 | 429 | 85 | 32,41 | 485 | 0,996 |
| 20 | 160 | 97 | 47,54 | 565 | 0,910 |
| 25 | 39 | 97 | 72,90 | 576 | 1,075 |
| 30 | 30 | 104 | 82,57 | 591 | 1,175 |
| 58 | 30 | 190 | 176,80 | 632 | 0,713 |

La creación de recetas cae de 469/día (día 10, 40 habitantes) a 30/día (día 58, **2** habitantes) — es decir, de 11,7 a 15 por habitante y día: la tasa per cápita **no cae**, la población sí. La suma media de capacidades (utilidad bruta de la receta) **no crece**: 0,42 → 1,18 → 0,71. No hay mejora acumulativa de calidad.

**Transmisión cultural** (fracción de ejecuciones `craft`/`use` cuya receta la inventó OTRO actor)

| Día | Extinto | Público |
|---|---|---|
| 1 | 60,7 % | 60,7 % |
| 5 | 44,3 % | 42,3 % |
| 10 | 16,1 % | 13,8 % |
| 15 | 11,5 % | 10,9 % |
| 20 | 4,4 % | — |
| 25 | 1,4 % | — |
| 30–58 | **0,0 %** | — |

**Recetas vivas vs muertas**

| Mundo | Recetas definidas | Nunca usadas | Vivas (último 1 día) | Vivas (últimos 10 días) | Top 1 % concentra |
|---|---|---|---|---|---|
| Extinto (d58) | 7 025 | **4 980 (70,9 %)** | 25 (0,4 %) | 104 (1,5 %) | 31,3 % de los usos |
| Público (d16) | 4 435 | 3 181 (71,7 %) | **170 (3,8 %)** | 1 075 (24,2 %) | 28,4 % |
| Reglas viejas (d21,9) | 4 019 | 2 879 (71,6 %) | 78 (1,9 %) | 443 (11,0 %) | 24,8 % |

**Tipos de ejecución (mundo extinto, 215 588 filas)**: `water` 188 500 (87,4 %), `use` 15 191, `research` 9 457, `recycle` 1 360, `craft` 917, `transfer` 124, `estate` 39. Solo `research` puede fallar (éxito 75,6 %); `craft`, `use`, `recycle`, `water` tienen éxito 100 % **por construcción**.

**Cierre organizativo (métrica propia, `/api/world.organization`, ventana de 94 ticks en el mundo vivo)**

| Campo | Valor |
|---|---|
| `autopoiesisEstablished` | **false** |
| `maximalRaf` (conjunto autocatalítico) | **[]** |
| `constructibleFromFood` | **[]** |
| `maintainedComponents` / `structuralComponents` | **0 / 8** |
| `catalystReplacementCoverage` | **0** |
| `diversity.maxAncestorDepth` | **0** (linaje irresoluble en la ventana) |
| `evidence` | 127 ejecuciones, 14 con éxito |
| Bloqueos dominantes por proceso | `no-repeated-flux`, `not-food-generated`, `unproduced-resource:*` |

### 2.4 Diversidad

**SC-003 — índice de conducta** (calculado con el `indiceDiversidad` REAL de `src/world/diversidad.ts` sobre cada instantánea; verificado con `npx tsx`, coincide dígito a dígito con mi reimplementación de control):

| Mundo | Día | n | conducta | oficios | total | SC-003 (≥ 0,60) |
|---|---|---|---|---|---|---|
| Público del despliegue 11:19 (EVIDENCIA.md:449; **otra instancia**, no la actual) | ~1 | 32 | 0,60 | — | — | límite |
| Demo | 7,5 | 40 | 0,352 | 0,396 | 0,374 | **FALLA** |
| Público (respaldo) | 16,2 | 20 | 0,214 | 0,245 | 0,230 | **FALLA** |
| Público (vivo, `/api/world`) | 18,7 | 11 | **0,197** | 0,208 | 0,203 | **FALLA** |
| Reglas VIEJAS | 21,9 | 16 | **0,466** | 0,427 | 0,446 | FALLA (pero **2,4× mejor**) |
| Extinto | 58,5 | 2 | 0,141 | 0,000 | 0,071 | **FALLA** |

**El laboratorio no mide SC-003.** `replica.ts:dailyMetrics` graba `diversidadOficios` = entropía de Shannon **en bits** de `specialty()`, que no es el índice del spec. Es una omisión, no un dato adverso: nadie ha comprobado SC-003 en réplicas.

**Oficio dominante en el mundo público (d16,2)**: `cooperate` 16/20, `research` 2, `explore` 1, `drink` 1. En vivo (d18,7), `specialty()`: «cooperación·research» 9/11. Homogeneidad casi total.

**Entropía de oficios en el laboratorio (bits, máx. log₂18 = 4,17)**: seed-1 va de 3,17 (día 1, 22 hab) a **2,48** (día 28, 284 hab); seed-7 de 2,43 a 3,20. Con la población multiplicada por 13, la riqueza de oficios no aumenta.

**Varianza genética entre vivos** (14 alelos, `varianzaFundadores = 0,15`)

| Mundo | Día | n | Varianza media | Mín. | Máx. | Mutaciones (media / máx.) |
|---|---|---|---|---|---|---|
| Demo | 7,5 | 40 | 0,1173 | 0,0935 | 0,1441 | 0,70 / 4 |
| Público | 16,2 | 20 | 0,1091 | 0,0793 | 0,1424 | 0,75 / 2 |
| Reglas viejas | 21,9 | 16 | **0,0328** | 0,0002 | 0,1166 | 0,88 / 2 |
| Extinto | 58,5 | 2 | 0,0443 | 0,0018 | 0,0982 | 0 / 0 |

La variación heredable **existe** y aún no ha convergido en el mundo público (0,109 frente a 0,15 de partida), pero con 3 generaciones y ≤ 2 mutaciones por individuo no hay margen para hablar de evolución. Con más generaciones (reglas viejas, 6 generaciones) la varianza cae a 0,033: **converge**.

### 2.5 Ecología

| Métrica | Objetivo (SC-004) | Público (vivo, d18,7) | Extinto (d58) | Demo (d7,5) | Reglas viejas (d21,9) |
|---|---|---|---|---|---|
| Gini de comida por región | ≥ 0,35 | **0,128** ❌ | — | — | — |
| Fracción de celdas con comida > 0,1 | — | **1,000** | 1,000 | 1,000 | 1,000 |
| Celdas de tierra con comida > 0,3 | — | **98,1 %** | 90,7 % | 94,6 % | 100 % |
| Comida media por celda de tierra | — | 0,793 | 0,592 | 0,623 | 0,850 |
| Regiones sin agua superficial | ≥ 30 % | **21,1 %** ❌ | — | — | — |
| Distancia media al agua potable | > 6 celdas | **8,31** ✅ | — | — | — |
| Teselas con agua potable | — | 9,90 % | 4,83 % | 22,63 % | 8,40 % |

El error original que motivó el sprint («el entorno es literalmente recursos en todos lados») **ha vuelto**: el 98,1 % de las celdas de tierra del mundo público tienen comida > 0,3 y el 100 % tienen comida > 0,1. Coherente: `foodHarvested` acumulado en 18,7 días es **94,08** unidades para 11–35 personas; el entorno no aprieta. Lo único escaso es el agua (distancia 8,3 celdas), y es justamente la causa de muerte que extingue seed-4 en el laboratorio.

### 2.6 Honestidad: qué mide de verdad cada contador

| Contador / campo | Qué es realmente | Veredicto |
|---|---|---|
| `count(world,'cooperation')` (`society.ts:190`, `:249`) | **NO es automático**: exige `cooperationOpportunity` (puntuación con genes, confianza, apertura), distancia ≤ 1,5, y una transferencia real (material, trabajo, objeto o habilidad). | **Legítimo** como "hubo una interacción con efecto" |
| …pero su composición | 97 % es la rama `teach`, cuyo efecto material es `other.skills[k] += min(0,012, …)`. Las habilidades saturan en 1 y entonces la enseñanza cesa (la cooperación del mundo extinto se congela en 10 049 durante los últimos 5 700 ticks). | **Inflado**: mide roce, no organización |
| `conflicts` | 0 en 4 mundos y ~105 días simulados. `resourceDispute` exige sed/hambre ≥ 0,65 + mismo destino + confianza < 0,55. Nunca ocurre. | **Métrica vacía** |
| `recetasDistintasEnUso` (lab) | Es `technologyCatalogueTotals().recipes` = `recipeCounter`: recetas creadas **jamás**, monótono, nunca podado. En el mundo público son 4 435 frente a **170 realmente en uso**. | **Artefacto (nombre engañoso, ×26)** |
| `diversidadFuncional` | Nº de códigos `floor(capacidad×5)` en base 6 vistos **alguna vez** (6⁶ = 46 656 posibles). Monótono creciente por construcción; no puede detectar pérdida de diversidad. | **Artefacto de trinquete** |
| `technology_executions` | 87,4 % son `kind='water'` (contabilidad de transporte de agua). Las "214 468 ejecuciones de tecnología" de EVIDENCIA.md son 27 088 actos técnicos + 188 500 apuntes de agua. | **Inflado ×8** |
| "Supervivencia a 58 días" | 29 de esos días son dos agentes **inmortales por ley** (`protected`) y **estériles por ley** (`role !== 'neighbor'`). | **Artefacto: el mundo murió el día 29** |
| `generation` de receta | `1 + max(gen. de padres)`. Gen. 191 = 4,5 operaciones. | **No mide complejidad** |
| Muertes | 0 causas `desconocida` en los 4 mundos; `legacy` completo (40 filas = `deaths` 40). | **Legítimo, SC-005 se cumple** |

---

## 3. Las tres evidencias más fuertes y las tres más débiles

### Las 3 más fuertes de complejización / cooperación

1. **Sin gobernador ni tope, la población se reemplaza y crece con generaciones profundas.** Laboratorio T032: **9 de 10 réplicas** crecen de 16–22 fundadores a 72–284 habitantes en 12–30 días, con **6–11 generaciones vivas simultáneas** (seed-1: 284 con 360 nacimientos; seed-7: 115 con 11 generaciones). La única extinción (seed-4) es por sed, no por senescencia. Esto es reemplazo demográfico real, no supervivencia de fundadores, y lo confirma T051 en curso (49–168 habitantes a los días 14–23). Es la prueba más fuerte de que **la ley de vida sí funciona cuando se la deja correr**.
2. **El árbol técnico es genealógicamente profundo y funcionalmente variado, y eso no es un tope artificial.** 7 025 recetas con 191 generaciones de descendencia, 633 perfiles funcionales distintos, 41 inventores distintos, y la complejidad del programa crece de forma monótona y medible con la generación (2,13 → 4,48 pasos; monótono en los 8 tramos). El `research` puede fallar (24,4 % de fracasos), así que hay selección real en la invención.
3. **La cooperación es una decisión con coste y efecto, no un incremento gratuito.** `cooperate()` transfiere madera/piedra, trabajo (`other.work += 12`), objetos con masa, o habilidad; paga energía y fatiga al que ayuda; exige proximidad ≤ 1,5 y respeta un descanso de 30 ticks. La diferencia entre mundos lo demuestra: `constructionHelp` es 403 en el extinto y 232 en el público, `trade` 68 vs 62 — varía con la historia, no es constante.

### Las 3 más débiles o directamente refutadas

1. **REFUTADO: "la extinción del mundo público la causó el tope, no la ley de senescencia" (EVIDENCIA.md, extinción del día 58).** El mundo público de hoy corre **sin tope** (`poblacion.maxima = 1 000 000`) y está muriendo igual: 35 habitantes el día 4 → 20 el día 16 → **11** el día 18,7, con **0 nacimientos en 13,7 días simulados**. Al día 16,17 los **18** vecinos vivos tienen 12,2–18,2 días y su `senescenceStart` está en 8,1–10,7 días: **18 de 18 fuera de la ventana fértil**, con salud entre 0,02 y 0,46, y además 14 de 18 por debajo del mínimo de reserva (`fertile()` exige `inventory ≥ 0,1`). Cero parejas viables. Hechos que sostienen que el sustituto del tope es el **gobernador de R17**: (a) la instantánea del día 16,17 tiene `reproductionEnabled: false`; (b) EVIDENCIA.md documenta «gobernador `activo:false` (p95 > 50 ms)» en el quinto despliegue y «p95 49–52 → gobernador oscilando en el umbral» el 2026-09-21; (c) hoy el gobernador está `activo: true` con p95 = 31 ms — reencendió la reproducción **después** de que la cohorte entera cruzara la vejez. Como la ventana fértil (≈ 2 → 8–10 días) es más corta que el tiempo que tarda el p95 en bajar (el p95 solo baja cuando muere gente), el gobernador actúa como **trinquete**: apaga los nacimientos cuando el mundo está lleno y los reenciende cuando ya no queda nadie que pueda tenerlos. *Límite de esta inferencia*: no conservo la serie temporal de `reproductionEnabled` (solo la instantánea final), así que no puedo separar cuantitativamente el peso del gobernador del de la reserva de alimento; E1 (§4) está diseñado exactamente para eso. Lo que sí es un hecho cerrado es el resultado: **el mundo público no tiene ya ningún camino a un nacimiento**, y su estado terminal es 2 habitantes (S e I), idéntico al del mundo extinto.
2. **REFUTADO: "los agentes se complejizan y se transmiten cultura".** La fracción de fabricaciones con receta ajena cae del 60,7 % al 8–14 % en 17 días y al 0,0 % sostenido desde el día 30. El 70,9 % de las recetas no se usa nunca. Solo el 0,4–3,8 % del catálogo está vivo en cualquier momento. Y la métrica formal del propio proyecto (`organization`) devuelve `maximalRaf: []`, `constructibleFromFood: []`, `maintainedComponents: 0/8`, `catalystReplacementCoverage: 0`, `autopoiesisEstablished: false`: **no hay ni un solo lazo de producción que se mantenga a sí mismo**. Lo que hay es un archivo que crece, no una técnica que se sostiene.
3. **REFUTADO: SC-003 y SC-004 y la premisa de que las reglas nuevas mejoraron la diversidad.** SC-003 pide conducta ≥ 0,60 y **ninguna** instantánea lo alcanza; peor, el índice baja monótonamente con el día en las reglas nuevas (0,352 → 0,214 → 0,197 → 0,141) y el único 0,60 registrado (EVIDENCIA.md:449) es una medición puntual del día 1 de **otra** instancia, no comparable directamente. El mundo con **reglas viejas** marca 0,466 a los 21,9 días: **2,4 veces más diverso** que el de las reglas nuevas a los 18,7. 16 de 20 habitantes tienen el mismo oficio dominante (`cooperate`). SC-004 falla en dos de tres partes (Gini 0,128 frente a ≥ 0,35; regiones secas 21,1 % frente a ≥ 30 %) y el 98,1 % de las celdas de tierra tienen comida > 0,3: **la abundancia irreal que motivó todo el sprint está de vuelta**. Además, ninguna réplica del laboratorio ha medido nunca SC-003, porque `replica.ts` graba otra cosa (`diversidadOficios` en bits).

---

## 4. Qué falta medir y cómo (experimentos con control, constitución §II)

### E1 — El gobernador como trinquete demográfico *(prioridad máxima)*
**Hipótesis (H1)**: `decideReproduction` (app.ts:86) extingue el mundo porque la ventana fértil (≈ 6–8 días) es más corta que el tiempo de recuperación del p95.
**Diseño**: 8 semillas × 30 días × 3 brazos, réplicas de `scripts/lab` con un gobernador simulado inyectado (hoy el laboratorio NO tiene gobernador — por eso no lo detectó):
- **control**: sin gobernador (= T032 actual);
- **A**: gobernador con `presupuestoMs = 50` y el p95 medido **incluyendo** el guardado (el estado real hasta R19);
- **B**: gobernador con histéresis por *cohorte*: en vez de apagar los nacimientos, subir `intervaloComprobacionTicks` proporcionalmente al exceso de p95 (freno continuo, no interruptor).
**Métricas fijadas antes**: días con `reproductionEnabled=false`; edad mínima de la población al reencenderse; nº de individuos dentro de la ventana fértil en ese instante; población al día 30; extinciones/8.
**Criterio de refutación de H1**: si el brazo A no se extingue más que el control, H1 es falsa.

### E2 — ¿La cooperación es una meseta impuesta por el `lastSocial`?
**Hipótesis (H2)**: los 15–27 actos/habitante/día son un techo mecánico, no un óptimo social.
**Diseño**: 8 semillas × 15 días × `lastSocial` ∈ {15, 30 (control), 60, 120} ticks.
**Métricas**: actos/habitante/día, reparto teaching/trade/supply/assist, varianza de habilidades entre vivos, SC-003 al día 5 y 15.
**Predicción falsable**: si la cooperación escala ~1/cooldown, es un techo mecánico (H2 verdadera) y el número no significa "más sociedad".

### E3 — Transmisión cultural: ¿por qué muere?
**Hipótesis (H3)**: la fracción de uso de recetas ajenas cae porque `memoryCapacity = min(32, maxRecipes)` y cada agente inventa más rápido de lo que copia.
**Diseño**: 6 semillas × 20 días × `budgets.maxRecipes` ∈ {32, 256 (control), 1024} × tasa de invención ∈ {×1, ×0,25}.
**Métricas**: fracción `craft`/`use` con receta ajena por día; nº de recetas vivas (usadas en los últimos 2 400 ticks); `organization.maximalRaf` no vacío en alguna ventana; `catalystReplacementCoverage`.
**Criterio de éxito**: aparición de **al menos un RAF no vacío** sostenido ≥ 1 día. Hoy nunca ocurre; es el listón más honesto para «complejización».

### E4 — SC-003 en réplicas (instrumento que falta)
`scripts/lab/replica.ts:dailyMetrics` debe grabar `indiceDiversidad(world)` (los tres campos) además de `diversidadOficios`. Sin eso, SC-003 **no se ha medido nunca** fuera de una instantánea puntual. Coste: 3 líneas. Sin control necesario: es instrumentación, no cambio de regla.

### E5 — Reglas viejas vs nuevas, cara a cara en diversidad
Las reglas viejas dan 0,466 de conducta y las nuevas 0,197, pero son mundos de días distintos y no es una comparación válida.
**Diseño**: 12 semillas × 20 días, dos brazos (`10ac5c1` = reglas viejas vs `3e48fa5` = actuales), mismas semillas, `Store` temporal, SC-003 al día 5, 10, 15 y 20.
**Criterio**: si las viejas ganan en la mediana, la calibración de T010–T013 **empeoró** la diversidad y hay que revisarla (constitución §IV: la homogeneidad es un bug de diseño).

### E6 — Escasez de agua y muerte por sed
seed-4 se extingue por deshidratación (20 de 29 muertes) en T032 y en T051. Barrido `agua.cuencas` ∈ {0,4 (control), 0,6, 0,8} × 8 semillas × 30 días, midiendo `regionesSinAgua`, `distanciaMediaAgua`, muertes por sed y población al día 30. Decide la pendiente de T051.

### Lo que **no** se puede medir con lo que hay hoy
- **Serie diaria de `teaching`/`trade`/`conflicts`/`constructionHelp`**: el laboratorio solo graba `cooperaciones`, y el SQLite solo guarda los totales finales más una ventana de 96 muestras (~5 700 ticks). Reconstruí la serie de cooperación con los eventos de crónica, pero están podados a los últimos 24 000 ticks. **Arreglo**: grabar `world.totals` completo en `dia-NNN.json`.
- **Edad media de la población por día**: `demography.age` solo existe en la instantánea final. **Arreglo**: añadirlo a `dailyMetrics`.
- **Campos que NO existen** y que pedí buscar: no hay `age` ni `tick` en los registros de `legacy` (son `bornAt`/`diedAt` y el `tick` es columna de la tabla); no hay serie diaria de comunidades; no hay `kind='conflict'` en ninguna crónica examinada.

---

## 5. Anexo — scripts y consultas

Todos en `/tmp/atlas-analisis/`. Ninguno escribe en el repo ni en `data/`; las bases se abren `mode=ro&immutable=1` y el mundo vivo se leyó por HTTPS.

| Script | Qué hace | Cómo se ejecutó |
|---|---|---|
| `tech.py` | Series por día del archivo de tecnología: definiciones nuevas, generación máx./media, perfiles funcionales, ejecuciones por `kind`, éxito, recetas distintas usadas, actores distintos, **fracción de `craft`/`use` con receta ajena**, `research` con padres. | `python3 /tmp/atlas-analisis/tech.py <db>` |
| `snap.py` | Decodifica `snapshots` slot 0: totales, `demographyDynamics`, catálogo de tecnología, comunidades, personas vivas con genoma. | `python3 /tmp/atlas-analisis/snap.py <db>` |
| `pob.py` | Reconstruye **población diaria exacta** desde `bornAt` (vivos + `legacy`) y `diedAt`; cruza con eventos `cooperation`/`conflict` por día y detecta los textos de enseñanza y de turnos. | `python3 /tmp/atlas-analisis/pob.py <db>` |
| `ev.py` | Eventos de crónica por día y por `kind`. | `python3 /tmp/atlas-analisis/ev.py <db>` |
| `fert.py` | Evalúa la **puerta reproductiva completa** persona a persona (rol, comunidad, ventana de edad con `longevityAges`, descanso, reservas, cuerpo, lugar ≤ 4, pareja ≤ 3 con confianza mutua ≥ 0,3 y no parentesco) e informa del primer filtro que falla. | `python3 /tmp/atlas-analisis/fert.py <db>` |
| `div.py` | Reimplementación de control de `vectorConducta`/`indiceDiversidad` + varianza de alelos. | `python3 /tmp/atlas-analisis/div.py <db>...` |
| `sc003.ts` | **Verificación con el código real**: importa `decodeSnapshot` y `indiceDiversidad` de `src/` y los aplica a las cuatro instantáneas. Coincide con `div.py` dígito a dígito. | `cd /datos/workspaces/personal/AtlasParaIsa && npx tsx /tmp/atlas-analisis/sc003.ts` |
| `vivas.py` | Recetas jamás usadas, recetas «vivas» a 1/3/10 días, concentración de usos en el top 1 %. | `python3 /tmp/atlas-analisis/vivas.py <db>` |

**Instantáneas extraídas** (para `sc003.ts`): `/tmp/atlas-analisis/snap-{vivo,extinto,demo,viejo}.json`, con
`sqlite3 -readonly <db> "select body from snapshots where slot=0" > snap-<n>.json`.

**Copia del mundo público**: `gunzip -c ~/.local/state/atlas-para-isa/backups/world-20260921-1815-predeploy6.sqlite.gz > /tmp/atlas-analisis/vivo.sqlite` (día 16,17). El `data/world.sqlite` en vivo **no se tocó**.

**Estado vivo** (día 18,73, tick 44 962), leído por HTTPS con la cookie de sesión:
`curl -s -c /tmp/j -X POST -H 'Origin: https://atlas.humanizar.tech' -H 'Content-Type: application/json' -d '{"password":"…"}' https://atlas.humanizar.tech/api/login` → `curl -s -b /tmp/j https://atlas.humanizar.tech/api/world > /tmp/atlas-analisis/vivo.json`.

**Consultas SQL directas usadas**

```sql
-- esquema y volúmenes
SELECT count(*) FROM technology_definitions;      -- 7025 (extinto) / 4435 (vivo)
SELECT count(*), min(tick), max(tick) FROM technology_executions;
SELECT count(*), min(tick), max(tick) FROM events;  -- podados a `persistencia.ventanaEventosTicks`
SELECT count(*) FROM legacy;                       -- = demographyDynamics.deaths
-- muertes con edad
SELECT tick, body FROM legacy ORDER BY tick;       -- body: bornAt, diedAt, cause, generation, genome
-- estado final
SELECT body FROM snapshots WHERE slot = 0;         -- JSON con tiles en tuplas (snapshot.ts ENCODING)
```

**Ficheros de laboratorio leídos**: `artifacts/lab/t032-20260919-1636-30d/*/seed-*/dia-*.json` (10 réplicas, 12–30 días) y `artifacts/lab/t051-20260921-1812-30d/*/seed-*/dia-*.json` (9 réplicas parciales, barrido en curso al cierre de este informe).

**Referencias de código citadas**: `src/world/society.ts:120-260` (cooperación, comunidades, disputa), `src/world/statistics.ts:97` (`count`), `src/world/diversidad.ts` (SC-003), `src/world/technology-catalogue.ts:27-54,161` (`technologyFunctionCode`, totales), `src/world/demography.ts:33-155` (`longevityAges`, `eligible`, `protected`), `src/world/lineage.ts:134` (protección de S e I), `src/world/family.ts:11-48` (`closeKin`, `reproductiveReadiness`), `src/world/index.ts:946-1000` (`reproduce`), `src/server/app.ts:86,150-156` (gobernador R17), `scripts/lab/replica.ts:dailyMetrics` (métricas del laboratorio).

---

## 6. Resumen para decidir

Lo que se construyó es **sólido como instrumento** y **frágil como fenómeno**. El motor es determinista, el archivo es auditable, las muertes son legibles y el laboratorio existe y funciona. Pero lo que la simulación produce hoy no es una sociedad que se complejiza: es una **cohorte única que envejece en bloque** mientras dos agentes inmortales acumulan un archivo de recetas que casi nadie usa y nadie se transmite. Las dos palancas que más rendirían, por orden: **(1)** arreglar el trinquete del gobernador (E1) para que haya generaciones solapadas — sin eso, ninguna otra métrica puede mejorar con el tiempo, porque no hay tiempo; **(2)** poner el listón de la complejización en `organization.maximalRaf ≠ []` (E3) en vez de en contadores monótonos, que es el único número de este proyecto que no se puede inflar.
