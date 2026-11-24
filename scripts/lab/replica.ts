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
 *
 * Los límites `limites.*` son de admisión, no cambian la dinámica. La réplica parte de los
 * límites que `hostParams()` deriva del hardware, igual que un mundo nuevo del servidor; los
 * overrides de `--params` siguen prevaleciendo. `replica.json` ya registra los params completos.
 *
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { hostParams } from '../../src/server/hardware-limits.js';
import { technologyJournalNearCapacity } from '../../src/world/technology-journal.js';
import { chronicleJournalNearCapacity } from '../../src/world/chronicle-journal.js';
import { assertWorld, createWorld, fraccionSerial, projectWorld, puntoDeRestauracion, stepWorld, TICKS_PER_DAY, type FaseMedicion, type World } from '../../src/world/index.js';
import { catalogueEnabled, technologyCatalogueNearCapacity, technologyCatalogueTotals } from '../../src/world/technology-catalogue.js';
import { worldStatistics } from '../../src/world/statistics.js';
import { indiceDiversidad } from '../../src/world/diversidad.js';
import { DEFAULT_PARAMS, paramsOf, parseParams, setParams, type WorldParams } from '../../src/world/params.js';
import type { FaseNombre } from '../../src/shared/types.js';
import { durableActivityMetrics } from './metrics.js';
import { InstrumentosConducta } from './instrumentos.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { faunaTotal, registrarFaunaRetirada } from './fauna-total.js';

/** Pasos de la ventana del p95 del paso, la misma que la telemetría del servidor (`registrarPaso`, src/server/app.ts). */
const VENTANA_P95_PASOS = 120;

const CAUSES = ['starvation', 'dehydration', 'exposure', 'senescence'] as const;
type Cause = typeof CAUSES[number];
const FASE_NOMBRES: readonly FaseNombre[] = [
  'maintainRegions', 'ecologia', 'kernel', 'fauna', 'personas', 'encuentros',
  'demografia', 'comunidades', 'reproduccion', 'checkpoint', 'muestreo', 'save', 'broadcast',
];

function flagPresente(flag: string): boolean {
  return process.argv.some(a => a === flag || a.startsWith(`${flag}=`));
}

function arg(flag: string): string | undefined {
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a === flag) return process.argv[i + 1];
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}

function normalizarGpuArg(raw: string): string {
  const trimmed = raw.trim();
  return /^\d+(,\s*\d+)*$/.test(trimmed) ? `[${trimmed}]` : raw;
}

/**
 * `digestoCanonico` hashea `{world, params}`. Para que dos backends de hardware
 * (`motor.hilos`, `motor.gpu`, `motor.orden`) produzcan el mismo `digestoMundoFinal`
 * cuando el estado del mundo y las leyes materiales coinciden bit a bit, normalizamos
 * únicamente esas tres claves de ejecución a sus defaults durante el cálculo del hash.
 */
function digestoMundoSinHardware(world: World): string {
  const vigentes = paramsOf(world);
  if (
    vigentes.motor.hilos === DEFAULT_PARAMS.motor.hilos &&
    vigentes.motor.gpu.length === DEFAULT_PARAMS.motor.gpu.length &&
    vigentes.motor.orden === DEFAULT_PARAMS.motor.orden
  ) {
    return digestoCanonico(world);
  }
  const sinHardware: WorldParams = {
    ...vigentes,
    motor: {
      ...vigentes.motor,
      hilos: DEFAULT_PARAMS.motor.hilos,
      gpu: DEFAULT_PARAMS.motor.gpu,
      orden: DEFAULT_PARAMS.motor.orden,
    },
  };
  setParams(world, sinHardware);
  try {
    return digestoCanonico(world);
  } finally {
    setParams(world, vigentes);
  }
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
function dailyMetrics(world: ReturnType<typeof createWorld>, store: Store, censosFauna: ReadonlyMap<string, number>) {
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
    // Activos vivos más el último censo vivo de cada chunk retirado que sigue inactivo.
    // El censo se toma antes de cada Store.save, que vacía world.retiredChunks.
    faunaTotal: faunaTotal(world, censosFauna),
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

/** Métricas adicionales de `--servidor si`, con la reserva, el paso y el guardado de `stepOnce`. */
function metricasServidor(world: World, p95PasoFinal: number, cloneMsMuestras: readonly number[], saveMsMuestras: readonly number[]) {
  const vivos = world.people;
  type Rasgos = { resilience: number; learningRate: number; curiosity: number; sociability: number; care: number };
  const sumas = new Map<number, { cuenta: number; suma: Rasgos }>();
  for (const persona of vivos) {
    const generacion = persona.genome.generation;
    let entrada = sumas.get(generacion);
    if (!entrada) { entrada = { cuenta: 0, suma: { resilience: 0, learningRate: 0, curiosity: 0, sociability: 0, care: 0 } }; sumas.set(generacion, entrada); }
    entrada.cuenta++;
    entrada.suma.resilience += persona.traits.resilience; entrada.suma.learningRate += persona.genome.learningRate;
    entrada.suma.curiosity += persona.traits.curiosity; entrada.suma.sociability += persona.traits.sociability; entrada.suma.care += persona.traits.care;
  }
  const rasgosPorGeneracion: Record<string, Rasgos> = {};
  for (const [generacion, { cuenta, suma }] of [...sumas.entries()].sort((a, b) => a[0] - b[0]))
    rasgosPorGeneracion[String(generacion)] = { resilience: suma.resilience / cuenta, learningRate: suma.learningRate / cuenta, curiosity: suma.curiosity / cuenta, sociability: suma.sociability / cuenta, care: suma.care / cuenta };
  // Varianza media de los 14 alelos (GENE_COUNT*2) entre los vivos; 0 con 0 o 1 habitante (sin
  // pareja no hay dispersión que medir, no es indefinido).
  let varianzaGenetica = 0;
  if (vivos.length > 0) {
    const numAlelos = vivos[0]!.genome.alleles.length;
    let sumaVarianzas = 0;
    for (let indice = 0; indice < numAlelos; indice++) {
      const valores = vivos.map(persona => persona.genome.alleles[indice]!);
      const media = valores.reduce((suma, valor) => suma + valor, 0) / valores.length;
      sumaVarianzas += valores.reduce((suma, valor) => suma + (valor - media) ** 2, 0) / valores.length;
    }
    varianzaGenetica = sumaVarianzas / numAlelos;
  }
  return {
    p95PasoFinal, cloneMsP50: distribution(cloneMsMuestras).p50, saveMsP50: distribution(saveMsMuestras).p50,
    indiceDiversidad: indiceDiversidad(world),
    cooperacionPorTipo: { cooperation: world.totals.cooperation ?? 0, teaching: world.totals.teaching ?? 0, trade: world.totals.trade ?? 0, constructionHelp: world.totals.constructionHelp ?? 0, conflicts: world.totals.conflicts ?? 0 },
    comunidades: world.communities.length,
    rasgosPorGeneracion, varianzaGenetica,
  };
}

async function main(): Promise<void> {
  const seed = Number(arg('--seed') ?? 51926), dias = Number(arg('--dias') ?? 1), salida = arg('--salida');
  if (!Number.isInteger(seed) || seed < 0) throw new Error('Uso: --seed N --dias D [--params "a.b=1,c.d=2"] --salida <dir> (seed entero ≥ 0).');
  if (!Number.isInteger(dias) || dias < 1) throw new Error('Uso: --seed N --dias D [--params "a.b=1,c.d=2"] --salida <dir> (dias entero ≥ 1).');
  if (!salida) throw new Error('Uso: --seed N --dias D [--params "a.b=1,c.d=2"] --salida <dir> (falta --salida).');
  if (flagPresente('--gobernador')) throw new Error('La opción --gobernador fue retirada. Usa --servidor si|no.');
  const servidorArg = flagPresente('--servidor') ? arg('--servidor') : 'no';
  if (servidorArg !== 'si' && servidorArg !== 'no') throw new Error('Uso: --servidor si|no (por defecto "no").');
  const imitarServidor = servidorArg === 'si';
  // Instrumentos de medida (scripts/lab/instrumentos.ts): conducta, cooperación y panel C8.
  // Por defecto activos; `--instrumentos no` da EXACTAMENTE los dia-NNN.json de antes (mismas claves).
  const instrumentosArg = arg('--instrumentos') ?? 'si';
  if (instrumentosArg !== 'si' && instrumentosArg !== 'no') throw new Error('Uso: --instrumentos si|no (por defecto "si").');
  const motorOverrides: Record<string, unknown> = {};
  if (flagPresente('--hilos')) {
    const hilosArg = arg('--hilos');
    if (hilosArg === undefined || hilosArg === '' || hilosArg.startsWith('--')) throw new Error('Uso: --hilos N (entero en [1, 512]).');
    motorOverrides['motor.hilos'] = hilosArg;
  }
  if (flagPresente('--gpu')) {
    const gpuArg = arg('--gpu');
    if (gpuArg === undefined || gpuArg === '' || gpuArg.startsWith('--')) throw new Error('Uso: --gpu <lista> (p. ej. [], [0], [0,1]).');
    motorOverrides['motor.gpu'] = normalizarGpuArg(gpuArg);
  }
  if (flagPresente('--orden')) {
    const ordenArg = arg('--orden');
    if (ordenArg === undefined || ordenArg === '' || ordenArg.startsWith('--')) throw new Error('Uso: --orden natural|inverso|adversarial.');
    motorOverrides['motor.orden'] = ordenArg;
  }
  let params: WorldParams = parseParams(arg('--params'), hostParams());
  if (Object.keys(motorOverrides).length > 0) params = parseParams(motorOverrides, params);
  mkdirSync(salida, { recursive: true });

  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-lab-'));
  process.env.CARTA_DATA_DIR = dataDir;
  const store = new Store(join(dataDir, 'world.sqlite'));
  try {
    const world = createWorld(seed, params);
    const censosFauna = new Map<string, number>();
    const poblacionInicial = world.people.length;
    const vecinosMortalesIniciales = world.people.filter(person => person.role === 'neighbor').length;
    const fundadoresMortalesIniciales = world.people.filter(person => person.role === 'neighbor' && person.genome.generation === 0).length;
    // P3: adjuntar y guardar el Store ANTES de simular fija las leyes de tecnología de producción
    // (enableTechnologyCatalogue) y liga el WorldContext (loadChunk/catalogueReader) al mundo.
    registrarFaunaRetirada(world, censosFauna);
    store.save(world);
    const instrumentos = instrumentosArg === 'si' ? new InstrumentosConducta(world, store.db) : null;

    // Solo con --servidor si: tiempos de reserva y guardado del día en curso.
    const cloneMsDia: number[] = [], saveMsDia: number[] = [];

    const totalTicks = dias * TICKS_PER_DAY, stepTimes: number[] = [];
    const fasesAcumuladas: Record<FaseNombre, number> = Object.fromEntries(FASE_NOMBRES.map(nombre => [nombre, 0])) as Record<FaseNombre, number>;
    const medicion: FaseMedicion = { clock: () => performance.now(), fases: fasesAcumuladas };
    let maxRss = process.memoryUsage().rss, ultimoDia: ReturnType<typeof dailyMetrics> | null = null;
    for (let tick = 1; tick <= totalTicks; tick++) {
      if (imitarServidor) {
        // Como stepOnce sin entradas y sin turbo: `true` avanza en el sitio y `false`
        // toma un punto de restauración. El guardado del paso queda dentro de la medición.
        instrumentos?.antesDelPaso(world);
        const stepStarted = performance.now();
        const punto = params.motor.clonPorPaso ? null : puntoDeRestauracion(world);
        const cloneMs = punto ? performance.now() - stepStarted : 0;
        try {
          stepWorld(world, [], undefined, medicion);
        } catch (error) {
          punto?.restaurar();
          throw error;
        }
        // Antes del guardado (vacía chronicleJournal.pending) y FUERA de la medida: su coste se
        // descuenta de stepMs para medir el mismo paso que sin instrumentos.
        const observadoAntes = instrumentos ? instrumentos.costeMs : 0;
        instrumentos?.despuesDelPaso(world);
        const observacionMs = instrumentos ? instrumentos.costeMs - observadoAntes : 0;
        let saveMs = 0;
        // sprint/journal-caps-20260929: además de la cadencia, guarda YA si el diario de
        // tecnología, crónica o catálogo se acerca a su tope de pendientes (ver hardware-limits.ts:
        // población grande puede acumular más recibos por tick de los que caben en `cadaTicks`).
        if (tick % params.persistencia.cadaTicks === 0
          || technologyJournalNearCapacity(world.technology) || chronicleJournalNearCapacity(world)
          || technologyCatalogueNearCapacity(world.technology)) {
          const saveStarted = performance.now();
          registrarFaunaRetirada(world, censosFauna);
          store.save(world);
          saveMs = performance.now() - saveStarted;
          fasesAcumuladas.save += saveMs;
        }
        const stepMs = performance.now() - stepStarted - observacionMs;
        stepTimes.push(stepMs);
        cloneMsDia.push(cloneMs); saveMsDia.push(saveMs);
      } else {
        instrumentos?.antesDelPaso(world);
        const started = performance.now();
        stepWorld(world, [], undefined, medicion);
        stepTimes.push(performance.now() - started);
        instrumentos?.despuesDelPaso(world);
        // sprint/journal-caps-20260929: mismo commit anticipado que en el modo "servidor" arriba.
        if (tick % params.persistencia.cadaTicks === 0
          || technologyJournalNearCapacity(world.technology) || chronicleJournalNearCapacity(world)
          || technologyCatalogueNearCapacity(world.technology)) {
          const saveStarted = performance.now();
          registrarFaunaRetirada(world, censosFauna); store.save(world);
          fasesAcumuladas.save += performance.now() - saveStarted;
        }
      }
      if (tick % TICKS_PER_DAY === 0) {
        if (tick % params.persistencia.cadaTicks !== 0) {
          const saveStarted = performance.now();
          registrarFaunaRetirada(world, censosFauna); store.save(world);
          fasesAcumuladas.save += performance.now() - saveStarted;
        }
        assertWorld(world);
        const dia = tick / TICKS_PER_DAY, rss = process.memoryUsage().rss, { p50, p95 } = distribution(stepTimes.slice(-TICKS_PER_DAY));
        maxRss = Math.max(maxRss, rss);
        const metrics = dailyMetrics(world, store, censosFauna);
        ultimoDia = metrics;
        // Campos nuevos de los instrumentos; foodShared entra como un tipo más de cooperación.
        let medidas: Record<string, unknown> = metrics;
        if (instrumentos) {
          const { foodShared, ...conducta } = instrumentos.metricasDia(world, store.db);
          medidas = { ...metrics, cooperacionAcumuladaPorTipo: { ...metrics.cooperacionAcumuladaPorTipo, foodShared }, ...conducta };
        }
        const extra = imitarServidor ? metricasServidor(world, distribution(stepTimes.slice(-VENTANA_P95_PASOS)).p95, cloneMsDia, saveMsDia) : {};
        const body = { tick, ...medidas, ...extra, p50Ms: Math.round(p50 * 100) / 100, p95Ms: Math.round(p95 * 100) / 100, rss };
        writeFileSync(join(salida, `dia-${String(dia).padStart(3, '0')}.json`), JSON.stringify(body, null, 2) + '\n');
        if (imitarServidor) { cloneMsDia.length = 0; saveMsDia.length = 0; }
      }
    }
    registrarFaunaRetirada(world, censosFauna);
    store.save(world);
    if (!ultimoDia) throw new Error('No se completó ningún día; --dias debe producir al menos un dia-NNN.json.');

    const { p50, p95 } = distribution(stepTimes);
    const fases = Object.fromEntries(
      FASE_NOMBRES.map(nombre => [nombre, fasesAcumuladas[nombre] / totalTicks]),
    ) as Record<FaseNombre, number>;
    const teselasActivas = world.tiles.length;
    const teselasPorHabitante = teselasActivas / Math.max(1, world.people.length);
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
      metricasVersion: 2,
      servidor: imitarServidor
        ? 'si, imita stepOnce sin entradas y sin turbo, con guardado por cadencia o presión de diarios'
        : 'no, mide stepWorld en el sitio',
      instrumentos: instrumentos ? 'si; solo lectura (scripts/lab/instrumentos.ts): conducta por tiempo, comida compartida y panel C8' : 'no',
      seed, params, sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      digest: worldSourceDigest(),
      teselasActivas,
      teselasPorHabitante,
      fases,
      fraccionSerial: fraccionSerial(fases),
      // Huella del ESTADO final (digestoCanonico de src/world/digesto.ts): con y sin instrumentos
      // (y entre distintos backends de hardware) debe ser idéntica. `digest` es la del CÓDIGO.
      digestoMundoFinal: digestoMundoSinHardware(world), dias, resumen,
    };
    writeFileSync(join(salida, 'replica.json'), JSON.stringify(replica, null, 2) + '\n');
    if (instrumentos) {
      const pasoMedio = stepTimes.reduce((suma, ms) => suma + ms, 0) / stepTimes.length;
      console.log(`Instrumentos: ${(instrumentos.costeMs / instrumentos.pasos).toFixed(4)} ms/paso de media (${instrumentos.costeMs.toFixed(0)} ms en ${instrumentos.pasos} pasos, incluidos los cálculos diarios) frente a ${pasoMedio.toFixed(2)} ms/paso de stepWorld (${(100 * instrumentos.costeMs / (pasoMedio * stepTimes.length)).toFixed(2)} %).`);
    }
    console.log(`Réplica completa: ${dias} día(s), población final ${resumen.poblacionFinal}. Salida: ${salida}`);
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
}

main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
