import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium, expect, type WebSocketRoute } from '@playwright/test';
import { createServer } from 'vite';
import { createWorld, projectWorld } from '../src/world/index.js';
import { destinationLink, inheritedAndLearned } from '../src/client/inspector-view.js';
import { technologyPane } from '../src/client/technology-art.js';
import type { PersonView } from '../src/shared/types.js';
import type { TechnologyRecipe } from '../src/shared/technology.js';

function catalogFixture() {
  const world = projectWorld(createWorld(51926)), technology = world.technology!;
  technology.dynamics.recipes = 400;
  Object.assign(technology.dynamics, { products: 1, importedMass: 1000, productMass: 1000, residueMass: 0, massError: 0 });
  technology.knowledge = [{ actorId: 's', recipeIds: ['recipe-cold'] }];
  technology.items = [{ id: 'held-product', ownerId: 's', x: 16, y: 12, recipeId: 'recipe-cold', mass: 1000, generation: 1,
    capacities: { cutting: 0, storage: .2, insulation: 0, cultivation: 0, binding: 0, abrasion: 0 } }];
  technology.recipes = [];
  return world;
}

test('catalogue counts discoveries globally while empty or bounded details remain explicitly local', () => {
  const world = catalogFixture(), technology = world.technology!;
  const absent = technologyPane(technology);
  assert.match(absent, /Descubiertos<\/span><strong>400<\/strong>/);
  assert.match(absent, /0 en esta vista/); assert.match(absent, /Hay procedimientos descubiertos/);
  assert.doesNotMatch(absent, /Todavía no hay una receta descubierta/);
  const empty = structuredClone(technology); empty.dynamics.recipes = 0;
  assert.match(technologyPane(empty), /Todavía no hay una receta descubierta/);
  const recipe = { id: 'recipe-visible', name: 'Procedimiento visible', generation: 2, program: { inputs: [], steps: [] }, capacities: {}, manufactured: 1, uses: 1, utility: .2, parents: [] } as unknown as TechnologyRecipe;
  technology.recipes = Array.from({ length: 25 }, (_, index) => ({ ...recipe, id: `recipe-${index}` }));
  const partial = technologyPane(technology);
  assert.match(partial, /25 en esta vista/); assert.match(partial, /Esta lista no muestra todo lo descubierto/);
  assert.equal((partial.match(/class="person-detail technology-recipe"/g) ?? []).length, 20);
  assert.ok(partial.includes('data-detail="recipe-recipe-24"') && !partial.includes('data-detail="recipe-recipe-4"'), 'keep the selection shared with linked-recipe navigation');
  assert.doesNotMatch(partial, /más recientes|25 registrados/);
});

test('remembered identity, received details and carried objects are distinct facts', () => {
  const world = catalogFixture(), person = world.people.find(person => person.id === 's')!;
  let kit = inheritedAndLearned(person, world).kit;
  assert.match(kit, /Procedimientos que recuerda/); assert.match(kit, /Procedimiento recipe-cold/);
  assert.match(kit, /Detalles fuera de esta vista/); assert.doesNotMatch(kit, /data-recipe=/);
  world.technology!.knowledge = [{ actorId: 's', recipeIds: [] }];
  kit = inheritedAndLearned(person, world).kit;
  assert.match(kit, /No recuerda ningún procedimiento ahora/); assert.match(kit, /Objetos que lleva/);
  assert.match(kit, /Llevar un objeto no implica recordar cómo se fabrica/);
  for (const knowledge of [undefined, [{ actorId: 'other', recipeIds: [] }]]) {
    world.technology!.knowledge = knowledge;
    kit = inheritedAndLearned(person, world).kit;
    assert.match(kit, /Su repertorio de procedimientos no aparece en esta vista/);
    assert.doesNotMatch(kit, /No recuerda ningún procedimiento ahora/);
  }
  world.technology!.knowledge = [{ actorId: 's', recipeIds: ['<img src=x onerror="bad()">'] }];
  kit = inheritedAndLearned(person, world).kit;
  assert.ok(!kit.includes('<img ') && kit.includes('&lt;img '));
});

test('catalogue metadata and personal learning refresh independently without commanding the world', { timeout: 30_000 }, async t => {
  if (!existsSync(chromium.executablePath())) { t.skip('Chromium absent: partial catalogue, remembered identities and independent snapshot refresh not run.'); return; }
  const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen(); const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 800 }, reducedMotion: 'reduce' });
    const received = catalogFixture(), preserved = JSON.stringify(received), messages: { type: string }[] = [], errors: string[] = [];
    let socket: WebSocketRoute | undefined, current = structuredClone(received);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/session', route => route.fulfill({ json: { authenticated: true } }));
    await page.route('**/api/world**', route => route.fulfill({ json: received }));
    await page.route('**/api/gesture', route => { messages.push({ type: 'gesture' }); return route.fulfill({ status: 500 }); });
    await page.routeWebSocket('**/ws', ws => { socket = ws; ws.onMessage(message => messages.push(JSON.parse(String(message)))); });
    await page.goto(server.resolvedUrls!.local[0]!); await expect(page.locator('#connection-label')).toHaveText('En vivo');
    if (await page.locator('#letter-dialog').isVisible()) await page.getByRole('button', { name: 'Entrar al mundo' }).click();
    await page.locator('#inspector-tab-kit').click();
    const procedures = page.locator('[data-detail="procedures"]'), summary = procedures.locator('summary');
    await summary.click(); await expect(procedures).toContainText('Procedimiento recipe-cold');
    await expect(procedures.locator('[data-recipe]')).toHaveCount(0);
    const publish = () => { current.sequence++; socket!.send(JSON.stringify({ type: 'state', world: current })); };
    current.technology!.knowledge = [{ actorId: 's', recipeIds: [] }]; publish();
    await expect(procedures).toContainText('No recuerda ningún procedimiento ahora');
    current.technology!.knowledge = [{ actorId: 's', recipeIds: ['recipe-cold'] }]; publish();
    await expect(procedures).toContainText('Procedimiento recipe-cold');
    await summary.focus();
    current.technology!.recipes = [{ id: 'recipe-cold', name: 'Lámina que aprendió', generation: 1,
      program: { inputs: [{ source: 'raw', material: 'wood', mass: 1000 }], steps: [{ op: 'form', intensity: 1 }] },
      capacities: { cutting: 0, storage: .2, insulation: 0, cultivation: 0, binding: 0, abrasion: 0 },
      manufactured: 1, uses: 0, utility: 0, parents: [] } as unknown as TechnologyRecipe]; publish();
    const recipeLink = procedures.locator('[data-recipe="recipe-cold"]');
    await expect(recipeLink).toHaveText('Lámina que aprendió'); await expect(summary).toBeFocused();
    await recipeLink.click(); await expect(page.locator('#stats-tab-technology')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#stats-content')).toContainText('1 en esta vista');
    await expect(page.locator('.technology-recipe')).toHaveCount(1);
    current.technology!.recipes = []; publish();
    await expect(page.locator('#stats-content')).toContainText('Hay procedimientos descubiertos');
    await expect(page.locator('#stats-content')).not.toContainText('Todavía no hay una receta descubierta');
    mkdirSync('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/catalog-ui-partial.png' });
    await page.locator('#focus-s').click(); await page.locator('#inspector-tab-kit').click();
    if (await procedures.getAttribute('open') === null) await summary.click();
    await expect(procedures).toContainText('Procedimiento recipe-cold'); await expect(recipeLink).toHaveCount(0);
    await expect(procedures).not.toContainText('No recuerda ningún procedimiento ahora');
    await procedures.scrollIntoViewIfNeeded(); await page.screenshot({ path: 'artifacts/catalog-ui-memory.png' });
    current.technology!.knowledge = undefined; publish();
    await expect(procedures).toContainText('Su repertorio de procedimientos no aparece en esta vista');
    await expect(procedures).not.toContainText('No recuerda ningún procedimiento ahora');
    await page.setViewportSize({ width: 320, height: 568 });
    await summary.focus(); await expect(summary).toBeFocused();
    assert.deepEqual(await page.locator('#landscape').boundingBox(), { x: 0, y: 0, width: 320, height: 568 });
    assert.equal(messages.filter(message => message.type === 'gesture').length, 0);
    assert.equal(JSON.stringify(received), preserved); assert.deepEqual(errors, []);
    writeFileSync('artifacts/catalog-ui-controls.json', JSON.stringify({ totalDiscovered: 400, receivedDetails: 0,
      coldRememberedIdentityRetained: true, forgettingUpdatesWithoutPersonChanges: true, metadataRefreshUpdatesWithoutItemChanges: true,
      missingKnowledgeIsNotEmptyKnowledge: true, heldObjectDoesNotConferKnowledge: true, navigationGestures: 0,
      protocolVersion: received.version, mobileViewport: [320,568], errors }, null, 2) + '\n');
  } finally { await browser.close(); await server.close(); }
});

test('destination wording follows authoritative control state and never invents an acknowledgement', () => {
  const person = { target: { x: -3, y: 8 }, controlMode: 'auto' } as PersonView;
  assert.match(destinationLink(person), /Destino actual: -3, 8/);
  assert.match(destinationLink({ ...person, controlMode: undefined }), /Destino actual:/);
  assert.match(destinationLink({ ...person, controlMode: 'directed' }), /Destino de la tarea:/);
  assert.equal(destinationLink({ ...person, target: undefined }), '');
  assert.doesNotMatch(destinationLink(person), /recibido|confirmado/i);
  const unsafe = { ...person, target: { x: '" onclick="bad()', y: 8 } } as unknown as PersonView;
  assert.ok(!destinationLink(unsafe).includes('" onclick="'));
});

test('inspector destination changes with received intent; viewing, focusing and mobile controls send no gestures', { timeout: 30_000 }, async t => {
  if (!existsSync(chromium.executablePath())) { t.skip('Chromium absent: inspector labels, camera navigation and no-gesture browser control not run.'); return; }
  const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen(); const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, reducedMotion: 'reduce' });
    const received = projectWorld(createWorld(51926));
    received.people.find(person => person.id === 's')!.target = { x: 25, y: 8 };
    const original = JSON.stringify(received), messages: { type: string }[] = [], errors: string[] = [];
    let socket: WebSocketRoute | undefined;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/session', route => route.fulfill({ json: { authenticated: true } }));
    await page.route('**/api/world**', route => route.fulfill({ json: received }));
    await page.route('**/api/gesture', route => { messages.push({ type: 'gesture' }); return route.fulfill({ status: 500 }); });
    await page.routeWebSocket('**/ws', ws => { socket = ws; ws.onMessage(message => messages.push(JSON.parse(String(message)))); });
    await page.goto(server.resolvedUrls!.local[0]!);
    await expect(page.locator('#connection-label')).toHaveText('En vivo');
    if (await page.locator('#letter-dialog').isVisible()) await page.getByRole('button', { name: 'Entrar al mundo' }).click();
    const auto = page.getByRole('button', { name: 'Destino actual: 25, 8' });
    await expect(auto).toBeVisible(); await expect(auto).toHaveAttribute('title', 'Centrar la cámara en este destino');
    mkdirSync('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/material-inspector-auto.png' });
    await auto.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('.tile-biome')).toContainText('25, 8');
    await expect(page.locator('#person-controls')).toBeHidden();
    await page.locator('#focus-s').click();
    const directed = structuredClone(received); directed.sequence++;
    directed.people.find(person => person.id === 's')!.controlMode = 'directed';
    socket!.send(JSON.stringify({ type: 'state', world: directed }));
    await expect(page.getByRole('button', { name: 'Destino de la tarea: 25, 8' })).toBeVisible();
    await page.screenshot({ path: 'artifacts/material-inspector-directed.png' });
    await page.locator('#direct-toggle').click();
    // UI steering mode is only a local preference; it cannot relabel an autonomous snapshot.
    const autonomous = structuredClone(received); autonomous.sequence += 2;
    socket!.send(JSON.stringify({ type: 'state', world: autonomous }));
    await expect(auto).toBeVisible(); await expect(page.locator('#mode-indicator')).toContainText('Dirigir');
    await page.setViewportSize({ width: 320, height: 568 });
    await page.locator('#task-toggle').click();
    await expect(page.getByRole('button', { name: 'Autonomía', exact: true })).toBeVisible();
    await page.locator('#task-toggle').click();
    await auto.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('.tile-biome')).toContainText('25, 8');
    await expect(page.locator('#person-controls')).toBeHidden();
    assert.equal(messages.filter(message => message.type === 'gesture').length, 0);
    assert.equal(JSON.stringify(received), original); assert.deepEqual(errors, []);
    assert.deepEqual(await page.locator('#landscape').boundingBox(), { x: 0, y: 0, width: 320, height: 568 });
    writeFileSync('artifacts/material-inspector-controls.json', JSON.stringify({ protocolVersion: received.version, authoritativeModes: ['auto','directed','auto'],
      localSteeringDoesNotChangeIntent: true, navigationGestures: messages.filter(message => message.type === 'gesture').length,
      originalProjectionUnchanged: true, mobileViewport: [320,568], errors }, null, 2) + '\n');
  } finally { await browser.close(); await server.close(); }
});
