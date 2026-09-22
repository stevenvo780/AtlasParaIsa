# Plan de la noche 2026-09-22 → 23 (orquestador Fable)

Base: main @ 694f6b6 (1251/1251 tests, typecheck ok). Servidor público V7 (3dd615e) vivo con solo S e I.

## Diagnóstico (confirmado)
1. Extinción pública = gobernador R17: p95(paso completo = clon+sim+save) > 50 ms → reproductionEnabled=false
   desde t16300 → 0 nacimientos → ola de senescencia (edad máx ~12 d) → solo S/I al día 21.
   Clon de mundo envejecido: p50 20–33 ms, p95 29–47 ms (REVISION-CLON-ENVEJECIDO). Sin gobernador 9/10 réplicas crecen.
2. Cooperación = 97 % enseñanza; conflictos = 0 (resourceDispute exige hambre≥0,65 Y stock≤0,06 Y otro igual a ≤2 celdas).
3. Diversidad de conducta cae 0,35→0,14 (SC-003 ≥0,6); transmisión cultural →0 %; comunidades estáticas (>=8 gate,
   revisión nunca se cumple); varianza genética converge con 6 generaciones.

## Workstreams
A. Etapa A (specs/002 tasks): T100, T103(perf), T104 (sin clon + punto de restauración), T105, T106, T107, T108, T109. Gate A = T110 (yo).
B. Gobernador con techo observado (T162/T164 parcial): cuando p95>presupuesto, no apagar: fijar techoObservado=población y
   permitir solo reemplazo (población < techo). Si p95 > 1,5×presupuesto, techo baja 1 cada N pasos. p95<0,7 → techo=null.
   Publicar performance.gobernador.techoObservado. (yo, worktree n-gobernador)
C. Laboratorio: replica.ts --gobernador servidor (clon+save por cadencia+decideReproduction) + métricas de rasgos por generación
   (selección) + índice SC-003 real (indiceDiversidad). Luego: runs control (hoy+gob) que reproduzcan la extinción, y runs con B.
D. Ciencia (reglas con parámetro, default=hoy): C1 disputa/turnos alcanzables; C2 enseñar lo que falta + transmitir recetas;
   C4 revisión de pertenencia/escisión alcanzable. A/B 8 semillas × 20 d. Adoptar ganadores → RULES_VERSION + evidencia.
E. Etapa D parcial: T134 (people/communities por viewport), T136 (perMessageDeflate).
F. Integración: merge orden T103→T105→T106→T107→T108→T109→T104→gob→lab→D→ciencia; suite completa; build en worktree;
   docs (EVIDENCIA, REGLAS, PLAN, tasks.md); main; push; deploy por protocolo (respaldo → stop → build → start → verificar).

## Worktrees: /datos/workspaces/personal/AtlasParaIsa-n-<tarea>, rama sprint/noche-<tarea>-20260922, node_modules symlink.
## Reglas duras: nunca build en árbol principal; nunca tocar data/ ni ~/.local/bin/atlas-servidor*; no leer contraseña.
