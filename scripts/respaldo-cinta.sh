#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

raiz=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ ${1-} == --verificar ]]; then
  [[ $# == 2 ]] || { echo 'Uso: respaldo-cinta.sh --verificar <cinta fuera de servicio>' >&2; exit 1; }
  directorio=$(realpath -e -- "$2")
  cd -- "$raiz"
  exec node --import tsx scripts/perf/cinta-verificar.mts --verificar "$directorio"
fi
[[ $# -le 2 ]] || { echo 'Uso: respaldo-cinta.sh [origen] [destino]' >&2; exit 1; }
origen=${1:-${CARTA_CINTA_ORIGEN:-}}
destino=${2:-${CARTA_CINTA_RESPALDO:-}}
: "${origen:?Falta CARTA_CINTA_ORIGEN}"
: "${destino:?Falta CARTA_CINTA_RESPALDO}"
origen=$(realpath -e -- "$origen")
destino=$(realpath -m -- "$destino")
if [[ "$destino/" == "$origen/"* || "$origen/" == "$destino/"* ]]; then
  echo 'El origen y el respaldo deben ser directorios separados.' >&2
  exit 1
fi
mkdir -p -- "$destino"
exec 9>"$destino/.respaldo.lock"
flock -n 9
anterior=$(readlink -f -- "$destino/ultimo" || true)
fuente=''
etapa=''
puntero="$destino/.ultimo-$$"
trap '[[ -z $fuente ]] || rm -rf -- "$fuente"; [[ -z $etapa ]] || rm -rf -- "$etapa"; rm -f -- "$puntero"' EXIT
fuente=$(mktemp -d -- "$(dirname -- "$origen")/.respaldo-cinta.XXXXXXXX")
etapa=$(mktemp -d -- "$destino/.cinta.XXXXXXXX")

node --input-type=module - "$origen" "$fuente" "$etapa" "$anterior" <<'JS'
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const [origen, fuente, etapa, anterior] = process.argv.slice(2);
const indice = 'cinta.idx.sqlite', nombreManifiesto = 'segmentos.json';
const original = join(origen, indice), copia = join(fuente, indice);
const identidad = statSync(original, { bigint: true });
const vivo = new DatabaseSync(original, { readOnly: true });
try { await backup(vivo, copia); } finally { vivo.close(); }

const db = new DatabaseSync(copia);
try {
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  const instancia = db.prepare('SELECT instanciaId FROM epocas ORDER BY id DESC LIMIT 1').get()?.instanciaId;
  if (!instancia) throw new Error('La cinta no tiene ninguna época.');
  const cuarentena = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='cuarentena'").get();
  db.exec('DELETE FROM segmentos WHERE nivel=0; DELETE FROM lagunas_poda WHERE nivel=0');
  if (cuarentena) db.exec('DELETE FROM cuarentena WHERE nivel=0');
  db.exec('COMMIT');
  if (db.prepare('PRAGMA quick_check').all().some(fila => fila.quick_check !== 'ok')
    || db.prepare('PRAGMA foreign_key_check').get()) throw new Error('El respaldo del catálogo no es válido.');

  const rutaPrevia = anterior && join(anterior, nombreManifiesto);
  const previo = rutaPrevia && existsSync(rutaPrevia) ? JSON.parse(readFileSync(rutaPrevia, 'utf8')) : null;
  const manifiesto = { instancia, segmentos: {} };
  const segmentos = db.prepare('SELECT id,epoca,nivel,bytes FROM segmentos ORDER BY id').all();
  const ultimos = new Map(segmentos.map(s => [s.nivel, s.id]));
  const aislado = cuarentena ? 'EXISTS (SELECT 1 FROM cuarentena c WHERE c.segmento=b.segmento AND c.offset=b.offset)' : '0';
  const bloques = db.prepare(`SELECT b.offset,b.bytes,b.crc,${aislado} AS aislado FROM bloques b WHERE b.segmento=? ORDER BY b.offset`);
  for (const nivel of [1, 2, 3, 4]) {
    mkdirSync(join(fuente, `n${nivel}`));
    mkdirSync(join(etapa, `n${nivel}`));
  }
  for (const segmento of segmentos) {
    const { id, nivel, bytes } = segmento;
    const nombre = `n${nivel}/seg-${String(id).padStart(6, '0')}.cnt`;
    const filas = bloques.all(id);
    const necesarios = filas.reduce((fin, f) => f.aislado ? fin : f.offset + f.bytes, 0);
    if (!necesarios) continue;
    const firma = createHash('sha256').update(JSON.stringify([segmento, filas])).digest('hex');
    const previoPath = anterior && join(anterior, nombre);
    if (previo?.instancia === instancia && previo.segmentos[nombre] === firma
      && statSync(previoPath, { throwIfNoEntry: false })?.size >= necesarios) {
      linkSync(previoPath, join(etapa, nombre));
    } else {
      const archivo = join(origen, nombre), salida = join(fuente, nombre);
      const sellado = ultimos.get(nivel) !== id;
      if (sellado) {
        try { linkSync(archivo, salida); }
        catch (error) { if (error.code !== 'EXDEV') throw error; copyFileSync(archivo, salida); }
      } else {
        // El último puede recibir anexos. El catálogo de esta copia solo confirma hasta bytes.
        copyFileSync(archivo, salida);
        if (statSync(salida).size > bytes) truncateSync(salida, bytes);
      }
      if (statSync(salida).size < necesarios) throw new Error(`Segmento incompleto: ${nombre}.`);
    }
    manifiesto.segmentos[nombre] = firma;
  }
  const final = statSync(original, { bigint: true });
  if (identidad.ino !== final.ino || identidad.dev !== final.dev) throw new Error('La instancia de la cinta cambió durante el respaldo.');
  writeFileSync(join(fuente, nombreManifiesto), JSON.stringify(manifiesto) + '\n');
} finally { db.close(); }
JS

rsync -a --fsync --ignore-existing -- "$fuente/" "$etapa/"
sync -f -- "$etapa"
nombre="cinta-$(date -u +%Y%m%dT%H%M%SZ)-${etapa##*.}"
mv -T -- "$etapa" "$destino/$nombre"
etapa=''
ln -s -- "$nombre" "$puntero"
mv -Tf -- "$puntero" "$destino/ultimo"
sync -f -- "$destino"
printf '%s\n' "$destino/$nombre"
