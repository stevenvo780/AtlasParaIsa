import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import type { LegacyRecord } from '../src/shared/demography.js';
import { assertWorld, cloneWorld, createWorld, type World } from '../src/world/index.js';
import { demographicTraits } from '../src/world/demography.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { assertLegacyRecord } from '../src/world/lineage.js';
import { paramsOf } from '../src/world/params.js';
import { activate } from '../src/world/spatial.js';
import { generateChunk } from '../src/world/terrain.js';

const checksum = (body: string): string => createHash('sha256').update(body).digest('hex');
interface ArchiveRow { body: string; digest: string; tick: number; }

function laboratory(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-snapshot-numeric-archive-'));
  const path = join(directory, 'world.sqlite');
  let current: Store | undefined = new Store(path);
  t.after(() => { current?.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    get store(): Store { return current!; },
    reopen(): Store {
      const previous = current!;
      current = undefined;
      previous.close();
      current = new Store(path);
      return current;
    },
  };
}

function syntheticLegacy(world: World, generation: number): LegacyRecord {
  const founder = world.people.find(person => person.role === 'neighbor')!;
  const record: LegacyRecord = {
    id: 'numeric-archive-fixture', name: 'Identidad sintética del archivo', role: 'neighbor',
    generation, parents: [], bornAt: founder.bornAt, diedAt: world.tick, cause: 'exposure',
    genome: structuredClone(founder.genome), traits: demographicTraits(founder.genome, paramsOf(world).cuerpo),
    communityId: null,
  };
  assertLegacyRecord(record, world.tick);
  return record;
}

for (const zero of [0, -0]) {
  const label = Object.is(zero, -0) ? '-0' : '+0 ordinario';

  test(`archivo numérico: chunk retirado conserva ${label} tras cerrar, reabrir y activar`, t => {
    const lab = laboratory(t), world = createWorld(42);
    const chunk = generateChunk(world.seed, 0, 10, paramsOf(world).agua.cuencas);
    // Una coordenada válida permite observar el bit sin avanzar ninguna ley física.
    chunk.tiles[0]!.x = zero;
    const expectedChunk = structuredClone(chunk);
    world.retiredChunks = [chunk];
    assertWorld(world);
    lab.store.save(world);
    assert.deepEqual(world.retiredChunks, [], 'el archivo ya fue confirmado, no sigue en la cola');
    const committedDigest = digestoCanonico(world);
    const saved = lab.store.db.prepare('SELECT body,digest,tick FROM chunks WHERE key=?').get(chunk.key) as unknown as ArchiveRow;
    assert.equal(saved.tick, world.tick);
    assert.equal(saved.digest, checksum(saved.body), 'el checksum acredita los bytes efectivamente escritos');
    assert.equal(lab.store.db.prepare('SELECT COUNT(*) AS n FROM chunks').get()!.n, 1);
    if (!Object.is(zero, -0)) assert.equal(saved.body, JSON.stringify(expectedChunk), 'el caso ordinario conserva los bytes históricos');

    const expected = cloneWorld(world);
    activate(expected, 0, 160, { loadChunk: key => key === chunk.key ? expectedChunk : null });
    assertWorld(expected);
    assert.equal(Object.is(expected.tiles.find(tile => tile.x === 0 && tile.y === 160)!.x, -0), Object.is(zero, -0), 'el normalizador de activación preserva el signo de la referencia');
    const expectedDigest = digestoCanonico(expected);

    const reopened = lab.reopen(), resumed = reopened.load()!.world;
    assert.equal(digestoCanonico(resumed), committedDigest, 'el estado confirmado residente es el mismo antes de recuperar el archivo');
    assert.deepEqual(reopened.db.prepare('SELECT body,digest,tick FROM chunks WHERE key=?').get(chunk.key), saved, 'reabrir no cambia la fila archivada');
    const restoredChunk = reopened.loadChunk(chunk.key, world.tick)!;
    activate(resumed, 0, 160, reopened.context);
    assertWorld(resumed);
    const observed = {
      archivedNegativeZero: Object.is(restoredChunk.tiles[0]!.x, -0),
      activatedNegativeZero: Object.is(resumed.tiles.find(tile => tile.x === 0 && tile.y === 160)!.x, -0),
      digest: digestoCanonico(resumed),
    };
    t.diagnostic(JSON.stringify({ kind: 'chunk', input: label, checksumValid: saved.digest === checksum(saved.body),
      rowPreservesNegativeZero: Object.is((JSON.parse(saved.body) as typeof chunk).tiles[0]!.x, -0), ...observed, expectedDigest }));
    assert.deepEqual(observed, {
      archivedNegativeZero: Object.is(zero, -0), activatedNegativeZero: Object.is(zero, -0), digest: expectedDigest,
    }, 'el archivo y la reactivación deben conservar el bit y el digesto completo');
  });

  test(`archivo numérico: identidad durable conserva ${label} fuera del caché de la instantánea`, t => {
    const lab = laboratory(t), world = createWorld(42), record = syntheticLegacy(world, zero);
    // Dejar vacío el caché aísla la fila durable de la codificación de snapshots.
    world.retiredLegacy = [record];
    world.demographyDynamics.deaths = 1;
    world.demographyDynamics.causes.exposure = 1;
    assertWorld(world);
    lab.store.save(world);
    assert.deepEqual(world.retiredLegacy, []);
    assert.deepEqual(world.legacy, []);
    const committedDigest = digestoCanonico(world);
    const saved = lab.store.db.prepare('SELECT body,digest,tick FROM legacy WHERE id=?').get(record.id) as unknown as ArchiveRow;
    assert.equal(saved.tick, world.tick);
    assert.equal(saved.digest, checksum(saved.body));
    assert.equal(lab.store.db.prepare('SELECT COUNT(*) AS n FROM legacy').get()!.n, 1);
    if (!Object.is(zero, -0)) assert.equal(saved.body, JSON.stringify(record), 'las identidades ordinarias mantienen sus bytes');
    const expected = cloneWorld(world);
    expected.legacy = [structuredClone(record)];
    assertWorld(expected);
    const expectedDigest = digestoCanonico(expected);

    const reopened = lab.reopen(), resumed = reopened.load()!.world;
    assert.equal(digestoCanonico(resumed), committedDigest, 'el estado confirmado sin caché no oculta una diferencia de snapshot');
    assert.deepEqual(reopened.db.prepare('SELECT body,digest,tick FROM legacy WHERE id=?').get(record.id), saved);
    const restored = reopened.loadLegacy(record.id, resumed.tick)!;
    assertLegacyRecord(restored, resumed.tick);
    // Reincorporar la identidad leída al caché hace observable el archivo en el digesto completo.
    resumed.legacy = [restored];
    assertWorld(resumed);
    const observed = { archivedNegativeZero: Object.is(restored.generation, -0), digest: digestoCanonico(resumed) };
    t.diagnostic(JSON.stringify({ kind: 'legacy', input: label, checksumValid: saved.digest === checksum(saved.body),
      rowPreservesNegativeZero: Object.is((JSON.parse(saved.body) as LegacyRecord).generation, -0), ...observed, expectedDigest }));
    assert.deepEqual(observed, { archivedNegativeZero: Object.is(zero, -0), digest: expectedDigest },
      'la identidad durable debe conservar el bit aunque no aparezca en el caché de la instantánea');
  });
}

test('archivo numérico: cambiar sólo -0 a +0 no puede reescribir una identidad durable', t => {
  const lab = laboratory(t), world = createWorld(42), ordinary = syntheticLegacy(world, 0);
  world.retiredLegacy = [ordinary];
  world.demographyDynamics.deaths = 1;
  world.demographyDynamics.causes.exposure = 1;
  lab.store.save(world);
  const committedDigest = digestoCanonico(world);
  const saved = lab.store.db.prepare('SELECT body,digest,tick FROM legacy WHERE id=?').get(ordinary.id) as unknown as ArchiveRow;
  // Fixture JSON válida, con checksum correcto: aísla la comparación de identidad
  // de la pérdida de signo que pueda existir todavía en el escritor.
  const negativeBody = saved.body.replace('"generation":0', '"generation":-0');
  const signed = JSON.parse(negativeBody) as LegacyRecord;
  assert.equal(Object.is(signed.generation, -0), true);
  assertLegacyRecord(signed, world.tick);
  lab.store.db.prepare('UPDATE legacy SET body=?,digest=? WHERE id=?').run(negativeBody, checksum(negativeBody), ordinary.id);
  const reopened = lab.reopen(), resumed = reopened.load()!.world;
  assert.equal(digestoCanonico(resumed), committedDigest);
  assert.equal(Object.is(reopened.loadLegacy(ordinary.id)!.generation, -0), true, 'JSON.parse conserva un token -0 genuino');
  resumed.retiredLegacy = [ordinary];
  let failure: unknown;
  try { reopened.save(resumed); } catch (error) { failure = error; }
  const preserved = reopened.db.prepare('SELECT body,digest,tick FROM legacy WHERE id=?').get(ordinary.id) as unknown as ArchiveRow;
  assert.deepEqual({ ...preserved }, { ...saved, body: negativeBody, digest: checksum(negativeBody) });
  assert.equal(digestoCanonico(reopened.load()!.world), committedDigest, 'el estado confirmado permanece igual tras el intento');
  t.diagnostic(JSON.stringify({ kind: 'legacy-immutable', rejected: failure instanceof Error,
    archivedNegativeZero: Object.is(reopened.loadLegacy(ordinary.id)!.generation, -0), pending: resumed.retiredLegacy.length }));
  assert.ok(failure instanceof Error && /cannot be overwritten/.test(failure.message),
    'el cambio exclusivo del bit de signo debe rechazarse como cambio de identidad, no confirmarse y vaciar la cola');
  assert.deepEqual(resumed.retiredLegacy, [ordinary], 'la identidad rechazada queda pendiente para recuperación explícita');
});
