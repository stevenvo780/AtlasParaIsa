/**
 * Mundos de prueba para medir cómo escala el paso con la población (sprint noche-perf2 2026-09-22).
 *
 *   tsx scripts/perf/instantaneas.ts --seed S --dias 6,9,12 --salida DIR [--params P]
 *   (`--dias` admite fracciones: 12.25 = tick 29 400, el de la copia r2/Psinagua-3)
 *
 * Una sola corrida con el régimen de `scripts/lab/replica.ts` sin gobernador (Store temporal,
 * guardado antes del primer paso y cada `persistencia.cadaTicks`). Al llegar a cada día pedido
 * guarda el mundo y deja en `DIR/dNN/world.sqlite` una copia consistente (`VACUUM INTO`) con su
 * `meta.json` (semilla, params, tick, población, digesto canónico), que `fases.ts --digesto`
 * puede exigir al cargarla. Por defecto usa las leyes candidatas del paquete de natalidad.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { createWorld, stepWorld, TICKS_PER_DAY } from '../../src/world/index.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { paramsOf, parseParams } from '../../src/world/params.js';
import { LEYES_CANDIDATAS } from '../lab/rendimiento.js';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}
const cpuMs = (): number => { const { user, system } = process.cpuUsage(); return (user + system) / 1000; };

const seed = Number(arg('--seed')), salida = arg('--salida'), params = arg('--params') ?? LEYES_CANDIDATAS;
const dias = (arg('--dias') ?? '6').split(',').map(Number).sort((a, b) => a - b);
if (!Number.isInteger(seed) || !salida || dias.some(d => !Number.isInteger(d * TICKS_PER_DAY) || d <= 0)) throw new Error('Uso: instantaneas.ts --seed S --dias 6,9,12 --salida DIR [--params P]');
if (!process.env.TMPDIR || process.env.TMPDIR.startsWith('/tmp')) throw new Error('TMPDIR debe apuntar fuera de /tmp (cuota): TMPDIR=/datos/tmp-atlas-lab');
mkdirSync(salida, { recursive: true });
const carpeta = (dia: number): string => join(salida, `d${String(dia).padStart(2, '0')}`);
for (const dia of dias) if (existsSync(carpeta(dia))) throw new Error(`Ya existe d${dia} en ${salida}`);

const dir = mkdtempSync(join(tmpdir(), 'atlas-perf2-inst-'));
const store = new Store(join(dir, 'world.sqlite'));
try {
  const world = createWorld(seed, parseParams(params));
  store.save(world);
  const inicio = cpuMs();
  let n = 0;
  for (const dia of dias) {
    for (; n < dia * TICKS_PER_DAY; n++) {
      stepWorld(world, []);
      if (world.tick % paramsOf(world).persistencia.cadaTicks === 0) store.save(world);
      if ((n + 1) % 1200 === 0) console.error(`tick ${world.tick} población ${world.people.length} cpu ${Math.round((cpuMs() - inicio) / 1000)} s`);
    }
    // El día es múltiplo de `cadaTicks` en el paquete de natalidad (300): ya se guardó en el paso.
    if (world.tick % paramsOf(world).persistencia.cadaTicks !== 0) store.save(world);
    const destino = carpeta(dia);
    mkdirSync(destino);
    store.db.exec(`VACUUM INTO '${join(destino, 'world.sqlite').replaceAll("'", "''")}'`);
    writeFileSync(join(destino, 'meta.json'), JSON.stringify({ seed, params, dia, tick: world.tick, poblacion: world.people.length, digesto: digestoCanonico(world) }, null, 2) + '\n');
    console.error(`día ${dia}: población ${world.people.length} -> ${destino}`);
  }
} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
