/** The sole DVR writer: compression, JSON copies, diffing and SQLite stay on this thread. */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { TapeWriter } from './tape-store.js';
import type { TapeWriterOptions } from '../shared/tape.js';
import type { WorldView } from '../shared/types.js';

export type TapeWorkerRequest =
  | { type: 'record'; view: WorldView; simHz: number; partialTiles: boolean }
  | { type: 'flush' | 'close'; id: number };
export type TapeWorkerReply =
  | { type: 'ack' }
  | { type: 'reply'; id: number; frames: number; latestTick: number };

if (!isMainThread && workerData?.role === 'carta-tape') {
  const port = parentPort!;
  const writer = new TapeWriter(workerData.options as TapeWriterOptions);
  // MessagePort preserves FIFO: a flush/close is a barrier behind every submitted frame.
  port.on('message', (message: TapeWorkerRequest) => {
    try {
      if (message.type === 'record') {
        writer.record(message.view, message.simHz, message.partialTiles);
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
