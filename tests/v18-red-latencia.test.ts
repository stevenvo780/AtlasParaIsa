import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { WebSocket as NodeWebSocket } from 'ws';
import { createWorld, stepWorld, projectWorld } from '../src/world/index.js';
import { projectTerrain } from '../src/world/spatial.js';
import { parseParams } from '../src/world/params.js';
import { computeStateDelta, applyStateDelta, fastEqual, tileKey } from '../src/shared/deltas.js';
import { PROTOCOL_VERSION, type PersonView, type ServerMessage, type Tile, type Viewport, type WorldView } from '../src/shared/types.js';
import { Store } from '../src/server/store.js';
import { createApp, TROZO_WS, TROZO_WS_COMPRIMIDO, ESTATICOS_MAX, estaticosEnCache } from '../src/server/app.js';

const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sinRendimiento = (v: WorldView): WorldView => { const c = wire(v); delete c.performance; return c; };
const settle = (ms = 10): Promise<void> => new Promise(r => setTimeout(r, ms));

/* =============================== deltas: equivalencia exacta =============================== */

function tile(x: number, y: number, extra: Partial<Tile> = {}): Tile {
  return { x, y, terrain: 'soil', moisture: 0.25, vegetation: 0.5, food: 0.125, biome: 'forest', elevation: 0.5, feature: 'tree', growth: 0.5, fertility: 0.5, ...extra } as Tile;
}
function person(id: string, extra: Partial<PersonView> = {}): PersonView {
  return { id, name: id, role: 'neighbor', x: 1, y: 1, color: '#fff', action: 'explore', reason: 'r', energy: 0.5, hunger: 0.1, fatigue: 0.2, need: 'none', recentMemory: null,
    traits: { curiosity: 0.1, sociability: 0.2, industriousness: 0.3, care: 0.4, resilience: 0.5 }, skills: { farm: 0.1 }, materials: { wood: 1, stone: 2 }, ...extra } as PersonView;
}
function baseView(): WorldView {
  const tiles: Tile[] = [];
  for (let y = 0; y < 5; y++) for (let x = 0; x < 6; x++) tiles.push(tile(x, y, x % 2 ? { wood: 0.5 } : {}));
  return { version: PROTOCOL_VERSION, sequence: 10, tick: 10, day: 1, phase: 'day', weather: 'clear', width: 6, height: 5, tiles,
    people: [person('a'), person('b'), person('c')], places: [{ id: 'p1', name: 'P', x: 1, y: 1, description: 'd', gatherings: 0 }],
    events: [{ id: 'e1', tick: 1, kind: 'x', actors: ['a'], text: 't', cause: 'c', source: 's' } as unknown as WorldView['events'][number]],
    memories: [{ id: 'm1', title: 't', text: 'x', source: 's', placeId: null } as unknown as WorldView['memories'][number]],
    originX: 0, originY: 0, infinite: true, pauseReason: 'pausa', communities: [], technology: { n: 1 } as unknown as WorldView['technology'] };
}
/** `wire(applyStateDelta(wire(prev), wire(delta)))` ≡ `wire(next)`: lo que de verdad ve el cliente. */
function converge(prev: WorldView, next: WorldView, mensaje: string) {
  const delta = computeStateDelta(prev, next);
  const recon = applyStateDelta(wire(prev), wire(delta));
  assert.deepEqual(wire(recon), wire(next), mensaje);
  return { delta, recon };
}

test('computeStateDelta + applyStateDelta: equivalencia exacta con campos que aparecen, cambian, pasan a 0 y desaparecen', () => {
  const prev = baseView();
  const next = wire(prev); next.sequence = 11; next.tick = 11;
  next.tiles[0] = tile(0, 0, { wood: 0.75 });                  // aparece un campo opcional
  next.tiles[1] = tile(1, 0, { wood: 0 });                     // cambia a 0 (presente, no ausente)
  next.tiles[3] = tile(3, 0);                                  // desaparece wood
  next.tiles[4] = tile(4, 0, { food: 0.5, feature: undefined } as Partial<Tile>); // cambia y feature desaparece
  const { delta } = converge(prev, next, 'campos de tesela');
  const ups = delta.tileUpserts as Array<Record<string, unknown>>;
  assert.equal(ups.length, 4, 'solo las teselas cambiadas');
  assert.deepEqual(ups.find(u => u.x === 3), { x: 3, y: 0, wood: null }, 'campo desaparecido ⇒ null');
  assert.deepEqual(ups.find(u => u.x === 4 && u.y === 0), { x: 4, y: 0, food: 0.5, feature: null });
  assert.equal((ups.find(u => u.x === 1) as { wood: number }).wood, 0, 'pasar a 0 NO es desaparecer');
});

test('teselas añadidas, quitadas y actualizadas: el orden (y, x) se conserva', () => {
  const prev = baseView();
  const next = wire(prev); next.sequence = 11;
  // Quita (2,1) y (0,3); añade (9,0) [al final de la fila 0], (3,-1) [antes de todo] y (2,2) tras quitar (2,2)... no: añade (6,2) en medio.
  next.tiles = next.tiles.filter(t => !((t.x === 2 && t.y === 1) || (t.x === 0 && t.y === 3)));
  next.tiles.push(tile(9, 0), tile(3, -1), tile(6, 2));
  next.tiles.sort((a, b) => a.y - b.y || a.x - b.x);
  const k = next.tiles.findIndex(t => t.x === 5 && t.y === 0); next.tiles[k] = tile(5, 0, { food: 0.9 });
  const { recon } = converge(prev, next, 'altas y bajas');
  const orden = recon.tiles.map(tileKey);
  assert.deepEqual(orden, [...recon.tiles].sort((a, b) => a.y - b.y || a.x - b.x).map(tileKey));
  assert.equal(recon.tiles.length, prev.tiles.length - 2 + 3);
  // Solo actualizaciones y bajas: sin inserciones el orden previo se conserva sin reordenar.
  const solo = wire(prev); solo.sequence = 11; solo.tiles.splice(4, 3); solo.tiles[0] = tile(0, 0, { food: 0.33 });
  converge(prev, solo, 'bajas y actualización');
});

test('una base desordenada se ordena igual que antes; las teselas no tocadas se comparten, las tocadas se clonan', () => {
  const prev = baseView();
  const desordenada = wire(prev); desordenada.tiles.reverse();
  const next = wire(prev); next.sequence = 11; next.tiles[0] = tile(0, 0, { food: 0.9 });
  const delta = wire(computeStateDelta(prev, next));
  const applied = applyStateDelta(desordenada, delta);
  assert.deepEqual(applied.tiles.map(tileKey), [...prev.tiles].map(tileKey), 'queda en orden (y, x)');
  // Compartir referencias de lo no tocado, sin mutar la base.
  const ordenada = wire(prev);
  const copia = wire(ordenada);
  const aplicado = applyStateDelta(ordenada, delta);
  assert.deepEqual(ordenada, copia, 'la base no se muta');
  assert.equal(aplicado.tiles[7], ordenada.tiles[7], 'tesela intacta compartida');
  assert.notEqual(aplicado.tiles[0], ordenada.tiles[0], 'tesela modificada = objeto nuevo');
  // Sin cambios de teselas/personas: se reutilizan los arreglos.
  const quieto = applyStateDelta(ordenada, { ...delta, tileUpserts: [], tileRemovals: [], peopleUpserts: [], peopleRemovals: [] });
  assert.equal(quieto.tiles, ordenada.tiles); assert.equal(quieto.people, ordenada.people);
});

test('personas, recuerdos, eventos, comunidades y campos top-level opcionales que aparecen y desaparecen', () => {
  const prev = baseView();
  const next = wire(prev); next.sequence = 11; next.tick = 11;
  next.people = [next.people[0]!, person('c', { x: 5, traits: { curiosity: 0.9, sociability: 0.2, industriousness: 0.3, care: 0.4, resilience: 0.5 } }), person('d')]; // b sale, c cambia, d entra
  next.people[0]!.recentMemory = 'hola';
  next.memories.push({ id: 'm2', title: 't2', text: 'y', source: 's', placeId: null } as unknown as WorldView['memories'][number]);
  next.events = []; // arreglo que cambia de longitud (a vacío)
  next.communities = [{ id: 'c1', name: 'C', x: 1, y: 1, color: '#000', members: ['a'], memberCount: 1, culture: { sharing: 0, stewardship: 0, openness: 0 }, formedAt: 1, cooperation: 0, disputes: 0 }];
  delete next.pauseReason;                       // desaparece
  next.paused = true;                            // aparece
  next.performance = { stepMs: 1 } as unknown as WorldView['performance']; // aparece
  next.regionesVivas = ['0,0'];
  const { delta, recon } = converge(prev, next, 'mezcla');
  assert.equal(recon.pauseReason, undefined); assert.ok(!('pauseReason' in recon), 'la clave desaparecida se borra de verdad');
  assert.equal(delta.worldPatch.pauseReason, null);
  assert.deepEqual(recon.people.map(p => p.id), ['a', 'c', 'd'], 'las personas conservan su orden, las nuevas al final');
  // Segundo paso: el campo vuelve y otro desaparece; y arreglos que crecen.
  const next2 = wire(next); next2.sequence = 12; next2.pauseReason = 'otra'; delete next2.performance; delete next2.paused; next2.events = [prev.events[0]!, prev.events[0]!];
  converge(next, next2, 'vuelta y desaparición');
  // Campo anidado que desaparece dentro de un objeto top-level ⇒ el objeto entero viaja.
  const a = wire(prev); a.stats = { population: 3, history: [1, 2] } as unknown as WorldView['stats'];
  const b = wire(a); b.sequence = 11; delete (b.stats as unknown as Record<string, unknown>).history;
  converge(a, b, 'clave anidada');
});

test('worldPatch omite los campos top-level sin cambio y siempre lleva sequence', () => {
  const prev = baseView();
  const next = wire(prev); next.sequence = 11; next.tick = 11;
  const { delta } = converge(prev, next, 'solo tick');
  assert.deepEqual(Object.keys(delta.worldPatch).sort(), ['sequence', 'tick']);
  assert.equal(delta.worldPatch.sequence, 11);
  const identico = computeStateDelta(prev, wire(prev));
  assert.deepEqual(identico.worldPatch, { sequence: 10 });
  assert.deepEqual([identico.tileUpserts, identico.tileRemovals, identico.peopleUpserts, identico.peopleRemovals], [[], [], [], []]);
});

test('compatibilidad: un worldPatch completo (forma antigua) se sigue aplicando igual', () => {
  const prev = baseView();
  const next = wire(prev); next.sequence = 11; next.tick = 11; next.pauseReason = 'x';
  const { tiles: _t, people: _p, ...patch } = next;
  const viejo = { ...computeStateDelta(prev, next), worldPatch: patch };
  assert.deepEqual(wire(applyStateDelta(wire(prev), wire(viejo))), wire(next));
});

test('fastEqual ≡ JSON.stringify sobre valores aleatorios (undefined, -0, NaN, arreglos, anidados)', () => {
  let seed = 123456789;
  const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const val = (d: number): unknown => {
    const r = rnd();
    if (d > 2 || r < 0.35) return [0, -0, 1, 0.5, NaN, Infinity, 'a', 'b', true, false, null, undefined][Math.floor(rnd() * 12)];
    if (r < 0.65) return Array.from({ length: Math.floor(rnd() * 3) }, () => val(d + 1));
    const o: Record<string, unknown> = {};
    for (const k of ['a', 'b', 'c']) if (rnd() < 0.7) o[k] = val(d + 1);
    return o;
  };
  const mutar = (v: unknown): unknown => {
    if (rnd() < 0.5) return structuredClone(v);
    if (Array.isArray(v)) { const c = v.slice(); if (c.length && rnd() < 0.6) c[Math.floor(rnd() * c.length)] = val(2); else if (rnd() < 0.5) c.pop(); return c; }
    if (v && typeof v === 'object') { const c = { ...(v as Record<string, unknown>) }; const k = ['a', 'b', 'c'][Math.floor(rnd() * 3)]!; if (rnd() < 0.5) delete c[k]; else c[k] = val(2); return c; }
    return val(2);
  };
  let iguales = 0;
  for (let i = 0; i < 20000; i++) {
    const a = val(0), b = mutar(a);
    const esperado = JSON.stringify(a) === JSON.stringify(b);
    if (esperado) iguales++;
    assert.equal(fastEqual(a, b), esperado, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  assert.ok(iguales > 1000 && iguales < 19000, `mezcla útil de iguales/distintos: ${iguales}`);
  assert.equal(fastEqual({ a: undefined }, {}), true);
  assert.equal(fastEqual(0, -0), true);
  assert.equal(fastEqual({ a: 1 }, { a: 1, b: undefined }), true);
  assert.equal(fastEqual({ a: 1 }, { a: 1, b: 0 }), false);
  assert.equal(fastEqual([1, 2], [1, 2, 3]), false);
  assert.equal(fastEqual([], {}), false);
});

/* ================================ deltas: bytes y CPU ================================ */

/** La implementación anterior, tal cual era, como línea base de comparación. */
function computeStateDeltaLegacy(prev: WorldView, next: WorldView) {
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const prevTiles = new Map(prev.tiles.map(t => [tileKey(t), t]));
  const nextKeys = new Set<string>();
  const tileUpserts: Array<Record<string, unknown>> = [];
  for (const t of next.tiles) {
    const key = tileKey(t); nextKeys.add(key);
    const before = prevTiles.get(key);
    if (!before) { tileUpserts.push({ ...t }); continue; }
    const up: Record<string, unknown> = { x: t.x, y: t.y }; let changed = false;
    for (const field of new Set([...Object.keys(before), ...Object.keys(t)])) {
      if (field === 'x' || field === 'y') continue;
      const a = (before as unknown as Record<string, unknown>)[field], b = (t as unknown as Record<string, unknown>)[field];
      if (same(a, b)) continue;
      up[field] = b === undefined ? null : b; changed = true;
    }
    if (changed) tileUpserts.push(up);
  }
  const tileRemovals = prev.tiles.filter(t => !nextKeys.has(tileKey(t))).map(tileKey);
  const prevPeople = new Map(prev.people.map(p => [p.id, p]));
  const ids = new Set(next.people.map(p => p.id));
  const peopleUpserts = next.people.filter(p => { const b = prevPeople.get(p.id); return !b || !same(b, p); });
  const peopleRemovals = prev.people.filter(p => !ids.has(p.id)).map(p => p.id);
  const { tiles: _t, people: _p, ...patch } = next;
  return { type: 'state-delta', baseSequence: prev.sequence, sequence: next.sequence, tileUpserts, tileRemovals, peopleUpserts, peopleRemovals, worldPatch: patch };
}

/** Vista densa y realista: 60×40 teselas, 400 personas y los campos top-level pesados. */
function vistaDensa(): WorldView {
  const tiles: Tile[] = [];
  for (let y = 0; y < 40; y++) for (let x = 0; x < 60; x++) tiles.push(tile(x, y, { wood: (x + y) % 3 ? 0.5 : undefined, fauna: x % 7 === 0 ? 0.25 : undefined, traffic: y % 5 === 0 ? 0.125 : undefined, life: 0.5, species: 'oak' } as unknown as Partial<Tile>));
  const people = Array.from({ length: 400 }, (_, i) => person(`p${i}`, { x: i % 60, y: i % 40, communityId: `c${i % 9}`, age: i, genome: { generation: 1, parents: ['a', 'b'], learningRate: 0.1, cooperation: 0.2, mutations: 1 } }));
  const events = Array.from({ length: 40 }, (_, i) => ({ id: `e${i}`, tick: i, kind: 'k', actors: ['a', 'b'], text: 'evento '.repeat(8), cause: 'c', source: 's' }));
  const memories = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, title: `Recuerdo ${i}`, text: 'texto largo del recuerdo '.repeat(6), source: 's', placeId: null }));
  const communities = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, name: `Comunidad ${i}`, x: i, y: i, color: '#abc', members: people.filter(p => p.communityId === `c${i}`).map(p => p.id), memberCount: 44, culture: { sharing: 0.1, stewardship: 0.2, openness: 0.3 }, formedAt: 1, cooperation: 0.5, disputes: 0 }));
  const animals = Array.from({ length: 60 }, (_, i) => ({ id: `an${i}`, x: i, y: i, kind: 'deer' }));
  return { version: PROTOCOL_VERSION, sequence: 100, tick: 100, day: 1, phase: 'day', weather: 'clear', width: 60, height: 40, tiles, people,
    places: Array.from({ length: 12 }, (_, i) => ({ id: `pl${i}`, name: `Lugar ${i}`, x: i, y: i, description: 'desc '.repeat(10), gatherings: i })), events: events as unknown as WorldView['events'], memories: memories as unknown as WorldView['memories'], communities,
    animals: animals as unknown as WorldView['animals'], originX: 0, originY: 0, infinite: true,
    stats: { population: 400, history: Array.from({ length: 120 }, (_, i) => ({ tick: i, population: 400 })), actions: { explore: 100 }, biomes: { forest: 1 } } as unknown as WorldView['stats'],
    technology: { items: Array.from({ length: 80 }, (_, i) => ({ id: `t${i}`, name: 'x'.repeat(30) })) } as unknown as WorldView['technology'],
    organization: { a: 1, b: [1, 2, 3] } as unknown as WorldView['organization'], demography: { deaths: 3, causes: { hunger: 3 }, recent: [] } };
}
/** El paso siguiente: objetos nuevos (como tras otra proyección), el 5 % de las teselas cambia y 100 personas se mueven. */
function pasoSiguiente(prev: WorldView): WorldView {
  const next = structuredClone(prev); next.sequence++; next.tick++;
  for (let i = 0; i < next.tiles.length; i += 20) next.tiles[i]!.food = 0.875;
  for (let i = 0; i < 100; i++) next.people[i * 4]!.x += 1;
  return next;
}
function mediana(fn: () => void, n = 9): number {
  const t: number[] = [];
  for (let i = 0; i < n; i++) { const t0 = performance.now(); fn(); t.push(performance.now() - t0); }
  return t.sort((a, b) => a - b)[Math.floor(n / 2)]!;
}

test('delta en un viewport grande (60×40 + 400 personas): menos bytes, menos CPU y mismo resultado', t => {
  const prev = vistaDensa(), next = pasoSiguiente(prev);
  const nuevo = computeStateDelta(prev, next), viejo = computeStateDeltaLegacy(prev, next);
  assert.deepEqual(wire(nuevo.tileUpserts), wire(viejo.tileUpserts));
  assert.deepEqual(wire(nuevo.peopleUpserts), wire(viejo.peopleUpserts));
  assert.deepEqual(nuevo.tileRemovals, viejo.tileRemovals); assert.deepEqual(nuevo.peopleRemovals, viejo.peopleRemovals);
  assert.deepEqual(wire(applyStateDelta(wire(prev), wire(nuevo))), wire(next));
  const bNuevo = Buffer.byteLength(JSON.stringify(nuevo)), bViejo = Buffer.byteLength(JSON.stringify(viejo));
  const pNuevo = Buffer.byteLength(JSON.stringify(nuevo.worldPatch)), pViejo = Buffer.byteLength(JSON.stringify(viejo.worldPatch));
  const msNuevo = mediana(() => computeStateDelta(prev, next)), msViejo = mediana(() => computeStateDeltaLegacy(prev, next));
  const base = wire(prev), delta = wire(nuevo);
  const msApNuevo = mediana(() => applyStateDelta(base, delta));
  t.diagnostic(`bytes delta ${bViejo} → ${bNuevo} (${(100 * (1 - bNuevo / bViejo)).toFixed(1)} % menos) · worldPatch ${pViejo} → ${pNuevo} B · computeStateDelta ${msViejo.toFixed(2)} → ${msNuevo.toFixed(2)} ms (${(msViejo / msNuevo).toFixed(1)}×) · applyStateDelta ${msApNuevo.toFixed(2)} ms`);
  assert.ok(pNuevo < pViejo / 5, `worldPatch ${pNuevo} vs ${pViejo}`);
  assert.ok(bNuevo < bViejo * 0.7, `delta ${bNuevo} vs ${bViejo}`);
  assert.ok(msNuevo < msViejo, `computeStateDelta ${msNuevo.toFixed(2)} ms vs ${msViejo.toFixed(2)} ms`);
});

test('applyStateDelta sin cambios de teselas no ordena ni clona la rejilla', t => {
  const prev = vistaDensa(), next = pasoSiguiente(prev);
  const delta = wire(computeStateDelta(prev, next));
  const soloTick = wire(computeStateDelta(prev, Object.assign(structuredClone(prev), { sequence: 101, tick: 101 })));
  const base = wire(prev);
  const ms = mediana(() => applyStateDelta(base, delta)), msQuieto = mediana(() => applyStateDelta(base, soloTick));
  t.diagnostic(`applyStateDelta 2.400 teselas: con ${delta.tileUpserts.length} cambios ${ms.toFixed(2)} ms · sin cambios de teselas ${msQuieto.toFixed(3)} ms`);
  assert.equal(applyStateDelta(base, soloTick).tiles, base.tiles);
});

/* ================================ proyección ================================ */

test('projectWorld: teselas con exactamente las mismas propiedades que la fórmula anterior y sin cantidades a 0', () => {
  const world = createWorld(51926, parseParams('red.deltas=true'));
  for (let i = 0; i < 60; i++) stepWorld(world);
  const V: Viewport = { x: 0, y: 0, width: 40, height: 28 };
  const r3 = (n: number): number => Math.round(n * 1000) / 1000;
  const viewNumber = (v: number | undefined): number | undefined => (typeof v === 'number' ? r3(v) : v);
  const amount = (key: string, value: number | undefined): Record<string, number> => (typeof value !== 'number' || value === 0 ? {} : { [key]: r3(value) });
  const esperado = projectTerrain(world, V).tiles.map(t => ({ x: t.x, y: t.y, terrain: t.terrain, biome: t.biome, elevation: viewNumber(t.elevation), moisture: viewNumber(t.moisture), food: viewNumber(t.food), vegetation: viewNumber(t.vegetation), feature: t.feature, growth: viewNumber(t.growth), fertility: viewNumber(t.fertility), species: t.species, ...amount('wood', t.wood), ...amount('stone', t.stone), ...amount('variety', t.variety), ...amount('cultivation', t.cultivation), ...amount('traffic', t.traffic), ...amount('drinkingWater', t.drinkingWater), ...amount('fauna', t.fauna), ...amount('life', t.life) }));
  const view = projectWorld(world, V);
  assert.equal(view.tiles.length, V.width * V.height);
  assert.deepEqual(view.tiles, esperado);
  const cantidades = ['wood', 'stone', 'variety', 'cultivation', 'traffic', 'drinkingWater', 'fauna', 'life'] as const;
  let con = 0;
  for (const t of view.tiles) for (const k of cantidades) {
    if (Object.hasOwn(t, k)) { con++; assert.notEqual(t[k], 0, `${k} = 0 no debe viajar`); assert.equal(typeof t[k], 'number'); }
  }
  assert.ok(con > 0, 'la muestra contiene cantidades opcionales presentes');
  assert.ok(view.tiles.some(t => cantidades.some(k => !Object.hasOwn(t, k))), 'y teselas con cantidades ausentes');
  assert.ok(view.people.length > 0 && view.people.every(p => typeof p.working === 'boolean' && (p.workProgress ?? 0) >= 0 && (p.workProgress ?? 0) <= 1));
});

/* ================================ app.ts: estáticos con gzip ================================ */

async function freePort(): Promise<number> {
  const probe = createNetServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(r => probe.close(() => r())); return port;
}
async function levantar(t: TestContext, opts: { staticDir?: string; perMessageDeflate?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'carta-v18-'));
  const store = new Store(join(dir, 'world.sqlite'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const password = 'synthetic-v18-password';
  const app = createApp({ store, password, origin, manual: true, seed: 51926, params: parseParams('red.deltas=true'), ...opts });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { app, origin, port, password, dir };
}
function pedir(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, res => {
      const partes: Buffer[] = []; res.on('data', c => partes.push(c as Buffer)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(partes) }));
    });
    req.on('error', reject); req.end();
  });
}

test('estáticos: gzip negociado con Vary, no-store intacto, recarga por mtime/size y respuesta plana sin gzip', async t => {
  const staticDir = mkdtempSync(join(tmpdir(), 'carta-v18-static-'));
  t.after(() => rmSync(staticDir, { recursive: true, force: true }));
  const html = '<!doctype html><title>Carta</title>' + '<p>una carta para Isa</p>'.repeat(120);
  const js = 'export const x = ' + JSON.stringify('ab'.repeat(900)) + ';\n';
  const small = 'a{color:red}';
  writeFileSync(join(staticDir, 'index.html'), html); writeFileSync(join(staticDir, 'app.js'), js); writeFileSync(join(staticDir, 'small.css'), small);
  writeFileSync(join(staticDir, 'logo.png'), Buffer.from(Array.from({ length: 4000 }, (_, i) => i % 251)));
  const f = await levantar(t, { staticDir });

  const gz = await pedir(f.port, '/', { 'Accept-Encoding': 'gzip, deflate, br' });
  assert.equal(gz.status, 200);
  assert.equal(gz.headers['content-encoding'], 'gzip'); assert.equal(gz.headers.vary, 'Accept-Encoding');
  assert.equal(gz.headers['cache-control'], 'no-store');
  for (const h of ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy']) assert.ok(gz.headers[h], `${h} presente`);
  assert.equal(gz.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(gunzipSync(gz.body).toString(), html, 'descomprime idéntico al fichero');
  assert.ok(gz.body.length < html.length / 5, `gzip ${gz.body.length} B vs ${html.length} B`);
  assert.equal(Number(gz.headers['content-length']), gz.body.length);

  const jsGz = await pedir(f.port, '/app.js', { 'Accept-Encoding': 'gzip' });
  assert.equal(jsGz.headers['content-encoding'], 'gzip'); assert.equal(gunzipSync(jsGz.body).toString(), js);
  assert.equal(jsGz.headers['content-type'], 'text/javascript; charset=utf-8');
  t.diagnostic(`estáticos · index.html ${html.length} → ${gz.body.length} B (${(100 * (1 - gz.body.length / html.length)).toFixed(1)} % menos) · app.js ${js.length} → ${jsGz.body.length} B`);

  // Sin gzip: plano, también con q=0 y sin cabecera; el cuerpo es el fichero.
  for (const h of [{}, { 'Accept-Encoding': 'gzip;q=0' }, { 'Accept-Encoding': 'identity' }, { 'Accept-Encoding': 'br' }] as Array<Record<string, string>>) {
    const plano = await pedir(f.port, '/', h);
    assert.equal(plano.status, 200); assert.equal(plano.headers['content-encoding'], undefined, JSON.stringify(h));
    assert.equal(plano.body.toString(), html); assert.equal(plano.headers['cache-control'], 'no-store');
  }
  // Pequeños y binarios: nunca se comprimen.
  const css = await pedir(f.port, '/small.css', { 'Accept-Encoding': 'gzip' });
  assert.equal(css.headers['content-encoding'], undefined); assert.equal(css.body.toString(), small);
  const png = await pedir(f.port, '/logo.png', { 'Accept-Encoding': 'gzip' });
  assert.equal(png.headers['content-encoding'], undefined); assert.equal(png.body.length, 4000);
  // HEAD con gzip: cabeceras, sin cuerpo.
  const head = await pedir(f.port, '/', { 'Accept-Encoding': 'gzip' }, 'HEAD');
  assert.equal(head.headers['content-encoding'], 'gzip'); assert.equal(head.body.length, 0);

  // Cambia el contenido (otro tamaño): se recarga.
  const html2 = html + '<footer>nuevo</footer>';
  writeFileSync(join(staticDir, 'index.html'), html2);
  const recargado = await pedir(f.port, '/', { 'Accept-Encoding': 'gzip' });
  assert.equal(gunzipSync(recargado.body).toString(), html2);
  // Mismo tamaño, otro contenido y otro mtime: también se recarga.
  const html3 = html2.replace('nuevo', 'otros');
  assert.equal(html3.length, html2.length);
  writeFileSync(join(staticDir, 'index.html'), html3);
  const futuro = new Date(Date.now() + 5000); utimesSync(join(staticDir, 'index.html'), futuro, futuro);
  const recargado2 = await pedir(f.port, '/', { 'Accept-Encoding': 'gzip' });
  assert.equal(gunzipSync(recargado2.body).toString(), html3);
  assert.equal((await pedir(f.port, '/', {})).body.toString(), html3);

  // Seguridad intacta: fuera de staticDir y extensiones desconocidas siguen siendo 404.
  assert.equal((await pedir(f.port, '/%2e%2e/secreto.html', { 'Accept-Encoding': 'gzip' })).status, 404);
  assert.equal((await pedir(f.port, '/nada.txt', {})).status, 404);
  assert.equal((await pedir(f.port, '/no-existe.js', {})).status, 404);
});

test('estáticos: la caché está acotada y cada ruta sigue sirviendo su propio contenido', async t => {
  const staticDir = mkdtempSync(join(tmpdir(), 'carta-v18-static-'));
  t.after(() => rmSync(staticDir, { recursive: true, force: true }));
  mkdirSync(join(staticDir, 'm'));
  const total = ESTATICOS_MAX + 20;
  for (let i = 0; i < total; i++) writeFileSync(join(staticDir, 'm', `f${i}.js`), `export const n = ${i}; // ${'x'.repeat(700)}\n`);
  const f = await levantar(t, { staticDir });
  for (let i = 0; i < total; i++) {
    const r = await pedir(f.port, `/m/f${i}.js`, { 'Accept-Encoding': 'gzip' });
    assert.ok(gunzipSync(r.body).toString().startsWith(`export const n = ${i};`));
    assert.ok(estaticosEnCache() <= ESTATICOS_MAX, `caché ${estaticosEnCache()}`);
  }
  assert.equal(estaticosEnCache(), ESTATICOS_MAX);
  const otra = await pedir(f.port, '/m/f0.js', { 'Accept-Encoding': 'gzip' });
  assert.ok(gunzipSync(otra.body).toString().startsWith('export const n = 0;'), 'una entrada expulsada se recarga bien');
});

/* ================================ app.ts: delta grande por WebSocket ================================ */

for (const [modo, perMessageDeflate, trocea] of [['en claro', false, true], ['con deflate adaptativo', undefined, false]] as const) test(`delta grande (>TROZO_WS) por /ws?ack=1 con red.deltas=true llega íntegro y converge (${modo})`, async t => {
  const f = await levantar(t, { perMessageDeflate });
  const login = await fetch(f.origin + '/api/login', { method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: f.password }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const socket = new NodeWebSocket(f.origin.replace('http:', 'ws:') + '/ws?ack=1&x=0&y=0&width=96&height=64', { headers: { Origin: f.origin, Cookie: cookie } });
  const mensajes: { raw: string; msg: ServerMessage; troceado: boolean }[] = [];
  let trozos: string[] | null = null, total = 0;
  socket.on('message', data => {
    const text = data.toString();
    if (trozos) { trozos.push(text); if (trozos.length < total) return; const raw = trozos.join(''); mensajes.push({ raw, msg: JSON.parse(raw) as ServerMessage, troceado: true }); trozos = null; return; }
    const msg = JSON.parse(text) as ServerMessage;
    if (msg.type === 'trozos') { trozos = []; total = msg.partes; return; }
    mensajes.push({ raw: text, msg, troceado: false });
  });
  await once(socket, 'open');
  let recon: WorldView | null = null, cursor = 0, grandes = 0, troceados = 0, mayor = 0;
  const drain = (): void => {
    for (; cursor < mensajes.length; cursor++) {
      const { raw, msg, troceado } = mensajes[cursor]!;
      if (msg.type === 'state') { recon = wire(msg.world); socket.send(JSON.stringify({ type: 'ack', sequence: msg.world.sequence })); }
      else if (msg.type === 'state-delta') {
        assert.ok(recon, 'delta sin base');
        recon = wire(applyStateDelta(recon!, msg));
        mayor = Math.max(mayor, raw.length);
        if (raw.length > TROZO_WS) { grandes++; if (troceado) troceados++; }
        // En claro el trozo es siempre TROZO_WS; con deflate adaptativo es TROZO_WS_COMPRIMIDO mientras el enlace
        // se considere lento y TROZO_WS cuando pasa a «rápido» (loopback): nunca más grande que el segundo.
        if (trocea) assert.equal(troceado, raw.length > TROZO_WS, `troceado=${troceado} con ${raw.length} unidades`);
        else { assert.ok(!troceado || raw.length > TROZO_WS); assert.ok(raw.length <= TROZO_WS_COMPRIMIDO || troceado); }
        socket.send(JSON.stringify({ type: 'ack', sequence: msg.sequence }));
      }
    }
  };
  const esperarSecuencia = async (secuencia: number): Promise<void> => {
    for (let i = 0; i < 400; i++) { drain(); if (recon && (recon as WorldView).sequence >= secuencia) return; await settle(10); }
    assert.fail(`no llegó la secuencia ${secuencia}; mensajes: ${mensajes.map(m => m.msg.type + ":" + m.raw.length).join(",")} · flujo ${JSON.stringify(f.app.flujo)}`);
  };
  await esperarSecuencia(f.app.world.tick);
  // El servidor difunde cada 5 pasos (`tick % 5`); el tick ecológico (`% 10`) es el que mueve ~1.500 teselas.
  for (let i = 0; i < 20; i++) { f.app.stepOnce(); if (f.app.world.tick % 5 === 0) await esperarSecuencia(f.app.world.tick); }
  const flujo = f.app.flujo[0]!;
  t.diagnostic(`${modo} · deltas mayores de ${TROZO_WS} unidades: ${grandes} (troceados ${troceados}) · mayor ${mayor} unidades · comprime=${flujo.comprime}`);
  assert.ok(grandes >= 1, 'hubo al menos un delta grande (tick ecológico en 96×64)');
  if (trocea) { assert.equal(troceados, grandes); assert.equal(flujo.comprime, false); }
  const completo = await (await fetch(`${f.origin}/api/world?x=0&y=0&width=96&height=64`, { headers: { Cookie: cookie } })).json() as WorldView;
  assert.deepEqual(sinRendimiento(recon!), sinRendimiento(completo));
  assert.equal(socket.readyState, NodeWebSocket.OPEN);
  socket.terminate();
});

test('gracia de arranque de página: tras un paso largo cede mientras llegan los recursos encadenados y se desarma al abrir /ws', async t => {
  const staticDir = mkdtempSync(join(tmpdir(), 'carta-v18-boot-'));
  const dir = mkdtempSync(join(tmpdir(), 'carta-v18-boot-db-'));
  t.after(() => { rmSync(staticDir, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Carta</title>');
  writeFileSync(join(staticDir, 'app.js'), 'console.log("ok");');
  const store = new Store(join(dir, 'world.sqlite'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const password = 'synthetic-v18-boot-password';

  let reloj = 1000, duracion = 0;
  const citas: { fn: () => void; ms: number }[] = [];
  const setTimeoutReal = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    citas.push({ fn, ms: ms ?? 0 });
    return { unref() { return this; }, ref() { return this; } };
  }) as unknown as typeof setTimeout;

  let app: ReturnType<typeof createApp> | undefined;
  let ws: NodeWebSocket | undefined;
  try {
    app = createApp({ store, password, origin, staticDir, tickMs: 100, seed: 42, monotonicNow: () => reloj });
    app.server.listen(port, '127.0.0.1');
    await once(app.server, 'listening');
    const guardar = store.save.bind(store);
    store.save = (...args) => { reloj += duracion; return guardar(...args); };

    const disparar = (en: number, dura = 0): number => {
      reloj = en; duracion = dura;
      const cita = citas.shift()!;
      assert.equal(citas.length, 0);
      cita.fn();
      assert.equal(citas.length, 1);
      return citas[0]!.ms;
    };

    // 1) Paso largo (> tickMs): llega tarde y arma cederHasta + limiteCargaHasta.
    const tick0 = app.world.tick;
    assert.equal(disparar(1100, 300), 0);
    assert.equal(app.world.tick, tick0 + 1);

    // 2) El navegador pide GET / -> 200 arma la ventana de gracia breve para los activos siguientes.
    const rHtml = await pedir(port, '/');
    assert.equal(rHtml.status, 200);
    assert.equal(disparar(1400), 1, 'tras servir /, el paso siguiente cede para que lleguen .js, /api/session y /api/world');
    assert.equal(app.world.tick, tick0 + 1, 'ningún paso interrumpe la ráfaga de carga inicial');

    // 3) Pide app.js y /api/session: siguen entrando sin paso en medio.
    const rJs = await pedir(port, '/app.js');
    assert.equal(rJs.status, 200);
    const rSess = await pedir(port, '/api/session');
    assert.equal(rSess.status, 200);
    assert.equal(disparar(1410), 1, 'sigue cediendo dentro de la gracia mientras completa la carga');
    assert.equal(app.world.tick, tick0 + 1);

    // 4) Login 200 + abrir /ws desarma la gracia de carga de inmediato (el siguiente paso ya corre).
    const login = await pedir(port, '/api/login', { Origin: origin, 'Content-Type': 'application/json' }, 'POST');
    assert.equal(login.status, 400); // sin cuerpo: no arma nada; hacemos login real con fetch sobre setTimeout real
    globalThis.setTimeout = setTimeoutReal;
    const loginRes = await fetch(`${origin}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;
    ws = new NodeWebSocket(`${origin.replace('http:', 'ws:')}/ws?ack=1`, { headers: { Origin: origin, Cookie: cookie } });
    await once(ws, 'open');
    // Tras abrir WS, cerramos el cliente para probar que `graciaCargaHasta` ya quedó desarmada (0).
    ws.terminate();
    while (app.flujo.length > 0) await new Promise(r => setImmediate(r));

    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      citas.push({ fn, ms: ms ?? 0 });
      return { unref() { return this; }, ref() { return this; } };
    }) as unknown as typeof setTimeout;
    // Sin clientes ni gracia activa, el siguiente paso ya avanza normalmente.
    assert.equal(disparar(1420, 20), 60, 'desarmada la gracia al abrir /ws, el paso retoma su cadencia');
    assert.equal(app.world.tick, tick0 + 2);
  } finally {
    globalThis.setTimeout = setTimeoutReal;
    ws?.terminate();
    await app?.close();
    store.close();
  }
});
