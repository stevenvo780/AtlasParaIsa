import { createHash } from 'node:crypto';
import { closeSync, openSync, writeSync, fsyncSync } from 'node:fs';
import type { DecisionObservationV1 } from '../../../src/world/index.js';

export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export interface Binding {
  version: 1; dataKind: 'NATIVE' | 'SYNTHETIC'; pairId: string; runId: string; pairedRunId: string; arm: 'CTRL' | 'PLAC';
  seed: number; initialHash: string; paramsHash: string; runtimeHash: string;
  sourceSHA: string; worldSourceHash: string; harnessHash: string; preregSHA: string;
  firstTick: 1; endTick: number; lowerInclusive: 4807;
}
/** Only projections are retained. Unchanged NO_DECISION states are carried forward;
 * thirst at suppressed gates is explicitly UNKNOWN, never reconstructed. */
export class FirstFlipObserver {
  private fd: number;
  private seq = 0;
  private tick = 0;
  private expected = 0;
  private ids: string[] = [];
  private changes: unknown[] = [];
  private commits: unknown[] = [];
  private cache = new Map<string, string>();
  private current = new Map<string, string>();
  private totalGates = 0;
  private totalDecisions = 0;
  private windows = 0;
  private fault = false;
  private closed = false;
  constructor(path: string, readonly binding: Binding) {
    this.fd = openSync(path, 'wx', 0o600); // Never overwrite or resume an old stream.
    this.append({ kind: 'header', ...binding, fieldCoverage: { gate:'ALL_ACTUAL_ITERATIONS',
      prePost:'ACTION_TARGET_DECISION_AT', thirstBits:'COMMIT_ONLY', selectedScoreBits:'COMMIT_ONLY',
      candidateCount:'COMMIT_ONLY', reasonHash:'UNKNOWN_NOT_EXPORTED', sourceOrdinal:'ACTUAL_ITERATION' } });
  }
  private append(record: object): void {
    const bytes = Buffer.from(JSON.stringify({ ...record, seq: ++this.seq }) + '\n');
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset, bytes.length - offset);
  }
  readonly observe = (dto: DecisionObservationV1): void => {
    try { this.accept(dto); } catch (error) { this.fault = true; throw error; }
  };
  private accept(dto: DecisionObservationV1): void {
    if (!Object.isFrozen(dto)) throw new Error('Unfrozen DTO');
    if (dto.kind === 'gate' || dto.kind === 'commit') {
      if (![dto.pre,dto.post,dto.pre.target,dto.post.target].every(Object.isFrozen)) throw new Error('Unfrozen projection');
      if (dto.kind === 'commit' && !Object.isFrozen(dto.selectedTarget)) throw new Error('Unfrozen selected target');
    }
    if (this.closed || this.fault) throw new Error('Invalid observer lifecycle');
    if (dto.kind === 'begin') {
      if (this.tick !== 0 || dto.tick !== this.windows + 1) throw new Error('Missing tick window');
      this.tick = dto.tick; this.expected = dto.expected;
      this.ids = []; this.changes = []; this.commits = []; this.current.clear();
      return;
    }
    if (dto.tick !== this.tick) throw new Error('Event outside actual iteration window');
    if (dto.kind === 'commit') {
      if (dto.ordinal !== this.ids.length + 1) throw new Error('Commit order');
      this.commits.push(dto); this.totalDecisions++; return;
    }
    if (dto.kind === 'gate') {
      if (dto.ordinal !== this.ids.length + 1 || this.current.has(dto.id)) throw new Error('Gate order/duplicate');
      this.ids.push(dto.id); this.totalGates++;
      const projection = { id: dto.id, ordinal: dto.ordinal, eligible: dto.eligible, path: dto.path,
        pre: { ...dto.pre, thirstBits: 'UNKNOWN' }, post: { ...dto.post, thirstBits: 'UNKNOWN' } };
      const serialized = JSON.stringify(projection);
      this.current.set(dto.id, serialized);
      if (dto.eligible || this.cache.get(dto.id) !== serialized) this.changes.push(projection);
      return;
    }
    if (dto.visited !== this.ids.length || dto.visited !== this.expected) throw new Error('Incomplete actual iterations');
    const removed = [...this.cache.keys()].filter(id => !this.current.has(id));
    this.append({ kind: 'window', tick: this.tick, expected: this.expected, visited: dto.visited,
      rosterHash: hash(JSON.stringify(this.ids)), changes: this.changes, commits: this.commits, removed,
      gateTotal: this.totalGates, decisionTotal: this.totalDecisions });
    this.cache = new Map(this.current); this.windows++; this.tick = 0;
  }
  finish(hookFault: boolean, receipt: unknown): void {
    if (this.closed) throw new Error('Already closed');
    try {
      this.append({ kind: 'footer', complete: !this.fault && !hookFault && this.tick === 0 && this.windows === this.binding.endTick,
        windows: this.windows, gateTotal: this.totalGates, decisionTotal: this.totalDecisions, receipt });
      fsyncSync(this.fd);
    } finally { closeSync(this.fd); this.closed = true; }
  }
}
