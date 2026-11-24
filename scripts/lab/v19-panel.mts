#!/usr/bin/env node
/** Paired CTRL/V19 durable-store panel. One isolated world per invocation. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../../src/server/store.js';
import { hostOpenWorldParams } from '../../src/server/hardware-limits.js';
import { createWorld, stepWorld, TICKS_PER_DAY, closeFaunaParallelPools, closePersonasParallelPools, closePolicyGpuBatchers, bindWorldContext, worldContext, type World } from '../../src/world/index.js';
import { ResidentTopologyOwner } from '../../src/world/soa/topologia.js';
import { closeEcosystemWorkers } from '../../src/world/ecosystem.js';
import { DEFAULT_PARAMS, parseParams, paramsOf, setParams } from '../../src/world/params.js';
import { digestoCanonico } from '../../src/world/digesto.js';

function flag(k: string): string | undefined { const i = process.argv.indexOf(k); return i < 0 ? undefined : process.argv[i + 1]; }
function need(k: string): string { const v = flag(k); if (!v || v.startsWith('--')) throw new Error(`Falta ${k}.`); return v; }
function quantile(a: number[], q: number): number { if (!a.length) return 0; const s = [...a].sort((x,y)=>x-y); return s[Math.ceil(q*s.length)-1]!; }
function mean(a: number[]): number { return a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0; }
const SPECIES = ['hare','deer','boar','fish','fox','wolf'];
const FIELDS_V19: Record<string, unknown> = {
  'conducta.aprendizajeCausal': true, 'social.acuerdosMateriales': true,
  'construccion.modular': true, 'tecnologia.obrasPorPropiedades': true,
  'fauna.contactoContinuo': true, 'fauna.reservaReproductiva': true,
  'fauna.encuentroFertil': true, 'ecologia.amplitudEstacional': 0.25,
  'conducta.memoriaResultadoTicks': 2400, 'social.memoriaResultadosDias': 10,
  'fauna.fraccionReservaCria': 0.15, 'ecologia.periodoEstacionalDias': 20,
  'ecologia.escalaClimaticaCeldas': 64,
};

function metrics(w: World, sampled: World[], birthBySpecies: Record<string, number>, birthTotal: number, predations: number, late: World[]): Record<string, unknown> {
  const mortals = w.people.filter(p => p.role === 'neighbor');
  const species: Record<string, unknown> = {};
  for (const name of SPECIES) {
    const aa = w.animals.filter(a => (a.species as string) === name);
    species[name] = { n: aa.length, maxGen: Math.max(0,...aa.map(a=>a.generation)), g1Plus: aa.filter(a=>a.generation>=1).length,
      g2Plus: aa.filter(a=>a.generation>=2).length, meanHunger: mean(aa.map(a=>a.hunger)), meanEnergy: mean(aa.map(a=>a.energy)), meanReserve: mean(aa.map(a=>Number(a.reproReserve ?? 0))), births: birthBySpecies[name] ?? 0 };
  }
  const camps: number[] = [];
  for (const day of sampled) for (const p of day.people) if (p.role === 'neighbor' && p.energy >= .9 && p.fatigue <= .15 && p.hunger < .7 && p.thirst < .7) camps.push(p.action === 'rest' ? 1 : 0);
  const div = (x: World) => x.communities.map(c => Number((c as any).diversity?.effectiveProcesses ?? (c as any).diversity ?? 0)).filter(Number.isFinite);
  const diversity = (worlds: World[]) => mean(worlds.flatMap(div));
  const opens = w.communities.map(c=>c.culture.openness), shares=w.communities.map(c=>c.culture.sharing), stews=w.communities.map(c=>c.culture.stewardship);
  const conflictEvents = w.events.filter(e=>e.kind==='conflict');
  const close = (xs:number[]) => xs.length ? Math.sqrt(mean(xs.map(x=>(x-mean(xs))**2))) : 0;
  const installations = w.structures.flatMap(s=>s.installed ?? []);
  return {
    tick:w.tick, pop:w.people.length, mortals:mortals.length, births:w.birthCounter, deaths:w.demographyDynamics.deaths,
    deathCauses:{...w.demographyDynamics.causes}, livingMortalGens:[...new Set(mortals.map(p=>p.genome.generation))].sort((a,b)=>a-b),
    maxGen:Math.max(0,...mortals.map(p=>p.genome.generation)), communities:w.communities.length, ghostComms:w.communities.filter(c=>!c.members.length).length,
    untiredCampFrac:camps.length?mean(camps):null, untiredCampN:camps.length,
    meanOpen:mean(opens),meanShare:mean(shares),meanStew:mean(stews),commOpenSd:close(opens),commStewSd:close(stews),
    totalConflictEvents:w.totals.conflicts ?? 0, lateConflictEvents:late.reduce((n,x)=>n+x.events.filter(e=>e.kind==='conflict').length,0),
    commDisputesSum:w.communities.reduce((n,c)=>n+Number((c as any).disputes ?? 0),0),commCoopSum:w.communities.reduce((n,c)=>n+Number((c as any).cooperation ?? 0),0),
    blueprints:w.blueprints.length,lateBlueprints:w.events.filter(e=>e.kind==='invention'&&e.tick>w.tick/2).length,structures:w.structures.length,
    activeSites:w.structures.filter(s=>Boolean(s.site)).length,largeBuilt:w.structures.filter(s=>!s.site && s.components.length>8).length,
    multiTileBuilt:w.structures.filter(s=>((s.footprint?.width ?? 1) * (s.footprint?.height ?? 1)) > 1).length,
    warehousesWithStock:w.structures.filter(s=>(s.storedWood ?? 0) + (s.storedStone ?? 0) > 0).length,
    warehouseWoodTotal:w.structures.reduce((n,s)=>n+(s.storedWood ?? 0),0),
    warehouseStoneTotal:w.structures.reduce((n,s)=>n+(s.storedStone ?? 0),0),
    installedTotal:installations.length,recipesTotal:w.technology.catalogue?.totals.recipes ?? w.technology.recipeCounter,techMaxGen:w.technology.catalogue?.totals.maxGeneration ?? Math.max(0,...w.technology.recipes.map(r=>r.generation)),toolUses:w.technology.ledger.toolUses,
    fauna:species,faunaBirths:w.animalDynamics.births,faunaPredations:predations,faunaBirthEvents:birthTotal,faunaBirthsBySpecies:birthBySpecies,
    commDivEarly:diversity(sampled.filter(x=>x.tick>=5*TICKS_PER_DAY&&x.tick<=15*TICKS_PER_DAY)),commDivLate:diversity(sampled.filter(x=>x.tick>w.tick-10*TICKS_PER_DAY)),
    memoriesUntouched:JSON.stringify(w.memories)===JSON.stringify((w as any).__initialMemories),
    siLastMeeting:Math.max(0,...w.events.filter(e=>e.kind==='meeting'&&e.actors.includes('s')&&e.actors.includes('i')).map(e=>e.tick)),
    siBond:w.people.find(p=>p.id==='s')?.trust?.find(t=>t.id==='i')?.value ?? null,
  };
}

async function main(): Promise<void> {
  const arm=need('--arm'); if (!['CTRL','V19'].includes(arm)) throw new Error('--arm debe ser CTRL o V19');
  const seed=Number(need('--seed')), days=Number(need('--days')), out=resolve(need('--out')), hilos=Number(flag('--hilos')??'1');
  if (!Number.isSafeInteger(seed)||seed<0||!Number.isSafeInteger(days)||days<1||days>365||!Number.isInteger(hilos)||hilos<1||hilos>512) throw new Error('Argumentos numéricos fuera de rango.');
  const tmp=mkdtempSync(join(tmpdir(), 'atlas-v19-lab-')); process.env.CARTA_DATA_DIR=tmp;
  const store=new Store(join(tmp,'world.sqlite')); const started=performance.now(), steps:number[]=[], sampled:World[]=[];
  let peakRss=process.memoryUsage().rss, birthTotal=0, predations=0, eventCounter=0;
  const births:Record<string,number>=Object.fromEntries(SPECIES.map(s=>[s,0]));
  try {
    const openWorld = process.argv.includes('--open-world');
    let baseParams = openWorld ? hostOpenWorldParams() : DEFAULT_PARAMS;
    if (openWorld && arm === 'CTRL') {
      baseParams = parseParams({
        'conducta.aprendizajeCausal': false, 'social.acuerdosMateriales': false,
        'construccion.modular': false, 'tecnologia.obrasPorPropiedades': false,
        'fauna.contactoContinuo': false, 'fauna.reservaReproductiva': false,
        'fauna.encuentroFertil': false, 'ecologia.amplitudEstacional': 0,
      }, baseParams);
    }
    let params=parseParams({ 'motor.hilos':hilos, 'motor.gpu':[], 'persistencia.cadaTicks':TICKS_PER_DAY }, baseParams);
    if (!openWorld && arm==='V19') for (const [key,value] of Object.entries(FIELDS_V19)) { try { params=parseParams({[key]:value},params); } catch { /* permits running alongside staged parameter work */ } }
    const w=createWorld(seed,params); setParams(w,params);
    (w as any).__initialMemories=JSON.parse(JSON.stringify(w.memories));
    const owner=new ResidentTopologyOwner(); w.tiles=owner.tiles(w.tiles.map(t=>owner.tile(t))); bindWorldContext(w,{...worldContext(w),tileOwnership:owner});
    store.save(w); eventCounter=w.eventCounter;
    for(let i=1;i<=days*TICKS_PER_DAY;i++) {
      const t=performance.now(); stepWorld(w); steps.push(performance.now()-t);
      const ev=w.events.filter(e=>Number(e.id.slice(1))>eventCounter); eventCounter=w.eventCounter;
      for(const e of ev) { if(e.kind==='birth') birthTotal++; if(e.kind==='animal'&&/\bNace\b/i.test(e.text)) { birthTotal++; const sp=e.text.match(/Nace\s+(hare|deer|boar|fish|fox|wolf)\b/i)?.[1]?.toLowerCase(); if(sp&&sp in births) births[sp]++; } if(e.kind==='conflict') predations+=/predat/i.test(e.cause+' '+e.text)?1:0; }
      predations=Math.max(predations,w.animalDynamics.predations);
      if(i%TICKS_PER_DAY===0) { store.save(w); sampled.push({tick:w.tick, people:w.people.map(p=>({role:p.role,energy:p.energy,fatigue:p.fatigue,hunger:p.hunger,thirst:p.thirst,action:p.action})), communities:w.communities.map(c=>({diversity:(c as any).diversity,culture:c.culture})), events:w.events.map(e=>({kind:e.kind,tick:e.tick}))} as unknown as World); peakRss=Math.max(peakRss,process.memoryUsage().rss); }
    }
    const result={schema:'v19-panel-v1',arm,seed,days,hilos,ticks:w.tick,...metrics(w,sampled.slice(-10),births,birthTotal,predations,sampled.slice(-10)),
      p95StepMs:quantile(steps,.95),wallSec:(performance.now()-started)/1000,peakRssMiB:peakRss/1048576,
      digestPrefix:createHash('sha256').update(digestoCanonico(w)).digest('hex').slice(0,16),
      criterionDailySummary:null as unknown};
    mkdirSync(dirname(out),{recursive:true}); writeFileSync(out,JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify(result));
  } finally {
    try { await closeFaunaParallelPools(); } finally { try { await closePersonasParallelPools(); } finally { try { await closeEcosystemWorkers(); } finally { closePolicyGpuBatchers(); store.close(); rmSync(tmp,{recursive:true,force:true}); } } }
  }
}
main().catch(e=>{ console.error(e instanceof Error?e.stack:e); process.exitCode=1; });
