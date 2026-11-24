/**
 * V20 — Motor de química algebraica conservada de 6 especies elementales (`C/Si/Ca/Fe/S/H`).
 *
 * Principios:
 * - Conservación exacta: ningún operador inventa masa. Lo que sale del lote (H evaporado, escoria de Si,
 *   carbono consumido como gas de escape, sales lavadas) se devuelve explícitamente en `byproduct` o
 *   `evaporatedH`, de modo que `masa(entrada) = masa(producto) + masa(byproduct) + evaporatedH` (±1e-9).
 * - Sin árbol tecnológico fijo: no hay recetas ni nombres de materiales; las fórmulas emergen de la
 *   firma cuantizada `(fase, vector normalizado en cubetas de 5 %)` y sus nombres se derivan de los
 *   rasgos físicos dominantes.
 * - Determinismo: las decisiones usan un hash puro de `(semilla, paso, id)`; nunca se toca `world.rng`.
 * - Coste O(1) por operación: 6 elementos, firma con índice en `WeakMap` (no viaja en la instantánea) y
 *   tope de fórmulas (`MAX_FORMULAS`) para que la instantánea no crezca sin límite.
 */
import {
  ELEMENTS, emptyVector, evaluateMaterialProperties, geologyAt, normalizeVector, vectorMass,
} from '../shared/chemistry.js';
import type {
  ChemOperator, ChemicalFormulaView, ChemistrySummaryView, CompoundLot, ElementSymbol, ElementVector,
  MaterialProperties, StructureMaterialProfile, ThermalPhase,
} from '../shared/chemistry.js';

export type TemperatureTier = 0 | 1 | 2;

export interface ChemistryState {
  formulas: ChemicalFormulaView[];
  formulaCounter: number;
  lotCounter: number;
  byOperator: Record<ChemOperator, number>;
  maxTemperatureTier: TemperatureTier;
}

/** Tope de fórmulas descubiertas por mundo: al llenarse, una mezcla nueva reutiliza la fórmula más cercana. */
export const MAX_FORMULAS = 256;
/** Inventario químico acotado por habitante; el exceso se aglomera (bind) sin perder masa. */
export const MAX_PERSON_COMPOUNDS = 6;
/** Fórmulas que viajan en la proyección (`WorldView.chemistry`); el total se informa aparte. */
export const PROJECTED_FORMULAS = 64;
/** Agua real que consume un lavado. */
export const WASH_WATER = 0.02;
/** Combustible mínimo (poder calorífico) que habilita el horno T2. */
export const KILN_FUEL_POWER = 0.6;
/** Masa de un lote extraído por cada unidad real de madera o piedra debitada. */
export const EXTRACTION_MASS = 1;
/** Misma frontera que `BROKEN_CONDITION` (inventions.ts): por debajo la estructura no funciona. */
const WORKING_CONDITION = 0.1;
const MASS_TOLERANCE = 1e-6;

const OPERATORS: readonly ChemOperator[] = ['grind', 'wash', 'heat', 'bind'];
const PHASES: readonly ThermalPhase[] = ['raw', 'ground', 'washed', 'fired', 'smelted', 'vitrified'];
const PHASE_RANK: Record<ThermalPhase, number> = { raw: 0, ground: 1, washed: 2, fired: 3, vitrified: 4, smelted: 5 };
const PHASE_TIER: Record<ThermalPhase, TemperatureTier> = { raw: 0, ground: 0, washed: 0, fired: 1, vitrified: 2, smelted: 2 };

export function defaultChemistryState(): ChemistryState {
  return { formulas: [], formulaCounter: 0, lotCounter: 0, byOperator: { grind: 0, wash: 0, heat: 0, bind: 0 }, maxTemperatureTier: 0 };
}

/**
 * Devuelve el estado químico del mundo. Solo lo crea y lo adjunta a `world.chemistry` cuando
 * `params.quimica.emergente === true`; en un mundo V18/V19 (apagado) devuelve un estado suelto sin
 * añadir campos al mundo.
 */
export function ensureChemistryState(world: { chemistry?: ChemistryState; params?: { quimica?: { emergente?: boolean } } }): ChemistryState {
  if (world.chemistry) return world.chemistry;
  const state = defaultChemistryState();
  if (world.params?.quimica?.emergente === true) world.chemistry = state;
  return state;
}

// ---------------------------------------------------------------------------------------------
// Vectores y firmas

function cloneVector(v: ElementVector): ElementVector {
  return { C: v.C, Si: v.Si, Ca: v.Ca, Fe: v.Fe, S: v.S, H: v.H };
}

function addVectors(a: ElementVector, b: ElementVector): ElementVector {
  return { C: a.C + b.C, Si: a.Si + b.Si, Ca: a.Ca + b.Ca, Fe: a.Fe + b.Fe, S: a.S + b.S, H: a.H + b.H };
}

function scaleVector(v: ElementVector, k: number): ElementVector {
  return { C: v.C * k, Si: v.Si * k, Ca: v.Ca * k, Fe: v.Fe * k, S: v.S * k, H: v.H * k };
}

function buckets(composition: ElementVector): number[] {
  const n = normalizeVector(composition);
  return ELEMENTS.map(e => Math.round(n[e] * 20));
}

/** Firma canónica determinista: fase + vector normalizado cuantizado en cubetas del 5 %. */
export function formulaSignature(phase: ThermalPhase, composition: ElementVector): string {
  const q = buckets(composition);
  return `${phase}:${ELEMENTS.map((e, i) => `${e}${q[i]}`).join('.')}`;
}

function signatureBuckets(signature: string): number[] {
  const body = signature.slice(signature.indexOf(':') + 1);
  return body.split('.').map(part => Number(part.replace(/^[A-Za-z]+/, '')));
}

/** Índice firma → fórmula fuera del estado serializable (se reconstruye si el arreglo cambió). */
const signatureIndex = new WeakMap<ChemicalFormulaView[], Map<string, ChemicalFormulaView>>();

function indexFor(state: ChemistryState): Map<string, ChemicalFormulaView> {
  let index = signatureIndex.get(state.formulas);
  if (!index || index.size !== state.formulas.length) {
    index = new Map(state.formulas.map(f => [f.signature, f]));
    signatureIndex.set(state.formulas, index);
  }
  return index;
}

// ---------------------------------------------------------------------------------------------
// Nombres emergentes (derivados de rasgos físicos, nunca de una lista de materiales)

const ADJECTIVE: Record<ElementSymbol, string> = { C: 'carbonoso', Si: 'silíceo', Ca: 'cálcico', Fe: 'férrico', S: 'salino', H: 'hídrico' };
const PREFIX: Record<ElementSymbol, string> = { C: 'carbo', Si: 'silico', Ca: 'calco', Fe: 'ferro', S: 'sali', H: 'hidro' };
const PARTICIPLE: Record<ThermalPhase, string> = { raw: 'crudo', ground: 'molido', washed: 'lavado', fired: 'cocido', smelted: 'fundido', vitrified: 'vítreo' };

function dominantElements(n: ElementVector, exclude?: ElementSymbol): ElementSymbol[] {
  return ELEMENTS.filter(e => e !== exclude && n[e] >= 0.12)
    .sort((a, b) => n[b] - n[a] || ELEMENTS.indexOf(a) - ELEMENTS.indexOf(b))
    .slice(0, 2);
}

function chemicalAdjective(elements: ElementSymbol[]): string {
  if (elements.length === 0) return 'mixto';
  if (elements.length === 1) return ADJECTIVE[elements[0]!];
  return `${PREFIX[elements[0]!]}-${ADJECTIVE[elements[1]!]}`;
}

/** Nombre descriptivo en castellano a partir de la composición, la fase y las propiedades medidas. */
export function emergentName(composition: ElementVector, phase: ThermalPhase, properties: MaterialProperties): string {
  const n = normalizeVector(composition);
  if (properties.fuelPower >= 0.6) {
    const rest = dominantElements(n, 'C');
    return `Carbón ${n.C >= 0.6 || rest.length === 0 ? 'denso' : ADJECTIVE[rest[0]!]} ${PARTICIPLE[phase]}`;
  }
  const adjective = chemicalAdjective(dominantElements(n));
  if (phase === 'vitrified') return `${properties.seal >= 0.75 ? 'Sellante' : 'Compuesto'} vítreo ${adjective}`;
  let noun: string;
  if (phase === 'smelted' || (properties.hardness >= 0.7 && properties.toughness >= 0.6)) noun = 'Compuesto';
  else if (properties.seal >= 0.65) noun = 'Sellante';
  else if (n.Ca >= 0.3 && PHASE_RANK[phase] >= PHASE_RANK.fired) noun = 'Aglomerado';
  else if (n.H >= 0.3) noun = 'Lodo';
  else if (phase === 'ground') noun = 'Polvo';
  else if (n.C >= 0.4) noun = 'Residuo';
  else noun = 'Agregado';
  return `${noun} ${adjective} ${PARTICIPLE[phase]}`;
}

// ---------------------------------------------------------------------------------------------
// Registro de fórmulas

function registerFormula(
  state: ChemistryState, composition: ElementVector, phase: ThermalPhase, operator: ChemOperator,
  tier: TemperatureTier, tick: number, discovererId: string | null,
): { formula: ChemicalFormulaView; isNew: boolean } {
  const signature = formulaSignature(phase, composition);
  const index = indexFor(state);
  const known = index.get(signature);
  if (known) { known.uses++; return { formula: known, isNew: false }; }
  if (state.formulas.length >= MAX_FORMULAS) {
    // Tope alcanzado: la fórmula más cercana (L1 sobre cubetas; misma fase primero) absorbe la mezcla.
    const q = buckets(composition);
    let best: ChemicalFormulaView | undefined; let bestScore = Infinity;
    for (const f of state.formulas) {
      const fq = signatureBuckets(f.signature);
      let d = f.phase === phase ? 0 : 1000;
      for (let i = 0; i < q.length; i++) d += Math.abs(q[i]! - (fq[i] ?? 0));
      if (d < bestScore) { bestScore = d; best = f; }
    }
    best!.uses++;
    return { formula: best!, isNew: false };
  }
  const normalized = normalizeVector(composition);
  const rounded = emptyVector();
  for (const e of ELEMENTS) rounded[e] = Math.round(normalized[e] * 1000) / 1000;
  const properties = evaluateMaterialProperties(composition, phase);
  // Mezclas distintas con los mismos rasgos dominantes: variante numerada (barrido acotado por MAX_FORMULAS,
  // solo al descubrir).
  const base = emergentName(composition, phase, properties);
  let homonyms = 0;
  for (const f of state.formulas) if (f.name === base || f.name.startsWith(`${base} (variante `)) homonyms++;
  const formula: ChemicalFormulaView = {
    id: `F${++state.formulaCounter}`, signature, name: homonyms === 0 ? base : `${base} (variante ${homonyms + 1})`,
    composition: rounded, phase, temperatureTier: tier, operator, discoveredAt: tick, discovererId, uses: 1, properties,
  };
  state.formulas.push(formula);
  index.set(signature, formula);
  return { formula, isNew: true };
}

function makeLot(state: ChemistryState, formulaId: string, composition: ElementVector, phase: ThermalPhase): CompoundLot {
  return {
    id: `L${++state.lotCounter}`, formulaId, composition, phase, mass: vectorMass(composition),
    properties: evaluateMaterialProperties(composition, phase),
  };
}

// ---------------------------------------------------------------------------------------------
// Extracción y operadores físicos

/**
 * Lote crudo de la geología latente de la tesela, escalado por la masa real debitada. La geología natural
 * no es un descubrimiento: el lote lleva `formulaId = geo:<firma>` y no ocupa el registro de fórmulas.
 */
export function extractGeologyLot(seed: number, x: number, y: number, biome: string | undefined, feature: string | undefined, mass: number, state: ChemistryState): CompoundLot {
  if (!(Number.isFinite(mass) && mass > 0)) throw new RangeError(`extractGeologyLot: masa inválida ${mass}`);
  const composition = scaleVector(geologyAt(seed, x, y, biome, feature), mass);
  return makeLot(state, `geo:${formulaSignature('raw', composition)}`, composition, 'raw');
}

export interface ChemOperatorOptions {
  /** Segundo lote: obligatorio en `bind`; en `heat` es la carga de co-cocción (p. ej. carbón reductor). */
  b?: CompoundLot;
  temperatureTier: TemperatureTier;
  waterAvailable?: number;
  /** Paso y autor para el registro de descubrimiento (opcionales). */
  tick?: number;
  actorId?: string | null;
}

export interface ChemOperatorResult {
  product: CompoundLot;
  byproduct?: ElementVector;
  evaporatedH: number;
  waterConsumed: number;
  temperatureTier: TemperatureTier;
  formula: ChemicalFormulaView;
  isNew: boolean;
}

function higherPhase(a: ThermalPhase, b: ThermalPhase): ThermalPhase {
  return PHASE_RANK[a] >= PHASE_RANK[b] ? a : b;
}

function assertOperand(lot: CompoundLot, label: string): void {
  if (!lot || typeof lot !== 'object') throw new TypeError(`applyChemOperator: ${label} ausente`);
  assertVector(lot.composition, `applyChemOperator: ${label}.composition`);
  if (!PHASES.includes(lot.phase)) throw new TypeError(`applyChemOperator: ${label}.phase inválida`);
}

/**
 * Aplica uno de los 4 operadores físicos universales. Puro respecto a los lotes de entrada (no los muta;
 * el llamador los retira de su inventario) y conservativo: entrada = producto + byproduct + evaporatedH.
 */
export function applyChemOperator(op: ChemOperator, a: CompoundLot, options: ChemOperatorOptions, state: ChemistryState): ChemOperatorResult {
  assertOperand(a, 'a');
  if (options.b !== undefined) {
    assertOperand(options.b, 'b');
    if (options.b === a || options.b.id === a.id) throw new RangeError('applyChemOperator: un lote no puede combinarse consigo mismo');
  }
  const tier = options.temperatureTier;
  if (tier !== 0 && tier !== 1 && tier !== 2) throw new RangeError(`applyChemOperator: temperatureTier inválido ${String(tier)}`);
  let product: ElementVector;
  let phase: ThermalPhase;
  let byproduct: ElementVector | undefined;
  let evaporatedH = 0;
  let waterConsumed = 0;
  let usedTier: TemperatureTier = 0;

  if (op === 'grind') {
    product = cloneVector(a.composition);
    phase = higherPhase(a.phase, 'ground');
  } else if (op === 'wash') {
    if (!((options.waterAvailable ?? 0) >= WASH_WATER)) throw new RangeError('applyChemOperator: wash requiere agua >= 0.02');
    const c = a.composition;
    const lostS = c.S * 0.65, lostH = c.H * 0.5;
    byproduct = { ...emptyVector(), S: lostS, H: lostH };
    product = { ...cloneVector(c), S: c.S - lostS, H: c.H - lostH };
    phase = higherPhase(a.phase, 'washed');
    waterConsumed = WASH_WATER;
  } else if (op === 'heat') {
    if (tier < 1) throw new RangeError('applyChemOperator: heat requiere temperatureTier >= 1');
    usedTier = tier;
    const charge = options.b ? addVectors(a.composition, options.b.composition) : cloneVector(a.composition);
    // La riqueza metálica es de la mena (`a`); el carbono reductor y el fundente, de la carga completa.
    // Con un solo lote ambas lecturas coinciden.
    const n = normalizeVector(charge);
    const ore = normalizeVector(a.composition);
    const parentPhase = options.b ? higherPhase(a.phase, options.b.phase) : a.phase;
    evaporatedH = charge.H * (tier === 2 ? 0.98 : 0.85);
    product = { ...charge, H: charge.H - evaporatedH };
    let formed: ThermalPhase = 'fired';
    if (tier === 2) {
      if (ore.Fe >= 0.22 && n.C >= 0.12) {
        // Reducción carbotérmica: el carbono reduce la mena; parte del Si sale como escoria y parte del C como gas.
        const slagSi = charge.Si * 0.55, exhaustC = charge.C * 0.40;
        byproduct = { ...emptyVector(), Si: slagSi, C: exhaustC };
        product.Si = charge.Si - slagSi; product.C = charge.C - exhaustC;
        formed = 'smelted';
      } else if (n.Si >= 0.35 && n.S >= 0.16) {
        formed = 'vitrified'; // vitrificación: el S actúa de fundente de la sílice
      }
    }
    // En T1 la carbonización (C dominante), la sinterización (Si+Ca) y el secado mineral comparten la fase
    // 'fired'; sus propiedades se separan solas por la composición restante (sin recetas).
    phase = higherPhase(parentPhase, formed);
  } else if (op === 'bind') {
    if (!options.b) throw new RangeError('applyChemOperator: bind requiere un segundo lote b');
    product = addVectors(a.composition, options.b.composition);
    phase = higherPhase(a.phase, options.b.phase);
  } else {
    throw new RangeError(`applyChemOperator: operador desconocido ${String(op)}`);
  }

  const tierOut: TemperatureTier = Math.max(usedTier, PHASE_TIER[phase]) as TemperatureTier;
  state.byOperator[op]++;
  if (op === 'heat' && usedTier > state.maxTemperatureTier) state.maxTemperatureTier = usedTier;
  const { formula, isNew } = registerFormula(state, product, phase, op, tierOut, options.tick ?? 0, options.actorId ?? null);
  const lot = makeLot(state, formula.id, product, phase);
  return { product: lot, ...(byproduct ? { byproduct } : {}), evaporatedH, waterConsumed, temperatureTier: tierOut, formula, isNew };
}

// ---------------------------------------------------------------------------------------------
// Hornos y experimentación autónoma

export interface ChemStructureLike {
  components: readonly string[];
  condition: number;
  installed?: readonly { insulation: number }[];
  storedCompounds?: readonly CompoundLot[];
}

function hasFuel(lots: readonly CompoundLot[] | undefined): boolean {
  return !!lots && lots.some(l => l.mass > 0 && l.properties.fuelPower >= KILN_FUEL_POWER);
}

/** Nivel térmico alcanzable: 0 sin hogar, 1 con hogar funcional, 2 con horno aislado + combustible denso. */
export function availableKilnTier(person: { compounds?: readonly CompoundLot[] }, nearbyStructures: readonly ChemStructureLike[]): TemperatureTier {
  let tier: TemperatureTier = 0;
  const personFuel = hasFuel(person.compounds);
  for (const s of nearbyStructures) {
    if (!(s.condition > WORKING_CONDITION)) continue;
    let hearths = 0, frames = 0, roof = false;
    for (const c of s.components) {
      if (c === 'hearth') hearths++; else if (c === 'frame') frames++; else if (c === 'roof') roof = true;
    }
    if (hearths === 0) continue;
    tier = 1;
    if (!roof || !(personFuel || hasFuel(s.storedCompounds))) continue;
    let insulation = 0;
    for (const item of s.installed ?? []) if (Number.isFinite(item.insulation) && item.insulation > 0) insulation += item.insulation;
    if (insulation >= 0.35 || frames >= 2 || hearths >= 2) return 2;
  }
  return tier;
}

function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

function mix32(a: number, b: number): number {
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be59b, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}

/** Dos números en [0, 1) puros a partir de `(semilla, paso, id)`. */
function experimentDraws(seed: number, tick: number, id: string): [number, number] {
  const h = mix32(mix32(seed | 0, tick | 0), hashString(id));
  return [h / 0x100000000, mix32(h, 0x5bd1e995) / 0x100000000];
}

/** Utilidad física de un lote (para elegir qué aglomerar cuando el inventario se desborda). */
function lotUtility(lot: CompoundLot): number {
  const p = lot.properties;
  return Math.max(p.hardness * p.toughness, p.seal, p.insulation, p.fuelPower) + PHASE_RANK[lot.phase] * 0.05;
}

const isFuel = (lot: CompoundLot): boolean => lot.properties.fuelPower >= KILN_FUEL_POWER;
const ORGANIC_FEATURES = new Set(['tree', 'pine', 'palm', 'stump', 'reeds', 'berries', 'flowers', 'cactus']);

export interface ChemExperimentStructure extends ChemStructureLike { water: number }

export interface ChemExperimentResult {
  lot: CompoundLot;
  formula: ChemicalFormulaView;
  isNew: boolean;
  operator: ChemOperator;
  temperatureTier: TemperatureTier;
  waterUsed: number;
  /** Masa nueva entrada al sistema químico desde una unidad real de madera/piedra (0 si se procesó un lote). */
  extractedMass: number;
  /** Masa salida del sistema (escoria, gas, sales lavadas) — conserva el balance del experimento. */
  byproduct?: ElementVector;
  evaporatedH: number;
}

interface Plan { op: ChemOperator | 'extract'; a: number; b?: number; tier: TemperatureTier; score: number }

/**
 * Un experimento químico autónomo de un habitante. Paga coste real (procesa un lote que lleva o debita
 * 1 madera/piedra), es determinista por `(semilla, paso, id)` y no toca `world.rng`. Devuelve `null` si
 * la química está apagada o no hay nada que hacer.
 */
export function performChemistryExperiment(
  world: { seed: number; tick: number; chemistry?: ChemistryState; params?: { quimica?: { emergente?: boolean } } },
  person: { id: string; x: number; y: number; materials: { wood: number; stone: number }; compounds?: CompoundLot[]; skills?: Record<string, number> },
  tile: { x: number; y: number; biome?: string; feature?: string; wood?: number; stone?: number; drinkingWater?: number },
  nearbyStructures: readonly ChemExperimentStructure[],
): ChemExperimentResult | null {
  // Un mundo con `quimica.emergente` explícitamente apagado nunca gana estado; sin params, decide el llamador.
  if (!world.chemistry && world.params !== undefined && world.params.quimica?.emergente !== true) return null;
  const state = world.chemistry ?? (world.chemistry = defaultChemistryState());
  const lots = person.compounds ?? [];
  const tier = availableKilnTier(person, nearbyStructures);

  // Fuente de agua real: la cisterna funcional con más agua, si no el agua potable de la tesela.
  let waterSource: ChemExperimentStructure | undefined;
  for (const s of nearbyStructures) {
    if (s.condition > WORKING_CONDITION && s.water >= WASH_WATER && (!waterSource || s.water > waterSource.water)) waterSource = s;
  }
  const waterAvailable = waterSource ? waterSource.water : Math.max(0, tile.drinkingWater ?? 0);

  const plans: Plan[] = [];
  for (let i = 0; i < lots.length; i++) {
    const lot = lots[i]!;
    const n = normalizeVector(lot.composition);
    const rank = PHASE_RANK[lot.phase];
    if (tier === 2 && rank < PHASE_RANK.smelted && !isFuel(lot)) {
      for (let j = 0; j < lots.length; j++) {
        if (j === i || !isFuel(lots[j]!)) continue;
        const m = normalizeVector(addVectors(lot.composition, lots[j]!.composition));
        if (n.Fe >= 0.22 && m.C >= 0.12) plans.push({ op: 'heat', a: i, b: j, tier: 2, score: 1 });
      }
      if (rank < PHASE_RANK.vitrified && n.Si >= 0.35 && n.S >= 0.16 && n.Fe < 0.22) plans.push({ op: 'heat', a: i, tier: 2, score: 0.9 });
    }
    if (tier >= 1 && rank < PHASE_RANK.fired) {
      const wantFuel = n.C >= 0.45 && !lots.some(isFuel);
      plans.push({ op: 'heat', a: i, tier: wantFuel ? 1 : tier, score: wantFuel ? 0.85 : 0.6 });
    }
    if (rank < PHASE_RANK.washed && waterAvailable >= WASH_WATER && n.S + n.H >= 0.2) plans.push({ op: 'wash', a: i, tier: 0, score: 0.45 });
    if (lot.phase === 'raw') plans.push({ op: 'grind', a: i, tier: 0, score: 0.3 });
    if (rank >= PHASE_RANK.fired && !isFuel(lot)) {
      for (let j = i + 1; j < lots.length; j++) {
        const other = lots[j]!;
        if (PHASE_RANK[other.phase] >= PHASE_RANK.fired && !isFuel(other)) plans.push({ op: 'bind', a: i, b: j, tier: 0, score: 0.5 });
      }
    }
  }
  const canExtract = lots.length < MAX_PERSON_COMPOUNDS && (person.materials.wood >= 1 || person.materials.stone >= 1);
  if (canExtract) plans.push({ op: 'extract', a: -1, tier: 0, score: lots.length < 2 ? 0.7 : 0.4 });
  if (plans.length === 0) return null;

  const [r1, r2] = experimentDraws(world.seed, world.tick, person.id);
  const craft = Math.max(0, Math.min(1, person.skills?.craft ?? 0));
  const explore = 0.25 * (1 - craft * 0.6);
  let plan: Plan;
  if (r1 < explore) plan = plans[Math.min(plans.length - 1, Math.floor(r2 * plans.length))]!;
  else { plan = plans[0]!; for (const p of plans) if (p.score > plan.score) plan = p; }

  const common = { tick: world.tick, actorId: person.id };
  let result: ChemOperatorResult;
  let extractedMass = 0;
  let consumed: number[] = [];
  if (plan.op === 'extract') {
    const woodFirst = person.materials.wood >= 1 && (person.materials.stone < 1
      || (ORGANIC_FEATURES.has(tile.feature ?? '') ? r2 < 0.75 : (tile.stone ?? 0) > 0 ? r2 < 0.25 : r2 < 0.5));
    let feature: string | undefined;
    if (woodFirst) { person.materials.wood -= 1; feature = ORGANIC_FEATURES.has(tile.feature ?? '') ? tile.feature : 'tree'; }
    else { person.materials.stone -= 1; feature = tile.feature === 'rock' || tile.feature === 'clay' ? tile.feature : 'rock'; }
    const raw = extractGeologyLot(world.seed, tile.x, tile.y, tile.biome, feature, EXTRACTION_MASS, state);
    extractedMass = raw.mass;
    result = applyChemOperator('grind', raw, { temperatureTier: 0, ...common }, state);
  } else {
    const a = lots[plan.a]!;
    const b = plan.b !== undefined ? lots[plan.b] : undefined;
    result = applyChemOperator(plan.op, a, { temperatureTier: plan.tier, waterAvailable, ...(b ? { b } : {}), ...common }, state);
    consumed = plan.b !== undefined ? [plan.a, plan.b] : [plan.a];
    if (result.waterConsumed > 0) {
      if (waterSource) waterSource.water = Math.max(0, waterSource.water - result.waterConsumed);
      else tile.drinkingWater = Math.max(0, (tile.drinkingWater ?? 0) - result.waterConsumed);
    }
  }

  const next = lots.filter((_, index) => !consumed.includes(index));
  next.push(result.product);
  let byproduct = result.byproduct;
  let evaporatedH = result.evaporatedH;
  // Inventario acotado: aglomerar los dos lotes de menor utilidad (bind conserva toda la masa).
  while (next.length > MAX_PERSON_COMPOUNDS) {
    const order = next.map((lot, index) => ({ index, u: lotUtility(lot) }))
      .filter(entry => next[entry.index] !== result.product)
      .sort((x, y) => x.u - y.u || x.index - y.index);
    const [low, second] = [order[0]!, order[1]!];
    const merged = applyChemOperator('bind', next[low.index]!, { b: next[second.index]!, temperatureTier: 0, ...common }, state);
    const keep = next.filter((_, index) => index !== low.index && index !== second.index);
    keep.push(merged.product);
    next.length = 0; next.push(...keep);
    if (merged.byproduct) byproduct = byproduct ? addVectors(byproduct, merged.byproduct) : merged.byproduct;
    evaporatedH += merged.evaporatedH;
  }
  person.compounds = next;

  return {
    lot: result.product, formula: result.formula, isNew: result.isNew, operator: plan.op === 'extract' ? 'grind' : plan.op,
    temperatureTier: result.temperatureTier, waterUsed: result.waterConsumed, extractedMass,
    ...(byproduct ? { byproduct } : {}), evaporatedH,
  };
}

// ---------------------------------------------------------------------------------------------
// Acoplamiento con estructuras, herramientas y proyección

function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return [128, 128, 128];
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

function toHex(rgb: readonly number[]): string {
  return `#${rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/** Mezcla las propiedades reales de un lote depositado/instalado en el perfil material de una estructura. */
export function blendMaterialProfile(current: StructureMaterialProfile | undefined, lot: CompoundLot, weight = 0.25): StructureMaterialProfile {
  const p = lot.properties;
  const incoming = { strength: (p.hardness + p.toughness) / 2, insulation: p.insulation, seal: p.seal };
  if (!current) return { strength: round3(incoming.strength), insulation: round3(incoming.insulation), seal: round3(incoming.seal), tint: p.colorHex };
  const w = clamp01(weight);
  const lerp = (x: number, y: number): number => round3(clamp01(x) * (1 - w) + y * w);
  const from = parseHex(current.tint), to = parseHex(p.colorHex);
  return {
    strength: lerp(current.strength, incoming.strength),
    insulation: lerp(current.insulation, incoming.insulation),
    seal: lerp(current.seal, incoming.seal),
    tint: toHex(from.map((c, i) => c * (1 - w) + to[i]! * w)),
  };
}

/** Bono físico [0, 0.45] del mejor lote que se lleva para una capacidad. */
export function compoundToolBonus(compounds: readonly CompoundLot[] | undefined, capability: 'cutting' | 'abrasion' | 'containment' | 'insulation'): number {
  if (!compounds || compounds.length === 0) return 0;
  let best = 0;
  for (const lot of compounds) {
    if (!(lot.mass >= 0.05)) continue;
    const p = lot.properties;
    const score = capability === 'cutting' ? p.hardness * p.toughness
      : capability === 'abrasion' ? p.hardness * (0.6 + 0.4 * p.toughness)
        : capability === 'containment' ? p.seal : p.insulation;
    if (score > best) best = score;
  }
  return round3(0.45 * clamp01((best - 0.15) / 0.7));
}

/** Resumen para `WorldView.chemistry`: las fórmulas más avanzadas/usadas (acotadas) y los totales. */
export function projectChemistry(
  state: ChemistryState | undefined,
  people: readonly { compounds?: readonly CompoundLot[] }[],
  structures: readonly { storedCompounds?: readonly CompoundLot[] }[],
): ChemistrySummaryView | undefined {
  if (!state) return undefined;
  let totalLots = 0;
  for (const p of people) totalLots += p.compounds?.length ?? 0;
  for (const s of structures) totalLots += s.storedCompounds?.length ?? 0;
  const formulas = [...state.formulas]
    .sort((a, b) => PHASE_RANK[b.phase] - PHASE_RANK[a.phase] || b.uses - a.uses || a.discoveredAt - b.discoveredAt || (a.id < b.id ? -1 : 1))
    .slice(0, PROJECTED_FORMULAS)
    .map(f => ({ ...f, composition: cloneVector(f.composition), properties: { ...f.properties } }));
  return { formulas, totalFormulas: state.formulas.length, totalLots, maxTemperatureTier: state.maxTemperatureTier, byOperator: { ...state.byOperator } };
}

// ---------------------------------------------------------------------------------------------
// Validación estricta

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finiteNonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const nonNegativeInteger = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function assertVector(v: unknown, label: string): asserts v is ElementVector {
  if (!isRecord(v)) throw new TypeError(`${label}: vector elemental ausente`);
  const keys = Object.keys(v);
  if (keys.length !== ELEMENTS.length || !ELEMENTS.every(e => keys.includes(e))) throw new TypeError(`${label}: claves elementales inválidas`);
  for (const e of ELEMENTS) if (!finiteNonNegative(v[e])) throw new RangeError(`${label}.${e}: debe ser finito y no negativo`);
}

function assertProperties(v: unknown, label: string): void {
  if (!isRecord(v)) throw new TypeError(`${label}: propiedades ausentes`);
  for (const key of ['hardness', 'toughness', 'seal', 'insulation', 'fuelPower'] as const) {
    const x = v[key];
    if (!finiteNonNegative(x) || x > 1) throw new RangeError(`${label}.${key}: debe estar en [0, 1]`);
  }
  if (typeof v.colorHex !== 'string' || !/^#[0-9a-f]{6}$/i.test(v.colorHex)) throw new TypeError(`${label}.colorHex inválido`);
}

const isPhase = (v: unknown): v is ThermalPhase => typeof v === 'string' && (PHASES as readonly string[]).includes(v);
const isTier = (v: unknown): v is TemperatureTier => v === 0 || v === 1 || v === 2;

export function assertCompoundLots(lots: unknown): void {
  if (lots === undefined) return;
  if (!Array.isArray(lots)) throw new TypeError('compounds: debe ser un arreglo');
  const ids = new Set<string>();
  lots.forEach((lot: unknown, index) => {
    const label = `compounds[${index}]`;
    if (!isRecord(lot)) throw new TypeError(`${label}: lote inválido`);
    if (typeof lot.id !== 'string' || lot.id.length === 0) throw new TypeError(`${label}.id inválido`);
    if (ids.has(lot.id)) throw new RangeError(`${label}.id duplicado ${lot.id}`);
    ids.add(lot.id);
    if (typeof lot.formulaId !== 'string' || lot.formulaId.length === 0) throw new TypeError(`${label}.formulaId inválido`);
    assertVector(lot.composition, `${label}.composition`);
    if (!isPhase(lot.phase)) throw new TypeError(`${label}.phase inválida`);
    if (!finiteNonNegative(lot.mass)) throw new RangeError(`${label}.mass: debe ser finita y no negativa`);
    const total = vectorMass(lot.composition);
    if (Math.abs(total - lot.mass) > MASS_TOLERANCE * Math.max(1, lot.mass)) throw new RangeError(`${label}.mass no coincide con su composición`);
    assertProperties(lot.properties, `${label}.properties`);
  });
}

export function assertChemistryState(state: unknown, tick: number): void {
  if (!isRecord(state)) throw new TypeError('chemistry: estado ausente');
  const { formulas, formulaCounter, lotCounter, byOperator, maxTemperatureTier } = state;
  if (!Array.isArray(formulas) || formulas.length > MAX_FORMULAS) throw new RangeError('chemistry.formulas: arreglo inválido o sobre el tope');
  if (!nonNegativeInteger(formulaCounter) || formulaCounter < formulas.length) throw new RangeError('chemistry.formulaCounter inválido');
  if (!nonNegativeInteger(lotCounter)) throw new RangeError('chemistry.lotCounter inválido');
  if (!isRecord(byOperator) || Object.keys(byOperator).length !== OPERATORS.length || !OPERATORS.every(op => nonNegativeInteger(byOperator[op]))) {
    throw new RangeError('chemistry.byOperator inválido');
  }
  if (!isTier(maxTemperatureTier)) throw new RangeError('chemistry.maxTemperatureTier inválido');
  const ids = new Set<string>(), signatures = new Set<string>();
  formulas.forEach((f: unknown, index) => {
    const label = `chemistry.formulas[${index}]`;
    if (!isRecord(f)) throw new TypeError(`${label}: fórmula inválida`);
    if (typeof f.id !== 'string' || f.id.length === 0 || ids.has(f.id)) throw new RangeError(`${label}.id inválido o duplicado`);
    if (typeof f.signature !== 'string' || f.signature.length === 0 || signatures.has(f.signature)) throw new RangeError(`${label}.signature inválida o duplicada`);
    ids.add(f.id); signatures.add(f.signature);
    if (typeof f.name !== 'string' || f.name.length === 0) throw new TypeError(`${label}.name inválido`);
    assertVector(f.composition, `${label}.composition`);
    if (!isPhase(f.phase) || !f.signature.startsWith(`${f.phase}:`)) throw new TypeError(`${label}.phase inválida`);
    if (!isTier(f.temperatureTier)) throw new RangeError(`${label}.temperatureTier inválido`);
    if (typeof f.operator !== 'string' || !(OPERATORS as readonly string[]).includes(f.operator)) throw new TypeError(`${label}.operator inválido`);
    if (!nonNegativeInteger(f.discoveredAt) || f.discoveredAt > tick) throw new RangeError(`${label}.discoveredAt fuera de [0, ${tick}]`);
    if (f.discovererId !== null && typeof f.discovererId !== 'string') throw new TypeError(`${label}.discovererId inválido`);
    if (!nonNegativeInteger(f.uses)) throw new RangeError(`${label}.uses inválido`);
    assertProperties(f.properties, `${label}.properties`);
  });
}
