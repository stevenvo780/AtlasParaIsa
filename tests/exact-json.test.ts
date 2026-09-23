import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exactJsonNumber, stringifyExact } from '../src/shared/exact-json.js';

test('exact JSON retains native syntax and only changes the signed zero token', () => {
  const value = { literal: '-0', nested: [0, Number.MIN_VALUE, 0.12345678901234566, 'á\n"'], absent: undefined };
  assert.equal(stringifyExact(value), JSON.stringify(value));
  assert.deepEqual(JSON.parse(stringifyExact(value)), JSON.parse(JSON.stringify(value)));
  const signed = stringifyExact({ ...value, signed: -0 });
  assert.equal(signed, `${JSON.stringify(value).slice(0, -1)},"signed":-0}`);
  assert.ok(Object.is(JSON.parse(signed).signed, -0));
  assert.ok(Object.isFrozen(exactJsonNumber(-0)), 'the shared raw token cannot be changed');
  assert.equal(exactJsonNumber(-0), exactJsonNumber(-0));
});

test('the world engine imports without JSON.rawJSON and exact writes fail explicitly if unsupported', () => {
  const world = new URL('../src/world/index.ts', import.meta.url).href;
  const exact = new URL('../src/shared/exact-json.ts', import.meta.url).href;
  const code = `
    Object.defineProperty(JSON, 'rawJSON', { value: undefined, configurable: true });
    const { TICKS_PER_DAY, phaseAt } = await import(${JSON.stringify(world)});
    const { stringifyExact } = await import(${JSON.stringify(exact)});
    if (!Number.isFinite(TICKS_PER_DAY) || typeof phaseAt(0) !== 'string') throw new Error('world engine failed');
    if (stringifyExact({ ordinary: 1 }) !== '{"ordinary":1}') throw new Error('ordinary JSON changed');
    let rejected = false;
    try { stringifyExact({ signed: -0 }); } catch (error) { rejected = /JSON.rawJSON support/.test(error.message); }
    if (!rejected) throw new Error('signed zero silently lost');
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stderr}`);
});
