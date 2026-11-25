/** Campo climático regional puro: hash entero, ruido suave y fase estacional sin estado ni RNG; y el sorteo del tiempo. */
import type { ChronicleEvent } from '../shared/types.js';
import { PROB_LLUVIA } from './ecologia-constantes.js';

const HASH_SALT = 0x6d2b79f5;
const TAU = 2 * Math.PI;

function hash(seed: number, x: number, y: number): number {
  let value = seed ^ HASH_SALT ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}
const unit = (seed: number, x: number, y: number): number => hash(seed, x, y) / 0x1_0000_0000;
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function spatialNoise(seed: number, x: number, y: number, scale: number): number {
  const gx = Math.floor(x / scale), gy = Math.floor(y / scale);
  const fx = fade((x - gx * scale) / scale), fy = fade((y - gy * scale) / scale);
  const a = lerp(unit(seed, gx, gy), unit(seed, gx + 1, gy), fx);
  const b = lerp(unit(seed, gx, gy + 1), unit(seed, gx + 1, gy + 1), fx);
  return lerp(a, b, fy) * 2 - 1;
}

/**
 * Regional seasonal forcing. The spatial field shifts the phase continuously; paired sine/cosine
 * components have zero temporal mean, so external rain and evaporation retain a mean of one.
 */
export function regionalClimateFactor(seed: number, tick: number, x: number, y: number,
  amplitud: number, periodoDias = 20, escalaCeldas = 64): { rainScale: number; evapScale: number; growthScale: number } {
  if (amplitud === 0) return { rainScale: 1, evapScale: 1, growthScale: 1 };
  if (!Number.isFinite(amplitud) || amplitud < 0 || amplitud > 1
    || !Number.isSafeInteger(tick) || !Number.isFinite(x) || !Number.isFinite(y)
    || !Number.isSafeInteger(periodoDias) || periodoDias <= 0
    || !Number.isSafeInteger(escalaCeldas) || escalaCeldas <= 0) throw new RangeError('Invalid regional climate input');
  const period = periodoDias * 2400;
  const regionalPhase = spatialNoise(seed, x, y, escalaCeldas) * 0.25;
  const phase = TAU * ((tick % period) / period + regionalPhase);
  const seasonal = Math.sin(phase);
  const productive = Math.cos(phase);
  return {
    rainScale: 1 + amplitud * seasonal,
    evapScale: 1 - amplitud * seasonal,
    growthScale: 1 + amplitud * productive,
  };
}

/**
 * El tiempo del mundo: cada INTERVALO_TIEMPO_TICKS se sortea si llueve (`sorteo` uniforme en [0, 1), contra PROB_LLUVIA) y
 * el cambio se cuenta en la crónica con `avisar`. Lo usan la ecología escalar (con el azar guardado del mundo) y el
 * mundo material (con el azar del dueño y, como causa, de dónde sale el agua que llueve).
 */
export function sortearTiempo(world: { weather: 'clear' | 'rain' }, sorteo: number, avisar: (e: Omit<ChronicleEvent, 'id' | 'tick'>) => void,
  cause = 'Cambio de tiempo del generador guardado; la lluvia aporta agua, no alimento instantáneo.'): void {
  const previous = world.weather;
  world.weather = sorteo < PROB_LLUVIA ? 'rain' : 'clear';
  if (world.weather !== previous) avisar({
    kind: 'ecology', actors: [], source: 'simulation',
    text: world.weather === 'rain' ? 'La lluvia humedece la tierra; el alimento crecerá si también hay luz.' : 'La lluvia deja paso al cielo abierto.',
    cause,
  });
}
