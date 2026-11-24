import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store, DEEP_CHECKPOINT_EVERY_SAVES, DEEP_VALIDATION_EVERY_SAVES } from '../src/server/store.js';
import { captureReplayChange, decodeSnapshot, encodeSnapshot, readSnapshotReplay, takeSnapshotParams } from '../src/server/snapshot.js';
import { cloneWorld, createWorld, migrateWorld, stepWorld, type World } from '../src/world/index.js';
import { diferenciaCanonica, digestoCanonico } from '../src/world/digesto.js';
import { paramsOf, parseParams, setParams } from '../src/world/params.js';
import type { Gesture } from '../src/shared/types.js';
import { directorioTemporal, filaInstantanea, laboratorio, reescribirInstantanea, sha256, todasLasTablas } from './lib/store.js';

const replayParams = parseParams('persistencia.paginasSucias=true');
const head = (store: Store, slot = 0) => readSnapshotReplay(JSON.parse(filaInstantanea(store, slot).body))!;
function fullDigest(world: World, store: Store): string {
  const decoded = decodeSnapshot(encodeSnapshot(world, paramsOf(world))) as World;
  setParams(decoded, takeSnapshotParams(decoded));
  return digestoCanonico(migrateWorld(decoded, store.context));
}
function comparable(world: World): World {
  const copy = cloneWorld(world); setParams(copy, replayParams); return copy;
}

test('replay: ticks, gestos, journals y reinicios tienen paridad canónica con el guardado completo', t => {
  const directory = directorioTemporal(t, 'atlas-replay-parity-');
  const full = new Store(join(directory, 'full.sqlite'));
  let delta = new Store(join(directory, 'delta.sqlite'), { snapshotInlineTileLimit: 0 });
  t.after(() => { full.close(); delta.close(); });
  const control = createWorld(51926);
  let world = createWorld(51926, replayParams);
  full.save(control); delta.save(world);
  const digests = [digestoCanonico(world)];
  for (let save = 1; save <= 14; save++) {
    const pending: Parameters<Store['save']>[1] = [];
    for (let tick = 0; tick < 4; tick++) {
      const gestures: Gesture[] = tick === 3 ? [{ id: `gesture-${save}`, kind: save % 2 ? 'invite' : 'plant', x: 17, y: 13 }] : [];
      const results = stepWorld(world, gestures, delta.context);
      assert.deepEqual(stepWorld(control, gestures, full.context), results);
      pending.push(...gestures.map((gesture, i) => ({ gesture, result: results[i]! })));
    }
    full.save(control, pending); delta.save(world, pending);
    const digest = digestoCanonico(world);
    assert.equal(digest, fullDigest(world, delta));
    assert.equal(digest, digestoCanonico(comparable(full.load()!.world)));
    assert.equal(digestoCanonico(delta.load()!.world), digest);
    const recovered = join(directory, `previous-${save}.sqlite`);
    assert.equal(delta.previous(recovered), 1);
    const previous = new Store(recovered, { readOnly: true });
    try { assert.equal(digestoCanonico(previous.load()!.world), digests.at(-1)); }
    finally { previous.close(); }
    digests.push(digest);
    if (save % 3 === 0) {
      delta.close(); delta = new Store(join(directory, 'delta.sqlite'), { snapshotInlineTileLimit: 0 });
      world = delta.load()!.world;
    }
  }
  const node = head(delta);
  assert.equal(node.kind, 'delta'); assert.equal(node.depth, 14);
  assert.ok(!filaInstantanea(delta).body.includes('"tiles"'), 'el delta no serializa el terreno numérico');
});

test('replay: checkpoint durable cada 100 guardados, <=99 deltas incluso tras reiniciar y previous exacto en el rollover', t => {
  const { path, directory, store: initial } = laboratorio(t, 'atlas-replay-rollover-');
  let store = initial;
  let world = createWorld(11, replayParams);
  let lastDigest: string | null = null;
  t.after(() => { if (store !== initial) store.close(); });
  for (let save = 1; save <= 202; save++) {
    if ([99, 100, 101, 199, 200, 201].includes(save)) stepWorld(world, [], store.context);
    const priorDigest = save > 1 ? digestoCanonico(world) : null;
    // The previous digest is captured independently of the new step below.
    const before: string | null = lastDigest;
    store.save(world);
    lastDigest = digestoCanonico(world);
    const node = head(store);
    assert.ok(node.depth <= DEEP_CHECKPOINT_EVERY_SAVES - 1);
    if (save === 1 || save % 100 === 0) assert.equal(node.kind, 'checkpoint');
    if (save === 199) assert.equal(node.depth, 99);
    if ([100, 101, 200, 201].includes(save)) {
      assert.equal(digestoCanonico(store.load()!.world), priorDigest);
      const destination = join(directory, `rollover-${save}.sqlite`);
      store.previous(destination);
      const previous = new Store(destination);
      try { assert.equal(digestoCanonico(previous.load()!.world), before); }
      finally { previous.close(); }
      store.close(); store = new Store(path); world = store.load()!.world;
    }
  }
  const objects = store.db.prepare("SELECT count(*) AS n FROM metadata WHERE key GLOB 'snapshot-replay-v1:*'").get()!.n as number;
  assert.ok(objects <= 2 * DEEP_CHECKPOINT_EVERY_SAVES + 3, `objetos retenidos acotados: ${objects}`);
});

test('replay: cambios externos marcados en su tick conservan valores exactos y borrados', t => {
  const { store } = laboratorio(t, 'atlas-replay-dirty-');
  const world = createWorld(7, replayParams); store.save(world);
  world.learningEnabled = false;
  const before = captureReplayChange(world, ['learningEnabled']);
  stepWorld(world, [], store.context);
  world.tiles[0]!.traffic = -0;
  const after = captureReplayChange(world, ['tiles', '0', 'traffic']);
  world.people[0]!.lastInvention = world.tick;
  const optional = captureReplayChange(world, ['people', '0', 'lastInvention']);
  store.save(world, [], [], [before, after, optional]);
  assert.equal(digestoCanonico(store.load()!.world), digestoCanonico(world));
  assert.ok(Object.is(store.load()!.world.tiles[0]!.traffic, -0));
  delete world.people[0]!.lastInvention;
  store.save(world, [], [], [captureReplayChange(world, ['people', '0', 'lastInvention'])]);
  assert.equal(digestoCanonico(store.load()!.world), fullDigest(world, store));
  assert.throws(() => captureReplayChange(world, ['__proto__', 'polluted']), /dirty path/);
  setParams(world, parseParams('persistencia.cadaTicks=40', paramsOf(world)));
  const params = captureReplayChange(world, ['$params']);
  stepWorld(world, [], store.context);
  store.save(world, [], [], [params]);
  assert.equal(digestoCanonico(store.load()!.world), digestoCanonico(world));
});

test('replay: volver al guardado completo y reactivar crea una nueva ancla sin perder previous', t => {
  const { store, directory } = laboratorio(t, 'atlas-replay-toggle-');
  const world = createWorld(7, replayParams); store.save(world);
  stepWorld(world, [], store.context); store.save(world);
  const expected = digestoCanonico(world);
  setParams(world, parseParams('persistencia.paginasSucias=false', paramsOf(world)));
  store.save(world);
  assert.equal(readSnapshotReplay(JSON.parse(filaInstantanea(store).body)), null);
  assert.equal(digestoCanonico(store.load()!.world), digestoCanonico(world));
  const destination = join(directory, 'previous.sqlite'); store.previous(destination);
  const previous = new Store(destination);
  try { assert.equal(digestoCanonico(previous.load()!.world), expected); }
  finally { previous.close(); }
  setParams(world, replayParams); store.save(world);
  assert.equal(head(store).kind, 'checkpoint');
  assert.equal(digestoCanonico(store.load()!.world), digestoCanonico(world));
});

test('replay: auditoría profunda rechaza una página no marcada sin modificar la cadena', t => {
  const { store } = laboratorio(t, 'atlas-replay-audit-');
  const world = createWorld(3, replayParams);
  for (let save = 1; save < 10; save++) store.save(world);
  const before = todasLasTablas(store), valid = digestoCanonico(world);
  world.tiles[0]!.moisture *= 0.5;
  assert.throws(() => store.save(world), /unmarked page or state/);
  assert.deepEqual(todasLasTablas(store), before);
  assert.equal(digestoCanonico(store.load()!.world), valid);
  store.save(world, [], [], [captureReplayChange(world, ['tiles', '0', 'moisture'])]);
  assert.equal(digestoCanonico(store.load()!.world), digestoCanonico(world));
});

test('replay: una mutación no marcada tampoco entra entre auditorías ni en el checkpoint', t => {
  const { store } = laboratorio(t, 'atlas-replay-unmarked-');
  const world = createWorld(3, replayParams); store.save(world);
  const before = todasLasTablas(store);
  world.learningEnabled = false;
  assert.throws(() => store.save(world), /unmarked page or state/);
  assert.deepEqual(todasLasTablas(store), before);
});

test('replay: interrupción operacional a mitad del replay no escribe ni contamina un reintento', t => {
  const { store, path } = laboratorio(t, 'atlas-replay-interrupt-');
  const world = createWorld(51926, replayParams); store.save(world);
  for (let n = 0; n < 5; n++) { stepWorld(world, [], store.context); store.save(world); }
  const before = todasLasTablas(store), prepare = store.db.prepare.bind(store.db);
  let reads = 0;
  store.db.prepare = (sql: string) => {
    if (sql === 'SELECT value FROM main.metadata WHERE key=?' && ++reads === 3) throw new Error('simulated replay interruption');
    return prepare(sql);
  };
  assert.throws(() => store.load(), /simulated replay interruption/);
  store.db.prepare = prepare;
  assert.equal(store.db.isTransaction, false);
  assert.deepEqual(todasLasTablas(store), before);
  const cold = new Store(path, { readOnly: true });
  try { assert.equal(digestoCanonico(cold.load()!.world), digestoCanonico(world)); }
  finally { cold.close(); }
});

test('replay: padre corrupto o ausente falla cerrado; previous conserva el eslabón sano', t => {
  for (const missing of [false, true]) {
    const { store, directory } = laboratorio(t, 'atlas-replay-corrupt-');
    const world = createWorld(7, replayParams); store.save(world);
    for (let n = 0; n < 4; n++) { stepWorld(world, [], store.context); store.save(world); }
    const previousDigest = digestoCanonico(world);
    stepWorld(world, [], store.context); store.save(world);
    const current = head(store);
    assert.equal(current.kind, 'delta');
    const corrupt = sha256(filaInstantanea(store).body);
    if (missing) store.db.prepare('DELETE FROM metadata WHERE key=?').run('snapshot-replay-v1:' + corrupt);
    else store.db.prepare('UPDATE metadata SET value=? WHERE key=?').run('{}', 'snapshot-replay-v1:' + corrupt);
    // Damage the selected head's parent, leaving slot 1 intact for explicit recovery.
    const body = JSON.parse(filaInstantanea(store).body); body.parent = corrupt;
    const encoded = JSON.stringify(body);
    store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(encoded, sha256(encoded));
    const before = todasLasTablas(store);
    try { assert.equal(digestoCanonico(store.load()!.world), previousDigest); }
    catch (error) { assert.match(String(error), /Replay|replay|Explicit recovery/); }
    assert.deepEqual(todasLasTablas(store), before);
    const destination = join(directory, 'recovered.sqlite'); store.previous(destination);
    const recovered = new Store(destination);
    try { assert.equal(digestoCanonico(recovered.load()!.world), previousDigest); }
    finally { recovered.close(); }
  }
});

test('replay: fallo transaccional al escribir delta deja heads, journals e inputs reintentables', t => {
  const { store } = laboratorio(t, 'atlas-replay-transaction-');
  const world = createWorld(11, replayParams); store.save(world);
  const gesture: Gesture = { id: 'transaction-input', kind: 'invite', x: 17, y: 13 };
  const results = stepWorld(world, [gesture], store.context);
  store.db.exec("CREATE TRIGGER cut_replay BEFORE INSERT ON metadata WHEN NEW.key GLOB 'snapshot-replay-v1:*' BEGIN SELECT RAISE(ABORT,'simulated commit cut'); END");
  const before = todasLasTablas(store), pending = digestoCanonico(world);
  assert.throws(() => store.save(world, [{ gesture, result: results[0]! }]), /simulated commit cut/);
  assert.deepEqual(todasLasTablas(store), before); assert.equal(digestoCanonico(world), pending);
  store.db.exec('DROP TRIGGER cut_replay');
  store.save(world, [{ gesture, result: results[0]! }]);
  assert.equal(digestoCanonico(store.load()!.world), digestoCanonico(world));
  assert.deepEqual(store.result(gesture), results[0]);
});

test('replay: corrupción en el interior de la cadena falla cerrada sin reparar ni crear destinos', t => {
  const { store, directory } = laboratorio(t, 'atlas-replay-middle-');
  const world = createWorld(7, replayParams); store.save(world);
  for (let n = 0; n < 5; n++) { stepWorld(world, [], store.context); store.save(world); }
  const node = head(store);
  assert.ok(node.kind === 'delta');
  const parent = JSON.parse(store.db.prepare('SELECT value FROM metadata WHERE key=?').get('snapshot-replay-v1:' + node.parent)!.value as string);
  const key = 'snapshot-replay-v1:' + parent.parent;
  const original = store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)!.value as string;
  store.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(original.slice(0, -8), key);
  const before = todasLasTablas(store);
  assert.throws(() => store.load(), /Replay parent|unusable/);
  const destination = join(directory, 'must-not-exist.sqlite');
  assert.throws(() => store.previous(destination), /No valid previous/);
  assert.deepEqual(todasLasTablas(store), before);
  store.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(original, key);
  assert.equal(digestoCanonico(store.load()!.world), digestoCanonico(world));
});

test('replay: una raíz recalculada incorrecta o profundidad >99 no autoriza retroceso silencioso', t => {
  const { store } = laboratorio(t, 'atlas-replay-root-');
  const world = createWorld(7, replayParams); store.save(world);
  stepWorld(world, [], store.context); store.save(world);
  const original = filaInstantanea(store).body;
  for (const patch of [{ root: '0'.repeat(64) }, { depth: 100 }]) {
    const body = JSON.stringify({ ...JSON.parse(original), ...patch });
    store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body, sha256(body));
    const before = todasLasTablas(store);
    assert.throws(() => store.load(), /canonical hash|Invalid snapshot replay/);
    assert.deepEqual(todasLasTablas(store), before);
  }
});

test('replay: deltas de fase 1 con raíz canónica siguen siendo legibles', t => {
  const { store } = laboratorio(t, 'atlas-replay-phase1-root-');
  const world = createWorld(7, replayParams); store.save(world);
  stepWorld(world, [], store.context); store.save(world);
  const legacy = { ...JSON.parse(filaInstantanea(store).body), root: digestoCanonico(world) };
  const body = JSON.stringify(legacy);
  store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body, sha256(body));
  assert.equal(digestoCanonico(store.load()!.world), digestoCanonico(world));
});

test('replay: confirma raíces históricas con el gobernador personalizado y permite continuar la cadena', t => {
  const { store, directory, path } = laboratorio(t, 'atlas-replay-legacy-governor-');
  const world = createWorld(7, replayParams);
  store.save(world);
  const checkpoint = head(store);
  assert.equal(checkpoint.kind, 'checkpoint');
  const gobernador = { presupuestoMs: 100, senales: ['rss'], politica: 'apagar' } as const;
  const instantanea = JSON.parse(checkpoint.body);
  instantanea.params.gobernador = gobernador;
  checkpoint.body = JSON.stringify(instantanea);
  checkpoint.root = digestoCanonico(world, gobernador);
  const checkpointAnterior = filaInstantanea(store).digest;
  const cuerpo = JSON.stringify(checkpoint);
  const clave = (digest: string) => 'snapshot-replay-v1:' + digest;
  store.db.prepare('UPDATE metadata SET key=?,value=? WHERE key=?')
    .run(clave(sha256(cuerpo)), cuerpo, clave(checkpointAnterior));
  reescribirInstantanea(store, cuerpo);

  stepWorld(world, [], store.context);
  store.save(world);
  const delta = head(store);
  assert.equal(delta.kind, 'delta');
  const params = parseParams('red.deltas=true', replayParams);
  const nuevo = { ...gobernador, presupuestoMs: 200 };
  setParams(world, params);
  delta.changes.push({ tick: world.tick, path: ['$params'], present: true,
    value: { ...params, 'gobernador.presupuestoMs': nuevo.presupuestoMs } });
  delta.root = digestoCanonico(world, nuevo);
  reescribirInstantanea(store, JSON.stringify({ ...delta, root: '0'.repeat(64) }));
  assert.throws(() => store.load(), /Replay canonical hash mismatch/);
  reescribirInstantanea(store, JSON.stringify({ ...delta, changes: [{ ...delta.changes[0], value: [] }] }));
  assert.throws(() => store.load(), /Invalid replay parameter change/);
  const deltaLegado = JSON.stringify(delta);
  store.db.prepare('INSERT INTO metadata VALUES (?,?)').run(clave(sha256(deltaLegado)), deltaLegado);
  reescribirInstantanea(store, deltaLegado);

  const reopened = new Store(path);
  try {
    const cargado = reopened.load()!.world;
    assert.deepEqual(paramsOf(cargado), params);
    assert.equal(digestoCanonico(cargado), digestoCanonico(world));
    stepWorld(cargado, [], reopened.context);
    reopened.save(cargado);
    assert.deepEqual(diferenciaCanonica(reopened.load()!.world, cargado), null);
    const previous = join(directory, 'previous.sqlite');
    reopened.previous(previous);
    const backup = new Store(previous);
    try { assert.equal(digestoCanonico(backup.load()!.world), digestoCanonico(world)); }
    finally { backup.close(); }
  } finally { reopened.close(); }
});

test('replay: save() y previous() mantienen beginHostTransaction activo durante prepareReplay/readSnapshot', t => {
  const { store, directory } = laboratorio(t, 'atlas-replay-host-tx-');
  const world = createWorld(51926, replayParams);
  store.save(world);
  for (let i = 0; i < 6; i++) stepWorld(world, [], store.context);
  const archive = (store as unknown as { technologyArchive: { hostTransaction: boolean; clearProofs: () => void } }).technologyArchive;
  const prepareReplay = (store as unknown as { prepareReplay: (...args: unknown[]) => unknown }).prepareReplay.bind(store);
  let txActiveInPrepare = false;
  (store as unknown as { prepareReplay: (...args: unknown[]) => unknown }).prepareReplay = (...args: unknown[]) => {
    txActiveInPrepare = archive.hostTransaction;
    return prepareReplay(...args);
  };
  store.save(world);
  assert.equal(txActiveInPrepare, true, 'beginHostTransaction debe estar activo antes de prepareReplay para no reescanear technology_definitions');

  const readSnapshot = (store as unknown as { readSnapshot: (body: string) => unknown }).readSnapshot.bind(store);
  let txActiveInPreviousRead = false;
  (store as unknown as { readSnapshot: (body: string) => unknown }).readSnapshot = (body: string) => {
    txActiveInPreviousRead = archive.hostTransaction;
    return readSnapshot(body);
  };
  store.previous(join(directory, 'prev.sqlite'));
  assert.equal(txActiveInPreviousRead, true, 'beginHostTransaction debe estar activo antes de readSnapshot en previous()');
});

test('replay: control de bytes escritos y saveMs con la misma escena y cadencia', t => {
  const directory = directorioTemporal(t, 'atlas-replay-benchmark-');
  const rows = [];
  for (const enabled of [false, true]) {
    const path = join(directory, enabled ? 'delta.sqlite' : 'full.sqlite'), store = new Store(path);
    try {
      store.db.exec('PRAGMA wal_autocheckpoint=0');
      const world = createWorld(51926, parseParams(`persistencia.paginasSucias=${enabled}`));
      store.save(world);
      const startBytes = statSync(path + '-wal').size;
      let bytes = 0; const samples: { save: number; ms: number; deepAudit: boolean }[] = [];
      for (let save = 1; save <= 12; save++) {
        for (let tick = 0; tick < 2; tick++) stepWorld(world, [], store.context);
        const start = performance.now(); store.save(world);
        // Hay un guardado inicial antes de la muestra. La marca coincide con
        // `deepValidationDue(this.saves)` y con la revisión retenida alineada.
        samples.push({ save, ms: performance.now() - start, deepAudit: save % DEEP_VALIDATION_EVERY_SAVES === 0 });
        bytes += store.lastSnapshotBytes;
      }
      const times = samples.filter(sample => !sample.deepAudit).map(sample => sample.ms).sort((a, b) => a - b);
      const deepAudits = samples.filter(sample => sample.deepAudit).map(sample => sample.ms);
      rows.push({ paginasSucias: enabled, seed: world.seed, people: world.people.length, tiles: world.tiles.length,
        saves: samples.length, ordinarySaves: times.length, deepAudits: deepAudits.length, ticks: world.tick,
        payloadBytes: bytes, walBytes: statSync(path + '-wal').size - startBytes,
        saveMsMedian: times[Math.floor(times.length / 2)], saveMsP95: times[Math.ceil(times.length * .95) - 1],
        deepAuditMsMax: Math.max(...deepAudits),
        digest: digestoCanonico(comparable(world)) });
      assert.equal(digestoCanonico(store.load()!.world), digestoCanonico(world));
    } finally { store.close(); }
  }
  assert.equal(rows[0]!.digest, rows[1]!.digest);
  assert.ok(rows[1]!.payloadBytes < rows[0]!.payloadBytes / 10);
  assert.ok(rows[1]!.walBytes < rows[0]!.walBytes);
  t.diagnostic(JSON.stringify(rows));
});
