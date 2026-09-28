/**
 * T100 / contrato 4c: ejecutar en DOS procesos secuenciales, dentro del mismo
 * scope con MemoryMax=8 GiB, MemorySwapMax=0 y NODE_OPTIONS=--max-old-space-size=6144.
 *
 *   npx tsx scripts/lab/t100-escala-procesos.mts write /ruta/nueva/world.sqlite /ruta/nueva/manifest.json
 *   npx tsx scripts/lab/t100-escala-procesos.mts read  /ruta/nueva/world.sqlite /ruta/nueva/manifest.json
 *
 * El cuarto argumento de write permite un número menor de chunks para un smoke.
 * Nunca se eliminan ni se sobrescriben archivos. Un fallo conserva la evidencia.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { createWorld, type World } from '../../src/world/index.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { parseParams } from '../../src/world/params.js';
import { Store } from '../../src/server/store.js';

const EXPECTED_CHUNKS = 8192;
const SEED = 51926;
const peakRssBytes = (): number => process.resourceUsage().maxRSS * 1024;
const metrics = () => ({
  heapLimitBytes: getHeapStatistics().heap_size_limit,
  heapUsedBytes: process.memoryUsage().heapUsed,
  rssBytes: process.memoryUsage().rss,
  peakRssBytes: peakRssBytes(),
});

// Misma geometría y cuerpo de la prueba T100 existente. Los decimales proceden
// de la posición y traffic incluye -0, que el digesto distingue de +0.
function wideWorld(chunks: number): World {
  const world = createWorld(SEED, parseParams({ limites: {
    teselasActivas: chunks * 256, chunks, comunidades: 12,
  } }));
  const template = world.tiles.find(tile => tile.terrain === 'meadow');
  assert.ok(template, 'falta una tesela meadow de plantilla');
  assert.ok(Object.keys(world.chunks).length <= chunks, 'el mundo inicial supera el objetivo');
  for (let cx = 100; Object.keys(world.chunks).length < chunks; cx++) {
    const cy = 100, key = `${cx},${cy}`;
    world.chunks[key] = { key, cx, cy, discovered: false, places: [], lastTick: 0 };
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const tx = cx * 16 + x, ty = cy * 16 + y, n = tx * 65537 + ty * 7919;
      const fraction = (n % 1000003) / 1000003;
      world.tiles.push({ ...template, x: tx, y: ty, fauna: 0, species: undefined,
        moisture: fraction, vegetation: 1 - fraction / 3, food: fraction / 7, growth: fraction / 11,
        fertility: 1 - fraction / 5, drinkingWater: fraction / 13, cultivation: fraction / 17,
        traffic: n % 4 === 0 ? -0 : fraction / 19, life: fraction / 23, elevation: fraction / 29,
        wood: n % 7, stone: n % 5, variety: n % 4 });
    }
  }
  return world;
}

interface Manifest {
  contract: 'T100-4c-processes-v1';
  sqlite: string;
  seed: number;
  tiles: number;
  chunks: number;
  negativeZeroTraffic: number;
  digest: string;
  logicalSnapshotBytes: number;
  sqliteBytes: number;
  writer: ReturnType<typeof metrics> & { generationMs: number; saveMs: number; digestMs: number; totalMs: number };
}

function write(sqlite: string, manifestPath: string, chunks: number): void {
  assert.ok(!existsSync(sqlite), `SQLite ya existe: ${sqlite}`);
  assert.ok(!existsSync(manifestPath), `manifiesto ya existe: ${manifestPath}`);
  assert.ok(!existsSync(`${manifestPath}.read.json`), 'ya existe un resultado de lectura');
  const started = performance.now();
  const world = wideWorld(chunks);
  const generationMs = performance.now() - started;
  const tiles = world.tiles.length, actualChunks = Object.keys(world.chunks).length;
  assert.equal(tiles, chunks * 256);
  assert.equal(actualChunks, chunks);
  const negativeZeroTraffic = world.tiles.reduce((count, tile) => count + Number(Object.is(tile.traffic, -0)), 0);
  assert.ok(negativeZeroTraffic > 0, 'el cuerpo no contiene -0');
  const store = new Store(sqlite);
  let logicalSnapshotBytes: number;
  const saveStart = performance.now();
  try {
    store.save(world);
    logicalSnapshotBytes = store.lastSnapshotBytes;
  } finally { store.close(); }
  const saveMs = performance.now() - saveStart;
  const digestStart = performance.now();
  // Store.save consume journals: el digest de referencia es el mundo CONFIRMADO.
  const digest = digestoCanonico(world);
  const digestMs = performance.now() - digestStart;
  const record: Manifest = {
    contract: 'T100-4c-processes-v1', sqlite, seed: SEED, tiles, chunks: actualChunks,
    negativeZeroTraffic, digest, logicalSnapshotBytes,
    sqliteBytes: statSync(sqlite).size,
    writer: { ...metrics(), generationMs, saveMs, digestMs, totalMs: performance.now() - started },
  };
  writeFileSync(manifestPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ mode: 'write', manifest: manifestPath, ...record }));
}

function read(sqlite: string, manifestPath: string): void {
  const resultPath = `${manifestPath}.read.json`;
  assert.ok(existsSync(sqlite), `SQLite ausente: ${sqlite}`);
  assert.ok(!existsSync(resultPath), `resultado ya existe: ${resultPath}`);
  const record = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  assert.equal(record.contract, 'T100-4c-processes-v1');
  assert.equal(record.sqlite, sqlite, 'el manifiesto apunta a otro SQLite');
  assert.equal(record.seed, SEED);
  assert.match(record.digest, /^[a-f0-9]{64}$/);
  assert.equal(statSync(sqlite).size, record.sqliteBytes, 'cambió el tamaño del SQLite');
  const started = performance.now();
  const store = new Store(sqlite, { readOnly: true });
  let world: World;
  try {
    const loaded = store.load();
    assert.ok(loaded, 'SQLite sin mundo confirmado');
    world = loaded.world;
  } finally { store.close(); }
  const loadMs = performance.now() - started;
  const tiles = world.tiles.length, chunks = Object.keys(world.chunks).length;
  const negativeZeroTraffic = world.tiles.reduce((count, tile) => count + Number(Object.is(tile.traffic, -0)), 0);
  const digestStart = performance.now();
  const digest = digestoCanonico(world);
  const digestMs = performance.now() - digestStart;
  const result = {
    contract: record.contract, sqlite, manifest: manifestPath,
    matching: digest === record.digest && tiles === record.tiles && chunks === record.chunks
      && negativeZeroTraffic === record.negativeZeroTraffic,
    digest, expectedDigest: record.digest, tiles, chunks, negativeZeroTraffic,
    logicalSnapshotBytes: record.logicalSnapshotBytes, sqliteBytes: statSync(sqlite).size,
    reader: { ...metrics(), loadMs, digestMs, totalMs: performance.now() - started },
  };
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ mode: 'read', result: resultPath, ...result }));
  assert.ok(result.matching, 'digest, geometría o -0 difieren del proceso escritor');
}

const [mode, sqliteArg, manifestArg, chunksArg] = process.argv.slice(2);
if (!['write', 'read'].includes(mode ?? '') || !sqliteArg || !manifestArg
  || mode === 'read' && chunksArg !== undefined
  || mode === 'write' && chunksArg !== undefined && !/^[1-9]\d*$/.test(chunksArg)) {
  throw new Error('Uso: t100-escala-procesos.mts write|read <sqlite> <manifest.json> [chunks para write]');
}
const sqlite = resolve(sqliteArg), manifestPath = resolve(manifestArg);
assert.notEqual(sqlite, manifestPath, 'SQLite y manifiesto deben ser archivos distintos');
const chunks = chunksArg === undefined ? EXPECTED_CHUNKS : Number(chunksArg);
assert.ok(Number.isSafeInteger(chunks) && chunks > 0 && chunks <= EXPECTED_CHUNKS);
if (mode === 'write') write(sqlite, manifestPath, chunks);
else read(sqlite, manifestPath);
