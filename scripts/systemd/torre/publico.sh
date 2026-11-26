#!/usr/bin/env bash
# V23 en la torre. El directorio del mundo lo elige el operador al preparar la publicación.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.."
: "${CARTA_DATA_DIR:?Falta el directorio del mundo}"
: "${PORT:?Falta el puerto de escucha}"
export CARTA_DATA_DIR HOST="${HOST:-127.0.0.1}" PORT
export CARTA_ORIGIN="${CARTA_ORIGIN:-http://127.0.0.1:$PORT}"
export CARTA_OPEN_WORLD=1 CARTA_SIM_WORKER=1 CARTA_TURBO=1 CARTA_TAPE=1 CARTA_OBSERVER_ONLY=1
export CARTA_MOTOR_HILOS=1 CARTA_MOTOR_GPU=
export CARTA_TAPE_TOPE_BYTES=50000000000
export NODE_ENV=production NODE_OPTIONS="--max-old-space-size=65536"
CARTA_PARAMS=persistencia.cadaTicks=200,persistencia.ventanaEventosTicks=2400,red.deltas=true
CARTA_PARAMS+=,v23.guardadoCompleto=true,v23.fotograma=true,v23.cohesion=true,v23.natalidad=true,v23.comunidades=true
CARTA_PARAMS+=,v23.materia=true,v23.cuerpos=true,v23.fauna=true,v23.tecnica=true,v23.obra=true,v23.intentos=true
export CARTA_PARAMS
unset CARTA_PASSWORD
test -r "$CARTA_DATA_DIR/access.scrypt"

# En la torre el nombre del proceso evita la regla de ananicy para node.
if [[ "$HOST" == 100.64.0.1 ]]; then
  ln -sf -- "$(command -v node)" dist/carta-isa
  exec ./dist/carta-isa dist/server/server/main.js
fi
exec node dist/server/server/main.js
