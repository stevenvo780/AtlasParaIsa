// V18 ola 2 (carril D) — acelerar blocksGet/tileLookup, filtrarCerca, perceivedRoutes y choose con 0 ULP.
//
// Paridad por tres vías:
//  1. digestos canónicos de mundos completos (3 semillas × 240 pasos × DEFAULT_PARAMS y
//     hostOpenWorldParams, plano y residente con ResidentTopologyOwner) medidos ANTES de optimizar
//     en este mismo worktree (probe de hardware fijo: no dependen de la torre);
//  2. referencias literales del comportamiento anterior para tileLookup/lastTileAt/firstTileAt
//     (el Map "x,y" de siempre) y para filtrarCerca/algunoCerca/primeroCerca (filter/some/find),
//     incluidas coordenadas negativas, no enteras, chunks dispersos y mutaciones del arreglo;
//  3. micro-bancos con cifras por t.diagnostic (stepWorld con 1.000 habitantes y tileLookup).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  bindWorldContext, closeFaunaParallelPools, closePolicyGpuBatchers,
  createWorld, stepWorld, worldContext,
} from '../src/world/index.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, parseParams, setParams, type WorldParams } from '../src/world/params.js';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import { ResidentTopologyOwner } from '../src/world/soa/topologia.js';
import { residentFastAccess, residentTileReader } from '../src/world/soa/terreno.js';
import { firstTileAt, lastTileAt, tileIndexAppended, tileLookup } from '../src/world/tile-index.js';
import { algunoCerca, filtrarCerca, primeroCerca, type Punto } from '../src/world/indice-puntos.js';
import { founderGenome } from '../src/world/genetics.js';

after(async () => {
  closePolicyGpuBatchers();
  await closeFaunaParallelPools();
  await closeEcosystemWorkers();
});

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// ───────────────────────── 1. digestos de mundos completos ─────────────────────────
const GiB = 1024 ** 3;
const probe = { cpuThreads: () => 1, totalRamBytes: () => 128 * GiB, nvrtcAvailable: () => false, nvidiaSmi: () => '',
  memory: () => ({ fisicaBytes: 128 * GiB, heapBytes: 8 * GiB }) };
const BASE_DIGESTS: Record<'default' | 'host', Record<number, string>> = {
  default: {
    7: 'dc4cec9e52d6b17d6a5441ae92ee2c85b641ef6815081f20c9f98a7a59aa95df',
    42: '94380d2e54cb40a81a7f77c051a9f121333f2afcb0c453cdc00b835c22dfc2af',
    51926: 'e12924bd298917cc46b1fd6fe5f319cbe50be8010712af72a57e0bd4bd582fbe',
  },
  host: {
    7: 'a2d3c767df5c26d2809f33ed01ccd439a9ce44789715f78552151b7473f5a725',
    42: 'f510f82ba0f4ace80c8a1767394850cfd8775c0cb8df7764875943ee22a0cf9d',
    51926: '7ef3c4dd7ac72a820f84c004db4d2c64066720542592cb2acd15891909b39dd8',
  },
};
const PASOS = 240;
for (const conjunto of ['default', 'host'] as const) {
  for (const [seedText, expected] of Object.entries(BASE_DIGESTS[conjunto])) {
    const seed = Number(seedText);
    // paridad histórica: cuarentena V23
    test.skip(`V18 ola2 digesto 0 ULP: ${conjunto} semilla ${seed}, ${PASOS} pasos, plano y residente`, { timeout: 600_000 }, () => {
      const params: WorldParams = conjunto === 'host' ? hostOpenWorldParams(DEFAULT_PARAMS, probe) : DEFAULT_PARAMS;
      const plain = createWorld(seed, params);
      for (let i = 0; i < PASOS; i++) stepWorld(plain);
      assert.equal(digestoCanonico(plain), expected, 'plano');

      const exec = parseParams({ motor: { ...params.motor, soaTerreno: true, hilos: 4, gpu: [] } }, params);
      const resident = createWorld(seed, exec);
      const owner = new ResidentTopologyOwner();
      resident.tiles = owner.tiles(resident.tiles.map(t => owner.tile(t)));
      bindWorldContext(resident, { ...worldContext(resident), tileOwnership: owner });
      let fastHits = 0, readerHits = 0;
      for (let i = 0; i < PASOS; i++) {
        stepWorld(resident, [], worldContext(resident));
        if (residentFastAccess(resident.tiles)) fastHits++;
        if (residentTileReader(resident.tiles)) readerHits++;
      }
      assert.ok(fastHits > 0 && readerHits > 0, `el residente ejercita fast/exact (fast ${fastHits}, lector ${readerHits})`);
      setParams(resident, params);
      assert.equal(digestoCanonico(resident), expected, 'residente (params de ejecución normalizados sólo para hashear)');
    });
  }
}

// ───────────────────────── 2. tileLookup / lastTileAt / firstTileAt ─────────────────────────
type Celda = { x: number; y: number };
const referenciaLast = (tiles: readonly Celda[]): Map<string, Celda> => new Map(tiles.map(t => [`${t.x},${t.y}`, t] as const));
function chunkTiles(cx: number, cy: number): Celda[] {
  const out: Celda[] = [];
  for (let s = 0; s < 256; s++) out.push({ x: cx * 16 + (s & 15), y: cy * 16 + (s >> 4) });
  return out;
}
const CONSULTAS_BORDE: [unknown, unknown][] = [
  [-0, 0], [0, -0], [0.5, 0], [-0.5, -1], [NaN, 0], [0, NaN], [Infinity, 0], [-Infinity, 3],
  [2 ** 24, 0], [-(2 ** 24) - 1, 0], [2 ** 31, 0], [2 ** 53, -(2 ** 53)], [1e7 - 1, -1e7], [null, 0], [undefined, 1], ['1', 2],
];
function comprobarTiles(tiles: Celda[], etiqueta: string): void {
  const ref = referenciaLast(tiles), lookup = tileLookup(tiles);
  const consultas: [unknown, unknown][] = [...CONSULTAS_BORDE];
  for (const t of tiles) consultas.push([t.x, t.y], [t.x + 1, t.y - 1]);
  for (let y = -40; y <= 40; y += 7) for (let x = -40; x <= 40; x += 5) consultas.push([x, y]);
  for (const [x, y] of consultas) {
    const esperado = ref.get(`${x},${y}`);
    assert.equal(lastTileAt(tiles, x, y), esperado, `${etiqueta} lastTileAt(${String(x)},${String(y)})`);
    if (typeof x === 'number' && typeof y === 'number') assert.equal(lookup(x, y), esperado, `${etiqueta} tileLookup(${x},${y})`);
    assert.equal(firstTileAt(tiles, x as number, y as number), tiles.find(t => t.x === (x as number) && t.y === (y as number)), `${etiqueta} firstTileAt(${String(x)},${String(y)})`);
  }
}

test('V18 ola2 tileLookup: chunks dispersos alineados, rejilla dispersa con duplicadas y modo cadena coinciden con el Map "x,y"', () => {
  // Modo aritmético (Blocks): chunks completos en orden no geográfico, con huecos entre ellos.
  const porChunks = [...chunkTiles(3, -4), ...chunkTiles(-2, -1), ...chunkTiles(0, 0), ...chunkTiles(-2, 2)];
  comprobarTiles(porChunks, 'chunks');
  // Disco de radio 7 cruzando 4 chunks, empezando en cada esquina de chunk: el patrón de `choose`.
  const lookup = tileLookup(porChunks), ref = referenciaLast(porChunks);
  for (const [px, py] of [[0, 0], [15, 15], [-17, -3], [52, -60], [-32, 33]] as const) {
    for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
      if (dx * dx + dy * dy > 49) continue;
      assert.equal(lookup(px + dx, py + dy), ref.get(`${px + dx},${py + dy}`), `disco (${px},${py}) + (${dx},${dy})`);
    }
  }
  // Modo rejilla: coordenadas dispersas, negativas, no enteras, fuera de rango y duplicadas (gana la última).
  const rnd = lcg(41), dispersas: Celda[] = [];
  for (let i = 0; i < 300; i++) dispersas.push({ x: Math.floor(rnd() * 200) - 100, y: Math.floor(rnd() * 200) - 100 });
  dispersas.push({ x: 0.5, y: -0.5 }, { x: -0, y: 0 }, { x: NaN, y: 1 }, { x: 2 ** 24, y: 0 }, { x: 1, y: Infinity },
    { x: 5, y: 5 }, { x: 5, y: 5 }, { x: -100.25, y: 33.75 });
  comprobarTiles(dispersas, 'rejilla');
  // Modo cadena: una coordenada que no es número.
  const conCadena = [{ x: 'a', y: 1 }, { x: 1, y: 2 }, { x: 'a', y: 1 }] as unknown as Celda[];
  comprobarTiles(conCadena, 'cadena');
});

test('V18 ola2 tileLookup: la consulta fijada no ve chunks añadidos después; una nueva sí (caché local incluidos fallos)', () => {
  const tiles = [...chunkTiles(0, 0), ...chunkTiles(1, 0)];
  const antes = tileLookup(tiles);
  assert.equal(antes(32, 0), undefined, 'el chunk (2,0) aún no existe y el fallo queda en caché local');
  assert.ok(antes(0, 0) && antes(31, 15));
  const desde = tiles.length;
  tiles.push(...chunkTiles(2, 0));
  tileIndexAppended(tiles, desde);
  assert.equal(antes(32, 0), undefined, 'la consulta fijada antes del alta sigue sin ver el chunk nuevo');
  assert.equal(antes(33, 5), undefined);
  assert.ok(antes(0, 0) && antes(31, 15), 'y sigue viendo los chunks de su momento');
  const despues = tileLookup(tiles), ref = referenciaLast(tiles);
  for (let y = -2; y <= 17; y++) for (let x = -2; x <= 50; x++) assert.equal(despues(x, y), ref.get(`${x},${y}`), `tras alta (${x},${y})`);
  assert.equal(lastTileAt(tiles, 32, 0), ref.get('32,0'));
  // Mutación por push sin `tileIndexAppended`: al cambiar la longitud, la próxima consulta reconstruye.
  const suelta = { x: 500, y: -500 };
  tiles.push(suelta);
  assert.equal(tileLookup(tiles)(500, -500), suelta);
  assert.equal(lastTileAt(tiles, 500, -500), suelta);
  // Mutar un campo de una tesela se ve por identidad (la consulta devuelve el mismo objeto).
  const mutable = { x: 700, y: 700, food: 1 } as Celda & { food: number };
  tiles.push(mutable);
  const vista = tileLookup(tiles)(700, 700) as typeof mutable;
  mutable.food = 2;
  assert.equal(vista, mutable); assert.equal(vista.food, 2);
});

// ───────────────────────── 3. indice-puntos ─────────────────────────
/** Orden de llamadas al predicado según la spec de la rejilla (casillas cx exterior, cy interior). */
function ordenDeLlamadas(puntos: readonly Punto[], centro: Punto, alcance: number): number[] {
  const celdas = new Map<string, number[]>();
  puntos.forEach((p, i) => {
    const k = `${Math.floor(p.x / 4)},${Math.floor(p.y / 4)}`, lista = celdas.get(k);
    if (lista) lista.push(i); else celdas.set(k, [i]);
  });
  const orden: number[] = [];
  for (let cx = Math.floor((centro.x - alcance) / 4); cx <= Math.floor((centro.x + alcance) / 4); cx++)
    for (let cy = Math.floor((centro.y - alcance) / 4); cy <= Math.floor((centro.y + alcance) / 4); cy++) {
      const lista = celdas.get(`${cx},${cy}`);
      if (lista) orden.push(...lista);
    }
  return orden;
}

test('V18 ola2 filtrarCerca/algunoCerca/primeroCerca: mismos elementos, mismo orden y mismo orden de predicado que filter/some/find', () => {
  const rnd = lcg(97), puntos: ({ x: number; y: number; id: number })[] = [];
  // Orden de inserción inverso al geográfico para que el recorrido por casillas desordene posiciones.
  for (let i = 0; i < 400; i++) puntos.push({ x: Math.floor(rnd() * 160) - 80, y: Math.floor(rnd() * 160) - 80, id: i });
  puntos.push({ x: -4, y: -4, id: 400 }, { x: -1, y: 3, id: 401 }, { x: 0, y: 0, id: 402 }, { x: 3.5, y: -2.5, id: 403 },
    { x: 4, y: 4, id: 404 }, { x: -5, y: 7, id: 405 }, { x: 0, y: 0, id: 406 });
  const distancia = (a: Punto, b: Punto) => Math.hypot(a.x - b.x, a.y - b.y);
  for (const centro of [{ x: 0, y: 0 }, { x: -33.5, y: 21.25 }, { x: 79, y: -79 }, { x: 500, y: 500 }]) {
    for (const alcance of [0, 0.5, 1, 3, 8, 40]) {
      const radio = alcance;
      const pred = (p: (typeof puntos)[number]) => distancia(p, centro) <= radio && p.id % 3 !== 0;
      assert.deepEqual(filtrarCerca(puntos, centro, alcance + 1, pred), puntos.filter(pred), `filtrar centro ${centro.x},${centro.y} alcance ${alcance}`);
      assert.equal(algunoCerca(puntos, centro, alcance + 1, pred), puntos.some(pred), 'alguno');
      assert.equal(primeroCerca(puntos, centro, alcance + 1, pred), puntos.find(pred), 'primero');
    }
  }
  // Orden exacto de invocación del predicado (recorrido por casillas), aunque el resultado salga ordenado.
  const centro = { x: -9, y: 13 }, llamadas: number[] = [];
  filtrarCerca(puntos, centro, 13, (p) => { llamadas.push(p.id); return distancia(p, centro) <= 12; });
  assert.deepEqual(llamadas, ordenDeLlamadas(puntos, centro, 13));
  // Fallbacks: centro/al alcance no finitos y un elemento inválido recorren el arreglo entero como filter.
  const predFino = (p: (typeof puntos)[number]) => !!p && distancia(p, { x: 0, y: 0 }) <= 9;
  assert.deepEqual(filtrarCerca(puntos, { x: NaN, y: 0 }, 10, predFino), puntos.filter(predFino));
  assert.deepEqual(filtrarCerca(puntos, { x: 0, y: 0 }, Infinity, predFino), puntos.filter(predFino));
  const conInvalido = [...puntos, null] as unknown as (typeof puntos);
  assert.deepEqual(filtrarCerca(conInvalido, { x: 0, y: 0 }, 10, predFino), conInvalido.filter(predFino));
  assert.deepEqual(filtrarCerca([], { x: 0, y: 0 }, 5, () => true), []);
});

// ───────────────────────── 4. micro-bancos (diagnóstico, sin umbral de pared estricto) ─────────────────────────
test('V18 ola2 banco: tileLookup sobre 262.144 teselas en chunks (disco de radio 7, consulta nueva por disco)', (t) => {
  const tiles: Celda[] = [];
  for (let cy = -16; cy < 16; cy++) for (let cx = -16; cx < 16; cx++) tiles.push(...chunkTiles(cx, cy));
  const rnd = lcg(999), centros = Array.from({ length: 512 }, () => tiles[Math.floor(rnd() * tiles.length)]!);
  const discos = 4000;
  let halladas = 0;
  const t0 = performance.now();
  for (let r = 0; r < discos; r++) {
    const lookup = tileLookup(tiles), c = centros[r % centros.length]!;
    for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
      if (dx * dx + dy * dy > 49) continue;
      if (lookup(c.x + dx, c.y + dy)) halladas++;
    }
  }
  const ms = performance.now() - t0, consultas = discos * 149;
  let esperadas = 0;
  const ref = referenciaLast(tiles);
  for (let r = 0; r < discos; r++) {
    const c = centros[r % centros.length]!;
    for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
      if (dx * dx + dy * dy > 49) continue;
      if (ref.get(`${c.x + dx},${c.y + dy}`)) esperadas++;
    }
  }
  assert.equal(halladas, esperadas);
  t.diagnostic(`tileLookup ${tiles.length} teselas: ${consultas} consultas en ${ms.toFixed(1)} ms = ${(ms * 1e6 / consultas).toFixed(1)} ns/consulta (halladas ${halladas})`);
});

test('V18 ola2 banco: stepWorld con 1.000 habitantes durante 20 pasos', { timeout: 300_000 }, (t) => {
  const world = createWorld(20261122, DEFAULT_PARAMS);
  const templates = world.people, land = world.tiles.filter(tile => tile.terrain !== 'water');
  assert.ok(land.length >= 900, `teselas de tierra (${land.length})`);
  const rnd = lcg(12345), people: typeof templates = [];
  for (let k = 0; k < 1000; k++) {
    const person = structuredClone(templates[k % templates.length]!);
    person.role = k === 0 ? 'S' : k === 1 ? 'I' : 'neighbor';
    person.id = `bench-${k}`; person.name = `Habitante ${k}`;
    person.genome = founderGenome(20261122, person.id, { curiosity: rnd(), sociability: rnd(), industriousness: rnd(), care: rnd(), resilience: rnd() });
    person.bonds = {}; person.communityId = null;
    const cell = land[k % land.length]!;
    person.x = cell.x; person.y = cell.y; person.target = { x: cell.x, y: cell.y };
    person.decisionAt = world.tick + (k % 30);
    person.hunger = 0.2 + rnd() * 0.4; person.thirst = 0.2 + rnd() * 0.4;
    people.push(person);
  }
  world.people = people;
  for (let i = 0; i < 3; i++) stepWorld(world);
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) stepWorld(world);
  const ms = performance.now() - t0;
  t.diagnostic(`stepWorld 1.000 habitantes: 20 pasos en ${ms.toFixed(1)} ms = ${(ms / 20).toFixed(2)} ms/paso (habitantes ${world.people.length}, teselas ${world.tiles.length})`);
  assert.ok(world.people.length > 900, 'sin mortandad masiva en el banco');
  assert.ok(ms / 20 < 250, `el paso no debe dispararse (${(ms / 20).toFixed(1)} ms/paso)`);
});


