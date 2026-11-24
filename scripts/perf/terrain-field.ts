// Compara el horneado de 2000 celdas sintéticas de 16 × 16 en los dos caminos.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { classifyTerrainPixel, materialNoise, newFieldPixel, prepareTerrainStencil, rnd } from '../../src/client/terrain-field.js';

const stencils = Array.from({ length: 2000 }, (_, i) => Array.from({ length: 9 }, (_, j) =>
  ({ biome: (i + j) % 3 ? 'grassland' : 'forest', water: false,
    cover: ((i * 13 + j * 7) % 13) / 12, traffic: ((i * 5 + j * 3) % 13) / 12,
    soil: 70 + ((i + j * 3) % 30), leaf: 100 + ((i * 2 + j * 5) % 40) })));
const output = newFieldPixel();
let sink = 0;
const legacy = () => {
  for (let n = 0; n < 2000; n++) {
    const s = stencils[n]!;
    for (let by = 0; by < 16; by++) for (let bx = 0; bx < 16; bx++) {
      const wx = n * 16 + bx, wy = by;
      const u0 = ((bx + .5) / 16 + .5) % 1, v0 = ((by + .5) / 16 + .5) % 1;
      const u = u0 * u0 * (3 - 2 * u0), v = v0 * v0 * (3 - 2 * v0);
      const j = (by < 8 ? 0 : 3) + (bx < 8 ? 0 : 1);
      const wa = (1 - u) * (1 - v), wb = u * (1 - v), wc = (1 - u) * v, wd = u * v;
      const a = s[j]!, b = s[j + 1]!, c = s[j + 3]!, d = s[j + 4]!;
      const cover = Math.min(s[4]!.cover * 1.5, a.cover * wa + b.cover * wb + c.cover * wc + d.cover * wd);
      const broad = materialNoise(wx, wy, 29, 348), fine = materialNoise(wx, wy, 7, 351);
      const patch = broad * .68 + fine * .32;
      const t = Math.max(0, Math.min(1, (cover - patch * .55 + .02) / .52));
      const rooted = s[4]!.cover ? t * t * (3 - 2 * t) : 0;
      const traffic = s[4]!.traffic ? a.traffic * wa + b.traffic * wb + c.traffic * wc + d.traffic * wd : 0;
      const q = Math.max(0, Math.min(1, (traffic - patch * .16) / .85));
      const wear = q * q * (3 - 2 * q);
      const grain = rnd(wx, wy, 358), dither = Number(grain < wear);
      const soil = a.soil * wa + b.soil * wb + c.soil * wc + d.soil * wd;
      const leaf = a.leaf * wa + b.leaf * wb + c.leaf * wc + d.leaf * wd;
      sink += soil + (leaf - soil) * rooted * (1 - dither * .65) + (grain - .5) * (1 - wear) * 4;
    }
  }
};
const field = () => {
  for (let n = 0; n < 2000; n++) {
    const s = prepareTerrainStencil(stencils[n]!);
    for (let by = 0; by < 16; by++) for (let bx = 0; bx < 16; bx++) {
      const p = classifyTerrainPixel(n * 16 + bx, by, n, 0, s, output);
      const raw = stencils[n]!;
      let soil = 0, leaf = 0, total = 0;
      for (let j = 0; j < 4; j++) {
        const sample = raw[p.corners[j]!]!;
        if (sample.biome !== p.biome) continue;
        const weight = p.weights[j]!;
        soil += sample.soil * weight; leaf += sample.leaf * weight; total += weight;
      }
      if (total) { soil /= total; leaf /= total; }
      sink += soil + (leaf - soil) * Number(p.grass) * (p.wear ? .35 : 1) + (rnd(n * 16 + bx, by, 358) - .5) * (p.wear ? 1 : 4);
    }
  }
};
// Calienta ambos caminos antes de alternar el orden para reducir el ruido del planificador.
legacy(); field();
const oldTimes: number[] = [], newTimes: number[] = [];
const time = (fn: () => void) => { const start = performance.now(); fn(); return performance.now() - start; };
for (let i = 0; i < 9; i++) {
  if (i % 2 === 0) { oldTimes.push(time(legacy)); newTimes.push(time(field)); }
  else { newTimes.push(time(field)); oldTimes.push(time(legacy)); }
}
// La carga de la máquina solo SUMA tiempo: el mínimo de corridas alternas estima el coste propio de cada
// camino (la mediana de 5 superó 1,5× con la torre saturada del laboratorio, 1,21–1,32× sin ella).
const before = Math.min(...oldTimes), after = Math.min(...newTimes);
console.log(`terrain-field benchmark: legacy ${before.toFixed(1)} ms; field ${after.toFixed(1)} ms; ratio ${(after / before).toFixed(2)}x; ${sink | 0}`);
assert.ok(after / before <= 1.5, `baked pixel work grew ${(after / before).toFixed(2)}×`);
