# Verificación documental final — R1 v3, dos fixes

Continuación de la misma cuenta secundaria R1-v3 tras el timeout de `job96bd6836a13d47daa0286bcd75d86f05` (900 s, sin error auth/cuota). Diagnóstico leído: `/datos/tmp-atlas-lab/orquestacion-20261003/criterios-autor/DIAGNOSTICO-TIMEOUT-R1-v3.md`. Base de código `bb483260b2489fe62b113d620e5f56e5f3676dbc`. Se conserva **NO-GO-R2** del peer `job47510e03921d4091a2fac76ead47299f` hasta peer y validación formal de estos bytes. Los identificadores de jobs no son commits.

## Los dos fixes cotejados

1. **Bundles e identidad.** Observation exige `kind=observation`, Evaluation `kind=evaluation`; el evidenceIndex asigna esos kinds a sus schemas exactos y los30 kinds evidence a evidence.schema.json, sin alias. Identidad `evidenceId/synthetic/runId/epochId/artifactRole`; run-manifest agrega época/rol y observationRef a hoja indexada. Evaluation agrega inputObservationRef y concilia identidad/perfil/inputHashes. crossrun-input.v3.json materializa dos bundles/manifests, la observación parcial y su salida manual. Negativos independientes de kind/schema, ref ausente, run/época/rol y evaluation-input conservan hashes correctos de los bytes indicados. C11/C17 siguen **UNKNOWN causal**: manifests existentes no completan los ledgers diseñados de servicios/stock/exposición.
2. **Servicio parcial del mismo evento.** partial-observation.json conserva condition-1 en wear y condition-at-service-1 en event-1/service. Servicio, condición, flow-1 y applied-effect comparten evento/tick/orden; ley y source-order usan el SHA de código indicado arriba. Efecto0.1 a condición0.1 con ley condition>0.1: oráculo manual **FAIL C10.wear**; baselineBenefit y baselineDelta AUSENTES mantienen las medidas marginales UNKNOWN. law-inputs.entries exige sourceEventId/sourceOrderRef además de tick/subject/field/value/unit; otro evento no sustituye la condición del servicio. Sin orden o con SHA de ley/orden contradictorio: **UNKNOWN causal**. El balance sintético parcial de madera incluye S y conserva1=0+1; no acredita C12 global ni autonomía.

## Verificación local acotada

Se volvió a ejecutar el probe documental preexistente `python3 /tmp/realismo_v3_probe.py`, sólo biblioteca estándar, exit0. SHA256 del scratch: `e7795d0076ee34975e16fb1a19bc89a2c15d9684f81ade7df7f9f204edae39a8`. [documentary-probes.v3.json](documentary-probes.v3.json) conserva inputs/pins/resultados y [g1-cases.v3.json](contracts/examples/g1-cases.v3.json) el oráculo manual. **15/15 coincidencias documentales**; no son ejecución de fixtures por motor/evaluador, aceptación G1 ni validación formal Draft2020-12.

- 72 JSON parseables con parser estricto;4 entradas negativas parser rechazadas (duplicatekeys/NaN/Infinity/overflow).
- 503 `$ref` locales y196 schemaPointers resolubles;22 familias,30 evidenceKinds,16 perfiles.
- 64 entradas existentes de index.v3.json, cada una con SHA256 de bytes;35 expected heredados de index.v2 idénticos. El índice también fija hashes del suplemento48+8 y del oráculo manual; no cambia expected para ajustar resultados.
- Todos los hashes de los evidenceIndex locales coinciden, incluidos los negativos de binding; thresholdProfileHash coincide con thresholds.v3.json. En partial-observation el mismo evento respalda la condición, débito y efecto, sin baseline.
- 48+8 **diseños sin ejecutar** y26 tareas `[ ]` permanecen abiertos. G1/R2 deberá ejecutar la semántica y completar fixtures científicos; la causalidad real C11/C17 no se añade como nuevo bloqueante de autoría R1.

## Congelación e integridad

Interfaz v3 congelada **para revisión**, perfil DRAFT/provisional; sin sellado, preregistro aplicado ni aprobación R2. [contract-fingerprints.v3.json](contract-fingerprints.v3.json) se recalcula como última escritura sobre los bytes finales: **87 rutas** (54 previas +30 artefactos v3 antes omitidos +ENTREGA/documentary-verification/documentary-probes). Incluye canon, tres schemas, índice, todos los fixtures/parser/oráculos/perfiles/tablas y toda la feature salvo el propio manifiesto. Ese único archivo se excluye de su lista para evitar autorreferencia; su hash externo se comunica en el informe final.

El agregado es SHA256 de las líneas UTF-8 `path + TAB + sha256 + LF`, ordenadas por path. La comprobación final exige conjunto exacto sin omisiones/duplicados,87/87 rutas existentes,87/87 hashes coincidentes y agregado coincidente. No se vuelve a editar un archivo después de generar el manifiesto.

Ownership: docs/CRITERIOS-REALISMO.md y specs/003-criterios-realismo/. requirements/revision-independiente/source-fingerprints y tasks preservados. No src/scripts/tests/package/lock/node_modules/main/config, instalaciones, suites/build/campañas, evaluador, commits/push, cuentas fallback ni delegaciones. ENTREGA permanece en cwd para que Luna la copie; no se escribe ningún informe externo.
