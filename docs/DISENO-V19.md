# Diseño técnico V19 — Biología, emergencia y protocolo de laboratorio

> Documento de diseño generado el 2026-11-23 (`codex/gpt-6.1-sol`) a partir de la auditoría viva de V18 (días 83–88, 5 001 → 8 210 habitantes) y la Constitución del proyecto.

**V19 should remove the learning and invention traps, then make infrastructure respond to persistent local scarcity.** Increasing neural weight, mutation, or conflict frequency would leave the underlying causes intact.

This is a read-only design brief. I inspected HEAD `e3e43be6`; the seven requested implementation files have no differences from published `4c97666`. The Day-83 measurements below are supplied observations, not independently sampled live telemetry. No files were modified and no simulations were launched.

**1. Root causes, with exact code evidence**

**1 — Shelter-rest convergence**

- [index.ts:1670](../src/world/index.ts#L1670) rewards rest every 30 ticks:

  ```text
  gained = fatigue_before − fatigue_after + energy_after − energy_before
  updatePolicyPlasticity(rest, gained × 25, learningRate × 0.3)
  ```

  Normal metabolism continually recreates small recoverable deficits. Rest can therefore keep earning positive reinforcement while the body remains almost fully rested.

- [politica.ts:94](../src/world/politica.ts#L94) applies:

  ```text
  reward = clamp(benefit, −1, 1)
  trace[i] = chosen ? 1 : trace[i] × 0.8
  bias[i] = clamp(bias[i] + learningRate × reward × trace[i], −0.5, 0.5)
  ```

  There is no prediction error, contextual baseline, or decay of an unchallenged positive bias. Other eligible actions also receive part of each reward. Plasticity is a **state-independent action bias**, although the neural network itself observes bodily state.

- [index.ts:1296](../src/world/index.ts#L1296) scales strategic heuristics by `1 − politicaAutonomia × 0.55`. At V18’s `0.65`, that is **0.6425**. The strategic list excludes rest; rest retains its heuristic plus its neural contribution.
- [index.ts:1057](../src/world/index.ts#L1057) gives rest `1.75f + 1.2(1−E) × readinessRecovery`, plus `0.1` at night, without scaling its neural contribution by remaining recovery demand.

**Diagnosis:** repeated positive reinforcement, transferable eligibility traces, and asymmetric heuristic attenuation create a plausible rest attractor.

**Qualification:** population means do not establish that every resting person is camping unnecessarily. Also, acquired plasticity is explicitly reset at birth—[index.ts:2000](../src/world/index.ts#L2000). The reported count does not by itself prove genetic convergence.

---

**2 — Openness saturation and disappearing conflicts**

- [society.ts:884](../src/world/society.ts#L884) selects turn-taking whenever:

  ```text
  trust ≥ 0.55 OR (openness_a + openness_b)/2 ≥ 0.65
  ```

  Neither condition tests whether the remaining resource can actually satisfy the agreement.

- The cross-community turn calls `bond(..., +0.04)`, which itself adds `0.006 × derivaCultural` to openness at [society.ts:88](../src/world/society.ts#L88), then adds another `0.012` at [society.ts:886](../src/world/society.ts#L886). **Total: +0.018 per participant**, at drift `1`, before observing successful consumption.
- Cross-community cooperation similarly adds `0.006 + 0.015 = 0.021`; within-community cooperation subtracts `0.003`: [society.ts:539](../src/world/society.ts#L539).
- The negative `−0.03` openness update exists only **after** bypassing the cooperative branch: [society.ts:902](../src/world/society.ts#L902). High openness therefore prevents the very experiences that could lower it.
- Useful farming/building can lower openness, but through a much smaller learning-rate-scaled update: [society.ts:55](../src/world/society.ts#L55).

`convivir()` is not directly homogenizing culture: it deliberately updates bonds without calling `bond()`, capped at `0.5`—[society.ts:108](../src/world/society.ts#L108). Productive cooperation can subsequently push trust above the unconditional `0.55` escape hatch.

**Diagnosis:** an agreement is treated as a successful outcome before fulfillment, producing a self-protecting cooperative branch. Simply lowering openness would not fix the independent trust override.

---

**3 — Architectural invention has an almost exhausted finite universe**

[validBlueprint():89](../src/world/inventions.ts#L89) requires:

```text
2 ≤ component count ≤ 8
1 ≤ frames ≤ 2
1 ≤ roofs ≤ frames
cisterns, granaries, gardens ≤ 2; hearths ≤ 1
garden ⇒ cistern
other components ≤ frames × 4
wood ≤ 12 AND stone ≤ 8
```

**Exhaustive enumeration of these conditions yields exactly 17 signatures, including the base blueprint.** Thus `blueprint-14` is consistent with approaching exhaustion; its identifier alone does not establish exactly which signatures remain.

Three additional closures matter:

- Signatures contain only six component counts; geometry is absent—[inventions.ts:73](../src/world/inventions.ts#L73).
- A new candidate must satisfy:

  ```text
  value > max(0.035, bestKnownValue × 1.02)
  ```

  [inventions.ts:428](../src/world/inventions.ts#L428). A cheaper, repairable, or niche-efficient design cannot qualify solely through those advantages.
- Candidate novelty is checked against **every resident world blueprint**, including designs the person has never encountered—[inventions.ts:408](../src/world/inventions.ts#L408). That makes remote invention affect local discoverability.
- Construction still requires one builder to hold the complete material cost—[inventions.ts:482](../src/world/inventions.ts#L482). Material gathering and cooperative supply stop at `12/8`—[index.ts:1717](../src/world/index.ts#L1717), [society.ts:505](../src/world/society.ts#L505).
- Open mode also retains `OPEN_WORLD_MAX_BLUEPRINTS = 4096`—[params.ts:302](../src/world/params.ts#L302). It is not the current bottleneck, but should not become a future lifetime innovation ceiling.

**Diagnosis:** raising catalog capacity alone cannot help. The genotype, admission test, and construction transaction all constrain invention.

---

**4 — Predator reproduction: narrow simultaneous eligibility plus difficult acquisition**

There is **no fox-specific reproductive prohibition**. The code supports several interacting bottlenecks.

[animals.ts:639](../src/world/animals.ts#L639) requires both nearby parents to satisfy:

```text
age ≥ 600
age − lastBirthAge ≥ 600
health > 0.75
energy > 0.65
hunger < 0.4
thirst < 0.4
action ≠ flee
```

The initiating cell must additionally have water `≥0.012`, plant growth `≥0.08`, room, and a same-species eligible partner at Manhattan distance `≤1`. Every species pays `0.06` **plant biomass**, including predators.

Acquisition makes those simultaneous conditions difficult:

- Foxes eat only hares; wolves can eat hares, deer, boar, and foxes—[animals.ts:375](../src/world/animals.ts#L375).
- Founder baseline movement intervals, at fatigue `0.12`, are approximately **hare 6 ticks, fox 7, wolf 7, deer/boar 8**, from `ceil(11 − 7speed + 3fatigue)`—[animals.ts:534](../src/world/animals.ts#L534). Foxes pursue their comparatively faster prey.
- Fleeing movement resolves first. Predation then requires exact co-location, four accumulated contact-work ticks per strike, and typically about five strikes against full health. Losing contact resets work—[animals.ts:855](../src/world/animals.ts#L855).
- At baseline metabolism, hunger rises `0.00042/tick`. Hunting begins above `0.38`; reproductive eligibility ends at `0.4`: only approximately **48 ticks** separate those thresholds without feeding—[animals.ts:517](../src/world/animals.ts#L517), [animals.ts:577](../src/world/animals.ts#L577).
- One hare provides a baseline fox about `0.12 × 4.8 × 0.85 = 0.4896` hunger relief, but only **0.06 readiness energy**. A deer gives a wolf about `1.152` hunger relief before clamping and **0.125 energy**—[ecosystem.ts:9](../src/world/ecosystem.ts#L9), [animals.ts:876](../src/world/animals.ts#L876).
- Hunting precedes resting in the selector, even when the hunter is tired; there is no mate-seeking branch—[animals.ts:518](../src/world/animals.ts#L518).

**Diagnosis:** foxes face a difficult prey matchup, fragile contact accumulation, and a small joint feeding/recovery/mating window. Wolves have more accessible and more rewarding prey.

**Do not infer lifetime zero births from a G0 census.** Newly explored terrain materializes new G0 animals. Fox lifespan is `26,000` active biological ticks, about **10.83 simulated days**, while archived animals can be frozen. Cohort genealogy and gate-rejection measurements are required to determine which bottleneck dominates.

---

**5 — Why community diversity plateaus**

Several feedbacks drive different communities toward similar mature economies:

- Lifetime habituation penalizes frequently performed actions, encouraging individuals to rotate through the same repertoire—[index.ts:1263](../src/world/index.ts#L1263).
- Local policy observations compress resources into aggregate food, water, and material quantities; they omit construction demand, specific material shortages, tool condition, and expected storage losses—[politica-obs.ts:224](../src/world/politica-obs.ts#L224).
- Architecture exhausts its small design space; openness converges; tool aggregation mostly takes the maximum capability across carried objects—[technology.ts:282](../src/world/technology.ts#L282).
- Weather is one world-wide Bernoulli draw every `600` ticks, with rain probability `0.4`, rather than persistent regional seasons—[index.ts:307](../src/world/index.ts#L307).
- Group culture is an average of members—[society.ts:820](../src/world/society.ts#L820). Splitting a group creates no new material niche. **V18 already has active fission**; the September “one giant community” diagnosis is historical, not an adequate explanation of V18.
- Technology admission compares against the global resident recipe window as well as personal knowledge—[technology.ts:638](../src/world/technology.ts#L638). This can suppress locally meaningful independent discovery.

Finally, [the C8 audit:25](REVISION-2026-09-24.md#L25) establishes a **measurement problem separate from these mechanisms**: a bounded index cannot keep increasing indefinitely in a healthy stationary regime. More communities or higher diversity do not automatically satisfy growing diversity.

**2. Concrete V19 mechanisms and parameters**

The following are **candidate laws and initial experimental values**, not calibrated defaults.

| Factor | Proposed `WorldParams` switch | Historical/default | V19 open candidate |
|---|---|---:|---:|
| L: causal learning | `conducta.aprendizajeCausal` | `false` | `true` |
| S: fulfilled material agreements | `social.acuerdosMateriales` | `false` | `true` |
| B: modular construction sites | `construccion.modular` | `false` | `true` |
| T: material-derived installations | `tecnologia.obrasPorPropiedades` | `false` | `true` |
| F: physical contact resolution | `fauna.contactoContinuo` | `false` | `true` |
| R: diet-funded reproduction | `fauna.reservaReproductiva` | `false` | `true` |
| M: local reproductive encounters | `fauna.encuentroFertil` | `false` | `true` |
| E: regional seasonality | `ecologia.amplitudEstacional` | `0` | `0.25` |

Associated numeric keys:

| Key | Initial value | Meaning |
|---|---:|---|
| `conducta.memoriaResultadoTicks` | `2400` | Local outcome-memory time constant; inactive when L is off |
| `social.memoriaResultadosDias` | `10` | Finite memory of personally observed agreement outcomes |
| `fauna.fraccionReservaCria` | `0.15` | Fraction of actual acquired food allocated to reproductive biomass |
| `ecologia.periodoEstacionalDias` | `20` | Environmental cycle, not a behavior schedule |
| `ecologia.escalaClimaticaCeldas` | `64` | Spatial correlation length of climate |

Boolean descriptors must remain boolean; periods/scales must be positive integers; fractions must lie in `[0,1]`. Disabled branches must preserve old arithmetic and RNG consumption exactly.

**L — Replace action bonuses with contextual consequence learning**

- Remove the special recurring rest reward and fixed action-completion bonuses from the enabled learning path.
- Accumulate an action episode’s **actual** bodily change and locally witnessed delivered services. Do not reward predicted production, inventory filling, recipe registration, or unfinished agreements.
- Use bounded contextual prediction error:

  ```text
  advantage = observed_return − learned_context_baseline
  bias ← bias + η × eligibility × (advantage − bias)
  ```

  Decay eligibility by elapsed ticks, rather than number of outcome calls. Contexts use existing bodily observations; learned state remains nonheritable.
- Scale rest’s neural contribution by available bodily recovery demand, e.g.:

  ```text
  g_rest = clamp(fatigue + 1 − energy, 0, 1)
  rest_score = existing_physical_score + g_rest × neural_delta
  ```

  This preserves rest and its benefits while preventing an acquired preference from dominating when recovery demand approaches zero.
- Credit maintenance or teaching through later **observed useful consequences**, with finite attribution memory. Unobserved remote benefits cannot become personal reward.

Keep `12→8→12` initially. A larger network is not necessary to test this correction.

**S — Learn whether agreements work**

Replace the unconditional trust/openness override with evaluation of locally feasible alternatives: wait, yield, exchange, or attempt extraction.

- Compare observed stock, travel/wait cost, bodily urgency, and personally remembered fulfillment.
- An agreement produces neither resources nor a success reward at signing.
- Actual delivery updates trust/openness upward; depletion during an agreed wait, unfulfilled exchange, or personally suffered exclusion supplies negative evidence.
- Use a bounded outcome estimator, `o ← o + α(y−o)`, with evidence strength derived from observed consequences. Remove automatic openness changes merely for “building,” “exploring,” or crossing a community label.
- Record conflict when incompatible physical claims actually obstruct access; retain paid fatigue/time consequences. No conflict quota, scheduled hostility, or forced violence.

High openness should remain possible where cooperation works. The defect is immunity to contradictory evidence.

**B — Scale buildings through physical modules and shared sites**

Replace count-only blueprints with connected modules carrying footprint, geometry, material content, support, and condition.

```text
required support load ≤ material strength × supporting section
project remaining material = required − physically delivered
project work = Σ paid contributions by present workers
```

- Construction sites hold real deposited materials and unfinished work. A single person can deliver multiple loads; several people can contribute through existing cooperation.
- Carry limits constrain transport, not the lifetime size of a project.
- Tools affect paid work, joining, attainable spans, and repair costs; their wear remains explicit.
- Components gain capacity through actual dimensions and material, with footprint, load, exposure, and maintenance costs.
- Local admission uses a Pareto frontier of service, material cost, work, and maintenance. A cheaper specialized design can qualify.
- Global signature interning may deduplicate storage, but must not grant knowledge or prohibit paid local rediscovery.
- Archive definitions and resolve ancestry beyond resident caches; remove lifetime blueprint-count gates.

**T — Connect recipes to infrastructure properties**

Install actual manufactured products into B modules, or into existing structures when B is disabled.

Examples of constitutive effects:

```text
usable storage volume = physical volume × containment × condition
leakage/spoilage = exposed content × loss coefficient(properties, environment)
joint capacity = installed material section × binding/cohesion × condition
```

Installing transfers the item out of inventory. Repair consumes replacement material. Capacity does not create contents.

Measure benefits as actual avoided loss, delivered water/food, avoided damage, or saved work. Remove positive benefit floors such as `Math.max(0.05, workSaved × 0.01)` from the enabled measurement path—[technology.ts:380](../src/world/technology.ts#L380).

This gives recipe differences consequences beyond “strongest carried tool wins.” Personal discovery comparisons must use encountered instructions and observed artifacts, not the global hot cache.

**F/R/M — Repair predator acquisition and reproductive provisioning independently**

- **F:** resolve movement/contact over the same physical interval, including crossed paths and local attack reach. Attack preparation represents paid effort; brief separation may decay preparation rather than erase it instantly. Damage still requires current physical contact/reach. Preserve finite attack costs, recovery time, prey escape, and deterministic collision ordering. No guaranteed catches or fox-specific speed bonus.
- **R:** reserve a debited fraction of actually acquired, diet-compatible food. Replace the universal natal-cell plant requirement with `0.03` reproductive biomass from each parent, supplying the existing `0.06` offspring biomass. Retain water, readiness, health, maturity, and reproductive recovery costs. Reserved food cannot also reduce hunger.
- **M:** a reproductively ready animal can approach a perceived compatible partner through ordinary paid movement. Urgent subsistence and threats remain relevant; no spawning partners or remote mate knowledge.

Do **not** initially relax the `<0.4` hunger gate or `>0.65` energy gate. First measure whether correcting acquisition, provisioning, and encounter opportunity restores viable reproduction.

**E — Persistent regional hydrological pressure**

Use a smooth, seed-derived regional climate field and a bounded seasonal forcing of precipitation/evaporation. Apply it to existing water, moisture, growth, and fertility fluxes.

- Preserve declared mean external inputs; record rainfall as an environmental input.
- Use integer phase arithmetic and explicitly ordered interpolation shared by CPU/GPU.
- Agents observe local conditions and their own history, never the climate generator or global scarcity.
- Dry periods make cisterns and transport useful; wet productive regions can support surplus and preservation; depleted woodland changes construction costs.

These pressures permit specialization without assigning a biome a profession. Community-wide averages and centroids must remain census information; decisions should use perceived contacts and remembered local conditions.

**Compatibility contract**

Enable candidates only for explicitly configured **rules 13** worlds created under `CARTA_OPEN_WORLD=1`. Persist their resolved parameters; loading V18 must not activate them through the environment.

Keep old defaults and disabled behavior intact. Because canonical digests include parameters/version, distinguish full digest equality from equality after **declared neutral schema/version normalization**. New state must be validated, persisted, and cleared appropriately at birth.

No mechanism reads or modifies `world.memories`, the letter, or S/I’s authorized characterization.

**3. Top three emergence multipliers**

| Rank | Upgrade | Emergence per implementation complexity | Constitutional basis |
|---|---|---|---|
| **1** | **B + T: scalable, repairable infrastructure made from real products** | Highest: turns recipes, carrying, construction, storage, maintenance, teaching, and exchange into one material dependency network | Benefits require geometry, matter, labor, use, and upkeep |
| **2** | **L + S: contextual learning from fulfilled consequences** | High: removes two absorbing feedback loops and lets the same laws produce different strategies under different histories | No reward for labels, activity counts, or promised outcomes |
| **3** | **E: persistent regional hydrology** | High once storage works: creates changing comparative advantages, migration pressure, buffers, and exchange opportunities | Environmental fluxes alter local opportunities; no assigned roles |

Predator corrections are essential biological repairs, but these three combinations provide broader routes to emergent complexity.

**4. Falsifiable laboratory protocol**

**Controls and arms**

Freeze code, resolved V18 open parameters, instruments, thresholds, and evaluator hashes before running.

Use factors `L,S,B,T,F,R,M,E` above:

- `CTRL`: V18 open physics.
- Eight singleton arms: `CTRL + X`, one factor at a time.
- `ALL`: all eight.
- Eight omission arms: `ALL − X`.
- `PLACEBO`: execute read-only candidate calculations without committing effects; trajectory must match `CTRL`.

That is **19 arms**. Singleton arms identify sufficiency; omissions identify effects dependent on the combined system.

Use identical initial conditions per seed. Run with durable `Store`, isolated temporary `CARTA_DATA_DIR`, no population ceiling, and no wall-clock-driven governor in biological comparisons. Stop at a declared resource failure and report the run incomplete; do not silently change biological laws.

**Seeds and duration**

- Engineering smoke and diagnostic fixtures: `7, 42, 404, 51926`, through day 10. These do not decide efficacy.
- Main panel: **19101–19108**, all 19 arms through **60 days / 144,000 ticks**.
- Untouched confirmation: **19201–19208**, `CTRL` and the frozen combined candidate through **90 days / 216,000 ticks**. This exceeds the reported Day-83 failure horizon.
- No tuning on either panel. A changed parameter set requires another preregistered panel.
- Seeds are experimental units. Report paired effects, intervals, and Holm-adjusted tests across the eight factor hypotheses; daily observations are not independent replicates.

**Measurements required before interpreting results**

Observe every tick without changing digests:

- Rest episodes, bodily state, feasible alternatives, actual recovery, neural contribution, contextual bias.
- Resource-contention opportunities, proposed agreements, fulfillment, consumption, losses, and subsequent trust/openness.
- Predator acquisition attempts, contacts, paid effort, kills, intake, **each reproductive gate**, mate encounters, and cohort genealogy.
- Blueprint/recipe proposals, rejection reasons, construction, actual service, users, wear, repairs, and resolved ancestry.
- Local environment, material flows, community membership history, and complete daily C1–C8 inputs.

Do not use the current reason string as the sole policy-causality measurement. Counterfactual decision evaluation must leave the real trajectory untouched.

**Acceptance gates**

| Gate | Preregistered pass condition |
|---|---|
| **Historical behavior** | Disabled candidate preserves normalized historical trajectories in seeds `7,42,51926,104729` for 2,400 ticks; missing keys load disabled |
| **0 ULP** | Zero `Object.is` differences across CPU 1/2/8/28 workers, adversarial scheduling, GPU `[0]`, `[1]`, `[0,1]`, including collisions, shared sites, climate boundaries, and save/reload |
| **Integrity** | Exact integer material balances; explicit floating-operation reference accounting; zero duplicate consumption, unpaid work, fabricated benefit, missing parent definitions, or observer-induced trajectory differences |
| **Non-extinction** | Combined candidate has no additional mortal-human extinctions versus paired control; survives in ≥7/8 main and ≥7/8 confirmation seeds; report fertile-pair availability separately |
| **Untired camping** | During days 41–60, ≤10% of eligible person-ticks belong to shelter-rest bouts lasting >240 ticks, and ≥80% reduction versus control. Eligible means `E≥0.9`, `fatigue≤0.15`, no urgent need/exposure recovery, and a physically feasible useful alternative |
| **Predators** | In productive predator fixtures, both fox and wolf produce ≥5 G2+ offspring reaching maturity in ≥7/8 seeds. Require in-world G2+ evidence where founding cohorts and suitable habitat exist; absence is reported, never replaced by spawned founders |
| **Continuing innovation** | Each late window, days 31–40, 41–50, 51–60, contains ≥1 new useful structural design and ≥1 new useful recipe, each subsequently used by ≥3 mortals with ≥10 verified service/use receipts. Names, duplicate signatures, and ancestry depth alone do not qualify |
| **Functional distinction** | Claimed innovations improve a local service/cost Pareto dimension by ≥8%, or enable a previously infeasible paid operation; remove the relevant property and its benefit disappears |
| **Maintenance** | Observe ≥2 actual tool replacement cycles and a paid structural repair that restores previously lost service; stored starting stock alone cannot establish continuity |

**Preserve the official C1–C8 evaluator.** Its executable defaults are at [criterio-terminado.mts:200](../scripts/lab/criterio-terminado.mts#L200):

| Criterion | Existing acceptance, evaluated at day 60 |
|---|---|
| C1 | Population ≥16 every day in days 51–60; also report mortals separately |
| C2 | ≥1 birth in that window; ≤1 mortal founder remains |
| C3 | ≥3 distinct living mortal generations |
| C4 | ≥2 recognized cooperation types, each ≥5 acts and ≥10% of window acts |
| C5 | ≥1 actual conflict in the window |
| C6 | Population/birth/death balance closes; recognized causes and ≥2 causes |
| C7 | Other-inventor useful-use fraction ≥0.15, present on ≥50% of window days, with ≥20 attributable uses |
| C8 | Frozen daily-window series; corrected one-sided MK `p<0.05`, Sen increase ≥0.02 over days 5–60, with existing coverage rules |

Require joint C1–C7 in ≥7/8 main and confirmation seeds. Keep official C8 results alongside all supplemental measures.

**Targeted causal challenges**

Run these as separately identified laboratory interventions, never hidden corrections in an autonomous world:

- **Agreements:** compare replenishing versus insufficient shared sources. With at least 100 contention opportunities, adequate agreements must achieve ≥90% fulfillment; inadequate sources must remain capable of producing costly disagreement even at initial openness `0.95`. Twenty observed successes versus failures must shift learned cooperation estimates in opposite directions by ≥0.02. Do not demand conflict in genuinely sufficient conditions.
- **Predators:** independently test prey speed, contact resolution, diet provisioning, and partner proximity. Report births per eligible-pair biological day, not just maximum generation. Scarcity must still be capable of causing extinction.
- **Infrastructure:** remove an installed property, supplier, or water inflow, then restore it physically. Require ≥10% loss and recovery of the relevant service across a declared window.
- **Specialization:** compare heterogeneous environments with equal-mean homogenized environments. Measure behavior, useful outputs, tool use, and dependency networks—not community names.

For supplemental community divergence, preregister permutation-corrected between-community variance and rarefied functional repertoire. A candidate target is late-window excess between-group variance `≥0.05`, increasing `≥0.02` from days 21–30 to 51–60, and exceeding the paired homogenized control. Validate the test against stationary/label-permuted nulls with **≤10% false acceptance**. These measurements remain supplemental until Steven chooses a revised C8 interpretation.

Finally, validate naturally attained **5,000 / 10,000 / 20,000** inhabitants using laboratory checkpoints and equivalent 2,400-tick replays. Require full-state parity, instrumentation overhead <5%, and candidate p95 step time ≤1.25× V18 on equivalent scenes. Record absolute latency, RAM/VRAM, save cost, and throughput. If a population scale is never reached or cannot run within resources, mark it unvalidated.

**V19 would remain a candidate if C8 fails.** Sustained specialization, ongoing useful invention, and biological continuity would be valuable evidence, but cannot silently replace the frozen acceptance criterion.

