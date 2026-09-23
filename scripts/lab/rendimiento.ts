/**
 * Laboratorio — control de identidad y perfil de CPU del paso (sprint noche-perf 2026-09-22).
 *
 * Tres subcomandos, todos con el mismo régimen que `replica.ts` (Store temporal guardado antes
 * del primer tick y cada `persistencia.cadaTicks` ticks; sin gobernador):
 *
 *   digestos    [--pasos 1200,2400]
 *       `digestoCanonico` tras cada número de pasos, en las tres semillas de control
 *       (51926 y 7 con LEYES_CANDIDATAS, 42 con los params HISTÓRICOS). Es lo que fija
 *       `tests/rendimiento-identidad.test.ts`. Reglas 10, etapa 1: el control se mide sobre
 *       `HISTORICAL_PARAMS` (el mundo de antes); LEYES_CANDIDATAS nombra las cinco leyes adoptadas,
 *       así que con ellas el mundo es el mismo sobre la base histórica o sobre los defaults nuevos.
 *   instantanea --seed S [--params P] --dias D --salida DIR
 *       Avanza D días y deja en DIR la base SQLite (con el mundo guardado en el último tick) y
 *       `meta.json` con el digesto del mundo en memoria.
 *   perfil      --desde DIR [--pasos N]
 *       Copia la base de DIR a un directorio temporal, carga el mundo, comprueba que su digesto
 *       coincide con el de `meta.json` y avanza N pasos midiendo CPU propia del proceso
 *       (`process.cpuUsage`, no reloj de pared: la torre está cargada) por fase de `stepWorld`.
 *       Imprime JSON con CPU por paso por fase, el digesto cada 1200 pasos y el final.
 *
 * Para perfil por función: `node --cpu-prof --import tsx scripts/lab/rendimiento.ts perfil ...`.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../../src/server/store.js';
import { createWorld, stepWorld, TICKS_PER_DAY, type FaseMedicion, type World } from '../../src/world/index.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { HISTORICAL_PARAMS, paramsOf, parseParams, setParams, type WorldParams } from '../../src/world/params.js';

export const LEYES_CANDIDATAS = 'persistencia.cadaTicks=300,poblacion.cortejo=2,poblacion.radioCortejo=128,poblacion.exigeComunidad=false,poblacion.comprobacionContinua=true,conducta.habituacion=0.35';
export const SEMILLAS_CONTROL: readonly { seed: number; params?: string }[] = [
  { seed: 51926, params: LEYES_CANDIDATAS }, { seed: 7, params: LEYES_CANDIDATAS }, { seed: 42 },
];

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const cpuMs = (): number => { const { user, system } = process.cpuUsage(); return (user + system) / 1000; };

/** Un paso del laboratorio: `stepWorld` y, por cadencia, `store.save` (como replica.ts sin gobernador). */
function paso(world: World, store: Store, medicion?: FaseMedicion): void {
  stepWorld(world, [], undefined, medicion);
  if (world.tick % paramsOf(world).persistencia.cadaTicks === 0) store.save(world);
}

/** `digestoCanonico` con las claves `sin` (`seccion.hoja`) quitadas de la FORMA de params sólo al hashear.
 * `digestoCanonico` hashea `{world, params}`, así que declarar una clave nueva mueve el hash aunque el mundo
 * no se mueva (T102). Así se comparan con hashes medidos en un árbol que aún no la declaraba.
 * `versionReferencia` normaliza sólo la etiqueta para comparar controles de otra versión; omitida,
 * el digesto conserva exactamente la versión actual. */
export function digestoSin(world: World, sin: readonly string[], versionReferencia?: number): string {
  const vigentes = paramsOf(world), forma = structuredClone(vigentes) as unknown as Record<string, Record<string, unknown>>;
  for (const clave of sin) {
    const [seccion, hoja] = clave.split('.') as [string, string];
    if (!forma[seccion] || !Object.hasOwn(forma[seccion]!, hoja)) throw new Error(`sin: la clave ${clave} no existe en este árbol`);
    delete forma[seccion]![hoja];
  }
  const version = world.version;
  if (sin.length > 0) setParams(world, forma as unknown as WorldParams);
  // Sólo los controles V10 pasan versionReferencia: la etiqueta cambia el hash, no el estado medido.
  if (versionReferencia !== undefined) world.version = versionReferencia;
  try { return digestoCanonico(world); } finally { world.version = version; if (sin.length > 0) setParams(world, vigentes); }
}

/** Digestos tras cada corte de `pasos` desde `createWorld(seed, params)` con Store temporal. Los
 * `params` se aplican sobre `HISTORICAL_PARAMS`: sin ellos, el control es el mundo de antes.
 * `sin`: claves que no entran en el hash (ver `digestoSin`). `versionReferencia` sólo afecta
 * al cálculo del hash, nunca a la simulación ni al guardado. */
export function digestosControl(seed: number, params: string | undefined, cortes: readonly number[],
  sin: readonly string[] = [], versionReferencia?: number): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-rendimiento-'));
  const store = new Store(join(dir, 'world.sqlite'));
  try {
    const world = createWorld(seed, parseParams(params, HISTORICAL_PARAMS));
    store.save(world);
    const salida: Record<string, string> = {}, fin = Math.max(...cortes);
    for (let n = 1; n <= fin; n++) {
      paso(world, store);
      if (cortes.includes(n)) salida[String(n)] = digestoSin(world, sin, versionReferencia);
    }
    return salida;
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

function digestos(): void {
  const cortes = (arg('--pasos') ?? '1200,2400').split(',').map(Number);
  const resultado = SEMILLAS_CONTROL.map(({ seed, params }) => {
    const started = cpuMs();
    const digestos = digestosControl(seed, params, cortes);
    return { seed, params: params ?? 'historicos', digestos, cpuS: Math.round(cpuMs() - started) / 1000 };
  });
  console.log(JSON.stringify(resultado, null, 2));
}

function instantanea(): void {
  const seed = Number(arg('--seed') ?? 51926), dias = Number(arg('--dias') ?? 6), salida = arg('--salida');
  if (!salida) throw new Error('Falta --salida');
  const params = arg('--params') ?? LEYES_CANDIDATAS;
  mkdirSync(salida, { recursive: true });
  const dbPath = join(salida, 'world.sqlite');
  if (existsSync(dbPath)) throw new Error(`${dbPath} ya existe`);
  const store = new Store(dbPath);
  try {
    const world = createWorld(seed, parseParams(params));
    store.save(world);
    const total = Math.round(dias * TICKS_PER_DAY);
    for (let n = 1; n <= total; n++) {
      paso(world, store);
      if (n % 1200 === 0) console.error(`tick ${world.tick} población ${world.people.length}`);
    }
    store.save(world);
    writeFileSync(join(salida, 'meta.json'), JSON.stringify({ seed, params, tick: world.tick, poblacion: world.people.length, digesto: digestoCanonico(world) }, null, 2) + '\n');
  } finally { store.close(); }
}

function perfil(): void {
  const desde = arg('--desde'), pasos = Number(arg('--pasos') ?? 1200);
  if (!desde) throw new Error('Falta --desde');
  const meta = JSON.parse(readFileSync(join(desde, 'meta.json'), 'utf8')) as { digesto: string; tick: number };
  const dir = mkdtempSync(join(tmpdir(), 'atlas-perfil-'));
  for (const sufijo of ['', '-wal', '-shm']) if (existsSync(join(desde, `world.sqlite${sufijo}`))) copyFileSync(join(desde, `world.sqlite${sufijo}`), join(dir, `world.sqlite${sufijo}`));
  const store = new Store(join(dir, 'world.sqlite'));
  try {
    const loaded = store.load();
    if (!loaded) throw new Error('La instantánea no tiene mundo');
    const world = loaded.world;
    const digestoInicial = digestoCanonico(world);
    if (digestoInicial !== meta.digesto) throw new Error(`El mundo cargado no es el guardado: ${digestoInicial} ≠ ${meta.digesto}`);
    const poblacionInicial = world.people.length;
    const medicion: FaseMedicion = { clock: cpuMs, fases: {} };
    const acumulado: Record<string, number> = {};
    let pasoCpu = 0, saveCpu = 0;
    const digestos: Record<string, string> = {};
    for (let n = 0; n < pasos; n++) {
      medicion.fases = {};
      const a = cpuMs();
      stepWorld(world, [], undefined, medicion);
      const b = cpuMs();
      pasoCpu += b - a;
      for (const [fase, ms] of Object.entries(medicion.fases)) acumulado[fase] = (acumulado[fase] ?? 0) + ms!;
      if (world.tick % paramsOf(world).persistencia.cadaTicks === 0) { store.save(world); saveCpu += cpuMs() - b; }
      if ((n + 1) % 1200 === 0) digestos[String(n + 1)] = digestoCanonico(world);
    }
    const porPaso = Object.fromEntries(Object.entries(acumulado).sort((x, y) => y[1] - x[1]).map(([fase, ms]) => [fase, Math.round(ms / pasos * 1000) / 1000]));
    console.log(JSON.stringify({ desdeTick: meta.tick, pasos, poblacionInicial, poblacionFinal: world.people.length,
      cpuMsPorPaso: Math.round(pasoCpu / pasos * 1000) / 1000, saveCpuMsPorPaso: Math.round(saveCpu / pasos * 1000) / 1000,
      fasesCpuMsPorPaso: porPaso, digestos, digestoFinal: digestoCanonico(world) }, null, 2));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

// Sólo como programa: `tests/rendimiento-identidad.test.ts` importa `digestosControl` sin ejecutar nada.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const comando = process.argv[2];
  if (comando === 'digestos') digestos();
  else if (comando === 'instantanea') instantanea();
  else if (comando === 'perfil') perfil();
  else throw new Error('Uso: rendimiento.ts digestos|instantanea|perfil …');
}
