import type { Capability, TechnologyProgram, TechnologyRecipe } from '../shared/technology.js';

/**
 * Pure reduction only: recipes/capacities/programs must be ordinary data that cannot
 * change during the call, `available` must be the local pure stock predicate, and
 * Math.max/Object.is must be their native intrinsics. This helper does not establish
 * that boundary; the engine admits its complete local graph immediately before
 * calling it. Calls outside the engine's people phase retain the original route.
 * All remembered resolutions must finish before entering it; none may be skipped.
 */
export function pureAvailableRecipePowers(
  remembered: readonly Pick<TechnologyRecipe, 'capacities' | 'program'>[],
  available: (program: TechnologyProgram) => boolean,
): Record<Capability, number> {
  const powers: Record<Capability, number> = {
    cutting: 0, storage: 0, insulation: 0, cultivation: 0, binding: 0, abrasion: 0,
  };
  for (const recipe of remembered) {
    const capacities = recipe.capacities;
    const cutting = Math.max(powers.cutting, capacities.cutting);
    const storage = Math.max(powers.storage, capacities.storage);
    const insulation = Math.max(powers.insulation, capacities.insulation);
    const cultivation = Math.max(powers.cultivation, capacities.cultivation);
    const binding = Math.max(powers.binding, capacities.binding);
    const abrasion = Math.max(powers.abrasion, capacities.abrasion);
    // Object.is keeps NaN absorbing and distinguishes the signs of zero. Starting
    // with +0 matches the original six left-to-right Math.max reductions.
    if (Object.is(cutting, powers.cutting) && Object.is(storage, powers.storage)
      && Object.is(insulation, powers.insulation) && Object.is(cultivation, powers.cultivation)
      && Object.is(binding, powers.binding) && Object.is(abrasion, powers.abrasion)) continue;
    if (!available(recipe.program)) continue;
    powers.cutting = cutting; powers.storage = storage; powers.insulation = insulation;
    powers.cultivation = cultivation; powers.binding = binding; powers.abrasion = abrasion;
  }
  return powers;
}
