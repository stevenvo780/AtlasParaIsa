/**
 * Banco del motor V23 con F2 repartida (piscina de M1, tarjetas de M3) por la entrada real `stepWorld`.
 *
 *   node --import tsx scripts/perf/banco-motor-v23.mts [--personas 40,400,4000] [--hilos 1,8,28] [--gpu no,si]
 *     [--adaptativo no,si] [--binarios <ruta>,<ruta>] [--repeticiones 1] [--pasos 120] [--calentar 30] [--semilla 51926]
 *     [--salida <json>]
 *
 * Cada combinación corre en un proceso propio, lanzado con cada uno de `--binarios` (por defecto este node). Con un
 * enlace de otro nombre (`ln -s "$(command -v node)" carta-banco`) se mide si escapar de la regla de ananicy para `node`
 * (SCHED_IDLE, nice 16) cambia algo; la clase se hereda, así que el banco mismo se lanza con ese enlace. Las
 * combinaciones se intercalan en cada repetición y al final sale una tabla (`TABLA`) con la mediana.
 *
 * El mundo se siembra igual en todas: `createWorld(semilla)` con los parámetros abiertos del anfitrión, 240 ticks de un
 * hilo, y personas clonadas sobre teselas de tierra al azar de un área que crece con ellas (≈ 32 teselas por persona,
 * más dispersas que en un poblado real); la fauna es la que el mundo tenga, sin techo. Mide, por tick y con `uptime` al
 * lado (la torre se comparte):
 *  - pared del tick (media, p50, p95), CPU del hilo que simula y del proceso, las fases de `FaseMedicion`, µs por
 *    persona (fase personas) y por animal (fauna);
 *  - F2: filas, captura, columnas de cerebro y despacho; de la piscina, la espera del que simula en la barrera y la
 *    ocupación de los hilos; de las tarjetas, bytes subidos y bajados y tramos rehechos en CPU;
 *  - fracción serie: lo que queda del tick fuera de F2 repartida y de la ecología en paralelo;
 *  - la puerta de M3: cada 10 ticks vencen a la vez todas las personas (hasta 4.000) y se mide ese despacho;
 *  - la política de planificación de los hilos del proceso (SCHED_OTHER / SCHED_IDLE) al terminar.
 * Con `--adaptativo si`, la piscina de F2 usa cada 10 ticks los núcleos que el resto de la torre deja libres.
 * Necesita `COMPUTE_NVRTC` para `--gpu si`.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { availableParallelism, loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';
import { hostOpenWorldParams } from '../../src/server/hardware-limits.js';
import { cpuDelProceso, cerrarPercibidores, PercibidorTarjetas, type PercibidorPiscina } from '../../src/world/decision/despacho.js';
import { percepcionDe } from '../../src/world/decision/percepcion.js';
import { initialDemography } from '../../src/world/demography.js';
import { closeEcosystemWorkers } from '../../src/world/ecosystem.js';
import { createWorld, stepWorld } from '../../src/world/index.js';
import { walkable } from '../../src/world/mundo/crear.js';
import { fraccionSerial } from '../../src/world/mundo/paso.js';
import { assertWorld } from '../../src/world/mundo/validar.js';
import { paramsOf, parseParams, setParams } from '../../src/world/params.js';
import { activate } from '../../src/world/spatial.js';
import { initialTechnologyKnowledge } from '../../src/world/technology.js';
import { tileLookup } from '../../src/world/tile-index.js';

interface Config { personas: number; hilos: number; gpu: boolean; pasos: number; calentar: number; semilla: number; adaptativo: boolean }

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
const lista = (flag: string, defecto: string): string[] => (arg(flag) ?? defecto).split(',').map(s => s.trim()).filter(Boolean);
const uptime = (): string => execFileSync('uptime', { encoding: 'utf8' }).trim();
const r = (x: number, d = 3): number => Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x;
const percentil = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
};

/** Núcleos ocupados por el resto de la torre desde la última lectura (/proc/stat menos la CPU de este proceso). */
function medidorDeLibres(): () => number {
  const leer = () => {
    const campos = readFileSync('/proc/stat', 'utf8').split('\n')[0]!.trim().split(/\s+/).slice(1).map(Number);
    const ocioso = campos[3]! + campos[4]!, total = campos.reduce((a, b) => a + b, 0);
    const { user, system } = process.cpuUsage();
    return { ocioso, total, propio: (user + system) / 1e6 };
  };
  const hz = 100, nucleos = availableParallelism();
  let previo = leer();
  return () => {
    const ahora = leer(), total = ahora.total - previo.total;
    const pared = total / hz / nucleos, ocupados = (total - (ahora.ocioso - previo.ocioso)) / hz / Math.max(pared, 1e-9);
    const propios = (ahora.propio - previo.propio) / Math.max(pared, 1e-9);
    previo = ahora;
    return Math.max(1, Math.floor(nucleos - Math.max(0, ocupados - propios)));
  };
}

/** CPU (ms) del hilo que simula y del proceso entero, de /proc (resolución de 10 ms: sirve sumada sobre muchos ticks). */
function cpuMs(): { principal: number; proceso: number } {
  const campos = (ruta: string) => { const t = readFileSync(ruta, 'utf8'); return t.slice(t.lastIndexOf(')') + 2).split(' '); };
  const principal = campos(`/proc/self/task/${process.pid}/stat`), proceso = campos('/proc/self/stat');
  return { principal: (Number(principal[11]) + Number(principal[12])) * 10, proceso: (Number(proceso[11]) + Number(proceso[12])) * 10 };
}

/** Política de planificación de los hilos del proceso, por nombre (campo 41 de /proc/<pid>/task/<tid>/stat). */
function politicas(): Record<string, number> {
  const nombres: Record<number, string> = { 0: 'SCHED_OTHER', 3: 'SCHED_BATCH', 5: 'SCHED_IDLE' }, cuenta: Record<string, number> = {};
  for (const tid of readdirSync('/proc/self/task')) {
    try {
      const stat = readFileSync(`/proc/self/task/${tid}/stat`, 'utf8'), resto = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const nombre = `${nombres[Number(resto[38])] ?? resto[38]} nice ${resto[16]}`;
      cuenta[nombre] = (cuenta[nombre] ?? 0) + 1;
    } catch { /* el hilo terminó entre listar y leer */ }
  }
  return cuenta;
}

/** El mundo sembrado del banco (también para otros scripts): `createWorld(semilla)` abierto, 240 ticks de un hilo y
 * clones hasta `personas`. */
export async function sembrarMundo(personas: number, semilla: number, validar = true) {

  const abiertos = hostOpenWorldParams();
  const conMotor = (motor: Partial<typeof abiertos.motor>) => parseParams({ motor: { ...abiertos.motor, ...motor } }, abiertos);
  const world = createWorld(semilla, conMotor({ hilos: 1, gpu: [] }));
  for (let i = 0; i < 240; i++) stepWorld(world);

  // Siembra determinista: el área crece en anillos de chunks alrededor del poblado hasta ≈ 32 teselas de tierra por
  // persona; cada clon cae en una tesela de tierra al azar (xorshift de la semilla) sin memorias de lugares ajenos.
  let estado = semilla >>> 0 || 1;
  const azar = () => { estado ^= estado << 13; estado >>>= 0; estado ^= estado >>> 17; estado ^= estado << 5; estado >>>= 0; return estado / 2 ** 32; };
  const plantillas = [...world.people];
  if (personas > plantillas.length) {
    const cx = Math.round(plantillas.reduce((s, p) => s + p.x, 0) / plantillas.length);
    const cy = Math.round(plantillas.reduce((s, p) => s + p.y, 0) / plantillas.length);
    const tierra = () => world.tiles.filter(t => t.terrain !== 'water');
    for (let anillo = 1; tierra().length < 32 * personas && anillo < 64; anillo++)
      for (let dy = -anillo; dy <= anillo; dy++) for (let dx = -anillo; dx <= anillo; dx++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === anillo) activate(world, cx + dx * 16, cy + dy * 16);
    const libres = tierra(), lookup = tileLookup(world.tiles);
    for (let i = world.people.length; i < personas; i++) {
      const p = structuredClone(plantillas[i % plantillas.length]!), t = libres[Math.floor(azar() * libres.length)]!;
      if (!walkable(world, t, lookup)) continue;
      // Lo que se reinicia es lo que reinicia un nacimiento (`demografia/nacer.ts`): nada que nombre a otros o a objetos.
      Object.assign(p, { id: `descendant-${++world.birthCounter}`, role: 'neighbor', x: t.x, y: t.y, target: { x: t.x, y: t.y }, command: null, controlMode: 'auto',
        materials: { wood: 0, stone: 0 }, skills: {}, activity: {}, values: {}, experiences: [], habits: [], visited: [], bonds: {},
        communityId: null, recentMemory: null, blueprintId: null, decisionAt: world.tick + 1 + (i % 30),
        technology: initialTechnologyKnowledge(), demography: initialDemography(p.demography.age) });
      for (const campo of ['uid', 'home', 'waterMemory', 'conflictMemory', 'partnerMemory', 'agreement', 'compounds', 'policyPlasticity'] as const) delete p[campo];
      world.people.push(p);
    }
    if (validar) {
      // La copia serializada, como al cargar; los parámetros van aparte del JSON (como en el guardado).
      const copia = JSON.parse(JSON.stringify(world));
      setParams(copia, paramsOf(world));
      assertWorld(copia);
    }
  }
  return { world, conMotor };
}

async function correrUna(c: Config): Promise<Record<string, unknown>> {
  const { world, conMotor } = await sembrarMundo(c.personas, c.semilla);

  setParams(world, conMotor({ hilos: c.hilos, gpu: c.gpu ? [0, 1] : [] }));
  const percepcion = percepcionDe(world), libresAhora = medidorDeLibres();
  const piscina = c.hilos > 1 ? cpuDelProceso(c.hilos) as PercibidorPiscina : undefined;
  const tarjetas = () => { const p = percepcion.percibidor; return p instanceof PercibidorTarjetas ? p : undefined; };
  if (c.gpu && !tarjetas()) throw new Error('Se pidió GPU y el percibidor no es de tarjetas (¿falta COMPUTE_NVRTC?)');
  const adaptar = () => { if (c.adaptativo && piscina) piscina.activos = Math.min(c.hilos, libresAhora()); };
  for (let i = 0; i < c.calentar; i++) stepWorld(world);

  const antes = uptime(), paredes: number[] = [], fases: Record<string, number> = {}, activos: number[] = [];
  const t0 = { ...percepcion.tiempos };
  piscina?.medidas();
  let personas = 0, animales = 0, bytes = 0, conDespacho = 0, enCpu0 = tarjetas()?.tramosEnCpu ?? 0, cpuPrincipal = 0, cpuProceso = 0;
  const puerta: { filas: number; despachoMs: number; f2Ms: number; gpuMs: number; bytes: number }[] = [];
  for (let i = 0; i < c.pasos; i++) {
    if (i % 10 === 0) adaptar();
    if (piscina) activos.push(piscina.activos);
    // Puerta de M3: en uno de cada 10 ticks medidos vence todo el mundo a la vez.
    const masivo = i % 10 === 5;
    if (masivo) for (const p of world.people) p.decisionAt = 0;
    const medicion = { clock: () => performance.now(), fases: {} as Record<string, number> };
    const tAntes = { ...percepcion.tiempos }, cpuAntes = cpuMs(), inicio = performance.now();
    stepWorld(world, [], undefined, medicion);
    const pared = performance.now() - inicio, cpuDespues = cpuMs();
    const lotes = tarjetas()?.ultimosLotes ?? [], hubo = percepcion.tiempos.despachos > tAntes.despachos;
    const b = hubo ? lotes.reduce((s, l) => s + l.subidos + l.bajados, 0) : 0;
    if (masivo) {
      puerta.push({ filas: percepcion.tiempos.filas - tAntes.filas, despachoMs: percepcion.tiempos.despachoMs - tAntes.despachoMs,
        f2Ms: percepcion.tiempos.capturaMs + percepcion.tiempos.cerebroMs + percepcion.tiempos.despachoMs - tAntes.capturaMs - tAntes.cerebroMs - tAntes.despachoMs,
        gpuMs: hubo ? Math.max(0, ...lotes.filter(l => l.dispositivo !== 'cpu').map(l => l.ms)) : 0, bytes: b });
      continue;
    }
    paredes.push(pared); bytes += b; if (hubo) conDespacho++;
    cpuPrincipal += cpuDespues.principal - cpuAntes.principal; cpuProceso += cpuDespues.proceso - cpuAntes.proceso;
    for (const [k, v] of Object.entries(medicion.fases)) fases[k] = (fases[k] ?? 0) + v;
    personas += world.people.length; animales += world.animals.length;
  }
  const n = paredes.length, t = percepcion.tiempos, m = piscina?.medidas();
  const porTick = (x: number) => r(x / n);
  const f2Repartida = m ? m.paredMs : (t.despachoMs - t0.despachoMs);
  const ecologia = c.hilos > 1 ? (fases.ecologia ?? 0) + (fases.kernel ?? 0) : 0;
  const total = paredes.reduce((a, b) => a + b, 0);
  const resultado = {
    config: c, uptimeAntes: antes, uptimeDespues: uptime(), binario: process.argv0,
    personas: r(personas / n, 1), animales: r(animales / n, 1), paginas: r(world.tiles.length / 256, 1),
    tickMs: { media: porTick(total), p50: r(percentil(paredes, 0.5)), p95: r(percentil(paredes, 0.95)) },
    // CPU por tick del hilo que simula y del proceso: pared ≫ CPU del principal es espera (barrera, tarjetas o la torre).
    cpuMsPorTick: { principal: porTick(cpuPrincipal), proceso: porTick(cpuProceso) },
    fasesMs: Object.fromEntries(Object.entries(fases).map(([k, v]) => [k, porTick(v)])),
    fraccionSerialT107: r(fraccionSerial(fases)),
    usPorPersona: r((fases.personas ?? 0) * 1000 / personas), usPorAnimal: r((fases.fauna ?? 0) * 1000 / animales),
    usPorOrganismo: r(total * 1000 / (personas + animales)),
    f2: { filasPorTick: porTick(t.filas - t0.filas - puerta.reduce((s, p) => s + p.filas, 0)), capturaMs: porTick(t.capturaMs - t0.capturaMs),
      cerebroMs: porTick(t.cerebroMs - t0.cerebroMs), despachoMs: porTick(t.despachoMs - t0.despachoMs),
      respaldos: percepcion.respaldos },
    piscina: m && { activosMedia: r(activos.reduce((a, b) => a + b, 0) / activos.length, 1), fasesEnPiscina: m.enPiscina, fases: m.fases,
      esperaSobrePared: r(m.esperaMs / Math.max(m.paredMs, 1e-9)), ocupacion: r(m.activoMs / Math.max(m.hiloMs, 1e-9)), mensajes: m.mensajes },
    tarjetas: c.gpu ? { activas: tarjetas()?.tarjetas, bytesPorTick: r(bytes / n, 0), bytesPorDespacho: r(bytes / Math.max(conDespacho, 1), 0),
      tramosEnCpu: (tarjetas()?.tramosEnCpu ?? 0) - enCpu0 } : undefined,
    // Lo que queda del tick fuera de las partes repartidas (F2 en la piscina o las tarjetas y la ecología en paralelo).
    fraccionSerie: c.hilos > 1 || c.gpu ? r(Math.max(0, 1 - (f2Repartida + ecologia) / total)) : 1,
    puertaM3: puerta.length ? {
      filas: r(percentil(puerta.map(p => p.filas), 0.5), 0), despachoMsP50: r(percentil(puerta.map(p => p.despachoMs), 0.5)),
      despachoMsMax: r(Math.max(...puerta.map(p => p.despachoMs))), f2MsP50: r(percentil(puerta.map(p => p.f2Ms), 0.5)),
      gpuMsP50: r(percentil(puerta.map(p => p.gpuMs), 0.5)), bytesP50: r(percentil(puerta.map(p => p.bytes), 0.5), 0), muestras: puerta.length,
    } : undefined,
    politicas: politicas(),
  };
  await cerrarPercibidores();
  await closeEcosystemWorkers();
  return resultado;
}

const directo = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (!directo) { /* importado: solo `sembrarMundo` */ } else if (arg('--uno')) {
  const resultado = await correrUna(JSON.parse(arg('--uno')!) as Config);
  process.stdout.write(`RESULTADO ${JSON.stringify(resultado)}\n`);
  process.exit(0);
} else {
  // Las combinaciones se intercalan en cada repetición: la carga de la torre cambia en minutos y así no cae sobre una sola.
  const salida = arg('--salida'), repeticiones = Number(arg('--repeticiones') ?? 1);
  const binarios = lista('--binarios', process.execPath), configs: Config[] = [];
  for (const personas of lista('--personas', '40,400,4000').map(Number))
    for (const gpu of lista('--gpu', 'no,si').map(s => s === 'si'))
      for (const hilos of lista('--hilos', '1,8,28').map(Number))
        for (const adaptativo of lista('--adaptativo', 'no').map(s => s === 'si'))
          if (hilos > 1 || !adaptativo) configs.push({ personas, hilos, gpu, adaptativo, pasos: Number(arg('--pasos') ?? 120),
            calentar: Number(arg('--calentar') ?? 30), semilla: Number(arg('--semilla') ?? 51926) });
  const resultados: Record<string, any>[] = [];
  for (let rep = 0; rep < repeticiones; rep++) for (const c of configs) for (const binario of binarios) {
    process.stderr.write(`${new Date().toISOString()} ${JSON.stringify(c)} ${binario} | ${uptime()} | carga ${loadavg()[0]!.toFixed(1)}\n`);
    const texto = execFileSync(binario, ['--import', 'tsx', fileURLToPath(import.meta.url), '--uno', JSON.stringify(c)],
      { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'inherit'] });
    const linea = texto.split('\n').find(l => l.startsWith('RESULTADO '));
    if (!linea) throw new Error(`Sin resultado para ${JSON.stringify(c)}`);
    const res = { ...JSON.parse(linea.slice('RESULTADO '.length)), binario: basename(binario) };
    resultados.push(res);
    process.stdout.write(`${JSON.stringify(res)}\n`);
    if (salida) writeFileSync(salida, JSON.stringify(resultados, null, 1));
  }
  // Resumen: mediana de las repeticiones por combinación.
  const mediana = (xs: number[]) => percentil(xs, 0.5);
  const grupos = new Map<string, Record<string, any>[]>();
  for (const res of resultados) {
    const { personas, hilos, gpu, adaptativo } = res.config as Config;
    const clave = `${personas}\t${hilos}${adaptativo ? ' adapt.' : ''}\t${gpu ? 'GPU' : 'CPU'}\t${res.binario}`;
    grupos.set(clave, [...grupos.get(clave) ?? [], res]);
  }
  const columnas = ['personas', 'hilos', 'disp.', 'binario', 'n', 'ms/tick', 'p95', 'CPU princ.', 'µs/pers', 'µs/anim', 'animales', 'F2 captura',
    'F2 cerebro', 'F2 despacho', 'serie', 'espera/pared', 'B/tick', 'puerta ms', 'puerta B', 'SCHED'];
  process.stdout.write(`TABLA ${columnas.join('\t')}\n`);
  for (const [clave, rs] of grupos) {
    const m = (f: (r: Record<string, any>) => number | undefined) => r(mediana(rs.map(f).filter((x): x is number => x !== undefined)), 2);
    process.stdout.write(`TABLA ${clave}\t${rs.length}\t${[m(x => x.tickMs.media), m(x => x.tickMs.p95), m(x => x.cpuMsPorTick?.principal),
      m(x => x.usPorPersona), m(x => x.usPorAnimal), m(x => x.animales), m(x => x.f2.capturaMs), m(x => x.f2.cerebroMs), m(x => x.f2.despachoMs),
      m(x => x.fraccionSerie), m(x => x.piscina?.esperaSobrePared), m(x => x.tarjetas?.bytesPorTick), m(x => x.puertaM3?.despachoMsP50),
      m(x => x.puertaM3?.bytesP50)].join('\t')}\t${Object.keys(rs[0]!.politicas).join(' + ')}\n`);
  }
}
