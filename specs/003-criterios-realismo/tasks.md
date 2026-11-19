# Tasks: criterios de realismo C9–C24

**Input**: [spec](spec.md), [plan](plan.md), [modelo](data-model.md), [contratos](contracts/README.md), [canon](../../docs/CRITERIOS-REALISMO.md).

Estado vivo: **T001–T003 cerradas documentalmente; T004–T006/G1 cerradas técnicamente sobre v9c; T007–T021/T026 pendientes; T022–T025 cerradas sólo documentalmente**. Fuente R1 congelada y hashes originales conservados fuera de este árbol; este tasks es una actualización posterior atribuida al integrador principal Sol 6.1 high. R1 entrega diseño, no ejecuta estas tareas ni cierra aceptación. Modelo asignado para todas: **Sol, esfuerzo alto**; cuenta secundaria para autores R2 y cuenta principal para revisión independiente según coordinación. No asumir otro modelo disponible ni hacer fallback. `[P]` indica archivos disjuntos después de dependencias, no autorización de ejecución durante R1. Root conserva tareas/coordinación; autores no marcan tareas ajenas.

## Fase1 — Setup / revisión vinculante

- [x] T001 [US1] Revisor independiente Sol high: identificar hashes de `docs/CRITERIOS-REALISMO.md` y `specs/003-criterios-realismo/contracts/*`, cotejar56 diseños y escribir dictamen sólo en `specs/003-criterios-realismo/checklists/revision-independiente.md` (un escritor); no aprobar R1 por auto-chequeo.
- [x] T002 [US1] R1 Sol high, tras T001: resolver hallazgos sólo en `docs/CRITERIOS-REALISMO.md` y documentos/contratos de esta feature, sin editar checklist del revisor; root registra G0 y sella perfil antes de R2.
- [x] T003 [US1] Root Sol high, tras G0: reservar archivos de R2 y registrar autor por archivo en `specs/003-criterios-realismo/ownership-r2.md`; confirmar proveedor/cuenta/modelo sin cambios de cuenta ocultos.

## Fase2 — Foundation compartida (bloquea R2)

- [x] T004 [US2] Integrador Sol high: crear tipos/validación en `scripts/lab/realismo-contract.ts`; `contractVersion=realismo-v3`, ticks/seq/saldos enteros seguros, números finitos, IDs únicos por run/epoch/stream, `quality=COMPLETE|PARTIAL|INVALID|UNAVAILABLE`, tiempo apertura excluida/cierre incluido; ausencia de familia debe declarar capability unavailable.
- [x] T005 [US3] Integrador Sol high, secuencial T004: crear `tests/realismo-contract.test.ts` con inputs manuales de versión errónea, NaN/Infinity/overflow y duplicatekeys desde parser estricto; quanta fraccional/unsafe,22caps mismafamily, recordId y (epochId,streamId,seq) repetidos, COMPLETE9..3/expected1observed99/fields vacíos,16C9; casos g1-cases.v3 de bundle kind/schema/ref/run/época/rol/inputObservationRef y hashes; transferID duplicado, tiempos asincrónicos, cierre sin apertura y desconocido explícito; no importar el motor ni usar evaluador como oráculo.
- [x] T006 Integrador Sol high, tras T005: gate G1 en worktree `npm run typecheck` y `npm test`; guardar comandos, SHA/hash/logs en `specs/003-criterios-realismo/validation-r2.md`, único escritor integrador; ninguna prueba omitida se convierte en PASS.

## Recepción G1 final y alcance G2 — 2026-10-04

ROOT-G1-GO técnico recibido sobre v9c: peer independiente GO, focal111/111 y RED manual, suite completa v9c-a2 typecheck+1733PASS/0FAIL/9SKIP nativos, exit0, auditoría CPU completa. La primera fullsuite v9c falló en preflight y queda separada. `validation-r2.md` y el snapshot externo G1 aceptado identifican los siete pins y el inventario497 pre/mid/post. T006 está cerrada sólo como puerta técnica; C9–C24 y aceptación personal siguen abiertos.

G2 autorizado según `ORDENES-G2-G3-v2.md` y `SCOPE-OBSERVABILIDAD-COMPLETA-v2.md`: un escritor observer principal para los15src exactos, replay y lab/tests. Sus seis ajustes obligatorios son C20 short-circuit real, historial privado por intento/adopción/COMMIT, beneficio tardío y recibos anidados sin doble conteo, tres superficies pagadas omitidas, replay temporal exacto por sitio y preservación de halo/RHS. Ningún archivo de evaluator secundaria ni canon pasa al observer. El autor prepara oráculos primero y entrega READY; root organiza typecheck, pruebas y paridad sólo en launcher.

## Fase3 — US2 observación (Priority P1)

Independent test: no mutación y6×1200 comparaciones por tick a igual traza.

- [ ] T007 [P] [US2] R2 observador Sol high, tras G1: escribir oráculos manuales de cobertura/apertura/stream vacío/protegidos en `tests/realismo-observer.test.ts` y fixtures privados del test; observar cero eventos no implica fenómeno ausente si coverage falta.
- [ ] T008 [US2] R2 observador Sol high, tras T007: crear `scripts/lab/realismo-observer.ts`; emitir22 familias con payloads parciales tipados/fieldCoverage, source-order entre familias o causalUNKNOWN, accepted/rejected+gates y cobertura de oportunidades/frenos, además de capability matrix del contrato, copiar inputs readonly, sin RNG/clock/nextIdentity del mundo; declarar no disponible lo que no pueda observarse.
- [ ] T009 [US2] R2 observador Sol high, tras T008: integrar hooks readonly en `scripts/lab/instrumentos.ts`, `scripts/lab/replica.ts`, `scripts/lab/realismo-replay.ts` nuevo y los15src exactos de `ownership-r2.md`. Cubrir22familias/30kinds, gaps explícitos y los6ajustes scopev2 sin cambiar leyes, C1–C8, halo/RHS ni física.
- [ ] T010 [US2] R2 observador Sol high, tras T009: crear `tests/realismo-paridad.test.ts`; fijar seis semillas técnicas antes del run; A=base bb483260→B=off→C=on, 1200ticks y7200 comparaciones por par,14400 total. Comparar estado/archivo lógico/IDs/RNG/arrays/historia/pending/durable/gobernador/clock con allowlist exacta de transporte; oráculos dirigidos de pagos fallidos, proyecto incompleto, beneficio tardío, transferencia anidada, muerte/estate, archivo, C20 y fallos observer/rollback/clock. Ejecutar sólo por launcher.
- [ ] T011 [US2] Root/integrador Sol high: G2 después de T010, coordinar6 semillas×1200 pasos y typecheck/tests en worktree; escribir resultados sólo en `specs/003-criterios-realismo/validation-r2.md` por integrador. No6×1200 en R1.

## Fase4 — US3 evaluador offline (Priority P1)

Independent test: oráculo manual de56 diseños más límites exactos y metamorfismos; no motor.

- [ ] T012 [P] [US3] R2 evaluador Sol high, tras G1: materializar48 casos y8 controles de la revisión previa en `tests/fixtures/realismo/v3/`, ajustando al perfil sellado; inventar eventos/stock manuales, sin usar booleans resumen como prueba ni derivar expected del código; incluir provenance del diseño original y cambios justificados.
- [ ] T013 [US3] R2 evaluador Sol high, tras T012: escribir `tests/realismo-evaluator.test.ts`; límites0.1,1e−9,19/20,10%,20pp,5/8,6≠8, control0, historia<3, censura, duplicados, protección transitiva, medio commit, C23 sin recibo y C24 method≠final. Borrar evidencia necesaria/cortar ventana no puede elevar FAIL/UNKNOWN a PASS; una infracción se conserva sólo mientras su evidencia sigue válida.
- [ ] T014 [US3] R2 evaluador Sol high, tras T013: crear `scripts/lab/realismo-evaluator.ts` puro con16 criterios/subgates, referencias, cálculos por unidades/cohortes, UNKNOWN y calidad separada; no importar src/world, RNG, clock ni runner; conservar FAIL C10 sin baseline C9, verificar inventario completo/autorización individual C23 y CausalPair C11/C17 contemporáneo; esquema solo no habilita G1/G3; mismos eventos de condición/service/débito/efecto y law-inputs.sourceEventId/sourceOrderRef, SHA común, balance parcial válido+efecto a condición0.1→FAIL C10 con baseline ausente→UNKNOWN marginal, sin orden/SHA contradictorio→UNKNOWN causal. No usar outputs del evaluador como oráculo.
- [ ] T015 [US3] R2 evaluador Sol high, tras T014: crear `scripts/lab/realismo-panel.ts` con conteos sobre planeadas, gate8 provisional, C13 mediana+0/8 separado y6 descriptivas; sin cambiar agregación C1–C8.
- [ ] T016 [US3] R2 evaluador Sol high, tras T015: crear `scripts/lab/criterio-realismo.mts`, CLI de lectura/output explícito y exit codes0/2/3 del plan; datos viejos incompletos→UNKNOWN; output con SHA/perfil/input hashes, nunca aprobar carta ni entrenamiento por omisión.
- [ ] T017 [US3] Integrador Sol high: G3 después de T016, typecheck/tests en worktree y revisión adversarial del oráculo/resultados por revisor, registro en `specs/003-criterios-realismo/validation-r2.md`.

## Fase5 — Integración / línea base

- [ ] T018 Integrador Sol high, tras G2/G3: ejecutar guía `specs/003-criterios-realismo/quickstart.md` con artefactos disponibles, comprobar interfaz de observador→evaluador, no reconstruir campos faltantes del pasado; typecheck/tests tras cambios y `npm run build` sólo en worktree para G4. Registro en `specs/003-criterios-realismo/validation-r2.md`.
- [ ] T019 [US3] Root Sol high, tras G4/revisión: preregistrar6 semillas nuevas verificadas×60d y perfil/control/versiones en `specs/003-criterios-realismo/baseline-preregistration.md`; si no se puede verificar reserva, pendiente; no escoger semillas después de resultados.
- [ ] T020 [US3] Root Sol high: coordinar línea base según T019 y tabla C1–C24×6, sólo cuando ejecución esté autorizada; informe `specs/003-criterios-realismo/baseline-report.md` con límites, abortos/UNKNOWN, C1–C8 importados sin modificar evaluador, sin fingir8 ni cerrar C20 a100d.
- [ ] T021 [US1] Root/revisor Sol high: preregistrar calibración/controles pertinentes antes de candidatas en `specs/003-criterios-realismo/calibration-plan.md`, no cambiar números mirando una ley favorable; decisión sobre panel8 separada.

## Fase6 — US4 puertas y aceptación posteriores (Priority P2)

- [x] T022 [P] [US4] Autor técnico Sol high: diseñar ensayo C21 sobre copias y manifiestos en `specs/003-criterios-realismo/durability-protocol.md`; sin tocar DB/auth/sesiones/servicios públicos; ejecución en nuevo alcance coordinado.
- [x] T023 [P] [US4] Autor rendimiento Sol high: diseñar protocolo C22 en `specs/003-criterios-realismo/performance-protocol.md`, paridad igual tick+inputs distinta de capacidad host/gobernador; medir coste completo y rechazar regresión GPU; ejecución posterior.
- [x] T024 [P] [US4] Autor experiencia Sol high: preparar sólo protocolo sintético de tareas/dispositivos C23 en `specs/003-criterios-realismo/experience-protocol.md`; revisión de carta/recuerdos exclusivamente Steven, recibo explícito local sin contenido íntimo; pendiente hasta sesión real.
- [x] T025 [P] [US4] Autor método Sol high: preparar C24 method y plan training separado en `specs/003-criterios-realismo/method-protocol.md`;8 reservadas×6 brazos×60d y beneficio material/control; método no habilita entrenamiento automáticamente.
- [ ] T026 Root Sol high: consolidar decisiones y brechas en `specs/003-criterios-realismo/acceptance-status.md` tras evidencias/revisiones; no marcar meta terminada si C23/revisión personal o training final pendientes. No publica ni hace push por esta tarea.

## Dependencies & Execution Order

T001→T002/G0→T003→T004→T005→T006/G1. Luego T007 y T012 pueden correr en paralelo, cada autor sigue su cadena secuencial. T011/G2 y T017/G3 preceden T018/G4. T019→T020 y T021 requieren coordinación/preregistro. T022–T025 tienen ownership disjunto y pueden redactarse después deG0, pero no ejecutarse desde R1; aceptación T026 depende de evidencia pertinente, no de completar protocolos.

## Implementation Strategy

MVP: contrato sellado→observador con calidad+evaluador sintético→interfaz probada; luego línea base con UNKNOWN honestos. Paralelismo R2 permitido sólo tras G1 y con un escritor por archivo. Integrador escribe validation-r2; autores entregan logs por mensaje/artefactos separados, no editan ese mismo informe simultáneamente. Antes de cada commit futuro constitución exige typecheck+suite; build antes de integración/publicación se hace sólo en worktree. Esta lista no autoriza campañas, servicios o entrenamiento en la sesión R1.

Corrección R1 documental: consumir exclusivamente realismo-v3 y perfil .v3.json;22 familias estables/30 tipos evidence. FieldCoverage parcial, SourceOrder entre familias, ReproductionGates accepted/rejected+cobertura oportunidades/frenos, inventario completo y autorizaciones individuales, CausalPair con control contemporáneo son obligatorios según contracts/README y reference-types.v3.json. Los ejemplos contracts/examples son diseños wire sin ejecutar; materializar48+8 y regresiones estructurales/semánticas/parser en R2. Validación Luna v2 (3/3+27 estructurales+4 parser, según coordinación) no certifica v3; G0 segunda revisión y G1 semántico siguen pendientes.26 tareas abiertas y un escritor por archivo; este texto no autoriza implementar ni ejecutar en R1.

## Recepción de G0 — 2026-10-04

T001 se cierra por revisión independiente job fc33b542bee1494abe4d7f089f5c66e1; T002 por resolución documental de ambos bloqueos y ROOT-G0-DECISION-v3. T003 por ownership-r2.md. Se conserva el fingerprint original en R1-FROZEN-v3, sin recalcularlo para esta edición mutable. G0 es contractual; T004/T005 implementadas con focal91/91 PASS, peer v5 pendiente, mientras T006/G1 sigue pendiente de suite completa y revisión. No habilita observadores/evaluador antes de su cierre. Cuenta integrador/G1 principal según asignación explícita root, sin fallback.

T022–T025 cerradas por GO-DOC root tras revisión independiente principal job28dd85d0d95e459b8ef060c064e9d246, initial=final4hashes; autoría secundaria disjunta. Sólo protocolos escritos: no harness/ensayo ejecutado, aceptación ni training autorizado. T006/G1 abierto por peer v4 NO-GO y suite completa FAIL; correctivos v5 focal91PASS pendientes de peer y del fix independiente curva-techo.
