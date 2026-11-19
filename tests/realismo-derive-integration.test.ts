import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createDerivationContext, observationView, certifyStream, certifyRecordOrder,
  measuredMetric, recordIn } from '../scripts/lab/realismo-derive-common.js';
import { deriveContemporaryPair, observedCausalRatios, certifyCohortCensors,
  reconcilePhaseCensors, certifyExposureSubject, certifyBoundaryCensus,
  certifyInterventionApplication } from '../scripts/lab/realismo-derive-causal-pair.js';
import { validateBundleFile, validateSemantics } from '../scripts/lab/realismo-contract.js';
import type { CatalogItem, JsonObject } from '../scripts/lab/realismo-contract.js';

const examples=resolve('specs/003-criterios-realismo/contracts/examples');
const report=()=>validateBundleFile(resolve(examples,'conservation-service.v3.json'));
const canonical=()=>{
  const validation=report();
  assert.equal(validation.valid,true,JSON.stringify(validation.issues));
  const context=createDerivationContext(validation);
  if (context.state!=='READY') throw new Error(context.reason);
  const root=context.value.root;
  const view=observationView(context.value,{bundleEvidenceId:String(root.evidenceId),
    runId:String(root.runId),epochId:String(root.epochId)});
  if (view.state!=='READY') throw new Error(view.reason);
  return {context:context.value,view:view.value};
};

test('validated canonical stock stream yields typed READY and non-null MEASURED',()=>{
  const {context}=canonical();
  const window=context.root.plannedWindow as JsonObject;
  const certified=certifyStream(context,{bundleEvidenceId:'conservation-service',
    runId:'manual-conservation-service',epochId:'e0',streamId:'stock-stream',family:'stock',
    window:{startTick:0,endTick:1,ticksPerDay:Number(window.ticksPerDay),
      closure:String(window.closure),clock:String(window.clock),epochId:'e0'},
    fields:['stockId','quantity','phase','clockTick'],order:'any'});
  assert.equal(certified.state,'READY');
  if (certified.state!=='READY') return;
  assert.equal(certified.value.records.length,2);
  assert.equal(certified.value.eligibleOpportunities,2);
  const metric=measuredMetric('fixture.stockCuts',certified.value.records.length,'count',certified.refs,
    certified.value.query.window,'CANONICAL_COMPLETE_STOCK_CUTS');
  assert.equal(metric.state,'MEASURED');
  if (metric.state==='MEASURED') assert.equal(metric.value,2);
});

test('source-order tuple collision rejects despite a matching mapped event',()=>{
  const {context,view}=canonical();
  const service=view.records.find(row=>row.recordId==='service-1');
  assert.ok(service);
  if (!service) return;
  assert.equal(certifyRecordOrder(view,service).state,'READY');
  const original=context.catalog.get('order');
  assert.ok(original);
  if (!original) return;
  const document=structuredClone(original.value);
  const payload=document.payload as JsonObject;
  const entries=payload.entries as JsonObject[];
  payload.entries=[...entries,{...entries[1],sourceEventId:'different-event',recordIds:['other-record']}];
  const catalog=new Map(context.catalog);
  catalog.set('order',{...original,value:document} satisfies CatalogItem);
  const changed={...view,catalog};
  const result=certifyRecordOrder(changed,service);
  assert.equal(result.state,'REJECT');
  if (result.state==='REJECT') assert.equal(result.reason,'SOURCE_ORDER_TUPLE_NOT_UNIQUE');
});

test('qualified record refs distinguish observations and absent IDs remain UNKNOWN',()=>{
  const {view}=canonical();
  assert.equal(recordIn(view,'conservation-service#service-1',true).state,'READY');
  assert.equal(recordIn(view,'other-arm#service-1',true).state,'REJECT');
  assert.equal(recordIn(view,'conservation-service#absent',true).state,'UNKNOWN');
  assert.equal(recordIn(view,'service-1',true).state,'UNKNOWN');
});

test('a nonexistent zero-support ref cannot certify an empty subwindow',()=>{
  const {context}=canonical();
  const root=structuredClone(context.root);
  const stock=(root.streams as JsonObject[]).find(row=>row.streamId==='stock-stream');
  assert.ok(stock);
  if (!stock) return;
  (stock.window as JsonObject).endTick=2;
  const catalog=new Map(context.catalog);
  const rootItem=catalog.get(String(root.evidenceId));
  assert.ok(rootItem);
  if (!rootItem) return;
  catalog.set(String(root.evidenceId),{...rootItem,value:root});
  const result=certifyStream({root,catalog},{bundleEvidenceId:'conservation-service',
    runId:'manual-conservation-service',epochId:'e0',streamId:'stock-stream',family:'stock',
    window:{startTick:1,endTick:2,ticksPerDay:2400,closure:'(start,end]',clock:'global',epochId:'e0'},
    fields:['stockId','quantity'],order:'any',zeroSupportRefs:['does-not-exist']});
  assert.equal(result.state,'UNKNOWN');
  if (result.state==='UNKNOWN') assert.equal(result.reason,'EVIDENCE_NOT_IN_ARM_NAMESPACE');
});

test('exact empty COMPLETE window cannot turn declared opportunity into absence proof',()=>{
  const {context}=canonical();
  const root={...structuredClone(context.root)};
  root.records=(root.records as JsonObject[]).filter(row=>row.streamId!=='stock-stream');
  const stock=(root.streams as JsonObject[]).find(row=>row.streamId==='stock-stream');
  assert.ok(stock);
  if (!stock) return;
  Object.assign(stock,{firstSeq:null,lastSeq:null,expectedRecords:0,observedRecords:0,
    eligibleOpportunities:1,censoredSubjects:[]});
  const catalog=new Map(context.catalog);
  const item=catalog.get(String(root.evidenceId));
  assert.ok(item);
  if (!item) return;
  catalog.set(String(root.evidenceId),{...item,value:root});
  const window=root.plannedWindow as JsonObject;
  const result=certifyStream({root,catalog},{bundleEvidenceId:String(root.evidenceId),
    runId:String(root.runId),epochId:String(root.epochId),streamId:'stock-stream',family:'stock',
    window:{startTick:Number(window.startTick),endTick:Number(window.endTick),ticksPerDay:Number(window.ticksPerDay),
      closure:String(window.closure),clock:String(window.clock),epochId:String(root.epochId)},
    fields:['stockId','quantity'],order:'any'});
  assert.equal(result.state,'UNKNOWN');
  if (result.state==='UNKNOWN') assert.equal(result.reason,'ZERO_LOCAL_PROOF_UNAVAILABLE');
});

test('zero opportunity requires family linkage and an in-arm selection registration',()=>{
  const {context}=canonical();
  const root={...structuredClone(context.root)};
  root.records=(root.records as JsonObject[]).filter(row=>row.streamId!=='stock-stream');
  const stock=(root.streams as JsonObject[]).find(row=>row.streamId==='stock-stream');
  assert.ok(stock);
  if (!stock) return;
  Object.assign(stock,{firstSeq:null,lastSeq:null,expectedRecords:0,observedRecords:0,
    eligibleOpportunities:1,censoredSubjects:[]});
  const window=root.plannedWindow as JsonObject;
  const status={status:'observed',reason:'adversarial fixture'};
  const opportunity={kind:'opportunity',payload:{cohortRef:'zero-cohort',startTick:0,endTick:1,
    eligibleActorIds:['actor']},fieldCoverage:{cohortRef:status,startTick:status,endTick:status,
      eligibleActorIds:status}};
  const cohort={kind:'cohort',payload:{actorIds:['actor'],censored:[],selectionRegisteredRef:'missing-selection',atTick:0},
    fieldCoverage:{actorIds:status,censored:status,selectionRegisteredRef:status,atTick:status}};
  const catalog=new Map(context.catalog);
  const item=catalog.get(String(root.evidenceId));
  assert.ok(item);
  if (!item) return;
  catalog.set(String(root.evidenceId),{...item,value:root});
  catalog.set('zero-opportunity',{...item,value:opportunity});
  catalog.set('zero-cohort',{...item,value:cohort});
  const query={bundleEvidenceId:String(root.evidenceId),runId:String(root.runId),epochId:String(root.epochId),
    streamId:'stock-stream',family:'stock' as const,
    window:{startTick:Number(window.startTick),endTick:Number(window.endTick),ticksPerDay:Number(window.ticksPerDay),
      closure:String(window.closure),clock:String(window.clock),epochId:String(root.epochId)},
    fields:['stockId','quantity'],order:'any' as const,zeroSupportRefs:['zero-opportunity']};
  const foreign=certifyStream({root,catalog},query);
  assert.equal(foreign.state,'UNKNOWN');
  if (foreign.state==='UNKNOWN') assert.equal(foreign.reason,'ZERO_OPPORTUNITY_NOT_LINKED_TO_FAMILY');
  stock.evidenceRefs=['zero-opportunity'];
  const missingSelection=certifyStream({root,catalog},query);
  assert.equal(missingSelection.state,'UNKNOWN');
  // The selector is absent from the validated arm namespace. evidenceInRun checks
  // that boundary first, so EVIDENCE_NOT_INDEXED cannot be reached for this ref.
  assert.equal(catalog.has('missing-selection'),false);
  if (missingSelection.state==='UNKNOWN') {
    assert.equal(missingSelection.reason,'EVIDENCE_NOT_IN_ARM_NAMESPACE');
    assert.ok(missingSelection.refs.includes(String(root.evidenceId)));
    assert.ok(missingSelection.refs.includes('missing-selection'));
  }
  cohort.payload.selectionRegisteredRef='registration';
  const registration=catalog.get('registration');
  assert.ok(registration);
  if (!registration) return;
  const registrationDoc=structuredClone(registration.value);
  (registrationDoc.payload as JsonObject).registeredAt='2026-10-01T00:00:00Z';
  (registrationDoc.payload as JsonObject).firstDataAt='2026-10-02T00:00:00Z';
  (registrationDoc.fieldCoverage as JsonObject).registeredAt=status;
  (registrationDoc.fieldCoverage as JsonObject).firstDataAt=status;
  catalog.set('registration',{...registration,value:registrationDoc});
  const unsupported=certifyStream({root,catalog},query);
  assert.equal(unsupported.state,'UNKNOWN');
  if (unsupported.state==='UNKNOWN') assert.equal(unsupported.reason,'ZERO_ABSENCE_PROOF_UNAVAILABLE');

  // The canonical fixture has one arm. Add a second indexed arm to this local
  // adversarial context; its registration must not cross into the first arm.
  const localNamespace=new Map(catalog);
  const foreignRegistration={...registration,value:{...registrationDoc,evidenceId:'foreign-registration'}};
  catalog.set(String(root.evidenceId),{...item,value:root,namespace:localNamespace});
  catalog.set('foreign-registration',foreignRegistration);
  catalog.set('foreign-arm',{...item,value:{...root,evidenceId:'foreign-arm',runId:'foreign-run'},
    namespace:new Map([['foreign-registration',foreignRegistration]])});
  cohort.payload.selectionRegisteredRef='foreign-registration';
  const otherArm=observationView({root,catalog},{bundleEvidenceId:'foreign-arm',
    runId:'foreign-run',epochId:String(root.epochId)});
  assert.equal(otherArm.state,'READY');
  if (otherArm.state==='READY') assert.equal(otherArm.value.localEvidenceIds.has('foreign-registration'),true);
  assert.equal(localNamespace.has('foreign-registration'),false);
  const otherArmSelection=certifyStream({root,catalog},query);
  assert.equal(otherArmSelection.state,'UNKNOWN');
  if (otherArmSelection.state==='UNKNOWN') {
    assert.equal(otherArmSelection.reason,'EVIDENCE_NOT_IN_ARM_NAMESPACE');
    assert.ok(otherArmSelection.refs.includes(String(root.evidenceId)));
    assert.ok(otherArmSelection.refs.includes('foreign-registration'));
  }
});

test('ancestor epoch contradiction rejects a transitive source-order chain',()=>{
  const {view}=canonical();
  const records=view.records.map(row=>row.recordId==='condition-1'?{...row,epochId:'foreign-epoch'}:row);
  const changed={...view,records};
  const service=records.find(row=>row.recordId==='service-1');
  assert.ok(service);
  if (!service) return;
  const result=certifyRecordOrder(changed,service);
  assert.equal(result.state,'REJECT');
  if (result.state==='REJECT') assert.equal(result.reason,'PREDECESSOR_SOURCE_ORDER_CONTRADICTION');
  const remapped={...view,records:view.records.map(row=>row.recordId==='condition-1'?
    {...row,causalContext:{...(row.causalContext as JsonObject),sourceEventId:'other-event'}}:row)};
  const mappedService=remapped.records.find(row=>'recordId' in row && row.recordId==='service-1');
  assert.ok(mappedService);
  if (!mappedService) return;
  assert.equal(certifyRecordOrder(remapped,mappedService).state,'REJECT');
});

test('eligible event actor cannot lend exposure to a foreign subject',()=>{
  const window={startTick:0,endTick:10,ticksPerDay:10,closure:'(start,end]',clock:'global',epochId:'e0'};
  const row={tick:10,actorIds:['eligible'],payload:{subjectId:'foreign',startTick:0,endTick:10,
    activeTicks:10,mode:'active'}};
  const result=certifyExposureSubject(row,['eligible'],window,'arm#exposure');
  assert.equal(result.state,'REJECT');
  if (result.state==='REJECT') assert.equal(result.reason,'PAIR_EXPOSURE_SUBJECT_OUTSIDE_COHORT');
});

test('cohort and phase census reject foreign or duplicate censorship and expose missing reconciliation',()=>{
  const window={startTick:0,endTick:10,ticksPerDay:10,closure:'(start,end]',clock:'global',epochId:'e0'};
  for (const raw of [[{actorId:'foreign',lastObservedTick:5,reason:'lost'}],
    [{actorId:'eligible',lastObservedTick:5,reason:'lost'},{actorId:'eligible',lastObservedTick:6,reason:'lost'}],
    [{actorId:'eligible',lastObservedTick:-1,reason:'lost'}],
    [{actorId:'eligible',lastObservedTick:5,reason:''}]]) {
    assert.equal(certifyCohortCensors(raw,['eligible'],0,'cohort').state,'REJECT');
  }
  const checked=certifyCohortCensors([{actorId:'eligible',lastObservedTick:5,reason:'lost'}],
    ['eligible'],0,'cohort');
  assert.equal(checked.state,'READY');
  if (checked.state!=='READY') return;
  const cohort={count:1,actors:['eligible'],eligibilityRule:'observed',censored:checked.value,refs:['cohort']};
  assert.equal(reconcilePhaseCensors(['foreign'],cohort,window,['stream']).state,'REJECT');
  assert.equal(reconcilePhaseCensors(['eligible','eligible'],cohort,window,['stream']).state,'REJECT');
  const late=certifyCohortCensors([{actorId:'eligible',lastObservedTick:11,reason:'lost'}],
    ['eligible'],0,'cohort');
  assert.equal(late.state,'READY');
  if (late.state==='READY') assert.equal(reconcilePhaseCensors(['eligible'],{...cohort,censored:late.value},
    window,['stream']).state,'REJECT');
  const absent=reconcilePhaseCensors([],cohort,window,['stream']);
  assert.equal(absent.state,'UNKNOWN');
  if (absent.state==='UNKNOWN') assert.equal(absent.reason,'PAIR_COHORT_CENSOR_NOT_IN_STREAM');
  const listed=reconcilePhaseCensors(['eligible'],cohort,window,['stream']);
  assert.equal(listed.state,'UNKNOWN');
  if (listed.state==='UNKNOWN') assert.equal(listed.reason,'PAIR_STREAM_CENSOR_TICK_REASON_UNVERIFIABLE');
});

test('stock boundary requires an observed census with matching stock IDs',()=>{
  const {view}=canonical();
  const window={startTick:0,endTick:1,ticksPerDay:2400,closure:'(start,end]',clock:'global',epochId:'e0'};
  const missing={...view,records:view.records.map(row=>{
    if (row.recordId!=='wood-boundary') return row;
    const payload={...(row.payload as JsonObject)};
    delete payload.boundaryId;
    return {...row,payload};
  })};
  assert.equal(certifyBoundaryCensus(missing,['wood-source'],window).state,'UNKNOWN');
  const mismatched={...view,records:view.records.map(row=>row.recordId==='wood-boundary'?
    {...row,payload:{...(row.payload as JsonObject),scope:'global',stockIds:['foreign-stock']}}:row)};
  const result=certifyBoundaryCensus(mismatched,['wood-source'],window);
  assert.equal(result.state,'REJECT');
  if (result.state==='REJECT') assert.equal(result.reason,'PAIR_BOUNDARY_STOCK_CENSUS_CONTRADICTION');
});

test('declared intervention with observed kind and input still lacks application proof',()=>{
  const {view}=canonical();
  const input='conservation-service#condition-1';
  const doc={payload:{runId:view.scope.runId,tick:1,kind:'removal',declaredBeforeData:true,inputRefs:[input]},
    fieldCoverage:Object.fromEntries(['runId','tick','kind','declaredBeforeData','inputRefs']
      .map(key=>[key,{status:'observed',reason:'fixture'}]))};
  const result=certifyInterventionApplication(view,doc,'removal',1,'intervention');
  assert.equal(result.state,'UNKNOWN');
  if (result.state==='UNKNOWN') assert.equal(result.reason,'PAIR_INTERVENTION_APPLICATION_UNVERIFIABLE');
  const contradictory=structuredClone(doc);
  contradictory.payload.kind='restoration';
  assert.equal(certifyInterventionApplication(view,contradictory,'removal',1,'intervention').state,'REJECT');
});

test('observed causal arithmetic remains R=.4 and Q=.9 without conferring proof',()=>{
  const rates=observedCausalRatios(60/100,100/100,90/100,100/100);
  assert.equal(rates.removalDrop,0.4);
  assert.equal(rates.restoration,0.9);
  assert.throws(()=>observedCausalRatios(1,0,1,1),RangeError);
});

test('a schema-valid causal pair reports the first missing preregistration and definition evidence',()=>{
  const {context}=canonical();
  const pair=JSON.parse(readFileSync(resolve(examples,'causal-pair-c11.json'),'utf8')) as JsonObject;
  assert.equal(validateSemantics('evidence.schema.json',pair).valid,true);
  const catalog=new Map(context.catalog);
  catalog.set('C11-pair',{value:pair,entry:{kind:'causal-pair'},sha256:'fixture',path:'fixture'});
  const missingHash=deriveContemporaryPair({...context,catalog},'C11','C11-pair');
  assert.deepEqual(missingHash.metrics.map(metric=>metric.id),
    ['C11.contemporaryPairs','C11.removalDrop','C11.restoration']);
  for (const metric of missingHash.metrics) {
    assert.equal(metric.state,'UNKNOWN');
    assert.equal(metric.value,null);
    assert.equal(metric.reason,'EVIDENCE_FIELD_MISSING:contentHash');
    assert.deepEqual(metric.refs,['registration']);
  }

  // This local adversarial document clears the registration field gate only;
  // its dates and digest are claims, not a canonical G1 seal or temporal receipt.
  const registration=catalog.get('registration');
  assert.ok(registration);
  if (!registration) return;
  const doc=structuredClone(registration.value);
  const payload=doc.payload as JsonObject;
  Object.assign(payload,{contentHash:'a'.repeat(64),registeredAt:'2026-10-01T00:00:00Z',
    firstDataAt:'2026-10-02T00:00:00Z',controlPairRefs:['C11-pair'],
    interventions:['registered-removal','registered-restoration'],
    plannedRunIds:['synthetic-treatment','synthetic-control'],
    arms:['paired-treatment','paired-control'],profileHash:context.root.thresholdProfileHash,
    metricDefinitionsRef:'definitions'});
  const coverage=doc.fieldCoverage as JsonObject;
  for (const key of ['contentHash','registeredAt','firstDataAt','controlPairRefs','interventions',
    'plannedRunIds','arms','profileHash','metricDefinitionsRef'])
    coverage[key]={status:'observed',reason:'controlled manual test claim'};
  catalog.set('registration',{...registration,value:doc});
  assert.equal(catalog.has('definitions'),false);
  const missingDefinitions=deriveContemporaryPair({...context,catalog},'C11','C11-pair');
  assert.deepEqual(missingDefinitions.metrics.map(metric=>metric.id),
    ['C11.contemporaryPairs','C11.removalDrop','C11.restoration']);
  for (const metric of missingDefinitions.metrics) {
    assert.equal(metric.state,'UNKNOWN');
    assert.equal(metric.value,null);
    assert.equal(metric.reason,'PAIR_METRIC_DEFINITIONS_NOT_INDEXED');
    assert.deepEqual(metric.refs,['C11-pair','definitions']);
  }
});

test('an invalid preregistration date is a contradiction, not temporal proof',()=>{
  const {context}=canonical();
  const pair=JSON.parse(readFileSync(resolve(examples,'causal-pair-c11.json'),'utf8')) as JsonObject;
  const registration=context.catalog.get('registration');
  assert.ok(registration);
  if (!registration) return;
  const doc=structuredClone(registration.value);
  const payload=doc.payload as JsonObject;
  Object.assign(payload,{contentHash:'a'.repeat(64),registeredAt:'not-a-date',
    firstDataAt:'2026-10-04T00:00:00Z',controlPairRefs:['C11-pair'],
    interventions:['registered-removal','registered-restoration'],
    plannedRunIds:['synthetic-treatment','synthetic-control'],
    arms:['paired-treatment','paired-control'],profileHash:context.root.thresholdProfileHash,
    metricDefinitionsRef:'definitions'});
  const coverage=doc.fieldCoverage as JsonObject;
  for (const key of Object.keys(payload)) coverage[key]={status:'observed',reason:'adversarial fixture'};
  const catalog=new Map(context.catalog);
  catalog.set('registration',{...registration,value:doc});
  catalog.set('C11-pair',{value:pair,entry:{kind:'causal-pair'},sha256:'fixture',path:'fixture'});
  const result=deriveContemporaryPair({...context,catalog},'C11','C11-pair');
  assert.deepEqual(result.metrics.map(metric=>metric.state),['REJECT','REJECT','REJECT']);
  assert.ok(result.metrics.every(metric=>metric.reason==='PAIR_NOT_PREREGISTERED_BEFORE_DATA'));
});
