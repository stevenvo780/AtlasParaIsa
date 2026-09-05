# Vercel setup — Una Carta Para Isa

Guía operacional completa para Steven. Cubre: estado actual del proyecto
Vercel, configuración de env vars, integración con Cloudflare Tunnel, y
Cloudflare Access para proteger el backend.

---

## Estado actual del proyecto Vercel

El proyecto ya está linkedado:

```
projectId:   prj_5Em6Rjs4tEodUBEf9V7NeFxuizpu
orgId:       team_2XRHkC7OumlFRLw8YObfUglL
projectName: carta-para-isa
```

El `vercel.json` de la raíz cubre el monorepo correctamente:

- `buildCommand`: `pnpm --filter @carta/web build`
- `installCommand`: `pnpm install --frozen-lockfile`
- `outputDirectory`: `apps/web/.next`
- `ignoreCommand`: solo despliega si cambian `apps/web/` o `packages/`

El archivo `apps/web/vercel.json` es una variante redundante para si el
root directory se configurara en `apps/web`; no causa conflicto pero puede
eliminarse cuando se confirme que el proyecto apunta a la raíz.

Migrar de `vercel.json` a `vercel.ts` no es necesario. El `vercel.json`
actual es válido.

---

## Env vars que faltan en Vercel

Estas variables NO están configuradas en el proyecto `carta-para-isa`.
Deben añadirse antes del primer deploy de producción real.

### Variables NEXT_PUBLIC_* (llegan al bundle del cliente)

```bash
# WebSocket del backend — incluye el path /ws al final
echo "wss://carta-ws.stevenvallejo.com/ws" | vercel env add NEXT_PUBLIC_REALTIME_WS_URL production

# REST API del backend — sin trailing slash
echo "https://carta-api.stevenvallejo.com" | vercel env add NEXT_PUBLIC_REALTIME_API_URL production

# Dominio público del frontend
echo "https://carta.stevenvallejo.com" | vercel env add NEXT_PUBLIC_APP_URL production

# Entorno explícito para feature flags
echo "production" | vercel env add NEXT_PUBLIC_APP_ENV production
```

Para preview (útil si quieres que los PRs apunten al mismo backend de producción
mientras no hay un backend de staging):

```bash
echo "wss://carta-ws.stevenvallejo.com/ws" | vercel env add NEXT_PUBLIC_REALTIME_WS_URL preview
echo "https://carta-api.stevenvallejo.com" | vercel env add NEXT_PUBLIC_REALTIME_API_URL preview
echo "preview" | vercel env add NEXT_PUBLIC_APP_ENV preview
```

Para development (sincroniza a .env.local con `vercel env pull`):

```bash
echo "ws://localhost:8090/ws" | vercel env add NEXT_PUBLIC_REALTIME_WS_URL development
echo "http://localhost:8090" | vercel env add NEXT_PUBLIC_REALTIME_API_URL development
echo "development" | vercel env add NEXT_PUBLIC_APP_ENV development
```

### Variables de servidor (no llegan al cliente)

```bash
# Vercel Blob — obtener token en: Dashboard → Storage → Blob → Tokens
vercel env add BLOB_READ_WRITE_TOKEN production

# Neon Postgres — obtener en: Dashboard → Storage → Postgres → Connect
# NUNCA para el corpus de chats; solo metadatos públicos (journal, chronicle)
vercel env add DATABASE_URL production

# Secret para autenticar llamadas servidor→servidor (Next.js API → realtime)
# Generar: openssl rand -hex 32
vercel env add REALTIME_INTERNAL_SECRET production
```

### Verificar todas las variables configuradas

```bash
vercel env ls
```

---

## Pasos manuales que Steven debe ejecutar

### A. Instalar cloudflared en la máquina con GPU

```bash
# Debian/Ubuntu (la máquina tiene Ubuntu 22.04 según compose)
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo gpg --dearmor -o /usr/share/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
  https://pkg.cloudflared.com/cloudflared $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update -q && sudo apt-get install -y cloudflared
cloudflared version
```

### B. Login con tu cuenta Cloudflare

```bash
cloudflared tunnel login
# Abre el browser automáticamente.
# Si la máquina es headless: copia la URL que imprime en consola
# y pégala en el browser de otro dispositivo.
# El certificado queda en ~/.cloudflared/cert.pem
```

Prerrequisito: el dominio `stevenvallejo.com` debe estar como zona
administrada en tu cuenta Cloudflare (no solo en el registrar).

### C. Ejecutar el setup del tunnel (one-shot)

```bash
cd /datos/repos/CartaParaIsa
bash scripts/tunnel/setup.sh
```

El script es idempotente. Si falla en algún paso intermedio, puede
re-ejecutarse sin daño. Al terminar imprime:
```
=== Setup complete ===
Tunnel: carta-realtime (<UUID>)
WS  public URL: wss://carta-ws.stevenvallejo.com/ws
API public URL: https://carta-api.stevenvallejo.com/api/world-health
```

### D. Verificar que el tunnel funciona

```bash
# Antes de configurar Vercel, verifica desde otro dispositivo:
curl https://carta-api.stevenvallejo.com/api/world-health
# Espera: { "realtime": "ok", ... }

npx wscat -c wss://carta-ws.stevenvallejo.com/ws
# Debe recibir inmediatamente un frame (SnapshotMessage en MessagePack)
```

### E. Configurar las env vars en Vercel

Ejecutar los comandos del bloque "Env vars que faltan" de arriba.
Verificar con `vercel env ls`.

### F. Dominio personalizado (opcional pero recomendado para Isa)

```bash
vercel domains add carta.stevenvallejo.com
# Vercel muestra el registro CNAME a añadir.
# En Cloudflare DNS: añadir CNAME carta → cname.vercel-dns.com
# Luego en Vercel: asignar el dominio al proyecto carta-para-isa
```

---

## Cloudflare Access — proteger el backend WS

El tunnel expone el backend publicamente. Para que solo el frontend de
Vercel pueda alcanzarlo (no cualquiera en internet), configurar Cloudflare
Access:

1. En Cloudflare Dashboard → Zero Trust → Access → Applications
2. "Add an application" → Self-hosted
3. Application domain: `carta-ws.stevenvallejo.com` y `carta-api.stevenvallejo.com`
4. Policy: "Service Auth" con un Service Token
5. Añadir el token a Vercel como variable de servidor:

```bash
vercel env add CF_ACCESS_CLIENT_ID production
vercel env add CF_ACCESS_CLIENT_SECRET production
```

6. En los server components / API routes de Next.js, incluir los headers
   `CF-Access-Client-Id` y `CF-Access-Client-Secret` en los fetches al backend.

Mientras Cloudflare Access no esté configurado, el backend es alcanzable
por cualquiera que conozca el hostname. Aceptable en fase inicial si el
corpus no está cargado, pero debe activarse antes de que el corpus real de
227k líneas esté indexado.

---

## Notas sobre el vercel.json actual

El `ignoreCommand` actual es:

```json
"ignoreCommand": "git diff HEAD^ HEAD --quiet -- apps/web packages"
```

Esto evita deploys en Vercel cuando el commit solo toca `services/`,
`docker/`, `scripts/` u otras partes del monorepo que no afectan el
frontend. Correcto y eficiente.

La `apps/web/vercel.json` es redundante dado que el proyecto apunta a la
raíz. Puede eliminarse sin efecto.

---

## Notas sobre Vercel Blob y Marketplace Storage

- Los 5.4 MB de sprites en `apps/web/public/assets/` están dentro del
  límite de Vercel (250 MB por deployment). No es blocker hoy.
- Migrar a Vercel Blob cuando se añadan audios o spritesheets grandes.
  Obtener `BLOB_READ_WRITE_TOKEN` en Dashboard → Storage → Blob.
- Neon Postgres (via Vercel Marketplace) para journal, chronicle,
  world-summary. NUNCA para el corpus de chats (ese corpus es privado,
  local, en GPU, ingestado por `scripts/narrative/ingest.ts`).
