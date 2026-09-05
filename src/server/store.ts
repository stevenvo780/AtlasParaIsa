import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Gesture, GestureResult } from '../shared/types.js';
import { migrateWorld, type World } from '../world/index.js';
import { CHUNK_SIZE, MAX_COORDINATE, type Chunk } from '../world/terrain.js';
import { assertEcosystemTile, assertChunkLife } from '../world/validation.js';
import { decodeSnapshot, encodeSnapshot } from './snapshot.js';
import type { LegacyRecord } from '../shared/demography.js';
import { assertLegacyRecord } from '../world/lineage.js';
import { TechnologyArchive } from './technology-archive.js';
import { TECHNOLOGY_ARCHIVE_LAWS_VERSION, type TechnologyDefinition } from '../shared/technology-archive.js';
import type { TechnologyRecipe } from '../shared/technology.js';
import { enableTechnologyJournal, assertTechnologyJournal, technologyStateForCommit, markTechnologyJournalCommitted } from '../world/technology-journal.js';

const checksum = (s: string) => createHash('sha256').update(s).digest('hex');
// Preserve all V1 gesture identities; only the new command kind extends the tuple.
export const fingerprint = (g: Gesture) => checksum(JSON.stringify(g.kind === 'command'
  ? [g.kind, g.x, g.y, g.memoryId ?? null, g.agentId ?? null, g.order ?? null]
  : [g.kind, g.x, g.y, g.memoryId ?? null]));
type Row = { body: string; digest: string; saved_at: number };
type SchemaColumn = { name: string; pk: number };
const BASE_TABLES: Record<string, string[]> = {
  snapshots: ['slot', 'body', 'digest', 'saved_at'], events: ['id', 'tick', 'body'],
  inputs: ['id', 'fingerprint', 'tick', 'ordinal', 'body', 'result'], sessions: ['hash', 'expires'], metadata: ['key', 'value'],
};
const ARCHIVE_SCHEMA = 'CREATE TABLE chunks (key TEXT NOT NULL, tick INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY (key,tick));';
const LEGACY_SCHEMA = 'CREATE TABLE legacy (id TEXT PRIMARY KEY, tick INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL); CREATE INDEX legacy_tick ON legacy(tick);';

function definitionOf(recipe: TechnologyRecipe): TechnologyDefinition {
  const { uses: _uses, utility: _utility, manufactured: _manufactured, ...definition } = recipe;
  return { ...definition, lawsVersion: TECHNOLOGY_ARCHIVE_LAWS_VERSION };
}
const sameStats = (a: { uses: number; utility: number; manufactured: number }, b: TechnologyRecipe) =>
  a.uses === b.uses && a.utility === b.utility && a.manufactured === b.manufactured;
const technologyFailure = (message: string): never => { throw new Error(`Technology archive ${message}. Explicit recovery required.`); };

/** Read-only schema inspection: opening a recovery source must never install tables. */
function assertTechnologySchema(db: DatabaseSync): void {
  for (const [table, names, primary, unique] of [
    ['technology_definitions', ['id', 'tick', 'signature', 'body', 'digest'], ['id'], 'signature'],
    ['technology_stats', ['recipeId', 'tick', 'body', 'digest'], ['recipeId', 'tick'], null],
    ['technology_executions', ['id', 'serial', 'tick', 'body', 'digest'], ['id'], 'serial'],
  ] as const) {
    const columns = db.prepare('SELECT name,type,"notnull",pk FROM pragma_table_info(?)').all(table) as { name: string; type: string; notnull: number; pk: number }[];
    if (JSON.stringify(columns.map(c => c.name)) !== JSON.stringify(names)
      || JSON.stringify(columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name)) !== JSON.stringify(primary)
      || columns.some(c => c.notnull !== 1 || c.type !== (['tick', 'serial'].includes(c.name) ? 'INTEGER' : 'TEXT'))) technologyFailure('schema is incomplete');
    if (unique) {
      const indexes = db.prepare('SELECT name FROM pragma_index_list(?) WHERE "unique"=1 AND partial=0').all(table) as { name: string }[];
      if (!indexes.some(index => {
        const fields = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name) as { name: string }[];
        return fields.length === 1 && fields[0]!.name === unique;
      })) technologyFailure('schema uniqueness is incomplete');
    }
  }
}

function coordinatesFromKey(key: string): { cx: number; cy: number } {
  const pieces = typeof key === 'string' ? key.split(',') : [];
  const cx = Number(pieces[0]), cy = Number(pieces[1]);
  const limit = MAX_COORDINATE / CHUNK_SIZE;
  if (pieces.length !== 2 || !Number.isInteger(cx) || !Number.isInteger(cy) || cx < -limit || cy < -limit || cx >= limit || cy >= limit || `${cx},${cy}` !== key) {
    throw new Error('Invalid archived chunk key. Explicit recovery required.');
  }
  return { cx, cy };
}

/** Validate archived terrain before it re-enters the active world, even if its checksum matches. */
function assertChunk(value: unknown, key: string, atTick: number): asserts value is Chunk {
  const fail = (): never => { throw new Error('Invalid archived chunk state. Explicit recovery required.'); };
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const number = (v: unknown, max = 1): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
  const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => number(v, max) && Number.isInteger(v);
  const string = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length <= max;
  const { cx, cy } = coordinatesFromKey(key);
  const x0 = cx * CHUNK_SIZE, y0 = cy * CHUNK_SIZE;
  if (!object(value) || value.key !== key || value.cx !== cx || value.cy !== cy || typeof value.discovered !== 'boolean' || !integer(value.lastTick, atTick) || !Array.isArray(value.tiles) || value.tiles.length !== CHUNK_SIZE ** 2 || !Array.isArray(value.places) || value.places.length > CHUNK_SIZE ** 2) fail();
  const chunk = value as unknown as Chunk;
  for (let index = 0; index < chunk.tiles.length; index++) {
    const tile = chunk.tiles[index];
    if (!object(tile) || tile.x !== x0 + index % CHUNK_SIZE || tile.y !== y0 + Math.floor(index / CHUNK_SIZE) || !['water', 'soil', 'meadow', 'shelter'].includes(String(tile.terrain)) || !number(tile.moisture) || !number(tile.vegetation) || !number(tile.food) || (tile.elevation !== undefined && !number(tile.elevation)) || (tile.wood !== undefined && !number(tile.wood, 12)) || (tile.stone !== undefined && !number(tile.stone, 8)) || (tile.biome !== undefined && !['grassland', 'forest', 'desert', 'mountain', 'wetland', 'ocean'].includes(String(tile.biome)))) fail();
    assertEcosystemTile(tile, false);
  }
  const ids = new Set<string>();
  for (const place of chunk.places) {
    if (!object(place) || !string(place.id, 200) || ids.has(place.id) || !string(place.name, 200) || !string(place.description) || !integer(place.gatherings, 1_000_000) || !Number.isInteger(place.x) || !Number.isInteger(place.y) || place.x < x0 || place.x >= x0 + CHUNK_SIZE || place.y < y0 || place.y >= y0 + CHUNK_SIZE) fail();
    ids.add(place.id);
  }
  assertChunkLife(chunk, atTick);
}
export class GestureConflict extends Error {}
export class SessionRevoked extends Error {}
export class Store {
  readonly db: DatabaseSync;
  readonly technologyArchive: TechnologyArchive;
  lastSnapshotBytes = 0;
  private readonly schemaVersion: number;
  private verifiedTechnology: { startsAfter: number; through: number; dataVersion: number; totalChanges: number } | null = null;
  private verifiedRecipes = new Map<string, { body: string; uses: number; utility: number; manufactured: number }>();
  constructor(readonly path: string, options: { readOnly?: boolean } = {}) {
    const existed = path !== ':memory:' && existsSync(path);
    if (path !== ':memory:' && !options.readOnly) mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    this.technologyArchive = new TechnologyArchive(this.db);
    let schemaVersion = existed ? 0 : 4;
    try {
      if (existed) {
        const marker = this.db.prepare('PRAGMA application_id').get() as { application_id: number };
        const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
        if (marker.application_id !== 1128354388 || ![1, 2, 3, 4].includes(version.user_version)) throw new Error('Unrecognized database or schema version. Explicit recovery required.');
        schemaVersion = version.user_version;
        for (const [table, columns] of Object.entries(BASE_TABLES)) {
          const actual = (this.db.prepare(`PRAGMA table_info(${table})`).all() as SchemaColumn[]).map(row => row.name);
          if (JSON.stringify(actual) !== JSON.stringify(columns)) throw new Error('Database schema is incomplete. Explicit recovery required.');
        }
        if (schemaVersion >= 2) {
          const columns = this.db.prepare('PRAGMA table_info(chunks)').all() as SchemaColumn[];
          const primary = columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
          if (JSON.stringify(columns.map(c => c.name)) !== JSON.stringify(['key', 'tick', 'body', 'digest']) || JSON.stringify(primary) !== JSON.stringify(['key', 'tick'])) throw new Error('Archive schema is incomplete. Explicit recovery required.');
        }
        if (schemaVersion >= 3) {
          const columns = this.db.prepare('PRAGMA table_info(legacy)').all() as SchemaColumn[];
          if (JSON.stringify(columns.map(c=>c.name))!==JSON.stringify(['id','tick','body','digest']) || columns.find(c=>c.name==='id')?.pk!==1) throw new Error('Identity archive schema is incomplete. Explicit recovery required.');
        }
        if (schemaVersion >= 4) assertTechnologySchema(this.db);
      }
      if (!options.readOnly) {
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');
        if (!existed || schemaVersion < 4) {
          this.db.exec('BEGIN IMMEDIATE');
          try {
            if (!existed) this.db.exec(`
              CREATE TABLE snapshots (slot INTEGER PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL, saved_at INTEGER NOT NULL);
              CREATE TABLE events (id TEXT PRIMARY KEY, tick INTEGER NOT NULL, body TEXT NOT NULL);
              CREATE TABLE inputs (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, tick INTEGER NOT NULL, ordinal INTEGER NOT NULL, body TEXT NOT NULL, result TEXT NOT NULL);
              CREATE TABLE sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
              CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
            if (!existed || schemaVersion === 1) this.db.exec(ARCHIVE_SCHEMA);
            if (!existed || schemaVersion < 3) this.db.exec(LEGACY_SCHEMA);
            this.technologyArchive.installSchema();
            this.db.exec('PRAGMA application_id=1128354388; PRAGMA user_version=4; COMMIT;');
            schemaVersion = 4;
          } catch (error) {
            if (this.db.isTransaction) this.db.exec('ROLLBACK');
            throw error;
          }
        }
      }
      this.schemaVersion = schemaVersion;
    } catch (error) { this.db.close(); throw error; }
  }
  load(): { world: World; savedAt: number } | null {
    const check = this.db.prepare('PRAGMA quick_check').get() as Record<string, unknown>;
    if (Object.values(check)[0] !== 'ok') throw new Error('SQLite integrity check failed. Explicit recovery required.');
    const row = this.db.prepare('SELECT body,digest,saved_at FROM snapshots WHERE slot=0').get() as Row | undefined;
    if (!row) {
      const initialized = this.db.prepare("SELECT value FROM metadata WHERE key='initialized'").get();
      if (initialized) throw new Error('Snapshot missing from initialized database. Explicit recovery required.');
      return null;
    }
    if (checksum(row.body) !== row.digest) throw new Error('Snapshot checksum mismatch. Explicit recovery required.');
    const world = migrateWorld(decodeSnapshot(row.body));
    const declaredJournal = world.technology.journal !== undefined;
    enableTechnologyJournal(world.technology);
    assertTechnologyJournal(world.technology, world.tick);
    if (declaredJournal) {
      if (world.technology.journal!.pending.length || world.technology.journal!.committedThrough !== world.technology.executionCounter) technologyFailure('snapshot contains uncommitted executions');
      this.assertTechnologyCoverage(world);
      if (this.schemaVersion >= 4) this.assertTechnologyCache(world);
    }
    // A migrated global allocator must remain above every archived identity, too.
    // Otherwise a corrupted counter could allocate an ID already living in a dormant region.
    if(this.schemaVersion>=2) {
      const archived=this.db.prepare("SELECT MAX(CAST(substr(json_extract(s.value,'$.id'),11) AS INTEGER)) AS maximum FROM chunks c, json_each(c.body,'$.structures') s WHERE c.tick<=? AND json_extract(s.value,'$.id') GLOB 'structure-[0-9]*'").get(world.tick) as {maximum:number|null};
      if(archived.maximum!==null&&(!Number.isSafeInteger(archived.maximum)||archived.maximum>world.structureCounter))throw new Error('Archived structure identity exceeds snapshot counter. Explicit recovery required.');
      const animals=this.db.prepare("SELECT DISTINCT json_extract(a.value,'$.id') AS id FROM chunks c, json_each(c.body,'$.animals') a WHERE c.tick<=? AND json_extract(a.value,'$.generation')>0").all(world.tick) as {id:string}[];
      for(const animal of animals){const serial=/^animal-born-\d+-\d+-([1-9]\d*)$/.exec(animal.id);if(serial&&(!Number.isSafeInteger(Number(serial[1]))||Number(serial[1])>world.animalCounter))throw new Error('Archived animal identity exceeds snapshot counter. Explicit recovery required.');}
    }
    if (this.schemaVersion>=3) {
      const count=this.db.prepare('SELECT COUNT(*) AS count FROM legacy WHERE tick<=?').get(world.tick) as {count:number};
      if (count.count!==world.demographyDynamics.deaths) throw new Error('Identity archive count disagrees with snapshot. Explicit recovery required.');
      for (const record of world.legacy) {
        const archived=this.loadLegacy(record.id,world.tick);
        if (!archived || JSON.stringify(archived)!==JSON.stringify(record)) throw new Error('Cached identity disagrees with archive. Explicit recovery required.');
        this.assertLegacyParents(record,world);
      }
      const serial=this.db.prepare("SELECT MAX(CAST(substr(id,12) AS INTEGER)) AS maximum FROM legacy WHERE tick<=? AND id GLOB 'descendant-[0-9]*'").get(world.tick) as {maximum:number|null};
      if (serial.maximum!==null&&(!Number.isSafeInteger(serial.maximum)||serial.maximum>world.birthCounter)) throw new Error('Archived human identity exceeds snapshot counter. Explicit recovery required.');
      for (const person of world.people) if(this.loadLegacy(person.id,world.tick)) throw new Error('A deceased identity is present among living inhabitants. Explicit recovery required.');
    }
    if (declaredJournal && this.schemaVersion >= 4) this.rememberTechnology(world);
    return { world, savedAt: row.saved_at };
  }
  loadLegacy(id: string, atTick=Number.MAX_SAFE_INTEGER): LegacyRecord | null {
    if (typeof id!=='string'||!id.length||id.length>50||!Number.isSafeInteger(atTick)||atTick<0) throw new RangeError('Invalid identity archive lookup.');
    if (this.schemaVersion<3) return null;
    const row=this.db.prepare('SELECT body,digest,tick FROM legacy WHERE id=? AND tick<=?').get(id,atTick) as {body:string;digest:string;tick:number}|undefined;
    if (!row) return null;
    if (checksum(row.body)!==row.digest) throw new Error('Archived identity checksum mismatch. Explicit recovery required.');
    const record:unknown=JSON.parse(row.body); assertLegacyRecord(record,atTick);
    if(record.id!==id||record.diedAt!==row.tick) throw new Error('Archived identity key or date mismatch. Explicit recovery required.');
    return record;
  }
  private assertLegacyParents(record: LegacyRecord, world: World): void {
    const parents=record.parents.map(id=>world.people.find(p=>p.id===id)??world.retiredLegacy.find(p=>p.id===id)??this.loadLegacy(id,world.tick));
    if (parents.some(p=>!p||p.id===record.id||p.bornAt>=record.bornAt||('diedAt' in p&&p.diedAt<record.bornAt)||p.genome.generation>=record.generation) || (parents.length&&record.generation!==Math.max(...parents.map(p=>p!.genome.generation))+1)) throw new Error('Archived genealogy is inconsistent. Explicit recovery required.');
  }
  loadChunk(key: string, atTick = Number.MAX_SAFE_INTEGER): Chunk | null {
    coordinatesFromKey(key);
    if (!Number.isSafeInteger(atTick) || atTick < 0) throw new RangeError('Invalid archive lookup tick.');
    // Read-only recovery of a V1 database never silently creates an archive or alters its schema.
    if (this.schemaVersion === 1) return null;
    const row = this.db.prepare('SELECT body,digest,tick FROM chunks WHERE key=? AND tick<=? ORDER BY tick DESC LIMIT 1').get(key, atTick) as { body: string; digest: string; tick: number } | undefined;
    if (!row) return null;
    if (!Number.isSafeInteger(row.tick) || row.tick < 0 || checksum(row.body) !== row.digest) throw new Error('Archived chunk checksum or version mismatch. Explicit recovery required.');
    const chunk: unknown = JSON.parse(row.body);
    assertChunk(chunk, key, row.tick);
    return chunk;
  }

  private dataVersion(): number { return Number(this.db.prepare('PRAGMA data_version').get()!.data_version); }
  private totalChanges(): number { return Number(this.db.prepare('SELECT total_changes() AS n').get()!.n); }

  /** A declared prefix is verified once on load, not scanned at the 10 Hz save cadence. */
  private assertTechnologyCoverage(world: World): void {
    const state = world.technology, journal = state.journal!;
    if (this.schemaVersion < 4) {
      if (journal.committedThrough !== journal.startsAfter) technologyFailure('coverage has no backing schema');
      return;
    }
    let serial = journal.startsAfter;
    const recent = new Map(state.history.map(receipt => [receipt.id, receipt]));
    while (serial < journal.committedThrough) {
      const page = this.technologyArchive.listExecutions({ afterSerial: serial, asOfTick: world.tick,
        limit: Math.min(1000, journal.committedThrough - serial) });
      if (!page.length) technologyFailure('declared execution coverage is incomplete');
      for (const receipt of page) {
        if (receipt.id !== `process-${++serial}`) technologyFailure('declared execution coverage has a gap');
        const cached = recent.get(receipt.id);
        if (cached && JSON.stringify(cached) !== JSON.stringify(receipt)) technologyFailure('cached execution disagrees with archive');
      }
    }
  }

  private assertTechnologyCache(world: World): void {
    const state = world.technology;
    // V5 still retains every definition (the 256 cap is unchanged by this integration).
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM technology_definitions WHERE tick<=?').get(world.tick) as { count: number };
    if (count.count !== state.recipes.length) technologyFailure('definition cache disagrees with archive');
    for (const recipe of state.recipes) {
      const definition = this.technologyArchive.getDefinition(recipe.id, world.tick), stats = this.technologyArchive.getStats(recipe.id, world.tick);
      if (!definition || JSON.stringify(definition) !== JSON.stringify(definitionOf(recipe))) technologyFailure('cached definition disagrees with archive');
      if (!stats || !sameStats(stats, recipe)) technologyFailure('cached statistics disagree with archive');
    }
    const latest = this.db.prepare('SELECT serial FROM technology_executions WHERE tick<=? ORDER BY serial DESC LIMIT 1').get(world.tick) as { serial: number } | undefined;
    if (latest && latest.serial > state.executionCounter) technologyFailure('execution identity exceeds snapshot counter');
  }

  private rememberTechnology(world: World): void {
    const state = world.technology, journal = state.journal!;
    this.verifiedTechnology = { startsAfter: journal.startsAfter, through: journal.committedThrough,
      dataVersion: this.dataVersion(), totalChanges: this.totalChanges() };
    this.verifiedRecipes = new Map(state.recipes.map(recipe => [recipe.id, { body: JSON.stringify(definitionOf(recipe)),
      uses: recipe.uses, utility: recipe.utility, manufactured: recipe.manufactured }]));
  }

  /** All writes use the host transaction. Neither this helper nor a failed save clears queues. */
  private flushTechnology(world: World, recovering = false): void {
    const state = world.technology, journal = state.journal!;
    assertTechnologyJournal(state, world.tick);
    const verified = this.verifiedTechnology;
    if (!verified || verified.startsAfter !== journal.startsAfter || verified.through !== journal.committedThrough
      || verified.dataVersion !== this.dataVersion() || verified.totalChanges !== this.totalChanges()) {
      this.verifiedRecipes.clear();
      if (!recovering) {
        // Validate the durable baseline BEFORE any idempotent writes. Otherwise a
        // deleted definition/statistics row could be silently rebuilt from the candidate.
        const row = this.db.prepare('SELECT body,digest FROM snapshots WHERE slot=0').get() as Row | undefined;
        if (row) {
          if (checksum(row.body) !== row.digest) technologyFailure('baseline snapshot checksum mismatch');
          const baseline = migrateWorld(decodeSnapshot(row.body));
          if (baseline.technology.journal !== undefined) {
            const committed = baseline.technology.journal;
            assertTechnologyJournal(baseline.technology, baseline.tick);
            if (committed.pending.length || committed.committedThrough !== baseline.technology.executionCounter) technologyFailure('baseline snapshot contains uncommitted executions');
            this.assertTechnologyCoverage(baseline); this.assertTechnologyCache(baseline);
            if (journal.startsAfter !== committed.startsAfter || journal.committedThrough !== committed.committedThrough) technologyFailure('candidate changed the committed coverage boundary');
            this.rememberTechnology(baseline);
          }
        }
        this.assertTechnologyCoverage(world);
      }
    }
    const latest = this.db.prepare('SELECT serial FROM technology_executions ORDER BY serial DESC LIMIT 1').get() as { serial: number } | undefined;
    if (latest && latest.serial > state.executionCounter) technologyFailure('cannot move behind archived executions');
    for (const recipe of [...state.recipes].sort((a, b) => a.generation - b.generation || a.id.localeCompare(b.id))) {
      const definition = definitionOf(recipe), cached = this.verifiedRecipes.get(recipe.id);
      if (!cached || cached.body !== JSON.stringify(definition)) this.technologyArchive.putDefinition(definition);
    }
    for (const recipe of state.recipes) {
      const previous = this.verifiedRecipes.get(recipe.id) ?? this.technologyArchive.getStats(recipe.id, world.tick);
      if (!previous || !sameStats(previous, recipe)) this.technologyArchive.putStats(recipe.id, world.tick,
        { uses: recipe.uses, utility: recipe.utility, manufactured: recipe.manufactured });
    }
    for (const receipt of journal.pending) this.technologyArchive.putExecution(receipt);
  }

  save(world: World, inputs: { gesture: Gesture; result: GestureResult }[] = [], requiredSessions: string[] = []): void {
    const retired = world.retiredChunks;
    enableTechnologyJournal(world.technology);
    assertTechnologyJournal(world.technology, world.tick);
    const body = encodeSnapshot({ ...world, technology: technologyStateForCommit(world.technology) });
    this.lastSnapshotBytes = Buffer.byteLength(body);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Authorization and commit share a transaction with respect to external revocation.
      if (requiredSessions.some(hash => !this.sessionValid(hash))) throw new SessionRevoked('Session revoked before commit.');
      this.flushTechnology(world);
      const archiveIdentity=this.db.prepare('INSERT INTO legacy VALUES (?,?,?,?)');
      for (const record of world.retiredLegacy) {
        assertLegacyRecord(record,world.tick); this.assertLegacyParents(record,world);
        const prior=this.loadLegacy(record.id);
        const archivedBody=JSON.stringify(record);
        if (prior) { if(JSON.stringify(prior)!==archivedBody) throw new Error('An archived identity cannot be overwritten. Explicit recovery required.'); }
        else archiveIdentity.run(record.id,record.diedAt,archivedBody,checksum(archivedBody));
      }
      if (retired.length) {
        const archive = this.db.prepare('INSERT OR REPLACE INTO chunks VALUES (?,?,?,?)');
        for (const chunk of retired) {
          assertChunk(chunk, chunk.key, world.tick);
          const archivedBody = JSON.stringify(chunk);
          archive.run(chunk.key, world.tick, archivedBody, checksum(archivedBody));
        }
      }
      this.db.exec('INSERT OR REPLACE INTO snapshots SELECT 1,body,digest,saved_at FROM snapshots WHERE slot=0');
      this.db.prepare('INSERT OR REPLACE INTO snapshots VALUES (0,?,?,?)').run(body, checksum(body), Date.now());
      this.db.prepare("INSERT OR REPLACE INTO metadata VALUES ('initialized','1')").run();
      const insertEvent = this.db.prepare('INSERT OR IGNORE INTO events VALUES (?,?,?)');
      for (const event of world.events) insertEvent.run(event.id, event.tick, JSON.stringify(event));
      const insertInput = this.db.prepare('INSERT INTO inputs VALUES (?,?,?,?,?,?)');
      for (const { gesture, result } of inputs) insertInput.run(gesture.id, fingerprint(gesture), result.tick, result.order, JSON.stringify(gesture), JSON.stringify(result));
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
    // A discarded transaction must leave the caller's pending archive queue intact for a retry.
    world.retiredChunks = [];
    world.retiredLegacy = [];
    markTechnologyJournalCommitted(world.technology);
    this.rememberTechnology(world);
  }
  result(gesture: Gesture): GestureResult | null {
    const row = this.db.prepare('SELECT fingerprint,result FROM inputs WHERE id=?').get(gesture.id) as { fingerprint: string; result: string } | undefined;
    if (!row) return null;
    if (row.fingerprint !== fingerprint(gesture)) throw new GestureConflict('Ese identificador ya se usó para otro gesto.');
    return JSON.parse(row.result) as GestureResult;
  }
  addSession(hash: string, expires: number) {
    this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES (?,?)').run(hash, expires);
  }
  sessionValid(hash: string): boolean {
    const row = this.db.prepare('SELECT expires FROM sessions WHERE hash=?').get(hash) as { expires: number } | undefined;
    return !!row && row.expires > Date.now();
  }
  revoke(hash?: string) {
    if (hash) this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash);
    else this.db.exec('DELETE FROM sessions');
  }
  backup(destination: string) {
    if (existsSync(destination)) throw new Error('Backup destination exists; choose a new path.');
    mkdirSync(dirname(resolve(destination)), { recursive: true, mode: 0o700 });
    this.db.prepare('VACUUM INTO ?').run(resolve(destination));
  }
  previous(destination: string) {
    const row = this.db.prepare('SELECT body,digest,saved_at FROM snapshots WHERE slot=1').get() as Row | undefined;
    if (!row || checksum(row.body) !== row.digest) throw new Error('No valid previous checkpoint.');
    const world = migrateWorld(decodeSnapshot(row.body));
    const declaredJournal = world.technology.journal !== undefined;
    enableTechnologyJournal(world.technology);
    assertTechnologyJournal(world.technology, world.tick);
    if (declaredJournal && (world.technology.journal!.pending.length || world.technology.journal!.committedThrough !== world.technology.executionCounter)) technologyFailure('previous snapshot contains uncommitted executions');
    this.backup(destination);
    const recovered = new Store(destination);
    try {
      recovered.db.exec('BEGIN IMMEDIATE');
      // Two snapshots may share a tick. Their serial/recipe boundaries still differ.
      recovered.db.prepare('DELETE FROM technology_executions WHERE serial>?').run(world.technology.executionCounter);
      recovered.db.prepare('DELETE FROM technology_stats WHERE recipeId IN (SELECT id FROM technology_definitions WHERE CAST(substr(id,8) AS INTEGER)>?)').run(world.technology.recipeCounter);
      recovered.db.prepare('DELETE FROM technology_definitions WHERE CAST(substr(id,8) AS INTEGER)>?').run(world.technology.recipeCounter);
      recovered.technologyArchive.truncateAfter(world.tick);
      if (declaredJournal) {
        recovered.assertTechnologyCoverage(world);
        recovered.assertTechnologyCache(world);
      }
      // A pre-journal checkpoint has surviving receipts in memory, not a backed watermark.
      recovered.flushTechnology(world, true);
      const body = encodeSnapshot({ ...world, technology: technologyStateForCommit(world.technology) });
      recovered.db.prepare('UPDATE snapshots SET body=?,digest=?,saved_at=? WHERE slot=0').run(body, checksum(body), row.saved_at);
      recovered.db.prepare('DELETE FROM inputs WHERE tick>?').run(world.tick);
      recovered.db.prepare('DELETE FROM events WHERE tick>?').run(world.tick);
      recovered.db.prepare('DELETE FROM chunks WHERE tick>?').run(world.tick);
      recovered.db.prepare('DELETE FROM legacy WHERE tick>?').run(world.tick);
      for (const event of recovered.db.prepare('SELECT id FROM events WHERE tick=?').all(world.tick) as {id:string}[]) {
        if (!world.events.some(e => e.id === event.id)) recovered.db.prepare('DELETE FROM events WHERE id=?').run(event.id);
      }
      recovered.revoke(); recovered.db.exec('COMMIT'); recovered.load();
    } catch (error) { if (recovered.db.isTransaction) recovered.db.exec('ROLLBACK'); throw error; }
    finally { recovered.close(); }
  }
  close() { this.db.close(); }
}
