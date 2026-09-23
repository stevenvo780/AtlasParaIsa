import {test} from 'node:test';
import {existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {chromium, expect, type WebSocketRoute} from '@playwright/test';
import {createBrowserTestServer as createServer} from './lib/vite.js';
import {structureCard, resourceQuantity} from '../src/client/inspector-view.js';
import {treeForm} from '../src/client/life-art.js';
import {createWorld, projectWorld} from '../src/world/index.js';
import type {StructureView} from '../src/shared/types.js';
import {PROTOCOL_VERSION} from '../src/shared/types.js';

const structure: StructureView = {id:'fixture-cistern',name:'Refugio',x:0,y:0,blueprintId:'base',components:['frame','roof','cistern','hearth'],condition:.8,water:.6,food:0,uses:123,builtAt:0,builderId:null};

test('facility facts separate cumulative benefits, stored water, empty reserves and tiny positive stock',()=>{
 const preserved=JSON.stringify(structure),html=structureCard(structure,null);
 assert.match(html,/Agua en la cisterna/);assert.match(html,/Usos con beneficio/);assert.match(html,/no indican ocupación actual/);
 assert.match(html,/Armazón · Cubierta · Cisterna · Hogar/);assert.doesNotMatch(html,/Usos reales|Último uso|Alimento en el granero|frame|hearth/);
 assert.match(structureCard({...structure,water:0},null),/data-structure-water><span>Agua en la cisterna<\/span><strong>0 /);
 assert.match(structureCard({...structure,water:.00001,condition:0},null),/&lt;0,01/);
 assert.match(structureCard({...structure,condition:0},null),/necesita reparación/);
 assert.doesNotMatch(structureCard({...structure,components:['frame','roof'],water:0},null),/data-structure-water/);
 assert.equal(resourceQuantity(0),'0');assert.equal(resourceQuantity(.004),'&lt;0,01');assert.equal(resourceQuantity(.4),'0,4');
 assert.equal(JSON.stringify(structure),preserved);
 const tile={x:0,y:0,terrain:'meadow' as const,wood:12,vegetation:0,growth:1,food:0,moisture:.5,feature:'tree' as const};
 assert.equal(treeForm(tile)!.foliage,0);assert.ok(treeForm(tile)!.height>=28);assert.equal(treeForm({...tile,wood:0}),null);
 assert.equal(treeForm({...tile,feature:'stump'}),null);
});

test('selected facility is visible in the mobile first fold and reserve-only changes keep focus with no orders',{timeout:30_000},async t=>{
 if(!existsSync(chromium.executablePath())){t.skip('Chromium absent: mobile first-fold facility visibility and reserve-only focus checks not run.');return;}
 let server:Awaited<ReturnType<typeof createServer>>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 try{
  server=await createServer();await server.listen();browser=await chromium.launch({headless:true});
  const p=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'}),w=projectWorld(createWorld(51926));
  w.structures=[structuredClone(structure)];w.tiles[0]={...w.tiles[0]!,x:0,y:0,terrain:'meadow',drinkingWater:0};w.places=[{id:'fixture',x:0,y:0,name:'Refugio',description:'Componentes frame, roof, cistern, hearth.',gatherings:0}];
  const preserved=JSON.stringify(w),messages:{type:string}[]=[],errors:string[]=[];let socket:WebSocketRoute|undefined;
  p.on('pageerror',e=>errors.push(e.name));await p.route('**/api/session',r=>r.fulfill({json:{authenticated:true}}));await p.route('**/api/world**',r=>r.fulfill({json:w}));
  await p.route('**/api/gesture',r=>{messages.push({type:'gesture'});return r.fulfill({status:500});});await p.routeWebSocket(/\/ws(\?.*)?$/,s=>{socket=s;s.onMessage(m=>messages.push(JSON.parse(String(m))));});
  await p.goto(server.resolvedUrls!.local[0]!);await expect(p.locator('#connection-label')).toHaveText('En vivo');if(await p.locator('#letter-dialog').isVisible())await p.getByRole('button',{name:'Entrar al mundo'}).click();
  await p.locator('#layer-toggle').click();await p.locator('#tile-x').fill('0');await p.locator('#tile-y').fill('0');await p.locator('#tile-form button').click();await expect(p.locator('#camera-coordinates')).toHaveText('0, 0');
  const water=p.locator('[data-structure-water]');await expect(water).toContainText('0,6 / 0,6 u.');
  const box=await water.boundingBox(),drawer=await p.locator('#inspector-drawer').boundingBox();assert.ok(box&&drawer&&box.y>=drawer.y&&box.y+box.height<=drawer.y+drawer.height);
  await expect(p.locator('#inhabitant-card')).not.toContainText('frame, roof');const summary=p.locator('[data-detail="structure-ground"] summary');await summary.focus();
  const next=structuredClone(w);next.sequence++;next.structures![0]!.water=.000001;socket!.send(JSON.stringify({type:'state',world:next}));await expect(water).toContainText('<0,01');await expect(summary).toBeFocused();await expect(p.locator('#camera-coordinates')).toHaveText('0, 0');
  await summary.click();await expect(p.locator('[data-detail="structure-ground"]')).toContainText('Agua en el terreno');
  next.sequence++;next.structures![0]!.water=0;socket!.send(JSON.stringify({type:'state',world:next}));await expect(water).toContainText('0 / 0,6');await expect(summary).toBeFocused();
  assert.deepEqual(await p.locator('#landscape').boundingBox(),{x:0,y:0,width:390,height:844});assert.equal(messages.filter(m=>m.type==='gesture').length,0);assert.deepEqual(errors,[]);assert.equal(JSON.stringify(w),preserved);
 }finally{await browser?.close();await server?.close();}
});

test('cutaways reveal only selected material and leafless wood keeps deterministic non-leafy branches',{timeout:30_000},async t=>{
 if(!existsSync(chromium.executablePath())){t.skip('Chromium absent: cutaway material reveal and deterministic tree rendering checks not run.');return;}
 let server:Awaited<ReturnType<typeof createServer>>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 try{
  server=await createServer();await server.listen();browser=await chromium.launch({headless:true});
  const p=await browser.newPage({viewport:{width:640,height:480},reducedMotion:'reduce'});await p.addInitScript('window.__name = value => value');
  await p.route('**/__legibility',r=>r.fulfill({contentType:'text/html',body:'<canvas style="width:640px;height:480px"></canvas>'}));await p.goto(new URL('__legibility',server.resolvedUrls!.local[0]).href);
  const result=await p.evaluate(async ({structure,version})=>{
   const path='/src/client/landscape.ts',artPath='/src/client/life-art.ts';const {Landscape}=await import(/* @vite-ignore */path),{paintTree}=await import(/* @vite-ignore */artPath);
   const r=new Landscape(document.querySelector('canvas')!,()=>{}),tiles=Array.from({length:20*16},(_,i)=>({x:i%20-10,y:Math.floor(i/20)-8,terrain:'meadow',biome:'forest',feature:'tree',moisture:.7,food:.2,wood:12,vegetation:1,growth:1,variety:i%4}));
   tiles.find(t=>t.x===4&&t.y===0)!.feature='spring';Object.assign(tiles.find(t=>t.x===4&&t.y===0)!,{drinkingWater:.8,wood:0});
   const w={version,tick:900,sequence:900,phase:'day',weather:'clear',day:1,width:20,height:16,originX:-10,originY:-8,tiles,people:[],animals:[],structures:[structure],places:[],events:[],memories:[]};const preserved=JSON.stringify(w);
   r.update(w);r.cam.x=0;r.cam.y=0;r.cam.zoom=24;
   const draw=(selection:object|null)=>{r.setSelection(selection);r.drawScene(w,[],[],0);return r.sceneCtx.getImageData(0,0,r.scene.width,r.scene.height).data.slice();};
   const normal=draw(null),selected=draw({kind:'tile',x:0,y:0}),cleared=draw({kind:'tile',x:-9,y:-7}),water=draw({kind:'tile',x:4,y:0});
   let changes=0,distantChanges=0,waterChanges=0;for(let y=0;y<r.scene.height;y++)for(let x=0;x<r.scene.width;x++){const i=(y*r.scene.width+x)*4;if(normal[i]!==selected[i]||normal[i+1]!==selected[i+1]||normal[i+2]!==selected[i+2]){changes++;if(Math.abs(x-160)>40||Math.abs(y-128)>64)distantChanges++;}if(normal[i]!==water[i]||normal[i+1]!==water[i+1]||normal[i+2]!==water[i+2])waterChanges++;}
   const signatures=[];let rootsStable=true,greenPixels=0;for(let variant=0;variant<4;variant++){const c=document.createElement('canvas');c.width=32;c.height=48;paintTree(c.getContext('2d'),{kind:'tree',height:42,width:18,foliage:0,variant},1);const data=c.getContext('2d')!.getImageData(0,0,32,48).data;signatures.push(Array.from(data).join(','));rootsStable&&=data[(43*32+15)*4+3]>0;for(let i=0;i<data.length;i+=4)if(data[i+3]>100&&data[i+1]>data[i])greenPixels++;}
   const again=document.createElement('canvas');again.width=32;again.height=48;paintTree(again.getContext('2d'),{kind:'tree',height:42,width:18,foliage:0,variant:0},1);const deterministic=signatures[0]===Array.from(again.getContext('2d')!.getImageData(0,0,32,48).data).join(',');
   r.destroy();return{changes,distantChanges,waterChanges,restored:Array.from(normal).join(',')===Array.from(cleared).join(','),unchanged:JSON.stringify(w)===preserved,variants:new Set(signatures).size,rootsStable,greenPixels,deterministic};
  },{structure,version:PROTOCOL_VERSION});
  assert.ok(result.changes>0&&result.waterChanges>0);assert.equal(result.distantChanges,0);assert.equal(result.restored,true);assert.equal(result.unchanged,true);assert.equal(result.variants,4);assert.equal(result.rootsStable,true);assert.equal(result.greenPixels,0);assert.equal(result.deterministic,true);
 }finally{await browser?.close();await server?.close();}
});
