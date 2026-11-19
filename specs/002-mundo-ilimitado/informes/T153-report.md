# Informe T153 — Reducción canónica de acumuladores agregados fuera del worker (FR-023)

Fecha: 2026-11-19  
Rama: `sprint/t153-agregados-20261119`  
Autoría: Grok (implementación y pruebas) + revisión e informe en integración.

## Resumen

Se implementa la vía (a) de FR-023 en `src/world/paralelo/agregados.ts` y el helper compartido `saturateTotal` / `TOTALS_CAP` en `src/world/statistics.ts`, junto con la suite `tests/agregados.test.ts`.

Los workers no acumulan en vivo sobre contadores globales; emiten contribuciones tipadas `Intent` (`fase: 'agregado'`) para los cinco libros declarados (`totals`, `inventionDynamics`, `ledger`, `demographyDynamics`, `animalDynamics`). El coordinador ejecuta `reduceAggregates(books, intents, now?)`:

- Valida estrictamente cada clave contra el catálogo cerrado `AGGREGATE_KEYS` (rechaza libro/clave desconocida, `actorSlot`/`secuenciaLocal` no enteros o negativos, cantidades no finitas y pares `(actorSlot, secuenciaLocal)` duplicados).
- Descarta por completo el orden de llegada/región y ordena de forma canónica por `(actorSlot, secuenciaLocal)` antes de sumar.
- Aplica la misma saturación en cada suma que `count` (`saturateTotal = Math.min(1e12, (current ?? 0) + amount)`), garantizando igualdad bit a bit (`Object.is`) frente al camino secuencial incluso en FP64 no asociativo y junto al tope `1e12`.
- No llama a relojes dentro de `src/world` (`NO_CLOCK` por defecto; acepta `now` inyectado para medir `ReductionCost` y calcular `serialShare(cost, stepBudgetMs)` hacia T151 / FR-021).

## Verificación

Ejecutado en `worktrees/t153-agregados-20261119`:

- `npm run typecheck`: verde (0 errores).
- `npx tsx --test tests/agregados.test.ts tests/halo-radios.test.ts`: **17/17 pruebas verdes, 0 fallos** (4,95 s):
  - Paridad bit a bit en cosecha entre dos regiones con 1, 8 y 28 workers y geometrías 256 y 512.
  - Prueba negativa: sumar FP64 agrupado por región altera bits y la aserción lo detecta.
  - Saturación exacta en `1e12` y junto al tope en cada suma para las cinco tablas de acumuladores.
  - Validación de orden canónico `(actorSlot, secuenciaLocal)`, rechazos de duplicados/claves ajenas/NaN e integración con `booksFromWorld`.
  - Medición del coste con reloj inyectado y verificación de baseline de 1 200 pasos con `particionarPersonas=false` (digesto idéntico).

## Ficheros tocados

- `src/world/statistics.ts` (+12/-1)
- `src/world/paralelo/agregados.ts` (nuevo, 224 líneas)
- `tests/agregados.test.ts` (nuevo, 9 pruebas)
- `specs/002-mundo-ilimitado/informes/T153-report.md` (este informe)
