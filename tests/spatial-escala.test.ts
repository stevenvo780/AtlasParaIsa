import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cloneWorld, createWorld, stepWorld, tileAt, type World } from '../src/world/index.js';
import { activate, maintainRegions, validCoordinate, worldContext, type WorldContext } from '../src/world/spatial.js';
import { chunkCoords, chunkKey, generateChunk, legacyStructures, type Chunk } from '../src/world/terrain.js';
import { initializeEcosystem } from '../src/world/ecosystem.js';
import { materializeAnimals } from '../src/world/animals.js';
import { paramsOf } from '../src/world/params.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { firstTileAt, lastTileAt, splitTileBlocks, tileIndexAppended, tileIndexBuilds, tileIndexCopied, tileLookup } from '../src/world/tile-index.js';
import type { Tile } from '../src/shared/types.js';

/** T113: tileAt aritmético, `retiredChunks` por clave y `maintainRegions` incremental, contra la
 * implementación anterior (copiada aquí tal cual estaba en 200d284) como oráculo. */

function aleatorio(seed: number): () => number {
  let n = seed >>> 0 || 1;
  return () => { n ^= n << 13; n >>>= 0; n ^= n >>> 17; n ^= n << 5; n >>>= 0; return n / 4294967296; };
}
const porCadena = <T extends { x: unknown; y: unknown }>(tiles: readonly T[]) => new Map(tiles.map(t => [`${t.x},${t.y}`, t]));

function viejoActivate(world: World, x: number, y: number, context: WorldContext = worldContext(world)): void {
  if (!validCoordinate(x) || !validCoordinate(y)) return;
  const key = chunkKey(x, y);
  if (world.chunks[key]) return;
  const pending = world.retiredChunks.findIndex(c => c.key === key);
  const { cx, cy } = chunkCoords(x, y);
  const cuencas = paramsOf(world).agua.cuencas;
  const archived = pending >= 0 ? world.retiredChunks.splice(pending, 1)[0]! : context.loadChunk?.(key, world.tick);
  const chunk = archived ? structuredClone(archived) : generateChunk(world.seed, cx, cy, cuencas);
  const { tiles, animals, structures, ...meta } = chunk;
  world.chunks[key] = meta;
  const initialized = tiles.map(tile => initializeEcosystem(world.seed, tile, cuencas));
  world.tiles.push(...initialized);
  world.animals.push(...(animals ?? materializeAnimals(world.seed, initialized, world.tick)));
  world.structures.push(...(structures ?? legacyStructures(tiles, world.tick)));
  for (const place of meta.places) if (!world.places.some(p => p.id === place.id)) world.places.push(place);
}
function viejoMaintainRegions(world: World, context: WorldContext = worldContext(world)): void {
  const needed = new Set<string>();
  for (const person of world.people) {
    for (const dx of [-8, 0, 8]) for (const dy of [-8, 0, 8]) {
      const x = person.x + dx, y = person.y + dy;
      if (!validCoordinate(x) || !validCoordinate(y)) continue;
      needed.add(chunkKey(x, y)); viejoActivate(world, x, y, context);
    }
  }
  const retired = new Set<string>();
  const detached = new Map<string, Chunk>();
  for (const [key, meta] of Object.entries(world.chunks)) {
    if (needed.has(key)) continue;
    const chunk: Chunk = { ...meta, lifeVersion: 4, lastTick: world.tick, tiles: [], places: [], animals: [], structures: [] };
    world.retiredChunks.push(chunk); detached.set(key, chunk);
    delete world.chunks[key]; retired.add(key);
  }
  if (retired.size) {
    const active: Tile[] = [];
    for (const tile of world.tiles) {
      const chunk = detached.get(chunkKey(tile.x, tile.y));
      if (chunk) chunk.tiles.push(tile); else active.push(tile);
    }
    for (const place of world.places) detached.get(chunkKey(place.x, place.y))?.places.push(place);
    world.tiles = active;
    world.animals = world.animals.filter(animal => {
      const chunk = detached.get(chunkKey(animal.x, animal.y));
      if (chunk) chunk.animals!.push(animal);
      return !chunk;
    });
    world.structures = world.structures.filter(structure => {
      const chunk = detached.get(chunkKey(structure.x, structure.y));
      if (chunk) chunk.structures!.push(structure);
      return !chunk;
    });
    world.places = world.places.filter(p => ['claro', 'refugio', 'huerta'].includes(p.id) || !retired.has(chunkKey(p.x, p.y)));
  }
}

/** Mismo plan de movimientos para los dos mundos: pasos cortos, saltos entre anclas (retiran chunks y
 * reaniman pendientes: la cola pasa de 64 y usa el índice), nacimientos, muertes, bordes del dominio
 * y una coordenada no entera. */
const ANCLAS: [number, number][] = [[0, 0], [300, 40], [-250, 500], [900, -900], [40, 1200], [-1600, -30], [9_999_990, 5], [-10_000_000, 3], [2000, 2000], [-700, -700], [123, -456], [1500, 300]];
const INTERIORES = ANCLAS.filter(([x]) => Math.abs(x) < 1_000_000);
function mover(worlds: World[], r: () => number, paso: number, anclas = ANCLAS): void {
  const people = worlds[0]!.people;
  const plan = people.map(() => {
    const u = r();
    if (u < 0.04) { const [ax, ay] = anclas[Math.floor(r() * anclas.length)]!; return { salto: true, x: ax + Math.floor(r() * 40) - 20, y: ay + Math.floor(r() * 40) - 20 }; }
    return { salto: false, x: u < 0.6 ? Math.floor(r() * 7) - 3 : 0, y: u < 0.6 ? Math.floor(r() * 7) - 3 : 0 };
  });
  const muere = people.length > 4 && r() < 0.05 ? Math.floor(r() * people.length) : -1;
  const nace = r() < 0.06 ? Math.floor(r() * people.length) : -1;
  for (const world of worlds) {
    world.tick++;
    world.people.forEach((p, i) => { const m = plan[i]!; if (m.salto) { p.x = m.x; p.y = m.y; } else { p.x += m.x; p.y += m.y; } });
    if (paso === 37) world.people[0]!.x += 0.5;
    if (paso === 38) world.people[0]!.x -= 0.5;
    if (nace >= 0) world.people.push({ ...structuredClone(world.people[nace]!), id: `nacido-${paso}` });
    if (muere >= 0) world.people.splice(muere, 1);
  }
}

test('maintainRegions incremental = maintainRegions de siempre: mismo mundo, mismo orden de chunks, mismas teselas', t => {
  for (const seed of [7, 51926]) {
    const nuevo = createWorld(seed), viejo = createWorld(seed), r = aleatorio(seed);
    let retiros = 0, reanimados = 0, maxCola = 0;
    for (let paso = 0; paso < 150; paso++) {
      mover([nuevo, viejo], r, paso);
      const vivos = new Set(Object.keys(viejo.chunks)), cola = new Set(viejo.retiredChunks.map(c => c.key));
      maintainRegions(nuevo); viejoMaintainRegions(viejo);
      for (const k of vivos) if (!(k in viejo.chunks)) retiros++;
      for (const k of Object.keys(viejo.chunks)) if (!vivos.has(k) && cola.has(k)) reanimados++;
      maxCola = Math.max(maxCola, viejo.retiredChunks.length);
      assert.deepEqual(Object.keys(nuevo.chunks), Object.keys(viejo.chunks), `semilla ${seed}, paso ${paso}: orden de world.chunks`);
      assert.deepEqual(nuevo.retiredChunks.map(c => c.key), viejo.retiredChunks.map(c => c.key), `semilla ${seed}, paso ${paso}: cola`);
      if (paso % 75 === 0 || paso === 149) assert.equal(digestoCanonico(nuevo), digestoCanonico(viejo), `semilla ${seed}, paso ${paso}`);
    }
    // El control ejerce lo que cambia: retiros, reanimaciones desde la cola y una cola indexada (≥ 64).
    assert.ok(retiros > 100 && reanimados > 20 && maxCola >= 64, `retiros ${retiros}, reanimados ${reanimados}, cola ${maxCola}`);
    t.diagnostic(JSON.stringify({ seed, retiros, reanimados, maxCola }));
  }
});

test('tileAt responde lo mismo que el Map de claves "x,y" en 10 000 consultas, en sitio, tras el clon y en los bordes', () => {
  const world = createWorld(51926), r = aleatorio(113);
  for (let paso = 0; paso < 40; paso++) { mover([world], r, paso, INTERIORES); maintainRegions(world); }
  const draft = cloneWorld(world);
  stepWorld(draft);
  for (const w of [world, draft]) {
    const referencia = porCadena(w.tiles);
    let aciertos = 0;
    // Alrededor de teselas vivas: dentro, en el borde del conjunto activo y fuera de él.
    for (let n = 0; n < 10_000; n++) {
      const cerca = w.tiles[Math.floor(r() * w.tiles.length)]!, x = cerca.x + Math.floor(r() * 41) - 20, y = cerca.y + Math.floor(r() * 41) - 20;
      const esperado = referencia.get(`${x},${y}`);
      assert.equal(tileAt(w, { x, y }), esperado, `tileAt(${x}, ${y})`);
      if (esperado) aciertos++;
    }
    assert.ok(aciertos > 3000 && aciertos < 9900, `${aciertos} aciertos`);
    const t = w.tiles[w.tiles.length - 1]!;
    for (const [x, y] of [[-0, t.y], [t.x, -0], [t.x + 0.5, t.y], [NaN, t.y], [t.x, Infinity], [2 ** 24, t.y], [-(2 ** 24) - 16, t.y], [String(t.x), t.y], [t.x, `${t.y}`], [undefined, t.y]] as [unknown, unknown][]) {
      assert.equal(lastTileAt(w.tiles, x, y), referencia.get(`${x},${y}`), `lastTileAt(${String(x)}, ${String(y)})`);
      if (typeof x === 'number' && typeof y === 'number') {
        assert.equal(tileLookup(w.tiles)(x, y), referencia.get(`${x},${y}`));
        assert.equal(firstTileAt(w.tiles, x, y), w.tiles.find(tile => tile.x === x && tile.y === y));
      }
    }
  }
});

test('la disposición por chunks cae a la rejilla de siempre en cuanto un arreglo no la cumple', () => {
  const chunks = [generateChunk(7, 0, 0), generateChunk(7, -1, 0), generateChunk(7, 5, -3)];
  const regular = chunks.flatMap(c => c.tiles);
  const cambios: [string, (tiles: Tile[]) => Tile[]][] = [
    ['invertido', tiles => [...tiles].reverse()],
    ['un chunk incompleto', tiles => tiles.slice(0, tiles.length - 1)],
    ['chunk repetido', tiles => [...tiles, ...chunks[0]!.tiles.map(t => ({ ...t }))]],
    ['tesela desplazada', tiles => tiles.map((t, i) => i === 300 ? { ...t, x: t.x + 1 } : t)],
    ['coordenada no entera', tiles => tiles.map((t, i) => i === 256 ? { ...t, x: t.x + 0.25 } : t)],
    ['bloque desalineado', tiles => tiles.map(t => ({ ...t, x: t.x + 3 }))],
    ['hueco', tiles => { const copia = [...tiles]; delete copia[40]; return copia; }],
  ];
  const r = aleatorio(9);
  for (const [nombre, cambiar] of [['regular', (t: Tile[]) => t] as [string, (tiles: Tile[]) => Tile[]], ...cambios]) {
    const tiles = cambiar(regular), referencia = porCadena(tiles.filter(Boolean)), lookup = tileLookup(tiles);
    for (let n = 0; n < 2000; n++) {
      const x = Math.floor(r() * 140) - 40, y = Math.floor(r() * 90) - 60;
      assert.equal(lastTileAt(tiles, x, y), referencia.get(`${x},${y}`), `${nombre}: lastTileAt(${x}, ${y})`);
      assert.equal(lookup(x, y), referencia.get(`${x},${y}`), `${nombre}: tileLookup(${x}, ${y})`);
      assert.equal(firstTileAt(tiles, x, y), tiles.find(t => t?.x === x && t?.y === y), `${nombre}: firstTileAt(${x}, ${y})`);
    }
  }
});

test('terrainIndex (el índice compartido de la fauna) no reconstruye nada al activar ni al retirar un chunk', () => {
  const world = createWorld(51926);
  for (const person of world.people) { person.x = 40; person.y = 20; }
  maintainRegions(world);
  const antes = tileLookup(world.tiles), longitud = world.tiles.length, builds = tileIndexBuilds();
  activate(world, 480, 480);
  assert.equal(tileIndexBuilds(), builds, 'activar no reconstruye el índice');
  const nueva = world.tiles.find(t => t.x === 480 && t.y === 480)!;
  assert.equal(tileLookup(world.tiles)(480, 480), nueva);
  assert.equal(antes(480, 480), undefined, 'la consulta fijada antes no ve teselas añadidas después');
  const referencia = porCadena(world.tiles);
  for (const t of world.tiles) assert.equal(tileLookup(world.tiles)(t.x, t.y), referencia.get(`${t.x},${t.y}`));
  const viejas = world.tiles;
  maintainRegions(world);
  assert.notEqual(world.tiles, viejas, 'hubo retiro');
  assert.equal(tileAt(world, { x: 480, y: 480 }), undefined);
  assert.equal(tileIndexBuilds(), builds, 'retirar tampoco');
  assert.equal(world.tiles.length, longitud);
  // Un paso entero en sitio con fauna, ecología y personas: ninguna reconstrucción, y las mismas teselas.
  let activaciones = 0;
  for (let paso = 0; paso < 150; paso++) {
    const vivos = new Set(Object.keys(world.chunks));
    if (paso % 50 === 25) for (const person of world.people) { person.x += 40; person.target = { x: person.x, y: person.y }; }
    stepWorld(world);
    for (const k of Object.keys(world.chunks)) if (!vivos.has(k)) activaciones++;
  }
  assert.ok(activaciones > 0);
  assert.equal(tileIndexBuilds(), builds, `${activaciones} activaciones sin reconstruir el índice`);
  const final = porCadena(world.tiles);
  for (const a of world.animals) assert.equal(tileLookup(world.tiles)(a.x, a.y), final.get(`${a.x},${a.y}`));
});

test('splitTileBlocks reparte como el recorrido tesela a tesela y el arreglo nuevo hereda la disposición', () => {
  const chunks = [generateChunk(3, 0, 0), generateChunk(3, 1, 0), generateChunk(3, 0, 1), generateChunk(3, -2, 4)];
  const tiles = chunks.flatMap(c => c.tiles), fuera = new Map([['1,0', [] as Tile[]], ['-2,4', [] as Tile[]]]);
  tileLookup(tiles);
  const builds = tileIndexBuilds();
  const kept = splitTileBlocks(tiles, first => fuera.get(chunkKey(first.x, first.y)))!;
  const esperado = new Map([['1,0', [] as Tile[]], ['-2,4', [] as Tile[]]]), quedan: Tile[] = [];
  for (const t of tiles) (esperado.get(chunkKey(t.x, t.y)) ?? quedan).push(t);
  assert.deepEqual(kept, quedan); assert.deepEqual(fuera, esperado);
  for (const t of tiles) assert.equal(lastTileAt(kept, t.x, t.y), quedan.find(q => q === t));
  assert.equal(tileIndexBuilds(), builds);
  // Añadir tras heredar: sigue sin reconstruir; añadir algo que no es un chunk completo sí descarta.
  const antes = kept.length;
  kept.push(...generateChunk(3, 9, 9).tiles); tileIndexAppended(kept, antes);
  assert.equal(lastTileAt(kept, 150, 150)?.x, 150);
  assert.equal(tileIndexBuilds(), builds);
  const n = kept.length; kept.push({ ...kept[0]!, x: 999, y: 999 }); tileIndexAppended(kept, n);
  assert.equal(lastTileAt(kept, 999, 999), kept[n]);
  assert.equal(tileIndexBuilds(), builds + 1);
  assert.equal(splitTileBlocks(kept, () => undefined), null, 'sin disposición por chunks, el llamador reparte tesela a tesela');
});

test('tileIndexCopied: una copia posición a posición hereda la disposición sin recorrer teselas; otra cosa no', () => {
  const world = createWorld(51926);
  tileAt(world, world.tiles[0]!);
  const builds = tileIndexBuilds(), copia = world.tiles.map(t => ({ ...t }));
  tileIndexCopied(copia, world.tiles);
  const referencia = porCadena(copia);
  for (const t of copia) assert.equal(lastTileAt(copia, t.x, t.y), referencia.get(`${t.x},${t.y}`));
  assert.equal(lastTileAt(copia, 1e6, 3), undefined);
  assert.equal(tileIndexBuilds(), builds);
  const invertida = [...copia].reverse();
  tileIndexCopied(invertida, copia);
  assert.equal(lastTileAt(invertida, copia[5]!.x, copia[5]!.y), copia[5]);
  assert.equal(tileIndexBuilds(), builds + 1, 'el resguardo rechaza lo que no es una copia y se construye como siempre');
});

/** Arreglo que cuenta los accesos a sus elementos (lecturas y escrituras por índice). */
function contado<T>(items: T[]): { array: T[]; accesos: () => number; reiniciar: () => void } {
  let n = 0;
  const indice = (p: string | symbol) => typeof p === 'string' && /^\d+$/.test(p);
  const array = new Proxy(items, {
    get(target, p, receiver) { if (indice(p)) n++; return Reflect.get(target, p, receiver); },
    set(target, p, value, receiver) { if (indice(p)) n++; return Reflect.set(target, p, value, receiver); },
  });
  return { array, accesos: () => n, reiniciar: () => { n = 0; } };
}
function relleno(cantidad: number): Chunk[] {
  return Array.from({ length: cantidad }, (_, i) => ({ key: `${20_000 + i},${-20_000}`, cx: 20_000 + i, cy: -20_000, discovered: true, places: [], lastTick: 0, lifeVersion: 4, tiles: [], animals: [], structures: [] }));
}

test('activate con 100 000 chunks retirados es O(1): mismos accesos a la cola que con 1 000 y mismo resultado que findIndex', t => {
  const medidas: Record<string, number> = {};
  for (const R of [1_000, 100_000]) {
    const nuevo = createWorld(7), viejo = createWorld(7);
    const pendiente: Chunk = { ...generateChunk(7, 50, 50), lifeVersion: 4, lastTick: 0 };
    const cola = contado([...relleno(R), pendiente]);
    nuevo.retiredChunks = cola.array; viejo.retiredChunks = [...relleno(R), structuredClone(pendiente)];
    // Una cola que se consulta pocas veces (la copia de cada paso de `cloneWorld`) se recorre como siempre;
    // a la octava consulta con la misma identidad se indexa.
    for (let i = 0; i < 8; i++) { activate(nuevo, (60 + i) * 16, 60 * 16); viejoActivate(viejo, (60 + i) * 16, 60 * 16); }
    cola.reiniciar();
    let started = performance.now();
    activate(nuevo, 61 * 16, 61 * 16); // chunk que no está en la cola: se genera
    medidas[`nuevo R=${R}`] = performance.now() - started;
    const generado = cola.accesos();
    started = performance.now();
    viejoActivate(viejo, 61 * 16, 61 * 16);
    medidas[`findIndex R=${R}`] = performance.now() - started;
    cola.reiniciar();
    activate(nuevo, 50 * 16, 50 * 16); viejoActivate(viejo, 50 * 16, 50 * 16); // el último retirado: se reanima
    const reanimado = cola.accesos();
    assert.equal(generado, 0, `R=${R}: un chunk nuevo no toca la cola`);
    assert.ok(reanimado <= 4, `R=${R}: reanimar el último retirado toca ${reanimado} elementos`);
    medidas[`accesos R=${R}`] = generado + reanimado;
    assert.equal(nuevo.retiredChunks.length, R);
    assert.deepEqual(Object.keys(nuevo.chunks), Object.keys(viejo.chunks));
    assert.equal(nuevo.tiles.length, viejo.tiles.length);
    if (R === 1_000) assert.equal(digestoCanonico(nuevo), digestoCanonico(viejo));
    else assert.deepEqual(nuevo.retiredChunks.map(c => c.key), viejo.retiredChunks.map(c => c.key));
  }
  assert.equal(medidas['accesos R=1000'], medidas['accesos R=100000']);
  t.diagnostic(JSON.stringify(medidas));
});

/** `world.chunks` que cuenta cada trampa: enumerar, leer, preguntar, escribir y borrar claves. */
function chunksContados(world: World): () => Record<string, number> {
  const n: Record<string, number> = { ownKeys: 0, get: 0, has: 0, set: 0, delete: 0, descriptor: 0 };
  world.chunks = new Proxy(world.chunks, {
    ownKeys(target) { n.ownKeys!++; return Reflect.ownKeys(target); },
    get(target, p, receiver) { n.get!++; return Reflect.get(target, p, receiver); },
    has(target, p) { n.has!++; return Reflect.has(target, p); },
    set(target, p, value, receiver) { n.set!++; return Reflect.set(target, p, value, receiver); },
    deleteProperty(target, p) { n.delete!++; return Reflect.deleteProperty(target, p); },
    getOwnPropertyDescriptor(target, p) { n.descriptor!++; return Reflect.getOwnPropertyDescriptor(target, p); },
  });
  return () => { const copia = { ...n }; for (const k of Object.keys(n)) n[k] = 0; return copia; };
}

test('maintainRegions no recorre world.chunks: un tick sin movimientos no lo toca y uno con movimientos sólo mira lo que cambió', () => {
  const world = createWorld(51926);
  // 120 habitantes repartidos: ~480 chunks vivos.
  const molde = world.people[0]!;
  world.people = Array.from({ length: 120 }, (_, i) => ({ ...structuredClone(molde), id: `p${i}`, x: (i % 12) * 64 + 3, y: Math.floor(i / 12) * 64 + 5 }));
  maintainRegions(world);
  const vivos = Object.keys(world.chunks).length;
  assert.ok(vivos >= 400, `${vivos} chunks vivos`);
  const trampas = chunksContados(world);
  maintainRegions(world); // objeto nuevo (el Proxy): se relee entero una vez
  assert.equal(trampas().ownKeys, 1);
  for (let tick = 0; tick < 20; tick++) {
    maintainRegions(world);
    assert.deepEqual(trampas(), { ownKeys: 0, get: 0, has: 0, set: 0, delete: 0, descriptor: 0 }, `tick ${tick} sin movimientos`);
  }
  world.people[5]!.x += 1; // dentro de sus mismas celdas: nueve lecturas, ningún retiro
  maintainRegions(world);
  assert.deepEqual(trampas(), { ownKeys: 0, get: 9, has: 0, set: 0, delete: 0, descriptor: 0 });
  world.people[7]!.x += 32; // cruza a celdas que nadie pedía: activa y retira, sin enumerar
  maintainRegions(world);
  const cruce = trampas();
  assert.equal(cruce.ownKeys, 0);
  assert.ok(cruce.delete > 0 && cruce.set > 0 && cruce.get < 40, JSON.stringify(cruce));
  assert.equal(Object.keys(world.chunks).length, vivos);
});
