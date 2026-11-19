/** Versioned, offline binding evidence. READY is a structural certificate, never a criterion PASS. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import type { CatalogItem, Family, FieldStatus, JsonObject, Quality } from './realismo-contract.js';

export const CAUSAL_PROOF_VERSION = 'realismo-causal-proof-v2' as const;
export type Basis = 'OBSERVED' | 'TEST_FIXTURE';
export type Phase = 'reference' | 'removal' | 'restoration';
export type ExactRef = { id: string; sha256: string };
export type Window = { phase: Phase; startTick: number; endTick: number };
export type ArmPlan = {
  bundleId: string; manifestId: string; runId: string; role: 'paired-treatment' | 'paired-control';
  inputTrace: ExactRef; governorTrace: ExactRef;
};
export type InterventionPlan = {
  ref: string; phase: 'removal' | 'restoration'; tick: number; kind: string;
  subjectId: string; field: string; before: number; after: number; unit: string;
};
export type Protocol = {
  pairId: string; selectionRef: string; criterion: 'C11' | 'C17'; sourceSHA: string; epochId: string; seed: number;
  paramsHash: string; initialStateHash: string; profileHash: string; definitions: ExactRef;
  functions: string[]; normalization: 'per-day' | 'per-opportunity';
  tolerance: number; toleranceUnit: string; ticksPerDay: number; closure: '(start,end]'; clock: 'global';
  windows: Window[]; arms: ArmPlan[]; interventions: InterventionPlan[];
};
export type Registration = {
  protocol: ExactRef; contentHash: string; g1Registration: ExactRef; receipt: ExactRef; firstDataReceipts: ExactRef[];
  armBindings: { bundle: ExactRef; manifest: ExactRef }[];
};
export type Definitions = {
  g1Definitions: ExactRef; functionRegistry: ExactRef; windows: Window[]; functions: string[]; normalization: Protocol['normalization'];
  tolerance: number; toleranceUnit: string; ticksPerDay: number; closure: Protocol['closure']; clock: Protocol['clock'];
};
/** A trusted authority attests first-data time, rather than a producer declaring two dates. */
export type TimeReceipt = {
  authority: string; producer: string; purpose: 'registration' | 'first-data'; at: string;
  subjectHash: string; bundleId: string | null; firstRecordId: string | null; signature: string;
};
export type PhysicalCut = {
  bundle: ExactRef; recordId: string; subjectId: string; field: string; value: number; unit: string;
  tick: number; sourceEventId: string; sourceOrder: ExactRef;
  lawInputs: ExactRef; entryIndex: number;
};
export type Application = {
  protocolHash: string; intervention: ExactRef; bundle: ExactRef; phase: 'removal' | 'restoration';
  tick: number; sourceEventId: string; sourceOrder: ExactRef; before: ExactRef; after: ExactRef;
  inputRefs: string[]; debitRecordIds: string[]; sourceObservation: ExactRef;
};
/** Source attests that the confirmed input caused this event; tick coincidence is insufficient. */
export type SourceApplication = {
  authority: string; protocolHash: string; sourceSHA: string; intervention: ExactRef; bundle: ExactRef;
  sourceEventId: string; sourceOrder: ExactRef; tick: number; before: ExactRef; after: ExactRef;
  inputs: { trace: ExactRef; entryIndex: number; inputId: string; inputHash: string }[];
  debitRecordIds: string[]; outcome: 'applied'; signature: string;
};
export type Coverage = {
  bundle: ExactRef; phase: Phase; family: Family; functionId: string; startTick: number; endTick: number;
  quality: Quality; streamId: string; cohortRef: string; opportunityRef: string; recordIds: string[];
  censored: { actorId: string; lastObservedTick: number; reason: string }[];
};
/** A source-supported zero is a separate proof over one exact family/window/cohort. */
export type Absence = {
  protocolHash: string; coverage: ExactRef; subjectId: string; functionId: string;
  opportunityCount: number; eligibleActorIds: string[]; physicalCuts: ExactRef[];
  predicate: { field: string; value: number; unit: string }; sourceLaw: ExactRef;
};
export type Payloads = {
  protocol: Protocol; definitions: Definitions; registration: Registration; 'time-receipt': TimeReceipt;
  'physical-cut': PhysicalCut; application: Application; 'source-application': SourceApplication; coverage: Coverage; absence: Absence;
};
export type ProofDocument = { [K in keyof Payloads]: {
  version: typeof CAUSAL_PROOF_VERSION; id: string; kind: K; basis: Basis;
  payload: Payloads[K]; fieldCoverage: Record<keyof Payloads[K], FieldStatus>;
} }[keyof Payloads];
export type IndexedProof = { sha256: string; canonicalJson: string };
export interface ProofContext {
  /** Only a valid G1 BundleReport.catalog may be supplied by the future adapter. */
  g1: ReadonlyMap<string, CatalogItem>;
  proofs: ReadonlyMap<string, IndexedProof>;
  /** Policy/keys are configured out of band, never read from the evidence itself. */
  timeAuthorities: ReadonlyMap<string, { publicKeyPem: string; basis: Basis }>;
  sourceAuthorities: ReadonlyMap<string, { publicKeyPem: string; basis: Basis; sourceSHA: string }>;
}
export type ProofRequest = {
  protocol: ExactRef; registration: ExactRef; applications: ExactRef[];
  coverage: ExactRef[]; absences: ExactRef[];
};
export type Barrier = 'INDEX_BINDINGS' | 'PROTOCOL' | 'PREREGISTRATION_TIME' | 'LINEAGE' |
  'WINDOW_COVERAGE' | 'FINAL_TYPED_G1_APPLICATION' | 'TYPED_ABSENCE' | 'COMPLETE';
export type ProofResult = {
  state: 'READY' | 'UNKNOWN' | 'REJECTED'; barrier: Barrier; reason: string; refs: string[];
  basis: Basis; scientificAcceptance: false;
};
const phases: Phase[] = ['reference', 'removal', 'restoration'];
const obj = (v: unknown): v is JsonObject => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text) && new Set(v).size === v.length;
const tick = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exact = (v: unknown): v is ExactRef => obj(v) && text(v.id) && hash(v.sha256) && Object.keys(v).length === 2;
const exacts = (v: unknown): v is ExactRef[] => Array.isArray(v) && v.every(exact) && new Set(v.map(x => x.id)).size === v.length;
const same = (a: unknown, b: unknown): boolean => canonicalProofJson(a) === canonicalProofJson(b);
export const proofHash = (bytes: string): string => createHash('sha256').update(bytes, 'utf8').digest('hex');
/** Sorted object keys; array order is significant. Reject non-JSON and lossy numbers. */
export function canonicalProofJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      throw new Error('NON_CANONICAL_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalProofJson).join(',') + ']';
  if (!obj(value)) throw new Error('NON_JSON_VALUE');
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalProofJson(value[k])).join(',') + '}';
}
class Stop extends Error {
  readonly state: 'UNKNOWN' | 'REJECTED';
  constructor(state: 'UNKNOWN' | 'REJECTED', message: string) { super(message); this.state = state; }
}
function reject(reason: string): never { throw new Stop('REJECTED', reason); }
function unknown(reason: string): never { throw new Stop('UNKNOWN', reason); }
function requireFields(doc: JsonObject, fields: string[]): JsonObject {
  if (!obj(doc.payload) || !obj(doc.fieldCoverage)) reject('PAYLOAD_OR_COVERAGE_SHAPE');
  // A positive contradiction survives another field being missing.
  for (const key of Object.keys(doc.fieldCoverage)) {
    const c = doc.fieldCoverage[key];
    if (!obj(c) || !['observed', 'missing', 'not-applicable'].includes(String(c.status)) || !text(c.reason))
      reject('FIELD_COVERAGE_SHAPE:' + key);
    if ((c.status === 'observed') !== Object.hasOwn(doc.payload, key)) reject('FIELD_COVERAGE_CONTRADICTION:' + key);
  }
  for (const key of Object.keys(doc.payload)) if (!Object.hasOwn(doc.fieldCoverage, key)) reject('UNCOVERED_FIELD:' + key);
  for (const key of fields) {
    const c = doc.fieldCoverage[key];
    if (!obj(c) || c.status !== 'observed') unknown('FIELD_UNOBSERVED:' + key);
  }
  return doc.payload;
}
function protocolShape(p: unknown): p is Protocol {
  return obj(p) && text(p.pairId) && text(p.selectionRef) && ['C11', 'C17'].includes(String(p.criterion)) &&
    typeof p.sourceSHA === 'string' && /^[a-f0-9]{40}$/.test(p.sourceSHA) && text(p.epochId) && tick(p.seed) &&
    hash(p.paramsHash) && hash(p.initialStateHash) && hash(p.profileHash) && exact(p.definitions) &&
    strings(p.functions) && p.functions.length > 0 && ['per-day', 'per-opportunity'].includes(String(p.normalization)) &&
    finite(p.tolerance) && p.tolerance >= 0 && p.tolerance < 1 && text(p.toleranceUnit) &&
    tick(p.ticksPerDay) && p.ticksPerDay > 0 && p.closure === '(start,end]' && p.clock === 'global' &&
    Array.isArray(p.windows) && p.windows.length === 3 && p.windows.every((w, i) => obj(w) &&
      w.phase === phases[i] && tick(w.startTick) && tick(w.endTick) && w.startTick < w.endTick) &&
    Array.isArray(p.arms) && p.arms.length === 2 && p.arms.every(a => obj(a) && text(a.bundleId) &&
      text(a.manifestId) && text(a.runId) && ['paired-treatment', 'paired-control'].includes(String(a.role)) &&
      exact(a.inputTrace) && exact(a.governorTrace)) &&
    Array.isArray(p.interventions) && p.interventions.length === 2 && p.interventions.every(i => obj(i) &&
      text(i.ref) && ['removal', 'restoration'].includes(String(i.phase)) && tick(i.tick) && text(i.kind) &&
      text(i.subjectId) && text(i.field) && finite(i.before) && finite(i.after) && i.before !== i.after && text(i.unit));
}

/** No I/O, World, evaluation, thresholds or inferred application. */
export function validateCausalProof(ctx: ProofContext, request: ProofRequest): ProofResult {
  let barrier: Barrier = 'INDEX_BINDINGS';
  let basis: Basis = 'OBSERVED';
  const refs = new Set<string>();
  const result = (state: ProofResult['state'], reason: string): ProofResult =>
    ({ state, reason, barrier, refs: [...refs], basis, scientificAcceptance: false });
  function load(ref: ExactRef, kind: keyof Payloads, fields: string[]): JsonObject {
    if (!exact(ref)) reject('EXACT_REF_SHAPE');
    refs.add(ref.id);
    const indexed = ctx.proofs.get(ref.id);
    if (!indexed) unknown('PROOF_NOT_INDEXED:' + ref.id);
    if (indexed.sha256 !== ref.sha256 || proofHash(indexed.canonicalJson) !== ref.sha256) reject('PROOF_HASH_CONTRADICTION:' + ref.id);
    let parsed: unknown;
    try { parsed = JSON.parse(indexed.canonicalJson); }
    catch { return reject('PROOF_JSON_INVALID'); }
    if (!obj(parsed) || canonicalProofJson(parsed) !== indexed.canonicalJson) reject('PROOF_NOT_CANONICAL');
    if (parsed.version !== CAUSAL_PROOF_VERSION || parsed.id !== ref.id || parsed.kind !== kind ||
        !['OBSERVED', 'TEST_FIXTURE'].includes(String(parsed.basis))) reject('PROOF_IDENTITY_CONTRADICTION:' + ref.id);
    if (parsed.basis === 'TEST_FIXTURE') basis = 'TEST_FIXTURE';
    return requireFields(parsed, fields);
  }
  function g1(id: string, kind: string, bundleId?: string, expectedHash?: string): CatalogItem {
    refs.add(bundleId ? bundleId + '#' + id : id);
    const item = bundleId ? ctx.g1.get(bundleId)?.namespace?.get(id) : ctx.g1.get(id);
    if (!item) unknown('G1_NOT_INDEXED:' + id);
    if (item.value.kind !== kind || (expectedHash !== undefined && item.sha256 !== expectedHash)) reject('G1_INDEX_BINDING_CONTRADICTION:' + id);
    if (item.value.synthetic === true) basis = 'TEST_FIXTURE';
    return item;
  }
  function record(bundleId: string, id: string): JsonObject {
    refs.add(bundleId + '#' + id);
    const rows = ctx.g1.get(bundleId)?.value.records;
    if (!Array.isArray(rows)) unknown('G1_RECORDS_UNAVAILABLE');
    const found = rows.filter(r => obj(r) && r.recordId === id);
    if (found.length > 1) reject('G1_RECORD_DUPLICATE');
    if (!obj(found[0])) unknown('G1_RECORD_NOT_INDEXED:' + id);
    return found[0];
  }
  function ordered(bundleId: string, rootId: string): void {
    const active = new Set<string>(), done = new Set<string>();
    let missing: string | undefined;
    function walk(id: string, child?: JsonObject): void {
      if (active.has(id)) reject('ANCESTOR_CYCLE');
      let row: JsonObject;
      try { row = record(bundleId, id); }
      catch (e) { if (e instanceof Stop && e.state === 'UNKNOWN') { missing = e.message; return; } throw e; }
      const bundle = ctx.g1.get(bundleId)!.value;
      if (row.epochId !== bundle.epochId || !tick(row.tick)) reject('ANCESTOR_EPOCH_OR_TICK_CONTRADICTION');
      const c = row.causalContext;
      if (!obj(c) || c.status === 'unknown') { missing = 'ANCESTOR_ORDER_UNOBSERVED'; return; }
      if (c.status !== 'ordered' || !text(c.sourceEventId) || !text(c.phaseId) || !tick(c.phaseOrdinal) ||
          !tick(c.eventOrdinal) || !text(c.sourceOrderRef) || !strings(c.predecessorRecordIds)) reject('ANCESTOR_ORDER_SHAPE');
      let source: CatalogItem;
      try { source = g1(c.sourceOrderRef, 'source-order', bundleId); }
      catch (e) { if (e instanceof Stop && e.state === 'UNKNOWN') { missing = e.message; return; } throw e; }
      const p = requireFields(source.value, ['sourceSHA', 'phaseOrder', 'entries']);
      if (p.sourceSHA !== bundle.sourceSHA || !Array.isArray(p.phaseOrder) || p.phaseOrder[c.phaseOrdinal] !== c.phaseId ||
          !Array.isArray(p.entries)) reject('ANCESTOR_SOURCE_ORDER_CONTRADICTION');
      const matches = p.entries.filter(e => obj(e) && e.sourceEventId === c.sourceEventId && e.tick === row.tick &&
        e.phaseId === c.phaseId && e.phaseOrdinal === c.phaseOrdinal && e.eventOrdinal === c.eventOrdinal &&
        Array.isArray(e.recordIds) && e.recordIds.includes(id));
      const tuples = p.entries.map(e => obj(e) ? canonicalProofJson([e.tick, e.phaseOrdinal, e.eventOrdinal]) : 'invalid');
      if (matches.length !== 1 || new Set(tuples).size !== tuples.length) reject('ANCESTOR_SOURCE_MAPPING_CONTRADICTION');
      if (child) {
        const cc = child.causalContext;
        if (!obj(cc)) reject('ANCESTOR_CHILD_ORDER_SHAPE');
        const position = [row.tick, c.phaseOrdinal, c.eventOrdinal];
        const next = [child.tick, cc.phaseOrdinal, cc.eventOrdinal];
        if (position.some((n, i) => position.slice(0, i).every((v, j) => v === next[j]) && Number(n) > Number(next[i])))
          reject('ANCESTOR_AFTER_CHILD');
      }
      if (done.has(id)) return;
      active.add(id);
      for (const predecessor of c.predecessorRecordIds) walk(predecessor, row);
      active.delete(id); done.add(id);
    }
    walk(rootId);
    if (missing) unknown(missing);
  }
  function cut(ref: ExactRef, bundleId: string): JsonObject {
    const p = load(ref, 'physical-cut', ['bundle', 'recordId', 'subjectId', 'field', 'value', 'unit', 'tick', 'sourceEventId', 'sourceOrder', 'lawInputs', 'entryIndex']);
    if (!exact(p.bundle) || p.bundle.id !== bundleId || !exact(p.sourceOrder) || !text(p.recordId) ||
        !text(p.subjectId) || !text(p.field) || !finite(p.value) || !text(p.unit) || !tick(p.tick) || !text(p.sourceEventId) ||
        !exact(p.lawInputs) || !tick(p.entryIndex)) reject('PHYSICAL_CUT_SHAPE');
    g1(bundleId, 'observation', undefined, p.bundle.sha256);
    g1(p.sourceOrder.id, 'source-order', bundleId, p.sourceOrder.sha256);
    const row = record(bundleId, p.recordId);
    const subjectKey = row.family === 'structure' ? 'structureId' : 'subjectId';
    const rp = requireFields(row, [subjectKey, p.field]);
    const inputs = requireFields(g1(p.lawInputs.id, 'law-inputs', bundleId, p.lawInputs.sha256).value, ['entries', 'lawRef']);
    if (!Array.isArray(inputs.entries) || !text(inputs.lawRef)) reject('PHYSICAL_CUT_INPUT_SHAPE');
    const entry = inputs.entries[p.entryIndex];
    if (!obj(entry) || entry.subjectId !== p.subjectId || entry.field !== p.field || entry.value !== p.value || entry.unit !== p.unit ||
        entry.tick !== p.tick || entry.sourceEventId !== p.sourceEventId || entry.sourceOrderRef !== p.sourceOrder.id)
      reject('PHYSICAL_CUT_LAW_INPUT_CONTRADICTION');
    const law = requireFields(g1(inputs.lawRef, 'law', bundleId).value, ['sourceSHA']);
    if (law.sourceSHA !== ctx.g1.get(bundleId)!.value.sourceSHA) reject('PHYSICAL_CUT_LAW_SHA_CONTRADICTION');
    const c = row.causalContext;
    if (rp[subjectKey] !== p.subjectId || rp[p.field] !== p.value ||
        row.tick !== p.tick || !obj(c) || c.sourceEventId !== p.sourceEventId || c.sourceOrderRef !== p.sourceOrder.id)
      reject('PHYSICAL_CUT_RECORD_CONTRADICTION');
    ordered(bundleId, p.recordId);
    return p;
  }
  function signature(payload: JsonObject, publicKeyPem: string, reason: string): void {
    if (typeof payload.signature !== 'string' || !/^[a-f0-9]{128}$/.test(payload.signature)) reject(reason);
    const statement = { ...payload }; delete statement.signature;
    try {
      const key = createPublicKey(publicKeyPem);
      if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonicalProofJson(statement)), key, Buffer.from(payload.signature, 'hex')))
        reject(reason);
    } catch (e) { if (e instanceof Stop) throw e; reject(reason); }
  }
  try {
    const p = load(request.protocol, 'protocol', ['pairId', 'selectionRef', 'criterion', 'sourceSHA', 'epochId', 'seed', 'paramsHash',
      'initialStateHash', 'profileHash', 'definitions', 'functions', 'normalization', 'tolerance', 'toleranceUnit',
      'ticksPerDay', 'closure', 'clock', 'windows', 'arms', 'interventions']);
    barrier = 'PROTOCOL';
    if (!protocolShape(p)) reject('PROTOCOL_SHAPE');
    if (p.windows.some((w, i) => i > 0 && w.startTick !== p.windows[i - 1].endTick) ||
        new Set(p.windows.map(w => w.endTick - w.startTick)).size !== 1 ||
        p.arms[0].role !== 'paired-treatment' || p.arms[1].role !== 'paired-control' ||
        p.arms[0].runId === p.arms[1].runId || p.arms[0].bundleId === p.arms[1].bundleId ||
        p.arms[0].manifestId === p.arms[1].manifestId || new Set(p.interventions.map(i => i.ref)).size !== 2 ||
        p.interventions.some((v, i) => v.phase !== phases[i + 1] ||
          v.tick <= p.windows[i + 1].startTick || v.tick > p.windows[i + 1].endTick)) reject('PROTOCOL_PAIR_WINDOW_CONTRADICTION');
    const expectedUnit = p.normalization === 'per-day' ? 'absolute-service-per-day' : 'absolute-service-per-opportunity';
    if (p.toleranceUnit !== expectedUnit) reject('PROTOCOL_TOLERANCE_UNIT_CONTRADICTION');
    const bindings = load(p.definitions, 'definitions', ['g1Definitions', 'functionRegistry', 'windows', 'functions', 'normalization',
      'tolerance', 'toleranceUnit', 'ticksPerDay', 'closure', 'clock']);
    if (!exact(bindings.g1Definitions) || !exact(bindings.functionRegistry)) reject('DEFINITIONS_G1_REF_SHAPE');
    const definition = g1(bindings.g1Definitions.id, 'metric-definitions', undefined, bindings.g1Definitions.sha256);
    const dp = requireFields(definition.value, ['definitions', 'definitionVersion']);
    if (!Array.isArray(dp.definitions) || !dp.definitions.length) unknown('METRIC_DEFINITIONS_UNAVAILABLE');
    // All binding semantics must be explicitly present in the indexed definitions, never inferred from text.
    if (!dp.definitions.some(d => obj(d) && d.criterion === p.criterion)) reject('DEFINITIONS_CRITERION_CONTRADICTION');
    const registry = requireFields(g1(bindings.functionRegistry.id, 'functional-map', undefined,
      bindings.functionRegistry.sha256).value, ['functionDefinitions', 'registeredRef']);
    if (!Array.isArray(registry.functionDefinitions) || !registry.functionDefinitions.length)
      unknown('FUNCTION_REGISTRY_UNAVAILABLE');
    const functionIds = new Set<string>();
    for (const entry of registry.functionDefinitions) {
      if (!obj(entry) || !text(entry.functionId) || !text(entry.domain) ||
          !text(entry.appliedEffectField) || !text(entry.unit) || !text(entry.noveltyRule) ||
          functionIds.has(entry.functionId)) reject('FUNCTION_REGISTRY_CONTRADICTION');
      functionIds.add(entry.functionId);
    }
    if (registry.registeredRef !== p.selectionRef || p.functions.some(id => !functionIds.has(id)))
      reject('FUNCTION_REGISTRY_PROTOCOL_CONTRADICTION');
    const binding = { ...bindings }; delete binding.g1Definitions; delete binding.functionRegistry;
    if (!same(binding, { windows: p.windows, functions: p.functions, normalization: p.normalization,
      tolerance: p.tolerance, toleranceUnit: p.toleranceUnit, ticksPerDay: p.ticksPerDay, closure: p.closure, clock: p.clock }))
      reject('DEFINITIONS_PROTOCOL_CONTRADICTION');
    for (const arm of p.arms) {
      const b = g1(arm.bundleId, 'observation').value;
      const m = requireFields(g1(arm.manifestId, 'run-manifest').value,
        ['runId', 'epochId', 'artifactRole', 'sourceSHA', 'seed', 'observationRef', 'interventionRefs']);
      if (b.runId !== arm.runId || m.runId !== arm.runId || m.observationRef !== arm.bundleId ||
          b.artifactRole !== arm.role || m.artifactRole !== arm.role || b.pairedRunId !== p.arms.find(x => x !== arm)!.runId ||
          (['sourceSHA', 'epochId', 'seed'] as const).some(k => b[k] !== p[k] || m[k] !== p[k]) ||
          (['paramsHash', 'initialStateHash'] as const).some(k => b[k] !== p[k]) || b.thresholdProfileHash !== p.profileHash ||
          b.inputTraceRef !== arm.inputTrace.id || b.governorTraceRef !== arm.governorTrace.id) reject('ARM_IDENTITY_CONTRADICTION');
      const interventions = arm.role === 'paired-treatment' ? p.interventions.map(i => i.ref) : [];
      if (!same(b.interventionRefs, interventions) || !same(m.interventionRefs, interventions)) reject('ARM_INTERVENTION_REFS_CONTRADICTION');
      g1(arm.inputTrace.id, 'physical-inputs', arm.bundleId, arm.inputTrace.sha256);
      g1(arm.governorTrace.id, 'governor-trace', arm.bundleId, arm.governorTrace.sha256);
      if (!same(arm.inputTrace, p.arms[0].inputTrace) || !same(arm.governorTrace, p.arms[0].governorTrace)) reject('ARM_TRACE_CONTRADICTION');
      const w = { startTick: p.windows[0].startTick, endTick: p.windows[2].endTick,
        ticksPerDay: p.ticksPerDay, closure: p.closure, clock: p.clock, epochId: p.epochId };
      if (!same(b.plannedWindow, w)) reject('ARM_PLANNED_WINDOW_CONTRADICTION');
    }
    barrier = 'PREREGISTRATION_TIME';
    const r = load(request.registration, 'registration', ['protocol', 'contentHash', 'g1Registration', 'receipt', 'firstDataReceipts', 'armBindings']);
    if (!same(r.protocol, request.protocol) || r.contentHash !== request.protocol.sha256 || !exact(r.receipt) ||
        !exact(r.g1Registration) || r.g1Registration.id !== p.selectionRef ||
        !exacts(r.firstDataReceipts) || r.firstDataReceipts.length !== 2) reject('REGISTRATION_CONTENT_BINDING_CONTRADICTION');
    const legacy = requireFields(g1(r.g1Registration.id, 'preregistration', undefined, r.g1Registration.sha256).value,
      ['registrationId', 'contentHash', 'plannedRunIds', 'arms', 'profileHash', 'interventions']);
    for (const [field, expected] of [
      ['contentHash', request.protocol.sha256], ['plannedRunIds', p.arms.map(a => a.runId)],
      ['arms', p.arms.map(a => a.role)], ['profileHash', p.profileHash], ['interventions', p.interventions.map(i => i.ref)],
    ] as const) if (Object.hasOwn(legacy, field) && !same(legacy[field], expected)) reject('G1_REGISTRATION_POSITIVE_CONTRADICTION:' + field);
    if (!Array.isArray(r.armBindings) || r.armBindings.length !== 2) reject('REGISTRATION_ARM_BINDINGS_SHAPE');
    const boundArms = new Set<string>();
    for (const entry of r.armBindings) {
      if (!obj(entry) || !exact(entry.bundle) || !exact(entry.manifest)) reject('REGISTRATION_ARM_BINDINGS_SHAPE');
      const bundleRef = entry.bundle;
      const arm = p.arms.find(a => a.bundleId === bundleRef.id);
      if (!arm || arm.manifestId !== entry.manifest.id || boundArms.has(arm.bundleId)) reject('REGISTRATION_ARM_BINDINGS_CONTRADICTION');
      g1(arm.bundleId, 'observation', undefined, entry.bundle.sha256);
      g1(arm.manifestId, 'run-manifest', undefined, entry.manifest.sha256);
      boundArms.add(arm.bundleId);
    }
    function time(ref: ExactRef, purpose: string): JsonObject {
      const t = load(ref, 'time-receipt', ['authority', 'producer', 'purpose', 'at', 'subjectHash', 'bundleId', 'firstRecordId', 'signature']);
      if (!text(t.authority) || !text(t.producer) || t.authority === t.producer || t.purpose !== purpose ||
          typeof t.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(t.at) ||
          !Number.isFinite(Date.parse(t.at)) || new Date(t.at).toISOString() !== t.at || !hash(t.subjectHash) ||
          typeof t.signature !== 'string' || !/^[a-f0-9]{128}$/.test(t.signature)) reject('TIME_RECEIPT_SHAPE');
      const authority = ctx.timeAuthorities.get(t.authority);
      if (!authority) unknown('TIME_AUTHORITY_NOT_CONFIGURED');
      if (authority.basis === 'TEST_FIXTURE') basis = 'TEST_FIXTURE';
      signature(t, authority.publicKeyPem, 'TIME_SIGNATURE_INVALID');
      return t;
    }
    const registration = time(r.receipt, 'registration');
    if (registration.subjectHash !== request.protocol.sha256 || registration.bundleId !== null || registration.firstRecordId !== null)
      reject('TIME_REGISTRATION_BINDING_CONTRADICTION');
    const anchored = new Set<string>();
    for (const ref of r.firstDataReceipts) {
      const t = time(ref, 'first-data');
      if (!text(t.bundleId) || !text(t.firstRecordId) || !p.arms.some(a => a.bundleId === t.bundleId) || anchored.has(t.bundleId))
        reject('TIME_FIRST_DATA_ARM_CONTRADICTION');
      const b = g1(t.bundleId, 'observation', undefined, String(t.subjectHash)).value;
      const first = record(t.bundleId, t.firstRecordId);
      if (!Array.isArray(b.records) || !tick(first.tick) || b.records.some(x => obj(x) && tick(x.tick) && x.tick < Number(first.tick)))
        reject('TIME_FIRST_DATA_RECORD_CONTRADICTION');
      if (Date.parse(String(registration.at)) >= Date.parse(String(t.at))) reject('REGISTRATION_NOT_BEFORE_FIRST_DATA');
      anchored.add(t.bundleId);
    }
    barrier = 'LINEAGE';
    // Inspect every positive ordered record; collect UNKNOWN so it cannot conceal a contradictory sibling ancestor.
    let lineageMissing: string | undefined;
    for (const arm of p.arms) {
      const rows = g1(arm.bundleId, 'observation').value.records;
      if (!Array.isArray(rows)) unknown('ARM_RECORDS_UNAVAILABLE');
      for (const row of rows) if (obj(row) && obj(row.causalContext) && row.causalContext.status === 'ordered' && text(row.recordId)) {
        try { ordered(arm.bundleId, row.recordId); }
        catch (e) { if (e instanceof Stop && e.state === 'UNKNOWN') lineageMissing = e.message; else throw e; }
      }
    }
    if (lineageMissing) unknown(lineageMissing);
    barrier = 'WINDOW_COVERAGE';
    const covered = new Map<string, { ref: ExactRef; payload: JsonObject }>();
    for (const ref of request.coverage) {
      const c = load(ref, 'coverage', ['bundle', 'phase', 'family', 'functionId', 'startTick', 'endTick', 'quality', 'streamId', 'cohortRef', 'opportunityRef', 'recordIds', 'censored']);
      if (!exact(c.bundle) || !text(c.phase) || !text(c.family) || !text(c.functionId) || !strings(c.recordIds) || !Array.isArray(c.censored) ||
          !text(c.streamId) || !text(c.cohortRef) || !text(c.opportunityRef)) reject('COVERAGE_SHAPE');
      const coverageRecordIds = c.recordIds;
      const coverageBundle = c.bundle;
      const arm = p.arms.find(a => a.bundleId === coverageBundle.id), w = p.windows.find(w => w.phase === c.phase);
      if (!arm || !w || c.startTick !== w.startTick || c.endTick !== w.endTick || c.family !== 'service' ||
          !p.functions.includes(c.functionId)) reject('COVERAGE_SCOPE_CONTRADICTION');
      const b = g1(arm.bundleId, 'observation', undefined, c.bundle.sha256).value;
      if (!Array.isArray(b.streams)) unknown('G1_STREAM_UNAVAILABLE');
      const streams = b.streams.filter(s => obj(s) && s.streamId === c.streamId);
      if (streams.length > 1) reject('G1_STREAM_DUPLICATE');
      const stream = streams[0];
      if (!obj(stream) || !obj(stream.window)) unknown('G1_STREAM_UNAVAILABLE');
      if (stream.family !== c.family || stream.epochId !== p.epochId || stream.window.startTick !== w.startTick ||
          stream.window.endTick !== w.endTick || stream.window.closure !== p.closure || stream.window.clock !== p.clock ||
          stream.window.ticksPerDay !== p.ticksPerDay) reject('G1_STREAM_SCOPE_CONTRADICTION');
      if (stream.quality !== 'COMPLETE') unknown('G1_STREAM_NOT_COMPLETE');
      if (!Array.isArray(stream.censoredSubjects) || stream.censoredSubjects.length) unknown('G1_STREAM_CENSUS_UNVERIFIABLE');
      if (!obj(b.actualWindow) || !tick(b.actualWindow.startTick) || !tick(b.actualWindow.endTick)) unknown('ACTUAL_WINDOW_UNAVAILABLE');
      if (b.actualWindow.startTick > w.startTick || b.actualWindow.endTick < w.endTick || b.runStatus !== 'complete') unknown('PARTIAL_RUN_WINDOW');
      if (!same(b.actualWindow, b.plannedWindow)) reject('ACTUAL_WINDOW_CONTRADICTION');
      const cohort = requireFields(g1(c.cohortRef, 'cohort', arm.bundleId).value,
        ['actorIds', 'atTick', 'censored', 'selectionRegisteredRef']);
      g1(p.selectionRef, 'preregistration', arm.bundleId, r.g1Registration.sha256);
      const op = requireFields(g1(c.opportunityRef, 'opportunity', arm.bundleId).value,
        ['startTick', 'endTick', 'eligibleActorIds', 'cohortRef']);
      if (!strings(cohort.actorIds) || !tick(cohort.atTick) || !Array.isArray(cohort.censored) ||
          cohort.atTick > w.startTick || cohort.selectionRegisteredRef !== p.selectionRef ||
          op.startTick !== w.startTick || op.endTick !== w.endTick || op.cohortRef !== c.cohortRef ||
          !same(op.eligibleActorIds, cohort.actorIds) || !cohort.actorIds.length) reject('COHORT_OPPORTUNITY_CONTRADICTION');
      const censoredIds = new Set<string>();
      for (const item of c.censored) {
        if (!obj(item) || !text(item.actorId) || !cohort.actorIds.includes(item.actorId) || censoredIds.has(item.actorId) ||
            !tick(item.lastObservedTick) || item.lastObservedTick < w.startTick || item.lastObservedTick > w.endTick || !text(item.reason))
          reject('CENSOR_CONTRADICTION');
        censoredIds.add(item.actorId);
      }
      if (!same(c.censored, cohort.censored)) reject('CENSOR_COHORT_CONTRADICTION');
      if (!['COMPLETE', 'PARTIAL', 'INVALID', 'UNAVAILABLE'].includes(String(c.quality))) reject('COVERAGE_QUALITY_SHAPE');
      if (c.quality === 'INVALID') reject('INVALID_COVERAGE');
      if (c.quality !== 'COMPLETE' || c.censored.length) unknown('PARTIAL_OR_CENSORED_COVERAGE');
      if (!Array.isArray(b.records)) unknown('COVERAGE_RECORDS_UNAVAILABLE');
      const selected = b.records.filter((x): x is JsonObject =>
        obj(x) && x.family === c.family && Number(x.tick) > w.startTick && Number(x.tick) <= w.endTick);
      const selectedIds = new Set<string>(), targetIds = new Set<string>(), foreignIds = new Set<string>();
      let unobservedFunction = false;
      for (const service of selected) {
        if (!text(service.recordId) || selectedIds.has(service.recordId)) reject('SERVICE_RECORD_ID_CONTRADICTION');
        selectedIds.add(service.recordId);
        let payload: JsonObject;
        try { payload = requireFields(service, ['functionId']); }
        catch (e) { if (e instanceof Stop && e.state === 'UNKNOWN') { unobservedFunction = true; continue; } throw e; }
        if (!text(payload.functionId)) reject('SERVICE_FUNCTION_SHAPE');
        if (payload.functionId === c.functionId) {
          if (service.streamId !== c.streamId) reject('COVERAGE_STREAM_MEMBERSHIP_CONTRADICTION');
          targetIds.add(service.recordId);
        } else foreignIds.add(service.recordId);
      }
      if (coverageRecordIds.some(id => foreignIds.has(id))) reject('COVERAGE_FOREIGN_FUNCTION_CONTRADICTION');
      if (coverageRecordIds.some(id => !selectedIds.has(id)) || [...targetIds].some(id => !coverageRecordIds.includes(id)))
        reject('COVERAGE_RECORD_CENSUS_CONTRADICTION');
      if (unobservedFunction) unknown('SERVICE_FUNCTION_UNOBSERVED');
      if (!same([...coverageRecordIds].sort(), [...targetIds].sort())) reject('COVERAGE_RECORD_CENSUS_CONTRADICTION');
      const key = arm.bundleId + ':' + w.phase + ':' + c.functionId;
      if (covered.has(key)) reject('DUPLICATE_PHASE_COVERAGE');
      covered.set(key, { ref, payload: c });
    }
    if (covered.size !== p.arms.length * p.windows.length * p.functions.length)
      unknown('ARM_PHASE_FUNCTION_COVERAGES_REQUIRED');
    barrier = 'FINAL_TYPED_G1_APPLICATION';
    const treatment = p.arms[0];
    if (!exacts(request.applications)) reject('APPLICATION_REFS_SHAPE');
    if (request.applications.length !== 2) unknown('TYPED_G1_APPLICATION_UNOBSERVED');
    const applied = new Set<string>();
    for (const ref of request.applications) {
      const a = load(ref, 'application', ['protocolHash', 'intervention', 'bundle', 'phase', 'tick', 'sourceEventId',
        'sourceOrder', 'before', 'after', 'inputRefs', 'debitRecordIds', 'sourceObservation']);
      if (!exact(a.intervention) || !exact(a.bundle) || !exact(a.before) || !exact(a.after) || !exact(a.sourceOrder) ||
          !exact(a.sourceObservation) || !strings(a.inputRefs) || !a.inputRefs.length || !strings(a.debitRecordIds) || !a.debitRecordIds.length)
        reject('APPLICATION_SHAPE');
      const interventionRef = a.intervention;
      const plan = p.interventions.find(i => i.ref === interventionRef.id);
      if (!plan || applied.has(plan.ref) || a.protocolHash !== request.protocol.sha256 || a.bundle.id !== treatment.bundleId ||
          a.phase !== plan.phase || a.tick !== plan.tick || !text(a.sourceEventId)) reject('APPLICATION_PROTOCOL_CONTRADICTION');
      g1(a.bundle.id, 'observation', undefined, a.bundle.sha256);
      const i = requireFields(g1(a.intervention.id, 'intervention', treatment.bundleId, a.intervention.sha256).value,
        ['runId', 'tick', 'kind', 'changes', 'inputRefs']);
      if (i.runId !== treatment.runId || i.tick !== plan.tick || i.kind !== plan.kind ||
          !same(i.changes, [{ field: plan.field, before: plan.before, after: plan.after, unit: plan.unit }]) ||
          !same(i.inputRefs, a.inputRefs)) reject('APPLICATION_INTERVENTION_CONTRADICTION');
      if (a.inputRefs.some(inputRef => !inputRef.startsWith(treatment.bundleId + '#'))) reject('APPLICATION_INPUT_NAMESPACE_CONTRADICTION');
      const source = load(a.sourceObservation, 'source-application', ['authority', 'protocolHash', 'sourceSHA', 'intervention',
        'bundle', 'sourceEventId', 'sourceOrder', 'tick', 'before', 'after', 'inputs', 'debitRecordIds', 'outcome', 'signature']);
      if (!text(source.authority) || source.outcome !== 'applied' || source.sourceSHA !== p.sourceSHA ||
          source.protocolHash !== request.protocol.sha256 || !same(source.intervention, a.intervention) ||
          !same(source.bundle, a.bundle) || source.sourceEventId !== a.sourceEventId || !same(source.sourceOrder, a.sourceOrder) ||
          source.tick !== a.tick || !same(source.before, a.before) || !same(source.after, a.after) ||
          !same(source.debitRecordIds, a.debitRecordIds) || !Array.isArray(source.inputs) || !source.inputs.length)
        reject('SOURCE_APPLICATION_BINDING_CONTRADICTION');
      const sourceAuthority = ctx.sourceAuthorities.get(source.authority);
      if (!sourceAuthority) unknown('SOURCE_APPLICATION_AUTHORITY_UNAVAILABLE');
      if (sourceAuthority.sourceSHA !== p.sourceSHA) reject('SOURCE_APPLICATION_AUTHORITY_SHA_CONTRADICTION');
      if (sourceAuthority.basis === 'TEST_FIXTURE') basis = 'TEST_FIXTURE';
      signature(source, sourceAuthority.publicKeyPem, 'SOURCE_APPLICATION_SIGNATURE_INVALID');
      const inputRefs: string[] = [];
      for (const input of source.inputs) {
        if (!obj(input) || !exact(input.trace) || !tick(input.entryIndex) || !text(input.inputId) || !hash(input.inputHash))
          reject('SOURCE_APPLICATION_INPUT_SHAPE');
        const trace = requireFields(g1(input.trace.id, 'physical-inputs', treatment.bundleId, input.trace.sha256).value, ['entries']);
        if (!Array.isArray(trace.entries)) unknown('SOURCE_APPLICATION_INPUT_UNOBSERVED');
        const entry = trace.entries[input.entryIndex];
        if (!obj(entry) || entry.inputId !== input.inputId || entry.inputHash !== input.inputHash || entry.tick !== plan.tick ||
            entry.targetRef !== plan.ref || entry.confirmed !== true) reject('SOURCE_APPLICATION_INPUT_CONTRADICTION');
        inputRefs.push(treatment.bundleId + '#' + input.trace.id);
      }
      if (new Set(inputRefs).size !== inputRefs.length || !same([...inputRefs].sort(), [...a.inputRefs].sort())) reject('SOURCE_APPLICATION_INPUT_REFS_CONTRADICTION');
      const before = cut(a.before, treatment.bundleId), after = cut(a.after, treatment.bundleId);
      if (before.subjectId !== plan.subjectId || after.subjectId !== plan.subjectId || before.field !== plan.field ||
          after.field !== plan.field || before.unit !== plan.unit || after.unit !== plan.unit ||
          before.value !== plan.before || after.value !== plan.after || Number(before.tick) > plan.tick || after.tick !== plan.tick ||
          after.sourceEventId !== a.sourceEventId || !same(after.sourceOrder, a.sourceOrder)) reject('APPLICATION_PHYSICAL_TRANSITION_CONTRADICTION');
      const bc = record(treatment.bundleId, String(before.recordId)).causalContext;
      const ac = record(treatment.bundleId, String(after.recordId)).causalContext;
      if (!obj(bc) || !obj(ac) || !Array.isArray(ac.predecessorRecordIds) || !ac.predecessorRecordIds.includes(String(before.recordId)) ||
          (before.tick === after.tick && (Number(bc.phaseOrdinal) > Number(ac.phaseOrdinal) ||
            (bc.phaseOrdinal === ac.phaseOrdinal && Number(bc.eventOrdinal) >= Number(ac.eventOrdinal))))) reject('APPLICATION_BEFORE_AFTER_ORDER_CONTRADICTION');
      for (const inputRef of a.inputRefs) {
        // Inputs are arm-qualified evidence references; no global fallback.
        const prefix = treatment.bundleId + '#';
        if (!inputRef.startsWith(prefix)) reject('APPLICATION_INPUT_NAMESPACE_CONTRADICTION');
        const inp = requireFields(g1(inputRef.slice(prefix.length), 'physical-inputs', treatment.bundleId).value, ['entries']);
        if (!Array.isArray(inp.entries) || !inp.entries.some(e => obj(e) && e.tick === plan.tick && e.confirmed === true && e.targetRef === plan.ref))
          unknown('APPLICATION_CONFIRMED_INPUT_UNAVAILABLE');
      }
      for (const id of a.debitRecordIds) {
        const debit = record(treatment.bundleId, id), dc = debit.causalContext;
        const d = requireFields(debit, ['quantity', 'flowType']);
        if (debit.family !== 'flow' || debit.tick !== plan.tick || !obj(dc) || dc.sourceEventId !== a.sourceEventId ||
            dc.sourceOrderRef !== a.sourceOrder.id || !obj(d.quantity) || !finite(d.quantity.value) || d.quantity.value <= 0 ||
            !['consumption', 'internal', 'external-out'].includes(String(d.flowType))) reject('APPLICATION_DEBIT_CONTRADICTION');
        ordered(treatment.bundleId, id);
      }
      applied.add(plan.ref);
    }
    barrier = 'TYPED_ABSENCE';
    const absent = new Set<string>();
    for (const ref of request.absences) {
      const a = load(ref, 'absence', ['protocolHash', 'coverage', 'subjectId', 'functionId', 'opportunityCount',
        'eligibleActorIds', 'physicalCuts', 'predicate', 'sourceLaw']);
      if (a.protocolHash !== request.protocol.sha256 || !exact(a.coverage) || !exact(a.sourceLaw) || !exacts(a.physicalCuts) ||
          !a.physicalCuts.length || !text(a.subjectId) || !text(a.functionId) || !p.functions.includes(a.functionId) ||
          !tick(a.opportunityCount) || a.opportunityCount === 0 || !strings(a.eligibleActorIds) || !a.eligibleActorIds.length ||
          !obj(a.predicate) || !text(a.predicate.field) || !finite(a.predicate.value) || !text(a.predicate.unit)) reject('ABSENCE_SHAPE');
      const entry = [...covered.entries()].find(([, c]) => same(c.ref, a.coverage));
      if (!entry || absent.has(entry[0])) reject('ABSENCE_COVERAGE_CONTRADICTION');
      const c = entry[1].payload;
      if (!exact(c.bundle) || !Array.isArray(c.recordIds) || c.recordIds.length) reject('ABSENCE_POSITIVE_RECORD_CONTRADICTION');
      const op = requireFields(g1(String(c.opportunityRef), 'opportunity', c.bundle.id).value, ['eligibleActorIds']);
      if (!same(a.eligibleActorIds, op.eligibleActorIds)) reject('ABSENCE_OPPORTUNITY_CONTRADICTION');
      const law = requireFields(g1(a.sourceLaw.id, 'law', c.bundle.id, a.sourceLaw.sha256).value, ['sourceSHA', 'formulaDefinitions']);
      if (law.sourceSHA !== p.sourceSHA) reject('ABSENCE_LAW_SHA_CONTRADICTION');
      // v1 does not invent a universal no-service law or infer absence from COMPLETE + an empty list.
      // A physical predicate needs a reviewed law evaluator and interval continuity, which G1 lacks.
      for (const physicalRef of a.physicalCuts) {
        const physical = cut(physicalRef, c.bundle.id);
        if (physical.subjectId !== a.subjectId || physical.field !== a.predicate.field ||
            physical.value !== a.predicate.value || physical.unit !== a.predicate.unit) reject('ABSENCE_PHYSICAL_PREDICATE_CONTRADICTION');
      }
      unknown('PHYSICAL_ABSENCE_INTERVAL_LAW_UNAVAILABLE');
    }
    for (const [key, c] of covered) if (Array.isArray(c.payload.recordIds) && c.payload.recordIds.length === 0 && !absent.has(key))
      unknown('TYPED_LOCAL_ABSENCE_UNOBSERVED');
    barrier = 'COMPLETE';
    return result('READY', 'STRUCTURAL_BINDINGS_ONLY');
  } catch (e) {
    if (e instanceof Stop) return result(e.state, e.message);
    return result('REJECTED', 'MALFORMED_PROOF_INPUT');
  }
}
