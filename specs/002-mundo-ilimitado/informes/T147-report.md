# T147 — SoA caliente de persona conservando el orden de iteración

## Ficheros tocados

- `src/world/soa/personas.ts` (nuevo): `PersonStore`, la SoA caliente de personas.
- `src/world/society.ts` (solo un helper puro nuevo, `topSkillByInsertionOrder`; ninguna ley ni función existente cambia).
- `tests/soa-personas.test.ts` (nuevo): la suite de la tarea.
- `specs/002-mundo-ilimitado/informes/T147-report.md` (este informe).

No se ha tocado `halo.ts`, ni `RULES_VERSION` (sigue en 11), ni ninguna ley de simulación, ni ningún otro fichero. `tasks.md` no se marca por la regla de aislamiento estricto de esta tarea (solo los cuatro ficheros de arriba).

## Nota previa (regla 11 de `tasks.md`)

La cita `society.ts:183` de la tarea ya no existe en este árbol: la expresión `Object.keys(person.skills).filter(…).sort((a,b) => skills[b]-skills[a])[0]` desapareció en refactorizaciones posteriores. El `practicedSkillToTeach` vigente (`src/world/society.ts`) no ordena habilidades: devuelve la acción del aprendiz si el maestro la ha practicado. El requisito de fondo sigue intacto y es el que se implementa y se prueba: **con dos habilidades empatadas, el desempate es el orden de inserción del `Record`, y el SoA debe conservarlo**. Por eso el helper puro de desempate vive ahora en `society.ts` y las pruebas lo contrastan contra el SoA en ambos órdenes de inserción.

## Diseño

- **Página caliente fija por slot: 782 B/habitante** (objetivo ≤ 1024 B). Columnas columnares en tres buffers: 78 columnas `Float64` (posición, cuerpo, rasgos, cultura, materiales, los 14 alelos del genoma, demografía, marcas de tiempo, residencia tecnológica), 37 columnas `Int32` (cadenas internadas y rangos `[inicio, cuenta)` de cada piscina) y 6 columnas `Uint8` (rol, acción, contexto de intención, modo de control, orden de comando, causa de muerte) más una palabra `Uint32` de banderas de presencia para los opcionales (`lastInvention`, `home`, `waterMemory`, `conflictMemory`, `blueprintId`, marcas de agua tecnológicas).
- **Piscinas variables** tras la página caliente, compactadas al terminar `pack` para que los bytes medidos sean los buffers finales, sin holgura de crecimiento:
  - `visited` como pares `Int32` (la forma `x,y` que `assertWorld` ya exige).
  - `skills`, `activity`, `values` y la competencia tecnológica como registros `(clave internada, orden de inserción explícito, valor)`: la columna de orden es el dato que conserva el desempate.
  - `bonds` como aristas indexadas `(destino internado, orden, valor)`, en el orden de claves original.
  - Experiencias (tick + tres cadenas internadas), hábitos y su evidencia, recetas conocidas, aprendizajes, e ítems tecnológicos (composición, masa y las 12 propiedades en columnas) en piscinas propias.
  - Cadenas en una piscina internada única (`Uint8Array` UTF-8 + offsets), compartida por ids, textos, claves de registro y destinos de vínculo.
- **Spill por referencia**: lo que no tiene forma cerrada — el proyecto tecnológico en curso (`technology.project`) y cualquier clave ajena a `Person` — no se duplica: viaja por índice a una tabla de referencias del almacén (contada a 16 B por índice en `bytes`). Todo lo demás es buffer propio y se cuenta entero.
- `unpack` reinserta cada `Record` ordenando por la columna de orden, así que `Object.keys` de `skills`, `activity`, `values`, `bonds` y `technology.competence` sale idéntico al original. `PersonStore.topSkill(slot)` aplica el mismo desempate sin salir del SoA (valor máximo; en empate, menor orden), y `topSkillByInsertionOrder` en `society.ts` es la misma regla sobre la forma objeto.
- Lo no representable lanza `RangeError` con el campo culpable (enumerado desconocido, `visited` que no es un par entero, genoma sin 14 alelos, tick fuera de `Int32` en las piscinas): el almacén falla en voz alta en vez de perder datos en silencio.

## Cómo se prueba

`tests/soa-personas.test.ts` (5 pruebas):

1. **Empate dedicado, en ambos órdenes**: dos personas con `{gather: 0.5, farm: 0.5, …}` insertado en orden contrario. Antes de empaquetar el desempate da `gather` en una y `farm` en la otra (la prueba muerde: si el orden se perdiera, ambas darían lo mismo). Tras la ida y vuelta, `Object.keys(skills)`, `store.skillsOrder`, `store.topSkill` y `topSkillByInsertionOrder` (con y sin orden explícito) eligen exactamente la misma habilidad en cada una; también se conserva el orden de `bonds`.
2. **Ida y vuelta real**: todas las personas de un mundo real (semilla 51926) tras 1200 pasos: `deepStrictEqual` contra las originales, orden de claves de los cinco registros por persona, y `digestoCanonico` idéntico al sustituir `world.people` por las desempaquetadas en un clon del mundo.
3. **Control de trayectoria**: un mundo desempaquetado y el original avanzan 120 pasos más y siguen dando el mismo `digestoCanonico`.
4. **Bytes medidos**: mundo real envejecido 600 pasos, llevado a 1000 habitantes clonando vecinos reales con textos propios por habitante (para que la piscina internada no deduplique la medida): `bytesPerPerson` sobre los buffers reales del almacén ≤ 4096 y página caliente ≤ 1024.
5. **Bordes**: opcionales presentes/ausentes, `-0` en una habilidad, registros vacíos, comando dirigido, y `RangeError` ante `visited` malformado, acción desconocida y slot fuera de rango.

Verificación ejecutada en este worktree:

- `npm run typecheck` — verde, 0 errores.
- `npx tsx --test tests/soa-personas.test.ts tests/halo-radios.test.ts` — **13/13 verdes, 0 fallos**.
- No se ha ejecutado `npm test` completo ni `npm run build`, como manda la tarea.

## Cifras medidas

| Medida | Valor |
|---|---:|
| Página caliente (`HOT_BYTES_PER_PERSON`) | 782 B/habitante (techo 1024 B) |
| Mundo real 1000 hab. (600 pasos + clones de vecinos reales con textos propios) | **2581,3 B/habitante** (bytes totales 2 581 296; techo 4096 B) |
| Mundo orgánico 19 hab. tras 600 pasos | 2079,8 B/habitante |
| Mundo orgánico 23 hab. tras 1200 pasos | 2763,0 B/habitante |
| Mundo orgánico 23 hab. tras 2400 pasos | 4194,7 B/habitante |

La última fila supera el techo: con 23 habitantes la parte compartida de la piscina de cadenas (claves de receta, de habilidad y de vínculo) no se amortiza y cada habitante arrastra ya el máximo de experiencias, `visited` e ítems. El presupuesto de la tarea se verifica donde la tarea lo pide — un mundo real de 500–2000 habitantes — y ahí se cumple con margen (2581 B a 1000 habitantes, con textos únicos por habitante). Como referencia, una `Person` real tras 1200 pasos ocupa ~5,4 KB serializada en JSON: el SoA la deja en ~2,6 KB a escala.

Control de digesto (antes/después): el digesto del mundo con las personas desempaquetadas es **idéntico** al del mundo original tras 1200 pasos, y sigue idéntico tras avanzar ambos 120 pasos más. Sin el cambio no hay «después» distinto que medir: el almacén no está cableado al paso, es una representación; por eso el control es la ida y vuelta y la trayectoria compartida, no una segunda implementación del motor.

## Hardware y resultado

**El hardware no puede cambiar el resultado de este cambio**: `PersonStore` es aritmética entera y `Float64` sobre buffers con un orden de recorrido fijo por slot y por columna de orden; no lee el número de hilos, ni particiones, ni GPU, ni reloj, y la ida y vuelta es exacta bit a bit (incluidos `-0` y el orden de inserción), así que cualquier máquina que ejecute el mismo `pack`/`unpack` obtiene las mismas personas y el mismo `digestoCanonico`.

## Pendiente fuera de alcance

- Cablear el SoA al motor (que la fase de personas lea/escriba el almacén en vez de objetos) es trabajo de T145/T152, no de T147: aquí el almacén se entrega probado como representación sin pérdida.
- Marcar T147 como cerrada en `tasks.md` corresponde a la integración, fuera del aislamiento de ficheros de esta tarea.
