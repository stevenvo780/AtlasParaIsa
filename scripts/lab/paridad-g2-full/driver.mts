/** Private, fail-closed technical parity driver. No public route or scientific verdict. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { canonicalGraph, captureSqlite, cutBytes, firstCutDifference, inventoryStoreFiles } from './comparator.mjs';
import { assertFullProbeNonInterference } from './full-noninterference.mjs';

type Arm='INIT'|'A0'|'A_PATCHED_FOR_VISIBILITY'|'B'|'C';
type Mode='PILOT_51926_120'|'FULL_6X1200';
type Pin={path:string;kind:'file'|'symlink'|'target';sha256:string};
type ClockDomain='app-monotonic'|'scheduler'|'projection';
type ClockRow={siteId:string;callOrdinal:number;attemptId:string|null;tick:number;clockDomain:ClockDomain;
  value:number;phase:'startup'|'step';attemptIndex:number};
type Config={schema:'atlas-g2-full-parity/v2';mode:Mode;arm:Arm;seed:number;ticks:number;
  checkout:string;privateRoot:string;initialDb:string;params:unknown;paramsSha256:string;
  tickMs:100;
  runId:string;epochId:string;sourceSHA:string;sourceManifest:string;sourceManifestSha256:string;
  baseCommit:string;allowedDependencyRoot:string;runtime:{path:string;sha256:string;version:string;loader:string;loaderSha256:string};
  harnessPins:{driver:string;comparator:string;pilot:string;selfcheck:string};pins:Pin[];inputSchedule:readonly unknown[];
  expectedClock?:string;expectedPublic?:string;expectedCommon?:string;expectedExtension?:string;
  baseClockCallsites?:Record<string,{siteId:string;clockDomain:ClockDomain}>;
  nonInterferenceReceipt?:string;nonInterferenceReceiptSha256?:string};
/** The exact direct monotonicNow() callsites in both pinned A0 and A† sources. */
const baseClockSites:Record<string,{siteId:string;clockDomain:ClockDomain}>={
  '306':{siteId:'projection-start',clockDomain:'projection'},
  '307':{siteId:'projection-end',clockDomain:'projection'},
  '492':{siteId:'step-start',clockDomain:'app-monotonic'},
  '512':{siteId:'clone-start',clockDomain:'app-monotonic'},
  '526':{siteId:'clone-end',clockDomain:'app-monotonic'},
  '527':{siteId:'simulation-start',clockDomain:'app-monotonic'},
  '535':{siteId:'simulation-end',clockDomain:'app-monotonic'},
  '548':{siteId:'save-start',clockDomain:'app-monotonic'},
  '550':{siteId:'save-end',clockDomain:'app-monotonic'},
  '559':{siteId:'step-end',clockDomain:'app-monotonic'},
  '755':{siteId:'scheduler-initial',clockDomain:'scheduler'},
  '764':{siteId:'scheduler-yield-check',clockDomain:'scheduler'},
  '779':{siteId:'scheduler-now',clockDomain:'scheduler'},
  '781':{siteId:'scheduler-delay',clockDomain:'scheduler'},
  '783':{siteId:'scheduler-delay',clockDomain:'scheduler'},
};
const hash=(x:Uint8Array|string)=>createHash('sha256').update(x).digest('hex');
function fail(code:string):never {throw new Error(code);}
function exactFile(path:string):Buffer {if(!lstatSync(path).isFile())fail('NONREGULAR_FILE');return readFileSync(path);}
function atomicJson(path:string,value:unknown):void {const temp=path+'.tmp-'+process.pid;
  writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temp,path);}
function boundedRoot(path:string,prefix:string):string {const actual=realpathSync(path);
  if(!actual.startsWith(prefix+'/'))fail('UNSAFE_PATH');return actual;}
/** Include each symlink's text AND all reachable content, including node_modules transitive files. */
function sourceInventory(c:Config):Pin[] {
  const root=boundedRoot(c.checkout,'/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees');
  const dep=realpathSync(c.allowedDependencyRoot);
  const allowed=(path:string)=>path===root||path.startsWith(root+'/')||path===dep||path.startsWith(dep+'/');
  const out:Pin[]=[];
  const visit=(full:string,rel:string,ancestors:Set<string>):void=>{
    if(!rel||rel.startsWith('/')||rel.split('/').includes('..'))fail('PIN_PATH_INVALID');
    const stat=lstatSync(full), real=realpathSync(full);
    if(!allowed(real))fail('PIN_TARGET_OUTSIDE_ALLOWED_ROOTS');
    if(stat.isSymbolicLink()) {
      out.push({path:rel,kind:'symlink',sha256:hash('SYMLINK\0'+readlinkSync(full))});
      const target=statSync(full);
      if(target.isFile()) {out.push({path:rel+'#target',kind:'target',sha256:hash(readFileSync(full))});return;}
      if(!target.isDirectory())fail('PIN_TARGET_NONREGULAR');
    } else if(stat.isFile()) {out.push({path:rel,kind:'file',sha256:hash(readFileSync(full))});return;}
    else if(!stat.isDirectory())fail('PIN_NONREGULAR');
    if(ancestors.has(real))fail('PIN_SYMLINK_CYCLE');
    const next=new Set(ancestors);next.add(real);
    for(const name of readdirSync(full).sort())visit(join(full,name),rel+'/'+name,next);
    if(out.length>250_000)fail('PIN_INVENTORY_UNBOUNDED');
  };
  for(const name of ['src','scripts','node_modules','package.json','package-lock.json','tsconfig.json','tsconfig.server.json'])
    visit(join(root,name),name,new Set());
  return out.sort((a,b)=>a.path.localeCompare(b.path)||a.kind.localeCompare(b.kind));
}
function preflight(c:Config):void {
  if(c.schema!=='atlas-g2-full-parity/v2'||
     !(c.mode==='PILOT_51926_120'&&c.seed===51926&&c.ticks===120 ||
       c.mode==='FULL_6X1200'&&[51926,42,606,1001,20260924,20261004].includes(c.seed)&&c.ticks===1200))
    fail('CAMPAIGN_IDENTITY_INVALID');
  if(!['INIT','A0','A_PATCHED_FOR_VISIBILITY','B','C'].includes(c.arm))fail('ARM_INVALID');
  const root=boundedRoot(c.privateRoot,'/datos/tmp-atlas-lab');
  if(!process.env.CARTA_DATA_DIR||realpathSync(process.env.CARTA_DATA_DIR)!==root)fail('DATA_DIR_NOT_OWN_UNIT');
  if(realpathSync(c.runtime.path)!==realpathSync(process.execPath)||process.version!==c.runtime.version||
     hash(exactFile(c.runtime.path))!==c.runtime.sha256||
     hash(exactFile(c.runtime.loader))!==c.runtime.loaderSha256)fail('RUNTIME_DRIFT');
  const self=join(dirname(new URL(import.meta.url).pathname),'driver.mts');
  const comparator=join(dirname(self),'comparator.mts');
  const pilot=join(dirname(self),'pilot.mts');
  const selfcheck=join(dirname(self),'selfcheck.test.mts');
  if(hash(exactFile(self))!==c.harnessPins.driver||hash(exactFile(comparator))!==c.harnessPins.comparator||
     hash(exactFile(pilot))!==c.harnessPins.pilot||hash(exactFile(selfcheck))!==c.harnessPins.selfcheck)
    fail('HARNESS_DRIFT');
  const actual=sourceInventory(c);
  if(JSON.stringify(actual)!==JSON.stringify(c.pins))fail('SOURCE_TREE_DRIFT');
  if(hash(canonicalGraph(c.params))!==c.paramsSha256||c.tickMs!==100||
     !Array.isArray(c.inputSchedule)||c.inputSchedule.length!==0)fail('PARAMS_OR_INPUTS_INVALID');
  if(hash(exactFile(c.sourceManifest))!==c.sourceManifestSha256)fail('SOURCE_MANIFEST_DRIFT');
  const manifest=JSON.parse(exactFile(c.sourceManifest).toString()) as {schema:string;baseCommit:string;
    runtime:unknown;pins:Pin[];sourceSHA:string;sourceTreeDigest:string};
  const descriptor=JSON.stringify({schema:'composite-source-runtime-v2',baseCommit:c.baseCommit,
    runtime:manifest.runtime,pins:actual});
  if(manifest.schema!=='composite-source-runtime-v2'||manifest.baseCommit!==c.baseCommit||
     JSON.stringify(manifest.pins)!==JSON.stringify(actual)||manifest.sourceTreeDigest!==hash(descriptor)||
     manifest.sourceSHA!==createHash('sha1').update(descriptor).digest('hex')||manifest.sourceSHA!==c.sourceSHA)
    fail('SOURCE_IDENTITY_INVALID');
  if(c.arm==='A0'&&c.baseCommit!=='bb483260b2489fe62b113d620e5f56e5f3676dbc')fail('A0_NOT_BASE');
  if(c.arm==='A0'){
    const head=execFileSync('git',['rev-parse','HEAD'],{cwd:c.checkout,encoding:'utf8'}).trim();
    const status=execFileSync('git',['status','--porcelain','--untracked-files=all'],
      {cwd:c.checkout,encoding:'utf8'}).trim();
    if(head!==c.baseCommit||status||
       hash(exactFile(join(c.checkout,'src/server/app.ts')))!=='c1a82b9befcb7a9498c02114344d0bc9c12a823f60ce49846083200fec71553b'||
       hash(exactFile(join(c.checkout,'src/server/governor.ts')))!=='3b55ea8718f0ca15b30af8ab9cfea8672d53a70be783b1714453ac2e1e17e8b4')
      fail('A0_EXACT_SOURCE_DRIFT');
  }
  if(c.arm==='A0'||c.arm==='A_PATCHED_FOR_VISIBILITY'){
    const appText=readFileSync(join(c.checkout,'src/server/app.ts'),'utf8').split('\n');
    const sites=c.baseClockCallsites;
    const actualLines=appText.flatMap((line,index)=>/\bmonotonicNow\(\)/.test(line)?[String(index+1)]:[]);
    const expectedLines=Object.keys(baseClockSites);
    const entries=(map:Record<string,{siteId:string;clockDomain:ClockDomain}>)=>
      Object.entries(map).map(([line,item])=>[line,item?.siteId,item?.clockDomain]).sort((a,b)=>Number(a[0])-Number(b[0]));
    if(!sites||JSON.stringify(actualLines)!==JSON.stringify(expectedLines)||
       JSON.stringify(entries(sites))!==JSON.stringify(entries(baseClockSites)))
      fail('BASE_CLOCK_MAP_BLOCKED');
  }
  if(c.arm==='A0'&&readFileSync(join(c.checkout,'src/server/app.ts'),'utf8').includes('technicalParityCommonState'))
    fail('A0_VISIBILITY_PATCH_PRESENT');
  if(c.arm==='INIT'&&c.expectedClock)fail('INIT_CLOCK_INVALID');
  assertFullProbeNonInterference(c,exactFile);
}
function frameWriter(path:string){const fd=openSync(path,'wx',0o600);let count=0;
  return {write(bytes:Buffer){const zipped=gzipSync(bytes,{level:6});const header=Buffer.alloc(4);
    header.writeUInt32BE(zipped.length);for(const part of [header,zipped]) {let off=0;
      while(off<part.length){const written=writeSync(fd,part,off,part.length-off);if(written<1)fail('CUT_WRITE_FAILED');off+=written;}}
    count++;},close(){fsyncSync(fd);closeSync(fd);return count;}};}
function frameReader(path:string){const fd=openSync(path,'r');return {next():Buffer|null{
  const header=Buffer.alloc(4);const n=readSync(fd,header,0,4,null);if(n===0)return null;if(n!==4)fail('CUT_TRUNCATED');
  const size=header.readUInt32BE();if(size<1||size>512*1024*1024)fail('CUT_SIZE_INVALID');const zipped=Buffer.alloc(size);
  let off=0;while(off<size){const n=readSync(fd,zipped,off,size-off,null);if(n<1)fail('CUT_TRUNCATED');off+=n;}
  return gunzipSync(zipped);},close(){closeSync(fd);}};}
class StrictClock {
  readonly rows:ClockRow[]=[];private cursor=0;private ordinals=new Map<string,number>();
  constructor(readonly mode:'record'|'replay',readonly expected:readonly ClockRow[]=[]){}
  read(siteId:string,attemptId:string|null,tick:number,clockDomain:ClockDomain,real:()=>number,
    phase:'startup'|'step',attemptIndex:number):number {
    const key=JSON.stringify([siteId,attemptId,tick,clockDomain]);const callOrdinal=(this.ordinals.get(key)??0)+1;
    this.ordinals.set(key,callOrdinal);
    if(this.mode==='record') {const value=real();if(!Number.isFinite(value))fail('CLOCK_NONFINITE');
      this.rows.push({siteId,callOrdinal,attemptId,tick,clockDomain,value,phase,attemptIndex});return value;}
    const row=this.expected[this.cursor++];
    if(!row||row.siteId!==siteId||row.callOrdinal!==callOrdinal||row.attemptId!==attemptId||
       row.tick!==tick||row.clockDomain!==clockDomain||row.phase!==phase||
       row.attemptIndex!==attemptIndex||!Number.isFinite(row.value))fail('CLOCK_CONTEXT_INCOMPLETE');
    return row.value;
  }
  finish(){if(this.mode==='replay'&&this.cursor!==this.expected.length)fail('CLOCK_MISSING_READ');}
  get consumed(){return this.cursor;}
}
export function expectedOn(rows:readonly ClockRow[],runId:string,epochId:string):ClockRow[]{
  const ordinals=new Map<string,number>();
  return rows.map(row=>{if(row.attemptId!==null||row.phase==='step'&&row.attemptIndex<1)fail('OFF_CLOCK_ENVELOPE_INVALID');
    const attemptId=row.phase==='step'?`${runId}:${epochId}:attempt-${row.attemptIndex+1}`:null;
    const key=JSON.stringify([row.siteId,attemptId,row.tick,row.clockDomain]);const callOrdinal=(ordinals.get(key)??0)+1;
    ordinals.set(key,callOrdinal);return {...row,attemptId,callOrdinal};});
}
const commonKeys=['pending','beats','governor','runtimeGovernor','effectiveGovernorParams','worldTick',
  'failed','stopped','aMedioPaso','enPaso','intentoReserva','lastViewTick'];
export function exactKeys(value:unknown,keys:readonly string[],code:string):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||
     JSON.stringify(Reflect.ownKeys(value).sort())!==JSON.stringify([...keys].sort()))fail(code);
  return value as Record<string,unknown>;
}
function readCommon(app:Record<string,unknown>,arm:Arm):{common:unknown;extension:unknown}{
  if(arm==='A0') {if('technicalParityCommonState'in app||'technicalParityG2State'in app)fail('A0_PROBE_PRESENT');
    return {common:null,extension:null};}
  const method=app.technicalParityCommonState;
  if(typeof method!=='function')fail('APP_STATE_INCOMPLETE');
  const state=exactKeys(method.call(app),commonKeys,'APP_STATE_INCOMPLETE');
  const governor=exactKeys(state.governor,['measurements','count','p95StepMs','estado','techoObservado','enRojo'],
    'GOVERNOR_STATE_INCOMPLETE');
  if(!Array.isArray(governor.measurements)||governor.count!==governor.measurements.length||
     governor.measurements.length>120||!Array.isArray(state.pending)||!Array.isArray(state.beats)||
     state.worldTick!==(app.world as {tick:number}).tick)fail('APP_STATE_INCOMPLETE');
  for(const pending of state.pending)exactKeys(pending,['key','gesture','hash','hasPromise','hasResolve','hasReject'],
    'PENDING_STATE_INCOMPLETE');
  if(arm==='A_PATCHED_FOR_VISIBILITY') {
    if('technicalParityG2State'in app)fail('A_PRIVATE_EXTENSION_INVENTED');
    return {common:state,extension:null};
  }
  const ext=app.technicalParityG2State;
  if(typeof ext!=='function')fail('BC_EXTENSION_MISSING');
  const extension=requireDecisionWorldAlignment(ext.call(app));
  return {common:state,extension};
}
export function requireDecisionWorldAlignment(value:unknown):Record<string,unknown>{
  const extension=exactKeys(value,['decisionWorldAlignment'],'BC_EXTENSION_INCOMPLETE');
  if(extension.decisionWorldAlignment!==true)fail('BC_DECISION_WORLD_MISALIGNED');
  return extension;
}
function clockRows(path:string):ClockRow[]{const rows=JSON.parse(exactFile(path).toString()) as ClockRow[];
  if(!Array.isArray(rows)||!rows.length||rows.some(row=>!row||typeof row.siteId!=='string'||
      !Number.isSafeInteger(row.callOrdinal)||!Number.isSafeInteger(row.tick)||!Number.isFinite(row.value)||
      !['startup','step'].includes(row.phase)||!Number.isSafeInteger(row.attemptIndex)))fail('CLOCK_TRACE_INVALID');
  return rows;}
function fixedInstanceId(seed:number):string {const h=hash(`atlas-g2-parity\0${seed}`);
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;}
/** Independent intended-bytes seal; a same-length preseal rewrite is still detected. */
export function sidecarMatches(disk:Buffer,intendedSha256:string,intendedBytes:number,intendedCount:number):boolean {
  const lines=disk.length?disk.toString('utf8').split('\n').length-1:0;
  return hash(disk)===intendedSha256&&disk.length===intendedBytes&&lines===intendedCount&&
    (disk.length===0||disk[disk.length-1]===10);
}
async function init(c:Config,output:string):Promise<void>{
  if(c.arm!=='INIT'||existsSync(c.initialDb))fail('BOOTSTRAP_NOT_FRESH');
  if(!resolve(c.initialDb).startsWith(output+'/'))fail('BOOTSTRAP_OUTSIDE_UNIT');
  const {Store}=await import(pathToFileURL(join(c.checkout,'src/server/store.ts')).href);
  const dbPath=join(output,'bootstrap.sqlite');const store=new Store(dbPath);
  try {const id=fixedInstanceId(c.seed);
    store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('world-instance-id',id);
    const snapshots=store.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as {n:number};
    if(snapshots.n!==0)fail('BOOTSTRAP_HAS_SNAPSHOT');
    store.backup(c.initialDb);
    atomicJson(join(output,'bootstrap.json'),{schema:c.schema,mode:c.mode,seed:c.seed,instanceId:id,
      initialSha256:hash(exactFile(c.initialDb)),snapshotRows:0,sourceSHA:c.sourceSHA});
  }finally{store.close();}
}
function readReference(path:string|undefined,required:boolean){if(required&&!path)fail('EXPECTED_CUT_MISSING');
  return path?frameReader(path):null;}
function checkReference(reader:ReturnType<typeof frameReader>|null,bytes:Buffer,label:string,tick:number,output:string){
  if(!reader)return;const expected=reader.next();if(!expected)fail('EXPECTED_CUT_TRUNCATED');
  const difference=firstCutDifference(expected,bytes);
  if(difference){atomicJson(join(output,'first-difference.json'),{tick,label,...difference});fail('PHYSICAL_DIFFERENCE');}}
async function run(c:Config,output:string,twin=false):Promise<void>{
  if(c.arm==='INIT'||!existsSync(c.initialDb))fail('RUN_INPUT_INVALID');
  const needs={A0:['expectedClock'],A_PATCHED_FOR_VISIBILITY:['expectedClock','expectedPublic'],
    B:[],C:['expectedClock','expectedPublic','expectedCommon','expectedExtension']} as const;
  for(const key of needs[c.arm])if(!c[key])fail('REQUIRED_REFERENCE_MISSING');
  if(c.arm==='B'&&(c.expectedClock||c.expectedPublic||c.expectedCommon||c.expectedExtension))fail('B_REFERENCE_INVALID');
  if(twin&&c.arm!=='B')fail('TWIN_ARM_INVALID');
  const bOutput=join(realpathSync(c.privateRoot),`seed-${c.seed}`,'B');
  const twinClock=twin?join(bOutput,'clock.json'):undefined;
  const twinPhysical=twin?join(bOutput,'physical.cuts'):undefined;
  const dbPath=join(output,'store','state.sqlite');mkdirSync(dirname(dbPath),{recursive:true,mode:0o700});
  if(existsSync(dbPath))fail('ARM_ALREADY_EXISTS');copyFileSync(c.initialDb,dbPath);
  const {Store}=await import(pathToFileURL(join(c.checkout,'src/server/store.ts')).href);
  const {createApp}=await import(pathToFileURL(join(c.checkout,'src/server/app.ts')).href);
  const {paramsOf}=await import(pathToFileURL(join(c.checkout,'src/world/params.ts')).href);
  const store=new Store(dbPath);let app:ReturnType<typeof createApp>|undefined;
  let session:import('../../../src/world/observation.js').ObservationSession|undefined;
  let observation:typeof import('../../../src/world/observation.js')|undefined;
  const raw=c.arm==='C'?openSync(join(output,'raw.ndjson'),'wx',0o600):null;
  const rawHash=createHash('sha256');let rawBytes=0,rawCount=0;const rawIds=new Set<string>();
  const rawOrder=new Map<string,{phaseOrdinal:number;eventOrdinal:number}>();
  const rawCountByAttempt=new Map<string,number>();let physicalCutTick=0;
  const physicalWriter=frameWriter(join(output,'physical.cuts'));
  const sqliteMeta=openSync(join(output,'sqlite-metadata.ndjson'),'wx',0o600);
  const commonWriter=c.arm==='A0'||twin?null:frameWriter(join(output,'common.cuts'));
  const extensionWriter=(c.arm==='B'||c.arm==='C')&&!twin?frameWriter(join(output,'extension.cuts')):null;
  const physicalRef=readReference(twinPhysical??c.expectedPublic,
    twin||c.arm==='A_PATCHED_FOR_VISIBILITY'||c.arm==='C');
  const commonRef=readReference(twin?undefined:c.expectedCommon,c.arm==='C');
  const extensionRef=readReference(twin?undefined:c.expectedExtension,c.arm==='C');
  let phase:'startup'|'step'='startup',attemptIndex=0;
  const recorded=twinClock||c.expectedClock?clockRows((twinClock??c.expectedClock)!):[];
  const expected=c.arm==='C'?expectedOn(recorded,c.runId,c.epochId):recorded;
  const clock=new StrictClock(c.arm==='B'&&!twin?'record':'replay',expected);
  const clockCallback=(siteId:string,attemptId:string|null,tick:number,domain:ClockDomain,real:()=>number)=>
    clock.read(siteId,attemptId,tick,domain,real,phase,attemptIndex);
  const monotonicNow=()=>{
    const stack=new Error().stack??'';
    const line=stack.split('\n').find(row=>row.includes('/src/server/app.ts:'))??'';
    const match=/\/src\/server\/app\.ts:(\d+):\d+/.exec(line);
    const mapped=match?c.baseClockCallsites?.[match[1]!]:undefined;
    const row=expected[clock.consumed];
    if(!mapped||!row||row.siteId!==mapped.siteId||row.clockDomain!==mapped.clockDomain||
       row.phase!==phase||row.attemptIndex!==attemptIndex)fail('BASE_CLOCK_CALLSITE_INCOMPLETE');
    const preTick=attemptIndex-1;
    const inferredTick=phase==='startup'?0:
      ['step-start','clone-start','clone-end','simulation-start'].includes(mapped.siteId)?preTick:attemptIndex;
    if(row.tick!==inferredTick)fail('BASE_CLOCK_CONTEXT_INCOMPLETE');
    return clock.read(mapped.siteId,null,row.tick,mapped.clockDomain,()=>fail('BASE_CLOCK_REAL_FALLBACK'),phase,attemptIndex);
  };
  const rawSink=(event:import('../../../src/world/observation.js').ObservationEvent)=>{
    if(!session||event.runId!==c.runId||event.epochId!==c.epochId||event.sourceSHA!==c.sourceSHA||
       !session.attemptHistory.has(event.attemptId)||event.tick!==physicalCutTick||
       !event.siteId||!event.phaseId||!Number.isSafeInteger(event.phaseOrdinal)||event.phaseOrdinal<0||
       !Number.isSafeInteger(event.eventOrdinal)||event.eventOrdinal<1||rawIds.has(event.sourceEventId)||
       event.sourceEventId!==`${event.attemptId}:${event.tick}:${event.phaseOrdinal}:${event.eventOrdinal}:${event.siteId}`)
      fail('RAW_IDENTITY_INVALID');
    const previous=rawOrder.get(event.attemptId);
    if(previous&&(event.phaseOrdinal<previous.phaseOrdinal||
      event.phaseOrdinal===previous.phaseOrdinal&&event.eventOrdinal<=previous.eventOrdinal))
      fail('RAW_ORDER_INVALID');
    rawOrder.set(event.attemptId,{phaseOrdinal:event.phaseOrdinal,eventOrdinal:event.eventOrdinal});
    rawCountByAttempt.set(event.attemptId,(rawCountByAttempt.get(event.attemptId)??0)+1);
    rawIds.add(event.sourceEventId);
    const bytes=Buffer.from(JSON.stringify(event)+'\n','utf8');let offset=0;
    while(offset<bytes.length){const n=writeSync(raw!,bytes,offset,bytes.length-offset);if(n<1)fail('RAW_WRITE_FAILED');offset+=n;}
    rawHash.update(bytes);rawBytes+=bytes.length;rawCount++;
  };
  let cutCount=0,terminal='UNKNOWN',problem:string|null=null;
  try {
    if(c.arm==='C') {observation=await import(pathToFileURL(join(c.checkout,'src/world/observation.ts')).href);
      if(!observation)fail('OBSERVATION_MODULE_UNAVAILABLE');
      session=observation.createObservationSession({runId:c.runId,epochId:c.epochId,sourceSHA:c.sourceSHA});}
    app=createApp({store,seed:c.seed,params:c.params,manual:true,tickMs:c.tickMs,origin:'http://127.0.0.1',
      password:'paridad-tecnica-privada-2026',...(c.arm==='A0'||c.arm==='A_PATCHED_FOR_VISIBILITY'?{monotonicNow}:{decisionClock:clockCallback}),
      ...(session?{observationSession:session}:{})});
    const initial=store.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as {n:number};
    if(initial.n!==1||app.world.tick!==0)fail('TICK0_BOOTSTRAP_INVALID');
    for(let i=0;i<=c.ticks;i++){
      if(i){phase='step';attemptIndex=i;app.stepOnce();}
      if(app.world.tick!==i||app.failed)fail('APP_TICK_OR_FAILURE');
      const before=i===0?canonicalGraph({world:app.world,sqlite:captureSqlite(store.db).logical}):null;
      const first=twin?{common:null,extension:null}:readCommon(app as unknown as Record<string,unknown>,c.arm);
      if(i===0&&!twin){const second=readCommon(app as unknown as Record<string,unknown>,c.arm);
        if(!canonicalGraph(first).equals(canonicalGraph(second))||
           !before!.equals(canonicalGraph({world:app.world,sqlite:captureSqlite(store.db).logical})))
          fail('PROBE_NONINTERFERENCE_UNPROVEN');}
      const sql=captureSqlite(store.db),files=inventoryStoreFiles(dirname(dbPath));
      const effectiveParams=paramsOf(app.world);
      if(JSON.stringify(effectiveParams)!==JSON.stringify(c.params))fail('EFFECTIVE_PARAMS_DRIFT');
      const physical=cutBytes({world:app.world,params:{declared:c.params,effective:effectiveParams},
        sqlite:sql.logical,storeFiles:files.durableFiles,
        app:{failed:app.failed,gestosPendientes:app.gestosPendientes}});
      const sqliteLine=Buffer.from(JSON.stringify({tick:i,excludedSavedAt:sql.excludedSavedAt,
        sqliteLayout:sql.layout,sqliteFiles:files.sqliteLayout})+'\n');
      let written=0;while(written<sqliteLine.length){const n=writeSync(sqliteMeta,sqliteLine,written,sqliteLine.length-written);
        if(n<1)fail('SQLITE_METADATA_WRITE_FAILED');written+=n;}
      physicalWriter.write(physical);checkReference(physicalRef,physical,'public',i,output);
      if(commonWriter){const common=canonicalGraph(first.common);commonWriter.write(common);
        checkReference(commonRef,common,'common',i,output);}
      if(extensionWriter){const extension=canonicalGraph(first.extension);extensionWriter.write(extension);
        checkReference(extensionRef,extension,'extension',i,output);}
      cutCount++;
      if(session&&observation){physicalCutTick=i;await observation.drainObservation(session,rawSink);
        const expectedAttempt=`${c.runId}:${c.epochId}:attempt-${i+1}`;
        const history=session.attemptHistory.get(expectedAttempt);
        if(!history||history[0]?.state!=='started'||!history.some(row=>row.state==='adopted'))
          fail('ATTEMPT_HISTORY_INCOMPLETE');
        const saved=store.db.prepare("SELECT COALESCE(json_extract(body,'$.tick'),json_extract(body,'$.world.tick')) AS tick FROM snapshots WHERE slot=0").get() as {tick:unknown}|undefined;
        if((saved?.tick===i)!==history.some(row=>row.state==='durable'))fail('DURABLE_ATTEMPT_MISMATCH');
        if(!rawCountByAttempt.get(expectedAttempt))fail('RAW_ATTEMPT_WITHOUT_SOURCE');
        if(session.nextAttempt!==i+1||session.queue.length)fail('ATTEMPT_OR_QUEUE_INCOMPLETE');}
      if(i===0)atomicJson(join(output,'tick0.json'),{physicalSha256:hash(physical),
        commonSha256:first.common===null?null:hash(canonicalGraph(first.common)),
        extensionSha256:first.extension===null?null:hash(canonicalGraph(first.extension))});
      if(i===Math.floor(c.ticks/2))preflight(c);
    }
    if(physicalRef?.next()||commonRef?.next()||extensionRef?.next())fail('EXPECTED_CUT_EXTRA');
    clock.finish();preflight(c);
    if(c.arm==='B'&&!twin)atomicJson(join(output,'clock.json'),clock.rows);
    terminal=twin?'PROBE_TWIN_EQUAL':'CANDIDATE_COMPARISON_ONLY';
  }catch(error){problem=error instanceof Error&&/^[A-Z0-9_-]+$/.test(error.message)?error.message:'RUNNER_ERROR';}
  finally {
    let seal='NOT_APPLICABLE';
    if(raw!==null){try{fsyncSync(raw);closeSync(raw);
      const disk=readFileSync(join(output,'raw.ndjson'));
      if(!sidecarMatches(disk,rawHash.digest('hex'),rawBytes,rawCount)){
        seal='SIDECAR_CONTENT_MISMATCH';if(session)session.gaps.push({attemptId:null,tick:null,siteId:'sidecar',reason:'sidecar-content-mismatch'});
      }else seal='COMPLETE';}catch{seal='SIDECAR_SEAL_FAILED';}}
    const history=session?.attemptHistory instanceof Map?[...session.attemptHistory]:null;
    const coverage=session&&observation?observation.coverageStatus(session):null;
    if(session&&(!history||history.length<1))problem='ATTEMPT_HISTORY_MISSING';
    if(session&&(seal!=='COMPLETE'||coverage?.quality!=='COMPLETE'||session.queue.length||session.lostEvents||session.lostGaps))
      problem=problem??'OBSERVER_COVERAGE_INCOMPLETE';
    if(problem)terminal='UNKNOWN';
    try{fsyncSync(sqliteMeta);closeSync(sqliteMeta);physicalWriter.close();commonWriter?.close();extensionWriter?.close();
      physicalRef?.close();commonRef?.close();extensionRef?.close();}
    catch{terminal='UNKNOWN';problem=problem??'CUT_SEAL_FAILED';}
    try{if(app)await app.close();}catch{terminal='UNKNOWN';problem=problem??'APP_CLOSE_FAILED';}
    try{store.close();}catch{terminal='UNKNOWN';problem=problem??'STORE_CLOSE_FAILED';}
    atomicJson(join(output,'run.json'),{schema:c.schema,mode:c.mode,arm:c.arm,seed:c.seed,ticks:c.ticks,cuts:cutCount,
      state:terminal,problem,sourceSHA:c.sourceSHA,sourceManifestSha256:c.sourceManifestSha256,
      runtime:c.runtime,paramsSha256:c.paramsSha256,initialSha256:hash(exactFile(c.initialDb)),
      clockReads:c.arm==='B'?clock.rows.length:clock.consumed,raw:{count:rawCount,bytes:rawBytes,seal},
      attemptHistory:history,coverage,decisionWorldAlignment:c.arm==='A0'||c.arm==='A_PATCHED_FOR_VISIBILITY'?
        'NOT_AVAILABLE_IN_A_SOURCE':'OBSERVED_BC_ONLY',
      scheduler:'APP-SCHEDULER-INCOMPLETE',recovery:'SNAPSHOT-RECOVERY-NOT-VERIFIED',
      probeTwin:twin?'SAME_NEXT_STEPS_EQUAL':'PROBE-NONINTERFERENCE-UNPROVEN',scientificAcceptance:false});
  }
  if(terminal!==(twin?'PROBE_TWIN_EQUAL':'CANDIDATE_COMPARISON_ONLY'))fail(problem??'RUN_UNKNOWN');
}
async function main(){if(process.argv.length!==4)fail('USAGE');
  const c=JSON.parse(exactFile(process.argv[2]!).toString()) as Config;
  const action=process.argv[3];if(action!=='init'&&action!=='run'&&action!=='twin')fail('ACTION_INVALID');
  preflight(c);const root=realpathSync(c.privateRoot);
  const output=join(root,`seed-${c.seed}`,action==='twin'?'B_TWIN':c.arm);
  mkdirSync(output,{recursive:true,mode:0o700});
  if(action==='init')await init(c,output);else await run(c,output,action==='twin');
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname))
  main().catch(error=>{const code=error instanceof Error&&/^[A-Z0-9_-]+$/.test(error.message)?error.message:'RUNNER_ERROR';
    process.stderr.write(code+'\n');process.exitCode=1;});
