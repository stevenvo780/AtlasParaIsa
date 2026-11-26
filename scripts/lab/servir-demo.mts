import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { CINTA, type ChunkReq, type ChunkResp, type Nivel } from '../../src/shared/cinta.js';
import type { WorldView } from '../../src/shared/types.js';
import { normalizeViewport } from '../../src/world/spatial.js';

const USO = 'Uso: node --import tsx scripts/lab/servir-demo.mts <directorio-de-demo> [puerto=3130] [cliente-compilado=dist/client]';
const JSON_TYPE = 'application/json; charset=utf-8';
const MIMES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

interface RespuestaApi { status: number; cuerpo: string | Buffer }
interface Demo {
  descripcion: string;
  api(url: URL): RespuestaApi | undefined;
  cerrar?(): void;
}

interface LoteCorte { id: string; sustancia: string; masaKg: number }
interface Corte {
  tick: number;
  slot: number;
  pavimento: number;
  lotes: LoteCorte[];
  digest: string;
  digestGuardado: string;
}

function json(status: number, cuerpo: unknown): RespuestaApi {
  return { status, cuerpo: JSON.stringify(cuerpo) };
}

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

function objeto(valor: unknown): valor is Record<string, unknown> {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor);
}

function huella(valor: unknown): valor is string {
  return typeof valor === 'string' && /^[a-f0-9]{64}$/.test(valor);
}

function esLote(valor: unknown): valor is LoteCorte {
  return objeto(valor) && typeof valor.id === 'string' && /^\d+$/.test(valor.id)
    && typeof valor.sustancia === 'string' && valor.sustancia.trim().length > 0
    && typeof valor.masaKg === 'number' && Number.isFinite(valor.masaKg) && valor.masaKg > 0;
}

function esCorte(valor: unknown): valor is Corte {
  return objeto(valor) && typeof valor.tick === 'number' && Number.isSafeInteger(valor.tick) && valor.tick >= 0
    && (valor.slot === 0 || valor.slot === 1 || valor.slot === 2)
    && typeof valor.pavimento === 'number' && valor.pavimento >= 0 && valor.pavimento <= 1
    && huella(valor.digest) && huella(valor.digestGuardado)
    && Array.isArray(valor.lotes) && valor.lotes.every(esLote)
    && new Set(valor.lotes.map(lote => lote.id)).size === valor.lotes.length;
}

function leerCorte(raiz: string, nombre: string): Buffer {
  const real = realpathSync(join(raiz, nombre));
  if (!real.startsWith(raiz + sep) || !statSync(real).isFile()) throw new Error(`Archivo inválido: ${nombre}.`);
  return readFileSync(real);
}

function verificarVista(cuerpo: Buffer, corte: Corte, x: number, y: number): void {
  if (createHash('sha256').update(cuerpo).digest('hex') !== corte.digest) {
    throw new Error(`La huella del corte ${corte.tick} no coincide.`);
  }
  const vista = JSON.parse(cuerpo.toString('utf8')) as WorldView | null;
  if (vista?.tick !== corte.tick || !Array.isArray(vista.tiles)) throw new Error(`Vista inválida para el corte ${corte.tick}.`);

  const foco = vista.tiles.filter(tile => tile?.x === x && tile.y === y);
  if (foco.length !== 1 || foco[0]!.paved !== corte.pavimento) {
    throw new Error(`El pavimento del foco no coincide en el corte ${corte.tick}.`);
  }
  if (!corte.lotes.length) return;
  if (!Array.isArray(vista.lotes) || !Array.isArray(vista.sustancias)) {
    throw new Error(`Faltan los lotes o su catálogo en el corte ${corte.tick}.`);
  }
  const catalogo = new Set(vista.sustancias.map(sustancia => sustancia?.id));
  const piezas = vista.lotes.filter(lote => lote?.rol === 'pieza' && lote.x === x && lote.y === y && catalogo.has(lote.principal));
  for (const lote of corte.lotes) {
    const indice = piezas.findIndex(pieza => pieza.masa === lote.masaKg);
    if (indice < 0) throw new Error(`La masa de un lote del foco no coincide en el corte ${corte.tick}.`);
    piezas.splice(indice, 1);
  }
}

function abrirCortes(directorio: string): Demo {
  const manifiesto: unknown = JSON.parse(leerCorte(directorio, 'cortes.json').toString('utf8'));
  if (!objeto(manifiesto) || manifiesto.version !== 1 || !huella(manifiesto.fuenteSha256)
    || !objeto(manifiesto.foco) || typeof manifiesto.foco.x !== 'number' || !Number.isSafeInteger(manifiesto.foco.x)
    || typeof manifiesto.foco.y !== 'number' || !Number.isSafeInteger(manifiesto.foco.y)
    || !Array.isArray(manifiesto.cortes) || manifiesto.cortes.length !== 2) {
    throw new Error('El manifiesto de cortes es inválido.');
  }
  const { x, y } = manifiesto.foco;
  const [antes, despues] = manifiesto.cortes;
  if (!esCorte(antes) || !esCorte(despues) || antes.tick >= despues.tick || antes.slot === despues.slot) {
    throw new Error('El manifiesto debe contener dos cortes ordenados de distintos slots.');
  }
  const rutas = new Map<string, RespuestaApi>();
  rutas.set('/api/session', json(200, { authenticated: true, observerOnly: true, archiveMode: true, archiveCuts: true }));
  rutas.set('/api/cortes', json(200, { version: 1, foco: { x, y }, cortes: [antes, despues], fuenteSha256: manifiesto.fuenteSha256 }));
  for (const corte of [antes, despues]) {
    const cuerpo = leerCorte(directorio, `${corte.tick}.json`);
    verificarVista(cuerpo, corte, x, y);
    rutas.set(`/api/cortes/${corte.tick}`, { status: 200, cuerpo });
  }
  return { descripcion: `cortes ${antes.tick} y ${despues.tick}`, api: url => rutas.get(url.pathname) };
}

async function abrirCinta(directorio: string): Promise<Demo> {
  const manifiesto = JSON.parse(readFileSync(join(directorio, 'demo.json'), 'utf8')) as { version?: number; epoca?: number; t0?: number; t1?: number };
  const { LectorCinta } = await import('../../src/server/cinta/lector.js');
  const lector = new LectorCinta(directorio);
  try {
    const meta = lector.meta();
    if (manifiesto.version !== 1 || manifiesto.epoca !== meta.epoca || manifiesto.t0 !== meta.t0 || manifiesto.t1 !== meta.t1
      || meta.niveles.length !== 1 || meta.niveles[0]!.nivel !== 0 || meta.niveles[0]!.t1 !== meta.t1) {
      throw new Error('El manifiesto no coincide con una cinta de demo sellada.');
    }
    const respuestaMeta = json(200, meta);
    const sesion = json(200, { authenticated: true, tapeEnabled: true, observerOnly: true, archiveMode: true });
    return {
      descripcion: `cinta ${meta.t0}–${meta.t1}`,
      cerrar: () => lector.close(),
      api(url) {
        if (url.pathname === '/api/session') return sesion;
        if (url.pathname === '/api/cinta/meta') {
          if (!url.searchParams.has('t0') && !url.searchParams.has('t1')) return respuestaMeta;
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
          return { status: 200, cuerpo: lector.chunk(pedido) };
        }
        return undefined;
      },
    };
  } catch (error) { lector.close(); throw error; }
}

async function servir(directorio: string, puerto: number, cliente: string): Promise<void> {
  const raiz = realpathSync(cliente);
  if (!abrirCliente(raiz, '/')) throw new Error('Falta el index.html del cliente compilado.');
  const demo = existsSync(join(directorio, 'cortes.json')) ? abrirCortes(directorio) : await abrirCinta(directorio);
  try {
    const host = `127.0.0.1:${puerto}`;
    const origen = `http://${host}`;
    const server = createServer((req, res) => {
      const responderApi = ({ status, cuerpo }: RespuestaApi) => responder(req, res, status, JSON_TYPE, cuerpo);
      if (req.headers.host !== host) return responderApi(json(400, { error: 'Usa la dirección local de la demo.' }));
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return responderApi(json(405, { error: 'La demo es de solo lectura.' }));
      }
      let url: URL;
      try { url = new URL(req.url ?? '/', origen); }
      catch { return responderApi(json(400, { error: 'URL inválida.' })); }
      if (url.origin !== origen) return responderApi(json(400, { error: 'URL inválida.' }));
      try {
        const respuesta = demo.api(url);
        if (respuesta) return responderApi(respuesta);
        const estatico = abrirCliente(raiz, url.pathname);
        if (estatico) return responder(req, res, 200, estatico.mime, estatico.contenido);
        return responderApi(json(404, { error: 'Ruta no encontrada.' }));
      } catch (error) {
        if (error instanceof URIError) return responderApi(json(400, { error: 'URL inválida.' }));
        return responderApi(json(500, { error: 'No se pudo leer la demo.' }));
      }
    });
    server.once('close', () => demo.cerrar?.());
    server.once('error', (error: Error) => { demo.cerrar?.(); console.error(error.message); process.exitCode = 1; });
    process.once('SIGINT', () => server.close());
    process.once('SIGTERM', () => server.close());
    server.listen(puerto, '127.0.0.1', () => console.log(`${origen}/ · ${demo.descripcion}`));
  } catch (error) { demo.cerrar?.(); throw error; }
}

try {
  const [directorio, puerto = '3130', cliente = 'dist/client'] = process.argv.slice(2);
  if (!directorio || process.argv.length > 5 || !/^\d+$/.test(puerto)) throw new Error(USO);
  const n = Number(puerto);
  if (n < 1 || n > 65535) throw new Error('Puerto inválido.');
  await servir(realpathSync(directorio), n, cliente);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
