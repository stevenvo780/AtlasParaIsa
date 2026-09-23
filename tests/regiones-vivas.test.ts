import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, projectWorld } from '../src/world/index.js';
import { CHUNK_SIZE } from '../src/world/terrain.js';
import { clavesVivasEn } from '../src/server/regiones-vivas.js';
import { LADO_REGION, claveRegion, enReposo } from '../src/client/regiones.js';
import { rotuloTerritorio, seccionTerritorio } from '../src/client/territorio-view.js';

test('M10: las regiones vivas de una ventana son exactas y acotadas', () => {
  assert.equal(LADO_REGION, CHUNK_SIZE, 'el cliente usa el mismo lado de región que el mundo');
  const world = createWorld(51926);
  for (let i = 0; i < 100; i++) stepWorld(world);
  const v = { x: 0, y: 0, width: 40, height: 28 };
  const vivas = clavesVivasEn(world, v);
  const view = projectWorld(world, v);
  for (const tile of view.tiles) {
    const viva = Object.prototype.hasOwnProperty.call(world.chunks, claveRegion(tile.x, tile.y));
    assert.equal(vivas.includes(claveRegion(tile.x, tile.y)), viva, `región de ${tile.x},${tile.y}`);
    assert.equal(enReposo({ regionesVivas: vivas }, tile.x, tile.y), !viva);
  }
  assert.deepEqual(clavesVivasEn(world, { x: 300, y: 300, width: 12, height: 8 }), [], 'lejos no hay regiones vivas');
  // Cota: la ventana máxima (96 × 64) toca como mucho 7 × 5 regiones, sin importar lo explorado.
  const todas = { ...world, chunks: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`${(i % 20) - 10},${Math.floor(i / 20) - 10}`, {}])) };
  const peor = clavesVivasEn(todas as unknown as typeof world, { x: -8, y: -8, width: 96, height: 64 });
  assert.ok(peor.length <= 35, `claves: ${peor.length}`);
  assert.ok(Buffer.byteLength(JSON.stringify(peor)) < 400, `bytes en el peor caso: ${Buffer.byteLength(JSON.stringify(peor))}`);
  assert.equal(enReposo({}, 0, 0), null, 'sin el dato no se vela ni se afirma reposo');
});

test('M10: el HUD y Paisaje explican el territorio con datos del estado', () => {
  const world = createWorld(51926);
  for (let i = 0; i < 300; i++) stepWorld(world);
  const view = projectWorld(world);
  const hud = rotuloTerritorio(view);
  assert.match(hud.texto, new RegExp(`^${view.activeChunks} regi(ón activa|ones activas) · ${view.discoveredChunks} descubiertas? · ${view.settlementCount} asentamientos?$`));
  assert.match(hud.ayuda, /16 × 16/);
  const html = seccionTerritorio(view);
  assert.match(html, /Regiones descubiertas/); assert.match(html, /Asentamientos/);
  assert.match(html, new RegExp(`medido en el paso ${view.stats!.statsTick!.toLocaleString('es-CO')}`));
  assert.match(html, /Reparto de comida \(Gini\)/);
  view.stats!.distanciaMediaAgua = -1;
  assert.match(seccionTerritorio(view), /sin agua potable/, 'el centinela −1 no se muestra como distancia');
});
