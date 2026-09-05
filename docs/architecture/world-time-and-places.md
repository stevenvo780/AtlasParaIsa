# World Time and Places

## Overview

The world now has a **day-night cycle** and two **semantic locations**. These are the answers to the autocritique: "para Isa no hay marcador de *esto está pasando ahora mientras me lees*." The calendar exists now — not as a UI gadget, but as a physical property of the simulation that every system reads.

---

## WorldClock and dayPhase

### Schema

```typescript
interface ClockState {
  tick: number;
  simulatedMs: number;
  paused: boolean;
  dayPhase: number;      // [0, 1) — position in the current simulated day
  dayLengthMs: number;   // configurable; default 30 real minutes per day
}
```

### How dayPhase advances

```
dayPhase = (simulatedMs mod dayLengthMs) / dayLengthMs
```

At 50 Hz (20 ms per tick), with `dayLengthMs = 1,800,000 ms` (30 real minutes):
- One full day = 90,000 ticks.
- dayPhase increases by `20 / 1,800,000 ≈ 0.0000111` per tick.
- It wraps cleanly at 1.0 → 0.0 every 30 real minutes.

`dayPhase` is computed inside `advanceClock` and stored in the ClockState so snapshots carry it and replays are deterministic.

### Phase bands

| Band | dayPhase range | Predicate | Meaning |
|------|---------------|-----------|---------|
| Predawn/night | [0, 0.125) or [0.75, 1) | `isNight` | Fatigue increases; entities should sleep |
| Dawn | [0.125, 0.25) | `isDawn` | Transition; energy begins recovering |
| Day | [0.25, 0.55) | `isMidday` | Peak activity; mood drift reduced |
| Dusk | [0.55, 0.75) | `isDusk` | Transition toward night |

Bands are **mutually exclusive** within their core range. The small gaps between bands (boundary ticks) belong to none and receive no special treatment — the simulation simply reads each predicate independently.

### Configuration

```typescript
interface TimeConfig {
  dayLengthMs: number;                 // default: 30 * 60 * 1000 (30 min real)
  nightEnergyDecayMultiplier: number;  // default: 2.0  (2x fatigue at night)
  middayMoodDecayMultiplier: number;   // default: 0.5  (half mood drift at noon)
}
```

Tuning `dayLengthMs`:
- `600_000` (10 min) — rapid cycling, useful for testing and demos.
- `1_800_000` (30 min, default) — a day passes while you are reading the letter.
- `7_200_000` (2 hours) — almost-real time; subtle, meditative.

---

## Homeostasis modifiers

### Night energy penalty

When `isNight(clock)` is true and the entity is **awake**:

```
energyDecay = cfg.energyDecayPerTick × nightEnergyDecayMultiplier × bondMultiplier
```

Default: `0.0001 × 2.0 = 0.0002` per tick at night. Still slow — after 500 ticks (10 seconds real) an entity loses 0.1 energy. The penalty is real but not punishing.

### Midday mood relief

When `isMidday(clock)` and `mood < 0` and `bond < bondWarnThreshold`:

```
moodDecay = moodDecayPerTick × (1 + deficit×2) × middayMoodDecayMultiplier
```

Default multiplier: 0.5. The midday light cuts mood deterioration in half when the entity is already distressed. Subtle. The bond deficit still matters — disconnection is not cancelled by daylight, only softened.

### Sleep energy restore

While the entity carries a `SleepingComponent`:

```
energyGain = energyRestorePerTick           (outside SleepPlace)
energyGain = energyRestorePerTick × 2.0     (inside SleepPlace radius)
```

Energy decay is suppressed entirely while sleeping. Night penalty does not apply to sleeping entities.

---

## SleepPlace component

```typescript
interface SleepPlaceComponent {
  kind: "SleepPlace";
  x: number;     // world-space position
  y: number;
  radius: number; // metres (world units)
}
```

**Semantic meaning**: "el rincón donde duermen." The place where they rest together.

**Effect**: sleeping entities within `radius` world-units of `(x, y)` restore energy at `energyRestorePerTick × sleepPlaceRestoreMultiplier` (default 2x). Awake entities in the same spot receive no bonus.

**Bootstrap position**: `(200, 800)`, radius `80`. In the default 1000×1000 world this is in the lower-left corner, a quiet edge.

### Frontend rendering

The frontend receives `SleepPlace` in the `Snapshot.landmarks` array:

```json
{
  "kind": "SleepPlace",
  "id": "sleep-place-1",
  "x": 200,
  "y": 800,
  "radius": 80
}
```

Suggested rendering: a soft, blurred circle at `(x, y)` with `radius`. Opacity ~0.15. Colour warm amber (rest). No label — the place is felt, not announced.

---

## MeetingPlace component

```typescript
interface MeetingPlaceComponent {
  kind: "MeetingPlace";
  x: number;
  y: number;
  radius: number;
  bondGainMultiplier: number; // default 1.5
}
```

**Semantic meaning**: "el patio donde se encuentran." The shared ground that amplifies connection.

**Effect**: when two entities with `Bondable + Lifecycle(alive)` are **simultaneously** inside the radius AND within each other's `interactionRadius` (proximity bonding is active), bond gain receives an additive bonus:

```
bonusA = bondableA.bondGainPerTick × (multiplier - 1)
```

Net gain at the MeetingPlace = `bondGainPerTick × multiplier` (1.5x default).

The bonus is only applied when proximity bonding is already active. Two entities standing in the courtyard but too far apart to interact do not receive the multiplier — the place amplifies closeness, it does not manufacture it.

**Bootstrap position**: `(500, 400)`, radius `100`. The centre of the world, slightly north of midpoint.

### Frontend rendering

Receives `MeetingPlace` in `Snapshot.landmarks`:

```json
{
  "kind": "MeetingPlace",
  "id": "meeting-place-1",
  "x": 500,
  "y": 400,
  "radius": 100,
  "bondGainMultiplier": 1.5
}
```

Suggested rendering: a barely-visible circle at `(x, y)`. Colour soft rose or blue. Opacity ~0.10. The world glows faintly where their stories happen.

---

## Sleep action and system

### SleepAction

```typescript
interface SleepAction {
  kind: "sleep";
  entityId: EntityId;
}
```

Produced by `ai-agency` when an entity decides to rest. The `intentions` system handles it:

1. If the entity has a `SleepingComponent` already → no-op (idempotent).
2. If the entity is dead → no-op.
3. Otherwise: adds `SleepingComponent { since: currentTick }` and emits `EntitySlept`.

While sleeping, `move` and `approach` actions are suppressed.

### Automatic waking (sleep system)

Runs after homeostasis, every tick:

```
if energy > sleepWakeThreshold (default 0.9) → wake
if (tick - sleeping.since) >= maxSleepTicks (default 1500) → wake
```

On waking: removes `SleepingComponent`, emits `EntityWokeUp { reason, energyOnWake }`.

### Configuration

```typescript
interface SleepConfig {
  sleepWakeThreshold: number;          // default: 0.9
  maxSleepTicks: number;               // default: 1500 (30s at 50Hz)
  sleepPlaceRestoreMultiplier: number; // default: 2.0
  meetingPlaceBondMultiplier: number;  // default: 1.5
}
```

---

## Snapshot and Delta wire format

### Snapshot additions

```typescript
interface Snapshot {
  // ... existing fields ...
  dayPhase: number;            // [0,1) — use 0.25 as default if absent
  landmarks: LandmarkInfo[];   // SleepPlace + MeetingPlace positions
}
```

`dayPhase` is included in every Snapshot **and** every Delta (so the frontend can update background tinting without waiting for the next full snapshot).

### Backward compatibility

Old snapshots that lack `dayPhase` and `landmarks` are valid. The frontend should:
- Default `dayPhase = 0.25` (midday) if the field is absent.
- Default `landmarks = []` if the field is absent.

The `deserialise` validator in `serialize.ts` accepts `dayPhase` and `dayLengthMs` as optional on the clock, and `time`/`sleep` as optional on the config. Old persisted worlds load cleanly; the day phase recomputes correctly from `simulatedMs` on the next tick.

---

## Execution order

```
intentions → interaction → places → homeostasis → sleep → lifecycle
```

- **intentions**: processes `sleep` action, suppresses movement for sleeping entities.
- **interaction**: proximity bond gain/decay.
- **places**: adds MeetingPlace bond bonus for co-located pairs.
- **homeostasis**: energy/mood/heartRate update — reads `clock` for night/midday predicates, reads `Sleeping` for restore vs. decay.
- **sleep**: checks waking conditions against the post-restore energy value.
- **lifecycle**: death check (unchanged).

---

## Tunable parameters

Steven can adjust these in `WorldConfig` passed to `createWorld`:

| Parameter | Location | Default | What it changes |
|-----------|----------|---------|-----------------|
| `dayLengthMs` | `config.time` | 1,800,000 | How long a day feels |
| `nightEnergyDecayMultiplier` | `config.time` | 2.0 | How much more tiring the night is |
| `middayMoodDecayMultiplier` | `config.time` | 0.5 | How much the light lifts the mood |
| `sleepWakeThreshold` | `config.sleep` | 0.9 | When sleeping ends naturally |
| `maxSleepTicks` | `config.sleep` | 1500 | Hard cap on sleep duration |
| `sleepPlaceRestoreMultiplier` | `config.sleep` | 2.0 | Bonus for sleeping in the corner |
| `meetingPlaceBondMultiplier` | `config.sleep` | 1.5 | Bonus for meeting in the courtyard |

The defaults are tuned to be **subtle**: a healthy interaction pace means the entities never exhaust. The night penalty and sleep system only matter when the entities are isolated or not paying attention. The parameters exist so the experience can be adjusted without touching logic.
