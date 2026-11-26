#!/usr/bin/env bash
# Panel integrado de referencia. Ejecutar en la copia de trabajo del candidato.
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 || ( $# -eq 2 && ! $2 =~ ^[1-9][0-9]*$ ) ]]; then
  printf 'Uso: bash scripts/lab/panel-demo.sh DIRECTORIO_NUEVO [CONCURRENCIA]\n' >&2
  exit 2
fi
salida=$(realpath -m -- "$1")
concurrencia=${2:-4}
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
if [[ -n $(git status --porcelain) ]]; then
  printf 'El panel requiere un candidato commiteado.\n' >&2
  exit 2
fi
mkdir -m 700 -- "$salida"
git rev-parse HEAD > "$salida/commit.txt"
semillas=(7 51926 19101 19102 19103 19104 19105 19106)
export ATLAS_PANEL_SALIDA="$salida"
export ATLAS_PANEL_PARAMS='motor.soaTerreno=false,motor.particionarPersonas=false,motor.clonPorPaso=true,persistencia.cadaTicks=200,persistencia.ventanaEventosTicks=2400,red.deltas=true'
printf '%s\n' "$ATLAS_PANEL_PARAMS" > "$salida/parametros.txt"
printf '%s\0' "${semillas[@]}" | xargs -0 -n 1 -P "$concurrencia" bash -c '
  semilla=$1
  salida=$ATLAS_PANEL_SALIDA
  export CARTA_DATA_DIR="$salida/datos-$semilla"
  mkdir -m 700 -- "$CARTA_DATA_DIR" || exit 1
  env -u COMPUTE_NVRTC node --import tsx scripts/lab/encender.mts --semilla "$semilla" --dias 30 --hasta intentos \
    --regimen abierto --hilos 1 --cada 120 --params "$ATLAS_PANEL_PARAMS" --salida "$salida/$semilla.jsonl" \
    > "$salida/$semilla.log" 2>&1
  codigo=$?
  printf "%s\n" "$codigo" > "$salida/$semilla.exit.tmp"
  mv -- "$salida/$semilla.exit.tmp" "$salida/$semilla.exit"
' atlas-panel

node --input-type=module - "$salida" "${semillas[@]}" <<'JS'
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [salida, ...semillas] = process.argv.slice(2);
const resultados = semillas.map(semilla => {
  const ruta = join(salida, `${semilla}.jsonl`);
  const filas = existsSync(ruta) ? readFileSync(ruta, 'utf8').trim().split('\n').filter(Boolean).map(fila => JSON.parse(fila)) : [];
  const dias = filas.filter(fila => fila.tipo === 'dia');
  const ultimo = dias.at(-1), fin = filas.findLast(fila => fila.tipo === 'fin');
  const codigo = Number(readFileSync(join(salida, `${semilla}.exit`), 'utf8'));
  const conservacion = dias.length > 0 && dias.every((dia, i) => dia.dia === i + 1 && dia.conservacion?.ok === true);
  return { semilla: Number(semilla), codigo, estado: fin?.estado ?? 'abortada', dia: ultimo?.dia ?? 0,
    tick: fin?.tick ?? ultimo?.tick ?? 0, mortales: ultimo?.poblacion ?? null, fauna: ultimo?.fauna ?? null,
    nacimientos: ultimo?.nacimientos ?? null, muertes: ultimo?.muertes ?? null,
    violaciones: fin?.violaciones ?? null, conservacion };
});
const resumen = { commit: readFileSync(join(salida, 'commit.txt'), 'utf8').trim(), resultados,
  abortadas: resultados.filter(fila => fila.codigo !== 0 || fila.estado === 'abortada').length,
  vivasDia30: resultados.filter(fila => fila.estado === 'completo' && fila.dia === 30 && fila.mortales > 0).length,
  vivasDia30Integras: resultados.filter(fila => fila.codigo === 0 && fila.estado === 'completo' && fila.dia === 30
    && fila.tick === 72000 && fila.mortales > 0 && fila.violaciones === 0 && fila.conservacion).length };
writeFileSync(join(salida, 'resumen.json'), JSON.stringify(resumen, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(resumen));
JS
