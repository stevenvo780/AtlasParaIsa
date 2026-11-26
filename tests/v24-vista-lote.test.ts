import assert from 'node:assert/strict';
import test from 'node:test';
import { ArenaLotes } from '../src/world/materia/arena.js';
import { materiaReal, MemoriaPrueba } from './lib/materia-real.js';

test('la vista de una mezcla con desborde conserva la lectura y el orden ante una consulta anidada', async t => {
  const m = materiaReal();
  t.after(() => m.cerrar());
  const mezcla = m.lote({ H2O: 31, O2: 47, CO2: 13, N2: 53, CH2: 29, madera: 17, SiO2: 23, CaCO3: 19, Fe2O3: 7 }, 310);
  const interior = m.lote({ H2O: 91 }, 270);
  const orden: number[] = [];
  let consultarInterior = false;
  let dentro = false;
  const arena = new ArenaLotes({
    lotes: new MemoriaPrueba(m.memoria.lotes), desborde: new MemoriaPrueba(m.memoria.desborde),
    paginas: new MemoriaPrueba(m.memoria.paginas), hilo: 0, quimica: m.quimica, agua: m.S.H2O,
    terreno: { chunkDe: celda => celda >> 8, duenoChunk: m.memoria.duenoChunk },
    digerible(sustancia) {
      if (!dentro) {
        orden.push(sustancia.id);
        if (consultarInterior) {
          dentro = true;
          try { assert.equal(arena.vista(interior).agua, 91); }
          finally { dentro = false; }
        }
      }
      return sustancia.id;
    },
  });
  const antes = m.arena.muestra(mezcla);
  const esperada = arena.vista(mezcla);
  const ordenEsperado = orden.splice(0);
  assert.equal(ordenEsperado.length, 9, 'la mezcla supera las ocho ranuras en línea');
  consultarInterior = true;
  assert.deepEqual(arena.vista(mezcla), esperada);
  assert.deepEqual(orden, ordenEsperado);
  assert.deepEqual(m.arena.muestra(mezcla), antes);
});
