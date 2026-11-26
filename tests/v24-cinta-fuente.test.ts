import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fuenteFotograma } from '../src/server/cinta/fuente.js';
import type { RuntimeStats } from '../src/shared/types.js';
import { addEvent, createWorld } from '../src/world/mundo/crear.js';
import type { CtxF0 } from '../src/world/motor/acceso.js';

const runtime: RuntimeStats = {
  stepMs: 0, p95StepMs: 0, saveMs: 0, projectionMs: 0, snapshotBytes: 0, activeTiles: 0, processRssMiB: 0,
  tickHz: 0, fraccionSerial: 0, fases: { maintainRegions: 0, ecologia: 0, kernel: 0, fauna: 0, personas: 0,
    encuentros: 0, demografia: 0, comunidades: 0, reproduccion: 0, checkpoint: 0, muestreo: 0, save: 0, broadcast: 0 },
};

test('la fuente compara textos con el último fotograma publicado y repite los textos vivos en un completo', () => {
  const mundo = createWorld(42);
  mundo.people = mundo.people.slice(0, 2);
  mundo.animals = [];
  const [persona, retirada] = mundo.people;
  persona.uid = 1; retirada.uid = 2;
  persona.recentMemory = 'Recuerdo anterior';
  const { cx, cy } = Object.values(mundo.chunks)[0]!;
  const idPagina = `${cx},${cy}`, pagina = Int32Array.of(cx, cy);
  const c = { mundo } as CtxF0;
  const fuente = fuenteFotograma(mundo, 0, 'prueba', runtime, () => 0, () => undefined);
  const ranura = new SharedArrayBuffer(0), versiones = new Float64Array(0);
  function corte(completo = false) {
    const f = { ranura, versiones, completo, tick: mundo.tick, epoca: 0 };
    return { sucesos: fuente.corte(c, f, completo ? pagina : new Int32Array(0)).sucesos,
      confirmar: () => fuente.confirmar(f) };
  }
  const base = corte(true);
  assert.equal(base.sucesos[0]?.tipo, 'cronica');
  const bajas = base.sucesos.filter(s => s.tipo === 'texto' && s.uid === retirada.uid).map(s => ({ ...s, valor: null }));
  assert.ok(bajas.length >= 5);
  base.confirmar();

  mundo.tick++;
  const evento = addEvent(mundo, { kind: 'memory', actors: [], text: 'Una pausa.', source: 'sample', cause: 'Prueba.' });
  persona.reason = 'Aquí encontró agua.';
  persona.need = '';
  persona.recentMemory = null;
  mundo.people.pop();
  const fallido = corte();
  assert.deepEqual(fallido.sucesos.filter(s => s.tipo === 'cronica' || s.tipo === 'texto'), [
    { tipo: 'cronica', evento },
    { tipo: 'texto', uid: 1, campo: 'reason', valor: 'Aquí encontró agua.' },
    { tipo: 'texto', uid: 1, campo: 'need', valor: '' },
    { tipo: 'texto', uid: 1, campo: 'recentMemory', valor: null },
    ...bajas,
  ]);
  assert.ok(!fallido.sucesos.some(s => s.tipo === 'pagina'));
  const reintento = corte();
  assert.deepEqual(reintento.sucesos, fallido.sucesos);
  reintento.confirmar();
  assert.ok(!corte().sucesos.some(s => s.tipo === 'texto' || s.tipo === 'cronica'));

  const completo = corte(true);
  const textosCompletos = completo.sucesos.filter(s => s.tipo === 'texto');
  assert.deepEqual(textosCompletos.map(s => s.campo), ['name', 'color', 'reason', 'need', 'specialty']);
  assert.ok(textosCompletos.every(s => s.uid === 1 && s.valor !== null));
  assert.ok(completo.sucesos.some(s => s.tipo === 'pagina' && s.id === idPagina && s.vista !== null));
  completo.confirmar();
  delete mundo.chunks[idPagina];
  assert.deepEqual(corte().sucesos.filter(s => s.tipo === 'pagina'), [{ tipo: 'pagina', id: idPagina, vista: null }]);
});
