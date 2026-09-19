# Quickstart

```sh
# desde la torre, rama 001-mundo-solido-masivo

# 1. Tipos y pruebas — verde antes de empezar
npm run typecheck
npm test          # ~2-3 min; world.test.ts tarda 115 s; nunca sin --test-timeout

# 2. Laboratorio — NO EXISTE TODAVÍA (se crea en T016–T018, disponible tras Gate 1+2).
#    Hasta entonces estos dos comandos fallan; no los ejecutes.
npm run lab -- --replicas 32 --dias 10 --salida artifacts/lab/base   # línea base (US1)
npm run lab -- --replicas 32 --dias 10 --param recursos.densidad=0.4,0.7,1.0 --control artifacts/lab/base
cat artifacts/lab/<sello>/resumen.md

# 3. Build y arranque
npm run build && npm start             # servidor local; el público se relanza desde la ventana 0 del tmux `atlas`

# Levantar local sin tocar data/ (mundo temporal, tras `npm run build`):
CARTA_DATA_DIR=<tmp> CARTA_PASSWORD=<12+ caracteres> HOST=127.0.0.1 PORT=3210 CARTA_ORIGIN=http://127.0.0.1:3210 node dist/server/server/main.js
```
El servidor público usa `~/.local/bin/atlas-servidor` (HOST=100.64.0.1, CARTA_ORIGIN=https://atlas.humanizar.tech). Para publicar: merge a `main`, `npm run build`, y en la ventana `servidor` Ctrl-C + Enter.
