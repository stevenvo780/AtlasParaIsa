/** Integrated byte fixtures; AUTHOR ONLY closure does not execute this file. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStrictJSON, validateBundleFile } from '../scripts/lab/realismo-contract.js';
import type { BundleReport, JsonObject } from '../scripts/lab/realismo-contract.js';
import { canonicalProofJson, proofHash } from '../scripts/lab/realismo-causal-proof.js';
import type { ExactRef, IndexedProof, ProofRequest } from '../scripts/lab/realismo-causal-proof.js';
import { createCausalAdapter } from '../scripts/lab/realismo-causal-adapter.js';
import type { CausalPolicy } from '../scripts/lab/realismo-causal-adapter.js';

const fixtures = fileURLToPath(new URL('./fixtures/realismo/causal-adapter/', import.meta.url));
const json = <T>(path: string): T => parseStrictJSON(readFileSync(path, 'utf8')) as T;
const policyBytes = json<{ timeAuthorities: Array<[string, CausalPolicy['timeAuthorities'] extends ReadonlyMap<string, infer T> ? T : never]>;
  sourceAuthorities: Array<[string, CausalPolicy['sourceAuthorities'] extends ReadonlyMap<string, infer T> ? T : never]> }>(join(fixtures, 'policy.fixture.json'));
const policy = (): CausalPolicy => ({ timeAuthorities: new Map(policyBytes.timeAuthorities), sourceAuthorities: new Map(policyBytes.sourceAuthorities) });

function fixture(name = 'positive', directory = join(fixtures, name)) {
  // No CatalogItem is constructed here. The REAL G3 validator owns the entire catalog.
  const report = validateBundleFile(join(directory, 'root.json'), directory);
  assert.equal(report.valid, true, JSON.stringify(report.issues));
  assert.deepEqual(report.issues, []);
  const index = json<Record<string, { relativePath: string; sha256: string }>>(join(directory, 'proof-index.json'));
  const proofs = new Map<string, IndexedProof>(Object.entries(index).map(([id, entry]) => [id,
    { canonicalJson: readFileSync(join(directory, entry.relativePath), 'utf8'), sha256: entry.sha256 }]));
  const request = json<ProofRequest>(join(directory, 'request.json'));
  const requests = new Map([['pair', request]]);
  return { report, proofs, request, requests, directory };
}
function created(f: ReturnType<typeof fixture>, p = policy()) {
  const result = createCausalAdapter(f.report, f.proofs, f.requests, p);
  assert.equal(result.state, 'CREATED', JSON.stringify(result));
  assert.ok(result.state === 'CREATED');
  return result.adapter;
}
function result(f: ReturnType<typeof fixture>, p = policy()) {
  const r = created(f, p).validations.get('pair'); assert.ok(r); return r;
}
function mutate(f: ReturnType<typeof fixture>, id: string, change: (payload: JsonObject) => void): ExactRef {
  const entry = f.proofs.get(id); assert.ok(entry);
  const doc = JSON.parse(entry.canonicalJson) as JsonObject;
  const payload = doc.payload; assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
  change(payload);
  doc.fieldCoverage = Object.fromEntries(Object.keys(payload).map(k => [k, { status: 'observed', reason: 'TEST_FIXTURE mutation' }]));
  const canonicalJson = canonicalProofJson(doc), sha256 = proofHash(canonicalJson);
  f.proofs.set(id, { canonicalJson, sha256 }); return { id, sha256 };
}
function oracle(f: ReturnType<typeof fixture>, state: string, barrier: string, reason: string) {
  const r = result(f);
  assert.equal(r.state, state); assert.equal(r.barrier, barrier); assert.equal(r.reason, reason);
  assert.equal(r.basis, 'TEST_FIXTURE'); assert.equal(r.scientificAcceptance, false);
  assert.equal(r.proofResult.state, state); return r;
}
function localReportMutation(f: ReturnType<typeof fixture>, edit: (report: BundleReport) => void, reason: string) {
  edit(f.report);
  const r = createCausalAdapter(f.report, f.proofs, f.requests, policy());
  assert.equal(r.state, 'REJECTED'); assert.ok(r.state !== 'CREATED'); assert.equal(r.reason, reason);
}

test('on-disk G3 VALID fixture reaches positive G1 READY; frozen G3 evidence namespace UNKNOWN survives', () => {
  const f = fixture(), a = created(f), r = a.validations.get('pair')!;
  assert.equal(r.proofResult.state, 'READY'); assert.equal(r.proofResult.barrier, 'COMPLETE');
  assert.equal(r.proofResult.reason, 'STRUCTURAL_BINDINGS_ONLY');
  assert.equal(r.proofResult.basis, 'TEST_FIXTURE');
  assert.equal(r.state, 'UNKNOWN'); assert.equal(r.reason, 'G3_BUNDLE_UNKNOWNS_PRESERVED');
  assert.equal(r.scientificAcceptance, false);
  assert.ok(r.bundleUnknowns.some(i => i.code === 'REFERENCE_UNAVAILABLE' && i.message === 'treatment#intervention-inputs'));
  assert.ok(r.refs.includes('treatment#service-reference'));
  assert.ok(r.refs.includes('control#service-reference'));
  assert.ok(a.docHashes.get('treatment')?.children?.get('order'));
  assert.ok(a.docHashes.get('control')?.children?.get('order'));
  assert.equal(a.docHashes.has('order'), false);
  assert.notEqual(a.docHashes.get('treatment')?.children?.get('order')?.sha256,
    a.docHashes.get('control')?.children?.get('order')?.sha256);
});
test('missing one application reaches the exact terminal G1 application barrier', () => {
  const f = fixture(); f.request.applications.pop();
  oracle(f, 'UNKNOWN', 'FINAL_TYPED_G1_APPLICATION', 'TYPED_G1_APPLICATION_UNOBSERVED');
});
test('missing arm × phase × function coverage remains UNKNOWN', () => {
  const f = fixture(); f.request.coverage.pop();
  oracle(f, 'UNKNOWN', 'WINDOW_COVERAGE', 'ARM_PHASE_FUNCTION_COVERAGES_REQUIRED');
});
test('foreign function claiming supply coverage is positively rejected', () => {
  oracle(fixture('foreign-function'), 'REJECTED', 'WINDOW_COVERAGE', 'COVERAGE_FOREIGN_FUNCTION_CONTRADICTION');
});
test('a function not observed in indexed service rows stays UNKNOWN', () => {
  oracle(fixture('function-unobserved'), 'UNKNOWN', 'WINDOW_COVERAGE', 'SERVICE_FUNCTION_UNOBSERVED');
});
test('a complete empty window does not create an absence observation', () => {
  oracle(fixture('zero-removal'), 'UNKNOWN', 'TYPED_ABSENCE', 'TYPED_LOCAL_ABSENCE_UNOBSERVED');
});
test('typed absence with indexed cuts and law preserves the physical interval barrier', () => {
  const f = fixture('zero-removal'); f.request.absences.push(json<ExactRef>(join(f.directory, 'absence-ref.json')));
  oracle(f, 'UNKNOWN', 'TYPED_ABSENCE', 'PHYSICAL_ABSENCE_INTERVAL_LAW_UNAVAILABLE');
});
test('malformed proof byte hash is rejected before G1', () => {
  const f = fixture(); f.proofs.get('protocol')!.sha256 = 'malformed';
  const r = createCausalAdapter(f.report, f.proofs, f.requests, policy());
  assert.ok(r.state !== 'CREATED'); assert.equal(r.state, 'REJECTED'); assert.equal(r.reason, 'PROOF_HASH_CONTRADICTION:protocol');
});
test('a valid hash over noncanonical proof JSON is rejected', () => {
  const f = fixture(), entry = f.proofs.get('protocol')!;
  entry.canonicalJson += '\n'; entry.sha256 = proofHash(entry.canonicalJson);
  const r = createCausalAdapter(f.report, f.proofs, f.requests, policy());
  assert.ok(r.state !== 'CREATED'); assert.equal(r.reason, 'PROOF_NOT_CANONICAL:protocol');
});
test('duplicate JSON keys cannot masquerade as canonical proof bytes', () => {
  const f = fixture(), entry = f.proofs.get('protocol')!;
  entry.canonicalJson = entry.canonicalJson.replace('"id":"protocol"', '"id":"protocol","id":"protocol"');
  entry.sha256 = proofHash(entry.canonicalJson);
  const r = createCausalAdapter(f.report, f.proofs, f.requests, policy());
  assert.ok(r.state !== 'CREATED'); assert.equal(r.state, 'REJECTED'); assert.equal(r.reason, 'PROOF_JSON_INVALID:protocol');
});
test('proof index identity cannot be renamed under another namespace', () => {
  const f = fixture(); f.proofs.set('treatment#protocol', f.proofs.get('protocol')!);
  const r = createCausalAdapter(f.report, f.proofs, f.requests, policy());
  assert.ok(r.state !== 'CREATED'); assert.equal(r.reason, 'PROOF_INDEX_IDENTITY_CONTRADICTION:treatment#protocol');
});
test('child namespace cannot be omitted', () => {
  localReportMutation(fixture(), r => { delete r.catalog.get('treatment')!.namespace; }, 'CATALOG_NAMESPACE_CONTRADICTION:treatment');
});
test('child namespaces cannot be swapped across arms', () => {
  localReportMutation(fixture(), r => { r.catalog.get('treatment')!.namespace = r.catalog.get('control')!.namespace; }, 'CATALOG_NAMESPACE_CONTRADICTION:treatment#');
});
test('catalog parent, hashes, path and value cannot be reasserted by a caller', () => {
  for (const field of ['sha256', 'path', 'value'] as const) {
    localReportMutation(fixture(), r => {
      const item = r.catalog.get('treatment')!.namespace!.get('order')!;
      if (field === 'value') item.value.sourceRefs = ['forged'];
      else item[field] = 'forged';
    }, 'CATALOG_PROVENANCE_CONTRADICTION:treatment#order');
  }
});
test('manually suppressing G3 unknowns fails report provenance', () => {
  localReportMutation(fixture(), r => { r.unknowns = []; }, 'BUNDLE_REPORT_PROVENANCE_CONTRADICTION');
});
test('source mapping duplicates and parent conflicts are rejected as forged catalog bytes', () => {
  localReportMutation(fixture(), r => {
    const order = r.catalog.get('treatment')!.namespace!.get('order')!.value.payload as JsonObject;
    assert.ok(Array.isArray(order.entries)); order.entries.push(order.entries[0]!);
  }, 'CATALOG_PROVENANCE_CONTRADICTION:treatment#order');
  localReportMutation(fixture(), r => {
    const rows = r.catalog.get('treatment')!.value.records as JsonObject[];
    const row = rows.find(x => x.recordId === 'after-removal')!;
    (row.causalContext as JsonObject).predecessorRecordIds = ['after-restoration'];
  }, 'CATALOG_PROVENANCE_CONTRADICTION:treatment');
});
test('G3 reports with issues are rejected even if the caller asserts valid', () => {
  const f = fixture(); f.report.issues.push({ code: 'TEST_FIXTURE', path: '', message: 'integrity contradiction' });
  const r = createCausalAdapter(f.report, f.proofs, f.requests, policy());
  assert.ok(r.state !== 'CREATED'); assert.equal(r.reason, 'BUNDLE_REPORT_NOT_VALID');
  assert.equal(r.basis, 'TEST_FIXTURE');
});
test('test fixture basis survives proofs and external policy claiming OBSERVED', () => {
  const f = fixture();
  // This changes only an unused indexed proof; arm bytes and consulted signed proofs remain TEST_FIXTURE.
  const entry = f.proofs.get('source-restoration')!, doc = JSON.parse(entry.canonicalJson) as JsonObject;
  doc.basis = 'OBSERVED'; entry.canonicalJson = canonicalProofJson(doc); entry.sha256 = proofHash(entry.canonicalJson);
  f.request.applications = [];
  const p = policy(); p.timeAuthorities = new Map([...p.timeAuthorities].map(([id, a]) => [id, { ...a, basis: 'OBSERVED' }]));
  const r = result(f, p); assert.equal(r.state, 'UNKNOWN'); assert.equal(r.basis, 'TEST_FIXTURE');
  assert.equal(r.reason, 'TYPED_G1_APPLICATION_UNOBSERVED'); assert.equal(r.scientificAcceptance, false);
});
test('G3 rejects duplicate index entries and byte corruption on disk', () => {
  // Future CPU QA must supply an owned /datos TMPDIR; never use the global /tmp.
  const tmp = process.env.TMPDIR; assert.ok(tmp && resolve(tmp).startsWith('/datos/'));
  const owned = mkdtempSync(join(tmp, 'causal-adapter-')); chmodSync(owned, 0o700);
  try {
    cpSync(join(fixtures, 'positive'), owned, { recursive: true });
    const rootPath = join(owned, 'root.json'), root = json<JsonObject>(rootPath);
    assert.ok(Array.isArray(root.evidenceIndex)); root.evidenceIndex.push(root.evidenceIndex[0]!);
    writeFileSync(rootPath, canonicalProofJson(root));
    const duplicated = validateBundleFile(rootPath, owned);
    assert.equal(duplicated.valid, false); assert.ok(duplicated.issues.some(i => i.code === 'DUPLICATE_EVIDENCE_ID'));
    cpSync(join(fixtures, 'positive', 'root.json'), rootPath);
    writeFileSync(join(owned, 'treatment', 'order.json'), '{}');
    const corrupted = validateBundleFile(rootPath, owned);
    assert.equal(corrupted.valid, false); assert.ok(corrupted.issues.some(i => i.code === 'EVIDENCE_HASH'));
    const f = fixture();
    assert.equal(createCausalAdapter(corrupted, f.proofs, f.requests, policy()).state, 'REJECTED');
  } finally { rmSync(owned, { recursive: true, force: true }); }
});
test('missing external clock policy remains UNKNOWN; fixture bundles cannot supply authority', () => {
  const f = fixture(), p = policy(); p.timeAuthorities = new Map();
  const r = result(f, p); assert.equal(r.state, 'UNKNOWN'); assert.equal(r.reason, 'TIME_AUTHORITY_NOT_CONFIGURED');
});
test('missing external source policy remains UNKNOWN', () => {
  const f = fixture(), p = policy(); p.sourceAuthorities = new Map();
  const r = result(f, p); assert.equal(r.state, 'UNKNOWN'); assert.equal(r.reason, 'SOURCE_APPLICATION_AUTHORITY_UNAVAILABLE');
});
test('source signature conflict is rejected with its exact G1 reason', () => {
  const f = fixture();
  const source = mutate(f, 'source-removal', p => { p.signature = '0'.repeat(128); });
  f.request.applications[0] = mutate(f, 'application-removal', p => { p.sourceObservation = source; });
  oracle(f, 'REJECTED', 'FINAL_TYPED_G1_APPLICATION', 'SOURCE_APPLICATION_SIGNATURE_INVALID');
});
test('time signature conflict is rejected; retrospective dates are not independent evidence', () => {
  const f = fixture();
  const receipt = mutate(f, 'registered-time', p => { p.at = '2026-09-30T00:00:00.000Z'; });
  f.request.registration = mutate(f, 'registration', p => { p.receipt = receipt; });
  oracle(f, 'REJECTED', 'PREREGISTRATION_TIME', 'TIME_SIGNATURE_INVALID');
});
test('application input namespace conflict is rejected without global fallback', () => {
  const f = fixture();
  f.request.applications[0] = mutate(f, 'application-removal', p => { p.inputRefs = ['control#intervention-inputs']; });
  oracle(f, 'REJECTED', 'FINAL_TYPED_G1_APPLICATION', 'APPLICATION_INTERVENTION_CONTRADICTION');
});
test('caller mutations cannot change the saved context, requests, results or child hashes', () => {
  const f = fixture(), a = created(f);
  f.proofs.clear(); f.requests.clear(); f.request.coverage.length = 0;
  f.report.catalog.get('treatment')!.namespace!.clear();
  assert.ok(a.context.proofs.get('protocol')); assert.equal(a.requests.get('pair')!.coverage.length, 6);
  assert.ok(a.context.g1.get('treatment')!.namespace!.get('order'));
  assert.equal((a.context.g1 as unknown as { set?: unknown }).set, undefined);
  assert.equal((a.docHashes as unknown as { clear?: unknown }).clear, undefined);
  a.context.g1.forEach((_value, id, owner) => { assert.equal(owner, a.context.g1); assert.ok(owner.has(id)); });
  assert.throws(() => { a.validations.get('pair')!.basis = 'OBSERVED'; }, TypeError);
  assert.throws(() => { a.requests.get('pair')!.applications.pop(); }, TypeError);
});
