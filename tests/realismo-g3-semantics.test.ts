import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRealismo, evaluateMaterialBalance, findUnauthorizedMemory,
  type EvaluationInput, type BalanceLedger, type MemoryEvidence } from '../scripts/lab/realismo-evaluator.js';
import { aggregatePanel } from '../scripts/lab/realismo-panel.js';
import { THRESHOLD_PROFILE_SHA256 } from '../scripts/lab/realismo-contract.js';

test('C13 reports a .6 replica without applying the .7 panel median to it', () => {
  const input:EvaluationInput={contractVersion:'realismo-v3',profileId:'r1-20261003-correction3-provisional',
    profileSha256:THRESHOLD_PROFILE_SHA256,source:'manual-fixture',synthetic:true,coveredCriteria:['C13'],
    valuesByCriterion:{C13:{founders:10,alive2d:8,alive10d:6,deaths:1,deathsWithHistory:1,
      shortLives:0,eligibleBirths:10,controlShortLives:0,controlEligibleBirths:10}}};
  const c13=evaluateRealismo(input).criteria.find(c=>c.criterion==='C13')!;
  assert.equal(c13.verdict,'PASS');
  const survival=c13.subgates.flatMap(g=>g.metrics).find(m=>m.id==='C13.founderMedian10d')!;
  assert.equal(survival.value,.6);
  assert.equal(survival.verdict,'UNKNOWN');
  assert.equal(survival.reason,'PANEL_ONLY_DESCRIPTIVE_REPLICA');
  const panel=aggregatePanel({plannedSeeds:[1,2,3,4,5,6,7,8],runs:[.6,.6,.6,.6,.8,.8,.8,.8].map((value,i)=>({
    seed:i+1,status:'complete' as const,verdict:'PASS' as const,quality:'COMPLETE' as const,evidenceRefs:[`r${i+1}`],safetyViolation:false,
    founderSurvival10d:value,collapse:false}))});
  assert.equal(panel.c13.medianFounder10d,.7);
  assert.equal(panel.c13.verdict,'PASS');
  const low=aggregatePanel({plannedSeeds:[1,2,3,4,5,6,7,8],runs:[1,2,3,4,5,6,7,8].map(seed=>({
    seed,status:'complete' as const,verdict:'PASS' as const,quality:'COMPLETE' as const,evidenceRefs:[`r${seed}`],safetyViolation:false,
    founderSurvival10d:.6,collapse:false}))});
  assert.equal(low.c13.verdict,'FAIL');
});

test('C13 bundle override stays descriptive for a .6 replica', () => {
  const input:EvaluationInput={contractVersion:'realismo-v3',profileId:'r1-20261003-correction3-provisional',
    profileSha256:THRESHOLD_PROFILE_SHA256,source:'bundle',synthetic:false,coveredCriteria:[],
    valuesByCriterion:{},availableEvidenceIds:['r'],
    metricOverrides:{'C13.founderMedian10d':{value:.6,refs:['r'],reason:'MEASURED_FOUNDER_SURVIVAL'}}};
  const result=evaluateRealismo(input);
  const median=result.criteria.find(c=>c.criterion==='C13')!.subgates.flatMap(g=>g.metrics)
    .find(m=>m.id==='C13.founderMedian10d')!;
  assert.deepEqual({value:median.value,verdict:median.verdict,reason:median.reason,refs:median.refs},
    {value:.6,verdict:'UNKNOWN',reason:'PANEL_ONLY_DESCRIPTIVE_REPLICA',refs:['r']});
  assert.equal(result.criteria.find(c=>c.criterion==='C13')?.verdict,'UNKNOWN');
});

test('an incomplete eight-seed panel preserves proven safety and collapse failures', () => {
  const runs=[{seed:1,status:'complete' as const,verdict:'FAIL' as const,quality:'COMPLETE' as const,evidenceRefs:['r1'],safetyViolation:true,
    founderSurvival10d:.8,collapse:true}];
  const panel=aggregatePanel({plannedSeeds:[1,2,3,4,5,6,7,8],runs});
  assert.deepEqual(panel.counts,{pass:0,fail:1,unknown:7,total:8});
  assert.equal(panel.candidate8.verdict,'FAIL');
  assert.equal(panel.c13.verdict,'FAIL');
  const incomplete=aggregatePanel({plannedSeeds:[1,2,3,4,5,6,7,8],runs:[
    {seed:1,status:'complete',verdict:'FAIL',quality:'COMPLETE',evidenceRefs:['r1'],safetyViolation:false,founderSurvival10d:.8,collapse:false}]});
  assert.equal(incomplete.candidate8.verdict,'UNKNOWN');
  assert.equal(incomplete.c13.verdict,'UNKNOWN');
  const unreachable=aggregatePanel({plannedSeeds:[1,2,3,4,5,6,7,8],runs:[1,2,3,4].map(seed=>({
    seed,status:'complete' as const,verdict:'FAIL' as const,quality:'COMPLETE' as const,evidenceRefs:[`r${seed}`],safetyViolation:false}))});
  assert.equal(unreachable.candidate8.verdict,'FAIL'); // Four failures make five passes impossible.
});

test('four accredited partial failures make five of eight unreachable without crediting partial passes', () => {
  const runs=[1,2,3,4].map(seed=>({seed,status:'partial' as const,verdict:'FAIL' as const,
    quality:'PARTIAL' as const,evidenceRefs:[`failure-${seed}`]}));
  const result=aggregatePanel({plannedSeeds:[1,2,3,4,5,6,7,8],runs:[...runs,
    {seed:5,status:'partial',verdict:'PASS',quality:'PARTIAL',evidenceRefs:['partial-pass']}]});
  assert.deepEqual(result.counts,{pass:0,fail:4,unknown:4,total:8});
  assert.equal(result.candidate8.verdict,'FAIL');
  assert.equal(result.candidate8.reason,'FIVE_OF_EIGHT_UNREACHABLE');
  const uncredited=aggregatePanel({plannedSeeds:[1,2,3,4,5,6,7,8],runs:[
    {seed:1,status:'partial',verdict:'FAIL',safetyViolation:true,collapse:true}]});
  assert.equal(uncredited.counts.fail,0);
  assert.equal(uncredited.candidate8.verdict,'UNKNOWN');
  assert.equal(uncredited.c13.verdict,'UNKNOWN');
});

test('C12 balanced listed stocks remain UNKNOWN; an explicit protected exclusion is invalid', () => {
  const q={value:1,material:'wood',unit:'quanta',conversionVersion:'v1'};
  const ledger:BalanceLedger={boundary:{scope:'global',includesProtected:true,stockIds:['mortal'],conversionMatrixRef:'m'},
    complete:true,matrices:{m:{version:'v1',entries:[{inputMaterial:'wood',inputUnit:'quanta',outputMaterial:'wood',outputUnit:'quanta',coefficient:1}]}},
    stocks:[{id:'o',stockId:'mortal',phase:'opening',quantity:q,protectedOriginIds:[]},
      {id:'c',stockId:'mortal',phase:'closing',quantity:q,protectedOriginIds:[]}],flows:[]};
  assert.equal(evaluateMaterialBalance(ledger).status,'UNKNOWN');
  const excluded=structuredClone(ledger); excluded.boundary.excludedCompartments=['S/I'];
  assert.equal(evaluateMaterialBalance(excluded).status,'REJECT');
  const omitted=structuredClone(ledger); omitted.stocks.push({id:'s',stockId:'protected-S',phase:'opening',quantity:q,protectedOriginIds:['S']});
  assert.equal(evaluateMaterialBalance(omitted).status,'REJECT');
});

test('C12 absent protected proof remains UNKNOWN rather than inventing false', () => {
  const q={value:1,material:'wood',unit:'quanta',conversionVersion:'v1'};
  const ledger:BalanceLedger={boundary:{scope:'global',stockIds:['s'],conversionMatrixRef:'m'},complete:true,
    matrices:{m:{version:'v1',entries:[{inputMaterial:'wood',inputUnit:'quanta',outputMaterial:'wood',outputUnit:'quanta',coefficient:1}]}},
    stocks:[{id:'o',stockId:'s',phase:'opening',quantity:q,protectedOriginIds:[]},
      {id:'c',stockId:'s',phase:'closing',quantity:q,protectedOriginIds:[]}],flows:[]};
  const absent=evaluateMaterialBalance(ledger);
  assert.equal(absent.status,'UNKNOWN');
  assert.ok(absent.reasons.includes('PROTECTED_INCLUSION_UNKNOWN'));
  assert.equal(evaluateMaterialBalance({...ledger,boundary:{...ledger.boundary,includesProtected:false}}).status,'REJECT');
});

test('local C12 invalidity preserves independently evidenced C23 failure', () => {
  const input:EvaluationInput={contractVersion:'realismo-v3',profileId:'r1-20261003-correction3-provisional',
    profileSha256:THRESHOLD_PROFILE_SHA256,source:'bundle',synthetic:false,coveredCriteria:[],valuesByCriterion:{},
    availableEvidenceIds:['boundary','inventory','manifest','authorization'],
    invalidSubgates:{'C12.balance':{reasons:['ACCREDITED_BOUNDARY_EXCLUSION'],refs:['boundary']}},
    unauthorizedMemory:{refs:['inventory','manifest','authorization'],reason:'OBSERVED_UNAUTHORIZED_MEMORY'}};
  const result=evaluateRealismo(input);
  assert.equal(result.status,'VALID');
  assert.equal(result.criteria.find(c=>c.criterion==='C12')?.quality,'INVALID');
  assert.deepEqual(result.criteria.find(c=>c.criterion==='C12')?.subgates.find(g=>g.id==='C12.balance')?.refs,['boundary']);
  assert.equal(result.criteria.find(c=>c.criterion==='C12')?.verdict,'UNKNOWN');
  assert.equal(result.criteria.find(c=>c.criterion==='C23')?.verdict,'FAIL');
  assert.equal(evaluateRealismo({...input,integrityIssues:['BUNDLE_HASH_INVALID']}).status,'REJECT');
});

test('C23 known rejected incorporation fails without personal receipt; missing inventory stays unknown', () => {
  const h='a'.repeat(64), content='b'.repeat(64);
  const inventory:MemoryEvidence={evidenceId:'inventory',kind:'real-memory-inventory',payload:{
    complete:true,inventoryScope:'all-real-memories-incorporated',contentHash:content,
    entries:[{memoryId:'memory-1',memoryHash:h,incorporatedContentHash:content,incorporated:true,
      incorporationRef:'manifest',authorization:'rejected',authorizationReceiptRef:'authorization'}]}};
  const manifest:MemoryEvidence={evidenceId:'manifest',kind:'component-manifest',payload:{
    components:[{component:'catalogue',itemId:'memory-1',sha256:h,count:1}]}};
  const authorization:MemoryEvidence={evidenceId:'authorization',kind:'memory-authorization',payload:{
    authority:'Steven',memoryId:'memory-1',memoryHash:h,contentHash:content,decision:'rejected',
    at:'2026-10-05T00:00:00Z',localReceiptId:'local-1',provenanceRef:'source'}};
  const catalog=new Map([['manifest',manifest],['authorization',authorization]]);
  const proof=findUnauthorizedMemory(inventory,content,catalog);
  assert.deepEqual(proof?.refs,['inventory','manifest','authorization']);
  assert.deepEqual(findUnauthorizedMemory({...inventory,payload:{...inventory.payload,complete:false}},content,catalog),proof);
  const input:EvaluationInput={contractVersion:'realismo-v3',profileId:'r1-20261003-correction3-provisional',
    profileSha256:THRESHOLD_PROFILE_SHA256,source:'bundle',synthetic:false,coveredCriteria:[],valuesByCriterion:{},
    availableEvidenceIds:['inventory','manifest','authorization'],unauthorizedMemory:proof,personalReceiptVerified:false};
  assert.equal(evaluateRealismo(input).criteria.find(c=>c.criterion==='C23')?.verdict,'FAIL');
  const absent=findUnauthorizedMemory({...inventory,payload:{...inventory.payload,entries:[]}},content,catalog);
  assert.equal(absent,undefined);
  assert.equal(evaluateRealismo({...input,unauthorizedMemory:absent}).criteria.find(c=>c.criterion==='C23')?.verdict,'UNKNOWN');
});

test('C23 current Steven rejection overrides unknown inventory summary and reports discrepancy', () => {
  const h='a'.repeat(64), content='b'.repeat(64);
  const inventory:MemoryEvidence={evidenceId:'inventory',kind:'real-memory-inventory',payload:{
    inventoryScope:'all-real-memories-incorporated',contentHash:content,entries:[]}};
  const manifest:MemoryEvidence={evidenceId:'manifest',kind:'component-manifest',payload:{
    components:[{component:'catalogue',itemId:'memory-1',sha256:h,count:1}]}};
  const authorization:MemoryEvidence={evidenceId:'authorization',kind:'memory-authorization',payload:{
    authority:'Steven',memoryId:'memory-1',memoryHash:h,contentHash:content,decision:'rejected',
    at:'2026-10-05T00:00:00Z',localReceiptId:'local-1',provenanceRef:'source'}};
  const catalog=new Map([['manifest',manifest],['authorization',authorization]]);
  const unknownSummary:MemoryEvidence={...inventory,payload:{...inventory.payload,entries:[{
    memoryId:'memory-1',memoryHash:h,incorporatedContentHash:content,incorporated:true,
    incorporationRef:'manifest',authorization:'unknown',authorizationReceiptRef:'authorization'}]}};
  const stillRejected=findUnauthorizedMemory(unknownSummary,content,catalog);
  assert.equal(stillRejected?.reason,'OBSERVED_UNAUTHORIZED_MEMORY');
  assert.equal(stillRejected?.discrepancy,'INVENTORY_AUTHORIZATION_DISAGREEMENT');
  assert.deepEqual(stillRejected?.refs,['inventory','manifest','authorization']);
  const input:EvaluationInput={contractVersion:'realismo-v3',profileId:'r1-20261003-correction3-provisional',
    profileSha256:THRESHOLD_PROFILE_SHA256,source:'bundle',synthetic:false,coveredCriteria:[],valuesByCriterion:{},
    availableEvidenceIds:['inventory','manifest','authorization'],personalReceiptVerified:false};
  assert.equal(evaluateRealismo({...input,unauthorizedMemory:stillRejected}).criteria.find(c=>c.criterion==='C23')?.verdict,'FAIL');
});
