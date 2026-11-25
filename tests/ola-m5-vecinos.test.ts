import assert from 'node:assert/strict';
import test from 'node:test';
import { Clase, REF_NULA, refDe, type CtxLectura } from '../src/world/motor/contratos.js';
import { cercanos, cuantosCerca, masCercano } from '../src/world/motor/vecinos.js';

test('las consultas del frente coinciden con fuerza bruta entre páginas y clases', () => {
  const filas = Array.from({ length: 91 }, (_, s) => ({
    x: (s * 43 % 127) - 63,
    y: (s * 19 % 129) - 64,
    vivo: s % 5 === 0 ? 0 : 1,
    clase: s % 2 === 0 ? Clase.Persona : Clase.Animal,
  }));
  filas.push({ x: 9_999_999, y: -9_999_999, vivo: 1, clase: Clase.Persona });
  const frente = {
    tick: 10, alta: filas.length,
    x: Float32Array.from(filas, f => f.x), y: Float32Array.from(filas, f => f.y),
    vivo: Uint8Array.from(filas, f => f.vivo), clase: Uint8Array.from(filas, f => f.clase),
  };
  const c = { frente } as unknown as CtxLectura;

  for (const [x, y, radio] of [[0, 0, 0], [-16, -16, 16], [-0.5, 16, 3], [25, 20, 50], [0, 0, Infinity], [9_999_999, -9_999_999, 0]]) {
    for (const clase of [0, Clase.Persona, Clase.Animal] as const) {
      const esperados: [number, number][] = [];
      filas.forEach((f, s) => {
        const d2 = (f.x - x) ** 2 + (f.y - y) ** 2;
        if (f.vivo && (!clase || f.clase === clase) && d2 <= radio ** 2) esperados.push([s, d2]);
      });
      const hallados: [number, number][] = [];
      cercanos(c, x, y, radio, clase, (s, d2) => { hallados.push([s, d2]); });
      assert.deepEqual(hallados.sort((a, b) => a[0] - b[0]), esperados);
      assert.equal(cuantosCerca(c, x, y, radio, clase), esperados.length);
      let visitas = 0;
      cercanos(c, x, y, radio, clase, () => { visitas++; return false; });
      assert.equal(visitas, Math.min(1, esperados.length));
    }
  }
});

test('elige entre empates con el azar dado y reconstruye el índice al cambiar el tick', () => {
  const frente = {
    tick: 1, alta: 4, gen: new Int32Array([1, 7, 3, 4]),
    x: new Float32Array([0, -1, 1, 0]), y: new Float32Array([0, 0, 0, 1]),
    vivo: new Uint8Array([1, 1, 1, 1]), clase: new Uint8Array([1, 1, 1, 2]),
  };
  const c = { frente } as unknown as CtxLectura;
  const buscar = (azar: number) => masCercano(c, 0, 0, 1, Clase.Persona, 0, () => true, () => azar);
  assert.notEqual(buscar(0), buscar(0.99));
  assert.equal(masCercano(c, 0, 0, 1, 0, 0, s => s === 3, () => 0), refDe(3, 4));

  frente.tick++;
  frente.vivo[1] = 0;
  frente.x[2] = 20;
  assert.equal(buscar(0), REF_NULA);
});
