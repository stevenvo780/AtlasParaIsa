import { existsSync, chmodSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Store } from '../src/server/store.js';
import { acquireLock } from '../src/server/lock.js';
process.umask(0o077);
const [action, argument] = process.argv.slice(2);
const data = resolve(process.env.CARTA_DATA_DIR ?? 'data');
try {
  if (!argument) throw new Error('Indica la ruta de una copia nueva (backup) o una copia existente (restore).');
  if (action === 'backup') {
    const db = resolve(data, 'world.sqlite');
    if (!existsSync(db)) throw new Error('No existe el mundo que se quiere copiar.');
    const store = new Store(db);
    try { store.load(); store.backup(resolve(argument)); chmodSync(resolve(argument), 0o600); }
    finally { store.close(); }
    console.log('Copia coherente creada. Conserva su acceso privado.');
  } else if (action === 'previous') {
    const source = resolve(data, 'world.sqlite');
    if (!existsSync(source)) throw new Error('El mundo original no existe.');
    const target = resolve(argument, 'world.sqlite');
    if (existsSync(target)) throw new Error('Elige un directorio de recuperación nuevo.');
    const unlock = acquireLock(resolve(argument, 'world.lock'));
    try {
      const original = new Store(source, { readOnly: true });
      try { original.previous(target); } finally { original.close(); }
    } finally { unlock(); }
    chmodSync(target, 0o600);
    console.log('Punto anterior recuperado en un directorio nuevo; entradas posteriores retiradas y sesiones revocadas.');
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
