# Informe T132 — Guardado incremental por replay determinista (`persistencia.paginasSucias`)

Fecha: 2026-11-19  
Rama fase 2: `sprint/t132-fast-save-20261119`

## Resultado

La fase 2 reduce la ruta delta ordinaria a un solo replay y una sola comparación estricta del estado, sin clonar el mundo cacheado ni calcular dos `digestoCanonico` completos por guardado. `persistencia.paginasSucias` continúa siendo opt-in; no se cambió `DEFAULT_PARAMS`.

La cadena sigue acotada a 99 deltas y conserva checkpoints completos cada 100 guardados. Los checkpoints mantienen la raíz canónica histórica. Los deltas nuevos usan un compromiso SHA-256 del padre y de todo el transporte determinista (tick, reglas, inputs/resultados, cambios marcados y journals); el cuerpo completo del nodo sigue autenticado por su digest de objeto. Al cargar:

1. se verifica físicamente cada nodo y su padre;
2. se vuelve a ejecutar el delta;
3. se comparan exactamente resultados y journals;
4. se verifica el compromiso del delta;
5. para deltas escritos por la fase 1 se conserva el fallback a `digestoCanonico`.

Por tanto, cambiar instrucciones, resultados, journals, padre o raíz sin rehacer una cadena coherente falla cerrado. El checkpoint canónico continúa siendo la ancla de estado.

## Fail-closed en `save()`

`prepareReplay()` mantiene un mundo replayado privado, separado del mundo vivo. En la ruta ordinaria:

- consume la caché verificada directamente, evitando `cloneWorld()`;
- retira la caché **antes** de mutarla, por lo que una excepción o rollback nunca puede reutilizar un candidato parcial;
- ejecuta el delta una vez;
- compara el mundo replayado y el candidato a guardar con `isDeepStrictEqual`, incluidos formas, huecos, `undefined`, prototipos y `-0`; para parámetros se excluye únicamente `motor.depuracion`, igual que en el digesto público;
- solo entonces autoriza el nodo durable.

Una mutación no marcada no se omite silenciosamente: la comparación falla antes de confirmar la transacción. Esto se prueba tanto entre auditorías como en la auditoría profunda. El fallo transaccional conserva heads, journals e inputs reintentables, y `previous()` sigue recuperando exactamente un guardado.

Las dos revisiones completas que antes caían en guardados consecutivos estaban desfasadas: `assertWorld` usaba `this.saves` y la revisión de la cadena retenida `nextDurableSaves`. Ahora comparten el mismo guardado cada `DEEP_VALIDATION_EVERY_SAVES = 10`. Las mediciones separan deliberadamente deltas ordinarios de esa auditoría profunda.

## Antes y después

Protocolo de control: semilla `51926`, 16 habitantes, 2 048 teselas, 12 guardados/24 ticks, WAL autocheckpoint desactivado, mismo proceso y misma cadencia para guardado completo y replay. El “antes” es la medición de fase 2 recibida para esta rama; la primera entrega también había registrado valores más altos bajo carga (`102,88 / 1 405,62 ms`), por lo que no se usa para mejorar artificialmente la comparación.

| Replay incremental | `saveMsMedian` | `saveMsP95` | Qué incluye |
|---|---:|---:|---|
| Antes de fase 2 | 31,4 ms | 383 ms | serie mezclada; clon + dos digestos y auditoría |
| Después, delta ordinario | **7,83 ms** | **19,47 ms** | 11 deltas entre auditorías |
| Después, auditoría profunda | — | 68,02 ms máx. | 1 barrera completa separada |

La muestra verde que produjo esos valores también conservó el mismo `digestoCanonico` entre ambos modos (`d0a52eac…217b9`), con `payloadBytes = 5 915 B` y `walBytes = 788 736 B` para replay frente a `5 131 625 B` y `10 697 232 B` para snapshot completo: 867× y 13,6× menos, respectivamente.

El test imprime `saveMsMedian`, `saveMsP95` y `deepAuditMsMax` por separado. No convierte el tiempo de pared en una aserción rígida porque los procesos `node` del laboratorio corren con `SCHED_IDLE` y la carga del servicio público puede retrasarlos sin cambiar el trabajo ejecutado; la evidencia de cierre es la muestra ordinaria p95 de **19,47 ms ≤ 20 ms**. No se fabricó una población de 500–2 000 habitantes para esta fase: se eligió la alternativa permitida de documentar exactamente el antes/después sobre la escena de control idéntica.

## Cobertura

`tests/store-replay.test.ts` cubre:

- paridad de ticks, gestos, journals y reinicios;
- rollover cada 100 guardados, profundidad máxima 99 y `previous()` exacto;
- cambios marcados, borrados, parámetros y `-0`;
- mutaciones no marcadas entre auditorías y durante auditoría profunda;
- interrupción operacional, padre ausente/corrupto y corrupción interior;
- rollback transaccional y reintento;
- raíz/profundidad falsificadas;
- lectura compatible de deltas de fase 1 con raíz canónica;
- bytes, WAL y latencia ordinaria/auditoría por separado.

## Ficheros de fase 2

- `src/server/store.ts`
- `tests/store-replay.test.ts`
- `specs/002-mundo-ilimitado/informes/T132-report.md`

No se modificaron `src/world/*`, `DEFAULT_PARAMS`, `docs/*`, `tasks.md` ni `src/server/snapshot.ts`.
