/** Puerta de motor de 8 semillas × 30 días. Ver --help. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { OpcionesEncender } from '../encender.mjs';
import type { WorldParams } from '../../../src/world/params.js';
import { DEMOGRAPHY_TICKS_PER_DAY as TICKS_DIA } from '../../../src/shared/demography.js';
import { NE } from '../../../src/shared/naturaleza.js';

const SEMILLAS = [7, 51926, 19101, 19102, 19103, 19104, 19105, 19106];
const DIAS = 30, MINIMO_VIVAS = 6;
const ENCENDER = 'scripts/lab/encender.mts';
const PARAMS_DEMO = 'motor.soaTerreno=false,motor.particionarPersonas=false,motor.clonPorPaso=true,persistencia.cadaTicks=200,persistencia.ventanaEventosTicks=2400,red.deltas=true';
const archivoPuerta = fileURLToPath(import.meta.url);
const raizPuerta = fileURLToPath(new URL('../../..', import.meta.url));
const hash = (dato: Buffer | string) => createHash('sha256').update(dato).digest('hex');
const json = (ruta: string) => JSON.parse(readFileSync(ruta, 'utf8')) as unknown;
const inmutable = (ruta: string, datos: Buffer | string) => writeFileSync(ruta, datos, { mode: 0o600, flag: 'wx' });
const entero = (n: unknown, min = 0): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min;
const objeto = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

function canonico(dato: unknown): string {
  if (Array.isArray(dato)) return `[${dato.map(canonico).join(',')}]`;
  if (objeto(dato)) return `{${Object.keys(dato).sort().map(k => `${JSON.stringify(k)}:${canonico(dato[k])}`).join(',')}}`;
  return JSON.stringify(dato);
}

type Opciones = Pick<OpcionesEncender, 'regimen' | 'hasta' | 'hilos' | 'cada' | 'ticks'>;
interface Manifiesto {
  tipo: 'atlas-puerta-motor-v1';
  producto: string;
  encenderSha: string;
  puertaSha: string;
  perfil: 'entorno' | 'manual';
  modo: 'puerta' | 'prueba';
  opciones: Opciones & { ticks: number; hilos: number; cada: number };
  params: WorldParams;
  paramsSha: string;
  ticksDia: number;
  anchoSaldo: number;
  mortalesIniciales: number;
  leyes: string[];
  interruptores: string[];
  invariantes: string[];
}

const rutaProducto = (raiz: string, ruta: string) => pathToFileURL(join(raiz, ruta)).href;
const encenderDe = (raiz: string): Promise<typeof import('../encender.mjs')> => import(rutaProducto(raiz, ENCENDER));
function identidad(raiz: string) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: raiz, encoding: 'utf8' }).trim();
  assert.equal(resolve(git('rev-parse', '--show-toplevel')), raiz, 'Indica la raíz exacta del producto.');
  // El arnés puede vivir junto al producto durante la revisión. Su propio contenido se sella aparte.
  const cambios = git('status', '--porcelain', '--', '.', ':(exclude)scripts/lab/panel-demo.sh',
    ':(exclude)scripts/lab/panel-demo/puerta.mts');
  assert.equal(cambios, '', 'El árbol del producto debe corresponder íntegramente a su commit.');
  return { producto: git('rev-parse', 'HEAD'), encenderSha: hash(readFileSync(join(raiz, ENCENDER))),
    puertaSha: hash(readFileSync(archivoPuerta)) };
}

function leerManifiesto(datos: Buffer): Manifiesto {
  const m = JSON.parse(datos.toString('utf8')) as Manifiesto;
  assert.ok(m && m.tipo === 'atlas-puerta-motor-v1' && ['entorno', 'manual'].includes(m.perfil));
  assert.match(m.producto, /^[a-f0-9]{40}$/);
  for (const sha of [m.encenderSha, m.puertaSha, m.paramsSha]) assert.match(sha, /^[a-f0-9]{64}$/);
  assert.equal(m.ticksDia, TICKS_DIA);
  assert.equal(m.anchoSaldo, NE + 1);
  assert.ok(entero(m.mortalesIniciales, 1), 'Falta la cohorte mortal inicial.');
  const o = m.opciones;
  assert.ok(o && ['abierto', 'defecto'].includes(o.regimen) && entero(o.hilos, 1) && entero(o.cada, 1));
  assert.ok(o.hasta === undefined || typeof o.hasta === 'string');
  assert.ok((m.modo === 'puerta' && o.ticks === DIAS * m.ticksDia)
    || (m.modo === 'prueba' && (o.ticks === 1 || o.ticks === 2)), 'Horizonte inválido.');
  assert.ok(objeto(m.params) && m.params.v23?.materia && !m.params.v23.materiaGpu
    && m.params.motor.hilos === o.hilos && m.params.motor.gpu.length === 0, 'Se requiere materia y motor CPU.');
  assert.equal(hash(canonico(m.params)), m.paramsSha, 'Params alterados.');
  for (const lista of [m.leyes, m.interruptores, m.invariantes]) assert.ok(Array.isArray(lista) && lista.length
    && lista.every(x => typeof x === 'string'));
  return m;
}

function opcionesDe(m: Manifiesto, semilla: number): OpcionesEncender {
  return { ...m.opciones, semilla, dias: DIAS, comprobar: true, continuar: false, params: canonico(m.params) };
}

async function fijar(args: string[]) {
  const { values: v } = parseArgs({ args, options: {
    salida: { type: 'string' }, 'repo-producto': { type: 'string' }, params: { type: 'string' }, hasta: { type: 'string' },
    hilos: { type: 'string' }, cada: { type: 'string' }, regimen: { type: 'string' },
    'perfil-entorno': { type: 'boolean' }, 'ticks-prueba': { type: 'string' },
  } });
  assert.ok(v.salida, 'Falta --salida.');
  const raiz = realpathSync(v['repo-producto'] ?? raizPuerta);
  const id = identidad(raiz);
  const modulo = await encenderDe(raiz);
  const [{ LEYES }, { INTERRUPTORES }, { listaInvariantes }] = await Promise.all([
    import(rutaProducto(raiz, 'src/world/motor/leyes.ts')),
    import(rutaProducto(raiz, 'src/shared/interruptores.ts')),
    import(rutaProducto(raiz, 'src/world/invariantes.ts')),
  ]) as [{ LEYES: typeof import('../../../src/world/motor/leyes.js').LEYES },
    { INTERRUPTORES: typeof import('../../../src/shared/interruptores.js').INTERRUPTORES },
    typeof import('../../../src/world/invariantes.js')];
  const entorno = v['perfil-entorno'] === true;
  assert.ok(!entorno || (v.params === undefined && v.regimen === undefined && v.hilos === undefined && v.hasta === undefined),
    'El perfil del entorno no se mezcla con --params, --regimen, --hilos ni --hasta.');
  const cli = [ '--regimen', entorno ? (process.env.CARTA_OPEN_WORLD === '1' ? 'abierto' : 'defecto') : v.regimen ?? 'abierto',
    '--hilos', entorno ? process.env.CARTA_MOTOR_HILOS ?? '1' : v.hilos ?? '1', '--cada', v.cada ?? '120' ];
  if (!entorno && v.hasta !== 'exacto') cli.push('--hasta', v.hasta ?? 'intentos');
  const o = modulo.argumentosEncender(cli);
  let base = v.params ?? PARAMS_DEMO;
  if (entorno) {
    assert.ok(!process.env.CARTA_MOTOR_GPU?.trim(), 'El perfil de motor debe usar CPU.');
    const { paramsNuevosDeDespliegue } = await import(rutaProducto(raiz, 'src/server/deployment-params.ts')) as
      typeof import('../../../src/server/deployment-params.js');
    base = canonico(paramsNuevosDeDespliegue());
  } else if (existsSync(base)) base = readFileSync(base, 'utf8');
  const params = modulo.paramsDeEncender({ ...o, params: base, gpu: [] });
  const { createWorld } = await import(rutaProducto(raiz, 'src/world/index.ts')) as typeof import('../../../src/world/index.js');
  const mortalesIniciales = createWorld(SEMILLAS[0], params).people.filter(p => p.role === 'neighbor').length;
  const ticks = v['ticks-prueba'] === undefined ? DIAS * TICKS_DIA : Number(v['ticks-prueba']);
  const manifiesto: Manifiesto = {
    tipo: 'atlas-puerta-motor-v1', ...id, perfil: entorno ? 'entorno' : 'manual',
    modo: v['ticks-prueba'] === undefined ? 'puerta' : 'prueba',
    opciones: { regimen: o.regimen, hasta: o.hasta, ticks, hilos: o.hilos!, cada: o.cada! },
    params, paramsSha: hash(canonico(params)), ticksDia: TICKS_DIA, anchoSaldo: NE + 1, mortalesIniciales,
    leyes: LEYES.filter(l => params.v23[l.interruptor]).map(l => l.id),
    interruptores: INTERRUPTORES.filter(i => params.v23[i]),
    invariantes: listaInvariantes().map(i => i.id),
  };
  const datos = Buffer.from(JSON.stringify(manifiesto, null, 2) + '\n');
  leerManifiesto(datos);
  assert.equal(canonico(modulo.paramsDeEncender(opcionesDe(manifiesto, SEMILLAS[0]!))), canonico(params),
    'El anclaje no pudo reproducirse al pasarlo al parser de encender.');
  inmutable(resolve(v.salida), datos);
  console.log(JSON.stringify({ producto: manifiesto.producto, manifiestoSha: hash(datos), paramsSha: manifiesto.paramsSha,
    modo: manifiesto.modo, motor: params.motor, limites: params.limites }));
}

function leerSemillas(x: unknown): number[] {
  assert.ok(Array.isArray(x) && x.length && new Set(x).size === x.length && x.every(n => SEMILLAS.includes(n)),
    'Subconjunto vacío, duplicado o fuera del panel.');
  return x;
}

function evaluarCorrida(dir: string, semilla: number, datos: Buffer, m: Manifiesto) {
  const bytes = readFileSync(join(dir, String(semilla), 'encender.jsonl'));
  const recibo = json(join(dir, String(semilla), 'recibo.json'));
  assert.ok(objeto(recibo) && recibo.codigo === 0 && recibo.senal === null && recibo.semilla === semilla
    && recibo.registroSha === hash(bytes) && recibo.manifiestoSha === hash(datos), 'Recibo incompleto o registro alterado.');
  const texto = bytes.toString('utf8');
  assert.ok(texto.endsWith('\n'), 'Registro sin cierre.');
  const filas = texto.slice(0, -1).split('\n').map(linea => JSON.parse(linea) as Record<string, unknown>);
  const inicio = filas[0], fin = filas.at(-1), dias = filas.slice(1, -1);
  const o = opcionesDe(m, semilla);
  assert.ok(inicio?.tipo === 'inicio' && inicio.semilla === semilla && inicio.tick === 0 && inicio.dia === 0
    && inicio.mortales === m.mortalesIniciales && inicio.hasta === (o.hasta ?? null)
    && inicio.regimen === o.regimen && inicio.params === o.params && inicio.paramsLeidosSha === m.paramsSha
    && inicio.producto === m.producto && inicio.encenderSha === m.encenderSha && inicio.puertaSha === m.puertaSha
    && inicio.hilos === o.hilos
    && inicio.comprobar === true && inicio.cada === o.cada && inicio.ticksPorDia === m.ticksDia
    && inicio.cadenciaMateria === m.params.v23.cadenciaMateria && Array.isArray(inicio.gpu) && !inicio.gpu.length,
    'Encender no acreditó el arranque previsto.');
  assert.deepEqual(inicio.leyes, m.leyes);
  assert.deepEqual(inicio.interruptores, m.interruptores);
  assert.deepEqual(inicio.invariantes, m.invariantes);
  assert.ok(fin?.tipo === 'fin' && fin.violaciones === 0 && fin.duras === 0 && dias.length,
    'Falta un cierre limpio de encender.');
  for (const [i, fila] of dias.entries()) {
    const c = fila.conservacion;
    assert.ok(fila.tipo === 'dia' && fila.dia === i + 1 && fila.tick === Math.min(m.ticksDia * (i + 1), m.opciones.ticks)
      && entero(fila.poblacion) && (fila.poblacion > 0 || i === dias.length - 1) && entero(fila.personas)
      && fila.personas >= fila.poblacion
      && fila.violaciones === 0 && fila.duras === 0 && objeto(c) && c.ok === true && c.posiciones === m.anchoSaldo
      && objeto(c.diferencias) && Object.keys(c.diferencias).length === 0 && objeto(c.cuentas)
      && Object.keys(c.cuentas).length >= m.anchoSaldo && Object.values(c.cuentas).every(n => typeof n === 'string' && /^-?\d+$/.test(n)),
      `Día ${i + 1} ausente, fuera de reloj o sin saldo/violaciones verificables.`);
  }
  const ultimo = dias.at(-1)!;
  assert.equal(fin.tick, ultimo.tick);
  assert.ok((fin.estado === 'extinta' && fin.dia === ultimo.dia && ultimo.poblacion === 0 && dias.length <= DIAS)
    || (fin.estado === 'completo' && fin.dia === undefined && fin.tick === m.opciones.ticks
      && dias.length === Math.ceil(m.opciones.ticks / m.ticksDia) && entero(ultimo.poblacion, 1)),
    'Corrida abortada o conclusión incoherente.');
  return { semilla, estado: fin.estado, tick: fin.tick, dias: dias.length, mortales: ultimo.poblacion,
    mortalesIniciales: inicio.mortales, hilos: inicio.hilos, saldo: 'exacto', violaciones: 0 };
}

async function interna(raiz: string, rutaM: string, semilla: number) {
  const m = leerManifiesto(readFileSync(rutaM));
  const actual = identidad(raiz);
  assert.deepEqual(actual, { producto: m.producto, encenderSha: m.encenderSha, puertaSha: m.puertaSha });
  assert.ok(SEMILLAS.includes(semilla));
  const modulo = await encenderDe(raiz);
  const o = opcionesDe(m, semilla);
  const paramsLeidosSha = hash(canonico(modulo.paramsDeEncender(o)));
  assert.equal(paramsLeidosSha, m.paramsSha, 'Params efectivos incompatibles en el host ejecutor.');
  return modulo.encender(o, fila => {
    const auditada = fila.tipo === 'inicio' ? { ...fila, ...actual, paramsLeidosSha, node: process.version } : fila;
    process.stdout.write(JSON.stringify(auditada) + '\n');
  });
}

async function correr(args: string[]) {
  const { values: v } = parseArgs({ args, options: {
    salida: { type: 'string' }, manifiesto: { type: 'string' }, semillas: { type: 'string' },
    'repo-producto': { type: 'string' }, concurrencia: { type: 'string' },
  } });
  assert.ok(v.manifiesto && v.semillas && v.salida, 'Faltan --manifiesto, --semillas o --salida.');
  const concurrencia = Number(v.concurrencia ?? 1);
  assert.ok(entero(concurrencia, 1) && concurrencia <= SEMILLAS.length);
  const semillas = leerSemillas(v.semillas.split(',').map(Number));
  const raiz = realpathSync(v['repo-producto'] ?? raizPuerta);
  const datos = readFileSync(v.manifiesto), m = leerManifiesto(datos);
  assert.deepEqual(identidad(raiz), { producto: m.producto, encenderSha: m.encenderSha, puertaSha: m.puertaSha });
  const modulo = await encenderDe(raiz);
  assert.equal(hash(canonico(modulo.paramsDeEncender(opcionesDe(m, semillas[0]!)))), m.paramsSha,
    'Params efectivos incompatibles en el host ejecutor.');
  const dir = resolve(v.salida), rutaM = join(dir, 'manifiesto.json'), rutaS = join(dir, 'semillas.json');
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: 0o700 });
    inmutable(rutaM, datos);
    inmutable(rutaS, JSON.stringify(semillas) + '\n');
  } else {
    assert.ok(readFileSync(rutaM).equals(datos), 'La salida pertenece a otro manifiesto.');
    assert.deepEqual(json(rutaS), semillas, 'La salida pertenece a otro subconjunto.');
  }
  const pendientes = semillas.filter(semilla => {
    if (!existsSync(join(dir, String(semilla)))) return true;
    console.log(JSON.stringify({ ...evaluarCorrida(dir, semilla, datos, m), reusada: true }));
    return false;
  });

  const hijos = new Set<ReturnType<typeof spawn>>();
  let detener = false;
  const senal = () => { detener = true; for (const hijo of hijos) hijo.kill(); };
  process.on('SIGINT', senal);
  process.on('SIGTERM', senal);
  const errores: string[] = [];
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([k]) => !/^(CARTA_|COMPUTE_|NODE_OPTIONS$|NODE_PATH$|TSX_TSCONFIG_PATH$)/.test(k)));
  async function lanzar(semilla: number) {
    const destino = join(dir, String(semilla));
    mkdirSync(destino, { mode: 0o700 });
    const tmp = mkdtempSync(join(tmpdir(), 'atlas-puerta-'));
    const ruta = join(destino, 'encender.jsonl');
    try {
      const registro = openSync(ruta, 'wx', 0o600);
      let log: number | undefined;
      let hijo: ReturnType<typeof spawn>;
      try {
        log = openSync(join(destino, 'encender.log'), 'wx', 0o600);
        hijo = spawn(process.execPath, ['--import', 'tsx', archivoPuerta, '--interno', raiz, rutaM, String(semilla)],
          { cwd: raiz, env: { ...env, CARTA_DATA_DIR: tmp }, stdio: ['ignore', registro, log] });
      } finally {
        closeSync(registro);
        if (log !== undefined) closeSync(log);
      }
      hijos.add(hijo);
      try {
        const estado = await new Promise<{ codigo: number | null; senal: string | null }>((ok, falla) => {
          hijo.once('close', (codigo, senal) => ok({ codigo, senal }));
          hijo.once('error', falla);
        });
        inmutable(join(destino, 'recibo.json'), JSON.stringify({ ...estado, semilla,
          manifiestoSha: hash(datos), registroSha: hash(readFileSync(ruta)) }) + '\n');
        console.log(JSON.stringify(evaluarCorrida(dir, semilla, datos, m)));
      } finally { hijos.delete(hijo); if (hijo.exitCode === null && hijo.signalCode === null) hijo.kill(); }
    } finally { rmSync(tmp, { recursive: true }); }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrencia, pendientes.length) }, async () => {
      while (!detener) {
        const semilla = pendientes.shift();
        if (semilla === undefined) return;
        try { await lanzar(semilla); } catch (e) { errores.push(`Semilla ${semilla}: ${String(e)}`); }
      }
    }));
  } finally { process.off('SIGINT', senal); process.off('SIGTERM', senal); }
  if (errores.length) console.error(errores.join('\n'));
  return detener || errores.length ? 1 : 0;
}

function evaluar(dirs: string[]) {
  assert.ok(dirs.length, 'Indica los directorios de subconjuntos.');
  const datos = readFileSync(join(dirs[0]!, 'manifiesto.json')), m = leerManifiesto(datos);
  assert.equal(m.puertaSha, hash(readFileSync(archivoPuerta)), 'Usa el mismo arnés que lanzó las corridas.');
  const vistos = new Set<number>(), errores: string[] = [], resultados = [];
  for (const dir of dirs) {
    try {
      assert.ok(readFileSync(join(dir, 'manifiesto.json')).equals(datos), 'Manifiesto distinto.');
      const semillas = leerSemillas(json(join(dir, 'semillas.json')));
      const guardadas = readdirSync(dir).filter(n => /^\d+$/.test(n));
      assert.ok(guardadas.every(n => semillas.map(String).includes(n)), 'Hay resultados no declarados.');
      for (const semilla of semillas) {
        try {
          assert.ok(!vistos.has(semilla), 'Semilla duplicada.');
          vistos.add(semilla);
          resultados.push(evaluarCorrida(dir, semilla, datos, m));
        } catch (e) { errores.push(`${dir}/${semilla}: ${String(e)}`); }
      }
    } catch (e) { errores.push(`${dir}: ${String(e)}`); }
  }
  const vivas = resultados.filter(r => r.estado === 'completo').length;
  const faltan = SEMILLAS.filter(s => !vistos.has(s));
  const puertaReal = m.modo === 'puerta' && !faltan.length && !errores.length && resultados.length === SEMILLAS.length
    && vivas >= MINIMO_VIVAS;
  console.log(JSON.stringify({ modo: m.modo, puertaReal, producto: m.producto, manifiestoSha: hash(datos),
    vivasDia30: m.modo === 'puerta' ? vivas : null, minimoVivas: MINIMO_VIVAS, faltan, errores, resultados }, null, 2));
  return puertaReal ? 0 : 1;
}

const USO = `Uso:
  bash scripts/lab/panel-demo.sh --puerta fijar --salida M.json [--repo-producto R] [--perfil-entorno]
      [--params ARCHIVO|OVERRIDES --hasta INTERRUPTOR|exacto --hilos N --regimen abierto|defecto]
      [--cada N] [--ticks-prueba 1|2]
  bash scripts/lab/panel-demo.sh --puerta correr --manifiesto M.json --semillas 7,51926 --salida DIR
      [--repo-producto R] [--concurrencia N]
  bash scripts/lab/panel-demo.sh --puerta evaluar DIR [DIR…]
Distribuye M.json intacto. Los resultados se sellan al cerrar encender y se reutilizan solo si son válidos.
La puerta exige materia en CPU, invariantes, 8 cierres íntegros y al menos 6 semillas vivas al día 30.
--ticks-prueba solo ensaya el flujo. evaluar devuelve 0 únicamente si la puerta formal cumple.
`;

const args = process.argv.slice(2);
try {
  if (args[0] === '--interno' && args.length === 4) process.exitCode = await interna(args[1]!, args[2]!, Number(args[3]));
  else if (args.length === 0 || args.includes('--help') || args.includes('-h')) console.log(USO);
  else {
    const [puerta, accion, ...resto] = args;
    assert.equal(puerta, '--puerta', USO);
    if (accion === 'fijar') await fijar(resto);
    else if (accion === 'correr') process.exitCode = await correr(resto);
    else if (accion === 'evaluar') process.exitCode = evaluar(resto);
    else assert.fail(USO);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
