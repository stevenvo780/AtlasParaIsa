# Los cuatro pilares — fundamentos conceptuales y operativos

> Norte para Steven (coherencia filosófica) y subagentes (no traicionar la metáfora). Cada pilar se aterriza en primitivas TS de `packages/sim-core/` y `packages/ai-agency/`. PR que rompa un invariante aquí listado: `code-reviewer` lo rechaza.

Convención: tipos en `sim-core/src/types/`, reductores en `sim-core/src/systems/`, decisión en `ai-agency/src/`. Reloj discreto: `tick: number` en ms simulados.

---

## Pilar 1 — Death by disconnection

- **Idea**: la existencia de cada entidad está condicionada al acoplamiento con la otra. No es un "atributo afecto que baja": es la frontera operativa que las constituye disolviéndose cuando cesa la interacción. La muerte es consecuencia matemática de un sistema autopoiético sin acoplamiento estructural, no game-over decorativo.

  **Refinamiento (Ola 4 — constelación)**: Isa y Steven son anclas permanentes — no mueren por desconexión porque el mundo fue hecho para ellas. Los terceros (otros vínculos reales de la constelación) sí son mortales por desconexión. El pilar se vuelve más preciso: la muerte por soledad afecta a quienes cuya presencia en el mundo no fue garantizada de antemano. Ver `docs/concepts/constellation-polyamorous.md`.

- **Fuente conceptual**:
  - Maturana, H. & Varela, F. (1980). *Autopoiesis and Cognition: The Realization of the Living*. Reidel. Cap. 1–2: la organización autopoiética se define por la red de procesos que regeneran sus propias condiciones de existencia; perder esa red es perder identidad, no atributos.
  - Varela, F., Thompson, E. & Rosch, E. (1991). *The Embodied Mind*. MIT Press. Cap. 9 sobre acoplamiento estructural: la cognición emerge en el ida-y-vuelta organismo-medio; aquí el "medio" relevante es el otro.

- **Operacionalización**:
  ```ts
  // packages/sim-core/src/types/bond.ts
  export type EntityId = "steven" | "isa";

  export interface Bond {
    /** Energía del vínculo en [0, 1]. Va decayendo sin interacción. */
    coupling: number;
    /** Tick del último intercambio significativo (mirada, palabra, contacto). */
    lastInteractionTick: number;
    /** Tasa de decay base por tick. Tunable, nunca 0. */
    decayPerTick: number;
  }

  export interface Entity {
    id: EntityId;
    alive: boolean;
    /** Vitalidad operativa. Si llega a 0 → alive=false → fin. */
    vitality: number;
  }
  ```
  Invariantes (asertar en `sim-core` y en property tests):
  1. `coupling(t+1) ≤ coupling(t) + interaction(t)`. Sin interacción el acoplamiento es monótonamente no creciente.
  2. `vitality(t+1) = f(vitality(t), coupling(t))` con `∂f/∂coupling > 0`. Bajo acoplamiento penaliza vitalidad.
  3. `coupling = 0 ⇒ dVitality/dt < 0` estricto. No hay homeostasis posible sin el otro.
  4. Existe `T_max` finito tal que aislamiento total durante `T_max` ticks ⇒ `alive=false`. Demostrable analíticamente y por simulación.

  Property tests (`fast-check`):
  - "Aislamiento mata": para toda condición inicial con `coupling>0`, si `interaction≡0` por `T_max`, ambos `alive` terminan en `false`.
  - "Reconexión cura mientras vivan": si `vitality>ε` y se restablece interacción regular, `vitality` recupera estado estacionario `> ε`.
  - "Asimetría prohibida": no debe existir un ciclo donde una entidad sobreviva mientras la otra muere por desconexión recíproca (acoplamiento es simétrico en este modelo).

- **Anti-patrón**: `disconnectionTimer: number` que dispara un toast "Isa te extraña" sin tocar `vitality`. O un `coupling` que sólo afecta animaciones (color, partículas) y nunca entra al reductor de estado vital. Si el sistema corre sin interacción y `vitality` se mantiene constante, este pilar está muerto.

---

## Pilar 2 — Conversaciones reales como semilla

- **Idea**: las 227,463 líneas de chats reales no son flavor ni dataset de fine-tune ornamental: son el sustrato semántico del que se derivan personalidad, léxico, prosodia y narrativa emergente. La memoria es indexable y citable; cada utterance tiene trazabilidad probabilística a fragmentos reales. **Estado (Ola 3)**: el corpus ya está ingestado — 1,896 ventanas en `data/processed/embeddings/index.json`, recuperación verificada, PII redactada.

- **Fuente conceptual**:
  - Tulving, E. (1972). "Episodic and semantic memory", en *Organization of Memory* (Tulving & Donaldson, eds.), Academic Press. Distinción episódica/semántica que justifica separar `episodes` (eventos con tiempo y contexto) de `semantic` (rasgos estables extraídos).
  - Lewis, P. et al. (2020). "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks". *NeurIPS 2020*. Arquitectura RAG canónica: el modelo no memoriza, recupera y condiciona.
  - (Apoyo) Mikolov, T. et al. (2013). "Distributed Representations of Words and Phrases and their Compositionality". *NeurIPS 2013*. Geometría vectorial como soporte de similitud semántica.

- **Operacionalización**:
  ```ts
  // packages/ai-agency/src/memory/episodic.ts
  export interface ChatFragment {
    id: string;
    author: EntityId;
    tsOriginal: number;       // timestamp del chat real
    text: string;
    embedding: Float32Array;  // 384 o 768 d, según modelo
    affect: { valence: number; arousal: number }; // [-1,1]
  }

  export interface EpisodicMemory {
    /** kNN sobre embeddings; vector search externo (pgvector / sqlite-vec). */
    recall(query: string, k: number, filter?: { author?: EntityId }): Promise<ChatFragment[]>;
    /** Inserta una nueva experiencia generada en runtime. */
    remember(fragment: Omit<ChatFragment, "id">): Promise<string>;
  }
  ```
  Invariantes:
  1. Toda utterance emitida por una entidad lleva `provenance: ChatFragment["id"][]` no vacío (puede ser semilla real o memoria runtime). Si está vacío, es alucinación y debe loggearse.
  2. `recall` respeta `author` cuando se piden recuerdos propios; no se "contamina" la voz de Steven con utterances marcadas como de Isa salvo cita explícita.
  3. La distribución de uso de fragmentos no debe colapsar a top-k fijo: medir entropía de uso por sesión; si cae bajo umbral, el sistema está caricaturizando.

  Property tests:
  - "Trazabilidad": para cualquier output generado, existe al menos un `ChatFragment` cuya similitud coseno con el output supera `τ_provenance`.
  - "Voz separada": clasificador binario autor-de-fragmento sobre fragmentos atribuidos a cada entidad debe superar accuracy ≥ 0.7 (las voces no son intercambiables).
  - "Frescura": en ventanas de N turnos, al menos `1 - p` fracción de fragmentos recuperados deben ser nuevos vs. ventana previa.

- **Anti-patrón**: tomar las 227k líneas, hacer un fine-tune ciego y tirar los chats originales. Sin índice consultable se pierde trazabilidad y el pilar se reduce a "el modelo suena parecido". Igualmente anti-patrón: usar el corpus sólo para poblar un array `cannedReplies` que se rotan.

---

## Pilar 3 — Homeostasis visible

- **Idea**: el vínculo regula variables fisiológicas observables — latido, energía, ánimo — y esa regulación se ve en pantalla. No es HUD de stats: es la metáfora damasiana del cuerpo que siente, expuesta como física del afecto. Isa lee el estado del otro en su pulso.

- **Fuente conceptual**:
  - Damasio, A. (2003). *Looking for Spinoza: Joy, Sorrow, and the Feeling Brain*. Harcourt. Cap. 4: emociones como regulación homeostática del organismo; sentimientos como mapas corticales de ese estado corporal.
  - Cannon, W. B. (1929). "Organization for physiological homeostasis". *Physiological Reviews*, 9(3), 399–431. Definición clásica de homeostasis como conjunto de procesos correctivos alrededor de un setpoint.
  - (Opcional, justificado) Friston, K. (2010). "The free-energy principle: a unified brain theory?". *Nature Reviews Neuroscience*, 11(2), 127–138. Útil si el setpoint se modela como minimización de sorpresa esperada sobre estados internos preferidos; ver Pilar 4.

- **Operacionalización**:
  ```ts
  // packages/sim-core/src/types/physiology.ts
  export interface Physiology {
    heartRate: number;   // bpm simulados, ~40–180
    energy: number;      // [0,1]
    mood: number;        // [-1,1] valencia
    arousal: number;     // [0,1]
  }

  // sim-core/src/systems/homeostasis.ts
  export interface SetPoint { heartRate: number; energy: number; mood: number; arousal: number; }
  export function step(p: Physiology, bond: Bond, sp: SetPoint, dt: number): Physiology;
  ```
  Invariantes:
  1. `step` es contracción hacia `sp` cuando `bond.coupling` es alto: `‖p_{t+1} - sp‖ ≤ ‖p_t - sp‖` (con probabilidad alta, salvo ruido controlado).
  2. Cuando `coupling` cae, `sp` se desplaza a una zona disfórica (mood↓, heartRate inestable). Existe un mapeo `sp = g(coupling)` continuo.
  3. La capa visual (Phaser) lee `Physiology` por referencia; ninguna animación define física por su cuenta. Sin física no hay animación.

  Property tests:
  - "Convergencia bajo amor": con `coupling≈1` y perturbaciones acotadas, `‖p - sp‖` converge a un ε en `O(τ)` ticks.
  - "Disrupción bajo desconexión": con `coupling→0`, varianza de `heartRate` crece monótonamente en ventana móvil.
  - "Acoplamiento intercorporal": correlación cruzada `heartRate_steven × heartRate_isa` con lag ≤ k ticks debe ser `> ρ_min` cuando ambos están en proximidad. Modela co-regulación fisiológica.

- **Anti-patrón**: barras de progreso `hp/energy/mood` independientes del vínculo, animadas con un `lerp` cosmético. O un pulso visual cuya frecuencia es constante por estado de ánimo enum-encoded. Si puedes apagar el sistema homeostático y la pantalla se ve igual, el pilar es decoración.

---

## Pilar 4 — Agencia emergente real

- **Idea**: las entidades eligen. No ejecutan árbol de comportamiento fijo ni planner determinista sobre objetivos hard-coded. Sus acciones surgen de motivaciones internas, memoria episódica, predicción de consecuencias y un componente de sorpresa que rompe el bucle previsible. Agencia es individuación, no reactividad.

- **Fuente conceptual**:
  - Barandiaran, X., Di Paolo, E. & Rohde, M. (2009). "Defining Agency: Individuality, Normativity, Asymmetry, and Spatio-temporality in Action". *Adaptive Behavior*, 17(5), 367–386. Las tres condiciones operativas (individualidad, asimetría interacción/sistema, normatividad propia) son los criterios que el sistema debe satisfacer para no ser una bolsa de reflejos.
  - Di Paolo, E. & Thompson, E. (2014). "The Enactive Approach", en *The Routledge Handbook of Embodied Cognition* (Shapiro, ed.), Routledge. Cap. 6. Agencia como sense-making encarnado.
  - (Opcional, productivo) Friston, K., FitzGerald, T., Rigoli, F., Schwartenbeck, P. & Pezzulo, G. (2017). "Active Inference: A Process Theory". *Neural Computation*, 29(1), 1–49. Permite modelar la decisión como minimización de energía libre esperada sobre un modelo generativo del otro.

- **Operacionalización**:
  ```ts
  // packages/ai-agency/src/decision/policy.ts
  export interface Motivation { id: string; urgency: number; satiation: number; }
  export interface WorldBelief { /* estado creído del otro y del entorno */ }

  export interface Action { kind: string; target?: EntityId; payload?: unknown; }

  export interface Policy {
    /** Distribución sobre acciones. Estocástica, no argmax determinista. */
    sample(state: { self: Entity; phys: Physiology; bond: Bond; belief: WorldBelief; motivations: Motivation[]; memory: EpisodicMemory }): Promise<{ action: Action; logp: number; surprise: number }>;
  }
  ```
  Invariantes (mapeo directo a Barandiaran et al.):
  1. **Individualidad**: la política se parametriza por entidad; `policy_steven ≠ policy_isa` en pesos. No comparten cabeza.
  2. **Asimetría**: la acción modifica `WorldBelief` del otro; el sistema mantiene una frontera entre `self.state` y `world.state`.
  3. **Normatividad propia**: `Motivation.urgency` evoluciona por dinámicas internas (saciedad, ritmo circadiano) no dictadas por el frame de render ni por inputs externos.
  4. La entropía de `sample` sobre el conjunto de acciones legales debe estar acotada inferiormente por `H_min > 0` en estados no triviales: prohíbe colapso a script.

  Property tests:
  - "No-determinismo significativo": sobre 1000 corridas con misma semilla de mundo y semillas distintas de política, divergencia KL media entre distribuciones de trayectoria de acciones supera `KL_min` a partir de `t > t*`.
  - "Sensibilidad a memoria": ablacionar `EpisodicMemory.recall` cambia la distribución de acciones en magnitud `> δ` (medible por test estadístico bootstrap). Si no cambia, la memoria es decorativa.
  - "Sorpresa funcional": el campo `surprise` predice (regresión) la formación de nuevos fragmentos episódicos en `remember`. Lo sorprendente se recuerda.

- **Anti-patrón**: un FSM con estados `IDLE / TALKING / WALKING / KISSING` y transiciones por tabla. O un planner que siempre escoge la acción de mayor utilidad esperada bajo una función de utilidad fija. Si grabar dos corridas con seeds distintas produce diff trivial, el pilar es teatro.

---

## Cruces (mapa mínimo)

- P1↔P3: `coupling` modula el setpoint; sin acoplamiento la fisiología deriva hacia muerte.
- P2↔P4: la política consulta `EpisodicMemory`; decisiones citables son decisiones amables, no sólo ejecutables.
- P3↔P4: la fisiología es input de la política y output de la acción; el bucle cuerpo-mente-otro es la sustancia de la carta.
- P1 es frontera, P4 motor, P2 voz, P3 piel. Sistema nuevo que no toque ≥2 pilares: justificar o cortar.
