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
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Escenario, Servidor } from './escenario.js';

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : 'true';
};
const leerServidor = (path?: string): Servidor | null => path ? JSON.parse(readFileSync(path, 'utf8').trim().split('\n').at(-1)!) as Servidor : null;
const plano = leerServidor(arg('servidor'));
const deflate = leerServidor(arg('servidor-deflate'));
if (!plano) throw new Error('--servidor <fichero con la línea JSON de servidor.ts>');
const duracionS = Number(arg('duracion', '120'));
const paralelo = Number(arg('paralelo', '3'));
const salida = resolve(arg('salida', '/datos/tmp-atlas-lab/wsfix/banco')!);
/** `real` (defecto): el cliente de `src/client/connection.ts` sin tocar, un proceso por escenario.
 * `emulado`: el emulador del diagnóstico (`cliente.ts`, el cliente anterior a la contrapresión). */
const tipoCliente = arg('cliente', 'real') as 'real' | 'emulado';
/** `--estancar 30@12`: a los 30 s de cada tanda se congela el proceso servidor 12 s (SIGSTOP/SIGCONT),
 * como un bucle de eventos bloqueado por un guardado lento o por falta de CPU (SCHED_IDLE). */
const estancar = arg('estancar')?.split('@').map(Number) as [number, number] | undefined;
function pidDe(port: number): number | null {
  try { const out = execFileSync('ss', ['-tlnpH', `( sport = :${port} )`], { encoding: 'utf8' }); return Number(/pid=(\d+)/.exec(out)?.[1] ?? NaN) || null; } catch { return null; }
}
mkdirSync(salida, { recursive: true });
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

type Resultado = { etiqueta: string; cliente: string; pctLive: number; silencios8s: number; reconexiones: number; cierres: number[]; statesPorS: number; stateKiB: { p50: number };
  gapMs: { max: number | null }; huecoMarcoMaxMs?: number; edadStateMs: { p50: number | null; max: number | null };
  servidor: { descartados: number; statesIntentados: number; aplazados: number; cortes2MiB: number; bufferedKiB: { max: number } };
  kernelSendQKiB: { max: number }; enlace: { bajadaMbps: number }; getWorld: { ms: number; ok: boolean }[] };
/** Un proceso por escenario: los globales del navegador (`navegador-node.ts`) son del proceso. */
function correr(e: Escenario): Promise<Resultado> {
  const srv = e.deflate ? deflate : plano;
  if (!srv) throw new Error(`escenario ${e.etiqueta} pide servidor ${e.deflate ? 'deflate' : 'plano'}`);
  return new Promise((yes, no) => {
    const hijo = spawn(process.execPath, [...process.execArgv, resolve(import.meta.dirname, 'escenario.ts'), JSON.stringify({ servidor: srv, escenario: e, duracionS, salida, cliente: tipoCliente })], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    hijo.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    hijo.on('error', no);
    hijo.on('close', code => {
      const linea = out.trim().split('\n').at(-1);
      if (code !== 0 || !linea) { no(new Error(`escenario ${e.etiqueta} terminó con ${code}`)); return; }
      yes(JSON.parse(linea) as Resultado);
    });
  });
}

const resultados: Resultado[] = [];
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
const filas = resultados.map(r => `| ${r.etiqueta} | ${f(r.pctLive)} % | ${r.silencios8s} | ${r.reconexiones} | ${r.cierres.join(' ') || '—'} | ${f(r.statesPorS, 2)} | ${f(r.stateKiB.p50)} | ${f(r.gapMs.max)} | ${f(r.huecoMarcoMaxMs)} | ${f(r.edadStateMs.p50)} / ${f(r.edadStateMs.max)} | ${r.servidor.descartados}/${r.servidor.statesIntentados} · ${r.servidor.aplazados ?? 0} | ${r.servidor.cortes2MiB} | ${f(r.servidor.bufferedKiB.max)} | ${f(r.kernelSendQKiB.max)} | ${f(r.enlace.bajadaMbps, 2)} | ${r.getWorld.map(g => `${g.ok ? '' : '✗'}${(g.ms / 1000).toFixed(1)}s`).join(' ')} |`);
const tabla = [`Cliente: ${tipoCliente}.`, '', '| escenario | live | silencios 8 s | reconexiones | cierres WS | states/s | state KiB p50 | hueco máx entre states ms | hueco máx entre marcos ms | edad state ms p50/máx | descartados/intentos · aplazados | cortes (terminate) | bufferedAmount máx KiB | Send-Q kernel máx KiB | enlace Mbit/s | GET /api/world |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|', ...filas].join('\n');
writeFileSync(resolve(salida, `tabla-${nombres.join('+')}.md`), tabla + '\n');
process.stdout.write(tabla + '\n');
