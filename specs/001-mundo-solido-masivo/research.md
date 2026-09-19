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
