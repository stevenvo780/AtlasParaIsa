/** Manual synthetic event scripts. Independent of observer, World, scores and RNG.
 * Expand repeated complete iteration witnesses, never emulate engine decisions.
 * Daily equality is deliberately irrelevant to the reader. */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const pin = 'a'.repeat(64);
export interface Scenario { name:string; tick:number; variant:string; expect:string; }
const state = (action='drink', x=0, bits='UNKNOWN', decisionAt=6000) => ({action,target:{x,y:0},decisionAt,thirstBits:bits});
const gate = (pre: ReturnType<typeof state>, post=pre, eligible=false) => ({id:'descendant-1',ordinal:1,eligible,path:'gate',pre,post});
const commit = (tick:number, pre: ReturnType<typeof state>, post: ReturnType<typeof state>) => ({kind:'commit',tick,id:'descendant-1',ordinal:1,
  pre:{...pre,thirstBits:'3fc3f8dd73b519d9'},post:{...post,thirstBits:'3fc3f8dd73b519d9'},selectedAction:post.action,
  selectedTarget:post.target,selectedScoreBits:'3ff0000000000000',candidateCount:2,reasonHash:'UNKNOWN'});
export function manualFixture(dir:string, scenario:Scenario): [string,string,string,string] {
  const p = {dataKind:'SYNTHETIC',status:'SEALED',sealedBeforeData:true,originalHEAD:'6516c62e06fe2b22493e029022fab7f32388b674',
    sourceSHA:pin,worldSourceHash:pin,harnessHash:pin,seed:18107,initialHash:pin,paramsHash:pin,runtimeHash:pin,
    firstTick:1,endTick:4810,lowerInclusive:4807,pairId:'manual-private',actor:'descendant-1',
    thirstBeforeBits:'3fc3f8dd73b519d9',thirstAfterBits:'3fc3f8dd73b519d8'};
  const prereg = JSON.stringify(p)+'\n', preregPath=join(dir,'prereg.json'), identityPath=join(dir,'identity.json');
  writeFileSync(preregPath,prereg);writeFileSync(identityPath,JSON.stringify({sourceSHA:pin,worldSourceHash:pin,harnessHash:pin}));
  const paths = ['CTRL','PLAC'].map(arm => {
    const path=join(dir,arm+'.jsonl'); let seq=0,gates=0,decisions=0;
    const lines: string[]=[];
    const append=(r:object) => lines.push(JSON.stringify({...r,seq:++seq})+'\n');
    append({kind:'header',version:1, ...p, fieldCoverage:{gate:'ALL_ACTUAL_ITERATIONS',prePost:'ACTION_TARGET_DECISION_AT',thirstBits:'COMMIT_ONLY',selectedScoreBits:'COMMIT_ONLY',candidateCount:'COMMIT_ONLY',reasonHash:'UNKNOWN_NOT_EXPORTED',sourceOrdinal:'ACTUAL_ITERATION'}, preregSHA:sha(prereg),arm,runId:arm,pairedRunId:arm==='CTRL'?'PLAC':'CTRL',
      ...(arm==='PLAC' && scenario.variant==='source'?{sourceSHA:'b'.repeat(64)}:{})});
    let cached = '';
    for (let tick=1;tick<=p.endTick;tick++) {
      if (arm==='PLAC' && scenario.variant==='history' && tick===scenario.tick) continue;
      let s=state(), pre=s, post=s, eligible=false;
      const active=!(scenario.variant==='death' && tick>=scenario.tick);
      const event=tick===scenario.tick;
      if (event && scenario.variant!=='death') {
        eligible=arm==='PLAC' || ['float','target','transient','boundary'].includes(scenario.variant);
        if (arm==='PLAC') {
          if (['transient','unilateral','boundary'].includes(scenario.variant)) post=state('eat');
          if (scenario.variant==='target') post=state('drink',1);
          if (scenario.variant==='gate') post=state('drink',0,'UNKNOWN',6037);
        }
      }
      if (arm==='PLAC' && ['unilateral','boundary','target'].includes(scenario.variant) && tick>scenario.tick)
        pre=post=state(scenario.variant==='target'?'drink':'eat',scenario.variant==='target'?1:0);
      if (arm==='PLAC' && scenario.variant==='gate' && tick>scenario.tick) pre=post=state('drink',0,'UNKNOWN',6037);
      if (arm==='PLAC' && scenario.variant==='transient' && tick===scenario.tick+1) {
        eligible=true;pre=state('eat');post=state();
      }
      const g=gate(pre,post,eligible), serialized=JSON.stringify(g);
      const changes: unknown[]=active && (cached!==serialized || eligible)?[g]:[];
      const commits: Record<string,unknown>[]=[];
      if (active && eligible) {
        const c=commit(tick,pre,post);
        if (arm==='PLAC' && event && scenario.variant==='float') c.post.thirstBits='3fc3f8dd73b519d8';
        commits.push(c);
      }
      if (arm==='PLAC' && event && scenario.variant==='missing') commits.length=0;
      if (arm==='PLAC' && event && scenario.variant==='malformed') delete (g.post as Partial<typeof g.post>).target;
      const removed=!active && cached?['descendant-1']:[];
      cached=active?serialized:'';gates+=active?1:0;decisions+=commits.length;
      append({kind:'window',tick,expected:active?1:0,visited:active?1:0,rosterHash:sha(JSON.stringify(active?['descendant-1']:[])),
        changes,commits,removed,gateTotal:gates,decisionTotal:decisions});
    }
    const receipt=arm==='CTRL'?null:{tick:4807,personaId:p.actor,variable:'thirst',direccion:'down',beforeBits:p.thirstBeforeBits,afterBits:p.thirstAfterBits};
    append({kind:'footer',complete:true,windows:p.endTick,gateTotal:gates,decisionTotal:decisions,receipt});
    if (arm==='PLAC' && scenario.variant==='seq') lines[scenario.tick]=lines[scenario.tick]!.replace(/"seq":\d+/, '"seq":999999');
    writeFileSync(path,scenario.variant==='empty'?'':lines.join('')); return path;
  });
  return [paths[0]!,paths[1]!,preregPath,identityPath];
}
