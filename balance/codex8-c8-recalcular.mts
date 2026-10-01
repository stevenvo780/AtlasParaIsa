/** Read-only C8 recalculation. Invoke using codex8-node with CPU/nice guards. */
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {getPriority,setPriority} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const repo='/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/auditoria-realismo';
const base='/datos/tmp-atlas-lab/datos-lab/codex8-c8-copia';
function guard(){
  const cpu=readFileSync('/proc/self/status','utf8').split('\n').find(x=>x.startsWith('Cpus_allowed_list:'))!.split(':')[1]!.trim();
  const nice=getPriority();
  if(nice!==19 || cpu!=='6-31')throw Error(`Resource guard: nice=${nice}, CPUs=${cpu}`);
  return {pid:process.pid,comm:readFileSync('/proc/self/comm','utf8').trim(),nice,cpus:cpu,utc:new Date().toISOString()};
}
const launchNice=getPriority();
setPriority(19);
const initial=guard();
const sourceFiles=readdirSync(base+'/source-world').filter(n=>n.endsWith('.ts')).sort();
const sourceHash=createHash('sha256');
const sourceRecords=sourceFiles.map(name=>{
  const copy=base+'/source-world/'+name,bytes=readFileSync(copy);
  sourceHash.update(name).update('\0').update(bytes);
  return {name,copy,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
});
const sourceDigestHistorical=sourceHash.digest('hex');
if(sourceDigestHistorical!=='8e7ba9abc56e568fd8bc552b3aa874135108fcc4ab0ace44d17b7f535bdfb224')throw Error('Historical source digest mismatch');
const sourceManifest={sha:'18062f5063cddf7847051490c5f6ca34db81da4c',worldSourceDigest:sourceDigestHistorical,records:sourceRecords};
const sourceManifestPath=base+'/SOURCE-MANIFEST.json';
const serializedManifest=JSON.stringify(sourceManifest,null,2)+'\n';
try {
  if(readFileSync(sourceManifestPath,'utf8')!==serializedManifest)throw Error('Historical source manifest changed');
} catch(error) {
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  writeFileSync(sourceManifestPath,serializedManifest);
}
const criterionPath=repo+'/scripts/lab/criterio-terminado.mts';
const evaluatorSha256=createHash('sha256').update(readFileSync(criterionPath)).digest('hex');
if(evaluatorSha256!=='dd6330067dc0c8f09ba156da04bc4342f966c892bdbafec333dd912148e98325')throw Error('Frozen criterion changed');
const {evaluarSerieDiversidad,UMBRALES_POR_DEFECTO,evaluarConjunto,mannKendall}=await import(pathToFileURL(criterionPath).href);
const u={...UMBRALES_POR_DEFECTO,dia:60};
for(const [name,f,expect] of [['increasing',(d:number)=>d/60,'cumple'],['decreasing',(d:number)=>1-d/60,'falla'],['flat',(_d:number)=>.5,'falla']] as const){
  const got=evaluarSerieDiversidad(f,60,u);if(got.estado!==expect)throw Error(`Synthetic ${name}: ${got.estado}`);
}
const original=JSON.parse(readFileSync(base+'/criterio-primario.json','utf8'));
const c8=[] as unknown[];
const betweenTrends={} as Record<string,unknown>;
for(const folder of ['torre-primario','torre']){
  const report=evaluarConjunto(base+'/'+folder,u);
  for(const p of report.replicas){
    c8.push({nombre:p.nombre,brazo:p.brazo,semilla:p.semilla,estado:p.estado,terminada:p.terminada,ultimoDia:p.ultimoDia,c8:p.criterios.diversidad,security:Object.fromEntries(Object.entries(p.criterios).filter(([k])=>k!=='diversidad').map(([k,v])=>[k,v.estado]))});
    const pts=[] as [number,number][];
    for(let d=11;d<=60;d++){
      const row=JSON.parse(readFileSync(`${base}/${folder}/${p.nombre}/dia-${String(d).padStart(3,'0')}.json`,'utf8'));
      const y=row.diversidadEntreGrupos.comunidades;if(y!==null)pts.push([d,y]);
    }
    betweenTrends[p.nombre]=mannKendall(pts);
  }
}
let mismatch=0;
for(const old of original.replicas){
  const got=(c8 as any[]).find(p=>p.nombre===old.nombre);
  for(const k of ['S','p','pendienteSen','subida','factor'])if(got.c8.valores[k]!==old.criterios.diversidad.valores[k])mismatch++;
}
if(mismatch)throw Error(`Original report mismatch: ${mismatch}`);
const final=guard();
const output={evaluatorSha256,syntheticTests:3,originalPrimaryComparisonMismatches:mismatch,c8,betweenTrends,sourceDigestHistorical,sourceManifestSHA256:createHash('sha256').update(readFileSync(sourceManifestPath)).digest('hex'),resourceGuard:{launchNiceBeforeExplicitSet:launchNice,explicitSetNice:19,initial,final}};
const outputPath=process.argv[2]??'/datos/tmp-atlas-lab/balance/codex8-c8-node.json';
writeFileSync(outputPath,JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({outputPath,evaluatorSha256,sourceDigestHistorical,replicas:c8.length,resourceGuard:output.resourceGuard}));
