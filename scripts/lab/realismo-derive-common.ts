/** Read-only, offline derivation support over an already validated realismo-v3 bundle. */
import { CONTRACT_VERSION, THRESHOLD_PROFILE_SHA256 } from './realismo-contract.js';
import type { BundleReport, CatalogItem, Family, JsonObject } from './realismo-contract.js';

export interface WindowScope {
  readonly startTick: number;
  readonly endTick: number;
  readonly ticksPerDay: number;
  readonly closure: string;
  readonly clock: string;
  readonly epochId: string;
}
export interface ObservationScope {
  readonly bundleEvidenceId: string;
  readonly runId: string;
  readonly epochId: string;
}
export interface StreamQuery extends ObservationScope {
  readonly streamId: string;
  readonly family: Family;
  readonly window: WindowScope;
  readonly fields: readonly string[];
  readonly order: 'ordered' | 'any';
  /** A subwindow with zero records needs its own opportunity/absence proof. */
  readonly zeroSupportRefs?: readonly string[];
  readonly requireRunComplete?: boolean;
}
export interface ObservationView {
  readonly scope: ObservationScope;
  readonly observation: Readonly<JsonObject>;
  readonly catalog: ReadonlyMap<string, CatalogItem>;
  readonly localEvidenceIds: ReadonlySet<string>;
  readonly records: readonly Readonly<JsonObject>[];
  readonly streams: readonly Readonly<JsonObject>[];
}
export interface CertifiedStream {
  readonly query: StreamQuery;
  readonly records: readonly Readonly<JsonObject>[];
  /** Null for a subwindow: whole-stream opportunity counts cannot be reused. */
  readonly eligibleOpportunities: number | null;
  readonly censoredSubjects: readonly string[];
  readonly refs: readonly string[];
}
export type Support<T> =
  | { readonly state: 'READY'; readonly value: T; readonly refs: readonly string[] }
  | { readonly state: 'UNKNOWN'; readonly reason: string; readonly refs: readonly string[] }
  | { readonly state: 'REJECT'; readonly reason: string; readonly refs: readonly string[] };
export interface DerivationContext {
  readonly root: Readonly<JsonObject>;
  readonly catalog: ReadonlyMap<string, CatalogItem>;
}
export type DerivedMetric =
  | { readonly state: 'MEASURED'; readonly id: string; readonly value: number; readonly unit: string;
      readonly refs: readonly string[]; readonly window: WindowScope | null; readonly reason: string;
      readonly numerator?: number; readonly denominator?: number; readonly exposureTicks?: number;
      readonly censoredCount?: number }
  | { readonly state: 'UNKNOWN' | 'REJECT'; readonly id: string; readonly value: null;
      readonly refs: readonly string[]; readonly window: WindowScope | null; readonly reason: string };
export interface DerivationBatch {
  readonly criterion: string;
  readonly metrics: readonly DerivedMetric[];
}

const object = (x: unknown): x is JsonObject => x !== null && typeof x === 'object' && !Array.isArray(x);
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(v => typeof v === 'string');
const safeCount = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const refList = (refs: readonly string[]): string[] => [...new Set(refs.filter(x => typeof x === 'string' && x.length > 0))];
export const ready = <T>(value: T, refs: readonly string[]): Support<T> => ({ state: 'READY', value, refs: refList(refs) });
export const unavailable = <T>(reason: string, refs: readonly string[] = []): Support<T> =>
  ({ state: 'UNKNOWN', reason, refs: refList(refs) });
export const contradiction = <T>(reason: string, refs: readonly string[] = []): Support<T> =>
  ({ state: 'REJECT', reason, refs: refList(refs) });
export function supportFailure<T>(result: Support<unknown>): Support<T> {
  if (result.state === 'UNKNOWN') return unavailable(result.reason, result.refs);
  if (result.state === 'REJECT') return contradiction(result.reason, result.refs);
  throw new TypeError('READY_IS_NOT_A_FAILURE');
}

export function measuredMetric(id: string, value: number, unit: string, refs: readonly string[],
  window: WindowScope | null, reason: string, counts: {
    numerator?: number; denominator?: number; exposureTicks?: number; censoredCount?: number
  } = {}): DerivedMetric {
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)) ||
      !unit || !refList(refs).length ||
      Object.entries(counts).some(([key, n]) => n !== undefined && (!Number.isFinite(n) ||
        (Number.isInteger(n) && !Number.isSafeInteger(n)) || (key !== 'numerator' && n < 0))))
    return { state: 'REJECT', id, value: null, refs: refList(refs), window, reason: 'INVALID_DERIVED_NUMBER_OR_SUPPORT' };
  return { state: 'MEASURED', id, value, unit, refs: refList(refs), window, reason, ...counts };
}
export const unknownMetric = (id: string, reason: string, refs: readonly string[] = [], window: WindowScope | null = null): DerivedMetric =>
  ({ state: 'UNKNOWN', id, value: null, refs: refList(refs), window, reason });
export const rejectedMetric = (id: string, reason: string, refs: readonly string[] = [], window: WindowScope | null = null): DerivedMetric =>
  ({ state: 'REJECT', id, value: null, refs: refList(refs), window, reason });

/** The only constructor: no request-supplied values, flags or metric overrides enter here. */
export function createDerivationContext(report: BundleReport): Support<DerivationContext> {
  if (!report.valid || !report.value || report.issues.length)
    return contradiction('INVALID_CANONICAL_BUNDLE', report.issues.map(x => x.path));
  if (report.value.contractVersion !== CONTRACT_VERSION ||
      report.value.thresholdProfileHash !== THRESHOLD_PROFILE_SHA256)
    return contradiction('UNSUPPORTED_CONTRACT_OR_PROFILE');
  if (report.value.kind !== 'observation' || !report.catalog.has(String(report.value.evidenceId)))
    return contradiction('ROOT_OBSERVATION_UNBOUND');
  return ready({ root: report.value, catalog: report.catalog }, [String(report.value.evidenceId)]);
}

/** Catalog entries in an arm shadow root IDs only inside that arm's namespace. */
export function observationView(ctx: DerivationContext, scope: ObservationScope): Support<ObservationView> {
  const item = ctx.catalog.get(scope.bundleEvidenceId);
  if (!item) return unavailable('OBSERVATION_NOT_INDEXED', [scope.bundleEvidenceId]);
  const observation = item.value;
  if (observation.kind !== 'observation') return contradiction('BUNDLE_REF_KIND_CONTRADICTION', [scope.bundleEvidenceId]);
  if (observation.evidenceId !== scope.bundleEvidenceId || observation.runId !== scope.runId ||
      observation.epochId !== scope.epochId)
    return contradiction('OBSERVATION_SCOPE_IDENTITY_CONTRADICTION', [scope.bundleEvidenceId]);
  if (!Array.isArray(observation.records) || !Array.isArray(observation.streams))
    return contradiction('OBSERVATION_LEDGER_SHAPE', [scope.bundleEvidenceId]);
  const scoped = new Map<string, CatalogItem>(ctx.catalog);
  for (const [id, entry] of item.namespace ?? new Map<string, CatalogItem>()) scoped.set(id, entry);
  return ready({ scope, observation, catalog: scoped,
    localEvidenceIds: new Set(item.namespace ? item.namespace.keys() :
      scope.bundleEvidenceId === ctx.root.evidenceId ? ctx.catalog.keys() : []),
    records: observation.records.filter(object), streams: observation.streams.filter(object) },
  [scope.bundleEvidenceId]);
}

export function evidenceIn(view: ObservationView, ref: string, kind?: string): Support<Readonly<JsonObject>> {
  if (!ref || ref.startsWith('unavailable:')) return unavailable('EVIDENCE_REF_UNAVAILABLE', [ref]);
  const item = view.catalog.get(ref);
  if (!item) return unavailable('EVIDENCE_NOT_INDEXED', [ref]);
  if (kind && item.value.kind !== kind) return contradiction('EVIDENCE_KIND_CONTRADICTION', [ref]);
  return ready(item.value, [ref]);
}

/** Per-arm evidence must be indexed by that observation, not merely by the parent bundle. */
export function evidenceInRun(view: ObservationView, ref: string, kind: string): Support<Readonly<JsonObject>> {
  if (!view.localEvidenceIds.has(ref)) return unavailable('EVIDENCE_NOT_IN_ARM_NAMESPACE', [view.scope.bundleEvidenceId, ref]);
  return evidenceIn(view, ref, kind);
}

/** A qualified ref cannot silently resolve in another run's namespace. */
export function recordIn(view: ObservationView, ref: string, requireQualified = false): Support<Readonly<JsonObject>> {
  if (!ref || ref.startsWith('unavailable:')) return unavailable('RECORD_REF_UNAVAILABLE', [ref]);
  const marker = ref.indexOf('#');
  if (requireQualified && marker < 0) return unavailable('RECORD_SCOPE_UNQUALIFIED', [ref]);
  if (marker >= 0 && (ref.slice(0, marker) !== view.scope.bundleEvidenceId || ref.indexOf('#', marker + 1) >= 0))
    return contradiction('RECORD_SCOPE_CONTRADICTION', [ref]);
  const id = marker < 0 ? ref : ref.slice(marker + 1);
  const rows = view.records.filter(r => r.recordId === id);
  if (!rows.length) return unavailable('RECORD_NOT_OBSERVED', [ref]);
  if (rows.length !== 1) return contradiction('DUPLICATE_RECORD_ID', [ref]);
  return ready(rows[0], [marker < 0 ? `${view.scope.bundleEvidenceId}#${id}` : ref]);
}

export function observedEvidenceFields(doc: Readonly<JsonObject>, fields: readonly string[], ref: string): Support<Readonly<JsonObject>> {
  if (!object(doc.payload) || !object(doc.fieldCoverage)) return contradiction('EVIDENCE_COVERAGE_SHAPE', [ref]);
  for (const field of fields) {
    const coverage = doc.fieldCoverage[field];
    if (!object(coverage)) return unavailable('EVIDENCE_FIELD_UNDECLARED:' + field, [ref]);
    if (coverage.status !== 'observed') {
      if (Object.hasOwn(doc.payload, field)) return contradiction('FIELD_PRESENT_BUT_UNOBSERVED:' + field, [ref]);
      return unavailable('EVIDENCE_FIELD_MISSING:' + field, [ref]);
    }
    if (!Object.hasOwn(doc.payload, field)) return contradiction('FIELD_COVERAGE_CONTRADICTION:' + field, [ref]);
  }
  return ready(doc, [ref]);
}

const numberTuple = (r: Readonly<JsonObject>): number[] => {
  const c = object(r.causalContext) ? r.causalContext : {};
  return [Number(r.tick), Number(c.phaseOrdinal), Number(c.eventOrdinal)];
};
const earlier = (a: number[], b: number[]): boolean =>
  a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));

/** Certifies only observed source order; sequence number never substitutes for source order. */
export function certifyRecordOrder(view: ObservationView, record: Readonly<JsonObject>): Support<true> {
  const c = record.causalContext;
  const recordRef = `${view.scope.bundleEvidenceId}#${String(record.recordId)}`;
  if (!object(c) || c.status !== 'ordered' || typeof c.sourceOrderRef !== 'string')
    return unavailable('SOURCE_ORDER_UNAVAILABLE', [recordRef]);
  const source = evidenceInRun(view, c.sourceOrderRef, 'source-order');
  if (source.state !== 'READY') return supportFailure<true>(source);
  const p = source.value.payload;
  if (!object(p) || !Array.isArray(p.phaseOrder) || !Array.isArray(p.entries))
    return contradiction('SOURCE_ORDER_SHAPE', [recordRef, c.sourceOrderRef]);
  if (p.sourceSHA !== view.observation.sourceSHA || p.phaseOrder[Number(c.phaseOrdinal)] !== c.phaseId)
    return contradiction('SOURCE_ORDER_SHA_OR_PHASE_CONTRADICTION', [recordRef, c.sourceOrderRef]);
  const orderKeys = p.entries.map(e => object(e) ? JSON.stringify([e.tick,e.phaseOrdinal,e.eventOrdinal]) : 'invalid');
  if (orderKeys.includes('invalid') || new Set(orderKeys).size !== orderKeys.length)
    return contradiction('SOURCE_ORDER_TUPLE_NOT_UNIQUE', [recordRef,c.sourceOrderRef]);
  const allSourceKeys:string[]=[];
  for (const id of view.localEvidenceIds) {
    const item=view.catalog.get(id);
    if (item?.value.kind!=='source-order' || !object(item.value.payload) ||
        item.value.payload.sourceSHA!==view.observation.sourceSHA) continue;
    const entries=item.value.payload.entries;
    if (!Array.isArray(entries)) return contradiction('SOURCE_ORDER_SHAPE',[recordRef,id]);
    for (const entry of entries) {
      if (!object(entry)) return contradiction('SOURCE_ORDER_SHAPE',[recordRef,id]);
      allSourceKeys.push(JSON.stringify([entry.tick,entry.phaseOrdinal,entry.eventOrdinal]));
    }
  }
  if (new Set(allSourceKeys).size!==allSourceKeys.length)
    return contradiction('SOURCE_ORDER_TUPLE_NOT_UNIQUE',[recordRef,c.sourceOrderRef]);
  if (record.epochId !== view.scope.epochId || !object(view.observation.plannedWindow) ||
      view.observation.plannedWindow.epochId !== view.scope.epochId ||
      !(typeof record.tick === 'number' && record.tick > Number(view.observation.plannedWindow.startTick) &&
        record.tick <= Number(view.observation.plannedWindow.endTick)))
    return contradiction('SOURCE_ORDER_CLOCK_OR_EPOCH_CONTRADICTION', [recordRef]);
  const matching = p.entries.filter(e => object(e) && e.sourceEventId === c.sourceEventId && e.tick === record.tick &&
    e.phaseId === c.phaseId && e.phaseOrdinal === c.phaseOrdinal && e.eventOrdinal === c.eventOrdinal &&
    Array.isArray(e.recordIds) && e.recordIds.includes(record.recordId));
  if (matching.length !== 1) return matching.length ? contradiction('DUPLICATE_SOURCE_ORDER_ENTRY', [recordRef, c.sourceOrderRef])
    : unavailable('SOURCE_ORDER_RECORD_UNMAPPED', [recordRef, c.sourceOrderRef]);
  if (!strings(c.predecessorRecordIds)) return contradiction('PREDECESSOR_SHAPE', [recordRef]);
  const byId = new Map(view.records.map(r => [String(r.recordId), r]));
  const seen = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): Support<true> => {
    if (visiting.has(id)) return contradiction('CAUSAL_CYCLE', [recordRef]);
    if (seen.has(id)) return ready(true, [recordRef]);
    const current = byId.get(id);
    if (!current) return unavailable('PREDECESSOR_RECORD_UNAVAILABLE', [recordRef, id]);
    const cc = current.causalContext;
    if (!object(cc) || cc.status !== 'ordered' || typeof cc.sourceOrderRef !== 'string' ||
        !strings(cc.predecessorRecordIds)) return unavailable('PREDECESSOR_ORDER_UNAVAILABLE', [recordRef, id]);
    const order = evidenceInRun(view, cc.sourceOrderRef, 'source-order');
    if (order.state !== 'READY') return supportFailure<true>(order);
    const op = order.value.payload;
    const priorKeys = object(op) && Array.isArray(op.entries) ? op.entries.map(e => object(e) ?
      JSON.stringify([e.tick,e.phaseOrdinal,e.eventOrdinal]) : 'invalid') : [];
    if (!object(op) || !Array.isArray(op.entries) || !Array.isArray(op.phaseOrder))
      return unavailable('PREDECESSOR_SOURCE_ORDER_UNBOUND', [recordRef,id,cc.sourceOrderRef]);
    if (op.sourceSHA !== view.observation.sourceSHA ||
        op.phaseOrder[Number(cc.phaseOrdinal)] !== cc.phaseId ||
        priorKeys.includes('invalid') || new Set(priorKeys).size !== priorKeys.length ||
        current.epochId !== view.scope.epochId ||
        !object(view.observation.plannedWindow) ||
        !(typeof current.tick==='number' && current.tick > Number(view.observation.plannedWindow.startTick) &&
          current.tick <= Number(view.observation.plannedWindow.endTick)))
      return contradiction('PREDECESSOR_SOURCE_ORDER_CONTRADICTION', [recordRef,id,cc.sourceOrderRef]);
    const tupleEntries=op.entries.filter(e=>object(e) && e.tick===current.tick &&
      e.phaseOrdinal===cc.phaseOrdinal && e.eventOrdinal===cc.eventOrdinal);
    if (tupleEntries.length && !tupleEntries.some(e=>object(e) && e.sourceEventId===cc.sourceEventId &&
        e.phaseId===cc.phaseId && Array.isArray(e.recordIds) && e.recordIds.includes(current.recordId)))
      return contradiction('PREDECESSOR_SOURCE_ORDER_CONTRADICTION',[recordRef,id,cc.sourceOrderRef]);
    if (!op.entries.some(e => object(e) && e.sourceEventId === cc.sourceEventId && e.tick === current.tick &&
          e.phaseId === cc.phaseId && e.phaseOrdinal === cc.phaseOrdinal && e.eventOrdinal === cc.eventOrdinal &&
          Array.isArray(e.recordIds) && e.recordIds.includes(current.recordId)))
      return unavailable('PREDECESSOR_SOURCE_ORDER_UNBOUND', [recordRef,id,cc.sourceOrderRef]);
    visiting.add(id);
    for (const priorId of cc.predecessorRecordIds) {
      const prior = byId.get(priorId);
      if (!prior) return unavailable('PREDECESSOR_RECORD_UNAVAILABLE', [recordRef, priorId]);
      if (!earlier(numberTuple(prior), numberTuple(current))) return contradiction('PREDECESSOR_NOT_EARLIER', [recordRef, priorId]);
      const check = visit(priorId); if (check.state !== 'READY') return check;
    }
    visiting.delete(id); seen.add(id); return ready(true, [recordRef]);
  };
  const checked = visit(String(record.recordId));
  return checked.state === 'READY' ? ready(true, [recordRef, c.sourceOrderRef]) : checked;
}

/** Complete means exact bytes/records/fields/window, not a producer's boolean alone. */
export function certifyStream(ctx: DerivationContext, query: StreamQuery): Support<CertifiedStream> {
  const viewResult = observationView(ctx, query);
  if (viewResult.state !== 'READY') return supportFailure<CertifiedStream>(viewResult);
  const view = viewResult.value, obs = view.observation;
  if (query.requireRunComplete && obs.runStatus !== 'complete')
    return unavailable('RUN_INCOMPLETE', [query.bundleEvidenceId]);
  const candidates = view.streams.filter(s => s.streamId === query.streamId);
  if (!candidates.length) return unavailable('STREAM_NOT_OBSERVED', [query.bundleEvidenceId]);
  if (candidates.length !== 1) return contradiction('DUPLICATE_STREAM_ID', [query.bundleEvidenceId]);
  const stream = candidates[0];
  if (stream.family !== query.family || stream.epochId !== query.epochId || !object(stream.window))
    return contradiction('STREAM_SCOPE_CONTRADICTION', [query.bundleEvidenceId]);
  const sw = stream.window;
  if (query.window.epochId !== query.epochId || sw.epochId !== query.window.epochId || sw.clock !== query.window.clock ||
      sw.closure !== query.window.closure || sw.ticksPerDay !== query.window.ticksPerDay ||
      query.window.startTick < Number(sw.startTick) || query.window.endTick > Number(sw.endTick) ||
      query.window.startTick >= query.window.endTick)
    return contradiction('STREAM_WINDOW_CONTRADICTION', [query.bundleEvidenceId]);
  const caps = Array.isArray(obs.capabilities) ? obs.capabilities.filter(c => object(c) && c.family === query.family) : [];
  if (caps.length !== 1) return contradiction('CAPABILITY_CARDINALITY', [query.bundleEvidenceId]);
  const cap = caps[0] as JsonObject;
  if (cap.status !== 'available' || stream.quality === 'UNAVAILABLE' || stream.quality === 'PARTIAL')
    return unavailable('FAMILY_OR_STREAM_INCOMPLETE', [query.bundleEvidenceId]);
  if (stream.quality !== 'COMPLETE') return contradiction('INVALID_STREAM_QUALITY', [query.bundleEvidenceId]);
  if (!strings(stream.requiredFields) || !strings(stream.coveredFields) || !strings(cap.availableFields) ||
      !stream.requiredFields.length) return unavailable('REQUIRED_FIELDS_UNCOVERED', [query.bundleEvidenceId]);
  const requiredFields = stream.requiredFields, coveredFields = stream.coveredFields, availableFields = cap.availableFields;
  if (query.fields.some(f => !requiredFields.includes(f) || !coveredFields.includes(f) || !availableFields.includes(f)))
    return unavailable('REQUIRED_FIELDS_UNCOVERED', [query.bundleEvidenceId]);
  if (!Array.isArray(stream.gaps) || stream.gaps.length || !safeCount(stream.expectedRecords) ||
      !safeCount(stream.observedRecords)) return unavailable('STREAM_COUNT_OR_GAP_UNAVAILABLE', [query.bundleEvidenceId]);
  const all = view.records.filter(r => r.streamId === query.streamId);
  if (all.length !== stream.expectedRecords || all.length !== stream.observedRecords ||
      all.some(r => r.family !== query.family || r.epochId !== query.epochId))
    return contradiction('STREAM_RECORD_COUNT_CONTRADICTION', [query.bundleEvidenceId]);
  if (all.length === 0 ? stream.firstSeq !== null || stream.lastSeq !== null :
      stream.firstSeq !== all[0].seq || stream.lastSeq !== all.at(-1)?.seq ||
      all.some((r, i) => r.seq !== Number(stream.firstSeq) + i))
    return contradiction('STREAM_SEQUENCE_CONTRADICTION', [query.bundleEvidenceId]);
  // An opening stock is the (start,end] interval's initial cut, not a second transition.
  const inWindow = all.filter(r => (Number(r.tick) > query.window.startTick && Number(r.tick) <= query.window.endTick) ||
    (query.family === 'stock' && Number(r.tick) === query.window.startTick && object(r.payload) && r.payload.phase === 'opening'));
  const refs = refList([query.bundleEvidenceId, ...(strings(stream.evidenceRefs) ? stream.evidenceRefs : []),
    ...inWindow.map(r => `${query.bundleEvidenceId}#${String(r.recordId)}`), ...(query.zeroSupportRefs ?? [])]);
  for (const record of inWindow) {
    if (!object(record.payload) || !object(record.fieldCoverage)) return contradiction('RECORD_COVERAGE_SHAPE', refs);
    for (const field of query.fields) {
      const coverage = record.fieldCoverage[field];
      if (!object(coverage)) return unavailable('RECORD_FIELD_UNDECLARED:' + field, refs);
      if (coverage.status !== 'observed') {
        if (Object.hasOwn(record.payload, field)) return contradiction('FIELD_PRESENT_BUT_UNOBSERVED:' + field, refs);
        return unavailable('RECORD_FIELD_MISSING:' + field, refs);
      }
      if (!Object.hasOwn(record.payload, field)) return contradiction('FIELD_COVERAGE_CONTRADICTION:' + field, refs);
    }
    if (query.order === 'ordered') {
      const ordered = certifyRecordOrder(view, record);
      if (ordered.state !== 'READY') return ordered;
    }
  }
  const exactWindow = sw.startTick === query.window.startTick && sw.endTick === query.window.endTick;
  if (!safeCount(stream.eligibleOpportunities)) return unavailable('OPPORTUNITY_CENSUS_UNAVAILABLE', refs);
  if (!strings(stream.censoredSubjects)) return contradiction('CENSORED_SUBJECTS_SHAPE', refs);
  const censoredSubjects=stream.censoredSubjects;
  if (!inWindow.length) {
    if (exactWindow && stream.eligibleOpportunities === 0)
      return unavailable('ZERO_WITHOUT_ELIGIBLE_OPPORTUNITY', refs);
    if (censoredSubjects.length) return unavailable('ZERO_CENSORED_SUBJECTS_UNRESOLVED', refs);
    {
      if (!query.zeroSupportRefs?.length) return unavailable('ZERO_LOCAL_PROOF_UNAVAILABLE', refs);
      let foundOpportunity = false;
      for (const ref of query.zeroSupportRefs) {
        const proof = evidenceInRun(view, ref, 'opportunity');
        if (proof.state !== 'READY') return supportFailure<CertifiedStream>(proof);
        if (!strings(stream.evidenceRefs) || !stream.evidenceRefs.includes(ref))
          return unavailable('ZERO_OPPORTUNITY_NOT_LINKED_TO_FAMILY', [query.bundleEvidenceId,ref]);
        const covered = observedEvidenceFields(proof.value, ['cohortRef','startTick','endTick','eligibleActorIds'], ref);
        if (covered.state !== 'READY') return supportFailure<CertifiedStream>(covered);
        const payload = proof.value.payload;
        if (!object(payload) || payload.startTick !== query.window.startTick || payload.endTick !== query.window.endTick ||
            !strings(payload.eligibleActorIds) || !payload.eligibleActorIds.length || typeof payload.cohortRef !== 'string')
          return contradiction('ZERO_OPPORTUNITY_WINDOW_CONTRADICTION', [ref]);
        const cohort = evidenceInRun(view, payload.cohortRef, 'cohort');
        if (cohort.state !== 'READY') return supportFailure<CertifiedStream>(cohort);
        const cohortCoverage = observedEvidenceFields(cohort.value,
          ['actorIds','censored','selectionRegisteredRef','atTick'], payload.cohortRef);
        if (cohortCoverage.state !== 'READY') return supportFailure<CertifiedStream>(cohortCoverage);
        const cp = cohort.value.payload;
        if (!object(cp) || !strings(cp.actorIds) || !Array.isArray(cp.censored))
          return contradiction('ZERO_COHORT_CONTRADICTION', [ref,payload.cohortRef]);
        const cohortActors=cp.actorIds, eligibleActors=payload.eligibleActorIds;
        if (eligibleActors.some(id => !cohortActors.includes(id)))
          return contradiction('ZERO_COHORT_CONTRADICTION', [ref,payload.cohortRef]);
        if (typeof cp.selectionRegisteredRef!=='string' || !safeCount(cp.atTick) ||
            cp.atTick > query.window.startTick)
          return unavailable('ZERO_COHORT_SELECTION_UNVERIFIED', [ref,payload.cohortRef]);
        const selection=evidenceInRun(view,cp.selectionRegisteredRef,'preregistration');
        if (selection.state!=='READY') return supportFailure<CertifiedStream>(selection);
        const selected=observedEvidenceFields(selection.value,['registeredAt','firstDataAt'],cp.selectionRegisteredRef);
        if (selected.state!=='READY') return supportFailure<CertifiedStream>(selected);
        const censored=new Map<string,number>();
        for (const item of cp.censored) {
          if (!object(item) || typeof item.actorId!=='string' || !safeCount(item.lastObservedTick) ||
              typeof item.reason!=='string' || !item.reason)
            return contradiction('ZERO_CENSOR_SHAPE_CONTRADICTION', [ref,payload.cohortRef]);
          if (!cohortActors.includes(item.actorId) || censored.has(item.actorId))
            return contradiction('ZERO_CENSOR_COHORT_CONTRADICTION',[ref,payload.cohortRef]);
          censored.set(item.actorId,item.lastObservedTick);
        }
        if (eligibleActors.some(id => (censored.get(id)??Infinity) < query.window.endTick ||
            censoredSubjects.includes(id) && !censored.has(id)))
          return unavailable('ZERO_COHORT_CENSORED', [ref,payload.cohortRef]);
        foundOpportunity = true;
      }
      if (!foundOpportunity) return unavailable('ZERO_LOCAL_PROOF_UNAVAILABLE', refs);
      // The frozen opportunity schema describes eligibility, but has no observed
      // family-specific absence/loss field. A COMPLETE declaration cannot fill it.
      return unavailable('ZERO_ABSENCE_PROOF_UNAVAILABLE', [...refs,...query.zeroSupportRefs]);
    }
  }
  return ready({ query, records: inWindow, eligibleOpportunities: exactWindow ? stream.eligibleOpportunities : null,
    censoredSubjects, refs }, refs);
}
