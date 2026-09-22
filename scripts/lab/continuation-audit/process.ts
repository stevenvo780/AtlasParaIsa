import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

export interface ProcessIdentity { pid:number; ppid:number; pgid:number; sid:number; state:string; start:string }
export function identities(): ProcessIdentity[] {
  const rows:ProcessIdentity[]=[];
  for(const name of readdirSync('/proc')) {
    if(!/^\d+$/.test(name))continue;
    try {const raw=readFileSync(`/proc/${name}/stat`,'utf8'),parts=raw.slice(raw.lastIndexOf(')')+2).split(' ');
      rows.push({pid:Number(name),state:parts[0]!,ppid:Number(parts[1]),pgid:Number(parts[2]),sid:Number(parts[3]),start:parts[19]!});
    }catch(error){if(!['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  }return rows;
}
export function liveGroup(pgid:number, start?:string): ProcessIdentity[] {
  const all=identities(),leader=all.find(p=>p.pid===pgid);
  if(leader&&start&&leader.start!==start)throw new Error('Owned process identity was reused; refusing signals');
  const group=all.filter(p=>p.pgid===pgid&&!['Z','X'].includes(p.state));
  if(group.some(p=>p.sid!==pgid||start&&BigInt(p.start)<BigInt(start)))throw new Error('Group membership no longer matches owned session');
  return group;
}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function signalGroup(pid:number,signal:NodeJS.Signals,start?:string):void {
  if(!liveGroup(pid,start).length)return;
  try {process.kill(-pid,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
}
async function drain(pid:number,start:string|undefined,graceMs:number):Promise<{leaked:boolean;clear:boolean}> {
  if(!liveGroup(pid,start).length)return {leaked:false,clear:true};
  signalGroup(pid,'SIGTERM',start);
  const until=performance.now()+graceMs;
  while(performance.now()<until){if(!liveGroup(pid,start).length)return {leaked:true,clear:true};await pause(Math.min(50,Math.max(1,until-performance.now())));}
  signalGroup(pid,'SIGKILL',start);
  for(let i=0;i<40;i++){if(!liveGroup(pid,start).length)return {leaked:true,clear:true};await pause(25);}
  return {leaked:true,clear:false};
}
export interface OwnedResult {code:number|null;signal:NodeJS.Signals|null;pid:number|null;timedOut:boolean;interrupted:boolean;descendantsFound:boolean;groupClear:boolean;error?:string;durationMs:number}
/** A finite deadline plus bounded group cleanup, even if the leader exits first. */
export async function runOwned(command:string,args:string[],options:{cwd:string;env:NodeJS.ProcessEnv;logFd:number;timeoutMs:number;signal?:AbortSignal;graceMs?:number;onSpawn?:(pid:number)=>void}):Promise<OwnedResult> {
  if(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>21_600_000)throw new Error('Invalid owned deadline');
  const started=performance.now();let timedOut=false,interrupted=false,error:string|undefined,start:string|undefined;
  const child=spawn(command,args,{cwd:options.cwd,env:options.env,stdio:['ignore',options.logFd,options.logFd],detached:true});
  const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{
    child.once('error',e=>{error=String(e);resolve({code:null,signal:null});});
    child.once('exit',(code,signal)=>resolve({code,signal}));
  });
  const pid=child.pid;
  if(pid)try{start=identities().find(p=>p.pid===pid)?.start;options.onSpawn?.(pid);}catch(e){error=String(e);child.kill('SIGKILL');}
  const stop=()=>{interrupted=true;if(pid)try{signalGroup(pid,'SIGTERM',start);}catch(e){error=String(e);child.kill('SIGKILL');}};
  const timer=setTimeout(()=>{timedOut=true;if(pid)try{signalGroup(pid,'SIGTERM',start);}catch(e){error=String(e);child.kill('SIGKILL');}},options.timeoutMs);
  // KILL is tied to the deadline/abort, not to the lifetime of npm/node's leader.
  let killTimer:ReturnType<typeof setTimeout>|undefined;
  const armKill=()=>{if(!killTimer)killTimer=setTimeout(()=>{if(pid)try{signalGroup(pid,'SIGKILL',start);}catch(e){error=String(e);child.kill('SIGKILL');}},options.graceMs??5000);};
  const deadlineKill=setTimeout(armKill,options.timeoutMs);
  const abort=()=>{stop();armKill();};options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  const ended=await exited;
  clearTimeout(timer);clearTimeout(deadlineKill);if(killTimer)clearTimeout(killTimer);options.signal?.removeEventListener('abort',abort);
  let cleanup={leaked:false,clear:true};
  if(pid)try{cleanup=await drain(pid,start,options.graceMs??5000);}catch(e){cleanup={leaked:true,clear:false};error=String(e);}
  return {...ended,pid:pid??null,timedOut,interrupted,descendantsFound:cleanup.leaked,groupClear:cleanup.clear,...(error?{error}:{}),durationMs:performance.now()-started};
}
