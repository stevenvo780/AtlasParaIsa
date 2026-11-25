import test from 'node:test';
import assert from 'node:assert/strict';
import { codigoForma, formaDeCodigo } from '../src/shared/materia.js';
import { OLVIDO_RECETA } from '../src/shared/naturaleza.js';
import { CLAVES_FUNCIONALES, codificarReceta, decodificarReceta, leerReceta, registrarReceta, vectorFuncional } from '../src/world/materia/proceso.js';
import type { Paso, VistaLote } from '../src/world/materia/tipos.js';
import type { Registro } from '../src/world/motor/contratos.js';
import { codificarEnsenanza, decodificarEnsenanza } from '../src/world/technology.js';
import { fuerzaReceta, nuevaTecnica, olvidarRecetas, recordarReceta, tauRecetaTicks, usarReceta, vidaReceta } from '../src/world/technology-memory.js';
import { isGenuineFunctionalNovelty, novedadFuncional, type PerfilFuncional } from '../src/world/tecnologia-complejidad.js';
import { TICKS_PER_DAY } from '../src/world/mundo/tipos.js';
import type { TechnologyRecipe } from '../src/shared/technology.js';

const forma = { largo: 0.2, ancho: 0.05, grueso: 0.01, hueco: 0, filo: 0.8 };
const receta: Paso[] = [
  { op: 'unir', insumo: 7, forma: 0, masa: 0.75 },
  { op: 'romper', forma },
  { op: 'calentar', hasta: { T: 1100, ticks: 40 } },
  { op: 'mojar', hasta: { ticks: 12 } },
];

function registroDePrueba(): Registro {
  const filas: Uint8Array[] = [], ids = new Map<string, number>();
  return {
    insertar(b) {
      const k = Buffer.from(b).toString('hex');
      let id = ids.get(k);
      if (id === undefined) { id = filas.length; filas.push(b.slice()); ids.set(k, id); }
      return id;
    },
    leer: id => filas[id],
    get n() { return filas.length; },
  };
}

test('t1: una receta va y vuelve por sus bytes canónicos, con la forma cuantizada', () => {
  const bytes = codificarReceta(receta), vuelta = decodificarReceta(bytes)!;
  assert.equal(vuelta.length, 4);
  assert.deepEqual(vuelta[0], receta[0]);
  assert.equal(vuelta[1]!.op, 'romper');
  assert.deepEqual((vuelta[1] as { forma: unknown }).forma, formaDeCodigo(codigoForma(forma)));
  assert.deepEqual(vuelta[2], receta[2]);
  assert.deepEqual(vuelta[3], { op: 'mojar', hasta: { ticks: 12 } });
  assert.deepEqual(codificarReceta(vuelta), bytes, 'decodificar y volver a codificar no cambia la receta');
  assert.equal(decodificarReceta(bytes.subarray(0, bytes.length - 1)), null);
  assert.equal(decodificarReceta(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0])), null);
});

test('t1: el registro da el mismo id a la misma receta y la devuelve', () => {
  const r = registroDePrueba();
  const a = registrarReceta(r, receta), b = registrarReceta(r, decodificarReceta(codificarReceta(receta))!);
  assert.equal(a, b);
  assert.notEqual(registrarReceta(r, receta.slice(0, 2)), a);
  assert.equal(leerReceta(r, a)!.length, 4);
  assert.equal(leerReceta(r, 99), null);
});

test('t1: olvido con τ = TAU_BASE + TAU_APRENDIZAJE·learningRate días; usar la pone a 1', () => {
  const tau = tauRecetaTicks(0.25);
  assert.equal(tau, 2 * TICKS_PER_DAY);
  const t = nuevaTecnica();
  recordarReceta(t, { id: 3, usada: 0, generacion: 1, padres: [], vector: [] });
  recordarReceta(t, { id: 4, usada: 100, generacion: 2, padres: [3], vector: [] });
  assert.ok(Math.abs(fuerzaReceta(t.recetas[0]!, tau, tau) - Math.exp(-1)) < 1e-12);
  const vida = vidaReceta(tau);
  assert.ok(Math.abs(fuerzaReceta({ usada: 0 }, vida, tau) - OLVIDO_RECETA) < 1e-12);
  assert.deepEqual(olvidarRecetas(t, Math.floor(vida), tau), []);
  assert.deepEqual(olvidarRecetas(t, Math.ceil(vida) + 1, tau), [3]);
  assert.deepEqual(t.recetas.map(r => r.id), [4]);
  assert.ok(usarReceta(t, 4, Math.ceil(vida) + 1));
  assert.equal(fuerzaReceta(t.recetas[0]!, Math.ceil(vida) + 1, tau), 1);
  assert.equal(usarReceta(t, 3, 0), false);
  assert.equal(JSON.parse(JSON.stringify(nuevaTecnica())).ultimoIntento, nuevaTecnica().ultimoIntento, 'el estado se guarda en JSON sin perder nada');
});

test('t1: una enseñanza va y vuelve por sus bytes', () => {
  const r = { id: 12, generacion: 3, padres: [4, 9], vector: CLAVES_FUNCIONALES.map((_, i) => i / 100) };
  assert.deepEqual(decodificarEnsenanza(codificarEnsenanza(r)), r);
  assert.equal(decodificarEnsenanza(new Uint8Array(30)), null);
});

test('t1: vector funcional = propiedades del lote × rasgos de su forma', () => {
  const v: VistaLote = { masa: 1, T: 295, fase: 0, dureza: 0.8, tenacidad: 0.5, sellado: 0.2, aislamiento: 0.1, energia: 0, digerible: 0,
    agua: 0, color: 0, forma: 0, principal: 1 };
  const monton = vectorFuncional(v);
  assert.equal(monton.length, CLAVES_FUNCIONALES.length);
  assert.equal(monton[CLAVES_FUNCIONALES.indexOf('dureza·material')], 0.8);
  assert.equal(monton[CLAVES_FUNCIONALES.indexOf('dureza·filo')], 0);
  const hoja = vectorFuncional({ ...v, forma: codigoForma(forma) });
  assert.ok(hoja[CLAVES_FUNCIONALES.indexOf('dureza·filo')]! > 0.6);
  assert.ok(vectorFuncional({ ...v, masa: 0 }).every(x => x === 0));
});

test('t1: el criterio genérico de novedad es el de isGenuineFunctionalNovelty', () => {
  const base = (id: string, capacities: Record<string, number>, generation = 1, parents: string[] = []): TechnologyRecipe => ({
    id, name: id, program: { inputs: [], steps: [] }, signature: id, parents, generation, inventorId: 'p', tick: 0, x: 0, y: 0,
    novelty: 'program', uses: 0, utility: 0, manufactured: 0,
    capacities: { cutting: 0, storage: 0, insulation: 0, cultivation: 0, binding: 0, abrasion: 0, ...capacities },
  });
  const existentes = [base('a', { cutting: 0.5 }), base('b', { cutting: 0.3, storage: 0.4 })];
  for (const [c, tol] of [[base('x', { cutting: 0.52 }), 0.05], [base('y', { cutting: 0.6 }), 0.05], [base('z', { storage: 0.2 }), 0],
    [base('w', { cutting: 0.3, storage: 0.4 }), 0]] as const) {
    assert.equal(novedadFuncional(['cutting', 'storage', 'insulation', 'cultivation', 'binding', 'abrasion'], c, existentes, tol, () => false),
      isGenuineFunctionalNovelty(c, existentes, tol));
  }
  const perfil = (id: string, capacities: Record<string, number>): PerfilFuncional => ({ id, signature: id, generation: 1, parents: [], capacities });
  assert.equal(novedadFuncional(['x', 'y'], perfil('n', { y: 0.5 }), [perfil('e', { x: 0.9 })], 0, () => false), true);
  assert.equal(novedadFuncional(['x', 'y'], perfil('n', { x: 0.5 }), [perfil('e', { x: 0.9 })], 0, () => false), false);
});
