# Persistencia: recuperación estricta y números exactos

La integración `bfdaa0f` conserva reglas V7 y SQLite4. Corrige tres fallos:
un snapshot con checksum válido pero leyes o estructura inválidas ya no se trata
como un archivo roto recuperable; la migración V1 conserva sus parámetros antes de
generar terreno; y el cero negativo conserva su signo en snapshots, chunks e
identidades. Los bytes ordinarios siguen siendo compatibles con el encoder anterior.

**946/946 pruebas, cero fallos y cero omisiones**, typecheck y build/smoke del
commit exacto pasaron en el worktree aislado. La suite tardó 216.559 s en este host
compartido. [Gate completo](evidencia-2026-09-22/t100-phase2-gates.json) y
[gate de publicación sin publicar](evidencia-2026-09-22/t100-phase2-exact-gate.json).

La revisión independiente ejerció diez casos de migración V1 con leyes de agua
distintas y corrupción introducida desde otra conexión, tanto al cargar como al
guardar. Se conservaron todas las tablas ante rechazos y las transacciones quedaron
cerradas. Además, seis semillas y dos órdenes de propiedades produjeron 24
roundtrips exactos de snapshots y doce controles de igualdad de bytes ordinarios,
con texto escapado, Unicode y ceros negativos en terreno, personas y parámetros.
Resultados: [primera unidad](evidencia-2026-09-22/t100-phase1-independent.json),
[segunda unidad](evidencia-2026-09-22/t100-phase2-independent.json).

El informe de cada cambio conserva controles negativos, alcance y medición:
[recuperación y migración](evidencia-2026-09-22/t100-persistence-phase1.md),
[números exactos](evidencia-2026-09-22/t100-persistence-phase2.md).
No se afirma exactitud universal de todos los serializadores del proyecto.

No se repitió E2E de navegador para estos cambios de almacenamiento. No hay
segmentación, nuevos límites activos ni roundtrip de dos millones de teselas en este
commit. **T100 y Gate A0 siguen abiertos**. El servidor público conserva el build
`3dd615e`; integrar fuentes en main no recompila sus assets ni reinicia su mundo.
