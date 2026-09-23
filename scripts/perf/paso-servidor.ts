/**
 * PERF3 — el paso del SERVIDOR (`createApp`, el mismo `stepOnce` que producción) con reloj real:
 * cuánto tarda y qué mundo deja. Sirve a la vez de banco y de control de identidad.
 *
 *   TMPDIR=/datos/tmp-atlas-lab npx tsx scripts/perf/paso-servidor.ts (--db <world.sqlite> | --seed S)
 *       [--pasos 600] [--gestos K] [--cada 100] [--presupuesto 5000] [--planificado] [--salida j.json]
 *
 * · `--db`: se trabaja sobre una copia en TMPDIR (el original solo se lee) y, como `main.ts`, los
 *   params de la instantánea con los del despliegue encima (`deploymentParams`). `--seed`: mundo nuevo
 *   con la receta de producción sobre `DEFAULT_PARAMS`, como `trayectoria-punto.ts`.
 * · `--gestos K`: un gesto `plant` real (HTTP, sesión propia) cada K pasos, junto a la primera persona.
 *   Cada resultado debe llevar el paso previsto; si no, el banco falla en vez de comparar entradas
 *   distintas. Sin `--gestos` el paso nunca lleva gestos.
 * · `--cada C`: `digestoCanonico` del mundo cada C pasos (0: solo al final), fuera de la medida.
 *   Al final, también el digesto de lo DURABLE (`store.load()`).
 * · `--presupuesto`: el del gobernador; 5000 por defecto porque es el único punto por el que el reloj
 *   de pared entra en el mundo y dos motores de velocidad distinta divergirían por el host.
 * · `--planificado`: en vez de `stepOnce` seguido, el planificador real (`tickMs` 100) hasta `--pasos`
 *   pasos; mide pasos por segundo de pared tal como los da el servidor.
 *
 * Para comparar con la base, este script se copia a un `git archive` del commit base y se corre allí con
 * los mismos argumentos: los digestos deben ser idénticos. Al cargar, `createApp` añade a la crónica un
 * suceso de pausa con 12 caracteres de `makeToken()`; durante `createApp` el generador se fija aquí
 * (`syncBuiltinESMExports`) para que dos procesos partan del mismo mundo. No cambia nada más.
 */
import crypto from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.js';
import { PRODUCTION_PARAMS, deploymentParams } from '../../src/server/deployment-params.js';
import { Store } from '../../src/server/store.js';
import type { GestureResult } from '../../src/shared/types.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { DEFAULT_PARAMS, paramsOf, parseParams, setParams } from '../../src/world/params.js';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}
const db = arg('--db'), seed = arg('--seed') === undefined ? undefined : Number(arg('--seed'));
const pasos = Number(arg('--pasos') ?? 600), gestos = Number(arg('--gestos') ?? 0), cada = Number(arg('--cada') ?? 100);
const presupuesto = Number(arg('--presupuesto') ?? 5000), planificado = process.argv.includes('--planificado'), salida = arg('--salida');
if ((db === undefined) === (seed === undefined) || (db !== undefined && !existsSync(db)) || (seed !== undefined && !Number.isInteger(seed))
  || !(pasos > 0) || !Number.isInteger(gestos) || gestos < 0 || !Number.isInteger(cada) || cada < 0 || !(presupuesto > 0)
  || (planificado && gestos)) {
  throw new Error('Uso: paso-servidor.ts (--db <world.sqlite> | --seed S) [--pasos N] [--gestos K] [--cada C] [--presupuesto ms]'
    + ' [--planificado] [--salida json]');
}
if (!process.env.TMPDIR || process.env.TMPDIR.startsWith('/tmp')) {
  throw new Error('TMPDIR debe apuntar fuera de /tmp (cuota): TMPDIR=/datos/tmp-atlas-lab');
}

const cpuMs = (): number => { const { user, system } = process.cpuUsage(); return (user + system) / 1000; };
const r2 = (x: number): number => Math.round(x * 100) / 100;
const cuantil = (xs: number[], q: number): number => {
  const o = [...xs].sort((a, b) => a - b); return o.length ? o[Math.min(o.length - 1, Math.floor(o.length * q))]! : NaN;
};
const media = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const resumen = (xs: number[]) => ({ media: r2(media(xs)), p50: r2(cuantil(xs, 0.5)), p95: r2(cuantil(xs, 0.95)),
  max: r2(Math.max(...xs)) });
const esperar = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** `createApp` con el generador de `node:crypto` fijado: el suceso de pausa de un mundo cargado es el mismo en todo proceso. */
function conAzarFijo<T>(crear: () => T): T {
  const original = crypto.randomBytes;
  let n = 0;
  crypto.randomBytes = ((size: number) => Buffer.alloc(size, ++n)) as typeof crypto.randomBytes;
  syncBuiltinESMExports();
  try { return crear(); } finally { crypto.randomBytes = original; syncBuiltinESMExports(); }
}

const dir = mkdtempSync(join(tmpdir(), 'atlas-paso-servidor-'));
let store: Store | undefined, app: ReturnType<typeof createApp> | undefined;
try {
  if (db) for (const sufijo of ['', '-wal', '-shm']) {
    if (!existsSync(db + sufijo)) continue;
    copyFileSync(db + sufijo, join(dir, 'world.sqlite' + sufijo)); chmodSync(join(dir, 'world.sqlite' + sufijo), 0o600);
  }
  store = new Store(join(dir, 'world.sqlite'));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, password = 'perf3-banco-paso-servidor';
  const cargaInicio = performance.now();
  const nuevo = seed === undefined ? {}
    : { seed, params: parseParams(`${PRODUCTION_PARAMS},gobernador.presupuestoMs=${presupuesto}`, DEFAULT_PARAMS) };
  app = conAzarFijo(() => createApp({ store: store!, origin, password, manual: !planificado, tickMs: 100, ...nuevo }));
  const cargaMs = performance.now() - cargaInicio;
  // Como `main.ts`: el despliegue manda sobre los params de la instantánea (y el presupuesto de este banco encima).
  if (db) setParams(app.world, parseParams(`gobernador.presupuestoMs=${presupuesto}`, deploymentParams(paramsOf(app.world))));
  const tickInicial = app.world.tick, poblacionInicial = app.world.people.length, teselas = app.world.tiles.length;
  const digestoInicial = digestoCanonico(app.world);

  let cookie = '';
  if (gestos) {
    app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
    const login = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }) });
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  }
  const medidas = { stepMs: [] as number[], cloneMs: [] as number[], simulationMs: [] as number[], saveMs: [] as number[],
    cpuMs: [] as number[] };
  const digestos: { paso: number; tick: number; poblacion: number; digesto: string }[] = [];
  const resultados: { paso: number; tick: number; aceptado: boolean }[] = [];
  let muroMs = 0;
  if (!planificado) {
    for (let paso = 1; paso <= pasos; paso++) {
      let respuesta: Promise<Response> | null = null;
      if (gestos && paso % gestos === 0) {
        const persona = app.world.people[0]!;
        const gesto = { id: `perf3-gesto-${String(paso).padStart(6, '0')}`, kind: 'plant',
          x: Math.round(persona.x) + 1, y: Math.round(persona.y) };
        respuesta = fetch(origin + '/api/gesture', { method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(gesto) });
        // El gesto tiene que estar en el lote de ESTE paso. `gestosPendientes` (PERF3) lo dice; un árbol
        // anterior no lo tiene y se le da tiempo. En los dos casos se comprueba después con el paso del resultado.
        const pendientes = (): number | undefined => (app as { gestosPendientes?: number }).gestosPendientes;
        if (pendientes() !== undefined) {
          const limite = performance.now() + 10_000;
          while (pendientes() === 0 && performance.now() < limite) await esperar(1);
        }
        else { for (let w = 0; w < 40; w++) await new Promise<void>(resolve => setImmediate(resolve)); await esperar(50); }
      }
      const t0 = performance.now(), c0 = cpuMs();
      app.stepOnce();
      const c1 = cpuMs(); muroMs += performance.now() - t0;
      if (app.failed) throw new Error(`El servidor se pausó en el paso ${paso}`);
      const rt = app.runtime;
      medidas.stepMs.push(rt.stepMs); medidas.cloneMs.push(rt.cloneMs ?? 0); medidas.simulationMs.push(rt.simulationMs ?? 0);
      medidas.saveMs.push(rt.saveMs); medidas.cpuMs.push(c1 - c0);
      if (respuesta) {
        // Un gesto que no entró en este paso esperaría al siguiente, que nunca llega: se corta con un error.
        let reloj: ReturnType<typeof setTimeout> | undefined;
        const tarde = new Promise<never>((_, no) => {
          reloj = setTimeout(() => no(new Error(`El gesto del paso ${paso} no entró en su paso`)), 10_000);
        });
        const r = await Promise.race([respuesta, tarde]).finally(() => clearTimeout(reloj));
        const cuerpo = await r.json() as Partial<GestureResult>;
        resultados.push({ paso, tick: cuerpo.tick ?? -1, aceptado: cuerpo.accepted === true });
        if (r.status !== 200 || cuerpo.tick !== app.world.tick) {
          throw new Error(`El gesto del paso ${paso} no entró en su paso (HTTP ${r.status}, tick ${cuerpo.tick} ≠ ${app.world.tick})`);
        }
      }
      if (cada && paso % cada === 0) {
        digestos.push({ paso, tick: app.world.tick, poblacion: app.world.people.length, digesto: digestoCanonico(app.world) });
      }
    }
  } else {
    // El planificador cita los pasos solo; aquí se espera a que den `pasos` y se mide el reloj de pared.
    const t0 = performance.now(), objetivo = tickInicial + pasos;
    while (app.world.tick < objetivo && !app.failed) await esperar(20);
    muroMs = performance.now() - t0;
    if (app.failed) throw new Error('El servidor se pausó');
  }
  const final = { tick: app.world.tick, poblacion: app.world.people.length, digesto: digestoCanonico(app.world) };
  const rt = app.runtime;
  await app.close(); app = undefined;
  const cargado = store.load();
  const durable = cargado ? { tick: cargado.world.tick, digesto: digestoCanonico(cargado.world) } : null;
  const resultado = {
    codigo: process.cwd(), origen: db ?? `semilla ${seed}`, planificado, pasos, gestos, cada, presupuestoMs: presupuesto,
    cargaMs: r2(cargaMs), tickInicial, poblacionInicial, teselas, digestoInicial,
    ...(planificado ? { pasosPorSegundo: r2(pasos / (muroMs / 1000)), tickHzServidor: r2(rt.tickHz), p95StepMsServidor: r2(rt.p95StepMs) }
      : {
      pasosPorSegundoSeguidos: r2(pasos / (muroMs / 1000)),
      stepMs: resumen(medidas.stepMs), cloneMs: resumen(medidas.cloneMs), simulationMs: resumen(medidas.simulationMs),
      saveMs: resumen(medidas.saveMs), guardados: medidas.saveMs.filter(x => x > 0).length, cpuMsPorPaso: resumen(medidas.cpuMs),
    }),
    gestosAplicados: resultados.length, resultados: resultados.slice(0, 4), digestos, final, durable,
  };
  const texto = JSON.stringify(resultado, null, 2);
  if (salida) writeFileSync(salida, texto + '\n');
  console.log(texto);
} finally {
  if (app) await app.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
}
