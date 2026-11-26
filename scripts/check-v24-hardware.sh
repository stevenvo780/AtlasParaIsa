#!/usr/bin/env bash
# Verificación breve de la arquitectura de V24 en una copia de trabajo.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

if [[ $# -gt 1 || ( $# -eq 1 && $1 != --cuda ) ]]; then
  printf 'Uso: bash scripts/check-v24-hardware.sh [--cuda]\n' >&2
  exit 2
fi
if [[ $# -eq 1 && ! -r ${COMPUTE_NVRTC:-} ]]; then
  printf 'Asigna COMPUTE_NVRTC a una biblioteca CUDA NVRTC legible.\n' >&2
  exit 2
fi

npm run typecheck
node_modules/.bin/tsc -p tsconfig.server.json --noEmit

env -u COMPUTE_NVRTC node --import tsx --test --test-concurrency=2 --test-timeout=30000 \
  tests/v24-agenda-territorial.test.ts tests/v24-motor-localidad.test.ts tests/v24-motor-carga-chunks.test.ts \
  tests/v24-gpu-coste.test.ts tests/v24-gpu-duenos.test.ts tests/v24-agenda-durable.test.ts \
  tests/ola-m7-rebalanceo.test.ts tests/ola-m5-aplicar.test.ts tests/v23-motor-guardia.test.ts tests/motor-fallos.test.ts \
  tests/ola-ps-guardado.test.ts tests/v23-cinta-escritor.test.ts tests/ola-cinta-recuperacion.test.ts \
  tests/v23-cinta-poda-volumen.test.ts tests/v23-cinta-recarga.test.ts

node --import tsx --test --test-timeout=30000 --test-name-pattern='la cinta externa|la ruta explícita de cinta|cada muerte lleva su causa' \
  tests/v21-turbo-server.test.ts tests/v23-poblacion-mundo.test.ts

if [[ $# -eq 1 ]]; then
  node --import tsx --test --test-timeout=45000 \
    --test-name-pattern='V24 CUDA real|G CUDA real|G recibe|G una página|G conserva|CUDA real: F2 distribuida|la recarga conserva mundo y época' \
    tests/v23-motor-despacho.test.ts tests/ola-g-percepcion.test.ts tests/v24-gpu-duenos.test.ts
fi
