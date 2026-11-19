# T135/T137 — Delta de teselas por campo, `ack`/`resync` y cliente de deltas

Rama `sprint/t135-t137-deltas-20261119`, worktree `t135-t137-red-deltas`. Solo este worktree; no se tocó el árbol principal ni se ejecutó `npm test` completo.

## Ficheros tocados

- [types.ts](../../../src/shared/types.ts): `StateDelta` (`state-delta` con `baseSequence`, `sequence`, `tileUpserts`, `tileRemovals`, `peopleUpserts`, `peopleRemovals`, `worldPatch`), `resync` en `ClientMessage` y `StateDelta` en `ServerMessage`. `PROTOCOL_VERSION` no cambia: los deltas son opt-in por `red.deltas` y un cliente anterior sigue recibiendo `state`.
- [deltas.ts](../../../src/shared/deltas.ts) (nuevo): `computeStateDelta`/`applyStateDelta` puros, compartidos por servidor, cliente y pruebas.
- [app.ts](../../../src/server/app.ts): buffer corto (8 vistas) por socket en `ClienteWs.delta`, envío de deltas en `sendView`, `ack` viejo ⇒ `needFull`, `resync` y cambio de viewport ⇒ `state` completo.
- [connection.ts](../../../src/client/connection.ts): aplica `state-delta`, acusa con `ack`, pide un solo `resync` por secuencia perdida y se recupera con el siguiente `state`.
- [landscape.ts](../../../src/client/landscape.ts): `interpolatePeople` poda `prevPeople` a los ids del frame actual.
- [red-deltas.test.ts](../../../tests/red-deltas.test.ts) (nuevo) y casillas T135/T137 en [tasks.md](../tasks.md).

`game.ts` no necesitó cambios: el censo ya sale de `stats.census` vía `censo-view.ts`/`demographicSummary` (T134); `receiveWorld` consume igual un `WorldView` reconstruido desde deltas.

## Qué cambió y por qué

- **Apagado por defecto**: con `red.deltas=false` (default en `params.ts`), `sendView` sigue enviando `{type:'state', world}` por el camino de siempre y el cliente solo ve el protocolo actual. Probado contra servidor real.
- **Comparación tras `r3`**: el servidor proyecta con `projectWorld` (que ya cuantiza) y difiere sobre esas vistas; en `tileUpserts` viaja `{x, y, ...camposCambiados}` y un campo que desaparece viaja como `null` (el cliente lo borra, porque JSON no transporta `undefined`). `tileUpserts` se emite como array y el cliente también acepta la forma `Record<"x,y", …>`.
- **Personas**: `peopleUpserts` lleva la `PersonView` completa de quien cambió o entró; `peopleRemovals`, los ids que salieron. El resto del `WorldView` viaja en `worldPatch`. La reconstrucción ordena teselas en el barrido (y,x) de `projectTerrain`.
- **Buffer y recuperación**: primera conexión, cambio de viewport, `resync` o `ack` fuera del buffer de 8 vistas ⇒ `state` completo acotado al viewport, y solo si `bufferedAmount ≤ 256 KiB` (si no, se aplaza, no se termina el socket). Con flujo (`/ws?ack=1`) nunca hay más de un mensaje en vuelo, como hoy.
- El hardware no puede cambiar el resultado de este cambio: no toca `src/world` ni ninguna ley; solo cambia cómo viaja una proyección ya calculada. La misma vista proyectada produce el mismo `WorldView` reconstruido, en cualquier máquina.

## Cómo se prueba

`tests/red-deltas.test.ts` (5 pruebas):

1. Convergencia pura durante 120 pasos (incluye ticks ecológicos `tick % 10 === 0`): aplicar cada delta reconstruye exactamente el `WorldView` de `projectWorld` (comparado tras el cable JSON, sin `performance`).
2. `tileUpserts` en forma `Record` también se aplica.
3. Cliente (`Connection` real): delta válido aplicado y acusado; delta con base perdida dispara exactamente un `resync` (aunque se repita) y el siguiente `state` recupera la base.
4. Servidor real con `red.deltas=true`: 120 pasos, convergencia contra el `state` completo del mismo tick por HTTP, `resync` ⇒ `state`, 0 sockets terminados.
5. Servidor real con `red.deltas=false`: solo llegan mensajes `state`, ningún `state-delta`.

## Cifras medidas (esta torre, viewport medio 12×8, mundo semilla 51926)

| Medida | Delta | `state` completo |
|---|---:|---:|
| Paso normal | 12 831 B | 31 390 B |
| Tras tick ecológico | 25 032 B | 37 270 B |
| Mayor delta en 120 pasos por servidor real (24 deltas, eco en 10…120) | 26 357 B | superior a todo delta |

Todo delta queda `< 120 KiB` en viewport medio. El resto tras el tick ecológico lo domina `worldPatch` (stats/tecnología/crónica), no las teselas: por campo, la tesela que solo cambia en `fertility` viaja con 3 claves.

## Verificación

- `npm run typecheck`: 0 errores.
- `npx tsx --test tests/red-deltas.test.ts tests/connection.test.ts tests/world-view-size.test.ts`: 33/33 verdes (incluye las pruebas previas de `connection.test.ts` sin cambios de conducta con deltas apagados).
- No se ejecutó `npm test` completo, por instrucción expresa del encargo.
