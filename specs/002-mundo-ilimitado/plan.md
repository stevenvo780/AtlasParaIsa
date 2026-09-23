# Implementation Plan: Mundo ilimitado — el techo lo pone el hardware

> **Estado: etapas B–F congeladas el 2026-09-22 y descongeladas el 2026-09-23 por Steven**, para no
> probar solo mundos de techo bajo (decisión del plan maestro del 23-09); el criterio de 100 días
> con 3 generaciones sigue siendo el objetivo biológico de `GOAL.md`, no una condición de reanudar.
> La ola 1 de la etapa B (T111–T113) y del bloque E.0 (T141–T143) ya están fusionadas en `main`
> (`ff52c30`, `9a7913e`); la ola 2 de B (T115/T117/T120) queda en espera porque el perfil a 700
> habitantes (bitácora 23-09 17:50) no la señala como el coste principal (decisión D4). La etapa A
> está integrada en `main`; T103 y T104 quedan superadas por ARCH/PERF3 y ese perfil (nota en
> [tasks.md](tasks.md)); siguen abiertas T100 (topes de anticorrupción) y el Gate A (T110). Este
> documento conserva el diseño original: el estado de cada tarea está en [tasks.md](tasks.md) y lo
> publicado en `docs/ESTADO.md`. T116 y T135 siguen asignadas a `grok/*`, que la flota ya no
> permite; se reasignan al descongelar.

**Branch**: `002-mundo-ilimitado` (desde `001-mundo-solido-masivo`, HEAD **`f30d528`**; la primera redacción se hizo sobre `ab2b376`) | **Date**: 2026-09-19 | **Spec**: [spec.md](spec.md) | **Research**: [research.md](research.md) | **Tareas**: [tasks.md](tasks.md) | **Quickstart**: [quickstart.md](quickstart.md)

## Summary

La arquitectura elegida es **el esqueleto de `cpu-particiones` con la espina de `gpu-deltas`**, que es lo que los tres juicios concluyeron por separado (8,0/8,4 · 7,60/8,80 · 7,75/8,50). De `cpu-particiones` se toman el plan por etapas con métrica ANTES/DESPUÉS medida, la reversión por parámetro, el backend adversarial y la autoprueba de GPU; de `gpu-deltas`, las reglas concretas (máscara de fauna en el coordinador, prefix-sum de identidades, máscara de presencia, `enCuenca` como port real, nada de `Atomics` para magnitudes, checkpoint+replay); de `persistencia-red`, la partición ≥ 64 celdas, la aritmética explícita del presupuesto de 50 ms y la plantilla de experimento dentro de cada etapa.

El orden es el que manda el perfil, no la elegancia: **clonar y recoger basura son el 69 % del paso y la ecología —la pieza que tiene GPU— es el 0,54 %**. Por eso la GPU va la cuarta, no la primera, aunque «varias GPU» esté en la petición: acelerar el 0,54 % antes de quitar el clon no cambia un solo tick por segundo. Las seis etapas son A (paso residente, **hoy**), B (SoA + workers deterministas del ecosistema), C (GPU residente), D (deltas de persistencia y red), E (particiones de personas, el hito duro), F (gobernador que hace crecer el mundo activo).

La puerta de calidad transversal es **el digesto canónico**, no el hash de hoy: `encodeSnapshot` borra `retiredChunks` y depende del orden de inserción de las claves, de modo que la puerta de las tres propuestas era decorativa justo donde más falta hacía. Esa es la tarea T101 y bloquea todo lo demás.

**Revisión de refutaciones (2026-09-19)**: dos refutaciones adversariales (`.superpowers/sdd/002/refutacion-opus.md`, `refutacion-grok.md`) encontraron 18 fallos, los 18 verificados contra el árbol y los 18 aplicados; la tabla está en `research.md` §6. La arquitectura no cambia —fases con barrera, orden total por contenido, reversión por parámetro, digesto como puerta—; lo que cambia es **el alcance tasado**. Cuatro añadidos tienen tarea nueva: los topes duros de 65 536/256/8 que bloqueaban SC-004 (T100, Gate A0), el bucle por tesela de `ecology()` fuera del hilo principal (T120, etapa B), los índices no-persona de `nextIdentity`/`localInputs` (T140, bloque E.0) y los acumuladores agregados fuera del worker (T153, bloque E.1). Otros cinco amplían el alcance de una tarea existente: `communities`/`blueprints` por viewport (T134), los nueve contadores de identidad (T146), los ocho sitios de consulta por vecindad (T141), la topología absorbida en el SoA (T112) y `terrainIndex` sobre el índice aritmético (T113). Y dos pares de tareas `[P]` de la etapa D dejan de serlo porque editaban la misma función (T132→T133, T134→T135). Y cuatro criterios se reescriben con la aritmética delante: SC-004 (puerta de guardar/recargar 2 M teselas), SC-005 (medición por campo), SC-010 (comparación por barrera con hash de región) y SC-013 (100 días, no 30).

## Technical Context

**Language/Version**: TypeScript estricto sobre Node 22.23.1 · **Deps**: `ws`, `node:sqlite`, Vite, `tsx`; **sin deps nuevas** · **Storage**: SQLite WAL, esquema `user_version` 4 → 5 (aditivo) · **Testing**: `tsx --test --test-timeout=240000 tests/*.test.ts` (histórico 2026-09-19: 75 ficheros, 781 pruebas; hoy más de 1 400, ver `docs/ESTADO.md`; la suite completa ~10 min, `world.test.ts` ~5 min tras T013/T035) · **Target**: torre kratos (32 hilos, 125 GiB, RTX 5070 Ti 16 GiB + RTX 2060 6 GiB), navegador escritorio y móvil · **Performance Goals**: digesto idéntico en 9 backends; p50 del paso 206 → ≤ 25 ms a 40 hab/5 días; ≥ 4 000 habitantes a p95 < 50 ms con 28 workers; ≥ 18,4 M teselas en el tick ecológico **íntegro** (`ecology()` + kernel) ≤ 20 ms; `state` < 120 KiB con 10 000 habitantes **medido por campo**; `load()` ≤ 30 s en el mundo de 243 MB · **Constraints**: determinismo independiente del hardware (requisito no negociable), sin frameworks nuevos ni servicios externos, sin LLM en el bucle, params fuera del snapshot, histórico hasta el 23-09: el servidor público servía `dist/` en caliente desde este árbol; hoy corre en el portátil de Steven (nunca `npm run build`/`npm run check` en el árbol principal salvo al publicar) · **Scale**: de 40 habitantes y 15 k teselas activas hoy, a miles de habitantes y decenas de millones de teselas.

## Constitution Check

- **I (determinista y verificable)**: FR-001 y FR-003..FR-011 son el principio I aplicado al paralelismo; `tests/determinismo-hardware.test.ts` con backend adversarial y comparación por barrera es la prueba que puede refutarlo. `world.rng` se queda serial; todo lo demás ya usa `localRandom(seed, sal)` puro ✔
- **II (evidencia antes que impresión)**: cada etapa trae control (misma semilla, mismo digesto de reglas, misma escena), réplicas y métricas fijadas **antes** de tocar código, con fila en `docs/EVIDENCIA.md`. Ninguna cifra de techo entra sin réplicas ✔
- **III (reglas simples que se componen)**: la feature **no añade leyes**. Cambia una sola cosa del mundo —la simultaneidad de las decisiones (FR-020)— y lo declara. Los dos cambios de reglas evitables (offset regional de fauna, clima por región) se **rechazan** por eso mismo ✔
- **IV (diversidad y muerte con sentido)**: el control de la etapa E compara supervivencia, diversidad, causas de muerte y Gini de paternidad, no solo bits ✔
- **V (rendimiento medido, cómputo aprovechado)**: es la razón de la feature. Se mide por fase, se declara la **fracción serial** y se compara Node / workers / GPU con la misma escena ✔
- **VI (experiencia que emociona sin mentir)**: el techo se publica en pantalla (US5); «billones activos en esta torre» queda **fuera de alcance por escrito**; la GPU que diverge se apaga sola en vez de fingir ✔
- **Excepciones declaradas** (ver Complexity Tracking): derogación del supuesto de GPU del spec 001, `RULES_VERSION` → siguiente en la etapa E (vigente 10 desde 2026-09-22; la siguiente es 11, no 7), convivencia de dos caminos (objeto y SoA) durante B–E, subproceso persistente de GPU, prueba larga fuera de `npm test`.

## Arquitectura elegida

### El paso, en fases

| Fase | Quién | Qué hace | Regla de determinismo |
|---|---|---|---|
| 0 · Coordinador | hilo principal | clima (`world.rng`), gestos confirmados, roster, **máscara de fauna** (sort canónico global + ventana), reparto de regiones a workers | orden fijo; el reparto no entra en ninguna fórmula |
| A · Ecología | workers / GPU | autómata celular sobre el buffer *previo*, escribe el *siguiente*; halo 1 | cero coordinación: cada celda se calcula del snapshot previo |
| B · Percepción y decisión | workers | recorre personas y animales de su región, lee teselas propias y de halo 14 (`HALO_CELDAS`, alcance efectivo compuesto), **no escribe nada en el mundo**: emite `Intent` | solo lectura; en modo depuración los buffers están marcados de solo lectura |
| C · Confirmación | workers | aplica los intentos que tocan celdas de su región, ordenados por `(celda, slot)` | orden total **por contenido**, no por llegada |
| D · Global | hilo principal | nacimientos, muertes, comunidades, `move` de fauna, checkpoint tecnológico, crónica, muestreo, **prefix-sum de identidades** | `(regiónId, slot)`; `Atomics` nunca para magnitudes |
| E · Barrera y publicación | hilo principal | swap de buffers, versiones, `Store.save` por cadencia, `broadcast` por deltas | una sola barrera |

**Geometría**: región de ejecución 256×256 teselas (16×16 chunks de `CHUNK_SIZE=16`), página durable = chunk, **halo humano 14** (constante única `HALO_CELDAS`, con prueba estática de **alcance efectivo compuesto**), halo ecológico 1. Con halo 14 sobre 256 el borde es `(284²−256²)/256² = 23,1 %` del área (con halo 13 era 21,3 %); con 512×512 baja a `(540²−512²)/512² = 11,2 %`, y es la geometría recomendada si ese borde pesa en la medida de la etapa B. *(Corrección 2026-09-19, refutación G2: el halo era 8 porque se inventariaron los radios sueltos; el alcance de `settlementOpportunity` es 13 celdas al componer `home` ≤7 con `viable()` ≤6, `society.ts:94-124`. Corrección 2026-09-23, fusionada: el máximo real es **14**, porque `evaluateCooperation` compone ≤7 con ≤7 (`src/world/halo.ts:41`), cota que cubre también la de `settlementOpportunity`. Además `index.ts:403` recorre todo `world.places` sin filtro espacial: se resuelve replicando ese array —acotado a 2 048— de solo lectura en cada worker, no ampliando el halo.)*

**Lo que NO se particiona**: clima (`world.rng`), comunidades, tecnología, crónica, demografía y el pase de `move` de fauna (es una cadena secuencial, no un recurso por celda). Esa fase D es O(eventos del paso) **solo si** se cumplen cuatro condiciones, tres de ellas corregidas el 2026-09-19:

1. la etapa E ha matado los O(P²) —los doce sitios de FR-027, no solo los dos que se habían tasado—;
2. el `new Set(actors.map(...))` por tick de `technology-checkpoint.ts:90-91` es incremental;
3. **el bucle por tesela de `ecology()` (`index.ts:225-241`) ha salido del hilo principal**: es un segundo barrido completo de teselas, con la misma cadencia `tick % 10` que el kernel y cuatro `tileAt()` por tesela, y escribe `food`, que el kernel SoA/CUDA no escribe. Sin eso, la fracción serial crece con el **mundo** y SC-008 no puede darse (refutaciones R4/G4);
4. **los acumuladores globales (`world.totals`, `inventionDynamics`, `technology.ledger`) no se tocan desde un worker** (FR-023). Reordenar sumas FP64 cambia el último bit y el digesto lo mira.

**Lo que tampoco puede quedarse serial y no estaba en la lista**: `terrainIndex` (`animals.ts:131-138`, `Map` de todas las teselas, se invalida al cruzar una frontera de chunk) y la caché de topología del kernel (`sameCoordinates` compara dos flotantes por tesela y retiene cuatro copias de ~1,92 GB a 18,4 M teselas). Ambas viven en FR-024.

### Hardware

| Recurso | Papel | Cómo |
|---|---|---|
| 28 de 32 hilos | fases A, B, C | pool persistente de `worker_threads` sobre `SharedArrayBuffer`, patrón ya probado en `CPUWorkers` (`compute-ecology-clients.mjs:17-27`). Colas estáticas por región **hasta** que el adversarial esté verde; robo de trabajo después |
| 4 hilos | coordinador, red, persistencia, alimentación de GPU | — |
| 125 GiB | terreno residente + caché LRU de terreno dormido | ≤ 256 B/tesela, ~4 KiB/habitante. Hoy el proceso vive en 206–524 MiB: la RAM **no se usa para nada** |
| RTX 5070 Ti (78,6 %) + RTX 2060 (21,4 %) | **solo** el campo denso del ecosistema | FP64, `--fmad=false`, buffers residentes en VRAM. **Dos presupuestos de transporte, no uno**: subida de confirmación (dispersa, ≤ 1 MB/paso) y bajada del campo ecológico (densa: 1,18 GB por tick ecológico a 18,4 M teselas mientras los consumidores vivan en CPU), medidos por separado — FR-025. Reparto por throughput medido, **no** persistido con el mundo |

### Persistencia y red

- **Commits intermedios**: solo lo no derivable (gestos, cambios estructurales, ids y contadores asignados, versiones y raíz hash, journals, tick durable). El estado numérico se reconstruye con **replay ≤ 99 commits** desde el checkpoint, conservando `DEEP_CHECKPOINT_EVERY_SAVES=100`.
- **Archivo**: terreno dormido con la tupla `tiles-tuple-v1`; `technology_executions` podado por checkpoint de prefijo con digest de frontera, igual que `pruneChronicle` poda `events`.
- **Red**: `people` por viewport, agregados de censo en el servidor, **delta por campo** comparado después de `r3`, `ack` del cliente, `state-full` acotado al viewport en el resync, `perMessageDeflate` tras medir su CPU.

### Gobernador

Cuatro señales con **prioridad estricta y una sola palanca activa a la vez**: (1) área — retirar páginas frías por `(distancia mínima, lastTick, regiónId)`, nunca impedir el movimiento; (2) nacimientos — lo que ya hace hoy; (3) cadencia de red — subir `subscribeMs` antes que descartar; (4) cadencia de guardado — dentro de un máximo, sin tocar nunca la invariante «un gesto fuerza guardado en su propio paso». Señal nueva obligatoria: **teselas activas por habitante**. Publicación nueva obligatoria: **techo observado**.

---

## Etapas

Cada etapa: **métrica de aceptación medida con control**, fila en `docs/EVIDENCIA.md`, parámetro de reversión, y qué se despliega al cerrar.

### Etapa A — Paso residente y ahorro inmediato (HOY, cerrable con `/speckit-implement`)

**Qué entra**: digesto canónico (bloqueante) · **topes de anticorrupción derivados de params (T100, bloqueante: sin él ninguna etapa puede pasar de 65 536 teselas activas)** · clon acotado → punto de restauración → clon fuera, detrás de `motor.clonPorPaso` · `prep` y `flushTechnology` del guardado · `assertWorld` sin el bucle cúbico de `bonds` ni el superlineal de `recipeIds` · índice de `tileAt` que deja de reconstruirse · perfil por fase publicado en `performance.fases` · candado del benchmark reapuntado al kernel vivo.

**El punto de restauración no es el snapshot codificado** (corrección 2026-09-19, refutación R6): `store.lastSnapshotBytes` es el **tamaño**, no el cuerpo, y `encodeSnapshot` borra `retiredChunks`. Es un diario de deshacer o un clon estructural acotado, con `retiredChunks` compartido por referencia. Ver FR-012.

**Métrica de aceptación** (control: mismo commit sin el cambio, semilla 51926):

| | ANTES [medido] | DESPUÉS |
|---|---:|---:|
| p50 del paso, 40 hab / 5 días, servidor real | 206 ms | **≤ 25 ms** |
| día simulado (2 400 pasos, clon+paso) | 43 510 ms | **≤ 6 500 ms** |
| p50 del par clon+paso | 17,82 ms | **≤ 2,0 ms** |
| RSS final | 524,3 MiB | **≤ 220 MiB** |
| `prep` dentro de `save` | 168 ms | **≤ 20 ms** |
| `flushTechnology` | 75 ms | **≤ 10 ms** |
| habitantes a p95 < 50 ms, 1 hilo | ≈ 40 | **≥ 250** |

**Control obligatorio**: `digestoCanonico` a 1 200 y 2 400 pasos **idéntico** antes y después, en 3 semillas. `tests/projection-failure.test.ts` verde, más el test nuevo que fuerza el fallo de `save` con un chunk recién reanimado.

**Se despliega**: sí, al cerrar. Es la etapa que multiplica por ~8 lo que el servidor público sostiene hoy, sin cambiar ninguna regla.

**Reversión**: `motor.clonPorPaso=true`.

### Etapa B — SoA de terreno y ecosistema en workers deterministas (2–4 días)

**Qué entra**: `HALO_CELDAS=14` + prueba estática de **alcance efectivo compuesto** (incluida la activación a ±8, cuyo alcance escrito llega a ~24 celdas, `settlementOpportunity` con alcance compuesto 13, y `evaluateCooperation` con alcance compuesto 14, el máximo) · `TileStore` SoA por campo con **máscara de presencia** y doble buffer, **absorbiendo la topología del kernel** (vecinos por aritmética, sin almacenar; validación de caché por versión entera) · `tileAt` por aritmética de offset (sustituir el `Map`, no extenderlo) · `terrainIndex` de fauna sobre ese mismo índice · **el bucle por tesela de `ecology()` al camino paralelo** (T120) · `activate` con índice por clave y `maintainRegions` incremental (FR-019) · port de T013/T035 a `compute-ecology-core.mjs` · ecología cableada a `worker_threads` · **`tests/determinismo-hardware.test.ts` con backend adversarial** (primera ejecución, backends de CPU) · máscara de fauna calculada en el coordinador.

**Métrica de aceptación**: 1 M celdas dentro del motor de 47,30 ms (1 hilo) a **≤ 20 ms** (8 workers) · teselas activas a p95 < 50 ms **≥ 2 M** con 28 workers, **guardadas y recargadas con el mismo digesto** (la puerta nueva de SC-004) · bytes por tesela **≤ 256 B** sobre el buffer real **incluido el scratch del kernel** (hoy ≈348 B solo en JSON de teselas, más 418 B/tesela de topologías retenidas) · `tileAt` desaparece del perfil (hoy 3,15 %) · fracción serial declarada y medida, y **ninguna fase serial escala con `activeTiles`**.

**Control**: digesto idéntico en 3 semillas y en los 6 backends de CPU (1/2/4/8/28/adversarial). Escena «regiones dispersas» obligatoria: es la que detecta el fallo de la máscara de presencia. Escena «alcance compuesto» obligatoria: es la que detecta un halo corto. El modo corto de la prueba compara por **hash de región**, no por digesto completo (SC-010).

**Se despliega**: sí, con `motor.hilos` conservador (4–8) en el servidor público y 28 en el laboratorio.

**Reversión**: `motor.hilos=1`, `motor.soaTerreno=false`.

### Etapa C — GPU residente para el ecosistema (2–3 días)

**Qué entra**: puente de subproceso persistente por GPU con buffers residentes en VRAM y solo deltas por el canal · `enCuenca` portado a CUDA con el desbordamiento de 32 bits de `Math.imul`, los `>>>` lógicos, la división por 2³², `Math.floor` con negativos y el polinomio `fade` en el mismo orden · autoprueba de paridad al arranque con autodesactivación · reparto 79:21 por throughput medido · backends `gpu:[0]`, `gpu:[1]`, `gpu:[0,1]` de la prueba de determinismo.

**Métrica de aceptación**: tick ecológico **íntegro** (`ecology()` + kernel) a **18,4 M teselas ≤ 20 ms** y **32 M ≤ 25 ms** · **dos** presupuestos de transporte medidos por separado (FR-025): subida de confirmación **≤ 1 MB por paso** (hoy 120 MB a 1 M celdas) y bajada del campo ecológico con su cifra medida y su objetivo en ms declarado —1,18 GB por tick ecológico a 18,4 M teselas si los consumidores siguen en CPU, ~47 ms solo de transferencia sobre PCIe 4.0 ×16— · topes del prototipo (`compute-ecology-gpu.py:143,148`: 120 MB y 1 M celdas) levantados en el mismo commit · punto de cruce real medido y comparado contra el estimado (1,25 M celdas), **recalculado con la bajada dentro** · autoprueba con **0 diferencias**.

**Puerta de entrada de la etapa** (corrección 2026-09-19, refutaciones R5/G3): la etapa C **no arranca** hasta que esté escrita y medida cuál de las tres salidas de FR-025 se toma (SoA como autoridad con lectura por página bajo demanda · descarga acotada al halo de actores activos · presupuesto de bajada de cientos de MB con objetivo propio). Prometer «≤ 1 MB» sin distinguir dirección era un factor ≈118× de error.

**Control**: los tres backends de GPU idénticos al de 1 hilo. Inyectar una divergencia sintética de un bit y comprobar que la GPU se apaga sola, queda registrado y el mundo sigue con el digesto correcto.

**Se despliega**: sí, con `motor.gpu=[]` por defecto en el servidor público hasta tener una semana de verde; el laboratorio la usa desde el primer día.

**Reversión**: `motor.gpu=[]`.

### Etapa D — Deltas de persistencia y de red (2–4 días, en paralelo a B y C)

**Qué entra**: esquema v5 aditivo · checkpoint + replay acotado · páginas sucias **solo** para lo no derivable, con auditoría profunda cada 10 guardados · terreno dormido en tupla compacta · `technology_checkpoints` y poda de prefijo con digest de frontera · `people` por viewport · **`communities` y `blueprints` por viewport** (FR-026: solo `members` ya son ≈190 KB a 10 000 habitantes, por encima del techo entero de SC-005) · agregados de censo en el servidor · delta por campo con `ack`/`resync` · `perMessageDeflate` medido y decidido con el número.

**Orden dentro de la etapa** (corrección 2026-09-19, refutación G5): T133 depende de T132 y T135 depende de T134; **no** son `[P]` entre sí. T133 reescribe el bloque de archivo de chunks que vive **dentro** del `save()` que T132 reescribe (`store.ts:704-714`), y T135 añade el modo delta a **la misma función** `projectWorld` que T134 filtra. Un merge limpio pero semánticamente incorrecto ahí descarta el trabajo de una de las dos.

**Métrica de aceptación**: `load()` ≤ **30 s** (243 MB) y ≤ **120 s** (600 MB), y **sin crecer** con las ejecuciones archivadas · crecimiento ≤ **20 MB/día simulado** · p95 de `saveMs` ≤ **20 ms** a 2 000 habitantes · `chunks` −60 % de bytes · `state` **< 120 KiB** con 10 000 habitantes y **< 250 KiB** en viewport máximo · egress ≤ **2,81 MiB/s** con 12 clientes.

**Control**: recuperar un mundo guardado y comparar el digesto con el original; un cliente que solo recibe deltas durante 1 000 pasos converge al mismo estado que uno con `state` completos; el test de regresión de `2517b19` verde.

**Se despliega**: sí, por partes (la red antes que el esquema). El cambio de esquema exige respaldo (`npm run respaldo`) antes de publicar.

**Reversión**: `persistencia.paginasSucias=false`, `red.deltas=false`; el lector v4 se conserva una versión.

### Etapa E — Personas en particiones: intención y confirmación (5–8 días) — **el hito duro**

**Bloque E.0 (bloqueante, independiente de B/C/D, puede adelantarse al día siguiente de A)**: rejilla espacial de personas (`Int32Array` de cabezas + lista enlazada por slot, O(P) una vez por paso) como **la** vía de consulta por vecindad, que mata **los doce sitios de FR-027** —no solo `index.ts:324` y `index.ts:953-959`: también `index.ts:574,652,928`, `inventions.ts:120,194,365`, `family.ts:57`, `society.ts:105,205,207,213,222,242`— · índices no-persona (ids del archivo para `nextIdentity`, estructuras por celda, `localInputs` por `tileAt`, recuento de teselas aptas para fauna) · poda incremental de `bonds` (`lineage.ts:141`) · roster incremental en `advanceTechnologyCheckpoint` (`technology-checkpoint.ts:90-91`) · índice de personas en `assertWorld` para el bucle cúbico de vínculos.

**Bloque E.1**: partir `bodyAndAction`/`choose` en fase B (solo lectura, emite `Intent`) y fase C (confirmación ordenada por `(celda, slot)`) · migración de entidades entre regiones tras la barrera · prefix-sum de identidades **de los nueve contadores**, con la **transacción** como unidad para los de tecnología · **acumuladores agregados fuera del worker** (FR-023) · SoA caliente de persona **conservando el orden de iteración** de `skills`/`activity`/`values`/`bonds` · modo depuración con buffers de solo lectura durante la fase B.

**Métrica de aceptación**: E.0 — el ajuste de `p95(P)` a P ∈ {50, 200, 800, 2 000} pasa de cuadrático a **lineal con R² > 0,95**, y ≥ **700** habitantes a p95 < 50 ms con 1 hilo. E.1 — ≥ **4 000** habitantes a p95 < 50 ms con 28 workers (objetivo declarado 8 000), aceleración ≥ 10× frente a 1 hilo en la misma escena, **fracción serial ≤ 5 %**, ocupación media de workers ≥ 70 %.

**Control**: E.0 con digesto **idéntico** (es reordenar una búsqueda, no cambiar la regla). E.1 **no puede dar digesto idéntico al de hoy**: es un cambio de reglas declarado (FR-020, `RULES_VERSION` → siguiente; vigente 10, la siguiente es 11). Su control es doble: (a) los 9 backends idénticos **entre sí**, incluido el adversarial; (b) campaña científica con réplicas y control sobre el mundo anterior comparando supervivencia, diversidad, causas de muerte y Gini de paternidad — si la reducción canónica empeora alguna, se revisa la reducción, no se publica igual.

**Se despliega**: sí, y con **mundo nuevo por versión publicada** (la política de la constitución para cambios de esquema/reglas durante pruebas). Steven decide el momento.

**Reversión**: `motor.particionarPersonas=false` ⇒ fases B y C corren en el hilo principal en orden de slot, que es exactamente el motor de la etapa B. Ojo: eso revierte el **paralelismo**, no el **cambio de reglas**, que ya está versionado.

### Etapa F — El gobernador hace crecer el mundo activo (1–2 días, tras E)

**Qué entra**: señales p95 por fase, RSS, VRAM libre, cola de red, retraso de guardado, teselas activas y **teselas activas por habitante** · estados verde/amarillo/rojo/manual con tres ventanas verdes (36 s) para salir de rojo · palancas con prioridad estricta · desalojo de páginas frías por `(distancia mínima, lastTick, regiónId)` con caché LRU de terreno dormido respaldada por la tabla `chunks` · **techo observado** publicado · panel del cliente que lo muestra.

**Métrica de aceptación**: 30 días simulados sin tope, p95 pegado al presupuesto, amplitud de oscilación de población **< 15 %**, memoria < 70 % del techo · **SC-013**: con la misma semilla y **100 días** (no 30: el calendario de nacimientos topa 30 días en 1 200 nacimientos y taparía el efecto del hardware, refutación R7), `motor.hilos=28` alcanza ≥ **4×** la población de `motor.hilos=1`, con el digesto del día 5 **idéntico** en ambos, y la cota del calendario (4 000 nacimientos en 100 días) declarada junto a la cifra medida.

**Señal obligatoria añadida**: **máximo por ventana** además del p95. El p95 sobre 120 muestras es ciego a los picos de cadencia larga (comunidades cada 120, estadísticas cada 200, guardado cada 20): un pico de un segundo cada 120 pasos es el 0,83 % de la ventana y el panel seguiría en verde (refutación R8).

**Control**: el mismo barrido con `gobernador.senales=['p95']` (el gobernador de hoy) como control; el multiseñal no puede empeorar la población sostenida ni la estabilidad.

**Se despliega**: sí. Es la etapa que convierte «el límite lo pone el hardware» en un número que Steven lee en pantalla.

**Reversión**: `gobernador.senales=['p95']`.

---

## Protocolo de ejecución paralela

**Principio**: paralelismo máximo con aislamiento por worktree; calidad por **revisión adversarial por tarea**; evidencia por laboratorio. El coste de tokens no es restricción; la calidad se sostiene con revisión, no con cautela.

0. **Gate A0** (árbol principal, secuencial): T101 (digesto canónico) → T102 (parámetros `motor.*`) → T100 (topes de anticorrupción; usa el digesto de T101 como control). Todo lo demás sale de este commit. Sin T101 ninguna etapa tiene puerta de calidad que valga; sin T100 ninguna etapa puede pasar de 65 536 teselas activas y el SoA de T112 se dimensionaría contra un tope falso.
1. **Por etapa**, un workflow (`Workflow` con `scriptPath` en `.specify/workflows/002-etapa-<X>.js`) con un agente por tarea `[P]`, cada uno con `isolation: 'worktree'` desde el commit de gate de la etapa anterior. Cada agente:
   - `ln -s <repo>/node_modules node_modules` en su worktree; lee su tarea en `tasks.md` y las secciones de `research.md` que la sostienen.
   - Si su modelo es externo: `delegar_a_cloud(model, effort, access:'write', cwd:<worktree>, timeout_s: 1800)` con prompt **autocontenido** (texto literal de la tarea + reglas de ejecución + fragmentos actuales de los ficheros a tocar + la decisión de `research.md` que la justifica). Si es Claude, implementa él mismo.
   - Verifica: `npm run typecheck` + `timeout 600 npx tsx --test <sus tests>`. **Nunca** `npm test` completo (≈10 min; lo corre la integración) ni `npm run build`/`npm run check` en el árbol principal.
   - Commit en la rama del worktree; informe en `specs/002-mundo-ilimitado/informes/<TID>-report.md`.
2. **Revisor adversarial por tarea** (Claude Opus, o `codex/gpt-5.6-sol` para las tareas de determinismo): lee `git diff <base>..HEAD` del worktree con **tres lentes fijas**: (a) ¿alguna fórmula del mundo toca el número de hilos, particiones o GPU? (b) ¿alguna reducción depende del orden de llegada? (c) ¿cambia el mundo sin declararlo? Veredicto ✅/❌ + una ronda de arreglo con el mismo modelo + re-revisión acotada.
3. **Gate de etapa** (orquestador): merge en el orden de `tasks.md` (menos → más conflictivo), `npm run typecheck && npm test` en un worktree, `tests/determinismo-hardware.test.ts` en modo corto, barrido de control del laboratorio, fila en `docs/EVIDENCIA.md`, commit.
4. **Corrección**: todo hallazgo CONFIRMADO se arregla **antes** del merge, delegando al modelo del workstream original. Los menores van al ledger `.superpowers/sdd/002/progress.md`.

**Regla de oro del revisor**: la pregunta no es «¿funciona?», es «¿puede el hardware cambiar el resultado?». Un diff que pase typecheck y tests pero introduzca `availableParallelism()` en una fórmula del mundo es un ❌ automático.

**Regla de aislamiento de las tareas `[P]`** (añadida 2026-09-19, refutación G5): dos tareas `[P]` de la **misma oleada** no pueden declarar en su alcance la misma **función**, ni un bloque de código que la otra reescribe por completo, aunque el fichero se declare «en partes distintas». El orden de merge del gate no salva ese caso: cada worktree parte del mismo commit base y no ve el parche del otro, de modo que el conflicto aparece en el gate y un merge limpio puede descartar en silencio el trabajo de uno de los dos. Cuando eso ocurra, la segunda tarea deja de ser `[P]` y se declara dependiente.

**Paralelismo entre etapas**: A → (B ∥ D) → C → E → F. La etapa D solo depende de A; la C depende de B (necesita el SoA y el port). El bloque E.0 solo depende de A y puede correr desde el día siguiente. F depende de E para tener algo que gobernar a escala, pero sus señales y su panel pueden escribirse en paralelo.

---

## Project Structure

### Documentation (this feature)

```text
specs/002-mundo-ilimitado/{spec,plan,research,tasks,quickstart}.md
.superpowers/sdd/002/{juicio-*,propuesta-*,mapa-*}.md   # material de entrada (git-ignored)
.superpowers/sdd/002/progress.md                        # ledger: rulings, rondas, completados
specs/002-mundo-ilimitado/informes/<TID>-report.md     # informe por tarea (versionado)
.specify/workflows/002-etapa-{a,b,c,d,e,f}.js           # workflows por etapa
docs/EVIDENCIA.md                                       # una sección por etapa, con SHA y semillas
```

### Source Code (repository root)

```text
src/world/
├── digesto.ts              # T101 NUEVO: digestoCanonico (orden total, retiredChunks incluido)
│                           # + T117: hashRegion incremental para comparar por barrera (SC-010)
├── params.ts               # T102: motor.{clonPorPaso,hilos,soaTerreno,particionarPersonas,gpu},
│                           #        persistencia.paginasSucias, red.deltas, gobernador.senales
│                           # T100: limites.{teselasActivas,chunks,comunidades,fauna}
├── index.ts                # A: cloneWorld→puntoDeRestauracion, assertWorld sin O(P³)/O(recipeIds)
│                           # A/T100: topes de assertWorld derivados de params
│                           # B/T120: ecology() → bucle por tesela al camino paralelo (clima serial)
│                           # E.0: choose/nearbyPeople, reproduce, explorationTarget, share, herencia
│                           # D/T134: projectWorld acota people, communities y blueprints
│                           # E.1: bodyAndAction → fase B (Intent) + fase C (confirmación)
├── spatial.ts              # B: tileAt por aritmética, activate con índice, maintainRegions incremental
├── halo.ts                 # B NUEVO: HALO_CELDAS=14 + inventario de alcance efectivo compuesto
├── rejilla.ts              # E.0 NUEVO: rejilla espacial de personas (Int32Array + lista enlazada)
├── indices.ts              # E.0 NUEVO (T140): ids del archivo para nextIdentity, estructuras por
│                           #   celda, teselas aptas para fauna — fuera del camino de decisión
├── soa/{region,terreno,presencia,arena}.ts   # B NUEVO: TileStore SoA + máscara de presencia
│                           #   + topología absorbida (vecinos por aritmética, sin retener 4 copias)
├── paralelo/{piscina,particion,reduccion,barrera}.ts  # B/E NUEVO: pool, colas, orden total
├── paralelo/agregados.ts   # E.1 NUEVO (T153): totals/ledger/dynamics en punto fijo o como Intent
├── gpu/{puente,autoprueba,reparto}.ts        # C NUEVO
├── ecosystem-kernel.ts, ecosystem.ts         # B: cuerpo extraído a función sobre arrays
├── animals.ts              # B: máscara de fauna del coordinador, terrainIndex sobre el índice
│                           #   aritmético; E: partición regional (move serial)
├── society.ts, lineage.ts, technology-checkpoint.ts   # E.0/E.1
├── technology.ts, technology-catalogue.ts, technology-execution.ts, inventions.ts
│                           # E.1/T146: los cinco contadores restantes por prefix-sum de transacción
└── statistics.ts           # E.1/T153: count() sin acumular en el worker
                            # F: teselasPorHabitante, techo observado
src/server/
├── app.ts                  # A: stepOnce sin clon + perfil por fase · D: broadcast por deltas · F: gobernador
├── store.ts                # A: prep/flushTechnology · D: v5, checkpoint+replay, poda de prefijo
├── snapshot.ts             # D: tupla compacta también para el terreno dormido
└── technology-archive.ts   # D: technology_checkpoints, digest de frontera
src/shared/types.ts         # D: protocolo con state-full/state-delta/ack/resync · F: RuntimeStats
src/client/{connection,landscape,game}.ts    # D: deltas, ack, censo desde stats · F: panel del techo
scripts/
├── compute-ecology-{core,worker,clients}.mjs, compute-ecology.cu, compute-ecology-gpu.py  # B/C
├── compute-ecology-benchmark.mjs            # B: candado reapuntado al kernel vivo
├── lab/{replica,barrido,resumen}.ts         # B/E: --hilos, --gpu, curva p95(P), curva p95(teselas)
└── curva-techo.mts                          # A NUEVO: mide el techo de habitantes y de teselas
tests/
├── digesto.test.ts, restauracion-paso.test.ts        # A
├── halo-radios.test.ts, determinismo-hardware.test.ts # B (adversarial), C (GPU), E (9 backends)
├── compute-ecology.test.ts                            # B/C: contra el kernel VIVO
├── store-v5.test.ts, red-deltas.test.ts               # D
├── rejilla.test.ts, intencion-confirmacion.test.ts    # E
└── gobernador.test.ts                                 # F (ampliado)
```

**Structure Decision**: carpetas nuevas solo en `src/world/{soa,paralelo,gpu}`. El resto son ficheros nuevos junto a sus pares. Durante B–E conviven dos caminos (objeto y SoA) con **una sola autoridad por página**: una aserción rechaza que objeto y SoA sean escribibles a la vez.

---

## Complexity Tracking

| Excepción | Motivo | Alternativa simple rechazada |
|---|---|---|
| **Deroga `specs/001-mundo-solido-masivo/spec.md:150`** («No hay presupuesto de GPU para la simulación en este bloque: la GPU se usa para render y, si sobra tiempo, para el benchmark de ecología») | La petición de Steven nombra «varias GPU» explícitamente, y el muro de DRAM (research §3.3) demuestra que el eje de teselas es de GPU: 10 M teselas son ~25–31 ms en CPU y ~2,8 ms en la 5070 Ti | Dejar la GPU fuera: el techo de teselas se queda capado por el ancho de banda de memoria de la torre en todo el plan. Se declara aquí para que dos specs del repo no se contradigan en silencio |
| **`RULES_VERSION` → siguiente en la etapa E (vigente 10; la siguiente es 11, no 7)** | Separar decidir de escribir hace **simultáneas** todas las decisiones; hoy la persona N+1 ve la cosecha de la persona N dentro del mismo tick (`index.ts:797-800,907`). Es un cambio de reglas, no una optimización invisible | Afirmar que el orden `(celda, slot)` reproduce el orden de hoy: es cierto para las escrituras y **falso para la percepción**. Ocultarlo haría decorativa la puerta de calidad de la etapa y violaría los principios II y IV |
| **Dos caminos conviviendo (objeto y SoA) durante B–E** | Migrar de golpe las ~40 funciones que mutan teselas es el mayor riesgo del plan; la convivencia permite revertir por página | Big-bang de SoA: el servidor público sirve este árbol en caliente y no admite un salto sin red |
| **Subproceso persistente con memoria compartida para la GPU** | El puente de hoy gasta ~196 ms de IPC por paso sobre 0,40 ms de kernel: no sirve para producción. El subproceso persistente no mete toolchain nativa en `npm test` | Addon N-API/CUDA: es lo más cercano a un framework nuevo de todo el material y mete compilación nativa en el camino de las pruebas. Se reconsidera **con evidencia** si el subproceso no alcanza el punto de cruce medido |
| **`tests/determinismo-hardware.test.ts` en modo largo fuera de `npm test`** | 9 backends × 4 semillas × 7 escenas × 2 400 pasos no cabe en una suite que ya tarda ~10 min | Meterlo entero: repetiría el desastre de `world.test.ts`. El modo corto (600 pasos, ≤ 3 min) sí entra en `npm test`; el largo va tras bandera y en el gate de etapa |
| **Prueba estática de radios como guardián de una constante** | Es la única defensa contra que alguien añada mañana un radio 9 y el paralelismo empiece a divergir de forma intermitente | Documentarlo en `docs/REGLAS.md`: un comentario no falla en CI |

---

## Qué NO se toca en esta feature

La carta, los recuerdos aprobados, el contenido de S e I, las leyes de hambre, sed y senescencia, los parámetros de diversidad, los costes materiales, `data/` del servidor público, `~/.local/bin/atlas-servidor*`, `dist/` en el árbol principal, y la comprobación de Host/Origin. El único cambio del mundo que esta feature introduce es el declarado en FR-020, con su evidencia.
