/**
 * Coste de reservar la vuelta atrás de un paso del servidor: `cloneWorld` (motor.clonPorPaso=true)
 * frente a `puntoDeRestauracion` (motor.clonPorPaso=false).
 *
 *   TMPDIR=/datos/tmp-atlas-lab NODE_OPTIONS=--expose-gc npx tsx scripts/perf/reserva-paso.ts \
 *       --db <world.sqlite> [--micro 30] [--pasos 200] [--bloque 10] [--salida j.json]
 *
 * Dos medidas, las dos con CPU propia del proceso (`process.cpuUsage`) y alternando el orden:
 * · paso: dos copias del mismo mundo avanzan a la par por bloques alternados de `--bloque` pasos
 *   con la receta de `stepOnce` (reserva, `stepWorld`, guardado cada `persistencia.cadaTicks`),
 *   una con clon y otra con punto. Sobre los params de la instantánea se aplican los de
 *   producción (`deploymentParams`), como hace `main.ts`. Al final exige el mismo digesto.
 * · micro: después, sobre el mundo del clon tal como lo deja el servidor (sus teselas ya pasaron
 *   por pasos), sin avanzarlo: `cloneWorld`, tomar el punto, restaurarlo (lo que solo se paga
 *   cuando el paso falla) y, para desglosar, solo la copia de teselas que hacen los dos caminos.
 *   Con `--expose-gc` cada operación empieza con el montón recogido: la basura de la anterior no
 *   se le cobra a la siguiente.
 * El original nunca se escribe: cada mundo se carga de su propia copia de la base.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { deploymentParams } from '../../src/server/deployment-params.js';
import { cloneWorld, puntoDeRestauracion, stepWorld, type World } from '../../src/world/index.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { paramsOf, setParams } from '../../src/world/params.js';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}
const cpuMs = (): number => { const { user, system } = process.cpuUsage(); return (user + system) / 1000; };
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const ordenados = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
const mediana = (xs: number[]): number => {
  const o = ordenados(xs);
  return o.length ? (o[(o.length - 1) >> 1]! + o[o.length >> 1]!) / 2 : NaN;
};
const p95 = (xs: number[]): number => { const o = ordenados(xs); return o.length ? o[Math.floor(o.length * 0.95)]! : NaN; };
const media = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const resumen = (xs: number[]) => ({ media: r3(media(xs)), mediana: r3(mediana(xs)), p95: r3(p95(xs)) });

const db = arg('--db'), micro = Number(arg('--micro') ?? 30), pasos = Number(arg('--pasos') ?? 200);
const bloque = Number(arg('--bloque') ?? 10), salida = arg('--salida');
if (!db || !existsSync(db)) {
  throw new Error('Uso: reserva-paso.ts --db <world.sqlite> [--micro N] [--pasos N] [--bloque B] [--salida json]');
}
if (!process.env.TMPDIR || process.env.TMPDIR.startsWith('/tmp')) {
  throw new Error('TMPDIR debe apuntar fuera de /tmp (cuota): TMPDIR=/datos/tmp-atlas-lab');
}
const gc = (globalThis as { gc?: () => void }).gc;
const recoger = (): void => { gc?.(); };

interface Copia { store: Store; world: World; dir: string }
function cargar(nombre: string): Copia {
  const dir = mkdtempSync(join(tmpdir(), `atlas-reserva-${nombre}-`));
  for (const sufijo of ['', '-wal', '-shm']) if (existsSync(db + sufijo)) copyFileSync(db + sufijo, join(dir, 'world.sqlite' + sufijo));
  const store = new Store(join(dir, 'world.sqlite'));
  const loaded = store.load();
  if (!loaded) throw new Error('La base no tiene mundo');
  setParams(loaded.world, deploymentParams(paramsOf(loaded.world)));
  return { store, world: loaded.world, dir };
}

const copias: Copia[] = [];
try {
  const clon = cargar('clon'); copias.push(clon);
  const punto = cargar('punto'); copias.push(punto);
  const digestoInicial = digestoCanonico(clon.world);
  if (digestoCanonico(punto.world) !== digestoInicial) throw new Error('Las dos copias cargadas difieren');
  const poblacionInicial = clon.world.people.length, tickInicial = clon.world.tick, teselas = clon.world.tiles.length;

  // Paso: la receta de `stepOnce` con cada reserva, por bloques alternados.
  type Medida = { reserva: number[]; paso: number[]; guardado: number[]; total: number[]; muro: number[] };
  const nueva = (): Medida => ({ reserva: [], paso: [], guardado: [], total: [], muro: [] });
  const medidas = { clon: nueva(), punto: nueva() };
  const avanzar = (copia: Copia, conClon: boolean, n: number, m: Medida): void => {
    for (let k = 0; k < n; k++) {
      const w0 = performance.now(), t0 = cpuMs();
      let reserva: ReturnType<typeof puntoDeRestauracion> | null = null;
      const draft = conClon ? cloneWorld(copia.world, copia.store.context) : (reserva = puntoDeRestauracion(copia.world), copia.world);
      const t1 = cpuMs();
      stepWorld(draft, [], copia.store.context);
      const t2 = cpuMs();
      if (draft.tick % paramsOf(draft).persistencia.cadaTicks === 0) copia.store.save(draft);
      const t3 = cpuMs();
      copia.world = draft; reserva = null;
      m.reserva.push(t1 - t0); m.paso.push(t2 - t1); m.guardado.push(t3 - t2); m.total.push(t3 - t0); m.muro.push(performance.now() - w0);
    }
  };
  const razones: number[] = [];
  for (let hecho = 0, par = 0; hecho < pasos; hecho += bloque, par++) {
    const n = Math.min(bloque, pasos - hecho);
    const antes = { clon: medidas.clon.total.length, punto: medidas.punto.total.length };
    if (par % 2) { avanzar(punto, false, n, medidas.punto); avanzar(clon, true, n, medidas.clon); }
    else { avanzar(clon, true, n, medidas.clon); avanzar(punto, false, n, medidas.punto); }
    const suma = (xs: number[], desde: number): number => xs.slice(desde).reduce((s, x) => s + x, 0);
    razones.push(suma(medidas.clon.total, antes.clon) / suma(medidas.punto.total, antes.punto));
  }
  const digestoClon = digestoCanonico(clon.world), digestoPunto = digestoCanonico(punto.world);

  // Micro: el mundo del clon tal como lo deja el servidor; el orden se alterna en cada ronda.
  const microClon: number[] = [], microPunto: number[] = [], microRestaurar: number[] = [], microTeselas: number[] = [];
  const operaciones: (() => void)[] = [
    () => {
      recoger();
      const t0 = cpuMs(), copia = cloneWorld(clon.world, clon.store.context);
      microClon.push(cpuMs() - t0);
      if (copia.tick !== clon.world.tick) throw new Error('clon inválido');
    },
    () => {
      recoger();
      const t0 = cpuMs(), reserva = puntoDeRestauracion(clon.world);
      microPunto.push(cpuMs() - t0);
      recoger();
      const t1 = cpuMs();
      reserva.restaurar();
      microRestaurar.push(cpuMs() - t1);
    },
    () => {
      recoger();
      const t0 = cpuMs(), copia = clon.world.tiles.map(tile => ({ ...tile }));
      microTeselas.push(cpuMs() - t0);
      if (copia.length !== clon.world.tiles.length) throw new Error('copia de teselas inválida');
    },
  ];
  for (let ronda = 0; ronda < micro; ronda++) for (const operacion of ronda % 2 ? [...operaciones].reverse() : operaciones) operacion();
  if (digestoCanonico(clon.world) !== digestoClon) throw new Error('Tomar y restaurar el punto cambió el mundo');

  const informe = (m: Medida) => ({ reservaCpuMs: resumen(m.reserva), pasoCpuMs: resumen(m.paso),
    guardadoCpuMsPorPaso: r3(media(m.guardado)), totalCpuMs: resumen(m.total), muroMs: resumen(m.muro) });
  const resultado = {
    db, tickInicial, poblacionInicial, teselas, gcForzado: !!gc, micro, pasos, bloque,
    microCpuMs: { cloneWorld: resumen(microClon), tomarPunto: resumen(microPunto), restaurar: resumen(microRestaurar),
      soloTeselas: resumen(microTeselas), razonMediana: r3(mediana(microClon) / mediana(microPunto)),
      restoClon: r3(mediana(microClon) - mediana(microTeselas)), restoPunto: r3(mediana(microPunto) - mediana(microTeselas)) },
    paso: { clon: informe(medidas.clon), punto: informe(medidas.punto),
      razonTotal: r3(media(medidas.clon.total) / media(medidas.punto.total)), razonTotalMedianaBloques: r3(mediana(razones)),
      razonPasoSolo: r3(media(medidas.clon.paso) / media(medidas.punto.paso)) },
    poblacionFinal: punto.world.people.length, tickFinal: punto.world.tick,
    digestoInicial, digestoFinalClon: digestoClon, digestoFinalPunto: digestoPunto, identico: digestoClon === digestoPunto,
  };
  const texto = JSON.stringify(resultado, null, 2);
  if (salida) writeFileSync(salida, texto + '\n');
  console.log(texto);
  if (!resultado.identico) process.exitCode = 1;
} finally { for (const copia of copias) { copia.store.close(); rmSync(copia.dir, { recursive: true, force: true }); } }
