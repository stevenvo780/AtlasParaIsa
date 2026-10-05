import { openSync, writeSync, fsyncSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ObservationEvent } from '../world/observation.js';
import type { PassiveCaptureSink } from './c10-native-commit-caller.js';

/** Fresh independent directory; fsync is for evidence bytes, not SQLite.
 * Partial writes/failures poison ingestion permanently. No World/census writes. */
export function createFsyncSidecar(directory: string): PassiveCaptureSink & { close(): void; status(): unknown } {
  mkdirSync(directory, { mode: 0o700 }); // exclusive directory, no recursive reuse
  const events = openSync(join(directory, 'independent-bus-tap.jsonl'), 'wx', 0o600);
  const signals = openSync(join(directory, 'store-commit-signals.jsonl'), 'wx', 0o600);
  const status = openSync(join(directory, 'capture-status.jsonl'), 'wx', 0o600);
  const dir = openSync(directory, 'r');
  fsyncSync(dir);
  const pins = new Map<string, string>();
  let failed = false, closed = false;
  function append(fd: number, value: unknown): void {
    if (closed || failed) throw new Error('sidecar-unavailable');
    try {
      const raw = Buffer.from(JSON.stringify(value) + '\n');
      let offset = 0;
      while (offset < raw.length) { const n = writeSync(fd, raw, offset, raw.length - offset); if (n <= 0) throw new Error('short-write'); offset += n; }
      fsyncSync(fd);
    } catch (error) { failed = true; throw error; }
  }
  return {
    appendSourceEvent(event: ObservationEvent) {
      const pin = createHash('sha256').update(JSON.stringify(event)).digest('hex');
      const prior = pins.get(event.sourceEventId);
      if (prior) { if (prior !== pin) { failed = true; throw new Error('duplicate-event-payload'); } return; }
      append(events, event); pins.set(event.sourceEventId, pin);
    },
    appendSignal(signal) { append(signals, signal); },
    unknown(reason) { if (!failed && !closed) append(status, { state: 'UNKNOWN', ingestionAllowed: false, reason }); },
    status() { return { state: 'UNKNOWN', ingestionAllowed: false, sidecarFailed: failed, capturedEvents: pins.size }; },
    close() { if (closed) return; closed = true; for (const fd of [events, signals, status, dir]) { try { fsyncSync(fd); } catch { failed = true; } finally { try { closeSync(fd); } catch { failed = true; } } } },
  };
}
