import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { loadavg, totalmem } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import type { World } from '../../src/world/index.js';
import type { WorldParams } from '../../src/world/params.js';
import type { Chunk } from '../../src/world/terrain.js';
import type { Violacion } from '../../src/world/invariantes.js';

const TICKS_POR_DIA = 2400;
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
  censos: CensoPanel[]; ramBytes: number; maxRssMiB: number;
  /** Día en que la corrida se detuvo por pasar de `--tope-mortales`: viva, con lo posterior desconocido. */
  tope?: number;
  /** Día en que no quedó ningún mortal: la corrida termina ahí y el mundo vacío ya no se simula. */
  extinta?: number;
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

/** Una corrida extinta termina el día en que no queda ningún mortal. Para las puertas sigue extinta, con lo contado
 * hasta entonces, en todos los días posteriores que miran los umbrales: es lo que habría dado simular el mundo vacío. */
function extenderExtinta(r: CorridaPanel, u: UmbralesPanel): CorridaPanel {
  const ultimo = r.censos.at(-1);
  if (r.extinta === undefined || !ultimo) return r;
  const hasta = Math.max(u.M1.dia, u.M2.dia, u.M3.dia, u.M4.hasta), relleno: CensoPanel[] = [];
  for (let dia = ultimo.dia + 1; dia <= hasta; dia++) relleno.push({ ...ultimo, dia, tick: ultimo.tick + (dia - ultimo.dia) * TICKS_POR_DIA });
  return { ...r, censos: [...r.censos, ...relleno] };
}

export function evaluarPanel(corridasLeidas: CorridaPanel[], u: UmbralesPanel = UMBRALES_PANEL): Record<keyof UmbralesPanel, Veredicto> {
  const corridas = corridasLeidas.map(r => extenderExtinta(r, u));
  const dia = (r: CorridaPanel, n: number) => r.censos.find(c => c.dia === n);
  const extintas = corridas.filter(r => r.censos.some(c => c.dia <= u.M1.dia && c.mortales === 0)).length;
  const m1 = extintas > u.M1.extincionesMax ? 'falla' : corridas.length > 0 && corridas.every(r => dia(r, u.M1.dia) || r.tope !== undefined) ? 'cumple' : 'desconocido';
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
    if (![final.pasoP95Ms, final.pasoMaxMs, r.maxRssMiB, r.ramBytes].every(Number.isFinite)) return 'desconocido';
    if ((u.M6.presupuestoMs !== null && final.pasoP95Ms > u.M6.presupuestoMs) || final.pasoMaxMs > u.M6.pasoMaxMs
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

/** Estado de una corrida de caché: `fallo` es la que se simula y luego se guarda; `sin-cache` dice por qué no se usó. */
interface MarcaCache { estado: 'acierto' | 'fallo' | 'sin-cache'; clave?: string; motivo?: string; origen?: string; diasOrigen?: number; prefijo?: boolean }
interface Trabajo {
  raiz: string; brazo: string; semilla: number; replica: number; dias: number; salida: string;
  regimen: 'abierto' | 'defecto'; hilos: number; gpu: number[]; cadaTicks: number; params?: string; topeMortales?: number;
  /** Guardar el mundo al final de este día en `guardarEn`, y/o arrancar desde un punto guardado allí. */
  guardarDia?: number; guardarEn?: string; desde?: string;
  /** Internos del panel: no salen en la fila de inicio salvo `cache`, que sale al final. */
  cache?: MarcaCache; paramsHash?: string; picos?: string;
}
interface Opciones {
  semillas: number[]; replicas: number; dias: number; paralelo: number; salida: string; brazos: string[];
  regimen: Trabajo['regimen']; hilos: number; gpu: number[]; cadaTicks: number; config?: string; params?: string; topeMortales?: number;
  cache?: string; guardarDia?: number; guardarEn?: string; desde?: string;
}
const importar = (raiz: string, ruta: string) => import(pathToFileURL(join(raiz, 'src', ruta)).href);
const escribir = (ruta: string, valor: unknown) => appendFileSync(ruta, `${JSON.stringify(valor)}\n`);
const sha = (contenido: string | Buffer) => createHash('sha256').update(contenido).digest('hex');
const ordenar = ([a]: [string, unknown], [b]: [string, unknown]) => a < b ? -1 : a > b ? 1 : 0;
/** JSON con las claves ordenadas: la misma estructura da siempre los mismos bytes, sea cual sea el orden de construcción. */
const estable = (valor: unknown): string => JSON.stringify(valor, (_clave, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(ordenar)) : v);

interface MedioInicio { carga: number[]; ramBytes: number; invariantesDisponibles: boolean; limitaciones: string[] }
/** La fila de inicio de una corrida: la misma la escribe el proceso que simula y el que sirve desde caché. */
function filaInicio(trabajo: Trabajo, params: WorldParams, medio: MedioInicio, extra: Record<string, unknown> = {}): Record<string, unknown> {
  // Pasar por JSON deja el trabajo como lo ve el proceso hijo: sin los campos indefinidos y en el mismo orden.
  const { cache, paramsHash: _hash, picos: _picos, ...base } = JSON.parse(JSON.stringify(trabajo)) as Trabajo;
  return { tipo: 'inicio', ...base, params, ...medio, ...(cache ? { cache } : {}), ...extra };
}

/** Los parámetros con que corre un trabajo: régimen, archivo `--params` y motor de un solo hilo, sobre `base` si se parte de un punto guardado. */
async function resolverParams(t: Pick<Trabajo, 'raiz' | 'regimen' | 'params' | 'hilos' | 'gpu'>, base?: WorldParams): Promise<WorldParams> {
  const { parseParams, DEFAULT_PARAMS } = await importar(t.raiz, 'world/params.ts') as typeof import('../../src/world/params.js');
  let params: WorldParams = base ?? DEFAULT_PARAMS;
  if (!base && t.regimen === 'abierto') {
    const { hostOpenWorldParams } = await importar(t.raiz, 'server/hardware-limits.ts') as typeof import('../../src/server/hardware-limits.js');
    params = hostOpenWorldParams();
  }
  if (t.params) params = parseParams(JSON.parse(readFileSync(t.params, 'utf8')), params);
  return parseParams({ motor: { ...params.motor, hilos: t.hilos, gpu: t.gpu } }, params);
}

const arbolGit = (raiz: string): { arbol: string; sucio: boolean } | null => {
  const git = (...args: string[]) => execFileSync('git', ['-C', raiz, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  // `git status` no ve los cambios de un fichero marcado skip-worktree o assume-unchanged (`ls-files -v`: S o letra minúscula):
  // con esa marca el árbol de trabajo puede no ser el del commit, así que cuenta como sucio.
  try {
    return { arbol: git('rev-parse', 'HEAD^{tree}'),
      sucio: git('status', '--porcelain', '--untracked-files=normal') !== '' || /^(?:[a-z]|S) /m.test(git('ls-files', '-v')) };
  } catch { return null; }
};

// ---- Caché de corridas: con un hilo y semilla el mismo árbol, parámetros y semilla dan el mismo censo, así que se guarda y se reutiliza.
const FORMATO_CACHE = 1;
const ESTADOS_FIN = ['completo', 'tope', 'extinta'];
const ENTRADA = /^(\d+)-(completo|tope|extinta)(?:-(\d+))?\.jsonl$/;

type ContextoCache = { usable: true; arbol: string; params: WorldParams; paramsHash: string } | { usable: false; motivo: string };
async function contextoCache(o: Opciones, raiz: string): Promise<ContextoCache> {
  if (o.desde || o.guardarDia !== undefined) return { usable: false, motivo: 'la corrida parte de un punto guardado o lo guarda' };
  if (o.hilos !== 1 || o.gpu.length) return { usable: false, motivo: 'el motor con más de un hilo o con GPU no es reproducible' };
  const git = arbolGit(raiz);
  if (!git) return { usable: false, motivo: 'la raíz no es un repositorio git' };
  if (git.sucio) return { usable: false, motivo: 'la raíz tiene cambios sin commitear' };
  try {
    const params = await resolverParams({ raiz, regimen: o.regimen, params: o.params, hilos: o.hilos, gpu: o.gpu });
    return { usable: true, arbol: git.arbol, params, paramsHash: sha(estable(params)) };
  } catch (error) { return { usable: false, motivo: `no se pudieron resolver los parámetros: ${String(error)}` }; }
}

const PANEL_HASH = sha(readFileSync(fileURLToPath(import.meta.url)));
/** Todo lo que decide el censo de una corrida salvo los días: el horizonte no cambia lo ya simulado. */
function componentesClave(c: Extract<ContextoCache, { usable: true }>, o: Opciones, semilla: number) {
  return { formato: FORMATO_CACHE, arbol: c.arbol, panel: PANEL_HASH, node: process.version, regimen: o.regimen, params: c.paramsHash, semilla, topeMortales: o.topeMortales ?? null, cadaTicks: o.cadaTicks };
}

/** Copia a `trabajo.salida` lo que una corrida terminada con esta clave ya simuló, o `null` si no hay entrada que sirva.
 * Una entrada completa a H días sirve a cualquier horizonte ≤ H (los primeros días son los mismos); una detenida por tope o
 * extinción sirve a cualquier horizonte, porque la parada ocurre el mismo día con los mismos parámetros. */
function servirDeCache(dir: string, clave: string, trabajo: Trabajo, params: WorldParams): MarcaCache | null {
  const carpeta = join(dir, clave);
  let nombres: string[];
  try { nombres = readdirSync(carpeta); } catch { return null; }
  const candidatas = nombres.flatMap(nombre => {
    const m = ENTRADA.exec(nombre);
    if (!m || (m[2] === 'completo' && Number(m[1]) < trabajo.dias)) return [];
    return [{ nombre, alcance: m[3] !== undefined ? Number(m[3]) : Number(m[1]) }];
  }).sort((a, b) => a.alcance - b.alcance || (a.nombre < b.nombre ? -1 : 1));
  for (const { nombre } of candidatas) {
    try {
      const lineas = readFileSync(join(carpeta, nombre), 'utf8').split('\n').filter(Boolean);
      const cabecera = JSON.parse(lineas[0]!), filas = lineas.slice(1), fin = JSON.parse(filas.at(-1) ?? 'null');
      if (cabecera.tipo !== 'cache' || cabecera.formato !== FORMATO_CACHE || cabecera.clave !== clave || fin?.tipo !== 'fin' || fin.estado !== cabecera.estado) continue;
      const entera = cabecera.estado === 'completo' ? trabajo.dias === cabecera.dias : trabajo.dias >= cabecera.parada;
      let cuerpo = filas;
      if (!entera) {
        const corte = filas.findIndex(f => { const fila = JSON.parse(f); return fila.tipo === 'censo' && fila.dia === trabajo.dias; });
        if (corte < 0) continue;
        cuerpo = [...filas.slice(0, corte + 1), JSON.stringify({ tipo: 'fin', estado: 'completo', maxRssMiB: cabecera.picos?.[trabajo.dias] ?? fin.maxRssMiB })];
      }
      const marca: MarcaCache = { estado: 'acierto', clave, origen: nombre, diasOrigen: cabecera.dias, prefijo: !entera };
      const etiquetadas = cuerpo.map(f => {
        const fila = JSON.parse(f);
        if ((fila.tipo !== 'censo' && fila.tipo !== 'violacion') || (fila.brazo === trabajo.brazo && fila.replica === trabajo.replica)) return f;
        return JSON.stringify({ ...fila, brazo: trabajo.brazo, replica: trabajo.replica });
      });
      writeFileSync(trabajo.salida, [JSON.stringify(filaInicio({ ...trabajo, cache: marca }, params, cabecera.medio)), ...etiquetadas].join('\n') + '\n');
      return marca;
    } catch { /* una entrada ilegible no es un acierto: se prueba la siguiente o se simula */ }
  }
  return null;
}

/** Guarda la corrida terminada en `trabajo.salida`. Atómico: se escribe a un temporal y se enlaza al nombre final, que solo lo toma
 * el primero; otro proceso con la misma clave a la vez deja una sola entrada válida. Una corrida con error o interrumpida no entra. */
function guardarEnCache(dir: string, clave: string, componentes: object, trabajo: Trabajo): void {
  const lineas = readFileSync(trabajo.salida, 'utf8').split('\n').filter(Boolean);
  const inicio = JSON.parse(lineas[0] ?? 'null'), fin = JSON.parse(lineas.at(-1) ?? 'null');
  if (inicio?.tipo !== 'inicio' || fin?.tipo !== 'fin' || !ESTADOS_FIN.includes(fin.estado) || lineas.some(l => l.startsWith('{"tipo":"proceso-error"'))) return;
  let picos: number[] = [];
  try { picos = JSON.parse(readFileSync(trabajo.picos!, 'utf8')); } catch { /* sin picos por día: un prefijo usará el máximo de la corrida entera */ }
  const medio: MedioInicio = { carga: inicio.carga, ramBytes: inicio.ramBytes, invariantesDisponibles: inicio.invariantesDisponibles, limitaciones: inicio.limitaciones };
  const parada = fin.estado === 'completo' ? undefined : fin.dia as number;
  const cabecera = { tipo: 'cache', formato: FORMATO_CACHE, clave, estado: fin.estado, dias: trabajo.dias, ...(parada !== undefined ? { parada } : {}), medio, picos, componentes };
  const carpeta = join(dir, clave);
  mkdirSync(carpeta, { recursive: true });
  const temporal = join(carpeta, `.tmp-${process.pid}-${randomUUID()}`), destino = join(carpeta, `${trabajo.dias}-${fin.estado}${parada !== undefined ? `-${parada}` : ''}.jsonl`);
  try {
    writeFileSync(temporal, [JSON.stringify(cabecera), ...lineas.slice(1)].join('\n') + '\n');
    try { linkSync(temporal, destino); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      renameSync(temporal, destino);
    }
  } finally { rmSync(temporal, { force: true }); }
}

// ---- Punto guardado: el mundo al final de un día, para seguir desde ahí con otros parámetros.
const FORMATO_PUNTO = 1;
interface PuntoGuardado {
  formato: number; semilla: number; dia: number; tick: number; version: number; origen: { raiz: string; brazo: string; arbol: string | null };
  params: WorldParams; mundo: World; archivo: Map<string, Buffer>; fundadores: string[];
  duras: number; blandas: number; comprobacionesRegion: number; pasoMaxMs: number; tiempos: number[]; picos: number[];
  /** Las filas de la corrida de origen hasta este día (censos y violaciones), para que la bifurcada se evalúe entera. */
  filas: string[];
}
const rutaPunto = (carpeta: string, semilla: number, replica: number) => join(carpeta, `${semilla}-${replica}.punto`);

async function replica(trabajo: Trabajo): Promise<void> {
  process.title = 'carta-isa';
  const mundoModulo: typeof import('../../src/world/index.js') = await importar(trabajo.raiz, 'world/index.ts');
  const { createWorld, stepWorld, TICKS_PER_DAY, RULES_VERSION } = mundoModulo;
  const { setParams } = await importar(trabajo.raiz, 'world/params.ts') as typeof import('../../src/world/params.js');
  const { indiceDiversidad } = await importar(trabajo.raiz, 'world/diversidad.ts') as typeof import('../../src/world/diversidad.js');
  const rutaInvariantes = join(trabajo.raiz, 'src/world/invariantes.ts');
  const invariantes = existsSync(rutaInvariantes) ? await import(pathToFileURL(rutaInvariantes).href) as {
    comprobarInvariantes: (mundo: World) => Violacion[]; crearComprobador?: () => (mundo: World) => Violacion[];
  } : undefined;
  const comprobarInvariantes = invariantes?.crearComprobador?.() ?? invariantes?.comprobarInvariantes;
  if (TICKS_PER_DAY !== TICKS_POR_DIA) throw new Error(`El brazo usa ${TICKS_PER_DAY} ticks/día; se esperaban ${TICKS_POR_DIA}`);
  let punto: PuntoGuardado | undefined;
  if (trabajo.desde) {
    const ruta = rutaPunto(trabajo.desde, trabajo.semilla, trabajo.replica);
    if (!existsSync(ruta)) throw new Error(`No hay punto guardado: ${ruta}`);
    punto = deserialize(readFileSync(ruta)) as PuntoGuardado;
    if (punto.formato !== FORMATO_PUNTO || punto.semilla !== trabajo.semilla) throw new Error(`El punto ${ruta} no es de esta semilla o de este formato`);
    if (punto.version !== RULES_VERSION) throw new Error(`El punto guarda reglas v${punto.version} y el árbol corre v${RULES_VERSION}: no se migra`);
    if (punto.dia >= trabajo.dias) throw new Error(`El punto está en el día ${punto.dia}: --dias debe ser mayor`);
  }
  const params = await resolverParams(trabajo, punto?.params);
  if (trabajo.paramsHash && sha(estable(params)) !== trabajo.paramsHash) throw new Error('Los parámetros resueltos en el proceso no coinciden con los de la clave de caché');
  // Sin almacén, el territorio que se retira se quedaría en memoria como objetos durante toda la corrida (≈ 25 MB por
  // día simulado). Se archiva serializado cada día, como hace el Store al guardar, y `loadChunk` lo devuelve al volver.
  const { bindWorldContext } = await importar(trabajo.raiz, 'world/spatial.ts') as typeof import('../../src/world/spatial.js');
  const archivo = new Map<string, Buffer>(punto?.archivo);
  let mundo: World, fundadores: Set<string>;
  if (punto) {
    mundo = punto.mundo; fundadores = new Set(punto.fundadores);
    setParams(mundo, params);
  } else {
    mundo = createWorld(trabajo.semilla, params);
    fundadores = new Set(mundo.people.filter(p => p.role === 'neighbor').map(p => p.id));
  }
  bindWorldContext(mundo, { loadChunk: clave => { const guardado = archivo.get(clave); return guardado ? deserialize(guardado) as Chunk : null; } });
  if (punto) mundoModulo.assertWorld(mundo, RULES_VERSION);
  const archivar = () => {
    const vistos = new Set<string>();
    for (const chunk of mundo.retiredChunks) if (!vistos.has(chunk.key)) { vistos.add(chunk.key); archivo.set(chunk.key, serialize(chunk)); }
    mundo.retiredChunks = [];
  };
  const tiempos = punto?.tiempos ?? [], picos = punto ? [...punto.picos] : [];
  let duras = punto?.duras ?? 0, blandas = punto?.blandas ?? 0, comprobacionesRegion = punto?.comprobacionesRegion ?? 0, pasoMaxMs = punto?.pasoMaxMs ?? 0;
  let inicioDia = performance.now(), tickDesde = mundo.tick;
  const revisar = () => {
    if (!comprobarInvariantes) return;
    const violaciones = comprobarInvariantes(mundo);
    duras += violaciones.filter(v => v.gravedad === 'dura').length;
    blandas += violaciones.filter(v => v.gravedad === 'blanda').length;
    const regiones = new Set(mundo.tiles.map(t => `${Math.floor(t.x / 16)},${Math.floor(t.y / 16)}`));
    comprobacionesRegion += Math.max(1, regiones.size);
    for (const violacion of violaciones) escribir(trabajo.salida, { tipo: 'violacion', brazo: trabajo.brazo, semilla: trabajo.semilla, replica: trabajo.replica, violacion });
  };
  const censo = (dia: number): CensoPanel => {
    const ahora = performance.now(), ordenados = [...tiempos].sort((a, b) => a - b), memoria = process.memoryUsage();
    const fila: CensoPanel = {
      tipo: 'censo', brazo: trabajo.brazo, semilla: trabajo.semilla, replica: trabajo.replica, dia, tick: mundo.tick,
      mortales: mundo.people.filter(p => p.role === 'neighbor').length, nacimientos: mundo.totals.births ?? 0,
      muertes: mundo.demographyDynamics.deaths, causas: { ...mundo.demographyDynamics.causes },
      fundadoresMortalesVivos: mundo.people.filter(p => fundadores.has(p.id)).length,
      comunidades: mundo.communities.length, estructuras: mundo.structures.length, fauna: mundo.animals.length,
      biomasaMedia: mundo.tiles.reduce((s, t) => s + t.vegetation, 0) / Math.max(1, mundo.tiles.length), diversidad: indiceDiversidad(mundo).total,
      duras, blandas, comprobacionesRegion, ticksPorSegundo: (mundo.tick - tickDesde) * 1000 / Math.max(1e-9, ahora - inicioDia),
      pasoP95Ms: ordenados.length ? ordenados[Math.min(ordenados.length - 1, Math.ceil(ordenados.length * 0.95) - 1)]! : 0,
      pasoMaxMs, rssMiB: memoria.rss / 1048576,
    };
    escribir(trabajo.salida, fila); inicioDia = ahora; tickDesde = mundo.tick; picos[dia] = process.resourceUsage().maxRSS / 1024;
    return fila;
  };
  const guardarPunto = (dia: number) => {
    const destino = rutaPunto(trabajo.guardarEn!, trabajo.semilla, trabajo.replica), temporal = `${destino}.${process.pid}.tmp`;
    const contenido: PuntoGuardado = { formato: FORMATO_PUNTO, semilla: trabajo.semilla, dia, tick: mundo.tick, version: mundo.version, origen: { raiz: trabajo.raiz, brazo: trabajo.brazo, arbol: arbolGit(trabajo.raiz)?.arbol ?? null },
      params, mundo, archivo, fundadores: [...fundadores], duras, blandas, comprobacionesRegion, pasoMaxMs, tiempos, picos,
      filas: readFileSync(trabajo.salida, 'utf8').split('\n').filter(Boolean).slice(1) };
    mkdirSync(trabajo.guardarEn!, { recursive: true });
    writeFileSync(temporal, serialize(contenido)); renameSync(temporal, destino);
  };
  const medio: MedioInicio = { carga: loadavg(), ramBytes: totalmem(), invariantesDisponibles: !!comprobarInvariantes, limitaciones: ['En memoria sin servidor ni BD: el catálogo tecnológico standalone puede divergir de producción', 'RSS y tiempos por proceso; no incluyen consumo de otros trabajos', ...(!comprobarInvariantes ? ['Este brazo no integra invariantes.ts: M5 desconocida'] : [])] };
  const origenPunto = punto ? { bifurcacion: { punto: rutaPunto(trabajo.desde!, trabajo.semilla, trabajo.replica), dia: punto.dia, tick: punto.tick, origen: punto.origen } } : {};
  escribir(trabajo.salida, filaInicio(trabajo, params, medio, origenPunto));
  let primerDia = 1;
  if (punto) {
    // Las filas de origen se heredan con las etiquetas de este brazo; el comprobador de invariantes lleva el estado del paso anterior,
    // que no viaja en el punto: se vuelve a cebar con el mundo tal como estaba cuando se guardó.
    for (const f of punto.filas) {
      const fila = JSON.parse(f);
      escribir(trabajo.salida, fila.tipo === 'censo' || fila.tipo === 'violacion' ? { ...fila, brazo: trabajo.brazo, replica: trabajo.replica } : fila);
    }
    comprobarInvariantes?.(mundo);
    inicioDia = performance.now(); primerDia = punto.dia + 1;
  } else { revisar(); censo(0); }
  const terminar = (fin: Record<string, unknown>) => {
    if (trabajo.picos) writeFileSync(trabajo.picos, JSON.stringify(picos));
    escribir(trabajo.salida, { tipo: 'fin', ...fin, maxRssMiB: process.resourceUsage().maxRSS / 1024 });
  };
  try {
    for (let dia = primerDia; dia <= trabajo.dias; dia++) {
      for (let t = 0; t < TICKS_POR_DIA; t++) {
        const inicioPaso = performance.now(); stepWorld(mundo);
        const ms = performance.now() - inicioPaso; tiempos.push(ms); pasoMaxMs = Math.max(pasoMaxMs, ms);
        if (mundo.tick % trabajo.cadaTicks === 0) revisar();
      }
      if (mundo.tick % trabajo.cadaTicks !== 0) revisar();
      const { mortales } = censo(dia); archivar();
      if (trabajo.guardarDia === dia) guardarPunto(dia);
      // Sin mortales no hay nada más que medir: el mundo vacío ya no se simula hasta el horizonte.
      if (mortales === 0) { terminar({ estado: 'extinta', dia }); return; }
      // Con un solo hilo, un mundo de cientos de habitantes no llega al horizonte en un tiempo razonable: se detiene
      // aquí y cuenta como vivo; lo que pase después queda desconocido, no supuesto.
      if (trabajo.topeMortales && mortales >= trabajo.topeMortales) { terminar({ estado: 'tope', dia }); return; }
    }
    terminar({ estado: 'completo' });
  } catch (error) {
    escribir(trabajo.salida, { tipo: 'fin', estado: 'error', error: String(error), maxRssMiB: process.resourceUsage().maxRSS / 1024 });
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
    salida: `/tmp/atlas-v23-0c/panel-${Date.now()}`, brazos: [process.cwd()], regimen: 'abierto', hilos: 1, gpu: [], cadaTicks: 120,
    cache: process.env.CARTA_PANEL_CACHE || undefined };
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
      case '--tope-mortales': o.topeMortales = numero(valor, bandera); break;
      case '--params': o.params = resolve(valor); break;
      case '--cache': o.cache = valor === 'sin' ? undefined : resolve(valor); break;
      case '--guardar-dia': o.guardarDia = numero(valor, bandera); break;
      case '--guardar-en': o.guardarEn = resolve(valor); break;
      case '--desde': o.desde = resolve(valor); break;
      default: throw new Error(`Opción desconocida: ${bandera}`);
    }
  }
  if (o.cache) o.cache = resolve(o.cache);
  if (!o.semillas.length || new Set(o.semillas).size !== o.semillas.length) throw new Error('Semillas vacías o repetidas');
  if (o.brazos.length < 1 || o.brazos.length > 2 || new Set(o.brazos).size !== o.brazos.length) throw new Error('Se requieren uno o dos brazos distintos');
  if ((o.guardarDia === undefined) !== (o.guardarEn === undefined)) throw new Error('--guardar-dia y --guardar-en van juntos');
  if (o.guardarDia !== undefined && o.guardarDia > o.dias) throw new Error('--guardar-dia no puede pasar de --dias');
  if (o.guardarEn && o.brazos.length > 1) throw new Error('Guardar el punto requiere un solo brazo: el fichero se nombra por semilla y réplica');
  if ((o.guardarEn || o.desde) && o.hilos !== 1) throw new Error('Guardar o arrancar desde un punto requiere --hilos 1: con más hilos el mundo no es reproducible');
  return o;
}

function leerCorrida(trabajo: Trabajo): CorridaPanel {
  const filas = readFileSync(trabajo.salida, 'utf8').trim().split('\n').filter(Boolean).map(f => JSON.parse(f));
  const inicio = filas.find(f => f.tipo === 'inicio'), fin = filas.filter(f => f.tipo === 'fin').at(-1), falloProceso = filas.find(f => f.tipo === 'proceso-error');
  const terminada = fin?.estado === 'completo' || fin?.estado === 'tope' || fin?.estado === 'extinta';
  return { brazo: trabajo.brazo, semilla: trabajo.semilla, replica: trabajo.replica, censos: filas.filter(f => f.tipo === 'censo'),
    estado: terminada ? 'completo' : 'error', tope: fin?.estado === 'tope' ? fin.dia : undefined, extinta: fin?.estado === 'extinta' ? fin.dia : undefined,
    error: fin?.error ?? falloProceso?.error ?? (!fin ? 'El proceso terminó sin fila fin' : undefined),
    ramBytes: inicio?.ramBytes ?? totalmem(), maxRssMiB: fin?.maxRssMiB ?? Infinity };
}

/** Valor de una métrica en el horizonte. Una corrida extinta antes de él deja `mortales` y `nacimientos` congelados en cero nuevos;
 * biomasa y diversidad siguen cambiando sin habitantes y no se extrapolan. */
function valorEnHorizonte(r: CorridaPanel, dias: number, metrica: 'mortales' | 'nacimientos' | 'biomasaMedia' | 'diversidad'): number | undefined {
  const censo = r.censos.find(c => c.dia === dias);
  if (censo) return censo[metrica];
  return r.extinta !== undefined && (metrica === 'mortales' || metrica === 'nacimientos') ? r.censos.at(-1)?.[metrica] : undefined;
}

async function panel(o: Opciones): Promise<void> {
  const umbrales = configurarPanel(o.config ? JSON.parse(readFileSync(o.config, 'utf8')) : undefined);
  mkdirSync(o.salida, { recursive: true });
  const trabajos: Trabajo[] = [];
  for (const semilla of o.semillas) for (let replica = 1; replica <= o.replicas; replica++) for (const [indice, raiz] of o.brazos.entries()) {
    const brazo = `${indice + 1}-${basename(raiz)}`;
    const salida = join(o.salida, `${brazo}-${semilla}-${replica}.jsonl`);
    if (existsSync(salida)) throw new Error(`La salida ya existe: ${salida}`);
    trabajos.push({ raiz, brazo, semilla, replica, dias: o.dias, salida, regimen: o.regimen, hilos: o.hilos, gpu: o.gpu, cadaTicks: o.cadaTicks, params: o.params, topeMortales: o.topeMortales,
      guardarDia: o.guardarDia, guardarEn: o.guardarEn, desde: o.desde });
  }
  writeFileSync(join(o.salida, 'config.json'), JSON.stringify({ ...o, umbrales, carga: loadavg(), ramBytes: totalmem() }, null, 2));
  mkdirSync('/tmp/atlas-v23-0c', { recursive: true });
  const temporal = mkdtempSync('/tmp/atlas-v23-0c/panel-bin-'), ejecutable = join(temporal, 'carta-isa');
  symlinkSync(realpathSync(process.execPath), ejecutable);

  // Con caché, una réplica idéntica de otra (mismo brazo, semilla y clave) espera a que termine la primera y se sirve de su entrada:
  // con un hilo y semilla simular las tres sería repetir la misma corrida.
  const resumenCache = { directorio: o.cache ?? null, aciertos: 0, fallos: 0, sinCache: 0 };
  const claves = new Map<Trabajo, { clave: string; componentes: object; contexto: Extract<ContextoCache, { usable: true }> }>();
  const primeros = new Map<string, Promise<void>>(), liberar = new Map<string, () => void>(), repetidos = new Set<Trabajo>();
  if (o.cache) {
    const contextos = new Map<string, ContextoCache>();
    for (const raiz of o.brazos) contextos.set(raiz, await contextoCache(o, raiz));
    for (const trabajo of trabajos) {
      const contexto = contextos.get(trabajo.raiz)!;
      if (!contexto.usable) { trabajo.cache = { estado: 'sin-cache', motivo: contexto.motivo }; resumenCache.sinCache++; continue; }
      const componentes = componentesClave(contexto, o, trabajo.semilla), clave = sha(estable(componentes));
      trabajo.cache = { estado: 'fallo', clave }; trabajo.paramsHash = contexto.paramsHash;
      trabajo.picos = join(temporal, `${basename(trabajo.salida)}.picos`);
      claves.set(trabajo, { clave, componentes, contexto });
      if (primeros.has(clave)) repetidos.add(trabajo);
      else primeros.set(clave, new Promise<void>(cumplir => liberar.set(clave, cumplir)));
    }
  }
  const cola = [...trabajos.filter(t => !repetidos.has(t)), ...trabajos.filter(t => repetidos.has(t))];

  const activos = new Set<ReturnType<typeof spawn>>();
  let cancelado = false;
  const detener = () => { cancelado = true; for (const hijo of activos) hijo.kill('SIGTERM'); };
  process.once('SIGTERM', detener); process.once('SIGINT', detener);
  const simular = (trabajo: Trabajo) => new Promise<number | null>((cumplir) => {
    const hijo = spawn(ejecutable, ['--import', import.meta.resolve('tsx'), fileURLToPath(import.meta.url), '--worker', JSON.stringify(trabajo)], { cwd: trabajo.raiz, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CARTA_DATA_DIR: temporal } });
    activos.add(hijo);
    let error = '';
    hijo.stderr?.on('data', b => { error = (error + String(b)).slice(-8192); });
    hijo.once('error', e => { escribir(trabajo.salida, { tipo: 'fin', estado: 'error', error: String(e) }); });
    hijo.once('close', codigo => {
      activos.delete(hijo);
      if (codigo !== 0) escribir(trabajo.salida, { tipo: 'proceso-error', codigo, error });
      cumplir(codigo);
    });
  });
  // La clave lleva el árbol del brazo al arrancar el panel, pero cada proceso carga el código al empezar su corrida: si entretanto
  // el brazo recibió un commit o cambios sin commitear, lo simulado ya no es de ese árbol y no puede guardarse bajo esa clave.
  const arbolIntacto = (trabajo: Trabajo, arbol: string) => { const git = arbolGit(trabajo.raiz); return !!git && !git.sucio && git.arbol === arbol; };
  const CAMBIO_ARBOL = 'el árbol del brazo cambió después de calcular la clave';
  const correr = async (trabajo: Trabajo) => {
    const registro = claves.get(trabajo);
    writeFileSync(trabajo.salida, '');
    let guardable = !!registro;
    if (registro) {
      if (repetidos.has(trabajo)) await primeros.get(registro.clave);
      if (cancelado) return;
      if (servirDeCache(o.cache!, registro.clave, trabajo, registro.contexto.params)) { resumenCache.aciertos++; return; }
      if (!arbolIntacto(trabajo, registro.contexto.arbol)) {
        guardable = false; trabajo.cache = { estado: 'sin-cache', motivo: CAMBIO_ARBOL }; trabajo.paramsHash = undefined; resumenCache.sinCache++;
      }
    }
    const codigo = await simular(trabajo);
    if (!registro || !guardable) return;
    resumenCache.fallos++;
    if (codigo !== 0) return;
    if (!arbolIntacto(trabajo, registro.contexto.arbol)) { process.stderr.write(`No se guarda en caché ${trabajo.salida}: ${CAMBIO_ARBOL} durante la corrida\n`); return; }
    try { guardarEnCache(o.cache!, registro.clave, registro.componentes, trabajo); } catch (error) { process.stderr.write(`No se pudo guardar en caché ${trabajo.salida}: ${String(error)}\n`); }
  };
  let cursor = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(o.paralelo, trabajos.length) }, async () => {
      while (!cancelado && cursor < cola.length) {
        const trabajo = cola[cursor++]!, registro = claves.get(trabajo);
        try { await correr(trabajo); } finally { if (registro && !repetidos.has(trabajo)) liberar.get(registro.clave)!(); }
      }
    }));
  } finally {
    detener(); process.removeListener('SIGTERM', detener); process.removeListener('SIGINT', detener); rmSync(temporal, { recursive: true, force: true });
  }
  const corridas = trabajos.map(trabajo => existsSync(trabajo.salida) ? leerCorrida(trabajo) : { brazo: trabajo.brazo, semilla: trabajo.semilla, replica: trabajo.replica, censos: [], estado: 'error' as const, error: 'Cancelada antes del arranque', ramBytes: totalmem(), maxRssMiB: Infinity });
  const brazos = Object.fromEntries([...new Set(corridas.map(r => r.brazo))].map(brazo => [brazo, evaluarPanel(corridas.filter(r => r.brazo === brazo), umbrales)]));
  const comparacion: Record<string, unknown> = {};
  if (o.brazos.length === 2) {
    const nombres = Object.keys(brazos), hayExtintas = corridas.some(r => r.extinta !== undefined && r.extinta < o.dias);
    for (const metrica of ['mortales', 'nacimientos', 'biomasaMedia', 'diversidad'] as const) {
      const grupos = nombres.map(brazo => o.semillas.map(semilla => ({ semilla, valores: corridas.filter(r => r.brazo === brazo && r.semilla === semilla && r.estado === 'completo').flatMap(r => { const final = valorEnHorizonte(r, o.dias, metrica); return final === undefined ? [] : [final]; }) })));
      comparacion[metrica] = grupos.some(gs => gs.some(g => g.valores.length !== o.replicas))
        ? { estado: 'desconocido', motivo: hayExtintas ? 'Faltan réplicas completas o una corrida extinta antes del horizonte no deja biomasa ni diversidad que comparar' : 'Faltan réplicas completas' }
        : permutacionEstratificada(grupos[0]!, grupos[1]!);
    }
  }
  // Una semilla cuyas réplicas completas dan el mismo censo biológico aporta una sola observación independiente.
  const huella = (r: CorridaPanel) => JSON.stringify(r.censos.map(({ replica, ticksPorSegundo, pasoP95Ms, pasoMaxMs, rssMiB, ...biologia }) => biologia));
  const pseudorreplicas = [...new Set(corridas.map(r => `${r.brazo}/${r.semilla}`))].filter(clave => {
    const huellas = corridas.filter(r => `${r.brazo}/${r.semilla}` === clave && r.estado === 'completo').map(huella);
    return huellas.length > 1 && new Set(huellas).size === 1;
  });
  const informe = { brazos, comparacion, pseudorreplicas, ...(o.cache ? { cache: resumenCache } : {}), corridas, umbrales, limitaciones: ['M1 es informativa hasta integrar 0H', 'Un panel corto deja desconocidas las métricas cuyo horizonte no alcanza', 'Réplicas idénticas dentro de una semilla (pseudorreplicas) cuentan como una en la permutación, pero no en las proporciones M1-M6', 'Permutación: diferencia de medias estratificada; no equivale a demostrar equivalencia', 'Sin servidor ni BD: no mide la persistencia ni el catálogo tecnológico de producción'] };
  writeFileSync(join(o.salida, 'panel.json'), JSON.stringify(informe, null, 2));
  process.stdout.write(`${JSON.stringify({ salida: o.salida, brazos, comparacion, pseudorreplicas, ...(o.cache ? { cache: resumenCache } : {}) })}\n`);
  if (corridas.some(r => r.estado === 'error')) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    process.stdout.write('tsx scripts/lab/panel.ts [--semillas 51926,19104,19101,19103] [--replicas 3] [--dias 30] [--paralelo 4] [--regimen abierto|defecto] [--hilos 1] [--gpu sin] [--cada-ticks 120] [--config umbrales.json] [--params params.json] [--tope-mortales N] [--brazo directorio (hasta dos)] [--salida directorio] [--cache directorio|sin (por defecto $CARTA_PANEL_CACHE)] [--guardar-dia N --guardar-en directorio] [--desde directorio]\n');
  } else if (process.argv[2] === '--worker') {
    replica(JSON.parse(process.argv[3]!)).then(() => process.exit(0)).catch(error => { process.stderr.write(`${String(error)}\n`); process.exit(1); });
  } else {
    Promise.resolve().then(() => panel(argumentos(process.argv.slice(2)))).catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
  }
}
