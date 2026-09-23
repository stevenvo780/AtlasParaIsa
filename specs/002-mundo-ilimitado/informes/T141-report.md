# T141: Rejilla espacial de personas

**Rama** `sprint/002-e0-t141` desde `5e0556f`. Commits `5be58ae` (rejilla + `index.ts`), `bb359fd`
(`society.ts`), `00ed091` (tests). **Estado**: digesto idéntico en todos los controles; los sitios de
la tabla y los dos barridos por radio que faltaban en ella están migrados. La curva del paso **sigue
siendo cuadrática** por barridos que están fuera de los ficheros de esta tarea (ver «Cierre»).

## Ficheros tocados

- `src/world/rejilla.ts` (nuevo): la rejilla y su API (`conRejilla`, `vecinos`, `primerVecino`,
  `personaMovida`, más dos ganchos de prueba).
- `src/world/index.ts`: `stepWorld` abre el ámbito; `move` avisa del cambio de posición; sitios `choose`,
  `explorationTarget`, `share` (receptor y observadores), `transferEstate` (herencia) y `reproduce`.
- `src/world/society.ts`: `settlementOpportunity`, `evaluateCooperation`, `updateCommunities`,
  `reviseByCohabitation` y `resourceDispute`, más el agrupamiento `porComunidad`.
- `tests/rejilla.test.ts` (nuevo).

## Qué cambió y por qué

**Rejilla.** Casillas de 4×4 celdas. Cada casilla tiene su cabeza y su cola en un `Int32Array` (el índice
denso de la casilla sale de un `Map` de clave numérica, como en `indice-puntos.ts`) y una lista
doblemente enlazada por slot en orden creciente. `vecinos(world, centro, alcance, pred)` junta las
cabezas de las casillas de `[c − alcance, c + alcance]` en un montículo y las fusiona. Devuelve
exactamente `world.people.filter(pred)`: los mismos objetos en orden de slot. `primerVecino` devuelve
`find(pred)`, el menor slot que cumple. El predicado es el mismo de antes y se evalúa sobre las
posiciones actuales. Cada llamador pasa `radio + 1` como alcance, así que el redondeo de `Math.hypot`
no puede dejar fuera a nadie.

**Por qué es exacta dentro del paso.** Encontré las trampas por grep antes de delegar y comprobé cada
una en el diff:
1. Las posiciones cambian durante el paso: la persona k ve ya movidas a las de slot menor. El único
   escritor de `person.x/y` en todo `src/` es `move` (`index.ts:913`). Justo después llama a
   `personaMovida`, que reubica el slot en su casilla nueva en orden, con coste O(ocupación de la
   casilla). No se usa un margen del tipo «sólo se mueve una vez por tick».
2. `world.people` cambia dentro del paso. Un nacimiento (`push` en `reproduce`) alarga el arreglo y
   se anexan los slots nuevos. Una muerte crea un arreglo nuevo (`filter` en `lineage.ts`) y la rejilla
   se reconstruye. Cada consulta comprueba la identidad y la longitud del arreglo.
3. **Ámbito explícito.** La rejilla sólo existe dentro de `conRejilla`, que `stepWorld` abre alrededor
   de `advanceTick` con try/finally. Se construye en O(P) en la primera consulta del paso. Fuera del
   ámbito, las consultas son el `filter`/`find` lineal de siempre. Así los tests que mueven personas a
   mano o las proyecciones que llaman a `settlementOpportunity` no pueden ver una rejilla obsoleta.
4. Cae al recorrido lineal, que es idéntico por definición, en estos casos: coordenadas no finitas o
   fuera de ±2^23 casillas, una persona repetida en dos slots, o un rango con más casillas que
   habitantes (`poblacion.radioPareja` = 32 con poca gente). Ningún parámetro hace la consulta más cara
   que el `filter`.
5. La rejilla no entra en `World`, en la instantánea ni en el digesto. Vive en un `WeakMap` de módulo.
   Los contadores por sitio sólo cuentan si una prueba los activa (`reiniciarConsultasRejillaParaPruebas`),
   así que el paso real no paga ese recuento.

**Comunidades.** Los `filter` por `communityId` de `updateCommunities` pasan a `porComunidad`, un
agrupamiento en orden de slot hecho en una pasada. Cuestan O(P) por invocación en vez de O(P·G) y de
O(P²) en el bucle de salida. La validez depende del momento:
- En el bucle de salida sólo se sale (a `null`). En la fisión sólo se sale o se va a ids nuevos, que la
  copia de `world.communities` no recorre. En los dos casos la lista inicial filtrada por la
  pertenencia actual (`p.communityId === id`) es el `filter` de siempre.
- La regla de la mayoría sí añade miembros a grupos existentes. Por eso, antes de recalcular
  `members`, cultura y centro, se reagrupa una vez.
- El bucle de fundación ya no lee el índice: asigna directamente, como antes.
- La fisión busca su núcleo con `vecinos` y `memberSet.has(p) && trustedNeighbor(…)`, que da el mismo
  arreglo que `members.filter(trustedNeighbor)`.

**Aritmética y orden.** No cambió ninguna expresión de ninguna ley. Dos predicados se escribieron como
negación literal del `continue` original: los observadores de `share`,
`!(observer.id === donor.id || distance > 3)`, y `evaluateCooperation`, `!(other === person || distance > 7)`.
Así un `NaN` se trata igual que antes. En `evaluateCooperation`, `world.tick - person.lastSocial < 30`
no depende de `other` y sale del bucle: antes se hacía `continue` en todas las iteraciones y se
devolvía `[].sort()[0]`, o sea `undefined`, que es lo mismo que devuelve ahora.

## Inventario (regla 11: el árbol se movió desde f30d528)

| Cita de tasks.md | Hoy (5e0556f → T141) | Consulta |
|---|---|---|
| `index.ts:324` `choose` | `index.ts:432` | `vecinos(…, RADIUS + 1)` |
| `index.ts:574` `explorationTarget` | `index.ts:851` | `vecinos(…, 8)` |
| `index.ts:652` `share` | `index.ts:930` (receptor) y **`index.ts:952` (observadores a ≤ 3, no estaba en la tabla)** | `vecinos(…, 3)` / `vecinos(…, 4)` |
| `index.ts:928` herencia | `index.ts:1256` `transferEstate` | `vecinos(…, 3)` |
| `index.ts:953-959` `reproduce` | `index.ts:1299` | `vecinos(…, radioPareja + 1)` |
| `society.ts:105` `settlementOpportunity` | `society.ts:245` (centrada en el lugar) | `vecinos(…, 7)` |
| `society.ts:205,207,213,222` `updateCommunities` | `society.ts:393,407,428-453` | `vecinos(…, 7)` + `porComunidad` |
| `society.ts:242` `resourceDispute` | `society.ts:490` | `primerVecino(…, disputaRadio + 1)` |
| — (no estaba en la tabla) | **`society.ts:276` `evaluateCooperation`**, radio 7, en cada `choose` vía `cooperationOpportunity` | `vecinos(…, 8)` |

**Barridos que vi y no migré** porque están fuera de los ficheros de T141 (regla 1). Quedan para T140
o para quien decida la integración:
- **`inventions.ts:212` `knownBlueprints`**: radio 3, llamado para **cada persona cada 60 ticks**
  desde `stepStructures` (`inventions.ts:477`). Es O(P²) y **no está en la lista de T140**, que sólo
  nombra `inventions.ts:120/194/365`.
- **`inventions.ts:471`**: depósito de comida, que recorre todas las personas **por estructura y por
  tick**. Es O(S·P) y **tampoco está en la lista de T140**.
- `inventions.ts:121` y `:195`, `family.ts:101` (`familyOpportunity`) e `inventions.ts:371`: ya están en
  T140.
- Comprobaciones de pertenencia O(P) en el camino de decisión: `technology.ts:584,605` y
  `technology-water.ts:224,283,298` (`host.people.includes(actor)`). Son del mismo tipo que
  `inventions.ts:365`, que T140 sí tiene.
- `society.ts:50` `convivir` ya tiene su propia rejilla. Recorre los pares en orden de casilla, no de
  slot, y cambiarlo movería el orden de inserción de las claves de `bonds`. No lo toqué.
- `applyGesture` (`index.ts:1153/1168/1173`) hace un barrido por gesto, no por persona. No lo toqué.

## Cómo se prueba

- `tests/rejilla.test.ts` (16 tests, ≈ 60 s):
  - 10 000 consultas aleatorias (xorshift) con P ∈ {50, 500, 5 000} y radios {2, 3, 6, 7, 32}. Incluyen
    bordes de casilla, coordenadas negativas, `-0` y no enteras, movimientos con `personaMovida`, un
    `push` y el reemplazo del arreglo. Se exige el mismo arreglo, con las mismas referencias y el mismo
    orden, que `filter`, y el mismo elemento que `find`.
  - Fuera del ámbito se usa el recorrido lineal y se ve la mutación manual.
  - Coordenadas infinitas o fuera de rango y personas repetidas caen al filtro.
  - **Un test por sitio** (12 etiquetas) sobre una escena de 2 000 personas: digesto igual con y sin
    rejilla, y el contador del sitio es > 0, o sea que el sitio pasó de verdad por la rejilla.
  - **Trayectoria densa**: 2 000 personas con vínculos locales, cuatro comunidades y decisiones
    escalonadas, 13 pasos (movimiento en 120, 126 y 132; comunidades y nacimientos en 120). El digesto
    es igual paso a paso. Hubo 861 consultas de `choose`, 1 890 de cohabitación, 257 de `reproduce`,
    y así con las demás.
- Tests del módulo, verdes: 140 tests (139 ok y 1 skip preexistente, la prueba de 2 M teselas, que
  exige `CARTA_TEST_ESCALA=1`) en `rejilla`, `society`, `comunidades-vivas`, `cronica`,
  `cultural-transmission`, `cultural-chain`, `technology-society`, `technology-world-context`, `family*`,
  `leyes-candidatas` y `limites-anticorrupcion`. Con la torre cargada tardaron 563 s.
- `tests/rendimiento-identidad.test.ts`: 8/8 verdes. Tiene hashes **literales** de la base sin
  optimizar, incluida la población alta (230 habitantes, semilla 3, día 12,25, 600 pasos), así que con
  230 habitantes la rejilla sí se usa.
- `npm run typecheck` verde.

## Control de digesto (2 400 pasos, `scripts/lab/digesto-control.ts`)

Tres árboles:
- **base**: `5e0556f` en un worktree temporal.
- **T141**: esta rama.
- **forzada**: el código de T141 sin el umbral de casillas. No se versiona. Hace que **todas** las
  consultas del paso, también con 16–23 habitantes, vayan por la rejilla, porque con el umbral los
  mundos pequeños casi siempre caerían al filtro.

Juegos de parámetros:
- **def**: sin params, sobre `HISTORICAL_PARAMS`.
- **B**: el de producción/laboratorio B, `persistencia.cadaTicks=300,social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3`.
- **R10C**: las leyes adoptadas en reglas 10 más cohabitación, para ejercer `reviseByCohabitation`:
  `poblacion.cortejo=2,poblacion.radioCortejo=128,poblacion.exigeComunidad=false,poblacion.comprobacionContinua=true,conducta.habituacion=0.35,social.radioConvivencia=6,social.vinculoConvivencia=0.002`.

| Params | Semilla | base | T141 | forzada | población / nacimientos | Resultado |
|---|---|---|---|---|---|---|
| def | 7 | `2b6392411920e59b…` | `2b6392411920e59b…` | `2b6392411920e59b…` | 16 / 0 | idéntico |
| def | 42 | `fb7036cb898aa9b3…` | `fb7036cb898aa9b3…` | `fb7036cb898aa9b3…` | 21 / 5 | idéntico |
| def | 51926 | `bff69c2fdf0ea2b5…` | `bff69c2fdf0ea2b5…` | `bff69c2fdf0ea2b5…` | 22 / 6 | idéntico |
| B | 7 | `ceb05d5b4151eb90…` | `ceb05d5b4151eb90…` | `ceb05d5b4151eb90…` | 16 / 0 | idéntico |
| B | 42 | `12ab9b88dd578103…` | `12ab9b88dd578103…` | `12ab9b88dd578103…` | 20 / 4 | idéntico |
| B | 51926 | `38b08b64eb9d4251…` | `38b08b64eb9d4251…` | `38b08b64eb9d4251…` | 22 / 6 | idéntico |
| R10C | 7 | `b3c4e5b67bca5179…` | `b3c4e5b67bca5179…` | `b3c4e5b67bca5179…` | 22 / 6 | idéntico |
| R10C | 42 | `adda1df6fb2f358d…` | `adda1df6fb2f358d…` | `adda1df6fb2f358d…` | 23 / 7 | idéntico |
| R10C | 51926 | `f910e96ff6e26fe3…` | `f910e96ff6e26fe3…` | `f910e96ff6e26fe3…` | 23 / 7 | idéntico |

Los campos `completo` y `fisico` coinciden en los 27 casos. **`social.memoriaDisputa=8` no existe en
este árbol**: `parseParams` la rechaza como «Parámetro desconocido». El juego B se corrió sin esa clave;
era de una rama que no está en `main`.

Con poblaciones altas, el banco A/B de abajo compara la base con T141 sobre mundos sintéticos de
**50 a 4 000 habitantes durante 13 pasos**, que incluyen movimiento, comunidades, nacimientos y
muertes. El `digestoCanonico` final es **idéntico en las cinco poblaciones**, en 7 repeticiones
(3 para P = 4 000).

## Coste medido (ANTES = 5e0556f, DESPUÉS = T141)

**Consulta aislada** (`microbanco-consulta.mts`): densidad fija de una persona por cada 6 celdas;
20 000 consultas con el predicado de `choose` (radio 7) y el de `share`/herencia (radio 2).

| P | radio | vecinos medios | antes µs/consulta | después µs/consulta | aceleración | construcción ms/paso |
|---|---|---|---|---|---|---|
| 50 | 7 | 15.8 | 1.49 | 2.06 | 0.7× | 0.23 |
| 50 | 2 | 1.8 | 1.20 | 0.47 | 2.5× | 0.11 |
| 200 | 7 | 19.9 | 7.25 | 3.19 | 2.3× | 0.20 |
| 200 | 2 | 2.1 | 6.14 | 0.67 | 9.2× | 0.22 |
| 800 | 7 | 23.2 | 30.92 | 5.59 | 5.5× | 0.28 |
| 800 | 2 | 2.1 | 25.09 | 1.56 | 16.1× | 0.26 |
| 2000 | 7 | 23.5 | 64.91 | 4.79 | 13.5× | 0.26 |
| 2000 | 2 | 2.1 | 62.77 | 1.33 | 47.1× | 0.36 |
| 5000 | 7 | 24.1 | 121.83 | 5.86 | 20.8× | 0.51 |
| 5000 | 2 | 2.1 | 143.46 | 2.37 | 60.5× | 1.12 |

El coste por consulta **deja de depender de P**: entre 5 y 6 µs a radio 7 y entre 1,3 y 2,4 µs a
radio 2. Antes crecía de forma lineal. En mundos de 30–50 habitantes la rejilla y el filtro están
empatados: una segunda pasada dio 0,86 → 1,18 µs a P = 30 y 1,49 → 1,21 µs a P = 50, y la diferencia
es de fracciones de µs por consulta.

**Paso completo, banco A/B pareado** (`banco-ab.mts`): los dos árboles se cargan en el mismo proceso y
se alternan en cada repetición. El mundo es `createWorld(51926)` más clones de un fundador en una de
cada 6 teselas transitables, en espiral, con vínculos a ≤ 4 celdas, 4 comunidades y 1/30 de las
decisiones en cada tick. Se corren los ticks 119–131. Hay 7 repeticiones (3 para P = 4 000). Las cifras
son ms, con las fases en mediana por paso.

| P | p95 del paso | media del paso | fase `personas` | `comunidades` | `reproduccion` | `fauna` | digesto igual |
|---|---|---|---|---|---|---|---|
| 50 | 11.41 → 11.47 | 3.84 → 3.94 | 1.63 → 1.84 | 0.012 → 0.013 | 0.129 → 0.110 | 0.55 → 0.57 | sí |
| 200 | 22.42 → 23.46 | 7.88 → 8.86 | 4.22 → 4.88 | 0.067 → 0.053 | 0.487 → 0.219 | 1.63 → 1.56 | sí |
| 800 | 106.55 → 99.26 | 38.48 → 36.37 | 21.90 → 20.04 | 0.418 → 0.159 | 1.637 → 0.337 | 8.62 → 8.74 | sí |
| 2000 | 451.46 → 449.52 | 125.99 → 113.72 | 72.14 → 65.41 | 1.537 → 0.394 | 6.625 → 0.802 | 34.78 → 34.67 | sí |
| 4000 | 1934.76 → 2017.74 | 493.18 → 447.93 | 285.15 → 244.76 | 8.612 → 1.008 | 34.544 → 2.166 | 127.54 → 146.15 | sí |

- A 4 000 habitantes, `comunidades` es **8,5× más barata** y `reproduccion` **16×**. Ambas crecían con
  P² y ahora casi no se mueven.
- La fase `personas` baja un 14 % a 4 000 y un 9 % a 2 000. No baja más porque dentro de `choose`
  quedan `familyOpportunity`, `constructionOpportunity` y `inventionContext`, que siguen siendo O(P)
  por decisión y son de T140.
- A P ≤ 200 las diferencias caen dentro del ruido de la torre: load average entre 26 y 53 durante las
  mediciones, con otros workstreams corriendo, así que las cifras absolutas son sólo orientativas.
- El p95 no cambia. Lo domina el tick 120, y dentro de él la fase `fauna`: allí `stepStructures`
  recorre `knownBlueprints` (`inventions.ts:212`, P²) para cada persona cada 60 ticks, más el depósito
  por estructura de `inventions.ts:471`.

## Cierre: ajuste de p95(P)

Ajuste sobre P ∈ {50, 200, 800, 2000}, con los datos de la tabla anterior:

| Serie | R² lineal | R² cuadrático |
|---|---|---|
| p95 base | 0,972 | 1,000 |
| p95 T141 | **0,966** | 1,000 |
| fase `comunidades`+`reproduccion` T141 | 0,992 | 0,995 |

Si se añade P = 4000, el R² lineal del p95 baja a 0,922 (T141) y 0,928 (base).

La cifra literal del cierre (R² > 0,95) se cumple, pero **no prueba linealidad**: la base también la
cumple con cuatro puntos, y el ajuste cuadrático explica el 100 %. **El término cuadrático que sigue
vivo** son los barridos fuera de los ficheros de T141:
- `inventions.ts:212` (`knownBlueprints`, P² cada 60 ticks) e `inventions.ts:471` (S·P cada tick),
  que dominan el tick 120 y el p95. **Ninguno de los dos está en la lista de T140.**
- Los de T140: `inventions.ts:121` y `:195`, `family.ts:101`, e `inventions.ts:365` (hoy `:371`).

T144 debe medir la curva con T140 integrada **y** con esos dos sitios añadidos a su alcance. Hasta
entonces no cierra.

## ¿Puede el hardware cambiar el resultado?

**No.** La rejilla sólo decide en qué orden se miran las candidatas. Todas se filtran con el predicado
exacto de antes, sobre las posiciones actuales, y se devuelven en orden de slot. Nada depende de hilos,
reparto, caché ni reloj. `LADO` y el umbral de caída al filtro dependen sólo del radio y de P, que son
contenido del mundo, y no entran en ninguna fórmula: si se cambian, cambia el coste y no el mundo.
La variante «forzada» lo demuestra: sin umbral, los 9 digestos son los mismos. Tampoco hay `Atomics`,
sumas reordenadas, `Math.random`, `Date.now` ni `performance.now`.

## Delegación y revisión

- **Qué hizo el delegado.** Se delegó en `codex/gpt-5.6-sol` con esfuerzo `xhigh`, acceso de escritura
  y un prompt autocontenido: la tarea literal, las reglas 1–13, el inventario de sitios con las líneas
  actuales, las 8 trampas y los digestos de la base. Escribió `rejilla.ts` (ámbito, lista doble
  ordenada, fusión con montículo, reubicación en `move`, caídas al filtro), migró los sitios, hizo un
  índice mutable por comunidad y escribió `tests/rejilla.test.ts` salvo la trayectoria densa.
- **Incidente.** La llamada MCP agotó su plazo de 1 800 s sin respuesta. El proceso `codex exec`
  siguió trabajando en el worktree y terminó hacia las 11:30, pero el servidor MCP borró su mensaje
  final. La revisión se hizo sobre el diff, línea a línea.
- **Qué corregí yo:**
  1. Sustituí el índice mutable por comunidad por `porComunidad`. Su `cambiar` hacía un `splice` por
     cada alta o baja, y en el bucle de fundación eso podía volver a ser O(P²) si muchas personas sin
     comunidad se unían en una sola invocación.
  2. Los contadores por sitio sólo cuentan cuando una prueba los pide. Antes creaban un `Map` por mundo
     en cada paso de producción.
  3. Volví a escribir los predicados de los observadores de `share` y de `evaluateCooperation` como
     negación literal del `continue`, para conservar la semántica de `NaN`.
  4. Puse en la cabecera de `rejilla.ts` los invariantes que la hacen exacta.
  5. Añadí el test de trayectoria densa de 13 pasos.
- **Controles.** Los corrí yo: digestos, variante forzada, bancos, tests y typecheck.

## Aislamiento (regla 12)

- T142 (`lineage.ts`) y T143 (`technology-checkpoint.ts`) no comparten ninguna función con esta tarea.
- T140 depende de esta rejilla. Para sus sitios de `inventions.ts` y `family.ts` debe usar
  `vecinos`/`primerVecino` de `src/world/rejilla.ts`, con `radio + 1`. Dentro de `stepWorld` el ámbito
  ya está abierto.
- T146 (`communityCounter`) y T147 (desempate de `skills`) tocan `society.ts` en otros gates. El
  contador sigue incrementándose en los mismos sitios y en el mismo orden.
