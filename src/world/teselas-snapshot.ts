import { exactJsonNumber } from '../shared/exact-json.js';
import type { Tile } from '../shared/types.js';
import { residentBackingArray, residentTopologyToken } from './soa/topologia.js';
import { residentFastAccess } from './soa/terreno.js';

/** Orden de los campos de cada tupla de tesela. `encodeSnapshotTileRows` escribe el mismo orden a mano
 * (camino caliente de cada guardado); tests/snapshot-tile-fields.test.ts comprueba que coinciden. */
export const SNAPSHOT_TILE_FIELDS = ['x','y','terrain','moisture','vegetation','food','biome','elevation','wood','stone','feature','variety','growth','fertility','cultivation','traffic','drinkingWater','species','fauna','life','paved','rocaLatente'] as const;
export const ANCHO_TESELA = SNAPSHOT_TILE_FIELDS.length - 1;
export const rocaValida = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Codifica `count` teselas desde `offset` sin copiar el tramo (el guardado por páginas ya no paga un
 * `slice` —otra pasada de traps sobre el array Proxy residente— por página). Sin tramo, el array entero.
 * El cuarto argumento se conserva para los llamadores que pasan el modo de guardado. */
export function encodeSnapshotTileRows(tiles: readonly Tile[], offset = 0, count = tiles.length - offset, _nativo = false): unknown[][] {
  // JSON null is reserved for absent optional fields. Never erase invalid present
  // values (JSON itself would turn NaN/Infinity into null) during compaction.
  const rows: unknown[][] = new Array(count);
  const token = residentTopologyToken(tiles as Tile[]);
  // An opaque array index accessor must keep the public Proxy as its receiver.
  const raw = token === undefined ? tiles : residentBackingArray(tiles);
  // The provider refuses busy stores and reflected resident descriptors. A binding
  // lookup (not an array index/coordinate guess) also handles mixed/new chunks.
  // Inherited optional values cannot be represented by the SoA absence sentinel.
  const fast = token !== undefined
    && !SNAPSHOT_TILE_FIELDS.some(key => key in Object.prototype) ? residentFastAccess(tiles) : undefined;
  for (let n = 0; n < count; n++) {
    const t = raw[offset + n]!;
    const cell = fast ? fast.cellOf(t) : -1;
    // Keep the historical tuple projection: custom object key order, extra keys
    // and tile.toJSON do not change it. Unbound/opaque tiles take the old reads.
    const row: unknown[] = cell < 0 ? [t.x,t.y,t.terrain,t.moisture,t.vegetation,t.food,t.biome,t.elevation,t.wood,t.stone,t.feature,t.variety,t.growth,t.fertility,t.cultivation,t.traffic,t.drinkingWater,t.species,t.fauna,t.life,t.paved]
      : [t.x,t.y,fast!.TERRAIN_NAMES[fast!.terrainArr[cell]! - 1],
        optionalNumber(fast!.moistureArr[cell]!),optionalNumber(fast!.vegetationArr[cell]!),optionalNumber(fast!.foodArr[cell]!),
        fast!.BIOME_NAMES[fast!.biomeArr[cell]! - 1],t.elevation,optionalNumber(fast!.woodArr[cell]!),t.stone,
        fast!.FEATURE_NAMES[fast!.featureArr[cell]! - 1],t.variety,optionalNumber(fast!.growthArr[cell]!),
        optionalNumber(fast!.fertilityArr[cell]!),optionalNumber(fast!.cultivationArr[cell]!),optionalNumber(fast!.trafficArr[cell]!),
        optionalNumber(fast!.drinkingWaterArr[cell]!),t.species,t.fauna,optionalNumber(fast!.lifeArr[cell]!),t.paved];
    const roca = t.rocaLatente;
    if (roca !== undefined) {
      if (!rocaValida(roca)) throw new Error('Reserva de roca latente inválida. No se guardó la instantánea.');
      row.push(roca);
    }
    for (let i = 0; i < row.length; i++) {
      const value = row[i];
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          if (i < 6 && i !== 2) throw new Error('Invalid required numeric tile value. Snapshot was not written.');
          if (i >= 6) throw new Error('Invalid optional tile value. Snapshot was not written.');
        } else if (value === 0 && 1 / value < 0) row[i] = exactJsonNumber(value);
      } else if (i < 6 && i !== 2) throw new Error('Invalid required numeric tile value. Snapshot was not written.');
      else if (i >= 6 && value === null) throw new Error('Invalid optional tile value. Snapshot was not written.');
    }
    rows[n] = row;
  }
  return rows;
}
/** NaN is the resident absence sentinel; Infinity is a present value and must
 * reach the same validation/error below as it does through a resident getter. */
function optionalNumber(value: number): number | undefined { return value === value ? value : undefined; }

/** Materializa una tupla cuyo ancho ya comprobó el transporte. */
export function materializarTuplaTesela(row: readonly unknown[]): Tile {
  const tile: Record<string, unknown> = {};
  for (let i = 0; i < row.length; i++) if (row[i] !== null || i < 6) tile[SNAPSHOT_TILE_FIELDS[i]!] = row[i];
  return tile as unknown as Tile;
}
