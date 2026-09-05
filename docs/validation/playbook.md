# Validation Playbook — Una Carta Para Isa

## Prerequisites — Playwright browsers

Before the first run of any e2e or screenshot validation, install the Playwright
browser binaries. This only needs to be done once per machine (or after a major
Playwright version bump):

```bash
# Install chromium and webkit (the two targets: Vercel/Chrome + Isa's iPhone/Safari)
npx playwright install chromium webkit

# Verify the installation resolved correctly
npx playwright --version
npx playwright test --list
```

On Ubuntu 25.x the webkit binary requires `libxml2.so.2` which the distro ships
as `libxml2.so.16`. If you see "cannot open shared object file: libxml2.so.2",
either install the system deps via:

```bash
sudo npx playwright install-deps
```

...or create a manual symlink (no sudo needed for the symlink itself):

```bash
ln -sf /lib/x86_64-linux-gnu/libxml2.so.16 /tmp/libxml2.so.2
# Then re-run playwright with LD_LIBRARY_PATH=/tmp
LD_LIBRARY_PATH=/tmp npx playwright test
```

If webkit remains unavailable, run chromium-only via:

```bash
npx playwright test --project=chromium
```

---

## Invoking the suite

```bash
# Full validation (90 s run + utterance analysis + screenshots)
bash scripts/validate/all.sh

# Shorter run for quick smoke test
bash scripts/validate/all.sh --seconds 30

# Skip screenshots (faster; use when Next.js is not available)
bash scripts/validate/all.sh --skip-screenshots

# Verbose output
bash scripts/validate/all.sh --verbose

# Custom port (if 8090 is occupied)
bash scripts/validate/all.sh --port 8095
```

## Suite V2 — additional steps

```bash
# V2 with chronicle + journal checks (added in scripts/validate/all.sh)
bash scripts/validate/all.sh

# V2 with stress test (30-min reconnect loop)
bash scripts/validate/all.sh --stress

# Standalone stress run (minimum 5 min, target 30 min)
bash scripts/validate/stress-run.sh

# Visual regression (captures or compares against baselines in data/validation/baselines/)
npx tsx scripts/validate/visual-diff.ts
```

Individual scripts:

```bash
# Run the world for N seconds and capture a structured JSON report
npx tsx scripts/validate/run-world.ts --seconds 60 --port 8090

# Analyze utterances from the latest report
npx tsx scripts/validate/analyze-utterances.ts --latest

# Analyze utterances from a specific report
npx tsx scripts/validate/analyze-utterances.ts data/validation/runs/2026-01-01T12-00-00-000Z.json

# Capture visual screenshots (requires Next.js dev OR will start it automatically)
npx tsx scripts/validate/screenshot-world.ts
```

All output goes to:

```
data/validation/
  runs/           # JSON run reports from run-world.ts
  screenshots/    # Per-timestamp dirs with .png files + manifest.json
  analyses/       # JSON utterance analyses from analyze-utterances.ts
```

---

## Metric reference

### run-world.ts output

| Field | Description | Health threshold |
|---|---|---|
| `duration_s` | Wall-clock seconds the run lasted | Should be ≈ `--seconds` ± 5 |
| `ticks` | Number of delta messages received | `duration_s * 30 * 0.9` (allows 10% drop) |
| `tick_rate_hz` | `ticks / duration_s` | **≥ 27 Hz** (target 30 Hz) |
| `drift_avg_ms` | Average absolute drift from ~33 ms interval | **≤ 5 ms** in steady state |
| `entities[*].alive` | Whether each entity is alive at end | Must be `true` for both |
| `entities[*].bond_final` | Bond value at run end | > 0.1 (above lethal threshold) |
| `utterances` | Speak events captured from events stream | ≥ 5 per minute when LLM is up |
| `events_summary` | Count per event kind | No `DeathByDisconnection` in < 300 s runs |
| `llm_invocations` | LLM call outcomes | `timeout` and `unavailable` should be 0 |

### analyze-utterances.ts output

| Field | Description | Health threshold |
|---|---|---|
| `variety.unique_text_ratio` | Fraction of utterances with unique text | **≥ 0.8** (not repeating) |
| `manifesto_compliance.compliant` | No prohibited strings found | **Must be true** |
| `corpus_overlap.ratio` | % of utterances with > 80% Jaccard to corpus | **< 0.05** (not copying literally) |
| `tone.tuteo_ratio` | Fraction using informal "tú" | ≥ 0.3 (intimate voice) |
| `tone.jargon_ratio` | Fraction with technical jargon | **< 0.1** |
| `tone.colloquial_score` | Composite score (tuteo + lowercase + no jargon) | ≥ 0.5 |

### screenshot-world.ts output

| Field | Description |
|---|---|
| `all_non_blank` | True when all 5 scenario screenshots have at least 1% non-background pixels |
| Individual scenario names | `healthy`, `warn`, `lethal`, `death`, `uttering` |

---

## Minimum health criteria (canonical state)

A project in canonical health must satisfy all of the following. When any fails, the executive summary shows `FALLA` and the issue is listed:

| Criterion | Value | Owner if broken |
|---|---|---|
| `tick_rate_hz` | ≥ 45 Hz | `simulation-engineer` (loop.ts) / `backend-realtime` |
| Both entities alive after 90 s | `true` | `simulation-engineer` (lifecycle / bond systems) |
| Manifesto compliance | 100% | `ai-agency-architect` (LLM prompts / voice filter) |
| No `DeathByDisconnection` in a 90 s run | count = 0 | `simulation-engineer` (bond decay rate / death threshold) |

Advisory criteria (shown as `ADVERTENCIA`, not `FALLA`):

| Criterion | Value | Owner if broken |
|---|---|---|
| `utterances/min` | ≥ 5/min when LLM is up | `ai-agency-architect` (LLM trigger policy) |
| `unique_text_ratio` | ≥ 0.8 | `ai-agency-architect` (prompt diversity) |
| `canvas_non_blank` | All 5 scenarios | `frontend-renderer` (WorldCanvas / useRealtime) |
| `drift_avg_ms` | ≤ 5 ms | `backend-realtime` (loop timing) |

---

## Identifying regressions between runs

Compare two run reports directly with `node`:

```bash
node --input-type=module <<'EOF'
import { readFileSync } from 'fs';
const [a, b] = process.argv.slice(2).map(f => JSON.parse(readFileSync(f, 'utf-8')));
console.log('tick_rate:', a.tick_rate_hz, '->', b.tick_rate_hz);
console.log('utterances:', a.utterances.length, '->', b.utterances.length);
console.log('alive:', a.entities.map(e=>e.alive), '->', b.entities.map(e=>e.alive));
EOF data/validation/runs/RUN_A.json data/validation/runs/RUN_B.json
```

Key regression signals:

- `tick_rate_hz` drops > 5 Hz between runs: something is blocking the event loop. Check recent changes to `services/realtime/src/loop.ts`, `agency.ts`, or a new npm dependency.
- `utterances` drops to 0: LLM policy stopped triggering. Check `ai-agency/src/decision/llm-policy.ts` `maybeRequestUtterance` condition and the LLM endpoint health.
- `bond_final` drops below 0.1 in a 90 s run: bond decay rate too high or gain too low. Check `sim-core/src/systems/interaction.ts` and world config `bondGainPerTick` / `bondDecayPerTick`.
- `DeathByDisconnection` appears in events: the death threshold or the disconnection timer changed. Check `sim-core/src/systems/lifecycle.ts` and `ai-agency/src/index.ts` `disconnectionDeathSeconds`.
- `manifesto_compliance` flips to false: a new LLM response contains a prohibited string. Add a voice filter in `ai-agency/src/narrative/voice.ts` and update the prompt in `decision/prompts.ts`.

---

## Interpreting failures

### tick_rate drops below 45 Hz

1. Check `carta_loop_drift_avg_ms` in the metrics diff — if drift > 20 ms, the host is overloaded or the loop is blocked.
2. Look at `llm_invocations.timeout > 0` — the LLM call may be blocking `decideAll()` synchronously. The design says it must not; verify the Promise path in `agency.ts`.
3. Run with `--verbose` to see loop warnings in realtime subprocess stderr.
4. Owner: `simulation-engineer` for loop timing; `backend-realtime` for server architecture.

### utterances = 0

1. Check `llm_invocations.unavailable` — if > 0, the LLM endpoint is unreachable.
2. Check `llm_invocations.silence` — if all invocations are silence, the LLM is returning empty strings. Review the `THINK_SUPPRESSOR` in `ai-agency/src/decision/prompts.ts`.
3. Check that `createLLMPolicy()` in `services/realtime/src/agency.ts` is using the correct `LLM_URL`.
4. Owner: `ai-agency-architect`.

### manifesto violations in utterances

1. The analysis file in `data/validation/analyses/` lists the exact text and violated pattern.
2. Add a post-processing filter in `ai-agency/src/narrative/voice.ts` `NullVoice` → implement `VoiceFilter.sanitize()`.
3. Update the system prompt in `ai-agency/src/decision/prompts.ts` to explicitly forbid the violated patterns.
4. Owner: `ai-agency-architect` + `letter-curator` for copy approval.

### canvas blank (screenshot check fails)

1. Verify the WS mock in `screenshot-world.ts` matches the current `WorldView` shape in `apps/web/lib/realtime/types.ts`. If the shape changed, update `makeEntityView()`.
2. Check `useRealtime` hook in `apps/web/lib/realtime/useRealtime.ts` — if it rejects unknown message types, the mock may be silently dropped.
3. Check `WorldCanvas.tsx` for uncaught exceptions in the rAF loop that would abort painting.
4. Owner: `frontend-renderer`.

### both entities dead before run ends

1. Check `bond_final` — if 0.0, the bond decayed completely. Verify `bondDecayPerTick` in sim-core world config.
2. Check events for `DeathByDisconnection` — if present at tick < 500, the initial bond or decay rate is wrong.
3. Run `packages/sim-core/tests/scenarios/death-by-disconnection.test.ts` locally.
4. Owner: `simulation-engineer`.

---

## Snapshot hash change policy

The `run-world.ts` report does not include a world-state hash directly. For deterministic snapshot regression testing, use the `packages/sim-core/tests/scenarios/` suite:

```bash
pnpm --filter @carta/sim-core test
```

When a snapshot hash changes in CI:
1. The PR author must add a comment explaining which behavioral change caused the hash to change.
2. The explanation must reference one of the four pillars (docs/concepts/four-pillars.md).
3. The `code-reviewer` agent must approve the explanation before merging.

---

## Notes for the orchestrator (MAIN)

- Run `bash scripts/validate/all.sh` after each wave of agent commits.
- The scripts are resilient: if LLM/embed are down, they log a warning and continue.
- The executive summary exit code is 0 (OK/WARN) or 1 (FAIL). Use `|| true` if you want to always see the summary even on failure.
- Reports are timestamped and never overwritten; accumulate freely in `data/validation/`.
- The `data/` directory is gitignored — reports stay local.
