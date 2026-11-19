/** One attributed CPU-v4 unit: exact A0 and lab A†/B/C, sequentially. Prepared, not an admission. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { firstCutDifference } from './comparator.mjs';
const hash=(x:Uint8Array|string)=>createHash('sha256').update(x).digest('hex');
function fail(code:string):never {throw new Error(code);}
function readJson(path:string):Record<string,unknown>{if(!lstatSync(path).isFile())fail('CONFIG_NONREGULAR');
  return JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>;}
function atomicJson(path:string,value:unknown){const temp=path+'.tmp-'+process.pid;
  writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temp,path);}
function compareFramed(leftPath:string,rightPath:string,expected:number,label:string):{count:number;digest:string}{
  const left=openSync(leftPath,'r'),right=openSync(rightPath,'r');let count=0;const digest=createHash('sha256');
  const next=(fd:number):Buffer|null=>{const header=Buffer.alloc(4),n=readSync(fd,header,0,4,null);
    if(n===0)return null;if(n!==4)fail('PILOT_CUT_TRUNCATED');
    const size=header.readUInt32BE();if(size<1||size>512*1024*1024)fail('PILOT_CUT_INVALID');
    const data=Buffer.alloc(size);let off=0;while(off<size){const read=readSync(fd,data,off,size-off,null);
      if(read<1)fail('PILOT_CUT_TRUNCATED');off+=read;}return gunzipSync(data);};
  try{while(true){const a=next(left),b=next(right);if(a===null||b===null){if(a!==b)fail('PILOT_CUT_COUNT');break;}
      const difference=firstCutDifference(a,b);if(difference){
        const output=join(dirname(rightPath),'first-difference-'+label+'.json');
        atomicJson(output,{cut:count,label,...difference});fail('PILOT_PHYSICAL_DIFFERENCE');}
      digest.update(hash(a));count++;}
    if(count!==expected)fail('PILOT_CUT_COUNT');return {count,digest:digest.digest('hex')};
  }finally{closeSync(left);closeSync(right);}
}
async function main(){if(process.argv.length!==3)fail('USAGE');
  const plan=readJson(process.argv[2]!);
  if(plan.schema!=='atlas-g2-parity-pilot/v2'||plan.seed!==51926||plan.ticks!==120||
     plan.mode!=='PILOT_51926_120')fail('PILOT_IDENTITY_INVALID');
  const root=realpathSync(String(plan.privateRoot));
  if(!root.startsWith('/datos/tmp-atlas-lab/')||!process.env.CARTA_DATA_DIR||
     realpathSync(process.env.CARTA_DATA_DIR)!==root)fail('PILOT_DATA_DIR_INVALID');
  const configs=plan.configs as Record<string,string>|undefined;
  if(!configs||Object.keys(configs).sort().join(',')!=='A0,A_PATCHED_FOR_VISIBILITY,B,C,INIT')
    fail('PILOT_PHASES_INVALID');
  const phases=['INIT','B','A0','A_PATCHED_FOR_VISIBILITY','C'] as const;
  const parsed=new Map<string,Record<string,unknown>>();
  for(const arm of phases){const file=resolve(configs[arm]!);if(!file.startsWith(root+'/'))fail('PILOT_CONFIG_OUTSIDE_UNIT');
    const c=readJson(file);if(c.schema!=='atlas-g2-full-parity/v2'||c.mode!=='PILOT_51926_120'||
      c.seed!==51926||c.ticks!==120||c.arm!==arm||realpathSync(String(c.privateRoot))!==root)
      fail('PILOT_CONFIG_IDENTITY');parsed.set(arm,c);}
  const b=parsed.get('B')!,c=parsed.get('C')!,a0=parsed.get('A0')!,a=parsed.get('A_PATCHED_FOR_VISIBILITY')!;
  const init=parsed.get('INIT')!;
  if(new Set(phases.map(arm=>parsed.get(arm)!.initialDb)).size!==1||
    new Set(phases.map(arm=>parsed.get(arm)!.paramsSha256)).size!==1||
    new Set(phases.map(arm=>JSON.stringify(parsed.get(arm)!.params))).size!==1||
    phases.some(arm=>parsed.get(arm)!.tickMs!==100)||
    b.checkout!==c.checkout||b.sourceSHA!==c.sourceSHA||b.sourceManifestSha256!==c.sourceManifestSha256||
    JSON.stringify(b.pins)!==JSON.stringify(c.pins)||a0.checkout===a.checkout||
    a0.checkout===b.checkout||a.checkout===b.checkout||init.checkout!==a.checkout)
    fail('PILOT_ARM_IDENTITY_INVALID');
  const output=(arm:string)=>join(root,'seed-51926',arm);
  if(a0.expectedClock!==join(output('B'),'clock.json')||a.expectedClock!==a0.expectedClock||
    c.expectedClock!==a0.expectedClock||a.expectedPublic!==join(output('A0'),'physical.cuts')||
    c.expectedPublic!==join(output('B'),'physical.cuts')||
    c.expectedCommon!==join(output('B'),'common.cuts')||
    c.expectedExtension!==join(output('B'),'extension.cuts'))fail('PILOT_REFERENCES_INVALID');
  const packageRoot=dirname(new URL(import.meta.url).pathname),driver=join(packageRoot,'driver.mts');
  const receipt:Record<string,unknown>={schema:plan.schema,mode:plan.mode,state:'UNKNOWN',phaseReceipts:[],
    sourceSHA:b.sourceSHA,runtime:b.runtime,harnessPins:b.harnessPins,
    a0:'EXACT_UNPATCHED_PUBLIC_ONLY',aPatched:'A_PATCHED_FOR_VISIBILITY',
    bcExtension:'B_C_ONLY',scheduler:'APP-SCHEDULER-INCOMPLETE',recovery:'SNAPSHOT-RECOVERY-NOT-VERIFIED',
    probeTwin:'PROBE-NONINTERFERENCE-UNPROVEN',scientificAcceptance:false};
  let problem:string|null=null;
  const execution=['INIT','B','B_TWIN','A0','A_PATCHED_FOR_VISIBILITY','C'] as const;
  try{for(const arm of execution){const configArm=arm==='B_TWIN'?'B':arm;
      const cfg=parsed.get(configArm)!;const runtime=cfg.runtime as {path:string;loader:string};
      const action=arm==='INIT'?'init':arm==='B_TWIN'?'twin':'run';
      const child=spawnSync(runtime.path,['--import',runtime.loader,driver,configs[configArm]!,action],
        {cwd:String(cfg.checkout),env:process.env,stdio:['ignore','ignore','pipe'],encoding:'utf8',maxBuffer:65536});
      if(child.error||child.status!==0)fail('PILOT_PHASE_FAILED_'+arm);
      const outputReceipt=join(output(arm),arm==='INIT'?'bootstrap.json':'run.json');
      const r=readJson(outputReceipt);
      if(arm!=='INIT'&&(r.state!==(arm==='B_TWIN'?'PROBE_TWIN_EQUAL':'CANDIDATE_COMPARISON_ONLY')||r.cuts!==121))
        fail('PILOT_RECEIPT_INCOMPLETE');
      (receipt.phaseReceipts as unknown[]).push({arm,path:outputReceipt,sha256:hash(readFileSync(outputReceipt))});
    }
    const physical=compareFramed(join(output('A_PATCHED_FOR_VISIBILITY'),'physical.cuts'),
      join(output('B'),'physical.cuts'),121,'A_PATCHED_B_PUBLIC');
    const common=compareFramed(join(output('A_PATCHED_FOR_VISIBILITY'),'common.cuts'),
      join(output('B'),'common.cuts'),121,'A_PATCHED_B_COMMON');
    receipt.comparisons={B_PROBE_TWIN:'121_CUTS_EQUAL',A0_A_PATCHED_PUBLIC:'121_CUTS_EQUAL',A_PATCHED_B_PUBLIC:physical,
      A_PATCHED_B_COMMON:common,B_C_PUBLIC_COMMON_EXTENSION:'121_CUTS_EQUAL_BY_C_DRIVER'};
    receipt.state='CANDIDATE_COMPARISON_ONLY';
  }catch(error){problem=error instanceof Error&&/^[A-Z0-9_-]+$/.test(error.message)?error.message:'PILOT_ERROR';}
  receipt.problem=problem;atomicJson(join(root,'pilot-receipt.json'),receipt);
  if(problem)fail(problem);
}
main().catch(error=>{const code=error instanceof Error&&/^[A-Z0-9_-]+$/.test(error.message)?error.message:'PILOT_ERROR';
  process.stderr.write(code+'\n');process.exitCode=1;});
