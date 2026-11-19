/**
 * Sonda descriptiva CULT-VAR: un proceso por brazo y semilla.
 *
 *   npx tsx scripts/lab/observa-cultura.ts --brazo control --seed 9001 --salida /ruta/aislada
 *   npx tsx scripts/lab/observa-cultura.ts --brazo variante --seed 9002 --salida /ruta/aislada
 *
 * Escribe <salida>/<brazo>/<semilla>/dia-NNN.json y manifiesto.json. Usa las
 * mismas leyes de persistencia del laboratorio (Store desde el tick cero), sin
 * cargar un mundo existente ni conectar con el servidor público.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/server/store.js';
import { hostParams } from '../../src/server/hardware-limits.js';
import { assertWorld, createWorld, stepWorld, TICKS_PER_DAY, type World } from '../../src/world/index.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { parseParams } from '../../src/world/params.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CULTURE_KEYS = ['sharing', 'stewardship', 'openness'] as const;
type CultureKey = typeof CULTURE_KEYS[number];
type Brazo = 'control' | 'variante';
const DAYS = 10;

function argumentsOf(argv: string[]): { brazo: Brazo; seed: number; salida: string } {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!flag || !['--brazo', '--seed', '--salida'].includes(flag) || value === undefined || value.startsWith('--') || flags.has(flag))
      throw new Error('Uso: --brazo control|variante --seed 9001|9002 --salida DIRECTORIO');
    flags.set(flag, value);
  }
  const brazo = flags.get('--brazo'), seedText = flags.get('--seed'), salida = flags.get('--salida');
  if (brazo !== 'control' && brazo !== 'variante') throw new Error('El brazo debe ser control o variante.');
  if (seedText !== '9001' && seedText !== '9002') throw new Error('La semilla debe ser 9001 o 9002.');
  if (!salida) throw new Error('Falta --salida.');
  return { brazo, seed: Number(seedText), salida: resolve(salida) };
}

/** Varianza poblacional: Σ(x−media)²/n; con n=0, media y varianza son null. */
function moments(values: readonly number[]): { n: number; media: number | null; varianza: number | null } {
  if (values.length === 0) return { n: 0, media: null, varianza: null };
  const media = values.reduce((sum, x) => sum + x, 0) / values.length;
  return { n: values.length, media, varianza: values.reduce((sum, x) => sum + (x - media) ** 2, 0) / values.length };
}

function cultureMetrics(world: World) {
  const members = new Map<string, World['people']>();
  for (const person of world.people) if (person.communityId) {
    const group = members.get(person.communityId) ?? [];
    group.push(person);
    members.set(person.communityId, group);
  }
  const communities = [...members.values()];
  const byKey = {} as Record<CultureKey, {
    personas: ReturnType<typeof moments>;
    mediasComunidades: ReturnType<typeof moments>;
  }>;
  for (const key of CULTURE_KEYS) byKey[key] = {
    personas: moments(world.people.map(person => person.culture[key])),
    mediasComunidades: moments(communities.map(group =>
      group.reduce((sum, person) => sum + person.culture[key], 0) / group.length)),
  };
  return {
    personasVivas: world.people.length,
    comunidadesRegistradas: world.communities.length,
    comunidadesConMiembrosVivos: communities.length,
    personasConComunidad: communities.reduce((sum, group) => sum + group.length, 0),
    cultura: byKey,
  };
}

function sourceDigest(): string {
  const hash = createHash('sha256');
  for (const dir of ['src/world', 'src/server', 'src/shared', 'scripts/lab']) {
    const directory = join(ROOT, dir);
    for (const name of readdirSync(directory).filter(name => /\.(ts|mts)$/.test(name)).sort()) {
      const relative = `${dir}/${name}`;
      hash.update(relative).update('\0').update(readFileSync(join(directory, name))).update('\0');
    }
  }
  return hash.digest('hex');
}

function sha256(data: string): string { return createHash('sha256').update(data).digest('hex'); }

function main(): void {
  const { brazo, seed, salida } = argumentsOf(process.argv.slice(2));
  const outDir = join(salida, brazo, String(seed));
  if (existsSync(outDir)) throw new Error(`La salida ya existe; se preserva: ${outDir}`);
  const params = parseParams({ cultura: brazo === 'control'
    ? { variacion: 0, adaptacion: 0 }
    : { variacion: 0.05, adaptacion: 0.5 } }, hostParams());
  // El Store solo existe dentro de un directorio nuevo y aislado; nunca lee CARTA_DATA_DIR heredado.
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-cult-var-'));
  process.env.CARTA_DATA_DIR = dataDir;
  let store: Store | undefined;
  try {
    store = new Store(join(dataDir, 'world.sqlite'));
    const world = createWorld(seed, params);
    store.save(world); // activa el catálogo SQLite antes de simular, igual que replica.ts
    const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const codigoSha256 = sourceDigest(); // también identifica cambios sin commit en las fuentes
    mkdirSync(outDir, { recursive: true });
    const files: { archivo: string; sha256: string }[] = [];
    let prevBirths = world.totals.births ?? 0, prevDeaths = world.demographyDynamics.deaths;
    for (let tick = 1; tick <= DAYS * TICKS_PER_DAY; tick++) {
      stepWorld(world);
      if (tick % params.persistencia.cadaTicks === 0) store.save(world);
      if (tick % TICKS_PER_DAY !== 0) continue;
      if (tick % params.persistencia.cadaTicks !== 0) store.save(world);
      assertWorld(world);
      const births = world.totals.births ?? 0, deaths = world.demographyDynamics.deaths;
      const day = tick / TICKS_PER_DAY;
      const body = {
        brazo, seed, dia: day, tick,
        ...cultureMetrics(world),
        nacimientosDia: births - prevBirths, muertesDia: deaths - prevDeaths,
        nacimientosAcumulados: births, muertesAcumuladas: deaths,
      };
      prevBirths = births; prevDeaths = deaths;
      const archivo = `dia-${String(day).padStart(3, '0')}.json`;
      const json = JSON.stringify(body, null, 2) + '\n';
      writeFileSync(join(outDir, archivo), json, { flag: 'wx' });
      files.push({ archivo, sha256: sha256(json) });
    }
    const manifest = {
      sonda: 'CULT-VAR', schemaVersion: 1, brazo, seed, dias: DAYS,
      ticksPorDia: TICKS_PER_DAY,
      formulas: {
        personas: 'Todas las personas vivas, incluidas S e I; media = suma(x)/n; varianza poblacional = suma((x-media)^2)/n.',
        comunidades: 'Para cada communityId con al menos un miembro vivo se calcula la media de sus miembros vivos. La media y varianza entre comunidades dan igual peso a cada comunidad; personas sin communityId se excluyen. Con n=0 ambas son null.',
        conteos: 'Nacimientos y muertes diarios = diferencia de acumulados al cierre de cada dia. Comunidades registradas = world.communities.length; con miembros vivos = IDs distintos observados.',
      },
      persistencia: 'Store SQLite temporal desde tick 0; guardado cada persistencia.cadaTicks y al cierre diario; sin gobernador de reloj.',
      params, gitCommit, codigoSha256, digestoMundoFinal: digestoCanonico(world), archivos: files,
    };
    writeFileSync(join(outDir, 'manifiesto.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    console.log(`Sonda completa: ${brazo} ${seed}, ${DAYS} días. ${outDir}`);
  } finally {
    store?.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

try { main(); } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
