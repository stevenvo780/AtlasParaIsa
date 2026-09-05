import type { MaterialBatch, MaterialProperties } from '../shared/technology.js';

/** Existing technology extraction uses 50 material mass units per normalized
 * drinking-water unit. Free contents are additional mass, never composition. */
export const WATER_QUANTA_PER_UNIT = 50_000;
export const MAX_WATER_STEP_TICKS = 2400;

/** Proposed simulation coefficients, not empirically calibrated material laws.
 * Persist the policy version with contents/receipts when integrating the kernel. */
export interface WaterInteractionPolicy {
  version: 1;
  fixedPointDenominator: number;
  capacityPerSolidMass: number;
  leakagePerTickNumerator: number;
  flowQuantaPerTick: number;
  quantaPerWork: number;
}
export const DEFAULT_WATER_POLICY: Readonly<WaterInteractionPolicy> = Object.freeze({
  version: 1, fixedPointDenominator: 1_000_000, capacityPerSolidMass: 8,
  leakagePerTickNumerator: 1000, flowQuantaPerTick: 250, quantaPerWork: 250,
});

export type PhysicalMaterialBatch = Pick<MaterialBatch, 'mass' | 'initialMass' | 'composition' | 'properties'>;
export interface WaterContents { water: number; leakRemainder: number; }
export interface ContainerAffordance {
  capacityQuanta: number;
  leakageNumerator: number;
  structuralMass: number;
  solidMass: number;
}
export interface WaterFlowState {
  sourceWater: number;
  destinationWater: number;
  destinationCapacity: number;
  requestedQuanta: number;
  carryFreeQuanta: number;
  elapsedTicks: number;
  workAvailable: number;
}
export interface QuantizedWaterFlow {
  sourceWater: number;
  destinationWater: number;
  movedQuanta: number;
  sourceDelta: number;
  destinationDelta: number;
  workSpent: number;
  workRemaining: number;
}
export interface WaterLeak {
  contents: WaterContents;
  leakedQuanta: number;
}
export interface WaterOverflow {
  contents: WaterContents;
  sinkWater: number;
  returnedQuanta: number;
  environmentalLossQuanta: number;
  containerDelta: number;
  sinkDelta: number;
}

function fail(label: string): never { throw new RangeError(`Invalid water physics: ${label}`); }
function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(label);
}
function safeNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail(label);
  return Number(value);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function assertPolicy(policy: Readonly<WaterInteractionPolicy>): void {
  if (!object(policy) || policy.version !== 1) fail('policy version');
  integer(policy.fixedPointDenominator, 'fixed-point denominator', 1);
  integer(policy.capacityPerSolidMass, 'capacity multiplier');
  integer(policy.leakagePerTickNumerator, 'leak coefficient', 0, policy.fixedPointDenominator);
  integer(policy.flowQuantaPerTick, 'flow rate');
  integer(policy.quantaPerWork, 'quanta per work', 1);
}
function assertPhysicalBatch(batch: PhysicalMaterialBatch): void {
  if (!object(batch) || !object(batch.composition) || Object.keys(batch.composition).length !== 3 || !object(batch.properties)) fail('material batch');
  integer(batch.mass, 'structural mass');
  integer(batch.initialMass, 'initial structural mass', 1);
  if (batch.mass > batch.initialMass) fail('mass exceeds initial mass');
  for (const material of ['wood', 'stone', 'water'] as const) integer(batch.composition[material], 'composition');
  const total = BigInt(batch.composition.wood) + BigInt(batch.composition.stone) + BigInt(batch.composition.water);
  if (total !== BigInt(batch.mass)) fail('composition differs from structural mass');
  const properties: (keyof MaterialProperties)[] = ['hardness', 'toughness', 'porosity', 'flexibility', 'edge', 'containment',
    'insulation', 'leverage', 'cohesion', 'temperature', 'alignment', 'firing'];
  for (const key of properties) {
    const value = batch.properties[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail('material property');
  }
}
export function assertWaterContents(value: unknown, denominator = DEFAULT_WATER_POLICY.fixedPointDenominator): asserts value is WaterContents {
  integer(denominator, 'fixed-point denominator', 1);
  if (!object(value)) fail('contents');
  integer(value.water, 'contents water');
  integer(value.leakRemainder, 'leak remainder', 0, denominator - 1);
  if (value.water === 0 && value.leakRemainder !== 0) fail('empty contents have a leak remainder');
}

/** Form acts through the existing, paid containment property; recipe names,
 * identities and generation never cause capacity. Structural water is not fill.
 * Floating properties are first floored onto the policy's fixed-point grid. */
export function containerAffordance(batch: PhysicalMaterialBatch, policy: Readonly<WaterInteractionPolicy> = DEFAULT_WATER_POLICY): ContainerAffordance {
  assertPolicy(policy); assertPhysicalBatch(batch);
  const d = BigInt(policy.fixedPointDenominator);
  const fixed = (value: number): bigint => BigInt(Math.floor(value * policy.fixedPointDenominator));
  const p = batch.properties, solidMass = batch.mass - batch.composition.water;
  const containment = fixed(p.containment), cohesion = fixed(p.cohesion), porosity = fixed(p.porosity);
  const capacity = BigInt(policy.capacityPerSolidMass) * BigInt(solidMass) * containment * cohesion * (d - porosity) / (d * d * d);
  const integrity = BigInt(batch.mass) * d / BigInt(batch.initialMass);
  const defects = porosity + (d - cohesion) + (d - integrity);
  const leakage = BigInt(policy.leakagePerTickNumerator) * (defects > d ? d : defects) / d;
  return { capacityQuanta: safeNumber(capacity, 'capacity exceeds safe integer'), leakageNumerator: Number(leakage),
    structuralMass: batch.mass, solidMass };
}

/** Payload adds to structural mass; it never changes composition or initialMass. */
export function carriedMassQuanta(batch: PhysicalMaterialBatch, contents: WaterContents, policy: Readonly<WaterInteractionPolicy> = DEFAULT_WATER_POLICY): number {
  assertPolicy(policy); assertPhysicalBatch(batch); assertWaterContents(contents, policy.fixedPointDenominator);
  return safeNumber(BigInt(batch.mass) + BigInt(contents.water), 'carried mass exceeds safe integer');
}

/** Two distinct reservoirs, already localized by the caller. Positive movement
 * requires both elapsed time and a finite work budget. Apply workSpent once;
 * body energy, ownership, reach and action eligibility remain caller duties.
 * No utility is awarded for filling, carrying, empty flow, or this prediction. */
export function flowQuantized(state: Readonly<WaterFlowState>, policy: Readonly<WaterInteractionPolicy> = DEFAULT_WATER_POLICY): QuantizedWaterFlow {
  assertPolicy(policy);
  if (!object(state)) fail('flow state');
  for (const key of ['sourceWater', 'destinationWater', 'destinationCapacity', 'requestedQuanta', 'carryFreeQuanta', 'workAvailable'] as const) integer(state[key], key);
  integer(state.elapsedTicks, 'elapsed ticks', 0, MAX_WATER_STEP_TICKS);
  if (state.destinationWater > state.destinationCapacity) fail('destination requires overflow settlement');
  const limits = [BigInt(state.sourceWater), BigInt(state.destinationCapacity - state.destinationWater), BigInt(state.requestedQuanta),
    BigInt(state.carryFreeQuanta), BigInt(policy.flowQuantaPerTick) * BigInt(state.elapsedTicks), BigInt(policy.quantaPerWork) * BigInt(state.workAvailable)];
  const q = limits.reduce((minimum, value) => value < minimum ? value : minimum);
  const moved = Number(q), perWork = BigInt(policy.quantaPerWork);
  const spent = safeNumber((q + perWork - 1n) / perWork, 'work exceeds safe integer');
  return { sourceWater: state.sourceWater - moved, destinationWater: state.destinationWater + moved,
    movedQuanta: moved, sourceDelta: moved === 0 ? 0 : -moved, destinationDelta: moved, workSpent: spent, workRemaining: state.workAvailable - spent };
}

/** One tick: z=water*numerator+remainder; lose floor(z/D), carry z mod D.
 * Repeating this recurrence preserves subdivision parity; a closed-form dt
 * multiplier would change the result as stock falls. Leakage needs a local sink
 * or an explicit environmental export in the caller's ledger. */
export function leakIntegerRemainder(contents: Readonly<WaterContents>, numerator: number,
  denominator = DEFAULT_WATER_POLICY.fixedPointDenominator, dt = 1): WaterLeak {
  assertWaterContents(contents, denominator); integer(numerator, 'leak numerator', 0, denominator);
  integer(dt, 'elapsed ticks', 0, MAX_WATER_STEP_TICKS);
  const d = BigInt(denominator), n = BigInt(numerator);
  let water = BigInt(contents.water), remainder = BigInt(contents.leakRemainder);
  for (let tick = 0; tick < dt && water > 0n; tick++) {
    const z = water * n + remainder;
    water -= z / d;
    remainder = water === 0n ? 0n : z % d;
  }
  return { contents: { water: Number(water), leakRemainder: Number(remainder) }, leakedQuanta: contents.water - Number(water) };
}

/** Capacity loss from wear or destruction must settle every excess quantum.
 * Bounded local sinks take what fits; the remainder is an explicit environmental
 * export, not silently clamped stock or manufactured hydration. */
export function capacityOverflowReturns(contents: Readonly<WaterContents>, capacityQuanta: number, sinkWater: number,
  sinkCapacity: number, denominator = DEFAULT_WATER_POLICY.fixedPointDenominator): WaterOverflow {
  assertWaterContents(contents, denominator);
  integer(capacityQuanta, 'capacity'); integer(sinkWater, 'sink water'); integer(sinkCapacity, 'sink capacity');
  if (sinkWater > sinkCapacity) fail('sink requires overflow settlement');
  const overflow = Math.max(0, contents.water - capacityQuanta), returned = Math.min(overflow, sinkCapacity - sinkWater);
  const water = contents.water - overflow;
  return { contents: { water, leakRemainder: water === 0 ? 0 : contents.leakRemainder }, sinkWater: sinkWater + returned,
    returnedQuanta: returned, environmentalLossQuanta: overflow - returned, containerDelta: overflow === 0 ? 0 : -overflow, sinkDelta: returned };
}
