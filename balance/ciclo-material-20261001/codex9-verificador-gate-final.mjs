import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
process.title = 'codex9audit';
const LAB='/datos/tmp-atlas-lab', DIR=LAB+'/balance/codex9', ROOT='/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/ciclo-material';
const resultPath=DIR+'/gate-v3-result.json', wrapperPath=DIR+'/gate-v3-real.json', logPath=DIR+'/gate-v3-real.log';
const outputPath=DIR+'/codex9-verificacion-gate-final.json';
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
function guard(){const v={pid:process.pid,nice:os.getPriority(0),cpus:fs.readFileSync('/proc/self/status','utf8').match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1],TMPDIR:process.env.TMPDIR};assert.equal(v.nice,19);assert.equal(v.cpus,'6-31');assert.equal(v.TMPDIR,LAB);return v;}
const initial=guard();
fs.readFileSync(LAB+'/datos-lab/codex-goal-9.md','utf8');fs.readFileSync(LAB+'/datos-lab/codex-goal-8.md','utf8');
const report=read(resultPath), wrapper=read(wrapperPath), p=read(report.protocolPath), log=fs.readFileSync(logPath,'utf8');
let numericChecks=0, structuralChecks=0;
function equal(a,b,name){structuralChecks++;assert.deepEqual(a,b,name);}
function num(a,b,name){numericChecks++;assert.ok(Number.isFinite(a)&&Number.isFinite(b),name+' nonfinite');assert.ok(Math.abs(a-b)<=1e-12*Math.max(1,Math.abs(a),Math.abs(b)),name+': '+a+' != '+b);}
function sum(a){return a.reduce((x,y)=>x+y,0);}
function q(a,percent){const s=[...a].sort((x,y)=>x-y),z=(s.length-1)*percent,i=Math.trunc(z);assert.ok(s.length);return s[i]+(s[Math.min(i+1,s.length-1)]-s[i])*(z-i);}
function describe(a){return {n:a.length,mean:sum(a)/a.length,p50:q(a,.5),p95:q(a,.95)};}
function checkDescription(actual,values,name){const expected=describe(values);for(const k of Object.keys(expected))num(actual[k],expected[k],name+'.'+k);}
equal(report.protocolSHA256,sha(report.protocolPath),'protocol hash');
equal(report.initialSources,report.finalSources,'source start/end');
let sourceChecks=0;
for(const [kind,root]of[['baseline',LAB+'/datos-lab/codex9-main-source'],['candidate',ROOT]])for(const [path,hash]of Object.entries(report.initialSources[kind])){equal(sha(root+'/'+path),hash,'current source '+path);sourceChecks++;}
const changed=[...new Set([...Object.keys(report.initialSources.baseline),...Object.keys(report.initialSources.candidate)])].filter(k=>report.initialSources.baseline[k]!==report.initialSources.candidate[k]).sort();
equal(changed,report.initialSources.changed,'source diff inventory');equal(changed,[...p.sourceAllowlist].sort(),'only approved source files changed');
equal(report.initialSources.runnerSHA256,sha(ROOT+'/scripts/lab/validar-ciclo-material.ts'),'runner hash');
equal(report.initialSources.runtimeSHA256,sha(LAB+'/codex9-runtime/codex9-node'),'runtime hash');
equal(report.initialSources.archiveSHA256,sha(LAB+'/datos-lab/codex9-main-source.tar'),'baseline archive hash');
equal(report.initialSources.manifestSHA256,sha(LAB+'/datos-lab/codex9-main-source/SOURCE-MANIFEST.json'),'baseline manifest');
equal(report.resources.length,681,'guard count');
for(const r of report.resources){equal(r.nice,19,'guard nice');equal(r.cpus,Array.from({length:26},(_,i)=>i+6),'guard CPU');equal(r.TMPDIR,LAB,'guard TMPDIR');equal(r.title,'codex9gate','guard title');equal(r.runtime,LAB+'/codex9-runtime/codex9-node','guard runtime');}
equal(wrapper.resourceSamples,7516,'wrapper samples');equal(wrapper.examinedThreads,105210,'wrapper thread checks');equal(wrapper.resourceIssues,[],'wrapper issues');equal(wrapper.signal,null,'wrapper signal');equal(wrapper.code,1,'scientific nonpass exit');equal(wrapper.valid,false,'wrapper retains nonpass');equal(wrapper.launchEnvironment,{TMPDIR:LAB,ldPreloadPresent:false,launcherInitEnabled:false},'no preload');
for(const r of wrapper.ownFinal){equal(r.nice,19,'wrapper final nice');equal(r.cpus,'6-31','wrapper final cpus');}
assert.ok(wrapper.elapsedSeconds<7200);equal(report.failure,undefined,'no runtime failure');equal(report.failedQuartet,undefined,'no partial failed quartet');
const measured=[], warm=[], armTotals=new Map(), metricResults={};let checkpointRecords=0, identityComparisons=0, blocks=0, warmBlocks=0, observerArms=0, stressedArms=0, recordCount=0, byteCount=0, dailyRows=0, structureRows=0;
const totalsFor=(arm,kind)=>sum([arm.initialObserver[kind],arm.closeObserver[kind],...arm.blocks.map(b=>b[kind])]);
function inspectArm(arm,family,expectedSteps,round,isWarm){
  const b=arm.label.startsWith('B'), steps=sum(arm.blocks.map(x=>x.to-x.from));
  num(arm.steps,steps,'arm steps');equal(steps,expectedSteps,'fixed arm length');equal(arm.blocks.length,expectedSteps/50,'block count');
  let end=0;for(const block of arm.blocks){equal(block.from,end,'continuous blocks');equal(block.to,end+50,'block width');equal(block.order,isWarm?['A1','B1']:p.orders[round],'fixed order');for(const m of ['cpuMs','wallMs'])assert.ok(block[m]>0&&Number.isFinite(block[m]));end=block.to;}
  if(isWarm)warmBlocks+=arm.blocks.length;else blocks+=arm.blocks.length;
  const totals={};for(const m of ['cpuMs','wallMs']){totals[m]=totalsFor(arm,m);num(arm.total[m],totals[m],'arm total '+m);num(arm[m+'PerStep'],totals[m]/steps,'ms per step '+m);checkDescription(arm['block'+(m==='cpuMs'?'Cpu':'Wall')+'MsPerStep'],arm.blocks.map(x=>x[m]/50),'block descriptive '+m);}
  armTotals.set(arm,totals);
  const wanted=[0,300,600,900,1200].filter(x=>x<=expectedSteps);equal(arm.checkpoints.map(x=>x.step),wanted,'checkpoint steps');
  for(const cp of arm.checkpoints){equal(cp.tick,cp.step,'checkpoint tick');assert.match(cp.world,/^[a-f0-9]{64}$/);assert.match(cp.database.sha256,/^[a-f0-9]{64}$/);assert.ok(Object.keys(cp.database.tables).length);checkpointRecords++;}
  if(!b){equal(arm.observerFinal,undefined,'baseline no observer');for(const m of ['cpuMs','wallMs']){num(arm.initialObserver[m],0,'baseline observer init');num(arm.closeObserver[m],0,'baseline observer close');}}
  if(family==='material-stressed'){
    stressedArms++;const f=arm.fixture, ids=Array.from({length:16},(_,i)=>'structure-'+(i+1));
    equal(f.initialResidency.tick,0,'initial residency tick');equal(f.firstStepResidency.tick,1,'first residency tick');equal(f.finalResidency.tick,expectedSteps,'final residency tick');
    for(const r of [f.initialResidency,f.firstStepResidency,f.finalResidency])equal(r.rows.map(x=>x.id),ids,'16 unique fixture IDs');
    for(let i=0;i<16;i++)equal(f.initialResidency.rows[i].state,i<8?'active':'dormant','initial active/dormant split');
    const remained=state=>f.initialResidency.rows.filter(row=>row.state===state&&f.firstStepResidency.rows.find(x=>x.id===row.id).state===state).length;
    num(f.minimumActiveExposureTicks,remained('active'),'independent active duration');num(f.minimumDormantExposureTicks,remained('dormant'),'independent dormant duration');
    assert.ok(f.minimumActiveExposureTicks>=1&&f.minimumDormantExposureTicks>=1);assert.ok(f.finalResidency.rows.every(x=>x.state!=='unknown'));assert.ok(f.usesSeen>0);if(!b)assert.ok(f.brokenSeen.length>0);
  }
  equal(arm.fixture.passed,true,'fixture passed');equal(arm.fixture.topologyPassed,true,'topology passed');
  if(b){
    observerArms++;const o=arm.observerFinal;equal(o.version,1,'observer version');equal(o.coverage.startTick,0,'observer start');equal(o.coverage.endTick,expectedSteps,'observer end');equal(o.coverage.observationGaps,[],'no gaps');equal(o.coverage.historyBeforeStart,'unobserved','prior history');equal(o.coverage.unseenArchivedStructures,'unknown','unseen archive');
    const ic=arm.fixture.instrumentCoverage, fixture=o.structures.filter(r=>/^structure-(?:[1-9]|1[0-6])$/.test(r.id));
    const derived={attachedPendingDormant:o.coverage.attachments[0]?.pendingDormantStructures??0,brokenCrossings:sum(o.structures.map(r=>r.brokenCrossings)),wearEvaluations:sum(o.structures.map(r=>r.wearEvaluations)),activeExposureTicks:sum(o.structures.map(r=>r.activeExposureTicks)),fixtureActiveExposureTicks:sum(fixture.map(r=>r.activeExposureTicks)),fixtureDormantExposureTicks:sum(fixture.map(r=>expectedSteps-r.firstObservedTick-r.activeExposureTicks)),fixtureExposureComplete:fixture.length===16&&fixture.every(r=>r.firstObservedTick===0&&r.activeExposureTicks>=0&&r.activeExposureTicks<=expectedSteps),dailyUses:sum(o.daily.map(r=>r.uses.food+r.uses.water+r.uses.rest)),observedSyntheticDormant:o.structures.filter(r=>/^structure-(?:9|1[0-6])$/.test(r.id)).length,explicitlyUnsupportedRuin:o.structures.every(r=>r.explicitRuinInModel===false)};
    for(const[k,v]of Object.entries(derived))typeof v==='number'?num(ic[k],v,'instrument '+k):equal(ic[k],v,'instrument '+k);
    const emitted=sum(wanted.map(t=>1+2*o.structures.filter(s=>s.firstObservedTick<=t).length));num(arm.observerFile.records,emitted,'NDJSON record count');assert.ok(arm.observerFile.bytes>0&&arm.observerFile.writes>0);assert.match(arm.observerFile.sha256,/^[a-f0-9]{64}$/);recordCount+=arm.observerFile.records;byteCount+=arm.observerFile.bytes;
    for(const s of o.structures){const days=o.daily.filter(d=>d.structureId===s.id);assert.ok(days.length);structureRows++;dailyRows+=days.length;
      for(const[field,rowField]of[['activeExposureTicks','exposureTicks'],['wearEvaluations','wearEvaluations'],['repairCount','repairCount'],['repairWoodPaid','repairWoodPaid'],['repairWorkPaid','repairWorkPaid'],['brokenCrossings','brokenCrossings'],['zeroCrossings','zeroCrossings']])num(s[field],sum(days.map(d=>d[rowField])),'daily sum '+field);
      num(s.conditionFinal,days.at(-1).conditionFinal,'final condition');num(s.conditionMinimum,Math.min(...days.map(d=>d.conditionMinimum)),'condition minimum');num(s.stockFoodFinal,days.at(-1).stockFoodFinal,'final food');num(s.stockWaterFinal,days.at(-1).stockWaterFinal,'final water');equal(s.explicitRuinInModel,false,'no ruin law');equal(s.salvagePotential.recoveryImplemented,false,'no recovered credit');
      for(const d of days){num(sum(Object.values(d.uses)),sum(Object.values(d.useCountsByClass)),'use classifications');equal(d.partial,true,'half-day partial');equal(d.hasObservationGap,false,'daily no gap');assert.ok(d.exposureTicks>=0&&d.exposureTicks<=d.observedTicks);for(const ids of Object.values(d.usersByClass)){equal(ids,[...new Set(ids)].sort(),'unique sorted users');}}
    }
    if(family==='material-stressed'){
      equal(fixture.length,16,'fixture exports16');assert.ok(derived.brokenCrossings>0&&derived.wearEvaluations>0&&derived.dailyUses>0);assert.ok(derived.fixtureActiveExposureTicks>=arm.fixture.minimumActiveExposureTicks&&derived.fixtureDormantExposureTicks>=arm.fixture.minimumDormantExposureTicks);
      for(const s of fixture){const actual=arm.fixture.finalResidency.rows.find(r=>r.id===s.id);num(s.conditionFinal,actual.condition,'fixture physical condition');num(sum(o.daily.filter(d=>d.structureId===s.id).map(d=>sum(Object.values(d.uses)))),actual.uses,'fixture uses physical');equal(s.constructionSeen,false,'synthetic insertion not paid construction');equal(s.historyCoverage,'left-censored','synthetic left censored');equal(s.salvagePotential.originalPaidCost,null,'synthetic original cost unknown');num(s.salvagePotential.wood,11,'nominal wood');num(s.salvagePotential.stone,7,'nominal stone');num(s.salvagePotential.work,165,'nominal work');}
    }
  }
}
equal(report.quartets.length,24,'quartets');equal(report.warmup.length,1,'warmup quartet');
for(const [list,isWarm]of[[report.quartets,false],[report.warmup,true]])for(const qt of list){
  equal(qt.arms.map(a=>a.label),isWarm?['A1','B1']:p.orders[qt.round],'arm order');equal(qt.identical,true,'quartet identity');equal(qt.fixturePassed,true,'quartet coverage');
  for(const arm of qt.arms){inspectArm(arm,qt.family,isWarm?300:1200,qt.round,isWarm);(isWarm?warm:measured).push(arm);}
  for(const arm of qt.arms.slice(1))for(let i=0;i<arm.checkpoints.length;i++){equal(arm.checkpoints[i],qt.arms[0].checkpoints[i],'world+SQLite same checkpoint');identityComparisons++;}
}
equal(measured.length,96,'96 measured worlds');equal(sum(measured.map(a=>a.steps)),115200,'115200 measured steps');equal(warm.length,2,'2 warmup worlds');equal(sum(warm.map(a=>a.steps)),600,'600 warmup steps');
equal(report.measuredWorlds,measured.length,'reported worlds');equal(report.measuredSteps,sum(measured.map(a=>a.steps)),'reported steps');
for(const seed of p.seeds)for(const family of p.families){const qs=report.quartets.filter(x=>x.seed===seed&&x.family===family).sort((a,b)=>a.round-b.round);equal(qs.map(q=>q.round),[0,1],'complete fixed seed rounds');for(let i=0;i<5;i++){equal(qs[0].arms[0].checkpoints[i],qs[1].arms[0].checkpoints[i],'round identity');identityComparisons++;}}
function bootstrap(rows){
  const seedRows=p.seeds.map(seed=>rows.filter(x=>x.seed===seed).sort((a,b)=>a.round-b.round));let state=BigInt(p.bootstrap.rngSeed);const rand=n=>{state=(state*1664525n+1013904223n)&4294967295n;return Number(state*BigInt(n)/4294967296n);};const samples=[];
  for(let r=0;r<10000;r++){let total=0;for(let c=0;c<6;c++){const pair=seedRows[rand(6)];total+=pair[rand(2)].logRatio;total+=pair[rand(2)].logRatio;}samples.push(Math.expm1(total/12));}
  return {estimate:Math.expm1(sum(rows.map(r=>r.logRatio))/12),ci95:[q(samples,.025),q(samples,.975)]};
}
let costPass=true;
for(const family of p.families){metricResults[family]={};const quartets=report.quartets.filter(x=>x.family===family);equal(quartets.length,12,'family12quartets');
  for(const metric of ['cpuMs','wallMs']){const ratios=[],aa=[],blockRatios=[];
    for(const qt of quartets){const arm=name=>qt.arms.find(a=>a.label===name),value=name=>armTotals.get(arm(name))[metric];ratios.push({seed:qt.seed,round:qt.round,logRatio:Math.log((value('B1')+value('B2'))/(value('A1')+value('A2')))});aa.push(value('A2')/value('A1')-1);for(let b=0;b<24;b++)blockRatios.push((arm('B1').blocks[b][metric]+arm('B2').blocks[b][metric])/(arm('A1').blocks[b][metric]+arm('A2').blocks[b][metric])-1);}
    const actual=report.cost.families[family][metric],expected=bootstrap(ratios);num(actual.estimate,expected.estimate,'estimate');for(let i=0;i<2;i++)num(actual.ci95[i],expected.ci95[i],'CI endpoint');equal(actual.replicates,10000,'10000 resamples');equal(actual.rngSeed,912037,'bootstrap seed');equal(actual.pairedSeedRoundRatios.map(r=>[r.seed,r.round]),ratios.map(r=>[r.seed,r.round]),'ratio ordering');for(let i=0;i<12;i++)num(actual.pairedSeedRoundRatios[i].logRatio,ratios[i].logRatio,'paired log ratio');checkDescription(actual.baselineAANoise,aa,'AA noise');checkDescription(actual.blockOverheads,blockRatios,'block overheads');
    expected.pass=expected.ci95[1]<=.01;equal(actual.passesOnePercent,expected.pass,'scientific metric gate');const reason=expected.pass?'upper95CI<=1%':expected.estimate>.01?'observed overhead>1%':'1% unresolved by confidence interval';equal(actual.reason,reason,'scientific reason');expected.reason=reason;metricResults[family][metric]=expected;costPass&&=expected.pass;
  }
}
equal(report.cost.passed,costPass,'cost aggregate');equal(report.identityPassed,true,'identity gate');equal(report.fixturePassed,true,'fixture gate');equal(report.status,costPass?'CUMPLIDA':'NO CUMPLIDA','final gate');
const progress=log.split('\n').filter(l=>l.startsWith('{"progress":')).map(l=>JSON.parse(l));equal(progress.length,24,'all progress retained');for(let i=0;i<24;i++){equal(progress[i].progress,i+1,'progress sequential');equal([progress[i].seed,progress[i].family,progress[i].round,progress[i].identity],[report.quartets[i].seed,report.quartets[i].family,report.quartets[i].round,true],'progress identity');}
const audit={reviewedUTC:new Date().toISOString(),verification:'PASS_RECALCULATION',gateA:'NO CUMPLIDA',reason:'scientific cost threshold not met; no resource drift, timeout, signal or runtime failure',inputs:{resultSHA256:sha(resultPath),wrapperSHA256:sha(wrapperPath),logSHA256:sha(logPath),protocolSHA256:sha(report.protocolPath),runnerSHA256:report.initialSources.runnerSHA256},counts:{numericChecks,structuralChecks,sourceChecks,measuredWorlds:measured.length,measuredSteps:sum(measured.map(a=>a.steps)),warmupWorlds:warm.length,warmupSteps:sum(warm.map(a=>a.steps)),quartets:report.quartets.length,measuredBlocks:blocks,warmupBlocks:warmBlocks,checkpointRecords,identityComparisons,observerArms,stressedArms,structureRows,dailyRows,observerNDJSONRecords:recordCount,observerNDJSONBytes:byteCount,internalGuards:report.resources.length,wrapperSamples:wrapper.resourceSamples,wrapperThreadChecks:wrapper.examinedThreads,wrapperIssues:0},cost:metricResults,limits:['No new stepWorld calls or trajectories; analysis only','Observer file bytes/stream SHA are recorded raw values; temporary files were removed, so original NDJSON bytes/hash cannot be re-read; record counts independently reconstructed','Resource sampler every0.5s can miss wholly intermediate processes/drift','Elapsed residency is separate from wear frames; dormant archives are not contemporaneous global inventories','6seed clusters/2rounds; buffered writes, no fsync; half-day simulations; no biological or future-law acceptance','Final suite QA is parent-owned and still pending'],resources:{initial,final:guard(),valid:true}};
fs.writeFileSync(outputPath,JSON.stringify(audit,null,2)+'\n',{flag:'wx',mode:0o600});
const reviewPath=DIR+'/revision-instrumento.json',review=read(reviewPath);review.phase='FINAL_REAL_GATE_REVIEW';review.gateA='NO CUMPLIDA';review.gateReason=audit.reason;review.benchReview='PASS_INDEPENDENT_RECALCULATION_OF_NO_CUMPLIDA_RESULT';review.realGateIndependentReview={...audit,evidencePath:outputPath,evidenceSHA256:sha(outputPath)};
let md=fs.readFileSync(DIR+'/revision-instrumento.md','utf8');md=md.replace(/\*\*Estado vigente [^\n]+\*\*/,'**Estado vigente '+audit.reviewedUTC+': recálculo independiente PASS; puerta A NO CUMPLIDA por coste. Identidad/cobertura/recursos PASS; B PASS de requisitos; suite final pendiente.**');
md+='\n## Resultado real: recálculo independiente — '+audit.reviewedUTC+'\n\n**Puerta A NO CUMPLIDA por coste**, reproducida desde datos crudos con analítica independiente (sin importar evaluador ni ejecutar trayectorias). '+numericChecks+' comparaciones numéricas y '+structuralChecks+' estructurales;0diferencias. '+measured.length+' mundos medidos,115.200 pasos,24cuartetos,'+blocks+' bloques;2mundos/600pasos warmup excluidos. '+checkpointRecords+' checkpoints mundo+SQLite,'+identityComparisons+' comparaciones de identidad entre brazos/rondas,'+observerArms+' exports B y '+stressedArms+' brazos stressed (incluye warmup). Fuentes inicio/fin iguales y '+sourceChecks+' SHA de fuentes actuales iguales a los registrados.\n\n|Familia|Métrica|Estimación %|CI95 %|Puerta≤1%|\n|---|---|---:|---|---|\n';
for(const[family,metrics]of Object.entries(metricResults))for(const[metric,r]of Object.entries(metrics))md+='|'+family+'|'+metric+'|'+(r.estimate*100).toFixed(6)+'|['+(r.ci95[0]*100).toFixed(6)+', '+(r.ci95[1]*100).toFixed(6)+']|'+(r.pass?'PASS':'NO CUMPLIDA')+'|\n';
md+='\nBootstrap propio con aritmética BigInt para RNG LCG32:10000 remuestreos jerárquicos de6semillas y2rondas, cuartetos enteros; cifras coinciden. Fresh CPU y stressed wall tienen estimación>1%; las CI de esos dos y fresh wall no permiten acreditar≤1%. Stressed CPU sí cumple. No se elimina wall ni se amplía panel tras el resultado.\n\n681guardas internas y wrapper7516muestras/105.210hilos examinados:0incidencias,LD_PRELOADausente. Wrapper conserva code1/validfalse; causa científica, sin señal, deriva, timeout ni fallo parcial. Tiempo operativo3757,963578108s<7200: no se necesitó traspaso de supervisor. Cobertura8activos+8dormidos, lowerbounds[0,1),16IDs B y estados físicos/uses finales conciliados; ningún estado final desconocido. Usos no se convierten en visitas, exposición no en frames, costes nominales no en material recuperado.\n\nLímite verificable: '+recordCount+' registros NDJSON se reconstruyeron; '+byteCount+' bytes y SHA de stream son valores crudos registrados, porque los archivos temporales ya fueron eliminados. No afirmo relectura de esos bytes. Las pruebas finales/suite pertenecen al parent y siguen pendientes. Evidencia completa `codex9-verificacion-gate-final.json`, SHA `'+sha(outputPath)+'`. **No aprobar entrega A ni declarar objetivo9 cumplido.**\n';
fs.writeFileSync(DIR+'/revision-instrumento.md',md);review.reportSHA256=sha(DIR+'/revision-instrumento.md');fs.writeFileSync(reviewPath,JSON.stringify(review,null,2)+'\n');
console.log(JSON.stringify({outputPath,gateA:audit.gateA,counts:audit.counts,cost:audit.cost,resources:audit.resources}));
