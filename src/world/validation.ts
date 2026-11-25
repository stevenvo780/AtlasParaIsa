import type { Tile } from '../shared/types.js';
import type { World } from './index.js';
import type { Chunk } from './terrain.js';
import { assertAnimals } from './animals.js';
import { ELEMENTS } from '../shared/chemistry.js';
import type { BlueprintView, StructureView } from '../shared/life.js';
import { validBlueprint, blueprintCost, blueprintAffordances, blueprintSignature, blueprintCap, materialCapacity, structureFootprintCells, polyominoCost } from './inventions.js';
import { chunkKey } from './terrain.js';
import { LEGACY_WORLD_LIMITS, limitsOf, paramsOf } from './params.js';
/** Optional V23 traits: legacy snapshots remain valid without adding fields. */
export function assertAnimalTraits(animal: { morphology?: unknown; habituation?: unknown; tends?: unknown; lastTended?: unknown; lastHunted?: unknown }, tick: number): void {
  const unit = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  const fail = (): never => { throw new Error('Rasgos animales V23 inválidos.'); };
  if (animal.morphology !== undefined) {
    const m = animal.morphology;
    if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).length !== 4) fail();
    for (const k of ['caution', 'size', 'coat', 'defense']) if (!unit((m as Record<string, unknown>)[k])) fail();
  }
  if (animal.habituation !== undefined && !unit(animal.habituation)) fail();
  if (animal.tends !== undefined && !(typeof animal.tends === 'number' && Number.isSafeInteger(animal.tends) && animal.tends >= 0)) fail();
  for (const t of [animal.lastTended, animal.lastHunted]) if (t !== undefined
    && !(typeof t === 'number' && Number.isSafeInteger(t) && t >= 0 && t <= tick)) fail();
}
export function assertEcosystemTile(tile: Tile, required = true): void {
  const fail = (): never => { throw new Error('Elemento del ecosistema inválido.'); };
  if (tile.paved !== undefined && (typeof tile.paved !== 'number' || !Number.isFinite(tile.paved) || tile.paved < 0 || tile.paved > 1)) fail();
  if ((required || tile.feature !== undefined) && !['tree','pine','palm','cactus','reeds','berries','flowers','rock','clay','stump','spring','pool','none'].includes(String(tile.feature))) fail();
  if ((required || tile.variety !== undefined) && (!Number.isInteger(tile.variety) || tile.variety! < 0 || tile.variety! > 3)) fail();
  for (const key of ['growth','fertility','cultivation','traffic','drinkingWater','life'] as const) {
    const value = tile[key];
    if ((required || value !== undefined) && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) fail();
  }
  if ((required || tile.fauna !== undefined) && (!Number.isInteger(tile.fauna) || tile.fauna! < 0)) fail();
  if (tile.species !== undefined && !['hare','deer','boar','fish','wolf','fox'].includes(tile.species)) fail();
  if ((tile.fauna ?? 0) > 0 && tile.species === undefined) fail();
}
const object = (v: unknown): v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v);
const number = (v: unknown,max=1): v is number => typeof v==='number' && Number.isFinite(v) && v>=0 && v<=max;
const integer = (v: unknown,max=Number.MAX_SAFE_INTEGER): v is number => number(v,max) && Number.isSafeInteger(v);
const string = (v: unknown,max=200): v is string => typeof v==='string' && v.length>0 && v.length<=max;
const coordinate = (v: unknown): v is number => typeof v==='number'&&Number.isSafeInteger(v)&&v>=-10_000_000&&v<10_000_000;
const fail = ():never=>{throw new Error('Estado de vida o estructuras inválido.');};
export function assertBlueprint(value: unknown,tick: number,maxGeneration=64,modular=false): asserts value is BlueprintView {
  if(!object(value)||!string(value.id,100)||!string(value.name,200)||!validBlueprint(value.components,modular)||!integer(value.generation,maxGeneration)||!Array.isArray(value.parents)||value.parents.length>2||!value.parents.every(p=>string(p,100))||!(value.inventorId===null||string(value.inventorId,50))||!integer(value.tick,tick)||!integer(value.uses)||!number(value.usefulness)||!object(value.cost)||!integer(value.cost.wood,modular?Number.MAX_SAFE_INTEGER:12)||!integer(value.cost.stone,modular?Number.MAX_SAFE_INTEGER:8)||!integer(value.cost.work,modular?Number.MAX_SAFE_INTEGER:600)||value.cost.work<1)fail();
  const b=value as unknown as BlueprintView, cost=blueprintCost(b.components,modular);
  if(b.cost.wood!==cost.wood||b.cost.stone!==cost.stone||b.cost.work!==cost.work)fail();
}
export function assertStructures(value: unknown,tick: number,tiles: Tile[],maxTiles=LEGACY_WORLD_LIMITS.teselasActivas): asserts value is StructureView[] {
  // The construction policy limits new work; it must not discard valid older roofs
  // when several archived regions become resident together.
  if(!Array.isArray(value)||value.length>Math.min(maxTiles,tiles.length))fail();
  const positions=new Map(tiles.map(t=>[`${t.x},${t.y}`,t])),ids=new Set<string>(),occupied=new Set<string>();
  for(const s of value as StructureView[]) {
    if(!object(s)||!string(s.id,100)||ids.has(s.id)||!coordinate(s.x)||!coordinate(s.y)||!string(s.blueprintId,100)||!string(s.name,200)||!validBlueprint(s.components,true)||!number(s.condition)||!number(s.water,Number.MAX_SAFE_INTEGER)||!number(s.food,Number.MAX_SAFE_INTEGER)||!integer(s.uses)||!integer(s.builtAt,tick)||!(s.builderId===null||string(s.builderId,50)))fail();
    const capacity=blueprintAffordances(s.components);
    if(s.losses!==undefined&&(!object(s.losses)||Object.keys(s.losses).length!==2||!number(s.losses.water,Number.MAX_SAFE_INTEGER)||!number(s.losses.food,Number.MAX_SAFE_INTEGER)))fail();
    if(s.installed!==undefined){
      if(!Array.isArray(s.installed)||s.installed.length>4)fail();
      const installedIds=new Set<string>();let containment=0;
      for(const i of s.installed){
        if(!object(i)||!string(i.id,100)||installedIds.has(i.id)||!(i.recipeId===null||string(i.recipeId,100))||!integer(i.mass)||i.mass<1||![i.containment,i.insulation,i.cohesion,i.binding,i.condition].every(v=>number(v)))fail();
        if(i.composition!==undefined&&(!object(i.composition)||Object.keys(i.composition).length!==3||!integer(i.composition.wood)||!integer(i.composition.stone)||!integer(i.composition.water)||i.mass!==i.composition.wood+i.composition.stone+i.composition.water))fail();
        installedIds.add(i.id);containment+=i.containment*i.condition*i.mass/1000;
      }
      capacity.waterCapacity*=1+containment;capacity.foodCapacity*=1+containment;
    }
    if(s.water>capacity.waterCapacity||s.food>capacity.foodCapacity)fail();
    if(s.synergy!==undefined){
      const v=s.synergy;
      if(!object(v)||!integer(v.sharedEdges,24)||typeof v.heated!=='boolean'||typeof v.irrigated!=='boolean'
        ||!number(v.workshopBonus,0.30)||(v.kilnTier!==undefined&&![0,1,2].includes(v.kilnTier))
        ||Object.keys(v).some(k=>!['sharedEdges','heated','irrigated','workshopBonus','kilnTier'].includes(k)))fail();
    }
    if(s.materialProfile!==undefined){
      const p=s.materialProfile;
      if(!object(p)||Object.keys(p).length!==4||![p.strength,p.insulation,p.seal].every(v=>number(v))
        ||typeof p.tint!=='string'||!/^#[0-9a-f]{6}$/i.test(p.tint))fail();
    }
    if(s.storedCompounds!==undefined){
      if(!Array.isArray(s.storedCompounds))fail();
      const lots=new Set<string>();
      for(const lot of s.storedCompounds){
        if(!object(lot)||!string(lot.id,100)||lots.has(lot.id)||!string(lot.formulaId,100)||!number(lot.mass,Number.MAX_VALUE)
          ||!object(lot.composition)||Object.keys(lot.composition).length!==6||!ELEMENTS.every(e=>number(lot.composition[e],Number.MAX_VALUE))
          ||!['raw','ground','washed','fired','smelted','vitrified'].includes(lot.phase)||!object(lot.properties)
          ||!['hardness','toughness','seal','insulation','fuelPower'].every(k=>number((lot.properties as unknown as Record<string,unknown>)[k]))
          ||typeof lot.properties.colorHex!=='string'||!/^#[0-9a-f]{6}$/i.test(lot.properties.colorHex))fail();
        lots.add(lot.id);
      }
    }
    const checkFootprint=(components:StructureView['components'],footprint:StructureView['footprint'],cells?:StructureView['cells'])=>{
      const frames=components.filter(c=>c==='frame').length;
      if(footprint!==undefined&&(!object(footprint)||Object.keys(footprint).length!==2||![1,2].includes(footprint.width)||![1,2].includes(footprint.height)))fail();
      if(cells!==undefined){
        if(!Array.isArray(cells)||cells.length<1||cells.length>6)fail();
        const keys=new Set<string>();
        for(const c of cells){
          if(!object(c)||Object.keys(c).length!==2||!coordinate(c.x)||!coordinate(c.y)||chunkKey(c.x,c.y)!==chunkKey(s.x,s.y)||keys.has(`${c.x},${c.y}`))fail();
          keys.add(`${c.x},${c.y}`);
        }
        if(!keys.has(`${s.x},${s.y}`))fail();
        const reached=new Set([`${s.x},${s.y}`]),queue=[{x:s.x,y:s.y}];
        for(const c of queue)for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
          const p={x:c.x+dx!,y:c.y+dy!},key=`${p.x},${p.y}`;
          if(keys.has(key)&&!reached.has(key)){reached.add(key);queue.push(p);}
        }
        if(reached.size!==keys.size)fail();
        if(footprint){
          const w=Math.max(...cells.map(c=>c.x))-Math.min(...cells.map(c=>c.x))+1;
          const h=Math.max(...cells.map(c=>c.y))-Math.min(...cells.map(c=>c.y))+1;
          if(w!==footprint.width||h!==footprint.height)fail();
        }
        return;
      }
      const width=footprint?.width??1,height=footprint?.height??1;
      if(frames<=2?width!==1||height!==1:frames<=4?width*height!==2:width!==2||height!==2)fail();
    };
    checkFootprint(s.components,s.footprint,s.cells);
    const materials=materialCapacity(s);
    if((s.storedWood!==undefined&&!integer(s.storedWood,materials.wood))||(s.storedStone!==undefined&&!integer(s.storedStone,materials.stone)))fail();
    const completedCells=structureFootprintCells({...s,site:undefined});
    let expansion=false;
    if(s.site!==undefined){
      const site=s.site;let cost=s.cells?.length?polyominoCost(s.components,s.cells.length):blueprintCost(s.components,true);
      if(!object(site))fail();
      if(site.expansion!==undefined){
        const target=site.expansion;
        if(!object(target)||!string(target.blueprintId,100)||target.blueprintId===s.blueprintId||!validBlueprint(target.components,true)
          ||Object.keys(target).some(k=>!['blueprintId','components','footprint','cells'].includes(k)))fail();
        checkFootprint(target.components,target.footprint,target.cells);
        for(const c of ['frame','roof','cistern','granary','garden','hearth'] as const){
          const old=s.components.filter(v=>v===c).length,next=target.components.filter(v=>v===c).length;
          if(next<old||(c==='frame'&&next===old))fail();
        }
        const targetCost=target.cells?.length?polyominoCost(target.components,target.cells.length):blueprintCost(target.components,true);
        cost={wood:targetCost.wood-cost.wood,stone:targetCost.stone-cost.stone,work:targetCost.work-cost.work};
        const reserved=structureFootprintCells(s);
        if(!completedCells.every(c=>reserved.some(r=>c.x===r.x&&c.y===r.y)))fail();
        expansion=true;
      }
      if(Object.keys(site).length!==(expansion?7:6)||site.requiredWood!==cost.wood||site.requiredStone!==cost.stone||site.requiredWork!==cost.work
        ||!integer(site.depositedWood,site.requiredWood)||!integer(site.depositedStone,site.requiredStone)||!number(site.completedWork,site.requiredWork)
        ||(!expansion&&(s.condition!==0||s.water!==0||s.food!==0||s.uses!==0||(s.storedWood??0)!==0||(s.storedStone??0)!==0))
        ||(site.depositedWood===site.requiredWood&&site.depositedStone===site.requiredStone&&site.completedWork===site.requiredWork))fail();
    }
    for(const cell of structureFootprintCells(s)){
      const position=`${cell.x},${cell.y}`,tile=positions.get(position);
      const finished=!s.site||(expansion&&completedCells.some(c=>c.x===cell.x&&c.y===cell.y));
      if(!coordinate(cell.x)||!coordinate(cell.y)||!tile||occupied.has(position)
        ||(finished?tile.terrain!=='shelter':['water','shelter'].includes(tile.terrain)))fail();
      occupied.add(position);
    }
    ids.add(s.id);
  }
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
  const maxBlueprints=blueprintCap(world);
  if(!integer(world.animalCounter)||!integer(world.blueprintCounter)||!integer(world.structureCounter)||!Array.isArray(world.blueprints)||world.blueprints.length<1||world.blueprints.length>maxBlueprints)fail();
  const ids=new Set<string>(),signatures=new Set<string>();
  for(const blueprint of world.blueprints) {assertBlueprint(blueprint,world.tick,maxBlueprints,paramsOf(world).construccion.modular);const signature=blueprintSignature(blueprint.components);if(ids.has(blueprint.id)||signatures.has(signature))fail();ids.add(blueprint.id);signatures.add(signature);}
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
  for(const s of [...world.structures,...world.retiredChunks.flatMap(c=>c.structures??[])]){
    const target=s.site?.expansion;
    if(target&&(!ids.has(target.blueprintId)||blueprintSignature(target.components)!==blueprintSignature(world.blueprints.find(b=>b.id===target.blueprintId)!.components)))fail();
  }
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
    if(person.agreement!==undefined){const a=person.agreement as unknown as Record<string,unknown>;if(world.version<13||!object(a)||Object.keys(a).length!==6||typeof a.partner!=='string'||a.partner.length>100||!coordinate(a.x)||!coordinate(a.y)||!integer(a.tick,world.tick)||!['hunger','thirst'].includes(String(a.metric))||!number(a.level,1))fail();}
    if(person.partnerMemory!==undefined&&(!object(person.partnerMemory)||Object.keys(person.partnerMemory).length!==3||!coordinate(person.partnerMemory.x)||!coordinate(person.partnerMemory.y)||!integer(person.partnerMemory.tick,world.tick)))fail();
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
  // Uid del motor: de un solo contador para personas y fauna (también la archivada), así que únicos y menores que él.
  if(world.siguienteUid!==undefined&&(!integer(world.siguienteUid)||world.siguienteUid<1))fail();
  const uids=new Set<number>();
  for(const organismo of [...world.people,...world.animals,...world.retiredChunks.flatMap(c=>c.animals??[])]){
    const uid=organismo.uid;
    if(uid===undefined)continue;
    if(!integer(uid)||uid<1||world.siguienteUid===undefined||uid>=world.siguienteUid||uids.has(uid))fail();
    uids.add(uid);
  }
}
