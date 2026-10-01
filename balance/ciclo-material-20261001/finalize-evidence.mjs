import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const dir = '/datos/tmp-atlas-lab/balance/codex9';
const worktree = '/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/ciclo-material';
const baseline = '/datos/tmp-atlas-lab/datos-lab/codex9-main-source';
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const gate = read('gate-v3-result.json');
const gateGuard = read('gate-v3-real.json');
const suiteGuard = read('suite-v4-night.json');
const typeGuard = read('typecheck-npm-final.json');
const review = read('codex9-verificacion-gate-final.json');
assert.equal(gate.status, 'NO CUMPLIDA');
assert.equal(gate.cost.passed, false);
assert.equal(gate.identityPassed, true);
assert.equal(gate.fixturePassed, true);
assert.equal(gate.measuredWorlds, 96);
assert.equal(gate.measuredSteps, 115200);
assert.equal(gateGuard.resourceIssues.length, 0);
assert.equal(gateGuard.code, 1);
assert.equal(gateGuard.signal, null);
assert.equal(gateGuard.launchEnvironment.ldPreloadPresent, false);
assert.deepEqual(gate.initialSources, gate.finalSources);
for (const [family, root] of [['baseline', baseline], ['candidate', worktree]]) {
  for (const [file, hash] of Object.entries(gate.initialSources[family])) {
    assert.equal(sha(path.join(root, file)), hash, `source drift: ${family}/${file}`);
  }
}
assert.equal(review.verification, 'PASS_RECALCULATION');
assert.equal(review.gateA, 'NO CUMPLIDA');
assert.equal(review.inputs.resultSHA256, sha(path.join(dir, 'gate-v3-result.json')));
for (const guard of [suiteGuard, typeGuard]) {
  assert.equal(guard.valid, true);
  assert.equal(guard.code, 0);
  assert.equal(guard.signal, null);
  assert.equal(guard.qaOnly, true);
  assert.equal(guard.resourceIssues.length, 0);
  assert.equal(guard.launchEnvironment.ldPreloadPresent, false);
}
const tap = fs.readFileSync(path.join(dir, 'suite-v4-night.log'), 'utf8');
function summary(name) {
  const match = tap.match(new RegExp(`^# ${name} ([0-9.]+)$`, 'm'));
  assert.ok(match, `missing final TAP ${name}`);
  return Number(match[1]);
}
const suite = Object.fromEntries(['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms'].map(key => [key, summary(key)]));
assert.equal(suite.tests, 1645);
assert.equal(suite.fail, 0);
assert.equal(suite.cancelled, 0);
assert.equal(suite.todo, 0);
assert.equal(suite.pass + suite.skipped, suite.tests);
const branch = execFileSync('git', ['-C', worktree, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
const mainHead = execFileSync('git', ['-C', '/datos/workspaces/personal/AtlasParaIsa', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(branch, 'sprint/ciclo-material-20261001');
assert.equal(mainHead, 'bb483260b2489fe62b113d620e5f56e5f3676dbc');
const proof = {
  verifiedAt: new Date().toISOString(), branch, baselineCommit: mainHead,
  acceptance: { identity: 'PASS', coverage: 'PASS', cost: 'NO CUMPLIDA', tests: 'PASS', typecheck: 'PASS', fullSuite: 'PASS', gateA: 'NO CUMPLIDA', designB: 'DELIVERED_UNIMPLEMENTED' },
  measuredWorlds: 96, measuredSteps: 115200, warmupSteps: 600,
  suite, suiteGuard: { label: suiteGuard.label, elapsedSeconds: suiteGuard.elapsedSeconds, resourceSamples: suiteGuard.resourceSamples, examinedThreads: suiteGuard.examinedThreads, resourceIssues: 0, authorizedPolicy: suiteGuard.authorizedPolicy },
  typecheckGuard: { label: typeGuard.label, elapsedSeconds: typeGuard.elapsedSeconds, resourceSamples: typeGuard.resourceSamples, resourceIssues: 0 },
  hashes: Object.fromEntries(['gate-v3-result.json', 'gate-v3-real.json', 'suite-v4-night.json', 'suite-v4-night.log', 'typecheck-npm-final.json', 'typecheck-npm-final.log', 'codex9-verificacion-gate-final.json', 'run_guarded.mjs', 'run_qa_night_guarded.mjs'].map(name => [name, sha(path.join(dir, name))])),
  resourceLimits: '0.5s observed thread sampling; no continuous proof. QA allowed0–31 only00–07 Bogota; benchmark frozen6–31. No runtime repair.',
  nextStep: 'candidate retained only on local branch; no integration/publication; future law requires formal adversarial critique before implementation',
};
fs.writeFileSync(path.join(dir, 'QA-FINAL.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(proof, null, 2));
