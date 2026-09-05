import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium, expect, type WebSocketRoute } from '@playwright/test';
import { createServer } from 'vite';
import { createWorld, projectWorld } from '../src/world/index.js';
import { destinationLink } from '../src/client/inspector-view.js';
import type { PersonView } from '../src/shared/types.js';

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
