import type { Tile } from '../../shared/types.js';

export const clamp = (n: number, max = 1): number => Math.max(0, Math.min(max, n));

export const distance = (a: Point, b: Point): number => HYPOT2_EXACT ? hypot2(a.x - b.x, a.y - b.y) : Math.hypot(a.x - b.x, a.y - b.y);

export interface Point { x: number; y: number; }

export type TileLookup = (x: number, y: number) => Tile | undefined;

/** `Math.hypot(x, y)` reserva un arreglo interno en cada llamada. Con dos argumentos la suma de
 * Kahan de V8 se reduce a estas mismas operaciones IEEE; si alguna muestra difiere, se usa `Math.hypot`. */
function hypot2(x: number, y: number): number {
  const ax = Math.abs(x), ay = Math.abs(y);
  if (ax === Infinity || ay === Infinity) return Infinity;
  if (x !== x || y !== y) return NaN;
  const max = ax > ay ? ax : ay;
  if (max === 0) return 0;
  const a = ax / max, b = ay / max;
  return Math.sqrt(a * a + b * b) * max;
}

const HYPOT2_EXACT = (() => {
  let state = 0x9e3779b9;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const samples: [number, number][] = [[0, 0], [-0, 0], [0, -0], [3, 4], [NaN, 1], [1, NaN], [Infinity, NaN], [-Infinity, 2], [5e-324, 0], [1e308, 1e308]];
  for (let i = 0; i < 256; i++) samples.push([(next() - 0.5) * 80, (next() - 0.5) * 80], [Math.floor(next() * 400) - 200, Math.floor(next() * 400) - 200]);
  return samples.every(([x, y]) => Object.is(hypot2(x, y), Math.hypot(x, y)));
})();
