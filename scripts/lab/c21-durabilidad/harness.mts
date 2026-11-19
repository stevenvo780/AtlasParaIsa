import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { Gesture, GestureResult } from '../../../src/shared/types.js';
import { CASES, LIMITS, SCHEMA, assess, parseMessage, type BoundaryMessage, type CaseId, type Phase } from './protocol.js';
import { readDatabaseDigest, type DatabaseDigest } from './database-digest.js';

const SELF = fileURLToPath(import.meta.url);
const WORKTREE = resolve(dirname(SELF), '../../..');
const OWNED = join(WORKTREE, '.orchestration/c21-durabilidad-v1');
const PINSET = join(OWNED, 'PINSET-v2.json');
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
function assertPrivatePath(path: string): void {
  let part = resolve(path);
  while (part !== dirname(part)) {
    if (existsSync(part) && lstatSync(part).isSymbolicLink()) throw new Error('SYMLINK_IN_PRIVATE_OUTPUT');
    part = dirname(part);
  }
  if (!resolve(path).startsWith(OWNED + sep)) throw new Error('OUTSIDE_OWNED_AREA');
}
function sourcePins(): string {
  const raw = readFileSync(PINSET);
  const spec: { schema: string; files: { path: string; sha256: string }[];
    node: { path: string; sha256: string } } = JSON.parse(raw.toString());
  if (spec.schema !== 'c21-author-pinset/v1' || !Array.isArray(spec.files) || !spec.files.length)
    throw new Error('INVALID_PINSET');
  for (const entry of spec.files) {
    if (typeof entry.path !== 'string' || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256))
      throw new Error('INVALID_PIN');
    const path = resolve(WORKTREE, entry.path);
    if (!path.startsWith(WORKTREE + sep) || hash(readFileSync(path)) !== entry.sha256)
      throw new Error('SOURCE_PIN_CHANGED: ' + entry.path);
  }
  if (process.execPath !== spec.node.path || hash(readFileSync(process.execPath)) !== spec.node.sha256)
    throw new Error('NODE_RUNTIME_PIN_CHANGED');
  return hash(raw);
}
function effectiveContainment(): { cpuCount: number; memoryBytes: number } {
  const entry = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(s => s.startsWith('0::'));
  if (!entry) throw new Error('CGROUP_V2_REQUIRED');
  const root = '/sys/fs/cgroup';
  let current = resolve(root, '.' + entry.slice(3)), cpuCount = Infinity, memoryBytes = Infinity;
  if (!(current === root || current.startsWith(root + sep))) throw new Error('INVALID_CGROUP');
  while (true) {
    if (current === root) break; // The cgroup v2 root has no cpu.max/memory.max controls.
    const cpu = readFileSync(join(current, 'cpu.max'), 'utf8').trim().split(/\s+/);
    if (cpu[0] !== 'max') {
      const quota = Number(cpu[0]), period = Number(cpu[1]);
      if (!(quota > 0 && period > 0)) throw new Error('INVALID_CPU_QUOTA');
      cpuCount = Math.min(cpuCount, quota / period);
    }
    const mem = readFileSync(join(current, 'memory.max'), 'utf8').trim();
    if (mem !== 'max') {
      const value = Number(mem); if (!(value > 0)) throw new Error('INVALID_MEMORY_QUOTA');
      memoryBytes = Math.min(memoryBytes, value);
    }
    current = dirname(current);
  }
  if (cpuCount > LIMITS.cpuCount || memoryBytes > LIMITS.memoryGiB * 2 ** 30)
    throw new Error('BOUNDED_4CPU_8GIB_CONTAINMENT_REQUIRED');
  return { cpuCount, memoryBytes };
}
function outputBytes(path: string): number {
  let bytes = 0;
  for (const name of readdirSync(path)) {
    const p = join(path, name), s = lstatSync(p);
    if (s.isSymbolicLink()) throw new Error('OUTPUT_SYMLINK');
    bytes += s.isDirectory() ? outputBytes(p) : s.size;
  }
  return bytes;
}
async function readStoreCut(path: string, gesture: Gesture): Promise<{ tick: number; result: GestureResult | null }> {
  const { Store } = await import('../../../src/server/store.js');
  const reader = new Store(path, { readOnly: true });
  try {
    const loaded = reader.load();
    if (!loaded) throw new Error('NO_COMMITTED_WORLD');
    return { tick: loaded.world.tick, result: reader.result(gesture) };
  } finally { reader.close(); }
}
/** Worker ONLY: instance-local SQL interception, preserving every real SQL call. No src hook patch. */
async function worker(caseId: string, directory: string, expectedPinset: string,
  controllerPid: number, controllerCookie: string): Promise<never> {
  const planned = CASES.find(c => c.id === caseId);
  if (!planned) throw new Error('UNPLANNED_CASE');
  assertPrivatePath(directory);
  if (!Number.isSafeInteger(controllerPid) || controllerPid !== process.ppid
    || !/^[0-9a-f]{32}$/.test(controllerCookie)) throw new Error('INVALID_OWN_CONTROLLER');
  if (sourcePins() !== expectedPinset) throw new Error('ADMISSION_PINSET_CHANGED');
  if (process.env.CARTA_DATA_DIR !== directory || !process.env.TMPDIR?.startsWith(directory + sep))
    throw new Error('PRIVATE_DATA_AND_TMP_REQUIRED');
  const { Store } = await import('../../../src/server/store.js');
  const { createWorld, stepWorld } = await import('../../../src/world/index.js');
  const path = join(directory, 'world.sqlite');
  const store = new Store(path);
  const world = createWorld(51926); // TEST_FIXTURE seed; no scientific seed or panel.
  const person = world.people[0];
  if (!person) throw new Error('FIXTURE_HAS_NO_ACTOR');
  const gesture: Gesture = { id: 'c21-technical-' + planned.id, kind: 'command',
    x: person.x, y: person.y, agentId: person.id, order: 'rest' };
  let sequence = 0;
  const send = (message: Omit<BoundaryMessage, 'schema' | 'caseId' | 'sequence' | 'gestureId'>): void => {
    const text = JSON.stringify({ ...message, schema: SCHEMA, caseId: planned.id,
      sequence: ++sequence, gestureId: gesture.id, controllerPid, controllerCookie }) + '\n';
    if (Buffer.byteLength(text) > 8192) throw new Error('OVERSIZE_CONTROL_MESSAGE');
    const bytes = Buffer.from(text); let at = 0;
    while (at < bytes.length) at += writeSync(3, bytes, at, bytes.length - at);
  };
  const awaitController = (): Promise<void> => new Promise((yes, no) => {
    const cleanup = (): void => {
      clearTimeout(timer); process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd); process.stdin.removeListener('error', onError);
      process.stdin.pause();
    };
    const onData = (bytes: Buffer): void => {
      cleanup();
      if (bytes.length !== 1 || bytes[0] !== 67) no(new Error('INVALID_CONTROLLER_CONTINUE'));
      else yes();
    };
    const onEnd = (): void => { cleanup(); no(new Error('CONTROLLER_DISCONNECTED')); };
    const onError = (error: Error): void => { cleanup(); no(error); };
    const timer = setTimeout(() => { cleanup(); no(new Error('CONTROLLER_WAIT_TIMEOUT')); }, LIMITS.caseSeconds * 1000);
    process.stdin.once('data', onData); process.stdin.once('end', onEnd);
    process.stdin.once('error', onError); process.stdin.resume();
  });
  const halt = (phase: Phase, kind: 'boundary' | 'store-api-ack', result?: GestureResult): never => {
    send({ kind, phase, tick: world.tick,
      source: kind === 'boundary' ? 'Store.save' : 'Store.result+independent-Store.load',
      ...(result ? { resultBody: JSON.stringify(result), resultHash: hash(JSON.stringify(result)) } : {}) });
    // Synchronous frontier is held before returning to Store/App. Only owned parent can kill this worker.
    const gate = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(gate, 0, 0, LIMITS.caseSeconds * 1000);
    throw new Error('WORKER_FRONTIER_TIMEOUT');
  };
  store.save(world);
  send({ kind: 'baseline', tick: world.tick, source: 'Store.save' });
  await awaitController();
  const results = stepWorld(world, [gesture], store.context);
  const result = results[0];
  if (results.length !== 1 || !result) throw new Error('UNBOUND_GESTURE_RESULT');
  // This receipt describes a proposed result, NOT a commit or ACK.
  send({ kind: 'candidate', tick: world.tick, source: 'Store.save',
    resultBody: JSON.stringify(result), resultHash: hash(JSON.stringify(result)) });
  await awaitController();
  const originalExec = store.db.exec.bind(store.db);
  let beginSeen = false, commitSeen = false;
  const interceptedExec = (sql: string): void => {
    if (sql === 'BEGIN IMMEDIATE') {
      if (beginSeen) throw new Error('MULTIPLE_SAVE_TRANSACTIONS');
      beginSeen = true;
      if (planned.phase === 'B01_BEFORE_BEGIN') halt(planned.phase, 'boundary');
    }
    originalExec(sql); // Real DatabaseSync executes exactly once; no synthetic success.
    if (sql === 'BEGIN IMMEDIATE' && planned.phase === 'B02_AFTER_BEGIN') halt(planned.phase, 'boundary');
    if (sql === 'COMMIT') {
      // prepareTechnology may finish its own readonly BEGIN/COMMIT before save's BEGIN IMMEDIATE.
      if (!beginSeen) return;
      if (commitSeen || store.db.isTransaction) throw new Error('UNVERIFIED_COMMIT_BOUNDARY');
      commitSeen = true;
      if (planned.phase === 'AFTER_COMMIT_BEFORE_ACK') halt(planned.phase, 'boundary');
    }
  };
  store.db.exec = interceptedExec;
  if (store.db.exec !== interceptedExec) throw new Error('SQL_BOUNDARY_OVERRIDE_NOT_INSTALLED');
  store.save(world, [{ gesture, result }]);
  if (!commitSeen || planned.phase !== 'AFTER_ACK') throw new Error('PLANNED_BOUNDARY_NOT_REACHED');
  const cut = await readStoreCut(path, gesture);
  if (cut.tick !== result.tick || !cut.result || JSON.stringify(cut.result) !== JSON.stringify(result)
    || JSON.stringify(store.result(gesture)) !== JSON.stringify(result)) throw new Error('ACK_WITHOUT_COMMITTED_RESULT');
  // A technical Store API response; explicitly NOT HTTP/WebSocket delivery or a power-loss guarantee.
  halt('AFTER_ACK', 'store-api-ack', result);
}

async function runCase(caseId: CaseId, root: string, totalStarted: number, expectedPinset: string) {
  const planned = CASES.find(c => c.id === caseId);
  if (!planned) throw new Error('UNPLANNED_CASE');
  const directory = join(root, caseId); mkdirSync(directory, { mode: 0o700 });
  const tmp = join(directory, 'tmp'); mkdirSync(tmp, { mode: 0o700 });
  const cache = join(directory, 'compile-cache'); mkdirSync(cache, { mode: 0o700 });
  const loader = pathToFileURL(join(WORKTREE, 'node_modules/tsx/dist/loader.mjs')).href;
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
    CARTA_DATA_DIR: directory, TMPDIR: tmp, NODE_COMPILE_CACHE: cache,
    OMP_NUM_THREADS: '4', OPENBLAS_NUM_THREADS: '4' };
  const controllerCookie = randomBytes(16).toString('hex');
  const child = spawn(process.execPath, ['--import', loader, SELF, '--worker', caseId, directory, expectedPinset,
    String(process.pid), controllerCookie], {
    cwd: WORKTREE, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true,
  });
  if (!child.pid || !child.stdin || !child.stdout || !child.stderr) throw new Error('CHILD_START_FAILED');
  const childInput = child.stdin;
  const pid = child.pid, events = join(directory, 'controller-receipts.jsonl');
  const log = (value: unknown): void => {
    appendFileSync(events, JSON.stringify(value) + '\n', { mode: 0o600 });
    if (statSync(events).size > LIMITS.receiptBytes) throw new Error('RECEIPT_BUDGET_EXCEEDED');
    const fd = openSync(events, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  const kill = (): boolean => {
    try { process.kill(-pid, 'SIGKILL'); return true; } catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'ESRCH')) throw e;
      return false;
    }
  };
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((yes, no) => {
    child.once('error', no); child.once('exit', (code, signal) => yes({ code, signal }));
  });
  let stopped = false, failure: string | null = null;
  const fail = (reason: unknown): void => {
    if (failure === null) failure = reason instanceof Error ? reason.message : String(reason);
    kill();
  };
  const started = performance.now();
  const monitor = setInterval(() => {
    try {
      if (performance.now() - started > LIMITS.caseSeconds * 1000
        || performance.now() - totalStarted > LIMITS.totalSeconds * 1000) throw new Error('WALL_TIME_BUDGET');
      if (outputBytes(root) > LIMITS.outputBytes) throw new Error('OUTPUT_BUDGET');
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? '0') * 1024;
      if (rss + process.memoryUsage().rss > LIMITS.memoryGiB * 2 ** 30) throw new Error('RSS_BUDGET');
    } catch (e) {
      if (!stopped) fail(e);
    }
  }, 250);
  for (const [stream, name] of [[child.stdout, 'stdout.log'], [child.stderr, 'stderr.log']] as const) {
    stream.on('data', (bytes: Buffer) => {
      try {
        const path = join(directory, name); appendFileSync(path, bytes, { mode: 0o600 });
        if (statSync(path).size > LIMITS.receiptBytes) throw new Error('LOG_BUDGET');
      } catch (e) { fail(e); }
    });
  }
  let baseline: DatabaseDigest | null = null, preKill: DatabaseDigest | null = null;
  let gesture: Gesture | null = null, expectedBody: string | null = null;
  let expectedTick = planned.committed ? 1 : 0, reached: Phase | null = null, ackReceived = false, lastSequence = 0;
  let boundaryKillAccepted = false;
  let buffer = '', processing = Promise.resolve();
  const handle = async (raw: unknown): Promise<void> => {
    if (!raw || typeof raw !== 'object' || !('controllerPid' in raw) || raw.controllerPid !== process.pid
      || !('controllerCookie' in raw) || raw.controllerCookie !== controllerCookie)
      throw new Error('UNBOUND_OWN_CHILD_RECEIPT');
    const m = parseMessage(raw);
    if (m.caseId !== caseId || m.sequence !== lastSequence + 1) throw new Error('CONTROL_SEQUENCE_GAP');
    lastSequence = m.sequence;
    const { controllerCookie: _privateCookie, ...visible } = raw;
    log({ from: 'child', receivedAt: new Date().toISOString(), pid, message: visible });
    const path = join(directory, 'world.sqlite');
    if (m.kind === 'baseline') {
      if (m.sequence !== 1 || m.tick !== 0) throw new Error('INVALID_BASELINE');
      baseline = readDatabaseDigest(path); writeJson(join(directory, 'baseline-full-db.json'), baseline);
      const { Store } = await import('../../../src/server/store.js');
      const reader = new Store(path, { readOnly: true });
      try {
        const loaded = reader.load(); if (!loaded || loaded.world.tick !== 0) throw new Error('BASELINE_LOAD');
        const person = loaded.world.people[0]; if (!person) throw new Error('NO_BASELINE_ACTOR');
        gesture = { id: m.gestureId, kind: 'command', x: person.x, y: person.y, agentId: person.id, order: 'rest' };
        if (reader.result(gesture)) throw new Error('BASELINE_INPUT_ALREADY_COMMITTED');
      } finally { reader.close(); }
      childInput.write('C');
    } else if (m.kind === 'candidate') {
      if (!baseline || !gesture || m.tick !== 1 || !m.resultBody || hash(m.resultBody) !== m.resultHash)
        throw new Error('INVALID_CANDIDATE');
      expectedBody = m.resultBody; childInput.write('C');
    } else {
      if (!baseline || !gesture || !expectedBody || m.tick !== 1) throw new Error('BOUNDARY_BEFORE_CANDIDATE');
      const phase = m.kind === 'store-api-ack' ? 'AFTER_ACK' : m.phase;
      if (phase !== planned.phase) throw new Error('WRONG_PHASE');
      const cut = await readStoreCut(path, gesture);
      if (planned.committed ? JSON.stringify(cut.result) !== expectedBody : cut.result !== null)
        throw new Error('PRE_KILL_COMMIT_CONTRADICTION');
      if (cut.tick !== expectedTick) throw new Error('PRE_KILL_TICK_CONTRADICTION');
      preKill = readDatabaseDigest(path); writeJson(join(directory, 'pre-kill-full-db.json'), preKill);
      ackReceived = m.kind === 'store-api-ack';
      if (ackReceived && (m.resultBody !== expectedBody || hash(m.resultBody) !== m.resultHash))
        throw new Error('ACK_RESULT_CONTRADICTION');
      reached = phase; log({ from: 'controller', kind: 'verified-boundary-then-sigkill', phase,
        pid, at: new Date().toISOString(), databaseDigest: preKill.digest, ackReceived });
      stopped = true; boundaryKillAccepted = kill();
      log({ from: 'controller', kind: 'signal-syscall-receipt', signal: 'SIGKILL', pid,
        processGroup: -pid, accepted: boundaryKillAccepted, at: new Date().toISOString() });
    }
  };
  const pipe = child.stdio[3];
  if (!pipe || !('on' in pipe)) throw new Error('NO_BOUNDARY_PIPE');
  pipe.on('data', (bytes: Buffer) => {
    buffer += bytes.toString('utf8');
    if (Buffer.byteLength(buffer) > 8192) { fail('CONTROL_PIPE_OVERFLOW'); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      processing = processing.then(() => handle(JSON.parse(line))).catch(fail);
    }
  });
  let exited: { code: number | null; signal: NodeJS.Signals | null };
  try { exited = await exit; await processing; }
  finally { clearInterval(monitor); stopped = true; kill(); childInput.destroy(); }
  let recovered: DatabaseDigest | null = null, recoveredTick: number | null = null;
  let resultPresent: boolean | null = null, resultMatches: boolean | null = null;
  try {
    if (!gesture) throw new Error('GESTURE_UNOBSERVED');
    const cut = await readStoreCut(join(directory, 'world.sqlite'), gesture);
    recoveredTick = cut.tick; resultPresent = cut.result !== null;
    resultMatches = !!expectedBody && JSON.stringify(cut.result) === expectedBody;
    recovered = readDatabaseDigest(join(directory, 'world.sqlite'));
    writeJson(join(directory, 'recovered-full-db.json'), recovered);
  } catch (e) { failure ??= e instanceof Error ? e.message : String(e); }
  const expectedFullDigest = planned.committed ? preKill?.digest ?? null : baseline?.digest ?? null;
  const assessment = assess({ caseId, reached, killedByController: boundaryKillAccepted,
    childExitSignal: exited.signal, ackReceived, recoveredResultMatches: resultMatches,
    recoveredResultPresent: resultPresent, recoveredTick, expectedTick,
    expectedFullDigest, recoveredFullDigest: recovered?.digest ?? null,
    independentPreKillRead: !!preKill, independentPostKillRead: !!recovered,
    sourcePinsUnchanged: sourcePins() === expectedPinset });
  const report = { schema: SCHEMA, caseId, plannedPhase: planned.phase, assessment,
    failure, childPid: pid, exit: exited, source: 'REAL_STORE_API_TEST_FIXTURE',
    ackScope: 'TECHNICAL_STORE_API_NOT_APP_NETWORK', guarantee: 'PROCESS_CRASH_NOT_POWER_LOSS',
    expectedDigestBasis: planned.committed ? 'INDEPENDENT_PARENT_READ_AT_HELD_COMMIT' : 'INITIAL_COMMIT',
    reached, ackReceived, recoveredTick, expectedFullDigest, recoveredFullDigest: recovered?.digest ?? null,
    controllerSignalAccepted: boundaryKillAccepted,
    milliseconds: performance.now() - started, scientificAcceptance: false };
  writeJson(join(directory, 'case.json'), report);
  return report;
}

export async function main(args: string[]): Promise<void> {
  if (args.length !== 4 || args[0] !== '--run-id' || args[2] !== '--go-receipt')
    throw new Error('REQUIRES --run-id ID --go-receipt OWNED_ROOT_RECEIPT');
  const runId = args[1]; if (!runId || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(runId)) throw new Error('INVALID_RUN_ID');
  const receipt = resolve(args[3]!); assertPrivatePath(receipt);
  const pinsHash = sourcePins();
  const go: { schema: string; runId: string; pinsetSha256: string; expiresAt: string } = JSON.parse(readFileSync(receipt, 'utf8'));
  if (go.schema !== 'root-exact-go/c21-technical-v1' || go.runId !== runId || go.pinsetSha256 !== pinsHash
    || !(Date.parse(go.expiresAt) > Date.now())) throw new Error('ROOT_EXACT_GO_REQUIRED');
  const containment = effectiveContainment();
  const data = join(OWNED, 'data'); assertPrivatePath(data); mkdirSync(data, { recursive: true, mode: 0o700 });
  const root = join(data, runId); mkdirSync(root, { mode: 0o700 }); // Must be fresh. Preserve all failed cases.
  writeJson(join(root, 'admission.json'), { runId, pinsetSha256: pinsHash, containment, limits: LIMITS,
    goReceiptSha256: hash(readFileSync(receipt)), testFixture: true, scientificAcceptance: false });
  const started = performance.now(), cases = [];
  for (const c of CASES) {
    if (performance.now() - started >= LIMITS.totalSeconds * 1000) break;
    cases.push(await runCase(c.id, root, started, pinsHash));
  }
  const summary = { schema: SCHEMA, state: 'TECHNICAL_RESULT_ONLY', cases,
    planned: CASES.length, attempted: cases.length, sourcePinsSha256: sourcePins(),
    pinsetUnchanged: sourcePins() === pinsHash,
    scientificAcceptance: false, c21: 'UNKNOWN', c21Missing: ['APP_NETWORK_ACK', '12_CLIENTS_3600_SECONDS',
      'TEN_BEFORE_TEN_AFTER_DISTINCT_POINTS', 'MANUAL_MULTICOMPONENT_ORACLES', 'POWER_LOSS'],
    milliseconds: performance.now() - started };
  writeJson(join(root, 'summary.json'), summary);
  console.log(JSON.stringify({ root, attempted: cases.length, technical: cases.map(c => c.assessment.verdict), c21: 'UNKNOWN' }));
  if (!summary.pinsetUnchanged || cases.length !== CASES.length
    || cases.some(c => c.failure || c.assessment.verdict !== 'TECHNICAL_PASS'))
    process.exitCode = 1;
}
if (process.argv[2] === '--worker') {
  await worker(process.argv[3] ?? '', process.argv[4] ?? '', process.argv[5] ?? '',
    Number(process.argv[6]), process.argv[7] ?? '');
} else if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main(process.argv.slice(2));
}
