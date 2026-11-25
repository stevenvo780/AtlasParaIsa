/**
 * Una carta para Isa — capas de mapa de selección múltiple (V24).
 *
 * Unifica en un solo control las capas que antes vivían duplicadas en «Explorar» (selector de una capa) y
 * «Calor» (ciclo con la tecla H). Módulo puro: el catálogo ordenado, las operaciones sobre el conjunto
 * activo (siempre devuelven un conjunto nuevo, nunca mutan) y el HTML del popover, con todo texto escapado.
 * `legacyCapa` enlaza cada capa con el identificador de `calor.ts` / `game.ts` (`Capa | 'humedad'`).
 */
import { esc } from './ui-catalog.js';
import type { WorldView } from '../shared/types.js';

export type BaseLayerId = 'food' | 'vegetation' | 'water' | 'fertility' | 'wood' | 'moisture' | 'geology' | 'roads' | 'activeRegions';
/** V23: capas que solo existen si el mundo servido trae su dato (`reparto`, `aire`). */
export type CapaV23Id = 'hilos' | 'aire';
export type MapLayerId = BaseLayerId | CapaV23Id;

export interface MapLayerMeta {
  id: MapLayerId;
  label: string;
  /** Etiqueta corta para el resumen del botón. */
  short: string;
  /** Color de la muestra (hex). */
  color: string;
  description: string;
  /** Identificador de la capa equivalente en el sistema anterior (calor / observation-layer). */
  legacyCapa?: string;
}

export const MAP_LAYER_CATALOG: readonly MapLayerMeta[] = [
  { id: 'food', label: 'Comida', short: 'Comida', color: '#d9902f', description: 'Alimento disponible en cada casilla: frutos, raíces, caza y cultivos.', legacyCapa: 'comida' },
  { id: 'vegetation', label: 'Vegetación', short: 'Vegetación', color: '#4f9a3c', description: 'Densidad de plantas, hierba y bosque.', legacyCapa: 'vegetacion' },
  { id: 'water', label: 'Agua potable', short: 'Agua', color: '#3b86c9', description: 'Dónde se puede beber: ríos, lagos y manantiales.', legacyCapa: 'agua' },
  { id: 'fertility', label: 'Fertilidad', short: 'Fertilidad', color: '#8b5e34', description: 'Qué tan buena es la tierra para cultivar.', legacyCapa: 'fertilidad' },
  { id: 'wood', label: 'Madera', short: 'Madera', color: '#a8743d', description: 'Madera que se puede recoger para construir y fabricar.', legacyCapa: 'madera' },
  { id: 'moisture', label: 'Humedad', short: 'Humedad', color: '#5cb7c4', description: 'Humedad del suelo: más azul, más húmedo.', legacyCapa: 'humedad' },
  { id: 'geology', label: 'Geología', short: 'Geología', color: '#7d7a8c', description: 'Tipo de roca y minerales bajo el terreno.' },
  { id: 'roads', label: 'Caminos y calzadas', short: 'Caminos', color: '#b89a64', description: 'Senderos y calzadas que la gente ha gastado al pasar.', legacyCapa: 'caminos' },
  { id: 'activeRegions', label: 'Regiones activas', short: 'Regiones', color: '#c0586f', description: 'Zonas del mundo donde ahora hay vida y actividad.' },
];

/** V23: se ofrecen solo cuando la vista trae el dato (ver `capasV23Disponibles`); ausente, el control queda como hoy. */
export const CAPAS_V23: readonly MapLayerMeta[] = [
  { id: 'hilos', label: 'Hilos', short: 'Hilos', color: '#9b7fd1', description: 'Qué hilo del servidor simula cada página de 16×16 casillas: un color por hilo.' },
  { id: 'aire', label: 'Humedad del aire', short: 'Aire', color: '#7fb3d9', description: 'Humedad relativa del aire de cada página; donde llueve, más intensa.' },
];

const IDS: ReadonlySet<string> = new Set([...MAP_LAYER_CATALOG, ...CAPAS_V23].map(layer => layer.id));
const TODAS: readonly MapLayerMeta[] = [...MAP_LAYER_CATALOG, ...CAPAS_V23];

/** Qué capas V23 trae esta vista: «Hilos» con `reparto`, «Humedad del aire» con `aire`. */
export function capasV23Disponibles(world: Pick<WorldView, 'reparto' | 'aire'> | null | undefined): Set<CapaV23Id> {
  const out = new Set<CapaV23Id>();
  if (world?.reparto?.paginas.length) out.add('hilos');
  if (world?.aire && Object.keys(world.aire).length) out.add('aire');
  return out;
}

/** Catálogo que se ofrece: el de siempre y, detrás, las capas V23 disponibles. */
export function capasDelMapa(disponibles?: ReadonlySet<CapaV23Id>): MapLayerMeta[] {
  return disponibles?.size ? [...MAP_LAYER_CATALOG, ...CAPAS_V23.filter(c => disponibles.has(c.id as CapaV23Id))] : [...MAP_LAYER_CATALOG];
}

/** Proporción áurea de vuelta: tonos sucesivos quedan lo más separados posible sin lista cerrada de colores. */
const GIRO_AUREO = 0.6180339887498949;

/** Color [r, g, b] del dueño `dueno` en la capa «Hilos»: tono por giro áureo, saturación y luz fijas, cuantizado a la
 * paleta de 8 niveles por canal del pixel-art. El mismo dueño tiene el mismo color en vivo y en lo grabado. */
export function colorDeDueno(dueno: number): [number, number, number] {
  const h = (((dueno | 0) * GIRO_AUREO) % 1 + 1) % 1, s = .62, l = .55;
  const k = (n: number) => (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255 / 8) * 8));
  return [q(f(0)), q(f(8)), q(f(4))];
}
export const isMapLayerId = (value: unknown): value is MapLayerId => typeof value === 'string' && IDS.has(value);

/** Enciende la capa si estaba apagada y la apaga si estaba encendida. Un id desconocido no cambia nada. */
export function toggleLayer(active: ReadonlySet<MapLayerId>, id: MapLayerId): Set<MapLayerId> {
  const next = new Set(active);
  if (!isMapLayerId(id)) return next;
  if (!next.delete(id)) next.add(id);
  return next;
}

export function clearLayers(): Set<MapLayerId> { return new Set(); }

/** Texto del botón: «Capas», «Agua» o «Agua + Comida», y «Agua + 2 más» a partir de tres. En orden del catálogo. */
export function activeLayersSummary(active: ReadonlySet<MapLayerId>): string {
  const on = TODAS.filter(layer => active.has(layer.id));
  if (on.length === 0) return 'Capas';
  if (on.length <= 2) return on.map(layer => layer.short).join(' + ');
  return `${on[0]!.short} + ${on.length - 1} más`;
}

/** Popover con una casilla por capa (muestra de color + descripción) y el botón «Limpiar capas».
 * `disponibles`: capas V23 que trae la vista (sin ellas, el popover de siempre). */
export function renderLayersPopoverHtml(active: ReadonlySet<MapLayerId>, disponibles?: ReadonlySet<CapaV23Id>): string {
  const catalogo = capasDelMapa(disponibles);
  const items = catalogo.map(layer => {
    const checked = active.has(layer.id);
    return `<li><label class="layer-option"><input type="checkbox" data-layer="${esc(layer.id)}"${checked ? ' checked' : ''}>`
      + `<i class="layer-swatch" style="background:${esc(layer.color)}" aria-hidden="true"></i>`
      + `<span><strong>${esc(layer.label)}</strong><small>${esc(layer.description)}</small></span></label></li>`;
  }).join('');
  const count = catalogo.filter(layer => active.has(layer.id)).length;
  return `<div class="layers-popover" role="group" aria-label="Capas del mapa"><ul class="layer-list">${items}</ul>`
    + `<button type="button" class="button layers-clear" data-action="clear-layers"${count === 0 ? ' disabled' : ''}>Limpiar capas</button></div>`;
}
