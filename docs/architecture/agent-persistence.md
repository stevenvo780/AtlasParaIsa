# Agent Persistence — Architecture

## Motivation

Without persistence, the agents that embody Steven and Isa start every server
boot as strangers. Every restart is a Día Cero — an entity that built 10 hours
of shared memory yesterday wakes up with nothing. This is the opposite of the
autopoiesis the project aims for.

The world state (ECS components) was already persisted by `ola A1`.
This document covers the complementary layer: **agent state persistence**
(episodic memory, drives, personality, and LLM trigger cooldowns).

---

## What is persisted

| Field                    | Location          | Rationale                                             |
|--------------------------|-------------------|-------------------------------------------------------|
| `id`                     | `agents.json`     | Identity — maps back to ECS entity                    |
| `seed`                   | `agents.json`     | Required to reconstruct the RNG deterministically     |
| `personality`            | `agents.json`     | Four axes (warmth, curiosity, restlessness, patience) |
| `drives[]`               | `agents.json`     | Current homeostatic values; preserve somatic state    |
| `episodicMemory[]`       | `agents.json`     | Events with weights — the agent's lived experience    |
| `alive`                  | `agents.json`     | Death state survives restart                          |
| `disconnectionSeconds`   | `agents.json`     | Partial disconnection accumulation survives restart   |
| LLM trigger states       | `agents.json`     | Cooldown history; prevents immediate re-invocation    |

## What is NOT persisted

| Field    | Reason                                                                         |
|----------|--------------------------------------------------------------------------------|
| `rng`    | Reconstructed from `(seed, id)`. Persisting state would couple restarts to the exact tick count, making tests non-deterministic. |
| `policy` | A runtime object (UtilityPolicy or ChainPolicy). Reconstructed by the loop bootstrap with the same config. |
| `affect` | Always re-derived from `drives` on load. This ensures self-consistency even if the affect formula changes between schema versions without bumping the schema version. |

---

## File layout

```
STATE_DIR/
  snapshot.json        — world state (ECS)
  snapshot.json.tmp    — in-progress write (deleted on completion)
  agents.json          — all agent states + LLM trigger states
  agents.json.tmp      — in-progress write (deleted on completion)
  wal.jsonl            — per-tick event log (world events only)
```

Both `snapshot.json` and `agents.json` use the same atomic write protocol:
write to `.tmp` → `fsync` → POSIX `rename` (atomic on Linux/macOS).

---

## Failure policy

### If `agents.json` is missing (first boot / deleted)

`loadAgents` returns `null`. The loop calls `createAgentsForWorld` to build
fresh agents. The simulation runs as it did before agent persistence was added.
No error is raised.

### If `agents.json` is corrupt (invalid JSON, wrong fileVersion)

Same as missing: `null` → fresh agents. A `WARN` log explains the reason.

### If `snapshot.json` (world) is present but `agents.json` is corrupt

**World continuity takes priority.** The world is loaded at tick N. The agents
are recreated fresh. The entities will not remember the previous session, but
the physics (positions, bond values, homeostasis) are intact. A `WARN` log
explains the loss. This is the correct tradeoff: agents are reconstructable,
world geometry is not.

### If individual agent fields are corrupt (partial corruption)

`deserialiseAgent` applies field-level defaults. Each field is parsed
independently; a bad `drives` array falls back to `makeDefaultDrives()` without
discarding valid `personality` or `episodicMemory` fields. No exception is
ever raised from deserialiseAgent.

### If `saveAgents` fails (disk full, permissions, etc.)

The error is logged at ERROR level, but the loop continues. The next periodic
snapshot will retry. On graceful shutdown, the error is also logged but the
process exits cleanly. Mission continuity > durability of a single save.

---

## Schema versioning

`SerialisedAgent.schemaVersion` is `1` (CURRENT_SCHEMA_VERSION in
`packages/ai-agency/src/persistence.ts`). If a breaking change to the
serialised shape is needed, increment the version. On load, any version
mismatch causes a full fallback to fresh defaults + WARN log.

Non-breaking changes (adding optional fields, changing computation formulas)
do NOT require a version bump.

---

## LLM trigger state persistence

The `AgentTriggerState` stored inside `LLMPolicy.triggerState` tracks:

- `lastInvokeMs` — last simulated ms at which the LLM was invoked
- `lastSpokeMs` — last simulated ms at which the LLM produced an utterance
- `baselineValence`, `baselineDistress` — affect baseline for swing detection
- `lastPartnerDistance` — last observed distance for proximity-crossing

If the trigger state is not restored (missing, corrupt), the agent starts
cooldown from scratch. This is acceptable and logged at INFO (not WARN) — the
agent may speak slightly sooner than it would have. It is NOT an error.

Restoration is done in `startLoop` after the LLMPolicy is created:

```ts
if (llmPolicy !== null && triggerStates.size > 0) {
  for (const [entityId, state] of triggerStates) {
    llmPolicy.restoreTriggerState(entityId, state);
  }
}
```

---

## Episodic memory continuity

`EpisodicBuffer.snapshot()` returns `(event, weight)` pairs. We persist both.
On restore, `buffer.remember()` re-inserts the events. The saved weight is
not directly injected (there is no internal `restore(event, weight)` hook),
so weights are recomputed from `intensity`. This means:

- **Faded memories come back slightly brighter** after a restart. The weight
  resets from `0.2 + 0.8 * intensity` instead of the decayed value.
- This is acceptable for the project's goals: the important thing is that
  the memory EXISTS, not that its weight is exact.

### Future improvement (marked as TODO in episodic.ts)

Add `EpisodicBuffer.restore(event, weight)` to allow exact weight
preservation. This would require exposing internal state from `EpisodicBuffer`
but would give perfect continuity of the forgetting curve across restarts.

---

## Periodic save timing

Agents are saved every `SNAPSHOT_TICKS` (~900 ticks ≈ 30 s at 30 Hz),
alongside the world snapshot. The saves are fire-and-forget from the tick loop
(no blocking).

On graceful shutdown (SIGTERM/SIGINT):
1. Loop stops.
2. World snapshot is saved (awaited).
3. Agent states are saved (awaited via `saveAgents`).
4. Connections close.
5. Process exits 0.

---

## Plan for future olas

### Corpus-acquired knowledge

The agent currently learns only from lived events (episodic memory). In a
future ola, the agent could acquire knowledge from the RAG corpus
(narrative/voice) in a session-persistent way — e.g. which conversation
fragments emotionally resonated. This would live in a separate
`semanticMemory` field in `SerialisedAgent` and would require coordination
with `simulation-engineer` and `narrative-curator`.

### Postgres migration

If the file-based storage becomes a bottleneck (multiple writers, replication,
metrics queries), migrate to Postgres. The serialised format is JSON-safe and
maps directly to a JSONB column. Coordinate with `devops-vercel`.

### Versioned snapshots

Currently each save overwrites the previous `agents.json`. A future improvement
would keep a rolling window of N versions (agents.json.1, agents.json.2, ...)
so that a corrupt save can be rolled back without losing the entire history.
