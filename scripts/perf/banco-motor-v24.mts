/**
 * Banco corto de CPU con el coordinador real. Ejecuta desde una copia de trabajo de Atlas.
 *
 *   node --import tsx scripts/perf/banco-motor-v24.mts ESCENAS.json DIRECTORIO_NUEVO
 *
 * Configuración de ejemplo (en el banco de escala, elige ventanas más largas):
 * {
 *   "hilos": [1, 2], "repeticiones": 1,
 *   "escenas": [{"id":"smoke", "semilla":7, "siembra":7, "n":20,
 *                "zona":"0,0,48,32", "calentar":1, "medir":3}]
 * }
 * El primer número de hilos es la referencia. Cada bloque comparte una siembra y alterna el
 * orden de ejecución. `resumen.json` aparece al pasar todas las comprobaciones. Cada JSONL
 * conserva los tiempos brutos. El libro se comprueba al salir del calentamiento y al final,
 * fuera de la medición. `mortalesVivos` excluye figuras protegidas, `paginasActivas` cuenta
 * páginas del motor y `chunksArchivados` cuenta copias retenidas, incluidas las de chunks
 * que se hayan reactivado. El banco usa CPU y RAM, sin abrir servidor, cinta o SQLite.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archivoDeChunks, paramsDeCorrida, poblar, zona } from '../lab/poblacion.mjs';
import { cerrarPercibidores } from '../../src/world/decision/despacho.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { closeEcosystemWorkers } from '../../src/world/ecosystem.js';
import { assertWorld, createWorld } from '../../src/world/index.js';
import { comprobarLeyes, crearComprobador } from '../../src/world/invariantes.js';
import { codificarCheckpoint, decodificarCheckpoint } from '../../src/world/materia/checkpoint.js';
import { enlazarCtx } from '../../src/world/motor/acceso.js';
import { duenoSi } from '../../src/world/motor/contexto.js';
import type { Instantanea, Motor, TelemetriaMotor } from '../../src/world/motor/contratos.js';
import { crearMotor } from '../../src/world/motor/coordinador.js';
import { setParams } from '../../src/world/params.js';

interface Escena {
  id: string; semilla: number; siembra: number; n: number; zona: string; calentar: number; medir: number;
}
interface Config { hilos: number[]; repeticiones: number; escenas: Escena[] }
interface Integridad {
  tick: number; mortalesVivos: number; faunaResidente: number; paginasActivas: number; chunksArchivados: number;
  conservacion: true; violaciones: ReturnType<typeof comprobarLeyes>;
}

const repo = fileURLToPath(new URL('../../', import.meta.url));
const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const entero = (n: number, minimo: number): boolean => Number.isSafeInteger(n) && n >= minimo;
const sha256 = (contenido: Buffer): string => createHash('sha256').update(contenido).digest('hex');

function validacionConfiguracion(config: Config): void {
  assert.ok(config && Array.isArray(config.hilos) && config.hilos.length >= 2 &&
    config.hilos.every(h => entero(h, 1) && h <= availableParallelism()) &&
    new Set(config.hilos).size === config.hilos.length, 'Indica al menos dos recuentos distintos de dueños disponibles');
  assert.ok(entero(config.repeticiones, 1), 'repeticiones debe ser un entero positivo');
  assert.ok(Array.isArray(config.escenas) && config.escenas.length > 0, 'Faltan escenas');
  for (const e of config.escenas) {
    assert.ok(e && typeof e.id === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(e.id), 'ID de escena inválido');
    assert.ok(entero(e.semilla, 0) && entero(e.siembra, 0) && entero(e.n, 1), `Siembra inválida en ${e.id}`);
    assert.ok(typeof e.zona === 'string', `Falta la zona de ${e.id}`);
    zona(e.zona);
    assert.ok(entero(e.calentar, 0) && entero(e.medir, 1) && entero(e.calentar + e.medir, 1), `Ventana inválida en ${e.id}`);
  }
  assert.equal(new Set(config.escenas.map(e => e.id)).size, config.escenas.length, 'IDs de escenas repetidos');
}

function planificador() {
  const afinidad = /^Cpus_allowed_list:\s*(.+)$/m.exec(readFileSync('/proc/thread-self/status', 'utf8'))?.[1];
  const stat = readFileSync('/proc/thread-self/stat', 'utf8');
  const campos = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { afinidad, cpus: availableParallelism(), nice: Number(campos[16]), politica: Number(campos[38]) };
}

function tiempos(muestras: readonly number[]) {
  assert.ok(muestras.length > 0 && muestras.every(x => Number.isFinite(x) && x >= 0), 'Muestra sin tiempos finitos');
  const orden = [...muestras].sort((a, b) => a - b);
  const pct = (p: number) => orden[Math.ceil(p * orden.length) - 1]!;
  return { media: orden.reduce((suma, ms) => suma + ms, 0) / orden.length, p50: pct(.5), p95: pct(.95), p99: pct(.99) };
}

async function medir(e: Escena, hilos: number, salida: string) {
  const base = paramsDeCorrida({ regimen: 'abierto', hasta: 'rebalanceo', hilos: 1, gpu: [] });
  const mundo = createWorld(e.semilla, base);
  const { caminables, candidatos } = poblar(mundo, { n: e.n, zona: zona(e.zona), siembra: e.siembra });
  assertWorld(mundo);
  const digestoInicial = digestoCanonico(mundo);
  const params = { ...base, motor: { ...base.motor, hilos } };
  setParams(mundo, params);
  const { archivar, archivo } = archivoDeChunks(mundo);
  const revisar = crearComprobador({ cadencia: false });
  const fd = openSync(salida, 'wx', 0o600);
  const anotar = (fila: object) => writeSync(fd, JSON.stringify(fila) + '\n');
  const pared: number[] = [], cpuProceso: number[] = [], barrera: number[] = [];
  let motor: Motor | undefined;
  const inicio = { tipo: 'inicio', escena: e, hilos, commit: git('rev-parse', 'HEAD'), node: process.version,
    digestoInicial, caminables, candidatos, intervalos: { inicio: mundo.tick, fin: mundo.tick + e.calentar + e.medir },
    interruptores: params.v23, motor: params.motor, carga: loadavg(), planificador: planificador() };
  try {
    anotar(inicio);
    motor = crearMotor(mundo, { hilos, gpu: [], decisionGpu: 'siempre', verificar: false, semilla: e.semilla });
    let integridad: Integridad | undefined;
    const conPaginas = new Set<number>();
    for (let paso = 1; paso <= e.calentar + e.medir; paso++) {
      const cpuAntes = process.cpuUsage();
      const desde = performance.now();
      const tick: number = motor.paso([]).tick;
      const paredMs = performance.now() - desde;
      const cpu = process.cpuUsage(cpuAntes);
      const cpuMs = (cpu.user + cpu.system) / 1000;
      const t: TelemetriaMotor = motor.telemetria();
      const reparto = motor.reparto();
      assert.equal(tick, inicio.intervalos.inicio + paso);
      assert.ok(paredMs > 0 && Number.isFinite(paredMs) && Number.isFinite(cpuMs), 'Tiempo de paso inválido');
      assert.equal(t.hilos, hilos);
      assert.ok(!t.gpuEstado.length && !t.gpuMs.length && !t.gpuBytes.length, 'Actividad GPU inesperada');
      assert.ok(reparto && reparto.msPorHilo.length === hilos && reparto.msPorHilo.every(ms => Number.isFinite(ms) && ms > 0),
        'El reparto efectivo no acredita la ejecución solicitada');
      for (const [,, dueno] of reparto.paginas) {
        assert.ok(entero(dueno, 0) && dueno < hilos, 'Dueño fuera de rango');
        conPaginas.add(dueno);
      }
      const medido = paso > e.calentar;
      const barreraEmaMs = hilos > 1 ? t.esperaBarreraMs : null;
      if (medido) {
        pared.push(paredMs);
        cpuProceso.push(cpuMs);
        if (barreraEmaMs !== null) barrera.push(barreraEmaMs);
      }
      anotar({ tipo: 'tick', tick, medido, paredMs, cpuMs, barreraEmaMs, fasesEmaMs: t.faseMs,
        paginasActivas: reparto.paginas.length, duenoMaxMs: hilos > 1 ? Math.max(...reparto.msPorHilo) : null,
        migraciones: t.migraciones, intentos: t.intentos, rssMiB: process.memoryUsage.rss() / 2 ** 20 });
      if (paso % 120 === 0 || tick === inicio.intervalos.fin) archivar();
      if (paso === e.calentar || tick === inicio.intervalos.fin) {
        const { world, materia }: Instantanea = motor.instantanea();
        const d = duenoSi(mundo);
        const quimica = d?.quimica;
        assert.ok(d && quimica && materia, 'Falta contexto o checkpoint material');
        const { enviados, recibidos, pendientes } = d.balanceIntentos();
        assert.equal(enviados, recibidos + pendientes, 'Saldo de intentos');
        assertWorld(world);
        decodificarCheckpoint(codificarCheckpoint(materia), id => quimica.sustancia(id));
        if (world !== mundo) enlazarCtx(world, d);
        const violaciones: Integridad['violaciones'] = [...revisar(world), ...comprobarLeyes(mundo, d.leyes)];
        assert.equal(violaciones.length, 0, JSON.stringify(violaciones));
        integridad = { tick, mortalesVivos: world.people.filter(p => p.role === 'neighbor').length,
          faunaResidente: world.animals.length, paginasActivas: reparto.paginas.length,
          chunksArchivados: archivo.size, conservacion: true, violaciones };
        anotar({ tipo: 'integridad', ...integridad });
      }
    }
    assert.ok(integridad?.tick === inicio.intervalos.fin && conPaginas.size > 0, 'Falta evidencia de cierre');
    const latencia = tiempos(pared);
    anotar({ tipo: 'fin', estado: 'completo', muestras: pared.length, carga: loadavg(), planificador: planificador(),
      paredMs: latencia, cpuProcesoMs: tiempos(cpuProceso), barreraEmaMs: barrera.length ? tiempos(barrera) : null,
      hz: 1000 / latencia.media, maxRssMiB: process.resourceUsage().maxRSS / 1024,
      duenosConPaginas: [...conPaginas].sort((a, b) => a - b), ...integridad });
  } finally {
    closeSync(fd);
    await motor?.cerrar();
    await cerrarPercibidores();
    await closeEcosystemWorkers();
  }
}

function medirBloques(rutaConfig: string, salida: string) {
  const contenido = readFileSync(rutaConfig);
  const config = JSON.parse(contenido.toString('utf8')) as Config;
  validacionConfiguracion(config);
  const commit = git('rev-parse', 'HEAD');
  const diferencia = git('diff', '--binary', 'HEAD', '--', 'src', 'scripts', 'package.json', 'package-lock.json');
  const script = fileURLToPath(import.meta.url);
  const instrumentoSha256 = sha256(readFileSync(script));
  mkdirSync(salida, { mode: 0o700 });
  const bloques = [];
  for (const escena of config.escenas) for (let repeticion = 0; repeticion < config.repeticiones; repeticion++) {
    const orden = repeticion % 2 ? [...config.hilos].reverse() : config.hilos;
    const corridas = [];
    let digestoInicial: string | undefined;
    for (const hilos of orden) {
      const nombre = `${escena.id}.r${repeticion + 1}.h${hilos}.jsonl`;
      const ruta = join(salida, nombre);
      const hijo = spawnSync(process.execPath, ['--import', 'tsx', script, '--medir', JSON.stringify(escena), String(hilos), ruta],
        { cwd: repo, stdio: ['ignore', 'inherit', 'inherit'] });
      if (hijo.error) throw hijo.error;
      assert.equal(hijo.status, 0, `Falló ${nombre} (${hijo.signal ?? hijo.status})`);
      const filas = readFileSync(ruta, 'utf8').trimEnd().split('\n').map(linea => JSON.parse(linea));
      const [inicio] = filas, fin = filas.at(-1);
      assert.ok(inicio?.tipo === 'inicio' && inicio.commit === commit && inicio.hilos === hilos, `Cabecera inválida en ${nombre}`);
      assert.deepEqual(inicio.escena, escena, `Escena distinta en ${nombre}`);
      assert.match(inicio.digestoInicial, /^[a-f0-9]{64}$/, `Huella inicial inválida en ${nombre}`);
      digestoInicial ??= inicio.digestoInicial;
      assert.equal(inicio.digestoInicial, digestoInicial, `Estado inicial diferente en ${nombre}`);
      const medidas = filas.filter(fila => fila.tipo === 'tick' && fila.medido === true);
      assert.ok(fin?.tipo === 'fin' && fin.estado === 'completo' && fin.muestras === escena.medir &&
        medidas.length === escena.medir && fin.tick === escena.calentar + escena.medir && fin.conservacion === true &&
        Array.isArray(fin.violaciones) && fin.violaciones.length === 0, `Cierre inválido en ${nombre}`);
      assert.ok(medidas.every((fila, i) => fila.tick === escena.calentar + i + 1), `Ventana incompleta en ${nombre}`);
      assert.deepEqual(fin.paredMs, tiempos(medidas.map(fila => fila.paredMs)), `Percentiles inconsistentes en ${nombre}`);
      corridas.push({ hilos, jsonl: nombre, cargaInicial: inicio.carga, ...fin });
    }
    const referencia = corridas.find(corrida => corrida.hilos === config.hilos[0])!;
    bloques.push({ escena: escena.id, repeticion: repeticion + 1, digestoInicial, corridas: corridas.map(corrida => ({
      ...corrida, aceleracionMedia: referencia.paredMs.media / corrida.paredMs.media,
      aceleracionP95: referencia.paredMs.p95 / corrida.paredMs.p95,
    })) });
  }
  assert.equal(git('rev-parse', 'HEAD'), commit, 'Cambió el commit durante la medición');
  assert.equal(git('diff', '--binary', 'HEAD', '--', 'src', 'scripts', 'package.json', 'package-lock.json'), diferencia,
    'Cambió el código durante la medición');
  assert.equal(sha256(readFileSync(script)), instrumentoSha256, 'Cambió el instrumento durante la medición');
  writeFileSync(join(salida, 'resumen.json'), JSON.stringify({ version: 1, commit, configSha256: sha256(contenido),
    instrumentoSha256, diffSha256: sha256(Buffer.from(diferencia)), arbolLimpio: git('status', '--porcelain', '--', 'src', 'scripts',
      'package.json', 'package-lock.json') === '', config, bloques }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

const args = process.argv.slice(2);
if (args[0] === '--medir') {
  assert.equal(args.length, 4);
  await medir(JSON.parse(args[1]!), Number(args[2]), args[3]!);
} else {
  assert.equal(args.length, 2, 'Uso: node --import tsx scripts/perf/banco-motor-v24.mts ESCENAS.json DIRECTORIO_NUEVO');
  medirBloques(resolve(args[0]!), resolve(args[1]!));
}
