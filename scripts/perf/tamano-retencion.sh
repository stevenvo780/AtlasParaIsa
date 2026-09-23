#!/usr/bin/env bash
# Tamaño de una base antes/después de la retención de recibos (sprint noche-arch 2026-09-23), sobre una COPIA.
#
#   TMPDIR=/datos/tmp-atlas-lab bash scripts/perf/tamano-retencion.sh <copia.sqlite> <salida-dir>
#
# Sólo lee <copia.sqlite> (sqlite3 -readonly). Informa: fichero vivo (una poda no lo encoge: SQLite deja las
# páginas libres en su lista y las reutiliza para lo que llega después), páginas libres, bytes por tabla
# (dbstat), el respaldo tal como lo hace `scripts/respaldo.sh` (VACUUM INTO + gzip por defecto) y el mismo
# respaldo con páginas de 8 KiB (lo que tiene ya toda base nueva). Los ficheros de trabajo se borran al acabar.
set -euo pipefail
COPIA=${1:?copia.sqlite}
SALIDA=${2:?salida-dir}
export TMPDIR=${TMPDIR:-/datos/tmp-atlas-lab}
case "$TMPDIR" in /tmp*) echo "TMPDIR fuera de /tmp" >&2; exit 2;; esac
mkdir -p "$SALIDA"
trabajo=$(mktemp -d "$SALIDA/tamano-retencion-XXXXXX")
trap 'rm -rf "$trabajo"' EXIT
mb() { awk -v b="$(stat -c %s "$1")" 'BEGIN { printf "%.1f", b / 1048576 }'; }

echo "fichero vivo: $(mb "$COPIA") MB"
sqlite3 -readonly "$COPIA" "
  SELECT 'page_size', page_size FROM pragma_page_size;
  SELECT 'paginas libres', freelist_count, printf('%.1f MB', freelist_count * (SELECT page_size FROM pragma_page_size) / 1048576.0)
    FROM pragma_freelist_count;
  SELECT 'recibos', COUNT(*), MIN(serial), MAX(serial), MIN(tick), MAX(tick) FROM technology_executions;
  SELECT 'metadato', key, value FROM metadata WHERE key LIKE 'technology-%';
  SELECT 'tabla', name, printf('%.1f MB', SUM(pgsize)/1048576.0) FROM dbstat
    WHERE name IN ('technology_executions','technology_definitions','technology_stats','chunks','snapshots','events')
    GROUP BY name ORDER BY SUM(pgsize) DESC;"
sqlite3 -readonly "$COPIA" "VACUUM INTO '$trabajo/respaldo.sqlite'"
echo "respaldo (VACUUM INTO): $(mb "$trabajo/respaldo.sqlite") MB"
gzip -c "$trabajo/respaldo.sqlite" > "$trabajo/respaldo.sqlite.gz"
echo "respaldo comprimido (gzip, como respaldo.sh): $(mb "$trabajo/respaldo.sqlite.gz") MB"
rm -f "$trabajo/respaldo.sqlite.gz"
# page_size sólo cambia con VACUUM y fuera de WAL; es formato físico, no contenido.
sqlite3 "$trabajo/respaldo.sqlite" "PRAGMA journal_mode=DELETE; PRAGMA page_size=8192; VACUUM;" > /dev/null
echo "respaldo con páginas de 8 KiB: $(mb "$trabajo/respaldo.sqlite") MB"
gzip -c "$trabajo/respaldo.sqlite" > "$trabajo/respaldo.sqlite.gz"
echo "respaldo con páginas de 8 KiB, comprimido: $(mb "$trabajo/respaldo.sqlite.gz") MB"
