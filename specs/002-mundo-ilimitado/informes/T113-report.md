# T113: `tileAt` por aritmética, `activate` con índice, `maintainRegions` incremental

Rama `sprint/002-b-t113`, base `200d284`. Sin cambio de reglas: `digestoCanonico` idéntico en todos
los controles. **Estado: parcial en una sola cifra.** El índice de teselas desaparece del perfil en
el camino en sitio (laboratorio) y con un gancho de dos líneas en `index.ts` que queda fuera del
alcance de esta tarea (ver «Pendiente»). Sin ese gancho, en los dos caminos del servidor baja un 30 %
pero no desaparece. Las otras tres cifras del cierre se cumplen.

## Qué había ya en el árbol (regla 11)

- **(a) y (d) estaban hechas a medias.** El sprint noche-perf del 2026-09-22 (`f2757fa`) ya había
  sustituido los dos `Map<string, Tile>` (el de `tileAt` en `spatial.ts` y el `terrainIndex` de
  `animals.ts`) por **un solo** índice compartido en `src/world/tile-index.ts`: una rejilla de bloques
  de 16×16 que usan `tileAt`, `stepAnimals`/`syncFauna`, `ecology` y `firstTileAt`. Ya no había
  cadenas por consulta, pero la rejilla se **reconstruía entera** (un `Map.get/set` y un arreglo de
  256 por bloque) cada vez que cambiaba la identidad o la longitud de `world.tiles`. Pasaba en cada
  paso con el clon o con el punto de restauración, y en cada activación o retiro de un chunk en sitio.
  `animals.ts` ya no tiene ningún `terrainIndex` propio: T113 (d) queda resuelta por el mismo índice
  de (a) y **no hizo falta tocar `animals.ts`**.
- **Fichero fuera de la lista: `src/world/tile-index.ts`.** Es donde vive hoy el índice de `tileAt` y
  de la fauna, que se sacó de `spatial.ts` y `animals.ts` después de escribirse la tarea. Tocarlo es
  el alcance (a)+(d), no otro trabajo. Ninguna tarea de la oleada en curso (T111, T112, T114, T116,
  E.0, PERF3) lo toca.
- `(b)` y `(c)` estaban tal como las describe la tarea: `findIndex` sobre `retiredChunks` en
  `activate` y `Object.entries(world.chunks)` en cada tick.
- **Delegación.** Se delegó a `gemini/pro` (effort high, access write) con el texto completo de T113,
  las reglas 1–13 y el estado real del árbol. El MCP abortó a los 1 800 s sin respuesta ni progreso y
  el delegado no dejó cambios. Siguiendo el procedimiento (calidad primero), la implementación, las
  pruebas y las mediciones son del orquestador de la tarea.

## Ficheros tocados

| Fichero | Qué |
|---|---|
| `src/world/tile-index.ts` | Modo «disposición por chunks» con consulta aritmética; ganchos `tileIndexAppended`, `splitTileBlocks`, `tileIndexCopied`; contador de diagnóstico `tileIndexBuilds` |
| `src/world/spatial.ts` | `activate` (índice de la cola y aviso al índice de teselas), `maintainRegions` incremental, `projectTerrain` (misma búsqueda en la cola) |
| `tests/spatial-escala.test.ts` | nuevo: 8 pruebas contra el código de `200d284` copiado como oráculo |

Commits: `57c41d8` (a/d), `a0544a4` (b), `1840315` (c), `586853f` (pruebas), más este informe.

## Qué cambió y por qué

**(a)+(d): teselas por desplazamiento de chunk.** En un mundo real `world.tiles` es la concatenación de
chunks **completos** de 16×16 en orden fila-mayor: `activate` añade los 256 de `generateChunk` de golpe
y `maintainRegions` retira chunks enteros con un recorrido que conserva el orden. Entonces basta
`clave de chunk → posición de su primera tesela`, y la consulta es `tiles[base + ((y&15)<<4 | (x&15))]`.
Verificar esa disposición cuesta dos comparaciones por tesela, sin `Map` por tesela ni arreglo por
bloque. Si un arreglo no la cumple (invertido, incompleto, con un chunk repetido, huecos, coordenadas
no enteras o desalineadas), se usa **exactamente** la rejilla de antes. Las respuestas son las mismas
para toda entrada, incluidos `-0`, `NaN`, `Infinity`, no enteros, fuera de ±2²⁴ y coordenadas que no
son número. Ya no hay que reconstruir en los casos siguientes:

- `activate`: `tileIndexAppended` verifica solo el bloque nuevo (256 teselas) y lo anota.
- `maintainRegions` al retirar: `splitTileBlocks` reparte por bloques (una `chunkKey` por chunk en vez
  de una por tesela) y el arreglo nuevo hereda la disposición en O(chunks).
- Una consulta fijada antes (`tileLookup`, la de la fauna y la de `ecology`) guarda su longitud y, como
  antes, no ve teselas añadidas después.

**(b): cola de retirados por clave.** El índice guarda la primera aparición de cada clave, como
`findIndex`, y va asociado a la identidad y la longitud del arreglo. El `splice` de `activate` y el
`push` de `maintainRegions` lo mantienen. La posición se busca con `lastIndexOf` desde el final,
porque lo que se reanima suele ser lo último retirado; con claves únicas es la misma posición. Si hay
claves repetidas, se vuelve a `findIndex`. Indexar cuesta unas diez veces un `findIndex`, así que el
índice solo se construye con una cola de al menos 64 chunks y a partir de la octava consulta con la
misma identidad. La copia que `cloneWorld` hace en cada paso, que se consulta una o dos veces, sigue
recorriéndose como antes. El orden de la cola, que entra en el digesto, no cambia.

**(c): `maintainRegions` incremental.** Hay un estado asociado a la identidad de `world.chunks` con tres
datos: cuántas celdas del alcance de alguien piden cada clave, qué claves pidió cada habitante en su
última posición, y la secuencia de inserción de cada clave viva. Tras cada llamada, las claves vivas
son exactamente las pedidas. En consecuencia:

- Quien no se movió no cuesta nada: sus claves siguen vivas y `activate` no haría nada.
- Quien se movió activa en el mismo orden de siempre (personas en su orden, desplazamientos −8/0/8) y
  libera sus claves viejas.
- Solo puede sobrar una clave cuyo recuento llegó a cero o que se activó desde la última llamada. Se
  retira en orden de inserción, que es el orden de `Object.entries`.

Un `world.chunks` nuevo (clon, punto de restauración, Store, migración) se relee entero una vez.
**Contrato**, igual que el índice de teselas de antes: fuera de `activate`/`maintainRegions` nadie
añade ni quita claves de un `world.chunks` vivo. En producción solo lo hacen las migraciones y el
Store, y ambos crean un objeto nuevo.

## Cómo se prueba

- `tests/spatial-escala.test.ts` (8 pruebas, verde). El oráculo es `activate`/`maintainRegions` de
  `200d284` copiados en la prueba:
  - Dos mundos (semillas 7 y 51926) siguen el mismo plan de 150 movimientos: pasos cortos, saltos
    entre 12 anclas, bordes del dominio ±10⁷, una coordenada no entera, nacimientos y muertes. En
    cada paso coinciden el orden de `world.chunks` y el de la cola, y cada 75 pasos coincide
    `digestoCanonico`. El control ejerce el cambio: 514 y 551 retiros, 370 y 405 reanimaciones desde
    la cola, y una cola de 146 (indexada).
  - `tileAt` coincide con el `Map` de claves `"x,y"` en 10 000 consultas alrededor de teselas vivas,
    en sitio y tras `cloneWorld` + `stepWorld`, y también en los bordes.
  - Los siete arreglos irregulares caen a la rejilla con las mismas respuestas en `lastTileAt`,
    `tileLookup` y `firstTileAt`.
  - El índice que usa la fauna no se reconstruye al activar ni al retirar un chunk, ni en 150 pasos en
    sitio con activaciones.
  - `splitTileBlocks` reparte igual que el recorrido tesela a tesela.
  - `tileIndexCopied` hereda la disposición de una copia y rechaza lo que no lo es.
  - `activate` con 100 000 chunks retirados (ver cifra 3).
  - `maintainRegions` sobre un `world.chunks` que cuenta las trampas de un `Proxy` (ver cifra 4).
- Módulo: `timeout 900 npx tsx --test --test-concurrency=3` sobre `spatial-escala`,
  `rendimiento-identidad`, `clon-acotado`, `archive`, `projection-failure`, `restauracion-paso`,
  `world`, `animals`, `backup-lazy-archives`, `inventions`, `digesto`, `perfil-fases`, `procedural`,
  `agua`, `limites-anticorrupcion`, `society`, `technology-store-catalogue`, `lifecycle-persistence`,
  `store-persistence` y `snapshot`. Resultado: **233 pruebas, 231 verdes, 2 omitidas** (las dos ya
  exigían `CARTA_TEST_ESCALA=1`), **0 fallos**. `npm run typecheck` verde.

## Cifras

Host compartido: carga 50–55 en 32 hilos durante todas las mediciones. Base y rama se midieron **a la
vez** (mismo mundo, misma carga). Los instrumentos no se versionan; están en
`/datos/tmp-atlas-lab/t113-digestos/` (`caminos.mts`, `perfil.mts`, `bench-regiones.mts`,
`bench-indice.mts`).

### 0. Identidad (puerta)

Los 18 controles de esta sección se repitieron sobre el commit final de código y pruebas (`586853f`,
con el umbral de consultas del índice de la cola ya puesto): **6/6 y 12/12 iguales**, los mismos
digestos que abajo.

`scripts/lab/digesto-control.ts --pasos 2400`, en `200d284` (worktree
`/datos/tmp-atlas-lab/b-base-T113`) y en la rama. «alt» =
`persistencia.cadaTicks=300,social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3`.
La clave `social.memoriaDisputa=8` del encargo **no existe en `200d284`** (`parseParams` la rechaza) y
se quitó, igual que en T114.

| Semilla | Params | Base | Rama | Nacimientos | Población |
|---|---|---|---|---:|---:|
| 7 | def | `2b6392411920e59b…` | `2b6392411920e59b…` | 0 | 16 |
| 42 | def | `fb7036cb898aa9b3…` | `fb7036cb898aa9b3…` | 5 | 21 |
| 51926 | def | `bff69c2fdf0ea2b5…` | `bff69c2fdf0ea2b5…` | 6 | 22 |
| 7 | alt | `ceb05d5b4151eb90…` | `ceb05d5b4151eb90…` | 0 | 16 |
| 42 | alt | `12ab9b88dd578103…` | `12ab9b88dd578103…` | 4 | 20 |
| 51926 | alt | `38b08b64eb9d4251…` | `38b08b64eb9d4251…` | 6 | 22 |

Ese control avanza en sitio. Para cubrir los dos caminos del servidor, `caminos.mts` repite 2 400 pasos
con las mismas semillas y params, con `store.context` y `store.save` cada `persistencia.cadaTicks`:

- **clon**: `cloneWorld` + `stepWorld`.
- **punto**: `puntoDeRestauracion` + `stepWorld` en sitio; cada 97 pasos se restaura y se repite el
  paso.

**12/12 digestos iguales** entre base y rama. Clon y punto también coinciden entre sí.

| Camino | Semilla | Params | Digesto (base = rama) | Activaciones | Retiros | Restauraciones | Reconstrucciones del índice |
|---|---|---|---|---:|---:|---:|---:|
| clon | 7 | def | `5406abe6bb3ceaf2…` | 167 | 133 | 0 | 2 400 |
| clon | 42 | def | `a74f2704b25bbc38…` | 165 | 128 | 0 | 2 400 |
| clon | 51926 | def | `f4fbbbc48cb73840…` | 77 | 64 | 0 | 2 400 |
| clon | 7 | alt | `4463c29bb96939c5…` | 167 | 133 | 0 | 2 400 |
| clon | 42 | alt | `bba58357f1c58fd9…` | 157 | 122 | 0 | 2 400 |
| clon | 51926 | alt | `be9daa2e8b5f545b…` | 80 | 66 | 0 | 2 400 |
| punto | 7 | def | `5406abe6bb3ceaf2…` | 167 | 133 | 24 | 2 424 |
| punto | 42 | def | `a74f2704b25bbc38…` | 165 | 128 | 24 | 2 424 |
| punto | 51926 | def | `f4fbbbc48cb73840…` | 77 | 64 | 24 | 2 424 |
| punto | 7 | alt | `4463c29bb96939c5…` | 167 | 133 | 24 | 2 424 |
| punto | 42 | alt | `bba58357f1c58fd9…` | 157 | 122 | 24 | 2 424 |
| punto | 51926 | alt | `be9daa2e8b5f545b…` | 80 | 66 | 24 | 2 424 |

En sitio (`caminos.mts lab`, 2 400 pasos, tres semillas) el índice se reconstruye **0 veces**, con 77 a
167 activaciones y 64 a 133 retiros por corrida.

Mundo envejecido (`perfil-perf2/s51926-d6`: tick 14 400 → 15 000, 59 habitantes, 28 416 teselas,
111 chunks): mismo digesto `328d360c1ca0d55c…` en base, rama y rama + gancho, por los tres caminos.

### 1 y 2. Perfil de `tileAt` y del índice de la fauna (`terrainIndex`)

Desde noche-perf los dos son **el mismo índice**: lo construye el primer consumidor del paso (en la
práctica `stepAnimals`), así que la cifra se da junta. La medición usa `node --cpu-prof` y
`scripts/perf/cpuprof.ts resumen --raiz pasoServidor`: 600 pasos del mundo envejecido, en ms de CPU
por paso dentro del paso (excluye el guardado). La base mide `indexOf` + `build` de la rejilla; la
rama, `indexOf` + la verificación.

| Camino | Base | Rama | Rama + gancho `tileIndexCopied` (experimento, sin commit) |
|---|---|---|---|
| En sitio (laboratorio) | 0,263 ms = **1,67 %** de 15,77 | 0,013 ms = **0,09 %** de 14,08 (la construcción inicial; 0 en 600 pasos) | igual que la rama |
| Clon (`clonPorPaso=true`, el servidor de hoy) | 2,20 ms = **6,7 %** de 32,75 | 1,51 ms = **4,7 %** de 32,08 | 0,08 ms = **0,16 %** de 52,8 |
| Punto de restauración (`clonPorPaso=false`) | 2,97 ms = **6,65 %** de 44,62 | 2,09 ms = **4,9 %** de 42,88 | 0,10 ms = **0,16 %** de 59,0 |

- En este mundo la base pesa más que el 3,15 % + 2,16 % de la tarea (otro mundo y otro instrumento).
  El orden de magnitud y la causa son los mismos.
- En los caminos del servidor, cada paso trae un `world.tiles` nuevo. Sin el gancho hay que leer `x,y`
  de las 28 416 teselas recién copiadas para verificar la disposición: dos comparaciones por tesela,
  pero con la caché fría. Aislado y con la caché caliente, el primer acceso a una copia de 27 136
  teselas pasa de p50 **0,60 → 0,20 ms** (`bench-indice.mts`, 80 copias). Dentro del paso, con la
  caché fría, pasa de 2,2 a 1,5 ms.
- `maintainRegions` en sitio, en el mismo perfil: **0,551 → 0,223 ms** por paso.

### 3. `activate` es O(1) en el tamaño de la cola

- **Accesos a la cola** (prueba, `Proxy` que cuenta lecturas y escrituras por índice): **0** para
  activar un chunk que no está en la cola y **2** para reanimar el último retirado, **igual con
  R = 1 000 que con R = 100 000**. El resultado es el mismo que con `findIndex`: digesto con
  R = 1 000, orden de la cola con R = 100 000.
- **Tiempo por el camino real** (`bench-regiones.mts`, mediana de 40). Un habitante va a territorio
  nuevo («ida»: 4 chunks generados y 4 retirados) y vuelve («vuelta»: 4 reanimados desde el final de la
  cola y 4 retirados). Cada celda da ida / vuelta en ms:

| R (chunks retirados) | Base | Rama |
|---:|---:|---:|
| 1 000 | 1,85 / 2,79 | 1,72 / 2,31 |
| 10 000 | 2,14 / 2,70 | 2,12 / 2,94 |
| 100 000 | **11,28 / 12,33** | **2,10 / 3,47** |

  Lo que queda en la rama es generar o clonar el chunk y repartir teselas: no depende de R.

### 4. Asignaciones por tick de `maintainRegions`

`node --max-semi-space-size=512 --expose-gc`. Se mide la diferencia de `heapUsed` por llamada en
rondas sin recolección (mediana de 5 rondas de 200 llamadas); el tiempo es por llamada.

| Mundo | Base | Rama |
|---|---|---|
| 30 habitantes / 120 chunks, nadie se mueve | **85 754 B**, 45–78 µs | ≈ 1,6 kB (ruido del instrumento), 1,4–2,8 µs |
| 120 habitantes / 480 chunks, nadie se mueve | **362 696 B**, 179–245 µs | 0,3–5 kB (ruido), 0,9–7 µs |
| 120 / 480, el 10 % se mueve dentro de sus celdas | (recolecta en todas las rondas), 173–273 µs | 19 kB, 14–29 µs: O(los que se mueven) |

En la base, lo asignado crece con los chunks: ×4,2 de 120 a 480. En la rama no. La prueba lo fija con
un contador de trampas sobre `world.chunks`, con 480 chunks vivos:

- En 20 ticks sin movimientos: **0 enumeraciones, 0 lecturas, 0 escrituras**.
- Si uno se mueve dentro de sus celdas: 9 lecturas.
- Al cruzar a celdas nuevas: activaciones y retiros **sin enumerar nunca**.

## Pendiente (fuera del alcance de T113; regla 1)

1. **Gancho de dos líneas en `src/world/index.ts`** (`cloneWorld` y `puntoDeRestauracion`, funciones
   de T103/T104 ya integradas, no de la oleada en curso). Es lo que hace desaparecer el índice del
   perfil en los caminos del servidor (tabla 1–2, última columna):
   ```ts
   // cloneWorld, tras `draft.tiles = world.tiles.map(tile => ({ ...tile }));`
   tileIndexCopied(draft.tiles, world.tiles);
   // puntoDeRestauracion, tras `world.tiles = tiles.map(tile => ({ ...tile }));`
   tileIndexCopied(world.tiles, tiles);
   ```
   `tileIndexCopied` ya está en la rama y probado. Hereda la disposición en O(chunks) y comprueba el
   origen de cada bloque como resguardo. Se midió en un worktree aparte
   (`/datos/tmp-atlas-lab/t113-gancho`): digesto `328d360c…` igual en los dos caminos y 0
   reconstrucciones en 600 pasos. Se propone aplicarlo en el gate B, o antes si el orquestador lo
   autoriza.
2. `syncFauna` (`animals.ts`) conserva su caché de celdas ocupadas asociada a la identidad del arreglo.
   Cuando el arreglo cambia, la reconstruye leyendo `fauna` de todas las teselas: 0,33–0,40 ms por
   paso en el camino con clon. No es el `terrainIndex` ni la selección de T116: queda anotado para la
   tarea que reparta `animals.ts` (no se tocó).
3. Siguen dos recorridos O(R) de la cola fuera de `spatial.ts`: `inventions.ts` hace
   `world.retiredChunks.flatMap(...)` para los ids y planos de estructuras (dos sitios). Son de
   T140/T146.

## ¿Puede el hardware cambiar el resultado?

**No.** El cambio no introduce reparto, hilos, reloj ni lectura del host en `src/world`. Los tres
índices solo deciden **cómo** se encuentra una tesela, un chunk retirado o una clave sobrante, nunca
**cuál**: la tesela es la misma que devolvía el `Map`, el chunk el mismo que devolvía `findIndex`, y el
orden de activación (personas × desplazamientos) y de retiro (inserción) no cambia. Cuando un arreglo
no cumple la disposición, se usa el camino de siempre. Lo único que depende de la máquina son los
tiempos medidos.
