/**
 * M1 (censo fiel): desde el protocolo 10 `world.people` llega RECORTADO a la cámara; el censo de
 * toda la población viaja en `stats.census` (statistics.ts, calculado sobre `world.people` entero).
 * Este módulo es puro (sin DOM ni estado): cuenta el mundo con el censo y rotula como «en esta vista»
 * lo que sale de `people`. Si el censo no llegó, lo dice con «—»; nunca cuenta la vista como si fuera
 * el mundo ni convierte una ausencia en cero.
 */
import type { CommunityView, WorldView } from '../shared/types.js';
import { esc, number, percentage } from './ui-catalog.js';

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

/* ----- Cultura viva (V18): los tres ejes que ya viajan en `culture` -----
 * Orden fijo y lectura causal tomada de la ley (world/index.ts + society.ts):
 * compartir se refuerza cuando compartir/cooperar sale bien; el cuidado del
 * entorno pesa al cultivar y frena la caza cuando la fauna escasea; la apertura
 * facilita cooperar y turnarse con gente de otra comunidad. La cultura de una
 * comunidad es la media de la de sus miembros vivos (society.ts). Un eje que no
 * llegó, no es finito o sale de [0,1] se trata como ausente (`null`), nunca 0. */
export type EjeCulturalClave = 'sharing' | 'stewardship' | 'openness';
export interface EjeCultural { clave: EjeCulturalClave; etiqueta: string; valor: number | null; lectura: string }

const EJES_CULTURA: ReadonlyArray<Omit<EjeCultural, 'valor'>> = [
  { clave: 'sharing', etiqueta: 'Compartir', lectura: 'Se refuerza cuando compartir alimento o cooperar sale bien.' },
  { clave: 'stewardship', etiqueta: 'Cuidar el entorno', lectura: 'Pesa al cultivar y frena la caza cuando la fauna escasea y el hambre no es extrema.' },
  { clave: 'openness', etiqueta: 'Apertura', lectura: 'Facilita cooperar y turnarse con quien pertenece a otra comunidad.' },
];

const valorCultura = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;

type CulturaRecibida = Partial<Record<EjeCulturalClave, unknown>> | null | undefined;

/** Los tres ejes en su orden canónico (compartir, cuidado, apertura), validados uno a uno. */
export function ejesCultura(culture: CulturaRecibida): EjeCultural[] {
  return EJES_CULTURA.map(eje => ({ ...eje, valor: valorCultura(culture?.[eje.clave]) }));
}

/** El eje más alto de un perfil; en empate manda el orden canónico. `null` si ningún eje llegó. */
export function ejeDominante(culture: CulturaRecibida): EjeCultural | null {
  let mejor: EjeCultural | null = null;
  for (const eje of ejesCultura(culture)) {
    if (eje.valor !== null && (mejor === null || eje.valor > mejor.valor!)) mejor = eje;
  }
  return mejor;
}

export interface RangoCultural { clave: EjeCulturalClave; etiqueta: string; min: number; max: number; amplitud: number }

/** Divergencia entre comunidades: rango (mín.–máx.) de cada eje sobre los perfiles COMPLETOS
 * recibidos. Con menos de dos perfiles completos no se afirma divergencia (`null`). */
export function divergenciaCultural(
  communities: ReadonlyArray<Pick<CommunityView, 'culture'>> | undefined,
): { comunidades: number; rangos: RangoCultural[] } | null {
  const completos = (communities ?? []).map(c => ejesCultura(c.culture)).filter(ejes => ejes.every(e => e.valor !== null));
  if (completos.length < 2) return null;
  const rangos = EJES_CULTURA.map((eje, index) => {
    const valores = completos.map(ejes => ejes[index]!.valor!);
    const min = Math.min(...valores), max = Math.max(...valores);
    return { clave: eje.clave, etiqueta: eje.etiqueta, min, max, amplitud: max - min };
  });
  return { comunidades: completos.length, rangos };
}

/** Mundo › Comunidades: una sola sección compacta con el rango de cada eje entre comunidades.
 * Cadena vacía si no hay al menos dos perfiles completos que comparar (la tarjeta ya los muestra). */
export function resumenCultural(view: Pick<WorldView, 'communities'>): string {
  const divergencia = divergenciaCultural(view.communities);
  if (!divergencia) return '';
  const filas = divergencia.rangos.map(r =>
    `<span data-eje="${esc(r.clave)}">${esc(r.etiqueta)}<strong>${esc(percentage(r.min))}–${esc(percentage(r.max))}</strong></span>`).join('');
  return `<section class="stats-section" data-cultural-divergence><div class="stats-section-heading"><h3>Culturas que divergen</h3><span>${number(divergencia.comunidades)} comunidades · rango entre ellas</span></div><div class="stats-facts">${filas}</div><p class="stats-note">La cultura de cada comunidad promedia la de sus miembros vivos. Un rango ancho dice que no comparten las mismas costumbres, no que estén enfrentadas.</p></section>`;
}

/** Orden legible y estable de las tarjetas: primero las más pobladas, luego por nombre.
 * Devuelve una copia; nunca reordena el estado recibido. */
export function comunidadesOrdenadas<T extends Pick<CommunityView, 'name' | 'members' | 'memberCount'>>(communities: readonly T[] | undefined): T[] {
  const total = (c: T): number => c.memberCount ?? c.members.length;
  return [...(communities ?? [])].sort((a, b) => total(b) - total(a) || a.name.localeCompare(b.name, 'es'));
}

/** Cota de DOM para listas que crecen con la población: se nombran las primeras filas y el resto
 * se cuenta, como ya hace la lista de fauna. Pensada para 300+ habitantes y para el modo ligero. */
export const MAX_FILAS_LISTA = 120;
export const MAX_MIEMBROS_NOMBRADOS = 24;

export function ventanaLista<T>(items: readonly T[], max: number = MAX_FILAS_LISTA): { visibles: T[]; restantes: number } {
  const limite = Number.isSafeInteger(max) && max >= 0 ? max : MAX_FILAS_LISTA;
  return { visibles: items.slice(0, limite), restantes: Math.max(0, items.length - limite) };
}

/** Miembros que se nombran en la tarjeta de una comunidad; el resto de la cámara se cuenta aparte. */
export function miembrosNombrados(ids: readonly string[], max: number = MAX_MIEMBROS_NOMBRADOS): { nombrados: string[]; restantesEnVista: number } {
  const { visibles, restantes } = ventanaLista(ids, max);
  return { nombrados: visibles, restantesEnVista: restantes };
}
