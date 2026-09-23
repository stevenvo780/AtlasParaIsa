# E0W2A: índices no-persona en `inventions.ts`/`family.ts` — `nextIdentity`, estructuras por celda, personas por vecindad

Base `8cc8a6c` (integra T141 rejilla espacial, T142 poda de vínculos, T143 roster del checkpoint).
Worktree `/datos/workspaces/personal/AtlasParaIsa-n-E0-w2a`, rama `sprint/002-e0-w2a`. Es el paquete
«w2a» de la ola 2 de E.0: cubre la parte de T140 (`inventions.ts`, `family.ts`, el `find` de estructuras
por celda de `index.ts`) más los dos sitios que el propio informe de T141 dejó fuera de su alcance
(`knownBlueprints` y el depósito por estructura de `stepStructures`, ambos en `inventions.ts`).

## Ficheros tocados

- `src/world/inventions.ts`: `nextIdentity`, `localServices`, `constructionContext`, `usefulRepairs`,
  `inventionContext`, `knownBlueprints`, `completeConstruction` (solo la llamada a `nextIdentity`),
  `takeFood`, `takeWater`, `recordFacilityRest`, `stepStructures` (solo el depósito de comida).
- `src/world/family.ts`: `familyOpportunity`.
- `src/world/indices.ts` (nuevo): índice incremental de ids del archivo dormido y comprobación de
  pertenencia O(1) a `world.people`.
- `src/world/index.ts`: solo `bodilyShelter`.
- `tests/indices.test.ts` (nuevo).

Nada más se tocó. `src/world/rejilla.ts` e `src/world/indice-puntos.ts` (T141 y sprint noche-perf2,
ambos ya existentes) se usan tal cual, sin modificarlos.

## Qué cambió y por qué

**`nextIdentity` (§T140 «O(territorio explorado)»).** Antes, `blueprintIdentity` y la asignación de id
de `completeConstruction` reconstruían en cada invención y cada construcción un arreglo con
`world.retiredChunks.flatMap(chunk => (chunk.structures ?? []).map(s => s.id o s.blueprintId))`: el
archivo dormido entero, en cada intento (no solo los que tienen éxito). `world.blueprints.length` y
`world.structures.length` están acotados por `MAX_BLUEPRINTS=64` y `MAX_STRUCTURES=512`, así que esa
parte del escaneo (blueprints, sus `parents`, structures) es barata por construcción y se dejó como
escaneo directo, sin indexar. Lo único que crecía sin cota era `retiredChunks`.

`src/world/indices.ts` añade `techoDelArchivo(retiredChunks)`, en dos capas:
- **Por chunk** (`techoDeChunk`, `WeakMap<Chunk, TechoArchivo>`): un chunk retirado es inmutable una vez
  archivado (`activate()` hace `structuredClone` antes de reinyectarlo; nada más escribe en
  `chunk.structures` mientras el chunk sigue en `retiredChunks`), así que su techo de ids (el mayor
  sufijo numérico de `structure.id` y de `structure.blueprintId` entre sus estructuras, con la misma
  regex/parseo que `nextIdentity` de siempre) se calcula una sola vez por chunk y vale para siempre,
  sobreviva el mundo los clones que sobreviva: `cloneWorld` copia `retiredChunks` superficial
  (`draft.retiredChunks = [...world.retiredChunks]`), así que los objetos `Chunk` conservan identidad
  entre pasos aunque el arreglo contenedor sea nuevo cada vez.
- **Por arreglo** (`WeakMap<readonly Chunk[], {…, techo}>`, validada además por longitud y por el primer
  y el último elemento): como `retiredChunks` sí cambia de identidad en cada clon, esta capa se
  reconstruye como mucho una vez por paso —el mismo patrón que ya usan `rejilla.ts` e
  `indice-puntos.ts`— pero cada reconstrucción es barata porque solo consulta el techo YA CACHEADO de
  cada chunk, nunca vuelve a mirar sus estructuras.

Un sufijo que pierde precisión al pasar por `Number(...)` marca `blueprintCorrupto`/`structureCorrupto`
en vez de abortar in situ; `nextIdentity` sigue devolviendo `undefined` en ese caso, igual que antes
(la evaluación exhaustiva y el corte temprano dan la misma respuesta final porque no hay efectos
colaterales durante el escaneo). `nextIdentity` combina ahora el escaneo directo y acotado de lo vivo
con `techoDelArchivo(world.retiredChunks)`, tomando el máximo de ambos y del `counter` de entrada: el id
resultante es el mismo, incluido el caso de un id reanimado del archivo con un sufijo mayor que
cualquier contador (probado en `tests/indices.test.ts`).

**Estructuras por celda (§T140 «O(estructuras)»).** `localServices`, `usefulRepairs` y la mitad de
`knownBlueprints` que mira `world.structures` recorrían el arreglo entero por persona y por invocación.
Pasan a `filtrarCerca` de `indice-puntos.ts` (ya existente, ya usado por `functionalNear` en el mismo
fichero), con el radio real **+ 1** al llamar al índice —igual que ya hace `functionalNear`— para que el
redondeo de `Math.hypot` en el borde de celda nunca excluya a nadie. En `localServices` y `usefulRepairs`
el predicado se escribió como **negación literal** del `continue`/`return []` original (no la forma
positiva "de Morgan"), porque la forma positiva sí cambia el resultado cuando `distance` o `condition`
son `NaN`: el `continue` original nunca se dispara por una comparación `NaN > r` (siempre falsa), así que
esas estructuras seguían procesándose; la negación literal preserva exactamente ese comportamiento
(en `usefulRepairs` además el bucle `while (condition < LIMIT)` de más abajo también es insensible a
`condition` NaN, así que ambas formas convergen ahí, pero no para `distance` NaN en `localServices`, que
sí divergía con la forma positiva). Es el mismo criterio que T141 documentó para `share`/
`evaluateCooperation`. `knownBlueprints` ya tenía la mitad de estructuras en forma positiva (un `if`
directo, no un `continue`), así que esa parte se migró literal, sin negar nada.

**Personas por vecindad (§T140 «O(P)»).** `constructionContext`, `inventionContext`, la otra mitad de
`knownBlueprints` (el barrido de `world.people` cuando `cooperationEnabled`) y `familyOpportunity`
(`family.ts`) ya eran `.filter()` en forma positiva; se migraron verbatim a `vecinos()` de `rejilla.ts`
(radio real + 1), sin negar nada porque no había nada que negar. El depósito de comida por estructura de
`stepStructures` (§T140 «S·P cada tick») **sí** era un `continue`-skip (`if (distance>1.5||hunger>=0.5||
inventory<=0.12) continue;`) y **sí** importa el orden (el depósito consume una capacidad compartida,
`a.foodCapacity - structure.food`, así que quién llega primero se lleva el cupo): se escribió como
negación literal, `vecinos(world, structure, 2.5, person => !(distance(person, structure) > 1.5 ||
person.hunger >= 0.5 || person.inventory <= 0.12))`, que devuelve exactamente el mismo orden que
`world.people.filter(pred)` (orden de slot) porque el radio 2,5 cubre 1,5 + 1. `stepStructures` corre
dentro de la fase `fauna` de `advanceTick`, ya dentro del ámbito `conRejilla` que abre `stepWorld`.

**Pertenencia O(1) (§T140, el mismo grupo de «O(P)»).** `takeFood`, `takeWater` y `recordFacilityRest`
comprobaban `world.people.some(p => p === person …)` / `.includes(person)` en cada llamada. `indices.ts`
añade `esMiembro(people, person)`: un `Set<Person>` por arreglo, en un `WeakMap<readonly Person[],
{length, set}>` validado por longitud (mismo criterio que usa `rejilla.ts` para saber si `world.people`
sigue siendo el mismo arreglo o si un nacimiento lo alargó). `world.people` es un arreglo nuevo en cada
clon del mundo, así que esta caché también vive como mucho un paso, pero eso ya es una mejora real
cuando varias personas comen/beben/descansan en el mismo paso. En `takeFood` la comprobación de
identidad se combina con el resto del predicado exactamente en el mismo orden de evaluación de siempre.

**`bodilyShelter` (`index.ts`, el único sitio permitido de ese fichero).** `world.structures.filter(s =>
s.x === point.x && s.y === point.y && …)` pasa a `filtrarCerca(world.structures, point, 0, …)`: alcance
0 porque el predicado exige coincidencia exacta de celda (dos coordenadas enteras iguales caen siempre
en la misma casilla de lado 4), y `index.ts` ya importaba `filtrarCerca` de `indice-puntos.ts`.

## Cómo se prueba

- `npm run typecheck`: verde.
- `TMPDIR=/datos/tmp-atlas-lab timeout 600 npx tsx --test tests/inventions.test.ts tests/family.test.ts
  tests/family-forage-contention.test.ts tests/family-forage-planning.test.ts
  tests/construction-decisions.test.ts tests/construction-demand.test.ts tests/agua-memoria.test.ts
  tests/survival-audit.test.ts tests/survival-risk.test.ts tests/indices.test.ts tests/rejilla.test.ts`:
  **131/131**, 0 fallos, 0 omitidos, ≈26 s.
- `tests/indices.test.ts` (3 tests nuevos):
  1. `techoDelArchivo` sobre 30 000 chunks retirados, con una minoría con estructuras (una de cada 997),
     un id "reanimado" (`structure-987654`/`blueprint-765432`, mayor que cualquier contador plausible) y
     un id de `legacyStructures` (`structure-legacy-23-456`) que no cuenta. Compara contra un oráculo que
     reimplementa la lógica de siempre. Comprueba con un contador de invocaciones
     (`escaneosDeArchivoParaPruebas`) que: la segunda llamada con el mismo arreglo no vuelve a visitar
     ningún chunk; un arreglo clonado (`[...chunks]`, misma longitud, mismos elementos) reutiliza el
     techo de cada chunk (visita 0 chunks nuevos) porque la caché es por chunk, no solo por arreglo; un
     `push` (longitud +1) invalida la capa de arreglo pero visita solo el chunk nuevo; un relevo de igual
     longitud (mismo `length`, pero el último elemento cambia) también invalida la capa de arreglo
     (gracias al chequeo de `first`/`last`, no solo de `length`) y visita el chunk sustituido.
  2. Corrupción de sufijos: un `blueprintId` y un `id` con 40 dígitos (pierde precisión en `Number(...)`)
     marcan `blueprintCorrupto`/`structureCorrupto` por separado, sin contaminar el otro campo; el id
     legacy en la misma corrida no cuenta.
  3. `esMiembro` coincide con `.includes`/`.some` por identidad de objeto (no por `id`): dos objetos con
     el mismo `id` pero distinta identidad no son intercambiables, y un `push` (nacimiento) invalida el
     `Set` cacheado para ese arreglo.

## Control de digesto

### 2 400 pasos, población fundadora (no ejerce de verdad el cambio)

Worktree base `/datos/tmp-atlas-lab/e0w2a-base-codex` en `8cc8a6c`, `TMPDIR=/datos/tmp-atlas-lab`, ≤ 3
procesos a la vez. «B» es `persistencia.cadaTicks=300,social.disputaNecesidad=0.45,
social.disputaEscasez=3,social.disputaRadio=3` (`social.memoriaDisputa` no existe en esta base).

| Semilla | Params | `completo`/`fisico` base | `completo`/`fisico` rama | Nacimientos / población |
|---|---|---|---|---|
| 7 | def | `2b6392411920e59b…` | idéntico | 0 / 16 |
| 42 | def | `fb7036cb898aa9b3…` | idéntico | 5 / 21 |
| 51926 | def | `bff69c2fdf0ea2b5…` | idéntico | 6 / 22 |
| 7 | B | `ceb05d5b4151eb90…` | idéntico | 0 / 16 |
| 42 | B | `12ab9b88dd578103…` | idéntico | 4 / 20 |
| 51926 | B | `38b08b64eb9d4251…` | idéntico | 6 / 22 |

Las 6 cifras coinciden exactamente con las de los informes de T141/T142/T143 sobre la misma base, lo que
confirma que el punto de partida es el correcto. Con 16-23 habitantes y pocas estructuras nunca hay
suficiente vecindad ni archivo dormido para que el índice importe: este control **no ejerce** el cambio.

### Mundo poblado (sí lo ejerce)

Script `/datos/tmp-atlas-lab/e0w2a-tools/e0w2a-bank-run.mts` (carga los dos árboles en el mismo proceso,
como `banco-ab.mts` de T141): `createWorld(51926)`, población clonada hasta 2 000 personas repartidas
sobre tierra transitable, 400 estructuras reales (`frame+roof+granary`, terreno puesto a `shelter`,
`structureCounter=400`) y 5 000 chunks retirados sintéticos, uno de cada 97 con una estructura
(ids `structure-100000+`, para ejercer el archivo). 15 pasos completos de `stepWorld` con las dos
ramas alternadas por paso.

```json
{"control":"poblado","people":2000,"structures":400,"retiredChunks":5000,"steps":15,"allEqual":true,
 "finalDigest":"85cf1201d932cdebae0d48e9f6614ec8ccd02ebb26c0c9223854ceff9d664bad"}
```

`digestoCanonico` coincide **en los 15 pasos**, antes y después de la corrección de negación literal en
`localServices`/`usefulRepairs` (se corrió dos veces, con el mismo resultado).

## Coste medido (ANTES = `8cc8a6c`, DESPUÉS = esta rama)

Mismo script, `process.hrtime.bigint()` en el banco (nunca dentro de `src/world`), torre compartida,
alternando árbol por repetición para que la carga afecte a ambos por igual. Medianas en ms.

**`nextIdentity`** (`completeConstruction` real, 100 000 chunks retirados, uno de cada 1 000 con una
estructura, 64 construcciones consecutivas, 3 repeticiones):

| Escenario | ANTES | DESPUÉS | Razón |
|---|---:|---:|---:|
| 64 construcciones, 100 000 chunks retirados | 76,8–189,5 (mediana de 3 corridas) | 21,1–58,9 | ≈ 2,5–3,2× |

El coste por construcción baja de ≈1,2–3,0 ms (recorre el archivo entero en cada llamada) a, tras la
primera, prácticamente el coste de `Object.is`/`Map.get` (el resto de las 63 llamadas reutiliza la capa
de arreglo cacheada, ya con el techo de cada chunk resuelto): el ahorro crece con el número de llamadas
dentro del mismo paso, no solo con el tamaño del archivo.

**Fase `fauna` de `stepWorld`** (2 000 personas, 400 estructuras, 5 repeticiones por escenario,
alternadas):

| Escenario | P | S | ANTES (mediana) | DESPUÉS (mediana) | Razón |
|---|---:|---:|---:|---:|---:|
| `knownBlueprints` solo (tick múltiplo de 60, sin graneros) | 2 000 | 400 | 260,2–285,8 ms | 96,9–104,3 ms | ≈ 2,6–2,9× |
| depósito solo (tick sin `knownBlueprints`, con graneros) | 2 000 | 400 | 25,3–33,7 ms | 6,9–11,4 ms | ≈ 3,1–3,2× |
| ambos a la vez (tick 59, múltiplo −1 de 60, con graneros) | 2 000 | 400 | 271,1–348,1 ms | 97,9–119,9 ms | ≈ 2,6–2,9× |

El coste de `knownBlueprints` (antes P × S para la parte de estructuras más P × P para la parte de
personas cuando `cooperationEnabled`, cada 60 ticks) y el del depósito (antes S × P cada tick) dejan de
crecer con el producto de las dos poblaciones: ahora cada llamada solo mira la vecindad real (celdas de
lado 4 alrededor de cada persona o estructura), y el coste restante es el de construir una vez por paso
la rejilla de personas (T141) y el índice de estructuras por celda (sprint noche-perf2), que ya paga
cualquier otro sitio del motor.

No se corrió `scripts/curva-techo.mts` con distintas P (eso es T144, que integra las tres tareas E.0 y
el resto de T140); las cifras de arriba son del banco A/B de esta tarea, para 2 000 personas fijas, y
sirven de evidencia de que el cambio es real y de que el digesto no se movió al aplicarlo.

## ¿Puede el hardware cambiar el resultado?

**No.** Los dos índices nuevos (`techoDelArchivo`/`techoDeChunk` y `esMiembro`) solo deciden si hace
falta recorrer datos que de todos modos se recorrerían, y devuelven exactamente lo mismo que el barrido
que sustituyen: el mismo máximo de sufijos, la misma pertenencia por identidad de objeto. `filtrarCerca`
y `vecinos` (ya existentes, de sprints anteriores) tienen la misma propiedad, documentada en sus propios
ficheros. Ningún reparto por hilos, ninguna suma en árbol, ningún `Atomics`, ningún reloj (`Math.random`,
`Date.now`, `performance.now`) entra en ninguno de los cuatro sitios tocados. El orden de iteración de
las cachés (`WeakMap`) no es observable: lo único que estas devuelven es un número o un booleano, nunca
un arreglo cuyo orden dependa de cómo el motor de JS recorra el mapa.

## Delegación y revisión

- Se delegó a `codex/gpt-5.6-sol` con esfuerzo `xhigh`, acceso de escritura, en este worktree, con un
  prompt autocontenido: la tarea literal, las reglas 1-13, el inventario de sitios con el código actual,
  y un diseño propuesto para `indices.ts` (dos capas de caché, por chunk y por arreglo, apoyadas en que
  `retiredChunks` conserva identidad de sus `Chunk` entre clones aunque el arreglo contenedor no).
- **Incidente**: la llamada MCP agotó su plazo de 1 500 s. El proceso siguió trabajando en el worktree y
  dejó el árbol con los cuatro ficheros modificados/creados y sin comprometer, tal como se le pidió («no
  hagas commit»); no dejó ninguna nota final de texto (se perdió con el timeout).
- **Qué corrigió el orquestador tras revisar el diff línea a línea:**
  1. `localServices` y `usefulRepairs` migraron sus predicados en forma positiva (De Morgan de un
     `continue`/`return []`), lo que cambia el resultado cuando `distance` es `NaN` (el `continue`
     original nunca se dispara por esa comparación). Se reescribieron como negación literal, con
     comentario explicando por qué, siguiendo el mismo criterio que T141 documentó para
     `share`/`evaluateCooperation`. El depósito de `stepStructures` y `knownBlueprints` (positivo desde
     el original) no necesitaban este cambio y el delegado los dejó bien.
  2. Limpieza de un directorio de trabajo temporal (`.e0w2a-tmp/`, con caché de `tsx` y un banco A/B) que
     el delegado creó **dentro del worktree** en vez de en `TMPDIR=/datos/tmp-atlas-lab`, y un worktree
     base en `/tmp/e0w2a-base-codex` (regla: nunca `/tmp`). Ambos se movieron a
     `/datos/tmp-atlas-lab/e0w2a-tools/` y `/datos/tmp-atlas-lab/e0w2a-base-codex/` respectivamente; el
     worktree del árbol de la tarea quedó limpio (solo los 4 ficheros del cambio).
  3. El banco A/B que dejó el delegado (`e0w2a-bank.mts`) resultó reutilizable tal cual (solo se corrigió
     la ruta del árbol base) y es la fuente de los controles de mundo poblado y las cifras de coste de
     este informe; se corrió por el orquestador, no por el delegado.
- **Controles.** Los corrió el orquestador: los 12 digestos de 2 400 pasos, el control de mundo poblado
  (2 veces, antes y después de la corrección de negación literal, mismo resultado), los 131 tests del
  módulo y `npm run typecheck`.

## Aislamiento (regla 12)

- No se tocó `src/world/rejilla.ts`, `src/world/indice-puntos.ts`, `src/world/society.ts`,
  `src/world/lineage.ts`, `src/world/technology-checkpoint.ts` ni ninguna otra parte de `index.ts`.
- Los otros sitios de T140 (`technology.ts:207,284` con `host.tiles?.find`, la capacidad de fauna en
  `animals.ts:258`) son de otro paquete de trabajo de esta misma ola (w2b/w2c) y no se tocaron.
- `family.ts` importa `vecinos` de `rejilla.ts` (T141) pero no modifica ese fichero.
