import assert from 'node:assert/strict';
import test from 'node:test';
import { projectWorld, createWorld } from '../src/world/index.js';
import { enlazarCtx, type CtxLey } from '../src/world/motor/acceso.js';
import { LEYES } from '../src/world/motor/leyes.js';
import { DEFAULT_PARAMS, setParams } from '../src/world/params.js';

test('la proyección llama a los ganchos sobre vistas rellenas y solo con ley y contexto', () => {
  const mundo = createWorld(7);
  const legado = projectWorld(mundo);
  const ctx = { mundo } as CtxLey;
  const ley = LEYES.find(l => l.interruptor === 'materia')!;
  const ganchos: NonNullable<typeof ley.proyectar> = {
    tesela(c, t, v) {
      assert.equal(c, ctx);
      assert.equal(v.terrain, t.terrain);
      v.T = 290;
    },
    persona(c, p, v) {
      assert.equal(c, ctx);
      assert.equal(v.name, p.name);
      v.escucha = 0.25;
    },
    animal(c, a, v) {
      assert.equal(c, ctx);
      assert.equal(v.action, a.action);
      v.v23 = { miedo: 0.25, linaje: 1 };
    },
    mundo(c, v) {
      assert.equal(c, ctx);
      assert.ok(v.tiles.every(t => t.T === 290));
      assert.ok(v.people.every(p => p.escucha === 0.25));
      assert.ok(v.animals?.every(a => a.v23?.miedo === 0.25));
      v.reparto = { paginas: [], msPorHilo: [1] };
    },
  };
  const anterior = ley.proyectar;
  const activar = { ...DEFAULT_PARAMS, v23: { ...DEFAULT_PARAMS.v23, materia: true } };
  Object.assign(ley, { proyectar: ganchos });
  try {
    setParams(mundo, activar);
    assert.deepEqual(projectWorld(mundo), legado);
    enlazarCtx(mundo, ctx);
    setParams(mundo, DEFAULT_PARAMS);
    assert.deepEqual(projectWorld(mundo), legado);
    setParams(mundo, activar);
    assert.ok(legado.people.length && legado.animals?.length);
    assert.deepEqual(projectWorld(mundo).reparto, { paginas: [], msPorHilo: [1] });
  } finally {
    Object.assign(ley, { proyectar: anterior });
  }
});
