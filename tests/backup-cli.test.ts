import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createWorld } from '../src/world/index.js';

test('backup CLI keeps an older service schema and source bytes unchanged',()=>{
  const directory=mkdtempSync(join(tmpdir(),'atlas-backup-v4-')),source=join(directory,'world.sqlite'),destination=join(directory,'backup.sqlite');
  const store=new Store(source),world=createWorld(51926);store.save(world);
  const prior=structuredClone(world) as unknown as Record<string,unknown>;prior.version=4;
  for(const key of ['technology','legacy','retiredLegacy','demographyDynamics'])delete prior[key];
  for(const person of prior.people as Record<string,unknown>[]) {delete person.demography;delete person.technology;}
  const body=JSON.stringify(prior),digest=createHash('sha256').update(body).digest('hex');
  store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body,digest);
  store.db.exec('DROP TABLE legacy; PRAGMA user_version=2;');store.close();
  try {
    const before=readFileSync(source);
    const result=spawnSync(process.execPath,['--import','tsx','scripts/storage.ts','backup',destination],{env:{...process.env,CARTA_DATA_DIR:directory},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.deepEqual(readFileSync(source),before);
    const copied=new Store(destination,{readOnly:true});
    try {assert.equal(copied.db.prepare('PRAGMA user_version').get()!.user_version,2);assert.equal(copied.load()!.world.people.length,16);}
    finally {copied.close();}
  } finally {rmSync(directory,{recursive:true,force:true});}
});
