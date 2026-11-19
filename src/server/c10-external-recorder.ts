import { mkdirSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { stable, type ExternalCapture } from './c10-process-host.js';
export function externalRecorder(directory: string, retainInitial: (ref: string) => void) {
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  const artifacts: { kind: string; path: string; ref: string }[] = []; const events: unknown[] = [];
  let initialRef = '';
  function write(path: string, raw: string) {
    writeFileSync(join(directory, path), raw, { mode: 0o600, flag: 'wx' });
    const fd = openSync(join(directory, path), 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    const dir = openSync(directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  const capture: ExternalCapture = { append(kind, data) {
    const row = { ...(data as Record<string, unknown>), externalObservationRef: randomUUID() };
    const raw = stable(row); const ref = createHash('sha256').update(raw).digest('hex');
    const path = `${artifacts.length}.json`; write(path, raw);
    artifacts.push({ kind, path, ref });
    if (kind === 'source-tap') {
      // v7 rows carry only source ops since the previous checkpoint; events are rebuilt by the independent reader from (path, seq).
      const tap = row as unknown as { protocol: string; operation: string; seq: number };
      if (tap.protocol !== 'c10-source-observer/v7') throw new Error('source-tap protocol');
      if (tap.operation === 'initial') { initialRef = ref; retainInitial(ref); } // BEFORE first begin
      if (tap.operation === 'emit') events.push({ path, seq: tap.seq, ref });
    }
    return ref;
  } };
  return { capture, artifacts, finish(dependencyManifest: string, dependencySHA256: string, sourceProof: string) {
    const raw = stable({ schema: 'c10-process-capture/v5', tapProtocol: 'c10-source-observer/v7', initialRef, artifacts, events,
      dependencyManifest, dependencySHA256, sourceProof }); write('index.json', raw);
    return { initialRef, indexSHA256: createHash('sha256').update(raw).digest('hex') };
  } };
}
