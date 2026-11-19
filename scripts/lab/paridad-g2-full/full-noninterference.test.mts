import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertFullProbeNonInterference } from './full-noninterference.mjs';
import type { ProbeProofConfig } from './full-noninterference.mjs';

const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value));
function fixture(arm='B') {
  const root='/datos/tmp-atlas-lab/test-fixture/pilot';
  const runtime={path:'/node',sha256:'1'.repeat(64),version:'fixture',loader:'/loader',loaderSha256:'2'.repeat(64)};
  const harnessPins={driver:'3'.repeat(64),comparator:'4'.repeat(64),pilot:'5'.repeat(64),selfcheck:'6'.repeat(64)};
  const c:ProbeProofConfig={mode:'FULL_6X1200',arm,sourceSHA:'7'.repeat(40),sourceManifestSha256:'8'.repeat(64),paramsSha256:'9'.repeat(64),runtime,harnessPins,nonInterferenceReceipt:root+'/pilot-receipt.json'};
  const witness={schema:'atlas-g2-full-parity/v2',mode:'PILOT_51926_120',arm:'B',seed:51926,ticks:120,cuts:121,state:'CANDIDATE_COMPARISON_ONLY',problem:null,sourceSHA:c.sourceSHA,sourceManifestSha256:c.sourceManifestSha256,paramsSha256:c.paramsSha256,runtime,initialSha256:'a'.repeat(64),clockReads:965};
  const b={...witness},twin={...witness,state:'PROBE_TWIN_EQUAL',clockReads:0,probeTwin:'SAME_NEXT_STEPS_EQUAL'};
  const proof={schema:'atlas-g2-parity-pilot/v2',mode:'PILOT_51926_120',state:'CANDIDATE_COMPARISON_ONLY',sourceSHA:c.sourceSHA,runtime,harnessPins,problem:null,comparisons:{B_PROBE_TWIN:'121_CUTS_EQUAL'},phaseReceipts:['INIT','B','B_TWIN','A0','A_PATCHED_FOR_VISIBILITY','C'].map(a=>({arm:a,path:root+'/seed-51926/'+a+'/'+(a==='INIT'?'bootstrap.json':'run.json'),sha256:'b'.repeat(64)}))};
  const files=new Map<string,Buffer>();
  const seal=()=>{
    for(const [a,w] of [['B',b],['B_TWIN',twin]] as const){const p=proof.phaseReceipts.find(p=>p.arm===a)!;const bytes=encode(w);p.sha256=sha(bytes);files.set(p.path,bytes);}
    const bytes=encode(proof);files.set(c.nonInterferenceReceipt!,bytes);c.nonInterferenceReceiptSha256=sha(bytes);
  };
  seal();const read=(path:string)=>{const bytes=files.get(path);if(!bytes)throw Error('fixture missing');return bytes;};
  return {c,b,twin,proof,files,seal,read};
}
test('FULL A0/A†/INIT do not use B proof as authority or read its files',()=>{
  for(const arm of ['A0','A_PATCHED_FOR_VISIBILITY','INIT']){
    const f=fixture(arm);f.c.sourceSHA='c'.repeat(40);
    assert.doesNotThrow(()=>assertFullProbeNonInterference(f.c,()=>{throw Error('must not read B authority');}));
    delete f.c.nonInterferenceReceipt;delete f.c.nonInterferenceReceiptSha256;
    assert.doesNotThrow(()=>assertFullProbeNonInterference(f.c,()=>{throw Error('must not read');}));
  }
});
test('FULL B/C accept current bound proof with 121-cut B and zero-clock B_TWIN witnesses',()=>{
  for(const arm of ['B','C']){const f=fixture(arm);assert.doesNotThrow(()=>assertFullProbeNonInterference(f.c,f.read));}
});
test('FULL B/C reject missing proof, foreign source, missing fields and wrong harness',()=>{
  for(const arm of ['B','C'])for(const mutate of [
    (f:ReturnType<typeof fixture>)=>{delete f.c.nonInterferenceReceipt;},
    (f:ReturnType<typeof fixture>)=>{f.proof.sourceSHA='d'.repeat(40);},
    (f:ReturnType<typeof fixture>)=>{delete (f.proof as Partial<typeof f.proof>).harnessPins;},
    (f:ReturnType<typeof fixture>)=>{f.proof.harnessPins={...f.proof.harnessPins,driver:'e'.repeat(64)};},
    (f:ReturnType<typeof fixture>)=>{f.proof.comparisons.B_PROBE_TWIN='UNKNOWN';},
  ]){const f=fixture(arm);mutate(f);f.seal();assert.throws(()=>assertFullProbeNonInterference(f.c,f.read),/PROBE_NONINTERFERENCE_UNPROVEN/);}
});
test('FULL proof rejects altered bytes even when JSON metadata is otherwise valid',()=>{
  const f=fixture();f.files.set(f.c.nonInterferenceReceipt!,Buffer.concat([f.files.get(f.c.nonInterferenceReceipt!)!,Buffer.from(' ')]));
  assert.throws(()=>assertFullProbeNonInterference(f.c,f.read),/PROBE_NONINTERFERENCE_UNPROVEN/);
});
test('FULL proof rejects forged or incomplete B_TWIN evidence with fresh receipt hashes',()=>{
  for(const mutate of [
    (f:ReturnType<typeof fixture>)=>{f.twin.clockReads=1;},
    (f:ReturnType<typeof fixture>)=>{f.twin.cuts=120;},
    (f:ReturnType<typeof fixture>)=>{f.twin.initialSha256='f'.repeat(64);},
    (f:ReturnType<typeof fixture>)=>{f.twin.sourceSHA='0'.repeat(40);},
    (f:ReturnType<typeof fixture>)=>{f.twin.sourceManifestSha256='0'.repeat(64);},
    (f:ReturnType<typeof fixture>)=>{f.twin.state='UNKNOWN';},
    (f:ReturnType<typeof fixture>)=>{f.twin.probeTwin='UNPROVEN';},
  ]){const f=fixture();mutate(f);f.seal();assert.throws(()=>assertFullProbeNonInterference(f.c,f.read),/PROBE_NONINTERFERENCE_UNPROVEN/);}
});
test('FULL proof rejects phase substitution and unsealed phase bytes',()=>{
  const f=fixture();f.proof.phaseReceipts[2]!.arm='B';
  const substitutedProof=encode(f.proof);
  f.files.set(f.c.nonInterferenceReceipt!,substitutedProof);
  f.c.nonInterferenceReceiptSha256=sha(substitutedProof);
  assert.throws(()=>assertFullProbeNonInterference(f.c,f.read),/PROBE_NONINTERFERENCE_UNPROVEN/);
  const g=fixture();const path=g.proof.phaseReceipts[2]!.path;g.files.set(path,encode({...g.twin,clockReads:1}));
  assert.throws(()=>assertFullProbeNonInterference(g.c,g.read),/PROBE_NONINTERFERENCE_UNPROVEN/);
});
