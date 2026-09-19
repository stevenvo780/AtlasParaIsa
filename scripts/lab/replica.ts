/**
 * Laboratorio — una réplica determinista de N días.
 *
 * `--seed S --dias D [--params "a.b=1,c.d=2"] --salida <dir>`
 *
 * Corrige P3 (docs/REVISION-2026-09-19.md): las leyes de tecnología cambian según haya
 * o no un `Store` SQLite adjunto (con Store, `enableTechnologyCatalogue` fija
 * `memoryCapacity=32`; sin Store rige `budgets.maxRecipes=256` sin poda por LRU). Un
 * laboratorio sin Store mediría una física distinta a la de producción. Por eso esta
 * réplica SIEMPRE crea un `Store` temporal y lo guarda antes de simular un solo tick
 * (`store.save(world)` fija la catalogación y liga el `WorldContext`, ver
 * `src/server/store.ts:195` y `src/world/spatial.ts:18-22`), y vuelve a guardar cada
 * `persistencia.cadaTicks` ticks como haría el servidor.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { assertWorld, createWorld, projectWorld, stepWorld, TICKS_PER_DAY } from '../../src/world/index.js';
import { worldStatistics } from '../../src/world/statistics.js';
import { parseParams, type WorldParams } from '../../src/world/params.js';

const CAUSES = ['starvation', 'dehydration', 'exposure', 'senescence'] as const;
type Cause = typeof CAUSES[number];

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function distribution(samples: readonly number[]): { p50: number; p95: number } {
  if (!samples.length) return { p50: 0, p95: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50: sorted[Math.floor(sorted.length * 0.5)]!, p95: sorted[Math.floor(sorted.length * 0.95)]! };
}

/** Entropía de Shannon en bits de la distribución de `specialty()` entre los vivos. */
function specialtyEntropy(specialties: readonly string[]): number {
  if (!specialties.length) return 0;
  const counts = new Map<string, number>();
  for (const s of specialties) counts.set(s, (counts.get(s) ?? 0) + 1);
  const n = specialties.length;
  let entropy = 0;
  for (const count of counts.values()) { const p = count / n; entropy -= p * Math.log2(p); }
  return entropy;
}

/** sha256 de los ficheros `.ts` de `src/world`, ordenados por nombre (nombre + contenido). */
function worldSourceDigest(): string {
  const dir = 'src/world', hash = createHash('sha256');
  for (const name of readdirSync(dir).filter(f => f.endsWith('.ts')).sort()) hash.update(name).update('\0').update(readFileSync(join(dir, name)));
  return hash.digest('hex');
}

/** Métricas leídas del mundo vivo para el archivo `dia-NNN.json`; sin campos de tiempo real. */
function dailyMetrics(world: ReturnType<typeof createWorld>) {
  const stats = worldStatistics(world), loose = stats as unknown as Record<string, unknown>;
  const gini = typeof loose.giniRecursosPorRegion === 'number' ? loose.giniRecursosPorRegion : null;
  const fraccionComida = typeof loose.fraccionCeldasConComida === 'number' ? loose.fraccionCeldasConComida : null;
  const distanciaAgua = typeof loose.distanciaMediaAgua === 'number' ? loose.distanciaMediaAgua : null;
  const generaciones = stats.generations;
  const specialties = projectWorld(world).people.map(p => p.specialty ?? '');
  const muertesPorCausa = Object.fromEntries(CAUSES.map(cause => [cause, world.demographyDynamics.causes[cause]])) as Record<Cause, number>;
  return {
    poblacion: world.people.length, nacimientos: world.totals.births ?? 0, muertesPorCausa,
    fundadoresVivos: generaciones['0'] ?? 0, generacionesVivas: Object.keys(generaciones).length,
    diversidadOficios: specialtyEntropy(specialties), recetasDistintasEnUso: world.technology.recipes.filter(r => r.manufactured > 0).length,
    cooperaciones: world.totals.cooperation ?? 0, gini, fraccionComida, distanciaAgua,
  };
}

async function main(): Promise<void> {
  const seed = Number(arg('--seed') ?? 51926), dias = Number(arg('--dias') ?? 1), salida = arg('--salida');
  if (!Number.isInteger(seed) || seed < 0) throw new Error('Uso: --seed N --dias D [--params "a.b=1,c.d=2"] --salida <dir> (seed entero ≥ 0).');
  if (!Number.isInteger(dias) || dias < 1) throw new Error('Uso: --seed N --dias D [--params "a.b=1,c.d=2"] --salida <dir> (dias entero ≥ 1).');
  if (!salida) throw new Error('Uso: --seed N --dias D [--params "a.b=1,c.d=2"] --salida <dir> (falta --salida).');
  const params: WorldParams = parseParams(arg('--params'));
  mkdirSync(salida, { recursive: true });

  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-lab-'));
  process.env.CARTA_DATA_DIR = dataDir;
  const store = new Store(join(dataDir, 'world.sqlite'));
  try {
    const world = createWorld(seed, params);
    const poblacionInicial = world.people.length;
    // P3: adjuntar y guardar el Store ANTES de simular fija las leyes de tecnología de producción
    // (enableTechnologyCatalogue) y liga el WorldContext (loadChunk/catalogueReader) al mundo.
    store.save(world);

    const totalTicks = dias * TICKS_PER_DAY, stepTimes: number[] = [];
    let maxRss = process.memoryUsage().rss, ultimoDia: ReturnType<typeof dailyMetrics> | null = null;
    for (let tick = 1; tick <= totalTicks; tick++) {
      const started = performance.now();
      stepWorld(world);
      stepTimes.push(performance.now() - started);
      if (tick % params.persistencia.cadaTicks === 0) store.save(world);
      if (tick % TICKS_PER_DAY === 0) {
        assertWorld(world);
        const dia = tick / TICKS_PER_DAY, rss = process.memoryUsage().rss, { p50, p95 } = distribution(stepTimes.slice(-TICKS_PER_DAY));
        maxRss = Math.max(maxRss, rss);
        const metrics = dailyMetrics(world);
        ultimoDia = metrics;
        const body = { tick, ...metrics, p50Ms: Math.round(p50 * 100) / 100, p95Ms: Math.round(p95 * 100) / 100, rss };
        writeFileSync(join(salida, `dia-${String(dia).padStart(3, '0')}.json`), JSON.stringify(body, null, 2) + '\n');
      }
    }
    store.save(world);
    if (!ultimoDia) throw new Error('No se completó ningún día; --dias debe producir al menos un dia-NNN.json.');

    const { p50, p95 } = distribution(stepTimes);
    const resumen = {
      poblacionInicial, poblacionFinal: ultimoDia.poblacion, nacimientosTotal: ultimoDia.nacimientos,
      muertesPorCausaTotal: ultimoDia.muertesPorCausa, fundadoresVivosFinal: ultimoDia.fundadoresVivos,
      generacionesVivasFinal: ultimoDia.generacionesVivas, diversidadOficiosFinal: ultimoDia.diversidadOficios,
      recetasDistintasEnUsoFinal: ultimoDia.recetasDistintasEnUso, cooperacionesTotal: ultimoDia.cooperaciones,
      gini: ultimoDia.gini, fraccionComida: ultimoDia.fraccionComida, distanciaAgua: ultimoDia.distanciaAgua,
      p50Ms: Math.round(p50 * 100) / 100, p95Ms: Math.round(p95 * 100) / 100, rssMaximo: maxRss,
    };
    const replica = {
      seed, params, sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      digest: worldSourceDigest(), dias, resumen,
    };
    writeFileSync(join(salida, 'replica.json'), JSON.stringify(replica, null, 2) + '\n');
    console.log(`Réplica completa: ${dias} día(s), población final ${resumen.poblacionFinal}. Salida: ${salida}`);
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
}

main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
