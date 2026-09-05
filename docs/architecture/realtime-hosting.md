# Realtime Service — Hosting Decision

## Decision: self-hosted on the author's machine (not Vercel)

The `services/realtime/` process runs a continuous simulation loop at 30 Hz
(one ~33 ms tick, 24/7). This is the exact workload Vercel Fluid
Compute is NOT designed for.

### Why Vercel Fluid Compute is wrong for this

Vercel Fluid Compute is optimised for request-scoped, bursty HTTP functions:
the platform suspends instances between requests and bills per invocation.
A continuous simulation loop is the antithesis of that model:

| Property | Vercel Fluid Compute | This simulation |
|---|---|---|
| Execution pattern | bursty (request-triggered) | continuous (30 Hz clock) |
| Active CPU | ~0% between requests | ~100% always |
| Billing model | per-invocation + duration | would be constant duration |
| WebSocket support | limited (no long-lived state) | required |
| State durability | ephemeral between invocations | world must persist across ticks |
| GPU access | none | available on local host (RTX 5070 Ti) |

Running this loop on Vercel would mean:
- Paying for constant active CPU (the most expensive compute on the platform).
- No real WebSocket support (Vercel functions have a 5 min execution limit).
- No access to the local GPU (needed when inference integration lands).
- Simulated world state would be lost between function invocations.

### Default architecture

```
┌──────────────────────────┐         ┌─────────────────────┐
│  Vercel (frontend)       │         │  Author's machine   │
│  apps/web (Next.js)      │──WS──>  │  Docker container   │
│  Phaser 3 client         │         │  carta-realtime     │
│  Static / SSR            │         │  :8080              │
└──────────────────────────┘         │  RTX 5070 Ti avail  │
                                     └─────────────────────┘
```

The frontend is deployed to Vercel (ideal for static/SSR Next.js).
The backend runs in Docker on the author's workstation with:
- 32-core CPU, 123 GB RAM, RTX 5070 Ti (16 GB).
- ~509 GB free on `/datos` for world state snapshots and WAL.

### Public access via Cloudflare Tunnel

The author's machine is not exposed directly to the internet. Instead, a
Cloudflare Tunnel (`cloudflared`) creates a secure outbound-only connection
from the Docker network to Cloudflare's edge. The Vercel frontend connects to
the stable Cloudflare subdomain (e.g. `ws.carta-para-isa.pages.dev`).

Benefits:
- No open inbound ports on the home network.
- Free tier covers the WebSocket traffic for a single-user app.
- TLS termination handled by Cloudflare.
- If the author's machine is offline, clients see a connection error (acceptable
  for a personal project — the world is paused, not destroyed).

Alternative tunnels (if Cloudflare is unavailable):
- `ngrok` (easier setup, less stable free URL).
- `tailscale funnel` (if both machines are on the same tailnet).

### Cloud fallback

If the service must move to cloud (e.g. for high availability), the correct
migration path is:

1. Provision a VPS with GPU (Lambda Labs, Vast.ai, RunPod — NOT Vercel).
2. Migrate the Docker Compose stack (realtime + inference) to the VPS.
3. Update the Cloudflare Tunnel target to point to the VPS.
4. The Vercel frontend requires zero changes.

Do NOT migrate to Vercel Functions — the loop-based workload is architecturally
incompatible with function-as-a-service.

### Summary

| Layer | Hosting | Rationale |
|---|---|---|
| Frontend (Next.js + Phaser) | Vercel | Ideal for SSR/static; Isa accesses from mobile |
| Realtime loop v1 (Node + WS) | Self-hosted Docker | 50 Hz loop, 2 founders, sim-core |
| Realtime loop v2 (Node + WS) | Self-hosted Docker | 30 Hz loop, 100-300 agents, field-engine + microagents |
| Inference (LLM + embeddings) | Self-hosted Docker | GPU required (RTX 5070 Ti / RTX 2060) |
| Public access | Cloudflare Tunnel | No open ports; stable URL; free tier |

## Realtime — agent-scale pivot

`services/realtime/` runs a 100-300 agent world (replaces the legacy 2-entity
sim-core model that was removed during cleanup on 2026-05-18):

- Loop at **30 Hz** (reduced from 50 Hz to accommodate field-engine diffusion
  across the HOT chunks of the infinite world + full agent step).
- Imports `@carta/field-engine` (diffusion, growth, stigmergy) and
  `@carta/microagents` (gradient-following agents, founders S+I).
- **Measured performance**: avg **1.3–1.4 ms/tick** at 300 agents
  (< 5% of 33 ms budget). Room to grow before hitting the 33 ms wall.
- State persistence: binary FGRD format for field layers + JSON for agents.
  Biome map never persisted (regenerated from seed deterministically).

This hosting split is the standard JAMstack + long-running backend pattern
and is well-supported by the existing `docker/compose.yaml` configuration.

## Multi-core parallelisation (2026-05-27)

The world is **always infinite and chunk-native** — the `ChunkManager`
(`@carta/world-core`) is always active and there is no mode flag (the legacy
`INFINITE_WORLD` flag is gone). The only remaining flag distributes agent
simulation across all 32 cores via `worker_threads`.

### Activation

```bash
# Default (single-thread, ChunkManager always active):
node dist/index.js

# Multi-core pool (one worker per core, dispatches stepChunk in parallel):
WORKER_POOL_ENABLED=1 node dist/index.js

# Override worker count explicitly (auto-sized by default):
WORKER_COUNT=8 WORKER_POOL_ENABLED=1 node dist/index.js
```

### How it works

```
Main thread
  ├── Field engine (stepField, applyGrowth)  — single thread, no lock needed
  ├── WorkerPool.tick()                       — dispatches to N workers
  │     ├── Worker 0 → stepChunk(chunk A)    — parallel on core 0
  │     ├── Worker 1 → stepChunk(chunk B)    — parallel on core 1
  │     └── Worker N → stepChunk(chunk C)    — parallel on core N
  ├── Social systems (marriage, buildings)   — single thread (global state)
  └── Broadcast WS delta
```

Each `stepChunk` call receives:
- The agents residing in its chunk (world-space 64×64 cell region)
- A halo of border agents from the 8 adjacent chunks (ghost perception layer)
- Emigrants: agents that crossed the boundary are returned and routed next tick

### Measured performance (32 cores, 256×256 grid)

| N agents | Single-thread avg | Pool avg | Workers | Budget (30 Hz) |
|---|---|---|---|---|
| 500 | 8.2 ms | 19.9 ms | 31 | 33 ms ✓ |
| 2000 | 27.1 ms | 72.1 ms | 31 | 33 ms — pool too slow |
| 5000 | 73.8 ms | 211 ms | 31 | missed |
| 10000 | 261.8 ms | 442 ms | 31 | missed |

**Key insight**: The pool's message-passing overhead (~8–15 ms/round-trip) dominates
at small agent counts. The crossover point where pool > single-thread is ~5000+ agents
per chunk (chunk compute > round-trip cost). At typical early-world scale (few HOT
chunks, <500 agents), single-thread is faster and is the default.

The pool becomes beneficial for:
1. Many HOT chunks at once (the world grows and colonises wide areas)
2. High agent density per chunk (chunk compute dominates round-trip cost)
3. Future field-engine parallelisation (each worker gets its own field slice)

### Determinism preserved

Same seed always produces the same world history regardless of worker count.
Merge order is sorted by `chunkKey` for deterministic result ordering.
Worker RNG is seeded by `(worldSeed ^ workerId ^ tick)` — per-tick, per-worker.
