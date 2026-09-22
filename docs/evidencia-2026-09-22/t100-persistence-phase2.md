# T100, segunda unidad: preservar el signo de cero

Padre: `f3d4c3c086cf2408e7f59c69d942cea40184f21a`, reglas V7. Se mantiene el formato
`tiles-tuple-v1` y el esquema SQLite4; esta unidad no activa límites ni segmentación.

`JSON.stringify` convertía `-0` a `0`, aunque ambos son números admitidos y el digesto
completo distingue sus bits. El fallo existía antes de T102 en coordenadas y parámetros
numéricos; los arrays GPU añadieron otro lugar donde podía manifestarse. La corrección
escribe el literal JSON `-0`, que el lector histórico ya conserva. No reconstruye signos
perdidos en archivos antiguos ni cambia el digesto para ocultar esa pérdida.

Cobertura concreta del cambio:

- Snapshot: teselas, personas, comunidades y parámetros, incluida la comparación con
  defaults para evitar omitir `-0` cuando el default es `0`.
- Archivo de chunks: cuerpo, checksum, reapertura y reactivación sin avanzar física.
- Archivo de identidades: escritura, comparación inmutable y comparación caché/archivo.
- Linaje residente: igualdad entre caché y cola pendiente, conservando su proyección
  explícita y la equivalencia al reordenar propiedades de registros ordinarios.

El helper puro compartido resuelve `JSON.rawJSON` únicamente al escribir un `-0`.
Ese API se instala en [Node22.22.0](https://github.com/nodejs/node/blob/v22.22.0/deps/v8/src/init/bootstrapper.cc#L5005-L5030)
y figura habilitado por defecto en sus [flags de V8](https://github.com/nodejs/node/blob/v22.22.0/deps/v8/src/flags/flag-definitions.h#L263-L307),
el mínimo admitido por `engines`. La ejecución fue Node22.23.1. Se usa un tipo local
estrecho; no se cambian targets ni declaraciones globales de TypeScript. Un proceso
nuevo sin `JSON.rawJSON` importa la iluminación del cliente y calcula sus tintes;
escribir `-0` sin soporte falla explícitamente. El build del cliente no incluye
`rawJSON` ni el helper, comprobado en los assets producidos en este worktree.

Antes: **9 negativos fallaban y 4 controles ordinarios pasaban** en snapshots,
archivo y linaje. Después: **70/70 focales**, sin omisiones, typecheck/build/diffcheck
verdes. Las pruebas de archivo usan SQLite real, cierre/reapertura, checksums y
comprobación independiente del contenido archivado. El digesto de carga se compara
contra el estado confirmado después de save; no se borran colas para fabricar igualdad.
La suite completa queda para integración conjunta por coordinación de raíz.

## Coste del encoder

Se midieron tres variantes sobre la misma copia readonly del mundo a cinco días:
12 288 teselas, 25 personas, 3 707 718 caracteres. Cinco calentamientos y 60 rondas
alternadas; todos los cuerpos ordinarios fueron exactamente iguales.

| Variante | Mediana ms | p95 ms |
|---|---:|---:|
| Encoder padre | 28.35 | 35.64 |
| Replacer exacto sobre todo el objeto | 30.33 | 34.73 |
| Candidato: números exactos durante tuplas; replacer para metadata | 20.43 | 26.50 |

El candidato evita visitar otra vez cada escalar de las teselas mediante un callback
JavaScript. Los demás campos conservan el serializer exacto. Esta es una medición del
encoder en **host compartido**, no de `Store.save`, p95 del servidor ni del gobernador.
No cambia cadencia ni presupuesto; no acredita que el servidor cierre 50ms.

[Instrumento reproducible](t100-snapshot-benchmark.mjs) y
[resultados con hashes](t100-snapshot-numbers-benchmark.json) conservan SHA del padre,
encoder, cuatro fuentes candidatas, instrumento, cuerpo fuente y salida. Ejemplo:

```sh
node --import tsx docs/evidencia-2026-09-22/t100-snapshot-benchmark.mjs \
  /ruta/a/copia/world.sqlite /tmp/snapshot-numbers-benchmark.json
```

Focal final:

```sh
node --import tsx --test tests/exact-json.test.ts tests/snapshot-numbers.test.ts \
  tests/snapshot-numeric-archive.test.ts tests/lineage-numeric-identity.test.ts \
  tests/snapshot.test.ts tests/archive.test.ts tests/params-instantanea.test.ts \
  tests/lifecycle-persistence.test.ts tests/store-baseline-params.test.ts \
  tests/snapshot-boundary.test.ts tests/migration-params-v1.test.ts
npm run typecheck
npm run build
git diff --check
```

Logs de la sesión: `/tmp/atlas-t100-preflight/phase2-numbers-before.tap`,
`params-lab-lineage-numeric-baseline.tap`, `phase2-focal-final.tap`,
`phase2-typecheck.log`, `phase2-build.log` y `phase2-benchmark-final.log`.

No se afirma exactitud universal de todos los serializadores: recibos técnicos,
journals, fingerprints y otras rutas JSON fuera de las enumeradas no fueron
reescritas ni certificadas aquí. T100 y la puerta de 2M siguen pendientes.
