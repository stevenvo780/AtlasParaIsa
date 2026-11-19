# T172 — Consolidación de documentación técnica

- **Fecha**: 2026-11-19
- **Rama / worktree**: `sprint/t172-docs-t144-20261119` (base `5935aea`)
- **Alcance estricto**: únicamente `docs/REGLAS.md`, `docs/CIENCIA.md`, `README.md` y este informe (sin tocar `src/`, `tests/`, `docs/EVIDENCIA.md`, `docs/ESTADO.md` ni `docs/PLAN-ESTABILIDAD-2026-11-18.md`).

**Frase de determinismo**: esta tarea modifica únicamente documentación Markdown; no altera código ejecutable ni parámetros, por lo que el hardware no puede cambiar el resultado del mundo.

---

## Ficheros tocados y cambios realizados

| Fichero | Qué cambió y por qué |
|---|---|
| [`docs/REGLAS.md`](../../../docs/REGLAS.md) | (1) Clarifica explícitamente bajo *Reglas 11* que **`RULES_VERSION` permanece en `11`** (protocolo `10`, SQLite `5`, estado publicado en [`docs/ESTADO.md`](../../../docs/ESTADO.md)) y que **Fase B (`tecnologia.*`) es opt-in y no ha sido adoptada en `DEFAULT_PARAMS` ni `HISTORICAL_PARAMS`** tras el veredicto del panel preregistrado de 8 semillas × 60 días (`Q4`/`Q5` ok, `Q1`/`Q2`/`Q3` no cumplidas). (2) Actualiza la tabla de configuración tipada con `motor.depuracion` (T148, excluida de `digestoCanonico`), el estado vivo de `motor.*`, `gobernador.senales` (`p95`, `max`, `rss`, `colaRed`, `saveMs`, T161/T162), `limites.aplicacion` (T100) y las cuatro claves exactas de `src/world/params.ts` para `tecnologia.*` (`dosisCuanto`, `mejoraLocal`, `enfriamiento`, `evitarNoOp`). (3) Actualiza la cobertura viva de `HALO_CELDAS = 14` (`src/world/halo.ts`, incluyendo E.0, `TileStore` paralelo/GPU, máscara de fauna y desalojo T163) y añade la sección **«Motor: orden determinista de reducciones y barreras»** (colas estáticas por `regionId`, doble buffer con máscara de presencia, dos pasadas ecológicas separadas y FP64 `--fmad=false` en GPU, prohibición de `Atomics` para magnitudes/identidades y sumas en árbol, fases seriales y contrato futuro E.1). (4) Alinea la tabla principal de parámetros con los defaults de Reglas 11 (`social.disputa*`), `social.hogarTrabajo`, `social.disolucion` (COM-D′) y `tecnologia.*` opt-in. |
| [`docs/CIENCIA.md`](../../../docs/CIENCIA.md) | Añade la sección **«Escala física del cómputo: muro de DRAM, PCIe y separación de ejes»**, enlazando la comparación inicial de septiembre con las mediciones de 2026-11-19 ([`T122-T125-report.md`](T122-T125-report.md) y [`T144-report.md`](T144-report.md)): explica la saturación de DDR5 en el tick ecológico CPU (105,7 → 3 245,4 ms en 1 hilo; 8 vs 28 workers planos en 1 088,7 → 1 097,7 ms a 32 M), el muro PCIe en bajada densa (`2 149 ms` sobre `18,39 ms` de kernel a 18,43 M) frente a **VRAM autoritativa** (`11,99 ms` a 18,43 M y **`19,60 ms` a 32,00 M** con `63 744 B/tick` de subida dispersa y 0 diffs `Object.is`), y por qué el eje de habitantes permanece en CPU/latencia de memoria (grafo irregular, ramificación alta, consultas de halo `HALO_CELDAS = 14`, acumuladores ordenados y SQLite). |
| [`README.md`](../../../README.md) | Añade a la tabla de «Desarrollo y comprobaciones» los comandos vigentes `npm run techo`, `npm run banco:red`, `scripts/banco-escala-extrema-gpu.mts` y `npx tsx scripts/check-links.ts`, conservando [`docs/ESTADO.md`](../../../docs/ESTADO.md) como única fuente del estado publicado. |
| [`specs/002-mundo-ilimitado/informes/T172-report.md`](T172-report.md) | Este informe. |

---

## Verificación

- `git status` y `git diff --stat`: verificado que únicamente se tocaron los cinco ficheros autorizados (`docs/REGLAS.md`, `docs/CIENCIA.md`, `README.md`, `T144-report.md`, `T172-report.md`).
- `npx tsx scripts/check-links.ts` tras `git add`: **0 enlaces rotos** en todos los documentos `.md` versionados.
- `git diff --check`: sin espacios sobrantes ni conflictos.
