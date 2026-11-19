# T166 — SC-013: prueba literal de «el límite lo pone el hardware»

**Rama**: `sprint/t166-sc013-20261119` · **Alcance (aislamiento estricto)**: solo
`tests/sc013-limite-hardware.test.ts` (nuevo) y este informe. Sin tocar `src/` ni
`docs/EVIDENCIA.md`: la fila de evidencia consolidada la escribe el Gate F (T167) al integrar.

## Qué se hizo y por qué

La redacción original de T166 pide tres corridas de laboratorio de 100 días y la fila en
`docs/EVIDENCIA.md`. En esta rama eso se sustituye por una prueba ejecutable, rápida y literal
del mismo mecanismo, porque el aislamiento de ficheros prohíbe `docs/EVIDENCIA.md` y porque una
campaña de 100 días mediría sobre todo el calendario de nacimientos, no el hardware (ver
«Cota del calendario» abajo). La prueba ataca la frase de SC-013 en sus tres únicos sitios
posibles — el gobernador que frena, el servidor que lo aplica y el pool que calcula el
terreno — con el coste por paso **inyectado** (reloj `monotonicNow` / coste sintético lineal)
sobre la misma semilla y las mismas leyes. Si el techo se mueve, solo pudo moverlo el hardware
simulado: ningún parámetro de tope poblacional cambia entre máquinas.

Qué demuestra cada test de `tests/sc013-limite-hardware.test.ts`:

1. **Sin topes fijos de población** — trayectoria de población creciente ante
   `Gobernador` + política `techo`: el techo observado depende exclusivamente de
   `gobernador.presupuestoMs` y del coste medido por paso. Las leyes parseadas de las tres
   máquinas son idénticas salvo el presupuesto (`poblacion` y `social` comparados con
   `deepEqual`), `RULES_VERSION = 11` y el único tope restante es el anticorrupción
   `POPULATION_HARD_LIMIT = 1_000_000`, que ningún techo medido alcanza.
2. **No-regresión de hardware (monotonía)** — la misma trayectoria con la función pura
   `gobernar()` (T162): máquinas 1× / 2× / 4× dan techos no decrecientes, y la clase
   `Gobernador` coincide con la función pura en el mismo punto.
3. **Anti-extinción bajo carga extrema sostenida** — 60 ventanas a 10× el presupuesto
   (500 ms contra 50 ms) con una muerte cada 3 ventanas: el techo jamás baja, toda muerte
   bajo el techo se repone, y la población nunca baja de 29. Contraste con la política
   histórica `apagar`, que con la misma carga y una muerte no repone (la extinción V7).
   Al retirarse la carga, exactamente `VENTANAS_VERDES_PARA_SALIR = 3` ventanas verdes
   consecutivas (T162) retiran el techo; una ventana amarilla intermedia reinicia la cuenta.
4. **Servidor real con reloj inyectado** — tres `createApp` con la misma semilla (42) y las
   mismas leyes, cuyo único «hardware» es cuánto suma el guardado al reloj monotónico:
   máquina lenta (frena), máquina con la mitad de coste (no frena) y máquina lenta con el
   doble de presupuesto (no frena). Las tres terminan con la misma población: solo frenó
   el coste medido.
5. **Eje de teselas** — paridad `Object.is` campo a campo del tick ecológico entre 1 hilo y
   4 workers (`EcosystemKernel`, SoA, 4 096 teselas en 4 regiones), y `stepMs` real del
   despacho `StaticWorkerPool.run` sobre el terreno SoA residente (768×768 = 589 824
   teselas, 9 regiones): la mediana de 5 despachos tras calentamiento, con 1 y con 4 workers
   físicos (hilos distintos verificados por `diagnostics()`).

## Cifras medidas (esta torre, 2026-11-19)

### Techo de población según el hardware (coste sintético 1 ms/habitante, presupuesto base 50 ms)

| Máquina simulada | Cómo se simula | `techoObservado` |
|---|---|---|
| 1× (control) | presupuesto 50 ms, coste íntegro | **51 habitantes** (p95 = 51 ms) |
| 2× presupuesto | presupuesto 100 ms, coste íntegro | **101 habitantes** |
| 2× velocidad | presupuesto 50 ms, coste ÷ 2 | **101 habitantes** (p95 = 50,5 ms) |
| 4× velocidad | presupuesto 50 ms, coste ÷ 4 | **201 habitantes** |
| Presupuesto máximo del rango | presupuesto 5000 ms, coste íntegro | **5001 habitantes** |

Doble presupuesto ≡ doble velocidad, bit a bit en el techo (101 = 101), y cada duplicación
de hardware duplica el techo (51 → 101 → 201, cocientes 1,98 y 1,99): el techo es proporcional
al hardware y no hay constante de software entre el control y el anticorrupción de 10⁶.

### Servidor real, misma semilla (42), 6 pasos, `monotonicNow` inyectado

| Máquina | Presupuesto | Coste de guardado inyectado | p95 medido | Techo | `reproductionEnabled` |
|---|---|---|---|---|---|
| Lenta | 50 ms | 80 ms | **87 ms** | 17 (= población del frenazo) | `false` (frena) |
| 2× rápida | 50 ms | 40 ms | **47 ms** | — (sin freno) | `true` |
| Lenta, presupuesto 2× | 100 ms | 80 ms | **87 ms** | — (sin freno) | `true` |

Las tres máquinas terminan con 17 habitantes y 2 048 teselas activas: la lenta publica
«frenado por p95 = 87.0 ms > 50 ms con 17 habitantes y 2048 teselas activas (paso 1)» y
las otras dos crecen. Mitad de coste y doble presupuesto son intercambiables.

### Anti-extinción (gobernador puro, multiseñal T162)

- 60 ventanas a 500 ms (10×): techo constante en 30, población oscilando 29↔30 solo por
  muerte + reposición, nunca por debajo de 29. Con `apagar`, la misma ventana da
  `reproductionEnabled = false` con la población en 29.
- Salida de rojo: ventana verde (1) → sigue rojo; amarilla → cuenta a 0; verdes 1 y 2 →
  sigue rojo; tercera verde consecutiva → `verde`, techo retirado, reproducción reanudada.

### Teselas: más hardware, menos paso, mismo bit

- Paridad: 4 096 teselas × 12 campos del kernel, **0 diferencias** `Object.is` entre 1 hilo
  y 4 workers, con 4 hilos físicos distintos en `diagnostics()`.
- Corrida de verificación obligatoria: `stepMs(1 worker) = 23,93 ms`,
  `stepMs(4 workers) = 8,87 ms` (medianas de 5) sobre 589 824 teselas ⇒ aceleración
  **2,70×**; en un presupuesto fijo de 50 ms caben **1 232 150** teselas con 1 worker y
  **3 324 917** con 4 workers.
- Repetición de control (mismo fichero, segunda corrida): 22,61 ms vs 9,43 ms
  (aceleración 2,40×; 1 304 294 vs 3 127 600 teselas por presupuesto). La cifra varía con
  la carga de la torre; el signo y el orden de magnitud, no.

### Verificación

- `npm run typecheck`: verde.
- `npx tsx --test tests/sc013-limite-hardware.test.ts tests/gobernador.test.ts`:
  **27/27 verdes, 0 omitidos**, 3,82 s en total.
- Solo `tests/sc013-limite-hardware.test.ts`: **5/5 verdes en 3,56 s** (< 15 s exigidos),
  determinista en todo salvo las medianas de tiempo real del eje de teselas, que se
  corroboraron en dos corridas.

## Cota del calendario (declarada, como pide T166)

El techo medido aquí es el del **gobernador**: cuánta población admite el hardware antes del
freno. La población que un mundo real alcanza en 100 días tiene además la cota de software
del calendario de nacimientos (`intervaloComprobacionTicks = 120`,
`nacimientosPorComprobacion = 2`, 2 400 ticks/día ⇒ ≤ 4 000 nacimientos en 100 días), que
el gobernador solo puede apagar, nunca acelerar. Esta prueba no la toca ni la esconde: si una
corrida futura de 100 días con 28 hilos quedara pegada a 4 000 nacimientos, lo medido sería
el calendario y no el hardware, y la fila de evidencia del Gate F deberá decirlo. La campaña
biológica de 100 días (US1) sigue siendo trabajo del gate; lo que aquí queda cerrado es el
mecanismo literal de SC-013: freno, techo, reposición y escala por hardware.

## Determinismo

**El hardware puede cambiar el resultado de esta prueba solo en velocidad —cuánto tarda el
paso y, por tanto, dónde frena el gobernador—, nunca en qué mundo resulta: con la misma
semilla y las mismas leyes, 1 hilo y 4 workers producen tesela a tesela el mismo bit
(`Object.is`), y cambiar el presupuesto o el coste inyectado mueve el techo publicado, no
ninguna ley ni ningún digesto.** El único reloj que entra en las decisiones es el inyectado
(`monotonicNow`) o el coste sintético declarado; los tiempos reales solo se comparan como
medianas en el eje de teselas.
