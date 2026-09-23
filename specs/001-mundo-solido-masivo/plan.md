# Implementation Plan: Mundo sólido y laboratorio masivo — SPRINT 3 h (2026-09-19)

**Branch**: `001-mundo-solido-masivo` | **Date**: 2026-09-19 (rev. 2, tras la revisión integral) | **Spec**: [spec.md](spec.md) | **Revisión**: [`docs/REVISION-2026-09-19.md`](../../docs/REVISION-2026-09-19.md) | **Tareas**: [tasks.md](tasks.md)

## Summary
La revisión integral (12 dimensiones + refutación adversarial, todo con ejecución real) encontró **la causa mecánica de cada queja**: los habitantes mueren por un **corte de edad incondicional** (10,45–14,70 días), la homogeneidad viene de que **la fabricación ignora la receta decidida** y de **fundadores homocigotos**, el entorno se satura porque la **regeneración no tiene capacidad de carga ni la fertilidad decaimiento**, el móvil muere por un **`state` de 465 KiB dos veces por segundo**, y el servidor incumple su presupuesto porque **clona y persiste el mundo entero cada tick**. Este plan sustituye al anterior: en vez de «instrumento → reglas → visual → refactor» en 4 h, corre **14 workstreams en paralelo** (vida/evolución/entorno + servidor/móvil + laboratorio) desde un único commit base, integra una vez, y usa el laboratorio para **calibrar** los defaults con evidencia. El refactor US5 se pospone con motivo (arquitectura de capas sana; riesgo de conflictos).

## Technical Context
**Language/Version**: TypeScript 7.0.2 estricto sobre Node 22.23.1 · **Deps**: `ws`, Vite 8, `tsx`, `node:sqlite`; sin deps nuevas · **Storage**: SQLite WAL (`data/world.sqlite` = 347 MB hoy + 9,7 GB en `data/experiments`; **no se toca**) · **Testing**: `tsx --test --test-timeout=240000 tests/*.test.ts` (56 ficheros; `world.test.ts` 115 s), Playwright e2e (Chromium 1243 instalado 2026-09-19) · **Target**: torre kratos (32 hilos, 125 GiB, RTX 5070 Ti + 2060), navegador escritorio y móvil · **Performance Goals**: p95 paso < 50 ms con 32 hab. (hoy **131,9 ms**); `state` < 120 KiB (hoy **465 KiB**); barrido 32×10 días < 15 min · **Constraints**: determinismo por semilla (verificado sano), origen único, sin LLM en el bucle, **params fuera del snapshot** (WeakMap por mundo, sin migración) · **Scale**: 16–128 habitantes (tope paramétrico), 30 réplicas paralelas.

## Constitution Check
- I (determinista, sin rescates): T010 convierte la muerte en riesgo determinista (`localRandom` por persona+tick), no en inmortalidad; T012/T013 con defaults = bit a bit igual (control) ✔
- II (evidencia): T030 línea base ANTES de cambiar defaults; T031 calibra con barrido y control; T032 barrido largo; filas en EVIDENCIA con SHA/semillas ✔
- III (reglas simples): capacidad de carga logística, hazard Gompertz y elección por afinidad son **una ley cada una**, parametrizadas, no sistemas nuevos ✔
- IV (diversidad/muerte con sentido): T011 variación heredable, T014 diversidad tecnológica, T015 muerte con lugar y 3 eventos previos ✔
- V (rendimiento medido): T021 cadencia de guardado + poda, T020 `state` acotado, T025 fauna incremental; `benchmark-simulation.ts` antes/después ✔
- VI (experiencia sin mentir): T024 modo observador real; la carta no se toca ✔
- **Excepción declarada** (Complexity Tracking): US5 pospuesta.

## Hallazgos que dirigen el plan (de la revisión, con cifras)
| Queja | Causa (fichero:línea) | Tarea |
|---|---|---|
| Mueren rápido | `demography.ts:23,82` corte de edad 10,45–14,70 días; tope 32 corta nacimientos → ola de senescencia → extinción ~día 15 | T010, T012 |
| Homogéneos | `technology.ts:463` fabrica otra receta; `genetics.ts:14` homocigotos; `index.ts:906` primer candidato | T014, T011, T012 |
| Recursos en todos lados | `index.ts:203` sin capacidad de carga (100 % celdas con comida a t=1251); `ecosystem-kernel.ts:94` fertilidad → 1,0 | T013 |
| Móvil imposible | `index.ts:978` state 465 KiB ×2/s (186 KiB recetas); `landscape.ts:612` dpr 3 sin modo ligero | T020, T024 |
| Arquitectura | `app.ts:142-146` clon+guardado síncrono por tick (p95 132 ms); `store.ts:598` crecimiento sin poda (~260 MB/h) | T021, T025 |
| (bloqueante) | `npm test` cuelga: Vite `listen()` fuera del `try` + Chromium 1243 ausente | T002, T003 |

## Project Structure

### Documentation (this feature)
```text
specs/001-mundo-solido-masivo/{spec,plan,research,tasks,quickstart}.md · checklists/requirements.md
docs/REVISION-2026-09-19.md                 # informe de la revisión (fuente de verdad de los hallazgos)
docs/historial/fase12-vida-servidor.js  # workflow paralelo de Fase 1+2 (tool Workflow, scriptPath); archivado
.superpowers/sdd/tasks/progress.md          # ledger SDD (git-ignored): rulings, rondas, completados
```

### Source Code (repository root)
```text
src/world/
├── params.ts            # T001 NUEVO: WorldParams, DEFAULT_PARAMS, parseParams, paramsOf/setParams (WeakMap)
├── demography.ts        # T010: senescencia como riesgo (hazard), desgaste legible
├── genetics.ts, lineage.ts   # T011: variación heredable por alelo, tasa de mutación paramétrica
├── index.ts             # T001 createWorld/cloneWorld · T011 fundadores · T012 reproduce · T013 ecology · T014 llamada craft · T015 registro de muerte · T020 projectWorld
├── ecosystem-kernel.ts, ecosystem.ts, statistics.ts   # T013: decaimiento de fertilidad, K por bioma, gini/fracción/distancia
├── technology.ts, technology-execution.ts             # T014 recipeId · T020 projectTechnology resumen
├── animals.ts           # T025 syncFauna incremental
└── chronicle-journal.ts # T015
src/server/app.ts        # T020 handler recipe · T021 stepOnce cadencia · T023 rate tras proxy · T024 suscripcion
src/server/store.ts      # T021 synchronous=NORMAL, poda, load() en transacción
src/server/main.ts       # T021 cadencia de producción
src/shared/types.ts      # T020 ClientMessage, instanceId, resumen de receta · T015 death en EventView
src/client/modo.ts       # T024 NUEVO · landscape.ts, game.ts, world-shell.ts (T024) · technology-art/inspector-view/ui-catalog (T020) · inspector-view (T015)
scripts/lab/{replica,barrido,resumen}.ts + README.md   # T016–T018 NUEVOS
tests/{params,senescencia,genetics,recursos,muerte,lab,lab-barrido,lab-resumen,world-view-size,modo}.test.ts  # NUEVOS
```

**Structure Decision**: sin carpetas nuevas en `src/` salvo `scripts/lab/`; cada tarea toca funciones distintas de `index.ts`/`app.ts` (mapa arriba) para que el merge sea trivial.

## Protocolo de ejecución (lo que `/speckit-implement` debe hacer, literal)

**Principio**: paralelismo máximo con aislamiento por worktree; calidad por revisión adversarial por tarea; evidencia por laboratorio. Token cost no es restricción (Steven, 2026-09-19).

0. **Fase 0** (workflow `fase0-desbloqueo`, ya lanzado 2026-09-19 09:40): T001 ∥ T002 ∥ T004 en el árbol principal (ficheros disjuntos) → Gate 0 (`typecheck` + suite completa) → **commit «Gate 0»**. T003 hecho (Chromium instalado).
1. **Fase 1+2** (workflow `docs/historial/fase12-vida-servidor.js`, archivado; tool `Workflow` con `scriptPath`): **14 agentes en paralelo**, uno por tarea, cada uno con `isolation: 'worktree'` desde el commit Gate 0. Cada agente:
   - `ln -s <repo>/node_modules node_modules` en su worktree; lee su tarea en `tasks.md`; lee `docs/REVISION-2026-09-19.md` §de su hallazgo.
   - Si su modelo es externo (`codex/*`, `gemini/*`, `grok/*`, `minimax/*`): delega con `delegar_a_cloud(model, effort, access:'write', cwd:<worktree>, timeout_s: 1500)` con un prompt **autocontenido** (texto literal de la tarea + reglas de ejecución + fragmentos actuales de los ficheros a tocar). Si es Claude, implementa él mismo.
   - Verifica: `npm run typecheck` + `timeout 300 npx tsx --test <sus tests>`; una ronda de corrección si falla; **commit en la rama del worktree**; informe en `.superpowers/sdd/tasks/<TID>-report.md` (en el repo principal).
   - **Revisor por tarea** (Opus, lente = hallazgo que corrige + constitución I/III): lee `git diff <base>..HEAD` del worktree; veredicto spec ✅/❌ + calidad; una ronda de arreglo (mismo modelo) + re-revisión acotada. Findings menores → ledger.
2. **Gate 1+2** (orquestador): merge de ramas en el orden de `tasks.md` (menos → más conflictivo), resolver conflictos de `index.ts`/`app.ts` (hunks disjuntos), `npm run check`, **T041 revisión adversarial del diff completo** (3 lentes Opus), commit.
3. **Fase 3** (en segundo plano desde que T016–T018 estén verdes): T030 línea base (worktree en Gate 0 + `scripts/lab`), T031 calibración 288 mundos (~10 min con 30 procesos), T032 largo. El orquestador fija `DEFAULT_PARAMS` con evidencia (única edición de `params.ts` post-T001).
4. **Fase 4**: T040 e2e + capturas, T042 docs (Gemini flash), T043 publicación con Steven.

**Ledger** (`.superpowers/sdd/tasks/progress.md`): una línea por tarea completada, ronda de arreglo o *ruling*. Sobrevive a la compactación de contexto; ante duda, manda el ledger + `git log`.

**Rulings ya tomados** (registrados en el ledger):
- R1: se ejecutan implementadores **en paralelo** (el skill SDD dice «nunca»): las tareas son disjuntas por fichero/función y corren en worktrees; el coste si falla es un merge manual, asumible frente a 14× tiempo. (Steven pidió paralelismo máximo.)
- R2: US5 refactor **pospuesto**; la constitución exige justificarlo: capas sanas verificadas, riesgo de conflicto con 14 workstreams sobre `index.ts`.
- R3: `params` viven en `WeakMap` fuera del snapshot (sin migración de esquema en el sprint); el servidor público arranca con `DEFAULT_PARAMS` calibrados en código. Coste si falla: un mundo restaurado de backup no recuerda params custom — aceptable porque producción usa defaults.
- R4: `synchronous=NORMAL` con WAL (T021): pérdida ≤ último commit ante corte eléctrico, nunca corrupción; a cambio el guardado baja de ~49 ms. Documentar en REGLAS.

## Asignación de modelos (calidad primero; saldos 2026-09-19 09:20: Claude 5h 92–100 % ×3 cuentas, Gemini 89–100 %, MiniMax 91 %, Grok autenticado, Codex 26 % semanal)
| Fase / tarea | Modelo | Esfuerzo | Por qué |
|---|---|---|---|
| T010 senescencia, T013 entorno | `codex/gpt-5.6-sol` (wrapper Opus verifica) | xhigh / high | Los dos modelos científicos delicados; el más capaz. Codex al 26 %: solo aquí |
| T011 genética | `gemini/pro` | high | Razonamiento + contexto largo (genetics/lineage/index) |
| T012 reproducción | `grok/grok-4.6` | high | Lógica no trivial; reparte carga entre proveedores |
| T002, T014, T023 | `minimax/MiniMax-M3` | — | Pequeñas, bien especificadas |
| T001, T004, T015–T018, T024, T025 | Claude Sonnet 5 | high | Codificación seria; cuota holgada |
| T020, T021 | Claude Opus | high | Contrato compartido y transacciones SQLite |
| Revisores por tarea, T041 | Claude Opus | high | Verificación adversarial (rúbrica 4) |
| T042 docs | `gemini/flash` | high | Documentación masiva |
| Gate 0/1+2, T030–T032, merges, rulings, T043 | Fable 5.1 (orquestador) | — | Decisiones críticas y síntesis |

## Fases y reloj (180 min desde 09:40)
| Reloj | Fase | Paralelismo |
|---|---|---|
| 0:00–0:15 | Fase 0 + SDD | 3 agentes + orquestador |
| 0:15–1:15 | Fase 1+2 | 14 implementadores ∥ → 14 revisores ∥ → arreglos ∥ |
| 0:50–1:45 | Fase 3 (fondo) | 30 procesos del laboratorio |
| 1:15–1:45 | Gate 1+2 | merge + T041 (3 lentes ∥) |
| 1:45–2:30 | Fase 4 | T040 ∥ T042 ∥ T032 |
| 2:30–3:00 | Buffer | — |

## Complexity Tracking
| Excepción | Motivo | Alternativa simple rechazada |
|---|---|---|
| US5 (refactor < 400 líneas) pospuesta | Capas sanas (revisión §3); 14 workstreams sobre `index.ts` en 3 h harían el refactor un generador de conflictos | Hacerlo primero: bloquearía todo lo demás 1 h y sin laboratorio no habría control de determinismo |
| Params fuera del snapshot | Evitar migración de esquema + `assertWorld` en el sprint | Campo `params` en `World`: exige versión 7 de snapshot y migración; se hará tras el evento |
