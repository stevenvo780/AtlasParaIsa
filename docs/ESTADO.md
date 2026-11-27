# Estado publicado

Única fuente de «qué está publicado». README, PLAN y CLAUDE.md/AGENTS.md enlazan aquí en vez de copiar
estas cifras. Se actualiza en cada publicación, junto con su contrato
`docs/evidencia-AAAA-MM-DD/publication*.json`; si este fichero y el contrato discrepan, manda
el contrato.

## Vigente (mundo nuevo V24 desde el 27 de noviembre de 2026, 16:28:46 -05, en la torre)

El mundo anterior abrió con `de86ec9` y completó la observación de su primera hora a las 02:19:10 -05. A las 10:59:41 -05 se publicó `3188026` sobre el mismo mundo y la misma cinta. Al mediodía se verificó `5544fec`, con la barra compacta. A las 12:11:41 -05 se verificó `6547f12`, que abre la ficha detallada al seleccionar al habitante. A las 12:26:40 -05 se verificó `0b5889d`, con los refugios materiales de una celda y la recuperación de la ficha tras mover el cabezal. A las 16:24:39 -05 se verificó `5af48b2`, con las recetas y reacciones registradas en el panel de Oficios. [Publicación inicial de V24](evidencia-2026-11-27/publication-v24.json) · [Relevo del visor](evidencia-2026-11-27/publication-v24-visor.json) · [Barra y fichas](evidencia-2026-11-27/publication-v24-barra-fichas.json) · [Ficha con un clic](evidencia-2026-11-27/publication-v24-ficha-directa.json) · [Refugios y ficha al recorrer Historia](evidencia-2026-11-27/publication-v24-refugios-ficha.json) · [Técnica grabada](evidencia-2026-11-27/publication-v24-tecnica-grabada.json).

A las 16:28:46 -05 se abrió un mundo nuevo con el visor publicado y una cinta independiente. Se comprobó el detalle corporal de los 16 habitantes en el paso 1 y el guardado del paso 400. Se archivó la apertura detallada del paso 1 al 397. [Contrato del mundo nuevo](evidencia-2026-11-27/publication-v24-mundo-inicio.json).

El perfil de la presentación pública reabrió ese mismo mundo desde el paso 24.874 y conservó su cinta. La RTX 5070 Ti y la RTX 2060 aceptaron resultados de percepción. En la primera medición de 13,24 s, el motor avanzó 18,36 pasos/s, la cinta llegó al paso 25.599 y el guardado durable al 25.600, con 72 habitantes registrados. Las dos réplicas de Atlas en la torre quedaron pausadas de forma reversible. [Relevo y medición](evidencia-2026-11-27/publication-v24-presentacion.json).

Oficios reintenta la cinta si falla la primera consulta y ofrece «Reintentar la cinta» si vuelve a fallar. El panel y el resumen superior muestran el alcance de la vista. En un fotograma del mundo público renderizado en Chromium a 1920×1080, ambos indicaron 15 habitantes con recetas. El panel mostró tres recetas distintas y una reacción aplicada. [Verificación de Oficios](evidencia-2026-11-27/publication-v24-oficios.json).

La revisión del visor comprobó las pestañas de Mundo y Vidas, las fichas de persona, fauna, obra y tesela, y los modales y controles de observación. Historia usa el fotograma elegido. Rendimiento distingue la medición grabada del monitor actual. Las vistas resumidas indican qué omitió la grabación. Materia muestra el catálogo y la última reacción recibidos con sus propios datos. El libro global de inventario material queda fuera de los fotogramas de la cinta actual. [Auditoría del visor](evidencia-2026-11-27/publication-v24-visor-auditado.json).

| Qué | Perfil de V24 |
|---|---|
| Código compilado y servido | `be50290`, worktree detached `AtlasParaIsa-anexo/worktrees/v24-auditoria-visor` con Node 22.23.3. El dominio sirve `/assets/index-DlYvI6Lw.js`. |
| Servicio y acceso | `atlas-publico.service` en `100.64.0.1:3000`, una sola instancia. [Dominio público](https://atlas.humanizar.tech). |
| Mundo | `AtlasParaIsa-anexo/mundos/v24-inicio-20261127-1627`, semilla 3159104107, instancia `d5af3361-7465-4326-97fa-f95c1aad30fc`. El mundo anterior y su cinta quedaron conservados. |
| Reglas | `RULES_VERSION = 14`. Motor abierto Turbo con 32 dueños CPU y ambas GPU para percepción, con grupos intercalados de 24 dueños en la RTX 5070 Ti y 8 en la RTX 2060. El selector por coste conserva la ruta CPU para los lotes que resuelve más rápido. Activadas materia, cuerpos, fauna, cohesión, natalidad, comunidades, técnica, obra e intentos. |
| Guardado | Hilo persistidor, cortes vivos transferibles de teselas y personas, adelanto de hasta tres pasos y `snapshot-parts-v5` con pesos por UID separados. `persistencia.cadaTicks=200`, `persistencia.ventanaEventosTicks=2400` y `red.deltas=true`. |
| Cinta y visor | En `AtlasParaIsa-anexo/mundos/v24-inicio-20261127-1627-cinta`. Cinta dedicada `CNT2` de niveles n0–n4, catálogo `cinta.idx.sqlite`, tope de 50 GB decimales, fotogramas por dueño y sucesos directos. Historia abre en **Tiempo real** (1 segundo del mundo por segundo) salvo preferencia guardada. **Paseo** reproduce un paso por segundo y **Borde vivo** sigue al motor. |
| Versiones | `PROTOCOL_VERSION` 10, SQLite de mundo `user_version` 5 y catálogo de cinta `user_version` 4. |
| Respaldos | Mundo y cinta en `/mnt/Data2/respaldos-atlas-v24-inicio-20261127-1627` y su subdirectorio `cinta`, con sendos timers horarios activos. |
| Perfil y lanzador | [perfil-v24.sh](../scripts/systemd/torre/perfil-v24.sh) · [perfil-presentacion-v24.sh](../scripts/systemd/torre/perfil-presentacion-v24.sh) · [publico-v24.sh](../scripts/systemd/torre/publico-v24.sh). |

En el mundo anterior, el censo de las 11:00 -05 registró **787 habitantes** en el paso 153800. En una vista detallada del paso 154065, los 134 habitantes tenían cuerpo y técnica registrados, 92 recordaban recetas y 535 de 538 construcciones mostraban piezas. La vista incluía una reacción aplicada en el paso 154000. En el nivel resumido de esa zona se conservaron las piezas y la reacción, aunque se omitieron los detalles individuales.

El visor consulta una sola casilla si el tramo resumido conserva detalle, tanto al seleccionar un habitante como al aterrizar tras mover el cabezal o avanzar un fotograma. La ficha usa datos del mismo habitante, paso y época. A 1920×1080, con la ficha abierta, la barra ocupa 860×52 px y la pista dispone de 480 px para recorrer la historia.

### Puertas anteriores al corte

- **Software por tandas.** 3.342 casos acreditados (3.289 pasan, 53 omitidos). La ejecución monolítica de `83b7cc3` conservó dos fallos. El dictamen incorpora T151 7/7 en `83b7cc3` y cinta 10/10 en `de86ec9`. Entre `38d26b3` y `de86ec9` cambiaron dos archivos de prueba y se cotejaron 784 blobs ajenos a pruebas. El smoke aislado de despliegue en `de86ec9` pasó 10/10.
- **Panel de motor en `38d26b3`.** 8/8 semillas vivas al día 30, T72000, con saldo exacto y cero violaciones en todas. El mínimo era 6/8. El contrato conserva los ocho resultados y los sellos del cierre.
- **Observación de laboratorio en `38d26b3`.** Fedora, 120 minutos y 241/241 respuestas `200`. Latencia p95 de `/health` de 1,536 ms. Avance visible T481→T39017 y durable T400→T39000. Reabrió en T39022, época 1, conservó el fotograma DVR T19501 y reanudó el avance. Chromium en 1440×900, 390×844 y 320×720.

### Corte y primera hora

El dominio respondió `200` y el HTML y los assets coincidieron con el build. Las solicitudes sin sesión a `/api/cinta/meta` y `/api/cinta/chunk` respondieron `401`. Las lecturas de salud avanzaron de T396 a T566 y el guardado durable confirmó T400, época 0, con materia. Se verificó por lectura local el fotograma T397 de L0. El respaldo inicial del mundo pasó `gzip -t` y el catálogo respaldado de cinta pasó `quick_check` y `foreign_key_check`. Los recibos están enumerados en el contrato.

La **primera hora** completó 121/121 respuestas `200`, sin errores HTTP, diagnósticos duros, recargas ni muestras degradadas. El tick visible avanzó de T433 a T47603 y el durable, de T400 a T47600. La latencia p95 del dominio fue de 617,259 ms y el uso p95 del hilo principal de 0,067 %. El RSS pasó de una mediana de 903,3 MiB en el primer cuarto a 1.240,4 MiB en el último, con pico de 1.337,2 MiB. El crecimiento observado no permite afirmar que la memoria haya alcanzado una meseta.

Los **primeros respaldos programados** de las 02:00 -05 cerraron con código 0. Se verificaron el archivo del mundo `world-20261127-0200.sqlite.gz` y el respaldo L1–L4 de la cinta `cinta-20261127T070007Z-WQRDjTLW`. El contrato enlaza los recibos.

El **panel de 60 días** está en curso. Se verificaron ocho de ocho arranques en laboratorio, seis en la torre y dos en Fedora, con réplicas nuevas de `de86ec9` independientes del mundo público y del panel de 30 días. La verificación de arranque acredita la configuración inicial. El resultado de 60 días queda pendiente.

## Anteriores, conservados

- V22 (`a7ec79b`, worktree `publico-v22`) se detuvo durante el corte del 27 de noviembre. Atendía en la **ruta histórica del mundo V21**, `AtlasParaIsa-anexo/mundos/v21-20261124`, con `world.tape.sqlite` y `/api/tape/*`. La fase de parada comenzó a las 00:51:36 -05. El conjunto frío verificado queda en `/mnt/Data2/vuelta-atlas-v22-de86ec9`, con restauración comprobada en T127580. El expediente `archivo/v24-orquesta/corte-de86ec9/VUELTA-V22.md` conserva el lanzador fijado y los pasos de retorno, incluso con `main` adelantado. V23 no se publicó.

### V21 (mundo abierto el el 24 de noviembre de 2026, 09:56 -05, en la TORRE)

| Qué | Valor |
|---|---|
| URLs | Público: <https://atlas.humanizar.tech> · VPN (Tailscale): `https://100.64.0.1:3443` · LAN: `https://192.168.78.211:3443` (excepción explícita de Steven sobre origen único: `CARTA_EXTRA_ORIGINS` empareja estrictamente `Host ↔ Origin` en HTTPS con cookie `Secure` y `access.scrypt`) |
| Código compilado y servido | `2b93250` (despliegue inicial `ebcabe0` a las 09:56 -05 + relevo en caliente a `2b93250` a las 10:19 -05 sobre el mismo mundo V21 sin reinicio; `publico-v21` en `ebcabe0` conservado para rollback; [contrato V21](evidencia-2026-11-24/publication-v21.json)): **motor Turbo sin tope de FPS (`CARTA_TURBO=1`, `tickMs=0`) + cinta DVR independiente en SQLite WAL (`world.tape.sqlite`, `auto_vacuum=INCREMENTAL`, keyframes gzip cada 60 pasos + parches incrementales por campo/tecnología/estadísticas/planos/comunidades + supresión de micro-deriva ecológica, anillo rodante de 20 000 fotogramas ≈ 8,3 días simulados / ~55 min de reproducción a 1×) + reproductor cine a 60 fps en cliente** (Play/Pausa `Espacio`, velocidades `0,5×`–`25×`, paso a paso `,`/`.`, línea temporal con sparkline SVG y vista previa, `⚡ Motor: X Hz · +N adelantados` y `● Borde vivo`) + **modo observador puro (`CARTA_OBSERVER_ONLY=1`)** sin órdenes directas a NPC (`410` en HTTP/WS) + **corrección demográfica de construcción modular** (verificada en 4/4 semillas tras la ablación de V20) + todos los pilares V20/V19/V18 (química algebraica conservada `C/Si/Ca/Fe/S/H`, edificios poliominó con sinergias locales, caminos estigmérgicos y empedrado autónomo, cultivos en 4 etapas, 28 hilos CPU + Dual-GPU `[0,1]`, heap V8 64 GiB) |
| Ley activada | **V21 abierto (`RULES_VERSION = 14`, `CARTA_OPEN_WORLD=1`, `CARTA_SIM_WORKER=1`, `CARTA_TURBO=1`, `CARTA_TAPE=1`, `CARTA_OBSERVER_ONLY=1`)**: `motor.hilos=28`, `motor.gpu=[0,1]`, `motor.soaTerreno=true`, `motor.particionarPersonas=true`, química algebraica + edificios poliominó + caminos estigmérgicos + factores V19 (`L/S/B/T/F/R/M/E` con `construccion.modular` corregida), `agua.cuencas=0.36`, `poblacion.natalidadVecindad=true` (`radioVecindadNatalidad=16`), `social` (`radioConvivencia=12`, `disolucion=1`, `maxComunidades=0`), `red.deltas=true`, `gobernador.presupuestoMs=5000` (`techo`), `persistencia.cadaTicks=200`, `persistencia.ventanaEventosTicks=2400` y admisión `limites.chunks=65536` |
| `main` | ver `git log`; lo servido es `2b93250` |
| Reglas | `RULES_VERSION` 14 (`CARTA_OPEN_WORLD=1`, defaults históricos conservados en `DEFAULT_PARAMS`) |
| Protocolo / SQLite | `PROTOCOL_VERSION` 10 / mundo `user_version` 5 / cinta DVR `user_version` 1 |
| Máquina | Torre: `atlas-publico.service` en `100.64.0.1:3000` + `atlas-lan-tls.service` en `100.64.0.1:3443` y `192.168.78.211:3443`, código en `AtlasParaIsa-anexo/worktrees/publico-v21-r3` (`publico-v21`, `publico-v20` y anteriores conservados para rollback; proceso «carta-isa», `NODE_OPTIONS=--max-old-space-size=65536`, drop-in CPUWeight/IOWeight 10000, `COMPUTE_NVRTC=/opt/cuda/lib64/libnvrtc.so`, ambas GPU RTX 5070 Ti + RTX 2060 activas en VRAM). No arrancar servicios del portátil ni `atlas-servidor`/`atlas-respaldo` de la torre |
| Mundo | V21, semilla 51926, identidad `8eed7817-14f4-44c2-8aca-8ceb14dbd411`, creado vacío el 24-11 09:56 -05 en NVMe `/datos/workspaces/personal/AtlasParaIsa-anexo/mundos/v21-20261124` (credencial `access.scrypt` copiada de V20) |
| Parámetros persistidos | `CARTA_OPEN_WORLD=1`, `CARTA_SIM_WORKER=1`, `CARTA_TURBO=1`, `CARTA_TAPE=1`, `CARTA_OBSERVER_ONLY=1`, `CARTA_TAPE_MAX_FRAMES=20000` + `CARTA_PARAMS` (`gobernador.presupuestoMs=5000`, `persistencia.cadaTicks=200`, `persistencia.ventanaEventosTicks=2400`, `red.deltas=true`, `limites.chunks=65536`, `teselasActivas=16777216`, `comunidades=16777216`, `fauna=100663296`), gobernador `techo` y reglas 14 |
| Respaldos | HDD `/mnt/Data2/respaldos-atlas-v21` (timer horario `atlas-respaldo-publico.timer`, `RETENCION=24`, `RESPALDO_METODO=backup`, `MemoryHigh=3G`, `IOSchedulingClass=idle`, `Nice=15`) |
| Contrato | [publication-v21.json](evidencia-2026-11-24/publication-v21.json) |

Lo que acreditó la publicación V21: ablación de 9 brazos sobre V20 aislando la extinción mortal en `construccion.modular=true` (`V20_ALL pop=8` vs `NO_B_modular pop=93`) y corrección validada al día 15 en 4/4 semillas (`51926`: `pop=47, births=52, structs=75, chemFormulas=209`; `19104`: `pop=29`; `19101`: `pop=23`; `19103`: `pop=21`, cero extinciones); `53/53` pruebas V21 (`v21-tape-store`, `v21-turbo-server`, `v21-dvr-client`) y `180/180` pruebas de regresión unificada en 25 suites (`0` fallos); banco de cinta 500k teselas / 1 500 habitantes (`keyframe 47,9 KB`, `delta 262 B`, `182,6×` menor); `deploy-check.sh 2b93250` salida `0` (`10/10` smoke PASS); `gpuAutoprueba` PASS en GPU 0 (`14,20 ms`) y GPU 1 (`7,25 ms`); verificación viva en público (`200`), LAN (`2–5 ms`, `observerOnly=true, tapeEnabled=true, turbo=true`), `403` en `POST /api/login` de origen ajeno y `401` en `/api/tape/*` sin sesión; en vivo al día 8 (`tick 17 897`, ~24 min reales): `simHz=18,6 Hz` (`p50=8,68 ms`), `44` habitantes vivos (`30` nacimientos, `2` muertes), `7` comunidades, `45` estructuras, `130` fórmulas químicas, `25` teselas empedradas, deltas medios `17,1 KB` (`36,4 MiB` para 1 378 fotogramas, `auto_vacuum=INCREMENTAL`) y respaldo íntegro `/mnt/Data2/respaldos-atlas-v21/world-20261124-1020.sqlite.gz` (`17 MiB`, `gzip -t` OK).

- V20 (código `e7331ed`, reglas 14 + `CARTA_OPEN_WORLD=1` + `CARTA_SIM_WORKER=1`), servido del 24-11 01:58 al 24-11 09:56 -05 (alcanzó el día 118,35, tick 284 044, 90 fórmulas químicas, 373 recetas archivadas, 2 731 chunks archivados; 171,3 MiB SQLite, pero los mortales se extinguieron hacia el día 17 dejando solo a S e I vivos — `people=2`, `births=14` — por el atasco en `construccion.modular` corregido en V21); mundo detenido e intacto en `AtlasParaIsa-anexo/mundos/v20-20261124` (worktree `publico-v20`); último respaldo antes del corte `/mnt/Data2/respaldos-atlas-v20/world-20261124-0954.sqlite.gz` (50 MiB, `gzip -t` OK). **No arrancarlo.**

- V19 (código `f953b11`, reglas 13 + `CARTA_OPEN_WORLD=1`), servido del 24-11 00:57 al 24-11 01:58 -05 (alcanzó el día 14,66, tick 35 174, 3 vivos, 13 nacimientos; 99,9 MiB SQLite; afectado ya por la misma regresión modular); mundo detenido e intacto en `AtlasParaIsa-anexo/mundos/v19-20261124` (worktree `publico-v19`); último respaldo `/mnt/Data2/respaldos-atlas-v19/world-20261124-0155.sqlite.gz` (23 MiB). **No arrancarlo.**

- V18 (código inicial `8be94ea`, relevo en caliente `4c97666`, reglas 12 + `CARTA_OPEN_WORLD=1`), servido del 22-11 21:24 al 24-11 00:55 -05 (alcanzó el día 91,75, tick 220 200, **10 210 vivos**, 16 500 nacimientos, 1 210 comunidades, 2 033 estructuras, 11 579 chunks archivados; 5,42 GiB SQLite); mundo detenido e intacto en `AtlasParaIsa-anexo/mundos/v18-20261122` (worktrees `publico-v18`, `publico-v18-r2`); último respaldo antes del corte `/mnt/Data2/respaldos-atlas-v18/world-20261124-0054.sqlite.gz` (920 MiB). **No arrancarlo.** Contratos: [publication-v18-r2.json](evidencia-2026-11-23/publication-v18-r2.json), [publication-v18.json](evidencia-2026-11-22/publication-v18.json).

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
