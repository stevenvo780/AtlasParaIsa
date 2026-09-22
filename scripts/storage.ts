import { existsSync, chmodSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Store } from '../src/server/store.js';
import { acquireLock } from '../src/server/lock.js';
process.umask(0o077);
const args = process.argv.slice(2);
// `--slot 2` elige desde qué respaldo empieza la cadena de recuperación (1 = el guardado
// anterior, 2 = el respaldo profundo de cada cien guardados). Sin bandera, empieza en 1 y
// baja sola al 2 si el 1 no se puede verificar.
const flag = args.indexOf('--slot');
const slot = flag < 0 ? 1 : Number(args[flag + 1]);
const [action, argument] = flag < 0 ? args : [...args.slice(0, flag), ...args.slice(flag + 2)];
const data = resolve(process.env.CARTA_DATA_DIR ?? 'data');
try {
  if (!argument) throw new Error('Indica la ruta de una copia nueva (backup) o una copia existente (restore).');
  if (action === 'backup') {
    const db = resolve(data, 'world.sqlite');
    if (!existsSync(db)) throw new Error('No existe el mundo que se quiere copiar.');
    // Backing up an older running service must not migrate its schema underneath it.
    const store = new Store(db, { readOnly: true });
    try {
      if (!store.load()) throw new Error('Copia sin mundo.');
      const destination = resolve(argument);
      store.backup(destination); chmodSync(destination, 0o600);
      // VACUUM copies a coherent SQLite version, possibly newer than the preload.
      // Validate those copied bytes through a fresh readonly reader. Loading the
      // resident world alone does not visit dormant chunks or uncached identities.
      // On rejection keep the copy as evidence and never print nominal success.
      const copied = new Store(destination, { readOnly: true });
      try {
        copied.db.exec('BEGIN');
        const loaded = copied.load();
        if (!loaded) throw new Error('Copia sin mundo.');
        // Stream keys, including older retained chunk versions, without keeping
        // a second world in memory. Older schemas may lack either archive table.
        const tableExists = (name: string): boolean => !!copied.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?").get(name);
        const validateTick = (tick: unknown): number => {
          if (typeof tick !== 'number' || !Number.isSafeInteger(tick) || tick < 0 || tick > loaded.world.tick)
            throw new Error('Invalid backup archive tick. Explicit recovery required.');
          return tick;
        };
        if (tableExists('chunks')) for (const row of copied.db.prepare('SELECT key,tick FROM chunks ORDER BY key,tick').iterate()) {
          if (typeof row.key !== 'string' || !copied.loadChunk(row.key, validateTick(row.tick)))
            throw new Error('Invalid backup chunk. Explicit recovery required.');
        }
        if (tableExists('legacy')) for (const row of copied.db.prepare('SELECT id,tick FROM legacy ORDER BY id').iterate()) {
          if (typeof row.id !== 'string' || !copied.loadLegacy(row.id, validateTick(row.tick)))
            throw new Error('Invalid backup identity. Explicit recovery required.');
        }
        copied.db.exec('COMMIT');
      } finally {
        if (copied.db.isTransaction) copied.db.exec('ROLLBACK');
        copied.close();
      }
    }
    finally { store.close(); }
    console.log('Copia coherente creada. Conserva su acceso privado.');
  } else if (action === 'previous') {
    if (slot !== 1 && slot !== 2) throw new Error('--slot admite 1 (guardado anterior) o 2 (respaldo profundo).');
    const source = resolve(data, 'world.sqlite');
    if (!existsSync(source)) throw new Error('El mundo original no existe.');
    const target = resolve(argument, 'world.sqlite');
    if (existsSync(target)) throw new Error('Elige un directorio de recuperación nuevo.');
    const unlock = acquireLock(resolve(argument, 'world.lock'));
    let restored = slot;
    try {
      const original = new Store(source, { readOnly: true });
      try { restored = original.previous(target, slot); } finally { original.close(); }
    } finally { unlock(); }
    chmodSync(target, 0o600);
    console.log(`Punto anterior recuperado desde el respaldo ${restored} (${restored === 1 ? 'guardado anterior' : 'respaldo profundo'}) en un directorio nuevo; entradas posteriores retiradas y sesiones revocadas.`);
  } else if (action === 'restore') {
    const source = resolve(argument);
    if (!existsSync(source)) throw new Error('La copia no existe.');
    // Restore into a new data directory: never overwrite evidence or a live world.
    const target = resolve(data, 'world.sqlite');
    if (existsSync(target)) throw new Error('Restauración exige CARTA_DATA_DIR nuevo. Se conserva el mundo existente.');
    const unlock = acquireLock(resolve(data, 'world.lock'));
    try {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const original = new Store(source, { readOnly: true });
      try { if (!original.load()) throw new Error('Copia sin mundo.'); original.backup(target); } finally { original.close(); }
      chmodSync(target, 0o600);
      const restored = new Store(target); try { restored.revoke(); restored.load(); } finally { restored.close(); }
    } finally { unlock(); }
    console.log('Mundo restaurado y sesiones revocadas. Configura acceso en este directorio antes de arrancar.');
  } else throw new Error('Operación no válida.');
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
