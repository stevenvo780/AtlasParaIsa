import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {chromium, expect, type WebSocketRoute} from '@playwright/test';
import {createBrowserTestServer as createServer} from './lib/vite.js';
import {createWorld, projectWorld} from '../src/world/index.js';
import type {PersonView} from '../src/shared/types.js';
import {inheritedAndLearned} from '../src/client/inspector-view.js';

/** M1: el censo del servidor se calcula sobre TODA la población (statistics.ts); en estos fixtures la
 * vista contiene a toda la población, así que el censo se rehace con las mismas reglas a partir de ella. */
function syncCensus(view: ReturnType<typeof projectWorld>, people: PersonView[] = view.people) {
  const lifeStage = {juvenile: 0, adult: 0, senescent: 0, unknown: 0};
  const neighbors = people.filter(p => p.role === 'neighbor');
  for (const p of neighbors) lifeStage[p.lifeStage ?? 'unknown']++;
  view.stats!.census = {neighbors: neighbors.length, identities: people.length - neighbors.length, protectedCount: people.length - neighbors.length, lifeStage};
  return view;
}

/** Presentation fixture, not an autonomous survival experiment. No engine step is run. */
function populationFixture(extinct: boolean) {
  const view = projectWorld(createWorld(51926));
  if (!extinct) return view;
  view.people = view.people.filter(person => person.role !== 'neighbor'); syncCensus(view);
  view.tick = view.sequence = 60000; view.day = 26;
  view.stats!.population = 2; view.stats!.totals.births = 18;
  view.stats!.actions = {rest: 2}; view.stats!.generations = {'0': 2};
  view.demography = {deaths: 32, causes: {starvation: 0, dehydration: 25, exposure: 7, senescence: 0}, recent: []};
  view.stats!.history = Array.from({length:96},(_,i)=>({tick:54240+i*60,population:2,energy:.6,hunger:.3,fatigue:.2,thirst:.4,discoveries:1,settlements:1,cooperation:0,births:18}));
  return view;
}

test('global mortality remains visible beside protected identities and a short two-person history',{timeout:60_000},async t=>{
  if(!existsSync(chromium.executablePath())){t.skip('Chromium absent: global mortality visibility and demographic history checks not run.');return;}
  let server:Awaited<ReturnType<typeof createServer>>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  const report:{scenario:string;viewport:number[];mortalityVisible:boolean;orders:number;worldUnchanged:boolean}[]=[];
  try{
    server=await createServer();await server.listen();
    browser=await chromium.launch({headless:true});mkdirSync('artifacts',{recursive:true});
    for(const[width,height]of[[390,844],[1440,900]])for(const extinct of[true,false]){
      const context=await browser.newContext({viewport:{width:width!,height:height!},reducedMotion:'reduce'}),page=await context.newPage();
      const original=populationFixture(extinct),preserved=JSON.stringify(original);let current=structuredClone(original),socket:WebSocketRoute|undefined;
      const messages:{type:string}[]=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.name));
      await page.route('**/api/session',r=>r.fulfill({json:{authenticated:true}}));await page.route('**/api/world**',r=>r.fulfill({json:current}));
      await page.route('**/api/gesture',r=>{messages.push({type:'gesture'});return r.fulfill({status:500});});
      await page.routeWebSocket(/\/ws(\?.*)?$/,s=>{socket=s;s.onMessage(m=>messages.push(JSON.parse(String(m))));});
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
      const panelBox=await panel.boundingBox();
      let mortalityVisible=true;
      for(const label of ['Vecinos vivos','S/I protegidos','Muertes humanas','Nacimientos']) {
        const box=await card(label).boundingBox();
        mortalityVisible&&=!!box&&!!panelBox&&box.y>=panelBox.y&&box.y+box.height<=panelBox.y+panelBox.height;
      }
      assert.ok(mortalityVisible,'all four demographic metrics are visible initially without scrolling');
      await page.screenshot({path:`artifacts/demography-${extinct?'loss':'fresh'}-${width}.png`});
      if(extinct){
        const window=page.locator('[data-population-window]');await expect(window).toContainText('54.240–59.940');await expect(window).toContainText('2,38 días');await expect(window).toContainText('96 muestras');await expect(window).toContainText('no es un registro completo');
        const graph=page.locator('.history-chart').filter({has:page.locator('figcaption',{hasText:'Población · ventana recibida'})});await expect(graph.locator('svg')).toHaveAttribute('aria-label',/Último valor 2 habitantes/);
        const details=page.locator('[data-detail="human-death-causes"]'),toggle=details.locator('summary');await toggle.click();await toggle.focus();await expect(details).toContainText('Falta prolongada de agua.');await expect(details).toContainText('25');await expect(details).toContainText('7');
        await panel.evaluate(e=>{e.scrollTop=160;});const scroll=await panel.evaluate(e=>e.scrollTop),camera=await page.locator('#camera-coordinates').textContent();
        current.sequence++;current.demography!.causes={starvation:0,dehydration:24,exposure:8,senescence:0};socket!.send(JSON.stringify({type:'state',world:current}));
        await expect(details).toContainText('24');await expect(toggle).toBeFocused();assert.equal(await panel.evaluate(e=>e.scrollTop),scroll);await expect(page.locator('#camera-coordinates')).toHaveText(camera!);
        await window.scrollIntoViewIfNeeded();await page.screenshot({path:`artifacts/demography-window-${width}.png`});
        // Missing lifetime data must not be replaced by the recent cache or by zero; a missing census
        // must not be replaced by counting the camera's `people` either (M1).
        current=structuredClone(current);current.sequence++;delete current.demography;delete current.stats!.census;for(const person of current.people)delete person.continuityProtected;
        current.stats!.history=[];socket!.send(JSON.stringify({type:'state',world:current}));
        await expect(card('Muertes humanas').locator('strong')).toHaveText('—');await expect(card('S/I protegidos').locator('strong')).toHaveText('—');await expect(summary).toContainText('Acumulado no recibido');await expect(window).toContainText('No se han recibido muestras');
      } else await expect(page.locator('[data-population-window]')).toContainText('No se han recibido muestras');
      assert.deepEqual(await page.locator('#landscape').boundingBox(),{x:0,y:0,width,height});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(messages.filter(m=>m.type==='gesture').length,0);assert.deepEqual(errors,[]);assert.equal(JSON.stringify(original),preserved);
      report.push({scenario:extinct?'two-protected-no-neighbors':'fresh-sixteen',viewport:[width!,height!],mortalityVisible,orders:0,worldUnchanged:true});await context.close();
    }
    writeFileSync('artifacts/demographic-scope-controls.json',JSON.stringify({scope:'Synthetic UI fixtures; no autonomous survival or runtime publication.',report},null,2)+'\n');
  }finally{await browser?.close();await server?.close();}
});

type Stage = NonNullable<PersonView['lifeStage']>;
function stageFixture(stages: Stage[]) {
  const view = projectWorld(createWorld(51926));
  const identities = view.people.filter(p => p.role !== 'neighbor');
  identities[0]!.lifeStage = 'juvenile'; identities[1]!.lifeStage = 'adult';
  const neighbors = view.people.filter(p => p.role === 'neighbor').slice(0, stages.length);
  neighbors.forEach((p, i) => { p.lifeStage = stages[i]!; p.age = 999999; });
  // Deliberately identical age/generation with different server stages: the client must not infer thresholds.
  view.people = [...identities, ...neighbors]; view.stats!.population = view.people.length;
  view.demography!.deaths = 14 - neighbors.length; view.demography!.causes.senescence = 14 - neighbors.length;
  return syncCensus(view);
}

test('inspector labels server stages and missing data without guessing from age, generation or protection', () => {
  const view = stageFixture(['juvenile', 'adult', 'senescent']), before = structuredClone(view);
  for (const [i, label] of ['En crecimiento', 'Edad de crianza', 'Vejez'].entries()) {
    const p = view.people.filter(p => p.role === 'neighbor')[i]!;
    assert.match(inheritedAndLearned(p, view).now, new RegExp(`Etapa del modelo</span><strong>${label}`));
  }
  const unknown = structuredClone(view.people[2]!); delete unknown.lifeStage;
  const html = inheritedAndLearned(unknown, view).now;
  assert.match(html, /Etapa del modelo<\/span><strong>Sin dato/);
  assert.doesNotMatch(html, /<strong>Vejez|<strong>Edad de crianza/);
  const protectedHtml = inheritedAndLearned(view.people[1]!, view).now;
  assert.match(protectedHtml, /continuidad de esta identidad está protegida/);
  assert.doesNotMatch(protectedHtml, /La edad no garantiza una crianza/);
  assert.deepEqual(view, before);
});

test('global life-stage summary and inspector update without disturbing focus, scroll, camera or commands', {timeout:90_000}, async t => {
  if (!existsSync(chromium.executablePath())) { t.skip('Chromium absent: global life-stage summary and inspector update checks not run.'); return; }
  let server:Awaited<ReturnType<typeof createServer>>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  const controls:unknown[]=[];
  try {
    server=await createServer();await server.listen();
    browser=await chromium.launch({headless:true});mkdirSync('artifacts',{recursive:true});
    for(const [width,height] of [[390,844],[320,568],[1440,900]] as const) {
      const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce'}),page=await context.newPage();
      const original=stageFixture(['juvenile','adult','senescent']),preserved=JSON.stringify(original);
      let current=structuredClone(original),socket:WebSocketRoute|undefined;
      const messages:{type:string}[]=[],errors:string[]=[];
      page.on('pageerror',e=>errors.push(e.name));
      await page.route('**/api/session',r=>r.fulfill({json:{authenticated:true}}));
      await page.route('**/api/world**',r=>r.fulfill({json:current}));
      await page.route('**/api/gesture',r=>{messages.push({type:'gesture'});return r.fulfill({status:500});});
      await page.routeWebSocket(/\/ws(\?.*)?$/,s=>{socket=s;s.onMessage(m=>messages.push(JSON.parse(String(m))));});
      const publish=()=>{current.sequence++;socket!.send(JSON.stringify({type:'state',world:current}));};
      const setStages=(stages:(Stage|undefined)[])=>{current.people.filter(p=>p.role==='neighbor').forEach((p,i)=>{p.lifeStage=stages[i];});syncCensus(current);publish();};
      await page.goto(server.resolvedUrls!.local[0]!);await expect(page.locator('#connection-label')).toHaveText('En vivo');
      if(await page.locator('#letter-dialog').isVisible())await page.getByRole('button',{name:'Entrar al mundo'}).click();
      await page.locator('#stats-toggle').click();
      const panel=page.locator('#stats-content'),stages=page.locator('[data-neighbor-life-stages]'),status=page.locator('[data-replacement-status]');
      const stage=(name:string)=>stages.locator(`[data-life-stage="${name}"] strong`);
      for(const name of ['juvenile','adult','senescent'])await expect(stage(name)).toHaveText('1');
      await expect(stages).toContainText('3/3 con dato');
      await expect(status).toContainText('La edad no garantiza una crianza');
      const metrics=await page.locator('[data-demographic-summary] > .stats-grid .stat-card').evaluateAll(cards=>{
        const panel=document.getElementById('stats-content')!.getBoundingClientRect();
        return cards.map(card=>{const box=card.getBoundingClientRect();return {label:card.querySelector('span')!.textContent,top:box.top,bottom:box.bottom,panelTop:panel.top,panelBottom:panel.bottom,fullyVisible:box.top>=panel.top&&box.bottom<=panel.bottom};});
      });
      if(width!==320)assert.ok(metrics.length===4&&metrics.every(m=>m.fullyVisible),'four primary metrics remain visible without scrolling');
      await page.screenshot({path:`artifacts/life-stage-initial-${width}.png`});
      const details=page.locator('[data-detail="human-death-causes"]'),toggle=details.locator('summary');
      await toggle.click();await toggle.focus();await panel.evaluate(e=>{e.scrollTop=180;});
      const scroll=await panel.evaluate(e=>e.scrollTop),camera=await page.locator('#camera-coordinates').textContent();
      setStages(['senescent','senescent','senescent']);
      await expect(status).toHaveText('No hay recambio posible entre los vecinos actuales.');
      await expect(stage('senescent')).toHaveText('3');await expect(stage('juvenile')).toHaveText('0');
      await expect(toggle).toBeFocused();assert.equal(await panel.evaluate(e=>e.scrollTop),scroll);await expect(page.locator('#camera-coordinates')).toHaveText(camera!);
      await stages.scrollIntoViewIfNeeded();await page.screenshot({path:`artifacts/life-stage-no-replacement-${width}.png`});
      const rows=await stages.locator('.stats-facts > span').evaluateAll(nodes=>nodes.map(e=>({height:e.getBoundingClientRect().height,textPixels:parseFloat(getComputedStyle(e).fontSize)})));
      assert.ok(rows.every(r=>r.height<=42&&r.textPixels>=11),'age-stage rows remain compact and readable');
      setStages(['juvenile','senescent','senescent']);await expect(status).toHaveText('No hay recambio posible entre los vecinos actuales.');
      setStages(['juvenile','juvenile','senescent']);await expect(status).toContainText('La edad no garantiza una crianza');
      setStages([undefined,'senescent','senescent']);await expect(stage('unknown')).toHaveText('1');await expect(status).toContainText('no se puede evaluar el recambio por edad');
      setStages([undefined,undefined,undefined]);for(const name of ['juvenile','adult','senescent'])await expect(stage(name)).toHaveText('—');
      await expect(stage('unknown')).toHaveText('3');await expect(status).not.toContainText('No hay recambio posible');
      await stages.scrollIntoViewIfNeeded();await page.screenshot({path:`artifacts/life-stage-unknown-${width}.png`});

      setStages(['juvenile','adult','senescent']);
      const neighborId=current.people.find(p=>p.role==='neighbor')!.id;
      await page.locator('#population-toggle').click();await page.locator(`[data-person="${neighborId}"]`).click();
      await page.locator('#inspector-tab-now').click();
      const body=page.locator('[data-detail="vitality"]'),bodyToggle=body.locator('summary'),label=body.locator('[data-person-life-stage] strong'),card=page.locator('#inhabitant-card');
      await bodyToggle.click();await expect(label).toHaveText('En crecimiento');await bodyToggle.focus();
      await card.evaluate(e=>{e.scrollTop=Math.min(120,e.scrollHeight-e.clientHeight);});
      const cardScroll=await card.evaluate(e=>e.scrollTop),inspectorCamera=await page.locator('#camera-coordinates').textContent();
      const demographicAge=current.people.find(p=>p.id===neighborId)!.age;
      for (const [nextStage, text] of [['adult','Edad de crianza'],['senescent','Vejez']] as const) {
        setStages([nextStage,'adult','senescent']);
        await expect(label).toHaveText(text);await expect(bodyToggle).toBeFocused();await expect(body).toHaveAttribute('open','');
        assert.equal(await card.evaluate(e=>e.scrollTop),cardScroll);await expect(page.locator('#camera-coordinates')).toHaveText(inspectorCamera!);
      }
      assert.equal(current.people.find(p=>p.id===neighborId)!.age,demographicAge,'stage-only update did not supply a different numeric age');
      await body.scrollIntoViewIfNeeded();await page.screenshot({path:`artifacts/life-stage-inspector-${width}.png`});
      setStages([undefined,'adult','senescent']);await expect(label).toHaveText('Sin dato');
      assert.deepEqual(await page.locator('#landscape').boundingBox(),{x:0,y:0,width,height});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.equal(await card.evaluate(e=>e.scrollWidth>e.clientWidth),false);
      assert.equal(messages.filter(m=>m.type==='gesture').length,0);assert.deepEqual(errors,[]);assert.equal(JSON.stringify(original),preserved);
      controls.push({viewport:[width,height],primaryMetrics:metrics,stageRows:rows,protectedExcluded:true,unknownIsNotInfertile:true,immaturePotentialIncluded:true,
        summaryFocusScrollCameraPreserved:true,inspectorFocusScrollCameraPreserved:true,stageOnlyUpdate:true,commands:0,errors});
      await context.close();
    }
    writeFileSync('artifacts/life-stage-controls.json',JSON.stringify({scope:'Synthetic presentation fixtures. No engine steps, paid births or autonomous sustainability claimed.',controls},null,2)+'\n');
  } finally {await browser?.close();await server?.close();}
});

/** M1: con la cámara recortando `people`, la pantalla cuenta el mundo con `stats.census` y dice qué
 * es «en esta vista»; la ficha de alguien fuera de cuadro no se confunde con una muerte. */
test('una vista recortada dice 23 vidas en el mundo y no 0, y quien sale de cuadro sigue vivo', {timeout:90_000}, async t => {
  if (!existsSync(chromium.executablePath())) { t.skip('Chromium absent: census scope checks not run.'); return; }
  let server:Awaited<ReturnType<typeof createServer>>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try {
    server=await createServer();await server.listen();browser=await chromium.launch({headless:true});
    for (const [width,height] of [[390,844],[1440,900]] as const) {
      const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce'}),page=await context.newPage();
      const full=projectWorld(createWorld(51926));
      // Presentación: 13 en cuadro de un mundo de 23 (21 vecinos + S/I), como en la auditoría móvil.
      const view=structuredClone(full);view.people=full.people.filter(p=>p.role!=='S').slice(0,13);
      view.stats!.census={neighbors:21,identities:2,protectedCount:2,lifeStage:{juvenile:5,adult:14,senescent:2,unknown:0}};
      let current=structuredClone(view),socket:WebSocketRoute|undefined;const errors:string[]=[],asked:string[]=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/api/session',r=>r.fulfill({json:{authenticated:true}}));await page.route('**/api/world**',r=>r.fulfill({json:current}));
      await page.routeWebSocket(/\/ws(\?.*)?$/,ws=>{socket=ws;ws.onMessage(m=>{const message=JSON.parse(String(m));if(message.type==='persona'){asked.push(message.id);ws.send(JSON.stringify({type:'persona',id:message.id,persona:{id:message.id,experiences:[],trust:[],recipeIds:[]}}));}});});
      await page.goto(server.resolvedUrls!.local[0]!);await expect(page.locator('#connection-label')).toHaveText('En vivo');
      if(await page.locator('#letter-dialog').isVisible())await page.getByRole('button',{name:'Entrar al mundo'}).click();
      await page.locator('#stats-toggle').click();
      const summary=page.locator('[data-demographic-summary]');
      await expect(summary).toContainText('23 vidas en el mundo · 13 en esta vista');
      await expect(summary.locator('.stat-card').filter({hasText:'Vecinos vivos'}).locator('strong')).toHaveText('21');
      await expect(summary).not.toContainText('Sin vecinos vivos');
      // Cámara lejos de todos: el censo no cambia, la vista sí.
      current=structuredClone(current);current.sequence++;current.people=[];socket!.send(JSON.stringify({type:'state',world:current}));
      await expect(summary).toContainText('23 vidas en el mundo · 0 en esta vista');
      await expect(summary.locator('.stat-card').filter({hasText:'S/I protegidos'}).locator('strong')).toHaveText('2');
      await page.locator('#population-toggle').click();
      await expect(page.locator('#population-count')).toHaveText('0 en esta vista · 23 en el mundo');
      // S no está en cuadro: su ficha pregunta al servidor y dice que vive fuera de la vista.
      await page.locator('#inspector-toggle').click();
      await expect(page.locator('#inhabitant-card')).toContainText('Vive fuera de esta vista');
      await expect(page.locator('#inhabitant-card')).not.toContainText('ya no aparece');
      assert.ok(asked.length>0,'la ficha de un ausente se pide al servidor');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      assert.deepEqual(errors,[]);await context.close();
    }
  } finally {await browser?.close();await server?.close();}
});
