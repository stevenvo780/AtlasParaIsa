# E0W2C: los dos cuadráticos de `advancePopulation` que T142 dejaba pendientes

Base: `8cc8a6c` (E.0 ola 1 integrada: T141 rejilla de personas, T142 poda de vínculos, T143 roster
del checkpoint). Rama `sprint/002-e0-w2c`, worktree `/datos/workspaces/personal/AtlasParaIsa-n-E0-w2c`.
Commits del cambio: `ea214ab` (código) y `828ae0a` (tests). El propio informe de T142
(`specs/002-mundo-ilimitado/informes/T142-report.md`, sección «Relevancia para T144») nombra
explícitamente estos dos sitios como los que quedaban fuera de su alcance:

> Quedan dos términos en `advancePopulation`, fuera del alcance de T142:
> - `dying.find(...)` dentro del bucle de registros (≈ línea 187): O(muertes²)…
> - el `world.structures.filter` de refugio por persona dentro de `transitions`:
>   O(P × estructuras) cuando `shelterBenefitEnabled`.

Esta tarea (E0W2C) cierra esos dos términos.

## Ejecución

Delegado a `codex/gpt-5.6-sol` (`effort: high`, `access: write`) con un prompt autocontenido (regla de
identidad, alcance exacto, prohibición de tocar `src/world/indices.ts` aunque exista por trabajo
paralelo, prohibición de commitear). Terminó en ~508 s dentro del timeout de 1500 s, con el diff hecho
y sin commitear (`HEAD` seguía en `8cc8a6c`). El orquestador revisó el diff línea a línea, corrió
`typecheck` y los tests del módulo, midió coste antes/después con un banco propio, corrió el control
de digesto en un worktree temporal del commit base y en la rama, y creó los commits.

## Qué cambió (solo `src/world/lineage.ts`, función `advancePopulation`)

1. **`dying.find(...)` dentro del bucle de `records`** (O(muertes²)): `records` es la proyección 1:1
   de `dying` (mismo orden, mismo filtro), así que antes del bucle se construye una vez
   `dyingById = new Map(dying.map(r => [r.person.id, r.person]))`, y dentro del bucle se usa
   `dyingById.get(record.id)!` en vez de recorrer `dying` por cada `record`.
2. **`world.structures.filter(...)` de refugio por persona** (O(P × estructuras)): se construye, una
   sola vez por llamada y solo si `world.shelterBenefitEnabled` (la única rama que lo consume), un
   índice **local** (variable dentro de la función, no un campo de `World`, no un fichero nuevo)
   `Map<string, StructureView[]>` que agrupa `world.structures` por celda `` `${x},${y}` ``, aplicando
   el mismo filtro (`condition > BROKEN_CONDITION && components.includes('roof')`) al construirlo y
   conservando el orden relativo de las estructuras de una misma celda. Cada persona consulta su celda
   en vez de recorrer el array completo.

No se creó `src/world/indices.ts` ni se tocó ningún otro fichero de `src/world`. Si E0W2A crea ese
índice compartido en paralelo, la integración deberá decidir si unifica este índice local de
`advancePopulation` con el suyo; por ahora son independientes y no colisionan porque nadie más lo
importa. No se tocó `pruneBonds` ni la decisión de bidireccionalidad de `bonds` (eso queda para el
integrador). No se usó `Math.random`, `Date.now` ni `performance.now` en ningún fichero de `src/world`.

## Cómo se prueba

- `npm run typecheck`: verde.
- `TMPDIR=/datos/tmp-atlas-lab timeout 300 npx tsx --test tests/lineage.test.ts tests/lineage-numeric-identity.test.ts`:
  **17/17**, 0 fallos, 0 omitidos (~1 s).
- Dos tests nuevos en `tests/lineage.test.ts` (los 15 anteriores no se tocaron):
  1. 160 muertes simultáneas con posiciones únicas: cada evento `death` y su `LegacyRecord` (mismo
     índice de iteración) se comparan contra la posición que tenía esa persona antes de llamar a
     `advancePopulation`, capturada en un `Map` aparte. Ejerce directamente la corrección 1: un
     emparejamiento persona/record incorrecto rompe este test.
  2. Cinco celdas con los casos límite del filtro de refugio (una estructura con techo; dos con techo
     donde debe ganar la de mayor `condition`; una rota justo en `BROKEN_CONDITION`; una sin `'roof'`
     entre sus `components`; una celda vacía), comparando la demografía real tras `advancePopulation`
     contra un oráculo que recalcula `shelter` con el `.filter()` original.

No se ejecutó `npm test` completo ni `npm run build`/`npm run check` en este árbol.

## Control de digesto (`digestoCanonico`, `scripts/lab/digesto-control.ts`)

Worktree temporal del commit base en `/datos/tmp-atlas-lab/e0w2-base-c8` (8cc8a6c, sin el cambio) frente
a esta rama, 2400 pasos:

| semilla | params | base (8cc8a6c) | rama (E0W2C) | |
|---|---|---|---|---|
| 7 | por defecto | `2b6392411920e59b…` | `2b6392411920e59b…` | igual |
| 42 | por defecto | `fb7036cb898aa9b3…` | `fb7036cb898aa9b3…` | igual |
| 51926 | por defecto | `bff69c2fdf0ea2b5…` | `bff69c2fdf0ea2b5…` | igual |
| 7 | banco B | `ceb05d5b4151eb90…` | `ceb05d5b4151eb90…` | igual |
| 42 | banco B | `12ab9b88dd578103…` | `12ab9b88dd578103…` | igual |
| 51926 | banco B | `38b08b64eb9d4251…` | `38b08b64eb9d4251…` | igual |

(«banco B» = `persistencia.cadaTicks=300,social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3`;
`social.memoriaDisputa` no existe en esta base, como ya notó T142, así que no se incluyó.)

**Este control apenas ejerce el cambio**: con estos parámetros casi no hay muertes en 2400 pasos y las
estructuras del mundo inicial son pocas, igual que constató T142. Por eso, además, se montó un mundo
poblado con estructuras (herramienta propia en `/datos/tmp-atlas-lab/e0w2c-tools/sitio.mts`, mismo
régimen que `t142-tools/escena.mts`: `createWorld` + `activate` de chunks + clonado de una plantilla de
persona, sin `Store`) con **2000 personas, 200 muertes simultáneas y 8000 estructuras de refugio**
(4 por celda, condiciones distintas para forzar el `Math.max`), `shelterBenefitEnabled=true`,
clima `'rain'` y terreno `'shelter'` forzado en cada celda ocupada:

| escenario | base (8cc8a6c) | rama (E0W2C) |
|---|---|---|
| 2000 personas, 200 muertes, 8000 estructuras | `4b84eff72dfd7afd…` | `4b84eff72dfd7afd…` — igual |

## Coste medido (el sitio: `advancePopulation` completo, torre compartida, mediana de 5 repeticiones)

**Ambas correcciones ejercidas a la vez** (estructuras y muertes crecen con P, `estructurasPorCelda=4`,
`D=P/10`):

| P | muertes | estructuras | antes (ms) | después (ms) | razón |
|---|---|---|---|---|---|
| 500 | 50 | 2 000 | 14,9 | 10,8 | 1,4× |
| 2 000 | 200 | 8 000 | 43,2 | 15,5 | 2,8× |
| 4 000 | 400 | 16 000 | 136,3 | 39,5 | 3,5× |
| 8 000 | 800 | 32 000 | 580,9 | 73,9 | 7,9× |

**Corrección 2 aislada** (`world.structures.filter` de refugio; D=1, para que el término de muertes no
pese): el «antes» crece con P² (16× P ⇒ ≈42× tiempo), el «después» crece con P (16× P ⇒ ≈7,5× tiempo,
dominado por el resto de `advancePopulation`, O(P), no por el refugio):

| P | estructuras | antes (ms) | después (ms) | razón |
|---|---|---|---|---|
| 500 | 2 000 | 20,2 | 12,8 | 1,6× |
| 1 000 | 4 000 | 31,8 | 14,4 | 2,2× |
| 2 000 | 8 000 | 81,1 | 29,8 | 2,7× |
| 4 000 | 16 000 | 260,8 | 46,5 | 5,6× |
| 8 000 | 32 000 | 851,4 | 96,3 | **8,8×** |

**Corrección 1 aislada** (`dying.find`; sin estructuras, P=4000 fijo, D creciente hasta casi agotar la
población, que es donde el término O(muertes²) empieza a pesar frente al resto de `advancePopulation`,
que es O(P)):

| P | muertes | antes (ms) | después (ms) | razón |
|---|---|---|---|---|
| 4 000 | 50 | 29,2 | 34,0 | 0,9× (ruido; el término no pesa aquí) |
| 4 000 | 500 | 43,4 | 47,3 | 0,9× (ruido) |
| 4 000 | 2 000 | 78,4 | 78,2 | 1,0× |
| 4 000 | 3 900 | 159,8 | 87,5 | **1,8×** |

Con pocas muertes relativas a P el término O(muertes²) es despreciable frente al resto de la función
(coherente con T142: «con P ≤ 2000 y como mucho una muerte por paso, la poda cuesta menos de 0,4 ms»);
se vuelve visible solo cuando las muertes se acercan a la población total, el caso de mortandad masiva
que la corrección cubre.

## Regla 10 — ¿puede el hardware cambiar el resultado de este cambio?

**No.** El cambio sustituye un recorrido lineal/cuadrático por una tabla hash (`Map`) construida en un
solo hilo, sin `Atomics`, sin GPU, sin reparto por núcleos y sin ningún nuevo punto de suma en coma
flotante: el `Math.max(0, ...)` que decide el `shelter` de una celda sigue siendo la misma operación
conmutativa sobre el mismo conjunto de valores, solo que ahora se itera un subconjunto (los de esa
celda) en vez de filtrar el array completo en cada persona, y `dyingById.get(id)` devuelve exactamente
la misma persona que devolvía `dying.find(...)`. El orden de iteración de `records` (y por lo tanto el
de los eventos emitidos) no cambia. Nada aquí depende de cuántos núcleos, qué CPU o qué GPU tenga la
máquina: el resultado —y el `digestoCanonico`— es el mismo en cualquier hardware, como confirman los
seis controles de semilla/parámetros y el control de mundo poblado de arriba.

## Pendiente / notas para la integración

- El patrón `world.structures.filter(s => s.x === point.x && s.y === point.y && …)` se repite, idéntico
  en su forma, en `src/world/index.ts:312-313` (una función de refugio para otro punto de consulta) y en
  varios sitios de `src/world/inventions.ts` — **fuera del alcance de esta tarea** (T140 ya los tiene
  asignados, con su propio índice en `src/world/indices.ts`). Si la integración quiere un único índice
  de estructuras por celda compartido entre `lineage.ts` y esos sitios, el índice local que agrega esta
  tarea es un candidato a fusionarse con el de T140, pero esa decisión es del integrador: aquí se dejó
  deliberadamente local para no tocar ficheros fuera del alcance asignado.
- La herramienta de medición (`/datos/tmp-atlas-lab/e0w2c-tools/sitio.mts`) y el worktree temporal del
  commit base (`/datos/tmp-atlas-lab/e0w2-base-c8`) quedan fuera del repositorio, no se commitean.
