#!/usr/bin/env bash
# Puerta breve del candidato integrado. Ejecutar en una copia de trabajo.
set -euo pipefail
if [[ $# -ne 1 ]]; then
  printf 'Uso: bash scripts/check-v24-demo.sh DIRECTORIO_NUEVO\n' >&2
  exit 2
fi
evidencia=$(realpath -m -- "$1")
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ -n $(git status --porcelain) ]]; then
  printf 'La puerta requiere un candidato commiteado.\n' >&2
  exit 2
fi
mkdir -m 700 -- "$evidencia"
git rev-parse HEAD > "$evidencia/commit.txt"

npm run typecheck 2>&1 | tee "$evidencia/typecheck.log"
node --import tsx --test --test-concurrency=2 --test-timeout=30000 \
  tests/v24-demo-agua.test.ts tests/v24-camino-material.test.ts tests/v24-cobijo-material.test.ts tests/v24-evidencia-reloj.test.ts \
  tests/v24-agenda-durable.test.ts tests/v24-cadencia-eco.test.ts tests/v24-gpu-coste.test.ts tests/v24-gpu-duenos.test.ts \
  tests/v23-crianza-intentos.test.ts tests/v23-muerte-residencia.test.ts tests/v23-motor-frontera.test.ts \
  tests/v23-topes-guardado.test.ts tests/v23-punto-materia.test.ts tests/v23-motor-cesion-materia.test.ts \
  tests/ola-n-natalidad.test.ts 2>&1 | tee "$evidencia/pruebas.log"
npm run build 2>&1 | tee "$evidencia/build.log"
timeout 65s node scripts/lab/demo-observacion.mjs "$PWD" "$evidencia/observacion" 2>&1 | tee "$evidencia/observacion.log"
