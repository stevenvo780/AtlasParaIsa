/**
 * Resúmenes pequeños del mundo vivo para la interfaz, calculados en el servidor con las propias leyes
 * del mundo y SOLO en lectura (nunca escriben ni avanzan el mundo, así que el digesto no cambia).
 * Viajan en `RuntimeStats` y se recalculan cada `CADA_PASOS` pasos: su coste es O(población) y su
 * tamaño es constante, independiente de la población.
 *
 * M4 (natalidad): cuántos vecinos son fértiles ahora, cuántos buscan a su pareja (cortejo), cuántos
 * preparan reservas para criar y cuántos se reúnen para intentarlo, más la ley de este mundo en números.
 * M7 (comidaCompartida): Σ `gatherings` de los lugares vivos.
 */
import type { PersonDetail, RuntimeStats } from '../shared/types.js';
import type { Person, World } from '../world/index.js';
import { reproductiveReadiness } from '../world/family.js';
import { demographicTraits } from '../world/demography.js';
import { paramsOf } from '../world/params.js';
import { POPULATION_HARD_LIMIT } from '../shared/life.js';

export const CADA_PASOS = 50;
/** Reserva mínima de alimento de cada progenitor para criar (`fertile()`, world/index.ts). Fijada por prueba. */
export const RESERVA_PARA_CRIAR = 0.1;

/** Prefijos fijos de `reason` que escribe `decide()` (world/index.ts); una prueba los contrasta con el mundo. */
export const RAZON_CORTEJO = 'Recuerda el vínculo con ';
export const RAZON_REUNION = 'Tiene reservas y busca ';
export const RAZON_PREPARA = 'Prepara alimento para una posible crianza con ';

export type Natalidad = NonNullable<RuntimeStats['natalidad']>;

export function resumenNatalidad(world: World): Natalidad {
  let fertiles = 0, cortejando = 0, preparando = 0, reuniendose = 0;
  for (const person of world.people) {
    if (person.role === 'neighbor' && reproductiveReadiness(world, person)) fertiles++;
    if (person.action === 'approach' && person.reason.startsWith(RAZON_CORTEJO)) cortejando++;
    else if (person.action === 'approach' && person.reason.startsWith(RAZON_REUNION)) reuniendose++;
    else if (person.action === 'forage' && person.reason.startsWith(RAZON_PREPARA)) preparando++;
  }
  const ley = paramsOf(world).poblacion;
  // El cupo y la ventana son los de `reproduce()` (world/index.ts): como mucho `nacimientosPorComprobacion`
  // nacimientos por ventana. `maxima` solo viaja si de verdad limita (R17: por defecto no hay tope propio).
  return { tick: world.tick, fertiles, cortejando, preparando, reuniendose,
    ley: { radioPareja: ley.radioPareja, radioLugar: ley.radioLugar, radioCortejo: ley.cortejo > 0 ? ley.radioCortejo : 0,
      exigeComunidad: ley.exigeComunidad, reserva: RESERVA_PARA_CRIAR,
      cupo: ley.nacimientosPorComprobacion, ventana: ley.intervaloComprobacionTicks, continua: ley.comprobacionContinua,
      ...(ley.maxima < POPULATION_HARD_LIMIT ? { maxima: ley.maxima } : {}) } };
}

/** M7: veces que se compartió comida en los lugares de las regiones vivas. Exacto para ellos: `share()`
 * (world/index.ts) solo comparte a ≤ 3 casillas de un lugar y suma allí `gatherings`. */
export function comidaCompartida(world: World): number {
  return world.places.reduce((sum, place) => sum + (Number.isFinite(place.gatherings) ? place.gatherings : 0), 0);
}

/** Lo que el servidor añade a `RuntimeStats` cada `CADA_PASOS` pasos. `conducta` es O(1): un parámetro. */
export function resumenVivo(world: World): Pick<RuntimeStats, 'natalidad' | 'comidaCompartida' | 'conducta'> {
  return { natalidad: resumenNatalidad(world), comidaCompartida: comidaCompartida(world),
    conducta: { habituacion: paramsOf(world).conducta.habituacion } };
}

type Fertil = NonNullable<PersonDetail['fertil']>;

/** Por qué una persona puede o no criar ahora, con las mismas condiciones que `reproductiveReadiness`,
 * `fertile()` y `reproduce()` (en ese orden de causa), sin escribir en el mundo. */
export function fertilidad(world: World, person: Person): Fertil {
  if (person.role !== 'neighbor') return { ahora: false, bloqueo: 'no-vecino', reserva: person.inventory, necesita: RESERVA_PARA_CRIAR };
  const cuerpo = paramsOf(world).cuerpo, traits = demographicTraits(person.genome, cuerpo), age = person.demography.age;
  const base = { reserva: person.inventory, necesita: RESERVA_PARA_CRIAR };
  if (age < traits.maturityAge) return { ahora: false, bloqueo: 'joven', faltanPasos: traits.maturityAge - age, ...base };
  if (age >= traits.senescenceStart) return { ahora: false, bloqueo: 'vejez', ...base };
  const desde = world.tick - person.lastBirth;
  if (desde < traits.fertilityCooldown) return { ahora: false, bloqueo: 'enfriamiento', faltanPasos: traits.fertilityCooldown - desde, ...base };
  if (!reproductiveReadiness(world, person)) {
    const d = person.demography, faltas: string[] = [];
    if (d.health < 0.55) faltas.push('salud'); if (d.vitality < 0.5) faltas.push('vitalidad');
    if (person.hunger > 0.45) faltas.push('hambre'); if (person.thirst > 0.45) faltas.push('sed');
    if (person.energy < 0.6) faltas.push('energía'); if (person.fatigue > 0.65) faltas.push('cansancio');
    return { ahora: false, bloqueo: 'cuerpo', cuerpo: faltas, ...base };
  }
  if (person.inventory < RESERVA_PARA_CRIAR) return { ahora: false, bloqueo: 'reserva', ...base };
  if (paramsOf(world).poblacion.exigeComunidad && !person.communityId) return { ahora: false, bloqueo: 'comunidad', ...base };
  if (!world.reproductionEnabled) return { ahora: false, bloqueo: 'techo', ...base };
  return { ahora: true, bloqueo: null, ...base };
}

/** Si su `reason` es de cortejo o de crianza, a quién busca (por nombre único en el mundo vivo). */
export function aQuienBusca(world: World, person: Person): { id: string; name: string; motivo: 'cortejo' | 'reunion' | 'prepara' } | undefined {
  const motivo = person.reason.startsWith(RAZON_CORTEJO) ? 'cortejo' : person.reason.startsWith(RAZON_REUNION) ? 'reunion' : person.reason.startsWith(RAZON_PREPARA) ? 'prepara' : null;
  if (!motivo) return undefined;
  const candidates = world.people.filter(other => other.id !== person.id && person.reason.includes(other.name) && (person.bonds[other.id] ?? 0) >= 0.3);
  // El nombre más largo que aparece: «Olmo 12» gana a «Olmo 1». Si aún hay empate, no se afirma nada.
  const longest = Math.max(0, ...candidates.map(c => c.name.length)), best = candidates.filter(c => c.name.length === longest);
  return best.length === 1 ? { id: best[0]!.id, name: best[0]!.name, motivo } : undefined;
}
