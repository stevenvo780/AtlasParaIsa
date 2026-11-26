import assert from 'node:assert/strict';
import test from 'node:test';
import { deserialize, serialize } from 'node:v8';
import { MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { stringifyExact } from '../src/shared/exact-json.js';
import { assertAnimal, materializeAnimals, type Animal } from '../src/world/animals.js';
import { faunaCorteDe, faunaVerificadaDe, tomarFaunaVerificada } from '../src/world/motor/fauna-corte.js';
import { CanalesCorte, enviarParteCorte } from '../src/world/motor/mensajes-corte.js';
import type { World } from '../src/world/mundo/tipos.js';

const tick = 12, epoca = 3;
const mundoConFauna = (): World => {
  const tiles: World['tiles'] = [{ x: 0, y: 0, fauna: 2, species: 'hare', terrain: 'meadow', moisture: 0, vegetation: 0, food: 0 }];
  const animals = materializeAnimals(7, tiles, tick, true);
  const parte: Pick<World, 'tick' | 'tiles' | 'people' | 'animals'> = { tick, tiles, people: [], animals };
  return parte as World;
};

test('la fauna directa solo viaja como filas UTF-8 con signo exacto y conserva sus textos una vez', () => {
  const world = mundoConFauna(), animal = world.animals[0]!;
  animal.reason = 'Río 🐇\nRefugio\r';
  animal.work = -0;
  assert.equal(Object.hasOwn(animal, 'morphology'), true);
  const canales = CanalesCorte.abrir(1)!;
  const { port1, port2 } = new MessageChannel();
  try {
    const solicitud = canales.pedir('directa');
    enviarParteCorte(port1, canales.solicitud, epoca, 1, world);
    const sobre = receiveMessageOnPort(port2)!.message;
    assert.deepEqual(deserialize(sobre.bytes).animals, []);
    assert.deepEqual(sobre.faunaSustituida, { cantidad: 2 });
    assert.equal(sobre.fauna.length, 1);
    const bloque = sobre.fauna[0];
    assert.equal(bloque.cuerpo.byteLength, bloque.cuerpo.buffer.byteLength);
    assert.equal(bloque.cuerpo.byteOffset, 0);
    const esperadas = world.animals.map(animal => stringifyExact(animal));
    assert.equal(new TextDecoder().decode(bloque.cuerpo), esperadas.join('\n'));
    canales.puertosRemotos[0]!.postMessage(sobre);
    const fauna = canales.recibir(solicitud, epoca, tick)[0]!.animals;
    assert.equal(fauna[0]!.reason, animal.reason);
    assert.ok(Object.is(fauna[0]!.work, -0));
    assert.equal(fauna[0]!.morphology, undefined);
    assert.deepEqual(fauna.map(animal => stringifyExact(animal)), esperadas);
    assert.equal(faunaCorteDe(fauna), undefined);
    const tramos = faunaVerificadaDe(fauna);
    assert.deepEqual(tramos, [{ desde: 0, filas: esperadas }]);
    assert.ok(Object.isFrozen(tramos) && Object.isFrozen(tramos![0]) && Object.isFrozen(tramos![0]!.filas));
    assert.equal(tomarFaunaVerificada(fauna), tramos);
    assert.equal(tomarFaunaVerificada(fauna), undefined);
  } finally { canales.cerrar(); port1.close(); port2.close(); }
});

test('la guardia de fauna conserva V8 para el dueño que produciría JSON con pérdida', () => {
  const casos: readonly ((world: World) => void)[] = [
    world => { world.animals[0]!.health = NaN; },
    world => { world.animals[0]!.health = Infinity; },
    world => { world.animals[1]!.target = world.animals[0]!.target; },
    world => { world.animals[0]!.target = world.tiles[0]!; },
    world => { Object.assign(world.animals[0]!, { circular: world.animals[0] }); },
    world => { world.animals[0]!.memory.length = 1; },
    world => { Object.assign(world.animals[0]!.memory, { otroCampo: 3 }); },
    world => { Object.setPrototypeOf(world.animals[0]!.target, null); },
    world => { Object.assign(world.animals[0]!, { otroCampo: 5n }); },
    world => { Object.defineProperty(world.animals[0]!, 'toJSON', { value: () => ({}) }); },
  ];
  const canales = CanalesCorte.abrir(2)!;
  try {
    for (const mutar of casos) {
      const world = mundoConFauna();
      mutar(world);
      const solicitud = canales.pedir('directa');
      enviarParteCorte(canales.puertosRemotos[0]!, canales.solicitud, epoca, 1, world);
      enviarParteCorte(canales.puertosRemotos[1]!, canales.solicitud, epoca, 2, mundoConFauna());
      const [canonica, directa] = canales.recibir(solicitud, epoca, tick);
      assert.equal(faunaVerificadaDe(canonica!.animals), undefined);
      assert.equal(faunaCorteDe(canonica!.animals), undefined);
      assert.deepEqual(canonica!.animals, deserialize(serialize(world.animals)));
      if (!Number.isFinite(world.animals[0]!.health)) assert.throws(() => assertAnimal(canonica!.animals[0], tick), /inválido/);
      if (world.animals[0]!.target === world.tiles[0]) assert.equal(canonica!.animals[0]!.target, canonica!.tiles[0]);
      assert.ok(faunaVerificadaDe(directa!.animals));
    }
  } finally { canales.cerrar(); }
});

test('la guardia no invoca getters ni traps y conserva los errores de V8', () => {
  const canales = CanalesCorte.abrir(1)!;
  try {
    const world = mundoConFauna();
    let lecturas = 0;
    Object.defineProperty(world.animals[0]!, 'health', { enumerable: true, get: () => { lecturas++; return 1; } });
    const solicitud = canales.pedir('directa');
    enviarParteCorte(canales.puertosRemotos[0]!, canales.solicitud, epoca, 1, world);
    assert.equal(lecturas, 1);
    assert.equal(faunaVerificadaDe(canales.recibir(solicitud, epoca, tick)[0]!.animals), undefined);
    const opacos = [() => ({}), Symbol(), new Proxy({ x: 0, y: 0 }, {
      get: () => { throw new Error('trap ejecutado'); }, ownKeys: () => { throw new Error('trap ejecutado'); },
    })];
    for (const valor of opacos) {
      const invalido = mundoConFauna();
      invalido.animals[0]!.target = valor as Animal['target'];
      assert.throws(() => enviarParteCorte(canales.puertosRemotos[0]!, canales.solicitud, epoca, 1, invalido), /could not be cloned/);
    }
  } finally { canales.cerrar(); }
});

test('las incoherencias del sobre o de las filas directas invalidan el corte', () => {
  const canales = CanalesCorte.abrir(1)!;
  try {
    const world = mundoConFauna(), fila = stringifyExact(world.animals[0]);
    const bloque = (texto: string, filas = 1) => [{ filas, cuerpo: new TextEncoder().encode(texto) }];
    const envelope = { epoca, tick, dueno: 1, bytes: serialize({ tick, animals: [] }),
      fauna: bloque(fila), faunaSustituida: { cantidad: 1 } };
    for (const cambio of [
      { faunaSustituida: undefined },
      { faunaSustituida: null },
      { faunaSustituida: { cantidad: -1 } },
      { faunaSustituida: { cantidad: 2 } },
      { fauna: undefined },
      { fauna: bloque(fila, 2) },
      { fauna: bloque(fila + '\n') },
      { fauna: bloque('\ufeff' + fila) },
      { fauna: bloque(fila + '\r') },
      { fauna: bloque('{inválido}') },
      { fauna: [{ filas: 1, cuerpo: Uint8Array.of(0xc0, 0xaf) }] },
      { bytes: serialize({ tick, animals: world.animals }) },
    ]) {
      const solicitud = canales.pedir('directa');
      canales.puertosRemotos[0]!.postMessage({ ...envelope, ...cambio, solicitud });
      assert.throws(() => canales.recibir(solicitud, epoca, tick), /Fauna directa inválida para el dueño 1/);
    }
  } finally { canales.cerrar(); }
});
