import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from '../src/world/index.js';
import { parseParams, paramsOf } from '../src/world/params.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { createDecisionReadOnlyProxy, withReadOnlyDecisionGuard } from '../src/world/paralelo/guardia.js';

const conDepuracion = () => createWorld(4821, parseParams('motor.depuracion=true'));
const sinDepuracion = () => createWorld(4821, parseParams('motor.depuracion=false'));

test('T148: con motor.depuracion=true, escribir una tesela en fase B lanza nombrando el slot culpable', () => {
  const world = conDepuracion();
  const food = world.tiles[0]!.food;
  assert.throws(() => withReadOnlyDecisionGuard(world, 3, view => { view.tiles[0]!.food = food + 1; }),
    /slot 3.*tiles\[0\]\.food/);
  assert.equal(world.tiles[0]!.food, food, 'la escritura rechazada no llega al mundo real');
});

test('T148: escribir una persona en fase B lanza nombrando el slot culpable', () => {
  const world = conDepuracion();
  assert.ok(world.people.length > 0, 'el mundo de prueba tiene habitantes');
  assert.throws(() => withReadOnlyDecisionGuard(world, 5, view => { view.people[0]!.x += 1; }),
    /slot 5.*people\[0\]\.x/);
});

test('T148: escribir world.totals en fase B lanza nombrando el slot culpable', () => {
  const world = conDepuracion();
  const previo = world.totals.foodHarvested;
  assert.throws(() => withReadOnlyDecisionGuard(world, 2, view => { view.totals.foodHarvested = 1; }),
    /slot 2.*totals\.foodHarvested/);
  assert.equal(world.totals.foodHarvested, previo, 'el total real no cambia');
});

test('T148: borrar una propiedad o mutar con push en fase B lanza nombrando el slot', () => {
  const world = conDepuracion();
  assert.throws(() => withReadOnlyDecisionGuard(world, 4, view => { delete view.totals.foodHarvested; }),
    /slot 4.*totals\.foodHarvested/);
  assert.throws(() => withReadOnlyDecisionGuard(world, 6, view => { view.tiles.push(view.tiles[0]!); }),
    /slot 6.*tiles/);
});

test('T148: un buffer tipado protegido rechaza escritura indexada y métodos mutadores con el slot', () => {
  const buffer = { datos: new Float64Array(4) };
  assert.throws(() => { const view = createDecisionReadOnlyProxy(buffer, 7); view.datos[1] = 1; },
    /slot 7.*datos\[1\]/);
  assert.throws(() => { const view = createDecisionReadOnlyProxy(buffer, 7); view.datos.fill(0); },
    /slot 7.*datos/);
  assert.equal(buffer.datos[1], 0);
});

test('T148: lecturas legítimas en fase B con motor.depuracion=true no lanzan y el digesto no cambia', () => {
  const world = conDepuracion();
  const before = digestoCanonico(world);
  const seen = withReadOnlyDecisionGuard(world, 1, view => {
    assert.equal(paramsOf(view).motor.depuracion, true, 'el proxy conserva los params del mundo');
    let food = 0;
    for (const tile of view.tiles) food += tile.food;
    const ids = view.people.map(person => person.id);
    const first = view.people.find(person => person.role === 'S');
    return { food, ids, role: first?.role, totals: JSON.stringify(view.totals), digest: digestoCanonico(view) };
  });
  let expectedFood = 0;
  for (const tile of world.tiles) expectedFood += tile.food;
  assert.equal(seen.food, expectedFood);
  assert.deepEqual(seen.ids, world.people.map(person => person.id));
  assert.equal(seen.digest, before, 'leer a través de la guardia no cambia el digesto');
  assert.equal(digestoCanonico(world), before);
});

test('T148: activar la guardia no cambia el digesto del mundo', () => {
  const off = sinDepuracion(), on = conDepuracion();
  assert.equal(paramsOf(on).motor.depuracion, true);
  assert.equal(digestoCanonico(on), digestoCanonico(off));
});

test('T148: con motor.depuracion=false el envoltorio devuelve el propio mundo y no intercepta nada', () => {
  const world = sinDepuracion();
  assert.equal(paramsOf(world).motor.depuracion, false);
  const returned = withReadOnlyDecisionGuard(world, 3, view => view);
  assert.strictEqual(returned, world, 'sin depuración no se crea ningún proxy');
  withReadOnlyDecisionGuard(world, 3, view => { view.totals.foodHarvested = 42; });
  assert.equal(world.totals.foodHarvested, 42, 'la escritura pasa sin interceptar');
});

test('T148: el default de motor.depuracion es false y un mundo nuevo no la activa', () => {
  const world = createWorld(4821);
  assert.equal(paramsOf(world).motor.depuracion, false);
  assert.strictEqual(withReadOnlyDecisionGuard(world, 0, view => view), world);
});
