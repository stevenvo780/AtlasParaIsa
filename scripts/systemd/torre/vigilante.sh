#!/bin/sh
# Vigilante del mundo público: cada minuto consulta /health en local y reinicia
# atlas-publico.service si responde 503 (el paso lleva demasiado sin avanzar, o la pausa
# protectora de guardado) o si no responde tres veces seguidas.
#
# No toca lo que no está en marcha ni lo que está arrancando:
#  - Una unidad parada a propósito (publicación, mantenimiento) no se vigila ni se reinicia.
#  - La carga en frío de un mundo grande tarda minutos y el transporte no escucha hasta
#    terminarla: durante ATLAS_VIGILANTE_ARRANQUE segundos desde que la unidad pasó a
#    `active` no se cuenta nada; pasado ese plazo, una unidad que sigue sin responder
#    cuenta como cualquier otra.
# La cuenta de consultas sin respuesta vive en el estado del usuario.
set -u

UNIDAD="${ATLAS_UNIDAD:-atlas-publico.service}"
URL="${ATLAS_HEALTH_URL:-http://100.64.0.1:3000/health}"
HOST_HTTP="${ATLAS_HEALTH_HOST:-atlas.humanizar.tech}"
ARRANQUE_MAX="${ATLAS_VIGILANTE_ARRANQUE:-900}"
ESTADO="${XDG_STATE_HOME:-$HOME/.local/state}/atlas-para-isa/vigilante-sin-respuesta"

if ! systemctl --user is-active --quiet "$UNIDAD"; then
  rm -f "$ESTADO"
  exit 0
fi

desde="$(systemctl --user show -P ActiveEnterTimestamp --timestamp=unix "$UNIDAD" 2>/dev/null)"
desde="${desde#@}"
case "$desde" in
  ''|*[!0-9]*) ;;
  *)
    if [ $(( $(date +%s) - desde )) -lt "$ARRANQUE_MAX" ]; then
      rm -f "$ESTADO"
      exit 0
    fi
    ;;
esac

codigo="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: $HOST_HTTP" "$URL" 2>/dev/null)" || codigo=000

case "$codigo" in
  200)
    rm -f "$ESTADO"
    ;;
  503)
    echo "vigilante: /health responde 503 (mundo parado); reinicio $UNIDAD" >&2
    rm -f "$ESTADO"
    systemctl --user restart "$UNIDAD"
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
      echo "vigilante: tres consultas sin respuesta; reinicio $UNIDAD" >&2
      systemctl --user restart "$UNIDAD"
    fi
    ;;
esac
