/** Reposición esperada y espaciado reproductivo. Sólo lee el mundo y no consume azar. */
import type { Person, World } from './index.js';
import { bodilyNeedRates, phaseAt, TICKS_PER_DAY } from './index.js';
import { enCuenca } from './agua.js';
import { blueprintAffordances, BROKEN_CONDITION } from './inventions.js';
import { filtrarCerca } from './indice-puntos.js';
import { vecinos } from './rejilla.js';
import { bindWorldContext, tileAt, worldContext, type ObservadorNatalidad } from './spatial.js';
import { demographicTraits } from './demography.js';
import { paramsOf } from './params.js';
import { CRECIMIENTO_COMIDA, EVAPORACION_LUZ, EVAPORACION_OSCURIDAD,
  HAMBRE_POR_UNIDAD, INTERVALO_ECOLOGIA_TICKS, INTERVALO_TIEMPO_TICKS, LUZ_CREPSCULO,
  PROB_LLUVIA, RECARGA_LLUVIA, RECARGA_MANANTIAL, SED_POR_UNIDAD } from './ecologia-constantes.js';

export type PuntoProvision = { readonly x: number; readonly y: number };
export interface Reposicion { agua: number; comida: number }
export interface Demanda { agua: number; comida: number }
export type { ObservadorNatalidad } from './spatial.js';
/** Por mundo, en su contexto de anfitrión (no se serializa y pasa a los clones del paso): dos mundos en el
 * mismo proceso no comparten observador. */
export function setObservadorNatalidad(world: World, value: ObservadorNatalidad | null): void { bindWorldContext(world, { observadorNatalidad: value }); }
export function observadorNatalidad(world: World): ObservadorNatalidad | null { return worldContext(world).observadorNatalidad ?? null; }

/** Misma fisiología basal que bodyAndAction, inclusive S e I. */
export function demandaDiaria(world: World, person: Person): Demanda {
  const rates = bodilyNeedRates(world, tileAt(world, person)!, demographicTraits(person.genome, paramsOf(world).cuerpo));
  return { agua: rates.thirst * TICKS_PER_DAY / SED_POR_UNIDAD,
    comida: rates.hunger * TICKS_PER_DAY / HAMBRE_POR_UNIDAD };
}

export function demandaTotal(world: World, people: readonly Person[]): Demanda {
  let agua = 0, comida = 0;
  for (const person of people) {
    const d = demandaDiaria(world, person);
    agua += d.agua; comida += d.comida;
  }
  return { agua, comida };
}

/** El ciclo usa phaseAt, la misma fase que ecology y el kernel, para evitar otra tabla horaria. */
function ciclo(): { pasos: number; luz: number; evaporacion: number } {
  let dia = 0, crepusculo = 0, noche = 0;
  for (let tick = INTERVALO_ECOLOGIA_TICKS; tick <= TICKS_PER_DAY; tick += INTERVALO_ECOLOGIA_TICKS) {
    const phase = phaseAt(tick);
    if (phase === 'day') dia++;
    else if (phase === 'night') noche++;
    else crepusculo++;
  }
  return { pasos: TICKS_PER_DAY / INTERVALO_ECOLOGIA_TICKS,
    luz: dia + crepusculo * LUZ_CREPSCULO,
    evaporacion: (dia + crepusculo) * EVAPORACION_LUZ + noche * EVAPORACION_OSCURIDAD };
}
let cicloMedido: ReturnType<typeof ciclo> | undefined;

/** Producción diaria esperada en el disco; existencias actuales no entran en la capacidad. */
export function reposicionLocal(world: World, centro: PuntoProvision, radio: number): Reposicion {
  const { cuencas } = paramsOf(world).agua;
  const { velocidadRegeneracion, decaimientoComida } = paramsOf(world).recursos;
  const { pasos, luz, evaporacion } = cicloMedido ??= ciclo();
  const ventanasLluvia = PROB_LLUVIA * TICKS_PER_DAY / INTERVALO_TIEMPO_TICKS;
  const pasosLluvia = PROB_LLUVIA * pasos;
  let agua = 0, comida = 0;
  const cx = Math.round(centro.x), cy = Math.round(centro.y);
  for (let dy = -radio; dy <= radio; dy++) for (let dx = -radio; dx <= radio; dx++) {
    if (dx * dx + dy * dy > radio * radio) continue;
    const t = tileAt(world, { x: cx + dx, y: cy + dy });
    if (!t || t.terrain === 'water') continue;
    comida += Math.max(0, velocidadRegeneracion * CRECIMIENTO_COMIDA * 0.5 * luz * t.moisture * t.vegetation - pasos * decaimientoComida);
    const fuente = t.feature === 'pool' || t.feature === 'spring' || t.biome === 'wetland';
    if (fuente && t.biome !== 'ocean' && enCuenca(world.seed, t.x, t.y, cuencas))
      agua += Math.max(0, pasosLluvia * RECARGA_LLUVIA * (0.4 + (t.fertility ?? 0) * 0.6)
        + (t.feature === 'spring' ? pasos * RECARGA_MANANTIAL : 0) - evaporacion);
  }
  for (const s of filtrarCerca(world.structures, centro, radio + 1, s => (s.x - centro.x) ** 2 + (s.y - centro.y) ** 2 <= radio * radio
      && s.condition > BROKEN_CONDITION && tileAt(world, s)?.terrain === 'shelter')) {
    const a = blueprintAffordances(s.components);
    if (a.waterCapacity > 0) agua += ventanasLluvia * Math.min(a.waterCapacity,
      INTERVALO_TIEMPO_TICKS / INTERVALO_ECOLOGIA_TICKS * a.catchment * s.condition);
  }
  return { agua, comida };
}

/** Unión de los discos ocupados: cada tesela y cada cisterna se suma una sola vez. */
export function reposicionTerritorioOcupado(world: World, centros: readonly PuntoProvision[], radio: number): Reposicion {
  const celdas = new Set<string>();
  for (const centro of centros) {
    const cx = Math.round(centro.x), cy = Math.round(centro.y);
    for (let dy = -radio; dy <= radio; dy++) for (let dx = -radio; dx <= radio; dx++) {
      if (dx * dx + dy * dy <= radio * radio) celdas.add(`${cx + dx},${cy + dy}`);
    }
  }
  let agua = 0, comida = 0;
  // Recorre sólo la unión de celdas, en el orden estable de inserción de centros y desplazamientos.
  // Las cisternas se calculan aparte: reposicionLocal(tile, 0) las sumaría de nuevo por celda.
  const { cuencas } = paramsOf(world).agua;
  const { velocidadRegeneracion, decaimientoComida } = paramsOf(world).recursos;
  const { pasos, luz, evaporacion } = cicloMedido ??= ciclo();
  const pasosLluvia = PROB_LLUVIA * pasos;
  for (const key of celdas) {
    const [x, y] = key.split(',').map(Number);
    const t = tileAt(world, { x: x!, y: y! });
    if (!t || t.terrain === 'water') continue;
    comida += Math.max(0, velocidadRegeneracion * CRECIMIENTO_COMIDA * 0.5 * luz * t.moisture * t.vegetation - pasos * decaimientoComida);
    const fuente = t.feature === 'pool' || t.feature === 'spring' || t.biome === 'wetland';
    if (fuente && t.biome !== 'ocean' && enCuenca(world.seed, t.x, t.y, cuencas))
      agua += Math.max(0, pasosLluvia * RECARGA_LLUVIA * (0.4 + (t.fertility ?? 0) * 0.6)
        + (t.feature === 'spring' ? pasos * RECARGA_MANANTIAL : 0) - evaporacion);
  }
  const cisternas = new Set<string>();
  for (const centro of centros) for (const s of filtrarCerca(world.structures, centro, radio + 1,
    s => (s.x - centro.x) ** 2 + (s.y - centro.y) ** 2 <= radio * radio)) cisternas.add(s.id);
  const ventanasLluvia = PROB_LLUVIA * TICKS_PER_DAY / INTERVALO_TIEMPO_TICKS;
  for (const s of world.structures) {
    if (!cisternas.delete(s.id)) continue;
    if (s.condition <= BROKEN_CONDITION || tileAt(world, s)?.terrain !== 'shelter') continue;
    const a = blueprintAffordances(s.components);
    if (a.waterCapacity > 0) agua += ventanasLluvia * Math.min(a.waterCapacity,
      INTERVALO_TIEMPO_TICKS / INTERVALO_ECOLOGIA_TICKS * a.catchment * s.condition);
  }
  return { agua, comida };
}

/** Presión por recurso; igualdad favorece agua. Sin demanda, x=0 aunque no haya provisión. */
export function presionLocal(world: World, centro: PuntoProvision, radio: number, alfa: number): { x: number; limitante: 'agua' | 'comida' } {
  const reposicion = reposicionLocal(world, centro, radio);
  const demanda = demandaTotal(world, vecinos(world, centro, radio + 1,
    p => (p.x - centro.x) ** 2 + (p.y - centro.y) ** 2 <= radio * radio, 'natalidadLocal'));
  const agua = demanda.agua === 0 ? 0 : reposicion.agua === 0 ? Infinity : demanda.agua / (alfa * reposicion.agua);
  const comida = demanda.comida === 0 ? 0 : reposicion.comida === 0 ? Infinity : demanda.comida / (alfa * reposicion.comida);
  return { x: Math.max(agua, comida), limitante: agua >= comida ? 'agua' : 'comida' };
}

export function hacinamientoLocal(world: World, centro: PuntoProvision, radio: number, alfa: number): number {
  return presionLocal(world, centro, radio, alfa).x;
}

export function intervaloCumplido(world: World, person: Person, x: number): boolean {
  return x < 1 && world.tick - person.lastBirth >= demographicTraits(person.genome, paramsOf(world).cuerpo).fertilityCooldown / (1 - x);
}
