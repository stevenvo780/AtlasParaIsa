/**
 * PERF3 — sondas de E/S contra `es-servidor.ts`, desde otro proceso (verificación del planificador, 2026-09-23).
 *
 *   TMPDIR=/datos/tmp-atlas-lab npx tsx scripts/perf/es-sonda.ts --info info.json [--segundos 30] [--rtt 0]
 *       [--salida s.json]
 *
 * A la vez, durante `--segundos`:
 * · un cliente WS con acuse y cámara de 96×64 (el `state` más grande) que acusa cada `state` y hace ping cada
 *   250 ms: latencia del pong (`ws` lo encola detrás del deflate en curso), intervalo entre `state` y lo que
 *   tardan en llegar sus trozos;
 * · una cadena de solicitudes HTTP, una tras otra: `/health`, `/api/world` con gzip, sin gzip y un login
 *   (su cuerpo se lee por el poll), y 200 ms de pausa.
 * `--rtt R` espera R ms antes de cada solicitud de la cadena, como un cliente remoto cuya siguiente solicitud
 * llega un viaje de ida y vuelta después de la respuesta anterior; el tiempo medido no incluye esa espera.
 * Con el cliente en la misma máquina (R 0) la cadena cabe entera en los 100 ms ociosos que la base dejaba
 * tras un paso largo: eso favorece a la base frente a lo que ve un cliente por el dominio.
 */
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';

const arg = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag); return index === -1 ? undefined : process.argv[index + 1];
};
const { port, cookie, password } = JSON.parse(readFileSync(arg('--info')!, 'utf8')) as { port: number; cookie: string; password: string };
const segundos = Number(arg('--segundos') ?? 30), rtt = Number(arg('--rtt') ?? 0), salida = arg('--salida');
const origin = `http://127.0.0.1:${port}`;
const cuantil = (xs: number[], q: number): number => {
  const o = [...xs].sort((a, b) => a - b);
  return o.length ? Math.round(o[Math.min(o.length - 1, Math.floor(o.length * q))]! * 10) / 10 : NaN;
};
const resumen = (xs: number[]) => ({ n: xs.length, p50: cuantil(xs, 0.5), p95: cuantil(xs, 0.95), max: cuantil(xs, 1) });
const esperar = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const health: number[] = [], mundoGzip: number[] = [], mundoPlano: number[] = [], login: number[] = [], pong: number[] = [];
const entreEstados: number[] = [], trozosMs: number[] = [], trozosPorEstado: number[] = [];
const fin = performance.now() + segundos * 1000, camara = 'x=-48&y=-32&width=96&height=64';

const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws?ack=1&${camara}`, { headers: { Origin: origin, Cookie: cookie } });
let ultimo = 0, esperados = 0, inicio = 0, partes: string[] = [];
function recibido(texto: string) {
  const mensaje = JSON.parse(texto) as { world: { sequence: number } }, ahora = performance.now();
  if (ultimo) entreEstados.push(ahora - ultimo);
  ultimo = ahora;
  ws.send(JSON.stringify({ type: 'ack', sequence: mensaje.world.sequence }));
}
ws.on('message', (data: Buffer) => {
  const texto = data.toString();
  if (esperados > 0) {
    partes.push(texto);
    if (partes.length === esperados) {
      trozosMs.push(performance.now() - inicio); trozosPorEstado.push(esperados); esperados = 0; recibido(partes.join(''));
    }
    return;
  }
  const mensaje = JSON.parse(texto) as { type: string; partes?: number };
  if (mensaje.type === 'trozos') { esperados = mensaje.partes!; inicio = performance.now(); partes = []; }
  else if (mensaje.type === 'state') recibido(texto);
});
await once(ws, 'open');

async function medir(lista: number[], url: string, init?: RequestInit) {
  await esperar(rtt);
  const desde = performance.now();
  await (await fetch(origin + url, init)).arrayBuffer();
  lista.push(performance.now() - desde);
}
const pings = (async () => {
  while (performance.now() < fin) {
    const desde = performance.now(); ws.ping(); await once(ws, 'pong'); pong.push(performance.now() - desde);
    await esperar(250);
  }
})();
const cadena = (async () => {
  while (performance.now() < fin) {
    await medir(health, '/health');
    await medir(mundoGzip, `/api/world?${camara}`, { headers: { Cookie: cookie, 'Accept-Encoding': 'gzip' } });
    await medir(mundoPlano, `/api/world?${camara}`, { headers: { Cookie: cookie, 'Accept-Encoding': 'identity' } });
    // Una clave de límite distinta por intento: el cupo de 6 logins por minuto y clave no debe entrar en la medida.
    await medir(login, '/api/login', { method: 'POST', body: JSON.stringify({ password }),
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${login.length % 250}` } });
    await esperar(200);
  }
})();
await Promise.all([pings, cadena]);
const resultado = { rtt, health: resumen(health), mundoGzip: resumen(mundoGzip), mundoPlano: resumen(mundoPlano), login: resumen(login),
  wsPong: resumen(pong), wsEntreEstados: resumen(entreEstados), wsTrozos: resumen(trozosMs), trozosPorEstado: resumen(trozosPorEstado) };
console.log(JSON.stringify(resultado));
if (salida) writeFileSync(salida, JSON.stringify(resultado, null, 1) + '\n');
ws.terminate(); process.exit(0);
