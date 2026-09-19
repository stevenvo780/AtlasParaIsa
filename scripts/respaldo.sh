#!/usr/bin/env bash
# T022 — Respaldo horario del mundo de Isa (hueco del crítico: 6,1 GiB/día, sin respaldo).
#
# Copia consistente vía la API de respaldo online de SQLite (`.backup`): segura con WAL
# y con el servidor escribiendo a la vez (no es un `cp` del fichero). Abre "$DB" con
# `sqlite3 -readonly`: solo LEE, nunca escribe ni borra el mundo. Sin -readonly, cuando
# este proceso es la ÚNICA conexión (servidor parado, WAL pendiente sin checkpointear),
# SQLite haría un checkpoint automático al cerrar la conexión de respaldo y modificaría
# el fichero original — -readonly evita esa escritura incluso en ese caso. La copia se
# verifica con PRAGMA quick_check antes de comprimirla; si falla, se descarta y el
# script termina en error (sin rescates ocultos: una copia dudosa nunca cuenta como
# éxito).
#
# Variables de entorno:
#   DB          ruta del mundo a copiar (por defecto "${CARTA_DATA_DIR:-data}/world.sqlite",
#               igual convención que el resto del proyecto — ver src/server/main.ts).
#   DEST        directorio de destino de las copias (por defecto
#               "$HOME/.local/state/atlas-para-isa/backups").
#   RETENCION   número de copias a conservar (por defecto 48; a razón de una por hora,
#               son 2 días de historial).
#
# Uso manual:  npm run respaldo
# Uso automático: scripts/systemd/atlas-respaldo.{service,timer} (T022; T043 lo activa).
set -euo pipefail

DB="${DB:-${CARTA_DATA_DIR:-data}/world.sqlite}"
DEST="${DEST:-$HOME/.local/state/atlas-para-isa/backups}"
RETENCION="${RETENCION:-48}"

if [ ! -f "$DB" ]; then
  echo "respaldo.sh: no existe la base de datos '$DB'" >&2
  exit 1
fi

umask 077
mkdir -p -m 700 "$DEST"

marca="$(date +%Y%m%d-%H%M)"
copia="$DEST/world-$marca.sqlite"

if [ -e "$copia" ] || [ -e "$copia.gz" ]; then
  echo "respaldo.sh: ya existe una copia para esta marca ($copia.gz)" >&2
  exit 1
fi

sqlite3 -readonly "$DB" ".backup '$copia'"

verificacion="$(sqlite3 "$copia" 'PRAGMA quick_check;')"
if [ "$verificacion" != "ok" ]; then
  rm -f "$copia"
  echo "respaldo.sh: la copia no pasó PRAGMA quick_check: $verificacion" >&2
  exit 1
fi

chmod 600 "$copia"
gzip -f "$copia"

# Retención: conserva solo las últimas $RETENCION copias por fecha de modificación
# (la más nueva primero); el resto se borra. Sin rm -rf amplio: solo ficheros
# "world-*.sqlite.gz" dentro de $DEST, uno a uno.
mapfile -t antiguas < <(ls -1t "$DEST"/world-*.sqlite.gz 2>/dev/null | tail -n "+$((RETENCION + 1))")
if [ "${#antiguas[@]}" -gt 0 ]; then
  rm -f -- "${antiguas[@]}"
fi

echo "respaldo.sh: copia verificada en $copia.gz"
