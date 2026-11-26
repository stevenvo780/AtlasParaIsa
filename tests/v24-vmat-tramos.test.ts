import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { NE } from '../src/shared/naturaleza.js';
import {
  codificarCheckpoint, codificarCheckpointEnTramos, codificarEnVuelo, codificarPaginas, decodificarCheckpoint,
} from '../src/world/materia/checkpoint.js';
import { Rol, type MateriaCheckpoint } from '../src/world/materia/tipos.js';
import { REF_NULA, TipoIntento, refDe } from '../src/world/motor/contratos.js';

const sinQuimica = (): never => { throw new Error('La escena sólo contiene energía.'); };

function vacio(): MateriaCheckpoint {
  return {
    epoca: 0, tick: 0, sustancias: new Uint8Array(), registro: new Uint8Array(),
    paginas: codificarPaginas(0, [], []), enVuelo: codificarEnVuelo([]),
    inicial: Array<bigint>(NE + 1).fill(0n), fuentes: Array<bigint>(NE + 1).fill(0n), sumideros: Array<bigint>(NE + 1).fill(0n),
  };
}

function poblado(): MateriaCheckpoint {
  const base = vacio(), epoca = 14;
  const paginas = codificarPaginas(epoca, [
    { ref: refDe(0, 1), celda: 18, rol: Rol.Suelo, dueno: 0, forma: 7, pares: Float64Array.of(0, 53) },
    { ref: refDe(1, 7), celda: 260, rol: Rol.Objeto, dueno: 1, forma: 23, pares: Float64Array.of(0, 12) },
  ], [refDe(2, 1)]);
  const soporte = new Uint8Array(paginas.length + 11);
  soporte.set(paginas, 5);
  const inicial = base.inicial.slice(), sumideros = base.sumideros.slice();
  inicial[NE] = -(2n ** 89n) + 37n;
  sumideros[NE] = inicial[NE]! - (53n + 12n + 7n);
  return {
    ...base, epoca, tick: 8052, inicial, sumideros,
    sustancias: Uint8Array.of(12, 34, 56), registro: Uint8Array.of(254, 255),
    paginas: soporte.subarray(5, 5 + paginas.length),
    enVuelo: codificarEnVuelo([{
      tipo: TipoIntento.Depositar, nonce: 4, de: REF_NULA, a: REF_NULA, celda: 18, lote: REF_NULA,
      materia: Float64Array.of(0, 7), dato: Float64Array.of(Rol.Suelo, 0), bytes: Uint8Array.of(3, 6, 9),
    }]),
  };
}

test('VMAT por tramos conserva los bytes canónicos y presta vistas de las páginas', () => {
  const checkpoint = poblado(), canonico = codificarCheckpoint(checkpoint);
  // Huella del escritor original para esta escena.
  assert.equal(createHash('sha256').update(canonico).digest('hex'), '9738ec6ace1e5e9a5a63addb7ea15b04d658e655aa3f25aa8953bd5c52c0694c');
  assert.deepEqual(decodificarCheckpoint(canonico, sinQuimica), checkpoint);
  for (const maximo of [1, 3, 8, 31, canonico.length + 1]) {
    const { longitud, tramos } = codificarCheckpointEnTramos(checkpoint, maximo);
    const partes = [...tramos];
    assert.equal(longitud, canonico.length);
    assert.ok(partes.every(tramo => tramo.length > 0 && tramo.length <= maximo));
    assert.deepEqual(Buffer.concat(partes), Buffer.from(canonico));
    const vistas = partes.filter(t => t.buffer === checkpoint.paginas.buffer);
    assert.equal(vistas[0]?.byteOffset, checkpoint.paginas.byteOffset);
    assert.equal(vistas.reduce((n, t) => n + t.byteLength, 0), checkpoint.paginas.byteLength);
    assert.deepEqual([...tramos], []);
  }
});

test('VMAT por tramos conserva encabezado vacío y detecta corrupción o truncado', () => {
  const checkpoint = vacio(), { longitud, tramos } = codificarCheckpointEnTramos(checkpoint, 2);
  const bytes = Uint8Array.from(Buffer.concat([...tramos]));
  assert.equal(bytes.length, longitud);
  assert.deepEqual(bytes.subarray(0, 8), Uint8Array.of(0x56, 0x4d, 0x41, 0x54, 1, 0, 0, 0));
  assert.ok(bytes.subarray(8, 24 + 8 + 8).every(byte => byte === 0));
  assert.deepEqual(decodificarCheckpoint(bytes, sinQuimica), checkpoint);
  assert.throws(() => decodificarCheckpoint(bytes.subarray(0, -1), sinQuimica), /truncado/);
  bytes[48] ^= 1;
  assert.throws(() => decodificarCheckpoint(bytes, sinQuimica), /CRC32/);
});

test('VMAT por tramos valida íntegramente antes de entregar el iterador', () => {
  const checkpoint = poblado();
  for (const maximo of [0, -1, 1.5, Infinity]) {
    assert.throws(() => codificarCheckpointEnTramos(checkpoint, maximo), /Entero inválido/);
  }
  assert.throws(() => codificarCheckpointEnTramos({ ...checkpoint, paginas: checkpoint.paginas.subarray(0, -1) }, 5), /truncado/);
  assert.throws(() => codificarCheckpointEnTramos({ ...checkpoint, enVuelo: checkpoint.enVuelo.subarray(0, -1) }, 5), /truncado/);
  assert.throws(() => codificarCheckpointEnTramos({ ...checkpoint, inicial: [] }, 5), /Ancho de cuenta/);
});
