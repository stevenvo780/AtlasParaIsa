# T116: máscara de fauna calculada en el coordinador

Base `200d284` (main). Worktree `/datos/workspaces/personal/AtlasParaIsa-n-B-t116`, rama
`sprint/002-b-t116`. Commits: `14d84b3` (máscara), `ad5c0c1` (comprobar el orden antes de
ordenar) y `06255f1` (certificado de orden entre pasos).

La primera versión (máscara, `seleccionDe`, gateo, comentario de `move` y cuatro tests) la
implementó **grok/grok-4.6** (esfuerzo alto; mediante `delegar_a_cloud`, 397 s) sobre un diseño
cerrado por el orquestador (Claude Opus 5.5). El orquestador revisó el diff línea a línea y lo
aceptó sin cambios de lógica. Después reforzó los tests: gateo, muertes, depredación y
nacimientos obligatorios, e invariante de orden. También añadió `ordenCanonico` y su certificado:
sin ellos la cifra de cierre no se cumplía (5,6 % del paso). Hizo además los controles y este
informe.

## Localización (regla 11) y solapamientos (regla 12)

- La cita `animals.ts:285-289` es de `f30d528`. En `200d284`, la selección vivía en `stepAnimals`
  (`animals.ts:325-330`): `world.animals.sort(canonical)`, la ventana con el módulo de la población
  global y el `Set` `selectedIds`. El cierre del paso volvía a ordenar en `:366`. Nada de T116
  estaba hecho.
- `move` está en `animals.ts:215` y su bucle en `:346`, no en `:186,191-195`.
- T113 declara `animals.ts` «solo `terrainIndex`», pero esa función ya no existe: PERF2 la sustituyó
  por `tileLookup` de `tile-index.ts`. T116 no comparte ninguna función con T113, T141, T142, T143
  ni PERF3. `src/world/index.ts` no se toca.

## Qué cambió y por qué

Solo `src/world/animals.ts` y `tests/fauna-mascara.test.ts` (nuevo). En `animals.ts` cambian la
selección, el gateo y el orden canónico que la selección exige al empezar y al cerrar el paso, y se
añade el comentario de `move`.

- **`mascaraFauna(world): MascaraFauna`** es la función del coordinador. Deja la fauna en orden
  canónico y toma la ventana con el módulo de la población **global**, con las mismas expresiones
  de antes (la ventana conserva su `.sort(canonical)`). Devuelve un objeto congelado: `tick`,
  `animales` (identidad del arreglo), `poblacion`, `seleccion` (congelada, en orden canónico) e `ids`.
- **`seleccionDe(mascara, animales)`** reparte la máscara a una región. Devuelve los animales de esa
  región que la máscara selecciona, consultando solo la pertenencia global. No hay ventana ni offset
  por región, y ninguna constante de partición entra en `animals.ts`: la región la define quien llama.
- **`stepAnimals(world, emit?, mascara?)`** acepta la máscara del coordinador. Si no la recibe, la
  calcula después del `throw` de admisión, en el mismo punto que antes. Si recibe una máscara de otro
  paso, lanza `Máscara de fauna de otro paso.`. Cuenta como de otro paso si cambian el `tick`, el
  arreglo o la población, o si el arreglo ya no conserva el orden certificado. El gateo de
  `physiology` (`ids.has`) y la lista `active` (`seleccion`) leen la máscara.
- **`move`** queda documentado como cadena secuencial. Cada movimiento libera y ocupa celdas en
  `state.counts`/`state.occupants`, y el siguiente movimiento lee ese cupo: liberar una celda
  habilita la entrada de otro. Por eso permanece en la fase serial, y repartirlo por región
  cambiaría quién entra.
- **`ordenCanonico(animals, desde = 0)`** sustituye a los dos `world.animals.sort(canonical)` de
  cada paso. Da el mismo resultado:
  - **Certificado.** Cuando el paso deja la fauna en orden, guarda en un `WeakMap` la copia de sus
    elementos. Si al empezar el paso siguiente el arreglo conserva esos mismos elementos en ese orden,
    sigue en orden. Verlo compara punteros sin leer ningún animal. La premisa es que un `id` no se
    reasigna nunca: en `src/` solo se reasignan ids de productos (`technology.ts`), jamás de animales.
    Cualquier cambio en sitio (invertir, intercambiar, reemplazar o crecer, que es lo que hace
    `activate`) pierde el certificado.
  - **Comprobación.** Sin certificado, un `<` por par. Un arreglo en orden es un punto fijo del
    `sort` estable. Si algún par falla (desorden o ids repetidos), se ordena con el `sort` de siempre.
  - **Cierre.** Filtrar conserva el orden de la máscara, así que solo las crías, añadidas al final,
    pueden quedar fuera de sitio: se comprueban desde `previos` y, si algún par falla, se ordena todo.

El coordinador del mundo (`stepWorld` en `index.ts`) sigue llamando `stepAnimals(world, emit)`, y
la máscara se calcula una sola vez por paso dentro de esa llamada. El único consumidor de
`seleccionDe` son los tests. Cuando exista la fase por regiones (T115), `stepWorld` pasará la máscara.
Ese cableado queda para el gate: `index.ts` no es de esta tarea y lo está reescribiendo T141.

## Cómo se prueba

`tests/fauna-mascara.test.ts`, 7 tests:

1. La máscara coincide con la ventana de hoy en los ticks 0..999 y con tres poblaciones: 5 000,
   `MAX_ACTIVE_ANIMALS + 1` y `3·MAX_ACTIVE_ANIMALS + 7`. La fórmula de `200d284` está copiada en el
   test. Parte de fauna invertida, así que ejerce también el `sort`.
2. Repartida entre 1 y 8 particiones espaciales, la máscara da regiones disjuntas. La unión es,
   objeto a objeto y en el mismo orden, la selección global, y la pertenencia de cada animal no
   depende de P. Control negativo: una ventana con offset **por región** da otra selección.
3. El gateo de fisiología sigue a la máscara: en el mismo tick, el único animal fuera de la ventana
   no muere y otro al borde de la muerte dentro de ella sí.
4. 60 pasos con 8 193 animales y la ventana rotando, con muertes por fisiología, depredación y
   nacimientos (se afirma que ocurren). Pasando la máscara reconstruida desde 1..8 particiones
   (P varía por tick), el mundo y los eventos coinciden en `JSON.stringify` con la llamada sin máscara.
   Además, al final de cada paso la fauna coincide objeto a objeto con su `sort(canonical)`, que es
   lo que dejaba el cierre de antes.
5. El orden rápido da el mismo arreglo, objeto a objeto, que `sort(canonical)` con fauna ordenada,
   invertida, casi ordenada y con ids repetidos (estabilidad).
6. Una fauna reordenada en sitio entre pasos (invertida, con dos elementos intercambiados o con
   elementos reemplazados, sin cambiar de longitud) da mundo y eventos idénticos a un control
   recién clonado.
7. Se rechaza una máscara de otro tick, de otro arreglo o de fauna reordenada en sitio.

Los tests muerden:

- un certificado que no compara punteros hace fallar los tests 6 y 7;
- un cierre que no ordena a las crías hace fallar el test 4.

Resultados en `06255f1`:

- `npm run typecheck`: verde.
- `timeout 900 npx tsx --test --test-concurrency=3 tests/fauna-mascara.test.ts tests/animals.test.ts
  tests/body.test.ts tests/limites-anticorrupcion.test.ts tests/archive.test.ts tests/digesto.test.ts`:
  **79 tests, 78 pass, 0 fail, 1 skip** (el de escala de T100, que exige `CARTA_TEST_ESCALA=1`), 10,9 s.

## Control de digesto (regla 5)

La tabla compara `scripts/lab/digesto-control.ts --seed S --pasos 2400` (campo `completo` =
`digestoCanonico`) en un worktree de `200d284` (`/datos/tmp-atlas-lab/b-base-T116`) y en la rama
(`06255f1`, repetido también en `ad5c0c1`). Se usaron dos juegos de parámetros:

- **defecto**: sin `--params`;
- **p2**: `persistencia.cadaTicks=300,social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3`.

| semilla | juego | digesto (200d284 = rama) |
|---|---|---|
| 7 | defecto | `2b6392411920e59bc7ac095f3a9e5fd7dda6771406524aff71048c7f9304b5d3` |
| 7 | p2 | `ceb05d5b4151eb90a9fbe605d093d1af637b44221bde47f820170d700bafd413` |
| 42 | defecto | `fb7036cb898aa9b340393c94b164dc8a08477bd9aa4ecd7ebd9ab2f63325543d` |
| 42 | p2 | `12ab9b88dd578103c584aa074e4cfad0b6cc65b9a79e76c5866ff0fc8d5520fc` |
| 51926 | defecto | `bff69c2fdf0ea2b522e284eef760c949c19a98b6eb0ac970f00971e9cc150a5f` |
| 51926 | p2 | `38b08b64eb9d4251a954908c0cb1dff68aec437ce638760fadcd54740fe530bb` |

**Seis de seis idénticos.** El juego de parámetros pedido incluía `social.memoriaDisputa=8`, que no
existe en `200d284`: `parseParams` lanza `Parámetro desconocido` tanto en la base como en la rama.
Por eso el juego p2 no lleva esa clave.

**Estos seis controles no ejercen la ventana.** A 2 400 pasos, la fauna de los mundos por defecto
va de 15 a 645 animales, muy por debajo de `MAX_ACTIVE_ANIMALS = 8192`, así que la selección es
siempre «todos». Por eso hay un segundo control con **fauna densa**. Parte de `createWorld(S)`,
siembra `min(6, ⌈16000/teselas⌉)` animales por tesela, con especies deterministas por coordenada
(herbívoros, lobos, zorros y peces), y recorre 2 400 pasos de `stepWorld`. Se compara
`digestoCanonico` a 1 200 y 2 400 pasos entre `200d284` y la rama:

| semilla | fauna mín–máx | pasos con la ventana rotando | nacimientos / muertes / depredaciones | digesto 1 200 | digesto 2 400 |
|---|---|---|---|---|---|
| 7 | 5 308–9 347 | 1 326 | 136 / 2 389 / 1 478 | `f55426162a23ec17…` = | `e3dd84d3873f7a95…` = |
| 42 | 4 057–9 217 | 744 | 4 / 4 456 / 1 093 | `7353650c681d9f5a…` = | `172ab909c2a36d19…` = |
| 51926 | 6 229–9 262 | 1 272 | 20 / 2 233 / 881 | `420808918c12e00b…` = | `81a3a2ed664d0c30…` = |

**Seis de seis idénticos** (el script está en `/datos/tmp-atlas-lab/t116-scratch/fauna-densa-control.mts`).

La medida de coste de abajo es un tercer control. Ejecuta el `stepAnimals` de `200d284` y el de la
rama en el mismo proceso, sobre mundos idénticos de 10⁵ animales. Tras 80 pasos sin cría y 40 con
cría (34 907 nacimientos, hasta 134 907 animales), los dos mundos son iguales en `JSON.stringify`.

## Cifras de cierre

La torre estaba compartida (carga 11–27 en 32 hilos) y node corre en clase idle (ananicy). Las
medidas se tomaron en un mismo proceso, con ticks intercalados entre `200d284` y la rama, fauna de
10⁵ animales en 50 176 teselas y 5 especies. Cada medida es el **primer** recorrido de la fauna en
su tick, con la caché fría como dentro del paso. Se dan medianas de pared, y la media de CPU del hilo
coincide dentro del 5 %. Script: `/datos/tmp-atlas-lab/t116-scratch/medida-cierre.mts`.

| 10⁵ animales, sin cría, 80 ticks | 200d284 | rama `06255f1` |
|---|---|---|
| paso de fauna (`stepAnimals`) | 126,5 ms | **117,0 ms** (−7,5 %) |
| orden canónico de la selección | `sort` 7,10 ms = **5,6 %** del paso | certificado 0,80 ms* = **0,62–0,68 %** del paso |
| selección / máscara completa (orden + ventana + ids) | 8,73 ms = 6,9 % | 1,93 ms = 1,65 % |

\* Medido en una corrida aparte (desglose). El desglose de la máscara con la caché fría es: orden 0,80 ms, ventana (slices y `sort` de 8 192)
0,72 ms, `Set` de ids 0,41 ms. Salen de un paso de 129,2 ms y de una copia de medida que exporta
`ordenCanonico`, fuera del repo (`desglose-mascara.mts`).

Con cría (40 ticks, 34 907 nacimientos): el `sort` de antes cuesta 14,2 ms (5,3 % de 270 ms) y la
máscara 3,3 ms (1,3 % de 258 ms). Con nacimientos, el cierre del paso cae casi siempre en el `sort`
completo, como antes: el id de una cría nueva (`…-100-…`) queda antes que el de una de otro tick
(`…-99-…`).

El `sort` O(A log A) de verdad solo ocurre si el orden se pierde entero, y cuesta 112–118 ms con
10⁵ ids barajados en `200d284` (tan caro como el paso de fauna). Una activación de chunk solo añade
una cola al final. En el estado estable del paso, la ordenación pasa a ser O(A) comparaciones de
punteros.

**Cierre: se cumple** `≤ 1 %` del paso a 10⁵ animales para el orden de la selección: 0,62–0,68 % del
paso de fauna, y menos aún del paso completo del mundo, que lo contiene. El digesto es idéntico en
3 semillas × 2 juegos × 2 400 pasos, más 3 semillas con la ventana rotando.

## ¿Puede el hardware cambiar el resultado?

**No.** La máscara depende solo de `world.tick`, de la población global y del orden canónico por
`id`. Ningún número de hilos, partición, reloj ni medida de capacidad entra en ella, y el reparto
a regiones (`seleccionDe`) solo consulta la pertenencia. El test 2 demuestra que 1..8 particiones
dan la misma selección. `ordenCanonico` tampoco depende del hardware: el certificado y la
comprobación solo deciden si hace falta el `sort`, y en ambos casos el arreglo resultante es el mismo.

## Pendiente y hallazgos para el gate B

- **Cableado.** `stepWorld` debe calcular `mascaraFauna` en el coordinador y pasarla cuando T115
  reparta la fase de fauna. Hasta entonces, la llamada interna es la misma y equivalente.
- **Gateo de `physiology`.** Consulta `ids.has` para **todos** los animales, ~4,3 ms en caliente a
  10⁵ (medido aparte). Es un coste que ya existía y no está en la cifra de cierre. Un mapa de bits
  por índice canónico costaría ~0,04 ms y se podría compartir con workers (`SharedArrayBuffer`),
  cosa que un `Set<string>` no permite. Se propone para T115. No se hace aquí: solo equivale a
  `ids.has` si los ids son únicos, y esa garantía la da la carga (`assertAnimals`), no el paso.
- **Cierre con cría.** Si hay nacimientos, el orden canónico del cierre cae en el `sort` completo
  (ver arriba). Una mezcla por inserción binaria de las crías lo dejaría en O(k log A).
- **Servidor con `motor.clonPorPaso=true`** (el default). Cada paso simula sobre un clon, cuyo
  arreglo de fauna no está certificado. Allí manda la comprobación por pares, más barata que el
  `sort` pero O(A) lecturas de animales. El certificado rinde en el laboratorio y con
  `clonPorPaso=false` (T104).
