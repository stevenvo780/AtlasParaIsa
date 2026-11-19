# Rejilla espacial de fauna — informe (perf-fauna-rejilla-20261119)

- **Rama / worktree**: `sprint/perf-fauna-rejilla-20261119`.
- **Alcance**: optimización pura sin cambio de reglas. `RULES_VERSION` sigue en 11; no se toca
  ninguna fórmula de decisión, ningún parámetro ni ningún fichero fuera de
  `src/world/animals.ts`, `src/world/index.ts` (solo `huntPlan` y el ciclo de vida por paso),
  `tests/fauna-rejilla.test.ts` y este informe.
- **Origen**: cuellos §4.2 y §4.4 de [T144-report.md](T144-report.md)
  (`O(P_dec · A)` en caza/recolección y barrido `O(T)` en capacidad de cría).

## 1. Qué se hizo

### 1.1 Rejilla de fauna (`src/world/animals.ts`)

Nueva rejilla efímera con la misma filosofía que `src/world/rejilla.ts` (personas):

- `conRejillaFauna(world, fn)` abre el ámbito del paso; lo abre `stepWorld`
  (`src/world/index.ts`, anidado dentro de `conRejilla`). Fuera del ámbito no hay índice.
- `animalesVivosEnCelda(world, x, y)` devuelve los animales vivos de la celda exacta en
  **orden de slot**, o `undefined` fuera del ámbito / con la rejilla inválida. Cada celda
  exacta (`cellXY`, la misma clave de celda del módulo) guarda sus slots en orden creciente
  y las coordenadas y la salud se evalúan en vivo, así que el resultado es objeto a objeto
  el de `world.animals.filter(a => a.x === x && a.y === y && a.health > 0)`.
- Construcción perezosa `O(A)` en la primera consulta del paso. Exactitud dentro del paso:
  - `move` es el único escritor de `x`/`y` y avisa con `animalMovido` (reubica el slot
    manteniendo el orden creciente de la celda destino).
  - Un nacimiento solo alarga el arreglo: `sincronizarRejillaFauna` anexa los slots nuevos.
  - Los escritores que reemplazan el arreglo (`stepAnimals`, `harvestAt`) refrescan el
    ámbito (`refrescarAmbitoFauna`); al cerrar la fauna del paso, `invalidarRejillaFauna`
    descarta el índice porque `ordenCanonico` puede reordenar el mismo arreglo en el sitio
    sin cambiar identidad ni longitud. La siguiente consulta reconstruye en `O(A)`.
  - Un animal repetido en el arreglo invalida la rejilla y el llamador cae al recorrido
    lineal, idéntico por definición.
- Nada de la rejilla entra en el mundo ni en su digesto (ámbitos en `WeakMap` por mundo).

### 1.2 Consumidores

- `huntPlan` (`src/world/index.ts`): la víctima sale de `animalesVivosEnCelda`; como la
  rejilla devuelve orden de slot, el menor `id` con desempate por slot (primero en ese
  orden) es exactamente el `[0]` del `filter(...).sort(por id)` anterior, sin ordenar la
  celda. Si la rejilla no responde (`undefined`), se ejecuta el `filter(...).sort(...)`
  literal de siempre. Ese respaldo mantiene además intacto el inventario de
  `tests/halo-radios.test.ts` (la lectura sigue fijada como `decision.caza`, radio 0).
- `harvestAt` (`src/world/animals.ts`): misma doble vía; sin rejilla usa el
  `world.animals.filter(...)` literal anterior. Se conserva `!world.tiles.some(...)`,
  el borrado por `id` y `syncFauna(...)` sin cambios.

Coste por decisión de caza: de `O(A)` por tesela candidata a `O(ocupantes de la celda)`
tras una construcción `O(A)` por paso (más una reconstrucción `O(A)` por cosecha
completada, que son escasas frente a las decisiones).

### 1.3 `faunaCapacity` (§4.4 de T144): verificado, sin contador que reutilizar

Se comprobó en el árbol que **no existe contador incremental** de teselas con
`growth > 0.04` (ni en `animals.ts` ni en índices/ecosistema). Mantener uno exacto desde
este módulo es imposible sin tocar a los escritores de `growth`: el kernel ecosistémico
reescribe `growth` de las teselas cada paso fuera del alcance permitido de ficheros, y un
contador desactualizado cambiaría los nacimientos y por tanto `digestoCanonico` (es la
misma conclusión que ya documenta el comentario de `faunaCapacity`, propuesta T140).
Por eso se conserva el recuento exacto, que ya es perezoso y único por paso
(`capacity ??= faunaCapacity(world.tiles)` en `reproduce`: solo se calcula si hay una
pareja elegible). Eliminar el `O(T)` exacto queda pendiente de que el paso ecológico
reporte sus deltas, fuera del alcance de esta tarea. No se introduce ninguna
aproximación: el valor es bit a bit el mismo.

## 2. Microbenchmark (torre, 1 hilo, `tsx`)

Consulta tipo `huntPlan`: 1 000 consultas de celda (`P = 1 000`) sobre `A` animales,
50 rondas tras calentamiento; construcción de la rejilla medida aparte, una vez por paso.

| A | Lineal `filter` (ms/ronda) | Rejilla (ms/ronda) | Construcción (ms) | Aceleración |
|---:|---:|---:|---:|---:|
| 2 000 | 2,333 | 0,126 | 0,966 | **18,6×** |
| 8 000 | 10,617 | 0,138 | 1,975 | **77,0×** |

El coste por ronda de la rejilla es casi plano en `A` (solo depende de los ocupantes de
la celda), mientras el filtro crece linealmente: es la eliminación del término
`O(P_dec · A)`. La construcción (≈0,5 µs/animal) se amortiza en el primer paso con unas
pocas decisiones de caza. La misma comparación corre como prueba en
`tests/fauna-rejilla.test.ts` (30 rondas, `P = 1 000`, `A = 2 000`) y exige
`msRejilla < msLineal`.

## 3. Paridad bit a bit

`digestoCanonico` tras 1 200 pasos con `stepWorld`, calculado con el código anterior a
la rejilla y repetido con la rejilla: idéntico en las tres semillas. Los valores base
quedan fijados en `tests/fauna-rejilla.test.ts`:

| Semilla | Digesto tras 1 200 pasos |
|---:|---|
| 7 | `94e1b21419c8cc6ebe73fe6dcb6d7a235c21b2c2052ae9b97a5532893c88840d` |
| 42 | `b12d70edacdef79d428660728577f9544239d636a242a0bdf8c69e1b0dd869ff` |
| 51926 | `95c577d0c6690a3cedd0027da3b8130a4d05a88c2e1b9837720f24339a6bdc61` |

Paridad adicional con fauna viva (mundo 51926 llevado a 1 200 pasos y 240 pasos más):
rejilla activa frente a rejilla desactivada (`sinRejillaFaunaParaPruebas`, recorrido
lineal) dan el mismo digesto.

## 4. Verificación ejecutada

- `npm run typecheck` — verde.
- `npx tsx --test tests/fauna-rejilla.test.ts tests/fauna-mascara.test.ts tests/halo-radios.test.ts tests/auditoria-reglas-motor.test.ts tests/indices.test.ts`
  — **39/39 en verde** (5 de la rejilla: equivalencia exacta en orden de slot con
  coordenadas negativas y hasta 6 por celda, víctima de caza, paridad 1 200 pasos en
  7/42/51926, paridad con fauna viva y microbenchmark).
- `tests/fauna-total.test.ts` — verde.
- Sin `performance.now` / `Date.now` / `Math.random` nuevos en `src/world/`
  (la auditoría de reglas lo vigila y pasa).
