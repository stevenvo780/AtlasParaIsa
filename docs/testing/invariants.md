# Testing invariants — Una Carta Para Isa

This document maps each of the four project pillars (see `docs/concepts/four-pillars.md`) to concrete, named test invariants. Every invariant listed here must have a passing test at all times. A PR that breaks a test in this list requires explicit justification from the author and sign-off from `code-reviewer`.

---

## Global rules (enforced across all packages)

These are meta-invariants on the test suite itself.

| Rule | Enforcement |
|---|---|
| No `Date.now()` in test code | `expectInvariant` from `@carta/test-utils`; ESLint rule `no-restricted-globals` pointing to `Date.now` in `tests/**` |
| No unseeded `Math.random()` in test code | Same ESLint rule; all randomness goes through `createRng(seedFor(label))` |
| Snapshot hashes change only with justification | CI snapshot diff step; reviewer must approve hash change in PR description |
| Real chat corpus never in tests | Fixture files are synthetic; `data/` is in `.gitignore` |
| One test per invariant beats 50 coverage tests | Coverage is a diagnostic, not a target |

---

## Pilar 1 — Death by disconnection

Source: `four-pillars.md` §Pilar 1. Conceptual basis: Maturana & Varela autopoiesis; acoplamiento estructural.

### P1-INV-1: Bond decays monotonically without interaction

**Name:** `coupling-monotone-decay`
**Package:** `packages/sim-core`
**Test path:** `packages/sim-core/tests/bond/monotone-decay.test.ts`
**Claim:** For every alive entity, if no interaction occurs in tick `t`, then `bond(t+1) ≤ bond(t)`. Strictly less than while `bond > 0`.

**How to measure:** Run N ticks with zero `InteractAction`. Assert `bond(t) > bond(t+1)` for all t. Use `seedFor("P1-INV-1")`.

**Anti-pattern to catch:** A `bondDecayPerTick` of `0`, or a system that skips the decay branch. The code reviewer must verify `BondableComponent.bondDecayPerTick > 0` is asserted on world construction.

---

### P1-INV-2: Vitality (energy) is penalized by low bond

**Name:** `vitality-penalized-by-low-bond`
**Package:** `packages/sim-core`
**Test path:** `packages/sim-core/tests/bond/vitality-penalty.test.ts`
**Claim:** `energy(t+1) = f(energy(t), bond(t))` with `∂f/∂bond > 0`. Two runs — one with `bond=0.9`, one with `bond=0.1` — diverge in energy within 100 ticks, the high-bond run always higher.

**How to measure:** Seed both runs with `seedFor("P1-INV-2")`. Set initial bond to 0.9 vs 0.1. Run 100 ticks. Assert `energy_highbond > energy_lowbond`.

**Anti-pattern to catch:** An energy reducer that does not read `bond` at all, or a conditional that makes energy independent of bond when above some arbitrary threshold.

---

### P1-INV-3: Zero bond implies strictly negative vitality delta

**Name:** `zero-bond-kills-energy`
**Package:** `packages/sim-core`
**Test path:** `packages/sim-core/tests/bond/zero-bond-energy-drain.test.ts`
**Claim:** When `bond == 0`, `energy(t+1) < energy(t)` without exception. No homeostasis is achievable alone.

**How to measure:** Fix `bond = 0` (no interaction), run 10 ticks, assert `energy` strictly decreasing each tick.

**Anti-pattern to catch:** A homeostasis setpoint that maintains energy when bond is zero. If energy plateaus at any positive value with bond=0, this invariant is dead.

---

### P1-INV-4: Isolation for T_max ticks kills the entity (death by disconnection scenario)

**Name:** `isolation-kills-within-T-max`
**Package:** `packages/sim-core`
**Test path:** `packages/sim-core/tests/scenarios/death-by-disconnection.test.ts`
**Claim:** There exists a finite `T_max` (= `bondLethalTicks` in config) such that an entity isolated for `T_max` consecutive ticks transitions to `alive = false` with `causeOfDeath = "DisconnectionDeath"`.

**How to measure:** Seed: `seedFor("P1-INV-4-isolation")`. Create two entities, place them at maximum distance, run `bondLethalTicks + 10` ticks. Assert both entities dead. Hash the final world state for snapshot regression.

**Anti-pattern to catch:** A `disconnectionTimer` that only fires UI events without touching `LifecycleComponent.alive`. The entity must genuinely die — `isAlive(ecs, id)` must return `false`.

---

### P1-INV-5: Reconnection cures (while both alive)

**Name:** `reconnection-cures-while-alive`
**Package:** `packages/sim-core`
**Test path:** `packages/sim-core/tests/scenarios/reconnection-recovery.test.ts`
**Claim:** If `energy > ε` and regular interaction resumes, both `bond` and `energy` return to a stable positive state within `T_recover` ticks.

**How to measure:** Run entities to `bond = 0.15` (just above lethal threshold). Then place them in interaction range for 200 ticks. Assert `bond > 0.3` and `energy > 0.5` at end.

**Anti-pattern to catch:** Recovery that only resets a visual indicator without actually updating `HomeostasisComponent.energy`.

---

### P1-INV-6: Bond symmetry (no single survival)

**Name:** `bond-symmetry-no-asymmetric-death`
**Package:** `packages/sim-core`
**Test path:** `packages/sim-core/tests/bond/symmetry.test.ts`
**Claim:** Both entities start with identical initial state and identical isolation. They must die at the same tick. Neither survives while the other dies by disconnection.

**How to measure:** Seed: `seedFor("P1-INV-6-symmetry")`. Identical initial components for both entities. Assert `causeOfDeath` tick is equal (±0 ticks) for both.

**Anti-pattern to catch:** A system that applies bond decay in insertion order but only runs for a fixed count — if entity "steven" always processes before "isa", timing can drift.

---

## Pilar 2 — Conversaciones reales como semilla

Source: `four-pillars.md` §Pilar 2. Conceptual basis: Tulving episodic memory; RAG (Lewis et al. 2020).

### P2-INV-1: Every utterance has non-empty provenance

**Name:** `utterance-provenance-non-empty`
**Package:** `packages/ai-agency`
**Test path:** `packages/ai-agency/tests/memory/provenance.test.ts`
**Claim:** Every generated utterance object must have `provenance: ChatFragment["id"][]` with at least one entry. An empty array is treated as an alucinación and must not pass silently.

**How to measure:** Generate 50 utterances from a mock `EpisodicMemory` backed by synthetic fixtures. Assert `provenance.length >= 1` for all.

**Anti-pattern to catch:** An utterance builder that sets `provenance: []` as a default or simply omits the field.

---

### P2-INV-2: Voice attribution does not cross-contaminate

**Name:** `voice-author-not-contaminated`
**Package:** `packages/ai-agency`
**Test path:** `packages/ai-agency/tests/memory/voice-separation.test.ts`
**Claim:** When `recall` is called with `filter: { author: "steven" }`, all returned fragments have `author === "steven"`. The voice of Steven must never return Isa's fragments untagged as a citation.

**How to measure:** Populate synthetic fixture store with 50 "steven" and 50 "isa" fragments. Call `recall("anything", 10, { author: "steven" })`. Assert all returned have `author === "steven"`.

**Anti-pattern to catch:** A `recall` implementation that ignores the `filter` argument.

---

### P2-INV-3: Fragment usage entropy stays above threshold

**Name:** `recall-entropy-above-floor`
**Package:** `packages/narrative`
**Test path:** `packages/narrative/tests/rag/recall-entropy.test.ts`
**Claim:** In a session of 100 recall calls, the entropy of the fragment-id usage distribution must exceed `H_min = 2.0` nats. A collapsing distribution (always returning the same top-K) signals caricature.

**How to measure:** Inject a seeded mock embedder. Run 100 queries with `seedFor("P2-INV-3-entropy")`. Compute Shannon entropy of fragment hit counts. Assert `H >= 2.0`.

**Anti-pattern to catch:** A cosine-similarity ranker that always returns the global top-3 fragments regardless of query.

---

## Pilar 3 — Homeostasis visible

Source: `four-pillars.md` §Pilar 3. Conceptual basis: Damasio (2003); Cannon (1929).

### P3-INV-1: Homeostasis step is a contraction toward setpoint under high bond

**Name:** `homeostasis-convergence-high-bond`
**Package:** `packages/sim-core`
**Test path:** `packages/sim-core/tests/homeostasis/convergence.test.ts`
**Claim:** With `bond.coupling ≈ 1.0` and a perturbation added to physiology, `‖p_{t+1} - sp‖ ≤ ‖p_t - sp‖`. The system is a contraction mapping in the `bond → 1` regime.

**How to measure:** Perturb heartRate to 150 (setpoint is 72). Run 100 ticks with `coupling = 0.95`. Assert `|heartRate - 72|` is monotonically non-increasing (allowing for seed-controlled noise up to ±2 BPM).

**Anti-pattern to catch:** A homeostasis `step` that applies a lerp purely as cosmetic — if removing the call doesn't change `energy` or `mood` values after 100 ticks, the step is decorative.

---

### P3-INV-2: Setpoint shifts into dysphoric zone when bond is low

**Name:** `setpoint-dysphoric-shift-under-disconnection`
**Package:** `packages/sim-core`
**Test path:** `packages/sim-core/tests/homeostasis/setpoint-shift.test.ts`
**Claim:** The mapping `sp = g(bond)` is continuous and monotone: lower bond → lower `mood` setpoint, more unstable `heartRate` setpoint. Verified at three bond levels: 0.9, 0.5, 0.1.

**How to measure:** Compute effective setpoint at each bond level via `g(0.9)`, `g(0.5)`, `g(0.1)`. Assert `mood(g(0.9)) > mood(g(0.5)) > mood(g(0.1))` and `heartRateStability(g(0.9)) > heartRateStability(g(0.1))`.

**Anti-pattern to catch:** A `SetPoint` object computed once at world creation and never updated as bond changes. The setpoint must be dynamic.

---

### P3-INV-3: Physiology drives animation — no animation defines its own physics

**Name:** `animation-reads-physiology-not-vice-versa`
**Package:** `apps/web` (architecture invariant, not a runtime test)
**Test path:** `packages/sim-core/tests/homeostasis/no-physics-in-renderer.test.ts`
**Claim:** `HomeostasisComponent` is written only by `sim-core` systems. No animation or Phaser component writes to it directly.

**How to measure:** Type-level test using TypeScript `satisfies` constraints. Additionally a grep check in CI: `grep -r "HomeostasisComponent" apps/web/src` must return zero results that include a write/mutation pattern.

**Anti-pattern to catch:** A Phaser sprite that sets `heartRate` directly based on a sprite animation frame.

---

### P3-INV-4: Cross-entity heart-rate correlation under proximity

**Name:** `cross-entity-heartrate-correlation`
**Package:** `packages/sim-core`
**Test path:** `packages/sim-core/tests/scenarios/co-regulation.test.ts`
**Claim:** When both entities are in interaction range for 200 ticks, the Pearson correlation of their `heartRate` time series exceeds `ρ_min = 0.6`. Models physiological co-regulation.

**How to measure:** Seed: `seedFor("P3-INV-4-coregulation")`. Place entities in range. Collect `heartRate` per tick for both. Compute Pearson r. Assert `r >= 0.6`.

**Anti-pattern to catch:** Two independent heart-rate oscillators that never synchronize regardless of bond or proximity.

---

## Pilar 4 — Agencia emergente real

Source: `four-pillars.md` §Pilar 4. Conceptual basis: Barandiaran et al. (2009) three conditions; Friston active inference (optional).

### P4-INV-1: Policy is individuated — steven's policy !== isa's policy in outputs

**Name:** `policy-individuated`
**Package:** `packages/ai-agency`
**Test path:** `packages/ai-agency/tests/decision/individuation.test.ts`
**Claim:** Given the same world state (identical `self`, `phys`, `bond`, `belief`), `policy_steven.sample(...)` and `policy_isa.sample(...)` produce different action distributions over 1000 samples. KL divergence between the two distributions exceeds `KL_min = 0.1` nats.

**How to measure:** Seed: `seedFor("P4-INV-1-individuation")`. Construct identical world slices for both. Sample 1000 actions per policy. Compute empirical action-type distributions. Assert `KL(steven || isa) >= 0.1`.

**KL reference (philosophy-research):** `four-pillars.md` property test "No-determinismo significativo" uses KL divergence between trayectoria distributions — this invariant applies KL at the single-step action distribution level.

**Anti-pattern to catch:** A single `Policy` class instantiated twice with the same weights. If `policy_steven` and `policy_isa` share a parameter object reference, this test will catch it.

---

### P4-INV-2: Action selection maintains minimum entropy (no script collapse)

**Name:** `action-entropy-above-floor`
**Package:** `packages/ai-agency`
**Test path:** `packages/ai-agency/tests/decision/entropy-floor.test.ts`
**Claim:** In a non-trivial world state (entity alive, bond in [0.3, 0.7], energy in [0.4, 0.8]), the entropy `H` of the action distribution returned by `policy.sample` must satisfy `H >= H_min = 0.5` nats. Precludes deterministic FSM behavior.

**How to measure:** Seed: `seedFor("P4-INV-2-entropy")`. Sample action distribution 500 times. Compute Shannon entropy on action kinds. Assert `H >= 0.5`.

**Anti-pattern to catch:** A `sample` that always returns `argmax(utility)` with probability 1, yielding `H = 0`.

---

### P4-INV-3: Memory ablation changes action distribution

**Name:** `memory-ablation-changes-policy`
**Package:** `packages/ai-agency`
**Test path:** `packages/ai-agency/tests/decision/memory-ablation.test.ts`
**Claim:** Ablating `EpisodicMemory.recall` (returning empty array) changes the action distribution in magnitude `> δ = 0.15` KL distance vs. the full-memory version. If memory doesn't change decisions, it is decorative.

**How to measure:** Seed: `seedFor("P4-INV-3-ablation")`. Sample 500 actions with full memory and 500 with ablated memory (same RNG seed, same world state). Assert `KL(full || ablated) >= 0.15`.

**KL reference:** This directly maps to the `four-pillars.md` property test "Sensibilidad a memoria" measured by bootstrap statistical test.

**Anti-pattern to catch:** A policy that computes an action logit purely from `bond` and `energy` without conditioning on any memory fragment.

---

### P4-INV-4: Surprise predicts new memory formation

**Name:** `surprise-predicts-memory-formation`
**Package:** `packages/ai-agency`
**Test path:** `packages/ai-agency/tests/decision/surprise-memory.test.ts`
**Claim:** Actions with `logp < surprise_threshold` (unexpected) must trigger at least one `memory.remember()` call within the next 5 ticks more often than actions with `logp >= surprise_threshold`. Modeled as conditional probability: `P(remember | surprised) > P(remember | not-surprised) + 0.2`.

**How to measure:** Run a 500-tick simulation. Bucket ticks by whether the sampled action was "surprising". Compare `remember` call rates per bucket. Assert the conditional probability gap exceeds 0.2.

**Anti-pattern to catch:** A `remember` call that fires at a fixed cadence (every 10 ticks) regardless of surprise — that makes memory formation a clock, not a response to novelty.

---

## Cross-pillar invariants

### XP-INV-1: P1 x P3 — Disconnection disables homeostasis recovery

**Name:** `disconnection-disables-homeostasis`
**Package:** `packages/sim-core`
**Test path:** `packages/sim-core/tests/scenarios/pillar-cross-p1-p3.test.ts`
**Claim:** When `bond.coupling < bondLethalThreshold`, no `step(physiology, bond, setpoint, dt)` call can restore `energy` to above `0.5`. Homeostasis has no positive equilibrium without the other.

---

### XP-INV-2: P2 x P4 — Policy decisions are citable

**Name:** `decision-citation-trail`
**Package:** `packages/ai-agency`
**Test path:** `packages/ai-agency/tests/decision/citation-trail.test.ts`
**Claim:** Every `InteractAction` produced by `policy.sample` must have at least one retrievable `ChatFragment` with cosine similarity `> τ_provenance = 0.4` to the action payload. Decisions are citable.

---

## Wave-9 invariants — new systems from olas recientes

The following invariants were added after waves 6-8 introduced: day-phase homeostasis, the sleep system, landmark places, agent persistence, RAG dialogue prompts, and LLM backpressure control.

---

### INV-NEW-1: dayPhase advances monotonically

**Name:** `day-phase-monotone`
**Package:** `packages/sim-core`
**Test path:** `packages/sim-core/tests/invariants/day-phase-monotone.test.ts`
**Pilar:** Homeostasis visible (Pilar 3).
**Claim:** `dayPhase` never decreases between consecutive ticks (except at the legal 1→0 day-cycle wrap). It is always `∈ [0, 1)` and never `NaN` or `Infinity`. A monotone phase is the backbone of circadian modulation of energy and mood.

**Anti-pattern to catch:** A refactor of `advanceClock` that resets `dayPhase` to 0 on every tick instead of computing it from `simulatedMs`. A modular arithmetic bug that produces values outside `[0, 1)`.

---

### INV-NEW-2: Sleep restores energy

**Name:** `sleep-restores-energy`
**Package:** `packages/sim-core`
**Test path:** `packages/sim-core/tests/invariants/sleep-restores-energy.test.ts`
**Pilar:** Homeostasis visible (Pilar 3).
**Claim:** An entity sleeping for N ticks has strictly more energy than an identical entity that stayed awake for the same N ticks. Energy during sleep is monotonically non-decreasing. Energy on wake (reason=energyFull) is >= `sleepWakeThreshold` (0.9).

**Anti-pattern to catch:** `energyRestorePerTick` set to 0 in a config refactor. Homeostasis applying decay after restore and negating the sleep benefit. Sleep system failing to remove `SleepingComponent` so the entity never wakes.

---

### INV-NEW-3: Persisted agents remember past episodes

**Name:** `persisted-agents-remember-episodes`
**Package:** `packages/ai-agency`
**Test path:** `packages/ai-agency/tests/invariants/persisted-agents-remember-episodes.test.ts`
**Pilar:** Conversaciones reales como semilla (Pilar 2) + Agencia emergente (Pilar 4).
**Claim:** After `serialiseAgent` → `deserialiseAgent`, the recovered agent's `EpisodicBuffer` contains: (a) the exact same episode count, (b) all original event kinds (encounter, converse, separation), (c) the same top-k events as before serialisation, and (d) the same `payload` objects.

**Anti-pattern to catch:** `parseEpisodicMemory` swallowing valid entries on minor field type mismatch. `serialiseAgent` omitting the `payload` field. High-intensity events being evicted before low-intensity events (eviction priority inversion).

---

### INV-NEW-4: Utterance variety with RAG > without RAG

**Name:** `utterance-variety-rag`
**Package:** `packages/ai-agency`
**Test path:** `packages/ai-agency/tests/invariants/utterance-variety-rag.test.ts`
**Pilar:** Conversaciones reales como semilla (Pilar 2).
**Claim:** The unique-prompt ratio of `buildDialoguePrompt` calls with varied RAG fragments exceeds the ratio without RAG by at least 0.15. RAG fragment content must appear in the system prompt. 30 distinct fragments must produce >= 0.8 unique-prompt ratio.

**Anti-pattern to catch:** `buildDialoguePrompt` ignoring the injected `store`. `renderInspirationBlock` producing identical output for all fragments. The `VectorStore.search()` mock always returning the same top fragment regardless of query.

---

### INV-NEW-5: MomentDetector emits no false positives in a static world

**Name:** `moment-detector-no-false-positives`
**Package:** `packages/sim-core`
**Test path:** `packages/sim-core/tests/invariants/moment-detector-no-false-positives.test.ts`
**Pilar:** Agencia emergente (Pilar 4).
**Claim:** A static world (two separated entities, no actions, bond decaying slowly) produces zero `MomentDetected` events over 500 ticks. Moments must be gated by genuine state changes, not by tick count.
**Status:** `it.skip` until `MomentDetectedEvent` is exported from `@carta/sim-core` (TODO ola-9). The regression guard sub-test (unknown event kinds) runs unconditionally.

**Anti-pattern to catch:** A detector that fires on every tick. A detector that fires on "first tick" unconditionally. Zero-threshold configuration that makes any observation trigger a moment.

---

### INV-NEW-6: dayPhase in snapshot persists through serialise/deserialise

**Name:** `day-phase-serialization`
**Package:** `packages/sim-core`
**Test path:** `packages/sim-core/tests/invariants/day-phase-serialization.test.ts`
**Pilar:** Homeostasis visible (Pilar 3) + Agencia emergente (Pilar 4).
**Claim:** After `serialise(world)` → `deserialise(json)`, the recovered world's `clock.dayPhase`, `clock.tick`, `clock.simulatedMs`, and `clock.dayLengthMs` are identical to the original. One additional tick on the recovered world produces the same `dayPhase` as on the original. The clock hash is identical.

**Anti-pattern to catch:** `deserialise` silently resetting `dayPhase` to 0 because the validator only checks `clock.tick`. A Map/Set-encoding refactor that drops the clock fields. The recovered world recomputing `dayPhase` from a reset tick counter.

---

### INV-NEW-7: Landmarks do not protect from death-by-disconnection

**Name:** `landmarks-no-death-effect`
**Package:** `packages/sim-core`
**Test path:** `packages/sim-core/tests/invariants/landmarks-no-death-effect.test.ts`
**Pilar:** Death by disconnection (Pilar 1).
**Claim:** An entity isolated inside a `MeetingPlace` landmark still dies at the same tick as an identical entity with no landmark present. Landmarks affect only bond GAIN between two co-located entities; they must never suppress bond DECAY or reset `ticksBelowBondThreshold`.

**Anti-pattern to catch:** `runPlaces` applying a bond gain to a single entity inside a `MeetingPlace` (the bonus requires TWO entities). A homeostasis PR that reads landmark proximity to reset the disconnection counter. A `MeetingPlace` setting `alive = true` or resetting `ticksBelowBondThreshold` directly.

---

### INV-NEW-8: Backpressure does not cause deadlock with a slow LLM

**Name:** `backpressure-no-deadlock`
**Package:** `packages/ai-agency`
**Test path:** `packages/ai-agency/tests/invariants/backpressure-no-deadlock.test.ts`
**Pilar:** Agencia emergente (Pilar 4).
**Claim:** When `LLM_MAX_INFLIGHT` requests are in flight, excess calls reject IMMEDIATELY with `LLMUnavailableError{reason:"backpressure"}` — not after a timeout. After all in-flight requests complete, `currentInflight()` returns 0 (no counter leak). Network errors on unavailable LLM also do not leak the counter.

**Anti-pattern to catch:** A future refactor wrapping the backpressure check in a queue instead of immediate rejection — the queue would grow unboundedly. `currentInflight()` never returning to 0 after in-flight requests complete. A timeout race resolving `undefined` instead of rejecting.

---

## Tooling rules for code reviewers

The `code-reviewer` agent must reject PRs that:

1. Add or modify a system in `packages/sim-core/src/systems/` without updating `packages/sim-core/tests/` with at least one invariant test.
2. Remove or weaken the `bondDecayPerTick > 0` check anywhere in the lifecycle or interaction systems.
3. Introduce `Date.now()` or unseeded `Math.random()` in any `tests/**` directory.
4. Change a snapshot hash (any `.snap` file or `hashState` assertion) without a comment in the PR body explaining the behavioral change and its justification in terms of the four pillars.
5. Add a `Policy` implementation that shares state between "steven" and "isa" policy instances.
6. Add animation logic to `apps/web/` that directly mutates `HomeostasisComponent` fields.
7. Modify `runPlaces` to apply bond gain to a single entity inside a `MeetingPlace` (INV-NEW-7).
8. Set `energyRestorePerTick = 0` or `bondDecayPerTick = 0` in any world config without a test proving the downstream invariant still holds (INV-NEW-2, P1-INV-1).
9. Change `LLMClient` backpressure handling from immediate rejection to a queue without explicit approval of the deadlock-risk analysis (INV-NEW-8).
10. Add a `gaze`/`touch`/`wave` action handler that emits its event on every proximity tick without checking for an explicit action submission (INV-IV-2).
11. Implement sequenced utterances using the `---` delimiter as literal text in the spoken output rather than splitting on it (INV-IV-7).
12. Implement season computation using `Date.now()` or any non-deterministic time source (INV-IV-8).

---

## Ola IV invariantes — nuevos sistemas de la cuarta ola

The following invariants were added after Ola IV introduced: φ-proxy integrated agency, gaze/touch/wave signals, persistent dreams in episodic memory, shared-moment detection via semantic intersection, distress-modulated softmax entropy, failed-pattern backoff, sequenced utterances from delimited LLM output, deterministic season advancement, and halo personality.

---

### INV-IV-1: Agencia integrada — φ-proxy KL ≥ 0.15 (integrated vs partitioned)

**Name:** `phi-proxy-kl-threshold`
**Package:** `packages/ai-agency`
**Test path:** `packages/ai-agency/tests/invariants/phi-proxy-kl.test.ts`
**Pilar:** Agencia emergente real (Pilar 4).
**Claim:** Running 200 ticks with seed `seedFor("INV-IV-1-phi-proxy")`, the KL divergence between the joint action-distribution of the full coupled system (both agents perceiving each other) versus a partitioned system (each agent sees `partnerPresent: false`) must be ≥ 0.15 nats. If KL < 0.15, the utility function is effectively scriptless with respect to the partner — Pillar 1 coupling is decorative.

**How to measure:** Sample 200-tick decide() trajectories under both conditions. Compute empirical action-kind distributions. Assert `KL(full || partition) >= 0.15`.

**Measured value (2026-05-17):** KL = 9.64 nats (200-tick CLI run via `scripts/validate/phi-measure.ts --ticks 200`) and KL = 10.7 nats (5-agent × 200-tick integration test from `phi-proxy.test.ts`). Both far above the 0.15 threshold.

**Anti-pattern to catch:** A utility function that scores bond-satisfying actions identically whether or not a partner is present. The "bond-deficit emergency" multiplier in `utility.ts` is the load-bearing mechanism — if removed or guarded behind a flag, KL collapses.

---

### INV-IV-2: Gaze/touch/wave generan eventos correctos sin falsos positivos

**Name:** `gaze-touch-wave-emit-events`
**Package:** `packages/sim-core`
**Test path:** `packages/sim-core/tests/invariants/gaze-touch-wave-events.test.ts`
**Pilar:** Homeostasis visible (Pilar 3) + Agencia emergente (Pilar 4).
**Claim:** For each of the three proxemic actions (gaze, touch, wave), triggering the action emits exactly one event of the matching kind in the event log. Actions that were NOT taken produce zero events of those kinds. No cross-contamination between kinds.

**How to measure:** The regression guard (unconditional) runs 100 ticks on a close-proximity world with no actions and asserts zero `EntityGazed`, `EntityTouched`, `EntityWaved` events. The full integration test (skipped pending public ActionKind export) submits each action and asserts one matching event.

**Anti-pattern to catch:** An intentions system that emits gaze events on every tick when entities are close, without an explicit gaze action being submitted.

---

### INV-IV-3: Sueños persisten en memoria episódica — 5 sueños → 5 episodios `dreamed`

**Name:** `dreams-persist-in-episodic-memory`
**Package:** `packages/ai-agency`
**Test path:** `packages/ai-agency/tests/invariants/dreams-persist-episodic.test.ts`
**Pilar:** Conversaciones reales como semilla (Pilar 2).
**Claim:** After an agent sleeps 5 times, the episodic buffer retains at least 5 events with `payload.type === "dreamed"`. High-intensity dream events (intensity=0.9) are not evicted even when the buffer also contains lower-intensity encounter events. The payload is preserved through recall.

**How to measure:** Call `memory.remember` 5 times with `kind: "custom"`, `intensity: 0.9`, `payload: { type: "dreamed" }`. Assert `recall(64)` contains ≥ 5 dreamed events.

**Anti-pattern to catch:** An `EpisodicBuffer` that silently drops events whose `payload` field is non-null. A sleep integration that records the dream result as a non-episodic log event instead of `memory.remember`.

---

### INV-IV-4: Recuerdo compartido emerge de intersección semántica

**Name:** `shared-moment-from-semantic-intersection`
**Package:** `packages/ai-agency` (consolidation logic) + `services/realtime` (service-layer detection)
**Test paths:**
  - `packages/ai-agency/tests/invariants/shared-moment-semantic.test.ts` — tests `consolidateSemantic` producing weight ≥ 0.7 facts after 10 encounter episodes, monotone weight scaling, below-threshold guard, and stability under zero new episodes.
  - `services/realtime/tests/shared-memory.test.ts` — tests `detectSharedMemoryMoment` firing `recuerdo_compartido` when both agents have weight ≥ 0.7 (exact threshold included), cooldown suppression within `RECUERDO_COOLDOWN_TICKS`, re-fire after cooldown, negative cases (one agent below threshold, empty memory, missing agent), and meta block contents.
**Pilar:** Agencia emergente real (Pilar 4) + Conversaciones reales (Pilar 2).
**Claim:** When both agents have enough episodic evidence, `consolidate` produces `knows-partner-exists` with weight ≥ 0.7 for each agent independently. Weight scales monotonically with episode count (min=3, full at 10). The fact survives consolidation with zero new episodes (semantic stability invariant). At the service layer, `detectSharedMemoryMoment` emits a `recuerdo_compartido` Moment when and only when both agents' semantic memory carries a shared fact kind at weight ≥ 0.7, subject to a cooldown of `RECUERDO_COOLDOWN_TICKS` (3000 ticks ≈ 60 simulated seconds).

**How to measure:** Seed each agent's episodic buffer with 10 encounter events at intensity=0.8. Assert `consolidate` returns `knows-partner-exists:<partnerId>` with weight ≥ 0.7 for both. Assert that re-consolidating with empty episodes preserves the fact. For the service layer, pass hand-crafted `SemanticMemory` objects directly to `detectSharedMemoryMoment` and assert the moment fires (or is suppressed) as expected.

**Anti-pattern to catch:** A `consolidate` call that fails to produce the fact when only 3 of the required 10 events are in the window (threshold check). A `partnerScopedKind` bug that scopes the fact to the wrong id. A `detectSharedMemoryMoment` refactor that lowers the threshold below 0.7 or removes the cooldown gate.

---

### INV-IV-5: Distress alto reduce entropía softmax — acciones más concentradas

**Name:** `distress-reduces-softmax-entropy`
**Package:** `packages/ai-agency`
**Test path:** `packages/ai-agency/tests/invariants/distress-entropy.test.ts`
**Pilar:** Homeostasis visible (Pilar 3) + Agencia emergente (Pilar 4).
**Claim:** With bond drive at 0.01 (distress ≈ 0.8), the softmax action distribution has LOWER Shannon entropy than with healthy drives (distress ≈ 0). The entropy difference must exceed 0.1 nats. Social actions (approach/embrace/interact) must collectively hold more probability mass than all other actions combined.

**How to measure:** Compute `scoreActions` + `softmaxDistribution` for (a) healthy drives and (b) bond=0.01. Assert `H(distress=0) > H(distress=0.8)` and `H(healthy) - H(distressed) > 0.1 nats`.

**Anti-pattern to catch:** A softmax temperature that is fixed and ignores the current drive state — entropy collapse under distress depends on the score spread driven by the bond-deficit emergency multiplier.

---

### INV-IV-6: ≥3 failedPatterns reducen T efectiva en 10%

**Name:** `failed-patterns-reduce-temperature`
**Package:** `packages/ai-agency`
**Test path:** `packages/ai-agency/tests/invariants/failed-patterns-temperature.test.ts`
**Pilar:** Agencia emergente real (Pilar 4).
**Claim:** When an agent has accumulated ≥ 3 consecutive LLM-failed-pattern markers, the effective softmax temperature is at least 10% lower than baseline. This is defined as `T_effective = T_baseline * 0.9` when `failedPatterns >= 3`. A lower T produces lower entropy and higher confidence on the argmax action.

**How to measure:** The reference implementation test verifies the math: `effectiveTemperature(baseT, 3) === baseT * 0.9`. The integration test (skipped) verifies the production code applies this reduction.

**Anti-pattern to catch:** A failed-pattern counter that resets on every tick instead of accumulating. A temperature modifier that applies a multiplier of 1.0 (identity) regardless of failure count.

---

### INV-IV-7: Conversación secuenciada produce N utterances escalonadas

**Name:** `sequenced-utterance-produces-n-delayed`
**Package:** `packages/ai-agency`
**Test path:** `packages/ai-agency/tests/invariants/sequenced-utterances.test.ts`
**Pilar:** Conversaciones reales (Pilar 2) + Agencia emergente (Pilar 4).
**Claim:** The reference `splitSequencedUtterance("a --- b --- c")` returns `["a", "b", "c"]` (3 segments). The `---` delimiter separates utterances; trailing delimiters produce empty segments that are stripped. The production code (once implemented) must schedule each segment as a separate `PendingUtterance` consumed on sequential ticks.

**How to measure:** Unit tests on the reference splitter. Integration test (skipped) verifies 3 speak actions polled across 3 ticks.

**Anti-pattern to catch:** An implementation that emits all three speak actions in the same tick. An implementation that uses the raw `---` string as part of the utterance text.

---

### INV-IV-8: Estaciones avanzan monotónicamente y son deterministas dado day count

**Name:** `seasons-advance-monotonically`
**Package:** `packages/sim-core`
**Test path:** `packages/sim-core/tests/invariants/seasons-monotone.test.ts`
**Pilar:** Homeostasis visible (Pilar 3).
**Claim:** `seasonFor(d)` is a pure function returning one of `{ spring, summer, autumn, winter }`. The 4-season sequence never skips a season. Each season spans exactly 90 days in a 360-day cycle. Season transitions are always forward (spring→summer→autumn→winter→spring). Negative day counts wrap correctly.

**How to measure:** Test all boundary values (0, 90, 180, 270, 360). Test a full 360-day run (each season appears exactly 90 times). Verify the sequence is monotone.

**Anti-pattern to catch:** A season implementation that uses `Date.now()` to determine the current season. A 3-season implementation. A season that reverses during a simulated run.
