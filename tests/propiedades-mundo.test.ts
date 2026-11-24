import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createWorld, stepWorld, closePersonasParallelPools, closeFaunaParallelPools, closePolicyGpuBatchers } from '../src/world/index.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { parseParams } from '../src/world/params.js';
import { crearComprobador } from '../src/world/invariantes.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { propiedad } from './lib/propiedades.js';

after(async () => { await Promise.all([closePersonasParallelPools(), closeFaunaParallelPools(), closePolicyGpuBatchers(), closeEcosystemWorkers()]); });

propiedad('mundos pequeños aleatorios preservan las invariantes en cada paso, T=1 sin GPU',
  { casos: 4, semilla: 230024, repeticiones: 3 },
  (azar, semilla) => ({ semilla, ticks: azar.entero(200, 260),
    params: parseParams({ motor: { hilos: 1, gpu: [] },
      agua: { cuencas: azar.elegir([0.6, 0.8, 1]) },
      social: { radioConvivencia: azar.entero(0, 4) },
      genes: { varianzaFundadores: azar.elegir([0.2, 0.5, 0.8]) } }) }),
  ({ semilla, ticks, params }) => {
    const mundo = createWorld(semilla, params), comprobar = crearComprobador();
    assert.deepEqual(comprobar(mundo), []);
    for (let tick = 1; tick <= ticks; tick++) {
      stepWorld(mundo);
      assert.deepEqual(comprobar(mundo), [], `semilla=${semilla}, tick=${tick}`);
    }
  });

test('misma semilla explícita en T=1 produce el mismo digesto entre dos corridas', () => {
  const correr = () => {
    const mundo = createWorld(19104, parseParams({ motor: { hilos: 1, gpu: [] } }));
    for (let i = 0; i < 240; i++) stepWorld(mundo);
    return digestoCanonico(mundo);
  };
  assert.equal(correr(), correr());
});
