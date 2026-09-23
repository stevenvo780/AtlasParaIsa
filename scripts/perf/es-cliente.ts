/**
 * PERF3 — un cliente como el del navegador contra `es-servidor.ts` (verificación del planificador, 2026-09-23).
 *
 *   TMPDIR=/datos/tmp-atlas-lab npx tsx scripts/perf/es-cliente.ts --info info.json [--segundos 90] [--salida c.json]
 *
 * Como `src/client/connection.ts`: `GET /api/world` con gzip y el mismo aborto a los 10 s, y después un WS con
 * acuse que acusa cada `state`, sin pings propios. Si el WS se cierra, vuelve a empezar. Anota cuánto tardó cada
 * `GET` (o si se abortó), los cierres, los silencios de más de 8 s (los que el cliente muestra como «sin
 * conexión») y el silencio más largo.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';

const arg = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag); return index === -1 ? undefined : process.argv[index + 1];
};
const { port, cookie } = JSON.parse(readFileSync(arg('--info')!, 'utf8')) as { port: number; cookie: string };
const segundos = Number(arg('--segundos') ?? 90), salida = arg('--salida'), origin = `http://127.0.0.1:${port}`;
const fin = performance.now() + segundos * 1000, t0 = performance.now();
const r = { getWorld: [] as string[], cierres: [] as string[], silenciosMas8s: 0, maxSilencioMs: 0, estados: 0 };
while (performance.now() < fin) {
  const desde = performance.now();
  try {
    const respuesta = await fetch(origin + '/api/world', { headers: { Cookie: cookie, 'Accept-Encoding': 'gzip' },
      signal: AbortSignal.timeout(10_000) });
    await respuesta.arrayBuffer();
    r.getWorld.push(`${respuesta.status}:${Math.round(performance.now() - desde)}ms`);
  } catch { r.getWorld.push(`abortado:${Math.round(performance.now() - desde)}ms`); continue; }
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws?ack=1`, { headers: { Origin: origin, Cookie: cookie } });
  let ultimo = performance.now(), esperados = 0, partes: string[] = [];
  const reloj = setInterval(() => { r.maxSilencioMs = Math.max(r.maxSilencioMs, Math.round(performance.now() - ultimo)); }, 100);
  const acusar = (texto: string) => {
    const mensaje = JSON.parse(texto) as { world: { sequence: number } };
    r.estados++; ws.send(JSON.stringify({ type: 'ack', sequence: mensaje.world.sequence }));
  };
  ws.on('message', (data: Buffer) => {
    if (performance.now() - ultimo > 8000) r.silenciosMas8s++;
    ultimo = performance.now();
    const texto = data.toString();
    if (esperados > 0) {
      partes.push(texto);
      if (partes.length === esperados) { esperados = 0; acusar(partes.join('')); }
      return;
    }
    const mensaje = JSON.parse(texto) as { type: string; partes?: number };
    if (mensaje.type === 'trozos') { esperados = mensaje.partes!; partes = []; }
    else if (mensaje.type === 'state') acusar(texto);
  });
  const abierto = performance.now();
  const cerrado = new Promise<number>(resolve => ws.on('close', code => resolve(code)));
  const codigo = await Promise.race([cerrado,
    new Promise<number>(resolve => setTimeout(() => resolve(-1), Math.max(0, fin - performance.now())))]);
  clearInterval(reloj);
  if (codigo !== -1) r.cierres.push(`${codigo} tras ${Math.round((performance.now() - abierto) / 1000)} s`);
  ws.terminate();
}
const resultado = { segundos: Math.round((performance.now() - t0) / 1000), ...r };
console.log(JSON.stringify(resultado));
if (salida) writeFileSync(salida, JSON.stringify(resultado, null, 1) + '\n');
process.exit(0);
