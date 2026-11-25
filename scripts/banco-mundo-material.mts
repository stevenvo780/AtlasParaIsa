/**
 * Banco del paso material (carril W1c): huella para la identidad de los arreglos, perfil por fases, velocidad con hilos,
 * error de la cadencia y proyección. Corre la sombra material sola (sin el mundo escalar al lado), como el punto (f) del
 * laboratorio, con el mismo tiempo (luz media de la ventana y lluvia por bloques de 600 ticks).
 *   huella    --pasos 600 [--lado 64] [--cada 10] [--semilla 1] --salida f   una línea por paso: libro, vistas y lotes (sha1)
 *   comparar  a b                                                          primera diferencia entre dos huellas
 *   fases     [--pasos 60] [--lado 64] [--cada 10]                          ms por fase y reacciones evaluadas/aplicadas
 *   velocidad [--hilos 1,8] [--pasos 50] [--lado 64] [--cada 10]          µs por tesela y tick (calentamiento en un hilo)
 *   cadencia  --k 1,10,60,120 [--dias 1,5] [--lado 32] [--semilla 1] [--mapa 1] [--grupo vida|cinetica|intercambio] --salida dir
 *             vistas tras cada día pedido, por K (con --grupo, solo ese grupo de procesos cada K ticks y el resto cada tick)
 *   errores   dir                                                          tabla de error frente a K = 1 (y ruido de semilla)
 *   arder     [--k 1,10,60,120]                                           un lote de fuego 120 ticks con pasos de K ticks
 */
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus, hostname, loadavg } from 'node:os';
import type { Tile } from '../src/shared/types.js';
import { createWorld, phaseAt } from '../src/world/mundo/crear.js';
import { activate } from '../src/world/spatial.js';
import { LUZ_CREPSCULO } from '../src/world/ecologia-constantes.js';
import { TICKS_PER_DAY } from '../src/world/mundo/tipos.js';
import { crearServicioQuimico, serializarSustancias } from '../src/world/materia/servicio.js';
import { MundoMaterial, totalesVacios, CUENTA, DT_LLUVIA, type DescriptorMundo, type Forzamiento } from '../src/world/materia/mundo.js';
import { pasoLote } from '../src/world/materia/paso.js';
import { fluir } from '../src/world/materia/fluir.js';
import { CAPACIDAD_ATOMO, ELEMENTOS, KAPPA_SUELO, KAPPA_SUELO_HH } from '../src/shared/naturaleza.js';
import { Rol, type LoteRef } from '../src/world/materia/tipos.js';
import { vistaVacia } from '../src/world/materia/vistas.js';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1]! : d; };
const lista = (k: string, d: string) => opt(k, d).split(',').map(Number);
const carga = () => `carga ${loadavg().map((x) => x.toFixed(1)).join(' ')} (${hostname()}, ${cpus().length} hilos)`;

function luzMedia(t: number, dt: number): number {
  let s = 0;
  for (let k = 0; k < dt; k++) { const f = phaseAt(t + k); s += f === 'day' ? 1 : f === 'night' ? 0 : LUZ_CREPSCULO; }
  return s / dt;
}

/** El tiempo del laboratorio: lluvia con probabilidad 0,4 en cada bloque de 600 ticks (el mismo sorteo con cualquier K). */
function tiempo(semilla: number) {
  let a = semilla >>> 0, lluvia = false;
  const azar = () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return (t: number, dt: number): Forzamiento => {
    if (Math.floor(t / 600) !== Math.floor((t - dt) / 600) || t === 0) lluvia = azar() < 0.4;
    return { dt, luz: luzMedia(t, dt), lluvia };
  };
}

function teselas(semilla: number, lado: number): Tile[] {
  const w = createWorld(semilla);
  for (let cy = 0; cy < lado / 16; cy++) for (let cx = 0; cx < lado / 16; cx++) activate(w, cx * 16, cy * 16);
  return w.tiles.filter((t) => t.x >= 0 && t.y >= 0 && t.x < lado && t.y < lado);
}

const sha = (...partes: ArrayBufferView[]) => {
  const h = createHash('sha1');
  for (const p of partes) h.update(new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
  return h.digest('hex').slice(0, 16);
};

function vistas(m: MundoMaterial): Float64Array {
  const out = new Float64Array(6 * m.n), v = vistaVacia();
  for (let i = 0; i < m.n; i++) {
    m.vista(i, v);
    out.set([v.drinkingWater, v.moisture, v.vegetation, v.food, v.wood, v.stone], 6 * i);
  }
  return out;
}

/** Todo el estado material: cada lote vivo con su ref, celda y pares en el orden de sus ranuras. */
function lotes(m: MundoMaterial): string {
  const h = createHash('sha1');
  for (const x of m.arena.muestras()) {
    h.update(new Uint8Array(Float64Array.of(x.ref, x.celda, x.rol, x.dueno, x.pares.length).buffer));
    h.update(new Uint8Array(x.pares.buffer, x.pares.byteOffset, x.pares.byteLength));
  }
  return h.digest('hex').slice(0, 16);
}

function huella(): void {
  const pasos = +opt('pasos', '600'), lado = +opt('lado', '64'), cada = +opt('cada', '10'), semilla = +opt('semilla', '1');
  const m = MundoMaterial.levantar(teselas(semilla, lado), crearServicioQuimico({ modo: 'inmediato' }), { semilla });
  const tot = totalesVacios(), clima = tiempo(semilla), filas: string[] = [];
  m.plegar(tot);
  let ms = 0;
  for (let k = 0, t = 0; k < pasos; k++, t += cada) {
    const t0 = performance.now();
    m.prepararPaso(); m.pasar(clima(t, cada));
    ms += performance.now() - t0;
    const libro = sha(m.libro.fuentes, m.libro.sumideros, m.libro.enVuelo, m.cuentas);
    m.plegar(tot);
    filas.push(`${k} libro ${libro} vistas ${sha(vistas(m))} lotes ${lotes(m)}`);
  }
  const s = m.saldo(), exacto = s.every((x, k) => x === tot.esperado[k]);
  filas.push(`fin saldo ${s.join(',')} exacto ${exacto}`);
  writeFileSync(opt('salida', '/tmp/atlas-v23-wperf/huella.txt'), filas.join('\n') + '\n');
  console.log(`huella de ${pasos} pasos (${m.n} teselas): ${(ms / pasos).toFixed(1)} ms por paso, libro exacto ${exacto}; ${carga()}`);
}

function comparar(): void {
  const [a, b] = [argv[1]!, argv[2]!].map((f) => readFileSync(f, 'utf8').trim().split('\n'));
  const n = Math.max(a!.length, b!.length);
  for (let i = 0; i < n; i++) if (a![i] !== b![i]) {
    console.log(`DIFIEREN en la línea ${i + 1} de ${n}:\n  ${a![i]}\n  ${b![i]}`);
    process.exitCode = 1;
    return;
  }
  console.log(`IDÉNTICAS: ${n} líneas (libro, vistas y lotes de cada paso, y el saldo final)`);
}

// ── Fases ──

type Privado = {
  crecer(i: number, a: LoteRef, f: Forzamiento): void; caer(i: number, dt: number): void;
  intercambiar(l: LoteRef, a: LoteRef, g: number, capL: number, capA: number, dt: number, T: number): void;
  vapor(p: number, dt: number, T: number): void; posar(p: number, T: number): void; semilla: number; estadoAzar: Uint32Array;
};
const FASES = ['crecer', 'caer', 'cinética suelo', 'cinética agua', 'cinética aire', 'intercambio suelo–aire', 'charca–suelo',
  'vapor', 'posar', 'termostato', 'barrera y reservas', 'libro (plegar)', 'vistas'] as const;

/** `pasarPagina` de mundo.ts con un reloj por fase (mismo orden de llamadas, así que el mismo resultado). */
function paginaMedida(m: MundoMaterial, p: number, f: Forzamiento, t: Float64Array, lotesCuenta: Float64Array): void {
  const x = m as unknown as Privado, c = m.ctx;
  const { dt } = f, a = m.aire[p]!, i0 = m.inicio[p]!, i1 = m.inicio[p + 1]!;
  const T = m.temperatura(p, f.luz), Taire = f.lluvia ? T - DT_LLUVIA : T;
  x.semilla = x.estadoAzar[p]!;
  let r = performance.now();
  const marca = (k: number) => { const s = performance.now(); t[k]! += s - r; r = s; };
  for (let i = i0; i < i1; i++) { x.crecer(i, a, f); marca(0); x.caer(i, dt); marca(1); }
  for (let i = i0; i < i1; i++) {
    tipo = 0; pasoLote(c, m.suelo[i]!, dt, SUELO); marca(2); lotesCuenta[0]!++;
    if (m.agua[i]! >= 0) { tipo = 1; pasoLote(c, m.agua[i]!, dt, SIN); marca(3); lotesCuenta[1]!++; }
  }
  tipo = 2; pasoLote(c, a, dt, SIN); marca(4); lotesCuenta[2]!++;
  tipo = 3;
  const capAire = 100 * (i1 - i0);
  for (let i = i0; i < i1; i++) {
    x.intercambiar(m.suelo[i]!, a, 1, 10, capAire, dt, T); marca(5);
    if (m.agua[i]! >= 0) {
      fluir(c, m.agua[i]!, m.suelo[i]!, m.S.H2O, m.params.gCharca, m.params.escalas.agua, m.params.escalas.humedad, 0, dt); marca(6);
    }
  }
  x.vapor(p, dt, Taire); marca(7);
  x.posar(p, Taire); marca(8);
  for (let i = i0; i < i1; i++) {
    m.termostato(m.suelo[i]!, T); m.termostato(m.vida[i]!, T);
    if (m.agua[i]! >= 0) m.termostato(m.agua[i]!, T);
  }
  m.termostato(a, Taire); marca(9);
  x.estadoAzar[p] = x.semilla;
}
const SIN = [0, 0, 0, 0] as [number, number, number, number];
const SUELO = [KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO, KAPPA_SUELO_HH] as [number, number, number, number];
let tipo = 0;

async function fases(): Promise<void> {
  const pasos = +opt('pasos', '60'), lado = +opt('lado', '64'), cada = +opt('cada', '10'), semilla = +opt('semilla', '1');
  const q = crearServicioQuimico({ modo: 'inmediato' });
  const m = MundoMaterial.levantar(teselas(semilla, lado), q, { semilla });
  // Contadores: pares evaluados (consultas a la química), canales que pasan la criba y aplicaciones con veces > 0.
  const consultas = new Float64Array(4), reacciones = new Float64Array(4), aplicadas = new Float64Array(4), veces = new Float64Array(4);
  const reaccion = q.reaccion.bind(q);
  q.reaccion = (a, b, n) => { const r = reaccion(a, b, n); consultas[tipo]!++; if (r) reacciones[tipo]!++; return r; };
  const aplicar = m.arena.aplicar.bind(m.arena);
  m.arena.aplicar = (l, e, v) => { const h = aplicar(l, e, v); if (h > 0) { aplicadas[tipo]!++; veces[tipo]! += h; } return h; };
  const tot = totalesVacios(), clima = tiempo(semilla);
  const t = new Float64Array(FASES.length), lotesCuenta = new Float64Array(3);
  let ms = 0, especies = 0, muestras = 0;
  for (let k = 0, tk = 0; k < pasos; k++, tk += cada) {
    const f = clima(tk, cada);
    const t0 = performance.now();
    m.prepararPaso(); m.arena.barrera();
    t[10]! += performance.now() - t0;
    for (let p = 0; p < m.np; p++) paginaMedida(m, p, f, t, lotesCuenta);
    const t1 = performance.now();
    m.plegar(tot);
    const t2 = performance.now();
    t[11]! += t2 - t1;
    vistas(m);
    t[12]! += performance.now() - t2;
    ms += performance.now() - t0;
    if (k % 10 === 0) for (let i = 0; i < m.n; i += 7) { especies += m.especies(m.suelo[i]!).length; muestras++; }
  }
  const total = t.reduce((s, v) => s + v, 0);
  console.log(`# Fases del paso material — ${pasos} pasos de ${cada} ticks, ${lado}×${lado} (${m.n} teselas, ${m.np} páginas) — ${carga()}`);
  console.log(`total ${(ms / pasos).toFixed(1)} ms por paso → ${(1000 * ms / pasos / m.n / cada).toFixed(2)} µs por tesela y tick`);
  console.log('| fase | ms por paso | % | µs por tesela y paso |\n|---|---|---|---|');
  FASES.forEach((nombre, k) => console.log(`| ${nombre} | ${(t[k]! / pasos).toFixed(2)} | ${(100 * t[k]! / total).toFixed(1)} | ${(1000 * t[k]! / pasos / m.n).toFixed(1)} |`));
  console.log('\n| lotes | lotes por paso | consultas a la química por lote | reacciones por lote | aplicaciones por lote | veces por aplicación |\n|---|---|---|---|---|---|');
  ['suelo', 'agua', 'aire'].forEach((nombre, k) => {
    const n = lotesCuenta[k]!;
    console.log(`| ${nombre} | ${(n / pasos).toFixed(0)} | ${(consultas[k]! / n).toFixed(1)} | ${(reacciones[k]! / n).toFixed(1)} | ${(aplicadas[k]! / n).toFixed(2)} | ${(veces[k]! / Math.max(1, aplicadas[k]!)).toFixed(1)} |`);
  });
  console.log(`fuera de la cinética (crecer, fuego…): ${consultas[3]} consultas, ${aplicadas[3]} aplicaciones; sustancias por suelo ${(especies / muestras).toFixed(1)}; total de sustancias ${q.totalSustancias()}`);
}

// ── Velocidad ──

async function velocidad(): Promise<void> {
  const lado = +opt('lado', '64'), cada = +opt('cada', '10'), semilla = +opt('semilla', '1'), pasos = +opt('pasos', '50');
  const etiqueta = opt('etiqueta', '');
  for (const hilos of lista('hilos', '1,8')) {
    const q = crearServicioQuimico({ modo: 'inmediato' });
    const m = MundoMaterial.levantar(teselas(semilla, lado), q, { hilos, semilla });
    const clima = tiempo(semilla);
    let t = 0;
    m.dueno.fill(0);
    for (; t < 30 * cada; t += cada) { m.prepararPaso(); m.pasar(clima(t, cada)); }
    for (let p = 0; p < m.np; p++) m.dueno[p] = p % hilos;
    const d: DescriptorMundo = { ...m.d, sustancias: serializarSustancias(q) };
    const workers = hilos > 1 ? Array.from({ length: hilos }, (_, h) => hiloBanco({ bancoMaterial: true, d, hilo: h })) : [];
    let ms = 0;
    for (let k = 0; k < pasos; k++, t += cada) {
      const f = clima(t, cada);
      m.prepararPaso();
      const t0 = performance.now();
      if (hilos === 1) m.pasar(f);
      else await Promise.all(workers.map((wk) => new Promise((ok) => { wk.once('message', ok); wk.postMessage(f); })));
      ms += performance.now() - t0;
    }
    await Promise.all(workers.map((wk) => wk.terminate()));
    const us = 1000 * ms / pasos / m.n / cada;
    console.log(`velocidad ${etiqueta} hilos=${hilos} ${(ms / pasos).toFixed(1)} ms por paso de ${cada} ticks → ${us.toFixed(3)} µs por tesela y tick (${m.n} teselas); ${carga()}`);
    await q.cerrar();
  }
}

/** Un worker que abre este mismo fichero con tsx registrado dentro (como la piscina): heredar el cargador del proceso
 * no funciona en todos los equipos (en server2, con Node 22.22, el worker no resolvía los .ts). */
function hiloBanco(datos: unknown): Worker {
  const cargador = JSON.stringify(import.meta.resolve('tsx/esm/api')), yo = JSON.stringify(import.meta.url);
  return new Worker(`import(${cargador}).then((m) => m.register()).then(() => import(${yo}))`, { eval: true, execArgv: [], workerData: datos });
}

// ── Cadencia ──

const CAMPOS = ['drinkingWater', 'moisture', 'vegetation', 'food', 'wood'] as const;

type Grupo = 'vida' | 'cinetica' | 'intercambio';

/** Lluvia del bloque de 600 ticks de t: el mismo sorteo que `tiempo`, por bloque, para pedirlo con cualquier ventana. */
function lluvias(semilla: number): (t: number) => boolean {
  const clima = tiempo(semilla), bloques: boolean[] = [];
  return (t) => {
    const b = Math.floor(t / 600);
    while (bloques.length <= b) bloques.push(clima(600 * bloques.length, 600).lluvia);
    return bloques[b]!;
  };
}

/**
 * `pasarPagina` con un grupo de procesos cada K ticks (dt = K, con la luz media de su ventana) y los demás cada tick:
 * vida (crecer y caer), cinética (pasoLote de suelo, agua y aire, y el termostato que se lleva su calor) o intercambio
 * (suelo–aire, charca–suelo, vapor y posar). Así se ve qué procesos aguantan qué K.
 */
function paginaMixta(m: MundoMaterial, p: number, t: number, K: number, grupo: Grupo, lluvia: (t: number) => boolean): void {
  const x = m as unknown as Privado, c = m.ctx, a = m.aire[p]!, i0 = m.inicio[p]!, i1 = m.inicio[p + 1]!;
  const ventana = (g: Grupo): Forzamiento | null => {
    const k = g === grupo ? K : 1;
    return t % k === 0 ? { dt: k, luz: luzMedia(t, k), lluvia: lluvia(t) } : null;
  };
  x.semilla = x.estadoAzar[p]!;
  const fv = ventana('vida'), fc = ventana('cinetica'), fi = ventana('intercambio');
  if (fv) for (let i = i0; i < i1; i++) { x.crecer(i, a, fv); x.caer(i, fv.dt); }
  if (fc) {
    for (let i = i0; i < i1; i++) {
      pasoLote(c, m.suelo[i]!, fc.dt, SUELO);
      if (m.agua[i]! >= 0) pasoLote(c, m.agua[i]!, fc.dt, SIN);
    }
    pasoLote(c, a, fc.dt, SIN);
  }
  if (fi) {
    const T = m.temperatura(p, fi.luz), Taire = fi.lluvia ? T - DT_LLUVIA : T, capAire = 100 * (i1 - i0);
    for (let i = i0; i < i1; i++) {
      x.intercambiar(m.suelo[i]!, a, 1, 10, capAire, fi.dt, T);
      if (m.agua[i]! >= 0) fluir(c, m.agua[i]!, m.suelo[i]!, m.S.H2O, m.params.gCharca, m.params.escalas.agua, m.params.escalas.humedad, 0, fi.dt);
    }
    x.vapor(p, fi.dt, Taire);
    x.posar(p, Taire);
  }
  if (fc) {
    const T = m.temperatura(p, fc.luz), Taire = fc.lluvia ? T - DT_LLUVIA : T;
    for (let i = i0; i < i1; i++) {
      m.termostato(m.suelo[i]!, T); m.termostato(m.vida[i]!, T);
      if (m.agua[i]! >= 0) m.termostato(m.agua[i]!, T);
    }
    m.termostato(a, Taire);
  }
  x.estadoAzar[p] = x.semilla;
}

function cadencia(): void {
  const lado = +opt('lado', '32'), semilla = +opt('semilla', '1'), dias = lista('dias', '1,5'), salida = opt('salida', '/tmp/atlas-v23-wperf/cadencia');
  // El mapa y el tiempo son los de --mapa; --semilla solo cambia el azar de la materia (para medir el ruido).
  const grupo = opt('grupo', '') as Grupo | '', mapa = +opt('mapa', '1');
  mkdirSync(salida, { recursive: true });
  for (const K of lista('k', '1,10,60,120')) {
    const q = crearServicioQuimico({ modo: 'inmediato' });
    const m = MundoMaterial.levantar(teselas(mapa, lado), q, { semilla, luz: luzMedia(0, grupo ? 1 : K) });
    const tot = totalesVacios(), clima = tiempo(mapa), lluvia = lluvias(mapa);
    m.plegar(tot);
    const fotos: Record<string, unknown> = {};
    const t0 = performance.now();
    let t = 0;
    for (const dia of dias) {
      if (grupo) for (; t < dia * TICKS_PER_DAY; t++) {
        m.prepararPaso(); m.arena.barrera();
        for (let p = 0; p < m.np; p++) paginaMixta(m, p, t, K, grupo, lluvia);
        m.plegar(tot);
      }
      else for (; t < dia * TICKS_PER_DAY; t += K) { m.prepararPaso(); m.pasar(clima(t, K)); m.plegar(tot); }
      const v = vistas(m), inv = m.inventario(), S = m.S;
      const aire = (id: number) => { let s = 0; for (let p = 0; p < m.np; p++) s += m.arena.cuantos(m.aire[p]!, id); return s; };
      fotos[dia] = {
        vistas: Array.from(v), cuentas: tot.cuentas.map(String),
        inventario: { H2O: inv.get(S.H2O) ?? 0, CO2: inv.get(S.CO2) ?? 0, O2: inv.get(S.O2) ?? 0, vaporAire: aire(S.H2O), CO2aire: aire(S.CO2) },
        exacto: m.saldo().every((x, k) => x === tot.esperado[k]),
      };
    }
    writeFileSync(`${salida}/s${semilla}-k${K}${grupo ? `-${grupo}` : ''}.json`, JSON.stringify({ K, semilla, lado, grupo, n: m.n, segundos: (performance.now() - t0) / 1000, fotos }));
    console.log(`cadencia K=${K}${grupo ? ` (solo ${grupo})` : ''} semilla ${semilla}: ${((performance.now() - t0) / 1000).toFixed(0)} s; ${carga()}`);
  }
}

interface Foto { vistas: number[]; cuentas: string[]; inventario: Record<string, number>; exacto: boolean }

function errores(): void {
  const dir = argv[1]!;
  const corr = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { K: number; semilla: number; grupo: string; segundos: number; fotos: Record<string, Foto> });
  const ref = corr.find((c) => c.K === 1 && c.semilla === 1 && !c.grupo);
  if (!ref) throw new Error('Falta la corrida K = 1 de la semilla 1.');
  const filas = corr.filter((c) => c !== ref && (c.semilla === 1 || c.K === 1))
    .sort((a, b) => (a.grupo || '').localeCompare(b.grupo || '') || a.K - b.K || a.semilla - b.semilla);
  const media = (v: number[], k: number) => { let s = 0, n = 0; for (let i = k; i < v.length; i += 6) { s += v[i]!; n++; } return s / n; };
  const rms = (a: number[], b: number[], k: number) => { let s = 0, n = 0; for (let i = k; i < a.length; i += 6) { s += (a[i]! - b[i]!) ** 2; n++; } return Math.sqrt(s / n); };
  for (const dia of Object.keys(ref.fotos)) {
    const r = ref.fotos[dia]!;
    console.log(`\n## Día ${dia}: error frente a K = 1 (semilla 1); la fila «K=1 s2» es el ruido de otra semilla\n`);
    console.log(`| corrida | ${CAMPOS.map((c) => `${c} Δmedia % / rms`).join(' | ')} | sol Δ% | caída Δ% | vapor aire Δ% | CO₂ aire Δ% | exacto |`);
    console.log(`|---|${CAMPOS.map(() => '---').join('|')}|---|---|---|---|---|`);
    const k = CAMPOS.map((_, j) => j);
    console.log(`| K=1 (valor) | ${k.map((j) => `${media(r.vistas, j).toFixed(4)}`).join(' | ')} | ${r.cuentas[CUENTA.SOL]} | ${r.cuentas[CUENTA.CAIDA]} | ${r.inventario.vaporAire} | ${r.inventario.CO2aire} | ${r.exacto} |`);
    for (const c of filas) {
      const x = c.fotos[dia]!;
      const d = (a: number, b: number) => (b === 0 ? (a === 0 ? '0' : '∞') : (100 * (a - b) / b).toFixed(2));
      console.log(`| K=${c.K}${c.grupo ? ` solo ${c.grupo}` : ''} s${c.semilla} (${c.segundos.toFixed(0)} s) | ${k.map((j) => `${d(media(x.vistas, j), media(r.vistas, j))} / ${rms(x.vistas, r.vistas, j).toFixed(4)}`).join(' | ')} | ${d(+x.cuentas[CUENTA.SOL]!, +r.cuentas[CUENTA.SOL]!)} | ${d(+x.cuentas[CUENTA.CAIDA]!, +r.cuentas[CUENTA.CAIDA]!)} | ${d(x.inventario.vaporAire!, r.inventario.vaporAire!)} | ${d(x.inventario.CO2aire!, r.inventario.CO2aire!)} | ${x.exacto} |`);
    }
  }
}

/** Un lote de fuego como el de `quemar` (hojas de una tesela con el doble del O₂ estequiométrico) durante 120 ticks. */
function arder(): void {
  const q = crearServicioQuimico({ modo: 'inmediato' });
  const m = MundoMaterial.levantar(teselas(1, 16), q, { semilla: 1 });
  const i = Array.from({ length: m.n }, (_, k) => k).find((k) => m.unidades(k, { hoja: 0, fruto: 0, tronco: 0 }).hoja > 50)!;
  console.log('| K | pasos | CO₂ producido | H₂O | O₂ que queda | sustancias | T final (K) |\n|---|---|---|---|---|---|---|');
  for (const K of lista('k', '1,10,60,120')) {
    // El mismo lote de partida para cada K: se copia el estado de la tesela en un fuego nuevo desde un mundo recién levantado.
    const mm = MundoMaterial.levantar(teselas(1, 16), q, { semilla: 1 });
    const fuego = mm.arena.nuevo(Rol.Objeto, -1, 0), vida = mm.vida[i]!, aire = mm.aire[mm.paginaDe(i)]!;
    for (const id of [...mm.especies(vida)]) mm.arena.mover({ de: vida, a: fuego, esp: id, cuantos: mm.arena.cuantos(vida, id) });
    let o2 = 0;
    for (const id of mm.especies(fuego)) { const at = q.sustancia(id).atomos; o2 += mm.arena.cuantos(fuego, id) * (at[E('C')]! + at[E('H')]! / 4 - at[E('O')]! / 2 + 1.25 * at[E('P')]!); }
    mm.arena.mover({ de: aire, a: fuego, esp: mm.S.O2, cuantos: Math.ceil(2 * Math.max(0, o2)) });
    mm.termostato(fuego, 1100, CUENTA.IGNICION);
    const co2 = mm.arena.cuantos(fuego, mm.S.CO2), h2o = mm.arena.cuantos(fuego, mm.S.H2O);
    for (let t = 0; t < 120; t += K) pasoLote(mm.ctx, fuego, K, SIN);
    const at = mm.especies(fuego).reduce((s, id) => s + mm.arena.cuantos(fuego, id) * q.sustancia(id).atomos.reduce((x, y) => x + y, 0), 0);
    console.log(`| ${K} | ${120 / K} | ${mm.arena.cuantos(fuego, mm.S.CO2) - co2} | ${mm.arena.cuantos(fuego, mm.S.H2O) - h2o} | ${mm.arena.cuantos(fuego, mm.S.O2)} | ${mm.especies(fuego).length} | ${(mm.arena.calor(fuego) / (CAPACIDAD_ATOMO * at)).toFixed(0)} |`);
  }
}
const E = (x: string) => ELEMENTOS.indexOf(x as never);

if (!isMainThread && (workerData as { bancoMaterial?: boolean } | null)?.bancoMaterial) {
  const { d, hilo } = workerData as { d: DescriptorMundo; hilo: number };
  const m = MundoMaterial.conectar(d, hilo);
  parentPort!.on('message', (f: Forzamiento) => { m.pasar(f); parentPort!.postMessage(0); });
} else if (isMainThread) {
  const orden = argv[0];
  if (orden === 'huella') huella();
  else if (orden === 'comparar') comparar();
  else if (orden === 'fases') await fases();
  else if (orden === 'velocidad') await velocidad();
  else if (orden === 'cadencia') cadencia();
  else if (orden === 'errores') errores();
  else if (orden === 'arder') arder();
  else { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 13).join('\n')); process.exitCode = 2; }
}
