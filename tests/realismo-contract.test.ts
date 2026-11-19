import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  CONTRACT_VERSION, FAMILIES, EVIDENCE_KINDS, parseStrictJSON, validateShape, validateSemantics,
  validateBundleFile, confinedInputPath, sha256,
  inspectServiceLinks,
} from '../scripts/lab/realismo-contract.js';
import type { JsonObject, SchemaName } from '../scripts/lab/realismo-contract.js';

const examples = resolve('specs/003-criterios-realismo/contracts/examples');
const text = (name: string): string => readFileSync(resolve(examples, name), 'utf8');
const json = (name: string): JsonObject => JSON.parse(text(name));
const clone = (value: JsonObject): JsonObject => structuredClone(value);
const observation = (): JsonObject => json('conservation-service.v3.json');
const rejected = (doc: JsonObject): string[] => {
  const report = validateSemantics('observation.schema.json', doc);
  assert.equal(report.valid, false); return report.issues.map(i => i.code);
};
const records = (doc: JsonObject): JsonObject[] => doc.records as JsonObject[];
const streams = (doc: JsonObject): JsonObject[] => doc.streams as JsonObject[];
const find = (doc: JsonObject, family: string): JsonObject => records(doc).find(r => r.family === family)!;

test('manual contract surface: realismo-v3, 22 distinct families and 30 evidence kinds', () => {
  assert.equal(CONTRACT_VERSION, 'realismo-v3'); assert.equal(FAMILIES.length, 22); assert.equal(new Set(FAMILIES).size, 22);
  assert.equal(EVIDENCE_KINDS.length, 30); assert.equal(new Set(EVIDENCE_KINDS).size, 30);
});

test('strict grammar and decoded duplicate keys at every depth before discarded values', () => {
  for (const invalid of ['{"a":1,"a":2}', '{"outer":{"a":1,"\\u0061":2}}', '[{"z":{"a":0,"\\u0061":1}}]',
    '{"a":NaN}', '{"a":Infinity}', '{"a":1e309}', '{"a":1,}', '//comment\n{"a":1}', '{"a":1/*comment*/}'])
    assert.throws(() => parseStrictJSON(invalid), invalid);
  assert.deepEqual(parseStrictJSON('{"x":{"a":1},"y":{"a":2},"condition":0.1}'), { x: { a: 1 }, y: { a: 2 }, condition: 0.1 });
});

test('integer lexemes reject fractions and unsafe values even after JSON.parse rounds them', () => {
  for (const literal of ['0.5', '9007199254740992', '9007199254740991.1', '9007199254740993', '1e-1000'])
    assert.throws(() => parseStrictJSON(`{"quantity":{"value":${literal},"unit":"quanta"}}`), literal);
  assert.throws(() => parseStrictJSON('{"tick":9007199254740991.1}'));
  assert.deepEqual(parseStrictJSON('{"quantity":{"value":9007199254740991,"unit":"quanta"},"condition":0.1}'),
    { quantity: { value: 9007199254740991, unit: 'quanta' }, condition: 0.1 });
  assert.deepEqual(parseStrictJSON('{"quantity":{"value":1.0,"unit":"quanta"}}'), { quantity: { value: 1, unit: 'quanta' } });
});

test('schema and numeric runtime reject wrong version, NaN, infinity and unsupported quantities without mutation', () => {
  const base = observation(); const before = structuredClone(base);
  assert.equal(validateShape('observation.schema.json', base).valid, true); assert.deepEqual(base, before);
  for (const value of ['realismo-v2', 'other']) { const x = clone(base); x.contractVersion = value; assert.equal(validateShape('observation.schema.json', x).valid, false); }
  for (const value of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const x = clone(base); (find(x, 'flow').payload as JsonObject).quantity = { value, unit: 'quanta', material: 'wood', conversionVersion: 'manual-quanta' };
    assert.equal(validateShape('observation.schema.json', x).valid, false);
  }
  const x = clone(base); (find(x, 'flow').payload as JsonObject).quantity = { value: 0.5, unit: 'quanta', material: 'wood', conversionVersion: 'manual-quanta' };
  assert.equal(validateShape('observation.schema.json', x).valid, false);
});

test('manual identity probes: duplicate records, epoch/stream sequence and capabilities', () => {
  const x = observation(); records(x)[1].recordId = records(x)[0].recordId; assert.ok(rejected(x).includes('DUPLICATE_RECORD'));
  const y = observation(); const list = records(y).filter(r => r.family === 'structure'); list[1].seq = list[0].seq;
  assert.ok(rejected(y).includes('DUPLICATE_SEQUENCE'));
  const z = observation(); z.capabilities = Array.from({ length: 22 }, () => clone((z.capabilities as JsonObject[])[0]));
  assert.equal(validateShape('observation.schema.json', z).valid, false);
});

test('COMPLETE is checked against actual records, seq ranges, fields and gaps', () => {
  for (const change of [
    (s: JsonObject) => { s.firstSeq = 9; s.lastSeq = 3; },
    (s: JsonObject) => { s.expectedRecords = 1; s.observedRecords = 99; },
    (s: JsonObject) => { s.requiredFields = []; s.coveredFields = []; },
    (s: JsonObject) => { s.gaps = [{ startTick: 0, endTick: 1, reason: 'lost' }]; },
  ]) { const x = observation(); change(streams(x).find(s => s.family === 'stock')!); assert.equal(validateSemantics('observation.schema.json', x).valid, false); }
  const partial = observation(); const service = find(partial, 'service');
  assert.equal((service.fieldCoverage as JsonObject).baselineBenefit !== undefined, true);
  assert.equal(validateSemantics('observation.schema.json', partial).valid, true);
  const falseCoverage = observation(); (find(falseCoverage, 'service').fieldCoverage as JsonObject).baselineBenefit = { status: 'observed', reason: 'lie' };
  assert.ok(rejected(falseCoverage).includes('FIELD_COVERAGE'));
});

test('window is opening-excluded/closing-included with explicit opening snapshots', () => {
  const base = observation(); assert.equal(validateSemantics('observation.schema.json', base).valid, true);
  assert.equal(find(base, 'boundary').tick, 0);
  const bad = clone(base); find(bad, 'service').tick = 0; assert.ok(rejected(bad).includes('RECORD_WINDOW'));
  const beyond = clone(base); find(beyond, 'flow').tick = 2; assert.ok(rejected(beyond).includes('RECORD_WINDOW'));
  const wrong = clone(base); (wrong.actualWindow as JsonObject).epochId = 'another'; assert.ok(rejected(wrong).includes('WINDOW_IDENTITY'));
  const reversed = clone(base); (reversed.actualWindow as JsonObject).startTick = 2; assert.ok(rejected(reversed).includes('WINDOW_ORDER'));
});

test('closing without opening and stale physical cut remain UNKNOWN, with no fake balance', () => {
  const x = observation(); x.records = records(x).filter(r => r.recordId !== 'wood-opening');
  const stock = streams(x).find(s => s.family === 'stock')!; stock.quality = 'PARTIAL'; stock.observedRecords = 1;
  const report = validateSemantics('observation.schema.json', x); assert.equal(report.valid, true); assert.ok(report.unknowns.some(i => i.code === 'MISSING_OPENING_CUT'));
  const y = observation(); (records(y).find(r => r.recordId === 'wood-closing')!.payload as JsonObject).clockTick = 0;
  const stale = validateSemantics('observation.schema.json', y); assert.equal(stale.valid, true); assert.ok(stale.unknowns.some(i => i.code === 'ASYNCHRONOUS_CUT'));
});

test('transfer identity cannot double count an unproven repeated physical flow', () => {
  const x = observation(); const flow = clone(find(x, 'flow')); flow.recordId = 'duplicate-flow'; flow.seq = 1; records(x).push(flow);
  streams(x).find(s => s.family === 'flow')!.observedRecords = 2;
  assert.ok(rejected(x).includes('DUPLICATE_TRANSFER'));
});

test('local evidence confinement rejects traversal, URLs and a symlink outside input root', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'realismo-paths-'));
  try {
    writeFileSync(resolve(dir, 'inside.json'), '{}'); symlinkSync(resolve(examples, 'params.json'), resolve(dir, 'escape.json'));
    assert.equal(confinedInputPath(dir, 'inside.json'), resolve(dir, 'inside.json'));
    for (const bad of ['../params.json', '/etc/passwd', 'https://example.test/input.json', 'escape.json', '..\\params.json'])
      assert.throws(() => confinedInputPath(dir, bad));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The frozen index is a manual documentary oracle, never an output generated by an evaluator.
const index = json('index.v3.json');
for (const entry of index.files as JsonObject[]) {
  test(`frozen wire oracle ${entry.validationLayer}: ${entry.file} -> ${entry.expected}`, () => {
    assert.equal(sha256(text(String(entry.file))), entry.sha256);
    const expected = String(entry.expected); const name = entry.schema as SchemaName;
    if (entry.validationLayer === 'parser-runtime') { assert.throws(() => parseStrictJSON(text(String(entry.file)))); return; }
    if (entry.validationLayer === 'structural') {
      assert.equal(validateShape(name, text(String(entry.file))).valid, !expected.startsWith('REJECT')); return;
    }
    if (expected === 'REJECT') { assert.equal(validateSemantics(name, text(String(entry.file))).valid, false); return; }
    const report = validateBundleFile(resolve(examples, String(entry.file)));
    assert.equal(report.valid, expected !== 'REJECT_BINDING', JSON.stringify(report.issues));
    if (expected === 'UNKNOWN_CAUSAL_SUBGATES') { assert.ok(report.serviceLinks.some(s => s.state === 'UNKNOWN')); }
    if (expected === 'BALANCE_CLOSED_C10_FAIL_BASELINE_UNKNOWN') {
      const doc = report.value!; const stocks = records(doc).filter(r => r.family === 'stock');
      const opening = (stocks.find(r => (r.payload as JsonObject).phase === 'opening')!.payload as JsonObject);
      const closing = (stocks.find(r => (r.payload as JsonObject).phase === 'closing')!.payload as JsonObject);
      const flow = find(doc, 'flow').payload as JsonObject;
      // Independent arithmetic and declared law at the same event; no C10 evaluator is implemented.
      assert.equal((opening.quantity as JsonObject).value, 1); assert.equal(opening.ownerId, 'S');
      assert.equal((closing.quantity as JsonObject).value, 0); assert.equal((flow.quantity as JsonObject).value, 1);
      assert.equal((opening.quantity as JsonObject).value, Number((closing.quantity as JsonObject).value) + Number((flow.quantity as JsonObject).value));
      assert.equal((find(doc, 'boundary').payload as JsonObject).scope, 'partial');
      const link = report.serviceLinks.find(s => s.recordId === 'service-1')!;
      assert.equal(link.state, 'BOUND'); assert.equal(link.condition, 0.1); assert.equal(link.appliedValue, 0.1); assert.equal(link.baselineAvailable, false);
      const law = report.catalog.get('law')!.value.payload as JsonObject;
      assert.equal(((law.parameters as JsonObject[])[0]).value, 0.1);
      assert.ok(String((law.formulaDefinitions as JsonObject[])[0].expression).includes('condition > functionalCutoff'));
      assert.equal(link.condition! > 0.1, false); // Handwritten C10 violation fact remains; marginal baseline stays unavailable.
    }
    if (expected === 'VALID_BINDINGS_CAUSAL_UNKNOWN') {
      assert.ok(report.catalog.has('bundle-treatment')); assert.ok(report.catalog.has('bundle-control'));
      assert.ok(report.unknowns.some(u => u.code === 'REFERENCE_UNAVAILABLE'));
    }
  });
}

test('causal SHA/order/event removal preserves a valid partial protected balance', () => {
  for (const file of ['unknown-law-sha.v3.json', 'unknown-order-sha.v3.json', 'unknown-service-order.v3.json', 'unknown-service-condition-event.v3.json', 'negative-condition-input-event.v3.json']) {
    const report = validateBundleFile(resolve(examples, file)); assert.equal(report.valid, true, JSON.stringify(report.issues));
    assert.equal(report.serviceLinks.find(s => s.recordId === 'service-1')?.state, 'UNKNOWN');
    assert.equal((find(report.value!, 'boundary').payload as JsonObject).includesProtected, true);
    assert.equal((records(report.value!).find(r => r.recordId === 'wood-opening')!.payload as JsonObject).ownerId, 'S');
  }
});

test('COMPLETE must match per-record fields and cannot override unavailable capability', () => {
  const x = observation(); const stock = find(x, 'stock'); delete (stock.payload as JsonObject).quantity;
  (stock.fieldCoverage as JsonObject).quantity = { status: 'missing', reason: 'lost cut' };
  assert.equal(validateShape('observation.schema.json', x).valid, true);
  assert.ok(rejected(x).includes('COMPLETE_RECORD_FIELDS'));
  const y = observation(); y.records = records(y).filter(r => r.family !== 'stock');
  const stream = streams(y).find(s => s.family === 'stock')!;
  stream.expectedRecords = 0; stream.observedRecords = 0; stream.firstSeq = null; stream.lastSeq = null;
  const cap = (y.capabilities as JsonObject[]).find(c => c.family === 'stock')!;
  cap.status = 'unavailable'; cap.missingFields = cap.availableFields; cap.availableFields = [];
  assert.ok(rejected(y).includes('UNAVAILABLE_CAPABILITY_RECORDS'));
});

function withManualFiles(body: (dir: string) => void): void {
  const dir = mkdtempSync(resolve(tmpdir(), 'realismo-wire-'));
  try { cpSync(examples, dir, { recursive: true }); body(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const save = (dir: string, name: string, doc: JsonObject): string => {
  const bytes = JSON.stringify(doc); writeFileSync(resolve(dir, name), bytes); return sha256(bytes);
};
const repin = (doc: JsonObject, id: string, hash: string): void => {
  (doc.evidenceIndex as JsonObject[]).find(e => e.evidenceId === id)!.sha256 = hash;
};

test('source predecessor cycle or later event gives UNKNOWN without discarding independent stock', () => {
  for (const mode of ['cycle', 'later']) withManualFiles(dir => {
    const doc = observation(); const service = find(doc, 'service'); const c = service.causalContext as JsonObject;
    if (mode === 'cycle') c.predecessorRecordIds = ['service-1'];
    else {
      const future = clone(records(doc).find(r => r.recordId === 'condition-at-service-1')!);
      future.recordId = 'future-condition'; future.seq = 2;
      future.causalContext = { ...(future.causalContext as JsonObject), sourceEventId: 'future-event', eventOrdinal: 1, predecessorRecordIds: [] };
      records(doc).push(future); streams(doc).find(s => s.family === 'structure')!.observedRecords = 3;
      c.predecessorRecordIds = ['future-condition'];
      const order = json('order.json'); ((order.payload as JsonObject).entries as JsonObject[]).push({
        sourceEventId: 'future-event', tick: 1, phaseId: 'service', phaseOrdinal: 1, eventOrdinal: 1, recordIds: ['future-condition'],
      }); repin(doc, 'order', save(dir, 'order.json', order));
    }
    save(dir, 'manual.json', doc); const report = validateBundleFile(resolve(dir, 'manual.json'));
    assert.equal(report.valid, true, JSON.stringify(report.issues)); assert.equal(report.serviceLinks[0].state, 'UNKNOWN');
    assert.equal((records(report.value!).find(r => r.recordId === 'wood-opening')!.payload as JsonObject).ownerId, 'S');
  });
});

test('indexed observation validates its own declared leaf hashes', () => withManualFiles(dir => {
  const leaf = json('bundle-treatment.v3.json'); (leaf.evidenceIndex as JsonObject[])[0].sha256 = '0'.repeat(64);
  const root = json('crossrun-input.v3.json'); repin(root, 'bundle-treatment', save(dir, 'bundle-treatment.v3.json', leaf));
  save(dir, 'manual-root.json', root); const report = validateBundleFile(resolve(dir, 'manual-root.json'));
  assert.equal(report.valid, false); assert.ok(report.issues.some(i => i.code === 'EVIDENCE_HASH'));
}));

test('pair service references stay inside their arm despite record ID collision in parent', () => withManualFiles(dir => {
  const root = json('crossrun-input.v3.json'); const manual = observation();
  const leaf = clone(manual); leaf.evidenceId = 'bundle-treatment'; leaf.runId = 'synthetic-treatment'; leaf.artifactRole = 'paired-treatment'; leaf.pairedRunId = 'synthetic-control';
  (leaf.plannedWindow as JsonObject).endTick = 72000;
  const sharedService = find(leaf, 'service'); sharedService.recordId = 'shared-id';
  repin(root, 'bundle-treatment', save(dir, 'bundle-treatment.v3.json', leaf));
  const manifest = json('run-manifest-treatment.v3.json'); (manifest.payload as JsonObject).runStatus = leaf.runStatus;
  repin(root, 'manifest-treatment', save(dir, 'run-manifest-treatment.v3.json', manifest));
  const pair = json('causal-pair-c11.json');
  for (const window of (pair.payload as JsonObject).windows as JsonObject[]) window.treatmentServiceRefs = ['shared-id'];
  repin(root, 'C11-pair', save(dir, 'causal-pair-c11.json', pair));
  const parentStock = clone(find(manual, 'stock')); parentStock.recordId = 'shared-id';
  root.records = [parentStock]; root.actualWindow = clone(manual.actualWindow as JsonObject); root.runStatus = 'partial';
  const stockStream = clone(streams(manual).find(s => s.family === 'stock')!); stockStream.quality = 'PARTIAL'; stockStream.observedRecords = 1;
  root.streams = [stockStream];
  const cap = (root.capabilities as JsonObject[]).find(c => c.family === 'stock')!;
  Object.assign(cap, clone((manual.capabilities as JsonObject[]).find(c => c.family === 'stock')!));
  save(dir, 'manual-root.json', root); const report = validateBundleFile(resolve(dir, 'manual-root.json'));
  assert.equal(report.valid, true, JSON.stringify(report.issues));
  assert.ok(!report.issues.some(i => i.path.includes('treatmentServiceRefs')));
}));

test('index hash, synthetic identity, unavailable profile and input binding contradictions reject integrity', () => withManualFiles(dir => {
  const badHash = observation(); (badHash.evidenceIndex as JsonObject[])[0].sha256 = 'f'.repeat(64);
  save(dir, 'bad-hash.json', badHash); assert.ok(validateBundleFile(resolve(dir, 'bad-hash.json')).issues.some(i => i.code === 'EVIDENCE_HASH'));
  const wrongSynthetic = observation(); (wrongSynthetic.evidenceIndex as JsonObject[])[0].synthetic = false;
  save(dir, 'bad-identity.json', wrongSynthetic); assert.ok(validateBundleFile(resolve(dir, 'bad-identity.json')).issues.some(i => i.code === 'EVIDENCE_IDENTITY'));
  const wrongProfile = observation(); wrongProfile.thresholdProfileHash = 'f'.repeat(64);
  save(dir, 'bad-profile.json', wrongProfile); assert.ok(validateBundleFile(resolve(dir, 'bad-profile.json')).issues.some(i => i.code === 'UNSUPPORTED_PROFILE'));
}));

test('reused capability and causalContext definitions enforce typed reference targets', () => {
  for (const place of ['capability', 'causalContext']) withManualFiles(dir => {
    const doc = observation();
    if (place === 'capability') (doc.capabilities as JsonObject[])[0].sourceRefs = ['law'];
    else (find(doc, 'service').causalContext as JsonObject).sourceOrderRef = 'law';
    save(dir, 'manual.json', doc); const report = validateBundleFile(resolve(dir, 'manual.json'));
    assert.equal(report.valid, false);
    assert.ok(report.issues.some(i => i.code === 'REFERENCE_TARGET_TYPE' && i.path.includes(place === 'capability' ? '/capabilities/0/sourceRefs' : '/causalContext/sourceOrderRef')));
  });
});

test('reused stream evidence refs detect missing inputs without discarding observed stock', () => withManualFiles(dir => {
  const doc = observation(); streams(doc)[0].evidenceRefs = ['absent-stream-evidence'];
  save(dir, 'manual.json', doc); const report = validateBundleFile(resolve(dir, 'manual.json'));
  assert.equal(report.valid, true, JSON.stringify(report.issues));
  assert.ok(report.unknowns.some(i => i.code === 'REFERENCE_UNAVAILABLE' && i.path === '/streams/0/evidenceRefs'));
  assert.equal((find(report.value!, 'stock').payload as JsonObject).ownerId, 'S');
}));

test('nested evaluation result, subgate and metric definitions resolve every evidence reference', () => {
  for (const place of ['result', 'subgate', 'metric']) withManualFiles(dir => {
    const evaluation = json('evaluation-partial.json');
    const result = (evaluation.results as JsonObject[])[1];
    const subgate = (result.subgates as JsonObject[])[0];
    const metric = (subgate.metrics as JsonObject[])[0];
    (place === 'result' ? result : place === 'subgate' ? subgate : metric).evidenceRefs = [`absent-${place}`];
    const root = json('negative-evaluation-input.v3.json');
    const entry = (root.evidenceIndex as JsonObject[]).find(e => e.kind === 'evaluation')!;
    entry.relativePath = 'manual-evaluation.json'; entry.sha256 = save(dir, 'manual-evaluation.json', evaluation);
    save(dir, 'manual-root.json', root); const report = validateBundleFile(resolve(dir, 'manual-root.json'));
    assert.equal(report.valid, true, JSON.stringify(report.issues));
    const suffix = place === 'result' ? '/results/1/evidenceRefs' : place === 'subgate'
      ? '/results/1/subgates/0/evidenceRefs' : '/results/1/subgates/0/metrics/0/evidenceRefs';
    assert.ok(report.unknowns.some(i => i.code === 'REFERENCE_UNAVAILABLE' && i.path === suffix && i.message === `absent-${place}`));
  });
});

test('reused panel definition rejects an observation where an evaluation is required', () => withManualFiles(dir => {
  const evaluation = json('evaluation-partial.json');
  evaluation.panels = [{ panelId: 'manual-panel', criterion: 'C9', profileRuleId: 'manual-not-science', plannedSeeds: [0],
    pass: 0, fail: 0, unknown: 1, total: 1, state: 'UNKNOWN', quality: 'PARTIAL', safetyState: 'UNKNOWN',
    reasonCodes: ['MISSING_FIELD'], replicaResultRefs: ['manual-partial-observation'] }];
  const root = json('negative-evaluation-input.v3.json');
  const entry = (root.evidenceIndex as JsonObject[]).find(e => e.kind === 'evaluation')!;
  entry.relativePath = 'manual-evaluation.json'; entry.sha256 = save(dir, 'manual-evaluation.json', evaluation);
  save(dir, 'manual-root.json', root); const report = validateBundleFile(resolve(dir, 'manual-root.json'));
  assert.equal(report.valid, false);
  assert.ok(report.issues.some(i => i.code === 'REFERENCE_TARGET_TYPE' && i.path === '/panels/0/replicaResultRefs'));
}));

test('F1 integer unit and integer array lexemes survive neither rounding nor underflow', () => {
  for (const unit of ['quanta', 'count', 'bytes', 'ticks']) for (const literal of ['1.0000000000000001', '1e-1000', '9007199254740991.1'])
    assert.throws(() => parseStrictJSON(`{"quantity":{"value":${literal},"unit":"${unit}"}}`));
  for (const literal of ['1e-1000', '1.0000000000000001'])
    assert.throws(() => parseStrictJSON(`{"panels":[{"plannedSeeds":[${literal}]}]}`));
  assert.deepEqual(parseStrictJSON('{"plannedSeeds":[0,1e2],"quantity":{"value":0.1,"unit":"normalized"}}'),
    { plannedSeeds: [0, 100], quantity: { value: 0.1, unit: 'normalized' } });
});

test('F2 records must respect their own stream opening, including valid narrowed partial streams', () => {
  const x = observation(); (streams(x).find(s => s.family === 'stock')!.window as JsonObject).startTick = 1;
  assert.ok(rejected(x).includes('RECORD_STREAM_WINDOW'));
  const y = observation(); (y.actualWindow as JsonObject).endTick = 2; (y.plannedWindow as JsonObject).endTick = 2;
  assert.equal(validateSemantics('observation.schema.json', y).valid, true, 'streams may retain their own shorter window');
  const z = observation(); (streams(z).find(s => s.family === 'service')!.window as JsonObject).startTick = 1;
  assert.ok(rejected(z).includes('RECORD_STREAM_WINDOW'), 'service at opening is not an opening snapshot');
});

test('F3 observation physical identity is checked without a run manifest; missing fields remain UNKNOWN', () => {
  for (const field of ['initialStateHash', 'paramsHash']) withManualFiles(dir => {
    const doc = observation(); const inputs = json('inputs.json'); (inputs.payload as JsonObject)[field] = 'f'.repeat(64);
    repin(doc, 'inputs', save(dir, 'inputs.json', inputs)); save(dir, 'manual.json', doc);
    const report = validateBundleFile(resolve(dir, 'manual.json')); assert.equal(report.valid, false);
    assert.ok(report.issues.some(i => i.code === 'PHYSICAL_BINDING' && i.path.endsWith(`/inputs/${field}`)));
  });
  withManualFiles(dir => {
    const doc = observation(); const inputs = json('inputs.json'); delete (inputs.payload as JsonObject).initialStateHash;
    (inputs.fieldCoverage as JsonObject).initialStateHash = { status: 'missing', reason: 'not observed' };
    repin(doc, 'inputs', save(dir, 'inputs.json', inputs)); save(dir, 'manual.json', doc);
    const report = validateBundleFile(resolve(dir, 'manual.json')); assert.equal(report.valid, true, JSON.stringify(report.issues));
    assert.ok(report.unknowns.some(i => i.code === 'PHYSICAL_BINDING_UNAVAILABLE'));
  });
});

test('F3 initial state proof requires snapshot and pair declarations match physical arm hashes', () => {
  withManualFiles(dir => {
    const root = json('crossrun-input.v3.json'); const entry = (root.evidenceIndex as JsonObject[]).find(e => e.evidenceId === 'initial-state')!;
    const state = JSON.parse(readFileSync(resolve(dir, String(entry.relativePath)), 'utf8')) as JsonObject;
    ((state.payload as JsonObject).components as JsonObject[]).find(c => c.component === 'snapshot')!.component = 'chronicle';
    entry.sha256 = save(dir, String(entry.relativePath), state); save(dir, 'manual.json', root);
    assert.ok(validateBundleFile(resolve(dir, 'manual.json')).issues.some(i => i.code === 'INITIAL_STATE_HASH'));
  });
  for (const field of ['initialStateHash', 'paramsHash', 'inputTraceHash', 'governorTraceHash']) withManualFiles(dir => {
    const root = json('crossrun-input.v3.json'); const pair = json('causal-pair-c11.json'); (pair.payload as JsonObject)[field] = 'f'.repeat(64);
    repin(root, 'C11-pair', save(dir, 'causal-pair-c11.json', pair)); save(dir, 'manual.json', root);
    const report = validateBundleFile(resolve(dir, 'manual.json')); assert.equal(report.valid, false);
    assert.ok(report.issues.some(i => ['PAIR_IDENTITY', 'PAIR_TRACE_HASH'].includes(i.code) && i.path.endsWith(`/${field}`)));
  });
});

test('F4 unresolved ordered predecessor propagates UNKNOWN to dependent service without losing stock', () => {
  for (const ref of [null, 'absent-order']) withManualFiles(dir => {
    const doc = observation(); const predecessor = records(doc).find(r => r.recordId === 'condition-1')!;
    (predecessor.causalContext as JsonObject).sourceOrderRef = ref;
    save(dir, 'manual.json', doc); const report = validateBundleFile(resolve(dir, 'manual.json'));
    assert.equal(report.valid, true, JSON.stringify(report.issues)); assert.equal(report.serviceLinks[0].state, 'UNKNOWN');
    assert.ok(report.unknowns.some(i => i.code === 'CAUSAL_CONTEXT_UNRESOLVED' && i.path === 'flow-1'));
    assert.equal((find(report.value!, 'stock').payload as JsonObject).ownerId, 'S');
  });
});

test('F5 effect consumption references, irreversible debit role, amount and declared conversion reconcile', () => {
  for (const mode of ['refs', 'amount', 'role', 'conversion']) withManualFiles(dir => {
    const doc = observation(); const effect = json('effect.json'); const ep = effect.payload as JsonObject;
    if (mode === 'refs') { ep.consumptionRefs = []; ep.consumedAmount = 0; }
    if (mode === 'amount') ep.consumedAmount = 2;
    if (mode === 'role') (find(doc, 'flow').payload as JsonObject).flowType = 'internal';
    if (mode === 'conversion') {
      (find(doc, 'boundary').payload as JsonObject).conversionMatrixRef = 'unavailable:conversion';
    }
    repin(doc, 'effect', save(dir, 'effect.json', effect)); save(dir, 'manual.json', doc);
    const report = validateBundleFile(resolve(dir, 'manual.json')); assert.equal(report.valid, true, JSON.stringify(report.issues));
    assert.equal(report.serviceLinks[0].state, 'UNKNOWN');
    assert.ok(report.serviceLinks[0].reasons.includes(mode === 'refs' ? 'EFFECT_DEBIT_REFS_UNBOUND' : mode === 'role' ? 'DEBIT_EVENT_UNBOUND' : 'DEBIT_AMOUNT_UNBOUND'));
  });
  withManualFiles(dir => {
    const doc = observation(); save(dir, 'manual.json', doc);
    assert.equal(validateBundleFile(resolve(dir, 'manual.json')).serviceLinks[0].state, 'BOUND', 'explicit identity conversion and matching debit are sufficient');
  });
});

test('F6 output subgates, threshold ownership and all planned seeds obey the pinned profile', () => {
  for (const mode of ['duplicate', 'missing', 'foreign', 'threshold']) {
    const doc = json('evaluation-partial.json'); const result = (doc.results as JsonObject[])[0]; const gates = result.subgates as JsonObject[];
    result.state = 'PASS'; result.quality = 'COMPLETE';
    if (mode === 'duplicate') gates[1].subgateId = gates[0].subgateId;
    if (mode === 'missing') gates.pop();
    if (mode === 'foreign') gates[0].subgateId = 'C10.wear';
    if (mode === 'threshold') gates[0].thresholdIds = ['C10.functionalCutoff'];
    const report = validateSemantics('evaluation.schema.json', doc); assert.equal(report.valid, false);
    assert.ok(report.issues.some(i => i.code === (mode === 'threshold' ? 'THRESHOLD_OWNERSHIP' : 'RESULT_SUBGATES')));
  }
  const doc = json('evaluation-partial.json'); doc.panels = [{ panelId: 'manual', criterion: 'C9', profileRuleId: 'manual', plannedSeeds: [0,1,2,3,4,5,6,7],
    pass: 1, fail: 0, unknown: 0, total: 1, state: 'PASS', quality: 'COMPLETE', safetyState: 'UNKNOWN', reasonCodes: ['MANUAL'], replicaResultRefs: [] }];
  assert.ok(validateSemantics('evaluation.schema.json', doc).issues.some(i => i.code === 'PANEL_TOTAL'));
});

for (const [amount, state] of [[2, 'UNKNOWN'], [1, 'BOUND']] as const)
  test(`F5 canonical physical transfer: reciprocal projections of one debit1 with effect${amount} is ${state}`, () => withManualFiles(dir => {
    const doc = observation(); const first = find(doc, 'flow'); const second = clone(first);
    second.recordId = 'flow-2'; second.seq = 1;
    (first.payload as JsonObject).counterpartRecordId = 'flow-2';
    (second.payload as JsonObject).counterpartRecordId = 'flow-1';
    (first.provenanceRefs as string[]).push('flow-2'); (second.provenanceRefs as string[]).push('flow-1');
    records(doc).push(second);
    const stream = streams(doc).find(s => s.family === 'flow')!;
    stream.lastSeq = 1; stream.expectedRecords = 2; stream.observedRecords = 2;
    (find(doc, 'service').payload as JsonObject).consumptionRefs = ['flow-1', 'flow-2'];
    const effect = json('effect.json'); const payload = effect.payload as JsonObject;
    payload.consumptionRefs = ['flow-1', 'flow-2']; payload.consumedAmount = amount;
    repin(doc, 'effect', save(dir, 'effect.json', effect));
    const order = json('order.json'); const entry = ((order.payload as JsonObject).entries as JsonObject[])
      .find(e => (e.recordIds as string[]).includes('flow-1'))!;
    (entry.recordIds as string[]).push('flow-2'); repin(doc, 'order', save(dir, 'order.json', order));
    save(dir, 'manual.json', doc); const report = validateBundleFile(resolve(dir, 'manual.json'));
    assert.equal(report.valid, true, JSON.stringify(report.issues)); assert.equal(report.serviceLinks[0].state, state);
    if (state === 'UNKNOWN') assert.ok(report.serviceLinks[0].reasons.includes('DEBIT_AMOUNT_UNBOUND'));
    assert.equal((first.payload as JsonObject).transferId, (second.payload as JsonObject).transferId);
    assert.equal(((first.payload as JsonObject).quantity as JsonObject).value, 1, 'manual physical debit is one');
  }));

test('F3 run manifests preserve missing parameter hash as UNKNOWN and reject observed contradiction', () => {
  for (const mode of ['missing', 'contradiction']) withManualFiles(dir => {
    const root = json('crossrun-input.v3.json'); const params = json('params.json');
    if (mode === 'missing') {
      delete (params.payload as JsonObject).paramsHash;
      (params.fieldCoverage as JsonObject).paramsHash = { status: 'missing', reason: 'hash was not observed' };
    } else (params.payload as JsonObject).paramsHash = 'f'.repeat(64);
    const hash = save(dir, 'params.json', params); repin(root, 'params', hash);
    const changedLeafHashes = new Map<string, string>();
    for (const entry of root.evidenceIndex as JsonObject[]) if (entry.kind === 'observation') {
      const leaf = JSON.parse(readFileSync(resolve(dir, String(entry.relativePath)), 'utf8')) as JsonObject;
      const previousHash = String(entry.sha256);
      repin(leaf, 'params', hash); entry.sha256 = save(dir, String(entry.relativePath), leaf);
      changedLeafHashes.set(previousHash, String(entry.sha256));
    }
    for (const entry of root.evidenceIndex as JsonObject[]) if (entry.kind === 'evaluation') {
      const evaluation = JSON.parse(readFileSync(resolve(dir, String(entry.relativePath)), 'utf8')) as JsonObject;
      evaluation.inputHashes = (evaluation.inputHashes as string[]).map(h => changedLeafHashes.get(h) ?? h);
      entry.sha256 = save(dir, String(entry.relativePath), evaluation);
    }
    save(dir, 'manual.json', root); const report = validateBundleFile(resolve(dir, 'manual.json'));
    assert.ok(!report.issues.some(i => i.code === 'EVIDENCE_HASH'), 'all modified artifacts have accurate manual pins');
    if (mode === 'missing') {
      assert.equal(report.valid, true, JSON.stringify(report.issues));
      assert.ok(report.unknowns.some(i => i.code === 'PHYSICAL_BINDING_UNAVAILABLE' && i.path === 'manifest-treatment/paramsHash'));
      assert.ok(!report.issues.some(i => i.code === 'PARAMETER_HASH'));
    } else {
      assert.equal(report.valid, false); assert.ok(report.issues.some(i => i.code === 'PARAMETER_HASH'));
    }
  });
});

for (const mode of ['missing', 'compatible', 'amount-conflict', 'dimension-conflict'])
  for (const reverse of [false, true]) test(`F5 each projection conversion ${mode}, reverse=${reverse} is order independent`, () => withManualFiles(dir => {
    const doc = observation(); const first = find(doc, 'flow'); const second = clone(first);
    second.recordId = 'flow-2'; second.seq = 1;
    (first.payload as JsonObject).counterpartRecordId = 'flow-2'; (second.payload as JsonObject).counterpartRecordId = 'flow-1';
    (first.provenanceRefs as string[]).push('flow-2'); (second.provenanceRefs as string[]).push('flow-1');
    if (mode === 'missing') (second.payload as JsonObject).conversionRef = 'unavailable:conversion';
    else {
      const matrix = json('conversion-matrix.v3.json'); matrix.evidenceId = 'member-matrix';
      const conversion = ((matrix.payload as JsonObject).entries as JsonObject[])[0];
      if (mode === 'amount-conflict') conversion.coefficient = 2;
      if (mode === 'dimension-conflict') conversion.outputUnit = 'normalized';
      const hash = save(dir, 'member-matrix.json', matrix);
      (doc.evidenceIndex as JsonObject[]).push({ evidenceId: 'member-matrix', relativePath: 'member-matrix.json', sha256: hash,
        kind: 'conversion-matrix', synthetic: true, schema: 'evidence.schema.json' });
      (second.payload as JsonObject).conversionRef = 'member-matrix';
    }
    records(doc).push(second); const stream = streams(doc).find(s => s.family === 'flow')!;
    stream.lastSeq = 1; stream.expectedRecords = 2; stream.observedRecords = 2;
    const refs = reverse ? ['flow-2', 'flow-1'] : ['flow-1', 'flow-2'];
    (find(doc, 'service').payload as JsonObject).consumptionRefs = refs;
    const effect = json('effect.json'); (effect.payload as JsonObject).consumptionRefs = refs;
    (effect.payload as JsonObject).consumedAmount = 1; repin(doc, 'effect', save(dir, 'effect.json', effect));
    const order = json('order.json'); const entry = ((order.payload as JsonObject).entries as JsonObject[]).find(e => (e.recordIds as string[]).includes('flow-1'))!;
    (entry.recordIds as string[]).push('flow-2'); repin(doc, 'order', save(dir, 'order.json', order));
    save(dir, 'manual.json', doc); const report = validateBundleFile(resolve(dir, 'manual.json'));
    assert.equal(report.valid, true, JSON.stringify(report.issues));
    assert.equal(report.serviceLinks[0].state, mode === 'compatible' ? 'BOUND' : 'UNKNOWN');
    if (mode !== 'compatible') assert.ok(report.serviceLinks[0].reasons.includes('DEBIT_AMOUNT_UNBOUND'));
  }));

for (const route of ['explicit', 'boundary-fallback']) for (const reverse of [false, true])
  test(`F5 indexed unavailable conversion ${route}, reverse=${reverse} cannot credit physical debit`, () => withManualFiles(dir => {
    const doc = observation(), first = find(doc, 'flow'), second = clone(first);
    second.recordId = 'flow-2'; second.seq = 1;
    (first.payload as JsonObject).counterpartRecordId = 'flow-2'; (second.payload as JsonObject).counterpartRecordId = 'flow-1';
    (first.provenanceRefs as string[]).push('flow-2'); (second.provenanceRefs as string[]).push('flow-1');
    const matrix = json('conversion-matrix.v3.json'); matrix.evidenceId = 'unavailable:conversion';
    const hash = save(dir, 'marked-matrix.json', matrix);
    (doc.evidenceIndex as JsonObject[]).push({ evidenceId: 'unavailable:conversion', relativePath: 'marked-matrix.json', sha256: hash,
      kind: 'conversion-matrix', synthetic: true, schema: 'evidence.schema.json' });
    if (route === 'explicit') (second.payload as JsonObject).conversionRef = 'unavailable:conversion';
    else {
      delete (second.payload as JsonObject).conversionRef;
      (second.fieldCoverage as JsonObject).conversionRef = { status: 'missing', reason: 'No per-flow matrix; use declared boundary fallback' };
      (find(doc, 'boundary').payload as JsonObject).conversionMatrixRef = 'unavailable:conversion';
    }
    records(doc).push(second); const stream = streams(doc).find(s => s.family === 'flow')!;
    stream.lastSeq = 1; stream.expectedRecords = 2; stream.observedRecords = 2;
    const refs = reverse ? ['flow-2', 'flow-1'] : ['flow-1', 'flow-2'];
    (find(doc, 'service').payload as JsonObject).consumptionRefs = refs;
    const effect = json('effect.json'); (effect.payload as JsonObject).consumptionRefs = refs;
    (effect.payload as JsonObject).consumedAmount = 1; repin(doc, 'effect', save(dir, 'effect.json', effect));
    const order = json('order.json'), entry = ((order.payload as JsonObject).entries as JsonObject[])
      .find(e => (e.recordIds as string[]).includes('flow-1'))!;
    (entry.recordIds as string[]).push('flow-2'); repin(doc, 'order', save(dir, 'order.json', order));
    save(dir, 'manual.json', doc); const report = validateBundleFile(resolve(dir, 'manual.json'));
    assert.equal(report.valid, true, JSON.stringify(report.issues));
    assert.ok(report.catalog.has('unavailable:conversion'), 'the correctly pinned matrix really is indexed');
    assert.ok(report.unknowns.some(i => i.code === 'REFERENCE_UNAVAILABLE'));
    assert.equal(report.serviceLinks[0].state, 'UNKNOWN');
    assert.ok(report.serviceLinks[0].reasons.includes('DEBIT_AMOUNT_UNBOUND'));
  }));

for (const kind of ['law', 'source-order'])
  test(`indexed unavailable ${kind} preserves unknown support instead of binding a service`, () => withManualFiles(dir => {
    const doc = observation(), marker = `unavailable:${kind}`;
    const name = kind === 'law' ? 'law.json' : 'order.json', evidence = json(name);
    const originalId = String(evidence.evidenceId); evidence.evidenceId = marker;
    const entry = (doc.evidenceIndex as JsonObject[]).find(e => e.evidenceId === originalId)!;
    entry.evidenceId = marker; entry.sha256 = save(dir, name, evidence);
    const effect = json('effect.json');
    if (kind === 'law') (effect.payload as JsonObject).lawRef = marker;
    else {
      for (const record of records(doc)) if ((record.causalContext as JsonObject).sourceOrderRef === originalId)
        (record.causalContext as JsonObject).sourceOrderRef = marker;
      (effect.payload as JsonObject).sourceOrderRef = marker;
    }
    repin(doc, 'effect', save(dir, 'effect.json', effect)); save(dir, 'manual.json', doc);
    const report = validateBundleFile(resolve(dir, 'manual.json'));
    assert.equal(report.valid, true, JSON.stringify(report.issues));
    assert.ok(report.catalog.has(marker), 'support exists as bytes but is explicitly unavailable');
    assert.ok(report.unknowns.some(i => i.code === 'REFERENCE_UNAVAILABLE'));
    assert.equal(report.serviceLinks[0].state, 'UNKNOWN');
    assert.ok(report.serviceLinks[0].reasons.includes('LAW_ORDER_SHA_UNRESOLVED'));
  }));

for (const explicit of [false, true])
  test(`condition record ID "undefined", explicit reference=${explicit} preserves raw reference identity`, () => withManualFiles(dir => {
    const doc = observation(), service = find(doc, 'service');
    const condition = records(doc).find(r => r.recordId === (service.payload as JsonObject).conditionSourceRef)!;
    const oldId = String(condition.recordId); condition.recordId = 'undefined';
    for (const record of records(doc)) {
      const causal = record.causalContext as JsonObject;
      causal.predecessorRecordIds = (causal.predecessorRecordIds as string[]).map(id => id === oldId ? 'undefined' : id);
    }
    const order = json('order.json');
    for (const entry of (order.payload as JsonObject).entries as JsonObject[])
      entry.recordIds = (entry.recordIds as string[]).map(id => id === oldId ? 'undefined' : id);
    repin(doc, 'order', save(dir, 'order.json', order));
    if (explicit) (service.payload as JsonObject).conditionSourceRef = 'undefined';
    else {
      delete (service.payload as JsonObject).conditionSourceRef;
      (service.fieldCoverage as JsonObject).conditionSourceRef = { status: 'missing', reason: 'No condition source reference was observed' };
      const stream = streams(doc).find(s => s.family === 'service')!;
      stream.coveredFields = (stream.coveredFields as string[]).filter(f => f !== 'conditionSourceRef');
      const cap = (doc.capabilities as JsonObject[]).find(c => c.family === 'service')!;
      cap.availableFields = (cap.availableFields as string[]).filter(f => f !== 'conditionSourceRef');
      (cap.missingFields as string[]).push('conditionSourceRef');
    }
    save(dir, 'manual.json', doc); const report = validateBundleFile(resolve(dir, 'manual.json'));
    assert.equal(report.valid, true, JSON.stringify(report.issues));
    assert.equal(report.serviceLinks[0].state, explicit ? 'BOUND' : 'UNKNOWN');
    if (!explicit) assert.deepEqual(report.serviceLinks[0].reasons, ['CONDITION_EVENT_UNBOUND']);
    assert.equal(condition.recordId, 'undefined', 'a literal explicit string ID is legitimate');
  }));

test('public service inspection cannot convert malformed raw references into matching literal record IDs or a boundary fallback', () => withManualFiles(dir => {
  const base = observation(); save(dir, 'manual.json', base);
  const report = validateBundleFile(resolve(dir, 'manual.json')); assert.equal(report.valid, true, JSON.stringify(report.issues));
  for (const raw of [null, 17, { value: 'condition-at-service-1' }]) {
    const doc = clone(base), service = find(doc, 'service');
    // Deliberate literal collision: shape must reject raw values; inspection must not stringify them.
    const condition = records(doc).find(r => r.recordId === (service.payload as JsonObject).conditionSourceRef)!;
    const oldId = String(condition.recordId);
    condition.recordId = String(raw);
    for (const record of records(doc)) {
      const causal = record.causalContext as JsonObject;
      causal.predecessorRecordIds = (causal.predecessorRecordIds as string[]).map(id => id === oldId ? String(raw) : id);
    }
    const order = json('order.json');
    for (const entry of (order.payload as JsonObject).entries as JsonObject[])
      entry.recordIds = (entry.recordIds as string[]).map(id => id === oldId ? String(raw) : id);
    const hash = save(dir, 'raw-order.json', order), catalog = new Map(report.catalog);
    catalog.set('order', { ...catalog.get('order')!, value: order, sha256: hash }); repin(doc, 'order', hash);
    (service.payload as JsonObject).conditionSourceRef = raw;
    assert.equal(validateShape('observation.schema.json', doc).valid, false);
    const result = inspectServiceLinks(doc, catalog)[0];
    assert.equal(result.state, 'UNKNOWN'); assert.ok(result.reasons.includes('CONDITION_EVENT_UNBOUND'));

    // Null is a legitimate fallback selector in the flow schema; other raw values cannot select it.
    if (raw === null) continue;
    const conversion = clone(base); (find(conversion, 'flow').payload as JsonObject).conversionRef = raw;
    assert.equal(validateShape('observation.schema.json', conversion).valid, false);
    const converted = inspectServiceLinks(conversion, report.catalog)[0];
    assert.equal(converted.state, 'UNKNOWN'); assert.ok(converted.reasons.includes('DEBIT_AMOUNT_UNBOUND'));
  }
}));
