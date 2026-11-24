/**
 * Fluir (ARQ-materia §3.2, carril P): materia y calor entre dos lotes del mismo dueño. Cada arista es un par RC: el
 * potencial de un lote es lo que tiene entre su capacidad y el flujo es G·(ψ_de − ψ_a + empuje). Se integra en forma
 * cerrada sobre dt (relajación exponencial hacia el equilibrio), así que nunca cruza el equilibrio por grande que sea
 * G·dt. Lo movido es entero (redondeo estocástico con el azar del hilo) y pasa por la arena, que lo conserva exacto (I2).
 * A menos de un cuanto (o un julio) del equilibrio no se mueve nada: es el equilibrio discreto. Sin él el último cuanto
 * iría y volvería en cada llamada; con medio cuanto no basta, porque la coma flotante deja el medio exacto a un lado en
 * los dos sentidos. Lo movido (≤ ⌈equilibrio⌉) siempre deja al otro lado menos de un cuanto, así que no vuelve.
 *
 * La geometría es de quien llama (W): área, barreras (Π(1 − sellado), Π(1 − aislamiento)), movilidad por fase y desnivel
 * van ya en `g` y en `empuje`. La capacidad es la del compartimento y no la de lo que contiene: para gases y disueltos,
 * su volumen geométrico (ψ = concentración, así que un lote vacío se llena y uno con más gas empuja); para el agua por
 * pendiente, su área en planta entre su volumen molar (ψ = altura), y el empuje es la diferencia de cota. `medir(…).V` no
 * sirve: es el volumen de lo que hay a una atmósfera, 0 en un lote vacío y proporcional a lo que hay de gas.
 */
import { CAPACIDAD_ATOMO } from '../../shared/naturaleza.js';
import { Parte, type LoteRef } from './tipos.js';
import type { SustanciaId } from '../../shared/materia.js';
import { medir, type CtxPaso } from './paso.js';

/** Entero con esperanza x (⌊x⌋ más un uniforme): sin sesgo hacia el flujo nulo en gradientes pequeños. */
const entero = (x: number, azar: () => number): number => {
  const piso = Math.floor(x);
  return piso + (azar() < x - piso ? 1 : 0);
};

/** Mueve `esp` entre `de` y `a` durante dt con conductancia `g` (capacidad por tick) y devuelve los cuantos movidos de
 * `de` a `a` (negativo si fueron al revés). Arrastran su parte del calor (`moverParte`, Exacta). */
export function fluir(c: CtxPaso, de: LoteRef, a: LoteRef, esp: SustanciaId,
  g: number, capDe: number, capA: number, empuje: number, dt: number): number {
  if (!(g > 0 && capDe > 0 && capA > 0)) return 0;
  const nDe = c.arena.cuantos(de, esp), nA = c.arena.cuantos(a, esp);
  // Cuantos que dejan ψ_de + empuje = ψ_a.
  const equilibrio = (nDe * capA - nA * capDe + empuje * capDe * capA) / (capDe + capA);
  if (!(Math.abs(equilibrio) >= 1)) return 0;
  const x = equilibrio * -Math.expm1(-g * dt * (1 / capDe + 1 / capA));
  const n = Math.max(-nA, Math.min(nDe, entero(x, c.azar)));
  if (n > 0) return c.arena.moverParte(de, a, { parte: Parte.Exacta, esp, cuantos: n, kappa: null });
  if (n < 0) return -c.arena.moverParte(a, de, { parte: Parte.Exacta, esp, cuantos: -n, kappa: null });
  return 0;
}

/** Conduce calor entre `i` y `j` durante dt con conductancia `g` (J/(K·tick)) y devuelve los J que pasaron de i a j. */
export function fluirCalor(c: CtxPaso, i: LoteRef, j: LoteRef, g: number, dt: number): number {
  if (!(g > 0)) return 0;
  const ci = CAPACIDAD_ATOMO * medir(c, i).atomos;
  const cj = CAPACIDAD_ATOMO * medir(c, j).atomos;
  if (ci === 0 || cj === 0) return 0;
  const qi = c.arena.calor(i), qj = c.arena.calor(j);
  // J que igualan las temperaturas, relajados con la constante de tiempo del par.
  const equilibrio = (qi * cj - qj * ci) / (ci + cj);
  if (!(Math.abs(equilibrio) >= 1)) return 0;
  const q = entero(equilibrio * -Math.expm1(-g * dt * (1 / ci + 1 / cj)), c.azar);
  if (q > 0) return c.arena.moverCalor(i, j, Math.min(q, qi));
  if (q < 0) return -c.arena.moverCalor(j, i, Math.min(-q, qj));
  return 0;
}
