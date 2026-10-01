/** Objective 10. Frozen paired technical cost instrument; synthetic q and ghat.
 * --manifest constructs inputs without stepping. Freeze its output BEFORE --selftest.
 * --selftest includes64 ON+32 OFF fixture steps plus2 restore-continuation steps.
 * --statistics-selftest validates the evaluator without constructing any world.
 * --run needs explicit authorization and that exact frozen manifest. No retries. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { World } from '../../src/world/index.js';
import type { TechnologyProgram } from '../../src/shared/technology.js';
import { ACTIONS, CANDIDATE, graph, frozenEvidence, resourceGuard, sha, stableJson, writeNew, identitySelftest,
  type Graph, type LocalPerson, type Productive } from './ley-2prima-identity.mjs';

export const COST_PROTOCOL = Object.freeze({
  version: 'ley-2prima-cost-1', blocks: 32, statesPerBlock: 64, warmupBlocks: 4,
  armOrder: 'even block ABBA; odd block BAAB; A=OFF, B=ON; two observations per arm averaged inside block',
  independentInputs: true, seed: 19011, initialTick: 13, learnedVariantTick: 29,
  profile: { 'social.radioConvivencia': 12, 'social.disolucion': 1, 'social.maxComunidades': 64 },
  ghat: [1, 1, 1, 1, 1, 1, 1, 1], syntheticQ: true, biologicalLearning: false,
  composition: { ready: 16, guards: 16, paid: 16, learnedRestoreVariants: 16 },
  scenes: {
    ready: 'indices 0..15: real selector with gather and farm admission satisfied, q rotated by i modulo8 (1 favored, 0 others), attempts3; same land cell wood8/stone6/food.2/moisture.7/vegetation.4; no command',
    guards: 'indices16..31: hungry, thirsty, tired, hungry+thirsty cyclic; q absent/attempts1/2/absent by floor(i/4)',
    paid: 'indices32..47: ordered eight actions, success then failure, work=duration-1; action held by decisionAt=tick+1000; q=.5 attempts3',
    learnedRestore: 'indices48..55: first8 ready fixtures with attempts7, tick29 and exact JSON snapshot reconstruction; indices56..63: each ordered paid action, success for even action index, failure for odd, attempts7 and tick29, same reconstruction',
    actor: 'first neighbor; other people hold rest until tick+1000 at their existing positions, bodily state .2/.2/.2/.8',
    cell: 'first resident land cell in existing tile order, at least6 from every place and no live animal; no search based on measured outcomes',
    paidFailure: 'gather no raw stock; forage full inventory; hunt no animal; farm no wood; build no materials; repair intact structure; research/craft missing raw input after paid project progress',
    technology: 'raw wood1000 quanta (one legal MASS_UNIT), combine intensity1; progress=technologyWorkCost-1, ledger and energy encode prior paid work; craft registers recipe1 from pure physical operation without running research',
  },
  timing: 'prepare/clone/params/hash/checks outside interval; each arm calls public stepWorld once per independent input; no reuse of output as next input',
  serialization: 'exact JSON-shaped {world,params} stringify timed separately after the step; not SQLite cost and excluded from principal gate',
  bootstrap: { repetitions: 10000, seed: 108281, rng: 'xorshift32 >>>0; one resampled paired block index per draw', estimator: 'ratio of paired arithmetic means', ci: 'percentile2.5/97.5 linear interpolation across sorted10000 ratios' },
  gate: 'CUMPLIDA iff CPU AND wall upper95<=1.01; NO CUMPLIDA if either lower95>1.01; otherwise NO CONCLUYENTE',
  baselineMainOff: 'not measured; frozen main is reserved for mandatory independent identity, not pooled into paired cost',
  exclusions: 'four predefined warmup blocks only; no sample exclusion, retries, calibration, alternate seed or outcome-adaptive fixture replacement',
});
type Scene = { id: number; group: 'ready' | 'guards' | 'paid' | 'learnedRestore'; actorId: string;
  world: World; paidAction?: Productive; expectedSuccess?: boolean; inputHash: string };
type Pair = { off: number; on: number };
type Interval = { ratio: number; lower: number; upper: number };

function personAt(world: World, id: string): LocalPerson {
  const person = world.people.find(p => p.id === id); assert(person); return person as LocalPerson;
}
function syntheticQ(person: LocalPerson, favored: number, attempts: number, fullReadyContrast = false) {
  person.utilidadLocal = Object.fromEntries(ACTIONS.map((action, i) => [action,
    { q: i === favored ? fullReadyContrast ? 1 : .8 : fullReadyContrast ? 0 : .2, intentos: attempts }]));
}
function snapshotRoundtrip(g: Graph, world: World): World {
  const restored = JSON.parse(JSON.stringify(world)) as World;
  g.params.setParams(restored, g.params.paramsOf(world));
  assert.equal(g.digest.digestoCanonico(restored), g.digest.digestoCanonico(world), 'Synthetic snapshot changed bytes');
  return restored;
}
function paidSetup(g: Graph, world: World, actor: LocalPerson, action: Productive, success: boolean) {
  const tile = g.world.tileAt(world, actor)!;
  actor.action = action; actor.target = { x: actor.x, y: actor.y }; actor.decisionAt = world.tick + 1000;
  actor.skills = {}; actor.materials = { wood: 12, stone: 8 }; actor.inventory = .1;
  actor.utilidadLocal = Object.fromEntries(ACTIONS.map(a => [a, { q: .5, intentos: 3 }]));
  actor.work = ['farm', 'hunt'].includes(action) ? 44 : action === 'repair' ? 29 : action === 'build' ? g.inventions.constructionCost(world, actor).work - 1 : 17;
  if (action === 'gather') {
    actor.materials = { wood: 0, stone: 0 }; tile.wood = success ? 8 : 0; tile.stone = success ? 6 : 0;
  } else if (action === 'forage') { tile.food = .2; actor.inventory = success ? 0 : .25; }
  else if (action === 'farm') { tile.moisture = .7; tile.vegetation = .4; actor.materials.wood = success ? 4 : 0; }
  else if (action === 'hunt' && success) {
    const prey = world.animals[0]; assert(prey, 'Frozen hunt fixture requires initial animal');
    prey.x = actor.x; prey.y = actor.y; prey.target = { x: actor.x, y: actor.y };
    prey.lastDecision = world.tick; prey.lastMove = world.tick;
  } else if (action === 'build' && !success) actor.materials = { wood: 0, stone: 0 };
  else if (action === 'repair') {
    const structure = world.structures[0]; assert(structure, 'Frozen repair fixture requires initial structure');
    actor.x = structure.x; actor.y = structure.y; actor.target = { x: actor.x, y: actor.y };
    structure.condition = success ? .3 : 1;
  } else if (action === 'research' || action === 'craft') {
    actor.work = 0;
    const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'combine', intensity: 1 }] };
    const required = g.technology.technologyWorkCost(program), progress = required - 1;
    if (action === 'craft') {
      const result = g.technology.applyPhysicalOperation(program.steps[0]!, [g.technology.rawMaterial('wood', 1000)]);
      assert(result.success && result.product);
      g.catalogue.registerTechnologyRecipe(world, { id: 'recipe-1', name: 'Fixture sintético', program,
        signature: g.technology.programSignature(program), parents: [], generation: 1, inventorId: actor.id, tick: 0,
        x: actor.x, y: actor.y, novelty: 'both', capacities: g.technology.materialCapacities(result.product), uses: 0, utility: 0, manufactured: 0 });
      actor.technology.knownRecipes = ['recipe-1'];
    }
    const energy = progress * .00045;
    actor.technology.project = { kind: action, program, parents: [], recipeId: action === 'craft' ? 'recipe-1' : null,
      progress, requiredWork: required, energyPaid: energy, startedAt: 0 };
    actor.materials.wood = success ? 4 : 0;
    world.technology.ledger.work += progress; world.technology.ledger.energy += energy;
  }
}
export function buildScenes(g: Graph): Scene[] {
  const params = g.params.parseParams({ ...COST_PROTOCOL.profile, 'conducta.utilidadLocal': 1, 'conducta.utilidadLocalGhat': COST_PROTOCOL.ghat });
  const base = g.world.createWorld(COST_PROTOCOL.seed, params);
  const scenes: Scene[] = [];
  for (let id = 0; id < 64; id++) {
    let world = g.world.cloneWorld(base); world.tick = id >= 48 ? 29 : 13;
    for (const person of world.people) {
      // Artificial initial clock, not elapsed biological history: satisfy the
      // population invariant age === tick - bornAt for every living identity.
      person.demography.age = world.tick - person.bornAt;
      person.hunger = .2; person.thirst = .2; person.fatigue = .2; person.energy = .8;
      person.action = 'rest'; person.target = { x: person.x, y: person.y }; person.decisionAt = world.tick + 1000;
      person.command = null; person.controlMode = 'auto';
    }
    const actor = world.people.find(p => p.role === 'neighbor') as LocalPerson | undefined; assert(actor);
    const tile = world.tiles.find(t => t.terrain !== 'water' && t.terrain !== 'shelter'
      && world.places.every(p => Math.hypot(p.x - t.x, p.y - t.y) >= 6)
      && !world.animals.some(a => a.x === t.x && a.y === t.y));
    assert(tile, 'Frozen scene requires a land cell outside settlement exclusion radius');
    actor.x = tile.x; actor.y = tile.y; actor.target = { x: tile.x, y: tile.y }; actor.action = 'explore'; actor.decisionAt = world.tick;
    tile.wood = 8; tile.stone = 6; tile.food = .2; tile.moisture = .7; tile.vegetation = .4;
    actor.materials = { wood: 1, stone: 1 }; actor.inventory = .1;
    syntheticQ(actor, id % 8, id >= 48 ? 7 : 3, id < 16 || id >= 48 && id < 56);
    let group: Scene['group'] = id < 16 ? 'ready' : id < 32 ? 'guards' : id < 48 ? 'paid' : 'learnedRestore';
    let paidAction: Productive | undefined, expectedSuccess: boolean | undefined;
    if (id >= 16 && id < 32) {
      const n = id - 16, guard = n % 4, attempts = Math.floor(n / 4) % 3;
      if (guard === 0 || guard === 3) actor.hunger = .75;
      if (guard === 1 || guard === 3) actor.thirst = .75;
      if (guard === 2) actor.fatigue = .75;
      if (attempts === 0) delete actor.utilidadLocal; else syntheticQ(actor, n % 8, attempts);
    }
    if (id >= 32 && id < 48 || id >= 56) {
      const actionIndex = id < 48 ? Math.floor((id - 32) / 2) : id - 56;
      paidAction = ACTIONS[actionIndex]!; expectedSuccess = id < 48 ? id % 2 === 0 : actionIndex % 2 === 0;
      paidSetup(g, world, actor, paidAction, expectedSuccess);
      if (id >= 56) for (const observation of Object.values(actor.utilidadLocal!)) observation.intentos = 7;
    }
    if (id >= 48) world = snapshotRoundtrip(g, world);
    if (id < 16 || id >= 48 && id < 56) {
      const p = personAt(world, actor.id), local = g.world.tileAt(world, p)!;
      assert(p.hunger <= .5 && p.thirst <= .5 && p.fatigue <= .5 && p.decisionAt === world.tick);
      assert(local.wood! >= 1 && p.materials.wood < g.inventions.constructionCost(world, p).wood, 'Ready gather admission missing');
      assert(local.terrain !== 'shelter' && local.moisture > .25 && local.vegetation < .8 && p.materials.wood >= 1, 'Ready farm admission missing');
    }
    try {
      // Moving a synthetic prey also moves its stock projection; no physics step.
      g.animals.syncFauna(world.tiles, world.animals);
      g.world.assertWorld(world);
    } catch (error) {
      throw new Error(`Fixture${id} (${group}, ${paidAction ?? 'decision'}, success=${expectedSuccess ?? 'n/a'}): invalid constructed initial state`, { cause: error });
    }
    scenes.push({ id, group, actorId: actor.id, world, ...(paidAction ? { paidAction, expectedSuccess } : {}), inputHash: g.digest.digestoCanonico(world) });
  }
  assert.equal(scenes.length, 64);
  for (const group of ['ready', 'guards', 'paid', 'learnedRestore'] as const) assert.equal(scenes.filter(s => s.group === group).length, 16);
  return scenes;
}
function sceneManifest(scenes: Scene[]) {
  return scenes.map(({ id, group, actorId, paidAction, expectedSuccess, inputHash, world }) => ({ id, group, actorId,
    paidAction: paidAction ?? null, expectedSuccess: expectedSuccess ?? null, inputHash, tick: world.tick, population: world.people.length,
    readyProductiveAdmissions: group === 'ready' || id >= 48 && id < 56 ? ['gather', 'farm'] : [],
    actorQ: personAt(world, actorId).utilidadLocal ?? null, progress: personAt(world, actorId).technology.project }));
}
function makeManifest(scenes: Scene[]) {
  const payload = { protocol: COST_PROTOCOL, protocolSha: sha(stableJson(COST_PROTOCOL)),
    fixtureClock: { artificialInitialState: true, biologicalHistorySimulated: false,
      humanAgeInvariant: 'demography.age = fixed scene tick - bornAt',
      paidProjectClock: 'progress, energyPaid, startedAt and ledger are declared synthetic initial state; no prior trajectory was run' },
    scenes: sceneManifest(scenes), sources: frozenEvidence() };
  return { ...payload, manifestSha: sha(stableJson(payload)) };
}
function restoreCheck(g: Graph, scene: Scene) {
  const world = g.world.cloneWorld(scene.world), store = new g.store.Store(':memory:');
  try {
    store.save(world); const before = g.digest.digestoCanonico(world), loaded = store.load(); assert(loaded);
    assert.equal(g.digest.digestoCanonico(loaded.world), before, 'Store roundtrip changed full world/params digest');
    assert.deepEqual(personAt(loaded.world, scene.actorId).utilidadLocal, personAt(world, scene.actorId).utilidadLocal, 'q/attempts not persisted');
    assert.deepEqual(personAt(loaded.world, scene.actorId).technology.project, personAt(world, scene.actorId).technology.project, 'Paid project progress not persisted');
    g.world.stepWorld(world); g.world.stepWorld(loaded.world);
    assert.equal(g.digest.digestoCanonico(loaded.world), g.digest.digestoCanonico(world), 'Active continuation diverges after Store recovery');
    assert.deepEqual(personAt(loaded.world, scene.actorId).utilidadLocal, personAt(world, scene.actorId).utilidadLocal, 'Recovered paid completion changes q');
    return { fullDigestAtRestore: before, fullDigestAfterContinuation: g.digest.digestoCanonico(world), sqliteRoundtrip: true,
      continuedStepsPerArm: 1, q: personAt(world, scene.actorId).utilidadLocal };
  } finally { store.close(); }
}
function checkPaid(g: Graph, scene: Scene, after: World) {
  if (!scene.paidAction) return null;
  const action = scene.paidAction, beforePerson = personAt(scene.world, scene.actorId), person = personAt(after, scene.actorId);
  const old = beforePerson.utilidadLocal?.[action], current = person.utilidadLocal?.[action]; assert(old && current);
  assert.equal(current.intentos, old.intentos + 1, `Scene${scene.id}: actual paid counter missing/doubled for ${action}`);
  let benefit = 0, paidWork = beforePerson.work + 1;
  if (action === 'gather') benefit = person.materials.wood + person.materials.stone - beforePerson.materials.wood - beforePerson.materials.stone;
  else if (action === 'forage') benefit = person.inventory - beforePerson.inventory;
  else if (action === 'hunt') benefit = (after.totals.foodHarvested ?? 0) - (scene.world.totals.foodHarvested ?? 0);
  else if (action === 'farm') benefit = (after.totals.cultivations ?? 0) - (scene.world.totals.cultivations ?? 0);
  else if (action === 'build') benefit = after.settlementCount - scene.world.settlementCount;
  else if (action === 'repair') {
    const original = scene.world.structures.find(s => s.x === beforePerson.x && s.y === beforePerson.y);
    const repaired = after.structures.find(s => s.x === person.x && s.y === person.y); assert(original && repaired);
    // Frozen baseline wear precedes work. Recover the condition immediately before
    // repair, independently of q and of the net condition delta across the tick.
    const frames = original.components.filter(component => component === 'frame').length;
    const durability = 1 + (frames - 1) * .5;
    const beforeOperation = after.tick % 10 === 0
      ? Math.max(0, Math.min(1, original.condition - (after.weather === 'rain' ? .00028 : .00018) / durability)) : original.condition;
    const expectedCondition = scene.expectedSuccess ? Math.min(1, beforeOperation + .4) : beforeOperation;
    assert.equal(repaired.condition, expectedCondition, 'Actual repair increment differs from its capped paid operation');
    benefit = repaired.condition - beforeOperation;
  }
  else {
    const receipt = [...after.technology.history, ...(after.technology.journal?.pending ?? [])].find(e => e.tick === after.tick && e.actorId === person.id && e.kind === action);
    assert(receipt && receipt.work > 0, `Scene${scene.id}: actual paid technology receipt missing`);
    benefit = Number(receipt.success); paidWork = receipt.work;
  }
  assert.equal(benefit > 0, scene.expectedSuccess, `Scene${scene.id}: expected paid success/failure not observed for ${action}`);
  assert(Number.isSafeInteger(paidWork) && paidWork > 0, 'Actual paid work must be positive');
  const ghat = g.params.paramsOf(scene.world).conducta.utilidadLocalGhat?.[ACTIONS.indexOf(action)];
  assert(ghat !== undefined && Number.isFinite(ghat) && ghat > 0, 'Frozen productive scale missing');
  const y = Math.max(0, Math.min(1, benefit / paidWork / ghat));
  const expectedQ = old.q + person.genome.learningRate * (y - old.q);
  assert.equal(current.q, expectedQ, `Scene${scene.id}: independently calculated paid q differs for ${action}`);
  return { id: scene.id, action, success: benefit > 0, observedBenefit: benefit, paidWork, ghat, y,
    qBefore: old.q, expectedQ, actualQ: current.q, attemptsBefore: old.intentos, attemptsAfter: current.intentos };
}
export function pairedInterval(pairs: Pair[]): Interval {
  assert.equal(pairs.length, 32, 'Incomplete paired evidence: exactly32 blocks required');
  assert(pairs.every(p => Number.isFinite(p.off) && p.off > 0 && Number.isFinite(p.on) && p.on > 0), 'Missing/nonpositive paired time');
  const ratio = (rows: Pair[]) => rows.reduce((n, p) => n + p.on, 0) / rows.reduce((n, p) => n + p.off, 0);
  let state = COST_PROTOCOL.bootstrap.seed;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const samples = Array.from({ length: 10000 }, () => ratio(Array.from({ length: pairs.length }, () => pairs[Math.floor(random() * pairs.length)]!))).sort((a, b) => a - b);
  const percentile = (p: number) => { const pos = p * (samples.length - 1), lo = Math.floor(pos); return samples[lo]! + (samples[Math.min(lo + 1, samples.length - 1)]! - samples[lo]!) * (pos - lo); };
  return { ratio: ratio(pairs), lower: percentile(.025), upper: percentile(.975) };
}
export function verdict(cpu: Interval, wall: Interval) {
  return cpu.upper <= 1.01 && wall.upper <= 1.01 ? 'CUMPLIDA' : cpu.lower > 1.01 || wall.lower > 1.01 ? 'NO CUMPLIDA' : 'NO CONCLUYENTE';
}
function statisticsSelftest() {
  const pass = pairedInterval(Array.from({ length: 32 }, () => ({ off: 100, on: 100 })));
  const fail = pairedInterval(Array.from({ length: 32 }, () => ({ off: 100, on: 103 })));
  const noisy = pairedInterval(Array.from({ length: 32 }, (_, i) => ({ off: 100, on: i % 2 ? 130 : 70 })));
  assert.equal(verdict(pass, pass), 'CUMPLIDA'); assert.equal(verdict(fail, pass), 'NO CUMPLIDA');
  assert.equal(verdict(pass, fail), 'NO CUMPLIDA'); assert.equal(verdict(noisy, pass), 'NO CONCLUYENTE');
  assert.throws(() => pairedInterval([{ off: 1, on: 1 }]), /Incomplete/);
  assert.throws(() => pairedInterval(Array.from({ length: 32 }, () => ({ off: 1, on: NaN }))), /Missing/);
  const weighted = pairedInterval(Array.from({ length: 32 }, (_, i) => i % 2 ? { off: 100, on: 100 } : { off: 1, on: 2 }));
  assert.equal(weighted.ratio, 102 / 101, 'Estimator must be ratio of paired means, not mean of block ratios');
  return { pass, fail, noisy, weighted, negatives: 2 };
}
function prepare(g: Graph, scenes: Scene[], active: boolean): World[] {
  const params = g.params.parseParams({ ...COST_PROTOCOL.profile, ...(active ? { 'conducta.utilidadLocal': 1, 'conducta.utilidadLocalGhat': COST_PROTOCOL.ghat } : { 'conducta.utilidadLocal': 0 }) });
  return scenes.map(scene => { const world = g.world.cloneWorld(scene.world); g.params.setParams(world, params); return world; });
}
function measuredArm(g: Graph, scenes: Scene[], active: boolean) {
  const worlds = prepare(g, scenes, active); // Clones and input preparation outside interval.
  const cpuStart = process.cpuUsage(), start = performance.now();
  for (const world of worlds) g.world.stepWorld(world); // The entire real step, not a helper.
  const wallMs = performance.now() - start, cpu = process.cpuUsage(cpuStart);
  const cpuUs = cpu.user + cpu.system;
  const paid = active ? scenes.map((scene, i) => checkPaid(g, scene, worlds[i]!)).filter(x => x !== null) : [];
  const serialCpuStart = process.cpuUsage(), serialStart = performance.now();
  let bytes = 0;
  for (const world of worlds) bytes += Buffer.byteLength(JSON.stringify({ world, params: g.params.paramsOf(world) }));
  const serialWallMs = performance.now() - serialStart, serialCpu = process.cpuUsage(serialCpuStart);
  return { active, cpuUs, wallMs, serialization: { cpuUs: serialCpu.user + serialCpu.system, wallMs: serialWallMs, bytes }, paid,
    outputs: worlds.map(w => g.digest.digestoCanonico(w)) };
}
async function main() {
  const args = process.argv.slice(2), value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const initialGuard = resourceGuard(), before = frozenEvidence();
  if (args.includes('--statistics-selftest')) {
    assert(!args.includes('--run') && !args.includes('--manifest') && !args.includes('--selftest'), 'Pure statistics mode must be exclusive');
    const statistics = statisticsSelftest(), after = frozenEvidence(); assert.deepEqual(after, before);
    const result = { result: { status: 'PASS', statistics, synthetic: true, realFixtureSteps: 0, worldsConstructed: 0 },
      sources: { before, after }, guards: { initial: initialGuard, final: resourceGuard() } };
    const out = value('--out'); if (out) writeNew(out, result); else process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const g = await graph(CANDIDATE), scenes = buildScenes(g), manifest = makeManifest(scenes);
  let result: unknown;
  if (args.includes('--manifest')) result = manifest;
  else {
    const frozenPath = value('--frozen'); assert(frozenPath, 'Manifest must be frozen before selftest or real data');
    const frozen = JSON.parse(readFileSync(frozenPath, 'utf8')) as typeof manifest;
    assert.deepEqual(frozen, manifest, 'Frozen manifest/input hashes/source footprint changed');
    if (args.includes('--selftest')) {
      const identity = identitySelftest(), statistics = statisticsSelftest(), paid = [], decisions = [], completed = [];
      for (const scene of scenes) {
        const world = g.world.cloneWorld(scene.world); g.world.stepWorld(world);
        completed.push(world);
        const checked = checkPaid(g, scene, world); if (checked) paid.push(checked);
        decisions.push({ id: scene.id, action: personAt(world, scene.actorId).action, q: personAt(world, scene.actorId).utilidadLocal ?? null });
      }
      assert.equal(paid.filter(row => row.id < 48).length, 16, 'Incomplete paid scene coverage');
      const pairedDecisions = [];
      for (const scene of scenes.slice(0, 32)) {
        const off = prepare(g, [scene], false)[0]!;
        // OFF and ON start from the same resident snapshot; only effective law params differ.
        assert.equal(stableJson(off), stableJson(scene.world), 'OFF input state differs before decision');
        g.world.stepWorld(off);
        const offPerson = personAt(off, scene.actorId), onPerson = personAt(completed[scene.id]!, scene.actorId);
        const productive = (person: LocalPerson) => (ACTIONS as readonly string[]).includes(person.action);
        assert.equal(productive(offPerson), productive(onPerson), `Scene${scene.id}: productive class crossed`);
        if (!productive(offPerson)) assert.deepEqual(
          { action: onPerson.action, target: onPerson.target, reason: onPerson.reason },
          { action: offPerson.action, target: offPerson.target, reason: offPerson.reason }, `Scene${scene.id}: nonproductive decision changed`);
        pairedDecisions.push({ id: scene.id, group: scene.group, productive: productive(offPerson),
          off: { action: offPerson.action, target: offPerson.target, reason: offPerson.reason },
          on: { action: onPerson.action, target: onPerson.target, reason: onPerson.reason }, changedProfession: offPerson.action !== onPerson.action });
      }
      const changedReadyProfessions = pairedDecisions.filter(row => row.group === 'ready' && row.productive && row.changedProfession).length;
      assert(changedReadyProfessions >= 1, 'Ready fixtures did not exercise an actual change of productive profession');
      const restore = restoreCheck(g, scenes[62]!);
      const broken = g.world.cloneWorld(scenes[32]!.world);
      assert.throws(() => checkPaid(g, scenes[32]!, broken), /counter/, 'Missing paid outcome must fail selftest');
      const wrongSuccessQ = g.world.cloneWorld(completed[32]!);
      personAt(wrongSuccessQ, scenes[32]!.actorId).utilidadLocal!.gather!.q += .00001;
      assert.throws(() => checkPaid(g, scenes[32]!, wrongSuccessQ), /paid q/, 'Incorrect success q must fail selftest');
      result = { status: 'PASS', manifestSha: manifest.manifestSha, identity, statistics, paid, decisions, pairedDecisions, changedReadyProfessions, restore,
        synthetic: true, biologicalLearning: false, independentOnFixtureSteps: 64, independentOffFixtureSteps: 32,
        independentFixtureSteps: 96, restoreContinuationFixtureSteps: 2, realFixtureSteps: 98, experimentalTrajectorySteps: 0 };
    } else {
      assert(args.includes('--run') && args.includes('--authorized-cost-32x64-abba'), 'Real cost run not authorized');
      const warmup = [], blocks = [];
      for (let block = -4; block < 32; block++) {
        resourceGuard(); const activeOrder = (block + 4) % 2 === 0 ? [false, true, true, false] : [true, false, false, true];
        const arms = activeOrder.map(active => measuredArm(g, scenes, active));
        const average = (active: boolean, metric: 'cpuUs' | 'wallMs') => arms.filter(a => a.active === active).reduce((n, a) => n + a[metric], 0) / 2;
        const row = { block, order: activeOrder.map(x => x ? 'B' : 'A').join(''), cpu: { off: average(false, 'cpuUs'), on: average(true, 'cpuUs') },
          wall: { off: average(false, 'wallMs'), on: average(true, 'wallMs') }, arms };
        if (block < 0) warmup.push(row); else blocks.push(row);
      }
      const cpu = pairedInterval(blocks.map(b => b.cpu)), wall = pairedInterval(blocks.map(b => b.wall));
      result = { manifestSha: manifest.manifestSha, protocol: COST_PROTOCOL, verdict: verdict(cpu, wall), cpu, wall, warmup, blocks,
        measuredRealSteps: 32 * 4 * 64, warmupRealSteps: 4 * 4 * 64, serializationIncludedInGate: false,
        limitations: 'Synthetic independent full-step inputs, not divergent population trajectories; no SQLite timing, calibration or biological conclusion' };
    }
  }
  const after = frozenEvidence(); assert.deepEqual(after, before, 'Sources changed during instrument execution');
  const final = { result, sources: { before, after }, guards: { initial: initialGuard, final: resourceGuard() } };
  const out = value('--out');
  // Freeze a manifest alone, so the file is independent of timestamps/resources.
  if (out) writeNew(out, args.includes('--manifest') ? manifest : final);
  else process.stdout.write(`${JSON.stringify(args.includes('--manifest') ? manifest : final)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error); process.exitCode = 1; });
