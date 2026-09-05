import type { Feature, Tile } from '../shared/types.js';

const clamp = (n: number): number => Math.max(0, Math.min(1, n));
const TREE_FEATURES = new Set<Feature>(['tree', 'pine', 'palm', 'cactus', 'reeds', 'stump']);
const MAX_TOPOLOGIES = 4;

interface Topology {
  coordinates: Float64Array;
  neighbors: Int32Array;
  growth: Float64Array;
  fertility: Float64Array;
  life: Float64Array;
  moisture: Float64Array;
  drinkingWater: Float64Array;
  cultivation: Float64Array;
  traffic: Float64Array;
}

function sameCoordinates(topology: Topology, tiles: readonly Tile[]): boolean {
  if (topology.coordinates.length !== tiles.length * 2) return false;
  for (let i = 0; i < tiles.length; i++) {
    if (!Object.is(topology.coordinates[i * 2], tiles[i].x)
      || !Object.is(topology.coordinates[i * 2 + 1], tiles[i].y)) return false;
  }
  return true;
}

function buildTopology(tiles: readonly Tile[]): Topology {
  const coordinates = new Float64Array(tiles.length * 2);
  const positions = new Map<string, number>();
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const key = `${tile.x},${tile.y}`;
    if (positions.has(key)) throw new Error('El ecosistema requiere coordenadas únicas.');
    positions.set(key, i);
    coordinates[i * 2] = tile.x; coordinates[i * 2 + 1] = tile.y;
  }
  const neighbors = new Int32Array(tiles.length * 8).fill(-1);
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    let offset = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      neighbors[i * 8 + offset++] = positions.get(`${tile.x + dx},${tile.y + dy}`) ?? -1;
    }
  }
  return { coordinates, neighbors, growth: new Float64Array(tiles.length), fertility: new Float64Array(tiles.length),
    life: new Float64Array(tiles.length), moisture: new Float64Array(tiles.length), drinkingWater: new Float64Array(tiles.length),
    cultivation: new Float64Array(tiles.length), traffic: new Float64Array(tiles.length) };
}

/** Scratch storage only: no Tile references or ecological values are reused between calls.
 * Ordered coordinates are checked even when cloneWorld replaces every object.
 * A cache hit changes allocation cost, never the rules or their arithmetic order.
 */
export class EcosystemKernel {
  private readonly topologies: Topology[] = [];

  get cachedTopologyCount(): number { return this.topologies.length; }

  step(tiles: Tile[], tick: number, weather: 'clear' | 'rain', phase: string): void {
    if (tick % 10 !== 0) return;
    const index = this.topologies.findIndex(topology => sameCoordinates(topology, tiles));
    // Build and reject duplicate coordinates before modifying any tile or cache.
    const previous = index < 0 ? buildTopology(tiles) : this.topologies[index];
    if (index >= 0) this.topologies.splice(index, 1);
    this.topologies.unshift(previous);
    if (this.topologies.length > MAX_TOPOLOGIES) this.topologies.pop();
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      previous.growth[i] = tile.growth ?? tile.vegetation;
      previous.fertility[i] = tile.fertility ?? 0;
      previous.life[i] = tile.life ?? 0;
      previous.moisture[i] = tile.moisture;
      previous.drinkingWater[i] = tile.drinkingWater ?? 0;
      previous.cultivation[i] = tile.cultivation ?? 0;
      previous.traffic[i] = tile.traffic ?? 0;
    }
    const light = phase === 'day' ? 1 : phase === 'night' ? 0 : 0.4;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const growth = previous.growth[i], fertility = previous.fertility[i], life = previous.life[i];
      const moisture = previous.moisture[i], drinkingWater = previous.drinkingWater[i];
      const cultivation = previous.cultivation[i], traffic = previous.traffic[i];
      let livingNeighbors = 0;
      for (let offset = 0; offset < 8; offset++) {
        const neighbor = previous.neighbors[i * 8 + offset];
        if (neighbor >= 0 && previous.life[neighbor] >= 0.45) livingNeighbors++;
      }
      const fertilePattern = livingNeighbors === 3 || (life >= 0.45 && livingNeighbors === 2);
      const cellularEnergy = light * moisture * (0.6 + fertility * 0.4);
      tile.life = clamp(life + ((fertilePattern ? 1 : 0) - life) * 0.2 * cellularEnergy
        - (moisture < 0.15 ? 0.015 : 0) - traffic * 0.004);
      tile.fertility = clamp(fertility + life * 0.0012 - traffic * 0.0007 - cultivation * 0.0002);
      const produced = light * moisture * fertility * (0.25 + life * 0.75)
        * (1 - growth) * (1 - traffic * 0.9) * 0.005;
      tile.growth = clamp(growth + produced - 0.0002 - traffic * 0.002 - (moisture < 0.15 ? 0.001 : 0));
      if (tile.terrain !== 'water') tile.vegetation = clamp(tile.vegetation + produced * 0.25 - traffic * 0.001);
      tile.traffic = clamp(traffic - 0.0005);
      tile.cultivation = clamp(cultivation - 0.00002);
      // Rain remains restricted to the same visible reservoirs as the object kernel.
      const reservoir = tile.feature === 'pool' || tile.feature === 'spring' || tile.biome === 'wetland' || tile.terrain === 'water';
      tile.drinkingWater = tile.biome === 'ocean' ? 0 : clamp(drinkingWater
        + (reservoir && weather === 'rain' ? 0.008 * (0.4 + fertility * 0.6) : 0)
        + (tile.feature === 'spring' ? 0.002 : 0) - (light ? 0.00015 : 0.00003));
      if (tile.terrain === 'water') tile.moisture = clamp(moisture + (tile.biome === 'ocean' ? 0.003 : 0) + (weather === 'rain' ? 0.008 : 0));
      // Wood consumes local growth; feature changes still use this tile's old growth.
      if (tick % 100 === 0 && TREE_FEATURES.has(tile.feature ?? 'none') && growth > 0.65
        && fertility > 0.4 && moisture > 0.35 && traffic < 0.35 && light > 0) {
        const capacity = tile.feature === 'reeds' || tile.feature === 'cactus' ? 2 : tile.feature === 'palm' ? 6 : 12;
        const regrowth = Math.min(capacity - (tile.wood ?? 0), 0.025 * light * moisture * fertility);
        if (regrowth > 0) {
          tile.wood = (tile.wood ?? 0) + regrowth;
          tile.growth = clamp(tile.growth! - regrowth * 0.05);
          if (tile.feature === 'stump' && tile.wood >= 1) tile.feature = tile.biome === 'mountain' ? 'pine' : 'tree';
        }
      }
    }
  }
}
