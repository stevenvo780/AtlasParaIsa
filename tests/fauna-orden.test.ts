import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tile } from '../src/shared/types.js';
import { materializeAnimals, stepAnimals, syncFauna, type Animal, type AnimalWorld } from '../src/world/animals.js';

function tile(x = 0, y = 0, overrides: Partial<Tile> = {}): Tile {
  return { x, y, terrain: 'meadow', biome: 'grassland', moisture: 0.8, vegetation: 0.8, growth: 0.8,
    food: 0.2, fauna: 0, drinkingWater: 0.8, fertility: 0.6, ...overrides };
}
function world(tiles: Tile[], animals: Animal[]): AnimalWorld {
  syncFauna(tiles, animals);
  return { seed: 42, tick: 0, tiles, animals, animalCounter: 0, reproductionEnabled: false,
    animalDynamics: { births: 0, deaths: 0, predations: 0, humanHunts: 0, waterConsumed: 0, plantConsumed: 0 } };
}
const canonicalId = (a: { id: string }, b: { id: string }): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function mundoVivo(): AnimalWorld {
  const count = 128;
  const tiles = Array.from({ length: count }, (_, x) => tile(x, 0, { fauna: 1, species: 'hare' }));
  const animals = materializeAnimals(42, tiles, 0);
  const prey = animals[0]!, wolf = animals[1]!, fox = animals[2]!, mateA = animals[3]!, mateB = animals[4]!;
  prey.energy = 0.05; // exhausta: no puede huir, así la caza termina en depredación
  wolf.species = 'wolf'; wolf.genes.carnivory = 0.96; wolf.hunger = 0.85;
  wolf.x = prey.x; wolf.y = prey.y; wolf.target = { x: prey.x, y: prey.y };
  fox.species = 'fox'; fox.genes.carnivory = 0.85; fox.hunger = 0.85;
  fox.x = prey.x + 1; fox.y = prey.y; fox.target = { x: prey.x + 1, y: prey.y };
  mateA.species = 'deer'; mateB.species = 'deer';
  mateB.x = mateA.x; mateB.y = mateA.y; mateB.target = { x: mateA.x, y: mateA.y };
  animals[100]!.thirst = 0.99; animals[100]!.health = 0.0005;
  const w = world(tiles, animals); w.reproductionEnabled = true;
  return w;
}

/** Generador determinista para los tests de propiedades (nada de azar real en la suite). */
function lcg(seed: number): (n: number) => number {
  let x = seed >>> 0;
  return n => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x % n; };
}
/** Copia profunda que comparte las cadenas, como `cloneState` de `cloneWorld` (motor.clonPorPaso). */
function clonar<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clonar) as T;
  const copia: Record<string, unknown> = {};
  for (const k in v) copia[k] = clonar((v as Record<string, unknown>)[k]);
  return copia as T;
}
const mismoArreglo = (a: readonly Animal[], b: readonly Animal[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

test('clonar el mundo en cada paso (motor.clonPorPaso) o alternar dos mundos da el mismo resultado', () => {
  const pasos = 40, correr = (w: AnimalWorld, clonarCadaPaso: boolean, entre?: () => void): { w: AnimalWorld; eventos: unknown[] } => {
    const eventos: unknown[] = [];
    for (let n = 0; n < pasos; n++) {
      if (clonarCadaPaso) w = clonar(w);
      w.tick++; stepAnimals(w, e => eventos.push(e));
      assert.ok(mismoArreglo(w.animals, [...w.animals].sort(canonicalId)));
      entre?.();
    }
    return { w, eventos };
  };
  const persistente = correr(mundoVivo(), false);
  assert.ok(persistente.w.animalDynamics.births > 0 && persistente.w.animalDynamics.deaths > 0, JSON.stringify(persistente.w.animalDynamics));
  const huella = JSON.stringify(persistente.w), eventos = JSON.stringify(persistente.eventos);
  const clonado = correr(mundoVivo(), true);
  assert.equal(JSON.stringify(clonado.w), huella); assert.equal(JSON.stringify(clonado.eventos), eventos);
  const otro = mundoVivo();
  otro.seed = 7; for (const a of otro.animals) a.id = a.id.replace('animal-42', 'animal-7');
  for (const clonarCadaPaso of [false, true]) {
    const alterno = correr(mundoVivo(), clonarCadaPaso, () => { otro.tick++; stepAnimals(otro); });
    assert.equal(JSON.stringify(alterno.w), huella); assert.equal(JSON.stringify(alterno.eventos), eventos);
  }
});

test('con crías y el mundo clonado en cada paso, desordenar la fauna entre pasos da lo mismo que ordenarla', () => {
  const pasos = 40, correr = (clonarCadaPaso: boolean): { w: AnimalWorld; eventos: unknown[] } => {
    const r = lcg(51926), eventos: unknown[] = [];
    let w = mundoVivo();
    for (let n = 0; n < pasos; n++) {
      if (clonarCadaPaso) w = clonar(w);
      const xs = w.animals, a = r(xs.length - 1), largo = 2 + r(6);
      if (r(3) === 0) [xs[a], xs[a + 1]] = [xs[a + 1]!, xs[a]!];              // vecinos intercambiados
      else if (r(2) === 0) xs.splice(a, largo, ...xs.slice(a, a + largo).reverse()); // tramo invertido
      if (!clonarCadaPaso) xs.sort(canonicalId);
      w.tick++; stepAnimals(w, e => eventos.push(e));
    }
    return { w, eventos };
  };
  const clonado = correr(true), control = correr(false);
  assert.ok(control.w.animalDynamics.births > 0, JSON.stringify(control.w.animalDynamics));
  assert.equal(JSON.stringify(clonado.w), JSON.stringify(control.w));
  assert.equal(JSON.stringify(clonado.eventos), JSON.stringify(control.eventos));
});

test('una fauna reordenada en sitio entre pasos no pasa por ordenada', () => {
  const w = mundoVivo();
  for (let n = 0; n < 3; n++) { w.tick++; stepAnimals(w); }
  const mutaciones: ((xs: Animal[]) => void)[] = [xs => xs.reverse(), xs => { [xs[10], xs[20]] = [xs[20]!, xs[10]!]; }, xs => { xs[5] = xs.pop()!; xs.push(xs[6]!); xs[6] = xs[xs.length - 2]!; }];
  for (const mutar of mutaciones) {
    const control = structuredClone(w), eventos: unknown[] = [], eventosControl: unknown[] = [];
    mutar(w.animals); mutar(control.animals);
    control.animals.sort(canonicalId);
    assert.equal(w.animals.length, control.animals.length);
    w.tick++; control.tick++;
    stepAnimals(w, e => eventos.push(e)); stepAnimals(control, e => eventosControl.push(e));
    assert.equal(JSON.stringify(w), JSON.stringify(control)); assert.equal(JSON.stringify(eventos), JSON.stringify(eventosControl));
  }
});
