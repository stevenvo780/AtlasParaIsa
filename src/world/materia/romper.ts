/**
 * Leyes de romper (ARQ-materia §3.2): golpear un lote para desprender parte de él (talar, cavar, tallar, despiezar,
 * moler, extraer) y quemar la reserva para pagar un trabajo. Ninguna crea ni destruye átomos ni energía: romper solo
 * traslada materia y su calor entre lotes; quemar aplica la reacción balanceada de Q y deja el calor en el lote.
 */
import { EPS_TENACIDAD } from '../../shared/naturaleza.js';
import type { SustanciaId } from '../../shared/materia.js';
import { DATO_GOLPEAR } from '../motor/contratos.js';
import { balanceada } from './copiar.js';
import { nivelDeT, type ArenaMateria, type LoteRef, type ServicioQuimico } from './tipos.js';

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
 * Desprende de `de` hacia `a` la fracción f = min(1, j/cohesión) del lote, con cohesión = Σ cuantos·D̄ de sus sustancias
 * (sale de la composición): la misma f de cada sustancia (misma química, redondeo entero insesgado con `azar`) y la
 * parte del calor de los átomos que se van, para que el fragmento salga a la misma T. Devuelve los cuantos movidos.
 */
export function desprender(arena: ArenaMateria, q: ServicioQuimico, de: LoteRef, a: LoteRef, j: number,
  azar: () => number): number {
  const ids = especies(arena, de);
  let cohesion = 0, atomos = 0;
  for (const id of ids) {
    const c = arena.cuantos(de, id), s = q.sustancia(id);
    cohesion += c * s.prop.dMedia;
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
  const calor = arena.calor(de);
  arena.moverCalor(de, a, atomosMovidos === atomos ? calor : Math.floor(calor * atomosMovidos / atomos));
  return movidos;
}

/**
 * Quema por demanda (no Arrhenius): aplica en `lote` la reacción de Q de cada sustancia con `oxidante` (en el orden de la
 * arena) tantas veces como pide `trabajo` J, recortado a existencias, hasta pagarlo. Solo usa reacciones exotérmicas y
 * balanceadas; las que Q no tiene aún (encoladas) no queman este tick. El calor liberado queda en el lote (de ahí lo
 * toman la síntesis o fluir). Devuelve los J liberados: ≥ trabajo si alcanzó (sobra menos de una vez), menos si no.
 */
export function quemar(arena: ArenaMateria, q: ServicioQuimico, lote: LoteRef, oxidante: SustanciaId, trabajo: number): number {
  let liberado = 0;
  const nivel = nivelDeT(arena.vista(lote).T);
  for (const id of especies(arena, lote)) {
    if (liberado >= trabajo) break;
    if (id === oxidante) continue;
    const r = q.reaccion(id, oxidante, nivel);
    if (!r || r.dH >= 0 || !balanceada(q, r)) continue;
    liberado -= r.dH * arena.aplicar(lote, r, Math.ceil((trabajo - liberado) / -r.dH));
  }
  return liberado;
}

function especies(arena: ArenaMateria, l: LoteRef): Uint32Array {
  let ids = new Uint32Array(16), n = arena.especies(l, ids);
  if (n > ids.length) n = arena.especies(l, ids = new Uint32Array(n));
  return ids.subarray(0, n);
}

const atomosDe = (a: Uint8Array) => a.reduce((s, v) => s + v, 0);
