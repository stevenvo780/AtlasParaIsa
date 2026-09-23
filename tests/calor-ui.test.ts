/**
 * T036(c) — cableado del mapa de calor en la escena.
 *
 * `Landscape.setCapaCalor(capa)` guarda la capa y la escena la pinta con
 * `pintarCalor` (misma proyección que el terreno: una tesela = ART px en el
 * lienzo de escena, ya trasladado al origen del mundo). Sin navegador: se ejerce
 * `pintarCalor` con el canvas falso del patrón de `tests/calor.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pintarCalor } from '../src/client/landscape.js';
import { colorCalor } from '../src/client/calor.js';
import type { Tile } from '../src/shared/types.js';

function tile(x: number, y: number, overrides: Partial<Tile> = {}): Tile {
  return { x, y, terrain: 'soil', moisture: 0.4, vegetation: 0.3, food: 0.2, ...overrides };
}

interface RegistroFillRect { x: number; y: number; w: number; h: number; color: string; }

function ctxFalso(): { ctx: CanvasRenderingContext2D; llamadas: RegistroFillRect[] } {
  const llamadas: RegistroFillRect[] = [];
  let fillStyle = '';
  const ctx = {
    get fillStyle() { return fillStyle; },
    set fillStyle(valor: string) { fillStyle = valor; },
    fillRect(x: number, y: number, w: number, h: number) { llamadas.push({ x, y, w, h, color: fillStyle }); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, llamadas };
}

/** `rgba(r,g,b,a)` que `dibujarCalor` deriva del hex de `colorCalor`. */
function rgbaDe(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const TESELAS = [tile(0, 0, { food: 0 }), tile(1, 0, { food: 0.5 }), tile(2, 1, { food: 1 })];

test('con capa «comida» la escena emite un fillRect por tesela visible con los colores de colorCalor', () => {
  const { ctx, llamadas } = ctxFalso();
  pintarCalor(ctx, TESELAS, 'comida');
  assert.equal(llamadas.length, TESELAS.length);
  assert.deepEqual(llamadas.map(l => l.color), TESELAS.map(t => rgbaDe(colorCalor('comida', t.food), 0.55)));
  // Proyección de la escena: tesela × ART (16 px), como el terreno.
  assert.deepEqual([llamadas[2]!.x, llamadas[2]!.y], [32, 16]);
});

test('apagar la capa (null) elimina todo el dibujado del mapa de calor', () => {
  const { ctx, llamadas } = ctxFalso();
  pintarCalor(ctx, TESELAS, null);
  assert.equal(llamadas.length, 0);
});

test('pintarCalor conserva el fillStyle previo de la escena', () => {
  const { ctx } = ctxFalso();
  ctx.fillStyle = '#123456';
  pintarCalor(ctx, TESELAS, 'agua');
  assert.equal(ctx.fillStyle, '#123456');
});

/** M10: la rampa se estira sobre el rango realmente recibido y la leyenda da valores reales. */
test('M10: con rango recibido la rampa va del mínimo al máximo de lo que se ve; sin rango, la cota de siempre', async () => {
  const { leyendaEnRango, rangoRecibido, posicionEnRampa } = await import('../src/client/calor.js');
  const teselas = [tile(0, 0, { food: 0.1 }), tile(1, 0, { food: 0.2 }), tile(2, 1, { food: 0.3 })];
  const rango = rangoRecibido(teselas, 'comida')!;
  assert.deepEqual(rango, { min: 0.1, max: 0.3 });
  const { ctx, llamadas } = ctxFalso();
  pintarCalor(ctx, teselas, 'comida', rango);
  assert.deepEqual(llamadas.map(l => l.color), [0, 0.5, 1].map(t => rgbaDe(colorCalor('comida', t), 0.55)), 'el mínimo recibido es el color más bajo y el máximo el más alto');
  assert.ok(Math.abs(posicionEnRampa(0.2, 'comida', rango) - 0.5) < 1e-9);
  assert.equal(posicionEnRampa(0.2, 'comida', null), 0.2, 'sin rango, la cota de siempre');
  assert.equal(posicionEnRampa(0.2, 'comida', { min: 0.2, max: 0.2 }), 0.2, 'un rango plano no divide por cero');
  const leyenda = leyendaEnRango('comida', rango);
  assert.deepEqual(leyenda.paradas.map(p => p.etiqueta), ['10 %', '15 %', '20 %', '25 %', '30 %']);
  assert.equal(leyendaEnRango('agua', { min: 0, max: 0.5 }).paradas.at(-1)!.etiqueta, '0,5 u.');
  assert.equal(leyendaEnRango('madera', null).paradas.length, 0);
  assert.equal(rangoRecibido([], 'comida'), null);
});

/** M10: la leyenda del mapa de calor se lee (la superficie clara del HUD ya no la pisa) y el selector es uno. */
test('M10: leyenda del calor con contraste legible y un solo selector de capas', { timeout: 90_000 }, async t => {
  const { existsSync } = await import('node:fs');
  const { chromium, expect } = await import('@playwright/test');
  if (!existsSync(chromium.executablePath())) { t.skip('Chromium absent: heat legend contrast not checked.'); return; }
  const { createBrowserTestServer } = await import('./lib/vite.js');
  const { createWorld, projectWorld } = await import('../src/world/index.js');
  const server = await createBrowserTestServer(); await server.listen(); const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const view = projectWorld(createWorld(51926));
    await page.route('**/api/session', r => r.fulfill({ json: { authenticated: true } })); await page.route('**/api/world**', r => r.fulfill({ json: view }));
    await page.routeWebSocket('**/ws', ws => { ws.onMessage(() => {}); });
    await page.goto(server.resolvedUrls!.local[0]!); await expect(page.locator('#connection-label')).toHaveText('En vivo');
    if (await page.locator('#letter-dialog').isVisible()) await page.getByRole('button', { name: 'Entrar al mundo' }).click();
    await page.locator('#heat-button').click();
    const legend = page.locator('#heat-legend');
    await expect(legend).toBeVisible(); await expect(legend).toContainText('Comida'); await expect(legend).toContainText('%');
    const colores = await legend.evaluate(el => [getComputedStyle(el).backgroundColor, getComputedStyle(el.querySelector('.heat-stops span')!).color]);
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const canal = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const lum = ([r, g, b]: number[]) => 0.2126 * canal(r!) + 0.7152 * canal(g!) + 0.0722 * canal(b!);
    const fondo = lum(rgb(colores[0]!)), texto = lum(rgb(colores[1]!));
    const contraste = (Math.max(fondo, texto) + 0.05) / (Math.min(fondo, texto) + 0.05);
    assert.ok(contraste >= 4.5, `contraste del texto de la leyenda: ${contraste.toFixed(2)}`);
    // El selector de Explorar sigue a la tecla y al botón: una sola capa a la vez.
    await page.locator('#layer-toggle').click();
    await expect(page.locator('#observation-layer')).toHaveValue('comida');
    await page.locator('#observation-layer').selectOption('humedad');
    await expect(legend).toContainText('Humedad');
    await expect(page.locator('#heat-button')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#observation-layer').selectOption('none');
    await expect(legend).toBeHidden(); await expect(page.locator('#heat-button')).toHaveAttribute('aria-pressed', 'false');
  } finally { await browser.close(); await server.close(); }
});
