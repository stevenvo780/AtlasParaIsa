# E0W2B: pertenencia O(P)→O(1) en `technology.ts`/`technology-water.ts` y recuento de fauna sin asignar

Base `8cc8a6c`. Rama `sprint/002-e0-w2b`, worktree `/datos/workspaces/personal/AtlasParaIsa-n-E0-w2b`.
Alcance declarado: `src/world/technology.ts`, `src/world/technology-water.ts` y **solo la capacidad de fauna**
de `src/world/animals.ts`.

## Localización (regla 11)

El inventario de T141 (`specs/002-mundo-ilimitado/informes/T141-report.md`, sección «Barridos que vi y no
migré») seguía vigente en `8cc8a6c`, verificado por contenido:

- `technology.ts:584,605` y `technology-water.ts:224,283,298`: `host.people.includes(x)` en el camino de
  decisión (5 sitios). **No migrados.**
- `technology.ts:207-208,299,366,391` y `technology-water.ts:232,300` (`localInputs` y sus gemelos):
  `firstTileAt(host.tiles, …)`, **ya migrados** a un índice O(1) por el sprint `noche-perf`
  (commit `f2757fa`, `src/world/tile-index.ts`, anterior a esta tarea). No queda ningún
  `host.tiles?.find/filter` por coordenadas en ninguno de los dos ficheros: sólo `.find` sobre
  `actor.technology.items` (arreglos de a lo sumo `budgets.maxItems` = 16 elementos por persona, fuera
  del alcance de FR-027). No había nada que tocar aquí; se deja constancia para que la integración no lo
  vuelva a listar.
- `animals.ts:298` (línea de hoy; T140 la cita como `:258`): `world.tiles.filter(t => t.terrain !== 'shelter'
  && (t.growth ?? 0) > 0.04).length * 3` para la capacidad de cría de fauna. **No migrado.**

## Qué cambió y por qué

### 1. Pertenencia `host.people.includes(x)` → `isHostMember(host.people, x)`, O(1) amortizado

Cinco sitios, dos cachés independientes (una por fichero, para no compartir estado entre módulos que ya
se importan mutuamente sólo por tipos):

- `technology.ts`: `transferTechnologyItem` (dos comprobaciones, `from` y `to`) y `settleTechnologyEstate`
  (una por cada candidato de `recipients`).
- `technology-water.ts`: `canHandle` (usada por `fillContainedWater` y `drinkContainedWater`),
  `payContainedWaterCarry` y `beginWaterPreparation`.

Cada fichero tiene ahora:

```ts
const peopleMemberships = new WeakMap<readonly TechnologyActor[], { length: number; members: Set<TechnologyActor> }>();
function isHostMember(people: readonly TechnologyActor[], actor: TechnologyActor): boolean {
  let cached = peopleMemberships.get(people);
  if (!cached || cached.length !== people.length) { cached = { length: people.length, members: new Set(people) }; peopleMemberships.set(people, cached); }
  return cached.members.has(actor);
}
```

**Por qué es exacta.** Es el mismo patrón que `tile-index.ts` y `rejilla.ts` (T141): un caché por
identidad del arreglo, invalidado por longitud. `host.people` es siempre `world.people`, que solo se
reasigna a un arreglo nuevo (una muerte, `filter` en `lineage.ts`) o crece con `push` (un nacimiento,
T141): las dos operaciones cambian la referencia o la longitud, así que una entrada obsoleta nunca puede
leerse — no hace falta invalidar por contenido porque el contenido nunca cambia sin que cambie uno de
esos dos. El `Set` guarda las MISMAS referencias que el arreglo, así que `.has(x)` es exactamente
`.includes(x)`: `Array.prototype.includes` y `Set.prototype.has` usan los dos SameValueZero, que para
objetos es `===`. Se comprobó en el código que ningún llamador reemplaza un elemento en su sitio
(`host.people[i] = otraPersona`) sin cambiar la longitud; el único caso encontrado en los tests es
`host.people.shift()` (`tests/technology.test.ts:190,194`), que sí cambia la longitud y por tanto
invalida el caché correctamente.

No se comparte una sola caché entre los dos ficheros a propósito: `technology-water.ts` sólo importa
*tipos* de `technology.ts` hoy (`import type { TechnologyActor, TechnologyHost }`), y mantenerlo así
evita introducir un import de valor circular entre ambos sólo para ahorrarse doce líneas duplicadas.

### 2. Capacidad de fauna: `world.tiles.filter(...).length * 3` → recuento de una pasada

```ts
function faunaCapacity(tiles: readonly Tile[]): number {
  let count = 0;
  for (const t of tiles) if (t.terrain !== 'shelter' && (t.growth ?? 0) > 0.04) count++;
  return count * 3;
}
```

Mismo predicado, mismo orden de recorrido, mismo resultado — sin asignar el arreglo intermedio que crea
`.filter()`. `capacity ??= faunaCapacity(world.tiles)` sigue calculándose **como mucho una vez por
llamada a `reproduce`**, es decir una vez por `stepAnimals`, exactamente igual que antes.

**Esto NO es el «recuento incremental mantenido por el paso ecológico» que pide T140.** Ese recuento
exige saber, sin recorrer las teselas, cuándo el `growth` de alguna cruza 0,04 hacia arriba o hacia
abajo. Esas escrituras están en `stepEcosystem` (`ecosystem.ts`, `ecosystem-kernel.ts`) y en
`trampleTile`/`cultivateTile`/`harvestMaterial` (`index.ts`, `ecosystem.ts`), y ocurren en **todos** los
ticks — ninguno de esos ficheros está en el alcance de esta tarea (regla 1), y no hay forma de observar
esas escrituras sólo desde `animals.ts`. Cachear el recuento entre ticks por identidad del arreglo (como
el punto 1) sería **incorrecto**: `world.tiles` no cambia de referencia ni de longitud cuando cambia
`growth`, así que el caché nunca se invalidaría y a partir del segundo tick devolvería un número
equivocado, cambiando `digestoCanonico` — la regla dura del bloque. Se deja propuesto para T140 tal como
ya lo describe `tasks.md`; aquí sólo se quita la asignación del arreglo intermedio, que es lo único
seguro de hacer sin salir del alcance declarado.

## Cómo se prueba

- `npm run typecheck`: verde.
- Tests del módulo, verdes (no la suite completa, regla 7):
  `TMPDIR=/datos/tmp-atlas-lab timeout 900 npx tsx --test tests/technology.test.ts
  tests/technology-water.test.ts tests/technology-water-planning.test.ts
  tests/technology-checkpoint.test.ts tests/technology-society.test.ts
  tests/technology-store-catalogue.test.ts tests/technology-catalogue-runtime.test.ts
  tests/technology-world-context.test.ts tests/organization.test.ts tests/animals.test.ts
  tests/ecosystem.test.ts tests/ecosystem-kernel.test.ts tests/digesto.test.ts` → **189/189**, 0 fallos.
  Además `tests/cultural-transmission.test.ts` y `tests/lifecycle-persistence.test.ts` (usan
  `settleTechnologyEstate`/`transferTechnologyItem` de fondo) → **14/14**.
- `tests/animals.test.ts` ya ejercita `reproduce`/la capacidad de fauna en varios escenarios de
  nacimiento (líneas 143, 155, 204-222, 295-330): pasan sin cambiar ninguna aserción.

## Control de digesto (`scripts/lab/digesto-control.ts`, 2 400 pasos)

Base: worktree temporal `/datos/tmp-atlas-lab/e0w2-base-c8` en `8cc8a6c` (compartido con las tareas
hermanas de esta misma oleada, mismo commit). Rama: este worktree. `TMPDIR=/datos/tmp-atlas-lab`, como
mucho 3 procesos a la vez. «B» es el juego de laboratorio
`persistencia.cadaTicks=300,social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3`
(`social.memoriaDisputa` no existe en esta base, como ya registraron T141/T142/T143; no se usó).

| Semilla | Params | `digestoCanonico` base | `digestoCanonico` rama | Nacimientos / población |
|---|---|---|---|---|
| 7 | por defecto | `2b6392411920e59b…` | idéntico | 0 / 16 |
| 42 | por defecto | `fb7036cb898aa9b3…` | idéntico | 5 / 21 |
| 51926 | por defecto | `bff69c2fdf0ea2b5…` | idéntico | 6 / 22 |
| 7 | B | `ceb05d5b4151eb90…` | idéntico | 0 / 16 |
| 42 | B | `12ab9b88dd578103…` | idéntico | 4 / 20 |
| 51926 | B | `38b08b64eb9d4251…` | idéntico | 6 / 22 |

`completo` y `fisico` coinciden en las 6 corridas. Estas cifras son, además, byte a byte las mismas que
registraron T141/T142/T143 para el mismo commit base y las mismas semillas: la cadena de tareas de esta
oleada no ha cambiado el mundo en ningún punto anterior a esta. Salidas en
`/datos/tmp-atlas-lab/e0w2b-digestos/`.

**Este control no ejerce los cinco sitios de pertenencia a escala** (con 16-22 habitantes,
`host.people.includes` cuesta lo mismo que `isHostMember` dentro del ruido): son órdenes de ejecución de
personas concretas del bloque histórico, no un mundo poblado. Por eso se añadió el banco A/B de abajo,
que sí llama a las cinco funciones reales con `host.people` creciente.

## Banco A/B (funciones reales, población creciente)

Script `/datos/tmp-atlas-lab/e0w2b-bench.mts` (fuera del árbol), mismo patrón que `banco-ab.mts` de T141:
carga los dos árboles en el mismo proceso (dos grafos de módulos) y alterna base/rama en cada repetición,
para que la carga de la torre afecte a los dos por igual. Mundo: `createWorld(51926)` con clones de un
`neighbor` hasta P, todos cerca entre sí. Se llama a la función real de cada árbol (no una reimplementación)
sobre el `host` (`world`) completo; «fría» es la primera pasada sobre `host.people` (construye el `Set`
en la rama nueva) y «caliente» la segunda pasada sobre el MISMO arreglo (sin nacimientos ni muertes de
por medio, la situación normal dentro de un mismo tick). En cada fila se comparan los resultados
devueltos por las dos ramas; las cinco tablas dieron **igual en todas las filas**.
Reproducir: `TMPDIR=/datos/tmp-atlas-lab npx tsx e0w2b-bench.mts <base> <rama>`.

**`payContainedWaterCarry`** (technology-water.ts:283 — también ejercita el mismo camino que `canHandle`,
que usan `fillContainedWater`/`drinkContainedWater`):

| P | antes fría ms | después fría ms | antes caliente ms | después caliente ms | aceleración (caliente) |
|---|---:|---:|---:|---:|---:|
| 200 | 0.113 | 0.250 | 0.039 | 0.041 | 1,0× |
| 800 | 0.411 | 0.411 | 0.199 | 0.133 | 1,5× |
| 2 000 | 0.851 | 0.580 | 0.606 | 0.250 | 2,4× |
| 8 000 | 11.666 | 1.816 | 9.386 | 0.803 | 11,7× |
| 20 000 | 55.374 | 10.596 | 53.441 | 4.466 | 12,0× |
| 50 000 | 296.969 | 15.788 | 295.137 | 10.891 | 27,1× |

**`transferTechnologyItem`** (technology.ts:584, dos comprobaciones por llamada):

| P | pares | antes fría ms | después fría ms | antes caliente ms | después caliente ms | aceleración (caliente) |
|---|---:|---:|---:|---:|---:|---:|
| 200 | 200 | 0.117 | 0.098 | 0.047 | 0.049 | 1,0× |
| 800 | 800 | 0.686 | 0.441 | 0.229 | 0.090 | 2,5× |
| 2 000 | 2 000 | 1.519 | 0.584 | 1.259 | 0.250 | 5,0× |
| 8 000 | 4 000 | 4.509 | 1.473 | 3.954 | 0.383 | 10,3× |
| 20 000 | 4 000 | 4.024 | 2.841 | 4.909 | 0.403 | 12,2× |

**`settleTechnologyEstate`** (technology.ts:605, `recipients.length` = 8 por llamada — el caso real,
la vecindad de una herencia es pequeña; la ganancia es menor porque sólo 8 de las O(P) comparaciones por
llamada se ahorran, no O(P)):

| P | llamadas | antes fría ms | después fría ms | antes caliente ms | después caliente ms | aceleración (caliente) |
|---|---:|---:|---:|---:|---:|---:|
| 200 | 200 | 1.272 | 1.322 | 1.239 | 1.012 | 1,2× |
| 800 | 800 | 6.234 | 2.895 | 3.167 | 4.816 | 0,7× |
| 2 000 | 2 000 | 14.602 | 12.785 | 12.445 | 8.210 | 1,5× |
| 8 000 | 4 000 | 39.389 | 23.260 | 34.530 | 18.730 | 1,8× |
| 20 000 | 4 000 | 48.387 | 39.421 | 41.579 | 27.111 | 1,5× |

El 0,7× de P = 800 es ruido de la torre compartida (dentro de una corrida el orden alterna base/rama para
repartir la carga por igual, pero con `recipients.length` fijo en 8 el tiempo por llamada está dominado
por el resto de `settleTechnologyEstate`, no por la pertenencia): en ninguna repetición individual la
rama nueva perdió de forma sistemática, y la mediana de las demás filas es siempre ≥ 1×.

**Capacidad de fauna** (fórmula equivalente en ambos árboles — `faunaCapacity` no se exporta; se
comparó la técnica `filter+length` contra el recuento de una pasada sobre el mismo arreglo sintético de
teselas, no las funciones importadas):

| Teselas | antes µs | después µs | aceleración | recuentos iguales |
|---|---:|---:|---:|---|
| 5 000 | 72.3 | 6.6 | 10,9× | sí (11 934) |
| 27 000 | 418.0 | 29.4 | 14,2× | sí (64 434) |
| 200 000 | 4 302.8 | 380.8 | 11,3× | sí (477 273) |
| 1 000 000 | 39 047.4 | 12 218.1 | 3,2× | sí (2 386 362) |

Salida completa guardada en `/datos/tmp-atlas-lab/e0w2b-bench-output.md`.

**Lectura.** Los dos sitios que comprueban la pertenencia de UN actor (`payContainedWaterCarry`,
`transferTechnologyItem`) muestran la aceleración esperada: crece con P porque O(P²) (P llamadas × O(P)
cada una) pasa a O(P) (un `Set` construido una vez por época del arreglo + O(1) por llamada). El de
`settleTechnologyEstate` mejora menos porque en producción sólo mira `recipients.length` ≈ 8 candidatos
por llamada, no toda la población: el ahorro por llamada es real pero pequeño frente al resto de la
función (mover objetos, sumar masas). La capacidad de fauna gana un factor constante (evita la
asignación de `.filter()`) que no depende de P, como se explicó arriba: sigue siendo O(teselas) por
llamada, una vez por tick.

## ¿Puede el hardware cambiar el resultado?

**No.** Los dos cambios son puramente mecánicos: `isHostMember` decide EXACTAMENTE lo mismo que
`host.people.includes(x)` (misma igualdad de referencia, mismo arreglo, invalidación determinista por
longitud) y `faunaCapacity` decide EXACTAMENTE lo mismo que `world.tiles.filter(pred).length * 3` (mismo
predicado, mismo recorrido). Ninguno de los dos consulta relojes, hilos, orden de llegada ni memoria
compartida entre workers; los dos corren en la fase serial del paso. Otro hardware sólo cambia cuánto
tardan, nunca qué devuelven.

## Aislamiento (regla 12) y pendientes

- No hay solape de funciones con T141 (`society.ts`, `index.ts`, `rejilla.ts`), T142 (`lineage.ts`) ni
  T143 (`technology-checkpoint.ts`): esta tarea sólo tocó los cinco sitios de pertenencia y la línea de
  capacidad de fauna listados arriba.
- `technology.ts` y `technology-water.ts` también los toca T146 (contadores) y T153 (acumuladores) en
  gates posteriores, en funciones distintas a las de aquí (`useTool`/`craft`, no las de esta tarea).
- **Pendiente para T140/T144** (fuera de alcance, regla 1): el recuento incremental real de la capacidad
  de fauna necesita que `stepEcosystem`, `trampleTile` y `cultivateTile` reporten sus propios cambios de
  `growth`; no es alcanzable sólo desde `animals.ts` sin arriesgar un número distinto al de hoy.
