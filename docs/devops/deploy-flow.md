# Deploy flow — Una Carta Para Isa

Frontend `apps/web/` (Next.js 15, App Router) desplegado en Vercel.
El backend realtime corre self-hosted con GPU y se expone via Cloudflare Tunnel.

---

## 1. Requisitos previos

```bash
npm install -g vercel          # CLI global
vercel --version               # verificar >= 37
```

Necesitas una cuenta en [vercel.com](https://vercel.com) vinculada al repo GitHub
`stevenvo780/CartaParaIsa`.

---

## 2. Primer link del proyecto

Vercel necesita saber que `apps/web/` es el root del proyecto Next.js.
**Opción A — linkar desde la raíz del monorepo (recomendado):**

```bash
cd /datos/repos/CartaParaIsa
vercel link
```

Durante el wizard responde:
- "Set up and deploy?" → No (solo link)
- "Which scope?" → tu cuenta personal o equipo
- "Found project?" → crear nuevo: `carta-para-isa`
- "In which directory is your code located?" → `./apps/web`

Vercel crea `.vercel/project.json` en la raíz. No commitees ese archivo
(ya está en `.gitignore` por defecto al crearlo Vercel).

**Opción B — desde el Dashboard de Vercel:**
- New Project → Import repo → Framework: Next.js
- Root Directory: `apps/web`
- Build Command (override): `cd ../.. && pnpm --filter @carta/web build`
- Install Command (override): `pnpm install --frozen-lockfile`
- Output Directory: `.next` (relativo a `apps/web`)

---

## 3. Gestión de variables de entorno

Las variables viven en Vercel, nunca en el repositorio.

```bash
# Agregar una variable (interactivo — te pregunta entorno y valor)
vercel env add NEXT_PUBLIC_REALTIME_WS_URL

# Agregar directamente para producción:
echo "wss://carta-ws.stevenvallejo.com" | vercel env add NEXT_PUBLIC_REALTIME_WS_URL production

# Agregar para preview y development:
echo "wss://carta-ws-preview.stevenvallejo.com" | vercel env add NEXT_PUBLIC_REALTIME_WS_URL preview
echo "ws://localhost:8080" | vercel env add NEXT_PUBLIC_REALTIME_WS_URL development

# Listar todas las variables del proyecto:
vercel env ls

# Bajar las variables de desarrollo a .env.local (para desarrollo local):
vercel env pull .env.local
```

Variables mínimas que debes configurar antes del primer deploy real:

| Variable | Entorno | Valor ejemplo | Descripción |
|---|---|---|---|
| `NEXT_PUBLIC_REALTIME_WS_URL` | production, preview | `wss://carta-ws.stevenvallejo.com/ws` | WebSocket del backend (Cloudflare Tunnel). Nota: incluye `/ws` path. |
| `NEXT_PUBLIC_REALTIME_API_URL` | production, preview | `https://carta-api.stevenvallejo.com` | REST API del backend (Cloudflare Tunnel). |
| `NEXT_PUBLIC_APP_URL` | production | `https://carta.stevenvallejo.com` | Dominio definitivo del frontend. |
| `NEXT_PUBLIC_APP_ENV` | todos | `production` / `preview` / `development` | Feature flags en cliente. |
| `BLOB_READ_WRITE_TOKEN` | production, preview | (de Vercel Dashboard) | Vercel Blob para sprites/audio. |
| `DATABASE_URL` | production, preview | (de Neon Dashboard) | Neon Postgres para metadatos públicos. |
| `REALTIME_INTERNAL_SECRET` | production, preview | (openssl rand -hex 32) | Auth servidor→servidor con realtime. |

Ver `.env.example` en la raíz para la lista completa y descripción de cada variable.

Comandos `vercel env add` correspondientes (ejecutar uno a uno; te pedirá el valor):
```bash
vercel env add NEXT_PUBLIC_REALTIME_WS_URL production
vercel env add NEXT_PUBLIC_REALTIME_API_URL production
vercel env add NEXT_PUBLIC_APP_URL production
vercel env add NEXT_PUBLIC_APP_ENV production
vercel env add BLOB_READ_WRITE_TOKEN production
vercel env add DATABASE_URL production
vercel env add REALTIME_INTERNAL_SECRET production
# Repetir para preview si se quiere un backend de preview separado:
vercel env add NEXT_PUBLIC_REALTIME_WS_URL preview
vercel env add NEXT_PUBLIC_REALTIME_API_URL preview
```

---

## 4. Preview por branch vs Production en main

Vercel crea deployments automáticamente:

- **Cada push a cualquier branch** → deployment de Preview con URL única
  `https://carta-para-isa-<hash>.vercel.app`
- **Cada merge a `main`** → deployment de Production con el dominio configurado
  `https://carta.stevenvallejo.com` (o el subdominio que elijas)

No es necesario correr `vercel deploy` manualmente si el repo está conectado
a Vercel via integración GitHub. El GitHub Action de CI (`.github/workflows/preview.yml`)
corre type-check y tests antes del merge, pero el deploy lo dispara Vercel
directamente desde GitHub.

---

## 5. Conectar el frontend en cloud con el backend realtime self-hosted

El backend WS corre en tu máquina local (RTX 5070 Ti). Para que el frontend
en Vercel lo alcance necesitas un túnel TLS público estable.

### Cloudflare Tunnel (recomendado — gratis, estable, sin IP fija)

El setup completo está automatizado. Ejecutar una sola vez en la máquina con la GPU:

```bash
bash scripts/tunnel/setup.sh
```

El script instala `cloudflared`, autentica, crea el túnel `carta-realtime`,
genera `~/.cloudflared/config.yml` a partir de
`services/realtime/config/cloudflared.yml.example`, crea los CNAME DNS en
Cloudflare para `carta-ws.stevenvallejo.com` y `carta-api.stevenvallejo.com`,
e instala el servicio systemd.

Para los pasos manuales detallados (si el script falla en algún paso intermedio)
ver `docs/devops/cloudflare-tunnel.md`.

**Una vez terminado el setup, configurar las variables en Vercel:**
```bash
echo "wss://carta-ws.stevenvallejo.com/ws" | vercel env add NEXT_PUBLIC_REALTIME_WS_URL production
echo "https://carta-api.stevenvallejo.com" | vercel env add NEXT_PUBLIC_REALTIME_API_URL production
```

El frontend usará `wss://carta-ws.stevenvallejo.com/ws` en producción y
`ws://localhost:8090/ws` en desarrollo local (via `apps/web/.env.local`).

### Alternativa: ngrok (para desarrollo rápido, no para producción)

```bash
ngrok http 8080
# Copia la URL wss://xxxx.ngrok.io
# Actualiza NEXT_PUBLIC_REALTIME_WS_URL en Vercel para preview
```

ngrok cambia la URL con cada arranque (plan gratuito), lo que hace
inviable para producción. Usar solo para pruebas de integración.

---

## 6. Rollback

Si un deploy de producción falla o introduce regresión:

```bash
# Listar deployments recientes
vercel ls

# Hacer rollback a una URL específica
vercel rollback https://carta-para-isa-<hash>.vercel.app

# O desde el Dashboard: Deployments → seleccionar deployment anterior → Promote to Production
```

---

## 7. Dominio personalizado

```bash
# Agregar dominio (requiere acceso al DNS de stevenvallejo.com)
vercel domains add carta.stevenvallejo.com

# Vercel muestra el registro DNS a agregar (CNAME o A record)
# Luego en Cloudflare DNS: agregar el CNAME apuntando a cname.vercel-dns.com
```

---

## 8. Primer deploy manual de prueba

Una vez completado el link (`vercel link`), puedes disparar un deploy de preview sin push:

```bash
cd /datos/repos/CartaParaIsa
# Asegúrate de que VERCEL_TOKEN esté en tu entorno (ver scripts/deploy-preview.sh)
bash scripts/deploy-preview.sh
```

O directamente:
```bash
vercel --cwd apps/web
```
