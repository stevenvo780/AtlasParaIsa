import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { loadavg, totalmem } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { World } from '../../src/world/index.js';
import type { WorldParams } from '../../src/world/params.js';
import type { Violacion } from '../../src/world/invariantes.js';

type Estado = 'cumple' | 'falla' | 'desconocido';
export interface UmbralesPanel {
  M1: { dia: number; extincionesMax: number; puerta: boolean };
  M2: { dia: number; poblacionMin: number; fraccionMin: number; desde: number; minimoVentana: number };
  M3: { dia: number; ventana: number; nacimientosMin: number; fundadoresMax: number; causasMin: number; causas: string[] };
  M4: { desde: number; hasta: number; log2Min: number; log2Max: number; fraccionMin: number };
  M5: { durasMax: number; blandasPorRegionMax: number };
  M6: { presupuestoMs: number | null; pasoMaxMs: number; fraccionRamMax: number };
}

export const UMBRALES_PANEL: UmbralesPanel = {
  M1: { dia: 30, extincionesMax: 0, puerta: false },
  M2: { dia: 30, poblacionMin: 16, fraccionMin: 10 / 12, desde: 20, minimoVentana: 8 },
  M3: { dia: 30, ventana: 10, nacimientosMin: 1, fundadoresMax: 1, causasMin: 2, causas: ['starvation', 'dehydration', 'exposure', 'senescence'] },
  M4: { desde: 15, hasta: 30, log2Min: -1, log2Max: 4, fraccionMin: 11 / 12 },
  M5: { durasMax: 0, blandasPorRegionMax: 1e-6 },
  M6: { presupuestoMs: null, pasoMaxMs: 30_000, fraccionRamMax: 0.7 },
};

export interface CensoPanel {
  tipo: 'censo'; brazo: string; semilla: number; replica: number; dia: number; tick: number;
  mortales: number; nacimientos: number; muertes: number; causas: Record<string, number>;
  fundadoresMortalesVivos: number; comunidades: number; estructuras: number; fauna: number;
  biomasaMedia: number; diversidad: number; duras: number; blandas: number; comprobacionesRegion: number;
  ticksPorSegundo: number; pasoP95Ms: number; pasoMaxMs: number; rssMiB: number;
}
export interface CorridaPanel {
  brazo: string; semilla: number; replica: number; estado: 'completo' | 'error'; error?: string;
  censos: CensoPanel[]; presupuestoMs: number; ramBytes: number; maxRssMiB: number;
}
interface Veredicto { estado: Estado; motivo: string; puerta?: boolean; valores?: unknown }
type ConfigParcial = { [K in keyof UmbralesPanel]?: Partial<UmbralesPanel[K]> };

export function configurarPanel(parcial: ConfigParcial = {}): UmbralesPanel {
  const resultado = structuredClone(UMBRALES_PANEL);
  for (const clave of Object.keys(parcial) as (keyof UmbralesPanel)[]) {
    if (!(clave in resultado)) throw new Error(`Métrica desconocida: ${clave}`);
    if (!parcial[clave] || typeof parcial[clave] !== 'object' || Array.isArray(parcial[clave])) throw new Error(`Configuración inválida: ${clave}`);
    for (const [campo, valor] of Object.entries(parcial[clave]!)) {
      const original = (resultado[clave] as unknown as Record<string, unknown>)[campo];
      if (original === undefined) throw new Error(`Umbral desconocido: ${clave}.${campo}`);
      if (Array.isArray(original) ? !Array.isArray(valor) || valor.some(v => typeof v !== 'string') : original === null ? valor !== null && typeof valor !== 'number' : typeof valor !== typeof original) throw new Error(`Tipo inválido: ${clave}.${campo}`);
    }
    Object.assign(resultado[clave], parcial[clave]);
  }
  for (const [metrica, valores] of Object.entries(resultado)) for (const [campo, valor] of Object.entries(valores)) {
    if (typeof valor === 'number' && (!Number.isFinite(valor) || (campo !== 'log2Min' && campo !== 'log2Max' && valor < 0))) throw new Error(`${metrica}.${campo} debe ser finito y no negativo`);
  }
  for (const dia of [resultado.M1.dia, resultado.M2.dia, resultado.M2.desde, resultado.M3.dia, resultado.M3.ventana, resultado.M4.desde, resultado.M4.hasta]) {
    if (!Number.isInteger(dia) || dia < 0) throw new Error('Los días de los umbrales deben ser enteros no negativos');
  }
  for (const f of [resultado.M2.fraccionMin, resultado.M4.fraccionMin, resultado.M6.fraccionRamMax]) {
    if (f < 0 || f > 1) throw new Error('Las fracciones deben estar entre 0 y 1');
  }
  if (resultado.M2.desde > resultado.M2.dia || resultado.M4.desde >= resultado.M4.hasta || resultado.M3.ventana > resultado.M3.dia) throw new Error('Ventana de días inválida');
  return resultado;
}

function conjuncion(estados: Estado[]): Estado {
  return estados.includes('falla') ? 'falla' : estados.includes('desconocido') || estados.length === 0 ? 'desconocido' : 'cumple';
}
function proporcion(estados: Estado[], minimo: number): Estado {
  if (!estados.length) return 'desconocido';
  const cumple = estados.filter(e => e === 'cumple').length, desconocido = estados.filter(e => e === 'desconocido').length;
  if ((cumple + desconocido) / estados.length < minimo) return 'falla';
  return cumple / estados.length >= minimo ? 'cumple' : 'desconocido';
}
const decidir = (ok: boolean): Estado => ok ? 'cumple' : 'falla';

export function evaluarPanel(corridas: CorridaPanel[], u: UmbralesPanel = UMBRALES_PANEL): Record<keyof UmbralesPanel, Veredicto> {
  const dia = (r: CorridaPanel, n: number) => r.censos.find(c => c.dia === n);
  const extintas = corridas.filter(r => r.censos.some(c => c.dia <= u.M1.dia && c.mortales === 0)).length;
  const m1 = extintas > u.M1.extincionesMax ? 'falla' : corridas.length > 0 && corridas.every(r => dia(r, u.M1.dia)) ? 'cumple' : 'desconocido';
  const m2Final = corridas.map((r): Estado => { const final = dia(r, u.M2.dia); return final ? decidir(final.mortales >= u.M2.poblacionMin) : 'desconocido'; });
  const m2Ventana = corridas.map((r): Estado => {
    const ventana = r.censos.filter(c => c.dia >= u.M2.desde && c.dia <= u.M2.dia);
    if (ventana.some(c => c.mortales < u.M2.minimoVentana)) return 'falla';
    return ventana.length === u.M2.dia - u.M2.desde + 1 ? 'cumple' : 'desconocido';
  });
  const m3 = corridas.map((r): Estado => {
    const final = dia(r, u.M3.dia), base = dia(r, u.M3.dia - u.M3.ventana), inicial = dia(r, 0);
    if (!final || !base || !inicial) return 'desconocido';
    const conocidas = Object.entries(final.causas).every(([causa, n]) => n === 0 || u.M3.causas.includes(causa));
    const balance = final.mortales - inicial.mortales === final.nacimientos - inicial.nacimientos - (final.muertes - inicial.muertes);
    return decidir(final.nacimientos - base.nacimientos >= u.M3.nacimientosMin && final.fundadoresMortalesVivos <= u.M3.fundadoresMax
      && conocidas && Object.values(final.causas).reduce((a, b) => a + b, 0) === final.muertes
      && Object.values(final.causas).filter(n => n > 0).length >= u.M3.causasMin && balance);
  });
  const m4 = corridas.map((r): Estado => {
    const a = dia(r, u.M4.desde), b = dia(r, u.M4.hasta);
    if (!a || !b) return 'desconocido';
    if (a.mortales <= 0 || b.mortales <= 0) return 'falla';
    const crecimiento = Math.log2(b.mortales / a.mortales);
    return decidir(crecimiento >= u.M4.log2Min && crecimiento <= u.M4.log2Max);
  });
  const m5 = corridas.map((r): Estado => {
    const final = r.censos.at(-1);
    if (!final) return 'desconocido';
    if (final.duras > u.M5.durasMax || final.blandas > u.M5.blandasPorRegionMax * final.comprobacionesRegion) return 'falla';
    return r.estado === 'completo' && final.comprobacionesRegion > 0 ? 'cumple' : 'desconocido';
  });
  const m6 = corridas.map((r): Estado => {
    const final = r.censos.at(-1);
    if (!final) return 'desconocido';
    if (![final.pasoP95Ms, final.pasoMaxMs, u.M6.presupuestoMs ?? r.presupuestoMs, r.maxRssMiB, r.ramBytes].every(Number.isFinite)) return 'desconocido';
    if (final.pasoP95Ms > (u.M6.presupuestoMs ?? r.presupuestoMs) || final.pasoMaxMs > u.M6.pasoMaxMs
      || r.maxRssMiB * 1048576 > u.M6.fraccionRamMax * r.ramBytes) return 'falla';
    return r.estado === 'completo' && final.tick > 0 ? 'cumple' : 'desconocido';
  });
  return {
    M1: { estado: m1, puerta: u.M1.puerta, motivo: u.M1.puerta ? 'Extinción de mortales' : 'Informativa hasta integrar 0H Fundadores (AJUSTES §3)', valores: { extintas, corridas: corridas.length, dia: u.M1.dia } },
    M2: { estado: conjuncion([proporcion(m2Final, u.M2.fraccionMin), conjuncion(m2Ventana)]), motivo: 'Población al horizonte y mínimo en la ventana de todas las corridas', valores: { final: m2Final, ventana: m2Ventana } },
    M3: { estado: conjuncion(m3), motivo: 'C2: recambio en la ventana; C6: causas conocidas y diversas, balance exacto', valores: m3 },
    M4: { estado: proporcion(m4, u.M4.fraccionMin), motivo: 'Crecimiento log2 dentro del margen', valores: m4 },
    M5: { estado: conjuncion(m5), motivo: 'Violaciones acumuladas; denominador: regiones revisadas en comprobaciones completas', valores: m5 },
    M6: { estado: conjuncion(m6), motivo: 'p95 del paso sin diagnóstico, paso máximo y RSS de cada proceso', valores: m6 },
  };
}

export interface GrupoPermutacion { semilla: number; valores: number[] }
export function permutacionEstratificada(a: GrupoPermutacion[], b: GrupoPermutacion[], opciones: { iteraciones?: number; semilla?: number; alfa?: number; margen?: number } = {}) {
  const iteraciones = opciones.iteraciones ?? 10_000, alfa = opciones.alfa ?? 0.01 / 8, margen = opciones.margen ?? 0.2;
  if (!Number.isSafeInteger(iteraciones) || iteraciones < 1 || !Number.isFinite(alfa) || alfa <= 0 || alfa >= 1 || !Number.isFinite(margen) || margen < 0) throw new Error('Parámetros de permutación inválidos');
  if (a.length !== b.length || new Set(a.map(g => g.semilla)).size !== a.length || new Set(b.map(g => g.semilla)).size !== b.length) return { estado: 'desconocido' as Estado, motivo: 'Estratos repetidos o distintos entre brazos' };
  const grupos = a.map(x => ({ a: x.valores, b: b.find(y => y.semilla === x.semilla)?.valores ?? [] }));
  if (!grupos.length || grupos.some(g => !g.a.length || !g.b.length || [...g.a, ...g.b].some(n => !Number.isFinite(n)))) {
    return { estado: 'desconocido' as Estado, motivo: 'Faltan réplicas finitas de alguna semilla en un brazo' };
  }
  const media = (xs: number[]) => xs.reduce((n, x) => n + x, 0) / xs.length;
  // Réplicas idénticas (T=1 con semilla, o un motor aún determinista) son pseudorréplicas: cuentan como una observación.
  const sinCopias = (valores: number[]) => valores.every(v => v === valores[0]) ? [valores[0]!] : valores;
  for (const grupo of grupos) { grupo.a = sinCopias(grupo.a); grupo.b = sinCopias(grupo.b); }
  const observado = media(grupos.map(g => media(g.b) - media(g.a)));
  let azar = (opciones.semilla ?? 51926) >>> 0, extremos = 0;
  const siguiente = () => { azar = (Math.imul(azar, 1664525) + 1013904223) >>> 0; return azar / 4294967296; };
  for (let n = 0; n < iteraciones; n++) {
    const diferencias = grupos.map(g => {
      const valores = [...g.a, ...g.b];
      for (let i = valores.length - 1; i > 0; i--) { const j = Math.floor(siguiente() * (i + 1)); [valores[i], valores[j]] = [valores[j]!, valores[i]!]; }
      return media(valores.slice(g.a.length)) - media(valores.slice(0, g.a.length));
    });
    if (Math.abs(media(diferencias)) >= Math.abs(observado) - 1e-12) extremos++;
  }
  const p = (extremos + 1) / (iteraciones + 1), referencia = media(grupos.map(g => media(g.a))), efectoRelativo = referencia === 0 ? observado === 0 ? 0 : null : observado / Math.abs(referencia);
  // No rechazar igualdad no demuestra equivalencia con una muestra pequeña.
  const sospecha = p < alfa || efectoRelativo === null || Math.abs(efectoRelativo) > margen;
  return { estado: (sospecha ? 'falla' : 'desconocido') as Estado, motivo: sospecha ? 'Diferencia significativa o fuera del margen: repetir con tres réplicas más antes de concluir' : 'Sin diferencia detectada; la permutación no acredita equivalencia', p, alfa, observado, efectoRelativo, margen, iteraciones };
}

interface Trabajo {
  raiz: string; brazo: string; semilla: number; replica: number; dias: number; salida: string;
  regimen: 'abierto' | 'defecto'; hilos: number; gpu: number[]; cadaTicks: number; params?: string;
}
interface Opciones {
  semillas: number[]; replicas: number; dias: number; paralelo: number; salida: string; brazos: string[];
  regimen: Trabajo['regimen']; hilos: number; gpu: number[]; cadaTicks: number; config?: string; params?: string;
}
const importar = (raiz: string, ruta: string) => import(pathToFileURL(join(raiz, 'src', ruta)).href);
const escribir = (ruta: string, valor: unknown) => appendFileSync(ruta, `${JSON.stringify(valor)}\n`);

async function replica(trabajo: Trabajo): Promise<void> {
  process.title = 'carta-isa';
  const { createWorld, stepWorld, TICKS_PER_DAY } = await importar(trabajo.raiz, 'world/index.ts') as typeof import('../../src/world/index.js');
  const { parseParams, DEFAULT_PARAMS } = await importar(trabajo.raiz, 'world/params.ts') as typeof import('../../src/world/params.js');
  const { indiceDiversidad } = await importar(trabajo.raiz, 'world/diversidad.ts') as typeof import('../../src/world/diversidad.js');
  const rutaInvariantes = join(trabajo.raiz, 'src/world/invariantes.ts');
  const invariantes = existsSync(rutaInvariantes) ? await import(pathToFileURL(rutaInvariantes).href) as {
    comprobarInvariantes: (mundo: World) => Violacion[]; crearComprobador?: () => (mundo: World) => Violacion[];
  } : undefined;
  const comprobarInvariantes = invariantes?.crearComprobador?.() ?? invariantes?.comprobarInvariantes;
  let params: WorldParams = DEFAULT_PARAMS;
  if (trabajo.regimen === 'abierto') {
    const { hostOpenWorldParams } = await importar(trabajo.raiz, 'server/hardware-limits.ts') as typeof import('../../src/server/hardware-limits.js');
    params = hostOpenWorldParams();
  }
  if (trabajo.params) params = parseParams(JSON.parse(readFileSync(trabajo.params, 'utf8')), params);
  params = parseParams({ motor: { ...params.motor, hilos: trabajo.hilos, gpu: trabajo.gpu } }, params);
  if (TICKS_PER_DAY !== 2400) throw new Error(`El brazo usa ${TICKS_PER_DAY} ticks/día; se esperaban 2400`);
  const mundo = createWorld(trabajo.semilla, params), fundadores = new Set(mundo.people.filter(p => p.role === 'neighbor').map(p => p.id));
  const tiempos: number[] = [];
  let duras = 0, blandas = 0, comprobacionesRegion = 0, pasoMaxMs = 0, desde = performance.now(), tickDesde = 0;
  const revisar = () => {
    if (!comprobarInvariantes) return;
    const violaciones = comprobarInvariantes(mundo);
    duras += violaciones.filter(v => v.gravedad === 'dura').length;
    blandas += violaciones.filter(v => v.gravedad === 'blanda').length;
    const regiones = new Set(mundo.tiles.map(t => `${Math.floor(t.x / 16)},${Math.floor(t.y / 16)}`));
    comprobacionesRegion += Math.max(1, regiones.size);
    for (const violacion of violaciones) escribir(trabajo.salida, { tipo: 'violacion', brazo: trabajo.brazo, semilla: trabajo.semilla, replica: trabajo.replica, violacion });
  };
  const censo = (dia: number) => {
    const ahora = performance.now(), ordenados = [...tiempos].sort((a, b) => a - b), memoria = process.memoryUsage();
    const fila: CensoPanel = {
      tipo: 'censo', brazo: trabajo.brazo, semilla: trabajo.semilla, replica: trabajo.replica, dia, tick: mundo.tick,
      mortales: mundo.people.filter(p => p.role === 'neighbor').length, nacimientos: mundo.totals.births ?? 0,
      muertes: mundo.demographyDynamics.deaths, causas: { ...mundo.demographyDynamics.causes },
      fundadoresMortalesVivos: mundo.people.filter(p => fundadores.has(p.id)).length,
      comunidades: mundo.communities.length, estructuras: mundo.structures.length, fauna: mundo.animals.length,
      biomasaMedia: mundo.tiles.reduce((s, t) => s + t.vegetation, 0) / Math.max(1, mundo.tiles.length), diversidad: indiceDiversidad(mundo).total,
      duras, blandas, comprobacionesRegion, ticksPorSegundo: (mundo.tick - tickDesde) * 1000 / Math.max(1e-9, ahora - desde),
      pasoP95Ms: ordenados.length ? ordenados[Math.min(ordenados.length - 1, Math.ceil(ordenados.length * 0.95) - 1)]! : 0,
      pasoMaxMs, rssMiB: memoria.rss / 1048576,
    };
    escribir(trabajo.salida, fila); desde = ahora; tickDesde = mundo.tick;
  };
  escribir(trabajo.salida, { tipo: 'inicio', ...trabajo, params, carga: loadavg(), ramBytes: totalmem(), invariantesDisponibles: !!comprobarInvariantes, limitaciones: ['En memoria sin servidor ni BD: el catálogo tecnológico standalone puede divergir de producción', 'RSS y tiempos por proceso; no incluyen consumo de otros trabajos', ...(!comprobarInvariantes ? ['Este brazo no integra invariantes.ts: M5 desconocida'] : [])] });
  revisar(); censo(0);
  try {
    for (let dia = 1; dia <= trabajo.dias; dia++) {
      for (let t = 0; t < 2400; t++) {
        const inicioPaso = performance.now(); stepWorld(mundo);
        const ms = performance.now() - inicioPaso; tiempos.push(ms); pasoMaxMs = Math.max(pasoMaxMs, ms);
        if (mundo.tick % trabajo.cadaTicks === 0) revisar();
      }
      if (mundo.tick % trabajo.cadaTicks !== 0) revisar();
      censo(dia);
    }
    escribir(trabajo.salida, { tipo: 'fin', estado: 'completo', presupuestoMs: params.gobernador.presupuestoMs, maxRssMiB: process.resourceUsage().maxRSS / 1024 });
  } catch (error) {
    escribir(trabajo.salida, { tipo: 'fin', estado: 'error', error: String(error), presupuestoMs: params.gobernador.presupuestoMs, maxRssMiB: process.resourceUsage().maxRSS / 1024 });
    throw error;
  }
}

function numero(texto: string, nombre: string, minimo = 1): number {
  const n = Number(texto);
  if (!Number.isSafeInteger(n) || n < minimo) throw new Error(`${nombre}: se esperaba un entero ≥ ${minimo}`);
  return n;
}
function argumentos(args: string[]): Opciones {
  const o: Opciones = { semillas: [51926, 19104, 19101, 19103], replicas: 3, dias: 30, paralelo: 4,
    salida: `/tmp/atlas-v23-0c/panel-${Date.now()}`, brazos: [process.cwd()], regimen: 'abierto', hilos: 1, gpu: [], cadaTicks: 120 };
  let brazoExplicito = false;
  for (let i = 0; i < args.length; i++) {
    const bandera = args[i]!, valor = args[++i];
    if (valor === undefined) throw new Error(`Falta valor para ${bandera}`);
    switch (bandera) {
      case '--semillas': o.semillas = valor.split(',').map(s => numero(s, bandera, 0)); break;
      case '--replicas': o.replicas = numero(valor, bandera); break;
      case '--dias': o.dias = numero(valor, bandera); break;
      case '--paralelo': o.paralelo = numero(valor, bandera); break;
      case '--salida': o.salida = resolve(valor); break;
      case '--brazo': if (!brazoExplicito) o.brazos = []; o.brazos.push(resolve(valor)); brazoExplicito = true; break;
      case '--comparar': o.brazos = valor.split(',').map(p => resolve(p)); brazoExplicito = true; break;
      case '--regimen': if (valor !== 'abierto' && valor !== 'defecto') throw new Error('Régimen inválido'); o.regimen = valor; break;
      case '--hilos': o.hilos = numero(valor, bandera); break;
      case '--gpu': o.gpu = valor === 'sin' ? [] : valor.split(',').map(s => numero(s, bandera, 0)); break;
      case '--cada-ticks': o.cadaTicks = numero(valor, bandera); break;
      case '--config': o.config = resolve(valor); break;
      case '--params': o.params = resolve(valor); break;
      default: throw new Error(`Opción desconocida: ${bandera}`);
    }
  }
  if (!o.semillas.length || new Set(o.semillas).size !== o.semillas.length) throw new Error('Semillas vacías o repetidas');
  if (o.brazos.length < 1 || o.brazos.length > 2 || new Set(o.brazos).size !== o.brazos.length) throw new Error('Se requieren uno o dos brazos distintos');
  return o;
}

function leerCorrida(trabajo: Trabajo): CorridaPanel {
  const filas = readFileSync(trabajo.salida, 'utf8').trim().split('\n').filter(Boolean).map(f => JSON.parse(f));
  const inicio = filas.find(f => f.tipo === 'inicio'), fin = filas.filter(f => f.tipo === 'fin').at(-1), falloProceso = filas.find(f => f.tipo === 'proceso-error');
  return { brazo: trabajo.brazo, semilla: trabajo.semilla, replica: trabajo.replica, censos: filas.filter(f => f.tipo === 'censo'),
    estado: fin?.estado === 'completo' ? 'completo' : 'error', error: fin?.error ?? falloProceso?.error ?? (!fin ? 'El proceso terminó sin fila fin' : undefined),
    presupuestoMs: fin?.presupuestoMs ?? inicio?.params?.gobernador?.presupuestoMs ?? NaN, ramBytes: inicio?.ramBytes ?? totalmem(), maxRssMiB: fin?.maxRssMiB ?? Infinity };
}

async function panel(o: Opciones): Promise<void> {
  const umbrales = configurarPanel(o.config ? JSON.parse(readFileSync(o.config, 'utf8')) : undefined);
  mkdirSync(o.salida, { recursive: true });
  const trabajos: Trabajo[] = [];
  for (const semilla of o.semillas) for (let replica = 1; replica <= o.replicas; replica++) for (const [indice, raiz] of o.brazos.entries()) {
    const brazo = `${indice + 1}-${basename(raiz)}`;
    const salida = join(o.salida, `${brazo}-${semilla}-${replica}.jsonl`);
    if (existsSync(salida)) throw new Error(`La salida ya existe: ${salida}`);
    trabajos.push({ raiz, brazo, semilla, replica, dias: o.dias, salida, regimen: o.regimen, hilos: o.hilos, gpu: o.gpu, cadaTicks: o.cadaTicks, params: o.params });
  }
  writeFileSync(join(o.salida, 'config.json'), JSON.stringify({ ...o, umbrales, carga: loadavg(), ramBytes: totalmem() }, null, 2));
  mkdirSync('/tmp/atlas-v23-0c', { recursive: true });
  const temporal = mkdtempSync('/tmp/atlas-v23-0c/panel-bin-'), ejecutable = join(temporal, 'carta-isa');
  symlinkSync(realpathSync(process.execPath), ejecutable);
  const activos = new Set<ReturnType<typeof spawn>>();
  let cancelado = false;
  const detener = () => { cancelado = true; for (const hijo of activos) hijo.kill('SIGTERM'); };
  process.once('SIGTERM', detener); process.once('SIGINT', detener);
  let cursor = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(o.paralelo, trabajos.length) }, async () => {
      while (!cancelado && cursor < trabajos.length) {
        const trabajo = trabajos[cursor++]!;
        writeFileSync(trabajo.salida, '');
        await new Promise<void>((cumplir) => {
          const hijo = spawn(ejecutable, ['--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url), '--worker', JSON.stringify(trabajo)], { cwd: trabajo.raiz, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CARTA_DATA_DIR: temporal } });
          activos.add(hijo);
          let error = '';
          hijo.stderr?.on('data', b => { error = (error + String(b)).slice(-8192); });
          hijo.once('error', e => { escribir(trabajo.salida, { tipo: 'fin', estado: 'error', error: String(e) }); });
          hijo.once('close', codigo => {
            activos.delete(hijo);
            if (codigo !== 0) escribir(trabajo.salida, { tipo: 'proceso-error', codigo, error });
            cumplir();
          });
        });
      }
    }));
  } finally {
    detener(); process.removeListener('SIGTERM', detener); process.removeListener('SIGINT', detener); rmSync(temporal, { recursive: true, force: true });
  }
  const corridas = trabajos.map(trabajo => existsSync(trabajo.salida) ? leerCorrida(trabajo) : { brazo: trabajo.brazo, semilla: trabajo.semilla, replica: trabajo.replica, censos: [], estado: 'error' as const, error: 'Cancelada antes del arranque', presupuestoMs: NaN, ramBytes: totalmem(), maxRssMiB: Infinity });
  const brazos = Object.fromEntries([...new Set(corridas.map(r => r.brazo))].map(brazo => [brazo, evaluarPanel(corridas.filter(r => r.brazo === brazo), umbrales)]));
  const comparacion: Record<string, unknown> = {};
  if (o.brazos.length === 2) {
    const nombres = Object.keys(brazos);
    for (const metrica of ['mortales', 'nacimientos', 'biomasaMedia', 'diversidad'] as const) {
      const grupos = nombres.map(brazo => o.semillas.map(semilla => ({ semilla, valores: corridas.filter(r => r.brazo === brazo && r.semilla === semilla && r.estado === 'completo').flatMap(r => { const final = r.censos.find(c => c.dia === o.dias); return final ? [final[metrica]] : []; }) })));
      comparacion[metrica] = grupos.some(gs => gs.some(g => g.valores.length !== o.replicas)) ? { estado: 'desconocido', motivo: 'Faltan réplicas completas' }
        : permutacionEstratificada(grupos[0]!, grupos[1]!);
    }
  }
  // Una semilla cuyas réplicas completas dan el mismo censo biológico aporta una sola observación independiente.
  const huella = (r: CorridaPanel) => JSON.stringify(r.censos.map(({ replica, ticksPorSegundo, pasoP95Ms, pasoMaxMs, rssMiB, ...biologia }) => biologia));
  const pseudorreplicas = [...new Set(corridas.map(r => `${r.brazo}/${r.semilla}`))].filter(clave => {
    const huellas = corridas.filter(r => `${r.brazo}/${r.semilla}` === clave && r.estado === 'completo').map(huella);
    return huellas.length > 1 && new Set(huellas).size === 1;
  });
  const informe = { brazos, comparacion, pseudorreplicas, corridas, umbrales, limitaciones: ['M1 es informativa hasta integrar 0H', 'Un panel corto deja desconocidas las métricas cuyo horizonte no alcanza', 'Réplicas idénticas dentro de una semilla (pseudorreplicas) cuentan como una en la permutación, pero no en las proporciones M1-M6', 'Permutación: diferencia de medias estratificada; no equivale a demostrar equivalencia', 'Sin servidor ni BD: no mide persistencia, gobernador ni el catálogo tecnológico de producción'] };
  writeFileSync(join(o.salida, 'panel.json'), JSON.stringify(informe, null, 2));
  process.stdout.write(`${JSON.stringify({ salida: o.salida, brazos, comparacion, pseudorreplicas })}\n`);
  if (corridas.some(r => r.estado === 'error')) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    process.stdout.write('tsx scripts/lab/panel.ts [--semillas 51926,19104,19101,19103] [--replicas 3] [--dias 30] [--paralelo 4] [--regimen abierto|defecto] [--hilos 1] [--gpu sin] [--cada-ticks 120] [--config umbrales.json] [--params params.json] [--brazo directorio (hasta dos)] [--salida directorio]\n');
  } else if (process.argv[2] === '--worker') {
    replica(JSON.parse(process.argv[3]!)).then(() => process.exit(0)).catch(error => { process.stderr.write(`${String(error)}\n`); process.exit(1); });
  } else {
    Promise.resolve().then(() => panel(argumentos(process.argv.slice(2)))).catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
  }
}
