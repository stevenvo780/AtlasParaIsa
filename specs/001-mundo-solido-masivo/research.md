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
