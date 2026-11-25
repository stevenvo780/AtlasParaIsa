/**
 * Leyes de romper (ARQ-materia §3.2): golpear un lote para desprender parte de él (talar, cavar, tallar, despiezar,
 * moler, extraer) y quemar la reserva para pagar un trabajo. Ninguna crea ni destruye átomos ni energía: romper solo
 * traslada materia y su calor entre lotes; quemar aplica la reacción balanceada de Q y deja el calor en el lote.
 */
import { EPS_TENACIDAD, FRACTURA } from '../../shared/naturaleza.js';
import type { SustanciaId } from '../../shared/materia.js';
import { DATO_GOLPEAR } from '../motor/contratos.js';
import { balanceada } from './copiar.js';
import { favorableA } from './quimica.js';
import { nivelDeLote, type ArenaMateria, type Kappa, type LoteRef, type ServicioQuimico } from './tipos.js';

/** Solo su signo cuenta para `nivelDeLote`: `quemar` no es cinético (la tasa la pone el trabajo pedido). */
const METABOLISMO: Kappa = [1, 1, 1, 1];

/**
 * J efectivos de un golpe (`dato` de un Golpear, `DATO_GOLPEAR`) sobre el blanco y sobre el útil que golpea:
 * P = trabajo·(1 + filo)·(1 + tenacidad·esbeltez), r = dureza útil/dureza blanco;
 * blanco: P·min(1, r²)/(tenacidad blanco + ε); útil (desgaste): P·min(1, r⁻²)·(1 − tenacidad útil).
 */
export function reparto(golpe: Float64Array, blanco: { dureza: number; tenacidad: number }): { blanco: number; util: number } {
  const g = DATO_GOLPEAR;
  const P = golpe[g.trabajo]! * (1 + golpe[g.filo]!) * (1 + golpe[g.tenacidad]! * golpe[g.esbeltez]!);
  const dA = golpe[g.dureza]!, dB = blanco.dureza;
  const r2 = dA === dB ? 1 : dB === 0 ? Infinity : (dA / dB) ** 2;
  return {
    blanco: P * Math.min(1, r2) / (blanco.tenacidad + EPS_TENACIDAD),
    util: P * Math.min(1, 1 / r2) * (1 - golpe[g.tenacidad]!),
  };
}

/** Golpea `blanco` y desprende lo que rompe hacia `fragmento` (el lote nuevo con la forma del patrón, que crea quien
 * golpea). Devuelve los cuantos desprendidos y los J de desgaste que el dueño del útil aplica con `desprender`. */
export function romper(arena: ArenaMateria, q: ServicioQuimico, blanco: LoteRef, fragmento: LoteRef,
  golpe: Float64Array, azar: () => number): { cuantos: number; desgaste: number } {
  const r = reparto(golpe, arena.vista(blanco));
  return { cuantos: desprender(arena, q, blanco, fragmento, r.blanco, azar), desgaste: r.util };
}

/**
 * Desprende de `de` hacia `a` la fracción f = min(1, j/cohesión) del lote, con cohesión = FRACTURA·Σ cuantos·D̄ de sus
 * sustancias (sale de la composición): la misma f de cada sustancia (misma química, redondeo entero insesgado con `azar`)
 * y la parte del calor de los átomos que se van, para que el fragmento salga a la misma T. Devuelve los cuantos movidos.
 */
export function desprender(arena: ArenaMateria, q: ServicioQuimico, de: LoteRef, a: LoteRef, j: number,
  azar: () => number): number {
  const ids = especies(arena, de);
  let cohesion = 0, atomos = 0;
  for (const id of ids) {
    const c = arena.cuantos(de, id), s = q.sustancia(id);
    cohesion += FRACTURA * c * s.prop.dMedia;
    atomos += c * atomosDe(s.atomos);
  }
  if (!(cohesion > 0 && j > 0)) return 0;
  const f = Math.min(1, j / cohesion);
  let movidos = 0, atomosMovidos = 0;
  for (const id of ids) {
    const x = arena.cuantos(de, id) * f, k = Math.floor(x) + (azar() < x - Math.floor(x) ? 1 : 0);
    if (k === 0) continue;
    const m = arena.mover({ de, a, esp: id, cuantos: k });
    movidos += m;
    atomosMovidos += m * atomosDe(q.sustancia(id).atomos);
  }
  // En bigint: calor·átomos pasa de 2⁵³ en lotes grandes y el doble redondearía el cociente.
  const calor = arena.calor(de);
  arena.moverCalor(de, a, Number(BigInt(calor) * BigInt(atomosMovidos) / BigInt(atomos)));
  return movidos;
}

/**
 * Quema por demanda (no Arrhenius): aplica en `lote` la reacción de Q de cada sustancia con `oxidante` (por id) tantas
 * veces como pide `trabajo` J, recortado a existencias, hasta pagarlo o agotar el oxidante. Cada vez lleva los
 * coeficientes que eligió Q (2 CH₂ + 3 O₂ → 2 CO₂ + 2 H₂O, enmienda 1): una reserva quema completa, sin soltar H₂. Solo usa reacciones
 * exotérmicas y balanceadas; las que Q no tiene aún (encoladas) no queman este tick. Con oxidante 0, que Q tomaría por
 * reacción unaria, no quema: ningún lote tiene cuantos de 0. El calor liberado queda en el lote (de ahí lo toman la
 * síntesis o fluir). Devuelve los J liberados: ≥ trabajo si alcanzó (sobra menos de una vez), menos si no.
 * Los productos son los del lote catalizado (el metabolismo es enzimático): nivel `nivelDeLote` con κ > 0, es decir,
 * nunca por debajo de NIVEL_CATALIZADO, como `pasoLote` en el tubo o en el suelo. Revisión de la enmienda 3 (hallazgo
 * 8): con `nivelDeT`, un cuerpo a 275 K quemaba el metanol con los productos del nivel 1 y su propio tubo, con κ > 0,
 * los elegía en el nivel 2.
 */
export function quemar(arena: ArenaMateria, q: ServicioQuimico, lote: LoteRef, oxidante: SustanciaId, trabajo: number): number {
  if (!(trabajo > 0)) return 0; // NaN: la arena no admite veces NaN
  let liberado = 0;
  const T = arena.vista(lote).T, nivel = nivelDeLote(T, METABOLISMO);
  for (const id of especies(arena, lote)) {
    if (liberado >= trabajo || arena.cuantos(lote, oxidante) === 0) break;
    if (id === oxidante) continue;
    const r = q.reaccion(id, oxidante, nivel);
    if (!r || r.dH >= 0 || !balanceada(q, r) || !favorableA(r, T, (s) => q.sustancia(s))) continue; // ΔG a la T real, como P
    const veces = Math.min(Number.MAX_SAFE_INTEGER, Math.ceil((trabajo - liberado) / -r.dH)); // la arena pide un entero seguro
    liberado -= r.dH * arena.aplicar(lote, r, veces);
  }
  return liberado;
}

/** Sustancias del lote por id: lo que ocurre no depende de en qué ranura de la arena está cada una. */
function especies(arena: ArenaMateria, l: LoteRef): Uint32Array {
  let ids = new Uint32Array(16), n = arena.especies(l, ids);
  if (n > ids.length) n = arena.especies(l, ids = new Uint32Array(n));
  return ids.subarray(0, n).sort();
}

const atomosDe = (a: Uint8Array) => a.reduce((s, v) => s + v, 0);
