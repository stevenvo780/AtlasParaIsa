import type { Capability, Composition, TechnologyProgram } from '../shared/technology.js';

export interface ProgramRequirements {
  readonly raw: Readonly<Composition>;
  readonly residue: Readonly<Composition>;
  readonly products: ReadonlyMap<string, number>;
  readonly fuel: number;
  readonly catalysts: readonly Capability[];
}
export type ProgramRequirementsOf = (program: TechnologyProgram) => ProgramRequirements;

/** Sólo cálculos del programa. La suma de cada material y del combustible conserva
 * el orden histórico; este resumen no contiene existencias ni resoluciones. */
export function summarizeProgramRequirements(program: TechnologyProgram): ProgramRequirements {
  const raw = { wood: 0, stone: 0, water: 0 }, residue = { wood: 0, stone: 0, water: 0 }, products = new Map<string, number>();
  for (const input of program.inputs) {
    if (input.source === 'product') products.set(input.recipeId!, (products.get(input.recipeId!) ?? 0) + input.mass);
    else (input.source === 'raw' ? raw : residue)[input.material!] += input.mass;
  }
  const fuel = program.steps.reduce((n, step) => n + (step.op === 'heat' ? step.intensity * 50 : 0), 0);
  const catalysts: Capability[] = [];
  for (const step of program.steps) if (step.requiredCatalyst) catalysts.push(step.requiredCatalyst);
  return { raw, residue, products, fuel, catalysts };
}

/** Crear por decisión, nunca conservar entre pasos ni después de una acción. */
export function createProgramRequirementsCache(): ProgramRequirementsOf {
  const summaries = new Map<TechnologyProgram, ProgramRequirements>();
  return program => {
    let summary = summaries.get(program);
    if (!summary) { summary = summarizeProgramRequirements(program); summaries.set(program, summary); }
    return summary;
  };
}

/** Existencias de UNA evaluación local sin mutaciones. El callback de masa debe
 * ser puro; esta clausura se descarta antes de enseñar, intercambiar o fabricar. */
export function localProgramAvailability(raw: Readonly<Composition>, residue: Readonly<Composition>,
  powers: Readonly<Record<Capability, number>>, productMass: (id: string) => number,
  requirementsOf: ProgramRequirementsOf = createProgramRequirementsCache()): (program: TechnologyProgram, prospectiveProductId?: string) => boolean {
  const availability = new Map<TechnologyProgram, { normal?: boolean; prospective?: Map<string, boolean> }>();
  return (program, prospectiveProductId) => {
    let cached = availability.get(program);
    const previous = prospectiveProductId === undefined ? cached?.normal : cached?.prospective?.get(prospectiveProductId);
    if (previous !== undefined) return previous;
    const required = requirementsOf(program);
    let wood = required.raw.wood;
    wood += Math.max(0, required.fuel - Math.max(0, residue.wood - required.residue.wood));
    let available = wood <= raw.wood && required.residue.wood <= residue.wood &&
      required.raw.stone <= raw.stone && required.residue.stone <= residue.stone &&
      required.raw.water <= raw.water && required.residue.water <= residue.water;
    if (available) for (const [id, needed] of required.products) {
      if (!(id === prospectiveProductId || productMass(id) >= needed)) { available = false; break; }
    }
    if (available) for (const catalyst of required.catalysts) {
      if (!(powers[catalyst] >= 0.1)) { available = false; break; }
    }
    if (!cached) { cached = {}; availability.set(program, cached); }
    if (prospectiveProductId === undefined) cached.normal = available;
    else (cached.prospective ??= new Map()).set(prospectiveProductId, available);
    return available;
  };
}

/** Misma subsecuencia de programas que recorrería `some`: un programa por id de
 * producto que pide, sin quitar programas repetidos ni cambiar su orden. */
export function prospectiveProgramsByProduct(programs: readonly TechnologyProgram[]): Map<string, TechnologyProgram[]> {
  const byProduct = new Map<string, TechnologyProgram[]>();
  for (const program of programs) {
    let seen: Set<string> | undefined;
    for (const input of program.inputs) {
      if (input.source !== 'product' || seen?.has(input.recipeId!)) continue;
      (seen ??= new Set()).add(input.recipeId!);
      const related = byProduct.get(input.recipeId!);
      if (related) related.push(program); else byProduct.set(input.recipeId!, [program]);
    }
  }
  return byProduct;
}
