// Runtime contract foundation only: no world, observer, evaluator or scientific acceptance.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { parseTree } from 'jsonc-parser';
import type { Node as JSONNode } from 'jsonc-parser';

export const CONTRACT_VERSION = 'realismo-v3' as const;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type Quality = 'COMPLETE' | 'PARTIAL' | 'INVALID' | 'UNAVAILABLE';
export type FieldStatus = { status: 'observed' | 'missing' | 'not-applicable'; reason: string };
export type CausalContext = { status: 'ordered' | 'snapshot' | 'unknown'; sourceEventId: string | null; phaseId: string | null; phaseOrdinal: number | null; eventOrdinal: number | null; sourceOrderRef: string | null; predecessorRecordIds: string[]; reason: string };
export const FAMILIES = ["boundary", "stock", "flow", "exposure", "person", "death", "structure", "repair", "service", "product", "replacement", "knowledge", "migration", "role", "conflict", "ecology", "rejection", "digest", "cost", "fault", "review", "method"] as const;
export type Family = typeof FAMILIES[number];
export const EVIDENCE_KINDS = ["governor-trace", "physical-inputs", "law", "law-inputs", "position-trajectory", "cohort", "opportunity", "applied-effect", "functional-map", "role-classification", "component-manifest", "host-scene", "preregistration", "seed-register", "budget", "phase-decision", "personal-receipt", "intervention", "parameter-set", "conversion-matrix", "real-memory-inventory", "memory-authorization", "synthetic-review-oracle", "source-metadata", "source-order", "reproduction-gates", "reproduction-coverage", "causal-pair", "metric-definitions", "run-manifest"] as const;
export type EvidenceKind = typeof EVIDENCE_KINDS[number];
// Payload surfaces transcribed mechanically from the pinned schemas; Ajv remains authoritative.
export interface RecordPayloads {
"boundary": { "boundaryId"?: string; "stockIds"?: Array<string>; "materials"?: Array<string>; "unitMapVersion"?: string; "conversionMatrixRef"?: string; "includesProtected"?: true; "scope"?: "global" | "partial"; "excludedCompartments"?: Array<string> };
"stock": { "boundaryId"?: string; "stockId"?: string; "ownerId"?: (string | null); "regionId"?: string; "clockTick"?: number; "scale"?: string; "material"?: string; "quantity"?: { "value": number; "unit": "quanta" | "normalized" | "work" | "energy-model" | "ticks" | "ms" | "bytes" | "seconds" | "count" | "fps" | "ratio" | "percentage-points"; "material": string; "conversionVersion": string }; "phase"?: "opening" | "closing" | "sample" };
"flow": { "boundaryId"?: string; "transferId"?: string; "fromStockId"?: (string | null); "toStockId"?: (string | null); "flowType"?: "internal" | "external-in" | "external-out" | "regeneration" | "conversion" | "consumption" | "loss"; "quantity"?: { "value": number; "unit": "quanta" | "normalized" | "work" | "energy-model" | "ticks" | "ms" | "bytes" | "seconds" | "count" | "fps" | "ratio" | "percentage-points"; "material": string; "conversionVersion": string }; "counterpartRecordId"?: (string | null); "conversionRef"?: (string | null); "consumptionRef"?: (string | null) };
"exposure": { "subjectId"?: string; "regionId"?: string; "startTick"?: number; "endTick"?: number; "activeTicks"?: number; "localStartTick"?: number; "localEndTick"?: number; "mode"?: "active" | "archived" | "multiscale"; "lawInputsRef"?: string };
"person": { "actorId"?: string; "role"?: "mortal" | "S" | "I" | "fauna"; "birthTick"?: number; "deathTick"?: (number | null); "founder"?: boolean; "species"?: string; "parentIds"?: Array<string>; "knownTechniqueIds"?: Array<string>; "positionRef"?: string; "ageOrigin"?: "observed-birth" | "initial-model-age"; "ageAtOpeningTicks"?: number };
"death": { "actorId"?: string; "birthTick"?: number; "deathTick"?: number; "ageTicks"?: number; "locationRef"?: string; "cause"?: string; "previousEventIds"?: Array<string>; "historyStartTick"?: number; "lifetimeEventCount"?: number; "historyComplete"?: boolean; "durableReceiptRef"?: (string | null); "ageOrigin"?: "observed-birth" | "initial-model-age"; "ageAtOpeningTicks"?: number };
"structure": { "structureId"?: string; "creationTick"?: number; "blueprintId"?: string; "positionRef"?: string; "condition"?: number; "durability"?: number; "constructionFlows"?: Array<string>; "constructionWork"?: number; "lawVersion"?: string; "rainInputRef"?: string };
"repair": { "structureId"?: string; "actorId"?: string; "conditionBefore"?: number; "conditionAfter"?: number; "paidWork"?: number; "inputFlows"?: Array<string>; "serviceBeforeRefs"?: Array<string>; "serviceAfterRefs"?: Array<string>; "lawVersion"?: string };
"service": { "subjectId"?: string; "actorId"?: string; "recipientId"?: string; "functionId"?: string; "domain"?: string; "appliedBenefit"?: { "value": number; "unit": "quanta" | "normalized" | "work" | "energy-model" | "ticks" | "ms" | "bytes" | "seconds" | "count" | "fps" | "ratio" | "percentage-points"; "material": string; "conversionVersion": string }; "baselineBenefit"?: { "value": number; "unit": "quanta" | "normalized" | "work" | "energy-model" | "ticks" | "ms" | "bytes" | "seconds" | "count" | "fps" | "ratio" | "percentage-points"; "material": string; "conversionVersion": string }; "consumptionRefs"?: Array<string>; "inputRefs"?: Array<string>; "work"?: number; "eventType"?: "consume" | "shelter-recovery" | "soil-preparation" | "extraction-increment" | "work-saving" | "other-applied"; "causeRef"?: string; "conditionAtService"?: number; "conditionSourceRef"?: string };
"product": { "productId"?: string; "techniqueId"?: string; "programSignature"?: string; "signatureVersion"?: string; "capabilities"?: Array<number>; "functionIds"?: Array<string>; "authorId"?: string; "ancestorIds"?: Array<string>; "techGeneration"?: number; "manufactureRefs"?: Array<string>; "resident"?: boolean; "residentBudget"?: number };
"replacement": { "oldProductId"?: string; "newProductId"?: string; "functionId"?: string; "wearRefs"?: Array<string>; "wasteFlowRefs"?: Array<string>; "oldServiceRefs"?: Array<string>; "newServiceRefs"?: Array<string>; "manufactureRefs"?: Array<string>; "supplierId"?: string; "initialStockRefs"?: Array<string> };
"knowledge": { "actorId"?: string; "techniqueId"?: string; "transition"?: "acquire" | "lose" | "teach" | "paid-rediscovery"; "teacherId"?: (string | null); "localityRef"?: string; "paymentRefs"?: Array<string>; "previousTechniqueId"?: (string | null); "originalAuthorId"?: string; "humanCohortId"?: string };
"migration": { "actorId"?: string; "exposureCohortId"?: string; "originHomeId"?: string; "destinationHomeId"?: string; "originSourceId"?: string; "destinationViabilityRef"?: string; "trajectoryRefs"?: Array<string>; "paidWork"?: number; "destinationStartTick"?: number; "destinationEndTick"?: number; "destinationConsumptionRefs"?: Array<string>; "visitRefs"?: Array<string> };
"role": { "actorId"?: string; "roleClassificationId"?: string; "functionId"?: string; "recipientIds"?: Array<string>; "serviceRefs"?: Array<string>; "workTicks"?: number; "opportunities"?: number; "institutionId"?: (string | null); "institutionTransition"?: ("adopt" | "revise" | "remove" | "restore" | null); "localRuleRef"?: (string | null) };
"conflict": { "episodeId"?: string; "actorIds"?: Array<string>; "sourceId"?: string; "groupRelation"?: "endo" | "exo"; "needInputsRef"?: string; "triggerLawRef"?: string; "trajectoryRefs"?: Array<string>; "costRefs"?: Array<string>; "agreement"?: boolean; "memoryEnabled"?: boolean; "accessWinnerId"?: (string | null); "consumptionRefs"?: Array<string>; "recurrenceRefs"?: Array<string>; "followupStartTick"?: number; "followupEndTick"?: number; "eligibleOpportunityRefs"?: Array<string> };
"ecology": { "regionId"?: string; "species"?: string; "biome"?: string; "globalTick"?: number; "localTick"?: number; "scale"?: string; "policyVersion"?: string; "population"?: number; "birthIds"?: Array<string>; "deathIds"?: Array<string>; "immigrantIds"?: Array<string>; "emigrantIds"?: Array<string>; "predationRefs"?: Array<string>; "huntRefs"?: Array<string>; "flowRefs"?: Array<string>; "conditionInputsRef"?: string; "humanIds"?: Array<string> };
"rejection": { "attemptId"?: string; "actorIds"?: Array<string>; "allGateResultsRef"?: string; "decisiveGate"?: ("local" | "global-quota" | "governor" | "anticorruption" | "other-software" | null); "fertilityInputsRef"?: string; "accessibleResourcesRef"?: string; "governorInputRef"?: (string | null); "governorDecisionRef"?: (string | null); "outcome"?: "accepted" | "rejected"; "opportunityId"?: string; "coverageRef"?: string };
"digest": { "physicalTick"?: number; "algorithm"?: "sha256"; "canonicalVersion"?: string; "scope"?: "physical" | "state-history" | "projection"; "digest"?: string; "inputTraceHash"?: string; "governorTraceHash"?: string; "population"?: number; "backend"?: string; "cameraCount"?: number; "excludedFields"?: Array<string>; "componentHashesRef"?: string };
"cost": { "sampleId"?: string; "sceneId"?: string; "completedSteps"?: number; "startSeconds"?: number; "endSeconds"?: number; "warmupSeconds"?: number; "hostLoadRef"?: string; "physicalInputsHash"?: string; "governorInputsHash"?: string; "backend"?: string; "threads"?: number; "cameraCount"?: number; "population"?: number; "stepMs"?: number; "saveMs"?: number; "projectionMs"?: number; "transferToMs"?: number; "transferFromMs"?: number; "completeMs"?: number; "queueMs"?: number; "cpuSeconds"?: number; "rssBytes"?: number; "diskBytes"?: number; "egressBytes"?: number; "stateBytes"?: number; "fps"?: number; "measurementScope"?: "server" | "kernel" | "client" | "end-to-end" };
"fault": { "caseId"?: string; "phase"?: "before-commit" | "after-commit"; "faultPoint"?: string; "lastDurableCommitId"?: string; "acknowledgedOrderIds"?: Array<string>; "recoveredCommitId"?: string; "expectedComponentManifestRef"?: string; "actualComponentManifestRef"?: string; "clientTickRefs"?: Array<string>; "archiveVersionManifestRef"?: string; "realDurationSeconds"?: number; "clientCount"?: number };
"review": { "reviewId"?: string; "kind"?: "personal" | "task" | "inspector" | "memory-pair" | "encounter-pair" | "authorization"; "authority"?: "Steven" | "technical-reviewer" | "synthetic-oracle"; "contentHash"?: string; "decision"?: "accepted" | "rejected" | "pending"; "receiptRef"?: string; "deviceId"?: string; "physicalDevice"?: boolean; "taskId"?: string; "criticalBlockers"?: number; "durationSeconds"?: number; "evidenceRefs"?: Array<string> };
"method": { "trialId"?: string; "preregistrationRef"?: string; "preregistrationHash"?: string; "registeredBeforeData"?: boolean; "seedRegistryRef"?: string; "runManifestRefs"?: Array<string>; "selector"?: "current" | "neutral" | "learned" | "not-applicable"; "learningEnabled"?: boolean; "budgetRef"?: string; "interventionRefs"?: Array<string>; "independentReviewRef"?: string; "priorPhaseDecisionRef"?: (string | null); "rewardDefinitionRef"?: string; "reservedSeedAuditRef"?: string };
}
export interface EvidencePayloads {
"governor-trace": { "policyVersion"?: string; "budgetMs"?: number; "entries"?: Array<{ "tick": number; "p95InputMs": number; "populationInput": number; "activeTilesInput": number; "manualInput": string; "previousCeiling": (number | null); "nextCeiling": (number | null); "decision": string; "reason": string }> };
"physical-inputs": { "initialStateHash"?: string; "paramsHash"?: string; "entries"?: Array<{ "tick": number; "inputId": string; "inputKind": string; "actorId": (string | null); "targetRef": (string | null); "quantity": (number | null); "confirmed": boolean; "inputHash": string }> };
"law": { "sourceSHA"?: string; "lawVersion"?: string; "phaseOrder"?: Array<string>; "formulaDefinitions"?: Array<{ "formulaId": string; "expression": string; "inputFields": Array<string>; "outputField": string; "unit": string }>; "parameters"?: Array<{ "name": string; "value": number; "unit": string }>; "sourceRefs"?: Array<string> };
"law-inputs": { "lawRef"?: string; "entries"?: Array<{ "tick": number; "subjectId": string; "field": string; "value": number; "unit": string; "sourceEventId": string; "sourceOrderRef": string }> };
"position-trajectory": { "actorId"?: string; "positions"?: Array<{ "tick": number; "x": number; "y": number; "regionId": string; "localPerceptionRef": string; "workDebitRef": string }> };
"cohort": { "cohortId"?: string; "selectionRegisteredRef"?: string; "atTick"?: number; "eligibilityRule"?: string; "actorIds"?: Array<string>; "excluded"?: Array<{ "actorId": string; "reason": string }>; "censored"?: Array<{ "actorId": string; "lastObservedTick": number; "reason": string }>; "sourceRefs"?: Array<string> };
"opportunity": { "cohortRef"?: string; "sourceId"?: string; "destinationId"?: (string | null); "startTick"?: number; "endTick"?: number; "eligibleActorIds"?: Array<string>; "viabilityStocks"?: Array<string>; "accessibleRouteRefs"?: Array<string>; "conditionRefs"?: Array<string>; "expectedFollowupTicks"?: number };
"applied-effect": { "actorId"?: string; "recipientId"?: string; "tick"?: number; "functionId"?: string; "unit"?: string; "bodyBefore"?: number; "bodyAfter"?: number; "baselineDelta"?: number; "appliedDelta"?: number; "consumedAmount"?: number; "consumptionRefs"?: Array<string>; "workRefs"?: Array<string>; "lawRef"?: string; "saturationLimit"?: (number | null); "sourceEventId"?: string; "sourceOrderRef"?: string };
"functional-map": { "signatureVersion"?: string; "capabilityOrder"?: Array<string>; "binEdges"?: Array<number>; "programCanonicalization"?: string; "functionDefinitions"?: Array<{ "functionId": string; "domain": string; "appliedEffectField": string; "unit": string; "noveltyRule": string }>; "historyOpeningRefs"?: Array<string>; "registeredRef"?: string };
"role-classification": { "classificationVersion"?: string; "registeredRef"?: string; "functionIds"?: Array<string>; "assignmentRule"?: string; "referenceCohortRef"?: string; "timeExposureRefs"?: Array<string>; "institutionRuleRefs"?: Array<string> };
"component-manifest": { "commitId"?: string; "tick"?: number; "components"?: Array<{ "component": "snapshot" | "inventories" | "identities" | "parentage" | "catalogue" | "authorship" | "receipts" | "chronicle" | "region-archive"; "itemId": string; "sha256": string; "count": number }>; "confirmedOrderIds"?: Array<string>; "historyUnknownPrefixRef"?: (string | null) };
"host-scene": { "hardwareId"?: string; "sceneId"?: string; "cpu"?: string; "ramBytes"?: number; "gpus"?: Array<string>; "drivers"?: Array<string>; "threads"?: number; "viewport"?: string; "population"?: number; "activeTiles"?: number; "warmupSeconds"?: number; "hostLoadSamples"?: Array<{ "seconds": number; "cpuLoad": number; "rssBytes": number; "externalLoadRef": string }>; "initialStateRef"?: string };
"preregistration": { "registrationId"?: string; "contentHash"?: string; "registeredAt"?: string; "firstDataAt"?: string; "plannedRunIds"?: Array<string>; "plannedSeeds"?: Array<number>; "arms"?: Array<string>; "interventions"?: Array<string>; "profileHash"?: string; "metricDefinitionsRef"?: string; "budgetRef"?: string; "controlPairRefs"?: Array<string>; "independentReceiptRef"?: string };
"seed-register": { "registeredAt"?: string; "entries"?: Array<{ "seed": number; "priorUses": Array<string>; "reservationStage": string; "reservedBeforeDataAt": string; "registryEvidenceRef": string }> };
"budget": { "budgetId"?: string; "stage"?: string; "dimensions"?: Array<{ "dimension": string; "unit": string; "plannedValue": number; "actualValue": (number | null) }>; "rewardFunctionRef"?: string; "interventionRefs"?: Array<string> };
"phase-decision": { "phase"?: string; "authority"?: string; "decision"?: "accepted" | "rejected" | "pending"; "at"?: string; "evidenceRefs"?: Array<string>; "receiptRef"?: string };
"personal-receipt": { "authority"?: "Steven"; "decision"?: "accepted" | "rejected" | "pending"; "contentHash"?: string; "at"?: string; "authorizedMemoryIds"?: Array<string>; "realMemoryInventoryRef"?: string; "localReceiptId"?: string; "provenanceRef"?: string };
"intervention": { "runId"?: string; "tick"?: number; "actorId"?: (string | null); "kind"?: string; "declaredBeforeData"?: boolean; "changes"?: Array<{ "field": string; "before": (number | null); "after": (number | null); "unit": string }>; "inputRefs"?: Array<string>; "protectedOriginIds"?: Array<string>; "receiptRef"?: string };
"parameter-set": { "sourceSHA"?: string; "paramsHash"?: string; "entries"?: Array<{ "name": string; "value": (number | string | boolean); "unit": string }> };
"conversion-matrix": { "version"?: string; "entries"?: Array<{ "inputMaterial": string; "inputUnit": string; "outputMaterial": string; "outputUnit": string; "coefficient": number }> };
"real-memory-inventory": { "contentHash"?: string; "inventoryScope"?: "all-real-memories-incorporated"; "complete"?: boolean; "entries"?: Array<{ "memoryId": string; "memoryHash": string; "incorporatedContentHash": string; "incorporated": boolean; "incorporationRef": string; "authorization": "accepted" | "rejected" | "pending" | "unknown"; "authorizationReceiptRef": (string | null) }> };
"memory-authorization": { "authority"?: "Steven"; "memoryId"?: string; "memoryHash"?: string; "contentHash"?: string; "decision"?: "accepted" | "rejected" | "pending"; "at"?: string; "localReceiptId"?: string; "provenanceRef"?: string };
"synthetic-review-oracle": { "authority"?: "synthetic-oracle"; "caseId"?: string; "contentHash"?: string; "inventoryRef"?: string; "expectedDecision"?: "accepted" | "rejected" | "pending"; "purpose"?: "technical-fixture-only" };
"source-metadata": { "sourceSHA"?: string; "sourcePath"?: string; "sourceLocation"?: string; "sha256"?: string; "role"?: "code" | "document" | "receipt-provenance" | "history-gap" | "seed-registry" };
"source-order": { "sourceSHA"?: string; "phaseOrder"?: Array<string>; "entries"?: Array<{ "sourceEventId": string; "tick": number; "phaseId": string; "phaseOrdinal": number; "eventOrdinal": number; "recordIds": Array<string> }> };
"reproduction-gates": { "attemptId"?: string; "opportunityId"?: string; "sourceOrderRef"?: string; "priority"?: Array<"local" | "global-quota" | "governor" | "anticorruption" | "other-software">; "gates"?: Array<{ "gateId": "local" | "global-quota" | "governor" | "anticorruption" | "other-software"; "ordinal": number; "result": "pass" | "block" | "not-reached" | "not-applicable" | "unknown"; "inputRefs": Array<string>; "reason": string }> };
"reproduction-coverage": { "startTick"?: number; "endTick"?: number; "opportunityRuleRef"?: string; "opportunities"?: Array<{ "opportunityId": string; "tick": number; "actorIds": Array<string>; "attemptRecordIds": Array<string>; "disposition": "attempted" | "not-attempted" | "unknown"; "reason": string }>; "stoppingPeriods"?: Array<{ "periodId": string; "startTick": number; "endTick": number; "reason": "local" | "global-quota" | "governor" | "anticorruption" | "other-software" | "unknown"; "opportunityIds": Array<string>; "attemptRecordIds": Array<string>; "decisionRefs": Array<string> }>; "coverageQuality"?: "COMPLETE" | "PARTIAL" | "UNAVAILABLE"; "gaps"?: Array<{ "startTick": number; "endTick": number; "reason": string }> };
"causal-pair": { "criterion"?: "C11" | "C17"; "registeredRef"?: string; "treatmentRunId"?: string; "controlRunId"?: string; "initialStateHash"?: string; "paramsHash"?: string; "inputTraceHash"?: string; "governorTraceHash"?: string; "interventionRefs"?: Array<string>; "functionIds"?: Array<string>; "normalization"?: "per-day" | "per-opportunity"; "windows"?: Array<{ "phase": "reference" | "removal" | "restoration"; "startTick": number; "endTick": number; "treatmentServiceRefs": Array<string>; "controlServiceRefs": Array<string>; "treatmentOpportunityRefs": Array<string>; "controlOpportunityRefs": Array<string>; "openingStockRefs": Array<string>; "closingStockRefs": Array<string>; "flowRefs": Array<string>; "exposureRefs": Array<string> }>; "treatmentManifestRef"?: string; "controlManifestRef"?: string; "equivalenceTolerance"?: number; "equivalenceUnit"?: string };
"metric-definitions": { "definitionVersion"?: string; "definitions"?: Array<{ "formulaId": string; "criterion": string; "expression": string; "unit": string; "requiredFields": Array<string>; "rewardEligible": boolean }> };
"run-manifest": { "runId"?: string; "sourceSHA"?: string; "seed"?: number; "paramsRef"?: string; "initialStateRef"?: string; "inputTraceRef"?: string; "governorTraceRef"?: string; "hardwareRef"?: string; "observationRef"?: string; "plannedStartTick"?: number; "plannedEndTick"?: number; "runStatus"?: "complete" | "aborted" | "partial" | "not-started"; "costRefs"?: Array<string>; "interventionRefs"?: Array<string>; "epochId"?: string; "artifactRole"?: "baseline" | "paired-control" | "paired-treatment" | "technical" | "experience" | "training" | "synthetic" | "legacy" };
}
export type ObservationRecord = { [F in Family]: {
  recordId: string; streamId: string; epochId: string; seq: number; tick: number; family: F;
  actorIds: string[]; protectedOriginIds: string[]; protectionStatus: 'none' | 'mixed' | 'protected' | 'unknown';
  provenanceRefs: string[]; payload: RecordPayloads[F]; fieldCoverage: Record<keyof RecordPayloads[F], FieldStatus>; causalContext: CausalContext;
} }[Family];
export type EvidenceDocument = { [K in EvidenceKind]: {
  contractVersion: typeof CONTRACT_VERSION; evidenceId: string; synthetic: boolean; kind: K; sourceRefs: string[];
  payload: EvidencePayloads[K]; fieldCoverage: Record<keyof EvidencePayloads[K], FieldStatus>;
} }[EvidenceKind];
export type SchemaName = 'observation.schema.json' | 'evidence.schema.json' | 'evaluation.schema.json';
export type ContractIssue = { code: string; path: string; message: string };
export interface ValidationReport<T = JsonObject> { valid: boolean; value?: T; issues: ContractIssue[]; unknowns: ContractIssue[]; }
export type CatalogItem = { value: JsonObject; entry: JsonObject; sha256: string; path: string; namespace?: Catalog };
export type Catalog = Map<string, CatalogItem>;
export interface BundleReport extends ValidationReport { catalog: Catalog; serviceLinks: ServiceLink[]; }
export interface ServiceLink { recordId: string; state: 'BOUND' | 'UNKNOWN'; reasons: string[]; condition?: number; appliedValue?: number; baselineAvailable: boolean; }

const schemaDir = fileURLToPath(new URL('../../specs/003-criterios-realismo/contracts/', import.meta.url));
export const SCHEMA_SHA256: Record<SchemaName, string> = {
  'observation.schema.json': 'de07d954cbb8d084bd0337723a947cc7c29ed9f385571dae42b3a060b74b1628',
  'evaluation.schema.json': 'f2d4f85be8541b4ff546fc4a037d0c0536c776e34168db5fe914f10eabe59a54',
  'evidence.schema.json': '0752c2f94b90030e1bff534b037f4f2b0de1abd5b0c6966e769638ed13d21983',
};
export const THRESHOLD_PROFILE_SHA256 = 'd99e24ee85f379164c1dd0d351a0cdb204d8bf1dda0e446abd70cfe582e4b7cb';
export const REFERENCE_REGISTRY_SHA256 = 'a6d128667f84e95253901d20e86dffb85f93a62ca4d67bdb9ce1ea6eb2697d69';
export const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value: object, key: string): boolean => Object.hasOwn(value, key);
const issue = (code: string, path: string, message: string): ContractIssue => ({ code, path, message });
const schemas = Object.fromEntries(Object.entries(SCHEMA_SHA256).map(([name, hash]) => {
  const bytes = readFileSync(resolve(schemaDir, name));
  if (sha256(bytes) !== hash) throw new Error(`Pinned schema changed: ${name}`);
  return [name, JSON.parse(bytes.toString('utf8'))];
})) as Record<SchemaName, JsonObject>;
// These canonical schemas omit redundant type/required declarations inside applicators.
// Disable only schema-author lint rules, never instance validation/coercion or formats.
const ajv = new Ajv2020({ allErrors: true, strictSchema: true, strictNumbers: true,
  strictTypes: false, strictRequired: false, allowUnionTypes: true,
  coerceTypes: false, useDefaults: false, removeAdditional: false, validateFormats: true });
const validators = new Map<SchemaName, ValidateFunction>();
function validator(name: SchemaName): ValidateFunction {
  let value = validators.get(name);
  if (!value) { value = ajv.compile(schemas[name]); validators.set(name, value); }
  return value;
}
const integerFields = new Set<string>();
const integerArrayFields = new Set<string>();
function collectIntegerFields(value: unknown): void {
  if (!object(value)) { if (Array.isArray(value)) value.forEach(collectIntegerFields); return; }
  if (object(value.properties)) for (const [key, schema] of Object.entries(value.properties)) {
    if (key !== 'value' && object(schema) && (schema.type === 'integer' ||
      (Array.isArray(schema.anyOf) && schema.anyOf.some(x => object(x) && x.type === 'integer')))) integerFields.add(key);
    if (object(schema) && object(schema.items) && schema.items.type === 'integer') integerArrayFields.add(key);
  }
  Object.values(value).forEach(collectIntegerFields);
}
Object.values(schemas).forEach(collectIntegerFields);

function exactInteger(raw: string): bigint | undefined {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match) return undefined;
  const fraction = match[3] ?? ''; const digits = (match[2] + fraction).replace(/^0+/, '') || '0';
  let magnitude = BigInt(digits); if (magnitude === 0n) return 0n;
  const scale = fraction.length - Number(match[4] ?? 0);
  if (!Number.isSafeInteger(scale)) return undefined;
  if (scale > 0) {
    if (scale > digits.length) return undefined;
    const divisor = 10n ** BigInt(scale); if (magnitude % divisor !== 0n) return undefined;
    magnitude /= divisor;
  } else {
    if (digits.length - scale > 16) return undefined;
    magnitude *= 10n ** BigInt(-scale);
  }
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return match[1] ? -magnitude : magnitude;
}

/** JSON grammar first; duplicate decoded keys and integer lexemes are checked before data is trusted. */
export function parseStrictJSON(text: string): JsonValue {
  const value: unknown = JSON.parse(text);
  const tree = parseTree(text);
  if (!tree) throw new Error('INVALID_JSON_TREE');
  function walk(node: JSONNode, path: string): void {
    if (node.type === 'object') {
      const names = new Set<string>();
      for (const property of node.children ?? []) {
        const key = String(property.children?.[0]?.value);
        if (names.has(key)) throw new Error(`DUPLICATE_KEY ${path}/${key}`);
        names.add(key);
      }
    }
    if (node.type === 'number') {
      if (!Number.isFinite(node.value)) throw new Error(`NON_FINITE_NUMBER ${path}`);
      if (Number.isInteger(node.value) && !Number.isSafeInteger(node.value)) throw new Error(`UNSAFE_INTEGER ${path}`);
      const property = node.parent?.type === 'property' ? node.parent : undefined;
      const key = property?.children?.[0]?.value;
      const parent = property?.parent;
      const unit = parent?.children?.find(p => p.children?.[0]?.value === 'unit')?.children?.[1]?.value;
      const arrayKey = node.parent?.type === 'array' && node.parent.parent?.type === 'property'
        ? node.parent.parent.children?.[0]?.value : undefined;
      if ((typeof key === 'string' && integerFields.has(key)) || (key === 'value' && ['quanta', 'ticks', 'bytes', 'count'].includes(String(unit))) ||
          (typeof arrayKey === 'string' && integerArrayFields.has(arrayKey))) {
        const exact = exactInteger(text.slice(node.offset, node.offset + node.length));
        if (exact === undefined || Number(exact) !== node.value) throw new Error(`INVALID_INTEGER_LEXEME ${path}`);
      }
    }
    (node.children ?? []).forEach((child, n) => walk(child, `${path}/${n}`));
  }
  walk(tree, '');
  return value as JsonValue;
}
function numericIssues(value: unknown, path = '', seen = new Set<object>()): ContractIssue[] {
  if (typeof value === 'number') return !Number.isFinite(value) ? [issue('NON_FINITE_NUMBER', path, 'Number must be finite')]
    : Number.isInteger(value) && !Number.isSafeInteger(value) ? [issue('UNSAFE_INTEGER', path, 'Integer exceeds safe range')] : [];
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return [];
  if (typeof value !== 'object') return [issue('NON_JSON_VALUE', path, 'JSON values only')];
  if (seen.has(value)) return [issue('CYCLIC_INPUT', path, 'JSON cannot contain object cycles')];
  seen.add(value);
  const result = Object.entries(value).flatMap(([key, child]) => numericIssues(child, `${path}/${key}`, seen));
  seen.delete(value); return result;
}
export function validateShape(name: SchemaName, input: unknown): ValidationReport {
  let value = input;
  try { if (typeof input === 'string') value = parseStrictJSON(input); }
  catch (error) { return { valid: false, issues: [issue('INVALID_JSON', '', String(error))], unknowns: [] }; }
  const issues = numericIssues(value);
  if (!issues.length) {
    const validate = validator(name);
    if (!validate(value)) issues.push(...(validate.errors ?? []).map(e => issue('SCHEMA', e.instancePath, `${e.keyword}: ${e.message}`)));
  }
  return { valid: !issues.length, value: object(value) ? value : undefined, issues, unknowns: [] };
}
function coverageIssues(doc: JsonObject, path: string): ContractIssue[] {
  if (!object(doc.payload) || !object(doc.fieldCoverage)) return [];
  const payload = doc.payload; const coverage = doc.fieldCoverage; const issues: ContractIssue[] = [];
  for (const [key, status] of Object.entries(coverage)) if (object(status)) {
    if ((status.status === 'observed') !== has(payload, key)) issues.push(issue('FIELD_COVERAGE', `${path}/${key}`, 'Observed requires a present property; missing/not-applicable requires absence'));
  }
  return issues;
}
function windowIssues(window: unknown, path: string): ContractIssue[] {
  if (!object(window)) return [];
  return Number(window.startTick) > Number(window.endTick) ? [issue('WINDOW_ORDER', path, 'Opening exceeds closing')] : [];
}
const profileBytes = readFileSync(resolve(schemaDir, 'thresholds.v3.json'));
if (sha256(profileBytes) !== THRESHOLD_PROFILE_SHA256) throw new Error('Pinned threshold profile changed');
const profile = JSON.parse(profileBytes.toString('utf8')) as JsonObject;
export function validateSemantics(name: SchemaName, input: unknown): ValidationReport {
  const report = validateShape(name, input); if (!report.valid || !report.value) return report;
  const doc = report.value; const issues = report.issues; const unknowns = report.unknowns;
  if (name === 'evidence.schema.json') issues.push(...coverageIssues(doc, 'evidence'));
  if (name === 'evaluation.schema.json') {
    const results = doc.results as JsonObject[];
    const ids = results.map(r => r.criterionId ?? r.criterion);
    if (new Set(ids).size !== 16) issues.push(issue('CRITERION_IDS', 'results', 'Exactly one result per C9–C24'));
    for (const result of results) {
      const rule = (profile.criteria as JsonObject[]).find(c => c.criterion === result.criterion);
      const gates = result.subgates as JsonObject[]; const gateIds = gates.map(g => g.subgateId);
      if (!rule || new Set(gateIds).size !== gateIds.length ||
          (rule.requiredSubgates as JsonValue[]).some(id => !gateIds.includes(id)) ||
          gateIds.some(id => !(rule.requiredSubgates as JsonValue[]).includes(id)))
        issues.push(issue('RESULT_SUBGATES', `results/${result.criterion}`, 'Subgates must uniquely match the pinned criterion profile'));
      const thresholds = rule ? (rule.thresholds as JsonObject[]).map(t => t.thresholdId) : [];
      for (const gate of gates) if ((gate.thresholdIds as JsonValue[]).some(id => !thresholds.includes(id)))
        issues.push(issue('THRESHOLD_OWNERSHIP', `results/${result.criterion}/${gate.subgateId}`, 'Threshold must belong to the result criterion'));
    }
    for (const panel of doc.panels as JsonObject[]) {
      if (Number(panel.pass) + Number(panel.fail) + Number(panel.unknown) !== Number(panel.total) || panel.total !== (panel.plannedSeeds as JsonValue[]).length)
        issues.push(issue('PANEL_TOTAL', 'panels', 'All planned runs remain in denominator'));
    }
  }
  if (name === 'observation.schema.json') {
    const records = doc.records as JsonObject[]; const streams = doc.streams as JsonObject[];
    issues.push(...windowIssues(doc.plannedWindow, 'plannedWindow'), ...windowIssues(doc.actualWindow, 'actualWindow'));
    const actual = doc.actualWindow as JsonObject; const planned = doc.plannedWindow as JsonObject;
    if (actual.epochId !== doc.epochId || planned.epochId !== doc.epochId || Number(actual.startTick) < Number(planned.startTick) || Number(actual.endTick) > Number(planned.endTick))
      issues.push(issue('WINDOW_IDENTITY', 'actualWindow', 'Actual window must belong to epoch and lie inside planned window'));
    const capabilities = doc.capabilities as JsonObject[];
    if (new Set(capabilities.map(c => c.family)).size !== FAMILIES.length) issues.push(issue('CAPABILITY_FAMILIES', 'capabilities', 'One capability per family'));
    const recordIds = new Set<JsonValue>(); const sequences = new Set<string>(); const streamIds = new Set<JsonValue>();
    for (const stream of streams) {
      if (streamIds.has(stream.streamId)) issues.push(issue('DUPLICATE_STREAM', 'streams', String(stream.streamId)));
      streamIds.add(stream.streamId); issues.push(...windowIssues(stream.window, `streams/${stream.streamId}`));
      const window = stream.window as JsonObject;
      if (stream.epochId !== doc.epochId || window.epochId !== doc.epochId || Number(window.startTick) < Number(actual.startTick) || Number(window.endTick) > Number(actual.endTick))
        issues.push(issue('STREAM_EPOCH_WINDOW', 'streams', String(stream.streamId)));
      const list = records.filter(r => r.streamId === stream.streamId);
      if (list.length !== stream.observedRecords) issues.push(issue('OBSERVED_COUNT', 'streams', String(stream.streamId)));
      if (stream.quality === 'UNAVAILABLE' && list.length) issues.push(issue('UNAVAILABLE_RECORDS', 'streams', String(stream.streamId)));
      if (stream.quality === 'COMPLETE') {
        const fields = stream.requiredFields as string[]; const covered = stream.coveredFields as string[];
        if (list.some(r => fields.some(f => !object((r.fieldCoverage as JsonObject)[f]) || ((r.fieldCoverage as JsonObject)[f] as JsonObject).status !== 'observed')))
          issues.push(issue('COMPLETE_RECORD_FIELDS', 'streams', String(stream.streamId)));
        if (!fields.length || fields.some(f => !covered.includes(f)) || (stream.gaps as JsonValue[]).length || stream.expectedRecords === null || stream.expectedRecords !== list.length)
          issues.push(issue('COMPLETE_COVERAGE', 'streams', String(stream.streamId)));
        if (!list.length) {
          if (stream.firstSeq !== null || stream.lastSeq !== null) issues.push(issue('EMPTY_SEQUENCE', 'streams', String(stream.streamId)));
        } else if (stream.firstSeq !== list[0].seq || stream.lastSeq !== list.at(-1)?.seq || list.some((r, i) => r.seq !== Number(stream.firstSeq) + i))
          issues.push(issue('COMPLETE_SEQUENCE', 'streams', String(stream.streamId)));
      }
      if (list.some((r, i) => i > 0 && Number(r.seq) <= Number(list[i - 1].seq))) issues.push(issue('SEQUENCE_ORDER', 'streams', String(stream.streamId)));
    }
    const transfers = new Map<JsonValue, JsonObject>();
    for (const record of records) {
      issues.push(...coverageIssues(record, `records/${record.recordId}`));
      if (recordIds.has(record.recordId)) issues.push(issue('DUPLICATE_RECORD', 'records', String(record.recordId)));
      recordIds.add(record.recordId);
      const key = JSON.stringify([record.epochId, record.streamId, record.seq]);
      if (sequences.has(key)) issues.push(issue('DUPLICATE_SEQUENCE', 'records', key)); sequences.add(key);
      const stream = streams.find(s => s.streamId === record.streamId); const causal = record.causalContext as JsonObject;
      if (!stream || stream.family !== record.family || stream.epochId !== record.epochId || record.epochId !== doc.epochId)
        issues.push(issue('RECORD_STREAM_IDENTITY', 'records', String(record.recordId)));
      const payload = record.payload as JsonObject;
      const openingSnapshot = causal.status === 'snapshot' && (record.family === 'boundary' || (record.family === 'stock' && payload.phase === 'opening'));
      if (Number(record.tick) > Number(actual.endTick) || Number(record.tick) < Number(actual.startTick) || (record.tick === actual.startTick && !openingSnapshot))
        issues.push(issue('RECORD_WINDOW', 'records', String(record.recordId)));
      if (stream) {
        const window = stream.window as JsonObject;
        if (Number(record.tick) > Number(window.endTick) || Number(record.tick) < Number(window.startTick) ||
            (record.tick === window.startTick && !openingSnapshot))
          issues.push(issue('RECORD_STREAM_WINDOW', `records/${record.recordId}`, 'Record must lie in its own stream window'));
      }
      if (causal.status === 'ordered') {
        if (['sourceEventId', 'phaseId', 'phaseOrdinal', 'eventOrdinal', 'sourceOrderRef'].some(k => causal[k] === null))
          unknowns.push(issue('CAUSAL_ORDER_UNAVAILABLE', `records/${record.recordId}`, 'Source order is unavailable'));
      } else if (['sourceEventId', 'phaseId', 'phaseOrdinal', 'eventOrdinal', 'sourceOrderRef'].some(k => causal[k] !== null))
        issues.push(issue('UNORDERED_CONTEXT', 'records', String(record.recordId)));
      if (record.family === 'flow' && has(payload, 'transferId')) {
        const previous = transfers.get(payload.transferId);
        if (previous) {
          const prior = previous.payload as JsonObject;
          const same = ['boundaryId', 'fromStockId', 'toStockId', 'flowType', 'quantity'].every(k => JSON.stringify(prior[k]) === JSON.stringify(payload[k]));
          const linked = prior.counterpartRecordId === record.recordId && payload.counterpartRecordId === previous.recordId &&
            (previous.provenanceRefs as JsonValue[]).includes(record.recordId) && (record.provenanceRefs as JsonValue[]).includes(previous.recordId);
          if (!same || !linked) issues.push(issue('DUPLICATE_TRANSFER', `records/${record.recordId}`, String(payload.transferId)));
        } else transfers.set(payload.transferId, record);
      }
    }
    for (const record of records) {
      if (record.protectionStatus === 'none' && (record.protectedOriginIds as JsonValue[]).length)
        issues.push(issue('PROTECTION_CONTRADICTION', `records/${record.recordId}`, 'Known protected origin cannot be declared none'));
      if (record.family !== 'stock') continue;
      const p = record.payload as JsonObject;
      if (p.phase === 'closing') {
        const opening = records.find(r => r.family === 'stock' && (r.payload as JsonObject).stockId === p.stockId &&
          (r.payload as JsonObject).boundaryId === p.boundaryId && (r.payload as JsonObject).phase === 'opening');
        if (!opening) unknowns.push(issue('MISSING_OPENING_CUT', `records/${record.recordId}`, 'Closing without a known opening cannot certify conservation'));
      }
      if (p.scale === 'active' && has(p, 'clockTick') && p.clockTick !== record.tick)
        unknowns.push(issue('ASYNCHRONOUS_CUT', `records/${record.recordId}`, 'Stock clock and boundary tick differ'));
    }
    for (const cap of capabilities) {
      if (cap.status === 'unavailable' && (records.some(r => r.family === cap.family) || streams.some(stream => stream.family === cap.family && stream.quality === 'COMPLETE')))
        issues.push(issue('UNAVAILABLE_CAPABILITY_RECORDS', 'capabilities', String(cap.family)));
      if ((cap.availableFields as JsonValue[]).some(f => (cap.missingFields as JsonValue[]).includes(f)))
        issues.push(issue('CAPABILITY_FIELD_CONTRADICTION', 'capabilities', String(cap.family)));
    }
  }
  report.valid = !issues.length; return report;
}

const registryBytes = readFileSync(resolve(schemaDir, 'reference-types.v3.json'));
if (sha256(registryBytes) !== REFERENCE_REGISTRY_SHA256) throw new Error('Pinned reference registry changed');
const referenceRegistry = JSON.parse(registryBytes.toString('utf8')).references as
  Array<{ schema: SchemaName; schemaPointer: string; field: string; targets: string[] }>;

/** Resolve only a declared local file; both lexical traversal and escaped symlinks are rejected. */
export function confinedInputPath(inputRoot: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || /^[a-z][a-z0-9+.-]*:/i.test(relativePath) ||
      relativePath.includes('\\') || relativePath.split('/').some(c => c === '..')) throw new Error('UNSAFE_INPUT_PATH');
  const root = realpathSync(inputRoot); const target = realpathSync(resolve(root, relativePath));
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error('INPUT_SYMLINK_ESCAPE');
  return target;
}
function referencedValues(schema: unknown, data: unknown, tokens: string[], path = ''): Array<{ value: unknown; path: string }> {
  if (!tokens.length) return [{ value: data, path }];
  if (!object(schema)) return [];
  const [operation, name, ...rest] = tokens;
  if (operation === 'properties') {
    if (!object(schema.properties) || !object(data) || !has(data, name)) return [];
    return referencedValues(schema.properties[name], data[name], rest, `${path}/${name}`);
  }
  if (operation === 'items') return Array.isArray(data)
    ? data.flatMap((v, i) => referencedValues(schema.items, v, tokens.slice(1), `${path}/${i}`)) : [];
  if (['oneOf', 'anyOf', 'allOf'].includes(operation)) {
    const alternatives = schema[operation]; if (!Array.isArray(alternatives)) return [];
    const branch = alternatives[Number(name)];
    if (object(branch) && object(branch.properties) && object(data)) {
      for (const key of ['kind', 'family']) {
        const discriminator = branch.properties[key];
        if (object(discriminator) && has(discriminator, 'const') && data[key] !== discriminator.const) return [];
      }
    }
    return referencedValues(branch, data, rest, path);
  }
  return [];
}
/** A definition is metadata, not a root instance property: find its actual $ref uses. */
function definitionReferenceValues(root: JsonObject, data: JsonObject, tokens: string[]): Array<{ value: unknown; path: string }> {
  const definitionName = tokens[1];
  const wanted = `#/$defs/${definitionName}`;
  const locations = new Map<string, { value: unknown; path: string }>();
  function visit(schema: unknown, value: unknown, path: string, refs: Set<string>): void {
    if (!object(schema)) return;
    if (object(schema.properties) && object(value)) for (const key of ['kind', 'family']) {
      const discriminator = schema.properties[key];
      if (object(discriminator) && has(discriminator, 'const') && value[key] !== discriminator.const) return;
    }
    if (typeof schema.$ref === 'string') {
      if (!schema.$ref.startsWith('#/$defs/') || refs.has(schema.$ref)) return;
      const name = schema.$ref.slice('#/$defs/'.length).replace(/~1/g, '/').replace(/~0/g, '~');
      const definition = object(root.$defs) ? root.$defs[name] : undefined;
      if (schema.$ref === wanted) for (const location of referencedValues(definition, value, tokens.slice(2), path))
        locations.set(location.path, location);
      visit(definition, value, path, new Set([...refs, schema.$ref]));
    }
    if (object(schema.properties) && object(value)) for (const [key, child] of Object.entries(schema.properties))
      if (has(value, key)) visit(child, value[key], `${path}/${key}`, refs);
    if (Array.isArray(value)) value.forEach((child, index) => visit(schema.items, child, `${path}/${index}`, refs));
    for (const applicator of ['oneOf', 'anyOf', 'allOf']) {
      const branches = schema[applicator];
      if (Array.isArray(branches)) branches.forEach(branch => visit(branch, value, path, refs));
    }
  }
  visit(root, data, '', new Set());
  return [...locations.values()];
}
/** An explicit unavailable marker cannot acquire support by being indexed under that ID. */
function availableReference(ref: unknown): ref is string {
  return typeof ref === 'string' && !ref.startsWith('unavailable:');
}
function referencedItem(catalog: Catalog, ref: unknown): CatalogItem | undefined {
  return availableReference(ref) ? catalog.get(ref) : undefined;
}
function targetOf(ref: unknown, observation: JsonObject, catalog: Catalog): { type: string; value: JsonObject } | undefined {
  if (!availableReference(ref)) return undefined;
  const marker = ref.indexOf('#');
  if (marker >= 0) {
    const bundle = referencedItem(catalog, ref.slice(0, marker))?.value;
    if (bundle?.kind !== 'observation') return undefined;
    const record = (bundle.records as JsonObject[]).find(r => r.recordId === ref.slice(marker + 1));
    return record ? { type: `record:${record.family}`, value: record } : undefined;
  }
  const record = (observation.records as JsonObject[]).find(r => r.recordId === ref);
  if (record) return { type: `record:${record.family}`, value: record };
  const item = referencedItem(catalog, ref);
  return item ? { type: ['observation', 'evaluation'].includes(String(item.value.kind)) ? `bundle:${item.value.kind}` : `evidence:${item.value.kind}`, value: item.value } : undefined;
}
function referenceIssues(name: SchemaName, doc: JsonObject, observation: JsonObject, catalog: Catalog): Pick<ValidationReport, 'issues' | 'unknowns'> {
  const issues: ContractIssue[] = []; const unknowns: ContractIssue[] = [];
  for (const definition of referenceRegistry.filter(r => r.schema === name)) {
    const tokens = definition.schemaPointer.split('/').slice(1);
    const locations = tokens[0] === '$defs' ? definitionReferenceValues(schemas[name], doc, tokens)
      : referencedValues(schemas[name], doc, tokens);
    for (const location of locations) for (const ref of Array.isArray(location.value) ? location.value : [location.value]) {
      if (ref === null) continue;
      if (typeof ref !== 'string') { issues.push(issue('REFERENCE_TYPE', location.path, 'Reference must be a string')); continue; }
      let scopedObservation = observation; let scopedCatalog = catalog;
      if (doc.kind === 'evaluation') {
        const input = referencedItem(catalog, doc.inputObservationRef);
        if (input?.value.kind === 'observation') {
          scopedObservation = input.value; scopedCatalog = new Map([...catalog, ...(input.namespace ?? [])]);
        }
      } else if (doc.kind === 'causal-pair' && object(doc.payload)) {
        const arm = location.path.includes('treatmentServiceRefs') || location.path.includes('treatmentOpportunityRefs') ? 'treatment'
          : location.path.includes('controlServiceRefs') || location.path.includes('controlOpportunityRefs') ? 'control' : undefined;
        if (arm) {
          const manifest = referencedItem(catalog, doc.payload[`${arm}ManifestRef`])?.value.payload;
          const input = object(manifest) ? referencedItem(catalog, manifest.observationRef) : undefined;
          if (!input || input.value.kind !== 'observation') {
            unknowns.push(issue('PAIR_NAMESPACE_UNAVAILABLE', location.path, ref)); continue;
          }
          if (ref.includes('#') && ref.split('#')[0] !== input.value.evidenceId) {
            issues.push(issue('PAIR_REFERENCE_SCOPE', location.path, ref)); continue;
          }
          scopedObservation = input.value; scopedCatalog = new Map([...catalog, ...(input.namespace ?? [])]);
        } else if (/openingStockRefs|closingStockRefs|flowRefs|exposureRefs/.test(location.path) && !ref.includes('#')) {
          unknowns.push(issue('PAIR_NAMESPACE_UNAVAILABLE', location.path, ref)); continue;
        }
      }
      const target = targetOf(ref, scopedObservation, scopedCatalog);
      if (!target || ref.startsWith('unavailable:')) unknowns.push(issue('REFERENCE_UNAVAILABLE', location.path, ref));
      else if (!definition.targets.includes(target.type)) issues.push(issue('REFERENCE_TARGET_TYPE', location.path, `${ref} resolves to ${target.type}`));
    }
  }
  return { issues, unknowns };
}
function bindingIssues(catalog: Catalog): Pick<ValidationReport, 'issues' | 'unknowns'> {
  const issues: ContractIssue[] = []; const unknowns: ContractIssue[] = [];
  for (const [id, item] of catalog) if (item.value.kind === 'observation') {
    const observation = item.value; const scope = item.namespace ?? catalog;
    const params = referencedItem(scope, observation.paramsRef)?.value.payload;
    const inputs = referencedItem(scope, observation.inputTraceRef)?.value.payload;
    for (const [payload, fields, label] of [[params, ['paramsHash'], 'params'], [inputs, ['paramsHash', 'initialStateHash'], 'inputs']] as const) {
      for (const field of fields) {
        if (!object(payload) || !has(payload, field)) unknowns.push(issue('PHYSICAL_BINDING_UNAVAILABLE', `${id}/${label}/${field}`, 'Physical identity is not observed'));
        else if (payload[field] !== observation[field]) issues.push(issue('PHYSICAL_BINDING', `${id}/${label}/${field}`, 'Observation and indexed physical input disagree'));
      }
    }
  }
  for (const [id, item] of catalog) {
    const doc = item.value;
    if (doc.kind === 'run-manifest') {
      const payload = doc.payload as JsonObject;
      if (!has(payload, 'observationRef')) continue; // Missing typed partial data remains unavailable.
      if (!availableReference(payload.observationRef)) { unknowns.push(issue('MANIFEST_BINDING_UNAVAILABLE', id, 'Referenced observation is explicitly unavailable')); continue; }
      const target = referencedItem(catalog, payload.observationRef);
      if (!target || target.value.kind !== 'observation') { issues.push(issue('MANIFEST_BINDING', id, 'Manifest observationRef must resolve to an indexed observation')); continue; }
      const bundle = target.value;
      for (const key of ['runId', 'epochId', 'artifactRole', 'sourceSHA', 'seed', 'paramsRef', 'inputTraceRef', 'governorTraceRef', 'hardwareRef', 'runStatus'])
        if (has(payload, key) && payload[key] !== bundle[key]) issues.push(issue('MANIFEST_IDENTITY', `${id}/${key}`, 'Manifest and observation disagree'));
      const planned = bundle.plannedWindow as JsonObject;
      if ((has(payload, 'plannedStartTick') && payload.plannedStartTick !== planned.startTick) ||
          (has(payload, 'plannedEndTick') && payload.plannedEndTick !== planned.endTick) || doc.synthetic !== bundle.synthetic)
        issues.push(issue('MANIFEST_WINDOW', id, 'Window/synthetic identity disagrees'));
      const params = referencedItem(catalog, payload.paramsRef)?.value.payload;
      if (!object(params) || !has(params, 'paramsHash')) unknowns.push(issue('PHYSICAL_BINDING_UNAVAILABLE', `${id}/paramsHash`, 'Parameter identity is not observed'));
      else if (params.paramsHash !== bundle.paramsHash) issues.push(issue('PARAMETER_HASH', id, 'Parameter identity disagrees'));
      const initial = referencedItem(catalog, payload.initialStateRef)?.value.payload;
      if (!object(initial) || !Array.isArray(initial.components)) unknowns.push(issue('INITIAL_STATE_UNAVAILABLE', id, 'Initial snapshot proof is absent'));
      else if (!initial.components.some(c => object(c) && c.component === 'snapshot' && c.sha256 === bundle.initialStateHash))
        issues.push(issue('INITIAL_STATE_HASH', id, 'Initial cut does not identify observation initial state'));
    }
    if (doc.kind === 'evaluation') {
      if (!availableReference(doc.inputObservationRef)) { unknowns.push(issue('EVALUATION_BINDING_UNAVAILABLE', id, 'Referenced observation is explicitly unavailable')); continue; }
      const target = referencedItem(catalog, doc.inputObservationRef);
      if (!target || target.value.kind !== 'observation') { issues.push(issue('EVALUATION_BINDING', id, 'Evaluation input must resolve')); continue; }
      const observation = target.value;
      if (['runId', 'epochId', 'artifactRole', 'synthetic', 'thresholdProfileHash'].some(k => doc[k] !== observation[k]) ||
          !(doc.inputHashes as JsonValue[]).includes(target.sha256)) issues.push(issue('EVALUATION_IDENTITY', id, 'Evaluation identity/hash differs from input'));
      const knownHashes = new Set([...catalog.values()].map(i => i.sha256));
      if ((doc.inputHashes as JsonValue[]).some(h => !knownHashes.has(String(h)))) issues.push(issue('EVALUATION_INPUT_HASH', id, 'Input hash is not an indexed input'));
    }
    if (doc.kind === 'causal-pair') {
      const p = doc.payload as JsonObject;
      const treatment = referencedItem(catalog, p.treatmentManifestRef)?.value.payload;
      const control = referencedItem(catalog, p.controlManifestRef)?.value.payload;
      if (!object(treatment) || !object(control)) continue;
      const a = referencedItem(catalog, treatment.observationRef)?.value;
      const b = referencedItem(catalog, control.observationRef)?.value;
      if (!a || !b) continue;
      if (a.runId === b.runId || a.runId !== p.treatmentRunId || b.runId !== p.controlRunId ||
          a.artifactRole !== 'paired-treatment' || b.artifactRole !== 'paired-control' ||
          a.pairedRunId !== b.runId || b.pairedRunId !== a.runId ||
          ['sourceSHA', 'seed', 'paramsHash', 'initialStateHash', 'epochId'].some(k => a[k] !== b[k]) ||
          JSON.stringify(a.plannedWindow) !== JSON.stringify(b.plannedWindow))
        issues.push(issue('PAIR_BINDING', id, 'Pair manifests and scoped observations disagree'));
      for (const input of [a, b]) {
        for (const key of ['paramsHash', 'initialStateHash']) {
          if (!has(p, key)) unknowns.push(issue('PAIR_IDENTITY_UNAVAILABLE', `${id}/${key}`, 'Declared physical identity is absent'));
          else if (p[key] !== input[key]) issues.push(issue('PAIR_IDENTITY', `${id}/${key}`, 'Pair declaration and arm disagree'));
        }
        const arm = catalog.get(String(input.evidenceId)); const scope = arm?.namespace ?? catalog;
        for (const [hashField, refField] of [['inputTraceHash', 'inputTraceRef'], ['governorTraceHash', 'governorTraceRef']]) {
          const trace = referencedItem(scope, input[refField]);
          if (!trace || !has(p, hashField)) unknowns.push(issue('PAIR_TRACE_UNAVAILABLE', `${id}/${hashField}`, 'Declared trace support is absent'));
          else if (p[hashField] !== trace.sha256) issues.push(issue('PAIR_TRACE_HASH', `${id}/${hashField}`, 'Pair declaration and indexed trace bytes disagree'));
        }
      }
    }
  }
  return { issues, unknowns };
}
const causalKey = (record: JsonObject): string => {
  const c = record.causalContext as JsonObject;
  return JSON.stringify([record.tick, c.sourceEventId, c.phaseId, c.phaseOrdinal, c.eventOrdinal, c.sourceOrderRef]);
};
function sourceOrderMapped(record: JsonObject, sourceSHA: JsonValue, catalog: Catalog): boolean {
  const c = record.causalContext as JsonObject;
  if (c.status !== 'ordered' || typeof c.sourceOrderRef !== 'string') return false;
  const order = referencedItem(catalog, c.sourceOrderRef)?.value;
  if (order?.kind !== 'source-order' || !object(order.payload)) return false;
  const p = order.payload;
  if (p.sourceSHA !== sourceSHA || !Array.isArray(p.entries) || !Array.isArray(p.phaseOrder) || p.phaseOrder[Number(c.phaseOrdinal)] !== c.phaseId) return false;
  const matching = p.entries.filter(entry => object(entry) && entry.sourceEventId === c.sourceEventId && entry.tick === record.tick &&
    entry.phaseId === c.phaseId && entry.phaseOrdinal === c.phaseOrdinal && entry.eventOrdinal === c.eventOrdinal &&
    Array.isArray(entry.recordIds) && entry.recordIds.includes(record.recordId));
  if (matching.length !== 1) return false;
  const orderKeys = p.entries.map(entry => object(entry) ? JSON.stringify([entry.tick, entry.phaseOrdinal, entry.eventOrdinal]) : 'invalid');
  if (new Set(orderKeys).size !== orderKeys.length) return false;
  return true;
}
function orderedAtSource(record: JsonObject, sourceSHA: JsonValue, catalog: Catalog, records: JsonObject[] = []): boolean {
  const position = (r: JsonObject): number[] => {
    const rc = r.causalContext as JsonObject;
    return [Number(r.tick), rc.status === 'snapshot' ? -1 : Number(rc.phaseOrdinal), rc.status === 'snapshot' ? -1 : Number(rc.eventOrdinal)];
  };
  const later = (a: number[], b: number[]): boolean => a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
  const visiting = new Set<JsonValue>();
  function acyclic(r: JsonObject): boolean {
    if (visiting.has(r.recordId)) return false;
    visiting.add(r.recordId);
    const rc = r.causalContext as JsonObject;
    if (rc.status === 'unknown' || (rc.status === 'ordered' && !sourceOrderMapped(r, sourceSHA, catalog))) return false;
    for (const id of rc.predecessorRecordIds as JsonValue[]) {
      const predecessor = availableReference(id) ? records.find(x => x.recordId === id) : undefined;
      if (!predecessor || later(position(predecessor), position(r)) || (predecessor.causalContext as JsonObject).status === 'unknown' || !acyclic(predecessor)) return false;
    }
    visiting.delete(r.recordId); return true;
  }
  return (record.causalContext as JsonObject).status === 'ordered' && acyclic(record);
}
/** Convert only through the declared boundary/flow matrix; no implicit unit or material sum. */
function declaredDebitAmount(flows: JsonObject[], records: JsonObject[], catalog: Catalog): number | undefined {
  const conversions: Array<{ transferId: string; possibilities: Array<{ dimension: string; amount: number }> }> = [];
  const canonical = new Map<string, JsonObject>();
  for (const flow of flows) {
    const p = flow.payload as JsonObject;
    if (typeof p.transferId !== 'string' || !p.transferId) return undefined;
    const prior = canonical.get(p.transferId);
    if (prior) {
      const q = prior.payload as JsonObject;
      const same = ['boundaryId', 'fromStockId', 'toStockId', 'flowType', 'quantity'].every(k => JSON.stringify(q[k]) === JSON.stringify(p[k]));
      const linked = q.counterpartRecordId === flow.recordId && p.counterpartRecordId === prior.recordId &&
        (prior.provenanceRefs as JsonValue[]).includes(flow.recordId) && (flow.provenanceRefs as JsonValue[]).includes(prior.recordId);
      if (!same || !linked) return undefined;
    } else canonical.set(p.transferId, flow);
  }
  // Every projection's declared support must resolve, even when its physical debit is shared.
  for (const flow of flows) {
    const p = flow.payload as JsonObject; const quantity = p.quantity;
    if (!object(quantity) || typeof quantity.value !== 'number') return undefined;
    const boundary = records.find(r => r.family === 'boundary' && (r.payload as JsonObject).boundaryId === p.boundaryId);
    // The schema's nullable conversionRef explicitly selects the declared boundary fallback.
    const ref = !has(p, 'conversionRef') || p.conversionRef === null
      ? (boundary?.payload as JsonObject | undefined)?.conversionMatrixRef : p.conversionRef;
    if (!availableReference(ref)) return undefined;
    const matrix = referencedItem(catalog, ref)?.value;
    const payload = matrix?.payload;
    if (matrix?.kind !== 'conversion-matrix' || !object(payload) || payload.version !== quantity.conversionVersion || !Array.isArray(payload.entries)) return undefined;
    const possibilities = payload.entries.filter(e => object(e) && e.inputMaterial === quantity.material && e.inputUnit === quantity.unit)
      .map(e => { const entry = e as JsonObject; return { dimension: JSON.stringify([entry.outputMaterial, entry.outputUnit]), amount: Number(quantity.value) * Number(entry.coefficient) }; });
    if (!possibilities.length || possibilities.some(p => !Number.isFinite(p.amount))) return undefined;
    conversions.push({ transferId: String(p.transferId), possibilities });
  }
  const common = conversions[0]?.possibilities.filter(candidate => conversions.every(member => member.possibilities.filter(p => p.dimension === candidate.dimension).length === 1)) ?? [];
  if (common.length !== 1) return undefined;
  const amounts = new Map<string, number>();
  for (const member of conversions) {
    const amount = member.possibilities.find(p => p.dimension === common[0].dimension)!.amount;
    if (amounts.has(member.transferId) && amounts.get(member.transferId) !== amount) return undefined;
    amounts.set(member.transferId, amount);
  }
  return [...amounts.values()].reduce((sum, amount) => sum + amount, 0);
}
export function inspectServiceLinks(observation: JsonObject, catalog: Catalog): ServiceLink[] {
  const records = observation.records as JsonObject[];
  return records.filter(r => r.family === 'service').map(record => {
    const p = record.payload as JsonObject; const c = record.causalContext as JsonObject;
    const reasons: string[] = [];
    if (!orderedAtSource(record, observation.sourceSHA, catalog, records)) reasons.push('SOURCE_ORDER_UNAVAILABLE');
    const effect = referencedItem(catalog, p.causeRef)?.value;
    const ep = object(effect?.payload) ? effect.payload : undefined;
    if (effect?.kind !== 'applied-effect' || !ep || ep.tick !== record.tick || ep.sourceEventId !== c.sourceEventId ||
        ep.sourceOrderRef !== c.sourceOrderRef || ep.actorId !== p.actorId || ep.recipientId !== p.recipientId || ep.functionId !== p.functionId)
      reasons.push('APPLIED_EFFECT_UNBOUND');
    const law = ep ? referencedItem(catalog, ep.lawRef)?.value : undefined;
    const lp = object(law?.payload) ? law.payload : undefined;
    const order = referencedItem(catalog, c.sourceOrderRef)?.value;
    const op = object(order?.payload) ? order.payload : undefined;
    if (law?.kind !== 'law' || !lp || lp.sourceSHA !== observation.sourceSHA || !op || op.sourceSHA !== lp.sourceSHA ||
        JSON.stringify(lp.phaseOrder) !== JSON.stringify(op.phaseOrder)) reasons.push('LAW_ORDER_SHA_UNRESOLVED');
    const condition = targetOf(p.conditionSourceRef, observation, catalog);
    let conditionBound = false;
    if (condition?.type === 'record:structure') {
      const cp = condition.value.payload as JsonObject;
      conditionBound = cp.structureId === p.subjectId && cp.condition === p.conditionAtService &&
        causalKey(condition.value) === causalKey(record) && orderedAtSource(condition.value, observation.sourceSHA, catalog, records);
    } else if (condition?.type === 'evidence:law-inputs') {
      const cp = condition.value.payload as JsonObject;
      conditionBound = Array.isArray(cp.entries) && cp.entries.some(entry => object(entry) && entry.tick === record.tick &&
        entry.subjectId === p.subjectId && entry.field === 'condition' && entry.unit === 'condition' && entry.value === p.conditionAtService &&
        entry.sourceEventId === c.sourceEventId && entry.sourceOrderRef === c.sourceOrderRef && (!ep || cp.lawRef === ep.lawRef));
    }
    if (!conditionBound) reasons.push('CONDITION_EVENT_UNBOUND');
    const flows = Array.isArray(p.consumptionRefs) ? p.consumptionRefs : [];
    const debitRecords: JsonObject[] = [];
    if (!flows.length || flows.some(ref => {
      const flow = availableReference(ref) ? records.find(r => r.recordId === ref) : undefined;
      if (!flow || flow.family !== 'flow') return true;
      debitRecords.push(flow); const fp = flow.payload as JsonObject;
      return fp.flowType !== 'consumption' || typeof fp.fromStockId !== 'string' || fp.toStockId !== null ||
        causalKey(flow) !== causalKey(record) || !orderedAtSource(flow, observation.sourceSHA, catalog, records);
    })) reasons.push('DEBIT_EVENT_UNBOUND');
    if (!ep || !Array.isArray(ep.consumptionRefs) || JSON.stringify([...ep.consumptionRefs].sort()) !== JSON.stringify([...flows].sort()))
      reasons.push('EFFECT_DEBIT_REFS_UNBOUND');
    const debited = declaredDebitAmount(debitRecords, records, catalog);
    if (!ep || debited === undefined || debited !== ep.consumedAmount) reasons.push('DEBIT_AMOUNT_UNBOUND');
    const benefit = object(p.appliedBenefit) ? p.appliedBenefit : undefined;
    if (!ep || !benefit || ep.appliedDelta !== benefit.value || ep.unit !== benefit.unit) reasons.push('EFFECT_AMOUNT_UNBOUND');
    return { recordId: String(record.recordId), state: reasons.length ? 'UNKNOWN' : 'BOUND', reasons,
      condition: typeof p.conditionAtService === 'number' ? p.conditionAtService : undefined,
      appliedValue: benefit && typeof benefit.value === 'number' ? benefit.value : undefined,
      baselineAvailable: has(p, 'baselineBenefit') };
  });
}
export function validateBundleFile(file: string, inputRoot = dirname(file)): BundleReport {
  return validateBundle(file, inputRoot, new Set());
}
function validateBundle(file: string, inputRoot: string, ancestors: Set<string>): BundleReport {
  const catalog: Catalog = new Map();
  let bytes: Buffer; let root: string;
  try { root = realpathSync(inputRoot); bytes = readFileSync(confinedInputPath(root, relative(root, resolve(file)))); }
  catch (error) { return { valid: false, issues: [issue('INPUT_PATH', '', String(error))], unknowns: [], catalog, serviceLinks: [] }; }
  const report = validateSemantics('observation.schema.json', bytes.toString('utf8'));
  const result: BundleReport = { ...report, catalog, serviceLinks: [] }; if (!result.valid || !result.value) return result;
  const observation = result.value;
  const canonicalFile = realpathSync(file);
  if (ancestors.has(canonicalFile)) { result.valid = false; result.issues.push(issue('BUNDLE_REFERENCE_CYCLE', '', canonicalFile)); return result; }
  const nextAncestors = new Set([...ancestors, canonicalFile]);
  if (observation.thresholdProfileHash !== THRESHOLD_PROFILE_SHA256)
    result.issues.push(issue('UNSUPPORTED_PROFILE', 'thresholdProfileHash', 'Input profile differs from the G0 seal'));
  for (const raw of observation.evidenceIndex as JsonObject[]) {
    const id = String(raw.evidenceId);
    if (catalog.has(id)) { result.issues.push(issue('DUPLICATE_EVIDENCE_ID', id, 'Evidence index IDs must be unique')); continue; }
    try {
      const path = confinedInputPath(root, String(raw.relativePath)); const data = readFileSync(path); const hash = sha256(data);
      if (hash !== raw.sha256) { result.issues.push(issue('EVIDENCE_HASH', id, 'Indexed bytes disagree')); continue; }
      const typed = validateSemantics(raw.schema as SchemaName, data.toString('utf8'));
      if (!typed.valid || !typed.value) { result.issues.push(...typed.issues.map(e => ({ ...e, path: `${id}${e.path}` }))); continue; }
      if (typed.value.evidenceId !== raw.evidenceId || typed.value.kind !== raw.kind || typed.value.synthetic !== raw.synthetic) {
        result.issues.push(issue('EVIDENCE_IDENTITY', id, 'Index and target identity disagree')); continue;
      }
      const item: CatalogItem = { value: typed.value, entry: raw, sha256: hash, path };
      catalog.set(id, item); result.unknowns.push(...typed.unknowns);
      if (typed.value.kind === 'observation') {
        const child = validateBundle(path, root, nextAncestors); item.namespace = child.catalog;
        result.issues.push(...child.issues.map(e => ({ ...e, path: `${id}/${e.path}` })));
        result.unknowns.push(...child.unknowns.map(e => ({ ...e, path: `${id}/${e.path}` })));
      }
    } catch (error) { result.issues.push(issue('EVIDENCE_FILE', id, String(error))); }
  }
  const ownId = String(observation.evidenceId);
  if (catalog.has(ownId) && catalog.get(ownId)?.sha256 !== sha256(bytes)) result.issues.push(issue('ROOT_EVIDENCE_SHADOW', ownId, 'Indexed alias contradicts the current observation'));
  if (!catalog.has(ownId)) catalog.set(ownId, { value: observation, entry: { kind: 'observation', schema: 'observation.schema.json' }, sha256: sha256(bytes), path: resolve(file) });
  const bindings = bindingIssues(catalog);
  result.issues.push(...bindings.issues); result.unknowns.push(...bindings.unknowns);
  const refs = referenceIssues('observation.schema.json', observation, observation, catalog);
  result.issues.push(...refs.issues); result.unknowns.push(...refs.unknowns);
  for (const item of catalog.values()) {
    if (item.value.kind === 'observation') continue; // Record namespaces are never merged across arms.
    const name = item.value.kind === 'evaluation' ? 'evaluation.schema.json' : 'evidence.schema.json';
    const references = referenceIssues(name, item.value, observation, catalog);
    result.issues.push(...references.issues); result.unknowns.push(...references.unknowns);
  }
  for (const record of observation.records as JsonObject[]) if ((record.causalContext as JsonObject).status === 'ordered' && !orderedAtSource(record, observation.sourceSHA, catalog, observation.records as JsonObject[]))
    result.unknowns.push(issue('CAUSAL_CONTEXT_UNRESOLVED', String(record.recordId), 'Missing, contradictory, cyclic or later source predecessor'));
  result.serviceLinks = inspectServiceLinks(observation, catalog);
  for (const link of result.serviceLinks) if (link.state === 'UNKNOWN') result.unknowns.push(issue('CAUSAL_UNKNOWN', link.recordId, link.reasons.join(',')));
  result.valid = !result.issues.length; return result;
}
