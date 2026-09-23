#!/usr/bin/env bash
# Tamaño del archivo de tecnología y qué lo acotaría (sprint noche-arch 2026-09-23), sobre una COPIA.
#
#   TMPDIR=/datos/tmp-atlas-lab bash scripts/perf/tamano-archivo.sh <copia.sqlite> <salida-dir> [ventana=24000]
#
# Nunca abre el original en escritura: cada experimento trabaja en su propia copia bajo <salida-dir>,
# que se borra al terminar. Mide con `dbstat` (bytes por tabla, filas por hoja, hueco sin usar) y
# con el tamaño de un `VACUUM INTO` (lo que pesa un respaldo, que es exactamente eso):
#   1. la base tal cual;
#   2. `page_size` 8192 y 16384: las filas de ~2,1 KB no caben dos por hoja de 4 KB y el 80 % de las
#      hojas lleva UNA sola fila; con hojas mayores el mismo contenido ocupa menos (cero bits cambian);
#   3. retención: borrar las ejecuciones con tick <= tick_actual - ventana (lo que haría la poda que se
#      propone, sin su fila de digesto) y ver el tamaño del respaldo resultante;
#   4. lo mismo, compactando además `technology_stats` a la última fila de cada receta anterior al
#      horizonte.
set -euo pipefail
COPIA=${1:?copia.sqlite}
SALIDA=${2:?salida-dir}
VENTANA=${3:-24000}
export TMPDIR=${TMPDIR:-/datos/tmp-atlas-lab}
case "$TMPDIR" in /tmp*) echo "TMPDIR fuera de /tmp" >&2; exit 2;; esac
mkdir -p "$SALIDA"
trabajo=$(mktemp -d "$SALIDA/tamano-XXXXXX")
trap 'rm -rf "$trabajo"' EXIT

mb() { awk -v b="$(stat -c %s "$1")" 'BEGIN { printf "%.1f", b / 1048576 }'; }
estadistica() {
  sqlite3 -readonly "$1" "
    SELECT 'tabla', name, printf('%.1f MB', SUM(pgsize)/1048576.0) FROM dbstat
      WHERE name IN ('technology_executions','technology_definitions','technology_stats','chunks','snapshots','events')
      GROUP BY name ORDER BY SUM(pgsize) DESC;
    SELECT 'ejecuciones', COUNT(*), printf('%.0f B cuerpo medio', AVG(length(body))) FROM technology_executions;
    SELECT 'hojas', pagetype, COUNT(*), SUM(ncell), printf('%.1f MB carga', SUM(payload)/1048576.0),
      printf('%.1f MB sin usar', SUM(unused)/1048576.0) FROM dbstat WHERE name='technology_executions' GROUP BY pagetype;"
}

echo "== 1. tal cual ($(mb "$COPIA") MB)"
sqlite3 -readonly "$COPIA" "PRAGMA page_size;"
estadistica "$COPIA"
sqlite3 -readonly "$COPIA" "VACUUM INTO '$trabajo/tal-cual.sqlite'"
echo "respaldo (VACUUM INTO): $(mb "$trabajo/tal-cual.sqlite") MB"

for pagina in 8192 16384; do
  cp "$trabajo/tal-cual.sqlite" "$trabajo/p$pagina.sqlite"
  # page_size sólo cambia con VACUUM y fuera de WAL; es formato físico, no contenido.
  sqlite3 "$trabajo/p$pagina.sqlite" "PRAGMA journal_mode=DELETE; PRAGMA page_size=$pagina; VACUUM;" > /dev/null
  echo "== 2. page_size $pagina ($(mb "$trabajo/p$pagina.sqlite") MB)"
  estadistica "$trabajo/p$pagina.sqlite"
  rm -f "$trabajo/p$pagina.sqlite"
done

TICK=$(sqlite3 -readonly "$COPIA" "SELECT MAX(tick) FROM technology_executions")
HORIZONTE=$((TICK - VENTANA))
echo "== 3. retención de ejecuciones: tick $TICK, ventana $VENTANA, horizonte $HORIZONTE"
cp "$trabajo/tal-cual.sqlite" "$trabajo/poda.sqlite"
sqlite3 "$trabajo/poda.sqlite" "PRAGMA journal_mode=DELETE;
  SELECT 'se podarían', COUNT(*), MAX(serial) FROM technology_executions WHERE tick<=$HORIZONTE;
  DELETE FROM technology_executions WHERE tick<=$HORIZONTE; VACUUM;"
echo "respaldo tras la poda: $(mb "$trabajo/poda.sqlite") MB"
estadistica "$trabajo/poda.sqlite"

echo "== 4. + estadísticas compactadas a la última fila anterior al horizonte"
sqlite3 "$trabajo/poda.sqlite" "
  SELECT 'filas de stats', COUNT(*) FROM technology_stats;
  DELETE FROM technology_stats WHERE tick<=$HORIZONTE AND EXISTS (SELECT 1 FROM technology_stats s2
    WHERE s2.recipeId=technology_stats.recipeId AND s2.tick>technology_stats.tick AND s2.tick<=$HORIZONTE);
  SELECT 'filas de stats tras compactar', COUNT(*) FROM technology_stats; VACUUM;"
echo "respaldo tras podar y compactar: $(mb "$trabajo/poda.sqlite") MB"
cp "$trabajo/poda.sqlite" "$trabajo/poda8k.sqlite"
sqlite3 "$trabajo/poda8k.sqlite" "PRAGMA page_size=8192; VACUUM;" > /dev/null
echo "y con page_size 8192: $(mb "$trabajo/poda8k.sqlite") MB"
gzip -1 -c "$trabajo/poda8k.sqlite" > "$trabajo/poda8k.sqlite.gz"
echo "comprimido como el respaldo horario (gzip -1): $(mb "$trabajo/poda8k.sqlite.gz") MB"
