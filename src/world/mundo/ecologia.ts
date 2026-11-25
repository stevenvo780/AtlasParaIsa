import type { World, WorldContext } from './tipos.js';
import { random, addEvent, phaseAt } from './crear.js';
import { clamp } from './geometria.js';
import type { EcologyExecution } from '../ecosystem-kernel.js';
import { INTERVALO_TIEMPO_TICKS, INTERVALO_ECOLOGIA_TICKS, LUZ_CREPSCULO, CRECIMIENTO_COMIDA } from '../ecologia-constantes.js';
import { paramsOf } from '../params.js';
import { gpuNvrtcAvailable } from '../gpu/puente.js';
import { stepLocalEcology } from '../ecosystem.js';
import { worldContext } from '../spatial.js';
import { regionalClimateFactor, sortearTiempo } from '../clima.js';
import { tileLookup } from '../tile-index.js';
import { residentFastAccess } from '../soa/terreno.js';
import { residentBackingArray } from '../soa/topologia.js';


/** Exportada para que la evidencia de T013 aplique la ley real a un mapa amplio sin pagar el coste del paso completo. */
export function ecology(world: World, execution?: EcologyExecution): void {
  if (world.tick % INTERVALO_TIEMPO_TICKS === 0) sortearTiempo(world, random(world), event => { addEvent(world, event); });
  if (world.tick % INTERVALO_ECOLOGIA_TICKS !== 0) return;
  const phase = phaseAt(world.tick);
  const climateParams = paramsOf(world).ecologia;
  // V22: la estacionalidad regional también va al pool de hilos y a la GPU. `regionalClimateFactor`
  // depende solo de la página 16×16 (su centro), así que el kernel lo precalcula una vez por página con
  // las mismas entradas que `climateFor` de abajo y aplica el mismo orden aritmético (0 ULP).
  if (paramsOf(world).motor.hilos > 1 || (paramsOf(world).motor.gpu.length > 0 && gpuNvrtcAvailable())) {
    stepLocalEcology(world.tiles, world.tick, world.weather, phase, paramsOf(world).recursos,
      { hilos: paramsOf(world).motor.hilos, orden: paramsOf(world).motor.orden, gpu: paramsOf(world).motor.gpu,
        ...(climateParams.amplitudEstacional > 0 ? { clima: { seed: world.seed, amplitud: climateParams.amplitudEstacional,
          periodoDias: climateParams.periodoEstacionalDias, escalaCeldas: climateParams.escalaClimaticaCeldas } } : {}),
        ...(execution ?? (worldContext(world) as WorldContext).ecologyExecution) });
    return;
  }
  const light = phase === 'day' ? 1 : phase === 'night' ? 0 : LUZ_CREPSCULO;
  const { capacidadBosque, capacidadPastizal, capacidadOtros, velocidadRegeneracion, decaimientoComida } = paramsOf(world).recursos;
  const seasonal = climateParams.amplitudEstacional > 0;
  const climateByRegion = seasonal ? new Map<number, ReturnType<typeof regionalClimateFactor>>() : undefined;
  const climateFor = (x: number, y: number): ReturnType<typeof regionalClimateFactor> => {
    const cx = Math.floor(x / 16), cy = Math.floor(y / 16), key = cx * 0x1_0000 + cy;
    let value = climateByRegion!.get(key);
    if (!value) {
      value = regionalClimateFactor(world.seed, world.tick, cx * 16 + 8, cy * 16 + 8,
        climateParams.amplitudEstacional, climateParams.periodoEstacionalDias, climateParams.escalaClimaticaCeldas);
      climateByRegion!.set(key, value);
    }
    return value;
  };
  // Índice fijado antes del recorrido (sprint noche-perf 2026-09-22): este bucle sólo cambia campos de
  // las teselas, nunca `world.tiles`, así que es la misma tesela que devolvería `tileAt` en cada vuelta,
  // sin crear cuatro pares y cuatro puntos por tesela.
  const tileIn = tileLookup(world.tiles);
  const fast = residentFastAccess(world.tiles);
  const exact = fast?.exact, terrainArr = fast?.terrainArr, biomeArr = fast?.biomeArr;
  const moistureArr = fast?.moistureArr, vegArr = fast?.vegetationArr, foodArr = fast?.foodArr;
  const WATER = fast?.TERRAIN_WATER ?? -1;
  const waterAt = (x: number, y: number): boolean => {
    if (exact && terrainArr) {
      const cell = exact.cellAt(x, y);
      if (cell >= 0) return terrainArr[cell] === WATER;
    }
    const tile = tileIn(x, y);
    if (!tile) return false;
    if (fast && terrainArr) {
      const cell = fast.cellOf(tile);
      if (cell >= 0) return terrainArr[cell] === WATER;
    }
    return tile.terrain === 'water';
  };
  const rawTiles = residentBackingArray(world.tiles);
  for (let i = 0; i < rawTiles.length; i++) {
    const tile = rawTiles[i]!;
    let cell = exact ? exact.cellAt(tile.x, tile.y) : -1;
    if (cell < 0 && fast) cell = fast.cellOf(tile);
    const bound = cell >= 0 && !!fast && !!terrainArr && !!biomeArr && !!moistureArr && !!vegArr && !!foodArr;
    if (bound && terrainArr![cell] === WATER) continue;
    if (!bound && tile.terrain === 'water') continue;
    // Neighbor water is an explicit, local moisture source (same four cells, same short-circuit order).
    const nearWater = waterAt(tile.x - 1, tile.y) || waterAt(tile.x + 1, tile.y) || waterAt(tile.x, tile.y - 1) || waterAt(tile.x, tile.y + 1);
    let moisture = bound ? moistureArr![cell]! : tile.moisture;
    let vegetation = bound ? vegArr![cell]! : tile.vegetation;
    let food = bound ? foodArr![cell]! : tile.food;
    const biomeCode = bound ? biomeArr![cell]! : 0;
    const biome = bound ? (biomeCode ? fast!.BIOME_NAMES[biomeCode - 1] : undefined) : tile.biome;
    if (seasonal) {
      const climate = climateFor(tile.x, tile.y);
      moisture = clamp(moisture + (world.weather === 'rain' ? 0.012 * climate.rainScale : 0) + (nearWater ? 0.008 : 0)
        - (0.0015 + light * 0.001) * climate.evapScale);
      tile.moisture = moisture;
      const K = biome === 'forest' ? capacidadBosque : biome === 'grassland' ? capacidadPastizal : capacidadOtros;
      const headroom = K > 0 ? 1 - vegetation / K : 0;
      const growth = velocidadRegeneracion * climate.growthScale * light * moisture * 0.007 * headroom;
      vegetation = clamp(vegetation + growth - (moisture < 0.15 ? 0.0015 : 0.0001));
      tile.vegetation = vegetation;
      const foodHeadroom = K > 0 ? 1 - food / K : 0;
      food = clamp(food + velocidadRegeneracion * climate.growthScale * light * moisture * vegetation * CRECIMIENTO_COMIDA * foodHeadroom - decaimientoComida);
      tile.food = food;
      continue;
    }
    moisture = clamp(moisture + (world.weather === 'rain' ? 0.012 : 0) + (nearWater ? 0.008 : 0) - 0.0015 - light * 0.001);
    tile.moisture = moisture;
    const K = biome === 'forest' ? capacidadBosque : biome === 'grassland' ? capacidadPastizal : capacidadOtros;
    const headroom = K > 0 ? 1 - vegetation / K : 0;
    const growth = velocidadRegeneracion * light * moisture * 0.007 * headroom;
    vegetation = clamp(vegetation + growth - (moisture < 0.15 ? 0.0015 : 0.0001));
    tile.vegetation = vegetation;
    const foodHeadroom = K > 0 ? 1 - food / K : 0;
    food = clamp(food + velocidadRegeneracion * light * moisture * vegetation * CRECIMIENTO_COMIDA * foodHeadroom - decaimientoComida);
    tile.food = food;
  }
}
