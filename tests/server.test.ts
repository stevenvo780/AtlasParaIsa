import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Store } from '../src/server/store.js';
import { createApp, parseGesture, loginKey, trustedProxiesFromEnv, rate } from '../src/server/app.js';
import { createWorld, stepWorld, projectWorld } from '../src/world/index.js';
import { parseParams, setParams } from '../src/world/params.js';
import { hashToken, makeToken, passwordRecord, passwordVerifier } from '../src/server/auth.js';
import { acquireLock } from '../src/server/lock.js';
import type { Gesture, ServerMessage, WorldView } from '../src/shared/types.js';

const password = 'synthetic-test-password-only';

function socketMessage(socket: WebSocket, type: ServerMessage['type']): Promise<ServerMessage> {
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{socket.off('message',receive);reject(new Error(`Missing ${type} message`));},3000);
    function receive(data:import('ws').RawData){const message=JSON.parse(data.toString()) as ServerMessage;if(message.type===type){clearTimeout(timeout);socket.off('message',receive);resolve(message);}}
    socket.on('message',receive);
  });
}
/** Broadcasts queued while nobody was reading arrive in a burst: a snapshot of the past answers
 * nothing about now, so the listener stays until one from `tick` onwards shows up. */
function stateFrom(socket: WebSocket, tick: number): Promise<WorldView> {
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{socket.off('message',receive);reject(new Error(`Sin estado en el paso ${tick} o posterior`));},5000);
    function receive(data:import('ws').RawData){const message=JSON.parse(data.toString()) as ServerMessage;if(message.type==='state'&&message.world.tick>=tick){clearTimeout(timeout);socket.off('message',receive);resolve(message.world);}}
    socket.on('message',receive);
  });
}
const gesture: Gesture = { id: 'test-plant-0001', kind: 'plant', x: 20, y: 14 };
async function freePort() {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as {port:number}).port;
  await new Promise<void>(resolve => probe.close(() => resolve())); return port;
}
async function fixture(t: { after: (f: () => unknown) => void }, manual = false) {
  const dir = mkdtempSync(join(tmpdir(), 'carta-test-'));
  const store = new Store(join(dir, 'world.sqlite'));
  const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
  const app = createApp({ store, password, origin, manual, tickMs: 15, seed: 42 });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const send = (g: unknown, cookieValue = cookie) => fetch(origin + '/api/gesture', { method: 'POST', headers: { Origin: origin, Cookie: cookieValue, 'Content-Type': 'application/json' }, body: JSON.stringify(g) });
  return { app, store, origin, cookie, send, dir };
}

test('two authenticated clients share one authoritative timeline and input transaction while their cameras stay independent', async t => {
  const f=await fixture(t,true);
  const login=await fetch(f.origin+'/api/login',{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json'},body:JSON.stringify({password})});
  const cookie2=login.headers.get('set-cookie')!.split(';')[0];
  const a=new WebSocket(f.origin.replace('http:','ws:')+'/ws',{headers:{Origin:f.origin,Cookie:f.cookie}});
  const b=new WebSocket(f.origin.replace('http:','ws:')+'/ws',{headers:{Origin:f.origin,Cookie:cookie2}});
  t.after(()=>{a.terminate();b.terminate();});
  const initial=await Promise.all([socketMessage(a,'state'),socketMessage(b,'state')]);
  assert.ok(initial.every(m=>m.type==='state'&&m.world.tick===0));
  const before=structuredClone(f.app.world);const moved=socketMessage(b,'state');
  b.send(JSON.stringify({type:'viewport',viewport:{x:-1000,y:2000,width:40,height:28}}));await moved;
  assert.deepEqual(f.app.world,before,'camera and login do not create or advance a simulation');
  const sameTick=Promise.all([socketMessage(a,'state'),socketMessage(b,'state')]);
  for(let n=0;n<5;n++)f.app.stepOnce();
  const [av,bv]=await sameTick;assert.equal(f.app.world.tick,5);
  assert.ok(av?.type==='state'&&bv?.type==='state');
  // T134 (FR-017/FR-026): `people` ahora se recorta por cámara — `b` la movió lejos (-1000,2000) y
  // legítimamente ve un reparto distinto (aquí, vacío). El invariante de «una sola línea de tiempo
  // autoritativa» pasa a probarse con lo que SÍ es ajeno a la cámara: el tick, la crónica y el censo
  // (`stats.census`, agregado sobre TODA la población en el servidor).
  assert.equal(av.world.tick,bv.world.tick);assert.deepEqual(av.world.events,bv.world.events);assert.deepEqual(av.world.stats!.census,bv.world.stats!.census);assert.notDeepEqual(av.world.people,bv.world.people,'cámaras distintas ahora ven repartos de personas distintos');assert.notEqual(av.world.originX,bv.world.originX);
  // WebSocket message order makes a subsequent camera response a fence: the preceding
  // command has entered the server queue, but cannot commit before the manual step.
  for(const [socket,id,person] of [[a,'shared-client-a',f.app.world.people[0]!],[b,'shared-client-b',f.app.world.people[1]!]] as const){
    const fence=socketMessage(socket,'state');socket.send(JSON.stringify({type:'gesture',gesture:{id,kind:'command',agentId:person.id,order:'rest',x:person.x,y:person.y}}));
    socket.send(JSON.stringify({type:'viewport',viewport:{x:0,y:0,width:40,height:28}}));await fence;
  }
  const results=Promise.all([socketMessage(a,'result'),socketMessage(b,'result')]);
  const states=Promise.all([socketMessage(a,'state'),socketMessage(b,'state')]);f.app.stepOnce();
  const accepted=await results;assert.ok(accepted.every(m=>m.type==='result'&&m.result.accepted&&m.result.tick===6));
  assert.deepEqual(accepted.map(m=>m.type==='result'?m.result.order:-1),[0,1]);
  const shared=await states;assert.ok(shared[0]?.type==='state'&&shared[1]?.type==='state');assert.deepEqual(shared[0].world.people,shared[1].world.people);
  assert.equal(f.app.world.tick,6);assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM inputs').get() as {n:number}).n,2);assert.deepEqual(f.store.load()!.world,f.app.world);
});

test('access is mandatory, origin is enforced, private projections exclude internal state', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin + '/api/world')).status, 401);
  assert.equal((await fetch(f.origin + '/api/gesture', { method: 'POST', headers: {Origin:f.origin,'Content-Type':'application/json'}, body:JSON.stringify(gesture) })).status, 401);
  const noOrigin = await fetch(f.origin + '/api/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
  assert.equal(noOrigin.status, 403); assert.equal(noOrigin.headers.get('set-cookie'), null);
  const res = await fetch(f.origin + '/api/world', {headers:{Cookie:f.cookie}});
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
  const view = await res.json() as WorldView;
  assert.equal(view.people.length, 16);
  assert.ok(!('rng' in view)); assert.ok(!('seed' in view));
  assert.ok(!JSON.stringify(view).includes('privateSource'));
  assert.ok(view.memories.every(m => m.source === 'sample'));
});

test('gestures are atomically recorded and an identical retry returns the original result', async t => {
  const f = await fixture(t);
  const first = await f.send(gesture); assert.equal(first.status, 200);
  const result = await first.json();
  const second = await f.send(gesture); assert.deepEqual(await second.json(), result);
  assert.equal((f.store.db.prepare('SELECT COUNT(*) AS n FROM inputs').get() as {n:number}).n, 1);
  const stored = f.store.load()!;
  assert.ok(stored.world.tick >= (result as {tick:number}).tick);
  const conflict = await f.send({...gesture,x:gesture.x+1}); assert.equal(conflict.status, 409);
  const invalid = await f.send({...gesture,id:'different-id',x:NaN}); assert.equal(invalid.status, 400);
});

test('no browser connected: server advances and committed chronicle exactly matches visible facts', async t => {
  const f = await fixture(t); const start = f.app.world.tick;
  await new Promise<void>(resolve => setTimeout(resolve, 160));
  assert.ok(f.app.world.tick > start);
  const saved = f.store.load()!.world;
  assert.deepEqual(saved, f.app.world);
  for (const e of projectWorld(saved).events) {
    const row = f.store.db.prepare('SELECT body FROM events WHERE id=?').get(e.id) as {body:string};
    assert.deepEqual(JSON.parse(row.body), e);
  }
});

test('transaction failure rolls back world, facts and input IDs together', () => {
  const store = new Store(':memory:');
  try {
    const world = createWorld(42); store.save(world); const before = store.load();
    const draft = structuredClone(world); const results = stepWorld(draft, [gesture]);
    store.db.exec("CREATE TRIGGER fail_input BEFORE INSERT ON inputs BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END;");
    assert.throws(() => store.save(draft, [{gesture,result:results[0]}]), /injected commit failure/);
    assert.deepEqual(store.load(), before); assert.equal(store.result(gesture), null);
    for (const event of draft.events.filter(e => !world.events.some(old => old.id === e.id))) assert.equal(store.db.prepare('SELECT id FROM events WHERE id=?').get(event.id), undefined);
  } finally {store.close();}
});

test('save failure halts the world and never acknowledges a discarded gesture', async t => {
  const f = await fixture(t); const before = structuredClone(f.app.world);
  f.store.save = () => { throw new Error('injected disk full'); };
  const response = await f.send(gesture); assert.equal(response.status, 503);
  assert.ok(f.app.failed); assert.deepEqual(f.app.world, before);
  assert.equal(f.store.result(gesture), null);
  assert.equal((await f.send({...gesture,id:'later-input-0001'})).status, 503);
  assert.equal((await fetch(f.origin + '/health')).status, 503);
  const res = await fetch(f.origin + '/api/world', {headers:{Cookie:f.cookie}});
  assert.equal((await res.json() as WorldView).paused, true);
});

test('restart restores intention, memory, PRNG and body without retrospective simulation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'carta-restart-')); const path = join(dir, 'world.sqlite');
  let store = new Store(path);
  try {
    const initial = createWorld(42); for(let i=0;i<30;i++) stepWorld(initial);
    store.save(initial); store.close(); store = new Store(path);
    assert.deepEqual(store.load()!.world, initial);
    const app = createApp({store,password,origin:'http://127.0.0.1:3000',manual:true});
    assert.equal(app.world.tick, initial.tick);
    const actual = structuredClone(app.world); actual.events = initial.events;
    assert.deepEqual(actual, initial);
    assert.equal(app.world.events.at(-1)?.kind, 'pause');
    assert.deepEqual(store.load()!.world, app.world); void app.close();
  } finally {store.close(); rmSync(dir,{recursive:true,force:true});}
});

test('checksum/schema corruption and missing committed snapshot fail closed', () => {
  const store = new Store(':memory:');
  try {
    store.save(createWorld(42));
    store.db.exec("UPDATE snapshots SET body='{}' WHERE slot=0");
    assert.throws(() => store.load(), /checksum/);
    store.db.exec('DELETE FROM snapshots WHERE slot=0');
    assert.throws(() => store.load(), /missing/);
    assert.equal(store.db.prepare('SELECT slot FROM snapshots WHERE slot=0').get(), undefined);
  } finally {store.close();}
});

test('backup is coherent, validates after reopening, and does not overwrite an existing file', () => {
  const dir = mkdtempSync(join(tmpdir(),'carta-backup-')); const store = new Store(join(dir,'world.sqlite'));
  try {
    const world=createWorld(42); for(let i=0;i<5;i++)stepWorld(world); store.save(world);
    const dest=join(dir,'copy.sqlite'); store.backup(dest);
    const backup=new Store(dest); assert.deepEqual(backup.load()!.world,world); backup.close();
    assert.throws(()=>store.backup(dest),/exists/);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('websocket requires session and exact origin, reconnect returns a current view, revoke closes it', async t => {
  const f = await fixture(t);
  const rejected = async (headers: Record<string,string>) => {
    const client=new WebSocket(f.origin.replace('http:','ws:')+'/ws',{headers});
    client.on('error',()=>{});
    const [request, response] = await once(client,'unexpected-response');
    assert.ok([401,403].includes(response.statusCode)); request.destroy(); client.terminate();
  };
  await rejected({Origin:f.origin}); await rejected({Cookie:f.cookie});
  const client=new WebSocket(f.origin.replace('http:','ws:')+'/ws',{headers:{Origin:f.origin,Cookie:f.cookie}});
  const [data]=await once(client,'message');
  assert.equal(JSON.parse(data.toString()).type,'state');
  client.close(); await once(client,'close');
  const next=new WebSocket(f.origin.replace('http:','ws:')+'/ws',{headers:{Origin:f.origin,Cookie:f.cookie}});
  const [current]=await once(next,'message');
  assert.ok(JSON.parse(current.toString()).world.tick>=JSON.parse(data.toString()).world.tick);
  f.store.revoke(); const [code]=await once(next,'close'); assert.equal(code,4001);
  assert.equal((await fetch(f.origin+'/api/world',{headers:{Cookie:f.cookie}})).status,401);
});

test('revocation between queue and commit prevents the gesture', async t => {
  const f=await fixture(t,true);
  const client=new WebSocket(f.origin.replace('http:','ws:')+'/ws',{headers:{Origin:f.origin,Cookie:f.cookie}});
  await once(client,'message');
  client.send(JSON.stringify({type:'gesture',gesture}));
  await new Promise<void>(resolve=>setTimeout(resolve,25));
  const before=structuredClone(f.app.world); f.store.revoke(); f.app.stepOnce();
  assert.equal(f.store.result(gesture),null);
  assert.ok(!f.app.world.events.some(e=>e.kind==='gesture'&&!before.events.some(b=>b.id===e.id)));
  client.terminate();
});

test('passwords use salted verification; parser rejects unexpected fields; instance locking is exclusive', () => {
  assert.notEqual(passwordRecord(password),passwordRecord(password));
  const verify=passwordVerifier({password}); assert.ok(verify(password)); assert.ok(!verify('incorrect'));
  assert.throws(()=>passwordVerifier({}),/Falta configurar/);
  assert.throws(()=>parseGesture({...gesture,admin:true})); assert.throws(()=>parseGesture({...gesture,x:1.5}));
  const dir=mkdtempSync(join(tmpdir(),'carta-lock-')); const path=join(dir,'world.lock');
  const unlock=acquireLock(path); assert.throws(()=>acquireLock(path),/Another/);unlock();
  const second=acquireLock(path);second();rmSync(dir,{recursive:true,force:true});
  assert.equal(hashToken(makeToken()).length,64);
});

test('revocation immediately before transaction discards the draft without halting the service', async t => {
  const f=await fixture(t);
  const other = new Store(join(f.dir,'world.sqlite')); const save=f.store.save.bind(f.store);
  let injected=false;
  f.store.save=(world,inputs,sessions)=>{
    if (inputs?.length && !injected) {injected=true;other.revoke();}
    return save(world,inputs,sessions);
  };
  try {
    const response=await f.send(gesture); assert.equal(response.status,401);
    assert.equal(f.store.result(gesture),null);assert.equal(f.app.failed,false);
  } finally {other.close();}
});

test('missing ledger table is corruption, never recreated on reopening', () => {
  const dir=mkdtempSync(join(tmpdir(),'carta-schema-'));const path=join(dir,'world.sqlite');
  const store=new Store(path);store.save(createWorld(42));store.db.exec('DROP TABLE inputs');store.close();
  try {assert.throws(()=>new Store(path),/schema is incomplete/);}
  finally {rmSync(dir,{recursive:true,force:true});}
});

test('recover previous checkpoint removes later idempotency and preserves original evidence', () => {
  const dir=mkdtempSync(join(tmpdir(),'carta-previous-'));const path=join(dir,'world.sqlite');const store=new Store(path);
  try {
    const world=createWorld(42);store.save(world);const previous=structuredClone(world);
    const results=stepWorld(world,[gesture]);store.save(world,[{gesture,result:results[0]}]);
    const output=join(dir,'recovered.sqlite');store.previous(output);
    const copy=new Store(output);assert.deepEqual(copy.load()!.world,previous);assert.equal(copy.result(gesture),null);copy.close();
    assert.deepEqual(store.load()!.world,world);assert.deepEqual(store.result(gesture),results[0]);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('actual crash releases instance lock and a new process recovers the committed world and input', async () => {
  const dir=mkdtempSync(join(tmpdir(),'carta-crash-')); const lock=join(dir,'world.lock');const path=join(dir,'world.sqlite');
  const moduleUrl=pathToFileURL(join(process.cwd(),'src/server/lock.ts')).href;
  const storeUrl=pathToFileURL(join(process.cwd(),'src/server/store.ts')).href;
  const worldUrl=pathToFileURL(join(process.cwd(),'src/world/index.ts')).href;
  const code=`import {acquireLock} from ${JSON.stringify(moduleUrl)}; import {Store} from ${JSON.stringify(storeUrl)}; import {createWorld,stepWorld} from ${JSON.stringify(worldUrl)}; const held=acquireLock(${JSON.stringify(lock)}); const s=new Store(${JSON.stringify(path)}); const w=createWorld(42); const g=${JSON.stringify(gesture)}; const r=stepWorld(w,[g]); s.save(w,[{gesture:g,result:r[0]}]); console.log('committed'); setInterval(()=>{ void held; },1000);`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
  try {
    const [data]=await once(child.stdout,'data');assert.match(data.toString(),/committed/);
    assert.throws(()=>acquireLock(lock),/Another/); child.kill('SIGKILL');await once(child,'exit');
    const unlock=acquireLock(lock);const store=new Store(path);
    assert.equal(store.load()!.world.tick,1);assert.equal(store.result(gesture)?.tick,1);store.close();unlock();
  } finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});}
});

test('restore CLI uses a coherent read-only source and revokes restored sessions', () => {
  const dir=mkdtempSync(join(tmpdir(),'carta-restore-cli-'));const source=join(dir,'source.sqlite');const store=new Store(source);
  const world=createWorld(42);store.save(world);store.addSession(hashToken('sample'),Date.now()+60_000);store.close();
  try {
    const output=join(dir,'restored');
    const result=spawnSync(process.execPath,['--import','tsx','scripts/storage.ts','restore',source],{cwd:process.cwd(),env:{...process.env,CARTA_DATA_DIR:output},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);const restored=new Store(join(output,'world.sqlite'));
    assert.deepEqual(restored.load()!.world,world);assert.equal(restored.sessionValid(hashToken('sample')),false);restored.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('previous-checkpoint CLI holds the destination lock throughout recovery', () => {
  const dir=mkdtempSync(join(tmpdir(),'carta-previous-cli-'));const source=join(dir,'source');const target=join(dir,'target');
  const store=new Store(join(source,'world.sqlite'));const world=createWorld(42);store.save(world);const previous=structuredClone(world);stepWorld(world);store.save(world);store.close();
  const run=()=>spawnSync(process.execPath,['--import','tsx','scripts/storage.ts','previous',target],{env:{...process.env,CARTA_DATA_DIR:source},encoding:'utf8'});
  try {
    const release=acquireLock(join(target,'world.lock'));
    const blocked=run();assert.equal(blocked.status,1);assert.equal(existsSync(join(target,'world.sqlite')),false);release();
    const recovered=run();assert.equal(recovered.status,0,recovered.stderr);
    const result=new Store(join(target,'world.sqlite'));assert.deepEqual(result.load()!.world,previous);result.close();
    const original=new Store(join(source,'world.sqlite'));assert.deepEqual(original.load()!.world,world);original.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('the snapshot carries procedure summaries and a definition is served only when asked, without advancing the world',async t=>{
  const f=await fixture(t,true);
  const socket=new WebSocket(f.origin.replace('http:','ws:')+'/ws',{headers:{Origin:f.origin,Cookie:f.cookie}});
  t.after(()=>socket.terminate());
  const initial=await socketMessage(socket,'state');
  assert.ok(initial.type==='state');
  assert.equal(JSON.stringify(initial.world.technology!.recipes).includes('"program"'),false);
  // The promise of this task is «I open a procedure and I see its steps»: it needs a world that
  // discovered one, served through the same catalogue the public world uses.
  for(let n=0;n<600&&!f.app.world.technology.recipes.length;n++)f.app.stepOnce();
  assert.ok(f.app.world.technology.recipes.length>0,`sin procedimiento tras ${f.app.world.tick} pasos`);
  assert.ok(f.app.world.technology.catalogue,'el mundo servido resuelve por catálogo, como en producción');
  const id=f.app.world.technology.recipes[0]!.id;
  // `send` drops a snapshot while the socket is behind: stepping in a tight loop leaves the client in the
  // past on purpose. Let the buffer drain, then step with the listener already waiting.
  await new Promise<void>(resolve=>setTimeout(resolve,200));
  const pendingState=stateFrom(socket,f.app.world.tick);
  for(let n=0;n<5;n++){f.app.stepOnce();await new Promise<void>(resolve=>setTimeout(resolve,10));}
  const latest=await pendingState;
  const summary=latest.technology!.recipes.find(recipe=>recipe.id===id);
  assert.ok(summary&&!('program' in summary),'el snapshot lista el procedimiento sin sus pasos');
  const before=structuredClone(f.app.world);
  const known=f.app.world.technology.recipes.find(recipe=>recipe.id===id)!;
  const asked=socketMessage(socket,'recipe');
  socket.send(JSON.stringify({type:'recipe',id}));
  const served=await asked;
  assert.ok(served.type==='recipe'&&served.id===id&&served.recipe!==null,'el programa pedido llega por el socket');
  const program=served.type==='recipe'?served.recipe:null;
  assert.ok(program&&program.program.steps.length>0&&program.program.inputs.length>0,'un programa servido tiene pasos y entradas');
  assert.deepEqual(program,JSON.parse(JSON.stringify(known)),'lo servido es la definición residente tal como el cable puede llevarla');
  const absent=`recipe-${f.app.world.technology.recipeCounter+1000}`;
  const unknown=socketMessage(socket,'recipe');
  socket.send(JSON.stringify({type:'recipe',id:absent}));
  assert.deepEqual(await unknown,{type:'recipe',id:absent,recipe:null},'an absent definition is null, never an empty program');
  for(const id of ['recipe-0','recipe-x','',42,null]){
    const rejected=socketMessage(socket,'error');
    socket.send(JSON.stringify({type:'recipe',id}));
    const message=await rejected;assert.ok(message.type==='error'&&/procedimiento no válido/.test(message.message),String(id));
  }
  assert.deepEqual(f.app.world,before,'a query is not a transaction: nothing was stepped or saved');
  // A long life evicts a resident definition (`cacheRecipe` keeps the last `maxRecipes`): from then on the
  // only copy is the archived one and the reader is the store's. That branch must serve the same program.
  assert.ok(!f.app.world.technology.catalogue!.pending.some(recipe=>recipe.id===id),'la definición ya está comprometida en el archivo');
  f.app.world.technology.recipes=f.app.world.technology.recipes.filter(recipe=>recipe.id!==id);
  const evicted=socketMessage(socket,'recipe');
  socket.send(JSON.stringify({type:'recipe',id}));
  assert.deepEqual(await evicted,{type:'recipe',id,recipe:JSON.parse(JSON.stringify(known))},'un programa archivado se sirve igual que uno residente');
});

test('a committed retry remains retrievable during a later storage pause',async t=>{
  const f=await fixture(t);const first=await f.send(gesture);assert.equal(first.status,200);const committed=await first.json();
  f.store.save=()=>{throw new Error('later synthetic failure');};
  await new Promise<void>(resolve=>setTimeout(resolve,50));assert.equal(f.app.failed,true);
  const retried=await f.send(gesture);assert.equal(retried.status,200);assert.deepEqual(await retried.json(),committed);
});

test('con cadencia 20 el paso no reescribe el mundo en cada tick, un gesto fuerza el guardado y el estado publica el ritmo real',async t=>{
  const f=await fixture(t,true);
  setParams(f.app.world,parseParams('persistencia.cadaTicks=20'));
  const savedTick=()=>JSON.parse((f.store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as {body:string}).body).tick as number;
  assert.equal(savedTick(),0);
  for(let n=0;n<5;n++)f.app.stepOnce();
  assert.equal(f.app.world.tick,5);assert.equal(savedTick(),0,'entre múltiplos de la cadencia no se persiste');
  const inflight=f.send({...gesture,id:'cadence-gesture-01'});
  await new Promise<void>(resolve=>setTimeout(resolve,25));
  f.app.stepOnce();
  assert.equal((await inflight).status,200);
  assert.equal(savedTick(),6,'un gesto confirmado obliga a guardar en su propio paso');
  while(f.app.world.tick<20)f.app.stepOnce();
  assert.equal(savedTick(),20,'la cadencia guarda al cruzar el múltiplo');
  assert.deepEqual(f.store.load()!.world,f.app.world);
  const view=await (await fetch(f.origin+'/api/world',{headers:{Cookie:f.cookie}})).json() as WorldView;
  assert.ok(Number.isFinite(view.performance!.tickHz)&&view.performance!.tickHz>0,'el ritmo real se mide, no se declara');
});

test('el planificador cita cada paso con compensación de deriva y el cierre no deja pasos pendientes',async t=>{
  const f=await fixture(t);
  await new Promise<void>(resolve=>setTimeout(resolve,300));
  const advanced=f.app.world.tick;
  assert.ok(advanced>=8&&advanced<=30,`el mundo avanzó ${advanced} pasos en 300 ms a 15 ms de cadencia`);
  const view=await (await fetch(f.origin+'/api/world',{headers:{Cookie:f.cookie}})).json() as WorldView;
  const hz=view.performance!.tickHz;
  assert.ok(hz>10&&hz<200,`ritmo medido ${hz} Hz`);
  await f.app.close();
  const stopped=f.app.world.tick;
  await new Promise<void>(resolve=>setTimeout(resolve,80));
  assert.equal(f.app.world.tick,stopped,'tras cerrar no se planifica ningún paso más');
});
test('loginKey uses X-Forwarded-For when the socket is loopback',()=>{
  assert.equal(loginKey('127.0.0.1','8.8.8.8'),'8.8.8.8');
  assert.equal(loginKey('::1','2001:db8::1'),'2001:db8::1');
  assert.equal(loginKey('::ffff:127.0.0.1','8.8.8.8'),'8.8.8.8');
});
test('loginKey picks the LAST IP from a comma-separated XFF chain (the one the trusted proxy appended, not the client-controlled head)',()=>{
  assert.equal(loginKey('127.0.0.1','9.9.9.9, 1.1.1.1'),'1.1.1.1');
  assert.equal(loginKey('127.0.0.1',['9.9.9.9','1.1.1.1']),'1.1.1.1');
});
test('loginKey falls back to remoteAddress when the last XFF token is invalid',()=>{
  assert.equal(loginKey('127.0.0.1','8.8.4.4, no-soy-una-ip'),'127.0.0.1');
  assert.equal(loginKey('127.0.0.1',['1.1.1.1','   ']),'127.0.0.1');
});
test('loginKey falls back to remoteAddress when no XFF header is present',()=>{
  assert.equal(loginKey('127.0.0.1',undefined),'127.0.0.1');
});
test('loginKey ignores XFF when the socket is not a trusted proxy',()=>{
  assert.equal(loginKey('203.0.113.5','8.8.8.8'),'203.0.113.5');
});
test('loginKey falls back to "local" when remoteAddress is undefined',()=>{
  assert.equal(loginKey(undefined,undefined),'local');
  assert.equal(loginKey(undefined,'8.8.8.8'),'local');
});

// Hallazgo crítico C7 (ronda de revisión T023): en producción atlas-servidor escucha en la
// malla (HOST=100.64.0.1) y el peer real es el Caddy del VPS por la malla (100.64.0.11), no
// loopback. Por defecto (sin CARTA_PROXY_IP) ese socket NO es de confianza -- la sesión de
// login no debe leer XFF de un origen no declarado explícitamente.
test('loginKey does NOT trust XFF from the real mesh proxy address by default (loopback-only trust)',()=>{
  assert.equal(loginKey('100.64.0.11','8.8.8.8'),'100.64.0.11');
});
// ... pero una vez declarado de confianza (el arreglo real de C7), el socket de malla sí
// puede aportar la IP del cliente vía XFF, exactamente el caso "socket = 100.64.0.11 y XFF
// presente" que pidió el revisor.
test('loginKey trusts XFF from an explicitly-configured proxy address (mesh peer 100.64.0.11)',()=>{
  const trusted = new Set(['127.0.0.1','::1','::ffff:127.0.0.1','100.64.0.11']);
  assert.equal(loginKey('100.64.0.11','8.8.8.8',trusted),'8.8.8.8');
  assert.equal(loginKey('100.64.0.12','8.8.8.8',trusted),'100.64.0.12');
});

test('trustedProxiesFromEnv adds CARTA_PROXY_IP (comma-separated) on top of loopback, and stays loopback-only when unset',()=>{
  assert.deepEqual([...trustedProxiesFromEnv({})].sort(),['127.0.0.1','::1','::ffff:127.0.0.1'].sort());
  assert.deepEqual([...trustedProxiesFromEnv({CARTA_PROXY_IP:''})].sort(),['127.0.0.1','::1','::ffff:127.0.0.1'].sort());
  const withProxy = trustedProxiesFromEnv({CARTA_PROXY_IP:' 100.64.0.11 , 100.64.0.12'});
  assert.ok(withProxy.has('100.64.0.11')&&withProxy.has('100.64.0.12')&&withProxy.has('127.0.0.1'));
});

test('login rate-limit isolates clients by forwarded IP behind a loopback proxy',async t=>{
  const f=await fixture(t);
  const post=(xff:string)=>fetch(f.origin+'/api/login',{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json','X-Forwarded-For':xff},body:JSON.stringify({password})});
  for(let i=0;i<6;i++){const res=await post('10.0.0.1');assert.equal(res.status,200);}
  const blocked=await post('10.0.0.1');assert.equal(blocked.status,429);
  const different=await post('10.0.0.2');assert.notEqual(different.status,429);
});

// Hallazgo "importante" (ronda de revisión T023): el cupo global compartido (loginGlobal,
// app.ts) es una regla nueva con coste (constitución / regla de ejecución 5) y no tenía test.
// rate() es exactamente el mecanismo que envuelve ese Map con la clave fija '*': un test
// directo sobre rate() refuta cualquier umbral equivocado, clave mal puesta u off-by-one sin
// pagar 600 peticiones HTTP reales.
test('rate() enforces a hard cap once a shared key crosses the threshold (the mechanism behind the global login cap)',()=>{
  const map = new Map<string,{count:number;reset:number}>();
  for(let i=0;i<600;i++) assert.doesNotThrow(()=>rate(map,'*',600,60_000));
  assert.throws(()=>rate(map,'*',600,60_000),/Espera un momento/);
  // Aislada de otras claves: una clave nueva no comparte cupo con '*'.
  const other = new Map<string,{count:number;reset:number}>();
  other.set('*',{count:600,reset:Date.now()+60_000});
  assert.doesNotThrow(()=>rate(other,'otra-clave',6,60_000));
});
