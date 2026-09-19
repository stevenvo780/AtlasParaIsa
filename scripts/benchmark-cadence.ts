/** T021 — p95 del paso del servidor (clon + simulación + persistencia) con 32
 * habitantes dispersos, el mismo reparto que usa scripts/benchmark-simulation.ts.
 * Reproduce `stepOnce` sin HTTP ni websockets: `benchmark-simulation.ts` mide las
 * piezas por separado (codecs, clones), este mide el paso entero bajo una política
 * de guardado concreta, que es lo que fija el p95 del servidor.
 *
 * Reproducción de las cifras del informe T021 (esta torre, 400 pasos medidos):
 *   antes:   git worktree add /tmp/base 1619c6b && cp scripts/benchmark-cadence.ts /tmp/base/scripts/
 *            (cd /tmp/base && STEPS=400 CADENCE=1 npx tsx scripts/benchmark-cadence.ts)
 *            — el `1619c6b` guarda cada tick con synchronous=FULL; CADENCE=1 respeta esa política.
 *   después: STEPS=400 CADENCE=20 npx tsx scripts/benchmark-cadence.ts
 *   coste de `assertWorld` antes de escribir: añade MEASURE_VALIDATION=1 (se descuenta del paso).
 *   poda: WINDOW=100 frente a WINDOW=0 compara filas y bytes de `events` al final.
 * Límite honesto: el reloj de pared no está aislado de otra carga del host, así que estas
 * cifras valen para comparar antes/después en la misma máquina, no como número absoluto. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { assertWorld, cloneWorld, createWorld, stepWorld, type World } from '../src/world/index.js';
import { generateTile } from '../src/world/terrain.js';
import { maintainRegions } from '../src/world/spatial.js';
import { parseParams, setParams } from '../src/world/params.js';

const seed = 51926, steps = Number(process.env.STEPS ?? 60), warmup = 4;
const cadence = Number(process.env.CADENCE ?? 1);

function fixture(population: number): World {
  const world = createWorld(seed);
  for (let index = 16; index < population; index++) {
    const inhabitant = structuredClone(world.people[2 + (index - 16) % 14]!);
    inhabitant.id = `cpu-benchmark-${index}`; inhabitant.name = `Sintético ${index}`; world.people.push(inhabitant);
  }
  const centers = 28;
  for (let index = 0; index < population; index++) {
    const person = world.people[index]!, center = index % centers;
    const x0 = (center % 8) * 64, y0 = Math.floor(center / 8) * 64;
    const positions = Array.from({ length: 256 }, (_, i) => ({ x: x0 + i % 16, y: y0 + Math.floor(i / 16) }))
      .sort((a, b) => Math.hypot(a.x - x0 - 8, a.y - y0 - 8) - Math.hypot(b.x - x0 - 8, b.y - y0 - 8));
    const position = positions.find(p => generateTile(seed, p.x, p.y).terrain !== 'water');
    assert.ok(position, 'fixture center must include traversable ground');
    Object.assign(person, position, { target: { ...position }, action: 'rest', decisionAt: 10000, hunger: .2, thirst: .2 });
  }
  maintainRegions(world);
  world.retiredChunks = [];
  assertWorld(world); return world;
}
const distribution = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: sorted[Math.floor(sorted.length * .5)]!, p95: sorted[Math.floor(sorted.length * .95)]!, max: sorted.at(-1)!,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length };
};
const show = (name: string, values: number[]) => {
  const d = distribution(values);
  console.log(`${name.padEnd(12)} p50 ${d.p50.toFixed(1).padStart(7)} ms  p95 ${d.p95.toFixed(1).padStart(7)} ms  max ${d.max.toFixed(1).padStart(7)} ms  n=${values.length}`);
};

const dir = mkdtempSync(join(tmpdir(), 't021-bench-'));
const store = new Store(join(dir, 'world.sqlite'));
let world = fixture(32);
if (Number(process.env.WINDOW ?? 0) > 0) setParams(world, parseParams(`persistencia.ventanaEventosTicks=${process.env.WINDOW}`));
console.log(`cadencia ${cadence}  tiles ${world.tiles.length}  personas ${world.people.length}  synchronous=${Object.values(store.db.prepare('PRAGMA synchronous').get()!)[0]}`);
store.save(world);
const step: number[] = [], clone: number[] = [], save: number[] = [], validate: number[] = [];
let saves = 0;
try {
  for (let iteration = -warmup; iteration < steps; iteration++) {
    const collect = iteration >= 0, started = performance.now();
    const cloneStarted = performance.now();
    const draft = cloneWorld(world, store.context);
    const cloneMs = performance.now() - cloneStarted;
    stepWorld(draft, [], store.context);
    let saveMs = 0, validateMs = 0;
    if (draft.tick % cadence === 0) {
      if (process.env.MEASURE_VALIDATION) {
        const validateStarted = performance.now();
        assertWorld(draft, draft.version, store.context);
        validateMs = performance.now() - validateStarted;
      }
      const saveStarted = performance.now();
      store.save(draft);
      saveMs = performance.now() - saveStarted; saves++;
    }
    world = draft;
    if (collect) { step.push(performance.now() - started - validateMs); clone.push(cloneMs); if (saveMs) { save.push(saveMs); if (validateMs) validate.push(validateMs); } }
  }
  show('paso', step); show('clon', clone); if (save.length) show('guardado', save); if (validate.length) show('assertWorld', validate);
  const bytes = (table: string) => Number((store.db.prepare(`SELECT COALESCE(SUM(LENGTH(body)),0) AS n FROM ${table}`).get() as { n: number }).n);
  const rows = (table: string) => Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  console.log(`guardados ${saves}/${steps + warmup} pasos · sqlite ${(statSync(store.path).size / 1048576).toFixed(2)} MiB · wal ${(statSync(`${store.path}-wal`).size / 1048576).toFixed(2)} MiB`);
  console.log(`events ${rows('events')} filas / ${(bytes('events') / 1024).toFixed(1)} KiB · chunks ${rows('chunks')} filas / ${(bytes('chunks') / 1024).toFixed(1)} KiB · tick ${world.tick}`);
} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
