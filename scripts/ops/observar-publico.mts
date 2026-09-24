import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RULES_VERSION, TICKS_PER_DAY, type World } from '../../src/world/index.js';
import { worldStatistics } from '../../src/world/statistics.js';
import { readStoredSnapshot } from '../../src/server/snapshot-parts.js';

const CAUSAS = ['senescence', 'exposure', 'dehydration', 'starvation'] as const;
const COOPERACIONES = ['teaching', 'trade', 'constructionHelp', 'foodShared'] as const;
type Registro = Record<string, unknown>;

function argumentos(argv: string[]): { base: string; gemelo?: string; salida?: string } {
  const result: { base?: string; gemelo?: string; salida?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (!['--base', '--gemelo', '--salida'].includes(flag)) throw new Error(`Opción desconocida: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Falta el valor de ${flag}.`);
    const key = flag.slice(2) as 'base' | 'gemelo' | 'salida';
    if (result[key] !== undefined) throw new Error(`Opción repetida: ${flag}`);
    result[key] = value;
  }
  if (!result.base) throw new Error('Uso: npx tsx scripts/ops/observar-publico.mts --base <world.sqlite> [--gemelo <directorio>] [--salida informe.json]');
  return result as { base: string; gemelo?: string; salida?: string };
}

function objeto(value: unknown, nombre: string): Registro {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`La instantánea no contiene ${nombre} válido.`);
  return value as Registro;
}

/** Lee únicamente slot 0. El decodificador compartido resuelve formatos plano y paginado
 * en una transacción de lectura, sin migrar ni guardar el mundo. */
function leerInstantanea(path: string): { world: World; foodShared: { cantidad: number; completa: boolean } } {
  if (!existsSync(path)) throw new Error(`No existe la base SQLite: ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    db.exec('BEGIN');
    const snapshot = readStoredSnapshot(db, 0);
    if (!snapshot) throw new Error('La base no tiene una instantánea vigente en slot 0.');
    const world = objeto(snapshot.value, 'mundo') as unknown as World;
    if (!Number.isSafeInteger(world.tick) || world.tick < 0 || !Array.isArray(world.people)
      || !Array.isArray(world.legacy) || !Array.isArray(world.retiredLegacy)
      || !world.totals || !world.demographyDynamics || !world.communities)
      throw new Error('La instantánea del slot 0 no tiene los campos necesarios para medir el mundo.');
    const hasEvents = db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='events'").get();
    const foodShared = hasEvents
      ? { cantidad: Number((db.prepare("SELECT COUNT(*) AS n FROM main.events WHERE json_extract(body,'$.kind')='care'").get() as { n: number }).n),
          completa: !db.prepare("SELECT 1 FROM main.metadata WHERE key='chronicle-pruned-v1'").get()
            && world.chronicleJournal?.startsAfter === 0 }
      : { cantidad: 0, completa: false };
    db.exec('COMMIT');
    return { world, foodShared };
  } finally { db.close(); }
}

function metricas(world: World, foodShared: { cantidad: number; completa: boolean }) {
  const stats = worldStatistics(world);
  const mortales = world.people.filter(person => person.role === 'neighbor');
  const muertes = Object.fromEntries(CAUSAS.map(causa => [causa, world.demographyDynamics.causes[causa] ?? 0])) as Record<typeof CAUSAS[number], number>;
  const conocidas = Object.values(muertes).reduce((sum, n) => sum + n, 0);
  const muertesPorCausa = { ...muertes, otras: Math.max(0, world.demographyDynamics.deaths - conocidas) };
  const cooperacionAcumuladaPorTipo: Record<string, number> = {
    teaching: stats.totals.teaching ?? 0,
    trade: stats.totals.trade ?? 0,
    constructionHelp: stats.totals.constructionHelp ?? 0,
    foodShared: foodShared.cantidad,
  };
  cooperacionAcumuladaPorTipo.otras = Math.max(0, (stats.totals.cooperation ?? 0) - (stats.totals.teaching ?? 0)
    - (stats.totals.trade ?? 0) - (stats.totals.constructionHelp ?? 0));
  return {
    tick: world.tick,
    diaSimulado: world.tick / TICKS_PER_DAY,
    versionReglas: world.version ?? RULES_VERSION,
    poblacion: world.people.length,
    poblacionMortal: mortales.length,
    poblacionTotal: world.people.length,
    generacionesMortalesVivas: new Set(mortales.map(person => person.genome.generation)).size,
    generacionesMortalesPresentes: [...new Set(mortales.map(person => person.genome.generation))].sort((a, b) => a - b),
    fundadoresMortalesVivos: mortales.filter(person => person.genome.generation === 0).length,
    nacimientos: stats.totals.births ?? 0,
    muertesPorCausa,
    conflictosAcumulados: stats.totals.conflicts ?? 0,
    cooperacionAcumuladaPorTipo,
    foodSharedCompleto: foodShared.completa,
    comunidades: world.communities.length,
  };
}

const COMPARAR = ['poblacion', 'nacimientos', 'muertesPorCausa', 'conflictosAcumulados', 'cooperacionAcumuladaPorTipo'] as const;
function comparar(informe: ReturnType<typeof metricas>, dir: string, tick: number) {
  const diaCompleto = Math.floor(tick / TICKS_PER_DAY);
  if (diaCompleto < 1) return { diaGemelo: null, estado: 'sin día completo para comparar', diferencias: [] as string[] };
  const fichero = join(dir, `dia-${String(diaCompleto).padStart(3, '0')}.json`);
  if (!existsSync(fichero)) throw new Error(`No existe el día del gemelo requerido: ${fichero}`);
  const gemelo = objeto(JSON.parse(readFileSync(fichero, 'utf8')), `contenido de ${basename(fichero)}`);
  const diferencias: string[] = [];
  for (const campo of COMPARAR) {
    const publico = informe[campo];
    const laboratorio = gemelo[campo];
    if (campo === 'muertesPorCausa' || campo === 'cooperacionAcumuladaPorTipo') {
      const left = objeto(publico, campo), right = objeto(laboratorio, campo);
      const keys = campo === 'muertesPorCausa' ? CAUSAS : COOPERACIONES;
      for (const key of keys) if (JSON.stringify(left[key]) !== JSON.stringify(right[key]))
        diferencias.push(`${campo}.${key}: público=${JSON.stringify(left[key])}, gemelo=${JSON.stringify(right[key])}`);
    } else if (JSON.stringify(publico) !== JSON.stringify(laboratorio)) {
      diferencias.push(`${campo}: público=${JSON.stringify(publico)}, gemelo=${JSON.stringify(laboratorio)}`);
    }
  }
  return {
    diaGemelo: diaCompleto,
    nota: tick % TICKS_PER_DAY === 0 ? undefined : `El día simulado ${informe.diaSimulado} está incompleto; se coteja con el último día completo, dia-${String(diaCompleto).padStart(3, '0')}.json.`,
    estado: diferencias.length ? 'diferencias' : 'idénticos',
    diferencias,
  };
}

export function observarPublico(opciones: { base: string; gemelo?: string }) {
  const { world, foodShared } = leerInstantanea(resolve(opciones.base));
  const informe = metricas(world, foodShared);
  return {
    ...informe,
    ...(opciones.gemelo ? { comparacionGemelo: comparar(informe, resolve(opciones.gemelo), world.tick) } : {}),
  };
}

function main(): void {
  const options = argumentos(process.argv.slice(2));
  const report = observarPublico(options);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.salida) writeFileSync(resolve(options.salida), json, { encoding: 'utf8', flag: 'w' });
  else process.stdout.write(json);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
