/** Confined, offline v3 evaluator. Input is an explicit measurement request plus one v3 bundle. */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_VERSION, THRESHOLD_PROFILE_SHA256, confinedInputPath, parseStrictJSON, sha256, validateBundleFile, validateSemantics } from './realismo-contract.js';
import { evaluateRealismo, evaluateMaterialBalance, findUnauthorizedMemory, PROFILE_ID, type EvaluationInput, type BalanceLedger, type MaterialQuantity, type MemoryEvidence } from './realismo-evaluator.js';
import type { JsonObject } from './realismo-contract.js';
import { createDerivationContext } from './realismo-derive-common.js';
import { deriveContemporaryPair } from './realismo-derive-causal-pair.js';

const args = new Map<string,string>();
for (let i=2;i<process.argv.length;i+=2) {
  const key=process.argv[i],value=process.argv[i+1];
  if (!key?.startsWith('--') || !value || args.has(key)) { process.stderr.write('Invalid CLI arguments\n'); process.exit(2); }
  args.set(key,value);
}
function outPath(root:string, name:string):string {
  if (!name || isAbsolute(name) || name.includes('\\') || name.split('/').some(p=>p==='..')) throw new Error('UNSAFE_OUTPUT_PATH');
  const canonicalRoot=realpathSync(root);
  const parent=realpathSync(resolve(canonicalRoot,dirname(name)));
  const rel=relative(canonicalRoot,parent);
  if (isAbsolute(rel)||rel==='..'||rel.startsWith('../')) throw new Error('OUTPUT_SYMLINK_ESCAPE');
  return resolve(parent,basename(name));
}
function object(v:unknown):v is JsonObject { return v!==null && typeof v==='object' && !Array.isArray(v); }
function requireString(v:unknown,key:string):string { if(typeof v!=='string'||!v)throw new Error(`MISSING_${key}`);return v; }
function stageFor(criterion:string,requested:string):string { return criterion==='C21'?'server':criterion==='C22'?'performance':criterion==='C23'?'experience':criterion==='C24'?requested:'replica'; }
function atPointer(value:unknown,pointer:string):unknown {
  if (!pointer.startsWith('/') || pointer.includes('__proto__') || pointer.includes('/constructor')) throw new Error('INVALID_FIELD_POINTER');
  return pointer.slice(1).split('/').reduce<unknown>((current,token)=>{
    const key=token.replace(/~1/g,'/').replace(/~0/g,'~');
    return object(current)?current[key]:Array.isArray(current)&&/^(0|[1-9]\d*)$/.test(key)?current[Number(key)]:undefined;
  },value);
}

async function main():Promise<number> {
  const inputRoot=requireString(args.get('--input-root'),'INPUT_ROOT');
  const inputRelative=requireString(args.get('--input'),'INPUT');
  const outputRoot=requireString(args.get('--output-root'),'OUTPUT_ROOT');
  const outputRelative=requireString(args.get('--output'),'OUTPUT');
  const requestedStage=requireString(args.get('--stage'),'STAGE');
  if (args.get('--contract-version')!==CONTRACT_VERSION || args.get('--profile-id')!==PROFILE_ID || args.get('--profile-sha256')!==THRESHOLD_PROFILE_SHA256) return 3;
  if (!['method','training','final'].includes(requestedStage)) return 3;
  const requestPath=confinedInputPath(inputRoot,inputRelative);
  const requestBytes=readFileSync(requestPath);
  const request=parseStrictJSON(requestBytes.toString('utf8'));
  if (!object(request)) throw new Error('REQUEST_OBJECT');
  if (request.contractVersion!==CONTRACT_VERSION || request.profileId!==PROFILE_ID || request.profileSha256!==THRESHOLD_PROFILE_SHA256) return 3;
  const bundleRelative=requireString(request.bundleRelativePath,'BUNDLE');
  const bundlePath=confinedInputPath(inputRoot,bundleRelative);
  const bundleHeader=parseStrictJSON(readFileSync(bundlePath,'utf8'));
  if (!object(bundleHeader)) throw new Error('BUNDLE_OBJECT');
  if (bundleHeader.contractVersion!==CONTRACT_VERSION || bundleHeader.thresholdProfileHash!==THRESHOLD_PROFILE_SHA256) return 3;
  const bundle=validateBundleFile(bundlePath,inputRoot);
  if (bundle.issues.some(x=>x.code==='UNSUPPORTED_PROFILE')) return 3;
  if (!bundle.valid || !bundle.value) throw new Error(`INVALID_BUNDLE:${bundle.issues.map(x=>x.code).join(',')}`);
  if (bundle.value.contractVersion!==CONTRACT_VERSION || bundle.value.thresholdProfileHash!==THRESHOLD_PROFILE_SHA256) return 3;
  const records=Array.isArray(bundle.value.records)?bundle.value.records.filter(object):[];
  const availableEvidenceIds=[...bundle.catalog.keys(),...records.map(r=>String(r.recordId))];
  const proposed=request.measurements;
  if (!object(proposed)||!object(proposed.fieldBindings)) throw new Error('MISSING_FIELD_BINDINGS');
  const evidence=new Map<string,Record<string,unknown>>();
  for (const [id,item] of bundle.catalog) evidence.set(id,item.value);
  for (const record of records) evidence.set(String(record.recordId),record);
  const valuesByCriterion:Record<string,Record<string,number>>={};
  const sourceRefs:Record<string,Record<string,string[]>>={};
  for (const [criterion,rawBindings] of Object.entries(proposed.fieldBindings)) {
    if (!/^C(?:9|1[0-9]|2[0-4])$/.test(criterion)||!object(rawBindings)) throw new Error('INVALID_CRITERION_BINDINGS');
    valuesByCriterion[criterion]={}; sourceRefs[criterion]={};
    for (const [operand,rawBinding] of Object.entries(rawBindings)) {
      if (!object(rawBinding)) throw new Error(`INVALID_BINDING:${criterion}.${operand}`);
      const ref=requireString(rawBinding.ref,`REF_${operand}`);
      const pointer=requireString(rawBinding.pointer,`POINTER_${operand}`);
      const doc=evidence.get(ref);
      if (!doc) throw new Error(`UNRESOLVED_BINDING:${ref}`);
      const value=atPointer(doc,pointer);
      if (typeof value!=='number'||!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value))) throw new Error(`NONNUMERIC_BINDING:${ref}${pointer}`);
      if (doc.family && pointer.startsWith('/payload/')) {
        const key=pointer.split('/')[2];
        const coverage=object(doc.fieldCoverage)?doc.fieldCoverage[key]:undefined;
        if (!object(coverage)||coverage.status!=='observed') throw new Error(`UNCOVERED_BINDING:${ref}${pointer}`);
      }
      valuesByCriterion[criterion][operand]=value;
      sourceRefs[criterion][operand]=[ref];
    }
  }
  const profilePath=fileURLToPath(new URL('../../specs/003-criterios-realismo/contracts/thresholds.v3.json',import.meta.url));
  const profileBytes=readFileSync(profilePath);
  if (sha256(profileBytes)!==THRESHOLD_PROFILE_SHA256) return 3;
  const profile=JSON.parse(profileBytes.toString('utf8')) as {criteria:Array<{criterion:string;requiredFamilies:string[];thresholds:Array<{thresholdId:string;unit:string}>}>};
  const capabilities=Array.isArray(bundle.value.capabilities)?bundle.value.capabilities.filter(object):[];
  const streams=Array.isArray(bundle.value.streams)?bundle.value.streams.filter(object):[];
  const planned=bundle.value.plannedWindow,actual=bundle.value.actualWindow;
  const plannedStart=object(planned)?planned.startTick:undefined;
  const plannedEnd=object(planned)?planned.endTick:undefined;
  const fullRun=bundle.value.runStatus==='complete'&&object(planned)&&object(actual)&&
    planned.startTick===actual.startTick&&planned.endTick===actual.endTick&&planned.epochId===actual.epochId;
  const coveredCriteria=fullRun?profile.criteria.filter(rule=>rule.requiredFamilies.every(family=>
    capabilities.some(c=>c.family===family&&c.status==='available')&&streams.some(s=>object(s.window)&&
      s.family===family&&s.quality==='COMPLETE'&&Array.isArray(s.gaps)&&s.gaps.length===0&&
      s.window.startTick===plannedStart&&s.window.endTick===plannedEnd))).map(rule=>rule.criterion):[];
  const coveredMetrics:string[]=[];
  const metricOverrides:NonNullable<EvaluationInput['metricOverrides']>={};
  const integrityIssues:string[]=[];
  const invalidSubgates:NonNullable<EvaluationInput['invalidSubgates']>={};
  const derivationReasons=new Map<string,string[]>();
  const derivationRefs=new Map<string,string[]>();
  const derivationContext=createDerivationContext(bundle);
  if (derivationContext.state==='READY') for (const criterion of ['C11','C17'] as const) {
    const pairs=[...bundle.catalog].filter(([,entry])=>entry.value.kind==='causal-pair'&&
      object(entry.value.payload)&&entry.value.payload.criterion===criterion);
    const batches=pairs.map(([id])=>deriveContemporaryPair(derivationContext.value,criterion,id));
    const reasons=batches.length ? batches.flatMap(batch=>batch.metrics.map(metric=>metric.reason)) : ['PAIR_NOT_INDEXED'];
    derivationReasons.set(criterion,[...new Set(reasons)]);
    derivationRefs.set(criterion,[...new Set([...pairs.map(([id])=>id),
      ...batches.flatMap(batch=>batch.metrics.flatMap(metric=>metric.refs))])]);
  }
  const boundaryRecords=records.filter(r=>r.family==='boundary'&&object(r.payload)&&r.payload.scope==='global');
  const balanceUnknowns:string[]=[];
  if (boundaryRecords.length!==1) balanceUnknowns.push('GLOBAL_BOUNDARY_NOT_UNIQUE');
  for (const boundaryRecord of boundaryRecords) {
    if (boundaryRecords.length!==1) break;
    const p=boundaryRecord.payload;
    if (!object(p)||p.scope!=='global'||typeof p.boundaryId!=='string') continue;
    const boundaryId=p.boundaryId;
    const stockRecords=records.filter(r=>r.family==='stock'&&object(r.payload)&&r.payload.boundaryId===boundaryId);
    const flowRecords=records.filter(r=>r.family==='flow'&&object(r.payload)&&r.payload.boundaryId===boundaryId);
    const quantity=(x:unknown):MaterialQuantity|undefined=>object(x)&&typeof x.value==='number'&&typeof x.material==='string'&&typeof x.unit==='string'&&typeof x.conversionVersion==='string'
      ?{value:x.value,material:x.material,unit:x.unit,conversionVersion:x.conversionVersion}:undefined;
    const matrices:BalanceLedger['matrices']={};
    for (const [id,item] of bundle.catalog) if (item.value.kind==='conversion-matrix'&&object(item.value.payload)) {
      const matrix=item.value.payload;
      if (typeof matrix.version==='string'&&Array.isArray(matrix.entries)) {
        const entries:BalanceLedger['matrices'][string]['entries']=[];
        for (const raw of matrix.entries) {
          if (!object(raw)||typeof raw.inputMaterial!=='string'||typeof raw.inputUnit!=='string'||
              typeof raw.outputMaterial!=='string'||typeof raw.outputUnit!=='string'||
              typeof raw.coefficient!=='number'||!Number.isFinite(raw.coefficient)) continue;
          entries.push({inputMaterial:raw.inputMaterial,inputUnit:raw.inputUnit,
            outputMaterial:raw.outputMaterial,outputUnit:raw.outputUnit,coefficient:raw.coefficient});
        }
        matrices[id]={version:matrix.version,entries};
      }
    }
    const stocks:BalanceLedger['stocks']=[];
    for (const r of stockRecords) {
      const s=r.payload as Record<string,unknown>,q=quantity(s.quantity);
      if (!q||typeof s.stockId!=='string'||(s.phase!=='opening'&&s.phase!=='closing')) continue;
      stocks.push({id:String(r.recordId),stockId:s.stockId,phase:s.phase,quantity:q,protectedOriginIds:Array.isArray(r.protectedOriginIds)?r.protectedOriginIds as string[]:[]});
    }
    const flows:BalanceLedger['flows']=[];
    for (const r of flowRecords) {
      const s=r.payload as Record<string,unknown>,q=quantity(s.quantity);
      if (!q||typeof s.transferId!=='string'||!['internal','external-in','external-out','regeneration','conversion','consumption','loss'].includes(String(s.flowType))) continue;
      flows.push({id:String(r.recordId),transferId:s.transferId,flowType:s.flowType as BalanceLedger['flows'][number]['flowType'],quantity:q,
        conversionRef:typeof s.conversionRef==='string'?s.conversionRef:null,
        fromStockId:typeof s.fromStockId==='string'?s.fromStockId:null,toStockId:typeof s.toStockId==='string'?s.toStockId:null,
        counterpartRecordId:typeof s.counterpartRecordId==='string'?s.counterpartRecordId:null});
    }
    const complete=fullRun&&stocks.length===stockRecords.filter(r=>object(r.payload)&&(r.payload.phase==='opening'||r.payload.phase==='closing')).length&&flows.length===flowRecords.length&&
      ['boundary','stock','flow'].every(f=>streams.some(s=>object(s.window)&&s.family===f&&s.quality==='COMPLETE'&&
        s.window.startTick===plannedStart&&s.window.endTick===plannedEnd&&Array.isArray(s.gaps)&&s.gaps.length===0));
    const balance=evaluateMaterialBalance({boundary:{scope:'global',includesProtected:typeof p.includesProtected==='boolean'?p.includesProtected:undefined,
      stockIds:Array.isArray(p.stockIds)?p.stockIds as string[]:[],conversionMatrixRef:typeof p.conversionMatrixRef==='string'?p.conversionMatrixRef:null,
      excludedCompartments:Array.isArray(p.excludedCompartments)?p.excludedCompartments as string[]:[]},
      stocks,flows,matrices,complete});
    if (balance.status==='REJECT') invalidSubgates['C12.balance']={reasons:balance.reasons,
      refs:[String(boundaryRecord.recordId),...stockRecords.map(r=>String(r.recordId)),...flowRecords.map(r=>String(r.recordId))]};
    if (balance.status==='UNKNOWN') balanceUnknowns.push(...balance.reasons);
    if (balance.status==='VALID') {
      const refs=[String(boundaryRecord.recordId),...stocks.map(x=>x.id),...flows.map(x=>x.id)];
      for (const [unit,id] of [['quanta','C12.integerResidual'],['normalized','C12.normalizedResidualAbs']] as const) {
        const residuals=Object.entries(balance.residualByDimension).filter(([dimension])=>dimension.endsWith(`:${unit}`)).map(([,value])=>value);
        if (!residuals.length) continue;
        const value=unit==='quanta'?residuals.reduce((largest,next)=>Math.abs(next)>Math.abs(largest)?next:largest,0):Math.max(...residuals.map(Math.abs));
        metricOverrides[id]={value,refs,reason:'CONVERTED_COMPLETE_BOUNDARY'}; coveredMetrics.push(id);
      }
    }
  }
  if (!metricOverrides['C12.integerResidual']||!metricOverrides['C12.normalizedResidualAbs']) {
    const index=coveredCriteria.indexOf('C12'); if(index>=0)coveredCriteria.splice(index,1);
  }
  const memoryCatalog=new Map<string,MemoryEvidence>();
  for (const [id,item] of bundle.catalog) if (object(item.value.payload))
    memoryCatalog.set(id,{evidenceId:id,kind:String(item.value.kind),payload:item.value.payload});
  const currentHashes=[...new Set(records.filter(r=>r.family==='review'&&object(r.payload)&&r.payload.kind==='personal'&&
    typeof r.payload.contentHash==='string').map(r=>String((r.payload as JsonObject).contentHash)))];
  const inventories=[...memoryCatalog.values()].filter(x=>x.kind==='real-memory-inventory'&&x.payload.contentHash===currentHashes[0]);
  const unauthorizedMemory=currentHashes.length===1 && inventories.length===1 && bundle.value.synthetic!==true
    ?findUnauthorizedMemory(inventories[0],currentHashes[0],memoryCatalog):undefined;
  for (const criterion of ['C11','C17']) {
    const index=coveredCriteria.indexOf(criterion);
    if (index>=0) coveredCriteria.splice(index,1);
    delete valuesByCriterion[criterion];
  }
  delete valuesByCriterion.C10?.conditionAtService;
  delete valuesByCriterion.C10?.functionalServicesAtCutoff;
  const cutoff=bundle.serviceLinks.filter(link=>link.state==='BOUND'&&typeof link.condition==='number'&&link.condition<=.1&&typeof link.appliedValue==='number'&&link.appliedValue>0);
  if (cutoff.length) {
    metricOverrides['C10.functionalCutoff']={value:cutoff.length,refs:cutoff.map(x=>x.recordId),reason:'BOUND_EFFECT_AT_LAW_CUTOFF'};
    coveredMetrics.push('C10.functionalCutoff');
  } else {
    derivationReasons.set('C10',['ZERO_LOCAL_ABSENCE_PROOF_UNAVAILABLE']);
    derivationRefs.set('C10',[String(bundle.value.evidenceId)]);
  }
  const input:EvaluationInput={
    contractVersion:CONTRACT_VERSION,profileId:PROFILE_ID,profileSha256:THRESHOLD_PROFILE_SHA256,
    source:'bundle',synthetic:bundle.value.synthetic===true,
    valuesByCriterion,coveredCriteria,coveredMetrics,metricOverrides,sourceRefs,availableEvidenceIds,integrityIssues,invalidSubgates,
    personalReceiptVerified:false,finalPhaseReceiptVerified:false,
    unauthorizedMemory,
    unknownReasons:[...bundle.unknowns.map(x=>x.code),...balanceUnknowns,
      ...(unauthorizedMemory?.discrepancy?[`C23:${unauthorizedMemory.discrepancy}`]:[]),
      ...[...derivationReasons].flatMap(([criterion,reasons])=>reasons.map(reason=>`${criterion}:${reason}`))],
  };
  const evaluation=evaluateRealismo(input);
  if (evaluation.status==='UNSUPPORTED') return 3;
  if (evaluation.status==='REJECT') throw new Error(`INVALID_MEASUREMENTS:${evaluation.issues.join(',')}`);
  const profileByCriterion=new Map(profile.criteria.map(c=>[c.criterion,new Map(c.thresholds.map(t=>[t.thresholdId,t.unit]))]));
  const evaluatorBytes=readFileSync(fileURLToPath(new URL('./realismo-evaluator.ts',import.meta.url)));
  const output={
    contractVersion:CONTRACT_VERSION,kind:'evaluation',evaluatorSHA:sha256(evaluatorBytes),thresholdProfileHash:THRESHOLD_PROFILE_SHA256,
    inputHashes:[...new Set([sha256(requestBytes),sha256(readFileSync(bundlePath))])],requestedStage,
    runId:String(bundle.value.runId),epochId:String(bundle.value.epochId),artifactRole:String(bundle.value.artifactRole),
    evidenceId:`evaluation-${String(bundle.value.runId)}-${String(bundle.value.epochId)}`,synthetic:input.synthetic,
    inputObservationRef:String(bundle.value.evidenceId),frozenC1C8ArtifactRef:null,acceptanceStatus:'NOT_GRANTED',
    limitations:[...new Set(['PROVISIONAL_THRESHOLDS_NOT_ACCEPTANCE',...evaluation.unknowns])],panels:[],
    results:evaluation.criteria.map(c=>({
      criterion:c.criterion,stage:stageFor(c.criterion,requestedStage),state:c.verdict,quality:c.quality,
      provisionalConformity:true,personalDecision:'pending',reasonCodes:[...new Set([
        ...(c.reasons.length?c.reasons:[c.verdict==='PASS'?'PROVISIONAL_NUMERIC_PASS':'SUPPORTED_FALSE']),
        ...(c.criterion==='C23'&&unauthorizedMemory?.discrepancy?[unauthorizedMemory.discrepancy]:[]),
        ...(derivationReasons.get(c.criterion)??[])])],
      evidenceRefs:[...new Set([...c.subgates.flatMap(g=>g.refs),
        ...(derivationRefs.get(c.criterion)??[])])],
      subgates:c.subgates.map(g=>({subgateId:g.id,state:g.verdict,quality:g.quality,
        reasonCodes:g.reasons.length?[...g.reasons,...(g.id==='C23.personal-review'&&unauthorizedMemory?.discrepancy?[unauthorizedMemory.discrepancy]:[])]:
          [g.verdict==='PASS'?'PROVISIONAL_NUMERIC_PASS':'SUPPORTED_FALSE'],
        thresholdIds:g.metrics.filter(m=>profileByCriterion.get(c.criterion)?.has(m.id)).map(m=>m.id),
        metrics:g.metrics.map(m=>({name:m.id,value:m.value,unit:m.id==='C10.functionalCutoff'?'events':profileByCriterion.get(c.criterion)?.get(m.id)??'count',
          numerator:null,denominator:null,exposureTicks:null,censoredCount:0,formulaId:m.id,evidenceRefs:m.refs})),
        evidenceRefs:g.refs,scope:'measured-operand-ledger'}))
    }))
  };
  const check=validateSemantics('evaluation.schema.json',output);
  if (!check.valid) throw new Error(`OUTPUT_SCHEMA:${check.issues.map(x=>x.code).join(',')}`);
  const target=outPath(outputRoot,outputRelative);
  writeFileSync(target,JSON.stringify(output,null,2)+'\n',{flag:'wx',mode:0o600});
  return 0;
}
main().then(code=>{process.exitCode=code;}).catch(error=>{process.stderr.write(`${String(error)}\n`);process.exitCode=2;});
