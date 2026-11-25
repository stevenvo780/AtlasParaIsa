// Garantías del motor viejo que V23 conserva en piezas nuevas (pedidos de m2b.cierre2 al integrador):
// - el orden Morton de páginas y su dominio int32 (c73221b:tests/gpu-reparto.test.ts), ahora en `soa/morton.ts`;
// - la guarda de escritura por fase (c73221b:tests/guardia-fase-b.test.ts e intencion-confirmacion.test.ts:207, :225),
//   que en V23 es la tabla de organismos con `motor.depuracion`: cada fila la escribe solo su dueño, el dueño sella
//   todas las suyas antes de publicar y el frente publicado no cambia durante el tick.
// La aplicación única y la reemisión de intentos (intencion-confirmacion.test.ts:73, :98) son de M5/M8.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { Clase, refDe, slotDe } from '../src/world/motor/contratos.js';
import { DEFAULT_PARAMS, paramsOf, parseParams } from '../src/world/params.js';
import { mortonCode } from '../src/world/soa/morton.js';
import { TablaOrganismosSoA } from '../src/world/soa/organismos.js';

test('Morton: páginas vecinas en Z, orden total también con coordenadas negativas', () => {
  assert.deepEqual([mortonCode(0, 0), mortonCode(1, 0), mortonCode(0, 1), mortonCode(1, 1)].map(c => c - mortonCode(0, 0)), [0n, 1n, 2n, 3n]);
  // Un bloque 10 × 10 centrado en el origen da códigos distintos; un bloque 2 × 2 alineado con negativas, consecutivos.
  const paginas = Array.from({ length: 100 }, (_, i) => ({ x: i % 10 - 5, y: Math.floor(i / 10) - 5 }));
  assert.equal(new Set(paginas.map(p => mortonCode(p.x, p.y))).size, paginas.length);
  assert.deepEqual([mortonCode(-4, -4), mortonCode(-3, -4), mortonCode(-4, -3), mortonCode(-3, -3)].map(c => c - mortonCode(-4, -4)), [0n, 1n, 2n, 3n]);
  // El sesgo a uint32 deja las negativas antes que las positivas en cada eje.
  assert.ok(mortonCode(-1, 0) < mortonCode(0, 0) && mortonCode(0, -1) < mortonCode(0, 0));
});

test('Morton: el dominio es int32 en cada eje, y los extremos no colisionan', () => {
  for (const c of [NaN, Infinity, -Infinity, 0.5, -2147483649, 2147483648]) {
    assert.throws(() => mortonCode(c, 0), /int32/);
    assert.throws(() => mortonCode(0, c), /int32/);
  }
  assert.notEqual(mortonCode(-2147483648, 2147483647), mortonCode(2147483647, -2147483648));
  assert.equal(mortonCode(-2147483648, -2147483648), 0n);
  assert.equal(mortonCode(2147483647, 2147483647), 2n ** 64n - 1n);
});

test('guarda de escritura: solo el dueño escribe, da de baja o sella su fila, y nombra al hilo y la fila culpables', () => {
  const tabla = new TablaOrganismosSoA(true);
  const deCero = tabla.alta(0, Clase.Animal), deUno = tabla.alta(1, Clase.Persona);
  const cero = tabla.escritura(0), uno = tabla.escritura(1);
  assert.throws(() => cero.fila(slotDe(deUno)), new RegExp(`hilo 0 no es dueño de la fila ${slotDe(deUno)}`));
  assert.throws(() => uno.fila(slotDe(deCero)), new RegExp(`hilo 1 no es dueño de la fila ${slotDe(deCero)}`));
  assert.throws(() => cero.fila(99), /fila 99/, 'una fila que no existe tampoco es suya');
  assert.throws(() => tabla.baja(1, deCero), /hilo 1 no es dueño/);
  cero.fila(slotDe(deCero));
  // La fila de 1 sigue sin sellar: publicar con depuración lo detecta.
  assert.throws(() => tabla.publicar(1), new RegExp(`no selló la fila ${slotDe(deUno)}`));
  uno.fila(slotDe(deUno));
  tabla.publicar(1);
  // La escritura del tick anterior ya no vale, y una Ref caducada no da de baja.
  assert.throws(() => cero.fila(slotDe(deCero)), /otro tick/);
  assert.throws(() => cero.f32('x'), /otro tick/);
  assert.throws(() => tabla.baja(0, refDe(slotDe(deCero), 7)), /caducada/);
});

test('guarda de escritura: el frente publicado no cambia durante el tick; sin depuración no se comprueba', () => {
  for (const depuracion of [true, false]) {
    const tabla = new TablaOrganismosSoA(depuracion);
    const ref = tabla.alta(0, Clase.Animal), s = slotDe(ref);
    tabla.escritura(0).fila(s);
    tabla.publicar(1);
    (tabla.lectura().y as Float32Array)[s] = 3;
    if (depuracion) {
      assert.throws(() => tabla.verificarFrente(), /CRC32/);
      assert.throws(() => tabla.publicar(2), /CRC32/);
    } else {
      assert.doesNotThrow(() => tabla.verificarFrente());
      // Sin sellar la fila ni vigilar el frente: la depuración es lo único que lo comprueba.
      assert.doesNotThrow(() => tabla.publicar(2));
    }
  }
});

test('guarda de escritura: motor.depuracion es diagnóstico, apagado por defecto, y no cambia el mundo', () => {
  assert.equal(DEFAULT_PARAMS.motor.depuracion, false);
  assert.equal(paramsOf(createWorld(4821)).motor.depuracion, false);
  const sin = createWorld(4821), con = createWorld(4821, parseParams('motor.depuracion=true'));
  for (let paso = 0; paso < 60; paso++) { stepWorld(sin); stepWorld(con); }
  assert.ok(con.animals.length > 0, 'la fauna pasó por la tabla de organismos con la guarda activa');
  assert.equal(digestoCanonico(con), digestoCanonico(sin));
});
