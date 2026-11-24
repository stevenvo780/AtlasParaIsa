import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import type { ChunkReq, CintaMeta } from '../../shared/cinta.js';
import type { TapeChunkEncoding } from '../../shared/tape.js';
import type { Tile, Viewport } from '../../shared/types.js';
import { LectorCinta, type Fondo } from './lector.js';

export type PeticionCinta =
  | { tipo: 'meta'; t0?: number; t1?: number }
  | { tipo: 'chunk'; req: ChunkReq }
  | { tipo: 'meta-antigua' }
  | { tipo: 'chunk-antiguo'; fromTick: number; count: number; camara?: Viewport; encoding: TapeChunkEncoding };
/** Lo que solo sabe quien sirve: si el escritor dio la cinta por perdida y con qué semilla se genera el fondo. */
export interface ContextoCinta { gzip: boolean; estado: CintaMeta['estado']; fondo?: { seed: number; cuencas: number } }
export interface RespuestaCinta { cuerpo: Buffer; gzip: boolean }
export interface OpcionesLectores {
  directorio: string;
  /** `world.sqlite` del mundo: el fondo de la cámara lee de su archivo los chunks que la cinta no grabó. */
  mundo?: string;
  topeBytes: number;
  observerOnly: boolean;
  turbo: boolean;
  hilos?: number;
}

type Mensaje = { id: number; peticion: PeticionCinta; contexto: ContextoCinta };
type Respuesta = { id: number; cuerpo: Uint8Array; gzip: boolean } | { id: number; error: string };

/**
 * Piscina de hilos lectores: el hilo HTTP solo valida y escribe bytes. Cada petición va al hilo con menos trabajo,
 * así un tramo largo no retiene un `meta`; un hilo que cae rechaza lo suyo y se relanza en la petición siguiente.
 */
export class LectoresCinta {
  private readonly hilos: ({ worker: Worker; pendientes: Map<number, { resolve(r: RespuestaCinta): void; reject(e: Error): void }> } | undefined)[];
  private siguiente = 0;
  private cerrado = false;

  constructor(private readonly opciones: OpcionesLectores) {
    this.hilos = Array.from({ length: opciones.hilos ?? 2 }, () => undefined);
  }

  private lanzar(i: number) {
    let moduleURL = new URL('./lector-worker.js', import.meta.url);
    const sourceLoader = new URL(import.meta.url).pathname.endsWith('.ts');
    if (sourceLoader && !existsSync(moduleURL)) moduleURL = new URL('./lector-worker.ts', import.meta.url);
    const worker = new Worker(`
      const { workerData } = require('node:worker_threads');
      (async () => {
        if (workerData.loaderURL) (await import(workerData.loaderURL)).register();
        await import(workerData.moduleURL);
      })().catch(error => { setImmediate(() => { throw error; }); });
    `, { eval: true, execArgv: [], name: 'carta-lector', workerData: { role: 'carta-lector', moduleURL: moduleURL.href,
      loaderURL: sourceLoader ? import.meta.resolve('tsx/esm/api') : undefined, opciones: this.opciones } });
    const hilo = { worker, pendientes: new Map<number, { resolve(r: RespuestaCinta): void; reject(e: Error): void }>() };
    const caer = (error: Error) => {
      if (this.hilos[i] === hilo) this.hilos[i] = undefined;
      for (const p of hilo.pendientes.values()) p.reject(error);
      hilo.pendientes.clear();
    };
    worker.on('message', (r: Respuesta) => {
      const p = hilo.pendientes.get(r.id);
      if (!p) return;
      hilo.pendientes.delete(r.id);
      if (!hilo.pendientes.size) worker.unref();
      if ('error' in r) p.reject(new Error(r.error));
      else p.resolve({ cuerpo: Buffer.from(r.cuerpo.buffer, r.cuerpo.byteOffset, r.cuerpo.byteLength), gzip: r.gzip });
    });
    worker.on('error', caer);
    worker.on('exit', code => caer(new Error(`El lector de la cinta terminó (código ${code}).`)));
    // Un hilo ocioso no retiene el proceso; uno con peticiones sí, o la espera quedaría sin bucle que la resuelva.
    worker.unref();
    return this.hilos[i] = hilo;
  }

  leer(peticion: PeticionCinta, contexto: ContextoCinta): Promise<RespuestaCinta> {
    if (this.cerrado) return Promise.reject(new Error('Los lectores de la cinta están cerrados.'));
    let i = 0;
    for (let j = 1; j < this.hilos.length; j++) if ((this.hilos[j]?.pendientes.size ?? 0) < (this.hilos[i]?.pendientes.size ?? 0)) i = j;
    // Los hilos arrancan juntos: uno que nace para atender una petición tardaría lo que tarda en cargar.
    for (let j = 0; j < this.hilos.length; j++) if (!this.hilos[j]) this.lanzar(j);
    const hilo = this.hilos[i]!;
    const id = ++this.siguiente;
    return new Promise((resolve, reject) => {
      if (!hilo.pendientes.size) hilo.worker.ref();
      hilo.pendientes.set(id, { resolve, reject });
      hilo.worker.postMessage({ id, peticion, contexto } satisfies Mensaje);
    });
  }

  async close(): Promise<void> {
    this.cerrado = true;
    await Promise.all(this.hilos.map(h => h?.worker.terminate()));
  }
}

if (!isMainThread && workerData?.role === 'carta-lector') {
  const opciones = workerData.opciones as OpcionesLectores;
  const lector = new LectorCinta(opciones.directorio);
  // Con un mundo detrás, el reproductor siempre pide cámara: el fondo se carga al arrancar el hilo.
  let pintor = opciones.mundo ? crearPintor(opciones.mundo) : undefined;
  pintor?.catch(() => undefined); // el fallo llega a quien pida una cámara, no tumba el hilo
  const port = parentPort!;
  port.on('message', async ({ id, peticion: p, contexto: c }: Mensaje) => {
    try {
      let fondo: Fondo | undefined;
      if (c.fondo && (p.tipo === 'chunk' && p.req.w !== undefined || p.tipo === 'chunk-antiguo' && p.camara)) {
        fondo = (await (pintor ??= crearPintor(opciones.mundo)))(c.fondo.seed, c.fondo.cuencas);
      }
      const json = p.tipo === 'meta' ? JSON.stringify(lector.meta(p, c.estado, opciones.topeBytes))
        : p.tipo === 'chunk' ? lector.chunk(p.req, fondo)
          : p.tipo === 'meta-antigua' ? lector.metaAntigua(opciones)
            : lector.chunkAntiguo(p.fromTick, p.count, p.camara, p.encoding, fondo);
      const datos = c.gzip ? gzipSync(json, { level: 3 }) : Buffer.from(json);
      // Copia propia: un Buffer pequeño vive en la reserva compartida de Node y no se puede transferir.
      const cuerpo = new Uint8Array(datos.length);
      cuerpo.set(datos);
      port.postMessage({ id, cuerpo, gzip: c.gzip } satisfies Respuesta, [cuerpo.buffer]);
    } catch (error) {
      port.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies Respuesta);
    }
  });
}

/**
 * El fondo de la cámara como lo pinta la pasarela en vivo: chunk archivado o generado, ecosistema inicial y
 * proyección pública. Carga el mundo solo cuando alguien pide una cámara.
 */
async function crearPintor(mundo: string | undefined): Promise<(seed: number, cuencas: number) => Fondo> {
  const [{ CHUNK_SIZE, generateChunk }, { initializeEcosystem }, { projectMirrorTile }, { Store }] = await Promise.all([
    import('../../world/terrain.js'), import('../../world/ecosystem.js'), import('../sim-worker.js'), import('../store.js')]);
  type Chunk = ReturnType<typeof generateChunk>;
  let archivo: InstanceType<typeof Store> | undefined;
  if (mundo && existsSync(mundo)) try { archivo = new Store(mundo, { readOnly: true }); } catch { /* sin archivo, se genera */ }
  const generados = new Map<string, Chunk>();
  return (seed, cuencas) => {
    // Lo archivado puede cambiar entre peticiones; lo generado depende solo de la semilla.
    const chunks = new Map<string, Chunk>();
    return (x, y): Tile => {
      const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE), clave = `${cx},${cy}`;
      let chunk = chunks.get(clave);
      if (!chunk) {
        chunk = archivo?.loadChunk(clave) ?? undefined;
        if (!chunk) {
          const k = `${seed}:${cuencas}:${clave}`;
          chunk = generados.get(k) ?? generateChunk(seed, cx, cy, cuencas);
          generados.delete(k); generados.set(k, chunk);
          if (generados.size > 128) generados.delete(generados.keys().next().value!);
        }
        chunks.set(clave, chunk);
      }
      return projectMirrorTile(initializeEcosystem(seed, chunk.tiles[(y - cy * CHUNK_SIZE) * CHUNK_SIZE + x - cx * CHUNK_SIZE]!, cuencas));
    };
  };
}
