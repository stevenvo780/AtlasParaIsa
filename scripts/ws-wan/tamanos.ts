/** Tamaño de un `state` por cámara (UTF-8 y comprimido con deflate como lo haría
 * permessage-deflate), sobre una COPIA del mundo del banco. Uso:
 *   CARTA_DATA_DIR=<copia> npx tsx scripts/ws-wan/tamanos.ts */
import { deflateRawSync } from 'node:zlib';
import { resolve } from 'node:path';
import { Store } from '../../src/server/store.js';
import { projectWorld } from '../../src/world/index.js';

const store = new Store(resolve(process.env.CARTA_DATA_DIR!, 'world.sqlite'));
const loaded = store.load();
if (!loaded) throw new Error('sin mundo');
const world = loaded.world;
const s = world.people.find(p => p.role === 'S')!;
const camaras: [string, number, number][] = [['sin-camara (40x28 en 0,0)', 0, 0], ['movil 23x38', 23, 38], ['portatil 49x27', 49, 27], ['escritorio 66x37', 66, 37], ['2K 86x51', 86, 51], ['maximo 96x64', 96, 64]];
console.log(`tick ${world.tick} · ${world.people.length} habitantes · ${world.tiles.length} teselas activas · S en (${s.x},${s.y})`);
console.log('| cámara | state KiB | deflate KiB | razón | tiles KiB | people KiB | people en cuadro | technology KiB | resto KiB |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const [nombre, w, h] of camaras) {
  const viewport = w ? { x: Math.floor(s.x + 0.5 - w / 2), y: Math.floor(s.y + 0.5 - h / 2), width: w, height: h } : undefined;
  const t0 = performance.now();
  const view = projectWorld(world, viewport, store.context);
  const text = JSON.stringify({ type: 'state', world: view });
  const ms = performance.now() - t0;
  const bytes = Buffer.byteLength(text), z = deflateRawSync(Buffer.from(text)).length;
  const part = (k: keyof typeof view) => Buffer.byteLength(JSON.stringify(view[k] ?? null));
  const resto = bytes - part('tiles') - part('people') - part('technology');
  console.log(`| ${nombre} | ${(bytes / 1024).toFixed(0)} | ${(z / 1024).toFixed(0)} | ${(bytes / z).toFixed(1)}× | ${(part('tiles') / 1024).toFixed(0)} | ${(part('people') / 1024).toFixed(0)} | ${view.people.length} | ${(part('technology') / 1024).toFixed(0)} | ${(resto / 1024).toFixed(0)} | (${ms.toFixed(0)} ms proyectar+serializar)`);
}
store.close();
