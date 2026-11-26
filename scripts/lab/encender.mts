/**
 * scripts/lab/encender.mts — enciende un escalón de la V23 en un mundo de UN hilo y con semilla, y lo
 * vigila tick a tick: para en la primera violación dura de un invariante o de un `Ley.comprobar` e imprime tick, ley y entorno.
 *
 *   tsx scripts/lab/encender.mts --semilla 51926 --hasta materia --dias 3 [--params p.json | "a.b=1,c.d=2"] [--regimen abierto|defecto]
 *        [--gpu 0[,1]] [--cada N] [--tope-mortales N] [--continuar] [--salida corrida.jsonl] [--sin-comprobar]
 *
 *  --hasta X     enciende los interruptores hasta X incluido, en el orden de `ORDEN_ENCENDIDO` (`escalon()`); se aplica
 *                ENCIMA de `--params`. Sin él, rigen los interruptores de `--params` (todos apagados por defecto).
 *  --gpu         añade materiaGpu sobre el escalón y usa las tarjetas indicadas. Por defecto corre en CPU.
 *  --cada N      comprueba los invariantes y las leyes cada N ticks. Sin él, cada tick, cada invariante con su propia cadencia.
 *  --continuar   no para en la primera violación dura: las anota todas (para ver su alcance, no para estabilizar).
 *
 * Salida: una línea JSON por suceso, en stdout y (si se pide) en `--salida`:
 *   {tipo:'inicio'}  semilla, interruptores, hilos, comprobadores disponibles.
 *   {tipo:'dia'}     población, natalidad, muertes por causa, fauna, vistas medias terrestres y balance material.
 *   {tipo:'violacion'} tick, ley, invariante y entorno (la primera dura, salvo `--continuar`).
 *   {tipo:'fin'}     estado: completo | violacion | extinta | tope.
 * Código de salida: 0 completo, 2 violación dura, 1 error.
 *
 * No calibra ni mide rendimiento: es el instrumento con que se enciende, una a una, cada ley de la V23.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import { createWorld, stepWorld, TICKS_PER_DAY, type World } from '../../src/world/index.js';
import { bindWorldContext } from '../../src/world/spatial.js';
import { parseParams, paramsOf, DEFAULT_PARAMS, type WorldParams } from '../../src/world/params.js';
import { hostOpenWorldParams } from '../../src/server/hardware-limits.js';
import { comprobarLeyes, crearComprobador, listaInvariantes, type Violacion } from '../../src/world/invariantes.js';
import { LEYES } from '../../src/world/motor/leyes.js';
import { ctxSi } from '../../src/world/motor/acceso.js';
import { cerrarMateriaGpu, conservacion, diagnosticoMateriaGpu } from '../../src/world/materia/ley-mundo.js';
import { escalon, INTERRUPTORES, ORDEN_ENCENDIDO, type Interruptor, type InterruptoresV23 } from '../../src/shared/interruptores.js';
import type { Chunk } from '../../src/world/terrain.js';

export interface OpcionesEncender {
  semilla: number; hasta?: Interruptor; params?: string; dias: number; regimen: 'abierto' | 'defecto';
  /** Cada cuántos ticks se comprueba todo; `undefined` = cada tick con la cadencia propia de cada invariante. */
  cada?: number; topeMortales?: number; continuar: boolean; salida?: string; comprobar: boolean; gpu?: number[];
}

const entero = (texto: string, nombre: string, minimo = 1): number => {
  const n = Number(texto);
  if (!Number.isSafeInteger(n) || n < minimo) throw new Error(`${nombre}: se esperaba un entero ≥ ${minimo}`);
  return n;
};

export function argumentosEncender(args: string[]): OpcionesEncender {
  const o: OpcionesEncender = { semilla: 51926, dias: 1, regimen: 'abierto', continuar: false, comprobar: true };
  for (let i = 0; i < args.length; i++) {
    const bandera = args[i]!;
    if (bandera === '--continuar') { o.continuar = true; continue; }
    if (bandera === '--sin-comprobar') { o.comprobar = false; continue; }
    const valor = args[++i];
    if (valor === undefined) throw new Error(`Falta valor para ${bandera}`);
    switch (bandera) {
      case '--semilla': o.semilla = entero(valor, bandera, 0); break;
      case '--hasta':
        if (!(INTERRUPTORES as readonly string[]).includes(valor)) throw new Error(`--hasta: «${valor}» no es un interruptor (${ORDEN_ENCENDIDO.join(', ')})`);
        o.hasta = valor as Interruptor; break;
      case '--params': o.params = valor; break;
      case '--dias': o.dias = entero(valor, bandera); break;
      case '--gpu':
        if (!/^\d+(,\d+)*$/.test(valor)) throw new Error('--gpu espera índices separados por comas');
        o.gpu = [...new Set(valor.split(',').map(id => entero(id, bandera, 0)))]; break;
      case '--regimen': if (valor !== 'abierto' && valor !== 'defecto') throw new Error('Régimen inválido'); o.regimen = valor; break;
      case '--cada': o.cada = entero(valor, bandera); break;
      case '--tope-mortales': o.topeMortales = entero(valor, bandera); break;
      case '--salida': o.salida = resolve(valor); break;
      default: throw new Error(`Opción desconocida: ${bandera}`);
    }
  }
  return o;
}

/** Los params del mundo de referencia: régimen, `--params`, el escalón de `--hasta` y un solo dueño. */
export function paramsDeEncender(o: Pick<OpcionesEncender, 'regimen' | 'params' | 'hasta' | 'gpu'>): WorldParams {
  let params: WorldParams = o.regimen === 'abierto' ? hostOpenWorldParams() : DEFAULT_PARAMS;
  if (o.params) {
    const texto = existsSync(o.params) ? readFileSync(o.params, 'utf8') : o.params;
    params = parseParams(texto.trimStart().startsWith('{') ? JSON.parse(texto) : texto, params);
  }
  if (o.hasta) params = parseParams({ v23: escalon(o.hasta) }, params);
  const gpu = o.gpu ?? [];
  return parseParams({ motor: { ...params.motor, hilos: 1, gpu },
    ...(gpu.length ? { v23: { ...params.v23, materiaGpu: true } } : {}) }, params);
}

const interruptoresEncendidos = (v: Readonly<InterruptoresV23>): Interruptor[] => INTERRUPTORES.filter(k => v[k]);

/** El balance exacto del libro del dueño, con los bigint en texto; `null` si el mundo no tiene materia o aún no tiene contexto. */
export function balanceConservacion(mundo: World): { ok: boolean; posiciones: number; diferencias: Record<string, string>; cuentas: Record<string, string> } | null {
  const c = ctxSi(mundo) as (ReturnType<typeof ctxSi> & { materia?: unknown; quimica?: unknown }) | undefined;
  if (!paramsOf(mundo).v23.materia || !c?.materia || !c.quimica) return null;
  const { esperado, hallado, cuentas } = conservacion(c as Parameters<typeof conservacion>[0]);
  const diferencias: Record<string, string> = {};
  for (let i = 0; i < Math.min(esperado.length, hallado.length); i++) if (esperado[i] !== hallado[i]) diferencias[String(i)] = String(hallado[i]! - esperado[i]!);
  return { ok: Object.keys(diferencias).length === 0 && esperado.length === hallado.length, posiciones: esperado.length, diferencias,
    cuentas: Object.fromEntries(Object.entries(cuentas).map(([k, v]) => [k, String(v)])) };
}

/** Qué ley responde por un invariante: la que lo declaró en su contexto o el carril con que se registró. */
function leyDe(v: Violacion, carriles: ReadonlyMap<string, string>): string {
  const declarada = (v.contexto as { ley?: unknown } | undefined)?.ley;
  return typeof declarada === 'string' ? declarada : carriles.get(v.id) ?? 'desconocida';
}

/** Vistas al cierre del día de las teselas terrestres que siguen residentes. */
export function vistasMedias(tiles: Readonly<World['tiles']>) {
  let teselas = 0, fertilidad = 0, vegetacion = 0, alimento = 0, humedad = 0;
  for (const tile of tiles) {
    if (tile.terrain === 'water') continue;
    teselas++;
    fertilidad += tile.fertility ?? 0;
    vegetacion += tile.vegetation;
    alimento += tile.food;
    humedad += tile.moisture;
  }
  return { teselas, fertilidad: teselas ? fertilidad / teselas : null, vegetacion: teselas ? vegetacion / teselas : null,
    alimento: teselas ? alimento / teselas : null, humedad: teselas ? humedad / teselas : null };
}

export async function encender(o: OpcionesEncender, escribirFila: (fila: Record<string, unknown>) => void): Promise<number> {
  const params = paramsDeEncender(o);
  const mundo = createWorld(o.semilla, params);
  try { return correr(o, mundo, escribirFila); }
  finally { cerrarMateriaGpu(mundo); }
}

function correr(o: OpcionesEncender, mundo: World, escribirFila: (fila: Record<string, unknown>) => void): number {
  const params = paramsOf(mundo);
  const archivo = new Map<string, Buffer>();
  bindWorldContext(mundo, { loadChunk: clave => { const g = archivo.get(clave); return g ? deserialize(g) as Chunk : null; } });
  const archivar = (): void => {
    const vistos = new Set<string>();
    for (const chunk of mundo.retiredChunks) if (!vistos.has(chunk.key)) { vistos.add(chunk.key); archivo.set(chunk.key, serialize(chunk)); }
    mundo.retiredChunks = [];
  };
  const carriles = new Map(listaInvariantes().map(i => [i.id, i.carril]));
  const comprobador = o.comprobar ? crearComprobador({ cadencia: o.cada === undefined }) : null;
  const leyesEncendidas = LEYES.filter(l => params.v23[l.interruptor]);
  const entorno = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    semilla: o.semilla, hasta: o.hasta ?? null, params: o.params ?? null, regimen: o.regimen, interruptores: interruptoresEncendidos(params.v23),
    cadenciaMateria: params.v23.cadenciaMateria, tick: mundo.tick, dia: Math.floor(mundo.tick / TICKS_PER_DAY),
    mortales: mundo.people.filter(p => p.role === 'neighbor').length, fauna: mundo.animals.length, ...extra,
  });
  escribirFila({ tipo: 'inicio', ...entorno(), leyes: leyesEncendidas.map(l => l.id), invariantes: [...carriles.keys()], comprobar: o.comprobar,
    cada: o.cada ?? 'propia', ticksPorDia: TICKS_PER_DAY, gpu: params.motor.gpu });

  let violaciones = 0, duras = 0, avisoSinContexto = false;
  const registrar = (lista: Violacion[]): boolean => {
    let dura = false;
    for (const v of lista) {
      violaciones++;
      if (v.gravedad === 'dura') { duras++; dura = true; }
      escribirFila({ tipo: 'violacion', tick: v.tick, ley: leyDe(v, carriles), invariante: v.id, gravedad: v.gravedad, detalle: v.detalle, contexto: v.contexto,
        esperado: v.esperado, observado: v.observado, entorno: entorno() });
    }
    return dura;
  };
  const revisar = (): boolean => {
    if (!o.comprobar) return false;
    // El comprobador por corrida suma a los invariantes los de historia (Δpoblación, acumulados, nacimientos).
    const invariantes = comprobador!(mundo);
    const deLeyes = comprobarLeyes(mundo, leyesEncendidas);
    if (!avisoSinContexto && leyesEncendidas.length && !ctxSi(mundo)) {
      avisoSinContexto = true;
      escribirFila({ tipo: 'aviso', tick: mundo.tick, texto: 'Hay leyes encendidas pero el mundo no tiene contexto de dueño (ctxSi): no corren sus comprobar ni I-C/I-R/I-B.' });
    }
    return registrar([...invariantes, ...deLeyes]);
  };

  let nacidosAntes = mundo.totals.births ?? 0, muertesAntes = mundo.demographyDynamics.deaths;
  let causasAntes = { ...mundo.demographyDynamics.causes };
  let faunaAntes = { ...mundo.animalDynamics };
  if (revisar() && !o.continuar) { escribirFila({ tipo: 'fin', estado: 'violacion', tick: mundo.tick }); return 2; }
  for (let dia = 1; dia <= o.dias; dia++) {
    const causasFauna: Record<string, number> = {};
    for (let t = 0; t < TICKS_PER_DAY; t++) {
      const muertesFaunaAntes = mundo.animalDynamics.deaths;
      stepWorld(mundo);
      if (params.v23.fauna && mundo.animalDynamics.deaths > muertesFaunaAntes) {
        for (let i = mundo.events.length - 1; i >= 0; i--) {
          const evento = mundo.events[i]!;
          if (evento.tick < mundo.tick) break;
          if (evento.kind === 'animal' && evento.text.startsWith('Muere un animal de ')) {
            causasFauna[evento.cause] = (causasFauna[evento.cause] ?? 0) + 1;
          }
        }
      }
      const toca = o.cada === undefined || mundo.tick % o.cada === 0;
      if (toca && revisar() && !o.continuar) { escribirFila({ tipo: 'fin', estado: 'violacion', tick: mundo.tick, violaciones, duras }); return 2; }
    }
    if (o.cada !== undefined && mundo.tick % o.cada !== 0 && revisar() && !o.continuar) { escribirFila({ tipo: 'fin', estado: 'violacion', tick: mundo.tick, violaciones, duras }); return 2; }
    archivar();
    const dinamica = mundo.demographyDynamics;
    const fauna = { ...mundo.animalDynamics };
    const mortales = mundo.people.filter(p => p.role === 'neighbor').length;
    const nacimientos = mundo.totals.births ?? 0;
    escribirFila({
      tipo: 'dia', dia, tick: mundo.tick, poblacion: mortales, personas: mundo.people.length,
      nacimientos, nacidosDia: nacimientos - nacidosAntes, muertes: dinamica.deaths, muertesDia: dinamica.deaths - muertesAntes,
      muertesPorCausa: { ...dinamica.causes }, muertesPorCausaDia: Object.fromEntries(Object.entries(dinamica.causes).map(([k, v]) => [k, v - (causasAntes[k as keyof typeof causasAntes] ?? 0)])),
      fauna: mundo.animals.length, faunaDinamica: fauna,
      faunaDinamicaDia: {
        births: fauna.births - faunaAntes.births, deaths: fauna.deaths - faunaAntes.deaths,
        predations: fauna.predations - faunaAntes.predations, humanHunts: fauna.humanHunts - faunaAntes.humanHunts,
        waterConsumed: fauna.waterConsumed - faunaAntes.waterConsumed, plantConsumed: fauna.plantConsumed - faunaAntes.plantConsumed,
      },
      faunaMuertesPorCausaDia: causasFauna, vistasMedias: vistasMedias(mundo.tiles),
      comunidades: mundo.communities.length, estructuras: mundo.structures.length,
      totales: { ...mundo.totals }, conservacion: balanceConservacion(mundo), violaciones, duras,
      ...(params.motor.gpu.length ? { gpuMateria: diagnosticoMateriaGpu(mundo) } : {}),
    });
    nacidosAntes = nacimientos; muertesAntes = dinamica.deaths; causasAntes = { ...dinamica.causes };
    faunaAntes = fauna;
    if (mortales === 0) { escribirFila({ tipo: 'fin', estado: 'extinta', dia, violaciones, duras }); return duras ? 2 : 0; }
    if (o.topeMortales && mortales >= o.topeMortales) { escribirFila({ tipo: 'fin', estado: 'tope', dia, violaciones, duras }); return duras ? 2 : 0; }
  }
  escribirFila({ tipo: 'fin', estado: duras ? 'violacion' : 'completo', tick: mundo.tick, violaciones, duras });
  return duras ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 20).join('\n') + '\n');
  } else {
    (async () => {
      const o = argumentosEncender(process.argv.slice(2));
      if (o.salida) writeFileSync(o.salida, '');
      process.title = 'atlas-encender';
      const codigo = await encender(o, fila => {
        const linea = `${JSON.stringify(fila)}\n`;
        process.stdout.write(linea);
        if (o.salida) appendFileSync(o.salida, linea);
      });
      process.exitCode = codigo;
    })().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
  }
}
