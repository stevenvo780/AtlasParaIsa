/**
 * V24 engine frequency: the publish path of the simulation worker records less without losing anything.
 * - The tile observer reports exactly the tiles whose public projection changed (ground truth: a fresh
 *   projection of every resident tile on every scan), serially and with the parallel SoA kernel.
 * - The tape holds a frame at least every
 *   `PASO_MAXIMO` ticks (its cadence widens under load), in order, and each reconstructed frame has its summaries.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { on } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, stepWorld, type World } from '../src/world/index.js';
import { paramsOf, parseParams } from '../src/world/params.js';
import { bindWorldContext, worldContext } from '../src/world/spatial.js';
import { ResidentTopologyOwner, residentBackingArray } from '../src/world/soa/topologia.js';
import { residentFastAccess } from '../src/world/soa/terreno.js';
import { createTileObserver, projectMirrorTile } from '../src/server/sim-worker.js';
import { cintaDeMundo, PASO_MAXIMO } from '../src/server/cinta/escritor.js';
import { LectorCinta } from '../src/server/cinta/lector.js';
import { CINTA, type ChunkResp } from '../src/shared/cinta.js';
import { applyClientTapeDelta } from '../src/shared/tape-delta.js';
import { cerrarPiscinasDeComputo } from '../src/server/app.js';
import { createWorkerGateway, saludDelEspejo } from '../src/server/gateway.js';
import type { OperacionSalud, Salud } from '../src/shared/salud.js';
import type { Tile, WorldView } from '../src/shared/types.js';

/** Los fotogramas de L0 de un tramo, reconstruidos desde su fotograma clave. */
function tramoL0(lector: LectorCinta, t: number, n: number): WorldView[] {
  const r = JSON.parse(lector.chunk({ t, n, nivel: 0 })) as ChunkResp;
  const frames = r.baseFrame ? [r.baseFrame] : [];
  for (const d of r.deltas) frames.push(applyClientTapeDelta(frames.at(-1)!, d).frame);
  return frames;
}

function directory(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'v24-sim-hz-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function esperarEspejo(gateway: ReturnType<typeof createWorkerGateway>, objetivo: number, signal: AbortSignal): Promise<void> {
  for await (const [tick] of on(gateway.events, 'mirror', { signal, close: ['workerError'] })) {
    if (typeof tick === 'number' && tick >= objetivo) return;
  }
  assert.fail(`El worker se detuvo antes de publicar el paso ${objetivo}.`);
}

/** The simulation worker's own setup: resident Proxy tiles whenever the motor is parallel. */
function residentWorld(hilos: number): World {
  const world = createWorld(51926, parseParams(`motor.hilos=${hilos},motor.soaTerreno=true`));
  for (let i = 0; i < 12; i++) stepWorld(world);
  const owner = new ResidentTopologyOwner();
  world.tiles = owner.tiles(world.tiles.map(tile => owner.tile(tile)));
  bindWorldContext(world, { ...worldContext(world), tileOwnership: owner });
  return world;
}

const key = (tile: { x: number; y: number }) => `${tile.x},${tile.y}`;

for (const hilos of [1, 4]) {
  test(`tile observer (${hilos} hilo${hilos > 1 ? 's' : ''}): reports exactly the tiles whose projection changed`, async t => {
    t.after(() => cerrarPiscinasDeComputo());
    const world = residentWorld(hilos);
    assert.equal(paramsOf(world).motor.hilos, hilos);
    const observer = createTileObserver();
    const truth = () => new Map(residentBackingArray(world.tiles).map(tile => {
      const projected = projectMirrorTile(tile, residentFastAccess(world.tiles));
      return [key(projected), projected] as const;
    }));
    let previous = truth();
    const first = observer.scan(world);
    assert.equal(first.force, true);
    assert.equal(first.changed.length, previous.size, 'the first scan reports every resident tile');
    let reported = 0, scans = 0;
    for (let step = 0; step < 60; step++) {
      stepWorld(world);
      // Scan on a sparse cadence too, as the turbo publish does (several steps between two scans).
      if (step % 3 === 1) continue;
      if (step === 30) { const tile = world.tiles[5]!; tile.stone = (tile.stone ?? 0) + 0.5; }
      const current = truth();
      const observation = observer.scan(world);
      const expected = [...current].filter(([id, tile]) => !isDeepStrictEqual(previous.get(id), tile)).map(([id]) => id).sort();
      assert.deepEqual(observation.changed.map(key).sort(), expected, `step ${step}: changed tiles`);
      // The cache is the projection: every chunk page equals a fresh projection, field for field.
      let cached = 0;
      for (const [chunk, tiles] of observation.chunks) for (const tile of tiles) {
        assert.equal(chunk, `${Math.floor(tile.x / 16)},${Math.floor(tile.y / 16)}`);
        assert.deepEqual(tile, current.get(key(tile)), `step ${step}: cached projection of ${key(tile)}`);
        cached++;
      }
      assert.equal(cached, current.size);
      assert.deepEqual([...observation.dirty].sort(), [...new Set(observation.changed.map(tile => `${Math.floor(tile.x / 16)},${Math.floor(tile.y / 16)}`))].sort());
      if (step === 30) assert.ok(observation.changed.some(tile => key(tile) === key(world.tiles[5]!)), 'a Proxy-held field is seen');
      reported += observation.changed.length; scans++;
      previous = current;
    }
    t.diagnostic(`${hilos} hilo(s): ${(reported / scans).toFixed(0)} of ${previous.size} tiles changed per scan`);
    // A scan with nothing written in between reports nothing and allocates no page.
    const idle = observer.scan(world);
    assert.equal(idle.changed.length, 0);
    assert.equal(idle.dirty.size, 0);
  });
}

test('tile observer: a different resident set regroups and keeps what did not change', () => {
  const world = residentWorld(1);
  const observer = createTileObserver();
  observer.scan(world);
  const before = observer.scan(world).chunks;
  // A tile object replaced by an equal copy (same coordinates, same values) is not a change.
  const raw = world.tiles[0]!;
  world.tiles[0] = { ...raw } as Tile;
  const regrouped = observer.scan(world);
  assert.notEqual(regrouped.chunks, before, 'regrouped');
  assert.equal(regrouped.changed.length, 0, 'an equal replacement is not reported');
  // A replacement with another value is.
  world.tiles[0] = { ...raw, food: (raw.food ?? 0) + 0.25 } as Tile;
  assert.deepEqual(observer.scan(world).changed.map(key), [key(raw)]);
  // Dropping the last tile regroups; the survivors keep their cached projection.
  const last = world.tiles.pop()!;
  const shrunk = observer.scan(world);
  assert.equal(shrunk.changed.length, 0);
  assert.equal([...shrunk.chunks.values()].reduce((n, tiles) => n + tiles.length, 0), world.tiles.length);
  assert.ok(![...shrunk.chunks.values()].some(tiles => tiles.some(tile => key(tile) === key(last))));
});

test('la salud del worker vence por falta de progreso, aunque una operación siga declarada', () => {
  const salud: Salud = { estado: 'ok', tick: 12, ticksPorSegundo: 3, segundosDesdeUltimoPaso: 1, ultimoGuardado: 500,
    gpu: [{ dispositivo: 0, estado: 'cpu' }], recargas: 2, operacion: null,
    diagnostico: { duras24h: 0, blandas24h: 0, ultimaViolacion: null, errorBitacora: null, registrosSinBitacora: 0 } };
  const medicion = { salud, saludMedidaEn: 1000 };
  const operacion: OperacionSalud = { tipo: 'recargando', inicio: 50_000, progresoEn: 80_000 };
  const avance = { type: 'operacion' as const, operacion, medidaEn: 700_000 };
  const avanzando = saludDelEspejo(medicion, avance, false, 720_000);
  assert.deepEqual(avanzando, { ...salud, segundosDesdeUltimoPaso: 720, estado: 'degradado', operacion });
  assert.equal(saludDelEspejo(medicion, avance, false, 760_001).estado, 'parado');
  assert.equal(saludDelEspejo(medicion, avance, true, 720_000).estado, 'parado');
  const fin = { ...avance, operacion: null, medidaEn: 720_000 };
  assert.equal(saludDelEspejo(medicion, { ...fin, medidaEn: 0 }, false, 61_001).estado, 'parado');
  const recienTerminada = saludDelEspejo(medicion, fin, false, 720_001);
  assert.equal(recienTerminada.estado, 'degradado', 'da tiempo al siguiente paso tras la operación');
  assert.ok(recienTerminada.segundosDesdeUltimoPaso > 60);
  assert.equal(saludDelEspejo(medicion, fin, false, 780_001).estado, 'parado');
});

test('un guardado rutinario no degrada la salud, pero uno que deja el paso parado más de un minuto sí', () => {
  const salud: Salud = { estado: 'ok', tick: 12, ticksPorSegundo: 10, segundosDesdeUltimoPaso: 0.1, ultimoGuardado: 500, gpu: [],
    recargas: 0, operacion: null,
    diagnostico: { duras24h: 0, blandas24h: 0, ultimaViolacion: null, errorBitacora: null, registrosSinBitacora: 0 } };
  const medicion = { salud, saludMedidaEn: 1000 };
  const operacion: OperacionSalud = { tipo: 'guardando', inicio: 1_000, progresoEn: 1_000 };
  const guardando = saludDelEspejo(medicion, { type: 'operacion', operacion, medidaEn: 1_500 }, false, 3_000);
  assert.equal(guardando.estado, 'ok');
  assert.deepEqual(guardando.operacion, operacion, 'la operación sigue visible aunque no degrade');
  const largo = saludDelEspejo(medicion, { type: 'operacion', operacion, medidaEn: 61_000 }, false, 62_000);
  assert.equal(largo.estado, 'degradado');
  assert.equal(saludDelEspejo(medicion, { type: 'operacion', operacion: { ...operacion, tipo: 'arrancando' }, medidaEn: 1_500 }, false, 3_000).estado, 'degradado');
});

test('turbo gateway: tape frames in order without gaps, summaries on every frame, live mirror at its cadence', { timeout: 120_000 }, async t => {
  const dir = directory(t);
  const worldPath = join(dir, 'world.sqlite');
  const gateway = createWorkerGateway({ worldPath, origin: 'https://carta.test', secure: true, password: 'private-v24-hz-password',
    seed: 42, params: parseParams('motor.hilos=1,persistencia.cadaTicks=200'), manual: true, turbo: true, tape: true });
  t.after(() => gateway.close());
  let mirrorTick = -1;
  gateway.events.on('mirror', (tick: number) => { mirrorTick = tick; });
  assert.equal(gateway.salud().operacion?.tipo, 'arrancando');
  await gateway.ready;
  assert.equal(gateway.salud().operacion, null);
  assert.ok(gateway.salud().ultimoGuardado);
  const start = await gateway.flushTape();
  const publicado = esperarEspejo(gateway, start.latestTick + 11, t.signal);
  gateway.start();
  await publicado;
  const end = await gateway.flushTape();
  const ticks = end.latestTick - start.latestTick;
  t.diagnostic(`turbo: ${ticks} ticks on the tape`);
  assert.ok(ticks > 10, `the world advanced (${ticks} ticks)`);
  const reader = new LectorCinta(cintaDeMundo(worldPath));
  try {
    const meta = reader.meta(), l0 = meta.niveles[0]!;
    // The world keeps running after the flush: the tape holds at least the flushed frames.
    assert.ok(l0.fotogramas >= end.frames);
    assert.deepEqual(meta.lagunas, []);
    let next = l0.t0, previous = -1, read = 0;
    while (next <= l0.t1) {
      const frames = tramoL0(reader, next, 120).filter(frame => frame.tick >= next);
      assert.ok(frames.length > 0);
      for (const frame of frames) {
        // Frames written after meta() are past this snapshot.
        if (frame.tick > l0.t1) break;
        if (previous < 0) assert.equal(frame.tick, l0.t0);
        else assert.ok(frame.tick > previous && frame.tick - previous <= PASO_MAXIMO, `step ${previous} → ${frame.tick}`);
        assert.equal(frame.tick % CINTA.pasos[0], 0);
        for (const field of ['stats', 'technology', 'organization', 'demography', 'places', 'memories'] as const) assert.ok(frame[field] !== undefined, `${field} at tick ${frame.tick}`);
        assert.ok(frame.people.length > 0 && frame.tiles.length > 0);
        previous = frame.tick; next = frame.tick + 1; read++;
      }
    }
    assert.equal(read, l0.fotogramas);
  } finally { reader.close(); }
  // The live mirror follows the world (throttled, never stalled).
  assert.ok(mirrorTick >= start.latestTick + 1, `mirror tick ${mirrorTick} moved past ${start.latestTick}`);
  assert.equal(gateway.salud().estado, 'ok');
  assert.ok(gateway.salud().tick >= mirrorTick);
  assert.ok(gateway.salud().ticksPorSegundo > 0);
  assert.equal(gateway.salud().diagnostico.duras24h, 0);
});

test('turbo gateway: the first frame of a reopened tape\'s epoch is a full keyframe (terrain not lost after a restart)', { timeout: 180_000 }, async t => {
  const dir = directory(t);
  const worldPath = join(dir, 'world.sqlite');
  const options = { worldPath, origin: 'https://carta.test', secure: true, password: 'private-v24-hz-password', seed: 42,
    params: parseParams('motor.hilos=1,persistencia.cadaTicks=200'), manual: true, turbo: true, tape: true };
  const leer = <T>(f: (lector: LectorCinta) => T): T => {
    const lector = new LectorCinta(cintaDeMundo(worldPath));
    try { return f(lector); } finally { lector.close(); }
  };
  let gateway = createWorkerGateway(options);
  try {
    await gateway.ready;
    const publicado = esperarEspejo(gateway, 2 * CINTA.pasos[0] + 1, t.signal);
    gateway.start();
    await publicado;
  } finally { await gateway.close(); }
  const before = leer(lector => lector.meta());
  assert.equal(before.epoca, 0);
  const last = leer(lector => tramoL0(lector, before.t1, 1).at(-1));
  assert.equal(last?.tick, before.t1);
  assert.ok((last?.tiles.length ?? 0) > 100, 'resident terrain on the tape before the restart');
  gateway = createWorkerGateway(options);
  t.after(() => gateway.close());
  await gateway.ready;
  const publicado = esperarEspejo(gateway, before.t1 + 2 * CINTA.pasos[0] + 1, t.signal);
  gateway.start();
  await publicado;
  let after = await gateway.flushTape();
  for (let i = 0; i < 100 && after.latestTick <= before.t1 + 2 * CINTA.pasos[0]; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    after = await gateway.flushTape();
  }
  // El servidor reabre el mundo donde lo guardó al cerrar: la época nueva empieza ahí, con un fotograma clave.
  const { meta, resp } = leer(lector => ({ meta: lector.meta(), resp: JSON.parse(lector.chunk({ t: before.t1, n: 1, nivel: 0 })) as ChunkResp }));
  assert.equal(meta.epoca, 1); assert.equal(resp.epoca, 1);
  const resumed = resp.baseFrame;
  assert.equal(resumed?.tick, before.t1, 'the new epoch starts at the saved tick');
  assert.ok(resumed?.performance?.activeTiles);
  // El terreno residente puede cambiar al paso siguiente, incluso sin reiniciar.
  assert.equal(resumed.tiles.length, resumed.performance.activeTiles, 'the reopened frame keeps every resident tile of its own tick');
});
