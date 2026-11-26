import assert from 'node:assert/strict';
import test from 'node:test';
import { escalon } from '../src/shared/interruptores.js';
import { HUNT_ORGANIC, organicLot } from '../src/world/actuar/caza.js';
import { gatherResources } from '../src/world/actuar/recursos.js';
import { assertWorld, createWorld, type World } from '../src/world/index.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { fundarCuerpo, plantillaHumana } from '../src/world/materia/cuerpo.js';
import { parseParams } from '../src/world/params.js';
import { cooperationOpportunity } from '../src/world/society.js';

function motorDe(world: World) {
  return crearMotor(world, { hilos: 1, gpu: [], decisionGpu: 'siempre', verificar: false, semilla: world.seed });
}

test('la materia proyecta stock por encima de 12/8 y la recolección escalar respeta la capacidad del cuerpo', async t => {
  const world = createWorld(7, parseParams({ v23: escalon('cuerpos') }));
  const p = world.people[0]!;
  const tile = world.tiles.find(t => t.x === p.x && t.y === p.y)!;
  tile.stone = 22;
  tile.wood = 31;
  const motor = motorDe(world);
  t.after(() => motor.cerrar());
  motor.cargar({ world, materia: null }, 0);
  assert.ok(tile.wood > 30);
  assert.ok(tile.stone > 21);

  // Con obra apagada las existencias escalares siguen pagando la fabricación heredada.
  // Un cuerpo sintético grande distingue su capacidad real de un valor fijo de 8.
  const c = ctxMateriaDe(world);
  p.cuerpo = fundarCuerpo(c, plantillaHumana(c).id, 400, 1, 1);
  p.materials = { wood: 6, stone: 8 };
  assert.ok(gatherResources(world, p, tile));
  assert.ok(p.materials.stone > 8);
  assert.ok(tile.stone < 22);
  assertWorld(world);
});

test('la cooperación material no intercambia las vistas escalares como si fueran existencias', () => {
  for (const obra of [false, true]) {
    const world = createWorld(7, obra ? parseParams({ v23: escalon('obra') }) : undefined);
    const [p, q] = world.people;
    p!.materials = { wood: 2, stone: 0 };
    q!.materials = { wood: 0, stone: 2 };
    assert.equal(cooperationOpportunity(world, p!)?.kind, obra ? undefined : 'trade');
  }
});

test('una extracción del modo mixto conserva cada lote cuando la técnica nueva está activa', () => {
  const params = parseParams({ v23: { ...escalon('tecnica'), fauna: false } });
  const world = createWorld(7, params), p = world.people[0]!;
  for (let i = 0; i < 7; i++) organicLot(world, p, 0.1, HUNT_ORGANIC);
  assert.equal(p.compounds?.length, 7);
  assert.ok(Math.abs(p.compounds.reduce((n, l) => n + l.mass, 0) - 0.7) < 1e-12);
});

test('personas y animales reservan sus campos opcionales desde la construcción', () => {
  const world = createWorld(7, parseParams({ v23: escalon('intentos') }));
  for (const p of world.people) {
    assert.ok(Object.hasOwn(p, 'cuerpo'));
    assert.ok(Object.hasOwn(p, 'carga'));
    assert.ok(Object.hasOwn(p, 'home'));
    assert.ok(Object.hasOwn(p.technology, 'waterPreparation'));
    assert.ok(p.technology.tecnica);
  }
  for (const a of world.animals) {
    assert.ok(Object.hasOwn(a, 'cuerpo'));
    assert.ok(Object.hasOwn(a, 'fauna'));
  }
});
