# Research: Mundo ilimitado — el techo lo pone el hardware

**Fuentes**: los 4 mapas y las 3 propuestas de `.superpowers/sdd/002/` (levantados sobre `40bd5c7`), los 3 juicios (determinismo, techo, riesgo/constitución, emitidos sobre `ab2b376`), **las 2 refutaciones adversariales del 2026-09-19** (`refutacion-opus.md`, `refutacion-grok.md`; su tabla hallazgo → decisión está en §6) y verificación propia contra el árbol vivo. Toda cifra lleva marca **[medido]** o **[estimado]**; las estimadas dicen de qué medición se derivan.

---

## 0. Regla de método

**Ninguna etapa se escribe contra un mapa; se escribe contra el árbol, con `git log` de por medio.** Y, desde la revisión del 2026-09-19 (§6): **ninguna promesa con un número dentro se escribe sin hacer la aritmética antes**. Cuatro criterios de éxito de la primera redacción (SC-005, SC-010, SC-013 y el presupuesto de IPC de SC-004) eran inalcanzables por cuentas que cabían en tres líneas. Dos de las tres propuestas presupuestaron trabajo ya hecho: `Store.load()` **ya** abre la transacción anfitriona (`src/server/store.ts:241`, dentro del `try`, `acknowledgeHostCommit()` en la 244, `invalidateVerification()` en el `catch`), traída por `6d16dc3` («468 s → 3,3 s con 13 710 ejecuciones») y `2517b19` (revisión H1 + test de regresión). `persistencia-red` la declaraba prerrequisito de todo lo demás; `cpu-particiones` la arrastraba en su E7. Esa victoria está cobrada y **no se vuelve a presupuestar**.

---

## 1. Estado medido de partida (esta torre, 2026-09-19)

### 1.1 Hardware **[medido]** (`scripts/compute-hardware.py`)

AMD Ryzen 9 9950X3D, 32 CPUs lógicas, sin topes de cgroup · 125 GiB · RTX 5070 Ti 16 303 MiB (14 943 libres, cc 12.0) + RTX 2060 6 144 MiB (5 632 libres, cc 7.5) · CUDA 13.3, driver 610.43.03 · `worker_threads`, `SharedArrayBuffer` y `Atomics` disponibles · WebGPU **no** (`navigator.gpu === undefined`, sin flag en Node 22.23.1) · ningún addon nativo de cómputo instalado.

### 1.2 El paso, hoy **[medido]** (2 400 pasos = 1 día, semilla 51926, `--cpu-prof`, 31,74 s de reloj)

| Fase | p50 (ms) | p95 (ms) | máx (ms) |
|---|---:|---:|---:|
| `cloneWorld` | 10,25 | 14,33 | 32,84 |
| `stepWorld` | 3,50 | 9,48 | 24,29 |
| total | 14,03 | 22,40 | 41,65 |

Atribución de CPU: `structuredClone` **52,06 %** · GC **17,19 %** · lambdas de `choose` 6,83 % · `tileAt` 3,15 % · `animals.choose` 2,45 % · `animals.terrainIndex` 2,16 % · `syncFauna` 2,13 % · `stepAnimals` 1,96 % · `choose` (cuerpo) 0,91 % · `cloneWorld` (cuerpo) 0,62 % · **`EcosystemKernel.step` + `buildTopology` 0,54 %** · `perceivedRoutes` 0,33 %.

**Lectura**: clonar + recoger basura es ~**69 %** del paso. La ecología —la pieza que tiene GPU— es el **0,54 %**. Acelerar la GPU antes de quitar el clon no mueve un solo tick por segundo.

En el servidor real, con 40 habitantes y 5 días, el p50 del paso es **206 ms** [medido, tras el hotfix de carga]; dentro de `save` mandan `prep` **168 ms** y `flushTechnology` **75 ms**, y `assertWorld` es superlineal por el bucle de `recipeIds`.

### 1.3 Tamaños del mundo **[medido]** (5 días, 37 habitantes, JSON UTF-8)

`retiredChunks` **15 545 853 B (14,8 MiB, 143 chunks, ≈108 712 B/chunk)** · `tiles` activas 5 255 743 B (15 104, ≈348 B) · `animals` 717 567 B · `technology` 530 210 B · `people` 369 757 B (37, ≈9 993 B; una persona establecida 14 359 B) · **`World` completo 24 294 505 B (23,2 MiB)**.

`cloneWorld` (`src/world/index.ts:998-999`) hace `structuredClone({...world, tiles: []})`: **excluye `tiles` pero NO `retiredChunks`**, y reconstruye `tiles` con `.map(t => ({...t}))`, lo que invalida el índice `Map` de `tileAt` (`spatial.ts:29-31`) **en cada paso**.

### 1.4 Persistencia **[medido]** (copias `VACUUM INTO` de solo lectura)

Mundo de 243 MB: `chunks` 89,2 MB (36,7 %) + `technology_executions` 84,8 MB (34,9 %) = **71,6 %** del fichero. Mundo de 600 MB: 193,6 + 236,0 = **71,3 %**. La instantánea viva es solo 6,76 MB / 2,34 MB. Los chunks archivados pesan **106,1 KB de media** (máx. 212 KB) porque se escriben con `JSON.stringify(chunk)` (`store.ts:711`) en vez de la tupla `tiles-tuple-v1` que la instantánea viva ya usa (`snapshot.ts:6-25`). `technology_executions` **no se poda nunca**: la única `DELETE` es `truncateAfter` hacia adelante (`technology-archive.ts:535`) y el origen del journal es inmutable (`technology-archive.ts:264-275`).

### 1.5 Red **[medido]** (cliente WS de prueba, mundo nuevo, 16 habitantes)

`state` de 270 503 B con viewport 40×28: `tiles` 82,1 % · `people` 6,9 % · `events` 4,6 % · `animals` 3,4 %. Con viewport máximo (96×64 = 6 144 teselas, tope duro de `spatial.ts:96`): **1 274 469 B**, `tiles` 95,2 %, ≈198 B/tesela. `perMessageDeflate: false` explícito (`app.ts:102/113`). `send()` descarta el `state` con `bufferedAmount > 256 KiB` y termina el socket a 2 MiB (`app.ts:123-124/153-154`): **un solo `state` en viewport máximo ya supera el umbral de descarte hoy**. `people` es el único array pesado sin filtro de cámara (`index.ts:1037-1046`).

### 1.6 Cómputo paralelo existente **[medido]**, 1 M celdas

Node 1 hilo **47,30 ms** · workers×4 **23,97 ms** · workers×8 **19,41 ms** (⇒ 2,44× con 8 hilos, **eficiencia paralela 0,30**) · GPU 5070 Ti **219,03 ms** · 2060 258,49 · ambas 254,35. Desglose de la GPU: kernel **0,40 ms**, driver ~23 ms, **IPC del subproceso Python ~196 ms**. FP64 vs FP32 en microbenchmark: 50,7× más lento en la 5070 Ti, 39,8× en la 2060 — **y da igual**, porque la base son 0,40 ms.

**El cuello de la GPU hoy es transporte, no aritmética.**

---

## 2. Decisiones

### D1 — El clon se quita en dos tiempos: acotar, construir la restauración, quitar

**Decisión**: (a) `retiredChunks` deja de clonarse en profundidad (copia superficial del array + clon profundo **solo** del chunk que `activate` reanima); (b) se construye el punto de restauración; (c) **en el mismo commit** que quita el clon entra la restauración y `tests/projection-failure.test.ts` sigue verde.

**Por qué**: quitar el clon está **[medido]** y es el mayor salto del plan: día simulado **43 510 → 5 910 ms (7,4×)**, p50 **17,82 → 1,78 ms**, RSS **524,3 → 206,5 MiB**, `sha256(World)` a 1 200 pasos **idéntico** (`e3d0700f…1336`). Pero hoy la atomicidad del paso es **gratis**: `stepOnce` clona, simula sobre el clon, guarda el clon y solo entonces hace `world = draft` (`app.ts:213-224`). `tests/projection-failure.test.ts:38` pincha esa garantía con `assert.deepEqual(app.world, before)` tras un fallo sintético de `save`.

**Alternativas rechazadas**:
- *Quitar el clon de golpe* (E1 de `cpu-particiones`): los scripts que lo midieron llaman `stepWorld(draft, [], ctx)` **sin gestos y sin `store.save`** — miden el camino feliz. Al quitarlo: (1) `projection-failure.test.ts:38` falla porque `app.world` **es** el borrador mutado; (2) el replay desde el último snapshot no basta, porque un fallo determinista de `stepWorld` se reproduce igual en el replay; (3) la ruta `SessionRevoked` (`app.ts:233`) **vuelve sin marcar `failed`**, de modo que el mundo habría avanzado un tick con un gesto aplicado, no confirmado y no guardado — lo contrario de la invariante C3/C12 que el propio `stepOnce` documenta.
- *`draft.retiredChunks = world.retiredChunks` sin copiar* (Etapa 1 de `persistencia-red`, declarada «riesgo bajo»): **inseguro**. `maintainRegions` hace `push` (`spatial.ts:69`), `activate` hace `splice` (`spatial.ts:43`) sobre ese mismo array, y `activate` **reinyecta los mismos objetos** de animales, estructuras y lugares del chunk archivado (`spatial.ts:48-52`), que acto seguido se mutan. Corrompería el mundo confirmado en un paso fallido.

**Riesgo y refutación**: el aliasing de terreno dormido no lo ve el hash de hoy (ver D2). Refutación: forzar el fallo de `save` con un chunk recién reanimado y comprobar con el digesto canónico —que **sí** mira `retiredChunks`— que el mundo vigente no cambió.

### D2 — Digesto canónico propio antes de tocar nada

**Decisión**: `src/world/digesto.ts` con orden total explícito: teselas por `(x,y)`, personas por slot, **claves de todo `Record` ordenadas**, `retiredChunks` **incluido**, `chronicleJournal` excluido.

**Por qué**: `encodeSnapshot` (`src/server/snapshot.ts:25`) hace `JSON.stringify({...world, retiredChunks: [], retiredLegacy: [], tiles, …})`. Tiene tres defectos que lo invalidan como puerta de calidad: (a) el orden de claves de todo `Record<string, number>` (`bonds`, `skills`, `activity`, `values`, `totals`, `chunks`) es orden de **inserción**; (b) `tiles` y `people` van en orden de array; (c) **borra `retiredChunks`**, que es justamente la estructura cuyo aliasing puede romperse al tocar el clon. El sha256 con el que se «demostró» hoy la paridad de la etapa A es real, pero prueba **menos** de lo que parece.

**Alternativa rechazada**: reutilizar `encodeSnapshot` «con las claves ordenadas» — ese trabajo no existe hoy y mezclaría el formato durable con el instrumento de verificación. Se separan: `encodeSnapshot` sirve para persistir, `digestoCanonico` para probar.

### D3 — Región de ejecución 256×256; halo único de 8 celdas

**Decisión**: región = 16×16 chunks = 65 536 teselas. `HALO_CELDAS = 13` como constante única, con prueba estática de **alcance efectivo compuesto**. *(Corregido el 2026-09-19, refutación G2: la decisión original decía 8 porque el inventario contaba radios sueltos. Ver §6.)*

**Por qué**: el radio máximo de cualquier interacción del motor es **7** [verificado]: `RADIUS=7` (`index.ts:43`), `CONSTRUCTION_RADIUS=7` (`inventions.ts:91`), fundación de comunidad ≤7 (`society.ts:226`), reproducción ≤3+4 (`index.ts:945-952`), herencia ≤2, encuentro ≤1,5, percepción animal `1+⌊p·5⌋ ≤ 6` (`animals.ts:140`). Y `maintainRegions` ya trabaja a ±8 (`spatial.ts:59`). Coste del halo: sobre 256×256 el borde es `(272²−256²)/256² = 12,89 %`; sobre 128×128 sería 23 %; sobre el chunk de 16 **más de media tesela de cada chunk caería en halo ajeno**.

**Alternativa rechazada**: partición = chunk (16×16). También rechazado dejar el halo implícito: si alguien añade mañana una regla con radio 9, el paralelismo empezaría a divergir de forma **intermitente**; la prueba estática es la defensa.

**Aviso verificado**: `maintainRegions` activa el chunk que contiene `(x±8, y±8)`, de modo que el área **escrita** alcanza ~24 celdas desde la persona. La prueba de radios debe cubrir también la activación, no solo la percepción.

### D4 — La ventana de fauna la calcula el coordinador; la ocupación de celda se queda secuencial

**Decisión**: el coordinador ejecuta una sola vez el orden canónico global + la ventana + `selectedIds` (`animals.ts:285-289`) y lo reparte como **máscara de solo lectura**. El pase de `move` de fauna **permanece en la fase secuencial**.

**Por qué**: hoy `offset = ((tick % población) * MAX_ACTIVE_ANIMALS) % población` usa la población **global** de fauna. Un offset por región cambia **qué animales piensan en qué tick** y sacrifica la paridad con todos los mundos existentes. El coste del sort global es `O(A log A)`: con 10⁶ animales son ~20 M comparaciones, un orden por debajo del presupuesto. Y la **ocupación** es una cadena: `move()` decrementa `counts`/`occupants` en el origen **e** incrementa en el destino, en sitio, y el animal siguiente lee esos mismos mapas (`animals.ts:186,191-195`): **liberar una celda habilita la entrada de otro**. Un orden total por `(celda, actor)` aplicado por regiones **no reproduce** esa cadena cuando cruza fronteras.

**Alternativas rechazadas**: *offset regional* (E2 de `cpu-particiones`) — mete el tamaño de partición dentro de la regla y viola su propia propiedad «el número de particiones no entra en ninguna fórmula». *Modelar la ocupación como recurso por celda con reducción `(celda, slot)`* — no reproduce la cadena. Si algún día el sort global deja de ser barato, la sustitución correcta es un criterio **por entidad** independiente del orden (`hash(seed, animalId, tick) % k === 0`), puro y reordenable — pero **es un cambio de reglas**: versión, control y fila en `docs/EVIDENCIA.md`.

### D5 — `world.rng` se queda en la fase secuencial

**Decisión**: el clima sigue consumiendo `world.rng` una vez cada 600 ticks (`index.ts:218`), en la fase del coordinador.

**Alternativa rechazada (veto)**: `localRandom(seed, 'clima:tick:regionId')` por región (§3 de `persistencia-red`). Haría el clima dependiente del **identificador de partición**: el mismo mundo con otra descomposición tendría otro tiempo meteorológico — exactamente la dependencia del hardware que la feature prohíbe. Además obligaría a subir `RULES_VERSION` (hoy 6) y cambiaría el clima de todos los mundos existentes, **para ahorrar una llamada cada 600 ticks**.

**Verificado**: todo lo demás ya es puro — `localRandom(seed, sal)` (`genetics.ts:22`) y `hash(seed, …)` (`agua.ts:22`); no hay `Math.random` ni `Date.now` en `src/world/`. El motor ya está casi listo para ejecutarse en cualquier orden.

### D6 — Identidades por *stable sort* + *prefix-sum*, nunca por hash

**Decisión**: los workers emiten candidatos con clave `(tick, fase, regionMorton, actorSlot, secuenciaLocal)`; el coordinador ordena de forma estable y asigna por prefix-sum desde el contador confirmado: `descendant-(birthCounter+i)`, `community-(communityCounter+i)`, serial de evento, y deduplicación por `chunkKey` para `discoveredChunks`.

**Alternativas rechazadas (veto)**: *hash `seed:tick:posición`* (Etapa 7 de `persistencia-red`): los ids `descendant-N` viven en la crónica, en `legacy` y en los snapshots guardados — cambiar la fórmula **invalida todos los mundos existentes** y además colisiona con dos nacimientos en el mismo tick y posición. *Rangos reservados por partición*: mete el reparto en la identidad.

### D7 — El slot de persona se asigna al nacer y no se reutiliza nunca

**Alternativa rechazada (veto)**: `personIndex: Map<id, slot>` con **reuso de slots** (§2 de `persistencia-red`, presentado como «mejor para determinismo»). Rompe el invariante de que las personas se recorren en orden de inserción, que es *load-bearing*: `index.ts:324-325` toma el **primer** vecino del array (`nearbyPeople.find(…)`) y `society.ts:244` hace lo mismo en `resourceDispute`. `advancePopulation` filtra preservando el orden (`lineage.ts:140`) y `reproduce` añade al final: **slot = posición en el array = orden actual**.

### D8 — El orden de iteración de los `Record` de persona es parte del mundo

**Decisión**: al migrar `skills`/`activity`/`values`/`bonds` a campos de orden fijo, se conserva el orden de inserción con una **columna de orden explícita**; si se decide no conservarlo, va como cambio de reglas con réplicas y control.

**Por qué (hallazgo propio, ninguna propuesta lo vio)**: `src/world/society.ts:183` hace `Object.keys(person.skills).filter(…).sort((a,b) => person.skills[b]! - person.skills[a]!)[0]` y a continuación `other.skills[skill] = clamp(…)`. **Con dos habilidades empatadas, el desempate es el orden de inserción del `Record`.** Un SoA de 18 campos en orden fijo cambia ese desempate → se enseña otra habilidad → **otro mundo**. (El caso hermano de `index.ts:602` solo afecta a la vista.)

### D9 — La separación decidir/escribir es un cambio de reglas, y se paga

**Decisión**: la etapa E incrementa `RULES_VERSION` (6 → 7), con campaña de evidencia (réplicas, control, supervivencia, diversidad, causas de muerte) y fila en `docs/EVIDENCIA.md`. La puerta «digesto idéntico al de hoy» vale hasta la etapa D; **a partir de E la puerta es «los 9 backends idénticos entre sí»**.

**Por qué**: hoy el paso es secuencial **dentro** del tick: `for (const person of world.people) bodyAndAction(world, person)` (`index.ts:907`), y dentro, `choose` lee `world.people` ya mutado por las personas de slot anterior (`index.ts:324`) y `performWork` cosecha `tile.food` ya reducido por quien pasó antes (`index.ts:797-800`). Una fase B que decide sobre el estado congelado hace **simultáneas** todas las decisiones. Eso cambia el mundo aunque el orden de reducción sea perfecto y aunque los 9 backends coincidan.

**Alternativa rechazada**: afirmar que el orden `(celda, slot)` «reproduce exactamente el orden de hoy» (§3.2 de `cpu-particiones`). Es **cierto para las escrituras** (el orden de `world.people` es el orden de slot) y **falso para las lecturas/percepción**. `gpu-deltas` lo declara pero lo limita a los conflictos de recurso, cuando alcanza a **toda** decisión.

### D10 — FP64 y `--fmad=false`, sin excepciones

**Decisión**: el kernel CUDA se queda en `double` y NVRTC mantiene `--fmad=false` (`compute-ecology-gpu.py:63/68`), sin fast-math.

**Por qué**: la paridad fp64 de este kernel es **estructural, no suerte**: `scripts/compute-ecology.cu` completo son `+ - * /`, comparaciones y un `bounded()` de dos ternarios — **ni una sola función trascendente** donde libdevice y V8 pudieran diferir. FP32 ahorraría ~1-2 ms sobre un kernel de 0,40 ms/M y rompería el determinismo cruzado en silencio. La FMA redondea una vez donde JS redondea dos.

**Alternativas rechazadas (veto unánime de los tres juicios)**: fp32; quitar `--fmad=false`; y la puerta entreabierta de `persistencia-red` («salvo que se declare la GPU como acelerador aparte, con su propia reducción determinista documentada»): bajo el principio I no existe tal excepción.

### D11 — El reparto entre GPU es configuración, no estado del mundo

**Decisión**: reparto ≈**79:21** (5070 Ti : 2060) por throughput medido, recalculable en caliente y **no persistido** con el mundo.

**Por qué**: el kernel **no tiene reducción entre celdas** — `.cu:17` lee siempre `in[...]` global (nunca `out`), y el reparto ensambla con escrituras disjuntas (`compute-ecology-gpu.py:152,162`). **Cualquier** frontera da el mismo bit [verificado en el código]. Los throughput medidos son 2,5 M/ms y 0,680 M/ms ⇒ 78,6 % / 21,4 %.

**Alternativas rechazadas**: *50/50 por celdas* (lo que hace hoy el prototipo) — es por lo que «ambas GPU» nunca superó a la 5070 Ti sola. *Persistir la frontera con el mundo* (§4 de `gpu-deltas`): está demostrado que no afecta al resultado; persistirla mete hardware dentro del estado sin comprar nada, y si algún día sí afectara, el determinismo ya estaría roto y persistirla no lo salvaría.

### D12 — Autoprueba de paridad de GPU al arranque, con autodesactivación

**Decisión**: 4 096 celdas sintéticas, 100 invocaciones, `Object.is` contra el kernel de CPU (es lo que ya hace `compare()`, `compute-ecology-core.mjs:89`). Un solo bit distinto desactiva esa GPU **para la sesión** y queda registrado.

**Por qué**: cubre la **divergencia silenciosa** por cambio de driver, que «si una GPU falla, el paso se aborta antes del swap» no cubre (eso cubre el fallo duro). Es lo que hace honesta la frase «el hardware solo cambia la velocidad» (principio VI).

### D13 — Backend adversarial en la prueba de determinismo

**Decisión**: `tests/determinismo-hardware.test.ts` incluye un backend `adversarial`: particiones **en orden inverso**, **número de hilos distinto en cada paso** y **retardos de reloj real** entre ellas; y la comparación se hace **tras cada barrera** durante 2 400 pasos, informando tick/fase/página/campo/índice del primer desacuerdo, sobre 4 semillas × **7 escenas** (compacta, frontera de región, dos actores compitiendo por la misma tesela, nacimiento y muerte simultáneos, regiones dispersas, **alcance compuesto** y **cosecha simultánea en dos regiones**; las dos últimas añadidas el 2026-09-19 por las refutaciones G2 y R3) y en las **dos geometrías** de partición (256×256 y 512×512). *(Corregido el 2026-09-19, refutación R9: la comparación por barrera es un **hash incremental por región**, no el digesto completo; el digesto completo va al final del paso y a los hitos. Con el mundo entero por barrera, el modo corto tardaría ~1 h, no 3 min.)*

**Por qué**: es el injerto número uno de los tres juicios. Una matriz `1/2/4/8/28 + GPU` demuestra que **hoy** coinciden; el adversarial demuestra que el **diseño** no depende del orden de llegada. Y comparar solo el hash final **detecta**; comparar por barrera **localiza**.

**Consecuencia operativa**: el *work stealing* dentro de una fase se admite **solo** cuando el adversarial esté en verde, no antes.

### D14 — Puente GPU: subproceso persistente con memoria compartida

**Decisión**: un subproceso persistente por GPU, con el `.cu` compilado una vez al arranque, **buffers residentes en VRAM** entre pasos, y solo deltas por el canal (`(índice, valor)` de las teselas que la fase de confirmación tocó).

**Por qué**: de los 219 ms medidos a 1 M celdas, **0,40 ms son kernel, ~23 ms driver y ~196 ms IPC** del subproceso Python con framing JSON por paso (120 MB de subida + bajada). El transporte, no CUDA ni fp64, es el cuello.

**Alternativa rechazada**: *addon N-API/CUDA* (§4 de `gpu-deltas`). Es lo más cercano a un framework nuevo de todo el material y mete toolchain de compilación nativa en el camino de `npm test`; la constitución obliga a declararlo en Complexity Tracking con su alternativa simple, y la alternativa simple —el subproceso persistente— existe y está prototipada. Si el subproceso persistente no alcanza el punto de cruce medido, el addon se reconsidera **con evidencia**, no por preferencia.

**Punto de cruce [estimado desde dos medidas]**: `Tcpu(N) = 0,18 + 19,23·N_M` ms. Con round-trip completo por paso (`Tgpu = 23 + 0,40·N_M`) el cruce está en **1,21 M celdas**; con buffers residentes y 12,02 ms como cota conservadora de dispatch, en **0,63 M**. Hasta medir el puente residente, el selector usa **workers por debajo de 1,25 M celdas y GPU por encima**.

### D15 — Persistencia: checkpoint + replay acotado; páginas sucias solo para lo no derivable

**Decisión**: los commits intermedios escriben gestos, cambios estructurales, ids y contadores asignados, versiones y raíz hash, journals y tick durable. El estado numérico se reconstruye desde el último checkpoint con replay **≤ 99 commits**, conservando `DEEP_CHECKPOINT_EVERY_SAVES=100` (`store.ts:25`) como ancla.

**Por qué**: la ecología escribe `life/fertility/growth/vegetation/traffic/cultivation/drinkingWater/moisture/wood` de **toda** tesela activa cada 10 ticks (`ecosystem-kernel.ts:120-138`). Con `persistencia.cadaTicks=20` (2 s), **toda región está sucia en todo guardado**: el bit de sucio no discrimina nada. A 18,4 M teselas × 120 B son **≈2,21 GB por guardado**, ≈1,1 GB/s sostenidos. En un servidor 10× mayor el problema se multiplica por 10 y el ancho de banda de disco no.

**Alternativa rechazada**: *páginas sucias como mecanismo de persistencia del estado ecológico* (§5.1 de `cpu-particiones`, Etapa 6 de `persistencia-red` — la propuesta **especializada en datos**, que no hizo la cuenta de datos).

### D16 — El arranque debe crecer con el tamaño, no con la edad

**Decisión**: `technology_checkpoints(serial, tick, aggregate_body, prefix_digest, digest)`; tras validar un checkpoint se adelanta el origen lógico y se elimina el prefijo de `technology_executions`, conservando el digest de frontera como evidencia. Es el patrón con el que `pruneChronicle` ya poda `events` por `ventanaEventosTicks` (`store.ts:457-477`).

**Por qué**: `assertTechnologyReceipts` recorre desde `journal.startsAfter` hasta `committedThrough` **en cada carga** (`store.ts:499-505`), el origen es inmutable, y la única `DELETE` es hacia adelante. El arranque ya no tiene el multiplicador de 39×–58×, pero **sigue creciendo linealmente con la vida del mundo**. El riesgo de durabilidad dominante a 100× no es la corrupción —esa maquinaria es sólida— es el **RTO**.

### D17 — Red: delta **por campo**, no por objeto tesela

**Decisión**: se comparan las teselas **después** de la cuantización `r3` (`index.ts:1014`) y se manda **el campo que cambió**, no el objeto entero. Más `people` por viewport, agregados de censo en el servidor, `ack` del cliente con buffer corto de deltas por socket, y `state-full` acotado al viewport en el resync. `perMessageDeflate` se activa **tras medir su CPU y memoria por conexión**.

**Por qué**: comparar tras `r3` es necesario pero **no suficiente**. `tile.fertility` deriva `life * 0.0012` por invocación ecológica (`ecosystem-kernel.ts:122`) — **más de una milésima**. Con ecología cada 10 ticks y `broadcast()` cada 5 (`app.ts:231`), en los empujes que siguen a un tick ecológico **casi toda tesela viva del viewport ha cambiado tras la cuantización**. La afirmación de que «`tiles` cambia poco entre empujes de 500 ms» es falsa por esa razón.

**Alternativas rechazadas**: *subir los umbrales de `send()`* para ocultar mensajes grandes; *activar `perMessageDeflate` como «la ganancia de menor esfuerzo» sin medir*: hoy está en `false` a propósito, y con 12 clientes a 2 Hz la compresión entra en el mismo presupuesto de 50 ms que se está peleando. Se mide primero y se decide con el número.

### D18 — El gobernador vigila teselas activas, no solo población

**Decisión**: señal nueva **teselas activas por habitante**, y «reducir área» = retirar páginas sin habitantes ni halos obligatorios, ordenadas por `(distancia mínima, lastTick, regiónId)`, **sin impedir jamás el movimiento**.

**Por qué**: `maintainRegions` activa 9 chunks por habitante sin condiciones (`spatial.ts:57-63`, `[-8,0,8]²`) y `CHUNK_SIZE=16` ⇒ **2 304 teselas por habitante aislado**. 8 000 exploradores dispersos = **18,4 M teselas**; 8 000 vecinos en 40 asentamientos de 64×64 = `40 × (64+16)² = ` **256 k teselas** — **72× menos con la misma población**. El terreno lo mueve la **dispersión**, no la población.

**Alternativa rechazada**: la palanca «reducir el paso de `maintainRegions` de ±8 a ±8 solo alrededor de personas» (§6 de `cpu-particiones`, su prioridad 1): es un **no-op**, `spatial.ts:57-63` ya itera solo sobre personas y ya usa exactamente ±8.

### D19 — Dos costes por tick que el gobernador no podrá frenar

**Decisión**: entran en el plan con nombre y tarea. (a) `activate` escanea `retiredChunks` linealmente (`const pending = world.retiredChunks.findIndex(c => c.key === key)`, `spatial.ts:40`) — O(R) por chunk activado, con R sin poda y creciendo con el territorio explorado (143 chunks a 5 días con 37 habitantes); pasa a índice por clave + LRU. (b) `maintainRegions` hace `Object.entries(world.chunks)` **en cada tick** (`spatial.ts:66`): a 20–60 M teselas son 78 k–234 k entradas por tick en el hilo principal; pasa a recorrido incremental.

**Por qué**: ninguna de las tres propuestas los nombra, y son exactamente el tipo de techo que la feature promete quitar.

### D20 — El arnés de paridad se reapunta al kernel vivo

**Decisión**: `scripts/compute-ecology-benchmark.mjs:34` deja de exigir identidad de **bytes** con `95ff0d2` y pasa a validar una **especificación versionada de las fórmulas** contra el kernel vivo; `tests/compute-ecology.test.ts` compara contra `EcosystemKernel.step` de hoy.

**Por qué**: hoy lanza `Baseline core changed: src/world/ecosystem-kernel.ts` porque T013 (`d385c18`) y T035 (`e2446de`) lo modificaron. **No protege nada desde el 6 de septiembre.** Reapuntarlo es requisito de la etapa que toque el port, no un extra.

### D21 — Fracción serial presupuestada y medida

**Decisión**: presupuesto ≤ **5 %** de fracción serial del paso, medido por fase en cada etapa y publicado en `performance.fases`.

**Por qué**: la fase serial (nacimientos, muertes, comunidades, checkpoint tecnológico, crónica, clima, prefix-sum de identidades, `Store.save`) es **irreducible por exigencia de determinismo**. Con 320 hilos manda Amdahl: 5 % topa la aceleración en 20×, 10 % en 10×. Ninguna de las tres propuestas lo cuantifica; sin este número, el servidor grande no dará 10× por mucho que se repartan las particiones.

---

## 3. Aritmética del techo (cuentas propias, con su incertidumbre declarada)

### 3.1 Coste por habitante y paso

Dos derivaciones del **mismo** perfil:

- **Desde el reloj absoluto [preferida]**: `31 740 ms × 0,0807 = 2 561 ms` de reloj real en `choose` (lambdas 6,83 % + cuerpo 0,91 % + `perceivedRoutes` 0,33 %), sobre `2 400 × 18,5 = 44 400` persona-pasos ⇒ **57,7 µs/persona-paso**, declarado como **cota inferior** (solo `choose`).
- **Desde el reparto proporcional [rechazada]**: renormalizar esos puntos porcentuales contra el p50 **sin clon** de 1,78 ms da ≈24 µs para *todo* el coste de persona. Es incompatible por ~2,4× y en la dirección mala: el número absoluto es más fiable que un reparto proporcional de un p50 hipotético. Además divide un coste de **p50** contra un presupuesto de **p95**, cuando el p95 sin clon medido es 6,78 ms (3,8× el p50).

**Capacidad**: 28 workers × banda verde `0,7 × 50 = 35 ms` = **980 núcleo-ms/paso**. Con 57,7 µs ⇒ 16 984 habitantes; con factor 2 declarado (fisiología, acciones, consolidación, desequilibrio, fases globales) ⇒ **8 492**. **Objetivo de aceptación: 8 000. Cota optimista: ≈17 000, pendiente de medir.** Y con 4 000 medidos en la etapa E se da por cumplido el escalón.

**Rechazado**: `2 080 × 30 × 0,7 ≈ 43 700` habitantes (§1.1 de `cpu-particiones`). Aplica eficiencia paralela **0,7 a 30 hilos** cuando la medición propia del proyecto da **0,30 a 8** (47,30 → 19,41 ms = 2,44×, y de 4 a 8 workers solo 1,23×: el kernel ya está contra un límite compartido de DRAM). No es incertidumbre de factor 2: es usar el número contrario al medido.

### 3.2 El p95 ve el pico de la ecología, no su media

`EcosystemKernel.step` sale temprano salvo cada 10 ticks (`ecosystem-kernel.ts:88`). El gobernador mide p95 sobre 120 pasos (`app.ts:225-226`): en esa ventana caben **12 pasos ecológicos**, y el percentil 95 es la muestra 114 de 120. **El p95 ve el coste íntegro de la ecología.** Amortizarla («0,4 ms/paso amortizado») subestima su efecto **10×**.

### 3.3 El muro de DRAM (cuenta propia, ninguna propuesta la hizo)

El kernel mueve ~250 B por celda y por invocación (15 campos f64 leídos + 15 escritos + el *gather* de 8 vecinos). A 10 M teselas son **2,5 GB por invocación**; contra ~80–100 GB/s de DDR5 de dos canales son **~25–31 ms**, y el p95 los ve enteros. A 20 M teselas la ecología sola se come el presupuesto. La 5070 Ti mueve ~900 GB/s: los mismos 10 M salen en ~2,8 ms y 64 M en ~18 ms — que es el orden de los 20,12 ms derivados del throughput medido. **Las dos vías coinciden: el eje de teselas es de GPU y el eje de habitantes es de CPU.** *(Aviso, refutación G6: los 64 M son una cota de **throughput**, no de memoria. `64 M × 272 B = 16,21 GiB` no cabe en los 15,92 GiB totales de la 5070 Ti; la cota de VRAM está en ~50 M. Ver la tabla de §3.5.)*

**Y la cuenta de ida y vuelta, que faltaba** (refutaciones R5/G3): mientras `ecology()`, `bodyAndAction`, `stepAnimals`, `encodeSnapshot` y `worldStatistics` vivan en CPU, el campo ecológico tiene que **bajar** de la GPU: 8 campos mutables × 8 B × 18,4 M teselas = **1,18 GB por tick ecológico**, ~47 ms sobre PCIe 4.0 ×16 a ~25 GB/s efectivos. Eso es más que el presupuesto entero de 20 ms del kernel, y es la razón de que FR-025 exija dos presupuestos de transporte en vez de uno. La ganancia de la GPU en el eje de teselas sigue siendo real, pero solo se cobra entera si el SoA pasa a ser la autoridad y los consumidores de CPU leen por página bajo demanda.

### 3.4 Los O(P²) que hay que matar antes de reclamar cualquier techo

Verificados hoy:

```ts
// src/world/index.ts:324  — dentro de choose(), una vez POR PERSONA
const nearbyPeople = world.people.filter(other => other.id !== person.id && distance(person, other) <= RADIUS);
// src/world/index.ts:953-959 — bucle sobre TODA la población, con un filter de TODA la población dentro
// src/world/lineage.ts:141 — P × muertes, poda de bonds
// src/world/technology-checkpoint.ts:90-91 — new Set(actors.map(...)) en CADA tick, y recaptura O(P) en cada nacimiento/muerte
```

A 9 500 habitantes, solo el filtro de `index.ts:324` son ~90 M llamadas a `distance()` por tick ⇒ ~0,9 s por paso; repartidas entre 30 hilos, ~30 ms: **el 60 % del presupuesto entero para una sola línea**. Ningún techo por encima de ~1 000 habitantes es real sin esta etapa.

Y hay un muro más, de arranque, que ninguna propuesta nombra: `assertWorld` es **cúbico en población por los vínculos** — `Object.keys(p.bonds).some(id => !w.people.some(other => other.id === id))` dentro del bucle de personas (`index.ts:1148`) ⇒ O(P × B × P). A 8 000 habitantes con 64 vínculos son ~4·10⁹ comparaciones de cadena **en cada carga**. Solo corre en `load`/`upgrade`, pero es un muro de RTO.

### 3.5 Techo declarado, por eje, en esta torre

| Eje | Techo | Qué lo fija |
|---|---|---|
| RAM | ~400–500 M teselas · millones de habitantes | 184–256 B/tesela SoA, ~4 KiB/habitante. **Nunca es el límite.** |
| Habitantes (CPU) | **4 000 medidos / 8 000 objetivo** | 57,7 µs/persona-paso (cota inferior), 28 workers, menos la fracción serial |
| Teselas activas (CPU) | **2–10 M** | **Ancho de banda de DRAM**, no núcleos |
| Teselas activas (GPU) — techo de **VRAM** | **32 M validables, ~50 M como cota de memoria** | `50,3 M × 272 B = 12,74 GiB` de los 14,9 GiB libres en la 5070 Ti [validado por memoria] |
| Teselas activas (GPU) — techo de **throughput**, si la memoria no limitara | ~64 M en ~18 ms | Extrapolación de los ~900 GB/s de la 5070 Ti (§3.3). **No es alcanzable en esta torre**: `64 M × 272 B = 16,21 GiB` y la tarjeta tiene 15,92 GiB **totales** (16 303 MiB) y 14,59-14,9 GiB libres. La memoria lo impide antes de llegar ahí (refutación G6) |
| Disco | el que mande checkpoint + replay | Páginas sucias completas serían ~2,2 GB/guardado |
| Red | no vinculante tras filtrar `people` | Viewport capado a 96×64 = 6 144 teselas (`spatial.ts:96`) |
| **Arranque (RTO)** | **el límite real si no se poda** | O(edad) del journal tecnológico + `assertWorld` cúbico |

**En un servidor 10× mayor**: a 184 B/tesela, 1 TiB da ~6 G teselas residentes; los «billones» (10¹²) serían **184 TB**, alcanzables **solo paginando a disco**, nunca residentes. La formulación honesta y la que se adopta como invariante de diseño: **el mundo crece sin cota en almacenamiento; el conjunto activo lo acota el hardware.** Eso es literalmente «el software no pone el techo».

---

## 4. Riesgos y cómo se refutan

| # | Riesgo | Cómo se refuta (instrumento concreto) |
|---|---|---|
| R1 | Una escritura se escapa de la fase de solo lectura y el determinismo se rompe de forma **intermitente** | Modo depuración con los buffers del mundo marcados **de solo lectura** durante la fase de decisión; la excepción nombra el **slot culpable**. Más el backend adversarial (D13) |
| R2 | La puerta de calidad «hash idéntico» no ve lo que importa | Digesto canónico con `retiredChunks` y claves ordenadas (D2) **antes** de la primera migración. Sin él, la puerta de cada etapa es decorativa |
| R3 | Quitar el clon deja el mundo medio mutado en un paso fallido | `tests/projection-failure.test.ts` sigue verde; test nuevo que fuerza el fallo de `save` **con un chunk recién reanimado**; la ruta `SessionRevoked` marca `failed` |
| R4 | El SoA denso cambia `livingNeighbors` en todo el borde | Máscara de presencia obligatoria (FR-008); escena «regiones dispersas» en la matriz de paridad |
| R5 | El SoA de persona cambia el desempate de `society.ts:183` sin que nadie lo note | Test dedicado con dos habilidades **empatadas**; columna de orden explícita (D8) |
| R6 | La reducción canónica cambia el mundo más de lo declarado | `RULES_VERSION` 6→7 con réplicas y control: supervivencia, diversidad, causas de muerte, Gini de paternidad. Medir, no prometer |
| R7 | Un cambio de driver rompe la paridad de GPU en silencio | Autoprueba de arranque con autodesactivación (D12) + los tres backends de GPU en la matriz, que **nunca** pasan por ausencia de CUDA |
| R8 | El techo se convierte en el arranque | SC-006 medido sobre los ficheros reales de 243 MB y 600 MB; `assertWorld` con índice de personas en vez de `some` anidado |
| R9 | Las páginas sucias no bastan y reintroducen GB por commit | La cuenta de D15 está hecha **antes** de implementar; la auditoría profunda cada 10 guardados recalcula hashes y falla si cambió una página no marcada |
| R10 | El delta de red no alcanza los 120 KiB | Delta **por campo** (D17) y medición del caso peor: el empuje inmediatamente posterior a un tick ecológico |
| R11 | Un servidor 10× mayor no da 10× | Fracción serial medida y presupuestada (D21); si sube del 5 %, la etapa no cierra |
| R12 | El *work stealing* introduce dependencia del orden | Prohibido hasta que el adversarial esté en verde; entonces es gratis por construcción (D13) |
| R13 | Dos specs del repo se contradicen en silencio | `specs/001-mundo-solido-masivo/spec.md:150` («no hay presupuesto de GPU para la simulación») queda **derogado explícitamente** en el Complexity Tracking de `plan.md` |
| R14 | Se publica un techo que no se midió | Ninguna cifra de techo entra en `docs/EVIDENCIA.md` sin réplicas y control (SC-014). Las tres propuestas dieron 20 000–45 000 / 8 000 / 6 000–13 000: solo la fila del clon está medida |
| R15 | Se promete lo que no se puede dar | «Billones activos en esta torre» está **fuera de alcance** por escrito en el spec. Cientos de millones residentes y decenas de millones activas es lo defendible |

---

## 5. Qué NO se hace (vetos consolidados de los tres juicios)

1. fp32 en cualquier kernel del mundo, y quitar `--fmad=false`.
2. Identidades por hash `seed:tick:posición`.
3. Reuso de slots de persona.
4. Gateo regional de la decisión de fauna.
5. `localRandom(seed, 'clima:tick:regionId')` por región.
6. Persistir la frontera GPU en el estado del mundo.
7. `Atomics` para magnitudes del mundo (acumular FP64, decidir ganadores, asignar ids). Solo barreras, estado de worker y colas.
8. Cualquier reducción en árbol o por orden de llegada; cualquier `n/hilos`, `availableParallelism()` o reparto por capacidad **dentro** de la lógica del mundo.
9. *Work stealing* dentro de una fase antes de que el adversarial esté en verde.
10. Aceptar el candado actual de `compute-ecology-benchmark.mjs` como red de seguridad.
11. Migrar a páginas sucias o a SoA **antes** de tener el digesto canónico.
12. Quitar el clon sin entregar la restauración atómica en el mismo commit.
13. Páginas sucias como mecanismo de persistencia del estado **ecológico**.
14. Subir los umbrales de `send()` para ocultar mensajes grandes.
15. Volver a presupuestar el arreglo de la caché de verificación de `Store.load()`.
16. Reparto 50/50 entre las dos GPU.
17. Convertir `POPULATION_HARD_LIMIT` en techo de diseño.
18. Prometer billones activos en esta torre.
19. *(Añadido 2026-09-19)* Dar por buena una promesa de IPC que solo cuente una dirección del canal.
20. *(Añadido 2026-09-19)* Inventariar radios sueltos en vez de **alcance efectivo compuesto**.
21. *(Añadido 2026-09-19)* Acumular magnitudes del mundo en FP64 dentro de un worker.
22. *(Añadido 2026-09-19)* Declarar `[P]` dos tareas de la misma oleada que editan la misma función.

---

## 6. Refutación 2026-09-19 — hallazgo → decisión

**Base del árbol**: las dos refutaciones se escribieron contra `ab2b376`; **esta corrección se verificó contra `f30d528`**, porque durante la revisión aterrizó el sprint de cierre del 2026-09-19 (`d0428f0`..`f30d528`: R1–R5, 16 ficheros de `src/`, entre ellos `ecosystem-kernel.ts`, `store.ts`, `snapshot.ts`, `params.ts` y `statistics.ts`). Las citas `fichero:línea` de los specs están reescritas contra `f30d528`, pero **son indicativas**: un sprint puede moverlas otra vez, así que antes de editar hay que **localizar por contenido con `grep`**, no por número. Un solo hallazgo cambió de fondo con el sprint: R12 (ver su fila).

Dos refutaciones adversariales sobre los cuatro ficheros de la feature, cada una verificada contra el árbol vivo antes de decidir: `.superpowers/sdd/002/refutacion-opus.md` (12 hallazgos, R1–R12) y `.superpowers/sdd/002/refutacion-grok.md` (6 hallazgos confirmados, G1–G6, más uno que la propia refutación descartó por premisa falsa: `main.ts:23` sobreescribe `persistencia.cadaTicks` a 20 en producción). **18 hallazgos, 18 aplicados, 0 rechazados**: los 18 se releyeron aquí contra `src/` y ninguno resultó falso.

Cuatro de ellos son el mismo problema visto por las dos refutaciones (R1≡G1, R5≡G3, R4≡G4, y R8 comparte con G1 el tope de 8 comunidades); se aplican como una sola corrección y se citan juntos.

| # | Hallazgo | Sev. | Decisión | Dónde queda |
|---|---|---|---|---|
| R1 · G1 | Topes fijos de 65 536 teselas (`snapshot.ts:53`, `index.ts:1081`), 256 chunks (`index.ts:1123`), 8 comunidades (`index.ts:1156`, `society.ts:226`) y 393 216 animales (`animals.ts:11,283`): SC-004 pide 30,5× y 281× el primero, y ninguna tarea los tocaba | crítica | **Aplicado** | FR-002 (ámbito ampliado a `snapshot.ts`, `animals.ts`, `society.ts`) · SC-004 (puerta nueva: guardar y recargar 2 M teselas da el mismo digesto) · **T100 nueva en Gate A0**, bloquea B y C · `params.limites.*` en T102 |
| R2 | FR-006 enumeraba 4 contadores de identidad; hay **9**, y los 5 que faltaban se asignan dentro de `bodyAndAction` con invariantes de **contigüidad por transacción** verificadas (`technology.ts:422,636`, `technology-journal.ts:25-26`) | crítica | **Aplicado** | FR-006 (nueve contadores + la transacción como unidad del prefix-sum) · T146 (alcance, ficheros y test de dos crafteos anidados simultáneos con `assertTechnology` de oráculo) · el índice de ids de `nextIdentity` va a T140 |
| R3 | Los acumuladores FP64 globales (`statistics.ts:97` `count`, llamado en `index.ts:722,744,793,801,805,814`; `inventions.ts:364`; `technology.ts:251`) viven dentro de la fase paralelizable y ninguna reducción los cubría; la suma FP64 no es asociativa y T101 mete `totals` en el digesto | crítica | **Aplicado** | **FR-023 nuevo** · **T153 nueva** (punto fijo entero o `Intent` aplicado por el coordinador) · escena «cosecha simultánea» en T117 · la matriz de T117 incluye las **dos geometrías** de partición, que es donde se ve |
| R4 · G4 | La fase serial no es O(eventos): `ecology()` (`index.ts:215-242`, llamada en `:900`) es un **segundo** barrido completo de teselas con 4 `tileAt()` por tesela que escribe `food`, y `terrainIndex` (`animals.ts:131-138`) reconstruye un `Map` de todas las teselas al cruzar una frontera de chunk | crítica/imp. | **Aplicado** | **FR-024 nuevo** · **T120 nueva** (el bucle por tesela al camino paralelo; el clima de `tick % 600` se queda serial por FR-010; dos despachos, no un kernel fusionado) · T113 absorbe `terrainIndex` · T114/T121 comparan el tick **íntegro** · plan.md corrige «lo que NO se particiona» |
| R5 · G3 | «IPC ≤ 1 MB por paso» solo contaba la **subida**; la bajada del campo ecológico es de 1,18 GB por tick ecológico a 18,4 M teselas (8 campos × 8 B × 18,4 M), ≈118× el presupuesto y ~47 ms de PCIe frente a los 20 ms del kernel | crítica/imp. | **Aplicado** | **FR-025 nuevo** (dos presupuestos medidos por separado + tres salidas admitidas, una a elegir y escribir) · US3-2 y SC-004 reescritos · T122 (tests que cuentan las dos direcciones; topes del prototipo `compute-ecology-gpu.py:143,148` levantados en el mismo commit) · puerta de entrada de la etapa C en plan.md y T126 |
| G2 | `HALO_CELDAS=8` no cubre el alcance **compuesto** real: `settlementOpportunity` llega a 13 celdas (`home` ≤7 en `society.ts:111` + `viable()` que lee personas ≤6 en `:105`), y `index.ts:403` recorre todo `world.places` sin filtro espacial | crítica | **Aplicado** | FR-007 (halo **13**, inventario de alcance efectivo compuesto, `world.places` como lectura global replicada) · T111 (test que falla ante una composición 7+8) · escena «alcance compuesto» en T117 · plan.md recalcula el coste del borde (21,3 % con 256², 10,4 % con 512²) |
| R6 | El punto de restauración de T104 se apoyaba en dos cosas que no existen: `store.lastSnapshotBytes` es **un número** (`store.ts:150,692`) y `encodeSnapshot` **borra** `retiredChunks` (`snapshot.ts:25`) | importante | **Aplicado** | FR-012 (diario de deshacer o clon estructural acotado; nunca el snapshot codificado) · T104 reescrita, porque su texto anterior habría hecho escribir código contra una API inexistente |
| R7 | SC-013 («28 hilos ⇒ ≥4× población en 30 días») era aritméticamente imposible: 72 000 ticks / 120 × 2 = **≤ 1 200 nacimientos** sea cual sea el hardware (`index.ts:949,953`, `params.ts:49`), y el gobernador solo puede apagar la reproducción | importante | **Aplicado** | SC-013 y US1 pasan a **≥ 100 días simulados** (4 000 nacimientos de techo), con la cota del calendario **declarada junto a la cifra medida** · T166 · derivar el calendario de la demografía queda declarado como cambio de reglas fuera de alcance |
| R8 · G1 | Tope fijo de 8 comunidades en la regla (`society.ts:226`) con `reproduce` exigiendo comunidad (`index.ts:951`); y `updateCommunities` es O(P²) (`society.ts:205,207,213,222`) en la fase serial, con un pico cada 120 ticks que **el p95 no ve** | importante | **Aplicado** | (a) el `>= 8` sale a parámetro en **T100** · (b) índice por `communityId` y rejilla en **T141** · (c) **señal de máximo por ventana** en FR-018 y T161, con test de pico sintético; T144 la mide también |
| R9 | «Comparar tras cada barrera» con el digesto completo no cabe en los 3 min de SC-010: ≥ 288 000 digestos × 10,25 ms (p50 de `cloneWorld`, y sin ordenar nada) ≈ 49 min con las 5 escenas de entonces, ≈ 69 min con las 7 de ahora; incluso a 1 ms por digesto, 4,8-6,7 min | importante | **Aplicado** | SC-010 (hash incremental **por región** con la máscara sucia; el digesto completo se reserva al final del paso y a los hitos; cifra **medida**, no estimada) · T117 (`hashRegion` en `digesto.ts`; `diferenciaCanonica` solo sobre las regiones que discrepan) |
| R10 | SC-005 no lo conseguían T134/T135: `communities[].members` (`index.ts:1050`) son ≈190 KB con 10 000 habitantes, por encima del techo entero de 120 KiB, y `blueprints` viaja sin filtrar | importante | **Aplicado** | **FR-026 nuevo** · T134 amplía su alcance a `communities` (con `memberCount` y miembros visibles) y `blueprints`, incluido el cambio de contrato de `game.ts:475-476` · T138 mide **por campo** · SC-005 exige el desglose |
| R11 | E.0 no linealizaba el paso: quedaban ocho barridos O(P) por persona (`index.ts:574,652,928`, `inventions.ts:120,194,365`, `family.ts:57`, `society.ts:105`) más O(estructuras), O(territorio) y O(teselas) | importante | **Aplicado** | **FR-027 nuevo** (la rejilla es **la** vía de consulta por vecindad) · T141 amplía a los ocho sitios de personas · **T140 nueva** para los índices no-persona · T144 exige nombrar el cuadrático que quede vivo si el R² falla · cita corregida: `society.ts:242`, no `:244` |
| G5 | T134∥T135 y T132∥T133 eran `[P]` y editaban la **misma función** (`projectWorld`; el bloque de chunks vive dentro de `save()`, `store.ts:704-714`) | importante | **Aplicado** | T135 depende de T134 y T133 de T132; orden de merge del gate D corregido · regla 11 de «Reglas de ejecución» y sección «Regla de aislamiento de las tareas `[P]`» en plan.md |
| R12 | La caché de topología del kernel hace O(T) antes de cada tick ecológico (`sameCoordinates`, 2 flotantes por tesela) y retiene `MAX_TOPOLOGIES = 4` copias de scratch | menor | **Aplicado, con la cifra corregida** | FR-024 · SC-009 (se mide **con el scratch dentro**) · T112 absorbe la topología: vecinos por aritmética sin almacenar, validación de caché por versión entera. **Su aritmética no sobrevivió**: R12 calculó 1,92 GB por topología y 418 B/tesela contra el kernel que copiaba **siete** `Float64Array` por tesela, y el commit `6fbefd2` del sprint del 2026-09-19 los dejó en uno (`life`) mientras esta revisión estaba en curso. Recalculado contra `f30d528`: 56 B/tesela por topología ⇒ **224 B/tesela y ≈4,12 GB** a 18,4 M teselas. El hallazgo se sostiene —sigue sin margen bajo los 256 B/tesela de SC-009, y la validación O(T) sigue entera—; la cifra no |
| G6 | «~64 M teselas teóricas» aparecía en la columna de VRAM de §3.5, pero `64 M × 272 B = 16,21 GiB` no cabe en los 15,92 GiB totales de la 5070 Ti | menor | **Aplicado** | §3.5 separa «techo de VRAM» (~50 M, validado por memoria) de «techo de throughput» (~64 M, con el aviso de que la memoria lo impide antes) · §3.3 lleva el mismo aviso |

**Lo que la refutación NO tumbó**: la arquitectura. Fases con barrera, orden total por contenido, `(celda, slot)` y `(regiónId, slot)`, reversión por parámetro, digesto como puerta, backend adversarial, FP64 con `--fmad=false`, identidades por prefix-sum y el veto al offset regional de fauna y al clima por región siguen en pie y salieron reforzados. Lo que se tumbó fue **el alcance tasado**: cuatro trabajos sin tarea (R1, R2, R3, R4) y cuatro criterios de éxito escritos sin hacer la cuenta antes (R5, R7, R9, R10). La lección de método, que se incorpora a §0: **una promesa con un número dentro se comprueba con la aritmética delante antes de escribirla, no después de medirla.**

---

*Verificaciones propias sobre el árbol vigente `ab2b376`: `src/world/index.ts:31,38,43,218,324-325,602,907,949,990-1005,1076,1107,1146,1154`; `src/world/agua.ts:18-27,35-53`; `src/world/animals.ts:140,186,191-195,285-289,301-302`; `src/world/ecosystem-kernel.ts:55-70,74,106-123`; `src/world/society.ts:183,206-233`; `src/world/lineage.ts:130-142`; `src/world/spatial.ts:28-35,40,43,48-52,56-93,96,121`; `src/world/params.ts:30,47-53,82`; `src/shared/life.ts:30`; `src/server/snapshot.ts:6-25`; `src/server/app.ts:102,113,119,123-137,153-154,197-235,398`; `src/server/store.ts:25,241,457-477,499-505,711`; `src/server/technology-archive.ts:264-275,535`; `scripts/compute-ecology-{core,clients,benchmark}.mjs`; `scripts/compute-ecology.cu`; `scripts/compute-ecology-gpu.py:63,68,152,162`; `tests/*` (75 ficheros, 781 pruebas).*

*Verificaciones añadidas en la revisión de refutaciones del 2026-09-19 (§6), releídas una a una sobre **`f30d528`** (el árbol avanzó un sprint entero durante la revisión; las citas de arriba, de la primera redacción, siguen referidas a `ab2b376` y hay que localizarlas por contenido): `src/server/snapshot.ts:25,23`; `src/server/store.ts:150,692,704-714`; `src/world/index.ts:215-242,324,403,574,652,722,744,793,801,805,814,820,900-904,928,947-957,1073,1079,1121,1146,1154`; `src/world/society.ts:94-124,198-235,226,242`; `src/world/statistics.ts:97`; `src/world/animals.ts:8-14,131-155,258,280-292`; `src/world/ecosystem-kernel.ts:6,22-28,42-53,73-90`; `src/world/inventions.ts:82,120,194,196,318,333,335,355,364,365`; `src/world/technology.ts:251,283-290,401,422,636`; `src/world/technology-catalogue.ts:124,132,135`; `src/world/technology-execution.ts:15,17`; `src/world/technology-journal.ts:21-26`; `src/world/family.ts:57`; `src/world/params.ts:20,49,70-72`.*
