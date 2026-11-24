// Fixture compartido de la fase 1 de V19 para la fauna (F, R, M). No depende de los interruptores V19:
// se ejecuta igual sobre V18 (para generar las huellas de referencia) y sobre V19.
import { createHash } from 'node:crypto';
import type { Tile } from '../src/shared/types.js';
import type { AnimalSpecies } from '../src/shared/life.js';
import { materializeAnimals, stepAnimals, syncFauna, type Animal, type AnimalEmitter, type AnimalWorld } from '../src/world/animals.js';
import { parseParams, setParams } from '../src/world/params.js';

export function tile(x: number, y: number, overrides: Partial<Tile> = {}): Tile {
  return { x, y, terrain: 'meadow', biome: 'grassland', moisture: 0.8, vegetation: 0.8, growth: 0.8,
    food: 0.2, fauna: 0, drinkingWater: 0.8, fertility: 0.6, ...overrides };
}

/** Un animal fundador de `species` en (x, y), con id estable `animal-<etiqueta>`. */
export function fundador(species: AnimalSpecies, x: number, y: number, etiqueta: string): Animal {
  const a = materializeAnimals(42, [tile(x, y, { fauna: 1, species })], 0)[0]!;
  a.id = `animal-${etiqueta}`;
  a.hunger = 0.25; a.thirst = 0.2;
  return a;
}

/**
 * Tres parches de 16×16 teselas de pradera productiva, separados por huecos sin teselas (los animales no los
 * cruzan): zorros + liebres, lobos + ciervos + liebres, y herbívoros solos (478 cabezas, más que el umbral
 * de 384 decisiones a partir del cual `stepAnimals` despacha la decisión a los workers). Reparto determinista.
 */
export function parches(): { tiles: Tile[]; animals: Animal[] } {
  const tiles: Tile[] = [], animals: Animal[] = [];
  const plan: [number, [AnimalSpecies, number][]][] = [
    [0, [['hare', 150], ['fox', 24]]],
    [20, [['deer', 60], ['hare', 60], ['wolf', 24]]],
    [40, [['hare', 80], ['deer', 40], ['boar', 40]]],
  ];
  for (const [ox, especies] of plan) {
    const local: Tile[] = [];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) local.push(tile(ox + x, y));
    const cuenta = new Map<number, number>(); let k = 0;
    for (const [species, n] of especies) for (let i = 0; i < n; i++) {
      let c = (k * 37 + 11) % local.length; k++;
      while ((cuenta.get(c) ?? 0) >= 3) c = (c + 1) % local.length;
      cuenta.set(c, (cuenta.get(c) ?? 0) + 1);
      const t = local[c]!;
      const a = materializeAnimals(42, [{ ...t, fauna: 1, species }], 0)[0]!;
      a.id = `animal-fx-${ox}-${species}-${i}`; a.x = t.x; a.y = t.y; a.target = { x: t.x, y: t.y };
      animals.push(a);
    }
    tiles.push(...local);
  }
  animals.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { tiles, animals };
}

/** Mundo de fauna solo (sin personas) con los params indicados ("a.b=v,c.d=w"; vacío = defaults). */
export function mundo(tiles: Tile[], animals: Animal[], params = '', reproduccion = true): AnimalWorld {
  syncFauna(tiles, animals);
  const w: AnimalWorld = { seed: 42, tick: 0, tiles, animals, animalCounter: 0, reproductionEnabled: reproduccion,
    animalDynamics: { births: 0, deaths: 0, predations: 0, humanHunts: 0, waterConsumed: 0, plantConsumed: 0 } };
  setParams(w, parseParams(params));
  return w;
}
export function paso(w: AnimalWorld, emit?: AnimalEmitter): void { w.tick++; stepAnimals(w, emit); }

/** Huella SHA-256 del estado exacto (conserva −0 y NaN) de la fauna, las teselas y la dinámica. */
export function huella(w: AnimalWorld): string {
  const texto = JSON.stringify({ tick: w.tick, counter: w.animalCounter, dyn: w.animalDynamics,
    animals: [...w.animals].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    tiles: [...w.tiles].sort((a, b) => a.y - b.y || a.x - b.x) },
  (_clave, valor) => typeof valor === 'number' && (Object.is(valor, -0) || Number.isNaN(valor)) ? `#${Object.is(valor, -0) ? '-0' : 'NaN'}` : valor);
  return createHash('sha256').update(texto).digest('hex');
}
