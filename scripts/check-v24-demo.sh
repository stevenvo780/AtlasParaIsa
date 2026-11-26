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
  tests/v21-dvr-client.test.ts tests/ola-cintacli-reproductor.test.ts tests/v24-motor-perfil-cpu1.test.ts \
  tests/v24-motor-perfil-paso.test.ts tests/v24-rutas-locales.test.ts tests/fauna-rejilla.test.ts \
  tests/v24-agenda-durable.test.ts tests/v24-materia-fria.test.ts tests/v24-cadencia-eco.test.ts tests/v24-gpu-coste.test.ts tests/v24-gpu-duenos.test.ts \
  tests/v24-indice-uid.test.ts tests/v24-indice-frente.test.ts tests/v24-reparto-inicial.test.ts \
  tests/v24-apertura-lineal.test.ts tests/v24-vecinos-localidad.test.ts tests/digesto-validacion.test.ts \
  tests/v24-motor-corte-transferible.test.ts \
  tests/v24-materia-tramos-store.test.ts tests/v24-vmat-tramos.test.ts tests/v24-snapshot-matter-parts.test.ts \
  tests/v24-snapshot-packed-people.test.ts tests/v24-snapshot-packed-store.test.ts \
  tests/v24-reserva-materia.test.ts tests/ola-srv-config.test.ts \
  tests/snapshot-parts-poblacion.test.ts tests/snapshot-parts.test.ts tests/snapshot-parts-order.test.ts tests/ola-ps-guardado.test.ts \
  tests/v24-cinta-pavimento.test.ts tests/v20-roads.test.ts tests/v20-visuals.test.ts \
  tests/v23-motor-fotograma-retirada.test.ts \
  tests/v24-worldmap-whispers.test.ts tests/v23-topes-reguladores.test.ts \
  tests/v23-crianza-intentos.test.ts tests/v23-muerte-residencia.test.ts tests/v23-motor-frontera.test.ts \
  tests/v23-topes-guardado.test.ts tests/v23-punto-materia.test.ts tests/v23-motor-cesion-materia.test.ts \
  tests/ola-n-natalidad.test.ts tests/ola-g-materia.test.ts tests/ola-b-cuerpo.test.ts tests/materia-mundo.test.ts tests/materia-arena.test.ts \
  tests/v23-motor-carga-rocosa.test.ts tests/v23-motor-guardado-carga.test.ts \
  tests/v23-motor-guardado-global.test.ts tests/v23-motor-guardado-planos.test.ts 2>&1 | tee "$evidencia/pruebas.log"
# Los casos de distribución química ocupan alrededor de 47 s incluso en un proceso aislado.
node --import tsx --test --test-timeout=90000 tests/materia-paso.test.ts 2>&1 | tee "$evidencia/materia-paso.log"
node --import tsx --test --test-timeout=30000 \
  --test-name-pattern='^(la vista se comparte|una página solo sube|las páginas históricas)' \
  tests/v23-decision-percepcion.test.ts 2>&1 | tee "$evidencia/percepcion-paginas.log"
npm run build 2>&1 | tee "$evidencia/build.log"
CARTA_SNAPSHOT_PACKED_PEOPLE=1 timeout 65s node scripts/lab/demo-observacion.mjs "$PWD" "$evidencia/observacion" 2>&1 | tee "$evidencia/observacion.log"
