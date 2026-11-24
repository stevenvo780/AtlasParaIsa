/**
 * Una carta para Isa — capas de mapa de selección múltiple (V24).
 *
 * Unifica en un solo control las capas que antes vivían duplicadas en «Explorar» (selector de una capa) y
 * «Calor» (ciclo con la tecla H). Módulo puro: el catálogo ordenado, las operaciones sobre el conjunto
 * activo (siempre devuelven un conjunto nuevo, nunca mutan) y el HTML del popover, con todo texto escapado.
 * `legacyCapa` enlaza cada capa con el identificador de `calor.ts` / `game.ts` (`Capa | 'humedad'`).
 */
import { esc } from './ui-catalog.js';

export type MapLayerId = 'food' | 'vegetation' | 'water' | 'fertility' | 'wood' | 'moisture' | 'geology' | 'roads' | 'activeRegions';

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

const IDS: ReadonlySet<string> = new Set(MAP_LAYER_CATALOG.map(layer => layer.id));
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
  const on = MAP_LAYER_CATALOG.filter(layer => active.has(layer.id));
  if (on.length === 0) return 'Capas';
  if (on.length <= 2) return on.map(layer => layer.short).join(' + ');
  return `${on[0]!.short} + ${on.length - 1} más`;
}

/** Popover con una casilla por capa (muestra de color + descripción) y el botón «Limpiar capas». */
export function renderLayersPopoverHtml(active: ReadonlySet<MapLayerId>): string {
  const items = MAP_LAYER_CATALOG.map(layer => {
    const checked = active.has(layer.id);
    return `<li><label class="layer-option"><input type="checkbox" data-layer="${esc(layer.id)}"${checked ? ' checked' : ''}>`
      + `<i class="layer-swatch" style="background:${esc(layer.color)}" aria-hidden="true"></i>`
      + `<span><strong>${esc(layer.label)}</strong><small>${esc(layer.description)}</small></span></label></li>`;
  }).join('');
  const count = MAP_LAYER_CATALOG.filter(layer => active.has(layer.id)).length;
  return `<div class="layers-popover" role="group" aria-label="Capas del mapa"><ul class="layer-list">${items}</ul>`
    + `<button type="button" class="button layers-clear" data-action="clear-layers"${count === 0 ? ' disabled' : ''}>Limpiar capas</button></div>`;
}
