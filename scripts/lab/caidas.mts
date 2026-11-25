/**
 * scripts/lab/caidas.mts — 20 `kill -9` al servidor de un worktree, con un `CARTA_DATA_DIR` temporal y en fases al azar.
 *
 *   tsx scripts/lab/caidas.mts --worktree /ruta/al/worktree [--caidas 20] [--semilla 51926] [--hasta materia] [--params "a.b=1"]
 *        [--turbo si|no] [--abierto] [--espera-lista 180] [--comando "node dist/server/server/main.js"] [--salida informe.json] [--mantener]
 *
 * Cada caída: arranca el servidor, espera la fase elegida (arranque, marcha, guardado o cinta), le manda SIGKILL, lo vuelve a
 * arrancar sobre el mismo directorio y comprueba:
 *   1. vuelve a servir (`/health` responde) sin intervención;
 *   2. vuelve al último guardado: `/health.ultimoTickGuardado` no es anterior al último que se vio antes de matarlo;
 *   3. la época es nueva: `/health.epoca` mayor que todas las vistas;
 *   4. la cinta marca lo huérfano: el catálogo (`cinta.idx.sqlite`) abre una época de «reinicio» y, si el mundo vuelve por
 *      detrás de lo que la cinta tenía, la época vieja queda visible solo hasta ese tick y con su bifurcación.
 * Lo que `/health` aún no diga (época, último tick guardado: los dejará srv) sale como «desconocido», no como fallo ni acierto.
 *
 * Código de salida: 0 todas bien, 3 alguna caída con problemas, 1 error del instrumento. No lee credenciales: el mundo es
 * temporal y su contraseña, aleatoria, solo vive en el entorno del proceso hijo.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escalon, INTERRUPTORES, type Interruptor } from '../../src/shared/interruptores.js';

export const FASES = ['arranque', 'marcha', 'guardado', 'cinta'] as const;
export type Fase = typeof FASES[number];

export interface OpcionesCaidas {
  worktree: string; caidas: number; semilla: number; hasta?: Interruptor; params?: string; turbo: boolean; abierto: boolean;
  /** Segundos que se espera a que el servidor responda `/health` tras arrancar. */
  esperaLista: number; comando?: string[]; salida?: string; mantener: boolean;
}

const entero = (texto: string, nombre: string, minimo = 1): number => {
  const n = Number(texto);
  if (!Number.isSafeInteger(n) || n < minimo) throw new Error(`${nombre}: se esperaba un entero ≥ ${minimo}`);
  return n;
};

export function argumentosCaidas(args: string[]): OpcionesCaidas {
  const o: Partial<OpcionesCaidas> = { caidas: 20, semilla: 51926, turbo: true, abierto: false, esperaLista: 180, mantener: false };
  for (let i = 0; i < args.length; i++) {
    const bandera = args[i]!;
    if (bandera === '--mantener') { o.mantener = true; continue; }
    if (bandera === '--abierto') { o.abierto = true; continue; }
    const valor = args[++i];
    if (valor === undefined) throw new Error(`Falta valor para ${bandera}`);
    switch (bandera) {
      case '--worktree': o.worktree = resolve(valor); break;
      case '--caidas': o.caidas = entero(valor, bandera); break;
      case '--semilla': o.semilla = entero(valor, bandera, 0); break;
      case '--hasta':
        if (!(INTERRUPTORES as readonly string[]).includes(valor)) throw new Error(`--hasta: «${valor}» no es un interruptor V23`);
        o.hasta = valor as Interruptor; break;
      case '--params': o.params = valor; break;
      case '--turbo': if (valor !== 'si' && valor !== 'no') throw new Error('--turbo si|no'); o.turbo = valor === 'si'; break;
      case '--espera-lista': o.esperaLista = entero(valor, bandera); break;
      case '--comando': o.comando = valor.split(/\s+/).filter(Boolean); break;
      case '--salida': o.salida = resolve(valor); break;
      default: throw new Error(`Opción desconocida: ${bandera}`);
    }
  }
  if (!o.worktree) throw new Error('Falta --worktree');
  return o as OpcionesCaidas;
}

// ── Azar y plan ──────────────────────────────────────────────────────────────────────────────────────────

export function mulberry32(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Las fases de las `n` caídas: cada fase sale al menos una vez si caben, y el resto y el orden son al azar con la semilla. */
export function planDeCaidas(n: number, semilla: number): Fase[] {
  const azar = mulberry32(semilla), plan: Fase[] = [];
  for (let i = 0; i < n; i++) plan.push(i < FASES.length ? FASES[i]! : FASES[Math.floor(azar() * FASES.length)]!);
  for (let i = plan.length - 1; i > 0; i--) { const j = Math.floor(azar() * (i + 1)); [plan[i], plan[j]] = [plan[j]!, plan[i]!]; }
  return plan;
}

// ── Lo que se lee del servidor ───────────────────────────────────────────────────────────────────────────

export interface EstadoServidor {
  tick: number | null; epoca: number | null; ultimoTickGuardado: number | null;
  /** Reloj de pared del último guardado (`/health.ultimoGuardado`), para saber cuándo guardó. */
  guardadoEn: number | null;
}
const numero = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const campo = (j: unknown, ...ruta: string[]): unknown => ruta.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), j);

/** Normaliza `/health`: acepta los nombres que srv podría dejar (`epoca`, `ultimoTickGuardado`) y dice null si no están. */
export function leerSalud(j: unknown): EstadoServidor {
  return {
    tick: numero(campo(j, 'tick')),
    epoca: numero(campo(j, 'epoca')) ?? numero(campo(j, 'cinta', 'epoca')) ?? numero(campo(j, 'epoch')),
    ultimoTickGuardado: numero(campo(j, 'ultimoTickGuardado')) ?? numero(campo(j, 'guardado', 'tick')) ?? numero(campo(j, 'persistencia', 'ultimoTick')),
    guardadoEn: numero(campo(j, 'ultimoGuardado')),
  };
}

export interface Antes extends EstadoServidor {
  /** Mayor último-tick-guardado visto antes de matar, y mayor tick visto. */
  maxTickGuardadoVisto: number | null; maxTickVisto: number | null; epocasVistas: number[];
}
export interface Juicio { problemas: string[]; desconocidos: string[] }

/** Veredicto de una recuperación (puro): 1 sirve, 2 vuelve al último guardado, 3 época nueva. */
export function juzgarRecuperacion(antes: Antes, despues: EstadoServidor | null): Juicio {
  const problemas: string[] = [], desconocidos: string[] = [];
  if (!despues) return { problemas: ['El servidor no volvió a responder /health.'], desconocidos };
  if (despues.tick === null) problemas.push('/health no trae el tick tras el reinicio.');
  if (despues.epoca === null) desconocidos.push('época: /health no la dice');
  else if (antes.epocasVistas.length && despues.epoca <= Math.max(...antes.epocasVistas)) {
    problemas.push(`La época no es nueva: ${despues.epoca} ≤ ${Math.max(...antes.epocasVistas)}.`);
  }
  if (despues.ultimoTickGuardado === null) desconocidos.push('último tick guardado: /health no lo dice');
  else {
    if (antes.maxTickGuardadoVisto !== null && despues.ultimoTickGuardado < antes.maxTickGuardadoVisto) {
      problemas.push(`Volvió a un guardado anterior al ya visto: ${despues.ultimoTickGuardado} < ${antes.maxTickGuardadoVisto}.`);
    }
    // No hay cota superior: entre la última sonda y el SIGKILL el mundo pudo guardar un tick que no se llegó a ver.
  }
  return { problemas, desconocidos };
}

// ── La cinta ─────────────────────────────────────────────────────────────────────────────────────────────

export interface EpocaCatalogo { id: number; instanciaId: string; tMundo: number; motivo: string; t1: number; visibleHasta: number | null }
export interface BifurcacionCatalogo { epoca: number; desde: number; hasta: number; motivo: string }

/** El catálogo de la cinta debajo de `dir`, o null si aún no existe. */
export function buscarCatalogo(dir: string): string | null {
  const pendientes = [dir];
  while (pendientes.length) {
    const d = pendientes.pop()!;
    let entradas: import('node:fs').Dirent[];
    try { entradas = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entradas) {
      if (e.isFile() && e.name === 'cinta.idx.sqlite') return join(d, e.name);
      if (e.isDirectory()) pendientes.push(join(d, e.name));
    }
  }
  return null;
}

export function leerCatalogo(ruta: string): { epocas: EpocaCatalogo[]; bifurcaciones: BifurcacionCatalogo[] } {
  const db = new DatabaseSync(ruta, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    return {
      epocas: db.prepare('SELECT id, instanciaId, tMundo, motivo, t1, visibleHasta FROM epocas ORDER BY id').all() as unknown as EpocaCatalogo[],
      bifurcaciones: db.prepare('SELECT epoca, desde, hasta, motivo FROM bifurcaciones ORDER BY epoca, desde').all() as unknown as BifurcacionCatalogo[],
    };
  } finally { db.close(); }
}

/**
 * La cinta tras un reinicio (puro): `antes` son las épocas que había, `despues` las de ahora. Debe haber una época nueva de
 * reinicio y, si el mundo volvió por detrás de lo que la cinta tenía, lo de después queda marcado: la época vieja solo visible
 * hasta el tick de vuelta y con su bifurcación. Si el servidor murió antes de abrir la cinta, no hay época nueva y no es fallo.
 */
export function juzgarCinta(antes: readonly EpocaCatalogo[], despues: readonly EpocaCatalogo[], bifurcaciones: readonly BifurcacionCatalogo[], abiertaPorElArranque: boolean): Juicio {
  const problemas: string[] = [], desconocidos: string[] = [];
  const idMax = antes.reduce((m, e) => Math.max(m, e.id), -1);
  const nuevas = despues.filter(e => e.id > idMax);
  if (nuevas.length > 1) problemas.push(`Se abrieron ${nuevas.length} épocas en un solo reinicio.`);
  if (!nuevas.length) {
    if (abiertaPorElArranque) problemas.push('El reinicio no abrió una época nueva en la cinta.');
    else desconocidos.push('cinta: el servidor murió antes de abrirla');
    return { problemas, desconocidos };
  }
  const nueva = nuevas[0]!;
  if (nueva.motivo !== 'reinicio' && nueva.motivo !== 'restauracion') problemas.push(`La época nueva tiene un motivo inesperado: ${nueva.motivo}.`);
  const previa = [...despues].filter(e => e.id < nueva.id).sort((a, b) => b.id - a.id)[0];
  if (previa && nueva.tMundo < previa.t1) {
    const bif = bifurcaciones.find(b => b.epoca === previa.id && b.desde === nueva.tMundo && b.hasta === previa.t1);
    if (!bif) problemas.push(`Lo huérfano (${nueva.tMundo}…${previa.t1}) de la época ${previa.id} no tiene su bifurcación.`);
    if (previa.visibleHasta === null || previa.visibleHasta > nueva.tMundo) {
      problemas.push(`La época ${previa.id} sigue visible más allá de ${nueva.tMundo}: visibleHasta = ${previa.visibleHasta}.`);
    }
  }
  return { problemas, desconocidos };
}

// ── Procesos ─────────────────────────────────────────────────────────────────────────────────────────────

const dormir = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
async function esperarHasta<T>(sonda: () => Promise<T | null | undefined | false> | T | null | undefined | false, limiteMs: number, pasoMs = 100): Promise<T | null> {
  const fin = Date.now() + limiteMs;
  for (;;) {
    const v = await sonda();
    if (v) return v as T;
    if (Date.now() >= fin) return null;
    await dormir(pasoMs);
  }
}
function puertoLibre(): Promise<number> {
  return new Promise((ok, mal) => {
    const s = createServer();
    s.once('error', mal);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => ok(port)); });
  });
}

interface Servidor { hijo: ChildProcess; salio: Promise<{ codigo: number | null; senal: NodeJS.Signals | null }>; cola: () => string }

function arrancar(o: OpcionesCaidas, env: NodeJS.ProcessEnv): Servidor {
  const comando = o.comando ?? (existsSync(join(o.worktree, 'dist/server/server/main.js'))
    ? [process.execPath, 'dist/server/server/main.js'] : [process.execPath, '--import', 'tsx', 'src/server/main.ts']);
  const hijo = spawn(comando[0]!, comando.slice(1), { cwd: o.worktree, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let cola = '';
  const guardar = (b: Buffer): void => { cola = (cola + String(b)).slice(-4096); };
  hijo.stdout?.on('data', guardar); hijo.stderr?.on('data', guardar);
  const salio = new Promise<{ codigo: number | null; senal: NodeJS.Signals | null }>(ok => hijo.once('exit', (codigo, senal) => ok({ codigo, senal })));
  return { hijo, salio, cola: () => cola };
}

async function salud(puerto: number): Promise<EstadoServidor | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${puerto}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok && r.status !== 503) return null;
    return leerSalud(await r.json());
  } catch { return null; }
}

/** `kill -9` de verdad: SIGKILL al proceso (su hilo de simulación y el de la cinta mueren con él). */
async function matar(s: Servidor): Promise<{ codigo: number | null; senal: NodeJS.Signals | null }> {
  s.hijo.kill('SIGKILL');
  return await Promise.race([s.salio, dormir(15_000).then(() => { throw new Error('El proceso no murió tras SIGKILL.'); })]);
}

const tamanoCinta = (dir: string): number => {
  let total = 0;
  const pendientes = [dir];
  while (pendientes.length) {
    const d = pendientes.pop()!;
    let es: import('node:fs').Dirent[];
    try { es = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of es) { const p = join(d, e.name); if (e.isDirectory()) pendientes.push(p); else { try { total += statSync(p).size; } catch { /* se movió */ } } }
  }
  return total;
};

export interface Caida {
  n: number; fase: Fase; lista: boolean; msHastaMatar: number; antes: Antes; despues: EstadoServidor | null;
  salidaDelHijo: { codigo: number | null; senal: NodeJS.Signals | null }; recuperacion: Juicio; cinta: Juicio; problemas: string[]; desconocidos: string[]; colaDelHijo?: string;
}

export async function caidas(o: OpcionesCaidas, escribirFila: (fila: Record<string, unknown>) => void): Promise<number> {
  if (!existsSync(o.worktree)) throw new Error(`No existe el worktree: ${o.worktree}`);
  const base = mkdtempSync(join(tmpdir(), 'atlas-caidas-')), datos = join(base, 'datos');
  const puerto = await puertoLibre(), azar = mulberry32(o.semilla ^ 0x9e3779b9), plan = planDeCaidas(o.caidas, o.semilla);
  const v23 = o.hasta ? Object.entries(escalon(o.hasta)).map(([k, v]) => `v23.${k}=${v}`) : [];
  const parametros = ['persistencia.cadaTicks=200', ...v23, ...(o.params ? [o.params] : [])].join(',');
  const env: NodeJS.ProcessEnv = { ...process.env, CARTA_DATA_DIR: datos, HOST: '127.0.0.1', PORT: String(puerto), CARTA_ORIGIN: `http://127.0.0.1:${puerto}`,
    CARTA_PASSWORD: randomBytes(16).toString('hex'), CARTA_SIM_WORKER: '1', CARTA_TAPE: '1', ...(o.turbo ? { CARTA_TURBO: '1' } : {}),
    ...(o.abierto ? { CARTA_OPEN_WORLD: '1' } : {}), CARTA_PARAMS: parametros, NODE_ENV: 'production' };
  escribirFila({ tipo: 'inicio', worktree: o.worktree, datos, puerto, semilla: o.semilla, hasta: o.hasta ?? null, caidas: o.caidas, plan, params: parametros });

  const epocasVistas: number[] = [];
  const resultados: Caida[] = [];
  let fallo = false;
  let servidor = arrancar(o, env);
  try {
    // La primera vida del mundo: se espera a que sirva para que existan un guardado y una época de partida.
    const primera = await esperarHasta(() => salud(puerto), o.esperaLista * 1000, 250);
    if (!primera) throw new Error(`El servidor no respondió /health en ${o.esperaLista} s.\n${servidor.cola()}`);
    if (primera.epoca !== null) epocasVistas.push(primera.epoca);
    for (let n = 1; n <= o.caidas; n++) {
      const fase = plan[n - 1]!, t0 = Date.now();
      const antes: Antes = { tick: null, epoca: null, ultimoTickGuardado: null, guardadoEn: null, maxTickGuardadoVisto: null, maxTickVisto: null, epocasVistas: [...epocasVistas] };
      const observar = (s: EstadoServidor | null): void => {
        if (!s) return;
        Object.assign(antes, s);
        if (s.tick !== null) antes.maxTickVisto = Math.max(antes.maxTickVisto ?? 0, s.tick);
        if (s.ultimoTickGuardado !== null) antes.maxTickGuardadoVisto = Math.max(antes.maxTickGuardadoVisto ?? 0, s.ultimoTickGuardado);
        if (s.epoca !== null && !antes.epocasVistas.includes(s.epoca)) antes.epocasVistas.push(s.epoca);
      };
      let lista = false;
      // La fase decide cuándo cae: justo al arrancar, en marcha, pegada a un guardado o pegada a una escritura de la cinta.
      if (fase === 'arranque') {
        await dormir(100 + Math.floor(azar() * 6000));
      } else {
        const s0 = await esperarHasta(() => salud(puerto), o.esperaLista * 1000, 100);
        lista = !!s0; observar(s0);
        if (fase === 'marcha') {
          const hasta = Date.now() + Math.floor(azar() * 5000);
          while (Date.now() < hasta) { observar(await salud(puerto)); await dormir(100); }
        } else if (fase === 'guardado') {
          const desde = s0?.guardadoEn ?? null;
          await esperarHasta(async () => { const s = await salud(puerto); observar(s); return s && s.guardadoEn !== null && s.guardadoEn !== desde ? s : null; }, 60_000, 20);
          await dormir(Math.floor(azar() * 200));
        } else {
          const antesCinta = tamanoCinta(datos);
          await esperarHasta(async () => { observar(await salud(puerto)); return tamanoCinta(datos) !== antesCinta; }, 60_000, 20);
          await dormir(Math.floor(azar() * 100));
        }
      }
      const catalogoAntes = buscarCatalogo(datos), epocasAntes = catalogoAntes ? leerCatalogo(catalogoAntes).epocas : [];
      const msHastaMatar = Date.now() - t0;
      const salidaDelHijo = await matar(servidor);
      servidor = arrancar(o, env);
      const despues = await esperarHasta(() => salud(puerto), o.esperaLista * 1000, 250);
      const recuperacion = juzgarRecuperacion(antes, despues);
      if (despues?.epoca !== null && despues?.epoca !== undefined) epocasVistas.push(despues.epoca);
      let cinta: Juicio = { problemas: [], desconocidos: ['cinta: no hay catálogo (¿CARTA_TAPE?)'] };
      const catalogoDespues = buscarCatalogo(datos);
      if (despues && catalogoDespues) {
        // El catálogo ya se abrió si hay época nueva: se lee con el servidor vivo (solo lectura) tras darle un respiro.
        await dormir(500);
        const { epocas, bifurcaciones } = leerCatalogo(catalogoDespues);
        cinta = juzgarCinta(epocasAntes, epocas, bifurcaciones, fase !== 'arranque' || lista);
      }
      const caida: Caida = { n, fase, lista, msHastaMatar, antes, despues, salidaDelHijo, recuperacion, cinta,
        problemas: [...recuperacion.problemas, ...cinta.problemas], desconocidos: [...recuperacion.desconocidos, ...cinta.desconocidos],
        ...(despues ? {} : { colaDelHijo: servidor.cola() }) };
      resultados.push(caida);
      escribirFila({ tipo: 'caida', ...caida });
      if (caida.problemas.length) fallo = true;
      if (!despues) break;
    }
  } finally {
    if (!servidor.hijo.killed && servidor.hijo.exitCode === null) { try { await matar(servidor); } catch { /* ya no está */ } }
    if (!o.mantener && !fallo) rmSync(base, { recursive: true, force: true });
  }
  const resumen = { tipo: 'fin', caidas: resultados.length, conProblemas: resultados.filter(c => c.problemas.length).length,
    porFase: Object.fromEntries(FASES.map(f => [f, { caidas: resultados.filter(c => c.fase === f).length, conProblemas: resultados.filter(c => c.fase === f && c.problemas.length).length }])),
    desconocidos: [...new Set(resultados.flatMap(c => c.desconocidos))], datos: o.mantener || fallo ? datos : null };
  escribirFila(resumen);
  return resumen.conProblemas || resultados.length < o.caidas ? 3 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    process.stdout.write(`${readSource()}\n`);
  } else {
    (async () => {
      const o = argumentosCaidas(process.argv.slice(2));
      const filas: Record<string, unknown>[] = [];
      const codigo = await caidas(o, fila => { filas.push(fila); process.stdout.write(`${JSON.stringify(fila)}\n`); });
      if (o.salida) writeFileSync(o.salida, JSON.stringify(filas, null, 2));
      process.exitCode = codigo;
    })().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
  }
}
function readSource(): string {
  return `tsx scripts/lab/caidas.mts --worktree DIR [--caidas 20] [--semilla 51926] [--hasta interruptor] [--params "a.b=1"] [--turbo si|no] [--abierto] [--espera-lista 180] [--comando "cmd args"] [--salida informe.json] [--mantener]`;
}
