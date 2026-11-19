// Native executor only. No source patch, Store wrapper, fake ACK or phase hook.
import { createServer } from 'node:net';
import { realpathSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

process.umask(0o077);
const root = realpathSync(process.env.C21_OUTPUT);
const stage = realpathSync(process.env.C21_STAGE);
const data = realpathSync(process.env.CARTA_DATA_DIR);
if (!stage.startsWith(root + '/') || !data.startsWith(root + '/')
    || process.env.HOST !== '127.0.0.1' || process.env.CARTA_PASSWORD
    || process.env.CARTA_PROXY_IP || process.env.CARTA_PARAMS) throw Error('UNSAFE_ENV');
const { createApp } = await import(pathToFileURL(resolve(stage, 'dist/server/server/app.js')).href);
const { Store } = await import(pathToFileURL(resolve(stage, 'dist/server/server/store.js')).href);
const { acquireLock } = await import(pathToFileURL(resolve(stage, 'dist/server/server/lock.js')).href);
const hash = s => createHash('sha256').update(s).digest('hex');
// main.ts excludes PORT=0. Reserve an OS-selected loopback port, release it, then
// bind App. A competing bind is fatal; never fall back to a public/default port.
const reservation = createServer();
await new Promise((yes, no) => {
  reservation.once('error', no); reservation.listen(0, '127.0.0.1', yes);
});
const address = reservation.address();
if (!address || typeof address === 'string') throw Error('NO_EPHEMERAL_PORT');
const port = address.port;
await new Promise((yes, no) => reservation.close(e => e ? no(e) : yes()));
const origin = `http://127.0.0.1:${port}`;
const unlock = acquireLock(resolve(data, 'world.lock'));
const store = new Store(resolve(data, 'world.sqlite'));
const loaded = store.load();
const app = createApp({ store, origin, secure: false,
  credentialPath: resolve(data, 'access.scrypt'),
  staticDir: resolve(stage, 'dist/client'), seed: 51926, tickMs: 100 });
let closing = false;
async function close() {
  if (closing) return; closing = true;
  try { await app.close(); store.close(); unlock(); process.exitCode = 0; }
  catch { process.exitCode = 1; }
}
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
app.server.once('error', () => { void close(); process.exitCode = 1; });
await new Promise((yes, no) => {
  app.server.once('error', no); app.server.listen(port, '127.0.0.1', yes);
});
const instance = store.db.prepare("SELECT value FROM metadata WHERE key='world-instance-id'").get();
const params = store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get();
// READY is operational provenance, never an accepted-order receipt.
process.stdout.write(JSON.stringify({ kind: 'ready', pid: process.pid, origin, port,
  loadedTick: loaded?.world.tick ?? null, loadedSlot: loaded?.slot ?? null,
  tick: app.world.tick, instanceId: instance?.value ?? null,
  node: process.version, sqlite: store.db.prepare('SELECT sqlite_version() AS v').get()?.v,
  effectiveSnapshotHash: hash(params.body),
  cgroup: readFileSync('/proc/self/cgroup', 'utf8').trim() }) + '\n');
