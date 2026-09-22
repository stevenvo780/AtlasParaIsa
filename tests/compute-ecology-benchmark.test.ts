import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-ignore benchmark-only JavaScript module
import { validateKernelSpecification, ECOLOGY_KERNEL_SPEC } from '../scripts/compute-ecology-core.mjs';

const KERNEL_PATH = resolve(import.meta.dirname, '../src/world/ecosystem-kernel.ts');
const HEAD = readFileSync(KERNEL_PATH, 'utf8');

test('ECOLOGY_KERNEL_SPEC exposes version 1.0 with fields and named terms', () => {
  assert.equal(ECOLOGY_KERNEL_SPEC.version, '1.0');
  assert.ok(Array.isArray(ECOLOGY_KERNEL_SPEC.fieldsRead));
  assert.ok(Array.isArray(ECOLOGY_KERNEL_SPEC.fieldsWritten));
  assert.ok(ECOLOGY_KERNEL_SPEC.fieldsRead.length > 0);
  assert.ok(ECOLOGY_KERNEL_SPEC.fieldsWritten.length > 0);
  assert.ok(typeof ECOLOGY_KERNEL_SPEC.terms === 'object');
  assert.ok(Object.keys(ECOLOGY_KERNEL_SPEC.terms).length > 0);
  assert.equal(typeof ECOLOGY_KERNEL_SPEC.canonicalStepBodyHash, 'string');
  assert.equal(ECOLOGY_KERNEL_SPEC.canonicalStepBodyHash.length, 64);
});

test('validateKernelSpecification passes against HEAD (current kernel source)', () => {
  const result = validateKernelSpecification(HEAD);
  assert.equal(result.valid, true, `unexpected failure: ${result.reason}`);
  assert.equal(result.version, '1.0');
});

test('validateKernelSpecification fails when a term value changes (0.45 -> 0.46)', () => {
  const modified = HEAD.replace(/\b0\.45\b/g, '0.46');
  // Sanity: the substitution actually happened.
  assert.notEqual(modified, HEAD);
  const result = validateKernelSpecification(modified);
  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /term|hash|mismatch/i);
});

test('validateKernelSpecification fails when a new term is introduced', () => {
  // Add a new constant to the life formula (changes terms multiset)
  const modified = HEAD.replace(/0\.2 \* cellularEnergy/, '0.21 * cellularEnergy');
  assert.notEqual(modified, HEAD);
  const result = validateKernelSpecification(modified);
  assert.equal(result.valid, false);
});

test('validateKernelSpecification fails when a new tile field is read or written', () => {
  // Add a write of a new tile field in the life assignment (changes fieldsWritten set)
  const modified = HEAD.replace(
    /tile\.life = clamp\(life/,
    "tile.food = 0; tile.life = clamp(life",
  );
  assert.notEqual(modified, HEAD);
  const result = validateKernelSpecification(modified);
  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /field/i);
});

test('validateKernelSpecification fails when a formula is reordered (A+B -> B+A)', () => {
  // In the fertility formula: life * 0.0012 - traffic * 0.0007 becomes traffic * 0.0007 - life * 0.0012
  // The numeric multiset is identical, so this only fails the hash check.
  const modified = HEAD.replace(
    'life * 0.0012 - traffic * 0.0007 - cultivation * 0.0002',
    'traffic * 0.0007 - life * 0.0012 - cultivation * 0.0002',
  );
  assert.notEqual(modified, HEAD);
  const result = validateKernelSpecification(modified);
  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /hash|structure/i);
});

test('validateKernelSpecification passes when only a comment is added', () => {
  // Insert an explanatory comment inside the step body, before the fertility assignment.
  const needle = 'tile.fertility = clamp(fertility';
  const modified = HEAD.replace(
    needle,
    '// Refactor marker: formatting-only change.\n      ' + needle,
  );
  assert.notEqual(modified, HEAD);
  const result = validateKernelSpecification(modified);
  assert.equal(result.valid, true, `comment change should not invalidate: ${result.reason}`);
});

test('validateKernelSpecification passes when blank lines are added inside step()', () => {
  // Insert blank lines inside the step body.
  const needle = 'tile.fertility = clamp(fertility';
  const modified = HEAD.replace(
    needle,
    '\n      ' + needle,
  );
  assert.notEqual(modified, HEAD);
  const result = validateKernelSpecification(modified);
  assert.equal(result.valid, true, `blank-line change should not invalidate: ${result.reason}`);
});

test('validateKernelSpecification passes when indentation is reformatted', () => {
  // Replace 6-space indentation with 2-space indentation inside the step body.
  // Comment-stripping + whitespace-collapsing normalization should make this a no-op.
  const stepStart = HEAD.indexOf('step(tiles: Tile[]');
  assert.ok(stepStart >= 0);
  // Crude: only touch a single statement to keep the test small.
  const modified = HEAD.replace(
    '      tile.fertility = clamp(fertility',
    '  tile.fertility = clamp(fertility',
  );
  assert.notEqual(modified, HEAD);
  const result = validateKernelSpecification(modified);
  assert.equal(result.valid, true, `indentation change should not invalidate: ${result.reason}`);
});

test('validateKernelSpecification rejects source without a step() function', () => {
  const broken = HEAD.replace(/step\(tiles: Tile\[\][^)]+\): void \{/, 'noStep(');
  const result = validateKernelSpecification(broken);
  assert.equal(result.valid, false);
});