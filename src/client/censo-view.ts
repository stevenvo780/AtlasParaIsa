/**
 * M1 (censo fiel): desde el protocolo 10 `world.people` llega RECORTADO a la cámara; el censo de
 * toda la población viaja en `stats.census` (statistics.ts, calculado sobre `world.people` entero).
 * Este módulo es puro (sin DOM ni estado): cuenta el mundo con el censo y rotula como «en esta vista»
 * lo que sale de `people`. Si el censo no llegó, lo dice con «—»; nunca cuenta la vista como si fuera
 * el mundo ni convierte una ausencia en cero.
 */
import type { WorldView } from '../shared/types.js';
import { esc, number } from './ui-catalog.js';

export interface Censo {
  /** Vecinos + identidades S/I: todas las vidas humanas del mundo servido. */
  total: number; neighbors: number; identities: number; protectedCount: number;
  lifeStage: { juvenile: number; adult: number; senescent: number; unknown: number };
}

const entero = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** El censo global tal como lo mandó el servidor, o `null` si no llegó o viene incompleto. */
export function censoDe(view: Pick<WorldView, 'stats'>): Censo | null {
  const census = view.stats?.census;
  if (!census || !entero(census.neighbors) || !entero(census.identities) || !entero(census.protectedCount)) return null;
  const stages = census.lifeStage;
  if (!stages || ![stages.juvenile, stages.adult, stages.senescent, stages.unknown].every(entero)) return null;
  return { total: census.neighbors + census.identities, neighbors: census.neighbors, identities: census.identities,
    protectedCount: census.protectedCount, lifeStage: { juvenile: stages.juvenile, adult: stages.adult, senescent: stages.senescent, unknown: stages.unknown } };
}

/** Recuento para la lista de Vidas: cuántas hay en la cámara y cuántas en el mundo (null = censo no recibido). */
export function recuentoPoblacion(view: Pick<WorldView, 'stats' | 'people'>): { enVista: number; enMundo: number | null } {
  return { enVista: view.people.length, enMundo: censoDe(view)?.total ?? null };
}

/** «13 en esta vista · 23 en el mundo»; sin censo solo afirma lo que ve. */
export function rotuloRecuento(view: Pick<WorldView, 'stats' | 'people'>): string {
  const { enVista, enMundo } = recuentoPoblacion(view);
  return enMundo === null ? `${number(enVista)} en esta vista` : `${number(enVista)} en esta vista · ${number(enMundo)} en el mundo`;
}

const statCard = (label: string, value: string, note: string): string =>
  `<article class="stat-card"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></article>`;

/** Mundo › Vida, bloque «Población humana». Todas las cifras del mundo salen de `stats.census`. */
export function demographicSummary(received: WorldView): string {
  const censo = censoDe(received), enVista = received.people.length;
  const deaths = received.demography;
  const neighbors = censo?.neighbors;
  const stages = censo?.lifeStage;
  const known = stages ? stages.juvenile + stages.adult + stages.senescent : 0;
  const replacement = !censo ? 'Sin censo recibido: no se puede evaluar el recambio.'
    : !censo.neighbors ? 'No hay vecinos para evaluar el recambio.'
    : stages!.unknown ? 'Faltan etapas de vida: no se puede evaluar el recambio por edad.'
    : stages!.juvenile + stages!.adult < 2 ? 'No hay recambio posible entre los vecinos actuales.'
    : 'La edad no garantiza una crianza: también hacen falta salud, recursos, confianza y cercanía.';
  const stageValue = (value: number | undefined): string => censo && (known || !censo.neighbors) ? number(value) : '—';
  const stagesMarkup = `<div data-neighbor-life-stages><div class="stats-section-heading"><h3>Etapas de los vecinos</h3><span>${censo ? `${number(known)}/${number(censo.neighbors)} con dato · todo el mundo` : 'censo no recibido'}</span></div><div class="stats-facts"><span data-life-stage="juvenile">En crecimiento<strong>${stageValue(stages?.juvenile)}</strong></span><span data-life-stage="adult">Edad de crianza<strong>${stageValue(stages?.adult)}</strong></span><span data-life-stage="senescent">Vejez<strong>${stageValue(stages?.senescent)}</strong></span>${stages?.unknown ? `<span data-life-stage="unknown">Etapa sin dato<strong>${number(stages.unknown)}</strong></span>` : ''}</div><p class="stats-note" data-replacement-status>${replacement}</p></div>`;
  const heading = !censo ? 'Población humana' : censo.neighbors === 0 ? 'Sin vecinos vivos' : 'Población humana';
  const scope = censo ? `${number(censo.total)} ${censo.total === 1 ? 'vida' : 'vidas'} en el mundo · ${number(enVista)} en esta vista` : `censo no recibido · ${number(enVista)} en esta vista`;
  const protection = !censo ? 'Esta vista no trae el censo del mundo: no se afirma cuántas vidas hay ni su protección.'
    : censo.protectedCount > 0 ? (censo.neighbors === 0 ? 'La continuidad de S/I está protegida. Su presencia no demuestra que los vecinos hayan sobrevivido.' : 'S/I tienen continuidad protegida por la configuración del mundo. Los vecinos siguen un ciclo de vida con mortalidad.')
    : 'El censo distingue vecinos e identidades S/I; ninguna identidad tiene continuidad protegida ahora.';
  const cameraNote = censo && enVista < censo.total ? `<p class="stats-note" data-census-scope>El censo cuenta a todas las vidas del mundo; la cámara muestra a ${number(enVista)}. La lista de Vidas enseña solo a quien está en cuadro.</p>` : '';
  return `<section data-demographic-summary><div class="stats-section-heading"><h3>${heading}</h3><span>${scope}</span></div><div class="stats-grid">${statCard('Vecinos vivos', censo ? number(neighbors) : '—', censo ? 'Sujetos a mortalidad · todo el mundo' : 'Censo no recibido')}${statCard('S/I protegidos', censo ? number(censo.protectedCount) : '—', censo ? 'Continuidad por configuración' : 'Protección sin dato')}${statCard('Muertes humanas', number(deaths?.deaths), deaths ? 'Acumuladas en este mundo' : 'Acumulado no recibido')}${statCard('Nacimientos', number(received.stats?.totals.births), 'Acumulados en este mundo')}</div>${cameraNote}${stagesMarkup}<p class="stats-note">${protection}</p></section>`;
}

/** Ficha de alguien que no está en `people`: despedida si murió hace poco, «fuera de esta vista» si
 * el servidor confirma que sigue vivo, y «comprobando» mientras no lo sabemos. Nunca sugiere muerte
 * sin el registro que la acredite. `alive`: true = el servidor sirvió su ficha; false = el servidor
 * dijo que no está en el mundo servido; undefined = aún sin respuesta. */
export function ausenteEstado(view: WorldView, id: string, alive: boolean | undefined): 'difunto' | 'fuera' | 'no-servido' | 'comprobando' {
  if (view.demography?.recent.some(entry => entry.id === id)) return 'difunto';
  return alive === true ? 'fuera' : alive === false ? 'no-servido' : 'comprobando';
}
