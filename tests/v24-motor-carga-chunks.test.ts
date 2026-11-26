import assert from 'node:assert/strict';
import test from 'node:test';
import { paramsDeEncender } from '../scripts/lab/encender.mjs';
import { poblar } from '../scripts/lab/poblacion.mjs';
import { comprobarLeyes, crearComprobador } from '../src/world/invariantes.js';
import { assertWorld, createWorld } from '../src/world/index.js';
import { codificarCheckpoint, decodificarCheckpoint } from '../src/world/materia/checkpoint.js';
import { enlazarCtx } from '../src/world/motor/acceso.js';
import { duenoSi } from '../src/world/motor/contexto.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { parseParams } from '../src/world/params.js';

for (const hilos of [1, 2]) test(`muestra el frente confirmado y la cobertura con ${hilos} dueños`, async () => {
  const base = paramsDeEncender({ regimen: 'abierto', hasta: 'rebalanceo' });
  const params = parseParams({ motor: { ...base.motor, hilos } }, base);
  const mundo = createWorld(7, params);
  poblar(mundo, { n: 20, siembra: 7, zona: { x: 0, y: 0, ancho: 48, alto: 32 } });
  const motor = crearMotor(mundo, { hilos, gpu: [], decisionGpu: 'siempre', verificar: true, semilla: 7 });
  try {
    assert.equal(motor.paso([]).tick, 1);
    const muestra = motor.muestraCarga();
    assert.ok(muestra);
    assert.equal(muestra.fuente, 'frenteConfirmado');
    assert.equal(muestra.tick, 1);
    assert.deepEqual(motor.muestraCarga(), muestra);
    assert.deepEqual(muestra.chunks.map(c => [c.px, c.py, c.dueno]), motor.reparto()?.paginas);
    assert.equal(new Set(muestra.chunks.map(c => c.dueno)).size, hilos);
    assert.ok(new Set(muestra.chunks.map(c => c.personas)).size > 1, 'la escena concentra personas en algunas páginas');
    assert.ok(muestra.chunks.every(c => c.personasVencen <= c.personas && c.faunaVence <= c.fauna));
    assert.equal(muestra.claseDesconocida, 0);
    assert.equal(muestra.chunks.reduce((n, c) => n + c.personas + c.fauna, 0) + muestra.fueraDeChunkActivo, muestra.ranurasVivas);
    if (hilos === 1) assert.equal(muestra.fasesPorDuenoMs, null);
    else {
      assert.equal(muestra.fasesPorDuenoMs?.length, hilos);
      for (const fase of muestra.fasesPorDuenoMs!) {
        assert.ok(fase.total > 0);
        assert.ok(Math.abs(fase.total - fase.F1 - fase.eco - fase.F2 - fase.F3F4 - fase.F5F6) < 1e-6);
      }
    }

    const { world, materia } = motor.instantanea(), d = duenoSi(mundo);
    assert.ok(materia && d?.quimica);
    assertWorld(world);
    assert.equal(world.people.length + world.animals.length, muestra.ranurasVivas);
    decodificarCheckpoint(codificarCheckpoint(materia), id => d.quimica!.sustancia(id));
    if (world !== mundo) enlazarCtx(world, d);
    assert.deepEqual([...crearComprobador()(world), ...comprobarLeyes(mundo, d.leyes)], []);
  } finally { await motor.cerrar(); }
});
