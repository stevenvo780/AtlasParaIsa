import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/server/store.js';
import { escalon } from '../src/shared/interruptores.js';
import { demographicTraits } from '../src/world/demography.js';
import { repartirPorTramos } from '../src/world/motor/bloques.js';
import { unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { assertWorld } from '../src/world/mundo/validar.js';
import { parseParams } from '../src/world/params.js';

test('el guardado repartido conserva la comunidad tras la baja de un miembro remoto', async () => {
  const semilla = 7, hilos = 2;
  const params = parseParams({ v23: escalon('duenos'), motor: { hilos } });
  const mundo = createWorld(semilla, params);
  const paginas = Object.values(mundo.chunks);
  const reparto = repartirPorTramos(paginas.map(p => p.cx), paginas.map(p => p.cy), hilos);
  const [victima, superviviente, vecina] = mundo.people.filter(p => p.role === 'neighbor');
  const situar = (p: typeof victima, dueno: number): void => {
    const tile = mundo.tiles.find(t => t.terrain !== 'water' && paginas.some((pagina, i) =>
      reparto[i] === dueno && pagina.cx === (t.x >> 4) && pagina.cy === (t.y >> 4)));
    assert.ok(tile);
    p.x = tile.x; p.y = tile.y; p.target = { x: tile.x, y: tile.y };
  };
  situar(victima, 1);
  situar(superviviente, 0);
  const edad = demographicTraits(victima.genome, params.cuerpo);
  victima.demography.age = Math.floor((edad.senescenceStart + edad.maximumAge) / 2);
  victima.bornAt = -victima.demography.age;
  victima.demography.health = Number.MIN_VALUE;
  superviviente.bonds[victima.id] = 0.8;
  const grupo = { id: 'comunidad-1', name: 'Grupo', x: superviviente.x, y: superviviente.y, color: '#aaaaaa',
    members: [victima.id, superviviente.id, vecina.id], memberCount: 3, culture: { ...superviviente.culture },
    formedAt: 0, cooperation: 0, disputes: 0 };
  mundo.communities = [grupo];
  mundo.communityCounter = 1;
  for (const p of [victima, superviviente, vecina]) p.communityId = grupo.id;
  assertWorld(mundo);

  const motor = crearMotor(mundo, { ...unSoloDueno(semilla), hilos });
  const store = new Store(':memory:');
  try {
    motor.paso([]);
    const instantanea = motor.instantanea(), { world } = instantanea;
    assert.ok(world.retiredLegacy.some(p => p.id === victima.id && p.diedAt === world.tick));
    assert.ok(!world.people.some(p => p.id === victima.id));
    assertWorld(world);
    const comunidad = world.communities.find(c => c.id === grupo.id);
    assert.deepEqual(comunidad?.members, [superviviente.id, vecina.id]);
    assert.equal(comunidad?.memberCount, 2);
    assert.ok(!Object.hasOwn(world.people.find(p => p.id === superviviente.id)!.bonds, victima.id));
    store.guardar(instantanea);
    const restaurado = store.cargarGuardadoCompleto()?.instantanea.world;
    assert.ok(restaurado);
    assert.deepEqual(restaurado.communities, world.communities);
    assert.deepEqual(restaurado.people.find(p => p.id === superviviente.id)?.bonds,
      world.people.find(p => p.id === superviviente.id)?.bonds);
  } finally {
    store.close();
    await motor.cerrar();
  }
});
