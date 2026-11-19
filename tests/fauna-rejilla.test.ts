import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tile } from '../src/shared/types.js';
import {
  animalesVivosEnCelda, animalMovido, conRejillaFauna, harvestAt, materializeAnimals,
  sinRejillaFaunaParaPruebas, syncFauna, type Animal, type AnimalWorld,
} from '../src/world/animals.js';
import { createWorld, stepWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';

/** Generador determinista para la suite (nada de azar real). */
function lcg(seed: number): (n: number) => number {
  let x = seed >>> 0;
  return n => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x % n; };
}
function tile(x: number, y: number, overrides: Partial<Tile> = {}): Tile {
  return { x, y, terrain: 'meadow', biome: 'grassland', moisture: 0.8, vegetation: 0.8, growth: 0.8,
    food: 0.2, fauna: 0, drinkingWater: 0.8, fertility: 0.6, ...overrides };
}
function mundo(tiles: Tile[], animals: Animal[]): AnimalWorld {
  syncFauna(tiles, animals);
  return { seed: 42, tick: 0, tiles, animals, animalCounter: 0, reproductionEnabled: false,
    animalDynamics: { births: 0, deaths: 0, predations: 0, humanHunts: 0, waterConsumed: 0, plantConsumed: 0 } };
}
/** Fauna determinista con coordenadas negativas y hasta 6 animales por celda. */
function manada(celdas = 24): AnimalWorld {
  const r = lcg(987654);
  const tiles: Tile[] = [];
  for (let y = -celdas; y < celdas; y++) for (let x = -celdas; x < celdas; x++)
    tiles.push(tile(x, y, { fauna: r(7), species: 'hare' }));
  return mundo(tiles, materializeAnimals(42, tiles, 0));
}
const lineal = (w: AnimalWorld, x: number, y: number): Animal[] =>
  w.animals.filter(a => a.x === x && a.y === y && a.health > 0);

test('animalesVivosEnCelda ≡ filter en orden de slot: negativas, varias por celda y muertas', () => {
  const w = manada();
  assert.ok(w.animals.length > 5000, `manada de ${w.animals.length}`);
  // Algunas muertas: el filtro las excluye y la rejilla evalúa la salud en vivo.
  for (let i = 0; i < w.animals.length; i += 97) w.animals[i]!.health = 0;
  const r = lcg(51926);
  conRejillaFauna(w, () => {
    for (let n = 0; n < 3000; n++) {
      const x = r(61) - 30, y = r(61) - 30;
      const esperado = lineal(w, x, y), obtenido = animalesVivosEnCelda(w, x, y);
      assert.ok(obtenido, 'dentro del ámbito la rejilla responde');
      assert.equal(obtenido.length, esperado.length, `celda ${x},${y}`);
      assert.ok(obtenido.every((a, i) => a === esperado[i]), `orden de slot en ${x},${y}`);
    }
    // Fuera del rango poblado y en celdas vacías: mismo resultado (vacío).
    assert.deepEqual(animalesVivosEnCelda(w, 500, -500), lineal(w, 500, -500));
    // Movimiento notificado como hace `move`: la celda origen se vacía y la destino se llena en orden.
    const movil = w.animals.find(a => a.health > 0)!;
    const ox = movil.x, oy = movil.y;
    movil.x = ox + 3; movil.y = oy - 2; animalMovido(w, movil);
    assert.ok(!animalesVivosEnCelda(w, ox, oy)!.includes(movil));
    assert.ok(animalesVivosEnCelda(w, movil.x, movil.y)!.every((a, i, xs) => i === 0 || w.animals.indexOf(xs[i - 1]!) < w.animals.indexOf(a)));
    assert.deepEqual(animalesVivosEnCelda(w, movil.x, movil.y), lineal(w, movil.x, movil.y));
    // Nacimiento anexado al final del arreglo: visible sin reconstruir.
    const cria: Animal = { ...movil, id: 'animal-born-42-0-999999', health: 1 };
    w.animals.push(cria);
    assert.deepEqual(animalesVivosEnCelda(w, cria.x, cria.y), lineal(w, cria.x, cria.y));
    // Cosecha (reemplaza el arreglo y refresca el ámbito): la siguiente consulta sigue exacta.
    const celda = w.animals.find(a => a.health > 0 && lineal(w, a.x, a.y).length > 1)!;
    harvestAt(w, celda, 'persona-1');
    assert.deepEqual(animalesVivosEnCelda(w, celda.x, celda.y), lineal(w, celda.x, celda.y));
  });
  // Fuera del ámbito no hay rejilla: el llamador debe caer al recorrido lineal.
  assert.equal(animalesVivosEnCelda(w, 0, 0), undefined);
  conRejillaFauna(w, () => sinRejillaFaunaParaPruebas(w, () => {
    assert.equal(animalesVivosEnCelda(w, 0, 0), undefined);
  }));
});

test('la víctima de caza por rejilla es la del filter+sort: menor id, desempate por slot', () => {
  const w = manada(6);
  conRejillaFauna(w, () => {
    for (const a of w.animals) {
      const enCelda = animalesVivosEnCelda(w, a.x, a.y)!;
      if (enCelda.length < 2) continue;
      const porRejilla = enCelda.reduce((m, c) => c.id < m.id ? c : m);
      const porLineal = lineal(w, a.x, a.y).sort((p, q) => p.id < q.id ? -1 : p.id > q.id ? 1 : 0)[0]!;
      assert.equal(porRejilla, porLineal);
      return;
    }
    assert.fail('la manada debe tener una celda con al menos dos animales vivos');
  });
});

/** Digestos base (código anterior a la rejilla) tras 1 200 pasos, semillas del encargo. */
const BASE_1200: Readonly<Record<number, string>> = {
  7: '94e1b21419c8cc6ebe73fe6dcb6d7a235c21b2c2052ae9b97a5532893c88840d',
  42: 'b12d70edacdef79d428660728577f9544239d636a242a0bdf8c69e1b0dd869ff',
  51926: '95c577d0c6690a3cedd0027da3b8130a4d05a88c2e1b9837720f24339a6bdc61',
};
test('digestoCanonico tras 1 200 pasos es bit a bit el base en semillas 7, 42 y 51926', { timeout: 600_000 }, () => {
  for (const seed of [7, 42, 51926]) {
    const w = createWorld(seed);
    for (let i = 0; i < 1200; i++) stepWorld(w);
    assert.equal(digestoCanonico(w), BASE_1200[seed], `semilla ${seed}`);
  }
});

test('paridad con muchos animales: rejilla y recorrido lineal dan el mismo digesto', { timeout: 600_000 }, () => {
  const poblado = (): World => {
    const w = createWorld(51926);
    for (let i = 0; i < 1200; i++) stepWorld(w);
    return w;
  };
  const conRejilla = poblado();
  assert.ok(conRejilla.animals.length >= 50, `fauna viva: ${conRejilla.animals.length}`);
  const sinRejilla = poblado();
  for (let i = 0; i < 240; i++) {
    stepWorld(conRejilla);
    sinRejillaFaunaParaPruebas(sinRejilla, () => stepWorld(sinRejilla));
  }
  assert.equal(digestoCanonico(sinRejilla), digestoCanonico(conRejilla));
});

test('microbenchmark P=1 000 consultas contra A=2 000 animales: la rejilla gana al filtro', { timeout: 120_000 }, () => {
  const tiles: Tile[] = [];
  for (let y = -25; y < 25; y++) for (let x = -20; x < 20; x++) tiles.push(tile(x, y, { fauna: 1, species: 'hare' }));
  const w = mundo(tiles.slice(0, 2000), materializeAnimals(42, tiles.slice(0, 2000), 0));
  assert.equal(w.animals.length, 2000);
  const consultas: [number, number][] = Array.from({ length: 1000 }, (_, i) => [w.animals[i * 2]!.x, w.animals[i * 2]!.y]);
  const rondas = 30;
  const medir = (fn: () => void): number => {
    fn(); // calentamiento
    const t0 = performance.now();
    for (let r = 0; r < rondas; r++) fn();
    return (performance.now() - t0) / rondas;
  };
  let halladosLineal = 0, halladosRejilla = 0;
  const msLineal = medir(() => { halladosLineal = 0; for (const [x, y] of consultas) halladosLineal += lineal(w, x, y).length; });
  const msRejilla = conRejillaFauna(w, () => medir(() => {
    halladosRejilla = 0;
    for (const [x, y] of consultas) halladosRejilla += animalesVivosEnCelda(w, x, y)!.length;
  }));
  assert.equal(halladosRejilla, halladosLineal);
  assert.ok(msRejilla < msLineal, `rejilla ${msRejilla.toFixed(3)} ms/ronda < lineal ${msLineal.toFixed(3)} ms/ronda`);
});
