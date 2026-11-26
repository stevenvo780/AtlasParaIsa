import { ley } from '../params.js';
import type { Person, World } from '../mundo/tipos.js';
import { distance, clamp, type TileLookup } from '../mundo/geometria.js';
import { workEffort, performWork } from './trabajo.js';
import { outcome } from '../decision/personas.js';
import { type ElementVector, evaluateMaterialProperties, type CompoundLot, vectorMass } from '../../shared/chemistry.js';
import { type Animal, isHerdAnimal, animalesVivosEnCelda } from '../animals.js';
import { golpearAnimal } from '../ley-fauna.js';
import { defaultChemistryState, formulaSignature, MAX_PERSON_COMPOUNDS, applyChemOperator } from '../chemistry.js';
import { exertBody, assimilateFood } from '../body.js';
import { HAMBRE_POR_UNIDAD } from '../ecologia-constantes.js';
import { count } from '../statistics.js';
import { C_MOVER } from '../../shared/naturaleza.js';
import { formaDeCodigo } from '../../shared/materia.js';
import { ctxSi, type CtxLeyMateria } from '../motor/acceso.js';
import { CAMPOS_CUERPO, CUERPO_ANCHO, DATO_GOLPEAR, DATO_TOMAR, GENOMA_ANCHO, REF_NULA, TipoIntento, slotDe, type Ref } from '../motor/contratos.js';
import { masaDe, pagar, reservaJ, vistaCuerpo } from '../materia/cuerpo.js';
import { lotesDeCelda } from '../materia/ley-mundo.js';
import { desprender, reparto } from '../materia/romper.js';
import { Rol, type LoteRef, type VistaCuerpo } from '../materia/tipos.js';
import { GEN, vidaMaxima } from '../decision/fauna.js';
import { CAMPOS_FAUNA, COLUMNA_FAUNA, FAUNA_ANCHO } from '../soa/fauna-v23.js';

export const HUNT_ORGANIC: ElementVector = { C: 0.48, H: 0.28, Ca: 0.16, S: 0.05, Si: 0.02, Fe: 0.01 };

const TEND_ORGANIC: ElementVector = { C: 0.56, H: 0.34, Ca: 0.06, S: 0.04, Si: 0, Fe: 0 };

export const huntable = (a: Animal, hunger: number): boolean => (a.habituation ?? 0) < 0.45 || hunger > 0.78;


/** The same physical work estimate is used by planning and paid execution. */
export function huntWorkDuration(person: Person, prey: Animal): number {
  let weapon = 0;
  if (person.compounds) for (const lot of person.compounds) if (lot.mass >= 0.05) {
    const p = evaluateMaterialProperties(lot.composition, lot.phase);
    weapon = Math.max(weapon, p.hardness * p.toughness);
  }
  for (const item of person.technology.items) if (item.mass > 0) {
    const p = item.properties;
    weapon = Math.max(weapon, p.hardness * p.toughness * p.edge);
  }
  const base = Math.max(10, Math.min(34, Math.round(14 + prey.genes.speed * 12 + (prey.morphology?.caution ?? 0.5) * 10 - weapon * 10)));
  return Math.max(6, Math.ceil(base * (1 - (person.skills.hunt ?? 0) * 0.3)));
}

export function trackedPrey(animals: readonly Animal[], person: Person): Animal | undefined {
  return animals.find(a => a.id === person.huntingPreyId && a.health > 0 && distance(a, person) <= 7 && huntable(a, person.hunger));
}

export function canTend(a: Animal, person: Person, tick: number): boolean {
  return isHerdAnimal(a) && a.health > 0 && (a.habituation ?? 0) >= 0.45 && a.hunger < 0.45 && a.energy > 0.35
    && (a.lastTended === undefined || tick - a.lastTended >= 480)
    && (a.lastHunted === undefined || tick - a.lastHunted >= 120) && distance(a, person) <= 2;
}

function tendingAnimal(world: World, person: Person): Animal | undefined {
  let best: Animal | undefined;
  // Serial action phase: reuse the existing live fauna grid, with a two-cell
  // neighborhood. The linear fallback also supports callers outside stepWorld.
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    if (Math.abs(dx) + Math.abs(dy) > 2) continue;
    const nearby = animalesVivosEnCelda(world, person.x + dx, person.y + dy);
    if (nearby === undefined) {
      const animals = world.animals;
      for (const a of animals) if (canTend(a, person, world.tick) && (!best || a.id < best.id)) best = a;
      return best;
    }
    for (const a of nearby) if (canTend(a, person, world.tick) && (!best || a.id < best.id)) best = a;
  }
  return best;
}

/** Organic matter is transferred from a carcass or a paid animal reserve, never
 * extracted from geology. Raw lots use provenance signatures just like geo lots. */
export function organicLot(world: World, person: Person, mass: number, recipe: ElementVector): void {
  const state = world.chemistry ?? (world.chemistry = defaultChemistryState());
  const composition: ElementVector = { C: recipe.C * mass, H: recipe.H * mass, Ca: recipe.Ca * mass, S: recipe.S * mass, Si: recipe.Si * mass, Fe: recipe.Fe * mass };
  const lot: CompoundLot = { id: `L${++state.lotCounter}`, formulaId: `bio:${formulaSignature('raw', composition)}`,
    composition, mass: vectorMass(composition), phase: 'raw', properties: evaluateMaterialProperties(composition, 'raw') };
  const lots = person.compounds ?? (person.compounds = []);
  if (!ley(world, 'tecnica') && lots.length >= MAX_PERSON_COMPOUNDS) {
    const b = lots.pop()!, a = lots.pop()!;
    lots.push(applyChemOperator('bind', a, { b, temperatureTier: 0, tick: world.tick, actorId: person.id }, state).product);
  }
  lots.push(lot);
}

export function tendNearbyAnimal(world: World, person: Person): boolean {
  if (person.action !== 'forage' && person.action !== 'cooperate' && person.action !== 'share') { person.tending = undefined; return false; }
  const animal = tendingAnimal(world, person);
  if (!animal) { person.tending = undefined; return false; }
  if (person.tending?.id !== animal.id) person.tending = { id: animal.id, work: 0 };
  exertBody(person, workEffort(person));
  person.tending.work++;
  person.reason = 'Cuida un animal habituado y recoge una porción renovable de alimento y fibra.';
  if (person.tending.work < 6) return true;
  // V23: el animal tiene cuerpo; lo que se saca sale de su reserva y de su pelo, por intento a su dueño.
  const c = materiaDe(world);
  if (c && animal.cuerpo && person.cuerpo && animal.uid !== undefined) {
    const ref = c.ref(animal.uid);
    if (ref !== REF_NULA) { extraerDeAnimal(c, person, ref, 'reserva'); extraerDeAnimal(c, person, ref, 'fibra'); }
    outcome(world, person, person.action, 0.14, true);
    person.tending = undefined; person.work = 0; person.decisionAt = world.tick + 1;
    return true;
  }
  const size = animal.morphology?.size ?? 0.5, coat = animal.morphology?.coat ?? 0.5;
  const food = 0.08 + size * 0.06, fiber = (0.012 + coat * 0.028) * (0.75 + size * 0.65);
  // Renewable output consumes body reserves; grazing must replenish them before
  // another harvest. A cooldown belongs to the animal, shared by all inhabitants.
  animal.hunger = clamp(animal.hunger + (food + fiber) * 4);
  animal.energy = clamp(animal.energy - (food + fiber) * 0.5);
  animal.lastTended = world.tick; animal.tends = (animal.tends ?? 0) + 1;
  animal.habituation = clamp((animal.habituation ?? 0) + 0.06);
  const stored = Math.min(Math.max(0, 0.25 - person.inventory), food);
  person.inventory += stored;
  assimilateFood(person, food - stored, { hungerPerUnit: HAMBRE_POR_UNIDAD, energyPerUnit: 0 });
  organicLot(world, person, fiber, TEND_ORGANIC); count(world, 'foodHarvested', food);
  outcome(world, person, person.action, 0.14, true);
  person.tending = undefined; person.work = 0; person.decisionAt = world.tick + 1;
  return true;
}


export function trackHuntingPrey(world: World, person: Person): void {
  const prey = trackedPrey(world.animals, person);
  if (prey) person.target = { x: prey.x, y: prey.y };
  else { person.huntingPreyId = undefined; person.work = 0; person.decisionAt = world.tick; }
}


export function pursuePrey(world: World, person: Person, tileIn: TileLookup): void {
  const prey = trackedPrey(world.animals, person);
  if (prey && distance(person, prey) <= 1.5) {
    const preyTile = tileIn(prey.x, prey.y);
    if (preyTile) performWork(world, person, preyTile);
  }
}

// ── V23 (`v23.fauna`): caza por la ley de romper y extracción no letal, por intentos ──────────────────────────
//
// La presa es un organismo de otro (aunque sea del mismo hilo): se le golpea con un `Golpear` y se le pide reserva o
// fibra con un `Tomar` (`leyFauna.aplicar`). Lo que cuesta se paga quemando la reserva propia. Nada lee especie.

// ── Constantes físicas: viven en shared/naturaleza.ts (integrador) y se reexportan aquí ─────────────────────
import { TASA_EXTRACCION } from '../../shared/naturaleza.js';
import { leyFauna } from '../ley-fauna.js';
export { TASA_EXTRACCION };

/** El contexto de materia del dueño de `world`, si el motor ya lo enlazó. */
function materiaDe(world: World): CtxLeyMateria | undefined {
  const c = ctxSi(world) as Partial<CtxLeyMateria> | undefined;
  return c?.materia && c.quimica ? c as CtxLeyMateria : undefined;
}

/** El golpe de una persona con el útil que más rompe de los que lleva (dureza·tenacidad·(1 + filo)), o con la mano
 * (su propio tejido, sin filo). La esbeltez es largo/(largo + grueso) de su forma, en [0, 1). */
export function golpeDePersona(c: CtxLeyMateria, person: Person, trabajo: number): { golpe: Float64Array; util: LoteRef } {
  const golpe = new Float64Array(5);
  let util: LoteRef = REF_NULA, mejor = -1;
  for (const l of person.carga ?? []) {
    if (!c.materia.vivo(l)) continue;
    const v = c.materia.vista(l), f = v.forma ? formaDeCodigo(v.forma) : undefined, filo = f?.filo ?? 0;
    const valor = v.dureza * v.tenacidad * (1 + filo);
    if (valor <= mejor) continue;
    mejor = valor; util = l;
    golpe[DATO_GOLPEAR.filo] = filo; golpe[DATO_GOLPEAR.tenacidad] = v.tenacidad; golpe[DATO_GOLPEAR.dureza] = v.dureza;
    golpe[DATO_GOLPEAR.esbeltez] = f ? f.largo / (f.largo + Math.max(f.ancho, f.grueso, 1e-3)) : 0;
  }
  if (util === REF_NULA && person.cuerpo) {
    const v = c.materia.vista(person.cuerpo.tejido);
    golpe[DATO_GOLPEAR.tenacidad] = v.tenacidad; golpe[DATO_GOLPEAR.dureza] = v.dureza;
  }
  golpe[DATO_GOLPEAR.trabajo] = trabajo;
  return { golpe, util };
}

const duenoDe = (c: CtxLeyMateria, r: Ref): number => {
  const d = c.frente.dueno[slotDe(r)] ?? -1;
  return d >= 0 ? d : c.hilo;
};

/**
 * Un tick de ataque de una persona a un animal (ref del frente): paga `trabajoJ` con su reserva, manda el golpe al dueño
 * de la presa (que lo resuelve con `herir`, la ley de romper sobre su tejido) y desgasta su útil con la parte del golpe
 * que le toca (`reparto`), que cae al suelo de su celda. El blanco del desgaste es su propio tejido: todos los cuerpos
 * son de la misma química, y el de la presa no se puede leer sin ser su dueño. Devuelve los J pagados.
 */
export function cazarAnimal(c: CtxLeyMateria, person: Person, presa: Ref, trabajoJ: number): number {
  if (!person.cuerpo || presa === REF_NULA || !(trabajoJ > 0)) return 0;
  const pagado = pagar(c, person.cuerpo, trabajoJ);
  if (!(pagado > 0)) return 0;
  const { golpe, util } = golpeDePersona(c, person, pagado);
  golpearAnimal(c, c.ref(person.uid ?? 0), presa, golpe);
  const celda = c.terreno.celda(person.x, person.y);
  if (util !== REF_NULA && celda >= 0 && c.terreno.duenoChunk[c.terreno.chunkDe(celda)] === c.hilo) {
    const desgaste = reparto(golpe, c.materia.vista(person.cuerpo.tejido)).util;
    const suelo = lotesDeCelda(c, celda, { suelo: REF_NULA, agua: REF_NULA, vida: REF_NULA, aire: REF_NULA }).suelo;
    if (desgaste > 0 && suelo !== REF_NULA) desprender(c.materia, c.quimica, util, suelo, desgaste, () => c.azar());
  }
  return pagado;
}

/**
 * Ordeñar (`reserva`) o esquilar (`fibra`) un animal: pide al dueño del animal lo que unas manos sacan en un tick, que
 * él concede si el animal no tiene más miedo que reserva relativa. La leche va al tubo de la persona (se bebe al
 * ordeñar); la fibra, a un lote Objeto nuevo que lleva a cuestas. El trabajo (mover lo sacado) se paga con su reserva:
 * C_MOVER·kg. Devuelve el lote donde llegará lo concedido, o REF_NULA si no pudo pedirlo.
 */
export function extraerDeAnimal(c: CtxLeyMateria, person: Person, animal: Ref, parte: 'reserva' | 'fibra'): LoteRef {
  if (!person.cuerpo || animal === REF_NULA) return REF_NULA;
  const de = c.ref(person.uid ?? 0), celda = c.terreno.celda(person.x, person.y);
  if (c.params.v23.intentos && (de === REF_NULA || celda < 0)) return REF_NULA;
  const kg = TASA_EXTRACCION * masaDe(c, person.cuerpo) ** 0.75;
  if (!(kg > 0) || pagar(c, person.cuerpo, C_MOVER * kg) <= 0) return REF_NULA;
  let destino: LoteRef = person.cuerpo.digestivo;
  if (parte === 'fibra') destino = c.materia.nuevo(Rol.Objeto, -1, 0);
  const dato = new Float64Array(DATO_TOMAR.kappa + 4);
  dato[DATO_TOMAR.rol] = parte === 'reserva' ? Rol.Reserva : Rol.Tejido;
  dato[DATO_TOMAR.esp] = 0; dato[DATO_TOMAR.cuantos] = kg * 1000; dato[DATO_TOMAR.loteDestino] = destino;
  const intento = { tipo: TipoIntento.Tomar, de, a: animal, celda, lote: REF_NULA,
    nonce: c.id('nonce'), materia: null, dato, bytes: null };
  if (c.params.v23.intentos) c.buzon.enviar(duenoDe(c, animal), intento);
  else {
    leyFauna.aplicar?.Tomar?.(c, intento);
    if (parte === 'fibra' && c.materia.especies(destino, new Uint32Array(1)) === 0) {
      c.materia.liberar(destino);
      return REF_NULA;
    }
  }
  if (parte === 'fibra') (person.carga ??= []).push(destino);
  return destino;
}

/** Miedo y habituación publicados de un animal (columna `fauna` del frente), y si hoy consentiría una extracción. */
export function animalVisto(c: CtxLeyMateria, slot: number): { miedo: number; habituacion: number; reserva: number; consiente: boolean } {
  const fauna = c.frente.columnas.includes(COLUMNA_FAUNA) ? c.frente.col(COLUMNA_FAUNA) : undefined;
  const miedo = fauna?.[slot * FAUNA_ANCHO + CAMPOS_FAUNA.miedo] ?? 1, habituacion = fauna?.[slot * FAUNA_ANCHO + CAMPOS_FAUNA.habituacion] ?? 0;
  const reserva = c.frente.cuerpo[slot * CUERPO_ANCHO + CAMPOS_CUERPO.energia] ?? 0;
  return { miedo, habituacion, reserva, consiente: miedo < reserva };
}

/** Borrador de `vistaCuerpo` para `valorDeAnimal` (un solo hilo por dueño). */
const vistaPropia: VistaCuerpo = { hambre: 0, sed: 0, energia: 0, salud: 0, masa: 0, carga: 0, T: 0 };

/**
 * Lo que vale para una persona un animal del frente, en J digeribles (leyes-opus §3e, «ganadería»): cazarlo ahora (su
 * masa a la densidad de la carne, menos perseguirlo y el riesgo de su defensa) o extraerle de forma sostenida (lo que
 * sacan sus manos por tick durante la mitad de la vida que le queda por alometría, si hoy lo consiente). La persona
 * descuenta lo diferido por su hambre: con hambre 1 solo cuenta lo de ahora.
 */
export function valorDeAnimal(c: CtxLeyMateria, person: Person, slot: number): { cazar: number; extraer: number } {
  if (!person.cuerpo) return { cazar: 0, extraer: 0 };
  const fr = c.frente, masaP = fr.cuerpo[slot * CUERPO_ANCHO + CAMPOS_CUERPO.masa] ?? 0, masaYo = masaDe(c, person.cuerpo);
  const tejido = c.materia.vista(person.cuerpo.tejido), jPorKg = tejido.masa > 0 ? tejido.digerible / tejido.masa : 0;
  const d = Math.hypot((fr.x[slot] ?? 0) - person.x, (fr.y[slot] ?? 0) - person.y);
  const defensa = fr.genoma[slot * GENOMA_ANCHO + GEN.defensa] ?? 0;
  const cazar = masaP * jPorKg - C_MOVER * masaYo * d - defensa * (masaP / Math.max(masaYo, 1e-9)) * reservaJ(c, person.cuerpo);
  const visto = animalVisto(c, slot), hambre = Math.min(1, Math.max(0, vistaCuerpo(c, person.cuerpo, vistaPropia).hambre));
  const masaAdulta = Math.exp(fr.genoma[slot * GENOMA_ANCHO + GEN.lnMasa] ?? 0);
  const extraer = visto.consiente
    ? TASA_EXTRACCION * masaYo ** 0.75 * jPorKg * vidaMaxima(masaAdulta) / 2 * (1 - hambre) - C_MOVER * masaYo * d
    : 0;
  return { cazar, extraer };
}
