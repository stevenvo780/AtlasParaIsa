import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { treeForm } from '../src/client/life-art.js';
import { generateChunk } from '../src/world/terrain.js';
import type { Tile } from '../src/shared/types.js';

test('new forest visibility follows real woody sites, while mature bodies retain several human heights', () => {
  const tiles=generateChunk(51926,0,0).tiles, before=structuredClone(tiles);
  const forms=tiles.map(treeForm).filter(form=>form!==null);
  assert.ok(forms.length>10&&forms.length<tiles.length/3);
  assert.ok(forms.every(form=>form.height>=28&&form.height<=44));
  assert.ok(new Set(forms.map(form=>`${form.kind}:${form.height}:${form.variant}`)).size>5);
  for(const tile of tiles){
    if(tile.wood===0)assert.equal(treeForm(tile),null);
    if((tile.wood??0)>0&&['tree','pine','palm'].includes(tile.feature!))assert.ok(treeForm(tile));
  }
  const mature:Tile={x:0,y:0,terrain:'meadow',biome:'forest',wood:12,feature:'tree',growth:1,vegetation:1,moisture:.8,food:.3};
  assert.ok(treeForm({...mature,wood:1})!.height<treeForm(mature)!.height);
  assert.ok(treeForm({...mature,growth:.1})!.height<treeForm(mature)!.height);
  assert.equal(treeForm({...mature,vegetation:0})!.foliage,0);
  assert.deepEqual(tiles,before,'art cannot rewrite the stock distribution');
});

test('non-canopy wood stays visible as a size-dependent deposit beside pools, rock and old clearings', {timeout:30_000}, async t => {
  if(!existsSync(chromium.executablePath())){t.skip('Chromium absent: deposited wood, water co-visibility and raster controls were not exercised.');return;}
  const server=await createServer({configFile:false,server:{host:'127.0.0.1',port:0},logLevel:'error'});await server.listen();
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:640,height:480},reducedMotion:'reduce'});
    await page.addInitScript('window.__name=value=>value');
    await page.route('**/__forest_test.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><body style="margin:0"><canvas style="width:640px;height:480px"></canvas></body>'}));
    await page.goto(new URL('__forest_test.html',server.resolvedUrls!.local[0]).href);
    const result=await page.evaluate(async()=>{
      const path='/src/client/landscape.ts',{Landscape}=await import(/* @vite-ignore */ path);
      const renderer=new Landscape(document.querySelector('canvas')!,()=>{});
      const tile={x:0,y:0,terrain:'meadow',biome:'forest',feature:'none',wood:0,stone:2,food:0,vegetation:.7,growth:.7,moisture:.8,life:0,drinkingWater:.6};
      const raster=(changes:object)=>{
        const art=document.createElement('canvas');art.width=art.height=16;
        const state={...tile,...changes},before=JSON.stringify(state);renderer.bakeFeatures(art.getContext('2d')!,state);
        if(before!==JSON.stringify(state))throw new Error('renderer changed stock');
        return [...art.getContext('2d')!.getImageData(0,0,16,16).data];
      };
      const differences=(a:number[],b:number[])=>a.filter((n,i)=>n!==b[i]).length;
      const features=['pool','spring','rock','none','flowers'];
      const results=features.map(feature=>{
        const empty=raster({feature,wood:0}),small=raster({feature,wood:.001}),full=raster({feature,wood:12});
        return{feature,small:differences(empty,small),full:differences(empty,full),waterStillVisible:differences(full,raster({feature,wood:12,drinkingWater:0}))};
      });
      const shelter=differences(raster({terrain:'shelter',feature:'tree',wood:0}),raster({terrain:'shelter',feature:'tree',wood:8}));
      const absent=differences(raster({wood:0}),raster({wood:undefined}));
      const view={version:6,sequence:1,tick:1,day:1,phase:'day',weather:'clear',width:16,height:16,originX:0,originY:0,
        tiles:Array.from({length:256},(_,i)=>({...tile,x:i%16,y:Math.floor(i/16),wood:i===136?.001:0})),people:[],animals:[],structures:[],places:[],events:[],memories:[]};
      renderer.update(view);renderer.render(0);const before=renderer.getDiagnostics().terrainBuilds;
      renderer.update({...view,sequence:2,tick:2,tiles:view.tiles.map(t=>({...t,wood:0}))});renderer.render(0);
      const invalidated=renderer.getDiagnostics().terrainBuilds-before;
      renderer.destroy();return{results,shelter,absent,invalidated};
    });
    for(const row of result.results){assert.ok(row.small>0,row.feature);assert.ok(row.full>row.small,row.feature);assert.ok(row.waterStillVisible>0,row.feature);}
    assert.ok(result.shelter>0,'old stock under a shelter retains a ground deposit');
    assert.equal(result.absent,0,'absent or zero stock does not invent fallen wood');
    assert.ok(result.invalidated>0&&result.invalidated<=4,'depleting a sub-bucket remnant updates only its neighboring ground caches');
  }finally{await browser.close();await server.close();}
});
