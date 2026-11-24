#!/usr/bin/env bash
# Servidor PÚBLICO de Una Carta Para Isa (atlas.humanizar.tech + acceso directo VPN/LAN :3443) en la TORRE.
# Mundo V21 desde el 2026-11-24 (código 2b93250, RULES_VERSION = 14, CARTA_OPEN_WORLD=1, CARTA_SIM_WORKER=1,
# CARTA_TURBO=1, CARTA_TAPE=1, CARTA_OBSERVER_ONLY=1: motor sin tope de FPS a máxima frecuencia del hardware
# + cinta DVR grabada en world.tape.sqlite con keyframes gzip y deltas incrementales + reproductor cine 60 fps
# en cliente con scrubber/sparkline/velocidades 0,5×–25×/paso a paso/Borde vivo + modo observador puro sin
# órdenes directas a NPC + corrección demográfica modular V20 verificada en 4/4 semillas + química algebraica
# C/Si/Ca/Fe/S/H + edificios poliominó y sinergias + caminos estigmérgicos + cultivos en 4 etapas + 28 hilos
# CPU + Dual-GPU [0,1] + heap V8 64 GiB).
# V20 se conserva intacto en mundos/v20-20261124 (publico-v20), V19 en mundos/v19-20261124 (publico-v19),
# V18 en mundos/v18-20261122 (publico-v18-r2), V17 en mundos/v17-20261122, V16 en mundos/v16-20261122,
# V15 en mundos/v15-20261121, V14 en mundos/v14-20261119, V13 en mundos/v13-20260930, V12 en
# mundos/v12-20260928 y V11 en mundos/v11-20260924.
# Escucha en la IP de tailnet de la torre 100.64.0.1:3000 (dominio vía Caddy VPS 100.64.0.11 y acceso directo
# LAN/VPN vía atlas-lan-tls.service en 100.64.0.1:3443 y 192.168.78.211:3443). Acceso con credencial con hash
# del directorio del mundo (access.scrypt); nunca la contraseña en claro. El binario se enlaza como «carta-isa»
# para que la regla de ananicy para «node» (SCHED_IDLE) no le quite prioridad.
set -euo pipefail
cd /datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/publico-v21-r3
export CARTA_DATA_DIR=/datos/workspaces/personal/AtlasParaIsa-anexo/mundos/v21-20261124 HOST=100.64.0.1 PORT=3000
export CARTA_ORIGIN=https://atlas.humanizar.tech
export CARTA_EXTRA_ORIGINS=https://100.64.0.1:3443,https://192.168.78.211:3443
export CARTA_PROXY_IP=100.64.0.11,100.64.0.1
export CARTA_OPEN_WORLD=1 CARTA_SIM_WORKER=1 CARTA_TURBO=1 CARTA_TAPE=1 CARTA_OBSERVER_ONLY=1 CARTA_TAPE_MAX_FRAMES=20000
export COMPUTE_NVRTC=/opt/cuda/lib64/libnvrtc.so NODE_OPTIONS="--max-old-space-size=65536"
export CARTA_PARAMS=gobernador.presupuestoMs=5000,persistencia.cadaTicks=200,persistencia.ventanaEventosTicks=2400,red.deltas=true,limites.chunks=65536,limites.teselasActivas=16777216,limites.comunidades=16777216,limites.fauna=100663296 NODE_ENV=production TMPDIR=/datos/workspaces/personal/AtlasParaIsa-anexo/publicaciones/tmp
ln -sf "$(command -v node)" dist/carta-isa
exec ./dist/carta-isa dist/server/server/main.js
