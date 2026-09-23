/** El cliente REAL (dist/client, Chromium de Playwright) contra la instancia propia, a través de
 * un `Enlace` limitado: lo que de verdad pide y recibe el navegador, y cuánto tiempo muestra
 * «Sin conexión». Chromium resuelve `atlas-wan.test` al puerto del enlace (host-resolver-rules),
 * así el Host y el Origin son los que espera el servidor; la cookie de sesión se inyecta.
 *
 * Uso: npx tsx scripts/ws-wan/navegador.ts --servidor <json> --mbps 5 --retardo 90 \
 *        --pantalla 1920x969 [--movil] [--duracion 90] [--salida <dir>]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { Enlace } from './enlace.js';

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : 'true';
};
const srv = JSON.parse(readFileSync(arg('servidor')!, 'utf8').trim().split('\n').at(-1)!) as { port: number; host: string; origin: string; cookie: string };
const mbpsArg = arg('mbps', 'lan')!;
const mbps = mbpsArg === 'lan' ? null : Number(mbpsArg);
const retardoMs = Number(arg('retardo', mbps === null ? '1' : '90'));
const [w, h] = arg('pantalla', '1920x969')!.split('x').map(Number) as [number, number];
const movil = arg('movil') === 'true';
const duracionS = Number(arg('duracion', '90'));
const salida = resolve(arg('salida', '/datos/tmp-atlas-lab/wsfix/navegador')!);
mkdirSync(salida, { recursive: true });
const etiqueta = `nav-${mbpsArg}M-${w}x${h}${movil ? '-movil' : ''}`;

const enlace = new Enlace({ host: '127.0.0.1', port: srv.port }, { bajadaBps: (mbps ?? 10_000) * 1e6, subidaBps: Math.max(1, (mbps ?? 10_000) / 4) * 1e6, retardoMs, colaBytes: 256 * 1024 });
const puerto = await enlace.abrir();
const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${srv.host} 127.0.0.1:${puerto}`, '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: w, height: h }, ...(movil ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
const [name, value] = srv.cookie.split('=') as [string, string];
await context.addCookies([{ name, value, domain: srv.host, path: '/', httpOnly: true, sameSite: 'Strict' }]);
const page = await context.newPage();
const t0 = Date.now();
const frames: { t: number; dir: 'out' | 'in'; bytes: number; tipo: string; detalle?: unknown }[] = [];
const sockets: { t: number; ev: string }[] = [];
const http: { t: number; url: string; status?: number; ms?: number; fallo?: string }[] = [];
page.on('websocket', ws => {
  sockets.push({ t: Date.now(), ev: 'abre' });
  ws.on('framesent', f => { const s = String(f.payload); let d: unknown; try { d = JSON.parse(s); } catch { d = s.slice(0, 80); } frames.push({ t: Date.now(), dir: 'out', bytes: Buffer.byteLength(s), tipo: (d as { type?: string })?.type ?? '?', detalle: d }); });
  ws.on('framereceived', f => { const s = String(f.payload); frames.push({ t: Date.now(), dir: 'in', bytes: Buffer.byteLength(s), tipo: /^\{"type":"([a-z]+)"/.exec(s)?.[1] ?? '?' }); });
  ws.on('close', () => sockets.push({ t: Date.now(), ev: 'cierra' }));
  ws.on('socketerror', e => sockets.push({ t: Date.now(), ev: `error ${e}` }));
});
const inicios = new Map<object, number>();
page.on('request', r => { if (r.url().includes('/api/')) inicios.set(r, Date.now()); });
page.on('requestfinished', async r => { if (!r.url().includes('/api/')) return; const resp = await r.response(); http.push({ t: inicios.get(r) ?? 0, url: r.url().replace(/^https?:\/\/[^/]+/, ''), status: resp?.status(), ms: Date.now() - (inicios.get(r) ?? Date.now()) }); });
page.on('requestfailed', r => { if (!r.url().includes('/api/')) return; http.push({ t: inicios.get(r) ?? 0, url: r.url().replace(/^https?:\/\/[^/]+/, ''), fallo: r.failure()?.errorText, ms: Date.now() - (inicios.get(r) ?? Date.now()) }); });
await page.goto(`${srv.origin}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(e => sockets.push({ t: Date.now(), ev: `goto: ${e}` }));
// Muestrea el aviso de conexión cada 250 ms: es lo que Steven ve.
const avisos: { t: number; texto: string }[] = [];
let ultimo = '';
const fin = t0 + duracionS * 1000;
while (Date.now() < fin) {
  const texto = await page.evaluate(() => { const n = document.getElementById('connection-notice'); return !n ? '(sin interfaz)' : n.hidden ? 'live' : (n.textContent ?? '').slice(0, 40); }).catch(() => '(error)');
  if (texto !== ultimo) { avisos.push({ t: Date.now(), texto }); ultimo = texto; }
  await new Promise(y => setTimeout(y, 250));
}
const tFin = Date.now();
await browser.close(); await enlace.cerrar();
const tiempo: Record<string, number> = {};
for (let i = 0; i < avisos.length; i++) { const a = avisos[i]!, b = avisos[i + 1]; const k = a.texto.startsWith('Sin conexión') ? 'sin-conexion' : a.texto.startsWith('Conectando') ? 'conectando' : a.texto; tiempo[k] = (tiempo[k] ?? 0) + ((b?.t ?? tFin) - a.t); }
const entrada = frames.filter(f => f.dir === 'in' && f.tipo === 'state');
const viewports = frames.filter(f => f.dir === 'out').map(f => ({ s: (f.t - t0) / 1000, tipo: f.tipo, detalle: f.detalle }));
const resumen = {
  etiqueta, mbps, retardoMs, pantalla: `${w}x${h}`, movil, duracionS: (tFin - t0) / 1000,
  pctPorAviso: Object.fromEntries(Object.entries(tiempo).map(([k, v]) => [k, Math.round(1000 * v / (tFin - t0)) / 10])),
  wsAbiertos: sockets.filter(s => s.ev === 'abre').length, wsCerrados: sockets.filter(s => s.ev === 'cierra').length,
  statesRecibidos: entrada.length, statesPorS: entrada.length / ((tFin - t0) / 1000),
  stateKiBp50: entrada.length ? [...entrada].sort((a, b) => a.bytes - b.bytes)[Math.floor(entrada.length / 2)]!.bytes / 1024 : null,
  stateKiBmax: entrada.length ? Math.max(...entrada.map(f => f.bytes)) / 1024 : null,
  primerosStatesKiB: entrada.slice(0, 4).map(f => Math.round(f.bytes / 1024)),
  enviados: viewports.slice(0, 12), totalEnviados: viewports.length,
  enviadosPorTipo: Object.fromEntries([...new Set(viewports.map(v => v.tipo))].map(t => [t, viewports.filter(v => v.tipo === t).length])),
  entrantesPorTipo: Object.fromEntries([...new Set(frames.filter(f => f.dir === 'in').map(f => f.tipo))].map(t => { const fs = frames.filter(f => f.dir === 'in' && f.tipo === t); return [t, { n: fs.length, KiB: Math.round(fs.reduce((a, f) => a + f.bytes, 0) / 1024) }]; })),
  http: http.map(x => ({ s: (x.t - t0) / 1000, url: x.url, status: x.status, ms: x.ms, fallo: x.fallo })),
  avisos: avisos.map(a => ({ s: (a.t - t0) / 1000, texto: a.texto })),
  sockets: sockets.map(s => ({ s: (s.t - t0) / 1000, ev: s.ev })),
  enlaceMiB: enlace.bajada.bytes / 1048576,
};
writeFileSync(resolve(salida, `${etiqueta}.json`), JSON.stringify(resumen, null, 2));
process.stdout.write(JSON.stringify({ ...resumen, avisos: resumen.avisos.slice(0, 30), http: resumen.http.slice(0, 20) }, null, 1) + '\n');
