# Estado publicado

Única fuente de «qué está publicado». README, PLAN y CLAUDE.md enlazan aquí en vez de copiar
estas cifras. Se actualiza en cada publicación, junto con su contrato
`docs/evidencia-AAAA-MM-DD/publication*.json`; si este fichero y el contrato discrepan, manda
el contrato.

## Vigente (mundo V10 desde el 22 de septiembre de 2026, 20:46 -05; código actual desde el 23 de septiembre, 10:37 -05; en el portátil desde las 11:17 -05)

| Qué | Valor |
|---|---|
| URL | <https://atlas.humanizar.tech> |
| Código compilado y servido | `b5def74` desde el 23-09 15:47 -05 en el portátil: PERF3 y E.0 olas 1 y 2, el mismo mundo bit a bit ([contrato](evidencia-2026-09-23/publication-v10-portatil-perf3-e0.json)). Antes `b754487` (13:01) (tope de metadatos de la instantánea 8 → 256 MiB tras la pausa de las 12:53; [contrato](evidencia-2026-09-23/publication-v10-portatil-hotfix.json)). Antes `0ea1514` (reinicio del mismo mundo el 23-09 a las 10:37 -05; build tras detener el servicio; assets servidos = compilados). Sobre `4df4455` añade la retención verificable del archivo de recibos de tecnología (ventana de 24 000 ticks, frontera V2 sellada) |
| `main` | ver `git log`; lo servido en el portátil es `b5def74`, no el HEAD de `main` |
| Reglas | `RULES_VERSION` 10: paquete de natalidad por defecto (cortejo 2, radio 128, comunidad opcional, comprobación continua, habituación 0,35) y gobernador `techo` |
| Protocolo | `PROTOCOL_VERSION` 10 |
| SQLite | `user_version` 5 (instantáneas paginadas) |
| Máquina | **Portátil de Steven** (i7-12700H, servicio `atlas-publico.service`, 100.64.0.2:3000 por tailnet) desde el 23-09 11:17 -05; el dominio llega por el puente TCP `atlas-puente.service` de la torre (100.64.0.1:3000 → 100.64.0.2:3000). La torre queda solo como laboratorio |
| Mundo | V10, semilla 51926, identidad `63033163-3a01-45cb-829a-004a0dc0ce65`, creado desde un directorio inicialmente vacío en la torre y mudado al portátil con el corte inicial de la mudanza (tick 322 800, 187 habitantes; respaldo `world-20260923-1114`, mismo sha256 a ambos lados): `~/atlas-lab/mundos/v10-20260922` del portátil. Estado vivo verificado el 23-09 ~17:30: ~día 167, 710 habitantes, 1957 nacimientos (balance-final.json). La copia de la torre (`/datos/workspaces/personal/AtlasParaIsa-anexo/mundos/v10-20260922`) queda congelada en el tick de la mudanza y su servicio deshabilitado |
| Parámetros persistidos | `persistencia.cadaTicks=100`, `gobernador.politica=techo`, `gobernador.presupuestoMs=5000` desde el 23-09 10:46 -05 (antes 50: el techo solo se fija si el p95 del paso pasa de 5 s; el mundo crece y se vuelve más lento a medida que crece) y el paquete de reglas 10 (lista completa en el contrato) |
| Respaldos | Portátil: `~/atlas-lab/respaldos` (timer horario `atlas-respaldo.timer` del portátil). Torre, hasta la mudanza: `/datos/workspaces/personal/AtlasParaIsa-anexo/publicaciones/20260922-v10/backups` |
| Servicios | Portátil: `atlas-publico.service` (`~/atlas-lab/publico.sh`, drop-in `prioridad.conf`: CPUWeight/IOWeight 10000, P-cores 0-11) y `atlas-respaldo.timer`, con linger. Torre: `atlas-puente.service` (puente TCP, `scripts/systemd/portatil/`); `atlas-servidor.service` y `atlas-respaldo.timer` deshabilitados |
| Gate | Despliegue vigente `b5def74`: `scripts/deploy-check.sh b5def74` verde, digesto idéntico a `main` en 3 semillas × 2400 pasos, suite 1504/1511 (PERF3+E.0 ola 1) y 1513/1520 (E.0 ola 2), 0 fallos ([contrato](evidencia-2026-09-23/publication-v10-portatil-perf3-e0.json)). Gate anterior `0ea1514`: build y smoke verdes, suite 1433/1444 (7 omitidos a propósito, 4 cancelados por carga y verdes aislados 40/40, 0 fallos); verificación independiente de la poda por Codex y Grok (un alto corregido en `e1639d7`) |
| Contrato | [publication-v10.json](evidencia-2026-09-22/publication-v10.json) (mundo), [publication-v10-pub2.json](evidencia-2026-09-23/publication-v10-pub2.json), [publication-v10-pub3.json](evidencia-2026-09-23/publication-v10-pub3.json) (reinicios del 23-09) y [publication-v10-portatil.json](evidencia-2026-09-23/publication-v10-portatil.json) (mudanza al portátil) |

Lo que esta publicación **no** acredita: el criterio de 60 días de [GOAL.md](../GOAL.md) se evaluó en el laboratorio el 23-09 y **no se cumple** con estas reglas (ver [EVIDENCIA](EVIDENCIA.md)); el público depende de que el portátil siga encendido y conectado (se relanza solo al arrancar); la base ocupa ~3 GB aunque ya se poda (no encoge sin VACUUM); el motor es de un solo hilo, así que el mundo usa un núcleo del portátil y se irá frenando al crecer (PERF3 y la ola 1 de E.0 ya integradas y servidas; la ola 1 de la etapa B ya fusionada en `main` pero aún no desplegada al público, que sirve `b5def74`, anterior a ese merge; la ola 2 de B en espera, ver «Trabajo en curso»); la meseta ~690-710 no la pone el gobernador ni el hardware, sino el cupo de software de 40 nacimientos/día (`poblacion.nacimientosPorComprobacion`, balance-final.json); qué pasaría sin ese cupo no está medido
([revisión de la noche](REVISION-NOCHE-2026-09-22.md)).

## Anteriores, conservados

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
