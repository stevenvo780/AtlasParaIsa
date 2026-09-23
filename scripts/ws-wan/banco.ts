/** Banco WS-WAN: corre escenarios (ancho de banda × retardo × cámara × modo) de un cliente que
 * imita `connection.ts` a través de un `Enlace` contra una instancia propia (`servidor.ts`), y
 * une tres miradas por escenario:
 *   - cliente: % del tiempo en 'live' / «Sin conexión», silencios de 8 s, reconexiones,
 *     states/s, tamaño, huecos entre states, GET /api/world (duración, timeout 10 s);
 *   - servidor (telemetría JSONL de `servidor.ts`): envíos, `state` descartados por
 *     `bufferedAmount > 256 KiB`, cortes por `> 2 MiB`, `bufferedAmount` máximo, y la EDAD
 *     de cada `state` al llegar (llegada al cliente − salida del servidor, misma secuencia);
 *   - kernel del servidor: Send-Q del socket (`ss`), lo que `bufferedAmount` no ve.
 *
 * Uso:
 *   npx tsx scripts/ws-wan/banco.ts --servidor <json de servidor.ts> [--servidor-deflate <json>] \
 *     --escenarios <nombre de lote> --duracion 120 --paralelo 3 --salida <dir>
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Enlace } from './enlace.js';
import { Cliente, type Viewport } from './cliente.js';

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : 'true';
};
interface Servidor { port: number; origin: string; host: string; cookie: string; people: number; tick: number; deflate: boolean; telemetry: string }
const leerServidor = (path?: string): Servidor | null => path ? JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!) as Servidor : null;
const plano = leerServidor(arg('servidor'));
const deflate = leerServidor(arg('servidor-deflate'));
if (!plano) throw new Error('--servidor <fichero con la línea JSON de servidor.ts>');
const duracionS = Number(arg('duracion', '120'));
const paralelo = Number(arg('paralelo', '3'));
const salida = resolve(arg('salida', '/datos/tmp-atlas-lab/wsfix/banco')!);
/** `--estancar 30@12`: a los 30 s de cada tanda se congela el proceso servidor 12 s (SIGSTOP/SIGCONT),
 * como un bucle de eventos bloqueado por un guardado lento o por falta de CPU (SCHED_IDLE). */
const estancar = arg('estancar')?.split('@').map(Number) as [number, number] | undefined;
function pidDe(port: number): number | null {
  try { const out = execFileSync('ss', ['-tlnpH', `( sport = :${port} )`], { encoding: 'utf8' }); return Number(/pid=(\d+)/.exec(out)?.[1] ?? NaN) || null; } catch { return null; }
}
mkdirSync(salida, { recursive: true });

/** Pantallas (Landscape.reportViewport: ancho = ceil(cssW/zoom)+6, alto = ceil(cssH/zoom)+6,
 * zoom 32 si cssW ≥ 600, si no 24; tope 96×64). */
const CAMARAS: Record<string, Omit<Viewport, 'x' | 'y'> | null> = {
  'sin-camara': null,          // nunca envía viewport: 40×28 por defecto del servidor
  movil: { width: 23, height: 38 },      // 390×750 CSS, zoom 24
  portatil: { width: 49, height: 27 },   // 1366×657 CSS, zoom 32
  escritorio: { width: 66, height: 37 }, // 1920×969 CSS, zoom 32
  maximo: { width: 96, height: 64 },     // alejado al mínimo en pantalla grande
};
interface Escenario { etiqueta: string; mbps: number | null; retardoMs: number; camara: keyof typeof CAMARAS; suscribirMs: number; deflate: boolean }
const RTT_WAN = 90; // ms por sentido: torre↔VPS medido 88 ms de RTT; navegador en casa → VPS → torre ≈ 2×88
const lotes: Record<string, Escenario[]> = {
  humo: [{ etiqueta: 'lan-escritorio', mbps: null, retardoMs: 1, camara: 'escritorio', suscribirMs: 0, deflate: false }],
  humo2: [{ etiqueta: 'humo-50M-movil', mbps: 50, retardoMs: RTT_WAN, camara: 'movil', suscribirMs: 0, deflate: false }, { etiqueta: 'humo-2M-movil', mbps: 2, retardoMs: RTT_WAN, camara: 'movil', suscribirMs: 0, deflate: false }],
  ancho: [null, 20, 10, 5, 2].flatMap(mbps => (['movil', 'escritorio', 'maximo'] as const).map(camara => ({
    etiqueta: `${mbps ?? 'lan'}M-${camara}`, mbps, retardoMs: mbps === null ? 1 : RTT_WAN, camara, suscribirMs: 0, deflate: false }))),
  camaras: (['sin-camara', 'portatil', 'maximo'] as const).flatMap(camara => [20, 5].map(mbps => ({
    etiqueta: `${mbps}M-${camara}`, mbps, retardoMs: RTT_WAN, camara, suscribirMs: 0, deflate: false }))),
  observador: [2, 1, 0.5].flatMap(mbps => (['movil', 'escritorio'] as const).map(camara => ({ etiqueta: `${mbps}M-${camara}-obs5s`, mbps, retardoMs: RTT_WAN, camara, suscribirMs: 5000, deflate: false }))),
  bajo: [1.5, 1, 0.5].flatMap(mbps => (['escritorio', 'maximo'] as const).map(camara => ({ etiqueta: `${mbps}M-${camara}`, mbps, retardoMs: RTT_WAN, camara, suscribirMs: 0, deflate: false }))),
  estancamiento: [null, 10, 5, 2].map(mbps => ({ etiqueta: `${mbps ?? 'lan'}M-escritorio-estancado`, mbps, retardoMs: mbps === null ? 1 : RTT_WAN, camara: 'escritorio' as const, suscribirMs: 0, deflate: false })),
  deflate: [10, 5, 2, 1, 0.5].flatMap(mbps => (['escritorio', 'maximo'] as const).map(camara => ({
    etiqueta: `${mbps ?? 'lan'}M-${camara}-deflate`, mbps, retardoMs: mbps === null ? 1 : RTT_WAN, camara, suscribirMs: 0, deflate: true }))),
  latencia: [40, 75].flatMap(retardoMs => [10, 5].map(mbps => ({ etiqueta: `${mbps}M-escritorio-rtt${2 * retardoMs}`, mbps, retardoMs, camara: 'escritorio' as const, suscribirMs: 0, deflate: false }))),
};
const nombres = arg('escenarios', 'humo')!.split(',');
const escenarios = nombres.flatMap(n => { const l = lotes[n]; if (!l) throw new Error(`lote desconocido: ${n}`); return l; });

function sendQ(port: number, peers: Set<number>): number[] {
  try {
    const out = execFileSync('ss', ['-tnH', 'state', 'established', `( sport = :${port} )`], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean).map(l => l.trim().split(/\s+/)).filter(c => peers.has(Number(c[3]?.split(':').at(-1)))).map(c => Number(c[1]));
  } catch { return []; }
}
const q = (arr: number[], p: number) => arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))]! : null;

async function correr(e: Escenario) {
  const srv = e.deflate ? deflate : plano;
  if (!srv) throw new Error(`escenario ${e.etiqueta} pide servidor ${e.deflate ? 'deflate' : 'plano'}`);
  const mbps = e.mbps ?? 10_000;
  const enlace = new Enlace({ host: '127.0.0.1', port: srv.port }, { bajadaBps: mbps * 1e6, subidaBps: Math.max(1, mbps / 4) * 1e6, retardoMs: e.retardoMs, colaBytes: 256 * 1024 });
  const puerto = await enlace.abrir();
  const cam = CAMARAS[e.camara];
  const cliente = new Cliente({ puerto, host: srv.host, origin: srv.origin, cookie: srv.cookie, viewport: cam ? { x: 0, y: 0, ...cam } : null, suscribirMs: e.suscribirMs, etiqueta: e.etiqueta });
  const t0 = Date.now();
  cliente.start();
  const colas: number[] = [];
  const muestreo = setInterval(() => { for (const v of sendQ(srv.port, enlace.puertosHaciaServidor)) colas.push(v); }, 1000);
  await new Promise(yes => setTimeout(yes, duracionS * 1000));
  clearInterval(muestreo);
  const t1 = Date.now();
  const resumen = cliente.resumen(t1);
  cliente.stop();
  await enlace.cerrar();
  // Telemetría del servidor de ESTE escenario: sus puertos y su ventana de tiempo.
  const tel = readFileSync(srv.telemetry, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { t: number; ev: string; peer?: number; type?: string; bytes?: number; bufferedAmount?: number; sequence?: number; tickHz?: number; people?: number })
    .filter(x => x.t >= t0 && x.t <= t1 + 50);
  const mios = tel.filter(x => x.peer !== undefined && enlace.puertosHaciaServidor.has(x.peer));
  const envios = mios.filter(x => x.ev === 'send' && x.type === 'state');
  const drops = mios.filter(x => x.ev === 'drop');
  const cortes = mios.filter(x => x.ev === 'terminate');
  // Edad al llegar: por secuencia, la salida más reciente anterior a la llegada.
  const edades: number[] = [];
  for (const m of cliente.mensajes.filter(m => m.tipo === 'state')) {
    const salidaT = envios.filter(s => s.sequence === m.secuencia && s.t <= m.t).at(-1)?.t;
    if (salidaT !== undefined) edades.push(m.t - salidaT);
  }
  const runtime = tel.filter(x => x.ev === 'runtime');
  const r = {
    escenario: e, ...resumen,
    servidor: {
      statesIntentados: envios.length + drops.length, statesEnviados: envios.length, descartados: drops.length,
      pctDescartados: envios.length + drops.length ? 100 * drops.length / (envios.length + drops.length) : 0,
      cortes2MiB: cortes.length, cortesDetalle: cortes.map(c => ({ bufferedKiB: Math.round((c.bufferedAmount ?? 0) / 1024) })),
      bufferedKiB: { p50: (q(mios.filter(x => x.ev === 'send').map(x => x.bufferedAmount ?? 0), 0.5) ?? 0) / 1024, max: Math.max(0, ...mios.map(x => x.bufferedAmount ?? 0)) / 1024 },
      tickHz: q(runtime.map(x => x.tickHz ?? 0), 0.5), habitantes: runtime.at(-1)?.people,
    },
    kernelSendQKiB: { p50: (q(colas, 0.5) ?? 0) / 1024, max: Math.max(0, ...colas) / 1024 },
    edadStateMs: { p50: q(edades, 0.5), p95: q(edades, 0.95), max: edades.length ? Math.max(...edades) : null },
    enlace: { bajadaMiB: enlace.bajada.bytes / 1048576, maxColaKiB: enlace.bajada.maxCola / 1024, conexiones: enlace.conexiones },
    transiciones: cliente.transiciones.map(x => ({ s: (x.t - t0) / 1000, estado: x.estado, motivo: x.motivo })),
    eventos: cliente.eventos.map(x => ({ s: (x.t - t0) / 1000, ev: x.ev, detalle: x.detalle })),
    servidorEventos: mios.filter(x => x.ev !== 'send').map(x => ({ s: (x.t - t0) / 1000, ...x, t: undefined })),
  };
  writeFileSync(resolve(salida, `${e.etiqueta}.json`), JSON.stringify(r, null, 2));
  return r;
}

const resultados: Awaited<ReturnType<typeof correr>>[] = [];
for (let i = 0; i < escenarios.length; i += paralelo) {
  const lote = escenarios.slice(i, i + paralelo);
  process.stderr.write(`→ ${lote.map(e => e.etiqueta).join(', ')} (${duracionS} s)\n`);
  let congelado: NodeJS.Timeout | undefined;
  if (estancar) {
    const pid = pidDe(lote[0]!.deflate ? deflate!.port : plano.port);
    if (!pid) throw new Error('no encuentro el pid del servidor para --estancar');
    congelado = setTimeout(() => {
      process.stderr.write(`   SIGSTOP servidor ${pid} durante ${estancar[1]} s\n`);
      process.kill(pid, 'SIGSTOP');
      setTimeout(() => process.kill(pid, 'SIGCONT'), estancar[1] * 1000);
    }, estancar[0] * 1000);
  }
  resultados.push(...await Promise.all(lote.map(correr)));
  clearTimeout(congelado);
}
const f = (n: number | null | undefined, d = 0) => n === null || n === undefined ? '—' : n.toFixed(d);
const filas = resultados.map(r => `| ${r.etiqueta} | ${f(r.pctLive)} % | ${r.silencios8s} | ${r.reconexiones} | ${r.cierres.join(' ') || '—'} | ${f(r.statesPorS, 2)} | ${f(r.stateKiB.p50)} | ${f(r.gapMs.max)} | ${f(r.edadStateMs.p50)} / ${f(r.edadStateMs.max)} | ${r.servidor.descartados}/${r.servidor.statesIntentados} | ${r.servidor.cortes2MiB} | ${f(r.servidor.bufferedKiB.max)} | ${f(r.kernelSendQKiB.max)} | ${r.getWorld.map(g => `${g.ok ? '' : '✗'}${(g.ms / 1000).toFixed(1)}s`).join(' ')} |`);
const tabla = ['| escenario | live | silencios 8 s | reconexiones | cierres WS | states/s | state KiB p50 | hueco máx ms | edad state ms p50/máx | descartados/intentos | cortes >2 MiB | bufferedAmount máx KiB | Send-Q kernel máx KiB | GET /api/world |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|', ...filas].join('\n');
writeFileSync(resolve(salida, `tabla-${nombres.join('+')}.md`), tabla + '\n');
process.stdout.write(tabla + '\n');
