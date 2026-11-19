/** FULL gate v5: only B/C use the private probe; their proof must match current bytes. */
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export type ProbeProofConfig = {
  mode:string; arm:string; sourceSHA:string; sourceManifestSha256:string; paramsSha256:string;
  runtime:unknown; harnessPins:unknown;
  nonInterferenceReceipt?:string; nonInterferenceReceiptSha256?:string;
};
type RecordValue = Record<string,unknown>;
const fail = ():never => { throw new Error('PROBE_NONINTERFERENCE_UNPROVEN'); };
const hash = (bytes:Uint8Array):string => createHash('sha256').update(bytes).digest('hex');
function record(value:unknown):RecordValue {
  if(value===null||typeof value!=='object'||Array.isArray(value))fail();
  return value as RecordValue;
}
function readRecord(path:string,sha:string,read:(path:string)=>Uint8Array):RecordValue {
  if(!/^[0-9a-f]{64}$/.test(sha))fail();
  const bytes=read(path);if(hash(bytes)!==sha)fail();
  try { return record(JSON.parse(Buffer.from(bytes).toString('utf8'))); } catch { return fail(); }
}
export function assertFullProbeNonInterference(c:ProbeProofConfig,read:(path:string)=>Uint8Array):void {
  if(c.mode!=='FULL_6X1200'||(c.arm!=='B'&&c.arm!=='C'))return;
  if(!c.nonInterferenceReceipt||!c.nonInterferenceReceiptSha256)fail();
  const proof=readRecord(c.nonInterferenceReceipt,c.nonInterferenceReceiptSha256,read);
  if(proof.schema!=='atlas-g2-parity-pilot/v2'||proof.mode!=='PILOT_51926_120'||
     proof.state!=='CANDIDATE_COMPARISON_ONLY'||proof.sourceSHA!==c.sourceSHA||
     JSON.stringify(proof.runtime)!==JSON.stringify(c.runtime)||
     JSON.stringify(proof.harnessPins)!==JSON.stringify(c.harnessPins)||
     record(proof.comparisons).B_PROBE_TWIN!=='121_CUTS_EQUAL'||proof.problem!==null)fail();
  if(!Array.isArray(proof.phaseReceipts))fail();
  const phases=proof.phaseReceipts.map(record);
  const expected=['INIT','B','B_TWIN','A0','A_PATCHED_FOR_VISIBILITY','C'];
  if(JSON.stringify(phases.map(p=>p.arm))!==JSON.stringify(expected))fail();
  const witnesses:RecordValue[]=[];
  for(const arm of ['B','B_TWIN']) {
    const phase=phases.find(p=>p.arm===arm)!;
    const path=join(dirname(c.nonInterferenceReceipt),'seed-51926',arm,'run.json');
    if(phase.path!==path||typeof phase.sha256!=='string')fail();
    const witness=readRecord(path,phase.sha256,read);
    if(witness.schema!=='atlas-g2-full-parity/v2'||witness.mode!=='PILOT_51926_120'||
       witness.arm!=='B'||witness.seed!==51926||witness.ticks!==120||witness.cuts!==121||
       witness.state!==(arm==='B_TWIN'?'PROBE_TWIN_EQUAL':'CANDIDATE_COMPARISON_ONLY')||
       witness.problem!==null||witness.sourceSHA!==c.sourceSHA||
       witness.sourceManifestSha256!==c.sourceManifestSha256||witness.paramsSha256!==c.paramsSha256||
       JSON.stringify(witness.runtime)!==JSON.stringify(c.runtime)||
       typeof witness.initialSha256!=='string'||!/^[0-9a-f]{64}$/.test(witness.initialSha256)||
       !Number.isSafeInteger(witness.clockReads)||(witness.clockReads as number)<0)fail();
    if(arm==='B_TWIN'&&(witness.clockReads!==0||witness.probeTwin!=='SAME_NEXT_STEPS_EQUAL'))fail();
    witnesses.push(witness);
  }
  if(witnesses[0]!.initialSha256!==witnesses[1]!.initialSha256)fail();
}
