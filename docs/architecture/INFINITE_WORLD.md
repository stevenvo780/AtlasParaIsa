# Arquitectura — Mundo Infinito (contratos para el rediseño)

> Decisión del autor (2026-05-24): el mundo debe crecer **infinitamente** hasta copar el hardware. Cómputo en backend: **worker-pool sobre los 32 cores de CPU** para la lógica de agentes (simbólica, ramificada → mala para GPU), **GPU 5070 Ti para campos data-parallel + LLM/embeddings** (ya). Isa lo abre desde el celular → el cliente **solo recibe el viewport**, nunca el mundo entero.
>
> Este documento es el **CONTRATO** que todos los agentes de implementación deben respetar para que las piezas conecten. Sin esto, el paralelismo produce costuras rotas.

---

## 1. Principios

1. **El mundo es ilimitado y disperso (chunked).** No hay grilla global fija. El espacio se divide en **chunks** de `CHUNK = 64×64` celdas, indexados por `(cx, cy)` enteros (pueden ser negativos). Solo existen en memoria los chunks **vivos**.
2. **Generación procedural por chunk, determinista por seed.** `genChunk(worldSeed, cx, cy)` es una función pura → mismo chunk siempre para un seed. Seed **aleatorio por mundo** (no el 42 fijo) para que cada mundo se sienta distinto; persistible para reproducir.
3. **El backend simula; el cliente observa una ventana.** El servidor mantiene el mundo; al cliente se le **streamean solo los chunks dentro/alrededor del viewport de su cámara** (+ un anillo de margen). Mover la cámara = suscribirse/desuscribirse a chunks.
4. **Crecer y degradar con gracia.** La población crece por reproducción sin cap fijo, hasta un **presupuesto de hardware** (RAM/CPU). Al acercarse al límite → backpressure (baja natalidad, hiberna chunks sin observadores), nunca "llenar hasta caerse".

---

## 2. Lifecycle de chunks

Estados: `HOT` (simulado cada tick) · `WARM` (simulado a baja frecuencia) · `COLD` (hibernado, solo estado serializado) · `UNGENERATED`.

- Un chunk es **HOT** si tiene observadores (cámara de algún cliente cerca) **o** contiene founders/miembros de constelación.
- Sin observadores N ticks → degrada a WARM → COLD. Reactivar al volver un observador.
- COLD se serializa a disco (`STATE_DIR/chunks/cx_cy.bin`) y se libera de RAM. Esto es lo que permite "infinito": solo lo relevante vive en RAM.

**Contrato de tipos (en `packages/sim-core` o nuevo `packages/world-core`):**
```ts
type ChunkCoord = { cx: number; cy: number }
type ChunkState = 'hot' | 'warm' | 'cold' | 'ungenerated'
interface Chunk {
  coord: ChunkCoord
  state: ChunkState
  biome: Uint8Array          // 64*64
  fields: FieldGrid          // food/water/trail locales (GPU-friendly)
  agentIds: string[]         // agentes cuyo home-cell cae en el chunk
  lastTickSimulated: number
}
genChunk(worldSeed: number, cx: number, cy: number): Chunk   // pura, determinista
```

---

## 3. Worker-pool (32 cores) — contrato

- Un **pool** de `N = cores-2` workers (Node `worker_threads`). El hilo principal del realtime **orquesta**, no simula.
- **Partición espacial**: cada worker posee un conjunto de chunks HOT (sharding por región para minimizar cruces de borde). Los agentes que cruzan borde de chunk se **migran** al worker dueño del chunk destino entre ticks (cola de migración).
- **Determinismo**: cada worker usa RNG sembrado por `(worldSeed, cx, cy, tick)`. El resultado de un tick global es la unión de los sub-ticks (orden de merge estable).
- **Protocolo worker ↔ orquestador** (mensajes estructurados, transferible con `SharedArrayBuffer` donde se pueda para campos):
```ts
// → worker
{ type: 'simChunks', chunks: ChunkCoord[], tick: number, crossBorderAgents: AgentMigration[] }
// ← worker
{ type: 'chunkResult', tick, perChunk: { coord, agentDeltas, fieldDelta, births, deaths, emigrants }[] }
```
- **GPU para campos**: la difusión de campos (`field-engine`) de los chunks HOT puede batch-procesarse en GPU (WebGPU/CUDA vía services/inference o un compute kernel). Contrato: `diffuseFieldsBatch(chunkFields[]) → chunkFields[]`. Empezar en CPU SIMD; mover a GPU como optimización detrás de la misma firma.

---

## 4. Streaming al cliente (viewport) — contrato WS

El cliente **NO** recibe todo. Mensajes:
```ts
// cliente → servidor
{ type: 'viewport', center: {x,y}, radiusChunks: number }   // al mover cámara
// servidor → cliente
{ type: 'chunkLoad', coord, biome, staticData }              // chunk entra al viewport
{ type: 'chunkUnload', coord }                               // chunk sale del viewport
{ type: 'delta', tick, agents: WireAgent[] /* solo de chunks suscritos */, fields, constellation, utterances }
```
- `WireAgent` y `constellation` (ya existen) se filtran a los chunks suscritos.
- La **constelación (Isa/Steven/terceros) siempre se streamea** aunque salga del viewport (es el corazón; el cliente puede mostrar un indicador "Isa está lejos →").
- Límite duro de agentes enviados por delta (p.ej. 1500) con priorización: constelación > cercanos a cámara > resto.

---

## 5. Reproducción / población (lo que el autor no veía)

- **Quitar el cap fijo de 400.** Población crece por reproducción hasta el presupuesto de hardware (medido por RAM de chunks HOT + carga de workers).
- **Nacimiento visible**: emitir `birthEvent` al wire; el cliente lo pinta (destello suave + el hijo aparece junto al padre). Linaje (`genealogy`) consultable.
- Arrancar con **población baja por chunk** (p.ej. 8–15) para que se vea CRECER, no saturado desde el inicio.

---

## 6. Mapeo del código actual

| Hoy | Infinito |
|-----|----------|
| Grilla fija 128² en `world.ts` | Mapa de chunks 64² dinámico (`world-core`) |
| `stepAgents` sobre todos los agentes | `stepChunk` por worker sobre agentes del chunk + migración de bordes |
| `biome.ts` (ya por noise+seed) | `genChunk` por coordenada (reusa noise; seed global aleatorio) |
| `field-engine` grilla única | campos por chunk; batch difusión (CPU→GPU) |
| Snapshot/delta de todo el mundo | delta filtrado por viewport + chunkLoad/Unload |
| `founders.ts` + `constellation.ts` | igual, pero la constelación fuerza sus chunks a HOT y siempre se streamea |
| seed=42 fijo | `worldSeed` aleatorio por arranque, persistido |

---

## 7. Fases de implementación (para la ola paralela, contra estos contratos)

- **F1 — `world-core` (chunks + genChunk + lifecycle)**: nuevo paquete puro, tipos del §2, determinista. Dueño: sim-engineer.
- **F2 — worker-pool + migración de bordes** en realtime: orquestador + `worker_threads`, protocolo §3. Dueño: backend-realtime.
- **F3 — streaming por viewport** (servidor + client.ts): protocolo §4. Dueño: backend-realtime + frontend (client).
- **F4 — render de chunks + viewport infinito** en WorldCanvas: cargar/descargar chunks, cámara sin límites. Dueño: frontend art/render.
- **F5 — población creciente + nacimiento visible + seed aleatorio**: reproduction sin cap, birthEvent al wire, viz. Dueño: sim + realtime + frontend.
- **F6 — GPU para campos** (optimización detrás de `diffuseFieldsBatch`). Dueño: gpu-infra.

**Regla de oro**: nadie cambia las FIRMAS de §2/§3/§4 sin avisar — son el contrato que hace que las piezas conecten.

---

*Contrato definido por el orquestador antes de paralelizar, para no repetir las costuras desconectadas de la Ola 4.*
