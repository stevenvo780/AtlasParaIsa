# T161 + T164: señales del gobernador, máximo por ventana y techo observado

Rama: `sprint/t161-t164-gobernador-20261119`. Alcance: el pedido exacto de esta
sesión (señales listadas en T161 y `techoObservado` de T164). Todo es
publicación: ningún fichero de `src/world` cambia y la dinámica del mundo es
bit a bit la misma (ver «Control»).

## Ficheros tocados

- `src/server/governor.ts`: `RollingStepPerformance` guarda muestras
  `{ms, fases}` de la ventana de 120 pasos y expone `p50Ms`, `p95Ms`, `p99Ms`,
  `maxMs`, `faseMax`, `fasesP95` y `senales()`; `Gobernador.registrar(ms, fases?)`
  acepta las fases del paso y delega esas señales; nuevo helper
  `teselasPorHabitante(teselas, poblacion)` (0 habitantes ⇒ 0, sin lanzar);
  `TechoObservado` gana `maxMs` (tipo completo:
  `{p95, maxMs, poblacion, teselasActivas, teselasPorHabitante, senal, tick, motivo}`)
  y `describirFrenazo` lo rellena con el máximo de la ventana en el frenazo.
- `src/shared/types.ts`: `RuntimeStats.gobernador` publica además `p50Ms`,
  `p95Ms`, `p99Ms`, `maxMs`, `faseMax`, `fasesP95`, `tickHz`, `rssBytes`,
  `saveMs`, `regionesActivas`, `teselasActivas`, `teselasPorHabitante`,
  `poblacion`, `nacimientos`, `muertes`, `colaRed` (+ alias
  `maxBufferedAmount`), `reproductionEnabled` y `techoPoblacion`;
  `techoObservado` incluye `maxMs` y `senal: string`.
- `src/server/app.ts`: `publicarSenalesGobernador(mundo)` rellena esas señales
  desde la ventana, el mundo servido (`chunks`, `tiles`, `people`,
  `totals.births`, suma de `demographyDynamics.causes`), `runtime`
  (`tickHz`, `saveMs`, RSS) y el máximo `socket.bufferedAmount` entre clientes
  WS; el paso registra sus fases (`{...medicion.fases, save}` y `broadcast`
  anotado al cerrar el paso). Se invoca tras decidir y al final del paso.
- `tests/gobernador-senales.test.ts` (nuevo) y `tests/techo-observado.test.ts`
  (nuevo): ver «Cómo se prueba».
- `tests/render-hud-movil.test.ts`: su fixture de `techoObservado` gana
  `maxMs`, para seguir el nuevo contrato del cable; sin cambio de conducta.

## Qué cambió y por qué

- **T161**: el p95 de 120 muestras es ciego a los picos de cadencia larga
  (comunidades cada 120 ticks, estadísticas cada 200, guardado cada 20): un
  pico de 1 s cada 120 pasos es el 0,83 % de la ventana. `maxMs` y `faseMax`
  (fase de mayor tiempo dentro del paso con `maxMs`; si ese paso no midió
  fases, la de mayor pico en la ventana) lo delatan, y `fasesP95` da el p95
  por fase sobre la misma ventana. Todas las señales viajan en
  `performance.gobernador`, que es donde el cliente ya lee el gobernador.
- **T164**: el frenazo ya se registraba en la transición a rojo; ahora el
  registro incluye `maxMs` y sigue sin borrarse al volver a verde (el techo
  se retira, el registro queda hasta el próximo frenazo). El motivo conserva
  el formato vigente: «frenado por p95 = 80.0 ms > 50 ms con 22 habitantes y
  1120 teselas activas (paso 8)», que es el que prueban los tests existentes.

## Cómo se prueba

- `tests/gobernador-senales.test.ts`: (1) todas las señales de
  `performance.gobernador` se publican con rangos válidos y coinciden con el
  mundo servido campo a campo; (2) `teselasPorHabitante` con 0 habitantes
  devuelve 0 y un frenazo con 0 habitantes no lanza; (3) pico sintético de
  1000 ms una vez cada 120 pasos (119 a 5 ms): `p95Ms < 50` pero
  `maxMs >= 1000` y `faseMax = 'comunidades'`; (4) `digestoCanonico` idéntico
  con y sin medir señales.
- `tests/techo-observado.test.ts`: tras un frenazo sintético (unidad y
  servidor real con guardado lento), `techoObservado` se puebla completo y
  no se borra al volver el p95 a verde.
- Regresión: `tests/gobernador.test.ts` y `tests/perfil-fases.test.ts` sin
  tocar, verdes; vecinos `tests/gobernador-view.test.ts` y
  `tests/curva-techo.test.ts` verdes.

## Cifras y control

- Ventana sintética del pico: p50 = p95 = p99 por fase de `comunidades`
  quedan en 5 ms (verde) mientras `maxMs = 1000` y `faseMax = 'comunidades'`.
- Servidor real (sonda, semilla 42, 40 pasos): `p50Ms ≈ 6,0`,
  `p95Ms ≈ 18,1`, `maxMs ≈ 44,0`, `faseMax = 'personas'`,
  `teselasPorHabitante ≈ 120,5` (2048 teselas / 17 habitantes).
- **Control de dinámica**: sonda de servidor real (semilla 42, 40 pasos) con
  el mismo `Store` temporal: `digestoCanonico` del mundo servido
  `a5a39e8b…` antes (base, vía `git stash`) y después del cambio — idéntico.
  La diferencia frente a un `stepWorld` directo es preexistente
  (`chronicleJournal.committedDigest`, que el guardado del servidor confirma)
  y no la introduce este cambio.
- Verificación: `npm run typecheck` en 0 errores;
  `npx tsx --test tests/gobernador.test.ts tests/perfil-fases.test.ts tests/gobernador-senales.test.ts tests/techo-observado.test.ts`
  = 26 pasadas, 0 fallos, 1 omitida (la de escala de `perfil-fases`, opt-in
  con `CARTA_TEST_ESCALA=1`, como en la base). No se ejecutó `npm test`
  completo (prohibido en esta sesión).

## Hardware y resultado

El hardware no puede cambiar el resultado de este cambio: no hay ninguna
fórmula del mundo nueva; las señales solo leen la ventana de pasos, el mundo
ya servido y los sockets conectados, y el digesto medido es idéntico.

## Alcance frente al texto original de tasks.md

Las casillas T161/T164 de `tasks.md` quedan sin marcar a propósito: su texto
original pide además señales fuera del alcance exacto de esta sesión (p95
ecológico CPU/GPU, VRAM libre, `state` descartados, resyncs, cola durable).
Lo implementado cubre íntegro el alcance pedido aquí; esas señales quedan
como trabajo restante de la Etapa F, no como cierre de la tarea entera.
