import type { Verdict } from './realismo-evaluator.js';

export interface PanelRun { seed: number; status: 'complete' | 'partial' | 'aborted' | 'not-started'; verdict: Verdict;
  quality?: 'COMPLETE' | 'PARTIAL' | 'INVALID' | 'UNAVAILABLE'; evidenceRefs?: string[];
  safetyViolation?: boolean; founderSurvival10d?: number; collapse?: boolean }
export interface PanelInput { plannedSeeds: number[]; runs: PanelRun[] }
export interface PanelResult {
  counts: { pass:number; fail:number; unknown:number; total:number };
  descriptive6: { verdict:'DESCRIPTIVE_ONLY' | 'UNKNOWN'; reason:string };
  candidate8: { verdict:Verdict; reason:string; minimumPass:number; safetyViolations:number };
  c13: { medianFounder10d:number|null; collapses:number|null; verdict:Verdict; reason:string };
  issues:string[];
}
const median = (values: number[]): number => { const a=[...values].sort((x,y)=>x-y); const n=a.length; return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2; };

/** Uses the preregistered denominator and only credited producer assertions. */
export function aggregatePanel(input: PanelInput): PanelResult {
  const issues:string[]=[];
  if (!Array.isArray(input.plannedSeeds) || !Array.isArray(input.runs)) throw new TypeError('PANEL_ARRAYS_REQUIRED');
  if (input.plannedSeeds.some(seed=>!Number.isSafeInteger(seed))) issues.push('INVALID_PLANNED_SEED');
  const planned=new Set(input.plannedSeeds);
  if (planned.size!==input.plannedSeeds.length) issues.push('DUPLICATE_PLANNED_SEED');
  const bySeed=new Map<number,PanelRun>();
  for (const run of input.runs) {
    if (!Number.isSafeInteger(run.seed) || !['complete','partial','aborted','not-started'].includes(run.status) ||
        !['PASS','FAIL','UNKNOWN'].includes(run.verdict) ||
        (run.founderSurvival10d!==undefined && (!Number.isFinite(run.founderSurvival10d)||run.founderSurvival10d<0||run.founderSurvival10d>1)) ||
        (run.quality!==undefined && !['COMPLETE','PARTIAL','INVALID','UNAVAILABLE'].includes(run.quality)) ||
        (run.evidenceRefs!==undefined && (!Array.isArray(run.evidenceRefs)||run.evidenceRefs.some(ref=>typeof ref!=='string'||!ref))) ||
        (run.collapse!==undefined && typeof run.collapse!=='boolean') ||
        (run.safetyViolation!==undefined && typeof run.safetyViolation!=='boolean')) issues.push(`INVALID_RUN:${run.seed}`);
    if (!planned.has(run.seed)) issues.push(`UNPLANNED_SEED:${run.seed}`);
    if (bySeed.has(run.seed)) issues.push(`DUPLICATE_RUN:${run.seed}`);
    bySeed.set(run.seed,run);
  }
  const rows=input.plannedSeeds.map(seed=>bySeed.get(seed));
  // The producer supplies quality and evidence refs for each assertion. A
  // partial run can establish a failure, but cannot establish a pass.
  const credited=(run:PanelRun|undefined):run is PanelRun=>!!run &&
    (run.quality==='COMPLETE'||run.quality==='PARTIAL') && !!run.evidenceRefs?.length;
  const state=(run:PanelRun|undefined):Verdict=>!credited(run)?'UNKNOWN':
    run.verdict==='FAIL'?'FAIL':run.status==='complete'&&run.quality==='COMPLETE'&&run.verdict==='PASS'?'PASS':'UNKNOWN';
  const counts={pass:rows.filter(r=>state(r)==='PASS').length,fail:rows.filter(r=>state(r)==='FAIL').length,
    unknown:rows.filter(r=>state(r)==='UNKNOWN').length,total:input.plannedSeeds.length};
  const safetyViolations=rows.filter(r=>credited(r)&&r.safetyViolation===true).length;
  const observedCollapses=rows.filter(r=>credited(r)&&r.collapse===true).length;
  const panel8=issues.length===0 && rows.length===8;
  const full8=issues.length===0 && rows.length===8 && rows.every(r=>credited(r)&&r.status==='complete' && r.quality==='COMPLETE' && state(r)!=='UNKNOWN' && r.safetyViolation===false);
  const majorityImpossible=counts.fail>3;
  const candidate8:{verdict:Verdict;reason:string;minimumPass:number;safetyViolations:number}={
    verdict:panel8 && (safetyViolations>0||majorityImpossible)?'FAIL':full8?'PASS':'UNKNOWN',
    reason:panel8 && safetyViolations>0?'OBSERVED_SAFETY_VIOLATION':panel8 && majorityImpossible?'FIVE_OF_EIGHT_UNREACHABLE':
      full8?'PROVISIONAL_EIGHT_SEED_RULE':'INSUFFICIENT_PANEL',minimumPass:5,safetyViolations};
  const founderValues=rows.map(r=>credited(r)?r.founderSurvival10d:undefined).filter((v):v is number=>typeof v==='number'&&Number.isFinite(v));
  const c13Complete=issues.length===0&&rows.length===8&&rows.every(r=>credited(r)&&r.status==='complete'&&r.quality==='COMPLETE')&&founderValues.length===8&&rows.every(r=>r?.collapse===false);
  const medianFounder10d=c13Complete?median(founderValues):null;
  const collapses=c13Complete?rows.filter(r=>r?.collapse).length:null;
  const c13:{medianFounder10d:number|null;collapses:number|null;verdict:Verdict;reason:string}={medianFounder10d,collapses,
    verdict:panel8&&observedCollapses>0?'FAIL':c13Complete?((medianFounder10d as number)>=.7&&collapses===0?'PASS':'FAIL'):'UNKNOWN',
    reason:panel8&&observedCollapses>0?'OBSERVED_PANEL_COLLAPSE':c13Complete?'MEDIAN_AND_ZERO_OF_EIGHT_SEPARATE':'C13_EIGHT_SEED_EVIDENCE_MISSING'};
  return {counts,descriptive6:{verdict:rows.length===6?'DESCRIPTIVE_ONLY':'UNKNOWN',reason:rows.length===6?'SIX_NOT_EIGHT':'NOT_SIX_SEEDS'},candidate8,c13,issues};
}
