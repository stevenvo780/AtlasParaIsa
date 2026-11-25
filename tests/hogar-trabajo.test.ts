import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, tileAt, type World } from '../src/world/index.js';
import { digestoSin } from '../scripts/lab/rendimiento.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, parseParams } from '../src/world/params.js';
import { settlementOpportunity } from '../src/world/society.js';

// Medidos en un checkout temporal detached de main 2ee2658, con createWorld(seed),
// 1200 llamadas a stepWorld y digestoCanonico, antes de declarar social.hogarTrabajo.
// V23: re-grabados en un hilo y sin GPU al quitar los topes de fauna (M2a, 1aae52f), que cambia el mundo a propósito;
// los valores anteriores pasaron sin cambios hasta 98e750c (sprint/v23l-motor).
const REFERENCIAS_1200 = {
  42: '126b7daa73d7920f81460fc1e6e8e2cd404134a0ffe09b413a57bbebbb4d48c3',
  2001: 'e1f561925d68dd610c6e136724cb66cda643e78356cedc2a2c653e60e26e363a',
} as const;

for (const seed of [42, 2001] as const) test(`H-B apagada conserva el mundo de referencia: semilla ${seed}`, { timeout: 600000 }, () => {
  assert.equal(DEFAULT_PARAMS.social.hogarTrabajo, 0);
  assert.equal(HISTORICAL_PARAMS.social.hogarTrabajo, 0);
  const world = createWorld(seed);
  for (let n = 0; n < 1200; n++) stepWorld(world);
  // La clave nueva sólo se quita de la FORMA hasheada, no del mundo simulado.
  // La poda ola 1 retiró las demás claves posteriores a 2ee2658; H-B, COM-D′ (`social.disolucion`,
  // `sprint/com-d-20260928`) y Fase B (`tecnologia.*`, `sprint/estabilidad-fase-b-20261118`) siguen
  // declarándose en sus valores históricos (no actúan).
  assert.deepEqual(DEFAULT_PARAMS.tecnologia, HISTORICAL_PARAMS.tecnologia);
  assert.equal(digestoSin(world, ['social.hogarTrabajo', 'social.disolucion', 'tecnologia', 'poblacion.natalidadVecindad', 'poblacion.radioVecindadNatalidad', 'conducta.politicaPeso'], 11), REFERENCIAS_1200[seed]);
});

function escenaHogar(r: number, abundanteEnCasa = false): World {
  const world = createWorld(42, parseParams(`social.hogarTrabajo=${r}`));
  const person = world.people[2]!;
  person.x = 19; person.y = 13;
  person.home = { x: 17, y: 13, quality: 0.45, observedAt: world.tick };
  person.hunger = person.thirst = 0.1;
  person.socialLoad = 0;
  for (const other of world.people) if (other !== person) { other.x = 40; other.y = 25; }
  world.places = [
    { ...world.places[0]!, x: 17, y: 13 },
    { ...world.places[1]!, x: 22, y: 13 },
  ];
  world.structures = [];
  for (const tile of world.tiles) {
    tile.food = 0.2; tile.drinkingWater = 0.2;
    tile.wood = tile.stone = tile.fauna = 0;
  }
  // (26,13) está a cuatro celdas del lugar visible y a nueve del hogar.
  tileAt(world, { x: 26, y: 13 })!.stone = 12;
  if (abundanteEnCasa) tileAt(world, { x: 13, y: 13 })!.wood = 12;
  return world;
}

test('H-B cambia un hogar agotado por un lugar visible con trabajo; apagada conserva la elección', () => {
  const apagado = escenaHogar(0), activo = escenaHogar(1);
  settlementOpportunity(apagado, apagado.people[2]!);
  settlementOpportunity(activo, activo.people[2]!);
  assert.deepEqual(apagado.people[2]!.home && { x: apagado.people[2]!.home.x, y: apagado.people[2]!.home.y }, { x: 17, y: 13 });
  assert.deepEqual(activo.people[2]!.home && { x: activo.people[2]!.home.x, y: activo.people[2]!.home.y }, { x: 22, y: 13 });
});

test('H-B satura el trabajo abundante y conserva el hogar', () => {
  const apagado = escenaHogar(0, true), activo = escenaHogar(1, true);
  settlementOpportunity(apagado, apagado.people[2]!);
  settlementOpportunity(activo, activo.people[2]!);
  assert.equal(activo.people[2]!.home?.x, 17);
  assert.equal(activo.people[2]!.home?.quality, apagado.people[2]!.home?.quality);
});

test('H-B sólo admite r entre cero y uno', () => {
  assert.equal(parseParams('social.hogarTrabajo=0').social.hogarTrabajo, 0);
  assert.equal(parseParams('social.hogarTrabajo=1').social.hogarTrabajo, 1);
  assert.throws(() => parseParams('social.hogarTrabajo=-0.001'));
  assert.throws(() => parseParams('social.hogarTrabajo=1.001'));
});
