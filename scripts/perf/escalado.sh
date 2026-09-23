#!/usr/bin/env bash
# Cómo escala el paso con la población (sprint noche-perf2 2026-09-22).
#
#   TMPDIR=/datos/tmp-atlas-lab scripts/perf/escalado.sh <salida> <chico.sqlite> <grande.sqlite> [pasosFases=600] [pasosPerfil=300]
#
# Para cada mundo, a la vez (misma carga de la torre para los dos): `fases.ts` sin perfilador
# (CPU propia por fase, `pasosFases` pasos) y `fases.ts` bajo `node --cpu-prof` (`pasosPerfil`
# pasos). Después resume cada perfil por función (`cpuprof.ts resumen`, población media del
# tramo) y compara los dos (`cpuprof.ts comparar`: exponente k de cada función).
# Si junto a la base hay un `meta.json` con `digesto`, se exige al cargar.
# Nunca en /tmp (cuota): exige TMPDIR fuera de /tmp.
set -euo pipefail
salida=${1:?salida}; chico=${2:?chico.sqlite}; grande=${3:?grande.sqlite}
pasosFases=${4:-600}; pasosPerfil=${5:-300}
case "${TMPDIR:-/tmp}" in /tmp*) echo "TMPDIR debe apuntar fuera de /tmp (cuota)" >&2; exit 2;; esac
raiz=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$salida"
tsx=(node --import tsx)

digesto() { local meta; meta="$(dirname "$1")/meta.json"; [ -f "$meta" ] && node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).digesto)' "$meta" || true; }

corre() { # nombre base
  local nombre=$1 db=$2 d; d=$(digesto "$db")
  local exige=(); [ -n "$d" ] && exige=(--digesto "$d")
  mkdir -p "$salida/$nombre/perfil"
  (cd "$raiz" && "${tsx[@]}" scripts/perf/fases.ts --db "$db" --pasos "$pasosFases" "${exige[@]}" --salida "$salida/$nombre/fases.json" > "$salida/$nombre/fases.log" 2>&1) &
  (cd "$raiz" && node --cpu-prof --cpu-prof-dir "$salida/$nombre/perfil" --import tsx scripts/perf/fases.ts --db "$db" --pasos "$pasosPerfil" "${exige[@]}" --salida "$salida/$nombre/perfil/fases.json" > "$salida/$nombre/perfil.log" 2>&1) &
}
corre chico "$chico"
corre grande "$grande"
wait

poblacion() { node -e 'const f=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(Math.round((f.poblacionInicial+f.poblacionFinal)/2)))' "$1"; }
for nombre in chico grande; do
  perfil=$(ls "$salida/$nombre/perfil/"*.cpuprofile | head -1)
  (cd "$raiz" && "${tsx[@]}" scripts/perf/cpuprof.ts resumen "$perfil" --pasos "$pasosPerfil" --poblacion "$(poblacion "$salida/$nombre/perfil/fases.json")" \
    --salida "$salida/$nombre/resumen.json" --top 80 > "$salida/$nombre/resumen.txt" 2>/dev/null)
  (cd "$raiz" && "${tsx[@]}" scripts/perf/cpuprof.ts resumen "$perfil" --pasos "$pasosPerfil" --raiz save --top 30 > "$salida/$nombre/resumen-save.txt" 2>/dev/null)
done
(cd "$raiz" && "${tsx[@]}" scripts/perf/cpuprof.ts comparar "$salida/chico/resumen.json" "$salida/grande/resumen.json" --top 120 > "$salida/comparacion.txt" 2>/dev/null)
for nombre in chico grande; do
  node -e 'const f=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(process.argv[2], "N", f.poblacionInicial, "->", f.poblacionFinal, "paso", f.cpuMsPorPaso, "ms guardado", f.saveCpuMsPorPaso, "ms", JSON.stringify(f.fasesCpuMsPorPaso))' "$salida/$nombre/fases.json" "$nombre"
done
head -3 "$salida/comparacion.txt"
