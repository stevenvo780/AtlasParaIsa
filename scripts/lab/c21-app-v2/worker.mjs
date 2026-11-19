// Opt-in instrumentation in this private process only. Production bytes stay pinned.
import { createServer } from 'node:net';
import { realpathSync, readFileSync, readSync, writeSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

process.umask(0o077);
const hash = value => createHash('sha256').update(value).digest('hex');
const root = realpathSync(process.env.C21_OUTPUT);
const stage = realpathSync(process.env.C21_STAGE);
const data = realpathSync(process.env.CARTA_DATA_DIR);
const cookie = process.env.C21_IPC_COOKIE;
const eventFd = Number(process.env.C21_EVENT_FD), releaseFd = Number(process.env.C21_RELEASE_FD);
if (!stage.startsWith(root + '/') || !data.startsWith(root + '/')
    || process.env.HOST !== '127.0.0.1' || process.env.CARTA_PASSWORD
    || process.env.CARTA_PROXY_IP || process.env.CARTA_PARAMS
    || !/^[a-f0-9]{64}$/.test(cookie ?? '') || !Number.isInteger(eventFd)
    || eventFd < 3 || !Number.isInteger(releaseFd) || releaseFd < 3)
  throw Error('PRIVATE_WORKER_OPT_IN_REQUIRED');
const identity = () => {
  const fields = readFileSync('/proc/self/stat', 'utf8').split(')').at(-1).trim().split(/\s+/);
  return { pid: process.pid, starttime: fields[19], pgrp: Number(fields[2]),
    session: Number(fields[3]), cgroup: readFileSync('/proc/self/cgroup', 'utf8').trim() };
};
const send = (kind, details = {}) => {
  const bytes = Buffer.from(JSON.stringify({ kind, cookie, identity: identity(), ...details }) + '\n');
  if (bytes.length > 65536) throw Error('IPC_LINE_CAP');
  for (let at = 0; at < bytes.length;) at += writeSync(eventFd, bytes, at, bytes.length - at);
};
const gate = (kind, details) => {
  send(kind, { held: true, ...details });
  // Separate inherited pipe: no event-loop work, Promise resolution or ACK is possible here.
  const buffer = Buffer.alloc(1);
  if (readSync(releaseFd, buffer, 0, 1, null) !== 1 || buffer[0] !== 67)
    throw Error('CONTROLLER_RELEASE_INVALID');
};
const { createApp } = await import(pathToFileURL(resolve(stage, 'dist/server/server/app.js')).href);
const { Store, fingerprint } = await import(pathToFileURL(resolve(stage, 'dist/server/server/store.js')).href);
const { acquireLock } = await import(pathToFileURL(resolve(stage, 'dist/server/server/lock.js')).href);
const reservation = createServer();
await new Promise((yes, no) => { reservation.once('error', no); reservation.listen(0, '127.0.0.1', yes); });
const address = reservation.address();
if (!address || typeof address === 'string') throw Error('NO_EPHEMERAL_PORT');
const port = address.port;
await new Promise((yes, no) => reservation.close(e => e ? no(e) : yes()));
const origin = `http://127.0.0.1:${port}`;
const dbfile = resolve(data, 'world.sqlite');
const credential = resolve(data, 'access.scrypt');
if (lstatSync(credential).isSymbolicLink() || (lstatSync(credential).mode & 0o077)) throw Error('CREDENTIAL_PERMISSIONS');
const unlock = acquireLock(resolve(data, 'world.lock'));
const store = new Store(dbfile);
const loaded = store.load();
if (process.env.C21_RECOVERY_HOLD === '1') gate('recovery-loaded', {
  loadedTick: loaded?.world.tick ?? null, loadedSlot: loaded?.slot ?? null, dbfile,
  instanceId: store.db.prepare("SELECT value FROM metadata WHERE key='world-instance-id'").get()?.value });
const app = createApp({ store, origin, secure: false, credentialPath: credential,
  staticDir: resolve(stage, 'dist/client'), seed: 51926, tickMs: 100,
  manual: process.env.C21_MANUAL === '1' });
let armed = null, saveContext = null, transaction = 0, holdCut = null;
const originalSave = store.save.bind(store), originalExec = store.db.exec.bind(store.db);
const changes = () => store.db.prepare('SELECT total_changes() AS n').get().n;
const snapshot = () => store.db.prepare('SELECT digest,body FROM snapshots WHERE slot=0').get();
const witnessedRows = context => context.inputs.map(({ gesture, result }) => {
  const row = store.db.prepare('SELECT fingerprint,tick,ordinal,body,result FROM inputs WHERE id=?').get(gesture.id);
  if (!row || row.fingerprint !== fingerprint(gesture) || row.tick !== result.tick
      || row.ordinal !== result.order || row.body !== JSON.stringify(gesture)
      || row.result !== JSON.stringify(result)) throw Error('UNKNOWN_OPERATION_BINDING');
  return { id: gesture.id, fingerprint: row.fingerprint, bodySha256: hash(row.body),
    resultSha256: hash(row.result), result: JSON.parse(row.result) };
});
store.save = function(world, inputs = [], sessions = []) {
  if (saveContext) throw Error('REENTRANT_SAVE');
  saveContext = { inputs, tick: world.tick, target: armed && inputs.some(x => x.gesture.id === armed.operationId),
    txId: `${process.pid}:${identity().starttime}:${++transaction}`, write: false, committed: false,
    trace: [], initialChanges: changes(), initialDigest: snapshot()?.digest ?? null };
  try { return originalSave(world, inputs, sessions); }
  finally { saveContext = null; }
};
const boundary = (hook, context, rows = []) => {
  if (!context.target || !armed || armed.hook !== hook) return;
  const snap = snapshot();
  gate('barrier', { hook, txId: context.txId, operationId: armed.operationId,
    operationBinding: 'STORE_SAVE_ARGUMENTS_REAL_GESTURE_ID', inputIds: context.inputs.map(x => x.gesture.id),
    candidateBindings: context.inputs.map(({ gesture, result }) => ({ gesture, result, fingerprint: fingerprint(gesture) })),
    dbfile, sql: context.trace, sqlSha256: hash(JSON.stringify(context.trace)),
    writeBeginSeen: context.write, commitReturned: context.committed, inTransaction: store.db.isTransaction,
    changesDelta: changes() - context.initialChanges, snapshotDigest: snap?.digest ?? null,
    snapshotBodySha256: snap ? hash(snap.body) : null, candidateTick: context.tick, rows });
  armed = null;
};
const interceptedExec = function(sql) {
  const context = saveContext;
  if (!context) return originalExec(sql);
  const normalized = sql.trim().replace(/;$/, '').toUpperCase();
  context.trace.push(sql);
  // prepareTechnology/withTechnologyReads has BEGIN/COMMIT reads. They never arm a write barrier.
  if (normalized === 'BEGIN IMMEDIATE') {
    if (context.write || store.db.isTransaction) throw Error('UNEXPECTED_WRITE_TRANSACTION');
    boundary('WRITE_BEFORE_BEGIN', context);
    const value = originalExec(sql);
    if (!store.db.isTransaction) throw Error('WRITE_BEGIN_NOT_ACTIVE');
    context.write = true;
    boundary('WRITE_AFTER_BEGIN', context);
    return value;
  }
  if (normalized === 'COMMIT' && context.write) {
    if (context.committed || !store.db.isTransaction) throw Error('NOOP_OR_DUPLICATE_COMMIT');
    const rows = context.target ? witnessedRows(context) : [];
    if (context.target && (changes() <= context.initialChanges || snapshot()?.digest === context.initialDigest))
      throw Error('NOOP_COMMIT_OR_SNAPSHOT_UNBOUND');
    boundary('WRITE_BEFORE_COMMIT', context, rows);
    const value = originalExec(sql); // Exactly one real COMMIT, before anything returns to Store/App.
    if (store.db.isTransaction) throw Error('COMMIT_DID_NOT_END_TRANSACTION');
    context.committed = true;
    boundary('WRITE_AFTER_COMMIT', context, context.target ? witnessedRows(context) : []);
    return value;
  }
  return originalExec(sql);
};
const originalFlushTechnology = store.flushTechnology.bind(store);
store.flushTechnology = function(world) {
  if (saveContext?.write) boundary('WRITE_BEFORE_FLUSH', saveContext);
  return originalFlushTechnology(world);
};
store.db.exec = interceptedExec;
if (store.db.exec !== interceptedExec) throw Error('SQL_OVERRIDE_NOT_INSTALLED');
// Witness a real HTTP projection while the event loop is held at the same durable tick.
app.server.prependListener('request', (req, res) => {
  if (!holdCut || req.method !== 'GET' || !req.url?.startsWith('/api/world?')) return;
  const expected = holdCut; holdCut = null;
  const originalEnd = res.end;
  res.end = function(chunk, ...args) {
    const result = originalEnd.call(this, chunk, ...args);
    if (res.statusCode !== 200 || typeof chunk !== 'string') { send('cut-unavailable', { token: expected }); return result; }
    const body = JSON.parse(chunk), snap = snapshot();
    const record = snap && JSON.parse(snap.body), tick = record?.world?.tick ?? record?.tick;
    if (body.tick !== tick || body.sequence !== tick) { send('cut-unavailable', { token: expected, tick: body.tick, durableTick: tick }); return result; }
    gate('projection-cut', { token: expected, tick, snapshotDigest: snap.digest, responseSha256: hash(chunk), dbfile });
    return result;
  };
});
let closing = false;
async function close() {
  if (closing) return; closing = true;
  try { await app.close(); store.close(); unlock(); process.exit(0); }
  catch { process.exit(1); }
}
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
const control = createInterface({ input: process.stdin, crlfDelay: Infinity });
control.on('line', line => {
  if (line.length > 4096) throw Error('CONTROL_LINE_CAP');
  const message = JSON.parse(line);
  if (message.cookie !== cookie || !['arm', 'flow', 'pending', 'step', 'hold-cut', 'recovery-hold'].includes(message.kind))
    throw Error('CONTROL_WHITELIST');
  if (message.kind === 'arm') {
    if (armed || !['WRITE_BEFORE_BEGIN', 'WRITE_AFTER_BEGIN', 'WRITE_BEFORE_FLUSH', 'WRITE_BEFORE_COMMIT', 'WRITE_AFTER_COMMIT'].includes(message.hook)
        || !/^[A-Za-z0-9_-]{1,160}$/.test(message.operationId)) throw Error('ARM_INVALID');
    armed = { hook: message.hook, operationId: message.operationId };
    send('armed', armed);
  } else if (message.kind === 'flow') send('flow', { flow: app.flujo });
  else if (message.kind === 'pending') send('pending', { count: app.gestosPendientes });
  else if (message.kind === 'step') {
    if (process.env.C21_MANUAL !== '1' || app.gestosPendientes !== 1) throw Error('STEP_REQUIRES_ONE_REAL_PENDING_REQUEST');
    app.stepOnce(); send('stepped');
  } else if (message.kind === 'hold-cut') { holdCut = message.token; send('cut-armed', { token: holdCut }); }
  else gate('recovery-cut', { tick: app.world.tick, instanceId: store.db.prepare("SELECT value FROM metadata WHERE key='world-instance-id'").get()?.value });
});
control.on('close', () => { if (!closing) void close(); });
await new Promise((yes, no) => { app.server.once('error', no); app.server.listen(port, '127.0.0.1', yes); });
send('ready', { origin, port, loadedTick: loaded?.world.tick ?? null, loadedSlot: loaded?.slot ?? null,
  tick: app.world.tick, instanceId: store.db.prepare("SELECT value FROM metadata WHERE key='world-instance-id'").get()?.value,
  node: process.version, sqlite: store.db.prepare('SELECT sqlite_version() AS v').get()?.v,
  hooks: ['WRITE_BEFORE_BEGIN', 'WRITE_AFTER_BEGIN', 'WRITE_BEFORE_FLUSH', 'WRITE_BEFORE_COMMIT', 'WRITE_AFTER_COMMIT'],
  dbfile, manual: process.env.C21_MANUAL === '1' });
