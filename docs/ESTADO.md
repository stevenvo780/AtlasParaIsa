# Estado publicado

Única fuente de «qué está publicado». README, PLAN y CLAUDE.md enlazan aquí en vez de copiar
estas cifras. Se actualiza en cada publicación, junto con su contrato
`docs/evidencia-AAAA-MM-DD/publication*.json`; si este fichero y el contrato discrepan, manda
el contrato.

## Vigente (mundo V11 desde el 24 de septiembre de 2026, 02:35 -05; en la TORRE desde las 08:35 -05)

| Qué | Valor |
|---|---|
| URL | <https://atlas.humanizar.tech> |
| Código compilado y servido | `5a36ce6` desde el 24-09 02:35 -05 (en el portátil hasta las 08:34, en la torre desde las 08:35: [contrato de la publicación](evidencia-2026-09-24/publication-v11.json), [contrato de la mudanza](evidencia-2026-09-24/publication-v11-torre.json)): reglas 11 (conflicto legible) y el arte del suelo por campo (bordes orgánicos de biomas, desgaste y orillas; agua sin cuadros). Contiene también, **a 0**, las leyes candidatas de C8 (`conducta.vocacion`, `social.hogarTrabajo`) y de natalidad local (`poblacion.natalidadLocal`): el mundo por defecto es bit a bit el de reglas 11 |
| `main` | ver `git log`; lo servido es `5a36ce6`, no necesariamente el HEAD de `main` |
| Reglas | `RULES_VERSION` 11: reglas 10 + `social` { disputaNecesidad 0,45, disputaEscasez 3, disputaRadio 3, memoriaDisputa 8 } y gobernador `techo` |
| Protocolo | `PROTOCOL_VERSION` 10 |
| SQLite | `user_version` 5 (instantáneas paginadas) |
| Máquina | **Torre** desde el 24-09 08:35 (Steven: portátil liberado, una sola instancia en la torre con todos sus recursos): servicio de usuario `atlas-publico.service` en 100.64.0.1:3000 (la IP que usa el dominio), código en el worktree `AtlasParaIsa-anexo/worktrees/publico-v11`; el puente `atlas-puente.service` quedó parado y deshabilitado. En el portátil, `atlas-publico.service` y su timer están deshabilitados y la copia del mundo renombrada a `v11-20260924-MUDADO-A-TORRE-0835`: **no arrancarlos** (bifurcaría el mundo) |
| Mundo | V11, semilla 51926, identidad `42704a7e-d5b7-4ee9-bef0-7c7ced2cb3b3`, creado vacío el 24-09 02:35 -05 en el portátil y mudado con el servicio parado (mismo sha256): `/datos/workspaces/personal/AtlasParaIsa-anexo/mundos/v11-20260924` de la torre (credencial `access.scrypt` copiada de V10: misma contraseña, solo el hash). Al mudarse: día 38,7, 631 vecinos, 1 057 nacimientos |
| Parámetros persistidos | `persistencia.cadaTicks=100`, `gobernador.politica=techo`, `gobernador.presupuestoMs=5000` (`CARTA_PARAMS`), límites de admisión del anfitrión y el paquete de reglas 11 (contrato) |
| Respaldos | Torre: `AtlasParaIsa-anexo/publicaciones/v11-respaldos` (timer horario `atlas-respaldo-publico.timer`). Portátil (ya sin servicio): `~/atlas-lab/respaldos` con el último de V10 (`world-20260924-0232`) y el de V11 antes de la mudanza (`world-20260924-0834`) |
| Servicios | Torre: `atlas-publico.service` (`scripts/systemd/torre/publico.sh`, drop-in CPUWeight/IOWeight 10000) y `atlas-respaldo-publico.timer`; copias en `scripts/systemd/torre/`. Deshabilitados: `atlas-puente.service`, `atlas-servidor.service` y `atlas-respaldo.timer` de la torre (V10), y los del portátil |
| Gate | Gemelo de laboratorio SEM2-51926 (reglas 11, semilla 51926, 60 días): C1–C7 cumplen, C8 falla; `scripts/deploy-check.sh 5a36ce6` verde; suites del arte y de la ley de natalidad sin fallos reales (contrato) |
| Contrato | [publication-v11.json](evidencia-2026-09-24/publication-v11.json) y [publication-v11-torre.json](evidencia-2026-09-24/publication-v11-torre.json) (mudanza) |

Lo que esta publicación **no** acredita: el criterio de 60 días de [GOAL.md](../GOAL.md) **no se cumple**: C8 (diversidad de conducta creciente) falla en todas las semillas del laboratorio con estas reglas (ver [EVIDENCIA](EVIDENCIA.md)). La meseta de población (~630–700) la pone el cupo global de 40 nacimientos/día (`poblacion.nacimientosPorComprobacion`), un regulador de software; la alternativa local NAT-L quedó refutada en su cribado del 24-09. El motor es de un solo hilo y se frenará cuando el mundo crezca.

## Anteriores, conservados

- V10 (código servido por última vez `b5def74`, reglas 10): mundo en `~/atlas-lab/mundos/v10-20260922` del portátil, intacto y detenido el 24-09 02:35 -05 (día ~165, ~700 habitantes); último respaldo `world-20260924-0232.sqlite.gz`. La copia de la torre (`AtlasParaIsa-anexo/mundos/v10-20260922`) es el estado de la mudanza (tick 322 800) y **no debe arrancarse**. Contratos: [publication-v10.json](evidencia-2026-09-22/publication-v10.json), [publication-v10-portatil.json](evidencia-2026-09-23/publication-v10-portatil.json) y [publication-v10-portatil-perf3-e0.json](evidencia-2026-09-23/publication-v10-portatil-perf3-e0.json).
- V7 (`3dd615e`, reglas 7, protocolo 9, SQLite 4): mundo en
  `/datos/workspaces/personal/AtlasParaIsa-anexo/mundos/v7-20260922`, intacto; se extinguió por la política
  `apagar` del gobernador. Contrato: [publication.json](evidencia-2026-09-22/publication.json).
- Publicaciones anteriores a V7: registros históricos en [EVIDENCIA](EVIDENCIA.md).

## Trabajo en curso

- Revisiones vigentes: [REVISION-2026-09-22](REVISION-2026-09-22.md) y
  [REVISION-NOCHE-2026-09-22](REVISION-NOCHE-2026-09-22.md).
- `specs/002-mundo-ilimitado/`: etapas B–F descongeladas el 2026-09-23 (decisión de Steven: la escala en paralelo a
  la biología). Ya integrados y servidos: PERF3 (sin copia del mundo en los pasos sin gestos) y el bloque E.0 ola 1
  (T141–T143). La ola 1 de la etapa B (T111–T113: halo, terreno SoA, teselas y activación O(1)) ya está fusionada en
  `main` (`ff52c30`) pero **aún no desplegada al público** (el commit servido, `b5def74`, es anterior a ese merge).
  La ola 2 de B (T115/T117/T120) queda en espera: el perfil a 700 habitantes (bitácora 23-09 17:50) señala la
  enseñanza/recetas (20 %), la fauna (13 %) y la ecología (7 %) como el coste, no el halo/terreno (decisión D4 del
  plan maestro). La etapa A está integrada en `main`; T103 y T104 quedan superadas por ARCH/PERF3 y ese perfil
  (pendiente reescribirlas); siguen abiertas T100 y el Gate A (T110), según
  [tasks.md](../specs/002-mundo-ilimitado/tasks.md).
- `specs/001-mundo-solido-masivo/`: cerrada el 2026-09-19.

## Cómo se actualiza

Al publicar, con el procedimiento de CLAUDE.md: nuevo `publication-*.json` con el commit, el gate y las
comprobaciones en vivo; después, esta tabla y la sección de anteriores, y `npx tsx scripts/check-links.ts`
para no dejar enlaces rotos. Ningún otro documento repite
el commit vigente; CLAUDE.md nombra además el directorio del mundo para que ningún agente lo toque.
