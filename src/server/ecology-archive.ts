import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { World } from '../world/index.js';
import type { Chunk } from '../world/terrain.js';
import { assertChunkLife, assertDormantTerrain } from '../world/validation.js';
import { assertClimateWindow, type ClimateObservation } from '../world/offscreen-kernel.js';
import { assertEcologyState, assertRegionKey, ecologyStateForCommit, type EcologyReader, type EcologyState, type EcologySummary, type RegionHead } from '../world/offscreen-state.js';

const digest = (body: string) => createHash('sha256').update(body).digest('hex');
const fail = (): never => { throw new Error('Ecology archive integrity or retained revision mismatch. Explicit recovery required.'); };
type Row = { key: string; tick: number; body: string | null; digest: string | null };
type Header = { revision: number; tick: number; eventCounter: number; state: EcologyState };
const TABLES = {
  ecology_headers: ['slot', 'revision', 'tick', 'body', 'digest'],
  ecology_heads: ['key', 'tick', 'body', 'digest'],
  ecology_previous: ['key', 'tick', 'body', 'digest'],
  ecology_climate: ['tick', 'weather', 'digest'],
  ecology_identities: ['id', 'key', 'kind'],
};

/** Two exact checkpoint views: current materialized heads and inverse deltas for
 * previous. A new commit overwrites only changed heads. Older ecological views
 * are deliberately not retained; the separate old chunks history is untouched. */
export class EcologyArchive implements EcologyReader {
  constructor(readonly db: DatabaseSync) {}
  installSchema(): void {
    this.db.exec(`CREATE TABLE ecology_headers (slot INTEGER PRIMARY KEY CHECK(slot IN (0,1)), revision INTEGER NOT NULL, tick INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE TABLE ecology_heads (key TEXT NOT NULL PRIMARY KEY, tick INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE INDEX ecology_heads_time ON ecology_heads(tick,key);
      CREATE TABLE ecology_previous (key TEXT NOT NULL PRIMARY KEY, tick INTEGER NOT NULL, body TEXT, digest TEXT);
      CREATE INDEX ecology_previous_time ON ecology_previous(tick,key);
      CREATE TABLE ecology_climate (tick INTEGER PRIMARY KEY, weather TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE TABLE ecology_identities (id TEXT NOT NULL PRIMARY KEY, key TEXT NOT NULL, kind TEXT NOT NULL);
      CREATE INDEX ecology_identities_region ON ecology_identities(key);`);
  }
  assertSchema(): void {
    for (const [table, columns] of Object.entries(TABLES)) {
      const actual = this.db.prepare('SELECT name,type,"notnull",pk FROM pragma_table_info(?)').all(table) as { name: string; type:string; notnull:number; pk: number }[];
      if (JSON.stringify(actual.map(column => column.name)) !== JSON.stringify(columns) || actual[0]?.pk !== 1
        || actual.slice(1).some(column => column.pk !== 0)) fail();
      for (const column of actual) {
        const integer = ['slot','revision','tick'].includes(column.name);
        const nullable = column.pk && integer || table === 'ecology_previous' && ['body','digest'].includes(column.name);
        if (column.type !== (integer ? 'INTEGER' : 'TEXT') || column.notnull !== (nullable ? 0 : 1)) fail();
      }
    }
  }
  private header(slot: number): Header | null {
    const row = this.db.prepare('SELECT revision,tick,body,digest FROM ecology_headers WHERE slot=?').get(slot) as { revision: number; tick: number; body: string; digest: string } | undefined;
    if (!row) return null;
    if (digest(row.body) !== row.digest) fail();
    const header: Header = JSON.parse(row.body);
    if (!header || header.revision !== row.revision || header.tick !== row.tick || !header.state
      || header.state.revision !== header.revision || header.state.committedRevision !== header.revision
      || header.state.pending.length || header.state.pendingClimate.length || !Array.isArray(header.state.pendingEvents) || header.state.pendingEvents.length
      || !Number.isSafeInteger(header.tick) || header.tick < 0 || !Number.isSafeInteger(header.eventCounter) || header.eventCounter < 0) fail();
    return header;
  }
  private slot(revision: number): 0 | 1 | null {
    if (!Number.isSafeInteger(revision) || revision < 0) fail();
    const current = this.header(0);
    if (!current) {
      if (revision !== 0 || this.header(1) || Object.keys(TABLES).some(table => table !== 'ecology_headers' && this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) fail();
      return null;
    }
    if (revision === current.revision) return 0;
    if (revision === this.header(1)?.revision) return 1;
    return fail();
  }
  private decode(row: Row, atTick: number): Chunk | null {
    if (row.body === null) { if (row.digest !== null) fail(); return null; }
    if (typeof row.body !== 'string' || digest(row.body) !== row.digest) fail();
    const chunk: Chunk = JSON.parse(row.body);
    if (!chunk || chunk.key !== row.key || chunk.lastTick !== row.tick || row.tick > atTick) fail();
    assertDormantTerrain(chunk, row.tick, true); assertChunkLife(chunk, row.tick);
    return chunk;
  }
  read(key: string, revision: number): Chunk | null {
    assertRegionKey(key);
    const slot = this.slot(revision); if (slot === null) return null;
    const row = (slot === 1 ? this.db.prepare('SELECT * FROM ecology_previous WHERE key=?').get(key) : null)
      ?? this.db.prepare('SELECT * FROM ecology_heads WHERE key=?').get(key);
    return row ? this.decode(row as Row, this.header(slot)!.tick) : null;
  }
  private view(slot: 0 | 1): string {
    return slot === 0 ? 'SELECT key,tick,body,digest FROM ecology_heads' : `SELECT key,tick,body,digest FROM ecology_previous WHERE body IS NOT NULL
      UNION ALL SELECT key,tick,body,digest FROM ecology_heads h WHERE NOT EXISTS (SELECT 1 FROM ecology_previous p WHERE p.key=h.key)`;
  }
  oldest(revision: number, limit: number, excluded: string[], cursor: string | null): RegionHead[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512 || !Array.isArray(excluded) || excluded.length > 1024) fail();
    excluded.forEach(assertRegionKey); if (cursor !== null) assertRegionKey(cursor);
    const slot = this.slot(revision); if (slot === null) return [];
    // Read indexed time groups and rotate their key range. ORDER BY a computed
    // cursor expression would sort a whole equal-time population before LIMIT.
    // Each range is bounded by the requested result and the excluded queue.
    const rows: {key:string;tick:number}[] = [], excludedJson = JSON.stringify(excluded);
    let afterTick = -1;
    while (rows.length < limit) {
      const first = this.db.prepare(`SELECT tick FROM (${this.view(slot)}) WHERE tick>? AND key NOT IN (SELECT value FROM json_each(?))
        ORDER BY tick,key LIMIT 1`).get(afterTick, excludedJson) as {tick:number}|undefined;
      if (!first) break;
      rows.push(...this.db.prepare(`SELECT key,tick FROM (${this.view(slot)}) WHERE tick=? AND (? IS NULL OR key>?)
        AND key NOT IN (SELECT value FROM json_each(?)) ORDER BY key LIMIT ?`).all(first.tick,cursor,cursor,excludedJson,limit-rows.length) as {key:string;tick:number}[]);
      if (cursor !== null && rows.length < limit) rows.push(...this.db.prepare(`SELECT key,tick FROM (${this.view(slot)}) WHERE tick=? AND key<=?
        AND key NOT IN (SELECT value FROM json_each(?)) ORDER BY key LIMIT ?`).all(first.tick,cursor,excludedJson,limit-rows.length) as {key:string;tick:number}[]);
      afterTick = first.tick;
    }
    return rows.map(row => { assertRegionKey(row.key); return { key: row.key, asOfTick: row.tick }; });
  }
  summary(revision: number): EcologySummary {
    const slot = this.slot(revision); return slot === null ? { regions: 0, sumTicks: 0, oldestTick: null } : { ...this.header(slot)!.state.summary };
  }
  climate(from: number, through: number, revision: number): ClimateObservation[] {
    const slot = this.slot(revision); if (slot === null) return [];
    if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(through) || through < from || through - from > 64 || through > this.header(slot)!.tick) fail();
    const rows = this.db.prepare(`SELECT tick,weather,digest FROM ecology_climate WHERE tick=(SELECT MAX(tick) FROM ecology_climate WHERE tick<=?)
      OR tick>? AND tick<=? ORDER BY tick`).all(from, from, through) as { tick: number; weather: 'clear' | 'rain'; digest: string }[];
    for (const row of rows) if (digest(JSON.stringify([row.tick, row.weather])) !== row.digest) fail();
    const observations = rows.map(({ tick, weather }) => ({ tick, weather })); assertClimateWindow(observations, from, through); return observations;
  }
  assertWorld(world: World): void {
    assertEcologyState(world);
    if (!world.ecology) { if (this.slot(0) !== null) fail(); return; }
    const state = world.ecology, slot = this.slot(state.committedRevision);
    if (slot === null || state.pending.length || state.pendingClimate.length || state.pendingEvents.length || state.revision !== state.committedRevision
      || JSON.stringify(this.header(slot)!.state) !== JSON.stringify(state) || this.header(slot)!.tick !== world.tick
      || this.header(slot)!.eventCounter !== world.eventCounter) fail();
    let regions = 0, sumTicks = 0, oldestTick: number | null = null;
    let identityCount = 0;
    for (const row of this.db.prepare(this.view(slot!)).iterate() as Iterable<Row>) {
      const chunk = this.decode(row, world.tick)!;
      if (world.chunks[chunk.key]) fail();
      regions++; sumTicks += chunk.lastTick; oldestTick = Math.min(oldestTick ?? chunk.lastTick, chunk.lastTick);
      for (const animal of chunk.animals ?? []) {
        identityCount++;
        if (slot === 0) {
          const index = this.db.prepare('SELECT key,kind FROM ecology_identities WHERE id=?').get(animal.id);
          if (index?.key !== chunk.key || index.kind !== 'animal') fail();
        }
        const serial = /^animal-born-\d+-\d+-([1-9]\d*)$/.exec(animal.id);
        if (serial && (!Number.isSafeInteger(Number(serial[1])) || Number(serial[1]) > world.animalCounter)) fail();
        if (world.animals.some(active => active.id === animal.id)) fail();
      }
      for (const structure of chunk.structures ?? []) {
        identityCount++;
        if (slot === 0) {
          const index = this.db.prepare('SELECT key,kind FROM ecology_identities WHERE id=?').get(structure.id);
          if (index?.key !== chunk.key || index.kind !== 'structure') fail();
        }
        const serial = /^structure-([1-9]\d*)$/.exec(structure.id);
        if (serial && (!Number.isSafeInteger(Number(serial[1])) || Number(serial[1]) > world.structureCounter)) fail();
        if (world.structures.some(active => active.id === structure.id)) fail();
      }
    }
    if (slot === 0 && this.db.prepare('SELECT COUNT(*) AS n FROM ecology_identities').get()!.n !== identityCount) fail();
    // Previous is reconstructed from inverse deltas, so its global identities
    // are checked in SQL without retaining every animal or structure in JS.
    if (slot === 1 && this.db.prepare(`SELECT id FROM (
      SELECT json_extract(a.value,'$.id') AS id FROM (${this.view(1)}) h,json_each(h.body,'$.animals') a
      UNION ALL SELECT json_extract(s.value,'$.id') AS id FROM (${this.view(1)}) h,json_each(h.body,'$.structures') s
      ) GROUP BY id HAVING COUNT(*)>1 LIMIT 1`).get()) fail();
    if (JSON.stringify({ regions, sumTicks, oldestTick }) !== JSON.stringify(state.summary)) fail();
    // Read chronologically without retaining lifetime weather in the snapshot.
    let expected = 0, latestWeather: string | undefined;
    for (const row of this.db.prepare('SELECT tick,weather,digest FROM ecology_climate WHERE tick<=? ORDER BY tick').iterate(world.tick) as Iterable<{tick:number;weather:string;digest:string}>) {
      if (row.tick !== expected || !['clear','rain'].includes(row.weather) || digest(JSON.stringify([row.tick,row.weather])) !== row.digest) fail();
      expected += 600;
      latestWeather = row.weather;
    }
    if (expected !== Math.floor(world.tick / 600) * 600 + 600 || latestWeather !== world.weather) fail();
    for (const event of world.events) {
      const row = this.db.prepare('SELECT tick,body FROM events WHERE id=?').get(event.id) as {tick:number;body:string}|undefined;
      if (!row || row.tick !== event.tick || row.body !== JSON.stringify(event)) fail();
    }
    if (slot === 0 && this.db.prepare('SELECT 1 FROM events WHERE CAST(substr(id,2) AS INTEGER)>? LIMIT 1').get(world.eventCounter)) fail();
  }
  assertPrevious(world: World): void {
    if (world.ecology) { this.assertWorld(world); return; }
    const current = this.header(0);
    if (!current) { this.assertWorld(world); return; }
    // The sole legacy predecessor is the zero-tick checkpoint immediately
    // before an explicit opt-in. Later omission is corruption, not migration.
    if (world.tick !== 0 || current.tick !== 0 || current.revision !== 0 || this.header(1)) fail();
  }
  restoreLegacyPrevious(world: World): void {
    if (!this.db.isTransaction) fail();
    this.assertPrevious(world);
    for (const table of Object.keys(TABLES)) this.db.exec(`DELETE FROM ${table}`);
  }
  /** Called only within the host transaction. No acknowledgement touches world. */
  flush(world: World): void {
    if (!this.db.isTransaction) throw new Error('Ecology writes require the host transaction.');
    const state = world.ecology;
    if (!state) { if (this.slot(0) !== null) fail(); return; }
    assertEcologyState(world);
    const previous = this.header(0);
    // Opening the host may re-save an unchanged committed checkpoint. This does
    // not fabricate a new ecological revision or alter either retained view.
    if (previous && state.revision === previous.revision && world.tick === previous.tick
      && JSON.stringify(state) === JSON.stringify(previous.state)) return;
    if (previous ? state.committedRevision !== previous.revision || state.revision !== previous.revision + 1 || world.tick < previous.tick || world.tick > previous.tick + 1
      : state.revision !== 0 || state.committedRevision !== 0 || world.tick !== 0) fail();
    if (previous) {
      if (world.eventCounter !== previous.eventCounter + state.pendingEvents.length) fail();
      for (const [index, event] of state.pendingEvents.entries()) {
        if (event.id !== `e${previous.eventCounter + index + 1}` || this.db.prepare('SELECT 1 FROM events WHERE id=?').get(event.id)) fail();
      }
    }
    this.db.exec('DELETE FROM ecology_previous; INSERT OR REPLACE INTO ecology_headers SELECT 1,revision,tick,body,digest FROM ecology_headers WHERE slot=0;');
    const aggregate: EcologySummary = previous ? { ...previous.state.summary } : { regions: 0, sumTicks: 0, oldestTick: null };
    for (const item of state.pending) {
      const prior = this.db.prepare('SELECT * FROM ecology_heads WHERE key=?').get(item.key) as Row | undefined;
      if (prior) {
        this.decode(prior, previous?.tick ?? 0);
        if (item.chunk && item.chunk.lastTick < prior.tick) fail();
        this.db.prepare('INSERT INTO ecology_previous VALUES (?,?,?,?)').run(item.key, prior.tick, prior.body, prior.digest);
        aggregate.regions--; aggregate.sumTicks -= prior.tick;
      } else this.db.prepare('INSERT INTO ecology_previous VALUES (?,0,NULL,NULL)').run(item.key);
      this.db.prepare('DELETE FROM ecology_heads WHERE key=?').run(item.key);
      this.db.prepare('DELETE FROM ecology_identities WHERE key=?').run(item.key);
    }
    for (const item of state.pending) if (item.chunk) {
      aggregate.regions++; aggregate.sumTicks += item.chunk.lastTick;
      const body = JSON.stringify(item.chunk);
      this.db.prepare('INSERT INTO ecology_heads VALUES (?,?,?,?)').run(item.key, item.chunk.lastTick, body, digest(body));
      for (const [kind, identities] of [['animal', item.chunk.animals ?? []], ['structure', item.chunk.structures ?? []]] as const)
        for (const identity of identities) this.db.prepare('INSERT INTO ecology_identities VALUES (?,?,?)').run(identity.id, item.key, kind);
    }
    for (const identity of [...world.animals, ...world.structures]) if (this.db.prepare('SELECT 1 FROM ecology_identities WHERE id=?').get(identity.id)) fail();
    for (const observation of state.pendingClimate) {
      if (previous && observation.tick <= previous.tick) fail();
      this.db.prepare('INSERT INTO ecology_climate VALUES (?,?,?)').run(observation.tick, observation.weather, digest(JSON.stringify([observation.tick, observation.weather])));
    }
    aggregate.oldestTick = (this.db.prepare('SELECT tick FROM ecology_heads ORDER BY tick,key LIMIT 1').get() as {tick:number}|undefined)?.tick ?? null;
    if (JSON.stringify(aggregate) !== JSON.stringify(state.summary)) fail();
    const latest = this.db.prepare('SELECT tick,weather FROM ecology_climate ORDER BY tick DESC LIMIT 1').get() as ClimateObservation | undefined;
    if (latest?.tick !== Math.floor(world.tick / 600) * 600 || latest.weather !== world.weather) fail();
    const header: Header = { revision: state.revision, tick: world.tick, eventCounter: world.eventCounter, state: ecologyStateForCommit(state) }, body = JSON.stringify(header);
    this.db.prepare('INSERT OR REPLACE INTO ecology_headers VALUES (0,?,?,?,?)').run(state.revision, world.tick, body, digest(body));
  }
  /** Recovery changes only the explicit backup, restoring exact inverse deltas. */
  restore(revision: number): void {
    if (!this.db.isTransaction) fail();
    const slot = this.slot(revision); if (slot === 0) return; if (slot !== 1) fail();
    for (const row of this.db.prepare('SELECT * FROM ecology_previous').iterate() as Iterable<Row>) {
      this.db.prepare('DELETE FROM ecology_heads WHERE key=?').run(row.key);
      if (row.body !== null) this.db.prepare('INSERT INTO ecology_heads VALUES (?,?,?,?)').run(row.key, row.tick, row.body, row.digest);
    }
    const previous = this.header(1)!;
    this.db.exec('DELETE FROM ecology_previous; DELETE FROM ecology_identities; INSERT OR REPLACE INTO ecology_headers SELECT 0,revision,tick,body,digest FROM ecology_headers WHERE slot=1; DELETE FROM ecology_headers WHERE slot=1;');
    for (const row of this.db.prepare('SELECT * FROM ecology_heads').iterate() as Iterable<Row>) {
      const chunk = this.decode(row, previous.tick)!;
      for (const [kind, identities] of [['animal', chunk.animals ?? []], ['structure', chunk.structures ?? []]] as const)
        for (const identity of identities) this.db.prepare('INSERT INTO ecology_identities VALUES (?,?,?)').run(identity.id, chunk.key, kind);
    }
    this.db.prepare('DELETE FROM ecology_climate WHERE tick>?').run(previous.tick);
  }
}
