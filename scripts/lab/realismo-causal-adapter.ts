/** Standalone P2 binding adapter. It neither produces observations nor evaluates criteria. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseStrictJSON, sha256, validateBundleFile } from './realismo-contract.js';
import type { BundleReport, Catalog, CatalogItem, ContractIssue } from './realismo-contract.js';
import { CAUSAL_PROOF_VERSION, canonicalProofJson, proofHash, validateCausalProof } from './realismo-causal-proof.js';
import type { Basis, IndexedProof, ProofContext, ProofRequest, ProofResult } from './realismo-causal-proof.js';

export const CAUSAL_ADAPTER_VERSION = 'realismo-causal-adapter-v1' as const;
export type CausalPolicy = Pick<ProofContext, 'timeAuthorities' | 'sourceAuthorities'>;
/** Child hashes stay in their namespace, including repeated local IDs. */
export type DocumentPin = { sha256: string; path: string; children?: ReadonlyMap<string, DocumentPin> };
export type AdapterValidation = ProofResult & {
  proofResult: ProofResult;
  bundleUnknowns: readonly ContractIssue[];
};
export interface CausalAdapter {
  readonly version: typeof CAUSAL_ADAPTER_VERSION;
  readonly context: ProofContext;
  readonly requests: ReadonlyMap<string, ProofRequest>;
  readonly docHashes: ReadonlyMap<string, DocumentPin>;
  readonly validations: ReadonlyMap<string, AdapterValidation>;
  readonly basis: Basis;
  readonly scientificAcceptance: false;
}
export type AdapterCreation = {
  state: 'CREATED'; adapter: CausalAdapter; basis: Basis; scientificAcceptance: false;
} | {
  state: 'UNKNOWN' | 'REJECTED'; barrier: 'BUNDLE_BINDINGS' | 'INDEX_BINDINGS';
  reason: string; basis: Basis; scientificAcceptance: false; issues: readonly ContractIssue[];
};

class BindingError extends Error {}
function fail(reason: string): never { throw new BindingError(reason); }
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const localId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !v.includes('#') && !v.startsWith('unavailable:');
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function clone<T>(value: T): T { return frozen(JSON.parse(canonicalProofJson(value)) as T); }
/** No mutable Map escapes; Object.freeze(Map) alone would still permit set/delete. */
function readonlyMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const map = new Map(entries);
  const view: ReadonlyMap<K, V> = Object.freeze({
    get size() { return map.size; }, get: (key: K) => map.get(key), has: (key: K) => map.has(key),
    entries: () => map.entries(), keys: () => map.keys(), values: () => map.values(),
    [Symbol.iterator]: () => map[Symbol.iterator](),
    forEach: (callback: (value: V, key: K, owner: ReadonlyMap<K, V>) => void, thisArg?: unknown) =>
      map.forEach((value, key) => callback.call(thisArg, value, key, view)),
  });
  return view;
}

/** Revalidate the on-disk root: a manually asserted valid catalog is not authority. */
export function createCausalAdapter(
  report: BundleReport,
  proofs: ReadonlyMap<string, IndexedProof>,
  requests: ReadonlyMap<string, ProofRequest>,
  policy: CausalPolicy,
): AdapterCreation {
  let basis: Basis = report?.value?.synthetic === true ? 'TEST_FIXTURE' : 'OBSERVED';
  let barrier: 'BUNDLE_BINDINGS' | 'INDEX_BINDINGS' = 'BUNDLE_BINDINGS';
  const stopped = (state: 'UNKNOWN' | 'REJECTED', reason: string, issues: readonly ContractIssue[] = []): AdapterCreation =>
    ({ state, reason, barrier, basis, issues: clone(issues), scientificAcceptance: false });
  try {
    if (!report || report.valid !== true || !report.value || !Array.isArray(report.issues) || report.issues.length)
      return stopped('REJECTED', 'BUNDLE_REPORT_NOT_VALID', report?.issues ?? []);
    const rootId = report.value.evidenceId;
    if (!localId(rootId)) fail('BUNDLE_ROOT_IDENTITY_CONTRADICTION');
    const root = report.catalog.get(rootId);
    if (!root || root.value.kind !== 'observation' || canonicalProofJson(root.value) !== canonicalProofJson(report.value))
      fail('BUNDLE_ROOT_IDENTITY_CONTRADICTION');
    const checked = validateBundleFile(root.path, dirname(resolve(root.path)));
    if (!checked.valid || !checked.value || checked.issues.length)
      return stopped('REJECTED', 'BUNDLE_REVALIDATION_FAILED', checked.issues);
    const active = new Set<Catalog>();
    function compare(actual: Catalog, expected: Catalog, parent: string): void {
      if (active.has(actual)) fail('CATALOG_NAMESPACE_CYCLE:' + parent);
      active.add(actual);
      if (actual.size !== expected.size) fail('CATALOG_NAMESPACE_CONTRADICTION:' + parent);
      for (const [id, item] of actual) {
        if (!localId(id) || item.value.evidenceId !== id) fail('CATALOG_IDENTITY_CONTRADICTION:' + parent + id);
        const other = expected.get(id);
        if (!other || !hash(item.sha256) || item.sha256 !== other.sha256 || resolve(item.path) !== resolve(other.path) ||
            canonicalProofJson(item.value) !== canonicalProofJson(other.value) || canonicalProofJson(item.entry) !== canonicalProofJson(other.entry))
          fail('CATALOG_PROVENANCE_CONTRADICTION:' + parent + id);
        const bytes = readFileSync(other.path);
        if (sha256(bytes) !== item.sha256 || canonicalProofJson(parseStrictJSON(bytes.toString('utf8'))) !== canonicalProofJson(item.value))
          fail('CATALOG_BYTES_CONTRADICTION:' + parent + id);
        if (!!item.namespace !== !!other.namespace) fail('CATALOG_NAMESPACE_CONTRADICTION:' + parent + id);
        if (item.namespace && other.namespace) compare(item.namespace, other.namespace, parent + id + '#');
      }
      active.delete(actual);
    }
    compare(report.catalog, checked.catalog, '');
    if (canonicalProofJson(report.unknowns) !== canonicalProofJson(checked.unknowns) ||
        canonicalProofJson(report.serviceLinks) !== canonicalProofJson(checked.serviceLinks)) fail('BUNDLE_REPORT_PROVENANCE_CONTRADICTION');
    function snapshot(catalog: Catalog): ReadonlyMap<string, CatalogItem> {
      return readonlyMap([...catalog].map(([id, item]) => {
        if (item.value.synthetic === true) basis = 'TEST_FIXTURE';
        const copy: CatalogItem = { value: clone(item.value), entry: clone(item.entry), sha256: item.sha256, path: item.path };
        // G1 declares Catalog as Map but uses only get/iteration; the runtime view is immutable.
        if (item.namespace) copy.namespace = snapshot(item.namespace) as Catalog;
        return [id, Object.freeze(copy)] as const;
      }));
    }
    const g1 = snapshot(checked.catalog);
    function pins(catalog: ReadonlyMap<string, CatalogItem>): ReadonlyMap<string, DocumentPin> {
      return readonlyMap([...catalog].map(([id, item]) => [id, Object.freeze({ sha256: item.sha256, path: item.path,
        ...(item.namespace ? { children: pins(item.namespace) } : {}) })] as const));
    }
    barrier = 'INDEX_BINDINGS';
    const proofEntries: Array<readonly [string, IndexedProof]> = [];
    const proofIds = new Set<string>();
    for (const [id, indexed] of proofs) {
      if (!localId(id) || proofIds.has(id)) fail('PROOF_INDEX_IDENTITY_CONTRADICTION:' + id);
      proofIds.add(id);
      if (!hash(indexed.sha256) || proofHash(indexed.canonicalJson) !== indexed.sha256) fail('PROOF_HASH_CONTRADICTION:' + id);
      let doc: ReturnType<typeof parseStrictJSON>;
      try { doc = parseStrictJSON(indexed.canonicalJson); }
      catch { fail('PROOF_JSON_INVALID:' + id); }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.id !== id || doc.version !== CAUSAL_PROOF_VERSION ||
          !['OBSERVED', 'TEST_FIXTURE'].includes(String(doc.basis))) fail('PROOF_INDEX_IDENTITY_CONTRADICTION:' + id);
      if (canonicalProofJson(doc) !== indexed.canonicalJson) fail('PROOF_NOT_CANONICAL:' + id);
      if (doc.basis === 'TEST_FIXTURE') basis = 'TEST_FIXTURE';
      proofEntries.push([id, clone(indexed)]);
    }
    function authorities<T extends { publicKeyPem: string; basis: Basis }>(entries: ReadonlyMap<string, T>): ReadonlyMap<string, T> {
      const ids = new Set<string>();
      return readonlyMap([...entries].map(([id, authority]) => {
        if (!localId(id) || ids.has(id) || !authority || typeof authority.publicKeyPem !== 'string' ||
            !['OBSERVED', 'TEST_FIXTURE'].includes(authority.basis)) fail('EXTERNAL_POLICY_SHAPE');
        ids.add(id);
        if (authority.basis === 'TEST_FIXTURE') basis = 'TEST_FIXTURE';
        return [id, clone(authority)] as const;
      }));
    }
    const context: ProofContext = Object.freeze({ g1, proofs: readonlyMap(proofEntries),
      timeAuthorities: authorities(policy.timeAuthorities), sourceAuthorities: authorities(policy.sourceAuthorities) });
    const requestEntries: Array<readonly [string, ProofRequest]> = [];
    const requestIds = new Set<string>();
    for (const [id, request] of requests) {
      if (!localId(id) || requestIds.has(id)) fail('REQUEST_INDEX_IDENTITY_CONTRADICTION:' + id);
      requestIds.add(id); requestEntries.push([id, clone(request)]);
    }
    const savedRequests = readonlyMap(requestEntries);
    const bundleUnknowns = clone(checked.unknowns);
    const validations = readonlyMap([...savedRequests].map(([id, request]) => {
      const raw = validateCausalProof(context, request);
      const proofResult = clone({ ...raw, basis: basis === 'TEST_FIXTURE' ? basis : raw.basis });
      let result: ProofResult = proofResult;
      // Preserve G1 reasons first. G3 UNKNOWN cannot be promoted by G1's structural certificate.
      if (raw.state === 'READY' && bundleUnknowns.length)
        result = { ...proofResult, state: 'UNKNOWN', barrier: 'INDEX_BINDINGS', reason: 'G3_BUNDLE_UNKNOWNS_PRESERVED' };
      else if (raw.state === 'READY' && raw.basis !== 'TEST_FIXTURE')
        result = { ...proofResult, state: 'UNKNOWN', barrier: 'PREREGISTRATION_TIME', reason: 'OBSERVED_CONTEMPORANEOUS_FIRST_DATA_UNAVAILABLE' };
      return [id, clone({ ...result, proofResult, bundleUnknowns })] as const;
    }));
    const adapter: CausalAdapter = Object.freeze({ version: CAUSAL_ADAPTER_VERSION, context, requests: savedRequests,
      docHashes: pins(g1), validations, basis, scientificAcceptance: false });
    return { state: 'CREATED', adapter, basis, scientificAcceptance: false };
  } catch (error) {
    return stopped('REJECTED', error instanceof BindingError ? error.message : 'MALFORMED_ADAPTER_INPUT');
  }
}
