import assert from 'node:assert/strict';
import test from 'node:test';
import { MundoMaterial, type Forzamiento } from '../src/world/materia/mundo.js';
import { duenoSi } from '../src/world/motor/contexto.js';
import { unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { DEFAULT_PARAMS, setParams } from '../src/world/params.js';

test('la cadencia material conserva el orden del barrido al cambiar páginas o periodo', async t => {
  const semilla = 7;
  const params = { ...DEFAULT_PARAMS, v23: { ...DEFAULT_PARAMS.v23, materia: true, cadenciaMateria: 2 } };
  const mundo = createWorld(semilla, params), motor = crearMotor(mundo, unSoloDueno(semilla));
  const pasos: number[] = [];
  const pasarAntes = MundoMaterial.prototype.pasarAntes;
  // El despacho ocurre antes de la química. Sus reacciones se ejercitan en la prueba de cesión material.
  t.mock.method(MundoMaterial.prototype, 'quimicaSuelos', () => {});
  t.mock.method(MundoMaterial.prototype, 'pasarAntes', function(this: MundoMaterial, p: number, f: Forzamiento) {
    pasos.push(p);
    pasarAntes.call(this, p, f);
  });
  const comprobar = (periodo: number): Int32Array => {
    pasos.length = 0;
    motor.paso([]);
    const d = duenoSi(mundo);
    assert.ok(d);
    const { chunks, terreno, tick } = d;
    const barrido = chunks.filter(p => {
      const sal = (Math.imul(terreno.paginaX[p]!, 0x9e3779b1) ^ Math.imul(terreno.paginaY[p]!, 0x85ebca77)) >>> 0;
      return (tick + sal % periodo) % periodo === 0;
    });
    assert.deepEqual(pasos, Array.from(barrido), `páginas del tick ${tick} en orden de aplicación`);
    return chunks;
  };

  const origen = mundo.people.map(persona => ({ persona, x: persona.x, y: persona.y }));
  const moverHalo = (dx: number): void => {
    for (const { persona, x, y } of origen) {
      persona.x = x + dx;
      persona.y = y;
      persona.target = { x: persona.x, y };
    }
  };

  try {
    const primeras = comprobar(2);
    assert.ok(primeras.length > 2);
    assert.strictEqual(comprobar(2), primeras);

    setParams(mundo, { ...params, v23: { ...params.v23, cadenciaMateria: 3 } });
    assert.strictEqual(comprobar(3), primeras);

    moverHalo(192);
    const nuevas = comprobar(3);
    assert.notStrictEqual(nuevas, primeras);
    assert.ok(mundo.retiredChunks.length > 0);
    assert.strictEqual(comprobar(3), nuevas);

    moverHalo(0);
    const reactivadas = comprobar(3);
    assert.notStrictEqual(reactivadas, nuevas);
    assert.ok(reactivadas.some(p => primeras.includes(p)));

    setParams(mundo, { ...params, v23: { ...params.v23, cadenciaMateria: 1 } });
    assert.strictEqual(comprobar(1), reactivadas);
  } finally { await motor.cerrar(); }
});
