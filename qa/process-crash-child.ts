// AUTHORED_NOTRUN. Only own child; host/OS stays alive. Callback blocks before ACK.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createWorld, observeWorldOpening } from '../src/world/index.js';
import { bindObservation, beginObservationAttempt, createObservationSession } from '../src/world/observation.js';
import { attachProcessCaller } from '../src/server/c10-process-host.js';
import { externalRecorder } from '../src/server/c10-external-recorder.js';
const [directory,cookie,mode]=process.argv.slice(2);
if (!directory || !cookie || !['before','after'].includes(mode)) throw new Error('own child arguments');
const store=new Store(join(directory,'private.sqlite'));const world=createWorld(20260905);
const session=createObservationSession({runId:cookie,epochId:mode,sourceSHA:'a'.repeat(40)});bindObservation(world,session);
const recorder=externalRecorder(join(directory,'capture'),ref=>writeFileSync(join(directory,'INITIAL.pin'),ref,{flag:'wx',mode:0o600}));
const sendAndBlock=()=>{process.send?.({cookie,pid:process.pid,mode});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);throw new Error('parent did not terminate child');};
attachProcessCaller(store,session,{append(kind,row){const ref=recorder.capture.append(kind,row);
 if(kind==='process-receipt'&&mode==='after')sendAndBlock();return ref;}});
beginObservationAttempt(world,world.tick);observeWorldOpening(world);
if(mode==='before')sendAndBlock();store.save(world);throw new Error('unexpected ACK reached');
