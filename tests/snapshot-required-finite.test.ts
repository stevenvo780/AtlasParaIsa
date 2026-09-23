import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, deepValidationDue } from '../src/server/store.js';
import { readStoredSnapshot } from '../src/server/snapshot-parts.js';
import type { LegacyRecord } from '../src/shared/demography.js';
import { assertWorld, cloneWorld, createWorld, type World } from '../src/world/index.js';
import { recordChronicleEvent } from '../src/world/chronicle-journal.js';
import { demographicTraits } from '../src/world/demography.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { paramsOf } from '../src/world/params.js';
import { researchTechnology, useTool, type TechnologyProgram } from '../src/world/technology.js';
import { generateChunk } from '../src/world/terrain.js';
import { filaInstantanea, sha256, todasLasTablas } from './lib/store.js';
import { proyectoInvestigacion } from './lib/escenas.js';

const fields = ['food', 'moisture', 'vegetation', 'x', 'y'] as const;
const formats = ['inline default', 'piezas forzadas'] as const;
const boundaries = ['warm', 'primer save tras load'] as const;
type Format = typeof formats[number];
type Boundary = typeof boundaries[number];


function advanceClock(world: World): void {
  world.tick++;
  for (const person of world.people) person.demography.age = world.tick - person.bornAt;
}

function worldWithTool(): World {
  const world = createWorld(42), actor = world.people[2]!;
  actor.materials.stone = 8; actor.energy = 1; actor.fatigue = 0.1;
  const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 4000 }],
    steps: [{ op: 'form', intensity: 4, shape: 'edge' }, { op: 'compress', intensity: 2 }] };
  actor.technology.project = proyectoInvestigacion(program, world.tick);
  for (let attempt = 0; actor.technology.project && attempt < 100; attempt++) {
    advanceClock(world); researchTechnology(world, actor);
  }
  assert.equal(actor.technology.project, null);
  assertWorld(world);
  return world;
}

function laboratory(t: TestContext, format: Format, boundary: Boundary) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-snapshot-required-finite-'));
  const path = join(directory, 'world.sqlite'), options = format === 'piezas forzadas' ? { snapshotInlineTileLimit: 0 } : {};
  let current: Store | undefined = new Store(path, options);
  const close = (): void => { const previous = current; current = undefined; previous?.close(); };
  t.after(() => { close(); rmSync(directory, { recursive: true, force: true }); });
  const reopen = (): Store => { close(); current = new Store(path, options); return current; };
  let world = worldWithTool();
  current.save(world);
  world.tiles[0]!.food = 0.3125;
  current.save(world);
  // El slot profundo se fija sintéticamente para aislar el rechazo sin 100 guardados por celda.
  current.db.exec('INSERT INTO snapshots SELECT 2,body,digest,saved_at FROM snapshots WHERE slot=1');
  assert.deepEqual((current.db.prepare('SELECT slot FROM snapshots ORDER BY slot').all() as { slot: number }[]).map(row => row.slot), [0, 1, 2]);
  const committedDigest = digestoCanonico(world);
  if (boundary === 'primer save tras load') world = reopen().load()!.world;
  assert.equal(deepValidationDue(boundary === 'warm' ? 2 : 0, boundary !== 'warm'), false,
    'la fixture llega por la ruta ligera cuya frontera de serialización se está probando');
  return { get store(): Store { return current!; }, world, committedDigest, reopen };
}

function pendingDraft(world: World, store: Store): World {
  const draft = cloneWorld(world, store.context);
  advanceClock(draft);
  assert.ok(useTool(draft, draft.people[2]!, 'cutting', 0.01));
  draft.events.push(recordChronicleEvent(draft, { kind: 'ecology', actors: [], text: 'Observación sintética.',
    cause: 'Frontera numérica obligatoria del snapshot.', source: 'simulation' }));
  const chunk = generateChunk(draft.seed, 0, 10, paramsOf(draft).agua.cuencas);
  chunk.lastTick = draft.tick;
  draft.retiredChunks = [chunk];
  const founder = draft.people.find(person => person.role === 'neighbor')!;
  const identity: LegacyRecord = {
    id: 'required-finite-fixture', name: 'Identidad sintética', role: 'neighbor', generation: 0,
    parents: [], bornAt: founder.bornAt, diedAt: draft.tick, cause: 'exposure',
    genome: structuredClone(founder.genome), traits: demographicTraits(founder.genome, paramsOf(draft).cuerpo), communityId: null,
  };
  draft.retiredLegacy = [identity]; draft.demographyDynamics.deaths++; draft.demographyDynamics.causes.exposure++;
  assertWorld(draft, draft.version, store.context);
  for (const queue of pendingQueues(draft)) assert.ok(queue.length > 0, 'cada cola pendiente tiene una observación real que conservar');
  return draft;
}

function pendingQueues(world: World): readonly unknown[][] {
  return [world.retiredChunks, world.retiredLegacy, world.chronicleJournal!.pending,
    world.technology.journal!.pending, world.technology.catalogue!.pending];
}

function rejectPreserving(store: Store, draft: World, before: unknown): void {
  const expected = structuredClone(draft), queues = pendingQueues(draft);
  assert.throws(() => store.save(draft), /required|finite|obligatori|numeric/i,
    'un número obligatorio inválido debe rechazarse antes de perderse como null en JSON');
  assert.equal(store.db.isTransaction, false);
  assert.deepEqual(todasLasTablas(store), before, 'el rechazo conserva TODAS las tablas, páginas y slots 0/1/2');
  assert.deepEqual(draft, expected, 'el candidato y el contenido de todas sus colas siguen intactos');
  pendingQueues(draft).forEach((queue, index) => assert.equal(queue, queues[index], 'no se sustituye ni confirma una cola pendiente'));
}

for (const format of formats) for (const boundary of boundaries) {
  for (const field of fields) for (const value of [NaN, Infinity, -Infinity]) {
    test(`required finite: ${format}, ${boundary}, ${field}=${String(value)} no confirma ni erosiona respaldos`, t => {
      const lab = laboratory(t, format, boundary), before = todasLasTablas(lab.store), draft = pendingDraft(lab.world, lab.store);
      draft.tiles[0]![field] = value;
      rejectPreserving(lab.store, draft, before);
      const reopened = lab.reopen(), loaded = reopened.load()!;
      assert.equal(loaded.slot, 0);
      assert.equal(digestoCanonico(loaded.world), lab.committedDigest);
      assert.deepEqual(todasLasTablas(reopened), before, 'cerrar y reabrir confirma que el rechazo no escribió nada durable');
    });
  }

  for (const value of [null, undefined, '0']) {
    test(`required finite: ${format}, ${boundary}, tipo ${String(value)} se rechaza en los cinco campos`, t => {
      const lab = laboratory(t, format, boundary), before = todasLasTablas(lab.store);
      for (const field of fields) {
        const draft = pendingDraft(lab.world, lab.store);
        (draft.tiles[0] as unknown as Record<string, unknown>)[field] = value;
        rejectPreserving(lab.store, draft, before);
      }
      const reopened = lab.reopen();
      assert.equal(digestoCanonico(reopened.load()!.world), lab.committedDigest);
      assert.deepEqual(todasLasTablas(reopened), before);
    });
  }

  test(`required finite: ${format}, ${boundary}, quince intentos inválidos conservan la misma cadena`, t => {
    const lab = laboratory(t, format, boundary), before = todasLasTablas(lab.store);
    const snapshots = lab.store.db.prepare('SELECT * FROM snapshots ORDER BY slot').all();
    for (const field of fields) for (const value of [NaN, Infinity, -Infinity]) {
      const draft = pendingDraft(lab.world, lab.store);
      draft.tiles[0]![field] = value;
      rejectPreserving(lab.store, draft, before);
    }
    const reopened = lab.reopen(), loaded = reopened.load()!;
    assert.equal(loaded.slot, 0);
    assert.equal(digestoCanonico(loaded.world), lab.committedDigest);
    assert.deepEqual(reopened.db.prepare('SELECT * FROM snapshots ORDER BY slot').all(), snapshots);
    assert.deepEqual(todasLasTablas(reopened), before);
  });

  for (const control of ['-0', 'ordinary bytes'] as const) {
    test(`required finite: ${format}, ${boundary}, control válido ${control} conserva bytes y digesto`, t => {
      const lab = laboratory(t, format, boundary), draft = pendingDraft(lab.world, lab.store), tile = draft.tiles[0]!;
      assert.equal(tile.x, 0); assert.equal(tile.y, 0);
      if (control === '-0') for (const field of fields) tile[field] = -0;
      else { tile.food = 0.125; tile.moisture = 0.25; tile.vegetation = 0.5; }
      assertWorld(draft, draft.version, lab.store.context);
      lab.store.save(draft);
      for (const queue of pendingQueues(draft)) assert.equal(queue.length, 0);
      const committedDigest = digestoCanonico(draft);
      const saved = filaInstantanea(lab.store);
      assert.equal(saved.digest, sha256(saved.body));
      if (control === 'ordinary bytes') {
        const tuples = draft.tiles.map(t => [t.x,t.y,t.terrain,t.moisture,t.vegetation,t.food,t.biome,t.elevation,
          t.wood,t.stone,t.feature,t.variety,t.growth,t.fertility,t.cultivation,t.traffic,t.drinkingWater,t.species,t.fauna,t.life]);
        if (format === 'inline default') {
          const { aplicacion, ...limits } = paramsOf(draft).limites;
          assert.ok(saved.body === JSON.stringify({ ...draft, retiredChunks: [], retiredLegacy: [], tiles: tuples,
            tileEncoding: 'tiles-tuple-v1', paramsEncoding: 'params-v1', params: paramsOf(draft),
            limitsProfile: { version: 2, aplicacion, ...limits } }), 'exact inline bytes include explicit parameters and limits profile');
        } else {
          const page = JSON.parse(saved.body).tiles.pages[0] as { digest: string; bytes: number };
          const body = (lab.store.db.prepare('SELECT body FROM snapshot_parts WHERE digest=?').get(page.digest) as { body: string }).body;
          assert.equal(body, JSON.stringify(tuples));
          assert.equal(page.digest, sha256(body));
          assert.equal(page.bytes, Buffer.byteLength(body));
        }
      }
      const transport = readStoredSnapshot(lab.store.db)!.value as World;
      for (const field of fields) assert.equal(Object.is(transport.tiles[0]![field], -0), control === '-0');
      const loaded = lab.reopen().load()!.world;
      assert.equal(digestoCanonico(loaded), committedDigest);
      for (const field of fields) assert.equal(Object.is(loaded.tiles[0]![field], -0), control === '-0');
    });
  }
}
