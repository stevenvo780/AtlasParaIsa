import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { LectorCinta } from '../../src/server/cinta/lector.js';
import { CINTA, type ChunkReq, type ChunkResp, type Nivel } from '../../src/shared/cinta.js';
import { normalizeViewport } from '../../src/world/spatial.js';

const USO = 'Uso: node --import tsx scripts/lab/servir-demo.mts <cinta-exportada> [puerto=3130] [cliente-compilado=dist/client]';
const JSON_TYPE = 'application/json; charset=utf-8';
const MIMES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function entero(q: URLSearchParams, clave: string, minimo: number, maximo: number): number {
  const s = q.get(clave), n = Number(s);
  if (!s || !/^-?\d+$/.test(s) || !Number.isSafeInteger(n) || n < minimo || n > maximo) throw new Error(`Parámetro ${clave} inválido.`);
  return n;
}

function consulta(q: URLSearchParams): ChunkReq {
  const max = Number.MAX_SAFE_INTEGER;
  const nivel = q.get('nivel') ?? 'auto';
  if (!['auto', '0', '1', '2', '3', '4'].includes(nivel)) throw new Error('Nivel inválido.');
  const campos = ['x', 'y', 'w', 'h'];
  const camara = campos.some(k => q.has(k)) ? normalizeViewport({
    x: entero(q, 'x', -max, max), y: entero(q, 'y', -max, max),
    width: entero(q, 'w', 1, max), height: entero(q, 'h', 1, max),
  }) : undefined;
  return {
    t: entero(q, 't', 0, max), n: entero(q, 'n', 1, CINTA.maxFotogramas),
    nivel: nivel === 'auto' ? nivel : Number(nivel) as Nivel,
    ...(q.has('epoca') ? { epoca: entero(q, 'epoca', 0, max) } : {}),
    ...(camara ? { x: camara.x, y: camara.y, w: camara.width, h: camara.height } : {}),
  };
}

function responder(req: IncomingMessage, res: ServerResponse, status: number, mime: string, cuerpo: string | Buffer): void {
  res.writeHead(status, {
    'Content-Type': mime, 'Content-Length': Buffer.byteLength(cuerpo), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : cuerpo);
}

function abrirCliente(raiz: string, pathname: string): { mime: string; contenido: Buffer } | undefined {
  const relativa = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  if (relativa.includes('\0') || relativa.includes('\\')) return undefined;
  const ruta = resolve(raiz, '.' + relativa), mime = MIMES[extname(ruta)];
  if (!ruta.startsWith(raiz + sep) || !mime) return undefined;
  try {
    const real = realpathSync(ruta);
    if (!real.startsWith(raiz + sep) || !statSync(real).isFile()) return undefined;
    return { mime, contenido: readFileSync(real) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

function servir(directorio: string, puerto: number, cliente: string): void {
  const raiz = realpathSync(cliente);
  if (!abrirCliente(raiz, '/')) throw new Error('Falta el index.html del cliente compilado.');
  const manifiesto = JSON.parse(readFileSync(join(directorio, 'demo.json'), 'utf8')) as { version?: number; epoca?: number; t0?: number; t1?: number };
  const lector = new LectorCinta(directorio);
  try {
    const meta = lector.meta();
    if (manifiesto.version !== 1 || manifiesto.epoca !== meta.epoca || manifiesto.t0 !== meta.t0 || manifiesto.t1 !== meta.t1
      || meta.niveles.length !== 1 || meta.niveles[0]!.nivel !== 0 || meta.niveles[0]!.t1 !== meta.t1) {
      throw new Error('El manifiesto no coincide con una cinta de demo sellada.');
    }
    const cuerpoMeta = JSON.stringify(meta);
    const host = `127.0.0.1:${puerto}`;
    const origen = `http://${host}`;
    const server = createServer((req, res) => {
      const json = (status: number, cuerpo: unknown) => responder(req, res, status, JSON_TYPE, JSON.stringify(cuerpo));
      if (req.headers.host !== host) return json(400, { error: 'Usa la dirección local de la demo.' });
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return json(405, { error: 'La demo es de solo lectura.' });
      }
      let url: URL;
      try { url = new URL(req.url ?? '/', origen); }
      catch { return json(400, { error: 'URL inválida.' }); }
      if (url.origin !== origen) return json(400, { error: 'URL inválida.' });
      try {
        if (url.pathname === '/api/session') return json(200, { authenticated: true, tapeEnabled: true, observerOnly: true, archiveMode: true });
        if (url.pathname === '/api/cinta/meta') {
          if (!url.searchParams.has('t0') && !url.searchParams.has('t1')) return responder(req, res, 200, JSON_TYPE, cuerpoMeta);
          let t0: number | undefined, t1: number | undefined;
          try {
            if (url.searchParams.has('t0')) t0 = entero(url.searchParams, 't0', 0, Number.MAX_SAFE_INTEGER);
            if (url.searchParams.has('t1')) t1 = entero(url.searchParams, 't1', 0, Number.MAX_SAFE_INTEGER);
          } catch (error) { return json(400, { error: (error as Error).message }); }
          return json(200, { ...meta, serie: lector.meta({ t0, t1 }).serie });
        }
        if (url.pathname === '/api/cinta/chunk') {
          let pedido: ChunkReq;
          try { pedido = consulta(url.searchParams); }
          catch (error) { return json(400, { error: (error as Error).message }); }
          if (pedido.t < meta.t0 || pedido.t > meta.t1) {
            const nivel = pedido.nivel === 'auto' ? 0 : pedido.nivel ?? 0;
            return json(200, { nivel, paso: CINTA.pasos[nivel],
              epoca: pedido.epoca ?? meta.epoca, t0: pedido.t, t1: pedido.t, hayMas: false, deltas: [] } satisfies ChunkResp);
          }
          return responder(req, res, 200, JSON_TYPE, lector.chunk(pedido));
        }
        const estatico = abrirCliente(raiz, url.pathname);
        if (estatico) return responder(req, res, 200, estatico.mime, estatico.contenido);
        return json(404, { error: 'Ruta no encontrada.' });
      } catch (error) {
        if (error instanceof URIError) return json(400, { error: 'URL inválida.' });
        return json(500, { error: 'No se pudo leer la demo.' });
      }
    });
    server.once('close', () => lector.close());
    server.once('error', (error: Error) => { lector.close(); console.error(error.message); process.exitCode = 1; });
    process.once('SIGINT', () => server.close());
    process.once('SIGTERM', () => server.close());
    server.listen(puerto, '127.0.0.1', () => console.log(`${origen}/ · cinta ${meta.t0}–${meta.t1}`));
  } catch (error) { lector.close(); throw error; }
}

try {
  const [directorio, puerto = '3130', cliente = 'dist/client'] = process.argv.slice(2);
  if (!directorio || process.argv.length > 5 || !/^\d+$/.test(puerto)) throw new Error(USO);
  const n = Number(puerto);
  if (n < 1 || n > 65535) throw new Error('Puerto inválido.');
  servir(realpathSync(directorio), n, cliente);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
