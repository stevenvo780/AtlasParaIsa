/** C11/C17 contemporary causal contrast. No request measurements enter this module. */
import { inspectServiceLinks } from './realismo-contract.js';
import type { Family, JsonObject } from './realismo-contract.js';
import {
  certifyStream, contradiction, evidenceInRun, observationView, observedEvidenceFields,
  recordIn, ready, rejectedMetric, supportFailure, unavailable, unknownMetric,
} from './realismo-derive-common.js';
import type {
  DerivationBatch, DerivationContext, ObservationView, Support, WindowScope,
} from './realismo-derive-common.js';

type Criterion = 'C11' | 'C17';
type Phase = 'reference' | 'removal' | 'restoration';
type Arm = 'treatment' | 'control';
type Cell = { rate: number; services: number; opportunities: number; exposureTicks: number;
  actors: readonly string[]; eligibilityRule: string; censoredCount: number; refs: string[] };
const phases: readonly Phase[] = ['reference', 'removal', 'restoration'];
const isObject = (x: unknown): x is JsonObject => x !== null && typeof x === 'object' && !Array.isArray(x);
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(v => typeof v === 'string');
const safeNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const safeTick = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x>=0;
const uniq = (refs: readonly string[]): string[] => [...new Set(refs)];
const field = (p: Readonly<JsonObject>, key: string): string => typeof p[key] === 'string' ? p[key] as string : '';
const windowOf = (base: Readonly<JsonObject>, phase: Readonly<JsonObject>): WindowScope => ({
  startTick: Number(phase.startTick), endTick: Number(phase.endTick),
  ticksPerDay: Number(base.ticksPerDay), closure: String(base.closure), clock: String(base.clock), epochId: String(base.epochId),
});
const reasonOf = (x: Support<unknown>): string => x.state === 'READY' ? '' : x.reason;
const refsOf = (x: Support<unknown>): readonly string[] => x.refs;
const stateOf = (x: Support<unknown>): 'UNKNOWN' | 'REJECT' => x.state === 'REJECT' ? 'REJECT' : 'UNKNOWN';
const finitePositive = (x: unknown): x is number => safeNumber(x) && x > 0;

/** Arithmetic only; this function makes no claim that its input rates are certified. */
export function observedCausalRatios(removalTreatment:number, removalControl:number,
  restorationTreatment:number, restorationControl:number): { removalDrop:number; restoration:number } {
  if (![removalTreatment,removalControl,restorationTreatment,restorationControl].every(Number.isFinite) ||
      removalControl<=0 || restorationControl<=0) throw new RangeError('CAUSAL_RATE_DENOMINATOR');
  return {removalDrop:(removalControl-removalTreatment)/removalControl,
    restoration:restorationTreatment/restorationControl};
}

function allPhaseMetrics(criterion: Criterion, state: 'UNKNOWN' | 'REJECT', reason: string,
  refs: readonly string[]): DerivationBatch {
  const make = state === 'REJECT' ? rejectedMetric : unknownMetric;
  return { criterion, metrics: [
    make(`${criterion}.contemporaryPairs`, reason, refs),
    make(`${criterion}.removalDrop`, reason, refs),
    make(`${criterion}.restoration`, reason, refs),
  ] };
}
function stop(criterion: Criterion, result: Support<unknown>): DerivationBatch {
  return allPhaseMetrics(criterion, stateOf(result), reasonOf(result), refsOf(result));
}
function listed(p: Readonly<JsonObject>, key: string, ref: string): Support<readonly string[]> {
  const value = p[key];
  if (!strings(value)) return contradiction('PAIR_REF_LIST_SHAPE:' + key, [ref]);
  if (new Set(value).size !== value.length) return contradiction('PAIR_REF_LIST_DUPLICATE:' + key, [ref]);
  return ready(value, [ref, ...value]);
}
function manifestView(ctx: DerivationContext, ref: string, runId: string, role: string): Support<ObservationView> {
  const item = ctx.catalog.get(ref);
  if (!item) return unavailable('PAIR_MANIFEST_NOT_INDEXED', [ref]);
  if (item.value.kind !== 'run-manifest') return contradiction('PAIR_MANIFEST_KIND', [ref]);
  const coverage = observedEvidenceFields(item.value,
    ['runId','epochId','artifactRole','sourceSHA','seed','paramsRef','initialStateRef','inputTraceRef',
      'governorTraceRef','observationRef','plannedStartTick','plannedEndTick','runStatus','interventionRefs'], ref);
  if (coverage.state !== 'READY') return supportFailure<ObservationView>(coverage);
  const p = item.value.payload as JsonObject;
  if (p.runId !== runId || p.artifactRole !== role) return contradiction('PAIR_MANIFEST_ROLE_OR_RUN', [ref]);
  if (p.runStatus !== 'complete') return unavailable('PAIR_MANIFEST_RUN_INCOMPLETE', [ref]);
  if (typeof p.observationRef !== 'string') return contradiction('PAIR_MANIFEST_OBSERVATION_REF', [ref]);
  const view = observationView(ctx, { bundleEvidenceId:p.observationRef, runId, epochId:String(p.epochId) });
  if (view.state !== 'READY') return view;
  const o = view.value.observation;
  if (o.runStatus !== 'complete') return unavailable('PAIR_ARM_RUN_INCOMPLETE', [ref, p.observationRef]);
  if (o.artifactRole !== role || o.sourceSHA !== p.sourceSHA || o.seed !== p.seed ||
      o.paramsRef !== p.paramsRef || o.inputTraceRef !== p.inputTraceRef || o.governorTraceRef !== p.governorTraceRef ||
      !isObject(o.plannedWindow) || o.plannedWindow.startTick !== p.plannedStartTick ||
      o.plannedWindow.endTick !== p.plannedEndTick ||
      !strings(o.interventionRefs) || !strings(p.interventionRefs) ||
      JSON.stringify([...o.interventionRefs].sort()) !== JSON.stringify([...p.interventionRefs].sort()))
    return contradiction('PAIR_MANIFEST_OBSERVATION_MISMATCH', [ref, p.observationRef]);
  return ready(view.value, [ref, p.observationRef]);
}
function certifyFamily(ctx: DerivationContext, view: ObservationView, family: Family, fields: readonly string[],
  window: WindowScope, zeroSupportRefs: readonly string[]): Support<{ rows: readonly Readonly<JsonObject>[];
    refs: string[]; opportunities: number | null; censoredSubjects:readonly string[] }> {
  const streams = view.streams.filter(s => s.family === family && isObject(s.window) &&
    typeof s.window.startTick === 'number' && typeof s.window.endTick === 'number' &&
    s.window.startTick <= window.startTick && s.window.endTick >= window.endTick);
  if (!streams.length) return unavailable('PHASE_STREAM_NOT_OBSERVED:' + family, [view.scope.bundleEvidenceId]);
  const rows: Readonly<JsonObject>[] = [], refs: string[] = [], censoredSubjects:string[]=[];
  let opportunities = 0, exact = true;
  for (const stream of streams) {
    const result = certifyStream(ctx, { ...view.scope, streamId:String(stream.streamId), family, window,
      fields, order: family === 'service' || family === 'flow' ? 'ordered' : 'any',
      zeroSupportRefs, requireRunComplete:true });
    if (result.state !== 'READY') return supportFailure(result);
    rows.push(...result.value.records); refs.push(...result.refs);
    censoredSubjects.push(...result.value.censoredSubjects);
    if (result.value.eligibleOpportunities === null) exact = false;
    else opportunities += result.value.eligibleOpportunities;
  }
  const seen = new Set(rows.map(r => String(r.recordId)));
  if (seen.size !== rows.length || view.records.some(r => r.family === family &&
      ((Number(r.tick) > window.startTick && Number(r.tick) <= window.endTick) ||
        (family === 'stock' && Number(r.tick) === window.startTick && isObject(r.payload) && r.payload.phase === 'opening')) &&
      !seen.has(String(r.recordId))))
    return contradiction('PHASE_STREAM_PARTITION_CONTRADICTION:' + family, refs);
  return ready({ rows, refs:uniq(refs), opportunities:exact ? opportunities : null,
    censoredSubjects }, refs);
}
function supportRows(view: ObservationView, refs: readonly string[], family: Family,
  window: WindowScope): Support<readonly Readonly<JsonObject>[]> {
  const rows: Readonly<JsonObject>[] = [];
  for (const ref of refs) {
    const result = recordIn(view, ref, true);
    if (result.state !== 'READY') return supportFailure(result);
    const tick=Number(result.value.tick);
    const inWindow=tick>window.startTick && tick<=window.endTick;
    const opening=family==='stock' && tick===window.startTick && isObject(result.value.payload) &&
      result.value.payload.phase==='opening';
    if (result.value.family !== family || !(inWindow || opening))
      return contradiction('PAIR_SUPPORT_RECORD_SCOPE:' + family, [ref]);
    rows.push(result.value);
  }
  return ready(rows, refs);
}
type Censor = {lastObservedTick:number; reason:string};
type OpportunityCohort = { count:number; actors:readonly string[]; eligibilityRule:string;
  censored:ReadonlyMap<string,Censor>; refs:readonly string[] };
export function certifyCohortCensors(raw:unknown, actors:readonly string[], atTick:number,
  ref:string): Support<ReadonlyMap<string,Censor>> {
  if (!Array.isArray(raw)) return unavailable('PAIR_COHORT_CENSOR_UNOBSERVED',[ref]);
  const censored=new Map<string,Censor>();
  for (const item of raw) {
    if (!isObject(item) || typeof item.actorId!=='string' || !safeTick(item.lastObservedTick) ||
        typeof item.reason!=='string' || !item.reason)
      return contradiction('PAIR_COHORT_CENSOR_SHAPE',[ref]);
    if (!actors.includes(item.actorId) || censored.has(item.actorId) || item.lastObservedTick<atTick)
      return contradiction('PAIR_COHORT_CENSOR_CONTRADICTION',[ref]);
    censored.set(item.actorId,{lastObservedTick:item.lastObservedTick,reason:item.reason});
  }
  return ready(censored,[ref]);
}
export function reconcilePhaseCensors(ids:readonly string[], opportunity:OpportunityCohort,
  window:WindowScope, refs:readonly string[]):Support<true> {
  if (new Set(ids).size!==ids.length || ids.some(id=>!opportunity.actors.includes(id)))
    return contradiction('PAIR_STREAM_CENSOR_FOREIGN_OR_DUPLICATE',refs);
  for (const id of ids) {
    const censor=opportunity.censored.get(id);
    if (!censor) return unavailable('PAIR_STREAM_CENSOR_NOT_IN_COHORT',refs);
    if (censor.lastObservedTick>window.endTick || !censor.reason)
      return contradiction('PAIR_STREAM_CENSOR_TICK_OR_REASON_CONTRADICTION',refs);
  }
  if (opportunity.actors.some(id=>{
    const censor=opportunity.censored.get(id);
    return censor && censor.lastObservedTick<window.endTick && !ids.includes(id);
  })) return unavailable('PAIR_COHORT_CENSOR_NOT_IN_STREAM',refs);
  // Stream census has IDs only. It cannot independently reconcile tick or reason.
  if (ids.length) return unavailable('PAIR_STREAM_CENSOR_TICK_REASON_UNVERIFIABLE',refs);
  return ready(true,refs);
}
export function certifyExposureSubject(row:Readonly<JsonObject>, actors:readonly string[],
  window:WindowScope, ref:string):Support<{subject:string;start:number;end:number;activeTicks:number}> {
  const p=row.payload;
  if (!isObject(p) || !safeTick(p.activeTicks) || p.activeTicks===0 || p.mode!=='active' ||
      !safeTick(p.startTick) || !safeTick(p.endTick) || p.endTick-p.startTick!==p.activeTicks ||
      p.startTick<window.startTick || p.endTick>window.endTick ||
      !safeTick(row.tick) || row.tick!==p.endTick || typeof p.subjectId!=='string')
    return unavailable('PAIR_EXPOSURE_INCOMPLETE',[ref]);
  if (!actors.includes(p.subjectId)) return contradiction('PAIR_EXPOSURE_SUBJECT_OUTSIDE_COHORT',[ref]);
  return ready({subject:p.subjectId,start:p.startTick,end:p.endTick,activeTicks:p.activeTicks},[ref]);
}
export function certifyBoundaryCensus(view:ObservationView, stockIds:readonly string[],
  window:WindowScope):Support<{boundaryId:string;ref:string}> {
  const refs=[view.scope.bundleEvidenceId];
  const streams=view.streams.filter(s=>s.family==='boundary');
  if (streams.length!==1) return unavailable('PAIR_BOUNDARY_STREAM_UNAVAILABLE',refs);
  const stream=streams[0];
  const rows=view.records.filter(r=>r.family==='boundary' && r.streamId===stream.streamId);
  if (stream.quality!=='COMPLETE' || !Array.isArray(stream.gaps) || stream.gaps.length ||
      stream.expectedRecords!==rows.length || stream.observedRecords!==rows.length)
    return unavailable('PAIR_BOUNDARY_CENSUS_INCOMPLETE',refs);
  const candidates=rows.filter(r=>r.epochId===window.epochId && safeTick(r.tick) &&
    r.tick<=window.startTick && isObject(r.payload) && typeof r.payload.boundaryId==='string');
  if (candidates.length!==1) return unavailable('PAIR_BOUNDARY_NOT_UNIQUE_OR_OBSERVED',refs);
  const boundary=candidates[0], ref=`${view.scope.bundleEvidenceId}#${String(boundary.recordId)}`;
  if (!isObject(boundary.fieldCoverage) || !isObject(boundary.payload))
    return unavailable('PAIR_BOUNDARY_FIELDS_UNOBSERVED',[ref]);
  const fields=['boundaryId','stockIds','materials','unitMapVersion','scope','includesProtected'];
  for (const key of fields) {
    const coverage=boundary.fieldCoverage[key];
    if (!isObject(coverage) || coverage.status!=='observed')
      return unavailable('PAIR_BOUNDARY_FIELDS_UNOBSERVED',[ref]);
  }
  const p=boundary.payload;
  const observedStockIds=p.stockIds;
  if (typeof p.boundaryId!=='string' || !p.boundaryId || !strings(observedStockIds) ||
      new Set(observedStockIds).size!==observedStockIds.length ||
      !strings(p.materials) || typeof p.unitMapVersion!=='string' ||
      p.scope!=='global' || typeof p.includesProtected!=='boolean')
    return unavailable('PAIR_BOUNDARY_CENSUS_NOT_GLOBAL',[ref]);
  if (new Set(stockIds).size!==stockIds.length || stockIds.length!==observedStockIds.length ||
      stockIds.some(id=>!observedStockIds.includes(id)))
    return contradiction('PAIR_BOUNDARY_STOCK_CENSUS_CONTRADICTION',[ref]);
  return ready({boundaryId:p.boundaryId,ref},[ref]);
}
export function certifyInterventionApplication(view:ObservationView, doc:Readonly<JsonObject>,
  phase:'removal'|'restoration', tick:number, ref:string):Support<true> {
  const observed=observedEvidenceFields(doc,['runId','tick','kind','declaredBeforeData','inputRefs'],ref);
  if (observed.state!=='READY') return supportFailure(observed);
  const p=doc.payload as JsonObject;
  if (p.runId!==view.scope.runId || p.tick!==tick || p.declaredBeforeData!==true || !strings(p.inputRefs))
    return contradiction('PAIR_INTERVENTION_IDENTITY_CONTRADICTION',[ref]);
  if (p.kind==='removal' || p.kind==='restoration') {
    if (p.kind!==phase) return contradiction('PAIR_INTERVENTION_KIND_CONTRADICTION',[ref]);
  } else return unavailable('PAIR_INTERVENTION_KIND_UNBOUND',[ref]);
  if (!p.inputRefs.length) return unavailable('PAIR_INTERVENTION_INPUTS_UNOBSERVED',[ref]);
  for (const inputRef of p.inputRefs) {
    const input=recordIn(view,inputRef,true);
    if (input.state!=='READY') return supportFailure(input);
    if (!safeNumber(input.value.tick) || input.value.tick>tick)
      return contradiction('PAIR_INTERVENTION_INPUT_TIME_CONTRADICTION',[ref,inputRef]);
  }
  return unavailable('PAIR_INTERVENTION_APPLICATION_UNVERIFIABLE',[ref,...p.inputRefs]);
}
function opportunityCount(view: ObservationView, refs: readonly string[], window: WindowScope,
  preregRef:string): Support<OpportunityCohort> {
  if (!refs.length) return unavailable('PAIR_OPPORTUNITIES_NOT_LISTED', [view.scope.bundleEvidenceId]);
  if (refs.length !== 1) return unavailable('PAIR_OPPORTUNITY_CARDINALITY_UNPROVEN', refs);
  const actors = new Set<string>();
  const censored=new Map<string,Censor>();
  let eligibilityRule = '';
  for (const ref of refs) {
    const doc = evidenceInRun(view, ref, 'opportunity');
    if (doc.state !== 'READY') return supportFailure(doc);
    const checked = observedEvidenceFields(doc.value, ['cohortRef','startTick','endTick','eligibleActorIds'], ref);
    if (checked.state !== 'READY') return supportFailure(checked);
    const p = doc.value.payload as JsonObject;
    if (p.startTick !== window.startTick || p.endTick !== window.endTick || !strings(p.eligibleActorIds))
      return contradiction('PAIR_OPPORTUNITY_WINDOW_OR_ACTORS', [ref]);
    const cohort = evidenceInRun(view, String(p.cohortRef), 'cohort');
    if (cohort.state !== 'READY') return supportFailure(cohort);
    const covered = observedEvidenceFields(cohort.value,
      ['actorIds','selectionRegisteredRef','atTick','eligibilityRule','censored'], String(p.cohortRef));
    if (covered.state !== 'READY') return supportFailure(covered);
    const cp = cohort.value.payload as JsonObject;
    if (!strings(cp.actorIds) || !strings(p.eligibleActorIds))
      return contradiction('PAIR_OPPORTUNITY_COHORT_MISMATCH', [ref, String(p.cohortRef)]);
    const cohortActors=cp.actorIds, eligibleActors=p.eligibleActorIds;
    if (
        cp.selectionRegisteredRef !== preregRef || !safeNumber(cp.atTick) || cp.atTick > window.startTick ||
        typeof cp.eligibilityRule !== 'string' || !cp.eligibilityRule || !Array.isArray(cp.censored) ||
        eligibleActors.some(a => !cohortActors.includes(a)))
      return contradiction('PAIR_OPPORTUNITY_COHORT_MISMATCH', [ref, String(p.cohortRef)]);
    const selection=evidenceInRun(view,preregRef,'preregistration');
    if (selection.state!=='READY') return supportFailure(selection);
    const checkedCensors=certifyCohortCensors(cp.censored,cohortActors,cp.atTick,String(p.cohortRef));
    if (checkedCensors.state!=='READY') return supportFailure(checkedCensors);
    for (const [id,censor] of checkedCensors.value) censored.set(id,censor);
    if (eligibleActors.some(id=>(censored.get(id)?.lastObservedTick??Infinity)<window.endTick))
      return unavailable('PAIR_COHORT_CENSOR_OVERLAPS_PHASE', [ref,String(p.cohortRef)]);
    eligibilityRule=cp.eligibilityRule;
    for (const actor of eligibleActors) {
      if (actors.has(actor)) return contradiction('PAIR_OPPORTUNITY_DUPLICATE', [ref]);
      actors.add(actor);
    }
  }
  return actors.size ? ready({count:actors.size,actors:[...actors].sort(),eligibilityRule,censored,refs}, refs) :
    unavailable('PAIR_ZERO_OPPORTUNITY_DENOMINATOR', refs);
}
function phaseCell(ctx: DerivationContext, view: ObservationView, phase: Readonly<JsonObject>, arm: Arm,
  window: WindowScope, functionIds: readonly string[], normalization: string, preregRef:string): Support<Cell> {
  const pairRef = view.scope.bundleEvidenceId;
  const key = arm === 'treatment' ? 'treatmentServiceRefs' : 'controlServiceRefs';
  const opportunityKey = arm === 'treatment' ? 'treatmentOpportunityRefs' : 'controlOpportunityRefs';
  const serviceList = listed(phase, key, pairRef), opportunityList = listed(phase, opportunityKey, pairRef);
  if (serviceList.state !== 'READY') return supportFailure(serviceList);
  if (opportunityList.state !== 'READY') return supportFailure(opportunityList);
  const opportunities = opportunityCount(view, opportunityList.value, window, preregRef);
  if (opportunities.state !== 'READY') return supportFailure(opportunities);
  const opportunity=opportunities.value;
  const service = certifyFamily(ctx, view, 'service', ['functionId','appliedBenefit','causeRef','consumptionRefs','conditionAtService','conditionSourceRef'],
    window, opportunityList.value);
  if (service.state !== 'READY') return supportFailure(service);
  const serviceCensor=reconcilePhaseCensors(service.value.censoredSubjects,opportunity,window,service.refs);
  if (serviceCensor.state!=='READY') return supportFailure(serviceCensor);
  if (service.value.opportunities !== null && service.value.opportunities !== opportunity.count)
    return contradiction('PHASE_OPPORTUNITY_CENSUS_CONTRADICTION', [...service.refs, ...opportunities.refs]);
  const selected = new Set<string>();
  for (const ref of serviceList.value) {
    const result = recordIn(view, ref, true);
    if (result.state !== 'READY') return supportFailure(result);
    if (result.value.family !== 'service') return contradiction('PAIR_SERVICE_REF_KIND', [ref]);
    selected.add(String(result.value.recordId));
  }
  const eligible = service.value.rows.filter(r => isObject(r.payload) && functionIds.includes(String(r.payload.functionId)));
  if (eligible.length !== selected.size || eligible.some(r => !selected.has(String(r.recordId))))
    return contradiction('PAIR_SERVICE_LIST_DOES_NOT_MATCH_COMPLETE_STREAM', [...service.refs, ...serviceList.refs]);
  const links = inspectServiceLinks(view.observation as JsonObject, view.catalog as Map<string, import('./realismo-contract.js').CatalogItem>);
  for (const row of eligible) {
    if (!isObject(row.payload) || typeof row.payload.actorId !== 'string' ||
        !opportunity.actors.includes(row.payload.actorId))
      return unavailable('PAIR_SERVICE_ACTOR_OUTSIDE_ELIGIBLE_COHORT', [pairRef+'#'+String(row.recordId)]);
    const link = links.find(l => l.recordId === row.recordId);
    if (!link || link.state !== 'BOUND') return unavailable('PAIR_SERVICE_EFFECT_OR_DEBIT_UNBOUND', [pairRef + '#' + String(row.recordId)]);
    if (!isObject(row.payload) || !isObject(row.payload.appliedBenefit) ||
        !finitePositive(row.payload.appliedBenefit.value))
      return unavailable('PAIR_APPLIED_BENEFIT_UNAVAILABLE', [pairRef + '#' + String(row.recordId)]);
  }
  const shared: readonly [string, Family, readonly string[]][] = [
    ['openingStockRefs','stock',['boundaryId','stockId','material','quantity','phase','clockTick']],
    ['closingStockRefs','stock',['boundaryId','stockId','material','quantity','phase','clockTick']],
    ['flowRefs','flow',['boundaryId','transferId','fromStockId','toStockId','flowType','quantity','counterpartRecordId']],
    ['exposureRefs','exposure',['subjectId','startTick','endTick','activeTicks','mode']],
  ];
  const supportRefs: string[] = [];
  let exposureTicks = 0;
  const stockCuts = new Map<string, { opening?: number; closing?: number; material?: string; unit?: string;
    version?: string; boundaryId?: string }>();
  const stockCutRefs = new Set<string>();
  const flowRows: Readonly<JsonObject>[]=[];
  const exposureIntervals = new Map<string,Array<{start:number;end:number}>>();
  for (const [refKey, family, fields] of shared) {
    const refs = listed(phase, refKey, pairRef);
    if (refs.state !== 'READY') return supportFailure(refs);
    const armRefs = refs.value.filter(r => r.startsWith(pairRef + '#'));
    if (!armRefs.length) return unavailable('PAIR_ARM_SUPPORT_NOT_LISTED:' + refKey, [pairRef]);
    const rows = supportRows(view, armRefs, family, window);
    if (rows.state !== 'READY') return supportFailure(rows);
    const certified = certifyFamily(ctx, view, family, fields, window, armRefs);
    if (certified.state !== 'READY') return supportFailure(certified);
    const familyCensor=reconcilePhaseCensors(certified.value.censoredSubjects,opportunity,window,certified.refs);
    if (familyCensor.state!=='READY') return supportFailure(familyCensor);
    if (rows.value.some(r => !certified.value.rows.includes(r)))
      return contradiction('PAIR_SUPPORT_OUTSIDE_COMPLETE_STREAM:' + refKey, armRefs);
    if (family === 'flow' || family === 'exposure') {
      const listedIds=new Set(rows.value.map(r=>String(r.recordId)));
      if (certified.value.rows.length !== listedIds.size ||
          certified.value.rows.some(r=>!listedIds.has(String(r.recordId))))
        return unavailable('PAIR_SUPPORT_LIST_INCOMPLETE:' + refKey, armRefs);
    }
    if (family === 'stock') for (const row of rows.value) {
      const sp=row.payload;
      const expected=refKey==='openingStockRefs'?'opening':'closing';
      const tick=expected==='opening'?window.startTick:window.endTick;
      if (!isObject(sp) || sp.phase!==expected || sp.clockTick!==tick ||
          !isObject(sp.quantity) || !safeNumber(sp.quantity.value) || sp.quantity.value<0 ||
          typeof sp.stockId!=='string' || typeof sp.material!=='string' ||
          typeof sp.boundaryId!=='string' || typeof sp.quantity.unit!=='string' ||
          typeof sp.quantity.material!=='string' || typeof sp.quantity.conversionVersion!=='string' ||
          sp.material!==sp.quantity.material)
        return contradiction('PAIR_STOCK_CUT_CONTRADICTION', armRefs);
      const entry=stockCuts.get(sp.stockId)??{};
      if (entry[expected]!==undefined) return contradiction('PAIR_STOCK_DUPLICATE_CUT',armRefs);
      if (entry.material!==undefined && (entry.material!==sp.material || entry.unit!==sp.quantity.unit ||
          entry.version!==sp.quantity.conversionVersion || entry.boundaryId!==sp.boundaryId))
        return contradiction('PAIR_STOCK_DIMENSION_CONTRADICTION',armRefs);
      entry.material=sp.material; entry.unit=sp.quantity.unit;
      entry.version=sp.quantity.conversionVersion; entry.boundaryId=sp.boundaryId;
      entry[expected]=sp.quantity.value; stockCuts.set(sp.stockId,entry);
      stockCutRefs.add(String(row.recordId));
    }
    if (family === 'flow') for (const row of rows.value) {
      const fp=row.payload;
      if (!isObject(fp) || !isObject(fp.quantity) || !finitePositive(fp.quantity.value))
        return unavailable('PAIR_FLOW_QUANTITY_UNAVAILABLE',armRefs);
      flowRows.push(row);
    }
    if (family === 'exposure') for (const row of rows.value) {
      const certifiedExposure=certifyExposureSubject(row,opportunity.actors,window,
        `${pairRef}#${String(row.recordId)}`);
      if (certifiedExposure.state!=='READY') return supportFailure(certifiedExposure);
      const {start,end,subject,activeTicks}=certifiedExposure.value;
      const intervals=exposureIntervals.get(subject)??[];
      if (intervals.some(x=>start < x.end && x.start < end))
        return contradiction('PAIR_EXPOSURE_OVERLAP',armRefs);
      intervals.push({start,end}); exposureIntervals.set(subject,intervals);
      exposureTicks += activeTicks;
    }
    supportRefs.push(...certified.refs, ...armRefs);
  }
  if (!stockCuts.size || [...stockCuts.values()].some(v=>v.opening===undefined || v.closing===undefined))
    return unavailable('PAIR_STOCK_CUTS_UNPAIRED',supportRefs);
  const boundary=certifyBoundaryCensus(view,[...stockCuts.keys()],window);
  if (boundary.state!=='READY') return supportFailure(boundary);
  if ([...stockCuts.values()].some(cut=>cut.boundaryId!==boundary.value.boundaryId))
    return contradiction('PAIR_STOCK_BOUNDARY_ID_CONTRADICTION',[...supportRefs,...boundary.refs]);
  supportRefs.push(...boundary.refs);
  const fullStock=certifyFamily(ctx,view,'stock',['boundaryId','stockId','material','quantity','phase','clockTick'],window,[...stockCutRefs]);
  if (fullStock.state!=='READY') return supportFailure(fullStock);
  if (fullStock.value.rows.some(r=>isObject(r.payload) &&
      (r.payload.phase==='opening' || r.payload.phase==='closing') && !stockCutRefs.has(String(r.recordId))))
    return unavailable('PAIR_STOCK_CUT_LIST_INCOMPLETE',supportRefs);
  const reconciled=new Map<string,number>([...stockCuts].map(([id,x]):[string,number]=>[id,x.opening??0]));
  const seenTransfer=new Map<string,Readonly<JsonObject>>();
  for (const row of flowRows) {
    const fp=row.payload;
    if (!isObject(fp) || !isObject(fp.quantity) || typeof fp.transferId!=='string' ||
        typeof fp.boundaryId!=='string' || typeof fp.quantity.material!=='string' ||
        typeof fp.quantity.unit!=='string' || typeof fp.quantity.conversionVersion!=='string' ||
        !finitePositive(fp.quantity.value)) return unavailable('PAIR_FLOW_DIMENSION_UNAVAILABLE',supportRefs);
    const prior=seenTransfer.get(fp.transferId);
    if (prior) {
      const pp=prior.payload;
      if (!isObject(pp) || pp.counterpartRecordId!==row.recordId || fp.counterpartRecordId!==prior.recordId ||
          JSON.stringify(pp.quantity)!==JSON.stringify(fp.quantity) || pp.fromStockId!==fp.fromStockId ||
          pp.toStockId!==fp.toStockId || pp.flowType!==fp.flowType)
        return contradiction('PAIR_FLOW_COUNTERPART_CONTRADICTION',supportRefs);
      continue;
    }
    seenTransfer.set(fp.transferId,row);
    if (fp.flowType==='conversion') return unavailable('PAIR_FLOW_CONVERSION_UNMODELLED',supportRefs);
    if (fp.fromStockId===null && fp.toStockId===null)
      return contradiction('PAIR_FLOW_NO_STOCK_ENDPOINT',supportRefs);
    if (fp.flowType==='internal' && (typeof fp.fromStockId!=='string' ||
        typeof fp.toStockId!=='string' || fp.fromStockId===fp.toStockId))
      return contradiction('PAIR_INTERNAL_FLOW_ENDPOINTS',supportRefs);
    if (['consumption','loss','external-out'].includes(String(fp.flowType)) &&
        (typeof fp.fromStockId!=='string' || fp.toStockId!==null))
      return contradiction('PAIR_OUTFLOW_ENDPOINTS',supportRefs);
    if (['external-in','regeneration'].includes(String(fp.flowType)) &&
        (fp.fromStockId!==null || typeof fp.toStockId!=='string'))
      return contradiction('PAIR_INFLOW_ENDPOINTS',supportRefs);
    if (fp.counterpartRecordId!==null && !flowRows.some(r=>r.recordId===fp.counterpartRecordId))
      return unavailable('PAIR_FLOW_COUNTERPART_MISSING',supportRefs);
    for (const [key,sign] of [['fromStockId',-1],['toStockId',1]] as const) {
      const id=fp[key];
      if (id===null) continue;
      if (typeof id!=='string') return unavailable('PAIR_FLOW_STOCK_ID_UNAVAILABLE',supportRefs);
      const stock=stockCuts.get(id);
      if (!stock) return contradiction('PAIR_FLOW_STOCK_ID_FOREIGN',supportRefs);
      if (stock.boundaryId!==fp.boundaryId || stock.material!==fp.quantity.material ||
          stock.unit!==fp.quantity.unit || stock.version!==fp.quantity.conversionVersion)
        return unavailable('PAIR_FLOW_CONVERSION_UNRECONCILED',supportRefs);
      reconciled.set(id,(reconciled.get(id)??0)+sign*fp.quantity.value);
    }
  }
  for (const [id,cut] of stockCuts) if (reconciled.get(id)!==cut.closing)
    return contradiction('PAIR_STOCK_FLOW_BALANCE_CONTRADICTION',supportRefs);
  const denominator = normalization === 'per-day' ? exposureTicks / window.ticksPerDay : opportunity.count;
  if (!finitePositive(denominator)) return unavailable('PAIR_NORMALIZATION_DENOMINATOR_UNKNOWN', supportRefs);
  return ready({ rate:eligible.length / denominator, services:eligible.length,
    opportunities:opportunity.count, exposureTicks, actors:opportunity.actors,
    eligibilityRule:opportunity.eligibilityRule,censoredCount:0,
    refs:uniq([...service.refs, ...opportunityList.refs, ...supportRefs]) },
    [...service.refs, ...opportunityList.refs, ...supportRefs]);
}

/** All three phase rates are observed; R and Q never use declared result values. */
export function deriveContemporaryPair(ctx: DerivationContext, criterion: Criterion, pairEvidenceId: string): DerivationBatch {
  const pairItem = ctx.catalog.get(pairEvidenceId);
  if (!pairItem) return allPhaseMetrics(criterion, 'UNKNOWN', 'PAIR_NOT_INDEXED', [pairEvidenceId]);
  if (pairItem.value.kind !== 'causal-pair') return allPhaseMetrics(criterion, 'REJECT', 'PAIR_KIND_CONTRADICTION', [pairEvidenceId]);
  const covered = observedEvidenceFields(pairItem.value,
    ['criterion','registeredRef','treatmentRunId','controlRunId','initialStateHash','paramsHash','inputTraceHash',
      'governorTraceHash','interventionRefs','functionIds','normalization','windows','treatmentManifestRef',
      'controlManifestRef','equivalenceTolerance','equivalenceUnit'], pairEvidenceId);
  if (covered.state !== 'READY') return stop(criterion, covered);
  const p = pairItem.value.payload as JsonObject;
  if (p.criterion !== criterion || !strings(p.functionIds) || !p.functionIds.length ||
      !strings(p.interventionRefs) || !['per-day','per-opportunity'].includes(String(p.normalization)) ||
      !safeNumber(p.equivalenceTolerance) || p.equivalenceTolerance < 0 || p.equivalenceTolerance >= 1 ||
      !Array.isArray(p.windows) || p.windows.length !== 3)
    return allPhaseMetrics(criterion, 'REJECT', 'PAIR_DECLARATION_SHAPE_OR_CRITERION', [pairEvidenceId]);
  const prereg = ctx.catalog.get(field(p,'registeredRef'));
  if (!prereg) return allPhaseMetrics(criterion,'UNKNOWN','PAIR_PREREGISTRATION_NOT_INDEXED',[pairEvidenceId,field(p,'registeredRef')]);
  if (prereg.value.kind !== 'preregistration') return allPhaseMetrics(criterion,'REJECT','PAIR_PREREGISTRATION_KIND',[pairEvidenceId,field(p,'registeredRef')]);
  const regCoverage = observedEvidenceFields(prereg.value,
    ['contentHash','registeredAt','firstDataAt','controlPairRefs','interventions','plannedRunIds','arms','profileHash','metricDefinitionsRef'],
    field(p,'registeredRef'));
  if (regCoverage.state !== 'READY') return stop(criterion,regCoverage);
  const reg = prereg.value.payload as JsonObject;
  const parsedRegistration=typeof reg.registeredAt==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(reg.registeredAt)
    ? Date.parse(reg.registeredAt) : NaN;
  const parsedData=typeof reg.firstDataAt==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(reg.firstDataAt)
    ? Date.parse(reg.firstDataAt) : NaN;
  if (!strings(reg.controlPairRefs) || !strings(reg.interventions) || !strings(reg.plannedRunIds) || !strings(reg.arms))
    return allPhaseMetrics(criterion,'REJECT','PAIR_PREREGISTRATION_LIST_SHAPE',[pairEvidenceId,field(p,'registeredRef')]);
  const registeredPairs=reg.controlPairRefs, registeredInterventions=reg.interventions;
  if (!Number.isFinite(parsedRegistration) || !Number.isFinite(parsedData) || parsedRegistration >= parsedData ||
      typeof reg.contentHash!=='string' || !/^[a-f0-9]{64}$/.test(reg.contentHash) ||
      !registeredPairs.includes(pairEvidenceId) ||
      p.interventionRefs.some(r => !registeredInterventions.includes(r)) ||
      !reg.plannedRunIds.includes(field(p,'treatmentRunId')) ||
      !reg.plannedRunIds.includes(field(p,'controlRunId')) ||
      !reg.arms.includes('paired-treatment') || !reg.arms.includes('paired-control') ||
      reg.profileHash!==ctx.root.thresholdProfileHash)
    return allPhaseMetrics(criterion,'REJECT','PAIR_NOT_PREREGISTERED_BEFORE_DATA',[pairEvidenceId,field(p,'registeredRef')]);
  const definitions=ctx.catalog.get(String(reg.metricDefinitionsRef));
  if (!definitions) return allPhaseMetrics(criterion,'UNKNOWN','PAIR_METRIC_DEFINITIONS_NOT_INDEXED',[pairEvidenceId,String(reg.metricDefinitionsRef)]);
  if (definitions.value.kind!=='metric-definitions')
    return allPhaseMetrics(criterion,'REJECT','PAIR_METRIC_DEFINITIONS_KIND',[pairEvidenceId,String(reg.metricDefinitionsRef)]);
  const t = manifestView(ctx,field(p,'treatmentManifestRef'),field(p,'treatmentRunId'),'paired-treatment');
  const c = manifestView(ctx,field(p,'controlManifestRef'),field(p,'controlRunId'),'paired-control');
  if (t.state !== 'READY') return stop(criterion,t);
  if (c.state !== 'READY') return stop(criterion,c);
  const a = t.value.observation, b = c.value.observation;
  if (a.runId === b.runId || a.pairedRunId !== b.runId || b.pairedRunId !== a.runId ||
      !isObject(a.plannedWindow) || !isObject(b.plannedWindow) || !isObject(a.actualWindow) || !isObject(b.actualWindow) ||
      JSON.stringify(a.plannedWindow) !== JSON.stringify(b.plannedWindow) ||
      ['sourceSHA','seed','paramsHash','initialStateHash','epochId'].some(k => a[k] !== b[k]) ||
      p.paramsHash !== a.paramsHash || p.initialStateHash !== a.initialStateHash)
    return allPhaseMetrics(criterion,'REJECT','PAIR_ARM_IDENTITY_CONTRADICTION',[pairEvidenceId,...t.refs,...c.refs]);
  for (const view of [t.value,c.value]) {
    for (const [refKey,hashKey] of [['inputTraceRef','inputTraceHash'],['governorTraceRef','governorTraceHash']] as const) {
      const trace = view.catalog.get(String(view.observation[refKey]));
      if (!trace) return allPhaseMetrics(criterion,'UNKNOWN','PAIR_TRACE_NOT_INDEXED',[pairEvidenceId,String(view.observation[refKey])]);
      if (trace.sha256 !== p[hashKey]) return allPhaseMetrics(criterion,'REJECT','PAIR_TRACE_SHA_CONTRADICTION',[pairEvidenceId,String(view.observation[refKey])]);
    }
  }
  const windows = p.windows as JsonObject[];
  for (let i=0;i<3;i++) {
    const w=windows[i];
    if (!isObject(w) || w.phase !== phases[i] || !safeNumber(w.startTick) || !safeNumber(w.endTick) ||
        w.startTick >= w.endTick || (i===0 ? w.startTick !== a.plannedWindow.startTick : w.startTick !== windows[i-1].endTick) ||
        (i===2 && w.endTick !== a.plannedWindow.endTick))
      return allPhaseMetrics(criterion,'REJECT','PAIR_PHASE_WINDOW_CONTRADICTION',[pairEvidenceId]);
  }
  for (const phase of windows) for (const key of ['openingStockRefs','closingStockRefs','flowRefs','exposureRefs']) {
    const refs=listed(phase,key,pairEvidenceId);
    if (refs.state!=='READY') return stop(criterion,refs);
    if (refs.value.some(ref=>!ref.startsWith(t.value.scope.bundleEvidenceId+'#') &&
        !ref.startsWith(c.value.scope.bundleEvidenceId+'#')))
      return allPhaseMetrics(criterion,'REJECT','PAIR_SHARED_REF_UNSCOPED_OR_FOREIGN',[pairEvidenceId,...refs.value]);
  }
  if (!strings(a.interventionRefs) || !strings(b.interventionRefs) ||
      JSON.stringify([...a.interventionRefs].sort()) !== JSON.stringify([...p.interventionRefs].sort()) ||
      b.interventionRefs.length !== 0 || p.interventionRefs.length < 2)
    return allPhaseMetrics(criterion,'REJECT','PAIR_INTERVENTION_ARM_CONTRADICTION',[pairEvidenceId,...t.refs,...c.refs]);
  const interventionPhases = new Set<Phase>();
  for (const ref of p.interventionRefs) {
    const intervention = evidenceInRun(t.value,ref,'intervention');
    if (intervention.state !== 'READY') return stop(criterion,intervention);
    const ip = intervention.value.payload as JsonObject;
    if (!safeNumber(ip.tick))
      return allPhaseMetrics(criterion,'UNKNOWN','PAIR_INTERVENTION_TICK_UNOBSERVED',[pairEvidenceId,ref]);
    const interventionTick=ip.tick;
    const phase = windows.find(w => typeof w.startTick==='number' && typeof w.endTick==='number' &&
      w.startTick < interventionTick && interventionTick <= w.endTick);
    if (!phase || (phase.phase !== 'removal' && phase.phase !== 'restoration'))
      return allPhaseMetrics(criterion,'REJECT','PAIR_INTERVENTION_PHASE_CONTRADICTION',[pairEvidenceId,ref]);
    const application=certifyInterventionApplication(t.value,intervention.value,phase.phase,interventionTick,ref);
    if (application.state==='REJECT') return stop(criterion,application);
    if (application.state==='UNKNOWN' && application.reason!=='PAIR_INTERVENTION_APPLICATION_UNVERIFIABLE')
      return stop(criterion,application);
    interventionPhases.add(phase.phase);
  }
  if (!interventionPhases.has('removal') || !interventionPhases.has('restoration'))
    return allPhaseMetrics(criterion,'UNKNOWN','PAIR_PHASE_INTERVENTIONS_NOT_OBSERVED',[pairEvidenceId,...p.interventionRefs]);
  const cells: Record<Phase, { treatment:Cell; control:Cell }> = {} as Record<Phase,{treatment:Cell;control:Cell}>;
  for (let i=0;i<3;i++) {
    const w=windows[i], window=windowOf(a.plannedWindow,w);
    for (const view of [t.value,c.value]) {
      const actual=view.observation.actualWindow as JsonObject;
      if (Number(actual.startTick)>window.startTick || Number(actual.endTick)<window.endTick)
        return allPhaseMetrics(criterion,'UNKNOWN','PAIR_PHASE_NOT_FULLY_OBSERVED',[pairEvidenceId,view.scope.bundleEvidenceId]);
    }
    const treatment=phaseCell(ctx,t.value,w,'treatment',window,p.functionIds,p.normalization as string,field(p,'registeredRef'));
    const control=phaseCell(ctx,c.value,w,'control',window,p.functionIds,p.normalization as string,field(p,'registeredRef'));
    if (treatment.state !== 'READY') return stop(criterion,treatment);
    if (control.state !== 'READY') return stop(criterion,control);
    if (treatment.value.opportunities!==control.value.opportunities ||
        treatment.value.eligibilityRule!==control.value.eligibilityRule ||
        JSON.stringify(treatment.value.actors)!==JSON.stringify(control.value.actors) ||
        (p.normalization==='per-day' && treatment.value.exposureTicks!==control.value.exposureTicks))
      return allPhaseMetrics(criterion,'UNKNOWN','PAIR_ARM_DENOMINATORS_NOT_COMPARABLE',
        [...treatment.refs,...control.refs]);
    cells[phases[i]]={treatment:treatment.value,control:control.value};
  }
  const ref=cells.reference, removal=cells.removal, restoration=cells.restoration;
  const refs=uniq([pairEvidenceId,field(p,'registeredRef'),...t.refs,...c.refs,
    ...Object.values(cells).flatMap(x=>[...x.treatment.refs,...x.control.refs])]);
  if (Math.abs(ref.treatment.rate-ref.control.rate)>p.equivalenceTolerance)
    return allPhaseMetrics(criterion,'REJECT','PAIR_REFERENCE_NOT_EQUIVALENT',refs);
  if (!finitePositive(removal.control.rate) || !finitePositive(restoration.control.rate))
    return allPhaseMetrics(criterion,'UNKNOWN','PAIR_CONTROL_DENOMINATOR_ZERO',refs);
  const ratios=observedCausalRatios(removal.treatment.rate,removal.control.rate,
    restoration.treatment.rate,restoration.control.rate);
  if (!Number.isFinite(ratios.removalDrop) || !Number.isFinite(ratios.restoration))
    return allPhaseMetrics(criterion,'REJECT','PAIR_NONFINITE_CONTRAST',refs);
  // The frozen G1 preregistration has a contentHash but no canonical sealed pair
  // protocol or independent timestamp attestation. Its dates and hash are claims.
  // Never turn an observed contrast into an authoritative contemporary pair.
  return allPhaseMetrics(criterion,'UNKNOWN','PAIR_PREREG_SEAL_AND_INTERVENTION_APPLICATION_UNVERIFIABLE:windows-functions-normalization-tolerance-time',
    [...refs,String(reg.metricDefinitionsRef)]);
}
