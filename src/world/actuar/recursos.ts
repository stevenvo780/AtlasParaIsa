import type { World, Person } from '../mundo/tipos.js';
import { clamp, distance } from '../mundo/geometria.js';
import { outcome } from '../decision/personas.js';
import { tileIsDesert } from '../decision/sentidos.js';
import { addEvent } from '../mundo/crear.js';
import type { Tile } from '../../shared/types.js';
import type { ResidentFastAccess } from '../soa/terreno.js';
import { count } from '../statistics.js';
import { guardarEnObra, takeFood, takeWater, BROKEN_CONDITION } from '../inventions.js';
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
import { marcarTesela } from '../soa/barrera-percepcion.js';
import { ley } from '../params.js';
import { ctxMateriaDe, type CtxLeyMateria } from '../motor/acceso.js';
import { REF_NULA } from '../motor/contratos.js';
import { extraerEscalar, lotesDeCelda, rocaDe, sustanciasDe, type LotesCelda } from '../materia/ley-mundo.js';
import { MASA_ADULTA_HUMANA, beber, beberEnCelda, comerEnCelda, energiaAlimento, ingerirSelecto, masaDe, soltar, trasladarAlimento } from '../materia/cuerpo.js';
import { Rol, type Cuerpo, type LoteRef } from '../materia/tipos.js';
import { madurezDe } from '../cohesion.js';

export const MIN_FORAGE_STOCK = 0.005;

export const FORAGE_AMOUNT = 0.06;


export function eat(world: World, person: Person, current: Tile, currentCell: number, fast?: ResidentFastAccess): void {
  if (person.cuerpo && ley(world, 'cuerpos')) { comerConCuerpo(world, person, person.cuerpo, current); return; }
  const foodBefore = fast && currentCell >= 0 ? fast.foodArr[currentCell]! : current.food;
  let harvest = Math.min(foodBefore, 0.0035 * madurezEscalar(world, person));
  if (ley(world, 'materia')) {
    // La vista `food` la reescribe w tras el paso material de la página: restar del escalar no comería nada.
    harvest = extraerDeCelda(world, current, 'comida', harvest);
  } else {
    current.food = clamp(foodBefore - harvest);
    const vegBefore = fast && currentCell >= 0 ? fast.vegetationArr[currentCell]! : current.vegetation;
    current.vegetation = clamp(vegBefore - harvest * 0.1);
    marcarTesela(current);
  }
  count(world, 'foodHarvested', harvest);
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
  if (person.cuerpo && ley(world, 'cuerpos')) { beberConCuerpo(world, person, person.cuerpo, current); return; }
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
  if (person.cuerpo && ley(world, 'cuerpos') && ley(world, 'obra')) return recogerACuestas(world, person, person.cuerpo, tile);
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
  if (person.cuerpo && ley(world, 'cuerpos')) return forrajearACuestas(world, person, person.cuerpo, tile);
  let success = false;
  const foodBefore = tile.food;
  let harvested = Math.min(foodBefore, FORAGE_AMOUNT * madurezEscalar(world, person), Math.max(0, 0.25 - person.inventory));
  if (ley(world, 'materia')) harvested = extraerDeCelda(world, tile, 'comida', harvested);
  else {
    tile.food = clamp(foodBefore - harvested);
    tile.vegetation = clamp(tile.vegetation - harvested * 0.1);
    marcarTesela(tile);
  }
  person.inventory += harvested;
  count(world, 'foodHarvested', harvested);
  success = harvested > 0;
  return success;
}


// ── V23: comer, beber y recoger sobre la materia ─────────────────────────────────────────────────────────

// Constantes físicas: viven en shared/naturaleza.ts (integrador) y se reexportan aquí.
import { BOCADO_KG, EXPONENTE_BOCADO, FORRAJEO_KG, KG_POR_UNIDAD_MATERIAL, SORBO_KG } from '../../shared/naturaleza.js';
export { BOCADO_KG, EXPONENTE_BOCADO, FORRAJEO_KG, KG_POR_UNIDAD_MATERIAL, SORBO_KG };

/** Contadores de `world.totals` que lee el laboratorio (kg acumulados en la vida del mundo). */
export const TOTAL_DIETA_KG = 'v23DietaKg';
export const TOTAL_DIETA_FAUNA_KG = 'v23DietaFaunaKg';
export const TOTAL_BEBIDA_KG = 'v23BebidaKg';
export const TOTAL_FORRAJEO_KG = 'v23ForrajeoKg';
export const TOTAL_RECOGIDA_KG = 'v23RecogidaKg';
export const TOTAL_CAZA_KG = 'v23CazaKg';
/** Σ por persona y tick de la carga a cuestas y de la masa corporal: su cociente es la carga media sobre la masa. */
export const TOTAL_CARGA_KG_TICK = 'v23CargaKgTick';
export const TOTAL_MASA_KG_TICK = 'v23MasaKgTick';
export const TOTALES_MATERIA = new Set<string>([TOTAL_DIETA_KG, TOTAL_DIETA_FAUNA_KG, TOTAL_BEBIDA_KG, TOTAL_FORRAJEO_KG,
  TOTAL_RECOGIDA_KG, TOTAL_CAZA_KG, TOTAL_CARGA_KG_TICK, TOTAL_MASA_KG_TICK]);

export function contar(world: World, clave: string, cantidad: number): void {
  if (!(cantidad > 0)) return;
  world.totals[clave] = (world.totals[clave] ?? 0) + cantidad;
}

const celdaVacia = (): LotesCelda => ({ suelo: REF_NULA, agua: REF_NULA, vida: REF_NULA, aire: REF_NULA });
const lotesCelda = celdaVacia();
const MG_A_KG = 1e-6;
let lotesTmp = new Float64Array(8);

/** ¿Es la celda de este dueño? Lo ajeno solo se toca por intento. */
export const celdaEsPropia = (c: CtxLeyMateria, celda: number): boolean =>
  celda >= 0 && c.terreno.duenoChunk[c.terreno.chunkDe(celda)] === c.hilo;

function cadaveresDe(c: CtxLeyMateria, celda: number): Float64Array {
  const n = c.materia.lotes(celda, Rol.Cadaver, lotesTmp);
  if (n > lotesTmp.length) c.materia.lotes(celda, Rol.Cadaver, lotesTmp = new Float64Array(n));
  return lotesTmp.subarray(0, n);
}

/** J de alimento que la persona puede comer en esta celda, consultados en la arena del dueño. */
export function comidaEnCelda(c: CtxLeyMateria, cuerpo: Cuerpo, punto: { x: number; y: number }, kg: number): number {
  const celda = c.terreno.celda(punto.x, punto.y);
  if (!celdaEsPropia(c, celda)) return 0;
  const vida = lotesDeCelda(c, celda, lotesCelda).vida;
  let energia = vida >= 0 ? energiaAlimento(c, cuerpo, vida, kg) : 0;
  for (const lote of cadaveresDe(c, celda)) energia += energiaAlimento(c, cuerpo, lote, kg);
  return energia;
}

/** Sin cuerpos, n pide que una cría coma y forrajee en proporción a su madurez. Con cuerpos lo da la masa del cuerpo. */
function madurezEscalar(world: World, person: Person): number {
  return ley(world, 'natalidad') ? Math.max(0, madurezDe(world, person)) : 1;
}

/** Cuánto traga este cuerpo frente a un adulto: (masa / masa adulta)^0,75. */
export function escalaBocado(c: CtxLeyMateria, cuerpo: Cuerpo): number {
  const masa = masaDe(c, cuerpo);
  return masa > 0 ? (masa / MASA_ADULTA_HUMANA) ** EXPONENTE_BOCADO : 0;
}

/** Con materia y cuerpos aún escalares: lo que sale de la tesela va al sumidero declarado de w. */
function extraerDeCelda(world: World, tile: Tile, recurso: 'comida' | 'agua', cantidad: number): number {
  if (!(cantidad > 0)) return 0;
  const c = ctxMateriaDe(world), celda = c.terreno.celda(tile.x, tile.y);
  if (!celdaEsPropia(c, celda)) return 0;
  return extraerEscalar(c, celda, recurso, cantidad);
}

/** Lotes de carne que esta persona lleva desde una caza o un cadáver: lo que come de ellos cuenta como dieta de fauna. */
const carneACuestas = new WeakMap<Person, Set<LoteRef>>();
export function marcarCarne(person: Person, lote: LoteRef): void {
  let s = carneACuestas.get(person);
  if (!s) carneACuestas.set(person, s = new Set());
  s.add(lote);
}

/** Come hasta `kg` de los lotes de la carga; suelta en la celda lo que, tras comer de ello, ya no da nada. */
export function comerDeCarga(c: CtxLeyMateria, person: Person, cuerpo: Cuerpo, kg: number, celda: number): { kg: number; fauna: number } {
  const carga = person.carga, carne = carneACuestas.get(person);
  let comido = 0, fauna = 0;
  if (!carga?.length || !(kg > 0)) return { kg: 0, fauna: 0 };
  for (let i = carga.length - 1; i >= 0 && comido < kg; i--) {
    const lote = carga[i]!;
    if (!c.materia.propio(lote) || !(energiaAlimento(c, cuerpo, lote, kg - comido) > 0)) continue;
    const k = ingerirSelecto(c, cuerpo, lote, kg - comido);
    if (!(k > 0)) continue;
    comido += k;
    if (carne?.has(lote)) fauna += k;
    const queda = c.materia.vista(lote);
    if (queda.masa <= 0 && c.materia.calor(lote) === 0) { c.materia.liberar(lote); carga.splice(i, 1); carne?.delete(lote); }
    else if (!(energiaAlimento(c, cuerpo, lote, Infinity) > 0) && celda >= 0) { soltar(c, lote, celda); carga.splice(i, 1); carne?.delete(lote); }
  }
  return { kg: comido, fauna };
}

/**
 * Comer con cuerpo de átomos: el bocado pasa al digestivo desde lo que hay en la celda propia (primero un cadáver, que se
 * pudre si nadie lo come, luego la vegetación), después de una obra con depósito y por último de lo que lleva a cuestas.
 * Nada se resta de un escalar: las vistas las reescriben w y b.
 */
export function comerConCuerpo(world: World, person: Person, cuerpo: Cuerpo, current: Tile): number {
  const c = ctxMateriaDe(world), celda = c.terreno.celda(current.x, current.y);
  const bocado = BOCADO_KG * escalaBocado(c, cuerpo);
  let comido = 0, fauna = 0;
  if (celdaEsPropia(c, celda)) {
    for (const lote of cadaveresDe(c, celda)) {
      if (comido >= bocado) break;
      const k = ingerirSelecto(c, cuerpo, lote, bocado - comido);
      comido += k; fauna += k;
    }
    if (comido < bocado) comido += comerEnCelda(c, cuerpo, celda, bocado - comido);
  }
  if (comido < bocado && ley(world, 'obra')) comido += takeFood(world, person, bocado - comido);
  if (comido < bocado) { const r = comerDeCarga(c, person, cuerpo, bocado - comido, celda); comido += r.kg; fauna += r.fauna; }
  contar(world, TOTAL_DIETA_KG, comido); contar(world, TOTAL_DIETA_FAUNA_KG, fauna);
  if (comido > 0 && world.tick - person.lastOutcome >= 30) outcome(world, person, 'eat', comido / bocado);
  if (person.hunger < 0.12 || (!(comido > 0) && distance(person, person.target) < 0.5)) person.decisionAt = world.tick + 1;
  return comido;
}

/** Beber con cuerpo: de la charca de la celda propia (y, con obra, de una cisterna) y de lo que lleva con agua. */
export function beberConCuerpo(world: World, person: Person, cuerpo: Cuerpo, current: Tile): number {
  const c = ctxMateriaDe(world), celda = c.terreno.celda(current.x, current.y);
  const sorbo = SORBO_KG * escalaBocado(c, cuerpo);
  let bebido = 0;
  if (ley(world, 'obra')) bebido = takeWater(world, person, sorbo);
  else if (celdaEsPropia(c, celda)) bebido = beberEnCelda(c, cuerpo, celda, sorbo);
  const carga = person.carga;
  for (let i = 0; carga && i < carga.length && bebido < sorbo; i++) {
    const lote = carga[i]!;
    if (c.materia.propio(lote) && c.materia.vista(lote).agua > 0) bebido += beber(c, cuerpo, lote, sorbo - bebido);
  }
  if (bebido > 0 && ley(world, 'materia') && paramsOf(world).agua.memoria < 1) person.waterMemory = { x: person.x, y: person.y };
  contar(world, TOTAL_BEBIDA_KG, bebido);
  if (bebido > 0 && world.tick - person.lastOutcome >= 30) outcome(world, person, 'drink', bebido / sorbo);
  if (person.thirst < 0.12 || !(bebido > 0)) {
    if (person.command?.order === 'drink') { person.command = null; person.controlMode = 'auto'; }
    person.decisionAt = world.tick + 1;
  }
  return bebido;
}

/** Forrajear con cuerpo: lo digerible de la vegetación de la celda propia pasa a un lote a cuestas (`Person.carga`). */
export function forrajearACuestas(world: World, person: Person, cuerpo: Cuerpo, tile: Tile): boolean {
  const c = ctxMateriaDe(world), celda = c.terreno.celda(tile.x, tile.y);
  if (!celdaEsPropia(c, celda)) return false;
  const vida = lotesDeCelda(c, celda, lotesCelda).vida;
  if (vida < 0) return false;
  const lote = c.materia.nuevo(Rol.Objeto, -1, 0);
  const kg = trasladarAlimento(c, cuerpo, vida, lote, FORRAJEO_KG * escalaBocado(c, cuerpo));
  if (!(kg > 0)) { if (c.materia.calor(lote) === 0) c.materia.liberar(lote); else soltar(c, lote, celda); return false; }
  (person.carga ??= []).push(lote);
  if (ley(world, 'obra') && person.hunger < 0.5) guardarEnObra(c, person, 'comida', lote, kg);
  contar(world, TOTAL_FORRAJEO_KG, kg);
  return true;
}

/** Con obra, recoger madera (del tronco de la vegetación) o piedra (de la roca latente) deja un lote a cuestas. */
export function recogerACuestas(world: World, person: Person, cuerpo: Cuerpo, tile: Tile): boolean {
  const c = ctxMateriaDe(world), celda = c.terreno.celda(tile.x, tile.y);
  if (!celdaEsPropia(c, celda)) return false;
  vistaMateriales(c, person);
  const S = sustanciasDe(c), carga = (person.carga ??= []);
  const preferido = person.materials.wood < 6 ? 'wood' : 'stone';
  for (const material of [preferido, preferido === 'wood' ? 'stone' : 'wood'] as const) {
    const receipt = useTool(world, person, material === 'wood' ? 'cutting' : 'abrasion');
    const kg = KG_POR_UNIDAD_MATERIAL * (1 + (receipt?.power ?? 0)) * escalaBocado(c, cuerpo);
    let lote: LoteRef = REF_NULA;
    if (material === 'stone') lote = rocaDe(c, celda, kg);
    else {
      const vida = lotesDeCelda(c, celda, lotesCelda).vida;
      if (vida >= 0) {
        lote = c.materia.nuevo(Rol.Objeto, -1, 0);
        const cuantos = Math.floor(kg / (c.quimica.sustancia(S.madera).masa * MG_A_KG));
        if (!(c.materia.mover({ de: vida, a: lote, esp: S.madera, cuantos }) > 0)) { c.materia.liberar(lote); lote = REF_NULA; }
      }
    }
    if (lote === REF_NULA) continue;
    const masa = c.materia.vista(lote).masa;
    carga.push(lote);
    contar(world, TOTAL_RECOGIDA_KG, masa);
    count(world, material === 'wood' ? 'woodGathered' : 'stoneGathered', masa / KG_POR_UNIDAD_MATERIAL);
    recordTechnologyBenefit(world, person, receipt, masa / KG_POR_UNIDAD_MATERIAL - 1);
    vistaMateriales(c, person);
    marcarTesela(tile);
    return true;
  }
  return false;
}

/** `Person.materials` como vista de la carga: madera y piedra en unidades de `KG_POR_UNIDAD_MATERIAL`. La decisión de
 * siempre la sigue leyendo; con obra no se escribe por otro lado. */
export function vistaMateriales(c: CtxLeyMateria, person: Person): void {
  const carga = person.carga;
  if (!carga) return;
  const S = sustanciasDe(c);
  let madera = 0, piedra = 0;
  for (const lote of carga) {
    if (!c.materia.propio(lote)) continue;
    const v = c.materia.vista(lote);
    if (v.principal === S.madera) madera += v.masa;
    else if (v.principal === S.SiO2 || v.principal === S.CaCO3 || v.principal === S.Fe2O3) piedra += v.masa;
  }
  person.materials.wood = madera / KG_POR_UNIDAD_MATERIAL;
  person.materials.stone = piedra / KG_POR_UNIDAD_MATERIAL;
}

/** Saca de la carga `unidades` de madera hacia el Suelo de una celda propia (estacas de un cultivo): no se destruye. */
export function gastarMaderaEnSuelo(c: CtxLeyMateria, person: Person, celda: number, unidades: number): number {
  const carga = person.carga, S = sustanciasDe(c);
  if (!carga || !celdaEsPropia(c, celda)) return 0;
  const suelo = lotesDeCelda(c, celda, lotesCelda).suelo;
  if (suelo < 0) return 0;
  const mg = c.quimica.sustancia(S.madera).masa;
  let resta = Math.ceil(unidades * KG_POR_UNIDAD_MATERIAL / (mg * MG_A_KG)), movido = 0;
  for (let i = carga.length - 1; i >= 0 && resta > 0; i--) {
    const lote = carga[i]!;
    if (!c.materia.propio(lote) || c.materia.vista(lote).principal !== S.madera) continue;
    const m = c.materia.mover({ de: lote, a: suelo, esp: S.madera, cuantos: resta });
    resta -= m; movido += m;
    if (c.materia.vista(lote).masa <= 0 && c.materia.calor(lote) === 0) { c.materia.liberar(lote); carga.splice(i, 1); }
  }
  vistaMateriales(c, person);
  return movido * mg * MG_A_KG / KG_POR_UNIDAD_MATERIAL;
}
