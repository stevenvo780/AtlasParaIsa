# T112: `TileStore` SoA con máscara de presencia y doble buffer

Base: `200d284`. Worktree: `/datos/workspaces/personal/AtlasParaIsa-n-B-t112`, rama `sprint/002-b-t112`.
Controles y pruebas medidos en `0c37f92`.

**Quién lo hizo.** El plan asignaba la tarea a `codex/gpt-5.6-sol · xhigh`. La delegación
(`delegar_a_cloud`, `access=write`) agotó los 1800 s sin responder ni escribir un solo fichero en el
worktree; `get_ai_quotas` daba el servidor de Codex como «desactivado». La implementación, los tests y
los controles los hizo el orquestador (Claude Opus), sin segunda vuelta de delegación.

## Antes de tocar (reglas 11 y 12)

- Las citas siguen valiendo en `200d284`: `MAX_TOPOLOGIES = 4`, `sameCoordinates` (dos flotantes por
  tesela) y `buildTopology` (`Int32Array(length * 8)` de vecinos, `-1` para los ausentes) están en
  `src/world/ecosystem-kernel.ts`. El kernel ya no copia siete instantáneas (`6fbefd2`). PERF2
  (`indice-puntos.ts`, `tile-index.ts`) indexó lugares, estructuras y `tileAt`, no la topología del
  kernel: **nada de T112 estaba hecho**.
- Hay un solapamiento que declarar: el control exige que `motor.soaTerreno` llegue al kernel, y el
  único llamador es `advanceTick` en `src/world/index.ts`, que no está en la lista de ficheros. Es
  **una línea** (añade `soaTerreno: paramsOf(world).motor.soaTerreno` a las opciones del kernel). T141
  (rejilla de personas) trabaja en `index.ts` en paralelo: si también toca `advanceTick`, el conflicto
  al integrar es textual y de una línea. T114 no se ve afectado: `tests/compute-ecology.test.ts` usa
  `EcosystemKernel` con el default, cuyo camino no cambió (verde abajo).
- El segundo juego de parámetros pedido incluía `social.memoriaDisputa=8`, clave que **no existe** en
  `200d284` (`parseParams` la rechaza). Los controles usan los otros cuatro:
  `persistencia.cadaTicks=300,social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3`.

## Ficheros y cambios

- `src/world/soa/region.ts` (nuevo): la geometría. La región de 256 × 256 es la unidad de partición; la
  página de 16 × 16 (= un chunk) es la unidad de almacenamiento. Cada región es una tabla de sus 256
  páginas → ranura de arena, con clave numérica, sin cadenas. Las coordenadas **no se guardan**: la celda
  `ranura·256 + offset` está en `(páginaX·16 + offset%16, páginaY·16 + ⌊offset/16⌋)`. El dominio aritmético
  son los enteros en [−2³⁰, 2³⁰), que contiene de sobra `MAX_COORDINATE`.
- `src/world/soa/arena.ts` (nuevo): un typed array por campo sobre `SharedArrayBuffer` (para que los
  workers de T115 lean el mismo buffer), con los campos reservados al primer uso, crecimiento ×1,25 y
  contabilidad exacta de bytes. No tiene tope de capacidad (FR-013).
- `src/world/soa/presencia.ts` (nuevo): la máscara de presencia, un sello `Uint32` por celda y por
  página. Presente ⇔ sello = versión vigente (+1 en cada carga). Retirar no cuesta nada, una ranura
  reusada no hereda presencia, un sello repetido en la misma carga es una coordenada duplicada, y al
  desbordar se borran los sellos.
- `src/world/soa/terreno.ts` (nuevo): `TileStore`.
  - Guarda todos los campos de `Tile`. Enumerados en `Uint8` (0 = ausente); numéricos en `Float64` con
    `NaN` = ausente, que no choca con nada porque el mundo nunca guarda no finitos. Se conservan `-0` y
    los opcionales ausentes.
  - `pack`/`unpack`/`flush` hacen ida y vuelta exacta. `loadLife` es el modo topología del kernel.
  - Autoridad única por página (objeto | SoA): cargar sobre páginas con escrituras sin volcar lanza, y
    escribir sin haber tomado la SoA también. `discard` abandona sin tocar los objetos.
  - `life` tiene doble buffer (frente/fondo, `swapLife`). Hay máscara sucia por página y una versión
    `Uint32` del conjunto de páginas (`pageSetVersion`).
  - `livingNeighborCounts` hace una sola pasada con los arrays en locales.
- `src/world/ecosystem-kernel.ts` (sólo la topología y su caché): `EcosystemOptions.soaTerreno`. Con
  `true`, la foto de `life` y la presencia van al `TileStore`, las vecinas vivas se cuentan por
  aritmética con la máscara y `topologies` queda vacía. El cuerpo de la regla no cambia: mismas
  expresiones y mismo orden de escrituras, así que también se conserva el orden de claves de las
  teselas. Con `false` (default) el camino de objetos y su caché siguen idénticos. `buildTopology` y su
  tipo se exportan para el test.
- `src/world/index.ts`: la línea de cableado de arriba.
- `tests/soa-terreno.test.ts` (nuevo): 13 tests.

### Decisiones que se apartan de la letra de la tarea, y por qué

1. **«Un buffer por campo y región de 256×256» se implementa como región = tabla de páginas sobre una
   arena por campo.** Un buffer denso de 65 536 celdas por región desperdicia memoria en los mundos
   reales. El de la semilla 51926 a los 60 pasos tiene 2 560 teselas en 10 chunks repartidos por
   **3 regiones** alrededor del origen (medido): serían 196 608 celdas reservadas para 2 560 presentes,
   77× la memoria, y rompería ≤ 256 B/tesela. Con páginas, la vecina de una celda en otra región se lee del mismo buffer. La región
   sigue siendo la unidad de reparto: `RegionTable.ordered()` da el orden por contenido `(regiónY, regiónX)`.
2. **Doble buffer sólo para `life`.** Es el único campo que la ley lee de otra celda. Los demás los lee
   y escribe cada celda en su propia ranura, así que duplicarlos no protege nada y doblaría la memoria.
3. **En esta tarea el kernel usa el SoA sólo para la topología.** La lista de ficheros limita el cambio
   del kernel a «solo la topología y su caché». Pasar el cuerpo de la regla a arrays es de T115
   («extraer el cuerpo a función sobre arrays»). En modo kernel el SoA es un espejo de sólo lectura con
   autoridad «objeto». La autoridad SoA, el doble buffer y el volcado están implementados y probados en
   `TileStore` para que T115 los use.
4. **Validación por versión.** Lo que se retiene entre pasadas (tabla de páginas y vecindad de páginas)
   se valida con `pageSetVersion`: sólo se recalcula, en O(páginas), si entra o sale un chunk. Ya no hay
   comparación de flotantes ni topologías retenidas. Aun así, asignar a cada tesela su celda sigue siendo
   una pasada O(T) de aritmética entera por tick ecológico, fundida con la copia de `life` que ya existía.
   Quitarla exige saber qué teselas cambiaron sin mirarlas, y eso pasa por mantener el índice en
   `activate`/`maintainRegions` (T113) o que el SoA sea la autoridad residente del terreno (T115/T120).

## Cómo se prueba

`tests/soa-terreno.test.ts`:

1. **Ida y vuelta de un mundo real** (`createWorld(51926)` + 200 pasos): `unpack` y `flush` sobre objetos
   corrompidos dan el mismo `digestoCanonico`.
2. **Ida y vuelta de casos límite**: `-0`, campos ausentes, chunks parciales, negativos y ≥ 6 regiones.
   Además, rechazo de enumerados, claves, `NaN`, `-0` y coordenadas no enteras.
3. **Vecinos por aritmética = `buildTopology` uno a uno** (mismo orden, mismo `-1`) en un conjunto
   disperso: chunks negativos, a ambos lados de la frontera de región 256, con huecos y celdas sueltas.
   Más de 500 teselas de borde. El recuento de una pasada coincide con la topología para cinco umbrales.
4. **La versión `Uint32` da la vuelta** sin resucitar celdas: sin el borrado al desbordar, el test falla.
5. **Por qué existe la máscara**: en una página presente con una celda ausente, la máscara conserva el
   `-1` de `buildTopology`; sin ella la ranura rancia aparece como vecina y `livingNeighbors` pasa de 7
   a 8.
6. **Kernel SoA = kernel de objetos** en 4 × 120 actualizaciones (`cuencas` ∈ {1, 0,4} ×
   `decaimientoFertilidad` ∈ {0, 0,001}). Hay clonado de teselas en cada paso, reordenación, alta y baja
   de chunks, clima y fases variados, y rebrote de tocón comprobado. La comparación es `deepStrictEqual`
   y además `JSON.stringify` igual (orden de claves). `cachedTopologyCount === 0`.
7. **Duplicados** lanzan el mismo error sin tocar teselas; con coordenadas no enteras se vuelve al camino
   de objetos, que está documentado.
8. **Autoridad única**: escribir sin tomar la SoA lanza, cargar con escrituras sin volcar lanza, el doble
   buffer no cambia el frente hasta `swapLife`, `flush` devuelve la autoridad y `discard` deja los objetos
   intactos.
9. **Bytes por tesela** sobre los buffers reales, scratch incluido.
10. **`stepWorld` con `motor.soaTerreno=true` = `false`** (300 pasos, semilla 51926). Un espía cuenta
    las cargas SoA (30 contra 0), que prueba que el parámetro llega al kernel.

Resultados en `0c37f92`:

- `npm run typecheck`: verde.
- `TMPDIR=/datos/tmp-atlas-lab timeout 900 npx tsx --test --test-concurrency=1 tests/soa-terreno.test.ts
  tests/ecosystem-kernel.test.ts tests/kernel-digest.test.ts tests/ecosystem.test.ts
  tests/compute-ecology.test.ts tests/kernel-logistica.test.ts tests/digesto.test.ts tests/params.test.ts`:
  **87/90 pasan, 0 fallan**, 22,9 s. Las 3 omisiones son las paridades CUDA de
  `compute-ecology.test.ts` («COMPUTE_NVRTC absent»), que ya se omitían antes y no tocan esta tarea.
  **No** se corrió `npm test` completo (regla 7).

## Control de digesto: 2 400 pasos, 3 semillas × 2 juegos de parámetros

`npx tsx scripts/lab/digesto-control.ts --seed S --pasos 2400 [--params …]`. La base es una exportación
limpia de `200d284` (`git archive`, `/datos/tmp-atlas-lab/b-base-T112`). La rama es `0c37f92`. Del lado
de la rama se pasó `--sin motor.soaTerreno`: `fisico` es el digesto sin esa opción de ejecución, el
control de paridad que pide T101 para comparar configuraciones de ejecución.

| params | semilla | base `completo` | rama soa=false `completo` | soa=false `fisico` | soa=true `fisico` | nacimientos | población |
|---|---|---|---|---|---|---|---|
| defecto | 7 | `2b6392411920e59b` | `2b6392411920e59b` = | `76b1c2710bbe5edf` | `76b1c2710bbe5edf` = | 0 | 16 |
| defecto | 42 | `fb7036cb898aa9b3` | `fb7036cb898aa9b3` = | `671cc52d6a340f9e` | `671cc52d6a340f9e` = | 5 | 21 |
| defecto | 51926 | `bff69c2fdf0ea2b5` | `bff69c2fdf0ea2b5` = | `8d160744b44febcf` | `8d160744b44febcf` = | 6 | 22 |
| juego 2 | 7 | `ceb05d5b4151eb90` | `ceb05d5b4151eb90` = | `0560b3cccc761cb4` | `0560b3cccc761cb4` = | 0 | 16 |
| juego 2 | 42 | `12ab9b88dd578103` | `12ab9b88dd578103` = | `c565a08b82f2b65f` | `c565a08b82f2b65f` = | 4 | 20 |
| juego 2 | 51926 | `38b08b64eb9d4251` | `38b08b64eb9d4251` = | `dda00ab6e8f28526` | `dda00ab6e8f28526` = | 6 | 22 |

Se comparan los 64 hexadecimales; la tabla muestra 16. Base 200d284 = rama con el default en las 6
trayectorias, y `motor.soaTerreno` true = false en las 6. Nacimientos y población iguales en los tres
lados.

## Cifras

**Bytes por tesela**, medidos con `byteLength` de todo lo reservado: arena con la holgura de crecimiento,
tablas de región y scratch (tesela → celda y recuento de vecinas).

| caso | teselas | B/tesela |
|---|---|---|
| modo kernel, mundo real (51926, 60 pasos) | 2 560 | **20,8** |
| modo kernel, denso (1 024 chunks) | 262 144 | **18,2** |
| todos los campos + doble buffer de `life`, denso | 262 144 | **143,0** |
| ANTES: topología de objetos, una retenida / cuatro retenidas | — | 56 / 224 |

Topologías retenidas: ANTES 1–4, DESPUÉS **0**.

**Coste de `EcosystemKernel.step`, un proceso por lado, alternados.** Son teselas sintéticas de la
semilla 51926. «mismo» es el mismo array en cada pasada, como en el laboratorio; «clon» son objetos
nuevos en cada pasada, como `cloneWorld` en el servidor. Cada celda da la mediana de las p50 y el mínimo,
en ms.

| teselas | régimen | objetos p50 (mín) | SoA p50 (mín) |
|---|---|---|---|
| 65 536 (200 pasadas × 3) | mismo | 2,51 (1,87) | 2,83 (2,36) |
| 65 536 (200 pasadas × 3) | clon | 6,94 (2,57) | 8,48 (3,30) |
| 1 048 576 (20 pasadas × 3) | mismo | 181,2 (110,4) | 228,9 (128,2) |
| 1 048 576 (20 pasadas × 3) | clon | 193,7 (91,1) | 201,0 (124,6) |

La torre estaba compartida (carga media 20–55 en 32 hilos) y la dispersión es grande. Con un solo hilo,
el camino SoA cuesta **lo mismo en orden de magnitud y entre un 15 y un 40 % más en los mínimos**. T112
no promete tiempo: lo que gana es memoria (56–224 → ~18 B/tesela de scratch, cero topologías retenidas)
y la forma que T115 necesita para repartir. La única lectura entre celdas es ahora una pasada sobre
arrays compartibles, sin estructuras de objetos. El script de medida fue efímero
(`/datos/tmp-atlas-lab/t112-ctl/perf*.mts`) y no entra en el repositorio.

## Cierre de la tarea

- Digesto idéntico: **cumplido** (3 semillas × 2 juegos × 2 400 pasos, true = false y base = rama).
- ≤ 256 B/tesela con el scratch dentro: **cumplido** (20,8 en modo kernel real, 143,0 con todos los
  campos en denso).
- Cero topologías retenidas: **cumplido** con `motor.soaTerreno=true`. Con `false` sigue la caché de hoy,
  por diseño (default = comportamiento de hoy). También con coordenadas fuera del dominio entero, que
  ningún mundo válido tiene.
- Una sola autoridad por página, con aserción: **cumplido** en `TileStore` y probado.
- Queda abierto, y no es de esta tarea: el cuerpo de la regla sobre arrays con la autoridad SoA y los
  workers (T115), y quitar la pasada O(T) de asignación tesela → celda (T113/T120). T100 sigue abierto,
  pero no limita este SoA: la arena no tiene tope y el dominio de coordenadas cubre todo `MAX_COORDINATE`.

## ¿Puede el hardware cambiar el resultado?

**No.** El SoA cambia dónde viven la foto de `life` y la presencia, y cómo se encuentran las ocho
vecinas. No cambia ninguna operación de la regla: las mismas operaciones IEEE-754 de doble precisión, por
celda, en un solo hilo. La región, la página y la capacidad de la arena (la memoria del anfitrión) no
entran en ninguna fórmula del mundo. `SharedArrayBuffer` frente a `ArrayBuffer` no altera ningún valor.
Lo único que depende del anfitrión es si hay memoria para reservar, y su falta produce una excepción, no
otro mundo.
