/** The sole DVR writer: compression, JSON copies, diffing and SQLite stay on this thread. */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { TapeWriter } from './tape-store.js';
import type { TapeWriterOptions } from '../shared/tape.js';
import type { WorldView } from '../shared/types.js';

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

export type TapeWorkerRequest =
  /** `carried`: the view leaves out `CARRIED_VIEW_FIELDS`; they are the previous frame's. */
  | { type: 'record'; view: WorldView; simHz: number; partialTiles: boolean; carried?: true }
  | { type: 'flush' | 'close'; id: number };
export type TapeWorkerReply =
  | { type: 'ack' }
  | { type: 'reply'; id: number; frames: number; latestTick: number };

if (!isMainThread && workerData?.role === 'carta-tape') {
  const port = parentPort!;
  const writer = new TapeWriter(workerData.options as TapeWriterOptions);
  let previous: WorldView | undefined;
  // MessagePort preserves FIFO: a flush/close is a barrier behind every submitted frame.
  port.on('message', (message: TapeWorkerRequest) => {
    try {
      if (message.type === 'record') {
        if (message.carried && !previous) throw new Error('A carried tape frame needs a previous frame.');
        const view = message.carried ? withCarriedFields(message.view, previous!) : message.view;
        // The structured clone is this thread's own copy: the writer normalizes it instead of copying it.
        writer.record(view, message.simHz, message.partialTiles, true);
        previous = view;
        port.postMessage({ type: 'ack' } satisfies TapeWorkerReply);
      } else {
        if (message.type === 'close') writer.close();
        else writer.flush();
        port.postMessage({ type: 'reply', id: message.id, frames: writer.frameCount,
          latestTick: writer.latestTick } satisfies TapeWorkerReply);
        if (message.type === 'close') port.close();
      }
    } catch (error) {
      try { writer.close(); } finally { port.close(); }
      throw error;
    }
  });
}
