import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { stringifyExact } from '../../src/shared/exact-json.js';
import { bindWorldContext, closeFaunaParallelPools, closePolicyGpuBatchers, createWorld, projectWorld, stepWorld, worldContext, type World } from '../../src/world/index.js';
import { closeEcosystemWorkers } from '../../src/world/ecosystem.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { DEFAULT_PARAMS, parseParams, setParams } from '../../src/world/params.js';
import { ResidentTopologyOwner } from '../../src/world/soa/topologia.js';

after(async () => {
  await closePolicyGpuBatchers();
  await closeFaunaParallelPools();
  await closeEcosystemWorkers();
});

test('V18 motors: paridad 0 ULP residente SoA/paralelo contra referencia plana durante 30 ticks', () => {
  const referenceParams = parseParams({ motor: { ...DEFAULT_PARAMS.motor, hilos: 1, gpu: [], soaTerreno: false, particionarPersonas: false } });
  const residentParams = parseParams({ motor: { ...DEFAULT_PARAMS.motor, hilos: 4, gpu: [], soaTerreno: true, particionarPersonas: true } });
  const plain = createWorld(51926, referenceParams);
  const resident = createWorld(51926, residentParams);
  // Un agente basta para cruzar movimiento y activar/retirar chunks, manteniendo la regresión ligera.
  plain.people.splice(1);
  resident.people.splice(1);
  const owner = new ResidentTopologyOwner();
  resident.tiles = owner.tiles(resident.tiles.map(tile => owner.tile(tile)));
  bindWorldContext(resident, { ...worldContext(resident), tileOwnership: owner });

  const digest = (world: World): string => {
    const saved = world === resident ? residentParams : referenceParams;
    setParams(world, referenceParams);
    const result = digestoCanonico(world);
    setParams(world, saved);
    return result;
  };

  for (let tick = 0; tick < 30; tick++) {
    if (tick === 5 || tick === 20) {
      for (const world of [plain, resident]) for (const person of world.people) {
        person.x += 48; person.y += 32; person.target = { x: person.x, y: person.y };
      }
    } else if (tick === 12) {
      for (const world of [plain, resident]) for (const person of world.people) {
        person.x -= 48; person.y -= 32; person.target = { x: person.x, y: person.y };
      }
    }
    stepWorld(plain, [], worldContext(plain));
    stepWorld(resident, [], worldContext(resident));
    assert.equal(digest(resident), digest(plain), `digesto distinto en tick ${tick + 1}`);
  }

  assert.equal(
    stringifyExact(projectWorld(resident, undefined, worldContext(resident))),
    stringifyExact(projectWorld(plain, undefined, worldContext(plain))),
    'la proyección final debe ser idéntica byte a byte',
  );
});
