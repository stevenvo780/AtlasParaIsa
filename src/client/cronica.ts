/**
 * M5: la crónica con memoria. Cada estado trae solo los últimos 40 episodios (unos pocos segundos de
 * mundo, dominados por inventos y adaptaciones). Este módulo puro los acumula sin duplicados mientras
 * el navegador está conectado, los clasifica por tipo con el `kind` y prefijos estables del texto que
 * escribe la ley (fijados por prueba), y resume lo que cambió desde la última visita con contadores
 * del estado real. Nada se inventa: lo que este navegador no vio, se dice que no lo vio.
 */
import type { ChronicleEvent, WorldView } from '../shared/types.js';
import { number } from './ui-catalog.js';

export type GrupoCronica = 'hitos' | 'convivencia' | 'tecnica' | 'paisaje' | 'otros';
export const GRUPOS: { id: GrupoCronica | 'todo'; nombre: string }[] = [
  { id: 'todo', nombre: 'Todo' }, { id: 'hitos', nombre: 'Hitos' }, { id: 'convivencia', nombre: 'Convivencia' },
  { id: 'tecnica', nombre: 'Técnica' }, { id: 'paisaje', nombre: 'Paisaje y fauna' },
];
const TICKS_POR_DIA = 2400;

/** Tipo legible de un episodio: su `kind` y, cuando un mismo `kind` cubre cosas distintas, un fragmento
 * fijo del texto que escribe la ley (world/*.ts). Un texto desconocido cae en la etiqueta general. */
export function clasificar(event: Pick<ChronicleEvent, 'kind' | 'text'>): { grupo: GrupoCronica; etiqueta: string } {
  const t = event.text;
  switch (event.kind) {
    case 'birth': return { grupo: 'hitos', etiqueta: 'Nacimiento' };
    case 'death': return { grupo: 'hitos', etiqueta: 'Una vida terminó' };
    case 'community':
      return { grupo: 'hitos', etiqueta: t.includes(' tomó forma entre ') ? 'Nueva comunidad' : t.includes(' se separó de ') ? 'Una comunidad se dividió'
        : t.includes(' y se unió a ') ? 'Cambió de comunidad' : t.includes(' buscó otra comunidad') ? 'Dejó su comunidad' : 'Comunidad' };
    case 'conflict': return { grupo: 'hitos', etiqueta: 'Desacuerdo' };
    case 'cooperation':
      if (t.includes(' acordaron turnarse ')) return { grupo: 'hitos', etiqueta: 'Se turnaron' };
      return { grupo: 'convivencia', etiqueta: t.includes('. Aportó una unidad de ') ? 'Aportó material' : t.includes(' unidades de trabajo a la obra ') ? 'Ayudó en una obra'
        : t.includes(' unidades de trabajo a la caza ') ? 'Ayudó en una caza' : t.includes('. Intercambiaron ') ? 'Trueque' : t.includes('. Entregó el objeto ') ? 'Trueque de un objeto'
        : t.includes('. Mostró las operaciones practicadas') ? 'Enseñó un procedimiento' : t.includes('. Mostró una técnica practicada') ? 'Enseñó una técnica' : 'Cooperación' };
    case 'care': return { grupo: 'convivencia', etiqueta: 'Compartió comida' };
    case 'meeting': return { grupo: 'convivencia', etiqueta: 'Encuentro' };
    case 'learning': return t.includes(' aprendió a compartir ') ? { grupo: 'convivencia', etiqueta: 'Aprendió a compartir' } : { grupo: 'tecnica', etiqueta: 'Aprendió un procedimiento' };
    case 'invention':
      return { grupo: 'tecnica', etiqueta: t.includes(' descubrió ') ? 'Descubrió un procedimiento' : t.includes(' ideó ') ? 'Ideó un plano' : t.includes(' reparó ') ? 'Reparó' : 'Invención' };
    case 'settlement': return { grupo: 'tecnica', etiqueta: 'Construyó' };
    case 'adaptation': return { grupo: 'tecnica', etiqueta: 'Aprendió de la práctica' };
    case 'discovery': return { grupo: 'paisaje', etiqueta: 'Nueva región' };
    case 'ecology': return t.startsWith('Las pertenencias de ') ? { grupo: 'convivencia', etiqueta: 'Reparto de pertenencias' } : { grupo: 'paisaje', etiqueta: 'El tiempo' };
    case 'animal': return { grupo: 'paisaje', etiqueta: t.startsWith('Nace ') ? 'Nace un animal' : t.includes(' muere por ') ? 'Muere un animal' : 'Vida animal' };
    case 'gesture': return t.includes('camino bloqueado') ? { grupo: 'paisaje', etiqueta: 'Camino bloqueado' } : { grupo: 'otros', etiqueta: 'Un gesto' };
    case 'memory': return { grupo: 'otros', etiqueta: 'Memoria' };
    case 'pause': return { grupo: 'otros', etiqueta: 'Pausa del servidor' };
    default: return { grupo: 'otros', etiqueta: 'Episodio' };
  }
}

export const esHito = (event: Pick<ChronicleEvent, 'kind' | 'text'>): boolean => clasificar(event).grupo === 'hitos';

/** «Día 3 · paso 5.496», con el mismo día que `projectWorld` (2400 pasos por día). */
export function momento(tick: number): string { return `Día ${number(Math.floor(tick / TICKS_POR_DIA) + 1)} · paso ${number(tick)}`; }

/** En un desacuerdo o un turno, quién cedió: society.ts pone primero a quien se retira. */
export function quienCedio(event: Pick<ChronicleEvent, 'kind' | 'text' | 'actors'>): { cede: string; sigue: string; como: string } | null {
  if (event.actors.length < 2) return null;
  if (event.kind === 'conflict') return { cede: event.actors[0]!, sigue: event.actors[1]!, como: 'cede el intento y busca otra fuente' };
  if (event.kind === 'cooperation' && event.text.includes(' acordaron turnarse ')) return { cede: event.actors[0]!, sigue: event.actors[1]!, como: 'espera doce pasos y deja pasar primero' };
  return null;
}

/** Búfer de episodios de esta visita: sin duplicados por id, ordenado por paso y acotado. Cuando se
 * llena, se olvidan primero los episodios comunes más viejos; los hitos se conservan hasta su propia cota. */
export class CronicaBuffer {
  private readonly porId = new Map<string, ChronicleEvent>();
  constructor(readonly max = 600, readonly maxHitos = 200) {}
  get size(): number { return this.porId.size; }
  acumular(events: readonly ChronicleEvent[]): number {
    let nuevos = 0;
    for (const event of events) if (!this.porId.has(event.id)) { this.porId.set(event.id, event); nuevos++; }
    if (this.porId.size > this.max) this.podar();
    return nuevos;
  }
  get(id: string): ChronicleEvent | undefined { return this.porId.get(id); }
  /** Todos los episodios guardados, del más viejo al más nuevo. */
  todos(): ChronicleEvent[] { return [...this.porId.values()].sort((a, b) => a.tick - b.tick || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); }
  clear(): void { this.porId.clear(); }
  private podar(): void {
    const orden = this.todos(), hitos = orden.filter(esHito), comunes = orden.filter(e => !esHito(e));
    const quedanHitos = hitos.slice(-this.maxHitos), quedanComunes = comunes.slice(Math.max(0, comunes.length - (this.max - quedanHitos.length)));
    this.porId.clear();
    for (const event of [...quedanHitos, ...quedanComunes].sort((a, b) => a.tick - b.tick)) this.porId.set(event.id, event);
  }
}

export function filtrar(events: readonly ChronicleEvent[], grupo: GrupoCronica | 'todo'): ChronicleEvent[] {
  return grupo === 'todo' ? [...events] : events.filter(event => clasificar(event).grupo === grupo);
}

/** Contadores del estado real que permiten decir qué cambió entre dos visitas. */
export interface ContadoresVisita { tick: number; births: number; deaths: number; conflicts: number; regions: number; recipes: number }
export function contadoresDe(view: WorldView): ContadoresVisita | null {
  // `totals` crea cada clave al primer suceso (statistics.ts `count`): una clave ausente con `totals` presente es cero.
  const births = view.stats ? view.stats.totals.births ?? 0 : undefined, deaths = view.demography?.deaths, conflicts = view.stats?.totals.conflicts ?? 0;
  const regions = view.discoveredChunks, recipes = view.technology?.dynamics.recipes;
  if (![births, deaths, regions, recipes].every(value => typeof value === 'number' && Number.isFinite(value))) return null;
  return { tick: view.tick, births: births!, deaths: deaths!, conflicts, regions: regions!, recipes: recipes! };
}

const causasBreves: Record<string, string> = { starvation: 'de hambre', dehydration: 'de sed', exposure: 'por desgaste del cuerpo', senescence: 'de vejez' };
const plural = (n: number, uno: string, varios: string): string => `${number(n)} ${n === 1 ? uno : varios}`;

/** «Desde tu última visita»: lo que cambió, con contadores del estado real. Sin contadores guardados (visita
 * de una versión anterior) solo se afirma el tiempo transcurrido y los episodios que siguen en la ventana. */
export function resumenDesdeVisita(prev: ContadoresVisita | null, lastTick: number, view: WorldView): { dias: string; cambios: string[] } {
  const pasos = Math.max(0, view.tick - lastTick);
  const dias = pasos < TICKS_POR_DIA / 10 ? `Pasaron ${number(pasos)} ${pasos === 1 ? 'paso' : 'pasos'} del mundo.` : `Pasaron ${number(pasos / TICKS_POR_DIA, 1)} ${Math.abs(pasos / TICKS_POR_DIA - 1) < 0.05 ? 'día' : 'días'} del mundo.`;
  const now = contadoresDe(view), cambios: string[] = [];
  if (prev && now) {
    const nacidos = now.births - prev.births, muertes = now.deaths - prev.deaths;
    if (nacidos > 0) cambios.push(`+${plural(nacidos, 'nacimiento', 'nacimientos')}`);
    if (muertes > 0) {
      const recientes = (view.demography?.recent ?? []).filter(entry => entry.diedAt > lastTick).slice(0, 3);
      const quienes = recientes.map(entry => `${entry.name}${causasBreves[entry.cause] ? `, ${causasBreves[entry.cause]}` : ''}`).join('; ');
      cambios.push(`${plural(muertes, 'vida terminó', 'vidas terminaron')}${quienes ? ` (${quienes}${muertes > recientes.length ? '…' : ''})` : ''}`);
    }
    const regiones = now.regions - prev.regions, recetas = now.recipes - prev.recipes, desacuerdos = now.conflicts - prev.conflicts;
    if (regiones > 0) cambios.push(`+${plural(regiones, 'región', 'regiones')}`);
    if (recetas > 0) cambios.push(`+${plural(recetas, 'procedimiento', 'procedimientos')}`);
    if (desacuerdos > 0) cambios.push(`${plural(desacuerdos, 'desacuerdo', 'desacuerdos')}`);
  }
  for (const community of view.communities ?? []) if (community.formedAt > lastTick) cambios.push(`nueva comunidad: ${community.name}`);
  return { dias, cambios };
}
