# Estado publicado

Única fuente de «qué está publicado». README, PLAN y CLAUDE.md enlazan aquí en vez de copiar
estas cifras. Se actualiza en cada publicación, junto con su contrato
`docs/evidencia-AAAA-MM-DD/publication*.json`; si este fichero y el contrato discrepan, manda
el contrato.

## Vigente (desde el 22 de septiembre de 2026, 20:46–20:50 -05)

| Qué | Valor |
|---|---|
| URL | <https://atlas.humanizar.tech> |
| Código compilado y servido | `eeb4bcf` (build tras detener el servicio; assets servidos = compilados) |
| `main` | `e385acb`. Desde `eeb4bcf` solo cambian documentación y el script `npm start`, que desde entonces ejecuta node con el nombre de proceso `carta-isa`; el proceso en marcha arrancó antes de ese commit y adopta el nombre en el próximo reinicio |
| Reglas | `RULES_VERSION` 10: paquete de natalidad por defecto (cortejo 2, radio 128, comunidad opcional, comprobación continua, habituación 0,35) y gobernador `techo` |
| Protocolo | `PROTOCOL_VERSION` 10 |
| SQLite | `user_version` 5 (instantáneas paginadas) |
| Mundo | V10 nuevo, semilla 51926, identidad `63033163-3a01-45cb-829a-004a0dc0ce65`, creado desde un directorio inicialmente vacío: `/datos/workspaces/personal/AtlasParaIsa-worlds/v10-20260922` |
| Parámetros persistidos | `persistencia.cadaTicks=100`, `gobernador.politica=techo` y el paquete de reglas 10 (lista completa en el contrato) |
| Respaldos | `/datos/workspaces/personal/AtlasParaIsa-publications/20260922-v10/backups` (timer horario `atlas-respaldo.timer`) |
| Servicios | `atlas-servidor.service` y `atlas-respaldo.service` de usuario; leen `~/.config/atlas-para-isa/runtime.env` (solo `CARTA_DATA_DIR` y `DEST`). Copias versionadas de las unidades (las instaladas son copias): `docs/ops/atlas-servidor.service` y `scripts/systemd/atlas-respaldo.{service,timer}` |
| Gate | `scripts/deploy-check.sh eeb4bcf` verde: typecheck, suite 1362/1366 (4 omitidos, 0 fallos, 201,5 s), build y smoke del commit exacto |
| Contrato | [publication-v10.json](evidencia-2026-09-22/publication-v10.json) |

Lo que esta publicación **no** acredita: el criterio de 60 días de [GOAL.md](../GOAL.md) no se ha
evaluado todavía; el crecimiento en laboratorio es casi exponencial hasta que lo frena el gobernador
por hardware ([revisión de la noche](REVISION-NOCHE-2026-09-22.md)).

## Anteriores, conservados

- V7 (`3dd615e`, reglas 7, protocolo 9, SQLite 4): mundo en
  `/datos/workspaces/personal/AtlasParaIsa-worlds/v7-20260922`, intacto; se extinguió por la política
  `apagar` del gobernador. Contrato: [publication.json](evidencia-2026-09-22/publication.json).
- Publicaciones anteriores a V7: registros históricos en [EVIDENCIA](EVIDENCIA.md).

## Trabajo en curso

- Revisiones vigentes: [REVISION-2026-09-22](REVISION-2026-09-22.md) y
  [REVISION-NOCHE-2026-09-22](REVISION-NOCHE-2026-09-22.md).
- `specs/002-mundo-ilimitado/`: etapas B–F congeladas hasta que los 16 fundadores lleguen a 100 días
  con 3 generaciones en el 90 % de las semillas; de la etapa A sigue abierta T100.
- `specs/001-mundo-solido-masivo/`: cerrada el 2026-09-19.

## Cómo se actualiza

Al publicar, con el procedimiento de CLAUDE.md: nuevo `publication-*.json` con el commit, el gate y las
comprobaciones en vivo; después, esta tabla y la sección de anteriores. Ningún otro documento repite
el commit vigente; CLAUDE.md nombra además el directorio del mundo para que ningún agente lo toque.
