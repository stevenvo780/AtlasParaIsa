import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Tile } from '../shared/types.js';
import { stringifyExact } from '../shared/exact-json.js';
import type { World } from '../world/index.js';
import type { WorldLimits, WorldParams } from '../world/params.js';
import { decodeSnapshotValue, decodeSnapshotTileRows, encodeSnapshot, encodeSnapshotTileRows,
  assertSnapshotCounts, finishDecodedRecord, parseSnapshotJSON, readSnapshotLimits, snapshotRecord,
  SNAPSHOT_TILE_ENCODING, SnapshotPhysicalError, SnapshotSemanticError } from './snapshot.js';
import { residentBackingArray, residentTileRevision, residentTopologyToken } from '../world/soa/topologia.js';
import { residentSnapshotGate, type ResidentSnapshotGate } from '../world/soa/terreno.js';

// Transport bounds, independent of world laws and available host hardware.
export const SNAPSHOT_INLINE_TILE_LIMIT = 32768;
export const SNAPSHOT_PAGE_TILES = 4096;
/** Tope de la parte de la instantánea que no son teselas (personas, recuerdos, sucesos…). Era 8 MiB y el mundo público
 * lo superó con 583 habitantes (2026-09-23): el guardado falló y el mundo quedó en pausa. El límite real lo pone V8,
 * que no crea cadenas de más de ~512 MiB al serializar; se deja la mitad como defensa contra filas corruptas, no como
 * techo de población (FR-013: el límite lo pone el hardware). */
export const SNAPSHOT_METADATA_BYTES = 256 * 1024 * 1024;
const PAGE_BYTES = 4 * 1024 * 1024;
const ENCODING = 'snapshot-parts-v1';
const checksum = (body: string | Uint8Array): string => createHash('sha256').update(body).digest('hex');
class SnapshotPartsFormatError extends SnapshotSemanticError {}
function failure(message: string): never { throw new SnapshotPartsFormatError(`Invalid snapshot parts ${message}. Explicit recovery required.`); }
/** Una regla de los metadatos ya se explica y pide recuperación: su texto va una sola vez, con el error original como `cause`. */
function metadataFailure(error: SnapshotSemanticError): never {
  throw new SnapshotPartsFormatError(`Invalid snapshot parts metadata: ${error.message}`, { cause: error });
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
interface Page { index: number; digest: string; count: number; bytes: number; }
interface Manifest { snapshotEncoding: typeof ENCODING; world: Record<string, unknown>; tiles: { count: number; pages: Page[] }; }
/** `metadata` is the exact JSON of the world record without tiles, serialized once. */
export interface PreparedSnapshot { inline?: string; metadata?: string; tiles: readonly Tile[]; }
/** `digest` is sha256(body); `pages` are the digests write() proved inside the caller's transaction. */
export interface WrittenSnapshot { body: string; digest: string; bytes: number; pages: readonly string[]; }
/**
 * Vale de reutilización de páginas limpias (v18) que emite `Store.save` SOLO cuando el sello completo de la
 * base al empezar el guardado (`data_version`, `total_changes`, cookies de esquema) coincide con el tomado
 * tras su último COMMIT, no hay triggers SQL y no toca validación profunda. `total_changes` ya lo cotejó el
 * Store antes de la transacción (dentro, sus propias escrituras lo mueven); `write` recoteja dentro de la
 * transacción los tres campos que una conexión AJENA puede mover. Sin vale, el camino histórico completo.
 */
export interface SnapshotReuseTicket { dataVersion: number; schemaCookie: number; tempSchemaCookie: number; }
/** Directorio confirmado de una página: digesto y tamaño ya durables + la prueba de identidad para reusarla
 * (mismos objetos `Tile` en el mismo orden y la revisión lógica de cada uno al codificarla). Sin cuerpos. */
interface CachedPage { offset: number; count: number; digest: string; bytes: number; tiles: readonly Tile[]; revisions: Int32Array; }
interface PageCache {
  pages: readonly CachedPage[];
  /** Puerta paralela al codificar: `null` certifica que ninguna tesela estaba ligada a un `TileStore`. */
  parallel: { identity: object; epoch: number; serial: number } | null;
}

/** JSON.parse accepts duplicate keys. A manifest must not hide an earlier encoding
 * or tile source through last-key-wins semantics, including inside its metadata. */
function assertUniqueKeys(body: string): void {
  const stack: (Set<string> | null)[] = [];
  const pool: Set<string>[] = [];
  const len = body.length;
  for (let i = 0; i < len; i++) {
    const code = body.charCodeAt(i);
    if (code === 123 /* { */) {
      const set = pool.pop() ?? new Set<string>();
      stack.push(set);
    } else if (code === 91 /* [ */) {
      stack.push(null);
    } else if (code === 125 /* } */ || code === 93 /* ] */) {
      const top = stack.pop();
      if (top) { top.clear(); pool.push(top); }
    } else if (code === 34 /* " */) {
      const start = i++;
      let escaped = false;
      for (; i < len; i++) {
        const ch = body.charCodeAt(i);
        if (ch === 92 /* \ */) { escaped = true; i++; }
        else if (ch === 34 /* " */) break;
      }
      let next = i + 1;
      while (next < len) {
        const ws = body.charCodeAt(next);
        if (ws === 32 || ws === 9 || ws === 10 || ws === 13) next++; else break;
      }
      if (next < len && body.charCodeAt(next) === 58 /* : */) {
        const key = escaped ? JSON.parse(body.slice(start, i + 1)) as string : body.slice(start + 1, i);
        const seen = stack[stack.length - 1];
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
  /** Páginas del último COMMIT de este proceso (solo digestos/tamaños e identidad, nunca cuerpos) y las de
   * la transacción en curso: `unconfirmedPages` solo se promueve con `confirmPendingPages()` tras COMMIT;
   * un ROLLBACK lo descarta y el directorio confirmado sigue describiendo lo durable. */
  private confirmedPages: PageCache | null = null;
  private unconfirmedPages: PageCache | null | undefined = undefined;
  /** Digestos de slot cuyos cuerpos `collect()` ya probó (checksum + referencias) y que un COMMIT
   * confirmó: con el sello de la base intacto son la prueba que permite recoger sin re-hashear los
   * tres cuerpos. `pendingSlots` es el conjunto de la transacción en curso y solo se promueve con
   * `confirmPendingPages()`; `writtenDigest`, el cuerpo que `write()` acaba de construir en ella. */
  private confirmedSlots: ReadonlySet<string> | null = null;
  private pendingSlots: ReadonlySet<string> | undefined = undefined;
  private writtenDigest: string | null = null;
  private pagesReused = 0;
  private pagesEncoded = 0;
  constructor(private readonly db: DatabaseSync, private readonly schemaVersion: number,
    private readonly onProgress?: () => void) {}

  /** Contadores acumulados de diagnóstico: páginas servidas desde el directorio confirmado frente a
   * codificadas (serializar + sha256 + cotejo SQL) por el camino completo. */
  get pageStats(): { reused: number; encoded: number } {
    return { reused: this.pagesReused, encoded: this.pagesEncoded };
  }
  /** Solo tras el COMMIT de la transacción en la que `write`/`collect` construyeron lo pendiente. */
  confirmPendingPages(): void {
    if (this.unconfirmedPages !== undefined) { this.confirmedPages = this.unconfirmedPages; this.unconfirmedPages = undefined; }
    if (this.pendingSlots !== undefined) { this.confirmedSlots = this.pendingSlots; this.pendingSlots = undefined; }
    this.writtenDigest = null;
  }
  /** La transacción que construyó el directorio pendiente no confirmó: se descarta entero. */
  discardPendingPages(): void { this.unconfirmedPages = undefined; this.pendingSlots = undefined; this.writtenDigest = null; }
  /** Olvida también lo confirmado (p. ej. si el sello post-COMMIT no se pudo tomar): todo se recodifica. */
  invalidatePageCache(): void {
    this.confirmedPages = null; this.unconfirmedPages = undefined;
    this.confirmedSlots = null; this.pendingSlots = undefined; this.writtenDigest = null;
  }

  static install(db: DatabaseSync): void {
    db.exec('CREATE TABLE main.snapshot_parts (digest TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL)');
  }

  private requireTransaction(): void {
    if (!this.db.isTransaction) throw new Error('Snapshot parts require a coherent transaction.');
  }

  prepare(world: World, params: WorldParams, inlineLimit: number): PreparedSnapshot {
    if (world.tiles.length <= inlineLimit) return { inline: encodeSnapshot(world, params), tiles: [] };
    // Keep a validated null placeholder: deleting/reinserting tiles changes the
    // world's enumerable property order when a paged checkpoint is reloaded.
    const metadata = stringifyExact(snapshotRecord(world, params, null));
    // UTF-8 ocupa como mucho 3 bytes por unidad UTF-16: por debajo de un tercio del tope el cuerpo
    // no puede excederlo y se ahorra re-codificar los metadatos enteros solo para contarlos.
    if (metadata.length * 3 > SNAPSHOT_METADATA_BYTES && Buffer.byteLength(metadata) > SNAPSHOT_METADATA_BYTES) failure('metadata exceeds transport size');
    return { metadata, tiles: world.tiles };
  }

  /** Los tres campos del vale que una conexión ajena puede mover, recotejados DENTRO de la transacción:
   * entre el sello previo del Store y este punto nadie más pudo confirmar cambios ni tocar el esquema. */
  private reuseStampIntact(ticket: SnapshotReuseTicket): boolean {
    return Number(this.db.prepare('PRAGMA data_version').get()!.data_version) === ticket.dataVersion
      && Number(this.db.prepare('PRAGMA schema_version').get()!.schema_version) === ticket.schemaCookie
      && Number(this.db.prepare('PRAGMA temp.schema_version').get()!.schema_version) === ticket.tempSchemaCookie;
  }

  /** Entrada de directorio para una página recién codificada: identidad y revisión lógica de cada tesela
   * en el instante de codificarla (el guardado es síncrono: nada muta entre codificar y COMMIT). */
  private cachedPage(tiles: readonly Tile[], offset: number, count: number, digest: string, bytes: number): CachedPage {
    const refs = new Array<Tile>(count), revisions = new Int32Array(count);
    const raw = residentTopologyToken(tiles as Tile[]) === undefined ? tiles : residentBackingArray(tiles);
    for (let i = 0; i < count; i++) {
      const tile = raw[offset + i]!;
      refs[i] = tile;
      // `-1` nunca coincide con una revisión real (≥ 0): una tesela sin owner ensucia su página siempre.
      revisions[i] = residentTileRevision(tile) ?? -1;
    }
    return { offset, count, digest, bytes, tiles: refs, revisions };
  }

  /** Páginas reutilizables del directorio confirmado, o `null` si la reutilización está vetada en bloque.
   * Una página solo es candidata si el token residente certifica observación total, cada tesela es el MISMO
   * objeto con la MISMA revisión lógica que al confirmarse, ninguna escritura paralela/SAB selló su ranura
   * después, y su digesto sigue presente en la tabla (una sola consulta por lote dentro de la transacción;
   * si falta, esa página se recodifica y se reinserta: recomputar exacto, nunca servir un digesto huérfano). */
  private reusablePages(tiles: Tile[], ticket: SnapshotReuseTicket | undefined,
    gate: ResidentSnapshotGate | undefined): (CachedPage | null)[] | null {
    const cache = this.confirmedPages;
    if (!ticket || !cache || residentTopologyToken(tiles) === undefined) return null;
    // La puerta paralela de hoy debe ser la de la confirmación: apareció, desapareció o cambió de época un
    // TileStore ⇒ ninguna reutilización este guardado (el directorio se reconstruye codificando).
    const parallelOk = cache.parallel === null
      ? gate === undefined
      : gate !== undefined && gate.identity === cache.parallel.identity && gate.epoch === cache.parallel.epoch;
    if (!parallelOk || !this.reuseStampIntact(ticket)) return null;
    const confirmedSerial = cache.parallel?.serial ?? 0;
    const raw = residentBackingArray(tiles);
    const candidates: (CachedPage | null)[] = [], digests: string[] = [];
    for (let index = 0, offset = 0; offset < tiles.length; index++, offset += SNAPSHOT_PAGE_TILES) {
      const count = Math.min(SNAPSHOT_PAGE_TILES, tiles.length - offset), entry = cache.pages[index];
      let clean = entry !== undefined && entry.offset === offset && entry.count === count;
      if (clean) {
        const entryTiles = entry!.tiles, entryRevisions = entry!.revisions;
        if (gate === undefined) {
          for (let i = 0; i < count; i++) {
            const tile = raw[offset + i]!;
            if (tile !== entryTiles[i] || residentTileRevision(tile) !== entryRevisions[i]) { clean = false; break; }
          }
        } else {
          for (let i = 0; i < count; i++) {
            const tile = raw[offset + i]!;
            if (tile !== entryTiles[i] || residentTileRevision(tile) !== entryRevisions[i]
              || gate.stampOfTile(tile) > confirmedSerial) { clean = false; break; }
          }
        }
      }
      candidates.push(clean ? entry! : null);
      if (clean) digests.push(entry!.digest);
    }
    if (digests.length) {
      const present = new Set((this.db.prepare(
        'SELECT digest FROM main.snapshot_parts WHERE digest IN (SELECT value FROM json_each(?))')
        .all(JSON.stringify(digests)) as { digest: string }[]).map(row => row.digest));
      for (let i = 0; i < candidates.length; i++) {
        const entry = candidates[i];
        if (entry && !present.has(entry.digest)) candidates[i] = null;
      }
    }
    return candidates;
  }

  /** Only one page's tuples and JSON string exist at once (certified clean pages materialize neither).
   * The caller owns the same transaction as journal writes and checkpoint rotation. With a reuse ticket
   * from Store (intact DB stamp vs its last COMMIT, no SQL triggers, no deep validation), pages proved
   * untouched since that COMMIT keep their confirmed digest/bytes without re-encode, re-hash or SQL body
   * comparison; every other page —and every page without a ticket— takes the full historical path, and
   * the returned body/digest/bytes are byte-identical either way. */
  write(prepared: PreparedSnapshot, reuse?: SnapshotReuseTicket): WrittenSnapshot {
    this.requireTransaction();
    assertSnapshotPartsSchema(this.db);
    // Un directorio pendiente de una transacción que nunca confirmó no deja residuo reutilizable.
    this.unconfirmedPages = undefined;
    this.writtenDigest = null;
    if (prepared.inline !== undefined) {
      const digest = checksum(prepared.inline);
      if (this.db.prepare('SELECT 1 FROM main.snapshot_parts LIMIT 1').get()) this.references.set(digest, []);
      else this.references.clear();
      this.unconfirmedPages = null;
      this.writtenDigest = digest;
      return { body: prepared.inline, digest, bytes: Buffer.byteLength(prepared.inline), pages: [] };
    }
    if (prepared.metadata === undefined) failure('metadata missing');
    const tiles = prepared.tiles as Tile[];
    // Sin token residente no hay certificación posible (teselas planas u opacas): se codifica todo y el
    // directorio confirmado queda vacío tras COMMIT. Con token, el directorio se (re)construye en CADA
    // guardado —también en los de validación profunda, que codifican todo— para el siguiente.
    const certified = residentTopologyToken(tiles) !== undefined;
    const gate = certified ? residentSnapshotGate(tiles) : undefined;
    const candidates = certified ? this.reusablePages(tiles, reuse, gate) : null;
    const pages: Page[] = [], pending: CachedPage[] = [], insert = this.db.prepare('INSERT INTO main.snapshot_parts(digest,body) VALUES (?,?)');
    // SQLite compares the stored bytes itself: an unchanged multi-megabyte page is not copied into JS
    // just to prove its identity. BINARY ignores any collation a damaged schema could declare.
    const same = this.db.prepare('SELECT body = ? COLLATE BINARY AS same FROM main.snapshot_parts WHERE digest=?');
    let bytes = 0;
    for (let offset = 0; offset < tiles.length; offset += SNAPSHOT_PAGE_TILES) {
      const index = pages.length, reused = candidates?.[index] ?? null;
      if (reused) {
        // Identidad, revisiones, sello paralelo, sello de base y presencia durable ya probados arriba:
        // el descriptor es el confirmado, sin re-serializar ni re-hashear los ~4 096 tuplas de la página.
        pages.push({ index, digest: reused.digest, count: reused.count, bytes: reused.bytes });
        pending.push(reused);
        bytes += reused.bytes;
        this.pagesReused++;
        this.onProgress?.();
        continue;
      }
      const rows = encodeSnapshotTileRows(tiles, offset, Math.min(SNAPSHOT_PAGE_TILES, tiles.length - offset));
      const body = JSON.stringify(rows), digest = checksum(body), size = Buffer.byteLength(body);
      if (size > PAGE_BYTES) failure('page exceeds transport size');
      const existing = same.get(body, digest) as { same: number } | undefined;
      if (existing && existing.same !== 1) failure('existing page disagrees with its digest');
      if (!existing) insert.run(digest, body);
      pages.push({ index, digest, count: rows.length, bytes: size });
      bytes += size;
      this.pagesEncoded++;
      if (certified) pending.push(this.cachedPage(tiles, offset, rows.length, digest, size));
      this.onProgress?.();
    }
    // Byte for byte `stringifyExact(manifest)`: the page descriptors hold only strings and non-negative integers.
    const manifestTiles: Manifest['tiles'] = { count: tiles.length, pages };
    const body = `{"snapshotEncoding":${JSON.stringify(ENCODING)},"world":${prepared.metadata},"tiles":${JSON.stringify(manifestTiles)}}`;
    const size = Buffer.byteLength(body), digest = checksum(body), digests = pages.map(page => page.digest);
    if (size > SNAPSHOT_METADATA_BYTES) failure('manifest exceeds transport size');
    this.references.set(digest, digests);
    this.writtenDigest = digest;
    this.unconfirmedPages = certified
      ? { pages: pending, parallel: gate ? { identity: gate.identity, epoch: gate.epoch, serial: gate.serial } : null }
      : null;
    return { body, digest, bytes: bytes + size, pages: digests };
  }

  /** Without SQL triggers only this transaction writes `snapshot_parts` before COMMIT, and write()
   * already proved the bytes of every page it references: what remains is that collection kept them. */
  assertWritten(written: WrittenSnapshot): void {
    this.requireTransaction();
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM main.snapshot_parts WHERE digest IN (SELECT value FROM json_each(?))')
      .get(JSON.stringify(written.pages)) as { n: number };
    if (row.n !== new Set(written.pages).size) throw new SnapshotPhysicalError('Snapshot page missing or checksum mismatch.');
  }

  private manifest(value: Record<string, unknown>, body: string, validateParams = true): Manifest {
    if (this.schemaVersion < 5) failure('encoding requires schema 5');
    if (Buffer.byteLength(body) > SNAPSHOT_METADATA_BYTES) failure('manifest exceeds transport size');
    assertUniqueKeys(body);
    if (!keys(value, ['snapshotEncoding', 'world', 'tiles']) || value.snapshotEncoding !== ENCODING
      || !object(value.world) || !object(value.tiles)) failure('manifest encoding');
    const world = value.world as Record<string, unknown>, tiles = value.tiles as Record<string, unknown>;
    if (!Object.hasOwn(world, 'tiles') || world.tiles !== null || Object.hasOwn(world, 'snapshotEncoding')
      || world.tileEncoding !== SNAPSHOT_TILE_ENCODING) failure('metadata tile encoding');
    let limits: Readonly<WorldLimits>;
    try { limits = readSnapshotLimits(world, validateParams); }
    catch (error) { if (error instanceof SnapshotSemanticError) metadataFailure(error); throw error; }
    if (!keys(tiles, ['count', 'pages']) || !Number.isSafeInteger(tiles.count) || (tiles.count as number) < 1
      || !Array.isArray(tiles.pages)
      || tiles.pages.length !== Math.ceil((tiles.count as number) / SNAPSHOT_PAGE_TILES)) failure('tile count');
    try { assertSnapshotCounts(world, limits, tiles.count as number); }
    catch (error) { if (error instanceof SnapshotSemanticError) metadataFailure(error); throw error; }
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
      this.onProgress?.();
    }
    const world = { ...manifest.world, tiles };
    finishDecodedRecord(world);
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

  /** Recogida sin re-hashear cuerpos: solo con el vale del Store (sello completo intacto desde su
   * último COMMIT y sin triggers, recotejado aquí dentro de la transacción) y cuando cada slot es un
   * cuerpo ya probado por `collect` y confirmado, o el que `write` acaba de construir en esta misma
   * transacción (slot 0, aún sin confirmar). Dentro de `BEGIN IMMEDIATE` ninguna conexión ajena pudo
   * escribir, y las escrituras propias del guardado solo rotan cuerpos con su digesto o insertan el
   * recién construido, así que las referencias recordadas son exactamente las durables. Cualquier
   * duda —sin vale, digesto no confirmado o referencias no recordadas— devuelve `false` sin tocar
   * nada y el camino completo de abajo decide. El borrado es idéntico al histórico. */
  private tryCollectFast(ticket: SnapshotReuseTicket): boolean {
    const confirmed = this.confirmedSlots;
    if (!confirmed || !this.reuseStampIntact(ticket)) return false;
    const slots = this.db.prepare('SELECT slot, digest FROM main.snapshots').all() as { slot: number; digest: string }[];
    const retained = new Set<string>(), bodies = new Set<string>();
    for (const { slot, digest } of slots) {
      if (!confirmed.has(digest) && !(slot === 0 && digest === this.writtenDigest)) return false;
      const refs = this.references.get(digest);
      if (!refs) return false;
      bodies.add(digest);
      for (const pageDigest of refs) retained.add(pageDigest);
    }
    for (const digest of this.references.keys()) if (!bodies.has(digest)) this.references.delete(digest);
    this.pendingSlots = bodies;
    this.db.prepare('DELETE FROM main.snapshot_parts WHERE digest NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify([...retained]));
    return true;
  }

  /** An unreadable older checkpoint is not proof that it has no references.
   * In that case retain pages; explicit recovery can later start a clean chain. */
  collect(reuse?: SnapshotReuseTicket): void {
    this.requireTransaction();
    this.pendingSlots = undefined;
    // Most existing worlds use only inline checkpoints. An empty page table
    // needs no collection: avoid copying/hashing three multi-megabyte bodies
    // merely to prove that there are no page rows to delete.
    if (!this.db.prepare('SELECT 1 FROM main.snapshot_parts LIMIT 1').get()) { this.references.clear(); return; }
    if (reuse && this.tryCollectFast(reuse)) return;
    const retained = new Set<string>(), bodies = new Set<string>();
    // In a UTF-8 database, valid UTF-8 bytes without NUL (node:sqlite cuts text there) hash exactly like
    // the text they decode to, without transcoding three multi-megabyte bodies to JS strings and back.
    // Stream one slot at a time so peak memory holds at most one snapshot body instead of all three.
    const slots = this.db.prepare('SELECT slot, digest FROM main.snapshots').all() as { slot: number; digest: string }[];
    const blobOf = this.db.prepare("SELECT CAST(body AS BLOB) AS bytes, instr(CAST(body AS BLOB), x'00') AS nul FROM main.snapshots WHERE slot=?");
    const text = this.db.prepare('SELECT body FROM main.snapshots WHERE slot=?');
    const bodyOf = (slot: number) => (text.get(slot) as { body: string }).body;
    const utf8 = (this.db.prepare('PRAGMA main.encoding').get() as { encoding: string }).encoding === 'UTF-8';
    try {
      for (const { slot, digest } of slots) {
        const raw = blobOf.get(slot) as { bytes: Uint8Array; nul: number } | undefined;
        if (!raw) return;
        if (checksum(utf8 && raw.nul === 0 && isUtf8(raw.bytes) ? raw.bytes : bodyOf(slot)) !== digest) return;
        bodies.add(digest);
        let refs = this.references.get(digest);
        if (!refs) {
          const body = bodyOf(slot), value = parseSnapshotJSON(body);
          refs = object(value) && Object.hasOwn(value, 'snapshotEncoding')
            ? this.manifest(value, body, false).tiles.pages.map(page => page.digest) : [];
          this.references.set(digest, refs);
        }
        for (const pageDigest of refs) retained.add(pageDigest);
      }
    } catch (error) {
      if (!(error instanceof SnapshotPhysicalError) && !(error instanceof SnapshotPartsFormatError)) throw error;
      return;
    }
    finally { for (const digest of this.references.keys()) if (!bodies.has(digest)) this.references.delete(digest); }
    // Los tres slots quedaron probados (checksum y referencias) en esta transacción: el conjunto solo
    // pasa a confirmado si el COMMIT llega (`confirmPendingPages`); un ROLLBACK lo descarta entero.
    this.pendingSlots = bodies;
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
