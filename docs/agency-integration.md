# Agency integration: enchufar `ai-agency` al mundo que corre

**Problema (Diagnóstico 24 mayo, A-1):** `@carta/ai-agency` modelaba agencia
deliberativa (drives, memoria, voz LLM) pero NUNCA se invocaba en producción.
La causa era un *impedance mismatch* sin adaptador:

| `@carta/microagents` (lo que corre) | `@carta/ai-agency` (lo modelado) |
|---|---|
| `MicroAgent { x, y, energy: number, alive }` | `Agent { drives: Drive[], affect, memory }` |
| posiciones de grid, vecindario físico | `Perception { partnerPresent, distance, attentive }` |

Nadie había escrito el puente. Este documento describe el puente — vive en
`packages/ai-agency/src/integration/` — y cómo `services/realtime` lo instancia.

## Regla de desacople

`ai-agency` **NO importa** de `@carta/microagents` (evita acoplar el paquete
hoja al motor físico y un ciclo). El adaptador declara la rebanada estructural
mínima que lee:

```ts
interface MicroAgentLike {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly energy: number;     // [0, maxEnergy]
  readonly alive: boolean;
  readonly bondTicks?: number;  // historial de contacto (founders)
}
```

Cualquier `MicroAgent` real es asignable a esto.

## Capa 1 — Adaptador (funciones puras)

```ts
// MicroAgent + vecindario → Perception (mide presencia respecto al ancla, Isa)
perceiveFromMicroAgent(
  self: MicroAgentLike,
  neighbors: ReadonlyArray<MicroAgentLike>,
  tick: number,
  options?: PerceiveOptions,
): Perception

// MicroAgent → Agent (energy → drive energía; bondTicks → seed de bond;
//                     id → personalidad de la constelación)
agentFromMicroAgent(self: MicroAgentLike, options?: AgentFromMicroOptions): Agent

// refresca SOLO la energía del cuerpo sin perder memoria ni pisar bond
syncEnergy(agent: Agent, self: MicroAgentLike, maxEnergy?: number): Agent
```

- **Presencia:** el ancla (Isa, `"i"`; para Isa, Steven `"s"`) cuenta como
  presente si está viva y dentro de `presenceRadius` celdas (Chebyshev, default
  12). `attentive` si está dentro de `attentiveRadius` (default 2). Si el ancla
  no está en el vecindario o está lejos → `partnerPresent: false` — exactamente
  la señal del Pilar 1: sin acoplamiento, el bond decae.
- **Bond como drive regulado, no contador hardcodeado:** `syncEnergy` proyecta
  energía cada tick PERO no toca bond. Bond lo regula `updateBondFromPerception`
  dentro de `decide()`. Eso convierte "mueren juntos por un `if`" en "el cuerpo
  dejó de poder regularse sin el otro" (recomendación #1 del diagnóstico).

## Capa 2 — Façade de voz (lo que llama realtime)

```ts
const voice = createConstellationVoice({
  llm,          // LLMClient | null  (null → NullVoice permanente)
  store,        // VectorStore | null (loadRagStore del index.json real)
  embedQuery,   // (q) => Promise<number[]>  seam de embeddings local
  cooldownMs,   // default 4000
  // ... onInvoked, onFailedUtterance, sequenceMode, constellationOnly, logger
});

// API que realtime consume (NO toca internals):
voice.maybeSpeak(microAgent, ctx): Promise<Utterance | null>
voice.setQuiet(quiet: boolean): void
voice.enabled: boolean
```

`Utterance = { entityId, text, recipient? }` — `text` ya pasó el validador de
glosario de voz; `entityId` ya viene relleno.

`SpeakContext = { tick, neighbors, agent? }` — pasa `agent` (uno persistente,
construido una vez con `agentFromMicroAgent` y enhebrado tick a tick) para
continuidad de memoria episódica/semántica; omítelo para una voz sin memoria.

### Qué resuelve el façade que el loop NO toca

- **Cooldown / backpressure / gating** (swing afectivo, cruce de proximidad,
  backstop de silencio) → delegado a `LLMPolicy.maybeRequestUtterance`.
- **Single-flight por agente** → mapa interno de promesas pendientes. El loop
  no guarda estado de promesas.
- **RAG del corpus REAL** → `store` + `embedQuery` se inyectan al `LLMPolicy`
  (vía la opción nueva `ragEmbedQuery`), así cada prompt de diálogo se tiñe con
  fragmentos reales de los chats de Steven/Isa. La voz suena a ELLOS.
- **Temperatura** → modulada por affect dentro de la política (interocepción →
  softmax), ya integrado.

### Manejo de fallos (Pilar 1 + regla #4): siempre degrada a silencio

- LLM inalcanzable / timeout / OOM → la promesa de `maybeRequestUtterance`
  resuelve `null` (el `LLMPolicy` envuelve todo fallo).
- `llm: null` (sin servicio de inferencia) → `NullVoice`: `maybeSpeak` siempre
  resuelve `null`. La simulación corre igual, las entidades callan.
- Cualquier throw síncrono en el façade → atrapado, logueado, retorna `null`.
- El cuerpo sigue decidiendo vía utility policy. La voz es color, nunca control.

## Cómo lo instancia `services/realtime` (bootstrap)

`ai-agency` **no** se cablea al loop a sí mismo (eso lo hace realtime). El
bootstrap hace:

```ts
import {
  createConstellationVoice,
  loadRagStore,
  isConstellationMember,
  agentFromMicroAgent,
  syncEnergy,
} from "@carta/ai-agency";

// 1) cargar el índice real (1.896 ventanas); degrada a vacío si no existe
const store = await loadRagStore("data/processed/embeddings/index.json");

// 2) construir el embedder local (e5 query) como EmbedQuery
const embedQuery = async (q: string) => embedClient.embed(q);

// 3) construir el façade UNA vez
const voice = createConstellationVoice({
  llm: llmEnabled ? new LLMClient({ url: LLM_URL }) : null,
  store,
  embedQuery,
});

// 4) construir/persistir un Agent por miembro de la constelación al bootstrap
const agents = new Map<string, Agent>();
for (const m of world.agents.filter((a) => isConstellationMember(a.id))) {
  agents.set(m.id, agentFromMicroAgent(m, { seed: String(SEED) }));
}

// 5) en el loop (después de stepAgents), por cada miembro de la constelación:
for (const m of constellationMembers) {
  let agent = agents.get(m.id)!;
  agent = syncEnergy(agent, m);            // refresca el cuerpo
  const { agent: next } = decide(agent, perceiveFromMicroAgent(m, neighbors, tick), dtMs);
  agents.set(m.id, next);                  // bond/memoria/affect evolucionan aquí
  const u = await voice.maybeSpeak(m, { tick, neighbors, agent: next });
  if (u) emitEntityUttered(u.entityId, u.text, u.recipient);  // → bus de eventos
}

// 6) sin observadores conectados: voice.setQuiet(true)
```

`decide()` es opcional para la voz (el façade construye un agente efímero si no
pasas `ctx.agent`), pero enhebrarlo es lo que materializa el Pilar 1: bond como
drive homeostático que regula la decisión, y death-by-disconnection como salida
del rango viable en vez de un contador externo.

## Tests

- `tests/integration/microagent-adapter.test.ts` — presencia/distancia/
  attentive, flip del ancla, mapeo energy/bond, determinismo, `syncEnergy` no
  pisa bond.
- `tests/integration/constellation-voice.test.ts` — NullVoice cuando `llm:null`,
  gating de constelación, happy path (habla tras gating), inyección RAG del
  corpus real al prompt, degradación a silencio en fallo (5xx/throw, nunca
  rechaza), quiet mode, continuidad de agente enhebrado.
