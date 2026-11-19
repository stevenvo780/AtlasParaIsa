# T022 — protocolo C21 de durabilidad y mundo compartido

Estado: **DISEÑO DOCUMENTAL, ENSAYOS NO EJECUTADOS**. Autor técnico Sol high,
cuenta secundaria autorizada; ownership exclusivo de este archivo y
[performance-protocol.md](performance-protocol.md). T022 queda sin marcar para
revisión del autor integrador y root. No acredita aceptación C21 ni implementa
instrumentos, física, esquemas, sesiones, servicios o migraciones.

## Autoridad, procedencia y puerta de ejecución

Rige [GOAL](../../GOAL.md), la
[constitución](../../.specify/memory/constitution.md),
[REGLAS](../../docs/REGLAS.md), [EVIDENCIA](../../docs/EVIDENCIA.md) y
[C21 del canon](../../docs/CRITERIOS-REALISMO.md#c21--b13--durabilidad-y-mundo-compartido).
La constitución del worktree coincide por SHA256 con la de main:
`e9aeee368c44fb706b6bb55221a9568ba1dd031252993ca68c207bf6c3d3cda0`.
El PLAN recuperado de main, leído en
`/datos/workspaces/personal/AtlasParaIsa/PLAN.md`, carril R7 y registro G0,
es la planificación vigente; no se lo reescribe ni se toma el antiguo estado del
PLAN de este worktree como revocación de G0.

Root liberó **GO-G0-R2 — CONTRATO** en
`/datos/tmp-atlas-lab/orquestacion-20261003/revision-criterios/ROOT-G0-DECISION-v3.md`
(SHA256 `658605e0d5f52d626def8169cf0e39f3d6477dbbbcb7c0573e7f85a0137b410c`),
tras peer `REVISION-R1-v3.md`
(SHA256 `d085aa80eb01573b4a2f913403f7b9191627433d99e70e5d5397b773a50815d2`)
y formal v3 sobre los mismos pins. R1-FROZEN-v3 conserva 87 inputs;
fingerprint original `8cf50919f02508a4f8d834a153c3d125d319e9f61f98726d0683be6dda0431f0`,
agregado `3989c066ea4c850cb8e4222a58a709fe0bbb7eaf2a5da8eb070aebb3f3a98467`;
manifiesto de archivo `faaac25fb0ace210103eb5a19f12b4be8a0fac009b4635a6bb9a9a880714ef54`.
Estos protocolos son adiciones posteriores, fuera de esos 87 pins. El manifiesto
original no se recalcula para incluirlos.

[Tasks](tasks.md) autoriza redactar T022/T023 después de G0 en archivos disjuntos.
Ejecutar requerirá un alcance posterior coordinado, preregistro revisado,
instrumentos disponibles y admisión fresca de recursos. G0 no ejecutó los 48+8
diseños ni aceptó criterios. G1 y el trabajo observador/evaluador pertenecen a sus
autores; este documento no los adelanta. El perfil
[thresholds.v3.json](contracts/thresholds.v3.json) sigue provisional, sin sellado.

## Alcance y afirmación que se intenta refutar

Dentro de una misma versión, estado **e historia juntos** deben recuperar el último
commit durable, con cero órdenes aceptadas y confirmadas perdidas. La afirmación
incluye inventarios/contenido, identidades vivas y archivadas, parentesco, autoría,
catálogo, recibos, crónica, regiones dormidas, reloj y observaciones de clientes.
Un snapshot igual con una fila de crónica confirmada ausente es FAIL.
Un prefijo histórico desconocido permanece UNKNOWN; no se rellena manualmente.

Se distinguen cuatro conjuntos, vinculados por ID de orden y fingerprint:

| Conjunto | Evidencia requerida | Expectativa tras interrupción |
|---|---|---|
| En vuelo, no aceptado | Petición enviada/encolada, sin respuesta de aceptación ni commit probado | Puede faltar; no cuenta como pérdida de aceptados. Debe declararse y reintentarse con el mismo ID |
| Commit completado sin respuesta recibida | Recibo externo de COMMIT y lectura independiente del efecto/resultado | Conservar efecto; reintento idempotente devuelve resultado guardado, sin ejecutarlo dos veces |
| Aceptado y ACK durable | Respuesta real de la orden, vínculo al commit y componentes durables coherentes | Cero pérdida; cualquier ausencia, mezcla de commits o duplicación es FAIL |
| Rechazado | Respuesta negativa y motivo con oportunidad/gates observados | No aplicar el efecto; no confundir HTTP 200 con `accepted` ni contar sólo éxitos |

No existe aquí un recibo durable inventado: el harness futuro debe capturar el
resultado íntegro de `POST /api/gesture` o el mensaje `{type:'result', result}` de WS y
conciliarlo con `Store.result(gesture)`/archivo `inputs` y el commit que lo contiene.
Los ACK `{type:'ack', sequence}` de `/ws?ack=1` sólo liberan un `state` en vuelo.
Ni ese ACK, ni una promesa encolada, ni un log «guardado» prueban durabilidad.
`commitId` del manifiesto de ensayo será una identidad externa de commit ligada a
tick, orden/serial y hashes; no se afirma que Store exponga hoy un contador de
commits. Dos commits pueden compartir tick: nunca usar tick como identidad única.

La lectura de [Store](../../src/server/store.ts) muestra WAL con
`synchronous=NORMAL`. La matriz de muerte de proceso no prueba resistencia a
corte eléctrico/caída del kernel. Un COMMIT retornado bajo NORMAL no se convierte
por declaración en un ACK con garantía de fsync. El preregistro debe declarar la
clase de fallo y la garantía demostrable. El carril de pérdida de alimentación
exige un entorno desechable y evidencia de persistencia física; está **pendiente**,
no se simula apagando el host compartido. Una pérdida de una orden aceptada
observada en ese carril es FAIL de la obligación, no una excepción aceptable. Sin
ese carril, el alcance frente a pérdida de alimentación queda UNKNOWN.

## Fuentes actuales y carencias del instrumento

| Fuente leída | Observable disponible | Límite que debe resolver el ensayo |
|---|---|---|
| `src/server/store.ts`: `save/load/result/backup/previous` | Transacción de snapshot, inputs, crónica, archivo tecnológico, legacy y chunks; slots 0/1/2 | No API pública de pausa por frontera ni stream externo de commits/ACK durables |
| `src/server/snapshot-parts.ts`, diarios y archivos enlazados por Store | Partes paginadas, cobertura y cabezas; leyes de lectura/retención | El lector bajo prueba no es el oráculo de integridad; cotejar bytes y filas independientemente |
| `src/server/app.ts`: `requestGesture/avanzar`, `/api/world`, `/health`, WS | Respuesta tras save, mismo world para proyecciones, `instanceId`, tick, pausa/retroceso | Proyección no transacciona simulación; no demuestra por sí sola igualdad de historia durable |
| `src/server/governor.ts`, `AppOptions.monotonicNow` | Reloj monotónico inyectable por instancia; decisiones del gobernador | No reloj/RNG oculto para explicar discrepancias; traza física y gobernador explícita |
| `scripts/storage.ts`, `scripts/respaldo.sh` | Backup/restore/previous existentes; destinos nuevos, verificación de copia | Backup de SQLite y `quick_check` no bastan para conservación/ACK/historia |
| `INVENTARIO-C21-C22.md` externo, directorio de revisión indicado arriba | Antecedentes V5/v6/V13 y huecos declarados | No recibo actual de backups, recuperación o mundo compartido |

El contrato V13 del 30-09 con `firstBackup:null` no certifica el primer respaldo
ni permite afirmar ausencia actual de backups. La migración histórica V5/SQLite
3→4 conservó un hueco de 1161 recibos; eso es antecedente, no fixture actual ni
continuidad retrospectiva. No abrir ni copiar ese mundo para este trabajo.
Las discrepancias entre documentación histórica y código se anotan; las leyes
del SHA congelado para cada futuro ensayo determinan el comportamiento esperado.

## Preregistro, fixtures y oráculos independientes

Antes de seleccionar datos candidatos, fijar un manifiesto de campaña con:
source SHA y hashes de fuentes aunque HEAD no cambie, Node/SQLite/compilador,
versiones world/protocolo/SQLite y params efectivos, profile hash y condición
provisional, seed registry previo, lista completa de casos/fronteras, clase de
fallo, calendario y límites, IDs/run/epoch, garantías de ACK, inputs físicos y
gobernador, ventanas `(apertura,cierre]`, observables y oráculo manual firmado por
revisor distinto del productor. No adaptar expected o seleccionar sólo fallos
favorables después de una candidata.

Sólo **fixtures sintéticos propios**, generados después en un directorio nuevo.
Cada caso parte de una copia desechable de su fixture, jamás del mundo público.
Fijar `CARTA_DATA_DIR` y `TMPDIR` propios, rutas resueltas dentro de la raíz de
ensayo, origen local y puerto reservado; PID/lock ownership verificable. Crear
acceso sintético independiente cuando la prueba de API lo requiera; nunca copiar
password, `access.scrypt`, tokens ni sesiones reales. No arrancar servicios viejos.

| Fixture de diseño | Datos que el constructor futuro debe materializar y fijar |
|---|---|
| F21-A limpio | Apertura conocida; orden válida con débito material y recibo, rechazo conocido, dos cámaras separadas, commits K0/K1 y orden en vuelo. Esperados escritos antes de usar Store |
| F21-B multicomponente | Inventario con contenido transportado, padre/madre/hijo y identidad fallecida archivada, obra/receta con autor y dependencias, recibo y crónica, región dormida/reactivada; todos con IDs y saldos manuales |
| F21-C retención/cadena | Tres slots verificables y límites de diario/catálogo; poda y checkpoint profundo alcanzados de modo reproducible, incluyendo reinicios antes de la cadencia profunda |
| F21-D versiones | Copia sintética por versión de origen soportada, params/limitsProfile/`stateVersion` explícitos, prefijo heredado UNKNOWN y archivo antes/después de migración |

Ninguno existe por la mera inclusión en esta tabla. El inventario de disponibilidad
debe comprobar constructibilidad con las leyes actuales; condición imposible o
fixture ausente → UNKNOWN del caso, sin fabricar el fenómeno para aprobar.
No curar `stateVersion`, modo heredado o agujeros de `ProjectState` a mano.

El oráculo manual conserva un ledger material: apertura + entradas = cierre +
salidas + consumo + pérdidas declaradas, con unidades/quanta del contrato, S/I
incluidos en conservación. Especifica IDs/parentesco/autoría y secuencias de
historia/recibos esperadas. El motor y el evaluador no generan los expected.
Un extractor futuro independiente lee una copia cerrada o un corte consistente,
contando todas las filas y componentes, incluidos archivos fuera de cámara.
`digestoCanonico` sólo cubre residente/pendientes; requiere manifiesto de archivo
aparte. Los hashes de archivos físicos conservan evidencia; igualdad lógica se
compara con serialización fijada sin ordenar arrays cronológicos/de simulación.
Los timestamps operativos se registran separados, sin esconder campos materiales.

En cada control positivo adulterado, eliminar una entrada confirmada de crónica,
un recibo, un progenitor o el débito de contenido debe ser detectado aunque el
snapshot sea igual. Retirar evidencia deja UNKNOWN dependiente, nunca mejora un
FAIL sustentado. No ejecutar evaluador para derivar el expected del control.

## Registro obligatorio por caso

Todo renglón de las matrices se expande a un recibo, no a un booleano:

```text
caseId; fixtureId; inputVersion; inputHashes; sourceHashes; seed; runId; epochId
before: K0 y component-manifest + ledger + ACK recibidos + clocks/inputs/gates
trigger: frontera fuente exacta, clase graceful|forced|io-fault, PID propio, recibo
expectedManual: K0|K1|checkpoint elegido, saldos/IDs/historia/reintentos/rechazos
observables: manifest esperado/actual, respuesta, ACK, log de fallo, clocks clientes
close: conexiones cerradas, procesos propios terminados, hashes de origen intactos
classification: PASS|FAIL|UNKNOWN; inválidos separados; primera diferencia y alcance
resourceStop: presupuesto admisión, timeout/log/output y motivo de interrupción
```

Los campos anteriores son una plantilla de recibo de laboratorio, **no una
extensión del schema**. Mapear los datos soportados a `fault`, `digest`,
`component-manifest`, `physical-inputs`, `governor-trace`, `host-scene`,
`source-metadata` y `run-manifest` del contrato v3; detalles extra permanecen en
artefactos de soporte con hash/sourceRefs. `component-manifest` cubre snapshot,
inventories, identities, parentage, catalogue, authorship, receipts, chronicle,
region-archive y `historyUnknownPrefixRef`. Resolver todas las refs mediante índice
explícito, schema/kind/hash/identidad/run/epoch/rol conciliados. Sin dato observar
`fieldCoverage` missing/unknown con motivo, no rellenar COMMIT/ACK/seq ficticios.

## Matriz de fronteras de guardado

Cada frontera siguiente requiere **dos casos distintos**, sufijos `-G` y `-F`:
G = solicitud de cierre graceful detenida en barrera; F = interrupción forzada del
proceso propio. El recibo debe probar dónde terminó la transacción. Un SIGTERM
pospuesto por ejecución síncrona puede acabar después de COMMIT: clasificar por
frontera alcanzada, no llamarlo falsamente fallo antes de COMMIT. Sin barrera
verificable → UNKNOWN de ese punto. Los hooks/barreras están pendientes.

Para Bxx se hereda F21-B/C, before=K0, expectedManual=K0 completo sin efecto en
vuelo, observables=vector íntegro+ACK+gates, close=origen intacto y proceso cerrado,
resourceStop=R21. Para Axx se hereda la misma plantilla con K1 completo durable,
reintento idempotente y ACK conservados según posición. La identidad final K se
demuestra con recibo de COMMIT; si fue incierta, declarar UNKNOWN y retener copia.

| IDs base | Frontera actual a instrumentar en `Store.save` | Refutación específica |
|---|---|---|
| B01 | Después de preparar snapshot, antes de `BEGIN IMMEDIATE` | No publicar borrador no confirmado |
| B02 | Después de BEGIN/comprobación de sesiones sintéticas, antes de flush | Nada parcial durable ni ACK positivo |
| B03 | Tras `flushTechnology` | Recibos/definiciones no sobreviven sin snapshot coherente |
| B04 | Tras `pruneTechnology` y metadata de cadena | No perder prefijo retenido ni modificar frontera en rollback |
| B05 | Tras `flushChronicle` | Crónica y snapshot vuelven juntos a K0 |
| B06 | Tras archivado de identidades `retiredLegacy` | Identidades/parentesco no mezclan K0 y K1 |
| B07 | Tras archivado de chunks y poda de crónica | Terreno/material/historia vuelven juntos |
| B08 | Tras rotación 0→1/2 | Rollback conserva red de respaldos original |
| B09 | Tras escritura de partes y slot0 | Partes referidas/GC no dejan snapshot a medias |
| B10 | Tras inputs/collect y validación final, inmediatamente antes de COMMIT | Ni resultado ni ACK sin el resto del commit |

| IDs base | Frontera después del COMMIT a instrumentar | Refutación específica |
|---|---|---|
| A01 | COMMIT retornado, antes de `saves++` | Contadores en memoria no condicionan recuperación de K1 |
| A02 | Antes de `acknowledgeHostCommit` | Archivo confirmado no se trata como cola descartada |
| A03 | Tras acknowledge, antes de actualizar crónica residente | Snapshot y archivo K1 íntegros |
| A04 | Antes de limpiar `retiredChunks` | No doble archivado/material al reintentar |
| A05 | Antes de limpiar `retiredLegacy` | No segunda muerte/identidad duplicada |
| A06 | Antes de `markTechnologyJournalCommitted` | No duplicar recibos ya escritos |
| A07 | Antes de `markTechnologyCatalogueCommitted` | Catálogo/autoría no se duplican ni pierden |
| A08 | Antes de caches `rememberTechnology/rememberSlotBounds` y retorno | Fallo de caché no revierte commit durable |
| A09 | App tras save, antes de `world=draft`/gobernador | Recuperación conserva K1 aunque memoria no se haya actualizado |
| A10 | App tras gobernador, antes de resolver órdenes pendientes | K1 sin ACK recibido; misma orden devuelve resultado guardado |
| A11 | Tras resolver/enviar resultado, antes de recepción cliente | Registrar incertidumbre de entrega sin borrar efecto |
| A12 | Tras recepción de respuesta aceptada y verificación durable | Ninguna orden confirmada perdida al reiniciar |

Los 10 puntos antes y al menos 10 después son tamaños **PROVISIONALES** heredados
de B13, no nuevos umbrales ni puntos ejecutados. Enumerar todos los planeados y
los no alcanzados; no reducir el denominador a los completados. Si una frontera
se transforma por cambios de código, remapear y congelar antes de ejecutar.
Para cada transacción durable adicional identificada en el alcance (inicialización/
migración, recuperación de copia, restauración/revocación sintética), enumerar
sus escrituras y repetir G/F antes de BEGIN, entre cada fase de escritura, antes
y después de COMMIT y antes del éxito comunicado. `load`/validación y la lectura
de origen de `previous` también requieren interrupción y origen preservado,
aunque no sean commits materiales nuevos. No afirmar cobertura por muestrear
sólo `save`.

## Matriz de recuperación, corrupción, archivo y clientes

Cada fila hereda el registro completo anterior y R21. Los expected indicados son
manuales; O = manifiestos de componentes/origen y C = clocks/observaciones/ACK.

| ID / fixture | Before y trigger | Expected manual; observables; cierre y clasificación |
|---|---|---|
| D01 / A | K0/K1, cierre graceful estable y reapertura misma versión | K1 sin reset a tick0; O+C, vínculos/órdenes exactos; origen intacto. Pérdida→FAIL, frontera desconocida→UNKNOWN |
| D02 / B | Bxx/Axx, fallo de escritura parcial/ENOSPC/EIO/timeout de bloqueo en almacenamiento desechable | Rollback K0 o K1 probado; error visible y pausa sin ACK falso; O+logs. No retirar disco del host; sin inyección reproducible→UNKNOWN |
| D03 / C | Slot0 físico roto, slot1 válido y archivo no posterior | Load adopta slot1 con retroceso declarado; primer save no pisa respaldo salvador, segundo rota sano; O+health/pausa. Pérdida adicional→FAIL |
| D04 / C | Slots0/1 físicos rotos, slot2 válido | Misma prueba para slot2; no asumir que aparece tras reinicios frecuentes; O+causa. Slot ausente→UNKNOWN de profundidad |
| D05 / B/C | Snapshot legible inválido, o respaldo atrasado frente al archivo durable | Rechazo cerrado, sin borrar ni crear mundo nuevo; O antes/después y error. Arranque con sustitución silenciosa→FAIL |
| D06 / B | Alterar en copia checksum/parte, padre, autor, recibo, crónica o región archivada; control ledger | Detectar cada clase independientemente; `quick_check` verde no la absuelve; O+diff manual. Dato sin cobertura→UNKNOWN |
| D07 / C | Backup coherente propio mientras escritor sintético avanza y con WAL pendiente | Copia refleja un único K demostrado, todos los componentes; original lógico preservado, versiones/bytes archivados; O+intervalo backup. No copiar sólo `.sqlite` abierto |
| D08 / C | Backup truncado/compresión fallida/destino ocupado/retención inválida | Error sin éxito nominal, sin sustituir copia buena; artefactos retenidos o limpieza documentada propia; O+stderr. Restauración no validada→UNKNOWN |
| D09 / B/C | Restore de backup a directorio vacío; intento a destino ocupado | Destino nuevo exacto, origen intacto, sólo sesiones sintéticas revocadas; ocupado rechazado; O+C. Borrar destino para ocultar rechazo→FAIL |
| D10 / C | `previous` desde slot1/2, incluidos dos checkpoints del mismo tick | Copia nueva igual al checkpoint por serial/IDs, poda explícita de futuros y sesiones sintéticas revocadas; origen completo conservado; O+recibo de pérdidas. No es cero pérdida del linaje original |
| D11 / C | Checkpoint cambia entre selección y backup, trigger altera copia, fallo durante recuperación | Rechazo sin «recuperado» nominal; copia fallida conservada separada, origen intacto; O+logs. No escoger otro checkpoint sin declararlo |
| D12 / D | Migración sintética soportada a lector actual, interrupción en cada fase | Archivo de origen con hash/version, destino verificable y mapa de transformaciones declaradas; O+ledger. No tocar `stateVersion`/holes; incompatible rechazado, faltante→UNKNOWN |
| D13 / D | Política de nueva versión publicada sólo en manifiestos sintéticos | Mundo de versión nueva inicia tick0 sin historia heredada; viejo queda archivado aparte. Restart/commit/reconnect misma versión no resetean; O. No ejecutar publicación ni copiar credenciales |
| S01 / A/B | Cámara1/cámara2 en regiones distintas, mismo servidor, corte a tick T | Misma instancia/mundo/clockTick T, stocks/IDs en solapamiento iguales; C+O. Diferente viewport no es otro mundo; falta corte común→UNKNOWN |
| S02 / B | Desconectar/reconectar un cliente, cambios de cámara y suscripción lenta | Historia/último ACK y orden recuperables; sin reejecución ni ticks por cámara; C+O. No exigir que paquetes asíncronos lleguen a la vez |
| S03 / B/C | Interrumpir servidor antes/después de ACK con clientes suscritos | Reconectar al mismo mundo/version, caída visible, órdenes mismas IDs idempotentes; reloj no retrocede salvo recuperación explícita declarada; C+O |
| S04 / A/B | Campaña preregistrada 12 clientes/1h, 1 y 2 cámaras explícitas, rápidos/lentos/no lectores | Cero bifurcaciones en cortes comunes; subscriber cambia transporte, no física; C+O+colas/coste. Tamaño/duración B13 PROVISIONALES; cobertura incompleta→UNKNOWN |

Rollback explícito D10 conserva el linaje original en su archivo y abre otra época
con pérdida declarada; jamás contará como recuperación sin pérdida de ACK
posteriores al checkpoint. La crónica debe decir el retroceso real; si no hay
tiempo verificable se declara desconocido. Corromper/recuperar copias no autoriza
borrar datos actuales, auto-reset, truncar el oráculo ni reparar manualmente.

## Operación futura y comandos existentes

Los siguientes comandos son **ejemplos futuros no ejecutados**; requieren fixture
materializado, presupuesto, ejecutables locales disponibles y preregistro. No
instalar dependencias. `C21_RUN` representa una raíz nueva propia resuelta dentro
de un área temporal autorizada; los subdirectorios de destino deben estar vacíos.

```bash
# Preparación futura: C21_RUN proviene del recibo de admisión, no de datos públicos.
export CARTA_DATA_DIR="$C21_RUN/source"
export TMPDIR="$C21_RUN/tmp"
npm run backup -- "$C21_RUN/backup.sqlite"
CARTA_DATA_DIR="$C21_RUN/restored" npm run restore -- "$C21_RUN/backup.sqlite"
npm run recover:previous -- "$C21_RUN/recovered-slot1" --slot 1
npm run recover:previous -- "$C21_RUN/recovered-slot2" --slot 2
DB="$C21_RUN/source/world.sqlite" DEST="$C21_RUN/compressed-backups" npm run respaldo
```

`respaldo.sh` tiene destino por defecto fuera del ensayo: **siempre fijar DEST**.
La recuperación `previous` recibe un directorio; backup/restore reciben archivo,
según `scripts/storage.ts`. La verificación complementaria independiente es
obligatoria aun con exit0. No lanzar CLI con valores sin resolver ni compartir raíz
entre casos. La copia original puede avanzar sólo en D07; allí los hashes físicos
deben compararse en cortes quietos, y la no interferencia lógica se demuestra con
una referencia concurrente, no exigiendo bytes inmóviles durante escritura.

```text
PSEUDOLLAMADAS — harness futuro, NO existe por este documento:
prepareSyntheticFixture(manualLedger, sourcePins, newRoot) -> inputHashes
freezeCasePlan(fixtureHashes, frontierMap, ackGuarantee, R21) -> preregisteredPlan
runFaultCase(plan, frontierBarrier, gracefulOrForced) -> rawEvidence
extractIndependentComponents(rawEvidence.closedCopy) -> actualManifest
compareManualExpected(plan.expectedManual, actualManifest, ackTrace, clientCuts)
closeOwnedRunAndPreserveEvidence(rawEvidence) -> closureReceipt
```

Faltan constructor de fixtures, hooks por frontera, recibos externos de COMMIT,
captura ACK/cliente a tick común, extractor independiente y supervisor de I/O/fallos.
No sustituirlos por un unit test verde o `quick_check`. Su implementación futura
requiere ownership nuevo; no se modifica aquí Store ni auth.

## Recursos R21, paradas y decisión

R21 se aplica a **cada caso**: admisión fresca del host y suma de todos los procesos
propios, incluidos servidor sintético, clientes, extracción y compresión; CPU,
RSS, disco/WAL/backups/output/log y plazo máximo fijados antes de empezar.
Fedora autorizado ≤100% sobre 20 threads y 38 GiB de RAM física, GPU integrada
Intel; pool propio FULL configurado 20 CPU/24 GiB. P0.c START2 es un panel de
cuatro ejecuciones running, sin cierre según corte `2026-10-04T04:07Z`, con
reserva FULL del pool completo **agregada** de 20 CPU/24 GiB/output 40 GiB.
La autorización no demuestra disponibilidad para C21. Torre ≤80% CPU global
sobre 32 threads/125 GiB de RAM física, slice propia agregada ≤24 CPU/32 GiB;
no se suman esas cifras como licencias separadas por caso. G1 full suite en torre
figura activo desde `2026-10-04T04:13:38Z`, con reserva 8 CPU/16 GiB/output 8 GiB
y concurrencia 4; no acredita PASS. Son cortes comunicados, no garantías futuras
de estado o disponibilidad. Los pools propios configurados son más conservadores
que la autorización de host; no fijan un límite permanente del usuario sobre
toda la RAM. Reservas actuales, ciencia y servicio público se preservan. Este
documento no crea capacidad libre ni admisión; cualquier inicio exige preflight
fresco y recibo verificable. Límites de permisos/preregistro más estrictos
prevalecen.

Sin recibo de recursos, límite de output/log/tiempo o ruta propia → caso no iniciado.
Al cruzar presupuesto, degradar el público, fallar el monitor o alcanzar plazo,
detener sólo PIDs propios, registrar motivo y último corte, conservar copias/logs;
caso abortado UNKNOWN de cobertura, con FAIL observado válido preservado.
No borrar evidencia para liberar cupo ni matar tareas ajenas. FULL suites futuras
sólo las coordina integrador en worktree y TMPDIR/output propios dentro del budget;
este protocolo no solicita ni ejecuta suites/builds.

Por subgate, PASS requiere matriz planeada completa y evidencia conjunta exacta;
FAIL por pérdida aceptada, historia/parentesco/autoría incoherente, doble aplicación
o bifurcación demostrada. UNKNOWN por falta de ACK/commit verificable, frontera,
historia, instrumentación o recursos. Entrada inválida se distingue del fenómeno.
El denominador conserva todos los casos/clientes planeados y abortos, con primer
desacuerdo, bytes/IDs, duración y límites. No conceder PASS global con un prefijo
UNKNOWN, un rollback declarado o una clase de crash pendiente. Root decide la
aceptación posterior sobre evidencia revisada; preparar este protocolo no la concede.
