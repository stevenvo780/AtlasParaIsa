/**
 * Banco del paso material (carril W1c): huella para la identidad de los arreglos, perfil por fases, velocidad con hilos,
 * error de la cadencia, proyección y perfil del mundo vivo. La sombra material sigue el tiempo del laboratorio
 * (luz media de la ventana y lluvia por bloques de 600 ticks), como el punto (f).
 *   huella    --pasos 600 [--lado 64] [--cada 10] [--semilla 1] [--gpu 0,1] --salida f
 *   comparar  a b [--estadistica]                                           primera diferencia o medias y dispersión
 *   vivo      [--hasta intentos] [--semilla 7] [--dias 1] [--gpu cpu|0|1|0,1|todos] [--cada N] [--salida f]
 *             mismo mundo y comprobaciones que encender, con un resumen del paso material por configuración.
 *   fases     [--pasos 60] [--lado 64] [--cada 10]                          ms por fase y reacciones evaluadas/aplicadas
 *   velocidad [--hilos 1,8] [--pasos 50] [--lado 64] [--cada 10] [--reparto modulo|coste]   µs por tesela y tick
 *   cadencia  --k 1,10,60,120 [--dias 1,5] [--lado 32] [--semilla 1] [--mapa 1] [--grupo vida|cinetica|intercambio] --salida dir
 *             vistas tras cada día pedido, por K (con --grupo, solo ese grupo de procesos cada K ticks y el resto cada tick)
 *   errores   dir [--ref f]                                                tabla de error frente a K = 1 (y ruido de semilla); con
 *             --ref, frente a esa corrida (p. ej. la K = 1 de otro integrador) y todas las de dir son filas
 *   arder     [--k 1,10,60,120]                                           un lote de fuego 120 ticks con pasos de K ticks
 */
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus, hostname, loadavg } from 'node:os';
import type { Tile } from '../src/shared/types.js';
import { createWorld, phaseAt } from '../src/world/mundo/crear.js';
import { activate } from '../src/world/spatial.js';
import { LUZ_CREPSCULO } from '../src/world/ecologia-constantes.js';
import { TICKS_PER_DAY } from '../src/world/mundo/tipos.js';
import { CanalCompartido } from '../src/world/gpu/canal.js';
import { crearPasoMateriaGpu, prepararMateriaGpu, type PasoMateriaGpu } from '../src/world/gpu/materia-gpu.js';
import { lanzarQuimicaSuelos } from '../src/world/materia/ley-mundo.js';
import { crearServicioQuimico, serializarSustancias } from '../src/world/materia/servicio.js';
import { MundoMaterial, totalesVacios, CUENTA, DT_LLUVIA, type DescriptorMundo, type Forzamiento } from '../src/world/materia/mundo.js';
import { cuentaIntegrador, pasoLote } from '../src/world/materia/paso.js';
import { fluir } from '../src/world/materia/fluir.js';
import { CAPACIDAD_ATOMO, ELEMENTOS, KAPPA_SUELO, KAPPA_SUELO_HH } from '../src/shared/naturaleza.js';
import { Rol, type LoteRef } from '../src/world/materia/tipos.js';
import { vistaVacia } from '../src/world/materia/vistas.js';
import { argumentosEncender, encender } from './lab/encender.mjs';

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1]! : d; };
const lista = (k: string, d: string) => opt(k, d).split(',').map(Number);
const carga = () => `carga ${loadavg().map((x) => x.toFixed(1)).join(' ')} (${hostname()}, ${cpus().length} hilos)`;
function indicesGpu(seleccion: string): number[] {
  if (seleccion === 'cpu') return [];
  if (!/^\d+(,\d+)*$/.test(seleccion)) throw new Error('Usa cpu o una lista de ID de GPU separados por comas.');
  const gpu = seleccion.split(',').map(Number);
  if (new Set(gpu).size !== gpu.length || !gpu.every(Number.isSafeInteger)) throw new Error('Los ID de GPU deben ser enteros distintos.');
  return gpu;
}

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
  for (const x of m.arenaLab.muestras()) {
    h.update(new Uint8Array(Float64Array.of(x.ref, x.celda, x.rol, x.dueno, x.pares.length).buffer));
    h.update(new Uint8Array(x.pares.buffer, x.pares.byteOffset, x.pares.byteLength));
  }
  return h.digest('hex').slice(0, 16);
}

function huella(): void {
  const pasos = +opt('pasos', '600'), lado = +opt('lado', '64'), cada = +opt('cada', '10'), semilla = +opt('semilla', '1');
  const gpu = indicesGpu(opt('gpu', 'cpu')), estadistica = argv.includes('--estadistica');
  const m = MundoMaterial.levantar(teselas(semilla, lado), crearServicioQuimico({ modo: 'inmediato' }), { semilla });
  const tot = totalesVacios(), clima = tiempo(semilla), filas: string[] = [];
  m.plegar(tot);
  let ms = 0, tripletas = 0;
  const tarjetas: { canal: CanalCompartido; paso: PasoMateriaGpu; paginas: number[] }[] = [];
  const paginas = Array.from({ length: m.np }, (_, p) => p);
  try {
    for (const id of gpu) {
      const canal = new CanalCompartido(id);
      tarjetas.push({ canal, paso: crearPasoMateriaGpu(canal), paginas: [] });
      prepararMateriaGpu(canal, 30_000);
    }
    if (tarjetas.length) for (const p of paginas) tarjetas[p % tarjetas.length]!.paginas.push(p);
    for (let k = 0, t = 0; k < pasos; k++, t += cada) {
      const t0 = performance.now();
      m.prepararPaso();
      const f = clima(t, cada);
      if (tarjetas.length) {
        m.arenaLab.barrera();
        for (const p of paginas) m.pasarAntes(p, f);
        const pendientes = tarjetas.filter(g => g.paginas.length).map(g => lanzarQuimicaSuelos(m, g.paso, g.paginas, f.dt, t));
        for (const p of paginas) m.quimicaCharcas(p, f.dt);
        for (const recoger of pendientes) tripletas += recoger().tripletas;
        for (const p of paginas) m.pasarDespues(p, f, true);
        m.recibir();
      } else m.pasar(f);
      ms += performance.now() - t0;
      const libro = sha(m.libro.fuentes, m.libro.sumideros, m.libro.enVuelo, m.cuentas);
      m.plegar(tot);
      filas.push(`${k} libro ${libro} vistas ${sha(vistas(m))} lotes ${lotes(m)}`);
    }
  } finally {
    for (const { paso, canal } of tarjetas) {
      try { paso.cerrar(); } finally { canal.cerrar(); }
    }
  }
  const s = m.saldo(), exacto = s.every((x, k) => x === tot.esperado[k]);
  filas.push(`fin saldo ${s.join(',')} exacto ${exacto}`);
  if (estadistica) {
    const v = vistas(m);
    const campos = ['agua', 'humedad', 'vegetacion', 'comida', 'madera', 'piedra'];
    const resumen = Object.fromEntries(campos.map((campo, j) => {
      let suma = 0, cuadrados = 0;
      for (let i = j; i < v.length; i += campos.length) {
        suma += v[i]!;
        cuadrados += v[i]! ** 2;
      }
      const media = suma / m.n;
      return [campo, { media, desviacion: Math.sqrt(Math.max(0, cuadrados / m.n - media ** 2)) }];
    }));
    filas.push(`estadistica ${JSON.stringify({ exacto, tripletas, msPorPaso: ms / pasos, campos: resumen })}`);
  }
  writeFileSync(opt('salida', '/tmp/atlas-v23-wperf/huella.txt'), filas.join('\n') + '\n');
  console.log(`huella de ${pasos} pasos (${m.n} teselas): ${(ms / pasos).toFixed(1)} ms por paso, libro exacto ${exacto}; ${carga()}`);
  if (!exacto) process.exitCode = 2;
}

function comparar(): void {
  const [a, b] = [argv[1]!, argv[2]!].map((f) => readFileSync(f, 'utf8').trim().split('\n'));
  if (argv.includes('--estadistica')) {
    const leer = (filas: string[]): { exacto: boolean; tripletas: number; msPorPaso: number; campos: Record<string, { media: number; desviacion: number }> } => {
      const fila = filas.find(l => l.startsWith('estadistica '));
      if (!fila) throw new Error('La huella requiere --estadistica.');
      return JSON.parse(fila.slice('estadistica '.length));
    };
    const cpu = leer(a!), tarjeta = leer(b!);
    for (const [campo, x] of Object.entries(cpu.campos)) {
      const y = tarjeta.campos[campo]!;
      console.log(`${campo}: media ${x.media.toFixed(7)} / ${y.media.toFixed(7)}, Δ ${(y.media - x.media).toExponential(3)}; σ ${x.desviacion.toFixed(7)} / ${y.desviacion.toFixed(7)}`);
    }
    console.log(`ms/paso ${cpu.msPorPaso.toFixed(2)} / ${tarjeta.msPorPaso.toFixed(2)}; libro exacto ${cpu.exacto} / ${tarjeta.exacto}; tripletas GPU ${tarjeta.tripletas}`);
    if (!cpu.exacto || !tarjeta.exacto || tarjeta.tripletas === 0) process.exitCode = 2;
    return;
  }
  const n = Math.max(a!.length, b!.length);
  for (let i = 0; i < n; i++) if (a![i] !== b![i]) {
    console.log(`DIFIEREN en la línea ${i + 1} de ${n}:\n  ${a![i]}\n  ${b![i]}`);
    process.exitCode = 1;
    return;
  }
  console.log(`IDÉNTICAS: ${n} líneas (libro, vistas y lotes de cada paso, y el saldo final)`);
}

// ── Mundo vivo ──

const FASES_GPU = ['msPreparar', 'msEnviar', 'msEsperar', 'msLeer', 'msServidor', 'msH2D',
  'msLanzar', 'msKernel', 'msD2H', 'msSincronizar'] as const;
type FaseGpu = typeof FASES_GPU[number];
type DespachoGpu = Partial<Record<FaseGpu, number>> & {
  dispositivo: number; tick: number; bytesH2D?: number; bytesD2H?: number; tripletas?: number; fallo?: string;
};
type ArranqueGpu = { dispositivo: number; msNvrtc: number; msModulo: number };
type PasoVivo = { ms: number; paginas: number; paginasCpu: number; fallos: number };

function duraciones(muestras: number[]) {
  const n = muestras.length;
  if (!n) return null;
  muestras.sort((a, b) => a - b);
  return { n, media: muestras.reduce((a, b) => a + b, 0) / n, p95: muestras[Math.ceil(n * 0.95) - 1]!, max: muestras[n - 1]! };
}

async function vivo(): Promise<void> {
  const args = argv.slice(1);
  const i = args.indexOf('--gpu'), seleccion = i < 0 ? 'cpu' : (args.splice(i, 2)[1] ?? '');
  const modos = (seleccion === 'todos' ? ['cpu', '0', '1', '0,1'] : [seleccion]).map(indicesGpu);
  const o = argumentosEncender(['--hasta', 'intentos', '--semilla', '7', ...args]);
  if (!o.comprobar) throw new Error('El perfil del mundo vivo requiere las comprobaciones de encender.');
  if (o.salida) writeFileSync(o.salida, '');
  for (const gpu of modos) {
    const cargaInicial = carga();
    const ms: number[] = [], arranques: ArranqueGpu[] = [], despachos = new Map<number, DespachoGpu[]>();
    let paginas = 0, paginasCpu = 0, fallos = 0;
    const paso = (mensaje: unknown) => {
      const p = mensaje as PasoVivo;
      ms.push(p.ms);
      paginas += p.paginas; paginasCpu += p.paginasCpu; fallos += p.fallos;
    };
    const despacho = (mensaje: unknown) => {
      const d = mensaje as DespachoGpu;
      let lista = despachos.get(d.dispositivo);
      if (!lista) despachos.set(d.dispositivo, lista = []);
      lista.push(d);
    };
    const arranque = (mensaje: unknown) => { arranques.push(mensaje as ArranqueGpu); };
    const canalPaso = channel('atlas:materia:paso'), canalGpu = channel('atlas:materia:gpu'), canalCuda = channel('atlas:materia:cuda');
    canalPaso.subscribe(paso); canalGpu.subscribe(despacho); canalCuda.subscribe(arranque);
    const dias: { dia: unknown; tick: unknown; exacto: boolean; gpuMateria?: unknown }[] = [];
    let violaciones = 0, fin: Record<string, unknown> | undefined;
    let codigo: number;
    try {
      codigo = await encender({ ...o, gpu }, fila => {
        if (fila.tipo === 'dia') dias.push({ dia: fila.dia, tick: fila.tick,
          exacto: (fila.conservacion as { ok?: boolean } | null)?.ok === true, gpuMateria: fila.gpuMateria });
        if (fila.tipo === 'fin') fin = fila;
        if (fila.tipo === 'violacion' || fila.tipo === 'aviso') console.log(JSON.stringify(fila));
        if (fila.tipo === 'violacion') violaciones++;
      });
    } finally {
      canalPaso.unsubscribe(paso); canalGpu.unsubscribe(despacho); canalCuda.unsubscribe(arranque);
    }
    const tarjetas = gpu.map(dispositivo => {
      const filas = despachos.get(dispositivo) ?? [];
      return { dispositivo, tandas: filas.length, arranques: arranques.filter(a => a.dispositivo === dispositivo),
        fases: Object.fromEntries(FASES_GPU.map(f => [f, duraciones(filas.flatMap(d => d[f] === undefined ? [] : [d[f]]))])),
        bytesH2D: filas.reduce((s, d) => s + (d.bytesH2D ?? 0), 0), bytesD2H: filas.reduce((s, d) => s + (d.bytesD2H ?? 0), 0),
        tripletas: filas.reduce((s, d) => s + (d.tripletas ?? 0), 0),
        fallos: filas.flatMap(d => d.fallo ? [{ tick: d.tick, error: d.fallo }] : []) };
    });
    const msPorPagina = paginas ? ms.reduce((s, t) => s + t, 0) / paginas : null;
    const resumen = JSON.stringify({ tipo: 'perfil-material', gpu, semilla: o.semilla, hasta: o.hasta, dias, fin, violaciones,
      msPaso: duraciones(ms), msPorPagina, paginas, paginasCpu, fallos, tarjetas, cargaInicial, cargaFinal: carga() });
    console.log(resumen);
    if (o.salida) appendFileSync(o.salida, resumen + '\n');
    if (codigo || fin?.estado !== 'completo' || dias.length !== o.dias || dias.some(d => !d.exacto) || violaciones || !ms.length
      || fallos || (gpu.length > 0 && paginasCpu > 0) || tarjetas.some(t => !t.tripletas || t.fallos.length)) process.exitCode = 2;
  }
}

// ── Fases ──

type Privado = {
  crecer(i: number, p: number, a: LoteRef, luz: number, dt: number): void; caer(i: number, dt: number): void;
  intercambiar(l: LoteRef, a: LoteRef, g: number, capL: number, capA: number, dt: number, T: number): void;
  vapor(p: number, dt: number, T: number): void; mezclarCielo(p: number, dt: number, T: number): void;
  llover(p: number, f: Forzamiento, T: number): void; escurrir(p: number): void; manar(p: number, dt: number): void;
  enviar(p: number, dt: number): void; posar(p: number, T: number): void; semilla: number; estadoAzar: Uint32Array;
};
const FASES = ['crecer', 'caer', 'cinética suelo', 'cinética agua', 'cinética aire', 'intercambio suelo–aire', 'charca–suelo',
  'vapor', 'posar', 'termostato', 'barrera y reservas', 'libro (plegar)', 'vistas', 'cielo, lluvia, mar y viento'] as const;

/** `pasarPagina` de mundo.ts con un reloj por fase (mismo orden de llamadas, así que el mismo resultado; la cobertura
 * foliar media de la página, que siembra las teselas peladas, no se actualiza aquí). */
function paginaMedida(m: MundoMaterial, p: number, f: Forzamiento, t: Float64Array, lotesCuenta: Float64Array): void {
  const x = m as unknown as Privado, c = m.ctx;
  const { dt } = f, a = m.aire[p]!, i0 = m.inicio[p]!, i1 = m.inicio[p + 1]!;
  const partido = m.params.reparto === 'strang' && dt > 1, dtVida = partido ? dt / 2 : dt, luzFin = f.luzFin ?? f.luz;
  const T = m.temperatura(p, partido ? (f.luz + luzFin) / 2 : f.luz), Taire = f.lluvia ? T - DT_LLUVIA : T;
  x.semilla = x.estadoAzar[p]!;
  let r = performance.now();
  const marca = (k: number) => { const s = performance.now(); t[k]! += s - r; r = s; };
  for (let i = i0; i < i1; i++) { x.crecer(i, p, a, f.luz, dtVida); marca(0); x.caer(i, dtVida); marca(1); }
  for (let i = i0; i < i1; i++) { tipo = 0; pasoLote(c, m.suelo[i]!, dt, SUELO); marca(2); lotesCuenta[0]!++; }
  for (let i = i0; i < i1; i++) if (m.agua[i]! >= 0) { tipo = 1; pasoLote(c, m.agua[i]!, dt, SIN); marca(3); lotesCuenta[1]!++; }
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
  x.mezclarCielo(p, dt, Taire); x.llover(p, f, Taire); x.escurrir(p); x.manar(p, dt); x.enviar(p, dt); marca(13);
  x.posar(p, Taire); marca(8);
  if (partido) for (let i = i0; i < i1; i++) { x.crecer(i, p, a, luzFin, dtVida); marca(0); x.caer(i, dtVida); marca(1); }
  for (let i = i0; i < i1; i++) {
    m.termostato(m.suelo[i]!, T); m.termostato(m.vida[i]!, T);
    if (m.agua[i]! >= 0) m.termostato(m.agua[i]!, T);
  }
  m.termostato(a, Taire); m.termostato(m.mar[p]!, T); m.termostato(m.cielo[p]!, Taire - m.params.fisica.enfriamientoAltura); marca(9);
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
  const c0 = { ...cuentaIntegrador };
  for (let k = 0, tk = 0; k < pasos; k++, tk += cada) {
    const f = clima(tk, cada);
    const t0 = performance.now();
    m.prepararPaso(); m.arenaLab.barrera();
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
  const integ = cuentaIntegrador.integraciones - c0.integraciones, comp = cuentaIntegrador.compartidas - c0.compartidas;
  const sub = cuentaIntegrador.subpasos - c0.subpasos, inst = cuentaIntegrador.instantaneas - c0.instantaneas;
  console.log(`integrador: ${integ} integraciones, ${(100 * comp / integ).toFixed(1)} % con reactivo compartido (${(100 * inst / Math.max(1, comp)).toFixed(1)} % de ellas con fase instantánea), ${(sub / Math.max(1, comp)).toFixed(1)} subpasos en esas, ${((integ - comp + sub) / integ).toFixed(2)} pasos de integración por integración`);
  console.log(`fuera de la cinética (crecer, fuego…): ${consultas[3]} consultas, ${aplicadas[3]} aplicaciones; sustancias por suelo ${(especies / muestras).toFixed(1)}; total de sustancias ${q.totalSustancias()}`);
}

// ── Velocidad ──

/** Dueño de cada página: p % hilos (el de `levantar`), o por coste (la página más cara al hilo menos cargado). El
 * resultado no depende del dueño (cada página lleva su azar), solo el reparto de la carga. */
function repartir(m: MundoMaterial, hilos: number, coste: Float64Array | null): void {
  if (!coste) { for (let p = 0; p < m.np; p++) m.dueno[p] = p % hilos; return; }
  const carga = new Float64Array(hilos), orden = Array.from({ length: m.np }, (_, p) => p).sort((a, b) => coste[b]! - coste[a]! || a - b);
  for (const p of orden) {
    let h = 0;
    for (let k = 1; k < hilos; k++) if (carga[k]! < carga[h]!) h = k;
    m.dueno[p] = h; carga[h]! += coste[p]!;
  }
}

async function velocidad(): Promise<void> {
  const lado = +opt('lado', '64'), cada = +opt('cada', '10'), semilla = +opt('semilla', '1'), pasos = +opt('pasos', '50');
  const etiqueta = opt('etiqueta', ''), reparto = opt('reparto', 'modulo');
  for (const hilos of lista('hilos', '1,8')) {
    const q = crearServicioQuimico({ modo: 'inmediato' });
    const m = MundoMaterial.levantar(teselas(semilla, lado), q, { hilos, semilla });
    const clima = tiempo(semilla);
    let t = 0;
    // Calentamiento en el hilo principal (que la química conozca las mezclas), midiendo lo que cuesta cada página.
    m.dueno.fill(0);
    const coste = new Float64Array(m.np);
    for (; t < 30 * cada; t += cada) {
      const f = clima(t, cada);
      m.prepararPaso(); m.arenaLab.barrera();
      for (let p = 0; p < m.np; p++) { const t0 = performance.now(); m.pasarPagina(p, f); coste[p]! += performance.now() - t0; }
    }
    repartir(m, hilos, reparto === 'coste' ? coste : null);
    const d: DescriptorMundo = { ...m.d, sustancias: serializarSustancias(q) };
    const workers = hilos > 1 ? Array.from({ length: hilos }, (_, h) => hiloBanco({ bancoMaterial: true, d, hilo: h })) : [];
    let ms = 0, maximo = 0, medio = 0;
    // Los workers tienen cada uno su química: unos pasos sin medir para que aprendan sus mezclas (en el mundo viven siempre).
    const fria = hilos > 1 ? +opt('calentar-hilos', '10') : 0;
    for (let k = -fria; k < pasos; k++, t += cada) {
      const f = clima(t, cada);
      m.prepararPaso();
      const t0 = performance.now();
      if (hilos === 1) m.pasar(f);
      else {
        const r = await Promise.all(workers.map((wk) => new Promise<number>((ok) => { wk.once('message', ok); wk.postMessage(f); })));
        maximo += Math.max(...r); medio += r.reduce((a, b) => a + b, 0) / r.length;
      }
      if (k < 0) { ms = maximo = medio = 0; continue; }
      ms += performance.now() - t0;
    }
    await Promise.all(workers.map((wk) => wk.terminate()));
    const us = 1000 * ms / pasos / m.n / cada;
    console.log(`velocidad ${etiqueta} hilos=${hilos} reparto=${reparto} ${(ms / pasos).toFixed(1)} ms por paso de ${cada} ticks → ${us.toFixed(3)} µs por tesela y tick (${m.n} teselas)${hilos > 1 ? `; hilo más lento ${(maximo / pasos).toFixed(1)} ms, medio ${(medio / pasos).toFixed(1)} ms` : ''}; ${carga()}`);
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
 * (suelo–aire, charca–suelo, vapor, cielo, lluvia, escorrentía, manantiales y posar). Así se ve qué procesos aguantan qué
 * K. La vida va aquí de una vez (reparto 'inicio'): el de Strang se mide con el paso entero (`--reparto`).
 */
function paginaMixta(m: MundoMaterial, p: number, t: number, K: number, grupo: Grupo, lluvia: (t: number) => boolean): void {
  const x = m as unknown as Privado, c = m.ctx, a = m.aire[p]!, i0 = m.inicio[p]!, i1 = m.inicio[p + 1]!;
  const ventana = (g: Grupo): Forzamiento | null => {
    const k = g === grupo ? K : 1;
    return t % k === 0 ? { dt: k, luz: luzMedia(t, k), lluvia: lluvia(t) } : null;
  };
  x.semilla = x.estadoAzar[p]!;
  const fv = ventana('vida'), fc = ventana('cinetica'), fi = ventana('intercambio');
  if (fv) for (let i = i0; i < i1; i++) { x.crecer(i, p, a, fv.luz, fv.dt); x.caer(i, fv.dt); }
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
    x.mezclarCielo(p, fi.dt, Taire); x.llover(p, fi, Taire); x.escurrir(p); x.manar(p, fi.dt);
    x.posar(p, Taire);
  }
  if (fc) {
    const T = m.temperatura(p, fc.luz), Taire = fc.lluvia ? T - DT_LLUVIA : T;
    for (let i = i0; i < i1; i++) {
      m.termostato(m.suelo[i]!, T); m.termostato(m.vida[i]!, T);
      if (m.agua[i]! >= 0) m.termostato(m.agua[i]!, T);
    }
    m.termostato(a, Taire); m.termostato(m.mar[p]!, T); m.termostato(m.cielo[p]!, Taire - m.params.fisica.enfriamientoAltura);
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
    // --reparto inicio|strang: dónde se evalúa la vida dentro de la ventana (para medir cuánto baja el sesgo de K).
    const m = MundoMaterial.levantar(teselas(mapa, lado), q, { semilla, luz: luzMedia(0, grupo ? 1 : K), reparto: opt('reparto', 'strang') === 'inicio' ? 'inicio' : 'strang' });
    const tot = totalesVacios(), clima = tiempo(mapa), lluvia = lluvias(mapa);
    m.plegar(tot);
    const fotos: Record<string, unknown> = {};
    const t0 = performance.now();
    let t = 0;
    for (const dia of dias) {
      if (grupo) for (; t < dia * TICKS_PER_DAY; t++) {
        m.prepararPaso(); m.arenaLab.barrera();
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
  type Corrida = { K: number; semilla: number; grupo: string; segundos: number; fotos: Record<string, Foto> };
  const leer = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as Corrida;
  const corr = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => leer(`${dir}/${f}`));
  const fichero = opt('ref', '');
  const ref = fichero ? leer(fichero) : corr.find((c) => c.K === 1 && c.semilla === 1 && !c.grupo);
  if (!ref) throw new Error('Falta la corrida K = 1 de la semilla 1.');
  const filas = corr.filter((c) => c !== ref && (fichero !== '' || c.semilla === 1 || c.K === 1))
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
  parentPort!.on('message', (f: Forzamiento) => { const t0 = performance.now(); m.pasar(f); parentPort!.postMessage(performance.now() - t0); });
} else if (isMainThread) {
  const orden = argv[0];
  if (orden === 'huella') huella();
  else if (orden === 'comparar') comparar();
  else if (orden === 'vivo') await vivo();
  else if (orden === 'fases') await fases();
  else if (orden === 'velocidad') await velocidad();
  else if (orden === 'cadencia') cadencia();
  else if (orden === 'errores') errores();
  else if (orden === 'arder') arder();
  else { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 15).join('\n')); process.exitCode = 2; }
}
