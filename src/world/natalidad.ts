/** Reposición esperada y espaciado reproductivo. Sólo lee el mundo y no consume azar. */
import type { Person, World } from './index.js';
import { phaseAt, TICKS_PER_DAY } from './index.js';
import { enCuenca } from './agua.js';
import { blueprintAffordances, BROKEN_CONDITION } from './inventions.js';
import { filtrarCerca } from './indice-puntos.js';
import { vecinos } from './rejilla.js';
import { tileAt } from './spatial.js';
import { demographicTraits } from './demography.js';
import { paramsOf } from './params.js';
import { CRECIMIENTO_COMIDA, EVAPORACION_LUZ, EVAPORACION_OSCURIDAD, HAMBRE_POR_PASO,
  HAMBRE_POR_UNIDAD, INTERVALO_ECOLOGIA_TICKS, INTERVALO_TIEMPO_TICKS, LUZ_CREPSCULO,
  PROB_LLUVIA, RECARGA_LLUVIA, RECARGA_MANANTIAL, SED_POR_PASO, SED_POR_UNIDAD } from './ecologia-constantes.js';

export type PuntoProvision = { readonly x: number; readonly y: number };
export interface Reposicion { agua: number; comida: number }

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
  // El orden de suma es el orden estable de teselas del mundo; el Set sólo decide pertenencia.
  for (const tile of world.tiles) if (celdas.has(`${tile.x},${tile.y}`)) {
    const local = reposicionLocal(world, tile, 0);
    agua += local.agua; comida += local.comida;
  }
  return { agua, comida };
}

export function capacidadLocal(reposicion: Reposicion, alfa: number): number {
  const demandaAgua = SED_POR_PASO * TICKS_PER_DAY / SED_POR_UNIDAD;
  const demandaComida = HAMBRE_POR_PASO * TICKS_PER_DAY / HAMBRE_POR_UNIDAD;
  return alfa * Math.min(reposicion.agua / demandaAgua, reposicion.comida / demandaComida);
}

export function hacinamientoLocal(world: World, centro: PuntoProvision, radio: number, alfa: number): number {
  const K = capacidadLocal(reposicionLocal(world, centro, radio), alfa);
  const n = vecinos(world, centro, radio + 1, p => (p.x - centro.x) ** 2 + (p.y - centro.y) ** 2 <= radio * radio, 'natalidadLocal').length;
  return K > 0 ? n / K : Infinity;
}

export function intervaloCumplido(world: World, person: Person, x: number): boolean {
  return x < 1 && world.tick - person.lastBirth >= demographicTraits(person.genome, paramsOf(world).cuerpo).fertilityCooldown / (1 - x);
}
