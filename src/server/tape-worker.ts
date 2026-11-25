import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { CINTA, type Apertura, type Corte, type Hito, type SeriePunto } from '../shared/cinta.js';
import { CONTROL_ENLACE_BYTES, enlaceCinta, type DescriptorEnlace, type EnlaceCinta } from '../shared/fotograma.js';
import type { WorldView } from '../shared/types.js';
import { EscritorCinta, PASO_MAXIMO, type OpcionesEscritor } from './cinta/escritor.js';

/** V24: the costly, slow-moving summaries of a view (each walks every tile or a whole catalogue). A turbo
 * frame between two live mirror posts may leave them out: this writer carries the previous frame's values,
 * so they (and the terrain) are SAMPLED at the mirror's cadence, ≤ `TURBO_MIRROR_MS` of wall time behind.
 * What must agree with the people of the same tick — communities, demography (deaths), places and
 * memories — is projected on every frame and never carried. */
export const CARRIED_VIEW_FIELDS = ['blueprints', 'stats', 'technology', 'organization', 'chemistry'] as const;
const carriedFields: ReadonlySet<string> = new Set(CARRIED_VIEW_FIELDS);
/** A carried frame completed with the previous frame's summaries, in the previous frame's key order. */
export function withCarriedFields(view: WorldView, previous: WorldView): WorldView {
  const current = view as unknown as Record<string, unknown>, before = previous as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(before)) {
    if (carriedFields.has(key)) out[key] = before[key];
    else if (key in current) out[key] = current[key];
  }
  for (const key of Object.keys(current)) if (!(key in out)) out[key] = current[key];
  return out as unknown as WorldView;
}

const CREDITOS_CORTES = 16;

export function crearEnlaceCortes(): DescriptorEnlace {
  // En ola 1 el crédito corresponde a un Corte en vuelo por el puerto. M6 añade las ranuras binarias.
  const descriptor = { control: new SharedArrayBuffer(CONTROL_ENLACE_BYTES), ranuras: [], sucesos: null };
  const enlace = enlaceCinta(descriptor);
  Atomics.store(enlace.creditos, 0, CREDITOS_CORTES);
  Atomics.store(enlace.cadencia, 0, CINTA.pasos[0]);
  return descriptor;
}

export function ajustarCadencia(enlace: EnlaceCinta, leidos: bigint, ahora: number, ultimoAtraso: number): number {
  const paso = Atomics.load(enlace.cadencia, 0);
  const atraso = Atomics.load(enlace.entregados, 0) - leidos;
  if (atraso > 8n) {
    Atomics.store(enlace.cadencia, 0, Math.min(PASO_MAXIMO, paso * 2));
    return ahora;
  }
  if (atraso === 0n && ahora - ultimoAtraso >= 2000 && paso > CINTA.pasos[0]) {
    Atomics.store(enlace.cadencia, 0, Math.max(CINTA.pasos[0], paso / 2));
    return ahora;
  }
  return ultimoAtraso;
}

export type TapeWorkerRequest = { type: 'abrir'; apertura: Apertura; hitosPrevios: readonly Hito[] } | { type: 'corte'; corte: Corte }
  | { type: 'serie'; epoca: number; punto: SeriePunto }
  | { type: 'flush' | 'close'; id: number };
export type TapeWorkerReply = { type: 'reply'; id: number; frames: number; latestTick: number };

if (!isMainThread && workerData?.role === 'carta-tape') {
  const port = parentPort!;
  const writer = new EscritorCinta(workerData.options as OpcionesEscritor);
  const enlace = enlaceCinta(workerData.descriptor as DescriptorEnlace);
  let leidos = 0n;
  let ultimoAtraso = performance.now();
  function ejecutar(accion: () => void): void {
    try {
      accion();
    } catch (error) {
      clearInterval(timer);
      try { writer.close(false); } catch { /* conserva el fallo original de la cinta */ }
      port.close();
      throw error;
    }
  }
  const timer = setInterval(() => ejecutar(() => {
    writer.flush();
    ultimoAtraso = ajustarCadencia(enlace, leidos, performance.now(), ultimoAtraso);
  }), 1000);
  // El orden FIFO publica la época después de los cortes viejos y antes de la nueva base.
  port.on('message', (message: TapeWorkerRequest) => ejecutar(() => {
    if (message.type === 'abrir') {
      writer.abrir(message.apertura, message.hitosPrevios);
      Atomics.store(enlace.cadencia, 0, CINTA.pasos[0]);
      ultimoAtraso = performance.now();
    } else if (message.type === 'corte') {
      ultimoAtraso = ajustarCadencia(enlace, leidos, performance.now(), ultimoAtraso);
      writer.registrar(message.corte);
      leidos++;
      Atomics.add(enlace.creditos, 0, 1);
    } else if (message.type === 'serie') {
      writer.registrarSerie(message.epoca, message.punto);
    } else {
      writer.flush();
      port.postMessage({ type: 'reply', id: message.id, ...writer.estado() } satisfies TapeWorkerReply);
      if (message.type === 'close') {
        clearInterval(timer);
        writer.close(false);
        port.close();
      }
    }
  }));
}
