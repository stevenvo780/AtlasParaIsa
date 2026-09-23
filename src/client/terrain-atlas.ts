/**
 * Atlas procedural de terreno. Se construye una sola vez, fuera del DOM, y
 * después cada chunk se hornea únicamente con blits de teselas 16×16.
 */
import type { Biome } from '../shared/types.js';
import { AGUA, BOSQUE, DESIERTO, HUMEDAL, MONTANA, PRADERA, SUELO } from './paleta.js';

export const TERRAIN_ATLAS_TILE = 16;
export const TERRAIN_VARIANTS = 4;
const ATLAS_STRIDE = TERRAIN_ATLAS_TILE + 8;

export type AtlasBiome = Biome;
export type WorkedGroundState = 'wild' | 'trodden' | 'ploughed' | 'cultivated';

export interface AtlasCell { sx: number; sy: number; }

export interface TerrainAtlas {
  canvas: HTMLCanvasElement;
  soil(biome: AtlasBiome, variant: number, moisture: number, fertility: number): AtlasCell;
  leaf(biome: AtlasBiome, variant: number, moisture: number, vegetation: number): AtlasCell;
  worked(state: Exclude<WorkedGroundState, 'wild'>, variant: number): AtlasCell;
  water(depth: number, variant: number): AtlasCell;
  edge(owner: AtlasBiome, neighbour: AtlasBiome, variant: number, mask: number): AtlasCell;
}

interface Colour { r: number; g: number; b: number; }
interface BiomeColours { soil: Colour; shade: Colour; leaf: Colour; leafShade: Colour; }

const BIOMES: readonly AtlasBiome[] = ['grassland', 'forest', 'desert', 'mountain', 'wetland', 'ocean'];
const LAND_BIOMES: readonly AtlasBiome[] = ['grassland', 'forest', 'desert', 'mountain', 'wetland'];
const ATLAS_COLUMNS = 64;
const CELLS = LAND_BIOMES.length * TERRAIN_VARIANTS * 13 * 13 * 2
  + 3 * TERRAIN_VARIANTS
  + 3 * TERRAIN_VARIANTS
  + BIOMES.length * (BIOMES.length - 1) * TERRAIN_VARIANTS * 15;
// 8 584 celdas de 24×24: raster de 1 536×3 240 RGBA, unos 19 MiB.

function colour(hex: string): Colour {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

const COLOURS: Record<AtlasBiome, BiomeColours> = {
  grassland: { soil: colour(SUELO.pisado), shade: colour(SUELO.arado), leaf: colour(PRADERA.base), leafShade: colour(PRADERA.seca) },
  forest: { soil: colour(SUELO.pisado), shade: colour(BOSQUE.sombra), leaf: colour(BOSQUE.base), leafShade: colour(BOSQUE.sombra) },
  desert: { soil: colour(DESIERTO.base), shade: colour(DESIERTO.sombra), leaf: colour(PRADERA.seca), leafShade: colour(DESIERTO.sombra) },
  mountain: { soil: colour(MONTANA.base), shade: colour(MONTANA.sombra), leaf: colour(PRADERA.seca), leafShade: colour(BOSQUE.sombra) },
  wetland: { soil: colour(HUMEDAL.sombra), shade: colour(SUELO.cultivo), leaf: colour(HUMEDAL.base), leafShade: colour(BOSQUE.base) },
  ocean: { soil: colour(AGUA.profunda), shade: colour(AGUA.somera), leaf: colour(AGUA.espuma), leafShade: colour(AGUA.somera) },
};

const WORKED: Record<Exclude<WorkedGroundState, 'wild'>, Colour> = {
  trodden: colour(SUELO.pisado), ploughed: colour(SUELO.arado), cultivated: colour(SUELO.cultivo),
};
function hash3(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt | 0, 2246822519);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Ventana 16×16 con fase propia de la casilla; cabe en el margen cíclico de 8 px. */
export function terrainAtlasWindow(cell: AtlasCell, x: number, y: number): AtlasCell {
  return { sx: cell.sx + (hash3(x, y, 3101) & 7), sy: cell.sy + (hash3(x, y, 3102) & 7) };
}

const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];

/**
 * Desplaza qué ventana de `BAYER8` cae en cada píxel, para que decisiones
 * tramadas simultáneas (fertilidad, humedad, cobertura, estado de suelo…) no
 * queden correlacionadas por compartir el mismo patrón (ver «Nota técnica:
 * fases del tramado» en `docs/ARTE.md`). La sal `1` de abajo no es arbitraria
 * ni heredada sin más del tramado por-píxel anterior: se verificó contra el
 * caso real que expuso una colisión (fertilidad=0 y humedad=0, cada una con
 * el resto de la tesela en sus valores por defecto, producían el mismo
 * raster porque la diferencia de suelo caía entera bajo la cobertura de
 * hoja) — con esta sal las 9 variantes ecológicas de esa prueba quedan
 * distintas entre sí. Quien cambie esta sal debe re-verificar
 * `tests/landscape-state.test.ts`.
 */
export function threshold(x: number, y: number, phase: number): number {
  const h = hash3(phase, 0, 1);
  return (BAYER8[(((y + ((h >>> 3) & 7)) & 7) * 8) + ((x + (h & 7)) & 7)]! + .5) / 64;
}

function choose(x: number, y: number, phase: number, amount: number, low: Colour, high: Colour): Colour {
  return amount > threshold(x, y, phase) ? high : low;
}

function key(...parts: Array<string | number>): string { return parts.join(':'); }

let memo: TerrainAtlas | undefined;

/** Crea el único raster del atlas. Ningún canvas generado aquí se inserta al DOM. */
export function getTerrainAtlas(): TerrainAtlas {
  if (memo) return memo;

  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLUMNS * ATLAS_STRIDE;
  canvas.height = Math.ceil(CELLS / ATLAS_COLUMNS) * ATLAS_STRIDE;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(canvas.width, canvas.height);
  const pixels = image.data;
  const cells = new Map<string, AtlasCell>();
  let cursor = 0;

  const add = (id: string, paint: (x: number, y: number) => Colour | undefined, wrapped = false): void => {
    const column = cursor % ATLAS_COLUMNS, row = Math.floor(cursor / ATLAS_COLUMNS);
    const sx = column * ATLAS_STRIDE, sy = row * ATLAS_STRIDE;
    cells.set(id, { sx, sy }); cursor++;
    const size = wrapped ? ATLAS_STRIDE : TERRAIN_ATLAS_TILE;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const value = paint(x & 15, y & 15); if (!value) continue;
      const offset = ((sy + y) * canvas.width + sx + x) * 4;
      pixels[offset] = value.r; pixels[offset + 1] = value.g; pixels[offset + 2] = value.b; pixels[offset + 3] = 255;
    }
  };

  for (const biome of LAND_BIOMES) for (let variant = 0; variant < TERRAIN_VARIANTS; variant++) {
    const palette = COLOURS[biome];
    for (let moisture = 0; moisture <= 12; moisture++) for (let fertility = 0; fertility <= 12; fertility++) {
      add(key('soil', biome, variant, moisture, fertility), (x, y) => {
        // Fertilidad y humedad tienen fases independientes: dos cambios
        // ecológicos distintos nunca colapsan accidentalmente al mismo raster.
        const fertile = choose(x, y, variant, fertility / 12 * .42, palette.soil, palette.shade);
        return choose(x, y, 3 + variant, moisture / 12 * .18, fertile, palette.shade);
      }, true);
    }
    for (let moisture = 0; moisture <= 12; moisture++) for (let vegetation = 0; vegetation <= 12; vegetation++) {
      const cover = vegetation / 12;
      add(key('leaf', biome, variant, moisture, vegetation), (x, y) => {
        if (cover <= threshold(x, y, 6 + variant)) return undefined;
        return choose(x, y, 9 + variant, (12 - moisture) / 12 * .58, palette.leaf, palette.leafShade);
      }, true);
    }
  }

  for (const state of ['trodden', 'ploughed', 'cultivated'] as const) for (let variant = 0; variant < TERRAIN_VARIANTS; variant++) {
    const stateIndex = state === 'trodden' ? 0 : state === 'ploughed' ? 1 : 2;
    add(key('worked', state, variant), (x, y) => {
      const phase = 12 + stateIndex * 3 + variant;
      if (state === 'trodden') return .54 > threshold(x, y, phase) ? WORKED[state] : undefined;
      if (state === 'ploughed') return ((y + variant) & 3) < 2 || .18 > threshold(x, y, phase) ? WORKED[state] : undefined;
      return ((y + variant) & 3) !== 3 || .3 > threshold(x, y, phase) ? WORKED[state] : undefined;
    }, true);
  }

  for (let depth = 0; depth < 3; depth++) for (let variant = 0; variant < TERRAIN_VARIANTS; variant++) {
    const shallow = [.82, .48, .16][depth]!;
    add(key('water', depth, variant), (x, y) => {
      if (((x + variant * 5) % 13 === 2 || (x + variant * 7) % 13 === 3) && (y + depth * 3) % 11 === 2) return COLOURS.ocean.leaf;
      return choose(x, y, 21 + variant, shallow, COLOURS.ocean.soil, COLOURS.ocean.shade);
    }, true);
  }

  for (const owner of BIOMES) for (const neighbour of BIOMES) {
    if (owner === neighbour) continue;
    for (let variant = 0; variant < TERRAIN_VARIANTS; variant++) for (let mask = 1; mask < 16; mask++) {
      const target = COLOURS[neighbour];
      add(key('edge', owner, neighbour, variant, mask), (x, y) => {
        let distance = 99;
        if (mask & 1) distance = Math.min(distance, y);
        if (mask & 2) distance = Math.min(distance, TERRAIN_ATLAS_TILE - 1 - x);
        if (mask & 4) distance = Math.min(distance, TERRAIN_ATLAS_TILE - 1 - y);
        if (mask & 8) distance = Math.min(distance, x);
        if (distance > 2) return undefined;
        const presence = distance === 0 ? 1 : distance === 1 ? .58 : .24;
        if (presence <= threshold(x, y, 24 + variant)) return undefined;
        if (neighbour === 'ocean') return distance === 0 && threshold(x, y, 27) < .28 ? target.leaf : target.shade;
        return choose(x, y, 28 + variant, .7, target.soil, target.leaf);
      });
    }
  }

  context.putImageData(image, 0, 0);
  const required = (id: string): AtlasCell => {
    const cell = cells.get(id); if (!cell) throw new Error(`Tesela ausente en atlas: ${id}`); return cell;
  };
  memo = {
    canvas,
    soil: (biome, variant, moisture, fertility) => required(key('soil', biome, variant, moisture, fertility)),
    leaf: (biome, variant, moisture, vegetation) => required(key('leaf', biome, variant, moisture, vegetation)),
    worked: (state, variant) => required(key('worked', state, variant)),
    water: (depth, variant) => required(key('water', depth, variant)),
    edge: (owner, neighbour, variant, mask) => required(key('edge', owner, neighbour, variant, mask)),
  };
  return memo;
}
