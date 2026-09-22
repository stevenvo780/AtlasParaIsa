# Integración técnica A0 y candidata familiar V8

La fuente integrada pasó typecheck, **939/939 tests Node, cero fallos y cero omisiones**
(501.707 s), build, **18/18 E2E** y smoke. Hash conjunto de los `.ts` de world/server/shared:
`c23d9013dfb3b2bac57e86ec3c3ae480d571f2cce7a6f10106e36fa6e33768b9`.
Se usó `COMPUTE_NVRTC=/opt/cuda/lib64/libnvrtc.so`; la suite ejerció ambas GPUs.
No se habilita GPU en producción. El servicio público continúa en V7 (`3dd615e`).

## Tres cambios técnicos separados

**T102:** parámetros tipados, lexer de comas externas a arrays y barridos compatibles.
Defaults deterministas y opciones todavía inactivas. Focal 45/45; revisión independiente
de parser, Store y barrido, con negativos de coerción, iteradores y corrupción. T102 cierra;
T100 y A0 no cierran. El hardware no selecciona leyes ni defaults en este cambio.

**Store:** las rutas internas de línea base tecnológica y recuperación restauran y
validan parámetros persistidos antes de migrar. Antes podían reparar silenciosamente una
ley inválida al guardar. Ocho pruebas cubren corrupción y recuperación antigua: contra
`6ddadaf` fallan seis y pasan dos; con la corrección pasan ocho. Focal ampliado 92/92,
revisión independiente con segunda conexión y migraciones V6 personalizada/default.
Una recuperación explícita fallida puede dejar la copia de destino sin validar; el origen
permanece intacto. No se atribuye a este cambio una reparación de la migración V1.

**Digesto incremental:** conserva los bytes canónicos anteriores, orden efectivo de arrays,
claves numéricas de objetos, Unicode, `-0` y rechazos, usando bloques de aproximadamente
64 KiB. Diez pruebas y 1200 fixtures independientes contrastan el algoritmo anterior.
El control sintético de 537601366 caracteres supera el máximo de string de V8 (536870888):
el anterior lanza `RangeError: Invalid string length`; el nuevo produce el SHA esperado
`339beb87c9ceb601cf247cfc072fcb6577778573c57ec824ce7461c06d94e67a`.
RSS máximo: 1198492 KiB en el control fallido y 93272 KiB en el nuevo. No es un mundo válido,
una prueba de SQLite con dos millones de teselas ni una medida del servidor. El localizador
`diferenciaCanonica` todavía construye representaciones completas.

## Paridad y procedencia

`scripts/verify-params-baseline.ts` compara el parche T102 aislado contra V7 `3dd615e`.
`scripts/verify-integration-parity.ts` compara la integración contra familia V8 `eaa2709`.
En ambos: semillas 1/51926/20260905 × defaults/opciones reservadas, 1200 ticks, Store cada
20, recargas 600/1200 y clones descartados cada 120. El segundo además compara, fila por
fila, las diez tablas durables excepto snapshots. Esa exclusión es completa y explícita:
los snapshots contienen nuevos parámetros y metadatos temporales. No significa comparar
SQLite byte a byte. Los digestos completos difieren porque incluyen las opciones nuevas;
el control físico separado conserva bits, orden, `undefined` y referencias compartidas.

Resultados y hashes en `evidencia-2026-09-22/integration-parity.json`,
`integration-a0-gates.json` y `digest-scale-{old,new}.json`.

## Lo que falta

V8 permite cosechas familiares pequeñas con coste físico probado; el corte del experimento
a las 11:04 UTC sigue siendo mixto. Sólo un par completó 13 días y se extinguió sin nacimientos
en ambos brazos. No prueba sostenibilidad ni autoriza declarar terminado GOAL.md.

El preflight T100 identifica tres límites adicionales: errores semánticos de decode tratados
como daño recuperable; pérdida de parámetros WeakMap durante migración V1; y JSON que pierde
`-0` o excede el tamaño máximo de string con dos millones de teselas de alta precisión.
Persistencia segmentada y límites derivados del host necesitan su propio diseño, pruebas
negativas, compatibilidad y revisión. No se cambió ninguna de esas rutas en este gate.
