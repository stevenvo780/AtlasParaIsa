import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { digestoSin } from '../scripts/lab/rendimiento.js';
import { createWorld, stepWorld } from '../src/world/index.js';
import { paramsOf } from '../src/world/params.js';
import {
  AGGREGATE_BOOKS, AGGREGATE_KEYS, INTEGER_AGGREGATE_KEYS, booksFromWorld, emptyAggregateBooks, reduceAggregates,
  serialShare, type AggregateBook, type AggregateBooks, type Intent,
} from '../src/world/paralelo/agregados.js';
import { partitionRegions } from '../src/world/paralelo/particion.js';
import { TOTALS_CAP, count, saturateTotal } from '../src/world/statistics.js';
import {
  HARVEST_AMOUNT, HARVEST_INITIAL_TOTAL, HARVEST_POSITIONS, regionGroupedHarvestTotal, sequentialHarvestTotal,
} from './hardware/escenas.js';

after(async () => { await closeEcosystemWorkers(); });

/** Digestos del motor secuencial medidos en este árbol antes de cablear la reducción (1 200 pasos). */
const BASELINE_1200: Readonly<Record<number, string>> = {
  7: '94e1b21419c8cc6ebe73fe6dcb6d7a235c21b2c2052ae9b97a5532893c88840d',
  51926: '95c577d0c6690a3cedd0027da3b8130a4d05a88c2e1b9837720f24339a6bdc61',
  104729: 'd286941f9a53016689c24fdb0df452b2d1f788238eeea58f0f4f2eafbfa66c2c',
};

function same(actual: number, expected: number, label: string): void {
  assert.equal(Object.is(actual, expected), true, `${label}: ${actual} no es el mismo bit que ${expected} (delta ${actual - expected})`);
}

function intent(book: AggregateBook, key: string, actorSlot: number, secuenciaLocal: number, cantidad: number): Intent {
  return { fase: 'agregado', tipoRecurso: book, recursoId: key, actorSlot, secuenciaLocal, cantidad };
}

function readKey(books: AggregateBooks, book: AggregateBook, key: string): number {
  if (book === 'totals') return books.totals[key] ?? 0;
  if (book === 'inventionDynamics') return books.inventionDynamics[key as keyof typeof books.inventionDynamics];
  if (book === 'animalDynamics') return books.animalDynamics[key as keyof typeof books.animalDynamics];
  if (book === 'demographyDynamics') {
    if (key.startsWith('causes.')) return books.demographyDynamics.causes[key.slice('causes.'.length) as keyof typeof books.demographyDynamics.causes];
    return books.demographyDynamics[key as 'deaths' | 'foodLost' | 'woodLost' | 'stoneLost'];
  }
  const dot = key.indexOf('.');
  if (dot >= 0) {
    const parent = key.slice(0, dot) as 'imported' | 'estateLoss';
    const material = key.slice(dot + 1) as 'wood' | 'stone' | 'water';
    return books.ledger[parent][material];
  }
  return books.ledger[key as 'toolUses'];
}

function writeKey(books: AggregateBooks, book: AggregateBook, key: string, value: number): void {
  if (book === 'totals') { books.totals[key] = value; return; }
  if (book === 'inventionDynamics') { books.inventionDynamics[key as keyof typeof books.inventionDynamics] = value; return; }
  if (book === 'animalDynamics') { books.animalDynamics[key as keyof typeof books.animalDynamics] = value; return; }
  if (book === 'demographyDynamics') {
    if (key.startsWith('causes.')) books.demographyDynamics.causes[key.slice('causes.'.length) as keyof typeof books.demographyDynamics.causes] = value;
    else books.demographyDynamics[key as 'deaths'] = value;
    return;
  }
  const dot = key.indexOf('.');
  if (dot >= 0) {
    const parent = key.slice(0, dot) as 'imported' | 'estateLoss';
    const material = key.slice(dot + 1) as 'wood' | 'stone' | 'water';
    books.ledger[parent][material] = value;
    return;
  }
  (books.ledger as unknown as Record<string, number>)[key] = value;
}

/** Llegada hostil: cada worker entrega su región ya agrupada, en orden adversarial. */
function adversarialArrival(side: 256 | 512, workers: number): Intent[] {
  const byRegion = new Map<string, Intent[]>();
  HARVEST_POSITIONS.forEach((position, index) => {
    const id = `${Math.floor(position.x / side)},${Math.floor(position.y / side)}`;
    const bucket = byRegion.get(id) ?? [];
    bucket.push(intent('totals', 'foodHarvested', index + 2, 0, HARVEST_AMOUNT));
    byRegion.set(id, bucket);
  });
  const regions = [...byRegion.keys()].sort().map((id, index) => ({ id, begin: index, end: index + 1 }));
  const arrived: Intent[] = [];
  for (const queue of partitionRegions(regions, workers, 'adversarial')) {
    for (const region of queue) arrived.push(...byRegion.get(String(region.id))!);
  }
  return arrived;
}

function applyHarvest(arrival: readonly Intent[]): number {
  const books = emptyAggregateBooks();
  books.totals.foodHarvested = HARVEST_INITIAL_TOTAL;
  reduceAggregates(books, arrival);
  return books.totals.foodHarvested ?? 0;
}

test('T153: cosecha en dos regiones, 1/8/28 workers y geometrías 256/512, bits idénticos al orden por slot', () => {
  const sequential = sequentialHarvestTotal();
  for (const side of [256, 512] as const) for (const workers of [1, 8, 28]) {
    const arrival = adversarialArrival(side, workers);
    assert.notDeepEqual(arrival.map(item => item.actorSlot), [2, 3, 4, 5], `la llegada ${workers}/${side} no puede ser ya la de slot`);
    same(applyHarvest(arrival), sequential, `workers=${workers} geometría=${side}`);
    same(applyHarvest(arrival.slice().reverse()), sequential, `workers=${workers} geometría=${side} llegada invertida`);
  }
});

test('T153 negativo: sumar FP64 agrupado por región produce otro bit y la aserción lo detecta', () => {
  const sequential = sequentialHarvestTotal();
  for (const side of [256, 512] as const) {
    const grouped = regionGroupedHarvestTotal(side);
    assert.equal(Object.is(sequential, grouped), false, `la geometría ${side} tiene que mover el último bit`);
    const reduced = applyHarvest(adversarialArrival(side, 28));
    assert.equal(Object.is(reduced, sequential), true, 'la reducción canónica no puede seguir a la región');
    assert.equal(Object.is(reduced, grouped), false, 'un total agrupado por región no pasa la comparación bit a bit');
  }
});

test('T153: saturación exacta en 1e12 y junto al tope, en cada suma', () => {
  const atCap = emptyAggregateBooks();
  atCap.totals.foodHarvested = TOTALS_CAP;
  reduceAggregates(atCap, [
    intent('totals', 'foodHarvested', 0, 0, HARVEST_AMOUNT),
    intent('totals', 'foodHarvested', 1, 0, 1),
  ]);
  same(atCap.totals.foodHarvested ?? 0, TOTALS_CAP, 'ya en el tope');

  const below = emptyAggregateBooks();
  below.totals.foodHarvested = TOTALS_CAP - 1;
  reduceAggregates(below, [intent('totals', 'foodHarvested', 0, 0, 0.25)]);
  same(below.totals.foodHarvested ?? 0, TOTALS_CAP - 0.75, 'debajo del tope no se recorta');

  const touches = emptyAggregateBooks();
  touches.totals.foodHarvested = TOTALS_CAP - 1;
  reduceAggregates(touches, [intent('totals', 'foodHarvested', 0, 0, 1)]);
  same(touches.totals.foodHarvested ?? 0, TOTALS_CAP, 'el paso que llega al tope');

  // Recortar en cada suma no es lo mismo que sumar y recortar una vez: +3 pasa el tope y −0,5 ya no recupera el exceso.
  const clipped = emptyAggregateBooks();
  clipped.totals.foodHarvested = TOTALS_CAP - 1;
  reduceAggregates(clipped, [
    intent('totals', 'foodHarvested', 0, 0, 3),
    intent('totals', 'foodHarvested', 0, 1, -0.5),
  ]);
  same(clipped.totals.foodHarvested ?? 0, TOTALS_CAP - 0.5, 'saturación por suma');
  assert.equal(Object.is(clipped.totals.foodHarvested, TOTALS_CAP), false);

  const world = createWorld(1);
  world.totals.foodHarvested = 2 ** 39;
  count(world, 'foodHarvested', HARVEST_AMOUNT);
  same(world.totals.foodHarvested ?? 0, saturateTotal(2 ** 39, HARVEST_AMOUNT), 'count sigue a saturateTotal');
  world.totals.foodHarvested = TOTALS_CAP;
  count(world, 'foodHarvested', 1);
  same(world.totals.foodHarvested ?? 0, TOTALS_CAP, 'count satura en el tope');
});

test('T153: cada clave declarada suma como el camino secuencial y satura en el tope', () => {
  const integers = new Set(AGGREGATE_BOOKS.flatMap(book => INTEGER_AGGREGATE_KEYS[book].map(key => `${book}:${key}`)));
  for (const book of AGGREGATE_BOOKS) for (const key of INTEGER_AGGREGATE_KEYS[book]) {
    assert.equal(AGGREGATE_KEYS[book].includes(key), true, `${book}.${key} está declarado`);
  }
  for (const book of AGGREGATE_BOOKS) for (const key of AGGREGATE_KEYS[book]) {
    const integer = integers.has(`${book}:${key}`);
    const books = emptyAggregateBooks();
    const start = integer ? 4 : 2 ** 39;
    const amount = integer ? 1 : HARVEST_AMOUNT;
    writeKey(books, book, key, start);
    reduceAggregates(books, [intent(book, key, 3, 1, amount)]);
    same(readKey(books, book, key), saturateTotal(start, amount), `${book}.${key}`);

    const capped = emptyAggregateBooks();
    writeKey(capped, book, key, TOTALS_CAP - 1);
    reduceAggregates(capped, [intent(book, key, 0, 0, 2)]);
    same(readKey(capped, book, key), TOTALS_CAP, `${book}.${key} en el tope`);
  }
});

test('T153: el orden canónico es (actorSlot, secuenciaLocal), no el de llegada', () => {
  const amounts = [2 ** 39, 0.00003, -(2 ** 39), 0.00003];
  const forwards = amounts.map((cantidad, secuenciaLocal) => intent('totals', 'foodHarvested', 4, secuenciaLocal, cantidad));
  let expected = 0;
  for (const cantidad of amounts) expected = saturateTotal(expected, cantidad);
  const books = emptyAggregateBooks();
  reduceAggregates(books, forwards.slice().reverse());
  same(books.totals.foodHarvested ?? 0, expected, 'secuencia invertida en la llegada');
  let reversed = 0;
  for (const cantidad of amounts.slice().reverse()) reversed = saturateTotal(reversed, cantidad);
  assert.equal(Object.is(expected, reversed), false, 'el orden de secuencia tiene que ser observable');

  const mixed = emptyAggregateBooks();
  reduceAggregates(mixed, [
    intent('ledger', 'toolUses', 1, 0, 1),
    intent('inventionDynamics', 'foodTaken', 0, 1, HARVEST_AMOUNT),
    intent('totals', 'foodHarvested', 0, 0, HARVEST_AMOUNT),
    intent('animalDynamics', 'plantConsumed', 2, 0, 0.06),
    intent('demographyDynamics', 'foodLost', 0, 2, 0.2),
  ].reverse());
  same(mixed.totals.foodHarvested ?? 0, HARVEST_AMOUNT, 'totals');
  same(mixed.inventionDynamics.foodTaken, HARVEST_AMOUNT, 'foodTaken');
  same(mixed.demographyDynamics.foodLost, 0.2, 'foodLost');
  same(mixed.animalDynamics.plantConsumed, 0.06, 'plantConsumed');
  same(mixed.ledger.toolUses, 1, 'toolUses');
});

test('T153: booksFromWorld escribe los acumuladores vivos y un lote vacío no los mueve', () => {
  const world = createWorld(3);
  const food = world.totals.foodHarvested ?? 0;
  const cost = reduceAggregates(booksFromWorld(world), [
    intent('totals', 'foodHarvested', 0, 0, HARVEST_AMOUNT),
    intent('ledger', 'toolUses', 1, 0, 1),
    intent('inventionDynamics', 'foodTaken', 2, 0, 0.01),
    intent('animalDynamics', 'births', 3, 0, 1),
    intent('demographyDynamics', 'causes.starvation', 4, 0, 1),
  ]);
  same(world.totals.foodHarvested ?? 0, saturateTotal(food, HARVEST_AMOUNT), 'foodHarvested vivo');
  assert.equal(world.technology.ledger.toolUses, 1);
  assert.equal(world.inventionDynamics.foodTaken, 0.01);
  assert.equal(world.animalDynamics.births, 1);
  assert.equal(world.demographyDynamics.causes.starvation, 1);
  assert.equal(cost.eventos, 5);
  const untouched = world.totals.woodGathered;
  const empty = reduceAggregates(booksFromWorld(world), []);
  assert.equal(empty.eventos, 0);
  assert.equal(empty.ms, 0);
  assert.equal(world.totals.woodGathered, untouched);
});

test('T153: se rechaza llegada ambigua, clave ajena y cantidad no finita', () => {
  const books = emptyAggregateBooks();
  assert.throws(() => reduceAggregates(books, [
    intent('totals', 'hunts', 1, 0, 1),
    intent('totals', 'births', 1, 0, 1),
  ]), /actorSlot 1, secuenciaLocal 0/);
  assert.throws(() => reduceAggregates(books, [intent('totals', 'noExiste', 0, 0, 1)]), /no declarado/);
  assert.throws(() => reduceAggregates(books, [{ ...intent('totals', 'hunts', 0, 0, 1), cantidad: Number.NaN }]), /finito/);
  assert.throws(() => reduceAggregates(books, [intent('totals', 'hunts', -1, 0, 1)]), /actorSlot/);
  assert.equal(books.totals.hunts, 0, 'un lote rechazado no escribe');
});

test('T153: el coste de la reducción se mide con el reloj inyectado y entra en la fracción serial', () => {
  const eventos = 8_000;
  const intents: Intent[] = [];
  for (let index = 0; index < eventos; index++) intents.push(intent('totals', 'foodHarvested', eventos - 1 - index, 0, HARVEST_AMOUNT));
  const books = emptyAggregateBooks();
  books.totals.foodHarvested = HARVEST_INITIAL_TOTAL;
  const cost = reduceAggregates(books, intents, () => performance.now());
  let sequential = HARVEST_INITIAL_TOTAL;
  for (let index = 0; index < eventos; index++) sequential = saturateTotal(sequential, HARVEST_AMOUNT);
  same(books.totals.foodHarvested ?? 0, sequential, '8 000 cosechas sobre 2^39');
  assert.equal(cost.eventos, eventos);
  assert.equal(Number.isFinite(cost.ms) && cost.ms >= 0, true);
  const share = serialShare(cost, 100);
  assert.equal(Number.isFinite(share) && share >= 0, true);
  assert.throws(() => serialShare(cost, 0), /presupuesto/);
});

test('T153: con particionarPersonas=false el digesto de 1 200 pasos es el baseline', () => {
  for (const seed of [7, 51926, 104729]) {
    const world = createWorld(seed);
    assert.equal(paramsOf(world).motor.particionarPersonas, false);
    for (let step = 0; step < 1200; step++) stepWorld(world);
    assert.equal(digestoSin(world, ['poblacion.natalidadVecindad', 'poblacion.radioVecindadNatalidad', 'conducta.politicaPeso'], 11), BASELINE_1200[seed], `semilla ${seed}`);
  }
});
