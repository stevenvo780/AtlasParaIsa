# Moments System

**Module**: `packages/sim-core/src/systems/moments.ts`
**Type**: `packages/sim-core/src/types/moment.ts`
**Tests**: `packages/sim-core/tests/systems/moments.test.ts`

## What it does

The moments system detects heuristically significant relational events from the delta between two consecutive world states. It runs as step 7 in the tick pipeline, after lifecycle, so it sees the final settled state.

Output: `Moment[]` — each moment has a kind, tick, intensity, and entity list.

## Pipeline position

```
intentions → interaction → places → homeostasis → sleep → lifecycle → moments
```

`detectMoments(prevWorld, world, dt, events)` is a pure function. Same inputs → same outputs.

## The ten canonical kinds

Defined by letter-curator in `docs/voice/moments.md`.

| Kind | Trigger condition |
|------|-------------------|
| `encuentro_inesperado` | Entities go from > 200 wu apart to < 100 wu, with BondGained >= 0.05 this tick |
| `despedida_cotidiana` | dayPhase crosses into [0.5, 0.6) for the first time (dusk entry) |
| `silencio_compartido` | Both entities < 100 wu, no utterances in 500 ticks, bond > 0.5 |
| `reconciliacion` | Bond crosses warn threshold (0.25) upward after > 1000 ticks below |
| `reconocimiento_mutuo` | Both entities receive BondGained in the same tick with notable gain (> 1.5x bondGainPerTick) |
| `perdida_temporal_de_vista` | Entity was inside interaction radius last tick, now > 2x radius away |
| `reanudacion_del_cuerpo` | EntityWokeUp event fires for a protagonist |
| `amanecer_juntos` | dayPhase crosses 0.25 upward, both entities within 200 wu |
| `secreto_confesado` | EntityUttered matches confession regex patterns |
| `perdon` | BondGained for an entity that was at bond < 0.3 and bond < 0.2 just before |

## Intensity

`intensity ∈ [0, 1]` — computed from the magnitude of the triggering delta. Used by frontend-renderer to scale the visual/audio reaction.

## Event emission

Each detected `Moment` also emits a `MomentDetected` `SimEvent` into the tick event log, so the frontend can react via the delta stream without waiting for the next snapshot.

## World state

`World.recentMoments` is a ring buffer (capacity 50) of the most recent Moments. Also exposed via `Snapshot.recentMoments`.

## Determinism

`detectMoments` uses no RNG. It reads world state deltas and event lists, which are themselves deterministic under seed. Same seed → same moment sequence.

## False-positive protection

Detectors are conservative:
- Thresholds are explicit constants in `MOMENT_THRESHOLDS`
- `silencio_compartido` fires at most once every 500 ticks per episode
- `reconocimiento_mutuo` requires gain > 1.5x normal proximity rate
- `perdon` requires bond was notably low (< 0.2) immediately before the gain

## Coordination

- **frontend-renderer**: listens for `MomentDetected` in the delta stream; `moment.kind` selects the visual reaction, `moment.intensity` scales it
- **letter-curator / narrative-curator**: polls `Snapshot.recentMoments` for story generation
- **backend-realtime**: serialises `recentMoments` as part of the Snapshot payload
