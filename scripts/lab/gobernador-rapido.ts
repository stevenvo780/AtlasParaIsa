/**
 * Réplica rápida CON gobernador (instrumento provisional de la noche del 2026-09-22; el
 * definitivo es `replica.ts --gobernador servidor`). Imita `stepOnce` de src/server/app.ts:
 * clon por paso (si motor.clonPorPaso), stepWorld, guardado por cadencia, p95 de 120 pasos y
 * la política de `gobernador.politica` sobre `world.reproductionEnabled`.
 * Uso: --seed N --dias D --params "..." --salida <dir>
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, stepWorld, cloneWorld, assertWorld, TICKS_PER_DAY, type World } from '../../src/world/index.js';
import { parseParams, paramsOf, type WorldParams } from '../../src/world/params.js';
import { Store } from '../../src/server/store.js';
import { Gobernador } from '../../src/server/governor.js';

function arg(flag: string): string | undefined { const i = process.argv.indexOf(flag); return i === -1 ? undefined : process.argv[i + 1]; }
const pct = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))]! : 0; };

async function main(): Promise<void> {
  const seed = Number(arg('--seed') ?? 51926), dias = Number(arg('--dias') ?? 1), salida = arg('--salida');
  if (!salida) throw new Error('falta --salida');
  const params: WorldParams = parseParams(arg('--params'));
  mkdirSync(salida, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-lab-gob-'));
  process.env.CARTA_DATA_DIR = dataDir;
  const store = new Store(join(dataDir, 'world.sqlite'));
  try {
    let world: World = createWorld(seed, params);
    store.save(world);
    const gob = new Gobernador(), context = store.context;
    const steps: number[] = [], clones: number[] = [], saves: number[] = [];
    let activos = 0, muertesPrev = 0, nacPrev = 0;
    const totalTicks = dias * TICKS_PER_DAY;
    for (let tick = 1; tick <= totalTicks; tick++) {
      const t0 = performance.now();
      const p = paramsOf(world);
      let draft = world;
      if (p.motor.clonPorPaso) { draft = cloneWorld(world, context); clones.push(performance.now() - t0); }
      stepWorld(draft, [], context);
      if (draft.tick % p.persistencia.cadaTicks === 0) { const s0 = performance.now(); store.save(draft); saves.push(performance.now() - s0); }
      world = draft;
      const stepMs = performance.now() - t0; steps.push(stepMs);
      gob.registrar(stepMs);
      world.reproductionEnabled = gob.decidir(p.gobernador, world.reproductionEnabled, world.people.length, world.tiles.length, world.tick);
      if (world.reproductionEnabled) activos++;
      if (tick % TICKS_PER_DAY === 0) {
        if (tick % p.persistencia.cadaTicks !== 0) store.save(world);
        assertWorld(world);
        const dia = tick / TICKS_PER_DAY, day = steps.slice(-TICKS_PER_DAY);
        const muertes = world.legacy.length + world.retiredLegacy.length, nac = world.birthCounter;
        const gens = new Set(world.people.map(q => q.genome.generation));
        const body = { tick, dia, poblacion: world.people.length, mortales: world.people.filter(q => q.role === 'neighbor').length,
          nacimientosDia: nac - nacPrev, muertesDia: muertes - muertesPrev, nacimientos: nac, muertes, generacionesVivas: gens.size,
          reproduccionActivaFraccion: activos / TICKS_PER_DAY, techo: gob.estado.techo, p95Gobernador: gob.p95StepMs,
          p50Ms: pct(day, 0.5), p95Ms: pct(day, 0.95), cloneP50: pct(clones.slice(-TICKS_PER_DAY), 0.5), saveP50: pct(saves.slice(-Math.ceil(TICKS_PER_DAY / p.persistencia.cadaTicks)), 0.5),
          comunidades: world.communities.length, totals: world.totals, rss: process.memoryUsage().rss };
        writeFileSync(join(salida, `dia-${String(dia).padStart(3, '0')}.json`), JSON.stringify(body, null, 2) + '\n');
        activos = 0; muertesPrev = muertes; nacPrev = nac;
        console.log(`dia ${dia}: pob ${body.poblacion} nac ${body.nacimientosDia} mue ${body.muertesDia} repro ${body.reproduccionActivaFraccion.toFixed(2)} techo ${body.techo} p95 ${body.p95Ms.toFixed(1)}`);
      }
    }
    store.save(world);
    writeFileSync(join(salida, 'replica.json'), JSON.stringify({ seed, dias, params, politica: params.gobernador.politica, techoObservado: gob.techoObservado,
      sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), poblacionFinal: world.people.length, nacimientos: world.birthCounter }, null, 2) + '\n');
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
}
main().catch(e => { console.error((e as Error).stack ?? String(e)); process.exitCode = 1; });
