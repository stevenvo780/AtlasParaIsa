// AUTHORED_NOTRUN: actual private Store, no public data/services.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, SessionRevoked } from '../src/server/store.js';
import { createWorld, observeWorldOpening } from '../src/world/index.js';
import { createObservationSession, bindObservation, beginObservationAttempt, markObservationAttempt,
  enterObservationPhase, emitObserved, endObservationAttempt, drainObservation } from '../src/world/observation.js';
import { attachProcessCaller, readManifest, verifyReload, captureOpening, stable } from '../src/server/c10-process-host.js';
import { externalRecorder } from '../src/server/c10-external-recorder.js';
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'c10-private-'));
  const store = new Store(join(directory,'private.sqlite')); const world=createWorld(20260905);
  const session=createObservationSession({runId:'synthetic-private-nativeQA',epochId:'single',sourceSHA:'a'.repeat(40)});
  bindObservation(world,session);
  const recorder=externalRecorder(join(directory,'capture'),ref=>writeFileSync(join(directory,'INITIAL.pin'),ref,{flag:'wx',mode:0o600}));
  const caller=attachProcessCaller(store,session,recorder.capture);
  return {directory,store,world,session,recorder,caller, close(){caller.detach();store.close();rmSync(directory,{recursive:true,force:true});}};
}
test('one attempt one real save; adoption after callback; independent SQL + consistent copy + Store.load all components',()=>{
 const f=fixture();try {
  beginObservationAttempt(f.world,f.world.tick);observeWorldOpening(f.world);
  assert.equal(f.store.save(f.world),undefined);markObservationAttempt(f.world,'adopted');
  assert.equal(f.caller.reconcile()[0].ownershipReconciled,true);
  const manifest=readManifest(f.store.path);const result=verifyReload(f.store,join(f.directory,'consistent.sqlite'),manifest);
  assert.equal(result.verified,true);assert.deepEqual(result.actual,manifest);
  assert.equal(captureOpening(f.store,f.recorder.capture).state,'READ_BACKED');
 }finally{f.close();}
});
test('two equal-content saves retain separate observed operations',()=>{
 const f=fixture();try {
  beginObservationAttempt(f.world,f.world.tick);observeWorldOpening(f.world);f.store.save(f.world);f.store.save(f.world);
  const rows=f.recorder.artifacts.filter(e=>e.kind==='process-receipt').map(e=>JSON.parse(readFileSync(join(f.directory,'capture',e.path),'utf8')));
  assert.equal(rows.length,2);assert.notEqual(rows[0].commitObservationRef,rows[1].commitObservationRef);
  assert.equal(rows[0].snapshotDigest,rows[1].snapshotDigest);assert.equal('nativeTransactionId' in rows[0],false);
 }finally{f.close();}
});
test('revoke rollback and real COMMITfail do not issue process receipts',()=>{
 const f=fixture();try {
  beginObservationAttempt(f.world,f.world.tick);observeWorldOpening(f.world);
  assert.throws(()=>f.store.save(f.world,[],['nonexistent']),SessionRevoked);
  const exec=f.store.db.exec.bind(f.store.db);const sentinel=Object.freeze({opaque:true});
  f.store.db.exec=(sql:string)=>{if(sql==='COMMIT')throw sentinel;return exec(sql);};
  assert.throws(()=>f.store.save(f.world),e=>e===sentinel);
  assert.equal(f.recorder.artifacts.filter(e=>e.kind==='process-receipt').length,0);
 }finally{f.close();}
});
test('unknown Proxy exception confined without traps or stringify',()=>{
 const f=fixture();f.caller.detach();let traps=0;
 const opaque=new Proxy({}, {get(){traps++;throw 0;},getPrototypeOf(){traps++;throw 0;}});
 const caller=attachProcessCaller(f.store,f.session,{append(){throw opaque;}});
 try {beginObservationAttempt(f.world,f.world.tick);observeWorldOpening(f.world);assert.equal(f.store.save(f.world),undefined);assert.equal(traps,0);assert.equal(caller.status().unknown,true);}
 finally {caller.detach();f.close();}
});
test('full bus includes not projected sites; early drain and discarded lineage cannot be promoted',async()=>{
 const f=fixture();try {
  beginObservationAttempt(f.world,f.world.tick);enterObservationPhase(f.world,'opening');
  emitObserved(f.world,'unsupported-source-site',()=>({value:1}));markObservationAttempt(f.world,'discarded');
  await drainObservation(f.session,()=>{});f.store.save(f.world);
  assert.equal(f.caller.reconcile().every(r=>!r.ownershipReconciled),true);
  const taps=f.recorder.artifacts.filter(e=>e.kind==='source-tap').map(e=>JSON.parse(readFileSync(join(f.directory,'capture',e.path),'utf8')));
  assert.ok(taps.some(r=>r.operation==='emit'&&r.protocol==='c10-source-observer/v7'&&JSON.stringify(r.ops).includes('"unsupported-source-site"')));
 }finally{f.close();}
});
test('history-only SQL mutation changes full manifest while slot0 digest unchanged',()=>{
 const f=fixture();try {
  f.store.save(f.world);const before=readManifest(f.store.path);
  const snapshot=f.store.db.prepare('SELECT digest FROM snapshots WHERE slot=0').get();
  f.store.db.prepare('INSERT INTO events VALUES (?,?,?)').run('history-tamper',f.world.tick,'{}');
  const after=readManifest(f.store.path);assert.deepEqual(f.store.db.prepare('SELECT digest FROM snapshots WHERE slot=0').get(),snapshot);
  assert.notEqual(stable(before),stable(after));assert.notEqual(before.components.chronicle,after.components.chronicle);
 }finally{f.close();}
});
test('two attempts with one original-cadence save reconcile only adopted ancestry',()=>{
 const f=fixture();try {
  beginObservationAttempt(f.world,f.world.tick);observeWorldOpening(f.world);markObservationAttempt(f.world,'adopted');endObservationAttempt(f.world);
  beginObservationAttempt(f.world,f.world.tick);observeWorldOpening(f.world);f.store.save(f.world);markObservationAttempt(f.world,'adopted');
  const rows=f.caller.reconcile();assert.equal(rows[0].attemptRefs.length,2);assert.equal(rows[0].ownershipReconciled,true);
 }finally{f.close();}
});

test('original error after real COMMIT remains same opaque sentinel, committed SQL survives before ACK',()=>{
 const f=fixture();const sentinel=Object.freeze({opaque:'postCOMMIT'});const original=f.world.retiredChunks;
 try {
  beginObservationAttempt(f.world,f.world.tick);observeWorldOpening(f.world);
  Object.defineProperty(f.world,'retiredChunks',{configurable:true,get(){return original;},set(){throw sentinel;}});
  assert.throws(()=>f.store.save(f.world),error=>error===sentinel);
  assert.equal(f.store.db.isTransaction,false);assert.ok(f.store.load());
  assert.equal(f.recorder.artifacts.filter(e=>e.kind==='process-receipt').length,1);
  assert.equal(f.caller.reconcile()[0].ownershipReconciled,false);
 }finally{f.close();}
});
