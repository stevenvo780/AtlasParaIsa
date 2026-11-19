# Preregistro — Estabilidad tecnológica por leyes locales (Fase B, 2026-11-18)

Escrito y congelado **antes** de ejecutar cualquier experimento o cribado con las leyes candidatas, en cumplimiento del principio II de la [Constitución](../../.specify/memory/constitution.md) y del plan de remediación en [PLAN-ESTABILIDAD-2026-11-18.md](../PLAN-ESTABILIDAD-2026-11-18.md).

## 1. Diagnóstico que lo motiva

En el diagnóstico en solo lectura del mundo público **V13** (`tick 22.206.700`, día `9.252,79`, 641 habitantes vivos, `24,43 GiB` en `world.sqlite`), el **91,03 %** del tamaño de la base provino de dos tablas append-only ligadas al ritmo de creación de recetas tecnológicas:

- `technology_definitions`: **11.098.963 filas** (`16,17 GiB`, ~1.199 recetas/día simulado).
- `technology_stats`: **29.274.568 filas** (`6,07 GiB`, ~3.164 filas/día simulado).

Las causas mecánicas verificadas en [technology.ts](../../src/world/technology.ts) e [index.ts](../../src/world/index.ts) son locales y corregibles sin imponer ningún tope fijo de recetas ni de generaciones (respetando [GOAL.md](../../GOAL.md) y [REGLAS.md](../REGLAS.md)):

1. `localInputs()` expone masas desgastadas sin cuantizar (`residue` `150..1000`, `product` `200..1000`) directamente a `programSignature()`, generando centenares de firmas distintas para el mismo procedimiento según el desgaste exacto.
2. `finishProject()` registra permanentemente toda firma nueva que no se desintegre físicamente, aunque sea una mutación no-op o estrictamente dominada por sus padres, y [index.ts](../../src/world/index.ts) aplica refuerzo positivo (`+0,12`) incluso cuando no aporta ninguna mejora funcional.
3. `technologyOpportunity()` usa un enfriamiento muy corto (`45` ticks), bloquea `craft` útil cada 3 intentos (`attempts % 3 !== 0`) para forzar especulación y mantiene el peso completo de `research` cuando el inventario está lleno de buenas herramientas, disparando bucles continuos de reciclaje (`recycleToFit`).
4. `proposeTechnologyProgram()` genera con frecuencia pasos localmente no-op obvios (`cool` sin `heat` previo, `separate` sobre un único insumo `raw` sin `combine`, o repetición inmediata del mismo paso).

## 2. Hipótesis y mecanismos locales (B1–B4)

Todos los mecanismos se exponen bajo la nueva sección `tecnologia` de [params.ts](../../src/world/params.ts). Por principio II de la Constitución, tanto `HISTORICAL_PARAMS` como `DEFAULT_PARAMS` nacen con los **valores históricos** hasta evaluar el panel preregistrado completo:

| Parámetro | Histórico (default actual) | Rango / tipo | Candidato tratamiento |
|---|---:|---|---:|
| `tecnologia.dosisCuanto` | `0` | entero `[0, 1000]` | `250` |
| `tecnologia.mejoraLocal` | `0` | real `[0, 1]` | `0.05` |
| `tecnologia.enfriamiento` | `45` | entero `[1, 2400]` | `300` |
| `tecnologia.evitarNoOp` | `false` | booleano | `true` |

No se introduce ningún límite fijo al catálogo ni a la profundidad de generaciones, ni azar no determinista, ni ruptura de conservación entera exacta de masa (`massError === 0`). Se preserva íntegro el **redescubrimiento pagado** de firmas ya existentes en el archivo.

1. **B1 — Cuantización entera de dosis en `localInputs()`** (`tecnologia.dosisCuanto`):
   - Cuando `dosisCuanto === 0`, se conserva la fórmula histórica bit a bit.
   - Cuando `dosisCuanto > 0`:
     - Para `residue`: si `actor.technology.residue[material] >= Math.max(150, dosisCuanto)`, propone `Math.min(1000, Math.floor(actor.technology.residue[material] / dosisCuanto) * dosisCuanto)`.
     - Para `product`: si `item.mass >= Math.max(200, dosisCuanto)`, propone `Math.min(1000, Math.floor(item.mass / dosisCuanto) * dosisCuanto)`.
2. **B2 — Puerta local de novedad o mejora en `finishProject()` + refuerzo honesto** (`tecnologia.mejoraLocal`):
   - Si `findTechnologyRecipe(host, signature)` encuentra una receta ya archivada, el **redescubrimiento pagado** permanece idéntico al actual (conserva `id`, `inventorId`, `tick`, `parents` y `generation`, fabrica el producto y cuenta como éxito).
   - Si la firma es **nueva** y `mejoraLocal > 0`, se calculan `capacities = materialCapacities(output)`, `newFunction = !hasTechnologyFunction(host, capacities)` y `maxCap = Math.max(...CAPABILITIES.map(c => capacities[c]))`:
     - Generación 1 (`parentRecipes.length === 0`): se acepta solo si `newFunction || maxCap >= 0.12`.
     - Generación ≥ 2 (`parentRecipes.length > 0`): con `parentBest[c] = max_p p.capacities[c]` y `minParentWork = min_p technologyWorkCost(p.program)`, se acepta solo si:
       1. `newFunction`, o
       2. existe capacidad `c` tal que `capacities[c] >= Math.max(0.12, parentBest[c] * (1 + mejoraLocal))`, o
       3. domina en Pareto por coste de trabajo (`maxCap >= 0.12`, toda capacidad `c` cumple `capacities[c] >= parentBest[c] - 1e-9` y `technologyWorkCost(project.program) < minParentWork`).
   - Si una firma nueva no supera la puerta local: **no** registra `TechnologyRecipe`, devuelve `output.composition` a `knowledge.residue` (conservación exacta entera), la añade a `residue`, marca `success = false`, registra la ejecución honestamente en el diario (`recipeId: null, success: false`) y `researchTechnology()` devuelve `false`, de modo que [index.ts](../../src/world/index.ts) aplica refuerzo negativo (`-0,12`).
3. **B3 — Enfriamiento y oportunidad realistas en `technologyOpportunity()`** (`tecnologia.enfriamiento` y `tecnologia.mejoraLocal`):
   - Sustituye el literal `45` por `tecnologia.enfriamiento`.
   - Cuando `mejoraLocal > 0 || enfriamiento > 45`:
     - No se salta `craft` útil por la condición `actor.technology.attempts % 3 !== 0`.
     - Cuando el inventario está lleno (`actor.technology.items.length >= host.technology.budgets.maxItems`) y el actor ya posee herramientas útiles (`Math.max(...Object.values(powers)) >= 0.4`), se atenúa la puntuación de `research` por `× 0.35`.
4. **B4 — Evitar mutaciones no-op obvias en `proposeTechnologyProgram()`** (`tecnologia.evitarNoOp`):
   - Cuando `evitarNoOp === true`, al generar o mutar una instrucción se reintenta (con el mismo `localRandom` determinista y un máximo acotado de 4 reintentos) si el paso propuesto es un no-op local obvio:
     - `cool` sin ningún `heat` previo en `steps`;
     - `separate` con un único insumo `raw` y sin ningún `combine` previo;
     - duplicado exacto del paso inmediatamente anterior en `(op, shape, material)`.
   - Cuando `evitarNoOp === false`, no altera ninguna llamada al PRNG.

### Hipótesis central

**H-B**: la combinación local B1+B2+B3+B4 reduce drásticamente el crecimiento ilimitado de recetas redundantes y el tamaño de `world.sqlite`, a la vez que mantiene viva la evolución tecnológica abierta (diversidad funcional, profundidad genealógica y transmisión cultural `C7`) y la salud demográfica/conductual (`C1`–`C7`), preservando identidad bit a bit cuando los parámetros están en sus valores históricos.

## 3. Panel fijo preregistrado

- **Semillas**: 8 semillas nuevas **`9601, 9602, 9603, 9604, 9605, 9606, 9607, 9608`** (serie `96xx` no usada en campañas previas).
- **Duración**: **60 días simulados** (`144.000` ticks, `TICKS_PER_DAY = 2400`).
- **Infraestructura de simulación**: `Store` SQLite adjunto desde el tick 0 (`enableTechnologyCatalogue` activo, como en producción y en [replica.ts](../../scripts/lab/replica.ts)), con límites de admisión derivados del anfitrión y sin techo artificial de laboratorio.
- **Parámetros comunes (régimen V13)**:
  `persistencia.cadaTicks=100,persistencia.ventanaEventosTicks=24000,social.radioConvivencia=12,social.disolucion=1,social.maxComunidades=64`
- **Brazo CONTROL**: parámetros comunes + valores históricos de tecnología (`tecnologia.dosisCuanto=0,tecnologia.mejoraLocal=0,tecnologia.enfriamiento=45,tecnologia.evitarNoOp=false`).
- **Brazo TRATAMIENTO**: parámetros comunes + paquete candidato (`tecnologia.dosisCuanto=250,tecnologia.mejoraLocal=0.05,tecnologia.enfriamiento=300,tecnologia.evitarNoOp=true`).
- **Verificación de humo previa (no decide adopción)**: un cribado rápido de 2 semillas (`9601, 9602`) × 5 días (`12.000` ticks) en ambos brazos comprueba que los mecanismos, la persistencia y las métricas operan sin errores; los valores de parámetros y umbrales Q1–Q5 quedan congelados aquí y **no** se ajustan a partir del cribado ni del panel.

## 4. Criterios de paso y refutación (Q1–Q5)

Todas las métricas se evalúan pareadas por semilla (TRATAMIENTO frente a CONTROL en las semillas `9601..9608` al día 60), usando los mismos instrumentos diarios de [replica.ts](../../scripts/lab/replica.ts) y el evaluador [criterio-terminado.mts](../../scripts/lab/criterio-terminado.mts):

- **Q1 (freno al spam)**:
  1. La mediana (sobre las 8 semillas) de `recetasCreadasAcumuladas` al día 60 se reduce en **≥ 85 %** (`tratamiento / control ≤ 0,15`, es decir ≥ 6,7× menos) respecto al control, y esa reducción ≥ 85 % se cumple individualmente en **≥ 7/8 semillas**.
  2. La tasa de creación de recetas en los días 41–60 (`recetas(60) − recetas(40)`) es **estrictamente menor** que en los días 1–20 (`recetas(20) − recetas(0)`) en mediana y en **≥ 7/8 semillas** (indica desaceleración orgánica conforme se explora el frente local, sin tope rígido).
- **Q2 (tamaño en disco)**:
  - El tamaño final en bytes de `world.sqlite` al día 60 (tras guardado y cierre limpio de `Store`, incluyendo cualquier residuo WAL) se reduce en **≥ 50 %** respecto al control (en mediana sobre las 8 semillas y en ≥ 7/8 semillas). Combinado con Fase A (compactación de `technology_stats` y vaciado incremental), la reducción esperada es aún mayor.
- **Q3 (tecnología abierta viva)**:
  - En **≥ 7/8 semillas**:
    - `diversidadFuncional` al día 60 ≥ **50 %** del control (y > 0; la diversidad funcional no colapsa).
    - `generacionMaxima` (`technologyCatalogueTotals(world).maxGeneration`) ≥ **3** (continúa componiendo productos sobre productos).
    - Transmisión tecnológica (`C7` en [criterio-terminado.mts](../../scripts/lab/criterio-terminado.mts)) mantenida: el tratamiento cumple `C7` en al menos tantas semillas como el control (tolerancia de 0 semillas por debajo si control cumple en ≤ 7, o ≥ 7/8 si control cumple en 8/8).
- **Q4 (seguridad demográfica)**:
  - `C1`–`C7` en tratamiento igual o mejor que en control (sin regresión agregada ni por criterio).
  - **0 extinciones adicionales** en tratamiento respecto al control.
  - Población al día 60 ≥ **0,80×** control (en mediana pareada y en ≥ 7/8 semillas no extinguidas en control).
  - Natalidad acumulada al día 60 ≥ **0,85×** control (en mediana pareada).
- **Q5 (compatibilidad histórica)**:
  - `digestoCanonico` idéntico bit a bit en **3 semillas (`7, 42, 51926`) × `1.200` ticks** con los valores históricos (`dosisCuanto=0, mejoraLocal=0, enfriamiento=45, evitarNoOp=false`) frente al comportamiento base de `main` (normalizando únicamente la forma del objeto `params` al declarar la nueva sección `tecnologia`, dado que `digestoCanonico` hashea `{ world, params }`).

## 5. Regla de decisión y congelación

Precedencia estricta, sin categoría «inconcluso»:

1. Si falla **Q5** → **BLOQUEADO POR REGRESIÓN** (corregir paridad histórica antes de evaluar ciencia).
2. Si falla **Q4** → **REFUTADA POR SEGURIDAD** (no se adopta).
3. Si pasan **Q1, Q2, Q3, Q4 y Q5** simultáneamente → **APROBADA PARA ADOPCIÓN** (promoción de los valores candidatos a `DEFAULT_PARAMS`, incremento de `RULES_VERSION` a `12`, registro completo en [EVIDENCIA.md](../EVIDENCIA.md) con SHA, semillas y límites).
4. En cualquier otro caso → **REFUTADA / NO ADOPTADA**; cualquier cambio de valores o de leyes requerirá un preregistro nuevo con semillas nuevas.

## 6. Riesgos declarados y alcance

- **Riesgo de sobre-frenado**: una puerta `mejoraLocal=0.05` junto con `enfriamiento=300` podría reducir demasiado las oportunidades tempranas de invención o enseñanza (`C7`). Lo vigila directamente **Q3** (`diversidadFuncional`, `generacionMaxima` y `C7`).
- **Riesgo de desacople demográfico**: si los habitantes investigan menos y producen menos herramientas útiles de corte/abrasión/almacenamiento, podría caer la recolección o el transporte de agua. Lo vigila directamente **Q4** (`C1`–`C7`, población y natalidad).
- **Alcance**: los resultados valen para el régimen V13 con `Store` SQLite adjunto a 60 días (`9601..9608`) y miden el efecto aislado de la Fase B sobre el motor actual; el efecto combinado con la Fase A (compactación de `technology_stats` y `auto_vacuum`) se mide por separado tras la integración de ambas fases.
