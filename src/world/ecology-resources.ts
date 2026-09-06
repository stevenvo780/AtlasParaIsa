import type { Tile } from '../shared/types.js';

const clamp = (value: number): number => Math.max(0, Math.min(1, value));

/** Existing fine resource law, shared by current and delayed regions. The input
 * domain is explicit: no archive lookup, generation, clock advance or RNG draw. */
export function updateEcosystemResources(tiles: Tile[], tick: number, weather: 'clear' | 'rain', phase: string): void {
  if (tick % 10 !== 0) return;
  const byPosition = new Map(tiles.map(tile => [`${tile.x},${tile.y}`, tile]));
  if (byPosition.size !== tiles.length) throw new Error('Ecological resource coordinates must be unique.');
  const light = phase === 'day' ? 1 : phase === 'night' ? 0 : 0.4;
  for (const tile of tiles) {
    if (tile.terrain === 'water') continue;
    const nearWater = [[tile.x - 1, tile.y], [tile.x + 1, tile.y], [tile.x, tile.y - 1], [tile.x, tile.y + 1]]
      .some(([x, y]) => byPosition.get(`${x},${y}`)?.terrain === 'water');
    tile.moisture = clamp(tile.moisture + (weather === 'rain' ? 0.012 : 0) + (nearWater ? 0.008 : 0) - 0.0015 - light * 0.001);
    const growth = light * tile.moisture * 0.007 * (1 - tile.vegetation);
    tile.vegetation = clamp(tile.vegetation + growth - (tile.moisture < 0.15 ? 0.0015 : 0.0001));
    tile.food = clamp(tile.food + light * tile.moisture * tile.vegetation * 0.006 * (1 - tile.food) - 0.0001);
  }
}
