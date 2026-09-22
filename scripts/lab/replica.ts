/**
 * Laboratorio — una réplica determinista de N días.
 *
 * `--seed S --dias D [--params "a.b=1,c.d=2"] --salida <dir>`
 *
 * Corrige P3 (docs/REVISION-2026-09-19.md): las leyes de tecnología cambian según haya
 * o no un `Store` SQLite adjunto. `budgets.maxRecipes` (256 por defecto) acota
 * `world.technology.recipes` (la ventana residente) EN AMBOS regímenes — eso NO es lo
 * que diverge (revisión 2026-09-19 de T016; `memoryCapacity` no acota esa ventana, acota
 * `person.technology.knownRecipes`/`learnedFrom`, la memoria POR PERSONA, ver
 * `src/world/technology.ts:52,407,472,597`). Lo que sí diverge: sin Store, una vez la
 * ventana llega a `maxRecipes` no se puede registrar ninguna receta más
 * (`registerTechnologyRecipe` falla con «standalone catalogue capacity»,
 * `src/world/technology-catalogue.ts:131`) y `technologyMemoryCapacity` devuelve
 * `budgets.maxRecipes` sin acotar (memoria por persona ilimitada hasta ese tope); con
 * Store, `enableTechnologyCatalogue` activa un catálogo respaldado por SQLite
 * (`technology_definitions`/`technology_stats`, recuperable vía `catalogueReader`) cuyos
 * totales (`technologyCatalogueTotals`) NO se podan al evictar la ventana residente, y
 * `memoryCapacity=min(32,maxRecipes)` sí acota la memoria por persona. Un laboratorio sin
 * Store mediría una física distinta a la de producción. Por eso esta réplica SIEMPRE crea
 * un `Store` temporal y lo guarda antes de simular un solo tick (`store.save(world)` fija
 * la catalogación y liga el `WorldContext`, ver `src/server/store.ts:195` y
 * `src/world/spatial.ts:18-22`), y vuelve a guardar cada `persistencia.cadaTicks` ticks
 * como haría el servidor.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { assertWorld, createWorld, projectWorld, stepWorld, TICKS_PER_DAY } from '../../src/world/index.js';
import { catalogueEnabled, technologyCatalogueTotals } from '../../src/world/technology-catalogue.js';
import { worldStatistics } from '../../src/world/statistics.js';
import { parseParams, type WorldParams } from '../../src/world/params.js';
import { durableActivityMetrics } from './metrics.js';

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
function dailyMetrics(world: ReturnType<typeof createWorld>, store: Store) {
  const stats = worldStatistics(world), loose = stats as unknown as Record<string, unknown>;
  const gini = typeof loose.giniRecursosPorRegion === 'number' ? loose.giniRecursosPorRegion : null;
  const fraccionComida = typeof loose.fraccionCeldasConComida === 'number' ? loose.fraccionCeldasConComida : null;
  const distanciaAgua = typeof loose.distanciaMediaAgua === 'number' ? loose.distanciaMediaAgua : null;
  // R1 (SC-004 parte 2): regionesSinAgua no viajaba a ningún consumidor del laboratorio.
  const regionesSinAgua = typeof loose.regionesSinAgua === 'number' ? loose.regionesSinAgua : null;
  const generaciones = stats.generations;
  const specialties = projectWorld(world).people.map(p => p.specialty ?? '');
  const muertesPorCausa = Object.fromEntries(CAUSES.map(cause => [cause, world.demographyDynamics.causes[cause]])) as Record<Cause, number>;
  // P3 (revisión 2026-09-19 de T016): `world.technology.recipes` es la ventana LRU
  // residente, acotada por `budgets.maxRecipes` (256 por defecto) EN AMBOS regímenes —
  // contar sobre ella satura a partir de ese tope y deja de distinguir con/sin Store.
  // `technologyCatalogueTotals(world)` no se poda al evictar la ventana: con Store (el
  // único régimen que corre esta réplica, ver cabecera del fichero) `.recipes` sigue a
  // `recipeCounter` sin límite y `.functionalDiversity` cuenta perfiles de capacidad
  // (`Capability`) realmente distintos jamás descubiertos, también sin ventana.
  const catalogo = technologyCatalogueTotals(world);
  return {
    poblacion: world.people.length, nacimientos: world.totals.births ?? 0, muertesPorCausa,
    fundadoresVivos: generaciones['0'] ?? 0, generacionesVivas: Object.keys(generaciones).length,
    diversidadOficios: specialtyEntropy(specialties), recetasCreadasAcumuladas: catalogo.recipes,
    diversidadConducta: stats.diversidad?.total ?? null,
    diversidadFuncional: catalogo.functionalDiversity,
    // Instrumento directo: true ⇔ el mundo tiene el catálogo de producción activo
    // (`enableTechnologyCatalogue`, ver Store.save). Esta réplica SIEMPRE lo deja en
    // true; si alguien quita el Store este campo lo delata (y el test de abajo lo afirma).
    catalogoActivo: catalogueEnabled(world.technology),
    cooperaciones: world.totals.cooperation ?? 0, gini, fraccionComida, distanciaAgua, regionesSinAgua,
    ...durableActivityMetrics(world, store.db, world.tick - TICKS_PER_DAY),
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
    const vecinosMortalesIniciales = world.people.filter(person => person.role === 'neighbor').length;
    const fundadoresMortalesIniciales = world.people.filter(person => person.role === 'neighbor' && person.genome.generation === 0).length;
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
        if (tick % params.persistencia.cadaTicks !== 0) store.save(world);
        assertWorld(world);
        const dia = tick / TICKS_PER_DAY, rss = process.memoryUsage().rss, { p50, p95 } = distribution(stepTimes.slice(-TICKS_PER_DAY));
        maxRss = Math.max(maxRss, rss);
        const metrics = dailyMetrics(world, store);
        ultimoDia = metrics;
        const body = { tick, ...metrics, p50Ms: Math.round(p50 * 100) / 100, p95Ms: Math.round(p95 * 100) / 100, rss };
        writeFileSync(join(salida, `dia-${String(dia).padStart(3, '0')}.json`), JSON.stringify(body, null, 2) + '\n');
      }
    }
    store.save(world);
    if (!ultimoDia) throw new Error('No se completó ningún día; --dias debe producir al menos un dia-NNN.json.');

    const { p50, p95 } = distribution(stepTimes);
    const resumen = {
      vecinosMortalesIniciales, fundadoresMortalesIniciales,
      poblacionInicial, poblacionFinal: ultimoDia.poblacion, nacimientosTotal: ultimoDia.nacimientos,
      muertesPorCausaTotal: ultimoDia.muertesPorCausa, fundadoresVivosFinal: ultimoDia.fundadoresVivos,
      generacionesVivasFinal: ultimoDia.generacionesVivas, diversidadOficiosFinal: ultimoDia.diversidadOficios,
      recetasDistintasEnUsoFinal: ultimoDia.recetasDistintasEnUso, cooperacionesTotal: ultimoDia.cooperaciones,
      gini: ultimoDia.gini, fraccionComida: ultimoDia.fraccionComida, distanciaAgua: ultimoDia.distanciaAgua,
      regionesSinAgua: ultimoDia.regionesSinAgua,
      p50Ms: Math.round(p50 * 100) / 100, p95Ms: Math.round(p95 * 100) / 100, rssMaximo: maxRss,
    };
    const replica = {
      metricasVersion: 2, gobernador: 'no-ejecutado; replica de leyes, no del servidor',
      seed, params, sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      digest: worldSourceDigest(), dias, resumen,
    };
    writeFileSync(join(salida, 'replica.json'), JSON.stringify(replica, null, 2) + '\n');
    console.log(`Réplica completa: ${dias} día(s), población final ${resumen.poblacionFinal}. Salida: ${salida}`);
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
}

main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
