#!/usr/bin/env bash
# Lanzador del candidato V24. El operador fija el directorio NVMe del mundo y la escucha.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.."
: "${CARTA_DATA_DIR:?Falta el directorio del mundo}"
: "${PORT:?Falta el puerto de escucha}"
export CARTA_DATA_DIR HOST="${HOST:-127.0.0.1}" PORT
export CARTA_ORIGIN="${CARTA_ORIGIN:-http://127.0.0.1:$PORT}"
export NODE_ENV=production NODE_OPTIONS="--max-old-space-size=65536"
source scripts/systemd/torre/perfil-v24.sh
unset CARTA_PASSWORD
if [[ ! -r "$CARTA_DATA_DIR/access.scrypt" ]]; then
  printf 'Falta la credencial privada del mundo.\n' >&2
  exit 1
fi

# En la torre el nombre del proceso evita la regla de ananicy para node.
if [[ "$HOST" == 100.64.0.1 ]]; then
  source scripts/systemd/torre/perfil-presentacion-v24.sh
  ln -sf -- "$(command -v node)" dist/carta-isa
  exec ./dist/carta-isa dist/server/server/main.js
fi
exec node dist/server/server/main.js
