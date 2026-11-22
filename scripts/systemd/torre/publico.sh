#!/usr/bin/env bash
# Servidor PÚBLICO de Una Carta Para Isa (atlas.humanizar.tech) en la TORRE desde el 2026-09-24 (Steven: portátil
# liberado; una sola instancia en la torre con todos sus recursos). Mundo V16 desde el 2026-11-22 (código d091f7a,
# RULES_VERSION = 12, CARTA_OPEN_WORLD=1: universo emergente abierto acotado solo por el hardware — 28 hilos CPU,
# Dual-GPU [0,1] ecología + política neuronal autónoma residente, heap V8 64 GiB, presión ecológica real cuencas=0.36,
# deriva cultural bidireccional, ancla narrativa S/I sin tocar la carta y tecnología cualitativa de 6 capacidades).
# V15 se conserva en mundos/v15-20261121 (publico-v15-r3), V14 en mundos/v14-20261119, V13 en mundos/v13-20260930,
# V12 en mundos/v12-20260928 y V11 en mundos/v11-20260924.
# Escucha en la IP de tailnet de la torre 100.64.0.1:3000 (la que usa el dominio). Acceso con la credencial con hash
# del directorio del mundo (access.scrypt); nunca la contraseña en claro. El binario se enlaza como «carta-isa» para que
# la regla de ananicy para «node» (SCHED_IDLE) no le quite prioridad.
set -euo pipefail
cd /datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/publico-v16
export CARTA_DATA_DIR=/datos/workspaces/personal/AtlasParaIsa-anexo/mundos/v16-20261122 HOST=100.64.0.1 PORT=3000 CARTA_ORIGIN=https://atlas.humanizar.tech
export CARTA_OPEN_WORLD=1 COMPUTE_NVRTC=/opt/cuda/lib64/libnvrtc.so NODE_OPTIONS="--max-old-space-size=65536"
export CARTA_PARAMS=gobernador.presupuestoMs=5000,persistencia.ventanaEventosTicks=2400,limites.chunks=65536,limites.teselasActivas=16777216,limites.comunidades=16777216,limites.fauna=100663296 NODE_ENV=production TMPDIR=/datos/workspaces/personal/AtlasParaIsa-anexo/publicaciones/tmp
ln -sf "$(command -v node)" dist/carta-isa
exec ./dist/carta-isa dist/server/server/main.js
