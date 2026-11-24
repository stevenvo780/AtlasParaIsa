/** Repite un fallo desde la misma entrada: --semilla S | --respaldo copia.sqlite.
 * Ejemplo: npx tsx scripts/lab/reproducir.ts --semilla 51926 --hasta-tick 2400 --intentos 10 --hilos 1,8
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/server/store.js';
import { createWorld, stepWorld, closePersonasParallelPools, closeFaunaParallelPools, closePolicyGpuBatchers, type World } from '../../src/world/index.js';
import { closeEcosystemWorkers } from '../../src/world/ecosystem.js';
import { crearComprobador } from '../../src/world/invariantes.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { paramsOf, parseParams, setParams } from '../../src/world/params.js';

const TEMPORALES = '/tmp/atlas-v23-0c';

export interface OpcionesIntento {
  semilla?: number;
  respaldo?: string;
  hastaTick: number;
  hilos: number;
  params?: string;
  invariante?: string;
}

export interface ResultadoIntento {
  ocurre: boolean;
  tick: number;
  invariantes: string[];
  error?: string;
  digesto?: string;
}

/** Intervalo binomial de Wilson al 95 %, también válido con cero o todos los fallos. */
export function intervaloWilson(k: number, n: number): [number, number] {
  if (!Number.isSafeInteger(n) || n < 1 || !Number.isSafeInteger(k) || k < 0 || k > n) {
    throw new RangeError('El intervalo requiere 0 <= k <= N y N entero positivo.');
  }
  const z = 1.959963984540054, z2 = z * z, p = k / n;
  const centro = (p + z2 / (2 * n)) / (1 + z2 / n);
  const margen = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / (1 + z2 / n);
  return [k === 0 ? 0 : Math.max(0, centro - margen), k === n ? 1 : Math.min(1, centro + margen)];
}

export function resumirIntentos(resultados: readonly ResultadoIntento[]) {
  const n = resultados.length, k = resultados.filter(resultado => resultado.ocurre).length;
  const firmas = new Set(resultados.map(resultado => JSON.stringify(resultado)));
  return { k, n, fraccion: k / n, intervalo95: intervaloWilson(k, n), reproducible: firmas.size === 1 };
}

function copiarRespaldo(origen: string, destino: string): void {
  // VACUUM INTO lee una instantánea SQLite coherente, incluido el WAL, sin escribir el origen.
  const fuente = new Store(origen, { readOnly: true });
  try { fuente.backup(destino); } finally { fuente.close(); }
}

export async function ejecutarIntento(opciones: OpcionesIntento): Promise<ResultadoIntento> {
  mkdirSync(TEMPORALES, { recursive: true });
  const temporal = mkdtempSync(join(TEMPORALES, 'repro-intento-'));
  let store: Store | undefined, mundo: World | undefined;
  try {
    if (opciones.respaldo) {
      const copia = join(temporal, 'world.sqlite');
      copiarRespaldo(opciones.respaldo, copia);
      store = new Store(copia);
      const cargado = store.load();
      if (!cargado) throw new Error('El respaldo no contiene un mundo.');
      mundo = cargado.world;
    } else {
      if (opciones.semilla === undefined) throw new Error('Falta --semilla o --respaldo.');
      mundo = createWorld(opciones.semilla, parseParams(opciones.params));
    }
    const base = parseParams(opciones.params, paramsOf(mundo));
    setParams(mundo, parseParams({ motor: { hilos: opciones.hilos, gpu: [] } }, base));
    if (opciones.hastaTick < mundo.tick) throw new Error(`El respaldo empieza en ${mundo.tick}, posterior a --hasta-tick.`);
    const comprobar = crearComprobador();
    while (true) {
      const violaciones = comprobar(mundo).filter(v => !opciones.invariante || v.id === opciones.invariante);
      if (violaciones.length) return { ocurre: true, tick: mundo.tick, invariantes: [...new Set(violaciones.map(v => v.id))].sort() };
      if (mundo.tick >= opciones.hastaTick) break;
      stepWorld(mundo);
      if (store && mundo.tick % paramsOf(mundo).persistencia.cadaTicks === 0) store.save(mundo);
    }
    return { ocurre: false, tick: mundo.tick, invariantes: [], digesto: digestoCanonico(mundo) };
  } catch (error) {
    return { ocurre: true, tick: mundo?.tick ?? 0, invariantes: [], error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  } finally {
    try {
      await Promise.all([closeEcosystemWorkers(), closePersonasParallelPools(), closeFaunaParallelPools(), closePolicyGpuBatchers()]);
    } finally {
      store?.close();
      rmSync(temporal, { recursive: true, force: true });
    }
  }
}

function entero(raw: string | undefined, nombre: string, minimo: number): number {
  if (!raw || !/^\d+$/.test(raw)) throw new Error(`${nombre} requiere un entero >= ${minimo}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimo) throw new Error(`${nombre} requiere un entero >= ${minimo}.`);
  return value;
}

async function relanzar(ejecutable: string, opciones: OpcionesIntento): Promise<ResultadoIntento> {
  return new Promise((resolver, rechazar) => {
    const hijo = spawn(ejecutable, ['--import', createRequire(import.meta.url).resolve('tsx'), fileURLToPath(import.meta.url), '--intento', JSON.stringify(opciones)], {
      cwd: resolve(fileURLToPath(new URL('../..', import.meta.url))), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let salida = '', errores = '';
    const interrumpir = () => { hijo.kill('SIGTERM'); };
    process.once('SIGINT', interrumpir);
    process.once('SIGTERM', interrumpir);
    hijo.stdout.setEncoding('utf8').on('data', texto => { salida += texto; });
    hijo.stderr.setEncoding('utf8').on('data', texto => { errores = (errores + texto).slice(-4096); });
    hijo.once('error', rechazar);
    hijo.once('close', (codigo, señal) => {
      process.off('SIGINT', interrumpir);
      process.off('SIGTERM', interrumpir);
      if (codigo !== 0) {
        rechazar(new Error(`El intento terminó sin resultado (${señal ?? codigo}): ${errores}`));
        return;
      }
      try { resolver(JSON.parse(salida.trim()) as ResultadoIntento); } catch { rechazar(new Error(`Resultado de intento ilegible: ${salida.slice(-1024)}`)); }
    });
  });
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === '--intento') {
    console.log(JSON.stringify(await ejecutarIntento(JSON.parse(args[1]!) as OpcionesIntento)));
    return;
  }
  const permitidos = new Set(['--semilla', '--respaldo', '--hasta-tick', '--intentos', '--hilos', '--params', '--invariante']);
  if (args.includes('--help')) {
    console.log('Uso: reproducir.ts (--semilla S | --respaldo copia.sqlite) --hasta-tick T [--intentos 50] [--hilos 1,8,28] [--params a.b=v] [--invariante ID]');
    return;
  }
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const nombre = args[i]!, valor = args[i + 1];
    if (!permitidos.has(nombre) || !valor || valor.startsWith('--') || flags.has(nombre)) throw new Error(`Argumento inválido: ${nombre}.`);
    flags.set(nombre, valor);
  }
  if (flags.has('--semilla') === flags.has('--respaldo')) throw new Error('Indica --semilla o --respaldo, exactamente uno.');
  const intentos = entero(flags.get('--intentos') ?? '50', '--intentos', 1);
  const hastaTick = entero(flags.get('--hasta-tick'), '--hasta-tick', 0);
  const hilos = [...new Set((flags.get('--hilos') ?? '1').split(',').map(raw => entero(raw, '--hilos', 1)))];
  const semilla = flags.has('--semilla') ? entero(flags.get('--semilla'), '--semilla', 0) : undefined;
  // La configuración inválida es un error del comando, no una ocurrencia del fallo del mundo.
  for (const numero of hilos) parseParams({ motor: { hilos: numero, gpu: [] } }, parseParams(flags.get('--params')));
  mkdirSync(TEMPORALES, { recursive: true });
  const temporal = mkdtempSync(join(TEMPORALES, 'reproducir-'));
  try {
    const ejecutable = join(temporal, 'carta-isa');
    symlinkSync(process.execPath, ejecutable);
    let respaldo: string | undefined;
    if (flags.has('--respaldo')) {
      respaldo = join(temporal, 'origen.sqlite');
      copiarRespaldo(resolve(flags.get('--respaldo')!), respaldo);
    }
    for (const numero of hilos) {
      const resultados: ResultadoIntento[] = [];
      for (let intento = 1; intento <= intentos; intento++) {
        const resultado = await relanzar(ejecutable, { semilla, respaldo, hastaTick, hilos: numero, params: flags.get('--params'), invariante: flags.get('--invariante') });
        resultados.push(resultado);
        console.log(JSON.stringify({ tipo: 'intento', hilos: numero, intento, ...resultado }));
      }
      const resumen = resumirIntentos(resultados);
      console.log(JSON.stringify({ tipo: 'resumen', hilos: numero, semilla, hastaTick, ...resumen,
        mensaje: `ocurre en ${resumen.k} de ${resumen.n}`, confianza: 0.95,
        reproducibilidadExigida: numero === 1,
      }));
      if (numero === 1 && !resumen.reproducible) process.exitCode = 1;
    }
  } finally { rmSync(temporal, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
