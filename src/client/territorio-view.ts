/**
 * M10: territorio que crece. Regiones exploradas (todas las que alguien descubrió), activas (las que el
 * servidor simula ahora, cerca de los habitantes) y asentamientos; sus curvas desde `stats.history`; y
 * las medidas de agua y comida que ya viajaban en `stats` con el paso en que se midieron (`statsTick`).
 */
import type { WorldView } from '../shared/types.js';
import { esc, number } from './ui-catalog.js';
import { sparkline, statCard } from './charts.js';

/** HUD: «13 regiones activas · 7 descubiertas · 1 asentamiento». Activas puede superar a descubiertas: el
 * servidor mantiene vivas también las regiones vecinas de los habitantes, aunque nadie haya entrado en ellas. */
export function rotuloTerritorio(view: Pick<WorldView, 'infinite' | 'discoveredChunks' | 'activeChunks' | 'settlementCount'>): { texto: string; ayuda: string } {
  if (!view.infinite) return { texto: 'Región inicial', ayuda: 'El mundo todavía es su región inicial.' };
  const exploradas = view.discoveredChunks ?? 0, activas = view.activeChunks, asentamientos = view.settlementCount ?? 0;
  return {
    texto: `${activas !== undefined ? `${number(activas)} ${activas === 1 ? 'región activa' : 'regiones activas'} · ${number(exploradas)} ${exploradas === 1 ? 'descubierta' : 'descubiertas'}` : `${number(exploradas)} ${exploradas === 1 ? 'región descubierta' : 'regiones descubiertas'}`} · ${number(asentamientos)} ${asentamientos === 1 ? 'asentamiento' : 'asentamientos'}`,
    ayuda: 'Una región son 16 × 16 casillas. Activas: las que el servidor simula ahora, alrededor de los habitantes (también las vecinas que nadie ha pisado); el resto descansa con su estado guardado. Descubiertas: aquellas en las que alguien entró. Asentamientos: construcciones levantadas.',
  };
}

const pct = (v: number | undefined): string => v !== undefined && Number.isFinite(v) ? `${number(v * 100)} %` : '—';

/** Mundo › Paisaje: el territorio y el agua, con su paso de medida. */
export function seccionTerritorio(view: WorldView): string {
  const stats = view.stats; if (!stats) return '';
  const history = stats.history ?? [];
  const medido = stats.statsTick !== undefined ? `medido en el paso ${number(stats.statsTick)}` : 'medida periódica';
  const distancia = stats.distanciaMediaAgua;
  const agua = distancia === undefined ? '—' : distancia < 0 ? 'sin agua potable' : `${number(distancia, 1)} casillas`;
  return `<section class="stats-section" data-territory><div class="stats-section-heading"><h3>Territorio</h3><span>Crece al explorar</span></div><div class="stats-chart-grid">${sparkline(history.map(p => ({ tick: p.tick, value: p.discoveries })), 'Regiones descubiertas', 'regiones')}${sparkline(history.map(p => ({ tick: p.tick, value: p.settlements })), 'Asentamientos', 'asentamientos')}</div></section>`
    + `<section class="stats-section" data-water-food><div class="stats-section-heading"><h3>Agua y comida en las regiones activas</h3><span>${esc(medido)}</span></div><div class="stats-grid">${statCard('Agua potable a', agua, 'Distancia media desde tierra hasta agua potable conectada; el mar no cuenta')}${statCard('Regiones sin agua', pct(stats.regionesSinAgua), 'Regiones con tierra y ninguna casilla de agua potable')}${statCard('Casillas con comida', pct(stats.fraccionCeldasConComida), 'Fracción de casillas activas con alimento')}${statCard('Reparto de comida (Gini)', stats.giniRecursosPorRegion !== undefined ? number(stats.giniRecursosPorRegion, 2) : '—', '0 = igual en todas las regiones; 1 = todo en una')}</div></section>`;
}
