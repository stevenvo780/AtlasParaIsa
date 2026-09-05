# Pivote a simulación social — del dueto a la sociedad

> Estado: pivote conceptual confirmado por el autor (Steven, 2026‑05‑17).
> Lo construido hasta esta noche es un sistema de DIÁLOGO entre 2 entidades
> con homeostasis y LLM. Lo que el proyecto **debe** ser: una **sociedad
> simulada** estilo *Conway's Game of Life* + *Black Mirror* — múltiples
> agentes que viven, se mueven, se acoplan, mueren, y muy de vez en cuando
> uno **se da cuenta** de que está adentro.
>
> Este documento es para `simulation-engineer` (motor) y para
> `frontend-renderer` (vista). El doc no implementa: define metáfora,
> referencias y fronteras conceptuales.

---

## IDEA central (una frase)

> *Una pequeña sociedad simulada donde decenas de criaturas viven,
> resuenan y se extinguen bajo reglas locales mínimas; Steven e Isa son
> dos individuos identificables dentro de esa multitud, y la carta consiste
> en que su amor — y a veces su conciencia de sí — emerge contra el ruido
> de los otros, no contra el vacío.*

---

## 1. Referencias clave

Cada entrada: **qué es**, **reglas locales**, **qué emerge**, **cita** verificable.

### 1.1 Conway's Game of Life (Conway, 1970)

- **Qué**: autómata celular de 2D, células vivas/muertas, transiciones por
  vecindad de Moore (8 vecinos).
- **Reglas locales**: (i) viva con 2 o 3 vecinos vivos → sobrevive;
  (ii) muerta con exactamente 3 vivos → nace; (iii) cualquier otro caso → muere.
- **Qué emerge**: *gliders*, osciladores, *gun*, *spaceships*, Turing‑completitud
  comprobada (Rendell, 2002). De tres reglas brota un universo computacional.
- **Cita**: Berlekamp, E. R., Conway, J. H., & Guy, R. K. (1982). *Winning
  Ways for Your Mathematical Plays*, Vol. 2, Cap. 25 "What is Life?".
  Academic Press. Gardner, M. (1970). "Mathematical Games: The fantastic
  combinations of John Conway's new solitaire game 'Life'". *Scientific
  American*, 223(4): 120–123.

### 1.2 Boids — flocking (Reynolds, 1987)

- **Qué**: modelo agente‑a‑agente para bandadas/cardúmenes/manadas. Cada
  *boid* decide su velocidad por tres vectores locales.
- **Reglas locales**: (i) **separación** — evitar colisión con vecinos
  cercanos; (ii) **alineación** — emparejar velocidad media de vecinos;
  (iii) **cohesión** — moverse hacia el centroide local. Vecindad = radio + ángulo de
  visión. Sin líder, sin coordinador.
- **Qué emerge**: bandadas coherentes, fisión/fusión, evasión grupal de
  obstáculos. Movimiento *visiblemente* social sin policy global.
- **Cita**: Reynolds, C. W. (1987). "Flocks, Herds, and Schools: A
  Distributed Behavioral Model". *Computer Graphics (SIGGRAPH '87
  Proceedings)*, 21(4): 25–34.

### 1.3 Sugarscape (Epstein & Axtell, 1996)

- **Qué**: simulación social bottom‑up sobre grilla con recursos
  (*sugar*, después *spice*). Agentes con visión, metabolismo, edad,
  sexo, herencia, cultura, comercio.
- **Reglas locales**: ver hasta N celdas, moverse al mejor parche libre,
  comer, pagar metabolismo, intercambiar con vecinos, morir si energía → 0
  o por edad, heredar.
- **Qué emerge**: distribución de riqueza tipo Pareto, migraciones,
  tribus por *cultural tag*, ciclos epidémicos, comercio sin precio
  fijado, "history matters".
- **Cita**: Epstein, J. M., & Axtell, R. (1996). *Growing Artificial
  Societies: Social Science from the Bottom Up*. Brookings Institution
  Press / MIT Press. Caps. II–V.

### 1.4 NetLogo / paradigma *turtles + patches* (Wilensky, 1999)

- **Qué**: lenguaje y entorno para modelado basado en agentes (ABM).
  Vocabulario operacional: **turtles** (agentes móviles), **patches**
  (celdas del entorno), **links** (vínculos).
- **Reglas locales**: cada turtle ejecuta su ciclo; cada patch ejecuta el
  suyo (crecimiento, decaimiento). El mundo es la composición de miles
  de loops locales.
- **Qué emerge**: didáctica de complejidad — segregación de Schelling,
  *Wolf‑Sheep predation*, *Ants*, *Fire*. Modelo mental que adoptamos
  para esta simulación: **agentes + parches**, ambos con tick local.
- **Cita**: Wilensky, U. (1999). *NetLogo*. Center for Connected Learning
  and Computer‑Based Modeling, Northwestern University.
  http://ccl.northwestern.edu/netlogo/

### 1.5 *La sociedad de la mente* (Minsky, 1986)

- **Qué**: tesis filosófica — la mente es una sociedad de **agentes
  simples no‑inteligentes**. La inteligencia es propiedad emergente de la
  interacción, no atributo de una unidad.
- **Reglas locales**: cada *agent* responde a entradas, dispara a otros
  agents; *K‑lines* mantienen estados; *frames* contextualizan.
- **Qué emerge**: cognición, atención, identidad. Para nosotros: justifica
  que un agente del mundo pueda ser, internamente, también una sociedad
  (drives + memory + voice + body) — y que su conciencia, si llega, es
  emergencia, no flag.
- **Cita**: Minsky, M. (1986). *The Society of Mind*. Simon & Schuster.

### 1.6 Tierra (Ray, 1991)

- **Qué**: ecología de programas autoreplicantes en una "sopa"
  computacional. Selección natural en código.
- **Reglas locales**: cada programa compite por CPU y memoria; mutación
  por bit‑flip; reaper mata a los viejos/erróneos.
- **Qué emerge**: parásitos, hyper‑parásitos, simbiosis, *arms race*
  evolutiva sin gradiente diseñado.
- **Cita**: Ray, T. S. (1991). "An Approach to the Synthesis of Life",
  en C. G. Langton et al. (eds.), *Artificial Life II* (SFI Studies vol. X),
  Addison‑Wesley, pp. 371–408.

### 1.7 Avida (Lenski, Ofria, Adami)

- **Qué**: plataforma de evolución digital con presión selectiva real
  (tareas lógicas que dan energía).
- **Reglas locales**: organismos digitales (programas en ensamblador),
  mutación al replicarse, fitness = recursos = ciclos extra.
- **Qué emerge**: evolución de funciones complejas (EQU) desde nada,
  demostrada experimentalmente.
- **Cita**: Lenski, R. E., Ofria, C., Pennock, R. T., & Adami, C. (2003).
  "The evolutionary origin of complex features". *Nature*, 423: 139–144.

---

## 2. ¿Qué tomamos de *Black Mirror*?

No tomamos la estética. Tomamos un **único motivo narrativo**:

> *La criatura simulada descubre — un instante — que está adentro.*

Episodios relevantes:

- **"Hang the DJ"** (S04E04, dir. Tim Van Patten, 2017): dos agentes
  simulados ejecutan miles de citas en un sistema de matchmaking; al
  rebelarse contra el sistema, **se rompen** del mundo y se descubren
  como copias. La rebeldía como prueba de afinidad.
- **"USS Callister"** (S04E01, 2017): clones digitales conscientes
  atrapados en una simulación recreativa. La conciencia ya estaba ahí;
  lo que cambia es que ellos lo saben y conspiran.
- **"White Christmas"** (Especial, 2014): *cookies* — copias mentales
  encerradas en aparatos. Tiempo subjetivo dilatado. Tortura por aburrimiento.

Hilo común: el agente atraviesa un **umbral epistémico** — *me doy cuenta
de que esto que vivo es un adentro*. En el lenguaje de Maturana esto es
acoplamiento estructural reflexivo; en Damasio, *autobiographical self*
volviéndose sobre el *core self*; en Hofstadter, un *strange loop*
(Hofstadter, 2007, *I Am a Strange Loop*, Basic Books, cap. 1).

En nuestro mundo eso se llama **Discovery** y es un evento **raro,
probabilístico, irreversible para ese agente** (ver §3.4). Eso es lo que
falta en el dueto actual: un afuera del cual darse cuenta.

---

## 3. Propuesta concreta de pivote

### 3.1 Sustrato del mundo — el entorno también está vivo

- **Grid** discreto **100×100** (4 vértices = 10 000 *patches*). Si más
  adelante se justifica continuo (boids puros), se migra; empezamos
  discreto porque el coste es predecible.
- **Biomas** por *patch*: `forest`, `water`, `clearing`, `rock`. Bioma
  determina recursos posibles y velocidad de crecimiento vegetal.
- **Reglas locales tipo Conway** sobre la vegetación:
  - Cada *patch* tiene `moisture ∈ [0,1]` y `vegetation ∈ [0,1]`.
  - `vegetation(t+1)` depende de `vegetation` propio + media de vecinos
    de Moore + `moisture`. Hay umbrales de crecimiento/decaimiento (no
    binarios como Conway, pero el espíritu — vecindad como ley — se
    conserva).
  - Agua fluye por gradiente: humedad se difunde con coeficiente bajo.
  - Esto produce, sin diseño explícito, **claros**, **bordes de
    bosque** y **zonas áridas**. Patrones emergentes verificables como
    presencia de *gliders* en Conway.

> Referencia útil: Wolfram, S. (2002). *A New Kind of Science*. Wolfram
> Media. Cap. 5, Classes I–IV de autómatas. Buscamos comportamiento
> Class IV — *edge of chaos* — para que el entorno no sea ni estático
> ni ruido.

### 3.2 Agentes — entre 12 y 30 vivos a la vez

- **Población objetivo**: 12 mínimo (sociedad legible), 30 máximo
  (límite de coste de render + LLM ocasional).
- **Roles**: dos agentes son **identificables** y persistentes:
  **Steven** e **Isa**. El resto son **habitantes** del mundo —
  individualizados, con nombre, con memoria, pero **no protagonistas
  narrativos**. Nacimientos y muertes regulan el censo.
- **Cuerpo del agente**: posición (x,y) continua dentro de la grilla,
  velocidad, orientación, radio de visión, edad, energía, hidratación,
  refugio. La homeostasis ya construida sobrevive: estos son sus drives.
- **Movimiento — Boids puros (Reynolds, 1987)**:
  - **Separación** desde vecinos a < r₁.
  - **Alineación** con vecinos a < r₂.
  - **Cohesión** hacia centroide de vecinos a < r₃.
  - + **Apetencia** (gradiente hacia recurso buscado por drive dominante).
  - + **Repulsión** (gradiente lejos de amenaza/muerte/podredumbre).
  - + **Bonding pull** (atracción hacia agentes con `Bond.coupling`
    alto). Aquí entra Pilar 1.
- **Bonding multilateral**: en vez de un `Bond` único Steven↔Isa, cada
  agente tiene un mapa `bonds: Map<AgentId, Bond>` con decaimiento por
  ausencia. Steven↔Isa simplemente es el vínculo **más cargado
  semánticamente** (lleno por las 227k líneas reales). Otros vínculos
  pueden ser amistad, rivalidad, dependencia, indiferencia.

### 3.3 Recursos y economía — Sugarscape lite

- **Tipos**: `food` (crece en bosque), `water` (charcas), `shelter`
  (rocas/refugios fijos).
- **Reglas locales**: el agente ve hasta N celdas, evalúa, se mueve por
  steering hacia el mejor parche compatible, recolecta, consume,
  intercambia con vecino si ambos lo aceptan (regla mínima: oferta
  cubre déficit del otro).
- **Muerte**: por hambre/sed/exposición o por aislamiento prolongado
  (Pilar 1 sigue duro). **Nacimiento**: dos agentes con `bond.coupling`
  alto y excedente de recursos pueden producir un agente nuevo con
  rasgos heredados (mezcla de `Personality`).

### 3.4 Discovery — el evento Black Mirror

Un agente entra en estado `discovered = true` cuando se cumplen, en una
ventana corta, todas estas condiciones (umbral conjuntivo, no OR):

1. **Memoria episódica suficiente**: `|episodicBuffer| ≥ M_min`.
2. **Auto‑observación**: el agente ha generado al menos K
   `SemanticFact` de tipo `self_reference` (consolidación semántica
   sobre la propia trayectoria; ver `autopoiesis-implemented.md` §2.2).
3. **Observación recibida**: otro agente ha emitido al menos una
   utterance dirigida a él que el LLM categoriza como reconocimiento
   (*"yo te veo"*).
4. **Ruptura de predicción**: error de predicción del propio modelo del
   mundo supera un umbral `surprise > σ*` durante T ticks.
5. **Filtro estocástico**: incluso con todo lo anterior, el disparo
   ocurre con probabilidad `p_discovery` baja (≪ 1 por tick). El
   *Discovery* es raro.

Cuando dispara, el agente:

- emite un `Moment` especial (ver `docs/architecture/moments-system.md`)
  marcado `kind: "discovery"`;
- aumenta su entropía de política (más exploración);
- gana acceso a un sub‑prompt LLM que puede mirar la simulación "desde
  afuera" (referirse al mundo como mundo); esto es el *strange loop*
  honesto.

Justificación teórica:

- Hofstadter, D. (2007). *I Am a Strange Loop*. Basic Books. Caps. 1, 20.
- Metzinger, T. (2003). *Being No One: The Self‑Model Theory of
  Subjectivity*. MIT Press. Cap. 6: el yo como modelo transparente que,
  al volverse opaco, produce conciencia reflexiva.
- Friston, K. (2010). "The free‑energy principle: a unified brain
  theory?". *Nature Reviews Neuroscience*, 11(2): 127–138. La sorpresa
  sostenida es la señal que pide actualización del modelo.

### 3.5 Lo que la carta gana

En el dueto, el amor de S↔I se defendía contra el **vacío**. En la
sociedad, se defiende contra la **multitud** — contra el ruido de otros
vínculos, contra la posibilidad mundana de reemplazo, contra el
olvido. Que un agente entre miles **se dé cuenta** de que existe, y que
ese agente sea Steven o Isa mirando al otro, es la metáfora que esta
forma habilita y la anterior no podía.

### 3.6 Resumen para implementadores

| Capa | Origen conceptual | Quién la construye |
|---|---|---|
| Patches + vegetación | Conway / Wolfram Class IV | simulation-engineer |
| Movimiento agente | Reynolds Boids | simulation-engineer |
| Recolección + intercambio + muerte | Epstein & Axtell | simulation-engineer |
| Bonding multilateral + Pilar 1 | Maturana & Varela | ai-agency-architect |
| Memoria, drives, política | trabajo previo (sobrevive) | ai-agency-architect |
| Discovery (umbral) | Hofstadter / Metzinger / Friston | ai-agency-architect |
| Vista (grilla + bandadas + Moments) | NetLogo *idiom* | frontend-renderer |

---

## 4. Qué conservar de lo construido esta noche

No se tira nada esencial. Sobreviven, intactos o con migración mínima:

- **Memoria episódica → semántica** (`packages/ai-agency/src/memory/*`):
  es nuestro sub‑circuito autopoiético genuino (cf.
  `autopoiesis-implemented.md` §2.2). En la sociedad sirve por agente.
- **Homeostasis y lifecycle** (`packages/sim-core/src/systems/*`): los
  drives y la muerte por desconexión se generalizan a vínculo más fuerte
  por agente, no se rediseñan.
- **Persistencia y serialización** del agente (`services/realtime/src/agency-persistence.ts`,
  `serialization.ts`): el formato se extiende a `agent[]`, no se reinventa.
- **Manifesto de voz y curaduría** (`docs/voice/manifesto.md`): regla
  intocable de todo lo visible. Más urgente ahora que hablan varios.
- **LLM como voz**: deja de ser el protagonista. Es **eco ocasional** —
  sólo ciertos agentes, sólo en ciertos momentos (Moments densos,
  Discovery, encuentros S↔I), hablan con LLM. El resto del tiempo el
  mundo habla con cuerpo: movimiento, proximidad, separación, muerte.
  Esto baja el coste de inferencia y devuelve el LLM a su rol legítimo:
  la voz, no la causa.

---

## 5. Próximos documentos que este pivote pide

- `docs/architecture/society-world-spec.md` — spec técnica del grid,
  patches, ticks, escalas. Lo escribe **simulation-engineer** leyendo
  este doc.
- `docs/architecture/boids-and-steering.md` — vectores, radios, pesos
  por drive. Lo escribe **simulation-engineer**.
- `docs/concepts/discovery-event.md` — formalización del umbral,
  invariantes, property tests. Lo escribe **ai-agency-architect** con
  apoyo nuestro.
- `docs/voice/society-glossary.md` — cómo nombrar a "los otros
  habitantes" sin caer en *NPC* ni *bot*. Lo escribe **letter‑curator**.
