/**
 * Contrato de la materia que comparten servidor y cliente (ARQ-materia §2 con PLAN-V23 §1.2): tipos de
 * enlace, sustancias tal como viajan y lo que la proyección manda de cada tesela y de cada lote con forma.
 * Los números están en `naturaleza.ts`; lo que solo vive en el servidor, en `world/materia/tipos.ts`.
 */
import { NE, ORDEN_MAX, PAULING, TABLA } from './naturaleza.js';

/** Átomos por unidad de fórmula: resolución de la representación, no tope de materia (lo grande son muchos cuantos). */
export const ATOMOS_POR_UNIDAD = 8;

/** u32 > 0 que asigna la química (Q): solo crece y nunca se reutiliza. 0 = ninguna. */
export type SustanciaId = number;

/** Molécula si puede existir sola como grafo conexo (`realizable`); si no, unidad de red. Antes `Clase` en ARQ-materia. */
export const ClaseSustancia = { Molecula: 1, Unidad: 2 } as const;
export type ClaseSustancia = (typeof ClaseSustancia)[keyof typeof ClaseSustancia];

/** Enlace entre los elementos e ≤ f (índices de `ELEMENTOS`) de orden k; d en J por cuanto, entero. */
export interface TipoEnlace { e: number; f: number; k: 1 | 2 | 3; d: number }

/**
 * Los tipos de enlace, derivados de `TABLA` (unos 52). Su índice es el `tipo` de `Sustancia.enlaces`, así que el
 * orden (e, luego f, luego k, crecientes) es parte de la identidad de toda sustancia.
 * Usan: Q (claves y energías), A, P y G (tablas), el cliente (nombres de enlace en la ficha).
 */
export const TIPOS: readonly TipoEnlace[] = (() => {
  const tipos: TipoEnlace[] = [];
  for (let e = 0; e < NE; e++) for (let f = e; f < NE; f++) {
    const a = TABLA[e]!, b = TABLA[f]!;
    const kMax = a.pi * b.pi > 0 ? Math.min(a.valencia, b.valencia, ORDEN_MAX) : 1;
    for (let k = 1; k <= kMax; k++) {
      // Cada par de electrones de un enlace múltiple se polariza por Δχ: sin `k`, C=O queda por debajo de 2·C–O
      // (el CO₂ polimerizaría en frío y la madera/carbón se apagarían en aire a 655/535 K).
      const d = (a.dPropia + b.dPropia) / 2 + k * PAULING * (a.chi - b.chi) ** 2 + (k - 1) * Math.sqrt(a.pi * b.pi);
      tipos.push({ e, f, k: k as TipoEnlace['k'], d: Math.round(d) });
    }
  }
  return tipos;
})();

/** Propiedades de una sustancia, derivadas de su estructura. Las calcula Q; las leen L, T1, P (vistas del lote) y la ficha del cliente. */
export interface Propiedades {
  r: number;            // coordinación media del núcleo (sin átomos de valencia 1)
  dMedia: number;       // J por cuanto: energía media de sus enlaces
  tFusion: number;      // K
  tEbullicion: number;  // K
  qOxidacion: number;   // J por cuanto que libera su oxidación completa (Hess)
  dureza: number;       // [0, 1]
  tenacidad: number;    // [0, 1]
  flexibilidad: number; // [0, 1]
  polaridad: number;    // [0, 1]
  densidad: number;     // kg/L en fase condensada (sólido/líquido); para gas a T, P usa gas ideal R·T/101,325 L/cuanto
  color: number;        // 0xRRGGBB
}

/** Sustancia tal como viaja: en `WorldView.sustancias` (solo las referenciadas) y en el catálogo de la cinta.
 * La arma la proyección (I2/V2) y el escritor de la cinta (C1a); la leen el cliente (V2, V3, V4) y el lector (C1b). */
export interface SustanciaVista {
  id: SustanciaId;
  clase: ClaseSustancia;
  atomos: number[];  // NE: átomos por elemento de una unidad de fórmula
  enlaces: number[]; // pares [tipo, cuenta] ordenados por tipo: la clave de la sustancia
  masa: number;      // mg por cuanto (g/mol)
  prop: Propiedades;
}

/** Forma de un lote con forma (objeto, cadáver, pieza): largo, ancho y grueso en m; hueco y filo en [0, 1].
 * La fijan L (romper con patrón), T1 y T2; la proyección la manda empaquetada con `codigoForma`. */
export interface Forma { largo: number; ancho: number; grueso: number; hueco: number; filo: number }

const NIVELES_CAMPO = 64;
const LONGITUD_MINIMA = 0.001;

/** Forma en un u32 de 30 bits (6 por campo): longitudes en escala log de razón 2^(1/3) desde 1 mm (0 = nula), hueco y filo lineales. */
export function codigoForma(f: Forma): number {
  const longitud = (v: number) => v <= 0 ? 0 : Math.min(63, Math.max(1, 1 + Math.round(3 * Math.log2(v / LONGITUD_MINIMA))));
  const fraccion = (v: number) => Math.min(63, Math.max(0, Math.round(v * 63)));
  const campos = [longitud(f.largo), longitud(f.ancho), longitud(f.grueso), fraccion(f.hueco), fraccion(f.filo)];
  return campos.reduce((codigo, q, i) => codigo + q * NIVELES_CAMPO ** i, 0);
}

/** Inversa de `codigoForma` (con la resolución del código). La usa el cliente (V3) para dibujar sin conocer átomos. */
export function formaDeCodigo(codigo: number): Forma {
  const campo = (i: number) => Math.floor(codigo / NIVELES_CAMPO ** i) % NIVELES_CAMPO;
  const longitud = (q: number) => q === 0 ? 0 : LONGITUD_MINIMA * 2 ** ((q - 1) / 3);
  return { largo: longitud(campo(0)), ancho: longitud(campo(1)), grueso: longitud(campo(2)), hueco: campo(3) / 63, filo: campo(4) / 63 };
}

/** `Tile.mat`: hasta 3 pares [sustancia, fracción de masa] de la superficie de la tesela, de mayor a menor.
 * Lo escribe la proyección desde W (ola 2); el cliente (V2) mezcla su color. Viaja junto a `Tile.T` (K). */
export type MatTesela = [SustanciaId, number][];

/** Lo visible de un lote con forma o de un cuerpo: lo que la proyección manda y el fotograma graba (la cinta no graba átomos).
 * Lo escriben la proyección y M6; lo lee el cliente (V3). */
export interface MateriaVisible { forma: number; principal: SustanciaId }
