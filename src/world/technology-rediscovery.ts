import type { TechnologyExecution, TechnologyRecipe } from '../shared/technology.js';
import type { TechnologyHost } from './technology.js';

/** A cut of current human instructions, taken before the researcher learns the recipe.
 * Legacy rows are dead identities in Source, not a second living population. If an
 * accessible archive instead carries instructions, it cannot silently prove zero. */
export interface RediscoveryCensus {
  status: 'ZERO' | 'KNOWN' | 'UNKNOWN';
  livingActorIds: string[];
  knownActorIds: string[];
  archivedIdentityIds: string[];
  reason: string | null;
}

export function inspectRediscoveryCensus(host: TechnologyHost, recipeId: string): RediscoveryCensus {
  const livingActorIds: string[] = [], knownActorIds: string[] = [], archivedIdentityIds: string[] = [];
  let unknown = false;
  const living = new Set<string>();
  if (!Array.isArray(host.people)) unknown = true;
  else for (const actor of host.people) {
    if (!actor || typeof actor.id !== 'string' || !actor.id || living.has(actor.id) ||
      !Array.isArray(actor.technology?.knownRecipes) ||
      actor.technology.knownRecipes.some(id => typeof id !== 'string')) { unknown = true; continue; }
    living.add(actor.id); livingActorIds.push(actor.id);
    if (actor.technology.knownRecipes.includes(recipeId)) knownActorIds.push(actor.id);
  }
  if ((host.legacy === undefined) !== (host.retiredLegacy === undefined)) unknown = true;
  for (const source of [host.legacy, host.retiredLegacy]) {
    if (source === undefined) continue; // Standalone TechnologyHost: people is its entire roster.
    if (!Array.isArray(source)) { unknown = true; continue; }
    for (const row of source) {
      if (!row || typeof row !== 'object') { unknown = true; continue; }
      const record = row as { id?: unknown; diedAt?: unknown; technology?: { knownRecipes?: unknown } };
      if (typeof record.id !== 'string' || !record.id) { unknown = true; continue; }
      archivedIdentityIds.push(record.id);
      // Source legacy records are deceased and contain no instructions. A richer
      // accessible actor archive with instructions is conservatively an inhibitor.
      const known = record.technology?.knownRecipes;
      if (known !== undefined) {
        if (!Array.isArray(known) || known.some(id => typeof id !== 'string')) unknown = true;
        else if (known.includes(recipeId)) knownActorIds.push(record.id);
      }
      if (!Number.isSafeInteger(record.diedAt) || (record.diedAt as number) > host.tick || living.has(record.id)) unknown = true;
    }
  }
  const uniqueKnown = [...new Set(knownActorIds)];
  return { status: uniqueKnown.length ? 'KNOWN' : unknown ? 'UNKNOWN' : 'ZERO',
    livingActorIds, knownActorIds: uniqueKnown, archivedIdentityIds: [...new Set(archivedIdentityIds)],
    reason: uniqueKnown.length ? 'CONTEMPORARY_KNOWER' : unknown ? 'CENSUS_OR_ARCHIVE_INCOMPLETE' : null };
}

/** Observational evidence only. The receipt and historical definition remain the authorities. */
export function paidRediscoveryPayload(host: TechnologyHost, recipe: TechnologyRecipe,
  receipt: TechnologyExecution, actorId: string, itemId: string, census: RediscoveryCensus,
  definitionSignatureMatches: boolean) {
  const definitionVerified = recipe.id === receipt.recipeId && recipe.signature === receipt.programSignature &&
    definitionSignatureMatches && typeof recipe.inventorId === 'string' && recipe.inventorId.length > 0 &&
    Number.isSafeInteger(recipe.tick) && recipe.tick < host.tick;
  const receiptVerified = (host.technology.history.includes(receipt) || host.technology.journal?.pending.includes(receipt)) &&
    /^process-[1-9]\d*$/.test(receipt.id) &&
    receipt.kind === 'research' && receipt.success && receipt.work > 0 && receipt.energy > 0 &&
    receipt.actorId === actorId && receipt.tick === host.tick && receipt.outputs.some(output =>
      output.resourceId === `recipe:${recipe.id}` && output.mass > 0);
  const reason = census.status !== 'ZERO' ? census.reason : !definitionVerified ? 'ORIGINAL_DEFINITION_UNVERIFIED'
    : !receiptVerified ? 'PAID_RECEIPT_UNVERIFIED' : null;
  return { kind: 'technology-paid-rediscovery', status: reason === null ? 'OBSERVED' : 'UNKNOWN', reason,
    actorId, executionId: receipt.id, itemId, recipeId: recipe.id,
    definition: { signature: recipe.signature, originalAuthorId: recipe.inventorId, originalTick: recipe.tick,
      generation: recipe.generation, parentRecipeIds: [...recipe.parents] },
    payment: { work: receipt.work, energy: receipt.energy, inputs: receipt.inputs, outputs: receipt.outputs },
    census } as const;
}
