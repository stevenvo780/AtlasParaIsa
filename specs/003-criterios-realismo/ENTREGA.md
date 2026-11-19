# Entrega R1-v3 finalizada para peer y formal — NO-GO-R2

Misma cuenta secundaria, continuación R1-v3; sin fallback ni delegación. Se cerró la integridad pendiente tras el timeout900s de `job96bd6836a13d47daa0286bcd75d86f05`, sin reiniciar diseño ni ampliar alcance. Base de código `bb483260b2489fe62b113d620e5f56e5f3676dbc`; rama `codex/criterios-realismo-20261003`, sin commits/push. Los jobs MCP, incluido `jobd1ab…`, no son commits.

**Dos fixes del peer `job47510e03921d4091a2fac76ead47299f` revisables en estos bytes; NO-GO-R2 vigente hasta peer + formal-v3 independientes.** Interfaz `realismo-v3` congelada para ese cotejo, perfil `r1-20261003-correction3-provisional` DRAFT; sin sellado ni aceptación científica/personal.

## Fixes y archivos

| Fix | Contratos, fixtures y documentación |
|---|---|
| Mapping/identidad de bundles | contracts/{observation,evaluation,evidence}.schema.json y reference-types.v3.json: kind/schema explícitos, evidenceId/synthetic/runId/epochId/rol, run-manifest.observationRef e inputObservationRef/inputHashes. examples/crossrun-input.v3.json indexa bundle-{treatment,control}.v3.json, run-manifest-{treatment,control}.v3.json y evaluation-partial.json. negative-bundle-{kind,schema,ref-absent,run,epoch,role}.v3.json y negative-evaluation-input.v3.json conservan sus expected y hashes internos correctos. |
| Condición del mismo evento | examples/partial-observation.json, law.json, effect.json y order.json: condition-at-service-1/event-1, condición0.1, efecto0.1, flow-1, ley y orden con sourceSHA de la base. evidence.schema.json tipa sourceEventId/sourceOrderRef de law-inputs; condition-inputs-service.v3.json ensaya esa alternativa. conservation-service.v3.json conserva balance parcial1=0+1 incluyendo S. unknown-{service-order,law-sha,order-sha,service-condition-event}.v3.json y negative-condition-input-event.v3.json conservan UNKNOWN causal. |

README/data-model/canon describen ambos fixes. Se corrigió la frase obsoleta sobre manifests ausentes: **C11/C17 mantienen UNKNOWN causal** por servicios/stock/exposición aún diseñados, aunque bundles/manifests ya existan. No se intenta aprobar biología ni materializar causalidad real en R1.

El caso bueno conserva **FAIL C10.wear + UNKNOWN de medidas marginales**: baselineBenefit/baselineDelta AUSENTES. Sin orden, SHA contradictorio o condición de otro evento: **UNKNOWN causal**. La salida evaluation-partial es un oráculo manual con evaluatorSHA=not-implemented; ningún caso se presenta como ejecutado por engine.

## Pins e integridad final

[contract-fingerprints.v3.json](contract-fingerprints.v3.json) cubre **87 rutas finales**, todas existentes y con SHA256 coincidente:54 previas +30 artefactos v3 omitidos +3 archivos de entrega/verificación. Cubre toda la feature y canon salvo el propio manifiesto, excluido para evitar autorreferencia. Contiene fileCount, agregado SHA256 y algoritmo: UTF-8 `path + TAB + sha256 + LF`, ordenado por path. Se genera como última escritura; su hash externo y agregado se comunican en el informe final, sin crear un ciclo en esta entrega.

[index.v3.json](contracts/examples/index.v3.json) conserva64 entradas, añade sus64 hashes y agregado, y fija suplemento/oráculo; **35/35 expected v2 intactos**. Pins de revisión:

| Ruta desde raíz | SHA256 |
|---|---|
| docs/CRITERIOS-REALISMO.md | `9f863c563b67d488af38a5653d7c381b33f02a3c4b8148722ec82981f79624ca` |
| specs/003-criterios-realismo/contracts/observation.schema.json | `de07d954cbb8d084bd0337723a947cc7c29ed9f385571dae42b3a060b74b1628` |
| specs/003-criterios-realismo/contracts/evaluation.schema.json | `f2d4f85be8541b4ff546fc4a037d0c0536c776e34168db5fe914f10eabe59a54` |
| specs/003-criterios-realismo/contracts/evidence.schema.json | `0752c2f94b90030e1bff534b037f4f2b0de1abd5b0c6966e769638ed13d21983` |
| specs/003-criterios-realismo/contracts/thresholds.v3.json | `d99e24ee85f379164c1dd0d351a0cdb204d8bf1dda0e446abd70cfe582e4b7cb` |
| specs/003-criterios-realismo/contracts/examples/index.v3.json | `62181f84f55c51267703ba0180436f964fa9ff55b4619979fe99efae61e9b029` |
| specs/003-criterios-realismo/contracts/examples/g1-cases.v3.json | `abfdc403c29983d4cc681b514f4a8d8cd599d76f0e08581bde3d28723038be2c` |

## Comprobado y pendiente

[Detalle documental](documentary-verification.md) y [probes](documentary-probes.v3.json):72 JSON parseables,503 refs locales,196 punteros,4 negativos parser rechazados y15/15 probes documentales coincidentes con el oráculo manual. Hashes internos del evidenceIndex y del perfil conciliados. Esto no es validación formal Draft2020-12 ni ejecución semántica del futuro evaluador.

**48+8 diseños y26 tareas siguen abiertos.** Peer y formal-v3 revisarán estos pins; G1/R2 ejecutará semántica y fixtures científicos. Luna v2, según coordinación previa, validó3/3 metaschemas +27 estructurales +4 parser; esa validación no certifica v3.

Sólo ownership docs/CRITERIOS-REALISMO.md y specs/003-criterios-realismo/. source-fingerprints, checklist independiente, requirements y tasks preservados. Sin cambios a src/scripts/tests/package/lock/node_modules/main/config, instalación/build/suites/campañas, evaluador, commits/push ni reportes fuera de cwd. Luna copiará esta entrega.
