import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Side = 'baseline' | 'candidate';
export type Json = Record<string, any>;
export interface Source { root: string; sourceHash: string; fullHash: string; originSha: string; rootDirty: boolean }
export interface Checkpoint { tick: number; version: number; seed: number; digest: string; savedAt: number; params: Json }
export interface Original { id: string; side: Side; seed: number; output: string; status: string; result: Json | null; checkpoint?: Checkpoint; daily: { day: number; path: string; hash: string }[]; eligible: boolean; reason: string; processes: number[]; validComplete: boolean }
export interface Manifest {
  continuationSchema: 1; metricasVersion: 2; mode: 'production' | 'control'; createdAt: string; cutoff: string;
  directory: string; originalBatch: string; originalManifestHash: string; sources: Record<Side, Source>;
  instrumentRoot: string; instrumentHash: string; driverHash: string; loader: string;
  workers: number; timeoutMs: number; horizon: number; cadence: 20; diskBudgetBytes: number; reserveBytes: number;
  originals: Original[]; selected: string[]; scope: string;
}
export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8'));
export function canonical(value: any): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Non-finite evidence'); return Object.is(value, -0) ? '-0' : String(value); }
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
export const logicalHash = (value: any): string => hash(canonical(value));
export function atomicJson(path: string, value: unknown): void {
  writeFileSync(`${path}.next`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(`${path}.next`, path);
}
export function files(root: string, prefix: string): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) return files(root, path);
    if (!entry.isFile()) throw new Error(`Unsupported source entry: ${path}`);
    return [path];
  });
}
export function fileSetHash(root: string, paths: string[]): string {
  const h = createHash('sha256'); for (const path of paths) h.update(path).update('\0').update(readFileSync(join(root, path))); return h.digest('hex');
}
export const driverHash = (root: string): string => fileSetHash(root, readdirSync(root).filter(p => p.endsWith('.ts')).sort());
export function verifySources(manifest: Pick<Manifest, 'sources' | 'instrumentRoot' | 'instrumentHash'>): void {
  for (const source of Object.values(manifest.sources)) {
    const sourceHash = fileSetHash(source.root, ['src/world', 'src/server', 'src/shared'].flatMap(folder => readdirSync(join(source.root, folder)).filter(p => p.endsWith('.ts')).sort().map(p => `${folder}/${p}`)));
    if (sourceHash !== source.sourceHash || fileSetHash(source.root, ['package.json', ...files(source.root, 'src')]) !== source.fullHash) throw new Error('Frozen source hash changed');
  }
  const h = createHash('sha256'); for (const path of ['scripts/lab/coherence.ts','scripts/lab/metrics.ts']) h.update(readFileSync(join(manifest.instrumentRoot,path)));
  if (h.digest('hex') !== manifest.instrumentHash) throw new Error('Frozen instrument hash changed');
}
export function readCheckpoint(db: DatabaseSync): Checkpoint {
  const row = db.prepare('SELECT body,digest,saved_at FROM snapshots WHERE slot=0').get() as { body: string; digest: string; saved_at: number } | undefined;
  if (!row || hash(row.body) !== row.digest) throw new Error('Slot 0 missing or checksum invalid');
  const body = JSON.parse(row.body);
  if (!Number.isSafeInteger(body.tick) || body.tick < 0 || !Number.isSafeInteger(body.seed)) throw new Error('Invalid checkpoint identity');
  return { tick: body.tick, version: body.version, seed: body.seed, digest: row.digest, savedAt: row.saved_at, params: body.params ?? {} };
}
export function sameCheckpoint(actual: Checkpoint, expected: Checkpoint): void {
  if (logicalHash(actual) !== logicalHash(expected)) throw new Error('Checkpoint changed since the frozen census');
}
export function completedCheckpoint(db: DatabaseSync, expected: Checkpoint, horizon: number): Checkpoint {
  const actual = readCheckpoint(db);
  if (actual.tick !== horizon || actual.seed !== expected.seed || actual.version !== expected.version
      || logicalHash(actual.params) !== logicalHash(expected.params)) throw new Error('Final durable checkpoint does not match the admitted trajectory');
  return actual;
}
export function copyCheckpoint(source: string, target: string, expected: Checkpoint): string {
  const db = new DatabaseSync(source, { readOnly: true });
  try { sameCheckpoint(readCheckpoint(db), expected); db.prepare('VACUUM INTO ?').run(target); sameCheckpoint(readCheckpoint(db), expected); }
  finally { db.close(); }
  const copied = new DatabaseSync(target, { readOnly: true });
  try {
    if (copied.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') throw new Error('Copied database quick_check failed');
    sameCheckpoint(readCheckpoint(copied), expected);
  } finally { copied.close(); }
  chmodSync(target, 0o400); return hash(readFileSync(target));
}
export function exactLoaded(loaded: any, expected: Checkpoint, before: any, beforeParams: any, afterParams: any): void {
  if (!loaded || loaded.slot !== 0 || loaded.skipped.length || loaded.world.tick !== expected.tick || loaded.world.version !== expected.version || loaded.world.seed !== expected.seed)
    throw new Error('Missing, migrated or rewound checkpoint refused');
  if (logicalHash({ world: before, params: beforeParams }) !== logicalHash({ world: loaded.world, params: afterParams })) throw new Error('Store.load changed resident state or parameters');
}
export function nextWindow(tick: number, horizon = 72000): { day: number; after: number; end: number; steps: number } {
  if (!Number.isSafeInteger(tick) || tick < 0 || tick >= horizon || horizon % 2400 !== 0) throw new Error('Invalid absolute horizon');
  const day = Math.floor(tick / 2400) + 1, after = (day - 1) * 2400, end = Math.min(horizon, day * 2400);
  return { day, after, end, steps: end - tick };
}
export function validateDays(days: { day: number; record: Json }[], tick: number): { missingBoundary: boolean } {
  const complete = Math.floor(tick / 2400), sorted = [...days].sort((a,b) => a.day-b.day);
  if (sorted.length > complete) throw new Error('Daily record beyond checkpoint');
  for (let i=0;i<sorted.length;i++) {
    const { day, record } = sorted[i]!;
    if (day !== i+1 || record.day !== day || record.tick !== day*2400 || record.activity?.ventanaActividad?.desdeTickExclusivo !== (day-1)*2400 || record.activity?.ventanaActividad?.hastaTickInclusivo !== day*2400) throw new Error('Missing or invalid absolute daily window');
  }
  const missingBoundary = sorted.length === complete-1 && tick % 2400 === 0;
  if (sorted.length !== complete && !missingBoundary) throw new Error('Historical daily endpoint cannot be reconstructed');
  return { missingBoundary };
}
export function below(parent: string, path: string): void {
  const rel = relative(resolve(parent), resolve(path)); if (!rel || rel.startsWith('..') || rel.startsWith('/')) throw new Error('Output escapes its owned directory');
}
export function directoryBytes(path: string): number {
  let size = 0; for (const entry of readdirSync(path)) { const child=join(path,entry), stat=lstatSync(child); if(stat.isSymbolicLink()) continue; size += stat.isDirectory() ? directoryBytes(child) : stat.size; } return size;
}
export function storageCheck(manifest: Pick<Manifest,'directory'|'diskBudgetBytes'|'reserveBytes'>, extraBytes=0): void {
  const disk = statfsSync(manifest.directory);
  if (disk.bavail * disk.bsize - extraBytes < manifest.reserveBytes || directoryBytes(manifest.directory) + extraBytes > manifest.diskBudgetBytes) throw new Error('storage_budget: evidence ceiling or free-space reserve reached');
}
export function copyEvidence(source: string, target: string, expectedHash: string): void {
  if(hash(readFileSync(source))!==expectedHash) throw new Error('Historical evidence changed');
  mkdirSync(dirname(target),{recursive:true,mode:0o700}); copyFileSync(source,target); chmodSync(target,0o400);
}
