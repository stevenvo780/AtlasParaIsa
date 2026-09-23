/** Coste de CPU de comprimir un `state` (deflate crudo, como permessage-deflate) por nivel,
 * sobre una COPIA del mundo del banco. Uso: CARTA_DATA_DIR=<copia> npx tsx scripts/ws-wan/coste-deflate.ts */
import { deflateRawSync, constants } from 'node:zlib';
import { resolve } from 'node:path';
import { Store } from '../../src/server/store.js';
import { projectWorld } from '../../src/world/index.js';

const store = new Store(resolve(process.env.CARTA_DATA_DIR!, 'world.sqlite'));
const world = store.load()!.world;
const s = world.people.find(p => p.role === 'S')!;
for (const [nombre, w, h] of [['movil', 23, 38], ['escritorio', 66, 37], ['maximo', 96, 64]] as const) {
  const text = JSON.stringify({ type: 'state', world: projectWorld(world, { x: Math.floor(s.x - w / 2), y: Math.floor(s.y - h / 2), width: w, height: h }, store.context) });
  const buf = Buffer.from(text);
  for (const level of [1, 3, constants.Z_DEFAULT_COMPRESSION]) {
    const cpu0 = process.cpuUsage(); const t0 = performance.now(); let z = 0;
    const N = 20;
    for (let i = 0; i < N; i++) z = deflateRawSync(buf, { level, memLevel: 8, windowBits: 15 }).length;
    const ms = (performance.now() - t0) / N; const cpu = process.cpuUsage(cpu0);
    console.log(`${nombre} ${(buf.length / 1024).toFixed(0)} KiB nivel ${level}: ${(z / 1024).toFixed(0)} KiB (${(buf.length / z).toFixed(1)}×) · ${ms.toFixed(1)} ms pared · ${((cpu.user + cpu.system) / 1000 / N).toFixed(1)} ms CPU`);
  }
}
store.close();
