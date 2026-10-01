import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tile } from '../src/shared/types.js';
import { harvestAt, materializeAnimals, stepAnimals, syncFauna, type Animal, type AnimalEmitter, type AnimalWorld } from '../src/world/animals.js';
import { FOOD_PER_ANIMAL } from '../src/world/ecosystem.js';
import { conIndiceFauna, faunaEn, retirarFauna } from '../src/world/indice-fauna.js';

interface Punto { x: number; y: number }
function tile(x = 0, y = 0): Tile {
  return { x, y, terrain: 'meadow', biome: 'grassland', moisture: .8, vegetation: .8, growth: .8,
    food: .2, fauna: 0, drinkingWater: .8, fertility: .6 };
}
function animal(id: string, x = 0, y = 0, health = 1): Animal {
  const fixture = materializeAnimals(42, [{ ...tile(), fauna: 1, species: 'hare' }], 0)[0]!;
  return { ...fixture, id, x, y, health, target: { x, y } };
}
function world(animals: Animal[], tiles: Tile[] = [tile(), tile(1), tile(2)]): AnimalWorld {
  syncFauna(tiles, animals);
  return { seed: 42, tick: 0, animals, tiles, animalCounter: 0, reproductionEnabled: false,
    animalDynamics: { births: 0, deaths: 0, predations: 0, humanHunts: 0, waterConsumed: 0, plantConsumed: 0 } };
}
const canonical = (a: Animal, b: Animal): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const literal = (w: { animals: Animal[] }, p: Punto): Animal[] => w.animals.filter(a => a.x === p.x && a.y === p.y && a.health > 0);
function mismasIdentidades(actual: Animal[], esperado: Animal[]): void {
  assert.equal(actual.length, esperado.length);
  actual.forEach((a, i) => assert.strictEqual(a, esperado[i]));
}
/** El harvestAt literal de MAIN, incluida la posición del emisor antes del filter. */
function cosechaLiteral(w: AnimalWorld, p: Punto, hunter: string, emit?: AnimalEmitter): number {
  const victim = w.animals.filter(a => a.x === p.x && a.y === p.y && a.health > 0).sort(canonical)[0];
  if (!victim || !w.tiles.some(t => t.x === p.x && t.y === p.y)) return 0;
  victim.health = 0; w.animalDynamics.deaths++;
  emit?.({ kind: 'animal', actors: [hunter, victim.id], x: victim.x, y: victim.y,
    text: `${victim.species} ${victim.id} muere por caza humana.`, cause: 'caza humana', source: 'simulation' });
  w.animalDynamics.humanHunts++;
  w.animals = w.animals.filter(a => a.id !== victim.id); syncFauna(w.tiles, w.animals);
  return FOOD_PER_ANIMAL[victim.species];
}

test('el filtro dentro y fuera del ámbito conserva identidades, salud y orden estable de IDs repetidos', () => {
  const first = animal('igual'), second = animal('igual'), w = { animals: [animal('z'), second, animal('muerto', 0, 0, 0),
    animal('a'), first, animal('lejos', 1), animal('negativo', 0, 0, -1), animal('nan', 0, 0, NaN)] };
  const comprobar = (): void => {
    mismasIdentidades(faunaEn(w, { x: 0, y: 0 }), literal(w, { x: 0, y: 0 }));
    mismasIdentidades(faunaEn(w, { x: 0, y: 0 }).sort(canonical), literal(w, { x: 0, y: 0 }).sort(canonical));
    assert.strictEqual(faunaEn(w, { x: 0, y: 0 }).sort(canonical)[1], second);
  };
  comprobar(); conIndiceFauna(w, comprobar);
});

test('coordenadas ±0, NaN, fracciones e infinitos coinciden con la igualdad estricta literal', () => {
  const points = [{ x: 0, y: -0 }, { x: -0, y: 0 }, { x: NaN, y: 0 }, { x: 0, y: NaN },
    { x: Infinity, y: -Infinity }, { x: .125, y: .25 }, { x: -.125, y: -.25 }];
  const w = { animals: points.flatMap((p, i) => [animal(`a${i}`, p.x, p.y), animal(`b${i}`, p.x, p.y, 0)]) };
  conIndiceFauna(w, () => {
    for (const p of [...points, { x: 500, y: 500 }]) mismasIdentidades(faunaEn(w, p), literal(w, p));
  });
});

test('la salud se lee en cada consulta y el resultado devuelto no puede reordenar el índice', () => {
  const a = animal('z'), b = animal('a'), w = { animals: [a, b] }, p = { x: 0, y: 0 };
  conIndiceFauna(w, () => {
    faunaEn(w, p).sort(canonical).pop();
    mismasIdentidades(faunaEn(w, p), [a, b]);
    a.health = 0; mismasIdentidades(faunaEn(w, p), [b]);
    a.health = .5; b.health = 0; mismasIdentidades(faunaEn(w, p), [a]);
  });
});

test('el índice es lazy, comparte ámbitos anidados y no reconstruye fauna distante tras una retirada propia', () => {
  const distant = animal('distante', 2), w = { animals: [animal('a'), animal('b'), distant] };
  let lecturas = 0;
  Object.defineProperty(distant, 'x', { configurable: true, get: () => { lecturas++; return 2; } });
  assert.equal(conIndiceFauna(w, () => 17), 17); assert.equal(lecturas, 0);
  conIndiceFauna(w, () => {
    faunaEn(w, { x: 0, y: 0 }); const construccion = lecturas;
    assert.ok(construccion > 0);
    conIndiceFauna(w, () => mismasIdentidades(faunaEn(w, { x: 0, y: 0 }), w.animals.slice(0, 2)));
    assert.throws(() => conIndiceFauna(w, () => { throw new Error('anidado'); }), /anidado/);
    retirarFauna(w, 'a');
    mismasIdentidades(faunaEn(w, { x: 0, y: 0 }), [w.animals[0]!]);
    assert.equal(lecturas, construccion, 'ninguna consulta o retirada vuelve a leer la coordenada distante');
  });
  faunaEn(w, { x: 0, y: 0 }); assert.ok(lecturas > 0);
});

test('push, splice y reemplazo de igual longitud invalidan desde la fuente real', () => {
  const a = animal('a'), b = animal('b'), c = animal('c', 1), w = { animals: [a, c] }, p = { x: 0, y: 0 };
  conIndiceFauna(w, () => {
    mismasIdentidades(faunaEn(w, p), [a]);
    w.animals.push(b); mismasIdentidades(faunaEn(w, p), literal(w, p));
    w.animals.splice(0, 1); mismasIdentidades(faunaEn(w, p), literal(w, p));
    w.animals = [a, animal('nuevo', 2)]; mismasIdentidades(faunaEn(w, p), literal(w, p));
    retirarFauna(w, 'a'); mismasIdentidades(faunaEn(w, p), []);
  });
});

test('retirar un ID elimina sus duplicados en todas las coordenadas preservando el resto del orden', () => {
  const keep = [animal('z'), animal('a'), animal('otro', 1)], w = { animals: [animal('igual'), keep[0]!,
    animal('igual', 1), keep[1]!, animal('igual', 0, 0, 0), keep[2]!, animal('igual', NaN, 0)] };
  conIndiceFauna(w, () => {
    faunaEn(w, { x: 0, y: 0 });
    retirarFauna(w, 'igual'); mismasIdentidades(w.animals, keep);
    for (const p of [{ x: 0, y: 0 }, { x: 1, y: 0 }]) mismasIdentidades(faunaEn(w, p), literal(w, p));
  });
});

test('una excepción retira el ámbito y la reentrada posterior lee las nuevas coordenadas', () => {
  const a = animal('a'), w = { animals: [a] };
  assert.throws(() => conIndiceFauna(w, () => { faunaEn(w, { x: 0, y: 0 }); throw new Error('fallo'); }), /fallo/);
  a.x = 1;
  mismasIdentidades(faunaEn(w, { x: 1, y: 0 }), [a]);
  conIndiceFauna(w, () => { mismasIdentidades(faunaEn(w, { x: 1, y: 0 }), [a]); mismasIdentidades(faunaEn(w, { x: 0, y: 0 }), []); });
});

test('dos mundos anidados mantienen índices y limpiezas independientes', () => {
  const a = { animals: [animal('a')] }, b = { animals: [animal('b', 1)] };
  conIndiceFauna(a, () => {
    faunaEn(a, { x: 0, y: 0 });
    conIndiceFauna(b, () => { mismasIdentidades(faunaEn(b, { x: 1, y: 0 }), b.animals); retirarFauna(a, 'a'); });
    mismasIdentidades(faunaEn(a, { x: 0, y: 0 }), []);
  });
});

test('cazas sucesivas del mismo paso coinciden con MAIN en alimento, eventos, fauna y dinámica', () => {
  const w = world([animal('z'), animal('a'), animal('igual'), animal('igual', 1), animal('b')]), reference = structuredClone(w);
  const events: unknown[] = [], expected: unknown[] = [], p = { x: 0, y: 0 };
  conIndiceFauna(w, () => {
    for (let n = 0; n < 6; n++) {
      assert.equal(harvestAt(w, p, `hunter-${n}`, e => events.push(e)), cosechaLiteral(reference, p, `hunter-${n}`, e => expected.push(e)));
      assert.deepEqual(w, reference); assert.deepEqual(events, expected);
      mismasIdentidades(faunaEn(w, p), literal(w, p));
    }
  });
  assert.equal(w.animalDynamics.humanHunts, 4);
});

test('harvestAt fuera de un ámbito conserva el contrato literal, incluso sin tesela o víctima viva', () => {
  const w = world([animal('a'), animal('b', 1)]), reference = structuredClone(w), events: unknown[] = [], expected: unknown[] = [];
  w.tiles.pop(); reference.tiles.pop(); w.tiles.shift(); reference.tiles.shift();
  for (const p of [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }]) {
    assert.equal(harvestAt(w, p, 'hunter', e => events.push(e)), cosechaLiteral(reference, p, 'hunter', e => expected.push(e)));
    assert.deepEqual(w, reference); assert.deepEqual(events, expected);
  }
});

test('un emisor que reemplaza o amplía fauna obliga a reconstruir después de la retirada', () => {
  for (const mutate of [(w: AnimalWorld): void => { w.animals = [animal('a'), animal('nuevo')]; },
    (w: AnimalWorld): void => { w.animals.push(animal('nuevo')); }]) {
    const w = world([animal('a'), animal('z')]), reference = structuredClone(w);
    const events: unknown[] = [], expected: unknown[] = [];
    conIndiceFauna(w, () => {
      faunaEn(w, { x: 0, y: 0 });
      assert.equal(harvestAt(w, { x: 0, y: 0 }, 'hunter', e => { events.push(e); mutate(w); }),
        cosechaLiteral(reference, { x: 0, y: 0 }, 'hunter', e => { expected.push(e); mutate(reference); }));
      mismasIdentidades(faunaEn(w, { x: 0, y: 0 }), literal(w, { x: 0, y: 0 }));
      assert.equal(harvestAt(w, { x: 0, y: 0 }, 'segundo', e => events.push(e)),
        cosechaLiteral(reference, { x: 0, y: 0 }, 'segundo', e => expected.push(e)));
      assert.deepEqual(w, reference); assert.deepEqual(events, expected);
    });
  }
});

test('un emisor reentrante observa la salud cero antes del filter y actualiza el mismo índice', () => {
  const w = world([animal('a'), animal('b'), animal('c')]), reference = structuredClone(w);
  const events: unknown[] = [], expected: unknown[] = [], p = { x: 0, y: 0 };
  conIndiceFauna(w, () => {
    const actual = harvestAt(w, p, 'primero', e => {
      events.push(e); mismasIdentidades(faunaEn(w, p), literal(w, p));
      conIndiceFauna(w, () => harvestAt(w, p, 'reentrante', inner => events.push(inner)));
    });
    const result = cosechaLiteral(reference, p, 'primero', e => {
      expected.push(e); cosechaLiteral(reference, p, 'reentrante', inner => expected.push(inner));
    });
    assert.equal(actual, result); assert.deepEqual(w, reference); assert.deepEqual(events, expected);
    mismasIdentidades(faunaEn(w, p), literal(w, p));
    assert.equal(harvestAt(w, p, 'tercero'), cosechaLiteral(reference, p, 'tercero'));
    assert.deepEqual(w, reference);
  });
});

test('un fallo del emisor conserva los efectos parciales literales y limpia el ámbito exterior', () => {
  const w = world([animal('a'), animal('b')]), reference = structuredClone(w), p = { x: 0, y: 0 };
  assert.throws(() => conIndiceFauna(w, () => harvestAt(w, p, 'hunter', () => { throw new Error('emisor'); })), /emisor/);
  assert.throws(() => cosechaLiteral(reference, p, 'hunter', () => { throw new Error('emisor'); }), /emisor/);
  assert.deepEqual(w, reference);
  w.animals[1]!.x = 1; mismasIdentidades(faunaEn(w, { x: 1, y: 0 }), [w.animals[1]!]);
});

test('el movimiento real de stepAnimals entre pasos no deja un índice de la celda anterior', () => {
  const a = animal('a'), w = world([a]); a.lastDecision = 0; a.lastMove = -12; a.target = { x: 1, y: 0 };
  conIndiceFauna(w, () => mismasIdentidades(faunaEn(w, { x: 0, y: 0 }), [a]));
  w.tick = 1; stepAnimals(w); assert.equal(a.x, 1);
  conIndiceFauna(w, () => {
    mismasIdentidades(faunaEn(w, { x: 0, y: 0 }), []);
    mismasIdentidades(faunaEn(w, { x: 1, y: 0 }), [a]);
  });
});
