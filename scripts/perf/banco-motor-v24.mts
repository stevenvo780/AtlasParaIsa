/**
 * Banco corto con el coordinador real. Ejecuta desde una copia de trabajo de Atlas.
 *
 *   node --import tsx scripts/perf/banco-motor-v24.mts ESCENAS.json DIRECTORIO_NUEVO
 *
 * Configuración de ejemplo (en el banco de escala, elige ventanas más largas):
 * {
 *   "hilos": [1, 2], "repeticiones": 1,
 *   "escenas": [{"id":"smoke", "semilla":7, "siembra":7, "n":20,
 *                "zona":"0,0,48,32", "calentar":1, "medir":3}]
 * }
 * Para comparar CUDA, reemplaza `hilos` por `brazos` y pasa `COMPUTE_NVRTC`:
 * [{"id":"cpu1","hilos":1,"gpu":[]},{"id":"cpu2","hilos":2,"gpu":[]},
 *  {"id":"gpu0-cpu2","hilos":2,"gpu":[0]}]
 * `"rutaGpu":"porCoste"` añade un brazo adaptativo con la misma GPU y dueños.
 * El modo fijo exige confirmaciones CUDA medidas. El adaptativo admite una ventana
 * íntegramente en CPU si se registraron decisiones de coste y confirmaciones previas.
 * Para medir desde un mundo ya crecido, prepara una copia de laboratorio con
 * `CARTA_DATA_DIR=/ruta/laboratorio npm run backup -- copia.sqlite` y calcula su SHA-256.
 * En la escena reemplaza `semilla`, `siembra`, `n` y `zona` por
 * `"fixture":{"sqlite":"copia.sqlite","sha256":"<64 hex>"}`. La ruta relativa se resuelve
 * desde ESCENAS.json. El guardado debe contener materia, la cabeza vigente y la ley de dueños.
 * Cada brazo carga una copia desechable y conserva sus parámetros salvo hilos y GPU.
 *
 * El primer brazo es la referencia. Cada bloque comparte el mismo estado y alterna el
 * orden de ejecución. `resumen.json` aparece al pasar todas las comprobaciones. Cada JSONL
 * conserva los tiempos brutos. El libro y la carga por chunk se comprueban al salir del
 * calentamiento y al final, fuera de la medición. `mortalesVivos` excluye figuras protegidas, `paginasActivas` cuenta
 * páginas del motor y `chunksArchivados` cuenta copias retenidas en RAM durante la corrida,
 * incluidas las de chunks que se hayan reactivado. En fixtures, el archivo SQLite previo
 * sigue accesible desde la copia. La medición se limita al motor, incluido el corredor cuando
 * se solicita. CUDA acredita los lotes confirmados por el canal en la ventana medida. Su tiempo
 * incluye copias y ejecución en el servidor. Los errores de revalidación posteriores no se imputan al canal.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { archivoDeChunks, paramsDeCorrida, poblar, zona } from '../lab/poblacion.mjs';
import { Store } from '../../src/server/store.js';
import { cerrarPercibidores } from '../../src/world/decision/despacho.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { closeEcosystemWorkers } from '../../src/world/ecosystem.js';
import { assertWorld, createWorld, RULES_VERSION, type World } from '../../src/world/index.js';
import { comprobarLeyes, crearComprobador } from '../../src/world/invariantes.js';
import { codificarCheckpoint, decodificarCheckpoint } from '../../src/world/materia/checkpoint.js';
import { enlazarCtx } from '../../src/world/motor/acceso.js';
import { duenoSi } from '../../src/world/motor/contexto.js';
import type { Instantanea, Motor, TelemetriaBrokerGpu, TelemetriaMotor } from '../../src/world/motor/contratos.js';
import { crearMotor } from '../../src/world/motor/coordinador.js';
import { paramsOf, setParams } from '../../src/world/params.js';
import { bindWorldContext, worldContext } from '../../src/world/spatial.js';

type Escena = { id: string; calentar: number; medir: number } & (
  { semilla: number; siembra: number; n: number; zona: string } | { fixture: { sqlite: string; sha256: string } });
interface Brazo { id: string; hilos: number; gpu: number[]; rutaGpu?: 'porCoste' }
interface Config { hilos?: number[]; brazos?: Brazo[]; repeticiones: number; escenas: Escena[] }
interface Integridad {
  tick: number; mortalesVivos: number; faunaResidente: number; paginasActivas: number; chunksArchivados: number;
  conservacion: true; violaciones: ReturnType<typeof comprobarLeyes>;
}

const repo = fileURLToPath(new URL('../../', import.meta.url));
const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const entero = (n: number, minimo: number): boolean => Number.isSafeInteger(n) && n >= minimo;
const sha256 = (contenido: Buffer): string => createHash('sha256').update(contenido).digest('hex');
const esSha256 = /^[a-f0-9]{64}$/;
const esId = /^[a-z0-9][a-z0-9_-]*$/;

function validacionConfiguracion(config: Config): Brazo[] {
  assert.ok(config && (Array.isArray(config.hilos) ? config.brazos === undefined : config.hilos === undefined && Array.isArray(config.brazos)),
    'Indica hilos o brazos');
  const brazos: Brazo[] = config.brazos ?? config.hilos!.map(hilos => ({ id: `h${hilos}`, hilos, gpu: [] }));
  assert.ok(brazos.length >= 2 && brazos.every(b => b && typeof b.id === 'string' && esId.test(b.id) &&
    entero(b.hilos, 1) && b.hilos <= availableParallelism() && Array.isArray(b.gpu) &&
    (b.gpu.length === 0 || b.hilos === 2 && b.gpu.length === 1 && b.gpu[0] === 0) &&
    (b.rutaGpu === undefined || b.rutaGpu === 'porCoste' && b.gpu.length === 1)),
  'Indica al menos dos brazos CPU o GPU0 con dos dueños');
  assert.equal(new Set(brazos.map(b => b.id)).size, brazos.length, 'IDs de brazos repetidos');
  assert.equal(new Set(brazos.map(b => `${b.hilos}:${b.gpu.join(',')}:${b.rutaGpu ?? ''}`)).size, brazos.length,
    'Configuraciones de brazos repetidas');
  if (brazos.some(b => b.gpu.length)) assert.ok(process.env.COMPUTE_NVRTC && existsSync(process.env.COMPUTE_NVRTC),
    'El brazo CUDA requiere COMPUTE_NVRTC');
  assert.ok(entero(config.repeticiones, 1), 'repeticiones debe ser un entero positivo');
  assert.ok(Array.isArray(config.escenas) && config.escenas.length > 0, 'Faltan escenas');
  for (const e of config.escenas) {
    assert.ok(e && typeof e.id === 'string' && esId.test(e.id), 'ID de escena inválido');
    if ('fixture' in e) {
      assert.ok(typeof e.fixture?.sqlite === 'string' && e.fixture.sqlite.length > 0 &&
        typeof e.fixture.sha256 === 'string' && esSha256.test(e.fixture.sha256) &&
        !['semilla', 'siembra', 'n', 'zona'].some(campo => campo in e), `Fixture inválido en ${e.id}`);
    } else {
      assert.ok(entero(e.semilla, 0) && entero(e.siembra, 0) && entero(e.n, 1), `Siembra inválida en ${e.id}`);
      assert.ok(typeof e.zona === 'string', `Falta la zona de ${e.id}`);
      zona(e.zona);
    }
    assert.ok(entero(e.calentar, 0) && entero(e.medir, 1) && entero(e.calentar + e.medir, 1), `Ventana inválida en ${e.id}`);
  }
  assert.equal(new Set(config.escenas.map(e => e.id)).size, config.escenas.length, 'IDs de escenas repetidos');
  return brazos;
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

function deltaGpu(fin: TelemetriaBrokerGpu, inicio?: TelemetriaBrokerGpu): TelemetriaBrokerGpu {
  const { completadas, ...contadores } = fin;
  const campos = Object.keys(contadores) as (keyof typeof contadores)[];
  const delta = { ...fin, completadas: [completadas[0] - (inicio?.completadas[0] ?? 0),
    completadas[1] - (inicio?.completadas[1] ?? 0)] } satisfies TelemetriaBrokerGpu;
  for (const campo of campos) delta[campo] = contadores[campo]! - (inicio?.[campo] ?? 0);
  assert.ok(campos.every(campo => entero(delta[campo] ?? NaN, 0)) && delta.completadas.every(n => entero(n, 0)), 'Contadores CUDA incoherentes');
  return delta;
}

function acreditarGpu(brazo: Brazo, ventana?: TelemetriaBrokerGpu, calentamiento?: TelemetriaBrokerGpu): void {
  if (!brazo.gpu.length) return;
  if (brazo.rutaGpu === 'porCoste') {
    assert.ok(ventana && ventana.cpuPorCoste !== undefined &&
      (ventana.completadas.some(n => n > 0) || ventana.cpuPorCoste > 0 && calentamiento?.completadas.some(n => n > 0)),
    'Falta actividad del corredor adaptativo en la ventana o confirmación CUDA durante su calibración');
  } else {
    assert.ok(ventana?.completadas.some(n => n > 0) && ventana.cpuPorCoste === undefined,
      'El corredor fijo debe confirmar CUDA durante la ventana medida');
  }
}

interface Preparada {
  mundo: World;
  siembra?: { caminables: number; candidatos: number };
  fixture?: { sha256: string; esquema: number; reglas: number; tick: number; semilla: number; paramsSha256: string };
  carga?: { instantanea: Instantanea; epoca: number };
  cerrar?: () => void;
}

async function preparar(e: Escena, directorio: string): Promise<Preparada> {
  if (!('fixture' in e)) {
    const base = paramsDeCorrida({ regimen: 'abierto', hasta: 'rebalanceo', hilos: 1, gpu: [] });
    const mundo = createWorld(e.semilla, base);
    const { caminables, candidatos } = poblar(mundo, { n: e.n, zona: zona(e.zona), siembra: e.siembra });
    return { mundo, siembra: { caminables, candidatos } };
  }
  const original = realpathSync(e.fixture.sqlite);
  const principal = dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
  for (const raiz of [resolve(principal, 'data'), resolve(repo, 'data'), resolve(repo, '../../mundos')]) {
    const absoluta = existsSync(raiz) ? realpathSync(raiz) : raiz;
    assert.ok(!original.startsWith(absoluta + sep), 'Usa una copia de laboratorio fuera de los mundos operativos');
  }
  assert.ok(statSync(original).isFile(), 'El fixture debe ser un archivo');
  assert.ok(!['-wal', '-shm', '-journal'].some(sufijo => existsSync(original + sufijo)), 'El fixture debe ser una copia SQLite sellada');
  const temporal = mkdtempSync(join(directorio, '.fixture-'));
  let store: Store | undefined;
  const cerrar = () => {
    try { store?.close(); }
    finally { rmSync(temporal, { recursive: true, force: true }); }
  };
  try {
    const copia = join(temporal, 'world.sqlite');
    copyFileSync(original, copia, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    const hash = createHash('sha256');
    for await (const bloque of createReadStream(copia)) hash.update(bloque);
    const sha = hash.digest('hex');
    assert.equal(sha, e.fixture.sha256, 'El SHA-256 de la copia difiere del fixture declarado');
    const lector = new DatabaseSync(copia, { readOnly: true });
    let esquema: number;
    try { esquema = Number(lector.prepare('PRAGMA user_version').get()!.user_version); }
    finally { lector.close(); }
    store = new Store(copia);
    assert.equal(Number(store.db.prepare('PRAGMA user_version').get()!.user_version), esquema, 'El fixture requiere migrar SQLite');
    const carga = store.cargarGuardadoCompleto();
    assert.ok(carga && carga.metadatos.slot === 0 && carga.instantanea.materia, 'Falta la cabeza vigente con materia');
    const { world: mundo } = carga.instantanea;
    const params = paramsOf(mundo);
    assert.ok(params.v23.guardadoCompleto && params.v23.materia && params.v23.duenos, 'El fixture debe usar guardado completo, materia y dueños');
    const fixture = { sha256: sha, esquema, reglas: mundo.version, tick: mundo.tick, semilla: mundo.seed,
      paramsSha256: sha256(Buffer.from(JSON.stringify(params))) };
    return { mundo, fixture, carga, cerrar };
  } catch (error) { cerrar(); throw error; }
}

async function medir(e: Escena, brazo: Brazo, salida: string) {
  const { hilos, gpu } = brazo;
  const { mundo, siembra, fixture, carga, cerrar } = await preparar(e, dirname(salida));
  let fd: number | undefined;
  let motor: Motor | undefined;
  try {
    assertWorld(mundo, RULES_VERSION, worldContext(mundo));
    const digestoInicial = digestoCanonico(mundo);
    const base = paramsOf(mundo), params = { ...base, motor: { ...base.motor, hilos, gpu } };
    if (gpu.length) assert.ok(!params.v23.materiaGpu, 'El corredor de percepción exige materia en CPU');
    setParams(mundo, params);
    const cargarGuardado = worldContext(mundo).loadChunk;
    const { archivar, archivo } = archivoDeChunks(mundo);
    const cargarArchivado = worldContext(mundo).loadChunk;
    if (cargarGuardado) bindWorldContext(mundo, { loadChunk: (key, tick) => {
      const chunk = cargarArchivado?.(key, tick);
      return chunk && chunk.lastTick <= tick ? chunk : cargarGuardado(key, tick);
    } });
    const revisar = crearComprobador({ cadencia: false });
    const descriptor = fd = openSync(salida, 'wx', 0o600);
    const anotar = (fila: object) => writeSync(descriptor, JSON.stringify(fila) + '\n');
    const pared: number[] = [], cpuProceso: number[] = [], barrera: number[] = [];
    const inicio = { tipo: 'inicio', escena: e, brazo, hilos, commit: git('rev-parse', 'HEAD'), node: process.version,
      digestoInicial, ...siembra, fixture, intervalos: { inicio: mundo.tick, fin: mundo.tick + e.calentar + e.medir },
      interruptores: params.v23, motor: params.motor, carga: loadavg(), planificador: planificador() };
    anotar(inicio);
    motor = crearMotor(mundo, { hilos, gpu, decisionGpu: 'siempre', verificar: false, semilla: mundo.seed, medirBrokerGpu: gpu.length > 0 });
    if (carga) motor.cargar(carga.instantanea, carga.epoca);
    if (gpu.length) {
      const desde = performance.now();
      const disponible = await motor.prepararBrokerGpu?.();
      anotar({ tipo: 'arranqueGpu', disponible: disponible === true, paredMs: performance.now() - desde });
      assert.equal(disponible, true, 'El corredor de GPU0 no está disponible');
    }
    let integridad: Integridad | undefined;
    let anteriorGpu: TelemetriaBrokerGpu | undefined, inicialGpu: TelemetriaBrokerGpu | undefined;
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
      if (!gpu.length) assert.ok(!t.gpuEstado.length && !t.gpuMs.length && !t.gpuBytes.length && !t.gpuBroker, 'Actividad GPU inesperada');
      assert.ok(reparto && reparto.msPorHilo.length === hilos && reparto.msPorHilo.every(ms => Number.isFinite(ms) && ms > 0),
        'El reparto efectivo no acredita la ejecución solicitada');
      for (const [,, dueno] of reparto.paginas) {
        assert.ok(entero(dueno, 0) && dueno < hilos, 'Dueño fuera de rango');
        conPaginas.add(dueno);
      }
      const medido = paso > e.calentar;
      const barreraEmaMs = hilos > 1 ? t.esperaBarreraMs : null;
      const gpuTick = t.gpuBroker && deltaGpu(t.gpuBroker, anteriorGpu);
      anteriorGpu = t.gpuBroker;
      if (paso === e.calentar) inicialGpu = anteriorGpu;
      if (medido) {
        pared.push(paredMs);
        cpuProceso.push(cpuMs);
        if (barreraEmaMs !== null) barrera.push(barreraEmaMs);
      }
      anotar({ tipo: 'tick', tick, medido, paredMs, cpuMs, barreraEmaMs, fasesEmaMs: t.faseMs,
        paginasActivas: reparto.paginas.length, duenoMaxMs: hilos > 1 ? Math.max(...reparto.msPorHilo) : null,
        migraciones: t.migraciones, intentos: t.intentos, rssMiB: process.memoryUsage.rss() / 2 ** 20,
        ...(gpu.length && { gpuEstado: t.gpuEstado[0] ?? 'sin', gpuBroker: gpuTick }) });
      if (paso % 120 === 0 || tick === inicio.intervalos.fin) archivar();
      if (paso === e.calentar || tick === inicio.intervalos.fin) {
        const cargaChunk = motor.muestraCarga();
        assert.ok(cargaChunk && cargaChunk.tick === tick, 'Falta la carga del frente confirmado');
        anotar({ tipo: 'cargaChunk', ...cargaChunk });
        const { world, materia }: Instantanea = motor.instantanea();
        const d = duenoSi(mundo);
        const quimica = d?.quimica;
        assert.ok(d && quimica && materia, 'Falta contexto o checkpoint material');
        const { enviados, recibidos, pendientes } = d.balanceIntentos();
        assert.equal(enviados, recibidos + pendientes, 'Saldo de intentos');
        assertWorld(world, RULES_VERSION, worldContext(mundo));
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
    const gpuVentana = anteriorGpu && deltaGpu(anteriorGpu, inicialGpu);
    acreditarGpu(brazo, gpuVentana, inicialGpu);
    const latencia = tiempos(pared);
    anotar({ tipo: 'fin', estado: 'completo', muestras: pared.length, carga: loadavg(), planificador: planificador(),
      paredMs: latencia, cpuProcesoMs: tiempos(cpuProceso), barreraEmaMs: barrera.length ? tiempos(barrera) : null,
      hz: 1000 / latencia.media, maxRssMiB: process.resourceUsage().maxRSS / 1024,
      duenosConPaginas: [...conPaginas].sort((a, b) => a - b), ...integridad,
      gpuBroker: gpuVentana, gpuBrokerCalentamiento: inicialGpu });
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
      await motor?.cerrar();
      await cerrarPercibidores();
      await closeEcosystemWorkers();
    } finally { cerrar?.(); }
  }
}

function medirBloques(rutaConfig: string, salida: string) {
  const contenido = readFileSync(rutaConfig);
  const config = JSON.parse(contenido.toString('utf8')) as Config;
  const brazos = validacionConfiguracion(config);
  const commit = git('rev-parse', 'HEAD');
  const diferencia = git('diff', '--binary', 'HEAD', '--', 'src', 'scripts', 'package.json', 'package-lock.json');
  const script = fileURLToPath(import.meta.url);
  const instrumentoSha256 = sha256(readFileSync(script));
  mkdirSync(salida, { mode: 0o700 });
  const bloques = [];
  for (const escena of config.escenas) for (let repeticion = 0; repeticion < config.repeticiones; repeticion++) {
    const orden = repeticion % 2 ? [...brazos].reverse() : brazos;
    const corridas = [];
    let origen: { digesto: string; tick: number; fixture?: Preparada['fixture'] } | undefined;
    for (const brazo of orden) {
      const { hilos, gpu } = brazo;
      const nombre = `${escena.id}.r${repeticion + 1}.${brazo.id}.jsonl`;
      const ruta = join(salida, nombre);
      const e = 'fixture' in escena ? { ...escena, fixture: { ...escena.fixture, sqlite: resolve(dirname(rutaConfig), escena.fixture.sqlite) } } : escena;
      const hijo = spawnSync(process.execPath, ['--import', 'tsx', script, '--medir', JSON.stringify(e), JSON.stringify(brazo), ruta],
        { cwd: repo, env: { ...process.env, CARTA_PERCEPCION_DUENOS: gpu.length ? '1' : '0',
          CARTA_PERCEPCION_COSTE_DUENOS: brazo.rutaGpu === 'porCoste' ? '1' : '0' }, stdio: ['ignore', 'inherit', 'inherit'] });
      if (hijo.error) throw hijo.error;
      assert.equal(hijo.status, 0, `Falló ${nombre} (${hijo.signal ?? hijo.status})`);
      const filas = readFileSync(ruta, 'utf8').trimEnd().split('\n').map(linea => JSON.parse(linea));
      const [inicio] = filas, fin = filas.at(-1);
      assert.ok(inicio?.tipo === 'inicio' && inicio.commit === commit && inicio.hilos === hilos, `Cabecera inválida en ${nombre}`);
      assert.deepEqual(inicio.escena, e, `Escena distinta en ${nombre}`);
      assert.deepEqual(inicio.brazo, brazo, `Brazo distinto en ${nombre}`);
      assert.deepEqual(inicio.motor.gpu, gpu, `Dispositivo distinto en ${nombre}`);
      assert.match(inicio.digestoInicial, esSha256, `Huella inicial inválida en ${nombre}`);
      const tickInicial = inicio.intervalos?.inicio;
      assert.ok(entero(tickInicial, 0) && inicio.intervalos.fin === tickInicial + escena.calentar + escena.medir,
        `Intervalo inválido en ${nombre}`);
      if ('fixture' in e) assert.ok(inicio.fixture?.sha256 === e.fixture.sha256 && inicio.fixture.tick === tickInicial &&
        inicio.fixture.reglas === RULES_VERSION, `Procedencia del fixture inválida en ${nombre}`);
      else assert.ok(tickInicial === 0 && inicio.fixture === undefined, `Siembra inválida en ${nombre}`);
      const fuente = { digesto: inicio.digestoInicial, tick: tickInicial, fixture: inicio.fixture };
      origen ??= fuente;
      assert.deepEqual(fuente, origen, `Estado inicial diferente en ${nombre}`);
      const medidas = filas.filter(fila => fila.tipo === 'tick' && fila.medido === true);
      assert.ok(fin?.tipo === 'fin' && fin.estado === 'completo' && fin.muestras === escena.medir &&
        medidas.length === escena.medir && fin.tick === inicio.intervalos.fin && fin.conservacion === true &&
        Array.isArray(fin.violaciones) && fin.violaciones.length === 0, `Cierre inválido en ${nombre}`);
      assert.ok(medidas.every((fila, i) => fila.tick === tickInicial + escena.calentar + i + 1), `Ventana incompleta en ${nombre}`);
      assert.deepEqual(fin.paredMs, tiempos(medidas.map(fila => fila.paredMs)), `Percentiles inconsistentes en ${nombre}`);
      acreditarGpu(brazo, fin.gpuBroker, fin.gpuBrokerCalentamiento);
      corridas.push({ brazo: brazo.id, hilos, gpu, rutaGpu: brazo.rutaGpu, jsonl: nombre, cargaInicial: inicio.carga, ...fin });
    }
    const referencia = corridas.find(corrida => corrida.brazo === brazos[0]!.id)!;
    bloques.push({ escena: escena.id, repeticion: repeticion + 1, digestoInicial: origen!.digesto, tickInicial: origen!.tick,
      fixture: origen!.fixture, corridas: corridas.map(corrida => ({
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
  await medir(JSON.parse(args[1]!), JSON.parse(args[2]!), args[3]!);
} else {
  assert.equal(args.length, 2, 'Uso: node --import tsx scripts/perf/banco-motor-v24.mts ESCENAS.json DIRECTORIO_NUEVO');
  medirBloques(resolve(args[0]!), resolve(args[1]!));
}
