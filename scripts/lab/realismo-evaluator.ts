/** Offline arithmetic for the sealed provisional profile. No world, clock, RNG or runner. */
import { CONTRACT_VERSION, THRESHOLD_PROFILE_SHA256 } from './realismo-contract.js';

export type Verdict = 'PASS' | 'FAIL' | 'UNKNOWN';
export type EvaluationStatus = 'VALID' | 'REJECT' | 'UNSUPPORTED';
export interface EvaluationInput {
  contractVersion: string;
  profileId: string;
  profileSha256: string;
  source: 'manual-fixture' | 'bundle';
  synthetic: boolean;
  valuesByCriterion: Record<string, Record<string, number>>;
  coveredCriteria: string[];
  coveredMetrics?: string[];
  metricOverrides?: Record<string,{value:number;refs:string[];reason:string}>;
  manualCaseId?: string;
  /** For bundle inputs, every operand must point to existing validated catalog/record IDs. */
  sourceRefs?: Record<string, Record<string, string[]>>;
  availableEvidenceIds?: string[];
  unknownReasons?: string[];
  integrityIssues?: string[];
  /** Invalid evidence is confined to the affected subgate. */
  invalidSubgates?: Record<string,{reasons:string[];refs:string[]}>;
  personalReceiptVerified?: boolean;
  /** Only an independently reconciled inventory/manifests/authorization chain may set this. */
  unauthorizedMemory?: { refs:string[]; reason:string };
  finalPhaseReceiptVerified?: boolean;
}
export interface MetricResult { id: string; value: number | null; verdict: Verdict; threshold: number | null; reason: string; refs: string[]; diagnostic: boolean }
export interface SubgateResult { id: string; verdict: Verdict; metrics: MetricResult[]; reasons: string[]; refs:string[]; quality: 'COMPLETE' | 'PARTIAL' | 'INVALID' | 'UNAVAILABLE' }
export interface CriterionResult { criterion: string; verdict: Verdict; subgates: SubgateResult[]; quality: 'COMPLETE' | 'PARTIAL' | 'INVALID' | 'UNAVAILABLE'; reasons: string[] }
export interface EvaluationResult { contractVersion: typeof CONTRACT_VERSION; profileId: string; profileSha256: string; status: EvaluationStatus; criteria: CriterionResult[]; issues: string[]; unknowns: string[]; synthetic: boolean }

export const PROFILE_ID = 'r1-20261003-correction3-provisional' as const;
const ids = Array.from({ length: 16 }, (_, i) => `C${i + 9}`);
type Formula = { id: string; gate: string; threshold: number; compare: 'ge' | 'le' | 'eq' | 'lt' | 'gt'; args: string[]; calc: (v: Record<string, number>) => number | undefined; evidence?: 'causal' | 'personal' | 'final'; diagnostic?: boolean };
const f = (id: string, gate: string, threshold: number, compare: Formula['compare'], args: string[], calc: Formula['calc'], evidence?: Formula['evidence']): Formula => ({ id, gate, threshold, compare, args, calc, evidence });
const direct = (id: string, gate: string, arg: string, threshold: number, compare: Formula['compare']): Formula => f(id, gate, threshold, compare, [arg], v => v[arg]);
const ratio = (a: number, b: number): number | undefined => b === 0 ? undefined : a / b;
const drop = (a: number, b: number): number | undefined => b === 0 ? undefined : (b - a) / b;
const subtract = (...n: number[]): number => n.slice(1).reduce((x, y) => x - y, n[0]);

/* Each profile measure is bound to a named, explicit arithmetic formula. The documentary
   expression strings in thresholds.v3.json are never evaluated. */
const formulas: Formula[] = [
  direct('C9.eligibleActiveDays','C9.service','activeDays',10,'ge'),
  direct('C9.usefulMortalServices','C9.service','usefulServices',1,'ge'),
  f('C9.opportunities','C9.service',1,'ge',['eligibleOpportunities'],v=>v.eligibleOpportunities===0?undefined:v.eligibleOpportunities),
  { ...f('C9.unusedAlarm','C9.service',.3,'gt',['unusedStructures','totalStructures'],v=>ratio(v.unusedStructures,v.totalStructures)), diagnostic:true },
  f('C9.workSaving','C9.marginal',.1,'ge',['workBase','workAblated'],v=>drop(v.workAblated,v.workBase),'causal'),
  f('C9.serviceDrop','C9.marginal',.05,'le',['serviceBase','serviceAblated'],v=>drop(v.serviceAblated,v.serviceBase),'causal'),
  direct('C10.activeDays','C10.wear','activeDays',20,'ge'),
  f('C10.conditionError','C10.wear',1e-9,'le',['conditionObserved','conditionReplay'],v=>Math.abs(v.conditionObserved-v.conditionReplay),'causal'),
  f('C10.functionalCutoff','C10.wear',0,'eq',['conditionAtService','functionalServicesAtCutoff'],v=>v.conditionAtService<=.1?v.functionalServicesAtCutoff:0,'causal'),
  direct('C10.repairWork','C10.repair','repairWork',30,'eq'),
  direct('C10.repairWood','C10.repair','repairWood',1,'eq'),
  f('C10.repairIncrease','C10.repair',.4,'le',['repairBefore','repairAfter'],v=>v.repairAfter-v.repairBefore),
  direct('C10.paidUsefulRepairs','C10.repair','paidUsefulRepairs',1,'ge'),
  direct('C11.completeReplacements','C11.replacement','replacements',3,'ge'),
  direct('C11.indispensableFunctions','C11.replacement','functions',2,'ge'),
  direct('C11.openingStock','C11.replacement','openingStock',0,'ge'),
  direct('C11.closingStock','C11.replacement','closingStock',0,'ge'),
  direct('C11.replacementFlows','C11.replacement','replacementFlows',3,'ge'),
  direct('C11.protectedSuppliers','C11.autonomy','protectedSuppliers',0,'eq'),
  direct('C11.contemporaryPairs','C11.supplier','contemporaryPairs',1,'ge'),
  f('C11.removalDrop','C11.supplier',.2,'ge',['treatmentRemoval','controlRemoval'],v=>drop(v.treatmentRemoval,v.controlRemoval),'causal'),
  f('C11.restoration','C11.supplier',.8,'ge',['treatmentRestoration','controlRestoration'],v=>ratio(v.treatmentRestoration,v.controlRestoration),'causal'),
  f('C12.integerResidual','C12.balance',0,'eq',['opening','externalInput','regeneration','conversionNet','closing','externalOut','consumption','loss'],v=>subtract(v.opening+v.externalInput+v.regeneration+v.conversionNet,v.closing,v.externalOut,v.consumption,v.loss)),
  f('C12.normalizedResidualAbs','C12.balance',1e-9,'le',['normalizedOpening','normalizedInput','normalizedClosing','normalizedOut','normalizedConsumption','normalizedLoss'],v=>Math.abs(subtract(v.normalizedOpening+v.normalizedInput,v.normalizedClosing,v.normalizedOut,v.normalizedConsumption,v.normalizedLoss))),
  direct('C12.freeRelief','C12.relief','freeRelief',0,'eq'),
  direct('C12.fillTransportUtility','C12.relief','fillTransportUtility',0,'eq'),
  f('C13.founderLoss2d','C13.founders',.5,'le',['founders','alive2d'],v=>ratio(v.founders-v.alive2d,v.founders)),
  { ...f('C13.founderMedian10d','C13.founders',.7,'ge',['founders','alive10d'],v=>ratio(v.alive10d,v.founders)), diagnostic:true },
  { ...f('C13.panelCollapses','C13.founders',0,'eq',['panelSeeds','panelCollapses'],v=>v.panelSeeds===8?v.panelCollapses:undefined), diagnostic:true },
  f('C13.historyCoverage','C13.history',1,'eq',['deaths','deathsWithHistory'],v=>ratio(v.deathsWithHistory,v.deaths)),
  f('C13.earlyDeathMultiplier','C13.early-mortality',1.1,'le',['shortLives','eligibleBirths','controlShortLives','controlEligibleBirths'],v=>{const a=ratio(v.shortLives,v.eligibleBirths),b=ratio(v.controlShortLives,v.controlEligibleBirths);return a===0&&b===0?0:a===undefined||b===undefined?undefined:ratio(a,b);}),
  direct('C14.preselectedTechniques','C14.transmission','preselected',3,'ge'),
  direct('C14.humanTurnovers','C14.transmission','turnovers',2,'ge'),
  f('C14.retainedFraction','C14.transmission',2/3,'ge',['retained','preselected'],v=>ratio(v.retained,v.preselected)),
  direct('C14.lossObserved','C14.loss','lossObserved',1,'ge'),
  direct('C14.paidRediscoveries','C14.rediscovery','paidRediscoveries',1,'ge'),
  direct('C14.manufactureWithoutLearning','C14.rediscovery','manufactureWithoutLearning',0,'eq'),
  direct('C15.newUsefulFunctions','C15.functional-novelty','newFunctions',3,'ge'),
  direct('C15.usesEach','C15.functional-novelty','minimumUses',5,'ge'),
  direct('C15.mortalsEach','C15.functional-novelty','minimumMortals',2,'ge'),
  f('C15.propertyDrop','C15.property',.1,'ge',['propertyBase','propertyAblated'],v=>drop(v.propertyAblated,v.propertyBase),'causal'),
  direct('C15.programs','C15.archive','programs',257,'ge'),
  direct('C15.techGenerations','C15.archive','generations',33,'ge'),
  direct('C15.brokenReferences','C15.archive','brokenReferences',0,'eq'),
  f('C16.depletion','C16.migration',.8,'ge',['sourceOpening','sourceClosing'],v=>drop(v.sourceClosing,v.sourceOpening)),
  f('C16.migrantDifference','C16.migration',20,'ge',['migrantsTreatment','exposedTreatment','migrantsControl','exposedControl'],v=>{const a=ratio(v.migrantsTreatment,v.exposedTreatment),b=ratio(v.migrantsControl,v.exposedControl);return a===undefined||b===undefined?undefined:100*(a-b);}),
  direct('C16.destinationDays','C16.migration','destinationDays',3,'ge'),
  direct('C16.contrastDays','C16.migration','contrastDays',10,'eq'),
  direct('C16.viableDestination','C16.migration','viableDestination',1,'eq'),
  direct('C16.paidTrajectory','C16.locality','paidTrajectory',1,'eq'),
  direct('C16.destinationConsumption','C16.locality','destinationConsumption',1,'eq'),
  direct('C16.teleports','C16.locality','teleports',0,'eq'),
  direct('C16.abandonmentDays','C16.abandonment','abandonmentDays',10,'ge'),
  direct('C16.abandonedPlaces','C16.abandonment','abandonedPlaces',1,'ge'),
  direct('C17.roles','C17.roles','roles',2,'ge'),
  direct('C17.deliveriesEach','C17.roles','minimumDeliveries',10,'ge'),
  f('C17.specialization','C17.roles',.2,'ge',['roleRate','peerRate'],v=>ratio(v.roleRate-v.peerRate,v.peerRate)),
  direct('C17.contemporaryPairs','C17.supplier','contemporaryPairs',1,'ge'),
  f('C17.removalDrop','C17.supplier',.2,'ge',['treatmentRemoval','controlRemoval'],v=>drop(v.treatmentRemoval,v.controlRemoval),'causal'),
  f('C17.restoration','C17.supplier',.8,'ge',['treatmentRestoration','controlRestoration'],v=>ratio(v.treatmentRestoration,v.controlRestoration),'causal'),
  direct('C17.revisedInstitutions','C17.institution','revisedInstitutions',1,'ge'),
  f('C18.triggerCoverage','C18.integrity',1,'eq',['triggered','episodes'],v=>ratio(v.triggered,v.episodes)),
  direct('C18.freeResources','C18.integrity','freeResources',0,'eq'),
  direct('C18.winnerConsumed','C18.integrity','winnerConsumed',1,'eq'),
  f('C18.episodesEachArm','C18.agreement-effect',20,'ge',['treatmentEpisodes','controlEpisodes'],v=>Math.min(v.treatmentEpisodes,v.controlEpisodes)>=20?Math.min(v.treatmentEpisodes,v.controlEpisodes):undefined),
  f('C18.recurrenceDrop','C18.agreement-effect',.2,'ge',['treatmentRecurrences','treatmentEpisodes','controlRecurrences','controlEpisodes'],v=>{if(v.treatmentEpisodes<20||v.controlEpisodes<20)return undefined;const a=ratio(v.treatmentRecurrences,v.treatmentEpisodes),b=ratio(v.controlRecurrences,v.controlEpisodes);return a===undefined||b===undefined?undefined:drop(a,b);},'causal'),
  direct('C18.followupDays','C18.agreement-effect','followupDays',1,'eq'),
  f('C19.ecologyBalance','C19.ecology-balance',0,'eq',['ecologyOpening','births','immigration','deaths','emigration','ecologyClosing'],v=>v.ecologyOpening+v.births+v.immigration-v.deaths-v.emigration-v.ecologyClosing),
  direct('C19.unbalancedTransfers','C19.ecology-balance','unbalancedTransfers',0,'eq'),
  direct('C19.doubleDeaths','C19.ecology-balance','doubleDeaths',0,'eq'),
  direct('C19.cameraDigestDifferences','C19.camera-parity','digestDifferences',0,'eq'),
  direct('C19.remoteRegions','C19.remote-advance','remoteRegions',4,'ge'),
  direct('C19.remoteDays','C19.remote-advance','remoteDays',10,'ge'),
  direct('C19.transitionsEachRegion','C19.remote-advance','minimumTransitions',1,'ge'),
  direct('C20.globalSoftwareRejections','C20.no-software-limit','globalSoftwareRejections',0,'eq'),
  f('C20.measuredStoppingReasons','C20.rejection-attribution',1,'eq',['measuredStops','allStops'],v=>ratio(v.measuredStops,v.allStops)),
  direct('C20.longWindowDays','C20.capacity','longWindowDays',100,'ge'),
  direct('C20.governorInputsComplete','C20.capacity','governorInputsComplete',1,'eq'),
  direct('C20.parityDifferences','C20.capacity','parityDifferences',0,'eq'),
  direct('C21.clients','C21.shared-world','clients',12,'ge'),
  direct('C21.worldClockDifferences','C21.shared-world','worldClockDifferences',0,'eq'),
  direct('C21.realSeconds','C21.durable-recovery','realSeconds',3600,'ge'),
  f('C21.faultsEachCommitPhase','C21.durable-recovery',10,'ge',['faultsBefore','faultsAfter'],v=>Math.min(v.faultsBefore,v.faultsAfter)),
  direct('C21.durableLosses','C21.durable-recovery','durableLosses',0,'eq'),
  direct('C21.adoptedCommitsComplete','C21.durable-recovery','adoptedCommitsComplete',1,'eq'),
  direct('C21.archiveVersionsComplete','C21.version-archive','archiveVersionsComplete',1,'eq'),
  direct('C22.paritySeeds','C22.tick-parity','paritySeeds',6,'ge'),
  direct('C22.parityStepsEach','C22.tick-parity','parityStepsEach',1200,'ge'),
  direct('C22.physicalDifferences','C22.tick-parity','physicalDifferences',0,'eq'),
  direct('C22.realSeconds','C22.host-capacity','realSeconds',1800,'ge'),
  direct('C22.warmupSeconds','C22.host-capacity','warmupSeconds',60,'ge'),
  direct('C22.p95At32','C22.host-capacity','p95At32',50,'lt'),
  direct('C22.stateAt32','C22.host-capacity','stateAt32',122880,'lt'),
  direct('C22.desktopFPS32','C22.host-capacity','desktopFPS32',55,'ge'),
  direct('C22.hostSceneComplete','C22.host-capacity','hostSceneComplete',1,'eq'),
  f('C22.completeSaving','C22.complete-cost',.1,'ge',['cpuCompleteCost','backendCompleteCost','backendAdopted'],v=>drop(v.backendCompleteCost,v.cpuCompleteCost)),
  f('C22.backendDecision','C22.backend-selection',1,'eq',['cpuCompleteCost','backendCompleteCost','backendAdopted'],v=>{
    const saving=drop(v.backendCompleteCost,v.cpuCompleteCost);
    return saving===undefined?undefined:Number((saving>=.1) === (v.backendAdopted===1));
  }),
  direct('C23.memoryPairs','C23.synthetic-agency','memoryPairs',3,'ge'),
  direct('C23.encounterPairs','C23.synthetic-agency','encounterPairs',1,'ge'),
  direct('C23.syntheticOracle','C23.synthetic-agency','syntheticOracle',1,'eq'),
  f('C23.tasksEachDevice','C23.device-tasks',10,'ge',['keyboardTasks','phoneTasks'],v=>Math.min(v.keyboardTasks,v.phoneTasks)),
  f('C23.realSecondsEachDevice','C23.device-tasks',1800,'ge',['keyboardSeconds','phoneSeconds'],v=>Math.min(v.keyboardSeconds,v.phoneSeconds)),
  direct('C23.criticalBlockers','C23.device-tasks','criticalBlockers',0,'eq'),
  direct('C23.physicalPhone','C23.device-tasks','physicalPhone',1,'eq'),
  f('C23.reviewedRealMemories','C23.personal-review',1,'eq',['authorizedMemories','incorporatedMemories'],v=>ratio(v.authorizedMemories,v.incorporatedMemories),'personal'),
  f('C23.inspectorsConform','C23.personal-review',1,'eq',['inspectorsConform','inspectorsReviewed'],v=>ratio(v.inspectorsConform,v.inspectorsReviewed),'personal'),
  f('C24.runMetadataCoverage','C24.method',1,'eq',['documentedRuns','plannedRuns'],v=>ratio(v.documentedRuns,v.plannedRuns)),
  direct('C24.hiddenInterventions','C24.method','hiddenInterventions',0,'eq'),
  direct('C24.preregistered','C24.method','preregistered',1,'eq'),
  direct('C24.reservedTrainingSeeds','C24.training','reservedSeeds',8,'eq'),
  direct('C24.selectors','C24.training','selectors',3,'eq'),
  direct('C24.learningArms','C24.training','learningArms',2,'eq'),
  direct('C24.trainingDays','C24.training','trainingDays',60,'ge'),
  direct('C24.trainingExecuted','C24.training','trainingExecuted',1,'eq'),
  f('C24.usefulImprovement','C24.training',.1,'ge',['learnedUsefulService','controlUsefulService'],v=>ratio(v.learnedUsefulService-v.controlUsefulService,v.controlUsefulService)),
  direct('C24.emptyConstructionReward','C24.training','emptyConstructionReward',0,'eq'),
  direct('C24.priorGate','C24.final','priorGate',1,'eq'),
  direct('C24.frozenC1C8Deteriorations','C24.final','frozenC1C8Deteriorations',0,'eq'),
  f('C24.finalReceipt','C24.final',1,'eq',[],()=>1,'final'),
];

const subgates: Record<string, string[]> = {
  C9:['service','marginal'], C10:['wear','repair'], C11:['replacement','autonomy','supplier'], C12:['balance','relief'],
  C13:['founders','history','early-mortality'], C14:['transmission','loss','rediscovery'], C15:['functional-novelty','property','archive'],
  C16:['migration','locality','abandonment'], C17:['roles','supplier','institution'], C18:['integrity','agreement-effect'],
  C19:['ecology-balance','camera-parity','remote-advance'], C20:['rejection-attribution','no-software-limit','capacity'],
  C21:['shared-world','durable-recovery','version-archive'], C22:['tick-parity','host-capacity','complete-cost','backend-selection'],
  C23:['synthetic-agency','device-tasks','personal-review'], C24:['method','training','final'],
};
const aggregate = (states: Verdict[]): Verdict => states.includes('FAIL') ? 'FAIL' : states.includes('UNKNOWN') ? 'UNKNOWN' : 'PASS';
const close = (a: number,b: number): boolean => Math.abs(a-b) <= 1e-12*Math.max(1,Math.abs(a),Math.abs(b));
function compare(value: number, threshold: number, op: Formula['compare']): boolean {
  return op==='ge' ? value > threshold || close(value,threshold) : op==='le' ? value < threshold || close(value,threshold)
    : op==='eq' ? close(value,threshold) : op==='gt' ? value > threshold && !close(value,threshold) : value < threshold && !close(value,threshold);
}
function metric(formula: Formula, criterion: string, input: EvaluationInput): MetricResult {
  if (formula.id==='C23.reviewedRealMemories' && input.unauthorizedMemory)
    return {id:formula.id,value:null,verdict:'FAIL',threshold:formula.threshold,
      reason:input.unauthorizedMemory.reason,refs:input.unauthorizedMemory.refs,diagnostic:false};
  const override=input.source==='bundle'?input.metricOverrides?.[formula.id]:undefined;
  if (override) return {id:formula.id,value:override.value,
    verdict:formula.id==='C13.founderMedian10d'||formula.id==='C13.panelCollapses'?'UNKNOWN':compare(override.value,formula.threshold,formula.compare)?'PASS':'FAIL',
    threshold:formula.threshold,reason:formula.id==='C13.founderMedian10d'||formula.id==='C13.panelCollapses'?'PANEL_ONLY_DESCRIPTIVE_REPLICA':override.reason,
    refs:override.refs,diagnostic:formula.diagnostic===true};
  const values = input.valuesByCriterion[criterion] ?? {};
  const refs = [...new Set(formula.args.flatMap(arg => input.sourceRefs?.[criterion]?.[arg] ?? []))];
  let reason = '';
  if (!input.coveredCriteria.includes(criterion) && !input.coveredMetrics?.includes(formula.id)) reason = 'COVERAGE_UNAVAILABLE';
  // A request-supplied JSON pointer is an operand proposal, not a certified
  // derivation from the complete event/cohort/flow ledger. Only internally
  // reconciled bundle overrides may produce a numeric verdict here.
  else if (input.source==='bundle') reason = 'OPERAND_DERIVATION_UNVERIFIED';
  else if (formula.id==='C9.usefulMortalServices' && values.eligibleOpportunities===0) reason = 'NO_ELIGIBLE_OPPORTUNITIES';
  else if (formula.args.some(arg => !Object.hasOwn(values,arg))) reason = 'MISSING_OPERAND';
  else if (formula.evidence==='personal' && (input.synthetic || !input.personalReceiptVerified)) reason = 'PERSONAL_RECEIPT_UNAVAILABLE';
  else if (formula.evidence==='final' && (input.synthetic || !input.finalPhaseReceiptVerified)) reason = 'FINAL_ACCEPTANCE_UNAVAILABLE';
  else if (criterion==='C24' && formula.gate==='C24.training' && values.trainingExecuted===0) reason = 'TRAINING_NOT_STARTED';
  if (reason) return { id:formula.id,value:null,verdict:'UNKNOWN',threshold:formula.threshold,reason,refs,diagnostic:formula.diagnostic===true };
  const value = formula.calc(values);
  if (value===undefined || !Number.isFinite(value)) return { id:formula.id,value:null,verdict:'UNKNOWN',threshold:formula.threshold,reason:'ZERO_REFERENCE_OR_INSUFFICIENT_EXPOSURE',refs,diagnostic:formula.diagnostic===true };
  if (formula.id==='C13.founderMedian10d' || formula.id==='C13.panelCollapses')
    return {id:formula.id,value,verdict:'UNKNOWN',threshold:formula.threshold,reason:'PANEL_ONLY_DESCRIPTIVE_REPLICA',refs,diagnostic:true};
  if (formula.id==='C22.completeSaving' && values.backendAdopted===0)
    return {id:formula.id,value,verdict:'PASS',threshold:formula.threshold,reason:'MEASURED_BACKEND_DECLINED',refs,diagnostic:false};
  return { id:formula.id,value,verdict:compare(value,formula.threshold,formula.compare)?'PASS':'FAIL',threshold:formula.threshold,reason:'NUMERIC_COMPARISON',refs,diagnostic:formula.diagnostic===true };
}

export function evaluateRealismo(input: EvaluationInput): EvaluationResult {
  const issues: string[] = [];
  const unsupported = input.contractVersion!==CONTRACT_VERSION || input.profileId!==PROFILE_ID || input.profileSha256!==THRESHOLD_PROFILE_SHA256;
  if (!unsupported) {
    if (input.source!=='manual-fixture' && input.source!=='bundle') issues.push('SOURCE_KIND');
    if (input.source==='manual-fixture' && !input.synthetic) issues.push('MANUAL_FIXTURE_MUST_BE_SYNTHETIC');
    if (!Array.isArray(input.coveredCriteria) || input.coveredCriteria.some(x=>typeof x!=='string'||!ids.includes(x)) || new Set(input.coveredCriteria).size!==input.coveredCriteria.length) issues.push('COVERED_CRITERIA_INVALID');
    if (!input.valuesByCriterion || typeof input.valuesByCriterion!=='object' || Array.isArray(input.valuesByCriterion)) issues.push('VALUES_BY_CRITERION_INVALID');
    for (const [criterion,values] of Object.entries(input.valuesByCriterion ?? {})) {
      if (!ids.includes(criterion) || values===null || typeof values!=='object' || Array.isArray(values)) { issues.push(`VALUES_SHAPE:${criterion}`); continue; }
      for (const [key,value] of Object.entries(values)) if (typeof value!=='number' || !Number.isFinite(value) || value<0 || (Number.isInteger(value) && !Number.isSafeInteger(value))) issues.push(`VALUE_INVALID:${criterion}.${key}`);
    }
    for (const [id,override] of Object.entries(input.metricOverrides??{}))
      if (!formulas.some(x=>x.id===id)||!Number.isFinite(override.value)||!Array.isArray(override.refs)||
          (input.source==='bundle'&&override.refs.some(ref=>!input.availableEvidenceIds?.includes(ref)))) issues.push(`METRIC_OVERRIDE_INVALID:${id}`);
    if (input.unauthorizedMemory && (input.source!=='bundle' || !input.unauthorizedMemory.refs.length ||
        input.unauthorizedMemory.refs.some(ref=>!input.availableEvidenceIds?.includes(ref)))) issues.push('UNAUTHORIZED_MEMORY_PROOF_INVALID');
    for (const [gate,issue] of Object.entries(input.invalidSubgates??{}))
      if (!ids.some(criterion=>subgates[criterion].some(name=>gate===`${criterion}.${name}`)) ||
          !issue || !Array.isArray(issue.reasons) || !issue.reasons.length || issue.reasons.some(reason=>typeof reason!=='string'||!reason) ||
          !Array.isArray(issue.refs) || !issue.refs.length || issue.refs.some(ref=>typeof ref!=='string'||!input.availableEvidenceIds?.includes(ref)))
        issues.push(`INVALID_SUBGATE_ISSUE:${gate}`);
    for (const x of input.integrityIssues ?? []) issues.push(`INTEGRITY:${x}`);
  }
  const status: EvaluationStatus = unsupported?'UNSUPPORTED':issues.length?'REJECT':'VALID';
  const criteria = ids.map(criterion => {
    const gates = subgates[criterion].map(name => {
      const id = `${criterion}.${name}`;
      const invalid=status==='VALID'?input.invalidSubgates?.[id]:undefined;
      const metrics = status==='VALID' && !invalid ? formulas.filter(x=>x.gate===id).map(x=>metric(x,criterion,input)) : [];
      const verdict = status==='VALID' && !invalid?aggregate(metrics.filter(x=>!x.diagnostic).map(x=>x.verdict)):'UNKNOWN';
      return { id, verdict, metrics, quality:invalid?'INVALID':status!=='VALID'?'UNAVAILABLE':verdict==='UNKNOWN'?'PARTIAL':'COMPLETE',
        reasons:invalid?invalid.reasons:[...new Set(metrics.filter(x=>!x.diagnostic&&x.verdict!=='PASS').map(x=>x.verdict==='FAIL'?`THRESHOLD_FALSE:${x.id}`:x.reason))],
        refs:invalid?invalid.refs:[...new Set(metrics.flatMap(m=>m.refs))] } satisfies SubgateResult;
    });
    const verdict = status==='VALID'?aggregate(gates.map(g=>g.verdict)):'UNKNOWN';
    const unknown = gates.some(g=>g.verdict==='UNKNOWN');
    return { criterion, verdict, subgates:gates, quality: status!=='VALID'?'UNAVAILABLE':gates.some(g=>g.quality==='INVALID')?'INVALID':!input.coveredCriteria.includes(criterion)&&!gates.some(g=>g.metrics.some(m=>m.verdict!=='UNKNOWN'))?'UNAVAILABLE':unknown?'PARTIAL':'COMPLETE',
      reasons:[...new Set(gates.flatMap(g=>g.reasons))] } satisfies CriterionResult;
  });
  return { contractVersion:CONTRACT_VERSION,profileId:PROFILE_ID,profileSha256:THRESHOLD_PROFILE_SHA256,status,criteria,issues,
    unknowns:[...new Set([...(input.unknownReasons??[]),...criteria.flatMap(c=>c.subgates.flatMap(g=>[...(g.quality==='INVALID'?g.reasons:[]),...g.metrics.filter(m=>m.verdict==='UNKNOWN'&&!m.diagnostic).map(m=>m.reason)]))])],synthetic:input.synthetic };
}

export interface MemoryEvidence { evidenceId:string; kind:string; payload:Record<string,unknown> }
/** A rejected authorization proves a violation only when an actual manifest
 * item matches the incorporated ID/hash and the current content hash. */
export function findUnauthorizedMemory(inventory:MemoryEvidence, currentContentHash:string,
  catalog:ReadonlyMap<string,MemoryEvidence>):{refs:string[];reason:string;discrepancy?:string}|undefined {
  const p=inventory.payload;
  if (inventory.kind!=='real-memory-inventory' ||
      p.inventoryScope!=='all-real-memories-incorporated' || p.contentHash!==currentContentHash ||
      !Array.isArray(p.entries)) return undefined;
  for (const raw of p.entries) {
    if (!raw || typeof raw!=='object' || Array.isArray(raw)) continue;
    const entry=raw as Record<string,unknown>;
    if (entry.incorporated!==true || entry.incorporatedContentHash!==currentContentHash ||
        typeof entry.memoryId!=='string' || typeof entry.memoryHash!=='string' ||
        typeof entry.incorporationRef!=='string' || typeof entry.authorizationReceiptRef!=='string') continue;
    const manifest=catalog.get(entry.incorporationRef), authorization=catalog.get(entry.authorizationReceiptRef);
    const components=manifest?.payload.components;
    if (manifest?.kind!=='component-manifest' || !Array.isArray(components) ||
        !components.some(rawItem=>rawItem!==null && typeof rawItem==='object' &&
          (rawItem as Record<string,unknown>).itemId===entry.memoryId &&
          (rawItem as Record<string,unknown>).sha256===entry.memoryHash &&
          typeof (rawItem as Record<string,unknown>).count==='number' &&
          ((rawItem as Record<string,unknown>).count as number)>0)) continue;
    const a=authorization?.payload;
    if (authorization?.kind==='memory-authorization' && a?.authority==='Steven' &&
        a.memoryId===entry.memoryId && a.memoryHash===entry.memoryHash &&
        a.contentHash===currentContentHash && a.decision==='rejected' &&
        typeof a.localReceiptId==='string' && typeof a.at==='string' && typeof a.provenanceRef==='string')
      return {refs:[inventory.evidenceId,manifest.evidenceId,authorization.evidenceId],reason:'OBSERVED_UNAUTHORIZED_MEMORY',
        ...(entry.authorization==='rejected'?{}:{discrepancy:'INVENTORY_AUTHORIZATION_DISAGREEMENT'})};
  }
  return undefined;
}

export interface MaterialQuantity { value:number; material:string; unit:string; conversionVersion:string }
export interface MaterialConversion { inputMaterial:string; inputUnit:string; outputMaterial:string; outputUnit:string; coefficient:number }
export interface MaterialStock { id:string; stockId:string; phase:'opening'|'closing'; quantity:MaterialQuantity; protectedOriginIds:string[] }
export interface MaterialFlow { id:string; transferId:string; flowType:'internal'|'external-in'|'external-out'|'regeneration'|'conversion'|'consumption'|'loss'; quantity:MaterialQuantity; conversionRef:string|null; fromStockId?:string|null; toStockId?:string|null; counterpartRecordId?:string|null }
export interface MaterialBoundary { scope:'global'|'partial'; includesProtected?:boolean; stockIds:string[]; conversionMatrixRef:string|null; excludedCompartments?:string[] }
export interface BalanceLedger { boundary:MaterialBoundary; stocks:MaterialStock[]; flows:MaterialFlow[]; matrices:Record<string,{version:string;entries:MaterialConversion[]}>; complete:boolean }
export interface BalanceResult { status:'VALID'|'UNKNOWN'|'REJECT'; reasons:string[]; residualByDimension:Record<string,number>; totalsByDimension:Record<string,{opening:number;closing:number;externalInput:number;regeneration:number;externalOut:number;consumption:number;loss:number}> }

/** Converts every stock and every flow projection before considering transfer identity. */
export function evaluateMaterialBalance(ledger:BalanceLedger):BalanceResult {
  const reasons:string[]=[];
  const residualByDimension:Record<string,number>={};
  const totalsByDimension:BalanceResult['totalsByDimension']={};
  if (!ledger.complete || ledger.boundary.scope!=='global') reasons.push('INCOMPLETE_OR_PARTIAL_BOUNDARY');
  if (ledger.boundary.includesProtected===false || ledger.boundary.excludedCompartments?.length)
    return {status:'REJECT',reasons:['ACCREDITED_BOUNDARY_EXCLUSION'],residualByDimension,totalsByDimension};
  if (ledger.boundary.includesProtected===undefined) reasons.push('PROTECTED_INCLUSION_UNKNOWN');
  // A boundary's own stockIds and includesProtected flag cannot attest to the
  // world's complete S/I, compartment and origin inventory.
  const canonical=(quantity:MaterialQuantity,ref:string|null):{dimension:string;amount:number}|undefined=>{
    const matrix=ref?ledger.matrices[ref]:undefined;
    if (!matrix || matrix.version!==quantity.conversionVersion || !Number.isFinite(quantity.value) || quantity.value<0 ||
        (quantity.unit==='quanta' && !Number.isSafeInteger(quantity.value))) return undefined;
    const matching=matrix.entries.filter(e=>e.inputMaterial===quantity.material&&e.inputUnit===quantity.unit);
    if (matching.length!==1 || !Number.isFinite(matching[0].coefficient) || matching[0].coefficient<=0) return undefined;
    const amount=quantity.value*matching[0].coefficient;
    return Number.isFinite(amount)?{dimension:`${matching[0].outputMaterial}:${matching[0].outputUnit}`,amount}:undefined;
  };
  const totals=(dimension:string):BalanceResult['totalsByDimension'][string]=>totalsByDimension[dimension]??=
    {opening:0,closing:0,externalInput:0,regeneration:0,externalOut:0,consumption:0,loss:0};
  const stockIds=new Set(ledger.boundary.stockIds);
  if (!stockIds.size) reasons.push('EMPTY_BOUNDARY');
  if (stockIds.size!==ledger.boundary.stockIds.length) return {status:'REJECT',reasons:['DUPLICATE_BOUNDARY_STOCK'],residualByDimension,totalsByDimension};
  const seenStockPhase=new Set<string>();
  for (const stock of ledger.stocks) {
    if (!stockIds.has(stock.stockId)) return {status:'REJECT',reasons:['STOCK_OUTSIDE_BOUNDARY'],residualByDimension,totalsByDimension};
    const key=`${stock.stockId}:${stock.phase}`;
    if (seenStockPhase.has(key)) return {status:'REJECT',reasons:['DUPLICATE_STOCK_PHASE'],residualByDimension,totalsByDimension};
    seenStockPhase.add(key);
    const converted=canonical(stock.quantity,ledger.boundary.conversionMatrixRef);
    if (!converted) { reasons.push(`CONVERSION_UNAVAILABLE:${stock.id}`); continue; }
    totals(converted.dimension)[stock.phase]+=converted.amount;
  }
  for (const stockId of stockIds) if (!seenStockPhase.has(`${stockId}:opening`)||!seenStockPhase.has(`${stockId}:closing`)) reasons.push(`STOCK_CUT_MISSING:${stockId}`);
  const byTransfer=new Map<string,Array<{flow:MaterialFlow;converted:{dimension:string;amount:number}}>>();
  for (const flow of ledger.flows) {
    const converted=canonical(flow.quantity,flow.conversionRef??ledger.boundary.conversionMatrixRef);
    if (!converted) { reasons.push(`CONVERSION_UNAVAILABLE:${flow.id}`); continue; }
    const list=byTransfer.get(flow.transferId)??[];
    list.push({flow,converted}); byTransfer.set(flow.transferId,list);
  }
  for (const [transferId,projections] of byTransfer) {
    const first=projections[0];
    if (first.flow.flowType==='conversion') { reasons.push(`CONVERSION_NET_UNMODELLED:${transferId}`); continue; }
    if (projections.some(x=>x.converted.dimension!==first.converted.dimension || !close(x.converted.amount,first.converted.amount) || x.flow.flowType!==first.flow.flowType))
      return {status:'REJECT',reasons:[`TRANSFER_PROJECTION_CONTRADICTION:${transferId}`],residualByDimension,totalsByDimension};
    if (first.flow.flowType==='internal') {
      const [a,b]=projections.map(x=>x.flow);
      if (projections.length>2 || (a?.counterpartRecordId && b && a.counterpartRecordId!==b.id) ||
          (b?.counterpartRecordId && a && b.counterpartRecordId!==a.id) ||
          (a?.fromStockId && b?.fromStockId && a.fromStockId!==b.fromStockId) ||
          (a?.toStockId && b?.toStockId && a.toStockId!==b.toStockId))
        return {status:'REJECT',reasons:[`INTERNAL_COUNTERPART_CONTRADICTION:${transferId}`],residualByDimension,totalsByDimension};
      if (projections.length!==2 || !a || !b || !a.fromStockId || !a.toStockId ||
          a.fromStockId===a.toStockId || !stockIds.has(a.fromStockId) || !stockIds.has(a.toStockId) ||
          b.fromStockId!==a.fromStockId || b.toStockId!==a.toStockId ||
          a.counterpartRecordId!==b.id || b.counterpartRecordId!==a.id)
        reasons.push(`INTERNAL_COUNTERPART_UNAVAILABLE:${transferId}`);
    }
  }
  if (reasons.length) return {status:'UNKNOWN',reasons,residualByDimension,totalsByDimension};
  for (const [transferId,projections] of byTransfer) {
    const first=projections[0];
    const t=totals(first.converted.dimension),amount=first.converted.amount;
    switch(first.flow.flowType) {
      case 'internal': break; // two ends, one physical movement, zero boundary net
      case 'external-in': t.externalInput+=amount; break;
      case 'external-out': t.externalOut+=amount; break;
      case 'regeneration': t.regeneration+=amount; break;
      case 'consumption': t.consumption+=amount; break;
      case 'loss': t.loss+=amount; break;
      case 'conversion': return {status:'UNKNOWN',reasons:[`CONVERSION_NET_UNMODELLED:${transferId}`],residualByDimension,totalsByDimension};
    }
  }
  for (const [dimension,t] of Object.entries(totalsByDimension)) residualByDimension[dimension]=
    t.opening+t.externalInput+t.regeneration-t.closing-t.externalOut-t.consumption-t.loss;
  return {status:'UNKNOWN',reasons:['GLOBAL_INVENTORY_NOT_ACCREDITED'],residualByDimension,totalsByDimension};
}
