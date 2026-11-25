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
import { ley } from '../params.js';
import { RADIUS } from '../mundo/tipos.js';
import { ctxMateriaDe, type CtxLeyMateria } from '../motor/acceso.js';
import { Clase, REF_NULA, slotDe, type Ref } from '../motor/contratos.js';
import { masCercano } from '../motor/vecinos.js';
import { pagar, soltar, trasladarAlimento } from '../materia/cuerpo.js';
import { Rol, type Cuerpo } from '../materia/tipos.js';
import { cazarAnimal, extraerDeAnimal, valorDeAnimal, animalVisto } from './caza.js';
import { celdaEsPropia, contar, escalaBocado, gastarMaderaEnSuelo, marcarCarne } from './recursos.js';

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
  if (person.cuerpo && ley(world, 'cuerpos')) {
    const c = ctxMateriaDe(world);
    if (person.action === 'hunt' && ley(world, 'fauna')) { cazarPorTick(c, person, person.cuerpo); return; }
    // El trabajo se paga quemando reserva; quien no alcanza a pagarlo avanza solo la parte pagada.
    const parte = pagar(c, person.cuerpo, TRABAJO_J_TICK) / TRABAJO_J_TICK;
    exertBody(person, { energy: 0, fatigue: workEffort(person).fatigue * parte });
    if (!(parte > 0)) {
      person.reason = 'Sin reserva que quemar no puede trabajar: necesita comer antes.';
      person.decisionAt = world.tick + 1;
      return;
    }
    if (ley(world, 'obra') && (person.action === 'build' || person.action === 'repair')) { obraPorTick(world, person, tile, parte); return; }
    person.work += parte;
  } else {
    exertBody(person, workEffort(person));
    person.work++;
  }
  const duration = workDuration(world, person);
  if (person.work < duration) return;
  let success = false;
  if (person.action === 'gather') {
    success = gatherResources(world, person, tile);
  } else if (person.action === 'forage') {
    success = forageFood(world, person, tile);
  } else if (person.action === 'farm' && person.materials.wood >= 1 && tile.terrain !== 'shelter' && tile.moisture > 0.2 && tile.vegetation < 0.9) {
    if (cultivateTile(tile)) {
      if (person.cuerpo && ley(world, 'cuerpos') && ley(world, 'obra')) {
        const c = ctxMateriaDe(world);
        gastarMaderaEnSuelo(c, person, c.terreno.celda(tile.x, tile.y), 1);
      } else person.materials.wood--;
      count(world, 'cultivations'); success = true;
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


// ── V23: trabajar con un cuerpo de átomos ────────────────────────────────────────────────────────────────

// Constantes físicas: viven en shared/naturaleza.ts (integrador) y se reexportan aquí.
import { ALCANCE_MANO, CARNE_A_CUESTAS_KG, TRABAJO_J_TICK } from '../../shared/naturaleza.js';
export { ALCANCE_MANO, CARNE_A_CUESTAS_KG, TRABAJO_J_TICK };

/** Última posición vista de la presa, para ir a por el cadáver cuando muere fuera de su celda. */
const ultimaPresa = new WeakMap<Person, { x: number; y: number }>();
/** Si la tarea de obra en curso aportó algo desde la última vez que la valoró. */
const aportoObra = new WeakSet<Person>();
const cadaveres = new Float64Array(8);

/** Con obra, construir y reparar aportan cada tick pagado una pieza o un paso (t2); el resultado se valora con la
 * cadencia de siempre, sin el examen heredado de `person.work` y `person.materials`. */
function obraPorTick(world: World, person: Person, tile: Tile, parte: number): void {
  const emit = (event: Parameters<typeof addEvent>[1]) => addEvent(world, event);
  let aporto = false;
  if (person.action === 'build') aporto = completeConstruction(world, person, tile, emit) !== null;
  else {
    const structure = primeroCerca(world.structures, tile, 1, s => s.x === tile.x && s.y === tile.y);
    aporto = !!structure && repair(world, person, structure, emit);
  }
  if (aporto) aportoObra.add(person);
  person.work += parte;
  if (person.work < Math.ceil(18 * (1 - (person.skills[person.action] ?? 0) * 0.25))) return;
  const success = aportoObra.has(person);
  aportoObra.delete(person);
  person.work = 0;
  outcome(world, person, person.action, success ? person.action === 'build' ? 0.3 : 0.14 : -0.2, success);
  if (!success) person.reason = 'La obra no avanzó: faltan piezas a cuestas o condiciones en el sitio.';
  if (person.command && ['build', 'repair'].includes(person.command.order)) { person.command = null; person.controlMode = 'auto'; }
  person.decisionAt = world.tick + 1;
}

/** La presa que persigue esta persona, por el frente; si no tiene, la que más le vale a su alcance de vista. */
function presaDe(c: CtxLeyMateria, person: Person): Ref {
  const uid = person.huntingPreyId ? c.uidDe(person.huntingPreyId) : 0;
  let presa = uid > 0 ? c.ref(uid) : REF_NULA;
  if (presa !== REF_NULA || person.huntingPreyId) return presa;
  presa = masCercano(c, person.x, person.y, RADIUS, Clase.Animal, -1, slot => {
    const v = valorDeAnimal(c, person, slot);
    return v.cazar > 0 || v.extraer > 0;
  }, () => c.azar());
  if (presa !== REF_NULA) person.huntingPreyId = c.idDe(c.frente.uid[slotDe(presa)] ?? 0);
  return presa;
}

/**
 * Cazar o esquilar con cuerpos y fauna (f): junto a la presa, un golpe pagado por tick (`cazarAnimal`) o, si consiente y
 * le vale más, ordeñarla o esquilarla (`extraerDeAnimal`); lejos, la sigue. Muerta, su cadáver queda en su celda: se
 * lleva una parte a cuestas y la persona vuelve a elegir (comer empieza por el cadáver de su celda).
 */
function cazarPorTick(c: CtxLeyMateria, person: Person, cuerpo: Cuerpo): void {
  const world = c.mundo, presa = presaDe(c, person), fr = c.frente;
  if (presa !== REF_NULA) {
    const slot = slotDe(presa), px = fr.x[slot] ?? person.x, py = fr.y[slot] ?? person.y;
    ultimaPresa.set(person, { x: Math.round(px), y: Math.round(py) });
    if (Math.hypot(px - person.x, py - person.y) > ALCANCE_MANO) {
      person.target = { x: Math.round(px), y: Math.round(py) };
      return;
    }
    const v = valorDeAnimal(c, person, slot);
    const pagado = v.extraer > v.cazar && animalVisto(c, slot).consiente
      ? (extraerDeAnimal(c, person, presa, person.hunger > 0.5 ? 'reserva' : 'fibra') !== REF_NULA ? TRABAJO_J_TICK : 0)
      : cazarAnimal(c, person, presa, TRABAJO_J_TICK);
    exertBody(person, { energy: 0, fatigue: workEffort(person).fatigue * Math.min(1, pagado / TRABAJO_J_TICK) });
    if (!(pagado > 0)) { person.decisionAt = world.tick + 1; person.reason = 'No le quedan fuerzas para seguir cazando.'; }
    return;
  }
  // La presa ya no vive (o nunca la hubo): su cadáver, si cayó a la vista, en su celda.
  const donde = ultimaPresa.get(person);
  if (donde && (donde.x !== person.x || donde.y !== person.y)) { person.target = { ...donde }; ultimaPresa.delete(person); return; }
  const celda = c.terreno.celda(person.x, person.y);
  let llevado = 0;
  if (celdaEsPropia(c, celda)) {
    const n = Math.min(c.materia.lotes(celda, Rol.Cadaver, cadaveres), cadaveres.length);
    const quiere = CARNE_A_CUESTAS_KG * escalaBocado(c, cuerpo);
    for (let i = 0; i < n && llevado < quiere; i++) {
      const lote = c.materia.nuevo(Rol.Objeto, -1, 0);
      const kg = trasladarAlimento(c, cuerpo, cadaveres[i]!, lote, quiere - llevado);
      if (kg > 0) { (person.carga ??= []).push(lote); marcarCarne(person, lote); llevado += kg; }
      else if (c.materia.calor(lote) === 0) c.materia.liberar(lote);
      else soltar(c, lote, celda);
    }
  }
  person.huntingPreyId = undefined;
  ultimaPresa.delete(person);
  const success = llevado > 0;
  if (success) { count(world, 'hunts'); contar(world, 'v23CazaKg', llevado); }
  outcome(world, person, 'hunt', success ? 0.14 : -0.2, success);
  if (!success) person.reason = 'La presa se perdió de vista sin dejar un cadáver al alcance.';
  if (person.command?.order === 'hunt') { person.command = null; person.controlMode = 'auto'; }
  person.decisionAt = world.tick + 1;
}
