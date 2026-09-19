# Tasks: Mundo sólido y laboratorio masivo

**Input**: `specs/001-mundo-solido-masivo/{spec,plan,research}.md` · **Branch**: `001-mundo-solido-masivo`

**Tests**: SÍ, pedidos por la constitución (II): cada regla trae prueba y experimento. Suite existente: `npm test` (58 ficheros), `npm run typecheck`.

**Organization**: por historia. `[P]` = paralelizable (ficheros disjuntos): repartir entre subagentes. Una integración (typecheck + test + barrido de control) al cerrar cada fase. **Orden estricto de fases: instrumento → reglas → experiencia → arquitectura → cierre.**

**Regla de oro**: el servidor público (`~/.local/bin/atlas-servidor`, datos en `data/`) no se toca; el laboratorio usa `CARTA_DATA_DIR` temporal por réplica.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [ ] T001 Crear `src/world/params.ts`: interfaz `WorldParams` (recursos.densidad, recursos.regeneracionDias, agua.cuencas, cuerpo.hambreDias, cuerpo.sedDias, cuerpo.frioTolerancia, social.imitacion, genes.varianza…), `DEFAULT_PARAMS`, `parseParams(input: Record<string,string>|string): WorldParams` con validación de rangos; test `tests/params.test.ts`.
- [ ] T002 Enchufar `WorldParams` en `createWorld(seed, params = DEFAULT_PARAMS)` y `stepWorld` (`src/world/index.ts`) sin cambiar valores por defecto; suite verde (control de que nada cambió).
- [ ] T003 [P] Añadir scripts npm: `"lab": "tsx scripts/lab/barrido.ts"`, `"lab:replica": "tsx scripts/lab/replica.ts"`, `"lab:resumen": "tsx scripts/lab/resumen.ts"` en `package.json`; crear `scripts/lab/README.md` con uso y formato de salida.

## Phase 2: US1 — Laboratorio de simulaciones masivas 🎯 MVP

**Goal**: barrido paralelo de mundos sin interfaz con métricas comparables y control de determinismo.
**Independent Test**: `npm run lab -- --replicas 32 --dias 10 --salida artifacts/lab/base` termina < 15 min usando ≥ 28 hilos y produce `resumen.{json,md}`; dos réplicas con la misma semilla dan métricas idénticas.

- [ ] T010 [P] [US1] `scripts/lab/replica.ts`: args `--seed --dias --params <json> --salida <dir>`; usa `createWorld/stepWorld/worldStatistics` con `CARTA_DATA_DIR` temporal; escribe `dia-NNN.json` (población, nacimientos, muertes por causa, diversidad, recursos por región, agua, construcciones, p50/p95 ms por paso, RSS) y `replica.json` final con SHA (`git rev-parse HEAD`) y digests de `src/world`.
- [ ] T011 [P] [US1] `scripts/lab/barrido.ts`: args `--replicas --dias --param clave=v1,v2 (repetible) --seed-base --concurrencia (default availableParallelism-2) --timeout --salida --control <dir>`; producto cartesiano de parámetros; `child_process.spawn` con cola; mata réplicas colgadas y las marca `abortada`; `progreso.log`.
- [ ] T012 [P] [US1] `scripts/lab/resumen.ts`: lee un directorio de barrido, agrega mediana/p10/p90 por grupo de parámetros, compara con `--control` (delta y semáforo), detecta rotura de determinismo (misma semilla+SHA ≠ métricas), escribe `resumen.json` y `resumen.md` (tabla legible).
- [ ] T013 [US1] `tests/lab.test.ts`: réplica de 1 día con semilla fija produce JSON con las claves esperadas; dos réplicas iguales → métricas idénticas; barrido con 3 réplicas y `--concurrencia 2` termina y encola (depende de T010–T012).
- [ ] T014 [US1] Correr LÍNEA BASE: `npm run lab -- --replicas 32 --dias 10 --salida artifacts/lab/base-$(git rev-parse --short HEAD)`; guardar `resumen.md`; anotar en `docs/EVIDENCIA.md` sección «2026-09-19 · Línea base» las cifras reales de supervivencia, diversidad, Gini y tiempos. **Estas cifras fijan los objetivos SC-002..005 definitivos (ajustar spec si procede, dejando escrito por qué).**

**Checkpoint**: instrumento listo; a partir de aquí toda regla se mide.

## Phase 3: US2 — Sobreviven, difieren, mueren con causa (P1)

**Goal**: mortalidad temprana corregida con causas legibles; diversidad medible y alta.
**Independent Test**: barrido 32×10 días: supervivencia fundadores mediana ≥ 70 %, diversidad ≥ 0,6 al día 5, 0 muertes `desconocida`.

- [ ] T020 [P] [US2] `src/shared/types.ts`: enum `CausaMuerte` (hambre, sed, frio, calor, herida, depredacion, ahogamiento, edad, enfermedad, parto) y tipo `RegistroMuerte {causa, tick, placeId, eventosPrevios[3]}`; `src/world/muerte.ts`: `registrarMuerte(world, cuerpo, causa, contexto)` única vía; test `tests/muerte.test.ts` con invariante «ninguna muerte sin causa» sobre 2 días simulados.
- [ ] T021 [US2] Sustituir todas las transiciones a muerto en `src/world/{body,animals,needs,family,demography}.ts` por `registrarMuerte`; la crónica (`src/server/store.ts` + `chronicle`) persiste el registro; el inspector del cliente lo muestra (depende de T020).
- [ ] T022 [P] [US2] `src/world/diversidad.ts`: vector de conducta por habitante (fracción de tiempo por actividad, alimentos, regiones visitadas, procedimientos practicados, oficio dominante) y `indiceDiversidad(world)` = distancia coseno media entre pares + entropía de oficios; exponer en `worldStatistics` (`src/world/statistics.ts`); test `tests/diversidad.test.ts` (dos clones → 0; dos opuestos → ~1).
- [ ] T023 [US2] Diagnóstico con el laboratorio: barrido `--param cuerpo.hambreDias=2,3,4 cuerpo.sedDias=1,2,3 cuerpo.frioTolerancia=…` (32 réplicas × 10 días) → identificar la causa dominante de muerte temprana en `resumen.md`; escribir hallazgo en EVIDENCIA (depende de T014, T021).
- [ ] T024 [US2] Corregir la regla responsable (no rescates: cambiar la ley o el valor por defecto en `params.ts` con justificación) y volver a barrer; elegir el valor con mejor supervivencia SIN población > 200 % (depende de T023).
- [ ] T025 [P] [US2] Homogeneidad: en `src/world/genetics.ts` y `src/world/lineage.ts` aumentar varianza heredable con parámetro `genes.varianza`, y en `src/world/needs.ts`/`decision` ponderar decisiones por rasgos individuales y recuerdos propios (no por tablas globales); barrer `genes.varianza` y `social.imitacion` y elegir por diversidad ≥ 0,6 manteniendo supervivencia (depende de T022).
- [ ] T026 [US2] Barrido de confirmación 32×10 con los nuevos defaults + control = línea base; fila en EVIDENCIA con SHA y cifras; `npm run typecheck && npm test` verdes.

**Checkpoint**: SC-002, SC-003, SC-005 cumplidos y documentados.

## Phase 4: US3 — Entorno escaso y legible (P2)

**Goal**: recursos por bioma con agotamiento y regeneración; mapa de calor.
**Independent Test**: Gini de recursos por región ≥ 0,35, ≥ 30 % regiones sin agua superficial, distancia media a agua > 6 celdas; mapa de calor coincide con el servidor.

- [ ] T030 [P] [US3] `src/world/recursos.ts`: densidad por bioma × ruido espacial determinista (reutilizar `terrain.ts`), agua superficial sólo en cuencas (`agua.cuencas`), agotamiento por extracción y regeneración logística (`recursos.regeneracionDias`); `giniPorRegion`, `regionesSinAgua`, `distanciaMediaAgua` en `statistics.ts`; test `tests/recursos.test.ts`.
- [ ] T031 [US3] Integrar `recursos.ts` en la generación (`terrain.ts`, `ecosystem.ts`) y en extracción/consumo (`technology-water.ts`, `needs.ts`); mantener determinismo (control con la misma semilla debe cambiar SOLO por el parámetro) (depende de T030).
- [ ] T032 [US3] Barrido `--param recursos.densidad=0.4,0.7,1.0 agua.cuencas=…` 32×10; elegir defaults que cumplan Gini/agua manteniendo SC-002; EVIDENCIA (depende de T031, T026).
- [ ] T033 [P] [US3] Cliente: capa `mapa de calor` de recursos en `src/client/` (tecla `H`), leyenda, y comprobación de que los totales por región coinciden con `worldStatistics` recibido; captura en `artifacts/`.

## Phase 5: US4 — Presentable: espectacular en escritorio, observador en móvil (P2)

**Goal**: modo completo vistoso y modo observador ligero.
**Independent Test**: Lighthouse móvil emulado < 3 s y < 150 MB en `/?modo=observador`; escritorio ≥ 55 fps con 32 habitantes; capturas antes/después.

- [ ] T040 [P] [US4] `src/client/modo.ts`: `decidirModo()` por WebGL2 disponible, `navigator.deviceMemory`, `matchMedia('(max-width: 700px)')`, `?modo=`; conmutador visible; test `tests/modo.test.ts` (tabla de casos).
- [ ] T041 [P] [US4] `src/client/observador/`: vista sin compositor: carta de apertura, crónica (últimos 50 eventos con causa), censo con búsqueda, ficha de habitante (estado, oficio, recuerdos, causa de la última decisión), mini-mapa estático (canvas 2D de 1 dibujo por actualización).
- [ ] T042 [US4] Servidor `src/server/app.ts`: mensaje `suscripcion {intervaloMs}` para clientes observadores (mínimo 1000, defecto 5000) y `state` reducido (sin celdas por celda) cuando el intervalo ≥ 5000; test en `tests/connection.test.ts` (depende de T041).
- [ ] T043 [P] [US4] Pase visual en `src/client/landscape.ts`: luz diurna/atardecer/noche según `phaseAt(tick)`, agua con reflejo animado barato, vegetación por densidad, huellas y humo de hogares; mantener ≥ 55 fps (medir con `performance.now()` en el bucle y registrar p95 en consola de diagnóstico ya existente).
- [ ] T044 [US4] Medición: Playwright con emulación móvil (`Moto G Power`, CPU 4x) sobre `/?modo=observador` → tiempo a interactivo y memoria; escritorio 60 s → fps; guardar capturas `artifacts/visual-antes.png` (tomar ANTES de T043) y `artifacts/visual-despues.png`; EVIDENCIA.

## Phase 6: US5 — Arquitectura que aguanta (P3)

**Goal**: módulos < 400 líneas por fase sin cambiar comportamiento.
**Independent Test**: `npm run lab -- --replicas 8 --dias 3 --seed-base 7` da métricas idénticas antes/después; suite verde.

- [ ] T050 [US5] Guardar control: barrido 8×3 días con `--seed-base 7` en `artifacts/lab/control-refactor-antes/`.
- [ ] T051 [P] [US5] Partir `src/world/index.ts` en `src/world/paso/{percepcion,decision,accion,materia,registro}.ts` + `paso/index.ts` (orquestador); `index.ts` queda como fachada que re-exporta.
- [ ] T052 [P] [US5] Partir `src/client/landscape.ts` en `src/client/paisaje/{terreno,agua,vegetacion,habitantes,luz,calor}.ts` + `paisaje/index.ts`.
- [ ] T053 [US5] Barrido de control después y `diff` de métricas contra T050 → idénticas; `npm run check` verde (depende de T051, T052).

## Phase 7: Cierre y publicación

- [ ] T060 Barrido largo 16×25 días con los defaults finales (en segundo plano mientras se cierra el resto); EVIDENCIA con SC-001..008 medidos.
- [ ] T061 `npm run check`; actualizar `docs/REGLAS.md` (parámetros y defaults) y `README.md` (sección Laboratorio); `PLAN.md` estado 2026-09-19.
- [ ] T062 Merge `001-mundo-solido-masivo` → `main`, push; `npm run build`; relanzar el servidor público (ventana 0 del tmux `atlas`: Ctrl-C, Enter) y verificar `https://atlas.humanizar.tech` en escritorio y móvil.

## Dependencies
Setup → US1 → (US2 ∥ parcialmente US3) → US4 → US5 → Cierre. Dentro de cada fase, las tareas `[P]` van en paralelo (subagentes, ficheros disjuntos); las demás en orden.

## Parallel Example (US1)
```
Subagente A: T010 scripts/lab/replica.ts
Subagente B: T011 scripts/lab/barrido.ts
Subagente C: T012 scripts/lab/resumen.ts
→ luego T013 (tests) y T014 (línea base, corre en segundo plano ~10 min mientras arranca US2/T020+T022 en paralelo)
```
