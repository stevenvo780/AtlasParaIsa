#!/usr/bin/env bash
# T022 — Respaldo horario del mundo de Isa (hueco del crítico: 6,1 GiB/día, sin respaldo).
#
# Copia consistente mediante VACUUM INTO: conserva una instantánea mientras el servidor
# escribe en WAL, sin reiniciar la copia ante cada escritura como puede hacer `.backup`.
# Abre "$DB" con
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
#               son 2 días de historial; rango 1..1000000).
#   RESPALDO_TIMEOUT_SEGUNDOS  límite por operación SQLite (por defecto 900;
#               rango 1..86400).
#
# Uso manual:  npm run respaldo
# Uso automático: scripts/systemd/atlas-respaldo.{service,timer} (T022; T043 lo activa).
set -euo pipefail

DB="${DB:-${CARTA_DATA_DIR:-data}/world.sqlite}"
DEST="${DEST:-$HOME/.local/state/atlas-para-isa/backups}"
RETENCION="${RETENCION:-48}"
RESPALDO_TIMEOUT_SEGUNDOS="${RESPALDO_TIMEOUT_SEGUNDOS:-900}"

# Limitar primero los dígitos: una comparación aritmética del valor sin acotar
# también podría desbordarse antes de llegar a RETENCION + 1.
if [[ ! "$RETENCION" =~ ^[1-9][0-9]{0,6}$ ]] || [ "$RETENCION" -gt 1000000 ]; then
  echo "respaldo.sh: RETENCION debe ser un entero entre 1 y 1000000" >&2
  exit 1
fi
if [[ ! "$RESPALDO_TIMEOUT_SEGUNDOS" =~ ^[1-9][0-9]{0,4}$ ]] || [ "$RESPALDO_TIMEOUT_SEGUNDOS" -gt 86400 ]; then
  echo "respaldo.sh: RESPALDO_TIMEOUT_SEGUNDOS debe ser un entero entre 1 y 86400" >&2
  exit 1
fi

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

temporal="$(mktemp -d "$DEST/.respaldo-$marca.XXXXXX")"
limpiar_temporal() {
  rm -f -- "$temporal/world.sqlite" "$temporal/world.sqlite.gz" "$temporal/world.sqlite-journal" "$temporal/world.sqlite-wal" "$temporal/world.sqlite-shm"
  rmdir -- "$temporal"
}
trap limpiar_temporal EXIT

sqlite_acotado() {
  local codigo
  if timeout --kill-after=5 "${RESPALDO_TIMEOUT_SEGUNDOS}s" sqlite3 "$@"; then
    return 0
  else
    codigo=$?
    if [ "$codigo" -eq 124 ] || [ "$codigo" -eq 137 ]; then
      echo "respaldo.sh: operación SQLite interrumpida al agotar ${RESPALDO_TIMEOUT_SEGUNDOS}s; no se publicó ninguna copia nueva" >&2
    else
      echo "respaldo.sh: operación SQLite falló (código $codigo); no se publicó ninguna copia nueva" >&2
    fi
    return "$codigo"
  fi
}

# Una comilla en una ruta es parte del nombre: duplicarla dentro del literal SQL.
# El directorio temporal es exclusivo de esta ejecución; un fallo no retira copias previas.
destino_sql="${temporal//\'/\'\'}/world.sqlite"
sqlite_acotado -readonly -cmd '.timeout 5000' "$DB" "VACUUM INTO '$destino_sql';"

verificacion="$(sqlite_acotado -readonly "$temporal/world.sqlite" 'PRAGMA quick_check;')"
if [ "$verificacion" != "ok" ]; then
  echo "respaldo.sh: la copia no pasó PRAGMA quick_check: $verificacion" >&2
  exit 1
fi

chmod 600 "$temporal/world.sqlite"
gzip -f -- "$temporal/world.sqlite"
# Publicación exclusiva en el mismo filesystem. Si otra ejecución ganó la marca,
# ln falla y conserva su respaldo; nunca sobrescribe un archivo existente.
ln -- "$temporal/world.sqlite.gz" "$copia.gz"

# Retención: conserva solo las últimas $RETENCION copias por fecha de modificación
# (la más nueva primero); el resto se borra. Sin rm -rf amplio: solo ficheros
# "world-*.sqlite.gz" dentro de $DEST, uno a uno.
mapfile -t antiguas < <(ls -1t "$DEST"/world-*.sqlite.gz 2>/dev/null | tail -n "+$((RETENCION + 1))")
if [ "${#antiguas[@]}" -gt 0 ]; then
  rm -f -- "${antiguas[@]}"
fi

echo "respaldo.sh: copia verificada en $copia.gz"
