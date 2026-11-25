// T145 + T151 + T153 — Motor paralelo de la fase `personas` (Fase B en workers, Fase C ordenada).
//
// 1. Paridad del kernel con los algoritmos de `src/world/index.ts` (`perceivedRoutes`, BFS de
//    `move`, selección de alimento/agua/materiales y cuerpo basal), sobre el terreno de un mundo
//    real y sobre un mapa con lagos y ríos. Las referencias son copias literales del código real
//    usando sus mismas utilidades (`tileAt`, `primero`, `primeroConFiltroCaro`, `bodilyNeedRates`).
// 2. Paridad bit a bit de todos los buffers de salida, intentos confirmados, stocks finales y
//    agregados entre 1, 2, 4, 8 y 28 hilos, orden adversarial y regiones de 256 y 512.
// 3. Fase C = confirmación serie en orden de personas (lo que hace hoy `bodyAndAction`).
// 4. Benchmark real a P = 4 000 con 1, 8 y 28 workers (tiempo, aceleración, ocupación).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { Tile } from '../src/shared/types.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { bodilyNeedRates, createWorld, stepWorld, type World } from '../src/world/index.js';
import { waterAvailable } from '../src/world/inventions.js';
import { advanceNeeds } from '../src/world/needs.js';
import { primero, primeroConFiltroCaro } from '../src/world/orden.js';
import { tileAt } from '../src/world/spatial.js';
import { generateChunk } from '../src/world/terrain.js';
import { saturateTotal } from '../src/world/statistics.js';
import {
  EstadoPersonasCompartido, PersonasParallelPool, confirmarFaseCPersonas, copiarSalidas, escenaDesdeMundo,
  type EscenaPersonas, type PersonaEntrada, type RegionSidePersonas, type TeselaEntrada,
} from '../src/world/paralelo/personas-motor.js';
import {
  HALLADO_AGUA, HALLADO_COMIDA, HALLADO_RECURSO, MOVE_AVANZA, MOVE_BLOQUEADO, MOVE_EN_DESTINO, MOVE_SIN_EVALUAR,
  NSI, SF, SI, pasoMovimiento, rutasPercibidas,
} from '../src/world/paralelo/personas-worker.js';

after(async () => { await closeEcosystemWorkers(); });

// ── Utilidades deterministas ────────────────────────────────────────────────────────────

function lcg(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** Mapa con lagos circulares y ríos con vados: obstáculos de agua reales para los BFS. */
function mapaSintetico(ancho: number, alto: number, semilla: number, x0 = 0, y0 = 0): TeselaEntrada[] {
  const rnd = lcg(semilla);
  const lagos = Array.from({ length: Math.max(4, Math.floor(ancho * alto / 6000)) }, () =>
    ({ x: x0 + rnd() * ancho, y: y0 + rnd() * alto, r: 2 + rnd() * 9 }));
  const rios = Array.from({ length: Math.max(1, Math.floor(alto / 60)) }, () => ({ y: y0 + Math.floor(rnd() * alto), vado: 7 + Math.floor(rnd() * 25) }));
  const tiles: TeselaEntrada[] = [];
  for (let y = y0; y < y0 + alto; y++) for (let x = x0; x < x0 + ancho; x++) {
    let agua = rios.some(rio => Math.abs(y - rio.y) <= 1 && (x - x0) % rio.vado !== 0);
    if (!agua) for (const lago of lagos) if ((x - lago.x) ** 2 + (y - lago.y) ** 2 <= lago.r * lago.r) { agua = true; break; }
    const r = rnd();
    tiles.push({
      x, y, terrain: agua ? 'water' : r < 0.02 ? 'shelter' : r < 0.5 ? 'soil' : 'meadow',
      biome: rnd() < 0.15 ? 'desert' : 'grassland',
      food: agua ? 0 : rnd() < 0.6 ? rnd() * 0.3 : 0,
      drinkingWater: agua ? 1 : rnd() < 0.05 ? rnd() * 0.05 : 0,
      wood: rnd() < 0.2 ? Math.floor(rnd() * 4) : 0,
      stone: rnd() < 0.15 ? Math.floor(rnd() * 3) : 0,
    });
  }
  return tiles;
}

const ACCIONES_PRUEBA = ['explore', 'eat', 'forage', 'drink', 'gather', 'rest'] as const;

function personaSintetica(rnd: () => number, x: number, y: number, objetivo: { x: number; y: number }, accion?: PersonaEntrada['action']): PersonaEntrada {
  return {
    x, y, targetX: objetivo.x, targetY: objetivo.y,
    hunger: rnd() * 0.95, thirst: rnd() * 0.95, fatigue: rnd() * 0.9, energy: 0.05 + rnd() * 0.95,
    inventory: rnd() * 0.25, wood: Math.floor(rnd() * 13), stone: Math.floor(rnd() * 9),
    traits: { curiosity: rnd(), sociability: rnd(), industriousness: rnd(), care: rnd(), resilience: rnd() },
    heading: rnd() * 6.28, action: accion ?? ACCIONES_PRUEBA[Math.floor(rnd() * ACCIONES_PRUEBA.length)]!,
    needsDecision: rnd() < 0.85, shouldMove: rnd() < 0.85,
    payload: rnd() < 0.2 ? rnd() * 0.5 : 0, foodDemand: 0.85 + rnd() * 0.6, waterDemand: 0.85 + rnd() * 0.6,
    disputa: rnd() < 0.15 ? { x: x + Math.floor(rnd() * 9) - 4, y: y + Math.floor(rnd() * 9) - 4 } : null,
    work: Math.floor(rnd() * 18), workDuration: 1 + Math.floor(rnd() * 18),
  };
}

// ── Referencias: copias literales de `src/world/index.ts` ───────────────────────────────

type Pt = { x: number; y: number };
type Lookup = (p: Pt) => TeselaEntrada | undefined;
const RADIUS = 7;
const distance = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/** `nearbyTiles` de `choose`. */
function nearbyTilesRef(lookup: Lookup, person: Pt): TeselaEntrada[] {
  const nearbyTiles: TeselaEntrada[] = [];
  for (let dy = -RADIUS; dy <= RADIUS; dy++) for (let dx = -RADIUS; dx <= RADIUS; dx++) {
    if (dx * dx + dy * dy > RADIUS * RADIUS) continue;
    const tile = lookup({ x: person.x + dx, y: person.y + dy }); if (tile && tile.terrain !== 'water') nearbyTiles.push(tile);
  }
  return nearbyTiles;
}

/** `perceivedRoutes` literal. */
function perceivedRoutesRef(person: Pt, tiles: TeselaEntrada[]): Map<string, number> {
  const land = new Set(tiles.map(t => `${t.x},${t.y}`)), steps = new Map([[`${person.x},${person.y}`, 0]]), queue: Pt[] = [person];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!, n = steps.get(`${p.x},${p.y}`)! + 1;
    for (const next of [{ x: p.x + 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y - 1 }]) {
      const key = `${next.x},${next.y}`;
      if (land.has(key) && !steps.has(key)) { steps.set(key, n); queue.push(next); }
    }
  }
  return steps;
}

/** BFS de `move` literal; devuelve el estado y el paso que tomaría. */
function moveRef(lookup: Lookup, person: Pt & { target: Pt }): { estado: number; x: number; y: number } {
  const walkable = (p: Pt): boolean => { const tile = lookup(p); return !!tile && tile.terrain !== 'water'; };
  if (distance(person, person.target) < 0.5) return { estado: MOVE_EN_DESTINO, x: person.x, y: person.y };
  const key = (p: Pt) => `${p.x},${p.y}`;
  const start = { x: person.x, y: person.y };
  const queue: Pt[] = [start], previous = new Map<string, Pt | null>([[key(start), null]]);
  let best = start, head = 0;
  while (head < queue.length && head < 2048) {
    const current = queue[head++]!;
    if (distance(current, person.target) < distance(best, person.target)) best = current;
    if (distance(current, person.target) < 0.5) { best = current; break; }
    for (const next of [{ x: current.x + 1, y: current.y }, { x: current.x, y: current.y + 1 }, { x: current.x - 1, y: current.y }, { x: current.x, y: current.y - 1 }]) {
      if (Math.max(Math.abs(next.x - start.x), Math.abs(next.y - start.y)) > 24 || !walkable(next) || previous.has(key(next))) continue;
      previous.set(key(next), current); queue.push(next);
    }
  }
  if (best === start) return { estado: MOVE_BLOQUEADO, x: start.x, y: start.y };
  while (previous.get(key(best)) !== start) best = previous.get(key(best))!;
  return { estado: MOVE_AVANZA, x: best.x, y: best.y };
}

interface Referencia {
  routes: Map<string, number>; food?: TeselaEntrada; water?: TeselaEntrada; resource?: TeselaEntrada;
  body: { hunger: number; thirst: number; fatigue: number; energy: number };
}

/** Cuerpo basal + selección de `choose` (alimento, agua, materiales), literal. */
function seleccionRef(lookup: Lookup, aguaDe: (t: TeselaEntrada) => number, p: PersonaEntrada, escena: EscenaPersonas): Referencia {
  const body = { hunger: p.hunger, thirst: p.thirst, fatigue: p.fatigue, energy: p.energy };
  const tile = lookup(p);
  if (tile) advanceNeeds(body, bodilyNeedRates({ weather: escena.lluvia ? 'rain' : 'clear' } as World, tile as Tile,
    { foodDemand: p.foodDemand ?? 1, waterDemand: p.waterDemand ?? 1 } as Parameters<typeof bodilyNeedRates>[2]));
  const person = { ...p, ...body, materials: { wood: p.wood, stone: p.stone } };
  const nearbyTiles = nearbyTilesRef(lookup, p);
  const routes = perceivedRoutesRef(p, nearbyTiles), stepsTo = (point: Pt) => routes.get(`${point.x},${point.y}`);
  const reachableTiles = nearbyTiles.filter(t => stepsTo(t) !== undefined), payload = p.payload ?? 0;
  const planAffordable = (steps: number, work: number) => person.energy >= steps * (.0008 + payload * .0008) + work * .0003
    && person.fatigue + steps * (.0007 * (1.2 - person.traits.resilience * .4) + payload * .0007) + work * .00025 * (1.2 - person.traits.resilience * .4) < 1;
  const memoriaDisputa = escena.memoriaDisputa ?? 0, disputaDestino = escena.disputaDestino ?? 0;
  const disputada = memoriaDisputa > 0 ? p.disputa ?? undefined : undefined;
  const recelo = (tile: Pt) => disputada && distance(tile, disputada) < disputaDestino ? memoriaDisputa : 0;
  const food = primero(reachableTiles, disputada
    ? (a, b) => (distance(person, a) - a.food * 2 + recelo(a)) - (distance(person, b) - b.food * 2 + recelo(b))
    : (a, b) => (distance(person, a) - a.food * 2) - (distance(person, b) - b.food * 2), tile => tile.food > 0.025 && planAffordable(stepsTo(tile)!, 0));
  const water = primeroConFiltroCaro(reachableTiles, disputada
    ? (a, b) => (distance(person, a) + recelo(a)) - (distance(person, b) + recelo(b))
    : (a, b) => distance(person, a) - distance(person, b), t => aguaDe(t) > 0.005 && planAffordable(stepsTo(t)!, 0));
  const resourceDistance = (t: TeselaEntrada): number => {
    const useful = person.materials.wood < 6 ? (t.wood ?? 0) >= 1 : (t.stone ?? 0) >= 1;
    return distance(person, t) + (useful ? 0 : 20);
  };
  const resource = primero(nearbyTiles, (a, b) => resourceDistance(a) - resourceDistance(b),
    t => ((t.wood ?? 0) >= 1 && person.materials.wood < 12) || ((t.stone ?? 0) >= 1 && person.materials.stone < 8));
  return { routes, food, water, resource, body };
}

const ordenar = (rutas: Map<string, number>): [string, number][] => [...rutas.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

function compararConReferencia(escena: EscenaPersonas, lookup: Lookup, aguaDe: (t: TeselaEntrada) => number, etiqueta: string): { movidos: number; bloqueados: number; rutas: number } {
  const estado = new EstadoPersonasCompartido();
  estado.empaquetar(escena);
  const pool = new PersonasParallelPool({ hilos: 1 });
  pool.stepPhaseB(estado);
  const vista = estado.vista(), cap = vista.params.capPersonas;
  const s = (campo: number, slot: number) => vista.si[campo * cap + slot]!;
  const f = (campo: number, slot: number) => vista.sf[campo * cap + slot]!;
  let movidos = 0, bloqueados = 0, rutas = 0;
  escena.personas.forEach((p, slot) => {
    const ctx = `${etiqueta} slot ${slot} (${p.x},${p.y})→(${p.targetX},${p.targetY})`;
    const ref = seleccionRef(lookup, aguaDe, p, escena);
    assert.deepEqual([f(SF.bodyHunger, slot), f(SF.bodyThirst, slot), f(SF.bodyFatigue, slot), f(SF.bodyEnergy, slot)],
      [ref.body.hunger, ref.body.thirst, ref.body.fatigue, ref.body.energy], `${ctx}: cuerpo basal`);
    // El mapa completo de rutas percibidas, celda a celda.
    assert.deepEqual(ordenar(rutasPercibidas(vista, p.x, p.y)), ordenar(ref.routes), `${ctx}: perceivedRoutes`);
    rutas += ref.routes.size;
    if (p.needsDecision) {
      assert.equal(s(SI.routeSteps, slot), ref.routes.size, `${ctx}: tamaño de rutas`);
      const found = s(SI.found, slot);
      for (const [obj, bandera, cx, cy, nombre] of [
        [ref.food, HALLADO_COMIDA, SI.bestFoodX, SI.bestFoodY, 'alimento'],
        [ref.water, HALLADO_AGUA, SI.bestWaterX, SI.bestWaterY, 'agua'],
        [ref.resource, HALLADO_RECURSO, SI.bestResourceX, SI.bestResourceY, 'materiales'],
      ] as const) {
        assert.equal(!!(found & bandera), !!obj, `${ctx}: ${nombre} hallado`);
        if (obj) assert.deepEqual([s(cx, slot), s(cy, slot)], [obj.x, obj.y], `${ctx}: celda de ${nombre}`);
      }
      assert.equal(s(SI.stepsFood, slot), ref.food ? ref.routes.get(`${ref.food.x},${ref.food.y}`) : -1, `${ctx}: pasos a alimento`);
      assert.equal(s(SI.stepsWater, slot), ref.water ? ref.routes.get(`${ref.water.x},${ref.water.y}`) : -1, `${ctx}: pasos a agua`);
    } else assert.equal(s(SI.routeSteps, slot), 0);
    // El paso de `move`, siempre (también cuando el actor no se mueve este paso).
    const mov = moveRef(lookup, { x: p.x, y: p.y, target: { x: p.targetX, y: p.targetY } });
    assert.deepEqual({ ...pasoMovimiento(vista, p.x, p.y, p.targetX, p.targetY, { estado: 0, x: 0, y: 0 }) }, mov, `${ctx}: move`);
    if (p.shouldMove) {
      assert.deepEqual([s(SI.moveStatus, slot), s(SI.nextX, slot), s(SI.nextY, slot)], [mov.estado, mov.x, mov.y], `${ctx}: salida de move`);
      if (mov.estado === MOVE_AVANZA) movidos++;
      if (mov.estado === MOVE_BLOQUEADO) bloqueados++;
    } else assert.deepEqual([s(SI.moveStatus, slot), s(SI.nextX, slot), s(SI.nextY, slot)], [MOVE_SIN_EVALUAR, p.x, p.y]);
  });
  void pool.close();
  return { movidos, bloqueados, rutas };
}

// ── 1. Paridad con `index.ts` ───────────────────────────────────────────────────────────

test('T145: perceivedRoutes, move y selección = index.ts sobre un mundo real con orillas de agua', () => {
  const world = createWorld(7);
  for (let paso = 0; paso < 12; paso++) stepWorld(world);
  // Los chunks iniciales de la semilla 7 no tienen agua: se cargan más chunks del generador real
  // (lagos y orillas auténticos) en el propio mundo, como haría `maintainRegions` al explorar.
  for (let cy = -5; cy < 5; cy++) for (let cx = -5; cx < 5; cx++) {
    const chunk = generateChunk(world.seed, cx, cy);
    if (!world.chunks[chunk.key]) world.tiles.push(...chunk.tiles);
  }
  const base = escenaDesdeMundo(world);
  const lookup: Lookup = p => tileAt(world, p);
  const agua = world.tiles.filter(t => t.terrain === 'water');
  assert.ok(agua.length > 0, 'el mundo real debe tener agua para probar obstáculos');
  // Sondas en tierra a ≤ 3 celdas de agua, con objetivos cercanos, lejanos (> 24) y sobre agua.
  const orilla = world.tiles.filter(t => t.terrain !== 'water'
    && agua.some(w => Math.abs(w.x - t.x) <= 3 && Math.abs(w.y - t.y) <= 3)).filter((_, i) => i % 7 === 0).slice(0, 400);
  assert.ok(orilla.length >= 50, `sondas de orilla: ${orilla.length}`);
  const rnd = lcg(91);
  const personas = [...base.personas, ...orilla.map(t => {
    const lejos = rnd() < 0.3, objetivo = lejos ? { x: t.x + Math.floor(rnd() * 80) - 40, y: t.y + Math.floor(rnd() * 80) - 40 }
      : rnd() < 0.2 ? agua[Math.floor(rnd() * agua.length)]! : { x: t.x + Math.floor(rnd() * 15) - 7, y: t.y + Math.floor(rnd() * 15) - 7 };
    return { ...personaSintetica(rnd, t.x, t.y, objetivo), needsDecision: true, shouldMove: rnd() < 0.9 };
  })];
  const escena: EscenaPersonas = { ...base, personas, memoriaDisputa: 3, disputaDestino: 2 };
  const r = compararConReferencia(escena, lookup, t => waterAvailable(world, t as Tile), 'mundo 7');
  assert.ok(r.movidos > 50, `pasos reales de move comparados: ${r.movidos}`);
});

test('T145: paridad con index.ts en un mapa con lagos y ríos (bloqueos, cotas 2048/24, recelo CONFL)', () => {
  const tiles = mapaSintetico(160, 120, 5, -40, -30);
  const indice = new Map(tiles.map(t => [`${t.x},${t.y}`, t]));
  const lookup: Lookup = p => indice.get(`${p.x},${p.y}`);
  const tierra = tiles.filter(t => t.terrain !== 'water');
  const rnd = lcg(17);
  const personas: PersonaEntrada[] = [];
  for (let i = 0; i < 700; i++) {
    const t = tierra[Math.floor(rnd() * tierra.length)]!;
    const r = rnd();
    const objetivo = r < 0.3 ? { x: t.x + Math.floor(rnd() * 100) - 50, y: t.y + Math.floor(rnd() * 100) - 50 }
      : r < 0.4 ? { x: t.x, y: t.y } : { x: t.x + Math.floor(rnd() * 21) - 10, y: t.y + Math.floor(rnd() * 21) - 10 };
    personas.push({ ...personaSintetica(rnd, t.x, t.y, objetivo), shouldMove: true });
  }
  // Islotes: personas encerradas por agua (move bloqueado, rutas de una sola celda).
  const islote = tiles.find(t => t.terrain !== 'water' && [[1, 0], [0, 1], [-1, 0], [0, -1]]
    .every(([dx, dy]) => lookup({ x: t.x + dx!, y: t.y + dy! })?.terrain === 'water'));
  if (islote) personas.push({ ...personaSintetica(rnd, islote.x, islote.y, { x: islote.x + 9, y: islote.y }), needsDecision: true, shouldMove: true });
  const escena: EscenaPersonas = { tiles, personas, lluvia: true, memoriaDisputa: 4, disputaDestino: 3 };
  const r = compararConReferencia(escena, lookup, t => t.drinkingWater ?? 0, 'sintético');
  assert.ok(r.movidos > 300 && r.bloqueados >= 0, `move: ${r.movidos} avances, ${r.bloqueados} bloqueos`);
});

// ── 2. Paridad bit a bit entre hilos, órdenes y geometrías ──────────────────────────────

/** Escena con varias regiones de 256 y 512 y competencia por las mismas celdas. */
function escenaCompetida(personasPorGrupo: number, grupos: number, semilla: number): EscenaPersonas {
  const tiles = mapaSintetico(1100, 140, semilla, -30, -20);
  const tierra = tiles.filter(t => t.terrain !== 'water');
  const rnd = lcg(semilla * 31 + 7);
  const personas: PersonaEntrada[] = [];
  for (let g = 0; g < grupos; g++) {
    const t = tierra[Math.floor(rnd() * tierra.length)]!;
    // Stocks escasos para que la Fase C tenga que denegar.
    t.food = 0.004 + rnd() * 0.05; t.drinkingWater = 0.003 + rnd() * 0.01; t.wood = 1 + Math.floor(rnd() * 2); t.stone = 1;
    for (let i = 0; i < personasPorGrupo; i++) {
      const accion = (['eat', 'forage', 'drink', 'gather'] as const)[(g + i) % 4]!;
      const p = personaSintetica(rnd, t.x, t.y, { x: t.x, y: t.y }, accion);
      personas.push({ ...p, thirst: Math.max(p.thirst, 0.3), inventory: Math.min(p.inventory, 0.2), workDuration: (p.work ?? 0) + 1,
        wood: Math.min(p.wood, 10), stone: Math.min(p.stone, 6) });
    }
  }
  // Viajeros dispersos con objetivos lejanos (BFS largos), mezclados en el orden de slots.
  for (let i = 0; i < grupos * personasPorGrupo; i++) {
    const t = tierra[Math.floor(rnd() * tierra.length)]!;
    const p = personaSintetica(rnd, t.x, t.y, { x: t.x + Math.floor(rnd() * 70) - 35, y: t.y + Math.floor(rnd() * 70) - 35 });
    personas.splice(Math.floor(rnd() * (personas.length + 1)), 0, p);
  }
  return { tiles, personas, lluvia: false, memoriaDisputa: 2, disputaDestino: 2 };
}

function huella(estado: EstadoPersonasCompartido) {
  const faseC = confirmarFaseCPersonas(estado);
  return {
    salidas: copiarSalidas(estado),
    intentos: faseC.confirmacion.ordenados.map(i => ({ ...i })),
    resultados: faseC.confirmacion.resultados.map(r => ({ actorSlot: r.intent.actorSlot, recursoId: r.intent.recursoId, concedido: r.concedido, denegado: r.denegado, duplicado: r.duplicado })),
    concedido: Array.from(faseC.concedido),
    stocks: faseC.stocksFinales,
    agregados: structuredClone(faseC.libros),
  };
}

test('T145/T153: salidas, intentos, stocks y agregados idénticos con 1/2/4/8/28 hilos, adversarial, regiones 256 y 512', async () => {
  const escena = escenaCompetida(6, 90, 23);
  const estado = new EstadoPersonasCompartido();
  const reasignacionesTrasPrimero: number[] = [];
  const huellas: { etiqueta: string; valor: ReturnType<typeof huella> }[] = [];
  const base = (() => {
    estado.empaquetar(escena, { regionSide: 256 });
    const uno = new PersonasParallelPool({ hilos: 1 });
    uno.stepPhaseB(estado);
    void uno.close();
    return huella(estado);
  })();
  reasignacionesTrasPrimero.push(estado.reasignaciones);
  // Competencia real: hay intentos denegados total o parcialmente y celdas con varios actores.
  assert.ok(base.intentos.length > 200, `intentos: ${base.intentos.length}`);
  assert.ok(base.resultados.some(r => r.denegado > 0), 'la Fase C debe denegar algo');
  assert.ok(base.stocks.some(([, v]) => v === 0), 'algún recurso se agota');
  const celdas = new Map<string, number>();
  for (const i of base.intentos) celdas.set(i.recursoId, (celdas.get(i.recursoId) ?? 0) + 1);
  assert.ok([...celdas.values()].some(n => n >= 3), 'varios actores compiten por la misma celda');

  for (const hilos of [1, 2, 4, 8, 28]) {
    for (const orden of ['adversarial', 'inverso'] as const) {
      if (orden === 'inverso' && hilos !== 4) continue;
      const pool = new PersonasParallelPool({ hilos, orden, retardoMs: orden === 'adversarial' ? 0.25 : 0 });
      try {
        for (const regionSide of [256, 512] as RegionSidePersonas[]) {
          estado.empaquetar(escena, { regionSide });
          // Ensuciar la salida: si un worker no escribiera su fila, la huella cambiaría.
          new Int32Array(estado.buffers.salidaI32).fill(-7); new Float64Array(estado.buffers.salidaF64).fill(Number.NaN);
          pool.stepPhaseB(estado);
          const etiqueta = `hilos=${hilos} orden=${orden} region=${regionSide}`;
          assert.ok(estado.regionesMorton >= (regionSide === 256 ? 4 : 2), `${etiqueta}: regiones Morton ${estado.regionesMorton}`);
          const valor = huella(estado);
          assert.deepStrictEqual(valor, base, `${etiqueta}: huella distinta de 1 hilo natural`);
          huellas.push({ etiqueta, valor });
          const d = pool.diagnostics();
          assert.equal(d.hilos, hilos);
          assert.ok(d.ocupacionWorkers >= 0 && d.ocupacionWorkers <= 1, `${etiqueta}: ocupación ${d.ocupacionWorkers}`);
          if (hilos > 1) {
            assert.ok(d.piscina, `${etiqueta}: diagnóstico de la piscina`);
            assert.ok(d.piscina.completedJobs.every(n => n === d.despachos), `${etiqueta}: workers persistentes, un trabajo por despacho`);
          }
        }
      } finally { await pool.close(); }
    }
  }
  assert.equal(estado.reasignaciones, reasignacionesTrasPrimero[0], 'los SAB se reutilizan entre pasos (sin reasignar)');
  assert.ok(huellas.length >= 10);
});

// ── 3. Fase C = confirmación serie en orden de personas ─────────────────────────────────

test('T145/T153: la Fase C reproduce bit a bit la confirmación serie de bodyAndAction', () => {
  const escena = escenaCompetida(5, 60, 41);
  const estado = new EstadoPersonasCompartido();
  estado.empaquetar(escena, { regionSide: 512 });
  const pool = new PersonasParallelPool({ hilos: 1, orden: 'adversarial' });
  pool.stepPhaseB(estado);
  void pool.close();
  const vista = estado.vista(), cap = vista.params.capPersonas;
  // Serie: personas en orden de `world.people`, cada una debita min(cantidad, stock) de su celda.
  const stock = new Map<string, number>(), totals: Record<string, number> = {};
  const indice = new Map(escena.tiles.map(t => [`${t.x},${t.y}`, t]));
  const concedidoSerie: number[] = [];
  const nombres: Record<number, [string, keyof TeselaEntrada, string]> = {
    1: ['comida', 'food', 'foodHarvested'], 2: ['comida', 'food', 'foodHarvested'], 3: ['agua', 'drinkingWater', 'waterConsumed'],
    4: ['madera', 'wood', 'woodGathered'], 5: ['piedra', 'stone', 'stoneGathered'],
  };
  for (let slot = 0; slot < estado.personas; slot++) {
    const kind = vista.si[SI.intentKind * cap + slot]!;
    if (!kind) { concedidoSerie.push(0); continue; }
    const x = vista.si[SI.intentCellX * cap + slot]!, y = vista.si[SI.intentCellY * cap + slot]!;
    const [prefijo, campo, total] = nombres[kind]!, id = `${prefijo}:${x},${y}`;
    const actual = stock.has(id) ? stock.get(id)! : (indice.get(`${x},${y}`)![campo] as number | undefined) ?? 0;
    const concedido = Math.min(vista.sf[SF.intentAmount * cap + slot]!, actual);
    stock.set(id, actual - concedido === 0 ? 0 : actual - concedido);
    if (concedido > 0) totals[total] = saturateTotal(totals[total], concedido);
    concedidoSerie.push(concedido);
  }
  const faseC = confirmarFaseCPersonas(estado, { aplicarStocks: true });
  assert.deepStrictEqual(Array.from(faseC.concedido), concedidoSerie);
  assert.deepStrictEqual(faseC.stocksFinales, [...stock.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  for (const clave of ['foodHarvested', 'waterConsumed', 'woodGathered', 'stoneGathered']) {
    assert.equal(faseC.libros.totals[clave], totals[clave] ?? 0, `total ${clave}`);
  }
  assert.ok(faseC.stocksFinales.every(([, v]) => v >= 0), 'ningún stock baja de 0');
  // `aplicarStocks` deja el terreno empaquetado listo para el siguiente paso.
  const otra = confirmarFaseCPersonas(estado);
  for (const [id, v] of otra.confirmacion.stocksFinales) assert.ok(v <= (stock.get(id) ?? Infinity));
});

// ── 4. Benchmark real a P = 4 000 ──────────────────────────────────────────────────────

test('T151: benchmark P = 4 000 con 1, 8 y 28 workers (tiempo, aceleración, ocupación) con salida idéntica', async t => {
  const tiles = mapaSintetico(640, 640, 77);
  const tierra = tiles.filter(tile => tile.terrain !== 'water');
  const rnd = lcg(4000);
  const personas: PersonaEntrada[] = Array.from({ length: 4000 }, () => {
    const tile = tierra[Math.floor(rnd() * tierra.length)]!;
    // Objetivos de 10–40 celdas: el BFS de move llega a su cota en la mayoría de actores.
    const objetivo = { x: tile.x + Math.floor(rnd() * 80) - 40, y: tile.y + Math.floor(rnd() * 80) - 40 };
    return { ...personaSintetica(rnd, tile.x, tile.y, objetivo), needsDecision: true, shouldMove: true };
  });
  const escena: EscenaPersonas = { tiles, personas, lluvia: false };
  const estado = new EstadoPersonasCompartido();
  const inicioEmpaquetado = performance.now();
  estado.empaquetar(escena, { regionSide: 256 });
  const empaquetadoMs = performance.now() - inicioEmpaquetado;
  // Régimen estacionario: los workers necesitan varios despachos para que el JIT compile el kernel.
  const calentar = 8, repetir = 9;
  const resultados: { hilos: number; medianaMs: number; ocupacion: number; barreraMs: number; salidas: Record<string, number[]> }[] = [];
  for (const hilos of [1, 8, 28]) {
    const pool = new PersonasParallelPool({ hilos, reloj: () => performance.now() });
    try {
      for (let i = 0; i < calentar; i++) pool.stepPhaseB(estado);
      const tiempos: number[] = [], ocupaciones: number[] = [], barreras: number[] = [];
      for (let i = 0; i < repetir; i++) {
        const inicio = performance.now();
        pool.stepPhaseB(estado);
        tiempos.push(performance.now() - inicio);
        const d = pool.diagnostics();
        ocupaciones.push(d.ocupacionWorkers); barreras.push(d.tiempoBarreraMs);
      }
      const mediana = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      resultados.push({ hilos, medianaMs: mediana(tiempos), ocupacion: mediana(ocupaciones), barreraMs: mediana(barreras), salidas: copiarSalidas(estado) });
    } finally { await pool.close(); }
  }
  const serie = resultados[0]!;
  for (const r of resultados) {
    assert.deepStrictEqual(r.salidas, serie.salidas, `P=4000: salida con ${r.hilos} hilos idéntica a 1 hilo`);
    assert.ok(r.ocupacion >= 0 && r.ocupacion <= 1);
    const linea = `P=4000 hilos=${r.hilos}: ${r.medianaMs.toFixed(2)} ms/paso (mediana de ${repetir}), aceleración ${(serie.medianaMs / r.medianaMs).toFixed(2)}×, `
      + `ocupación ${(r.ocupacion * 100).toFixed(1)} %, barrera ${r.barreraMs.toFixed(2)} ms`;
    t.diagnostic(linea);
    console.log(linea);
  }
  const avances = serie.salidas.moveStatus!.filter(e => e === MOVE_AVANZA).length;
  const linea = `P=4000: empaquetado ${empaquetadoMs.toFixed(1)} ms (${tiles.length} teselas, ${estado.paginas} páginas, ${estado.regiones.length} bloques, `
    + `${estado.regionesMorton} regiones Morton); ${avances} pasos de move; columnas de salida ${NSI}+${Object.keys(SF).length}`;
  t.diagnostic(linea);
  console.log(linea);
});
