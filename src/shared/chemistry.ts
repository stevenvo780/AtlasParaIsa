/**
 * V20 — Química algebraica conservada de 6 especies elementales, geología latente determinista
 * y tipos compartidos de materiales/sinergia de estructuras (servidor + cliente, cero estado extra por tesela).
 */

export const ELEMENTS = ['C', 'Si', 'Ca', 'Fe', 'S', 'H'] as const;
export type ElementSymbol = typeof ELEMENTS[number];
export type ElementVector = Record<ElementSymbol, number>;
export type ThermalPhase = 'raw' | 'ground' | 'washed' | 'fired' | 'smelted' | 'vitrified';
export type ChemOperator = 'grind' | 'wash' | 'heat' | 'bind';

export interface MaterialProperties {
  hardness: number;
  toughness: number;
  seal: number;
  insulation: number;
  fuelPower: number;
  colorHex: string;
}

export interface CompoundLot {
  id: string;
  formulaId: string;
  composition: ElementVector;
  phase: ThermalPhase;
  mass: number;
  properties: MaterialProperties;
}

export interface ChemicalFormulaView {
  id: string;
  signature: string;
  name: string;
  composition: ElementVector;
  phase: ThermalPhase;
  temperatureTier: 0 | 1 | 2;
  operator: ChemOperator;
  discoveredAt: number;
  discovererId: string | null;
  uses: number;
  properties: MaterialProperties;
}

export interface ChemistrySummaryView {
  formulas: ChemicalFormulaView[];
  totalFormulas: number;
  totalLots: number;
  maxTemperatureTier: 0 | 1 | 2;
  byOperator: Record<ChemOperator, number>;
}

export interface StructureMaterialProfile {
  strength: number;
  insulation: number;
  seal: number;
  tint: string;
}

export interface StructureSynergyView {
  sharedEdges: number;
  heated: boolean;
  irrigated: boolean;
  workshopBonus: number;
  kilnTier?: 0 | 1 | 2;
}

export function emptyVector(): ElementVector {
  return { C: 0, Si: 0, Ca: 0, Fe: 0, S: 0, H: 0 };
}

export function vectorMass(v: ElementVector): number {
  return v.C + v.Si + v.Ca + v.Fe + v.S + v.H;
}

export function normalizeVector(v: ElementVector): ElementVector {
  const total = vectorMass(v);
  if (!(total > 0)) return emptyVector();
  return {
    C: v.C / total,
    Si: v.Si / total,
    Ca: v.Ca / total,
    Fe: v.Fe / total,
    S: v.S / total,
    H: v.H / total,
  };
}

function hashCoord(seed: number, x: number, y: number, salt: number): number {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(x | 0, 0x85ebca6b) ^ Math.imul(y | 0, 0xc2b2ae35) ^ Math.imul(salt | 0, 0x27d4eb2f)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 0x100000000;
}

/** Smooth coarse geological basin noise (24-cell strata + local pocket) — pure, deterministic, zero memory per tile. */
function strataNoise(seed: number, x: number, y: number, salt: number, scale = 24): number {
  const gx = Math.floor(x / scale), gy = Math.floor(y / scale);
  const fx = (x - gx * scale) / scale, fy = (y - gy * scale) / scale;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hashCoord(seed, gx, gy, salt), b = hashCoord(seed, gx + 1, gy, salt);
  const c = hashCoord(seed, gx, gy + 1, salt), d = hashCoord(seed, gx + 1, gy + 1, salt);
  const coarse = (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  const fine = hashCoord(seed, x, y, salt + 17);
  return coarse * 0.72 + fine * 0.28;
}

/**
 * Latent deterministic tile geology (normalized 6-element signature summing to 1.0).
 * Server and client compute the exact same composition without sending per-tile mineral fields over the wire.
 */
export function geologyAt(seed: number, x: number, y: number, biome?: string, feature?: string): ElementVector {
  const raw = emptyVector();
  // Biome geological base
  if (biome === 'mountain') {
    raw.Si = 0.44; raw.Fe = 0.22; raw.Ca = 0.16; raw.S = 0.10; raw.C = 0.04; raw.H = 0.04;
  } else if (biome === 'wetland') {
    raw.Si = 0.26; raw.Ca = 0.28; raw.H = 0.24; raw.C = 0.14; raw.S = 0.05; raw.Fe = 0.03;
  } else if (biome === 'forest') {
    raw.C = 0.42; raw.Si = 0.22; raw.H = 0.16; raw.Ca = 0.11; raw.Fe = 0.05; raw.S = 0.04;
  } else if (biome === 'desert') {
    raw.Si = 0.48; raw.S = 0.24; raw.Ca = 0.16; raw.Fe = 0.08; raw.C = 0.02; raw.H = 0.02;
  } else if (biome === 'ocean') {
    raw.H = 0.62; raw.S = 0.22; raw.Ca = 0.08; raw.Si = 0.05; raw.C = 0.02; raw.Fe = 0.01;
  } else {
    // grassland / default
    raw.Si = 0.30; raw.C = 0.26; raw.Ca = 0.20; raw.H = 0.12; raw.Fe = 0.07; raw.S = 0.05;
  }
  // Surface feature enrichment
  if (feature === 'rock') { raw.Si += 0.28; raw.Fe += 0.24; raw.Ca += 0.12; }
  else if (feature === 'clay') { raw.Ca += 0.32; raw.Si += 0.24; raw.H += 0.16; }
  else if (feature === 'tree' || feature === 'pine' || feature === 'palm' || feature === 'stump') { raw.C += 0.42; raw.H += 0.08; }
  else if (feature === 'spring' || feature === 'pool') { raw.H += 0.34; raw.S += 0.18; raw.Ca += 0.10; }
  else if (feature === 'reeds' || feature === 'berries' || feature === 'flowers') { raw.C += 0.24; raw.H += 0.14; }
  else if (feature === 'cactus') { raw.H += 0.22; raw.C += 0.18; raw.S += 0.12; }
  // Regional mineral veins (deterministic strata pockets so mountains/regions have real ore/salt/lime veins)
  const feVein = strataNoise(seed, x, y, 101, 20);
  const caVein = strataNoise(seed, x, y, 202, 24);
  const sVein = strataNoise(seed, x, y, 303, 22);
  if (feVein > 0.62) raw.Fe += (feVein - 0.62) * 1.45;
  if (caVein > 0.60) raw.Ca += (caVein - 0.60) * 1.15;
  if (sVein > 0.64) raw.S += (sVein - 0.64) * 1.25;
  return normalizeVector(raw);
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

/** Deterministic continuous material properties derived strictly from elemental vector + thermal phase. */
export function evaluateMaterialProperties(composition: ElementVector, phase: ThermalPhase): MaterialProperties {
  const n = normalizeVector(composition);
  const phaseHard = phase === 'smelted' ? 0.42 : phase === 'vitrified' ? 0.34 : phase === 'fired' ? 0.24 : phase === 'washed' ? 0.10 : phase === 'ground' ? 0.05 : 0;
  const phaseTough = phase === 'smelted' ? 0.44 : phase === 'fired' ? 0.20 : phase === 'vitrified' ? 0.10 : phase === 'washed' ? 0.08 : 0.03;
  const phaseSeal = phase === 'vitrified' ? 0.48 : phase === 'fired' ? 0.32 : phase === 'smelted' ? 0.26 : phase === 'washed' ? 0.10 : 0.04;
  const phaseInsul = phase === 'fired' ? 0.24 : phase === 'ground' ? 0.14 : phase === 'raw' ? 0.10 : phase === 'smelted' ? 0.06 : 0.12;

  const hardness = clamp01(n.Fe * 0.85 + n.Si * 0.52 + n.Ca * 0.28 + n.C * 0.14 + phaseHard - n.H * 0.35);
  const toughness = clamp01(n.Fe * 0.78 + n.C * 0.44 + n.Ca * 0.34 + n.Si * 0.22 + phaseTough - n.S * 0.18 - n.H * 0.28);
  const seal = clamp01(n.Si * 0.46 + n.Ca * 0.44 + n.S * 0.36 + n.Fe * 0.22 + phaseSeal - n.C * 0.15 - n.H * 0.22);
  const insulation = clamp01(n.C * 0.56 + n.Ca * 0.42 + n.Si * 0.28 + phaseInsul - n.Fe * 0.28 - n.H * 0.25);
  const fuelPower = clamp01(n.C * (phase === 'fired' ? 1.35 : phase === 'raw' ? 0.72 : 0.55) - n.H * 0.65 - (n.Si + n.Fe) * 0.35);

  // Color derived continuously from dominant chemistry + thermal phase (terracotta, lime, iron-slate, charcoal, vitreous teal)
  let r = 162, g = 148, b = 124;
  r += n.Fe * 44 + n.Ca * 34 - n.C * 62 - n.S * 14;
  g += n.Ca * 26 + n.Si * 12 - n.C * 58 - n.Fe * 18 + n.S * 18;
  b += n.S * 38 + n.H * 34 + n.Si * 16 - n.C * 54 - n.Fe * 22;
  if (phase === 'fired') { r += 26; g -= 6; b -= 22; }
  else if (phase === 'smelted') { r -= 32; g -= 24; b -= 12; }
  else if (phase === 'vitrified') { r -= 18; g += 18; b += 34; }
  const hex = (v: number) => Math.max(38, Math.min(228, Math.round(v))).toString(16).padStart(2, '0');
  const colorHex = `#${hex(r)}${hex(g)}${hex(b)}`;

  return {
    hardness: Math.round(hardness * 1000) / 1000,
    toughness: Math.round(toughness * 1000) / 1000,
    seal: Math.round(seal * 1000) / 1000,
    insulation: Math.round(insulation * 1000) / 1000,
    fuelPower: Math.round(fuelPower * 1000) / 1000,
    colorHex,
  };
}
