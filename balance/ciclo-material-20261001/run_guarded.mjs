/** Own-goal launcher. Checks itself and every observed descendant thread; never repairs runtime drift. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const [label, timeoutText, ...command] = process.argv.slice(2);
if (!/^[a-zA-Z0-9_.-]+$/.test(label ?? '') || !command.length || !Number.isFinite(Number(timeoutText))) throw new Error('label timeoutSeconds command required');
const runtime = '/datos/tmp-atlas-lab/codex9-runtime/codex9-node';
if (fs.realpathSync(command[0]) !== fs.realpathSync(runtime) || process.env.TMPDIR !== '/datos/tmp-atlas-lab') throw new Error('wrong owned runtime/TMPDIR');
process.title = 'codex9wrap';
// Let the shell parent's delayed exec classification settle before establishing the
// launch boundary. No child, model, compiler or measured work starts in this pause.
const priorityOnEntry = os.getPriority();
await new Promise(resolve => setTimeout(resolve, 2000));
const priorityBeforeEstablishment = os.getPriority();
// Establish absolute priority ONCE, before the guard/child boundary, never during work.
for (const tid of fs.readdirSync(`/proc/${process.pid}/task`)) os.setPriority(Number(tid), 19);
const destination = '/datos/tmp-atlas-lab/balance/codex9';
const logPath = path.join(destination, `${label}.log`), resultPath = path.join(destination, `${label}.json`);
if (fs.existsSync(resultPath)) throw new Error('new label required');
const log = fs.openSync(logPath, 'wx');
const started = performance.now(), issues = [];
let samples = 0, examinedThreads = 0;
const known = new Set([process.pid]);
function resources(pid) {
  const threads = [];
  try {
    for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8');
        const nice = Number(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[16]);
        const status = fs.readFileSync(`/proc/${pid}/task/${tid}/status`, 'utf8');
        const cpus = status.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1]?.trim();
        const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(') '));
        threads.push({ pid, tid: Number(tid), comm, nice, cpus });
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
  } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  return threads;
}
function collect(pid) {
  let children = [];
  try { children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); }
  catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  for (const child of children) { if (!known.has(child)) known.add(child); collect(child); }
}
function check() {
  samples++; collect(process.pid);
  for (const pid of known) for (const thread of resources(pid)) {
    examinedThreads++;
    if (thread.nice !== 19 || thread.cpus !== '6-31') issues.push({ sample: samples, ...thread });
  }
}
check();
if (issues.length) throw new Error(`initial resources failed: ${JSON.stringify(issues)}`);
const child = spawn(command[0], command.slice(1), { cwd: '/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/ciclo-material',
  env: { ...process.env, TMPDIR: '/datos/tmp-atlas-lab', CARTA_DATA_DIR: path.join(destination, `data-${label}`) },
  stdio: ['ignore', log, log], detached: true });
known.add(child.pid);
let stopping = false;
const interval = setInterval(() => {
  check();
  if (performance.now() - started > Number(timeoutText) * 1000 && !stopping) issues.push({ timeoutSeconds: Number(timeoutText) });
  if (issues.length && !stopping) {
    stopping = true;
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const hard = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }, 5000);
    hard.unref();
  }
}, 500);
const completion = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
clearInterval(interval); check(); fs.closeSync(log);
const ownFinal = resources(process.pid);
const valid = completion.code === 0 && issues.length === 0;
const result = { label, command, ...completion, elapsedSeconds: (performance.now() - started) / 1000,
  startup: { settleMilliseconds: 2000, priorityOnEntry, priorityBeforeEstablishment, establishmentBeforeChild: true },
  launchEnvironment: { TMPDIR: process.env.TMPDIR, ldPreloadPresent: Boolean(process.env.LD_PRELOAD), launcherInitEnabled: process.env.CODEX9_LAUNCHER_INIT === '1' },
  resourceSamples: samples, examinedThreads, observedPids: [...known], resourceIssues: issues, ownFinal, valid,
  samplingLimit: '0.5-second observed process-tree sampling; a process or drift wholly between samples may escape detection', log: logPath };
fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ label, code: completion.code, valid, elapsedSeconds: result.elapsedSeconds, issues: issues.length, resultPath }));
process.exitCode = valid ? 0 : 1;
