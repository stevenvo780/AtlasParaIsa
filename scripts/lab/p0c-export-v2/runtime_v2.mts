import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { instrumentApproachSource } from './approach-observer_v2.mts';
import { hash, instrumentReturnSources, sourceInventory } from './instrumentation_v2.mts';

export const BASE_COMMIT = '119a5d38ac4bc0d961c88eede7d6a089512ca57b';
export const OWNED = fileURLToPath(new URL('./', import.meta.url));
export const CHECKOUT = resolve(OWNED, '../../..');
export const RUNTIME = join(OWNED, 'runtime-v2');
export const REPORT = join(CHECKOUT, '.orchestration/p0c-export-ledger-v2/P0C-EXPORT-LEDGER-v3.json');
export function requireInsideCheckout(path: string): string {
  const result = resolve(path), rel = relative(realpathSync(CHECKOUT), result);
  assert.ok(rel && !rel.startsWith('..') && !rel.startsWith('/') && !rel.split('/').includes('.git'), 'Write path outside checkout');
  // Resolve every existing ancestor, preventing an in-checkout symlink from escaping.
  let parent = result;
  while (!existsSync(parent)) parent = resolve(parent, '..');
  const real = relative(realpathSync(CHECKOUT), realpathSync(parent));
  assert.ok(!real.startsWith('..') && !real.startsWith('/'), 'Write path symlink escapes checkout');
  return result;
}
export function frozenInputs() {
  const reportBody = readFileSync(REPORT), report = JSON.parse(reportBody.toString());
  assert.equal(report.state, 'FROZEN'); assert.equal(report.baseCommit, BASE_COMMIT);
  assert.equal(hash(JSON.stringify(report.pinset)), report.pinsetSha256, 'Pinset hash drift');
  for (const entry of report.pinset.files) assert.equal(hash(readFileSync(join(CHECKOUT, entry.path))), entry.sha256, `Frozen source drift: ${entry.path}`);
  assert.deepEqual(sourceInventory(join(CHECKOUT, 'src')), report.pinset.sourceInventory, 'Checkout source inventory drift');
  assert.ok(Array.isArray(report.externalOperationalInputs) && report.externalOperationalInputs.length === 3, 'Operational input pinset required');
  for (const entry of report.externalOperationalInputs) assert.equal(hash(readFileSync(entry.path)), entry.sha256, `Operational input drift: ${entry.path}`);
  return { report, reportSha256: hash(reportBody) };
}
export function runtimeAnchors() {
  const frozen = frozenInputs();
  return { sourceCommit: BASE_COMMIT, sourceCheckout: CHECKOUT, reportSha256: frozen.reportSha256,
    pinsetSha256: frozen.report.pinsetSha256, sourceInventory: frozen.report.pinset.sourceInventory,
    observerSha256: {
      retornos: hash(readFileSync(join(OWNED, 'retornos_v2.mts'))),
      approach: hash(readFileSync(join(OWNED, 'approach-observer_v2.mts'))),
      instrumentar: hash(readFileSync(join(OWNED, 'instrumentation_v2.mts'))),
    }, packageSha256: hash(readFileSync(join(CHECKOUT, 'package.json'))) };
}
/** Explicit future preparation only; no World imports or campaign execution. */
export function prepareRuntime() {
  const anchors = runtimeAnchors();
  requireInsideCheckout(RUNTIME);
  assert.ok(!existsSync(RUNTIME), 'Preserving existing runtime');
  const index = readFileSync(join(CHECKOUT, 'src/world/index.ts'), 'utf8');
  const utility = readFileSync(join(CHECKOUT, 'src/world/utilidad-local.ts'), 'utf8');
  assert.equal(hash(index), 'a3c42127589cdf3f157d9aec994f6e16b8d36bc4c1db3eb53aa62171da064ac9');
  assert.equal(hash(utility), 'e602221be4a868e527bd32c03d3b367b24c010b62c329bacfbb24eb97ef47319');
  const transformed = instrumentReturnSources(index, utility), finalIndex = instrumentApproachSource(transformed.index);
  mkdirSync(RUNTIME);
  cpSync(join(CHECKOUT, 'src'), join(RUNTIME, 'src'), { recursive: true, errorOnExist: true, force: false });
  writeFileSync(join(RUNTIME, 'package.json'), readFileSync(join(CHECKOUT, 'package.json')), { flag: 'wx' });
  writeFileSync(join(RUNTIME, 'src/world/index.ts'), finalIndex);
  writeFileSync(join(RUNTIME, 'src/world/utilidad-local.ts'), transformed.utility);
  symlinkSync(join(CHECKOUT, 'node_modules'), join(RUNTIME, 'node_modules'), 'dir');
  const manifest = { schema: 'p0c-instrumented-source-v2', ...anchors,
    runtimeInventory: sourceInventory(join(RUNTIME, 'src')), law: 'OFF', trajectoryExecuted: false };
  writeFileSync(join(RUNTIME, 'instrumentation.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}
export function verifyRuntime() {
  requireInsideCheckout(RUNTIME);
  const manifest = JSON.parse(readFileSync(join(RUNTIME, 'instrumentation.json'), 'utf8'));
  assert.equal(manifest.schema, 'p0c-instrumented-source-v2');
  const anchors = runtimeAnchors();
  for (const key of Object.keys(anchors)) assert.deepEqual(manifest[key], anchors[key as keyof typeof anchors], `Runtime anchor drift: ${key}`);
  const expected = anchors.sourceInventory.map((entry: { path: string; sha256: string; bytes: number }) => ({ ...entry }));
  const transformed = instrumentReturnSources(readFileSync(join(CHECKOUT, 'src/world/index.ts'), 'utf8'),
    readFileSync(join(CHECKOUT, 'src/world/utilidad-local.ts'), 'utf8'));
  for (const [path, source] of [['world/index.ts', instrumentApproachSource(transformed.index)],
    ['world/utilidad-local.ts', transformed.utility]]) {
    const entry = expected.find((item: { path: string }) => item.path === path);
    assert.ok(entry); entry.sha256 = hash(source!); entry.bytes = Buffer.byteLength(source!);
  }
  assert.deepEqual(manifest.runtimeInventory, expected, 'Only exact observer transforms are permitted');
  assert.deepEqual(sourceInventory(join(RUNTIME, 'src')), expected, 'Runtime source drift');
  assert.equal(hash(readFileSync(join(RUNTIME, 'package.json'))), anchors.packageSha256);
  return manifest;
}
