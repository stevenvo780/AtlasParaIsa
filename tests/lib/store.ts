import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Store, type StoreOptions } from '../../src/server/store.js';

/** Lo mínimo de `TestContext` que usan estos ayudantes. */
export interface ConLimpieza { after(callback: () => unknown): void }

/** sha256 en hexadecimal: el `digest` con que Store sella el cuerpo de cada instantánea. */
export const sha256 = (datos: string | NodeJS.ArrayBufferView): string => createHash('sha256').update(datos).digest('hex');

/** Directorio temporal bajo `tmpdir()` (respeta TMPDIR) que se borra al terminar la prueba. */
export function directorioTemporal(t: ConLimpieza, prefijo: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefijo));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Un Store en `world.sqlite` de un directorio temporal; se cierra (si sigue abierto) y se borra al terminar. */
export function laboratorio(t: ConLimpieza, prefijo: string, opciones: StoreOptions = {}): { directory: string; path: string; store: Store } {
  const directory = mkdtempSync(join(tmpdir(), prefijo));
  const path = join(directory, 'world.sqlite'), store = new Store(path, opciones);
  t.after(() => {
    try { store.close(); } catch { /* la prueba ya lo cerró */ }
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, path, store };
}

const base = (fuente: Store | DatabaseSync): DatabaseSync => fuente instanceof Store ? fuente.db : fuente;

/** Cuerpo y sello tal cual están en la tabla `snapshots`. */
export function filaInstantanea(fuente: Store | DatabaseSync, slot = 0): { body: string; digest: string } {
  return base(fuente).prepare('SELECT body,digest FROM snapshots WHERE slot=?').get(slot) as { body: string; digest: string };
}

/** Sustituye el cuerpo de un slot y recalcula su sello, como lo haría un escritor que respeta el checksum. */
export function reescribirInstantanea(fuente: Store | DatabaseSync, body: string, slot = 0): void {
  base(fuente).prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=?').run(body, sha256(body), slot);
}

/** Todas las tablas de `main` con todas sus filas, en orden estable: para afirmar que nada cambió. */
export function todasLasTablas(store: Store): unknown {
  const names = store.db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[];
  return names.map(({ name }) => [name, store.db.prepare(`SELECT * FROM main."${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
}
