/**
 * Banco corto con el coordinador real. Ejecuta desde una copia de trabajo de Atlas.
 *
 *   node --import tsx scripts/perf/banco-motor-v24.mts ESCENAS.json DIRECTORIO_NUEVO
 *
 * Configuración de ejemplo (en el banco de escala, elige ventanas más largas):
 * {
 *   "hilos": [1, 2], "repeticiones": 1, "perfilPaso": true,
 *   "escenas": [{"id":"smoke", "semilla":7, "siembra":7, "n":20,
 *                "zona":"0,0,48,32", "calentar":1, "medir":3}]
 * }
 * Para comparar CUDA, reemplaza `hilos` por `brazos` y pasa `COMPUTE_NVRTC`:
 * [{"id":"cpu1","hilos":1,"gpu":[]},{"id":"cpu2","hilos":2,"gpu":[]},
 *  {"id":"gpu0-cpu2","hilos":2,"gpu":[0]},{"id":"gpu1-cpu2","hilos":2,"gpu":[1]},
 *  {"id":"dual-cpu2","hilos":2,"gpu":[0,1]},
 *  {"id":"dual-cpu4","hilos":4,"gpu":[0,1],"duenosPercepcionGpu":[2,3]}]
 * Sin asignación explícita se usan dos dueños. Una sola GPU atiende ambos y, con dos, cada dueño usa la de
 * su índice. `duenosPercepcionGpu` fija un dueño global distinto por tarjeta, en el orden de `gpu`.
 * Las siembras con CUDA requieren al menos un tick de calentamiento para abrir todos los motores antes de medir.
 * `"rutaGpu":"porCoste"` añade un brazo adaptativo. Cada GPU del brazo fijo debe entregar
 * resultados aceptados por F2 durante la ventana. El adaptativo puede elegir CPU si F2
 * aceptó resultados de esa GPU durante la calibración.
 * Para medir desde un mundo ya crecido, prepara una copia de laboratorio con
 * `CARTA_DATA_DIR=/ruta/laboratorio npm run backup -- copia.sqlite` y calcula su SHA-256.
 * En la escena reemplaza `semilla`, `siembra`, `n` y `zona` por
 * `"fixture":{"sqlite":"copia.sqlite","sha256":"<64 hex>"}`. La ruta relativa se resuelve
 * desde ESCENAS.json. El guardado debe contener materia, la cabeza vigente y la ley de dueños.
 * Cada brazo carga una copia desechable y conserva sus parámetros salvo hilos y GPU.
 * `rebalanceo:false` en una escena ignora el coste de pared al reasignar páginas.
 * Las huellas de cierre permiten detectar divergencias entre brazos y repeticiones.
 *
 * El primer brazo es la referencia. Cada bloque comparte el mismo estado y alterna el
 * orden de ejecución. `resumen.json` distingue el arranque, la actividad y la degradación de cada brazo CUDA.
 * Las aceleraciones requieren un brazo y una referencia completos. Cada JSONL conserva los tiempos brutos.
 * `perfilPaso` añade fases crudas y esperas del coordinador. Sus lecturas forman parte del tiempo medido.
 * El libro y la carga por chunk se comprueban al salir del
 * calentamiento y al final, fuera de la medición. `mortalesVivos` excluye figuras protegidas, `paginasActivas` cuenta
 * páginas del motor y `chunksArchivados` cuenta copias retenidas en RAM durante la corrida,
 * incluidas las de chunks que se hayan reactivado. En fixtures, el archivo SQLite previo
 * sigue accesible desde la copia. La medición se limita al motor, incluido el corredor cuando
 * se solicita. Cada GPU registra confirmaciones del canal, sus bytes y tiempo, resultados
 * aceptados por F2, rechazos y desvíos a CPU. El tiempo CUDA incluye copias y ejecución en el servidor.
 * `cpuProcesoMs` y `maxRssMiB` corresponden al proceso Node y sus hilos.
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
import { admiteBrokerPercepcionGpu, resolverDuenosPercepcionGpu } from '../../src/world/gpu/broker-percepcion.js';
import { assertWorld, createWorld, RULES_VERSION, type World } from '../../src/world/index.js';
import { comprobarLeyes, crearComprobador } from '../../src/world/invariantes.js';
import { codificarCheckpoint, decodificarCheckpoint } from '../../src/world/materia/checkpoint.js';
import { enlazarCtx } from '../../src/world/motor/acceso.js';
import { duenoSi } from '../../src/world/motor/contexto.js';
import type { Instantanea, Motor, PerfilPasoMotor, TelemetriaBrokerGpu, TelemetriaDispositivoBrokerGpu, TelemetriaMotor } from '../../src/world/motor/contratos.js';
import { crearMotor } from '../../src/world/motor/coordinador.js';
import { paramsOf, setParams } from '../../src/world/params.js';
import { bindWorldContext, worldContext } from '../../src/world/spatial.js';

type Escena = { id: string; calentar: number; medir: number; rebalanceo?: boolean } & (
  { semilla: number; siembra: number; n: number; zona: string } | { fixture: { sqlite: string; sha256: string } });
interface Brazo { id: string; hilos: number; gpu: number[]; rutaGpu?: 'porCoste'; duenosPercepcionGpu?: number[] }
interface ArranqueDispositivo { dispositivo: number; disponible: boolean }
interface Config { hilos?: number[]; brazos?: Brazo[]; repeticiones: number; escenas: Escena[]; perfilPaso?: boolean }
interface Integridad {
  tick: number; mortalesVivos: number; faunaResidente: number; paginasActivas: number; chunksArchivados: number;
  digestoMundo: string; digestoMateria: string;
  conservacion: true; violaciones: ReturnType<typeof comprobarLeyes>;
}

const repo = fileURLToPath(new URL('../../', import.meta.url));
const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const entero = (n: number, minimo: number): boolean => Number.isSafeInteger(n) && n >= minimo;
const sha256 = (contenido: Uint8Array): string => createHash('sha256').update(contenido).digest('hex');
const esSha256 = /^[a-f0-9]{64}$/;
const esId = /^[a-z0-9][a-z0-9_-]*$/;

export function validacionConfiguracion(config: Config): Brazo[] {
  assert.ok(config && (Array.isArray(config.hilos) ? config.brazos === undefined : config.hilos === undefined && Array.isArray(config.brazos)),
    'Indica hilos o brazos');
  const brazos: Brazo[] = config.brazos ?? config.hilos!.map(hilos => ({ id: `h${hilos}`, hilos, gpu: [] }));
  assert.ok(brazos.length >= 2 && brazos.every(b => b && typeof b.id === 'string' && esId.test(b.id) &&
    entero(b.hilos, 1) && b.hilos <= availableParallelism() && Array.isArray(b.gpu) &&
    (b.duenosPercepcionGpu === undefined || Array.isArray(b.duenosPercepcionGpu)) &&
    (b.gpu.length === 0 ? b.duenosPercepcionGpu === undefined : admiteBrokerPercepcionGpu(b.hilos, b.gpu, b.duenosPercepcionGpu)) &&
    (b.rutaGpu === undefined || b.rutaGpu === 'porCoste' && b.gpu.length > 0)),
  'Indica al menos dos brazos CPU o CUDA [0], [1] o [0,1] con un mapeo de dueños válido');
  assert.equal(new Set(brazos.map(b => b.id)).size, brazos.length, 'IDs de brazos repetidos');
  assert.equal(new Set(brazos.map(b => JSON.stringify([b.hilos, b.gpu, b.rutaGpu,
    resolverDuenosPercepcionGpu(b.hilos, b.gpu, b.duenosPercepcionGpu)]))).size, brazos.length,
    'Configuraciones de brazos repetidas');
  assert.ok(entero(config.repeticiones, 1), 'repeticiones debe ser un entero positivo');
  assert.ok(config.perfilPaso === undefined || typeof config.perfilPaso === 'boolean', 'perfilPaso debe ser booleano');
  const conCuda = brazos.some(brazo => brazo.gpu.length > 0);
  assert.ok(Array.isArray(config.escenas) && config.escenas.length > 0, 'Faltan escenas');
  for (const e of config.escenas) {
    assert.ok(e && typeof e.id === 'string' && esId.test(e.id), 'ID de escena inválido');
    assert.ok(e.rebalanceo === undefined || typeof e.rebalanceo === 'boolean', `Rebalanceo inválido en ${e.id}`);
    if ('fixture' in e) {
      assert.ok(typeof e.fixture?.sqlite === 'string' && e.fixture.sqlite.length > 0 &&
        typeof e.fixture.sha256 === 'string' && esSha256.test(e.fixture.sha256) &&
        !['semilla', 'siembra', 'n', 'zona'].some(campo => campo in e), `Fixture inválido en ${e.id}`);
    } else {
      assert.ok(entero(e.semilla, 0) && entero(e.siembra, 0) && entero(e.n, 1), `Siembra inválida en ${e.id}`);
      assert.ok(typeof e.zona === 'string', `Falta la zona de ${e.id}`);
      zona(e.zona);
      if (conCuda) assert.ok(entero(e.calentar, 1), `La siembra ${e.id} requiere calentamiento para comparar CUDA`);
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

function resumenPerfilPaso(perfiles: readonly PerfilPasoMotor[]) {
  const primero = perfiles[0]!;
  const fase = (leer: (perfil: PerfilPasoMotor) => number | null) => {
    const muestras = perfiles.map(leer);
    return muestras.every(ms => ms !== null) ? tiempos(muestras) : null;
  };
  const fasesDueno = ['F1', 'eco', 'F2', 'F3F4', 'F3', 'F4', 'F5', 'F6'] as const;
  return {
    paredMs: fase(p => p.paredMs), F0Ms: fase(p => p.F0Ms), cierreMs: fase(p => p.cierreMs),
    tramos: primero.tramos.map(({ tramo }, i) => ({ tramo,
      paredMs: fase(p => p.tramos[i]!.paredMs), esperaCoordinadorMs: fase(p => p.tramos[i]!.esperaCoordinadorMs),
    })),
    fasesPorDuenoMs: primero.fasesPorDuenoMs.map((_, dueno) =>
      Object.fromEntries(fasesDueno.map(nombre => [nombre, fase(p => p.fasesPorDuenoMs[dueno]![nombre])]))),
  };
}

function deltaGpu(fin: TelemetriaBrokerGpu, inicio?: TelemetriaBrokerGpu): TelemetriaBrokerGpu {
  const { completadas, aceptadas, ...contadores } = fin;
  const campos = Object.keys(contadores) as (keyof typeof contadores)[];
  const restar = (total: [number, number], previo?: [number, number]): [number, number] =>
    [total[0] - (previo?.[0] ?? 0), total[1] - (previo?.[1] ?? 0)];
  const delta = { ...fin, completadas: restar(completadas, inicio?.completadas),
    aceptadas: restar(aceptadas, inicio?.aceptadas) };
  for (const campo of campos) delta[campo] = contadores[campo]! - (inicio?.[campo] ?? 0);
  assert.ok(campos.every(campo => entero(delta[campo] ?? NaN, 0)) &&
    delta.completadas.every((n, i) => entero(n, 0) && entero(delta.aceptadas[i]!, 0) && delta.aceptadas[i]! <= n),
  'Contadores CUDA incoherentes');
  return delta;
}

function deltaBrokersGpu(fin: TelemetriaDispositivoBrokerGpu[] = [], inicio: TelemetriaDispositivoBrokerGpu[] = []) {
  return fin.map(tarjeta => ({
    ...tarjeta,
    detalle: tarjeta.detalle && deltaGpu(tarjeta.detalle, inicio.find(anterior => anterior.dispositivo === tarjeta.dispositivo)?.detalle),
  }));
}

function comprobarRanurasGpu(tarjeta: TelemetriaDispositivoBrokerGpu, esperadas: readonly [number | null, number | null],
  explicito: boolean): void {
  const { dispositivo, duenosPorRanura, detalle } = tarjeta;
  if (explicito || duenosPorRanura !== undefined)
    assert.deepEqual(duenosPorRanura, esperadas, `Mapeo por ranura GPU${dispositivo} distinto del solicitado`);
  if (detalle) for (const [ranura, dueno] of esperadas.entries()) {
    if (dueno === null) assert.ok(detalle.completadas[ranura] === 0 && detalle.aceptadas[ranura] === 0,
      `GPU${dispositivo} sirvió una ranura sin dueño`);
  }
}

export function acreditarGpu(brazo: Brazo, ventana: TelemetriaDispositivoBrokerGpu[] = [], calentamiento: TelemetriaDispositivoBrokerGpu[] = []) {
  assert.deepEqual(ventana.map(d => d.dispositivo), brazo.gpu, 'Telemetría CUDA de otros dispositivos');
  const explicito = brazo.duenosPercepcionGpu !== undefined;
  const mapeo = resolverDuenosPercepcionGpu(brazo.hilos, brazo.gpu, brazo.duenosPercepcionGpu);
  assert.ok(brazo.gpu.length ? mapeo : !explicito, 'Mapeo CUDA inválido para el brazo');
  if (calentamiento.length) assert.deepEqual(calentamiento.map(d => d.dispositivo), brazo.gpu, 'Calentamiento CUDA de otros dispositivos');
  const adaptativo = brazo.rutaGpu === 'porCoste';
  const acepto = (d?: TelemetriaBrokerGpu): boolean =>
    !!d && d.aceptadas.some(n => n > 0) && d.subidaConfirmadaBytes > 0 && d.bajadaConfirmadaBytes > 0;
  const sinGpu: number[] = [], gpuDegradadas: number[] = [];
  ventana.forEach((tarjeta, i) => {
    const { detalle, dispositivo, lista } = tarjeta;
    const previa = calentamiento[i], antes = previa?.detalle;
    assert.ok(detalle && (detalle.cpuPorCoste !== undefined) === adaptativo, `Faltan contadores de GPU${dispositivo}`);
    comprobarRanurasGpu(tarjeta, mapeo![i]!, explicito);
    if (previa) comprobarRanurasGpu(previa, mapeo![i]!, explicito);
    if (!lista || detalle.erroresCanal > 0 || detalle.cpuSinCanal > 0) gpuDegradadas.push(dispositivo);
    if (!acepto(detalle) && !(adaptativo && detalle.cpuPorCoste! > 0 && acepto(antes))) sinGpu.push(dispositivo);
  });
  return { estado: gpuDegradadas.length ? 'gpu-degradada' : sinGpu.length ? 'sin-actividad-gpu' : 'completo', sinGpu, gpuDegradadas };
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

async function medir(e: Escena, brazo: Brazo, salida: string, perfilPaso: boolean) {
  const { hilos, gpu, duenosPercepcionGpu } = brazo;
  const duenosPorRanura = resolverDuenosPercepcionGpu(hilos, gpu, duenosPercepcionGpu);
  assert.ok(gpu.length ? duenosPorRanura : duenosPercepcionGpu === undefined, 'Mapeo CUDA inválido para el brazo');
  const { mundo, siembra, fixture, carga, cerrar } = await preparar(e, dirname(salida));
  let fd: number | undefined;
  let motor: Motor | undefined;
  try {
    assertWorld(mundo, RULES_VERSION, worldContext(mundo));
    const digestoInicial = digestoCanonico(mundo);
    const base = paramsOf(mundo), params = { ...base, motor: { ...base.motor, hilos, gpu },
      v23: { ...base.v23, rebalanceo: e.rebalanceo ?? base.v23.rebalanceo } };
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
    const inicio = { tipo: 'inicio', escena: e, brazo, hilos, duenosPorRanura, perfilPaso, commit: git('rev-parse', 'HEAD'), node: process.version,
      digestoInicial, ...siembra, fixture, intervalos: { inicio: mundo.tick, fin: mundo.tick + e.calentar + e.medir },
      interruptores: params.v23, motor: params.motor, carga: loadavg(), planificador: planificador() };
    anotar(inicio);
    const biblioteca = process.env.COMPUTE_NVRTC;
    const conNvrtc = !!biblioteca && existsSync(biblioteca);
    if (!gpu.length || conNvrtc) {
      motor = crearMotor(mundo, { hilos, gpu, duenosPercepcionGpu, decisionGpu: 'siempre', verificar: false, semilla: mundo.seed,
        medirBrokerGpu: gpu.length > 0, medirPaso: perfilPaso });
      if (carga) motor.cargar(carga.instantanea, carga.epoca);
    }
    if (gpu.length) {
      const desde = performance.now();
      await motor?.prepararBrokerGpu?.();
      const brokers = motor?.telemetria().gpuBrokers ?? [];
      const dispositivos = gpu.map(dispositivo => ({ dispositivo,
        disponible: brokers.some(tarjeta => tarjeta.dispositivo === dispositivo && tarjeta.lista) }));
      const sinGpu = dispositivos.filter(tarjeta => !tarjeta.disponible).map(tarjeta => tarjeta.dispositivo);
      const disponible = sinGpu.length === 0;
      anotar({ tipo: 'arranqueGpu', disponible, dispositivos, paredMs: performance.now() - desde });
      if (!disponible) {
        anotar({ tipo: 'fin', estado: 'sin-arranque-gpu', sinGpu,
          motivo: conNvrtc ? 'El corredor no confirmó el arranque' : 'Falta una biblioteca válida en COMPUTE_NVRTC' });
        return;
      }
    }
    assert.ok(motor, 'Falta el motor de la corrida');
    let integridad: Integridad | undefined;
    let anteriorGpu: TelemetriaDispositivoBrokerGpu[] | undefined, inicialGpu: TelemetriaDispositivoBrokerGpu[] | undefined;
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
      if (!gpu.length) assert.ok(!t.gpuEstado.length && !t.gpuMs.length && !t.gpuBytes.length && !t.gpuBrokers, 'Actividad GPU inesperada');
      assert.ok(reparto && reparto.msPorHilo.length === hilos && reparto.msPorHilo.every(ms => Number.isFinite(ms) && ms > 0),
        'El reparto efectivo no acredita la ejecución solicitada');
      for (const [,, dueno] of reparto.paginas) {
        assert.ok(entero(dueno, 0) && dueno < hilos, 'Dueño fuera de rango');
        conPaginas.add(dueno);
      }
      const medido = paso > e.calentar;
      const barreraEmaMs = hilos > 1 ? t.esperaBarreraMs : null;
      const perfil = perfilPaso ? motor.muestraPerfilPaso() : undefined;
      if (perfilPaso) assert.ok(perfil?.tick === tick && perfil.epoca === (carga?.epoca ?? 0), 'Perfil de otro tick o época');
      const gpuTick = t.gpuBrokers && deltaBrokersGpu(t.gpuBrokers, anteriorGpu);
      anteriorGpu = t.gpuBrokers;
      if (paso === e.calentar) inicialGpu = anteriorGpu;
      if (medido) {
        pared.push(paredMs);
        cpuProceso.push(cpuMs);
        if (barreraEmaMs !== null) barrera.push(barreraEmaMs);
      }
      anotar({ tipo: 'tick', tick, medido, paredMs, cpuMs, barreraEmaMs, fasesEmaMs: t.faseMs,
        paginasActivas: reparto.paginas.length, duenoMaxMs: hilos > 1 ? Math.max(...reparto.msPorHilo) : null,
        migraciones: t.migraciones, intentos: t.intentos, rssMiB: process.memoryUsage.rss() / 2 ** 20,
        ...(perfil && { perfilPaso: perfil }),
        ...(gpu.length && { gpuEstado: t.gpuEstado, gpuBrokers: gpuTick }) });
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
        const codificado = codificarCheckpoint(materia);
        decodificarCheckpoint(codificado, id => quimica.sustancia(id));
        if (world !== mundo) enlazarCtx(world, d);
        const violaciones: Integridad['violaciones'] = [...revisar(world), ...comprobarLeyes(mundo, d.leyes)];
        assert.equal(violaciones.length, 0, JSON.stringify(violaciones));
        integridad = { tick, mortalesVivos: world.people.filter(p => p.role === 'neighbor').length,
          faunaResidente: world.animals.length, paginasActivas: reparto.paginas.length,
          chunksArchivados: archivo.size, digestoMundo: digestoCanonico(world), digestoMateria: sha256(codificado),
          conservacion: true, violaciones };
        anotar({ tipo: 'integridad', ...integridad });
      }
    }
    assert.ok(integridad?.tick === inicio.intervalos.fin && conPaginas.size > 0, 'Falta evidencia de cierre');
    const gpuVentana = anteriorGpu && deltaBrokersGpu(anteriorGpu, inicialGpu);
    const { estado, sinGpu, gpuDegradadas } = acreditarGpu(brazo, gpuVentana, inicialGpu);
    const latencia = tiempos(pared);
    anotar({ tipo: 'fin', estado, muestras: pared.length, ...(sinGpu.length && { sinGpu }),
      ...(gpuDegradadas.length && { gpuDegradadas }), carga: loadavg(), planificador: planificador(),
      paredMs: latencia, cpuProcesoMs: tiempos(cpuProceso), barreraEmaMs: barrera.length ? tiempos(barrera) : null,
      hz: 1000 / latencia.media, maxRssMiB: process.resourceUsage().maxRSS / 1024,
      duenosConPaginas: [...conPaginas].sort((a, b) => a - b), ...integridad,
      gpuBrokers: gpuVentana, gpuBrokersCalentamiento: inicialGpu });
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
  const perfilPaso = config.perfilPaso === true;
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
      const { hilos, gpu, duenosPercepcionGpu } = brazo;
      const duenosPorRanura = resolverDuenosPercepcionGpu(hilos, gpu, duenosPercepcionGpu);
      const nombre = `${escena.id}.r${repeticion + 1}.${brazo.id}.jsonl`;
      const ruta = join(salida, nombre);
      const e = 'fixture' in escena ? { ...escena, fixture: { ...escena.fixture, sqlite: resolve(dirname(rutaConfig), escena.fixture.sqlite) } } : escena;
      const hijo = spawnSync(process.execPath, ['--import', 'tsx', script, '--medir', JSON.stringify(e), JSON.stringify(brazo), ruta, perfilPaso ? '1' : '0'],
        { cwd: repo, env: { ...process.env, CARTA_PERCEPCION_DUENOS: gpu.length ? '1' : '0',
          CARTA_PERCEPCION_COSTE_DUENOS: brazo.rutaGpu === 'porCoste' ? '1' : '0' }, stdio: ['ignore', 'inherit', 'inherit'] });
      if (hijo.error) throw hijo.error;
      assert.equal(hijo.status, 0, `Falló ${nombre} (${hijo.signal ?? hijo.status})`);
      const filas = readFileSync(ruta, 'utf8').trimEnd().split('\n').map(linea => JSON.parse(linea));
      const [inicio] = filas, fin = filas.at(-1);
      assert.ok(inicio?.tipo === 'inicio' && inicio.commit === commit && inicio.hilos === hilos, `Cabecera inválida en ${nombre}`);
      assert.equal(inicio.perfilPaso, perfilPaso, `Modo de perfil distinto en ${nombre}`);
      assert.deepEqual(inicio.escena, e, `Escena distinta en ${nombre}`);
      assert.deepEqual(inicio.brazo, brazo, `Brazo distinto en ${nombre}`);
      assert.deepEqual(inicio.motor.gpu, gpu, `Dispositivo distinto en ${nombre}`);
      assert.deepEqual(inicio.duenosPorRanura, duenosPorRanura, `Mapeo CUDA distinto en ${nombre}`);
      if (escena.rebalanceo !== undefined) assert.equal(inicio.interruptores.rebalanceo, escena.rebalanceo,
        `Rebalanceo distinto en ${nombre}`);
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
      const corrida = { brazo: brazo.id, hilos, gpu, duenosPercepcionGpu, duenosPorRanura,
        rutaGpu: brazo.rutaGpu, jsonl: nombre, cargaInicial: inicio.carga, ...fin };
      if (fin?.estado === 'sin-arranque-gpu') {
        const arranque = filas.find(fila => fila.tipo === 'arranqueGpu');
        assert.ok(fin.tipo === 'fin' && gpu.length && arranque?.disponible === false && fin.sinGpu?.length, `Arranque inválido en ${nombre}`);
        const dispositivos = arranque.dispositivos as ArranqueDispositivo[];
        assert.deepEqual(dispositivos.map(d => d.dispositivo), gpu);
        assert.deepEqual(dispositivos.filter(d => !d.disponible).map(d => d.dispositivo), fin.sinGpu);
        corridas.push(corrida);
        continue;
      }
      const medidas = filas.filter(fila => fila.tipo === 'tick' && fila.medido === true);
      assert.ok(fin?.tipo === 'fin' && fin.muestras === escena.medir &&
        medidas.length === escena.medir && fin.tick === inicio.intervalos.fin && fin.conservacion === true &&
        Array.isArray(fin.violaciones) && fin.violaciones.length === 0, `Cierre inválido en ${nombre}`);
      assert.ok(medidas.every((fila, i) => fila.tick === tickInicial + escena.calentar + i + 1), `Ventana incompleta en ${nombre}`);
      assert.deepEqual(fin.paredMs, tiempos(medidas.map(fila => fila.paredMs)), `Percentiles inconsistentes en ${nombre}`);
      assert.match(fin.digestoMundo, esSha256, `Falta la huella final del mundo en ${nombre}`);
      assert.match(fin.digestoMateria, esSha256, `Falta la huella final de materia en ${nombre}`);
      const { estado, sinGpu, gpuDegradadas } = acreditarGpu(brazo, fin.gpuBrokers, fin.gpuBrokersCalentamiento);
      assert.equal(fin.estado, estado);
      assert.deepEqual(fin.sinGpu ?? [], sinGpu);
      assert.deepEqual(fin.gpuDegradadas ?? [], gpuDegradadas);
      corridas.push(perfilPaso ? { ...corrida, perfilPaso: resumenPerfilPaso(medidas.map(fila => fila.perfilPaso)) } : corrida);
    }
    const referencia = corridas.find(corrida => corrida.brazo === brazos[0]!.id && corrida.estado === 'completo');
    bloques.push({ escena: escena.id, repeticion: repeticion + 1, digestoInicial: origen!.digesto, tickInicial: origen!.tick,
      fixture: origen!.fixture, corridas: corridas.map(corrida => ({
      ...corrida, ...(referencia && corrida.estado === 'completo' && {
        aceleracionMedia: referencia.paredMs.media / corrida.paredMs.media,
        aceleracionP95: referencia.paredMs.p95 / corrida.paredMs.p95,
      }),
    })) });
  }
  assert.equal(git('rev-parse', 'HEAD'), commit, 'Cambió el commit durante la medición');
  assert.equal(git('diff', '--binary', 'HEAD', '--', 'src', 'scripts', 'package.json', 'package-lock.json'), diferencia,
    'Cambió el código durante la medición');
  assert.equal(sha256(readFileSync(script)), instrumentoSha256, 'Cambió el instrumento durante la medición');
  writeFileSync(join(salida, 'resumen.json'), JSON.stringify({ version: 4, commit, perfilPaso, configSha256: sha256(contenido),
    instrumentoSha256, diffSha256: sha256(Buffer.from(diferencia)), arbolLimpio: git('status', '--porcelain', '--', 'src', 'scripts',
      'package.json', 'package-lock.json') === '', config, bloques }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args[0] === '--medir') {
    assert.ok(args.length === 5 && (args[4] === '0' || args[4] === '1'));
    await medir(JSON.parse(args[1]!), JSON.parse(args[2]!), args[3]!, args[4] === '1');
  } else {
    assert.equal(args.length, 2, 'Uso: node --import tsx scripts/perf/banco-motor-v24.mts ESCENAS.json DIRECTORIO_NUEVO');
    medirBloques(resolve(args[0]!), resolve(args[1]!));
  }
}
