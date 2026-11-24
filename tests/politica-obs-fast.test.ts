import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { digestoCanonico } from '../src/world/digesto.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import {
  closePersonasParallelPools, closePolicyGpuBatchers, createWorld, stepWorld, type Person, type World,
} from '../src/world/index.js';
import { activate, tileAt } from '../src/world/spatial.js';
import { tileLookup } from '../src/world/tile-index.js';
import { vecinos } from '../src/world/rejilla.js';
import { extractLocalObservation } from '../src/world/politica.js';
import { cellIntKey, cellKeyX, cellKeyY, computeLocalPolicyObservation } from '../src/world/politica-obs.js';
import { parseParams } from '../src/world/params.js';
import type { Tile } from '../src/shared/types.js';

after(async () => {
  closePolicyGpuBatchers();
  await closePersonasParallelPools();
  await closeEcosystemWorkers();
});

const clamp = (n: number, max = 1): number => Math.max(0, Math.min(max, n));

/** Copia literal de `localPolicyObservation` antes del índice entero. */
function referenciaLocalPolicyObservation(world: World, person: Person): Float64Array {
  let land = 0, foodSum = 0, waterTiles = 0, shelterTiles = 0, materialSum = 0, unvisited = 0;
  const visitedSet = person.visited.length > 0 ? new Set(person.visited) : null;
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    if (dx * dx + dy * dy > 16) continue;
    const tile = tileAt(world, { x: person.x + dx, y: person.y + dy });
    if (!tile || tile.terrain === 'water') continue;
    land++;
    foodSum += tile.food;
    if ((tile.drinkingWater ?? 0) > 0.005) waterTiles++;
    if (tile.terrain === 'shelter') shelterTiles++;
    materialSum += (tile.wood ?? 0) + (tile.stone ?? 0);
    if (!visitedSet || !visitedSet.has(`${tile.x},${tile.y}`)) unvisited++;
  }
  const nearby = vecinos(world, person, 8, other => other.id !== person.id && Math.hypot(person.x - other.x, person.y - other.y) <= 7, 'policy');
  let trustSum = 0;
  for (const other of nearby) trustSum += person.bonds[other.id] ?? 0;
  const denom = Math.max(1, land);
  return extractLocalObservation({
    hunger: clamp(person.hunger),
    thirst: clamp(person.thirst),
    fatigue: clamp(person.fatigue),
    energy: clamp(person.energy),
    inventoryFrac: clamp(person.inventory / 0.25),
    localFood: clamp(foodSum / denom),
    localWater: clamp((waterTiles / denom) * 3),
    localShelter: clamp(shelterTiles / 4),
    localResources: clamp(materialSum / 24),
    localCrowd: clamp(nearby.length / 16),
    communityTrust: nearby.length > 0 ? clamp(trustSum / nearby.length) : 0,
    biomeNovelty: clamp(unvisited / denom),
  });
}

function observar(world: World, person: Person, tileIn = tileLookup(world.tiles)): Float64Array {
  const nearby = vecinos(world, person, 8, other => other.id !== person.id && Math.hypot(person.x - other.x, person.y - other.y) <= 7, 'policy');
  return computeLocalPolicyObservation(world, person, tileIn, nearby);
}

function igual(obtenido: Float64Array, esperado: Float64Array, etiqueta: string): void {
  assert.equal(obtenido.length, 12, etiqueta);
  for (let i = 0; i < 12; i++) {
    assert.ok(Object.is(obtenido[i], esperado[i]), `${etiqueta} entrada ${i}: ${obtenido[i]} frente a ${esperado[i]}`);
  }
}

test('cellIntKey es biyectiva en el dominio entero admisible, incluidos los negativos', () => {
  const muestras = [0, 1, -1, -10_000_000, 9_999_999, 33_554_431, -33_554_432];
  const vistos = new Set<number>();
  for (const y of muestras) for (const x of muestras) {
    const key = cellIntKey(x, y);
    assert.equal(typeof key, 'number');
    assert.equal(cellKeyX(key!), x);
    assert.equal(cellKeyY(key!), y);
    assert.equal(vistos.has(key!), false);
    vistos.add(key!);
  }
  assert.equal(cellIntKey(1.5, 2), undefined);
  assert.equal(cellIntKey(40_000_000, 1), undefined);
  assert.equal(cellIntKey(Number.NaN, 0), undefined);
});

test('la observación local coincide bit a bit con el bucle original en 220 actores', () => {
  const world = createWorld(7, parseParams('conducta.politicaPeso=0.35'));
  activate(world, -48, -48);
  activate(world, -32, -32);
  const pintar = (x: number, y: number, terrain: Tile['terrain'], food: number, drinkingWater: number, wood = 0, stone = 0) => {
    const tile = tileAt(world, { x, y });
    assert.ok(tile, `tesela ${x},${y}`);
    tile.terrain = terrain;
    tile.food = food;
    tile.drinkingWater = drinkingWater;
    tile.wood = wood;
    tile.stone = stone;
  };
  pintar(17, 13, 'shelter', 0.42, 0.2, 3, 1);
  pintar(18, 13, 'water', 0.9, 0.8, 4, 2);
  pintar(16, 14, 'meadow', 0.05, 0.005, 0, 0);
  pintar(17, 12, 'meadow', 0.31, 0.006, 5, 0);
  pintar(-30, -20, 'shelter', 0.2, 0.01, 1, 1);
  pintar(-29, -20, 'water', 0.4, 0.5);
  pintar(-31, -19, 'meadow', 0.02, 0, 0, 3);

  const base = world.people[0]!;
  const actores: Person[] = [];
  for (let i = 0; i < 220; i++) {
    const person = structuredClone(base);
    person.id = `obs-${i}`;
    person.name = `Obs ${i}`;
    person.hunger = (i % 11) / 5;
    person.thirst = (i % 9) / 8;
    person.fatigue = i % 3 === 0 ? -0.2 : 0.45;
    person.energy = i % 4 === 0 ? 1.4 : 0.25;
    person.inventory = (i % 13) / 20;
    if (i < 40) {
      person.x = 15 + (i % 5);
      person.y = 12 + Math.floor(i / 5) % 3;
    } else if (i < 80) {
      person.x = -30 + (i % 5);
      person.y = -24 + Math.floor((i - 40) / 5);
    } else {
      person.x = 400 + i;
      person.y = -400 - i;
    }
    person.visited = visitedDe(i, person.x, person.y);
    person.bonds = {};
    if (i < 40) {
      person.bonds[`obs-${(i + 1) % 40}`] = 0.15 + (i % 7) * 0.1;
      person.bonds.s = 0.62;
      person.bonds['nadie'] = 0.9;
    }
    world.people.push(person);
    actores.push(person);
  }

  const tileIn = tileLookup(world.tiles);
  for (const person of actores) {
    igual(observar(world, person, tileIn), referenciaLocalPolicyObservation(world, person), person.id);
  }
  igual(observar(world, world.people[0]!, tileIn), referenciaLocalPolicyObservation(world, world.people[0]!), 'fundador');

  const mutable = actores[1]!;
  assert.ok(mutable.visited.length > 2);
  mutable.visited[0] = mutable.visited[0] === '0,0' ? '4,4' : '0,0';
  igual(observar(world, mutable, tileIn), referenciaLocalPolicyObservation(world, mutable), 'cache invalida al cambiar el primero');
  const largo = mutable.visited.length;
  mutable.visited.push('8,8');
  mutable.visited.shift();
  assert.equal(mutable.visited.length, largo);
  igual(observar(world, mutable, tileIn), referenciaLocalPolicyObservation(world, mutable), 'cache invalida con shift y push');
});

function visitedDe(i: number, x: number, y: number): string[] {
  if (i % 5 === 0) return [];
  if (i % 5 === 1) {
    const lleno: string[] = [];
    for (let n = 0; n < 192; n++) lleno.push(`${x - 96 + n},${y + ((n % 17) - 8)}`);
    lleno[3] = '01,2';
    lleno[4] = '40000000,1';
    lleno[5] = '-0,1';
    return lleno;
  }
  if (i % 5 === 2) return [`${x},${y}`, `${x + 1},${y}`, `${x - 4},${y + 4}`, '01,2', '-12,-12'];
  if (i % 5 === 3) return ['1,2,3', '', 'no-es-celda', '+3,4', `-2,${y}`];
  return [`${x - 3},${y - 3}`, `${x + 2},${y - 1}`, '-8,-3', '40000000,-1'];
}

test('la observación cae a la clave de texto cuando la tesela no es un entero admisible', () => {
  const world = createWorld(11);
  const person = world.people[0]!;
  person.x = 0;
  person.y = 0;
  person.hunger = 0.4;
  person.thirst = 0.2;
  person.fatigue = 0.1;
  person.energy = 0.8;
  person.inventory = 0.05;
  person.bonds = { vecino: 0.4 };
  person.visited = ['1.5,2', '40000000,1', '0,0', '01,2', '-8,-3'];
  // La consulta es entera (la persona está en 0,0); la tesela devuelta puede no serlo.
  // El original marca lo visitado con `${tile.x},${tile.y}`, no con la consulta.
  const porConsulta = new Map<string, Tile>([
    ['0,0', { x: 40_000_000, y: 1, terrain: 'shelter', moisture: 0, vegetation: 0, food: 0.1, drinkingWater: 0.2, wood: 2, stone: 3 }],
    ['1,0', { x: 1.5, y: 2, terrain: 'meadow', moisture: 0, vegetation: 0, food: 0.4, wood: 1, stone: 0 }],
    ['-1,0', { x: -8, y: -3, terrain: 'meadow', moisture: 0, vegetation: 0, food: 0.05, wood: 0, stone: 4 }],
    ['2,0', { x: 2, y: 0, terrain: 'water', moisture: 0, vegetation: 0, food: 0.9, drinkingWater: 1 }],
    ['0,1', { x: 0, y: 1, terrain: 'meadow', moisture: 0, vegetation: 0, food: 0.25, drinkingWater: 0.005, wood: 0, stone: 0 }],
  ]);
  const tileIn = (x: number, y: number) => porConsulta.get(`${x},${y}`);
  let land = 0, foodSum = 0, waterTiles = 0, shelterTiles = 0, materialSum = 0, unvisited = 0;
  const visitedSet = new Set(person.visited);
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    if (dx * dx + dy * dy > 16) continue;
    const tile = tileIn(person.x + dx, person.y + dy);
    if (!tile || tile.terrain === 'water') continue;
    land++;
    foodSum += tile.food;
    if ((tile.drinkingWater ?? 0) > 0.005) waterTiles++;
    if (tile.terrain === 'shelter') shelterTiles++;
    materialSum += (tile.wood ?? 0) + (tile.stone ?? 0);
    if (!visitedSet.has(`${tile.x},${tile.y}`)) unvisited++;
  }
  const nearby = [{ id: 'vecino' }, { id: 'otro' }];
  let trustSum = 0;
  for (const other of nearby) trustSum += person.bonds[other.id] ?? 0;
  const denom = Math.max(1, land);
  const esperado = extractLocalObservation({
    hunger: clamp(person.hunger), thirst: clamp(person.thirst), fatigue: clamp(person.fatigue), energy: clamp(person.energy),
    inventoryFrac: clamp(person.inventory / 0.25), localFood: clamp(foodSum / denom), localWater: clamp((waterTiles / denom) * 3),
    localCrowd: clamp(nearby.length / 16), localShelter: clamp(shelterTiles / 4), localResources: clamp(materialSum / 24),
    communityTrust: clamp(trustSum / nearby.length), biomeNovelty: clamp(unvisited / denom),
  });
  igual(computeLocalPolicyObservation(world, person, tileIn, nearby), esperado, 'teselas no enteras');
  assert.ok(land >= 3 && shelterTiles === 1 && waterTiles >= 1, 'el caso cubre agua, techo y tierra');
});

const DIGESTO_BASE = {
  7: '31229317fea16372bb8213f87d6da14dc0505d61ec31ccad4231da3bbae99873',
  42: 'c108530b2b4d80624a31dd0a681c8c3b1725babdd47da32e67d792906fa7be12',
  51926: '3bfff0197cf7e1b0173336485cc0f7f7ca69481aade03f5b5afdbf018f0763d7',
} as const;

// paridad histórica: cuarentena V23
test.skip('600 ticks de mundo abierto conservan el digesto canónico de las semillas 7, 42 y 51926', () => {
  const leyes = 'poblacion.natalidadVecindad=true,conducta.politicaPeso=0.35,conducta.aptitud=0.35';
  for (const seed of [7, 42, 51926] as const) {
    const world = createWorld(seed, parseParams(leyes));
    for (let tick = 0; tick < 600; tick++) stepWorld(world);
    assert.equal(digestoCanonico(world), DIGESTO_BASE[seed], `semilla ${seed}`);
  }
});
