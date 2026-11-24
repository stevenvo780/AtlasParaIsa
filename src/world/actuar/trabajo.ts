import type { Person, World } from '../mundo/tipos.js';
import { trackedPrey, huntWorkDuration, organicLot, HUNT_ORGANIC } from './caza.js';
import { gatherResources, forageFood } from './recursos.js';
import { clamp } from '../mundo/geometria.js';
import { addEvent } from '../mundo/crear.js';
import { outcome } from '../decision/personas.js';
import { paramsOf } from '../params.js';
import { constructionCost, completeConstruction, invent, repair } from '../inventions.js';
import { constructionWorkFactor, huntingWorkFactor, useTool, recordTechnologyBenefit, consumeHuntingTools } from '../technology.js';
import type { Tile } from '../../shared/types.js';
import { exertBody, assimilateFood } from '../body.js';
import { cultivateTile } from '../ecosystem.js';
import { count } from '../statistics.js';
import { harvestAt } from '../animals.js';
import { HAMBRE_POR_UNIDAD } from '../ecologia-constantes.js';
import { primeroCerca } from '../indice-puntos.js';

export function workEffort(person: Person, work = 1) {
  return { energy: work * 0.0003, fatigue: work * 0.00025 * (1.2 - person.traits.resilience * 0.4) };
}

export function forageDuration(person: Person): number {
  return Math.ceil(18 * (1 - (person.skills.forage ?? 0) * 0.25));
}

function workDuration(world: World, person: Person, action = person.action): number {
  if (action === 'hunt' && paramsOf(world).quimica.emergente) {
    const prey = trackedPrey(world.animals, person);
    if (prey) return huntWorkDuration(person, prey);
  }
  const base = action === 'build' ? constructionCost(world, person).work : action === 'invent' ? 60 : action === 'repair' ? 30
    : (action === 'farm' || action === 'hunt') ? Math.ceil(45 * (1 - (person.skills[action] ?? 0) * 0.25))
      : Math.ceil(18 * (1 - (person.skills[action] ?? 0) * 0.25));
  if (action === 'build') { const f = constructionWorkFactor(world, person); return f < 1 ? Math.ceil(base * f) : base; }
  if (action === 'hunt') { const f = huntingWorkFactor(world, person); return f < 1 ? Math.ceil(base * f) : base; }
  return base;
}

export function performWork(world: World, person: Person, tile: Tile): void {
  exertBody(person, workEffort(person));
  person.work++;
  const duration = workDuration(world, person);
  if (person.work < duration) return;
  let success = false;
  if (person.action === 'gather') {
    success = gatherResources(world, person, tile);
  } else if (person.action === 'forage') {
    success = forageFood(world, person, tile);
  } else if (person.action === 'farm' && person.materials.wood >= 1 && tile.terrain !== 'shelter' && tile.moisture > 0.2 && tile.vegetation < 0.9) {
    if (cultivateTile(tile)) {
      person.materials.wood--; count(world, 'cultivations'); success = true;
      if ((tile.cultivation??0)<1) {
        const receipt=useTool(world,person,'cultivation'), before=tile.cultivation??0;
        tile.cultivation=clamp(before+(receipt?.power??0)*0.15);
        recordTechnologyBenefit(world,person,receipt,tile.cultivation-before);
      }
    }
  } else if (person.action === 'hunt' && (tile.fauna ?? 0) >= 1) {
    const emergent = paramsOf(world).quimica.emergente;
    const biomass = harvestAt(world,tile,person.id,event=>addEvent(world,event), emergent ? person.huntingPreyId : undefined);
    // One carcass: 80% edible, 20% hide/bone/tallow into universal chemistry.
    const food = emergent ? biomass * 0.8 : biomass;
    if (emergent && biomass > 0) organicLot(world, person, biomass * 0.2, HUNT_ORGANIC);
    const stored = Math.min(0.25 - person.inventory, food * 0.5);
    person.inventory += stored; assimilateFood(person, food - stored, { hungerPerUnit: HAMBRE_POR_UNIDAD, energyPerUnit: 0 });
    if (food > 0) { count(world, 'hunts'); consumeHuntingTools(world, person, food); }
    count(world, 'foodHarvested', food); success = food > 0;
  } else if (person.action === 'build') {
    success=!!completeConstruction(world,person,tile,event=>addEvent(world,event));
  } else if(person.action==='invent') {
    success=invent(world,person,event=>addEvent(world,event));
  } else if(person.action==='repair') {
    const structure=primeroCerca(world.structures, tile, 1, s=>s.x===tile.x&&s.y===tile.y);
    if(structure) success=repair(world,person,structure,event=>addEvent(world,event));
  }
  person.work = 0;
  outcome(world, person, person.action, success ? person.action === 'build' ? 0.3 : 0.14 : -0.2, success);
  if (!success) person.reason = 'La tarea no produjo un resultado: faltan recursos o condiciones. Esa experiencia reduce su preferencia.';
  if (person.command && ['build', 'farm', 'invent', 'repair', 'forage'].includes(person.command.order)) { person.command = null; person.controlMode = 'auto'; }
  person.decisionAt = world.tick + 1;
}
