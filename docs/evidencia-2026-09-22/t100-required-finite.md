# Rechazo de números requeridos inválidos antes de persistir teselas

La revisión independiente reprodujo el defecto en `b83b976`, anterior al codec
segmentado: un guardado caliente —también el primero tras `load()`— convertía
NaN y ambos infinitos de `x`, `y`, `moisture`, `vegetation` o `food` en `null`.
El checksum del JSON coincidía, pero la carga posterior rechazaba el mundo.
Continuar guardando podía reemplazar también el respaldo cercano antes de la
siguiente validación profunda. Informe independiente y fixtures privados:
`/tmp/atlas-save-nonfinite-audit/report.md`, `results.json`, `manifest.json`.
La entrada fue inyectada: no demuestra que la física produzca esos valores.

Sobre `cc83409`, el writer de tuplas exige que esos cinco campos sean números
finitos. También rechaza `null`, `undefined` y cadenas en ellos. El formato inline
lo comprueba antes del BEGIN; el paginado lo comprueba dentro de la transacción y
cualquier escritura anterior se revierte. No se corrigen ni sustituyen valores.
Los rangos/coordenadas y la revisión profunda mantienen sus reglas y cadencia;
los opcionales mantienen su contrato anterior y `-0` sigue siendo exacto.

La prueba nueva dio **76 negativos rojos por ausencia de rechazo y 8 controles
verdes** antes de modificar el encoder. Después pasan **84/84 nuevos** y
**273/273 focales, cero omitidos**, con typecheck verde. Los negativos cubren
ambos formatos, guardado caliente y primer guardado tras cerrar/cargar, valores
no finitos y tipos incorrectos, quince intentos inválidos consecutivos, todas las
tablas y los slots 0/1/2. Las cinco colas reales (chunks, identidades, crónica,
ejecuciones y catálogo tecnológico) conservan referencia y contenido. La
reapertura recupera el mismo digesto confirmado, sin reparar el candidato.
Los ocho positivos verifican `-0`, bytes ordinarios y reapertura.

```sh
npm run typecheck
node --import tsx --test --test-concurrency=2 tests/snapshot*.test.ts tests/store*.test.ts tests/archive.test.ts tests/backup-cli.test.ts tests/chronicle-store.test.ts tests/technology-store-review.test.ts tests/recovery*.test.ts tests/migration-params-v1.test.ts
node --import tsx docs/evidencia-2026-09-22/t100-required-finite-benchmark.mjs COPIA.sqlite /tmp/required-finite.json
```

Logs: `/tmp/atlas-save-nonfinite-audit/required-finite-baseline.tap`,
`required-finite-final.tap`, `typecheck.log`. La suite completa conjunta corresponde
a la integración. No se publicó ni se tocó el mundo público.

El microbenchmark compara el encoder exacto de `cc83409` y el candidato sobre el
mismo mundo real cargado en read-only, con 12.288 teselas, cinco calentamientos y
40 rondas alternadas. Todos los cuerpos ordinarios resultaron idénticos. Medianas
16,78 ms padre / 15,73 ms candidato; p95 observado 29,83 / 27,18 ms. Es un control
del encoder en host compartido, no evidencia de aceleración, `saveMs`, p95 del
servidor ni capacidad de dos millones. El instrumento y JSON incluyen hashes de
las dos fuentes, cuerpo e instrumento y todas las muestras.

Alcance deliberado: los cinco números requeridos de las teselas. No se afirma
validación universal de metadatos, archivos históricos o recibos. Este commit es
independiente de las correcciones pendientes de la revisión de `previous()`.
