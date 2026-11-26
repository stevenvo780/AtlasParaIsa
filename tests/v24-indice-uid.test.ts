import assert from 'node:assert/strict';
import test from 'node:test';
import { IndiceUid, MAX_FILAS_INDICE_UID } from '../src/world/soa/indice-uid.js';

test('índice UID coincide con Map para colisiones, duplicados y claves límite', () => {
  const indice = new IndiceUid(12);
  // 1.25 y 1.75 tienen la misma huella entera; NaN y ±0 también caen en la misma casilla inicial.
  const uids = Float64Array.of(1.25, 1.75, 0, NaN, -0, NaN, 1.75, 2 ** 32 + 1, Number.MAX_SAFE_INTEGER, Infinity);
  const vivo = Uint8Array.of(1, 1, 1, 1, 2, 1, 1, 1, 1, 0);
  indice.reconstruir(vivo, uids, uids.length);
  const esperado = new Map<number, number>();
  for (let s = 0; s < uids.length; s++) if (vivo[s]) esperado.set(uids[s]!, s);
  for (const uid of [...uids, 1.5, -17]) {
    assert.equal(indice.ranuraDe(uid, uids), esperado.get(uid) ?? -1);
  }
  assert.equal(indice.ranuraDe(1.25, uids), 0);
  assert.equal(indice.ranuraDe(1.75, uids), 6);
});

test('índice UID compartido ve el crecimiento y una ranura reasignada', () => {
  const coordinador = new IndiceUid(16);
  const lector = new IndiceUid(structuredClone(coordinador.memoria));
  const uids = new Float64Array(16), vivo = new Uint8Array(16);
  assert.equal(lector.ranuraDe(7, uids), -1);
  assert.equal(lector.memoria.byteLength, 8);

  uids[0] = 7;
  vivo[0] = 1;
  coordinador.reconstruir(vivo, uids, 1);
  assert.equal(lector.ranuraDe(7, uids), 0);

  vivo[0] = 0;
  uids[3] = 7;
  vivo[3] = 1;
  coordinador.reconstruir(vivo, uids, 4);
  assert.equal(lector.memoria.byteLength, 32);
  assert.equal(lector.ranuraDe(7, uids), 3);

  uids[0] = 11;
  vivo[0] = 1;
  vivo[3] = 0;
  coordinador.reconstruir(vivo, uids, 4);
  assert.equal(lector.ranuraDe(7, uids), -1);
  assert.equal(lector.ranuraDe(11, uids), 0);

  coordinador.reconstruir(vivo, uids, 0);
  assert.equal(lector.ranuraDe(11, uids), -1);
});

test('índice UID comprueba alta y reserva antes de tocar su tabla', () => {
  assert.throws(() => new IndiceUid(MAX_FILAS_INDICE_UID + 1), RangeError);
  assert.throws(() => new IndiceUid(new SharedArrayBuffer(12)), RangeError);
  const indice = new IndiceUid(1);
  const uids = Float64Array.of(7, 8), vivo = Uint8Array.of(1, 1);
  indice.reconstruir(vivo, uids, 1);
  assert.throws(() => indice.reconstruir(vivo, uids, 2), RangeError);
  assert.throws(() => indice.reconstruir(vivo, uids, Number.NaN), RangeError);
  assert.equal(indice.ranuraDe(7, uids), 0);
});
