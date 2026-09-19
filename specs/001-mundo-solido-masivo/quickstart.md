# Quickstart

```sh
# desde la torre, rama 001-mundo-solido-masivo
npm run typecheck && npm test          # verde antes de empezar
npm run lab -- --replicas 32 --dias 10 --salida artifacts/lab/base   # línea base (US1)
npm run lab -- --replicas 32 --dias 10 --param recursos.densidad=0.4,0.7,1.0 --control artifacts/lab/base
cat artifacts/lab/<sello>/resumen.md
npm run build && npm start             # servidor local; el público se relanza desde la ventana 0 del tmux `atlas`
```
El servidor público usa `~/.local/bin/atlas-servidor` (HOST=100.64.0.1, CARTA_ORIGIN=https://atlas.humanizar.tech). Para publicar: merge a `main`, `npm run build`, y en la ventana `servidor` Ctrl-C + Enter.
