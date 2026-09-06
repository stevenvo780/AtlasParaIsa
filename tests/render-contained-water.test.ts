import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium, expect, type WebSocketRoute } from '@playwright/test';
import { createServer } from 'vite';
import { carriedWaterCard } from '../src/client/technology-art.js';
import { inheritedAndLearned } from '../src/client/inspector-view.js';
import { createWorld, projectWorld } from '../src/world/index.js';
import type { TechnologyView } from '../src/shared/technology.js';

type Item = TechnologyView['items'][number];
const water = (quanta: number, capacityQuanta = 2000, leakageNumerator = 1000) => ({
  version: 1 as const, quanta, capacityQuanta, quantaPerUnit: 50000 as const,
  leakageNumerator, leakageDenominator: 1000000 as const,
});
const item = (contents?: unknown): Item => Object.assign({ id: 'fixture-vessel', ownerId: 's', x: 16, y: 12,
  recipeId: 'recipe-cold', mass: 1000, generation: 1,
  capacities: { cutting: 0, storage: .2, insulation: 0, cultivation: 0, binding: 0, abrasion: 0 },
}, contents === undefined ? {} : { water: contents });

// Projection fixtures exercise presentation only: they do not claim that a
// person filled these vessels, paid a process or lost water in a real world step.
function fixture() {
  const view = projectWorld(createWorld(51926));
  view.technology!.items = [item(water(0))];
  view.technology!.knowledge = [{ actorId: 's', recipeIds: [] }];
  view.technology!.recipes = [];
  return view;
}

test('a missing water projection remains unknown, even if an object has storage capacity or structural water', () => {
  const legacy = Object.assign(item(), { composition: { wood: 0, stone: 750, water: 250 } });
  const html = carriedWaterCard(legacy);
  assert.match(html, /Contenido de agua no recibido/);
  assert.match(html, /data-water-state="unavailable"/);
  assert.doesNotMatch(html, /Vacío|Lleno|<meter|0,005/);
});

test('authoritative zero, partial, full and incapable vessels are distinct without guessing from capability scores', () => {
  const empty = carriedWaterCard(item(water(0)));
  assert.match(empty, /data-water-state="empty"/); assert.match(empty, /Vacío/);
  assert.match(empty, /max="2000" value="0"/); assert.match(empty, /0,04 u\. de agua/);
  const partial = carriedWaterCard(item(water(750)));
  assert.match(partial, /data-water-state="partial"/); assert.match(partial, /0,015 u\. de agua/);
  assert.match(partial, /max="2000" value="750"/);
  const full = carriedWaterCard(item(water(2000)));
  assert.match(full, /data-water-state="full"/); assert.match(full, /Lleno/);
  const incapable = item(water(0, 0)); incapable.capacities.storage = 1;
  assert.match(carriedWaterCard(incapable), /no retiene agua transportada/);
  assert.doesNotMatch(carriedWaterCard(incapable), /<meter|Vacío|Lleno/);
});

test('the smallest water quantum stays visible and permeability is a coefficient rather than observed loss', () => {
  const html = carriedWaterCard(item(water(1, 2000, 1)));
  assert.match(html, /0,00002 u\. de agua/);
  assert.match(html, /Fuga: 0,0001% por paso/);
  assert.match(html, /no pérdida observada/);
  assert.doesNotMatch(html, /ha perdido|utilidad|hidratación|Llenar/);
  assert.match(carriedWaterCard(item(water(500, 2000, 0))), /Fuga: 0%/);
});

test('unsafe quantities or unsupported units produce an unavailable state instead of a plausible false gauge', () => {
  const invalid: unknown[] = [null, [], {}, { ...water(0), version: 2 }, { ...water(0), quantaPerUnit: 1000 },
    { ...water(0), leakageDenominator: 0 }, { ...water(0), leakageNumerator: -1 },
    { ...water(0), leakageNumerator: 1000001 }, water(-1), water(.5), water(NaN), water(Infinity),
    water(Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1), water(2, 1), water(0, -1)];
  for (const contents of invalid) {
    const html = carriedWaterCard(item(contents));
    assert.match(html, /data-water-state="unavailable"/);
    assert.doesNotMatch(html, /<meter|Vacío|Lleno|NaN|Infinity/);
  }
});

test('rendering keeps matter, drinkable payload and remembered instructions separate without mutating the projection', () => {
  const view = fixture(), before = structuredClone(view), person = view.people.find(person => person.id === 's')!;
  const html = inheritedAndLearned(person, view).kit;
  assert.match(html, /Material del objeto/); assert.match(html, /1 u\. de material/);
  assert.match(html, /agua de su composición es distinta del agua potable transportada/);
  assert.match(html, /No recuerda ningún procedimiento ahora/);
  assert.match(html, /Detalles fuera de esta vista/); assert.doesNotMatch(html, /data-order=|data-recipe=/);
  assert.deepEqual(view, before);
  const unsafe = item(water(0)); unsafe.id = '"><img src=x onerror="bad()">';
  const markup = carriedWaterCard(unsafe);
  assert.ok(!markup.includes('<img ') && markup.includes('&lt;img '));
});

test('content-only snapshots retain inspector focus, scroll and camera across empty, partial, full, leakage and legacy views', { timeout: 40_000 }, async t => {
  if (!existsSync(chromium.executablePath())) { t.skip('Chromium absent: water content refresh, focus, camera, screenshots and mobile layout were not exercised.'); return; }
  const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen(); const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, reducedMotion: 'reduce' });
    const received = fixture(), original = JSON.stringify(received), current = structuredClone(received);
    const messages: { type: string; viewport?: unknown }[] = [], errors: string[] = [];
    let socket: WebSocketRoute | undefined;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/session', route => route.fulfill({ json: { authenticated: true } }));
    await page.route('**/api/world**', route => route.fulfill({ json: received }));
    await page.route('**/api/gesture', route => { messages.push({ type: 'gesture' }); return route.fulfill({ status: 500 }); });
    await page.routeWebSocket('**/ws', ws => { socket = ws; ws.onMessage(message => messages.push(JSON.parse(String(message)))); });
    await page.goto(server.resolvedUrls!.local[0]!); await expect(page.locator('#connection-label')).toHaveText('En vivo');
    if (await page.locator('#letter-dialog').isVisible()) await page.getByRole('button', { name: 'Entrar al mundo' }).click();
    await page.locator('#inspector-tab-kit').click();
    const products = page.locator('[data-detail="products"]'), summary = products.locator('summary');
    await summary.click(); await expect(products).toContainText('Agua transportada · Vacío');
    await summary.focus();
    const camera = await page.locator('#camera-coordinates').textContent();
    const unchangedPeople = JSON.stringify(current.people);
    const card = page.locator('#inhabitant-card');
    await card.evaluate(element => { element.scrollTop = 45; });
    const scroll = await card.evaluate(element => element.scrollTop);
    mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/contained-water-empty.png' });
    const publish = (contents?: ReturnType<typeof water>) => {
      current.technology!.items = [item(contents)]; current.sequence++;
      socket!.send(JSON.stringify({ type: 'state', world: current }));
    };
    for (const [name, contents, expected] of [
      ['partial', water(750), '0,015 u. de agua'],
      ['full', water(2000), 'Agua transportada · Lleno'],
      ['leakage', water(500, 2000, 5000), 'Fuga: 0,5% por paso'],
      ['legacy', undefined, 'Contenido de agua no recibido en esta vista'],
    ] as const) {
      publish(contents); await expect(products).toContainText(expected);
      await expect(summary).toBeFocused(); await expect(products).toHaveAttribute('open', '');
      assert.equal(await card.evaluate(element => element.scrollTop), scroll);
      assert.equal(await page.locator('#camera-coordinates').textContent(), camera);
      assert.equal(JSON.stringify(current.people), unchangedPeople, 'only the item projection changed');
      await page.screenshot({ path: `artifacts/contained-water-${name}.png` });
    }
    await page.setViewportSize({ width: 320, height: 568 });
    publish(water(1)); await expect(products).toContainText('0,00002 u. de agua'); await expect(summary).toBeFocused();
    const vessel = page.locator('[data-water-item="fixture-vessel"]');
    await vessel.scrollIntoViewIfNeeded();
    await expect(vessel).toContainText('0,00002 u. de agua'); await expect(vessel).toContainText('0,04 u. de agua');
    const readable = await vessel.evaluate(element => {
      const card = document.getElementById('inhabitant-card')!, clip = card.getBoundingClientRect(), rect = element.getBoundingClientRect();
      return { fullyVisible: rect.top >= clip.top && rect.bottom <= clip.bottom,
        minimumTextSize: Math.min(...[element, ...element.querySelectorAll('p,strong,span')].map(node => Number.parseFloat(getComputedStyle(node).fontSize))) };
    });
    assert.equal(readable.fullyVisible, true); assert.ok(readable.minimumTextSize >= 11);
    assert.deepEqual(await page.locator('#landscape').boundingBox(), { x: 0, y: 0, width: 320, height: 568 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await card.evaluate(element => element.scrollWidth > element.clientWidth), false);
    await page.screenshot({ path: 'artifacts/contained-water-mobile.png' });
    assert.equal(messages.filter(message => message.type === 'gesture').length, 0);
    assert.equal(JSON.stringify(received), original); assert.deepEqual(errors, []);
    writeFileSync('artifacts/contained-water-ui-controls.json', `${JSON.stringify({ syntheticProjectionOnly: true,
      waterProjectionVersion: 1, protocolVersion: received.version, quantumPerWaterUnit: 50000,
      states: ['empty', 'partial', 'full', 'leakage-coefficient', 'legacy-unavailable'],
      unchangedPeople: true, contentOnlyRefresh: true, focusAndScrollPreserved: true, cameraPreserved: true,
      mobileWaterCardFullyVisible: readable.fullyVisible, minimumWaterTextPixels: readable.minimumTextSize,
      smallestQuantumVisible: true, localMemoryNotDerivedFromItems: true, commandsSent: 0, mobileViewport: [320, 568], errors }, null, 2)}\n`);
  } finally { await browser.close(); await server.close(); }
});
