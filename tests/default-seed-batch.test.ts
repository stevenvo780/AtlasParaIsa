import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { artifactBytes, classifyOutcome, verifyEvidence, type Batch } from '../scripts/lab/default-seed-batch.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = '3dd615ee069d9d61f51a4c74f85d33c15a4583e0';
const CANDIDATE = 'cf04ac402d25179c9fa878292390e3c2aff0255e';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

test('portable frozen CLI archives both fixed laws away from candidate HEAD and verifies a bounded paired pilot', { timeout: 240000 }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-default-seed-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  execFileSync('git', ['clone', '--quiet', '--shared', '--no-checkout', ROOT, repo]);
  execFileSync('git', ['-C', repo, 'symbolic-ref', 'HEAD', 'refs/heads/portable-fixture']);
  execFileSync('git', ['-C', repo, 'update-ref', 'refs/heads/portable-fixture', BASELINE]);
  assert.equal(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), BASELINE);
  for (const path of ['scripts/lab', 'docs/evidencia-2026-09-22', 'src/world']) mkdirSync(join(repo, path), { recursive: true });
  for (const path of ['package.json', 'scripts/lab/default-seed-batch.ts', 'scripts/lab/default-seed-pilot.ts', 'docs/evidencia-2026-09-22/default-seed-public-params.json']) copyFileSync(join(ROOT, path), join(repo, path));
  symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'), 'dir');
  writeFileSync(join(repo, 'src/world/index.ts'), "throw new Error('live checkout must not supply the candidate');\n");
  writeFileSync(join(repo, 'scripts/lab/family-reserve.ts'), "throw new Error('live checkout must not supply the instrument');\n");
  const loader = pathToFileURL(join(repo, 'node_modules/tsx/dist/loader.mjs')).href;
  const cli = (script: string, args: string[]) => spawnSync(process.execPath, ['--import', loader, script, ...args],
    { cwd: directory, encoding: 'utf8', timeout: 220000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, CARTA_DATA_DIR: join(directory, 'isolated-data') } });
  const batchPath = join(repo, 'artifacts/default-seed-v7-v9-20260922/fixture');
  const prepared = cli(join(repo, 'scripts/lab/default-seed-batch.ts'), ['prepare', batchPath]);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(JSON.parse(prepared.stdout).simulationsStarted, 0);
  const manifest = join(batchPath, 'batch.json'), original = readFileSync(manifest, 'utf8'), batch = JSON.parse(original);
  assert.equal(batch.sources.baseline.originSha, BASELINE); assert.equal(batch.sources.candidate.originSha, CANDIDATE);
  assert.equal(batch.sources.baseline.rootDirty, false); assert.equal(batch.sources.candidate.rootDirty, false);
  assert.equal(batch.sources.baseline.sourceHash, '783b2dc78b0361a51e390c2e015429a984c50f8b1b6ce73bbd941d7e4d30778d');
  assert.equal(batch.sources.candidate.sourceHash, 'cd11a32b26ffbce2e28c6b0e9bf97196180a1219aefb0e0577b007d669603125');
  assert.equal(batch.instrumentHash, '12053834befc95ebedc4bf1bf4c4308ff49c040c21d233f585aa02d3f894f542');
  const frozen = join(batchPath, 'default-seed-batch.ts');
  assert.equal(hash(readFileSync(frozen)), batch.runnerHash);
  assert.equal(cli(frozen, ['check', batchPath]).status, 0, 'frozen launcher resolves its own manifest outside the checkout cwd');
  assert.notEqual(cli(frozen, ['run', batchPath]).status, 0, 'no long simulation before the paired pilot');
  assert.equal(existsSync(join(batchPath, 'started.json')), false);
  const corruptions = [ { days: 24 }, { ticks: 59999 }, { workers: 3 }, { timeoutMs: 7200001 }, { params: 'persistencia.cadaTicks=100' },
    { effectiveParams: { ...batch.effectiveParams, agua: { cuencas: .9 } } }, { instrumentHash: '0'.repeat(64) },
    { limits: { ...batch.limits, maxArtifactBytes: 65 * 1024 ** 3 } },
    { jobs: batch.jobs.map((j: object) => ({ ...j, seed: 1007 })) },
    { sources: { ...batch.sources, candidate: { ...batch.sources.candidate, sourceHash: '0'.repeat(64) } } } ];
  for (const changed of corruptions) {
    writeFileSync(manifest, JSON.stringify({ ...batch, ...changed }));
    assert.notEqual(cli(frozen, ['check', batchPath]).status, 0, JSON.stringify(changed));
  }
  writeFileSync(manifest, original);
  const source = join(batch.sources.candidate.root, 'src/world/index.ts'), before = readFileSync(source);
  chmodSync(source, 0o644); writeFileSync(source, Buffer.concat([before, Buffer.from('\n// altered fixture\n')]));
  assert.notEqual(cli(frozen, ['check', batchPath]).status, 0, 'changed archived engine is rejected');
  writeFileSync(source, before); chmodSync(source, 0o444);
  const piloted = cli(join(batchPath, 'default-seed-pilot.ts'), [batchPath]);
  assert.equal(piloted.status, 0, piloted.stderr);
  const pilot = JSON.parse(piloted.stdout);
  assert.equal(pilot.passed, true); assert.equal(pilot.batchHash, hash(original)); assert.equal(pilot.pilotHash, batch.pilotHash);
  assert.deepEqual(pilot.pilots.map((p: {checkpoint: {version: number}}) => p.checkpoint.version), [7, 9]);
  for (const p of pilot.pilots) assert.deepEqual(p.checkpoint, { tick: 2400, version: p.checkpoint.version, slot: 0, paramsEqual: true, inputs: 0 });
  const pilotBatch = { ...batch, days: 1, ticks: 2400 } as Batch;
  for (const originalJob of pilotBatch.jobs) {
    const job = { ...originalJob, output: join(batchPath, 'pilot', originalJob.id) };
    assert.equal(verifyEvidence(pilotBatch, job), undefined);
    const db = new DatabaseSync(join(job.output, 'world.sqlite'));
    try {
      const row = db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get() as { body: string; digest: string };
      for (const change of [{ seed: 1007 }, { version: originalJob.side === 'baseline' ? 9 : 7 }]) {
        const altered = JSON.stringify({ ...JSON.parse(row.body), ...change });
        db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(altered, hash(altered));
        assert.match(verifyEvidence(pilotBatch, job) ?? '', /identity/, 'checksum-valid wrong world must not certify completion');
        db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(row.body, row.digest);
      }
    } finally { db.close(); }
    assert.equal(verifyEvidence(pilotBatch, job), undefined);
  }
  assert.equal(cli(frozen, ['check', batchPath]).status, 0);
  writeFileSync(join(batchPath, 'pilot.json'), JSON.stringify({ ...pilot, batchHash: '0'.repeat(64) }));
  assert.notEqual(cli(frozen, ['run', batchPath]).status, 0, 'another manifest cannot borrow the completed pilot');
  assert.equal(existsSync(join(batchPath, 'started.json')), false, 'this test never launches the 25-day diagnostic');
  assert.equal(readFileSync(join(repo, 'src/world/index.ts'), 'utf8'), "throw new Error('live checkout must not supply the candidate');\n");
});

test('disk accounting tolerates a vanished SQLite temporary file but retains permission failures', t => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-default-seed-disk-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'stable'), '12345'); writeFileSync(join(directory, 'transient'), 'abc');
  const original = fs.statSync, mutableFs = fs as unknown as { statSync: typeof fs.statSync }; let removed = false;
  mutableFs.statSync = ((...args: Parameters<typeof fs.statSync>) => {
    if (String(args[0]).endsWith('/transient')) { fs.unlinkSync(join(directory, 'transient')); removed = true; }
    return (original as Function)(...args);
  }) as typeof fs.statSync;
  syncBuiltinESMExports();
  try { assert.equal(artifactBytes(directory), 5); assert.equal(removed, true); }
  finally { mutableFs.statSync = original; syncBuiltinESMExports(); }
  mutableFs.statSync = (() => { throw Object.assign(new Error('synthetic EACCES'), { code: 'EACCES' }); }) as typeof fs.statSync;
  syncBuiltinESMExports();
  try { assert.throws(() => artifactBytes(directory), /synthetic EACCES/); }
  finally { mutableFs.statSync = original; syncBuiltinESMExports(); }
});

test('censorship wins over nominal exit zero and the captured laws contain exactly the authorized 22 scalars', () => {
  assert.equal(classifyOutcome(0, { timedOut: true }), 'timeout');
  assert.equal(classifyOutcome(0, { interrupted: true }), 'interrupted');
  assert.equal(classifyOutcome(0, { invalidEvidence: true }), 'invalid-evidence');
  assert.equal(classifyOutcome(0, {}), 'success');
  const bytes = readFileSync(join(ROOT, 'docs/evidencia-2026-09-22/default-seed-public-params.json'));
  assert.equal(hash(bytes), '272ec788ba8dbb4fdb7e813c201b4bca83298497f960097a0eecba1f512b0b6a');
  const capture = JSON.parse(bytes.toString());
  const scalars = Object.values(capture.params).flatMap(group => Object.values(group as object));
  assert.equal(scalars.length, 22); assert.ok(scalars.every(value => typeof value === 'number' && Number.isFinite(value)));
  assert.deepEqual(Object.keys(capture).sort(), ['acceptedInputRows', 'observedAt', 'params', 'seed', 'snapshotDigest', 'tick', 'version']);
});
