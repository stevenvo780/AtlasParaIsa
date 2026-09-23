import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneWorld, createWorld, stepWorld, type World } from '../src/world/index.js';
import { activate, maintainRegions, bindWorldContext, worldContext } from '../src/world/spatial.js';
import { HISTORICAL_PARAMS, paramsOf, setParams } from '../src/world/params.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { generateChunk } from '../src/world/terrain.js';

test('reactivating a shared dormant chunk cannot mutate the confirmed world or its archive', () => {
  const original = createWorld(51926);
  for (const person of original.people) { person.x = 400; person.y = 400; }
  maintainRegions(original);
  const chunk = original.retiredChunks.find(c => c.places.length > 0 && (c.animals?.length ?? 0) > 0)!;
  assert.ok(chunk, 'fixture must include nested places and animals');
  const before = digestoCanonico(original), draft = cloneWorld(original);
  assert.notEqual(draft.retiredChunks, original.retiredChunks);
  assert.equal(draft.retiredChunks.find(c => c.key === chunk.key), chunk);
  activate(draft, chunk.cx * 16, chunk.cy * 16);
  const place = draft.places.find(p => p.id === chunk.places[0]!.id)!;
  place.gatherings++;
  const animal = draft.animals.find(a => a.id === chunk.animals![0]!.id)!;
  animal.memory.push({ x: animal.x, y: animal.y, food: 0, water: 0.2, visited: true, tick: draft.tick });
  animal.health = 0.25;
  assert.equal(digestoCanonico(original), before);
  assert.notEqual(digestoCanonico(draft), before);
});

test('reactivation also isolates objects returned by a caching archive reader', () => {
  const original = createWorld(7), chunk = generateChunk(original.seed, 30, 30);
  const before = structuredClone(chunk);
  const draft = cloneWorld(original, { loadChunk: () => chunk });
  activate(draft, 480, 480);
  draft.tiles.find(tile => tile.x === chunk.tiles[0]!.x && tile.y === chunk.tiles[0]!.y)!.food = 0;
  draft.chunks[chunk.key]!.lastTick++;
  assert.deepEqual(chunk, before);
});

test('shared dormant chunks preserve the full-copy trajectory over three seeds', () => {
  for (const seed of [1, 7, 51926]) {
    const original = createWorld(seed);
    original.retiredChunks.push(generateChunk(seed, 30, 30));
    const copied = structuredClone(original);
    bindWorldContext(copied, worldContext(original)); setParams(copied, paramsOf(original));
    const shared = cloneWorld(original);
    for (let tick = 0; tick < 120; tick++) {
      if (tick === 0 || tick === 60) for (const world of [copied, shared]) {
        const x = tick === 0 ? 480 : 17;
        for (const person of world.people) { person.x = x; person.y = x; person.target = { x, y: x }; }
      }
      stepWorld(copied); stepWorld(shared);
      assert.equal(digestoCanonico(shared), digestoCanonico(copied));
    }
    assert.equal(digestoCanonico(shared), digestoCanonico(copied));
  }
});

/** Cada objeto alcanzable dos veces, con los dos caminos que llegan a él: `world.events` y
 * `chronicleJournal.pending` comparten sucesos, y un lugar vive a la vez en `world.places` y en
 * el meta de su chunk activo (`activate`). Si el clon rompe ese compartir, una ley que escribe
 * por un camino deja de verse por el otro sin que el digesto del primer paso lo note. */
function caminosCompartidos(world: World): string[] {
  const visto = new Map<object, string>(), compartidos: string[] = [];
  const visitar = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object') return;
    const previo = visto.get(value);
    if (previo !== undefined) { compartidos.push(`${previo} == ${path}`); return; }
    visto.set(value, path);
    if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) if (i in value) visitar(value[i], `${path}[${i}]`); return; }
    for (const [key, entry] of Object.entries(value)) visitar(entry, `${path}.${key}`);
  };
  visitar({ ...world, tiles: [], retiredChunks: [] }, '$');
  return compartidos;
}

/** El clon íntegro de siempre: `structuredClone` de todo menos las teselas. Es el control. */
function clonEstructural(world: World): World {
  const draft: World = structuredClone({ ...world, tiles: [] });
  draft.tiles = world.tiles.map(tile => ({ ...tile }));
  bindWorldContext(draft, worldContext(world)); setParams(draft, paramsOf(world));
  return draft;
}

/** Un mundo con cola de chunks dormidos y lugares reanimados: los habitantes se mudan lejos
 * (retira el barrio de origen) y vuelven (reanima y republica sus lugares). La fixture se midió en el
 * mundo de antes de reglas 10 y parte de `HISTORICAL_PARAMS` explícitos: con los defaults nuevos
 * ninguna de las tres semillas comparte un lugar entre `places` y `chunks` a los 600 pasos. */
function mundoEnvejecido(seed: number, pasos = 600): World {
  const world = createWorld(seed, HISTORICAL_PARAMS);
  for (let tick = 0; tick < pasos; tick++) {
    if (tick === 100 || tick === 300) {
      const d = tick === 100 ? 400 : 16;
      for (const person of world.people) { person.x = d; person.y = d; person.target = { x: d, y: d }; }
    }
    stepWorld(world);
  }
  return world;
}

test('el clon por campo conserva el estado y el compartir de objetos del clon estructural', () => {
  let conLugarEnChunk = 0;
  for (const seed of [1, 7, 51926]) {
    const world = mundoEnvejecido(seed);
    const control = clonEstructural(world), draft = cloneWorld(world);
    assert.equal(digestoCanonico(draft), digestoCanonico(world));
    assert.equal(digestoCanonico(draft), digestoCanonico(control));
    const compartidos = caminosCompartidos(world);
    assert.ok(compartidos.length > 0, 'el mundo envejecido debe ejercer objetos compartidos');
    assert.deepEqual(caminosCompartidos(draft), compartidos);
    assert.deepEqual(caminosCompartidos(control), compartidos);
    if (compartidos.some(path => path.includes('.chunks.'))) conLugarEnChunk++;
  }
  assert.ok(conLugarEnChunk > 0, 'alguna semilla debe compartir un lugar entre places y chunks');
});

test('un lugar compartido con el meta de su chunk sigue siendo el mismo objeto en el borrador', () => {
  const world = mundoEnvejecido(7);
  const par = caminosCompartidos(world).find(path => path.includes('.chunks.'));
  assert.ok(par, 'la fixture debe compartir un lugar entre places y chunks');
  const indice = Number(/^\$\.places\[(\d+)\]/.exec(par!)![1]);
  const clave = /\$\.chunks\.([^.]+)\.places/.exec(par!)![1]!;
  const before = digestoCanonico(world), draft = cloneWorld(world);
  const lugar = draft.places[indice]!;
  assert.equal(draft.chunks[clave]!.places.find(p => p.id === lugar.id), lugar);
  lugar.gatherings++;
  assert.equal(draft.chunks[clave]!.places.find(p => p.id === lugar.id)!.gatherings, lugar.gatherings);
  assert.equal(digestoCanonico(world), before);
  assert.notEqual(digestoCanonico(draft), before);
});

test('un valor que no es objeto plano viaja por structuredClone', () => {
  const world = createWorld(1) as World & { sonda?: { cuando: Date; sinPrototipo: Record<string, number> } };
  const sinPrototipo = Object.assign(Object.create(null) as Record<string, number>, { n: 3 });
  world.sonda = { cuando: new Date(86400000), sinPrototipo };
  const draft = cloneWorld(world) as typeof world;
  assert.ok(draft.sonda!.cuando instanceof Date);
  assert.equal(draft.sonda!.cuando.getTime(), 86400000);
  assert.notEqual(draft.sonda!.cuando, world.sonda!.cuando);
  assert.equal(draft.sonda!.sinPrototipo.n, 3);
});
