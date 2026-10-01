/**
 * Brazo PLACEBO del laboratorio (METODO-SEGURIDAD-CAOS-20261001.md §2).
 *
 * El runner (scripts/lab/replica.ts) lo aplica UNA vez en el tick
 * t0 = 2·TICKS_PER_DAY + 7 sobre el mundo vivo: al mortal de menor id se le
 * sustituye una variable corporal continua por su vecina flotante (1 ulp),
 * hacia arriba en semillas pares y hacia abajo en impares. No cambia ninguna
 * regla, parámetro, recurso ni el calendario de lluvia: su único canal de
 * efecto es disparar antes o después algún umbral discreto (el canal del caos).
 *
 * Variable: `thirst` (float64 en [0,1], aritmética sin cuantizar en
 * src/world/body.ts, serialización exacta vía stringifyExact/JSON). Si el valor
 * está justo en el borde que la dirección de paridad abandonaría ([0,1] se
 * violaría y `assertBody` rechazaría el mundo), se recurre a `energy`,
 * `hunger` y `fatigue` en ese orden fijo, con la MISMA dirección de paridad.
 * Si ninguna admite la patada (frontera cuádruple exacta: imposible en la
 * práctica), se lanza un error en vez de correr un placebo silenciosamente nulo.
 */
import { TICKS_PER_DAY, type Person, type World } from '../../src/world/index.js';

/** Tick de la patada: t0 = 2400·d0 + 7 con d0 = 2 (fórmula literal del método §2.1). */
export const PLACEBO_TICK = 2 * TICKS_PER_DAY + 7;

export type PlaceboDireccion = 'up' | 'down';
export type PlaceboVariable = 'thirst' | 'energy' | 'hunger' | 'fatigue';

const VARIABLES: readonly PlaceboVariable[] = ['thirst', 'energy', 'hunger', 'fatigue'];

export interface PatadaPlacebo {
  tick: number; personaId: string; variable: PlaceboVariable;
  direccion: PlaceboDireccion; antes: number; despues: number;
}

/** Semillas pares: vecino siguiente; impares: anterior (método §2.1). */
export function placeboDireccion(seed: number): PlaceboDireccion {
  return seed % 2 === 0 ? 'up' : 'down';
}

const vista = new DataView(new ArrayBuffer(8));

/** Vecino flotante siguiente (1 ulp hacia +∞). Solo para finitos. */
export function nextUp(x: number): number {
  if (!Number.isFinite(x)) throw new RangeError('nextUp exige un finito.');
  if (x === 0) return Number.MIN_VALUE; // trata -0 como +0
  vista.setFloat64(0, x);
  const bits = vista.getBigUint64(0);
  vista.setBigUint64(0, x > 0 ? bits + 1n : bits - 1n);
  return vista.getFloat64(0);
}

/** Vecino flotante anterior (1 ulp hacia −∞). Solo para finitos. */
export function nextDown(x: number): number {
  if (!Number.isFinite(x)) throw new RangeError('nextDown exige un finito.');
  if (x === 0) return -Number.MIN_VALUE; // trata -0 como +0
  vista.setFloat64(0, x);
  const bits = vista.getBigUint64(0);
  vista.setBigUint64(0, x > 0 ? bits - 1n : bits + 1n);
  return vista.getFloat64(0);
}

/** Mortal (neighbor) vivo de menor id (lexicográfico; los id son cadenas). */
export function mortalMenorId(world: Pick<World, 'people'>): Person {
  let mejor: Person | null = null;
  for (const persona of world.people as Person[])
    if (persona.role === 'neighbor' && (mejor === null || persona.id < mejor.id)) mejor = persona;
  if (!mejor) throw new Error('Placebo sin mortal vivo al que patear.');
  return mejor;
}

/**
 * Aplica la patada ε al mundo vivo (mutación in situ, una sola vez).
 * `tick` debe ser PLACEBO_TICK; se registra tal cual en el parte.
 */
export function aplicarPlacebo(world: World, seed: number, tick: number): PatadaPlacebo {
  if (tick !== PLACEBO_TICK) throw new Error(`La patada placebo solo se aplica en el tick ${PLACEBO_TICK} (recibido ${tick}).`);
  const direccion = placeboDireccion(seed);
  const patear = direccion === 'up' ? nextUp : nextDown;
  const persona = mortalMenorId(world);
  for (const variable of VARIABLES) {
    const antes = persona[variable];
    if (typeof antes !== 'number' || !Number.isFinite(antes)) continue;
    const despues = patear(antes);
    if (despues < 0 || despues > 1) continue; // borde exacto: probar la siguiente variable
    persona[variable] = despues;
    return { tick, personaId: persona.id, variable, direccion, antes, despues };
  }
  throw new Error(`Placebo imposible en ${persona.id}: ninguna variable corporal admite 1 ulp ${direccion} dentro de [0,1].`);
}
