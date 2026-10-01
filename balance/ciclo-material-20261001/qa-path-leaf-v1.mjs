import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

const [name, expectedTmp, ...args] = process.argv.slice(2);
assert.deepEqual(args, ['space argument', "single'quote", 'double"quote', '$literal', '', 'last']);
assert.equal(process.execPath, '/datos/tmp-atlas-lab/codex9-runtime/codex9-node');
assert.equal(process.env.LD_PRELOAD, undefined);
assert.equal(process.env.CODEX9_LAUNCHER_INIT, undefined);
assert.equal(process.env.CODEX9_INIT_AUDIT, undefined);
assert.equal(process.env.TMPDIR, expectedTmp);
assert.equal(os.tmpdir(), expectedTmp);
assert.equal(process.env.PATH.split(':')[0], '/datos/tmp-atlas-lab/balance/codex9/qa-path-bin-v1');
function resourceSnapshot(phase) {
  const threads = fs.readdirSync(`/proc/${process.pid}/task`).map(tid => {
    const stat = fs.readFileSync(`/proc/${process.pid}/task/${tid}/stat`, 'utf8');
    const status = fs.readFileSync(`/proc/${process.pid}/task/${tid}/status`, 'utf8');
    const nice = Number(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[16]);
    const cpus = status.match(/^Cpus_allowed_list:\s*(.+)$/m)[1].trim();
    assert.equal(nice, 19);
    assert.equal(cpus, '6-31');
    return { tid: Number(tid), nice, cpus };
  });
  console.log(JSON.stringify({ case: name, phase, pid: process.pid, priority: os.getPriority(), TMPDIR: process.env.TMPDIR, execPath: process.execPath, argumentsVerified: true, threads }));
}
resourceSnapshot('start');
await new Promise(resolve => setTimeout(resolve, 6000));
resourceSnapshot('end');
