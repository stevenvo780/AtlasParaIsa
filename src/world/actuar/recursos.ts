import type { World, Person } from '../mundo/tipos.js';
import { clamp, distance } from '../mundo/geometria.js';
import { outcome } from '../decision/personas.js';
import { tileIsDesert } from '../decision/sentidos.js';
import { addEvent } from '../mundo/crear.js';
import type { Tile } from '../../shared/types.js';
import type { ResidentFastAccess } from '../soa/terreno.js';
import { count } from '../statistics.js';
import { takeFood, takeWater, BROKEN_CONDITION } from '../inventions.js';
import { assimilateFood, hydrateBody } from '../body.js';
import { HAMBRE_POR_UNIDAD, SED_POR_UNIDAD, SED_POR_PASO } from '../ecologia-constantes.js';
import { demographicTraits } from '../demography.js';
import { type WorldParams, paramsOf } from '../params.js';
import { WATER_QUANTA_PER_UNIT } from '../material-affordances.js';
import { drinkContainedWater, beginWaterPreparation } from '../technology-water.js';
import { useTool, recordTechnologyBenefit } from '../technology.js';
import { compoundToolBonus, performChemistryExperiment } from '../chemistry.js';
import { harvestMaterial } from '../ecosystem.js';
import { filtrarCerca } from '../indice-puntos.js';

export const MIN_FORAGE_STOCK = 0.005;

export const FORAGE_AMOUNT = 0.06;


export function eat(world: World, person: Person, current: Tile, currentCell: number, fast?: ResidentFastAccess): void {
  const foodBefore = fast && currentCell >= 0 ? fast.foodArr[currentCell]! : current.food;
  const harvest = Math.min(foodBefore, 0.0035);
  current.food = clamp(foodBefore - harvest);
  count(world, 'foodHarvested', harvest);
  const vegBefore = fast && currentCell >= 0 ? fast.vegetationArr[currentCell]! : current.vegetation;
  current.vegetation = clamp(vegBefore - harvest * 0.1);
  // Harvested biomass is divided between today's meal and a bounded portable reserve.
  const saved = Math.min(harvest * 0.25, 0.25 - person.inventory);
  person.inventory += saved;
  let consumed = harvest - saved;
  if(consumed<0.001 && person.hunger>0.2) consumed += takeFood(world,person,0.002);
  if (consumed < 0.001 && person.inventory > 0 && person.hunger > 0.2) {
    const carried = Math.min(person.inventory, 0.002);
    person.inventory -= carried; consumed += carried;
  }
  assimilateFood(person, consumed, { hungerPerUnit: HAMBRE_POR_UNIDAD, energyPerUnit: 1.2 });
  if (consumed > 0 && world.tick - person.lastOutcome >= 30) outcome(world, person, 'eat', consumed * 30);
  if (person.hunger < 0.12) person.decisionAt = world.tick + 1;
}


export function drink(world: World, person: Person, current: Tile, currentCell: number, fast: ResidentFastAccess | undefined, physiology: ReturnType<typeof demographicTraits>, params: WorldParams): void {
  const needed = Math.min(0.006, person.thirst / SED_POR_UNIDAD);
  const ambient = takeWater(world, person, needed);
  hydrateBody(person, ambient);
  if (ambient > 0 && params.agua.memoria < 1) person.waterMemory = { x: person.x, y: person.y };
  const remaining = Math.max(0, Math.floor((needed - ambient) * WATER_QUANTA_PER_UNIT));
  const contained = remaining > 0 ? drinkContainedWater(world, person, remaining) / WATER_QUANTA_PER_UNIT : 0;
  const water = contained + ambient;
  count(world, 'waterConsumed', water);
  if (water > 0 && world.tick - person.lastOutcome >= 30) outcome(world, person, 'drink', water * 20);
  if (person.thirst < 0.12) {
    if (person.command?.order === 'drink') { person.command = null; person.controlMode = 'auto'; }
    person.decisionAt = world.tick + 1;
    if (ambient > 0 && !person.command && beginWaterPreparation(world, person,
      (SED_POR_PASO + (tileIsDesert(current, currentCell, fast) ? 0.0002 : 0)) * physiology.waterDemand)) {
      person.reason = 'Ya bebió de la fuente local; prepara una reserva útil para cuando se aleje.';
    }
  }
}


export function gatherResources(world: World, person: Person, tile: Tile): boolean {
  let success = false;
  const preferred = person.materials.wood < 6 ? 'wood' : 'stone';
  for (const material of [preferred, preferred === 'wood' ? 'stone' : 'wood'] as const) {
    const available = tile[material] ?? 0;
    if (available < 1 || person.materials[material] >= (material === 'wood' ? 12 : 8)) continue;
    const capacity=(material==='wood'?12:8)-person.materials[material];
    const baseline=Math.min(1,capacity,available);
    const receipt=capacity>1&&available>1 ? useTool(world,person,material==='wood'?'cutting':'abrasion') : undefined;
    const chemBonus = paramsOf(world).quimica.emergente ? compoundToolBonus(person.compounds, material === 'wood' ? 'cutting' : 'abrasion') : 0;
    const amount = harvestMaterial(tile, material, Math.min(capacity,1+(receipt?.power??0)+chemBonus));
    person.materials[material] += amount; count(world, material === 'wood' ? 'woodGathered' : 'stoneGathered', amount);
    recordTechnologyBenefit(world,person,receipt,amount-baseline); success = amount > 0;
    if (success && paramsOf(world).quimica.emergente && (person.compounds?.length ?? 0) < 5 && (world.tick + Math.abs(person.x * 7 + person.y * 13)) % 2 === 0) {
      const nearbyChem = filtrarCerca(world.structures, person, 4, s => distance(person, s) <= 3 && s.condition > BROKEN_CONDITION && (!s.site || !!s.site.expansion));
      const chem = performChemistryExperiment(world, person, tile, nearbyChem);
      if (chem?.isNew) addEvent(world, { kind: 'invention', actors: [person.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} obtuvo ${chem.formula.name} (T${chem.temperatureTier}).`, cause: `Extracción y proceso químico local (${chem.operator}) desde la geología del lugar.` });
    }
    break;
  }
  return success;
}


export function forageFood(world: World, person: Person, tile: Tile): boolean {
  let success = false;
  const foodBefore = tile.food, harvested = Math.min(foodBefore, FORAGE_AMOUNT, Math.max(0, 0.25 - person.inventory));
  tile.food = clamp(foodBefore - harvested);
  tile.vegetation = clamp(tile.vegetation - harvested * 0.1);
  person.inventory += harvested;
  count(world, 'foodHarvested', harvested);
  success = harvested > 0;
  return success;
}
