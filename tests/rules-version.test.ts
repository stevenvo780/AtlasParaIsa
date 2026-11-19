import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorld, cloneWorld, createWorld, migrateWorld, RULES_VERSION, stepWorld } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { parseParams, paramsOf } from '../src/world/params.js';

for (const previousVersion of [6, 7, 8, 9, 10, 11]) test(`V12 is explicit and reading valid V${previousVersion} preserves its history, stocks, traits and parameters`, () => {
  const world = createWorld(7, parseParams('agua.cuencas=0.8'));
  for (let n = 0; n < 60; n++) stepWorld(world);
  world.version = previousVersion;
  // Old founder expressions are historical state, not retroactively corrected.
  world.people[2]!.traits.curiosity = 0.01;
  const before = cloneWorld(world), migrated = migrateWorld(world);
  assert.equal(RULES_VERSION, 12);
  assert.equal(createWorld().version, 12);
  assert.equal(migrated.version, 12);
  assert.deepEqual(migrated, { ...before, version: 12 });
  assert.deepEqual(world, before);
  assert.deepEqual(paramsOf(migrated), paramsOf(world));
  assertWorld(migrated);
});

test('V10/V11→V12 cambia sólo version: mismo digesto canónico del estado y params persistidos intactos', () => {
  const persisted = parseParams('agua.cuencas=0.8,social.disputaNecesidad=0.65,social.disputaEscasez=1,social.disputaRadio=2,social.memoriaDisputa=0');
  const world = createWorld(51926, persisted);
  for (let n = 0; n < 120; n++) stepWorld(world);
  for (const prev of [10, 11] as const) {
    const sample = cloneWorld(world);
    sample.version = prev;
    const before = cloneWorld(sample);
    const digest = digestoCanonico(before);
    assertWorld(before, prev);
    const migrated = migrateWorld(sample);
    assert.deepEqual(migrated, { ...before, version: 12 });
    assert.deepEqual(paramsOf(migrated), persisted);
    assert.deepEqual(paramsOf(sample), persisted);
    migrated.version = prev;
    assert.equal(digestoCanonico(migrated), digest, `normalizar sólo la etiqueta reproduce el digesto V${prev}`);
    migrated.version = 12;
    assertWorld(migrated);

    // Un V10/V11 sin diario ni punto de control recibe al cargar la MISMA normalización que la versión vigente.
    const sinOpcionales = cloneWorld(before);
    delete sinOpcionales.chronicleJournal;
    delete sinOpcionales.technology.checkpoint;
    assertWorld(sinOpcionales, prev);
    const normalizado = migrateWorld(sinOpcionales);
    assert.ok(normalizado.technology.checkpoint !== undefined && normalizado.chronicleJournal !== undefined);
  }
});

for (const previousVersion of [6, 7, 8, 9, 10, 11]) test(`a V${previousVersion} label cannot launder corrupt physical state through the V12 reader`, () => {
  const world = createWorld(); world.version = previousVersion;
  world.people[2]!.materials.wood = -1;
  const before = structuredClone(world);
  assert.throws(() => migrateWorld(world));
  assert.deepEqual(world, before);
  const future = createWorld(); future.version = RULES_VERSION + 1;
  assert.throws(() => migrateWorld(future));
});
