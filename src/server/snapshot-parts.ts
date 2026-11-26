import { constants, isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Tile } from '../shared/types.js';
import { stringifyExact } from '../shared/exact-json.js';
import { clavesJsonUnicas } from '../shared/json-keys.js';
import type { World } from '../world/index.js';
import { faunaCorteDe, type TramoFaunaCorte, type TramoFaunaVerificada } from '../world/motor/fauna-corte.js';
import type { TeselasCorteVerificadas } from '../world/motor/teselas-corte.js';
import type { WorldLimits, WorldParams } from '../world/params.js';
import { decodeSnapshotValue, decodeSnapshotTileRows, encodeSnapshot, encodeSnapshotTileRows,
  assertSnapshotCounts, finishDecodedRecord, parseSnapshotJSON, readSnapshotLimits, readSnapshotParams, snapshotRecord,
  SNAPSHOT_TILE_ENCODING, SnapshotPhysicalError, SnapshotSemanticError } from './snapshot.js';
import { decodePackedPeoplePage, encodePackedPeoplePage, packedPeoplePageBytes, preparePackedPerson,
  type PackedPersonRow } from './snapshot-packed-people.js';
import { residentBackingArray, residentTileRevision, residentTopologyToken } from '../world/soa/topologia.js';
import { residentSnapshotGate, type ResidentSnapshotGate } from '../world/soa/terreno.js';

// Transport bounds, independent of world laws and available host hardware.
export const SNAPSHOT_INLINE_TILE_LIMIT = 32768;
export const SNAPSHOT_PAGE_TILES = 4096;
/** Cota del manifiesto heredado. El guardado completo crece hasta los límites de cadena de V8 y fila de SQLite. */
export const SNAPSHOT_METADATA_BYTES = 256 * 1024 * 1024;
const PAGE_BYTES = 4 * 1024 * 1024;
// Upper bound for UTF-8 bytes representable in one JS string. SQLite also enforces its row limit.
const MAX_UTF8_TEXT_BYTES = 3 * constants.MAX_STRING_LENGTH;
const ENCODING_V1 = 'snapshot-parts-v1', ENCODING_V2 = 'snapshot-parts-v2', ENCODING_V3 = 'snapshot-parts-v3';
const ORGANISM_FIELDS = ['people', 'animals'] as const;
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
interface Pages { count: number; pages: Page[]; }
interface ManifestBase { world: Record<string, unknown> & { version: number }; tiles: Pages; }
type Manifest = ManifestBase & ({ snapshotEncoding: typeof ENCODING_V1 } |
  { snapshotEncoding: typeof ENCODING_V2 | typeof ENCODING_V3; people: Pages; animals: Pages; });
type PageFormat = 'tiles' | 'organisms' | 'packedPeople';
type Organisms = Pick<World, typeof ORGANISM_FIELDS[number]>;
/** `metadata` is the exact JSON of the world record with placeholders for its paged collections. */
export interface PreparedSnapshot {
  inline?: string; metadata?: string; tiles: readonly Tile[]; organisms?: Organisms; nativo: boolean;
  faunaVerificada?: readonly TramoFaunaVerificada[];
  teselasVerificadas?: TeselasCorteVerificadas;
}

export function hasCanonicalSnapshotPartsPrefix(body: string): boolean {
  return body.startsWith(`{"snapshotEncoding":"${ENCODING_V1}","world":{`)
    || body.startsWith(`{"snapshotEncoding":"${ENCODING_V2}","world":{`)
    || body.startsWith(`{"snapshotEncoding":"${ENCODING_V3}","world":{`);
}

function* organismPages(manifest: Manifest): IterableIterator<Page> {
  if (manifest.snapshotEncoding !== ENCODING_V1)
    for (const field of ORGANISM_FIELDS) yield* manifest[field].pages;
}

function pageByteLimit(count: number, organisms: boolean): number {
  return organisms && count === 1 ? MAX_UTF8_TEXT_BYTES : PAGE_BYTES;
}

function pageDescriptor(value: unknown, index: number, organisms = false): value is Page {
  return object(value) && keys(value, ['index', 'digest', 'count', 'bytes']) && value.index === index
    && typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest)
    && Number.isSafeInteger(value.count) && (value.count as number) > 0
    && Number.isSafeInteger(value.bytes) && (value.bytes as number) >= 2
    && (value.bytes as number) <= pageByteLimit(value.count as number, organisms);
}
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
  if (!clavesJsonUnicas(body)) failure('duplicate metadata key');
}

function parsePackedPeopleJSON(body: string): unknown {
  const value = parseSnapshotJSON(body);
  assertUniqueKeys(body);
  return value;
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
  private readonly faunaStats = { compared: 0, accepted: 0, rejected: 0, reused: 0 };
  private readonly teselasStats = { reused: 0, recoded: 0 };
  constructor(private readonly db: DatabaseSync, private readonly schemaVersion: number,
    private readonly onProgress?: () => void, private readonly organismPageBytes = PAGE_BYTES,
    private readonly packedPeople = false) {
    if (!Number.isSafeInteger(organismPageBytes) || organismPageBytes < 2 || organismPageBytes > PAGE_BYTES)
      throw new RangeError('Invalid snapshot organism page byte limit.');
  }

  /** Contadores acumulados de diagnóstico: páginas servidas desde el directorio confirmado frente a
   * codificadas (serializar + sha256 + cotejo SQL) por el camino completo. */
  get pageStats(): { reused: number; encoded: number } {
    return { reused: this.pagesReused, encoded: this.pagesEncoded };
  }
  /** Filas remotas cotejadas, rechazadas o reutilizadas desde un corte sellado durante la escritura. */
  get faunaCorteStats(): { compared: number; accepted: number; rejected: number; reused: number } {
    return { ...this.faunaStats };
  }
  /** Filas verificadas reutilizadas o recodificadas por una mutación posterior al corte. */
  get teselasCorteStats(): { reused: number; recoded: number } {
    return { ...this.teselasStats };
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
    // La afinidad TEXT histórica se conserva. SQLite mantiene como BLOB las páginas enlazadas como bytes.
    db.exec('CREATE TABLE main.snapshot_parts (digest TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL)');
  }

  private requireTransaction(): void {
    if (!this.db.isTransaction) throw new Error('Snapshot parts require a coherent transaction.');
  }

  prepare(world: World, params: WorldParams, inlineLimit: number, faunaVerificada?: readonly TramoFaunaVerificada[],
    teselasVerificadas?: TeselasCorteVerificadas): PreparedSnapshot {
    const nativo = params.v23.guardadoCompleto;
    if (!nativo && world.tiles.length <= inlineLimit) return { inline: encodeSnapshot(world, params), tiles: [], nativo };
    // Keep null placeholders to preserve the world's enumerable property order after reloading.
    const record = snapshotRecord(world, params, null);
    const organisms = nativo ? { people: world.people, animals: world.animals } : undefined;
    if (organisms) for (const field of ORGANISM_FIELDS) record[field] = null;
    const metadata = stringifyExact(record, nativo);
    // UTF-8 ocupa como mucho 3 bytes por unidad UTF-16: por debajo de un tercio del tope el cuerpo
    // no puede excederlo y se ahorra re-codificar los metadatos enteros solo para contarlos.
    if (!nativo && metadata.length * 3 > SNAPSHOT_METADATA_BYTES && Buffer.byteLength(metadata) > SNAPSHOT_METADATA_BYTES)
      failure('metadata exceeds transport size');
    return { metadata, tiles: world.tiles, organisms, nativo, faunaVerificada, teselasVerificadas };
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
    const writeTeselasCorte = prepared.nativo && prepared.teselasVerificadas?.tramos.length
      ? this.teselasCortePages(tiles, prepared.teselasVerificadas) : undefined;
    const pages: Page[] = [], pending: CachedPage[] = [], insert = this.db.prepare('INSERT INTO main.snapshot_parts(digest,body) VALUES (?,?)');
    // Probe the key before binding a multi-megabyte body. The caller's write transaction keeps the row stable.
    const present = this.db.prepare('SELECT 1 FROM main.snapshot_parts WHERE digest=?');
    // SQLite compares the stored bytes itself: an unchanged multi-megabyte page is not copied into JS
    // just to prove its identity. BINARY ignores any collation a damaged schema could declare.
    const same = this.db.prepare('SELECT body = ? COLLATE BINARY AS same FROM main.snapshot_parts WHERE digest=?');
    let bytes = 0;
    const writePage = (index: number, body: string | Uint8Array, count: number, organisms = false): Page => {
      const digest = checksum(body), size = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength;
      if (size > pageByteLimit(count, organisms)) failure('page exceeds transport size');
      if (present.get(digest)) {
        const existing = same.get(body, digest) as { same: number } | undefined;
        if (existing?.same !== 1) failure('existing page disagrees with its digest');
      } else insert.run(digest, body);
      bytes += size;
      return { index, digest, count, bytes: size };
    };
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
      const count = Math.min(SNAPSHOT_PAGE_TILES, tiles.length - offset);
      const body = writeTeselasCorte ? writeTeselasCorte(offset, count)
        : JSON.stringify(encodeSnapshotTileRows(tiles, offset, count, prepared.nativo));
      const page = writePage(index, body, count);
      pages.push(page);
      this.pagesEncoded++;
      if (certified) pending.push(this.cachedPage(tiles, offset, page.count, page.digest, page.bytes));
      this.onProgress?.();
    }
    // Byte for byte `stringifyExact(manifest)`: the page descriptors hold only strings and non-negative integers.
    const manifestTiles: Pages = { count: tiles.length, pages }, digests = pages.map(page => page.digest);
    const encoding = prepared.organisms
      ? (prepared.nativo && this.packedPeople ? ENCODING_V3 : ENCODING_V2) : ENCODING_V1;
    let body = `{"snapshotEncoding":"${encoding}","world":${prepared.metadata},"tiles":${JSON.stringify(manifestTiles)}`;
    if (prepared.organisms) {
      const writeOrganismPage = (index: number, page: string | Uint8Array, count: number) => writePage(index, page, count, true);
      for (const field of ORGANISM_FIELDS) {
        const faunaVerificada = field === 'animals' ? prepared.faunaVerificada : undefined;
        const manifest = encoding === ENCODING_V3 && field === 'people'
          ? this.writePackedPeople(prepared.organisms.people, writeOrganismPage)
          : this.writeOrganisms(prepared.organisms[field], writeOrganismPage,
            field === 'animals' && faunaVerificada === undefined ? faunaCorteDe(prepared.organisms.animals) : undefined,
            faunaVerificada);
        for (const page of manifest.pages) digests.push(page.digest);
        body += `,"${field}":${JSON.stringify(manifest)}`;
      }
    }
    body += '}';
    const size = Buffer.byteLength(body), digest = checksum(body);
    if (!prepared.nativo && size > SNAPSHOT_METADATA_BYTES) failure('manifest exceeds transport size');
    this.references.set(digest, digests);
    this.writtenDigest = digest;
    this.unconfirmedPages = certified
      ? { pages: pending, parallel: gate ? { identity: gate.identity, epoch: gate.epoch, serial: gate.serial } : null }
      : null;
    return { body, digest, bytes: bytes + size, pages: digests };
  }

  /** El cursor conserva un tramo que atraviese páginas. Los huecos y las filas sucias consecutivas
   * se codifican juntos con la misma proyección nativa que el guardado sin corte. */
  private teselasCortePages(tiles: Tile[], { tramos, modificadas }: TeselasCorteVerificadas):
    (offset: number, count: number) => string {
    let fin = 0;
    for (const { desde, filas } of tramos) {
      if (!Number.isSafeInteger(desde) || desde < fin || filas.length === 0 || desde + filas.length > tiles.length)
        failure('verified tile range');
      fin = desde + filas.length;
    }
    const raw = residentTopologyToken(tiles) === undefined ? tiles : residentBackingArray(tiles);
    const hayModificadas = modificadas.size > 0;
    const filasCanonicas = (desde: number, count: number) =>
      JSON.stringify(encodeSnapshotTileRows(tiles, desde, count, true)).slice(1, -1);
    let index = 0;
    return (offset, count) => {
      const fin = offset + count, fragmentos: string[] = [];
      let inicioCanonico = offset, reused = 0, recoded = 0;
      for (let tramo = tramos[index]; tramo && tramo.desde < fin; tramo = tramos[++index]) {
        const finTramo = tramo.desde + tramo.filas.length, finFilas = Math.min(fin, finTramo);
        for (let i = Math.max(offset, tramo.desde); i < finFilas; i++) {
          if (hayModificadas && modificadas.has(raw[i]!)) { recoded++; continue; }
          if (inicioCanonico < i) fragmentos.push(filasCanonicas(inicioCanonico, i - inicioCanonico));
          const fila = tramo.filas[i - tramo.desde]!;
          if (typeof fila !== 'string' || !fila.startsWith('[')) failure('verified tile row');
          fragmentos.push(fila);
          inicioCanonico = i + 1;
          reused++;
        }
        if (finTramo > fin) break;
      }
      if (inicioCanonico < fin) fragmentos.push(filasCanonicas(inicioCanonico, fin - inicioCanonico));
      const body = `[${fragmentos.join(',')}]`;
      this.teselasStats.reused += reused;
      this.teselasStats.recoded += recoded;
      return body;
    };
  }

  private *faunaCorteRows(tramos: readonly TramoFaunaCorte[], count: number): Generator<{ index: number; row: string }, void> {
    // UTF-8 estricto y sin quitar el BOM: la igualdad del texto implica igualdad de bytes.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let next = 0;
    for (const { desde, bloques } of tramos) {
      let offset = Number.isSafeInteger(desde) && desde >= 0 ? desde : NaN;
      for (const { filas, cuerpo } of bloques) {
        const index = offset, validCount = Number.isSafeInteger(filas) && filas > 0;
        offset = validCount ? offset + filas : NaN;
        if (!Number.isSafeInteger(offset) || index < next || offset > count || !(cuerpo instanceof Uint8Array)) {
          this.faunaStats.rejected += validCount ? filas : 1;
          continue;
        }
        next = offset;
        let text: string;
        try { text = decoder.decode(cuerpo); }
        catch { this.faunaStats.rejected += filas; continue; }
        const rows = text.split('\n', filas + 1);
        if (rows.length !== filas || rows.some(row => row.length === 0)) {
          this.faunaStats.rejected += filas;
          continue;
        }
        for (let i = 0; i < filas; i++) yield { index: index + i, row: rows[i]! };
      }
    }
  }

  private writeOrganisms(organisms: readonly unknown[], writePage: (index: number, body: string, count: number) => Page,
    faunaCorte?: readonly TramoFaunaCorte[], faunaVerificada?: readonly TramoFaunaVerificada[]): Pages {
    const pages: Page[] = [], rows: string[] = [];
    let bytes = 2; // Opening and closing brackets.
    const flush = () => {
      pages.push(writePage(pages.length, `[${rows.join(',')}]`, rows.length));
      rows.length = 0;
      bytes = 2;
      this.onProgress?.();
    };
    const count = organisms.length;
    if (faunaVerificada) {
      let fin = 0;
      for (const { desde, filas } of faunaVerificada) {
        if (!Number.isSafeInteger(desde) || desde < fin || filas.length === 0 || desde + filas.length > count)
          failure('verified fauna range');
        fin = desde + filas.length;
      }
    }
    const remote = faunaCorte && this.faunaCorteRows(faunaCorte, count);
    let candidate = remote?.next().value;
    let indexTramo = 0, tramo = faunaVerificada?.[0];
    for (let i = 0; i < count; i++) {
      let row: string;
      if (tramo && i >= tramo.desde) {
        const offset = i - tramo.desde;
        row = tramo.filas[offset]!;
        this.faunaStats.reused++;
        if (offset + 1 === tramo.filas.length) tramo = faunaVerificada![++indexTramo];
      } else {
        const organism = organisms[i];
        if (!object(organism)) failure('organism row');
        row = stringifyExact(organism);
      }
      if (typeof row !== 'string' || !row.startsWith('{')) failure('organism row');
      if (candidate?.index === i) {
        this.faunaStats.compared++;
        if (candidate.row === row) {
          this.faunaStats.accepted++;
          row = candidate.row;
        } else this.faunaStats.rejected++;
        candidate = remote!.next().value;
      }
      const size = Buffer.byteLength(row);
      if (rows.length && bytes + size + 1 > this.organismPageBytes) flush();
      bytes += size + Number(rows.length > 0);
      rows.push(row);
      // An oversized organism gets its own page so every row supported by the old transport still fits.
      if (bytes >= this.organismPageBytes) flush();
    }
    if (rows.length) flush();
    return { count, pages };
  }

  private writePackedPeople(people: readonly unknown[], writePage: (index: number, body: Uint8Array, count: number) => Page): Pages {
    const pages: Page[] = [], rows: PackedPersonRow[] = [];
    let rowBytes = 0;
    const flush = () => {
      const body = encodePackedPeoplePage(rows);
      pages.push(writePage(pages.length, body, rows.length));
      rows.length = 0;
      rowBytes = 0;
      this.onProgress?.();
    };
    for (let i = 0; i < people.length; i++) {
      const person = people[i];
      if (!object(person)) failure('organism row');
      const row = preparePackedPerson(person);
      if (rows.length && packedPeoplePageBytes(rows.length + 1, rowBytes + row.bytes) > this.organismPageBytes) flush();
      rows.push(row);
      rowBytes += row.bytes;
      // Como en el formato JSON, un organismo histórico grande puede ocupar su propia página.
      if (packedPeoplePageBytes(rows.length, rowBytes) >= this.organismPageBytes) flush();
    }
    if (rows.length) flush();
    return { count: people.length, pages };
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
    const pagedOrganisms = value.snapshotEncoding === ENCODING_V2 || value.snapshotEncoding === ENCODING_V3;
    const fields = ['snapshotEncoding', 'world', 'tiles'];
    if (pagedOrganisms) fields.push(...ORGANISM_FIELDS);
    if (!keys(value, fields) || (!pagedOrganisms && value.snapshotEncoding !== ENCODING_V1)
      || !object(value.world) || !object(value.tiles)) failure('manifest encoding');
    const world = value.world as Record<string, unknown>, tiles = value.tiles as Record<string, unknown>;
    if (!Object.hasOwn(world, 'tiles') || world.tiles !== null || Object.hasOwn(world, 'snapshotEncoding')
      || world.tileEncoding !== SNAPSHOT_TILE_ENCODING) failure('metadata tile encoding');
    const puedeExcederTope = body.length * 3 > SNAPSHOT_METADATA_BYTES;
    let params: WorldParams | null;
    let limits: Readonly<WorldLimits>;
    try {
      params = validateParams || pagedOrganisms || puedeExcederTope ? readSnapshotParams(world) : null;
      limits = readSnapshotLimits(world, validateParams ? params : null);
    } catch (error) { if (error instanceof SnapshotSemanticError) metadataFailure(error); throw error; }
    if (puedeExcederTope && !params?.v23.guardadoCompleto && Buffer.byteLength(body) > SNAPSHOT_METADATA_BYTES)
      failure('manifest exceeds transport size');
    assertUniqueKeys(body);
    if (!keys(tiles, ['count', 'pages']) || !Number.isSafeInteger(tiles.count) || (tiles.count as number) < (pagedOrganisms ? 0 : 1)
      || !Array.isArray(tiles.pages)
      || tiles.pages.length !== Math.ceil((tiles.count as number) / SNAPSHOT_PAGE_TILES)) failure('tile count');
    try { if (validateParams && params) assertSnapshotCounts(world, limits, params.v23, tiles.count as number); }
    catch (error) { if (error instanceof SnapshotSemanticError) metadataFailure(error); throw error; }
    let count = 0;
    for (const [index, page] of (tiles.pages as unknown[]).entries()) {
      if (!pageDescriptor(page, index) || page.count !== Math.min(SNAPSHOT_PAGE_TILES, (tiles.count as number) - count))
        failure('page descriptor');
      count += page.count;
    }
    if (count !== tiles.count) failure('total tile count');
    if (pagedOrganisms) {
      if (!params?.v23.guardadoCompleto) failure('organism encoding requires complete save');
      for (const field of ORGANISM_FIELDS) {
        if (!Object.hasOwn(world, field) || world[field] !== null) failure('metadata organism encoding');
        this.assertOrganismManifest(value[field], value.snapshotEncoding === ENCODING_V3 && field === 'people');
      }
      const animals = value.animals as Pages;
      if (!params.v23.fauna && animals.count > limits.fauna)
        metadataFailure(new SnapshotSemanticError('Invalid snapshot collection limit. Explicit recovery required.'));
    }
    return value as unknown as Manifest;
  }

  private assertOrganismManifest(value: unknown, packed: boolean): void {
    if (!object(value) || !keys(value, ['count', 'pages']) || !Number.isSafeInteger(value.count)
      || (value.count as number) < 0 || (value.count as number) > 0xffff_ffff || !Array.isArray(value.pages)
      || value.pages.length > (value.count as number)) failure('organism count');
    let count = 0;
    for (const [index, page] of value.pages.entries()) {
      if (!pageDescriptor(page, index, true) || page.bytes < 1 + 3 * page.count) failure('organism page descriptor');
      // Cada objeto JSON ocupa, como mínimo, los dos bytes de sus llaves.
      if (packed && page.bytes < packedPeoplePageBytes(page.count, 2 * page.count)) failure('organism page descriptor');
      count += page.count;
    }
    if (count !== value.count) failure('total organism count');
  }

  private page(page: Page, format: PageFormat = 'tiles'): unknown[] {
    const body = this.db.prepare('SELECT body FROM main.snapshot_parts WHERE digest=?').get(page.digest)?.body;
    const text = typeof body === 'string';
    if ((!text && !(body instanceof Uint8Array)) || (format === 'packedPeople' ? text : !text)
      || checksum(body) !== page.digest)
      throw new SnapshotPhysicalError('Snapshot page missing or checksum mismatch.');
    if ((text ? Buffer.byteLength(body) : body.byteLength) !== page.bytes) failure('page byte count');
    const rows = text ? parseSnapshotJSON(body) : decodePackedPeoplePage(body, page.count, parsePackedPeopleJSON);
    if (!Array.isArray(rows) || rows.length !== page.count) failure('page row count');
    if (format !== 'tiles') {
      if (text) assertUniqueKeys(body);
      if (!rows.every(object)) failure('organism row');
    }
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
      for (const tile of decodeSnapshotTileRows(this.page(page), manifest.world.version)) tiles.push(tile);
      bytes += page.bytes;
      this.onProgress?.();
    }
    const world: Record<string, unknown> = { ...manifest.world, tiles };
    if (manifest.snapshotEncoding !== ENCODING_V1) {
      for (const field of ORGANISM_FIELDS) {
        const format = manifest.snapshotEncoding === ENCODING_V3 && field === 'people' ? 'packedPeople' : 'organisms';
        const rows: unknown[] = [];
        for (const page of manifest[field].pages) {
          for (const row of this.page(page, format)) rows.push(row);
          bytes += page.bytes;
          this.onProgress?.();
        }
        world[field] = rows;
      }
    }
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
    const manifest = this.manifest(value, body);
    for (const page of manifest.tiles.pages) decodeSnapshotTileRows(this.page(page), manifest.world.version);
    if (manifest.snapshotEncoding !== ENCODING_V1) for (const field of ORGANISM_FIELDS) {
      const format = manifest.snapshotEncoding === ENCODING_V3 && field === 'people' ? 'packedPeople' : 'organisms';
      for (const page of manifest[field].pages) this.page(page, format);
    }
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
          if (object(value) && Object.hasOwn(value, 'snapshotEncoding')) {
            const manifest = this.manifest(value, body, false);
            refs = [...manifest.tiles.pages, ...organismPages(manifest)].map(page => page.digest);
          } else refs = [];
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
