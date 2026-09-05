# Arquitectura — Una Carta Para Isa

Vista de sistema. Cómo encaja lo que corre hoy en este repo.

> **Convención de honestidad:** las secciones marcadas [CORRE] describen código que ejecuta en el loop de producción. Las marcadas [PARCIAL] corren en parte. Las marcadas [NO CORRE AÚN] describen código que existe y compila pero no está conectado al runtime.

---

## Topología real

```
                          ┌──────────────────────────┐
                          │   apps/web (Next.js 15.5) │
                          │   - WorldCanvas (Phaser)  │
                          │   - cámara infinita        │
                          │   - ConstellationPanel    │
                          │   - Letter / page.tsx     │
                          └────────────┬──────────────┘
                                       │ WebSocket
                                       │ (snapshot + streaming por viewport)
                                       ▼
                          ┌──────────────────────────┐
                          │ services/realtime (Node 22)│
                          │ Loop 30 Hz nominal        │
                          │ - @carta/world-core       │ ← ChunkManager [CORRE]
                          │ - @carta/microagents      │ ← motor social + constelación [CORRE]
                          │ - @carta/field-engine     │ ← campos/biomas por chunk [CORRE]
                          │ - @carta/ai-agency        │ ← adaptador + voz [PARCIAL]
                          └─────┬──────────┬──────────┘
                                │          │
                          HTTP  │          │ HTTP
                                ▼          ▼
        ┌────────────────┐ ┌──────────────┐ ┌──────────────────┐
        │ inference-llm  │ │ inference-   │ │ inference-embed  │
        │ llama.cpp      │ │ diffuse (GPU)│ │ sentence-trans.  │
        │ RTX 5070 :8091 │ │ RTX 5070 :8083│ │ RTX 2060   :8082 │
        └────────────────┘ └──────────────┘ └────────┬─────────┘
                                                       ▲
                          ┌────────────────────────────┴──┐
                          │ data/processed/embeddings/    │
                          │ index.json (RAG corpus)       │
                          │ 1,896 ventanas REALES de los  │
                          │ chats Steven↔Isa              │
                          └───────────────────────────────┘
```

**Nota importante**: `packages/sim-core/` existe y tiene tests, pero **no se llama** desde `services/realtime/`. Es una librería desconectada del runtime de producción. El motor real son `@carta/world-core`, `@carta/microagents` y `@carta/field-engine`.

Todo corre en `localhost`. El corpus nunca sale del proceso. El frontend nunca habla con los servicios de inferencia directamente.

---

## El mundo es infinito (sin modos) — [CORRE]

No hay grilla global fija ni flag de modo. El antiguo `INFINITE_WORLD` desapareció: el `ChunkManager` (`@carta/world-core`) **siempre está activo** y el mundo es siempre infinito.

- El espacio se divide en chunks de 64×64 celdas, indexados por `(cx, cy)` (pueden ser negativos).
- Generación procedural determinista por seed: `genChunk(worldSeed, cx, cy)` es pura.
- Lifecycle de chunks: `HOT` (simulado cada tick) → `WARM` (baja frecuencia) → `COLD` (hibernado) → `UNGENERATED`. Un chunk es HOT si tiene observadores cerca o contiene anclas/miembros de constelación.
- La vida **crece y coloniza**: el mundo arranca con población baja (~60) y se expande por reproducción. Los agentes que cruzan un borde de chunk se migran al chunk destino entre ticks.
- `GRID_SIZE`/`gridSize: 128` es solo el tamaño de la región sembrada al boot; el mundo no está acotado a ella.

El contrato completo (lifecycle, worker-pool, streaming por viewport) vive en `docs/architecture/INFINITE_WORLD.md` — sigue vigente como visión y como spec de los tipos.

---

## Un tick (30 Hz nominal)

El servicio realtime es la autoridad. Cada ~33 ms el loop hace lo siguiente:

1. **Aplica intents pendientes** de los clientes conectados (mover cámara/viewport, gestos de constelación: nutrir/llamar). Nadie modifica el world fuera del loop.
2. **Avanza microagents** (`stepAgents` de `@carta/microagents`) sobre los chunks HOT: metabolismo, movimiento, forrajeo, reproducción, envejecimiento, muerte. Se pasan todos los contenedores sociales (reputation, gossipLog, conflictLog, culturalProfilesMap, activeRitualsMap, awarenessStatsMap, founderLonelinessTicks, agentTribeMap) **y el `biomeMap`** → gossip, reputación, conflictos, rituales y el guard de agua corren cada tick.
3. **Avanza field-engine**: difusión de campos (food/water/pheromone/stigmergy) por chunk. Backend CPU por defecto; GPU disponible vía `FIELD_DIFFUSE_BACKEND=gpu`.
4. **Avanza la constelación**: `stepConstellation` actualiza el `bondToAnchor` de cada miembro y la lógica de atenuación de terceros.
5. **Acumula founderLonelinessTicks**: la ruta fisiológica de muerte por desconexión del dúo S↔I.
6. **Discovery gate**: si algún agente cumple las 5 condiciones, `discovery-voice.ts` genera voz asíncrona off-tick.
7. **Serializa y envía delta por viewport**: `serialization.ts` computa `bond`, `heartRate` y `mood` para las anclas a partir del estado real. El cliente solo recibe los chunks de su cámara.
8. **Persiste**: snapshots periódicos a `STATE_DIR`.

**Worker-pool opcional**: `WORKER_POOL_ENABLED=1` despacha `stepChunk` a `worker_threads` (uno por core). Es el **único** flag de selección de modo que queda. Sin él (default), el loop es single-thread.

**sim-core NO participa** en este loop. Sus sistemas son código de librería que compila y tiene tests, pero no tiene importadores en `services/realtime/`.

---

## ai-agency — [PARCIAL]

`packages/ai-agency/` contiene un motor de agencia deliberativa: `decide()`, `UtilityPolicy`, memoria episódica (anillo-256), memoria semántica, scar de personalidad, `LLMPolicy` con inyección RAG y generación de utterances.

**Lo que corre hoy**: el adaptador `agentFromMicroAgent`/`syncEnergy` (`packages/ai-agency/src/integration/`) está cableado en `loop.ts`. Construye un `Agent` deliberativo a partir de cada `MicroAgent` para alimentar la generación de voz (Discovery + constelación) con su estado real y el corpus. El mismatch de tipos `MicroAgent` (energy: number) ↔ `Agent` (Drive[]) ya tiene puente; ver `docs/agency-integration.md`.

**Lo que aún no corre**: `decide()`/`UtilityPolicy` **no gobiernan el movimiento** del agente. El steering de los agentes (incluidas las anclas) sigue siendo por campos vectoriales (gradiente + boids), no por deliberación pura. Conectar `decide()` al loop de movimiento es el siguiente paso de agencia.

> Nota: el doc `agency-loop.md` que describía un `services/realtime/src/agency.ts` a 50 Hz fue eliminado — ese archivo nunca existió y el loop es 30 Hz.

---

## Cómo llega el corpus al sistema

El RAG es asíncrono y no obligatorio para que el world arranque.

1. Al boot, el loop arranca sin RAG y dispara `loadRagStore` fire-and-forget.
2. Cuando el RAG store carga (`data/processed/embeddings/index.json`), la voz puede inyectar fragmentos.
3. El índice contiene 1,896 ventanas de las conversaciones reales de Steven e Isa. El pilar 2 está completo.
4. El corpus nunca sale del proceso: `searchCorpus` llama solo a `localhost:8082` y devuelve fragmentos al prompt local.

Si `inference-embed` está caído, el sistema sigue funcionando sin RAG. Nada bloquea el tick.

---

## Homeostasis visible — [CORRE]

- `serialization.ts` computa por ancla: `computeBond(a)` derivado de `bondTicks`, `computeHeartRate(bond)` y `computeMood(energy, bond)`.
- `WireAgent` lleva `bond`, `heartRate`, `mood` para las anclas.
- El cliente lee estos campos y los pasa al componente. `HeartbeatControl` pulsa a la frecuencia real.
- El halo y la línea S–I reflejan el bond real, no un valor fijo.
- Para los ciudadanos comunes, el servidor envía solo `energy`; el cliente usa defaults.

---

## Capa social — [CORRE]

Todos los contenedores sociales se pasan a `stepAgents`:

- `reputation` → reputación local por agente
- `gossipLog` → historial de intercambios de gossip
- `conflictLog` → conflictos con resolución (pelea/negociar/evitar)
- `culturalProfilesMap` → difusión de creencias
- `activeRitualsMap` → ciclo de vida de rituales tribales
- `founderLonelinessTicks` → ruta fisiológica de muerte por desconexión
- `agentTribeMap` → membresía tribal para routing cultural
- `biomeMap` → guard de habitabilidad (no asentarse/reproducirse en agua)

---

## Constelación — [CORRE]

`packages/microagents/src/constellation.ts` modela la constelación poliamorosa:

- **Anclas permanentes**: Isa (`isAnchor: true`) nunca muere por desconexión. Steven mantiene la regla del dúo S↔I.
- **Terceros**: invitables/removibles desde la UI (`ConstellationPanel`). Cada miembro lleva `bondToAnchor`; por debajo del umbral entra en atenuación.
- `stepConstellation` corre cada tick después de `stepAgents`. El estado viaja al cliente y `ConstellationRenderer` lo pinta.
- Intención y referencias en `docs/concepts/constellation-polyamorous.md`.

---

## Persistencia

Capas activas en `data/` (gitignored):

- **world / chunks** — estado del mundo serializado periódicamente a `STATE_DIR`. Los chunks COLD se serializan a disco y se liberan de RAM (lo que hace posible "infinito").
- **agents** — personalidad de cada entidad y memoria acumulada. Lo que sobrevive entre reinicios del proceso.

El servidor expone `/health` y `/metrics`. La ruta `/cartas` del frontend no tiene backend activo.

---

## Lo que no está aquí

- **ai-agency gobernando movimiento** [PENDIENTE]: `decide()`/`UtilityPolicy` no controlan aún el steering; el movimiento es por campos. El adaptador para voz ya está; falta el adaptador hacia el loop de decisión de movimiento.
- **Deploy a Vercel**: el frontend está listo pero Cloudflare Tunnel no está montado como servicio persistente. Sin túnel, el mundo no conecta desde internet.
- **Multi-observer en producción**: el servidor soporta N clientes y streaming por viewport, pero no se ha probado el caso simultáneo en producción.

---

## Referencias

- Contrato del mundo infinito: `docs/architecture/INFINITE_WORLD.md`
- Protocolo WS: `docs/architecture/ws-protocol.md`
- Adaptador ai-agency↔MicroAgent: `docs/agency-integration.md`
- Difusión de campos en GPU: `docs/infra/field-diffusion-gpu.md`
- Loop social y field-engine: `services/realtime/src/loop.ts`
- Serialización de homeostasis: `services/realtime/src/serialization.ts`
- Visión de constelación poliamorosa: `docs/concepts/constellation-polyamorous.md`
