# E.1 «Intención y confirmación»: revisión de diseño (2026-09-23)

Revisión de solo lectura: no se cambió código. Base: `main` @ `200d284`, `RULES_VERSION = 10`
(`src/world/index.ts:36`). También se leyeron tres ramas en curso: T141 (`sprint/002-e0-t141` @ `fbdd95b`),
T111 (worktree `AtlasParaIsa-n-B-t111`, sin commit) y R11 (`sprint/reglas11-20260923`). Las líneas se citan contra
`200d284`, no contra `f30d528`.

**Veredicto corto: todavía no se puede implementar.** La idea de fondo sigue en pie: decidir sobre un estado congelado
cambia las reglas y hay que declararlo y medirlo. Pero el contrato «la fase B no escribe nada, la fase C confirma por
`(celda, slot)`» solo cubre una de las cuatro clases de escritura que tiene el código de hoy. Hay además tres errores
que romperían el determinismo entre geometrías de partición, o entre backends:

- la clave de orden de T146 incluye la región;
- los identificadores se citan dentro de textos;
- la ventana LRU de recetas se escribe al leer.

Antes de escribir código hace falta un ruling de diseño (§5). Y el cambio de reglas debe medirse con una implementación
serial de referencia antes de paralelizar (§4).

---

## 1. Qué sigue valiendo y qué quedó obsoleto

**Sigue valiendo**
- El principio de FR-020 y D9. Con decisiones simultáneas la persona N+1 ya no ve lo que la persona N hizo en el mismo
  tick: el bucle es `index.ts:1231`, la cosecha `index.ts:997-1000`. Es un cambio de reglas: se versiona, se mide y
  se publica con mundo nuevo.
- La confirmación por `(celda, orden de persona)` para escrituras sobre la **propia celda** del actor. Tras `move`,
  las acciones físicas exigen `distance(person, target) < 0.5`: comer, beber, recolectar, cultivar, cosechar, cazar,
  construir y descansar actúan sobre la celda del actor (`index.ts:997-1050`).
- T146 en lo esencial: nada de hash ni de `Atomics`, asignación por *prefix-sum* en el coordinador y la transacción
  tecnológica como unidad. Las invariantes de contigüidad siguen en el código: `technology.ts:522` y `:736`,
  `technology-journal.ts:48-49,53`.
- T147/FR-011: el orden de inserción de `skills` y demás es parte del mundo. T148: una guardia de escritura en
  depuración. T151: la fracción serial. T150: la campaña con control.
- La reversión por `motor.particionarPersonas`, siempre que revierta solo el paralelismo y no las reglas.

**Obsoleto o erróneo**
- **Todas las citas `fichero:línea`.** `choose` está hoy en `index.ts:415-837`, `bodyAndAction` en `:968-1056` y el
  bucle de personas en `:1231`. Las llamadas a `count` dentro del bloque están en `:1000, 1023, 1082, 1090, 1094, 1103`.
  `inventions.ts:364` pasó a `:370`, `technology.ts:251` a `:266`, `technology.ts:422` a `:522` y `:636` a `:736`.
- **T149 «`RULES_VERSION` 6→7».** Hoy estamos en 10. R11, la ley de conflicto legible, está en vuelo y reescribe
  `resourceDispute` (`society.ts:457-492`). E.1 debe tomar el siguiente número libre y coordinarse con R11. La
  migración sigue el patrón de `upgradeV10` (`index.ts:1829`): solo cambia la etiqueta.
- **El halo 13 (FR-007) no alcanza.** T111 en curso ya va por `HALO_CELDAS = 14`: `evaluateCooperation` compone 7+7.
  Con reglas 10, además, el cortejo lee a toda persona vinculada **a cualquier distancia** mediante `personById`
  (`index.ts:534-549`). El filtro por radio viene después, y el radio por defecto es 128 (`params.ts:148`). La fase B
  necesita por tanto una tabla de personas **global y de solo lectura**, no un halo. T111 ya lo registra en
  `LECTURAS_POR_IDENTIDAD` (`halo.ts:211` en su worktree).
- **«La fase B no escribe nada».** Hoy `choose` escribe:
  - `person.home` (`society.ts:250,256`);
  - `waterMemory` (`index.ts:568-570`);
  - eventos de memoria (`:833-836`);
  - `work`, `action`, `target` y `decisionAt` (`:826-832`);
  - la ventana LRU de recetas (riesgo R5).

  Antes de decidir, `bodyAndAction` también escribe necesidades y fugas de agua con recibo tecnológico
  (`:969-986`). El contrato correcto es otro: B lee el estado del tick anterior **congelado** y escribe solo el estado
  siguiente **de su propio actor** (doble buffer), más intenciones.
- **«(celda, slot) reproduce el orden de hoy para las escrituras» (D9, T145).** No es así cuando el actor escribe
  fuera de su celda:
  - `takeFood` toma de estructuras a ≤ 1,5 celdas (`inventions.ts:360-375`);
  - `share` escribe al receptor y a los observadores;
  - `cooperate` escribe al otro;
  - `resourceDispute` escribe al otro, y con R11 incluso decide que ceda el otro.
- **T145 incluye `animals.ts` («decisión regional»).** Eso ya es de T116 y T115 (etapa B, ola 1). Debe salir de E.1.
- **Seis contadores de identidad, no nueve.** `birthCounter`, `communityCounter` y `discoveredChunks` ya se asignan
  fuera del bloque que se paraleliza: `reproduce` en `:1244`, `updateCommunities` en `:1243` y el bucle de
  descubrimiento en `:1232-1239`, que va después de todos los `bodyAndAction`. Siguen en la fase D sin prefix-sum.
- **Controles que ya no pueden cumplirse.** T146 pide que con `hilos=1` los ids sean «exactamente los de hoy». T153
  pide que con `particionarPersonas=false` `totals` sea «exactamente el de hoy». Con reglas nuevas ninguna de las dos
  cosas es posible. El control correcto tiene dos partes:
  - los mundos con la versión anterior pasan por el motor intacto, con digesto idéntico al de hoy;
  - los mundos con la versión nueva comparan los backends entre sí.
- **Dependencias que faltan en `tasks.md`.** La línea de dependencias solo dice `T144 → T145`. La fase E paralela
  necesita además, de la etapa B: T115 (pool de workers), T117 (arnés de determinismo), T112 (SoA de terreno) y T113
  (`tileAt` por aritmética).

## 2. Riesgos más graves para el determinismo

**R1. La región entra en la clave de orden (T146, FR-005).**
- *Dónde.* T146 ordena los candidatos por `(tick, fase, regionMorton, actorSlot, secuenciaLocal)`, y FR-005 fija
  `(regiónId, slot)` para la fase global. T145 migra en orden `(regiónDestino, slot)`.
- *Escenario.* En el mismo tick inventan dos personas: la de orden 40 en la región Morton 1 y la de orden 12 en la
  Morton 3. Con regiones de 256×256, `blueprint-65` va a la 40. Con 512×512 las dos caen en la misma región y
  `blueprint-65` va a la 12. El digesto difiere entre geometrías y se viola US2-4.
- *Corrección.* La clave es `(fase, ordenPersona, secuenciaLocal)`, sin región. El «orden de persona» es la posición
  en `world.people` al empezar el paso. Es estable dentro del tick, porque nacimientos y muertes solo ocurren en D
  (`lineage.ts:148`, `index.ts:1326`). T147 no puede reutilizar slots (D7) sin una columna de orden explícita.

**R2. Conflictos entre regiones por el mismo recurso o por un tope global.**
- *Topes globales:*
  - `MAX_STRUCTURES = 512` (`inventions.ts:12,169,331`);
  - `MAX_BLUEPRINTS = 64` (`:11,294,310`);
  - deduplicación de planos por firma (`:263-266`);
  - deduplicación de recetas por firma, con la clasificación de novedad `hasTechnologyFunction`
    (`technology.ts:489-496`).
- *Escenario 1 (topes).* Hay 511 estructuras activas y dos personas terminan una obra en regiones distintas en el mismo
  tick. Hoy construye la de orden menor; la otra falla y pierde su trabajo. En una fase C paralela las dos pasan la
  comprobación.
- *Escenario 2 (recetas).* Dos investigadores descubren la misma firma de programa. Hoy nace una receta; en paralelo
  nacerían dos, y la segunda tendría otra novedad.
- *Escenario 3 (celdas vecinas).* Quien come en x=255 (región A) cae en `takeFood` y descuenta de un granero en
  x=256 (región B), al que también come otra persona de B. Las dos fases C escriben el mismo `structure.food`.
- *Corrección.* Construir, inventar, terminar una investigación o fabricación, cazar (`harvestAt` recorre el arreglo
  global de animales y `syncFauna`) y `takeFood` van a la fase D serial. Esa clase la decide el **tipo** de acción,
  nunca la posición: si dependiera de la frontera, dependería de la geometría.

**R3. Escrituras entre personas y pares simétricos.**
- *Dónde.* `share` escribe hambre y energía del receptor y los hábitos de los observadores, un anillo de 3 con
  `shift` (`index.ts:925-966`). `cooperate` escribe materiales, trabajo, habilidades, objetos y experiencias del otro
  (`society.ts:294-339`). `bond()` acerca la cultura, y eso no conmuta: `bond(a,b)` seguido de `bond(a,c)` no da lo
  mismo que en orden inverso (`society.ts:22-30`).
- *Escenario.* A y B se disputan una fuente en el mismo tick. Hoy, cuando B evalúa, ya está bloqueado por el
  `lastDispute` que acaba de escribir A (`society.ts:466`). Con decisiones simultáneas disparan los dos: el conflicto
  se cuenta dos veces, ceden los dos y la confianza cae 0,16 en vez de 0,08.
- *Corrección.* Las intenciones entre personas se aplican en D, en orden canónico, con el par deduplicado (inicia el
  de orden menor) y **revalidando** contra el estado vigente.

**R4. Identidades citadas dentro de otro estado y de textos.**
- *Dónde.* Hay ids que quedan escritos en otro sitio en el momento de emitirse:
  - `remember(…, event.id)` (`index.ts:134-138,835`) y los hábitos con `sourceEvent`/`evidence.eventId`
    (`:954,959`);
  - **textos**: `hecho ${e.eventId}` (`:962`), `objeto ${item.id}` en la experiencia de cooperar
    (`society.ts:320,337`), `Plano ${blueprint.id}` (`inventions.ts:344`) y el nombre de receta con `recipeCounter+1`
    (`technology.ts:494`);
  - el recibo `executionId` de una herramienta, que `recordTechnologyBenefit` compara con
    `journal.committedThrough` (`technology.ts:271-285`);
  - los `transfer-${executionCounter+1}` (`:591,625`).
- *Riesgo.* El prefix-sum de T146 renumera los contadores, pero no estas referencias. Quedarían ids colgando o textos
  que nombran otro hecho.
- *Corrección.* Hay dos caminos: ids provisionales reescritos en D, o eventos como registros estructurados cuyo texto se
  compone en D.

**R5. Tecnología y su diario.**
- *La ventana LRU se escribe al leer.* `resolveTechnologyRecipe` escribe `state.recipes` porque su `cache` vale `true`
  por defecto (`technology-catalogue.ts:148-172,221-237`), y esa ventana entra en el digesto. Se llama desde la
  decisión: `practicedRecipeToTeach` (`society.ts:135,139`, dentro de `cooperationOpportunity`) y
  `knownTechnologyRecipes` (`technology.ts:60,307`). Si dos workers resuelven en distinto orden, la ventana queda
  distinta y el digesto también.
- *El lector del archivo no llega a un worker.* Es un `DatabaseSync` del hilo principal
  (`technology-catalogue.ts:231-233`, `withArchiveReadBatch`).
- *Las transacciones leen deltas globales.*
  - `lossBefore` (`technology.ts:463,517`) atribuye al actor el cambio **global** de `water.environmentalLoss`, y
    `maintainContainedWater` escribe ese mismo ledger al empezar cada `bodyAndAction` (`technology-water.ts:203-215`).
  - `nestedExecutionIds` (`technology.ts:464,522`) supone que nadie más añade ejecuciones durante la transacción.
- *Corrección.*
  - Las transacciones tecnológicas se ejecutan completas en D.
  - La fase B lee una instantánea congelada de recetas con `cache:false`.
  - Los toques de la LRU pasan a ser intenciones que D aplica en orden canónico.

**R6. Acumuladores fuera de la lista de T153.**
- *Qué falta.*
  - `blueprint.usefulness` es una media móvil exponencial (`inventions.ts:354`): depende del orden incluso con
    aritmética exacta, y **la leen las leyes** (`:238,479`);
  - `recipe.utility` y `catalogue.totals.utility` (`technology-catalogue.ts:284-291`);
  - `ledger.energy` (`technology.ts:546,576`) y la `energy` del ledger de agua (`technology-water.ts:169-176`);
  - `structure.uses`, `place.gatherings` (`index.ts:937-939`) y los contadores `cooperation`/`disputes` de cada
    comunidad.
- *La variante (b) de T153, «milésimas», no sirve.* Una cosecha de 0,0035 no cabe en milésimas. Con una resolución
  suficiente, `1e12 × 2^30` desborda 2^53 y haría falta BigInt.
- *Corrección.* La variante (a), aplicar en D por orden canónico, para todo lo que lee una ley. La (b) solo para
  estadística que nadie lee: se comprobó con grep que ninguna ley lee `world.totals`.

**R7. El digesto no permite comparar backends.**
- *Dónde.* `digestoCanonico` recorre `{world, params}` (`digesto.ts:71`), y los params incluyen `motor.hilos` y
  `motor.orden` (`params.ts:70`). El informe de T102 ya lo anota: el digesto cambia con la configuración.
- *Consecuencia.* «Los 9 backends idénticos», en T117 y en T145, fallaría por construcción.
- *Corrección.* Un `digestoFisico` sin `motor.*`, definido antes de T117.

## 3. Qué cambia en la conducta del mundo y cómo medirlo

**El mecanismo.** Hoy la persona N decide y actúa con lo que ya hicieron las personas 0..N−1 en ese tick. La
diferencia está acotada: las posiciones solo cambian en los ticks múltiplos de 6 (`index.ts:995`), y `choose` corre
cada ~30 ticks o ante una urgencia (`:993`). El cambio grande no está en la percepción, sino en las **cadenas causales
dentro del tick**: compartir, cooperar, disputar, recursos agotados a mitad del tick y los topes globales.

Lo que sigue son hipótesis. No se han medido.

- **Natalidad: efecto directo pequeño.** `reproduce` ya corre al final del paso (`:1244`). El efecto indirecto llega por
  las reservas: fertilidad con reserva ≥ 0,1 (`:1345-1347`) y reserva familiar de 0,12 (`family.ts:7`). Si varios
  donantes alimentan a la vez al mismo hambriento sin revalidar, cada uno pierde 0,025, se desperdicia comida por el
  `clamp` y hay menos adultos fértiles. En escasez también pesa la antigüedad: en la misma celda gana el orden menor,
  es decir, los fundadores y los mayores. Eso ya ocurre hoy al escribir, pero ahora los jóvenes decidirían a ciegas
  sobre bocados que otro ya se llevó. Cabe esperar más mortalidad juvenil en regímenes secos.
- **Cooperación: los recuentos pueden inflarse.** Sin deduplicar pares, A ayuda a B mientras B ayuda a A: los dos
  pagan y el vínculo sube +0,24. Más vínculos mutuos ≥ 0,3 empujan el cortejo y la familia, así que la natalidad
  podría incluso **subir** por un artefacto.
- **Conflicto: el recuento puede duplicarse.** Es el par simétrico de R3. Con menos confianza tras una disputa, bajan
  las comunidades y el cortejo. Hay un bucle negativo posible.
- **Carreras físicas: prácticamente igual que hoy.** Comer, cazar o construir en la misma celda da el mismo resultado,
  porque C aplica en `(celda, orden)` sobre el estado vigente.

**Cómo medirlo antes de adoptarlo.** La idea es hacerlo sin workers y barato:

1. Implementar las fases B/C/D **en serie** (un hilo, modelo de objetos actual) para la versión nueva de reglas.
2. Comprobar que B no depende del orden: evaluar B con `motor.orden` en `natural`, `inverso` y `adversarial` (el
   parámetro ya existe, `params.ts:303`, aunque aún no está cableado) y exigir el mismo `digestoFisico`.
3. Campaña con `scripts/lab/replica.ts`, `CARTA_DATA_DIR` y `TMPDIR=/datos/tmp-atlas-lab`:
   - brazo de control: reglas 10, en el commit anterior;
   - brazo nuevo: reglas nuevas, **con y sin** revalidación y deduplicación de pares;
   - ≥ 32 semillas nuevas × 25 días, más 12 × 60 días evaluadas con `scripts/lab/criterio-terminado.mts --dia 60`
     (C1–C8 del criterio de GOAL.md).

   Comparar distribuciones, no semillas pareadas: la trayectoria es caótica y deja de ser comparable al cabo de pocos
   días.
4. Métricas preregistradas:
   - las de T150;
   - nacimientos por adulto fértil y día (`diagnostico-natalidad.ts`);
   - `totals.conflicts`, `cooperation`, `teaching` y `trade` por habitante y día;
   - comida compartida (`instrumentos.ts`) y mortalidad juvenil;
   - dos instrumentos nuevos, solo de laboratorio: el reparto de recursos disputados por cuartil de orden de persona,
     y las intenciones invalidadas en la confirmación, por clase.
5. Banda de aceptación: la dispersión entre dos mitades del propio control. Si una métrica sale de esa banda, se
   revisa la reducción y no se publica.

## 4. Orden mínimo de tareas y qué depende de T141

0. **Ruling E.1-R (solo documento, ya, en paralelo a E.0).** Fija:
   - las cuatro clases de intención (propia / celda propia / entre personas / catálogo global), con reglas por
     **tipo**;
   - las fases B → barrera y migración → C → D;
   - la clave de orden sin región;
   - los ids y textos compuestos en D;
   - la política de la LRU de recetas y el `digestoFisico`;
   - el número de reglas, coordinado con R11;
   - la salida de `animals.ts` de E.1;
   - las citas corregidas.

   Nada de esto depende de T141.
1. **E.0 según lo previsto**: T142 ∥ T143, luego T141 → T140 → T144. Hay que añadir el O(P²) que el informe de T141
   dejó vivo: `knownBlueprints` y `stepStructures` (`inventions.ts:212,471-482`). Si no, D crece con P² y SC-008 no se
   alcanza.
2. **E.1-ref (T145a, nueva).** Semántica nueva en serie, junto con T153(a) y la asignación de ids en D por clave
   canónica. Su prueba es la invariancia ante `motor.orden`.
3. **T150 sobre E.1-ref** para el veredicto biológico, y después **T149**: siguiente `RULES_VERSION`, migración que
   solo cambia la etiqueta y `docs/REGLAS.md`.
4. **Infraestructura de la etapa B**: T112, T113, T115 y T117 con `digestoFisico`.
5. **Paralelismo**: T147 (SoA de persona **con doble buffer** y columna de orden, sin reutilizar slots) → T148 (la
   guardia protege el buffer **congelado**) → T145b (workers: B por región leyendo la tabla global compartida, C por
   región, D serial) → T146, que en el coordinador queda reducida a verificar → T151 → T152.

**Qué depende de T141**
- *Directamente, E.1-ref.* B necesita la consulta de vecinos en el mismo orden que el `filter`, sobre posiciones
  **congeladas**. La rejilla de T141 es hoy «viva»: `personaMovida` la actualiza en cada `move`. Su cabecera lo dice:
  «la persona k ve ya movidas a las de slot menor». En B no se llama a `personaMovida`: la rejilla se congela al
  principio del paso y se reconstruye tras la barrera. Sus pruebas «rejilla ≡ filter» sirven de oráculo.
- *Para los workers.* Hay que realojarla sobre memoria compartida. `celdas: Map` y `slotPorPersona: Map<Person,…>`
  no se pueden compartir; esto va dentro de T147/T145b.
- *Transitivamente.* T140 depende de T141 (`family.ts`), T146 de T140 (el índice de `nextIdentity`), y SC-008 de
  T144.
- *No dependen de T141*: el ruling, T153, el `digestoFisico`, R4, R5 y la preparación de T150.

## 5. Veredicto

**No está listo para implementarse tras E.0 tal como está escrito.** Antes de la primera línea de código hay que
rediseñar:

1. El contrato de fases: B lee el estado del tick anterior congelado y escribe solo el siguiente estado de su actor
   (doble buffer).
2. La taxonomía de intenciones. Lo que ocurre entre personas, las escrituras fuera de la celda, las transacciones
   tecnológicas, invenciones, obras y cazas, y todos los topes o deduplicaciones globales van a D, por tipo de acción
   y en orden canónico. C queda para la propia celda.
3. La clave de orden sin región (R1).
4. Los ids y referencias en textos (R4).
5. La LRU de recetas y el archivo, que los workers no pueden abrir (R5).
6. La lista completa de acumuladores, incluida la media móvil de `usefulness` (R6).
7. La tabla global de personas en lugar del halo, por el cortejo a 128 celdas.
8. El `digestoFisico` (R7).
9. El número de reglas y los controles reformulados (§1).

Con eso escrito, lo siguiente es E.1-ref en serie más la campaña del cambio de reglas. Solo si la biología no empeora
se pasa al paralelismo, que además necesita la infraestructura de la etapa B.

El riesgo de rendimiento que queda es el tamaño de la fase D. Hay que medirlo en E.1-ref con un contador de
intenciones por clase. Si D pasa del 5 % del paso, SC-008 no se cumple con este reparto.
