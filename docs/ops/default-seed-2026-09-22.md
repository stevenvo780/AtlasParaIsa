# Diagnóstico reproducible de la semilla51926 — V7 frente a V9

Este protocolo crea dos mundos nuevos desde tick0 para comparar las leyes V7 y V9 durante25d/60000ticks. La semilla fue observada antes del experimento: es diagnóstica, **no reservada**. No reconstruye la historia del servidor ni sus pausas de gobernador. No promete supervivencia ni repoblación.

La [captura sanitizada](../evidencia-2026-09-22/default-seed-public-params.json) contiene22 parámetros materiales/operativos y procedencia (tick53700, semilla, versión, checksum y cero inputs aceptados). **No contiene autenticación, sesiones, contraseñas, datos de la carta ni cuerpos de habitantes.** SHA256: `272ec788ba8dbb4fdb7e813c201b4bca83298497f960097a0eecba1f512b0b6a`.

## Identidades fijadas

| Componente | Identidad |
|---|---|
| V7 | commit `3dd615ee069d9d61f51a4c74f85d33c15a4583e0` |
| V9 | commit `cf04ac402d25179c9fa878292390e3c2aff0255e` |
| V7 núcleo world/server/shared | SHA256 `783b2dc78b0361a51e390c2e015429a984c50f8b1b6ce73bbd941d7e4d30778d` |
| V9 núcleo world/server/shared | SHA256 `cd11a32b26ffbce2e28c6b0e9bf97196180a1219aefb0e0577b007d669603125` |
| V7 src completo + package.json | SHA256 `776ae07aa9a037e4d656f5abfc57d5cf770792d1102698e23ef68a4f9eadb4c7` |
| V9 src completo + package.json | SHA256 `9addd8f10de65b86b579800bf31b9f2f10a39788aa9251527817de32bd9e704d` |
| Instrumento family-reserve.ts + metrics.ts + family-observation.ts | SHA256 `12053834befc95ebedc4bf1bf4c4308ff49c040c21d233f585aa02d3f894f542` |
| Wrapper portable, protocolo2 | SHA256 `4cb87b02603882fe12dc8e49b2998126529c8a5389a187841ca114eb8e533d8e` |
| Piloto portable | SHA256 `edc47d62a889cc6aaf1a8c4a7c4351f8a6357f695847ee54e248d3bb832892cb` |

`prepare` extrae **ambos motores con git archive**, sin usar src del checkout ni exigir HEAD=V9. También extrae el instrumento original desde V9: modificaciones futuras al laboratorio no entran silenciosamente en esta comparación. Guarda copias de sólo lectura, sus hashes, ambos launchers y el JSON íntegro de parámetros. Cada parser de motor debe devolver exactamente los22 valores capturados.

Los objetos Git referenciados tienen que existir en un clon nuevo. Se conservan mediante las ramas originales `sprint/family-reserve-v8-20260922` y `sprint/family-contention-v9-20260922` cuando sean publicadas; el historial de esta última alcanza V7. La existencia local se puede comprobar con `git cat-file -e <sha>^{commit}`. No sustituir un SHA ausente por HEAD ni por otra versión de reglas.

## Ejecución desde la raíz del repositorio

Requiere Git, tar, nice, Node compatible con package.json y dependencias instaladas con el lockfile. La prueba documentada usó Node22.23.1 y tsx4.23.13. Los hashes de fuentes no abarcan el binario Node ni el directorio node_modules; registrar también sus versiones al comparar ejecuciones de otros hosts.

Usar un identificador de directorio **nuevo**; el protocolo rechaza sobrescrituras. Las órdenes `prepare`, `check` y el piloto no inician el lote25d. Solamente `run` lo hace.

```bash
audit_batch="$PWD/artifacts/default-seed-v7-v9-20260922/batch-identificador-nuevo"
node --import ./node_modules/tsx/dist/loader.mjs scripts/lab/default-seed-batch.ts prepare "$audit_batch"
node --import ./node_modules/tsx/dist/loader.mjs "$audit_batch/default-seed-batch.ts" check "$audit_batch"
node --import ./node_modules/tsx/dist/loader.mjs "$audit_batch/default-seed-pilot.ts" "$audit_batch"
node --import ./node_modules/tsx/dist/loader.mjs "$audit_batch/default-seed-batch.ts" check "$audit_batch"
node --import ./node_modules/tsx/dist/loader.mjs "$audit_batch/default-seed-batch.ts" run "$audit_batch"
```

Las copias congeladas resuelven su repositorio por el manifiesto; no dependen del cwd desde el que se invocan. El manifiesto conserva rutas absolutas: para otro checkout/host hay que preparar un batch nuevo, no editar rutas y reutilizar un piloto antiguo.

El piloto usa el mismo instrumento sin modificar, un día/2400ticks por brazo y timeout simétrico de180s. Comprueba checkpoint0 recargable, reglas7/9, cero inputs, igualdad de todos los parámetros y métricas diarias. Su recibo incluye hash del manifiesto y del propio piloto. El launcher verifica ese recibo antes de cualquier job25d.

## Condiciones y evidencia

- Semilla51926 en ambos brazos, sin gestos, `engine=world`: stepWorld y Store real, sin gobernador, scheduler de servidor, clientes ni red. El presupuesto50 queda persistido, pero no interviene en este motor de laboratorio.
- Todos los parámetros de la captura: cadencia100, ventana de eventos24000 y el resto de las leyes exactas. Nunca reconstruir sólo esos dos overrides dejando otros valores a defaults futuros.
- Dos workers con incremento positivo `nice -n 10`; la prioridad efectiva puede ser16 si hereda6. Deadline7200000ms por proceso, simétrico, SIGTERM y escalamiento a SIGKILL5s.
- Cada job tiene CARTA_DATA_DIR aislado; TMPDIR pertenece al batch. Mínimo20GiB libres y presupuesto64GiB de artefactos, comprobados antes de lanzar y cada5s. Es una guarda muestreada, **no una cuota del filesystem**: puede haber un exceso transitorio entre comprobaciones. No borra evidencia para hacer espacio.
- La desaparición de un archivo temporal entre readdir/stat devuelve cero para ese archivo. Errores de permisos u otros errores de lectura siguen deteniendo el lote; no se confunden con un presupuesto satisfecho.
- Se conservan SQLite y journals, run.json, cierres diarios, muestras familiares cada120ticks, logs, resultados, motivo de timeout/interrupción y hashes. El instrumento registra primera extinción mortal, nacimientos/muertes, causas, reservas/oportunidades familiares y uso útil separado de S/I.
- Un timeout o stop por recursos es censura, aunque un wrapper salga0. Comparar ventanas completas comunes y declarar cuánto horizonte se alcanzó. No extrapolar25d ni convertir timings compartidos en una medición de servidor.

No se incluyen fixes técnicos posteriores a los dos commits fijados, incluido el encoder no-finito. Un error de esos binarios debe conservarse como resultado; no se reemplaza el motor en mitad de una corrida.

## Procedencia histórica y verificación de esta entrega

El diagnóstico ya iniciado el22 de septiembre conserva el **wrapper privado de protocolo1** `68bdccf3e50e9cd990ca061dfcc5e82b7ce69f029fec07efae1b094600166733` y su piloto `513a1f3cdc80e7028feaec37b420f9dd1cf2344a93d5df3bb546a45cc73ff711`. El wrapper portable tiene bytes distintos; **no reemplaza ni adopta aquel manifiesto**. Sólo el instrumento físico/de métricas, los motores, las leyes y los presupuestos conservan las identidades anteriores.

Antes existió otro intento, wrapper `32a720685778855617d7e061a3cba021214f7c18b59494f938e506a80c2b8524`, interrumpido en ambos brazos aproximadamente25s después del inicio al desaparecer un temporal SQLite durante el cómputo de disco. Sus fuentes, pilotos y evidencias quedaron retenidos. El tratamiento exclusivo de ENOENT corrigió ese fallo de wrapper; sus ticks no se sumaron al nuevo intento.

Validación portable: typecheck y **3/3 pruebas, cero skips**, incluida CLI real en un clon temporal situado en HEADV7, con src e instrumento locales señuelo que lanzarían si fueran usados. Se preparó por SHA, se ejecutaron ambos launchers congelados desde otro cwd, se corrieron solamente los dos pilotos2400 y se recargaron sus checkpoints. Diez contratos alterados, fuente modificada, falta de piloto y recibo de otro manifiesto fueron rechazados; ningún job25d fue lanzado por esas pruebas. El control ENOENT/EACCES y la conservación de censura también pasaron. Los archivos históricos y los procesos del diagnóstico en curso no se tocaron.
