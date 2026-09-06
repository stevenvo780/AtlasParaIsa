import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {chromium, expect, type WebSocketRoute} from '@playwright/test';
import {createServer} from 'vite';
import {createWorld, projectWorld} from '../src/world/index.js';

/** Presentation fixture, not an autonomous survival experiment. No engine step is run. */
function populationFixture(extinct: boolean) {
  const view = projectWorld(createWorld(51926));
  if (!extinct) return view;
  view.people = view.people.filter(person => person.role !== 'neighbor');
  view.tick = view.sequence = 60000; view.day = 26;
  view.stats!.population = 2; view.stats!.totals.births = 18;
  view.stats!.actions = {rest: 2}; view.stats!.generations = {'0': 2};
  view.demography = {deaths: 32, causes: {starvation: 0, dehydration: 25, exposure: 7, senescence: 0}, recent: []};
  view.stats!.history = Array.from({length:96},(_,i)=>({tick:54240+i*60,population:2,energy:.6,hunger:.3,fatigue:.2,thirst:.4,discoveries:1,settlements:1,cooperation:0,births:18}));
  return view;
}

test('global mortality remains visible beside protected identities and a short two-person history',{timeout:60_000},async()=>{
  const server=await createServer({configFile:false,server:{host:'127.0.0.1',port:0},logLevel:'error'});await server.listen();
  const browser=await chromium.launch({headless:true});mkdirSync('artifacts',{recursive:true});
  const report:{scenario:string;viewport:number[];mortalityVisible:boolean;orders:number;worldUnchanged:boolean}[]=[];
  try{
    for(const[width,height]of[[390,844],[1440,900]])for(const extinct of[true,false]){
      const context=await browser.newContext({viewport:{width:width!,height:height!},reducedMotion:'reduce'}),page=await context.newPage();
      const original=populationFixture(extinct),preserved=JSON.stringify(original);let current=structuredClone(original),socket:WebSocketRoute|undefined;
      const messages:{type:string}[]=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.name));
      await page.route('**/api/session',r=>r.fulfill({json:{authenticated:true}}));await page.route('**/api/world**',r=>r.fulfill({json:current}));
      await page.route('**/api/gesture',r=>{messages.push({type:'gesture'});return r.fulfill({status:500});});
      await page.routeWebSocket('**/ws',s=>{socket=s;s.onMessage(m=>messages.push(JSON.parse(String(m))));});
      await page.goto(server.resolvedUrls!.local[0]!);await expect(page.locator('#connection-label')).toHaveText('En vivo');
      if(await page.locator('#letter-dialog').isVisible())await page.getByRole('button',{name:'Entrar al mundo'}).click();
      await page.locator('#stats-toggle').click();const panel=page.locator('#stats-content'),summary=page.locator('[data-demographic-summary]');
      const card=(label:string)=>summary.locator('.stat-card').filter({has:page.locator('span',{hasText:new RegExp(`^${label}$`)})});
      await expect(card('Vecinos vivos').locator('strong')).toHaveText(extinct?'0':'14');
      await expect(card('S/I protegidos').locator('strong')).toHaveText('2');
      await expect(card('Muertes humanas').locator('strong')).toHaveText(extinct?'32':'0');
      await expect(card('Nacimientos').locator('strong')).toHaveText(extinct?'18':'0');
      if(extinct){await expect(summary).toContainText('Sin vecinos vivos');await expect(summary).toContainText('Su presencia no demuestra que los vecinos hayan sobrevivido');}
      else await expect(summary).not.toContainText('Sin vecinos vivos');
      const deathsBox=await card('Muertes humanas').boundingBox(),panelBox=await panel.boundingBox();
      const mortalityVisible=!!deathsBox&&!!panelBox&&deathsBox.y>=panelBox.y&&deathsBox.y+deathsBox.height<=panelBox.y+panelBox.height;
      assert.equal(mortalityVisible,true,'mortality is visible in the initial statistics viewport without scrolling');
      await page.screenshot({path:`artifacts/demography-${extinct?'loss':'fresh'}-${width}.png`});
      if(extinct){
        const window=page.locator('[data-population-window]');await expect(window).toContainText('54.240–59.940');await expect(window).toContainText('2,38 días');await expect(window).toContainText('96 muestras');await expect(window).toContainText('no es un registro completo');
        const graph=page.locator('.history-chart').filter({has:page.locator('figcaption',{hasText:'Población · ventana recibida'})});await expect(graph.locator('svg')).toHaveAttribute('aria-label',/Último valor 2 habitantes/);
        const details=page.locator('[data-detail="human-death-causes"]'),toggle=details.locator('summary');await toggle.click();await toggle.focus();await expect(details).toContainText('Falta prolongada de agua.');await expect(details).toContainText('25');await expect(details).toContainText('7');
        await panel.evaluate(e=>{e.scrollTop=160;});const scroll=await panel.evaluate(e=>e.scrollTop),camera=await page.locator('#camera-coordinates').textContent();
        current.sequence++;current.demography!.causes={starvation:0,dehydration:24,exposure:8,senescence:0};socket!.send(JSON.stringify({type:'state',world:current}));
        await expect(details).toContainText('24');await expect(toggle).toBeFocused();assert.equal(await panel.evaluate(e=>e.scrollTop),scroll);await expect(page.locator('#camera-coordinates')).toHaveText(camera!);
        await window.scrollIntoViewIfNeeded();await page.screenshot({path:`artifacts/demography-window-${width}.png`});
        // Missing lifetime data must not be replaced by the recent cache or by zero.
        current=structuredClone(current);current.sequence++;delete current.demography;for(const person of current.people)delete person.continuityProtected;
        current.stats!.history=[];socket!.send(JSON.stringify({type:'state',world:current}));
        await expect(card('Muertes humanas').locator('strong')).toHaveText('—');await expect(card('S/I protegidos').locator('strong')).toHaveText('—');await expect(summary).toContainText('Acumulado no recibido');await expect(window).toContainText('No se han recibido muestras');
      } else await expect(page.locator('[data-population-window]')).toContainText('No se han recibido muestras');
      assert.deepEqual(await page.locator('#landscape').boundingBox(),{x:0,y:0,width,height});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(messages.filter(m=>m.type==='gesture').length,0);assert.deepEqual(errors,[]);assert.equal(JSON.stringify(original),preserved);
      report.push({scenario:extinct?'two-protected-no-neighbors':'fresh-sixteen',viewport:[width!,height!],mortalityVisible,orders:0,worldUnchanged:true});await context.close();
    }
    writeFileSync('artifacts/demographic-scope-controls.json',JSON.stringify({scope:'Synthetic UI fixtures; no autonomous survival or runtime publication.',report},null,2)+'\n');
  }finally{await browser.close();await server.close();}
});
