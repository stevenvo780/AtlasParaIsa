# Tasks: Mundo ilimitado — el techo lo pone el hardware

**Input**: [spec.md](spec.md) + [plan.md](plan.md) + [research.md](research.md) + los 3 juicios y 4 mapas de `.superpowers/sdd/002/` · **Branch**: `002-mundo-ilimitado` (desde **`f30d528`**) · **Constitución**: manda.

**Meta** (Steven, literal): «hay que ajustar el software para que aproveche al máximo el hardware para que la simulación pueda crecer sin parar». **Requisito no negociable**: con N hilos, con otra geometría de particiones o con GPU, el mundo es **idéntico bit a bit** al de 1 hilo.

---

## Reglas de ejecución (para TODO delegado, de cualquier proveedor)

1. **Un solo workstream**: toca SOLO los ficheros listados en tu tarea. Si necesitas algo de otro fichero, escríbelo en tu informe, no lo edites.
2. **El reparto no entra en la regla**: PROHIBIDO `n/hilos`, `availableParallelism()`, `os.cpus()`, reparto por capacidad medida, y cualquier constante de partición **dentro de una fórmula del mundo**. El reparto decide **quién** calcula, jamás **qué** sale. Un diff que viole esto es ❌ automático, pase o no pase los tests.
3. **Determinismo**: nada de `Math.random`, `Date.now` ni `performance.now` en `src/world`. Usa `localRandom(seed, sal)` o `hash(seed, …)`, que ya existen. `world.rng` se queda donde está (clima, fase serial).
4. **Reducciones**: orden total **por contenido** — `(celda, slot)` en confirmación, `(regiónId, slot)` en la fase global, `id.localeCompare` donde ya se usa. Nunca «orden de llegada». `Atomics` solo para barreras, estado de worker y colas: **nunca** para acumular FP64, decidir ganadores ni asignar ids. Nunca sumas en árbol.
5. **Puerta de calidad**: el digesto es `digestoCanonico` (T101), **no** `encodeSnapshot` — ese borra `retiredChunks` y depende del orden de inserción de las claves. Si tu tarea no declara un cambio de reglas, el digesto DEBE ser idéntico antes y después.
6. **GPU**: FP64 siempre, `--fmad=false` siempre, fast-math jamás. Sin excepciones ni «tolerancias».
7. Antes de terminar: `npm run typecheck` verde y `timeout 600 npx tsx --test <tus tests>` verde. **NO** ejecutes `npm test` completo (≈10 min; lo corre la integración) ni `npm run build`/`npm run check` en el árbol principal (**el servidor público sirve `dist/` en caliente desde aquí**).
8. No toques `data/`, `~/.local/bin/atlas-servidor*`, la carta (S e I, recuerdos, textos de `world-shell.ts`), ni las leyes de hambre/sed/senescencia/diversidad/costes materiales.
9. Escribe código que lea como el circundante: denso, comentarios escasos y precisos, español en textos de usuario, inglés en identificadores.
10. Informe final en `.superpowers/sdd/002/tareas/<TID>-report.md`: ficheros tocados, qué cambió y por qué, cómo se prueba, cifras medidas (ANTES/DESPUÉS con control) y **una frase explícita sobre si el hardware puede cambiar el resultado de tu cambio**.
11. **Las citas `fichero:línea` son indicativas**: están reescritas contra `f30d528` (2026-09-19), pero el árbol se mueve. **Localiza por contenido con `grep`, no por número**, y si el código que tu tarea describe ya no está donde dice, escríbelo en el informe antes de tocarlo — puede que otro sprint ya lo haya arreglado (le pasó a la refutación R12).
12. **Aislamiento de las tareas `[P]`** (regla añadida 2026-09-19, refutación G5): dos tareas `[P]` de la **misma oleada** no pueden declarar en su alcance la misma **función**, ni un bloque de código que la otra reescribe por completo, aunque el fichero se reparta «en partes distintas». Cada worktree parte del mismo commit base y no ve el parche del otro: el conflicto aparece en el gate y un merge limpio puede descartar en silencio el trabajo de uno de los dos. Si tu tarea se solapa así con otra `[P]`, dilo en el informe **antes** de empezar.
13. **Acumuladores y contadores**: PROHIBIDO tocar `world.totals` (`statistics.ts:97` `count()`), `world.demographyDynamics`, `world.inventionDynamics`, `world.animalDynamics`, `world.technology.ledger` ni ninguno de los **nueve** contadores de identidad (FR-006) desde código que corra en un worker. La suma FP64 no es asociativa y todos entran en el digesto.

## Format: `[ID] [P?] [Modelo · esfuerzo] Descripción`

`[P]` = paralelizable (ficheros disjuntos) · Cada workstream corre en su **worktree** (`isolation: 'worktree'`) y se integra con merge en el gate de su etapa.

---

## Etapa A — Paso residente y ahorro inmediato (HOY, cerrable con `/speckit-implement`)

### Gate A0 (secuencial, árbol principal) — sin esto ninguna etapa tiene puerta de calidad

- [x] **T101** [claude opus · high; ejecutado y revisado con Codex disponible, 2026-09-22] **Digesto canónico** — la puerta de calidad de toda la feature.
  Nuevo `digestoCanonico(world): string` (sha256) con **claves de todo `Record` ordenadas** (`bonds`, `skills`, `activity`, `values`, `totals`, `chunks`) y **orden efectivo de TODOS los arrays conservado**, incluidos teselas, personas, animales, estructuras, lugares y `retiredChunks`. Incluye chunks retirados, parámetros efectivos y `chronicleJournal` pendiente completo. Distingue `-0` de `0` y rechaza números no finitos. Además `diferenciaCanonica(a, b)` localiza el **primer** desacuerdo e informa ruta/campo/índice. No toca `encodeSnapshot`: persistir y verificar son trabajos distintos.
  **Corrección de contrato, 2026-09-22:** ordenar arrays ocultaba desempates causales de `find()` y orden estable; omitir el journal ocultaba historia todavía no persistida. Los negativos de [la revisión](../../docs/REVISION-2026-09-22.md#integridad-de-los-controles) refutan ambas premisas anteriores. El contenido externo de SQLite requiere su control separado. Antes de comparar configuraciones de ejecución distintas en T102/B, definir un control de paridad que excluya sólo esas opciones: el digesto completo actual las detectará y no debe debilitarse eliminando leyes materiales.
  · **Ficheros**: `src/world/digesto.ts` (nuevo), `tests/digesto.test.ts` (nuevo).
  · **Tests**: dos mundos con las mismas claves insertadas en distinto orden dan el mismo digesto; cambiar un chunk **retirado** cambia el digesto (hoy `encodeSnapshot` no lo ve: test que lo demuestra); `diferenciaCanonica` localiza un cambio de un solo campo en una tesela concreta.
  · **Control**: el digesto de `createWorld(51926)` tras 1 200 pasos es estable entre dos ejecuciones del mismo binario.
  · **Cierre**: los tres tests verdes y el digesto adoptado como puerta en `tasks.md` (ninguna tarea posterior usa `encodeSnapshot` para probar paridad).

- [x] **T102** [claude sonnet · high; ejecutado y revisado con Codex disponible, 2026-09-22] **Parámetros de motor y reversión por etapa.**
  **Cierre 2026-09-22:** implementación desde `3dd615e`; Codex nativo como fallback explícito porque la ruta Claude/cloud-offload no estaba disponible. Focal 45/45, seis controles físicos de 1200 ticks contra V7 y otros seis contra la candidata familiar V8, con tablas durables iguales. Gate conjunto: typecheck, **939/939 tests, cero skips**, build, 18/18 E2E y smoke verdes. Informe: `.superpowers/sdd/002/tareas/T102-report.md`; [evidencia conjunta](../../docs/REVISION-INTEGRACION-A0-2026-09-22.md). El alcance incluye lexer compartido, barrido, snapshots y documentación. Son opciones reservadas, sin consumidores activos: **T100 y Gate A0 permanecen abiertos**.
  **Preflight 2026-09-22:** el parser y el barrido actuales separan comas sin reconocer arrays; ampliar ambos con descriptores tipados y un separador compartido, conservando sweeps numéricos, precedencia y congelación profunda. `motor.gpu=[],[0],[0,1]` son tres valores del barrido. Mantener los defaults deterministas; aceptar una opción no acredita un backend activo.
  Añadir a `WorldParams`: `motor: { clonPorPaso: boolean /*true = hoy*/; hilos: number /*1*/; soaTerreno: boolean /*false*/; particionarPersonas: boolean /*false*/; gpu: number[] /*[]*/; orden: 'natural'|'inverso'|'adversarial' /*'natural'*/ }`, `persistencia.paginasSucias: boolean /*false*/`, `red.deltas: boolean /*false*/`, `gobernador.senales: string[] /*['p95']*/` y **`limites: { teselasActivas: number; chunks: number; comunidades: number; fauna: number }`** (para T100; defaults = los topes de hoy, de modo que T102 por sí sola no cambia nada). Todos con **default = comportamiento de hoy**, sus rangos en `PARAM_RANGES` y su documentación.
  · **Ficheros**: `src/world/params.ts`, `tests/params.test.ts`.
  · **Tests**: defaults = hoy; `parseParams('motor.hilos=8,motor.gpu=[0,1]')` válido; rangos rechazan `motor.hilos=0` y `motor.hilos=513`.
  · **Control**: `tests/world.test.ts` sigue verde (nada cambió).
  · **Cierre**: typecheck verde y ningún fichero de `src/world` lee estos parámetros todavía.

- [ ] **T100** [codex/gpt-5.6-sol · high] **Topes de anticorrupción derivados de parámetros** (depende de T101 y T102). **Sin esta tarea la feature entera se despliega y el techo sigue estando en el software.**
  **Avance técnico 2026-09-22:** SQLite5 y páginas transaccionales integradas en `b7b8583`;1153/1153 sin omisiones,typecheck,build/smoke exactos y seis paridades1200ticks. El control externo encontró y corrigió el orden raíz al recargar páginas. [Evidencia](../../docs/REVISION-PERSISTENCIA-PAGINADA-2026-09-22.md). Siguen pendientes activación de límites por hardware, ley comunitaria/fauna y roundtrip2M; **T100/A0 permanecen abiertos**.
  **Preflight 2026-09-22:** quitar el gate de ocho comunidades sí cambia conductas y reproducción; debe declararse y contrastarse por separado de relajar validaciones. El límite de fauna también interviene en nacimientos y `assertAnimals`. Ampliar ownership a las rutas de Store que decodifican antes de restaurar parámetros y a sus recuperaciones: todas deben validar y aplicar límites persistidos antes de usarlos. Si los límites dependen de memoria del host, resolverlos fuera del motor y persistirlos explícitamente, sin defaults ambientales ocultos. Los controles de mundo pequeño no sustituyen negativos que alcancen esos gates.
  Hay **cuatro** topes fijos que ninguna tarea tocaba y que bloquean SC-004 por sí solos (refutaciones R1/G1/R8, verificadas en el árbol):
  · `src/server/snapshot.ts:53` — `record.tiles.length > 65536` ⇒ `throw new Error('Invalid snapshot tile encoding. Explicit recovery required.')`, en el camino de `load()` (`store.ts:264`), `previous()` (`store.ts:837`) y las dos rutas de recuperación (`store.ts:436,610,804,823`): **un mundo de más de 65 536 teselas activas no se puede ni guardar ni cargar**.
  · `src/world/index.ts:1081` — `list(world.tiles, legacy ? 1120 : 65536)`, con `list = (v, max) => Array.isArray(v) && v.length <= max` (`index.ts:1075`); `assertWorld` corre en cada `load()` (`store.ts:218`) y cada validación profunda (`store.ts:687`).
  · `src/world/index.ts:1123` — `Object.keys(w.chunks).length > 256`. 256 chunks × 256 teselas = 65 536 = **exactamente una región de ejecución**: un segundo recinto activo ya es ilegal.
  · `src/world/index.ts:1156` — `w.communities.length > 8`, y su gemelo de regla `world.communities.length >= 8` en `society.ts:226`, que deja de fundar comunidades nuevas al llegar a ocho mientras `reproduce` exige `!!p.communityId` (`index.ts:951`): a miles de habitantes la pertenencia deja de describir un grupo y pasa a ser un gate de reproducción saturado.
  · Y `src/world/animals.ts:11` — `MAX_STORED_ANIMALS = 65536 * MAX_ANIMALS_PER_TILE` (= 393 216), con `throw` en `animals.ts:283`.
  Los cinco pasan a derivarse de `params.limites.{teselasActivas, chunks, comunidades, fauna}` (T102), con **default = memoria real / orden de magnitud**, no una constante; el criterio es el del Ruling R17 para `POPULATION_HARD_LIMIT` (`shared/life.ts:22-30`): anticorrupción, nunca política. `decodeSnapshot` se actualiza **en el mismo commit**. El `>= 8` de `society.ts:226` sale a parámetro con default sin tope: es un tope de software, no una ley de vida (si alguien sostiene lo contrario, se versiona con FR-020 y su evidencia, pero no se deja como está).
  · **Ficheros**: `src/world/index.ts` (solo los tres `list`/comparaciones de `assertWorld`), `src/server/snapshot.ts` (solo `decodeSnapshot`), `src/world/animals.ts` (solo la constante y su `throw`), `src/world/society.ts` (solo el `>= 8`), `src/world/params.ts` (claves `limites.*`; coordinar con T102 en el mismo gate secuencial), `tests/limites-anticorrupcion.test.ts` (nuevo).
  · **Tests**: **guardar y recargar un mundo sintético de > 65 536 teselas activas y > 256 chunks da el mismo `digestoCanonico`** (hoy lanza: el test debe fallar antes del cambio y pasar después); un mundo con 12 comunidades carga; un valor fuera del límite de anticorrupción sigue fallando con el mismo mensaje; un mundo v4/legacy sigue cargando con sus topes de siempre.
  · **Control**: `digestoCanonico` de un mundo pequeño idéntico antes y después (solo se relajan validaciones, no se cambia ninguna regla). La suite de store verde.
  · **Cierre**: el test de 2 M teselas de ida y vuelta verde, y **ninguna** de las cinco constantes sigue escrita a mano en `src/`. Sin este cierre, ni el gate B ni el C pueden cerrar: T112 dimensionaría el SoA contra un tope falso.

**Gate A0**: `npm run typecheck` ✅ + los tests de T101/T102/T100 ✅ → commit «digesto canónico + params de motor + topes de anticorrupción». Orden secuencial: **T101 → T102 → T100** (T100 usa el digesto de T101 como control y las claves de T102). **De este commit salen todos los worktrees de A.**

### Etapa A en paralelo (worktrees desde Gate A0)

- [ ] **T103** [P] [codex/gpt-5.6-sol · high] **Clon acotado: `retiredChunks` deja de clonarse en profundidad.**
  **Perfil real 2026-09-22:** tres bases envejecidas a5/13 días, en carga y tras19 pasos de cadencia20, conservan digestos y SQLite/WAL. El clon compartido dio p50 de19,94–33,53ms y p95 de29,28–47,00ms en la pasada final; no alcanza6,15/10ms. Dos pasadas e instrumento preservados, host compartido. [Informe](../../docs/REVISION-CLON-ENVEJECIDO-2026-09-22.md). La paridad está probada; **el gate de rendimiento sigue rojo**.
  **Preflight 2026-09-22:** la implementación ya está en V7. `scripts/verify-clone-trajectory.mts <repo>` compara el clon completo con el compartido en semillas 1/7/51926 durante 2400 ticks, clonando cada paso, guardando cada 20 y recargando en 1200/2400: digestos iguales y diez tablas durables iguales salvo snapshots. Hubo 568/535/391 pasos clonados con chunks pendientes, por lo que el control sí ejerce el cambio. [Resultados](../../docs/evidencia-2026-09-22/clone-trajectory.json). El banco previo de 65536 teselas dormidas era sintético; el perfil real posterior figura arriba y **T103 no se marca cerrado**.
  `cloneWorld` (`src/world/index.ts:995-1005`) copia `retiredChunks` **superficialmente** (array nuevo, mismos objetos) y `activate` (`src/world/spatial.ts:36-52`) hace **clon profundo del chunk que reanima** antes de reinyectar sus animales, estructuras y lugares en el mundo (copy-on-write). Hoy `structuredClone({...world, tiles: []})` excluye `tiles` pero **no** `retiredChunks`, que pesa 14,8 MiB de los 23,2 MiB del mundo a los 5 días.
  · **Ficheros**: `src/world/index.ts` (solo `cloneWorld`), `src/world/spatial.ts` (solo `activate`), `tests/clon-acotado.test.ts` (nuevo).
  · **Tests**: reanimar un chunk y mutar sus animales en el borrador no toca el mundo confirmado (comparado con `digestoCanonico`, que sí mira `retiredChunks`); `tests/projection-failure.test.ts` sigue verde.
  · **Control (experimento)**: 2 400 pasos, semilla 51926, con y sin el cambio: `digestoCanonico` **idéntico**; `cloneWorld` de p50 **10,25 → ≤ 6,15 ms** y p95 **14,33 → ≤ 10 ms**.
  · **Cierre**: digesto idéntico en 3 semillas y las dos cifras de p50/p95 alcanzadas.

- [ ] **T104** [claude opus · high] **Punto de restauración y fuera el clon** (depende de T101 y T103). **La tarea más delicada de la etapa.**
  `stepOnce` (`src/server/app.ts:197-235`) deja de clonar cuando `motor.clonPorPaso=false`. La atomicidad del paso fallido se conserva con un punto de restauración.
  **Corrección 2026-09-19 (refutación R6, verificada — el texto anterior de esta tarea era falso y habría hecho escribir código contra una API inexistente)**: el punto de restauración **no puede ser el snapshot codificado**. Dos razones de código: (a) `store.lastSnapshotBytes` es **un número**, no el cuerpo — `store.ts:150` `lastSnapshotBytes = 0;` y `store.ts:774` `this.lastSnapshotBytes = Buffer.byteLength(body);`, y el cuerpo se descarta tras escribirlo (`app.ts:229` solo lo publica como `runtime.snapshotBytes`); (b) `encodeSnapshot` devuelve `{...world, retiredChunks: [], retiredLegacy: [], …}` (`snapshot.ts:25`), así que el mundo restaurado desde ese cuerpo **no tendría `retiredChunks`** y su `digestoCanonico` no coincidiría — justo el caso que la prueba (2) de abajo quiere cubrir. Elige **una** de estas dos, mide su coste y déjalo en el informe:
  · **Diario de deshacer** del paso (registro de las mutaciones, revertible en orden inverso), que además alimenta las páginas sucias de T132; o
  · **clon estructural acotado** a lo que el paso puede tocar, con `retiredChunks` **compartido por referencia** porque `activate` ya hace copia al reanimar (T103).
  Cualquiera de las dos debe caber en el presupuesto «RSS ≤ 220 MiB» de la etapa: retener el cuerpo codificado costaba ~8 MiB de JSON por paso hoy y del orden de 1 GB a 2 M teselas.
  **Obligatorio además**: la ruta `SessionRevoked` (`app.ts:233`) hoy **vuelve sin marcar `failed`** — sin clon eso dejaría el mundo avanzado un tick con un gesto aplicado, no confirmado y no guardado; debe restaurar o marcar `failed`.
  · **Ficheros**: `src/server/app.ts` (solo `stepOnce` y la ruta `SessionRevoked`), `src/world/index.ts` (`puntoDeRestauracion`), `tests/restauracion-paso.test.ts` (nuevo), `tests/projection-failure.test.ts` (ampliado).
  · **Tests**: (1) fallo sintético de `store.save` ⇒ `digestoCanonico(app.world)` idéntico al de antes del paso; (2) el mismo test **con un chunk recién reanimado en ese paso** (el caso que el hash de hoy no veía); (3) `stepWorld` que lanza a mitad ⇒ mundo restaurado; (4) `SessionRevoked` ⇒ el mundo no avanza con un gesto no confirmado; (5) `motor.clonPorPaso=true` restaura exactamente el comportamiento de hoy.
  · **Control (experimento)**: 2 400 pasos, semilla 51926, **con gestos y con `store.save` activos** (lo que los scripts de medida de las propuestas NO ejercitaban): día simulado **43 510 → ≤ 6 500 ms**, p50 del par **17,82 → ≤ 2,0 ms**, RSS **524,3 → ≤ 220 MiB**, `digestoCanonico` a 1 200 y 2 400 pasos **idéntico**.
  · **Cierre**: los 5 tests verdes, las 4 cifras alcanzadas y digesto idéntico en 3 semillas. Si la restauración no está lista, **la tarea no cierra**: quitar el clon sin ella está vetado.

- [ ] **T105** [P] [codex/gpt-5.6-sol · high] **`prep` y `flushTechnology` del guardado.**
  Hoy, a 40 habitantes y 5 días, dentro de `save` mandan `prep` **168 ms** y `flushTechnology` **75 ms**. Reducirlos sin cambiar el contrato de verificación: `prep` deja de reconstruir lo que no cambió (seguir el patrón de `verifiedRecipes`/`verifiedTechnology`, `store.ts:136-138,549-552,640-656`), `flushTechnology` escribe solo recibos nuevos y no recalcula pruebas ya retenidas.
  · **Ficheros**: `src/server/store.ts` (solo `save`/`prep`/`flushTechnology`), `tests/store-guardado.test.ts` (nuevo o ampliado).
  · **Tests**: el contenido escrito es idéntico al de hoy fila a fila; la verificación profunda cada `DEEP_VALIDATION_EVERY_SAVES=10` sigue corriendo.
  · **Control (experimento)**: mismo mundo de 40 hab / 5 días, `saveMs` desglosado antes/después.
  · **Cierre**: `prep` **≤ 20 ms** y `flushTechnology` **≤ 10 ms**, con las filas escritas idénticas.

- [ ] **T106** [P] [gemini/pro · high] **`assertWorld` deja de ser cúbico.**
  `src/world/index.ts:1148` hace `Object.keys(p.bonds).some(id => !w.people.some(other => other.id === id))` **dentro** del bucle de personas ⇒ O(P × B × P): a 8 000 habitantes con 64 vínculos son ~4·10⁹ comparaciones de cadena **en cada carga**. Sustituir por un `Set<id>` construido una vez. Además acotar el bucle de `recipeIds` (`index.ts:1178-1190`), que es superlineal y toca disco por receta, reutilizando la caché de pruebas ya retenida.
  · **Ficheros**: `src/world/index.ts` (solo `assertWorld`), `tests/assert-world-escala.test.ts` (nuevo).
  · **Tests**: mundo sintético de 2 000 personas con 64 vínculos ⇒ `assertWorld` < 1 s; un vínculo huérfano sigue fallando con el mismo mensaje; un `recipeId` inexistente sigue fallando.
  · **Control**: `digestoCanonico` intacto (es una verificación, no una regla); la suite de store verde.
  · **Cierre**: el tiempo de `assertWorld` crece **linealmente** con P en {200, 800, 2 000} (R² > 0,95 sobre el ajuste lineal).
  · **Alcance explícitamente excluido**: los topes `65536`/`256`/`8` de `assertWorld` los levanta **T100** en Gate A0, no esta tarea. Si al mergear hay conflicto en `assertWorld`, manda T100.

- [ ] **T107** [P] [minimax/MiniMax-M3] **Perfil por fase y fracción serial.**
  `stepOnce` mide y publica ms por fase (`maintainRegions`, ecología, kernel, fauna, personas, encuentros, demografía, comunidades, reproducción, checkpoint, muestreo, `save`, `broadcast`) en `runtime.fases` y en `performance.fases` del `state`, más `runtime.fraccionSerial` (fracción del paso que no es paralelizable por diseño).
  · **Ficheros**: `src/server/app.ts` (instrumentación), `src/world/index.ts` (marcas de fase), `src/shared/types.ts` (`RuntimeStats`), `tests/perfil-fases.test.ts` (nuevo).
  · **Tests**: la suma de las fases no difiere del `stepMs` en más del 5 %; `fraccionSerial` ∈ [0,1].
  · **Control**: `digestoCanonico` idéntico (solo instrumentación); el coste de medir ≤ 2 % del paso.
  · **Cierre**: el `state` publica las fases y el laboratorio las registra por día.

- [ ] **T108** [P] [minimax/MiniMax-M3] **Desbloquear el banco de cómputo y perfilar el kernel vivo.**
  `scripts/compute-ecology-benchmark.mjs:34` exige identidad de **bytes** de `src/world/ecosystem-kernel.ts`, `ecosystem.ts` y `terrain.ts` con `95ff0d2` y hoy lanza `Baseline core changed`: **no protege nada desde el 6 de septiembre**. Sustituir el candado de bytes por una **especificación versionada de las fórmulas** (lista de campos y términos, con su versión) validada contra el kernel vivo. Con el banco desbloqueado, medir `EcosystemKernel.step` **dentro del motor** a 65 k, 1 M y 4 M celdas y dejar las cifras en el informe.
  · **Ficheros**: `scripts/compute-ecology-benchmark.mjs`, `.superpowers/sdd/002/tareas/T108-report.md`.
  · **Tests**: el banco corre en verde contra HEAD; cambiar un término del kernel hace fallar la especificación versionada.
  · **Control**: las cifras del banco a 1 M celdas reproducen 47,30 / 23,97 / 19,41 ms (1 / 4 / 8 hilos) dentro de ±15 %.
  · **Cierre**: banco verde + tabla de coste del kernel por número de celdas, que es la línea base de las etapas B y C.

- [ ] **T109** [P] [claude sonnet · high] **`scripts/curva-techo.mts` — el instrumento que mide el techo.**
  Args `--seed --hilos --gpu --escala habitantes|teselas --hasta N --salida <dir>`. Hace crecer la escala hasta que el p95 del paso toca `gobernador.presupuestoMs` y escribe `{escala, p95, p50, tickHz, rss, teselasActivas, teselasPorHabitante, fraccionSerial}` por punto. Es el instrumento que cierra SC-003, SC-004 y SC-013 en todas las etapas.
  · **Ficheros**: `scripts/curva-techo.mts` (nuevo), `package.json` (script `"techo"`), `scripts/lab/README.md`, `tests/curva-techo.test.ts` (nuevo).
  · **Tests**: dos corridas con la misma semilla dan la misma curva salvo tiempos; el criterio de parada es reproducible.
  · **Control**: el punto de partida de la curva coincide con el p95 medido por el laboratorio para la misma escena.
  · **Cierre**: la curva de HOY queda escrita en `docs/EVIDENCIA.md` como línea base de la feature.

- [ ] **T110** [orquestador] **Gate A.** Merge en orden T103 → T105 → T106 → T107 → T108 → T109 → T104 (el más conflictivo, el último) → `npm run typecheck && npm test` en un worktree → `npx tsx scripts/curva-techo.mts --escala habitantes --hilos 1` → fila en `docs/EVIDENCIA.md` §«2026-09-19 · Etapa A» con SHA, semillas, ANTES/DESPUÉS y control → commit. **Criterio de cierre de la etapa**: SC-002 y el escalón de 250 habitantes de SC-003 alcanzados, digesto idéntico en 3 semillas, suite 781/0. **Se despliega.**

---

## Etapa B — SoA de terreno y ecosistema en workers deterministas

- [ ] **T111** [P] [claude sonnet · high] **`HALO_CELDAS = 13` y la prueba estática de alcance efectivo compuesto.**
  Constante única en `src/world/halo.ts` con el **inventario explícito** del **alcance efectivo compuesto** de cada función —radio directo **más** los sub-escaneos que la propia función hace sobre lo que encontró— y una prueba que falla si alguno lo supera. Radios sueltos: `RADIUS=7` (`index.ts:43`), `CONSTRUCTION_RADIUS=7` (`inventions.ts:91`), fundación ≤7 (`society.ts:226`), reproducción ≤3+4 (`index.ts:945-952`), herencia ≤2, encuentro ≤1,5, percepción animal `1+⌊p·5⌋ ≤ 6` (`animals.ts:140`). **Incluir la activación**: `maintainRegions` activa el chunk que contiene `(x±8, y±8)`, de modo que el área **escrita** alcanza ~24 celdas desde la persona.
  **Corrección 2026-09-19 (refutación G2, verificada — por esto el halo sube de 8 a 13)**: `settlementOpportunity` (`society.ts:94-124`, llamada desde `choose` en `index.ts:327`, o sea dentro de la futura fase B de solo lectura) **compone** radios: `person → home` a ≤7 (`society.ts:111`) y luego `viable(home)` lee teselas ±4 (`:98-101`), estructuras ≤4 (`:104`) y **personas ≤6** (`:105`) **alrededor del home, no de la persona** ⇒ **13 celdas** en personas y **11** en teselas desde la persona. La rama hermana `world.places.filter(p => distance(person,p) <= 6)` (`:114`) da 12 con la misma composición. Ni `research.md` D3 ni `mapa-motor-paso.md` §2 lo registraban.
  **Lectura global replicada, no radio**: `index.ts:403` (`buildable`) recorre **todo** `world.places` sin filtro espacial (`!world.places.some(p => distance(p, t) < 5)` sobre teselas ya acotadas a `RADIUS=7`). `world.places` está acotado a 2 048 (`index.ts:1081`), así que la solución es replicarlo íntegro y de **solo lectura** en cada worker. El inventario debe registrarlo en una sección aparte: «lecturas globales replicadas», con su cota de tamaño.
  · **Ficheros**: `src/world/halo.ts` (nuevo), `tests/halo-radios.test.ts` (nuevo).
  · **Tests**: el inventario cubre todos los alcances (un grep de `distance(`, `filter(`, `some(` y `find(` sobre `world.people`/`world.places`/`world.structures`/`world.tiles` en `src/world` no encuentra ninguno fuera del inventario o de la lista de lecturas globales); introducir un radio 9 sintético hace fallar; **introducir una composición sintética radio 7 + radio 8 hace fallar** aunque ningún `distance()` suelto supere 13.
  · **Control**: `digestoCanonico` intacto (es una constante y una prueba).
  · **Cierre**: prueba verde, el inventario citado en `docs/REGLAS.md`, y el coste del halo medido: sobre región 256×256 el borde pasa de 12,89 % (halo 8) a **21,3 %** (halo 13); si eso pesa en la métrica de T115, se declara y se pasa a región **512×512** (borde 10,4 %), que es un cambio de geometría, **no** de reglas, y T117 debe seguir dando digestos idénticos entre ambas.

- [ ] **T112** [P] [codex/gpt-5.6-sol · xhigh] **`TileStore` SoA con máscara de presencia y doble buffer.**
  SoA **por campo** (un buffer por campo y región de 256×256), estáticos como enteros, mutables FP64, doble buffer, versión `Uint32`, máscara sucia y **máscara de presencia**. Las coordenadas **no** se almacenan: se derivan de `(regionX, regionY, offset)`. **La máscara de presencia es obligatoria**: `buildTopology` pone `-1` a los vecinos fuera del conjunto activo (`ecosystem-kernel.ts:55-70`); sin ella, una región densa daría vecinos reales a celdas que hoy no los tienen y `livingNeighbors` cambiaría **en todo el borde del mundo activo**. Detrás de `motor.soaTerreno`.
  **Absorber la topología del kernel** (añadido 2026-09-19, refutación R12, verificada): `EcosystemKernel` mantiene una caché de hasta `MAX_TOPOLOGIES = 4` topologías (`ecosystem-kernel.ts:6`), valida el acierto con `sameCoordinates` —que compara **dos flotantes por tesela** (`:26-33`), hasta 147 M comparaciones por tick ecológico a 18,4 M teselas con las cuatro retenidas— y, en fallo, reconstruye el índice de posiciones y un `Int32Array(length * 8)` de vecinos (`:43-70`). Cuenta por topología: `coordinates` 2×8 B + `neighbors` 8×4 B + `life` 8 B = **56 B/tesela** ⇒ 1,03 GB a 18,4 M teselas, × 4 = **≈4,12 GB = 224 B/tesela solo de scratch**, que se suma al del `TileStore` y deja SC-009 (256 B/tesela) **sin margen**.
  *(Aritmética recalculada contra `f30d528`. La refutación R12 daba 1,92 GB por topología y 418 B/tesela porque medía el kernel anterior, que copiaba **siete** `Float64Array` por tesela; el commit `6fbefd2` del sprint del 2026-09-19 —«el kernel de ecología deja de reconstruir índices de cadena y de copiar siete instantáneas por tesela»— ya se llevó esa mitad y el índice de claves de cadena. Lo que queda por hacer aquí es la **validación de caché O(T)** y las **cuatro copias retenidas**.)* Con el SoA las coordenadas son implícitas en `(regionX, regionY, offset)`: `neighbors` se **calcula por aritmética y no se almacena**, y la validación de caché pasa a ser una **versión entera** del conjunto activo, no una comparación O(T).
  · **Ficheros**: `src/world/soa/{region,terreno,presencia,arena}.ts` (nuevos), `src/world/ecosystem-kernel.ts` (solo la topología y su caché), `tests/soa-terreno.test.ts` (nuevo).
  · **Tests**: empaquetar y desempaquetar un mundo real da `digestoCanonico` idéntico; una celda ausente conserva vecino `-1` con la máscara y lo pierde sin ella (test que demuestra por qué la máscara existe); **los vecinos calculados por aritmética coinciden uno a uno con los de `buildTopology` para un conjunto activo disperso**; bytes por tesela medidos sobre el buffer real **incluido el scratch**.
  · **Control**: 2 400 pasos con `motor.soaTerreno` en `false` y en `true`: digesto **idéntico** en 3 semillas.
  · **Cierre**: digesto idéntico, **≤ 256 B/tesela** medidos **con el scratch dentro**, cero topologías retenidas, y una sola autoridad por página (aserción que rechaza objeto y SoA escribibles a la vez).

- [ ] **T113** [P] [gemini/pro · high] **`tileAt` por aritmética, `activate` con índice, `maintainRegions` incremental.**
  (a) `tileAt` (`spatial.ts:28-35`) **sustituye** el `Map<string,Tile>` por aritmética de offset por chunk (`chunkKey` + offset local ya dan una fórmula O(1)); hoy el índice se reconstruye entero en cada paso porque `cloneWorld` cambia la identidad de `world.tiles` — 3,15 % de la CPU. (b) `activate` (`spatial.ts:40`) escanea `retiredChunks` con `findIndex` ⇒ O(R) por chunk activado, con R creciendo con el territorio explorado: índice por clave. (c) `maintainRegions` (`spatial.ts:66`) hace `Object.entries(world.chunks)` **en cada tick**: recorrido incremental sobre lo que cambió.
  · **Ficheros**: `src/world/spatial.ts`, `tests/spatial-escala.test.ts` (nuevo).
  (d) **`terrainIndex` de fauna sobre ese mismo índice** (añadido 2026-09-19, refutación R4): `animals.ts:131-138` construye `new Map(world.tiles.map(t => [key(t), t]))` y lo invalida cuando cambia la identidad **o la longitud** de `world.tiles` — es decir, en cada paso mientras exista el clon (2,16 % del perfil de hoy) y, quitado el clon, **cada vez que alguien cruza una frontera de chunk** (`spatial.ts:50,80`). No debe sustituirse por otro `Map` paralelo: debe usar el índice aritmético de (a).
  · **Ficheros**: `src/world/spatial.ts`, `src/world/animals.ts` (**solo** `terrainIndex`; la selección y el gateo son de T116), `tests/spatial-escala.test.ts` (nuevo).
  · **Tests**: `tileAt` devuelve lo mismo que hoy para 10 000 consultas aleatorias; `activate` con 100 000 chunks retirados es O(1) medido; `maintainRegions` no asigna O(chunks) por tick; **`terrainIndex` no reconstruye nada al activar un chunk** y devuelve las mismas teselas que hoy.
  · **Control**: 2 400 pasos, digesto **idéntico** en 3 semillas; `tileAt` y `animals.terrainIndex` desaparecen del perfil (hoy 3,15 % y 2,16 %).
  · **Cierre**: digesto idéntico y las cuatro cifras (perfil de `tileAt`, perfil de `terrainIndex`, O(1) de `activate`, asignaciones por tick).

- [ ] **T114** [P] [codex/gpt-5.6-sol · high] **Port de T013/T035 al SoA y paridad contra el kernel VIVO.**
  Añadir a `stepArrays` (`scripts/compute-ecology-core.mjs:56`) los tres escalares que le faltan: `decaimientoFertilidad` (T013, `ecosystem-kernel.ts:122`) y `seed`/`cuencas` con el gateo `enCuenca` (T035, `ecosystem-kernel.ts:130-138`). **`enCuenca` no son «tres escalares»**: exige reproducir `ruidoCuenca` → `unit` → `hash` con el desbordamiento de 32 bits de `Math.imul`, los `>>> 16/15` lógicos, la división por 2³², `Math.floor` con coordenadas negativas y el polinomio `fade` `t*t*t*(t*(t*6-15)+10)` en el mismo orden (`src/world/agua.ts:18-27,35-53`). Reapuntar `tests/compute-ecology.test.ts` al kernel **vivo**.
  · **Ficheros**: `scripts/compute-ecology-core.mjs`, `scripts/compute-ecology-worker.mjs`, `tests/compute-ecology.test.ts`.
  **El arnés de paridad compara el tick ecológico íntegro** (añadido 2026-09-19, refutación G4): lo que `stepWorld` ejecuta cada 10 ticks es `ecology()` **y luego** `EcosystemKernel.step`, en ese orden. El arnés debe comparar la composición de las dos, no solo el kernel, porque `food` lo escribe la primera y ninguna otra tarea lo cubría. El port de `ecology()` es de T120; aquí entra solo en el **oráculo**.
  · **Tests**: `Object.is` elemento a elemento con **cero** diferencias contra `ecology()` + `EcosystemKernel.step` de HEAD, con `cuencas` ∈ {1, 0,4} y `decaimientoFertilidad` ∈ {0, 0,001}; casos con `x`/`y` negativos y cruzando múltiplos de la escala del ruido.
  · **Control**: con los defaults (`decaimientoFertilidad=0`, `cuencas=1`) el resultado es bit a bit el del port congelado.
  · **Cierre**: cero diferencias en los cuatro cuadrantes de parámetros y el banco de T108 verde.

- [ ] **T115** [claude opus · high] **Pool de workers y ecología cableada** (depende de T112 y T114).
  Pool persistente de `worker_threads` sobre `SharedArrayBuffer` (patrón de `CPUWorkers`, `compute-ecology-clients.mjs:17-27`), **colas estáticas por región** ordenadas por `regiónId` — **nada de *work stealing* hasta que el adversarial de T117 esté verde**. `stepEcosystem` reparte `[begin,end)` entre `motor.hilos` workers; el halo no se copia, se lee del buffer del vecino.
  · **Ficheros**: `src/world/paralelo/{piscina,particion,barrera}.ts` (nuevos), `src/world/ecosystem.ts`, `src/world/ecosystem-kernel.ts` (extraer el cuerpo a función sobre arrays), `tests/paralelo-ecologia.test.ts` (nuevo).
  · **Tests**: 1, 2, 4, 8 y 28 hilos dan bytes idénticos; una región vacía no rompe la barrera; un worker que lanza aborta el paso antes del swap.
  · **Control**: 1 M celdas dentro del motor: **47,30 ms (1 hilo) → ≤ 20 ms (8 workers)**; digesto idéntico en 3 semillas y 5 recuentos de hilos.
  · **Cierre**: la cifra alcanzada, digesto idéntico y `motor.hilos=1` revirtiendo exactamente al camino de hoy.

- [ ] **T116** [P] [grok/grok-4.6 · high] **Máscara de fauna calculada en el coordinador.**
  Hoy `stepAnimals` ordena canónicamente toda la fauna y toma la ventana con el módulo de la población **global** (`animals.ts:285-289`). Extraer eso a una función del coordinador que produce `selectedIds` **una sola vez por paso** y repartirlo a las regiones como **máscara de solo lectura**. **PROHIBIDO** el offset por región: cambia qué animales piensan en qué tick. Además dejar escrito en el código que el pase de `move` (`animals.ts:186,191-195`) es una **cadena secuencial** —liberar una celda habilita la entrada de otro— y permanece en la fase serial.
  · **Ficheros**: `src/world/animals.ts` (solo la selección y el gateo), `tests/fauna-mascara.test.ts` (nuevo).
  · **Tests**: la máscara coincide exactamente con la ventana de hoy para 1 000 ticks y 3 poblaciones de fauna; con la máscara repartida entre 1 y 8 particiones, el resultado es idéntico.
  · **Control**: 2 400 pasos, `digestoCanonico` **idéntico** (es reordenar el cálculo, no cambiar la regla).
  · **Cierre**: digesto idéntico y el coste del sort medido (`O(A log A)`, ≤ 1 % del paso a 10⁵ animales).

- [ ] **T117** [claude opus · xhigh] **`tests/determinismo-hardware.test.ts` — la prueba que sostiene la feature.**
  4 semillas (`7, 51926, 104729, 20260919`) × **7 escenas** × backends `{hilos:1|2|4|8|28}`, **`{orden:'adversarial'}`** y (etapa C) `{gpu:[0]}`, `{gpu:[1]}`, `{gpu:[0,1]}`. **El backend adversarial** ejecuta las particiones en **orden inverso**, con un **número de hilos distinto en cada paso** y con **retardos de reloj real** entre ellas: sin él la prueba solo demuestra que 28 hilos coinciden *hoy*. Modo corto (600 pasos) dentro de `npm test`; modo largo (2 400 pasos) tras bandera. **Sin CUDA, los backends de GPU se marcan `skipped` con motivo; nunca `passed`.**
  **Las siete escenas** (las dos últimas añadidas 2026-09-19): compacta · habitantes sobre frontera de región · dos actores compitiendo por la misma tesela · nacimiento y muerte simultáneos · regiones dispersas · **alcance compuesto** (persona en la frontera, `home` a 6-7 celdas **en la región vecina**, y la persona o el recurso que decide el resultado 4-6 celdas más allá: es la escena que refuta un halo corto, y con `HALO_CELDAS=8` habría fallado — refutación G2) · **cosecha simultánea en dos regiones** cuyo **único** síntoma posible es `world.totals` (refutación R3: la suma FP64 no es asociativa y T101 mete `totals` en el digesto). Las dos geometrías de partición (256×256 y 512×512) entran en la matriz, porque US2-4 lo exige y porque es lo que delata un acumulador agrupado por región.
  **La comparación por barrera es por región, no del mundo completo** (corrección 2026-09-19, refutación R9, verificada): la comparación se hace **tras cada barrera** con un **hash incremental por región** actualizado con la máscara sucia, en O(regiones tocadas); el `digestoCanonico` completo se reserva para el final del paso y para los hitos (1 200 y 2 400). Cuenta que lo obliga: 4 semillas × 7 escenas × 6 backends de CPU = 168 corridas × 600 pasos ≥ 403 000 barreras, y el único recorrido completo del mundo medido hoy es `cloneWorld` a **p50 10,25 ms sin ordenar nada** ⇒ más de una hora; incluso con un digesto irreal de 1 ms se pasa del techo de 3 min de SC-010. Cuando una barrera discrepe, **entonces** se llama a `diferenciaCanonica` (T101) sobre las regiones que difieren, que es quien informa **tick, fase, página, campo e índice**.
  · **Ficheros**: `tests/determinismo-hardware.test.ts` (nuevo), `src/world/digesto.ts` (solo `hashRegion` incremental), `src/world/paralelo/particion.ts` (soporte de `motor.orden` y de la geometría).
  · **Tests**: los propios; más un test negativo que inyecta una suma en árbol sintética y comprueba que la prueba **falla** y localiza el primer desacuerdo; y un segundo negativo que acumula `totals` por región en FP64 y comprueba que la escena de cosecha simultánea **lo detecta**.
  · **Control**: referencia = 1 hilo, `motor.orden='natural'`, geometría 256×256.
  · **Cierre**: todos los backends de CPU verdes en las 4 semillas y las 7 escenas, modo corto ≤ 3 min **medidos y escritos en evidencia** (no estimados), y los dos tests negativos demostrando que la prueba muerde.

- [ ] **T118** [P] [claude sonnet · high] **Laboratorio consciente del hardware.**
  `scripts/lab/replica.ts` y `barrido.ts` aceptan `--hilos`, `--gpu`, `--orden`; `replica.json` registra `fases`, `fraccionSerial`, `teselasActivas`, `teselasPorHabitante`; `resumen.ts` añade la **curva p95(teselas)** y la comparación de digestos entre backends (misma semilla + distinto backend con digesto distinto ⇒ 🔴).
  · **Ficheros**: `scripts/lab/{replica,barrido,resumen}.ts`, `scripts/lab/README.md`, `tests/lab-hardware.test.ts` (nuevo).
  · **Tests**: un barrido de 2 réplicas × 2 backends detecta una rotura de determinismo sintética.
  · **Control**: `--hilos 1` reproduce exactamente las cifras de mundo del laboratorio de hoy.
  · **Cierre**: el barrido produce la curva y el semáforo de determinismo.

- [ ] **T120** [codex/gpt-5.6-sol · high] **El segundo barrido de teselas: `ecology()` al camino paralelo** (depende de T112, T113 y T115). *(Tarea nueva de la revisión de refutaciones; numerada después de T119 por no renumerar el gate, pero **se mergea antes que T119**.)*
  `stepWorld` corre **dos** pasadas ecológicas cada 10 ticks, no una: `ecology(world)` (`index.ts:900`) y `stepEcosystem(...)` (`index.ts:903`). `ecology()` (`index.ts:215-242`) es una función **distinta** del kernel: recorre `for (const tile of world.tiles)`, hace **cuatro `tileAt()`** por tesela para la humedad de vecindad y escribe `moisture`, `vegetation` y **`food`** — el campo que comen las personas, que el kernel SoA/CUDA **no** escribe. Ninguna tarea la nombraba: T112/T114/T115/T121/T122 hablan todas de `EcosystemKernel`/`stepEcosystem`. A 18,4 M teselas son **73,6 M búsquedas en `Map` de cadena por tick ecológico en el hilo principal**, y el 0,54 % del perfil de `research.md` §1.2 mide solo `EcosystemKernel.step + buildTopology`: el coste de `ecology()` a escala **no está medido ni presupuestado** (refutaciones R4/G4, verificadas).
  **Qué se mueve y qué no**:
  · **Se mueve** el bucle por tesela (`index.ts:225-241`). Es un autómata local: lee `tile` completo y de los cuatro vecinos **solo `terrain`**, que es estático ⇒ no hay dependencia entre celdas y encaja en el SoA de T112 y en el pool de T115.
  · **NO se mueve** el bloque de clima (`index.ts:216-224`, `tick % 600`, consume `random(world)` = `world.rng`): se queda en el coordinador por FR-010/D5.
  · **El orden se conserva**: la pasada de `ecology` termina **entera** antes de que empiece la del kernel, porque el kernel copia `moisture`/`vegetation` ya actualizados a sus buffers (`ecosystem-kernel.ts:97-110`). Son **dos despachos**, no un kernel fusionado.
  · **Ficheros**: `src/world/index.ts` (solo el cuerpo de `ecology`, extraído a función sobre arrays), `src/world/ecosystem.ts` (despacho), `src/world/paralelo/particion.ts` (reparto de la pasada), `tests/ecology-paralela.test.ts` (nuevo).
  · **Tests**: `Object.is` elemento a elemento con **cero** diferencias contra la `ecology()` de HEAD, en un mundo con teselas de agua en los bordes y con conjunto activo disperso (que es donde los cuatro vecinos faltan); 1, 2, 4, 8 y 28 hilos dan bytes idénticos; el clima sigue saliendo de `world.rng` en el orden de hoy.
  · **Control**: 2 400 pasos con y sin el cambio: `digestoCanonico` **idéntico** en 3 semillas. Coste de `ecology()` medido a 65 k, 1 M y 4 M teselas, 1 hilo vs 8 workers, y la cifra escrita: es la mitad que faltaba del presupuesto de 20 ms de SC-004.
  · **Cierre**: digesto idéntico, cifra medida, y **ninguna fase serial escala con `activeTiles`** (lo comprueba la aserción de T107).

- [ ] **T119** [orquestador] **Gate B.** Merge T111 → T116 → T114 → T113 → T112 → T115 → **T120** → T117 → T118 → suite completa + `determinismo-hardware` modo corto + curva p95(teselas) con 28 workers → evidencia. **Cierre**: SC-004 (≥ 2 M teselas en CPU, **guardadas y recargadas con el mismo digesto** — la puerta que T100 hizo posible), 6 backends de CPU idénticos, ≤ 256 B/tesela **con el scratch del kernel dentro**, y el tick ecológico medido **íntegro** (`ecology()` + kernel). **Se despliega** con `motor.hilos` conservador en el servidor público.

---

## Etapa C — GPU residente para el ecosistema

- [ ] **T121** [P] [codex/gpt-5.6-sol · xhigh] **`enCuenca` y los tres escalares en CUDA, con paridad fp64 exacta.**
  Portar a `scripts/compute-ecology.cu` lo que T114 portó al SoA de JS: `decaimientoFertilidad`, `seed`, `cuencas` y `enCuenca` completo, **más el bucle por tesela de `ecology()` que T120 llevó al camino paralelo** (mismo orden: pasada de `ecology` completa, luego la del kernel; dos despachos, no un kernel fusionado — es quien escribe `food`, refutación G4). El desbordamiento de 32 bits de `Math.imul` se reproduce con `int32_t`/`uint32_t` explícitos; los `>>>` son desplazamientos **lógicos**; la división por 2³² es exacta; `Math.floor` con negativos **no** es truncamiento; el polinomio `fade` va en el mismo orden y **sin contracción FMA**. La paridad de este kernel es estructural (no hay `exp`/`log`/`pow` donde libdevice y V8 pudieran diferir): si diverge, es un error de port, no de la GPU.
  · **Ficheros**: `scripts/compute-ecology.cu`, `scripts/compute-ecology-gpu.py` (paso de los escalares), `tests/compute-ecology.test.ts` (variantes GPU).
  · **Tests**: `Object.is` con cero diferencias contra el kernel vivo en los cuatro cuadrantes de parámetros, con coordenadas negativas y en los bordes de la escala del ruido.
  · **Control**: `--fmad=false` verificado en la línea de compilación; quitarlo debe hacer fallar el test (prueba de que el flag importa).
  · **Cierre**: cero diferencias en GPU0 y GPU1 por separado.

- [ ] **T122** [claude opus · high] **Puente GPU persistente con buffers residentes.**
  Un subproceso persistente por GPU, NVRTC compilado **una vez** al arranque, los 9 campos de ecología residentes en VRAM entre pasos. Hoy el puente manda 120 MB por paso y gasta ~196 ms de IPC sobre 0,40 ms de kernel. Selector: workers por debajo de 1,25 M celdas, GPU por encima, con el punto de cruce **medido** y comparado contra el estimado.
  **Dos presupuestos de transporte, medidos por separado** (corrección 2026-09-19, refutaciones R5/G3, verificadas — el «≤ 1 MB por paso» solo contaba la subida y erraba por ≈118×):
  · **CPU → GPU (confirmación)**: `(índice, valor)` de las teselas que la fase de confirmación tocó. Disperso. **≤ 1 MB por paso**, que es el número que ya estaba.
  · **GPU → CPU (campo ecológico)**: **denso**. El kernel escribe `life/fertility/growth/vegetation/traffic/cultivation/drinkingWater/moisture/wood` de **toda** tesela activa cada 10 ticks (`ecosystem-kernel.ts:120-138`, sin salida temprana parcial) y **todos** sus consumidores viven en CPU y en el mismo tick: `ecology()` (`index.ts:234-241`), `bodyAndAction` (`index.ts:797-800`, lee **y escribe** `tile.food` y `tile.vegetation`), `stepAnimals` (`animals.ts:139-151`), `encodeSnapshot` (20 campos por tesela, `snapshot.ts:23`) y `worldStatistics` (`statistics.ts:120`). Cuenta: 8 campos × 8 B × 18,4 M = **1,18 GB por tick ecológico** ≈ 118 MB por paso de media, ~**47 ms** solo de transferencia sobre PCIe 4.0 ×16 (~25 GB/s efectivos): más que el presupuesto entero de 20 ms del kernel. Y `research.md` D17 ya dice que `fertility` deriva `life*0.0012` por invocación, **más de una milésima**: no hay delta disperso que quepa en 1 MB para un campo que cambia casi entero.
  **La tarea no cierra sin elegir y medir una de estas tres salidas**, escrita en evidencia: (a) el SoA de terreno es la autoridad y los consumidores de CPU leen por página bajo demanda —**es una tarea aparte, no parte de T122**, y si se elige hay que darla de alta antes del gate C—; (b) la descarga se acota al halo de actores activos, con la regla escrita y demostrado que no cambia el resultado; (c) se declara un presupuesto de bajada de cientos de MB con su **propio** objetivo en ms y se recalcula el punto de cruce del selector (`research.md`:165 se mueve). Además hay que **levantar los topes del prototipo en el mismo commit**: `compute-ecology-gpu.py:143` (`amount > 120_000_000`) y `:148` (`n > 1_000_000`) están a tres órdenes de magnitud de 18,4-32 M celdas.
  · **Ficheros**: `src/world/gpu/puente.ts` (nuevo), `scripts/compute-ecology-gpu.py` (buffers residentes, protocolo de deltas, topes), `tests/gpu-puente.test.ts` (nuevo, con `skip` sin CUDA).
  · **Tests**: 1 000 pasos con la GPU residente dan el mismo digesto que en CPU; matar el subproceso a mitad aborta el paso **antes** del swap y el mundo no queda a medias; los bytes de subida y de bajada se cuentan **por separado** y el test falla si la subida pasa de 1 MB/paso.
  · **Control (experimento)**: tick ecológico **íntegro** (`ecology()` + kernel) a 1 M, 4 M, 18,4 M y 32 M celdas, GPU vs 8 workers vs 1 hilo, misma escena, con las dos direcciones de transporte medidas.
  · **Cierre**: **18,4 M ≤ 20 ms**, **32 M ≤ 25 ms**, subida **≤ 1 MB/paso**, bajada **medida con su objetivo declarado**, y el punto de cruce real escrito en evidencia.

- [ ] **T123** [P] [claude sonnet · high] **Autoprueba de paridad al arranque, con autodesactivación.**
  Al arrancar, 4 096 celdas sintéticas × 100 invocaciones, `Object.is` contra el kernel de CPU (es lo que ya hace `compare()`, `compute-ecology-core.mjs:89`). **Un solo bit distinto desactiva esa GPU para la sesión**, queda registrado con dispositivo, driver y primer índice divergente, y el mundo sigue en CPU. Es lo que hace honesta la frase «el hardware solo cambia la velocidad» frente a una actualización de driver.
  · **Ficheros**: `src/world/gpu/autoprueba.ts` (nuevo), `src/server/main.ts` (invocación), `tests/gpu-autoprueba.test.ts` (nuevo).
  · **Tests**: con una divergencia **sintética** inyectada de un bit, la GPU queda desactivada, el log lo dice y el mundo avanza con el digesto correcto; sin CUDA la autoprueba no falla, informa `no disponible`.
  · **Control**: la autoprueba tarda ≤ 200 ms al arranque.
  · **Cierre**: los dos tests verdes y la desactivación visible en `performance`.

- [ ] **T124** [P] [minimax/MiniMax-M3] **Reparto por throughput medido, no 50/50 y no persistido.**
  Repartir las regiones entre GPU por throughput medido (≈**78,6 % / 21,4 %**, de 2,5 M/ms y 0,680 M/ms), redondeado a páginas completas, asignado por orden Morton. **El reparto NO se persiste con el mundo**: es configuración de ejecución. El kernel no tiene reducción entre celdas (`compute-ecology-core.mjs:56-65`), así que cualquier frontera da el mismo bit.
  · **Ficheros**: `src/world/gpu/reparto.ts` (nuevo), `tests/gpu-reparto.test.ts` (nuevo).
  · **Tests**: tres repartos distintos (79:21, 50:50, 100:0) dan bytes idénticos; el reparto no aparece en el snapshot.
  · **Control**: «ambas GPU» supera a la 5070 Ti sola a 18,4 M celdas (hoy no lo hace con 50/50).
  · **Cierre**: bytes idénticos en los tres repartos y la mejora medida.

- [ ] **T125** [claude opus · high] **Backends de GPU en la prueba de determinismo.**
  Activar `{gpu:[0]}`, `{gpu:[1]}`, `{gpu:[0,1]}` en `tests/determinismo-hardware.test.ts`, con `skip` explícito y motivo cuando falta `COMPUTE_NVRTC`. Cerrar los 9 backends.
  · **Ficheros**: `tests/determinismo-hardware.test.ts`.
  · **Tests**: los propios.
  · **Control**: referencia 1 hilo sin GPU.
  · **Cierre**: 9 backends verdes (o `skipped` con motivo para los de GPU si no hay CUDA en la máquina de CI).

- [ ] **T126** [orquestador] **Gate C.** Merge T121 → T124 → T123 → T122 → T125 → suite + determinismo con GPU + curva p95(teselas) con GPU → evidencia. **Puerta de entrada**: la etapa no arranca hasta que esté escrita —y con su cifra medida— cuál de las tres salidas de FR-025 se toma para la bajada GPU → CPU; si es la (a), la tarea del SoA como autoridad se da de alta **antes** de empezar. **Cierre**: SC-004 (tick ecológico **íntegro** a 18,4 M ≤ 20 ms, 32 M ≤ 25 ms), los **dos** presupuestos de transporte medidos por separado, y SC-012. **Se despliega** con `motor.gpu=[]` por defecto en el servidor público.

---

## Etapa D — Deltas de persistencia y de red (en paralelo a B y C; solo depende de A)

- [ ] **T131** [P] [gemini/pro · high] **Esquema v5, `technology_checkpoints` y poda de prefijo.**
  Migración **aditiva** `user_version` 4 → 5 con `technology_checkpoints(serial, tick, aggregate_body, prefix_digest, digest)`. Tras validar un checkpoint se adelanta el origen lógico del journal y se elimina el prefijo de `technology_executions`, conservando el digest de frontera como evidencia — el mismo patrón con el que `pruneChronicle` ya poda `events` (`store.ts:457-477`). Hoy el origen es inmutable (`technology-archive.ts:264-275`) y la única `DELETE` es hacia adelante (`:535`), de modo que **cada arranque repite la vida entera del mundo**.
  · **Ficheros**: `src/server/technology-archive.ts`, `src/server/store.ts` (migración y `assertTechnologySchema`), `tests/store-v5.test.ts` (nuevo).
  · **Tests**: una base v4 migra y sigue cargando; el digest de frontera prueba lo podado; una base con un prefijo podado y un digest incorrecto se rechaza con «Explicit recovery required.».
  · **Control (experimento)**: `Store.load()` sobre copias `VACUUM INTO` de los mundos de 243 MB y 600 MB, antes y después.
  · **Cierre**: **≤ 30 s** y **≤ 120 s**, el tiempo **no crece** con las ejecuciones archivadas, y el test de regresión de `2517b19` verde.

- [ ] **T132** [P] [codex/gpt-5.6-sol · high] **Checkpoint + replay acotado; páginas sucias solo para lo no derivable.**
  Los commits intermedios escriben **solo** gestos, cambios estructurales, ids y contadores asignados, versiones y raíz hash, journals y tick durable. El estado numérico se reconstruye desde el último checkpoint con replay **≤ 99 commits**, conservando `DEEP_CHECKPOINT_EVERY_SAVES=100`. Auditoría profunda cada 10 guardados que recalcula hashes y **falla si cambió una página no marcada**. **Motivo**: la ecología escribe toda tesela activa cada 10 ticks, así que toda región está sucia en todo guardado — a 18,4 M teselas serían ≈2,21 GB por guardado.
  · **Ficheros**: `src/server/store.ts` (`save`, slots 1 y 2, replay), `src/server/snapshot.ts`, `tests/store-replay.test.ts` (nuevo).
  · **Tests**: `previous()` devuelve exactamente el commit anterior; un corte simulado a mitad de replay no corrompe; la auditoría profunda detecta una página modificada sin marcar.
  · **Control**: recuperar un mundo guardado y comparar `digestoCanonico` con el original.
  · **Cierre**: crecimiento **≤ 20 MB/día simulado**, p95 de `saveMs` **≤ 20 ms** a 2 000 habitantes, `previous()` exacto.

- [ ] **T133** [minimax/MiniMax-M3] **Terreno dormido con la tupla compacta** (**depende de T132**, ya no es `[P]`).
  *(Corrección 2026-09-19, refutación G5: el bloque de archivo de chunks vive **dentro** del `save()` que T132 reescribe — `store.ts:704-714`, `if (retired.length) { const archive = this.db.prepare('INSERT OR REPLACE INTO chunks VALUES (?,?,?,?)'); … }`, en el mismo `try`. Dos worktrees `[P]` desde el mismo commit base no ven el parche del otro y el merge del gate puede quedar limpio pero descartar en silencio uno de los dos cambios.)*
  Hoy los chunks archivados se escriben con `JSON.stringify(chunk)` (`store.ts:711`) mientras la instantánea viva ya usa `ENCODING='tiles-tuple-v1'` (`snapshot.ts:6-25`): 106,1 KB de media por chunk, el 36,7 % del fichero de 243 MB. Reusar la tupla, con lector de **ambos** formatos durante una versión.
  · **Ficheros**: `src/server/store.ts` (escritura y lectura de `chunks`), `src/server/snapshot.ts`, `tests/store-chunks-tupla.test.ts` (nuevo).
  · **Tests**: un chunk escrito en formato viejo se lee igual; ida y vuelta sin pérdida (incluidos los opcionales, que `encodeSnapshot` ya valida).
  · **Control (experimento)**: mismo barrido de exploración, tamaño de la tabla `chunks` antes/después con `VACUUM INTO`.
  · **Cierre**: **≥ 60 %** menos bytes en `chunks` y `digestoCanonico` intacto tras recargar.

- [ ] **T134** [P] [claude sonnet · high] **`people`, `communities` y `blueprints` por viewport, y censo en el servidor.**
  `projectWorld` (`src/world/index.ts:1037-1046`) aplica a `people` el mismo `visible()` que `projectTerrain` ya usa para `tiles` (`spatial.ts:121`), con margen de una celda. Los agregados de censo (`neighbors`, histograma de `lifeStage`, `protectedCount`) pasan a `stats`, donde hoy el cliente los recalcula recorriendo miles de objetos (`game.ts:419-437`). Subir `PROTOCOL_VERSION`.
  **Alcance ampliado 2026-09-19 (refutación R10, verificada — filtrar `people` no alcanza SC-005 por sí solo)**: en el mismo objeto siguen viajando **sin ningún filtro** `communities` (`index.ts:1050`: `members: [...c.members]`) y `blueprints` (`index.ts:1049`). Cuenta: cada habitante está en como mucho una comunidad, así que con 10 000 habitantes los arrays `members` contienen 10 000 ids; `"descendant-10000",` son 19 B en JSON ⇒ **≈190 KB solo en `members`**, frente al techo de 120 KiB = 122 880 B, **antes** de contar teselas, personas, tecnología, crónica y estadísticas. Las comunidades viajan con `memberCount` y solo los miembros **visibles**; los planos, solo los referenciados por las estructuras visibles (o a petición, como ya hace `technologyRecipeDetail`). Es **cambio de contrato de cliente**: `game.ts:475-476` renderiza un enlace por miembro (`community.members.map(id => personLink(world!, id))`) y hay que adaptarlo aquí mismo o dejarlo declarado para T137 en el informe.
  · **Ficheros**: `src/world/index.ts` (solo `projectWorld`), `src/world/statistics.ts`, `src/shared/types.ts`, `src/client/game.ts` (solo el panel de comunidad), `tests/world-view-size.test.ts` (ampliado), `tests/censo-servidor.test.ts` (nuevo).
  · **Tests**: con 10 000 habitantes inyectados y 40 en cámara, el `state` lleva 40 personas y ninguna lista `members` completa; el panel de comunidad sigue mostrando el recuento correcto y los miembros visibles; los agregados del servidor coinciden con los que el cliente calculaba; `tests/render-demographic-scope.test.ts` y `tests/viewport.test.ts` adaptados al cambio de contrato.
  · **Control**: con 16 habitantes, el `state` no crece y el panel es idéntico.
  · **Cierre**: `state` **< 120 KiB** con 10 000 habitantes en viewport medio, **verificado campo a campo** con el banco de T138 (no solo el total).

- [ ] **T135** [grok/grok-4.6 · high] **Delta de teselas por campo, `ack` y `resync`** (**depende de T134**, ya no es `[P]`).
  *(Corrección 2026-09-19, refutación G5: T134 y T135 declaraban **la misma función**, `projectWorld`. Dos worktrees `[P]` desde el mismo commit base no ven el parche del otro; el delta se construye sobre el `projectWorld` ya filtrado, no en paralelo con él.)*
  Protocolo `state-full` / `state-delta {baseSequence, sequence, tileUpserts(por campo), tileRemovals, peopleUpserts, peopleRemovals, statsDelta}` / `ack {sequence}` / `resync {viewport}`. Las teselas se comparan **después** de la cuantización `r3` (`index.ts:1014`) y se manda **el campo que cambió, no el objeto**: `tile.fertility` deriva `life * 0.0012` por invocación ecológica (`ecosystem-kernel.ts:122`), **más de una milésima**, así que tras un tick ecológico casi toda tesela viva del viewport ha cambiado. Buffer corto de deltas por socket; un `ack` demasiado viejo ⇒ **un** `state-full` acotado al viewport. `state-full` solo con `bufferedAmount = 0`.
  · **Ficheros**: `src/server/app.ts` (`broadcast`, buffer por socket), `src/world/index.ts` (`projectWorld` en modo delta), `src/shared/types.ts`, `tests/red-deltas.test.ts` (nuevo).
  · **Tests**: un cliente que solo recibe deltas durante 1 000 pasos converge al mismo estado que uno con `state` completos; un delta perdido produce exactamente **un** resync; el empuje inmediatamente posterior a un tick ecológico es el caso peor y se mide.
  · **Control**: `red.deltas=false` reproduce el protocolo de hoy.
  · **Cierre**: **< 120 KiB** en viewport medio y **< 250 KiB** en viewport máximo, 0 mensajes descartados y 0 sockets terminados en 1 000 pasos.

- [ ] **T136** [P] [minimax/MiniMax-M3] **Medir `perMessageDeflate` y decidir con el número.**
  Hoy está en `false` explícito (`app.ts:102/113`) sobre el JSON más repetitivo posible. Medir CPU y memoria **por conexión** con 12 clientes a 2 Hz y decidir: si el coste cabe en el presupuesto de 50 ms, se activa; si no, se deja y se documenta por qué. Revisar los umbrales de `send()` (256 KiB / 2 MiB, `app.ts:123-124/153-154`) — **sin subirlos**: si un mensaje no cabe, el arreglo es el delta, no el umbral.
  · **Ficheros**: `src/server/app.ts` (solo la opción del `WebSocketServer` y un comentario con la cifra), `.superpowers/sdd/002/tareas/T136-report.md`.
  · **Tests**: el banco de red de T138 con y sin compresión.
  · **Control**: mismo mundo, mismo viewport, mismos 1 000 pasos.
  · **Cierre**: decisión tomada **con la cifra escrita** en evidencia, sea cual sea.

- [ ] **T137** [P] [claude sonnet · medium] **Cliente: `ack`, deltas y censo desde `stats`.**
  El cliente confirma con `ack`, aplica `state-delta` sobre su copia, pide `resync` cuando pierde la base, lee el censo de `stats` en vez de recorrer `received.people` (`game.ts:419-437`), y `interpolatePeople` (`landscape.ts:1075-1099`) deja de recorrer toda la población recibida por frame (cae solo al filtrar en el servidor, pero el `Map` `prevPeople` debe acotarse igual).
  · **Ficheros**: `src/client/{connection,game,landscape}.ts`, `tests/connection.test.ts` (ampliado), `tests/modo.test.ts` (si aplica).
  · **Tests**: reconexión tras corte largo; delta aplicado sobre base correcta e incorrecta; el panel de censo muestra lo mismo que antes.
  · **Control**: con `red.deltas=false` el cliente funciona exactamente como hoy.
  · **Cierre**: e2e del observador verde y sin errores de consola.

- [ ] **T138** [P] [claude sonnet · high] **Banco de red a escala.**
  `scripts/banco-red.mts`: levanta un servidor con `CARTA_DATA_DIR` temporal y un mundo con N habitantes **inyectados** (fuera de `stepWorld`, solo para medir tamaño), conecta hasta 12 clientes con viewports distintos y mide bytes/paso por cliente, egress total, mensajes descartados y sockets terminados.
  · **Ficheros**: `scripts/banco-red.mts` (nuevo), `package.json`, `tests/banco-red.test.ts` (nuevo).
  **Desglose por campo obligatorio** (añadido 2026-09-19, refutación R10): el banco mide bytes **por campo** del `state` (`tiles`, `people`, `communities`, `blueprints`, `technology`, `events`, `animals`, `structures`, `stats`, `demography`, `organization`, `memories`, `places`) a 40, 1 000 y 10 000 habitantes, de modo que el campo que rebase el techo quede **nombrado**. Un total bajo el techo con un campo creciendo linealmente con la población no cierra SC-005.
  · **Tests**: el banco reproduce las cifras de hoy (270 503 B con viewport 40×28 y 16 habitantes; 1 274 469 B en viewport máximo) dentro de ±5 %; el desglose por campo suma el total dentro de ±1 %; con 10 000 habitantes **ningún** campo crece con la población salvo los agregados de `stats`.
  · **Control**: las cifras de hoy son la línea base.
  · **Cierre**: el banco cierra SC-005 para T134/T135/T136, con la tabla por campo en evidencia.

- [ ] **T139** [orquestador] **Gate D.** Merge T131 → T132 → T133 → T134 → T135 → T136 → T137 → T138 → suite + banco de red + `load()` sobre los dos mundos reales → evidencia. *(Orden corregido 2026-09-19: T133 va **después** de T132 y T135 **después** de T134, porque ya no son `[P]` entre sí; ver refutación G5.)* **Antes de publicar el esquema: `npm run respaldo`.** **Cierre**: SC-005 **medido campo a campo**, SC-006 y SC-007. **Se despliega** (la red antes que el esquema).

---

## Etapa E — Personas en particiones: intención y confirmación — **el hito duro**

### Bloque E.0 — Fuera los cuadráticos (bloqueante; solo depende de A, puede adelantarse a B)

- [ ] **T141** [P] [codex/gpt-5.6-sol · xhigh] **Rejilla espacial de personas — la única vía de consulta por vecindad.**
  `Int32Array` de cabezas por celda + lista enlazada por slot, reconstruida en **O(P) una vez por paso**, no O(P) por persona. **Crítico**: la rejilla debe devolver los vecinos **en el mismo orden** en que hoy los devuelve el `filter` sobre `world.people` (orden de slot), porque `index.ts:324-325` toma el **primero** (`nearbyPeople.find(…)`) y `society.ts:242` hace lo mismo. *(Cita corregida: el `find` de `resourceDispute` está en `society.ts:242`, no en `:244`.)*
  **Alcance ampliado 2026-09-19 (refutación R11, verificada — con solo dos sitios sustituidos, el cierre «R² > 0,95 lineal» de T144 no podía darse)**: la rejilla es **la** vía de consulta «vecinos dentro de radio r» y hay que migrar **todos** estos sitios, todos llamados por persona y por tick desde `choose`/`bodyAndAction`:

  | Sitio | Qué es | Llamado desde |
  |---|---|---|
  | `index.ts:324` | `world.people.filter(… ≤ RADIUS)` | `choose` |
  | `index.ts:574` | `world.people.filter(… ≤ 7)` | `explorationTarget`, desde `index.ts:532,543` |
  | `index.ts:652` | `world.people.filter(… ≤ 2)` | `share`, desde `index.ts:761` |
  | `index.ts:928` | `world.people.filter(… ≤ 2)` | herencia, por muerte |
  | `index.ts:953-959` | bucle sobre toda la población con un `filter` de toda la población dentro | `reproduce` |
  | `society.ts:105` | `world.people.filter(… ≤ 6)` | `settlementOpportunity` (y es el que fuerza el halo 13) |
  | `society.ts:205,207,213,222` | cuatro `world.people.filter(...)` dentro del bucle de personas ⇒ **≈2·P²** cada 120 ticks: 32 M comparaciones a 4 000 habitantes, 128 M a 8 000 | `updateCommunities` |
  | `society.ts:242` | `world.people.find(… ≤ 2)` | `resourceDispute` |

  Para `updateCommunities` basta además un **índice de personas por `communityId`** construido una vez por invocación (baja de O(P²) a O(P)); ese bloque corre en la fase serial, así que su pico **no lo ve el p95** (es el 0,83 % de una ventana de 120) — por eso T161 añade la señal de máximo por ventana.
  · **Ficheros**: `src/world/rejilla.ts` (nuevo), `src/world/index.ts` (`choose`, `explorationTarget`, `share`, herencia, `reproduce`), `src/world/society.ts` (`settlementOpportunity`, `updateCommunities`, `resourceDispute`), `tests/rejilla.test.ts` (nuevo).
  · **Tests**: la rejilla devuelve exactamente el mismo array (mismo orden) que el `filter` para 10 000 consultas aleatorias con P ∈ {50, 500, 5 000}; personas en el borde de celda y con coordenadas negativas; **un test por sitio migrado** que compara el resultado con el de la versión anterior en un mundo de 2 000 personas.
  · **Control (experimento)**: 2 400 pasos, `digestoCanonico` **idéntico** en 3 semillas — es reordenar una búsqueda, **no** cambiar la regla.
  · **Cierre**: digesto idéntico, los ocho sitios migrados, y el ajuste de `p95(P)` a P ∈ {50, 200, 800, 2 000} **lineal con R² > 0,95**.

- [ ] **T140** [gemini/pro · high] **Índices no-persona: `nextIdentity`, estructuras por celda, `localInputs`, capacidad de fauna** (depende de T141; usa su rejilla para `family.ts`).
  *(Tarea nueva de la revisión de refutaciones — R2 y R11. Lleva el número 140 pero **depende de T141 y se mergea después de ella**, porque `family.ts` usa su rejilla.)* Barridos que quedaban en el camino de decisión y que no son consultas de personas:
  · **O(territorio explorado)** — `inventions.ts:82` y `:333`: `nextIdentity(...)` construye el conjunto global de ids con `world.retiredChunks.flatMap(chunk => (chunk.structures ?? []).map(s => s.id))` en **cada invención y cada construcción**, es decir recorre el archivo dormido entero. Pasa a índice incremental de ids (`src/world/indices.ts`), que además es lo que necesita el prefix-sum de `blueprintCounter`/`structureCounter` de T146.
  · **O(teselas activas)** — `technology.ts:284` (y su gemelo `:207`): `host.tiles?.find(t => t.x === Math.round(actor.x) && t.y === Math.round(actor.y))` dentro de `localInputs`, en cada intento de investigación. Debe usar `tileAt` (T113), que ya es O(1).
  · **O(teselas activas)** — `animals.ts:258`: `world.tiles.filter(t => … (t.growth ?? 0) > 0.04 …).length * 3` para la capacidad de fauna. Pasa a recuento incremental mantenido por el paso ecológico.
  · **O(estructuras)** — `index.ts:820`, `inventions.ts:196` y `:355`: `world.structures.find/filter` por celda o por radio. Pasa a índice de estructuras por celda.
  · **O(P)** — `inventions.ts:120` (`≤ CONSTRUCTION_RADIUS`), `inventions.ts:194` (`≤ 4`), `inventions.ts:365` (`world.people.some(p => p === person && …)`: O(P) **para comparar una referencia**; es `person.action === 'eat' && person.hunger > 0` más la pertenencia al array) y `family.ts:57` (elección de pareja): pasan a la rejilla de T141.
  · **Ficheros**: `src/world/indices.ts` (nuevo), `src/world/inventions.ts`, `src/world/technology.ts`, `src/world/animals.ts` (solo la capacidad), `src/world/family.ts`, `src/world/index.ts` (solo el `find` de estructuras de `:820`), `tests/indices.test.ts` (nuevo).
  · **Tests**: cada índice devuelve exactamente lo mismo que el barrido que sustituye, en un mundo con 100 000 chunks retirados, 5 000 estructuras y 2 000 personas; `nextIdentity` sigue dando el **mismo id** que hoy en las mismas condiciones, incluido el caso de un id reanimado desde el archivo.
  · **Control**: 2 400 pasos, `digestoCanonico` **idéntico** en 3 semillas.
  · **Cierre**: digesto idéntico y **ningún** barrido O(P)/O(estructuras)/O(territorio)/O(teselas) en el camino de decisión (grep del inventario de FR-027 vacío).

- [ ] **T142** [P] [gemini/pro · high] **Poda incremental de vínculos.**
  `lineage.ts:141` recorre P × muertes para borrar `bonds` de los fallecidos. Mantener un índice inverso incremental (quién tiene vínculo con quién) y podar solo los afectados, conservando el orden de las claves restantes.
  · **Ficheros**: `src/world/lineage.ts`, `tests/lineage.test.ts` (ampliado).
  · **Tests**: tras 1 000 muertes en un mundo de 2 000 personas, los `bonds` resultantes son idénticos —**incluido el orden de claves**— a los de la versión de hoy.
  · **Control**: digesto idéntico en 3 semillas.
  · **Cierre**: digesto idéntico y coste lineal en muertes, no en P × muertes.

- [ ] **T143** [P] [minimax/MiniMax-M3] **Roster incremental del checkpoint tecnológico.**
  `technology-checkpoint.ts:90-91` construye `new Set(actors.map(...))` en **cada** tick y recaptura O(población) en cada nacimiento o muerte. Mantener el roster de forma incremental.
  · **Ficheros**: `src/world/technology-checkpoint.ts`, `tests/technology-checkpoint.test.ts` (ampliado).
  · **Tests**: el checkpoint resultante es byte a byte el de hoy tras 2 400 pasos con nacimientos y muertes.
  · **Control**: digesto idéntico.
  · **Cierre**: digesto idéntico y el coste por tick deja de depender de P.

- [ ] **T144** [claude sonnet · high] **Cierre medido de E.0: la curva se vuelve lineal** (depende de T140, T141, T142 y T143).
  Correr `scripts/curva-techo.mts --escala habitantes --hilos 1` a P ∈ {50, 200, 800, 2 000} con y sin el bloque E.0, ajustar lineal y cuadrático, y dejar el R² de ambos en evidencia. **Medir además el máximo por ventana**, no solo el p95: `updateCommunities` corre cada 120 ticks y su pico no aparece en el p95 de 120 muestras (refutación R8).
  · **Ficheros**: `docs/EVIDENCIA.md`, `.superpowers/sdd/002/tareas/T144-report.md`.
  · **Control**: el commit anterior a T141 como control.
  · **Cierre**: **R² > 0,95 sobre el ajuste lineal** y **≥ 700 habitantes** a p95 < 50 ms con 1 hilo. **Si el R² no se alcanza, el informe debe nombrar el término cuadrático que quedó vivo** (con fichero:línea) y la tarea no cierra: la lista de FR-027 es el punto de partida de esa búsqueda, no su final.

### Bloque E.1 — Intención y confirmación (cambio de reglas declarado)

- [ ] **T145** [claude opus · xhigh] **Fase B (solo lectura) y fase C (confirmación ordenada).**
  Partir `bodyAndAction`/`choose` (`index.ts:685-907`) en: fase B que **no escribe nada en el mundo** y emite `Intent {fase, tipoRecurso, recursoId, actorSlot, secuenciaLocal, cantidad, payload}`; y fase C que aplica los intentos que tocan celdas de su región **ordenados por `(celda, slot)`**. Migración de entidades entre regiones **tras la barrera**, en orden `(regiónDestino, slot)`; **el slot no cambia nunca**. Lo delicado no es el paralelismo: es separar decidir de escribir en un fichero donde hoy están entrelazados.
  · **Ficheros**: `src/world/index.ts` (fases B y C), `src/world/paralelo/reduccion.ts` (nuevo), `src/world/animals.ts` (decisión regional; `move` **sigue serial**), `src/world/society.ts`, `src/server/app.ts`.
  · **Tests**: `tests/intencion-confirmacion.test.ts` (nuevo): dos personas compitiendo por la misma tesela desde regiones distintas dan el mismo ganador con 1, 2, 8 y 28 hilos y con 3 geometrías de partición; ningún intento se pierde ni se aplica dos veces.
  · **Control**: los 9 backends **idénticos entre sí** (ya no al mundo de hoy: ver T149).
  · **Cierre**: 9 backends idénticos, incluido el adversarial, y `motor.particionarPersonas=false` revirtiendo al motor de la etapa B.

- [ ] **T146** [P] [codex/gpt-5.6-sol · xhigh] **Prefix-sum de los NUEVE contadores de identidad en el coordinador.**
  Los workers **no** incrementan ningún contador: emiten candidatos con clave `(tick, fase, regionMorton, actorSlot, secuenciaLocal)` y el coordinador hace *stable sort* + *prefix-sum* desde el contador confirmado. Se conservan los ids legibles `descendant-N` / `community-N`; `discoveredChunks` deduplica por `chunkKey` y suma transiciones `false→true`. **PROHIBIDO** el hash `seed:tick:posición` (invalida los mundos guardados: los ids viven en la crónica, en `legacy` y en los snapshots) y **prohibido** `Atomics` para asignarlos.
  **Alcance ampliado 2026-09-19 (refutación R2, verificada — la tarea cubría cuatro contadores y hay nueve, los cinco que faltaban se asignan todos dentro de `bodyAndAction`, el bloque `index.ts:685-907` que T145 parte)**:

  | Contador | Dónde se incrementa | Llega desde |
  |---|---|---|
  | `world.birthCounter` | `index.ts` `reproduce` | — |
  | `world.communityCounter` | `society.ts:226` | `updateCommunities` |
  | `world.eventCounter` | `addEvent` | crónica |
  | `world.discoveredChunks` | `index.ts:908-910` | descubrimiento de chunk |
  | `technology.executionCounter` | `technology-execution.ts:15,17`, ids `process-N` | `useTool` (`technology.ts:242,254`) desde `index.ts:791` |
  | `technology.itemCounter` | `technology.ts:401`, ids `product-N` | `craft` |
  | `technology.recipeCounter` | `technology-catalogue.ts:132,135`, ids `recipe-N` | `research`/`invent` |
  | `world.blueprintCounter` | `inventions.ts:318` | `invent` |
  | `world.structureCounter` | `inventions.ts:335` | `build` |

  **La unidad del prefix-sum para tecnología es la TRANSACCIÓN, no la ejecución suelta.** El código ya verifica contigüidad de seriales y una renumeración ingenua la rompe: `technology.ts:422` construye `nestedExecutionIds: Array.from({length: state.executionCounter - transactionStart}, (_, n) => 'process-' + (transactionStart + n + 1))` —asume un **rango contiguo por transacción**—; `technology.ts:636` exige `serial === previousSerial + 1`; `technology-journal.ts:25-26` exigen `journal.pending.length === executionCounter - committedThrough` y `history.length + historyDropped === executionCounter`; y `catalysts[].executionId` referencia ejecuciones por id. El coordinador debe renumerar **en bloque**: `id`, `nestedExecutionIds`, `catalysts[].executionId` y el orden de `journal.pending` e `history`.
  **`blueprintCounter`/`structureCounter` necesitan el índice de ids de T140**: hoy `nextIdentity` lee `world.retiredChunks.flatMap(...)` (`inventions.ts:82,333`), el archivo dormido entero, en cada asignación.
  · **Ficheros**: `src/world/paralelo/identidades.ts` (nuevo), `src/world/index.ts` (`reproduce`, descubrimiento de chunk), `src/world/society.ts` (`updateCommunities`), `src/world/technology-execution.ts`, `src/world/technology.ts`, `src/world/technology-catalogue.ts`, `src/world/inventions.ts`, `tests/identidades.test.ts` (nuevo).
  · **Tests**: 5 nacimientos simultáneos en 3 regiones dan la misma secuencia de ids con 1, 8 y 28 hilos; **dos crafteos anidados simultáneos en regiones distintas**, con `assertTechnology` como oráculo, conservan la contigüidad por transacción y la coherencia de `nestedExecutionIds`/`catalysts`; `assertTechnologyJournal` verde tras 2 400 pasos con 28 hilos; un mundo guardado con ids viejos sigue cargando.
  · **Control**: con `motor.hilos=1` la secuencia de ids es **exactamente** la de hoy, para los nueve contadores.
  · **Cierre**: mismas secuencias en todos los backends, `assertTechnology` y `assertTechnologyJournal` verdes, y compatibilidad con mundos guardados.

- [ ] **T147** [P] [gemini/pro · high] **SoA caliente de persona conservando el orden de iteración.**
  Página fija caliente (objetivo 1 024 B, presupuesto de planificación 4 KiB con spill) y piscinas variables (`visited` como pares Int32, experiencias/hábitos por referencia al journal, `bonds` como aristas). **Requisito que ninguna propuesta vio**: `society.ts:183` hace `Object.keys(person.skills).filter(…).sort((a,b) => skills[b]-skills[a])[0]` y con dos habilidades **empatadas** el desempate es el **orden de inserción** del `Record`. El SoA debe conservarlo con una **columna de orden explícita** — o declararse como cambio de reglas con su propia evidencia.
  · **Ficheros**: `src/world/soa/personas.ts` (nuevo), `src/world/society.ts` (solo el desempate), `tests/soa-personas.test.ts` (nuevo).
  · **Tests**: **test dedicado con dos habilidades empatadas** que comprueba que se enseña la misma; ida y vuelta de una persona real sin pérdida; bytes por persona medidos sobre el buffer.
  · **Control**: 2 400 pasos con y sin el SoA de persona: digesto **idéntico**.
  · **Cierre**: digesto idéntico, test de empate verde y **≤ 4 KiB/habitante** medidos.

- [ ] **T148** [P] [claude sonnet · high] **Modo depuración: los buffers del mundo son de solo lectura en la fase B.**
  Con `motor.depuracion=true`, los buffers del mundo se marcan de solo lectura durante la fase de decisión y **cualquier escritura lanza nombrando el slot culpable**. Es la única mitigación concreta contra la escritura fugada, que rompe el determinismo de forma intermitente y difícil de ver.
  · **Ficheros**: `src/world/paralelo/guardia.ts` (nuevo), `src/world/params.ts` (clave `motor.depuracion`), `tests/guardia-fase-b.test.ts` (nuevo).
  · **Tests**: una escritura sintética en fase B lanza con el slot; con `depuracion=false` el coste es cero.
  · **Control**: el digesto no cambia al activar la guardia.
  · **Cierre**: la guardia activa en todas las corridas del laboratorio de la etapa E.

- [ ] **T149** [claude opus · high] **`RULES_VERSION` 6 → 7 y migración.**
  Separar decidir de escribir hace **simultáneas** todas las decisiones: hoy la persona N+1 ve la cosecha de la persona N dentro del mismo tick (`index.ts:797-800,907`). Es un cambio de reglas: subir `RULES_VERSION`, escribir la migración y declarar en `docs/REGLAS.md` qué cambia y por qué. **A partir de aquí la puerta de calidad deja de ser «digesto idéntico al mundo de hoy» y pasa a ser «los 9 backends idénticos entre sí»**; eso debe quedar escrito en el propio test.
  · **Ficheros**: `src/world/index.ts` (`RULES_VERSION`, `migrateWorldState`), `docs/REGLAS.md`, `tests/migracion-v7.test.ts` (nuevo).
  · **Tests**: un mundo v6 guardado migra y pasa `assertWorld`; el digesto del mundo migrado es estable.
  · **Control**: ninguno posible contra el mundo de hoy — por eso existe T150.
  · **Cierre**: migración verde y la nueva puerta escrita en `tasks.md`, `plan.md` y el test.

- [ ] **T150** [orquestador + gemini/pro para leer `resumen.md`] **Campaña de evidencia del cambio de reglas.**
  16 réplicas × 25 días con reglas v7, contra 16 réplicas × 25 días con reglas v6 (control), mismas semillas. Métricas fijadas **antes**: supervivencia de fundadores, población final/inicial, muertes por causa, índice de diversidad, Gini de nº de hijos por progenitor, generaciones vivas, `edadMuerte.cv`. Si la reducción canónica empeora alguna, **se revisa la reducción**; no se publica igual.
  · **Ficheros**: `docs/EVIDENCIA.md`, `.superpowers/sdd/002/tareas/T150-report.md`.
  · **Control**: el commit anterior a T145.
  · **Cierre**: ninguna métrica de vida empeora fuera de su banda declarada (SC-002..SC-005 del spec 001 se mantienen), y la fila está en `docs/EVIDENCIA.md` con SHA, semillas, réplicas y duración.

- [ ] **T151** [P] [claude sonnet · high] **Fracción serial y ocupación de workers.**
  Medir y publicar la fracción serial del paso (fase D + barreras + `save`) y la ocupación media de los workers durante la fase B. Es el número que decide si un servidor 10× mayor da 10×: con 5 % la aceleración topa en 20×, con 10 % en 10×.
  · **Ficheros**: `src/server/app.ts`, `src/world/paralelo/piscina.ts`, `src/shared/types.ts`, `tests/fraccion-serial.test.ts` (nuevo).
  · **Tests**: con `motor.hilos=1` la fracción serial es 1; con 28 y carga equilibrada, ≤ 0,05.
  · **Control**: la aceleración medida coincide con la que predice Amdahl a partir de la fracción publicada (±20 %).
  · **Cierre**: **fracción serial ≤ 5 %** y **ocupación media ≥ 70 %**.

- [ ] **T153** [codex/gpt-5.6-sol · xhigh] **Acumuladores agregados fuera del worker** (depende de T145; bloquea el control de T145, T149 y T152). *(Tarea nueva de la revisión de refutaciones — R3.)*
  `count(world, key, amount)` (`statistics.ts:97`: `world.totals[key] = Math.min(1e12, (world.totals[key] ?? 0) + amount)`) se invoca **dentro de `bodyAndAction`**, o sea dentro del bloque que T145 reparte entre regiones: `index.ts:722` (`foodHarvested`), `:744` (`waterConsumed`), `:793` (`woodGathered`/`stoneGathered`), `:801` (`foodHarvested`), `:805` (`cultivations`), `:814` (`hunts` y `foodHarvested`). El mismo patrón está en `inventions.ts:364` (`world.inventionDynamics.foodTaken += amount`) y `technology.ts:251` (`state.ledger.toolUses++`), y hay que revisar `demographyDynamics` y `animalDynamics`.
  **Por qué es una refutación y no una mejora**: la suma FP64 **no es asociativa**. Con miles de habitantes cosechando, `foodHarvested` recibe sumandos de orden 10⁻² sobre un acumulado que crece a 10⁶; agruparlos por región en vez de por slot cambia el último bit, y el `Math.min(1e12, …)` se aplica **en cada suma**. T101 mete `totals` **explícitamente** en el digesto canónico, así que el control de T145 —«los 9 backends idénticos entre sí»— fallaría de forma **sistemática** en cuanto cambiara la geometría de partición, que US2-4 exige probar (256×256 y 512×512). Se puede comprobar sin escribir el motor: basta sumar la misma lista de cosechas en dos órdenes.
  **Dos formas admitidas, elige una y mide su coste**:
  · (a) la contribución viaja como `Intent` y el coordinador la aplica en orden `(actorSlot, secuenciaLocal)` — coste O(eventos del paso), que **hay que meter en la fracción serial de T151/FR-021**; o
  · (b) el worker acumula en **punto fijo entero** (milésimas, asociativo) por región y el coordinador convierte y satura **una sola vez**.
  · **Ficheros**: `src/world/statistics.ts` (solo `count` y el tipo de `totals`), `src/world/paralelo/agregados.ts` (nuevo), `src/world/index.ts` (los seis puntos de llamada), `src/world/inventions.ts` (`inventionDynamics`), `src/world/technology.ts` (`ledger`), `tests/agregados.test.ts` (nuevo).
  · **Tests**: una escena de cosecha simultánea en dos regiones da `world.totals` **bit a bit idéntico** con 1, 8 y 28 hilos **y con las dos geometrías de partición**; un test negativo que acumula en FP64 por región y comprueba que la prueba lo detecta; el `Math.min(1e12, …)` se aplica una sola vez y el valor saturado coincide con el de hoy.
  · **Control**: con `motor.particionarPersonas=false`, `world.totals` es **exactamente** el de hoy tras 2 400 pasos en 3 semillas.
  · **Cierre**: bits idénticos en los backends y en las dos geometrías, y el coste de la reducción declarado dentro de la fracción serial.

- [ ] **T152** [orquestador] **Gate E.** Merge T142 → T143 → T141 → **T140** → T144 → T147 → T146 → T148 → T151 → T145 → **T153** → T149 → suite + `determinismo-hardware` modo largo + curva de habitantes con 28 workers + T150 → evidencia. **Cierre**: SC-003 (≥ 4 000 habitantes), SC-008, 9 backends idénticos entre sí **en las dos geometrías de partición**. **Se despliega con «mundo nuevo por versión publicada»** (decide Steven).

---

## Etapa F — El gobernador hace crecer el mundo activo

- [ ] **T161** [P] [claude sonnet · high] **Señales del gobernador.**
  p50/p95/p99 del paso y **por fase**, **máximo por ventana**, `tickHz`, p95 ecológico (CPU y GPU), RSS, VRAM libre por dispositivo, cola de red (`max(bufferedAmount)`, `state` descartados, resyncs), `saveMs` y cola durable, regiones activas, teselas activas y **teselas activas por habitante**, población, nacimientos y muertes.
  **El máximo por ventana es obligatorio** (añadido 2026-09-19, refutación R8): el p95 sobre 120 muestras (`app.ts:224-226`) es **ciego a los picos de cadencia larga**. `updateCommunities` corre cada 120 ticks (`society.ts:199`), `worldStatistics` cada 200 y el guardado cada 20: un pico de un segundo cada 120 pasos es el **0,83 %** de la ventana —por debajo del percentil 95— así que el mundo se congelaría ~1 s cada 12 s con el panel en verde. Eso choca con US5 y con el principio VI. La señal debe publicar también **qué fase** produjo el máximo.
  · **Ficheros**: `src/server/app.ts`, `src/world/statistics.ts`, `src/shared/types.ts`, `tests/gobernador-senales.test.ts` (nuevo).
  · **Tests**: cada señal se publica y tiene rango válido; `teselasPorHabitante` con 0 habitantes no lanza; **un pico sintético de 1 s cada 120 pasos deja el p95 verde y el máximo por ventana en rojo**, y el panel nombra la fase.
  · **Control**: el coste de medir ≤ 2 % del paso.
  · **Cierre**: todas las señales en `performance.gobernador`.

- [ ] **T162** [claude opus · high] **Estados, umbrales y palancas con prioridad estricta.**
  Verde / amarillo / rojo / manual, con la histéresis que ya existe (35/50 ms) y **tres ventanas verdes (36 s)** para salir de rojo. Palancas en orden, **una sola activa a la vez**: (1) área — retirar páginas frías; (2) nacimientos — lo de hoy; (3) cadencia de red — subir `subscribeMs` antes que descartar; (4) cadencia de guardado — dentro de un máximo, **sin tocar** la invariante «un gesto fuerza guardado en su propio paso» (C3/C12, `app.ts:216-221`). La orden humana (`manual`) manda siempre. `decideReproduction` sigue siendo una **función pura** (lo exige `tests/gobernador.test.ts`).
  · **Ficheros**: `src/server/app.ts` (`governReproduction` → `gobernar`), `src/world/params.ts`, `tests/gobernador.test.ts` (ampliado).
  · **Tests**: cuatro señales disparando a la vez ⇒ una sola palanca; oscilación acotada; `manual` gana a todo; la función pura sigue siéndolo.
  · **Control**: `gobernador.senales=['p95']` reproduce el gobernador de hoy exactamente.
  · **Cierre**: tests verdes y control idéntico.

- [ ] **T163** [P] [codex/gpt-5.6-sol · high] **Desalojo de páginas frías y caché LRU de terreno dormido.**
  «Reducir área» = retirar páginas **sin habitantes ni halos obligatorios**, ordenadas por `(distancia mínima, lastTick, regiónId)`, respaldadas por la tabla `chunks` que el `Store` ya tiene y por `context.loadChunk` que ya existe (`spatial.ts:13`). **Nunca** impedir el movimiento ni borrar mundo: si una persona cruza una frontera, se activa la página obligatoria y se retira otra fría. **PROHIBIDO** la palanca «reducir `maintainRegions` de ±8 a ±8 solo alrededor de personas»: es un **no-op**, `spatial.ts:57-63` ya hace exactamente eso.
  · **Ficheros**: `src/world/spatial.ts` (retiro y reanimación), `src/world/lru.ts` (nuevo), `src/server/store.ts` (paginación de `chunks`), `tests/desalojo.test.ts` (nuevo).
  · **Tests**: una persona que camina 1 000 celdas nunca ve una página obligatoria ausente; el conjunto activo se mantiene bajo el techo sin que el mundo pierda información (recargar da el mismo digesto).
  · **Control**: 30 días con y sin desalojo: mismo digesto del día 5, distinta memoria.
  · **Cierre**: memoria acotada y digesto intacto.

- [ ] **T164** [P] [minimax/MiniMax-M3] **Techo observado.**
  `performance.gobernador.techoObservado = {p95, poblacion, teselasActivas, teselasPorHabitante, senal, tick}` del último frenazo, más el motivo legible («frenado por p95 = 52 ms con 3 180 habitantes y 4,2 M teselas activas»).
  · **Ficheros**: `src/server/app.ts`, `src/shared/types.ts`, `tests/techo-observado.test.ts` (nuevo).
  · **Tests**: tras un frenazo sintético, el campo se puebla y no se borra al volver a verde.
  · **Control**: no cambia el digesto (es publicación).
  · **Cierre**: el campo viaja en el `state`.

- [ ] **T165** [P] [claude sonnet · medium] **Panel del techo en el cliente.**
  Mostrar estado del gobernador, señal disparadora, techo observado y teselas por habitante, en escritorio y en modo observador. Sin adornos: causas, como pide el principio VI.
  · **Ficheros**: `src/client/{game,world-shell}.ts`, `tests/panel-gobernador.test.ts` (nuevo).
  · **Tests**: el panel muestra lo que el `state` trae; con el gobernador en manual lo dice.
  · **Control**: e2e del observador verde.
  · **Cierre**: captura en `artifacts/` con el techo visible.

- [ ] **T166** [orquestador] **SC-013: la prueba literal de «el límite lo pone el hardware».**
  Mismo mundo, misma semilla, **100 días simulados**: `motor.hilos=1` vs `motor.hilos=28` (y una tercera corrida con `motor.gpu=[0]`). Registrar población final, teselas activas, p95, **máximo por ventana** y el digesto del día 5.
  **Por qué 100 días y no 30** (corrección 2026-09-19, refutación R7, verificada): el ritmo de nacimientos lo fija el **software**, no el hardware. `index.ts:949` sale si `world.tick % pop.intervaloComprobacionTicks !== 0` y `index.ts:953` hace como mucho `pop.nacimientosPorComprobacion` nacimientos por comprobación; `params.ts:49` da `{intervaloComprobacionTicks: 120, nacimientosPorComprobacion: 2}` y `TICKS_PER_DAY = 2400` (`index.ts:39`). 30 días = 72 000 ticks ⇒ 600 comprobaciones ⇒ **≤ 1 200 nacimientos sea cual sea el hardware**, porque el gobernador solo puede **apagar** la reproducción (`app.ts:225-235`), nunca acelerarla. Con el suelo de 1 hilo de SC-003 (≥ 700 habitantes), «≥ 4×» pide ≥ 2 800: imposible en 30 días. A 100 días (240 000 ticks) el techo sube a 4 000 nacimientos, que sí deja sitio a los ≥ 4 000 de la etapa E frente a los ≥ 700 de 1 hilo.
  **Subir `poblacion.nacimientosPorComprobacion` NO es una salida**: contradice US1 («crece el doble sin tocar código ni parámetros») y su propio rango tiene otro tope de software (`params.ts:72`: `[0, 20]`). Derivar el calendario de la demografía (parejas fértiles disponibles) sería un **cambio de reglas** con su `RULES_VERSION` y su evidencia: fuera de alcance salvo decisión de Steven.
  · **Ficheros**: `docs/EVIDENCIA.md`.
  · **Control**: la corrida de 1 hilo.
  · **Cierre**: población con 28 hilos **≥ 4×** la de 1 hilo, y **digesto del día 5 idéntico** en las tres corridas. La fila de evidencia **debe escribir la cota del calendario** (4 000 nacimientos en 100 días) junto a la cifra medida: si la corrida de 28 hilos queda pegada a ella, lo que se midió es el calendario y no el hardware, y hay que decirlo. Si el digesto difiere, la feature **no cierra**.

- [ ] **T167** [orquestador] **Gate F.** Merge T161 → T164 → T163 → T165 → T162 → T166 → suite + barrido de 30 días + evidencia consolidada. **Cierre**: SC-011 y SC-013. **Se despliega.**

---

## Cierre

- [ ] **T171** [P] [claude opus ×3 lentes: **hardware en la regla** · **orden de llegada** · **cambio de mundo no declarado**] **Revisión adversarial del diff completo** Gate A0 → HEAD, en workflow. Cada lente lee el diff entero buscando su patrón: (1) `availableParallelism`, `n/hilos`, tamaños de partición o capacidades medidas dentro de una fórmula del mundo; (2) reducciones, sumas o desempates que dependan de quién termina antes, incluidos `Atomics` mal usados y sumas en árbol; (3) cualquier cambio de comportamiento del mundo que no esté en FR-020 ni versionado. Cada hallazgo CONFIRMADO se arregla antes de publicar, delegando al modelo del workstream original.
- [ ] **T172** [P] [gemini/flash · high] **Docs**: `docs/REGLAS.md` (halo único y su inventario de radios, orden de las reducciones, qué cambió en v7 y por qué, parámetros `motor.*`), `docs/EVIDENCIA.md` (consolidar A–F), `docs/CIENCIA.md` (el muro de DRAM y por qué el eje de teselas es de GPU y el de habitantes de CPU), `CLAUDE.md` (comandos nuevos: `npm run techo`, `--hilos`, `--gpu`), `README.md`. Solo docs.
- [ ] **T173** [orquestador, con Steven] **Publicación**: (1) `npm run respaldo` antes de tocar nada; (2) merge a `main`; (3) `npm run build` **solo aquí**, con el servidor parado (sirve `dist/` en caliente); (4) relanzar desde la ventana 0 del tmux `atlas`; (5) comprobar `performance.tickHz ≈ 10`, `p95StepMs < 50` y `performance.gobernador.techoObservado` en el `state`; (6) mundo nuevo por versión publicada si subió `RULES_VERSION` (decide Steven); (7) verificar `https://atlas.humanizar.tech` en escritorio y móvil real.

---

## Dependencies

`T101 → T102 → T100 → todo`. `T103 → T104`. Etapa A → (Etapa B ∥ Etapa D ∥ bloque E.0). `T112 ∥ T114 → T115 → T120 → T117`. Etapa B → Etapa C (`T114 → T121`, `T115 → T122`, `T120 → T121`). `T117 → T125`. Bloque E.0: `T141 → T140`; `{T140, T141, T142, T143} → T144`. `T144 → T145`. `T145 ∥ T146 ∥ T147`; `T145 → T153`; `{T145, T146, T147, T153} → T149 → T150`. Etapa D: `T132 → T133`, `T134 → T135` (**ya no son `[P]` entre sí**). Etapa E → Etapa F (`T151 → T162`, `T163` necesita el SoA de B). `T166` necesita C, E y F. `T171` antes de `T173`.

**T100 bloquea las etapas B y C**: sin él, `decodeSnapshot` y `assertWorld` rechazan cualquier mundo de más de 65 536 teselas activas o 256 chunks, de modo que SC-004 no puede cerrarse ni en CPU ni en GPU, y T112 dimensionaría el SoA contra un tope falso.

**Ficheros compartidos y orden de merge**: `src/world/index.ts` lo tocan T100/T103/T104/T106/T107/T113/T120/T130/T134/T140/T141/T145/T146/T149/T153 en funciones distintas (`assertWorld` topes, `cloneWorld`, `assertWorld` bucles, marcas de fase, `ecology`, `projectWorld`, `choose`, `explorationTarget`, `share`, herencia, `reproduce`, fases B/C, `RULES_VERSION`, puntos de `count`) — se mergea en el orden indicado en cada gate, de menos a más conflictivo; **en `assertWorld` manda T100 sobre T106**. `src/server/app.ts` lo tocan T104/T107/T135/T136/T151/T161/T162/T164 en bloques distintos (`stepOnce`, instrumentación, `broadcast`, opciones del WS, gobernador). `src/server/store.ts` lo tocan T105/T131/T132/T133/T163 — y **T133 va después de T132**, porque su bloque vive dentro de `save()`. `src/world/society.ts` lo tocan T100 (el `>= 8`), T141 (consultas por vecindad y `updateCommunities`), T146 (`communityCounter`) y T147 (el desempate de `skills`), en gates distintos. `src/world/inventions.ts` y `src/world/technology.ts` los tocan T140 (índices), T146 (contadores) y T153 (acumuladores), en ese orden. `src/world/params.ts` la tocan **T102 y T100** (claves `limites.*`), ambas en el gate secuencial A0; si te falta una clave, usa una constante local con `// TODO params:` y repórtalo.

---

## Modelos por tarea (calidad primero; el coste de tokens no es restricción)

**Paso 0 obligatorio antes de lanzar cada workflow de etapa**: `get_ai_quotas` en vivo y, con esos saldos, confirmar o rutear la tabla de abajo **hacia arriba** (nunca hacia abajo: si un proveedor está agotado, se cae al siguiente **más capaz**, no al más barato). En fan-outs grandes se reparte la carga entre proveedores con holgura para poder sostener la calidad en toda la etapa.

| Tarea | Modelo | Esfuerzo | Por qué |
|---|---|---|---|
| T101 digesto canónico | claude opus | high | Es **la** puerta de calidad de toda la feature; si está mal, todas las etapas prueban nada |
| T102 params, T109 curva, T111 halo, T118 lab, T123 autoprueba, T134 viewport, T137 cliente, T138 banco de red, T144 cierre E.0, T148 guardia, T151 fracción serial, T161 señales, T165 panel | claude sonnet | high (T137/T165: medium) | Codificación seria y bien acotada; cuota Claude holgada, y son tareas con contrato claro |
| T103 clon acotado, T105 prep/flush, T114 port SoA, T120 `ecology()` al camino paralelo, T132 checkpoint+replay, T163 desalojo | codex/gpt-5.6-sol | high | Transacciones, aliasing y persistencia: donde un error se paga en corrupción, no en lentitud |
| **T100 topes de anticorrupción** | codex/gpt-5.6-sol | high | Toca `decodeSnapshot` y `assertWorld`, las dos puertas que protegen el mundo guardado: relajarlas mal se paga en corrupción silenciosa |
| T112 SoA + presencia, T121 `enCuenca` en CUDA, T141 rejilla espacial, T146 prefix-sum de identidades, **T153 acumuladores agregados** | codex/gpt-5.6-sol | **xhigh** | Las cinco con trampa aritmética o de orden: máscara de presencia, `Math.imul` con overflow, orden de vecinos, identidades sin `Atomics`, asociatividad de FP64. Rúbrica punto 4 |
| T104 quitar el clon, T115 pool de workers, T122 puente GPU, T125 backends GPU, T149 RULES_VERSION, T162 gobernador | claude opus | high | Contratos compartidos, atomicidad y decisiones que tocan el servidor público |
| T117 prueba de determinismo, T145 intención/confirmación | claude opus | **xhigh** | Los dos hitos duros: la prueba que sostiene el requisito no negociable y el cambio que lo pone a prueba |
| T106 assertWorld, T131 esquema v5, **T140 índices no-persona**, T142 poda de bonds, T147 SoA de persona | gemini/pro | high | Contexto largo sobre ficheros grandes (`index.ts`, `store.ts`, `technology-archive.ts`, `inventions.ts`) y razonamiento sobre invariantes |
| T116 máscara de fauna, T135 deltas de red | grok/grok-4.6 | high | Lógica no trivial bien acotada; reparte carga entre proveedores en las etapas de fan-out grande |
| T107 perfil, T108 candado del banco, T124 reparto GPU, T133 tupla de chunks, T136 deflate, T143 roster, T164 techo observado | minimax/MiniMax-M3 | — | Cambios pequeños, mecánicos y bien especificados; el volumen barato que libera cuota para lo difícil |
| T171 revisión adversarial ×3 lentes | claude opus | high | Verificación adversarial (rúbrica punto 4); la lente «¿puede el hardware cambiar el resultado?» no se delega barato |
| T172 docs | gemini/flash | high | Documentación masiva sobre mucho contexto |
| T150 lectura del barrido | gemini/pro | high | Leer y comparar `resumen.md` de 32 réplicas |
| Gates (T110, T119, T126, T139, T152, T167), T166, T173, rulings | orquestador (Opus 4.8; Fable 5 solo si un hito se atasca) | — | Orquestación, decisiones críticas y síntesis no se delegan |

**Revisor adversarial por tarea**: claude opus para todas; `codex/gpt-5.6-sol` con `effort: high` para las de determinismo (T112, T114, T115, T116, T117, T120, T121, T141, T145, T146, T147, T153), porque son las que hay que intentar **romper**, no solo leer. Para T100 el revisor debe intentar **cargar un mundo corrupto** que antes se rechazaba: relajar un tope de anticorrupción no puede abrir la puerta a un snapshot inválido.

---

## Notes

- Ninguna cifra de techo entra en `docs/EVIDENCIA.md` sin réplicas y control. Las tres propuestas dieron 20 000–45 000 / 8 000 / 6 000–13 000 habitantes: solo la fila del clon estaba medida.
- El *work stealing* sobre la cola de regiones es **gratis por construcción** una vez el backend adversarial esté verde, y está **prohibido** antes. Cuando se active, va en su propia tarea con su propio control.
- La prueba de determinismo en modo largo no entra en `npm test`: la suite ya tarda ~10 min y `world.test.ts` ~5 min. Va tras bandera y en el gate de etapa.
- Si una etapa no alcanza su métrica, **no se maquilla**: se escribe la cifra alcanzada en evidencia y se decide si se sigue o se rehace. «Parece mejor» no cierra nada (constitución II).
