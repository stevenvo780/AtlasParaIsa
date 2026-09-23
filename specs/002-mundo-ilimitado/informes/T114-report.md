# T114: port del kernel ecológico al SoA con paridad contra el tick vivo

Base `200d284`, worktree `/datos/workspaces/personal/AtlasParaIsa-n-B-t114`, rama
`sprint/002-b-t114`. Commits `ffa75b3` (arnés del tick íntegro) y `0da419a` (control contra
el port congelado).

## Qué ya estaba hecho (regla 11)

El primer párrafo de T114 ya estaba en el árbol desde `bf23e04` (2026-09-22, «fix(compute):
compare CPU and both GPUs against the live ecology laws»):

- `stepArrays` (hoy en `scripts/compute-ecology-core.mjs:349`, no en `:56`; `4f47435` le
  antepuso la especificación versionada de T108) ya acepta
  `options = { decaimientoFertilidad, seed, cuencas }`.
- Los campos 15 y 16 empaquetan `x`/`y`, con `FIELDS = 17` y contrato v3.
- `basinUnit`/`basinNoise` (`:335-347`) reproducen `hash` → `unit` → `ruidoCuenca` de
  `src/world/agua.ts:22-51`: `Math.imul`, `>>>` lógicos, división por 2³², `Math.floor` con
  negativos, y `fade` y `lerp` en el mismo orden.
- `scripts/compute-ecology-worker.mjs` ya reenvía `request.options` y no necesita cambios.
- `tests/compute-ecology.test.ts` ya comparaba contra `EcosystemKernel` vivo en los cuatro
  cuadrantes, y `validateLiveKernel` valida 192 casos.

Revisé de nuevo la paridad `stepArrays` ↔ `EcosystemKernel.step` (`ecosystem-kernel.ts:95-150`)
y no encontré ninguna discrepancia. Revisé:

- los `?? 0` y el `growth ?? vegetation`;
- la vida vecina leída de la foto previa;
- la clave `wood` ausente frente a `woodPresent`, y `feature` indefinida;
- el goteo del manantial condicionado por la cuenca;
- el orden de las operaciones de coma flotante;
- la transición de tocón a árbol o pino.

**Lo que faltaba** era la parte añadida por la refutación G4 (comparar el tick ecológico
**íntegro**) y el control contra el port congelado. Eso es lo que entrega esta tarea.

**Solapamiento (regla 12):** no hay ninguno con las demás tareas `[P]` de la Etapa B:

- T111 toca `halo.ts`.
- T112 toca la topología de `ecosystem-kernel.ts`.
- T113 toca `spatial.ts` y `animals.ts`.
- T116 toca `animals.ts`.
- E.0 y PERF3 tocan otros ficheros.

T114 solo **importa** `ecology`, `stepEcosystem`, `cloneWorld` y `paramsOf`; no edita nada de
`src/`. T121 (Etapa C, otra oleada) añadirá variantes de GPU a este mismo fichero de tests.

## Ficheros tocados

- `tests/compute-ecology.test.ts`:
  - **Arnés del tick íntegro.**
    - El oráculo es la composición viva de `advanceTick`: `ecology(world)` y luego
      `stepEcosystem(..., false, {decaimientoFertilidad, seed, cuencas})`, con las opciones
      tomadas de `paramsOf(world)`.
    - El candidato es la misma `ecology()` sobre objetos (su port corresponde a T120) seguida
      de `pack` → `stepArrays` → `unpack`, o bien del paso por `CPUWorkers`.
    - Cada tick ecológico se compara con `Object.is` en todos los puntos siguientes:
      - `compare()` de los 17 campos empaquetados;
      - `food`, `moisture` y `vegetation`, tesela a tesela;
      - `deepStrictEqual` de las teselas completas cada 40 ticks y al final;
      - `weather`, `rng` y el número de eventos.
    - Se prueba en los cuatro cuadrantes `cuencas ∈ {1, 0.4}` × `decaimientoFertilidad ∈ {0,
      0.001}`. Los mundos se crean con `parseParams(..., HISTORICAL_PARAMS)`, sobre dos escenas:
      - (a) Mundo real `51926` envejecido 600 pasos: 2 048 teselas activas, 149 con tráfico.
        Recorre 240 ticks ecológicos (ticks 610–3000), que cubren amanecer, día, atardecer,
        noche, los múltiplos de 100 (madera) y los de 600 (cambio de clima con `world.rng`).
      - (b) Conjunto disperso generado con `generateChunk` en `x, y ∈ [-50, 50]`: 9 577 teselas,
        con huecos y por tanto vecinos ausentes. Tiene manantiales, charcas o humedal en todas
        las parejas de `{-49, -48, -25, -24, -1, 0, 23, 24, 25, 47, 48}`, es decir, cruzando
        cada múltiplo de 24 con signo. Incluye 542 tocones con madera 0,999 y tráfico y cultivo
        inyectados. Recorre 120 ticks ecológicos desde el tick 1400, empezando con lluvia.
    - La prueba exige que la puerta de cuenca se ejerza **exactamente** cuando `cuencas < 1`
      (359 reservorios de tierra fuera de cuenca con 0,4, ninguno con 1), que haya ticks con
      lluvia y que `ecology()` escriba `food`.
    - Un test más repite la escena (b) a través de `CPUWorkers` con 1, 3 y 4 workers, en el
      cuadrante `cuencas 0.4`, `decaimientoFertilidad 0.001`.
  - **Control contra el port congelado.**
    - El fixture es literal y sintético, sin `generateChunk`, para que un cambio de las reglas
      de terreno no lo rompa. Tiene 1 333 teselas en `x ∈ [-52, 51]`, `y ∈ [-7, 6]`, con
      huecos, las 14 features, `wood`/`growth`/`fertility`/`drinkingWater` ausentes en parte,
      vida en 0,45/0,44999999999999996 y humedad en 0,15/0,14999999999999997.
    - Se calcula el sha256 de los 15 primeros campos de 48 salidas encadenadas. El layout es
      por campo (`f*n+i`), así que coincide con el del port de `FIELDS = 15`.
    - Con las opciones omitidas, `{}` y `{seed: 51926, cuencas: 1, decaimientoFertilidad: 0}`,
      el hash es igual al del port congelado.
    - Con `cuencas: 0.4` y con `decaimientoFertilidad: 0.001` el hash cambia, así que el
      control muerde.
- `scripts/compute-ecology-core.mjs`: se añade un término descriptivo, `terms.tick`, al
  contrato del banco. Documenta que `stepWorld` ejecuta `ecology()` antes del kernel y dónde se
  prueba esa composición. No cambia la versión del contrato, ni `ECOLOGY_KERNEL_SPEC`, ni una
  sola operación de `stepArrays`.
- `specs/002-mundo-ilimitado/informes/T114-report.md`: este informe.

## Referencia del port congelado

```bash
git show bf23e04^:scripts/compute-ecology-core.mjs > /datos/tmp-atlas-lab/T114-probe/frozen-core.mjs
# bf23e04^ = 9665754c15e9c9c40b025a69ccf990896bc3849c; sha256 del fichero c66aa679…46ea11
node /datos/tmp-atlas-lab/T114-probe/frozen-control.mjs   # mismo fixture y frozenRun, con los dos ports
```

| Ejecución | sha256 |
|---|---|
| port congelado (`FIELDS = 15`, sin opciones) | `50034301b99aa752f6bdb1dbd5125ae52adccf7c7a2557aa93d25a36603e93bc` |
| port vivo, opciones omitidas / `{}` / `{seed 51926, cuencas 1, decaimiento 0}` | `50034301…93bc` (las tres) |
| port vivo, `cuencas 0.4` | `c0aa2403…e35a` |
| port vivo, `decaimientoFertilidad 0.001` | `98bdde20…0176` |

## Cómo se prueba

```bash
npm run typecheck
TMPDIR=/datos/tmp-atlas-lab timeout 900 npx tsx --test tests/compute-ecology.test.ts \
  tests/compute-ecology-benchmark.test.ts tests/ecosystem-kernel.test.ts tests/ecosystem.test.ts
COMPUTE_NVRTC=/opt/cuda/lib64/libnvrtc.so npx tsx --test tests/compute-ecology.test.ts   # con las 3 variantes CUDA
node --import tsx scripts/compute-ecology-benchmark.mjs --output <dir nuevo> --sizes 4096,65536 --repetitions 3 --nvrtc /opt/cuda/lib64/libnvrtc.so
```

## Cifras medidas

**Paridad (cierre).** En cada cuadrante se comparan
2 048 × 17 × 240 + 9 577 × 17 × 120 = **27 892 920 valores empaquetados**, más `food`,
`moisture` y `vegetation` tesela a tesela. En los cuatro cuadrantes, con 1 hilo y con 1, 3 y
4 workers, hay **0 diferencias** y el error absoluto máximo es 0. Duración de cada test del
tick íntegro: 2,0–3,2 s. La del test de workers: 2,4 s.

**Los tests muerden.** Hice cuatro mutaciones temporales, que no se commitearon:

| Mutación | Resultado |
|---|---|
| quitar la puerta de cuenca en `stepArrays` | fallan los dos cuadrantes con `cuencas 0.4` y el de workers; pasan los de `cuencas 1` |
| ignorar `decaimientoFertilidad` | fallan los dos cuadrantes con decaimiento, el de workers y el control congelado |
| en el candidato, kernel **antes** de `ecology()` | fallan los 4 cuadrantes |
| `unpack` pisa `food` (una regla nueva sobre un campo no empaquetado) | fallan los 4, con `aged world tick 610: food differs at tile 0` |

**Tests focales.**

- `npm run typecheck`: verde.
- Los cuatro ficheros focales: **60 tests, 57 pass, 0 fail, 3 skip**, en 16 s. Los tres skip
  son las variantes CUDA sin `COMPUTE_NVRTC`.
- Con `COMPUTE_NVRTC`, `tests/compute-ecology.test.ts` da **20/20 pass, 0 skip**: GPU0,
  GPU1 y GPU0+1 coinciden con el kernel vivo.

**Banco de T108** (`scripts/compute-ecology-benchmark.mjs`, fuente `0da419a`):

- A 4 096 y 65 536 celdas, 3 repeticiones, con ambas GPU: `ok: true`,
  `liveContract` = 192 comparaciones con 0 diferencias y `kernelSpecCheck` válido (v1.0).
- Los 7 modos dan 0 diferencias: `node-reference`, `cpu-soa`, `cpu-workers-4`,
  `cpu-workers-8`, `gpu-0`, `gpu-1` y `gpu-0,1`.
- Resultado en `/datos/tmp-atlas-lab/T114-bench-rama/result.json`.
- A **1 000 000 celdas**, 3 repeticiones y 46 s, en un host compartido con carga entre 20 y
  55: `ok: true` y **0 diferencias en los 7 modos**. Mediana en caliente de
  `computeAndTransfer`:

  | Modo | ms |
  |---|---|
  | `node-reference` (solo `compute`) | 136,26 |
  | `cpu-soa` | 126,56 |
  | `cpu-workers-4` | 52,75 |
  | `cpu-workers-8` | 48,98 |
  | `gpu-0` | 873,57 |
  | `gpu-1` | 1 043,99 |
  | `gpu-0,1` | 1 020,38 |

  El total en caliente de cada modo es de 1,4–3,0 s, dominado por el clon y el `pack` de
  objetos, que T112 y T115 eliminan. Resultado en
  `/datos/tmp-atlas-lab/T114-bench-rama-1M/result.json`.
- Estas cifras de tiempo **no** cierran la banda de rendimiento de T108 (`1M @ cpu-workers-4`,
  20,37–27,57 ms), que quedó en FAIL en su informe; T114 no la cambia.

**Digesto de control.**

- Se ejecutó `scripts/lab/digesto-control.ts --pasos 2400` en `200d284` (worktree
  `/datos/tmp-atlas-lab/b-base-T114`) y en la rama.
- Se usaron 3 semillas y dos juegos de parámetros:
  - «def»: sin `--params`;
  - «alt»: `persistencia.cadaTicks=300,social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3`.
- `social.memoriaDisputa=8`, que pedía el enunciado, **no existe** en `200d284`: `parseParams`
  lo rechaza como parámetro desconocido. Por eso se excluyó del juego «alt».

| Semilla | Juego | `digestoCanonico` base = rama | Población | Nacimientos |
|---|---|---|---|---|
| 7 | def | `2b639241…b5d3` ✅ | 16 | 0 |
| 7 | alt | `ceb05d5b…d413` ✅ | 16 | 0 |
| 42 | def | `fb7036cb…543d` ✅ | 21 | 5 |
| 42 | alt | `12ab9b88…20fc` ✅ | 20 | 4 |
| 51926 | def | `bff69c2f…0a5f` ✅ | 22 | 6 |
| 51926 | alt | `38b08b64…30bb` ✅ | 22 | 6 |

Los seis son idénticos, como se esperaba: el cambio no toca `src/`. Los ficheros están en
`/datos/tmp-atlas-lab/T114-digestos/`.

## Hardware

**El hardware no puede cambiar el resultado de este cambio.** Añade pruebas y un término
descriptivo al contrato del banco, no toca `src/` y no altera ninguna operación de `stepArrays`.
Esas pruebas demuestran además que el reparto no cambia el resultado: 1, 3 y 4 workers en el
test, y 4 y 8 workers y GPU0, GPU1 y GPU0+1 en el banco, dan cero diferencias contra el tick
vivo.

## Delegación

La implementación se delegó a `codex/gpt-5.6-sol` (esfuerzo `high`, `access=write`) con el
texto completo de la tarea y de las reglas. La llamada agotó los 1 800 s sin respuesta y sin
dejar ningún cambio en el árbol; no quedaba ningún proceso suyo vivo. El orquestador (Claude
Opus) implementó la tarea directamente.

## Lo que no cubre

- El candidato ejecuta `ecology()` sobre objetos: portarla a arrays es trabajo de T120, y este
  arnés es el que T120 y T121 deben reutilizar como oráculo.
- El arnés compara el tick ecológico aislado, no un `stepWorld` con el kernel SoA cableado:
  ese cableado es de T115, detrás de `motor.hilos`.
