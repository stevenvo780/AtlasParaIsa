/** Manual structural oracles, exclusively TEST_FIXTURE. No World or scientific observation. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import type { Catalog, CatalogItem, JsonObject } from '../scripts/lab/realismo-contract.js';
import { CAUSAL_PROOF_VERSION, canonicalProofJson, proofHash, validateCausalProof } from '../scripts/lab/realismo-causal-proof.js';
import type { ExactRef, IndexedProof, ProofContext, ProofRequest, Protocol, Payloads, Window } from '../scripts/lab/realismo-causal-proof.js';

const H = 'a'.repeat(64), SOURCE = 'b'.repeat(40);
const windows: Window[] = [
  { phase: 'reference', startTick: 0, endTick: 10 },
  { phase: 'removal', startTick: 10, endTick: 20 },
  { phase: 'restoration', startTick: 20, endTick: 30 },
];
function covered(payload: JsonObject): JsonObject {
  return Object.fromEntries(Object.keys(payload).map(k => [k, { status: 'observed', reason: 'TEST_FIXTURE manual oracle' }]));
}
function item(id: string, kind: string, payload: JsonObject): CatalogItem {
  const value: JsonObject = { contractVersion: 'realismo-v3', evidenceId: id, kind, synthetic: true,
    sourceRefs: [], payload, fieldCoverage: covered(payload) };
  return { value, entry: { kind }, sha256: proofHash(canonicalProofJson(value)), path: 'TEST_FIXTURE/' + id };
}
function row(id: string, family: string, at: number, phaseOrdinal: number, eventOrdinal: number,
  payload: JsonObject, predecessors: string[] = []): JsonObject {
  return { recordId: id, family, epochId: 'e0', tick: at, streamId: 'service-' + windows.find(w => at > w.startTick && at <= w.endTick)?.phase,
    payload, fieldCoverage: covered(payload),
    causalContext: { status: 'ordered', sourceEventId: 'event-' + at, phaseId: ['before', 'application', 'service'][phaseOrdinal],
      phaseOrdinal, eventOrdinal, sourceOrderRef: 'order', predecessorRecordIds: predecessors, reason: 'TEST_FIXTURE' } };
}
function fixture(zeroRemoval = false, serviceFunction: string | null = 'supply', claimService = true) {
  const g1: Catalog = new Map(), proofs = new Map<string, IndexedProof>();
  function add<K extends keyof Payloads>(id: string, kind: K, payload: Payloads[K]): ExactRef {
    const bytes = canonicalProofJson({ version: CAUSAL_PROOF_VERSION, id, kind, basis: 'TEST_FIXTURE', payload,
      fieldCoverage: covered(payload) });
    const ref = { id, sha256: proofHash(bytes) };
    proofs.set(id, { sha256: ref.sha256, canonicalJson: bytes }); return ref;
  }
  const input = item('inputs', 'physical-inputs', { entries: [] });
  const governor = item('governor', 'governor-trace', { entries: [] });
  const law = item('law', 'law', { sourceSHA: SOURCE, formulaDefinitions: [] });
  const definitions = item('g1-definitions', 'metric-definitions', { definitionVersion: 'TEST_FIXTURE-v1', definitions: [
    { formulaId: 'R', criterion: 'C11', expression: '(control-treatment)/control', unit: 'ratio', requiredFields: [], rewardEligible: false },
  ] });
  g1.set('g1-definitions', definitions);
  const functionRegistry = item('function-registry', 'functional-map', { registeredRef: 'g1-registration',
    functionDefinitions: [{ functionId: 'supply', domain: 'TEST_FIXTURE', appliedEffectField: 'appliedBenefit',
      unit: 'quanta', noveltyRule: 'TEST_FIXTURE only' },
    { functionId: 'foreign', domain: 'TEST_FIXTURE', appliedEffectField: 'appliedBenefit',
      unit: 'quanta', noveltyRule: 'TEST_FIXTURE only' }] });
  g1.set('function-registry', functionRegistry);
  const g1Registration = item('g1-registration', 'preregistration', { registrationId: 'manual-TEST_FIXTURE',
    plannedRunIds: ['run-t', 'run-c'], arms: ['paired-treatment', 'paired-control'], profileHash: H,
    interventions: ['removal', 'restoration'] });
  g1.set('g1-registration', g1Registration);
  const armPlans: Protocol['arms'] = [];
  const applicationData: Array<{ ref: ExactRef; before: ExactRef; after: ExactRef; event: string; phase: 'removal' | 'restoration'; tick: number }> = [];
  for (const [bundleId, runId, role, partner] of [
    ['treatment', 'run-t', 'paired-treatment', 'run-c'], ['control', 'run-c', 'paired-control', 'run-t'],
  ] as const) {
    const records = windows.map((w, n) => row('service-' + w.phase, 'service', w.startTick + 5, 2, n,
      { subjectId: 'tool', ...(serviceFunction === null ? {} : { functionId: serviceFunction }),
        actorId: 'mortal', recipientId: 'mortal' }))
      .filter(r => !(zeroRemoval && bundleId === 'treatment' && r.recordId === 'service-removal'));
    if (bundleId === 'treatment') for (const [phase, at, before, after] of [
      ['removal', 11, 1, 0], ['restoration', 21, 0, 1],
    ] as const) {
      records.push(row('before-' + phase, 'structure', at - 1, 0, 0, { structureId: 'tool', condition: before }));
      records.push(row('after-' + phase, 'structure', at, 1, 0, { structureId: 'tool', condition: after }, ['before-' + phase]));
      records.push(row('debit-' + phase, 'flow', at, 1, 0, { flowType: 'consumption', quantity: {
        value: 1, unit: 'quanta', material: 'wood', conversionVersion: 'TEST_FIXTURE' } }));
    }
    const entries: JsonObject[] = [];
    for (const r of records) {
      const c = r.causalContext; assert.ok(c && typeof c === 'object' && !Array.isArray(c));
      const existing = entries.find(e => e.tick === r.tick && e.phaseOrdinal === c.phaseOrdinal && e.eventOrdinal === c.eventOrdinal);
      if (existing && Array.isArray(existing.recordIds)) existing.recordIds.push(r.recordId);
      else entries.push({ sourceEventId: c.sourceEventId, tick: r.tick, phaseId: c.phaseId,
        phaseOrdinal: c.phaseOrdinal, eventOrdinal: c.eventOrdinal, recordIds: [r.recordId] });
    }
    const order = item('order', 'source-order', { sourceSHA: SOURCE, phaseOrder: ['before', 'application', 'service'], entries });
    const local: Catalog = new Map([['inputs', input], ['governor', governor], ['law', law], ['order', order], ['g1-registration', g1Registration]]);
    const lawEntries: JsonObject[] = [];
    for (const phase of ['removal', 'restoration'] as const) if (bundleId === 'treatment') {
      const at = phase === 'removal' ? 11 : 21, before = phase === 'removal' ? 1 : 0, after = 1 - before;
      for (const [prefix, value, physicalTick] of [['before', before, at - 1], ['after', after, at]] as const)
        lawEntries.push({ tick: physicalTick, subjectId: 'tool', field: 'condition', value, unit: 'condition',
          sourceEventId: 'event-' + physicalTick, sourceOrderRef: 'order' });
      const intervention = item(phase, 'intervention', { runId, tick: at, kind: phase,
        changes: [{ field: 'condition', before, after, unit: 'condition' }], inputRefs: ['treatment#intervention-inputs'] });
      local.set(phase, intervention);
    }
    local.set('law-inputs', item('law-inputs', 'law-inputs', { lawRef: 'law', entries: lawEntries }));
    local.set('intervention-inputs', item('intervention-inputs', 'physical-inputs', { entries: [
      { tick: 11, inputId: 'input-removal', inputHash: H, targetRef: 'removal', confirmed: true },
      { tick: 21, inputId: 'input-restoration', inputHash: H, targetRef: 'restoration', confirmed: true },
    ] }));
    const whole = { startTick: 0, endTick: 30, ticksPerDay: 1, closure: '(start,end]', clock: 'global', epochId: 'e0' };
    const b = item(bundleId, 'observation', {});
    b.value = { contractVersion: 'realismo-v3', evidenceId: bundleId, kind: 'observation', synthetic: true,
      sourceSHA: SOURCE, epochId: 'e0', seed: 1, paramsHash: H, initialStateHash: H, thresholdProfileHash: H,
      runId, artifactRole: role, pairedRunId: partner, inputTraceRef: 'inputs', governorTraceRef: 'governor',
      plannedWindow: whole, actualWindow: whole, runStatus: 'complete', interventionRefs: bundleId === 'treatment' ? ['removal', 'restoration'] : [],
      records, streams: windows.map(w => ({
        streamId: 'service-' + w.phase, family: 'service', epochId: 'e0', quality: 'COMPLETE', censoredSubjects: [],
        window: { startTick: w.startTick, endTick: w.endTick, ticksPerDay: 1, closure: '(start,end]', clock: 'global', epochId: 'e0' },
      })) };
    b.sha256 = proofHash(canonicalProofJson(b.value)); b.namespace = local; g1.set(bundleId, b);
    const manifestId = 'manifest-' + bundleId;
    g1.set(manifestId, item(manifestId, 'run-manifest', { runId, artifactRole: role, observationRef: bundleId,
      sourceSHA: SOURCE, epochId: 'e0', seed: 1, interventionRefs: bundleId === 'treatment' ? ['removal', 'restoration'] : [] }));
    armPlans.push({ bundleId, runId, manifestId, role, inputTrace: { id: 'inputs', sha256: input.sha256 },
      governorTrace: { id: 'governor', sha256: governor.sha256 } });
  }
  const definitionProof = add('definitions', 'definitions', { g1Definitions: { id: 'g1-definitions', sha256: definitions.sha256 },
    functionRegistry: { id: 'function-registry', sha256: functionRegistry.sha256 },
    windows, functions: ['supply'], normalization: 'per-day', tolerance: 0, toleranceUnit: 'absolute-service-per-day',
    ticksPerDay: 1, closure: '(start,end]', clock: 'global' });
  const protocol: Protocol = { pairId: 'pair', selectionRef: 'g1-registration', criterion: 'C11', sourceSHA: SOURCE, epochId: 'e0', seed: 1,
    paramsHash: H, initialStateHash: H, profileHash: H, definitions: definitionProof, functions: ['supply'],
    normalization: 'per-day', tolerance: 0, toleranceUnit: 'absolute-service-per-day', ticksPerDay: 1,
    closure: '(start,end]', clock: 'global', windows, arms: armPlans, interventions: [
      { ref: 'removal', phase: 'removal', tick: 11, kind: 'removal', subjectId: 'tool', field: 'condition', before: 1, after: 0, unit: 'condition' },
      { ref: 'restoration', phase: 'restoration', tick: 21, kind: 'restoration', subjectId: 'tool', field: 'condition', before: 0, after: 1, unit: 'condition' },
    ] };
  const protocolRef = add('protocol', 'protocol', protocol);
  const preregPayload = g1Registration.value.payload;
  assert.ok(preregPayload && typeof preregPayload === 'object' && !Array.isArray(preregPayload));
  preregPayload.contentHash = protocolRef.sha256;
  g1Registration.value.fieldCoverage = covered(preregPayload);
  g1Registration.sha256 = proofHash(canonicalProofJson(g1Registration.value));
  // Public RFC8032 test seed, deliberately incapable of representing a real trusted authority.
  const privateKey = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' +
    '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'), format: 'der', type: 'pkcs8' });
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  function receipt(id: string, purpose: 'registration' | 'first-data', at: string, subjectHash: string,
    bundleId: string | null, firstRecordId: string | null): ExactRef {
    const statement = { authority: 'fixture-clock', producer: 'fixture-producer', purpose, at, subjectHash, bundleId, firstRecordId };
    return add(id, 'time-receipt', { ...statement,
      signature: sign(null, Buffer.from(canonicalProofJson(statement)), privateKey).toString('hex') });
  }
  const registered = receipt('registered-time', 'registration', '2026-10-01T00:00:00.000Z', protocolRef.sha256, null, null);
  const firstDataReceipts = armPlans.map(a => receipt('first-' + a.bundleId, 'first-data', '2026-10-01T00:00:01.000Z',
    g1.get(a.bundleId)!.sha256, a.bundleId, 'service-reference'));
  const registration = add('registration', 'registration', { protocol: protocolRef, contentHash: protocolRef.sha256,
    g1Registration: { id: 'g1-registration', sha256: g1Registration.sha256 }, receipt: registered, firstDataReceipts,
    armBindings: armPlans.map(a => ({ bundle: { id: a.bundleId, sha256: g1.get(a.bundleId)!.sha256 },
      manifest: { id: a.manifestId, sha256: g1.get(a.manifestId)!.sha256 } })) });
  const coverage: ExactRef[] = [];
  for (const arm of armPlans) for (const w of windows) {
    const local = g1.get(arm.bundleId)!.namespace!;
    local.set('cohort-' + w.phase, item('cohort-' + w.phase, 'cohort', { actorIds: ['mortal'], atTick: 0,
      censored: [], selectionRegisteredRef: 'g1-registration' }));
    local.set('opportunity-' + w.phase, item('opportunity-' + w.phase, 'opportunity', {
      startTick: w.startTick, endTick: w.endTick, eligibleActorIds: ['mortal'], cohortRef: 'cohort-' + w.phase }));
    coverage.push(add('coverage-' + arm.bundleId + '-' + w.phase, 'coverage', {
      bundle: { id: arm.bundleId, sha256: g1.get(arm.bundleId)!.sha256 }, phase: w.phase, family: 'service', functionId: 'supply',
      startTick: w.startTick, endTick: w.endTick, quality: 'COMPLETE', streamId: 'service-' + w.phase,
      cohortRef: 'cohort-' + w.phase, opportunityRef: 'opportunity-' + w.phase,
      recordIds: (zeroRemoval && arm.bundleId === 'treatment' && w.phase === 'removal') || !claimService
        ? [] : ['service-' + w.phase], censored: [],
    }));
  }
  const b = g1.get('treatment')!, local = b.namespace!, order = local.get('order')!, lawInputs = local.get('law-inputs')!;
  for (const plan of protocol.interventions) {
    const cutRefs = (['before', 'after'] as const).map((prefix, index) => add(prefix + '-' + plan.phase, 'physical-cut', {
      bundle: { id: 'treatment', sha256: b.sha256 }, recordId: prefix + '-' + plan.phase, subjectId: 'tool', field: 'condition',
      value: prefix === 'before' ? plan.before : plan.after, unit: 'condition', tick: plan.tick - (prefix === 'before' ? 1 : 0),
      sourceEventId: 'event-' + (plan.tick - (prefix === 'before' ? 1 : 0)), sourceOrder: { id: 'order', sha256: order.sha256 },
      lawInputs: { id: 'law-inputs', sha256: lawInputs.sha256 }, entryIndex: (plan.phase === 'removal' ? 0 : 2) + index,
    }));
    applicationData.push({ ref: { id: plan.ref, sha256: local.get(plan.ref)!.sha256 }, before: cutRefs[0], after: cutRefs[1],
      event: 'event-' + plan.tick, phase: plan.phase, tick: plan.tick });
  }
  const applications = applicationData.map((a, index) => {
    const statement = { authority: 'fixture-source', protocolHash: protocolRef.sha256, sourceSHA: SOURCE,
      intervention: a.ref, bundle: { id: 'treatment', sha256: b.sha256 }, sourceEventId: a.event,
      sourceOrder: { id: 'order', sha256: order.sha256 }, tick: a.tick, before: a.before, after: a.after,
      inputs: [{ trace: { id: 'intervention-inputs', sha256: local.get('intervention-inputs')!.sha256 },
        entryIndex: index, inputId: 'input-' + a.phase, inputHash: H }],
      debitRecordIds: ['debit-' + a.phase], outcome: 'applied' as const };
    const sourceObservation = add('source-' + a.phase, 'source-application', { ...statement,
      signature: sign(null, Buffer.from(canonicalProofJson(statement)), privateKey).toString('hex') });
    return add('application-' + a.phase, 'application', {
      protocolHash: protocolRef.sha256, intervention: a.ref, bundle: { id: 'treatment', sha256: b.sha256 },
      phase: a.phase, tick: a.tick, sourceEventId: a.event, sourceOrder: { id: 'order', sha256: order.sha256 },
      before: a.before, after: a.after, inputRefs: ['treatment#intervention-inputs'], debitRecordIds: ['debit-' + a.phase], sourceObservation,
    });
  });
  const ctx: ProofContext = { g1, proofs, timeAuthorities: new Map([['fixture-clock', { publicKeyPem, basis: 'TEST_FIXTURE' }]]),
    sourceAuthorities: new Map([['fixture-source', { publicKeyPem, basis: 'TEST_FIXTURE', sourceSHA: SOURCE }]]) };
  const request: ProofRequest = { protocol: protocolRef, registration, applications, coverage, absences: [] };
  function mutate(ref: ExactRef, change: (payload: JsonObject) => void): ExactRef {
    const entry = proofs.get(ref.id)!;
    const doc: JsonObject = JSON.parse(entry.canonicalJson);
    assert.ok(doc.payload && typeof doc.payload === 'object' && !Array.isArray(doc.payload));
    change(doc.payload);
    const canonicalJson = canonicalProofJson(doc), sha256 = proofHash(canonicalJson);
    proofs.set(ref.id, { canonicalJson, sha256 }); return { id: ref.id, sha256 };
  }
  return { ctx, request, proofs, g1, mutate, receipt, add };
}

test('NEGATIVE reaches FINAL_TYPED_G1_APPLICATION with every prior binding/time/index/coverage valid', () => {
  const f = fixture(); f.request.applications = [];
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.barrier, 'FINAL_TYPED_G1_APPLICATION');
  assert.equal(r.reason, 'TYPED_G1_APPLICATION_UNOBSERVED');
  assert.ok(r.refs.includes('registered-time')); assert.ok(r.refs.includes('coverage-control-restoration'));
  assert.equal(r.scientificAcceptance, false);
});
test('positive structural path is labelled TEST_FIXTURE, and never scientific acceptance', () => {
  const f = fixture(), r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'READY'); assert.equal(r.barrier, 'COMPLETE');
  assert.equal(r.basis, 'TEST_FIXTURE'); assert.equal(r.scientificAcceptance, false);
});
test('a foreign function cannot satisfy preregistered supply coverage', () => {
  const f = fixture(false, 'foreign');
  assert.equal(f.request.applications.length, 2);
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'REJECTED'); assert.equal(r.barrier, 'WINDOW_COVERAGE');
  assert.equal(r.reason, 'COVERAGE_FOREIGN_FUNCTION_CONTRADICTION');
  assert.ok(r.refs.includes('registered-time'));
  assert.ok(r.refs.includes('coverage-treatment-reference'));
  assert.equal(r.scientificAcceptance, false);
});
test('foreign samples excluded from the census leave missing supply UNKNOWN', () => {
  const f = fixture(false, 'foreign', false);
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.barrier, 'TYPED_ABSENCE');
  assert.equal(r.reason, 'TYPED_LOCAL_ABSENCE_UNOBSERVED');
  assert.ok(r.refs.includes('source-restoration'));
  assert.equal(r.scientificAcceptance, false);
});
test('a service without observed functionId cannot certify coverage', () => {
  const f = fixture(false, null);
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.barrier, 'WINDOW_COVERAGE');
  assert.equal(r.reason, 'SERVICE_FUNCTION_UNOBSERVED');
});
test('each preregistered arm, phase and function needs its own coverage', () => {
  const f = fixture(); f.request.coverage.pop();
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.barrier, 'WINDOW_COVERAGE');
  assert.equal(r.reason, 'ARM_PHASE_FUNCTION_COVERAGES_REQUIRED');
  assert.ok(r.refs.includes('registered-time'));
});
test('a seal string without exact bindings cannot reach READY', () => {
  const f = fixture(); f.proofs.delete('protocol');
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.reason, 'PROOF_NOT_INDEXED:protocol');
});
test('a signed and indexed protocol without observed application still fails closed', () => {
  const f = fixture(); f.proofs.delete('application-removal');
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.barrier, 'FINAL_TYPED_G1_APPLICATION');
  assert.equal(r.reason, 'PROOF_NOT_INDEXED:application-removal');
});
test('indexed bytes and declared digest must match exactly', () => {
  const f = fixture(); f.proofs.get('protocol')!.canonicalJson += ' ';
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'REJECTED'); assert.equal(r.reason, 'PROOF_HASH_CONTRADICTION:protocol');
});
test('definitions missing from their index remain UNKNOWN', () => {
  const f = fixture(); f.proofs.delete('definitions');
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.reason, 'PROOF_NOT_INDEXED:definitions');
});
test('a declared function without its indexed registry remains UNKNOWN', () => {
  const f = fixture(); f.g1.delete('function-registry');
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.barrier, 'PROTOCOL');
  assert.equal(r.reason, 'G1_NOT_INDEXED:function-registry');
});
test('missing observed G1 preregistration content hash remains UNKNOWN', () => {
  const f = fixture(), registration = f.g1.get('g1-registration')!;
  const payload = registration.value.payload, coverage = registration.value.fieldCoverage;
  assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
  assert.ok(coverage && typeof coverage === 'object' && !Array.isArray(coverage));
  delete payload.contentHash;
  coverage.contentHash = { status: 'missing', reason: 'TEST_FIXTURE omitted' };
  registration.sha256 = proofHash(canonicalProofJson(registration.value));
  f.request.registration = f.mutate(f.request.registration, p => {
    p.g1Registration = { id: 'g1-registration', sha256: registration.sha256 };
  });
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.barrier, 'PREREGISTRATION_TIME');
  assert.equal(r.reason, 'FIELD_UNOBSERVED:contentHash');
});
test('dates written into a receipt cannot substitute for its signature', () => {
  const f = fixture();
  const ref = f.mutate({ id: 'registered-time', sha256: f.proofs.get('registered-time')!.sha256 }, p => { p.at = '2026-10-01T00:00:02.000Z'; });
  f.request.registration = f.mutate(f.request.registration, p => { p.receipt = ref; });
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'REJECTED'); assert.equal(r.reason, 'TIME_SIGNATURE_INVALID');
});
test('a valid signature at/after the first data is positively REJECTED', () => {
  const f = fixture();
  const late = f.receipt('registered-time', 'registration', '2026-10-01T00:00:01.000Z', f.request.protocol.sha256, null, null);
  f.request.registration = f.mutate(f.request.registration, p => { p.receipt = late; });
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'REJECTED'); assert.equal(r.barrier, 'PREREGISTRATION_TIME');
  assert.equal(r.reason, 'REGISTRATION_NOT_BEFORE_FIRST_DATA');
});
test('an unconfigured temporal authority remains UNKNOWN', () => {
  const f = fixture();
  const r = validateCausalProof({ ...f.ctx, timeAuthorities: new Map() }, f.request);
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.reason, 'TIME_AUTHORITY_NOT_CONFIGURED');
});
test('positive source-order contradiction is REJECTED even with a missing sibling ancestor', () => {
  const f = fixture(); const rows = f.g1.get('treatment')!.value.records;
  assert.ok(Array.isArray(rows)); const after = rows.find(r => typeof r === 'object' && r !== null && !Array.isArray(r) && r.recordId === 'after-removal');
  assert.ok(after && typeof after === 'object' && !Array.isArray(after));
  assert.ok(after.causalContext && typeof after.causalContext === 'object' && !Array.isArray(after.causalContext));
  after.causalContext.predecessorRecordIds = ['missing', 'before-removal'];
  const order = f.g1.get('treatment')!.namespace!.get('order')!.value.payload;
  assert.ok(order && typeof order === 'object' && !Array.isArray(order)); order.sourceSHA = 'c'.repeat(40);
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'REJECTED'); assert.equal(r.barrier, 'LINEAGE');
  assert.equal(r.reason, 'ANCESTOR_SOURCE_ORDER_CONTRADICTION');
});
test('PARTIAL declared coverage cannot pass the application barrier', () => {
  const f = fixture(); f.request.coverage[0] = f.mutate(f.request.coverage[0], p => { p.quality = 'PARTIAL'; });
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.barrier, 'WINDOW_COVERAGE');
  assert.equal(r.reason, 'PARTIAL_OR_CENSORED_COVERAGE');
});
test('foreign censored subject is a positive contradiction', () => {
  const f = fixture(); f.request.coverage[0] = f.mutate(f.request.coverage[0], p => {
    p.censored = [{ actorId: 'foreign', lastObservedTick: 5, reason: 'lost' }];
  });
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'REJECTED'); assert.equal(r.reason, 'CENSOR_CONTRADICTION');
});
test('unobserved application field remains UNKNOWN at the final typed barrier', () => {
  const f = fixture(); const ref = f.request.applications[0], doc: JsonObject = JSON.parse(f.proofs.get(ref.id)!.canonicalJson);
  assert.ok(doc.payload && typeof doc.payload === 'object' && !Array.isArray(doc.payload));
  assert.ok(doc.fieldCoverage && typeof doc.fieldCoverage === 'object' && !Array.isArray(doc.fieldCoverage));
  delete doc.payload.after; doc.fieldCoverage.after = { status: 'missing', reason: 'not observed' };
  const canonicalJson = canonicalProofJson(doc), sha256 = proofHash(canonicalJson);
  f.proofs.set(ref.id, { canonicalJson, sha256 }); f.request.applications[0] = { id: ref.id, sha256 };
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.barrier, 'FINAL_TYPED_G1_APPLICATION'); assert.equal(r.reason, 'FIELD_UNOBSERVED:after');
});
test('application references must stay inside the treatment namespace', () => {
  const f = fixture(); f.request.applications[0] = f.mutate(f.request.applications[0], p => { p.inputRefs = ['control#intervention-inputs']; });
  // The declared intervention is kept consistent so the deeper namespace guard is the oracle.
  const i = f.g1.get('treatment')!.namespace!.get('removal')!;
  const payload = i.value.payload; assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
  payload.inputRefs = ['control#intervention-inputs'];
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'REJECTED'); assert.equal(r.barrier, 'FINAL_TYPED_G1_APPLICATION');
  assert.equal(r.reason, 'APPLICATION_INPUT_NAMESPACE_CONTRADICTION');
});
test('canonical encoding rejects nonfinite, unsafe, negative-zero and duplicate-key documents', () => {
  for (const n of [NaN, Infinity, 9007199254740992, -0]) assert.throws(() => canonicalProofJson({ n }));
  const f = fixture(), entry = f.proofs.get('protocol')!;
  const bytes = entry.canonicalJson.replace('"version":', '"version":"duplicate","version":');
  const sha256 = proofHash(bytes); f.proofs.set('protocol', { canonicalJson: bytes, sha256 }); f.request.protocol.sha256 = sha256;
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'REJECTED'); assert.equal(r.reason, 'PROOF_NOT_CANONICAL');
});
test('an exact empty window still needs typed local physical absence after application', () => {
  const f = fixture(true), r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.barrier, 'TYPED_ABSENCE');
  assert.equal(r.reason, 'TYPED_LOCAL_ABSENCE_UNOBSERVED');
});
test('physical cuts and a law seal cannot invent interval-wide absence', () => {
  const f = fixture(true), c = f.request.coverage.find(r => r.id === 'coverage-treatment-removal')!;
  const law = f.g1.get('treatment')!.namespace!.get('law')!;
  f.request.absences = [f.add('absence-removal', 'absence', { protocolHash: f.request.protocol.sha256, coverage: c,
    subjectId: 'tool', functionId: 'supply', opportunityCount: 1, eligibleActorIds: ['mortal'],
    physicalCuts: [{ id: 'after-removal', sha256: f.proofs.get('after-removal')!.sha256 }],
    predicate: { field: 'condition', value: 0, unit: 'condition' }, sourceLaw: { id: 'law', sha256: law.sha256 } })];
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.barrier, 'TYPED_ABSENCE');
  assert.equal(r.reason, 'PHYSICAL_ABSENCE_INTERVAL_LAW_UNAVAILABLE');
});
test('an altered physical cut cannot replace the exact cut attested by the source', () => {
  const f = fixture();
  const altered = f.mutate({ id: 'after-removal', sha256: f.proofs.get('after-removal')!.sha256 }, p => { p.value = 0.5; });
  f.request.applications[0] = f.mutate(f.request.applications[0], p => { p.after = altered; });
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'REJECTED'); assert.equal(r.barrier, 'FINAL_TYPED_G1_APPLICATION');
  assert.equal(r.reason, 'SOURCE_APPLICATION_BINDING_CONTRADICTION');
});
test('tick coincidence without a typed source application stays UNKNOWN', () => {
  const f = fixture(); f.proofs.delete('source-removal');
  const r = validateCausalProof(f.ctx, f.request);
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.barrier, 'FINAL_TYPED_G1_APPLICATION');
  assert.equal(r.reason, 'PROOF_NOT_INDEXED:source-removal');
});
test('a source signer must be configured out of band for the exact SHA', () => {
  const f = fixture();
  const r = validateCausalProof({ ...f.ctx, sourceAuthorities: new Map() }, f.request);
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.barrier, 'FINAL_TYPED_G1_APPLICATION');
  assert.equal(r.reason, 'SOURCE_APPLICATION_AUTHORITY_UNAVAILABLE');
});
