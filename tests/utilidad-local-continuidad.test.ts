import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/server/store.js';
import { SNAPSHOT_INLINE_TILE_LIMIT } from '../src/server/snapshot-parts.js';
import { createWorld, stepWorld, type Person, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { paramsOf, parseParams } from '../src/world/params.js';
import type { Gesture } from '../src/shared/types.js';
import { filaInstantanea, laboratorio, sha256 } from './lib/store.js';

// Congelado antes de ejecutar: fixture técnico, sin calibración ni selección de semillas/cortes.
const SEED = 19017, MID = 160, END = 320;
const GHAT = [1, 1, 1, 1, 1, 1, 1, 1];
type LearnedPerson = Person & { utilidadLocal?: Partial<Record<'gather', { q: number; intentos: number }>> };

/** Únicos cambios físicos, TODOS iniciales: necesidades .1/energía1; demás actores
 * con orden rest local; actor vecino en la primera celda terrestre residente
 * x>=32,y<=4, sin materiales y con stock real local wood12/stone8. No se cambia
 * genoma, habilidad, q ni trabajo pagado; no se retocan necesidades o stocks después.
 * El actor recibe la orden gather mediante el gesto real del primer paso. */
function fixture(): { world: World; actorId: string; order: Gesture } {
  const world = createWorld(SEED, parseParams({ conducta: { utilidadLocal: 1, utilidadLocalGhat: GHAT } }));
  const actor = world.people.find(person => person.role === 'neighbor')!;
  assert.ok(actor);
  for (const person of world.people) {
    assert.equal(Object.hasOwn(person, 'utilidadLocal'), false, 'no se introduce aprendizaje de fixture');
    assert.equal(person.work, 0);
    person.hunger = person.thirst = person.fatigue = 0.1;
    person.energy = 1;
    if (person === actor) continue;
    person.command = { order: 'rest', x: person.x, y: person.y };
    person.controlMode = 'directed';
    person.action = 'rest'; person.target = { x: person.x, y: person.y };
    person.decisionAt = 0;
  }
  const tile = world.tiles.find(tile => tile.x >= 32 && tile.y <= 4 && tile.terrain !== 'water')!;
  assert.ok(tile, 'celda terrestre elegida por regla fija, sin búsqueda de resultados');
  actor.x = tile.x; actor.y = tile.y; actor.target = { x: tile.x, y: tile.y };
  actor.materials = { wood: 0, stone: 0 }; actor.decisionAt = 0;
  tile.wood = 12; tile.stone = 8;
  return { world, actorId: actor.id, order: { id: 'continuity-gather-19017', kind: 'command', agentId: actor.id, order: 'gather', x: tile.x, y: tile.y } };
}
function actorOf(world: World, id: string): LearnedPerson {
  const person = world.people.find(person => person.id === id);
  assert.ok(person, `el actor ${id} sigue presente en paso ${world.tick}`);
  return person;
}
function learningState(world: World): unknown {
  return world.people.map(person => ({ id: person.id, work: person.work, utilidadLocal: (person as LearnedPerson).utilidadLocal }));
}
function sameWorld(a: World, b: World): void {
  assert.equal(b.tick, a.tick);
  assert.deepEqual(paramsOf(b), paramsOf(a));
  assert.deepEqual(learningState(b), learningState(a), `q, contadores y trabajo en paso ${a.tick}`);
  assert.equal(digestoCanonico(b), digestoCanonico(a), `digesto completo en paso ${a.tick}`);
}

/** Comprueba que el transporte solicitado se escribió realmente, incluyendo las
 * páginas durables, su hash y número de filas; el umbral solo no es evidencia. */
function checkTransport(store: Store, world: World, paged: boolean): void {
  const body = filaInstantanea(store).body;
  const record = JSON.parse(body) as {
    snapshotEncoding?: string; tileEncoding?: string;
    world?: { tiles: unknown; params: unknown; people: unknown };
    params?: unknown; people?: unknown;
    tiles: unknown[] | { count: number; pages: { digest: string; count: number; bytes: number }[] };
  };
  if (!paged) {
    assert.equal(record.snapshotEncoding, undefined);
    assert.equal(record.tileEncoding, 'tiles-tuple-v1');
    assert.ok(Array.isArray(record.tiles));
    assert.equal(record.tiles.length, world.tiles.length);
    assert.deepEqual(record.params, paramsOf(world));
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM snapshot_parts').get() as { n: number }).n, 0);
    return;
  }
  assert.equal(record.snapshotEncoding, 'snapshot-parts-v1');
  assert.equal(record.world!.tiles, null);
  assert.deepEqual(record.world!.params, paramsOf(world));
  assert.ok(!Array.isArray(record.tiles));
  assert.equal(record.tiles.count, world.tiles.length);
  assert.ok(record.tiles.pages.length > 0);
  let count = 0;
  for (const page of record.tiles.pages) {
    const row = store.db.prepare('SELECT body FROM snapshot_parts WHERE digest=?').get(page.digest) as { body: string } | undefined;
    assert.ok(row, 'cada página del manifiesto existe en SQLite');
    assert.equal(sha256(row.body), page.digest);
    assert.equal(Buffer.byteLength(row.body), page.bytes);
    const tiles = JSON.parse(row.body) as unknown[][];
    assert.equal(tiles.length, page.count);
    assert.ok(tiles.every(tile => tile.length === 20));
    count += page.count;
  }
  assert.equal(count, world.tiles.length);
}

for (const paged of [false, true]) {
  test(`Ley 2′: trabajo real y continuación exacta 160/320 tras cerrar Store ${paged ? 'por páginas' : 'inline'}`, t => {
    const options = { snapshotInlineTileLimit: paged ? 0 : SNAPSHOT_INLINE_TILE_LIMIT };
    const a = fixture(), b = fixture();
    const labA = laboratorio(t, 'atlas-utilidad-continuidad-a-', options);
    const labB = laboratorio(t, 'atlas-utilidad-continuidad-b-', options);
    let resumedStore: Store | undefined;
    let continuation = b.world;
    let paidOutcomes = 0, positiveOutcomes = 0;
    let midEvidence: unknown;
    try {
      // Ambos usan el mismo contrato de Store desde el principio: catalogue/journals
      // se habilitan en los dos; solo el brazo B se restaura en el corte congelado.
      labA.store.save(a.world); labB.store.save(continuation);
      sameWorld(a.world, continuation);
      checkTransport(labA.store, a.world, paged);
      checkTransport(labB.store, continuation, paged);
      for (let tick = 1; tick <= END; tick++) {
        const actor = actorOf(a.world, a.actorId);
        const before = { work: actor.work, material: actor.materials.wood + actor.materials.stone,
          q: actor.utilidadLocal?.gather?.q, attempts: actor.utilidadLocal?.gather?.intentos ?? 0 };
        const resultA = stepWorld(a.world, tick === 1 ? [a.order] : []);
        const resultB = stepWorld(continuation, tick === 1 ? [b.order] : []);
        assert.deepEqual(resultB, resultA);
        if (tick === 1) assert.equal(resultA[0]!.accepted, true, 'orden dirigida aceptada por el camino real');
        const after = actorOf(a.world, a.actorId), learned = after.utilidadLocal?.gather;
        const deltaAttempts = (learned?.intentos ?? 0) - before.attempts;
        assert.ok(deltaAttempts === 0 || deltaAttempts === 1, 'un paso no inventa varios intentos');
        if (deltaAttempts === 1) {
          paidOutcomes++;
          assert.equal(after.action, 'gather');
          assert.ok(before.work > 0, 'el resultado llega después de trabajo realmente acumulado');
          assert.equal(after.work, 0, 'la acción terminó el intento');
          const actualGain = after.materials.wood + after.materials.stone - before.material;
          assert.ok(actualGain >= 0);
          if (actualGain > 0) positiveOutcomes++;
          const y = Math.min(1, Math.max(0, actualGain / (before.work + 1)));
          const expectedQ = before.q === undefined ? y : before.q + after.genome.learningRate * (y - before.q);
          assert.equal(learned!.q, expectedQ, 'q procede de beneficio y ticks reales, no de un preset');
          assert.equal(learned!.intentos, paidOutcomes);
        }
        sameWorld(a.world, continuation);
        if (tick === MID) {
          assert.ok(paidOutcomes >= 3, 'al menos tres intentos pagados realmente terminados antes del corte');
          assert.ok(positiveOutcomes >= 3, 'al menos tres intentos extrajeron material real');
          assert.ok(after.work > 0, 'el corte fijo contiene trabajo real en curso, sin modificarlo');
          assert.equal(after.action, 'gather');
          midEvidence = { tick, paidOutcomes, positiveOutcomes, work: after.work, gather: structuredClone(learned) };
          labA.store.save(a.world); labB.store.save(continuation);
          sameWorld(a.world, continuation);
          checkTransport(labA.store, a.world, paged); checkTransport(labB.store, continuation, paged);
          assert.equal(filaInstantanea(labB.store).body, filaInstantanea(labA.store).body);
          labB.store.close();
          resumedStore = new Store(labB.path, options);
          const loaded = resumedStore.load()!;
          assert.equal(loaded.slot, 0);
          continuation = loaded.world;
          sameWorld(a.world, continuation);
        }
      }
      const finalActor = actorOf(a.world, a.actorId);
      assert.ok(finalActor.utilidadLocal!.gather!.intentos > (midEvidence as { paidOutcomes: number }).paidOutcomes,
        'el trabajo y aprendizaje continuaron después de restaurar');
      labA.store.save(a.world); resumedStore!.save(continuation);
      sameWorld(a.world, continuation);
      checkTransport(labA.store, a.world, paged); checkTransport(resumedStore!, continuation, paged);
      assert.equal(filaInstantanea(resumedStore!).body, filaInstantanea(labA.store).body);
      t.diagnostic(JSON.stringify({ seed: SEED, steps: END, midpoint: MID, transport: paged ? 'snapshot-parts-v1' : 'inline',
        mid: midEvidence, final: { tick: END, paidOutcomes, positiveOutcomes, work: finalActor.work,
          gather: finalActor.utilidadLocal!.gather, digest: digestoCanonico(a.world) } }));
    } finally { resumedStore?.close(); }
  });
}
