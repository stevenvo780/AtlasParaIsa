import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorldView } from '../src/shared/types.js';

// Exercise the built entrypoint and credential CLI in a disposable world, never real data.
const dir=mkdtempSync(join(tmpdir(),'carta-entry-smoke-'));
const password=randomBytes(24).toString('base64url');
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
const port=(probe.address() as {port:number}).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
const origin=`http://127.0.0.1:${port}`;
const env: NodeJS.ProcessEnv={...process.env,CARTA_DATA_DIR:dir,PORT:String(port),HOST:'127.0.0.1',CARTA_ORIGIN:origin};
delete env.CARTA_PASSWORD;
let child:ChildProcess|undefined;
async function start() {
  child=spawn(process.execPath,['dist/server/server/main.js'],{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Built server did not start within 10 seconds.')),10_000);
    child!.once('exit',()=>{clearTimeout(timeout);reject(new Error('Built server exited before readiness.'));});
    child!.stdout!.on('data',chunk=>{if(chunk.toString().includes('Carta disponible')){clearTimeout(timeout);resolve();}});
  });
}
try {
  const access=spawnSync(process.execPath,['--import','tsx','scripts/access.ts','init'],{env:{...env,CARTA_PASSWORD:password},encoding:'utf8'});
  assert.equal(access.status,0,'Credential CLI failed.');assert.ok(!access.stdout.includes(password));
  await start();assert.equal((await fetch(origin+'/api/world')).status,401);
  const login=await fetch(origin+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const headers={Cookie:cookie};
  const before=await (await fetch(origin+'/api/world',{headers})).json() as WorldView;
  assert.equal((await fetch(origin)).status,200);
  await new Promise<void>(resolve=>setTimeout(resolve,350));
  const after=await (await fetch(origin+'/api/world',{headers})).json() as WorldView;
  assert.ok(after.tick>before.tick);
  child!.kill('SIGKILL');await once(child!,'exit');await start();
  const resumed=await (await fetch(origin+'/api/world',{headers})).json() as WorldView;
  assert.ok(resumed.tick>=after.tick && resumed.tick<=after.tick+3);
  assert.ok(resumed.events.some(e=>e.kind==='pause'));
  const revoke=spawnSync(process.execPath,['--import','tsx','scripts/access.ts','revoke'],{env,encoding:'utf8'});assert.equal(revoke.status,0);
  assert.equal((await fetch(origin+'/api/world',{headers})).status,401);
  child!.kill('SIGTERM');const [code]=await once(child!,'exit');assert.equal(code,0);
  const report={generatedAt:new Date().toISOString(),builtEntrypoint:true,credentialCli:true,privateHttp:true,autonomousAdvance:true,sigkillRestart:true,persistedSession:true,revocationCli:true,gracefulExit:true};
  mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/smoke.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {
  if(child && child.exitCode===null && child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}
  rmSync(dir,{recursive:true,force:true});
}
