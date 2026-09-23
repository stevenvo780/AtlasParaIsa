/**
 * ¿Lee la simulación el archivo de ejecuciones? Control empírico (sprint noche-arch 2026-09-23).
 *
 *   TMPDIR=/datos/tmp-atlas-lab nice -n 10 npx tsx scripts/perf/identidad-poda.ts --db <copia.sqlite> \
 *     --borrar ninguna|ventana|todas [--ventana 24000] [--pasos 600] [--salida json]
 *
 * Carga el mundo de una copia propia con el `Store` de hoy (verificación completa), y DESPUÉS borra de
 * `technology_executions` las filas que tocaría una poda de prefijo (`ventana`: tick <= tick − ventana) o
 * todas (`todas`); luego avanza N pasos con `stepWorld` y el contexto del Store (lecturas de recetas
 * archivadas, terreno dormido e identidades, como el servidor) y anota `digestoCanonico` cada 100 pasos.
 * No guarda: el Store de hoy exige la cobertura completa y se negaría, que es justo lo que la poda
 * propuesta cambia. Si los digestos de las tres variantes coinciden, el paso no depende de esas filas.
 * La copia se borra al terminar.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { stepWorld } from '../../src/world/index.js';
import { digestoCanonico } from '../../src/world/digesto.js';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}
const origen = arg('--db'), borrar = arg('--borrar') ?? 'ninguna', salida = arg('--salida');
const ventana = Number(arg('--ventana') ?? 24000), pasos = Number(arg('--pasos') ?? 600);
if (!origen || !existsSync(origen) || !['ninguna', 'ventana', 'todas'].includes(borrar))
  throw new Error('Uso: identidad-poda.ts --db <copia.sqlite> --borrar ninguna|ventana|todas [--ventana N] [--pasos N]');
if (!process.env.TMPDIR || process.env.TMPDIR.startsWith('/tmp'))
  throw new Error('TMPDIR debe apuntar fuera de /tmp: TMPDIR=/datos/tmp-atlas-lab');

const dir = mkdtempSync(join(tmpdir(), 'atlas-identidad-poda-'));
const ruta = join(dir, 'world.sqlite');
for (const sufijo of ['', '-wal', '-shm']) if (existsSync(origen + sufijo)) copyFileSync(origen + sufijo, ruta + sufijo);
try {
  const store = new Store(ruta);
  const loaded = store.load();
  if (!loaded) throw new Error('La base no tiene mundo');
  const world = loaded.world, digestoCarga = digestoCanonico(world), tickInicial = world.tick;
  const limite = borrar === 'todas' ? Number.MAX_SAFE_INTEGER : borrar === 'ventana' ? world.tick - ventana : -1;
  const borradas = Number(store.db.prepare('DELETE FROM technology_executions WHERE tick<=?').run(limite).changes);
  const context = store.context, digestos: Record<string, string> = {};
  for (let n = 1; n <= pasos; n++) {
    stepWorld(world, [], context);
    if (n % 100 === 0) digestos[String(n)] = digestoCanonico(world);
  }
  const quedan = Number((store.db.prepare('SELECT COUNT(*) AS n FROM technology_executions').get() as { n: number }).n);
  store.close();
  const informe = { borrar, ventana, borradas, quedan, tickInicial, digestoCarga, digestos,
    tickFinal: world.tick, poblacionFinal: world.people.length };
  console.log(JSON.stringify(informe));
  if (salida) writeFileSync(salida, JSON.stringify(informe, null, 1));
} finally { rmSync(dir, { recursive: true, force: true }); }
