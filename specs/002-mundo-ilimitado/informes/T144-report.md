# T144 — Cierre medido de linealidad del bloque E.0

- **Fecha**: 2026-11-19
- **Rama / worktree**: `sprint/t172-docs-t144-20261119` (`HEAD` base `5935aea`, con T141, T142, T143 y ola 2 de E.0 `E0W2A`/`E0W2B`/`E0W2C` integradas)
- **Hardware**: torre AMD Ryzen 9 9950X3D (32 hilos, 125 GiB), ejecutado estrictamente en **1 hilo** (`motor.hilos = 1`, `motor.gpu = []`), bajo carga concurrente de fondo de la torre (`load average` ≈ 17 al arrancar)
- **Alcance**: medición y análisis únicamente (sin modificaciones en `src/`, `tests/` ni `scripts/`); directorios temporales `CARTA_DATA_DIR` en `/tmp/t144-*` creados y eliminados al terminar.

**Frase de determinismo**: esta tarea solo mide y documenta; no modifica fórmulas ni ejecución, de modo que el hardware no puede cambiar ningún resultado del mundo.

---

## 1. Resumen ejecutivo y veredicto honesto

| Criterio de [tasks.md](../tasks.md) §T144 | Resultado medido (1 hilo) | Estado |
|---|---|---|
| Linealidad de `stepWorld` en densidad constante (`P ∈ {50, 200, 800, 1 500}`) | `stepP50`: **`R²_lin = 0,99926`** (`R²_cuad = 0,99928`) · `stepP95`: **`R²_lin = 0,99778`** (`R²_cuad = 0,99913`) · `stepMax`: **`R²_lin = 0,99878`** | **CUMPLE** |
| Población bajo `p95 < 50 ms` a 1 hilo (densidad constante, in-place + `save` cada 100 pasos, régimen PERF3/V14) | **`P = 1 000`** medido con `stepP95 = 46,37 ms` y `totalP95 = 47,19 ms` (a `P = 700`: `35,41 ms`; a `P = 1 500`: `86,53 ms`) | **CUMPLE** (≥ 700) |
| Picos periódicos dentro de `stepWorld`: `updateCommunities` (cada 120) y `stepStructures` (cada 60) | `comunidades` máx: `0,54 → 11,92 ms` (`R²_lin = 0,98691` en `50..2 000`) · `fauna` máx: `3,68 → 34,45 ms` (`R²_lin = 0,97227`) | **CUMPLE** |
| Pico cada 200 pasos en proyección de servidor (`worldStatistics` → `indiceDiversidad`) | **`6,25 → 15,02 → 129,61 → 396,16 → 712,28 ms`** (`R²_lin = 0,94422` vs **`R²_cuad = 0,99964`** en `50..2 000`; **`R²_cuad = 0,99996`** en `50..1 500`) | **NO CUMPLE — $O(P^2)$ VIVO** |
| Ejecución literal de `scripts/curva-techo.mts --escala habitantes --hilos 1 --hasta 2000` | Se detiene por presupuesto en `P = 256` (`p95 = 71,68 ms`; último punto `< 50 ms`: **`128` hab.**, `p95 = 35,04 ms`) por `clone+save` cada tick (`cadaTicks = 1`) y apilamiento en 16 casillas | **BLOQUEADO POR FIXTURE / CADENCIA** |

**Veredicto**: el bloque E.0 (T141 + T142 + T143 + T140/`E0W2A`–`E0W2C`) **sí volvió lineal a `stepWorld`** en densidad constante (`R²_lin > 0,99` en `p50`, `p95` y `máximo por ventana` hasta `P = 2 000`) y **sí supera el objetivo de `≥ 700` habitantes bajo `p95 < 50 ms` a 1 hilo** (`1 000` habitantes medidos a `47,19 ms` p95 con cadencia de producción `cadaTicks = 100`). Sin embargo, **el cierre de extremo a extremo en servidor con clientes conectados NO puede declararse 100 % lineal todavía**: la medición del **máximo por ventana** destapó un término estrictamente cuadrático $O(P^2)$ vivo en `src/world/diversidad.ts:140-142` (invocado cada 200 pasos por `src/world/statistics.ts:38`), que provoca una pausa de `396 ms` a `P = 1 500` y `712 ms` a `P = 2 000`, invisible al `p95` de 120 pasos.

---

## 2. Ejecución oficial de `scripts/curva-techo.mts`

Comando ejecutado (semilla `51926`, `CARTA_DATA_DIR` temporal eliminado al finalizar, commit `5935aeaf`):

```sh
npx tsx scripts/curva-techo.mts --seed 51926 --escala habitantes --hilos 1 --hasta 2000 --salida /tmp/t144-curva-$$/out
```

| Escala (`P`) | Teselas activas | Teselas / hab | `p50` (ms) | `p95` (ms) | `tickHz` | RSS (MiB) | Tick final | Estado vs 50 ms |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 16 | 2 048 | 128,00 | 7,18 | 15,25 | 124,21 | 163,9 | 120 | `< 50 ms` |
| 32 | 2 304 | 72,00 | 8,57 | 16,69 | 105,67 | 179,8 | 240 | `< 50 ms` |
| 64 | 2 304 | 36,00 | 12,18 | 20,82 | 77,01 | 228,5 | 360 | `< 50 ms` |
| **128** | 2 560 | 20,00 | 22,44 | **35,04** | 43,29 | 248,1 | 480 | **`< 50 ms` (último)** |
| 256 | 3 328 | 13,00 | 46,86 | **71,68** | 20,83 | 290,3 | 600 | **Parada (`presupuesto`)** |

Ajuste sobre los 5 puntos medidos por `curva-techo.mts` (`P ∈ {16, 32, 64, 128, 256}`):
- `p50`: `R²_lin = 0,99124` (`a = 2,800`, `b = 0,1678 ms/hab`) vs `R²_cuad = 0,99958` (`c = +2,410 × 10⁻⁴ ms/hab²`).
- `p95`: `R²_lin = 0,98308` (`a = 8,132`, `b = 0,2396 ms/hab`) vs `R²_cuad = 0,99936` (`c = +4,826 × 10⁻⁴ ms/hab²`).

**Por qué `curva-techo.mts` literal se detiene en `P = 256` y muestra curvatura positiva**:
1. **Clon y guardado en cada paso** (`scripts/curva-techo.mts:308-310`): el script usa `DEFAULT_PARAMS.persistencia.cadaTicks = 1` y clona el mundo completo en cada tick, mientras que el servidor en producción (PERF3 / V14) simula *in-place* en pasos sin gestos y guarda cada `100` pasos (`PRODUCTION_PARAMS`).
2. **Apilamiento geométrico en 16 casillas** (`scripts/curva-techo.mts:125-133`): `agregarHabitantesSinteticos` coloca a los `P` clones sobre las mismas 16 posiciones iniciales de los fundadores. Eso fuerza a que cada consulta espacial de radio ≤ 7 (`vecinos` en `src/world/rejilla.ts:218`) devuelva $k = \Theta(P)$ vecinos por persona, convirtiendo cualquier bucle sobre vecinos locales en $O(P^2)$ por geometría del fixture, no por fallo de la rejilla.

---

## 3. Medición controlada en `P ∈ {50, 200, 800, 1 500, 2 000}` con máximo por ventana

Para separar el algoritmo E.0 del artefacto de apilamiento y de `cadaTicks = 1`, se ejecutaron tres series en 1 hilo sobre la misma semilla `51926`, con `Store` SQLite temporal (`reproductionEnabled = false`, 10 pasos de calentamiento JIT, instrumentación `FaseMedicion` por fase y medición explícita de `worldStatistics` en ticks múltiplos de 200):

### Serie A — Densidad constante (~1 persona / 6 teselas transitables), simulación *in-place* + `Store.save` cada 100 pasos (régimen producción V14, ventana de 240 pasos)

| `P` | Teselas | `stepP50` (ms) | `stepP95` (ms) | `stepMax` (ms) | Fase del pico `stepMax` | `comun.` máx (t=120/240) | `fauna` máx (t=%60) | `saveMax` (t=100/200) | `stats200Ms` (t=200) | `totalP95` (ms) | `totalMax` (ms, t=200) |
|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|
| 50 | 2 816 | 1,10 | 4,90 | 8,92 | `personas` (8,54 ms, t=31) | 0,54 | 3,68 | 19,80 | 6,25 | 4,91 | 30,02 |
| 200 | 4 096 | 2,61 | 9,40 | 17,31 | `personas` (10,26 ms, t=240) | 1,42 | 4,73 | 21,78 | 15,02 | 9,99 | 43,02 |
| 800 | 9 984 | 11,26 | **41,04** | 70,98 | `personas` (46,12 ms, t=240) | 3,73 | 13,18 | 80,37 | **129,61** | **43,00** | **237,01** |
| 1 500 | 14 848 | 20,56 | 79,80 | 127,01 | `personas` (79,11 ms, t=240) | 9,30 | 31,28 | 121,75 | **396,16** | 86,53 | **559,24** |
| 2 000 | 20 224 | 28,32 | 119,16 | 183,66 | `personas` (119,10 ms, t=240) | 11,92 | 34,45 | 197,26 | **712,28** | 126,09 | **952,68** |

**Acotación directa del cruce de 50 ms en Serie A** (ventanas de 120 pasos en 1 hilo, misma densidad constante y `cadaTicks = 100`):
- `P = 700` (`8 704` teselas): `stepP50 = 9,93 ms`, `stepP95 = 35,26 ms`, `totalP95 = 35,41 ms`, `totalMax = 77,34 ms`.
- `P = 900` (`11 008` teselas): `stepP50 = 14,10 ms`, `stepP95 = 42,01 ms`, `totalP95 = 45,89 ms`, `totalMax = 69,95 ms`.
- **`P = 1 000`** (`12 032` teselas): `stepP50 = 13,09 ms`, **`stepP95 = 46,37 ms`**, **`totalP95 = 47,19 ms`**, `totalMax = 70,38 ms` (**< 50 ms**).

### Ajustes OLS lineal ($a + bP$) vs cuadrático ($a + bP + cP^2$) en Serie A

| Métrica | `R²_lin` (`50..1 500`) | `R²_cuad` (`50..1 500`) | `R²_lin` (`50..2 000`) | `R²_cuad` (`50..2 000`) | Pendiente `b` / término `c` (`50..2 000`) | Diagnóstico |
|---|---:|---:|---:|---:|---|---|
| `stepP50` | **0,99926** | 0,99928 | **0,99911** | 0,99947 | `13,95 µs/hab` · `c = +5,37e-7` | **Lineal** |
| `stepP95` | **0,99778** | 0,99913 | **0,99142** | 0,99898 | `57,87 µs/hab` · `c = +1,02e-5` | **Lineal** (leve cola $O(P\cdot A)$) |
| `stepMax` | **0,99878** | 0,99882 | **0,99581** | 0,99827 | `88,59 µs/hab` · `c = +8,91e-6` | **Lineal** |
| `totalP95` (`cadaTicks=100`) | **0,99674** | 0,99952 | **0,99329** | 0,99972 | `61,76 µs/hab` · `c = +1,00e-5` | **Lineal** |
| `personas` (media) | **0,99971** | 0,99972 | **0,99834** | 0,99952 | `15,02 µs/hab` · `c = +1,05e-6` | **Lineal** |
| `comunidades` máx (t=120/240) | **0,97208** | 0,99712 | **0,98691** | 0,99103 | `5,94 µs/hab` · `c = +7,76e-7` | **Lineal** (antes $O(P^2)$ en T141) |
| `fauna` máx (t=%60) | **0,96885** | 1,00000 | **0,97227** | 0,97250 | `17,20 µs/hab` · `c = -5,34e-7` | **Lineal** (antes $O(P^2)$ por `knownBlueprints`) |
| `cloneWorld` p50 (ref.) | **0,98844** | 0,99893 | **0,98230** | 0,98691 | `32,50 µs/hab` · `c = +4,50e-6` | **Lineal** |
| **`stats200Ms` (`worldStatistics`)** | **0,95856** | **0,99996** | **0,94422** | **0,99964** | `a = -67,5` · **`c = +1,72e-4 ms/hab²`** | **CUADRÁTICO $O(P^2)$** |
| **`totalMax` (incl. t=200)** | 0,98242 | **0,99905** | 0,96249 | **0,99862** | `a = -54,7` · **`c = +1,80e-4 ms/hab²`** | **Dominado por `stats200Ms`** |

### Serie B — Mismo fixture apilado de `scripts/curva-techo.mts` (todos los clones en las 16 casillas fundadoras, *in-place* + `cadaTicks = 100`)

Sirve como contraprueba experimental del efecto geométrico de densidad $k = \Theta(P)$:

| `P` | Teselas | `stepP50` (ms) | `stepP95` (ms) | `stepMax` (ms) | `personas` máx | `comun.` máx | `fauna` máx | `stats200Ms` |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 50 | 2 304 | 0,50 | 2,62 | 12,83 | 12,66 | 0,15 | 1,33 | 2,75 |
| 200 | 2 048 | 0,95 | 7,59 | 55,30 | 55,02 | 2,93 | 4,39 | 11,07 |
| 800 | 2 048 | 3,31 | 55,99 | 397,34 | 393,95 | 39,70 | 47,53 | 115,72 |
| 1 500 | 2 304 | 6,39 | 168,63 | 1 157,52 | 1 154,03 | 148,99 | 159,01 | 417,95 |

Ajustes en Serie B (`P ∈ {50, 200, 800, 1 500}`): `stepP95` da `R²_lin = 0,96048` vs **`R²_cuad = 1,00000`**, `stepMax` `0,96586` vs **`1,00000`**, `comunidades` máx `0,93597` vs **`0,99993`**, `fauna` máx `0,94877` vs **`1,00000`**, y **`stats200Ms`** (con teselas constantes ~2 304, aislando a `indiceDiversidad` del BFS de agua) da **`R²_lin = 0,93903` vs `R²_cuad = 0,99995`** (`c = +1,936 × 10⁻⁴ ms/hab²`).

### Serie C — Trío completo `cloneWorld + stepWorld + store.save(cadaTicks = 1)` en densidad constante (`120` pasos)

| `P` | Teselas | `stepP50` (ms) | `stepP95` (ms) | `cloneP50` (ms) | `saveMax` (ms) | `totalP50` (ms) | `totalP95` (ms) | `totalMax` (ms) |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 50 | 2 816 | 1,49 | 5,70 | 1,22 | 15,31 | 11,81 | 17,90 | 23,95 |
| 200 | 4 096 | 4,43 | 11,43 | 2,51 | 27,99 | 21,89 | 31,00 | 41,05 |
| 800 | 10 240 | 15,72 | **37,16** | 7,48 | 180,56 | 67,33 | **95,27** | 207,65 |

Incluso con `clone + save` en cada tick sobre densidad constante, `stepP95` sigue siendo lineal (`R²_lin = 0,99967`) y `< 50 ms` a `P = 800` (`37,16 ms`), pero `store.save` en cada paso empuja `totalP95` a `95,27 ms`.

### Comparación frente al control pre-E.0 (datos archivados en [T141-report.md](T141-report.md))

En el mismo régimen de densidad constante (1 persona cada ~6 teselas transitables) sobre el commit base previo a E.0 (`5e0556f`, tabla §«Coste medido» de [T141-report.md](T141-report.md)):

| `P` | Pre-E.0 `5e0556f` `p95` (ms) | Post-E.0 `5935aea` `stepP95` (ms) | Reducción |
|---:|---:|---:|---:|
| 50 | 11,41 | 4,90 | **2,3×** |
| 200 | 22,42 | 9,40 | **2,4×** |
| 800 | 106,55 | **41,04** | **2,6×** |
| 2 000 | 451,46 | **119,16** | **3,8×** |

Antes de E.0, `p95` ya duplicaba el presupuesto de 50 ms en `P = 800` (`106,55 ms`) y se disparaba cuadráticamente hasta `451,46 ms` en `P = 2 000` (y `1 934,76 ms` en `P = 4 000`) por los barridos $O(P^2)$ de `choose`, `reproduce`, `updateCommunities`, `knownBlueprints` y `stepStructures`. Tras E.0 (ola 1 + ola 2), `P = 800` cae a `41,04 ms` y `P = 1 000` sigue bajo 50 ms (`46,37 ms` solo paso, `47,19 ms` con `save` cada 100 pasos).

---

## 4. Términos no lineales y cuellos todavía vivos (con `fichero:línea`)

Auditados sobre el árbol actual (`5935aea`):

1. **CRÍTICO — $O(P^2)$ activo cada 200 pasos en proyección de servidor**:
   - **`src/world/diversidad.ts:140-142`** (`indiceDiversidad`): doble bucle sobre todos los pares `(i, j)` de `world.people` (`P·(P−1)/2` pares: `1,12 M` a `P = 1 500`, `2,00 M` a `P = 2 000`), llamando además a `cosineDistance` (`src/world/diversidad.ts:112-120`), que recalcula `normA` y `normB` sobre 53 dimensiones en cada par. Su comentario (`src/world/diversidad.ts:132`) asumía el antiguo tope `poblacion.maxima ≤ 128`.
   - Invocado cada `ESTADISTICAS_CARAS_CADA_TICKS = 200` pasos desde **`src/world/statistics.ts:38`** (`estadisticasCaras`) vía `worldStatistics` (`src/world/statistics.ts:108`) y `projectWorld` (`src/world/index.ts:1602`).
   - Efecto medido: `129,6 ms` a `P = 800`, `396,2 ms` a `P = 1 500`, **`712,3 ms` a `P = 2 000`** (`R²_cuad = 0,99996`), invisible para el `p95` de 120 pasos y capturado únicamente por el máximo por ventana (`T161`).
   - *Nota técnica*: dado que los vectores no nulos de `vectorConducta` tienen norma L2 unitaria (`src/world/diversidad.ts:103`), la distancia coseno media sobre vectores unitarios admite reducción exacta $O(P \cdot d)$ mediante la suma vectorial $\sum v_i$ (tratando por separado los vectores en blanco de norma 0), pendiente de una tarea propia en `src/` con control de paridad.
2. **Secundario — $O(P_{\text{dec}} \times A)$ en búsqueda de presa y caza**:
   - **`src/world/index.ts:633-634`** (`choose` → `huntPlan`): dentro del bucle sobre teselas alcanzables con `fauna >= 1`, ejecuta `world.animals.filter(a => a.x === tile.x && a.y === tile.y && a.health > 0)` por cada persona que decide. Como la fauna activa $A$ crece con las teselas activas (y estas con la población dispersa), explica la ligera curvatura positiva residual en `personas_p95` (`c = +9,58 × 10⁻⁶ ms/hab²` en `50..2 000`).
   - **`src/world/animals.ts:527-530`** (`harvestAt`): ejecuta `world.animals.filter(...)`, `!world.tiles.some(...)` y `syncFauna(world.tiles, world.animals)` en cada caza completada.
3. **Latente — $O(|G|^2)$ en salida de comunidades grandes**:
   - **`src/world/society.ts:486-496`** (`updateCommunities`): por cada persona cuya distancia cultural a su comunidad sea `≥ 0,3`, filtra todos los miembros de su comunidad `(iniciales.get(group.id) ?? []).filter(...)` y promedia `bonds`. En la corrida sintética de 240 pasos no dispara (`culturalDistance < 0,3`), pero en un mundo envejecido con comunidades de centenares de personas es $O(|G|^2)$ cada 120 pasos.
4. **Barrido lineal $O(T)$ no incremental en cría de fauna**:
   - **`src/world/animals.ts:285-290`** (`faunaCapacity`, invocada en `reproduce`): recorre `world.tiles` entero cuando hay cría animal (ya documentado en [E0W2B-report.md](E0W2B-report.md)).
5. **Dependencia del grado de vínculos en cortejo**:
   - **`src/world/index.ts:565-576`** (`choose`): recorre `Object.entries(person.bonds)` completo por cada persona fértil que decide ($O(P \cdot \bar{B})$ si el grado medio de vínculos crece sin cota en mundos densos y longevos).
6. **Instrumento `scripts/curva-techo.mts` desalineado con producción PERF3**:
   - **`scripts/curva-techo.mts:125-133`** apila todos los clones sobre las 16 teselas fundadoras (induciendo $O(P^2)$ geométrico en la rejilla) y **`scripts/curva-techo.mts:308-310`** clona y persiste en cada tick (`cadaTicks = 1`), fijando el techo medido del CLI en `128` habitantes frente a `~1 000` en régimen de densidad constante + `cadaTicks = 100`.
