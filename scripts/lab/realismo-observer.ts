/** Offline projection of private source receipts to the sealed realismo-v3 surface. */
import { EVIDENCE_KINDS, FAMILIES, type Family, type EvidenceKind, type ObservationRecord } from './realismo-contract.js';
import type { AttemptState, ObservationEvent, ObservationGap } from '../../src/world/observation.js';

const FIELD_NAMES: Record<Family, readonly string[]> = {
  "boundary": [
    "boundaryId",
    "stockIds",
    "materials",
    "unitMapVersion",
    "conversionMatrixRef",
    "includesProtected",
    "scope",
    "excludedCompartments"
  ],
  "stock": [
    "boundaryId",
    "stockId",
    "ownerId",
    "regionId",
    "clockTick",
    "scale",
    "material",
    "quantity",
    "phase"
  ],
  "flow": [
    "boundaryId",
    "transferId",
    "fromStockId",
    "toStockId",
    "flowType",
    "quantity",
    "counterpartRecordId",
    "conversionRef",
    "consumptionRef"
  ],
  "exposure": [
    "subjectId",
    "regionId",
    "startTick",
    "endTick",
    "activeTicks",
    "localStartTick",
    "localEndTick",
    "mode",
    "lawInputsRef"
  ],
  "person": [
    "actorId",
    "role",
    "birthTick",
    "deathTick",
    "founder",
    "species",
    "parentIds",
    "knownTechniqueIds",
    "positionRef",
    "ageOrigin",
    "ageAtOpeningTicks"
  ],
  "death": [
    "actorId",
    "birthTick",
    "deathTick",
    "ageTicks",
    "locationRef",
    "cause",
    "previousEventIds",
    "historyStartTick",
    "lifetimeEventCount",
    "historyComplete",
    "durableReceiptRef",
    "ageOrigin",
    "ageAtOpeningTicks"
  ],
  "structure": [
    "structureId",
    "creationTick",
    "blueprintId",
    "positionRef",
    "condition",
    "durability",
    "constructionFlows",
    "constructionWork",
    "lawVersion",
    "rainInputRef"
  ],
  "repair": [
    "structureId",
    "actorId",
    "conditionBefore",
    "conditionAfter",
    "paidWork",
    "inputFlows",
    "serviceBeforeRefs",
    "serviceAfterRefs",
    "lawVersion"
  ],
  "service": [
    "subjectId",
    "actorId",
    "recipientId",
    "functionId",
    "domain",
    "appliedBenefit",
    "baselineBenefit",
    "consumptionRefs",
    "inputRefs",
    "work",
    "eventType",
    "causeRef",
    "conditionAtService",
    "conditionSourceRef"
  ],
  "product": [
    "productId",
    "techniqueId",
    "programSignature",
    "signatureVersion",
    "capabilities",
    "functionIds",
    "authorId",
    "ancestorIds",
    "techGeneration",
    "manufactureRefs",
    "resident",
    "residentBudget"
  ],
  "replacement": [
    "oldProductId",
    "newProductId",
    "functionId",
    "wearRefs",
    "wasteFlowRefs",
    "oldServiceRefs",
    "newServiceRefs",
    "manufactureRefs",
    "supplierId",
    "initialStockRefs"
  ],
  "knowledge": [
    "actorId",
    "techniqueId",
    "transition",
    "teacherId",
    "localityRef",
    "paymentRefs",
    "previousTechniqueId",
    "originalAuthorId",
    "humanCohortId"
  ],
  "migration": [
    "actorId",
    "exposureCohortId",
    "originHomeId",
    "destinationHomeId",
    "originSourceId",
    "destinationViabilityRef",
    "trajectoryRefs",
    "paidWork",
    "destinationStartTick",
    "destinationEndTick",
    "destinationConsumptionRefs",
    "visitRefs"
  ],
  "role": [
    "actorId",
    "roleClassificationId",
    "functionId",
    "recipientIds",
    "serviceRefs",
    "workTicks",
    "opportunities",
    "institutionId",
    "institutionTransition",
    "localRuleRef"
  ],
  "conflict": [
    "episodeId",
    "actorIds",
    "sourceId",
    "groupRelation",
    "needInputsRef",
    "triggerLawRef",
    "trajectoryRefs",
    "costRefs",
    "agreement",
    "memoryEnabled",
    "accessWinnerId",
    "consumptionRefs",
    "recurrenceRefs",
    "followupStartTick",
    "followupEndTick",
    "eligibleOpportunityRefs"
  ],
  "ecology": [
    "regionId",
    "species",
    "biome",
    "globalTick",
    "localTick",
    "scale",
    "policyVersion",
    "population",
    "birthIds",
    "deathIds",
    "immigrantIds",
    "emigrantIds",
    "predationRefs",
    "huntRefs",
    "flowRefs",
    "conditionInputsRef",
    "humanIds"
  ],
  "rejection": [
    "attemptId",
    "actorIds",
    "allGateResultsRef",
    "decisiveGate",
    "fertilityInputsRef",
    "accessibleResourcesRef",
    "governorInputRef",
    "governorDecisionRef",
    "outcome",
    "opportunityId",
    "coverageRef"
  ],
  "digest": [
    "physicalTick",
    "algorithm",
    "canonicalVersion",
    "scope",
    "digest",
    "inputTraceHash",
    "governorTraceHash",
    "population",
    "backend",
    "cameraCount",
    "excludedFields",
    "componentHashesRef"
  ],
  "cost": [
    "sampleId",
    "sceneId",
    "completedSteps",
    "startSeconds",
    "endSeconds",
    "warmupSeconds",
    "hostLoadRef",
    "physicalInputsHash",
    "governorInputsHash",
    "backend",
    "threads",
    "cameraCount",
    "population",
    "stepMs",
    "saveMs",
    "projectionMs",
    "transferToMs",
    "transferFromMs",
    "completeMs",
    "queueMs",
    "cpuSeconds",
    "rssBytes",
    "diskBytes",
    "egressBytes",
    "stateBytes",
    "fps",
    "measurementScope"
  ],
  "fault": [
    "caseId",
    "phase",
    "faultPoint",
    "lastDurableCommitId",
    "acknowledgedOrderIds",
    "recoveredCommitId",
    "expectedComponentManifestRef",
    "actualComponentManifestRef",
    "clientTickRefs",
    "archiveVersionManifestRef",
    "realDurationSeconds",
    "clientCount"
  ],
  "review": [
    "reviewId",
    "kind",
    "authority",
    "contentHash",
    "decision",
    "receiptRef",
    "deviceId",
    "physicalDevice",
    "taskId",
    "criticalBlockers",
    "durationSeconds",
    "evidenceRefs"
  ],
  "method": [
    "trialId",
    "preregistrationRef",
    "preregistrationHash",
    "registeredBeforeData",
    "seedRegistryRef",
    "runManifestRefs",
    "selector",
    "learningEnabled",
    "budgetRef",
    "interventionRefs",
    "independentReviewRef",
    "priorPhaseDecisionRef",
    "rewardDefinitionRef",
    "reservedSeedAuditRef"
  ]
} as const;

export type RawObservedPayload = Readonly<{
  family: Family;
  payload: Readonly<Record<string, unknown>>;
  actorIds?: readonly string[];
  protectedOriginIds?: readonly string[];
  provenanceRefs?: readonly string[];
}>;
/** Source readings for C18; these are not typed evidence documents. */
export type ConflictSourceReceipt = Readonly<{
  sourceEventId: string; siteId: string; details: Readonly<Record<string, unknown>>;
}>;
export type FamilyCapability = Readonly<{ family: Family; status: 'available' | 'partial' | 'unavailable'; availableFields: string[]; missingFields: string[]; sourceRefs: string[]; reason: string }>;
export type EvidenceCapability = Readonly<{ kind: EvidenceKind; status: 'available' | 'partial' | 'unavailable'; reason: string }>;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const unique = (values: readonly string[]): string[] => [...new Set(values)];
function frozenSourceCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}
/** Narrow, lossless-to-source projection. Never invent a conversion or causal link. */
function fromRawSource(event: ObservationEvent, raw: Record<string, unknown>, benefitLinks: ReadonlyMap<string, readonly string[]>): RawObservedPayload | null {
  const kind = raw.kind;
  if (kind === 'reproduction-accepted' && typeof raw.childId === 'string') {
    return { family: 'rejection', actorIds: Array.isArray(raw.actorIds)
      ? raw.actorIds.filter((id): id is string => typeof id === 'string') : [],
      payload: { attemptId: raw.childId, outcome: 'accepted', decisiveGate: null,
        coverageRef: event.sourceEventId } };
  }
  if (kind === 'reproduction-gate' && raw.passed === false
    && ['fit', 'match', 'place', 'partner'].includes(String(raw.gate))) {
    const actorIds = Array.isArray(raw.actorIds)
      ? raw.actorIds.filter((id): id is string => typeof id === 'string') : [];
    if (actorIds.length) return { family: 'rejection', actorIds,
      payload: { attemptId: event.sourceEventId, actorIds, outcome: 'rejected',
        decisiveGate: 'local', coverageRef: event.sourceEventId } };
  }
  if ((kind === 'structure-food-debit' || kind === 'cistern-water-debit')
    && typeof raw.structureId === 'string' && typeof raw.amount === 'number' && Number.isFinite(raw.amount)) {
    const material = kind === 'structure-food-debit' ? 'food' : 'water';
    return { family: 'flow', actorIds: typeof raw.actorId === 'string' ? [raw.actorId] : [],
      payload: { transferId: event.sourceEventId, fromStockId: `structure:${raw.structureId}:${material}`,
        flowType: 'consumption', quantity: { value: raw.amount, unit: 'normalized', material,
          conversionVersion: 'atlas-native-normalized-v1' },
        ...(typeof raw.consumptionId === 'string' ? { consumptionRef: raw.consumptionId } : {}) } };
  }
  if ((kind === 'food-applied' || kind === 'water-applied') && typeof raw.actorId === 'string'
    && typeof raw.consumptionId === 'string') {
    const before = kind === 'food-applied' ? raw.hungerBefore : raw.thirstBefore;
    const after = kind === 'food-applied' ? raw.hungerAfter : raw.thirstAfter;
    return { family: 'service', actorIds: [raw.actorId], payload: {
      subjectId: raw.actorId, recipientId: raw.actorId, eventType: 'consume',
      domain: kind === 'food-applied' ? 'food' : 'water', consumptionRefs: [raw.consumptionId],
      ...(typeof before === 'number' && typeof after === 'number' && Number.isFinite(before - after) && before >= after
        ? { appliedBenefit: { value: before - after, unit: 'normalized',
          material: kind === 'food-applied' ? 'hunger-relief' : 'thirst-relief',
          conversionVersion: 'atlas-native-normalized-v1' } } : {}) } };
  }
  if (kind === 'region-boundary' && typeof raw.regionId === 'string' && typeof raw.globalTick === 'number') {
    const archived = raw.operation === 'archive';
    return { family: 'exposure', payload: { subjectId: raw.regionId, regionId: raw.regionId,
      ...(archived ? { endTick: raw.globalTick, localEndTick: raw.localTick, mode: 'archived' }
        : { startTick: raw.globalTick, ...(typeof raw.previousLocalTick === 'number' ? { localStartTick: raw.previousLocalTick } : {}), mode: 'active' }) } };
  }
  if ((kind === 'ecology-prekernel-tile' || kind === 'ecology-kernel-tile')
    && typeof raw.x === 'number' && typeof raw.y === 'number') {
    return { family: 'ecology', payload: { regionId: `tile:${raw.x},${raw.y}`, globalTick: event.tick,
      scale: 'tile', ...(typeof raw.biome === 'string' ? { biome: raw.biome } : {}) } };
  }
  if (kind === 'technology-product-manufactured' && typeof raw.itemId === 'string') {
    return { family: 'product', actorIds: typeof raw.actorId === 'string' ? [raw.actorId] : [],
      payload: { productId: raw.itemId, ...(typeof raw.recipeId === 'string' ? { techniqueId: raw.recipeId } : {}),
        ...(typeof raw.programSignature === 'string' ? { programSignature: raw.programSignature } : {}),
        ...(typeof raw.actorId === 'string' ? { authorId: raw.actorId } : {}),
        ...(typeof raw.generation === 'number' ? { techGeneration: raw.generation } : {}),
        resident: true } };
  }
  if (kind === 'animal-death' && typeof raw.animalId === 'string') {
    return { family: 'death', actorIds: [raw.animalId], payload: { actorId: raw.animalId,
      birthTick: raw.birthTick, deathTick: raw.deathTick,
      ...(typeof raw.birthTick === 'number' && typeof raw.deathTick === 'number' ? { ageTicks: raw.deathTick - raw.birthTick } : {}),
      cause: raw.causeCode } };
  }
  if (kind === 'shelter-recovery-applied' && typeof raw.structureId === 'string' && typeof raw.actorId === 'string') {
    return { family: 'service', actorIds: [raw.actorId], payload: { subjectId: raw.structureId,
      actorId: raw.actorId, eventType: 'shelter-recovery', conditionAtService: raw.conditionAtService,
      ...(typeof raw.measuredExtra === 'number' && Number.isFinite(raw.measuredExtra)
        ? { appliedBenefit: { value: raw.measuredExtra, unit: 'normalized', material: 'body-recovery',
          conversionVersion: 'atlas-native-normalized-v1' } } : {}) } };
  }
  if (kind === 'technology-benefit-update' && raw.benefitContext === 'applied-world'
    && typeof raw.itemId === 'string' && typeof raw.actorId === 'string'
    && benefitLinks.has(event.sourceEventId)) {
    return { family: 'service', actorIds: [raw.actorId], provenanceRefs: benefitLinks.get(event.sourceEventId),
      payload: { subjectId: raw.itemId, actorId: raw.actorId,
      inputRefs: [...benefitLinks.get(event.sourceEventId)!],
      ...(typeof raw.capability === 'string' ? { functionId: raw.capability } : {}), eventType: 'other-applied',
      ...(typeof raw.actualBenefit === 'number' && Number.isFinite(raw.actualBenefit)
        ? { appliedBenefit: { value: raw.actualBenefit, unit: 'normalized', material: 'technology-benefit',
          conversionVersion: 'atlas-native-normalized-v1' } } : {}) } };
  }
  return null;
}


/** Project only fields present in a real receipt. Absent fields stay missing, never zero. */
export function projectObservedEvents(events: readonly ObservationEvent[], context: Readonly<{
  gaps: readonly ObservationGap[]; attemptHistory: ReadonlyMap<string, readonly Readonly<{ state: AttemptState }>[]>;
  lostEvents?: number; lostGaps?: number;
}>): {
  records: ObservationRecord[]; capabilities: FamilyCapability[]; evidenceCoverage: EvidenceCapability[]; modelGaps: string[];
  sourceEvents: readonly ObservationEvent[]; conflictSourceReceipts: readonly ConflictSourceReceipt[];
} {
  const records: ObservationRecord[] = [];
  const conflictSourceReceipts: ConflictSourceReceipt[] = [];
  const modelGaps: string[] = [];
  // A caller without the attempt ledger cannot establish adoption. Retain the
  // source receipts, but fail closed instead of promoting them to world effects.
  const gaps = context?.gaps ?? [];
  const attemptHistory = context?.attemptHistory;
  const observerGap = !attemptHistory || gaps.length > 0 || (context?.lostEvents ?? 0) > 0 || (context?.lostGaps ?? 0) > 0;
  if (!attemptHistory) modelGaps.push('attempt-history-unavailable');
  if (observerGap) modelGaps.push('observer-gap-coverage-incomplete');
  const perFamily = new Map<Family, Set<string>>();
  const sequence = new Map<Family, number>();
  const eligible = events.filter(event => {
    const states = attemptHistory?.get(event.attemptId)?.map(transition => transition.state) ?? [];
    const adopted = states.includes('adopted');
    const rolledBack = states.includes('discarded') || states.includes('restored');
    if (!adopted || rolledBack) modelGaps.push(`${event.sourceEventId}:unadopted-or-rolled-back`);
    return adopted && !rolledBack;
  });
  const uses = new Map<string, ObservationEvent>();
  const wears = new Map<string, ObservationEvent>();
  const invalidReceipts = new Set<string>();
  const credited = new Set<string>();
  const benefitLinks = new Map<string, readonly string[]>();
  for (const event of eligible) {
    const raw = event.payload;
    if (!isObject(raw) || typeof raw.executionId !== 'string') continue;
    const key = `${event.attemptId}\0${raw.executionId}`;
    if (raw.kind === 'technology-execution' && raw.receiptKind === 'use') {
      if (uses.has(key)) invalidReceipts.add(key);
      uses.set(key, event);
    } else if (raw.kind === 'technology-tool-wear') {
      if (wears.has(key)) invalidReceipts.add(key);
      wears.set(key, event);
    }
    else if (raw.kind === 'technology-benefit-update' && raw.benefitContext === 'applied-world') {
      const use = uses.get(key), wear = wears.get(key);
      const usePayload = use?.payload, wearPayload = wear?.payload;
      if (!invalidReceipts.has(key) && !credited.has(key) && use && wear && isObject(usePayload) && isObject(wearPayload)
        && usePayload.actorId === raw.actorId && wearPayload.actorId === raw.actorId
        && usePayload.recipeId === raw.recipeId && wearPayload.recipeId === raw.recipeId
        && wearPayload.itemId === raw.itemId && wearPayload.capability === raw.capability
        && use.tick === event.tick && wear.tick === event.tick) {
        benefitLinks.set(event.sourceEventId, [use.sourceEventId, wear.sourceEventId]);
        credited.add(key);
      } else modelGaps.push(`${event.sourceEventId}:applied-benefit-without-same-attempt-use-and-wear`);
    }
  }
  for (const event of eligible) {
    const source = event.payload;
    const raw = isObject(source) ? (fromRawSource(event, source, benefitLinks) ?? source) : source;
    if (!isObject(raw)) { modelGaps.push(`${event.sourceEventId}:payload-not-object`); continue; }
    // Private source receipts remain available to an offline reconciler. A raw receipt is
    // not silently promoted to a canonical record with invented units or counterparts.
    if (!FAMILIES.includes(raw.family as Family) || !isObject(raw.payload)) continue;
    const family = raw.family as Family;
    const sourceDetails = raw.sourceDetails;
    const hasConflictSourceDetails = family === 'conflict'
      && (event.siteId === 'society.dispute-agreement' || event.siteId === 'society.dispute-conflict')
      && isObject(sourceDetails);
    if (hasConflictSourceDetails && isObject(sourceDetails)) {
      conflictSourceReceipts.push(Object.freeze({ sourceEventId: event.sourceEventId, siteId: event.siteId,
        details: frozenSourceCopy(sourceDetails) }));
      modelGaps.push(`${event.sourceEventId}:conflict-typed-refs-consumption-and-followup-unavailable`);
    }
    const allowed = FIELD_NAMES[family];
    const payload: Record<string, unknown> = {};
    const fieldCoverage: Record<string, { status: 'observed' | 'missing'; reason: string }> = {};
    for (const key of allowed) {
      if (Object.hasOwn(raw.payload, key) && raw.payload[key] !== undefined) {
        payload[key] = raw.payload[key];
        fieldCoverage[key] = { status: 'observed', reason: `source:${event.siteId}` };
        const present = perFamily.get(family) ?? new Set<string>(); present.add(key); perFamily.set(family, present);
      } else fieldCoverage[key] = { status: 'missing', reason: observerGap ? 'observation-gap-or-not-captured'
        : hasConflictSourceDetails && ['needInputsRef', 'triggerLawRef', 'costRefs'].includes(key) ? 'source-readings-present-typed-evidence-unavailable'
        : family === 'conflict' && ['trajectoryRefs', 'consumptionRefs', 'recurrenceRefs', 'followupStartTick', 'followupEndTick', 'eligibleOpportunityRefs'].includes(key)
          ? 'not-observed-at-conflict-episode' : `not-captured-at:${event.siteId}` };
    }
    if (!Object.keys(payload).length) { modelGaps.push(`${event.sourceEventId}:no-schema-field`); continue; }
    const actorIds = unique(Array.isArray(raw.actorIds) ? raw.actorIds.filter((x): x is string => typeof x === 'string') : []);
    const protectedOriginIds = unique(Array.isArray(raw.protectedOriginIds) ? raw.protectedOriginIds.filter((x): x is string => typeof x === 'string') : actorIds.filter(x => x === 's' || x === 'i'));
    const seq = sequence.get(family) ?? 0; sequence.set(family, seq + 1);
    records.push({
      recordId: `record:${event.sourceEventId}`, streamId: `stream:${family}`, epochId: event.epochId, seq,
      tick: event.tick, family, actorIds, protectedOriginIds,
      protectionStatus: protectedOriginIds.length ? (actorIds.some(x => !protectedOriginIds.includes(x)) ? 'mixed' : 'protected') : 'unknown',
      provenanceRefs: unique(Array.isArray(raw.provenanceRefs) ? raw.provenanceRefs.filter((x): x is string => typeof x === 'string') : []),
      payload, fieldCoverage,
      causalContext: { status: 'unknown', sourceEventId: event.sourceEventId, phaseId: event.phaseId,
        phaseOrdinal: event.phaseOrdinal, eventOrdinal: event.eventOrdinal, sourceOrderRef: event.sourceEventId,
        predecessorRecordIds: [], reason: 'source-order-observed-causal-binding-not-established' },
    } as unknown as ObservationRecord);
  }
  const capabilities = FAMILIES.map(family => {
    const availableFields = [...(perFamily.get(family) ?? new Set<string>())];
    const missingFields = FIELD_NAMES[family].filter(key => !availableFields.includes(key));
    return { family, status: observerGap ? 'unavailable' : availableFields.length ? 'partial' : 'unavailable', availableFields, missingFields,
      sourceRefs: unique(eligible.filter(event => { const payload = event.payload;
        return isObject(payload) && (fromRawSource(event, payload, benefitLinks)?.family ?? payload.family) === family;
      }).map(event => event.sourceEventId)),
      reason: observerGap ? 'observation-gap-no-complete-family-coverage' : availableFields.length ? 'partial-source-fields-and-causal-binding' : 'no-observed-source-event' } satisfies FamilyCapability;
  });
  const sites = new Set(eligible.map(event => event.siteId));
  const technicalSource: Partial<Record<EvidenceKind, string[]>> = {
    'source-metadata': ['index.step-inputs'], 'source-order': ['index.step-inputs'],
    'reproduction-gates': ['index.reproduce.fit', 'index.reproduce.global-stop', 'index.reproduce.cadence-stop'],
    'reproduction-coverage': ['index.reproduce.global-stop', 'index.reproduce.cadence-stop'],
    'governor-trace': ['app.governor'], 'cohort': ['index.birth', 'lineage.death'],
    'applied-effect': ['technology.benefit-applied', 'technology-water.drink', 'inventions.repair'],
    'position-trajectory': ['spatial.activate', 'spatial.retire'],
  };
  const evidenceCoverage = EVIDENCE_KINDS.map(kind => {
    const refs = technicalSource[kind] ?? [];
    return { kind, status: !observerGap && refs.some(ref => sites.has(ref)) ? 'partial' as const : 'unavailable' as const,
      reason: observerGap ? 'observation-gap-no-complete-evidence-coverage' : refs.some(ref => sites.has(ref)) ? 'private-source-receipt-only-no-complete-evidence-document'
        : 'evidence-document-requires-harness-or-external-authority' };
  });
  return { records, capabilities, evidenceCoverage, modelGaps, sourceEvents: Object.freeze([...events]),
    conflictSourceReceipts: Object.freeze(conflictSourceReceipts) };
}
