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

## Optimización DMA/IPC y escala extrema (2026-11-19, continuación)

Tres cuellos eliminados en `scripts/compute-ecology-gpu-resident.py` y `src/world/gpu/puente.ts`, con paridad FP64 bit a bit intacta:

1. **Coalescencia en tramos contiguos**: cualquier lista ordenada de slots (`dirtySlots`, `haloSlots`, slots de bajada) se agrupa en `runs = [(start_slot, count)]` y se transfiere por campo y por tramo con una sola llamada `cuMemcpyDtoH_v2`/`cuMemcpyHtoD_v2` de `count * 256 * esz` bytes. A 4 M de celdas (15 625 páginas) la bajada pasa de 203 125 llamadas `ctypes` por pasada a 3–10 llamadas DMA. El layout del body de subida y del staging de bajada es ahora «por campo y por tramo» en ambos extremos (Python y worker JS). En multi-GPU, `d.step(...)` de cada dispositivo se lanza en paralelo con `ThreadPoolExecutor` (`ex.submit`), nunca en bucle secuencial. Extras de escala en el mismo pase: slots de bajada con `np.unique` en C (sin `tolist()` de millones de celdas) y marcas tipadas `Uint8Array` para el halo en `puente.ts` (sin `Set` por celda).
2. **Descarga selectiva por pasada**: `pass == 1` descarga solo `moisture`, `vegetation`, `food` (24 B/tesela frente a 75 B/tesela, −68 % de PCIe en esa pasada); `pass == 2` descarga los 10 campos que modifica (todos menos `food`, `terrain`, `biome`). Los campos no descargados los copia el worker JS `front -> back` en RAM local para los tramos tocados. En VRAM el kernel sigue escribiendo los 13 campos `F -> B` (ancho GDDR), pero por PCIe solo viaja lo modificado: bajada total por tick = 97 B/tesela + cola `woodAdded`.
3. **Payload por `/dev/shm` (`mmap`)**: el subproceso crea `/dev/shm/atlas-gpu-resident-<pid>.shm` (o `os.tmpdir()` si no existe `/dev/shm`), lo anuncia en el encabezado `ready` (`shmPath`) y stdin/stdout solo llevan encabezados JSON (< 4 KB) con `shmBytes`. La DMA de bajada escribe directa en el mmap compartido (cada GPU en su tramo) y el worker JS lee por segmentos (`fs.readSync` sobre un `Buffer` reutilizable) dispersando al `*Back` sin una pasada intermedia; al cerrar se hace `unlink` (también desde el worker JS si el subproceso muere con SIGKILL). Diagnóstico opcional de tiempos por pasada con `ATLAS_GPU_TIMING=<fichero>`.

### Banco de escala extrema (`scripts/banco-escala-extrema-gpu.mts`)

Terreno sintético válido fabricado directamente sobre los buffers SoA (sin millones de objetos `Tile`): `cells[i] = i`, páginas de 256 celdas en cuadrícula, `around`/`stamps`/`pageX`/`pageY` coherentes y los 13 campos con patrón determinista. Mide el tick íntegro (pasada 1 + pasada 2, con swap de paridad tras cada pasada) ya sincronizado, con 3 páginas sucias dispersas por tick (57 600 B de subida sucia ≤ 1 MB). Paridad `Object.is` sobre los 13 campos frente a CPU 1 hilo tras los ticks medidos. Corrida del 2026-11-19 con la torre bajo carga externa ajena (load ≈ 28 por un panel de réplicas en otro worktree): los tiempos absolutos están inflados y son ruidosos entre réplicas; las comparaciones de paridad y de bytes no dependen de la carga.

| Celdas | Backend | Mediana tick (ms) | Kernel GPU (ms) | Subida/tick (B) | Bajada/tick (B) | Diffs vs CPU 1 |
|---:|---|---:|---:|---:|---:|---:|
| 65 536 | CPU 1 hilo | 6,42 | — | 0 (SAB) | 0 (SAB) | — |
| 65 536 | CPU 8 workers | 7,80 | — | 0 | 0 | — |
| 65 536 | CPU 28 workers | 45,75 | — | 0 | 0 | — |
| 65 536 | GPU [0] RTX 5070 Ti | 4,06 | 0,07 | 64 000 | 6 357 248 | — |
| 65 536 | GPU [0,1] | 4,90 | 0,29 | 206 336 | 6 357 504 | — |
| 1 048 576 | CPU 1 hilo | 104,57 | — | 0 | 0 | — |
| 1 048 576 | CPU 8 workers | 39,35 | — | 0 | 0 | 0 |
| 1 048 576 | CPU 28 workers | 63,24 | — | 0 | 0 | 0 |
| 1 048 576 | GPU [0] RTX 5070 Ti | 64,88 | 0,58 | 67 840 | 101 715 968 | 0 |
| 1 048 576 | GPU [0,1] | 59,52 | 1,05 | 435 200 | 101 720 064 | 0 |
| 4 194 304 | CPU 1 hilo | 429,60 | — | 0 | 0 | — |
| 4 194 304 | CPU 8 workers | 145,97 | — | 0 | 0 | 0 |
| 4 194 304 | CPU 28 workers | 112,14 | — | 0 | 0 | 0 |
| 4 194 304 | GPU [0] RTX 5070 Ti | 594,02 | 2,16 | 80 128 | 406 863 872 | 0 |
| 4 194 304 | GPU [0,1] | 566,28 | 4,19 | 754 688 | 406 880 256 | 0 |
| 8 388 608 | CPU 1 hilo | 1 390,47 | — | 0 | 0 | — |
| 8 388 608 | CPU 8 workers | 489,23 | — | 0 | 0 | — |
| 8 388 608 | CPU 28 workers | 474,59 | — | 0 | 0 | — |
| 8 388 608 | GPU [0] RTX 5070 Ti | 1 054,22 | 4,42 | 96 512 | 813 727 744 | — |
| 8 388 608 | GPU [0,1] | 889,05 | 6,51 | 1 036 288 | 813 760 512 | — |
| 18 432 000 | CPU 1 hilo | 3 255,19 | — | 0 | 0 | — |
| 18 432 000 | CPU 8 workers | 940,58 | — | 0 | 0 | — |
| 18 432 000 | CPU 28 workers | 767,67 | — | 0 | 0 | — |
| 18 432 000 | GPU [0] RTX 5070 Ti | 2 149,05 | 18,39 | 135 744 | 1 787 976 000 | — |
| 18 432 000 | GPU [0,1] | 2 221,60 | 24,84 | 1 515 648 | 1 788 048 000 | — |

Lectura honesta de la tabla:

- **Paridad: 0 diferencias `Object.is`** entre CPU y GPU a 1 M y 4 M de celdas (los cinco backends comparados a 1 M/4 M difieren en 0 celdas × campo). El kernel GPU es despreciable (0,58 ms a 1 M; 18–25 ms a 18,4 M): manda el transporte denso de bajada (97 B/tesela × tick), no el cálculo.
- La GPU gana a CPU 1 hilo a 65k, 1 M, 8,4 M y 18,4 M en esta corrida, pero **pierde contra CPU 8/28 workers** (que comparten los SAB sin copiar) y a 4 M también contra CPU 1 hilo, con la máquina contendida. La subida `[0,1]` supera 1 MB a 8,4 M/18,4 M porque suma halo duplicado por dispositivo y la cola `woodAdded` de un byte por slot (72 000 B a 18,4 M); la parte sucia propiamente dicha son 57 600 B.
- 18 432 000 celdas caben y corren en ambas GPU: VRAM residente por dispositivo ≈ 2,76 GB (frente+fondo de los 13 campos) sobre 16 GiB (GPU 0) y 6 GiB (GPU 1). El criterio histórico de T122 «tick a 18,4 M ≤ 20 ms» **sigue sin cumplirse**: con bajada densa son 1,79 GB de PCIe por tick (≈ 2,1 s medidos); cumplirlo exigiría abandonar la bajada densa por páginas (opción (a) de FR-025), decisión de reglas que este sprint no toma.

## Lo que no cierra este sprint

- Los cierres de escala de T122 (tick ecológico íntegro a 18,4 M ≤ 20 ms y 32 M ≤ 25 ms) ya se midieron con `scripts/banco-escala-extrema-gpu.mts` (sección anterior): 18,4 M corre en ambas GPU pero el tick son ≈ 2,1 s por la bajada densa (1,79 GB/tick), así que el criterio de ≤ 20 ms **no se cumple** y no debe darse por demostrado; 32 M no se midió (la VRAM de la GPU 1, 6 GiB, no admite la réplica residente completa a ese tamaño). T122 queda implementado y probado en paridad, aborto y presupuestos de transporte.
- La matriz T117 completa con GPU (168 candidatos) queda activada y verificada en un caso por backend; su corrida completa queda para el gate C.
- T122/T125 no se marcan `[x]` en `tasks.md`: sus criterios de cierre de etapa (escala y gate) siguen abiertos, aunque el código pedido está integrado y verde en lo ejecutado.
