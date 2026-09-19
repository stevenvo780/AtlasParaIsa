# Research: Mundo sólido y laboratorio masivo

## Estado medido de partida (2026-09-19, torre kratos)
- Código: `src/world` 28 ficheros (índice 1.196 líneas), `src/client` 20 (landscape 2.032), `src/server` 8, `src/shared` 7; 58 ficheros de test (`tsx --test`), Playwright e2e. Deps de runtime: solo `ws`; SQLite vía `node:sqlite`.
- Bucle: `setInterval(stepOnce, tickMs ?? 100)` en `src/server/app.ts:265`; `TICKS_PER_DAY = 2400`.
- Harness existentes: `scripts/soak.ts` (SOAK_DAYS 3..60, un mundo, digests de fuente), `scripts/survival-matrix.py` + `survival-audit.mts` (matriz con `concurrent.futures`, exige SHA exacto), `scripts/compute-ecology-*` (CPU vs workers vs CUDA; medido: 1 M celdas 412 ms Node vs 1.137 ms GPU incluyendo transferencias → la GPU NO compensa para la simulación hoy).
- Hardware: Ryzen 9 9950X3D (32 hilos), 125 GiB, RTX 5070 Ti 16 GiB + RTX 2060 6 GiB.
- Evidencia previa: colapsos del mundo observado, afinación posterior, recambio hasta octava generación en réplicas largas; matriz V6 cerrada a 25 días. Queja actual: mortalidad temprana, homogeneidad, recursos omnipresentes.

## Decisiones
1. **Laboratorio = procesos, no worker_threads.** Cada réplica es un `child_process` de `tsx scripts/lab/replica.ts` con `CARTA_DATA_DIR` temporal: aislamiento de memoria y de fallos, y reutiliza `createWorld/stepWorld/worldStatistics` como `soak.ts`. Concurrencia = `os.availableParallelism() - 2`. Alternativa rechazada: worker_threads (una excepción tira el proceso padre; RSS compartido difícil de medir).
2. **Parámetros con nombre** en `src/world/params.ts`: objeto tipado `WorldParams` con defaults y `parseParams(env|json)`; `createWorld(seed, params?)`. Alternativa rechazada: variables de entorno sueltas (no documentables, no versionables).
3. **Índice de diversidad de conducta**: para cada habitante, vector normalizado de (fracción de tiempo por actividad ×k, tipos de alimento consumidos, regiones visitadas, procedimientos practicados, oficio dominante). Diversidad = distancia coseno media entre todos los pares. Complemento: entropía de oficios dominantes. Se calcula en `worldStatistics` (servidor) y en el laboratorio.
4. **Escasez**: densidad de recursos por bioma con ruido espacial (ya hay regiones deterministas), agotamiento por extracción y regeneración logística; agua superficial sólo en cuencas. Métrica: Gini de recursos por región + % regiones sin agua + distancia media a agua.
5. **Causas de muerte**: enumeración cerrada `CausaMuerte` en `src/shared/types.ts`; toda transición a muerto pasa por `registrarMuerte(cuerpo, causa, contexto)` que escribe crónica con los 3 eventos previos del habitante. Invariante probado: ninguna muerte sin causa.
6. **Modo observador**: decisión en `src/client/game.ts` por `matchMedia`, `navigator.deviceMemory`, disponibilidad de WebGL2 y ancho; ruta `/?modo=observador|completo` fuerza. El observador reutiliza el `state` que ya llega por WebSocket pero pide `intervalo` de 5 s (mensaje `suscripcion` opcional en `app.ts`) y no instancia el compositor.
7. **Refactor por fases** sólo después de fijar métricas y control de determinismo (US1+US2 primero). Partir `world/index.ts` en `world/{percepcion,decision,accion,materia,registro,paso}.ts` y `client/landscape.ts` en `client/paisaje/{terreno,agua,vegetacion,habitantes,luz,calor}.ts`.

## Cómo aprovechar la torre en 4 horas
- Barridos del laboratorio en segundo plano (28 procesos) mientras los subagentes escriben código; cada fase termina con un barrido de control.
- Tareas `[P]` del `tasks.md` se reparten entre subagentes (ficheros disjuntos). Una integración por fase.
- GPU: sólo render y el benchmark existente si sobra tiempo; no bloquear el objetivo con CUDA.

## Riesgos
- Cambiar reglas y refactorizar a la vez rompe el determinismo sin saber por qué → orden estricto: instrumento → reglas → visual → refactor.
- Sobreajustar a 10 días: correr al menos un barrido de 25 días al final (existe precedente V6).
- El servidor público comparte `data/`: el laboratorio usa siempre directorios temporales.

## Medido 2026-09-19 (revisión integral; fuente: `docs/REVISION-2026-09-19.md`)
Todo con ejecución real sobre `aeada2e` en la torre.
- **Mortalidad**: `maximumAge = round((11 + resilience·4 − activity)·2400)` → 10,45–14,70 días (42–59 min reales); corte incondicional en `demography.ts:82`. Semilla 12345 hasta día 7,4: **0 muertes**, población 16→32 (tope) → los nacimientos paran → la ola de senescencia extingue el mundo ~día 15. Hambre/sed/frío bien gestionados por la IA (usa rasgos y memorias propias, no tablas globales).
- **Genética**: 16 fundadores homocigotos en los 7 loci; `learningRate` = 0,12 en todos (alelos 0,5/0,5 = codificación exacta del default). Sin variación de partida no hay selección posible.
- **Tecnología**: `technologyOpportunity` decide `recipeId`; `craftTechnology` lo ignora y fabrica la de mayor `benefit` (reproducido con el motor). Con Store `memoryCapacity=32`; sin Store `maxRecipes=256`, `maxGeneration=32` → **el laboratorio debe adjuntar Store**.
- **Entorno**: a t=1251, 1120/1120 celdas con comida, 100 % vegetación > 0,3, 36 celdas (3 %) con agua potable. `ecology()` crece cada 10 ticks hacia saturación sin K por bioma; fertilidad sin decaimiento → 1,0. Generación inicial sí desigual (madera 4,6 % global, distancia media 17 celdas). Hipótesis «doble regeneración» refutada (kernel +0,05).
- **Servidor**: 32 hab. dispersos (28.672 tiles activas): paso p50 78,4 / p95 131,9 ms (clon 16,5, guardado 48,7). Soak archivado (18 hab.): p95 64,9 ms, picos 639 ms. SQLite crece ~7 KB/tick (6,8 MB @t500 → 32,6 MB @t4000) sin poda; `data/world.sqlite` público = 347 MB + 9,7 GB en `experiments/`.
- **Red**: `state` = 469.337 B a t=12000 con cámara 12×8; 186 KiB son 256 recetas con programa; 2 envíos/s.
- **Cliente**: `dpr = clamp(devicePixelRatio,1,3)`; en móvil dpr 3 → canvas 1206×2622 por rAF. Higiene de recursos correcta (rAF, listeners, contextlost, backoff).
- **Determinismo**: sano (sin `Math.random`/`Date.now` en `src/world`; misma semilla → idéntico tras 400 pasos; snapshot roundtrip bit a bit).
- **Tests**: 53/56 ok en < 6 s; `world.test.ts` 115 s; 2 cuelgan por `listen()` fuera del `try` + Chromium 1243 ausente (instalado 2026-09-19).

## Decisiones (rev. 2)
8. **Muerte como riesgo, no decreto**: hazard Gompertz determinista desde `senescenceStart`, reducido por salud·vitalidad y resiliencia; la salud se desgasta en la vejez para que la muerte sea legible. Alternativa rechazada: subir `maximumAge` (solo retrasa la ola; no produce recambio ni diversidad de causas).
9. **Reemplazo continuo**: tope paramétrico, varios nacimientos por comprobación si hay hueco, pareja por afinidad determinista. Alternativa rechazada: quitar el tope (rompe el presupuesto V).
10. **Capacidad de carga por bioma** y decaimiento de fertilidad, ambos paramétricos con default = hoy (control bit a bit) y calibrados por barrido (Gini ≥ 0,35; 30–70 % celdas con comida).
11. **Params en `WeakMap`** por mundo (patrón ya usado en `spatial.ts`, `technology-catalogue.ts`): sin campo nuevo en `World`, sin migración.
12. **`state` acotado**: recetas como resumen + detalle bajo demanda; ventana de eventos/memorias. Objetivo < 120 KiB.
13. **Guardado por cadencia** (20 ticks o al haber gestos) + poda por ventana + `synchronous=NORMAL`.
14. **US5 pospuesta** (ver plan.md, Complexity Tracking).

## Modelo de senescencia y reemplazo: expectativas analíticas y rejilla de calibración (2026-09-19)

*Trabajo analítico previo a T010/T012/T031. Todas las cifras salen de un modelo numérico propio
(`p_tick = 1 − e^{−h·dt/2400}`, integración de S(edad) y simulación de población con la cadencia real
de `reproduce`), **no del motor**. El script no vive en el repo: es reproducible desde las fórmulas de
esta sección. Cuando el motor hace algo distinto de lo que el enunciado de T010 supone, se dice.*

### 0. Lo que el motor hace HOY (leído, no supuesto) — seis hechos que condicionan el barrido

1. **`dt` siempre vale 1 tick.** `advancePopulation` (`src/world/lineage.ts:124`) llama
   `updateDemography(..., 1)` una vez por persona y tick. La conversión correcta es
   `p_tick = 1 − exp(−h·dt/2400)`; con `h = 0,02/día` da `p_tick = 8,33·10⁻⁶` y `1 − (1−p)²⁴⁰⁰ = 0,0198/día`.
2. **`updateDemography` NO se llama una vez por tick, sino ≥ 10.** Además del paso real hay 7 sitios de
   previsión en `src/world/index.ts` (`bodilyDamage`, L228; llamado en L298, 301, 328, 349, 425, 483 —dentro
   de un bucle—, 491) y uno en `src/world/family.ts:14` (`reproductiveReadiness`, con `dt = 0`).
   **Trampa para T010**: la tirada de senescencia debe ser función pura de `(personId, tick)` vía
   `localRandom`. Cualquier estado incremental (contador, PRNG del mundo) se consumiría ~10 veces por
   persona y tick y multiplicaría la mortalidad por ~10 sin que ningún test lo note. La rama `dt === 0`
   (L63) devuelve antes; **la tirada debe ir después de esa guarda**.
3. **S e I son inmortales.** `advancePopulation` pasa `protected: person.role === 'S' || person.role === 'I'`;
   `updateDemography` L87-90 convierte cualquier muerte en `preventedDeath` y aplica suelos
   (`health ≥ 0,05`, `vitality ≥ 0,08`). De los 16 fundadores **solo 14 pueden morir**, y esos 2
   tampoco se reproducen (`reproductiveReadiness` exige `role === 'neighbor'`, `family.ts:11`).
   Consecuencia para SC-002: 2/16 = 12,5 % de supervivencia está regalada; el umbral del 70 % sobre 16
   equivale al 65,7 % sobre los 14 mortales.
4. **Los fundadores NO son «alelos 0,5».** `founderGenome` (`genetics.ts:12-16`) codifica el fenotipo:
   locus 4 (alelos 8-9) = `traits.resilience`, locus 2 (alelos 4-5) = `traits.industriousness` —que
   `demography.ts:22` llama `activity`—, ambos sorteados por `seededTraits` (`index.ts:182`) en
   `0,1 + U·0,85`. Por tanto `maximumAge = 11 + 4R − I` días se distribuye con **media 12,58 d,
   σ = 1,01 d, rango 10,45–14,70 d** (coincide con la revisión). Lo homocigoto es el locus 5 (0,5 fijo)
   y `learningRate = 0,12` constante.
5. **La fertilidad termina en `senescenceStart`, no en `maximumAge`.** `eligible()` (`demography.ts:44`)
   exige `age < traits.senescenceStart`. La ventana fértil es `[maturityAge, 0,75·maximumAge)` ≈
   `[2,0 d, 9,4 d)` para un cuerpo medio. **Alargar la vida NO alarga la fertilidad**: todo el tiempo
   que el hazard regale por encima de `senescenceStart` son ancianos post-fértiles ocupando cupo.
   Este es el hecho que domina toda la dinámica de población, más que el propio hazard.
6. **Ya existe un segundo corte implícito: el desgaste de salud.** `senescenceDamage` (`demography.ts:49-53`)
   acumula, entre `S` y `maximumAge`, un daño total de `0,8·(A−S)/3 = A/15` puntos de salud
   (0,833 para A = 12,5 d), mientras la curación sólo aporta `γ·(A−S)/2 ≈ 0,072`
   (γ = nourishment·energy·vitality·0,08 ≈ 0,046/día con hambre 0,20 / sed 0,15 / energía 0,78).
   Resultado medido: **un cuerpo bien alimentado llega a `maximumAge` con salud 0,36 (A = 10,45),
   0,24 (A = 12,5) o 0,10 (A = 14,70)**. Si `health ≤ 0` la muerte se dispara igual y la causa
   ordenada por daño máximo sale `senescence`: el corte por decreto vuelve disfrazado.

| edad | A = 10,45 | A = 12,5 | A = 14,70 |
|---|---|---|---|
| `senescenceStart` | 1,00 | 1,00 | 1,00 |
| 0,90·A | 0,90 | 0,88 | 0,86 |
| 0,97·A | 0,59 | 0,51 | 0,43 |
| `maximumAge` | **0,36** | **0,24** | **0,10** |

### 1. Hazard formalizado (contrato para T010)

Para `edad ≥ senescenceStart = senescenciaInicioFraccion · maximumAge`:

```
h(edad)  [por día]  =  riesgoSenescenciaDiario
                     · exp( riesgoSenescenciaPendiente · (edad − maximumAge) / maximumAge )
                     · ( 1 − cuidadoReduceRiesgo · health · vitality )
                     · φ(resilience)

φ(resilience) = 1 − 0,5·(resilience − 0,5)          // 1,00 en 0,5; [0,775 , 1,200] en el rango real

p_tick = 1 − exp( − h · dt / 2400 )                  // dt en ticks; con dt = 1 → 1 − exp(−h/2400)
```

Notas de diseño, con cifras:

- **`h` está anclado en `maximumAge`**, no en `senescenceStart`: `h(maximumAge) = riesgoSenescenciaDiario`
  y `h(senescenceStart) = riesgoSenescenciaDiario · e^{−0,25·pendiente}` (0,47· con pendiente 3,
  0,22· con 6, 0,082· con 10). La pendiente gobierna **cuánto se concentra la mortalidad al final**,
  no el nivel.
- **φ es cosmético y está bien que lo sea.** Medido sobre A = 12,5 d, c = 0,6: pasar de
  `resilience = 0,95` (φ = 0,775) a `resilience = 0,10` (φ = 1,20) mueve la mediana de vida
  **1,76 d con pendiente 3, 0,90 d con 6 y 0,54 d con 10**. La dispersión de `maximumAge`
  (10,45–14,70 d) es 2–4× mayor. Si se quiere que la resiliencia «pese más» hay que tocar
  `longevidadPorResiliencia`, no φ: **φ más agresivo dobla el efecto del mismo gen** (ya suma
  +4 días de `maximumAge` por unidad) y sesga la selección sin ganar legibilidad.
- **`vitality` es ≈ 1 en un cuerpo alimentado**: con los valores de arriba, `recovery ≈ 0,214/día`
  frente a `strain ≈ 0,002/día` → satura en 1 en pocas horas. El factor de cuidado es, en la práctica,
  `1 − c·health`, y por el punto 0.6 `health` ya está erosionada justo cuando importa (§5).
- **Usar `paramsOf`**: `demography.ts:23` y `:28` tienen `11 + resilience*4 - activity` y `*0.75`
  cableados. T010 debe leerlos de `cuerpo.longevidad*` y `cuerpo.senescenciaInicioFraccion`.

### 2. Supervivencia y esperanza de vida

`S(edad) = exp(−∫₀^edad h)`, integrado en pasos de 120 ticks (exacto a trozos, el hazard es constante
dentro del paso). Mediana = edad con `S = 0,5`; media = `∫S`. Tres regímenes:
**sano** (`health·vitality = 1` constante, cota superior idealizada, **inalcanzable** en el motor por 0.6),
**descuidado** (`h·v = 0,3` constante) y **real** (`vitality = 1`, `health` según la trayectoria medida del
motor). Se asume que hambre y sed no matan (la revisión midió 0 muertes por esas causas hasta el día 7,4).

**Tabla 1 · Mediana de vida (días), `maximumAge = 12,5 d` (alelos medios), φ = 1** — `sano / descuidado / real`

| `riesgoDiario` | pend. | c = 0,4 | c = 0,6 | c = 0,8 |
|---|---|---|---|---|
| 0,005 | 3 | 29,3 / 27,7 / 27,6 | 30,9 / 28,0 / 27,8 | 33,8 / 28,3 / 28,1 |
| 0,005 | 6 | 22,3 / 21,5 / 21,5 | 23,2 / 21,7 / 21,6 | 24,6 / 21,8 / 21,7 |
| 0,005 | 10 | 19,0 / 18,5 / 18,5 | 19,5 / 18,6 / 18,6 | 20,4 / 18,7 / 18,7 |
| 0,01 | 3 | 26,4 / 24,9 / 24,8 | 28,1 / 25,1 / 25,0 | 30,9 / 25,4 / 25,2 |
| 0,01 | 6 | 20,9 / 20,1 / 20,0 | 21,7 / 20,2 / 20,1 | 23,2 / 20,4 / 20,3 |
| 0,01 | 10 | 18,2 / 17,7 / 17,7 | 18,7 / 17,8 / 17,7 | 19,5 / 17,9 / 17,8 |
| **0,02** | **6** *(defaults)* | 19,4 / 18,6 / 18,6 | **20,3 / 18,8 / 18,7** | 21,7 / 19,0 / 18,9 |
| 0,02 | 3 | 23,6 / 22,1 / 22,0 | 25,2 / 22,3 / 22,3 | 28,1 / 22,6 / 22,5 |
| 0,02 | 10 | 17,3 / 16,8 / 16,8 | 17,8 / 16,9 / 16,9 | 18,7 / 17,0 / 16,9 |
| 0,04 | 3 | 20,8 / 19,4 / 19,4 | 22,4 / 19,6 / 19,6 | 25,2 / 19,9 / 19,9 |
| 0,04 | 6 | 18,0 / 17,2 / 17,2 | 18,8 / 17,4 / 17,3 | 20,3 / 17,5 / 17,5 |
| 0,04 | 10 | 16,4 / 16,0 / 15,9 | 16,9 / 16,0 / 16,0 | 17,8 / 16,1 / 16,1 |
| 0,08 | 3 | 18,2 / 16,8 / 16,9 | 19,7 / 17,1 / 17,2 | 22,4 / 17,4 / 17,5 |
| 0,08 | 6 | 16,6 / 15,8 / 15,9 | 17,4 / 16,0 / 16,0 | 18,8 / 16,1 / 16,1 |
| 0,08 | 10 | 15,6 / 15,1 / 15,1 | 16,1 / 15,2 / 15,2 | 16,9 / 15,3 / 15,3 |

**Media (esperanza de vida), c = 0,6, A = 12,5 d** — `sano / descuidado / real`:
r0 = 0,005 → 30,1/27,2/27,1 (p3) · 22,7/21,2/21,2 (p6) · 19,3/18,4/18,3 (p10);
r0 = 0,01 → 27,3/24,5/24,4 · 21,3/19,8/19,8 · 18,4/17,5/17,5;
r0 = 0,02 → 24,6/21,8/21,8 · **19,9/18,4/18,4** · 17,5/16,7/16,6;
r0 = 0,04 → 21,9/19,3/19,4 · 18,5/17,0/17,1 · 16,7/15,8/15,8;
r0 = 0,08 → 19,4/16,9/17,2 · 17,1/15,7/15,8 · 15,8/15,0/15,0.

**Tabla 2 · Extremos reales de `maximumAge`** (mediana, c = 0,6, `sano / descuidado / real`)

| r0 | pend. | A = 10,45 d | A = 14,70 d |
|---|---|---|---|
| 0,005 | 3 | 26,5 / 24,0 / 24,2 | 35,6 / 32,1 / 31,5 |
| 0,005 | 6 | 19,7 / 18,4 / 18,5 | 26,8 / 25,1 / 24,8 |
| 0,005 | 10 | 16,5 / 15,8 / 15,8 | 22,7 / 21,7 / 21,5 |
| 0,01 | 6 | 18,5 / 17,2 / 17,3 | 25,1 / 23,4 / 23,1 |
| 0,02 | 6 | 17,3 / 16,0 / 16,1 | 23,5 / 21,7 / 21,4 |
| 0,02 | 10 | 15,1 / 14,3 / 14,4 | 20,7 / 19,6 / 19,5 |
| 0,04 | 6 | 16,1 / 14,8 / 14,9 | 21,8 / 20,0 / 19,8 |
| 0,04 | 10 | 14,3 / 13,6 / 13,7 | 19,7 / 18,6 / 18,5 |
| 0,08 | 6 | 14,9 / 13,7 / 13,8 | 20,1 / 18,4 / 18,3 |
| 0,08 | 10 | 13,6 / 12,9 / 13,0 | 18,7 / 17,6 / 17,5 |

**Tres lecturas incómodas pero firmes:**

- **Toda la rejilla alarga la vida.** La esquina más severa (r0 = 0,08, pend. 10, c = 0,4, A = 10,45)
  da mediana **12,9 d frente a los 10,45 d del corte duro actual**. No existe combinación de la rejilla
  propuesta que mate antes que hoy. El hazard no es un problema de mortalidad, es un problema de
  **exceso de ancianos**.
- **`cuidadoReduceRiesgo` es casi inerte en el motor real.** Compárense las columnas «descuidado» y
  «real»: difieren < 0,4 d en toda la tabla, porque a la edad en que el hazard muerde la salud ya
  cayó a 0,10–0,36 (punto 0.6). La columna «sano» es una ficción: exigiría `health = 1` a la edad
  `maximumAge`, imposible con el `senescenceDamage` vigente. Con c = 0,8 el motor entrega el
  comportamiento de c ≈ 0,05.
- **Supervivencia de fundadores (métrica de SC-002), modo real, φ activo, integrando sobre la
  distribución real de A.** A día 10 los fundadores tienen 12 días de edad; a día 25, 27 días.

| r0 | pend. | S(día 10), c=0,6 | S(día 25), c=0,6 |
|---|---|---|---|
| 0,005 | 3 / 6 / 10 | 0,995 / 0,996 / 0,997 | 0,555 / 0,024 / 0,000 |
| 0,01 | 3 / 6 / 10 | 0,990 / 0,992 / 0,994 | 0,336 / 0,003 / 0,000 |
| 0,02 | 3 / 6 / 10 | 0,981 / 0,985 / 0,987 | 0,144 / 0,000 / 0,000 |
| 0,04 | 3 / 6 / 10 | 0,963 / 0,970 / 0,975 | 0,036 / 0,000 / 0,000 |
| 0,08 | 3 / 6 / 10 | 0,927 / 0,941 / 0,951 | 0,003 / 0,000 / 0,000 |
| **corte duro (hoy)** | — | **0,671** | **0,000** |

  → **SC-002 lo cumplen las 45 combinaciones con margen enorme (≥ 0,906, y ≥ 0,93 sumando S e I),
  mientras que las reglas de HOY lo incumplen (0,671 sobre mortales; 0,712 contando S e I).**
  SC-002 por sí solo **no discrimina nada**: el barrido T031 no debe decidirse con esa métrica.

### 3. Modelo de población (60 días, simulación propia)

Reglas reproducidas: 16 fundadores de 2 días (`initialDemography(4800)`, `index.ts:163`), 2 de ellos
inmortales y estériles; comprobación cada 120 ticks (20/día); `maturityAge = 1,8 + 0,3R + 0,1I` días;
`fertilityCooldown = 0,8 + 0,5R + 0,1I` días; ventana fértil `[maturity, 0,75·A)`; salud ≥ 0,55 para
procrear; herencia = media de los alelos de ambos progenitores + mutación (p = 0,08, ±0,08) sobre R e I;
muerte por hazard **y** por `health ≤ 0`; hambre/sed no matan.

**Calibración del factor de oportunidad.** El motor exige además comunidad, distancia ≤ 3, vínculos
mutuos ≥ 0,3, un lugar a ≤ 4 y reservas ≥ 0,1, que no se pueden modelar sin el mapa. Se resume en una
probabilidad por comprobación calibrada contra el dato medido (16 → 32 habitantes hacia el día 7,4,
semilla 12345). Como la forma funcional es la principal incertidumbre, **se calibraron y corrieron DOS
modelos** y sólo se recomienda lo que aguanta en ambos:

- **lineal** (el encuentro escala con el nº de adultos, comunidades densas): α = 0,00927 por adulto
  elegible y comprobación.
- **pares** (el encuentro escala con los pares, F²): α = 0,00188 por par elegible y comprobación.

Ambos reproducen el control: con las reglas VIEJAS la población llega a 32 el día 7 y los fundadores
caen de 16/16 (día 10, con S e I) a 3/16 (día 12) y 2/16 (día 14), con mediana de población 13 a día 25
y 8 a día 30 — la «ola» que describe la revisión.

**Hallazgo central — el tope, no el hazard, es el cuello de botella.** Con `poblacion.maxima = 32` el
mundo se llena hacia el día 7; a partir de ahí los ancianos post-fértiles (§0.5) ocupan cupo sin
reponer, los nacimientos se cortan y **la cohorte entera envejece sincronizada y muere junta**. En el
modelo de pares, `tope = 32` colapsa a los 60 días en 31-32 de 32 réplicas para *cualquier* hazard.
Paradójicamente, **más mortalidad estabiliza**: con tope fijo, matar ancianos es lo único que libera
cupo para nacimientos.

**Tabla 3 · Barrido de tope (c = 0,6, 32 réplicas, medianas; `ext60` = réplicas con ≤ 3 vivos a día 60)**

| r0 | pend. | tope | nac. | LINEAL pop10 / pop25 / pop60 · ext25 · ext60 | PARES pop10 / pop25 / pop60 · ext25 · ext60 | pop25/16 (LIN/PAR) |
|---|---|---|---|---|---|---|
| 0,02 | 10 | 32 | 1 | 32 / 12 / 8 · 0 · 3 | 32 / 6 / 2 · 3 · 32 | 0,75 / 0,38 |
| 0,04 | 6 | 32 | 1 | 32 / 16 / 14 · 1 · 8 | 32 / 7 / 2 · 6 · 32 | 1,00 / 0,44 |
| 0,08 | 6 | 32 | 1 | 32 / 17 / 15,5 · 0 · 9 | 32 / 9 / 2 · 1 · 32 | 1,06 / 0,56 |
| 0,04 | 6 | 36 | 1 | 36 / 21 / 10 · 0 · 11 | 36 / 16 / 2 · 0 · 31 | 1,31 / 1,00 |
| 0,08 | 6 | 36 | 2 | 36 / 22,5 / 21 · 0 · **1** | 36 / 19 / 2 · 0 · 28 | 1,41 / 1,19 |
| **0,04** | **10** | **40** | **2** | 39 / 27 / 23 · 0 · **3** | 40 / 24 / 2 · 0 · 19 | **1,69 / 1,50** |
| **0,08** | **6** | **40** | **2** | 37 / 31,5 / 25 · 0 · **1** | 40 / 26,5 / 2 · 0 · 21 | **1,97 / 1,66** |
| **0,08** | **10** | **40** | **2** | 39 / 32 / 29,5 · 0 · **2** | 40 / 32 / 22 · 0 · **10** | **2,00 / 2,00** |
| 0,04 | 6 | 48 | 2 | 39 / 39 / 31 · 0 · 0 | 43 / 41,5 / 29,5 · 0 · 10 | 2,44 / 2,59 |
| 0,08 | 10 | 48 | 2 | 38,5 / 38,5 / 29 · 0 · 1 | 41,5 / 45 / 46 · 0 · 1 | 2,41 / 2,81 |

Observaciones cuantitativas:

- **Generaciones vivas a día 25**: 6–8 en todo el barrido con tope ≥ 36 (mínimo por réplica ≥ 3);
  con tope 32 bajan a 4–5 y el mínimo por réplica cae a 3. SC-011 se cumple salvo en las esquinas
  `tope = 32` + pendiente ≥ 6 + r0 ≤ 0,01 del modelo de pares (hasta 7/32 réplicas con ≤ 3 vivos).
- **Fundadores vivos a día 10**: 14,5–16 de 16 en toda la rejilla (≥ 0,90). A día 25: 2–10 de 16 con
  pendiente 3, y exactamente 2 (S e I) con pendiente ≥ 6 — es decir, **con pendiente ≥ 6 ningún
  fundador mortal llega al día 25**, lo que es sano (recambio) pero conviene saberlo antes de leer
  la métrica.
- **`poblacion.maxima = 48/64` rompe el criterio de población final**: pop25 = 33–46 → 2,1–2,9× la
  inicial. Es el rango más estable a 60 días, pero incumple «≤ 200 %».
- **`nacimientosPorComprobacion = 2` reduce el colapso a 60 días** sin mover apenas pop25
  (p. ej. 0,08/6/tope 40: ext60 pasa de 1 a 1 en lineal y de 17 a 21 en pares; 0,08/10/tope 40:
  de 16 a 10 en pares): sirve sobre todo para **rebotar tras una ola**, que es cuando el mundo se
  extingue de verdad.

**Tensión honesta del criterio**: «población final entre 60 % y 200 % de la inicial» con inicial = 16
significa `pop ≤ 32`, es decir **fija el tope en ~32-40 por construcción**, justo el régimen donde el
modelo predice colapso a 60 días. Recomiendo medir la banda **contra el tope** (p. ej. 50–95 % del
tope) o subir el techo de la banda a 250 % si se quiere `tope = 48`. Se deja documentado porque el
barrido lo va a chocar.

### 4. RECOMENDACIÓN para T031

Régimen que cumple **SC-002** (fundadores a día 10 ≥ 70 %: predicho 0,91–1,00), **SC-011** (0 réplicas
extintas a día 25 y 6–8 generaciones vivas, mínimo 3) y **población final 0,6–2,0× la inicial**, en los
**dos** modelos de oportunidad: `poblacion.maxima = 40` con `nacimientosPorComprobacion = 2`, hazard
medio-alto (`riesgoSenescenciaDiario` 0,04–0,08) y pendiente 6–10.

```
npm run lab -- --param cuerpo.riesgoSenescenciaDiario=0.04,0.08 cuerpo.riesgoSenescenciaPendiente=6,10 cuerpo.cuidadoReduceRiesgo=0.6,0.8 poblacion.maxima=40 poblacion.nacimientosPorComprobacion=2 --replicas 8 --dias 25
```

8 combinaciones × 8 réplicas = 64 mundos. Predicción del modelo (8 réplicas, 25 días, medianas;
`LIN` = oportunidad lineal, `PAR` = por pares):

| r0 | pend. | c | LIN pop10 / pop25 / fund.10 / gen.25 | PAR pop10 / pop25 / fund.10 / gen.25 | pop25/16 |
|---|---|---|---|---|---|
| 0,04 | 6 | 0,6 | 39,5 / 27 / 15 / 7 | 40 / 19,5 / 16 / 7 | 1,69 / 1,22 |
| 0,04 | 6 | 0,8 | 39,5 / 24 / 15 / 8 | 40 / 17,5 / 16 / 7 | 1,50 / 1,09 |
| 0,04 | 10 | 0,6 | 39,5 / 33 / 15 / 7,5 | 40 / 25 / 16 / 7 | 2,06 / 1,56 |
| 0,04 | 10 | 0,8 | 39,5 / 26 / 15 / 7 | 40 / 28 / 16 / 6,5 | 1,63 / 1,75 |
| 0,08 | 6 | 0,6 | 40 / 29,5 / 14,5 / 7 | 40 / 28,5 / 15 / 7,5 | 1,84 / 1,78 |
| 0,08 | 6 | 0,8 | 39,5 / 35 / 14,5 / 7,5 | 40 / 26 / 15,5 / 7 | 2,19 / 1,63 |
| 0,08 | 10 | 0,6 | 39,5 / 27,5 / 14,5 / 7 | 39,5 / 36 / 15 / 7 | 1,72 / 2,25 |
| 0,08 | 10 | 0,8 | 39,5 / 33 / 15 / 7 | 40 / 34,5 / 16 / 8 | 2,06 / 2,16 |

Ninguna réplica se extingue a 25 días en ninguno de los dos modelos. Las combinaciones rozan el techo
del 200 % (pop25 ≈ 32) precisamente porque el tope es 40; si el barrido devuelve pop25 > 32 de forma
sistemática, **bajar `poblacion.maxima` a 36** (predicción: pop25 = 19–24, ratio 1,2–1,5) antes que
tocar el hazard. Si además se quiere estabilidad a 60 días (no exigida por SC-011), el mejor candidato
único es **`r0 = 0,08, pendiente = 10, c = 0,6, tope = 40, nac = 2`** (2/32 y 10/32 réplicas colapsadas
a 60 días frente a 31-32/32 con tope 32).

**Fallback sin barrido** (si T031 no llega a correr), `DEFAULT_PARAMS`:
`cuerpo.riesgoSenescenciaDiario=0.04`, `cuerpo.riesgoSenescenciaPendiente=10`,
`cuerpo.cuidadoReduceRiesgo=0.6`, `poblacion.maxima=40`, `poblacion.nacimientosPorComprobacion=2`.

**`PARAM_RANGES` (params.ts:48-69): la recomendación NO necesita ampliar ningún rango.**
`riesgoSenescenciaDiario` 0,04-0,08 ∈ [0,1]; `riesgoSenescenciaPendiente` 6-10 ∈ [0,50];
`cuidadoReduceRiesgo` 0,6-0,8 ∈ [0,1]; `poblacion.maxima` 40 ∈ [1,200];
`nacimientosPorComprobacion` 2 ∈ [0,20]. Lo que **sí** hay que tocar es otra cosa:

1. **`MAX_POPULATION = 32` está cableado en cinco sitios de `assertWorld` que T012 debe relajar, no
   dos**: `index.ts:998` (lista de personas), **`:1079` (`sample.population > MAX_POPULATION` en
   `world.history` — este se dispara aunque se arregle el primero)**, `:1017`
   (`list(event.actors, MAX_POPULATION)`), `:1064` (`numericMap(p.bonds, 0, 1, MAX_POPULATION)` — con
   40 habitantes una persona puede superar 32 vínculos) y `:1075` (`community.members.length`).
   Con `poblacion.maxima = 40` y sólo los dos cambios que menciona la tarea, el laboratorio revienta
   en `assertWorld` antes del día 8.
2. **Rangos que permiten construir un mundo que lanza `RangeError`** (robustez del barrido, no de la
   recomendación): `senescenciaInicioFraccion ∈ [0,1]` admite 0 y 1, pero `validate()`
   (`demography.ts:40`) exige `maturityAge < senescenceStart < maximumAge` estrictamente →
   debería ser `[0,30, 0,95]`. Y `longevidadBaseDias ∈ [1,60]` con `longevidadPorActividad ∈ [0,20]`
   permite `maximumAge ≤ 0` → `validate()` lanza. Conviene acotar `longevidadPorActividad` a `[0,4]`.
3. **Si el barrido sube `longevidadBaseDias` por encima de ~12,4** reaparece el corte implícito por
   salud (§5): el daño de senescencia total `A/15` supera `1 + γ(A−S)/2` para `A ≥ 16,42 d`, y
   `A_max = longevidadBaseDias + longevidadPorResiliencia`. Con los defaults (11 + 4 = 15 d) queda
   justo por debajo; con `base = 13` ya no.

### 5. Riesgos del modelo y cómo detectarlos en el laboratorio

**R1 · Bucle de realimentación cuidado→salud→riesgo (el riesgo principal).** El término
`1 − cuidadoReduceRiesgo·health·vitality` premia al cuerpo cuidado, pero `senescenceDamage` **ya**
erosiona la salud de 1,00 a 0,24 (A = 12,5) dentro de la misma ventana en que el hazard actúa. La
mitigación efectiva pasa de `1 − c` en `senescenceStart` a `1 − 0,24·c` en `maximumAge`: con c = 0,6,
de 0,40 a **0,857**. Es decir, **el cuidado protege un 60 % cuando no hace falta y un 14 % cuando sí**.
Por eso las columnas «descuidado» y «real» de la Tabla 1 son indistinguibles: el parámetro que la
constitución vende como «la cooperación alarga la vida» hoy casi no mueve nada.

**R1b · Si T010 añade MÁS desgaste, restaura el decreto.** Margen exacto: la salud llega a 0 antes de
`maximumAge` cuando `m·(A/15) > 1 + γ·(A−S)/2`. Con el desgaste actual (m = 1) el umbral es
**A ≥ 16,42 d** (nadie lo alcanza hoy: A_max = 15,0 d). **Con el desgaste ×2 el umbral baja a
A ≥ 7,84 d, o sea TODOS**: el mundo volvería a morir por decreto, con causa `senescence`, y el
barrido no lo distinguiría de un hazard funcionando. Multiplicador máximo tolerable: **m < 1,09** para
el individuo más longevo posible y **m < 1,29** para el medio. **Recomendación: T010 no debe añadir
desgaste nuevo; debe redistribuir el existente** (p. ej. bajar el coeficiente 0,8 de
`senescenceDamage` a ~0,45 y compensar con el hazard) para que el cuidado tenga algo que proteger.

**Métricas y umbrales para el laboratorio (T016-T018), por réplica y día:**

| métrica | cómo se calcula | 🟢 | 🟡 | 🔴 |
|---|---|---|---|---|
| `salud.ancianos.p50` | mediana de `demography.health` entre los vivos con `age ≥ senescenceStart`, a día 10 y 25 | ≥ 0,55 | 0,35–0,55 | < 0,35 → la mitigación por cuidado está muerta (`1−c·h` > 0,79) |
| `muertes.senescencia.porSalud` | fracción de muertes con causa `senescence` en cuyo tick `health` llegó a 0 (rama `health <= 0`) en vez de salir sorteada | 0 % | ≤ 20 % | > 20 % → sigue siendo decreto |
| `edadMuerte.cv` | σ/media de la edad de muerte de los mortales | ≥ 0,15 | 0,10–0,15 | ≤ 0,10 → indistinguible del corte duro |
| `ancianos.fraccion` | vivos con `age ≥ senescenceStart` / población, a día 25 | ≤ 0,35 | 0,35–0,50 | > 0,50 → cupo bloqueado, nacimientos a cero |
| `nacimientos.dia` | nacimientos por día, ventana móvil de 3 días | ≥ 1,0 | 0,3–1,0 | 0 durante ≥ 3 días → ola sincronizada en curso |

`edadMuerte.cv` es el test más limpio de «riesgo vs. decreto»: **con el corte duro de hoy vale 0,081**
(media 12,57 d, σ 1,01 d, p10-p90 11,2-13,9), y con el hazard sube a **0,155 (pendiente 6)** o
**0,123 (pendiente 10)** — medias 15,1-18,6 d, p10-p90 12,7-22,2. Una pendiente 10 con r0 alto se
acerca peligrosamente al corte duro en dispersión; **si se quiere legibilidad de «unos mueren antes
que otros», preferir pendiente 6**.

**R2 · Ola sincronizada.** Todos los fundadores tienen 2 días y todos los hijos nacen en ~7 días: las
cohortes envejecen juntas. Con tope apretado esto produce el patrón boom-bust que se ve en la Tabla 3
(pop60 = 2 = sólo S e I). Detección: `nacimientos.dia = 0` durante ≥ 3 días con población < tope, o
σ de la edad de la población viva < 2,5 días. Mitigación disponible sin tocar reglas:
`nacimientosPorComprobacion = 2` y `poblacion.maxima = 40`.

**R3 · Incertidumbre del propio modelo.** El factor de oportunidad reproductiva es lo único calibrado
«a ojo» contra un dato (16→32 en 7,4 días). Las dos formas funcionales probadas difieren hasta 2× en
`pop25` y hasta 20/32 réplicas en el colapso a 60 días. **Todo lo que esta sección afirma está
verificado en ambas**; lo que sólo vale en una está marcado. Si el barrido real difiere, el parámetro
a re-estimar primero es la tasa de nacimientos, no el hazard.

**R4 · Lo que este modelo NO simula** y puede invalidar los números: hambre/sed/frío (supuestos
inocuos por la medición de la revisión, cierto sólo mientras los recursos estén saturados — **T013
cambia eso y puede reintroducir mortalidad juvenil**), la formación de comunidades (el tope real de
nacimientos es social, no demográfico), `varianzaFundadores > 0` de T011 (ensancharía la distribución
de `maximumAge` más allá de 10,45-14,70 d y **rompería la sincronía de cohortes, que es una buena
noticia para R2**), y la elección de pareja por afinidad de T012.
