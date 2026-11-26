import assert from 'node:assert/strict';
import test from 'node:test';
import { Clase, refDe, type CtxLectura } from '../src/world/motor/contratos.js';
import { cercanos, masCercano } from '../src/world/motor/vecinos.js';

type Fila = readonly [x: number, y: number, clase?: Clase, vivo?: number];
type Visita = [slot: number, distanciaCuadrada: number];

function frente(filas: readonly Fila[], tick = 0) {
  return {
    tick, alta: filas.length, vivo: Uint8Array.from(filas, f => f[3] ?? 1),
    clase: Uint8Array.from(filas, f => f[2] ?? Clase.Persona), gen: Int32Array.from(filas, (_, s) => s + 1),
    x: Float32Array.from(filas, f => f[0]), y: Float32Array.from(filas, f => f[1]),
  };
}

function visitas(datos: ReturnType<typeof frente>, x: number, y: number, radio: number, clase: 0 | Clase, limite = Infinity): Visita[] {
  const salida: Visita[] = [];
  const ctx = { frente: datos } as unknown as CtxLectura;
  cercanos(ctx, x, y, radio, clase, (s, d2) => {
    if (datos.clase[s] !== Clase.Persona) return;
    salida.push([s, d2]);
    if (salida.length >= limite) return false;
  });
  return salida;
}

test('vecinos de radio corto conservan el orden original entre páginas y ranuras', () => {
  const datos = frente([
    [-15.9, -15.9], [-16.1, -16.1], [-16, -16, Clase.Animal], [-17.5, -16.5],
    [-16.2, -15.1], [-15.2, -16.2], [-16.25, -16.25, Clase.Persona, 0], [-1e-4, -0.5],
    [0, -0.25], [-0.5, -1.75], [0.5, 0.5], [4, 0.5], [16.1, 16.1], [17, 17],
    [3.8, 4.1], [5, 3], [3.9, 3.9], [5, 5], [6.5, 6.5],
  ]);
  for (const [x, y] of [[-16, -16], [0, 0], [4, 4], [16, 16], [-40, 10], [NaN, 0]] as const) {
    for (const radio of [0, 0.8, 1.5, 2, 2.01, 16]) {
      const completo = visitas(datos, x, y, radio, 0);
      assert.deepEqual(visitas(datos, x, y, radio, Clase.Persona), completo);
      assert.deepEqual(visitas(datos, x, y, radio, Clase.Persona, 2), completo.slice(0, 2));
    }
  }
  assert.deepEqual(visitas(datos, 4, 4, 2, Clase.Persona).map(([s]) => s), [14, 15, 16, 17]);

  // Dos páginas diagonales dentro de un rectángulo de cuatro. El recorrido disperso toma el orden de alta de páginas.
  const disperso = frente([[0.25, 0.25], [-0.25, -0.25], [0.5, 0.5], [-0.5, -0.5]]);
  assert.deepEqual(visitas(disperso, 0, 0, 2, Clase.Persona).map(([s]) => s), [0, 2, 1, 3]);
});

test('vecinos descartan las subceldas antiguas al publicar otro tick o abrir otro frente', () => {
  const datos = frente([[0, 0], [16, 16]], 10);
  assert.deepEqual(visitas(datos, 0, 0, 2, Clase.Persona), [[0, 0]]);
  datos.tick++;
  datos.x[0] = 16;
  datos.y[0] = 16;
  datos.vivo[1] = 0;
  assert.deepEqual(visitas(datos, 0, 0, 2, Clase.Persona), []);
  assert.deepEqual(visitas(datos, 16, 16, 2, Clase.Persona), [[0, 0]]);
  const nuevo = frente([[0, 0], [-1, 0], [1, 0]], 11);
  assert.deepEqual(visitas(nuevo, 0, 0, 2, Clase.Persona), visitas(nuevo, 0, 0, 2, 0));
  const ctx = { frente: nuevo } as unknown as CtxLectura;
  let sorteos = 0;
  assert.equal(masCercano(ctx, 0, 0, 2, Clase.Persona, 0, () => true, () => { sorteos++; return 0; }), refDe(2, 3));
  assert.equal(sorteos, 1);
});
