/** Perfil reproducible del paso, exclusivamente sobre escenas privadas del laboratorio.
 * Las fases usan reloj de pared y CPU propia simultáneamente. La carga y el diario se
 * declaran aparte; la clasificación serial por diseño no acredita workers activos.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { Store } from '../../src/server/store.js';
import { assertWorld, fraccionSerial, projectWorld, stepWorld, TICKS_PER_DAY, type FaseMedicion } from '../../src/world/index.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { paramsOf, parseParams, setParams } from '../../src/world/params.js';
import { technologyJournalNearCapacity } from '../../src/world/technology-journal.js';
import { chronicleJournalNearCapacity } from '../../src/world/chronicle-journal.js';
import { catalogueEnabled, technologyCatalogueNearCapacity, technologyCatalogueTotals } from '../../src/world/technology-catalogue.js';
import { worldStatistics } from '../../src/world/statistics.js';
import { durableActivityMetrics } from '../lab/metrics.js';
import { faunaTotal, registrarFaunaRetirada } from '../lab/fauna-total.js';
import { InstrumentosConducta } from '../lab/instrumentos.js';

const arg = (key: string) => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
const cpu = () => { const c = process.cpuUsage(); return (c.user + c.system) / 1000; };
const stamp = () => ({ wall: performance.now(), cpu: cpu() });
const difference = (a: ReturnType<typeof stamp>, b = stamp()) => ({ wallMs: b.wall - a.wall, cpuMs: b.cpu - a.cpu });
function distribution(values: readonly number[]) {
  const v = [...values].sort((a, b) => a - b);
  return { n: v.length, mean: v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0,
    p50: v[Math.floor(v.length * .5)] ?? null, p95: v[Math.floor(v.length * .95)] ?? null,
    max: v.at(-1) ?? null };
}
function sourceHash() {
  const h = createHash('sha256');
  function walk(p: string) { for (const e of readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const f = join(p, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith('.ts')) h.update(f).update('\0').update(readFileSync(f));
  } }
  walk('src/world'); walk('src/server');
  for (const f of ['scripts/perf/perfil-escala.ts', 'scripts/lab/instrumentos.ts', 'scripts/lab/metrics.ts', 'scripts/lab/fauna-total.ts'])
    h.update(f).update('\0').update(readFileSync(f));
  return h.digest('hex');
}
/** Same dailyMetrics calculation as replica.ts; measured apart, without interpreting criteria. */
function dailyMetrics(world: Parameters<typeof stepWorld>[0], store: Store, census: ReadonlyMap<string, number>) {
  const stats = worldStatistics(world), loose = stats as unknown as Record<string, unknown>;
  const specialties = projectWorld(world).people.map(p => p.specialty ?? '');
  const counts = new Map<string, number>(); for (const s of specialties) counts.set(s, (counts.get(s) ?? 0) + 1);
  let entropy = 0; for (const n of counts.values()) { const p = n / specialties.length; entropy -= p * Math.log2(p); }
  const catalogue = technologyCatalogueTotals(world);
  const nullable = (key: string) => typeof loose[key] === 'number' ? loose[key] : null;
  return { poblacion: world.people.length, nacimientos: world.totals.births ?? 0,
    muertesPorCausa: Object.fromEntries(['starvation', 'dehydration', 'exposure', 'senescence'].map(c => [c, world.demographyDynamics.causes[c as keyof typeof world.demographyDynamics.causes]])),
    faunaTotal: faunaTotal(world, census), fundadoresVivos: stats.generations['0'] ?? 0,
    generacionesVivas: Object.keys(stats.generations).length, diversidadOficios: entropy,
    recetasCreadasAcumuladas: catalogue.recipes, diversidadConducta: stats.diversidad?.total ?? null,
    diversidadFuncional: catalogue.functionalDiversity, catalogoActivo: catalogueEnabled(world.technology),
    cooperaciones: world.totals.cooperation ?? 0, gini: nullable('giniRecursosPorRegion'),
    fraccionComida: nullable('fraccionCeldasConComida'), distanciaAgua: nullable('distanciaMediaAgua'),
    regionesSinAgua: nullable('regionesSinAgua'), ...durableActivityMetrics(world, store.db, world.tick - TICKS_PER_DAY) };
}

async function main() {
  const db = arg('--db'), output = arg('--salida'), steps = Number(arg('--pasos') ?? 600), threads = Number(arg('--hilos') ?? 1);
  const allowed = '/datos/tmp-atlas-lab/datos-lab/perfil-escala-20260930/escenas/';
  if (!db || !realpathSync(db).startsWith(allowed) || !output || !resolve(output).startsWith('/datos/tmp-atlas-lab/balance/'))
    throw new Error('Uso: --db <escena privada codex7> --salida <balance/resultado.json> [--pasos 600] [--hilos 1]');
  const balance = realpathSync('/datos/tmp-atlas-lab/balance'), parent = realpathSync(dirname(resolve(output)));
  if (parent !== balance && !parent.startsWith(balance + sep)) throw new Error('La salida resuelta debe permanecer en balance');
  if (!Number.isSafeInteger(steps) || steps < 1 || ![1, 2, 4, 8, 28].includes(threads)) throw new Error('Pasos/hilos inválidos');
  if (['', '.pasos.jsonl', '.cpuprofile', '.diario-muestra.json'].some(s => existsSync(output + s))) throw new Error('No se sobrescriben resultados');
  if (process.env.TMPDIR !== '/datos/tmp-atlas-lab') throw new Error('TMPDIR=/datos/tmp-atlas-lab obligatorio');
  const startedAt = new Date().toISOString(), code = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const sourceDigest = sourceHash(), working = mkdtempSync(join(tmpdir(), 'codex7-perfil-'));
  mkdirSync(resolve(output, '..'), { recursive: true });
  console.log(JSON.stringify({ event: 'copy', startedAt, pid: process.pid, db, working }));
  const copyAt = stamp();
  execFileSync('cp', ['--reflink=auto', '--', realpathSync(db), join(working, 'world.sqlite')]);
  const copyMeasurement = difference(copyAt), copyCost = { wallMs: copyMeasurement.wallMs, parentCpuMs: copyMeasurement.cpuMs };
  const store = new Store(join(working, 'world.sqlite'));
  const profiler = new Session();
  const post = (method: string, params: object = {}) => new Promise<any>((yes, no) => profiler.post(method, params, (e, r) => e ? no(e) : yes(r)));
  try {
    const loadAt = stamp(), loaded = store.load();
    if (!loaded) throw new Error('Escena vacía');
    const loadCost = difference(loadAt), world = loaded.world, referenceParams = paramsOf(world);
    const initialDigest = digestoCanonico(world), initial = { tick: world.tick, population: world.people.length,
      tiles: world.tiles.length, animals: world.animals.length, recipes: world.technology.recipes.length };
    setParams(world, parseParams(`motor.hilos=${threads}`, referenceParams));
    const census = new Map<string, number>(), instrumentsAt = stamp(), instruments = new InstrumentosConducta(world, store.db);
    const instrumentsSetup = difference(instrumentsAt);
    const samples: { tick: number; population: number; tiles: number; step: ReturnType<typeof difference>;
      phases: Record<string, ReturnType<typeof difference>>; observation: ReturnType<typeof difference>;
      save: ReturnType<typeof difference> | null; saveReasons: string[] }[] = [];
    const phaseWall: Record<string, number> = {}, phaseCpu: Record<string, number> = {};
    const maxPending = { technology: 0, chronicle: 0, catalogue: 0 };
    let lastSavedTick = world.tick;
    if (process.argv.includes('--cpu-profile')) { profiler.connect(); await post('Profiler.enable'); await post('Profiler.start'); }
    for (let n = 0; n < steps; n++) {
      const observationBeforeAt = stamp(); instruments.antesDelPaso(world);
      const observationBefore = difference(observationBeforeAt), marks: ReturnType<typeof stamp>[] = [];
      const measure: FaseMedicion = { clock: () => { const s = stamp(); marks.push(s); return s.wall; }, fases: {} };
      const stepAt = stamp(); stepWorld(world, [], undefined, measure); const step = difference(stepAt);
      const keys = Object.keys(measure.fases), phases: Record<string, ReturnType<typeof difference>> = {};
      if (marks.length !== keys.length * 2) throw new Error('Fases anidadas/repetidas: actualizar el lector de marcas antes de medir');
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!, cost = difference(marks[i * 2]!, marks[i * 2 + 1]!); phases[key] = cost;
        if (Math.abs(cost.wallMs - measure.fases[key as keyof typeof measure.fases]!) > 1e-7)
          throw new Error('Las marcas no coinciden con la fase: no medir fases anidadas con este lector');
        phaseWall[key] = (phaseWall[key] ?? 0) + cost.wallMs; phaseCpu[key] = (phaseCpu[key] ?? 0) + cost.cpuMs;
      }
      const observationAfterAt = stamp(); instruments.despuesDelPaso(world); const observationAfter = difference(observationAfterAt);
      maxPending.technology = Math.max(maxPending.technology, world.technology.journal?.pending.length ?? 0);
      maxPending.chronicle = Math.max(maxPending.chronicle, world.chronicleJournal?.pending.length ?? 0);
      maxPending.catalogue = Math.max(maxPending.catalogue, world.technology.catalogue?.pending.length ?? 0);
      const reasons: string[] = [];
      if (world.tick % paramsOf(world).persistencia.cadaTicks === 0) reasons.push('cadencia');
      if (technologyJournalNearCapacity(world.technology)) reasons.push('technology');
      if (chronicleJournalNearCapacity(world)) reasons.push('chronicle');
      if (technologyCatalogueNearCapacity(world.technology)) reasons.push('catalogue');
      let save: ReturnType<typeof difference> | null = null;
      if (reasons.length) { const at = stamp(); registrarFaunaRetirada(world, census); store.save(world); save = difference(at); lastSavedTick = world.tick; }
      samples.push({ tick: world.tick, population: world.people.length, tiles: world.tiles.length, step, phases,
        observation: { wallMs: observationBefore.wallMs + observationAfter.wallMs, cpuMs: observationBefore.cpuMs + observationAfter.cpuMs }, save, saveReasons: reasons });
      if ((n + 1) % 100 === 0 || n + 1 === steps) {
        appendFileSync(output + '.pasos.jsonl', samples.slice(Math.floor(n / 100) * 100).map(s => JSON.stringify(s)).join('\n') + '\n');
        console.log(JSON.stringify({ event: 'steps', completed: n + 1, tick: world.tick, population: world.people.length, at: new Date().toISOString() }));
      }
    }
    if (process.argv.includes('--cpu-profile')) { const { profile } = await post('Profiler.stop'); writeFileSync(output + '.cpuprofile', JSON.stringify(profile)); profiler.disconnect(); }
    // La consulta durable exige un estado confirmado. Este cierre queda fuera de las
    // muestras de paso/guardado ordinario y nunca se oculta en su media.
    let terminalSave: ReturnType<typeof difference> | null = null;
    if (lastSavedTick !== world.tick) {
      const at = stamp(); registrarFaunaRetirada(world, census); store.save(world); terminalSave = difference(at); lastSavedTick = world.tick;
    }
    const dailyAt = stamp(), metrics = dailyMetrics(world, store, census), dailyBase = difference(dailyAt);
    const dailyInstrumentsAt = stamp(), instrumentMetrics = instruments.metricasDia(world, store.db), dailyInstruments = difference(dailyInstrumentsAt);
    const encodeAt = stamp(), dailyBody = JSON.stringify({ ...metrics, ...instrumentMetrics }); const dailyEncoding = difference(encodeAt);
    const writeAt = stamp(); writeFileSync(output + '.diario-muestra.json', dailyBody + '\n'); const dailyWrite = difference(writeAt);
    const validationAt = stamp(); assertWorld(world); const validation = difference(validationAt);
    const measuredParams = paramsOf(world); setParams(world, referenceParams);
    const finalDigest = digestoCanonico(world); setParams(world, measuredParams);
    const totalWall = samples.reduce((s, x) => s + x.step.wallMs, 0), totalCpu = samples.reduce((s, x) => s + x.step.cpuMs, 0);
    const saves = samples.filter(s => s.save !== null);
    const sumPhaseWall = Object.values(phaseWall).reduce((a, b) => a + b, 0), sumPhaseCpu = Object.values(phaseCpu).reduce((a, b) => a + b, 0);
    const result = { startedAt, finishedAt: new Date().toISOString(), code, sourceDigest, pid: process.pid, db: realpathSync(db), working,
      seed: world.seed, initial, final: { tick: world.tick, population: world.people.length, tiles: world.tiles.length }, steps,
      referenceParams, measuredParams, initialDigest, finalDigest,
      digestNormalization: 'Only motor.hilos restored to referenceParams for final digest; all laws preserved',
      copyCost, loadCost, stepWall: distribution(samples.map(s => s.step.wallMs)), stepCpu: distribution(samples.map(s => s.step.cpuMs)),
      phases: Object.fromEntries(Object.keys(phaseWall).map(k => [k, { wallMsPerStep: phaseWall[k]! / steps, cpuMsPerStep: phaseCpu[k]! / steps,
        wallFraction: phaseWall[k]! / totalWall, cpuFraction: phaseCpu[k]! / totalCpu }])),
      unclassified: { wallMsPerStep: (totalWall - sumPhaseWall) / steps, cpuMsPerStep: (totalCpu - sumPhaseCpu) / steps },
      serialByDesign: fraccionSerial({ ...phaseWall, save: saves.reduce((s, x) => s + x.save!.wallMs, 0) }),
      execution: { configuredThreads: threads, baselineSynchronousMotor: true, physicalSerialFraction: 1,
        note: 'Baseline bb48326 never dispatches motor.hilos; redesign evidence required after implementation' },
      saves: { count: saves.length, wall: distribution(saves.map(s => s.save!.wallMs)), cpu: distribution(saves.map(s => s.save!.cpuMs)),
        wallMsPerStep: saves.reduce((s, x) => s + x.save!.wallMs, 0) / steps, cpuMsPerStep: saves.reduce((s, x) => s + x.save!.cpuMs, 0) / steps },
      instrumentsSetup, observationWallMsPerStep: samples.reduce((s, x) => s + x.observation.wallMs, 0) / steps,
      daily: { base: dailyBase, instruments: dailyInstruments, encoding: dailyEncoding, write: dailyWrite, validation,
        terminalSave, lastSavedTick, censusScope: 'Active animals + chunks retired during this window; historic dormant census not restored',
        observedWindowSteps: steps, note: 'One separately measured closure; not a full 2400-step daily distribution' },
      maxPending, affinity: readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:.*$/m)?.[0] };
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ event: 'complete', output, finalDigest }));
  } finally { profiler.disconnect(); store.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
