import type { Order, PersonView } from '../shared/types.js';
import { icons } from './icons.js';

export const esc = (value: string | number): string => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const svg = (path: string): string => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
export const icon = { ...icons,
  people: svg('<circle cx="9" cy="7" r="3"/><path d="M3 21v-5a6 6 0 0 1 12 0v5M17 4a3 3 0 0 1 0 6m2 3a5 5 0 0 1 2 4v4"/>'),
  hand: svg('<path d="M8 12V6a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v9c0 4-3 6-7 6-3 0-5-3-7-6l-2-3c-1-2 1-3 2-2l2 1Z"/>'),
  layers: svg('<path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5"/>'),
  eye: svg('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
  hammer: svg('<path d="m4 20 9-9M9 5l5-3 7 7-3 3-7-7Z"/>'),
  bag: svg('<path d="M5 9h14l2 12H3L5 9Zm3 0V6a4 4 0 0 1 8 0v3"/>'),
  tent: svg('<path d="m12 3 10 18H2L12 3Zm0 9-5 9m5-9 5 9"/>'),
  stats: svg('<path d="M3 3v18h18M7 15v-4m5 4V6m5 9V9"/>'),
  cooperate: svg('<path d="m3 11 4-5 5 2 5-2 4 5-6 8h-6l-6-8ZM7 12l4 4m6-4-4 4m-6-5 5-3 3 3-3 3-2-1"/>'),
  water: svg('<path d="M12 2C9 7 5 10 5 15a7 7 0 0 0 14 0c0-5-4-8-7-13Z"/><path d="M8 15a4 4 0 0 0 4 4"/>'),
  hunt: svg('<path d="M5 3c13 0 13 18 0 18L15 12 5 3Zm0 9h17m-3-3 3 3-3 3"/>'),
};
export const actions: Record<PersonView['action'], string> = { explore: 'Explorando', eat: 'Buscando alimento', forage: 'Cosechando alimento', drink: 'Buscando agua', hunt: 'Cazando', rest: 'Descansando', approach: 'Acercándose', accompany: 'Acompañando', retreat: 'Buscando espacio', share: 'Compartiendo', gather: 'Recolectando', farm: 'Cultivando', build: 'Construyendo', cooperate: 'Cooperando', invent: 'Investigando un proyecto', repair: 'Reparando', research: 'Probando materiales', craft: 'Fabricando un producto' };
export const phases = { dawn: 'Amanecer', day: 'Día', dusk: 'Atardecer', night: 'Noche' };
export const terrains = { water: 'Agua', meadow: 'Pradera', soil: 'Tierra', shelter: 'Refugio' };
export const biomes: Record<string, string> = { grassland: 'Praderas', forest: 'Bosque', desert: 'Desierto', mountain: 'Montañas', wetland: 'Humedal', ocean: 'Océano' };
export const deathCauses: Record<string,string> = {starvation:'Falta prolongada de alimento.',dehydration:'Falta prolongada de agua.',exposure:'Desgaste corporal por exposición.',senescence:'Llegó al término de su ciclo de vida simulado.'};
const orderEntries: { order: Order; title: string; icon: string }[] = [
  { order: 'explore', title: 'Explorar', icon: icon.focus }, { order: 'gather', title: 'Recolectar', icon: icon.bag },
  { order: 'forage', title: 'Cosechar alimento', icon: icon.leaf },
  { order: 'farm', title: 'Cultivar', icon: icon.leaf }, { order: 'build', title: 'Construir', icon: icon.hammer },
  { order: 'rest', title: 'Descansar', icon: icon.tent }, { order: 'auto', title: 'Autonomía', icon: icon.star },
  { order: 'cooperate', title: 'Cooperar', icon: icon.cooperate },
  { order: 'drink', title: 'Beber', icon: icon.water }, { order: 'hunt', title: 'Cazar', icon: icon.hunt },
  { order: 'invent', title: 'Inventar', icon: icon.star }, { order: 'repair', title: 'Reparar', icon: icon.hammer },
  { order: 'research', title: 'Investigar', icon: icon.layers }, { order: 'craft', title: 'Fabricar', icon: icon.hammer },
];
export const orders = orderEntries.map(entry => ({ ...entry, group: ['forage', 'drink', 'rest', 'hunt'].includes(entry.order) ? 'sustenance' : ['build', 'invent', 'repair'].includes(entry.order) ? 'building' : 'work' }));
export const number = (value: number | undefined, digits = 0): string => value !== undefined && Number.isFinite(value) ? value.toLocaleString('es-CO', { maximumFractionDigits: digits }) : '—';
export const percentage = (value: number | undefined): string => value !== undefined && Number.isFinite(value) ? `${number(value * 100)}%` : '—';
