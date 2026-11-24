# Leyes sin topes (decisiones 7, 8 y 9)

Base leída: `AtlasParaIsa-anexo/worktrees/v24-base` (849a895). Todas las rutas son relativas a ese árbol.

## 1) Idea central

1. Ningún número decide cuántos nacen, cuántos caben o cuántos se juntan: lo decide **lo que un cuerpo puede pagar** en masa y energía conservadas, y **lo que el suelo produce**.
2. Nacer cuesta: la gestación pasa materia del cuerpo gestante al embrión. Criar cuesta: la cría come de lo que otros le dan. La capacidad de carga sale de la producción primaria, no de un umbral.
3. Una comunidad es una etiqueta que se propaga por una red de confianza que **se gasta** si no se mantiene. El coste de mantenerla limita el tamaño del grupo.
4. La fauna es un solo tipo de cuerpo con genes continuos. La caza, el miedo, la habituación y el ordeño salen de leyes que valen para todo cuerpo, sin lista de especies.
5. Lo que se carga lo limita el peso y el volumen. Lo que se sabe lo limita el olvido por desuso. Las únicas cotas que quedan son la RAM, la anticorrupción y la percepción.

## 2) Modelo de datos (contratos a congelar)

Dependo de la pieza «átomos» solo a través de este adaptador. Las etapas 1 a 4 lo implementan sobre los escalares de hoy (`inventory`, `energy`, `hunger`); cuando lleguen los átomos, solo se cambia la implementación.

```ts
// src/world/balance.ts (nuevo; único punto de contacto con la pieza «átomos»)
export interface Balance {
  masa(c: CuerpoRef): number;            // kg de cuerpo (estructura + reserva)
  reserva(c: CuerpoRef): number;         // kg movilizables sin dañar estructura
  masaAdulta(c: CuerpoRef): number;      // objetivo genético de masa
  volumen(c: CuerpoRef): number;         // L
  transferir(de: CuerpoRef | CeldaRef, a: CuerpoRef | CeldaRef, kg: number): number; // conserva; devuelve lo movido
  produccionPrimaria(celda: CeldaRef): number;   // kg/tick que fija la vegetación
}
export type CuerpoRef = { tipo: 'persona' | 'animal' | 'embrion'; id: string };
```

**Personas** (`src/shared/types.ts`, `Person` en `src/world/index.ts`):

```ts
interface Gestacion { otroProgenitor: string; inicio: number; masa: number; genoma: Genome; politica?: Policy }
// Person += gestacion?: Gestacion; cuidadores?: string[] (ids, solo mientras masa < 0,9·masaAdulta)
// Genome: GENE_COUNT 7 → 8; alelos 14-15 = «escucha». traits.escucha ∈ [0,1].
// bonds: Record<string, number> → Record<string, { v: number; t: number }>  (t = último contacto)
```

**Fauna**: SoA en `Float32Array`, una columna por campo y un índice por ranura. Columnas: x, y, masa, reserva, hambre, sed, energía, salud, edad, miedo, habituación, presa (Int32); genes: velocidad, percepción, metabolismo, carnivoría, eficienciaAgua, camuflaje, acuático, cautela, tamaño, pelaje, defensa. Son 23 campos × 4 B = 92 B por animal, legibles tal cual por un kernel GPU. `species` pasa a llamarse `linajeFundador`: solo lo leen la proyección y el cliente.

**Campo de alarma por celda** (`Float32Array` paralelo al SoA de terreno, `src/world/soa/terreno.ts`): una muerte violenta en la celda lo sube y decae solo. Reemplaza `alarmHerd`.

**Memoria técnica** (`technology-memory.ts`): `knownRecipes: string[]` → `{ id: string; fuerza: number; ultimoUso: number }[]`.

## 3) Leyes y algoritmos

### a) Natalidad: gestación y crianza pagadas

```
fértil(p) = rol mortal ∧ edad ∈ [madurez, vejez) ∧ masa(p) ≥ 0,9·masaAdulta(p)
          ∧ sin gestación ∧ tick − lastBirth ≥ fertilityCooldown (gen, demography.ts:55)
          ∧ reserva(p) ≥ COSTE_GESTACION(p)          // «el cuerpo sabe si puede pagar»
COSTE_GESTACION(p) = m0(p) / η ;  m0 = 0,05·masaAdulta ;  η = 0,5 (lo demás es calor)

concepción (cada tick, en paralelo por persona): p fértil busca entre vecinos a ≤ 1,5 celdas
  q fértil, vínculo mutuo ≥ 0,3, ¬closeKin; elige por pairAffinity (family.ts:22).
  Gestante = el de mayor reserva. Se crea Gestacion{masa: 0, genoma: inheritGenome(...)}.
gestación (cada tick):
  dm = min(reserva(g) − basal(g)·horizonte, m0 / T_min)     // T_min = 0,5 días
  si dm ≤ 0 durante 1 día seguido → aborto: transferir(embrión → g, masa)  // nada se pierde
  si no: transferir(g → embrión, dm/η); embrión.masa += dm
  si embrión.masa ≥ m0 → nace con esa masa exacta y cuidadores = [g, otro]
crianza: la eficiencia de forrajeo de la cría es masa/masaAdulta; su ingesta máxima ∝ masa^0,75.
  Los cuidadores ya tienen la acción `share` (family.ts); su prioridad sube con `care` y parentesco.
```

**Por qué no explota.** Cada nacimiento retira m0/η de un cuerpo, y ese cuerpo solo repone lo que come. El flujo de nacimientos está acotado por Σ ingesta ≤ Σ producción primaria accesible. La tasa máxima por pareja es 1/(T_min + cooldown) ≈ 1 cada 1,3–1,8 días. Cuando el suelo se agota, la reserva baja antes que la salud y la fertilidad se apaga antes de que haya hambre: es un regulador del propio cuerpo. El equilibrio es K ≈ P_accesible·η_digestión / basal.

**Por qué no se extingue.** No hay umbral externo: cuando hay menos gente, la competencia baja, las reservas suben y la fertilidad vuelve. El aborto devuelve la masa. El riesgo que queda es el efecto Allee (pocos y dispersos). Lo mitigan `radioCortejo` (que ya existe, `params.ts:229`) y S e I inmortales.

**Experimento N1.** 4 semillas × 3 réplicas (la réplica cambia hilos y GPU, así que el resultado no es determinista) × 15 días, contra v24-base con las mismas semillas y réplicas.
- Métricas: mortales N(t); nacimientos, abortos y muertes juveniles por día; reserva media de fértiles; producción primaria terrestre P(t); ingesta/P; error de masa por día.
- Falla si:
  - (i) hay ≥ 2 de 12 réplicas con N = 0 antes del día 15;
  - (ii) el error de masa relativo supera 1e‑6 por día;
  - (iii) N > 3·K_estimado durante más de 2 días;
  - (iv) hay caídas de más del 80 % en 2 días en ≥ 3 réplicas;
  - (v) la mediana de N en el día 15 es menor que 0,5× la mediana de v24-base (prueba de Mann‑Whitney, p < 0,05).

### b) Comunidades: propagación de etiquetas por una red que cuesta

```
peso(i,j) = min(v_ij, v_ji) + 0,5·parentesco(i,j) + recursos_compartidos_ij(ventana 1 día, normalizado)
decaimiento: v_ij ← 0,2 + (v_ij − 0,2)·exp(−(tick − t_ij)/τ)   (al leer; τ = 2 días)
coste de coordinación: cada interacción social (convivir, share, cooperate) ocupa el tick y gasta energía;
  mantener k vínculos fuertes cuesta ≈ k·(τ⁻¹) interacciones por día → k_máx emerge del tiempo.
propagación (cada tick, por persona, en paralelo sobre la foto del tick anterior):
  L* = argmax_L Σ_{j vecino ≤ RADIUS, label_j = L} peso(i,j)
  si Σ(L*) > Σ(label_i) → label_i = L*        // empate = se queda (histéresis sin constante)
  si i no tiene etiqueta y ≥ 2 vecinos sin etiqueta con peso mutuo > 0 → etiqueta nueva compartida
comunidad = etiqueta con ≥ 3 mortales (es la definición de «comunidad», no un tope)
fisión: ocurre sola cuando la red se corta; fusión: cuando el peso entre grupos supera el de dentro.
```

**Por qué no explota.** Con vínculos que decaen y un tiempo social finito, el grado fuerte por persona queda acotado. Una etiqueta no se propaga más allá de donde llegan las aristas, así que no aparece una comunidad gigante en una población dispersa.

**Por qué no se extingue.** Convivir sigue creando vínculos (`society.ts:115`) y tres personas cercanas con confianza vuelven a fundar una comunidad.

**Experimento C1.** El mismo panel, 15 días.
- Métricas: número de comunidades; tamaños (mediana, p90 y máximo); fracción de mortales con comunidad; cambios de etiqueta por persona y día; grado fuerte (v > 0,5) por persona; fracción del tiempo en actos sociales.
- Falla si:
  - el tamaño máximo supera el 60 % de N mientras la dispersión espacial es mayor que 2·RADIUS;
  - hay más de 2 cambios de etiqueta por persona y día (oscilación);
  - pasan más de 2 días sin ninguna comunidad con ≥ 20 personas a menos de RADIUS;
  - el grado fuerte mediano crece sin meseta (> 150 en el día 15).

### c) Fauna: densidad por huella y decisión cada tick

- **Huella** = masa^(2/3)·k_forma. Un movimiento o un nacimiento solo cabe si Σ huellas de la celda ≤ área de la celda. Sustituye a `MAX_ANIMALS_PER_TILE`.
- **Cría**: la reserva reproductiva de V19/R (`animals.ts:743-748`, `:838`) pasa a ser obligatoria y a escalar con el tamaño (crías de masa 0,1·masa del progenitor). Se borran la capacidad «3 × teselas con growth > 0,04» y los umbrales de celda 0,012 y 0,08.
- **Decisión**: todos los vivos deciden en cada tick. `choose` debe ser una función pura de (columnas del animal, vista local 13×13, campo de alarma, capa de presencia de personas). Va al pool de 28 hilos o a la GPU, que es otra pieza; aquí solo se congela el contrato.
- **Movimiento paralelo**: en una pasada cada animal propone una celda. En la segunda, por celda, se aceptan propuestas hasta llenar el área. El orden lo da `Math.random` en CPU o `atomicAdd` en GPU, porque ya no hace falta determinismo.
- **Muerte por edad**: `LIFESPAN` por especie → L = L0·masa^0,25 (alometría). L0 se ajusta para que las plantillas fundadoras reproduzcan las edades de hoy.

**Por qué no explota.** Los herbívoros comen `growth`, que es finito y regenera a la tasa ecológica. Los carnívoros comen herbívoros. La huella acota la densidad física.

**Por qué no se extingue.** La cría exige reserva, no un umbral del suelo. Si hay pocos animales sobra pasto y la reserva se llena antes.

**Experimento F1.** El mismo panel, 15 días.
- Métricas: biomasa de herbívoros (carnivoría < 0,5) y de carnívoros; stock vegetal; ocupación máxima de huella por celda; decisiones por tick / vivos (debe dar 1); ms de la fase de fauna frente al número de hilos.
- Falla si:
  - la biomasa herbívora llega a 0 en alguna réplica;
  - la ocupación de alguna celda supera 1 (error);
  - los carnívoros se extinguen en 12 de 12 réplicas;
  - la fase de fauna pasa de 30 ms/tick con 100 000 animales y 28 hilos (prueba sintética).

### d) Química y objetos por persona: cuerpo, olvido y RAM

- **Carga**: Σ masa de lotes químicos, objetos (`technology.items`), materiales y comida ≤ 0,4·masa(p), y Σ volumen ≤ 0,3·volumen(p). Lo que no cabe se **deja en la celda** como montón visible: la materia se conserva y otro la puede recoger. Esto sustituye a 6 compuestos, 16 objetos, 4.000 de masa por insumo y el tope de comida 0,25.
- **Insumos por paso**: los que quepan en la carga o en el almacén de la estructura donde se trabaja. Desaparece `maxInputs` = 4.
- **Pasos por receta**: sin tope. El coste es de memoria (abajo).
- **Olvido**: `fuerza ← fuerza·exp(−Δt/τ_m)`. τ_m es heredable: 1 + 4·learningRate días, porque el gen ya existe. Usar o enseñar una receta pone la fuerza a 1. Por debajo de 0,05 se olvida; es limpieza numérica. El tamaño de lo que se recuerda emerge como tasa de uso × τ_m. Desaparecen 32 recetas, `maxRecipes` 256 y `maxGeneration` 32.
- **Registro de fórmulas**: sin tope. Una fórmula sin lotes vivos, sin recetas que la usen y con `uses` viejo se recoge como basura al persistir. Desaparece la fusión «a la más cercana» (`chemistry.ts:174-186`), que inventaba química falsa.
- **Cota global**: la admisión por RAM de `hardware-limits.ts`.

**Experimento Q1** (tras la pieza «átomos»). Panel de 15 días.
- Métricas: masa cargada/masa corporal (p99 ≤ 0,4); montones en el suelo; recetas recordadas por persona en el tiempo; tamaño del registro y su RAM.
- Falla si:
  - alguien supera su carga (error);
  - la mediana de recetas por persona no alcanza meseta (> 1.000 en el día 15);
  - el registro pasa de 1 GB.

### e) Caza y ganadería desde leyes generales

Cuatro leyes que valen para todo cuerpo, sea persona o animal:

1. **Miedo**: `miedo = cautela·(1 − habituación)·amenaza`, con `amenaza = Σ_agentes(masa_agente/masa_propia)·cercanía + alarma(celda)`. Un animal huye si `miedo > reserva/masa`: el hambriento arriesga más. Las personas entran en la capa de presencia solo como masa, igual que un depredador.
2. **Habituación**: si hay un agente más grande cerca y la alarma de la celda es ≈ 0, `h += α(1−h)`, con α = 0,01·(1 − cautela). Si la alarma sube, `h −= h·alarma`. Sin contacto decae lentamente.
3. **Energía y forma**: perseguir o huir cuesta masa·distancia·metabolismo. Cada tick de contacto el ataque hace daño = (masa_a·arma_a)/(masa_p·(1+defensa_p)), donde «arma» es la de la persona (dureza·tenacidad·filo de su objeto) o la carnivoría del animal. La presa escapa si su velocidad es mayor. Se elige a quién atacar por **rendimiento esperado** = masa_presa·asimilación − coste de persecución − riesgo (defensa·masa_presa/masa_propia). Desaparecen `edible`, la tabla de presas y el «trabajo 4/45».
4. **Extracción no letal**: cualquier agente junto a otro que no huye puede sacarle reserva (comida) o pelaje (fibra) a la tasa de trabajo de su cuerpo. Cada extracción sube el miedo de la víctima en proporción a Δmasa/masa_víctima. La víctima tolera mientras `miedo < reserva/masa`. El pelaje vuelve a crecer comiendo, con un objetivo de masa que fija el gen `pelaje`.

**Qué sale de ahí sin escribirlo.**
- **Caza**: la persona elige matar cuando la masa de la presa compensa la persecución.
- **Ganadería**: un animal habituado no huye, así que ordeñarlo rinde de forma sostenida. La decisión de la persona compara «matar ahora» (masa) con «extraer» (tasa × vida esperada), descontando por el hambre que tenga. Además, cerca de las aldeas hay fuego y gente (el campo de alarma sube cuando hay depredación), lo que aleja a los carnívoros. La supervivencia de los animales de baja cautela es mayor allí, y la cautela media cerca de las aldeas baja por selección: eso es domesticación.

**Experimento H1.** Panel de 30 días, porque la selección necesita generaciones.
- Métricas: cazas y extracciones por día; habituación y cautela medias a < 10 celdas de una estructura frente a > 30; fracción de la dieta humana de origen animal.
- Falla si:
  - la diferencia de cautela cerca/lejos no es significativa (Mann‑Whitney, p < 0,05) en ≥ 3 de 4 semillas;
  - la fauna a < 10 celdas de todas las aldeas queda en 0 en el día 10 en ≥ 6 de 12 réplicas;
  - la dieta animal supera el 90 %.
- Aparte, una prueba estática con `grep` debe dar 0 lecturas de `.species`/`linajeFundador` en `src/world` fuera de la proyección.

### f) Mensajes divinos según el carácter

- **Gen**: `escucha` es el locus 8 (`genetics.ts:4`, GENE_COUNT = 8). Los fundadores lo sacan con varianza de `0,2 + random·0,6`. Se hereda por `inheritGenome` sin cambiar código, porque el bucle ya recorre GENE_COUNT. Se expresa en `traits.escucha` (`genetics.ts:49-51`). La validación pasa a esperar 16 alelos (`genetics.ts:67`).
- **Oír**: probabilidad por tick `escucha²·calma·audibilidad`, con `calma = (1−hambre)(1−sed)(1−fatiga)` y `audibilidad = 1/(1 + (d/RADIUS)²)` para los mensajes regionales. La latencia sale de ahí: E[latencia] ∝ 1/escucha². Sustituye a las constantes 0,035/0,055/0,045 de `whispers.ts:168-172`, a la espera mínima de 20 ticks (`:142-143`) y a los umbrales de calma (`:165`).
- **Cumplir**: un mensaje oído entra en la decisión de la persona como candidato con puntuación `escucha·(1 − presión de necesidad)`. Cada tick puede abandonarlo con riesgo `(1 − escucha)·0,001` y dejar el evento «lo olvidó».
- **Herencia observable**: si obedecer ayuda o perjudica a sobrevivir, `escucha` evoluciona. El observador se convierte así en una presión selectiva.

**Experimento W1.** Un guion de laboratorio inyecta 1 mensaje por comunidad y día en un sitio al azar; 4 × 3 × 15 días.
- Falla si:
  - la correlación de Spearman entre escucha y latencia no es negativa (p < 0,05);
  - la pendiente de la regresión padre medio → hijo cae fuera de [0,6; 1,1].

### g) Otros topes que quedan

| Constante (ruta:línea) | Clase | Destino |
|---|---|---|
| `POPULATION_HARD_LIMIT` 1e6, `poblacion.maxima` (`params.ts:228`) | anticorrupción | pasa a derivarse de la RAM (`hardware-limits.ts`); no actúa en la ley |
| `src/server/governor.ts:79-110` (`techo`, `apagar`), `app.ts:447-470` `gobernar` | **ficticio**: frena la natalidad por el p95 en tiempo de reloj | **borrar**; contradice la decisión 1. `reproductionEnabled` queda solo como pausa manual |
| `MAX_STRUCTURES` 512, `MAX_BLUEPRINTS` 64 (`inventions.ts:20-21`), `OPEN_WORLD_MAX_BLUEPRINTS` 4096 (`params.ts:341`), `openWorldCaps` (`params.ts:345-348`) | ficticio | borrar; las estructuras se limitan por materiales y RAM |
| `storedCompounds < 12` (`inventions.ts:238`) | ficticio | volumen del almacén |
| `FAMILY_RESERVE_TARGET` 0,12 (`family.ts:8`), tope de comida 0,25 (`index.ts:514,953,1357,1836,1997`) | ficticio | carga corporal (d) |
| `limites.comunidades`, `limites.fauna` (`hardware-limits.ts:93`) | admisión | solo RAM; la fauna deja de calcularse como teselas×6 |
| `MAX_ACTIVE_WHISPERS` 16, `MAX_RETAINED_WHISPERS` 32, `WHISPER_LIFETIME_TICKS` (`whispers.ts:10-13`) | límite de entrada del observador | razonable; se mueve al servidor |
| `RADIUS` 7 (`index.ts:74`), `RADIO_PERCEPCION`, `MOVE_RADIO_CHEBYSHEV` 24, `MAX_RADIUS` 6 de fauna, `RADIO_PAREJA` 12 | percepción y cognición | se quedan |
| `MAX_EXPERIENCES` 8, `MAX_HABITS` 3, `MAX_ANIMAL_MEMORY` 12, `MEMORY_TTL` 480, `PLAZO_ACUERDO` 300 | cognición | se quedan |
| `MAX_EVENTS` 120, `VIEW_EVENTS`, `RECENT_LEGACY_COUNT`, `PROJECTED_FORMULAS`, `maxHistory` 256, `TOTALS_CAP` | vista y registro | se quedan |
| `MAX_COORDINATE`, límites de SoA y rejilla, `MOVE_MAX_EXTRACCIONES` 2048 | ingeniería y anticorrupción | se quedan |
| `ecologia-constantes.ts` (tasas), `RESERVA_*`, `MATURITY` 600 | física y biología | pasan a la pieza «átomos»; `MATURITY` → masa ≥ 0,9·adulta |
| `world.tick % 120` en `updateCommunities` (`society.ts:814`), `intervaloComprobacionTicks` | cadencia ficticia | todo cada tick |
| `ELECCION_POR_AFINIDAD` (`index.ts:2295`) | código muerto | borrar |

## 4) Qué se borra y qué se conserva

**Se borra:**
- `natalidad-local.ts` entero (224 líneas). `effectiveCommunityCap` (:119-122) cae con las comunidades.
- `index.ts:2293-2413` (`reproduce` y `fertile`) se reescribe en `src/world/natalidad.ts`, de unas 150 líneas.
- `params.ts:43-51,228-230,377-384`: `nacimientosPorComprobacion`, `intervaloComprobacionTicks`, `natalidadVecindad`, `radioVecindadNatalidad`, `radioLugar`, `exigeComunidad`, `comprobacionContinua`. Se conservan `radioPareja` (1,5) y `cortejo`/`radioCortejo`.
- `demography.ts:91-93`: los umbrales de hambre, energía y fatiga para ser elegible pasan a ser de reserva. Se conservan salud y edad.
- `society.ts`:
  - `:612-621` (`trustedNeighbor` con 6/0,25/0,3 y `trustedMajority`);
  - `:642-676`;
  - `:694-810` (`reviseByCohabitation` con 48/64/96/40/32/2,5/360 y `disolverPorEscasezDeMortales`);
  - de `:813-895`, la salida por distancia cultural 0,3 (`:831-843`), la fundación (`:866-893`) y el `% 120`.
  - `params.social`: `maxComunidades`, `radioConvivencia`, `disolucion`, `confianzaSalida`, `distanciaAlternativa`.
- `animals.ts`:
  - `:16,17,23` (`MAX_ACTIVE_ANIMALS`, `MAX_ANIMALS_PER_TILE`, `MAX_ANIMAL_DECISIONS_PER_TICK`);
  - `:53` `LIFESPAN`;
  - `:124` `isHerdAnimal`;
  - `:135-165` `settlementOverlay`, que se integra en `choose`;
  - `:471-476` `edible`;
  - `:785-795` `faunaCapacity`;
  - `:807,812-813,821-822`;
  - `:978-992` (ventana rotatoria);
  - `:1041-1045` (cadencia de 8 ticks, 1.024 decisiones y el umbral de 384);
  - `:1063-1064` (abono «de rebaño»: todo animal excreta, y eso es de la pieza «átomos»);
  - `:1071` (defensa por hash);
  - `:1114-1119` `alarmHerd`.
  - Además se borra toda la maquinaria de orden canónico y certificado (`:856-996`, unas 140 líneas), que solo servía al determinismo.
- `index.ts`:
  - `:1074,1099-1120` (`herdPlan`);
  - `:1122` (caza solo si `inventory < 0.18`);
  - `:1924-1926` (`HUNT_ORGANIC`, `TEND_ORGANIC` y `huntable`);
  - `:1929-1941` (`huntWorkDuration`, con 7 constantes);
  - `:1945-2004` (`canTend` con 0,45/0,35/480/120/2, `tendingAnimal`, `organicLot` con su fusión forzada y `tendNearbyAnimal` con 6 trabajos y fórmulas de rendimiento);
  - el bloque `quimica.emergente` de `:2063-2069`.
  - Todo lo que queda de caza se reescribe en `src/world/caza.ts`, de unas 180 líneas: búsqueda de presa, persecución, daño y extracción.
- `chemistry.ts:41-47,174-186,492,532-540,878,953`.
- `technology.ts:97`: se quedan `maxHistory` y `maxMassPerInput` → carga.
- `technology.ts:536,647-654,849,911` (`maxItems`), `technology-catalogue.ts:85`, `technology-memory.ts:111-117`.
- `whispers.ts:141-172`.
- `governor.ts` entero (374 líneas) y `gobernar` en `app.ts`.

**Se conserva de v23 (3b7d73f):**
- la morfología heredable (`animals.ts:106-123`), donde `MORPH_BASE` pasa a ser solo plantilla de fundación;
- la pérdida de calor por pelaje (`:1025-1032`);
- `habituation` y `lastHunted`, que pasa a ser la alarma;
- la biomasa según el tamaño, que pasa a ser la masa;
- la persecución por `huntingPreyId` (`index.ts:1785`, `:1907`);
- la proyección (+40) y la validación (+14).

De sus 305 líneas de pruebas sobreviven las de herencia de la morfología. Las que fijan umbrales se borran.

## 5) Migración por etapas

Cada etapa deja el mundo andando y se mide con su experimento. La propiedad de ficheros es disjunta dentro de cada ola.

| Etapa | Ficheros (dueño único) | Medida |
|---|---|---|
| **L0** Adaptador | `src/world/balance.ts` (nuevo, implementación escalar), tipos `Gestacion`/`bonds{v,t}` en `src/shared/types.ts` | typecheck; una prueba que conserva Σ masa en `transferir` |
| **L1** Natalidad *(ola 1)* | `src/world/natalidad.ts` (nuevo), `natalidad-local.ts` (borrar), `index.ts:2293-2413` (solo esa zona), `demography.ts:91-93`, `family.ts:50-57`, `params.ts` (poblacion) | N1 |
| **L2** Gobernador y topes de servidor *(ola 1)* | `src/server/governor.ts`, `app.ts:436-470`, `resumen-vivo.ts:79`, `hardware-limits.ts`, `inventions.ts:20-21`, `params.ts:341-348` | N1 sin gobernador; que el servidor arranque y aguante 1 h de humo |
| **L3** Comunidades *(ola 1)* | `society.ts:73-110,592-895`, `lineage.ts:226-250` (podar `bonds` por decaimiento), `params.ts` (social) | C1 |
| **L4** Fauna: huella y decisión total *(ola 1)* | `animals.ts`, `paralelo/fauna-motor.ts`, `paralelo/fauna-worker.ts`, `ecosystem.ts:10` (FOOD_PER_ANIMAL → masa) | F1 |
| **L5** Escucha *(ola 1, tras el cierre del equipo de mensajes)* | `genetics.ts`, `whispers.ts`, panel de persona en el cliente | W1 |
| **L6** Caza y ganadería *(ola 2, tras L4)* | `src/world/caza.ts` (nuevo), `index.ts:1074-1122,1780-1830,1900-2070` | H1 |
| **L7** Carga y memoria *(ola 3, tras «átomos»)* | `chemistry.ts`, `technology*.ts`, `inventions.ts:238`, `index.ts` (topes de 0,25) | Q1 |
| **L8** Panel conjunto | ninguno | 4 semillas × 3 réplicas × 30 días con todo activo; reúne los criterios de N1, C1, F1, H1 y W1 |

L1 y L6 tocan zonas distintas de `index.ts`. El orquestador integra extrayendo cada una a su fichero nuevo, y en `index.ts` solo cambian las importaciones y las llamadas.

## 6) Coste de cómputo y memoria

Los tiempos son de JS sin medir: estimaciones.

- **Natalidad**: O(N·k) por tick, con k ≈ 10 vecinos. Con N = 10 000 son unos 0,3 ms en serie, y paralelizable. Elimina el `while` O(N) por nacimiento de `natalidad-local.ts:167-182`, que era O(N·B).
- **Comunidades**: O(Σ grados) por tick. Con un grado de unos 50 por el decaimiento y N = 10 000 salen 5·10⁵ operaciones: 3–5 ms en serie, menos de 0,3 ms en 28 hilos. Los `bonds` como `{v,t}` ocupan unos 24 B por arista: con 10 000 × 50 son 12 MB. Hoy los `bonds` no decaen y solo se podan al morir: ese grafo crece sin cota.
- **Fauna**:
  - `choose` mira 169 celdas, unos 3–6 µs en JS. Con 100 000 animales cada tick (hoy deciden cada 8 ticks, así que es 8× más trabajo) salen 0,45 s en serie, unos 20 ms en 28 hilos, y menos de 1 ms de cómputo en GPU más el traslado de 9,2 MB del SoA. Con SoA residente se mueven solo los deltas.
  - Memoria: 92 B por animal, 92 MB por millón.
  - Con la escala del público de hoy (decenas a cientos de personas y miles de animales), la fauna cuesta menos de 2 ms por tick.
- **Memoria técnica**: unas 50–200 recetas por persona en equilibrio × 24 B, despreciable.
- **Escala**: todo lo de arriba es lineal en N y en animales. La población queda acotada por la producción primaria, que es proporcional al área activa. El coste por tick crece con el área explorada, y con él cae la velocidad en ticks por segundo. Esa caída es aceptable según la decisión 1.

## 7) Invariantes y pruebas que sustituyen a la paridad

1. **Conservación**: Σ masa de cuerpos, embriones, suelo, montones y objetos es constante con error relativo ≤ 1e‑9 por tick, salvo el flujo declarado de la fotosíntesis y la respiración, que define la pieza «átomos». Se comprueba en cada tick del laboratorio y cada 2.400 en producción.
2. **Huella**: ninguna celda supera su área.
3. **Carga**: nadie supera 0,4·masa ni 0,3·volumen.
4. **Unidades**: todo en rango y finito (validación al cargar).
5. **Sin topes ni listas**: una prueba `grep` falla si reaparecen `nacimientosPorComprobacion`, `MAX_ANIMALS_PER_TILE`, `MAX_PERSON_COMPOUNDS`, `isHerdAnimal`, `maxComunidades` o una lectura de `.species` en `src/world`.
6. **Pruebas unitarias por ley** con RNG inyectable, solo en las pruebas: un aborto devuelve la masa; una persona sin reserva no concibe; la propagación de etiquetas parte un grafo cortado y fusiona uno unido; una presa más rápida escapa; un animal habituado tolera la extracción y uno asustado huye.
7. **Pruebas estadísticas** (N1, C1, F1, H1, W1, Q1) en vez de digestos: cada una con réplicas, prueba de hipótesis y criterio de fallo, ejecutadas por `npm run lab`.

## 8) Cómo se ve en pantalla

- **Gestación**: un píxel de vientre sobre la gestante y una barra de embrión en la ficha. Eventos «abortó por falta de reserva» y «nació con 3,1 kg». Las crías dibujan una línea tenue hacia sus cuidadores mientras dependen de ellos.
- **Capacidad de carga**: capa «producción vs. consumo» por región y una gráfica de nacimientos, abortos y muertes juveniles por día.
- **Comunidades**:
  - al seleccionar a una persona se dibujan sus aristas de confianza, con el grosor según el peso y el color según la etiqueta;
  - fisión y fusión salen como eventos con causa («se cortó la red entre X e Y»);
  - el panel muestra el histograma de tamaños.
- **Fauna**: el sprite escala con la masa y el color sale del linaje fundador con tinte por genes; capa de densidad de biomasa.
- **Caza**:
  - una línea de persecución entre cazador y presa;
  - destello de miedo en el animal y halo para los habituados;
  - eventos «ordeñó» y «esquiló» con los kg extraídos;
  - gráfica de cautela media cerca y lejos de las aldeas, donde la domesticación se ve como dos curvas que se separan.
- **Carga**: barra de peso en la ficha; montones de objetos en el suelo como píxeles apilados.
- **Escucha**:
  - barra en la ficha, junto a la de sus padres;
  - ondas cuando alguien oye un mensaje, que se apagan si lo abandona;
  - serie de la escucha media por generación.

## 9) Riesgos y mitigaciones

1. **Ciclos de exceso y colapso** en personas y fauna, porque ya no hay cupo que los amortigüe. Mitigación: la fertilidad depende de la reserva y responde antes que el hambre. Si N1 muestra caídas de más del 80 %, se sube η o T_min, que son constantes biológicas, no topes.
2. **Efecto Allee y extinción con poblaciones dispersas.** Mitigación: `radioCortejo`, S e I inmortales y un aborto que no destruye masa.
3. **El decaimiento de vínculos reduce los pares con vínculo ≥ 0,3** y frena la natalidad. Mitigación: L1 y L3 se miden juntas en L8, y τ se calibra con `vinculoConvivencia`.
4. **Depredación entre parecidos** (lobo contra lobo) al quitar `edible`. Mitigación: el riesgo de la ley 3 lo vuelve poco rentable entre iguales. Si F1 muestra canibalismo dominante, se añade el reconocimiento de parentesco, que ya existe por `parents`.
5. **Sobrecaza alrededor de las aldeas** antes de que aparezca la habituación. Mitigación: el campo de alarma aleja la fauna, y la puntuación de extracción no letal compite con la de matar.
6. **Dependencia de la pieza «átomos».** Mitigación: el adaptador `Balance` con implementación escalar permite entregar L1–L6 antes que ella.
7. **La GPU de fauna sin paridad** puede tapar errores. Mitigación: los invariantes 1–3 se comprueban en cada tick del laboratorio tanto en CPU como en GPU.
8. **Choque con el equipo de mensajes divinos en `whispers.ts`.** Mitigación: L5 empieza cuando ellos integren. Hasta entonces solo se toca `genetics.ts`.

## 10) Consecuencias y decisiones para el orquestador

- **El gobernador `techo` es un regulador de natalidad** que mira el tiempo de reloj. La decisión 1 obliga a borrarlo. Sin él, la población solo se frena por el suelo y, en último caso, por la RAM. El motor irá más lento en ticks por segundo a medida que crezca, y la cinta lo grabará igual.
- **Las constantes biológicas** (η = 0,5, m0 = 5 % de la masa adulta, T_min = 0,5 días, carga 0,4·masa, τ de vínculos = 2 días, alometrías) **no son topes, pero sí son números**. Steven debería saber que el mundo seguirá teniendo «física» elegida a mano. La propuesta es declararlas en un único fichero de constantes de la naturaleza.
- **Las especies dejan de existir para las reglas.** Seis plantillas fundan el mundo y después solo hay genes continuos. Pueden aparecer omnívoros intermedios o que desaparezcan los carnívoros: eso es emergencia, pero puede verse como «se perdieron los lobos».
- **Con escucha heredable, los mensajes del observador se vuelven selección.** Si obedecer mata (por ejemplo, mensajes que mandan a la gente a lugares secos), la escucha se extinguirá. Es coherente con «no coercitivo», pero Steven debe saberlo.
- **Sin determinismo, una regresión solo se ve con réplicas.** Cada experimento pide como mínimo 12 corridas (4 × 3), y el panel corto de 4 × 30 se vuelve 12 corridas de 30 días.
- **El orquestador tiene que decidir:**
  - (a) si la pieza «átomos» llega antes que L1, para saltarse la implementación escalar del adaptador;
  - (b) quién es dueño de `index.ts` en la integración;
  - (c) si `reproductionEnabled` sobrevive como pausa manual del operador;
  - (d) si las plantillas fundadoras de fauna se quedan en 6 o se generan al azar.
