# T116: máscara de fauna calculada en el coordinador

Base `200d284` (main). Worktree `/datos/workspaces/personal/AtlasParaIsa-n-B-t116`, rama
`sprint/002-b-t116`. Commits:

- primera vuelta: `14d84b3` (máscara), `ad5c0c1` (comprobar el orden antes de ordenar), `06255f1`
  (certificado de orden entre pasos) y `e9eadbe` (informe);
- segunda vuelta, tras la verificación: `b37dab3` (ventana sin reordenar), `67c717f` (crías
  mezcladas, fauna clonada reconocida por id), `893fda9` (certificado privado y recorrido acotado) y
  `8156a29` (ids del cierre sacados del certificado).

La primera versión la implementó **grok/grok-4.6** (esfuerzo alto, `delegar_a_cloud`) sobre un diseño
del orquestador (Claude Opus 5.5), que la revisó línea a línea. La segunda vuelta la hizo el
orquestador. Una revisión adversarial de **codex/gpt-5.6-sol** (esfuerzo xhigh, solo lectura) sobre
`67c717f` encontró dos defectos, corregidos en `893fda9`.

## Segunda vuelta: qué dijo la verificación y qué se hizo

La verificación rechazó el cierre «≤ 1 % del paso a 10⁵ animales» por tres motivos. Los tres se
reprodujeron.

| Hallazgo | ¿Real? | Corrección | Resultado (mismas medidas que el verificador) |
|---|---|---|---|
| (a) El 0,80 ms del informe medía solo el orden al empezar; faltaba el cierre (0,21 ms) | Sí | Todas las cifras de abajo suman inicio + cierre | Persistente sin cría: 0,62–0,70 % (el verificador midió 0,83–0,93 % en `06255f1`) |
| (b) Con crías, el cierre caía en el `sort` completo | Sí: 11,6 ms de mediana | Las crías se ordenan aparte y se mezclan galopando (`mezclar`) | Cierre de 11,6 ms a 0,36–0,47 ms; total 0,80–0,91 % (antes 4,2–5,7 %) |
| (c) Con `motor.clonPorPaso=true` (el default del servidor) mandaba la comprobación por pares, sin medir | Sí: 9,5–14,2 ms | El certificado reconoce la fauna clonada por sus ids, que `cloneWorld` comparte | 3,2–3,8 % sin cría y 4,0 % con cría (antes 4,1–4,4 % y ~10–12 %). **No llega al 1 %**: ver «Cifras» |

La revisión de codex encontró otros dos defectos:

1. `mascaraFauna` entregaba en `orden` el arreglo del propio certificado, sin congelar. Invertirlo
   con `Array.prototype.reverse.call` hacía pasar por ordenada una fauna invertida y dejaba pasar una
   máscara de otro orden. **Corregido**: la máscara exportada lleva una copia congelada, y la interna
   de `stepAnimals` no sale del paso.
2. El recorrido podía saltar por todo el certificado de un mundo anterior. Si un mundo de 1 animal
   alterna con uno de 200 000, el pequeño tardaba 1,04 ms por paso. **Corregido**: los saltos no
   pasan de la población actual; ahora tarda 0,008 ms.

Codex no halló más divergencias en 100 000 mutaciones aleatorias, 109 220 transiciones con ids
repetidos, referencias duplicadas y clones, y 80 ventanas grandes, todas comparadas con el `sort`
estable.

## Localización (regla 11) y solapamientos (regla 12)

- La cita `animals.ts:285-289` es de `f30d528`. En `200d284`, la selección vivía en `stepAnimals`:
  `world.animals.sort(canonical)`, la ventana con el módulo de la población global y el `Set`
  `selectedIds`. El cierre del paso volvía a ordenar. Nada de T116 estaba hecho.
- `move` (`function move`) no está en `:186,191-195`; su bucle es el `for … move(animal, world, state)`
  de `stepAnimals`.
- T113 declara `animals.ts` «solo `terrainIndex`», pero esa función ya no existe (PERF2 la sustituyó
  por `tileLookup`). T116 no comparte ninguna función con T113, T141, T142, T143 ni PERF3.
  `src/world/index.ts` no se toca.

## Qué cambió y por qué

Solo `src/world/animals.ts` (selección, gateo y el orden canónico que la selección exige) y
`tests/fauna-mascara.test.ts` (nuevo).

- **`mascaraFauna(world)`** es la función del coordinador. Deja la fauna en orden canónico y toma la
  ventana con el módulo de la población **global**. Devuelve un objeto congelado con `tick`,
  `animales` (identidad del arreglo), `poblacion`, `orden` (copia congelada de la fauna en orden),
  `seleccion` e `ids`. `stepAnimals` usa la misma función sin exportar la copia (`calcularMascara`).
- **Ventana sin `sort`**. Los dos tramos de la ventana ya están en orden. Si la vuelta queda
  entera por delante (último id de la vuelta `<` primer id del tramo), se concatenan. Si hay ids
  repetidos entre los tramos, decide el `sort` de siempre, que es estable.
- **`seleccionDe(mascara, animales)`** reparte la máscara a una región consultando solo la
  pertenencia global. No hay ventana ni offset por región.
- **`stepAnimals(world, emit?, mascara?)`** acepta la máscara del coordinador. Lanza `Máscara de
  fauna de otro paso.` si cambian el `tick`, el arreglo o la población, o si el arreglo ya no está
  en el `orden` de la máscara. El gateo de `physiology` (`ids.has`) y la lista `active`
  (`seleccion`) leen la máscara.
- **`move`** queda documentado como cadena secuencial: liberar una celda habilita la entrada de
  otro, así que permanece en la fase serial.
- **`ordenCanonico(animals, desde)`** sustituye a los dos `sort(canonical)` de cada paso. Deja el
  mismo arreglo, objeto a objeto:
  - **Certificado** (`certificado`, un único hueco del módulo). Guarda la fauna tal como quedó en
    orden y, si el mundo se clona entre pasos, también sus ids. Al empezar el paso,
    `prefijoCertificado` busca hasta dónde la fauna es, en orden, una **subsecuencia** del
    certificado, reconociendo cada animal por su objeto (se comparan punteros, sin leer animales) o
    por su id (en el clon, que comparte las cadenas). Lo que otro código hace entre pasos es quitar
    (caza, chunk retirado) o añadir al final (chunk activado), y la subsecuencia de una secuencia
    ordenada sigue en orden. Los saltos están acotados por la población actual. Es solo una caché:
    decide qué parte hay que comprobar, nunca qué arreglo sale. Si el hueco lo ocupa otro mundo,
    se comprueba por pares.
  - **Pares y cola**. Desde donde llega el certificado se recorren los pares con `<` hasta el
    primer desorden. Lo que queda (crías, un chunk recién activado, o todo si se perdió el orden) se
    ordena aparte y se mezcla (`mezclar`).
  - **`mezclar`**: cada elemento de la cola va detrás de los de delante con su mismo id, así que el
    resultado es el del `sort` estable. El sitio se busca galopando hacia atrás desde el anterior. Las
    crías de un paso comparten prefijo de id (`animal-born-S-T-`) y caen juntas, así que casi todas
    cuestan una comparación: O(k log A) comparaciones y A movimientos de punteros.
  - **Cierre**. Un paso sin crías no hace nada: lo que queda es una subsecuencia de lo certificado.
    Con crías se mezclan y se certifica. En modo clon, los ids del cierre salen del certificado
    emparejando punteros (`idsSinLeer`), y solo se leen los de las crías.
  - El certificado **no se congela**: leer un arreglo congelado en el recorrido cuesta 3,6 veces más
    (0,33 frente a 0,09 ms en 10⁵).
  - La premisa es la de la primera vuelta: un `id` de animal no se reasigna nunca. En `src/` no hay
    ninguna asignación a `animal.id`. El modo por ids no la necesita.

El coordinador (`stepWorld`, en `index.ts`) sigue llamando `stepAnimals(world, emit)`, y la máscara se
calcula una sola vez por paso dentro de esa llamada. El cableado de `mascaraFauna` → regiones queda para
el gate B con T115.

## Cómo se prueba

`tests/fauna-mascara.test.ts`, 12 tests:

1. La máscara coincide con la ventana de `200d284` en los ticks 0..999 y con 3 poblaciones (5 000,
   `MAX_ACTIVE_ANIMALS + 1`, `3·MAX_ACTIVE_ANIMALS + 7`).
2. Repartida entre 1 y 8 particiones da la misma selección, objeto a objeto. Control negativo: un
   offset por región da otra.
3. El gateo de fisiología sigue a la máscara.
4. 60 pasos con muertes, depredación y nacimientos, pasando la máscara reconstruida desde 1..8
   particiones, dan mundo y eventos idénticos. Al final de cada paso, la fauna es su `sort`.
5. El orden rápido da lo mismo que `sort` con fauna ordenada, invertida, casi ordenada y con ids
   repetidos.
6. **Nuevo.** 600 rondas deterministas (generador LCG) de quitar, añadir al final, repetir ids,
   intercambiar, invertir, mover tramos invertidos y clonar (con cadenas compartidas y nuevas), cada
   una comparada objeto a objeto con `sort`.
7. **Nuevo.** Una ventana que da la vuelta con 8 193 animales del mismo id coincide objeto a objeto
   con la de `200d284`.
8. **Nuevo.** 40 pasos clonando el mundo en cada paso (el clon de `cloneWorld`, que comparte
   cadenas) o alternando con otro mundo que ocupa el hueco del certificado dan mundo y eventos
   idénticos al mundo persistente.
9. **Nuevo.** 40 pasos con crías y el mundo clonado en cada paso, con vecinos intercambiados o tramos
   invertidos entre paso y paso, dan lo mismo que un control que ordena con `sort` antes de cada paso.
10. Una fauna reordenada en sitio entre pasos da lo mismo que un control ordenado con `sort`. El
    control ya no se deja en manos del certificado, porque con un único hueco podía engañarse igual.
11. Se rechazan máscaras de otro tick, de otro arreglo o de fauna reordenada.
12. **Nuevo.** El `orden` de la máscara está congelado: tocarlo lanza `TypeError`, y ni la validación
    ni el paso siguiente se dejan engañar. Es el caso de codex.

**Mutantes** (sobre `8156a29`; `/datos/tmp-atlas-lab/t116-fix/mutantes-8156a29.txt`). Los ocho
rompen la suite; entre paréntesis, cuántos tests fallan:

- mezcla con cota inferior, que pone las crías delante de sus iguales (3);
- atajo de la ventana con `<=` (1);
- certificado que no compara objetos (6);
- modo por ids que no compara ids (5);
- búsqueda que se salta una posición (2);
- cierre sin mezcla (7);
- máscara que no valida el orden (2);
- máscara que entrega el certificado (1).

`idsSinLeer` (`8156a29`) no tiene mutante propio. Cada id que produce va atado por puntero a su
objeto. Un id equivocado en el certificado solo puede hacer que el recorrido siguiente no reconozca
la fauna y compruebe por pares; no puede dar por ordenada una fauna desordenada, salvo que el error
fuese justo la permutación que se aplique. El test 9 cubre ese camino.

Resultados en `8156a29`:

- `npm run typecheck`: verde.
- `timeout 900 npx tsx --test --test-concurrency=3` con `fauna-mascara`, `animals`, `body`,
  `limites-anticorrupcion`, `archive`, `digesto`, `chronicle-store`, `survival-audit` y `society`:
  **132 tests: 131 pass, 0 fail, 1 skip** (el de escala de T100, que exige `CARTA_TEST_ESCALA=1`),
  30,8 s. No se ejecutó `npm test` completo.

## Control de digesto (regla 5)

`scripts/lab/digesto-control.ts --seed S --pasos 2400` (campo `completo` = `digestoCanonico`) en un
worktree de `200d284` (`/datos/tmp-atlas-lab/b-base-T116`) y en la rama. Se hizo en `67c717f`,
`893fda9` y `8156a29`, siempre 6 de 6 iguales. Juegos: **defecto** y **p2** =
`persistencia.cadaTicks=300,social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3`.
El juego pedido llevaba además `social.memoriaDisputa=8`, pero esa clave no existe en `200d284`:
`parseParams` lanza `Parámetro desconocido` en la base y en la rama (comprobado otra vez).

| semilla | juego | digesto (200d284 = 8156a29) |
|---|---|---|
| 7 | defecto | `2b6392411920e59bc7ac095f3a9e5fd7dda6771406524aff71048c7f9304b5d3` |
| 7 | p2 | `ceb05d5b4151eb90a9fbe605d093d1af637b44221bde47f820170d700bafd413` |
| 42 | defecto | `fb7036cb898aa9b340393c94b164dc8a08477bd9aa4ecd7ebd9ab2f63325543d` |
| 42 | p2 | `12ab9b88dd578103c584aa074e4cfad0b6cc65b9a79e76c5866ff0fc8d5520fc` |
| 51926 | defecto | `bff69c2fdf0ea2b522e284eef760c949c19a98b6eb0ac970f00971e9cc150a5f` |
| 51926 | p2 | `38b08b64eb9d4251a954908c0cb1dff68aec437ce638760fadcd54740fe530bb` |

Esos mundos se quedan en 15–645 animales y no ejercen la ventana (`MAX_ACTIVE_ANIMALS = 8192`). Por
eso hay otro control, con **fauna densa**. Siembra `createWorld(S)` de forma determinista
(`/datos/tmp-atlas-lab/t116-fix/densa.mts`) y avanza 2 400 pasos de `stepWorld` por dos caminos:

- en sitio;
- **clonando con `cloneWorld` antes de cada paso**, como el servidor con `motor.clonPorPaso=true`.

Se compara `digestoCanonico` a 1 200 y 2 400 pasos. `200d284`, `67c717f`, `893fda9` y `8156a29`
dan los mismos digestos por los dos caminos: 30 corridas de la rama (18 del árbol y 12 de la copia
instrumentada) y 6 de la base.

| semilla | fauna mín–máx | pasos con la ventana rotando | nacimientos / muertes / depredaciones | digesto 1 200 | digesto 2 400 |
|---|---|---|---|---|---|
| 7 | 5 308–9 347 | 1 326 | 136 / 2 389 / 1 478 | `f55426162a23ec17…` | `e3dd84d3873f7a95…` |
| 42 | 4 057–9 217 | 744 | 4 / 4 456 / 1 093 | `7353650c681d9f5a…` | `172ab909c2a36d19…` |
| 51926 | 6 229–9 262 | 1 272 | 20 / 2 233 / 881 | `420808918c12e00b…` | `81a3a2ed664d0c30…` |

En esos mundos, la copia instrumentada cuenta por dónde pasa el orden en 2 400 pasos:

- **Inicio, en sitio**: certificado exacto en 1 143–1 530 pasos; subsecuencia sin mezcla (tras
  muertes o cazas) en 838–1 204; y cola mezclada (chunk activado) en 32–53, con 90–317 animales de
  mediana y 1 539 como máximo.
- **Inicio, en clon**: reconocido por ids en 2 347–2 368 pasos; el resto, con cola mezclada.
- **Cierre**: mezcla en 3–77 pasos, con una cría de mediana.

El `sort` de toda la fauna no se ejecutó ni una vez. El verificador había contado en `06255f1`
0–126 cierres y 123–169 inicios que caían en él.

## Cifras de cierre

Las condiciones de medida:

- 10⁵ animales en 50 176 teselas y 5 especies, el mismo arnés que el verificador;
- «paso» es `stepAnimals`, el paso de fauna, que es el denominador más estricto;
- «orden» es inicio + cierre, medidos dentro del paso con `performance.now()` en copias
  instrumentadas fuera del repo (`/datos/tmp-atlas-lab/t116-fix/instr-*`);
- la torre estaba compartida: carga de 15 a 55 en 32 hilos, y node en clase idle por ananicy.

Dos métodos:

- **V (el del verificador)**: una variante por proceso, 60 ticks sin cría y 40 con cría, dos
  repeticiones (`medida.mts`).
- **P (pareado)**: `200d284`, `06255f1`, la rama y una variante que se fía del orden sin comprobar
  (`sincomp`) en el mismo proceso, con `gc()` antes de cada paso y el orden rotado por tick
  (`compara.mts`). En modo clon, cada variante clona justo antes de su paso. Una primera versión
  clonaba las cuatro antes de ningún paso y favorecía a la última en caché; esas corridas se
  descartan. Se da la mediana del % por tick y su IC 95 % por bootstrap.

**Orden canónico / paso de fauna (inicio + cierre)**

| Régimen | `200d284` (`sort` ×2), P | `06255f1` (1.ª vuelta), P | rama, V | rama, P |
|---|---|---|---|---|
| Persistente, sin cría | 11,1–11,8 % | 0,92–0,95 % | **0,62–0,70 %** | **0,86 %** [0,80; 0,93] y 0,92 % [0,81; 1,00] |
| Persistente, con cría (27 de 35 ticks con nacimientos) | 10,9–11,7 % | 4,6–4,8 % | **0,80–0,91 %** | **1,06 %** [0,98; 1,15] y 0,90 % [0,78; 0,96] |
| Clon por paso, sin cría | 17,8 % | 4,9 % | 3,2–3,8 % | 2,9 % [2,7; 3,1] |
| Clon por paso, con cría | 16,4 % | 11,3 % | 5,0–5,6 %¹ | 4,0 % [3,9; 4,3] (`8156a29`) |

¹ Medido en `893fda9`, antes de `idsSinLeer`: el cierre con crías costaba 6,4–10,1 ms y ahora cuesta
2,0 ms (P, frente a 7,6 ms en el mismo proceso).

Milisegundos típicos (V): el inicio en sitio cuesta 1,15–1,94 ms y el cierre con crías 0,36–0,47 ms.
En modo clon, el inicio cuesta 9,1–17,7 ms.

**Coste marginal**: cuánto más tarda el paso por comprobar el orden. Se midió de dos maneras.

1. **P**, frente a `sincomp` en el mismo proceso, en la ventana que va del inicio del paso al final
   del gateo:
   - persistente sin cría: −2,3 ms, IC 95 % [−6,8; −0,1]. Con este ruido no se ve ningún coste
     positivo;
   - clon sin cría: +16,4 ms, IC 95 % [+8,5; +33,2], con la torre a carga 28.

   Con esa dispersión (varios ms), este método no basta para afirmar un 1 %.
2. **Suelo** (`suelo.mts`), más controlado. Al mismo estado frío se llega por dos órdenes: tocar la
   fauna (leer `x`, `y` e `id` de cada animal, lo que lee el gateo) y luego recorrer, o recorrer y
   luego tocar. Marginal = recorrer en frío + tocar después − tocar en frío. En modo clon, cada orden
   usa su propio clon, hecho justo antes con `gc()`, y es pareado por tick (con IC 95 %). En sitio,
   los dos órdenes se alternan por tick y el marginal se calcula con medianas, sin IC. Carga 13–16,
   60 ticks sin cría y 40 con cría:

| Régimen | tocar en frío | recorrer en frío | recorrer tras tocar | **marginal** |
|---|---|---|---|---|
| Persistente, sin cría | 2,39 ms | 1,20 ms | 0,96 ms | **1,06 ms = 0,72 %** |
| Persistente, con cría | 4,47 ms | 2,06 ms | 0,91 ms | **1,22 ms = 0,68 %** |
| Clon, sin cría | 17,4 ms | 7,5 ms | 5,2 ms | **5,3 ms = 2,4 %** [2,0; 2,8] |
| Clon, con cría | 22,2 ms | 9,6 ms | 5,6 ms | **5,7 ms = 2,1 %** [1,4; 2,9] |

En modo clon, el recorrido cuesta ~5 ms aunque la fauna se acabe de tocar. Un bucle que solo lee
`animal.id` y lo compara cuesta lo mismo (4,3 frente a 4,8 ms; `micro8.mts`), y tocar la fauna por
segunda vez sigue costando 13,8 ms. Es decir: en esta torre cargada, 10⁵ objetos recién clonados no
se quedan en caché, y leer la cabecera de cada uno es el suelo. Un atajo que compara los ids en un
bucle cerrado no lo bajó (5,4 frente a 5,3 ms) y se descartó.

**Qué se cumple del cierre** «coste del sort medido (O(A log A), ≤ 1 % del paso a 10⁵ animales)»:

- El `sort` O(A log A) está medido: en `200d284` son dos por paso, el 11–18 % del paso de fauna. En
  la rama ya no se ejecuta en régimen estable. Solo queda para cuando se pierde el orden entero, y
  entonces cuesta lo mismo que antes: 112–118 ms con 10⁵ ids barajados (medido en la primera
  vuelta).
- **Persistente** (`motor.clonPorPaso=false`, el laboratorio y T104): **se cumple**, con y sin crías.
  - Medido como lo midió el verificador, el orden cuesta 0,62–0,91 %.
  - Su coste marginal (suelo) es 0,68–0,72 %.
  - En la medida pareada, con `gc()` y cuatro mundos en el proceso, el inclusivo queda entre 0,86
    y 1,06 %: el IC de la corrida con crías roza el 1 % por arriba.
- **Clon por paso** (`motor.clonPorPaso=true`, el default del servidor): **no se cumple**.
  - Inclusivo: 2,9–4,0 % (antes 4,9–11 % en `06255f1` y 16–18 % en `200d284`).
  - Marginal: 2,1–2,4 %.
  - El suelo es leer una vez cada animal recién clonado. Desde `animals.ts` no se puede certificar
    un clon sin leerlo, porque el clon no conserva ni objetos ni arreglo. Hace falta que `cloneWorld`
    herede el certificado, como ya hereda la caché de estadísticas (`heredarEstadisticas`). Ver
    «Pendiente».

## ¿Puede el hardware cambiar el resultado?

**No.** La máscara depende solo de `world.tick`, de la población global y del orden canónico por
`id`. Ningún número de hilos, partición, reloj ni medida de capacidad entra en ella. El reparto a
regiones (`seleccionDe`) solo consulta la pertenencia, y el test 2 demuestra que 1..8 particiones dan
la misma selección. `ordenCanonico` no depende del hardware ni del estado de su caché:

- el certificado, el recorrido y la mezcla solo deciden cuánto trabajo hace falta;
- el arreglo resultante es siempre el del `sort` estable (tests 5, 6, 8, 9 y 10, y 24 controles de
  digesto denso por los dos caminos);
- que el hueco lo ocupe otro mundo, o que se clone, solo cambia el coste.

## Pendiente y hallazgos para el gate B

- **Heredar el certificado en `cloneWorld`** (`index.ts`, fuera de T116 y en reescritura por T141).
  Es lo único que baja el modo clon del 1 %. El clon ya lee cada animal del mundo vigente para
  copiarlo, así que podría entregar el certificado con los objetos nuevos en el mismo recorrido. El
  paso haría entonces la comparación de punteros del modo persistente (~1,2–1,9 ms) en vez de leer
  10⁵ animales fríos. Se propone para el gate B, con T115 y el cableado de la máscara.
- **Cableado.** `stepWorld` debe calcular `mascaraFauna` en el coordinador y pasarla cuando T115
  reparta la fase de fauna. La máscara exportada hace una copia congelada del orden (O(A), ~0,3 ms a
  10⁵), y validarla es otro recorrido O(A).
- **Gateo de `physiology`.** Consulta `ids.has` para **todos** los animales: ~4,3 ms a 10⁵. Es un
  coste que ya existía y no entra en la cifra de orden. Un mapa de bits por índice canónico costaría
  ~0,04 ms y se podría compartir con workers (`SharedArrayBuffer`). Se propone para T115.
- **Un hueco.** Con varios mundos en el mismo proceso (laboratorio de réplicas en un solo proceso),
  cada uno desaloja el certificado del otro y el orden se comprueba por pares (O(A) comparaciones de
  cadenas). Es correcto, pero más caro. Si hiciera falta, se puede pasar a un hueco por mundo.
