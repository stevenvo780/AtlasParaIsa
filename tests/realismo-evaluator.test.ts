import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateRealismo, evaluateMaterialBalance, type EvaluationInput, type BalanceLedger } from '../scripts/lab/realismo-evaluator.js';
import { aggregatePanel } from '../scripts/lab/realismo-panel.js';

interface OracleCase { id: string; criterion: string; expected: string; changes?: Record<string, number>; missing?: string[]; expectedSubgates?: Record<string, string>; manual: string }
interface OracleFile { bases: Record<string, Record<string, number>>; cases: OracleCase[]; controls: OracleCase[] }
const oracles = JSON.parse(readFileSync('tests/fixtures/realismo/v3/manual-oracles.json', 'utf8')) as OracleFile;
const numeric = JSON.parse(readFileSync('tests/fixtures/realismo/v3/expected-numeric.json','utf8')) as Record<string,Record<string,number|null>>;
const ledgers = JSON.parse(readFileSync('tests/fixtures/realismo/v3/support-ledgers.json','utf8')) as Record<string,unknown>;
function checkNumbers(id:string, result:ReturnType<typeof evaluateRealismo>):void {
  const metrics=result.criteria.flatMap(c=>c.subgates.flatMap(g=>g.metrics));
  for (const [metricId,expected] of Object.entries(numeric[id]??{})) {
    const actual=metrics.find(m=>m.id===metricId);
    assert.ok(actual,`${id}: ${metricId} exists`);
    if(expected===null) assert.equal(actual.value,null,`${id}: ${metricId}`);
    else assert.ok(actual.value!==null && Math.abs(actual.value-expected)<=1e-12,`${id}: ${metricId} expected ${expected}, got ${actual.value}`);
  }
}

function inputFor(row: OracleCase): EvaluationInput {
  const values = { ...oracles.bases[row.criterion], ...row.changes };
  for (const key of row.missing ?? []) delete values[key];
  return { contractVersion: 'realismo-v3', profileId: 'r1-20261003-correction3-provisional',
    profileSha256: 'd99e24ee85f379164c1dd0d351a0cdb204d8bf1dda0e446abd70cfe582e4b7cb',
    source: 'manual-fixture', synthetic: true, valuesByCriterion: { [row.criterion]: values },
    coveredCriteria: [row.criterion], manualCaseId: row.id };
}

test('48 authored cases: three states for each C9–C24, with all subgates present', () => {
  assert.equal(oracles.cases.length, 48);
  for (let n = 9; n <= 24; n++) {
    const rows = oracles.cases.filter(c => c.criterion === `C${n}`);
    assert.equal(rows.length, 3, `C${n}`);
    for (const row of rows) {
      const result = evaluateRealismo(inputFor(row));
      assert.equal(result.status, 'VALID', row.id);
      const criterion = result.criteria.find(c => c.criterion === row.criterion)!;
      assert.equal(criterion.verdict, row.expected, `${row.id}: ${row.manual}`);
      checkNumbers(row.id,result);
      assert.ok(criterion.subgates.length >= 2);
      for (const [id, expected] of Object.entries(row.expectedSubgates ?? {}))
        assert.equal(criterion.subgates.find(g => g.id === id)?.verdict, expected, row.id);
      assert.equal(result.criteria.length, 16);
    }
  }
});

test('eight transverse controls are separate from the 48 designs', () => {
  assert.equal(oracles.controls.length, 8);
  assert.deepEqual(oracles.controls.map(c => c.id), [
    'protected-stock-conservation', 'missing-event-vs-zero', 'zero-events-complete-existential',
    'zero-opportunities-universal', 'six-not-eight-seeds', 'governor-parity',
    'c8-frozen-channel', 'no-evidence-upgrade']);
  for (const row of oracles.controls) {
    const result = evaluateRealismo(inputFor(row));
    // The legacy six-seed oracle described a panel; the replica now reports
    // its own measurements while the separate panel remains insufficient.
    const expected=row.id==='six-not-eight-seeds'?'PASS':row.expected;
    assert.equal(result.criteria.find(c => c.criterion === row.criterion)?.verdict, expected, row.id);
    checkNumbers(row.id,result);
  }
});

test('manual support inventories preserve contemporaneous arms, protected balance and synthetic-only review', () => {
  for (let n=9;n<=24;n++) assert.ok(ledgers[`C${n}`],`C${n} support inventory`);
  for (const criterion of ['C11','C17']) {
    const l=ledgers[criterion] as {manifests:Array<{id:string;reference:number;removal:number;restoration:number}>};
    const treatment=l.manifests.find(x=>x.id==='treatment')!;
    const control=l.manifests.find(x=>x.id==='contemporary-control')!;
    assert.deepEqual([treatment.reference,control.reference,treatment.removal,control.removal,treatment.restoration,control.restoration],[100,100,60,100,90,100]);
    assert.equal(1-treatment.removal/control.removal,.4);
    assert.equal(treatment.restoration/control.restoration,.9);
  }
  const balance=ledgers.C12 as {stocks:Array<{includesProtected:boolean}>;flows:Array<{transferId?:string}>};
  assert.equal(balance.stocks.every(x=>x.includesProtected),true);
  assert.equal(balance.flows.filter(x=>x.transferId==='internal-3').length,2);
  const review=ledgers.C23 as {manifests:Array<{authority?:string;status?:string}>};
  assert.equal(review.manifests[0].authority,'synthetic-oracle');
  assert.equal(review.manifests[1].status,'UNAVAILABLE');
});

test('deleting needed evidence cannot upgrade a FAIL or UNKNOWN to PASS', () => {
  for (const row of oracles.cases) {
    const before = evaluateRealismo(inputFor(row)).criteria.find(c => c.criterion === row.criterion)!;
    for (const key of Object.keys(oracles.bases[row.criterion])) {
      const altered = inputFor(row);
      delete altered.valuesByCriterion[row.criterion][key];
      const after = evaluateRealismo(altered).criteria.find(c => c.criterion === row.criterion)!;
      if (before.verdict !== 'PASS') assert.notEqual(after.verdict, 'PASS', `${row.id} removing ${key}`);
    }
  }
});

test('numeric boundaries, causal support and distinct UNKNOWN quality', () => {
  const c10 = inputFor(oracles.cases.find(c => c.id === 'C10-pass-01')!);
  c10.valuesByCriterion.C10.conditionAtService = 0.1;
  c10.valuesByCriterion.C10.functionalServicesAtCutoff = 1;
  assert.equal(evaluateRealismo(c10).criteria.find(c => c.criterion === 'C10')?.verdict, 'FAIL');
  const c12 = inputFor(oracles.cases.find(c => c.id === 'C12-pass-01')!);
  c12.valuesByCriterion.C12.normalizedLoss += 1e-9;
  assert.equal(evaluateRealismo(c12).criteria.find(c => c.criterion === 'C12')?.verdict, 'PASS');
  c12.valuesByCriterion.C12.normalizedLoss += 1e-9;
  assert.equal(evaluateRealismo(c12).criteria.find(c => c.criterion === 'C12')?.verdict, 'FAIL');
  const c9=inputFor(oracles.cases.find(c=>c.id==='C9-pass-01')!);
  c9.valuesByCriterion.C9.workAblated=90;
  assert.equal(evaluateRealismo(c9).criteria.find(c=>c.criterion==='C9')?.subgates.find(g=>g.id==='C9.marginal')?.verdict,'PASS');
  c9.valuesByCriterion.C9.workAblated=91;
  assert.equal(evaluateRealismo(c9).criteria.find(c=>c.criterion==='C9')?.subgates.find(g=>g.id==='C9.marginal')?.verdict,'FAIL');
  const c16=inputFor(oracles.cases.find(c=>c.id==='C16-pass-01')!);
  c16.valuesByCriterion.C16.migrantsTreatment=3;
  assert.equal(evaluateRealismo(c16).criteria.find(c=>c.criterion==='C16')?.verdict,'FAIL');
  const c18=inputFor(oracles.cases.find(c=>c.id==='C18-pass-01')!);
  c18.valuesByCriterion.C18.treatmentEpisodes=19;
  assert.equal(evaluateRealismo(c18).criteria.find(c=>c.criterion==='C18')?.verdict,'UNKNOWN');
});

test('C10 valid cutoff contradiction survives C9 missing baseline; stage gates stay separate', () => {
  const c10=inputFor(oracles.cases.find(c=>c.id==='C10-fail-01')!);
  const result=evaluateRealismo(c10);
  assert.equal(result.criteria.find(c=>c.criterion==='C10')?.verdict,'FAIL');
  assert.equal(result.criteria.find(c=>c.criterion==='C9')?.verdict,'UNKNOWN');
  const c24=inputFor(oracles.cases.find(c=>c.id==='C24-unknown-01')!);
  const stages=evaluateRealismo(c24).criteria.find(c=>c.criterion==='C24')!.subgates;
  assert.equal(stages.find(g=>g.id==='C24.method')?.verdict,'PASS');
  assert.equal(stages.find(g=>g.id==='C24.training')?.verdict,'UNKNOWN');
  assert.equal(stages.find(g=>g.id==='C24.final')?.verdict,'UNKNOWN');
});

test('unsupported versions and contradictory inputs are separate from scientific FAIL', () => {
  const x=inputFor(oracles.cases[0]);
  assert.equal(evaluateRealismo({...x,profileSha256:'bad'}).status,'UNSUPPORTED');
  assert.equal(evaluateRealismo({...x,valuesByCriterion:{C9:{...x.valuesByCriterion.C9,activeDays:Infinity}}}).status,'REJECT');
  assert.equal(evaluateRealismo({...x,coveredCriteria:['C9','C9']}).status,'REJECT');
  assert.equal(evaluateRealismo({...x,integrityIssues:['PARTIAL_COMMIT_CONTRADICTION']}).status,'REJECT');
});

test('protected stock is conserved; conversion of every projection precedes transfer deduplication', () => {
  const quantity=(value:number)=>({value,material:'wood',unit:'quanta',conversionVersion:'v1'});
  const ledger:BalanceLedger={boundary:{scope:'global',includesProtected:true,stockIds:['protected-S','mortal'],conversionMatrixRef:'matrix'},complete:true,
    matrices:{matrix:{version:'v1',entries:[{inputMaterial:'wood',inputUnit:'quanta',outputMaterial:'wood',outputUnit:'quanta',coefficient:1}]}},
    stocks:[{id:'open',stockId:'protected-S',phase:'opening',quantity:quantity(10),protectedOriginIds:['S']},
      {id:'close',stockId:'protected-S',phase:'closing',quantity:quantity(5),protectedOriginIds:['S']},
      {id:'mortal-open',stockId:'mortal',phase:'opening',quantity:quantity(0),protectedOriginIds:[]},
      {id:'mortal-close',stockId:'mortal',phase:'closing',quantity:quantity(0),protectedOriginIds:[]}],
    flows:[{id:'in',transferId:'in',flowType:'external-in',quantity:quantity(2),conversionRef:null},
      {id:'use',transferId:'use',flowType:'consumption',quantity:quantity(4),conversionRef:null},
      {id:'waste',transferId:'waste',flowType:'external-out',quantity:quantity(1),conversionRef:null},
      {id:'loss',transferId:'loss',flowType:'loss',quantity:quantity(2),conversionRef:null},
      {id:'internal-a',transferId:'internal-3',flowType:'internal',quantity:quantity(3),conversionRef:null,
        fromStockId:'protected-S',toStockId:'mortal',counterpartRecordId:'internal-b'},
      {id:'internal-b',transferId:'internal-3',flowType:'internal',quantity:quantity(3),conversionRef:null,
        fromStockId:'protected-S',toStockId:'mortal',counterpartRecordId:'internal-a'}]};
  const balance=evaluateMaterialBalance(ledger);
  assert.equal(balance.status,'UNKNOWN'); // Arithmetic alone cannot accredit the global stock inventory.
  assert.ok(balance.reasons.includes('GLOBAL_INVENTORY_NOT_ACCREDITED'));
  const missing=structuredClone(ledger); missing.flows[5].conversionRef='absent';
  assert.equal(evaluateMaterialBalance(missing).status,'UNKNOWN');
  const mismatched=structuredClone(ledger); mismatched.flows[5].quantity.value=4;
  assert.equal(evaluateMaterialBalance(mismatched).status,'REJECT');
  const oneEnd=structuredClone(ledger); oneEnd.flows.pop();
  assert.equal(evaluateMaterialBalance(oneEnd).status,'UNKNOWN');
  const wrongCounterpart=structuredClone(ledger); wrongCounterpart.flows[5].counterpartRecordId='different';
  assert.equal(evaluateMaterialBalance(wrongCounterpart).status,'REJECT');
  const partialContradiction=structuredClone(mismatched); partialContradiction.complete=false;
  assert.equal(evaluateMaterialBalance(partialContradiction).status,'REJECT');
});

test('unverified bundle pointers never certify numeric gates', () => {
  const manual=inputFor(oracles.cases.find(c=>c.id==='C9-pass-01')!);
  const bundle:EvaluationInput={...manual,source:'bundle',synthetic:false,sourceRefs:{C9:{activeDays:['r']}},
    availableEvidenceIds:['r'],coveredCriteria:['C9']};
  const result=evaluateRealismo(bundle);
  assert.equal(result.status,'VALID');
  assert.equal(result.criteria.find(c=>c.criterion==='C9')?.verdict,'UNKNOWN');
  assert.ok(result.unknowns.includes('OPERAND_DERIVATION_UNVERIFIED'));
});

test('a measured slower backend may be declined without inventing a saving', () => {
  const input=inputFor(oracles.cases.find(c=>c.id==='C22-pass-01')!);
  input.valuesByCriterion.C22.backendCompleteCost=110;
  input.valuesByCriterion.C22.backendAdopted=0;
  const result=evaluateRealismo(input).criteria.find(c=>c.criterion==='C22')!;
  assert.equal(result.verdict,'PASS');
  const saving=result.subgates.flatMap(g=>g.metrics).find(m=>m.id==='C22.completeSaving')!;
  assert.equal(saving.value,-.1);
  assert.equal(saving.verdict,'PASS');
});

test('panel counts all planned seeds and separates six descriptive from provisional eight', () => {
  const result = aggregatePanel({ plannedSeeds: [1,2,3,4,5,6], runs: [
    { seed: 1, status: 'complete', verdict: 'PASS', quality:'COMPLETE', evidenceRefs:['r1'] },
    { seed: 2, status: 'complete', verdict: 'PASS', quality:'COMPLETE', evidenceRefs:['r2'] },
    { seed: 3, status: 'complete', verdict: 'PASS', quality:'COMPLETE', evidenceRefs:['r3'] },
    { seed: 4, status: 'complete', verdict: 'PASS', quality:'COMPLETE', evidenceRefs:['r4'] },
    { seed: 5, status: 'complete', verdict: 'PASS', quality:'COMPLETE', evidenceRefs:['r5'] },
    { seed: 6, status: 'aborted', verdict: 'UNKNOWN' }] });
  assert.deepEqual(result.counts, { pass: 5, fail: 0, unknown: 1, total: 6 });
  assert.equal(result.candidate8.verdict, 'UNKNOWN');
  const eight=aggregatePanel({plannedSeeds:[1,2,3,4,5,6,7,8],runs:[1,2,3,4,5,6,7,8].map(seed=>({
    seed,status:'complete' as const,verdict:seed<=5?'PASS' as const:'FAIL' as const,quality:'COMPLETE' as const,evidenceRefs:[`r${seed}`],safetyViolation:false,
    founderSurvival10d:seed<=4 ? 0.7 : 0.8,collapse:false}))});
  assert.equal(eight.candidate8.verdict,'PASS');
  assert.equal(eight.c13.medianFounder10d,.75);
  assert.equal(eight.c13.collapses,0);
  assert.equal(eight.c13.verdict,'PASS');
  const c13Only=aggregatePanel({plannedSeeds:[1,2,3,4,5,6,7,8],runs:[1,2,3,4,5,6,7,8].map(seed=>({
    seed,status:'complete' as const,verdict:'UNKNOWN' as const,quality:'COMPLETE' as const,evidenceRefs:[`r${seed}`],
    founderSurvival10d:seed<=4?0.7:0.8,collapse:false}))});
  assert.equal(c13Only.candidate8.verdict,'UNKNOWN');
  assert.equal(c13Only.c13.verdict,'PASS');
  const invalid=aggregatePanel({plannedSeeds:[1,1,2,3,4,5,6,7],runs:[]});
  assert.ok(invalid.issues.includes('DUPLICATE_PLANNED_SEED'));
  assert.equal(invalid.candidate8.verdict,'UNKNOWN');
});
