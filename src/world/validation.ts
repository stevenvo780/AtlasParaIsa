import type { Tile } from '../shared/types.js';
export function assertEcosystemTile(tile: Tile, required = true): void {
  const fail = (): never => { throw new Error('Elemento del ecosistema inválido.'); };
  if ((required || tile.feature !== undefined) && !['tree','pine','palm','cactus','reeds','berries','flowers','rock','clay','stump','spring','pool','none'].includes(String(tile.feature))) fail();
  if ((required || tile.variety !== undefined) && (!Number.isInteger(tile.variety) || tile.variety! < 0 || tile.variety! > 3)) fail();
  for (const key of ['growth','fertility','cultivation','traffic','drinkingWater','life'] as const) {
    const value = tile[key];
    if ((required || value !== undefined) && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) fail();
  }
  if ((required || tile.fauna !== undefined) && (!Number.isInteger(tile.fauna) || tile.fauna! < 0 || tile.fauna! > 6)) fail();
  if (tile.species !== undefined && !['hare','deer','boar','fish'].includes(tile.species)) fail();
  if ((tile.fauna ?? 0) > 0 && tile.species === undefined) fail();
}
