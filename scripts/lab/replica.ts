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
 * `--techo-lab N` (entero ≥ 16; sin la bandera, nada cambia): techo DETERMINISTA de laboratorio. Emula
 * la política `techo` del gobernador del servidor (`decidirConTecho`, src/server/governor.ts) con el
 * techo YA FIJADO en N, en lugar del que dispara el p95 del paso (reloj de pared: no reproducible).
 * Antes de cada paso, `world.reproductionEnabled = población < N`, con la población contada como la
 * cuenta el servidor (`draft.people.length` en `governReproduction`, src/server/app.ts: todas las
 * personas vivas, S e I incluidas). Cota: ver `techoLabCota` (scripts/lab/techo-lab.ts) y scripts/lab/README.md §«Techo de
 * laboratorio». Incompatible con `--gobernador servidor`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { assertWorld, cloneWorld, createWorld, projectWorld, stepWorld, TICKS_PER_DAY, type World } from '../../src/world/index.js';
import { catalogueEnabled, technologyCatalogueTotals } from '../../src/world/technology-catalogue.js';
import { worldStatistics } from '../../src/world/statistics.js';
import { indiceDiversidad } from '../../src/world/diversidad.js';
import { parseParams, type WorldParams } from '../../src/world/params.js';
import { decideReproduction, RollingStepPerformance } from '../../src/server/governor.js';
import { decidirTechoLab, TECHO_LAB_MINIMO, techoLabCota } from './techo-lab.js';
import { durableActivityMetrics } from './metrics.js';
import { InstrumentosConducta } from './instrumentos.js';
import { digestoCanonico } from '../../src/world/digesto.js';

type ModoGobernador = 'no' | 'servidor';

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

/**
 * T118-bis ("laboratorio consciente del servidor"): `dailyMetrics` (arriba) queda intacta a
 * propósito — es el contrato que el test (a) protege bit a bit para `--gobernador no` (default).
 * Estas métricas SOLO existen con `--gobernador servidor`, y se calculan aparte para no arriesgar
 * ni una clave nueva en el régimen de hoy.
 *
 * `reproduccionActivaTicks`/`ticksDia` acotan la fracción al día en curso (no acumulado desde el
 * inicio, a diferencia del resto de `dailyMetrics`): es la señal que delata si el gobernador pasó
 * el día apagando/reencendiendo nacimientos, y acumularla desde el día 1 la diluiría.
 */
function metricasGobernador(world: World, reproduccionActivaTicks: number, ticksDia: number, p95GobernadorFinal: number, cloneMsMuestras: readonly number[], saveMsMuestras: readonly number[]) {
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
    reproduccionActivaFraccion: ticksDia > 0 ? reproduccionActivaTicks / ticksDia : 0,
    p95GobernadorFinal, cloneMsP50: distribution(cloneMsMuestras).p50, saveMsP50: distribution(saveMsMuestras).p50,
    indiceDiversidad: indiceDiversidad(world),
    cooperacionPorTipo: { cooperation: world.totals.cooperation ?? 0, teaching: world.totals.teaching ?? 0, trade: world.totals.trade ?? 0, constructionHelp: world.totals.constructionHelp ?? 0, conflicts: world.totals.conflicts ?? 0 },
    comunidades: world.communities.length,
    rasgosPorGeneracion, varianzaGenetica,
  };
}

const USO_TECHO = `Uso: --techo-lab N (entero ≥ ${TECHO_LAB_MINIMO}: techo fijo de laboratorio; sin la bandera no hay techo).`;

async function main(): Promise<void> {
  const seed = Number(arg('--seed') ?? 51926), dias = Number(arg('--dias') ?? 1), salida = arg('--salida');
  if (!Number.isInteger(seed) || seed < 0) throw new Error('Uso: --seed N --dias D [--params "a.b=1,c.d=2"] --salida <dir> (seed entero ≥ 0).');
  if (!Number.isInteger(dias) || dias < 1) throw new Error('Uso: --seed N --dias D [--params "a.b=1,c.d=2"] --salida <dir> (dias entero ≥ 1).');
  if (!salida) throw new Error('Uso: --seed N --dias D [--params "a.b=1,c.d=2"] --salida <dir> (falta --salida).');
  const gobernadorArg = arg('--gobernador') ?? 'no';
  if (gobernadorArg !== 'no' && gobernadorArg !== 'servidor') throw new Error('Uso: --gobernador no|servidor (por defecto "no").');
  const gobernadorModo: ModoGobernador = gobernadorArg;
  const techoArg = arg('--techo-lab');
  let techoLab: number | null = null;
  if (techoArg !== undefined) {
    const n = Number(techoArg);
    if (techoArg.trim() === '' || !Number.isInteger(n) || n < TECHO_LAB_MINIMO) throw new Error(`${USO_TECHO} Recibido «${techoArg}».`);
    if (gobernadorModo === 'servidor') throw new Error('--techo-lab es incompatible con --gobernador servidor: el techo de laboratorio es fijo y determinista, el del servidor lo dispara el p95 del reloj. Usa uno u otro.');
    techoLab = n;
  }
  // Instrumentos de medida (scripts/lab/instrumentos.ts): conducta por tiempo y comida compartida.
  // Por defecto activos; `--instrumentos no` da EXACTAMENTE los dia-NNN.json de antes (mismas claves).
  const instrumentosArg = arg('--instrumentos') ?? 'si';
  if (instrumentosArg !== 'si' && instrumentosArg !== 'no') throw new Error('Uso: --instrumentos si|no (por defecto "si").');
  const params: WorldParams = parseParams(arg('--params'));
  mkdirSync(salida, { recursive: true });

  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-lab-'));
  process.env.CARTA_DATA_DIR = dataDir;
  const store = new Store(join(dataDir, 'world.sqlite'));
  try {
    let world = createWorld(seed, params);
    const poblacionInicial = world.people.length;
    const vecinosMortalesIniciales = world.people.filter(person => person.role === 'neighbor').length;
    const fundadoresMortalesIniciales = world.people.filter(person => person.role === 'neighbor' && person.genome.generation === 0).length;
    // P3: adjuntar y guardar el Store ANTES de simular fija las leyes de tecnología de producción
    // (enableTechnologyCatalogue) y liga el WorldContext (loadChunk/catalogueReader) al mundo.
    store.save(world);
    const instrumentos = instrumentosArg === 'si' ? new InstrumentosConducta(world) : null;

    // Solo con --gobernador servidor: p95 de la ventana de 120 pasos (mismo mecanismo que
    // src/server/app.ts) y acumuladores del DÍA en curso, reiniciados en cada dia-NNN.json.
    const gobernadorPerf = new RollingStepPerformance();
    let reproduccionActivaTicksDia = 0, ticksDia = 0, p95GobernadorActual = 0;
    const cloneMsDia: number[] = [], saveMsDia: number[] = [];

    // Solo con --techo-lab: ticks del día (y de toda la réplica) con reproducción habilitada y población
    // máxima tras un paso, para comprobar la cota (`techoLabCota`) a resolución de paso.
    let techoTicksActivosDia = 0, techoTicksDia = 0, techoTicksActivos = 0, techoPoblacionMaximaDia = 0, techoPoblacionMaxima = world.people.length;

    const totalTicks = dias * TICKS_PER_DAY, stepTimes: number[] = [];
    let maxRss = process.memoryUsage().rss, ultimoDia: ReturnType<typeof dailyMetrics> | null = null;
    for (let tick = 1; tick <= totalTicks; tick++) {
      if (gobernadorModo === 'servidor') {
        // Imita src/server/app.ts:stepOnce — clon+paso, guardado por cadencia DENTRO de la
        // medición, y el gobernador decidiendo sobre el paso ya medido (governReproduction).
        instrumentos?.antesDelPaso(world);
        const stepStarted = performance.now();
        let cloneMs = 0;
        if (params.motor.clonPorPaso) {
          const cloneStarted = performance.now();
          const draft = cloneWorld(world, store.context);
          cloneMs = performance.now() - cloneStarted;
          stepWorld(draft);
          world = draft;
        } else {
          stepWorld(world);
        }
        // Antes del guardado (vacía chronicleJournal.pending) y FUERA de la medida: su coste se
        // descuenta de stepMs para que el gobernador decida sobre el mismo paso que sin instrumentos.
        const observadoAntes = instrumentos ? instrumentos.costeMs : 0;
        instrumentos?.despuesDelPaso(world);
        const observacionMs = instrumentos ? instrumentos.costeMs - observadoAntes : 0;
        let saveMs = 0;
        if (tick % params.persistencia.cadaTicks === 0) {
          const saveStarted = performance.now();
          store.save(world);
          saveMs = performance.now() - saveStarted;
        }
        const stepMs = performance.now() - stepStarted - observacionMs;
        stepTimes.push(stepMs);
        p95GobernadorActual = gobernadorPerf.record(stepMs);
        world.reproductionEnabled = decideReproduction(p95GobernadorActual, params.gobernador.presupuestoMs, world.reproductionEnabled);
        ticksDia++; if (world.reproductionEnabled) reproduccionActivaTicksDia++;
        cloneMsDia.push(cloneMs); saveMsDia.push(saveMs);
      } else {
        if (techoLab !== null) {
          // El servidor decide tras cada paso sobre el mundo vigente, para el paso siguiente; aquí se
          // decide antes de cada paso sobre la misma población (la del final del paso anterior).
          world.reproductionEnabled = decidirTechoLab(world.people.length, techoLab, params.gobernador.presupuestoMs);
          techoTicksDia++;
          if (world.reproductionEnabled) { techoTicksActivosDia++; techoTicksActivos++; }
        }
        instrumentos?.antesDelPaso(world);
        const started = performance.now();
        stepWorld(world);
        stepTimes.push(performance.now() - started);
        instrumentos?.despuesDelPaso(world);
        if (techoLab !== null) { techoPoblacionMaximaDia = Math.max(techoPoblacionMaximaDia, world.people.length); techoPoblacionMaxima = Math.max(techoPoblacionMaxima, world.people.length); }
        if (tick % params.persistencia.cadaTicks === 0) store.save(world);
      }
      if (tick % TICKS_PER_DAY === 0) {
        if (tick % params.persistencia.cadaTicks !== 0) store.save(world);
        assertWorld(world);
        const dia = tick / TICKS_PER_DAY, rss = process.memoryUsage().rss, { p50, p95 } = distribution(stepTimes.slice(-TICKS_PER_DAY));
        maxRss = Math.max(maxRss, rss);
        const metrics = dailyMetrics(world, store);
        ultimoDia = metrics;
        // Campos nuevos de los instrumentos; foodShared entra como un tipo más de cooperación.
        let medidas: Record<string, unknown> = metrics;
        if (instrumentos) {
          const { foodShared, ...conducta } = instrumentos.metricasDia(world);
          medidas = { ...metrics, cooperacionAcumuladaPorTipo: { ...metrics.cooperacionAcumuladaPorTipo, foodShared }, ...conducta };
        }
        const extra = gobernadorModo === 'servidor' ? metricasGobernador(world, reproduccionActivaTicksDia, ticksDia, p95GobernadorActual, cloneMsDia, saveMsDia)
          : techoLab !== null ? { techoLab, reproduccionActivaFraccion: techoTicksActivosDia / techoTicksDia, poblacionMaximaDia: techoPoblacionMaximaDia } : {};
        techoTicksActivosDia = 0; techoTicksDia = 0; techoPoblacionMaximaDia = 0;
        const body = { tick, ...medidas, ...extra, p50Ms: Math.round(p50 * 100) / 100, p95Ms: Math.round(p95 * 100) / 100, rss };
        writeFileSync(join(salida, `dia-${String(dia).padStart(3, '0')}.json`), JSON.stringify(body, null, 2) + '\n');
        if (gobernadorModo === 'servidor') { reproduccionActivaTicksDia = 0; ticksDia = 0; cloneMsDia.length = 0; saveMsDia.length = 0; }
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
      metricasVersion: 2,
      gobernador: gobernadorModo === 'servidor'
        ? 'servidor; imita stepOnce (clon+paso, guardado por cadencia, decideReproduction sobre p95) cada tick'
        : techoLab !== null ? `techo de laboratorio fijo en ${techoLab}; política techo del servidor sin reloj (reproductionEnabled = población < ${techoLab} antes de cada paso)`
          : 'no-ejecutado; replica de leyes, no del servidor',
      ...(techoLab !== null ? {
        techoLab,
        techoLabDetalle: {
          reproduccionActivaFraccion: techoTicksActivos / totalTicks,
          poblacionMaxima: techoPoblacionMaxima,
          cotaPoblacion: techoLabCota(techoLab, poblacionInicial, params.poblacion.nacimientosPorComprobacion),
          poblacionContada: 'world.people.length (todas las personas vivas, S e I incluidas), como governReproduction en src/server/app.ts',
        },
      } : {}),
      instrumentos: instrumentos ? 'si; solo lectura (scripts/lab/instrumentos.ts): conducta por tiempo y comida compartida' : 'no',
      seed, params, sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      digest: worldSourceDigest(),
      // Huella del ESTADO final (digestoCanonico de src/world/digesto.ts): con y sin instrumentos
      // debe ser idéntica (tests/instrumentos-lab.test.ts). `digest` es la del CÓDIGO.
      digestoMundoFinal: digestoCanonico(world), dias, resumen,
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
