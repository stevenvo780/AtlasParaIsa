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
