#!/usr/bin/env bash
# Verificación de una optimización (sprint noche-perf2 2026-09-22): identidad bit a bit contra el
# commit base y CPU propia base/rama, todo en paralelo.
#
#   BASE=/datos/tmp-atlas-lab/perf2-base REF=<dir con base-id-*.json> \
#     bash scripts/perf/verificar.sh <salida> [mundo-alto.sqlite] [mundo-bajo.sqlite] [pasos]
#
# - `identidad.ts d51926|s7|s42` en este árbol; sus digestos deben ser los de `$REF/base-id-<caso>.json`,
#   que se obtienen corriendo el mismo script en `$BASE` (un `git archive` del commit base, nunca este
#   árbol).
# - `alterna.ts` sobre el mundo de población alta y el de población baja: base y rama en el mismo
#   proceso por bloques alternados; exige el mismo digesto final y da la razón de CPU.
set -euo pipefail
SALIDA=${1:?salida}
ALTO=${2:-/datos/tmp-atlas-lab/perfil/psinagua3-d12.sqlite}
BAJO=${3:-/datos/tmp-atlas-lab/perfil-perf2/s51926-d6/world.sqlite}
PASOS=${4:-600}
: "${BASE:?BASE}" "${REF:?REF}"
export TMPDIR=${TMPDIR:-/datos/tmp-atlas-lab}
case "$TMPDIR" in /tmp*) echo "TMPDIR fuera de /tmp" >&2; exit 2;; esac
cd "$(dirname "$0")/../.."
mkdir -p "$SALIDA"
pids=()
for caso in d51926 s7 s42; do
  npx tsx scripts/perf/identidad.ts "$caso" --salida "$SALIDA/id-$caso.json" > "$SALIDA/id-$caso.log" 2>&1 & pids+=($!)
done
npx tsx scripts/perf/alterna.ts --base "$BASE" --db "$ALTO" --pasos "$PASOS" --salida "$SALIDA/alterna-alto.json" > "$SALIDA/alterna-alto.log" 2>&1 & pids+=($!)
npx tsx scripts/perf/alterna.ts --base "$BASE" --db "$BAJO" --pasos "$PASOS" --salida "$SALIDA/alterna-bajo.json" > "$SALIDA/alterna-bajo.log" 2>&1 & pids+=($!)
fallos=0
for pid in "${pids[@]}"; do wait "$pid" || fallos=$((fallos + 1)); done
node -e '
const fs = require("fs"), [salida, ref] = process.argv.slice(1);
let ok = true;
for (const caso of ["d51926", "s7", "s42"]) {
  const a = JSON.parse(fs.readFileSync(`${ref}/base-id-${caso}.json`)).digestos, b = JSON.parse(fs.readFileSync(`${salida}/id-${caso}.json`)).digestos;
  const igual = JSON.stringify(a) === JSON.stringify(b); ok &&= igual;
  console.log(`${caso}: ${igual ? "idéntico" : "DISTINTO"} ${JSON.stringify(b)}`);
}
for (const mundo of ["alto", "bajo"]) {
  const r = JSON.parse(fs.readFileSync(`${salida}/alterna-${mundo}.json`)); ok &&= r.identico;
  console.log(`${mundo}: N ${r.poblacionInicial}→${r.poblacionFinal} ${r.identico ? "idéntico" : "DISTINTO"} ${r.digestoFinalRama}; paso base ${r.base.cpuMsPorPaso} rama ${r.rama.cpuMsPorPaso} ms (x${r.razonPaso}, mediana por bloque x${r.razonPasoMediana}); guardado base ${r.base.saveCpuMsPorPaso} rama ${r.rama.saveCpuMsPorPaso}; paso+guardado x${r.razonPasoYGuardado}`);
}
process.exit(ok ? 0 : 1);
' "$SALIDA" "$REF" || fallos=$((fallos + 1))
exit $fallos
