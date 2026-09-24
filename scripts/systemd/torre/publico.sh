#!/usr/bin/env bash
# Servidor PÚBLICO de Una Carta Para Isa (atlas.humanizar.tech) en la TORRE desde el 2026-09-24 (Steven: portátil
# liberado; una sola instancia en la torre con todos sus recursos). Mundo V11 mudado del portátil con el servicio parado.
# Escucha en la IP de tailnet de la torre 100.64.0.1:3000 (la que usa el dominio). Acceso con la credencial con hash
# del directorio del mundo (access.scrypt); nunca la contraseña en claro. El binario se enlaza como «carta-isa» para que
# la regla de ananicy para «node» (SCHED_IDLE) no le quite prioridad.
set -euo pipefail
cd /datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/publico-v11
export CARTA_DATA_DIR=/datos/workspaces/personal/AtlasParaIsa-anexo/mundos/v11-20260924 HOST=100.64.0.1 PORT=3000 CARTA_ORIGIN=https://atlas.humanizar.tech
export CARTA_PARAMS=gobernador.presupuestoMs=5000 NODE_ENV=production TMPDIR=/datos/workspaces/personal/AtlasParaIsa-anexo/publicaciones/tmp
ln -sf "$(command -v node)" dist/carta-isa
exec ./dist/carta-isa dist/server/server/main.js
