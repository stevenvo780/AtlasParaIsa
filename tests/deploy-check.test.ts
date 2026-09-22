import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const script = resolve('scripts/deploy-check.sh');
const smokeChecks = ['builtEntrypoint', 'credentialCli', 'privateHttp', 'autonomousAdvance', 'sigkillRestart', 'persistedSession', 'revocationCli', 'gracefulExit'];

function fixture(t: TestContext, options: { build?: number; smoke?: number; missingBuild?: boolean; missingSmoke?: boolean; hang?: boolean; resistantChild?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atlas-deploy-fixture-' ")), repo = join(root, 'repository');
  mkdirSync(repo); mkdirSync(join(repo, 'scripts'));
  copyFileSync(script, join(repo, 'scripts/deploy-check.sh'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '--quiet'); git('config', 'user.name', 'Deploy fixture'); git('config', 'user.email', 'fixture@example.invalid');
  t.after(() => {
    // This Git repository belongs only to this fixture; remove its own registered
    // worktrees if a failing assertion interrupted the normal cleanup check.
    for (const line of git('worktree', 'list', '--porcelain').split('\n')) {
      if (line.startsWith('worktree ') && line.slice(9) !== repo) git('worktree', 'remove', '--force', line.slice(9));
    }
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(repo, '.gitignore'), 'node_modules\ndata\ndist\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ private: true, scripts: { build: 'node build.cjs', 'test:smoke': 'node smoke.cjs' } }));
  writeFileSync(join(repo, 'marker'), 'committed revision');
  const environmentChecks = `
    const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
    assert.equal(process.env.CARTA_PASSWORD, undefined);
    assert.equal(process.env.NODE_OPTIONS, undefined);
    assert.equal(process.env.NPM_TOKEN, undefined);
    assert.equal(process.env.npm_config_offline, 'true');
    assert.ok(process.env.CARTA_DATA_DIR.startsWith(path.dirname(process.cwd()) + '/'));
    assert.ok(process.env.TMPDIR.startsWith(path.dirname(process.cwd()) + '/'));
    assert.equal(fs.statSync(process.env.TMPDIR).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync('marker', 'utf8'), 'committed revision');
  `;
  writeFileSync(join(repo, 'build.cjs'), `${environmentChecks}
    console.log('fixture build stdout'); console.error('fixture build stderr');
    ${options.resistantChild ? `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`process.title='atlas-deploy-test-leaf'; process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(join(root, 'leaf.pid'))},String(process.pid)); setInterval(()=>{},1000);`)}], {stdio:'ignore'});` : ''}
    ${options.hang ? 'setInterval(() => {}, 1000);' : `
      if (${options.build ?? 0}) process.exit(${options.build ?? 0});
      if (!${!!options.missingBuild}) {
        fs.mkdirSync('dist/client', { recursive: true }); fs.mkdirSync('dist/server/server', { recursive: true });
        fs.writeFileSync('dist/client/index.html', 'fixture build'); fs.writeFileSync('dist/server/server/main.js', 'fixture entrypoint');
      }`}
  `);
  writeFileSync(join(repo, 'smoke.cjs'), `${environmentChecks}
    console.log('fixture smoke stdout');
    if (${options.smoke ?? 0}) process.exit(${options.smoke ?? 0});
    const privateFile = path.join(process.env.CARTA_DATA_DIR, 'access-fixture');
    fs.writeFileSync(privateFile, require('node:crypto').randomBytes(24), { mode: 0o600 });
    assert.equal(fs.statSync(privateFile).mode & 0o777, 0o600);
    if (!${!!options.missingSmoke}) {
      fs.mkdirSync('artifacts', { recursive: true });
      fs.writeFileSync('artifacts/smoke.json', JSON.stringify({${smokeChecks.map(key => `${key}: true`).join(',')}, marker: fs.readFileSync('marker', 'utf8')}));
    }
  `);
  mkdirSync(join(repo, 'artifacts'));
  writeFileSync(join(repo, 'artifacts/smoke.json'), JSON.stringify(Object.fromEntries(smokeChecks.map(key => [key, true]))));
  git('add', '.'); git('commit', '--quiet', '-m', 'safe gate fixture');
  const revision = git('rev-parse', 'HEAD'); git('tag', 'tested-revision');
  mkdirSync(join(root, 'dependencies')); symlinkSync(join(root, 'dependencies'), join(repo, 'node_modules'), 'dir');
  mkdirSync(join(repo, 'data')); writeFileSync(join(repo, 'data/world.sqlite'), 'original world sentinel');
  mkdirSync(join(repo, 'dist')); writeFileSync(join(repo, 'dist/public-sentinel'), 'original public build');
  const before = git('worktree', 'list', '--porcelain');
  const run = (ref = 'tested-revision', output = join(root, 'report'), extraEnv: Record<string, string> = {}) => {
    const result = spawnSync('bash', [join(repo, 'scripts/deploy-check.sh'), ref, output], {
      cwd: root, encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, CARTA_DATA_DIR: join(repo, 'data'), CARTA_PASSWORD: 'inherited-fixture-only', NPM_TOKEN: 'inherited-fixture-only', NODE_OPTIONS: '--throw-deprecation', ...extraEnv },
    });
    if (result.status !== 0) for (const log of ['build.log', 'smoke.log']) {
      if (existsSync(join(output, log))) result.stderr += readFileSync(join(output, log), 'utf8');
    }
    return result;
  };
  const unchanged = () => {
    assert.equal(readFileSync(join(repo, 'data/world.sqlite'), 'utf8'), 'original world sentinel');
    assert.equal(readFileSync(join(repo, 'dist/public-sentinel'), 'utf8'), 'original public build');
    assert.equal(git('worktree', 'list', '--porcelain'), before);
    assert.ok(existsSync(join(root, 'dependencies')), 'cleanup must not remove the shared dependencies');
  };
  return { root, repo, revision, git, run, unchanged };
}

test('deploy-check builds the requested commit from any cwd, preserves evidence and cleans only its own worktree', t => {
  const f = fixture(t), reportDir = join(f.root, "report's result");
  f.git('worktree', 'add', '--detach', join(f.root, 'other-worktree'), f.revision);
  const registeredBefore = f.git('worktree', 'list', '--porcelain');
  writeFileSync(join(f.repo, 'marker'), 'newer HEAD'); f.git('add', 'marker'); f.git('commit', '--quiet', '-m', 'newer source');
  writeFileSync(join(f.repo, 'marker'), 'dirty source');
  const result = f.run('tested-revision', reportDir);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(readFileSync(join(reportDir, 'report.json'), 'utf8'));
  assert.equal(report.revision, f.revision); assert.equal(report.status, 'passed'); assert.equal(report.cleanup, true);
  assert.equal(report.buildExitCode, 0); assert.equal(report.smokeExitCode, 0);
  assert.equal(report.repository, f.repo); assert.match(report.helperSha256, /^[a-f0-9]{64}$/);
  assert.ok(!existsSync(dirname(report.worktree)), 'temporary world, credential, npm cache and worktree must be removed');
  assert.equal(statSync(reportDir).mode & 0o777, 0o700); assert.equal(statSync(join(reportDir, 'report.json')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(reportDir, 'smoke.json'), 'utf8')).marker, 'committed revision');
  assert.match(readFileSync(join(reportDir, 'build.log'), 'utf8'), /fixture build stdout/);
  assert.match(readFileSync(join(reportDir, 'build.log'), 'utf8'), /fixture build stderr/);
  assert.match(readFileSync(join(reportDir, 'smoke.log'), 'utf8'), /fixture smoke stdout/);
  assert.equal(readFileSync(join(f.repo, 'marker'), 'utf8'), 'dirty source');
  // HEAD moved above, but the independent registered worktree must survive.
  assert.ok(f.git('worktree', 'list', '--porcelain').includes(join(f.root, 'other-worktree')));
  assert.equal(f.git('worktree', 'list', '--porcelain').split('worktree ').length, registeredBefore.split('worktree ').length);
  f.git('worktree', 'remove', '--force', join(f.root, 'other-worktree'));
  assert.equal(readFileSync(join(f.repo, 'data/world.sqlite'), 'utf8'), 'original world sentinel');
  assert.equal(readFileSync(join(f.repo, 'dist/public-sentinel'), 'utf8'), 'original public build');
});

for (const [phase, code] of [['build', 23], ['smoke', 37]] as const) {
  test(`deploy-check propagates ${phase} failure, records it and removes the temporary worktree`, t => {
    const f = fixture(t, { [phase]: code }), result = f.run();
    assert.equal(result.status, code, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(readFileSync(join(f.root, 'report/report.json'), 'utf8'));
    assert.equal(report.status, 'failed'); assert.equal(report.phase, phase); assert.equal(report.exitCode, code);
    assert.equal(report.cleanup, true); assert.ok(!existsSync(dirname(report.worktree)));
    if (phase === 'build') { assert.equal(report.smokeExitCode, null); assert.ok(!existsSync(join(f.root, 'report/smoke.log'))); }
    f.unchanged();
  });
}

for (const [option, phase] of [['missingBuild', 'build-evidence'], ['missingSmoke', 'smoke-evidence']] as const) {
  test(`deploy-check rejects exit zero with ${phase} absent, including a stale committed smoke report`, t => {
    const f = fixture(t, { [option]: true }), result = f.run();
    assert.notEqual(result.status, 0);
    const report = JSON.parse(readFileSync(join(f.root, 'report/report.json'), 'utf8'));
    assert.equal(report.phase, phase); assert.equal(report.status, 'failed'); assert.equal(report.cleanup, true);
    assert.ok(!existsSync(dirname(report.worktree))); f.unchanged();
  });
}

test('deploy-check times out a hanging gate and still cleans its private world', t => {
  const f = fixture(t, { hang: true }), result = f.run('tested-revision', join(f.root, 'report'), { DEPLOY_CHECK_TIMEOUT_SECONDS: '1' });
  assert.equal(result.status, 124, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(readFileSync(join(f.root, 'report/report.json'), 'utf8'));
  assert.equal(report.buildExitCode, 124); assert.equal(report.cleanup, true);
  assert.ok(!existsSync(dirname(report.worktree))); f.unchanged();
});

test('deploy-check removes its Git registration when interrupted just after worktree add', t => {
  const f = fixture(t), bin = join(f.root, 'bin'); mkdirSync(bin);
  const actualGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  assert.equal(actualGit.status, 0, actualGit.stderr);
  // Real Git creates the worktree, then the shim delivers an external signal
  // before Bash can acknowledge successful setup. No fabricated Git results.
  writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const args=process.argv.slice(2);
const result=require('node:child_process').spawnSync(${JSON.stringify(actualGit.stdout.trim())},args,{stdio:'inherit'});
if(result.status===0 && args.includes('worktree') && args.includes('add')) process.kill(process.ppid,'SIGTERM');
process.exit(result.status??1);
`, { mode: 0o700 });
  const result = f.run('tested-revision', join(f.root, 'report'), { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.status, 143, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(readFileSync(join(f.root, 'report/report.json'), 'utf8'));
  assert.equal(report.phase, 'setup'); assert.equal(report.cleanup, true);
  assert.ok(!existsSync(dirname(report.worktree))); f.unchanged();
});

test('deploy-check kills a TERM-resistant descendant even after npm and timeout have exited', t => {
  const f = fixture(t, { hang: true, resistantChild: true }), pidFile = join(f.root, 'leaf.pid');
  let leafPid: number | undefined;
  t.after(() => {
    if (leafPid === undefined) return;
    const command = spawnSync('ps', ['-o', 'args=', '-p', String(leafPid)], { encoding: 'utf8' }).stdout;
    if (command.includes('atlas-deploy-test-leaf')) { try { process.kill(leafPid, 'SIGKILL'); } catch {} }
  });
  const result = f.run('tested-revision', join(f.root, 'report'), { DEPLOY_CHECK_TIMEOUT_SECONDS: '2' });
  if (existsSync(pidFile)) leafPid = Number(readFileSync(pidFile, 'utf8'));
  assert.equal(result.status, 124, `${result.stdout}\n${result.stderr}`);
  assert.ok(existsSync(pidFile), 'the resistant descendant actually started before the deadline');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  assert.ok(state === '' || /^[ZX]/.test(state), `descendant ${pid} is still executing (${state})`);
  const report = JSON.parse(readFileSync(join(f.root, 'report/report.json'), 'utf8'));
  assert.equal(report.buildExitCode, 124); assert.equal(report.cleanup, true);
  assert.ok(!existsSync(dirname(report.worktree))); f.unchanged();
});

test('deploy-check rejects an unknown ref, existing report and protected output paths without altering them', t => {
  const f = fixture(t), reportDir = join(f.root, 'report');
  const unknown = f.run('missing-ref'); assert.notEqual(unknown.status, 0); assert.ok(!existsSync(reportDir));
  mkdirSync(reportDir); writeFileSync(join(reportDir, 'sentinel'), 'retain this report');
  const existing = f.run(); assert.notEqual(existing.status, 0);
  assert.equal(readFileSync(join(reportDir, 'sentinel'), 'utf8'), 'retain this report');
  for (const protectedPath of ['data', 'dist']) {
    const target = join(f.repo, protectedPath, 'gate-report');
    const rejected = f.run('tested-revision', target); assert.notEqual(rejected.status, 0); assert.ok(!existsSync(target));
  }
  f.unchanged();
});
