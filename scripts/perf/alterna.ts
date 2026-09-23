/**
 * Base contra rama en el MISMO proceso, por bloques alternados (sprint noche-perf2 2026-09-22).
 *
 *   TMPDIR=/datos/tmp-atlas-lab npx tsx scripts/perf/alterna.ts --base <árbol base> --db <world.sqlite>
 *       [--pasos 600] [--bloque 50] [--salida j.json]
 *
 * `--base` es un `git archive` del commit base con `node_modules` enlazado (p. ej.
 * /datos/tmp-atlas-lab/perf2-base). Se importan dos grafos de módulos independientes —el del árbol
 * base y el de este árbol—, cada uno carga su propia copia de la base (el original no se escribe) y
 * avanzan por bloques alternados de `--bloque` pasos con el régimen de `replica.ts` (`stepWorld` y
 * `store.save` cada `persistencia.cadaTicks`). La CPU propia (`process.cpuUsage`) de cada bloque se
 * atribuye a su árbol: base y rama sufren la misma carga de la torre, bloque a bloque, en vez de dos
 * corridas separadas cuya carga cambia. El orden dentro de cada par de bloques se alterna.
 *
 * Al final exige que los dos mundos tengan el mismo `digestoCanonico` (control de identidad) e
 * imprime CPU por paso (paso y guardado), por fase y la razón base/rama.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FaseMedicion, World } from '../../src/world/index.js';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}
const cpuMs = (): number => { const { user, system } = process.cpuUsage(); return (user + system) / 1000; };
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

const base = arg('--base'), db = arg('--db'), pasos = Number(arg('--pasos') ?? 600), bloque = Number(arg('--bloque') ?? 50), salida = arg('--salida');
if (!base || !db || !existsSync(db) || !existsSync(join(base, 'src/world/index.ts'))) throw new Error('Uso: alterna.ts --base <árbol> --db <world.sqlite> [--pasos N] [--bloque B] [--salida json]');
if (!process.env.TMPDIR || process.env.TMPDIR.startsWith('/tmp')) throw new Error('TMPDIR debe apuntar fuera de /tmp (cuota): TMPDIR=/datos/tmp-atlas-lab');

interface Arbol {
  nombre: string; world: World; store: { save(world: World): void; close(): void };
  stepWorld: (world: World, inputs: [], context: undefined, medicion: FaseMedicion) => void;
  digesto: (world: World) => string; cadaTicks: (world: World) => number;
  pasoCpu: number; saveCpu: number; fases: Record<string, number>; cargaCpu: number; dir: string;
}
async function cargar(nombre: string, raiz: string): Promise<Arbol> {
  const modulo = (ruta: string) => import(pathToFileURL(resolve(raiz, ruta)).href);
  const [{ Store }, mundo, { digestoCanonico }, { paramsOf }] = await Promise.all([
    modulo('src/server/store.ts'), modulo('src/world/index.ts'), modulo('src/world/digesto.ts'), modulo('src/world/params.ts')]);
  const dir = mkdtempSync(join(tmpdir(), `atlas-alterna-${nombre}-`));
  for (const sufijo of ['', '-wal', '-shm']) if (existsSync(db + sufijo)) copyFileSync(db + sufijo, join(dir, 'world.sqlite' + sufijo));
  const store = new Store(join(dir, 'world.sqlite'));
  const inicio = cpuMs();
  const loaded = store.load();
  if (!loaded) throw new Error('La base no tiene mundo');
  return { nombre, world: loaded.world, store, stepWorld: mundo.stepWorld, digesto: digestoCanonico,
    cadaTicks: (world: World) => paramsOf(world).persistencia.cadaTicks, pasoCpu: 0, saveCpu: 0, fases: {}, cargaCpu: cpuMs() - inicio, dir };
}

function avanzar(arbol: Arbol, n: number): void {
  const medicion: FaseMedicion = { clock: cpuMs, fases: {} };
  for (let k = 0; k < n; k++) {
    medicion.fases = {};
    const a = cpuMs();
    arbol.stepWorld(arbol.world, [], undefined, medicion);
    const b = cpuMs();
    arbol.pasoCpu += b - a;
    for (const [fase, ms] of Object.entries(medicion.fases)) arbol.fases[fase] = (arbol.fases[fase] ?? 0) + ms!;
    if (arbol.world.tick % arbol.cadaTicks(arbol.world) === 0) { arbol.store.save(arbol.world); arbol.saveCpu += cpuMs() - b; }
  }
}

const arboles = [await cargar('base', base), await cargar('rama', resolve(import.meta.dirname, '../..'))];
try {
  const [digestoBase, digestoRama] = arboles.map(arbol => arbol.digesto(arbol.world));
  if (digestoBase !== digestoRama) throw new Error(`Los mundos cargados difieren: ${digestoBase} ≠ ${digestoRama}`);
  const poblacionInicial = arboles[0]!.world.people.length, tickInicial = arboles[0]!.world.tick;
  const bloques: { hastaPaso: number; baseMs: number; ramaMs: number; razon: number }[] = [];
  for (let hecho = 0, par = 0; hecho < pasos; hecho += bloque, par++) {
    const n = Math.min(bloque, pasos - hecho), antes = arboles.map(arbol => arbol.pasoCpu);
    for (const arbol of par % 2 ? [...arboles].reverse() : arboles) avanzar(arbol, n);
    const [baseMs, ramaMs] = arboles.map((arbol, i) => (arbol.pasoCpu - antes[i]!) / n) as [number, number];
    bloques.push({ hastaPaso: hecho + n, baseMs: r3(baseMs), ramaMs: r3(ramaMs), razon: r3(baseMs / ramaMs) });
  }
  const finales = arboles.map(arbol => arbol.digesto(arbol.world));
  const resumen = Object.fromEntries(arboles.map(arbol => [arbol.nombre, {
    cargaCpuMs: Math.round(arbol.cargaCpu), cpuMsPorPaso: r3(arbol.pasoCpu / pasos), saveCpuMsPorPaso: r3(arbol.saveCpu / pasos),
    fasesCpuMsPorPaso: Object.fromEntries(Object.entries(arbol.fases).sort((x, y) => y[1] - x[1]).map(([fase, ms]) => [fase, r3(ms / pasos)])),
  }]));
  const [b, r] = arboles as [Arbol, Arbol];
  const resultado = { db, tickInicial, pasos, bloque, poblacionInicial, poblacionFinal: r.world.people.length, ...resumen,
    razonPaso: r3(b.pasoCpu / r.pasoCpu), razonPasoYGuardado: r3((b.pasoCpu + b.saveCpu) / (r.pasoCpu + r.saveCpu)),
    digestoInicial: digestoBase, digestoFinalBase: finales[0], digestoFinalRama: finales[1], identico: finales[0] === finales[1], bloques };
  const texto = JSON.stringify(resultado, null, 2);
  if (salida) writeFileSync(salida, texto + '\n');
  console.log(texto);
  if (!resultado.identico) process.exitCode = 1;
} finally { for (const arbol of arboles) { arbol.store.close(); rmSync(arbol.dir, { recursive: true, force: true }); } }
