# T143: padrón incremental del checkpoint tecnológico — exacto, más barato, todavía O(P)

Base: `5e0556f` (rama `sprint/002-e0-t143`). Worktree: `/datos/workspaces/personal/AtlasParaIsa-n-E0-t143`.
Implementación delegada a MiniMax-M3 según el diseño del orquestador; revisión, tests definitivos,
controles y medidas del orquestador (ver «Delegación»).

**Veredicto:** el digesto es idéntico en las 6 corridas de control y el checkpoint es byte a byte el de
antes en 2400 pasos con nacimientos y muertes. El tick sin cambios de padrón cuesta de 3 a 8,5 veces menos
(P = 2000: 70–77 µs → 11 µs). **El cierre «el coste por tick deja de depender de P» NO se cumple.** La
comprobación sigue siendo lineal (≈6 ns por habitante frente a ≈35–65 ns) y la rotación de cada tick con
nacimiento o muerte sigue siendo O(P·objetos): 4–6,5 ms con P = 2000 y 33–47 ms con P = 8000. A partir de
unos cientos de habitantes es el coste real de este sitio. Ver «Qué falta».

## Localización (regla 11)

La cita `technology-checkpoint.ts:90-91` era de `f30d528`. En `5e0556f` el mismo código seguía en
`advanceTechnologyCheckpoint` (línea 100: `const current = new Set(actors.map(actor => actor.id))` y el
`some` sobre `checkpoint.inventories`) y no lo había arreglado otro sprint. Regla 12: ninguna otra tarea
de E.0 declara este fichero ni estas funciones (T140 toca `technology.ts`, no `technology-checkpoint.ts`).

## Qué cambió y por qué

- `src/world/technology-checkpoint.ts`, sólo `advanceTechnologyCheckpoint` más dos piezas nuevas junto a
  ella:
  - `sameIds(list, ids, key)`: compara dos secuencias de ids posición a posición, sin asignar memoria. Lee
    los elementos en el mismo orden que el predicado de antes, así que un elemento `null` o forjado
    falla con el mismo `TypeError` en el mismo punto.
  - `steady`: una entrada de módulo con el último par (ids de `actors`, `actorId` de la apertura) para el
    que el padrón no había cambiado.
  - El predicado de siempre (`|Set(A)| ≠ |I| ∨ ∃ i ∈ I: i ∉ Set(A)`) depende **sólo** de esas dos
    secuencias de strings. Si ambas coinciden posición a posición con el par guardado, el resultado es el
    mismo y no se construye el Set. Si no coinciden, se calcula exactamente como antes y, cuando da «sin
    cambio», se guarda el par. Tras una rotación por cambio de padrón, y sólo si `actors` no repite ids,
    se precarga el par (padrón, apertura recién capturada), para que el tick siguiente a un nacimiento o
    una muerte tampoco construya el Set. Con ids repetidos el predicado daría otro resultado y no se
    precarga.
  - La caché se valida **por contenido, no por identidad**. El servidor clona el mundo en cada paso
    (`motor.clonPorPaso=true`), así que una `WeakMap` por checkpoint, por estado o por array fallaría
    siempre. Con dos mundos intercalados en el mismo proceso, la entrada única falla y se recalcula, sin
    error.
  - No cambian `captureTechnologyCheckpoint`, `assertTechnologyCheckpoint`, `technologyHistoryGap` ni
    la firma de `advanceTechnologyCheckpoint`. La rotación (aserción de la apertura vieja + captura
    nueva) es la misma.
- `tests/technology-checkpoint.test.ts`, ampliado. Los 14 tests anteriores siguen igual. Se añaden un
  oráculo `legacyAdvance`, copia literal de la función de `5e0556f`, y `lockstep`, que exige los mismos
  bytes (`JSON.stringify`, con el orden de claves y de arrays), la misma rotación (se sustituye el objeto
  ⇔ el oráculo lo sustituye) y el mismo error (`String(error)`, con clase y mensaje). Tests nuevos:
  1. **2400 pasos de `createWorld(51926)` con dinámica natural.** Una muerte forzada cada 200 ticks y
     `cloneWorld` cada 300 (el clon por paso del servidor). En cada tick se compara la apertura del
     mundo con la del oráculo aplicado a la apertura anterior. Resultado: 6 nacimientos, 12 muertes,
     18 rotaciones por padrón y aperturas con objetos reales en 2251 de los 2400 ticks.
  2. **Fuzz determinista (mulberry32, semilla 143) de 2400 ticks** con 13 operaciones: alta, baja, alta y
     baja en sitio con la misma longitud, barajar en sitio, renombrar el mismo objeto, id repetido, clonar
     actores y aperturas, objetos nuevos, hueco de historia, apertura invertida en sitio (mismo padrón),
     `actorId` forjado y entrada duplicada. Tiene que ver rotaciones `roster-change` y `history-gap`, y
     errores de la aserción iguales en ambos lados.
  3. Dos mundos intercalados con la caché de una sola entrada.
  4. Casos límite explícitos: reordenar no rota; alta y baja en el mismo tick con la misma longitud rota
     (`roster-change`, `['a','c','d']`); el tick siguiente, clonado o no, conserva la apertura; un id
     repetido no es un cambio de padrón, como antes (el padrón es un conjunto).

## Cómo se prueba

- `npm run typecheck`: verde.
- `timeout 900 npx tsx --test tests/technology-checkpoint.test.ts tests/organization.test.ts
  tests/technology-store-catalogue.test.ts tests/technology-water.test.ts
  tests/technology-world-context.test.ts tests/digesto.test.ts`: **90/90, 0 fallos, 0 omitidos**.
- Los tests nuevos también pasan contra la implementación de `5e0556f` (18/18 en el worktree base): fijan
  la conducta de hoy, no la nueva.
- **Mutantes**, los cuatro detectados por los tests nuevos:
  - M1: el camino rápido no compara la apertura. 1 fallo.
  - M2: se precarga aunque haya ids repetidos. 1 fallo.
  - M3: `sameIds` sólo compara longitudes. 2 fallos.
  - M4: se precarga también en la rotación por hueco. 1 fallo.

## Control de digesto (`scripts/lab/digesto-control.ts`, 2400 pasos)

Mismo script en `5e0556f` (worktree temporal `/datos/tmp-atlas-lab/e0-base-T143`) y en el árbol de
T143, con `TMPDIR=/datos/tmp-atlas-lab` y como mucho 3 procesos a la vez. «Lab B» es
`persistencia.cadaTicks=300,social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3`.
La clave `social.memoriaDisputa=8` del juego de laboratorio **no existe en `5e0556f`** (`parseParams`
la rechaza: sólo está en ramas de laboratorio, no en `main`), así que se corrió sin ella en los dos
árboles.

| Semilla | Params | `digestoCanonico` 5e0556f | `digestoCanonico` T143 | Nacimientos / población final |
|---|---|---|---|---|
| 7 | por defecto | `2b6392411920e59bc7ac095f3a9e5fd7dda6771406524aff71048c7f9304b5d3` | idéntico | 0 / 16 |
| 42 | por defecto | `fb7036cb898aa9b340393c94b164dc8a08477bd9aa4ecd7ebd9ab2f63325543d` | idéntico | 5 / 21 |
| 51926 | por defecto | `bff69c2fdf0ea2b522e284eef760c949c19a98b6eb0ac970f00971e9cc150a5f` | idéntico | 6 / 22 |
| 7 | lab B | `ceb05d5b4151eb90a9fbe605d093d1af637b44221bde47f820170d700bafd413` | idéntico | 0 / 16 |
| 42 | lab B | `12ab9b88dd578103c584aa074e4cfad0b6cc65b9a79e76c5866ff0fc8d5520fc` | idéntico | 4 / 20 |
| 51926 | lab B | `38b08b64eb9d4251a954908c0cb1dff68aec437ce638760fadcd54740fe530bb` | idéntico | 6 / 22 |

`completo` y `fisico` coinciden en las 12 salidas. La semilla 7 no cambia de padrón en 2400 pasos, así
que ejerce sólo el camino rápido. Las otras dos ejercen también rotaciones por nacimiento. El test 1
completa la cobertura de muertes y clones.

## Coste del sitio, antes/después

Microbanco `/datos/tmp-atlas-lab/t143/bench-checkpoint.mts <árbol>`, fuera del árbol: una llamada a
`advanceTechnologyCheckpoint` con P fija y actores sintéticos con 0–3 objetos reales de una receta
fabricada en el mundo. Base y T143 corrieron **a la vez, dos rondas**, con la torre cargada (carga
media 50–56 en 32 hilos por otros laboratorios). Cifras en p50 (µs), ronda 1 / ronda 2.

| Escenario | P | 5e0556f | T143 |
|---|---:|---:|---:|
| quieto (padrón sin cambios) | 50 | 3,2 / 3,1 | 1,04 / 1,05 |
| | 200 | 9,6 / 10,1 | 3,6 / 3,7 |
| | 800 | 29,2 / 29,5 | 4,3 / 4,4 |
| | 2000 | 76,7 / 70,4 | **11,4 / 10,9** |
| | 8000 | 507 / 521 | **62 / 60** |
| clonado (actores y apertura recién clonados, como en el servidor) | 800 | 508 / 584 | 262 / 293 |
| | 2000 | 1359 / 1460 | 695 / 818 |
| | 8000 | 4906 / 4420 | 2231 / 2293 |
| tick tras una rotación | 2000 | 129 / 139 | 12,0 / 14,2 |
| | 8000 | 1049 / 1859 | 211 / 162 |
| relevo (alta + baja: rotación completa) | 800 | 1155 / 1406 | 1316 / 1343 |
| | 2000 | 4878 / 6523 | 4129 / 5053 |
| | 8000 | 35 989 / 34 457 | 46 822 / 33 061 |

Lectura:

- El tick quieto baja de ≈35–65 ns por habitante a ≈5,5–7,5 ns, de 3 a 8,5 veces según P. Sin clon es
  el caso de casi todos los ticks.
- Con el clon por paso, las strings recién copiadas se comparan por contenido y la mejora queda en ≈2×.
- La rotación no cambia: la diferencia está dentro del ruido del host compartido. Su coste crece más que
  linealmente (≈2,5 µs por habitante con P = 2000 y ≈4,3 µs con P = 8000), por la aserción de la apertura
  vieja, la copia de todos los inventarios y las dos ordenaciones con `localeCompare`. Desglose medido en
  la base con P = 2000: aserción ≈1,5 ms, captura ≈2,5 ms (de ella ≈0,6 ms la ordenación de ids) y
  comprobación con Set ≈0,14 ms.

## Qué falta (el cierre de la tarea no se alcanza)

1. **El tick quieto sigue siendo O(P).** Son 2P comparaciones sin memoria nueva, no hashing ni
   asignación. Nada dentro de `(state, actors, tick)` permite saber en O(1) y de forma exacta que el
   padrón no cambió: los arrays y los objetos son mutables y el clon por paso rompe cualquier identidad.
   Bajar a O(1) necesita una señal de altas y bajas desde `stepWorld`, por ejemplo `world.birthCounter` y
   el recuento de muertes, o una versión del padrón que suban `reproduce`, `advancePopulation` y la carga.
   Eso toca `src/world/index.ts`, fuera de los ficheros de T143 (regla 1). Se deja propuesto para T144,
   T145 o la integración.
2. **La rotación sigue siendo O(P·objetos).** El checkpoint es por definición una foto completa de las
   existencias en la frontera. Con P = 8000 casi cada tick tiene un nacimiento o una muerte, y la rotación
   cuesta 33–47 ms por tick, del orden del presupuesto entero del gobernador (50 ms). Hay dos formas de
   bajarla sin cambiar la regla, las dos fuera de este fichero y con riesgo semántico que merece su propia
   tarea y revisión adversarial:
   - (a) llevar en `technology.ts` qué inventarios cambiaron desde la última captura, para recapturar
     sólo esos y reutilizar las demás entradas; hay que cuidar el orden de claves y el `-0` para que la
     apertura siga siendo byte a byte la misma;
   - (b) memorizar la aserción de una apertura ya validada que no se haya tocado.

   Espaciar las rotaciones sería un cambio de regla (FR-020).
3. No se marcan casillas de `tasks.md`: lo hace la integración.

## ¿Puede el hardware cambiar el resultado?

**No.** La caché sólo decide si se recalcula el predicado, nunca qué devuelve. Compara contenido, no
identidades, tiempos ni memoria. Corre en la fase serial del paso y no depende de hilos, reloj, reparto ni
del número de mundos del proceso. El orden de la captura (`localeCompare`, que depende de la
configuración regional del proceso) es el de antes y no se tocó.

## Delegación

- **MiniMax-M3** (`access=write`, 17 min) implementó `advanceTechnologyCheckpoint` tal como decía el
  diseño. Se aceptó, con los comentarios reescritos y el flujo de control compactado.
- Sus tests se reescribieron:
  - el test de mundo ponía a todos a descansar (`decisionAt=10000`), así que nadie fabricaba objetos y
    las aperturas comparadas iban vacías;
  - la identidad de rotación se tomaba antes de la operación, y las operaciones de clon la hacían
    trivialmente cierta;
  - no cubría el hueco de historia;
  - reanclaba en el tick 0.

  Los tests definitivos son del orquestador.
