#!/bin/sh
# Vigilante del mundo público: cada minuto consulta /health en local y reinicia
# atlas-publico.service si responde 503 (el paso lleva más de 60 s sin avanzar,
# o la pausa protectora de guardado) o si no responde tres veces seguidas.
# La cuenta de consultas sin respuesta vive en el estado del usuario.
set -u

URL="${ATLAS_HEALTH_URL:-http://100.64.0.1:3000/health}"
HOST_HTTP="${ATLAS_HEALTH_HOST:-atlas.humanizar.tech}"
ESTADO="${XDG_STATE_HOME:-$HOME/.local/state}/atlas-para-isa/vigilante-sin-respuesta"

codigo="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: $HOST_HTTP" "$URL" 2>/dev/null)" || codigo=000

case "$codigo" in
  200)
    rm -f "$ESTADO"
    ;;
  503)
    echo "vigilante: /health responde 503 (mundo parado); reinicio atlas-publico.service" >&2
    rm -f "$ESTADO"
    systemctl --user restart atlas-publico.service
    ;;
  *)
    mkdir -p "$(dirname "$ESTADO")"
    n=0
    if [ -f "$ESTADO" ]; then n="$(cat "$ESTADO" 2>/dev/null || echo 0)"; fi
    case "$n" in ''|*[!0-9]*) n=0 ;; esac
    n=$((n + 1))
    echo "$n" > "$ESTADO"
    echo "vigilante: /health no responde (codigo $codigo), vez $n de 3" >&2
    if [ "$n" -ge 3 ]; then
      rm -f "$ESTADO"
      echo "vigilante: tres consultas sin respuesta; reinicio atlas-publico.service" >&2
      systemctl --user restart atlas-publico.service
    fi
    ;;
esac
