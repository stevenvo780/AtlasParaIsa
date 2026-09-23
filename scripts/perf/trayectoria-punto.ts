/**
 * ¿Da `motor.clonPorPaso=false` el mismo mundo que `true`? Dos servidores reales (`createApp` con
 * `stepOnce` manual y Store en disco temporal) generan el mismo mundo nuevo con la receta de
 * producción (`PRODUCTION_PARAMS` sobre `DEFAULT_PARAMS`, reglas 10) y avanzan a la par; solo
 * cambia cómo se reserva la vuelta atrás del paso.
 *
 *   TMPDIR=/datos/tmp-atlas-lab npx tsx scripts/perf/trayectoria-punto.ts --seed S \
 *       [--cortes 2400,4800] [--cada 600] [--salida j.json]
 *
 * El presupuesto del gobernador sube a 5000 ms: es el único punto por el que el reloj de pared
 * entra en el mundo, y con dos motores de velocidad distinta la divergencia que se mediría sería
 * la del host. `digestoCanonico` incluye los params efectivos, así que se compara cada mundo con
 * `motor.clonPorPaso` igualado (cualquier otra diferencia de params sigue contando). Al final
 * también se compara lo DURABLE: lo que cada Store devuelve con `load()`.
 * La CPU propia de cada `stepOnce` se atribuye a su servidor y el orden se alterna en cada paso.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.js';
import { PRODUCTION_PARAMS } from '../../src/server/deployment-params.js';
import { Store } from '../../src/server/store.js';
import { cloneWorld, type World } from '../../src/world/index.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { DEFAULT_PARAMS, paramsOf, parseParams, setParams } from '../../src/world/params.js';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}
const cpuMs = (): number => { const { user, system } = process.cpuUsage(); return (user + system) / 1000; };
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const media = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const p95 = (xs: number[]): number => { const o = [...xs].sort((a, b) => a - b); return o.length ? o[Math.floor(o.length * 0.95)]! : NaN; };

const seed = Number(arg('--seed')), salida = arg('--salida');
const cortes = (arg('--cortes') ?? '2400,4800').split(',').map(Number).sort((a, b) => a - b);
const cada = Number(arg('--cada') ?? 600);
if (!Number.isInteger(seed) || cortes.some(c => !Number.isInteger(c) || c <= 0) || !(cada > 0)) {
  throw new Error('Uso: trayectoria-punto.ts --seed S [--cortes 2400,4800] [--cada 600] [--salida json]');
}
if (!process.env.TMPDIR || process.env.TMPDIR.startsWith('/tmp')) {
  throw new Error('TMPDIR debe apuntar fuera de /tmp (cuota): TMPDIR=/datos/tmp-atlas-lab');
}

/** El mundo sin la elección de motor: la misma clave para los dos caminos. */
function digestoDelMundo(world: World): string {
  const copia = cloneWorld(world), params = paramsOf(world);
  setParams(copia, { ...params, motor: { ...params.motor, clonPorPaso: true } });
  return digestoCanonico(copia);
}

const dir = mkdtempSync(join(tmpdir(), 'atlas-trayectoria-punto-'));
const lados = [true, false].map(clonPorPaso => {
  const store = new Store(join(dir, `${clonPorPaso ? 'clon' : 'punto'}.sqlite`));
  const params = parseParams(`${PRODUCTION_PARAMS},gobernador.presupuestoMs=5000,motor.clonPorPaso=${clonPorPaso}`, DEFAULT_PARAMS);
  const app = createApp({ store, origin: 'http://127.0.0.1:9', password: 'trayectoria-punto', manual: true, seed, params });
  return { clonPorPaso, store, app, cpu: [] as number[], reserva: [] as number[], simulacion: [] as number[] };
});
try {
  const [clon, punto] = lados as [typeof lados[0], typeof lados[0]];
  const comparaciones: { paso: number; poblacion: number; digesto: string; identico: boolean }[] = [];
  const ultimo = cortes[cortes.length - 1]!;
  const inicio = cpuMs();
  for (let paso = 1; paso <= ultimo; paso++) {
    for (const lado of paso % 2 ? [clon, punto] : [punto, clon]) {
      const t0 = cpuMs();
      lado.app.stepOnce();
      lado.cpu.push(cpuMs() - t0);
      lado.reserva.push(lado.app.runtime.cloneMs ?? 0); lado.simulacion.push(lado.app.runtime.simulationMs ?? 0);
      if (lado.app.failed) throw new Error(`El servidor ${lado.clonPorPaso ? 'con clon' : 'con punto'} se pausó en el paso ${paso}`);
    }
    if (paso % cada === 0 || cortes.includes(paso)) {
      const a = digestoDelMundo(clon.app.world), b = digestoDelMundo(punto.app.world);
      comparaciones.push({ paso, poblacion: punto.app.world.people.length, digesto: b, identico: a === b });
      console.error(`paso ${paso}: población ${punto.app.world.people.length} ${a === b ? 'idéntico' : `DIVERGE ${a} ≠ ${b}`}`
        + ` cpu ${Math.round((cpuMs() - inicio) / 1000)} s`);
      if (a !== b) break;
    }
  }
  const durables = lados.map(lado => { const cargado = lado.store.load(); return cargado ? digestoDelMundo(cargado.world) : null; });
  const gobernador = lados.map(lado => lado.app.runtime.gobernador);
  const informe = (lado: typeof clon) => {
    const cola = (xs: number[]) => xs.slice(-Math.min(600, xs.length));
    return { cpuMsPorPaso: r3(media(lado.cpu)), cpuMsP95: r3(p95(lado.cpu)), reservaMsMedia: r3(media(lado.reserva)),
      simulacionMsMedia: r3(media(lado.simulacion)), ultimos600: { cpuMsPorPaso: r3(media(cola(lado.cpu))),
        reservaMsMedia: r3(media(cola(lado.reserva))), simulacionMsMedia: r3(media(cola(lado.simulacion))) } };
  };
  const resultado = {
    seed, params: `${PRODUCTION_PARAMS},gobernador.presupuestoMs=5000 sobre DEFAULT_PARAMS`, cortes, comparaciones,
    identico: comparaciones.length > 0 && comparaciones.every(c => c.identico) && comparaciones[comparaciones.length - 1]!.paso === ultimo,
    durableIdentico: durables[0] !== null && durables[0] === durables[1], durable: durables[1],
    gobernadorVerde: gobernador.every(g => g?.techo === null && g?.activo === true),
    clon: informe(clon), punto: informe(punto),
  };
  const texto = JSON.stringify(resultado, null, 2);
  if (salida) writeFileSync(salida, texto + '\n');
  console.log(texto);
  if (!resultado.identico || !resultado.durableIdentico) process.exitCode = 1;
} finally {
  for (const lado of lados) { await lado.app.close(); lado.store.close(); }
  rmSync(dir, { recursive: true, force: true });
}
