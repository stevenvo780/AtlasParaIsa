/**
 * V23 · V1 — extremo a extremo en Chromium, a tamaño de escritorio (1440×900) y de móvil (390×844), con el cliente
 * de verdad servido por Vite y el servidor sustituido por respuestas con la forma de los contratos: `/api/motor`
 * con `TelemetriaMotor`, `/health`, el directorio y la ficha a demanda por el socket. Una prueba por elemento:
 * indicador de salud, panel «Motor», barra de escucha y red de comunidades (grafo en Mundo y aristas en el mapa).
 * Con `V23_CAPTURAS=<directorio>` guarda una captura de cada elemento en cada tamaño.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { createBrowserTestServer as createServer } from './lib/vite.js';
import { createWorld, projectWorld } from '../src/world/index.js';
import type { CommunityView, PersonDetail, WorldView } from '../src/shared/types.js';
import type { WorldDirectoryResponse } from '../src/shared/worldmap.js';
import type { TelemetriaRecibida } from '../src/client/panel-motor.js';
import type { SaludVisible } from '../src/client/salud-view.js';

const CAPTURAS = process.env.V23_CAPTURAS;
const TAMANOS = [['escritorio', 1440, 900], ['movil', 390, 844]] as const;
const cultura = { sharing: .6, stewardship: .5, openness: .4 };

/** El mundo inicial de la semilla 51926 con dos comunidades, escucha heredada, una cría de S e I y un día de muestras. */
function escena(): { view: WorldView; directorio: WorldDirectoryResponse; fichas: Record<string, PersonDetail> } {
  const view = projectWorld(createWorld(51926));
  const rio = ['s', 'i', 'neighbor-1', 'neighbor-2', 'neighbor-3', 'neighbor-4'], colina = ['neighbor-5', 'neighbor-6', 'neighbor-7', 'neighbor-8', 'neighbor-9', 'neighbor-10'];
  view.people.forEach((p, k) => {
    p.communityId = rio.includes(p.id) ? 'c-rio' : colina.includes(p.id) ? 'c-colina' : null;
    (p.traits as Record<string, number>).escucha = [.82, .44, .3, .55, .61, .7, .25, .9, .5, .35, .66, .4, .2, .58, .47, .73][k]!;
    if (p.id === 'neighbor-3') p.genome = { ...p.genome!, generation: 1, parents: ['s', 'i'] };
    if (p.id === 'neighbor-4') p.genome = { ...p.genome!, generation: 1, parents: ['neighbor-1', 'fallecida-7'] };
  });
  const comunidad = (id: string, name: string, color: string, members: string[], x: number, y: number): CommunityView =>
    ({ id, name, color, members, memberCount: members.length + 40, x, y, culture: cultura, formedAt: 1200, cooperation: 31, disputes: 4 });
  view.communities = [comunidad('c-rio', 'Gente del río', '#5f8fa3', rio, 17, 12), comunidad('c-colina', 'Los de la colina', '#b07a3c', colina, 25, 7)];
  const muestras = Array.from({ length: 24 }, (_, i) => ({ tick: 2400 + i * 200, population: 380 + i * 1.4, energy: .7, hunger: .3, fatigue: .2, thirst: .2, discoveries: 0, settlements: 0, cooperation: 0, births: 0 }));
  view.stats = { ...view.stats!, population: 412, history: muestras };
  view.tick = muestras.at(-1)!.tick;
  view.performance = { stepMs: 2.1, p95StepMs: 3.4, saveMs: 1, projectionMs: 2, snapshotBytes: 4096, activeTiles: 1200, processRssMiB: 300, tickHz: 290, tickHzObjetivo: 300,
    fases: { maintainRegions: .1, ecologia: .6, kernel: .1, fauna: .4, personas: .9, encuentros: .1, demografia: .05, comunidades: .1, reproduccion: .02, checkpoint: 0, muestreo: .01, save: 0, broadcast: .2 }, fraccionSerial: .2 };

  // Directorio de todo el mundo: las 16 vidas de la vista y 396 más en 12 comunidades repartidas por el territorio.
  const azar = (n: number) => { let x = Math.imul(n ^ 0x9e3779b9, 2654435761) >>> 0; x ^= x >>> 15; return (Math.imul(x, 2246822519) >>> 0) / 4294967296; };
  const centros = Array.from({ length: 12 }, (_, c) => ({ id: `c-${c}`, x: 40 + azar(c) * 300, y: 20 + azar(c + 50) * 180, color: ['#6f5f8f', '#4f7f6a', '#a5584a', '#8c8a4a', '#3f6f8a', '#9a6b7c', '#6c7d45', '#c29a4b', '#7c6a58', '#8a5a3c', '#5a7d9a', '#7d5a8a'][c]! }));
  const personas = view.people.map(p => ({ id: p.id, name: p.name, role: p.role, x: p.x, y: p.y, action: p.action, age: 0, generation: p.genome?.generation ?? 0, communityId: p.communityId ?? null, hunger: p.hunger, energy: p.energy }));
  for (let k = 0; k < 396; k++) {
    const c = centros[Math.floor(azar(k + 900) ** 1.6 * 12)]!, suelto = azar(k + 3000) < .12;
    personas.push({ id: `p-${k}`, name: `Habitante ${k}`, role: 'neighbor', x: Math.round(c.x + (azar(k + 7000) - .5) * 30), y: Math.round(c.y + (azar(k + 8000) - .5) * 22), action: 'rest', age: 0, generation: 2, communityId: suelto ? null : c.id, hunger: .3, energy: .7 });
  }
  const tamanos = new Map<string, number>(); for (const p of personas) if (p.communityId) tamanos.set(p.communityId, (tamanos.get(p.communityId) ?? 0) + 1);
  const directorio: WorldDirectoryResponse = { tick: view.tick, day: view.day, totalPeople: personas.length, totalAnimals: 0, totalTameAnimals: 0, totalStructures: 0, totalPolyominoes: 0, people: personas,
    communities: [...view.communities.map(c => ({ id: c.id, name: c.name, x: c.x, y: c.y, color: c.color, memberCount: tamanos.get(c.id) ?? 0, cooperation: c.cooperation, disputes: c.disputes })),
      ...centros.map((c, i) => ({ id: c.id, name: `Comunidad ${i + 1}`, x: Math.round(c.x), y: Math.round(c.y), color: c.color, memberCount: tamanos.get(c.id) ?? 0, cooperation: 3, disputes: 1 }))],
    structures: [], herds: [] };

  const ficha = (id: string, trust: PersonDetail['trust']): PersonDetail => ({ id, experiences: [], trust, recipeIds: [] });
  const fichas: Record<string, PersonDetail> = {
    'neighbor-3': ficha('neighbor-3', [{ id: 's', value: .82 }, { id: 'i', value: .74 }, { id: 'neighbor-1', value: .45 }, { id: 'neighbor-5', value: .22 }, { id: 'neighbor-12', value: .3 }, { id: 'p-40', value: .6 }]),
    s: ficha('s', [{ id: 'neighbor-3', value: .7 }, { id: 'i', value: .95 }, { id: 'neighbor-2', value: .5 }]),
  };
  return { view, directorio, fichas };
}

const telemetria = (hz: number, saltados: number): TelemetriaRecibida => ({
  tick: 7000, hz, diasPorMinuto: hz * 60 / 2400, hilos: 32, desequilibrio: .18, esperaBarreraMs: .42,
  faseMs: { F0: .21, eco: .64, percibir: 1.1, actuar: .83, aplicar: .3 },
  ocupacion: Array.from({ length: 32 }, (_, i) => i === 0 ? .97 : .45 + ((i * 37) % 50) / 100),
  gpuMs: [.9, 0], gpuBytes: [1.8 * 1048576, 0], gpuEstado: ['ok', 'cpu'],
  intentos: 18240, rechazados: 312, migraciones: 41, fotogramasSaltados: saltados,
});

interface Mundo { page: Page; salud: SaludVisible; motor: TelemetriaRecibida | 'sin-ruta'; errores: string[] }
async function abrir(browser: Browser, url: string, ancho: number, alto: number, inicial: Partial<Pick<Mundo, 'motor'>> = {}): Promise<Mundo> {
  const page = await (await browser.newContext({ viewport: { width: ancho, height: alto }, reducedMotion: 'reduce' })).newPage();
  const { view, directorio, fichas } = escena();
  const m: Mundo = { page, errores: [], salud: { estado: 'ok', tick: 7000, ticksPorSegundo: 290, gpu: [{ dispositivo: 0, estado: 'ok' }, { dispositivo: 1, estado: 'cpu' }], recargas: 1 }, motor: inicial.motor ?? telemetria(290, 3) };
  page.on('pageerror', e => m.errores.push(e.message));
  await page.route('**/api/session', r => r.fulfill({ json: { authenticated: true } }));
  await page.route('**/api/world**', r => r.fulfill({ json: view }));
  await page.route('**/api/directory', r => r.fulfill({ json: directorio }));
  await page.route('**/api/motor', r => m.motor === 'sin-ruta' ? r.fulfill({ status: 404, body: 'no' }) : r.fulfill({ json: m.motor }));
  await page.route('**/health', r => r.fulfill({ status: m.salud.estado === 'parado' ? 503 : 200, json: m.salud }));
  await page.routeWebSocket(/\/ws(\?.*)?$/, ws => ws.onMessage(raw => {
    const pedido = JSON.parse(String(raw)) as { type: string; id?: string };
    if (pedido.type === 'persona' && pedido.id) ws.send(JSON.stringify({ type: 'persona', id: pedido.id, persona: fichas[pedido.id] ?? { id: pedido.id, experiences: [], trust: [], recipeIds: [] } }));
  }));
  await page.goto(url); await expect(page.locator('#connection-label')).toHaveText('En vivo');
  if (await page.locator('#letter-dialog').isVisible()) await page.getByRole('button', { name: 'Entrar al mundo' }).click();
  return m;
}
async function capturar(page: Page, nombre: string, recorte?: string): Promise<void> {
  if (!CAPTURAS) return;
  mkdirSync(CAPTURAS, { recursive: true });
  await page.waitForTimeout(250);
  if (recorte) await page.locator(recorte).screenshot({ path: join(CAPTURAS, `${nombre}.png`) });
  else await page.screenshot({ path: join(CAPTURAS, `${nombre}.png`) });
}
/** Lleva el elemento al borde superior del contenido desplazable de Mundo (para que la captura empiece en él). */
async function alInicio(page: Page, selector: string): Promise<void> {
  await page.evaluate(sel => { const c = document.getElementById('stats-content')!, e = document.querySelector(sel)!; c.scrollTop += e.getBoundingClientRect().top - c.getBoundingClientRect().top; }, selector);
}
async function abrirMundo(page: Page, pestana: 'life' | 'communities' | 'performance'): Promise<void> {
  if (await page.locator('#stats-drawer').isHidden()) await page.locator('#stats-toggle').click();
  await page.locator(`#stats-tab-${pestana}`).click();
  await expect(page.locator(`#stats-tab-${pestana}`)).toHaveAttribute('aria-selected', 'true');
}

let server: Awaited<ReturnType<typeof createServer>> | undefined, browser: Browser | undefined, url = '';
test.before(async () => {
  if (!existsSync(chromium.executablePath())) return;
  server = await createServer(); await server.listen(); url = server.resolvedUrls!.local[0]!;
  browser = await chromium.launch({ headless: true });
});
test.after(async () => { await browser?.close(); await server?.close(); });

test('indicador de salud: luces del mundo y del motor siempre a la vista, que cambian con lo medido y abren su panel', { timeout: 180_000 }, async t => {
  if (!browser) { t.skip('Chromium ausente'); return; }
  for (const [nombre, ancho, alto] of TAMANOS) {
    const m = await abrir(browser, url, ancho, alto), { page } = m;
    const mundo = page.locator('#salud-mundo'), motor = page.locator('#salud-motor');
    await expect(mundo).toBeVisible(); await expect(motor).toBeVisible(); await expect(page.locator('#salud-chip')).toHaveText('Servidor · en marcha');
    await expect(mundo).toHaveAttribute('data-estado', 'sano'); await expect(mundo.locator('[data-luz-valor]')).toHaveText('412 ↑');
    // Una tarjeta en CPU pide atención aunque el ritmo sea bueno; el motivo está en la ayuda.
    await expect(motor).toHaveAttribute('data-estado', 'atencion'); await expect(motor.locator('[data-luz-valor]')).toHaveText('290 Hz');
    assert.match(await motor.getAttribute('title') ?? '', /1 tarjeta cayó a CPU/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${nombre}: sin desborde horizontal`);
    if (ancho < 761) for (const id of ['#salud-mundo', '#salud-motor', '#salud-chip']) { const caja = (await page.locator(id).boundingBox())!; assert.ok(caja.height >= 44 && caja.x >= 0 && caja.x + caja.width <= ancho, `${id} tocable y dentro: ${JSON.stringify(caja)}`); }
    await capturar(page, `indicador-${nombre}`);
    // El servidor se para: la luz del motor pasa a grave sin esperar a un paso nuevo del mundo.
    m.salud = { ...m.salud, estado: 'parado', ticksPorSegundo: 0 };
    await expect(motor).toHaveAttribute('data-estado', 'grave', { timeout: 8000 });
    await expect(page.locator('#salud-chip')).toHaveText('Servidor · parado');
    await capturar(page, `indicador-grave-${nombre}`, '.game-clock');
    await motor.click();
    await expect(page.locator('#stats-tab-performance')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-panel-motor]')).toBeVisible();
    if (ancho < 761) await page.locator('[data-close="stats"]').click(); // en móvil la hoja del cuaderno tapa la barra
    await mundo.click();
    await expect(page.locator('#stats-tab-life')).toHaveAttribute('aria-selected', 'true');
    assert.deepEqual(m.errores, []); await page.context().close();
  }
});

test('panel «Motor»: hilos, tarjetas, ritmo, coste por fase, colas y fallos recuperados; sin la ruta, dice lo que falta', { timeout: 180_000 }, async t => {
  if (!browser) { t.skip('Chromium ausente'); return; }
  for (const [nombre, ancho, alto] of TAMANOS) {
    const m = await abrir(browser, url, ancho, alto), { page } = m;
    await abrirMundo(page, 'performance');
    const panel = page.locator('[data-panel-motor]');
    await expect(panel).toHaveAttribute('data-fuente', 'motor');
    await expect(panel.locator('.motor-hilo')).toHaveCount(32);
    await expect(panel.locator('[data-motor-hz] strong')).toHaveText('290');
    await expect(panel.locator('[data-motor-dias] strong')).toHaveText('7,25');
    await expect(panel.locator('[data-fase]')).toHaveCount(5);
    await expect(panel.locator('[data-fase="percibir"]')).toContainText('1,1 ms');
    await expect(panel.locator('.motor-tarjeta[data-estado="cpu"]')).toContainText('GPU 1');
    await expect(panel.locator('[data-motor-colas]')).toContainText('sin dato');
    await expect(panel.locator('[data-motor-recargas] strong')).toHaveText('1');
    await expect(panel.locator('[data-motor-saltados] strong')).toHaveText('3');
    const alto0 = await panel.locator('.motor-hilo').first().evaluate(e => getComputedStyle(e, '::after').height);
    assert.equal(alto0, '32px', 'el hilo al 97 % llena sus 8 escalones');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await alInicio(page, '[data-panel-motor]');
    await capturar(page, `motor-${nombre}`, ancho < 761 ? undefined : '#stats-drawer');
    await panel.locator('[data-motor-trafico]').scrollIntoViewIfNeeded();
    await capturar(page, `motor-fallos-${nombre}`, ancho < 761 ? undefined : '#stats-drawer');
    // Lecturas nuevas a 1 Hz con el panel abierto: los saltos nuevos se ven en el panel y en la luz.
    m.motor = telemetria(291, 9);
    await expect(panel.locator('[data-motor-saltados] strong')).toHaveText('9', { timeout: 6000 });
    assert.match(await page.locator('#salud-motor').getAttribute('title') ?? '', /saltó 6 fotogramas/);
    await page.context().close();
  }
  // Un servidor sin la ruta del motor: el panel se arma con el paso y /health, y dice qué falta.
  const m = await abrir(browser, url, 1440, 900, { motor: 'sin-ruta' }), { page } = m;
  await abrirMundo(page, 'performance');
  const panel = page.locator('[data-panel-motor]');
  await expect(panel).toHaveAttribute('data-fuente', 'paso');
  await expect(panel.locator('[data-motor-hilos="media"]')).toContainText('sin dato');
  await expect(panel.locator('[data-fase]')).toHaveCount(13); // las 13 fases medidas del paso, también la que costó 0
  await expect(panel.locator('.motor-tarjeta')).toHaveCount(2);
  await capturar(page, 'motor-sin-ruta-escritorio', '#stats-drawer');
  assert.deepEqual(m.errores, []); await page.context().close();
});

test('escucha: barra de la persona junto a la de sus progenitores, con lo que la ley le da ahora', { timeout: 180_000 }, async t => {
  if (!browser) { t.skip('Chromium ausente'); return; }
  for (const [nombre, ancho, alto] of TAMANOS) {
    const m = await abrir(browser, url, ancho, alto), { page } = m;
    await page.locator('#population-toggle').click();
    await page.locator('#population-search').fill(escena().view.people.find(p => p.id === 'neighbor-3')!.name);
    await page.locator('[data-directory-id="neighbor-3"]').first().click();
    const ficha = page.locator('#inspector-drawer .escucha-ficha');
    await expect(ficha).toBeVisible();
    await expect(ficha).toHaveAttribute('data-escucha', '0.61');
    await expect(ficha.locator('.escucha-fila')).toHaveCount(3);
    await expect(ficha.locator('.escucha-padre strong').first()).toHaveText('0,82');
    await expect(ficha.locator('[data-escucha-ahora]')).toContainText('escucha² · calma');
    await expect(ficha.locator('[data-escucha-generacion]')).toContainText('G1');
    await ficha.scrollIntoViewIfNeeded();
    await capturar(page, `escucha-${nombre}`, ancho < 761 ? undefined : '#inspector-drawer');
    assert.deepEqual(m.errores, []); await page.context().close();
  }
});

test('red de comunidades: grafo de todo el mundo con los vínculos conocidos, histograma, clic a la ficha y aristas en el mapa', { timeout: 180_000 }, async t => {
  if (!browser) { t.skip('Chromium ausente'); return; }
  for (const [nombre, ancho, alto] of TAMANOS) {
    const m = await abrir(browser, url, ancho, alto), { page } = m;
    // Abrir la ficha de neighbor-3 trae sus vínculos: se dibujan en el mapa con el color de la comunidad de cada otro.
    await page.locator('#population-toggle').click();
    await page.locator('#population-search').fill(escena().view.people.find(p => p.id === 'neighbor-3')!.name);
    await page.locator('[data-directory-id="neighbor-3"]').first().click();
    await expect(page.locator('#inspector-drawer .trust-list')).toBeAttached();
    if (ancho < 761) await page.locator('[data-close="inspector"]').click();
    await page.waitForTimeout(400);
    await capturar(page, `vinculos-mapa-${nombre}`);
    await abrirMundo(page, 'communities');
    const grafo = page.locator('[data-grafo]');
    await expect(grafo).toHaveAttribute('data-nodos', '412');
    await expect(grafo).toHaveAttribute('data-aristas', '6');
    // Los elementos del SVG dependen de las comunidades y de los grupos de aristas, no de las 412 personas.
    const elementos = await grafo.locator('svg *').count();
    assert.ok(elementos < 60, `elementos del grafo: ${elementos}`);
    await expect(page.locator('[data-histograma] li')).not.toHaveCount(0);
    await alInicio(page, '[data-red-comunidades]');
    await capturar(page, `red-comunidades-${nombre}`, ancho < 761 ? undefined : '#stats-drawer');
    await page.locator('[data-histograma]').scrollIntoViewIfNeeded();
    await capturar(page, `histograma-${nombre}`, ancho < 761 ? undefined : '#stats-drawer');
    // Pasar por un extremo de una de sus aristas nombra a esa persona; tocarla abre su ficha.
    await alInicio(page, '[data-grafo]');
    const caja = (await grafo.locator('svg').boundingBox())!;
    const punto = await page.evaluate(() => {
      const svg = document.querySelector('[data-grafo] svg') as SVGSVGElement, arista = svg.querySelector('.grafo-arista.es-propia')!;
      const [x, y] = arista.getAttribute('d')!.split('L')[1]!.split(/[ M]/).map(Number) as [number, number];
      const p = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM()!); return { x: p.x, y: p.y };
    });
    assert.ok(punto.x >= caja.x && punto.x <= caja.x + caja.width && punto.y >= caja.y && punto.y <= caja.y + caja.height);
    const pista = grafo.locator('[data-grafo-pista]');
    await page.mouse.move(punto.x, punto.y);
    await expect(pista).toContainText('toca para abrir su ficha');
    const nombreNodo = (await pista.textContent())!.split(' · ')[0]!;
    await page.mouse.click(punto.x, punto.y);
    await expect(page.locator('#inspector-title')).toHaveText(nombreNodo);
    assert.deepEqual(m.errores, []); await page.context().close();
  }
});
