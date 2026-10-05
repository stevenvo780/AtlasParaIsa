// AUTHORED_NOTRUN. Original App save cadence/governor/RNG/cache/clock/input budget.
// No listening server. Manual App steps alone cannot certify scheduler parity.
import { createHash } from 'node:crypto';import { mkdirSync, writeFileSync } from 'node:fs';import { join } from 'node:path';import { performance } from 'node:perf_hooks';
import { Store } from '../src/server/store.js';import { createApp } from '../src/server/app.js';
import { createObservationSession } from '../src/world/observation.js';
import { attachProcessCaller, readManifest, stable } from '../src/server/c10-process-host.js';import { externalRecorder } from '../src/server/c10-external-recorder.js';
const [mode,output,sourceSHA]=process.argv.slice(2);
if(!['A','B','C'].includes(mode)||!output||!/^[a-f0-9]{40}$/.test(sourceSHA??''))throw new Error('capsule source_guard must precede entry');
mkdirSync(output,{mode:0o700});const store=new Store(join(output,'private.sqlite'));
const session=createObservationSession({runId:'technical-NI',epochId:mode,sourceSHA,capacity:100000});
const recorder=mode==='C'?externalRecorder(join(output,'capture'),ref=>writeFileSync(join(output,'INITIAL.pin'),ref,{mode:0o600,flag:'wx'})):undefined;
const caller=recorder?attachProcessCaller(store,session,recorder.capture):undefined;
const app=createApp({store,origin:'http://127.0.0.1',password:'private-QA-only',seed:20260905,manual:true,...(mode==='C'?{observationSession:session}:{})});
const physical:string[]=[],appCuts:string[]=[],costs:number[]=[];const hash=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');
try{
 for(let i=0;i<1200;i++){
  const start=performance.now();app.stepOnce();costs.push(performance.now()-start);
  if(app.failed)throw new Error('App failure blocks NI');
  physical.push(hash(app.world));appCuts.push(hash(app.technicalParityCommonState()));
  caller?.reconcile(); // after App adoption, no forced save or drain
 }
 writeFileSync(join(output,'NI.json'),stable({mode,ticks:1200,physical,appCuts,costs,sql:readManifest(store.path),
  caller:caller?.status(),scheduler:'UNKNOWN_REQUIRES_ORIGINAL_TIMER_DRIVER',NI:'UNKNOWN',scientificAcceptance:false}));
}finally{caller?.detach();await app.close();store.close();}
