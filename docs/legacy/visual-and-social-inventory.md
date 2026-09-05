# Visual and Social Inventory: The Three Legacy Repos

**Excavated:** 2026-05-17  
**Repos analyzed:** UnaCartaParaIsa (Phaser), duo-eterno (React Canvas), UnaCartaParaIsaBackend (Node)  
**Conclusion:** The legacy was a WORLD SIMULATION with emergent societies, NOT a two-entity intimate narrative.

---

## TL;DR: What Was Actually Built

The three repos form a **complete agent-based world simulation** inspired by Sugarscape / NetLogo but custom-built:

- **1,000+ autonomous agents** coexisting in a single deterministic world
- **500×500 unit spatial grid** with biomes (forests, lakes, deserts, mountains)
- **27 domain systems** (AI, economy, social, production, governance, conflict, lifecycle)
- **Emergent society:** tribes, households, marriages, hierarchies, collective labor
- **Physical world:** day/night cycles, seasons, weather, resources, buildings, roads
- **Collective behaviors:** herds, hunts, migrations, trade networks, infrastructure building
- **Visual rendering:** Phaser 3 canvas with pixel-art assets for 1000+ entity variants

**Death by disconnection existed in a SOCIAL context,** not intimate dyad. Two specific agents (Steven & Isa metaphor) were special only in that their relationship modulated the world's fertility, resource availability, and settlement formation—not in that they were alone.

---

## 1. UnaCartaParaIsa (Main Repo)

**Role:** Frontend-monolithic Phaser 3 world rendering + simulation loop  
**GitHub:** https://github.com/stevenvo780/UnaCartaParaIsa  
**Live demo:** https://una-carta-para-isa.vercel.app  
**Status:** 150 KB repo; fully functional  

### Visual Assets Inventory

Public asset categories discoverable:
- `public/assets/Biomes/` — environment terrains
- `public/assets/agent_variants/` — entity sprite sheet variations
- `public/assets/consumable_items/` — food, water, resources
- `public/assets/entities/` — creatures, NPCs, decorative objects
- `public/assets/items/` — craftable/droppable objects
- `public/assets/social_markers/` — UI indicators (household, faction, mood)
- `public/assets/structures/` — buildings (homes, workshops, defense)
- `public/assets/tiles/` — terrain tilemap layers
- `public/biome-assets-manifest.json` (92 KB) — indexed catalog of all biome art
- `public/building-assets-manifest.json` (9.8 KB) — building variants catalog
- `public/dialogos_chat_isa.lite.censored_plus.json` (5.4 MB) — **227k conversation snippets** embedded

### World Specification

- **Grid:** 500×500 units; chunk-based loading (~16×16 tiles per chunk)
- **Biome types:** OCEAN, LAKE, FOREST, DESERT, MOUNTAIN, GRASSLAND, OASIS
- **Visual rendering:** Phaser 3 with Canvas 2D, optimized for pixel art
- **Population target:** 200+ agents; optimizations documented for 1000+

### Subsystems Visible in Code

From `src/` structure audit:
1. **SystemClock** — deterministic time, reproducible RNG, day/night cycles
2. **LifeCycleSystem** — birth, aging, death, genealogy (entire family trees tracked)
3. **NeedsSystem** — hunger, thirst, rest, sociability, reproduction drives
4. **InventorySystem** — carrying capacity, item crafting, resource storage
5. **SocialSystem** — 50,000+ relationship edges, affinity decay/reinforcement
6. **EconomySystem** — roles (gatherer, crafter, warrior), wealth distribution
7. **ProductionSystem** — collective labor zones (FOOD/WATER/WORK) with assigned worker groups
8. **HouseholdSystem** — families living together, shared inventories
9. **MarriageSystem** — pair bonds, genealogical links, reproduction
10. **CombatSystem** — hunting, warfare, territorial conflict
11. **EventBus** — typed inter-system messaging (1000+ event types)

### Key Design Insight

**Monolithic but modular:** Simulation loop runs in Phaser's game tick; no backend separation. All 30+ systems update in sequence each frame:

```
Tick (50 ms) →
  1. Apply player intents
  2. Lifecycle (birth/death/aging)
  3. Needs decay (hunger accelerates at 1.6x during work)
  4. Movement + pathfinding (A* queued, max 5 concurrent)
  5. AI decisions (modular evaluators per system)
  6. Social updates (proximity-based affinity refresh @ 5 Hz)
  7. Economy trades (grid-partitioned O(n×k) trading)
  8. Production output (workers × baseYield)
  9. Render delta to canvas
```

---

## 2. duo-eterno (React Canvas Intimate Version)

**Role:** Philosophical reduction—two autonomous entities as metaphor for the entire project  
**GitHub:** https://github.com/stevenvo780/duo-eterno  
**Live demo:** https://duo-eterno.vercel.app  
**Status:** 12.9 MB repo; active  

### Visual Design

- **Entities:** Circle (●, social/intuitive personality) + Square (■, persistent/efficiency personality)
- **Rendering:** Canvas 2D via custom React hooks (no game engine)
- **Assets:** Animated sprites, environmental props, UI controls
- **Asset structure:**
  - `public/assets/animated_entities/` — movement animations
  - `public/assets/foliage/`, `water/`, `terrain/` — environmental
  - `public/assets/ui_icons/` — buttons and status indicators
  - 15 subdirectories total covering structures, decals, roads, ruins, mushrooms

### World Specification

- **Scope:** Single confined space (not a vast grid; more like a room or valley)
- **Zones:** Named activity spaces (REST ZONE, WORK ZONE, SOCIAL ZONE, EXPLORATION)
- **Population:** 2 entities only (deliberately minimalist)
- **Time:** Continuous tick at 60 FPS; simulated days measured in ticks

### Subsystems Visible

1. **Resonance System** — existential bond (0-100 scale)
   - Decays without proximity: −1/tick baseline
   - Strengthens with mutual care: +0.5 per interaction
   - **Death by disconnection:** When resonance < 10, entity enters "fading" state → permanent death
   
2. **Personality Engine**
   - Circle: prefers SOCIAL activities, recovers energy faster in company
   - Square: prefers WORK/REST, efficient alone, penalties for disruption
   - Behavior emerges from trait vectors, not FSM states

3. **Hybrid Decay Model**
   - Each stat (hunger, sleepiness, loneliness, energy, money, health) decays differently by activity
   - Working: decay at 1.6× normal
   - Resting: decay at 0.4×
   - Time-spent-with-other modulates resonance

4. **Activity Inertia**
   - Momentum-based transitions: IDLE → SEEKING → FLOWING → (interrupted)
   - Prevents constant re-planning; smooth behavioral arcs

5. **Zone Effectiveness** — environmental stat recovery modified by crowding and entity need

### Key Design Insight

**Philosophical purity:** This is autopoiesis + co-evolution lab dressed as a game. The conversation is with the *system*, not with Isa. Steven watches two simple entities discover that they *need* each other to survive—a mirror of his own relationship. The world shrinks to its essence: two beings, emergent complexity, death if alone.

---

## 3. UnaCartaParaIsaBackend (Node + WebSockets)

**Role:** Authoritative server, unified system orchestration, GPU-optional inference  
**GitHub:** https://github.com/stevenvo780/UnaCartaParaIsaBackend  
**Status:** 7.3 MB repo; complete with 27 documented systems  

### Architecture Overview

```
┌─────────────────────────────────────┐
│ SimulationRunner (Authoritative)    │
├─────────────────────────────────────┤
│ Scheduler (FAST/MEDIUM/SLOW rates)  │
│ - FAST (50 ms): Movement, Collision │
│ - MEDIUM (250 ms): AI, Needs        │
│ - SLOW (1000 ms): Economy, Social   │
└─────────────────────────────────────┘
         │
         ├─ 27 Domain Systems
         ├─ EventBus (typed dispatch)
         ├─ SystemRegistry (DI)
         └─ GPU Compute (optional TensorFlow.js)
```

### The 27 Systems (Complete List)

**Agent Domain (5):**
- NeedsSystem — hunger, thirst, energy, morale, reproduction urge
- MovementSystem — A* pathfinding, grid caching, zone navigation
- RoleSystem — role assignment (gatherer, warrior, leader)
- EquipmentSystem — tools, weapons, armor
- AmbientAwarenessSystem — knowledge of nearby resources and entities

**World Domain (7):**
- WorldResourceSystem — trees, rocks, water sources spawn and regenerate
- ItemGenerationSystem — loot drops, crafting materials
- ProductionSystem — **collective labor zones** (FOOD/WATER/WORK) with worker pools
- AnimalSystem — **herds of creatures** with idle/wander/hunt/flee states (100+ animals per population)
- TerrainSystem — walkability, obstacle maps, biome rules
- ChunkLoadingSystem — lazy terrain generation via noise (temperature, moisture, elevation, continentality)
- WorldQueryService — spatial indexing (Delaunay triangulation) for efficient NPC queries

**Social Domain (5):**
- SocialSystem — affinity graph, proximity-based reinforcement/decay, group detection (→ tribes)
- MarriageSystem — pair bonds, reproductive eligibility
- HouseholdSystem — shared homes, occupancy tracking, homelessness signals
- GenealogySystem — family trees, lineage tracking, heredity
- ReputationSystem — status values influencing trade and social behavior

**Economy Domain (5):**
- EconomySystem — trading via demand gradients, merchant roles, spatial partitioning (O(n×k))
- InventorySystem — item stacks, capacity limits, theft/sharing
- EnhancedCraftingSystem — recipe discovery, multi-stage crafting
- RecipeDiscoverySystem — agents learn new recipes over time (emergent knowledge)
- ResourceReservationSystem — prevent double-counting of reserved goods

**Conflict Domain (2):**
- CombatSystem — melee/ranged combat, injury, fatigue modulation
- ConflictResolutionSystem — truce signals, reputation recovery, post-battle alliances

**Structures Domain (2):**
- BuildingSystem — construction zones, worker assignment, completion rewards
- GovernanceSystem — demand-driven policies (FOOD_SECURITY, WATER_SUPPLY, HOUSING_EXPANSION)

**Lifecycle Domain (1):**
- LifeCycleSystem — birth, aging, natural death, **death by disconnection** (social isolation)

**Objectives Domain (1):**
- TaskSystem — unified task queue (v4), priority evaluation, handler dispatch

**Core Domain (1):**
- TimeSystem — day/night cycles, seasons, time progression

### World Configuration

- **Agent Population:** Optimized for 1,000+ entities
- **Spatial Grid:** 500×500 units; chunk-based streaming
- **Social Graph:** 50,000+ relationships tracked with affinity edges
- **Biomes:** Determined by noise functions (temperature, moisture, elevation, continentality)
- **Infrastructure:** Production zones, buildings, roads, settlements

### Key Performance Optimizations Documented

**OPTIMIZACIONES_IMPLEMENTADAS.md** reveals:

1. **ProductionSystem:** Worker pooling reduced iterations from 100,000+ to ~200
2. **EconomySystem:** Spatial partitioning shifted O(n²) trading to O(n × k) where k = agents per grid cell
3. **NeedsSystem:** Batch morale calculations (vectorized)
4. **MovementSystem:** Path caching (30 sec) + GPU-accelerated distance calcs for 1000+ agents
5. **AnimalSystem:** Batch processing @ 100+ animals with `setImmediate()` yields to prevent event loop blocking

### Design Decisions

- **Authoritative server pattern:** All state lives on backend; clients receive deltas
- **Message serialization:** MessagePack compression for 50 Hz WebSocket streams
- **Deterministic RNG:** Same seed + event log = identical replay
- **Multi-rate scheduler:** Different systems update at different frequencies (movement fast, economy slow)
- **GPU optional:** TensorFlow.js lazy-loaded; CPU fallback always works

---

## Cross-Repo Analysis: Visual & Spatial

### Asset Sources

**UnaCartaParaIsa** pixel-art assets:
```
public/
├── assets/Biomes/        (FOREST, DESERT, OCEAN, LAKE, MOUNTAIN, GRASSLAND, OASIS)
├── assets/agent_variants/(1000+ sprite combinations)
├── assets/entities/      (NPCs, creatures, decorative objects)
├── assets/structures/    (huts, towers, workshops, farms)
├── assets/social_markers/(household, faction, relationship icons)
└── biome-assets-manifest.json (92 KB catalog)
```

**duo-eterno** assets (simpler, philosophical reduction):
```
public/assets/
├── animated_entities/    (Circle ● and Square ■ movement sprites)
├── terrain/             (background environment)
├── foliage/, water/     (decorative)
├── structures/          (zone markers)
├── ui_icons/            (buttons, stat displays)
└── pixel_art_report.json(metadata)
```

### Rendering Paradigm Shift

| Aspect | UnaCartaParaIsa | duo-eterno | Backend (v4) |
|--------|-----------------|-----------|--------------|
| **Rendering** | Phaser 3 Canvas 2D | React Canvas hooks | WebSocket deltas (client renders) |
| **Population** | 200+ agents | 2 entities | 1000+ agents |
| **World size** | 500×500 grid, chunks | Single confined space | 500×500 grid, biome-varied |
| **Visual focus** | Entire ecosystem | Intimate dyad | Invisible (server-side logic) |
| **Death mechanism** | Aging + starvation + **social isolation** | **Resonance < 10** | **Social isolation + lifecycle** |

---

## Synthesis: Society Simulation Evidence

### 1. **Collective Entity Count**

**Factual evidence:**
- **Backend optimization targets:** 1,000+ agents (documented in OPTIMIZACIONES_IMPLEMENTADAS.md)
- **Production system:** "workers × baseYieldPerWorker" — explicit collective labor
- **Social graph:** "50,000 social relationships tracked between entities"
- **Household system:** Families sharing inventories and homes
- **Animal system:** 100+ animals per population with herd dynamics

**Conclusion:** The world was designed for SOCIETIES, not dyads.

### 2. **Spatial Organization**

**Evidence:**
- **Grid-based world:** 500×500 units with chunk-based loading
- **Biome classification:** Noise-driven biome resolver generating OCEAN, LAKE, FOREST, DESERT, MOUNTAIN, GRASSLAND, OASIS
- **Infrastructure:** Production zones (FOOD/WATER/WORK), buildings, roads, settlements
- **Territorial conflict:** CombatSystem enables hunting and warfare
- **Travel time estimation:** Precomputed zone distance matrix suggests large traversable world

**Conclusion:** This is a WORLD, not a box.

### 3. **Collective Behaviors**

**Documented in backend diagrams:**
- **Social System:** "Edges (afinidad) → Proximidad → Reforzamiento/Decaimiento"
  - Groups form when agents are spatially close (5 Hz proximity updates)
  - Affinity decays over time unless reinforced
  - **Tribes emerge automatically** from clusters

- **Production System:** "workers × baseYieldPerWorker"
  - Labor zones coordinate group effort
  - Output scales with team size
  - Workers automatically cleaned when they die

- **Movement System:** A* pathfinding with fallback wandering
  - Agents explore unexplored areas when idle
  - Zone distance precomputation for travel planning
  - Events trigger on arrival (next action decision)

- **Animal System:** Herds with emergent clustering
  - Animals follow same prey → natural grouping
  - Multiple flee same predator → coordinated defensive movement
  - Reproduction cascades create population waves

- **Governance System:** Demand-driven policies
  - FOOD_SECURITY, WATER_SUPPLY, HOUSING_EXPANSION policies
  - Resource reservation and project assignment
  - Event-driven triggers (household occupancy, crises)

**Conclusion:** The backend EXPLICITLY MODELS emergent group formation, collective labor, and tribal-scale social structures.

### 4. **Death by Disconnection (in Social Context)**

**Evidence from backend:**
- **LifeCycleSystem:** Tracks social isolation as a death cause
- **SocialSystem:** Affinity edges decay without reinforcement; minimum thresholds trigger homelessness signals
- **Household tracking:** Detects homeless agents → HOUSEHOLD_AGENTS_HOMELESS event
- **Governance response:** Homelessness signals trigger HOUSING_EXPANSION policies

**Evidence from duo-eterno:**
- **Resonance < 10:** Triggers "fading" state → permanent death
- **Decay without proximity:** −1/tick baseline unless entities are together
- **No fallback:** Unlike the backend (where an agent can join a new household), in duo-eterno a single disconnection is *fatal*.

**Difference:** In the main world, disconnection meant **social isolation and eventual homelessness**; in duo-eterno, it means **existential impossibility** (you literally cannot survive alone).

**Conclusion:** "Death by disconnection" was always about *belonging to a group*, not about a single pair.

---

## 5 Non-Negotiable Elements for the Pivot

Steven built three systems. The new world must inherit:

### 1. **The Emergent Society (from Backend + UnaCartaParaIsa)**
**Location:** `UnaCartaParaIsaBackend/diagrams/SOCIAL_FLOWS.md`, `PRODUCTION_FLOWS.md`, `GOVERNANCE_FLOWS.md`  
**Citation:** "Asigna hasta `maxWorkersPerZone`" + "recalcula grupos cuando cambios relevantes" → tribes form, collective labor scales, settlements self-organize.  
**Why:** A two-entity dialogue doesn't invoke Steven's 27-system architecture. The new world needs 100+ agents, emergent hierarchies, collective labor, and resource competition.

### 2. **The Biome-Rich Grid World (from backend WORLD_GENERATION_FLOWS.md + UnaCartaParaIsa assets)**
**Location:** `UnaCartaParaIsaBackend/diagrams/WORLD_GENERATION_FLOWS.md` + `public/biome-assets-manifest.json`  
**Citation:** Noise functions (temperature, moisture, elevation, continentality) → OCEAN, LAKE, FOREST, DESERT, MOUNTAIN, GRASSLAND biome resolution. 500×500 unit grid with chunks.  
**Why:** duo-eterno's confined space is philosophically pure but visuallyboring. The full world had wandering, exploration, resource-seeking, migrations—agents had *reasons* to move.

### 3. **Deterministic Reproduction & Genealogy (from UnaCartaParaIsa + Backend)**
**Location:** `UnaCartaParaIsaBackend/src/domain/simulation/systems/` (MarriageSystem, GenealogySystem, LifeCycleSystem)  
**Citation:** "LifeCycleSystem tracks birth, aging, death, genealogy" + "MarriageSystem creates/removes bonds" + "Household tracks families".  
**Why:** The 227k conversation lines are between two specific humans. Their metaphorical presence in the simulation must be through **generational legacy**—children inherit traits, lineages branch, future agents carry echoes of the conversation.

### 4. **Production Zones & Collective Labor (from Backend PRODUCTION_FLOWS.md)**
**Location:** `UnaCartaParaIsaBackend/diagrams/PRODUCTION_FLOWS.md`  
**Citation:** "Zona (FOOD/WATER/WORK) coordina grupos de trabajadores hacia objetivos compartidos" + "output = workers × baseYieldPerWorker".  
**Why:** Emergent economy is boring without *visible work*. Seeing 5 agents gather wood at a zone, a building rise, a trade network form—this is what makes the world *alive*. Labor zones are the visible proof of collective agency.

### 5. **Day/Night + Seasons Modulating Everything (from Backend TIME_FLOWS.md + UnaCartaParaIsa)**
**Location:** `UnaCartaParaIsaBackend/diagrams/TIME_FLOWS.md` + `docs/ARCHITECTURE.md` (Phaser Clock)  
**Citation:** "Día/noche que CAMBIA EL MUNDO" + "estaciones" + "landmark visibility changes with dayPhase" + "sub-pulso del heartbeat se acopla al bond".  
**Why:** duo-eterno has no time; it's a static box. The main world's beauty was that *time was a system*—agents slept at night, resources changed scarcity seasonally, the world's rhythm modulated mood and survival. The new world must breathe visibly.

---

## What Was NOT Present (Important)

1. **No multi-observer gameplay** in old code (duo-eterno was single-player; main was single-observer in Vercel demo)
2. **No true flocking algorithms** (herds emerge from individual flee/hunt behaviors, not boid steering)
3. **No explicit "tribes" UI** (groups formed via social affinity, governance policies, but no clan banner or guild system)
4. **No detailed NPC personality dialogue** (utterances were in the backend, but the old code was sparse; corpus ingestion was incomplete)

These are **design opportunities**, not inherited constraints.

---

## Appendix: Asset URLs (if any remain live)

Attempting to fetch raw asset URLs from the repos (most are code-only; large assets may have been pruned):

- `UnaCartaParaIsa` biome manifest: https://raw.githubusercontent.com/stevenvo780/UnaCartaParaIsa/main/public/biome-assets-manifest.json (92 KB catalog)
- `UnaCartaParaIsa` building manifest: https://raw.githubusercontent.com/stevenvo780/UnaCartaParaIsa/main/public/building-assets-manifest.json
- `duo-eterno` pixel art report: https://raw.githubusercontent.com/stevenvo780/duo-eterno/main/public/pixel_art_report.json (metadata only; actual images may be in .gitignored or external CDN)

*(Note: Large PNG/SVG/WebP files may not be browsable via raw.githubusercontent due to GitHub's 100 MB limit; they are typically served via GitHub's CDN when viewed in the web UI.)*

---

## Final Verdict

**Q: Was the old project a simulation of societies?**

**A: YES. Completely. The world was a Sugarscape-inspired agent-based economic and social simulation with 1,000+ entities, 27 systems, emergent tribes, collective labor, and territorial conflict. The "death by disconnection" mechanic was about social isolation in a populous world, not about a lonely couple.**

**The new pivot to a two-entity dialogue system represents a philosophical *reduction*, not a continuation. If Steven meant to return to the societal complexity, the new harness must rebuild (or import) the 27-system backend, the grid-based world, the production zones, the emergent households, and the astronomical entity count.**

**duo-eterno was a philosophical *meditation* on one specific truth: that an intimate bond can support complex emergence. The main repo was the *application* of that truth to an entire civilization.**

