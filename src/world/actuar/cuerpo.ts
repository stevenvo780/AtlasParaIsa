import type { World, Person } from '../mundo/tipos.js';
import { type TileLookup, clamp, distance } from '../mundo/geometria.js';
import { trackHuntingPrey, tendNearbyAnimal, pursuePrey } from './caza.js';
import { soaCell, needRates, tileIsDesert, tileIsExposed, foodStock, localRestQuality } from '../decision/sentidos.js';
import { MIN_FORAGE_STOCK, eat, drink } from './recursos.js';
import { choose, outcome } from '../decision/personas.js';
import { addEvent } from '../mundo/crear.js';
import { move } from './mover.js';
import { ensurePersonPolicy } from '../decision/politica-persona.js';
import { share } from './interacciones.js';
import { performWork } from './trabajo.js';
import { type ResidentFastAccess, residentFastAccess } from '../soa/terreno.js';
import { maintainContainedWater, advanceWaterPreparation, containedWaterQuanta, canHandleContainedWater } from '../technology-water.js';
import { paramsOf } from '../params.js';
import { tileLookup } from '../tile-index.js';
import { demographicTraits } from '../demography.js';
import { advanceNeeds } from '../needs.js';
import { foodAvailable, waterAvailable, REST_FATIGUE_RATE, REST_ENERGY_RATE, recordFacilityRest, BROKEN_CONDITION } from '../inventions.js';
import { resourceDispute, settleAgreement, cooperate } from '../society.js';
import { restBody } from '../body.js';
import { filtrarCerca } from '../indice-puntos.js';
import { performChemistryExperiment } from '../chemistry.js';
import { updatePolicyPlasticity } from '../politica.js';
import { researchTechnology, craftTechnology, technologyOpportunity } from '../technology.js';
import type { Tile } from '../../shared/types.js';
import { ley } from '../params.js';
import { ctxDe } from '../motor/acceso.js';


/** Lo que elegir y actuar comparten de una persona en un tick: dónde está al empezarlo y cómo se leen las teselas. */
export interface PasoPersona {
  tileIn: TileLookup;
  fast: ResidentFastAccess | undefined;
  tile: Tile;
  tileCell: number;
  physiology: ReturnType<typeof demographicTraits>;
  /** Con la ley de actuar: chunk donde empezó el tick. Lo que haría en una celda de otro chunk tras moverse lo hace en
   * el tick siguiente, cuando ya es suya (DISCIPLINA DE DUEÑO). null en el tick heredado. */
  chunkInicio: number | null;
}

export function prepararPaso(world: World, person: Person, tileInArg?: TileLookup, fastArg?: ResidentFastAccess | null,
  chunkInicio: number | null = null): PasoPersona {
  const tileIn = tileInArg ?? tileLookup(world.tiles);
  const fast = fastArg === undefined ? residentFastAccess(world.tiles) : fastArg ?? undefined;
  const tile = tileIn(person.x, person.y)!;
  return { tileIn, fast, tile, tileCell: soaCell(fast, person.x, person.y, tile), chunkInicio,
    physiology: demographicTraits(person.genome, paramsOf(world).cuerpo) };
}

/** El tick heredado de una persona: elegir y actuar seguidos. La ley de actuar llama a las dos mitades en F3 y F4. */
export function bodyAndAction(world: World, person: Person, policyScores?: Map<string, Float64Array>, tileInArg?: TileLookup, fastArg?: ResidentFastAccess | null): void {
  const paso = prepararPaso(world, person, tileInArg, fastArg);
  if (elegirPersona(world, person, paso, policyScores)) actuarPersona(world, person, paso);
}

/**
 * Primera mitad: el cuerpo del tick (necesidades, agua que prepara) y la decisión, si vence o la urgencia la rehace (la
 * urgencia fuera de F2 la percibe `choose` en el momento con `PercepcionDelPaso.filaDe`). Devuelve false si este tick ya
 * se le fue en preparar agua y no actúa.
 */
export function elegirPersona(world: World, person: Person, paso: PasoPersona, policyScores?: Map<string, Float64Array>): boolean {
  maintainContainedWater(world, person);
  const params = paramsOf(world), fauna = ley(world, 'fauna');
  if (params.quimica.emergente && !fauna && person.action === 'hunt' && person.huntingPreyId) {
    trackHuntingPrey(world, person);
  }
  const { tileIn, fast, tile, tileCell, physiology } = paso;
  // Con cuerpos, `advanceBody` solo avanza la fatiga: hambre, sed y energía las escribe b en F4 desde el cuerpo.
  advanceNeeds(person, needRates(world, tileIsDesert(tile, tileCell, fast), tileIsExposed(tile, tileCell, fast), physiology));
  person.closeness = clamp(person.closeness + 0.0001);
  person.socialLoad = clamp(person.socialLoad - 0.0008);
  if (person.technology.waterPreparation) {
    if (person.action !== 'drink' || person.command) person.technology.waterPreparation = undefined;
    else {
      const preparation = advanceWaterPreparation(world, person);
      person.decisionAt = preparation.moved > 0 ? world.tick + 1 : world.tick;
      if (preparation.moved > 0) {
        person.reason = preparation.complete ? 'Preparó una reserva finita de agua; vuelve a elegir su camino.' : 'Llena un objeto que retiene agua para preparar una reserva de viaje; cada carga cuesta esfuerzo.';
        person.need = 'Preparar agua para el camino';
        return false; // This tick's handling effort cannot also be spent drinking or working.
      }
    }
  }
  let targetFood = 0;
  if (person.action === 'eat' || person.action === 'forage') {
    const targetTile = tileIn(person.target.x, person.target.y);
    targetFood = foodStock(targetTile, soaCell(fast, person.target.x, person.target.y, targetTile), fast);
  }
  const emptyFood = person.action === 'eat' && targetFood < 0.005 && person.inventory < 0.01 && !(person.carga?.length) && foodAvailable(world,person)<0.001;
  const emptyHarvest = person.action === 'forage' && targetFood < MIN_FORAGE_STOCK;
  const emptyWater = person.action === 'drink' && containedWaterQuanta(person) === 0 && waterAvailable(world,person.target) < 0.003;
  const blockedCarriedWater = person.action === 'drink' && distance(person, person.target) < 0.5
    && containedWaterQuanta(person) > 0 && !canHandleContainedWater(person, world.tick) && waterAvailable(world, person) <= 0;
  const agreedWait = person.action === 'retreat' && person.lastDispute >= 0 && world.tick < person.decisionAt && world.tick - person.lastDispute < 30;
  if (!agreedWait && (world.tick >= person.decisionAt || emptyFood || emptyHarvest || emptyWater || blockedCarriedWater || (person.hunger > 0.9 && person.action !== 'eat' && person.action !== 'hunt') || (person.thirst > 0.9 && person.action !== 'drink'))) choose(world, person, policyScores, tileIn, fast ?? null);
  return true;
}

/** Segunda mitad: actuar sobre lo elegido (disputas, andar, comer, beber, descansar, trabajar, cooperar). */
export function actuarPersona(world: World, person: Person, paso: PasoPersona): void {
  const params = paramsOf(world), fauna = ley(world, 'fauna'), tecnica = ley(world, 'tecnica');
  const { tileIn, fast, tile, tileCell } = paso;
  if (person.action === 'eat' || person.action === 'drink' || person.action === 'hunt') resourceDispute(world, person, event => addEvent(world, event));
  if (person.agreement !== undefined) settleAgreement(world, person);
  if (world.tick % 6 === 0 && !(person.action === 'accompany' && distance(person, person.target) <= 1.5)) move(world, person, tileIn, fast?.exact ?? null);
  const moved = person.x !== tile.x || person.y !== tile.y;
  const current = moved ? tileIn(person.x, person.y)! : tile;
  const currentCell = moved ? soaCell(fast, person.x, person.y, current) : tileCell;
  if (moved && paso.chunkInicio !== null && chunkDeCelda(world, current) !== paso.chunkInicio) { anotarNecesidad(person); return; }
  if (params.quimica.emergente && !fauna && tendNearbyAnimal(world, person)) return;
  if (person.action === 'eat') {
    eat(world, person, current, currentCell, fast);
  }
  if (person.action === 'drink' && distance(person, person.target) < 0.5) {
    drink(world, person, current, currentCell, fast, paso.physiology, params);
  }
  if (person.action === 'rest' && distance(person, person.target) < 0.5) {
    const quality = localRestQuality(world, person);
    const beforeRest={fatigue:person.fatigue,energy:person.energy};
    restBody(person, { fatigue: REST_FATIGUE_RATE, energy: REST_ENERGY_RATE }, quality);
    if (world.shelterBenefitEnabled) recordFacilityRest(world,person,beforeRest);
    if (params.quimica.emergente && !tecnica && world.tick % 40 === 0 && (person.compounds?.length ?? 0) > 0) {
      const nearbyRestChem = filtrarCerca(world.structures, person, 4, s => distance(person, s) <= 3 && s.condition > BROKEN_CONDITION && (!s.site || !!s.site.expansion));
      if (nearbyRestChem.some(s => s.components.includes('hearth') || (s.components.includes('cistern') && s.water >= 0.02)) || (current.drinkingWater ?? 0) >= 0.02) {
        const chem = performChemistryExperiment(world, person, current, nearbyRestChem);
        if (chem?.isNew) addEvent(world, { kind: 'invention', actors: [person.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} obtuvo ${chem.formula.name} (T${chem.temperatureTier}).`, cause: `Química emergente (${chem.operator}) junto al hogar o al agua sin lista fija.` });
      }
    }
    // V19/L: como comer (hambre < 0,12) o beber (sed < 0,12), una pausa termina cuando el cuerpo ya recuperó lo que
    // la motivaba: al cruzar la demanda de recuperación por debajo de `REST_RECOVERED` vuelve a elegir en el paso
    // siguiente (una sola vez por tramo; si sigue lloviendo y no hay trabajo bajo techo, el techo seguirá ganando).
    if (params.conducta.aprendizajeCausal && beforeRest.fatigue + (1 - beforeRest.energy) >= REST_RECOVERED
      && person.fatigue + (1 - person.energy) < REST_RECOVERED) person.decisionAt = Math.min(person.decisionAt, world.tick + 1);
    const { politicaPeso, politicaAutonomia } = params.conducta;
    if (!params.conducta.aprendizajeCausal && politicaAutonomia > 0 && politicaPeso > 0 && world.adaptationEnabled && world.tick % 30 === 0) {
      const gained = (beforeRest.fatigue - person.fatigue) + (person.energy - beforeRest.energy);
      const { plasticity } = ensurePersonPolicy(world, person);
      updatePolicyPlasticity(plasticity, 'rest', gained * 25, person.genome.learningRate * 0.3);
    }
  }
  if (person.action === 'share') share(world, person);
  if ((person.action === 'research' || person.action === 'craft') && distance(person,person.target)<0.5) {
    const before = person.technology.attempts;
    const completed = person.action === 'research' ? researchTechnology(world,person,event=>addEvent(world,event)) : craftTechnology(world,person,technologyOpportunity(world,person)?.recipeId,event=>addEvent(world,event));
    if (person.technology.attempts > before) {
      if (params.quimica.emergente && !tecnica) {
        const nearbyChem = filtrarCerca(world.structures, person, 4, s => distance(person, s) <= 3 && s.condition > BROKEN_CONDITION && (!s.site || !!s.site.expansion));
        const chem = performChemistryExperiment(world, person, current, nearbyChem);
        if (chem?.isNew) addEvent(world, { kind: 'invention', actors: [person.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} obtuvo ${chem.formula.name} (T${chem.temperatureTier}).`, cause: `Química emergente (${chem.operator}) sobre composición local sin lista fija.` });
      }
      outcome(world,person,person.action,completed?0.12:-0.12,completed);
      if (person.command?.order === person.action) { person.command=null; person.controlMode='auto'; }
      person.decisionAt=world.tick+1;
    }
  }
  if (person.action === 'hunt' && fauna && person.cuerpo) {
    performWork(world, person, current);
  } else if (params.quimica.emergente && person.action === 'hunt' && person.huntingPreyId) {
    pursuePrey(world, person, tileIn);
  } else if ((person.action === 'gather' || person.action === 'farm' || person.action === 'build' || person.action === 'hunt' || person.action === 'invent' || person.action === 'repair' || person.action === 'forage') && distance(person, person.target) < 0.5) performWork(world, person, current);
  if (person.action === 'cooperate' && distance(person, person.target) <= 1.5) {
    person.work++;
    if (person.work >= 18) { person.work = 0; const useful = cooperate(world, person, event => addEvent(world, event)); outcome(world, person, 'cooperate', useful ? 0.2 : -0.1, useful); person.decisionAt = world.tick + 1; }
  }
  anotarNecesidad(person);
}

function anotarNecesidad(person: Person): void {
  person.need = person.thirst > 0.6 ? 'Agua dulce' : person.hunger > 0.6 ? 'Alimento' : person.fatigue > 0.55 || person.energy < 0.35 ? 'Descanso' : person.socialLoad > 0.7 ? 'Espacio propio' : person.closeness > 0.5 && person.role !== 'neighbor' ? 'Compañía' : 'Recorrer';
}

/** Chunk de la celda de una tesela en el terreno del dueño (−1 si no es residente). */
function chunkDeCelda(world: World, tile: Tile): number {
  const c = ctxDe(world), celda = c.terreno.celda(tile.x, tile.y);
  return celda < 0 ? -1 : c.terreno.chunkDe(celda);
}


/** V19/L: demanda de recuperación (fatiga + 1 − energía) por debajo de la cual una pausa ya no tiene qué reparar. */
const REST_RECOVERED = 0.2;
