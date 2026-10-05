// AUTHORED_NOTRUN single-attempt candidate; no synthetic/native receipt promotion.
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';import { join } from 'node:path';
import { Store } from '../src/server/store.js';import { createWorld, observeWorldOpening } from '../src/world/index.js';
import { createObservationSession,bindObservation,beginObservationAttempt,markObservationAttempt } from '../src/world/observation.js';
import { attachProcessCaller,readManifest,verifyReload,captureOpening,stable } from '../src/server/c10-process-host.js';import { externalRecorder } from '../src/server/c10-external-recorder.js';
const [output,sourceSHA,dependencyManifest,dependencySHA256,proofRelative]=process.argv.slice(2);
if(!output||!sourceSHA||!dependencyManifest||!dependencySHA256||!proofRelative)throw new Error('controller capsule arguments');
mkdirSync(output,{mode:0o700});const store=new Store(join(output,'private.sqlite'));const world=createWorld(20260905);
const session=createObservationSession({runId:'controller-single',epochId:'single',sourceSHA});bindObservation(world,session);
const recorder=externalRecorder(join(output,'capture'),ref=>writeFileSync(join(output,'INITIAL.pin'),ref,{flag:'wx',mode:0o600}));
const caller=attachProcessCaller(store,session,recorder.capture);
try{
 beginObservationAttempt(world,world.tick);observeWorldOpening(world);store.save(world);markObservationAttempt(world,'adopted');caller.reconcile();
 const frontier=readManifest(store.path);const reload=verifyReload(store,join(output,'consistent.sqlite'),frontier);
 recorder.capture.append('normal-reload',{mode:'CLEAN_RELOAD_ONLY',...reload});captureOpening(store,recorder.capture);
 copyFileSync(dependencyManifest,join(output,'capture','deps.json'));
 const pins=recorder.finish('deps.json',dependencySHA256,proofRelative);
 writeFileSync(join(output,'FINAL.pins.json'),stable(pins),{flag:'wx',mode:0o600});
 // External controller copies the INITIAL pin before run and publishes custody;
 // this entry does not produce nativeQA VERIFIED or processRecovery verified.
 writeFileSync(join(output,'candidate.json'),stable({candidate:'GOCANDIDATE_QA_SINGLEATTEMPT_ONLY',reload:reload.verified,processRecovery:'UNKNOWN',normalAppIngestion:false,scientificAcceptance:false}));
}finally{caller.detach();store.close();}
