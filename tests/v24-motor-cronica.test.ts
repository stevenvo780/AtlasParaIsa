import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/server/store.js';
import { escalon } from '../src/shared/interruptores.js';
import { assertChronicleJournal } from '../src/world/chronicle-journal.js';
import { demographicTraits } from '../src/world/demography.js';
import { repartirPorTramos } from '../src/world/motor/bloques.js';
import { unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { assertWorld } from '../src/world/mundo/validar.js';
import { parseParams } from '../src/world/params.js';
import { recordSample } from '../src/world/statistics.js';

test('dos dueños: la crónica asienta sucesos del dueño 0 y de otro dueño sin rebotar entre ticks', async () => {
  const semilla = 7, hilos = 2;
  const params = parseParams({ v23: escalon('duenos'), motor: { hilos } });
  const mundo = createWorld(semilla, params);
  const paginas = Object.values(mundo.chunks);
  const reparto = repartirPorTramos(paginas.map(p => p.cx), paginas.map(p => p.cy), hilos);
  const tileDe = (dueno: number) => {
    const tile = mundo.tiles.find(t => t.terrain !== 'water' && paginas.some((pagina, i) =>
      reparto[i] === dueno && pagina.cx === (t.x >> 4) && pagina.cy === (t.y >> 4)));
    assert.ok(tile);
    return tile;
  };
  const [victima, superviviente] = mundo.people.filter(p => p.role === 'neighbor');
  assert.ok(victima && superviviente);
  const tile1 = tileDe(1), tile0 = tileDe(0);
  victima.x = tile1.x; victima.y = tile1.y; victima.target = { x: tile1.x, y: tile1.y };
  superviviente.x = tile0.x; superviviente.y = tile0.y; superviviente.target = { x: tile0.x, y: tile0.y };
  tile0.vegetation = 0.2;
  const edad = demographicTraits(victima.genome, params.cuerpo);
  victima.demography.age = Math.floor((edad.senescenceStart + edad.maximumAge) / 2);
  victima.bornAt = -victima.demography.age;
  victima.demography.health = Number.MIN_VALUE;
  const contadorInicial = mundo.eventCounter;

  const motor = crearMotor(mundo, { ...unSoloDueno(semilla), hilos }) as ReturnType<typeof crearMotor> & { cronicaDesfasada?: number };
  const store = new Store(':memory:');
  try {
    const paso1 = motor.paso([{ id: 'g-dueno0', kind: 'plant', x: tile0.x, y: tile0.y }]);
    assert.equal(paso1.resultados.length, 1);
    assert.equal(paso1.resultados[0]!.accepted, true);

    const vista1 = motor.vista();
    const pendientesVista1 = vista1.chronicleJournal?.pending.length ?? 0;
    assert.equal(motor.cronicaDesfasada, 0, 'no debe haber desfase al asentar sucesos de F0 y de los workers');
    assert.ok(vista1.eventCounter >= contadorInicial + 2, `esperaba ≥${contadorInicial + 2} sucesos y hubo ${vista1.eventCounter}`);
    assert.ok(vista1.events.some(e => e.kind === 'gesture' && e.tick === 1), 'el gesto en dueño 0 queda en la crónica del tick 1');
    assert.ok(vista1.events.some(e => e.kind === 'death' && e.actors.includes(victima.id) && e.tick === 1),
      'la baja del dueño 1 queda en la crónica del tick 1');
    assertChronicleJournal(vista1);
    assertWorld(vista1);

    const muerteTick1 = vista1.events.find(e => e.kind === 'death' && e.actors.includes(victima.id))!;
    const gestoTick1 = vista1.events.find(e => e.kind === 'gesture' && e.tick === 1)!;

    motor.paso([]);
    assert.equal(motor.cronicaDesfasada, 0, 'los sucesos del tick 1 no deben rebotar al tick 2');
    assert.equal(vista1.chronicleJournal?.pending.length, pendientesVista1,
      'vista() no debe compartir el diario mutable del coordinador con pasos posteriores');

    const inst2 = motor.instantanea();
    assertChronicleJournal(inst2.world);
    assertWorld(inst2.world);
    assert.equal(inst2.world.events.filter(e => e.kind === 'gesture' && e.x === tile0.x && e.y === tile0.y).length, 1,
      'el gesto no se vuelve a emitir en el tick 2');
    assert.equal(inst2.world.events.filter(e => e.kind === 'death' && e.actors.includes(victima.id)).length, 1,
      'la muerte no se vuelve a emitir en el tick 2');
    assert.equal(inst2.world.events.find(e => e.id === gestoTick1.id)?.tick, 1);
    assert.equal(inst2.world.events.find(e => e.id === muerteTick1.id)?.tick, 1);

    store.guardar(inst2);
    const cargado = store.cargarGuardadoCompleto();
    assert.ok(cargado);
    assertChronicleJournal(cargado.instantanea.world);
    assert.equal(cargado.instantanea.world.eventCounter, inst2.world.eventCounter);
  } finally {
    store.close();
    await motor.cerrar();
  }
});

test('muestras de historia por tick sin duplicados en recordSample y en lecturas repetidas de dos dueños', async () => {
  const semilla = 11, hilos = 2;
  const params = parseParams({ v23: escalon('duenos'), motor: { hilos } });
  const mundo = createWorld(semilla, params);
  mundo.tick = 60;
  recordSample(mundo);
  recordSample(mundo);
  assert.deepEqual(mundo.history.map(m => m.tick), [60]);
  mundo.tick = 120;
  recordSample(mundo);
  recordSample(mundo);
  assert.deepEqual(mundo.history.map(m => m.tick), [60, 120]);

  const mundo2 = createWorld(semilla, params);
  const motor = crearMotor(mundo2, { ...unSoloDueno(semilla), hilos });
  try {
    motor.cargar({ world: mundo2, materia: null }, 0);
    const inst0 = motor.instantanea();
    assert.deepEqual(inst0.world.history.map(m => m.tick), [0]);
    motor.cargar(inst0, 0);
    const vista0 = motor.vista();
    const inst0Rep = motor.instantanea();
    assert.deepEqual(vista0.history.map(m => m.tick), [0], 'vista() en el mismo tick múltiplo de 60 no duplica la muestra');
    assert.deepEqual(inst0Rep.world.history.map(m => m.tick), [0], 'instantanea() repetida no duplica la muestra');
  } finally {
    await motor.cerrar();
  }
});
