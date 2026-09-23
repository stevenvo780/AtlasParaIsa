#!/usr/bin/env bash
# Antes/después del banco WS-WAN, a la vez (misma torre, misma carga), con el cliente REAL en los dos
# lados: el `src/client/connection.ts` de cada commit por `cliente-real.ts`, y Chromium con el
# `dist/client` de cada commit por `navegador.ts`. Mismos lotes y duración que el diagnóstico.
#
#   bash scripts/ws-wan/antes-despues.sh [--antes d88699d] [--despues HEAD] [--salida DIR] \
#        [--mundo world.sqlite] [--duracion 90] [--sin-navegador]
#
# Cada lado es una instantánea `git archive` del commit (el «antes» con el arnés de medición de
# `--despues`, pero su propio `servidor.ts`, `src/` y cliente), un mundo copiado de `--mundo` y una
# instancia propia en 127.0.0.1 con contraseña desechable. Nunca el árbol, el mundo ni la contraseña
# del servidor público. Tablas: <salida>/tabla-antes-despues.md y <salida>/tabla-navegador.md.
set -euo pipefail
ANTES=d88699d; DESPUES=HEAD; SALIDA=/datos/tmp-atlas-lab/wsfix-ad; MUNDO=/datos/tmp-atlas-lab/wsfix/mundo/world.sqlite
DURACION=90; NAVEGADOR=1
while [ $# -gt 0 ]; do case $1 in
  --antes) ANTES=$2; shift 2;; --despues) DESPUES=$2; shift 2;; --salida) SALIDA=$2; shift 2;;
  --mundo) MUNDO=$2; shift 2;; --duracion) DURACION=$2; shift 2;; --sin-navegador) NAVEGADOR=0; shift;;
  *) echo "opción desconocida: $1" >&2; exit 2;; esac; done
REPO=$(git rev-parse --show-toplevel)
for p in "$SALIDA" "$MUNDO"; do case $(readlink -m "$p") in
  /datos/workspaces/personal/AtlasParaIsa|/datos/workspaces/personal/AtlasParaIsa/*|/datos/workspaces/personal/AtlasParaIsa-worlds*|"$HOME"/.local/state/atlas-para-isa*)
    echo "$p es del servidor público" >&2; exit 2;; esac; done
export TMPDIR=${TMPDIR:-/datos/tmp-atlas-lab}
mkdir -p "$SALIDA"
ARNES="banco escenario cliente-real navegador-node enlace navegador cliente"
for lado in antes despues; do
  commit=$([ $lado = antes ] && echo "$ANTES" || echo "$DESPUES")
  rm -rf "$SALIDA/$lado-src" "$SALIDA/mundo-$lado" "$SALIDA/$lado" "$SALIDA/nav-$lado"; mkdir -p "$SALIDA/$lado-src" "$SALIDA/mundo-$lado"
  git -C "$REPO" archive "$commit" | tar -x -C "$SALIDA/$lado-src"
  for f in $ARNES; do git -C "$REPO" show "$DESPUES:scripts/ws-wan/$f.ts" > "$SALIDA/$lado-src/scripts/ws-wan/$f.ts"; done
  ln -sfn "$(readlink -f "$REPO/node_modules")" "$SALIDA/$lado-src/node_modules"
  cp "$MUNDO" "$SALIDA/mundo-$lado/world.sqlite"
  (cd "$SALIDA/$lado-src" && nice -n 10 npx vite build > "$SALIDA/build-$lado.log" 2>&1)
  echo "$lado = $(git -C "$REPO" rev-parse --short "$commit")" >&2
done
PW=banco-$(head -c9 /dev/urandom | od -An -tx1 | tr -d ' \n')
declare -A PID
for lado in antes despues; do
  (cd "$SALIDA/$lado-src" && CARTA_DATA_DIR="$SALIDA/mundo-$lado" CARTA_PASSWORD=$PW exec nice -n 10 npx tsx scripts/ws-wan/servidor.ts \
    > "$SALIDA/servidor-$lado.out" 2> "$SALIDA/servidor-$lado.err" < /dev/null) & PID[$lado]=$!
done
parar() { # npx no siempre reenvía la señal: se busca el node que escucha en el puerto de cada instancia
  for lado in antes despues; do
    port=$(python3 -c "import json,sys; print(json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])['port'])" "$SALIDA/servidor-$lado.out" 2>/dev/null || true)
    [ -n "$port" ] && pid=$(ss -tlnpH "( sport = :$port )" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2) && [ -n "$pid" ] && { kill -TERM "$pid" 2>/dev/null || true; }
    kill -TERM "${PID[$lado]}" 2>/dev/null || true
  done
}
trap parar EXIT
until [ -s "$SALIDA/servidor-antes.out" ] && [ -s "$SALIDA/servidor-despues.out" ]; do sleep 5; done
# Calentamiento: el primer guardado tras cargar un mundo grande bloquea el bucle minutos (medido
# 148–177 s con 245 MB); se espera a que pase en los dos antes de medir.
echo "calentando (primer guardado)…" >&2
python3 - "$SALIDA" <<'EOF'
import glob, json, sys, time
def listo(path):
    rt = [json.loads(l) for l in open(path) if '"ev":"runtime"' in l or '"ev":"ready"' in l]
    if len(rt) < 8 or (time.time() * 1000 - rt[0]['t']) < 240_000: return False
    return all(rt[i]['t'] - rt[i - 1]['t'] < 6000 for i in range(len(rt) - 6, len(rt)))
while not all(listo(p) for p in [json.loads(open(f'{sys.argv[1]}/servidor-{l}.out').read().strip().splitlines()[-1])['telemetry'] for l in ('antes', 'despues')]):
    time.sleep(10)
EOF
lote() { # $1 = lado, $2 = lotes, $3… = extra
  local lado=$1 lotes=$2; shift 2
  (cd "$SALIDA/$lado-src" && nice -n 10 npx tsx scripts/ws-wan/banco.ts --cliente real --servidor "$SALIDA/servidor-$lado.out" --escenarios "$lotes" \
    --duracion "$DURACION" --paralelo 3 --salida "$SALIDA/$lado" "$@" > "$SALIDA/banco-$lado-${lotes//,/+}.out" 2> "$SALIDA/banco-$lado-${lotes//,/+}.err")
}
for lado in antes despues; do (lote $lado ancho,bajo,observador; lote $lado estancamiento --estancar 30@12) & done; wait
if [ $NAVEGADOR = 1 ]; then
  for args in "--mbps lan --pantalla 1920x969" "--mbps 5 --pantalla 1920x969" "--mbps 2 --pantalla 1920x969" "--mbps 1 --pantalla 1920x969" "--mbps 0.5 --pantalla 1920x969" "--mbps 2 --pantalla 390x750 --movil"; do
    for lado in antes despues; do
      # shellcheck disable=SC2086
      (cd "$SALIDA/$lado-src" && nice -n 10 npx tsx scripts/ws-wan/navegador.ts --servidor "$SALIDA/servidor-$lado.out" --duracion "$DURACION" --salida "$SALIDA/nav-$lado" $args > /dev/null 2>&1) &
    done; wait
  done
fi
ORDEN="lanM-movil lanM-escritorio lanM-maximo 20M-movil 20M-escritorio 20M-maximo 10M-movil 10M-escritorio 10M-maximo 5M-movil 5M-escritorio 5M-maximo 2M-movil 2M-escritorio 2M-maximo 1.5M-escritorio 1.5M-maximo 1M-escritorio 1M-maximo 0.5M-escritorio 0.5M-maximo 2M-movil-obs5s 2M-escritorio-obs5s 1M-movil-obs5s 1M-escritorio-obs5s 0.5M-movil-obs5s 0.5M-escritorio-obs5s lanM-escritorio-estancado 10M-escritorio-estancado 5M-escritorio-estancado 2M-escritorio-estancado"
# shellcheck disable=SC2086
python3 "$REPO/scripts/ws-wan/comparar.py" "$SALIDA/antes" "$SALIDA/despues" $ORDEN | tee "$SALIDA/tabla-antes-despues.md"
[ $NAVEGADOR = 1 ] && python3 "$REPO/scripts/ws-wan/comparar-navegador.py" "$SALIDA/nav-antes" "$SALIDA/nav-despues" | tee "$SALIDA/tabla-navegador.md"
exit 0
