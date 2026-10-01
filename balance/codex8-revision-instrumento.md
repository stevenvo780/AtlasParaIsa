# Revisión independiente del instrumento de realismo

Corte de la primera comprobación real: 2026-09-30T22:51:08.662694-05:00. Instrumento de esa comprobación SHA256 `cd3d9fe6b36e6b69bc6e327577867939355d564618033e2c3aa9ae7f9a8cdfa0`. Revisión sintética final del instrumento corregido SHA256 **`c83a2c34d8562a3e747de37ba041fee12fa3c06ab5e7ca4838d8ffa715ceeb2e`**, estable durante esa revisión.

Sintéticos finales del lector independiente: **19/19 PASS**, **0 GAP pendientes** en los once casos que también invocan el lector auditado.
Recálculo numérico real: **PASS, 0 diferencias**, con los límites de recursos y versiones indicados abajo.

| Caso sintético | Lector independiente | Instrumento auditado |
|---|---|---|
| active overrides stale archived body | PASS | PASS |
| latest per key at or before horizon | PASS | PASS |
| legacy excluded from constructed counter | PASS | PASS |
| resident duplicate rejected | PASS | PASS |
| archived structure duplicate rejected | PASS | PASS |
| resident place duplicate rejected | PASS | PASS |
| duplicate inside archived places rejected | PASS | PASS, corregido |
| one dormant resident anchor may overlay archive | PASS | PASS |
| negative coordinate uses floor division | PASS | PASS |
| constructed serial completeness | PASS | PASS |
| bad archive digest rejected | PASS | PASS |
| recipe definitions and statistics bounded by horizon | PASS | no invocado |
| missing cumulative recipe stats rejected | PASS | no invocado |
| delta four over two days is interval average, not daily history | PASS | no invocado |
| equal endpoints permit unobserved consume-and-refill | PASS | no invocado |
| S and I protected, neighbor mortal | PASS | no invocado |
| duplicate JSON key rejected | PASS | no invocado |
| live path refused before opening | PASS | no invocado |
| integer comparison remains exact at large magnitude | PASS | no invocado |

**6** snapshots, **2** catálogos detallados, **4** intervalos y **133166** comparaciones; **0** diferencias. Los seis gzip coinciden con el manifest y las seis bases con su gzip; SHA SQLite antes/después idénticos. Sólo se abrieron copias privadas; no se accedió a rutas source del manifest ni al mundo vivo.

La primera comprobación real terminó con salida **0**, nice **19** y CPUs **6–31** iguales al principio y al final. Durante esa comprobación, el agente raíz corrigió el único fallo reproducido: un lugar repetido dentro de la misma región archivada se sobrescribía. La versión final añade `archived_place_ids` y rechaza esa repetición (`scripts/lab/auditar-realismo.py:36,51–53`); conserva la superposición válida entre un ancla residente dormida y una entrada archivada de igual identidad y coordenadas (`:55–58`). La revisión final pasó 19 sintéticos con recursos inicial/final válidos y fuente estable.

Una segunda comprobación numérica completa, con comparación entera estricta y la versión final, volvió a comprobar las seis copias sin diferencias. Su guard final detectó **`ValueError: verifier resource drift`**, salida **1**, después del recálculo y antes de escribir: **esa ejecución no se presenta como PASS de recursos ni reemplazó el reporte válido anterior**. El JSON conserva el resultado de la primera ejecución y registra por separado esta repetición fallida y la revisión sintética final. Un primer intento sintético había detenido el trabajo antes de abrir bases por `ValueError: start outside compute policy`; al fijar nombre/nice/afinidad del propio proceso, el sintético posterior pasó. No se cambió ningún servicio para corregir prioridad.

Las comparaciones cubren estructuras/all/built/legacy/active/archive, condición/edad/usos/stocks, lugares, hogares, reservas corporales/materiales, productos y sus roles S/I, tecnología, estadísticas acumuladas al horizonte, recibos retenidos e intervalos.

Límites:

- Copies only; no source gzip or live world opened.
- El comparador final exige igualdad exacta para enteros; flotantes usan rel=1e-10 y abs=1e-7 con math.fsum independiente. El sintético de 1e12 y 1e12+1 detecta cualquier tolerancia indebida para contadores.
- Active/archive observations have different clocks; sums are mixed-time states.
- Three snapshots per version cannot reconstruct daily use or assert never consumed.
- Real verifier rechecks summaries and row identities, not complete Store/law validation or replay.
- Receipt count and used-as-input fields are restricted to retained history.

No se encontraron errores numéricos pendientes en estos datos. Eso acredita la extracción de los campos comparados, no una prueba de realismo, ocupación, mantenimiento o conservación material global. `usesZero` de receta es cero usos acumulados registrados de esa clase, sin excluir empleo como insumo o catalizador; los nuevos campos retained separan esas formas de utilización (`auditar-realismo.py:89–112`). `itemsSameMass` no acredita cero usos (por ejemplo, llenar/beber agua puede conservar masa del soporte); `stockUnchanged` puede esconder consumo seguido de reposición. Tasas entre respaldos son promedios sobre calendario; no se reconstruyó uso por día ni tiempo activo entre ambos extremos (`:161–178,197–199`).

Recursos válidos para la primera comprobación real y para la revisión sintética final: nice=19, CPUs 6–31, inicial/final iguales. El fallo de recursos de la repetición se conserva como límite explícito.
No se editaron el instrumento auditado, las reglas, specs, evaluadores, preregistros ni servicios.
