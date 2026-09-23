# T111: `HALO_CELDAS` y la prueba estática de alcance compuesto. Sale 14, no 13

Base: `200d284`. Rama: `sprint/002-b-t111`. Worktree: `/datos/workspaces/personal/AtlasParaIsa-n-B-t111`.
Commits: `a961c05` (inventario y prueba) y `4b11e3b` (cita en `docs/REGLAS.md`).

## Resumen

- El inventario completo del paso da **14 celdas, no 13**. `evaluateCooperation` se llama dentro de `choose`.
  Mira a las personas que están a 7 celdas o menos. Desde cada una lee la tesela de su destino (a ≤ 7 de ella)
  y las teselas que suman los insumos de una receta (también a ≤ 7). Son 7 + 7. Este caso es como la
  refutación G2: el texto de la tarea no lo recoge. El 13 de G2 (hogar + personas) sigue siendo el máximo
  **para personas**.
- **Con las reglas vigentes (reglas 10), la decisión de una persona necesita un halo de 128.** El cortejo está
  activo (`poblacion.cortejo` = 2, `radioCortejo` = 128). Lee por id a cada persona vinculada, esté donde esté,
  y decide sobre las que están a 128 celdas o menos. Con el cortejo apagado, como en los mundos históricos,
  basta con 14. Ninguna constante fija resuelve esto. Lo tiene que resolver T115/T117, replicando una tabla de
  personas de solo lectura o dejando el cortejo en la fase serial.
- Estos alcances no los recogía ninguna tarea: la ruta de `move` lee terreno a **24** celdas, los recuerdos de
  la fauna consultan la máscara de presencia a **126** y una orden puede dejar el destino de alguien a
  **4 096**. La tabla está más abajo.
- El digesto es idéntico: 6 de 6 controles de 2 400 pasos.

## Ficheros tocados

| Fichero | Qué |
|---|---|
| `src/world/halo.ts` (nuevo) | `HALO_CELDAS = 14` y el inventario, en seis secciones. `ALCANCES` tiene 84 entradas, 4 de ellas con radio de parámetro. Las otras cinco son `LECTURAS_GLOBALES` (15, cada una con su cota), `LECTURAS_POR_IDENTIDAD` (21), `RECORRIDOS` de fase (15), `ESCRITURAS` (la activación) y `FUERA_DEL_PASO` (13 funciones: validación, proyección, creación y migración). Además, `RADIOS_CON_NOMBRE` y `UMBRALES_QUE_NO_SON_LECTURAS`, y cinco funciones puras: `alcanceCompuesto`, `excesos`, `haloRequerido`, `valorRadio` y `fraccionBorde`. No lo importa ningún fichero del motor. |
| `tests/halo-radios.test.ts` (nuevo) | 7 pruebas, descritas abajo. |
| `docs/REGLAS.md` | Sección «Motor: halo de las particiones». Es el cierre de la tarea («el inventario citado en `docs/REGLAS.md`»). |

No se editó ningún fichero existente de `src/`.

## Qué es el inventario

Cada entrada de `ALCANCES` es una lectura del mundo alrededor de un punto. Guarda la fase, la colección, el
radio y un `centro`. El `centro` es `actor` (quien decide o actúa) o el `id` de la entrada que encontró ese
punto. `alcanceCompuesto` suma los radios de esa cadena. Así, `asentamiento.hogar.personas` tiene por centro
`asentamiento.hogar` y suma 7 + 6 = 13. Una función auxiliar que se llama desde varios sitios se inventaría en
su peor llamada, y la entrada dice cuáles son las demás. `waterAvailable`, `bodilyShelter`, `immediateMeal` y
`functionalNear` se componen sobre `decision.teselas`, a 7 celdas: `choose` sólo pregunta por teselas o
destinos con ruta percibida.

Métrica: el halo cuenta celdas por eje. Las personas miden la distancia con `Math.hypot` y la fauna con
Manhattan. En los dos casos, `d ≤ r` implica |Δx| ≤ r y |Δy| ≤ r. Por la desigualdad triangular, dos saltos
suman a lo sumo sus radios. Un umbral estricto (`< 5`) cuenta como 5, una cota conservadora.

Sólo tres fases se reparten por regiones y quedan sujetas al halo (`FASES_CON_HALO`): la decisión de cada
persona (`choose`, la «fase B de solo lectura»), la ecología (T115/T120) y la decisión de la fauna (T116).
Las demás fases se quedan en el coordinador: el movimiento, la alimentación y la cría de la fauna, la acción
de cada persona, los gestos, las estructuras, los encuentros, la demografía, las comunidades y la
reproducción. Esas fases escriben en orden de `world.people`, consumen `world.rng` o suman en acumuladores
globales. Su alcance queda inventariado y fijado en la prueba, pero no acotado por el halo.

### Alcance compuesto máximo por fase (params históricos / reglas 10)

| Fase | Entradas | Máximo | Causa |
|---|---:|---:|---|
| decisión | 42 | **14 / 128** | cooperación: 7 + 7 (teselas). Con reglas 10, cortejo a 128 |
| decisión de la fauna | 3 | 6 (126 con la excepción) | percepción de 6 en Manhattan. Los recuerdos consultan la presencia a 6 + 480/4 = 126 |
| ecología | 2 | 1 | 4 vecinos de `ecology()` y 8 vecinos del kernel |
| movimiento, alimentación y cría de la fauna | 2 | 1 | vecinos del movimiento y de la cría |
| acción | 18 | 4 096 | tesela del destino propio con una orden (`accion.destino`). La ruta de `move` llega a 24 |
| gestos | 2 | 7 | testigos a ≤ `RADIUS` del gesto |
| estructuras | 3 | 1,5 | depósito de comida. Cada 60 pasos se revisan los planos: 5 alrededor de cada persona |
| encuentros | 2 | 3 | lugar del encuentro de S e I |
| demografía | 3 | 2 | herencia |
| comunidades | 5 | 7 | lugar de fundación y de fisión |
| reproducción | 2 | 4 (de parámetro) | `radioLugar` 4 y `radioPareja` 3, medidos los dos desde `a`: no se componen |
| activación (escritura) | 1 | 23 | chunk de (x ± 8, y ± 8): 8 + 15 |

Para las fases con halo, el máximo por colección es: teselas 14, personas 13, lugares 12, estructuras 11 y
animales 7.

## Qué comprueba la prueba

1. **Cobertura en los dos sentidos.** El escáner lee cada línea de `src/world` salvo `halo.ts`. Marca las
   líneas que tocan `world.`/`host.` + `people|places|structures|tiles|animals|communities|invitations|reminders`
   junto a `distance(`, `filter(`, `some(`, `find(`, `findIndex(`, `includes(`, `every(` u `of`. También marca
   las llamadas a `filtrarCerca`, `primeroCerca`, `algunoCerca`, `tileAt`, `firstTileAt`, `lastTileAt`,
   `tileLookup` y `personById`. En cada línea, los patrones de las entradas de su función tapan sus fragmentos.
   Si lo que queda sigue siendo una lectura, falta una entrada. Por eso una segunda lectura en una línea ya
   inventariada también falla. En sentido contrario, cada patrón tiene que seguir existiendo dentro de la
   función declarada, y la función se detecta en el propio fuente.
2. **Umbrales.** Todo `distance(…) <|<=|>|>= X` y todo `for (let dy = -X` de `src/world` tiene que cumplir una
   de dos condiciones: un número ≤ `HALO_CELDAS`, o un nombre de `RADIOS_CON_NOMBRE`. `RADIUS`,
   `CONSTRUCTION_RADIUS` y `RADIO_CONVIVENCIA` se leen del código, así que no hay copia que se desactualice. La
   única excepción numérica es el 4 096 de `applyGesture`, que valida una orden y no lee nada allí.
3. **Alcance compuesto ≤ halo en las fases con halo**, y el máximo es **exactamente** `HALO_CELDAS`. Así la
   constante no puede inflarse sin que se note. La prueba fija que las tres entradas de 14 son las de la
   cooperación, y los valores 13, 11, 11, 12 y 12 de G2, de su rama hermana y de la obra.
4. **Alcances fijados de todas las fases**, las seriales incluidas: el 24 de la ruta, el 23 de la activación
   (`8 + CHUNK_SIZE − 1`) y el 126 de la memoria de la fauna. Este último se calcula desde `MEMORY_TTL` y el
   intervalo mínimo de movimiento que se leen del fuente.
5. **Parámetros.** Con `HISTORICAL_PARAMS`, `haloRequerido` es 14 (causa: `cooperacion.destinoDelOtro`). Con
   `DEFAULT_PARAMS` es 128 (causa: `decision.cortejo`). Con el cortejo apagado vuelve a 14 aunque el radio sea
   128. En el máximo de su rango superan el halo `radioPareja` (32), `radioLugar` (64) y `radioCortejo` (128);
   `disputaRadio` (8) no lo supera.
6. **La prueba falla cuando debe.**
   - (a) Una lectura sintética `world.people.filter(p => distance(person, p) <= 9)` sin inventariar hace
     fallar la cobertura.
   - Un umbral sintético de 15 y un barrido de ±20 hacen fallar la comprobación de umbrales.
   - (b) Un radio 9 centrado en el hogar da 16 y `excesos` lo detecta.
   - (c) La composición 7 + 8 da 15: ninguna de las dos entradas supera 14 por sí sola, y la prueba falla
     igual. En una fase serial no cuenta.
   - Un ciclo de centros lanza un error.
7. **Coste geométrico**: `fraccionBorde` para 256/8, 256/13, 256/14, 512/13, 512/14 y 128.

Mutaciones contra el árbol real, aplicadas a mano y revertidas con `git checkout`:

| Mutación | Resultado |
|---|---|
| Añadir `const lejos = world.people.filter(p => distance(p, place) <= 9)` en la misma línea que `peers` de `settlementOpportunity` | la prueba 1 falla |
| Añadir `world.structures.filter(s => distance(person, s) <= 9)` en `choose` | la prueba 1 falla |
| Cambiar `for (let dy=-4…` de `viable` a `-15` | la prueba 2 falla |
| Cambiar `distance(person, other) > 7` de `evaluateCooperation` a `> 20` | las pruebas 1 y 2 fallan |
| Dar a `decision.personas` el centro `asentamiento.hogar` con radio 8 (15) | las pruebas 3–6 fallan |
| Poner `HALO_CELDAS = 13` | las pruebas 3, 5 y 6 fallan |

## Cómo se prueba

```
npm run typecheck                                   # verde (rc 0)
TMPDIR=/datos/tmp-atlas-lab timeout 900 npx tsx --test tests/halo-radios.test.ts tests/digesto.test.ts tests/params.test.ts tests/check-links.test.ts
# tests 39 · pass 39 · fail 0 · skipped 0
```

## Cifras

### Control de identidad: `digestoCanonico` a 2 400 pasos, base `200d284` frente a esta rama

`npx tsx scripts/lab/digesto-control.ts --seed S --pasos 2400 [--params P2]`. La base corrió en el worktree
temporal `/datos/tmp-atlas-lab/b-base-T111`. P2 es
`persistencia.cadaTicks=300,social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3`.

| Semilla | Params | Base `200d284` | Rama | |
|---|---|---|---|---|
| 7 | por defecto | `2b639241…5b3` | `2b639241…5b3` | igual |
| 42 | por defecto | `fb7036cb…43d` | `fb7036cb…43d` | igual |
| 51926 | por defecto | `bff69c2f…a5f` | `bff69c2f…a5f` | igual |
| 7 | P2 | `ceb05d5b…13d` | `ceb05d5b…13d` | igual |
| 42 | P2 | `12ab9b88…0fc` | `12ab9b88…0fc` | igual |
| 51926 | P2 | `38b08b64…0bb` | `38b08b64…0bb` | igual |

**Desviación del encargo:** el segundo juego pedido incluía `social.memoriaDisputa=8`. Esa clave no existe en
`200d284`: sólo está en la rama `sprint/noche-fund2-20260923`. `parseParams` la rechaza («Parámetro
desconocido»), así que se corrió P2 con las otras cuatro claves. Los hashes completos están en
`/datos/tmp-atlas-lab/t111-controles/{base,rama}/*.json`.

### Coste del halo

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

Los mundos de hoy nacen en el origen, que es la esquina de cuatro regiones de cualquier tamaño alineado. Por
eso, a esta escala, pasar a 512 no abarata nada. Las cifras geométricas sólo valen para regiones llenas, en
la escala de SC-004 (millones de teselas). El cierre pide pasar a 512 × 512 «si eso pesa en la métrica de
T115». T115 no existe todavía, así que esa decisión sigue abierta. Script de medida (fuera del repo):
`coste-halo.mts` del scratchpad de la sesión. Salida: `/datos/tmp-atlas-lab/t111-controles/coste/*.json`.

## ¿Puede el hardware cambiar el resultado de este cambio?

**No.** `halo.ts` no lo importa ningún fichero del motor. Contiene una constante, datos y funciones puras
sobre esos datos. La prueba es un análisis estático del fuente. Ningún número de hilos, geometría ni GPU
entra en ninguna de las dos. El digesto a 2 400 pasos es idéntico en 6 de 6 controles.

## Hallazgos para las tareas siguientes

1. **El 13 queda refutado para las teselas; el halo es 14** (ver el resumen). También lo afirman T117 («con
   `HALO_CELDAS=8` habría fallado») y el borde de 21,3 % de la tarea. La escena de «alcance compuesto» de T117
   debería incluir este caso: una persona en la frontera, otra a 7 celdas en la región vecina y el destino de
   esa otra 7 celdas más allá.
2. **Cortejo de reglas 10.** Se lee por id, sin cota: `choose` recorre `person.bonds` y lee rol, vínculos y
   padres de cada persona vinculada a cualquier distancia (`vinculos.cortejo`). Decide sobre las que están a
   ≤ 128. Con personas repartidas por región hace falta una tabla de personas replicada de solo lectura, o
   que esa parte de la decisión se quede en el coordinador. Es un problema de diseño para T115/T117 y para
   `motor.particionarPersonas`. No se arregla con el halo.
3. **La «fase B de solo lectura» todavía no existe.** Hoy `choose` corre dentro de la cadena
   `for (const person of world.people) bodyAndAction(…)`. Cada persona decide viendo lo que las anteriores ya
   hicieron en este paso. Separar la decisión del efecto es un cambio de orden. Hay que declararlo y medirlo
   con el digesto: no basta con repartir.
4. **Fauna (T116).** Los recuerdos de un animal preguntan si la celda recordada sigue activa hasta a 126
   celdas. Es la única excepción admitida del halo en una fase repartida: la máscara de presencia no cambia
   durante el paso y se replica. Además, la capacidad de cría (`reproduce` de animals.ts) cuenta **todas** las
   teselas activas, y la presa se lee por id. Las dos lecturas son globales y quedan en el coordinador.
5. **Acción.** `move` hace una búsqueda en anchura de hasta 24 celdas por eje, sobre terreno y presencia. Una
   orden (`forage`, `drink`, `hunt`) fuera de la vista deja el destino a ≤ 4 096 celdas, y
   `bodyAndAction`/`resourceDispute` leen la tesela de ese destino. Las dos cosas son serial hoy. Si alguna
   vez se reparte la acción, estas cifras mandan.
6. **Citas movidas** (regla 11). `RADIUS` está en `index.ts:48` (no en `:43`), `CONSTRUCTION_RADIUS` en
   `inventions.ts:92`, `settlementOpportunity` en `society.ts:233-265` (no en 94-124) y `buildable` en
   `index.ts:640-641`. PERF2 cambió `buildable`: ya no recorre todo `world.places`, porque usa
   `algunoCerca(world.places, t, 6, …)` con índice. Sigue siendo la regla «ningún lugar a < 5 de una tesela a
   ≤ 7». Queda inventariada como alcance compuesto de 12, y `world.places` (≤ 2 048) figura además entre las
   lecturas globales replicadas. La fundación está en `society.ts:441` y su tope es
   `social.maxComunidades`, no `>= 8`. La reproducción no es «3 + 4»: pareja y lugar se miden los dos desde
   `a` y no se componen (máximo 4, de parámetro). La percepción animal usa **Manhattan**: `localTiles` recorre
   un rombo de `2 + ⌊p·4⌋ ≤ 6`, y las amenazas `1 + ⌊p·5⌋ ≤ 6` son un subconjunto.
7. **Solape con otras tareas (regla 12).** No se editó ninguna función de nadie. La prueba sí **lee** el texto
   de funciones que otras tareas en curso reescriben. Al integrarlas, los patrones afectados fallarán con un
   mensaje que dice fichero, función y patrón, y hay que refrescar `halo.ts`. Ese es el propósito de la
   prueba, pero conviene saberlo antes del gate. Tareas y funciones:
   - T112: `buildTopology` del kernel.
   - T113: `tileAt`, `activate`, `maintainRegions` y `terrainIndex`.
   - T116: la selección de `stepAnimals`.
   - T141: rejilla de personas en `index.ts`/`society.ts`, en casi todas las entradas de personas.
   - T142: `lineage.ts`.

   Si T141 introduce una primitiva nueva de consulta de personas, hay que añadirla a `PRIMITIVA` en la prueba.
   Si no se añade, las lecturas nuevas escapan al escáner.

## Delegación

El procedimiento asignaba la implementación a `claude/sonnet` (esfuerzo high) vía `delegar_a_cloud`. La
llamada MCP murió a los 1 800 s sin respuesta: el delegado pasó la mayor parte en cola y arrancó tarde. El
proceso huérfano siguió corriendo en el worktree y a los ~16 min escribió un `halo.ts` y una prueba. Nunca
devolvió informe. Revisé esos ficheros y los descarté. Dejaba `HALO_CELDAS = 13` y trataba la tesela del
destino del otro y los insumos de receta como lecturas a 7 del actor, sin componer. No encontró la ruta de 24
ni la memoria de 126, y atribuía lecturas a funciones inexistentes (`facilityRestQuality/hearthFuel` para el
riego de `stepStructures`). Además, su prueba sólo cruzaba los patrones con el fichero, no con la función.
Detuve el proceso para que no escribiera sobre mi versión. Sus ficheros están en
`/datos/tmp-atlas-lab/t111-delegado/` por si alguien quiere compararlos. La implementación final, las medidas
y este informe los hizo el orquestador.

## Estado del cierre

| Criterio | Estado |
|---|---|
| Prueba verde | cumplido |
| Inventario citado en `docs/REGLAS.md` | cumplido |
| Coste del halo medido | cumplido (geométrico y en mundos reales) |
| `digestoCanonico` intacto | cumplido (6 de 6) |
| Valor `HALO_CELDAS = 13` del título | **no se cumple, a propósito**: el inventario da 14 |
| Decisión 256 frente a 512 | abierta: depende de la métrica de T115, que no existe todavía |
