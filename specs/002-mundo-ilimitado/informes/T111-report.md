# T111: `HALO_CELDAS` y la prueba estática de alcance compuesto. Sale 14, no 13

Base: `200d284`. Rama: `sprint/002-b-t111`. Worktree: `/datos/workspaces/personal/AtlasParaIsa-n-B-t111`.

Commits:

- Primera ronda: `a961c05` (inventario y prueba) y `4b11e3b` (cita en `docs/REGLAS.md`).
- Segunda ronda, tras la verificación: `ffed268` (inventario como grafo y prueba nueva), `e3b58d2` (`docs/REGLAS.md`) y `9fe83b9` (operando izquierdo de un umbral).

## Resumen

- **El halo es 14 celdas, no 13.** `evaluateCooperation` corre dentro de `choose`. Mira a quien está a ≤ 7
  celdas y, desde esa persona, lee la tesela de su destino y las teselas que suman los insumos de una receta,
  cada una a ≤ 7 de ella: 7 + 7. El 13 de la refutación G2 (hogar + personas) sigue siendo el máximo **para
  personas**.
- **Con reglas 10 la decisión necesita 128.** El cortejo lee por id a cada persona vinculada y decide sobre las
  que están a ≤ 128 celdas. Ninguna constante fija lo arregla: lo tiene que resolver T115/T117.
- **La verificación rechazó la primera ronda con dos hallazgos. Los dos eran reales y los dos están
  corregidos.**
  1. La prueba no detectaba siete mutaciones reales, y `docs/REGLAS.md` afirmaba más de lo que se comprobaba.
     La prueba se reescribió: ahora sigue el grafo de llamadas del fuente y fija cada lectura entera. Detecta
     las siete mutaciones de la verificación y otras 27 (34 de 34). La composición 7 + 8 se prueba sobre el
     código, no solo sobre datos inventados.
  2. El inventario no registraba las dos selecciones globales que deciden qué animales deciden en cada paso.
     Ahora cada fase repartida declara su raíz y las lecturas que eligen quién actúa. La ventana de
     `MAX_ACTIVE_ANIMALS` y el tope de `MAX_ANIMAL_DECISIONS_PER_TICK` quedan como lecturas globales que calcula
     el coordinador.
- **Sonda dinámica nueva.** Se altera al azar todo lo que está a más de H celdas de quien decide.
  - Con los parámetros históricos, **ninguna** de 230 decisiones de personas cambia con H ≥ 13, ni ninguna de
    642 decisiones de fauna con H ≥ 5.
  - Con reglas 10 cambian entre 4 y 7 decisiones con H de 13 a 28. Es el cortejo: se comprobó caso a caso.
- `digestoCanonico` es idéntico en 6 de 6 controles de 2 400 pasos, repetidos en esta ronda.

## Los dos hallazgos de la verificación

### 1. La prueba no mordía (alta). Real

Reproduje las siete mutaciones del verificador (`/datos/tmp-atlas-lab/b-verif/T111/sondas/mutaciones.py`)
contra la prueba de la primera ronda: las siete pasaban en verde. Venían de cinco causas.

1. **Regex de barridos.** `-3 * RADIUS` capturaba solo el 3.
2. **Nombres con valor fijo.** Cualquier variable llamada `radius` valía 6.
3. **Lista de consultas corta.** `.reduce`, `.map` y `.slice` no estaban en la lista.
4. **`state.` no se escaneaba.**
5. **Composición a mano.** La composición dependía de un `centro` escrito a mano. Una llamada nueva (M3:
   `foodAvailable` sobre el destino del otro) no entraba en ninguna suma.

Además encontré dos defectos en un borrador intermedio:

- La comprobación de umbrales cortaba `distance(a, b)` en la primera coma. En la práctica no comprobaba
  ningún umbral.
- Los patrones casaban como subcadena: `<= 3` casaba dentro de `<= 30`.

**Qué se cambió.** `halo.ts` deja de ser una lista plana y pasa a ser un grafo:

- `RAICES`: la función de cada fase repartida, el bucle serial que la llama y las lecturas que eligen quién
  actúa.
- `ALCANCES`: las lecturas, agrupadas por función.
- `LLAMADAS`: las llamadas entre funciones que leen el mundo, cada una con el punto que recibe.

El alcance compuesto se calcula sobre ese grafo. `entrada(F)` es el peor punto con que se llama a `F`. Así
salen solos el 7 + 7 de la cooperación y el 13 de G2.

La prueba (`tests/halo-radios.test.ts`) analiza el fuente de `src/world`. Hace cinco comprobaciones.

1. **Grafo de llamadas.** Lo reconstruye desde cada raíz resolviendo identificadores e importaciones. Exige que
   sea igual al del inventario: 43 funciones en la decisión, 4 en la ecología y 2 en la fauna. También exige
   que cada raíz solo se llame desde su bucle de fase.
2. **Lecturas fijadas enteras.** En cada función alcanzada, cada una de estas lecturas tiene que estar fijada
   por el texto literal de una entrada, entera y en frontera de símbolo:
   - **Colecciones del mundo**: con cualquier receptor, desestructuradas o entre corchetes, junto con la cadena
     `.filter(…).sort(…)` que cuelga de ellas. Si un `for … of` recorre la colección, cuentan su cabecera y la
     condición que acota en la primera sentencia.
   - **Alias locales** (con punto fijo). Las funciones invocadas en el acto no cuentan como alias.
   - **Primitivas de consulta y `state.tile/occupants/counts`**, con sus argumentos.
   - **Llamadas a otra función que lee el mundo**, con sus argumentos.
   - **Barridos**: un `for` o un parámetro de flecha cuya variable desplaza una coordenada. Cuentan la cabecera
     y cualquier reasignación dentro del cuerpo.
   - **El mundo por reflexión, con otro tipo o con otro nombre**: `Object.values(world)`, `world as …`,
     `(world)[…]` y `const w = world`.
3. **Estado global.** Los demás campos de `world`/`host` que se leen tienen que estar en `ESTADO_GLOBAL`: reloj,
   semilla, tiempo, banderas y `technology`.
4. **Umbrales.** Todo umbral de `distance()` o `Math.hypot()`, a cualquiera de los dos lados de la comparación,
   tiene que cumplir una de tres condiciones:
   - ser un número ≤ halo;
   - ser una constante de radio, cuyo valor se lee del fuente;
   - estar dentro de una lectura fijada, o declarado.
5. **Fases seriales.** La red es más laxa. Se marcan las colecciones cuya cadena, aunque ocupe varias líneas, o
   cuya línea consulta algo, y todas las primitivas. Las consultas son `filter`, `find`, `some`, `every`,
   `includes`, `reduce`, `map`, `flatMap`, `forEach`, `slice`, `sort`, `indexOf`, `at`, `distance`,
   `Math.hypot` y los índices.

**Qué no demuestra**, y así lo dicen `halo.ts` y `docs/REGLAS.md`:

- Que el radio escrito en cada entrada sea el verdadero. Eso lo contrasta la sonda dinámica.
- El flujo de datos. Si cambia de dónde sale una variable local que una lectura fijada usa como punto (por
  ejemplo, `const recuerdo = …`), el texto de la lectura no cambia y la prueba no lo ve.
- El código fuera de `src/world`.

**Mutaciones.** Cada una se aplica a una copia del árbol y se corre la prueba. Script:
`/datos/tmp-atlas-lab/t111-fix/mutaciones.py`. Salida: `mutaciones.out`. **34 de 34 detectadas.** Las más
representativas, junto con las siete de la verificación, están también dentro de la prueba 7, que las aplica
al texto en memoria.

| Mutación | Detecta |
|---|---|
| M0 `HALO_CELDAS = 13` | composición: `cooperacion.* alcanza 14 > 13` |
| M1 barrido de `choose` a `3 * RADIUS` | el patrón del barrido desaparece |
| M2 percepción de la fauna × 5 | el patrón del barrido desaparece |
| M3 `foodAvailable(world, person.target)` en `itemNeed` | llamada sin inventariar; inventariada con su centro honesto, `estructuras.funcionales alcanza 15.5 > 14` |
| M4 `world.structures.reduce(… ≤ 30)` | colección sin inventariar |
| M5 bucle indexado sobre `world.people` | colección sin inventariar |
| M6 `const radius = 40` + `.filter` en otra línea | colección sin inventariar |
| M7 `state.tile(animal.x + 40, …)` | estado de la fauna sin inventariar |
| N1–N2 `const { people } = world`, `world['people']` | colección sin inventariar |
| N3 y N15 barrido `for (const dx of [-20, 20])` y `[[20,0]].map(([dx,dy]) => …)` | primitiva sin inventariar |
| N4 y N20 función nueva que lee, en el mismo fichero o en un fichero nuevo | llamada sin inventariar y grafo distinto |
| N5 `contarCerca(world.people, …)` | colección sin inventariar |
| N6 `world.events` | campo global fuera de `ESTADO_GLOBAL` |
| N7 `state.occupants` a 30 | estado sin inventariar |
| N8 vecindad del kernel ± 3 | patrón |
| N9 y N10 lecturas seriales en dos líneas o con `.reduce` | red serial |
| N11, N22 y N26 `Object.values(world)`, `world as …`, `const w = world` | reflexión |
| N12 `MEMORY_TTL` 960 | el alcance fijado de la memoria de la fauna (6 + TTL/4) |
| N13 una función no lectora pasa a leer | grafo distinto y llamada sin inventariar |
| N14 percepción de la fauna × 20 | patrón |
| N16 `<= 3` → `<= 30` | patrón en frontera de símbolo |
| N17 `viable({ ...p, x: p.x + 20 })` | patrón |
| N18 `practicedSkillToTeach(…, world.people[0]!)` | patrón |
| N19 `.slice(0, 512)` en la selección de la fauna | patrón de `fauna.turno` |
| N21 `40 >= distance(…)` | colección y umbral a la izquierda |
| N23 `dx += 20` dentro del barrido | reasignación del barrido |
| N24 predicado ampliado con `\|\| Math.abs(…) < 40` | lectura «fijada a medias» |
| N25 sentencia nueva antes del filtro de un `for … of` | lectura «fijada a medias» |

Según la verificación, M1–M3 compilan y cambian el digesto. Las N se aplicaron al texto y no se compilaron una
a una.

### 2. Selección global de la fauna (media). Real

El verificador tiene razón. `stepAnimals` solo deja decidir a los animales que salen de dos selecciones sobre
toda la fauna activa:

- la ventana rotatoria de `MAX_ACTIVE_ANIMALS` = 8 192 sobre el orden canónico;
- los `MAX_ANIMAL_DECISIONS_PER_TICK` = 1 024 más atrasados, con `.sort(…).slice(0, 1024)`.

Que un animal decida puede depender, por tanto, de animales a cualquier distancia. Su sonda
`fauna-global.mts` lo demuestra: un animal deja de decidir cuando se añaden 1 074 animales atrasados a 41
celdas o más. Hoy el efecto es latente, porque los mundos del laboratorio no pasan de ~775 animales.

**Qué se cambió.** La raíz `fauna` (`animals.ts:choose`) declara su llamador fijado,
`for (const animal of due) choose(animal, world, state);`, y su selección: `fauna.ventana` y `fauna.turno`,
dos `LECTURAS_GLOBALES` con su cota. La prueba 4 exige que existan, que sean globales y que estén en
`stepAnimals`. Cualquier cambio del texto de la selección rompe la prueba (N19).

La raíz `decision` hace lo mismo. Quién decide lo resuelve `bodyAndAction`, en la cadena serial, con su turno
y con el disparador de destino agotado, que lee la tesela de su propio destino. Ese disparador llega a 4 096
celdas con una orden.

**Hallazgo añadido al auditar esto.** `choose` tampoco es de solo lectura hoy.

- Cuando decide por un recuerdo de S e I, escribe un evento de crónica con id global (`addEvent`).
- Resolver recetas toca el LRU residente del catálogo de tecnología (`withRecipeSession`,
  `resolveTechnologyRecipe`). El orden de `state.recipes` depende del orden de las decisiones.

El halo no resuelve ninguna de las dos escrituras: las tiene que ordenar la confirmación (E.1). Quedan
anotadas en la raíz y en `ESTADO_GLOBAL.technology`, sin recorrido exhaustivo.

## Ficheros tocados

| Fichero | Qué |
|---|---|
| `src/world/halo.ts` | Contiene `HALO_CELDAS = 14` y estas tablas: `RAICES` (4); `ALCANCES` (52 entradas, 1 de ellas con radio de parámetro); `LLAMADAS` (61); `ALCANCES_SERIALES` (39); `LECTURAS_GLOBALES` (31, cada una con su cota); `LECTURAS_POR_IDENTIDAD` (24); `RECORRIDOS` (18); `ESCRITURAS` (2); `FUERA_DEL_PASO` (17); `PRIMITIVAS` (8); `ESTADO_GLOBAL` (9); `COLECCIONES_POR_NOMBRE`; `CONSTANTES_DE_RADIO`; `UMBRALES_QUE_NO_SON_LECTURAS`. Funciones puras: `funcionesDeFase`, `alcancesDeFase`, `excesos`, `haloRequerido`, `alcanceSerial`, `valorRadio`, `fraccionBorde`. El motor no lo importa. |
| `tests/halo-radios.test.ts` | Analizador léxico (sin comentarios, cadenas ni regex), grafo de llamadas y las comprobaciones descritas arriba. 8 pruebas. |
| `docs/REGLAS.md` | Sección «Motor: halo de las particiones»: qué fija la prueba, qué no, la sonda, quién decide y el coste. |

No se editó ningún fichero existente de `src/`.

## Las 8 pruebas

1. La cobertura: lecturas, llamadas, barridos, estado global y umbrales, con ninguna entrada obsoleta.
2. Las funciones que alcanza cada fase son las del fuente: 43, 4 y 2.
3. El alcance compuesto de las fases con halo no supera `HALO_CELDAS`, y el máximo es **exactamente** 14.
   - Tres entradas llegan a 14, las de la cooperación.
   - G2 da 13 y su rama hermana 12.
   - Máximo por colección: teselas 14, personas 13, lugares 12 y estructuras 11.
   - Máximo por fase: decisión 14, ecología 1 y fauna 6.
   - La memoria de la fauna llega a 126, y ese valor se calcula desde `MEMORY_TTL` y el intervalo de
     movimiento del fuente.
4. Quién actúa en una fase con halo lo decide la fase serial: el destino propio (4 096) y las dos selecciones
   globales de la fauna.
5. Alcances fijados de las fases seriales:
   - fauna serial: 1;
   - acción: 4 096 (la ruta de `move` llega a 24);
   - gestos: 7;
   - estructuras: 1,5;
   - encuentros: 3;
   - demografía: 2;
   - comunidades: 7;
   - reproducción: 4.

   La activación escribe hasta 23 celdas (`8 + CHUNK_SIZE − 1`).
6. Radios de parámetros:
   - `haloRequerido(HISTORICAL_PARAMS)` = 14, por la cooperación.
   - `DEFAULT_PARAMS` = 128, por el cortejo. Con el cortejo apagado vuelve a 14.
   - En el máximo de su rango superan el halo `radioPareja`, `radioLugar` y `radioCortejo`.
7. La prueba muerde. Incluye:
   - las siete mutaciones de la verificación y M3 inventariada con su centro honesto (15,5);
   - la composición 7 + 8 **en el código**: `algunoCerca(world.structures, learner, 9, … <= 8)` dentro de
     `practicedSkillToTeach` falla sin inventariar, y al inventariarla da 15 > 14;
   - un alias reutilizado, `RADIUS = 21`, una raíz llamada fuera de su bucle, `<= 3` → `<= 30`, un predicado
     ampliado, una sentencia antes del filtro, un barrido reasignado, un campo global nuevo, el mundo con otro
     tipo y una lectura serial en dos líneas.
8. Coste geométrico del halo (`fraccionBorde`).

## Cómo se prueba

```
npm run typecheck                                   # verde (rc 0)
TMPDIR=/datos/tmp-atlas-lab timeout 900 npx tsx --test tests/halo-radios.test.ts tests/digesto.test.ts tests/params.test.ts tests/check-links.test.ts
# tests 40 · pass 40 · fail 0 · skipped 0
TMPDIR=/datos/tmp-atlas-lab python3 /datos/tmp-atlas-lab/t111-fix/mutaciones.py   # 34 de 34 DETECTADA
```

## Cifras

### Control de identidad: `digestoCanonico` a 2 400 pasos, base `200d284` frente a la rama

Repetido en esta ronda con el script `/datos/tmp-atlas-lab/t111-fix/controles/correr.sh`, que corre un proceso
a la vez. La base está en el worktree temporal `/datos/tmp-atlas-lab/b-base-T111` (`200d284`, limpio). La rama
es `36a04be` más los cambios de esta ronda, que no tocan el motor. P2 es
`persistencia.cadaTicks=300,social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3`.

| Semilla | Params | Base `200d284` | Rama | |
|---|---|---|---|---|
| 7 | por defecto | `2b639241…04b5d3` | `2b639241…04b5d3` | igual |
| 42 | por defecto | `fb7036cb…25543d` | `fb7036cb…25543d` | igual |
| 51926 | por defecto | `bff69c2f…150a5f` | `bff69c2f…150a5f` | igual |
| 7 | P2 | `ceb05d5b…afd413` | `ceb05d5b…afd413` | igual |
| 42 | P2 | `12ab9b88…5520fc` | `12ab9b88…5520fc` | igual |
| 51926 | P2 | `38b08b64…e530bb` | `38b08b64…e530bb` | igual |

Los 12 hashes coinciden además con los de la primera ronda. El JSON completo está en
`/datos/tmp-atlas-lab/t111-fix/controles/{base,rama}/`.

**Desviación del encargo:** `social.memoriaDisputa=8` no existe en `200d284`. Solo está en
`sprint/noche-fund2`. `parseParams` la rechaza en la base y en la rama («Parámetro desconocido»; ver
`memoriaDisputa.err`), así que P2 se corrió con las otras cuatro claves.

### Sonda dinámica de no interferencia

Script: `/datos/tmp-atlas-lab/t111-fix/sonda2/sonda.mts`. Para cada persona P y cada H, hace dos cosas y
compara el objeto P entero:

- decide sobre una copia intacta;
- decide sobre otra copia en la que se altera, con un PRNG de semilla fija, **todo** lo que está a Chebyshev
  > H de P:
  - teselas: comida, agua, humedad, vegetación, crecimiento, fertilidad, vida, cultivo, tránsito, fauna,
    madera y piedra;
  - personas: necesidades, inventario, materiales, destrezas, vínculos, acción, destino y trabajo;
  - animales: salud y necesidades;
  - estructuras: estado, comida y agua.

Lo mismo se hace para una muestra de ~60 animales por instantánea.

- Semillas 7, 42 y 51926.
- Instantáneas a los pasos 600, 1 200, 2 400 y 4 800.
- Código real (copia con `choose` exportada) y dos controles positivos: M1 (percepción 21) y M3.
- «Capa» es el número de comparaciones con alguna persona, estructura o animal alterado en la franja
  (H, H + 8]. Todas las filas tienen capa en más del 85 % de las comparaciones.

| Personas: decisiones que cambian / comparadas | H=2 | H=7 | H=13 | H=14 | H=15 | H=21 | H=28 |
|---|---:|---:|---:|---:|---:|---:|---:|
| código real, históricos | 108/230 | 9/230 | **0**/230 | **0**/230 | **0**/230 | **0**/230 | **0**/230 |
| código real, reglas 10 sin cortejo | 149/258 | 18/258 | **0** | **0** | **0** | **0** | **0** |
| código real, reglas 10 | 157/267 | 29/267 | 7 | 5 | 6 | 6 | 4 |
| M1 (percepción 21), históricos | 148/248 | 46/248 | 1 | 2 | 0 | 0 | 0 |
| M3, históricos | 108/230 | 9/230 | 0 | 0 | 0 | 0 | 0 |

| Fauna: decisiones que cambian / comparadas | H=2 | H=5 | H=6 | H=7 | H=10 |
|---|---:|---:|---:|---:|---:|
| históricos | 605/642 | **0** | **0** | **0** | **0** |
| reglas 10 | 600/623 | 0 | 0 | 0 | 0 |
| reglas 10 sin cortejo | 516/547 | 0 | 0 | 0 | 0 |

Lectura de las tablas:

- **Históricos.** Con los parámetros históricos, y con reglas 10 sin cortejo, la decisión no depende de
  nada a más de 13 celdas en ninguna de las comparaciones. Es coherente con el halo de 14: la cadena 7 + 7 de
  la cooperación es rara. Con H = 7 sí cambian decisiones, así que el alcance real pasa de 7.
- **Reglas 10.** Las decisiones que cambian con H de 13 a 28 son del cortejo. Reproduje dos (`detalle.mts`).
  `neighbor-1` en (29, −46) busca a una pareja vinculada a 58 celdas («Recuerda el vínculo con Duna y lo
  busca…»), y `neighbor-2` tiene vínculos a 25–78 celdas. Es el 128 del inventario.
- **Fauna.** Con H ≥ 5 no cambia nada. La percepción llega a 6 en Manhattan, y un 6 en Chebyshev solo cae
  en los ejes.
- **Poder de la sonda.** La sonda tiene poco poder. M1 amplía la vista a 21 y solo cambian 3 de 248
  decisiones, con H de 13 y 14. M3 no cambia ninguna, porque el intercambio de productos no llega a darse.
  Una lectura lejana que casi nunca decide no se ve desde fuera. Por eso la sonda contrasta los radios, pero
  la garantía la da la prueba estática, que detecta las dos.

Los datos están en `/datos/tmp-atlas-lab/t111-fix/sonda2/res-*.json` y `resumen.tsv`. Cada corrida tarda
22–104 s, con dos procesos a la vez.

### Coste del halo (sin cambios desde la primera ronda)

Fracción de celdas que una región llena lee de sus vecinas, `((L + 2h)² − L²) / L²`:

| Región | Halo 8 | Halo 13 | **Halo 14** | Halo 24 |
|---|---:|---:|---:|---:|
| 256 × 256 | 12,89 % | 21,34 % | **23,07 %** | 41,02 % |
| 512 × 512 | 6,35 % | 10,41 % | **11,24 %** | 19,63 % |

Medido en mundos reales tras 12 000 pasos (5 días, `HISTORICAL_PARAMS`). La tabla da, sobre las teselas
activas, la fracción que las regiones con teselas propias leen de sus vecinas:

| Semilla | Habitantes | Teselas activas | Regiones 256 / 512 | Halo 8 | Halo 13 | **Halo 14** | Halo 14 con regiones de 512 |
|---|---:|---:|---|---:|---:|---:|---:|
| 7 | 16 | 10 496 | 4 / 4 | 26,8 % | 46,1 % | **50,2 %** | 50,2 % |
| 42 | 21 | 17 920 | 6 / 4 | 14,6 % | 24,2 % | **26,1 %** | 26,1 % |
| 51926 | 33 | 17 664 | 6 / 4 | 17,8 % | 30,0 % | **32,5 %** | 35,0 % |

El mundo nace en el origen, que es esquina de cuatro regiones de cualquier tamaño alineado. Por eso, a esta
escala, pasar a 512 no abarata nada. El cierre pide pasar a 512 × 512 «si eso pesa en la métrica de T115»;
T115 no existe todavía y la decisión sigue abierta. Los datos están en
`/datos/tmp-atlas-lab/t111-controles/coste/`.

## ¿Puede el hardware cambiar el resultado de este cambio?

**No.** Ningún fichero del motor importa `halo.ts`: tiene una constante, datos y funciones puras. La prueba es
un análisis estático del fuente. La sonda y las mutaciones corren fuera del repo. Ni el número de hilos, ni la
geometría, ni la GPU entran en nada de esto. El digesto a 2 400 pasos es idéntico en 6 de 6 controles.

## Hallazgos para las tareas siguientes

1. **El 13 queda refutado para las teselas: el halo es 14.** La escena de «alcance compuesto» de T117
   debería incluir este caso: una persona en la frontera, otra a 7 celdas en la región vecina y el destino de
   esa otra 7 celdas más allá.
2. **Cortejo de reglas 10: lectura por id, sin cota.** Decide sobre vínculos a ≤ 128 celdas, y la sonda lo ve
   hasta H = 28 en mundos pequeños. Hace falta una tabla de personas replicada de solo lectura, o dejar esa
   parte en el coordinador. Afecta a T115, T117 y `motor.particionarPersonas`.
3. **La «fase B de solo lectura» todavía no existe.**
   - `choose` corre dentro de la cadena `for (const person of world.people) bodyAndAction(…)`, así que cada
     persona decide viendo lo que las anteriores ya hicieron en el mismo paso.
   - `choose` escribe un evento de crónica al decidir por un recuerdo.
   - `choose` toca el LRU de recetas.

   Separar la decisión del efecto es un cambio de orden: hay que declararlo y medirlo con el digesto (E.1).
4. **Fauna (T116).**
   - Qué animales deciden sale de dos selecciones globales (`fauna.ventana` y `fauna.turno`). Las tiene que
     calcular el coordinador antes de repartir `choose`. Repartirlas por región divergiría por encima de 1 024
     animales atrasados o de 8 192 activos.
   - Los recuerdos consultan la máscara de presencia hasta 126 celdas. La máscara no cambia durante el paso y
     se replica.
   - La capacidad de cría cuenta todas las teselas activas, y la presa se lee por id.
5. **Acción.** La ruta de `move` llega a 24 celdas. Una orden fuera de la vista deja el destino a ≤ 4 096 y
   `bodyAndAction`/`resourceDispute` leen esa tesela. Hoy las dos cosas son seriales.
6. **Citas movidas (regla 11).**
   - `RADIUS` está en `index.ts:48` y `CONSTRUCTION_RADIUS` en `inventions.ts:92`.
   - `settlementOpportunity` está en `society.ts:233-265`.
   - PERF2 cambió `buildable`, que ahora usa `algunoCerca(world.places, t, 6, …)`. La regla sigue siendo
     «ningún lugar a < 5», con alcance compuesto de 12.
   - La fundación usa `social.maxComunidades`, no `>= 8`. Queda inventariada como lectura global
     (`comunidades.tope`).
   - La reproducción no es «3 + 4». Pareja y lugar se miden los dos desde `a`, así que el máximo es 4, de
     parámetro.
   - La percepción animal es un rombo Manhattan de `2 + ⌊p·4⌋ ≤ 6`.
7. **Solape con otras tareas (regla 12).** No se editó ninguna función de nadie, pero la prueba **lee** el
   texto de funciones que otras tareas reescriben. Al integrar esas tareas, los patrones afectados fallarán. El
   mensaje dice fichero, línea, función y el trozo sin fijar, y hay que refrescar `halo.ts`: es lo que se
   busca.
   - T112: `buildTopology`.
   - T113: `tileAt`, `activate`, `maintainRegions` y `terrainIndex`.
   - T116: la selección de `stepAnimals`.
   - T141: la rejilla de personas en `index.ts`/`society.ts`.
   - T142: `lineage.ts`.

   Si T141 introduce una primitiva nueva de consulta de personas, hay que añadirla a `PRIMITIVAS` en
   `halo.ts`. Si no, la prueba ve la colección que le pasen, pero no el radio de la consulta.

## Delegación

- **Primera ronda.** `delegar_a_cloud(claude/sonnet)` murió a los 1 800 s. Su resultado huérfano no servía, se
  descartó y se guardó en `/datos/tmp-atlas-lab/t111-delegado/`. La implementación fue del orquestador.
- **Segunda ronda.**
  - Codex no estaba disponible. `codex exec` da `401 Unauthorized` y `get_ai_quotas` marca los dos perfiles
    de Codex como no disponibles. Por eso la corrección de la prueba y del inventario la hice yo, siguiendo
    la regla de calidad primero.
  - La sonda dinámica la delegué a Gemini 3.1 Pro (`agy -p`, en segundo plano, con permisos solo sobre
    `/datos/tmp-atlas-lab/t111-fix/sonda-dinamica/`). Escribió los parches de exportación, correctos y
    reutilizados, y una sonda que:
    - alteraba con valores constantes;
    - no tocaba la fauna de las teselas;
    - calculaba dos `digestoCanonico` completos por comparación.

    A los 20 minutos no había terminado ni la primera de 9 corridas. La detuve y escribí `sonda2/sonda.mts`
    (alteración aleatoria con semilla, capa medida por tipo de entidad), que termina las 15 corridas en ~8
    minutos con dos procesos a la vez.

## Estado del cierre

| Criterio | Estado |
|---|---|
| Prueba verde | cumplido (8/8; 40/40 con los tests del módulo) |
| La prueba falla ante un radio 9 y una composición 7 + 8 | cumplido: la composición 7 + 8 se prueba en el código, y 34 de 34 mutaciones se detectan |
| Inventario citado en `docs/REGLAS.md` | cumplido, con lo que la prueba fija y lo que no |
| Coste del halo medido | cumplido (geométrico y en mundos reales) |
| `digestoCanonico` intacto | cumplido (6 de 6, repetido) |
| Valor `HALO_CELDAS = 13` del título | **no se cumple, a propósito**: el inventario y la prueba dan 14 |
| Decisión 256 frente a 512 | abierta: depende de la métrica de T115 |
| Casillas de `tasks.md` | sin marcar |
