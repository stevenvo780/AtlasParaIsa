#!/usr/bin/env bash
# Servidor PÚBLICO de Una Carta Para Isa (atlas.humanizar.tech + acceso directo VPN/LAN :3443) en la TORRE.
# Mundo V18 desde el 2026-11-22 (código 4c97666, RULES_VERSION = 12, CARTA_OPEN_WORLD=1: universo emergente
# abierto acotado solo por el hardware — 28 hilos CPU, Dual-GPU [0,1] ecología + política neuronal autónoma
# residente en VRAM, heap V8 64 GiB, presión ecológica real cuencas=0.36, fisión Dunbar estable sin fantasmas +
# nombres propios sin artículos + deriva cultural stewardship reforzada, peregrinaje S/I con rodeo costero,
# UI/UX de observabilidad emergente, páginas limpias fail-closed + persistencia acelerada 6× (SoA tuplas +
# exact-json nativo), gracia de arranque HTTP LAN, vía rápida SoA en estadísticas/proyección, retiro de chunks
# y caché de fauna incrementales sin picos, deltas WS estructurales con deflate/troceo adaptativo y caché gzip).
# V17 se conserva en mundos/v17-20261122 (publico-v17), V16 en mundos/v16-20261122 (publico-v16), V15 en
# mundos/v15-20261121 (publico-v15-r3), V14 en mundos/v14-20261119, V13 en mundos/v13-20260930, V12 en
# mundos/v12-20260928 y V11 en mundos/v11-20260924.
# Escucha en la IP de tailnet de la torre 100.64.0.1:3000 (dominio vía Caddy VPS 100.64.0.11 y acceso directo
# LAN/VPN vía atlas-lan-tls.service en 100.64.0.1:3443 y 192.168.78.211:3443). Acceso con credencial con hash
# del directorio del mundo (access.scrypt); nunca la contraseña en claro. El binario se enlaza como «carta-isa»
# para que la regla de ananicy para «node» (SCHED_IDLE) no le quite prioridad.
set -euo pipefail
cd /datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/publico-v18-r2
export CARTA_DATA_DIR=/datos/workspaces/personal/AtlasParaIsa-anexo/mundos/v18-20261122 HOST=100.64.0.1 PORT=3000
export CARTA_ORIGIN=https://atlas.humanizar.tech
export CARTA_EXTRA_ORIGINS=https://100.64.0.1:3443,https://192.168.78.211:3443
export CARTA_PROXY_IP=100.64.0.11,100.64.0.1
export CARTA_OPEN_WORLD=1 COMPUTE_NVRTC=/opt/cuda/lib64/libnvrtc.so NODE_OPTIONS="--max-old-space-size=65536"
export CARTA_PARAMS=gobernador.presupuestoMs=5000,persistencia.cadaTicks=200,persistencia.ventanaEventosTicks=2400,red.deltas=true,limites.chunks=65536,limites.teselasActivas=16777216,limites.comunidades=16777216,limites.fauna=100663296 NODE_ENV=production TMPDIR=/datos/workspaces/personal/AtlasParaIsa-anexo/publicaciones/tmp
ln -sf "$(command -v node)" dist/carta-isa
exec ./dist/carta-isa dist/server/server/main.js
