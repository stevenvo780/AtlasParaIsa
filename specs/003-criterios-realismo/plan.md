# Implementation Plan: criterios de realismo C9–C24

**Branch**: `codex/criterios-realismo-20261003` | **Date**:2026-10-03 | **Spec**:[spec.md](spec.md)

## Summary

R1 entrega el contrato canónico y diseño de intercambio observador→evaluador→informe. R2 futuro observa sin modificar física y evalúa offline; las pruebas independientes preceden datos candidatos. No implementar leyes faltantes para conseguir PASS. El diseño representa capacidades ausentes como UNKNOWN y entrega brechas para otro frente.

## Technical Context

**Language/Version**: futuro TypeScript estricto/Node22, sin librerías nuevas; JSON Schema draft2020-12 como artefacto documental.

**Primary Dependencies**: herramientas existentes del proyecto; no npm install. No se presupone que exista un validador de schema instalado: R2 usará validación equivalente explícita en TypeScript si falta.

**Storage**: archivos JSON de observación/resultados y manifiestos locales; ninguna migración SQLite, acceso a bases públicas o cambio de sesiones. Ledger externo append-only por época; derivación determinista offline.

**Testing**: futuros tests sintéticos `tsx --test`, paridad por tick, typecheck y suite; no ejecutados en R1.

**Target Platform / Project Type**: CLI de laboratorio offline en worktree, observador desacoplado del mundo; C21–C24 reciben evidencia de ensayos aislados posteriores.

**Performance Goals**: observación no modifica digestos ni decisiones; medir su CPU/RAM/E/S y latencia sin prometer overhead sin datos. C22 usa presupuestos heredados y compara coste completo.

**Constraints**: C1–C8 congelados; sin reloj/RNG ocultos, escritura de física, LLM por tick, rescates ni nuevas dependencias. No seleccionar umbrales después de candidatas.

**Scale/Scope**:16 criterios; línea base6×60d, paridad6×1200; panel8 candidato aparte; C20 requiere100d; método/entrenamiento separados. R1 es sólo documentos.

## Constitution Check

Antes y después del diseño:

| Principio | Cumplimiento documental / gate futuro |
|---|---|
| I autoridad/determinismo | streams externos, entradas del gobernador explícitas, paridad por tick y balance con frontera; ensayo pendiente |
| II evidencia | cada perfil tiene origen/control/calibración; oráculo sintético independiente y preregistro antes de datos |
| III composición | no añade física ni instituciones para completar medida; ausencias son brechas |
| IV muerte | cohortes fundadoras/nacidos y censura, historia individual, sin premio a nuevas causas |
| V rendimiento | coste integral, CPU/GPU/hilos/cámaras con equivalencia y carga declaradas; presupuesto heredado |
| VI carta | recibo personal de Steven obligatorio, teléfono real, sólo sintéticos en diseño |
| Gobernanza | sin commits/integración/publicación en R1; typecheck+tests antes de commits futuros y build antes de integración/publicación coordinada |

Diseño conforme al alcance documental; ninguna prueba de conformidad del producto se declara ejecutada.

## Project Structure

```text
docs/CRITERIOS-REALISMO.md                     # canon de medidas, R1
specs/003-criterios-realismo/
  spec.md plan.md tasks.md research.md data-model.md quickstart.md
  checklists/requirements.md                  # auto-chequeo de calidad de R1
  checklists/revision-independiente.md        # sólo revisor independiente
  contracts/README.md
  contracts/thresholds.v3.json
  contracts/observation.schema.json
  contracts/evaluation.schema.json
  contracts/evidence.schema.json
  contracts/example-unavailable.v3.json
  contracts/reference-types.v3.json
  contracts/examples/index.v3.json             # wire/documental: no ejecución48+8
scripts/lab/realismo-contract.ts              # FUTURO: integrador tipos/validador
scripts/lab/realismo-observer.ts              # FUTURO: R2 observador
scripts/lab/instrumentos.ts                   # FUTURO: R2 observador, único escritor
scripts/lab/replica.ts                        # FUTURO: R2 observador, único escritor
scripts/lab/realismo-evaluator.ts             # FUTURO: R2 evaluador puro
scripts/lab/criterio-realismo.mts              # FUTURO: R2 evaluador CLI lector
scripts/lab/realismo-panel.ts                 # FUTURO: R2 evaluador agregación
 tests/realismo-contract.test.ts              # FUTURO: integrador
 tests/realismo-observer.test.ts              # FUTURO: observador
 tests/realismo-paridad.test.ts               # FUTURO: observador
 tests/realismo-evaluator.test.ts             # FUTURO: evaluador
 tests/fixtures/realismo/v3/                  # FUTURO: evaluador, oráculo manual
```

Las rutas futuras son reserva de ownership, no archivos creados en R1. Si colisionan con trabajo ajeno, root acuerda nueva ruta antes de editar; nunca sobrescribir. No src/, package.json, cartas, configs ni servicios en esta implementación observacional. La sonda A/ciclo-material, si root la proporciona identificada, se adapta por interfaz y conserva su procedencia; no asumir que está en este HEAD ni buscar otros worktrees.

## Fase0: contrato y revisión

R1: documentar fuentes/decisiones; schema y profile versionados; cotejar56 diseños. Sol independiente revisa una versión por hash de los archivos (no sólo HEAD, porque R1 sin commit). Gate G0 exige dictamen independiente y resolución de observaciones, no autoaprobación. No se crean ramas/worktrees adicionales aquí.

## Fase1: interfaz compartida

Un integrador único crea `realismo-contract.ts` y su test desde schema. Se fija `realismo-v3`, unidades, tipos/refIDs, campos condicionales por familia, validación de safe integer/finite y replay de fronteras. Observador y evaluador consumen esos tipos sin editar su archivo. Para ampliación compatible, nuevo minor explícito/revisión; cambio de fórmula/frontera/semántica exige nueva versión mayor/perfil y no reetiquetar datos viejos.

## Fase2: dos frentes R2 separables

**Observador:** interfaz conceptual `observe(previousReadonly, nextReadonly, confirmedEventsReadonly, declaredInputs, epoch) → observationRecords + coverage`; copia datos necesarios, no conserva referencias mutables ni altera orden del motor. Hooks sólo en runner/lab existentes tras frontera de tick confirmado; apertura0 y cierre diario exactos. Sin eventos disponibles: capability unavailable, no los deduce de delta agregado si varios flujos pueden explicarlo. IDs de observación provienen de `(runId,epoch,stream,seq)` externos, nunca consume nextIdentity/rng. Costes de tiempo real se miden fuera del núcleo y nunca realimentan gobernador sin traza equivalente.

**Evaluador:** `evaluate(validatedBundle, sealedThresholdProfile, requestedStage) → evaluation`; lee sólo archivos declarados, sin importar src/world ni lanzar runner. Recalcula medidas desde eventos/stock, valida cobertura y referencias, filtros protegidos y parejas; no acepta `meetsThreshold=true` como evidencia. Produce todas las16 salidas y paneles separados, también para legacy incompleto. CLI futura: `--input <manifest.json> --profile <thresholds.v3.json> --stage method|training|final --output <file>`; exit0 si evaluación válida,2 si entradas/formato inválidos,3 si versión/perfil no soportados; PASS/FAIL del fenómeno van en JSON, no código de proceso. Escritura sólo al output explícito.

**Integrador:** conecta sólo después de tests sintéticos. Gates por fase `npm run typecheck` y `npm test` en el worktree; paridad G2 ≥6×1200 por tick con mismo input trace, informe costo/primera diferencia y cero mutaciones. Bajo gobernador host real, runner no puede confundir medir overhead con ley distinta; registrar/reproducir entradas iguales para gate. No repetir suites verdes salvo cambios o problemas nuevos. Build `npm run build` en worktree en G4 antes de integración; no habilita publicación.

## Fase3: calibración, línea base y otras puertas

Preregistrar SHA/profile hash,6 semillas nuevas verificadas,60d, params, límites/cupo/gobernador, archivo/cobertura/costes e intervenciones; root coordina ejecución tras revisión. Tabla24×6 importa C1–C8 congelados. Todos UNKNOWN y abortados visibles. Calibración de candidatos con controles conocidos pertinentes antes de candidatas, sin buscar números que aprueben una ley. Panel8 futuro sólo si root lo preregistra. C21 fallos en copias, C22 benchmark, C23 revisión personal y C24 entrenamiento son entregas posteriores independientes, no se simulan en línea base.

## Complexity Tracking

| Restricción de workflow | Decisión para este alcance | Alternativa descartada |
|---|---|---|
| Skill specify persiste `.specify/feature.json`; scripts setup pueden escribir fuera de ownership | Resolver explícitamente `SPECIFY_FEATURE=003-criterios-realismo`, `SPECIFY_FEATURE_DIRECTORY=specs/003-criterios-realismo`; generación manual desde templates, sin persistir estado global | Editar `.specify/` excedería ownership y haría otra feature activa |
| Skill plan propone agentes de investigación | Investigación documental acotada por el autor, según prohibición explícita de delegar del usuario | Delegar violaría asignación y repetiría búsquedas canceladas |

No excepción a leyes/constitución. Templates y skills se usan como estructura; no se lanza implement ni hooks de cambio de rama. `.specify/extensions.yml` no presente al chequeo; sin hooks que despachar. Gates científicos/personales pendientes no impiden diseñar UNKNOWN; impiden cerrar aceptación.

Corrección R1 documental: consumir exclusivamente realismo-v3 y perfil .v3.json;22 familias estables/30 tipos evidence. FieldCoverage parcial, SourceOrder entre familias, ReproductionGates accepted/rejected+cobertura oportunidades/frenos, inventario completo y autorizaciones individuales, CausalPair con control contemporáneo son obligatorios según contracts/README y reference-types.v3.json. Los ejemplos contracts/examples son diseños wire sin ejecutar; materializar48+8 y regresiones estructurales/semánticas/parser en R2. Validación Luna v2 (3/3+27 estructurales+4 parser, según coordinación) no certifica v3; G0 segunda revisión y G1 semántico siguen pendientes.26 tareas abiertas y un escritor por archivo; este texto no autoriza implementar ni ejecutar en R1.


## Delta G1 cerrado y G2/G3 autorizado — 2026-10-04

ROOT-G1-GO técnico v9c cierra T004–T006 con peer independiente, focal111/111 y suite final typecheck+1733PASS/0FAIL/9SKIP (1742 total), sin C9–C24 PASS. El primer intento completo v9c falló en preflight y no sustituye la suite final. Ver `validation-r2.md` y snapshot privado G1 aceptado; R1-FROZEN-v3 sigue inmutable.

El observador ya no se limita al runner: scope aprobado `SCOPE-OBSERVABILIDAD-COMPLETA-v2.md` SHA `a59a8e23a697fb6df19d6b31c5665b9eee0fe7a4536053269277fe124a06c4f3`, órdenes `ORDENES-G2-G3-v2.md` SHA `00b9ba9bc83217b846c1f3d190aa66a28cd9cb94ab87d6a499afeeaf703db251`. Un único escritor observer principal recibe los 15 `src` exactos de `ownership-r2.md`, `scripts/lab/realismo-replay.ts`, observer/instrumentos/replica y dos tests. Hooks efímeros readonly en decisiones reales, default off sin carga ni cambio físico; 22 familias/30 kinds con fieldCoverage y model-gap, sin atribuir fenómenos ausentes. Seis ajustes vinculantes: short-circuit C20 sin contrafactual inventado; attemptId privado e historial adopted/discarded/restored/partial/durable separado de COMMIT; beneficio tardío y recibos anidados sin doble contar; ecology prekernel/inventos fallidos pagados/proyectos incompletos; replay exacto por sitio/ordinal/attempt/tick con scheduler/projection declarados; radios/halo/RHS intactos.

Antes de hooks se escriben oráculos manuales. El control dinámico posterior será A=base bb483260→B=off→C=on con seis semillas técnicas×1200 ticks, 7200 comparaciones por par, 14400 total, archivo lógico íntegro y allowlist exacta de metadata de transporte. El perfil de coste/volumen corto precede cualquier baseline60d; G2 necesita cobertura de superficies modeladas y revisión independiente. G3 evaluator secundaria conserva sus cinco áreas disjuntas. Ningún autor ejecuta World/typecheck/tests/build fuera del launcher; root programa cómputo y gates. C1–C8, canon/profile/schemas/wire, leyes, S/I y servicio público permanecen fuera de cambio.
