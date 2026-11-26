/**
 * scripts/lab/encender.mts — enciende un escalón de la V23 en un mundo con semilla y lo
 * vigila tick a tick: para en la primera violación dura de un invariante o de un `Ley.comprobar` e imprime tick, ley y entorno.
 *
 *   tsx scripts/lab/encender.mts --semilla 51926 --hasta materia --dias 3 [--params p.json | "a.b=1,c.d=2"] [--regimen abierto|defecto]
 *        [--hilos N] [--gpu 0[,1]] [--cada N] [--tope-mortales N] [--continuar] [--salida corrida.jsonl] [--sin-comprobar]
 *        [--n N] [--ticks N] [--perfil] [--digesto] [--panel-corto]
 *
 *  --hasta X     enciende los interruptores hasta X incluido, en el orden de `ORDEN_ENCENDIDO` (`escalon()`); se aplica
 *                ENCIMA de `--params`. Sin él, rigen los interruptores de `--params` (todos apagados por defecto).
 *  --hilos N     usa N dueños. Si N > 1, añade duenos sobre el escalón y exige que intentos ya esté encendido.
 *  --gpu         añade materiaGpu sobre el escalón y usa las tarjetas indicadas. Por defecto corre en CPU.
 *  --cada N      comprueba los invariantes y las leyes cada N ticks. Sin él, cada tick, cada invariante con su propia cadencia.
 *  --continuar   no para en la primera violación dura: las anota todas (para ver su alcance, no para estabilizar).
 *  --panel-corto mide cada paso y sigue tras la extinción mortal. Comprueba al inicio, según --cada (120 por defecto)
 *                y al cierre de cada día.
 *
 * Salida: una línea JSON por suceso, en stdout y (si se pide) en `--salida`:
 *   {tipo:'inicio'}  semilla, interruptores, hilos, comprobadores disponibles.
 *   {tipo:'dia'}     población, natalidad, muertes por causa, fauna, vistas medias terrestres y balance material.
 *   {tipo:'violacion'} tick, ley, invariante y entorno (la primera dura, salvo `--continuar`).
 *   {tipo:'fin'}     estado: completo | violacion | extinta | tope.
 * Código de salida: 0 completo, 2 violación dura, 1 error.
 *
 * --n siembra mortales con `poblacion.mts` en la zona 0,0,48,32. --ticks permite un último día parcial.
 * --perfil resume el coste del paso. --digesto incluye el estado final residente, archivado y material.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import { createWorld, stepWorld, TICKS_PER_DAY, worldContext, type FaseMedicion, type World } from '../../src/world/index.js';
import { parseParams, paramsOf, DEFAULT_PARAMS, type WorldParams } from '../../src/world/params.js';
import { hostOpenWorldParams } from '../../src/server/hardware-limits.js';
import { comprobarLeyes, crearComprobador, listaInvariantes, type Violacion } from '../../src/world/invariantes.js';
import { LEYES } from '../../src/world/motor/leyes.js';
import { ctxSi, enlazarCtx } from '../../src/world/motor/acceso.js';
import { duenoSi } from '../../src/world/motor/contexto.js';
import { crearMotor } from '../../src/world/motor/coordinador.js';
import type { Instantanea, Motor } from '../../src/world/motor/contratos.js';
import { cerrarMateriaGpu, conservacion, diagnosticoMateriaGpu } from '../../src/world/materia/ley-mundo.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { escalon, INTERRUPTORES, ORDEN_ENCENDIDO, type Interruptor, type InterruptoresV23 } from '../../src/shared/interruptores.js';
import { archivoDeChunks, poblar } from './poblacion.mjs';

export interface OpcionesEncender {
  semilla: number; hasta?: Interruptor; params?: string; dias: number; regimen: 'abierto' | 'defecto';
  /** Cada cuántos ticks se comprueba todo. En el panel son 120 por defecto, fuera del panel rige cada invariante. */
  cada?: number; topeMortales?: number; continuar: boolean; salida?: string; comprobar: boolean; gpu?: number[];
  n?: number; ticks?: number; perfil?: boolean; digesto?: boolean; hilos?: number; panelCorto?: boolean;
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
    if (bandera === '--perfil') { o.perfil = true; continue; }
    if (bandera === '--digesto') { o.digesto = true; continue; }
    if (bandera === '--panel-corto') { o.panelCorto = true; continue; }
    const valor = args[++i];
    if (valor === undefined) throw new Error(`Falta valor para ${bandera}`);
    switch (bandera) {
      case '--semilla': o.semilla = entero(valor, bandera, 0); break;
      case '--hasta':
        if (!(INTERRUPTORES as readonly string[]).includes(valor)) throw new Error(`--hasta: «${valor}» no es un interruptor (${ORDEN_ENCENDIDO.join(', ')})`);
        o.hasta = valor as Interruptor; break;
      case '--params': o.params = valor; break;
      case '--dias': o.dias = entero(valor, bandera); break;
      case '--ticks': o.ticks = entero(valor, bandera); break;
      case '--n': o.n = entero(valor, bandera); break;
      case '--hilos': o.hilos = entero(valor, bandera); break;
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

/** Los params del mundo de referencia, con un dueño y CPU por defecto. */
export function paramsDeEncender(o: Pick<OpcionesEncender, 'regimen' | 'params' | 'hasta' | 'hilos' | 'gpu'>): WorldParams {
  let params: WorldParams = o.regimen === 'abierto' ? hostOpenWorldParams() : DEFAULT_PARAMS;
  if (o.params) {
    const texto = existsSync(o.params) ? readFileSync(o.params, 'utf8') : o.params;
    params = parseParams(texto.trimStart().startsWith('{') ? JSON.parse(texto) : texto, params);
  }
  if (o.hasta) params = parseParams({ v23: escalon(o.hasta) }, params);
  const hilos = o.hilos ?? 1, gpu = o.gpu ?? [];
  return parseParams({ motor: { hilos, gpu }, v23: {
    duenos: hilos > 1 || params.v23.duenos, materiaGpu: gpu.length > 0 || params.v23.materiaGpu,
  } }, params);
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
  if (o.n !== undefined) poblar(mundo, { n: o.n, zona: { x: 0, y: 0, ancho: 48, alto: 32 }, siembra: o.semilla });
  const { hilos, gpu } = params.motor;
  const motor = hilos > 1 ? crearMotor(mundo, { hilos, gpu, decisionGpu: 'siempre', verificar: o.comprobar, semilla: o.semilla }) : undefined;
  try { return correr(o, mundo, motor, escribirFila); }
  finally {
    if (motor) await motor.cerrar();
    else cerrarMateriaGpu(mundo);
  }
}

function correr(o: OpcionesEncender, origen: World, motor: Motor | undefined, escribirFila: (fila: Record<string, unknown>) => void): number {
  let mundo = origen;
  const params = paramsOf(origen);
  // El coordinador recibe los chunks retirados de todos los dueños y vuelve a activarlos desde este archivo.
  const { archivo, archivar } = archivoDeChunks(origen);
  const contexto = worldContext(origen);
  const panel = o.panelCorto ? { pasosMedidos: 0, pasoMaximoMs: 0, pasosSobre30s: 0, comprobacionesRegiones: 0,
    reunionMaximaMs: 0, comprobacionMaximaMs: 0, archivoMaximoMs: 0 } : undefined;
  const cpuMs = (): number => { const { user, system } = process.cpuUsage(); return (user + system) / 1000; };
  const medicion: FaseMedicion | undefined = o.perfil && !motor ? { clock: cpuMs, fases: {}, v23: {} } : undefined;
  const paso = (): number => {
    if (motor) return motor.paso([]).tick;
    if (medicion) stepWorld(origen, [], contexto, medicion);
    else stepWorld(origen);
    return origen.tick;
  };
  const reunir = (tick: number): void => {
    if (!motor) return;
    const inicio = panel ? performance.now() : 0;
    mundo = motor.vista();
    if (mundo.tick !== tick) throw new Error(`Vista del tick ${mundo.tick}, se esperaba ${tick}.`);
    const dueno = duenoSi(origen);
    if (!dueno) throw new Error('El motor repartido no abrió el contexto del coordinador.');
    // La vista reúne todos los organismos; el contexto de 0 da acceso al libro y la arena globales.
    enlazarCtx(mundo, dueno);
    if (panel) panel.reunionMaximaMs = Math.max(panel.reunionMaximaMs, performance.now() - inicio);
  };
  const ticks = o.ticks ?? o.dias * TICKS_PER_DAY;
  const cada = o.cada ?? (panel ? 120 : undefined);
  const mortalesIniciales = panel ? mundo.people.filter(p => p.role === 'neighbor') : [];
  const fundadores = new Set(mortalesIniciales.map(p => p.id));
  const primerFundador = mortalesIniciales[0];
  const puertaInicial = panel ? {
    cohorteFundadoraHomogenea: primerFundador !== undefined && mortalesIniciales.every(p =>
      p.genome.generation === primerFundador.genome.generation && p.demography.age === primerFundador.demography.age),
    poblacionInicial: mortalesIniciales.length,
    nacimientosIniciales: mundo.totals.births ?? 0,
    muertesIniciales: mundo.demographyDynamics.deaths,
    muertesPorCausaIniciales: { ...mundo.demographyDynamics.causes },
  } : undefined;
  let msPared = 0, msCpu = 0;
  const carriles = new Map(listaInvariantes().map(i => [i.id, i.carril]));
  const comprobador = o.comprobar ? crearComprobador({ cadencia: cada === undefined }) : null;
  const leyesEncendidas = LEYES.filter(l => params.v23[l.interruptor]);
  const entorno = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    semilla: o.semilla, hasta: o.hasta ?? null, params: o.params ?? null, regimen: o.regimen, interruptores: interruptoresEncendidos(params.v23),
    cadenciaMateria: params.v23.cadenciaMateria, tick: mundo.tick, dia: Math.floor(mundo.tick / TICKS_PER_DAY),
    mortales: mundo.people.filter(p => p.role === 'neighbor').length, fauna: mundo.animals.length, ...extra,
  });
  escribirFila({ tipo: 'inicio', ...entorno(), leyes: leyesEncendidas.map(l => l.id), invariantes: [...carriles.keys()], comprobar: o.comprobar,
    cada: cada ?? 'propia', ticksPorDia: TICKS_PER_DAY, hilos: motor?.telemetria().hilos ?? 1, gpu: params.motor.gpu,
    ...(puertaInicial && { puertaCorta: puertaInicial }) });

  let violaciones = 0, duras = 0, avisoSinContexto = false;
  const fin = (estado: string, dia?: number): number => {
    const medido = mundo.tick;
    const rssPicoKiB = process.resourceUsage().maxRSS;
    const porTick = (fases: Record<string, number>) => Object.fromEntries(Object.entries(fases).map(([fase, ms]) => [fase, ms / medido]));
    const perfil = o.perfil && medido > 0 ? {
      msCpuPorTick: msCpu / medido, msParedPorTick: msPared / medido, ticksPorSegundo: medido * 1000 / msPared,
      ...(medicion ? { cpuPorFaseV23: porTick(medicion.v23!), cpuPorSubfase: porTick(medicion.fases) } : {}), maxRssMiB: rssPicoKiB / 1024,
    } : undefined;
    const digesto = o.digesto ? digestoCompleto(mundo, archivo, motor?.instantanea().materia) : undefined;
    escribirFila({ tipo: 'fin', estado, tick: mundo.tick, dia, violaciones, duras, perfil, digesto,
      ...(panel && { puertaCorta: { ...panel, rssPicoKiB } }) });
    return duras ? 2 : 0;
  };
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
    const inicio = panel ? performance.now() : 0;
    // El comprobador por corrida suma a los invariantes los de historia (Δpoblación, acumulados, nacimientos).
    const invariantes = comprobador!(mundo);
    // Los invariantes regionales recorren el mundo residente completo, una cobertura por región del corte.
    if (panel) panel.comprobacionesRegiones += Object.keys(mundo.chunks).length;
    // Los ganchos locales requieren el contexto del dueño, no el mundo reunido.
    const deLeyes = comprobarLeyes(origen, leyesEncendidas);
    const balance = motor && duenoSi(origen)?.balanceIntentos();
    if (balance && balance.enviados !== balance.recibidos + balance.pendientes) {
      invariantes.push({ id: 'motor-buzones', gravedad: 'dura', tick: mundo.tick,
        detalle: 'Los intentos enviados no cuadran con los recibidos y los pendientes.', contexto: balance });
    }
    if (!motor && !avisoSinContexto && leyesEncendidas.length && !ctxSi(mundo)) {
      avisoSinContexto = true;
      escribirFila({ tipo: 'aviso', tick: mundo.tick, texto: 'Hay leyes encendidas pero el mundo no tiene contexto de dueño (ctxSi): no corren sus comprobar ni I-C/I-R/I-B.' });
    }
    const dura = registrar([...invariantes, ...deLeyes]);
    if (panel) panel.comprobacionMaximaMs = Math.max(panel.comprobacionMaximaMs, performance.now() - inicio);
    return dura;
  };

  let nacidosAntes = mundo.totals.births ?? 0, muertesAntes = mundo.demographyDynamics.deaths;
  let causasAntes = { ...mundo.demographyDynamics.causes };
  let faunaAntes = { ...mundo.animalDynamics };
  if (revisar() && !o.continuar) return fin('violacion');
  const leerCronicaViva = Boolean(panel && motor);
  let tick = mundo.tick;
  for (let dia = 1; tick < ticks; dia++) {
    const causasFauna: Record<string, number> = {};
    for (let t = 0; t < TICKS_PER_DAY && tick < ticks; t++) {
      const muertesFaunaAntes = mundo.animalDynamics.deaths;
      const anterior = tick;
      if (o.perfil || panel) {
        const cpu = o.perfil ? cpuMs() : 0, pared = performance.now();
        tick = paso();
        const ms = performance.now() - pared;
        if (o.perfil) { msCpu += cpuMs() - cpu; msPared += ms; }
        if (panel) {
          panel.pasosMedidos++;
          panel.pasoMaximoMs = Math.max(panel.pasoMaximoMs, ms);
          if (ms > 30_000) panel.pasosSobre30s++;
        }
      } else tick = paso();
      if (panel && tick !== anterior + 1) {
        throw new Error(`El paso saltó del tick ${anterior} al ${tick}.`);
      }
      const toca = cada === undefined || tick % cada === 0;
      const cierraDia = t + 1 === TICKS_PER_DAY || tick === ticks;
      const revisarPaso = toca || Boolean(panel && cierraDia);
      if (!panel || cierraDia || o.comprobar && revisarPaso) reunir(tick);
      if (params.v23.fauna && (leerCronicaViva || mundo.animalDynamics.deaths > muertesFaunaAntes)) {
        // El coordinador recoge los sucesos confirmados de todos los dueños en el mismo paso.
        const eventos = leerCronicaViva ? origen.events : mundo.events;
        for (let i = eventos.length - 1; i >= 0; i--) {
          const evento = eventos[i]!;
          if (evento.tick < tick) break;
          if (evento.kind === 'animal' && evento.text.startsWith('Muere un animal de ')) {
            causasFauna[evento.cause] = (causasFauna[evento.cause] ?? 0) + 1;
          }
        }
      }
      if (revisarPaso && revisar() && !o.continuar) return fin('violacion');
    }
    if (!panel && cada !== undefined && tick % cada !== 0 && revisar() && !o.continuar) return fin('violacion');
    const inicioArchivo = panel ? performance.now() : 0;
    archivar();
    if (panel) panel.archivoMaximoMs = Math.max(panel.archivoMaximoMs, performance.now() - inicioArchivo);
    const dinamica = mundo.demographyDynamics;
    const fauna = { ...mundo.animalDynamics };
    const vecinos = mundo.people.filter(p => p.role === 'neighbor');
    const mortales = vecinos.length;
    const nacimientos = mundo.totals.births ?? 0;
    escribirFila({
      tipo: 'dia', dia, tick: mundo.tick, poblacion: mortales, personas: mundo.people.length,
      ...(panel && { fundadoresMortalesVivos: vecinos.filter(p => fundadores.has(p.id)).length, regionesArchivadas: archivo.size }),
      nacimientos, nacidosDia: nacimientos - nacidosAntes, muertes: dinamica.deaths, muertesDia: dinamica.deaths - muertesAntes,
      muertesPorCausa: { ...dinamica.causes }, muertesPorCausaDia: Object.fromEntries(Object.entries(dinamica.causes).map(([k, v]) => [k, v - (causasAntes[k as keyof typeof causasAntes] ?? 0)])),
      fauna: mundo.animals.length, faunaDinamica: fauna,
      faunaDinamicaDia: {
        births: fauna.births - faunaAntes.births, deaths: fauna.deaths - faunaAntes.deaths,
        predations: fauna.predations - faunaAntes.predations, humanHunts: fauna.humanHunts - faunaAntes.humanHunts,
        waterConsumed: fauna.waterConsumed - faunaAntes.waterConsumed, plantConsumed: fauna.plantConsumed - faunaAntes.plantConsumed,
      },
      faunaMuertesPorCausaDia: causasFauna,
      vistasMedias: vistasMedias(mundo.tiles),
      comunidades: mundo.communities.length, estructuras: mundo.structures.length,
      totales: { ...mundo.totals }, conservacion: balanceConservacion(mundo), violaciones, duras,
      ...(params.motor.gpu.length ? { gpuMateria: diagnosticoMateriaGpu(mundo) } : {}),
    });
    nacidosAntes = nacimientos; muertesAntes = dinamica.deaths; causasAntes = { ...dinamica.causes };
    faunaAntes = fauna;
    if (!panel && mortales === 0) return fin('extinta', dia);
    if (o.topeMortales && mortales >= o.topeMortales) return fin('tope', dia);
  }
  return fin(duras ? 'violacion' : 'completo');
}

function digestoCompleto(mundo: World, archivo: ReadonlyMap<string, Buffer>, reunida?: Instantanea['materia']): string {
  const dueno = duenoSi(mundo);
  const materia = reunida === undefined ? dueno?.instantaneaMateria(dueno.pendientes()) : reunida;
  const hash = createHash('sha256').update(digestoCanonico(mundo));
  hash.update(serialize([mundo.siguienteUid, mundo.people.map(p => p.uid), mundo.animals.map(a => a.uid), materia]));
  for (const [clave, datos] of [...archivo].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    hash.update(serialize([clave, deserialize(datos)]));
  }
  return hash.digest('hex');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n') + '\n');
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
