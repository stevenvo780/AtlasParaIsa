/** node --import tsx scripts/lab/panel-corto/evaluar.mts DIR */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMOGRAPHY_TICKS_PER_DAY as TICKS_DIA, type DemographicDeathCause } from '../../../src/shared/demography.js';

const SEMILLAS = [51926, 19104, 19101, 19103] as const;
const DIAS_PANEL = 30;
const PASO_MAXIMO_MS = 30_000;
const CAUSAS = ['starvation', 'dehydration', 'exposure', 'senescence'] as const satisfies readonly DemographicDeathCause[];

type Dict = Record<string, unknown>;
type Estado = 'cumple' | 'falla' | 'desconocido';
type Veredicto = Estado | 'no_aplica';
interface Replica { semilla: number; replica: number; ruta: string }
interface Manifiesto {
  commit: string;
  modo: 'panel' | 'smoke';
  objetivoDias: number;
  ticksObjetivo: number;
  ramFisicaBytes: number;
  perfil: { hilos: number; gpu: number[]; cada: number };
  replicas: Replica[];
}
interface Demografia { poblacion: number; nacimientos: number; muertes: number; causas: Record<string, number> }
interface Dia {
  dia: number;
  poblacion: number | null;
  nacimientos: number | null;
  demografia: Demografia | null;
  fundadoresMortalesVivos: number | null;
  conservacion: boolean | null;
}

const objeto = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);
const contador = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const positivo = (v: unknown): v is number => contador(v) && v > 0;
const num = (v: unknown): number | null => contador(v) ? v : null;
const bool = (v: unknown): boolean | null => typeof v === 'boolean' ? v : null;
const estado = (v: boolean | null): Estado => v === null ? 'desconocido' : v ? 'cumple' : 'falla';
function todas(estados: readonly Estado[]): Estado {
  if (estados.includes('falla')) return 'falla';
  return estados.includes('desconocido') ? 'desconocido' : 'cumple';
}

function leerManifiesto(valor: unknown): Manifiesto {
  if (!objeto(valor)) throw new Error('Se esperaba un objeto JSON');
  const { commit, modo, objetivoDias, ticksObjetivo, ramFisicaBytes, perfil, replicas } = valor;
  if (typeof commit !== 'string' || !/^[a-f0-9]{7,64}$/.test(commit)) throw new Error('commit inválido');
  if (modo !== 'panel' && modo !== 'smoke') throw new Error('modo debe ser panel o smoke');
  if (!positivo(objetivoDias) || !positivo(ticksObjetivo) || Math.ceil(ticksObjetivo / TICKS_DIA) !== objetivoDias) {
    throw new Error('objetivoDias y ticksObjetivo no corresponden');
  }
  if (!positivo(ramFisicaBytes)) throw new Error('Falta la RAM física en bytes');
  if (!objeto(perfil) || !positivo(perfil.hilos) || !positivo(perfil.cada) || !Array.isArray(perfil.gpu)
      || !perfil.gpu.every(contador) || new Set(perfil.gpu).size !== perfil.gpu.length) throw new Error('perfil inválido');
  if (!Array.isArray(replicas) || !replicas.length) throw new Error('Faltan réplicas');
  const ids = new Set<string>();
  const corridas = replicas.map((fila: unknown): Replica => {
    if (!objeto(fila) || !contador(fila.semilla) || !positivo(fila.replica) || fila.ruta !== `${fila.semilla}-${fila.replica}`) {
      throw new Error('Identificador o ruta de réplica inválidos');
    }
    if (ids.has(fila.ruta)) throw new Error(`Réplica duplicada ${fila.ruta}`);
    ids.add(fila.ruta);
    return { semilla: fila.semilla, replica: fila.replica, ruta: fila.ruta };
  });
  if (modo === 'panel') {
    const esperados = SEMILLAS.flatMap(s => [1, 2, 3].map(r => `${s}-${r}`));
    if (ids.size !== esperados.length || esperados.some(id => !ids.has(id))) throw new Error('El panel exige los doce IDs de las cuatro semillas prescritas');
    if (objetivoDias !== DIAS_PANEL || ticksObjetivo !== DIAS_PANEL * TICKS_DIA) throw new Error('El panel exige treinta días completos');
  }
  return { commit, modo, objetivoDias, ticksObjetivo, ramFisicaBytes, perfil: { hilos: perfil.hilos, gpu: perfil.gpu, cada: perfil.cada }, replicas: corridas };
}

function leerCorrida(dir: string, errores: string[]): Dict[] {
  try {
    const texto = readFileSync(join(dir, 'corrida.jsonl'), 'utf8');
    return texto.trimEnd().split(/\r?\n/).flatMap((linea, i) => {
      try {
        const fila: unknown = JSON.parse(linea);
        if (objeto(fila) && ['inicio', 'dia', 'fin', 'violacion', 'aviso'].some(tipo => fila.tipo === tipo)) return [fila];
      } catch { /* el número de línea permite localizar el error sin copiar su contenido */ }
      errores.push(`corrida.jsonl:${i + 1} ilegible`);
      return [];
    });
  } catch {
    errores.push('corrida.jsonl ausente o ilegible');
    return [];
  }
}

function leerCodigo(dir: string, errores: string[]): number | null {
  try {
    const codigo = readFileSync(join(dir, 'codigo.exit'), 'utf8').trim();
    if (/^(0|[1-9][0-9]{0,2})$/.test(codigo) && Number(codigo) <= 255) return Number(codigo);
  } catch { /* el mismo diagnóstico cubre un archivo ausente o ilegible */ }
  errores.push('codigo.exit ausente o ilegible');
  return null;
}

function demografia(poblacion: unknown, nacimientos: unknown, muertes: unknown, causas: unknown): Demografia | null {
  if (!contador(poblacion) || !contador(nacimientos) || !contador(muertes) || !objeto(causas)) return null;
  if (CAUSAS.some(c => !Object.hasOwn(causas, c)) || !Object.values(causas).every(contador)) return null;
  return { poblacion, nacimientos, muertes, causas: causas as Record<string, number> };
}

const muertesDe = (d: Demografia, causa: string): number => Object.hasOwn(d.causas, causa) ? d.causas[causa] : 0;

function balanceDemografico(inicial: Demografia | null, dias: readonly Dia[], totalDias: number, errores: string[]) {
  let anterior = inicial;
  const residuos: { dia: number; poblacion: number; muertesPorCausa: string }[] = [];
  const decrecen: number[] = [];
  const causasDesconocidas = new Set<string>();
  for (const { dia, demografia: actual } of [{ dia: 0, demografia: inicial }, ...dias]) {
    if (!actual) {
      anterior = null;
      continue;
    }
    const totalCausas = Object.values(actual.causas).reduce((s, n) => s + BigInt(n), 0n);
    const residuoCausas = BigInt(actual.muertes) - totalCausas;
    const residuoPoblacion = anterior ? (actual.poblacion - anterior.poblacion) - ((actual.nacimientos - anterior.nacimientos) - (actual.muertes - anterior.muertes)) : 0;
    if (residuoCausas !== 0n || residuoPoblacion !== 0) residuos.push({ dia, poblacion: residuoPoblacion, muertesPorCausa: String(residuoCausas) });
    if (anterior && (actual.nacimientos < anterior.nacimientos || actual.muertes < anterior.muertes
      || Object.entries(anterior.causas).some(([causa, n]) => muertesDe(actual, causa) < n))) decrecen.push(dia);
    if (dia > 0 && inicial) {
      for (const [causa, n] of Object.entries(actual.causas)) {
        if (!(CAUSAS as readonly string[]).includes(causa) && n > muertesDe(inicial, causa)) causasDesconocidas.add(causa);
      }
    }
    anterior = actual;
  }
  if (decrecen.length) errores.push(`Acumulados demográficos decrecientes en D${decrecen.join(', D')}`);
  const ultimo = dias.find(fila => fila.dia === totalDias)?.demografia;
  const causasVentana = inicial && ultimo ? Object.fromEntries(CAUSAS.map(c => [c, ultimo.causas[c] - inicial.causas[c]])) : null;
  const causasDistintas = causasVentana && Object.values(causasVentana).filter(n => n > 0).length;
  const completa = inicial && dias.length === totalDias && dias.every(d => d.demografia) && !decrecen.length;
  const balanceExacto = residuos.length || causasDesconocidas.size ? false : completa ? true : null;
  return { balanceExacto, residuos, causasVentana, causasDistintas, causasDesconocidas: [...causasDesconocidas] };
}

function leerDias(filas: Dict[], inicial: Demografia | null, m: Manifiesto, errores: string[]): Map<number, Dia> {
  const dias = new Map<number, Dia>();
  let ultimoDia = 0;
  for (const fila of filas.filter(f => f.tipo === 'dia')) {
    const { dia, tick } = fila;
    if (!positivo(dia) || dia > m.objetivoDias || dia <= ultimoDia || tick !== Math.min(dia * TICKS_DIA, m.ticksObjetivo)) {
      errores.push(`Fila diaria fuera de secuencia o de reloj (día ${num(dia) ?? '?'}, tick ${num(tick) ?? '?'})`);
      continue;
    }
    const datos = demografia(fila.poblacion, fila.nacimientos, fila.muertes, fila.muertesPorCausa);
    const fundadores = num(fila.fundadoresMortalesVivos);
    const topeFundadores = Math.min(inicial?.poblacion ?? Infinity, num(fila.poblacion) ?? Infinity,
      dias.get(ultimoDia)?.fundadoresMortalesVivos ?? Infinity);
    const fundadoresMortalesVivos = fundadores !== null && fundadores <= topeFundadores ? fundadores : null;
    const conservacion = objeto(fila.conservacion) ? bool(fila.conservacion.ok) : null;
    if (!datos || fundadoresMortalesVivos === null || conservacion === null) errores.push(`Evidencia demográfica o material ausente o inválida en D${dia}`);
    dias.set(dia, { dia, poblacion: num(fila.poblacion), nacimientos: num(fila.nacimientos),
      demografia: datos, fundadoresMortalesVivos, conservacion });
    ultimoDia = dia;
  }
  if (dias.size !== m.objetivoDias) errores.push(`Cobertura diaria ${dias.size}/${m.objetivoDias}`);
  return dias;
}

function leerCierre(filas: Dict[], codigo: number | null, m: Manifiesto, errores: string[]) {
  const ultimo = filas.at(-1);
  const fin = ultimo?.tipo === 'fin' && filas.filter(f => f.tipo === 'fin').length === 1 ? ultimo : null;
  const tick = num(fin?.tick);
  const estadoFin = typeof fin?.estado === 'string' ? fin.estado : null;
  const duras = num(fin?.duras), violaciones = num(fin?.violaciones);
  const cierreSano = estadoFin === 'completo' && codigo === 0 && duras === 0;
  const cierreConViolacion = estadoFin === 'violacion' && codigo === 2 && duras !== null && duras > 0;
  if (tick !== m.ticksObjetivo || !(cierreSano || cierreConViolacion)) errores.push('Cierre ausente, interrumpido o con error de ejecución');
  const anotadas = filas.filter(f => f.tipo === 'violacion');
  const durasAnotadas = anotadas.filter(f => f.gravedad === 'dura').length;
  const blandasAnotadas = anotadas.filter(f => f.gravedad === 'blanda').length;
  const conteoValido = duras === durasAnotadas && violaciones === anotadas.length && durasAnotadas + blandasAnotadas === anotadas.length;
  if (!conteoValido) errores.push('Conteos de violaciones ausentes o distintos de la bitácora');
  const medicion = objeto(fin?.puertaCorta) ? fin.puertaCorta : {};
  const comprobacionesRegiones = positivo(medicion.comprobacionesRegiones) ? medicion.comprobacionesRegiones : null;
  if (comprobacionesRegiones === null) errores.push('Falta un número positivo de comprobaciones de región');
  const pasosMedidos = num(medicion.pasosMedidos), pasosSobre30s = num(medicion.pasosSobre30s);
  const pasoMaximoMs = typeof medicion.pasoMaximoMs === 'number' && Number.isFinite(medicion.pasoMaximoMs) && medicion.pasoMaximoMs > 0 ? medicion.pasoMaximoMs : null;
  const rssPicoKiB = positivo(medicion.rssPicoKiB) ? medicion.rssPicoKiB : null;
  const rendimientoCompleto = pasosMedidos === m.ticksObjetivo && pasosSobre30s !== null && pasosSobre30s <= pasosMedidos
    && pasoMaximoMs !== null && (pasoMaximoMs > PASO_MAXIMO_MS) === (pasosSobre30s > 0) && rssPicoKiB !== null;
  if (!rendimientoCompleto) errores.push('Medición de paso o RSS ausente, incompleta o incoherente');
  const rssPorcentaje = rssPicoKiB === null ? null : rssPicoKiB * 1024 * 100 / m.ramFisicaBytes;
  const excedeRss = rssPicoKiB !== null && BigInt(rssPicoKiB) * 10_240n > BigInt(m.ramFisicaBytes) * 7n;
  return { cierre: { codigo, estado: estadoFin, tick }, duras, durasAnotadas, blandas: conteoValido ? blandasAnotadas : null, comprobacionesRegiones,
    M6: { estado: estado(rendimientoCompleto ? pasosSobre30s === 0 && !excedeRss : null), pasosMedidos, pasoMaximoMs, pasosSobre30s, rssPicoKiB, rssPorcentaje } };
}

function evaluarReplica(dir: string, replica: Replica, m: Manifiesto) {
  const errores: string[] = [];
  const filas = leerCorrida(dir, errores);
  const codigo = leerCodigo(dir, errores);
  const inicio = filas[0]?.tipo === 'inicio' && filas.filter(f => f.tipo === 'inicio').length === 1 ? filas[0] : null;
  if (!inicio || inicio.semilla !== replica.semilla || inicio.tick !== 0 || inicio.dia !== 0 || inicio.comprobar !== true
      || inicio.ticksPorDia !== TICKS_DIA || inicio.cada !== m.perfil.cada || inicio.hilos !== m.perfil.hilos
      || !Array.isArray(inicio.gpu) || inicio.gpu.length !== m.perfil.gpu.length || inicio.gpu.some((v, i) => v !== m.perfil.gpu[i])) {
    errores.push('Inicio ausente, duplicado o incompatible con la semilla, el reloj o el perfil');
  }
  const arranque = objeto(inicio?.puertaCorta) ? inicio.puertaCorta : {};
  const cohorteFundadoraHomogenea = bool(arranque.cohorteFundadoraHomogenea);
  const inicial = demografia(arranque.poblacionInicial, arranque.nacimientosIniciales, arranque.muertesIniciales, arranque.muertesPorCausaIniciales);
  if (!inicial || cohorteFundadoraHomogenea === null) errores.push('Faltan datos demográficos iniciales');

  const dias = leerDias(filas, inicial, m, errores);
  const { cierre, duras, durasAnotadas, blandas, comprobacionesRegiones, M6 } = leerCierre(filas, codigo, m, errores);

  const diaria = [...dias.values()];
  const balancesMateriales = diaria.filter(d => d.conservacion !== null).length;
  const fallosMateriales = diaria.filter(d => d.conservacion === false).map(d => d.dia);
  const balanceMaterial = estado(fallosMateriales.length ? false : balancesMateriales === m.objetivoDias ? true : null);
  const balance = balanceDemografico(inicial, diaria, m.objetivoDias, errores);

  const diaExtincion = inicial?.poblacion === 0 ? 0 : diaria.find(d => d.poblacion === 0)?.dia ?? null;
  const antesD30 = diaExtincion !== null && diaExtincion < DIAS_PANEL;
  const coberturaM1 = inicial !== null && Array.from({ length: DIAS_PANEL - 1 }, (_, i) => dias.get(i + 1)?.poblacion ?? null).every(p => p !== null);
  const mortalD30 = dias.get(30)?.poblacion ?? null;
  const mortalD15 = dias.get(15)?.poblacion ?? null;
  const poblacionesD20aD30 = Array.from({ length: 11 }, (_, i) => dias.get(i + 20)?.poblacion ?? null);
  const minimoD20aD30 = poblacionesD20aD30.every(p => p !== null) ? Math.min(...poblacionesD20aD30) : null;
  const nacimientosD30 = dias.get(30)?.nacimientos ?? null;
  const nacimientosD20 = dias.get(20)?.nacimientos ?? null;
  const nacimientosD21aD30 = nacimientosD30 !== null && nacimientosD20 !== null && nacimientosD30 >= nacimientosD20 ? nacimientosD30 - nacimientosD20 : null;
  const fundadoresMortalesD30 = dias.get(30)?.fundadoresMortalesVivos ?? null;
  const C2 = todas([estado(nacimientosD21aD30 === null ? null : nacimientosD21aD30 >= 1),
    estado(fundadoresMortalesD30 === null ? null : fundadoresMortalesD30 <= 1)]);
  const C6 = todas([estado(balance.balanceExacto), estado(balance.causasDistintas === null ? null : balance.causasDistintas >= 2)]);
  const log2 = mortalD15 && mortalD30 ? Math.log2(mortalD30 / mortalD15) : null;
  return {
    ...replica, errores, inicio: { cohorteFundadoraHomogenea, demografia: inicial }, cierre, diasLeidos: diaria.length,
    M1: { estado: estado(antesD30 ? false : coberturaM1 ? true : null), informativo: cohorteFundadoraHomogenea === true, diaExtincion },
    M2: { estado: todas([estado(mortalD30 === null ? null : mortalD30 >= 16), estado(minimoD20aD30 === null ? null : minimoD20aD30 >= 8)]), mortalD30, minimoD20aD30 },
    M3: { estado: todas([C2, C6]), C2: { estado: C2, nacimientosD21aD30, fundadoresMortalesD30 }, C6: { estado: C6, ...balance } },
    M4: { estado: estado(mortalD15 === null || mortalD30 === null ? null : log2 !== null && log2 >= -1 && log2 <= 4), mortalD15, mortalD30, log2 },
    M5: { duras, blandas, durasAnotadas, comprobacionesRegiones, tasaBlandas: blandas !== null && comprobacionesRegiones !== null ? blandas / comprobacionesRegiones : null,
      balanceMaterial, balancesMateriales, fallosMateriales },
    M6,
  };
}

function quorum(estados: Estado[], minimo: number) {
  const cumplen = estados.filter(e => e === 'cumple').length;
  const desconocidos = estados.filter(e => e === 'desconocido').length;
  return { estado: estado(cumplen >= minimo ? true : cumplen + desconocidos < minimo ? false : null), cumplen, desconocidos, minimo };
}

export function evaluarPanel(dir: string) {
  let manifiesto: Manifiesto;
  try {
    manifiesto = leerManifiesto(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));
  } catch (error) {
    return { veredicto: 'desconocido' as const, aprobado: false, instrumentacion: 'incompleta' as const,
      errores: [`manifest.json: ${error instanceof Error ? error.message : String(error)}`], metricas: null, replicas: [], codigoSalida: 1 };
  }
  const replicas = manifiesto.replicas.map(r => evaluarReplica(join(dir, r.ruta), r, manifiesto));
  const errores = replicas.flatMap(r => r.errores.map(error => `${r.ruta}: ${error}`));
  const totalBlandas = replicas.reduce((s, r) => s + (r.M5.blandas ?? 0), 0);
  const totalRegiones = replicas.reduce((s, r) => s + BigInt(r.M5.comprobacionesRegiones ?? 0), 0n);
  const conocidas = replicas.every(r => r.M5.blandas !== null && r.M5.comprobacionesRegiones !== null);
  const M5 = { estado: todas([
    estado(replicas.some(r => r.M5.durasAnotadas > 0 || (r.M5.duras ?? 0) > 0) ? false : conocidas ? true : null),
    estado(conocidas ? BigInt(totalBlandas) * 1_000_000n <= totalRegiones : null), ...replicas.map(r => r.M5.balanceMaterial),
  ]), blandas: conocidas ? totalBlandas : null,
  comprobacionesRegiones: conocidas ? totalRegiones <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(totalRegiones) : String(totalRegiones) : null,
  tasaBlandas: conocidas ? totalBlandas / Number(totalRegiones) : null };
  const M6 = { estado: todas(replicas.map(r => r.M6.estado)) };
  const M4 = quorum(replicas.map(r => r.M4.estado), 11);
  const metricas = manifiesto.modo === 'smoke' ? null : {
    M1: { estado: todas(replicas.map(r => r.M1.estado)),
      estadoExigible: todas(replicas.filter(r => !r.M1.informativo).map(r => r.inicio.cohorteFundadoraHomogenea === null ? 'desconocido' : r.M1.estado)),
      extincionesAntesD30: replicas.filter(r => r.M1.diaExtincion !== null && r.M1.diaExtincion < DIAS_PANEL).length,
      informativas: replicas.filter(r => r.M1.informativo).length },
    M2: quorum(replicas.map(r => r.M2.estado), 10),
    M3: { estado: todas(replicas.map(r => r.M3.estado)), criterio: 'C2 y C6 por réplica, sin cuórum definido en VALIDACION.md' },
    M4: { ...M4, requiereRevisionHumana: M4.estado === 'falla' }, M5, M6,
  };
  const instrumentacion = errores.length ? 'incompleta' : 'completa';
  const veredicto: Veredicto = metricas === null ? 'no_aplica' : errores.length ? 'desconocido'
    : todas([metricas.M1.estadoExigible, ...[metricas.M2, metricas.M3, metricas.M4, M5, M6].map(m => m.estado)]);
  const aprobado = veredicto === 'cumple';
  const smokeSano = manifiesto.modo === 'smoke' && errores.length === 0 && M5.estado === 'cumple' && M6.estado === 'cumple'
    && replicas.every(r => r.M3.C6.balanceExacto === true);
  return { ...manifiesto, veredicto, aprobado, instrumentacion, errores, metricas, replicas, codigoSalida: aprobado || smokeSano ? 0 : 1 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, ...extras] = process.argv.slice(2);
  if (!dir || extras.length) {
    process.stderr.write('Uso: node --import tsx scripts/lab/panel-corto/evaluar.mts DIR\n');
    process.exitCode = 2;
  } else {
    const resumen = evaluarPanel(dir);
    process.stdout.write(`${JSON.stringify(resumen, null, 2)}\n`);
    process.exitCode = resumen.codigoSalida;
  }
}
