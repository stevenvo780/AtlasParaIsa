// AUTHORED_NOTRUN: kill only the spawned OWN cookie child with SIGKILL, never host.
import test from 'node:test';import assert from 'node:assert/strict';
import { fork } from 'node:child_process';import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';import { join } from 'node:path';import { tmpdir } from 'node:os';import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store.js';import { readManifest, stable } from '../src/server/c10-process-host.js';
for(const mode of ['before','after'])test(`own abrupt ${mode} COMMIT, new OS process recovery all SQL components`,async()=>{
 const directory=mkdtempSync(join(tmpdir(),'c10-owncrash-'));const cookie=randomUUID();
 const child=fork(new URL('./process-crash-child.ts',import.meta.url),[directory,cookie,mode],{execArgv:['--import','/deps/node_modules/tsx/dist/loader.mjs'],stdio:['ignore','ignore','pipe','ipc']});
 let ready=false;const timeout=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},60000);
 try {
  const [message]=await once(child,'message') as [{cookie:string;pid:number;mode:string}];
  assert.equal(message.cookie,cookie);assert.equal(message.pid,child.pid);assert.equal(message.mode,mode);ready=true;
  const exited=once(child,'exit');assert.equal(child.kill('SIGKILL'),true);await exited;
  // Parent process has never opened this DB until the writer child was gone.
  const recovery=fork(new URL('./process-recovery-child.ts',import.meta.url),[join(directory,'private.sqlite'),cookie],{execArgv:['--import','/deps/node_modules/tsx/dist/loader.mjs'],stdio:['ignore','ignore','pipe','ipc']});
  const finished=once(recovery,'exit');
  const [recovered]=await once(recovery,'message') as [{cookie:string;pid:number;slot:number|null;worldLoaded:boolean;componentFrontier:unknown}];await finished;
  assert.equal(recovered.cookie,cookie);assert.notEqual(recovered.pid,child.pid);
  const rows=readdirSync(join(directory,'capture')).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(readFileSync(join(directory,'capture',n),'utf8')));
  const receipt=rows.find(r=>r.schema==='c10-store-persistence-evidence/v1');
  if(mode==='before'){assert.equal(recovered.worldLoaded,false);assert.equal(receipt,undefined);}
  else {assert.equal(recovered.slot,0);assert.ok(receipt);assert.equal(stable(recovered.componentFrontier),stable(receipt.componentFrontier));}
 }finally{clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}rmSync(directory,{recursive:true,force:true});}
 assert.equal(ready,true);
});
