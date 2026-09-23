#!/usr/bin/env bash
# Servidor PÚBLICO de Una Carta Para Isa (atlas.humanizar.tech), mudado de la torre al portátil el 2026-09-23 por decisión de Steven.
# Escucha solo en la IP de tailnet 100.64.0.2:3000 (zona trusted); el dominio llega por el puente TCP de la torre (atlas-puente.service).
# El acceso usa la credencial con hash ~/atlas-lab/mundos/v10-20260922/access.scrypt (npm run access -- init); nunca la contraseña en claro.
set -euo pipefail
cd "$HOME/atlas-lab/servidor"
export CARTA_DATA_DIR="$HOME/atlas-lab/mundos/v10-20260922" HOST=100.64.0.2 PORT=3000 CARTA_ORIGIN=https://atlas.humanizar.tech
export CARTA_PARAMS=gobernador.presupuestoMs=5000 NODE_ENV=production TMPDIR="$HOME/atlas-lab/tmp"
ln -sf "$(command -v node)" dist/carta-isa
exec ./dist/carta-isa dist/server/server/main.js
