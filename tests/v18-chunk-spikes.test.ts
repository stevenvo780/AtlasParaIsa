import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tile } from '../src/shared/types.js';
import {
  bindWorldContext, closePolicyGpuBatchers,
  createWorld, stepWorld, tileAt, worldContext, type World,
} from '../src/world/index.js';
import { closeEcosystemWorkers, initializeEcosystem } from '../src/world/ecosystem.js';
import { activate, evictColdChunks, maintainRegions } from '../src/world/spatial.js';
import {
  faunaCacheAppended, faunaCacheBuilds, faunaCacheFiltered, materializeAnimals, syncFauna, type Animal,
} from '../src/world/animals.js';
import {
  firstTileAt, lastTileAt, splitTileBlocks, splitTileBlocksWith, tileIndexAppended,
  tileIndexBuilds, tileIndexCopied, tileLookup, verifiedChunkBlocks,
} from '../src/world/tile-index.js';
import { chunkKey, generateChunk } from '../src/world/terrain.js';
import { ResidentTopologyOwner, residentBackingArray, residentTopologyToken } from '../src/world/soa/topologia.js';
import { DEFAULT_PARAMS, paramsOf, parseParams, setParams } from '../src/world/params.js';
import { digestoCanonico } from '../src/world/digesto.js';

function wrapResident(world: World): ResidentTopologyOwner {
  const owner = new ResidentTopologyOwner();
  world.tiles = owner.tiles(world.tiles.map(t => owner.tile(t)));
  bindWorldContext(world, { ...worldContext(world), tileOwnership: owner });
  return owner;
}

/** Proyección de referencia desde cero (sin caché): recorre todas las teselas y aplica `animals`. */
function referenceSyncFaunaScratch(tiles: Tile[], animals: Animal[]): void {
  const counts = new Map<string, { count: number; species: NonNullable<Tile['species']> }>();
  for (const a of animals) {
    const k = `${a.x},${a.y}`;
    const prev = counts.get(k), species = a.species as NonNullable<Tile['species']>;
    if (prev) { prev.count++; if (species < prev.species) prev.species = species; }
    else counts.set(k, { count: 1, species });
  }
  const byKey = new Map<string, Tile>();
  for (const t of tiles) byKey.set(`${t.x},${t.y}`, t);
  const touched = new Set<string>();
  for (const t of tiles) if (t.fauna) touched.add(`${t.x},${t.y}`);
  for (const k of counts.keys()) touched.add(k);
  for (const k of touched) {
    const tile = byKey.get(k);
    if (!tile) continue;
    const c = counts.get(k);
    const nextFauna = c?.count ?? 0;
    if (!Object.is(tile.fauna, nextFauna)) tile.fauna = nextFauna;
    if (c) {
      if (tile.species !== c.species) tile.species = c.species;
    } else if (tile.species !== undefined) tile.species = undefined;
  }
}

// V23 (i1): el motor deja `species = undefined` en lugar de borrar la clave (teselas de forma fija en V8): "sin especie" es valor undefined, no clave ausente.
const tileSnapshot = (tiles: readonly Tile[]): string =>
  residentBackingArray(tiles)
    .map(t => `${t.x},${t.y}|${Object.is(t.fauna, -0) ? '-0' : String(t.fauna)}|${t.species !== undefined ? String(t.species) : '<absent>'}`)
    .join('\n');

test('V18 spikes: paridad bit a bit (0 ULP) entre mundo residente y referencia plana con altas, retiros, reanimaciones y pasos múltiples', async () => {
  const paramsPlain = parseParams({
    motor: { ...DEFAULT_PARAMS.motor, hilos: 1, gpu: [], soaTerreno: false, particionarPersonas: false },
  });
  const paramsRes = parseParams({
    motor: { ...DEFAULT_PARAMS.motor, hilos: 1, gpu: [], soaTerreno: true, particionarPersonas: false },
  });

  const plain = createWorld(51926, paramsPlain);
  const resident = createWorld(51926, paramsRes);
  wrapResident(resident);

  const digestNormalized = (w: World): string => {
    const saved = paramsOf(w);
    setParams(w, paramsPlain);
    const d = digestoCanonico(w);
    setParams(w, saved);
    return d;
  };

  // Calentar índices en ambos mundos.
  stepWorld(plain, [], worldContext(plain));
  stepWorld(resident, [], worldContext(resident));
  assert.equal(digestNormalized(resident), digestNormalized(plain), 'paridad tras paso inicial');

  const indexBuilds0 = tileIndexBuilds();
  const faunaScans0 = faunaCacheBuilds();

  let activations = 0;
  let retirements = 0;
  for (let tick = 0; tick < 90; tick++) {
    // Desplazamientos que fuerzan altas, retiros (incluso chunks con fauna viva) y reanimaciones.
    if (tick === 10 || tick === 40) {
      for (const w of [plain, resident]) {
        for (const p of w.people) { p.x += 48; p.y += 32; p.target = { x: p.x, y: p.y }; }
      }
    } else if (tick === 25 || tick === 65) {
      for (const w of [plain, resident]) {
        for (const p of w.people) { p.x -= 48; p.y -= 32; p.target = { x: p.x, y: p.y }; }
      }
    }
    const beforeKeys = new Set(Object.keys(resident.chunks));
    stepWorld(plain, [], worldContext(plain));
    stepWorld(resident, [], worldContext(resident));
    const afterKeys = new Set(Object.keys(resident.chunks));
    for (const k of afterKeys) if (!beforeKeys.has(k)) activations++;
    for (const k of beforeKeys) if (!afterKeys.has(k)) retirements++;

    assert.ok(residentTopologyToken(resident.tiles), `tick ${tick}: el token de topología residente sigue vigente tras subsetBlocks`);
    if (tick % 15 === 0 || tick === 89) {
      assert.equal(digestNormalized(resident), digestNormalized(plain), `divergencia en tick ${tick}`);
    }
  }

  assert.ok(activations > 10, `se esperaban altas de chunks, ocurrieron ${activations}`);
  assert.ok(retirements > 10, `se esperaban retiros de chunks, ocurrieron ${retirements}`);
  assert.equal(tileIndexBuilds(), indexBuilds0, '0 reconstrucciones completas de tile-index durante altas y retiros');
  assert.equal(faunaCacheBuilds(), faunaScans0, '0 barridos completos de syncFauna durante altas y retiros');

  await closePolicyGpuBatchers();
  await closeEcosystemWorkers();
});

test('V18 spikes: retirar chunks con fauna viva, activar chunks con fauna inicial y reanimar conserva paridad exacta', () => {
  const plain = createWorld(77);
  const resident = createWorld(77);
  wrapResident(resident);

  // Calentar cachés en ambos.
  syncFauna(plain.tiles, plain.animals);
  syncFauna(resident.tiles, resident.animals);
  const indexBuilds0 = tileIndexBuilds();
  const faunaScans0 = faunaCacheBuilds();

  // Activar chunks distantes que generen fauna inicial.
  const coords: [number, number][] = [[160, 160], [176, 160], [192, 160], [208, 160], [224, 160], [240, 160]];
  for (const [x, y] of coords) {
    activate(plain, x, y, worldContext(plain));
    activate(resident, x, y, worldContext(resident));
  }
  const spawnedRemote = resident.animals.filter(a => a.x >= 160);
  assert.ok(spawnedRemote.length > 0, 'los chunks activados deben contener fauna inicial');

  // Borrar parte de la fauna recién nacida antes de syncFauna: faunaCacheAppended debe asegurar su limpieza a fauna=0 sin species.
  const victimId = spawnedRemote[0]!.id;
  for (const w of [plain, resident]) {
    w.animals = w.animals.filter(a => a.id !== victimId);
    syncFauna(w.tiles, w.animals);
  }
  assert.equal(tileSnapshot(resident.tiles), tileSnapshot(plain.tiles), 'paridad tras activar y matar fauna recién nacida');

  // Retirar chunks con fauna viva mediante maintainRegions (los remotos no tienen personas cerca).
  maintainRegions(plain, worldContext(plain));
  maintainRegions(resident, worldContext(resident));
  assert.ok(resident.retiredChunks.some(c => (c.animals?.length ?? 0) > 0), 'al menos un chunk retirado llevaba fauna viva');
  syncFauna(plain.tiles, plain.animals);
  syncFauna(resident.tiles, resident.animals);
  assert.equal(tileSnapshot(resident.tiles), tileSnapshot(plain.tiles), 'paridad tras retirar chunks con fauna viva');

  // Reanimar los chunks retirados y volver a sincronizar.
  for (const [x, y] of coords) {
    activate(plain, x, y, worldContext(plain));
    activate(resident, x, y, worldContext(resident));
  }
  syncFauna(plain.tiles, plain.animals);
  syncFauna(resident.tiles, resident.animals);
  assert.equal(tileSnapshot(resident.tiles), tileSnapshot(plain.tiles), 'paridad tras reanimar chunks retirados');
  assert.equal(digestoCanonico(resident), digestoCanonico(plain), 'digesto exacto tras ciclo activar → retirar → reanimar');

  assert.equal(tileIndexBuilds(), indexBuilds0, 'sin reconstrucciones de tile-index');
  assert.equal(faunaCacheBuilds(), faunaScans0, 'sin barridos completos de syncFauna');
});

test('V18 spikes: fail-closed ante teselas parciales/no-bloque, mutaciones externas, escrituras in-place y procedencia ajena', () => {
  // 1. Respaldo no-bloque: añadir una tesela suelta fuerza el camino fallback en retireActiveChunks y en syncFauna.
  const plain = createWorld(19);
  const resident = createWorld(19);
  const owner = wrapResident(resident);
  activate(plain, 160, 160, worldContext(plain));
  activate(resident, 160, 160, worldContext(resident));
  syncFauna(plain.tiles, plain.animals);
  syncFauna(resident.tiles, resident.animals);

  const loose: Tile = initializeEcosystem(19, {
    x: 999, y: 999, terrain: 'meadow', biome: 'grassland', moisture: 0.5, vegetation: 0.5, food: 0.2,
  });
  loose.fauna = 2;
  loose.species = 'hare';
  plain.tiles.push({ ...loose });
  resident.tiles.push(owner.tile({ ...loose }));
  assert.equal(verifiedChunkBlocks(resident.tiles), null, 'una tesela suelta desactiva la disposición por chunks');

  maintainRegions(plain, worldContext(plain));
  maintainRegions(resident, worldContext(resident));
  syncFauna(plain.tiles, plain.animals);
  syncFauna(resident.tiles, resident.animals);
  assert.equal(tileSnapshot(resident.tiles), tileSnapshot(plain.tiles), 'fallback no-bloque coincide con referencia');
  const looseAfter = tileAt(resident, { x: 999, y: 999 })!;
  assert.equal(looseAfter.fauna, 0);
  assert.equal(Object.hasOwn(looseAfter, 'species'), true);

  // 2. Mutación in-place en un array observado (residentInPlaceRevision cambia sin cambiar length).
  const w2 = createWorld(23);
  const owner2 = wrapResident(w2);
  syncFauna(w2.tiles, w2.animals);
  const scansBefore = faunaCacheBuilds();
  const emptyIdx = w2.tiles.findIndex(t => !t.fauna);
  assert.ok(emptyIdx >= 0);
  const orig = w2.tiles[emptyIdx]!;
  const replaced = owner2.tile({ ...orig, fauna: 3, species: 'wolf' });
  w2.tiles[emptyIdx] = replaced;
  syncFauna(w2.tiles, w2.animals);
  assert.equal(faunaCacheBuilds(), scansBefore + 1, 'mutación in-place revoca caché y fuerza rescan');
  assert.equal(w2.tiles[emptyIdx]!.fauna, 0);
  assert.equal(Object.hasOwn(w2.tiles[emptyIdx]!, 'species'), true);

  // 3. Push externo sin avisar a tileIndexAppended / faunaCacheAppended.
  const w3 = createWorld(29);
  const owner3 = wrapResident(w3);
  syncFauna(w3.tiles, w3.animals);
  const scans3 = faunaCacheBuilds();
  const extraChunk = generateChunk(29, 20, 20).tiles.map(t => {
    const init = initializeEcosystem(29, t);
    return owner3.tile(init);
  });
  extraChunk[0]!.fauna = 2;
  extraChunk[0]!.species = 'deer';
  w3.tiles.push(...extraChunk); // sin llamar a faunaCacheAppended
  syncFauna(w3.tiles, w3.animals);
  assert.equal(faunaCacheBuilds(), scans3 + 1, 'push externo sin aviso reconstruye');
  assert.equal(extraChunk[0]!.fauna, 0);
  assert.equal(Object.hasOwn(extraChunk[0]!, 'species'), true);

  // 3b. Reemplazar el array público sin ganchos no puede reutilizar la caché de la identidad anterior.
  const scansReplace = faunaCacheBuilds();
  const replacement = owner3.tiles(residentBackingArray(w3.tiles).map(t => owner3.tile({ ...t })));
  w3.tiles = replacement;
  syncFauna(w3.tiles, w3.animals);
  assert.equal(faunaCacheBuilds(), scansReplace + 1, 'una referencia nueva de world.tiles fuerza una reconstrucción completa');

  // Las escrituras directas observables de fauna/especie se normalizan igual que antes desde las identidades animales.
  const occupied = residentBackingArray(w3.tiles).find(t => t.fauna)!;
  assert.ok(occupied);
  const expectedCount = w3.animals.filter(a => a.x === occupied.x && a.y === occupied.y).length;
  occupied.fauna = 123;
  occupied.species = 'wolf';
  const scansMutation = faunaCacheBuilds();
  syncFauna(w3.tiles, w3.animals);
  assert.equal(occupied.fauna, expectedCount, 'syncFauna restaura el conteo tras una escritura directa');
  assert.equal(occupied.species, w3.animals.filter(a => a.x === occupied.x && a.y === occupied.y)
    .map(a => a.species).sort()[0], 'syncFauna restaura la especie representativa');
  assert.equal(faunaCacheBuilds(), scansMutation, 'la escritura de campos de tile no invalida el cache de identidad/longitud');

  // 4. Animal fuera de mapa antes de activar el chunk de esas coordenadas: no debe escribir fauna=0 sobre undefined.
  const w4 = createWorld(31);
  const owner4 = wrapResident(w4);
  const ghost: Animal = { ...w4.animals[0]!, id: 'animal-ghost-1', x: 320, y: 320, species: 'fox' };
  syncFauna(w4.tiles, [...w4.animals, ghost]);
  const c320 = generateChunk(31, 20, 20).tiles.map(t => {
    const clean: Tile = { ...t };
    delete clean.fauna;
    delete clean.species;
    return owner4.tile(clean);
  });
  const from4 = w4.tiles.length;
  w4.tiles.push(...c320);
  tileIndexAppended(w4.tiles, from4);
  faunaCacheAppended(w4.tiles, from4);
  syncFauna(w4.tiles, w4.animals); // el animal fantasma ya no está
  assert.equal(c320[0]!.fauna, undefined, 'la tesela sin fauna previa no se contamina por un animal fuera de mapa');

  // 5. faunaCacheFiltered rechaza un arreglo chunk-aligned de procedencia ajena (blockIds distintos).
  const wA = createWorld(41);
  const wB = createWorld(41);
  syncFauna(wA.tiles, wA.animals);
  // Modificar manualmente wB.tiles[0] con fauna sin syncFauna en wB, y llamar faunaCacheFiltered(wA, wB).
  const idxB = wB.tiles.findIndex(t => !t.fauna);
  wB.tiles[idxB]!.fauna = 4;
  wB.tiles[idxB]!.species = 'boar';
  const scansB = faunaCacheBuilds();
  faunaCacheFiltered(wA.tiles, wB.tiles);
  syncFauna(wB.tiles, wB.animals);
  assert.equal(faunaCacheBuilds(), scansB + 1, 'blockIds distintos impiden heredar caché de otro mundo');
  assert.equal(wB.tiles[idxB]!.fauna, 0);
  assert.equal(wB.tiles[idxB]!.species, undefined);
});

test('V18 spikes: tile-index sobre Proxy residente coincide 100 % con arreglo plano en todos los helpers', () => {
  const owner = new ResidentTopologyOwner();
  const plainChunks = [generateChunk(5, 0, 0), generateChunk(5, 1, 0), generateChunk(5, -1, 2)];
  const plain = plainChunks.flatMap(c => c.tiles.map(t => ({ ...t })));
  const proxied = owner.tiles(plainChunks.flatMap(c => c.tiles.map(t => owner.tile(t))));

  const lookPlain = tileLookup(plain);
  const lookProxied = tileLookup(proxied);
  for (let y = -16; y < 48; y++) for (let x = -16; x < 36; x++) {
    const a = lookPlain(x, y), b = lookProxied(x, y);
    assert.equal(b?.x, a?.x);
    assert.equal(b?.y, a?.y);
    assert.equal(lastTileAt(proxied, x, y), b);
    assert.equal(firstTileAt(proxied, x, y), b);
  }
  assert.equal(lastTileAt(proxied, -0, -0), lookProxied(0, 0));
  assert.equal(lastTileAt(proxied, 0.5, 0), undefined);
  assert.equal(firstTileAt(proxied, NaN, 0), undefined);

  // Append incremental + aislamiento de consulta fijada antes.
  const extra = generateChunk(5, 3, 3);
  const from = proxied.length;
  plain.push(...extra.tiles.map(t => ({ ...t })));
  proxied.push(...extra.tiles.map(t => owner.tile(t)));
  tileIndexAppended(plain, from);
  tileIndexAppended(proxied, from);
  assert.equal(lookProxied(48, 48), undefined, 'consulta fijada antes del alta no ve el bloque nuevo');
  assert.equal(lastTileAt(proxied, 48, 48)?.x, 48);

  // splitTileBlocksWith + subsetBlocks conserva identidades y blockIds.
  const retiredA: Tile[] = [], retiredB: Tile[] = [];
  const buildsBefore = tileIndexBuilds();
  const keptPlain = splitTileBlocks(plain, first => chunkKey(first.x, first.y) === '1,0' ? retiredA : undefined)!;
  const keptProxied = splitTileBlocksWith(
    proxied,
    first => chunkKey(first.x, first.y) === '1,0' ? retiredB : undefined,
    (keptBases, blockLen) => owner.subsetBlocks(proxied, keptBases, blockLen),
  )!;
  assert.equal(tileIndexBuilds(), buildsBefore, 'splitTileBlocksWith no reconstruye el índice');
  assert.equal(keptProxied.length, keptPlain.length);
  assert.equal(retiredB.length, 256);
  assert.ok(residentTopologyToken(keptProxied), 'subsetBlocks conserva certificado fail-closed del owner');
  assert.equal(lastTileAt(keptProxied, 16, 0), undefined);
  assert.equal(lastTileAt(keptProxied, 48, 48)?.x, 48);

  // tileIndexCopied con Proxy de destino.
  const wrappedAgain = owner.tiles(keptProxied);
  tileIndexCopied(wrappedAgain, keptProxied, true);
  assert.equal(tileIndexBuilds(), buildsBefore);
  assert.equal(lastTileAt(wrappedAgain, 48, 48)?.x, 48);
});

test('V18 spikes: a escala real el retiro reutiliza los bloques certificados y la fauna conserva sus índices', t => {
  // Construye un mundo sintético a escala V18: 43 × 40 - 1 = 1 719 chunks = 440 064 teselas.
  const CHUNKS = 1_719;
  const COLS = 43;
  const world = createWorld(51926);
  const owner = new ResidentTopologyOwner();
  const cuencas = DEFAULT_PARAMS.agua.cuencas;

  const allTiles: Tile[] = [];
  const allAnimals: Animal[] = [];
  world.chunks = {};
  for (let i = 0; i < CHUNKS; i++) {
    const cx = i % COLS;
    const cy = Math.floor(i / COLS);
    const chunk = generateChunk(51926, cx, cy, cuencas);
    const { tiles, animals: _a, structures: _s, ...meta } = chunk;
    world.chunks[chunk.key] = meta;
    const init = tiles.map(tile => owner.tile(initializeEcosystem(51926, tile, cuencas)));
    allTiles.push(...init);
    allAnimals.push(...materializeAnimals(51926, init, world.tick));
  }
  // Aproximar el recuento de fauna V18 (~7 500 animales) si el generador produjo más o menos.
  if (allAnimals.length > 7_678) allAnimals.length = 7_678;
  world.tiles = owner.tiles(allTiles);
  world.animals = allAnimals;
  world.places = [];
  world.structures = [];
  // Colocar a todas las personas en (0, 0) para que los chunks lejanos sean candidatos fríos en evictColdChunks.
  for (const p of world.people) { p.x = 4; p.y = 4; }
  bindWorldContext(world, { ...worldContext(world), tileOwnership: owner });

  assert.equal(world.tiles.length, 440_064);

  // Calentamiento inicial (1 build de tile-index + 1 barrido de syncFauna).
  const lookup = tileLookup(world.tiles);
  syncFauna(world.tiles, world.animals);
  const buildsWarm = tileIndexBuilds();
  const scansWarm = faunaCacheBuilds();

  // 1. Consultar el índice sin reconstruirlo sobre las 440k teselas.
  let hits = 0;
  for (let i = 0; i < 200_000; i++) {
    const x = (i * 17) % (COLS * 16);
    const y = ((i * 31) % 640);
    if (lookup(x, y)) hits++;
  }
  assert.ok(hits > 150_000);

  // 2. Cada retiro copia como mucho una vez los bloques conservados.
  const copiarBloques = t.mock.method(owner, 'subsetBlocks');
  const envolverTeselas = t.mock.method(owner, 'tiles');
  const evicted = evictColdChunks(world, { maxActiveChunks: CHUNKS - 4 });
  assert.equal(evicted.length, 4);
  assert.equal(world.tiles.length, (CHUNKS - 4) * 256);
  assert.ok(copiarBloques.mock.callCount() <= evicted.length, 'una sola copia de los bloques activos por retiro');
  assert.equal(envolverTeselas.mock.callCount(), 0, 'el retiro reutiliza la certificación de las teselas activas');

  // Simular movimiento de 200 animales y sincronizar fauna.
  const rawAfter = residentBackingArray(world.tiles);
  for (let i = 0; i < Math.min(200, world.animals.length); i++) {
    const a = world.animals[i]!;
    const cand = tileAt(world, { x: a.x + 1, y: a.y });
    if (cand && world.animals.filter(o => o.x === cand.x && o.y === cand.y).length < 5) a.x = cand.x;
  }
  syncFauna(world.tiles, world.animals);

  // 3. Activar 2 chunks nuevos + syncFauna.
  activate(world, 200 * 16, 200 * 16, worldContext(world));
  activate(world, 201 * 16, 200 * 16, worldContext(world));
  syncFauna(world.tiles, world.animals);

  assert.equal(tileIndexBuilds(), buildsWarm, '0 reconstrucciones completas de tile-index a escala 440k');
  assert.equal(faunaCacheBuilds(), scansWarm, '0 barridos completos de syncFauna a escala 440k');
  assert.ok(residentTopologyToken(world.tiles), 'el token de topología residente sigue válido tras 4 retiros y 2 altas');

  // Verificar exactitud de fauna/species contra una recomputación de referencia en una copia plana.
  const refTiles = residentBackingArray(world.tiles).map(tile => ({ ...tile }));
  referenceSyncFaunaScratch(refTiles, world.animals);
  const curRaw = residentBackingArray(world.tiles);
  assert.equal(curRaw.length, refTiles.length);
  for (let i = 0; i < curRaw.length; i++) {
    assert.ok(Object.is(curRaw[i]!.fauna, refTiles[i]!.fauna), `fauna difiere en índice ${i}`);
    assert.equal(curRaw[i]!.species, refTiles[i]!.species, `species difiere en índice ${i}`);
    assert.equal(Object.hasOwn(curRaw[i]!, 'species'), Object.hasOwn(refTiles[i]!, 'species'), `hasOwn(species) difiere en índice ${i}`);
  }
  assert.equal(curRaw.length, (CHUNKS - 4 + 2) * 256);
  assert.equal(rawAfter, curRaw, 'activate empuja in-place sobre el mismo backing del array observado');
});
