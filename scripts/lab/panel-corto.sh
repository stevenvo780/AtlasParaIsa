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
afinidades=()
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
  if ! afinidad=$(taskset -c "$grupo" "$node" --input-type=module -e '
    import { availableParallelism } from "node:os";
    import { readFileSync } from "node:fs";
    const mascara = /^Cpus_allowed_list:\s*(.+)$/m.exec(readFileSync("/proc/thread-self/status", "utf8"))?.[1];
    if (!mascara || availableParallelism() !== Number(process.argv[1])) process.exit(1);
    console.log(mascara);
  ' "$hilos"); then
    printf 'La afinidad efectiva no coincide con el grupo %s.\n' "$grupo" >&2
    exit 2
  fi
  afinidades+=("$afinidad")
done

cada=120
hasta=intentos
ajustes='motor.soaTerreno=false,motor.particionarPersonas=false,motor.clonPorPaso=true,persistencia.cadaTicks=200,persistencia.ventanaEventosTicks=2400,red.deltas=true'
semillas=(51926 19104 19101 19103)
replicas=()
if [[ $modo == smoke ]]; then
  replicas=(51926-1)
else
  # Cada vuelta empieza por una semilla distinta.
  for replica in 1 2 3; do
    for i in "${!semillas[@]}"; do
      replicas+=("${semillas[(i + replica - 1) % ${#semillas[@]}]}-$replica")
    done
  done
fi

mkdir -m 700 -- "$salida"
for id in "${replicas[@]}"; do
  mkdir -m 700 -- "$salida/$id"
done
grabar_manifiesto() {
  "$node" --input-type=module - "$salida" "$revision" "$modo" "$dias" "$ticks" "$hilos" "$cada" "$hasta" "$ajustes" \
    "${replicas[@]}" <<'JS'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';

const [salida, commit, modo, dias, ticks, hilos, cada, hasta, parametros, ...lista] = process.argv.slice(2);
const ruta = join(salida, 'manifest.json');
const manifest = existsSync(ruta) ? JSON.parse(readFileSync(ruta, 'utf8')) : {
  commit, modo, versionNode: process.version, inicioUtc: new Date().toISOString(),
  objetivoDias: Number(dias), ticksObjetivo: Number(ticks), ramFisicaBytes: totalmem(),
  perfil: { regimen: 'abierto', hilos: Number(hilos), gpu: [], cada: Number(cada), hasta, parametros },
  replicas: lista.map(ruta => {
    const [semilla, replica] = ruta.split('-').map(Number);
    return { semilla, replica, ruta, afinidadCpu: null };
  }),
};
for (const replica of manifest.replicas) {
  const evidencia = join(salida, replica.ruta, 'afinidad.cpu');
  if (existsSync(evidencia)) {
    replica.afinidadCpu = readFileSync(evidencia, 'utf8').trim().replace(/(\d+)-(\d+)/g, (_, desde, hasta) =>
      Array.from({ length: Number(hasta) - Number(desde) + 1 }, (_, i) => Number(desde) + i).join(','));
  }
}
writeFileSync(`${ruta}.tmp`, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
renameSync(`${ruta}.tmp`, ruta);
JS
}

# shellcheck disable=SC2329
parar_hijos() {
  trap '' HUP INT TERM
  local -a activos
  mapfile -t activos < <(jobs -pr)
  if ((${#activos[@]})); then
    kill -TERM "${activos[@]}" 2>/dev/null || :
    wait || :
  fi
}

# shellcheck disable=SC2329
cerrar_panel() {
  local codigo=$?
  parar_hijos
  if [[ -f "$salida/manifest.json" && ! -f "$salida/codigo.exit" ]]; then
    grabar_manifiesto || :
    grabar_codigo "$salida" "$codigo"
  fi
}

grabar_codigo() {
  printf '%s\n' "$2" > "$1/codigo.exit.tmp"
  mv -- "$1/codigo.exit.tmp" "$1/codigo.exit"
}

# shellcheck disable=SC2329
cerrar_grupo() {
  parar_hijos
  if [[ -n $1 && ! -f "$1/codigo.exit" ]]; then
    grabar_codigo "$1" "$2"
  fi
}

correr_grupo() {
  local grupo=$1 esperada=$2 id ruta activa='' codigo=''
  trap 'cerrar_grupo "${activa:-}" "${codigo:-$?}"' EXIT
  trap 'exit 129' HUP
  trap 'exit 143' TERM
  for id in "${replicas[@]}"; do
    ruta="$salida/$id"
    # La creación atómica del directorio privado da la réplica a un solo grupo.
    if ! mkdir -m 700 -- "$ruta/datos" 2>/dev/null; then
      [[ -d "$ruta/datos" ]] && continue
      printf 'No se pudo reservar la réplica %s.\n' "$id" >&2
      return 1
    fi
    activa=$ruta
    # shellcheck disable=SC2016
    taskset -c "$grupo" env -i PATH="$PATH" LC_ALL=C TMPDIR="$ruta/datos" CARTA_DATA_DIR="$ruta/datos" \
      "$BASH" -euc '
        esperada=$1
        shift
        while read -r campo mascara; do
          if [[ $campo == Cpus_allowed_list: ]]; then break; fi
        done < /proc/thread-self/status
        if [[ $campo != Cpus_allowed_list: || $mascara != "$esperada" ]]; then
          printf "Afinidad efectiva inesperada (%s). Se esperaba %s.\n" "${mascara:-ausente}" "$esperada" >&2
          exit 2
        fi
        printf "%s\n" "$mascara" > "$CARTA_DATA_DIR/../afinidad.cpu"
        exec "$@"
      ' bash "$esperada" \
      "$node" --import tsx scripts/lab/encender.mts --panel-corto --semilla "${id%-*}" --ticks "$ticks" \
      --hasta "$hasta" --regimen abierto --hilos "$hilos" --cada "$cada" --params "$ajustes" \
      > "$ruta/corrida.jsonl" 2> "$ruta/stderr.log" &
    if wait "$!"; then codigo=0; else codigo=$?; fi
    grabar_codigo "$activa" "$codigo"
    activa=''
    codigo=''
  done
}

trap 'cerrar_panel' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
grabar_manifiesto
pids=()
for i in "${!grupos[@]}"; do
  correr_grupo "${grupos[i]}" "${afinidades[i]}" &
  pids+=("$!")
done
fallo=0
for pid in "${pids[@]}"; do wait "$pid" || fallo=1; done
grabar_manifiesto

codigo=0
"$node" --import tsx scripts/lab/panel-corto/evaluar.mts "$salida" > "$salida/resumen.json" || codigo=$?
if ((fallo && codigo == 0)); then codigo=1; fi
grabar_codigo "$salida" "$codigo"
cat -- "$salida/resumen.json"
exit "$codigo"
