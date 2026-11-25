import { statSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogoCinta, INDICE_CINTA } from '../../src/server/cinta/catalogo.js';

const [, , modo, directorio] = process.argv;
if (modo !== '--verificar' || !directorio || process.argv.length !== 4) {
  throw new Error('Uso: cinta-verificar.mts --verificar <cinta fuera de servicio>');
}
if (!statSync(join(directorio, INDICE_CINTA), { throwIfNoEntry: false })?.isFile()) {
  throw new Error('El directorio no contiene un catálogo de cinta.');
}
const catalogo = new CatalogoCinta(directorio, undefined, true);
try {
  const cuarentena = catalogo.cuarentena();
  console.log(JSON.stringify({ cuarentena }, null, 2));
  if (cuarentena.length) process.exitCode = 2;
} finally { catalogo.db.close(); }
