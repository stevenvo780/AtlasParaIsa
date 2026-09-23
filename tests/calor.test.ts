import test from 'node:test';
import assert from 'node:assert/strict';
import { capasDeCalor, colorCalor, dibujarCalor, leyendaCalor, type VistaCalor } from '../src/client/calor.js';
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

const VISTA: VistaCalor = { x0: 0, y0: 0, tileSize: 16, scale: 1 };

test('capasDeCalor enumera exactamente las 5 capas del brief', () => {
  assert.deepEqual(capasDeCalor, ['comida', 'vegetacion', 'agua', 'fertilidad', 'madera']);
});

test('dibujarCalor pinta un rectángulo por cada tesela visible recibida', () => {
  const { ctx, llamadas } = ctxFalso();
  const tiles = [tile(0, 0), tile(1, 0), tile(0, 1), tile(3, 2, { food: 0.9 })];
  dibujarCalor(ctx, tiles, 'comida', VISTA);
  assert.equal(llamadas.length, tiles.length);
  // Posición en pixeles: (tile - origen) * tileSize * scale.
  assert.deepEqual([llamadas[3]!.x, llamadas[3]!.y], [48, 32]);
});

test('dibujarCalor no pinta nada con la lista vacía', () => {
  const { ctx, llamadas } = ctxFalso();
  dibujarCalor(ctx, [], 'agua', VISTA);
  assert.equal(llamadas.length, 0);
});

test('colorCalor: la luminancia crece monótonamente con el valor, en las 5 capas', () => {
  const luma = (colorHex: string): number => {
    const r = parseInt(colorHex.slice(1, 3), 16), g = parseInt(colorHex.slice(3, 5), 16), b = parseInt(colorHex.slice(5, 7), 16);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const muestras = [0, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 1];
  for (const capa of capasDeCalor) {
    const lumas = muestras.map(v => luma(colorCalor(capa, v)));
    for (let i = 1; i < lumas.length; i++) {
      assert.ok(lumas[i]! > lumas[i - 1]!, `capa ${capa}: luminancia no crece entre ${muestras[i - 1]} y ${muestras[i]}`);
    }
  }
});

test('colorCalor recorta valores fuera de 0..1', () => {
  assert.equal(colorCalor('comida', -1), colorCalor('comida', 0));
  assert.equal(colorCalor('comida', 5), colorCalor('comida', 1));
});

test('leyendaCalor devuelve 5 paradas crecientes de 0 a 1, con colores de colorCalor', () => {
  for (const capa of capasDeCalor) {
    const leyenda = leyendaCalor(capa);
    assert.equal(leyenda.paradas.length, 5);
    assert.equal(leyenda.paradas[0]!.valor, 0);
    assert.equal(leyenda.paradas[4]!.valor, 1);
    assert.equal(leyenda.paradas[2]!.color, colorCalor(capa, 0.5));
    for (let i = 1; i < leyenda.paradas.length; i++) assert.ok(leyenda.paradas[i]!.valor > leyenda.paradas[i - 1]!.valor);
  }
});
