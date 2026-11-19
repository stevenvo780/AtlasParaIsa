import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  POLICY_INPUTS, POLICY_HIDDEN, POLICY_ACTIONS, POLICY_WEIGHTS,
  founderPolicy, inheritPolicy, assertPolicyGenome, initialPolicyPlasticity,
  assertPolicyPlasticity, updatePolicyPlasticity, extractLocalObservation,
  evaluatePolicySingle, evaluatePoliciesCpu, policyActionBias, policyDiversity, softSign,
  type PolicyGenome, type LocalObservationInput,
} from '../src/world/politica.js';
import { localRandom } from '../src/world/genetics.js';
import { PolicyGpuBatcher } from '../src/world/gpu/politica-gpu.js';

const zeros = (): PolicyGenome => ({ weights: new Array<number>(212).fill(0) });
function exact(a: ArrayLike<number>, b: ArrayLike<number>): void {
  assert.equal(a.length, b.length);
  let diffs = 0;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) diffs++;
  assert.equal(diffs, 0, '0 ULP, including signed zero');
}
function scene(count: number) {
  const random = localRandom(51926, 'policy-test-batch');
  const observations = Float64Array.from({ length: count * 12 }, () => random() * 2 - 1);
  const weights = Float64Array.from({ length: count * 212 }, () => random() * 2 - 1);
  const biases = Float64Array.from({ length: count * 12 }, () => random() - 0.5);
  // Cover signed zeros, subnormal products, extremes, zero norms and biased zeros.
  const edge = [0, -0, 1, -1, Number.MIN_VALUE, -Number.MIN_VALUE, 0.5, -0.5];
  for (let i = 0; i < Math.min(count, 12); i++) {
    for (let j = 0; j < 12; j++) observations[i * 12 + j] = edge[(i + j) % edge.length];
    for (let j = 0; j < 212; j++) weights[i * 212 + j] = edge[(i * 3 + j) % edge.length];
  }
  if (count) weights.fill(0, 0, 212);
  return { observations, weights, biases };
}

test('fixed 12/8/12 FP64 topology and rational activation', () => {
  assert.equal(POLICY_INPUTS, 12); assert.equal(POLICY_HIDDEN, 8); assert.equal(POLICY_WEIGHTS, 212);
  assert.deepEqual(POLICY_ACTIONS, ['explore', 'eat', 'forage', 'drink', 'hunt', 'rest',
    'share', 'gather', 'farm', 'build', 'cooperate', 'tech']);
  for (const x of [-12, -1, -0, 0, Number.MIN_VALUE, 1, 12]) assert.ok(Object.is(softSign(x), x / (1 + Math.abs(x))));
  assert.ok(Object.is(softSign(-0), -0));
  const cuda = readFileSync(new URL('../scripts/compute-policy-gpu.py', import.meta.url), 'utf8');
  for (const flag of ['--fmad=false', '--prec-div=true', '--ftz=false']) assert.ok(cuda.includes(flag), flag);
  for (const prohibited of ['--fmad=true', 'use_fast_math', 'fma(']) assert.ok(!cuda.includes(prohibited), prohibited);
});

test('seeded founder variance and independent identity; no process randomness', () => {
  const a = founderPolicy(7, 'a');
  assertPolicyGenome(a);
  assert.deepEqual(founderPolicy(7, 'a'), a);
  assert.notDeepEqual(founderPolicy(8, 'a'), a);
  assert.notDeepEqual(founderPolicy(7, 'b'), a);
  assert.deepEqual(Object.keys(a), ['weights']);
  assert.ok(founderPolicy(7, 'a', 0).weights.every(x => x === 0));
  for (const x of [-1, NaN, Infinity, 1.1]) assert.throws(() => founderPolicy(1, 'a', x));
  const population = Array.from({ length: 100 }, (_, i) => founderPolicy(42, String(i)));
  const mean = population.flatMap(g => g.weights).reduce((s, x) => s + x, 0) / (100 * 212);
  assert.ok(Math.abs(mean) < 0.02, `mean=${mean}`);
  assert.ok(policyDiversity(population) > 0.9);
  const source = readFileSync(new URL('../src/world/politica.ts', import.meta.url), 'utf8');
  for (const token of ['Math.random', 'Date.now', 'performance.now', 'process.hrtime', 'os.cpus'])
    assert.ok(!source.includes(token), token);
});

test('recombination/mutation deterministic, bounded, isolated from lifetime learning', () => {
  const a = founderPolicy(1, 'a'), b = founderPolicy(2, 'b');
  const before = structuredClone([a, b]);
  const child = inheritPolicy(42, 'child', a, b);
  assert.deepEqual(inheritPolicy(42, 'child', a, b), child);
  assert.notDeepEqual(inheritPolicy(42, 'other', a, b), child);
  assert.notDeepEqual(inheritPolicy(43, 'child', a, b), child);
  const noMutation = inheritPolicy(42, 'child', a, b, 0);
  assert.ok(noMutation.weights.every((x, i) => x === a.weights[i] || x === b.weights[i]));
  assert.notDeepEqual(inheritPolicy(42, 'child', a, b, 1), noMutation);
  assertPolicyGenome(child);
  const learned = initialPolicyPlasticity();
  updatePolicyPlasticity(learned, 'forage', 0.5, 0.2);
  assert.deepEqual(inheritPolicy(42, 'child', a, b), child);
  assert.deepEqual([a, b], before);
  const born = initialPolicyPlasticity();
  assert.ok(born.bias.every(x => Object.is(x, 0)) && born.trace.every(x => Object.is(x, 0)));
  assert.notStrictEqual(born.bias, learned.bias);
  assert.notStrictEqual(child.weights, a.weights);
  for (const rate of [-1, 1.1, NaN, Infinity]) assert.throws(() => inheritPolicy(1, 'x', a, b, rate));
});

test('closed genome/plasticity validation rejects corrupt, sparse and mixed state', () => {
  for (const bad of [null, {}, [], { weights: [] }, { weights: new Float64Array(212) },
    { weights: Array(212) }, { ...zeros(), bias: Array(12).fill(0) },
    ...[NaN, Infinity, -Infinity, -1.01, 1.01, '0', undefined].map(x => ({ weights: Array(212).fill(x) }))])
    assert.throws(() => assertPolicyGenome(bad));
  for (const bad of [null, {}, [], { bias: [], trace: [] }, { bias: Array(12), trace: Array(12).fill(0) },
    { ...initialPolicyPlasticity(), weights: zeros().weights },
    ...[NaN, Infinity, 0.51, -0.51].map(x => ({ bias: Array(12).fill(x), trace: Array(12).fill(0) })),
    ...[NaN, Infinity, -0.1, 1.01].map(x => ({ bias: Array(12).fill(0), trace: Array(12).fill(x) }))])
    assert.throws(() => assertPolicyPlasticity(bad));
  assertPolicyGenome({ weights: Array(212).fill(-1) });
  assertPolicyGenome({ weights: Array(212).fill(1) });
  assertPolicyPlasticity({ bias: Array(12).fill(-0.5), trace: Array(12).fill(1) });
  const aliased = Array(12).fill(0);
  assert.throws(() => assertPolicyPlasticity({ bias: aliased, trace: aliased }));
});

test('local observed benefit uses decaying eligibility, sign, bounds and tech family', () => {
  const p = initialPolicyPlasticity();
  updatePolicyPlasticity(p, 'forage', 0.5, 0.2);
  assert.equal(p.bias[2], 0.1); assert.equal(p.trace[2], 1);
  updatePolicyPlasticity(p, 'drink', -0.25, 0.2);
  assert.equal(p.trace[2], 0.8); assert.equal(p.trace[3], 1);
  assert.ok(Math.abs(p.bias[2] - 0.06) < 1e-15); assert.equal(p.bias[3], -0.05);
  const before = structuredClone(p);
  updatePolicyPlasticity(p, 'research', 0, 0.2);
  assert.deepEqual(p.bias, before.bias); assert.equal(p.trace[11], 1);
  updatePolicyPlasticity(p, 'repair', 1, 0.2);
  assert.equal(p.bias[11], 0.2);
  const paused = structuredClone(p);
  updatePolicyPlasticity(p, 'eat', 1, 0);
  updatePolicyPlasticity(p, 'unknown', 1, 0.2);
  assert.deepEqual(p, paused);
  for (let i = 0; i < 100; i++) updatePolicyPlasticity(p, 'eat', 100, 1);
  assert.equal(p.bias[1], 0.5);
  for (let i = 0; i < 100; i++) updatePolicyPlasticity(p, 'eat', -100, 1);
  assert.equal(p.bias[1], -0.5); assertPolicyPlasticity(p);
  for (const [benefit, rate] of [[NaN, 0.1], [Infinity, 0.1], [1, -1], [1, NaN], [1, 1.1]])
    assert.throws(() => updatePolicyPlasticity(p, 'eat', benefit, rate));
  const obs = new Float64Array(12);
  assert.notDeepEqual(evaluatePolicySingle(obs, zeros().weights, p.bias), evaluatePolicySingle(obs, zeros().weights));
});

test('observation ordering, saturation, finite guard; only explicit local inputs', () => {
  const input: LocalObservationInput = { hunger: 0, thirst: 0.1, fatigue: 0.2, energy: 0.3,
    inventoryFrac: 0.4, localFood: 0.5, localWater: 0.6, localCrowd: 0.7,
    localShelter: 0.8, localResources: 0.9, communityTrust: 1, biomeNovelty: 0.25 };
  exact(extractLocalObservation(input), Float64Array.from(Object.values(input), x => x * 2 - 1));
  const saturated = extractLocalObservation({ ...input, hunger: -10, biomeNovelty: 10 });
  assert.equal(saturated[0], -1); assert.equal(saturated[11], 1);
  for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => extractLocalObservation({ ...input, energy: value }));
  assert.throws(() => extractLocalObservation({} as LocalObservationInput));
});

test('single network arithmetic and FP64 batched results are identical', () => {
  const w = zeros().weights;
  w[0] = 0.5; w[96] = 0.25; w[104] = 0.75; w[200] = -0.125;
  const o = new Float64Array(12); o[0] = 0.5;
  const b = Array(12).fill(0); b[0] = 0.25;
  const expected = softSign(-0.125 + softSign(0.25 + 0.5 * 0.5) * 0.75 + 0.25);
  assert.ok(Object.is(evaluatePolicySingle(o, w, b)[0], expected));
  const { observations, weights, biases } = scene(257);
  for (const plasticity of [null, biases]) {
    const batch = evaluatePoliciesCpu(observations, weights, plasticity, 257);
    for (let i = 0; i < 257; i++) {
      exact(batch.subarray(i * 12, (i + 1) * 12), evaluatePolicySingle(
        observations.subarray(i * 12, (i + 1) * 12), weights.subarray(i * 212, (i + 1) * 212),
        plasticity ? Array.from(plasticity.subarray(i * 12, (i + 1) * 12)) : undefined));
    }
    assert.ok(batch.every(x => Number.isFinite(x) && x > -1 && x < 1));
  }
  assert.equal(evaluatePoliciesCpu(new Float64Array(), new Float64Array(), null, 0).length, 0);
  for (const count of [-1, 0.5, NaN, Infinity]) assert.throws(() => evaluatePoliciesCpu(o, Float64Array.from(w), null, count));
  assert.throws(() => evaluatePoliciesCpu(o, Float64Array.from(w), new Float64Array(11), 1));
  assert.throws(() => evaluatePoliciesCpu(o, new Float64Array(211), null, 1));
  assert.throws(() => evaluatePolicySingle(new Float64Array(11), w));
  for (const invalid of [NaN, Infinity, -1.01, 1.01]) {
    const bad = Float64Array.from(w); bad[0] = invalid;
    assert.throws(() => evaluatePoliciesCpu(o, bad, null, 1));
    assert.throws(() => evaluatePolicySingle(o, bad));
  }
  assert.throws(() => evaluatePolicySingle(o, w, [0]));
});

test('CPU evaluation timing P=4000, with and without lifetime plasticity', t => {
  const { observations, weights, biases } = scene(4000);
  for (const plasticity of [null, biases]) {
    const start = performance.now();
    const scores = evaluatePoliciesCpu(observations, weights, plasticity, 4000);
    const ms = performance.now() - start;
    assert.equal(scores.length, 48000);
    assert.ok(scores.every(x => Number.isFinite(x) && x > -1 && x < 1));
    t.diagnostic(`CPU P=4000 bias=${plasticity !== null}: ${ms.toFixed(3)} ms`);
  }
});

test('action bias maps all tech actions and disables without inspecting scores', () => {
  const scores = Float64Array.from({ length: 12 }, (_, i) => (i - 6) / 12);
  for (const [i, action] of POLICY_ACTIONS.entries()) assert.equal(policyActionBias(scores, action, 0.4), scores[i] * 0.4);
  for (const action of ['research', 'craft', 'invent', 'repair']) assert.equal(policyActionBias(scores, action, 2), scores[11] * 2);
  assert.equal(policyActionBias([], 'eat', 0), 0);
  assert.equal(policyActionBias([], 'eat', -1), 0);
  assert.equal(policyActionBias([], 'absent', 1), 0);
  assert.throws(() => policyActionBias(scores, 'eat', NaN));
});

function diversityReference(genomes: readonly PolicyGenome[]): number {
  if (genomes.length < 2) return 0;
  const unit = genomes.map(g => {
    const norm = Math.sqrt(g.weights.reduce((s, x) => s + x * x, 0));
    return norm === 0 ? null : g.weights.map(x => x / norm);
  });
  let total = 0, pairs = 0;
  for (let i = 0; i < unit.length; i++) for (let j = i + 1; j < unit.length; j++) {
    const a = unit[i], b = unit[j];
    if (a && b) {
      let squared = 0;
      for (let k = 0; k < 212; k++) squared += (a[k] - b[k]) ** 2;
      total += squared / 2;
    } else if (a || b) total++;
    pairs++;
  }
  return total / pairs;
}
test('linear cosine/L2 diversity matches quadratic oracle within 1e-12, P=4000 timing', t => {
  const positive = { weights: Array(212).fill(1) }, negative = { weights: Array(212).fill(-1) };
  for (const genomes of [[], [zeros()], [zeros(), zeros()], [zeros(), positive], [positive, negative],
    Array(100).fill(positive), [zeros(), ...Array.from({ length: 128 }, (_, i) => founderPolicy(7, String(i)))]]) {
    const expected = diversityReference(genomes), actual = policyDiversity(genomes);
    assert.ok(Math.abs(expected - actual) < 1e-12, `expected=${expected} actual=${actual}`);
  }
  assert.equal(policyDiversity([zeros(), positive]), 1);
  assert.ok(Math.abs(policyDiversity([positive, negative]) - 2) < 1e-12);
  const tiny = { weights: Array(212).fill(Number.MIN_VALUE) };
  assert.ok(Math.abs(policyDiversity([tiny, negative]) - 2) < 1e-12);
  const population = Array.from({ length: 4000 }, (_, i) => founderPolicy(42, String(i)));
  const start = performance.now(), score = policyDiversity(population), ms = performance.now() - start;
  const refStart = performance.now(), reference = diversityReference(population), refMs = performance.now() - refStart;
  assert.ok(Math.abs(score - reference) < 1e-12, `P=4000 expected=${reference} actual=${score}`);
  assert.ok(Number.isFinite(score) && score > 0.9 && score < 1.1);
  t.diagnostic(`policyDiversity P=4000 W=212 O(P*W): ${ms.toFixed(3)} ms; O(P²*W): ${refMs.toFixed(3)} ms; error=${Math.abs(score - reference)}`);
  assert.throws(() => policyDiversity([{ weights: [] }]));
});

test('GPU unavailable: explicit CPU fallback, reusable batches, validation and close', () => {
  const batcher = new PolicyGpuBatcher([0], { nvrtc: '/nonexistent/nvrtc.so', scriptPath: '/nonexistent/policy.py' });
  try {
    assert.equal(batcher.backend, 'cpu'); assert.ok(batcher.fallbackReason);
    for (const count of [0, 1, 33, 2]) {
      const { observations, weights, biases } = scene(count);
      exact(batcher.evaluate(observations, weights, biases, count), evaluatePoliciesCpu(observations, weights, biases, count));
    }
    assert.throws(() => batcher.evaluate(new Float64Array(12), new Float64Array(1), null, 1));
  } finally { batcher.close(); batcher.close(); }
  assert.throws(() => batcher.evaluate(new Float64Array(), new Float64Array(), null, 0), /closed/);
  for (const devices of [[], [-1], [0, 0], [NaN], [0.5]]) assert.throws(() => new PolicyGpuBatcher(devices));
});

test('persistent binary worker protocol: reuse, process failure and deterministic child cleanup', () => {
  // Transport fixture only; actual CUDA parity is a separate test below.
  const dir = mkdtempSync(join(tmpdir(), 'atlas-policy-test-'));
  const script = join(dir, 'fixture.py'), pidPath = join(dir, 'pid');
  writeFileSync(script, `import json, struct, sys, os
open(${JSON.stringify(pidPath)}, 'w').write(str(os.getpid()))
def send(h, body=b''):
 b=json.dumps(h).encode(); sys.stdout.buffer.write(struct.pack('<I',len(b))+b+body); sys.stdout.buffer.flush()
send({'ready':True})
while True:
 p=sys.stdin.buffer.read(4)
 if not p: break
 h=json.loads(sys.stdin.buffer.read(struct.unpack('<I',p)[0]))
 if h['kind']=='close': break
 n=h['count']; left=n*(224+(12 if h['biases'] else 0))*8
 while left:
  b=sys.stdin.buffer.read(min(left,4096))
  if not b: sys.exit(1)
  left-=len(b)
 if n==13: sys.exit(3)
 if n==7: sys.stdin.buffer.read(1)
 send({'bytes':n*12*8}, bytes(n*12*8))
`);
  const batcher = new PolicyGpuBatcher([0, 1], { nvrtc: 'fixture', scriptPath: script });
  try {
    assert.equal(batcher.backend, 'gpu');
    const pid = Number(readFileSync(pidPath, 'utf8'));
    for (const n of [1, 4000, 2]) {
      exact(batcher.evaluate(new Float64Array(n * 12), new Float64Array(n * 212), null, n), new Float64Array(n * 12));
      assert.equal(Number(readFileSync(pidPath, 'utf8')), pid, 'same persistent subprocess');
    }
    const { observations, weights, biases } = scene(13);
    exact(batcher.evaluate(observations, weights, biases, 13), evaluatePoliciesCpu(observations, weights, biases, 13));
    assert.equal(batcher.backend, 'cpu'); assert.ok(batcher.fallbackReason);
  } finally { batcher.close(); }
  const closing = new PolicyGpuBatcher([0], { nvrtc: 'fixture', scriptPath: script });
  const pid = Number(readFileSync(pidPath, 'utf8'));
  closing.close(); closing.close();
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  const timed = new PolicyGpuBatcher([0], { nvrtc: 'fixture', scriptPath: script, timeoutMs: 1000 });
  const timedPid = Number(readFileSync(pidPath, 'utf8'));
  try {
    const s = scene(7);
    exact(timed.evaluate(s.observations, s.weights, s.biases, 7), evaluatePoliciesCpu(s.observations, s.weights, s.biases, 7));
    assert.equal(timed.backend, 'cpu'); assert.match(timed.fallbackReason!, /timed out/);
    assert.throws(() => process.kill(timedPid, 0), /ESRCH/);
  } finally { timed.close(); }
  rmSync(dir, { recursive: true, force: true });
});

const nvrtc = process.env.COMPUTE_NVRTC || (existsSync('/opt/cuda/lib64/libnvrtc.so') ? '/opt/cuda/lib64/libnvrtc.so' : null);
for (const devices of [[0], [1], [0, 1]]) {
  test(`actual CUDA FP64 Object.is parity P=4000 devices=[${devices}]`, { skip: nvrtc === null ? 'NVRTC unavailable' : false }, t => {
    const start = performance.now(), batcher = new PolicyGpuBatcher(devices);
    const startup = performance.now() - start;
    try {
      const unavailable = /Policy CUDA\/NVRTC result 100\b|libcuda\.so\.1: cannot open shared object file/;
      // Only a missing CUDA runtime/device can skip auto-detection. Compilation,
      // protocol or kernel errors on available hardware must fail this gate.
      if (batcher.backend !== 'gpu' && !process.env.COMPUTE_NVRTC && unavailable.test(batcher.fallbackReason ?? '')) {
        t.skip(`CUDA runtime unavailable: ${batcher.fallbackReason}`); return;
      }
      assert.equal(batcher.backend, 'gpu', batcher.fallbackReason ?? 'GPU required');
      const { observations, weights, biases } = scene(4000);
      for (const plasticity of [null, biases]) {
        const cpuStart = performance.now();
        const cpu = evaluatePoliciesCpu(observations, weights, plasticity, 4000);
        const cpuMs = performance.now() - cpuStart;
        const gpuStart = performance.now();
        const gpu = batcher.evaluate(observations, weights, plasticity, 4000);
        const gpuMs = performance.now() - gpuStart;
        assert.equal(batcher.backend, 'gpu', batcher.fallbackReason ?? 'GPU required, no disguised fallback');
        exact(cpu, gpu);
        exact(gpu, batcher.evaluate(observations, weights, plasticity, 4000));
        assert.equal(batcher.backend, 'gpu', batcher.fallbackReason ?? 'GPU repeat required');
        t.diagnostic(`P=4000 devices=[${devices}] bias=${plasticity !== null}: startup=${startup.toFixed(3)} ms CPU=${cpuMs.toFixed(3)} ms GPU transfer+kernel=${gpuMs.toFixed(3)} ms Object.is diffs=0`);
      }
      // Reuse allocation after shrink/grow, and exercise an uneven shard / empty shard.
      for (const n of [0, 1, 17, 4001]) {
        const s = scene(n);
        exact(batcher.evaluate(s.observations, s.weights, s.biases, n), evaluatePoliciesCpu(s.observations, s.weights, s.biases, n));
        assert.equal(batcher.backend, 'gpu', batcher.fallbackReason ?? 'GPU required');
      }
    } finally { batcher.close(); }
  });
}
