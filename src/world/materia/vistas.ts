/**
 * Vistas del mundo material (carril W, etapa 1): funciones puras que, de los lotes de una tesela, dan los escalares que
 * hoy leen las leyes (`Tile` de shared/types.ts y LAYOUT de soa/terreno.ts): agua potable, humedad, vegetación,
 * alimento, madera y piedra. No escriben nada; la etapa siguiente las usará para volcar los escalares en las teselas.
 *
 * La Vida de una tesela es un solo lote (la arena no admite dos del mismo rol en una celda) con tres órganos que se
 * distinguen por su composición: hoja (la cobertura, `vegetation`), fruto (lo comestible, `food`) y tronco (`wood`).
 * Crecen y caen siempre por unidades enteras de su plantilla, así que la composición es una combinación entera exacta
 * de las tres unidades y se descompone resolviendo un sistema 3 × 3 en tres sustancias marcadoras.
 */
import type { SustanciaId } from '../../shared/materia.js';
import type { LoteRef } from './tipos.js';

/** Cuantos (o unidades de plantilla) que vale una unidad de cada escalar de la tesela. */
export interface Escalas {
  agua: number;       // cuantos de H₂O del lote Agua por unidad de `drinkingWater`
  humedad: number;    // cuantos de H₂O del Suelo por unidad de `moisture`
  vegetacion: number; // unidades de hoja por unidad de `vegetation`
  alimento: number;   // unidades de fruto por unidad de `food`
  madera: number;     // unidades de tronco por unidad de `wood`
  piedra: number;     // cuantos de roca latente por unidad de `stone`
}

/** Sustancias marcadoras (filas) y cuantos de cada una por unidad de cada órgano (columnas). */
export interface Organos {
  marcas: readonly [SustanciaId, SustanciaId, SustanciaId];
  hoja: readonly [number, number, number];
  fruto: readonly [number, number, number];
  tronco: readonly [number, number, number];
}

export interface Unidades { hoja: number; fruto: number; tronco: number }

export interface LotesTesela { suelo: LoteRef; agua: LoteRef /* −1: sin charca */; vida: LoteRef; latente: number }

export interface VistaTesela {
  drinkingWater: number; moisture: number; vegetation: number; food: number; wood: number; stone: number;
}

export type Cuantos = (l: LoteRef, id: SustanciaId) => number;

const det3 = (a: readonly number[], b: readonly number[], c: readonly number[]) =>
  a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - b[0]! * (a[1]! * c[2]! - a[2]! * c[1]!) + c[0]! * (a[1]! * b[2]! - a[2]! * b[1]!);

/** Unidades de cada órgano en el lote Vida `l` (regla de Cramer; exactas mientras solo se mueven unidades enteras). */
export function unidadesVida(cuantos: Cuantos, l: LoteRef, o: Organos, out: Unidades): Unidades {
  const y = [cuantos(l, o.marcas[0]), cuantos(l, o.marcas[1]), cuantos(l, o.marcas[2])];
  const d = det3(o.hoja, o.fruto, o.tronco);
  out.hoja = Math.max(0, Math.round(det3(y, o.fruto, o.tronco) / d));
  out.fruto = Math.max(0, Math.round(det3(o.hoja, y, o.tronco) / d));
  out.tronco = Math.max(0, Math.round(det3(o.hoja, o.fruto, y) / d));
  return out;
}

/** Los escalares de hoy reconstruidos de los lotes de una tesela. */
export function vistaTesela(cuantos: Cuantos, t: LotesTesela, agua: SustanciaId, e: Escalas, o: Organos,
  out: VistaTesela, u: Unidades): VistaTesela {
  unidadesVida(cuantos, t.vida, o, u);
  out.drinkingWater = t.agua >= 0 ? cuantos(t.agua, agua) / e.agua : 0;
  out.moisture = cuantos(t.suelo, agua) / e.humedad;
  out.vegetation = u.hoja / e.vegetacion;
  out.food = u.fruto / e.alimento;
  out.wood = u.tronco / e.madera;
  out.stone = t.latente / e.piedra;
  return out;
}

export const vistaVacia = (): VistaTesela => ({ drinkingWater: 0, moisture: 0, vegetation: 0, food: 0, wood: 0, stone: 0 });
export const unidadesVacias = (): Unidades => ({ hoja: 0, fruto: 0, tronco: 0 });
