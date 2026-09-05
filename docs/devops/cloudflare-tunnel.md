# Cloudflare Tunnel — realtime backend

## Problema

El backend de Una Carta Para Isa corre self-hosted en la máquina del autor
(RTX 5070 Ti, 123 GB RAM) porque un loop de simulación a 30 Hz con CPU
constante no es adecuado para Vercel Functions. El frontend vive en Vercel
(dominio Vercel o personalizado). El frontend y los server components de
Next.js necesitan alcanzar el backend desde la red pública sin abrir puertos
en el router ni manejar certificados TLS manualmente.

Cloudflare Tunnel resuelve esto: el proceso `cloudflared` en la máquina abre
una conexión saliente a Cloudflare; no se expone ningún puerto al exterior.

## Arquitectura resultante

```
Browser / Vercel SSR
       |
       | HTTPS / WSS (TLS de Cloudflare)
       v
Cloudflare Edge (cloudflare.com)
       |
       | Tunnel (conexión saliente desde la máquina)
       v
cloudflared (daemon en la máquina del autor)
       |
       | localhost:8090
       v
Node 24 — services/realtime  (loop 30 Hz, WS, HTTP API)
```

## Hostnames públicos

| Hostname | Protocolo | Uso |
|---|---|---|
| `carta-ws.stevenvallejo.com` | WSS | WebSocket feed — frontend Phaser |
| `carta-api.stevenvallejo.com` | HTTPS | REST API — Next.js server components |

Ambos hostnames apuntan al mismo proceso local en el puerto 8090.

## Configuración de una sola vez

### Prerrequisitos

- Cuenta Cloudflare con `stevenvallejo.com` como zona administrada.
- La máquina tiene acceso a internet (saliente; no se necesita abrir puertos).
- Ubuntu/Debian (ajustar para otras distros).

### Pasos automatizados

```bash
cd /datos/repos/CartaParaIsa
bash scripts/tunnel/setup.sh
```

El script:
1. Instala `cloudflared` desde el repositorio oficial de Cloudflare.
2. Abre el flujo de autenticación (`cloudflared tunnel login`) — se abre el
   browser; si la máquina es headless, pega la URL en otro dispositivo.
3. Crea el túnel con nombre `carta-realtime`.
4. Escribe `~/.cloudflared/config.yml` a partir de
   `services/realtime/config/cloudflared.yml.example`.
5. Crea los registros DNS CNAME en Cloudflare para los dos hostnames.
6. Instala y arranca el servicio systemd `cloudflared`.

### Verificación

Después del setup, el backend debe ser alcanzable:

```bash
# Health del API (espera JSON: { realtime: "ok", ... })
curl https://carta-api.stevenvallejo.com/api/world-health

# World chronicle (vacío en boot; se llena con ticks)
curl "https://carta-api.stevenvallejo.com/api/world-chronicle?limit=5"

# Estado del túnel
cloudflared tunnel info carta-realtime
```

Para el WebSocket puedes usar `wscat`:
```bash
npx wscat -c wss://carta-ws.stevenvallejo.com/ws
# Debe recibir inmediatamente un frame MessagePack (SnapshotMessage)
```

## Configuración en Vercel

En el dashboard de Vercel (o en `vercel env`), añadir las variables de entorno
al proyecto `apps/web`:

```
NEXT_PUBLIC_REALTIME_WS_URL=wss://carta-ws.stevenvallejo.com/ws
NEXT_PUBLIC_REALTIME_API_URL=https://carta-api.stevenvallejo.com
```

Los server components usan `NEXT_PUBLIC_REALTIME_API_URL` para fetch de
`/api/world-summary`, `/api/world-chronicle`, `/api/world-journal` y
`/api/world-health`. El cliente Phaser usa `NEXT_PUBLIC_REALTIME_WS_URL`.

## WebSockets en el plan gratuito de Cloudflare

El plan Free soporta WebSocket pero con un timeout de inactividad de 100
segundos. El cliente debe enviar pings periódicos. El `wsHub.ts` del backend
ya acepta pings nativos del protocolo WebSocket (la librería `ws` responde
automáticamente con pong).

Para eliminar el límite, actualizar la zona a un plan Pro o usar un
subdomain con "Orange Cloud" apagado (grey-cloud / DNS-only), que expone la
IP directamente — menos óptimo en términos de seguridad.

## Gestión del servicio

```bash
# Estado
sudo systemctl status cloudflared

# Reiniciar (ej. después de cambiar config.yml)
sudo systemctl restart cloudflared

# Logs en tiempo real
sudo journalctl -u cloudflared -f

# Detener (sin eliminar el túnel)
sudo systemctl stop cloudflared
```

## Rotación de credenciales

Si el archivo de credenciales `~/.cloudflared/<TUNNEL_ID>.json` se pierde o
expira:

```bash
cloudflared tunnel delete carta-realtime   # elimina el túnel viejo
bash scripts/tunnel/setup.sh               # recrea todo
```

Los registros DNS de Cloudflare se actualizan automáticamente porque apuntan
al nombre del túnel, no al ID.

## Alternativa cloud (si el self-host no es viable)

Si en algún momento el backend debe migrar a cloud:
- **Opción recomendada**: VPS con GPU en Hetzner / Lambda Labs / Vast.ai.
  El mismo `cloudflared` setup aplica desde el VPS.
- **No recomendado**: Vercel Functions. Un loop de simulación 24/7 a 30 Hz
  con CPU constante agota los créditos de Fluid Compute rápidamente y la
  latencia de cold start rompe el loop.
- Ver `docs/architecture/realtime-hosting.md` para el análisis completo.
