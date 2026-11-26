import { closeSync, mkdirSync, openSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CatalogoCinta, INDICE_CINTA, MAX_SEGMENTO, VERSION_CATALOGO, rutaSegmento, type BloqueCinta, type EpocaCinta, type SegmentoCinta } from '../../src/server/cinta/catalogo.js';
import { codificarBloque, decodificarBloque, verificarBloque } from '../../src/server/cinta/formato.js';
import type { SeriePunto } from '../../src/shared/cinta.js';
import { applyClientTapeDelta } from '../../src/shared/tape-delta.js';

const USO = 'Uso: node --import tsx scripts/lab/exportar-demo.mts <cinta-origen> <tick-inicial> <tick-final> <directorio-nuevo>';

/** Toma las referencias de una sola transacción. El escritor publica cada bloque después de sincronizarlo. */
function indice(ruta: string, desde: number, hasta: number) {
  const db = new DatabaseSync(ruta, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    if (db.prepare('PRAGMA user_version').get()?.user_version !== VERSION_CATALOGO) throw new Error('Catálogo de cinta incompatible.');
    const epocas = db.prepare('SELECT * FROM epocas ORDER BY id').all() as unknown as (EpocaCinta & { motivo: string })[];
    const epoca = epocas.reverse().find(e => e.tMundo <= desde);
    if (!epoca || hasta > epoca.t1 || epocas.some(e => e.id > epoca.id && e.tMundo <= hasta)) {
      throw new Error('El intervalo debe estar confirmado dentro de una sola época visible.');
    }
    for (const tabla of ['lagunas', 'lagunas_poda', 'cuarentena']) {
      const nivel = tabla === 'lagunas' ? '' : 'AND nivel=0';
      if (db.prepare(`SELECT 1 FROM ${tabla} WHERE epoca=? ${nivel} AND t0<? AND t1>? LIMIT 1`).get(epoca.id, hasta, desde)) {
        throw new Error(`El intervalo cruza una discontinuidad registrada en ${tabla}.`);
      }
    }
    const bloques = db.prepare(`SELECT b.*, s.bytes AS bytesConfirmados FROM bloques b JOIN segmentos s ON s.id=b.segmento
      WHERE b.epoca=? AND b.nivel=0 AND b.t0<=? AND b.t1>=? ORDER BY b.t0`)
      .all(epoca.id, hasta, desde) as unknown as (BloqueCinta & { bytesConfirmados: number })[];
    const serie = db.prepare(`SELECT t,poblacion,nacimientos,muertes,fauna,estructuras,sustancias,hz FROM serie
      WHERE epoca=? AND t BETWEEN ? AND ? ORDER BY t`).all(epoca.id, desde, hasta) as unknown as SeriePunto[];
    db.exec('COMMIT');
    if (!bloques.length) throw new Error('No hay fotogramas de nivel 0 en el intervalo.');
    return { epoca, bloques, serie };
  } finally { db.close(); }
}

/** Un segmento activo puede crecer; se leen solo posiciones que confirmó el catálogo, desde un descriptor de solo lectura. */
function bloqueConfirmado(origen: string, b: BloqueCinta & { bytesConfirmados: number }): Buffer {
  const fin = b.offset + b.bytes;
  if (![b.offset, b.bytes, fin].every(Number.isSafeInteger) || b.offset < 0 || b.bytes <= 0 || fin > b.bytesConfirmados) {
    throw new Error(`Extensión inválida para el bloque ${b.segmento}/${b.offset}.`);
  }
  const fd = openSync(rutaSegmento(origen, b.nivel, b.segmento), 'r');
  try {
    const datos = Buffer.allocUnsafe(b.bytes);
    for (let cursor = 0; cursor < datos.length;) {
      const n = readSync(fd, datos, cursor, datos.length - cursor, b.offset + cursor);
      if (!n) throw new Error(`Bloque confirmado truncado ${b.segmento}/${b.offset}.`);
      cursor += n;
    }
    const verificado = verificarBloque(datos);
    if (verificado.crc !== b.crc || verificado.t0 !== b.t0 || verificado.t1 !== b.t1
      || verificado.nivel !== b.nivel || verificado.fotogramas !== b.fotogramas) {
      throw new Error(`El bloque ${b.segmento}/${b.offset} no coincide con el catálogo.`);
    }
    return datos;
  } finally { closeSync(fd); }
}

/** Los bloques interiores conservan sus bytes; los dos bordes se cortan exactamente a los fotogramas presentes. */
function recortar(datos: Buffer, b: BloqueCinta, desde: number, hasta: number): Buffer | undefined {
  if (b.t0 >= desde && b.t1 <= hasta) return datos;
  const bloque = decodificarBloque(datos);
  let base = bloque.baseFrame;
  for (const delta of bloque.deltas) {
    if (base.tick >= desde) break;
    base = applyClientTapeDelta(base, delta).frame;
  }
  if (base.tick < desde || base.tick > hasta) return undefined;
  return codificarBloque(b.nivel, base, bloque.deltas.filter(d => d.tick > base.tick && d.tick <= hasta));
}

function exportar(origen: string, desde: number, hasta: number, destino: string) {
  const rutaIndice = join(origen, INDICE_CINTA);
  const identidad = statSync(rutaIndice, { bigint: true });
  const { epoca, bloques, serie } = indice(rutaIndice, desde, hasta);
  mkdirSync(destino);
  try {
    const catalogo = new CatalogoCinta(destino);
    let t0: number | undefined;
    let ultimo: SegmentoCinta | undefined;
    try {
      catalogo.db.prepare('INSERT INTO epocas VALUES (?,?,?,?,?,NULL)').run(epoca.id, epoca.instanciaId, epoca.tMundo, epoca.motivo, 0);
      for (const bloque of bloques) {
        const datos = recortar(bloqueConfirmado(origen, bloque), bloque, desde, hasta);
        if (!datos) continue;
        const segmento = ultimo && ultimo.bytes + datos.length <= MAX_SEGMENTO ? ultimo : undefined;
        catalogo.escribirBloque(epoca.id, datos, segmento);
        ultimo = catalogo.segmentos().at(-1)!;
        t0 ??= ultimo.t0;
      }
      if (t0 === undefined || !ultimo) throw new Error('No hay fotogramas dentro de los límites pedidos.');
      const inicio = t0, { t1 } = ultimo;
      catalogo.flujos(epoca.id, serie.filter(p => p.t >= inicio && p.t <= t1), [], []);
      if (catalogo.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok'
        || catalogo.db.prepare('PRAGMA foreign_key_check').get()) throw new Error('El catálogo exportado no es válido.');
      // Cierra el WAL antes de entregar el paquete. El lector no necesita permisos de escritura.
      catalogo.db.exec('PRAGMA journal_mode=DELETE');
    } finally { catalogo.db.close(); }
    const final = statSync(rutaIndice, { bigint: true });
    if (identidad.dev !== final.dev || identidad.ino !== final.ino) throw new Error('La cinta de origen cambió de instancia durante la exportación.');
    const manifiesto = { version: 1, epoca: epoca.id, t0, t1: ultimo.t1 };
    writeFileSync(join(destino, 'demo.json'), `${JSON.stringify(manifiesto)}\n`, { flag: 'wx' });
    return manifiesto;
  } catch (error) { rmSync(destino, { recursive: true, force: true }); throw error; }
}

try {
  process.umask(0o077);
  const [origen, t0, t1, salida] = process.argv.slice(2);
  if (process.argv.length !== 6 || !origen || !salida || !/^\d+$/.test(t0 ?? '') || !/^\d+$/.test(t1 ?? '')) throw new Error(USO);
  const desde = Number(t0), hasta = Number(t1);
  if (!Number.isSafeInteger(desde) || !Number.isSafeInteger(hasta) || desde > hasta) throw new Error('Intervalo de ticks inválido.');
  const fuente = realpathSync(origen);
  const destino = join(realpathSync(dirname(salida)), basename(salida));
  const ruta = relative(fuente, destino);
  if (!ruta || (ruta !== '..' && !ruta.startsWith('../'))) throw new Error('La carpeta nueva debe quedar fuera de la cinta de origen.');
  console.log(JSON.stringify({ directorio: destino, ...exportar(fuente, desde, hasta, destino) }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
