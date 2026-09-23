/**
 * Coste del archivo de tecnología en la carga y en los guardados de un mundo grande (sprint noche-arch
 * 2026-09-23). El mundo público V10 pesa 1,19 GB y el 80 % es `technology_executions`; otro
 * verificador vio el primer guardado tras cargar congelar el bucle 90–177 s. Esto mide DÓNDE se va.
 *
 *   TMPDIR=/datos/tmp-atlas-lab nice -n 10 npx tsx scripts/perf/guardado-archivo.ts --db <copia.sqlite> \
 *     [--guardados 12] [--cadencia 100] [--sesion-antes 3] [--sin-copia] [--salida json]
 *
 * - Copia la base a un directorio temporal PROPIO bajo `$TMPDIR` (nunca escribe el original; con
 *   `--sin-copia` usa la ruta dada, que debe ser ya una copia de trabajo desechable).
 * - Régimen del servidor (`app.ts`): `new Store` → `load()` → `save(world)` (el «primer guardado») →
 *   `stepWorld` paso a paso y `save` cada `--cadencia` pasos, `--guardados` veces.
 * - `--sesion-antes K`: antes del guardado K (1 = el primero del bucle) hace `addSession`, como un inicio
 *   de sesión en la interfaz. Es una escritura por la MISMA conexión: mueve `total_changes()` y vuelve
 *   rancias las pruebas de `flushTechnology`/`assertChronicleChanges`, que entonces reverifican la línea
 *   base entera. Se puede repetir el flag.
 * - Cada operación se mide con reloj de pared y `process.cpuUsage` (usuario+sistema del proceso) y se
 *   reparte por método: se envuelven los métodos (también los privados, que en JS son propiedades
 *   normales) de `Store`, `TechnologyArchive` y `SnapshotParts`. Cada tramo es INCLUSIVO y cuenta sólo la
 *   llamada más externa de cada nombre (una recursión no se suma dos veces). Tramos de nombres distintos
 *   se solapan (p. ej. `assertTechnologyReceipts` está dentro de `assertTechnologyCoverage`).
 * - Digesto canónico del mundo tras cargar y al final: una medida no puede cambiar la simulación.
 *
 * Para el perfil por función: `node --cpu-prof --cpu-prof-dir D --import tsx scripts/perf/guardado-archivo.ts …`
 * y `tsx scripts/perf/cpuprof.ts resumen D/*.cpuprofile --pasos 1 --raiz load|save`.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { TechnologyArchive } from '../../src/server/technology-archive.js';
import { SnapshotParts } from '../../src/server/snapshot-parts.js';
import { stepWorld } from '../../src/world/index.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { paramsOf } from '../../src/world/params.js';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}
function args(flag: string): string[] {
  return process.argv.flatMap((value, index) => value === flag && process.argv[index + 1] ? [process.argv[index + 1]!] : []);
}
const cpuMs = (): number => { const { user, system } = process.cpuUsage(); return (user + system) / 1000; };
const r1 = (x: number): number => Math.round(x * 10) / 10;

interface Tramo { llamadas: number; paredMs: number; cpuMs: number }
interface Fase { nombre: string; paredMs: number; cpuMs: number; tramos: Record<string, Tramo>; extra?: Record<string, unknown> }

let fase: Fase | null = null;
const profundidad = new Map<string, number>();
/** Envuelve `metodos` del prototipo. Sólo se mide dentro de una fase abierta con `medir`. Con
 * `soloContar` no se toma reloj: son métodos de cientos de miles de llamadas por carga, donde dos
 * `process.cpuUsage()` por llamada (una llamada al sistema cada uno) inflarían la propia medida. */
function envolver(prototipo: object, prefijo: string, metodos: string[], soloContar = false): void {
  const proto = prototipo as Record<string, unknown>;
  for (const metodo of metodos) {
    const original = proto[metodo];
    if (typeof original !== 'function') throw new Error(`${prefijo}.${metodo} no existe: el script quedó viejo`);
    const nombre = `${prefijo}.${metodo}`;
    proto[metodo] = function (this: unknown, ...argumentos: unknown[]) {
      const actual = fase, nivel = profundidad.get(nombre) ?? 0;
      if (!actual || nivel > 0) {
        profundidad.set(nombre, nivel + 1);
        try { return (original as (...a: unknown[]) => unknown).apply(this, argumentos); }
        finally { profundidad.set(nombre, nivel); }
      }
      if (soloContar) {
        (actual.tramos[nombre] ??= { llamadas: 0, paredMs: 0, cpuMs: 0 }).llamadas++;
        profundidad.set(nombre, 1);
        try { return (original as (...a: unknown[]) => unknown).apply(this, argumentos); }
        finally { profundidad.set(nombre, 0); }
      }
      profundidad.set(nombre, 1);
      const pared = performance.now(), cpu = cpuMs();
      try { return (original as (...a: unknown[]) => unknown).apply(this, argumentos); }
      finally {
        profundidad.set(nombre, 0);
        const tramo = actual.tramos[nombre] ??= { llamadas: 0, paredMs: 0, cpuMs: 0 };
        tramo.llamadas++; tramo.paredMs += performance.now() - pared; tramo.cpuMs += cpuMs() - cpu;
      }
    };
  }
}
envolver(Store.prototype, 'Store', ['load', 'loadVerified', 'loadSlot', 'migrateSnapshot', 'assertChronicleArchive',
  'assertTechnologyCoverage', 'assertTechnologyReceipts', 'assertTechnologyCache', 'prepareTechnology', 'rememberTechnology',
  'save', 'flushTechnology', 'assertChronicleChanges', 'flushChronicle', 'pruneChronicle', 'assertTechnologyChanges', 'readSlot0',
  // Retención (sprint noche-arch 2026-09-23): poda por guardado, anillo del candidato en el camino frío, recuperación.
  'pruneTechnology', 'assertTechnologyRing', 'slotBoundsOf', 'technologyChainAt']);
envolver(Store.prototype, 'Store', ['loadLegacy', 'loadChunk', 'readTechnologyRecipe', 'assertTechnologyAuthor',
  'assertLegacyParents'], true);
envolver(TechnologyArchive.prototype, 'Archivo', ['listExecutions', 'listExecutionRecords', 'putExecution', 'putDefinition', 'putStats',
  'summarizeDefinitions', 'scanDefinitions', 'pruneExecutions']);
envolver(TechnologyArchive.prototype, 'Archivo', ['getDefinition', 'getStats', 'executionReferences', 'executionTimeline',
  'execution', 'referencedDefinition', 'getHistoryOrigin', 'definitionParents', 'readEpoch'], true);
envolver(SnapshotParts.prototype, 'Instantanea', ['read', 'prepare', 'write', 'verify', 'collect']);

function medir<T>(nombre: string, trabajo: () => T, fases: Fase[]): T {
  const actual: Fase = { nombre, paredMs: 0, cpuMs: 0, tramos: {} };
  fase = actual;
  const pared = performance.now(), cpu = cpuMs();
  try { return trabajo(); }
  finally {
    actual.paredMs = performance.now() - pared; actual.cpuMs = cpuMs() - cpu; fase = null; fases.push(actual);
    const principales = Object.entries(actual.tramos).sort((a, b) => b[1].paredMs - a[1].paredMs).slice(0, 8)
      .map(([n, t]) => `${n} ${r1(t.paredMs)}ms×${t.llamadas}`).join(' | ');
    console.log(`${nombre}: pared ${r1(actual.paredMs)} ms, cpu ${r1(actual.cpuMs)} ms :: ${principales}`);
  }
}

const origen = arg('--db'), guardados = Number(arg('--guardados') ?? 12), cadencia = Number(arg('--cadencia') ?? 100);
const salida = arg('--salida'), sinCopia = process.argv.includes('--sin-copia');
const sesionAntes = new Set(args('--sesion-antes').map(Number));
if (!origen || !existsSync(origen)) throw new Error('Uso: guardado-archivo.ts --db <copia.sqlite> [--guardados N] [--cadencia N]'
  + ' [--sesion-antes K]… [--sin-copia] [--salida json]');
if (!process.env.TMPDIR || process.env.TMPDIR.startsWith('/tmp'))
  throw new Error('TMPDIR debe apuntar fuera de /tmp: TMPDIR=/datos/tmp-atlas-lab');
if (!Number.isSafeInteger(guardados) || guardados < 0 || !Number.isSafeInteger(cadencia) || cadencia < 1)
  throw new Error('--guardados ≥ 0 y --cadencia ≥ 1');

const dir = sinCopia ? null : mkdtempSync(join(tmpdir(), 'atlas-arch-'));
const ruta = dir ? join(dir, 'world.sqlite') : origen;
if (dir) for (const sufijo of ['', '-wal', '-shm']) if (existsSync(origen + sufijo)) copyFileSync(origen + sufijo, ruta + sufijo);
const fases: Fase[] = [];
const filas = (store: Store): Record<string, number> => Object.fromEntries(
  ['technology_executions', 'technology_definitions', 'technology_stats', 'events', 'chunks']
  .map(tabla => [tabla, Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${tabla}`).get() as { n: number }).n)]));
try {
  const store = medir('abrir', () => new Store(ruta), fases);
  const loaded = medir('load', () => store.load(), fases);
  if (!loaded) throw new Error('La base no tiene mundo');
  const world = loaded.world;
  const digestoCarga = digestoCanonico(world);
  const inicial = { tick: world.tick, poblacion: world.people.length, executionCounter: world.technology.executionCounter,
    recipeCounter: world.technology.recipeCounter, journal: { startsAfter: world.technology.journal?.startsAfter,
      committedThrough: world.technology.journal?.committedThrough }, filas: filas(store), params: paramsOf(world).persistencia };
  console.log(JSON.stringify(inicial));
  medir('primerGuardado', () => store.save(world), fases);
  const context = store.context;
  const pasos: { cpuMs: number; paredMs: number }[] = [];
  for (let k = 1; k <= guardados; k++) {
    const pared = performance.now(), cpu = cpuMs(), pendientesAntes = world.technology.journal?.pending.length ?? 0;
    let n = 0;
    do { stepWorld(world, [], context); n++; } while (world.tick % cadencia !== 0);
    pasos.push({ cpuMs: cpuMs() - cpu, paredMs: performance.now() - pared });
    if (sesionAntes.has(k)) store.addSession(`arch-perf-${k}`.padEnd(64, '0'), Date.now() + 60_000);
    const pendientes = world.technology.journal?.pending.length ?? 0;
    medir(`guardado${k}${sesionAntes.has(k) ? '+sesion' : ''}`, () => store.save(world), fases);
    fases.at(-1)!.extra = { tick: world.tick, pasos: n, ejecucionesPendientes: pendientes - pendientesAntes,
      pasoCpuMsMedio: r1(pasos.at(-1)!.cpuMs / n) };
  }
  const final = { tick: world.tick, poblacion: world.people.length, filas: filas(store), digesto: digestoCanonico(world),
    bytesBase: statSync(ruta).size, bytesWal: existsSync(ruta + '-wal') ? statSync(ruta + '-wal').size : 0 };
  store.close();
  const informe = { origen, ruta, cadencia, guardados, sesionAntes: [...sesionAntes], inicial, digestoCarga, final,
    fases: fases.map(f => ({ ...f, paredMs: r1(f.paredMs), cpuMs: r1(f.cpuMs),
      tramos: Object.fromEntries(Object.entries(f.tramos).sort((a, b) => b[1].paredMs - a[1].paredMs)
        .map(([n, t]) => [n, { llamadas: t.llamadas, paredMs: r1(t.paredMs), cpuMs: r1(t.cpuMs) }])) })) };
  if (salida) writeFileSync(salida, JSON.stringify(informe, null, 1));
  console.log(`final: ${JSON.stringify(final)}`);
} finally {
  if (dir) rmSync(dir, { recursive: true, force: true });
}
