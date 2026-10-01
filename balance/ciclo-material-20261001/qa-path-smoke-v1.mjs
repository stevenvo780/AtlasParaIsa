import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const destination = '/datos/tmp-atlas-lab/balance/codex9';
const leaf = `${destination}/qa-path-leaf-v1.mjs`;
const nestedTmp = `${destination}/qa-path-nested-v1/tmp`;
const reportPath = `${destination}/qa-path-smoke-v1-cases.json`;
assert.equal(process.env.TMPDIR, '/datos/tmp-atlas-lab');
assert.equal(process.env.LD_PRELOAD, undefined);
assert.equal(process.env.CODEX9_LAUNCHER_INIT, undefined);
assert.equal(process.env.CODEX9_INIT_AUDIT, undefined);
assert.equal(process.env.PATH.split(':')[0], `${destination}/qa-path-bin-v1`);
assert.equal(fs.existsSync(reportPath), false, 'new report required');
assert.equal(fs.existsSync(`${destination}/qa-path-nested-v1`), false, 'new sandbox required');
fs.mkdirSync(nestedTmp, { recursive: true, mode: 0o700 });
const originalArgs = ['space argument', "single'quote", 'double"quote', '$literal', '', 'last'];
const cases = [
  { name: 'normal-path', command: 'bash', args: ['-c', 'exec node "$@"', 'qa-path-case', leaf, 'normal-path', '/datos/tmp-atlas-lab', ...originalArgs] },
  { name: 'env-i-nested-tmp', command: '/usr/bin/env', args: ['-i', `PATH=${process.env.PATH}`, `TMPDIR=${nestedTmp}`, `TMP=${nestedTmp}`, `TEMP=${nestedTmp}`, 'CI=1', 'bash', '-c', 'exec node "$@"', 'qa-path-case', leaf, 'env-i-nested-tmp', nestedTmp, ...originalArgs] },
];
console.log(JSON.stringify({ phase: 'smoke-plan', pid: process.pid, caseNames: cases.map(item => item.name), secondsPerCase: 6, LD_PRELOAD: false, priorityRepairsDuringWork: false }));
const results = await Promise.all(cases.map(item => new Promise((resolve, reject) => {
  const child = spawn(item.command, item.args, { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ case: item.name, pid: child.pid, code, signal }));
})));
fs.writeFileSync(reportPath, JSON.stringify({ results, valid: results.every(item => item.code === 0 && item.signal === null) }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ phase: 'smoke-complete', results, reportPath }));
assert.ok(results.every(item => item.code === 0 && item.signal === null));
