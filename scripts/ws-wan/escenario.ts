/** UN escenario del banco WS-WAN en su propio proceso (los globales del navegador de
 * `navegador-node.ts` son del proceso: una página por proceso). Lo lanza `banco.ts`.
 *
 *   npx tsx scripts/ws-wan/escenario.ts '<json: {servidor, escenario, duracionS, salida, cliente}>'
 *
 * Une tres miradas: cliente (real o emulado), telemetría JSONL del servidor (`servidor.ts`) y Send-Q
 * del kernel del servidor (`ss`). Escribe `<salida>/<etiqueta>.json` e imprime el mismo JSON. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Enlace } from './enlace.js';
import { Cliente, type Viewport } from './cliente.js';
import { ClienteReal } from './cliente-real.js';

export interface Servidor { port: number; origin: string; host: string; cookie: string; people: number; tick: number; deflate: boolean; telemetry: string }
export interface Escenario { etiqueta: string; mbps: number | null; retardoMs: number; camara: string; suscribirMs: number; deflate: boolean }
/** Pantallas (Landscape.reportViewport: ancho = ceil(cssW/zoom)+6, alto = ceil(cssH/zoom)+6,
 * zoom 32 si cssW ≥ 600, si no 24; tope 96×64). */
export const CAMARAS: Record<string, Omit<Viewport, 'x' | 'y'> | null> = {
  'sin-camara': null,
  movil: { width: 23, height: 38 },
  portatil: { width: 49, height: 27 },
  escritorio: { width: 66, height: 37 },
  maximo: { width: 96, height: 64 },
};

const { servidor: srv, escenario: e, duracionS, salida, cliente: tipoCliente } = JSON.parse(process.argv[2]!) as { servidor: Servidor; escenario: Escenario; duracionS: number; salida: string; cliente: 'real' | 'emulado' };

function sendQ(port: number, peers: Set<number>): number[] {
  try {
    const out = execFileSync('ss', ['-tnH', 'state', 'established', `( sport = :${port} )`], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean).map(l => l.trim().split(/\s+/)).filter(c => peers.has(Number(c[3]?.split(':').at(-1)))).map(c => Number(c[1]));
  } catch { return []; }
}
const q = (arr: number[], p: number) => arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))]! : null;

const mbps = e.mbps ?? 10_000;
const enlace = new Enlace({ host: '127.0.0.1', port: srv.port }, { bajadaBps: mbps * 1e6, subidaBps: Math.max(1, mbps / 4) * 1e6, retardoMs: e.retardoMs, colaBytes: 256 * 1024 });
const puerto = await enlace.abrir();
const cam = CAMARAS[e.camara];
const opciones = { puerto, host: srv.host, origin: srv.origin, cookie: srv.cookie, viewport: cam ? { x: 0, y: 0, ...cam } : null, suscribirMs: e.suscribirMs, etiqueta: e.etiqueta };
const cliente = tipoCliente === 'real' ? new ClienteReal(opciones) : new Cliente(opciones);
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
type Tel = { t: number; ev: string; peer?: number; type?: string; bytes?: number; bufferedAmount?: number; sequence?: number; tickHz?: number; people?: number; stepMs?: number; p95StepMs?: number; broadcastMs?: number;
  conexiones?: { remotePort: number | null; acuse: boolean; enviados: number; aplazados: number; acuses: number; ultimoAcuseMs: number | null; bufferedAmount: number }[] };
const tel = readFileSync(srv.telemetry, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Tel).filter(x => x.t >= t0 && x.t <= t1 + 50);
const mios = tel.filter(x => x.peer !== undefined && enlace.puertosHaciaServidor.has(x.peer));
const envios = mios.filter(x => x.ev === 'send' && x.type === 'state');
const drops = mios.filter(x => x.ev === 'drop');
const cortes = mios.filter(x => x.ev === 'terminate');
// Contrapresión (servidor nuevo): el último registro de cada socket propio.
const flujoPorSocket = new Map<number, NonNullable<Tel['conexiones']>[number]>();
const acuseMs: number[] = [];
for (const x of tel.filter(x => x.ev === 'flujo')) for (const c of x.conexiones ?? []) if (c.remotePort !== null && enlace.puertosHaciaServidor.has(c.remotePort)) {
  const previo = flujoPorSocket.get(c.remotePort);
  if (c.ultimoAcuseMs !== null && c.acuses !== previo?.acuses) acuseMs.push(c.ultimoAcuseMs);
  flujoPorSocket.set(c.remotePort, c);
}
const flujo = [...flujoPorSocket.values()];
// Edad al llegar: por secuencia, la salida más reciente anterior a la llegada.
const edades: number[] = [];
for (const m of cliente.mensajes.filter(m => m.tipo === 'state')) {
  const salidaT = envios.filter(s => s.sequence === m.secuencia && s.t <= m.t).at(-1)?.t;
  if (salidaT !== undefined) edades.push(m.t - salidaT);
}
const runtime = tel.filter(x => x.ev === 'runtime');
const r = {
  escenario: e, cliente: tipoCliente, ...resumen,
  servidor: {
    statesIntentados: envios.length + drops.length, statesEnviados: envios.length, descartados: drops.length,
    pctDescartados: envios.length + drops.length ? 100 * drops.length / (envios.length + drops.length) : 0,
    aplazados: flujo.reduce((s, c) => s + c.aplazados, 0), acuses: flujo.reduce((s, c) => s + c.acuses, 0), conAcuse: flujo.some(c => c.acuse),
    acuseMs: { p50: q(acuseMs, 0.5), max: acuseMs.length ? Math.max(...acuseMs) : null },
    cortes2MiB: cortes.length, cortesDetalle: cortes.map(c => ({ bufferedKiB: Math.round((c.bufferedAmount ?? 0) / 1024), by: (c as { by?: string }).by })),
    bufferedKiB: { p50: (q(mios.filter(x => x.ev === 'send').map(x => x.bufferedAmount ?? 0), 0.5) ?? 0) / 1024, max: Math.max(0, ...mios.map(x => x.bufferedAmount ?? 0)) / 1024 },
    tickHz: q(runtime.map(x => x.tickHz ?? 0), 0.5), habitantes: runtime.at(-1)?.people,
    p95StepMs: q(runtime.map(x => x.p95StepMs ?? 0), 0.5), broadcastMs: q(runtime.map(x => x.broadcastMs ?? 0), 0.5),
  },
  kernelSendQKiB: { p50: (q(colas, 0.5) ?? 0) / 1024, max: Math.max(0, ...colas) / 1024 },
  edadStateMs: { p50: q(edades, 0.5), p95: q(edades, 0.95), max: edades.length ? Math.max(...edades) : null },
  enlace: { bajadaMiB: enlace.bajada.bytes / 1048576, bajadaMbps: enlace.bajada.bytes * 8 / ((t1 - t0) / 1000) / 1e6, maxColaKiB: enlace.bajada.maxCola / 1024, conexiones: enlace.conexiones },
  transiciones: cliente.transiciones.map(x => ({ s: (x.t - t0) / 1000, estado: x.estado, motivo: x.motivo })),
  eventos: cliente.eventos.map(x => ({ s: (x.t - t0) / 1000, ev: x.ev, detalle: x.detalle })),
  servidorEventos: mios.filter(x => x.ev !== 'send').map(x => ({ s: (x.t - t0) / 1000, ...x, t: undefined })),
};
writeFileSync(resolve(salida, `${e.etiqueta}.json`), JSON.stringify(r, null, 2));
process.stdout.write(JSON.stringify(r) + '\n');
process.exit(0);
