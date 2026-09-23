/**
 * M8: linaje, generaciones y muertes. Módulo puro sobre el estado real: `demography` (difuntos recientes
 * con causa, generación, nacimiento y muerte), `stats.generations`, `stats.census`,
 * `communities[].memberCount` y, en la ficha, `familia` y `edades` de la ficha a demanda. Las edades se
 * dicen en días del mundo (2400 pasos por día, el mismo reloj que el día del HUD).
 */
import type { PersonDetail, PersonView, WorldView } from '../shared/types.js';
import { deathCauses, esc, icon, number } from './ui-catalog.js';
import { censoDe } from './censo-view.js';
import { distribution } from './charts.js';
import { causasMuerte } from './textos.js';

const DIA = 2400;
export const enDias = (pasos: number): string => `${number(pasos / DIA, 1)} ${Math.abs(pasos / DIA - 1) < 0.05 ? 'día' : 'días'}`;
const diaDelMundo = (tick: number): string => `día ${number(Math.floor(tick / DIA) + 1)}`;

/** La generación más alta entre los vivos (`stats.generations` cuenta a toda la población). */
export function generacionMaxima(view: Pick<WorldView, 'stats'>): number | null {
  const gens = Object.entries(view.stats?.generations ?? {}).filter(([, n]) => n > 0).map(([g]) => Number(g)).filter(Number.isFinite);
  return gens.length ? Math.max(...gens) : null;
}

/** Cuántas vidas no pertenecen a ninguna comunidad (en reglas 10 es opcional). */
export function sinComunidad(view: Pick<WorldView, 'stats' | 'communities'>): number | null {
  const censo = censoDe(view);
  if (!censo) return null;
  const miembros = (view.communities ?? []).reduce((sum, c) => sum + (c.memberCount ?? c.members.length), 0);
  const resto = censo.total - miembros;
  return resto >= 0 ? resto : null;
}

/** Mundo › Vida › «Vidas que terminaron»: causas en barras y los difuntos recientes que llegan en el estado. */
export function vidasQueTerminaron(view: WorldView): string {
  const d = view.demography;
  if (!d) return '<section class="stats-section" data-ended-lives><div class="stats-section-heading"><h3>Vidas que terminaron</h3></div><p class="stats-empty">El servidor no envió el registro de muertes con este estado.</p></section>';
  const causas = Object.fromEntries(Object.entries(d.causes).filter(([, n]) => Number.isFinite(n) && n > 0));
  const nombres = Object.fromEntries(Object.keys(causas).map(k => [k, deathCauses[k] ?? causasMuerte[k] ?? k]));
  const lista = d.recent.slice(0, 32);
  const nombreDe = (id: string): string => view.people.find(p => p.id === id)?.name ?? d.recent.find(r => r.id === id)?.name ?? '';
  const filas = lista.map(r => {
    const padres = r.parents.map(nombreDe).filter(Boolean);
    return `<li><button class="entity-link" data-person-link="${esc(r.id)}">${esc(r.name)} ${icon.arrow}</button><small>G${esc(r.generation)} · ${esc(causasMuerte[r.cause] ?? r.cause)} · ${esc(diaDelMundo(r.bornAt))} → ${esc(diaDelMundo(r.diedAt))} (vivió ${esc(enDias(r.diedAt - r.bornAt))})${padres.length ? ` · de ${esc(padres.join(' y '))}` : r.parents.length ? '' : ' · población inicial'}</small></li>`;
  }).join('');
  return `<section class="stats-section" data-ended-lives><div class="stats-section-heading"><h3>Vidas que terminaron</h3><span>${number(d.deaths)} en este mundo</span></div><details class="person-detail" data-detail="human-death-causes" open><summary>Causas de las muertes acumuladas</summary>${Object.keys(causas).length ? distribution(causas, nombres, 'vidas') : '<p>No hay causas de muerte registradas en el acumulado recibido.</p>'}</details>${lista.length ? `<ol class="ended-lives">${filas}</ol><p class="stats-note">Las ${number(lista.length)} más recientes que conserva el mundo; cada una abre su despedida.</p>` : ''}</section>`;
}

type Extra = Pick<PersonDetail, 'familia' | 'edades'> | null | undefined;

/** Ficha › Historia › «Herencia y genealogía»: progenitores y descendencia en todo el mundo, con enlaces. */
export function genealogiaFicha(p: PersonView, view: WorldView, extra: Extra): { progenitores: string; descendencia: string } {
  const pariente = (h: { id: string; nombre: string | null; vivo: boolean | null; generacion: number | null }): string =>
    h.nombre ? `<button class="lineage-person${h.vivo ? '' : ' is-absent'}" data-parent="${esc(h.id)}">${esc(h.nombre)}${h.generacion !== null ? ` · G${esc(h.generacion)}` : ''}${h.vivo === false ? ' · murió' : view.people.some(x => x.id === h.id) ? '' : ' · fuera de esta vista'} ${icon.arrow}</button>`
      : '<span class="lineage-absent">Un registro que el mundo ya no conserva</span>';
  const familia = extra?.familia;
  if (!familia) return { progenitores: '', descendencia: '' };
  const progenitores = familia.progenitores.length ? familia.progenitores.map(pariente).join('') : '<span class="lineage-absent">Población inicial · sin progenitores registrados</span>';
  // `totalHijos` cuenta vivos y los difuntos que el mundo aún registra (`legacy` + `retiredLegacy`); el
  // registro de difuntos se archiva con el tiempo, así que es lo conocido, no un total de por vida.
  const conocidos = `${number(familia.totalHijos)} ${familia.totalHijos === 1 ? 'conocido' : 'conocidos'}`;
  const vivos = `${number(familia.hijosVivos)} ${familia.hijosVivos === 1 ? 'vive' : 'viven'}`;
  const resumen = familia.totalHijos ? `${conocidos} · ${vivos}` : 'Ninguna conocida';
  const descendencia = `<p class="lineage-count" data-offspring>${esc(resumen)}</p>${familia.hijos.map(pariente).join('')}${familia.totalHijos > familia.hijos.length ? `<span class="lineage-absent">y ${number(familia.totalHijos - familia.hijos.length)} más</span>` : ''}`;
  return { progenitores, descendencia };
}

/** «Edad: 2,6 días del mundo · madura a los 1,9 días · vejez desde los 12,4 días». */
export function edadFicha(p: PersonView, extra: Extra): string {
  const e = extra?.edades;
  if (e) return `<p class="agent-age" data-age>Edad: ${esc(enDias(e.edad))} del mundo · madura a los ${esc(enDias(e.madurez))} · vejez desde los ${esc(enDias(e.vejez))}. Días del mundo, no años humanos.</p>`;
  return p.age !== undefined ? `<p class="agent-age" data-age>Edad: ${esc(enDias(p.age))} del mundo. Días del mundo, no años humanos.</p>` : '';
}
