# T136: `perMessageDeflate` — medido, y se deja en `false`

Base: `694f6b6` (rama `sprint/noche-t136-20260922`). Worktree:
`/datos/workspaces/personal/AtlasParaIsa-n-T136`. Ejecutado directamente (un intento previo
delegado a MiniMax agotó el tiempo sin producir nada usable; dejó un `tests/t136-compression.test.ts`
que medía sobre la línea fija de `app.ts` — sin la opción pedida por la tarea, requería editar el
fichero entre corridas — y se descartó).

## Qué se tocó

- `src/server/app.ts`: nueva opción `AppOptions.perMessageDeflate?: boolean`, usada en la única
  línea que construye el `WebSocketServer` (`perMessageDeflate: options.perMessageDeflate ?? false`
  — el default sigue siendo `false`, igual que hoy). Comentario junto a esa línea con la cifra medida.
  Ningún otro cambio en el fichero.
- `scripts/benchmark-ws-deflate.ts` (nuevo): banco reproducible. Arranca `createApp` en modo
  manual con un `Store` temporal, contraseña sintética y login (mismo patrón que `tests/server.test.ts`),
  abre 12 clientes WebSocket autenticados (mismo cookie de sesión, que el servidor permite —
  `clients.size >= 12` es el límite real de conexiones concurrentes por servidor), fija el viewport
  medio (40×28, el mismo que usan `research.md` y `tests/world-view-size.test.ts`) y corre 1000 pasos
  manuales (`app.stepOnce()`, que dispara `broadcast()` cada 5 ticks, igual que producción) dos veces
  seguidas — una vez con `perMessageDeflate: false`, otra con `true` — contra dos instancias de
  `createApp`, sin editar `app.ts` entre corridas.
- No se tocó `tests/server.test.ts`: la tarea solo pide un test ahí **si** el número justifica
  activar la compresión por defecto; no es el caso (ver decisión). Los 33 tests existentes de
  `tests/server.test.ts` siguen en verde (no se cambió ningún comportamiento por defecto).

## Cómo se mide

- **Bytes en el cable**: `_socket.bytesRead` de cada cliente `ws` (la `net.Socket` subyacente),
  acumulado entre el primer `state` medido y el último — framing WebSocket incluido; bajo
  compresión el payload viaja deflatado.
- **CPU**: delta de `process.cpuUsage()` del proceso del servidor durante la ventana medida.
  `getrusage(RUSAGE_SELF)` agrega todos los hilos del proceso en Linux, así que la compresión
  asíncrona de zlib (corre en el threadpool de libuv que usa `ws`, no bloquea el hilo principal)
  sí queda contabilizada aquí.
- **Latencia p95**: duración de cada `app.stepOnce()` medida desde fuera con `performance.now()`,
  separada en dos grupos — pasos que difunden (`tick % 5 === 0`, incluyen `broadcast()`) y pasos
  llanos (clon + simulación + persistencia condicional, sin red). Esta separación importa porque
  `runtime.p95StepMs` — la métrica que de verdad usa el gobernador (ruling R17) para pausar la
  reproducción — se congela **antes** de que `stepOnce()` llame a `broadcast()`
  (`runtime.stepMs = monotonicNow() - stepStarted` ocurre antes del `broadcast()` de fin de paso).
  El coste de la compresión es, por construcción, invisible para el gobernador; solo aparece en
  el p95 medido aquí desde fuera.
- **Entrega real, no un artefacto del banco**: la primera corrida (descartada, ver «Primer intento
  descartado» abajo) mostró solo 195/2400 y 24/2400 mensajes entregados porque el bucle de 1000
  pasos es 100 % síncrono y nunca cede el hilo — el proceso jamás vuelve al event loop entre pasos,
  así que el servidor no llega a vaciar el socket ni el cliente a leerlo, y `send()` descarta el
  `state` en cuanto `bufferedAmount > 256 KiB` (protección real de `app.ts`, no un bug del banco).
  En producción median 500 ms reales entre broadcasts (`tickMs=100`, difunde cada 5). El banco
  corregido espera, tras cada tick que difunde, la confirmación real de entrega en los 12 clientes
  (con techo de 500 ms) antes de seguir — así el `bufferedAmount` se vacía como en producción y
  solo se cuenta como «descartado» un mensaje que de verdad no llegó.

## Cifras (esta torre, 2026-09-22; 12 clientes, viewport 40×28, 1000 pasos = 200 difusiones)

| Métrica | `perMessageDeflate: false` (hoy) | `perMessageDeflate: true` | Diferencia |
|---|---:|---:|---:|
| Mensajes entregados / esperados | 2400 / 2400 (0 descartados) | 2400 / 2400 (0 descartados) | — |
| Bytes totales (12 clientes, 200 difusiones) | 650 950 712 B (620,8 MiB) | 73 328 541 B (69,9 MiB) | **−88,7 %** |
| Bytes/mensaje (promedio) | 271 229 B (264,9 KiB) | 30 554 B (29,8 KiB) | −88,7 % |
| CPU proceso (user+sys) en 1000 pasos | 69 591,6 ms | 84 917,8 ms | **+15 326,2 ms** (+22,0 %) |
| CPU extra por difusión (12 clientes) | — | — | ≈ +76,6 ms/difusión ⇒ ≈ +6,4 ms/cliente |
| p95 paso que difunde (incl. `broadcast()`) | 165,98 ms | 224,78 ms | **+58,80 ms** |
| p50 paso que difunde | 131,35 ms | 152,91 ms | +21,56 ms |
| p95 paso llano (sin red) | 46,38 ms | 64,91 ms | +18,53 ms |
| RSS delta durante la corrida | +233,8 MiB | +48,6 MiB | −185,2 MiB (buffers de socket más chicos) |

Presupuesto del gobernador (`gobernador.presupuestoMs`, default en `params.ts`): **50 ms**.

Datos completos (JSON) de la corrida: `/tmp/claude-1000/-datos-workspaces-personal-AtlasParaIsa/71b6da8a-24fe-445a-abe9-a2469c7538ac/scratchpad/t136-bench2.log`
(reproducible con `npx tsx scripts/benchmark-ws-deflate.ts` desde este worktree).

## Decisión: se deja en `false`

El número no justifica activarla por defecto:

1. **El coste de comprimir, por sí solo, ya excede el presupuesto de 50 ms del gobernador**: +58,80 ms
   de p95 *únicamente* por la diferencia entre difundir con y sin compresión (sin contar los ~166 ms
   base que ya cuesta el paso completo — clon + simulación + persistencia — que hoy tampoco entra
   en ese presupuesto porque incluye red; el punto es que la compresión sola es más cara que todo
   el presupuesto).
2. **Ese coste es invisible para el gobernador de ruling R17**: `runtime.p95StepMs` se mide antes de
   `broadcast()`, así que activar la compresión no dispararía la histéresis que apaga la
   reproducción — el sistema absorbería el costo extra de CPU/latencia sin ningún mecanismo que
   lo compense, al contrario que el resto del paso.
3. **+22 % de CPU de proceso** en esta corrida (15,3 s extra sobre 69,6 s en 1000 pasos) es un coste
   real y medible, no ruido: se repitió con el mismo patrón (CPU y p95 de `broadcast` y de los pasos
   llanos vecinos, todos consistentemente más altos con la compresión encendida).
4. El ahorro de bytes (88,7 %) es grande en términos relativos, pero la causa raíz del problema de
   tamaño de `state` (FR-026/SC-005) es que `tiles` es ≈82 % del payload sin filtrar por cámara
   (`research.md`) — eso es exactamente lo que T134 (filtrar `people`/`communities`/`blueprints`) y
   T135 (delta de teselas por campo) atacan en la fuente, sin gastar CPU. Comprimir un payload que
   de todos modos se va a reducir en un orden de magnitud por delta/filtrado es pagar CPU por un
   problema que la propia hoja de ruta de la feature ya resuelve de otra forma; y una vez que
   T134/T135 bajen el `state` medio a menos de 120 KiB, la ganancia relativa de comprimir un payload
   ya pequeño (y con menos proporción de `tiles` repetitivo) previsiblemente sea menor que la medida aquí.

**Conclusión**: `perMessageDeflate` se deja en `false` (sin cambio de comportamiento respecto a hoy).
Queda la opción `AppOptions.perMessageDeflate` para poder reevaluar con un número, sin editar el
fichero, si el contexto cambia (por ejemplo, tras T134/T135, o en una red real con clientes lentos
donde el ahorro de bytes pese más que aquí).

## El hardware no cambia el resultado de este cambio

Este parche no toca ninguna fórmula del mundo, reparto ni ruta que dependa de `os.cpus()`,
`availableParallelism()` ni de la capacidad medida del hardware — es una opción de configuración
del `WebSocketServer` con un default fijo (`false`) y un banco de medición externo al motor. La
**decisión** de dejarlo en `false`, en cambio, sí está atada a las cifras de CPU de *esta* torre
(32 hilos, 125 GiB): en una máquina sustancialmente más lenta la compresión podría paradójicamente
salir más barata en proporción (si la red fuera el cuello real y no la CPU), y en una más rápida el
coste de CPU importaría menos en términos relativos; si se reevalúa en otra máquina, hay que volver
a correr `scripts/benchmark-ws-deflate.ts` ahí, no asumir esta cifra.

## Reproducir

```bash
cd /datos/workspaces/personal/AtlasParaIsa-n-T136
npm run typecheck
npx tsx scripts/benchmark-ws-deflate.ts
npx tsx --test --test-timeout=600000 tests/server.test.ts   # 33/33, sin cambios de comportamiento
```
