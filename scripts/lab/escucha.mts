/**
 * Laboratorio W1 — la escucha heredable (docs/v23/leyes-opus.md, «Mensajes divinos según el carácter»).
 *
 * Mide, en mundos sembrados, dos cosas con sus intervalos:
 *  1. Latencia entre dejar un mensaje a una persona y que lo oiga, frente a su gen de escucha: correlación de Spearman
 *     (criterio: menor que cero, con p < 0,05). Un mensaje que nadie oye en `WHISPER_LIFETIME_TICKS` queda censurado por la
 *     derecha en ese plazo (empata en el valor más alto); también se informa la correlación solo entre los oídos.
 *  2. Herencia del gen: pendiente de la regresión lineal de la escucha del hijo sobre la media de la de sus padres, con los
 *     pares que el propio mundo produjo (criterio: dentro de [0,6; 1,1]).
 *
 * Uso:
 *   npx tsx scripts/lab/escucha.mts                                  todo: 12 semillas × 15 días, un proceso por semilla
 *   npx tsx scripts/lab/escucha.mts --semillas 4001,4002 --dias 15   otras semillas
 *   npx tsx scripts/lab/escucha.mts --semilla 4001 --dias 15 --salida f.json   una réplica (la que lanza cada proceso)
 *   npx tsx scripts/lab/escucha.mts --resumen <dir>                  agrega las réplicas ya corridas en <dir>
 * Opciones: --por-dia N (mensajes al día, 4), --procesos N (réplicas a la vez, 6), --salida <dir> (por defecto un
 * directorio nuevo bajo /tmp/atlas-v23-e/), --tope-mortales N (corta una réplica desbocada, 300), --params "a.b=1,…".
 * Un mundo por proceso y un hilo cada uno: la corrida es reproducible con la misma semilla (el modo de un hilo). Usa un
 * `CARTA_DATA_DIR` temporal; nunca toca `data/` ni los mundos del servidor público.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/server/store.js';
import { hostParams } from '../../src/server/hardware-limits.js';
import { assertWorld, createWorld, stepWorld, submitWhisper, TICKS_PER_DAY, type World } from '../../src/world/index.js';
import { escuchaDe, localRandom } from '../../src/world/genetics.js';
import { parseParams } from '../../src/world/params.js';
import { WHISPER_CHECK_TICKS, WHISPER_LIFETIME_TICKS } from '../../src/world/whispers.js';
import { technologyJournalNearCapacity } from '../../src/world/technology-journal.js';
import { chronicleJournalNearCapacity } from '../../src/world/chronicle-journal.js';
import { technologyCatalogueNearCapacity } from '../../src/world/technology-catalogue.js';

// ── Tipos de lo que escribe cada réplica ─────────────────────────────────────────────────────────────────────

export interface MensajeMedido {
  id: string; personaId: string; escucha: number; creado: number;
  /** Paso en que lo oyó, o null si no lo oyó. */
  oido: number | null;
  /** Entre los oídos: `cumplido` (llegó), `olvidado` o `en-camino` (su historia no acabó dentro de la corrida).
   * `sin-oir` si se desvaneció sin oírse en el plazo. Los que se perdieron por otra causa (murió el destinatario, destino
   * inalcanzable, cupo de mensajes) no se miden. */
  desenlace: 'cumplido' | 'olvidado' | 'en-camino' | 'sin-oir';
}
export interface ParMedido { hijo: string; escucha: number; padres: [string, string]; escuchaPadres: [number, number] }
export interface Replica {
  semilla: number; dias: number; porDia: number; poblacionFinal: number; mortalesFinal: number;
  tope: number | null; mensajes: MensajeMedido[]; perdidos: number; pares: ParMedido[]; fundadores: number[];
  segundos: number; carga: number;
}

// ── Estadística ──────────────────────────────────────────────────────────────────────────────────────────────

/** Rangos con empates promediados. */
export function rangos(x: readonly number[]): number[] {
  const orden = x.map((_, i) => i).sort((a, b) => x[a]! - x[b]!), r = new Array<number>(x.length);
  for (let i = 0; i < orden.length;) {
    let j = i;
    while (j + 1 < orden.length && x[orden[j + 1]!] === x[orden[i]!]) j++;
    const medio = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[orden[k]!] = medio;
    i = j + 1;
  }
  return r;
}
export function pearson(x: readonly number[], y: readonly number[]): number {
  const n = x.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]!; my += y[i]!; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[i]! - mx, b = y[i]! - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}
/** Spearman = Pearson de los rangos (con empates). */
export const spearman = (x: readonly number[], y: readonly number[]): number => pearson(rangos(x), rangos(y));
/** Pendiente y ordenada de la regresión de mínimos cuadrados de y sobre x. */
export function regresion(x: readonly number[], y: readonly number[]): { pendiente: number; ordenada: number; r: number } {
  const n = x.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]!; my += y[i]!; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i]! - mx) * (y[i]! - my); sxx += (x[i]! - mx) ** 2; }
  const pendiente = sxx === 0 ? 0 : sxy / sxx;
  return { pendiente, ordenada: my - pendiente * mx, r: pearson(x, y) };
}
export function generador(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function percentil(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (s.length - 1) * p, a = Math.floor(i), b = Math.ceil(i);
  return s[a]! + (s[b]! - s[a]!) * (i - a);
}
const mediana = (xs: readonly number[]) => percentil(xs, 0.5);
const media = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** p unilateral de «rho < 0» por permutación de la latencia entre los mensajes. */
export function pPermutacion(x: readonly number[], y: readonly number[], rho: number, permutaciones: number, azar: () => number): number {
  const rx = rangos(x), ry = [...rangos(y)];
  let menores = 0;
  for (let k = 0; k < permutaciones; k++) {
    for (let i = ry.length - 1; i > 0; i--) { const j = Math.floor(azar() * (i + 1)); [ry[i], ry[j]] = [ry[j]!, ry[i]!]; }
    if (pearson(rx, ry) <= rho) menores++;
  }
  return (menores + 1) / (permutaciones + 1);
}

/** Intervalo de percentiles 2,5–97,5 % por bootstrap de CÚMULOS: se remuestrean los grupos, no las filas, porque las filas
 * de un mismo grupo (varios mensajes a una persona; varios hijos de una pareja) no son independientes. */
export function bootstrapPorGrupo<T>(filas: readonly T[], grupo: (fila: T) => string, estadistico: (filas: readonly T[]) => number, veces: number, azar: () => number): [number, number] {
  const grupos = new Map<string, T[]>();
  for (const fila of filas) { const g = grupo(fila), lista = grupos.get(g); if (lista) lista.push(fila); else grupos.set(g, [fila]); }
  const lista = [...grupos.values()], valores: number[] = [];
  for (let k = 0; k < veces; k++) {
    const muestra: T[] = [];
    for (let i = 0; i < lista.length; i++) muestra.push(...lista[Math.floor(azar() * lista.length)]!);
    const v = estadistico(muestra);
    if (Number.isFinite(v)) valores.push(v);
  }
  return [percentil(valores, 0.025), percentil(valores, 0.975)];
}

// ── Una réplica ──────────────────────────────────────────────────────────────────────────────────────────────

const arg = (flag: string): string | undefined => {
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a === flag) return process.argv[i + 1];
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
};

function correrReplica(semilla: number, dias: number, porDia: number, topeMortales: number, parametros: string | undefined): Replica {
  const inicio = performance.now();
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-escucha-'));
  process.env.CARTA_DATA_DIR = dataDir;
  const store = new Store(join(dataDir, 'world.sqlite'));
  try {
    // Guardar en cada paso (el valor por defecto del servidor) multiplica el coste sin cambiar lo que se mide: el `Store` se
    // liga igual antes de simular y se guarda cada 240 pasos, o antes si se llenan los diarios.
    const params = parseParams(['motor.hilos=1', 'motor.gpu=[]', 'persistencia.cadaTicks=240', parametros].filter(Boolean).join(','), hostParams());
    const world: World = createWorld(semilla, params);
    store.save(world);
    const azar = localRandom(semilla, 'escucha-lab');
    const conocidos = new Map<string, { escucha: number; padres: string[] }>();
    const registrar = () => { for (const p of world.people) if (!conocidos.has(p.id)) conocidos.set(p.id, { escucha: escuchaDe(p.genome), padres: p.genome.parents }); };
    registrar();
    const fundadores = [...conocidos.values()].map(c => c.escucha);
    const escuchaDelDestinatario = new Map<string, number>();
    const vistos = new Map<string, { personaId: string; creado: number; oido: number | null; estado: string; resuelto: number | null }>();
    // Los mensajes se dejan hasta que el último tenga plazo de resolverse dentro de la corrida.
    const ultimoDiaConMensajes = dias - Math.ceil(WHISPER_LIFETIME_TICKS / TICKS_PER_DAY) - 1;
    let tope: number | null = null;
    const mirar = () => {
      for (const w of world.whispers ?? []) if (w.personId) vistos.set(w.id, { personaId: w.personId, creado: w.createdTick, oido: w.heardTick ?? null, estado: w.status, resuelto: w.resolvedTick ?? null });
    };
    const dejarMensajes = () => {
      const vivos = world.people.filter(p => p.role === 'neighbor');
      if (!vivos.length) return;
      for (let n = 0; n < porDia; n++) {
        if ((world.whispers ?? []).filter(w => w.status === 'latent' || w.status === 'heard').length >= 14) break;
        const persona = vivos[Math.floor(azar() * vivos.length)]!;
        for (let intento = 0; intento < 40; intento++) {
          const angulo = azar() * 2 * Math.PI, d = 10 + azar() * 30;
          try {
            const m = submitWhisper(world, { personId: persona.id, intent: 'travel', x: Math.round(persona.x + Math.cos(angulo) * d), y: Math.round(persona.y + Math.sin(angulo) * d), note: '' });
            escuchaDelDestinatario.set(m.id, escuchaDe(persona.genome));
            break;
          } catch { /* agua o fuera del mundo: otro sitio */ }
        }
      }
    };
    const total = dias * TICKS_PER_DAY, cada = params.persistencia.cadaTicks;
    for (let tick = 1; tick <= total; tick++) {
      if ((tick - 1) % TICKS_PER_DAY === 0 && (tick - 1) / TICKS_PER_DAY <= ultimoDiaConMensajes) dejarMensajes();
      stepWorld(world);
      if (tick % cada === 0 || technologyJournalNearCapacity(world.technology) || chronicleJournalNearCapacity(world) || technologyCatalogueNearCapacity(world.technology)) store.save(world);
      if (tick % WHISPER_CHECK_TICKS === 0) { registrar(); mirar(); }
      if (tick % TICKS_PER_DAY === 0) {
        assertWorld(world);
        if (world.people.filter(p => p.role === 'neighbor').length > topeMortales) { tope = tick / TICKS_PER_DAY; break; }
      }
    }
    mirar();

    const mensajes: MensajeMedido[] = [];
    let perdidos = 0;
    for (const [id, v] of vistos) {
      const escucha = escuchaDelDestinatario.get(id);
      if (escucha === undefined) continue;
      let desenlace: MensajeMedido['desenlace'];
      if (v.oido !== null) desenlace = v.estado === 'fulfilled' ? 'cumplido' : v.estado === 'faded' ? 'olvidado' : 'en-camino';
      else if (v.estado === 'faded' && v.resuelto !== null && v.resuelto - v.creado >= WHISPER_LIFETIME_TICKS) desenlace = 'sin-oir';
      else { perdidos++; continue; }
      mensajes.push({ id, personaId: v.personaId, escucha, creado: v.creado, oido: v.oido, desenlace });
    }
    const pares: ParMedido[] = [];
    for (const [id, c] of conocidos) {
      if (c.padres.length !== 2) continue;
      const a = conocidos.get(c.padres[0]!), b = conocidos.get(c.padres[1]!);
      if (a && b) pares.push({ hijo: id, escucha: c.escucha, padres: [c.padres[0]!, c.padres[1]!], escuchaPadres: [a.escucha, b.escucha] });
    }
    return {
      semilla, dias, porDia, poblacionFinal: world.people.length, mortalesFinal: world.people.filter(p => p.role === 'neighbor').length,
      tope, mensajes, perdidos, pares, fundadores, segundos: (performance.now() - inicio) / 1000, carga: loadavg()[0]!,
    };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// ── Resumen ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface Resumen {
  replicas: number; topes: number[]; mensajes: number; oidos: number; sinOir: number; cumplidos: number; olvidados: number; enCamino: number; perdidos: number;
  spearmanTodos: { rho: number; ic95: [number, number]; p: number };
  spearmanSoloOidos: { n: number; rho: number; ic95: [number, number] };
  latenciaPorTercil: { tercil: string; escuchaMedia: number; n: number; oidos: number; medianaPasos: number | null }[];
  herencia: { pares: number; familias: number; pendiente: number; ic95: [number, number]; r: number; ordenada: number; porReplica: { semilla: number; pares: number; pendiente: number | null }[] };
  fundadores: { n: number; media: number; desviacion: number; min: number; max: number };
  criterio: { spearmanNegativo: boolean; pendienteEnRango: boolean; icPendienteDentro: boolean };
}

const PERMUTACIONES = 20_000, REMUESTREOS = 2_000;

export function resumir(replicas: readonly Replica[]): Resumen {
  const azar = generador(20261124);
  const mensajes = replicas.flatMap(r => r.mensajes.map(m => ({ ...m, semilla: r.semilla })));
  const latencia = (m: MensajeMedido) => m.oido === null ? WHISPER_LIFETIME_TICKS : m.oido - m.creado;
  const persona = (m: { semilla: number; personaId: string }) => `${m.semilla}:${m.personaId}`;
  const rho = (xs: readonly MensajeMedido[]) => spearman(xs.map(m => m.escucha), xs.map(latencia));
  const rhoTodos = rho(mensajes), pTodos = pPermutacion(mensajes.map(m => m.escucha), mensajes.map(latencia), rhoTodos, PERMUTACIONES, azar);
  const oidos = mensajes.filter(m => m.oido !== null);

  const orden = [...mensajes].sort((a, b) => a.escucha - b.escucha), tercio = Math.ceil(orden.length / 3);
  const tercil = ['bajo', 'medio', 'alto'].map((nombre, i) => {
    const grupo = orden.slice(i * tercio, (i + 1) * tercio), oidosGrupo = grupo.filter(m => m.oido !== null);
    return { tercil: nombre, escuchaMedia: media(grupo.map(m => m.escucha)), n: grupo.length, oidos: oidosGrupo.length, medianaPasos: oidosGrupo.length ? mediana(oidosGrupo.map(latencia)) : null };
  });

  const pares = replicas.flatMap(r => r.pares.map(p => ({ ...p, semilla: r.semilla })));
  const mediaPadres = (p: ParMedido) => (p.escuchaPadres[0] + p.escuchaPadres[1]) / 2;
  const reg = regresion(pares.map(mediaPadres), pares.map(p => p.escucha));
  const familia = (p: ParMedido & { semilla: number }) => `${p.semilla}:${[...p.padres].sort().join('+')}`;
  const pendiente = (xs: readonly ParMedido[]) => regresion(xs.map(mediaPadres), xs.map(p => p.escucha)).pendiente;
  const icPendiente = bootstrapPorGrupo(pares, familia, pendiente, REMUESTREOS, azar);

  const fundadores = replicas.flatMap(r => r.fundadores);
  const mediaFund = media(fundadores);
  return {
    replicas: replicas.length, topes: replicas.filter(r => r.tope !== null).map(r => r.semilla),
    mensajes: mensajes.length, oidos: oidos.length, sinOir: mensajes.filter(m => m.desenlace === 'sin-oir').length,
    cumplidos: mensajes.filter(m => m.desenlace === 'cumplido').length, olvidados: mensajes.filter(m => m.desenlace === 'olvidado').length,
    enCamino: mensajes.filter(m => m.desenlace === 'en-camino').length, perdidos: replicas.reduce((a, r) => a + r.perdidos, 0),
    spearmanTodos: { rho: rhoTodos, ic95: bootstrapPorGrupo(mensajes, persona, rho, REMUESTREOS, azar), p: pTodos },
    spearmanSoloOidos: { n: oidos.length, rho: rho(oidos), ic95: bootstrapPorGrupo(oidos, persona, rho, REMUESTREOS, azar) },
    latenciaPorTercil: tercil,
    herencia: {
      pares: pares.length, familias: new Set(pares.map(familia)).size, pendiente: reg.pendiente, ic95: icPendiente, r: reg.r, ordenada: reg.ordenada,
      porReplica: replicas.map(r => ({ semilla: r.semilla, pares: r.pares.length, pendiente: r.pares.length >= 8 ? pendiente(r.pares) : null })),
    },
    fundadores: { n: fundadores.length, media: mediaFund, desviacion: Math.sqrt(media(fundadores.map(x => (x - mediaFund) ** 2))), min: Math.min(...fundadores), max: Math.max(...fundadores) },
    criterio: {
      spearmanNegativo: rhoTodos < 0 && pTodos < 0.05,
      pendienteEnRango: reg.pendiente >= 0.6 && reg.pendiente <= 1.1,
      icPendienteDentro: icPendiente[0] >= 0.6 && icPendiente[1] <= 1.1,
    },
  };
}

// ── Orquestación ─────────────────────────────────────────────────────────────────────────────────────────────

async function lanzar(semillas: number[], dias: number, porDia: number, procesos: number, salida: string, tope: number, parametros: string | undefined): Promise<void> {
  const script = fileURLToPath(import.meta.url);
  const cola = [...semillas];
  const worker = async () => {
    for (let s = cola.shift(); s !== undefined; s = cola.shift()) {
      const destino = join(salida, `semilla-${s}.json`);
      if (existsSync(destino)) continue;
      await new Promise<void>((ok, ko) => {
        const args = ['tsx', script, '--semilla', String(s), '--dias', String(dias), '--por-dia', String(porDia), '--tope-mortales', String(tope), '--salida', destino, ...(parametros ? ['--params', parametros] : [])];
        const hijo = spawn('npx', args, { stdio: ['ignore', 'inherit', 'inherit'] });
        hijo.on('exit', c => c === 0 ? ok() : ko(new Error(`semilla ${s}: salió con ${c}`)));
        hijo.on('error', ko);
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(procesos, semillas.length) }, worker));
}

const f = (x: number, d = 3) => Number.isFinite(x) ? x.toFixed(d).replace('.', ',') : 'n/d';
function imprimir(r: Resumen): void {
  const ic = (x: [number, number], d = 3) => `[${f(x[0], d)}; ${f(x[1], d)}]`;
  console.log(`\nW1 — escucha heredable (${r.replicas} réplicas${r.topes.length ? `, con tope de mortales en ${r.topes.join(',')}` : ''})`);
  console.log(`mensajes medidos ${r.mensajes}: oídos ${r.oidos}, sin oír ${r.sinOir} (censurados en el plazo de ${WHISPER_LIFETIME_TICKS} pasos), perdidos por otra causa ${r.perdidos}`);
  console.log(`entre los oídos: cumplidos ${r.cumplidos}, olvidados ${r.olvidados}, en camino al acabar ${r.enCamino}`);
  console.log(`Spearman escucha~latencia (censurados en el plazo): rho = ${f(r.spearmanTodos.rho)}  IC95 ${ic(r.spearmanTodos.ic95)}  p(rho<0, permutación ${PERMUTACIONES}) = ${f(r.spearmanTodos.p, 4)}`);
  console.log(`Spearman solo entre los oídos (n=${r.spearmanSoloOidos.n}): rho = ${f(r.spearmanSoloOidos.rho)}  IC95 ${ic(r.spearmanSoloOidos.ic95)}`);
  for (const t of r.latenciaPorTercil) console.log(`  tercil ${t.tercil}: escucha media ${f(t.escuchaMedia, 2)}, n ${t.n}, oídos ${t.oidos} (${f(100 * t.oidos / t.n, 1)} %), mediana de latencia ${t.medianaPasos === null ? 'n/d' : `${f(t.medianaPasos, 0)} pasos`}`);
  console.log(`Herencia: ${r.herencia.pares} pares hijo~media de padres (${r.herencia.familias} familias): pendiente = ${f(r.herencia.pendiente)}  IC95 por familias ${ic(r.herencia.ic95)}  r = ${f(r.herencia.r)}  ordenada ${f(r.herencia.ordenada)}`);
  console.log(`  por réplica: ${r.herencia.porReplica.map(p => `${p.semilla}: ${p.pendiente === null ? `n=${p.pares}` : `${f(p.pendiente, 2)} (n=${p.pares})`}`).join('; ')}`);
  console.log(`Fundadores: n ${r.fundadores.n}, media ${f(r.fundadores.media)}, d.t. ${f(r.fundadores.desviacion)}, rango [${f(r.fundadores.min)}; ${f(r.fundadores.max)}]`);
  console.log(`Criterio W1: Spearman<0 con p<0,05 ${r.criterio.spearmanNegativo ? 'CUMPLE' : 'FALLA'}; pendiente en [0,6; 1,1] ${r.criterio.pendienteEnRango ? 'CUMPLE' : 'FALLA'} (IC entero dentro: ${r.criterio.icPendienteDentro ? 'sí' : 'no'})`);
}

async function main(): Promise<void> {
  const resumenDe = arg('--resumen');
  if (resumenDe) {
    const replicas = readdirSync(resumenDe).filter(n => /^semilla-\d+\.json$/.test(n)).sort().map(n => JSON.parse(readFileSync(join(resumenDe, n), 'utf8')) as Replica);
    if (!replicas.length) throw new Error(`Sin réplicas en ${resumenDe}.`);
    const resumen = resumir(replicas);
    writeFileSync(join(resumenDe, 'resumen.json'), JSON.stringify(resumen, null, 2));
    return imprimir(resumen);
  }
  const dias = Number(arg('--dias') ?? 15), porDia = Number(arg('--por-dia') ?? 4), tope = Number(arg('--tope-mortales') ?? 300);
  const parametros = arg('--params');
  if (!Number.isInteger(dias) || dias < 5 || !Number.isInteger(porDia) || porDia < 1 || !Number.isInteger(tope) || tope < 1) throw new Error('Uso: --dias D (entero ≥ 5) --por-dia N (≥ 1) --tope-mortales N (≥ 1).');
  const una = arg('--semilla');
  if (una !== undefined) {
    const semilla = Number(una), salida = arg('--salida');
    if (!Number.isInteger(semilla) || semilla < 0 || !salida) throw new Error('Uso: --semilla S --salida <fichero.json>.');
    const replica = correrReplica(semilla, dias, porDia, tope, parametros);
    mkdirSync(join(salida, '..'), { recursive: true });
    writeFileSync(salida, JSON.stringify(replica));
    console.log(`semilla ${semilla}: ${replica.mensajes.length} mensajes, ${replica.pares.length} pares, ${replica.segundos.toFixed(0)} s, carga ${replica.carga.toFixed(1)}${replica.tope ? `, tope de mortales en el día ${replica.tope}` : ''}`);
    return;
  }
  const semillas = (arg('--semillas') ?? Array.from({ length: 12 }, (_, i) => 4001 + i).join(',')).split(',').map(Number);
  if (semillas.some(s => !Number.isInteger(s) || s < 0)) throw new Error('--semillas: enteros ≥ 0 separados por comas.');
  const procesos = Number(arg('--procesos') ?? 6);
  mkdirSync('/tmp/atlas-v23-e', { recursive: true });
  const salida = arg('--salida') ?? mkdtempSync('/tmp/atlas-v23-e/w1-');
  mkdirSync(salida, { recursive: true });
  console.log(`salida: ${salida}; carga ${loadavg()[0]!.toFixed(1)}`);
  await lanzar(semillas, dias, porDia, procesos, salida, tope, parametros);
  const replicas = semillas.map(s => JSON.parse(readFileSync(join(salida, `semilla-${s}.json`), 'utf8')) as Replica);
  const resumen = resumir(replicas);
  writeFileSync(join(salida, 'resumen.json'), JSON.stringify(resumen, null, 2));
  imprimir(resumen);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
