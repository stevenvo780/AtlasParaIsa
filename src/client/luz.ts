import { TICKS_PER_DAY, phaseAt } from '../world/index.js';
import { localRandom } from '../world/genetics.js';

export type Phase = 'dawn' | 'day' | 'dusk' | 'night';
export interface Tinte { r: number; g: number; b: number; a: number; }
export interface Sombra { dx: number; dy: number; alpha: number; }
export interface Particula { dx: number; dy: number; alpha: number; }

const PHASE_ORDER: readonly Phase[] = ['dawn', 'day', 'dusk', 'night'];

/**
 * [inicio, fin) de cada fase en ticks-del-día. Se deriva barriendo `phaseAt` una sola vez al
 * cargar el módulo en vez de copiar sus cortes (300/1500/1800) a mano: si esos cortes cambian
 * en `src/world/index.ts`, este pase de luz queda sincronizado sin tocarlo.
 */
const PHASE_BOUNDS: Record<Phase, readonly [number, number]> = (() => {
  const bounds = {} as Record<Phase, [number, number]>;
  let current = phaseAt(0), start = 0;
  for (let t = 1; t <= TICKS_PER_DAY; t++) {
    const next = t < TICKS_PER_DAY ? phaseAt(t) : phaseAt(0);
    if (next !== current) { bounds[current] = [start, t]; start = t; current = next; }
  }
  return bounds;
})();

/** Color propio de cada fase; el pico que se alcanza a mitad de su ventana. */
const PHASE_TINT: Record<Phase, Tinte> = {
  dawn: { r: 255, g: 196, b: 140, a: 0.26 },
  day: { r: 255, g: 250, b: 235, a: 0.04 },
  dusk: { r: 240, g: 140, b: 80, a: 0.30 },
  night: { r: 35, g: 48, b: 96, a: 0.42 },
};

const average = (a: Tinte, b: Tinte): Tinte => ({ r: (a.r + b.r) / 2, g: (a.g + b.g) / 2, b: (a.b + b.b) / 2, a: (a.a + b.a) / 2 });
const mix = (from: Tinte, to: Tinte, f: number): Tinte => {
  const s = f * f * (3 - 2 * f);
  return { r: from.r + (to.r - from.r) * s, g: from.g + (to.g - from.g) * s, b: from.b + (to.b - from.b) * s, a: from.a + (to.a - from.a) * s };
};

/**
 * Tinte de superposición para la fase recibida, continuo dentro de ella y en sus dos bordes:
 * en cada borde el valor es el PROMEDIO con la fase vecina (misma fórmula de los dos lados),
 * así la fase saliente y la entrante coinciden exactamente en el tick donde `phaseAt` cambia.
 * Amanecer cálido, día casi neutro, atardecer naranja, noche azul profunda con alpha ≤ 0,45.
 */
export function tinteDeFase(phase: Phase, tick: number): Tinte {
  const index = PHASE_ORDER.indexOf(phase);
  const own = PHASE_TINT[phase];
  const low = average(PHASE_TINT[PHASE_ORDER[(index + 3) % 4]!], own);
  const high = average(own, PHASE_TINT[PHASE_ORDER[(index + 1) % 4]!]);
  const [start, end] = PHASE_BOUNDS[phase];
  const t = tick % TICKS_PER_DAY;
  const u = Math.max(0, Math.min(1, (t - start) / (end - start)));
  return u < 0.5 ? mix(low, own, u * 2) : mix(own, high, (u - 0.5) * 2);
}

const SUN_START = PHASE_BOUNDS.dawn[0], SUN_END = PHASE_BOUNDS.dusk[1], SUN_SPAN = SUN_END - SUN_START;
const SHADOW_REACH = 10, SHADOW_MAX_ALPHA = 0.4;

/**
 * Sombra proyectada de árboles y personas: nula de noche (sin sol, sin sombra direccional);
 * larga al principio/final de la ventana con sol (amanecer/atardecer, ángulo rasante) y corta
 * al mediodía solar. `elevation` es 0 en los dos extremos de [dawn,dusk] y 1 al mediodía solar;
 * `magnitude` es la parábola 4·e·(1−e), que vale 0 en ambos extremos Y en el mediodía solar,
 * dando dos lóbulos de sombra larga (media mañana, media tarde) sin discontinuidad con la noche.
 */
export function sombraLarga(phase: Phase, tick: number): Sombra {
  if (phase === 'night') return { dx: 0, dy: 0, alpha: 0 };
  const t = tick % TICKS_PER_DAY;
  const angle = ((t - SUN_START) / SUN_SPAN) * Math.PI;
  const elevation = Math.sin(angle);
  const magnitude = 4 * elevation * (1 - elevation);
  return { dx: -Math.cos(angle) * SHADOW_REACH * magnitude, dy: SHADOW_REACH * 0.35 * magnitude, alpha: SHADOW_MAX_ALPHA * magnitude };
}

/**
 * Brillo del agua en (x,y): 0..1, seno de baja frecuencia con desfase determinista por celda
 * (hash de x,y vía `localRandom`, sin estado del mundo) para que celdas vecinas no titilen
 * en fase. Con lluvia el período se acorta (ondas más cortas y frecuentes).
 */
export function brilloAgua(tick: number, x: number, y: number, weather: 'clear' | 'rain'): number {
  const period = weather === 'rain' ? 90 : 240;
  const offset = localRandom(x | 0, `agua:${y | 0}`)() * Math.PI * 2;
  const wave = Math.sin((tick % period) / period * Math.PI * 2 + offset);
  return 0.5 + 0.5 * wave;
}

/**
 * Partículas de humo de un hogar: 3–5, número fijo por `seed` (una vivienda no cambia de
 * chimenea tick a tick); cada una sube y se desvanece en un ciclo propio (70–109 ticks) con
 * fase inicial propia para que no asciendan sincronizadas. El reinicio de ciclo ocurre con
 * `alpha` en 0 (envolvente seno, nula en ambos extremos del ciclo), así el salto de posición
 * al reciclar la partícula queda invisible.
 */
export function humoDeHogar(tick: number, seed: number): Particula[] {
  const draw = (salt: string) => localRandom(seed, salt)();
  const count = 3 + Math.floor(draw('humo:n') * 3);
  return Array.from({ length: count }, (_, i) => {
    const cycle = 70 + Math.floor(draw(`humo:${i}:ciclo`) * 40);
    const offset = Math.floor(draw(`humo:${i}:fase`) * cycle);
    const sway = draw(`humo:${i}:vaiven`) - 0.5;
    const progress = ((tick + offset) % cycle) / cycle;
    const envelope = Math.sin(Math.PI * progress);
    return { dx: sway * 3 * Math.sin(progress * Math.PI * 2), dy: -progress * 12, alpha: envelope * 0.35 };
  });
}
