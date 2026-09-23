# Estado publicado

Única fuente de «qué está publicado». README, PLAN y CLAUDE.md enlazan aquí en vez de copiar
estas cifras. Se actualiza en cada publicación, junto con su contrato
`docs/evidencia-AAAA-MM-DD/publication*.json`; si este fichero y el contrato discrepan, manda
el contrato.

## Vigente (mundo V10 desde el 22 de septiembre de 2026, 20:46 -05; código actual desde el 23 de septiembre, 10:37 -05)

| Qué | Valor |
|---|---|
| URL | <https://atlas.humanizar.tech> |
| Código compilado y servido | `0ea1514` (reinicio del mismo mundo el 23-09 a las 10:37 -05; build tras detener el servicio; assets servidos = compilados). Sobre `4df4455` añade la retención verificable del archivo de recibos de tecnología (ventana de 24 000 ticks, frontera V2 sellada) |
| `main` | `0ea1514` |
| Reglas | `RULES_VERSION` 10: paquete de natalidad por defecto (cortejo 2, radio 128, comunidad opcional, comprobación continua, habituación 0,35) y gobernador `techo` |
| Protocolo | `PROTOCOL_VERSION` 10 |
| SQLite | `user_version` 5 (instantáneas paginadas) |
| Mundo | V10 nuevo, semilla 51926, identidad `63033163-3a01-45cb-829a-004a0dc0ce65`, creado desde un directorio inicialmente vacío: `/datos/workspaces/personal/AtlasParaIsa-worlds/v10-20260922` |
| Parámetros persistidos | `persistencia.cadaTicks=100`, `gobernador.politica=techo`, `gobernador.presupuestoMs=5000` desde el 23-09 10:46 -05 (antes 50: el techo solo se fija si el p95 del paso pasa de 5 s; el mundo crece y se vuelve más lento a medida que crece) y el paquete de reglas 10 (lista completa en el contrato) |
| Respaldos | `/datos/workspaces/personal/AtlasParaIsa-publications/20260922-v10/backups` (timer horario `atlas-respaldo.timer`) |
| Servicios | `atlas-servidor.service` y `atlas-respaldo.service` de usuario; leen `~/.config/atlas-para-isa/runtime.env` (solo `CARTA_DATA_DIR` y `DEST`); el servidor lleva el drop-in `crecimiento.conf` (`CPUWeight=10000`, `CARTA_PARAMS=gobernador.presupuestoMs=5000`). Copias versionadas de las unidades (las instaladas son copias, no enlaces): `scripts/systemd/` |
| Gate | `scripts/deploy-check.sh 0ea1514` verde (build y smoke); suite 1433/1444 (7 omitidos a propósito, 4 cancelados por carga y verdes aislados 40/40, 0 fallos); verificación independiente de la poda por Codex y Grok (un alto corregido en `e1639d7`) |
| Contrato | [publication-v10.json](evidencia-2026-09-22/publication-v10.json) (mundo), [publication-v10-pub2.json](evidencia-2026-09-23/publication-v10-pub2.json) y [publication-v10-pub3.json](evidencia-2026-09-23/publication-v10-pub3.json) (reinicios del 23-09) |

Lo que esta publicación **no** acredita: el criterio de 60 días de [GOAL.md](../GOAL.md) se evaluó en el laboratorio el 23-09 y **no se cumple** con estas reglas (ver [EVIDENCIA](EVIDENCIA.md)); el servidor corre en SCHED_IDLE (falta la regla de root) y la base ocupa 3,2 GB aunque ya se poda (no encoge sin VACUUM); el gobernador mantiene ~150 habitantes porque el paso tarda ~230 ms frente a 50 ms de presupuesto (PERF3 en curso); el crecimiento en laboratorio es casi exponencial hasta que lo frena el gobernador
por hardware ([revisión de la noche](REVISION-NOCHE-2026-09-22.md)).

## Anteriores, conservados

- V7 (`3dd615e`, reglas 7, protocolo 9, SQLite 4): mundo en
  `/datos/workspaces/personal/AtlasParaIsa-worlds/v7-20260922`, intacto; se extinguió por la política
  `apagar` del gobernador. Contrato: [publication.json](evidencia-2026-09-22/publication.json).
- Publicaciones anteriores a V7: registros históricos en [EVIDENCIA](EVIDENCIA.md).

## Trabajo en curso

- Revisiones vigentes: [REVISION-2026-09-22](REVISION-2026-09-22.md) y
  [REVISION-NOCHE-2026-09-22](REVISION-NOCHE-2026-09-22.md).
- `specs/002-mundo-ilimitado/`: etapas B–F descongeladas el 2026-09-23 (decisión de Steven: la escala en paralelo a
  la biología). En curso: PERF3 (sin copia del mundo en los pasos sin gestos) y el bloque E.0 (T141–T143: fuera los
  cuadráticos por habitante). La etapa A está integrada en `main`; siguen abiertas T100, T103, T104 y el Gate A (T110),
  según [tasks.md](../specs/002-mundo-ilimitado/tasks.md).
- `specs/001-mundo-solido-masivo/`: cerrada el 2026-09-19.

## Cómo se actualiza

Al publicar, con el procedimiento de CLAUDE.md: nuevo `publication-*.json` con el commit, el gate y las
comprobaciones en vivo; después, esta tabla y la sección de anteriores, y `npx tsx scripts/check-links.ts`
para no dejar enlaces rotos. Ningún otro documento repite
el commit vigente; CLAUDE.md nombra además el directorio del mundo para que ningún agente lo toque.
