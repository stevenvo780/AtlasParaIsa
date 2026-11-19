// Separate read-only Store connection to actual retained SQLite cut; never stepping a World.
import { realpathSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = realpathSync(process.env.C21_OUTPUT), stage = realpathSync(process.env.C21_STAGE);
const dbfile = realpathSync(process.argv[2]);
if (!dbfile.startsWith(root + '/') || !stage.startsWith(root + '/')) throw Error('PROJECTION_PATH_ESCAPE');
const { Store } = await import(pathToFileURL(resolve(stage, 'dist/server/server/store.js')).href);
const { projectWorld } = await import(pathToFileURL(resolve(stage, 'dist/server/world/index.js')).href);
const { clavesVivasEn } = await import(pathToFileURL(resolve(stage, 'dist/server/server/regiones-vivas.js')).href);
const viewport = JSON.parse(process.argv[3]);
const store = new Store(dbfile, { readOnly: true });
try {
  const loaded = store.load();
  if (!loaded || loaded.slot !== 0) throw Error('READONLY_PROJECTION_FALLBACK');
  const projected = projectWorld(loaded.world, viewport, store.context);
  const instanceId = store.db.prepare("SELECT value FROM metadata WHERE key='world-instance-id'").get()?.value;
  const snapshotDigest = store.db.prepare('SELECT digest FROM snapshots WHERE slot=0').get()?.digest;
  const regionesVivas = clavesVivasEn(loaded.world, { x: projected.originX ?? 0, y: projected.originY ?? 0, width: projected.width, height: projected.height });
  const bytes = Buffer.from(JSON.stringify({ projected: { ...projected, instanceId, regionesVivas }, snapshotDigest }) + '\n');
  if (bytes.length > 268435456) throw Error('PROJECTION_OUTPUT_CAP');
  for (let at = 0; at < bytes.length;) at += writeSync(1, bytes, at, bytes.length - at);
} finally { store.close(); }
