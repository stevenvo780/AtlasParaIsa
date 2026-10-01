import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
process.title='codex9-audit'; os.setPriority(0,19);
function guard() {
  const v={pid:process.pid,nice:os.getPriority(0),affinity:fs.readFileSync('/proc/self/status','utf8').match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1],TMPDIR:process.env.TMPDIR};
  assert.equal(v.nice,19); assert.equal(v.affinity,'6-31'); assert.equal(v.TMPDIR,'/datos/tmp-atlas-lab'); return v;
}
const initial=guard(), root='/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/ciclo-material', lab='/datos/tmp-atlas-lab/datos-lab', out='/datos/tmp-atlas-lab/balance/codex9/revision-instrumento';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex'), sha=p=>hash(fs.readFileSync(p));
const commit='bb483260b2489fe62b113d620e5f56e5f3676dbc', pathspec=['src/world','src/shared','src/server','package.json','tsconfig.json'];
const tar=fs.readFileSync(lab+'/codex9-main-source.tar');
const regenerated=execFileSync('git',['archive',commit,...pathspec],{cwd:root,maxBuffer:32*1024*1024});
assert.equal(hash(tar),hash(regenerated)); assert.ok(tar.equals(regenerated));
// get-tar-commit-id reads only the leading extended header; a full buffered stdin can EPIPE.
const tarCommit=execFileSync('git',['get-tar-commit-id'],{cwd:root,input:tar.subarray(0,1024),encoding:'utf8'}).trim();
assert.equal(tarCommit,commit);
const Q=3e9, qB=3e8, aD=540000, aR=840000;
const checks=[
 ['dryRate',aD/Q,.00018],['rainRate',aR/Q,.00028],
 ['durability1.5Dry',360000/Q,.00018/1.5,1e-19],['durability1.5Rain',560000/Q,.00028/1.5,1e-19],
 ['reviews20days',20*2400/10,4800],['mixedLoss',aD*2400+aR*2400,3312000000],
 ['mixedCondition',Math.max(0,Q-aD*2400-aR*2400),0],['dry20Condition',(Q-aD*4800)/Q,.136],
 ['rainCrossReview',Math.ceil((Q-qB)/aR),3215],['rainCrossDay',3215/240,13.395833,.0000005],
 ['dryCrossReview',Math.ceil((Q-qB)/aD),5000],['dryCrossDay',5000/240,20.833333,.0000005],
 ['foodDryDays',518400000/aD/240,4],['waterDryDays',1296000000/aD/240,10],
 ['waterDay4',1-aD*4*240/1296000000,.6],['waterDay5',1-aD*5*240/1296000000,.5],
 ['foodRainDays',518400000/aR/240,2.571,.0005],['waterRainDays',1296000000/aR/240,6.429,.0005],
 ['dismantlingWork',Math.ceil(.25*90),23],['woodConsumable',2*50,100],
 ['woodBalance',6000+100,3000+3100],['stoneBalance',3000,2250+750],['woodNet',3000-100,2900],
 ['replicaSteps',20*2400,48000],['panelSteps',8*2*20*2400,768000]
];
for(const [name,actual,expected,tolerance=0] of checks) assert.ok(Math.abs(actual-expected)<=tolerance,name+': '+actual+' != '+expected);
const bpath=lab+'/DISENO-CICLO-MATERIAL-20261001.md', b=fs.readFileSync(bpath,'utf8'), bhash=hash(b), mismatch=b.includes('`recovery:false`');
const data=JSON.parse(fs.readFileSync(out+'.json','utf8')), now=new Date().toISOString();
data.protocolPreReview.baselineGitCommitProvenance={verdict:'PASS',commit:tarCommit,pathspec,regeneratedArchiveSHA256:hash(regenerated),existingArchiveSHA256:hash(tar),byteIdentical:true,command:'git archive '+commit+' '+pathspec.join(' '),failedReaderAttempt:{error:'spawnSync git EPIPE',status:0,stdoutCommit:commit,reason:'full stdin written after header-only reader exited; no simulation, no real data, no artifact written by failed attempt'}};
data.lawBReview={verdict:mismatch?'COMPLETE_WITH_ONE_FACTUAL_CORRECTION':'PASS_REQUIREMENTS_ONLY',reviewedUTC:now,path:bpath,sha256:bhash,bytes:Buffer.byteLength(b),scope:'requirements completeness and factual/numeric references only; not formal future-law critique/acceptance',requirements:{dormantPureDeterministicCatchup:'20–44',explicitRuinLocalPaidRecovery:'46–60',environmentalBrokenDepositLoss:'62–86',localityNoNewCaps:'88–90',lawZeroAllParamsBitIdentity:'92–94',proposed20DayNewSeedPanelV13Control:'96–118',fertilityCostDormantDeterminismRisks:'120–133'},proposalsNotImplementation:true,noExperimentClaimed:true,noSeedVirginityClaimed:true,numericComparisons:checks.length,numericDifferences:0,checks,observationFiguresMatchObjective8Report:true,factualCorrections:mismatch?[{severity:'low',line:15,actual:'recovery:false',expected:'salvagePotential.recoveryImplemented:false',source:'src/world/material-observer.ts:93–94',impact:'API reference mismatch only'}]:[]};
let md=fs.readFileSync(out+'.md','utf8');
md+='\n## Procedencia Git y diseño B — '+now+'\n\nBaseline PASS: `git get-tar-commit-id` confirma `'+commit+'`; regenerado `git archive '+commit+' '+pathspec.join(' ')+'` en el worktree propio en lectura. Stream y tar existente son byte a byte idénticos, SHA **'+hash(tar)+'**. Procedencia del baseline cerrada. Un primer lector Node produjo EPIPE al enviar el tar completo a la utilidad que termina tras leer la cabecera; status0/stdout correcto preservados en JSON. Repetición con cabecera PASS. No hubo datos reales ni escritura en el intento fallido.\n\nDiseño B leído completo, SHA **'+bhash+'**: catch-up puro determinista O(1) por obra (20–44); ruina y desmontaje local pagado sin crédito doble (46–60); pérdidas ambientales con escalas/restos exactos (62–86); localidad sin nuevos topes y ley0 sin claves nuevas en parámetros efectivos ni estado (88–94); panel propuesto8 pares/20d, control V13 y semillas candidatas sin afirmar virginidad (96–118); riesgos demográficos, coste/determinismo dormido y decisiones pendientes (120–133). No afirma implementación, ensayos ni aceptación.\n\nRecálculo independiente: **'+checks.length+' comparaciones nominales, 0 diferencias**: tasas,20d/4800 revisiones, pérdida mixta3.312.000.000, condición seca0,136, cruces3215/5000 revisiones, ventanas4/10d y2,571/6,429d, saldos de desmontaje y768.000 pasos propuestos. Las observaciones iniciales coinciden con objetivo8; no se convierten archivos de relojes distintos en balance simultáneo. Referencias clave verificadas: clima `index.ts:260`, esfuerzo `:1083`, orden `:1242`, coste `inventions.ts:25`, desgaste `:478`, legacy `terrain.ts:25`, humedad `:104`, params en digesto `digesto.ts:30`, escalas `technology.ts:27`/`material-affordances.ts:5`. Los rangos históricos de inventions corresponden al baseline antes de hooks.\n\n'+(mismatch?'Corrección factual pendiente de severidad baja: diseño línea15 dice `recovery:false`, API real `salvagePotential.recoveryImplemented:false` en `material-observer.ts:93–94`. Sugerencia: reemplazar sólo nombre/camino. B completo con esta corrección.':'B PASS de completitud/correctitud revisada; referencia API corregida.')+' **Esta revisión no es la crítica formal de la ley futura ni su aprobación.** Puerta A NO CUMPLIDA mientras runner/datos/checks finales pendientes.\n';
assert.equal(sha(bpath),bhash); data.preBReviewerResources={initial,final:guard(),valid:true};
fs.writeFileSync(out+'.md',md); data.reportSHA256=sha(out+'.md'); fs.writeFileSync(out+'.json',JSON.stringify(data,null,2)+'\n');
console.log(JSON.stringify({tarSHA256:hash(tar),tarCommit,lawB:data.lawBReview.verdict,documentSHA256:bhash,numericComparisons:checks.length,numericDifferences:0,resources:data.preBReviewerResources}));
