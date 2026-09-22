# T100, primera unidad: lectura cerrada y parámetros V1

Base: `6c9e88c7f4e070b6ac7a32d23ea16ae9ba03a29b`, reglas V7. Rama aislada
`sprint/t100-20260922`. Codex nativo; sin delegación cloud disponible.

Un snapshot con JSON legible y encoding desconocido, tupla incompleta o cardinalidad
ilegal hacía que `Store.load()` probara un respaldo sano. También confundía errores
de recursos del decoder con daño físico. Ahora sólo el error explícito de JSON
ilegible autoriza ese fallback; checksum/fila ausente conservan su manejo anterior.
Las demás excepciones se propagan, sin modificar snapshots ni sus respaldos.

La migración V1 hacía `structuredClone` y perdía los parámetros del WeakMap antes
de generar terreno/ecosistema. El clon recibe ahora las mismas leyes inmediatamente,
antes de cualquier generación; los campos originales y los límites V1 se conservan.

Negativos previos, reproducidos sobre la base: **6 fallos / 2 controles verdes**.
Después: **45/45** en snapshot, migración, archivo, params y baselines durables;
**16/16** adicionales en persistencia, recuperación y CLI de backup. Cero omisiones.
`npm run typecheck` y `git diff --check` verdes. Comandos:

```sh
node --import ./node_modules/tsx/dist/loader.mjs --test \
  tests/snapshot-boundary.test.ts tests/migration-params-v1.test.ts \
  tests/snapshot.test.ts tests/archive.test.ts tests/store-baseline-params.test.ts \
  tests/params-instantanea.test.ts
node --import ./node_modules/tsx/dist/loader.mjs --test \
  tests/store-persistence.test.ts tests/rescate-respaldo.test.ts tests/backup-cli.test.ts
npm run typecheck
git diff --check
```

Evidencia de la sesión: `/tmp/atlas-t100-preflight/phase1-boundary-before.tap`,
`phase1-boundary-after.tap`, `phase1-recovery.tap`, `phase1-typecheck.log`.
Las pruebas nuevas permanecen en el repositorio para repetir el contraste.

Revisión independiente de integración: diez controles adicionales en
`t100-phase1-independent.json`. Dos bases SQLite V1 con cuencas 0.05/1 conservan el
archivo byte a byte al abrir readonly; la migración SQL writable conserva el cuerpo
original hasta guardar, y el agua física coincide tras guardar/recargar. Ocho casos
de corrupción checksum-válido desde otra conexión, después de cinco guardados
calientes, cubren encoding/tupla/params/versión × load/save: rechazo, todas las tablas
durables intactas y transacción cerrada. Instrumento de sesión:
`/tmp/atlas-phase1-independent.mts`, reutilizando sólo el fixture V1 histórico.

Esta unidad no corrige todavía `-0`, no segmenta snapshots ni activa límites nuevos,
no modifica reglas reproductivas, cadencia, gobernador o familia V8. No acredita
2M ni rendimiento. La suite completa queda para integración conjunta, según la
coordinación explícita de raíz; esta entrega aplica focales y typecheck y no publica.
