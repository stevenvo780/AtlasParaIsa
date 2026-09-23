/**
 * Retención del archivo de recibos sobre una copia del mundo público (sprint noche-arch 2026-09-23): coste de
 * carga y guardados, poda por guardado, tamaño y digestos canónicos. Corre igual en el árbol base (sin
 * retención) y en la rama: los digestos de cada guardado tienen que coincidir.
 *
 *   TMPDIR=/datos/tmp-atlas-lab nice -n 10 npx tsx scripts/perf/retencion-publico.ts --db <copia.sqlite> \
 *     [--pasos 1200] [--sesion-antes K]… [--conservar <ruta>] [--salida json]
 *
 * - Copia la base a un directorio propio bajo `$TMPDIR` (nunca escribe el original). `--conservar` deja la copia
 *   de trabajo final en esa ruta (p. ej. para medir una segunda carga del archivo ya podado).
 * - Régimen de `main.ts`/`app.ts`: `new Store` → `load()` → `save(world)` (primer guardado) → params del
 *   despliegue encima de los de la instantánea (`deploymentParams`) → `stepWorld` y `save` cada
 *   `persistencia.cadaTicks` pasos.
 * - `--sesion-antes K`: `addSession` antes del guardado K del bucle (1 = el primero), como un inicio de sesión.
 * - Por guardado: reloj de pared, CPU del proceso, recibos retenidos, frontera de poda y `digestoCanonico`.
 */
import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { stepWorld } from '../../src/world/index.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { paramsOf, setParams } from '../../src/world/params.js';
import { deploymentParams } from '../../src/server/deployment-params.js';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}
const cpuMs = (): number => { const { user, system } = process.cpuUsage(); return (user + system) / 1000; };
const r1 = (x: number): number => Math.round(x * 10) / 10;
const origen = arg('--db'), pasos = Number(arg('--pasos') ?? 1200), salida = arg('--salida'), conservar = arg('--conservar');
const sesionAntes = new Set(process.argv.flatMap((v, i) => v === '--sesion-antes' ? [Number(process.argv[i + 1])] : []));
if (!origen || !existsSync(origen) || !Number.isSafeInteger(pasos) || pasos < 0)
  throw new Error('Uso: retencion-publico.ts --db <copia.sqlite> [--pasos N] [--sesion-antes K]… [--conservar ruta] [--salida json]');
if (!process.env.TMPDIR || process.env.TMPDIR.startsWith('/tmp'))
  throw new Error('TMPDIR debe apuntar fuera de /tmp: TMPDIR=/datos/tmp-atlas-lab');

const dir = mkdtempSync(join(tmpdir(), 'atlas-retencion-')), ruta = join(dir, 'world.sqlite');
for (const sufijo of ['', '-wal', '-shm']) if (existsSync(origen + sufijo)) copyFileSync(origen + sufijo, ruta + sufijo);
const medir = <T>(trabajo: () => T): { valor: T; paredMs: number; cpuMs: number } => {
  const pared = performance.now(), cpu = cpuMs(), valor = trabajo();
  return { valor, paredMs: r1(performance.now() - pared), cpuMs: r1(cpuMs() - cpu) };
};
const archivo = (store: Store) => {
  const fila = (sql: string) => (store.db.prepare(sql).get() ?? {}) as Record<string, number | string | null | undefined>;
  const poda = fila("SELECT value FROM metadata WHERE key='technology-pruned-v1'").value ?? null;
  return { recibos: Number(fila('SELECT COUNT(*) AS n FROM technology_executions').n),
    primeraSerie: fila('SELECT MIN(serial) AS s FROM technology_executions').s,
    ultimaSerie: fila('SELECT MAX(serial) AS s FROM technology_executions').s,
    frontera: poda === null ? null : JSON.parse(String(poda)).through as number };
};
try {
  const abrir = medir(() => new Store(ruta)), store = abrir.valor;
  const carga = medir(() => store.load());
  if (!carga.valor) throw new Error('La base no tiene mundo');
  const world = carga.valor.world;
  const inicial = { tick: world.tick, poblacion: world.people.length, executionCounter: world.technology.executionCounter,
    digesto: digestoCanonico(world), archivo: archivo(store), bytes: statSync(ruta).size };
  console.log(`carga: ${carga.paredMs} ms pared, ${carga.cpuMs} ms cpu; ${JSON.stringify(inicial)}`);
  const primero = medir(() => store.save(world));
  setParams(world, deploymentParams(paramsOf(world)));
  const cadencia = paramsOf(world).persistencia.cadaTicks;
  console.log(`primer guardado: ${primero.paredMs} ms pared, ${primero.cpuMs} ms cpu; ${JSON.stringify(archivo(store))}`);
  const guardados: Record<string, unknown>[] = [];
  const context = store.context;
  let pasoCpu = 0, pasoPared = 0, k = 0;
  for (let n = 1; n <= pasos; n++) {
    const pared = performance.now(), cpu = cpuMs();
    stepWorld(world, [], context);
    pasoCpu += cpuMs() - cpu; pasoPared += performance.now() - pared;
    if (world.tick % cadencia !== 0) continue;
    k++;
    if (sesionAntes.has(k)) store.addSession(`retencion-${k}`.padEnd(64, '0'), Date.now() + 60_000);
    const guardado = medir(() => store.save(world));
    const fila = { k, tick: world.tick, paredMs: guardado.paredMs, cpuMs: guardado.cpuMs, sesion: sesionAntes.has(k),
      digesto: digestoCanonico(world), ...archivo(store) };
    guardados.push(fila);
    console.log(JSON.stringify(fila));
  }
  const final = { tick: world.tick, poblacion: world.people.length, digesto: digestoCanonico(world), archivo: archivo(store),
    pasoCpuMsMedio: r1(pasoCpu / Math.max(1, pasos)), pasoParedMsMedio: r1(pasoPared / Math.max(1, pasos)) };
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  store.close();
  const bytes = statSync(ruta).size;
  const informe = { origen, pasos, cadencia, abrirMs: abrir.paredMs, carga: { paredMs: carga.paredMs, cpuMs: carga.cpuMs },
    primerGuardado: { paredMs: primero.paredMs, cpuMs: primero.cpuMs }, inicial, guardados, final: { ...final, bytes } };
  if (salida) writeFileSync(salida, JSON.stringify(informe, null, 1));
  console.log(`final: ${JSON.stringify(informe.final)}`);
  if (conservar) { renameSync(ruta, conservar); }
} finally { rmSync(dir, { recursive: true, force: true }); }
