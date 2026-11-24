import { CRECIMIENTO_COMIDA } from './ecologia-constantes.js';
import type { WorldParams } from './params.js';
import type { StaticWorkerHandlerJob } from './paralelo/piscina.js';

const clamp = (n: number): number => Math.max(0, Math.min(1, n));

export interface ParallelEcologyParams {
  phase: 'ecologia';
  weather: 'clear' | 'rain';
  light: number;
  version: number;
  recursos: WorldParams['recursos'];
}

/**
 * V22: forzamiento estacional regional precalculado UNA vez por página 16×16 (`regionalClimateFactor`
 * en el centro `(px*16+8, py*16+8)`, el mismo punto que usa el bucle serie de `ecology()`), en el
 * buffer compartido `climate` con tres dobles por ranura: `rainScale`, `evapScale`, `growthScale`.
 * Sin el buffer (amplitud 0) el cuerpo es el de siempre, literal a literal.
 */
export const CLIMATE_STRIDE = 3;

/**
 * Primera pasada ecológica sobre los buffers residentes. Cada celda copia primero la foto
 * completa al fondo: la barrera puede intercambiar todos los pares sin perder campos que esta
 * ley no escribe. La única lectura remota es `terrain` de las cuatro vecinas cardinales.
 */
export function runParallelEcology({ regions, buffers, params }: StaticWorkerHandlerJob<ParallelEcologyParams>): void {
  const { weather, light, version, recursos } = params;
  const { capacidadBosque, capacidadPastizal, capacidadOtros, velocidadRegeneracion, decaimientoComida } = recursos;
  const cells = new Int32Array(buffers.cells!), stamps = new Uint32Array(buffers.stamps!);
  const around = new Int32Array(buffers.around!);
  const moistureFront = new Float64Array(buffers.moisture!), moistureBack = new Float64Array(buffers.moistureBack!);
  const vegetationFront = new Float64Array(buffers.vegetation!), vegetationBack = new Float64Array(buffers.vegetationBack!);
  const foodFront = new Float64Array(buffers.food!), foodBack = new Float64Array(buffers.foodBack!);
  const woodFront = new Float64Array(buffers.wood!), woodBack = new Float64Array(buffers.woodBack!);
  const growthFront = new Float64Array(buffers.growth!), growthBack = new Float64Array(buffers.growthBack!);
  const fertilityFront = new Float64Array(buffers.fertility!), fertilityBack = new Float64Array(buffers.fertilityBack!);
  const cultivationFront = new Float64Array(buffers.cultivation!), cultivationBack = new Float64Array(buffers.cultivationBack!);
  const trafficFront = new Float64Array(buffers.traffic!), trafficBack = new Float64Array(buffers.trafficBack!);
  const drinkingFront = new Float64Array(buffers.drinkingWater!), drinkingBack = new Float64Array(buffers.drinkingWaterBack!);
  const lifeFront = new Float64Array(buffers.life!), lifeBack = new Float64Array(buffers.lifeBack!);
  const terrainFront = new Uint8Array(buffers.terrain!), terrainBack = new Uint8Array(buffers.terrainBack!);
  const biomeFront = new Uint8Array(buffers.biome!), biomeBack = new Uint8Array(buffers.biomeBack!);
  const featureFront = new Uint8Array(buffers.feature!), featureBack = new Uint8Array(buffers.featureBack!);
  const dirty = new Uint8Array(buffers.dirty!);
  const woodAddedQueue = buffers.woodAddedQueue ? new Int32Array(buffers.woodAddedQueue) : undefined;
  if (woodAddedQueue) Atomics.store(woodAddedQueue, 0, 1);
  const climate = buffers.climate ? new Float64Array(buffers.climate) : undefined;

  const waterAt = (cell: number, dx: number, dy: number): boolean => {
    const slot = cell >>> 8, nx = (cell & 15) + dx, ny = ((cell >> 4) & 15) + dy;
    const target = around[slot * 9 + (ny < 0 ? 0 : ny > 15 ? 6 : 3) + (nx < 0 ? 0 : nx > 15 ? 2 : 1)]!;
    if (target < 0) return false;
    const neighbor = (target << 8) | ((ny & 15) << 4) | (nx & 15);
    return stamps[neighbor] === version && terrainFront[neighbor] === 1;
  };

  for (const region of regions) for (let i = region.begin; i < region.end; i++) {
    const cell = cells[i]!, slot = cell >>> 8;

    moistureBack[cell] = moistureFront[cell]!;
    vegetationBack[cell] = vegetationFront[cell]!;
    foodBack[cell] = foodFront[cell]!;
    woodBack[cell] = woodFront[cell]!;
    growthBack[cell] = growthFront[cell]!;
    fertilityBack[cell] = fertilityFront[cell]!;
    cultivationBack[cell] = cultivationFront[cell]!;
    trafficBack[cell] = trafficFront[cell]!;
    drinkingBack[cell] = drinkingFront[cell]!;
    lifeBack[cell] = lifeFront[cell]!;
    terrainBack[cell] = terrainFront[cell]!;
    biomeBack[cell] = biomeFront[cell]!;
    featureBack[cell] = featureFront[cell]!;

    if (terrainFront[cell] !== 1) {
      // Mismo orden y cortocircuito que `waterAt(x - 1) || waterAt(x + 1)
      // || waterAt(y - 1) || waterAt(y + 1)` del camino de objetos.
      const nearWater = waterAt(cell, -1, 0) || waterAt(cell, 1, 0)
        || waterAt(cell, 0, -1) || waterAt(cell, 0, 1);
      if (climate) {
        // Mismo orden aritmético que la rama `seasonal` del bucle serie de `ecology()` (index.ts).
        const at = slot * CLIMATE_STRIDE;
        const rainScale = climate[at]!, evapScale = climate[at + 1]!, growthScale = climate[at + 2]!;
        const moisture = clamp(moistureFront[cell]! + (weather === 'rain' ? 0.012 * rainScale : 0)
          + (nearWater ? 0.008 : 0) - (0.0015 + light * 0.001) * evapScale);
        moistureBack[cell] = moisture;
        const biome = biomeFront[cell]!;
        const K = biome === 2 ? capacidadBosque : biome === 1 ? capacidadPastizal : capacidadOtros;
        const vegetation = vegetationFront[cell]!;
        const headroom = K > 0 ? 1 - vegetation / K : 0;
        const growth = velocidadRegeneracion * growthScale * light * moisture * 0.007 * headroom;
        const nextVegetation = clamp(vegetation + growth - (moisture < 0.15 ? 0.0015 : 0.0001));
        vegetationBack[cell] = nextVegetation;
        const food = foodFront[cell]!;
        const foodHeadroom = K > 0 ? 1 - food / K : 0;
        foodBack[cell] = clamp(food + velocidadRegeneracion * growthScale * light * moisture * nextVegetation
          * CRECIMIENTO_COMIDA * foodHeadroom - decaimientoComida);
        dirty[slot] = 1;
        continue;
      }
      const moisture = clamp(moistureFront[cell]! + (weather === 'rain' ? 0.012 : 0)
        + (nearWater ? 0.008 : 0) - 0.0015 - light * 0.001);
      moistureBack[cell] = moisture;
      const biome = biomeFront[cell]!;
      const K = biome === 2 ? capacidadBosque : biome === 1 ? capacidadPastizal : capacidadOtros;
      const vegetation = vegetationFront[cell]!;
      const headroom = K > 0 ? 1 - vegetation / K : 0;
      const growth = velocidadRegeneracion * light * moisture * 0.007 * headroom;
      const nextVegetation = clamp(vegetation + growth - (moisture < 0.15 ? 0.0015 : 0.0001));
      vegetationBack[cell] = nextVegetation;
      const food = foodFront[cell]!;
      const foodHeadroom = K > 0 ? 1 - food / K : 0;
      foodBack[cell] = clamp(food + velocidadRegeneracion * light * moisture * nextVegetation
        * CRECIMIENTO_COMIDA * foodHeadroom - decaimientoComida);
    }
    // El swap publica una foto completa también para páginas de agua; el diagnóstico de su página
    // debe reflejar que el worker la tocó aunque sus trece valores sean idénticos.
    dirty[slot] = 1;
  }
}
