# Informe T132 — Guardado incremental por replay determinista y páginas marcadas (`persistencia.paginasSucias`)

Fecha: 2026-11-19  
Rama: `sprint/t132-replay-20261119`  
Autoría: Codex (implementación y pruebas) + revisión e informe en integración.

## Resumen

Se implementa el guardado incremental bajo `persistencia.paginasSucias=true` (opt-in; `DEFAULT_PARAMS.persistencia.paginasSucias` permanece en `false`) en `src/server/snapshot.ts` y `src/server/store.ts`, junto con la suite completa de verificación y fallos cerrados en `tests/store-replay.test.ts`.

En vez de reescribir el terreno numérico completo en cada guardado, el almacén mantiene una cadena acotada de deltas deterministas (`snapshotReplay: 1`) anclada en checkpoints completos cada `DEEP_CHECKPOINT_EVERY_SAVES = 100` guardados durables (`depth <= 99`):

- **Checkpoint (`kind: 'checkpoint'`, `depth: 0`)**: almacena la instantánea base codificada por `SnapshotParts`, su versión de reglas, `tick` y raíz canónica (`digestoCanonico`).
- **Delta (`kind: 'delta'`, `depth: 1..99`)**: almacena el hash `parent`, los `inputs` (gestos y resultados ordenados), los cambios externos explícitamente marcados vía `captureReplayChange(world, path)` y los journals (`chronicle`, `technology`), junto con la raíz canónica esperada (`root`). El cuerpo del delta no serializa `"tiles"`.
- **Fail-closed y paridad canónica**: `prepareReplay` verifica que reproducir el delta desde el padre produce exactamente el mismo `digestoCanonico` del mundo vivo (detectando y rechazando cualquier mutación externa no marcada sin escribir ni corromper la cadena). `replayWorld` reconstruye de forma iterativa, rechaza cadenas con `depth > 99`, padres ausentes/corruptos o raíces discordantes, y conserva intacto el eslabón `previous`.
- **Retención acotada**: el recolector de metadatos mantiene los objetos `snapshot-replay-v1:*` acotados a `<= 2 * DEEP_CHECKPOINT_EVERY_SAVES + 3` tras múltiples rollovers.

## Resultados medidos

Verificación ejecutada en `worktrees/t132-replay-20261119`:

- `npm run typecheck`: verde (0 errores).
- `npx tsx --test tests/store-replay.test.ts tests/store-chunks-tupla.test.ts tests/snapshot-parts.test.ts tests/store.test.ts`: **82/82 pruebas verdes, 0 fallos** (68,9 s).

Control medido en `tests/store-replay.test.ts` (semilla `51926`, 16 habitantes, 2 048 teselas, 12 guardados en 24 ticks):

| Modo (`persistencia.paginasSucias`) | `payloadBytes` | `walBytes` | `saveMsMedian` | `saveMsP95` | `digestoCanonico` |
|---|---:|---:|---:|---:|---|
| `false` (guardado completo) | 5 131 625 B | 10 697 232 B | 4,25 ms | 10,01 ms | `d0a52eac…217b9` |
| `true` (replay incremental) | **5 915 B** (**867× menor**) | **788 736 B** (**13,56× menor**) | 102,88 ms | 1 405,62 ms | `d0a52eac…217b9` (idéntico) |

### Lectura honesta del compromiso actual

- **Escritura en disco y WAL**: el ahorro es masivo (867× menos bytes de carga y 13,6× menos WAL) manteniendo paridad bit a bit y respaldo `previous()` íntegro incluso cruzando rollovers cada 100 guardados.
- **Latencia `saveMs`**: en esta primera entrega, cada guardado delta valida `digestoCanonico` completo contra el replay para garantizar detección fail-closed de páginas no marcadas en el 100 % de los guardados; en una escena pequeña (2 048 teselas) esa comprobación cuesta ~103 ms de mediana frente a 4,25 ms del guardado completo. Por ello `persistencia.paginasSucias` debe seguir en `false` por defecto hasta sustituir la verificación completa por el hash incremental por regiones (`IncrementalRegionHasher`) en el siguiente paso de Etapa D.

## Ficheros tocados

- `src/server/snapshot.ts` (+69/-1)
- `src/server/store.ts` (+248/-25)
- `tests/store-replay.test.ts` (nuevo, 12 pruebas de paridad, rollover, marcas externas, toggle y corrupción fail-closed)
- `specs/002-mundo-ilimitado/informes/T132-report.md` (este informe)
