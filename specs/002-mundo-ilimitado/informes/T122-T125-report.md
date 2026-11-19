# T122 + T125 — Puente GPU persistente residente y backends GPU en determinismo

Rama: `sprint/t122-gpu-puente-20261119` · Máquina: torre con RTX 5070 Ti (GPU 0, 16 GiB) y RTX 2060 (GPU 1, 6 GiB), NVRTC en `/opt/cuda/lib64/libnvrtc.so`.

**Frase de determinismo: el hardware solo cambia la velocidad, nunca el resultado.** Con GPU `[0]`, `[1]` y `[0,1]`, el `digestoCanonico` normalizado (sin selectores de motor) tras 600 pasos es bit a bit el de CPU 1 hilo (`0cf48dd6511bed788c5feaf6c31008df737412c717d34b7b0a7ec92c935eda26` en la escena medida); cualquier divergencia de un bit es un error del port, no una tolerancia.

## Salida elegida para la bajada (FR-025)

Opción **(a)**: `TileStore` SoA como autoridad residente + VRAM residente. Los consumidores de CPU siguen leyendo los `Tile` enlazados por accesores a los buffers SoA por páginas de 256 celdas; la GPU trabaja sobre ese mismo layout por páginas y descarga a los buffers `*Back`, de modo que `store.commitParallel()` publica el resultado exactamente igual que con los workers de CPU. La bajada es densa por páginas asignadas (todos los campos que escribe cada pasada) y se mide por separado de la subida; no se declara un presupuesto de bajada de ≤ 1 MB (sería falso: a 2 048 teselas ya son ≈ 161 KB/pasada).

## Ficheros tocados

| Fichero | Cambio |
|---|---|
| `scripts/compute-ecology-resident.cu` (nuevo) | Kernels `ecology_pass1`, `ecology_pass2` (y auxiliar retirado del camino caliente) sobre el layout por páginas de `TileStore`; FP64, `enCuenca`/`basinNoise` con hash `imul` de 32 bits, `floor` con negativos y polinomio `fade` en el orden de JS |
| `scripts/compute-ecology-gpu-resident.py` (nuevo) | Subproceso Python persistente: compila con NVRTC una sola vez (`--fmad=false`, `--std=c++11`), buffers residentes en VRAM por dispositivo, sincronización de topología, subida dispersa por páginas sucias, halo, ejecución y bajada por páginas; `MAX_CELLS = 33_554_432`, sin topes de 1 M celdas ni 120 MB |
| `src/world/gpu/puente.ts` (nuevo) | `ResidentGpuBridge`: worker JS persistente que posee el subproceso Python; el hilo principal espera con `Atomics.wait` (patrón de `StaticWorkerPool`); reparto `[0,1]` 79 %/21 % redondeado a páginas completas; estadísticas `uploadedBytes`/`downloadedBytes` por pasada |
| `src/world/ecosystem-kernel.ts` | `gpu?: readonly number[]` en `EcosystemOptions`; despacho GPU en `stepEcology` y `step` sobre `TileStore` (`prepareParallel`/`beginParallel`/`commitParallel`, `abortParallel` ante fallo); `gpu`/`gpuStats` en la barrera; puentes cerrados en `closeParallelPool()`/`closeGpuBridges()` |
| `src/world/ecosystem.ts` | Reexporta `closeGpuBridges`, `ecosystemGpuDiagnostics`, `killGpuSubprocessForTest` |
| `src/world/index.ts` | Pasa `gpu: params.motor.gpu` en `stepLocalEcology`/`stepEcosystem`; camino paralelo/GPU cuando `motor.hilos > 1 \|\| motor.gpu.length > 0` (incluye ownership residente en `createWorld`/`cloneWorld` y la barrera serial sintética) |
| `tests/gpu-puente.test.ts` (nuevo) | Paridad de digesto 600 pasos × 3 backends GPU, subida dispersa ≤ 1 MB, aborto al matar el subproceso |
| `tests/hardware/matriz.ts` | `compareGpuCandidate` (T125): misma referencia CPU 1 hilo, comparación por barrera `ecologia`/`kernel`/`fin-paso`, hitos con digesto canónico |
| `tests/hardware/contrato.ts` | `gpu`/`gpuStats` en `HardwareBarrier` |
| `tests/determinismo-hardware.test.ts` | Tests `T117 CUDA … gpu=[…]` activados cuando `COMPUTE_NVRTC` está definido; `skip` con motivo explícito solo cuando no lo está; caché de referencias por semilla/escena |

No se modificó `scripts/compute-ecology-gpu.py` ni `scripts/compute-ecology.cu`: el prototipo de banco y `tests/compute-ecology.test.ts` quedan intactos.

## Cómo funciona

1. **Arranque**: el worker JS lanza `python3 scripts/compute-ecology-gpu-resident.py --devices … --nvrtc …`. Python crea un contexto por GPU y compila los dos kernels con NVRTC una sola vez (`compileMs` por dispositivo en el mensaje `ready`).
2. **Sincronización**: si cambian `terrain.version`, `pageSetVersion`, capacidad, número de slots, total de celdas o geometría, se suben topología (`cells`, `stamps`, `around`, `pageX`, `pageY`) y los 13 campos front a VRAM y se (re)asignan los buffers residentes.
3. **Subida dispersa**: en la misma versión de topología, antes de cada pasada se suben únicamente las páginas con `dirty[slot] === 1` (escrituras de actores entre ticks vía accesores residentes), todos sus campos front. Tras cada pasada el puente limpia `dirty`; los actores vuelven a marcar solo lo que tocan.
4. **Halo multi-GPU**: cada dispositivo guarda una réplica VRAM, pero su frente solo es autoritativo en sus páginas asignadas. La única lectura entre celdas es `terrain` (pasada 1) y `life` (pasada 2) de las 8/4 vecinas, así que antes de cada pasada se refresca en cada dispositivo solo ese campo de las páginas vecinas no asignadas (vía `around`). Sin este refresco, el vecino de otra GPU se leía con el valor de dos pasadas antes y la tesela (38,15) divergía en el tick 100 (detectado y corregido; una primera versión con copia completa frente→fondo tenía el mismo defecto disfrazado).
5. **Ejecución**: reparto del rango de celdas por dispositivo (79/21 con `[0,1]`, redondeado a páginas completas para que ninguna página se descargue dos veces), kernels FP64 sin FMA, y bajada de las páginas asignadas a los buffers `*Back` de `TileStore`. Para la pasada 2, el worker JS construye la cola `woodAddedQueue` en orden de slot ascendente (protocolo 1 de `commitParallel`).
6. **Publicación/aborto**: `EcosystemKernel` hace `beginParallel` → `bridge.run` → `commitParallel`. Si el subproceso muere o el IPC falla, `bridge.run` lanza antes del swap, el kernel llama a `abortParallel()` y descarta el puente; el frente no cambia y el mundo no queda a medias (probado matando el subproceso con SIGKILL). Tras un aborto, el siguiente paso crea un puente nuevo.
7. **Paridad de doble buffer**: Python intercambia sus punteros front/back tras cada pasada, en el mismo orden que el `commitParallel` de CPU intercambia la paridad.

## Pruebas ejecutadas

- `npm run typecheck` — 0 errores.
- `COMPUTE_NVRTC=/opt/cuda/lib64/libnvrtc.so npx tsx --test tests/gpu-puente.test.ts tests/compute-ecology.test.ts` — **25/25 ok, 0 omitidos** (incluye los 3 casos CUDA del banco antiguo, que siguen verdes, y los 5 tests nuevos de T122).
- `COMPUTE_NVRTC=/opt/cuda/lib64/libnvrtc.so npx tsx --test --test-name-pattern="T117 CUDA seed=7 scene=compacta geometry=256 gpu=" tests/determinismo-hardware.test.ts` — **3/3 ok** (`[0]`, `[1]`, `[0,1]`), con 60 despachos de cada pasada y comparación por barrera completa. La matriz GPU completa (4 semillas × 7 escenas × 2 geometrías × 3 backends) queda activa pero no se corrió entera en este sprint: cada candidato de 600 pasos con el rastreador de barreras tarda ~40 s en esta máquina, así que la matriz GPU completa son horas; no se ejecutó `npm test` completo (prohibido en este worktree).

## Cifras medidas

Mundo real `createWorld(51926)`, `stepWorld` completo, 600 pasos, 2 048 teselas, 19 personas al final. Mismo digesto en los cinco backends.

| Backend | ms totales | ms/paso | Notas |
|---|---:|---:|---|
| CPU 1 hilo | 441 | 0,74 | referencia |
| CPU 8 workers | 1 180 | 1,97 | el pool no compensa a 2 048 teselas |
| GPU [0] RTX 5070 Ti | 1 265 | 2,11 | kernel acumulado 4,25 ms en 120 pasadas |
| GPU [1] RTX 2060 | 1 362 | 2,28 | kernel acumulado 4,54 ms en 120 pasadas |
| GPU [0,1] | 1 478–3 117 | 2,46–5,20 | dos ejecuciones; la segunda quedó penalizada por contención de la máquina |

Transporte GPU (mismo mundo, sumado en las barreras):

| Backend | Subida total | Bajada total | Subida/pasada | Bajada/pasada |
|---|---:|---:|---:|---:|
| GPU [0] | 9 529 680 B | 19 293 892 B | 79 414 B | 160 782 B |
| GPU [1] | 9 681 632 B | 19 293 904 B | 80 680 B | 160 783 B |
| GPU [0,1] | 20 095 936 B | 19 294 624 B | 167 466 B | 160 789 B |

La subida por pasada está muy por debajo de 1 MB incluso con los actores tocando páginas entre ticks; en la prueba aislada de una sola tesela tocada, la pasada 1 sube ~23 KB. La bajada es densa por construcción (opción (a)): ≈ 79 B/tesela/pasada a este tamaño. El kernel en sí tarda ~0,03 ms por pasada a 2 048 teselas: a esta escala mandan el IPC y la bajada, no la GPU, y por eso la GPU no gana ni a CPU 1 hilo ni el punto de cruce del selector está a este tamaño.

## Lo que no cierra este sprint

- Los cierres de escala de T122 (tick ecológico íntegro a 18,4 M ≤ 20 ms y 32 M ≤ 25 ms) **no se midieron**: generar y sincronizar mundos de ese tamaño excede este sprint, y con la bajada densa actual el transporte dominaría de todos modos. T122 queda implementado y probado en paridad, aborto y presupuestos de transporte, pero su criterio de escala no debe darse por demostrado.
- La matriz T117 completa con GPU (168 candidatos) queda activada y verificada en un caso por backend; su corrida completa queda para el gate C.
- T122/T125 no se marcan `[x]` en `tasks.md`: sus criterios de cierre de etapa (escala y gate) siguen abiertos, aunque el código pedido está integrado y verde en lo ejecutado.
