# Objetivo 8 A — mapa de ciclos, contadores y persistencia

Auditoría estática de `/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/auditoria-realismo`, commit `bb483260b2489fe62b113d620e5f56e5f3676dbc`. Lecturas a 2026-09-30 22:23 −05:00; cómputo `nice 19`, CPUs 6–31, `TMPDIR=/datos/tmp-atlas-lab`. Se leyó completo `codex-goal-8.md` y se releíeron prohibiciones antes de cada paso. No se cambió código, reglas, evaluación, servicios ni datos; no hubo simulaciones. Este documento separa las constantes del modelo de las cifras empíricas que mide el integrador en copias de respaldos.

## Hallazgos de código que condicionan la lectura de datos

1. **Sí existe deterioro pasivo de las estructuras activas**, cada 10 ticks, sin depender de `uses` ni presencia de un ocupante en la casa. Un techo ordinario pasa de condición 1 a ≤0,1 después de aproximadamente 13,39–20,83 días **de región activa**, según lluvia/seco. Fuente: `src/world/inventions.ts:466–472`; `src/world/ecologia-constantes.ts:14`; `src/world/index.ts:46`.
2. **En una región retirada se congela la condición, los depósitos y el uso**: se copia el objeto y al reactivar se recupera sin envejecimiento por el tiempo transcurrido (`src/world/spatial.ts:121–143,185–210`). Una estructura antigua en calendario puede haber envejecido físicamente 0 ticks durante su dormancia.
3. **No hay desmontaje, ruina explícita, retiro por condición 0, ni liberación de la casilla** en las leyes de estructuras. El objeto roto permanece; la casilla conserva `terrain='shelter'`, bloqueando una nueva construcción (`src/world/inventions.ts:346–348,466–492`; único filtro de retiro físico, que archiva en vez de destruir: `src/world/spatial.ts:206–210`). `Terrain` solo tiene 4 estados: `water`, `soil`, `meadow`, `shelter` (`src/shared/types.ts:23`).
4. `structure.uses=0` significa **0 beneficios directos registrados por tres funciones**, no 0 visitas, 0 ocupación o 0 protección real. La protección frente a exposición en lluvia reduce daño demográfico sin registrar usos (`src/world/lineage.ts:156–169`; `src/world/demography.ts:128–132`). La regla de fatiga climática mira `terrain`, no condición (`src/world/index.ts:382`).
5. `recipe.uses` tecnológico tiene otra semántica: el uso mecánico cuenta aunque `benefit=0`; consumir el producto como sustrato de otra receta no lo incrementa. El uso al beber de un recipiente cuenta mediante recibo `kind='water'`, además de `kind='use'` (`src/world/technology.ts:230–240,272–296`; `src/world/technology-water.ts:274–297`).
6. **No existe `lastUsedAt` ni historial por estructura**. Una diferencia de `uses` entre dos copias sirve para el intervalo completo; no identifica el día exacto ni el actor. El historial corriente del mundo solo tiene 96 muestras cada 60 ticks (2,4 días nominales), y no incluye condición/usos de objetos (`src/world/statistics.ts:100–106`).
7. **Los productos secos no tienen envejecimiento ambiental**: su capacidad depende de masa/integridad y propiedades; pierden masa por trabajo/consumo como insumo, no por `madeAt`. Los líquidos portátiles sí fugan cada tick, aunque el dueño descanse (`src/world/technology.ts:106–115,230–240,265–284`; `src/world/technology-water.ts:219–232`).
8. **Comida y agua de edificios no se pudren ni evaporan** en `stepStructures`; hay llenado, extracción, irrigación y depósitos. Al romperse (≤0,1), sus stocks quedan inaccesibles a las funciones ordinarias y sin pérdida ambiental hasta reparación. La comida del suelo tiene otro ciclo y sí decae (`src/world/inventions.ts:375–490`; `src/world/index.ts:268–287`).
9. **Plano arquitectónico y receta material son dos sistemas**. El primero tiene tope global de 64 planos; las construcciones se limitan a 512 estructuras **activas**, de modo que el total archivado puede superar 512. Las recetas materiales tienen caché residente de 256 y archivo durable, no un catálogo mundial de solo 256 (`src/world/inventions.ts:14–15,184,309,346`; `src/world/technology.ts:56–59,80–85`; `src/world/technology-catalogue.ts:160–179`).
10. **Acumulativos no equivalen a estados vivos**: `settlementCount`, `discoveredChunks`, planos aceptados y totales del catálogo no bajan por muerte, desuso o ruina. La diversidad funcional es un bitmap acumulativo de 6 capacidades con 6 niveles cada una: como máximo 46.656 combinaciones; no mide funciones actuales útiles (incremento de asentamiento en `src/world/inventions.ts:354`; descubrimiento en `src/world/index.ts:1255–1257`; `src/world/technology-catalogue.ts:23,48–54,272–286`).

## A1. Estructuras: construcción, servicio, desgaste y reparación

| Ley / magnitud | Valor y condición | Fuente |
|---|---|---|
| Tiempo | 2.400 ticks/día; ecología/estructura cada 10 ticks = 240 revisiones/día activo | `src/world/index.ts:46`; `src/world/ecologia-constantes.ts:14` |
| Componentes | 6: frame, roof, cistern, granary, garden, hearth; plano de 2–8 componentes | `src/world/inventions.ts:23,41–47` |
| Coste básico | frame 2 madera/1 piedra/20 trabajo + roof 4/2/70 = 6 madera,3 piedra,90 trabajo | `src/world/inventions.ts:24–27,35–36,66–68` |
| Durabilidad | `1 + (n.frame-1)*0.5`; 1 o 1,5 porque el plano admite 1–2 frames | `src/world/inventions.ts:44,50–55` |
| Cisterna | capacidad 0,6 por cisterna; captación 0,012 por cubierta en lluvia, multiplicada por condición | `src/world/inventions.ts:52–55,473–475` |
| Granero | capacidad 0,7 por granero; depósito ≤0,012/persona/revisión, reserva del dueño >0,12, hambre <0,5, distancia ≤1,5 | `src/world/inventions.ts:52,487–490` |
| Huerta | riego 0,008 por módulo × condición; debita cisterna y humedece 4 vecinas hasta 0,75 | `src/world/inventions.ts:53,478–485` |
| Descanso | calidad base 0,82; +0,09 por cubierta adicional,+0,03 por frame adicional; ×condición; exterior seco 0,55/lluvia0,2 | `src/world/inventions.ts:54,424–449` |
| Hogar de fuego | combustible 0,0005 madera/tick de descanso en lluvia o últimos 600 ticks del día; +0,12 calidad; débito exige mejora efectiva | `src/world/inventions.ts:421–449` |
| Desgaste pasivo | condición −0,00018 seco/−0,00028 lluvia dividido por durabilidad cada revisión; clamp[0,1] | `src/world/inventions.ts:466–472` |
| Reparación | −1 madera y −30 trabajo; +0,4 condición hasta1; exige condición <0,95, distancia≤1,5; contador repairs+1 y evento | `src/world/inventions.ts:17,20,457–462` |
| Admisión de nueva obra | radio local7, ganancia de servicio≥0,025 escalada por coste; reparación que gana en eficiencia puede bloquear obra | `src/world/inventions.ts:103–104,161–195` |
| Bloqueo espacial | no agua/shelter, ningún lugar a distancia<5, ninguna estructura en la misma casilla; constructor a≤0,5 | `src/world/inventions.ts:344–348` |

Derivación aritmética, sin simulación y sin reparaciones; aproximación continua del número de revisiones (discretización ≤10 ticks, más alineación inicial):

| Durabilidad | Clima constante | Pérdida/día activo | Hasta condición≤0,1 | Hasta condición0 |
|---:|---|---:|---:|---:|
| 1 | seco | 0,0432 | 20,83 días | 23,15 días |
| 1 | lluvia | 0,0672 | 13,39 días | 14,88 días |
| 1,5 | seco | 0,0288 | 31,25 días | 34,72 días |
| 1,5 | lluvia | 0,0448 | 20,09 días | 22,32 días |

La edad calendario `(world.tick-builtAt)/2400` no es el denominador físico: falta un contador durable de ticks activos por estructura/región. La comparación de dos respaldos tampoco identifica cuánto tiempo estuvo activa entre ellos. `Chunk.lastTick` marca retiro; al reactivar no hay cálculo de `world.tick-lastTick` para estructuras (`src/world/spatial.ts:131–142,185`).

## A2. Qué cuenta como uso

| Objeto / función | Cuenta | No cuenta / límite |
|---|---|---|
| Estructura, `observeUse` | beneficio>0; structure.uses+1; blueprint.uses+1; usefulness se suaviza con coeficiente0,04 | No es persona/día, ocupación ni duración; 2400 ticks de descanso pueden generar muchos usos. `src/world/inventions.ts:365–369` |
| `takeFood` | comida extraída del granero por miembro real, acción eat, hambre>0; beneficio amount×10 | Depósito, excedente o producción no cuentan; cantidad0 no cuenta. Radio1,5. `src/world/inventions.ts:379–390` |
| `takeWater` | extracción positiva de cisterna, miembro real con acción drink/objetivo≤0,5/sed>0; beneficio amount×15 | Agua ambiental se debita primero y no acredita cisterna; lluvia/riego no cuentan. `src/world/inventions.ts:399–415` |
| `recordFacilityRest` | mejoría real de fatiga/energía superior al exterior, margen>1e−12, radio0,5 | Estar bajo techo, descansar sin mejoría extra, cuerpo saturado, visitas o protección demográfica no cuentan. `src/world/inventions.ts:431–449` |
| Plano arquitectónico | suma de los anteriores sobre sus construcciones | Construirlo no acredita uso; utilidad solo cambia con uso positivo, sin olvido temporal. `src/world/inventions.ts:351–369` |
| Receta material | `useTool` debita masa y acredita uses+1 inmediatamente, aun benefit0; `recordTechnologyBenefit` añade utilidad positiva una vez | Fabricación no equivale a uso: manufactured+1; consumir como sustrato no incrementa uses. `src/world/technology.ts:230–240,272–296,518–535` |
| Recipiente portátil | beber acredita uses+1, utilidad=alivio de sed; recibo kind water, action drink | Llenar/cargar/fugar no acredita utilidad; la bebida no desgasta la masa seca en esa función. `src/world/technology-water.ts:274–297`; `src/world/material-affordances.ts:121–124` |
| Lugar, gatherings | compartir 0,025 comida a otro a distancia≤2 en un lugar apto incrementa gatherings | No es un contador general de visitas o población residente. `src/world/index.ts:950–967` |

Beneficios indirectos sin contador específico de usos: riego y cosecha posterior, protección climática demográfica, oportunidad local percibida de una instalación. Un jardín puede contribuir a alimento real y seguir en `uses=0` si nadie bebe/come del edificio o obtiene descanso incremental. `stepStructures` no emite recibos de irrigación por edificio (`src/world/inventions.ts:465–485`).

## A3. Mapa de persistencia SQLite y campos

**12 tablas de aplicación en esquema5:** snapshots, events, inputs, sessions, metadata, chunks, legacy, technology_definitions, technology_stats, technology_executions, technology_origin, snapshot_parts. La auditoría no lee cuerpos de inputs/sessions ni material de autenticación. Fuentes: `src/server/store.ts:120–125,310–320`; `src/server/technology-archive.ts:298–309`; `src/server/snapshot-parts.ts:84`.

| Tabla | Columnas / clave | Datos relevantes para A |
|---|---|---|
| snapshots | slot PK; body,digest,saved_at | slots0/1/2: actual, guardado previo, profundo cada100 guardados. `saved_at` es Date.now(), tiempo de servidor; `world.tick` da edad de simulación. JSON directo o manifest `snapshot-parts-v1` con `world`. `src/server/store.ts:30–35,1272–1280`; `src/server/snapshot-parts.ts:31–32,175–189` |
| snapshot_parts | digest PK; body | páginas de4096 teselas, usadas cuando hay>32768 teselas activas; **no páginas de estructuras/personas**. El manifest.world lleva esos metadatos. `src/server/snapshot-parts.ts:12–13,91–98` |
| chunks | PK(key,tick); body,digest | región retirada: key,cx,cy,lastTick,tiles,places,animals,structures. Lectura vigente: mayor tick≤tick del snapshot, no sumar todas las versiones. `src/world/terrain.ts:11–21`; `src/server/store.ts:594–604` |
| events | id PK; tick,body | construcción, reparación, invento, descubrimiento y compartir; sin recibo para cada descanso/bebida/uso de estructura. Archivo puede podarse. `src/server/store.ts:719–757` |
| technology_definitions | id PK; tick,signature UNIQUE,body,digest | definición inmutable, programa/inputs/steps, parents,generation,inventorId,tick,x,y,novelty,capacities,lawsVersion; excluye uses/utility/manufactured. `src/server/store.ts:127–129`; `src/shared/technology.ts:41–45`; `src/shared/technology-archive.ts:5–9` |
| technology_stats | PK(recipeId,tick); body,digest | estadísticas acumulativas uses/utility/manufactured. Elegir última≤horizonte; no sumar filas históricas. `src/server/store.ts:348–353`; `src/server/technology-archive.ts:124,302–303` |
| technology_executions | id PK; serial UNIQUE,tick,body,digest | kind,actorId,recipeId,inputs,outputs,residueMass,catalysts,benefit,balance; posible nestedExecutionIds y water. 7 kinds. `src/shared/technology.ts:67–79`; `src/server/technology-archive.ts:128–131,304–305` |
| technology_origin | id=1 PK; body,digest | startsAfter: seriales previos no reclamados como preservados. `src/shared/technology-archive.ts:10–11`; `src/server/technology-archive.ts:306–307` |
| metadata | key PK; value | chronicle-origin-v1,chronicle-pruned-v1,technology-pruned-v1,technology-chain-v1; fronteras de origen/poda verificadas. La poda tecnologíaV2 conserva count/byKind/tick/digest, no objetos/beneficios individuales del prefijo. `src/server/store.ts:108,721,756–757,815–821` |
| legacy | id PK; tick,body,digest | identidad/genealogía de fallecidos; no un historial diario de hogares y posesiones. `src/server/store.ts:125` |

**Campos lógicos en el mundo decodificado** (para manifest, dentro de `body.world`; para instantánea inline, raíz):

- `structures[]`: id,x,y,blueprintId,name,components,condition,water,food,uses,builtAt,builderId. No lastUse, ocupantes, activeTicks, abandonedAt, ruina, inventario material recuperable. `src/shared/life.ts:16–19`.
- `blueprints[]`: id,name,components,generation,parents,inventorId,tick,uses,usefulness,cost. Son arquitectónicos, distintos de `technology.recipes`. `src/shared/life.ts:11–15`.
- `people[].home`: x,y,quality,observedAt; `people[].inventory` comida portátil; `materials.wood/stone`; `technology.items[]`,residue,knownRecipes,project,competence. `src/world/index.ts:72`; `src/shared/technology.ts:55–64`.
- `people[].technology.items[]`: id,recipeId,composition{wood,stone,water},mass,properties,generation,madeAt,parentItems,initialMass y contents opcional. `contents.water` es agua libre distinta de composition.water. 1000 quanta=1 unidad material; 50.000 quanta=1 unidad ambiental de agua. `src/shared/technology.ts:1–21`; `src/world/technology.ts:27`; `src/world/material-affordances.ts:5`.
- `technology.ledger`: imported,estateLoss,fuelMass,work,energy,attempts,failures,crafted,toolUses,shared,recycled; `catalogue.totals`; `historyDropped`; `journal.startsAfter/committedThrough`; `checkpoint`. `src/shared/technology.ts:91–125`.
- `chunks[].structures` en archivos SQLite es un estado por retiro, no un censo adicional a sumar a las mismas regiones activas. Deduplicar por id y clave; **las regiones activas del snapshot prevalecen sobre la última versión archivada de la misma clave**.
- Las teselas durable usan `tileEncoding` y tuplas; no asumir objetos x/y en snapshot. `src/server/snapshot.ts:76,100,109–111`. `retiredChunks` y `retiredLegacy` quedan vacíos en el snapshot porque los pendientes se vacían hacia sus tablas (`src/server/snapshot.ts:100`).

## A4. Ventanas y censuras

| Evidencia | Ventana / retención | Consecuencia |
|---|---|---|
| history global | 96×60=5760 ticks nominales=2,4d; ticks de primera a última muestra llenas=5700 (2,375d) | No historia de objetos. `src/world/statistics.ts:100–106` |
| technology.history | 256 ejecuciones recientes, no256ticks; historyDropped contabiliza descartes del anillo | Con población alta cubre muy poco tiempo. `src/world/technology.ts:56–59`; `src/world/technology-execution.ts:14–21` |
| Tecnología durable | journal pendiente preserva cada recibo antes del descarte residente; origen comienza en historyDropped al habilitarse | Nunca reconstruir prefijo anterior al origen. `src/world/technology-journal.ts:79–82,94–100` |
| Producción | `cadaTicks=100`, `ventanaEventosTicks=24000` (10d), salvo overrides; confirmar params reales de copia | Recibos más antiguos pueden no existir. No inferir «nunca usado» de ausencia. `src/server/deployment-params.ts:21,31–32` |
| Default histórico/laboratorio | `cadaTicks=1`, ventana0: sin poda normal | No presupone que todos los paneles usen default; leer params guardados. `src/world/params.ts:155` |
| Poda tecnológica | ventana efectiva≥2400ticks; protege3 snapshots/anillos; ≤4096filas/guardado o un tick completo si lo supera | Ventana nominal puede retener más; cobertura real requiere MIN/MAXtick, origin y frontera. `src/server/store.ts:62,69,945–977` |
| Chunk con ventana>0 | al archivar nueva versión, borra anteriores de misma clave | A menudo solo último retiro disponible; sin ventana0 se conserva historial. `src/server/store.ts:1253–1263` |
| Catálogo | 256 recetas residentes;32 instrucciones/persona por default de catálogo, hasta256; archivo conserva definiciones | Caché ausente no equivale a receta inexistente/desconocida globalmente. `src/world/technology-catalogue.ts:84,160–179`; `src/world/technology-memory.ts:98–119` |
| Proyección cliente | cámara recorta people/structures/blueprints; recipe resúmenes sin programa; capacidades redondeadas a0,001 | Evitar contar capturas UI como censo completo. `src/shared/types.ts:15–19`; `src/world/index.ts:1576`; `src/world/technology.ts:660–683` |

`technology.checkpoint` conserva apertura de stock prospectiva cuando hay cambio de padrón/hueco: no valida ni recupera el intervalo perdido (`src/world/technology-checkpoint.ts:110–124`). El metadato de poda sí sirve para contabilizar cuántas transacciones se retiraron por clase, no para atribuir uso a recetas/productos en ese prefijo.

## A5. Stocks, residuos y hogares: ciclos existentes y huecos

| Stock / estado | Entradas y salidas existentes | Desuso / límite observable |
|---|---|---|
| Materias crudas personales | cosecha1+herramienta hasta12madera/8piedra; gastos de construcción, reparar, farm, ensayo, fabricación, intercambio y herencia; remanente perdido al morir | Sin putrefacción o fuga temporal; no fecha/procedencia por unidad. `src/world/index.ts:1095–1104,1274–1289`; `src/world/inventions.ts:323,351,459`; `src/world/technology.ts:230–245` |
| Comida portátil | ≤0,25; entrada cosecha/forraje; comer, granero, compartir, reproducción(0,08 de cada progenitor), herencia/muerte | Sin tasa de putrefacción propia. `src/world/index.ts:1023–1032,1106–1110,1279–1287,1352`; `src/world/inventions.ts:487–490` |
| Alimento/agua edificio | caps0,7/0,6 por módulo; captación/deposito; beber/comer/riego | Sin spoil/evaporación ni fuga al romperse; dormancia congela. `src/world/inventions.ts:50–55,375–415,466–490` |
| Productos tecnológicos | fabricación incrementa manufactured; consumo como sustrato; desgaste de herramienta; traslados; reciclaje al superar16objetos y patrimonio | Sin corrosión/desgaste de calendario. Masa/integridad reducen capacidades; no indicador de «nunca usado» por producto. `src/world/technology.ts:106–115,230–240,265–284,450–456,514–521,615–657` |
| Residuos tecnológicos | desgaste/proceso/reciclaje añaden; receta y combustible pueden consumirlos; patrimonio transfiere o pierde | No edad ni origen: 3 acumuladores por persona. localInputs ofrece residuo≥150quanta; tope por propuesta1000. No degradación ambiental. `src/world/technology.ts:198,217–218,241,268,307–311,454,501,631–651` |
| Combustible gastado | `fuelMass` acumulativo fuera de residuo reciclable | Sumidero contable no ceniza material reutilizable. Comentario habla de residuo inerte, pero implementación lo separa en ledger. `src/world/technology.ts:242–245` |
| Agua portátil | llenado, bebida, fuga, derrame, transferencia, esfuerzo de transporte; fuga depende porosidad/cohesión/integridad | Fuga real en descanso; no implica pérdida de masa seca del recipiente. Capacidad=8×masa sólida×contención×cohesión×(1−porosidad); coeficiente máximo1000/1.000.000 por tick, calculado en fijo. `src/world/material-affordances.ts:18–20,107–118`; `src/world/technology-water.ts:219–232` |
| Madera/piedra ambiental | extracción debita casilla; madera rebrota cada100ticks si growth>0,65,fertilidad>0,4,humedad>0,35,traffic<0,35 y luz; cap2/6/12 según planta | Piedra no tiene reposición en kernel; stock dormido se conserva. `src/world/ecosystem.ts:170–179`; `src/world/ecosystem-kernel.ts:158–165` |
| Cultivo/sendero | cultivate +0,18, traffic pisada +0,025; decaimientos pasivos0,00002/0,0005 por revisión10ticks | Sí desaparecen gradualmente en regiones activas; dormancia congela. Desde1, sin refuerzo: cultivo≈208,33d activos, traffic≈8,33d activos. `src/world/ecosystem.ts:183–198`; `src/world/ecosystem-kernel.ts:145–146` |
| Hogar de persona | se adopta lugar percibido quality>0,4; sustituye si mejora>0,12; elimina si observación local≤7 da quality<0,12 | Distante, confianza decae linealmente a0 en2400ticks; calidad efectiva<0,2 deja de motivar retorno pero **no elimina home distante**. Sin abandonedAt/ocupantes. `src/world/society.ts:233–269` |
| Lugar | obra crea settlement-x-y y mantiene nombre/description/gatherings; retiro archiva | No borra por quedar vacío; no estado de abandono/desmantelamiento; 3 lugares ancla permanecen en world.places dormidos. `src/world/inventions.ts:354–357`; `src/world/spatial.ts:200–212` |
| Definiciones y estadística | planos/recetas creados conservados; uses/manufactured/utility no negativos acumulativos; usefulness arquitectónica EMA0,04 | Sin olvido/obsolescencia en definición global. Memoria personal olvida por presión LRU al aprender, no cronómetro de desuso. `src/world/technology-catalogue.ts:272–307`; `src/world/technology-memory.ts:95–119`; `src/world/inventions.ts:334,369` |

## A6. Medidas que son posibles y nombres honestos

- **«Cero usos directos registrados desde construcción/identificación»**: `uses==0`; separar `builderId!=null` de `structure-legacy-*` con builderIdnull. Las legacy nacen ya como scenery/refugios a condición1/usos0/builtAt=identificación, de modo que no se conoce la fecha física original ni usos previos (`src/world/terrain.ts:24–29`).
- **«Sin incremento observado en intervalo»**: objeto presente con mismo id en dos copias y Δuses=0; ventana=[ticks de copias]. Una sola copia solo muestra acumulativo y condición actual.
- **«Baja exposición o dormancia»**: separado de «abandono». Chunk retirado tiene0 referentes de vecindario activo; no demuestra decisión social de abandonar ni hogares sin dueños. Calcular número de personas/home por coordenada y distancia, con umbral de ventana explícito, sería proxy propuesto.
- **«Recetas sin aplicación mecánica/bebida acumulada»**: último technology_stats.uses=0; también medir manufactured>0 y consumo como insumo `recipe:<id>` en research/craft. Esas recetas pueden haber sido consumidas como sustratos o producir funciones indirectas.
- **«Sin consumo en recibos retenidos»** para stock/residuo: delimitar MIN/MAXtick y frontera/origen. Ausencia de consumo en una ventana no demuestra nunca; stocks agregados no conservan lotes/edad. Para producto individual, no todos los recibos de uso llevan itemId: `useTool` registra entrada agregada `recipe:<id>`, aunque los catalysts de research/craft sí conservan itemId (`src/world/technology.ts:247,282,488–489`).
- **Uso por estructura/día** no es recuperable retrospectivamente con granularidad diaria si faltan snapshots diarios o si solo hay contadores acumulados; no inventar reparto uniforme. Las copias horarias de servidor son intervalos de tiempo real, no necesariamente un día simulado.
- **Edad y condición a lo largo del tiempo** requieren varias copias o versiones de retiro con id estable, sin doble contaje. No tratar modificación del universo activo como nuevas construcciones o muertes físicas.
- **No llamado «stock eterno observado»** por una sola medición. El código permite stocks sin decaimiento; para probar acumulación real hace falta serie de saldos/entradas/salidas. Reportar «stock actual con salidas no observadas en X días» cuando la cobertura lo permita.

## A7. Prioridad para integrar con las mediciones empíricas

1. Separar estructuras activas/archivadas/originarias y normalizar desgaste por exposición, no solo por edad calendario. Si se conserva condición en dormancia es comportamiento implementado, no un fallo de contador.
2. Informar vida completa de objeto: exposición→deterioro→reparación/rotura→ruina/reutilización. Faltan los dos últimos eventos explícitos; la casilla rota sigue shelter y bloquea obra.
3. Distinguir contadores de uso útiles, mecánicos, alimentadores de cadena e indirectos. `uses=0` no puede rotularse «nunca usado» sin calificación.
4. Medir stocks sin pérdidas naturales por clase y ventana; destacar reservorios rotos inaccesibles, comida almacenada y productos secos. No usar residuo agregado para atribuir edad por lote.
5. No evaluar dinámica actual con `settlementCount`, definitions totals o functionalDiversity históricos crecientes. Comparar tasas/ocupación/beneficios actuales y la fracción de definiciones que mantiene alguna aplicación/consumidor en la ventana.

No se proponen aquí cambios de reglas aplicados ni thresholds de aceptación: el integrador cruza este mapa con GOAL/constitución/criterios y los respaldos. Verificación proporcional realizada: búsqueda de mutaciones/llamadas, lectura de cuerpos de funciones, derivación aritmética y comprobación de HEAD; 0 tests de simulación y 0 builds porque la entrega es documentación de solo lectura.
