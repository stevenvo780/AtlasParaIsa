import type { Tile } from '../shared/types.js';
import type { World } from './index.js';
import type { Chunk } from './terrain.js';
import { assertAnimals } from './animals.js';
import type { BlueprintView, StructureView } from '../shared/life.js';
import { validBlueprint, blueprintCost, blueprintAffordances, blueprintSignature } from './inventions.js';
import { LEGACY_WORLD_LIMITS, limitsOf, paramsOf } from './params.js';
import { desgasteQ } from './desgaste.js';
import { DESGASTE_Q } from '../shared/life.js';
export function assertEcosystemTile(tile: Tile, required = true): void {
  const fail = (): never => { throw new Error('Elemento del ecosistema inválido.'); };
  if ((required || tile.feature !== undefined) && !['tree','pine','palm','cactus','reeds','berries','flowers','rock','clay','stump','spring','pool','none'].includes(String(tile.feature))) fail();
  if ((required || tile.variety !== undefined) && (!Number.isInteger(tile.variety) || tile.variety! < 0 || tile.variety! > 3)) fail();
  for (const key of ['growth','fertility','cultivation','traffic','drinkingWater','life'] as const) {
    const value = tile[key];
    if ((required || value !== undefined) && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) fail();
  }
  if ((required || tile.fauna !== undefined) && (!Number.isInteger(tile.fauna) || tile.fauna! < 0 || tile.fauna! > 6)) fail();
  if (tile.species !== undefined && !['hare','deer','boar','fish','wolf','fox'].includes(tile.species)) fail();
  if ((tile.fauna ?? 0) > 0 && tile.species === undefined) fail();
}
const object = (v: unknown): v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v);
const number = (v: unknown,max=1): v is number => typeof v==='number' && Number.isFinite(v) && v>=0 && v<=max;
const integer = (v: unknown,max=Number.MAX_SAFE_INTEGER): v is number => number(v,max) && Number.isSafeInteger(v);
const string = (v: unknown,max=200): v is string => typeof v==='string' && v.length>0 && v.length<=max;
const coordinate = (v: unknown): v is number => typeof v==='number'&&Number.isSafeInteger(v)&&v>=-10_000_000&&v<10_000_000;
const fail = ():never=>{throw new Error('Estado de vida o estructuras inválido.');};
export function assertBlueprint(value: unknown,tick: number): asserts value is BlueprintView {
  if(!object(value)||!string(value.id,100)||!string(value.name,200)||!validBlueprint(value.components)||!integer(value.generation,64)||!Array.isArray(value.parents)||value.parents.length>2||!value.parents.every(p=>string(p,100))||!(value.inventorId===null||string(value.inventorId,50))||!integer(value.tick,tick)||!integer(value.uses)||!number(value.usefulness)||!object(value.cost)||!integer(value.cost.wood,12)||!integer(value.cost.stone,8)||!integer(value.cost.work,600)||value.cost.work<1)fail();
  const b=value as unknown as BlueprintView, cost=blueprintCost(b.components);
  if(b.cost.wood!==cost.wood||b.cost.stone!==cost.stone||b.cost.work!==cost.work)fail();
}
export function assertStructures(value: unknown,tick: number,tiles: Tile[],maxTiles=LEGACY_WORLD_LIMITS.teselasActivas): asserts value is StructureView[] {
  // The construction policy limits new work; it must not discard valid older roofs
  // when several archived regions become resident together.
  if(!Array.isArray(value)||value.length>Math.min(maxTiles,tiles.length))fail();
  const positions=new Map(tiles.map(t=>[`${t.x},${t.y}`,t])),ids=new Set<string>(),occupied=new Set<string>();
  for(const s of value as StructureView[]) {
    if(!object(s)||!string(s.id,100)||ids.has(s.id)||!coordinate(s.x)||!coordinate(s.y)||!string(s.blueprintId,100)||!string(s.name,200)||!validBlueprint(s.components)||!number(s.condition)||!number(s.water,4)||!number(s.food,4)||!integer(s.uses)||!integer(s.builtAt,tick)||!(s.builderId===null||string(s.builderId,50)))fail();
    const capacity=blueprintAffordances(s.components);
    if(s.water>capacity.waterCapacity||s.food>capacity.foodCapacity)fail();
    const position=`${s.x},${s.y}`;
    if(!positions.has(position)||positions.get(position)!.terrain!=='shelter'||occupied.has(position))fail();
    ids.add(s.id);occupied.add(position);
  }
}
/** DESG-D: N/R y anclas. Con ley=0 prohíbe los tres (fuente única); con ley=1 exige
 * prefijos sanos, anclas anteriores al horizonte (un ancla posterior a un respaldo
 * anterior es corrupción, nunca recorte silencioso) y caché fresca en residentes. */
export function assertDesgasteDormido(world: World): void {
  const ley = paramsOf(world).material?.desgasteDormido ?? 0;
  if (ley !== 0 && ley !== 1) fail();
  const archivadas = world.retiredChunks.flatMap(chunk => chunk.structures ?? []);
  if (ley === 0) {
    if (Object.hasOwn(world, 'revisionesObra') || Object.hasOwn(world, 'revisionesLluvia')) fail();
    for (const s of [...world.structures, ...archivadas]) if (Object.hasOwn(s, 'anclaDesgaste')) fail();
    return;
  }
  const N = world.revisionesObra, R = world.revisionesLluvia;
  if (!integer(N) || !integer(R) || (R as number) > (N as number)) fail();
  const revisa = (s: StructureView, fresca: boolean): void => {
    const a = (s as { anclaDesgaste?: unknown }).anclaDesgaste;
    if (!object(a) || Object.keys(a).length !== 3) fail();
    const { q0, n0, r0 } = a as Record<string, unknown>;
    if (!integer(q0, DESGASTE_Q) || !integer(n0) || !integer(r0) || (r0 as number) > (n0 as number)
      || (n0 as number) > (N as number) || (r0 as number) > (R as number)
      || ((R as number) - (r0 as number)) > ((N as number) - (n0 as number))) fail();
    if (fresca) {
      const q = desgasteQ(q0 as number, n0 as number, r0 as number, N as number, R as number, blueprintAffordances(s.components).durability);
      if (s.condition !== q / DESGASTE_Q) fail();
    }
  };
  for (const s of world.structures) revisa(s, true);
  for (const s of archivadas) revisa(s, false);
}
export function assertChunkLife(chunk: Chunk,tick: number): void {
  if(chunk.lifeVersion!==undefined&&chunk.lifeVersion!==4)fail();
  if(chunk.lifeVersion===4&&(chunk.animals===undefined||chunk.structures===undefined))fail();
  if(chunk.animals!==undefined){assertAnimals(chunk.animals,tick,chunk.tiles);assertFaunaStock(chunk.tiles,chunk.animals);}
  if(chunk.structures!==undefined)assertStructures(chunk.structures,tick,chunk.tiles);
}
export function assertDormantTerrain(chunk:Chunk,tick:number,ecosystemRequired:boolean):void {
  if(!object(chunk)||!integer(chunk.lastTick,tick)||!Number.isSafeInteger(chunk.cx)||!Number.isSafeInteger(chunk.cy)||!coordinate(chunk.cx*16)||!coordinate(chunk.cy*16)||chunk.key!==`${chunk.cx},${chunk.cy}`||typeof chunk.discovered!=='boolean'||!Array.isArray(chunk.tiles)||chunk.tiles.length!==256||!Array.isArray(chunk.places)||chunk.places.length>256)fail();
  for(const [i,t] of chunk.tiles.entries()){
    if(!object(t)||t.x!==chunk.cx*16+i%16||t.y!==chunk.cy*16+Math.floor(i/16)||!['water','soil','meadow','shelter'].includes(t.terrain)||!number(t.food)||!number(t.vegetation)||!number(t.moisture)||(t.wood!==undefined&&!number(t.wood,12))||(t.stone!==undefined&&!number(t.stone,8))||(t.elevation!==undefined&&!number(t.elevation)))fail();
    assertEcosystemTile(t,ecosystemRequired);
  }
  for(const p of chunk.places)if(!object(p)||!string(p.id,100)||!string(p.name,200)||typeof p.description!=='string'||p.description.length>2000||!coordinate(p.x)||!coordinate(p.y)||Math.floor(p.x/16)!==chunk.cx||Math.floor(p.y/16)!==chunk.cy||!integer(p.gatherings,1e6))fail();
}
function assertFaunaStock(tiles:Tile[],animals:World['animals']):void {
  const counts=new Map<string,number>();for(const a of animals){const key=`${a.x},${a.y}`;counts.set(key,(counts.get(key)??0)+1);}
  for(const tile of tiles)if((tile.fauna??0)!==(counts.get(`${tile.x},${tile.y}`)??0))fail();
}
export function assertLifeState(world: World): void {
  const limits=limitsOf(world,world.version);
  assertAnimals(world.animals,world.tick,world.tiles,limits.fauna);
  assertFaunaStock(world.tiles,world.animals);
  assertStructures(world.structures,world.tick,world.tiles,limits.teselasActivas);
  if(!integer(world.animalCounter)||!integer(world.blueprintCounter)||!integer(world.structureCounter)||!Array.isArray(world.blueprints)||world.blueprints.length<1||world.blueprints.length>64)fail();
  const ids=new Set<string>(),signatures=new Set<string>();
  for(const blueprint of world.blueprints) {assertBlueprint(blueprint,world.tick);const signature=blueprintSignature(blueprint.components);if(ids.has(blueprint.id)||signatures.has(signature))fail();ids.add(blueprint.id);signatures.add(signature);}
  if(!ids.has('blueprint-base'))fail();
  for(const blueprint of world.blueprints) {
    if(blueprint.parents.some(id=>id===blueprint.id||!ids.has(id))||new Set(blueprint.parents).size!==blueprint.parents.length)fail();
    if(blueprint.id==='blueprint-base'){if(blueprint.generation!==0||blueprint.parents.length||blueprint.components.join(',')!=='frame,roof'||blueprint.inventorId!==null||blueprint.tick!==0)fail();}
    else {
      const serial=/^blueprint-([1-9]\d*)$/.exec(blueprint.id);
      if(!serial||!integer(Number(serial[1]),world.blueprintCounter))fail();
      const parents=blueprint.parents.map(id=>world.blueprints.find(b=>b.id===id)!);
      if(!parents.length||blueprint.generation!==Math.max(...parents.map(b=>b.generation))+1||parents.some(b=>b.tick>blueprint.tick)||!(world.people.some(p=>p.id===blueprint.inventorId)||(world.version>=5&&world.legacy?.some(p=>p.id===blueprint.inventorId&&p.diedAt>=blueprint.tick))))fail();
    }
  }
  for(const s of world.structures) if(!ids.has(s.blueprintId)||blueprintSignature(s.components)!==blueprintSignature(world.blueprints.find(b=>b.id===s.blueprintId)!.components))fail();
  for(const [record,keys] of [[world.animalDynamics,['births','deaths','predations','humanHunts','waterConsumed','plantConsumed']],[world.inventionDynamics,['attempts','accepted','repairs','waterCollected','foodStored','foodTaken']]] as const) {
    if(!object(record)||Object.keys(record).length!==keys.length||keys.some(key=>!number((record as Record<string,unknown>)[key],1e12)))fail();
  }
  if(world.inventionDynamics.accepted>world.inventionDynamics.attempts||world.animalDynamics.predations+world.animalDynamics.humanHunts>world.animalDynamics.deaths)fail();
  for(const n of [world.animalDynamics.births,world.animalDynamics.deaths,world.animalDynamics.predations,world.animalDynamics.humanHunts,world.inventionDynamics.attempts,world.inventionDynamics.accepted,world.inventionDynamics.repairs])if(!integer(n,1e12))fail();
  for(const person of world.people) {
    if(person.blueprintId!==undefined&&person.blueprintId!==null&&!ids.has(person.blueprintId))fail();
    if(person.lastInvention!==undefined&&(!Number.isSafeInteger(person.lastInvention)||person.lastInvention< -2400||person.lastInvention>world.tick))fail();
    if(person.home!==undefined&&(!object(person.home)||!coordinate(person.home.x)||!coordinate(person.home.y)||!number(person.home.quality)||!integer(person.home.observedAt,world.tick)))fail();
    if(person.waterMemory!==undefined&&(!object(person.waterMemory)||Object.keys(person.waterMemory).length!==2||!coordinate(person.waterMemory.x)||!coordinate(person.waterMemory.y)))fail();
    if(person.conflictMemory!==undefined&&(!object(person.conflictMemory)||Object.keys(person.conflictMemory).length!==3||!coordinate(person.conflictMemory.x)||!coordinate(person.conflictMemory.y)||!integer(person.conflictMemory.tick,world.tick)))fail();
  }
  const animalIds=new Set(world.animals.map(a=>a.id)),structureIds=new Set(world.structures.map(s=>s.id));
  for(const chunk of world.retiredChunks) {
    assertChunkLife(chunk,world.tick);
    for(const animal of chunk.animals??[]){if(animalIds.has(animal.id))fail();animalIds.add(animal.id);}
    for(const structure of chunk.structures??[]){if(structureIds.has(structure.id)||!ids.has(structure.blueprintId))fail();structureIds.add(structure.id);}
  }
  for(const structure of [...world.structures,...world.retiredChunks.flatMap(c=>c.structures??[])]) {
    const serial=/^structure-([1-9]\d*)$/.exec(structure.id);
    if(serial && !integer(Number(serial[1]),world.structureCounter))fail();
    if(!serial && structure.id!==`structure-legacy-${structure.x}-${structure.y}`)fail();
  }
  for(const animal of [...world.animals,...world.retiredChunks.flatMap(c=>c.animals??[])]){
    const serial=/^animal-born-\d+-\d+-([1-9]\d*)$/.exec(animal.id);
    if(serial&&!integer(Number(serial[1]),world.animalCounter))fail();
  }
}
