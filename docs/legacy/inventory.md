# Legacy Repos Inventory — Una Carta Para Isa

Three-repo archaeological record of the "Una Carta Para Isa" project. Each repo represents a philosophical and technical evolution of the same vision: building a living, autonomous ecosystem from 227k+ lines of real conversation.

---

## 1. UnaCartaParaIsa (Frontend)

**URL:** https://github.com/stevenvo780/UnaCartaParaIsa  
**Role:** Main interactive letter — 30+ simulation systems rendered in Phaser 3

### Stack Confirmed
- **Runtime:** Node.js (npm, TypeScript 5.8)
- **Framework:** Phaser 3.90.0 (2D game engine)
- **Build:** Vite 7.1.2 + ESBuild
- **Language:** TypeScript strict mode
- **UI Components:** React 18.3 + Material-UI 7.3
- **Testing:** Vitest 3.2 + Playwright 1.56 (E2E)
- **Persistence:** localStorage, MessagePack serialization
- **Rendering:** Canvas 2D via Phaser, pixel-art optimized

### Folder Structure (3 levels)
```
src/
├── application/          # Startup, clock, event bus core
├── config/              # Constants (thresholds, rates)
├── core/                # LifeCycle, Needs, Inventory, Clock
├── data/                # Genealogy, Demographics, EventLog
├── engine/              # Simulation runner, RNG, deterministic
├── network/             # Express server stub
├── ui/                  # React panels (Genealogy, Household, Agents)
├── workers/             # Web Workers (optional heavy compute)
└── styles/              # CSS, themes
```

### Key Subsystems
1. **SystemClock** (`engine/`) — deterministic time + RNG seed, reproducibility core
2. **LifeCycleSystem** (`core/`) — birth, aging, death, genealogy tracking
3. **NeedsSystem** (`core/`) — hunger, energy, rest, social drives
4. **InventorySystem** (`core/`) — items, crafting, resource tracking
5. **AIEvaluators** (`application/`) — modular priority logic (goals → actions)
6. **SocialSystem** (`core/`) — relationships, reputation, household formation
7. **EconomySystem** (`core/`) — roles, trading, wealth distribution
8. **EventBus** (`application/`) — typed inter-system messaging, safe payloads

### Design Decisions
- **Deterministic reproducibility:** Fixed RNG seed enables replay of exact simulations (logged in MONITORING.md)
- **Modular evaluators:** AI not hardcoded goals; instead, each system emits priorities (hunger → "find food" task) and evaluators rank them
- **Event-driven architecture:** No tight coupling; all systems communicate via typed EventBus
- **Monolithic frontend:** All UI in React; simulation loop in Phaser; no separation between game engine and presentation logic

### What Failed or Abandoned
- **Code-splitting performance:** Chunks still >500KB (noted in walkthrough.md perf review)
- **Web Workers pool:** Workers directory exists but under-utilized (no streaming per chunk)
- **Legacy "goals/actions" model:** Replaced by unified task queue v4 (see IA.md in backend) but old code comments persist
- **Deprecated systems:** Some old `SystemRegistry` patterns still present; migration to ECS incomplete

### Lessons for Remake
1. **Keep:** Deterministic clock + RNG; event-driven messaging; modular evaluator pattern
2. **Rethink:** Code splitting for AI modules; separate simulation from rendering more aggressively
3. **Drop:** Monolithic Phaser clock loop; consider moving heavy simulation to Web Worker or backend
4. **Add:** State versioning/snapshots for true replay; stream simulation via WebSocket

---

## 2. duo-eterno (React Canvas Intimate Version)

**URL:** https://github.com/stevenvo780/duo-eterno  
**Role:** Philosophical tamagotchi — two autonomous entities, emergent codependency, existential resonance

### Stack Confirmed
- **Runtime:** Node.js (npm, TypeScript 5.8)
- **Framework:** React 19.1 (hooks-first)
- **Build:** Vite 6.3.2
- **Rendering:** Canvas 2D (custom hooks, no game engine)
- **Testing:** Vitest 2.1 + Testing Library
- **Persistence:** localStorage only
- **Language:** TypeScript strict

### Folder Structure
```
src/
├── components/          # Canvas, UI panels, debug
├── hooks/              # Game loop (useUnifiedGameLoop, usePhysics)
├── state/              # React Context (entities, resonance, stats)
├── utils/              # Algorithms (decay, collision, pathfinding)
├── types/              # TypeScript interfaces
├── constants/          # Thresholds, rates, personality math
├── config/             # Environment-specific config
└── generated/          # Auto-generated code (analysis tools)
```

### Key Subsystems
1. **useUnifiedGameLoop** — 60 FPS physics engine, canvas rendering loop
2. **Personality Engine** — Circle (social/intuitive) vs Square (persistent/efficient) differential behavior
3. **Activity Inertia** — momentum-based state transitions (SEEKING → FLOWING → IDLE)
4. **Resonance** (`hooks/`) — existential bond metric (0-100); death by disconnection when <10
5. **Hybrid Decay** — stats degrade asymmetrically by activity type
6. **Survival Improvements** (`MEJORAS_SUPERVIVENCIA.md`) — grace period, early warnings, difficulty modes

### Design Decisions
- **Philosophical tamagotchi:** Not a traditional game; explicitly framed as autopoiesis + co-evolution laboratory
- **Personality differentiation:** Behavior emerges from dimensional personality traits (socialness, efficiency), not hardcoded FSM
- **Minimal backend:** Only React Context + localStorage; no server dependency
- **Death as mechanic:** Disconnection results in "fading" state → permanent death; not reversible

### What Failed or Abandoned
- **High memory usage:** Tests fail with memory limits (~500MB); suggests inefficient state management (noted in PLAN_COMPLETION_AUDIT.md)
- **Complexity of decay math:** Multiple interacting decay functions led to tuning hell; survival overhauls happened 3+ times
- **No logging server initially:** Added later (backend/logs/) but too late to help early balance
- **Canvas rendering unoptimized:** No layer caching; O(n²) proximity checks every frame (see OPTIMIZACIONES_IMPLEMENTADAS.md)

### Lessons for Remake
1. **Keep:** Personality-driven behavior; resonance as mechanical bond; philosophical framing
2. **Rethink:** Decay math — too many parameters; move to backend for centralized tuning
3. **Drop:** Manual canvas rendering (use WebGL or Babylon.js); localStorage only (add server sync)
4. **Add:** Logging from day 1; separate physics engine library; difficulty as first-class server feature

---

## 3. UnaCartaParaIsaBackend (Node + WebSockets + TensorFlow)

**URL:** https://github.com/stevenvo780/UnaCartaParaIsaBackend  
**Role:** Authoritative simulation server — AI, economies, battles, GPU acceleration

### Stack Confirmed
- **Runtime:** Node.js (npm, TypeScript 5.9, tsx for dev)
- **Server:** Express 4.18 + WebSockets (ws 8.18)
- **DI:** Inversify 7.10 (service locator pattern)
- **GPU (optional):** TensorFlow.js Node (@tensorflow/tfjs-node 4.22) + GPU plugin
- **Storage:** Google Cloud Storage (GCS) or local filesystem + SFTP NAS backups
- **Monitoring:** Prometheus + Grafana (auto-provisioned)
- **Build:** TypeScript → ES modules, no bundler

### Folder Structure
```
src/
├── application/         # Express routes, server.ts (HTTP + WS)
├── config/             # DI container, constants, types
├── domain/simulation/  # Core: SimulationRunner, system classes
│   └── systems/        # AISystem, MovementSystem, EconomySystem, etc.
├── infrastructure/     # Storage, chunk streaming, performance monitor
└── shared/             # MessagePack codecs, types
```

### Key Subsystems
1. **SimulationRunner** (`domain/simulation/`) — authoritative state machine, command queue
2. **SystemRegistry** + **EventBus** — modular systems with safe typed events
3. **AISystem v4** (IA.md) — unified task queue, detector-based goal emission, handler dispatch
4. **Scheduler (FAST/MEDIUM/SLOW)** — 60 Hz, 10 Hz, 1 Hz rates per system
5. **WorldQueryService** — spatial index (Delaunay); batch vectorized queries
6. **GPUComputeService** — lazy-load TensorFlow for N ≥ 1000 entities
7. **PerformanceMonitor** (`infrastructure/`) — tick metrics, memory tracking, Prometheus export
8. **Chunk Streaming** — async terrain generation + delivery via WebSocket

### Design Decisions
- **GPU optional, not required:** CPU fallback; thresholds (5-20 entities) trigger GPU batch processing
- **Batch processing with yields:** AISystem processes 50 agents, then yields via `setImmediate()` to prevent event loop blocking
- **Spatial partitioning for economy:** 500×500-unit grid cells; trading only within cell + 8 adjacent (O(n²) → O(n×k))
- **Deterministic replayability:** Same RNG seed + event log → identical simulation
- **Idle worker pool:** ProductionSystem maintains pool of available workers, updated every 2s

### What Failed or Abandoned
- **TensorFlow.js integration:** GPU acceleration implemented but underutilized; threshold too high in early versions
- **Chunk caching:** Terrain generation async but no CDN; each client re-requests chunks
- **Old goals/actions model:** Replaced by task queue v4; legacy code still in comments
- **Single-threaded bottleneck:** All systems in main event loop; Web Workers not used for heavy math

### Lessons for Remake
1. **Keep:** Authoritative server pattern; batch processing + yields; spatial partitioning; modular systems via DI
2. **Rethink:** TensorFlow integration — either commit to GPU or remove; separate simulation into Worker threads
3. **Drop:** Dual-stack storage (GCS + local); pick one or abstract better
4. **Add:** Server-side replay/snapshots; client state validation; load testing (k6, Artillery)

---

## Synthesis: Patterns & Contradictions

### Obsessions (Recurring Patterns)
1. **Deterministic Reproducibility:** All three repos feature RNG seeds + event logging for replay; Steven's signature—control over emergence
2. **Modular Evaluators/Planners:** Whether via EventBus or hooks, no hardcoded AI paths; always soft priorities
3. **Existential Metrics:** Resonance (duo-eterno), relationships (main), bonds (backend); love as a mechanical property
4. **Philosophical Framing:** Every README is a manifesto; code as medium for questions about consciousness, autopoiesis, love
5. **GPU Exploration:** Every backend version mentions TensorFlow; never fully deployed but always tempting

### Contradictions (Change of Mind)
1. **Monolithic Frontend vs. Distributed Backend:** Main repo bundles simulation + UI; backend decouples them, causing sync friction
2. **Simplicity vs. Completeness:** duo-eterno strips to 2 entities (philosophical clarity); main has 30+ systems (mechanical complexity)
3. **Decay Tuning:** duo-eterno's survival overhauls suggest decay math is fundamentally hard to balance; backend still tries via parameters

---

**Archive Date:** 2025-05-16  
**Conversion Status:** Ready for unified remake with lessons applied
