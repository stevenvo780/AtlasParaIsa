import { serialize } from 'node:v8';
import type { BlueprintView, StructureComponent, StructureView } from '../shared/life.js';
import type { StructureMaterialProfile, StructureSynergyView } from '../shared/chemistry.js';
import { codigoForma, formaDeCodigo } from '../shared/materia.js';
import { KG_POR_UNIDAD_MATERIAL, TRABAJO_J_TICK } from '../shared/naturaleza.js';
import { blendMaterialProfile, compoundCarryUnits, enrichSoilFromLots, KILN_FUEL_POWER, unfiredCompoundShare } from './chemistry.js';
import type { ChronicleEvent, Tile } from '../shared/types.js';
import type { Person, World } from './index.js';
import { localRandom } from './genetics.js';
import { tileAt } from './spatial.js';
import { tileLookup } from './tile-index.js';
import { residentFastAccess, type ResidentFastAccess } from './soa/terreno.js';
import { CHUNK_SIZE, chunkKey } from './terrain.js';
import { INTERVALO_ECOLOGIA_TICKS, SED_POR_UNIDAD } from './ecologia-constantes.js';
import { algunoCerca, filtrarCerca } from './indice-puntos.js';
import { esMiembro, techoDelArchivo } from './indices.js';
import { ley, openWorldCaps, OPEN_WORLD_MAX_BLUEPRINTS, paramsOf } from './params.js';
import { vecinos } from './rejilla.js';
import { constructionWorkFactor, consumeConstructionTools, installTechnologyItem, recordTechnologyBenefit, toolEffectsEnabled, useTool } from './technology.js';
import { marcarTesela } from './soa/barrera-percepcion.js';
import { ctxMateriaDe, refDeOrganismo, type CtxLeyMateria } from './motor/acceso.js';
import { slotDe } from './motor/contratos.js';
import { basalJ, beber, cargaKg, energiaAlimento, ingerirSelecto, pagar, reservaJ } from './materia/cuerpo.js';
import { aportarEscalar, extraerEscalar, lotesDeCelda, rocaDe } from './materia/ley-mundo.js';
import {
  AREA_OBRA_M2, COBERTURA_COBIJO, DENSIDAD_AGUA_KG_M3, DENSIDAD_GRANO_KG_M3, FLUJO_CAPTACION_KG_M2_TICK, KG_POR_CUANTO_AGUA, MASA_PORTANTE_KG_M2,
  areaPortante, calidadEmpedrado, celdaObra, colocarPieza, depositarEnObra, esPiedraDeObra, estadoObra, loteDepositoObra, lotesEnObra,
  prestacionesDePiezas, prestacionesObra, registrarEmpedrado, stockObra, trasladarLoteObra, type DepositoObra, type EstadoObra,
} from './materia/piezas.js';
import { avanzarProceso, iniciarProceso } from './materia/proceso.js';
import { Rol, type LoteRef, type Paso } from './materia/tipos.js';

type Emit = (event: Omit<ChronicleEvent, 'id' | 'tick'>) => ChronicleEvent;
type Point = { x: number; y: number };
export const MAX_BLUEPRINTS = 64;
export const MAX_STRUCTURES = 512;
export const structureCap = (world: World): number => ley(world, 'obra') ? Infinity
  : openWorldCaps(world) ? paramsOf(world).limites.teselasActivas : MAX_STRUCTURES;
export const blueprintCap = (world: World): number => ley(world, 'obra') ? Infinity
  : paramsOf(world).construccion.modular ? Number.MAX_SAFE_INTEGER : openWorldCaps(world) ? OPEN_WORLD_MAX_BLUEPRINTS : MAX_BLUEPRINTS;
export const COLOCACION_J_POR_KG = 20;
export const SALTO_TERMICO_COBIJO_K = 20;
const FORMA_OBRA_INICIAL = codigoForma({ largo: 1, ancho: 1, grueso: 0.12, hueco: 0.25, filo: 0 });
export interface PlanoObra { area: number; compacto: boolean; forma: number }
export const RESEARCH_WORK = 60;
export const REPAIR_WORK = 30;
export const RESEARCH_COOLDOWN = 1200;
export const BROKEN_CONDITION = 0.1;
const REPAIR_CONDITION_LIMIT = 0.95;
export const REST_FATIGUE_RATE = 0.0018;
export const REST_ENERGY_RATE = 0.0011;
export const COMPONENTS: readonly StructureComponent[] = ['frame', 'roof', 'cistern', 'granary', 'garden', 'hearth'];
const COSTS: Record<StructureComponent, BlueprintView['cost']> = {
  frame: { wood: 2, stone: 1, work: 20 }, roof: { wood: 4, stone: 2, work: 70 },
  cistern: { wood: 2, stone: 3, work: 40 }, granary: { wood: 3, stone: 1, work: 35 },
  garden: { wood: 2, stone: 1, work: 30 }, hearth: { wood: 1, stone: 2, work: 30 },
};
const clamp = (value: number, maximum = 1) => Math.max(0, Math.min(maximum, value));
/** V18 ola 2: `Math.hypot` es el coste dominante de este módulo (≈ 60 % del tiempo propio con miles de habitantes: cada
 * llamada reserva un arreglo interno). Para dos argumentos V8 calcula `max·√Σ(|vᵢ|/max)²` con suma de Kahan; con dos
 * términos positivos la compensación de la primera vuelta es exactamente 0, así que se reduce a `√(a² + b²)·max` con las
 * mismas operaciones IEEE: el resultado es idéntico bit a bit (incluidos ±0, NaN e ∞). Al cargar el módulo se comprueba
 * contra `Math.hypot` en una muestra; si un motor distinto difiriera, se usa `Math.hypot`. */
export function hypotExact(x: number, y: number): number {
  const ax = Math.abs(x), ay = Math.abs(y);
  if (ax === Infinity || ay === Infinity) return Infinity;
  if (x !== x || y !== y) return NaN;
  const max = ax > ay ? ax : ay;
  if (max === 0) return 0;
  const a = ax / max, b = ay / max;
  return Math.sqrt(a * a + b * b) * max;
}
const HYPOT_EXACT = (() => {
  let state = 0x9e3779b9;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const samples: [number, number][] = [[0, 0], [-0, 0], [0, -0], [3, 4], [NaN, 1], [1, NaN], [Infinity, NaN], [-Infinity, 2], [5e-324, 0], [1e308, 1e308]];
  for (let i = 0; i < 512; i++) samples.push([(next() - 0.5) * 40, (next() - 0.5) * 40], [Math.floor(next() * 30) - 15, Math.floor(next() * 30) - 15]);
  return samples.every(([x, y]) => Object.is(hypotExact(x, y), Math.hypot(x, y)));
})();
const distance = (a: Point, b: Point) => HYPOT_EXACT ? hypotExact(a.x - b.x, a.y - b.y) : Math.hypot(a.x - b.x, a.y - b.y);
function counts(components: readonly StructureComponent[]): Record<StructureComponent, number> {
  const result = { frame: 0, roof: 0, cistern: 0, granary: 0, garden: 0, hearth: 0 };
  for (const component of components) {
    switch (component) {
      case 'frame': result.frame++; break;
      case 'roof': result.roof++; break;
      case 'cistern': result.cistern++; break;
      case 'granary': result.granary++; break;
      case 'garden': result.garden++; break;
      case 'hearth': result.hearth++; break;
    }
  }
  return result;
}
const canonical = (components: readonly StructureComponent[]) => COMPONENTS.flatMap(component => components.filter(c => c === component));
export const blueprintSignature = (components: readonly StructureComponent[]): string => {
  const n = counts(components);
  return `${n.frame}:${n.roof}:${n.cistern}:${n.granary}:${n.garden}:${n.hearth}`;
};

export function blueprintCost(components: readonly StructureComponent[], modular = false): BlueprintView['cost'] {
  let wood = 0, stone = 0, work = 0;
  for (let i = 0; i < components.length; i++) {
    const c = COSTS[components[i]!];
    wood += c.wood; stone += c.stone; work += c.work;
  }
  const frames = modular ? counts(components).frame : 0;
  if (frames >= 3) {
    const load = 1 + 0.15 * (frames - 1);
    return { wood: Math.ceil(wood * load), stone: Math.ceil(stone * load), work: Math.ceil(work * load) };
  }
  return { wood, stone, work };
}

function footprintCells(point: Point, footprint?: StructureView['footprint']): Point[] {
  const cells: Point[] = [];
  for (let dy = 0; dy < (footprint?.height ?? 1); dy++) for (let dx = 0; dx < (footprint?.width ?? 1); dx++) cells.push({ x: point.x + dx, y: point.y + dy });
  return cells;
}

/** Includes reserved expansion ground, so even simultaneous works cannot collide. */
export function structureFootprintCells(structure: StructureView): Point[] {
  if (structure.site?.expansion?.cells?.length) return structure.site.expansion.cells;
  if (structure.cells?.length) return structure.cells;
  return footprintCells(structure, structure.site?.expansion?.footprint ?? structure.footprint);
}

/** Operational ground excludes the unpaid extension. Six cells bound every geometry operation. */
export const completedStructureCells = (s: StructureView): Point[] => s.cells?.length ? s.cells : footprintCells(s, s.footprint);
const ORTHOGONAL = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;
const cellKey = (p: Point) => `${p.x},${p.y}`;
export function polyominoGeometry(cells: readonly Point[]): { area: number; perimeter: number; compactness: number } {
  const occupied = new Set(cells.map(cellKey));
  let perimeter = 0;
  for (const c of cells) for (const [dx, dy] of ORTHOGONAL) if (!occupied.has(`${c.x + dx},${c.y + dy}`)) perimeter++;
  return { area: occupied.size, perimeter, compactness: occupied.size / Math.max(1, perimeter) };
}

/** Area surcharge is paid once; expansions subtract the entire old paid estate. */
export function polyominoCost(components: readonly StructureComponent[], area: number): BlueprintView['cost'] {
  const base = blueprintCost(components, true), extra = area * area - 1;
  return { wood: base.wood + extra * 2, stone: base.stone + extra, work: base.work + extra * 10 };
}
function cellFootprint(cells: readonly Point[]): StructureView['footprint'] {
  const width = Math.max(...cells.map(c => c.x)) - Math.min(...cells.map(c => c.x)) + 1;
  const height = Math.max(...cells.map(c => c.y)) - Math.min(...cells.map(c => c.y)) + 1;
  return width <= 2 && height <= 2 ? { width: width as 1 | 2, height: height as 1 | 2 } : undefined;
}

/** Bounded growth around the anchor: planner 7 + extent 2 + occupancy anchor 5 <= HALO 14.
 * Two-axis extent also admits L, T, U and 3x2 halls without a global occupancy scan. */
export function fittingPolyomino(world: World, anchor: Point, components: readonly StructureComponent[], existing?: StructureView): Point[] | false {
  const n = counts(components), target = n.frame <= 2 ? 1 : n.frame - 1;
  const cells = existing ? completedStructureCells(existing).map(c => ({ ...c })) : [{ x: anchor.x, y: anchor.y }];
  const wanted = n.frame >= 6 && n.roof + n.hearth >= n.cistern + n.garden ? 6 : target;
  if (!isFootprintFree(world, cells, existing?.id) || cells.length > wanted) return false;
  const compact = n.roof + n.hearth >= n.cistern + n.garden;
  return growPolyomino(cells, wanted, compact, p => Math.abs(p.x - anchor.x) <= 2 && Math.abs(p.y - anchor.y) <= 2
    && chunkKey(p.x, p.y) === chunkKey(anchor.x, anchor.y) && tileAt(world, p)?.terrain !== 'shelter'
    && isFootprintFree(world, [p], existing?.id), anchor);
}

function growPolyomino(cells: Point[], wanted: number, compact: boolean, libre: (p: Point) => boolean, anchor: Point): Point[] | false {
  while (cells.length < wanted) {
    const keys = new Set(cells.map(cellKey)), frontier = new Map<string, Point>();
    for (const c of cells) for (const [dx, dy] of ORTHOGONAL) {
      const p = { x: c.x + dx, y: c.y + dy };
      if (keys.has(cellKey(p)) || !libre(p)) continue;
      frontier.set(cellKey(p), p);
    }
    const edges = (p: Point) => ORTHOGONAL.filter(([dx, dy]) => keys.has(`${p.x + dx},${p.y + dy}`)).length;
    const candidate = [...frontier.values()].sort((a, b) => (compact ? edges(b) - edges(a) : edges(a) - edges(b))
      || distance(a, anchor) - distance(b, anchor) || b.x - a.x || b.y - a.y)[0];
    if (!candidate) return false;
    cells.push(candidate);
  }
  return cells;
}

const PLANO_INICIAL: Readonly<PlanoObra> = { area: 1, compacto: true, forma: FORMA_OBRA_INICIAL };
const planoObra = (b: BlueprintView): Readonly<PlanoObra> => (b as BlueprintView & { planoMaterial?: PlanoObra }).planoMaterial ?? PLANO_INICIAL;
const PREFIJO_PLANO_OBRA = 'blueprint-obra-';
export const firmaPlanoObra = (b: BlueprintView): string => {
  const { area, compacto, forma } = planoObra(b);
  return `${area}/${Number(compacto)}/${forma}`;
};

function formaDePlano(c: CtxLeyMateria, id: string): Readonly<PlanoObra> {
  const local = c.mundo.blueprints.find(b => b.id === id);
  if (local) return planoObra(local);
  if (!id.startsWith(PREFIJO_PLANO_OBRA)) return PLANO_INICIAL;
  const clave = Number(id.slice(PREFIJO_PLANO_OBRA.length));
  if (!Number.isSafeInteger(clave) || clave < 0) return PLANO_INICIAL;
  const bytes = c.globales.registro.leer(clave);
  if (!bytes) return PLANO_INICIAL;
  const [marca, area, compacto, forma] = JSON.parse(new TextDecoder().decode(bytes)) as [string, number, boolean, number];
  if (marca !== 'obra-v23') throw new Error(`El registro ${clave} no contiene un plano de obra.`);
  return { area, compacto, forma };
}

function planoSeleccionado(c: CtxLeyMateria, persona: Person) {
  const mundo = c.mundo;
  const base = selectedBlueprint(mundo, persona);
  const id = persona.blueprintId?.startsWith(PREFIJO_PLANO_OBRA) ? persona.blueprintId : base.id;
  const plano = formaDePlano(c, id);
  return { id, name: id === base.id ? base.name : `Obra de ${plano.area} celdas`, plano };
}

function fittingMaterial(world: World, anchor: Point, plano: Readonly<PlanoObra>, existing?: StructureView): Point[] | false {
  const key = chunkKey(anchor.x, anchor.y);
  const ocupadas = new Set(filtrarCerca(world.structures, anchor, CHUNK_SIZE, s => s !== existing
    && chunkKey(s.x, s.y) === key).flatMap(s => structureFootprintCells(s).map(cellKey)));
  const cells = (existing ? completedStructureCells(existing) : [anchor]).map(({ x, y }) => ({ x, y }));
  const libre = (p: Point) => {
    if (chunkKey(p.x, p.y) !== key || ocupadas.has(cellKey(p))) return false;
    const tile = tileAt(world, p);
    return !!tile && tile.terrain !== 'water' && tile.terrain !== 'shelter';
  };
  if (cells.length > plano.area || cells.some(p => !libre(p))) return false;
  return growPolyomino(cells, plano.area, plano.compacto, libre, anchor);
}

export function isFootprintFree(world: World, cells: readonly Point[], ignoreStructureId?: string): boolean {
  if (!cells.length) return false;
  const keys = new Set(cells.map(c => `${c.x},${c.y}`));
  if (keys.size !== cells.length || cells.some(c => !Number.isSafeInteger(c.x) || !Number.isSafeInteger(c.y)
    || !tileAt(world, c) || tileAt(world, c)!.terrain === 'water')) return false;
  for (const cell of cells) if (filtrarCerca(world.structures, cell, paramsOf(world).construccion.poliminosYSinergia ? 5 : 2,
    s => s.id !== ignoreStructureId && structureFootprintCells(s).some(c => keys.has(`${c.x},${c.y}`))).length) return false;
  return true;
}

function fittingFootprint(world: World, point: Point, components: readonly StructureComponent[], existing?: StructureView): StructureView['footprint'] | false {
  const frames = counts(components).frame;
  const candidates: NonNullable<StructureView['footprint']>[] = frames >= 5 ? [{ width: 2, height: 2 }]
    : frames >= 3 ? [{ width: 2, height: 1 }, { width: 1, height: 2 }] : [{ width: 1, height: 1 }];
  for (const footprint of candidates) {
    const cells = footprintCells(point, footprint), old = existing ? footprintCells(existing, existing.footprint) : [];
    // A structure is archived with its anchor chunk. Keep its whole physical estate
    // in that persistence unit, including when a neighbouring chunk is retired alone.
    if (cells.some(c => chunkKey(c.x, c.y) !== chunkKey(point.x, point.y))) continue;
    if (!old.every(o => cells.some(c => c.x === o.x && c.y === o.y)) || !isFootprintFree(world, cells, existing?.id)) continue;
    if (cells.some(c => tileAt(world, c)!.terrain === 'shelter' && !old.some(o => o.x === c.x && o.y === c.y))) continue;
    return frames <= 2 ? undefined : footprint;
  }
  return false;
}

export function structureDistance(point: Point, structure: StructureView): number {
  let minima = Infinity;
  for (const cell of completedStructureCells(structure)) minima = Math.min(minima, distance(point, cell));
  return minima;
}

const hasCompletedBuilding = (s: StructureView) => !s.site || !!s.site.expansion;
const structureSearchRadius = (world: World, legacy: number) => paramsOf(world).construccion.poliminosYSinergia ? Math.min(3, legacy) : legacy;
/** V23: chemistry-era laws (transport gear, soil enrichment, kilns, settlement halls) need `quimica.emergente`. */
const chemistryEra = (world: World): boolean => paramsOf(world).quimica.emergente === true;
/** V23: extra units per trip from the best carried pack (lightness × toughness); 0 without `quimica.emergente`. */
const carryUnits = (world: World, person: Person): number => chemistryEra(world) ? compoundCarryUnits(person.compounds) : 0;
const isFuelLot = (lot: { mass: number; properties: { fuelPower: number } }): boolean => lot.mass > 0 && lot.properties.fuelPower >= KILN_FUEL_POWER;

/** Fixed storage section persists when a liner wears out: contents never disappear
 * or exceed a shrinking capacity. Condition controls access, not conserved volume. */
export function materialCapacity(structure: StructureView): { wood: number; stone: number } {
  const n = counts(structure.components), area = completedStructureCells(structure).length;
  if (n.frame < 2 && n.granary === 0) return { wood: 0, stone: 0 };
  const extra = (structure.installed ?? []).reduce((sum, i) => sum + i.containment * i.mass / 1000, 0);
  return { wood: Math.floor((n.frame >= 2 ? area * 12 : 4) + extra * 4), stone: Math.floor((n.frame >= 2 ? area * 8 : 3) + extra * 3) };
}

function warehousesNear(world: World, person: Point): StructureView[] {
  // Called for a cooperation partner up to seven cells away. A six-cell hall
  // may extend five cells: bound its anchor so 7 + 7 stays inside the halo.
  return filtrarCerca(world.structures, person, paramsOf(world).construccion.poliminosYSinergia ? 5 : 4.5, s => Math.abs(s.x - person.x) <= 7 && Math.abs(s.y - person.y) <= 7
    && hasCompletedBuilding(s) && s.condition > BROKEN_CONDITION
    && tileAt(world, s)?.terrain === 'shelter' && structureDistance(person, s) <= 2.5)
    .sort((a, b) => structureDistance(person, a) - structureDistance(person, b) || a.id.localeCompare(b.id));
}

export function storedMaterialsNear(world: World, person: Point): { wood: number; stone: number } {
  const result = { wood: 0, stone: 0 };
  if (ley(world, 'obra')) return result;
  if (paramsOf(world).construccion.modular) for (const s of warehousesNear(world, person)) { result.wood += s.storedWood ?? 0; result.stone += s.storedStone ?? 0; }
  return result;
}

/** Sole matching debit for material delivered directly into a local paid process. */
export function withdrawMaterials(world: World, person: Point, requested: { wood: number; stone: number }): { wood: number; stone: number } {
  const taken = { wood: 0, stone: 0 };
  if (ley(world, 'obra')) return taken;
  for (const s of warehousesNear(world, person)) {
    const wood = Math.max(0, Math.min(s.storedWood ?? 0, Math.floor(requested.wood - taken.wood)));
    const stone = Math.max(0, Math.min(s.storedStone ?? 0, Math.floor(requested.stone - taken.stone)));
    if (wood) s.storedWood! -= wood;
    if (stone) s.storedStone! -= stone;
    taken.wood += wood; taken.stone += stone;
    if (wood + stone > 0) observeUse(world, s, (wood + stone) / 20);
  }
  return taken;
}

/** Deposit surplus only; moving stock is not evidence of utility. */
export function depositMaterials(world: World, person: Person, structure: StructureView): boolean {
  if (ley(world, 'obra')) return false;
  if (!paramsOf(world).construccion.modular || person.action === 'build' || !world.people.includes(person) || !world.structures.includes(structure)
    || !hasCompletedBuilding(structure) || structure.condition <= BROKEN_CONDITION || tileAt(world, structure)?.terrain !== 'shelter'
    || structureDistance(person, structure) > 1.5) return false;
  // A builder walking to its own site carries that trip's load; it is delivered there, not banked on the way.
  const capacity = materialCapacity(structure);
  const wood = person.materials.wood >= 8 ? Math.max(0, Math.min(Math.floor(person.materials.wood - 4), capacity.wood - (structure.storedWood ?? 0))) : 0;
  const stone = person.materials.stone >= 5 ? Math.max(0, Math.min(Math.floor(person.materials.stone - 3), capacity.stone - (structure.storedStone ?? 0))) : 0;
  if (wood) { person.materials.wood -= wood; structure.storedWood = (structure.storedWood ?? 0) + wood; }
  if (stone) { person.materials.stone -= stone; structure.storedStone = (structure.storedStone ?? 0) + stone; }
  let storedCompound = false;
  if (paramsOf(world).quimica.emergente && person.compounds && person.compounds.length >= 4 && (structure.storedCompounds?.length ?? 0) < 12
    && (capacity.wood > 0 || structure.components.includes('hearth') || structure.components.includes('granary'))) {
    // V23: a hearth banks the charcoal (dense fuel) the carrier holds; otherwise the last lot, as in V20.
    const fuelIndex = structure.components.includes('hearth') ? person.compounds.findIndex(isFuelLot) : -1;
    const lot = fuelIndex >= 0 && chemistryEra(world) ? person.compounds.splice(fuelIndex, 1)[0]! : person.compounds.pop()!;
    (structure.storedCompounds ??= []).push(lot);
    structure.materialProfile = blendMaterialProfile(structure.materialProfile, lot, 0.25);
    storedCompound = true;
  }
  return wood + stone > 0 || storedCompound;
}

/** A roof needs a frame; enclosed storage needs a roof; gardens need captured water.
 * Repetition is structural: extra frames support roofs and slow wear, extra modules add capacity. */
export function validBlueprint(components: unknown, modular = false): components is StructureComponent[] {
  if (!Array.isArray(components) || components.length < 2 || components.length > (modular ? 20 : 8)) return false;
  let frame = 0, roof = 0, cistern = 0, granary = 0, garden = 0, hearth = 0;
  let wood = 0, stone = 0;
  for (let i = 0; i < components.length; i++) {
    switch (components[i]) {
      case 'frame': frame++; wood += 2; stone += 1; break;
      case 'roof': roof++; wood += 4; stone += 2; break;
      case 'cistern': cistern++; wood += 2; stone += 3; break;
      case 'granary': granary++; wood += 3; stone += 1; break;
      case 'garden': garden++; wood += 2; stone += 1; break;
      case 'hearth': hearth++; wood += 1; stone += 2; break;
      default: return false;
    }
  }
  if (modular) return frame >= 1 && frame <= 6 && roof >= 1 && roof <= frame
    && cistern <= 6 && granary <= 6 && garden <= 6 && hearth <= 3
    && (garden === 0 || cistern > 0)
    // Roof spans and filled reservoirs exert twice the load of a light module.
    // Each wood/stone frame provides six units of supporting section.
    && roof * 2 + cistern * 2 + granary + garden + hearth * 2 <= frame * 6;
  return frame >= 1 && frame <= 2 && roof >= 1 && roof <= frame
    && cistern <= 2 && granary <= 2 && garden <= 2 && hearth <= 1
    && (garden === 0 || cistern > 0) && components.length - frame - roof <= frame * 4
    && wood <= 12 && stone <= 8;
}

export function blueprintAffordances(components: readonly StructureComponent[]) {
  let frame = 0, roof = 0, cistern = 0, granary = 0, garden = 0, hearth = 0;
  for (let i = 0; i < components.length; i++) {
    switch (components[i]) {
      case 'frame': frame++; break;
      case 'roof': roof++; break;
      case 'cistern': cistern++; break;
      case 'granary': granary++; break;
      case 'garden': garden++; break;
      case 'hearth': hearth++; break;
    }
  }
  return { waterCapacity: cistern * 0.6, foodCapacity: granary * 0.7,
    catchment: cistern ? roof * 0.012 : 0, irrigation: garden * 0.008,
    restQuality: clamp(0.82 + (roof - 1) * 0.09 + (frame - 1) * 0.03),
    hearths: hearth, durability: 1 + (frame - 1) * 0.5 };
}

function restQualityOf(components: readonly StructureComponent[]): number {
  let frame = 0, roof = 0;
  for (let i = 0; i < components.length; i++) {
    const c = components[i];
    if (c === 'frame') frame++;
    else if (c === 'roof') roof++;
  }
  return clamp(0.82 + (roof - 1) * 0.09 + (frame - 1) * 0.03);
}

const SOA_SAFE_COORD = 1_073_741_800; // 2^30 - 24: x ± 7 siempre en el dominio admisible SoA

function isShelterAt(
  tileIn: (x: number, y: number) => Tile | undefined,
  fast: ResidentFastAccess | undefined,
  x: number,
  y: number,
): boolean {
  if (fast) {
    const exact = fast.exact;
    if (exact) {
      const cell = exact.cellAt(x, y);
      return cell >= 0 && fast.terrainArr[cell] === fast.TERRAIN_SHELTER;
    }
    const tile = tileIn(x, y);
    if (!tile) return false;
    const cell = fast.cellOf(tile);
    return cell >= 0 ? fast.terrainArr[cell] === fast.TERRAIN_SHELTER : tile.terrain === 'shelter';
  }
  return tileIn(x, y)?.terrain === 'shelter';
}

function blueprintName(components: readonly StructureComponent[]): string {
  const n = counts(components), pieces: string[] = [n.roof > 1 ? 'Casa de dos cubiertas' : n.frame > 1 ? 'Refugio reforzado' : 'Refugio'];
  for (const [key, label] of [['cistern', 'cisterna'], ['granary', 'granero'], ['garden', 'huerta'], ['hearth', 'hogar']] as const) {
    if (n[key]) pieces.push(`${label}${n[key] > 1 ? ' doble' : ''}`);
  }
  return pieces.join(' · ');
}

export function defaultBlueprint(): BlueprintView {
  const components: StructureComponent[] = ['frame', 'roof'];
  return { id: 'blueprint-base', name: blueprintName(components), components, generation: 0, parents: [], inventorId: null, tick: 0, uses: 0, usefulness: 0, cost: blueprintCost(components) };
}

/** A caller may hold an outdated counter; active and pending archive identities remain reserved. */
function nextIdentity(counter: number, prefix: 'blueprint' | 'structure', ids: readonly string[], world: World): { id: string; counter: number } | undefined {
  if (!Number.isSafeInteger(counter) || counter < 0) return;
  let largest = counter;
  for (const id of ids) {
    if (!id.startsWith(`${prefix}-`)) continue;
    const suffix = id.slice(prefix.length + 1); if (!/^\d+$/.test(suffix)) continue;
    const reserved = Number(suffix); if (!Number.isSafeInteger(reserved)) return;
    largest = Math.max(largest, reserved);
  }
  const archive = techoDelArchivo(world.retiredChunks, world.tick);
  if (prefix === 'blueprint') {
    if (archive.blueprintCorrupto) return;
    largest = Math.max(largest, archive.blueprint);
  } else {
    if (archive.structureCorrupto) return;
    largest = Math.max(largest, archive.structure);
  }
  if (largest >= Number.MAX_SAFE_INTEGER) return;
  return { id: `${prefix}-${largest + 1}`, counter: largest + 1 };
}

/**
 * T146: base confirmada efectiva para el prefix-sum de `blueprint`/`structure`:
 * el mayor serial ya reservado entre el contador del mundo, los ids activos y
 * el techo del archivo dormido (`techoDelArchivo`, T140). Es exactamente la
 * reserva que `nextIdentity` hace hoy antes de asignar `largest + 1`, pero sin
 * asignar: el coordinador suma su prefix-sum sobre esta base. `undefined` si
 * algún sufijo es corrupto o desborda, como en `nextIdentity`. Sin cambios en
 * el camino por defecto, que sigue llamando a `nextIdentity`.
 */
export function identityBaseFromArchive(world: World, prefix: 'blueprint' | 'structure'): number | undefined {
  const planos = world.blueprints, obras = world.structures, ids: string[] = [];
  if (prefix === 'blueprint') {
    for (const plano of planos) ids.push(plano.id, ...plano.parents);
    for (const obra of obras) ids.push(obra.blueprintId);
  } else for (const obra of obras) ids.push(obra.id);
  const counter = prefix === 'blueprint' ? world.blueprintCounter : world.structureCounter;
  const siguiente = nextIdentity(counter, prefix, ids, world);
  return siguiente ? siguiente.counter - 1 : undefined;
}

function blueprintIdentity(world: World) {
  return nextIdentity(world.blueprintCounter, 'blueprint', [...world.blueprints.map(b => b.id), ...world.blueprints.flatMap(b => b.parents),
    ...world.structures.map(s => s.blueprintId)], world);
}

function selectedBlueprint(world: World, person: Person): BlueprintView {
  return world.blueprints.find(b => b.id === person.blueprintId && validBlueprint(b.components, paramsOf(world).construccion.modular)) ?? world.blueprints.find(b => b.id === 'blueprint-base') ?? defaultBlueprint();
}

function expansionDelta(structure: StructureView, components: readonly StructureComponent[]): BlueprintView['cost'] | undefined {
  const old = counts(structure.components), target = counts(components);
  // Existing matter and service modules are retained, never converted into free replacements.
  if (old.frame >= target.frame || COMPONENTS.some(c => target[c] < old[c])) return;
  const before = blueprintCost(structure.components, true), after = blueprintCost(components, true);
  return { wood: after.wood - before.wood, stone: after.stone - before.stone, work: after.work - before.work };
}

function expansionCandidate(world: World, person: Person, blueprint = selectedBlueprint(world, person)) {
  if (!paramsOf(world).construccion.modular || !validBlueprint(blueprint.components, true)) return;
  const radius = structureSearchRadius(world, CONSTRUCTION_RADIUS);
  for (const structure of filtrarCerca(world.structures, person, radius + 1, s => !s.site && s.condition > 0.5 && distance(person, s) <= radius
    && tileAt(world, s)?.terrain === 'shelter')
    .sort((a, b) => distance(person, a) - distance(person, b) || a.id.localeCompare(b.id))) {
    const cost = expansionDelta(structure, blueprint.components);
    if (!cost) continue;
    if (paramsOf(world).construccion.poliminosYSinergia) {
      const cells = fittingPolyomino(world, structure, blueprint.components, structure);
      if (!cells) continue;
      const before = structure.cells?.length ? polyominoCost(structure.components, structure.cells.length) : blueprintCost(structure.components, true);
      const after = polyominoCost(blueprint.components, cells.length);
      return { structure, cells, footprint: cells.length > 1 ? cellFootprint(cells) : undefined,
        cost: { wood: after.wood - before.wood, stone: after.stone - before.stone, work: after.work - before.work } };
    }
    const footprint = fittingFootprint(world, structure, blueprint.components, structure);
    if (footprint !== false) return { structure, cost, footprint, cells: undefined };
  }
}

export function constructionCost(world: World, person: Person): BlueprintView['cost'] {
  if (ley(world, 'obra')) {
    // Con obra, lo que falta es la materia de una pieza: nada si ya lleva un lote duro; si no, la roca que pide la forma
    // del plano, en las unidades de `materials`. Sin esto la decisión veía coste cero y nadie recogía nunca piedra.
    const c = ctxMateriaDe(world);
    if (cargaDePieza(c, person) !== undefined) return { wood: 0, stone: 0, work: 1 };
    const forma = formaDeCodigo(planoSeleccionado(c, person).plano.forma);
    return { wood: 0, stone: Math.ceil(MASA_PORTANTE_KG_M2 * forma.largo * forma.ancho / KG_POR_UNIDAD_MATERIAL), work: 1 };
  }
  const modular = paramsOf(world).construccion.modular;
  const components = selectedBlueprint(world, person).components;
  const cells = modular && paramsOf(world).construccion.poliminosYSinergia ? fittingPolyomino(world, person, components) : false;
  const cost = cells ? polyominoCost(components, cells.length) : blueprintCost(components, modular);
  if (!paramsOf(world).construccion.modular) return cost;
  const structure = constructionSite(world, person), site = structure?.site;
  const expansion = site ? undefined : expansionCandidate(world, person), delta = expansion?.cost;
  // Storage must be reachable from the actual work site, not from a remote planner.
  const stored = storedMaterialsNear(world, structure ?? expansion?.structure ?? person);
  // The existing selector requests one transport/work trip, not the whole building.
  return { wood: Math.max(0, Math.min(12, (site ? site.requiredWood - site.depositedWood : (delta ?? cost).wood) - stored.wood)),
    stone: Math.max(0, Math.min(8, (site ? site.requiredStone - site.depositedStone : (delta ?? cost).stone) - stored.stone)),
    work: Math.max(1, Math.min(30, site ? site.requiredWork - site.completedWork : (delta ?? cost).work)) };
}

export function activeSiteAt(world: World, point: Point): StructureView | undefined {
  if (ley(world, 'obra')) return obraCercana(world, point, 0.5).find(s => !!celdaPendiente(ctxMateriaDe(world), s));
  if (!paramsOf(world).construccion.modular) return;
  return filtrarCerca(world.structures, point, 1.5, s => !!s.site && distance(point, s) <= 0.5)
    .sort((a, b) => distance(point, a) - distance(point, b) || a.id.localeCompare(b.id))[0];
}

/** Local construction cost for a nearby building partner (<= 7 cells away in evaluateCooperation):
 * stays strictly inside HALO_CELDAS (7 + 3.5 = 10.5 <= 14) by checking only a site the partner
 * stands on and warehouses directly beside them. */
export function partnerConstructionCost(world: World, person: Person): BlueprintView['cost'] {
  if (ley(world, 'obra')) return constructionCost(world, person);
  const modular = paramsOf(world).construccion.modular;
  const cost = blueprintCost(selectedBlueprint(world, person).components, modular);
  if (!modular) return cost;
  const structure = activeSiteAt(world, person), site = structure?.site;
  const stored = storedMaterialsNear(world, person);
  return { wood: Math.max(0, Math.min(12, (site ? site.requiredWood - site.depositedWood : cost.wood) - stored.wood)),
    stone: Math.max(0, Math.min(8, (site ? site.requiredStone - site.depositedStone : cost.stone) - stored.stone)),
    work: Math.max(1, Math.min(30, site ? site.requiredWork - site.completedWork : cost.work)) };
}

export function constructionSite(world: World, person: Point): StructureView | undefined {
  if (ley(world, 'obra')) {
    const c = ctxMateriaDe(world);
    return obraCercana(world, person, CONSTRUCTION_RADIUS).find(s => !!celdaPendiente(c, s));
  }
  if (!paramsOf(world).construccion.modular) return;
  // V20 keeps the V19 reach for active sites: anchor 7 + warehouse anchor 7 from the site <= HALO 14.
  // Shrinking it to 3 left half-paid sites invisible a few steps away, so neighbours started new ones.
  const radius = 7;
  return filtrarCerca(world.structures, person, radius + 1, s => !!s.site && distance(person, s) <= radius)
    .sort((a, b) => distance(person, a) - distance(person, b) || a.id.localeCompare(b.id))[0];
}

const CONSTRUCTION_RADIUS = 7;
const MIN_SERVICE_GAIN = 0.025;
type Services = { rest: number; water: number; food: number; irrigation: number };

/** These are perceived opportunities, not occupancy or production receipts. Roofs are
 * reusable; storage/catchment and irrigation add across locally visible structures.
 * Normalized catchment discounts worn collectors without inventing water in them. */
function localServices(world: World, person: Person, replacement?: { structure: StructureView; condition: number }, added?: readonly StructureComponent[], fuelWood = person.materials.wood): Services {
  const result: Services = { rest: world.weather === 'rain' ? 0.2 : 0.55, water: 0, food: 0, irrigation: 0 };
  const add = (components: readonly StructureComponent[], condition: number, water = 0, food = 0, installed?: ReturnType<typeof blueprintAffordances>) => {
    if (condition <= BROKEN_CONDITION) return;
    const a = installed ?? blueprintAffordances(components);
    if (world.shelterBenefitEnabled) {
      const heated = (world.weather === 'rain' || world.tick % 2400 >= 1800) && fuelWood >= a.hearths * 0.0005;
      result.rest = Math.max(result.rest, clamp((a.restQuality + (heated ? a.hearths * 0.12 : 0)) * condition));
    }
    result.water += Math.max(water, a.waterCapacity * clamp(a.catchment / 0.012 * condition));
    result.food += Math.max(0, a.foodCapacity - food);
    result.irrigation += a.irrigation * condition;
  };
  // Negación literal del `continue` de siempre (no la forma positiva): preserva cómo se trata una
  // distancia o condición NaN, igual que hizo T141 en `share`/`evaluateCooperation`.
  const radius = structureSearchRadius(world, CONSTRUCTION_RADIUS);
  for (const structure of filtrarCerca(world.structures, person, radius + 1,
    structure => (paramsOf(world).construccion.modular ? hasCompletedBuilding(structure) : !structure.site) && !(distance(person, structure) > radius || tileAt(world, structure)?.terrain !== 'shelter'))) {
    add(structure.components, replacement?.structure === structure ? replacement.condition : structure.condition, structure.water, structure.food,
      paramsOf(world).tecnologia.obrasPorPropiedades ? structureAffordances(world, structure) : undefined);
  }
  if (added) add(added, 1);
  return result;
}

function constructionContext(world: World, person: Person) {
  const nearby = vecinos(world, person, CONSTRUCTION_RADIUS + 1, other => distance(person, other) <= CONSTRUCTION_RADIUS);
  return { ...inventionContext(world, person),
    // Drinking lowers thirst by three times the debited water. One full body's
    // dose is a planning reserve; additional demand comes only from people seen.
    waterDemand: Math.max(1 / SED_POR_UNIDAD, nearby.reduce((sum, other) => sum + other.thirst / SED_POR_UNIDAD, 0)),
    foodSurplus: nearby.reduce((sum, other) => sum + Math.max(0, other.inventory - 0.12), 0) };
}

function serviceValue(services: Services, context: ReturnType<typeof constructionContext>): number {
  return services.rest * context.rest
    + clamp(services.water / context.waterDemand) * context.rainPotential * context.water
    + Math.min(services.food, context.foodSurplus) * context.food
    + clamp(services.irrigation / 0.012) * context.rainPotential * (1 - context.moisture) * context.food * 0.65;
}

function localMaterials(world: World, person: Person, stored?: { wood: number; stone: number }): Person['materials'] {
  const materials = { ...person.materials };
  const fast = residentFastAccess(world.tiles), exact = fast?.exact;
  for (let dy = -CONSTRUCTION_RADIUS; dy <= CONSTRUCTION_RADIUS; dy++) for (let dx = -CONSTRUCTION_RADIUS; dx <= CONSTRUCTION_RADIUS; dx++) {
    if (dx * dx + dy * dy > CONSTRUCTION_RADIUS * CONSTRUCTION_RADIUS) continue;
    const x = person.x + dx, y = person.y + dy;
    const cell = exact?.cellAt(x, y) ?? -1;
    const tile = cell >= 0 ? tileAt(world, { x, y }) : exact ? undefined : tileAt(world, { x, y });
    // The gathering action requires at least one unit on a tile. Fractional
    // leftovers spread across many tiles are not a reachable material reserve.
    if (tile && (cell < 0 ? tile.terrain !== 'water' : fast!.terrainCode(cell) !== fast!.TERRAIN_WATER)) {
      materials.wood += Math.floor(cell < 0 ? tile.wood ?? 0 : exact!.wood(cell) ?? 0);
      materials.stone += Math.floor(tile.stone ?? 0);
    }
  }
  if (paramsOf(world).construccion.modular) {
    const radius = structureSearchRadius(world, CONSTRUCTION_RADIUS);
    for (const s of filtrarCerca(world.structures, person, radius + 1, s => hasCompletedBuilding(s) && s.condition > BROKEN_CONDITION
      && distance(person, s) <= radius && tileAt(world, s)?.terrain === 'shelter')) {
      materials.wood += s.storedWood ?? 0; materials.stone += s.storedStone ?? 0;
      if (stored) { stored.wood += s.storedWood ?? 0; stored.stone += s.storedStone ?? 0; }
    }
  }
  return materials;
}

function usefulRepairs(world: World, person: Person, context?: ReturnType<typeof constructionContext>) {
  // Negación literal del `return []` de siempre: una condición/distancia NaN no debe excluir aquí lo
  // que el bucle de abajo (también insensible a NaN por `while (condition < LIMIT)`) habría procesado.
  const radius = structureSearchRadius(world, CONSTRUCTION_RADIUS);
  const structures = filtrarCerca(world.structures, person, radius + 1, structure => !structure.site && !(structure.condition >= REPAIR_CONDITION_LIMIT
    || distance(person, structure) > radius || tileAt(world, structure)?.terrain !== 'shelter'));
  if (!structures.length) return [];
  const perceived = context ?? constructionContext(world, person), before = serviceValue(localServices(world, person), perceived);
  return structures.flatMap(structure => {
    // Evaluate each physically legal paid prefix. A broken roof can need several
    // steps before it helps; a last top-up with no extra service earns no benefit.
    let condition = structure.condition, steps = 0;
    const load = paramsOf(world).construccion.modular ? maintenanceLoad(structure) : 1;
    const options: { structure: StructureView; gain: number; steps: number; efficiency: number }[] = [];
    while (condition < REPAIR_CONDITION_LIMIT) {
      condition = clamp(condition + 0.4); steps++;
      const gain = serviceValue(localServices(world, person, { structure, condition }, undefined, Math.max(0, person.materials.wood - steps * load)), perceived) - before;
      if (gain >= MIN_SERVICE_GAIN) options.push({ structure, gain, steps: steps * load, efficiency: gain / (steps * load * (1 + REPAIR_WORK / 30)) });
    }
    return options;
  }).sort((a, b) => b.efficiency - a.efficiency || distance(person, a.structure) - distance(person, b.structure) || a.structure.id.localeCompare(b.structure.id));
}

export interface ConstructionOpportunity { score: number; reason: string; target?: Point; delivery?: 'site' | 'expansion'; workLeft?: boolean }

/** Loads one person carries (the gather and delivery caps). */
const CARRY = { wood: 12, stone: 8 } as const;
/** Smallest worthwhile delivery trip while more material can still be gathered nearby. */
const TRIP_LOAD = 4;

/** V20 modular: whether a trip to the chosen work is worth starting now. Sites and extensions accept
 * partial deliveries (contributeConstruction debits only what is carried or stored beside them), so
 * a builder need not carry the whole remaining bill. `cost` is the trip bill of constructionCost. */
export function modularBuildReady(person: Person, construction: ConstructionOpportunity, cost: BlueprintView['cost'], canGather: boolean): boolean {
  const needed = cost.wood + cost.stone;
  const deliverable = Math.min(Math.floor(person.materials.wood), cost.wood) + Math.min(Math.floor(person.materials.stone), cost.stone);
  if (needed === 0 || deliverable >= needed) return true;
  // Paid work on a standing site is a real contribution even with empty hands.
  if (construction.delivery === 'site' && construction.workLeft) return true;
  // V23: a carried pack (fibre, hide, resin: lightness × toughness) makes each trip worth 4..8 units. Compound lots
  // exist only in `quimica.emergente` worlds, so a historical person always keeps TRIP_LOAD = 4.
  const tripLoad = TRIP_LOAD + (person.compounds?.length ? compoundCarryUnits(person.compounds) : 0);
  return deliverable >= Math.min(needed, tripLoad) || (deliverable > 0 && !canGather);
}

/** Cells a fresh build of this genotype occupies (same rule as fittingPolyomino). */
function plannedArea(components: readonly StructureComponent[]): number {
  const n = counts(components);
  return n.frame >= 6 && n.roof + n.hearth >= n.cistern + n.garden ? 6 : n.frame <= 2 ? 1 : n.frame - 1;
}
/** Full paid bill of a fresh build, including the polyomino area surcharge. */
function plannedCost(world: World, components: readonly StructureComponent[]): BlueprintView['cost'] {
  return paramsOf(world).construccion.poliminosYSinergia ? polyominoCost(components, plannedArea(components)) : blueprintCost(components, true);
}
/** Cheapest real way to obtain the design here: a fresh build or the paid extension of a nearby building. */
function adoptionCost(world: World, person: Person, blueprint: BlueprintView): BlueprintView['cost'] {
  const fresh = plannedCost(world, blueprint.components), extension = expansionCandidate(world, person, blueprint)?.cost;
  return extension && normalizedCost(extension) < normalizedCost(fresh) ? extension : fresh;
}
/** What can physically reach a work started here: one carried load (own load plus reachable ground)
 * and the stock already banked in nearby warehouses. */
function constructionBudget(world: World, person: Person): { wood: number; stone: number } {
  const stored = { wood: 0, stone: 0 }, local = localMaterials(world, person, stored), extra = carryUnits(world, person);
  return { wood: Math.min(CARRY.wood + extra, local.wood - stored.wood) + stored.wood, stone: Math.min(CARRY.stone + extra, local.stone - stored.stone) + stored.stone };
}

/** Autonomous admission only. Explicit construction still uses completeConstruction
 * and pays the same material/work costs. No distant archive, historical uses or
 * invented number of occupants contributes to this local marginal comparison. */
export function constructionOpportunity(world: World, person: Person, placed = true): ConstructionOpportunity | undefined {
  if (ley(world, 'obra')) return oportunidadObraMaterial(ctxMateriaDe(world), person, placed);
  const site = constructionSite(world, person);
  if (site) return { target: { x: site.x, y: site.y }, score: 0.6 + person.traits.industriousness * 0.2,
    reason: 'Una obra local aún necesita entregas de materiales y trabajo pagado.',
    delivery: 'site', workLeft: site.site!.completedWork < site.site!.requiredWork };
  const modular = paramsOf(world).construccion.modular, blueprint = selectedBlueprint(world, person);
  const expansion = modular ? expansionCandidate(world, person, blueprint) : undefined;
  // Without free ground of its own, only an existing work (site or extension) can be continued.
  if (!placed && !expansion) return;
  if (!expansion && world.structures.length >= structureCap(world)) return;
  const cells = !expansion && modular && paramsOf(world).construccion.poliminosYSinergia ? fittingPolyomino(world, person, blueprint.components) : false;
  const cost = expansion?.cost ?? (cells ? polyominoCost(blueprint.components, cells.length) : blueprintCost(blueprint.components, modular)), materials = localMaterials(world, person);
  if (materials.wood < cost.wood || materials.stone < cost.stone) return;
  const context = constructionContext(world, person), before = serviceValue(localServices(world, person), context);
  if (expansion) {
    const old = blueprintAffordances(expansion.structure.components), upgraded = blueprintAffordances(blueprint.components);
    const stored = storedMaterialsNear(world, expansion.structure), oldCapacity = materialCapacity(expansion.structure);
    const capacity = materialCapacity({ ...expansion.structure, components: blueprint.components, footprint: expansion.footprint, cells: expansion.cells });
    const storageNeeded = capacity.wood > oldCapacity.wood && capacity.stone > oldCapacity.stone
      && person.materials.wood + stored.wood >= Math.min(12, cost.wood) && person.materials.stone + stored.stone >= Math.min(8, cost.stone);
    const gain = Math.max(0, upgraded.restQuality - old.restQuality) * context.rest
      + Math.max(0, upgraded.waterCapacity - old.waterCapacity) * context.water * context.rainPotential
      + Math.max(0, upgraded.foodCapacity - old.foodCapacity) * context.foodSurplus * context.food;
    if (gain >= MIN_SERVICE_GAIN || storageNeeded) {
      return { target: { x: expansion.structure.x, y: expansion.structure.y }, score: 0.6 + person.traits.industriousness * 0.2,
        reason: 'Ampliar una obra local conserva sus materiales y servicios; la nueva sección exige terreno libre y costes adicionales.',
        delivery: 'expansion', workLeft: true };
    }
    return;
  }
  // Material committed to the building cannot simultaneously fuel its hearth.
  const gain = serviceValue(localServices(world, person, undefined, blueprint.components, Math.max(0, person.materials.wood - cost.wood)), context) - before;
  const expense = normalizedCost(cost), baseExpense = normalizedCost(defaultBlueprint().cost);
  if (gain < MIN_SERVICE_GAIN * expense / baseExpense) return;
  const repair = usefulRepairs(world, person, context).find(option => materials.wood >= option.steps);
  if (repair && repair.efficiency >= gain / expense) return;
  return { score: 0.35 + person.traits.industriousness * 0.2 + Math.min(0.55, gain) - expense * 0.005,
    reason: 'El plano aporta una función adicional frente a las instalaciones que percibe; fabricarlo exige materiales y trabajo.' };
}

export interface InventionContext { water: number; food: number; rest: number; rainPotential: number; foodSurplus: number; moisture: number; cold: number; fuel: number;
  /** V23 (`quimica.emergente`): share of carried compound mass still unfired with no roofed hearth within reach. */
  kiln?: number; }
/** Perceived local deficits, not global resource omniscience or invented weather history.
 * rainPotential is explicitly a soil/biome prior; only actual rain can fill a built cistern. */
export function inventionContext(world: World, person: Person): InventionContext {
  let count = 0, moisture = 0, food = 0, wood = 0, reserve = 0;
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    if (dx * dx + dy * dy > 16) continue;
    const tile = tileAt(world, { x: person.x + dx, y: person.y + dy });
    if (tile && tile.terrain !== 'water') {
      count++; moisture += tile.moisture; food += tile.food; wood += tile.wood ?? 0;
      reserve = Math.max(reserve, tile.drinkingWater ?? 0);
    }
  }
  moisture /= Math.max(1, count); food /= Math.max(1, count); wood /= Math.max(1, count);
  const portable = vecinos(world, person, 5, p => distance(person, p) <= 4).reduce((sum, p) => sum + Math.max(0, p.inventory - 0.08), 0);
  const roofRadius = structureSearchRadius(world, 4);
  const roofs = filtrarCerca(world.structures, person, roofRadius + 1, s => distance(person, s) <= roofRadius && s.condition > BROKEN_CONDITION && tileAt(world, s)?.terrain === 'shelter');
  const quality = Math.max(0, ...roofs.map(s => blueprintAffordances(s.components).restQuality * s.condition));
  const context: InventionContext = { water: clamp(0.65 * (1 - clamp(reserve * 5)) + person.thirst * 0.35),
    food: clamp(0.65 * (1 - clamp(food * 4)) + person.hunger * 0.35),
    rest: clamp((1 - quality) * 0.6 + person.fatigue * 0.4),
    rainPotential: world.weather === 'rain' ? 1 : clamp(0.15 + moisture * 0.55),
    foodSurplus: clamp(portable * 2 + food * 2), moisture,
    cold: world.weather === 'rain' || world.tick % 2400 >= 1800 ? 1 : 0.15,
    fuel: clamp((person.materials.wood + wood) / 4) };
  // V23: carried unfired compounds (share of mass) motivate a hearth when none of the roofs already perceived has one.
  if (chemistryEra(world) && !roofs.some(s => s.components.includes('hearth') && s.components.includes('roof'))) {
    const kiln = unfiredCompoundShare(person.compounds); if (kiln > 0) context.kiln = kiln;
  }
  return context;
}

/** Cultural parents must be known through ownership, nearby built examples, or trusted contacts. */
function knownBlueprints(world: World, person: Person): BlueprintView[] {
  const ids = new Set(['blueprint-base', person.blueprintId]);
  const radius = structureSearchRadius(world, 5);
  for (const structure of filtrarCerca(world.structures, person, radius + 1, structure => distance(person, structure) <= radius
    && (paramsOf(world).construccion.modular ? hasCompletedBuilding(structure) : !structure.site) && structure.condition > BROKEN_CONDITION && tileAt(world, structure)?.terrain === 'shelter')) ids.add(structure.blueprintId);
  if (world.cooperationEnabled) for (const other of vecinos(world, person, 4, other => other !== person && distance(person, other) <= 3
    && (person.bonds[other.id] ?? 0.2) >= 0.2 && person.culture.openness >= 0.15)) ids.add(other.blueprintId);
  return world.blueprints.filter(b => (ids.has(b.id) || b.inventorId === person.id) && validBlueprint(b.components, paramsOf(world).construccion.modular));
}

function expectedValue(components: readonly StructureComponent[], context: InventionContext): number {
  const a = blueprintAffordances(components);
  const water = clamp(a.waterCapacity) * context.rainPotential * context.water;
  const food = clamp(a.foodCapacity) * context.foodSurplus * context.food
    + clamp(a.irrigation / 0.012) * context.rainPotential * (1 - context.moisture) * context.food * 0.65;
  const rest = (a.restQuality - 0.82 + a.hearths * 0.12 * context.cold * context.fuel) * context.rest * 5;
  // A base roof is already known; novelty is evaluated on the additional functions it enables.
  const value = water + food + rest + (a.durability - 1) * context.rest * 0.1;
  // V23: a roofed hearth would fire the unfired compounds this person carries (charcoal, ceramics, smelting).
  return context.kiln ? value + Math.min(1, a.hearths) * context.kiln * 0.25 : value;
}
const normalizedCost = (cost: BlueprintView['cost']) => cost.wood + cost.stone * 1.5 + cost.work / 30;
const genotypeDistance = (a: readonly StructureComponent[], b: readonly StructureComponent[]) => {
  const ac = counts(a), bc = counts(b); return COMPONENTS.reduce((sum, component) => sum + Math.abs(ac[component] - bc[component]), 0);
};
export interface InventionCandidate {
  components: StructureComponent[]; parents: string[]; value: number; efficiency: number; novelty: number;
  planoMaterial?: PlanoObra;
}

/** Exactly twelve bounded proposals, including meaningful multi-component edits; invalid children
 * are rejected rather than silently repaired into a different claimed genotype. */
export function inventionCandidates(world: World, person: Person): InventionCandidate[] {
  if (ley(world, 'obra')) return candidatosObra(ctxMateriaDe(world), person);
  return candidatesFromKnown(world, person, inventionContext(world, person), knownBlueprints(world, person));
}

function candidatesFromKnown(world: World, person: Person, context: InventionContext, known: BlueprintView[]): InventionCandidate[] {
  if (!known.length) known.push(defaultBlueprint());
  const values = new Map(known.map(b => [b, expectedValue(b.components, context)]));
  // Keep the original left-associative subtraction, including its rounding at ties.
  known.sort(paramsOf(world).construccion.modular
    ? (a, b) => values.get(b)! - values.get(a)! || blueprintSignature(a.components).localeCompare(blueprintSignature(b.components))
    : (a, b) => values.get(b)! + b.usefulness * 0.1 - values.get(a)! - a.usefulness * 0.1 || a.id.localeCompare(b.id));
  const random = localRandom(world.seed, `research:${person.id}:${world.tick}`), raw: { components: StructureComponent[]; parents: string[] }[] = [];
  const base = known.find(b => b.id === 'blueprint-base') ?? known[0]!;
  const push = (components: StructureComponent[], parents: string[]) => raw.push({ components: canonical(components), parents: [...new Set(parents)] });
  // Context-independent controls ensure selection, not proposal availability, explains contrasts.
  push([...base.components, 'cistern'], [base.id]);
  push([...base.components, 'granary'], [base.id]);
  push([...base.components, 'hearth'], [base.id]);
  push([...base.components, 'frame', 'roof'], [base.id]);
  push([...base.components, 'cistern', 'garden'], [base.id]);
  push([...base.components, 'granary', 'granary'], [base.id]);
  if (paramsOf(world).construccion.modular) for (const parent of known.slice(0, 4)) {
    push([...parent.components, 'frame', 'roof'], [parent.id]);
    push([...parent.components, 'frame'], [parent.id]);
  }
  for (let slot = 6; slot < 12; slot++) {
    const a = known[Math.floor(random() * Math.min(4, known.length))]!, b = known[Math.floor(random() * known.length)]!;
    if (slot < 9 && a.id !== b.id) {
      const ac = counts(a.components), bc = counts(b.components);
      const components = COMPONENTS.flatMap(component => Array.from({ length: random() < 0.5 ? ac[component] : bc[component] }, () => component));
      push(components, [a.id, b.id]);
    } else {
      const components = [...a.components], component = paramsOf(world).construccion.modular
        ? COMPONENTS[Math.floor(random() * COMPONENTS.length)]! : COMPONENTS[2 + Math.floor(random() * 4)]!;
      if (slot % 3 === 0 && components.length > 2) components.splice(2 + Math.floor(random() * (components.length - 2)), 1);
      else if (slot % 3 === 1 && components.length > 2) components[2 + Math.floor(random() * (components.length - 2))] = component;
      else components.push(component);
      push(components, [a.id]);
    }
  }
  const modular = paramsOf(world).construccion.modular, encountered = modular ? known : world.blueprints;
  const seen = new Set(encountered.map(b => blueprintSignature(b.components))), candidates: InventionCandidate[] = [];
  for (const child of raw) {
    if (!validBlueprint(child.components, modular)) continue;
    const signature = blueprintSignature(child.components); if (seen.has(signature)) continue; seen.add(signature);
    const value = expectedValue(child.components, context);
    candidates.push({ ...child, value, efficiency: value / normalizedCost(blueprintCost(child.components, modular)),
      novelty: Math.min(...encountered.map(b => genotypeDistance(child.components, b.components)), 8) / 8 });
  }
  return candidates;
}

export function paretoCandidates(candidates: readonly InventionCandidate[]): InventionCandidate[] {
  return candidates.filter(candidate => !candidates.some(other => other !== candidate
    && other.value >= candidate.value && other.efficiency >= candidate.efficiency && other.novelty >= candidate.novelty
    && (other.value > candidate.value || other.efficiency > candidate.efficiency || other.novelty > candidate.novelty)));
}

/** Physical service/cost frontier in the actor's own niche; no global utility or labels. */
export function locallyUsefulBlueprint(components: readonly StructureComponent[], known: readonly BlueprintView[], context: InventionContext, modular = false): boolean {
  const dimensions = (cs: readonly StructureComponent[]) => {
    const a = blueprintAffordances(cs), cost = normalizedCost(blueprintCost(cs, modular)), value = expectedValue(cs, context);
    return [value, value / cost, value * a.durability / cost,
      a.waterCapacity * context.water * context.rainPotential / cost,
      a.foodCapacity * context.foodSurplus * context.food / cost,
      a.irrigation * (1 - context.moisture) * context.food * context.rainPotential / cost];
  };
  const candidate = dimensions(components);
  return candidate[0]! > 0.035 && !known.some(b => {
    const other = dimensions(b.components);
    return other.every((v, i) => v >= candidate[i]!) && other.some((v, i) => v > candidate[i]!);
  });
}

function chooseInvention(world: World, person: Person, context = inventionContext(world, person)): InventionCandidate | undefined {
  const known = knownBlueprints(world, person), raw = candidatesFromKnown(world, person, context, known);
  const candidates = paramsOf(world).construccion.modular ? raw : paretoCandidates(raw);
  const bestKnown = Math.max(0, ...known.map(b => expectedValue(b.components, context)));
  const useful = candidates.filter(candidate => paramsOf(world).construccion.modular
    ? locallyUsefulBlueprint(candidate.components, known, context, true) : candidate.value > Math.max(0.035, bestKnown * 1.02));
  const valueScale = Math.max(0.001, ...useful.map(c => c.value)), efficiencyScale = Math.max(0.001, ...useful.map(c => c.efficiency));
  const score = (candidate: InventionCandidate) => candidate.value / valueScale * 0.76 + candidate.efficiency / efficiencyScale * 0.16 + candidate.novelty * 0.08;
  return useful.sort((a, b) => score(b) - score(a) || blueprintSignature(a.components).localeCompare(blueprintSignature(b.components)))[0];
}

function expertise(person: Person): number {
  return clamp(((person.activity.build ?? 0) + (person.activity.farm ?? 0) + (person.activity.gather ?? 0)) / 20
    + (person.skills.build ?? 0) + (person.skills.farm ?? 0) + (person.skills.gather ?? 0));
}

function candidatosObra(c: CtxLeyMateria, persona: Person): InventionCandidate[] {
  const mundo = c.mundo;
  const obras = obraCercana(mundo, persona, CONSTRUCTION_RADIUS);
  const referencias = [
    ...(persona.carga ?? []),
    ...obras.flatMap(s => estadoObra(s)!.piezas.map(p => p.lote)),
  ];
  const muestra = referencias.filter(l => c.materia.propio(l)).map(l => c.materia.vista(l))
    .find(v => areaPortante(v) >= AREA_OBRA_M2 * COBERTURA_COBIJO);
  if (!muestra) return [];
  const ids = new Set(['blueprint-base', persona.blueprintId, ...obras.map(s => s.blueprintId)]);
  const conocidos = mundo.blueprints.filter(b => ids.has(b.id) || b.inventorId === persona.id);
  const sitio = obras.find(s => structureDistance(persona, s) <= 0.5);
  const firmas = new Set(mundo.blueprints.map(firmaPlanoObra));
  const valorar = (plano: Readonly<PlanoObra>) => {
    const forma = formaDeCodigo(plano.forma);
    const huecoAnterior = formaDeCodigo(muestra.forma).hueco;
    const sellado = huecoAnterior < 1 ? clamp(muestra.sellado / (1 - huecoAnterior) * (1 - forma.hueco)) : 0;
    const s = prestacionesDePiezas([{ ...muestra, forma: plano.forma, sellado }], 1);
    const valor = calidadCobijo(s) * persona.fatigue + clamp(s.volumen * DENSIDAD_AGUA_KG_M3) * persona.thirst
      + clamp(s.volumen * DENSIDAD_GRANO_KG_M3) * persona.hunger;
    return valor * plano.area;
  };
  const candidatos: InventionCandidate[] = [];
  for (const padre of conocidos) {
    const plano = planoObra(padre);
    const f = formaDeCodigo(plano.forma);
    const variaciones: PlanoObra[] = [
      { ...plano, area: plano.area + 1, compacto: !plano.compacto },
      { ...plano, forma: codigoForma({ ...f, hueco: (1 + f.hueco) / 2 }) },
      { ...plano, forma: codigoForma({ ...f, grueso: f.grueso * 2, hueco: f.hueco / 2 }) },
      { ...plano, forma: muestra.forma },
    ];
    const valorPadre = valorar(plano);
    for (const variacion of variaciones) {
      const firma = `${variacion.area}/${Number(variacion.compacto)}/${variacion.forma}`;
      if (firmas.has(firma) || !fittingMaterial(mundo, sitio ?? persona, variacion, sitio)) continue;
      const value = valorar(variacion);
      if (value <= valorPadre) continue;
      firmas.add(firma);
      const masa = muestra.masa * variacion.area;
      candidatos.push({ components: [], parents: [padre.id], planoMaterial: variacion,
        value, efficiency: value / (masa * COLOCACION_J_POR_KG), novelty: 1 - valorPadre / value });
    }
  }
  return paretoCandidates(candidatos).sort((a, b) => b.efficiency - a.efficiency || b.value - a.value || b.novelty - a.novelty);
}

function costeEnsayoObraJ(): number {
  return Math.ceil(AREA_OBRA_M2 * MASA_PORTANTE_KG_M2 * COLOCACION_J_POR_KG);
}

function inventarObra(c: CtxLeyMateria, persona: Person, emit: Emit): boolean {
  const mundo = c.mundo, cuerpo = persona.cuerpo;
  if (!mundo.noveltyEnabled || !cuerpo || !puedeTrabajarEn(c, persona, celdaObra(c, persona))) return false;
  const [candidato] = candidatosObra(c, persona);
  if (!candidato?.planoMaterial) return false;
  const coste = costeEnsayoObraJ(), pago = pagar(c, cuerpo, coste);
  if (pago < coste) return false;
  const { planoMaterial } = candidato;
  const serial = c.globales.registro.insertar(new TextEncoder().encode(JSON.stringify(
    ['obra-v23', planoMaterial.area, planoMaterial.compacto, planoMaterial.forma],
  )));
  const padre = mundo.blueprints.find(b => b.id === candidato.parents[0])!;
  const plano: BlueprintView & { planoMaterial: PlanoObra } = {
    id: `${PREFIJO_PLANO_OBRA}${serial}`, name: `Obra de ${planoMaterial.area} celdas`, generation: padre.generation + 1,
    parents: candidato.parents, inventorId: persona.id, tick: mundo.tick, components: candidato.components,
    uses: 0, usefulness: 0, cost: { wood: 0, stone: 0, work: 0 }, planoMaterial,
  };
  mundo.blueprintCounter = Math.max(mundo.blueprintCounter, serial);
  mundo.blueprints.push(plano);
  mundo.inventionDynamics.attempts++;
  mundo.inventionDynamics.accepted++;
  persona.lastInvention = mundo.tick; persona.blueprintId = plano.id;
  emit({ kind: 'invention', actors: [persona.id], x: persona.x, y: persona.y, source: 'simulation',
    text: `${persona.name} ensayó otra planta de obra.`, cause: `Ensayo de una variación sobre ${padre.name} con ${pago} J de trabajo.` });
  return true;
}
export function inventionOpportunity(world: World, person: Person): { score: number; target: Point; reason: string } | undefined {
  if (ley(world, 'obra')) {
    if (!world.noveltyEnabled || !person.cuerpo) return;
    const c = ctxMateriaDe(world), ticks = Math.max(0, RESEARCH_WORK - (person.action === 'invent' ? person.work : 0));
    if (reservaJ(c, person.cuerpo) < costeEnsayoObraJ() + ticks * TRABAJO_J_TICK + basalJ(c, person.cuerpo, ticks)) return;
    const [plan] = candidatosObra(c, person);
    if (plan) return { score: plan.value * plan.novelty * person.curiosity, target: { x: person.x, y: person.y },
      reason: 'Una pieza real sugiere otra forma, volumen o reparto de la planta.' };
    return;
  }
  if (!world.noveltyEnabled || world.blueprints.length >= blueprintCap(world) || person.materials.wood < 1 || expertise(person) < 0.2
    || world.tick - (person.lastInvention ?? -RESEARCH_COOLDOWN) < RESEARCH_COOLDOWN
    || person.energy < 0.45 || Math.max(person.hunger, person.thirst, person.fatigue) > 0.72) return;
  const context = inventionContext(world, person), need = Math.max(context.water, context.food, context.rest);
  if (need < 0.35 || !chooseInvention(world, person, context)) return;
  return { target: { x: person.x, y: person.y }, score: 0.4 + person.curiosity * 0.25 + expertise(person) * 0.18 + need * 0.22,
    reason: 'Su práctica y una carencia local motivan ensayar otra combinación; el intento cuesta madera y trabajo.' };
}

/** The single debit boundary for research. A completed unsuccessful trial still consumes effort. */
export function invent(world: World, person: Person, emit: Emit): boolean {
  if (ley(world, 'obra')) return inventarObra(ctxMateriaDe(world), person, emit);
  if (!world.noveltyEnabled || person.work < RESEARCH_WORK || person.materials.wood < 1 || expertise(person) < 0.2
    || world.tick - (person.lastInvention ?? -RESEARCH_COOLDOWN) < RESEARCH_COOLDOWN) return false;
  const identity = blueprintIdentity(world); if (!identity) return false;
  person.materials.wood--; person.work -= RESEARCH_WORK; person.lastInvention = world.tick;
  world.inventionDynamics.attempts++;
  const candidate = world.blueprints.length < blueprintCap(world) ? chooseInvention(world, person) : undefined;
  if (!candidate) {
    person.reason = 'El ensayo consumió una madera y sesenta unidades de trabajo; no produjo una receta novedosa y útil.';
    return false;
  }
  const parents = candidate.parents.map(id => world.blueprints.find(b => b.id === id)).filter((b): b is BlueprintView => !!b);
  const blueprint: BlueprintView = { id: identity.id, name: blueprintName(candidate.components), components: candidate.components,
    generation: Math.max(0, ...parents.map(b => b.generation)) + 1, parents: parents.map(b => b.id), inventorId: person.id, tick: world.tick,
    uses: 0, usefulness: 0, cost: blueprintCost(candidate.components, paramsOf(world).construccion.modular) };
  // Intern a remote signature only AFTER the paid local discovery passed its own frontier.
  const existing = paramsOf(world).construccion.modular ? world.blueprints.find(b => blueprintSignature(b.components) === blueprintSignature(candidate.components)) : undefined;
  if (!existing) { world.blueprintCounter = identity.counter; world.blueprints.push(blueprint); }
  // V20 modular: a design larger than one carried load is kept as known culture (inventorId); adopting
  // it is the cost-aware choice of stepStructures, once warehouses or an extendable building can pay it.
  const adopted = existing ?? blueprint, bill = paramsOf(world).construccion.modular ? plannedCost(world, adopted.components) : undefined;
  const extra = bill ? carryUnits(world, person) : 0;
  if (!bill || (bill.wood <= CARRY.wood + extra && bill.stone <= CARRY.stone + extra)) person.blueprintId = adopted.id;
  world.inventionDynamics.accepted++;
  const event = emit({ kind: 'invention', actors: [person.id], x: person.x, y: person.y, source: 'simulation',
    text: `${person.name} ideó ${blueprint.name.toLocaleLowerCase('es')}, generación ${blueprint.generation}.`,
    cause: `Ensayo real: −1 madera y ${RESEARCH_WORK} trabajo; selección Pareto entre combinaciones válidas; receta cultural derivada de ${blueprint.parents.join(', ')}. La utilidad deberá comprobarse al usarla.` });
  person.experiences.push({ tick: world.tick, text: `Diseñó ${blueprint.name}; aún debe construirlo y probarlo.`, causeId: event.id, placeId: '' });
  person.experiences = person.experiences.slice(-8); person.recentMemory = person.experiences.at(-1)!.text;
  return true;
}

/** The single debit boundary for construction. No stock is seeded into the finished building.
 * V16 (`tecnologia.efectosHerramientas`): lashings, carpentry and masonry tools shorten the work the
 * blueprint needs (`constructionWorkFactor`) without changing its materials. The work saved is measured,
 * not assumed: only work the builder really did not spend wears the tools and counts as their benefit. */
function obraCercana(world: World, p: Point, radio: number): StructureView[] {
  const margen = radio + 1;
  return filtrarCerca(world.structures, p, CHUNK_SIZE + radio,
    s => {
      if (!estadoObra(s)) return false;
      let minima = Infinity;
      for (const celda of completedStructureCells(s)) {
        const dx = Math.abs(p.x - celda.x), dy = Math.abs(p.y - celda.y);
        // El margen deja fuera solo celdas inalcanzables. Con NaN se conserva el resultado de distance.
        if ((dx > margen && dy >= 0) || (dy > margen && dx >= 0)) continue;
        minima = Math.min(minima, distance(p, celda));
      }
      return minima <= radio;
    })
    .sort((a, b) => structureDistance(p, a) - structureDistance(p, b) || a.id.localeCompare(b.id));
}

function puedeTrabajarEn(c: CtxLeyMateria, quien: Person, celda: number): boolean {
  const ref = refDeOrganismo(c, quien);
  if (ref < 0 || celda < 0) return false;
  const slot = slotDe(ref);
  return c.personas.get(slot) === quien && c.frente.chunk[slot] === c.terreno.chunkDe(celda);
}

/** El lote a cuestas que sirve de pieza: propio, con masa, sólido o polvo, y duro o tenaz. */
function cargaDePieza(c: CtxLeyMateria, persona: Person): LoteRef | undefined {
  return persona.carga?.find(l => {
    if (!c.materia.propio(l)) return false;
    const v = c.materia.vista(l);
    return v.masa > 0 && (v.fase === 0 || v.fase === 3) && (v.dureza > 0 || v.tenacidad > 0);
  });
}

/** Si quien está en `p` tiene de dónde sacar una pieza: un lote duro a cuestas o roca latente en esa celda. */
function fuenteDePieza(c: CtxLeyMateria, persona: Person, p: Point): boolean {
  return cargaDePieza(c, persona) !== undefined || (tileAt(c.mundo, p)?.stone ?? 0) > 0;
}

function celdaPendiente(c: CtxLeyMateria, s: StructureView): Point | undefined {
  const obra = estadoObra(s);
  if (!obra) return;
  if (obra.pendiente) return obra.pendiente;
  const areas = new Map<string, number>();
  for (const pieza of obra.piezas) if (c.materia.propio(pieza.lote)) {
    const key = cellKey(pieza);
    areas.set(key, (areas.get(key) ?? 0) + areaPortante(c.materia.vista(pieza.lote)));
  }
  return (s.cells ?? [s]).find(p => (areas.get(cellKey(p)) ?? 0) < AREA_OBRA_M2 * COBERTURA_COBIJO);
}

function oportunidadObraMaterial(c: CtxLeyMateria, persona: Person, placed: boolean): ConstructionOpportunity | undefined {
  const mundo = c.mundo;
  if (!persona.cuerpo) return;
  const { plano } = planoSeleccionado(c, persona);
  for (const s of obraCercana(mundo, persona, CONSTRUCTION_RADIUS)) {
    const p = celdaPendiente(c, s);
    if (p) {
      // Sin pieza a medio asentar, solo se ofrece a quien tiene de dónde sacar una: sin ella cada tick allí fallaba.
      if (estadoObra(s)!.pendiente || fuenteDePieza(c, persona, p)) return { target: { x: p.x, y: p.y },
        score: 0.6 + persona.traits.industriousness * 0.2, delivery: 'site', workLeft: true, reason: 'La obra local necesita piezas y trabajo para asentarlas.' };
      continue;
    }
    if (plano.area > (s.cells?.length ?? 1) && fittingMaterial(mundo, s, plano, s)) {
      return { target: { x: s.x, y: s.y }, score: 0.6 + persona.traits.industriousness * 0.2, delivery: 'expansion',
        workLeft: true, reason: 'La planta del plano admite una ampliación con más piezas.' };
    }
  }
  if (!placed) return;
  const tile = tileAt(mundo, persona);
  if (!tile || !fittingMaterial(mundo, tile, plano) || !fuenteDePieza(c, persona, tile)) return;
  const carencia = Math.max(persona.fatigue, persona.thirst, persona.hunger);
  return { target: { x: tile.x, y: tile.y }, score: carencia * persona.traits.industriousness,
    reason: 'Puede ensayar el plano con la materia que tiene a mano.' };
}

/** Arranca un corte, unión o cocción de T1 sobre un lote libre ya depositado en la obra. */
export function prepararPiezaObra(c: CtxLeyMateria, s: StructureView, p: Point, lote: LoteRef, pasos: readonly Paso[]): boolean {
  const obra = estadoObra(s);
  const celda = celdaObra(c, p);
  if (!obra || !c.mundo.structures.includes(s) || obra.pendiente || obra.agua === lote || obra.comida === lote || celda < 0
    || !c.materia.propio(lote) || !(s.cells ?? [s]).some(q => q.x === p.x && q.y === p.y)
    || !lotesEnObra(c, celda, Rol.Objeto).includes(lote)) return false;
  const vista = c.materia.vista(lote);
  if (vista.masa <= 0 || (!vista.forma && !pasos.length)) return false;
  const proceso = pasos.length ? iniciarProceso(c, lote, pasos, p.x, p.y) : null;
  obra.pendiente = { x: p.x, y: p.y, lote, proceso, trabajoJ: 0 };
  return true;
}

function contribuirObraMaterial(c: CtxLeyMateria, persona: Person, s: StructureView, emit: Emit): boolean {
  const mundo = c.mundo, obra = estadoObra(s), cuerpo = persona.cuerpo;
  const p = celdaPendiente(c, s);
  if (!obra || !cuerpo || !p || distance(persona, p) > 0.5) return false;
  const celda = celdaObra(c, p);
  if (!puedeTrabajarEn(c, persona, celda)) return false;
  if (!obra.pendiente) {
    const plano = formaDePlano(c, s.blueprintId);
    const forma = formaDeCodigo(plano.forma);
    const carga = cargaDePieza(c, persona);
    const vistaCarga = carga === undefined ? undefined : c.materia.vista(carga);
    const lote = carga === undefined
      ? rocaDe(c, celda, MASA_PORTANTE_KG_M2 * forma.largo * forma.ancho)
      : trasladarLoteObra(c, carga, Rol.Objeto, celda, vistaCarga!.forma);
    if (carga !== undefined) persona.carga!.splice(persona.carga!.indexOf(carga), 1);
    const pasos: Paso[] = vistaCarga && areaPortante(vistaCarga) > 0 ? [] : [{ op: 'romper', forma }];
    if (lote < 0 || !prepararPiezaObra(c, s, p, lote, pasos)) return false;
  }
  const pendiente = obra.pendiente!;
  if (pendiente.proceso) {
    if (!c.materia.propio(pendiente.lote)) {
      obra.pendiente = null;
      return false;
    }
    const avance = avanzarProceso(c, pendiente.proceso, cuerpo);
    pendiente.lote = pendiente.proceso.lote;
    if (avance !== 'hecho') return avance !== 'espera';
    pendiente.proceso = null;
  }
  if (!c.materia.propio(pendiente.lote) || areaPortante(c.materia.vista(pendiente.lote)) <= 0) {
    obra.pendiente = null;
    return false;
  }
  const coste = Math.ceil(cargaKg(c, [pendiente.lote]) * COLOCACION_J_POR_KG);
  const falta = Math.max(0, coste - pendiente.trabajoJ);
  const pago = falta > 0 ? pagar(c, cuerpo, falta) : 0;
  pendiente.trabajoJ += Math.min(falta, pago);
  if (pendiente.trabajoJ < coste) return pago > 0;
  colocarPieza(c, s.id, pendiente.lote, celda);
  obra.pendiente = null;
  const servicio = prestacionesObra(c, s);
  s.condition = servicio.cobertura >= COBERTURA_COBIJO ? servicio.cobertura : 0;
  if (!obra.terminada && !celdaPendiente(c, s)) {
    obra.terminada = true;
    s.builtAt = mundo.tick;
    mundo.settlementCount++;
    const id = `settlement-${s.x}-${s.y}`;
    const previo = c.globales.lugares.get(id) ?? mundo.places.find(p => p.id === id);
    const lugar = previo ?? { id, name: s.name, x: s.x, y: s.y,
      description: 'Obra levantada con piezas colocadas.', gatherings: 0 };
    // El checkpoint puede caer entre F4 y F0. El dueño ya deja el lugar en su mundo y en el chunk.
    if (!previo) mundo.places.push(lugar);
    const locales = mundo.chunks[chunkKey(s.x, s.y)]!.places;
    if (!locales.some(p => p.id === id)) locales.push(lugar);
    if (!previo) c.pedirGlobal('lugar', serialize(lugar));
    emit({ kind: 'settlement', actors: [persona.id], x: s.x, y: s.y, source: 'simulation',
      text: `${persona.name} terminó ${s.name.toLocaleLowerCase('es')}.`,
      cause: `La obra sostiene ${servicio.masa.toFixed(3)} kg de piezas colocadas con trabajo pagado.` });
  }
  return true;
}

function construirObraMaterial(c: CtxLeyMateria, persona: Person, tile: Tile, emit: Emit): StructureView | null {
  const mundo = c.mundo, celda = celdaObra(c, tile);
  if (!persona.cuerpo || tileAt(mundo, tile) !== tile || distance(persona, tile) > 0.5 || !puedeTrabajarEn(c, persona, celda)) return null;
  const blueprint = planoSeleccionado(c, persona), { plano } = blueprint;
  const existente = obraCercana(mundo, tile, 0.5)[0];
  if (existente) {
    const obra = estadoObra(existente)!;
    if (obra.terminada && !celdaPendiente(c, existente) && plano.area > (existente.cells?.length ?? 1)) {
      const cells = fittingMaterial(mundo, existente, plano, existente);
      if (!cells) return null;
      existente.cells = cells;
      existente.blueprintId = blueprint.id;
      existente.name = blueprint.name;
      existente.components = [];
      return existente;
    }
    return contribuirObraMaterial(c, persona, existente, emit) ? existente : null;
  }
  const cells = fittingMaterial(mundo, tile, plano);
  if (!cells || !fuenteDePieza(c, persona, tile)) return null;
  const serial = c.id('estructura');
  const s: StructureView & { obraMaterial: EstadoObra } = {
    id: `structure-${serial}`, x: tile.x, y: tile.y, cells, blueprintId: blueprint.id, name: blueprint.name,
    components: [], condition: 0, water: 0, food: 0, uses: 0, builtAt: mundo.tick, builderId: persona.id,
    obraMaterial: { piezas: [], pendiente: null, agua: -1, comida: -1, terminada: false },
  };
  mundo.structureCounter = Math.max(mundo.structureCounter, serial);
  mundo.structures.push(s);
  return contribuirObraMaterial(c, persona, s, emit) ? s : null;
}

export function completeConstruction(world: World, person: Person, tile: Tile, emit: Emit): StructureView | null {
  if (ley(world, 'obra')) return construirObraMaterial(ctxMateriaDe(world), person, tile, emit);
  if (paramsOf(world).construccion.modular) return modularConstruction(world, person, tile, emit);
  const blueprint = selectedBlueprint(world, person), cost = blueprintCost(blueprint.components);
  const tools = toolEffectsEnabled(world), requiredWork = tools ? cost.work * constructionWorkFactor(world, person) : cost.work;
  if (!validBlueprint(blueprint.components) || world.structures.length >= structureCap(world) || tileAt(world, tile) !== tile || distance(person, tile) > 0.5
    || tile.terrain === 'water' || tile.terrain === 'shelter' || algunoCerca(world.places, tile, 6, p => distance(p, tile) < 5)
    || algunoCerca(world.structures, tile, 1, s => s.x === tile.x && s.y === tile.y) || person.work < requiredWork || person.materials.wood < cost.wood || person.materials.stone < cost.stone) return null;
  const identity = nextIdentity(world.structureCounter, 'structure', world.structures.map(s => s.id), world);
  if (!identity) return null;
  const paidWork = tools ? Math.min(person.work, cost.work) : cost.work, savedWork = cost.work - paidWork;
  person.materials.wood -= cost.wood; person.materials.stone -= cost.stone; person.work -= paidWork; world.structureCounter = identity.counter;
  const structure: StructureView = { id: identity.id, x: tile.x, y: tile.y, blueprintId: blueprint.id, name: blueprint.name,
    components: [...blueprint.components], condition: 1, water: 0, food: 0, uses: 0, builtAt: world.tick, builderId: person.id };
  world.structures.push(structure); tile.terrain = 'shelter'; marcarTesela(tile); world.settlementCount++;
  installTechnologyItem(world, person, structure);
  const place = { id: `settlement-${tile.x}-${tile.y}`, name: blueprint.name, x: tile.x, y: tile.y,
    description: `Construido por ${person.name}; componentes ${blueprint.components.join(', ')}.`, gatherings: 0 };
  world.places.push(place); world.chunks[chunkKey(tile.x, tile.y)]?.places.push(place);
  if (savedWork > 0) consumeConstructionTools(world, person, savedWork);
  const toolNote = savedWork > 0 ? ` Herramientas de atar, cortar y desbastar ahorraron ${Math.round(savedWork * 10) / 10} de trabajo, con desgaste real.` : '';
  const event = emit({ kind: 'settlement', actors: [person.id], x: tile.x, y: tile.y, source: 'simulation', text: `${person.name} construyó ${blueprint.name.toLocaleLowerCase('es')}.`,
    cause: `Plano ${blueprint.id}; trabajo ${cost.work}; inventario −${cost.wood} madera y −${cost.stone} piedra. Depósitos inicialmente vacíos.${toolNote}` });
  person.experiences.push({ tick: world.tick, text: `Construyó ${blueprint.name}.`, causeId: event.id, placeId: place.id });
  person.experiences = person.experiences.slice(-8); person.recentMemory = person.experiences.at(-1)!.text;
  return structure;
}

function modularConstruction(world: World, person: Person, tile: Tile, emit: Emit): StructureView | null {
  if (!world.people.includes(person) || tileAt(world, tile) !== tile || distance(person, tile) > 0.5 || tile.terrain === 'water') return null;
  const existing = world.structures.find(s => s.x === tile.x && s.y === tile.y);
  const blueprint = selectedBlueprint(world, person), cost = blueprintCost(blueprint.components, true);
  if (existing) {
    if (!existing.site) {
      const expansion = expansionCandidate(world, person, blueprint);
      if (!expansion || expansion.structure !== existing || (person.materials.wood <= 0 && person.materials.stone <= 0 && person.work <= 0
        && storedMaterialsNear(world, person).wood + storedMaterialsNear(world, person).stone <= 0)) return null;
      existing.site = { requiredWood: expansion.cost.wood, requiredStone: expansion.cost.stone, requiredWork: expansion.cost.work,
        depositedWood: 0, depositedStone: 0, completedWork: 0,
        expansion: { blueprintId: blueprint.id, components: [...blueprint.components], ...(expansion.footprint ? { footprint: expansion.footprint } : {}),
          ...(expansion.cells && expansion.cells.length > 1 ? { cells: expansion.cells } : {}) } };
    }
    return contributeConstruction(world, person, existing, emit) ? existing : null;
  }
  const polyomino = paramsOf(world).construccion.poliminosYSinergia;
  const cells = polyomino ? fittingPolyomino(world, tile, blueprint.components) : undefined;
  const footprint = polyomino ? (cells && cells.length > 1 ? cellFootprint(cells) : undefined) : fittingFootprint(world, tile, blueprint.components);
  const paidCost = cells ? polyominoCost(blueprint.components, cells.length) : cost;
  if (!validBlueprint(blueprint.components, true) || tile.terrain === 'shelter' || world.structures.length >= structureCap(world)
    || footprint === false || cells === false
    || algunoCerca(world.places, tile, 6, p => distance(p, tile) < 5 && !world.structures.some(s => p.id === `settlement-${s.x}-${s.y}`))
    || (person.materials.wood <= 0 && person.materials.stone <= 0 && person.work <= 0)) return null;
  const identity = nextIdentity(world.structureCounter, 'structure', world.structures.map(s => s.id), world);
  if (!identity) return null;
  const structure: StructureView = { id: identity.id, x: tile.x, y: tile.y, blueprintId: blueprint.id, name: blueprint.name,
    components: [...blueprint.components], condition: 0, water: 0, food: 0, uses: 0, builtAt: world.tick, builderId: person.id,
    site: { requiredWood: paidCost.wood, requiredStone: paidCost.stone, depositedWood: 0, depositedStone: 0, requiredWork: paidCost.work, completedWork: 0 },
    ...(footprint ? { footprint } : {}), ...(cells && cells.length > 1 ? { cells } : {}) };
  world.structureCounter = identity.counter; world.structures.push(structure);
  contributeConstruction(world, person, structure, emit);
  return structure;
}

/** Only present actors can debit their own carried load and already paid work. */
export function contributeConstruction(world: World, person: Person, structure: StructureView, emit: Emit): boolean {
  if (ley(world, 'obra')) return contribuirObraMaterial(ctxMateriaDe(world), person, structure, emit);
  const site = structure.site;
  if (!paramsOf(world).construccion.modular || !site || !world.structures.includes(structure) || !world.people.includes(person)
    || distance(person, structure) > 1.5 || !isFootprintFree(world, structureFootprintCells(structure), structure.id)) return false;
  const wood = Math.max(0, Math.min(12, Math.floor(person.materials.wood), site.requiredWood - site.depositedWood));
  const stone = Math.max(0, Math.min(8, Math.floor(person.materials.stone), site.requiredStone - site.depositedStone));
  const work = Math.max(0, Math.min(person.work, site.requiredWork - site.completedWork));
  const stored = withdrawMaterials(world, person, { wood: site.requiredWood - site.depositedWood - wood, stone: site.requiredStone - site.depositedStone - stone });
  if (wood + stone + work + stored.wood + stored.stone <= 0) return false;
  person.materials.wood -= wood; person.materials.stone -= stone; person.work -= work;
  site.depositedWood += wood + stored.wood; site.depositedStone += stone + stored.stone; site.completedWork += work;
  installTechnologyItem(world, person, structure);
  if (site.depositedWood < site.requiredWood || site.depositedStone < site.requiredStone || site.completedWork < site.requiredWork) return true;
  if (site.expansion) {
    const target = world.blueprints.find(b => b.id === site.expansion!.blueprintId)!;
    structure.blueprintId = target.id; structure.name = target.name; structure.components = [...site.expansion.components];
    if (site.expansion.footprint) structure.footprint = { ...site.expansion.footprint };
    if (paramsOf(world).construccion.poliminosYSinergia) {
      if (site.expansion.cells) structure.cells = site.expansion.cells.map(c => ({ ...c }));
      if (!site.expansion.footprint) delete structure.footprint;
    }
  }
  delete structure.site; structure.condition = 1;
  for (const cell of structureFootprintCells(structure)) { const celda = tileAt(world, cell)!; celda.terrain = 'shelter'; marcarTesela(celda); }
  const tile = tileAt(world, structure)!;
  if (!site.expansion) { structure.builtAt = world.tick; world.settlementCount++; }
  const place = { id: `settlement-${tile.x}-${tile.y}`, name: structure.name, x: tile.x, y: tile.y,
    description: `Obra compartida; componentes ${structure.components.join(', ')}.`, gatherings: 0 };
  if (!site.expansion) { world.places.push(place); world.chunks[chunkKey(tile.x, tile.y)]?.places.push(place); }
  else {
    for (const p of world.places) if (p.id === place.id) { p.name = place.name; p.description = place.description; }
  }
  emit({ kind: 'settlement', actors: [person.id], x: tile.x, y: tile.y, source: 'simulation',
    text: `${person.name} terminó ${structure.name.toLocaleLowerCase('es')}.`,
    cause: `Obra material completa: ${site.depositedWood} madera, ${site.depositedStone} piedra y ${site.completedWork} trabajo pagado. Depósitos vacíos.` });
  return true;
}

/** Added volume and protection come only from the condition of real installed products. */
export function structureAffordances(world: World, structure: StructureView) {
  if (ley(world, 'obra')) {
    const s = prestacionesObra(ctxMateriaDe(world), structure);
    return { waterCapacity: s.volumen * DENSIDAD_AGUA_KG_M3, foodCapacity: s.volumen * DENSIDAD_GRANO_KG_M3,
      catchment: FLUJO_CAPTACION_KG_M2_TICK * s.cobijo * (structure.cells?.length ?? 1) * AREA_OBRA_M2,
      irrigation: 0, restQuality: calidadCobijo(s), hearths: s.calor > 0 ? 1 : 0, durability: Math.max(s.dureza, s.tenacidad) };
  }
  const a = blueprintAffordances(structure.components);
  if (!paramsOf(world).tecnologia.obrasPorPropiedades || !structure.installed?.length) return a;
  const containment = structure.installed.reduce((n, i) => n + i.containment * i.condition * i.mass / 1000, 0);
  return { ...a, waterCapacity: a.waterCapacity * (1 + containment), foodCapacity: a.foodCapacity * (1 + containment) };
}

function installationProtection(world: World, structure: StructureView) {
  let insulation = 0, joining = 0;
  if (paramsOf(world).tecnologia.obrasPorPropiedades) for (const i of structure.installed ?? []) {
    insulation += i.insulation * i.condition * i.mass / 1000;
    joining += i.cohesion * i.binding * i.condition * i.mass / 1000;
  }
  return { insulation, joining };
}

/** Anchor-index broad phase; the physical predicate always limits neighbours to three cells.
 * Query each occupied cell so opposite ends of two halls still share their actual wall. */
function synergyNeighbours(world: World, structure: StructureView): StructureView[] {
  const found = new Set<StructureView>();
  for (const cell of completedStructureCells(structure)) for (const other of filtrarCerca(world.structures, cell, 5,
    s => s !== structure && hasCompletedBuilding(s) && s.condition > BROKEN_CONDITION && structureDistance(cell, s) <= 3)) found.add(other);
  return [...found].sort((a, b) => a.id.localeCompare(b.id));
}

export function computeStructureSynergy(world: World, structure: StructureView): StructureSynergyView {
  if (ley(world, 'obra')) {
    const c = ctxMateriaDe(world), servicio = prestacionesObra(c, structure);
    return { sharedEdges: 0, heated: servicio.calor > 0, irrigated: false, workshopBonus: 0 };
  }
  const result: StructureSynergyView = { sharedEdges: 0, heated: false, irrigated: false, workshopBonus: 0, kilnTier: 0 };
  if (!hasCompletedBuilding(structure) || structure.condition <= BROKEN_CONDITION) return result;
  const cells = completedStructureCells(structure), neighbours = synergyNeighbours(world, structure), n = counts(structure.components);
  const walls = new Set(neighbours.flatMap(completedStructureCells).map(cellKey));
  for (const c of cells) for (const [dx, dy] of ORTHOGONAL) if (walls.has(`${c.x + dx},${c.y + dy}`)) result.sharedEdges++;
  result.heated = n.hearth > 0 || neighbours.some(s => s.components.includes('hearth'));
  result.irrigated = (n.cistern > 0 && structure.water > 0) || neighbours.some(s => s.components.includes('cistern') && s.water >= 0.02);
  const installed = (structure.installed ?? []).filter(i => i.condition > 0);
  if (n.roof && (installed.length || n.hearth)) {
    const properties = installed.reduce((sum, i) => sum + (i.cohesion + i.binding + i.insulation) * i.condition / 3, 0);
    result.workshopBonus = Math.min(0.30, properties * 0.24 + (n.hearth ? 0.04 : 0)
      + (neighbours.some(s => (s.storedWood ?? 0) + (s.storedStone ?? 0) > 0 && materialCapacity(s).wood > 0) ? 0.06 : 0));
  }
  if (n.hearth) {
    result.kilnTier = n.roof ? 1 : 0;
    if (n.roof && (installed.some(i => i.insulation * i.condition >= 0.35) || n.hearth >= 2
      || (cells.length >= 2 && structure.storedCompounds?.some(c => c.mass > 0 && c.properties.fuelPower >= 0.6)))) result.kilnTier = 2;
    // V23: a multi-cell hearth hall, or a roofed hearth whose settlement banks dense charcoal (here or in a
    // neighbour wall-to-wall within three cells), sustains the reducing heat of a tier-2 kiln.
    else if (n.roof && chemistryEra(world) && (cells.length >= 2 || structure.storedCompounds?.some(isFuelLot)
      || neighbours.some(s => s.storedCompounds?.some(isFuelLot)))) result.kilnTier = 2;
  }
  return result;
}

function defaultMaterialProfile(structure: StructureView): StructureMaterialProfile {
  const cost = blueprintCost(structure.components), stone = cost.stone / Math.max(1, cost.stone + cost.wood);
  let strength = 0.3 + stone * 0.5, insulation = 0.25 + (1 - stone) * 0.35, seal = stone * 0.4;
  let tint = stone >= 0.5 ? '#ccc4b4' : '#a87848';
  for (const i of structure.installed ?? []) {
    strength += (i.cohesion + i.binding) * i.condition * 0.12;
    insulation += i.insulation * i.condition * 0.2; seal += i.containment * i.condition * 0.2;
  }
  let total = 0, r = 0, g = 0, b = 0;
  for (const lot of structure.storedCompounds ?? []) if (lot.mass > 0) {
    const p = lot.properties, weight = lot.mass;
    strength += (p.hardness + p.toughness) * weight / (1000 + weight) * 0.15;
    insulation += p.insulation * weight / (1000 + weight) * 0.2; seal += p.seal * weight / (1000 + weight) * 0.2;
    total += weight; r += parseInt(p.colorHex.slice(1, 3), 16) * weight;
    g += parseInt(p.colorHex.slice(3, 5), 16) * weight; b += parseInt(p.colorHex.slice(5, 7), 16) * weight;
  }
  if (total > 0) tint = '#' + [r, g, b].map(c => Math.round(c / total).toString(16).padStart(2, '0')).join('');
  return { strength: clamp(strength), insulation: clamp(insulation), seal: clamp(seal), tint };
}

/** Never walks neighbours from a decision helper: the last ecological step supplies shared walls. */
function thermalBonus(world: World, structure: StructureView): number {
  if (!paramsOf(world).construccion.poliminosYSinergia) return 0.12;
  const geometry = polyominoGeometry(completedStructureCells(structure));
  return 0.12 * (1 + Math.min(0.30, (structure.synergy?.sharedEdges ?? 0) * 0.10)
    + Math.min(0.25, Math.max(0, geometry.compactness - 0.25) / 0.35 * 0.25)
    + (structure.materialProfile?.insulation ?? defaultMaterialProfile(structure).insulation) * 0.25);
}

function observeUse(world: World, structure: StructureView, benefit: number): void {
  if (benefit <= 0) return;
  structure.uses++;
  const blueprint = world.blueprints.find(b => b.id === structure.blueprintId);
  if (blueprint) { blueprint.uses++; blueprint.usefulness = clamp(blueprint.usefulness + (clamp(benefit) - blueprint.usefulness) * 0.04); }
}
// Sprint noche-perf 2026-09-22: se descarta primero lo que está a más de `radius + 1` en algún eje (entonces
// `Math.hypot` supera `radius` sin duda de redondeo) y el filtro completo, puro, decide igual que antes sobre
// el resto; el orden de `world.structures` se conserva. Evita un `tileAt` por estructura en cada consulta.
// Sprint noche-perf2: los candidatos salen del índice por casillas (indice-puntos.ts), en el orden del arreglo.
const functionalNear = (world: World, point: Point, radius = 1.5) => paramsOf(world).construccion.modular
  ? filtrarCerca(world.structures, point, radius + 2, s => hasCompletedBuilding(s) && s.condition > BROKEN_CONDITION && tileAt(world, s)?.terrain === 'shelter' && structureDistance(point, s) <= radius)
  : filtrarCerca(world.structures, point, radius + 1, s => Math.abs(s.x - point.x) <= radius + 1
    && Math.abs(s.y - point.y) <= radius + 1 && !s.site && s.condition > BROKEN_CONDITION && tileAt(world, s)?.terrain === 'shelter' && distance(s, point) <= radius);
const waterNearScratch = new WeakMap<World, StructureView[]>();
// `foodCapacity = granary·0.7` es positiva exactamente cuando hay algún granero (y `waterCapacity` con alguna cisterna): basta mirar
// el componente, sin construir el recuento ni el objeto de capacidades por estructura.
export function foodAvailable(world: World, person: Point): number {
  if (ley(world, 'obra')) {
    const c = ctxMateriaDe(world);
    return obraCercana(world, person, 1.5).reduce((suma, s) => suma + stockObra(c, s, 'comida'), 0);
  }
  return functionalNear(world, person).reduce((sum, s) => sum + (s.components.includes('granary') ? s.food : 0), 0);
}

export function comidaEnObra(c: CtxLeyMateria, cuerpo: NonNullable<Person['cuerpo']>, punto: Point, kg: number): number {
  let energia = 0;
  for (const s of obraCercana(c.mundo, punto, 1.5)) {
    const lote = loteDepositoObra(c, s, 'comida');
    if (lote >= 0 && prestacionesObra(c, s).volumen > 0) energia += energiaAlimento(c, cuerpo, lote, kg);
  }
  return energia;
}
/** Returns food removed, never also credits inventory. The consumer owns the sole matching credit. */
export function takeFood(world: World, person: Point, requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  const member = person as Person;
  if (ley(world, 'obra')) return member.action === 'eat' ? consumirDepositoObra(ctxMateriaDe(world), member, 'comida', requested) : 0;
  let taken = 0;
  for (const structure of functionalNear(world, person).sort((a, b) => distance(person, a) - distance(person, b) || a.id.localeCompare(b.id))) {
    if (!structure.components.includes('granary')) continue;
    const amount = Math.min(structure.food, requested - taken);
    structure.food -= amount; taken += amount; world.inventionDynamics.foodTaken += amount;
    if (esMiembro(world.people, member, world.tick) && member.action === 'eat' && member.hunger > 0) observeUse(world, structure, amount * 10);
    if (taken >= requested) break;
  }
  return taken;
}

/** Perception includes cistern stock directly; keeping water in its reservoir retains provenance. */
export function waterAvailable(world: World, point: Point): number {
  let total = tileAt(world, point)?.drinkingWater ?? 0;
  if (ley(world, 'obra')) {
    const c = ctxMateriaDe(world);
    const celda = celdaObra(c, point);
    if (celda < 0) return 0;
    const { agua } = lotesDeCelda(c, celda, { suelo: -1, agua: -1, vida: -1, aire: -1 });
    total = agua >= 0 ? c.materia.vista(agua).agua * KG_POR_CUANTO_AGUA : 0;
    return obraCercana(world, point, 0.5).reduce((suma, s) => suma + stockObra(c, s, 'agua'), total);
  }
  if (paramsOf(world).construccion.modular) return total + functionalNear(world, point, 0.5)
    .reduce((sum, s) => sum + (s.components.includes('cistern') ? s.water : 0), 0);
  // Reuse a per-world result buffer so the indexed query keeps its narrow scan without allocating
  // an empty candidate array for every person on every tick.
  const candidates = waterNearScratch.get(world) ?? [];
  waterNearScratch.set(world, candidates);
  filtrarCerca(world.structures, point, 1.5, structure => Math.abs(structure.x - point.x) <= 1.5
    && Math.abs(structure.y - point.y) <= 1.5 && !structure.site && structure.condition > BROKEN_CONDITION
    && tileAt(world, structure)?.terrain === 'shelter' && distance(structure, point) <= 0.5, candidates);
  for (const structure of candidates) {
    if (structure.components.includes('cistern')) total += structure.water;
  }
  return total;
}

/** Sole drinking debit: use ambient water first, then credit only water delivered by a cistern.
 * The engine applies the matching thirst reduction immediately after this call. */
export function takeWater(world: World, person: Person, requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0 || !esMiembro(world.people, person, world.tick) || person.action !== 'drink'
    || distance(person, person.target) > 0.5 || person.thirst <= 0) return 0;
  const tile = tileAt(world, person); if (!tile) return 0;
  if (ley(world, 'obra')) {
    const c = ctxMateriaDe(world), celda = celdaObra(c, tile);
    if (!person.cuerpo || !puedeTrabajarEn(c, person, celda)) return 0;
    const { agua } = lotesDeCelda(c, celda, { suelo: -1, agua: -1, vida: -1, aire: -1 });
    const kg = agua < 0 ? 0 : beber(c, person.cuerpo, agua, requested);
    return kg + consumirDepositoObra(c, person, 'agua', requested - kg);
  }
  const needed = Math.min(requested, person.thirst / SED_POR_UNIDAD), ambient = Math.min(tile.drinkingWater ?? 0, needed);
  let taken: number;
  if (ley(world, 'materia')) {
    const c = ctxMateriaDe(world), celda = celdaObra(c, tile);
    taken = ambient > 0 && puedeTrabajarEn(c, person, celda) ? extraerEscalar(c, celda, 'agua', ambient) : 0;
  } else {
    tile.drinkingWater = (tile.drinkingWater ?? 0) - ambient;
    marcarTesela(tile);
    taken = ambient;
  }
  for (const structure of functionalNear(world, person, 0.5)) {
    if (!structure.components.includes('cistern')) continue;
    const amount = Math.min(structure.water, needed - taken);
    structure.water -= amount; taken += amount;
    observeUse(world, structure, amount * 15);
    if (taken >= needed) break;
  }
  return taken;
}

/** Material que entra en el digestivo. El cuerpo da alivio al asimilarlo. */
export function consumirDepositoObra(c: CtxLeyMateria, quien: Person, tipo: DepositoObra, kg: number): number {
  const cuerpo = quien.cuerpo;
  if (!Number.isFinite(kg) || kg <= 0 || !cuerpo) return 0;
  let tomado = 0;
  for (const s of obraCercana(c.mundo, quien, tipo === 'agua' ? 0.5 : 1.5)) {
    if (!puedeTrabajarEn(c, quien, celdaObra(c, s)) || prestacionesObra(c, s).volumen <= 0) continue;
    const lote = loteDepositoObra(c, s, tipo);
    if (lote < 0) continue;
    const resta = kg - tomado;
    const cantidad = tipo === 'agua' ? beber(c, cuerpo, lote, resta) : ingerirSelecto(c, cuerpo, lote, resta);
    tomado += cantidad;
    if (tipo === 'comida') c.mundo.inventionDynamics.foodTaken += cantidad;
    observeUse(c.mundo, s, cantidad);
    if (tomado >= kg) break;
  }
  return tomado;
}

export function guardarEnObra(c: CtxLeyMateria, quien: Person, tipo: DepositoObra, lote: LoteRef, kg: number): number {
  const carga = quien.carga;
  if (!carga?.includes(lote) || !c.materia.propio(lote) || !Number.isFinite(kg) || kg <= 0) return 0;
  let guardado = 0;
  for (const s of obraCercana(c.mundo, quien, 1.5)) {
    if (!puedeTrabajarEn(c, quien, celdaObra(c, s))) continue;
    guardado += depositarEnObra(c, s, tipo, lote, kg - guardado);
    if (guardado >= kg || c.materia.vista(lote).masa <= 0) break;
  }
  if (guardado > 0 && c.materia.vista(lote).masa <= 0 && c.materia.calor(lote) === 0) {
    c.materia.liberar(lote);
    carga.splice(carga.indexOf(lote), 1);
  }
  if (tipo === 'comida') c.mundo.inventionDynamics.foodStored += guardado;
  return guardado;
}

/** Asienta una piedra labrada de la carga en la celda por la que pasa la persona. */
export function empedrar(c: CtxLeyMateria, quien: Person, tile: Tile): boolean {
  const celda = celdaObra(c, tile), cuerpo = quien.cuerpo, carga = quien.carga;
  if (!cuerpo || !carga || !puedeTrabajarEn(c, quien, celda) || distance(quien, tile) > 0.5
    || tile.terrain === 'water' || tile.terrain === 'shelter' || obraCercana(c.mundo, tile, 0.5).length
    || calidadEmpedrado(c, tile) >= 1) return false;
  const i = carga.findIndex(lote => c.materia.propio(lote) && esPiedraDeObra(c, c.materia.vista(lote)));
  if (i < 0) return false;
  const lote = carga[i]!;
  const coste = Math.ceil(cargaKg(c, [lote]) * COLOCACION_J_POR_KG);
  if (pagar(c, cuerpo, coste) < coste) return false;
  trasladarLoteObra(c, lote, Rol.Pieza, celda, c.materia.vista(lote).forma);
  carga.splice(i, 1);
  registrarEmpedrado(c, celda);
  c.propio.marcar(c.terreno.chunkDe(celda), true);
  return true;
}

function calidadCobijo(s: ReturnType<typeof prestacionesObra>): number {
  return clamp(s.cobijo * (1 + s.aislamiento) + s.calor / SALTO_TERMICO_COBIJO_K);
}

function cobijoCercano(c: CtxLeyMateria, p: Point): { estructura: StructureView | undefined; calidad: number } {
  let estructura: StructureView | undefined, calidad = 0;
  for (const s of obraCercana(c.mundo, p, 0.5)) {
    const valor = calidadCobijo(prestacionesObra(c, s));
    if (valor > calidad) { estructura = s; calidad = valor; }
  }
  return { estructura, calidad };
}

export function cobijoEnObra(c: CtxLeyMateria, p: Point): boolean {
  return cobijoCercano(c, p).calidad > 0;
}

function restFacility(world: World, person: Person): StructureView | undefined {
  return functionalNear(world, person, 0.5).sort((a, b) => b.condition - a.condition || a.id.localeCompare(b.id))[0];
}
function hearthFuel(world: World, person: Person, structure: StructureView): number {
  return world.weather === 'rain' || world.tick % 2400 >= 1800 ? blueprintAffordances(structure.components).hearths * 0.0005 : 0;
}
export function facilityRestQuality(world: World, person: Person): number {
  const outdoor = world.weather === 'rain' ? 0.2 : 0.55;
  if (!world.shelterBenefitEnabled) return outdoor;
  if (ley(world, 'obra')) {
    return outdoor + (1 - outdoor) * cobijoCercano(ctxMateriaDe(world), person).calidad;
  }
  const structure = restFacility(world, person); if (!structure) return outdoor;
  const a = blueprintAffordances(structure.components), fuel = hearthFuel(world, person, structure);
  return Math.max(outdoor, clamp((a.restQuality + (fuel > 0 && person.materials.wood >= fuel ? thermalBonus(world, structure) : 0)) * structure.condition));
}
/** Called after body recovery, with the pre-rest body. Only recovery beyond the outdoor
 * counterfactual is evidence; saturated bodies and degraded roofs cannot earn fictitious utility. */
export function recordFacilityRest(world: World, person: Person, before?: Pick<Person, 'fatigue' | 'energy'>): void {
  if (!world.shelterBenefitEnabled || !before || !Number.isFinite(before.fatigue) || !Number.isFinite(before.energy)
    || before.fatigue < 0 || before.fatigue > 1 || before.energy < 0 || before.energy > 1 || !esMiembro(world.people, person, world.tick)
    || person.action !== 'rest' || distance(person, person.target) > 0.5) return;
  const material = ley(world, 'obra');
  const structure = material
    ? cobijoCercano(ctxMateriaDe(world), person).estructura
    : restFacility(world, person);
  if (!structure) return;
  const outdoor = world.weather === 'rain' ? 0.2 : 0.55, quality = facilityRestQuality(world, person);
  const energyRate = REST_ENERGY_RATE * clamp((1 - Math.max(person.hunger, person.thirst)) / 0.5);
  const actualFatigue = Math.max(0, Math.min(before.fatigue - person.fatigue, before.fatigue, REST_FATIGUE_RATE * quality));
  const actualEnergy = Math.max(0, Math.min(person.energy - before.energy, 1 - before.energy, energyRate * quality));
  const extra = (counterfactual: number) => Math.max(0, actualFatigue - Math.min(before.fatigue, REST_FATIGUE_RATE * counterfactual))
    + Math.max(0, actualEnergy - Math.min(1 - before.energy, energyRate * counterfactual));
  const benefit = extra(outdoor);
  // Rounding at saturation must not fabricate an incremental benefit.
  if (quality <= outdoor || benefit <= 1e-12) return;
  if (!material) {
    const fuel = hearthFuel(world, person, structure), unheated = Math.max(outdoor, blueprintAffordances(structure.components).restQuality * structure.condition);
    if (fuel > 0 && person.materials.wood >= fuel && extra(unheated) > 1e-12) person.materials.wood -= fuel;
  }
  observeUse(world, structure, benefit / (REST_FATIGUE_RATE + REST_ENERGY_RATE));
}

export function repairOpportunity(world: World, person: Person): StructureView | undefined {
  if (ley(world, 'obra')) {
    const c = ctxMateriaDe(world);
    return obraCercana(world, person, CONSTRUCTION_RADIUS).find(s => estadoObra(s)!.terminada && !!celdaPendiente(c, s));
  }
  if (person.materials.wood + (paramsOf(world).construccion.modular ? storedMaterialsNear(world, person).wood : 0) < 1) return;
  const options = usefulRepairs(world, person);
  if (!options.length) return;
  const materials = localMaterials(world, person);
  return options.find(option => materials.wood >= option.steps)?.structure;
}
/** V16 (`tecnologia.efectosHerramientas`): lashings (`binding`) and dressed stone (`abrasion`) make the same wood
 * and work restore more condition, +0.25·power per tool up to 1. Each tool pays real wear and is credited
 * exactly the condition it added. Perception (`usefulRepairs`) still plans the bare +0.4 step. */
export function repair(world: World, person: Person, structure: StructureView, emit: Emit): boolean {
  if (ley(world, 'obra')) {
    const obra = estadoObra(structure);
    if (!obra?.terminada) return false;
    const piezas = obra.piezas.length;
    const reparada = contribuirObraMaterial(ctxMateriaDe(world), person, structure, emit);
    if (obra.piezas.length > piezas) world.inventionDynamics.repairs++;
    return reparada;
  }
  const modular = paramsOf(world).construccion.modular, load = modular ? maintenanceLoad(structure) : 1;
  if (!world.structures.includes(structure) || structure.site || structure.condition >= REPAIR_CONDITION_LIMIT || distance(person, structure) > 1.5
    || person.materials.wood + (modular ? storedMaterialsNear(world, person).wood : 0) < load || person.work < REPAIR_WORK * load) return false;
  if (modular) {
    const carried = Math.min(load, Math.floor(person.materials.wood));
    if (carried + storedMaterialsNear(world, person).wood < load) return false;
    withdrawMaterials(world, person, { wood: load - carried, stone: 0 });
    person.materials.wood -= carried;
  } else person.materials.wood--;
  person.work -= REPAIR_WORK * load; structure.condition = clamp(structure.condition + 0.4); world.inventionDynamics.repairs++;
  let toolGain = 0;
  if (toolEffectsEnabled(world)) for (const capability of ['binding', 'abrasion'] as const) {
    if (structure.condition >= 1) break;
    const receipt = useTool(world, person, capability, 0.7);
    if (!receipt) continue;
    const before = structure.condition;
    structure.condition = clamp(before + 0.25 * receipt.power); toolGain += structure.condition - before;
    recordTechnologyBenefit(world, person, receipt, structure.condition - before);
  }
  const toolNote = toolGain > 0 ? ` Ataduras y piedra desbastada sumaron +${Math.round(toolGain * 1000) / 1000} de condición, con desgaste real.` : '';
  installTechnologyItem(world, person, structure);
  emit({ kind: 'invention', actors: [person.id], x: structure.x, y: structure.y, source: 'simulation', text: `${person.name} reparó ${structure.name.toLocaleLowerCase('es')}.`,
    cause: `Mantenimiento real: −${load} madera y ${REPAIR_WORK * load} trabajo; condición +0,4 hasta un máximo de 1.${toolNote}` });
  return true;
}

function maintenanceLoad(structure: StructureView): number {
  const area = completedStructureCells(structure).length;
  return Math.ceil(area * (1 + 0.15 * Math.max(0, counts(structure.components).frame - 1)));
}

/** Bounded active structures only. Inflow, transfers and irrigation all have explicit debits. */
export function stepStructures(world: World, _emit: Emit): void {
  if (ley(world, 'obra')) return;
  if (world.tick % INTERVALO_ECOLOGIA_TICKS !== 0) return;
  const materia = ley(world, 'materia') ? ctxMateriaDe(world) : undefined;
  const polyomino = paramsOf(world).construccion.poliminosYSinergia;
  if (polyomino) for (const structure of world.structures) {
    if (!hasCompletedBuilding(structure)) continue;
    structure.materialProfile ??= defaultMaterialProfile(structure);
    structure.synergy = computeStructureSynergy(world, structure);
  }
  for (const structure of world.structures) {
    const modular = paramsOf(world).construccion.modular;
    if (modular ? !hasCompletedBuilding(structure) : structure.site) continue;
    const tile = tileAt(world, structure); if (!tile || tile.terrain !== 'shelter') continue;
    const a = structureAffordances(world, structure), protection = installationProtection(world, structure);
    let wear = modular ? (world.weather === 'rain' ? 0.00028 : 0.00018) / a.durability * maintenanceLoad(structure)
      : (world.weather === 'rain' ? 0.00028 : 0.00018) / a.durability;
    const geometry = polyomino ? polyominoGeometry(completedStructureCells(structure)) : undefined;
    if (polyomino) {
      const compact = Math.min(0.25, Math.max(0, geometry!.compactness - 0.25) / 0.35 * 0.25);
      wear *= (1 - compact) * (1 - Math.min(0.45, structure.synergy!.sharedEdges * 0.15)) * (1 - structure.materialProfile!.strength * 0.25);
      a.catchment *= 1 + Math.min(0.40, Math.max(0, geometry!.perimeter - 4) * 0.08);
    }
    structure.condition = clamp(structure.condition - (paramsOf(world).tecnologia.obrasPorPropiedades ? wear / (1 + protection.joining) : wear));
    if (paramsOf(world).tecnologia.obrasPorPropiedades || polyomino) {
      // Exposure consumes condition, never material quanta. Failed liners retain their matter.
      for (const i of structure.installed ?? []) i.condition = clamp(i.condition - wear);
      const capacity = structureAffordances(world, structure);
      // Overflow and exposure losses cannot turn into a credited use.
      const beforeWater = structure.water, beforeFood = structure.food;
      structure.water = Math.min(structure.water, capacity.waterCapacity);
      structure.food = Math.min(structure.food, capacity.foodCapacity);
      const sealing = polyomino ? 1 - structure.materialProfile!.seal * 0.35 : 1;
      const drying = polyomino && structure.synergy!.heated && structure.components.includes('granary') ? 0.5 : 1;
      if (polyomino) {
        structure.water -= structure.water * 0.002 / (1 + protection.insulation) * sealing;
        structure.food -= structure.food * 0.001 / (1 + protection.insulation) * sealing * drying;
      } else {
        structure.water -= structure.water * 0.002 / (1 + protection.insulation);
        structure.food -= structure.food * 0.001 / (1 + protection.insulation);
      }
      const losses = structure.losses ??= { water: 0, food: 0 };
      losses.water += beforeWater - structure.water; losses.food += beforeFood - structure.food;
      a.waterCapacity = capacity.waterCapacity; a.foodCapacity = capacity.foodCapacity;
    }
    if (structure.condition <= BROKEN_CONDITION) continue;
    if (modular) for (const person of vecinos(world, structure, 3.5, p => structureDistance(p, structure) <= 1.5)) depositMaterials(world, person, structure);
    const celdaEstructura = materia ? celdaObra(materia, tile) : -1;
    if (world.weather === 'rain' && a.waterCapacity > 0) {
      const potential = Math.max(0, Math.min(a.waterCapacity - structure.water, a.catchment * structure.condition));
      const collected = materia ? celdaEstructura >= 0 && potential > 0 ? extraerEscalar(materia, celdaEstructura, 'agua', potential) : 0 : potential;
      structure.water += Math.max(0, collected); world.inventionDynamics.waterCollected += Math.max(0, collected);
    }
    // Production remains stock. Only an actual consumer may turn supply into observed utility.
    if (a.irrigation > 0 && (structure.water > 0 || polyomino)) {
      const irrigationCells = polyomino ? completedStructureCells(structure) : [structure];
      const ground = new Map<string, Point>();
      for (const cell of irrigationCells) for (const [dx, dy] of ORTHOGONAL) {
        const p = { x: cell.x + dx, y: cell.y + dy }; ground.set(cellKey(p), p);
      }
      const gardens = (polyomino ? [...ground.values()].map(p => tileAt(world, p))
        : [[0, -1], [-1, 0], [1, 0], [0, 1]].map(([dx, dy]) => tileAt(world, { x: structure.x + dx!, y: structure.y + dy! })))
        .filter((t): t is Tile => !!t && t.terrain !== 'water' && t.terrain !== 'shelter' && t.moisture < 0.75);
      if (polyomino && gardens.length > 0 && structure.water <= 0) {
        const donor = synergyNeighbours(world, structure).find(s => s.components.includes('cistern') && s.water >= 0.02);
        // Transfer is real stock; residual water stays in the garden's reservoir.
        if (donor) { donor.water -= 0.01; structure.water += 0.01; observeUse(world, donor, 0.01 * 15); }
      }
      let budget = Math.min(structure.water, a.irrigation * structure.condition);
      for (const [index, garden] of gardens.entries()) {
        const amount = Math.min(budget / (gardens.length - index), 0.75 - garden.moisture);
        const celda = materia ? celdaObra(materia, garden) : -1;
        if (materia) {
          const mismoChunk = celda >= 0 && celdaEstructura >= 0 && materia.terreno.chunkDe(celda) === materia.terreno.chunkDe(celdaEstructura);
          const regado = mismoChunk && amount > 0 ? aportarEscalar(materia, celda, 'agua', amount) : 0;
          structure.water -= regado; budget -= regado;
        } else {
          garden.moisture += amount; marcarTesela(garden); structure.water -= amount; budget -= amount;
        }
      }
      // V23 (`quimica.emergente`): ash, lime and ground organics banked here manure the irrigated garden ground.
      if (!materia && chemistryEra(world) && structure.storedCompounds?.length) {
        for (const garden of gardens) garden.fertility = enrichSoilFromLots(structure.storedCompounds, garden.fertility ?? 0);
        if (structure.storedCompounds.length === 0) delete structure.storedCompounds;
      }
    }
    if (a.foodCapacity > 0) for (const person of vecinos(world, structure, 2.5,
      person => !(distance(person, structure) > 1.5 || person.hunger >= 0.5 || person.inventory <= 0.12))) {
      const deposited = Math.max(0, Math.min(person.inventory - 0.12, a.foodCapacity - structure.food, 0.012));
      person.inventory -= deposited; structure.food += deposited; world.inventionDynamics.foodStored += deposited;
    }
  }
  if (world.tick % 60 === 0 && world.learningEnabled) for (const person of world.people) {
    // El único efecto es la asignación de abajo, que exige `action !== 'build'` y otro plano mejor: quien construye, o sólo
    // conoce su propio plano (o ninguno), no cambia; se evita entonces calcular el contexto local, que es lo más caro.
    if (person.action === 'build') continue;
    const current = selectedBlueprint(world, person), candidates = knownBlueprints(world, person);
    if (candidates.length === 0 || (candidates.length === 1 && candidates[0]!.id === current.id)) continue;
    const context = inventionContext(world, person);
    if (paramsOf(world).construccion.modular) {
      // Value net of its paid bill, among designs this place can actually pay (one carried load plus
      // banked stock, or the extension of a nearby building). Same expense weight as constructionOpportunity.
      // When carrying material surplus under polyominoes, physical warehouse volume counts toward adoption
      // so settlements organically graduate from 1×1 shelters to multi-cell halls once locally affordable.
      const budget = constructionBudget(world, person);
      const carryLoad = clamp((person.materials.wood + person.materials.stone) / 14);
      const net = (b: BlueprintView) => {
        const bill = adoptionCost(world, person, b);
        if (bill.wood > budget.wood || bill.stone > budget.stone) return undefined;
        const cap = polyomino ? (counts(b.components).frame >= 2 ? plannedArea(b.components) * 20 : counts(b.components).granary > 0 ? 7 : 0) : 0;
        const storageValue = polyomino ? clamp(cap / 80) * carryLoad * 0.16 : 0;
        return expectedValue(b.components, context) + storageValue - normalizedCost(bill) * 0.005;
      };
      const options = candidates.map(blueprint => ({ blueprint, value: net(blueprint) }))
        .filter((o): o is { blueprint: BlueprintView; value: number } => o.value !== undefined)
        .sort((a, b) => b.value - a.value || a.blueprint.id.localeCompare(b.blueprint.id));
      const best = options[0], own = options.find(o => o.blueprint.id === current.id)?.value ?? net(current);
      if (best && best.blueprint.id !== current.id && (own === undefined || best.value > own + 0.025)) person.blueprintId = best.blueprint.id;
      continue;
    }
    const value = (b: BlueprintView) => expectedValue(b.components, context) + b.usefulness * 0.12;
    const observed = candidates.map(blueprint => ({ blueprint, value: value(blueprint) }))
      .sort((a, b) => b.value - a.value || a.blueprint.id.localeCompare(b.blueprint.id))[0];
    if (observed && observed.blueprint.id !== current.id && observed.value > value(current) + 0.025) person.blueprintId = observed.blueprint.id;
  }
}
