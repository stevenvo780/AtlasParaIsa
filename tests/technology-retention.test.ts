/**
 * Retención verificable del archivo de recibos de ejecución (sprint noche-arch 2026-09-23, FR-016).
 *
 * Con `persistencia.ventanaEventosTicks` > 0 cada guardado poda los recibos anteriores a la ventana (nunca a
 * menos de un día) sin tocar lo que necesiten las tres instantáneas, en ticks completos y con un tope por
 * guardado; la frontera guarda el pliegue de la cadena de digestos y la cabeza de la cadena se escribe con cada
 * instantánea. Estas pruebas refutan: que la carga, la recuperación o las métricas C7 dejen de ver lo que leían;
 * que una frontera, una cabeza o una fila retenida se puedan falsificar o borrar sin que la carga lo note; que un
 * respaldo viejo pierda sus recibos; y que un inicio de sesión vuelva a costar un barrido del archivo entero.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, TECHNOLOGY_RETENTION_MIN_TICKS } from '../src/server/store.js';
import { TechnologyArchive, TECHNOLOGY_CHAIN_EMPTY, technologyChainStep } from '../src/server/technology-archive.js';
import { assertWorld, createWorld, type World } from '../src/world/index.js';
import { parseParams, setParams } from '../src/world/params.js';
import { recordTechnologyBenefit, researchTechnology, technologyWorkCost, useTool } from '../src/world/technology.js';
import type { TechnologyExecution, TechnologyProgram } from '../src/shared/technology.js';
import { durableActivityMetrics } from '../scripts/lab/metrics.js';

const digest = (body: string) => createHash('sha256').update(body).digest('hex');
const count = (store: Store, sql = 'SELECT COUNT(*) AS n FROM technology_executions', ...values: number[]) =>
  Number((store.db.prepare(sql).get(...values) as { n: number }).n);
function directory(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), 'atlas-retention-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function open(t: TestContext, path: string, options: ConstructorParameters<typeof Store>[1] = {}): Store {
  const store = new Store(path, options); t.after(() => { try { store.close(); } catch { /* ya cerrada */ } }); return store;
}
function fixtureTick(world: World, tick: number): void {
  world.tick = tick; for (const person of world.people) person.demography.age = tick - person.bornAt;
}
function makeTool(world: World) {
  const person = world.people[2]!;
  person.materials.stone = 8; person.energy = 1; person.fatigue = 0.1;
  const program: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 4000 }],
    steps: [{ op: 'form', shape: 'edge', intensity: 4 }, { op: 'compress', intensity: 2 }] };
  person.technology.project = { kind: 'research', program, parents: [], recipeId: null,
    progress: 0, requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: world.tick };
  for (let n = 0; n < 100 && person.technology.project; n++) { fixtureTick(world, world.tick + 1); researchTechnology(world, person); }
  assert.equal(person.technology.project, null); assertWorld(world);
}
/** `amount` usos útiles en el tick actual; devuelve la serie y el tick de cada recibo. */
function useMany(world: World, amount: number): { serial: number; tick: number }[] {
  const person = world.people[2]!, receipts: { serial: number; tick: number }[] = [];
  for (let n = 0; n < amount; n++) {
    const receipt = useTool(world, person, 'cutting', 0.01); assert.ok(receipt);
    recordTechnologyBenefit(world, person, receipt, 0.25);
    receipts.push({ serial: Number(receipt!.executionId.slice(8)), tick: world.tick });
  }
  return receipts;
}
const pruneRecord = (store: Store) => {
  const row = store.db.prepare("SELECT value FROM metadata WHERE key='technology-pruned-v1'").get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) as { startsAfter: number; through: number; tick: number; digest: string; count: number } : null;
};
const chainRecord = (store: Store) => {
  const row = store.db.prepare("SELECT value FROM metadata WHERE key='technology-chain-v1'").get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) as { startsAfter: number; through: number; digest: string } : null;
};
/** Pliegue de la cadena sobre las filas retenidas, desde la frontera. */
const foldRetained = (store: Store) => {
  const boundary = pruneRecord(store);
  let value = boundary?.digest ?? TECHNOLOGY_CHAIN_EMPTY;
  for (const row of store.db.prepare('SELECT digest FROM technology_executions ORDER BY serial').all() as { digest: string }[])
    value = technologyChainStep(value, row.digest);
  return value;
};
const serial = (receipt: TechnologyExecution) => Number(receipt.id.slice(8));

/** Mundo con ventana `window`, una herramienta y `steps` tandas de `perStep` usos separadas `gap` ticks. */
function grow(t: TestContext, { window = 2400, steps = 10, perStep = 150, gap = 1000, rows }: { window?: number; steps?: number;
  perStep?: number; gap?: number; rows?: number } = {}) {
  const dir = directory(t), path = join(dir, 'world.sqlite');
  const store = open(t, path, rows ? { technologyPruneRowsPerSave: rows } : {}), world = createWorld(51926);
  setParams(world, parseParams(`persistencia.ventanaEventosTicks=${window}`));
  store.save(world); makeTool(world); store.save(world);
  const created: { serial: number; tick: number }[] = world.technology.history.map(r => ({ serial: serial(r), tick: r.tick }));
  const rings: (number | null)[] = [];
  for (let step = 1; step <= steps; step++) {
    fixtureTick(world, world.tick + gap);
    created.push(...useMany(world, perStep));
    rings.push(world.technology.history[0]?.tick ?? null);
    store.save(world);
  }
  return { dir, path, store, world, created, rings };
}

test('la retención poda por ventana en ticks completos, la carga la verifica y las métricas C7 siguen viendo su día', t => {
  const { path, store, world, created, rings } = grow(t);
  const boundary = pruneRecord(store), chain = chainRecord(store);
  assert.ok(boundary, 'con ventana y recibos viejos tiene que haber poda');
  // Límite esperado: la ventana y el primer recibo del anillo de las instantáneas que quedaron (slots 0 y 1).
  const horizon = Math.min(world.tick - Math.max(2400, TECHNOLOGY_RETENTION_MIN_TICKS), rings.at(-1)!, rings.at(-2)!);
  const expected = Math.max(...created.filter(row => row.tick < horizon).map(row => row.serial));
  assert.equal(boundary!.through, expected);
  assert.equal(boundary!.count, boundary!.through - boundary!.startsAfter);
  assert.equal(boundary!.tick, created.find(row => row.serial === expected)!.tick);
  assert.equal(count(store, 'SELECT COUNT(*) AS n FROM technology_executions WHERE serial<=?', expected), 0);
  assert.equal(count(store), world.technology.executionCounter - expected, 'lo retenido es contiguo hasta el contador');
  assert.equal(count(store, 'SELECT COUNT(*) AS n FROM technology_executions WHERE tick<?', horizon), 0);
  assert.deepEqual(chain, { version: 1, startsAfter: 0, through: world.technology.executionCounter, digest: foldRetained(store) });
  assert.deepEqual(store.load()!.world, world);
  const reopened = open(t, path, { readOnly: true });
  assert.deepEqual(reopened.load()!.world, world);
  // C7: el último día detrás del guardado sigue entero; un intervalo que empieza en lo podado falla en voz alta.
  const lastDay = created.filter(row => row.tick > world.tick - 2400).length;
  assert.equal(durableActivityMetrics(world, store.db, world.tick - 2400).usosUtiles, lastDay);
  assert.throws(() => durableActivityMetrics(world, store.db, 0), /were pruned/);
});

test('sin ventana no se poda nada y la cabeza de la cadena cubre el archivo entero', t => {
  const { store, world } = grow(t, { window: 0, steps: 4 });
  assert.equal(pruneRecord(store), null);
  assert.equal(count(store), world.technology.executionCounter);
  assert.deepEqual(chainRecord(store), { version: 1, startsAfter: 0, through: world.technology.executionCounter,
    digest: foldRetained(store) });
  assert.deepEqual(store.load()!.world, world);
});

test('un archivo que ya existía se poda poco a poco: tope por guardado, ticks completos y un tick mayor que el tope entero', t => {
  // 25 recibos por tick y tope 100: cada guardado poda cuatro ticks; el primer tick lleva 150 (más que el tope).
  const dir = directory(t), path = join(dir, 'world.sqlite'), store = open(t, path, { technologyPruneRowsPerSave: 100 });
  const world = createWorld(51926);
  store.save(world); makeTool(world); store.save(world);
  const ticks = new Map<number, number>();
  const mark = (receipts: { serial: number; tick: number }[]) => { for (const r of receipts) ticks.set(r.serial, r.tick); };
  mark(world.technology.history.map(r => ({ serial: serial(r), tick: r.tick })));
  fixtureTick(world, world.tick + 10); const big = useMany(world, 150); mark(big); store.save(world);
  for (let n = 0; n < 40; n++) { fixtureTick(world, world.tick + 10); mark(useMany(world, 25)); store.save(world); }
  assert.equal(pruneRecord(store), null, 'sin ventana el archivo se conserva entero');
  // Se abre la ventana (como `CARTA_PARAMS` en producción) y el mundo sigue sin recibos nuevos.
  setParams(world, parseParams('persistencia.ventanaEventosTicks=2400'));
  const ringSerial = serial(world.technology.history[0]!);
  let previous = 0, saves = 0, sawBigTick = false;
  for (; saves < 60; saves++) {
    fixtureTick(world, world.tick + 3000); store.save(world);
    const through = pruneRecord(store)?.through ?? 0;
    if (through === previous) break;
    // Nunca más que el tope, salvo el tick de 150 recibos, que se poda entero y solo.
    const wholeBigTick = previous + 1 === big[0]!.serial && through === big.at(-1)!.serial;
    assert.ok(through - previous <= 100 || wholeBigTick, `guardado ${saves}: ${previous} → ${through}`);
    if (through - previous > 100) sawBigTick = true;
    // Tick completo: el siguiente recibo retenido ya es de otro tick.
    const next = store.db.prepare('SELECT tick FROM technology_executions ORDER BY serial LIMIT 1').get() as { tick: number };
    assert.notEqual(next.tick, ticks.get(through));
    previous = through;
    if (saves === 3) assert.deepEqual(store.load()!.world, world, 'a mitad de la migración la carga verifica');
  }
  assert.ok(saves > 5, 'la migración tiene que repartirse en varios guardados');
  assert.ok(sawBigTick, 'el tick mayor que el tope se podó entero');
  // Converge al primer recibo del anillo: lo que el anillo residente compara con el archivo nunca se poda.
  assert.ok(previous < ringSerial && previous >= ringSerial - 25, `frontera ${previous}, anillo desde ${ringSerial}`);
  assert.deepEqual(store.load()!.world, world);
});

test('una frontera o cabeza falsificadas, una fila retenida alterada o borrada: la carga y el guardado fallan cerrados', t => {
  const { dir, store, world } = grow(t, { steps: 8 });
  const boundary = pruneRecord(store)!;
  const retained = store.db.prepare('SELECT id FROM technology_executions ORDER BY serial LIMIT 1 OFFSET 3').get() as { id: string };
  assert.ok(!world.technology.history.some(r => r.id === retained.id), 'la fila elegida no está en el anillo');
  const mutations: [string, (db: DatabaseSync) => void, RegExp][] = [
    ['digesto de frontera', db => db.prepare("UPDATE metadata SET value=? WHERE key='technology-pruned-v1'")
      .run(JSON.stringify({ version: 1, ...boundary, digest: '1'.repeat(64) })), /chain disagrees/],
    ['frontera adelantada sin borrar', db => db.prepare("UPDATE metadata SET value=? WHERE key='technology-pruned-v1'")
      .run(JSON.stringify({ version: 1, ...boundary, through: boundary.through + 1, count: boundary.count + 1 })), /still archived/],
    ['frontera adelantada borrando', db => {
      db.prepare('DELETE FROM technology_executions WHERE serial=?').run(boundary.through + 1);
      db.prepare("UPDATE metadata SET value=? WHERE key='technology-pruned-v1'")
        .run(JSON.stringify({ version: 1, ...boundary, through: boundary.through + 1, count: boundary.count + 1 }));
    }, /chain disagrees/],
    ['cabeza ausente', db => db.exec("DELETE FROM metadata WHERE key='technology-chain-v1'"), /no execution chain head/],
    ['fila retenida reescrita con su digesto', db => {
      const row = db.prepare('SELECT body FROM technology_executions WHERE id=?').get(retained.id) as { body: string };
      const body = JSON.stringify({ ...JSON.parse(row.body), benefit: 0.5 });
      db.prepare('UPDATE technology_executions SET body=?,digest=? WHERE id=?').run(body, digest(body), retained.id);
    }, /chain disagrees/],
    ['fila retenida borrada', db => db.prepare('DELETE FROM technology_executions WHERE id=?').run(retained.id), /has a gap/],
    ['frontera con otra forma', db => db.prepare("UPDATE metadata SET value=? WHERE key='technology-pruned-v1'")
      .run(JSON.stringify({ version: 1, ...boundary, extra: 1 })), /prune boundary is invalid/],
  ];
  for (const [name, mutate, expected] of mutations) {
    const copy = join(dir, `${name.replaceAll(' ', '-')}.sqlite`); store.backup(copy);
    const db = new DatabaseSync(copy); try { mutate(db); } finally { db.close(); }
    const damaged = open(t, copy);
    assert.throws(() => damaged.load(), expected, name);
    const draft = structuredClone(world); fixtureTick(draft, draft.tick + 1);
    assert.throws(() => damaged.save(draft), /[Tt]echnology archive/, `${name}: el guardado tampoco lo tapa`);
  }
  assert.deepEqual(store.load()!.world, world, 'el original sigue intacto');
});

test('un respaldo profundo viejo frena la poda y previous() lo recupera con el archivo podado', t => {
  const { dir, store, world } = grow(t, { steps: 3 });
  // El slot 2 hereda la instantánea vigente (como cada cien guardados) y el servicio sigue: la ventana ya lo
  // dejaría atrás, pero sus recibos confirmados y su anillo tienen que seguir en el archivo.
  store.db.exec('INSERT OR REPLACE INTO snapshots SELECT 2,body,digest,saved_at FROM snapshots WHERE slot=0');
  const deep = structuredClone(world), deepRing = serial(deep.technology.history[0]!);
  for (let step = 0; step < 6; step++) { fixtureTick(world, world.tick + 1000); useMany(world, 150); store.save(world); }
  const boundary = pruneRecord(store)!;
  assert.ok(boundary.through < deepRing, `la frontera ${boundary.through} no alcanza el anillo del slot 2 (${deepRing})`);
  assert.ok(world.tick - 2400 > deep.technology.history.at(-1)!.tick, 'sin el slot 2 la ventana lo habría podado');
  for (const slot of [2, 1] as const) {
    const destination = join(dir, `previous-${slot}.sqlite`);
    assert.equal(store.previous(destination, slot), slot);
    const recovered = open(t, destination, { readOnly: true }), loaded = recovered.load()!;
    // El slot 1 es el guardado anterior al último (una tanda, 1000 ticks, antes).
    assert.equal(loaded.world.tick, slot === 2 ? deep.tick : world.tick - 1000);
    if (slot === 2) assert.deepEqual(loaded.world.technology.history, deep.technology.history);
    assert.deepEqual(pruneRecord(recovered), boundary);
    assert.equal(chainRecord(recovered)!.through, loaded.world.technology.executionCounter);
  }
  assert.deepEqual(store.load()!.world, world);
});

test('un inicio de sesión no tira la verificación de la carga; una escritura ajena cuesta un solo barrido', t => {
  const { path, world } = grow(t, { steps: 4 });
  const store = open(t, path), loaded = store.load()!.world; store.save(loaded);
  const probe = Store.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const archive = TechnologyArchive.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const calls = { receipts: 0, scans: 0 };
  const receipts = probe.assertTechnologyReceipts!, scans = archive.scanDefinitions!;
  probe.assertTechnologyReceipts = function (...a) { calls.receipts++; return receipts.apply(this, a); };
  archive.scanDefinitions = function (...a) { calls.scans++; return scans.apply(this, a); };
  t.after(() => { probe.assertTechnologyReceipts = receipts; archive.scanDefinitions = scans; });
  const step = () => { fixtureTick(loaded, loaded.tick + 1); useMany(loaded, 3); };
  store.addSession('a'.repeat(64), Date.now() + 60_000); step(); store.save(loaded, [], ['a'.repeat(64)]);
  store.revoke('a'.repeat(64)); step(); store.save(loaded);
  assert.deepEqual(calls, { receipts: 0, scans: 0 }, 'sesiones por la misma conexión: ni barrido de recibos ni de definiciones');
  // Una sesión revocada antes de guardar deshace una transacción vacía: tampoco tira las pruebas.
  step(); assert.throws(() => store.save(loaded, [], ['b'.repeat(64)]), /revoked/); store.save(loaded);
  assert.equal(calls.receipts, 0);
  const foreign = new DatabaseSync(path);
  try { foreign.prepare('INSERT INTO sessions VALUES (?,?)').run('c'.repeat(64), Date.now() + 60_000); } finally { foreign.close(); }
  step(); store.save(loaded);
  assert.equal(calls.receipts, 1, 'la línea base se barre una vez; el candidato sólo compara su anillo');
  assert.deepEqual(store.load()!.world, loaded);
  assert.ok(world.tick < loaded.tick);
});

test('un archivo sin cabeza (anterior a la retención) se carga y el primer guardado la escribe; una cabeza atrasada es un prefijo', t => {
  const { path, store, world } = grow(t, { window: 0, steps: 3 });
  const early = chainRecord(store)!;
  fixtureTick(world, world.tick + 10); useMany(world, 20); store.save(world);
  store.db.exec("DELETE FROM metadata WHERE key='technology-chain-v1'");
  const legacy = open(t, path), loaded = legacy.load()!.world;
  assert.equal(chainRecord(legacy), null, 'cargar no escribe');
  legacy.save(loaded);
  assert.deepEqual(chainRecord(legacy), { version: 1, startsAfter: 0, through: loaded.technology.executionCounter,
    digest: foldRetained(legacy) });
  // Cabeza de un binario anterior que siguió guardando sin mantenerla: se comprueba hasta donde llega.
  legacy.db.prepare("UPDATE metadata SET value=? WHERE key='technology-chain-v1'").run(JSON.stringify(early));
  assert.deepEqual(open(t, path).load()!.world, loaded);
  legacy.db.prepare("UPDATE metadata SET value=? WHERE key='technology-chain-v1'")
    .run(JSON.stringify({ ...early, digest: '2'.repeat(64) }));
  assert.throws(() => open(t, path).load(), /chain disagrees/);
});

test('el archivo acepta una anidada ausente sólo dentro del prefijo podado que declara el anfitrión', t => {
  const dir = directory(t), db = new DatabaseSync(join(dir, 'archive.sqlite'));
  t.after(() => db.close());
  let pruned: number | null = null;
  const archive = new TechnologyArchive(db, { prunedThrough: () => pruned });
  const receipt = (n: number, tick: number, extra: Partial<TechnologyExecution> = {}): TechnologyExecution => ({ id: `process-${n}`,
    kind: 'research', tick, actorId: 'inventor-1', recipeId: null, programSignature: 'failed-trial', inputs: [], outputs: [],
    residueMass: 0,
    energy: 0.001, work: 1, success: false, parentRecipeIds: [], catalysts: [], benefit: 0,
    balance: { opening: [], closing: [], externalInputs: [], externalLoss: [] }, ...extra });
  db.exec('BEGIN'); archive.installSchema(); archive.initializeHistory(0);
  const digests = [1, 2, 3].map(n => archive.putExecution(receipt(n, 10, { kind: 'use' })));
  archive.putExecution(receipt(4, 10, { nestedExecutionIds: ['process-2'] }));
  db.exec('COMMIT');
  db.exec('BEGIN');
  assert.throws(() => archive.pruneExecutions(0, 9, TECHNOLOGY_CHAIN_EMPTY), /gap/);
  const result = archive.pruneExecutions(0, 3, TECHNOLOGY_CHAIN_EMPTY);
  db.exec('COMMIT');
  assert.equal(result.digest, digests.reduce(technologyChainStep, TECHNOLOGY_CHAIN_EMPTY));
  assert.deepEqual({ count: result.count, tick: result.tick }, { count: 3, tick: 10 });
  assert.throws(() => archive.getExecution('process-4'), /missing nested execution/, 'sin frontera declarada es un hueco');
  pruned = 3;
  assert.equal(archive.getExecution('process-4')!.id, 'process-4');
  assert.deepEqual(archive.listExecutions().map(r => r.id), ['process-4']);
  // Un cuerpo que ya no es el de su digesto no se poda: lo descartado queda certificado por el pliegue.
  db.exec('BEGIN'); archive.putExecution(receipt(5, 11)); db.exec('COMMIT');
  db.prepare("UPDATE technology_executions SET body=replace(body,'0.001','0.002') WHERE id='process-5'").run();
  db.exec('BEGIN'); assert.throws(() => archive.pruneExecutions(3, 5, result.digest), /checksum/); db.exec('ROLLBACK');
});

test('una base nueva usa páginas de 8 KiB y una existente conserva las suyas; el volcado del WAL sigue en bytes', t => {
  const dir = directory(t), fresh = open(t, join(dir, 'nueva.sqlite'));
  const pragma = (db: DatabaseSync, name: string) => Number(Object.values(db.prepare(`PRAGMA ${name}`).get()!)[0]);
  assert.equal(pragma(fresh.db, 'page_size'), 8192);
  assert.equal(pragma(fresh.db, 'wal_autocheckpoint'), 2000);
  const legacyPath = join(dir, 'vieja.sqlite'), legacy = new DatabaseSync(legacyPath);
  legacy.exec('PRAGMA page_size=4096; CREATE TABLE x(y)'); legacy.close();
  // Abrirla como Store falla (no es una base de la carta), pero antes no puede cambiar su tamaño de página.
  assert.throws(() => new Store(legacyPath), /Unrecognized database/);
  const reopened = new DatabaseSync(legacyPath);
  try { assert.equal(pragma(reopened, 'page_size'), 4096); } finally { reopened.close(); }
});
