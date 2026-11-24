# Inventario mecánico: huella del determinismo y código sin uso en ejecución

Worktree: `/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/v24-base` (rama sprint/v24-base). Solo lectura. Sin opinión: son conteos y clasificación.

## Método y advertencias
- Parte A: grep de las palabras de la consigna sobre src/, tests/, scripts/, docs/, specs/, .specify/, README.md, GOAL.md, PLAN.md, AGENTS.md, CLAUDE.md. Coincidencias = líneas que contienen alguna de las palabras (no ocurrencias).
- Las clases **PRUEBA SOLO DE PARIDAD (candidata)** salen de heurística: nombre del fichero (parity, paridad, digest, digesto, identidad, numeric, exact, perf, hotpath) y densidad de palabras clave frente a aserciones. **No se ha leído línea a línea.** Las **PRUEBA MIXTA** son el valor por defecto de cualquier prueba no marcada por la heurística (no es una lectura).
- En `src/`, la clase CÓDIGO DE EJECUCIÓN se asignó solo a `digesto.ts`, `exact-json.ts` y `halo.ts` por nombre; el resto de src es CÓDIGO QUE LO USA DE PASO por defecto (no leído).
- `docs/` contiene también scripts .py/.sh/.mjs de evidencia; se cuentan como DOCUMENTO / EVIDENCIA por la ruta.
- Parte B: importaciones por nombre de fichero (`/<nombre>` seguido de comillas) en src/, tests/ y scripts/.

## Parte A. Huella del determinismo (todos los ficheros con coincidencias)

| Coincidencias | Líneas | Clase | Fichero |
|---:|---:|---|---|
| 28 | 776 | CÓDIGO DE EJECUCIÓN (determinismo/verificación) | `src/world/halo.ts` |
| 13 | 335 | CÓDIGO DE EJECUCIÓN (determinismo/verificación) | `src/world/digesto.ts` |
| 3 | 124 | CÓDIGO DE EJECUCIÓN (determinismo/verificación) | `src/shared/exact-json.ts` |
| 158 | 2076 | CÓDIGO QUE LO USA DE PASO | `src/server/store.ts` |
| 68 | 496 | CÓDIGO QUE LO USA DE PASO | `src/server/snapshot-parts.ts` |
| 58 | 1031 | CÓDIGO QUE LO USA DE PASO | `src/server/technology-archive.ts` |
| 28 | 1221 | CÓDIGO QUE LO USA DE PASO | `src/world/soa/terreno.ts` |
| 27 | 844 | CÓDIGO QUE LO USA DE PASO | `src/world/gpu/puente.ts` |
| 13 | 2721 | CÓDIGO QUE LO USA DE PASO | `src/world/index.ts` |
| 10 | 320 | CÓDIGO QUE LO USA DE PASO | `src/world/lineage.ts` |
| 7 | 1018 | CÓDIGO QUE LO USA DE PASO | `src/world/society.ts` |
| 7 | 1298 | CÓDIGO QUE LO USA DE PASO | `src/world/inventions.ts` |
| 7 | 156 | CÓDIGO QUE LO USA DE PASO | `src/world/gpu/autoprueba.ts` |
| 7 | 351 | CÓDIGO QUE LO USA DE PASO | `src/world/paralelo/reduccion.ts` |
| 7 | 669 | CÓDIGO QUE LO USA DE PASO | `src/world/params.ts` |
| 7 | 831 | CÓDIGO QUE LO USA DE PASO | `src/world/paralelo/personas-motor.ts` |
| 6 | 1164 | CÓDIGO QUE LO USA DE PASO | `src/world/animals.ts` |
| 5 | 208 | CÓDIGO QUE LO USA DE PASO | `src/shared/chemistry.ts` |
| 5 | 225 | CÓDIGO QUE LO USA DE PASO | `src/world/diversidad.ts` |
| 5 | 257 | CÓDIGO QUE LO USA DE PASO | `src/server/hardware-limits.ts` |
| 4 | 1103 | CÓDIGO QUE LO USA DE PASO | `src/world/technology.ts` |
| 4 | 191 | CÓDIGO QUE LO USA DE PASO | `src/world/whispers.ts` |
| 4 | 210 | CÓDIGO QUE LO USA DE PASO | `src/world/demography.ts` |
| 4 | 762 | CÓDIGO QUE LO USA DE PASO | `src/world/gpu/politica-gpu.ts` |
| 4 | 977 | CÓDIGO QUE LO USA DE PASO | `src/world/chemistry.ts` |
| 3 | 117 | CÓDIGO QUE LO USA DE PASO | `src/world/family.ts` |
| 3 | 251 | CÓDIGO QUE LO USA DE PASO | `src/world/politica.ts` |
| 3 | 31 | CÓDIGO QUE LO USA DE PASO | `src/server/auth.ts` |
| 3 | 458 | CÓDIGO QUE LO USA DE PASO | `src/world/ecosystem-kernel.ts` |
| 3 | 69 | CÓDIGO QUE LO USA DE PASO | `src/world/genetics.ts` |
| 3 | 713 | CÓDIGO QUE LO USA DE PASO | `src/world/paralelo/fauna-motor.ts` |
| 3 | 819 | CÓDIGO QUE LO USA DE PASO | `src/client/structure-art.ts` |
| 2 | 121 | CÓDIGO QUE LO USA DE PASO | `src/world/chronicle-journal.ts` |
| 2 | 125 | CÓDIGO QUE LO USA DE PASO | `src/server/main.ts` |
| 2 | 184 | CÓDIGO QUE LO USA DE PASO | `src/client/road-geology-art.ts` |
| 2 | 212 | CÓDIGO QUE LO USA DE PASO | `src/world/agua.ts` |
| 2 | 283 | CÓDIGO QUE LO USA DE PASO | `src/world/tecnologia-complejidad.ts` |
| 2 | 374 | CÓDIGO QUE LO USA DE PASO | `src/server/governor.ts` |
| 2 | 380 | CÓDIGO QUE LO USA DE PASO | `src/world/rejilla.ts` |
| 2 | 522 | CÓDIGO QUE LO USA DE PASO | `src/server/sim-worker.ts` |
| 1 | 101 | CÓDIGO QUE LO USA DE PASO | `src/world/paralelo/guardia.ts` |
| 1 | 107 | CÓDIGO QUE LO USA DE PASO | `src/server/resumen-vivo.ts` |
| 1 | 135 | CÓDIGO QUE LO USA DE PASO | `src/world/clon.ts` |
| 1 | 170 | CÓDIGO QUE LO USA DE PASO | `src/world/material-affordances.ts` |
| 1 | 192 | CÓDIGO QUE LO USA DE PASO | `src/world/terrain.ts` |
| 1 | 235 | CÓDIGO QUE LO USA DE PASO | `src/world/ecosystem.ts` |
| 1 | 273 | CÓDIGO QUE LO USA DE PASO | `src/shared/types.ts` |
| 1 | 305 | CÓDIGO QUE LO USA DE PASO | `src/world/soa/topologia.ts` |
| 1 | 3130 | CÓDIGO QUE LO USA DE PASO | `src/client/landscape.ts` |
| 1 | 364 | CÓDIGO QUE LO USA DE PASO | `src/world/spatial.ts` |
| 1 | 364 | CÓDIGO QUE LO USA DE PASO | `src/world/statistics.ts` |
| 1 | 371 | CÓDIGO QUE LO USA DE PASO | `src/server/snapshot.ts` |
| 1 | 407 | CÓDIGO QUE LO USA DE PASO | `src/world/paralelo/personas-worker.ts` |
| 1 | 443 | CÓDIGO QUE LO USA DE PASO | `src/client/soundscape.ts` |
| 1 | 445 | CÓDIGO QUE LO USA DE PASO | `src/world/paralelo/piscina.ts` |
| 1 | 484 | CÓDIGO QUE LO USA DE PASO | `src/world/paralelo/fauna-worker.ts` |
| 1 | 537 | CÓDIGO QUE LO USA DE PASO | `src/world/technology-catalogue.ts` |
| 1 | 55 | CÓDIGO QUE LO USA DE PASO | `src/world/paralelo/particion.ts` |
| 1 | 61 | CÓDIGO QUE LO USA DE PASO | `src/world/paralelo/paginas.ts` |
| 183 | 1680 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-23-retencion/publico-9000-pasos.json` |
| 132 | 586 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/tasks.md` |
| 73 | 1162 | DOCUMENTO / EVIDENCIA | `docs/REGLAS.md` |
| 52 | 529 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T171-report.md` |
| 46 | 1080 | DOCUMENTO / EVIDENCIA | `docs/EVIDENCIA.md` |
| 38 | 354 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/research.md` |
| 35 | 242 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/spec.md` |
| 35 | 292 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/plan.md` |
| 30 | 774 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-11-19/live-world-dual-gpu-30d-20261119.json` |
| 29 | 410 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T111-report.md` |
| 27 | 276 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-23-retencion/publico-1200-pasos.json` |
| 24 | 175 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-phase2-independent.json` |
| 24 | 276 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/E1-revision-diseno-2026-09-23.md` |
| 21 | 644 | DOCUMENTO / EVIDENCIA | `PLAN.md` |
| 18 | 1038 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/balance/veredicto-f21.json` |
| 18 | 272 | DOCUMENTO / EVIDENCIA | `docs/T100-LIMITES-CONTRATO.md` |
| 16 | 113 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T163-report.md` |
| 16 | 156 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T122-T125-report.md` |
| 16 | 290 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/snapshot-economia.py` |
| 15 | 127 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-23-retencion/identidad-semillas.json` |
| 14 | 193 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/quickstart.md` |
| 13 | 82 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T148-report.md` |
| 12 | 112 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-parts-benchmark.mjs` |
| 12 | 132 | DOCUMENTO / EVIDENCIA | `docs/ops/noche-20260922-bitacora.md` |
| 12 | 272 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T141-report.md` |
| 11 | 121 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T145-report.md` |
| 11 | 130 | DOCUMENTO / EVIDENCIA | `specs/001-mundo-solido-masivo/tasks.md` |
| 11 | 210 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/balance/diagnostico-economia-hacer-historico-20260927.md` |
| 11 | 258 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T113-report.md` |
| 11 | 288 | DOCUMENTO / EVIDENCIA | `docs/preregistros/2026-09-23-vocacion-banda.md` |
| 10 | 103 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T133-report.md` |
| 10 | 108 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/perf-fauna-rejilla-report.md` |
| 10 | 168 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-persistence-phase3.md` |
| 10 | 237 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/sync-codex-laptop.sh` |
| 10 | 313 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T116-report.md` |
| 10 | 371 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/audit-codex-campaigns.py` |
| 10 | 387 | DOCUMENTO / EVIDENCIA | `specs/001-mundo-solido-masivo/research.md` |
| 9 | 291 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/hedge_provenance.py` |
| 9 | 397 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/diagnostico-economia-hacer.py` |
| 9 | 92 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T121-T123-T124-report.md` |
| 8 | 194 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T112-report.md` |
| 8 | 202 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T142-report.md` |
| 8 | 2335 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/store.json` |
| 8 | 261 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/launch-codex-campaigns-executed.py` |
| 8 | 279 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/launch-codex-campaigns.py` |
| 8 | 437 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/veredicto-f21.py` |
| 8 | 591 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/portable-fill-manager.py` |
| 8 | 60 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T118-report.md` |
| 8 | 68 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T132-report.md` |
| 7 | 142 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/clone-trajectory.json` |
| 7 | 212 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T114-report.md` |
| 7 | 215 | DOCUMENTO / EVIDENCIA | `docs/REVISION-NOCHE-2026-09-22.md` |
| 7 | 44 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-11-19/publication-v14-r2.json` |
| 6 | 108 | DOCUMENTO / EVIDENCIA | `docs/preregistros/2026-11-18-estabilidad-tecnologia.md` |
| 6 | 124 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T166-report.md` |
| 6 | 154 | DOCUMENTO / EVIDENCIA | `specs/001-mundo-solido-masivo/spec.md` |
| 6 | 168 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-limits-integration-gates.json` |
| 6 | 194 | DOCUMENTO / EVIDENCIA | `docs/historial/fase12-vida-servidor.js` |
| 6 | 222 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/E0W2B-report.md` |
| 6 | 257 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/clone-aged-final.json` |
| 6 | 257 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/clone-aged-initial.json` |
| 6 | 258 | DOCUMENTO / EVIDENCIA | `docs/CONSTRUCCION.md` |
| 6 | 269 | DOCUMENTO / EVIDENCIA | `README.md` |
| 6 | 452 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/prepare-c8-decision-input.py` |
| 6 | 66 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T147-report.md` |
| 6 | 73 | DOCUMENTO / EVIDENCIA | `docs/REVISION-INTEGRACION-A0-2026-09-22.md` |
| 6 | 89 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/README.md` |
| 6 | 91 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T102-report.md` |
| 6 | 95 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/family-v8-13d-checkpoints.json` |
| 5 | 110 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T146-report.md` |
| 5 | 171 | DOCUMENTO / EVIDENCIA | `docs/CIENCIA.md` |
| 5 | 182 | DOCUMENTO / EVIDENCIA | `docs/REVISION-CONTENCION-V9-2026-09-22.md` |
| 5 | 243 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/E0W2A-report.md` |
| 5 | 252 | DOCUMENTO / EVIDENCIA | `docs/REVISION-2026-09-22.md` |
| 5 | 332 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-phase3-parity-independent.json` |
| 5 | 341 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T143-report.md` |
| 5 | 359 | DOCUMENTO / EVIDENCIA | `docs/DISENO-V19.md` |
| 5 | 421 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/verificar-ctrlv4b.py` |
| 5 | 42 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-11-19/publication-v14-r3.json` |
| 5 | 53 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-11-19/publication-v15.json` |
| 5 | 5526 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/compute-live.json` |
| 5 | 643 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/tower-fill-manager.py` |
| 5 | 997 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/compute-final-guard.json` |
| 4 | 190 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/resumen-economia-ctrlv4-40.py` |
| 4 | 35 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T153-report.md` |
| 4 | 38 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-snapshot-order.md` |
| 4 | 53 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-limits-legacy-mode.md` |
| 4 | 72 | DOCUMENTO / EVIDENCIA | `docs/REVISION-LIMITES-PERSISTIDOS-2026-09-22.md` |
| 4 | 74 | DOCUMENTO / EVIDENCIA | `docs/historial/fase4-revision-diff.js` |
| 4 | 82 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-persistence-phase2.md` |
| 4 | 83 | DOCUMENTO / EVIDENCIA | `docs/REVISION-PERSISTENCIA-PAGINADA-2026-09-22.md` |
| 4 | 97 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T161-T164-report.md` |
| 3 | 111 | DOCUMENTO / EVIDENCIA | `specs/001-mundo-solido-masivo/plan.md` |
| 3 | 112 | DOCUMENTO / EVIDENCIA | `docs/preregistros/2026-09-23-c8-linaje-hogar.md` |
| 3 | 153 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/E0W2C-report.md` |
| 3 | 167 | DOCUMENTO / EVIDENCIA | `docs/EXPERIENCIA.md` |
| 3 | 26 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T172-report.md` |
| 3 | 277 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/a0-v7-parity.json` |
| 3 | 277 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/integration-parity.json` |
| 3 | 282 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/integration-v9-parity.json` |
| 3 | 287 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-phase3-parity.json` |
| 3 | 303 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-limits-integration-parity.json` |
| 3 | 376 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-parts-profile-before.json` |
| 3 | 409 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/calibracion-v4-ctrlv4.mts` |
| 3 | 424 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-parts-initial.json` |
| 3 | 45 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-11-22/publication-v18.json` |
| 3 | 46 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/integration-v9-gates.json` |
| 3 | 520 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-parts-fastpath.json` |
| 3 | 520 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-parts-final.json` |
| 3 | 62 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-11-23/publication-v18-r2.json` |
| 3 | 75 | DOCUMENTO / EVIDENCIA | `docs/REVISION-2026-09-19.md` |
| 2 | 107 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T151-report.md` |
| 2 | 111 | DOCUMENTO / EVIDENCIA | `docs/ESTADO.md` |
| 2 | 1215 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-23-retencion/perfil-carga-sin-podar.json` |
| 2 | 121 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T136-report.md` |
| 2 | 131 | DOCUMENTO / EVIDENCIA | `docs/preregistros/2026-09-23-natalidad-local.md` |
| 2 | 13 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/digest-scale-new.json` |
| 2 | 13 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/digest-scale-old.json` |
| 2 | 143 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T144-report.md` |
| 2 | 206 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t102-params-baseline.json` |
| 2 | 35 | DOCUMENTO / EVIDENCIA | `.specify/memory/constitution.md` |
| 2 | 38 | DOCUMENTO / EVIDENCIA | `docs/REVISION-INTEGRACION-V9-2026-09-22.md` |
| 2 | 39 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-11-19/publication-v15-r3.json` |
| 2 | 41 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-11-22/publication-v16.json` |
| 2 | 42 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-24/publication-v11.json` |
| 2 | 43 | DOCUMENTO / EVIDENCIA | `docs/REVISION-CLON-ENVEJECIDO-2026-09-22.md` |
| 2 | 52 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-limits-4a.md` |
| 2 | 52 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-recovery-boundary.md` |
| 2 | 54 | DOCUMENTO / EVIDENCIA | `docs/PLAN-ESTABILIDAD-2026-11-18.md` |
| 2 | 591 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-23-retencion/perfil-carga-podada.json` |
| 2 | 59 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T165-report.md` |
| 2 | 66 | DOCUMENTO / EVIDENCIA | `docs/REVISION-SEMILLA-PUBLICA-25D-2026-09-22.md` |
| 2 | 72 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-23/publication-v10-pub2.json` |
| 2 | 92 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-phase3-gates.json` |
| 1 | 102 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-11-19/gpu-burn-28m-5000ticks-20261119.json` |
| 1 | 119 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/verificar-hog-2010.py` |
| 1 | 13 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/a0-v7-tests.json` |
| 1 | 158 | DOCUMENTO / EVIDENCIA | `docs/REVISION-FAMILIA-V8-2026-09-22.md` |
| 1 | 16 | DOCUMENTO / EVIDENCIA | `AGENTS.md` |
| 1 | 16 | DOCUMENTO / EVIDENCIA | `CLAUDE.md` |
| 1 | 173 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/comparar-snapshots-economia.py` |
| 1 | 18 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/clone.json` |
| 1 | 190 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/verificar-solapes-relanzadas.py` |
| 1 | 20 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-limits-own-properties.md` |
| 1 | 256 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/verificar-ctrlv4c.py` |
| 1 | 284 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/verificar-ctrlv4e.py` |
| 1 | 287 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/verificar-ctrlv4f.py` |
| 1 | 298 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/scripts/analysis/verificar-ctrlv4d.py` |
| 1 | 352 | DOCUMENTO / EVIDENCIA | `docs/ANALISIS-DINAMICAS-2026-09-21.md` |
| 1 | 37 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/balance/diagnostico-economia-hacer.md` |
| 1 | 38 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-23/publication-v10-portatil-hotfix.json` |
| 1 | 38 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-23/publication-v10-portatil-perf3-e0.json` |
| 1 | 38 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-28/publication-v12.json` |
| 1 | 39 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-required-finite-benchmark.mjs` |
| 1 | 40 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/balance/veredicto-f21.md` |
| 1 | 41 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/integration-a0-gates.json` |
| 1 | 45 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-11-22/publication-v17.json` |
| 1 | 49 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-required-finite.md` |
| 1 | 54 | DOCUMENTO / EVIDENCIA | `docs/REVISION-CONTENCION-V9-RESULTADOS-2026-09-22.md` |
| 1 | 58 | DOCUMENTO / EVIDENCIA | `GOAL.md` |
| 1 | 629 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-11-19/panel-fase-b-20261119.json` |
| 1 | 75 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/t100-snapshot-benchmark.mjs` |
| 1 | 78 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/default25-app-control.json` |
| 1 | 844 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-22/mortal-activity/results.json` |
| 1 | 967 | DOCUMENTO / EVIDENCIA | `docs/evidencia-2026-09-26/balance/resumen-economia-ctrlv4-40.json` |
| 1 | 97 | DOCUMENTO / EVIDENCIA | `specs/002-mundo-ilimitado/informes/T108-report.md` |
| 106 | 784 | PRUEBA MIXTA | `tests/snapshot-parts.test.ts` |
| 54 | 446 | PRUEBA MIXTA | `tests/lab-resumen.test.ts` |
| 43 | 321 | PRUEBA MIXTA | `tests/store-replay.test.ts` |
| 42 | 545 | PRUEBA MIXTA | `tests/restauracion-paso.test.ts` |
| 36 | 353 | PRUEBA MIXTA | `tests/v18-dirty-snapshot-pages.test.ts` |
| 31 | 927 | PRUEBA MIXTA | `tests/halo-radios.test.ts` |
| 29 | 390 | PRUEBA MIXTA | `tests/technology-retention.test.ts` |
| 23 | 539 | PRUEBA MIXTA | `tests/v18-w2-inventions-ckpt-perf.test.ts` |
| 22 | 209 | PRUEBA MIXTA | `tests/auditoria-reglas-motor.test.ts` |
| 21 | 168 | PRUEBA MIXTA | `tests/desalojo.test.ts` |
| 20 | 348 | PRUEBA MIXTA | `tests/demography.test.ts` |
| 19 | 302 | PRUEBA MIXTA | `tests/v18-w2-stats-soa.test.ts` |
| 19 | 434 | PRUEBA MIXTA | `tests/v18-tech-fauna-perf.test.ts` |
| 19 | 476 | PRUEBA MIXTA | `tests/store-technology.test.ts` |
| 17 | 389 | PRUEBA MIXTA | `tests/technology-archive.test.ts` |
| 16 | 223 | PRUEBA MIXTA | `tests/params.test.ts` |
| 16 | 299 | PRUEBA MIXTA | `tests/determinismo-hardware.test.ts` |
| 15 | 179 | PRUEBA MIXTA | `tests/snapshot-required-finite.test.ts` |
| 15 | 237 | PRUEBA MIXTA | `tests/limites-anticorrupcion.test.ts` |
| 15 | 250 | PRUEBA MIXTA | `tests/v12-full-hardware-evolution.test.ts` |
| 15 | 323 | PRUEBA MIXTA | `tests/leyes-candidatas.test.ts` |
| 15 | 332 | PRUEBA MIXTA | `tests/politica-evolutiva.test.ts` |
| 15 | 458 | PRUEBA MIXTA | `tests/v18-w2-archive-perf.test.ts` |
| 15 | 680 | PRUEBA MIXTA | `tests/v18-org-stats-perf.test.ts` |
| 15 | 719 | PRUEBA MIXTA | `tests/v18-demografia-perf.test.ts` |
| 15 | 89 | PRUEBA MIXTA | `tests/guardia-fase-b.test.ts` |
| 14 | 103 | PRUEBA MIXTA | `tests/gpu-autoprueba.test.ts` |
| 14 | 233 | PRUEBA MIXTA | `tests/agua-memoria.test.ts` |
| 14 | 449 | PRUEBA MIXTA | `tests/v18-chunk-spikes.test.ts` |
| 13 | 166 | PRUEBA MIXTA | `tests/snapshot-recovery-boundary.test.ts` |
| 13 | 198 | PRUEBA MIXTA | `tests/ley-aptitud.test.ts` |
| 13 | 231 | PRUEBA MIXTA | `tests/comunidades-vivas.test.ts` |
| 13 | 293 | PRUEBA MIXTA | `tests/com-d.test.ts` |
| 13 | 578 | PRUEBA MIXTA | `tests/estabilidad-persistencia.test.ts` |
| 12 | 141 | PRUEBA MIXTA | `tests/clon-acotado.test.ts` |
| 12 | 247 | PRUEBA MIXTA | `tests/intencion-confirmacion.test.ts` |
| 12 | 247 | PRUEBA MIXTA | `tests/lab-hardware.test.ts` |
| 12 | 253 | PRUEBA MIXTA | `tests/v22-seasonal-gpu-ecology.test.ts` |
| 12 | 273 | PRUEBA MIXTA | `tests/v19-phase1-lsfrm.test.ts` |
| 12 | 293 | PRUEBA MIXTA | `tests/hardware/matriz.ts` |
| 11 | 336 | PRUEBA MIXTA | `tests/compute-ecology.test.ts` |
| 11 | 447 | PRUEBA MIXTA | `tests/gobernador.test.ts` |
| 10 | 133 | PRUEBA MIXTA | `tests/store-chunks-tupla.test.ts` |
| 10 | 236 | PRUEBA MIXTA | `tests/limites-legacy-mode.test.ts` |
| 10 | 262 | PRUEBA MIXTA | `tests/agregados.test.ts` |
| 10 | 279 | PRUEBA MIXTA | `tests/chronicle-store.test.ts` |
| 10 | 310 | PRUEBA MIXTA | `tests/politica-gpu-residente.test.ts` |
| 10 | 437 | PRUEBA MIXTA | `tests/senescencia.test.ts` |
| 10 | 451 | PRUEBA MIXTA | `tests/v22-client-60fps.test.ts` |
| 9 | 109 | PRUEBA MIXTA | `tests/generar-escenas-perfil.test.ts` |
| 9 | 168 | PRUEBA MIXTA | `tests/reglas10-defaults.test.ts` |
| 9 | 187 | PRUEBA MIXTA | `tests/conflicto-legible.test.ts` |
| 9 | 224 | PRUEBA MIXTA | `tests/fauna-soa-fast.test.ts` |
| 9 | 226 | PRUEBA MIXTA | `tests/perf-personas-core-parity.test.ts` |
| 9 | 243 | PRUEBA MIXTA | `tests/soa-terreno.test.ts` |
| 9 | 334 | PRUEBA MIXTA | `tests/technology-archive-catalogue.test.ts` |
| 9 | 360 | PRUEBA MIXTA | `tests/curva-techo.test.ts` |
| 9 | 412 | PRUEBA MIXTA | `tests/paralelo-ecologia.test.ts` |
| 8 | 142 | PRUEBA MIXTA | `tests/fauna-rejilla.test.ts` |
| 8 | 150 | PRUEBA MIXTA | `tests/soa-personas.test.ts` |
| 8 | 195 | PRUEBA MIXTA | `tests/personas-choose-paralelo.test.ts` |
| 8 | 213 | PRUEBA MIXTA | `tests/soa-topologia-residente.test.ts` |
| 8 | 243 | PRUEBA MIXTA | `tests/ecology-paralela.test.ts` |
| 8 | 271 | PRUEBA MIXTA | `tests/v18-sociedad-fision-estabilidad.test.ts` |
| 8 | 305 | PRUEBA MIXTA | `tests/v23-hunting-herding.test.ts` |
| 8 | 307 | PRUEBA MIXTA | `tests/instrumentos-lab.test.ts` |
| 8 | 526 | PRUEBA MIXTA | `tests/tecnologia-estabilidad.test.ts` |
| 8 | 71 | PRUEBA MIXTA | `tests/snapshot-numbers.test.ts` |
| 7 | 127 | PRUEBA MIXTA | `tests/hardware/contrato.ts` |
| 7 | 165 | PRUEBA MIXTA | `tests/lifecycle-persistence.test.ts` |
| 7 | 198 | PRUEBA MIXTA | `tests/soa-terreno-paralelo.test.ts` |
| 7 | 238 | PRUEBA MIXTA | `tests/rejilla.test.ts` |
| 7 | 262 | PRUEBA MIXTA | `tests/v18-w2-choose-fast.test.ts` |
| 7 | 458 | PRUEBA MIXTA | `tests/technology-water.test.ts` |
| 7 | 92 | PRUEBA MIXTA | `tests/gpu-reparto.test.ts` |
| 6 | 111 | PRUEBA MIXTA | `tests/fauna-hotpath-parity.test.ts` |
| 6 | 156 | PRUEBA MIXTA | `tests/fraccion-serial.test.ts` |
| 6 | 156 | PRUEBA MIXTA | `tests/v17-sociedad-fision.test.ts` |
| 6 | 213 | PRUEBA MIXTA | `tests/v19-phase1-fauna.test.ts` |
| 6 | 227 | PRUEBA MIXTA | `tests/hardware/escenas.ts` |
| 6 | 281 | PRUEBA MIXTA | `tests/v16-cultura-perf.test.ts` |
| 6 | 414 | PRUEBA MIXTA | `tests/v16-tecnologia-cualitativa.test.ts` |
| 6 | 430 | PRUEBA MIXTA | `tests/lab-barrido.test.ts` |
| 6 | 76 | PRUEBA MIXTA | `tests/v17-emergencia-largo-plazo.test.ts` |
| 5 | 120 | PRUEBA MIXTA | `tests/genetics.test.ts` |
| 5 | 124 | PRUEBA MIXTA | `tests/lab-techo.test.ts` |
| 5 | 170 | PRUEBA MIXTA | `tests/family-forage-contention.test.ts` |
| 5 | 180 | PRUEBA MIXTA | `tests/lab.test.ts` |
| 5 | 184 | PRUEBA MIXTA | `tests/gpu-puente.test.ts` |
| 5 | 193 | PRUEBA MIXTA | `tests/agua.test.ts` |
| 5 | 234 | PRUEBA MIXTA | `tests/politica-obs-fast.test.ts` |
| 5 | 454 | PRUEBA MIXTA | `tests/personas-paralelo.test.ts` |
| 5 | 48 | PRUEBA MIXTA | `tests/lib/store.ts` |
| 5 | 73 | PRUEBA MIXTA | `tests/render-legibility.test.ts` |
| 5 | 94 | PRUEBA MIXTA | `tests/backup-copy-validation.test.ts` |
| 4 | 114 | PRUEBA MIXTA | `tests/technology-store-review.test.ts` |
| 4 | 118 | PRUEBA MIXTA | `tests/perfil-fases.test.ts` |
| 4 | 186 | PRUEBA MIXTA | `tests/digesto-regiones.test.ts` |
| 4 | 231 | PRUEBA MIXTA | `tests/projection-failure.test.ts` |
| 4 | 250 | PRUEBA MIXTA | `tests/v20-roads.test.ts` |
| 4 | 292 | PRUEBA MIXTA | `tests/sc013-limite-hardware.test.ts` |
| 4 | 301 | PRUEBA MIXTA | `tests/identidades.test.ts` |
| 4 | 349 | PRUEBA MIXTA | `tests/gpu-incremental-page-sync.test.ts` |
| 4 | 42 | PRUEBA MIXTA | `tests/reglas11-defaults.test.ts` |
| 4 | 60 | PRUEBA MIXTA | `tests/rules-version.test.ts` |
| 4 | 61 | PRUEBA MIXTA | `tests/hardware/cambios.ts` |
| 4 | 85 | PRUEBA MIXTA | `tests/persona-extra.test.ts` |
| 4 | 91 | PRUEBA MIXTA | `tests/assert-world-escala.test.ts` |
| 4 | 93 | PRUEBA MIXTA | `tests/backup-lazy-archives.test.ts` |
| 3 | 106 | PRUEBA MIXTA | `tests/gobernador-senales.test.ts` |
| 3 | 108 | PRUEBA MIXTA | `tests/rules-v10.test.ts` |
| 3 | 109 | PRUEBA MIXTA | `tests/journal-caps.test.ts` |
| 3 | 137 | PRUEBA MIXTA | `tests/society-perf-parity.test.ts` |
| 3 | 166 | PRUEBA MIXTA | `tests/v16-emergencia-core.test.ts` |
| 3 | 201 | PRUEBA MIXTA | `tests/store-guardado.test.ts` |
| 3 | 215 | PRUEBA MIXTA | `tests/params-instantanea.test.ts` |
| 3 | 295 | PRUEBA MIXTA | `tests/fauna-mascara.test.ts` |
| 3 | 330 | PRUEBA MIXTA | `tests/spatial-escala.test.ts` |
| 3 | 333 | PRUEBA MIXTA | `tests/archive.test.ts` |
| 3 | 472 | PRUEBA MIXTA | `tests/v19-phase2-bt.test.ts` |
| 3 | 63 | PRUEBA MIXTA | `tests/v19-phase2-ecal.test.ts` |
| 3 | 70 | PRUEBA MIXTA | `tests/v19-phase1-fauna-fixture.ts` |
| 3 | 72 | PRUEBA MIXTA | `tests/hogar-trabajo.test.ts` |
| 2 | 140 | PRUEBA MIXTA | `tests/v18-hotpath-parity.test.ts` |
| 2 | 142 | PRUEBA MIXTA | `tests/technology-archive-load.test.ts` |
| 2 | 159 | PRUEBA MIXTA | `tests/terrain.test.ts` |
| 2 | 205 | PRUEBA MIXTA | `tests/hardware-auto-motor.test.ts` |
| 2 | 254 | PRUEBA MIXTA | `tests/natalidad-local.test.ts` |
| 2 | 271 | PRUEBA MIXTA | `tests/technology.test.ts` |
| 2 | 28 | PRUEBA MIXTA | `tests/backup-cli.test.ts` |
| 2 | 340 | PRUEBA MIXTA | `tests/survival-risk.test.ts` |
| 2 | 34 | PRUEBA MIXTA | `tests/snapshot-rules-before-pages.test.ts` |
| 2 | 356 | PRUEBA MIXTA | `tests/technology-store-catalogue.test.ts` |
| 2 | 35 | PRUEBA MIXTA | `tests/exact-json.test.ts` |
| 2 | 367 | PRUEBA MIXTA | `tests/v15-open-caps.test.ts` |
| 2 | 390 | PRUEBA MIXTA | `tests/v20-visuals.test.ts` |
| 2 | 548 | PRUEBA MIXTA | `tests/v21-tape-store.test.ts` |
| 2 | 57 | PRUEBA MIXTA | `tests/kernel-digest.test.ts` |
| 2 | 59 | PRUEBA MIXTA | `tests/lineage-numeric-identity.test.ts` |
| 2 | 606 | PRUEBA MIXTA | `tests/v18-client-smooth.test.ts` |
| 2 | 89 | PRUEBA MIXTA | `tests/resumen-vivo.test.ts` |
| 2 | 91 | PRUEBA MIXTA | `tests/v24-worldmap-whispers.test.ts` |
| 1 | 115 | PRUEBA MIXTA | `tests/v18-r3-scale-parity.test.ts` |
| 1 | 119 | PRUEBA MIXTA | `tests/muerte.test.ts` |
| 1 | 122 | PRUEBA MIXTA | `tests/v12-perf-fastpaths.test.ts` |
| 1 | 176 | PRUEBA MIXTA | `tests/cultural-chain.test.ts` |
| 1 | 181 | PRUEBA MIXTA | `tests/diversidad.test.ts` |
| 1 | 197 | PRUEBA MIXTA | `tests/v23-visuals-ui.test.ts` |
| 1 | 204 | PRUEBA MIXTA | `tests/v18-sim-worker-gateway.test.ts` |
| 1 | 211 | PRUEBA MIXTA | `tests/society.test.ts` |
| 1 | 225 | PRUEBA MIXTA | `tests/material-affordances.test.ts` |
| 1 | 235 | PRUEBA MIXTA | `tests/store-persistence.test.ts` |
| 1 | 246 | PRUEBA MIXTA | `tests/ecosystem.test.ts` |
| 1 | 255 | PRUEBA MIXTA | `tests/terrain-field.test.ts` |
| 1 | 30 | PRUEBA MIXTA | `tests/lib/agua.ts` |
| 1 | 319 | PRUEBA MIXTA | `tests/inventions.test.ts` |
| 1 | 323 | PRUEBA MIXTA | `tests/lineage.test.ts` |
| 1 | 323 | PRUEBA MIXTA | `tests/tecnologia-complejidad.test.ts` |
| 1 | 360 | PRUEBA MIXTA | `tests/animals.test.ts` |
| 1 | 369 | PRUEBA MIXTA | `tests/organization.test.ts` |
| 1 | 408 | PRUEBA MIXTA | `tests/v20-chemistry.test.ts` |
| 1 | 426 | PRUEBA MIXTA | `tests/fauna-paralelo.test.ts` |
| 1 | 44 | PRUEBA MIXTA | `tests/snapshot-parts-order.test.ts` |
| 1 | 690 | PRUEBA MIXTA | `tests/e2e.spec.ts` |
| 1 | 78 | PRUEBA MIXTA | `tests/instrumentos-sed.test.ts` |
| 1 | 794 | PRUEBA MIXTA | `tests/criterio-terminado.test.ts` |
| 40 | 159 | PRUEBA SOLO DE PARIDAD (candidata) | `tests/snapshot-numeric-archive.test.ts` |
| 23 | 278 | PRUEBA SOLO DE PARIDAD (candidata) | `tests/v18-store-save-perf.test.ts` |
| 21 | 204 | PRUEBA SOLO DE PARIDAD (candidata) | `tests/perf-store-save-parity.test.ts` |
| 20 | 233 | PRUEBA SOLO DE PARIDAD (candidata) | `tests/rendimiento-identidad.test.ts` |
| 14 | 65 | PRUEBA SOLO DE PARIDAD (candidata) | `tests/digesto.test.ts` |
| 9 | 140 | PRUEBA SOLO DE PARIDAD (candidata) | `tests/v17-perf-hotpath.test.ts` |
| 9 | 47 | PRUEBA SOLO DE PARIDAD (candidata) | `tests/digesto-stream.test.ts` |
| 8 | 110 | PRUEBA SOLO DE PARIDAD (candidata) | `tests/perf-pop400-tech-inventions.test.ts` |
| 7 | 115 | PRUEBA SOLO DE PARIDAD (candidata) | `tests/v22-world-hotpaths.test.ts` |
| 5 | 101 | PRUEBA SOLO DE PARIDAD (candidata) | `tests/perf-society-parity.test.ts` |
| 5 | 57 | PRUEBA SOLO DE PARIDAD (candidata) | `tests/v18-motors-perf.test.ts` |
| 46 | 666 | SCRIPT o BANCO | `scripts/lab/resumen.ts` |
| 36 | 808 | SCRIPT o BANCO | `scripts/compute-ecology-gpu-resident.py` |
| 34 | 754 | SCRIPT o BANCO | `scripts/lab/README.md` |
| 27 | 168 | SCRIPT o BANCO | `scripts/lab/rendimiento.ts` |
| 20 | 150 | SCRIPT o BANCO | `scripts/lab/t100-escala-procesos.mts` |
| 19 | 447 | SCRIPT o BANCO | `scripts/lab/replica.ts` |
| 16 | 290 | SCRIPT o BANCO | `scripts/analysis/snapshot-economia.py` |
| 14 | 222 | SCRIPT o BANCO | `scripts/perf/generar-escenas.ts` |
| 12 | 162 | SCRIPT o BANCO | `scripts/survival-audit.mts` |
| 11 | 182 | SCRIPT o BANCO | `scripts/perf/paso-servidor.ts` |
| 11 | 95 | SCRIPT o BANCO | `scripts/verify-integration-parity.ts` |
| 10 | 162 | SCRIPT o BANCO | `scripts/benchmark-simulation.ts` |
| 10 | 208 | SCRIPT o BANCO | `scripts/lab/auditar-realismo.py` |
| 10 | 237 | SCRIPT o BANCO | `scripts/analysis/sync-codex-laptop.sh` |
| 10 | 371 | SCRIPT o BANCO | `scripts/analysis/audit-codex-campaigns.py` |
| 9 | 105 | SCRIPT o BANCO | `scripts/perf/alterna.ts` |
| 9 | 111 | SCRIPT o BANCO | `scripts/perf/ventana-archivo.ts` |
| 9 | 112 | SCRIPT o BANCO | `scripts/perf/fases.ts` |
| 9 | 291 | SCRIPT o BANCO | `scripts/analysis/hedge_provenance.py` |
| 9 | 397 | SCRIPT o BANCO | `scripts/analysis/diagnostico-economia-hacer.py` |
| 8 | 103 | SCRIPT o BANCO | `scripts/perf/trayectoria-punto.ts` |
| 8 | 183 | SCRIPT o BANCO | `scripts/survival-matrix.py` |
| 8 | 210 | SCRIPT o BANCO | `scripts/compute-ecology-gpu.py` |
| 8 | 261 | SCRIPT o BANCO | `scripts/analysis/launch-codex-campaigns-executed.py` |
| 8 | 279 | SCRIPT o BANCO | `scripts/analysis/launch-codex-campaigns.py` |
| 8 | 40 | SCRIPT o BANCO | `scripts/perf/identidad.ts` |
| 8 | 437 | SCRIPT o BANCO | `scripts/analysis/veredicto-f21.py` |
| 8 | 591 | SCRIPT o BANCO | `scripts/analysis/portable-fill-manager.py` |
| 8 | 64 | SCRIPT o BANCO | `scripts/verify-clone-trajectory.mts` |
| 8 | 88 | SCRIPT o BANCO | `scripts/verify-params-baseline.ts` |
| 7 | 148 | SCRIPT o BANCO | `scripts/perf/reserva-paso.ts` |
| 7 | 398 | SCRIPT o BANCO | `scripts/lab/barrido.ts` |
| 7 | 53 | SCRIPT o BANCO | `scripts/perf/identidad-retencion.ts` |
| 7 | 54 | SCRIPT o BANCO | `scripts/perf/identidad-poda.ts` |
| 7 | 57 | SCRIPT o BANCO | `scripts/lab/digesto-control.ts` |
| 7 | 91 | SCRIPT o BANCO | `scripts/perf/retencion-publico.ts` |
| 6 | 125 | SCRIPT o BANCO | `scripts/benchmark-store.ts` |
| 6 | 159 | SCRIPT o BANCO | `scripts/lab/reproduce-cupo20-8103.mts` |
| 6 | 179 | SCRIPT o BANCO | `scripts/perf/perfil-escala.ts` |
| 6 | 338 | SCRIPT o BANCO | `scripts/banco-dual-gpu-mundo-vivo.mts` |
| 6 | 452 | SCRIPT o BANCO | `scripts/analysis/prepare-c8-decision-input.py` |
| 6 | 71 | SCRIPT o BANCO | `scripts/benchmark-clone-aged.mts` |
| 5 | 421 | SCRIPT o BANCO | `scripts/analysis/verificar-ctrlv4b.py` |
| 5 | 45 | SCRIPT o BANCO | `scripts/perf/verificar.sh` |
| 5 | 643 | SCRIPT o BANCO | `scripts/analysis/tower-fill-manager.py` |
| 4 | 163 | SCRIPT o BANCO | `scripts/perf/guardado-archivo.ts` |
| 4 | 190 | SCRIPT o BANCO | `scripts/analysis/resumen-economia-ctrlv4-40.py` |
| 4 | 44 | SCRIPT o BANCO | `scripts/perf/escalado.sh` |
| 3 | 117 | SCRIPT o BANCO | `scripts/compute-ecology-benchmark.mjs` |
| 3 | 200 | SCRIPT o BANCO | `scripts/banco-escala-extrema-gpu.mts` |
| 3 | 409 | SCRIPT o BANCO | `scripts/analysis/calibracion-v4-ctrlv4.mts` |
| 3 | 451 | SCRIPT o BANCO | `scripts/curva-techo.mts` |
| 3 | 57 | SCRIPT o BANCO | `scripts/perf/instantaneas.ts` |
| 3 | 596 | SCRIPT o BANCO | `scripts/compute-policy-gpu.py` |
| 3 | 92 | SCRIPT o BANCO | `scripts/lab/reproduce-catalogue-caps.mts` |
| 2 | 111 | SCRIPT o BANCO | `scripts/lab/v19-panel.mts` |
| 2 | 114 | SCRIPT o BANCO | `scripts/perf/contadores.py` |
| 2 | 304 | SCRIPT o BANCO | `scripts/evolution.ts` |
| 2 | 464 | SCRIPT o BANCO | `scripts/compute-ecology-core.mjs` |
| 2 | 74 | SCRIPT o BANCO | `scripts/lab/metrics.ts` |
| 2 | 99 | SCRIPT o BANCO | `scripts/bench/benchmark-render.ts` |
| 1 | 119 | SCRIPT o BANCO | `scripts/analysis/verificar-hog-2010.py` |
| 1 | 120 | SCRIPT o BANCO | `scripts/compute-ecology-clients.mjs` |
| 1 | 125 | SCRIPT o BANCO | `scripts/compute-ecology-resident.cu` |
| 1 | 140 | SCRIPT o BANCO | `scripts/lab/calibrar-c8.mts` |
| 1 | 173 | SCRIPT o BANCO | `scripts/analysis/comparar-snapshots-economia.py` |
| 1 | 190 | SCRIPT o BANCO | `scripts/analysis/verificar-solapes-relanzadas.py` |
| 1 | 200 | SCRIPT o BANCO | `scripts/deploy-check.sh` |
| 1 | 217 | SCRIPT o BANCO | `scripts/benchmark-ws-deflate.ts` |
| 1 | 256 | SCRIPT o BANCO | `scripts/analysis/verificar-ctrlv4c.py` |
| 1 | 284 | SCRIPT o BANCO | `scripts/analysis/verificar-ctrlv4e.py` |
| 1 | 287 | SCRIPT o BANCO | `scripts/analysis/verificar-ctrlv4f.py` |
| 1 | 298 | SCRIPT o BANCO | `scripts/analysis/verificar-ctrlv4d.py` |
| 1 | 45 | SCRIPT o BANCO | `scripts/lab/techo-lab.ts` |
| 1 | 676 | SCRIPT o BANCO | `scripts/lab/instrumentos.ts` |
| 1 | 72 | SCRIPT o BANCO | `scripts/soak.ts` |
| 1 | 73 | SCRIPT o BANCO | `scripts/perf/tamano-archivo.sh` |
| 1 | 78 | SCRIPT o BANCO | `scripts/compute-ecology.cu` |

### Totales por clase
| Clase | Ficheros | Líneas | Coincidencias |
|---|---:|---:|---:|
| CÓDIGO DE EJECUCIÓN (determinismo/verificación) | 3 | 1235 | 44 |
| CÓDIGO QUE LO USA DE PASO | 56 | 30967 | 501 |
| DOCUMENTO / EVIDENCIA | 166 | 46331 | 1500 |
| PRUEBA MIXTA | 166 | 42751 | 1418 |
| PRUEBA SOLO DE PARIDAD (candidata) | 11 | 1509 | 161 |
| SCRIPT o BANCO | 78 | 18266 | 566 |
| **Total** | **480** | **141059** | **4190** |

## Parte B. Código sin uso en ejecución (paralelo, soa, gpu, halo)

| Fichero | Líneas | Importado por src/ | Importado por tests/ | Importado por scripts/ | Marca |
|---|---:|---|---|---|---|
| `src/world/paralelo/agregados.ts` | 224 | src/world/paralelo/personas-motor.ts  | tests/agregados.test.ts  | — | USO |
| `src/world/paralelo/barrera.ts` | 51 | src/world/paralelo/piscina.ts  | — | — | SOLO SRC |
| `src/world/paralelo/fauna-motor.ts` | 713 | src/world/index.ts src/world/animals.ts  | tests/v22-world-hotpaths.test.ts tests/v15-open-caps.test.ts tests/v19-phase1-fauna.test.ts tests/fauna-paralelo.test.ts  | — | USO |
| `src/world/paralelo/fauna-worker.ts` | 484 | src/world/paralelo/fauna-motor.ts  | tests/v22-world-hotpaths.test.ts tests/v19-phase1-fauna.test.ts tests/fauna-paralelo.test.ts  | — | USO |
| `src/world/paralelo/guardia.ts` | 101 | src/world/paralelo/reduccion.ts  | tests/guardia-fase-b.test.ts  | — | USO |
| `src/world/paralelo/identidades.ts` | 250 | — | tests/identidades.test.ts  | — | SOLO PRUEBAS |
| `src/world/paralelo/paginas.ts` | 61 | src/world/paralelo/fauna-motor.ts src/world/paralelo/personas-motor.ts src/world/paralelo/fauna-worker.ts src/world/paralelo/personas-worker.ts  | — | — | SOLO SRC |
| `src/world/paralelo/particion.ts` | 55 | src/world/paralelo/piscina.ts src/world/paralelo/fauna-motor.ts src/world/paralelo/personas-motor.ts src/world/paralelo/fauna-worker.ts src/world/paralelo/personas-worker.ts src/world/soa/terreno.ts  | tests/paralelo-adversarial.test.ts tests/auditoria-reglas-motor.test.ts tests/agregados.test.ts tests/paralelo-piscina-fatal.test.ts  | — | USO |
| `src/world/paralelo/personas-motor.ts` | 831 | src/world/index.ts  | tests/v22-world-hotpaths.test.ts tests/v12-perf-fastpaths.test.ts tests/v17-perf-hotpath.test.ts tests/personas-choose-paralelo.test.ts tests/personas-paralelo.test.ts  | — | USO |
| `src/world/paralelo/personas-worker.ts` | 407 | src/world/paralelo/personas-motor.ts  | tests/v12-perf-fastpaths.test.ts tests/personas-choose-paralelo.test.ts tests/personas-paralelo.test.ts  | — | USO |
| `src/world/paralelo/piscina.ts` | 445 | src/server/app.ts src/world/ecosystem-kernel.ts src/world/ecology-kernel.ts src/world/paralelo/fauna-motor.ts src/world/paralelo/personas-motor.ts src/world/paralelo/fauna-worker.ts src/world/paralelo/personas-worker.ts  | tests/paralelo-adversarial.test.ts tests/auditoria-reglas-motor.test.ts tests/fraccion-serial.test.ts tests/sc013-limite-hardware.test.ts tests/hardware/contrato.ts tests/paralelo-ecologia.test.ts tests/paralelo-piscina-fatal.test.ts  | scripts/banco-escala-extrema-gpu.mts scripts/banco-dual-gpu-mundo-vivo.mts  | USO |
| `src/world/paralelo/reduccion.ts` | 351 | src/world/paralelo/personas-motor.ts  | tests/intencion-confirmacion.test.ts  | — | USO |
| `src/world/soa/arena.ts` | 69 | src/world/soa/presencia.ts src/world/soa/terreno.ts  | — | — | SOLO SRC |
| `src/world/soa/personas.ts` | 485 | — | tests/soa-personas.test.ts  | — | SOLO PRUEBAS |
| `src/world/soa/presencia.ts` | 55 | src/world/soa/terreno.ts  | — | — | SOLO SRC |
| `src/world/soa/region.ts` | 82 | src/world/soa/presencia.ts src/world/soa/terreno.ts  | tests/fauna-soa-fast.test.ts  | — | USO |
| `src/world/soa/terreno.ts` | 1221 | src/server/snapshot-parts.ts src/server/sim-worker.ts src/server/snapshot.ts src/world/index.ts src/world/gpu/puente.ts src/world/ecosystem-kernel.ts src/world/society.ts src/world/natalidad-local.ts src/world/spatial.ts src/world/agua.ts src/world/politica-obs.ts src/world/paralelo/fauna-motor.ts src/world/paralelo/personas-motor.ts src/world/proyeccion.ts src/world/inventions.ts src/world/animals.ts  | tests/v12-perf-fastpaths.test.ts tests/v18-r3-scale-parity.test.ts tests/fauna-hotpath-parity.test.ts tests/v20-roads.test.ts tests/soa-mutaciones.test.ts tests/v22-seasonal-gpu-ecology.test.ts tests/v18-dirty-snapshot-pages.test.ts tests/soa-terreno.test.ts tests/v18-w2-stats-soa.test.ts tests/sc013-limite-hardware.test.ts tests/v18-store-save-perf.test.ts tests/gpu-puente.test.ts tests/fauna-soa-fast.test.ts tests/soa-terreno-paralelo.test.ts tests/v18-w2-choose-fast.test.ts tests/v18-hotpath-parity.test.ts tests/perf-personas-core-parity.test.ts tests/gpu-incremental-page-sync.test.ts tests/soa-topologia-residente.test.ts  | scripts/banco-escala-extrema-gpu.mts scripts/banco-dual-gpu-mundo-vivo.mts  | USO |
| `src/world/soa/topologia.ts` | 305 | src/server/snapshot-parts.ts src/server/sim-worker.ts src/server/main.ts src/server/snapshot.ts src/world/index.ts src/world/spatial.ts src/world/agua.ts src/world/tile-index.ts src/world/paralelo/fauna-motor.ts src/world/paralelo/personas-motor.ts src/world/clon.ts src/world/animals.ts src/world/soa/terreno.ts src/world/ecosystem.ts  | tests/v22-world-hotpaths.test.ts tests/v12-perf-fastpaths.test.ts tests/v18-r3-scale-parity.test.ts tests/fauna-hotpath-parity.test.ts tests/perf-store-save-parity.test.ts tests/v20-roads.test.ts tests/soa-mutaciones.test.ts tests/v18-motors-perf.test.ts tests/v18-dirty-snapshot-pages.test.ts tests/v18-w2-stats-soa.test.ts tests/v18-store-save-perf.test.ts tests/fauna-soa-fast.test.ts tests/v18-w2-choose-fast.test.ts tests/v18-hotpath-parity.test.ts tests/v17-perf-hotpath.test.ts tests/personas-choose-paralelo.test.ts tests/perf-personas-core-parity.test.ts tests/hardware/escenas.ts tests/hardware/cambios.ts tests/v18-chunk-spikes.test.ts tests/determinismo-hardware.test.ts tests/soa-topologia-residente.test.ts  | scripts/lab/v19-panel.mts  | USO |
| `src/world/gpu/autoprueba.ts` | 156 | src/server/sim-worker.ts src/server/main.ts  | tests/gpu-autoprueba.test.ts tests/auditoria-reglas-motor.test.ts tests/v15-open-caps.test.ts tests/gpu-reparto.test.ts tests/v17-perf-hotpath.test.ts  | — | USO |
| `src/world/gpu/politica-gpu.ts` | 762 | src/world/index.ts  | tests/politica-gpu-residente.test.ts tests/v12-perf-fastpaths.test.ts tests/politica-evolutiva.test.ts tests/v12-full-hardware-evolution.test.ts  | scripts/banco-dual-gpu-mundo-vivo.mts  | USO |
| `src/world/gpu/puente.ts` | 844 | src/server/hardware-limits.ts src/world/index.ts src/world/ecosystem-kernel.ts  | tests/auditoria-reglas-motor.test.ts tests/v22-seasonal-gpu-ecology.test.ts tests/gpu-puente.test.ts tests/v17-perf-hotpath.test.ts tests/v12-full-hardware-evolution.test.ts tests/gpu-incremental-page-sync.test.ts  | scripts/banco-escala-extrema-gpu.mts scripts/banco-dual-gpu-mundo-vivo.mts  | USO |
| `src/world/gpu/reparto.ts` | 44 | src/world/paralelo/personas-motor.ts src/world/paralelo/reduccion.ts  | tests/gpu-reparto.test.ts  | — | USO |
| `src/world/halo.ts` | 776 | — | tests/halo-radios.test.ts  | — | SOLO PRUEBAS |
