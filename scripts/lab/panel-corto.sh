#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ ${1-} == --smoke ]]; then
  modo=smoke
  dias=1
  ticks=24
  shift
else
  modo=panel
  dias=30
  ticks=72000
fi
if [[ $# -lt 2 || ! $1 =~ ^[a-f0-9]{40}$ ]]; then
  printf 'Uso: bash scripts/lab/panel-corto.sh [--smoke] SHA DIRECTORIO_NUEVO [GRUPO_CPU ...]\n' >&2
  exit 2
fi
revision=$1
salida=$(realpath -m -- "$2")
shift 2
if [[ $# == 0 ]]; then
  set -- 8,9 10,11 12,13 14,15
fi
grupos=("$@")
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
if [[ $(git rev-parse HEAD) != "$revision" || -n $(git status --porcelain) ]]; then
  printf 'El SHA debe coincidir con un árbol de trabajo limpio.\n' >&2
  exit 2
fi

node=$(command -v node)
declare -A usados=()
hilos=0
for grupo in "${grupos[@]}"; do
  if [[ ! $grupo =~ ^(0|[1-9][0-9]*)(,(0|[1-9][0-9]*))*$ ]]; then
    printf 'Grupo CPU inválido %s\n' "$grupo" >&2
    exit 2
  fi
  IFS=, read -r -a nucleos <<< "$grupo"
  if [[ $hilos == 0 ]]; then hilos=${#nucleos[@]}; fi
  if [[ $hilos != "${#nucleos[@]}" ]]; then
    printf 'Los grupos CPU deben tener el mismo tamaño.\n' >&2
    exit 2
  fi
  for cpu in "${nucleos[@]}"; do
    if [[ -n ${usados[$cpu]+x} ]]; then
      printf 'La CPU %s figura más de una vez.\n' "$cpu" >&2
      exit 2
    fi
    usados[$cpu]=1
  done
  if [[ $(taskset -c "$grupo" "$node" -p "require('node:os').availableParallelism()") != "$hilos" ]]; then
    printf 'La afinidad efectiva no coincide con el grupo %s.\n' "$grupo" >&2
    exit 2
  fi
done

cada=120
hasta=intentos
ajustes='motor.soaTerreno=false,motor.particionarPersonas=false,motor.clonPorPaso=true,persistencia.cadaTicks=200,persistencia.ventanaEventosTicks=2400,red.deltas=true'
semillas=(51926 19104 19101 19103)
replicas=()
if [[ $modo == smoke ]]; then
  replicas=(51926-1)
else
  # Cada vuelta cambia la posición de una semilla para repartir su carga entre grupos.
  for replica in 1 2 3; do
    for i in "${!semillas[@]}"; do
      replicas+=("${semillas[(i + replica - 1) % ${#semillas[@]}]}-$replica")
    done
  done
fi

mkdir -m 700 -- "$salida"
for id in "${replicas[@]}"; do
  mkdir -m 700 -- "$salida/$id" "$salida/$id/datos"
done
"$node" --input-type=module - "$salida" "$revision" "$modo" "$dias" "$ticks" "$hilos" "$cada" "$hasta" "$ajustes" \
  "${#grupos[@]}" "${grupos[@]}" "${replicas[@]}" <<'JS'
import { writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';

const [salida, commit, modo, dias, ticks, hilos, cada, hasta, parametros, numeroGrupos, ...lista] = process.argv.slice(2);
const grupos = lista.splice(0, Number(numeroGrupos));
const replicas = lista.map((ruta, i) => {
  const [semilla, replica] = ruta.split('-').map(Number);
  return { semilla, replica, ruta, afinidadCpu: grupos[i % grupos.length] };
});
const manifest = {
  commit, modo, versionNode: process.version, inicioUtc: new Date().toISOString(),
  objetivoDias: Number(dias), ticksObjetivo: Number(ticks), ramFisicaBytes: totalmem(),
  perfil: { regimen: 'abierto', hilos: Number(hilos), gpu: [], cada: Number(cada), hasta, parametros },
  replicas,
};
writeFileSync(join(salida, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
JS

correr_grupo() {
  local grupo=$1 i id ruta codigo
  for ((i=$2; i<${#replicas[@]}; i+=${#grupos[@]})); do
    id=${replicas[i]}
    ruta="$salida/$id"
    codigo=0
    taskset -c "$grupo" env -i PATH="$PATH" LC_ALL=C TMPDIR="$ruta/datos" CARTA_DATA_DIR="$ruta/datos" \
      "$node" --import tsx scripts/lab/encender.mts --panel-corto --semilla "${id%-*}" --ticks "$ticks" \
      --hasta "$hasta" --regimen abierto --hilos "$hilos" --cada "$cada" --params "$ajustes" \
      > "$ruta/corrida.jsonl" 2> "$ruta/stderr.log" || codigo=$?
    printf '%s\n' "$codigo" > "$ruta/codigo.exit.tmp"
    mv -- "$ruta/codigo.exit.tmp" "$ruta/codigo.exit"
  done
}

pids=()
for i in "${!grupos[@]}"; do
  correr_grupo "${grupos[i]}" "$i" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid" || :; done

codigo=0
"$node" --import tsx scripts/lab/panel-corto/evaluar.mts "$salida" > "$salida/resumen.json" || codigo=$?
printf '%s\n' "$codigo" > "$salida/codigo.exit"
cat -- "$salida/resumen.json"
exit "$codigo"
