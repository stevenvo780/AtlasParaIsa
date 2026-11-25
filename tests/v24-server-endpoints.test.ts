/**
 * V24 — Server wiring: `/api/worldmap`, `/api/directory`, Mensajes Divinos (`POST /api/whisper`,
 * `GET /api/whispers`) on the direct app AND behind the simulation-worker gateway; the mirror projection
 * (craft, whispers); and the world law of whispers (latent → heard → fulfilled, zero cost without them).
 */
import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { createApp, MinimapAtlas } from '../src/server/app.js';
import { createWorkerGateway, type WorkerGatewayOptions } from '../src/server/gateway.js';
import { Store } from '../src/server/store.js';
import { projectMirrorWorld, projectTapeFrame } from '../src/server/sim-worker.js';
import { cloneWorld, createWorld, projectWorld, stepWorld, submitWhisper, type Person, type World } from '../src/world/index.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { paramsOf, parseParams, setParams } from '../src/world/params.js';
import { WHISPER_LIFETIME_TICKS } from '../src/world/whispers.js';
import type { Tile, WorldView } from '../src/shared/types.js';
import type { DivineWhisper, WorldDirectoryResponse, WorldMapResponse } from '../src/shared/worldmap.js';
import type { StructureView } from '../src/shared/life.js';
import type { Chunk } from '../src/world/terrain.js';

const ORIGIN = 'https://carta.test', PASSWORD = 'private-v24-endpoints-password';
const params = parseParams('motor.hilos=1,persistencia.cadaTicks=200');
const OPEN = 'poblacion.natalidadVecindad=true,social.maxComunidades=0,limites.aplicacion=parametros,limites.chunks=65536,limites.teselasActivas=16777216,limites.comunidades=16777216,limites.fauna=100663296,construccion.modular=true,construccion.poliminosYSinergia=true,terreno.caminosFisicos=true,quimica.emergente=true,motor.soaTerreno=true,motor.particionarPersonas=true';
after(async () => { await closeEcosystemWorkers(); });
type Reply = { status: number; headers: IncomingHttpHeaders; text: string; json(): any };

/** Real Node HTTP parser over in-memory duplex sockets (no TCP bind needed). */
function client(server: Server) {
  let cookie = '';
  function connection(): Socket {
    class Endpoint extends Duplex {
      peer!: Endpoint;
      remoteAddress = '127.0.0.1';
      _read() {}
      _write(data: Buffer, _encoding: BufferEncoding, done: () => void) {
        queueMicrotask(() => { if (!this.peer.destroyed) this.peer.push(Buffer.from(data)); }); done();
      }
      _final(done: () => void) { queueMicrotask(() => this.peer.push(null)); done(); }
      setTimeout() { return this; }
      setNoDelay() { return this; }
      setKeepAlive() { return this; }
    }
    const local = new Endpoint(), remote = new Endpoint(); local.peer = remote; remote.peer = local;
    server.emit('connection', remote);
    return local as unknown as Socket;
  }
  const http = (path: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<Reply>((resolve, reject) => {
    const req = request({ host: 'localhost', path, method: body === undefined ? 'GET' : 'POST', createConnection: connection,
      headers: { Host: 'carta.test', Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}), Connection: 'close',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, res => {
      const parts: Buffer[] = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => {
        const raw = Buffer.concat(parts);
        const text = (res.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString();
        resolve({ status: res.statusCode!, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
  return {
    http,
    async login() {
      const res = await http('/api/login', { password: PASSWORD });
      assert.equal(res.status, 200, res.text);
      cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
    },
  };
}

function directory(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'carta-v24-endpoints-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function assertUnauthorized(http: ReturnType<typeof client>['http']) {
  for (const path of ['/api/worldmap', '/api/directory', '/api/whispers']) assert.equal((await http(path)).status, 401, path);
  assert.equal((await http('/api/whisper', { intent: 'travel', x: 1, y: 1 })).status, 401);
}

function assertWorldmap(map: WorldMapResponse) {
  assert.ok(map.chunks.length > 0 && map.activeChunks > 0);
  for (const chunk of map.chunks) {
    assert.match(chunk.cells, /^[0-9a-f]{16}$/);
    assert.ok(Number.isInteger(chunk.cx) && Number.isInteger(chunk.cy));
    assert.ok(chunk.cx >= map.bounds.minCx && chunk.cx <= map.bounds.maxCx && chunk.cy >= map.bounds.minCy && chunk.cy <= map.bounds.maxCy);
  }
  assert.ok(map.chunks.some(c => c.active));
  assert.ok(map.markers.some(m => m.kind === 'S') && map.markers.some(m => m.kind === 'I'));
}

function assertDirectoryPins(dir: WorldDirectoryResponse) {
  assert.equal(dir.people[0]!.role, 'S');
  assert.equal(dir.people[1]!.role, 'I');
  assert.equal(dir.totalPeople, dir.people.length);
  for (const p of dir.people) assert.equal(Object.hasOwn(p, 'genome') || Object.hasOwn(p, 'traits') || Object.hasOwn(p, 'experiences'), false, 'directory never leaks private fields');
}

/** POST /api/whisper answers only after the step that applied the message saved it: drive a manual app. */
async function whisperThroughStep(app: ReturnType<typeof createApp>, http: ReturnType<typeof client>['http'], body: unknown): Promise<Reply> {
  let settled = false;
  const reply = http('/api/whisper', body).finally(() => { settled = true; });
  while (!settled && app.susurrosPendientes === 0) await new Promise(resolve => setImmediate(resolve));
  if (!settled) app.stepOnce();
  return reply;
}

/** A land tile at 5–8 cells from `person` (a whisper destination reachable by land in a few steps). */
function landNear(world: World, person: { x: number; y: number }): { x: number; y: number } {
  const tile = world.tiles.find(t => t.terrain !== 'water' && t.terrain !== 'shelter'
    && Math.hypot(t.x - person.x, t.y - person.y) >= 5 && Math.hypot(t.x - person.x, t.y - person.y) <= 8);
  assert.ok(tile, 'a land destination near the inhabitant');
  return { x: tile.x, y: tile.y };
}

test('direct app: worldmap, global directory and Mensajes Divinos (observer-only) end to end', { timeout: 300_000 }, async t => {
  const dir = directory(t);
  const store = new Store(join(dir, 'world.sqlite'));
  const app = createApp({ store, password: PASSWORD, origin: ORIGIN, secure: true, seed: 42, params, manual: true, observerOnly: true });
  t.after(async () => { try { await app.close(); } finally { store.close(); } });
  const { http, login } = client(app.server);
  await assertUnauthorized(http);
  await login();

  // Worldmap: gzip, no-store, valid chunks and S/I markers.
  const gz = await http('/api/worldmap', undefined, { 'Accept-Encoding': 'gzip' });
  assert.equal(gz.status, 200);
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(gz.headers['cache-control'], 'no-store');
  const map = gz.json() as WorldMapResponse;
  assertWorldmap(map);
  assert.equal(map.activeChunks, Object.keys(app.world.chunks).length);
  const plain = await http('/api/worldmap');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(plain.json(), map, 'identical body with and without gzip while the tick does not move');

  // Directory: the WHOLE world (not a camera), S and I pinned, communities, works and tame herds.
  const world = app.world;
  const wanderer = world.people.find(p => p.role === 'neighbor')!;
  const home = { x: wanderer.x, y: wanderer.y };
  const animal = world.animals[0]!;
  const previousHabituation = animal.habituation;
  animal.habituation = 0.8;
  const community = { id: 'community-v24-test', name: 'Alba', x: world.people[0]!.x, y: world.people[0]!.y, color: '#da5', members: world.people.slice(0, 3).map(p => p.id),
    culture: { sharing: 0.5, stewardship: 0.5, openness: 0.5 }, formedAt: 0, cooperation: 4, disputes: 0 };
  const structure = { id: 'structure-v24-test', x: world.people[0]!.x, y: world.people[0]!.y, blueprintId: 'bp-v24', name: 'Taller', components: ['frame', 'roof'],
    condition: 0.9, water: 0, food: 0, uses: 0, builtAt: 0, builderId: world.people[0]!.id, cells: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    synergy: { sharedEdges: 1, heated: false, irrigated: false, workshopBonus: 0, kilnTier: 1 } } as unknown as StructureView;
  world.communities.push(community as never); world.structures.push(structure as never);
  // An inhabitant far outside any camera the client could hold.
  wanderer.x = home.x + 400; wanderer.y = home.y - 300;
  try {
    const res = await http('/api/directory', undefined, { 'Accept-Encoding': 'gzip' });
    assert.equal(res.status, 200); assert.equal(res.headers['content-encoding'], 'gzip');
    const dirView = res.json() as WorldDirectoryResponse;
    assertDirectoryPins(dirView);
    assert.equal(dirView.totalPeople, world.people.length);
    assert.equal(dirView.totalAnimals, world.animals.length);
    const far = dirView.people.find(p => p.id === wanderer.id)!;
    assert.deepEqual({ x: far.x, y: far.y }, { x: wanderer.x, y: wanderer.y }, 'out-of-view inhabitant is listed where it is');
    const camera = (await http(`/api/world?x=${home.x - 2}&y=${home.y - 2}&width=4&height=4`)).json() as WorldView;
    assert.equal(camera.people.some(p => p.id === wanderer.id), false, 'the camera does not see it');
    assert.ok(dirView.totalPeople > camera.people.length, `global scope beyond the camera (${dirView.totalPeople} vs ${camera.people.length})`);
    assert.ok(dirView.communities.some(c => c.id === community.id && c.memberCount === 3));
    assert.ok(dirView.structures.some(s => s.id === structure.id && s.cells === 2 && s.kilnTier === 1));
    assert.ok(dirView.totalPolyominoes >= 1);
    assert.ok(dirView.totalTameAnimals >= 1 && dirView.herds.some(h => h.tameCount >= 1));
  } finally {
    wanderer.x = home.x; wanderer.y = home.y;
    world.communities.pop(); world.structures.pop();
    if (previousHabituation === undefined) delete animal.habituation; else animal.habituation = previousHabituation;
  }

  // Mensajes Divinos: CSRF, validation, body limit, and 201 even in observer-only mode (orders stay 410).
  const s = world.people.find(p => p.role === 'S')!;
  s.genome.alleles[14] = s.genome.alleles[15] = 1; // escucha máxima: el ritmo con que oye es lo único que no se fija aquí
  const target = landNear(world, s);
  assert.equal((await http('/api/whisper', { personId: s.id, intent: 'travel', ...target }, { Origin: 'https://evil.test' })).status, 403);
  const invalid = await http('/api/whisper', { intent: 'bogus', x: 1, y: 1 });
  assert.equal(invalid.status, 400); assert.match(invalid.json().error, /no válida/);
  assert.equal((await http('/api/whisper', { intent: 'travel', x: 1.5, y: 1 })).status, 400);
  assert.equal((await http('/api/whisper', { personId: 'nadie', intent: 'travel', x: 1, y: 1 })).status, 400);
  assert.equal((await http('/api/whisper', 'not json')).status, 400);
  assert.equal((await http('/api/whisper', { intent: 'travel', x: 1, y: 1, note: 'x'.repeat(5000) })).status, 413, 'max 4 KiB body');
  const water = world.tiles.find(tile => tile.terrain === 'water');
  if (water) assert.equal((await http('/api/whisper', { intent: 'travel', x: water.x, y: water.y })).status, 400, 'known water is no destination');
  assert.equal((await http('/api/gesture', { id: 'g-v24', kind: 'command', agentId: s.id, order: 'move', x: 1, y: 1 })).status, 410);
  const before = world.tick;
  const created = await whisperThroughStep(app, http, { personId: s.id, intent: 'travel', ...target, note: 'Mira hacia allí' });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json().ok, true);
  const whisper = created.json().whisper as DivineWhisper;
  assert.equal(whisper.status, 'latent'); assert.equal(whisper.personName, s.name);
  assert.equal(whisper.createdTick, before, 'enters the world at the tick of the step that applied it');
  assert.equal(world.tick, before + 1);
  const listed = (await http('/api/whispers')).json() as { tick: number; whispers: DivineWhisper[] };
  assert.equal(listed.tick, world.tick);
  assert.deepEqual(listed.whispers.map(w => w.id), [whisper.id]);
  assert.ok(((await http('/api/worldmap')).json() as WorldMapResponse).markers.some(m => m.kind === 'whisper' && m.id === whisper.id));

  // Real stepped world: never heard at once; heard later; walked to; chronicle entries.
  let heardAt: number | undefined, fulfilledAt: number | undefined;
  for (let i = 0; i < WHISPER_LIFETIME_TICKS + 1200 && fulfilledAt === undefined; i++) {
    app.stepOnce();
    const live = app.world.whispers!.find(w => w.id === whisper.id)!;
    if (live.status === 'heard' && heardAt === undefined) heardAt = app.world.tick;
    if (live.status === 'fulfilled') fulfilledAt = app.world.tick;
    if (live.status === 'faded') break;
  }
  t.diagnostic(`whisper created at tick ${whisper.createdTick}, heard at ${heardAt}, fulfilled at ${fulfilledAt}`);
  assert.ok(heardAt !== undefined && heardAt > whisper.createdTick, 'asynchronous: never heard at once');
  assert.ok(heardAt! - whisper.createdTick < WHISPER_LIFETIME_TICKS, 'heard before it fades');
  assert.ok(fulfilledAt !== undefined && fulfilledAt > heardAt!, 'the inhabitant walked there by land');
  const texts = app.world.events.map(e => e.text);
  assert.ok(texts.some(text => text.includes('oyó un susurro') && text.includes(s.name)), 'chronicle: heard');
  assert.ok(texts.some(text => text.includes('llegó al lugar del susurro')), 'chronicle: fulfilled');
  const after = (await http('/api/whispers')).json() as { whispers: DivineWhisper[] };
  assert.equal(after.whispers[0]!.status, 'fulfilled');
  assert.equal(after.whispers[0]!.heardById, s.id);
  assert.equal(Object.hasOwn(after.whispers[0]!, 'bestDistance'), false, 'internal tracking never leaves the world');
});

test('whispers persist with the world (save on close, load on start)', { timeout: 120_000 }, async t => {
  const dir = directory(t);
  const path = join(dir, 'world.sqlite');
  let store = new Store(path);
  let app = createApp({ store, password: PASSWORD, origin: ORIGIN, secure: true, seed: 42, params, manual: true, observerOnly: true });
  const s = app.world.people.find(p => p.role === 'S')!;
  const created = submitWhisper(app.world, { personId: s.id, intent: 'explore', ...landNear(app.world, s), note: 'Allí' });
  try { await app.close(); } finally { store.close(); }
  store = new Store(path);
  app = createApp({ store, password: PASSWORD, origin: ORIGIN, secure: true, seed: 42, params, manual: true, observerOnly: true });
  t.after(async () => { try { await app.close(); } finally { store.close(); } });
  assert.deepEqual(app.world.whispers?.map(w => ({ id: w.id, status: w.status, x: w.x, y: w.y })), [{ id: created.id, status: 'latent', x: created.x, y: created.y }]);
});

test('whispers: confirmed only once durable (also as a replayed delta), a revoked session never writes one', { timeout: 300_000 }, async t => {
  const dir = directory(t);
  // 1) `persistencia.paginasSucias=true`: the step that applies the whisper saves a replay delta that must
  //    carry it as a change at its tick (before the fix: «Replay canonical hash mismatch» and a paused world).
  {
    const path = join(dir, 'replay.sqlite');
    const store = new Store(path);
    const app = createApp({ store, password: PASSWORD, origin: ORIGIN, secure: true, seed: 42, manual: true, observerOnly: true,
      params: parseParams('motor.hilos=1,persistencia.cadaTicks=200,persistencia.paginasSucias=true') });
    // Pre-existing and unrelated to whispers: the direct host does not record its own host changes as replay
    // changes, so a later routine/close save of this reserved mode can fail. Only the whisper delta is asserted.
    t.after(async () => { try { await app.close().catch(() => undefined); } finally { store.close(); } });
    const { http, login } = client(app.server);
    await login();
    for (let i = 0; i < 3; i++) app.stepOnce();
    const s = app.world.people.find(p => p.role === 'S')!;
    const created = await whisperThroughStep(app, http, { personId: s.id, intent: 'explore', ...landNear(app.world, s), note: 'Allí' });
    assert.equal(created.status, 201, created.text);
    assert.equal(app.failed, false, 'the replayed save of the whisper step committed');
    const whisper = created.json().whisper as DivineWhisper;
    // Durable at the 201: an independent reader rebuilds the delta (re-simulated, root verified) with it.
    const reader = new Store(path, { readOnly: true });
    try {
      const durable = reader.load()!.world;
      assert.equal(durable.tick, app.world.tick);
      assert.deepEqual(durable.whispers?.map(w => w.id), [whisper.id]);
    } finally { reader.close(); }
  }
  // 2) Default persistence: durable at the 201 without waiting for the routine cadence; a session revoked
  //    while the message waits for its step gets 401 and the world is untouched.
  const path = join(dir, 'world.sqlite');
  const store = new Store(path);
  const app = createApp({ store, password: PASSWORD, origin: ORIGIN, secure: true, seed: 42, params, manual: true, observerOnly: true });
  t.after(async () => { try { await app.close(); } finally { store.close(); } });
  const { http, login } = client(app.server);
  await login();
  const s = app.world.people.find(p => p.role === 'S')!;
  const created = await whisperThroughStep(app, http, { personId: s.id, intent: 'travel', ...landNear(app.world, s) });
  assert.equal(created.status, 201, created.text);
  const reader = new Store(path, { readOnly: true });
  try { assert.ok(reader.load()!.world.whispers?.some(w => w.id === created.json().whisper.id), 'saved by its own step (cadaTicks=200)'); }
  finally { reader.close(); }

  const again = client(app.server);
  await again.login();
  const count = app.world.whispers!.length;
  let settled = false;
  const pendingReply = again.http('/api/whisper', { intent: 'explore', ...landNear(app.world, s) }).finally(() => { settled = true; });
  while (!settled && app.susurrosPendientes === 0) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await again.http('/api/logout', {})).status, 200);
  app.stepOnce();
  const revoked = await pendingReply;
  assert.equal(revoked.status, 401, revoked.text);
  assert.equal(app.world.whispers!.length, count, 'a revoked session never adds a whisper');
  assert.equal(app.failed, false);
});

async function gatewayFixture(t: TestContext, overrides: Partial<WorkerGatewayOptions> = {}) {
  const dir = directory(t);
  const worldPath = join(dir, 'world.sqlite');
  const gateway = createWorkerGateway({ worldPath, origin: ORIGIN, secure: true, password: PASSWORD, seed: 42, params, manual: true, tickMs: 40, ...overrides });
  t.after(() => gateway.close());
  await gateway.ready;
  return { gateway, worldPath, ...client(gateway.server) };
}

test('sim-worker gateway: worldmap, global directory and whispers via RPC, allowed in observer-only turbo', { timeout: 300_000 }, async t => {
  const { gateway, http, login } = await gatewayFixture(t, { turbo: true, tape: true, observerOnly: true });
  await assertUnauthorized(http);
  await login();
  const gz = await http('/api/worldmap', undefined, { 'Accept-Encoding': 'gzip' });
  assert.equal(gz.status, 200); assert.equal(gz.headers['content-encoding'], 'gzip'); assert.equal(gz.headers['cache-control'], 'no-store');
  assertWorldmap(gz.json() as WorldMapResponse);
  // Hot path: the same mirror answers with the cached response object (no rebuild, no stringify, no gzip).
  const first = gateway.worldmap();
  const hot = performance.now();
  for (let i = 0; i < 20; i++) assert.equal(gateway.worldmap(), first);
  const hotMs = (performance.now() - hot) / 20;
  t.diagnostic(`gateway.worldmap() hot: ${hotMs.toFixed(4)} ms`);
  assert.ok(hotMs < 5, `worldmap hot < 5 ms (${hotMs})`);

  const dirView = (await http('/api/directory')).json() as WorldDirectoryResponse;
  assertDirectoryPins(dirView);
  const camera = (await http('/api/world?x=0&y=0&width=4&height=4')).json() as WorldView;
  assert.equal(dirView.totalPeople, camera.stats?.population ?? dirView.totalPeople, 'the census, not the camera');
  assert.ok(dirView.totalPeople > camera.people.length, `global scope beyond the camera (${dirView.totalPeople} vs ${camera.people.length})`);

  const s = dirView.people[0]!;
  assert.equal((await http('/api/whisper', { personId: s.id, intent: 'explore', x: s.x + 4, y: s.y }, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await http('/api/whisper', { intent: 'teleport', x: 0, y: 0 })).status, 400);
  assert.equal((await http('/api/whisper', { personId: 'nadie', intent: 'travel', x: 0, y: 0 })).status, 400, 'world-side validation crosses the RPC as 400');
  const tiles = (await http(`/api/world?x=${s.x - 8}&y=${s.y - 8}&width=17&height=17`)).json() as WorldView;
  const land = tiles.tiles.find(tile => tile.terrain !== 'water' && Math.hypot(tile.x - s.x, tile.y - s.y) >= 4 && Math.hypot(tile.x - s.x, tile.y - s.y) <= 7)!;
  // A message is confirmed by the step that applies and saves it: the world must be running.
  gateway.start();
  const created = await http('/api/whisper', { personId: s.id, intent: 'explore', x: land.x, y: land.y, note: 'Allí hay agua' });
  assert.equal(created.status, 201, created.text);
  const whisper = created.json().whisper as DivineWhisper;
  assert.equal(whisper.status, 'latent');
  // The step that applied it posted the mirror before the reply: the next read already shows the whisper.
  const listed = (await http('/api/whispers')).json() as { whispers: DivineWhisper[] };
  assert.ok(listed.whispers.some(w => w.id === whisper.id));
  assert.ok(((await http('/api/worldmap')).json() as WorldMapResponse).markers.some(m => m.kind === 'whisper' && m.id === whisper.id));

  let status: DivineWhisper | undefined;
  for (let i = 0; i < 1200; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    status = ((await http('/api/whispers')).json() as { whispers: DivineWhisper[] }).whispers.find(w => w.id === whisper.id);
    if (status && status.status !== 'latent') break;
  }
  t.diagnostic(`gateway whisper: ${JSON.stringify(status)}`);
  assert.ok(status && (status.status === 'heard' || status.status === 'fulfilled'), 'heard asynchronously by the simulation worker');
  assert.ok(status!.heardTick! > status!.createdTick);
  const view = (await http('/api/world?x=0&y=0&width=40&height=28')).json() as WorldView;
  assert.ok(view.events.some(e => e.text.includes('oyó un susurro')), 'chronicle event reaches the live mirror');
  const later = (await http('/api/directory')).json() as WorldDirectoryResponse;
  assert.ok(later.tick > dirView.tick, 'directory follows the mirror');
});

test('worldmap atlas: archived (retired) chunks are discovered terrain, read once in bounded turns', async () => {
  const tiles = (cx: number, cy: number): Tile[] => {
    const out: Tile[] = [];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) out.push({ x: cx * 16 + x, y: cy * 16 + y, terrain: 'meadow', biome: 'grassland', moisture: 0.5, vegetation: 0.5, food: 0.4 } as Tile);
    return out;
  };
  const archived = ['5,5', '6,5', '7,5', '0,0'];
  let loads = 0;
  const store = {
    db: { prepare: () => ({ all: () => archived.map(key => ({ key })) }) },
    loadChunk: (key: string) => { loads++; const [cx, cy] = key.split(',').map(Number) as [number, number]; return { key, cx, cy, tiles: tiles(cx, cy) } as unknown as Chunk; },
  } as never;
  const atlas = new MinimapAtlas();
  atlas.setActive('0,0', '3333333333333333');
  atlas.retainActive(['0,0']);
  atlas.fillFromArchive(store, 100, 0); // zero budget: one archived key per event-loop turn
  assert.ok(loads <= 1 && !atlas.archiveFilled, 'never the whole archive in one synchronous turn');
  for (let i = 0; i < 10 && !atlas.archiveFilled; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(atlas.archiveFilled);
  assert.equal(loads, 3, 'a chunk already summarized (the active one) is not read again');
  const byKey = new Map(atlas.chunks().map(c => [`${c.cx},${c.cy}`, c]));
  assert.equal(byKey.get('0,0')?.active, true);
  for (const key of ['5,5', '6,5', '7,5']) { assert.equal(byKey.get(key)?.active, undefined); assert.match(byKey.get(key)!.cells, /^3{16}$/); }
  const version = atlas.version;
  atlas.fillFromArchive(store, 200);
  assert.equal(atlas.version, version, 'the archive is read only once');
});

test('mirror projection: craft and whispers travel as detached public copies', () => {
  const world = createWorld(42, parseParams('motor.hilos=1'));
  for (let i = 0; i < 30; i++) stepWorld(world);
  const crafter = world.people[0]!;
  crafter.compounds = [{ id: 'lot-v24', formulaId: 'f-v24', composition: { C: 0.2, H: 0.1, Ca: 0.1, S: 0, Si: 0.4, Fe: 0.2 }, phase: 'solid', mass: 0.4,
    properties: { hardness: 0.9, toughness: 0.8, seal: 0.1, insulation: 0.2, fuelPower: 0, colorHex: '#7a5c44' } }] as never;
  assert.equal(projectMirrorWorld(world).whispers, undefined, 'no whispers, no field');
  assert.equal(projectWorld(world).whispers, undefined);
  const created = submitWhisper(world, { personId: crafter.id, intent: 'craft', ...landNear(world, crafter), note: '' });
  world.whispers![0]!.bestDistance = 3; // internal tracking state
  const view = projectMirrorWorld(world);
  const person = view.people.find(p => p.id === crafter.id)!;
  assert.equal(person.craftTint, '#7a5c44');
  assert.equal(person.craftFocus, 'cutting');
  assert.equal(view.whispers?.length, 1);
  assert.equal(view.whispers![0]!.id, created.id);
  assert.notEqual(view.whispers![0], world.whispers![0], 'detached copy');
  assert.equal(Object.hasOwn(view.whispers![0]!, 'bestDistance'), false);
  assert.equal(Object.hasOwn(projectWorld(world).whispers![0]!, 'bestDistance'), false);
  const frame = projectTapeFrame(world, {} as never, 'instance', []);
  assert.deepEqual(frame.whispers, view.whispers);
  assert.equal(frame.people.find(p => p.id === crafter.id)!.craftTint, '#7a5c44');
});

function normalizedDigest(world: World): string {
  const copy = cloneWorld(world);
  const p = structuredClone(paramsOf(copy));
  p.motor.hilos = 1;
  setParams(copy, p);
  return digestoCanonico(copy);
}

test('worlds without whispers are reproducible (open world digest: same seed, one thread, two runs)', () => {
  // V23: no fixed golden digest; two runs of the same world (same seed, one thread, no GPU) must agree.
  const run = (): { whispers: unknown; digest: string } => {
    const world = createWorld(51926, parseParams(`${OPEN},motor.hilos=1`));
    for (let i = 0; i < 240; i++) stepWorld(world);
    return { whispers: world.whispers, digest: normalizedDigest(world) };
  };
  const first = run(), second = run();
  assert.equal(first.whispers, undefined);
  assert.equal(second.digest, first.digest);
});

test('whisper law: latent → heard (bounded, deterministic delay) → fulfilled by land; acute need defers it', () => {
  const world = createWorld(51926, parseParams('motor.hilos=1'));
  for (let i = 0; i < 60; i++) stepWorld(world);
  const person = world.people.find(p => p.role === 'I')!;
  person.genome.alleles[14] = person.genome.alleles[15] = 1; // escucha máxima: no olvida el mensaje por el camino
  const rngBefore = world.rng;
  const whisper = submitWhisper(world, { personId: person.id, intent: 'travel', ...landNear(world, person), note: 'Ven' });
  assert.equal(world.rng, rngBefore, 'submitting draws nothing');
  let last = { x: person.x, y: person.y }, deferred = false;
  for (let i = 0; i < WHISPER_LIFETIME_TICKS + 1200 && whisper.status !== 'fulfilled' && whisper.status !== 'faded'; i++) {
    const heardBefore = whisper.status === 'heard';
    stepWorld(world);
    const now = world.people.find(p => p.id === person.id) as Person | undefined;
    if (!now) break;
    assert.ok(Math.abs(now.x - last.x) + Math.abs(now.y - last.y) <= 1, 'one land step at a time, never a teleport');
    last = { x: now.x, y: now.y };
    if (!heardBefore && whisper.status === 'heard') {
      assert.ok(world.tick > whisper.createdTick);
      // Acute hunger: the next decision is about the body, not the whisper.
      const hunger = now.hunger;
      now.hunger = 0.95; now.decisionAt = world.tick;
      stepWorld(world);
      deferred = !(now.action === 'explore' && now.target.x === whisper.x && now.target.y === whisper.y);
      now.hunger = Math.min(now.hunger, hunger); now.decisionAt = world.tick;
      last = { x: now.x, y: now.y };
    }
  }
  assert.ok(deferred, 'acute need comes first');
  assert.equal(whisper.status, 'fulfilled');
  assert.ok(world.events.some(e => e.text.includes('oyó un susurro')));
  assert.ok(world.events.some(e => e.text.includes('llegó al lugar del susurro')));
});

test('whisper law: parity 0 ULP between hilos 1 and 4 with an active whisper (open world)', () => {
  const serial = createWorld(51926, parseParams(`${OPEN},motor.hilos=1`));
  const parallel = createWorld(51926, parseParams(`${OPEN},motor.hilos=4`));
  for (let i = 0; i < 60; i++) { stepWorld(serial); stepWorld(parallel); }
  const s = serial.people.find(p => p.role === 'S')!;
  const destination = landNear(serial, s);
  submitWhisper(serial, { personId: s.id, intent: 'explore', ...destination, note: '' });
  submitWhisper(parallel, { personId: s.id, intent: 'explore', ...destination, note: '' });
  for (let i = 0; i < 600; i++) { stepWorld(serial); stepWorld(parallel); }
  assert.notEqual(serial.whispers![0]!.status, 'latent');
  assert.equal(normalizedDigest(parallel), normalizedDigest(serial));
});
