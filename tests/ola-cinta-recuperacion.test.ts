import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, truncateSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { CatalogoCinta, rutaSegmento } from '../src/server/cinta/catalogo.js';
import { clientDelta, codificarBloque } from '../src/server/cinta/formato.js';
import { LectorCinta } from '../src/server/cinta/lector.js';
import type { ChunkReq, ChunkResp } from '../src/shared/cinta.js';
import type { WorldView } from '../src/shared/types.js';

function directorio(t: TestContext): string {
  const raiz = '/tmp/atlas-v23-o-cinta';
  mkdirSync(raiz, { recursive: true });
  const ruta = mkdtempSync(join(raiz, 'recuperacion-'));
  t.after(() => rmSync(ruta, { recursive: true, force: true }));
  return ruta;
}

function vista(tick: number): WorldView {
  return { tick, sequence: tick, version: 10, day: 1, phase: 'day', weather: 'clear', width: 1, height: 1,
    tiles: [{ x: 0, y: 0, terrain: 'soil', food: tick / 100, moisture: .5, vegetation: 0 }],
    people: [], places: [], events: [], memories: [] };
}

function lectorEn(t: TestContext, ruta: string) {
  const lector = new LectorCinta(ruta);
  t.after(() => lector.close());
  return (req: ChunkReq): ChunkResp => JSON.parse(lector.chunk(req));
}

test('n=1 reconstruye el fotograma exacto anterior incluso entre bloques y con cámara', t => {
  const ruta = directorio(t);
  const catalogo = new CatalogoCinta(ruta);
  const epoca = catalogo.abrir({ instanciaId: 'prueba', epoca: 0, tMundo: 4, motivo: 'reinicio' });
  catalogo.escribirBloque(epoca, codificarBloque(0, vista(4), [clientDelta(vista(4), vista(8))]), undefined);
  catalogo.escribirBloque(epoca, codificarBloque(0, vista(12), []), undefined);
  catalogo.db.close();

  const leer = lectorEn(t, ruta);
  for (const [t, esperado] of [[3, undefined], [5, 4], [8, 8], [11, 8], [12, 12], [13, 12]] as const) {
    for (const camara of [{}, { x: 0, y: 0, w: 1, h: 1 }]) {
      const r = leer({ t, n: 1, nivel: 0, ...camara });
      assert.deepEqual(r.deltas, []);
      assert.equal(r.baseFrame?.tick, esperado);
      if (esperado !== undefined) assert.deepEqual(r.baseFrame, { ...vista(esperado), ...('w' in camara ? { originX: 0, originY: 0 } : {}) });
    }
  }
});

test('verificar aísla un CRC malo en un segmento sellado y conserva sus bloques vecinos', t => {
  const ruta = directorio(t);
  let catalogo = new CatalogoCinta(ruta);
  const epoca = catalogo.abrir({ instanciaId: 'prueba', epoca: 0, tMundo: 0, motivo: 'reinicio' });
  const bloque = (t: number) => codificarBloque(0, vista(t), []);
  for (const tick of [0, 4, 8]) catalogo.escribirBloque(epoca, bloque(tick), catalogo.segmentos()[0]);
  const sellado = catalogo.segmentos()[0]!;
  catalogo.escribirBloque(epoca, bloque(12), undefined);
  catalogo.db.close();

  const lector = new LectorCinta(ruta);
  t.after(() => lector.close());
  assert.equal(lector.meta().niveles[0]?.fotogramas, 4, 'el lector cachea el índice vigente antes del aislamiento');
  const path = rutaSegmento(ruta, 0, sellado.id);
  const fd = openSync(path, 'r+');
  const offset = bloque(0).length + bloque(4).length - 1;
  try {
    const byte = Buffer.alloc(1);
    readSync(fd, byte, 0, 1, offset);
    byte[0] ^= 0x80;
    writeSync(fd, byte, 0, 1, offset);
  } finally { closeSync(fd); }

  new CatalogoCinta(ruta).db.close();
  catalogo = new CatalogoCinta(ruta, undefined, true);
  assert.deepEqual(catalogo.cuarentena().map(b => [b.segmento, b.t0, b.t1]), [[sellado.id, 4, 4]]);
  catalogo.db.close();
  assert.deepEqual(lector.meta().lagunas, [{ t0: 4, t1: 4 }]);
  assert.equal(lector.meta().niveles[0]?.fotogramas, 3);
  const leer = (req: ChunkReq): ChunkResp => JSON.parse(lector.chunk(req));
  assert.equal(leer({ t: 0, n: 120, nivel: 0 }).t1, 0);
  assert.equal(leer({ t: 4, n: 1, nivel: 0 }).baseFrame?.tick, 0);
  assert.equal(leer({ t: 8, n: 1, nivel: 0 }).baseFrame?.tick, 8);

  truncateSync(path, offset + 1);
  catalogo = new CatalogoCinta(ruta, undefined, true);
  assert.deepEqual(catalogo.cuarentena().map(b => b.t0), [4, 8]);
  catalogo.db.close();
  new CatalogoCinta(ruta).db.close();
  assert.equal(leer({ t: 8, n: 1, nivel: 0 }).baseFrame?.tick, 0);
  assert.equal(leer({ t: 12, n: 1, nivel: 0 }).baseFrame?.tick, 12);
});
