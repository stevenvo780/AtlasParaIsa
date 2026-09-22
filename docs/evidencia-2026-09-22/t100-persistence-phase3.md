# T100, fase técnica 3: snapshots segmentados y transacciones coherentes

Base: `bfa4297fb741a5301b3f17c6a695c3b9c780d1b5` (reglas 7). Esta fase cambia el
transporte durable; no activa límites nuevos, reglas comunitarias, fauna, motores,
GPU ni flags de ejecución. T100 y su control de dos millones de teselas siguen
pendientes de la fase de límites. La fuente pública y sus datos no se tocaron.

## Contrato de representación

- SQLite pasa explícitamente de schema 4 a **5**, añadiendo `snapshot_parts` con
  `digest TEXT PRIMARY KEY NOT NULL` y `body TEXT NOT NULL`. Se verifican nombres,
  tipos, nulabilidad, PK y unicidad. Una tabla ausente o malformada declarada como
  schema 5 se rechaza; no se instala silenciosamente para ocultar el daño.
- Los schemas 1–4 siguen legibles en modo read-only sin migrar. Una apertura de
  escritura instala el nuevo esquema transaccionalmente, sin reescribir cuerpos
  anteriores. Los cuerpos compactos históricos siguen siendo legibles en schema 5.
- Con **hasta 32.768 teselas inclusive**, el encoder conserva los bytes de la fase
  2. Por encima cambia la representación durable: el cuerpo es un manifiesto
  `snapshot-parts-v1` y cada página contiene hasta **4.096 tuplas**, en su orden
  original. El mundo reconstruido conserva sus valores, parámetros y `-0`.
- El manifiesto contiene `{snapshotEncoding, world, tiles:{count,pages}}`; `world`
  incluye `tileEncoding: 'tiles-tuple-v1'`, pero nunca otro `tiles` ni otro
  `snapshotEncoding`. Cada descriptor lleva `index`, `digest`, `count`, `bytes`.
  Se exigen índices consecutivos, conteos exactos, SHA-256 y bytes UTF-8 reales.
  No se permiten claves JSON duplicadas, incluidas claves escapadas equivalentes.
- El manifiesto/metadatos tienen un guard de **8 MiB** y cada página de **4 MiB**.
  Esos guards son del transporte, no leyes del mundo ni valores de hardware. Esta
  fase segmenta teselas; todavía no promete metadatos arbitrariamente grandes.
- `StoreOptions.snapshotInlineTileLimit` permite probar el transporte en mundos
  pequeños: entero seguro entre 0 y 32.768, default 32.768. Se rechazan opciones
  desconocidas y valores inválidos. No entra en `WorldParams`, digesto o física.

El writer construye y serializa una página por vez, sin concatenar el JSON total
de teselas. El reader decodifica páginas dentro de una vista SQLite coherente y
reconstruye el array de teselas sin un spread gigante. El límite histórico de
65.536 teselas sigue vigente aquí y será reemplazado en una fase posterior.

## Atomicidad y fallos

Las páginas, archivos de crónica/tecnología/regiones, recibos y rotación de slots
comparten el `BEGIN IMMEDIATE` de Store. Una página ya existente sólo se reutiliza
si sus bytes reales coinciden con su hash. Antes del COMMIT se revalidan las páginas
escritas; con triggers se revisan además las que quedan sólo en respaldos 1/2.
Se rechazan sombras TEMP y el acceso a páginas usa el esquema `main`.

El GC conserva las referencias de los slots retenidos; su caché sólo contiene
listas de referencias por hash de cuerpo, no páginas ni archivo completo. Un
cuerpo anterior ilegible impide demostrar su conjunto de referencias, por lo que
se retienen las páginas. Los errores inesperados, incluido `RangeError`, se
propagan. El borrado ocurre en la misma transacción: un rollback restaura páginas
anteriores y deja intactas las colas del candidato. Si la tabla está vacía, el GC
lo comprueba dentro de esa transacción y no relee los tres cuerpos grandes.

Una página ausente, un checksum roto o JSON ilegible son daño físico y conservan
la política explícita de fallback de `Store.load`. Un manifiesto válido como JSON
pero imposible —índice, conteo, bytes, tuple, parámetros, encoding— falla cerrado
aunque exista un respaldo sano. Recalcular un checksum no legitima un mundo
inválido: la carga sigue pasando por migración y validación completa.

`previous()` selecciona y verifica dentro de una transacción de lectura. Como
SQLite no permite VACUUM dentro de ella, después de copiar comprueba nuevamente
en una transacción de la copia la misma fila seleccionada (slot, cuerpo, digest,
fecha) y todas sus referencias. Si otro escritor la rotó o retiró una página,
falla; no recupera silenciosamente otro tick. Se conserva la política previa de
no borrar automáticamente el destino si una copia ya creada falla al recuperar.

Todos los lectores internos de Store resuelven páginas: carga, comprobación para
rotar, baseline de crónica/tecnología y reconstrucción/selección de `previous`.
`readStoredSnapshot(db, slot)` ofrece esa vista coherente a herramientas host,
verifica transporte y no hace fallback; Store añade validación de mundo y archivo.
Smoke, `coherence-batch` y `benchmark-store` lo usan. El último informa por separado
digesto canónico del mundo, hash del cuerpo, bytes del cuerpo y bytes lógicos de
cuerpo más páginas. `lastSnapshotBytes` conserva esa medida lógica completa.
`benchmark-simulation` sigue siendo una comparación inline con fixtures menores
al umbral; lo declara y su verificador durable usa el reader común. Instrumentos
históricos congelados no se modificaron.

## Evidencia y reproducción

Negativo inicial: 22/27 pruebas fallaron por ausencia del transporte; los cinco
controles de schema inválido ya fallaban cerrados. Los tres controles iniciales
de `previous` tampoco podían llegar al protocolo inexistente. Los logs están en
`/tmp/atlas-t100-preflight/params-lab-snapshot-parts*-baseline.tap`.

Resultado final focal: **189/189, cero omitidas**, incluyendo **65** casos nuevos.
Cubren bytes inline, parámetros y digesto poscommit, `-0`, reapertura de archivo,
schema 4→5/read-only, corrupción con hashes recalculados, triggers que corrompen
sin arrojar, rollback de todas las tablas y colas, GC/slot 2 a cadencia real de 100
guardados, `RangeError`, claves duplicadas y sombras TEMP. Incluyen dos carreras
reales con conexión 2 antes de VACUUM, una carrera con borrado GC durante lectura,
y el cruce **32.768 inline → 33.024 segmentado** con validación y digesto completo.

Un último negativo detectó que la revocación de sesiones de `previous()` podía
disparar un trigger corruptor después del guard de páginas: el error llegaba
después del COMMIT. La prueba roja conserva esa evidencia en
`params-lab-previous-revoke-trigger-red.tap`; la revocación ahora precede el guard
final, y la prueba verde exige que el rollback restaure todas las tablas de la
copia y que el origen permanezca intacto.

```sh
npm run typecheck
node --import tsx --test --test-concurrency=2 tests/snapshot*.test.ts tests/store*.test.ts tests/archive.test.ts tests/backup-cli.test.ts tests/chronicle-store.test.ts tests/technology-store-review.test.ts tests/recovery*.test.ts tests/migration-params-v1.test.ts
npm run build
npm run test:smoke
node --import tsx docs/evidencia-2026-09-22/t100-parts-benchmark.mjs COPIA.sqlite /tmp/parts-report.json 8
```

Los focales y typecheck constan en `/tmp/atlas-t100-preflight/phase3-focal-final.tap`
y `phase3-typecheck.log`. Build y smoke pasan (`phase3-build-final.log`,
`phase3-smoke-final.log`). También pasan los CLI activos `benchmark-store` en
modo current, una ronda real a cadencia 20 (`phase3-profile-cli-current.log`), y
`benchmark-simulation`, 24 pasos pareados por escenario de 16 y 32 habitantes
(`phase3-simulation-cli.log`). La integración ejecutará la suite completa conjunta;
esta entrega no afirma haberla repetido y no publica main.

## Coste medido y límites

Instrumento versionado: `t100-parts-benchmark.mjs`; resultados completos con hashes
de padre, fuentes, instrumento, copias y digesto: `t100-parts-initial.json`,
`t100-parts-profile-before.json`, `t100-parts-fastpath.json`, `t100-parts-final.json`.
Fuente: copia read-only
del mundo real de cinco días, seed 51926, 12.288 teselas; los controles parten de
una misma copia, conservan cadencia 20 y rotan el orden. El padre importa sus dos
fuentes de persistencia exactas desde el commit declarado y comparte las leyes
actuales inalteradas. No se guarda ninguna base SQLite en Git.

La primera implementación añadía una regresión: mediana de save 75,07 ms en el
padre frente a 95,96 inline y 122,80 con páginas forzadas (8 rondas). Un segundo
perfil de 4 rondas localizó **24,01 ms medios en GC inline**: copiaba y hasheaba
cuerpos de los tres slots aun cuando no había páginas. El control vacío dentro de
la misma transacción evita ese trabajo; no reduce ninguna validación de páginas.

Primera medición con el fast-path, 8 rondas: padre **93,51 ms**, inline **101,89 ms**, páginas
forzadas **144,06 ms** de mediana. GC inline baja a **0,025 ms medios**. Permanece
un diferencial observado de 8,38 ms inline y el transporte segmentado cuesta más
en esta escena pequeña; no se presenta como una mejora de rendimiento general.
La carga del host estaba entre 19 y 21 y hubo verificaciones concurrentes.

Tras corregir el orden final de revocación, se repitieron 8 rondas con los hashes
de la fuente entregada: **65,63 ms padre**, **66,87 ms inline**, **107,51 ms con
páginas forzadas**; GC inline **0,017 ms medios**. La carga bajó a 10–11, por lo que
no se atribuye la mejora absoluta al codec ni se descarta la observación anterior.
Son observaciones pareadas compartidas, no una estimación aislada ni un gate de
p95 del servidor. El gobernador conserva su presupuesto y registrará el coste real.

Tras 160 pasos por variante, todas alcanzaron el digesto completo
`c8b5837fb2fbd08101b5b9eb15c6450f0d4aa969fd9a5581afc7774c4b7236da`, también al
releer SQLite. Padre e inline conservaron exactamente el cuerpo final de
3.907.805 bytes; el paginado usó 1.654.981 bytes de manifiesto y 3.908.344 lógicos
en total. El hash del manifiesto cambia correctamente: no se hace pasar por el
digesto completo del mundo. RSS máximo final de este proceso con tres mundos:
632,25 MiB (645 MiB en la repetición anterior).

No se midieron dos millones de teselas, pérdidas de energía, un proceso de
servidor grande, fauna ampliada ni nuevas leyes comunitarias. El formato elimina
la necesidad de una única cadena JSON para las teselas, pero la admisión de esos
tamaños, memoria real y roundtrip en otro proceso pertenecen a la siguiente fase.

Hallazgo independiente al cierre, reproducido también en `b83b976` sin este codec:
el guardado caliente heredado permite que números requeridos no finitos de una
tesela se conviertan en `null` antes de la siguiente revisión profunda. La carga
los rechaza, pero repetir guardados puede deteriorar los respaldos. Este commit
no atribuye su origen a la segmentación ni afirma resolverlo; se prepara una
corrección separada con negativos calientes y poscarga antes de publicar.
