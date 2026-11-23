# Estado publicado

Única fuente de «qué está publicado». README, PLAN y CLAUDE.md/AGENTS.md enlazan aquí en vez de copiar
estas cifras. Se actualiza en cada publicación, junto con su contrato
`docs/evidencia-AAAA-MM-DD/publication*.json`; si este fichero y el contrato discrepan, manda
el contrato.

## Vigente (mundo V18 desde el 22 de noviembre de 2026, 21:24 -05, en la TORRE)

| Qué | Valor |
|---|---|
| URLs | Público: <https://atlas.humanizar.tech> · VPN (Tailscale): `https://100.64.0.1:3443` · LAN: `https://192.168.78.211:3443` (excepción explícita de Steven sobre origen único: `CARTA_EXTRA_ORIGINS` empareja estrictamente `Host ↔ Origin` en HTTPS con cookie `Secure` y `access.scrypt`) |
| Código compilado y servido | `6fcf49b` desde el 22-11 21:24 -05 ([contrato V18](evidencia-2026-11-22/publication-v18.json)): universo emergente abierto (`RULES_VERSION = 12`, `CARTA_OPEN_WORLD=1`) con 13 frentes Claude + Muse Contributor integrados — fisión Dunbar estable sin comunidades fantasma de 1 mortal + nombres propios poéticos en `reproduce()` + refuerzo bidireccional de `stewardship`, UI/UX de observabilidad emergente (inspector política/Baldwin, ejes culturales, distancia/encuentros discretos S–I sin tocar la carta, fases/gobernador y `resync` WS único en vuelo), vía rápida SoA en estadísticas/cuencas (`~80–100×`), `TileIndex`/rutas/`halo`/catálogo/linaje/demografía/fauna/archivo acelerados (`0 ULP`), reutilización fail-closed de páginas limpias de snapshot (`~5×`) con escaneo iterativo, proyección `5,65×` más rápida, deltas WS estructurales (`−47,5%` bytes, deflate/troceo adaptativo) y caché gzip en activos (`Cache-Control: no-store`) |
| Ley activada | **V18 abierto (`CARTA_OPEN_WORLD=1`)**: `motor.hilos=28`, `motor.gpu=[0,1]`, `motor.soaTerreno=true`, `motor.particionarPersonas=true`, `recursos` (`capacidadBosque=0.74`, `capacidadPastizal=0.52`, `capacidadOtros=0.24`, `velocidadRegeneracion=0.66`, `decaimientoFertilidad=0.0022`), `agua.cuencas=0.36`, `poblacion.natalidadVecindad=true` (`radioVecindadNatalidad=16`), `social` (`radioConvivencia=12`, `disolucion=1`, `maxComunidades=0`, `derivaCultural=1`, `vinculoEncuentro=1`), `conducta` (`aptitud=0.85`, `politicaPeso=0.80`, `politicaAutonomia=0.65`), `tecnologia` (`evitarNoOp=true`, `dosisCuanto=100`, `mejoraLocal=0.08`, `enfriamiento=240`, `efectosHerramientas=true`), `red.deltas=true`, `gobernador.presupuestoMs=5000` (`techo`), `persistencia.cadaTicks=200`, `persistencia.ventanaEventosTicks=2400` y admisión `limites.chunks=65536` |
| `main` | ver `git log`; lo servido es `6fcf49b` |
| Reglas | `RULES_VERSION` 12 (`CARTA_OPEN_WORLD=1`, defaults históricos conservados byte a byte en `DEFAULT_PARAMS`) |
| Protocolo / SQLite | `PROTOCOL_VERSION` 10 / `user_version` 5 |
| Máquina | Torre: `atlas-publico.service` en `100.64.0.1:3000` + `atlas-lan-tls.service` en `100.64.0.1:3443` y `192.168.78.211:3443`, código en `AtlasParaIsa-anexo/worktrees/publico-v18` (`publico-v17` y anteriores conservados para rollback; proceso «carta-isa», `NODE_OPTIONS=--max-old-space-size=65536`, drop-in CPUWeight/IOWeight 10000, `COMPUTE_NVRTC=/opt/cuda/lib64/libnvrtc.so`, ambas GPU RTX 5070 Ti + RTX 2060 activas en VRAM). No arrancar servicios del portátil ni `atlas-servidor`/`atlas-respaldo` de la torre |
| Mundo | V18, semilla 51926, identidad `13501d91-56f1-4df3-abe2-67b1620c7042`, creado vacío el 22-11 21:24 -05 en NVMe `/datos/workspaces/personal/AtlasParaIsa-anexo/mundos/v18-20261122` (credencial `access.scrypt` copiada de V17) |
| Parámetros persistidos | `CARTA_OPEN_WORLD=1` + `CARTA_PARAMS` (`gobernador.presupuestoMs=5000`, `persistencia.cadaTicks=200`, `persistencia.ventanaEventosTicks=2400`, `red.deltas=true`, `limites.chunks=65536`, `teselasActivas=16777216`, `comunidades=16777216`, `fauna=100663296`), gobernador `techo` y reglas 12 |
| Respaldos | HDD `/mnt/Data2/respaldos-atlas-v18` (timer horario `atlas-respaldo-publico.timer`, `RETENCION=24`, `RESPALDO_METODO=backup`, `MemoryHigh=3G`, `IOSchedulingClass=idle`, `Nice=15`) |
| Contrato | [publication-v18.json](evidencia-2026-11-22/publication-v18.json) |

Lo que esta publicación acredita: auditoría de 4 semillas × 30 días (`7, 42, 404, 51926`) con `0` comunidades fantasma de 1 mortal, `100%` nombres propios y comunitarios únicos, divergencia `stewardship` viva (`stewInterSd 0,0162–0,0369`), `memoriesUntouched = 4/4` y encuentros S–I `77–119`; banco a escala de 3.207 hab. / 278.016 teselas (28T + Dual-GPU): proyección `1.303,2 → 230,6 ms` (`5,65×`), `deltaMs = 3,65 ms` (`−43,4%` bytes), `Store.save` frío `4.646,5 → 3.584,3 ms` / tibio `1.962,2 → 1.363,1 ms`, `checkpoint` máx `40,1 → 26,9 ms` y paso sostenido `p95 = 710,4 ms` (`7×` bajo `5.000 ms`); suite completa verde (`2.552` + `18` aisladas + `222` catálogo/tecnología + `139` V18 + `543/543` determinismo hardware con CUDA `gpu=[0,1]` 0 ULP); `deploy-check.sh 6fcf49b` salida `0`, `gpuAutoprueba` PASS en GPU 0 (`17,44 ms`) y GPU 1 (`9,38 ms`), verificación viva en público + VPN + LAN (`403` en cruce `Host ↔ Origin`, `content-encoding: gzip` + `gzip -dc | cmp -s` OK) y primer respaldo íntegro en `/mnt/Data2/respaldos-atlas-v18`.

## Anteriores, conservados

- V17 (código `db4998a`, reglas 12 + `CARTA_OPEN_WORLD=1`), servido del 22-11 13:27 al 22-11 21:23 -05 (alcanzó el día 57,75, tick 138 600, 2 926 vivos, 268 comunidades, 4 154 nacimientos, 1 292 recetas, 190 976 teselas, 2 303 chunks; 4,0 GiB SQLite); mundo detenido e intacto en `AtlasParaIsa-anexo/mundos/v17-20261122` (worktree `publico-v17`); último respaldo antes del corte `/mnt/Data2/respaldos-atlas-v17/world-20261122-2121.sqlite.gz` (483 MiB, `gzip -t` OK). **No arrancarlo.** Contrato: [publication-v17.json](evidencia-2026-11-22/publication-v17.json).

- V16 (código `d091f7a`, reglas 12 + `CARTA_OPEN_WORLD=1`), servido del 22-11 01:42 al 22-11 13:25 -05 (alcanzó el día 50,04, tick 120 100, 3 204 vivos, 202 comunidades, 4 703 nacimientos, 2 333 recetas, 259 584 teselas); mundo detenido e intacto en `AtlasParaIsa-anexo/mundos/v16-20261122` (worktree `publico-v16`); último respaldo antes del corte `/mnt/Data2/respaldos-atlas-v16/world-20261122-1319.sqlite.gz` (631 MiB, `gzip -t` OK). **No arrancarlo.** Contrato: [publication-v16.json](evidencia-2026-11-22/publication-v16.json).

- V15 (código inicial `179b44d`, actualizado a `a928287`, reglas 12 + `CARTA_OPEN_WORLD=1`), servido del 21-11 15:48 al 22-11 01:40 -05 (alcanzó el día 40,58, tick 97 400, 4 867 vivos, 371 comunidades, 5 954 nacimientos, 35 613 recetas); mundo detenido e intacto en `AtlasParaIsa-anexo/mundos/v15-20261121` (worktrees `publico-v15`, `publico-v15-r3`); último respaldo antes del corte `/mnt/Data2/respaldos-atlas-v15/world-20261122-0139.sqlite.gz` (535 MiB, `gzip -t` OK). **No arrancarlo.** Contratos: [publication-v15-r3.json](evidencia-2026-11-19/publication-v15-r3.json), [publication-v15.json](evidencia-2026-11-19/publication-v15.json).

- V14 (código inicial `aebce69`, actualizado a `f550c04` y `c1fe393`, reglas 11 + COM + COM-D′), servido del 19-11 00:42 al 21-11 15:48 -05 (alcanzó el día 601,29, tick 1 443 100, 649 vivos, 64 comunidades, 23 648 nacimientos; 4,0 GiB SQLite); mundo detenido e intacto en `AtlasParaIsa-anexo/mundos/v14-20261119` (worktrees `publico-v14`, `publico-v14-r2`, `publico-v14-r3`); último respaldo antes del corte `/mnt/Data2/respaldos-atlas-v14/world-20261121-1545.sqlite.gz` (852 MiB, `gzip -t` OK). **No arrancarlo.** Contratos: [publication-v14-r3.json](evidencia-2026-11-19/publication-v14-r3.json), [publication-v14-r2.json](evidencia-2026-11-19/publication-v14-r2.json), [publication-v14.json](evidencia-2026-11-19/publication-v14.json).

- V13 (código `c7b3bb3`, reglas 11 + COM + COM-D′), servido del 30-09 07:26 al 17-11 13:13 -05 (alcanzó el día 9 252,79, tick 22 206 700, 641 vivos, 369 708 nacimientos, 0 caídas; 24,43 GiB SQLite); mundo detenido e intacto en `AtlasParaIsa-anexo/mundos/v13-20260930` (worktree `publico-v13`); último respaldo `/mnt/Juegos/respaldos-atlas-v13/world-20261118-2000.sqlite.gz` (5,12 GiB, `gzip -t` OK; 5 copias duplicadas deduplicadas). **No arrancarlo.** Contrato: [publication-v13.json](evidencia-2026-09-30/publication-v13.json).

- V12 (código `ced1fec`, reglas 11 + COM), servido del 28-09 20:59 al 30-09 07:26 -05; mundo detenido e intacto en `AtlasParaIsa-anexo/mundos/v12-20260928` (worktree `publico-v12`); último respaldo `v12-respaldos/world-20260930-0725.sqlite.gz` (gzip íntegro). **No arrancarlo.** Detalle de su publicación:

| Qué | Valor |
|---|---|
| URL | <https://atlas.humanizar.tech> |
| Código compilado y servido | `ced1fec` desde el 28-09 20:59 -05 ([contrato](evidencia-2026-09-28/publication-v12.json)): reglas 11 + poda de leyes refutadas (NAT-L, vocación), T100, arreglo de HOG-2010 y del tope fijo de identidades (`MAX_LEGACY_CACHE`); sin cambio de dinámica con parámetros por defecto |
| Ley activada | **COM**: `social.radioConvivencia=12` (la pertenencia a una comunidad sigue a la convivencia y la confianza, con fisión por distancia), activada por `CARTA_PARAMS` y persistida. Cribado preregistrado de 6 semillas × 60 días: comunidades vivas 5/6, natalidad 6/6 sin daño, C1–C7 6/6 (contrato) |
| `main` | ver `git log`; lo servido fue `ced1fec` |
| Reglas | `RULES_VERSION` 11 (+ COM por parámetro) |
| Protocolo / SQLite | `PROTOCOL_VERSION` 10 / `user_version` 5 |
| Máquina | Torre: `atlas-publico.service` en 100.64.0.1:3000, código en `AtlasParaIsa-anexo/worktrees/publico-v12` (proceso «carta-isa», drop-in CPUWeight/IOWeight 10000) |
| Mundo | V12, semilla 51926, identidad `3b0a6a0f-ec88-4949-8364-17ac6ec4edab`, creado vacío el 28-09 20:59 -05 en `AtlasParaIsa-anexo/mundos/v12-20260928` (credencial `access.scrypt` copiada de V11: misma contraseña, solo el hash) |
| Parámetros persistidos | `gobernador.presupuestoMs=5000`, `social.radioConvivencia=12` (`CARTA_PARAMS`), gobernador `techo`, límites de admisión del anfitrión y el paquete de reglas 11 |
| Respaldos | `AtlasParaIsa-anexo/publicaciones/v12-respaldos` (timer horario `atlas-respaldo-publico.timer`) |
| Contrato | [publication-v12.json](evidencia-2026-09-28/publication-v12.json) |

Lo que esta publicación **no** acreditó: el criterio de 60 días de [GOAL.md](../GOAL.md) **no se cumple**; C8 falla (con COM la diversidad entre comunidades sube de nivel pero no crece) y su lectura v4 la decide Steven. Límites conocidos de COM: el tope de fundación de 8 comunidades estaba activo y quedaban restos pequeños (la disolución local COM-D′ estaba en diseño; ya integrada en V13). La población la sigue regulando el cupo global de 40 nacimientos/día (D2 pendiente).

- V11 (código `5a36ce6`, reglas 11), servido del 24-09 02:35 al 28-09 20:59 -05; mundo detenido e intacto en `AtlasParaIsa-anexo/mundos/v11-20260924` (día ~815, 642 vecinos, 3 comunidades del día 1); último respaldo `v11-respaldos/world-20260928-2056.sqlite.gz`. **No arrancarlo.** Detalle de su publicación:

| Qué | Valor |
|---|---|
| URL | <https://atlas.humanizar.tech> |
| Código compilado y servido | `5a36ce6` desde el 24-09 02:35 -05 (en el portátil hasta las 08:34, en la torre desde las 08:35: [contrato de la publicación](evidencia-2026-09-24/publication-v11.json), [contrato de la mudanza](evidencia-2026-09-24/publication-v11-torre.json)): reglas 11 (conflicto legible) y el arte del suelo por campo (bordes orgánicos de biomas, desgaste y orillas; agua sin cuadros). Contiene también, **a 0**, las leyes candidatas de C8 (`conducta.vocacion`, `social.hogarTrabajo`) y de natalidad local (`poblacion.natalidadLocal`): el mundo por defecto es bit a bit el de reglas 11 |
| `main` | ver `git log`; lo servido fue `5a36ce6`, no necesariamente el HEAD de `main` |
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


- V10 (código servido por última vez `b5def74`, reglas 10): mundo en `~/atlas-lab/mundos/v10-20260922` del portátil, intacto y detenido el 24-09 02:35 -05 (día ~165, ~700 habitantes); último respaldo `world-20260924-0232.sqlite.gz`. La copia de la torre (`AtlasParaIsa-anexo/mundos/v10-20260922`) es el estado de la mudanza (tick 322 800) y **no debe arrancarse**. Contratos: [publication-v10.json](evidencia-2026-09-22/publication-v10.json), [publication-v10-portatil.json](evidencia-2026-09-23/publication-v10-portatil.json) y [publication-v10-portatil-perf3-e0.json](evidencia-2026-09-23/publication-v10-portatil-perf3-e0.json).
- V7 (`3dd615e`, reglas 7, protocolo 9, SQLite 4): mundo en
  `/datos/workspaces/personal/AtlasParaIsa-anexo/mundos/v7-20260922`, intacto; se extinguió por la política
  `apagar` del gobernador. Contrato: [publication.json](evidencia-2026-09-22/publication.json).
- Publicaciones anteriores a V7: registros históricos en [EVIDENCIA](EVIDENCIA.md).

## Trabajo en curso

- Revisiones vigentes: [REVISION-2026-09-24](REVISION-2026-09-24.md),
  [REVISION-2026-09-22](REVISION-2026-09-22.md) y
  [REVISION-NOCHE-2026-09-22](REVISION-NOCHE-2026-09-22.md).
- `specs/002-mundo-ilimitado/`: etapas B–F descongeladas el 2026-09-23 (decisión de Steven: la escala en paralelo a
  la biología). Ya integrados en `main` y desplegados en V13 (`c7b3bb3`): PERF3 (sin copia del mundo en pasos sin
  gestos), bloque E.0 olas 1–2 (T141–T143 y `b5def74`), Etapa B tareas T111–T114 y T116 (halo, terreno SoA,
  activación O(1), port SoA de ecología y máscara de fauna), Etapa D tareas T134 y T136 (viewport/censo y compresión
  WS), y T100 (cerrada funcionalmente el 2026-09-28, [T100-LIMITES-CONTRATO](T100-LIMITES-CONTRATO.md)).
  La ola 2 de B (T115/T117/T120, en ramas `sprint/t115..t120-20260930`) sigue pendiente de integración y Gate B
  (T118/T119) porque el perfil a 700 habitantes (bitácora 23-09 17:50) señala enseñanza/recetas (20 %), fauna (13 %)
  y ecología (7 %) como coste dominante (decisión D4). De la etapa A siguen abiertas T103 y T104 (superadas por
  ARCH/PERF3 y ese perfil, pendientes de reescritura) y el Gate A (T110), según
  [tasks.md](../specs/002-mundo-ilimitado/tasks.md).
- `specs/001-mundo-solido-masivo/`: cerrada el 2026-09-19.

## Cómo se actualiza

Al publicar, con el procedimiento de CLAUDE.md/AGENTS.md: nuevo `publication-*.json` con el commit, el gate y las
comprobaciones en vivo; después, esta tabla y la sección de anteriores, y `npx tsx scripts/check-links.ts`
para no dejar enlaces rotos. Ningún otro documento repite
el commit vigente; CLAUDE.md/AGENTS.md nombran además el directorio del mundo para que ningún agente lo toque.
