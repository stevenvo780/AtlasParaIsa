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
/**
 * Lo que solo sabe quien sirve: si el escritor dio la cinta por perdida, de qué instancia del mundo es la cinta que
 * vale (otra se lee como vacía) y con qué semilla se genera el fondo.
 */
export interface ContextoCinta { gzip: boolean; estado: CintaMeta['estado']; instancia?: string; fondo?: { seed: number; cuencas: number } }
export interface RespuestaCinta { cuerpo: Buffer; gzip: boolean }
export interface OpcionesLectores {
  directorio: string;
  /** `world.sqlite` del mundo: el fondo de la cámara lee de su archivo los chunks que la cinta no grabó. */
  mundo?: string;
  topeBytes: number;
  observerOnly: boolean;
  turbo: boolean;
  /** Hilos para los tramos; los metadatos tienen uno aparte. */
  hilos?: number;
}

/** Peticiones que esperan hilo, por clase: más allá se responde que la cinta está ocupada. */
export const MAX_ESPERA = 32;

type Mensaje = { id: number; peticion: PeticionCinta; contexto: ContextoCinta };
type Respuesta = { id: number; cuerpo: Uint8Array; gzip: boolean } | { id: number; error: string };
interface Trabajo { mensaje: Mensaje; resolve(r: RespuestaCinta): void; reject(e: Error): void; soltar(): void }
interface Hilo { worker: Worker; trabajo?: Trabajo }

const esMeta = (p: PeticionCinta): boolean => p.tipo === 'meta' || p.tipo === 'meta-antigua';
const abortado = (): Error => Object.assign(new Error('La petición de la cinta se canceló.'), { name: 'AbortError' });

/**
 * Hilos lectores: el hilo HTTP solo valida y escribe bytes. Los metadatos van a un hilo propio, así un salto nunca los
 * retiene; los tramos, a los demás, de uno en uno por hilo y en orden de llegada. Lo que espera es acotado y se retira
 * si el cliente cierra antes (arrastrar el cabezal cancela los saltos anteriores). Un hilo que cae rechaza lo suyo y
 * se relanza para lo que espera.
 */
export class LectoresCinta {
  /** [0] metadatos; el resto, tramos. */
  private readonly hilos: (Hilo | undefined)[];
  private readonly colas: [Trabajo[], Trabajo[]] = [[], []];
  private siguiente = 0;
  private cerrado = false;

  constructor(private readonly opciones: OpcionesLectores) {
    this.hilos = Array.from({ length: 1 + (opciones.hilos ?? 2) }, () => undefined);
  }

  private lanzar(i: number): Hilo {
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
      loaderURL: sourceLoader ? import.meta.resolve('tsx/esm/api') : undefined, opciones: this.opciones, metadatos: i === 0 } });
    const hilo: Hilo = { worker };
    const caer = (error: Error) => {
      if (this.hilos[i] !== hilo) return;
      this.hilos[i] = undefined;
      hilo.trabajo?.reject(error);
      hilo.trabajo = undefined;
      this.despachar();
    };
    worker.on('message', (r: Respuesta) => {
      const t = hilo.trabajo;
      if (!t || t.mensaje.id !== r.id) return;
      hilo.trabajo = undefined;
      if ('error' in r) t.reject(new Error(r.error));
      else t.resolve({ cuerpo: Buffer.from(r.cuerpo.buffer, r.cuerpo.byteOffset, r.cuerpo.byteLength), gzip: r.gzip });
      this.despachar();
    });
    worker.on('error', caer);
    worker.on('exit', code => caer(new Error(`El lector de la cinta terminó (código ${code}).`)));
    // Un hilo ocioso no retiene el proceso; uno con trabajo sí, o la espera quedaría sin bucle que la resuelva.
    worker.unref();
    return this.hilos[i] = hilo;
  }

  private despachar(): void {
    if (this.cerrado) return;
    this.hilos.forEach((h, i) => {
      const cola = this.colas[i ? 1 : 0];
      if (h?.trabajo) return;
      if (!cola.length) { h?.worker.unref(); return; }
      const hilo = h ?? this.lanzar(i), t = cola.shift()!;
      hilo.trabajo = t;
      hilo.worker.ref();
      hilo.worker.postMessage(t.mensaje);
    });
  }

  leer(peticion: PeticionCinta, contexto: ContextoCinta, senal?: AbortSignal): Promise<RespuestaCinta> {
    if (this.cerrado) return Promise.reject(new Error('Los lectores de la cinta están cerrados.'));
    if (senal?.aborted) return Promise.reject(abortado());
    const cola = this.colas[esMeta(peticion) ? 0 : 1];
    if (cola.length >= MAX_ESPERA) return Promise.reject(new Error('La cinta tiene demasiadas peticiones en espera.'));
    // Los hilos arrancan juntos: uno que nace para atender una petición tardaría lo que tarda en cargar.
    this.hilos.forEach((h, i) => { if (!h) this.lanzar(i); });
    return new Promise((resolve, reject) => {
      const quitar = () => {
        const i = cola.indexOf(t);
        if (i >= 0) { cola.splice(i, 1); reject(abortado()); }
      };
      const t: Trabajo = { mensaje: { id: ++this.siguiente, peticion, contexto },
        resolve: r => { t.soltar(); resolve(r); }, reject: e => { t.soltar(); reject(e); },
        soltar: () => senal?.removeEventListener('abort', quitar) };
      senal?.addEventListener('abort', quitar, { once: true });
      cola.push(t);
      this.despachar();
    });
  }

  async close(): Promise<void> {
    this.cerrado = true;
    for (const cola of this.colas) for (const t of cola.splice(0)) t.reject(new Error('Los lectores de la cinta están cerrados.'));
    await Promise.all(this.hilos.map(h => h?.worker.terminate()));
  }
}

if (!isMainThread && workerData?.role === 'carta-lector') {
  const opciones = workerData.opciones as OpcionesLectores;
  const lector = new LectorCinta(opciones.directorio);
  // Con un mundo detrás, el reproductor siempre pide cámara: el fondo se carga al arrancar el hilo de tramos.
  let pintor = opciones.mundo && !workerData.metadatos ? crearPintor(opciones.mundo) : undefined;
  pintor?.catch(() => undefined); // el fallo llega a quien pida una cámara, no tumba el hilo
  const port = parentPort!;
  port.on('message', async ({ id, peticion: p, contexto: c }: Mensaje) => {
    try {
      let fondo: Fondo | undefined;
      if (c.fondo && (p.tipo === 'chunk' && p.req.w !== undefined || p.tipo === 'chunk-antiguo' && p.camara)) {
        fondo = (await (pintor ??= crearPintor(opciones.mundo)))(c.fondo.seed, c.fondo.cuencas);
      }
      const json = p.tipo === 'meta' ? JSON.stringify(lector.meta(p, c.estado, opciones.topeBytes, c.instancia))
        : p.tipo === 'chunk' ? lector.chunk(p.req, fondo, c.instancia)
          : p.tipo === 'meta-antigua' ? lector.metaAntigua(opciones, c.instancia)
            : lector.chunkAntiguo(p.fromTick, p.count, p.camara, p.encoding, fondo, c.instancia);
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
 * proyección pública. Del archivo se toma la versión de ese tick, nunca una posterior; sin ella, el terreno generado.
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
    return (x, y, t): Tile => {
      const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE), clave = `${cx},${cy}`;
      let chunk = chunks.get(`${clave}@${t}`);
      if (!chunk) {
        chunk = archivo?.loadChunk(clave, t) ?? undefined;
        if (!chunk) {
          const k = `${seed}:${cuencas}:${clave}`;
          chunk = generados.get(k) ?? generateChunk(seed, cx, cy, cuencas);
          generados.delete(k); generados.set(k, chunk);
          if (generados.size > 128) generados.delete(generados.keys().next().value!);
        }
        chunks.set(`${clave}@${t}`, chunk);
      }
      return projectMirrorTile(initializeEcosystem(seed, chunk.tiles[(y - cy * CHUNK_SIZE) * CHUNK_SIZE + x - cx * CHUNK_SIZE]!, cuencas));
    };
  };
}
