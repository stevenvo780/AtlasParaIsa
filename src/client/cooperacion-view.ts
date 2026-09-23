/**
 * M7: cooperación por tipo y desacuerdos con quién cedió y por qué. Módulo puro sobre el estado real:
 * `stats.totals` (society.ts: cada cooperación suma a `cooperation` y, según su estrategia, a
 * `teaching`, `trade` o `constructionHelp` —ninguno si aporta material—; un turno solo suma a
 * `cooperation`), `technology.dynamics.shared`, `stats.inventionDynamics.foodStored/foodTaken`,
 * `performance.comidaCompartida` (Σ encuentros de los lugares vivos) y los episodios que recibió este
 * navegador. Una resta que la identidad no sostenga no se dibuja.
 */
import type { ChronicleEvent, WorldView } from '../shared/types.js';
import { esc, number } from './ui-catalog.js';
import { clasificar, momento, quienCedio } from './cronica.js';
import { enClaro } from './textos.js';
import { personLink } from './world-evidence.js';

export interface Juntos { ensenanzas: number; recetasEnsenadas: number | null; trueques: number; ayudas: number; aportesYTurnos: number | null; cooperacion: number }

/** Desglose de `cooperation` por tipo. `aportesYTurnos` = cooperation − teaching − trade − constructionHelp,
 * solo si no es negativo (un mundo migrado cuyos contadores no empezaron juntos no la sostiene). */
export function desglose(view: Pick<WorldView, 'stats' | 'technology'>): Juntos | null {
  const t = view.stats?.totals; if (!t) return null;
  const cooperacion = t.cooperation ?? 0, ensenanzas = t.teaching ?? 0, trueques = t.trade ?? 0, ayudas = t.constructionHelp ?? 0;
  const resto = cooperacion - ensenanzas - trueques - ayudas;
  return { cooperacion, ensenanzas, trueques, ayudas, aportesYTurnos: resto >= 0 ? resto : null, recetasEnsenadas: view.technology?.dynamics.shared ?? null };
}

const fila = (label: string, value: number, maximum: number, note: string, key: string): string =>
  `<div class="distribution-row" data-together="${key}"><div><span>${esc(label)}</span><strong>${esc(number(value))}</strong></div><span class="distribution-track" aria-hidden="true"><i style="width:${(maximum > 0 ? value / maximum * 100 : 0).toFixed(2)}%"></i></span><small class="distribution-note">${esc(note)}</small></div>`;

/** Mundo › Vida › «Lo que han hecho juntos». `recibidos`: episodios de esta visita (búfer de la crónica). */
export function seccionJuntos(view: WorldView, recibidos: readonly ChronicleEvent[]): string {
  const d = desglose(view);
  if (!d) return '';
  const compartidaVista = recibidos.filter(event => event.kind === 'care').length;
  const compartidaVivos = view.performance?.comidaCompartida;
  const dinamica = view.stats?.inventionDynamics;
  const filas: [string, number, string, string][] = [
    ['Enseñanzas', d.ensenanzas, d.recetasEnsenadas !== null ? `De ellas, ${number(d.recetasEnsenadas)} ${d.recetasEnsenadas === 1 ? 'receta pasada' : 'recetas pasadas'} a otra persona; el resto, técnicas practicadas.` : 'Recetas y técnicas mostradas a alguien cerca.', 'teaching'],
    ['Trueques', d.trueques, 'Madera por piedra, u objetos a cambio de material.', 'trade'],
    ['Ayuda en obras y cacerías', d.ayudas, 'Trabajo aportado a la obra o a la caza de otra persona.', 'help'],
  ];
  if (d.aportesYTurnos !== null) filas.push(['Aportes de material y turnos', d.aportesYTurnos, 'Unidades de madera o piedra aportadas y turnos acordados ante una fuente escasa.', 'supply']);
  const maximum = Math.max(1, ...filas.map(f => f[1]));
  const comida = `<div class="stats-facts" data-shared-food>${compartidaVivos !== undefined ? `<span>Comida compartida en los lugares de las regiones vivas<strong>${number(compartidaVivos)}</strong></span>` : ''}<span>Comida compartida que vio este navegador<strong>${number(compartidaVista)}</strong></span>${dinamica ? `<span>Alimento guardado en graneros<strong>${number(dinamica.foodStored, 2)}</strong></span><span>Alimento retirado de graneros<strong>${number(dinamica.foodTaken, 2)}</strong></span>` : ''}</div>`;
  return `<section class="stats-section" data-together><div class="stats-section-heading"><h3>Lo que han hecho juntos</h3><span>${number(d.cooperacion)} cooperaciones · acumulado del mundo</span></div><div class="distribution">${filas.map(f => fila(f[0], f[1], maximum, f[2], f[3])).join('')}</div>${comida}<p class="stats-note">Compartir comida no cuenta como cooperación: se registra en el lugar donde ocurre (a 3 casillas o menos de un lugar conocido).</p></section>`;
}

/** Mundo › Vida › «Desacuerdos»: cuándo ocurren según la ley y los últimos vistos, con quién cedió. */
export function seccionDesacuerdos(view: WorldView, recibidos: readonly ChronicleEvent[]): string {
  const total = view.stats?.totals.conflicts ?? 0;
  const ultimos = recibidos.filter(event => quienCedio(event)).slice(-4).reverse();
  const lista = ultimos.length ? `<ol class="experience-list" data-disputes>${ultimos.map(event => { const c = quienCedio(event)!; return `<li><span class="experience-tick">${esc(momento(event.tick).toLocaleUpperCase('es'))} · ${esc(clasificar(event).etiqueta.toLocaleUpperCase('es'))}</span><p>${esc(enClaro(event.text, { world: view }))}</p><small>Cedió ${personLink(view, c.cede)}: ${esc(c.como)}; ${personLink(view, c.sigue)} siguió.</small></li>`; }).join('')}</ol>` : '<p class="stats-empty">Este navegador no ha visto desacuerdos ni turnos en esta visita.</p>';
  return `<section class="stats-section" data-disputes-section><div class="stats-section-heading"><h3>Desacuerdos</h3><span>${number(total)} en el mundo</span></div><p class="stats-note">Solo ocurren si las dos personas tienen comunidad, el hambre o la sed aprietan y van a la misma fuente casi agotada. Con confianza o apertura suficientes se turnan en vez de disputar; quien no tiene comunidad nunca disputa. Pertenecer a grupos distintos no basta para un conflicto.</p>${lista}</section>`;
}
