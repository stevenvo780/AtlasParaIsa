import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluatePoliciesCpu, founderPolicy, POLICY_WEIGHTS } from '../src/world/politica.js';
import { localRandom } from '../src/world/genetics.js';
import {
  PolicyGpuBatcher, ResidentPolicyRegistry, closePolicyGpuBatchers, evaluatePoliciesResidentBatch,
  policyGpuResidentStatus, residentPolicyRegistry, type ResidentPolicyActor,
} from '../src/world/gpu/politica-gpu.js';

const W = POLICY_WEIGHTS;
function diffs(a: ArrayLike<number>, b: ArrayLike<number>): number {
  assert.equal(a.length, b.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) n++;
  return n;
}
function exact(a: ArrayLike<number>, b: ArrayLike<number>, label = ''): void {
  assert.equal(diffs(a, b), 0, `0 ULP, including signed zero ${label}`);
}
/** Rows with signed zeros, subnormals and extremes, like politica-evolutiva.test.ts. */
function rows(count: number, width: number, salt: string, lo: number, hi: number): Float64Array {
  const random = localRandom(51926, salt);
  const out = Float64Array.from({ length: count * width }, () => lo + random() * (hi - lo));
  const edge = [0, -0, hi, lo, Number.MIN_VALUE, -Number.MIN_VALUE, hi / 2, lo / 2];
  for (let i = 0; i < Math.min(count, 12); i++) for (let j = 0; j < width; j++) out[i * width + j] = edge[(i * 3 + j) % edge.length]!;
  return out;
}
const weightsOf = (count: number, salt: string) => rows(count, W, 'w:' + salt, -1, 1);
const obsOf = (count: number, salt: string) => rows(count, 12, 'o:' + salt, -1, 1);
const biasOf = (count: number, salt: string) => rows(count, 12, 'b:' + salt, -0.5, 0.5);
/** CPU reference: gather the rows a slot table holds and run evaluatePoliciesCpu. */
function cpuFor(table: Float64Array, slots: Uint32Array, obs: Float64Array, bias: Float64Array | null): Float64Array {
  const gathered = new Float64Array(slots.length * W);
  for (let i = 0; i < slots.length; i++) gathered.set(table.subarray(slots[i]! * W, (slots[i]! + 1) * W), i * W);
  return evaluatePoliciesCpu(obs, gathered, bias, slots.length);
}
function sampleSlots(n: number, from: number, salt: string): Uint32Array {
  const random = localRandom(7, salt), all = Array.from({ length: from }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [all[i], all[j]] = [all[j]!, all[i]!]; }
  return Uint32Array.from(all.slice(0, n));
}
const shmLeaks = () => readdirSync('/dev/shm').filter(f => f.startsWith(`atlas-policy-${process.pid}-`));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

test('resident API without NVRTC/accelerator: honest CPU backend and exact Object.is parity', () => {
  for (const options of [{ nvrtc: '/nonexistent/libnvrtc.so' }, { nvrtc: '/nonexistent/nvrtc.so', scriptPath: '/nonexistent/policy.py' }]) {
    const batcher = new PolicyGpuBatcher([0, 1], options);
    try {
      assert.equal(batcher.backend, 'cpu'); assert.ok(batcher.fallbackReason);
      const P = 600, table = weightsOf(P, 'fallback');
      batcher.syncResidentWeights(Uint32Array.from({ length: P }, (_, i) => i), table, P);
      for (const count of [0, 1, 17, 500]) {
        const slots = sampleSlots(count, P, 'fb' + count), obs = obsOf(count, 'fb' + count), bias = biasOf(count, 'fb' + count);
        for (const b of [null, bias]) exact(batcher.evaluateResident(slots, obs, b, count), cpuFor(table, slots, obs, b));
        const gathered = new Float64Array(count * W);
        for (let i = 0; i < count; i++) gathered.set(table.subarray(slots[i]! * W, (slots[i]! + 1) * W), i * W);
        exact(batcher.evaluateResident(slots, obs, bias, count, gathered), evaluatePoliciesCpu(obs, gathered, bias, count));
      }
      assert.equal(batcher.backend, 'cpu', 'a CPU fallback never reports itself as GPU');
      assert.equal(batcher.residentStats.transport, 'cpu');
      assert.equal(batcher.residentStats.evaluateCalls, 0, 'no GPU evaluation counted');
      // Validation is backend independent.
      assert.throws(() => batcher.evaluateResident(Uint32Array.of(P + 5), obsOf(1, 'x'), null, 1), /Unsynchronised/);
      assert.throws(() => batcher.evaluateResident(Uint32Array.of(0), new Float64Array(12).fill(2), null, 1), /Invalid observations/);
      assert.throws(() => batcher.syncResidentWeights(Uint32Array.of(1, 1), weightsOf(2, 'dup'), P), /Duplicated/);
      assert.throws(() => batcher.syncResidentWeights(Uint32Array.of(0), new Float64Array(W).fill(1.5), P), /Invalid resident weights/);
      assert.throws(() => batcher.syncResidentWeights(Uint32Array.of(P), weightsOf(1, 'cap'), P), /beyond capacity/);
      // The registry runs on the CPU batcher with identical results.
      const registry = new ResidentPolicyRegistry(batcher);
      const actors = population(300, 'fb-registry');
      exact(registry.evaluate(actors), cpuActors(actors));
    } finally { batcher.close(); }
  }
  const actors = population(50, 'no-devices');
  exact(evaluatePoliciesResidentBatch(actors, []), cpuActors(actors));
  assert.deepEqual(shmLeaks(), []);
});

test('resident protocol faults: missing protocol and dying worker fall back exactly and honestly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-policy-resident-'));
  try {
    // Legacy-only worker (no resident flag in ready): resident calls must not pretend GPU.
    const legacy = join(dir, 'legacy.py');
    writeFileSync(legacy, `import json, struct, sys
def send(h, body=b''):
 b=json.dumps(h).encode(); sys.stdout.buffer.write(struct.pack('<I',len(b))+b+body); sys.stdout.buffer.flush()
send({'ready':True})
while sys.stdin.buffer.read(4): pass
`);
    const a = new PolicyGpuBatcher([0], { nvrtc: 'fixture', scriptPath: legacy });
    try {
      assert.equal(a.backend, 'gpu');
      const table = weightsOf(40, 'legacy');
      a.syncResidentWeights(Uint32Array.from({ length: 40 }, (_, i) => i), table, 40);
      assert.equal(a.backend, 'cpu'); assert.match(a.fallbackReason!, /resident protocol/);
      const slots = sampleSlots(20, 40, 'legacy'), obs = obsOf(20, 'legacy'), bias = biasOf(20, 'legacy');
      exact(a.evaluateResident(slots, obs, bias, 20), cpuFor(table, slots, obs, bias));
    } finally { a.close(); }
    // Resident-capable worker that dies mid evaluate_resident (after a good sync).
    const pidPath = join(dir, 'pid'), dying = join(dir, 'dying.py');
    writeFileSync(dying, `import json, struct, sys, os
open(${JSON.stringify(pidPath)}, 'w').write(str(os.getpid()))
def send(h, body=b''):
 b=json.dumps(h).encode(); sys.stdout.buffer.write(struct.pack('<I',len(b))+b+body); sys.stdout.buffer.flush()
send({'ready':True,'resident':True,'shm':False})
while True:
 p=sys.stdin.buffer.read(4)
 if not p: break
 h=json.loads(sys.stdin.buffer.read(struct.unpack('<I',p)[0]))
 if h['kind']=='close': break
 if h['kind']=='sync_weights':
  k=h['count']; left=((k*4+7)//8*8)+k*212*8
  while left:
   b=sys.stdin.buffer.read(min(left,65536))
   if not b: sys.exit(1)
   left-=len(b)
  send({'ok':True,'capacity':h['capacity']}); continue
 sys.exit(3)
`);
    const b = new PolicyGpuBatcher([0, 1], { nvrtc: 'fixture', scriptPath: dying });
    try {
      assert.equal(b.backend, 'gpu');
      const table = weightsOf(100, 'dying');
      b.syncResidentWeights(Uint32Array.from({ length: 100 }, (_, i) => i), table, 100);
      assert.equal(b.backend, 'gpu', 'the sync itself succeeded');
      assert.equal(b.residentStats.transport, 'pipe', 'worker declined shm: pipe framing');
      const pid = Number(readFileSync(pidPath, 'utf8'));
      const slots = sampleSlots(64, 100, 'dying'), obs = obsOf(64, 'dying'), bias = biasOf(64, 'dying');
      const pending = b.beginEvaluateResident(slots, obs, bias, 64);
      exact(pending.wait(), cpuFor(table, slots, obs, bias));
      exact(pending.wait(), cpuFor(table, slots, obs, bias));
      assert.equal(b.backend, 'cpu'); assert.ok(b.fallbackReason);
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    } finally { b.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(shmLeaks(), []);
});

function population(n: number, salt: string, start = 0): ResidentPolicyActor[] {
  return Array.from({ length: n }, (_, k) => {
    const i = start + k, id = `${salt}:${i}`;
    return { id, weights: founderPolicy(4242, id).weights, obs: obsOf(1, id), bias: biasOf(1, id) };
  });
}
function cpuActors(actors: readonly ResidentPolicyActor[]): Float64Array {
  const n = actors.length, obs = new Float64Array(n * 12), w = new Float64Array(n * W), b = new Float64Array(n * 12);
  actors.forEach((a, i) => { obs.set(a.obs, i * 12); w.set(a.weights, i * W); b.set(a.bias, i * 12); });
  return evaluatePoliciesCpu(obs, w, b, n);
}

const nvrtc = process.env.COMPUTE_NVRTC || (existsSync('/opt/cuda/lib64/libnvrtc.so') ? '/opt/cuda/lib64/libnvrtc.so' : null);
const unavailable = /Policy CUDA\/NVRTC result 100\b|libcuda\.so\.1: cannot open shared object file/;
function requireGpu(t: { skip(reason: string): void }, batcher: PolicyGpuBatcher): boolean {
  // Only a missing CUDA runtime/device can skip auto-detection; any other failure fails the gate.
  if (batcher.backend !== 'gpu' && !process.env.COMPUTE_NVRTC && unavailable.test(batcher.fallbackReason ?? '')) {
    t.skip(`CUDA runtime unavailable: ${batcher.fallbackReason}`); return false;
  }
  assert.equal(batcher.backend, 'gpu', batcher.fallbackReason ?? 'GPU required');
  return true;
}

for (const transport of ['shm', 'pipe'] as const) for (const devices of [[0], [1], [0, 1]]) {
  test(`CUDA resident table Object.is parity devices=[${devices}] transport=${transport}: subsets, births, slot reuse, compaction`,
    { skip: nvrtc === null ? 'NVRTC unavailable' : false }, t => {
      const batcher = new PolicyGpuBatcher(devices, { transport });
      try {
        if (!requireGpu(t, batcher)) return;
        assert.equal(batcher.residentStats.transport, transport);
        const P = 4000;
        let capacity = P;
        const table = new Float64Array(8192 * W);
        table.set(weightsOf(P, 'resident'));
        batcher.syncResidentWeights(Uint32Array.from({ length: P }, (_, i) => i), table.subarray(0, P * W), P);
        let checks = 0;
        const check = (slots: Uint32Array, label: string) => {
          const n = slots.length, obs = obsOf(n, label), bias = biasOf(n, label);
          for (const b of [null, bias]) {
            exact(batcher.evaluateResident(slots, obs, b, n), cpuFor(table, slots, obs, b), `${label} bias=${b !== null}`);
            assert.equal(batcher.backend, 'gpu', batcher.fallbackReason ?? 'no disguised fallback');
            checks++;
          }
          // Throughput-balanced shards: tiny batches may legitimately go to one device only.
          if (devices.length === 2 && n >= 500) assert.ok(batcher.residentStats.lastShards.every(s => s > 0), 'both devices computed');
        };
        // Full, sparse subsets (500 of 4000 resident), and tiny / uneven shards.
        check(sampleSlots(4000, P, 'perm'), 'P4000-permuted');
        for (const count of [1, 17, 500]) check(sampleSlots(count, P, 'sub' + count), 'subset' + count);
        // Births: sparse slot additions that grow capacity (geometric on device).
        const births = Uint32Array.from({ length: 300 }, (_, i) => P + 13 * i);
        capacity = P + 13 * 299 + 1;
        const born = weightsOf(births.length, 'births');
        births.forEach((s, i) => table.set(born.subarray(i * W, (i + 1) * W), s * W));
        batcher.syncResidentWeights(births, born, capacity);
        check(Uint32Array.from([...sampleSlots(400, P, 'old'), ...births]), 'with-births');
        check(births.subarray(0, 17), 'only-births');
        // Slot reuse: an actor died, its slot now holds a different genome.
        const reused = Uint32Array.of(5, 77, 3999, births[7]!);
        const fresh = weightsOf(reused.length, 'reuse');
        reused.forEach((s, i) => table.set(fresh.subarray(i * W, (i + 1) * W), s * W));
        batcher.syncResidentWeights(reused, fresh, capacity);
        check(Uint32Array.of(3999, 5, 0, 77, births[7]!, 6), 'reused');
        assert.equal(batcher.residentStats.capacity, capacity);
        // Compaction/reset: the table is re-created; old slots become invalid.
        const compact = weightsOf(10, 'compact');
        table.fill(0); table.set(compact);
        batcher.syncResidentWeights(Uint32Array.from({ length: 10 }, (_, i) => i), compact, 10, true);
        assert.throws(() => batcher.evaluateResident(Uint32Array.of(20), obsOf(1, 'z'), null, 1), /Unsynchronised/);
        check(Uint32Array.of(9, 0, 3, 3), 'after-reset');
        const stats = batcher.residentStats;
        assert.equal(batcher.backend, 'gpu');
        t.diagnostic(`devices=[${devices}] ${transport}: ${checks} batches, 0 Object.is diffs; evaluateUploadedBytes=${stats.evaluateUploadedBytes} weightBytesAvoided=${stats.weightBytesAvoided} syncUploadedBytes=${stats.syncUploadedBytes}`);
      } finally { batcher.close(); }
      assert.deepEqual(shmLeaks(), []);
    });
}

test('ResidentPolicyRegistry on [0,1]: syncs only new genomes, zero weight bytes for known actors, bounded memory',
  { skip: nvrtc === null ? 'NVRTC unavailable' : false }, t => {
    const devices = [0, 1];
    try {
      const registry = residentPolicyRegistry(devices);
      if (!requireGpu(t, registry.batcher)) return;
      let alive = population(4000, 'pop');
      let next = 4000;
      const random = localRandom(99, 'registry');
      let maxResident = 0;
      const ticks = ResidentPolicyRegistry.STALE_CALLS + 2 * ResidentPolicyRegistry.SCAN_EVERY + 30;
      for (let tick = 0; tick < ticks; tick++) {
        // Deaths and births every tick; a sparse subset decides.
        if (tick < 20) {
          alive = alive.filter(() => random() > 0.01);
          alive.push(...population(40, 'pop', next)); next += 40;
        } else if (tick === 20) {
          // Mass die-off: 3000 dead entries must be evicted, then the slot range compacted.
          alive = alive.slice(0, 600);
        }
        const deciding = alive.filter(() => random() < (tick % 10 === 0 ? 1 : 0.15));
        for (const a of deciding) a.obs = obsOf(1, `${a.id}@${tick}`);
        const before = registry.batcher.residentStats;
        const gpu = evaluatePoliciesResidentBatch(deciding, devices);
        exact(gpu, cpuActors(deciding), `tick ${tick}`);
        const after = registry.batcher.residentStats;
        assert.equal(registry.batcher.backend, 'gpu', registry.batcher.fallbackReason ?? 'GPU required');
        const s = registry.stats;
        assert.ok(s.lastSyncedRows <= deciding.length);
        if (tick > 0 && tick < 20 && s.compactions === 0)
          assert.equal(after.syncedRows - before.syncedRows, s.lastSyncedRows, 'only first-seen genomes are uploaded');
        maxResident = Math.max(maxResident, s.residentActors);
        // Before the die-off nobody is stale: everything resident was seen recently.
        if (tick < 20) assert.ok(s.residentActors <= next, `resident=${s.residentActors}`);
      }
      // Once the stale window and a scan period have passed, the 3000+ dead are gone:
      // the registry is bounded by twice the live set.
      assert.ok(registry.stats.residentActors <= 2 * alive.length,
        `resident=${registry.stats.residentActors} alive=${alive.length}`);
      // A batch of already-resident actors uploads zero weight rows.
      const known = alive.slice(0, 500);
      const syncedBefore = registry.batcher.residentStats.syncedRows;
      exact(evaluatePoliciesResidentBatch(known, devices), cpuActors(known));
      assert.equal(registry.batcher.residentStats.syncedRows, syncedBefore);
      assert.equal(registry.stats.lastSyncedRows, 0);
      // A new genome array for the same id is re-synchronised (identity, not id only).
      const mutated = { ...known[0]!, weights: founderPolicy(1, 'other').weights };
      exact(evaluatePoliciesResidentBatch([mutated, ...known.slice(1, 10)], devices), cpuActors([mutated, ...known.slice(1, 10)]));
      assert.equal(registry.stats.lastSyncedRows, 1);
      assert.throws(() => evaluatePoliciesResidentBatch([known[1]!, known[1]!], devices), /Duplicated actor id/);
      const s = registry.stats;
      assert.ok(s.evictedRows >= 3000, `evicted ${s.evictedRows}`);
      assert.ok(s.compactions >= 1, 'slot range compacted after the die-off');
      assert.ok(s.highWater <= 2 * s.residentActors + 1024, `highWater=${s.highWater} resident=${s.residentActors}`);
      const status = policyGpuResidentStatus(devices)!;
      assert.equal(status.backend, 'gpu');
      t.diagnostic(`registry: ${JSON.stringify(s)} maxResident=${maxResident} table=${JSON.stringify(status.table)}`);
    } finally { closePolicyGpuBatchers(); }
  });

for (const P of [4000, 20000]) {
  test(`speedup P=${P} devices=[0,1]: evaluateResident (zero weight bytes) vs full-upload evaluate`,
    { skip: nvrtc === null ? 'NVRTC unavailable' : false }, t => {
      const batcher = new PolicyGpuBatcher([0, 1]);
      try {
        if (!requireGpu(t, batcher)) return;
        const weights = weightsOf(P, 'speed' + P), obs = obsOf(P, 'speed' + P), bias = biasOf(P, 'speed' + P);
        const slots = Uint32Array.from({ length: P }, (_, i) => i);
        const syncStart = performance.now();
        batcher.syncResidentWeights(slots, weights, P);
        const syncMs = performance.now() - syncStart;
        const cpuStart = performance.now();
        const cpu = evaluatePoliciesCpu(obs, weights, bias, P);
        const cpuMs = performance.now() - cpuStart;
        const full: number[] = [], resident: number[] = [];
        for (let r = 0; r < 3; r++) { batcher.evaluate(obs, weights, bias, P); batcher.evaluateResident(slots, obs, bias, P); }
        for (let r = 0; r < 15; r++) {
          let s = performance.now();
          const a = batcher.evaluate(obs, weights, bias, P); full.push(performance.now() - s);
          s = performance.now();
          const b = batcher.evaluateResident(slots, obs, bias, P); resident.push(performance.now() - s);
          if (r === 0) { exact(a, cpu); exact(b, cpu); }
        }
        assert.equal(batcher.backend, 'gpu', batcher.fallbackReason ?? 'GPU required');
        const f = median(full), r = median(resident);
        const fullBytes = P * (224 + 12) * 8, residentBytes = Math.ceil(P * 4 / 8) * 8 + P * 24 * 8;
        t.diagnostic(`P=${P} [0,1]: full evaluate median=${f.toFixed(3)} ms (${fullBytes} B/tick) | evaluateResident median=${r.toFixed(3)} ms (${residentBytes} B/tick, 0 weight bytes) | speedup=${(f / r).toFixed(2)}x | one-off sync=${syncMs.toFixed(2)} ms | CPU=${cpuMs.toFixed(2)} ms | shards=${batcher.residentStats.lastShards} | Object.is diffs=0`);
        assert.ok(r < f, `resident ${r} ms must beat full upload ${f} ms`);
      } finally { batcher.close(); }
    });
}
