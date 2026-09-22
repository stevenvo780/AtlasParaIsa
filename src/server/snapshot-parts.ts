import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Tile } from '../shared/types.js';
import { stringifyExact } from '../shared/exact-json.js';
import type { World } from '../world/index.js';
import type { WorldParams } from '../world/params.js';
import { decodeSnapshotValue, decodeSnapshotTileRows, encodeSnapshot, encodeSnapshotTileRows,
  LEGACY_SNAPSHOT_TILE_LIMIT, parseSnapshotJSON, readSnapshotParams, snapshotRecord,
  SNAPSHOT_TILE_ENCODING, SnapshotPhysicalError } from './snapshot.js';

// Transport bounds, independent of world laws and available host hardware.
export const SNAPSHOT_INLINE_TILE_LIMIT = 32768;
export const SNAPSHOT_PAGE_TILES = 4096;
export const SNAPSHOT_METADATA_BYTES = 8 * 1024 * 1024;
const PAGE_BYTES = 4 * 1024 * 1024;
const ENCODING = 'snapshot-parts-v1';
const checksum = (body: string): string => createHash('sha256').update(body).digest('hex');
class SnapshotPartsFormatError extends Error {}
function failure(message: string): never { throw new SnapshotPartsFormatError(`Invalid snapshot parts ${message}. Explicit recovery required.`); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
interface Page { index: number; digest: string; count: number; bytes: number; }
interface Manifest { snapshotEncoding: typeof ENCODING; world: Record<string, unknown>; tiles: { count: number; pages: Page[] }; }
export interface PreparedSnapshot { inline?: string; metadata?: Record<string, unknown>; tiles: readonly Tile[]; }
export interface WrittenSnapshot { body: string; bytes: number; }

/** JSON.parse accepts duplicate keys. A manifest must not hide an earlier encoding
 * or tile source through last-key-wins semantics, including inside its metadata. */
function assertUniqueKeys(body: string): void {
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === '{') stack.push(new Set());
    else if (char === '[') stack.push(null);
    else if (char === '}' || char === ']') stack.pop();
    else if (char === '"') {
      const start = i++;
      for (; i < body.length; i++) {
        if (body[i] === '\\') i++;
        else if (body[i] === '"') break;
      }
      let next = i + 1;
      while (/\s/.test(body[next] ?? '') && next < body.length) next++;
      if (body[next] === ':') {
        const key = JSON.parse(body.slice(start, i + 1)) as string, seen = stack.at(-1);
        if (!seen || seen.has(key)) failure('duplicate metadata key');
        seen.add(key);
      }
    }
  }
}

/** Schema 5 is explicit. Missing/nullable/non-unique keys are never repaired on open. */
export function assertSnapshotPartsSchema(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM temp.sqlite_schema WHERE name='snapshot_parts'").get()) failure('temporary object shadows durable table');
  const columns = db.prepare('SELECT name,type,"notnull",pk FROM pragma_table_info(?,?)').all('snapshot_parts', 'main');
  if (JSON.stringify(columns) !== JSON.stringify([
    { name: 'digest', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'body', type: 'TEXT', notnull: 1, pk: 0 },
  ])) failure('schema is incomplete');
  const indexes = db.prepare('SELECT name FROM pragma_index_list(?,?) WHERE "unique"=1 AND partial=0').all('snapshot_parts', 'main') as { name: string }[];
  if (!indexes.some(index => {
    const fields = db.prepare('SELECT name FROM pragma_index_info(?,?) ORDER BY seqno').all(index.name, 'main') as { name: string }[];
    return fields.length === 1 && fields[0]!.name === 'digest';
  })) failure('schema uniqueness is incomplete');
}

export class SnapshotParts {
  // Only reference lists keyed by complete body hashes; no tile/page body cache.
  // collect() trims this to the three durable slots after every save.
  private readonly references = new Map<string, readonly string[]>();
  constructor(private readonly db: DatabaseSync, private readonly schemaVersion: number) {}

  static install(db: DatabaseSync): void {
    db.exec('CREATE TABLE main.snapshot_parts (digest TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL)');
  }

  private requireTransaction(): void {
    if (!this.db.isTransaction) throw new Error('Snapshot parts require a coherent transaction.');
  }

  prepare(world: World, params: WorldParams, inlineLimit: number): PreparedSnapshot {
    if (world.tiles.length <= inlineLimit) return { inline: encodeSnapshot(world, params), tiles: [] };
    const metadata = snapshotRecord(world, params, undefined);
    delete metadata.tiles;
    const body = stringifyExact(metadata);
    if (Buffer.byteLength(body) > SNAPSHOT_METADATA_BYTES) failure('metadata exceeds transport size');
    return { metadata, tiles: world.tiles };
  }

  /** Only one page's tuples and JSON string exist at once. The caller owns the
   * same transaction as journal writes and checkpoint rotation. */
  write(prepared: PreparedSnapshot): WrittenSnapshot {
    this.requireTransaction();
    assertSnapshotPartsSchema(this.db);
    if (prepared.inline !== undefined) {
      if (this.db.prepare('SELECT 1 FROM main.snapshot_parts LIMIT 1').get()) this.references.set(checksum(prepared.inline), []);
      else this.references.clear();
      return { body: prepared.inline, bytes: Buffer.byteLength(prepared.inline) };
    }
    if (!prepared.metadata) failure('metadata missing');
    const pages: Page[] = [], insert = this.db.prepare('INSERT INTO main.snapshot_parts(digest,body) VALUES (?,?)');
    const get = this.db.prepare('SELECT body FROM main.snapshot_parts WHERE digest=?');
    let bytes = 0;
    for (let offset = 0; offset < prepared.tiles.length; offset += SNAPSHOT_PAGE_TILES) {
      const rows = encodeSnapshotTileRows(prepared.tiles.slice(offset, offset + SNAPSHOT_PAGE_TILES));
      const body = JSON.stringify(rows), digest = checksum(body), size = Buffer.byteLength(body);
      if (size > PAGE_BYTES) failure('page exceeds transport size');
      const existing = get.get(digest) as { body: string } | undefined;
      if (existing && existing.body !== body) failure('existing page disagrees with its digest');
      if (!existing) insert.run(digest, body);
      pages.push({ index: pages.length, digest, count: rows.length, bytes: size });
      bytes += size;
    }
    const manifest: Manifest = { snapshotEncoding: ENCODING, world: prepared.metadata!, tiles: { count: prepared.tiles.length, pages } };
    const body = stringifyExact(manifest);
    if (Buffer.byteLength(body) > SNAPSHOT_METADATA_BYTES) failure('manifest exceeds transport size');
    this.references.set(checksum(body), pages.map(page => page.digest));
    return { body, bytes: bytes + Buffer.byteLength(body) };
  }

  private manifest(value: Record<string, unknown>, body: string, validateParams = true): Manifest {
    if (this.schemaVersion < 5) failure('encoding requires schema 5');
    if (Buffer.byteLength(body) > SNAPSHOT_METADATA_BYTES) failure('manifest exceeds transport size');
    assertUniqueKeys(body);
    if (!keys(value, ['snapshotEncoding', 'world', 'tiles']) || value.snapshotEncoding !== ENCODING
      || !object(value.world) || !object(value.tiles)) failure('manifest encoding');
    const world = value.world as Record<string, unknown>, tiles = value.tiles as Record<string, unknown>;
    if (Object.hasOwn(world, 'tiles') || Object.hasOwn(world, 'snapshotEncoding')
      || world.tileEncoding !== SNAPSHOT_TILE_ENCODING) failure('metadata tile encoding');
    if (validateParams) readSnapshotParams(world);
    if (!keys(tiles, ['count', 'pages']) || !Number.isSafeInteger(tiles.count) || (tiles.count as number) < 1
      || (tiles.count as number) > LEGACY_SNAPSHOT_TILE_LIMIT || !Array.isArray(tiles.pages)
      || tiles.pages.length !== Math.ceil((tiles.count as number) / SNAPSHOT_PAGE_TILES)) failure('tile count');
    let count = 0;
    for (const [index, page] of (tiles.pages as unknown[]).entries()) {
      if (!object(page) || !keys(page, ['index', 'digest', 'count', 'bytes']) || page.index !== index
        || typeof page.digest !== 'string' || !/^[0-9a-f]{64}$/.test(page.digest)
        || !Number.isSafeInteger(page.count) || page.count !== Math.min(SNAPSHOT_PAGE_TILES, (tiles.count as number) - count)
        || !Number.isSafeInteger(page.bytes) || (page.bytes as number) < 2 || (page.bytes as number) > PAGE_BYTES) failure('page descriptor');
      count += page.count as number;
    }
    if (count !== tiles.count) failure('total tile count');
    return value as unknown as Manifest;
  }

  private page(page: Page): unknown[] {
    const row = this.db.prepare('SELECT body FROM main.snapshot_parts WHERE digest=?').get(page.digest) as { body: string } | undefined;
    if (!row || typeof row.body !== 'string' || checksum(row.body) !== page.digest)
      throw new SnapshotPhysicalError('Snapshot page missing or checksum mismatch.');
    if (Buffer.byteLength(row.body) !== page.bytes) failure('page byte count');
    const rows = parseSnapshotJSON(row.body);
    if (!Array.isArray(rows) || rows.length !== page.count) failure('page row count');
    return rows;
  }

  read(body: string): unknown {
    return this.readWithInfo(body).value;
  }

  readWithInfo(body: string): { value: unknown; bytes: number } {
    this.requireTransaction();
    if (this.schemaVersion >= 5) assertSnapshotPartsSchema(this.db);
    let bytes = Buffer.byteLength(body);
    const value = parseSnapshotJSON(body);
    if (!object(value) || !Object.hasOwn(value, 'snapshotEncoding')) return { value: decodeSnapshotValue(value), bytes };
    const manifest = this.manifest(value, body), tiles: Tile[] = [];
    for (const page of manifest.tiles.pages) {
      // Avoid a giant spread argument or a reconstructed giant JSON string.
      for (const tile of decodeSnapshotTileRows(this.page(page))) tiles.push(tile);
      bytes += page.bytes;
    }
    const world = { ...manifest.world, tiles };
    delete (world as Record<string, unknown>).tileEncoding;
    return { value: world, bytes };
  }

  /** Re-read after all SQL triggers have run, before COMMIT. A content-addressed
   * row is reusable only when the actual durable bytes still prove that identity. */
  verify(body: string): void {
    this.requireTransaction();
    assertSnapshotPartsSchema(this.db);
    const value = parseSnapshotJSON(body);
    if (!object(value) || !Object.hasOwn(value, 'snapshotEncoding')) return;
    for (const page of this.manifest(value, body).tiles.pages) decodeSnapshotTileRows(this.page(page));
  }

  /** Triggers can also damage pages now referenced only by a backup. Verify all
   * retained slots after every host write when triggers were present. */
  verifyRetained(): void {
    this.requireTransaction();
    assertSnapshotPartsSchema(this.db);
    for (const row of this.db.prepare('SELECT body,digest FROM main.snapshots').all() as { body: string; digest: string }[]) {
      if (checksum(row.body) !== row.digest) throw new SnapshotPhysicalError('Retained snapshot checksum mismatch.');
      this.verify(row.body);
    }
  }

  /** An unreadable older checkpoint is not proof that it has no references.
   * In that case retain pages; explicit recovery can later start a clean chain. */
  collect(): void {
    this.requireTransaction();
    // Most existing worlds use only inline checkpoints. An empty page table
    // needs no collection: avoid copying/hashing three multi-megabyte bodies
    // merely to prove that there are no page rows to delete.
    if (!this.db.prepare('SELECT 1 FROM main.snapshot_parts LIMIT 1').get()) { this.references.clear(); return; }
    const retained = new Set<string>(), bodies = new Set<string>();
    const snapshots = this.db.prepare('SELECT body,digest FROM main.snapshots').all() as { body: string; digest: string }[];
    try {
      for (const row of snapshots) {
        if (checksum(row.body) !== row.digest) return;
        bodies.add(row.digest);
        let refs = this.references.get(row.digest);
        if (!refs) {
          const value = parseSnapshotJSON(row.body);
          refs = object(value) && Object.hasOwn(value, 'snapshotEncoding')
            ? this.manifest(value, row.body, false).tiles.pages.map(page => page.digest) : [];
          this.references.set(row.digest, refs);
        }
        for (const digest of refs) retained.add(digest);
      }
    } catch (error) {
      if (!(error instanceof SnapshotPhysicalError) && !(error instanceof SnapshotPartsFormatError)) throw error;
      return;
    }
    finally { for (const digest of this.references.keys()) if (!bodies.has(digest)) this.references.delete(digest); }
    // Only the current reference set crosses the JS boundary; never materialize
    // the whole historical archive or mutate a table under a live SELECT cursor.
    this.db.prepare('DELETE FROM main.snapshot_parts WHERE digest NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify([...retained]));
  }
}

/** Host tools must read the slot and every referenced page in one SQLite view.
 * This codec-only API verifies transport; Store.load additionally validates and
 * migrates the world and its external archives. It never selects another slot. */
export function readStoredSnapshot(db: DatabaseSync, slot = 0):
  { value: unknown; bodyDigest: string; bodyBytes: number; snapshotBytes: number; savedAt: number } | null {
  if (![0, 1, 2].includes(slot)) throw new Error('Invalid snapshot slot.');
  const own = !db.isTransaction;
  if (own) db.exec('BEGIN');
  try {
    const row = db.prepare('SELECT body,digest,saved_at FROM main.snapshots WHERE slot=?').get(slot) as
      { body: string; digest: string; saved_at: number } | undefined;
    let result = null;
    if (row) {
      if (typeof row.body !== 'string' || checksum(row.body) !== row.digest) throw new SnapshotPhysicalError('Snapshot checksum mismatch.');
      const version = Number(db.prepare('PRAGMA main.user_version').get()!.user_version);
      if (![1, 2, 3, 4, 5].includes(version)) failure('schema version');
      const decoded = new SnapshotParts(db, version).readWithInfo(row.body);
      result = { value: decoded.value, bodyDigest: row.digest, bodyBytes: Buffer.byteLength(row.body), snapshotBytes: decoded.bytes, savedAt: row.saved_at };
    }
    if (own) db.exec('COMMIT');
    return result;
  } catch (error) { if (own && db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
