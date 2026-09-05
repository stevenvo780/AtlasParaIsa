import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';

const password='synthetic-browser-test-only';
let app: ReturnType<typeof createApp>, store: Store, dir: string, origin: string;
test.beforeAll(async()=>{
  dir=mkdtempSync(join(tmpdir(),'carta-browser-'));store=new Store(join(dir,'world.sqlite'));
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=(probe.address() as {port:number}).port;
  await new Promise<void>(resolve=>probe.close(()=>resolve()));origin=`http://127.0.0.1:${port}`;
  app=createApp({store,password,origin,seed:51926});app.server.listen(port,'127.0.0.1');await once(app.server,'listening');
  mkdirSync('artifacts',{recursive:true});
});
test.afterAll(async()=>{await app?.close();store?.close();if(dir)rmSync(dir,{recursive:true,force:true});});
async function enter(page: Page) {
  await page.goto(origin);await page.getByLabel('Contraseña privada').fill(password);
  await page.getByRole('button',{name:'Entrar a la carta'}).click();
  await expect(page.getByRole('dialog',{name:'Para ti, Isa.'})).toBeVisible();
  await page.getByRole('button',{name:'Entrar al mundo'}).click();
  await expect(page.locator('#connection-label')).toHaveText('En vivo');
  await expect(page.locator('#map-loading')).toBeHidden();
}

test('desktop: private entry, letter, landscape, causal cards, gestures, chronicle, camera and logout',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1440,height:1100});await enter(page);
  await page.locator('#focus-s').click();await expect(page.locator('#inhabitant-card')).toContainText('S');
  await page.locator('#focus-i').click();await expect(page.locator('#inhabitant-card')).toContainText('I');
  await page.locator('#observation-layer').selectOption('moisture');await expect(page.locator('#layer-explanation')).toContainText('Humedad');
  await page.locator('#observation-layer').selectOption('none');
  await page.getByText('Explorar sin usar el mapa',{exact:true}).click();
  await page.locator('#tile-x').fill('20');await page.locator('#tile-y').fill('14');await page.getByRole('button',{name:'Ver casilla'}).click();
  await page.locator('#gesture-send').click();await expect(page.locator('#gesture-result')).toContainText('planta nueva');
  await page.locator('#chronicle-button').click();await expect(page.locator('#journal-events')).toContainText('planta nueva');
  await page.getByRole('button',{name:'Cerrar crónica'}).click();
  await page.locator('#landscape').focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('+');
  await page.locator('#map-reset').click();await page.locator('#focus-s').click();
  await page.getByText('Explorar sin usar el mapa',{exact:true}).click();
  await page.screenshot({path:'artifacts/desktop.png',fullPage:true});
  const storedTick=app.world.tick;await page.reload();
  await expect(page.locator('#landscape')).toBeVisible();expect(app.world.tick).toBeGreaterThanOrEqual(storedTick);
  if(await page.locator('#letter-dialog').isVisible())await page.getByRole('button',{name:'Entrar al mundo'}).click();
  await page.locator('#logout-button').click();await expect(page.getByLabel('Contraseña privada')).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile touch and reduced motion: no horizontal overflow, all three gestures and readable dialogs',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2,reducedMotion:'reduce'});
  const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    await enter(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.locator('#focus-i').tap();await page.getByText('Explorar sin usar el mapa',{exact:true}).tap();
    await page.locator('#place-select').selectOption('claro');
    await page.locator('[data-gesture="invite"]').tap();await expect(page.locator('#gesture-send')).toBeEnabled();
    await expect.poll(()=>app.world.tick-app.world.lastGestureTick).toBeGreaterThanOrEqual(30);
    await page.locator('#gesture-send').tap();await expect(page.locator('#gesture-result')).toContainText('invitación');
    await page.locator('[data-gesture="remember"]').tap();await expect(page.locator('#memory-preview')).toContainText('sintético');
    await expect.poll(()=>app.world.tick-app.world.lastGestureTick).toBeGreaterThanOrEqual(30);
    await page.locator('#gesture-send').tap();await expect(page.locator('#gesture-result')).toContainText('contexto');
    await page.getByText('Explorar sin usar el mapa',{exact:true}).tap();
    await page.locator('#focus-s').tap();await page.screenshot({path:'artifacts/mobile.png',fullPage:true});
    await page.locator('#letter-button').tap();await expect(page.locator('#letter-dialog')).toBeVisible();
    expect(await page.locator('#letter-dialog').evaluate(el=>el.getBoundingClientRect().width<=window.innerWidth)).toBe(true);
    await page.getByRole('button',{name:'Cerrar la carta'}).tap();expect(errors).toEqual([]);
  } finally {await context.close();}
});

test('offline/reconnect, tab absence and external session revocation remain truthful',async({page,context})=>{
  await enter(page);const tick=app.world.tick;await context.setOffline(true);
  await expect(page.locator('#connection-label')).not.toHaveText('En vivo');
  await expect(page.locator('#gesture-send')).toBeDisabled();
  await expect.poll(()=>app.world.tick).toBeGreaterThan(tick);
  await context.setOffline(false);await expect(page.locator('#connection-label')).toHaveText('En vivo',{timeout:15_000});
  expect(app.world.tick).toBeGreaterThan(tick);
  store.revoke();await expect(page.getByLabel('Contraseña privada')).toBeVisible();
  await expect(page.locator('#landscape')).toHaveCount(0);
});

test('server save error reaches browser even with unchanged world sequence',async({page})=>{
  await enter(page);const save=store.save.bind(store);
  store.save=()=>{throw new Error('synthetic browser disk error');};
  try {
    await expect(page.locator('#connection-notice')).toContainText('pausa');
    await expect(page.locator('#gesture-send')).toBeDisabled();
  } finally {store.save=save;}
});
