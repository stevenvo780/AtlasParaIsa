# T151 — Fracción serial y ocupación de workers

## Ficheros tocados

- `src/world/paralelo/piscina.ts` — instrumentación de `StaticWorkerPool` y helpers puros.
- `src/shared/types.ts` — nuevos campos opcionales de `RuntimeStats`.
- `src/server/app.ts` — publicación por paso y republicación de `aceleracionAmdahlTeorica`.
- `tests/fraccion-serial.test.ts` (nuevo) — pruebas de la tarea.
- `specs/002-mundo-ilimitado/informes/T151-report.md` (este informe).

Ningún otro fichero. Sin solape con otra tarea `[P]` de la misma oleada: se añaden campos
a `StaticWorkerDiagnostics` y a `RuntimeStats`, sin reescribir funciones ajenas.

## Qué cambió y por qué

### Piscina (`piscina.ts`)

Cada worker de cómputo mide, con `performance.now()` en su propio hilo, el tiempo activo
útil alrededor de cada invocación del handler (en `natural`, una por cola; en
`inverso`/`adversarial`, una por región, **excluyendo** las esperas `Atomics.wait` entre
regiones). Al terminar el despacho publica los microsegundos activos en un
`Int32Array` sobre `SharedArrayBuffer` propio (entero vía `Atomics`, nunca FP64 acumulado)
antes de marcar su estado `done`/`jobError`. El coordinador mide la pared del despacho y
deriva en `diagnostics()`:

- `ocupacionWorkers ∈ [0,1]` = Σ tiempo activo / (`workers × tiempoParaleloMs`).
- `tiempoActivoWorkersMs[]` por worker.
- `tiempoParaleloMs` = pared del despacho en el coordinador.
- `tiempoBarreraMs` = pared − worker más ocupado (espera de barrera y despacho).

Helpers puros y verificables: `aceleracionAmdahlTeorica(fraccionSerial, hilos)`
(`1 / (s + (1−s)/n)`, rechaza `s ∉ [0,1]` y `hilos < 1`),
`calcularOcupacionWorkers(tiempos, wallMs)` (acotada a `[0,1]`) y
`calcularFraccionSerialReal(serialMs, paraleloMs, hilos, gpu)` (1 si `hilos ≤ 1` y sin
GPU; si no, `serial / (serial + paralelo)`, y 1 mientras no haya tiempo paralelo medido).

### Tipos y servidor (`types.ts`, `app.ts`)

`RuntimeStats` gana cuatro campos **opcionales** (un servidor anterior puede omitirlos):
`fraccionSerialReal`, `ocupacionWorkers`, `tiempoBarreraMs` y `tiempoParaleloMs`.
`app.ts` encadena un `onBarrier` ecológico por paso (conservando el previo del contexto)
que solo acumula los ms de los diagnósticos del pool, y publica:

- Sin workers ni GPU (`motor.hilos === 1 && motor.gpu.length === 0`):
  `fraccionSerialReal = 1`, `ocupacionWorkers = 0`, `tiempoParaleloMs = tiempoBarreraMs = 0`.
- Con tramo paralelo: `fraccionSerialReal` es el tiempo fuera del tramo paralelo
  efectivo sobre el total de fases del paso; el trío ocupación/paralelo/barrera solo se
  actualiza con un despacho real (o con la pared GPU, sin diagnósticos de pool) y entre
  ticks ecológicos conserva el último despacho.

`fraccionSerial` **no cambia**: sigue siendo exactamente `fraccionSerial(runtime.fases)`
(la lectura por diseño de T107/FR-021), que es lo que exigen
`tests/perfil-fases.test.ts` y `tests/lab-hardware.test.ts`. La lectura real es un campo
nuevo, no una reinterpretación silenciosa de la anterior.

## Cómo se prueba

`tests/fraccion-serial.test.ts` (7 pruebas):

1. `aceleracionAmdahlTeorica`: valores exactos (`(1,28)=1`, `(0,28)=28`, `(0.05,28)≈11.92`),
   identidad entre el helper de la piscina y el republicado por `app.ts`, y rechazos.
2. Contrato puro de `calcularFraccionSerialReal`/`calcularOcupacionWorkers`.
3. Servidor con `motor.hilos=1` (5 pasos): `fraccionSerialReal === 1`,
   `ocupacionWorkers === 0` y `fraccionSerial === fraccionSerial(fases)` en cada paso.
4. `StaticWorkerPool` físico (handler que gira en CPU en proporción al tamaño de región):
   carga equilibrada frente a desbalanceada (ver cifras).
5. Amdahl: mismo trabajo con 1 y con 4 workers; la aceleración medida se compara con
   `aceleracionAmdahlTeorica` aplicada a la fracción serial reportada del despacho de 4.
6. Servidor con `motor.hilos=4` (12 pasos): publica ocupación en `[0,1]`,
   `tiempoParaleloMs > 0`, `0 ≤ tiempoBarreraMs ≤ tiempoParaleloMs` y la lectura T107 intacta.
7. Paridad: dos mundos `51926` avanzan 30 pasos con 1 y con 4 hilos (SoA con workers) y,
   normalizados los parámetros de ejecución, dan el mismo `digestoCanonico`.

## Cifras medidas (esta torre, 2026-11-19)

| Medida | Valor |
|---|---|
| Pool equilibrado (4 workers × 80 ms CPU) | ocupación **0,994**, pared 80,6 ms, barrera 0,5 ms |
| Pool desbalanceado (1 región de 320 ms + 3 de 2 ms) | ocupación **0,255** (≈ 1/4, proporcional), pared 320,4 ms |
| Amdahl: T(1 worker) / T(4 workers), 4 × 200 ms | medida **3,989×**; predicha **3,962×** (fracción reportada 0,0032); desviación **0,7 %** (≤ 20 %) |
| Servidor `hilos=4`, mundo pequeño `51926`, último despacho | ocupación 0,327, pared 3,68 ms, barrera 0,80 ms |
| Servidor `hilos=1` | `fraccionSerialReal = 1`, `ocupacionWorkers = 0` en los 5 pasos |

Lectura honesta de las dos últimas filas: el instrumento cumple su contrato (con carga
equilibrada y trabajo suficiente la ocupación es ≥ 0,70 y la fracción de barrera ≤ 5 %),
pero el paso completo del servidor **todavía no** tiene fracción serial real ≤ 5 %: en el
mundo pequeño el despacho ecológico dura ~3,7 ms frente a decenas de ms de fases hoy
seriales (personas, fauna, guardado), y su ocupación (0,33) refleja regiones diminutas
donde manda el coste de despacho. Ese es exactamente el número que T145/T153 deben mover;
T151 solo lo hace visible y verificable, sin maquillarlo.

Verificación ejecutada:

- `npm run typecheck` — verde.
- `npx tsx --test tests/fraccion-serial.test.ts tests/perfil-fases.test.ts tests/server.test.ts tests/gobernador.test.ts tests/paralelo-ecologia.test.ts`
  — **90 pasadas, 0 fallos, 1 omitida** (la medida de escala opt-in de `perfil-fases`, que
  exige `CARTA_TEST_ESCALA=1` ya en el árbol base).
- Extra: `tests/gobernador-senales.test.ts` + `tests/gobernador-view.test.ts` — 7/7 verdes.

## Determinismo

**El hardware solo puede cambiar la velocidad, nunca el resultado de este cambio.** La
instrumentación vive en buffers de tiempos que ningún cálculo del mundo lee (reglas 2 y
3): no hay `performance.now` alimentando una ley, ningún reparto entra en una fórmula y
ningún contador del mundo se toca desde un worker (regla 13). La prueba 7 lo demuestra
con `digestoCanonico` idéntico entre 1 y 4 hilos tras normalizar solo los parámetros de
ejecución.
