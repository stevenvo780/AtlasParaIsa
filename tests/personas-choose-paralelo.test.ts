import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { Tile } from '../src/shared/types.js';
import { createWorld, stepWorld, closePersonasParallelPools, closePolicyGpuBatchers, type World } from '../src/world/index.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { paramsOf, parseParams, setParams } from '../src/world/params.js';
import { ResidentTopologyOwner } from '../src/world/soa/topologia.js';
import {
  EstadoPersonasCompartido, PersonasParallelPool, precomputePersonasParallel, precomputeMovesParallel,
  precomputedRouteLookup,
} from '../src/world/paralelo/personas-motor.js';
import { CELDAS_PERCEPCION, LADO_PERCEPCION, MOVE_SIN_EVALUAR, SI } from '../src/world/paralelo/personas-worker.js';

after(async () => {
  closePolicyGpuBatchers();
  await closePersonasParallelPools();
  await closeEcosystemWorkers();
});

type Point = { x: number; y: number };
const key = (p: Point): string => `${p.x},${p.y}`;

/** Referencia independiente: perceivedRoutes original y el disco de nearbyTiles de choose. */
function perceivedRoutes(person: Point, tileIn: (x: number, y: number) => Tile | undefined): Map<string, number> {
  const land = new Set<string>();
  for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
    if (dx * dx + dy * dy > 49) continue;
    const tile = tileIn(person.x + dx, person.y + dy);
    if (tile && tile.terrain !== 'water') land.add(key(tile));
  }
  const steps = new Map([[key(person), 0]]), queue: Point[] = [person];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!, n = steps.get(key(p))! + 1;
    for (const next of [{ x: p.x + 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y - 1 }]) {
      const k = key(next);
      if (land.has(k) && !steps.has(k)) { steps.set(k, n); queue.push(next); }
    }
  }
  return steps;
}

function fixture(count: number, obstacles = true): World {
  const world = createWorld(7), baseTile = world.tiles[0]!, basePerson = world.people[0]!;
  const owner = new ResidentTopologyOwner(), tiles: Tile[] = [];
  for (let y = -64; y < 64; y++) for (let x = -64; x < 64; x++) {
    // Un chunk entero ausente; ríos con pasos, muros y un islote de una sola celda.
    if (obstacles && x >= 0 && x < 16 && y >= 0 && y < 16) continue;
    const island = Math.abs(x + 20) + Math.abs(y + 20) === 1;
    const water = obstacles && (island || x === -12 && y % 11 !== 0 || y === 24 && x % 9 !== 0);
    tiles.push(owner.tile({ ...baseTile, x, y, terrain: water ? 'water' : 'meadow' }));
  }
  world.tiles = owner.tiles(tiles);
  const centers = [{ x: -20, y: -20 }, { x: -19, y: -20 }, { x: 8, y: 8 }, { x: -1, y: -1 },
    { x: -16, y: -16 }, { x: 16, y: 16 }, { x: -63, y: 60 }, { x: 63, y: -63 }];
  world.people = Array.from({ length: count }, (_, i) => ({ ...basePerson, id: `probe-${i}`,
    ...(i < centers.length ? centers[i]! : { x: -55 + i * 17 % 108, y: -55 + i * 31 % 108 }),
    decisionAt: 0, action: 'explore', target: { x: 30, y: 30 } }));
  world.tick = 1; // percepción sin movimiento
  return world;
}

test('choose: 225 Int16 por actor = perceivedRoutes celda a celda (negativos, agua, islote y chunks ausentes)', t => {
  const world = fixture(128), tiles = new Map(world.tiles.map(tile => [key(tile), tile]));
  const refs = world.people.map(p => perceivedRoutes(p, (x, y) => tiles.get(`${x},${y}`)));
  assert.equal(refs[0]!.size, 1, 'el islote queda aislado');
  assert.equal(refs[2]!.size, 1, 'el origen ausente también conserva distancia cero');
  let compared = 0;
  for (const hilos of [1, 2, 4, 8, 28]) for (const orden of ['natural', 'inverso', 'adversarial'] as const) {
    for (const tick of [1, 6]) {
      world.tick = tick;
      const result = precomputePersonasParallel(world, { hilos, orden })!;
      assert.ok(result.rutas?.pasos instanceof Int16Array);
      assert.ok(result.rutas.pasos.buffer instanceof SharedArrayBuffer);
      assert.equal(result.diagnostico.hilos, hilos);
      for (let slot = 0; slot < world.people.length; slot++) {
        const p = world.people[slot]!, lookup = precomputedRouteLookup(p, result, slot)!;
        assert.equal(typeof lookup, 'function');
        for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
          const expected = dx * dx + dy * dy <= 49 ? refs[slot]!.get(`${p.x + dx},${p.y + dy}`) : undefined;
          const actual: number | undefined = result.rutas.pasos[slot * CELDAS_PERCEPCION + (dy + 7) * LADO_PERCEPCION + dx + 7];
          assert.equal(actual, expected ?? -1, `h=${hilos}/${orden} tick=${tick} slot=${slot} offset=${dx},${dy}`);
          assert.equal(lookup({ x: p.x + dx, y: p.y + dy }), expected);
          compared++;
        }
        assert.equal(lookup({ x: p.x + 8, y: p.y }), undefined);
        assert.equal(lookup({ x: p.x + 0.5, y: p.y }), undefined);
        assert.equal(result.si[SI.routeSteps * result.cap + slot], refs[slot]!.size);
        if (tick === 1) assert.equal(result.si[SI.moveStatus * result.cap + slot], MOVE_SIN_EVALUAR);
      }
    }
  }
  t.diagnostic(`${compared} celdas comparadas, 0 diferencias; 1/2/4/8/28 hilos × 3 órdenes × rutas solas/combinadas`);
});

test('choose: umbral, un despacho combinado, filas reutilizadas y fallback por posición o decisión imprevista', () => {
  const world = fixture(32), motor = { hilos: 4, orden: 'inverso' as const };
  const before = precomputePersonasParallel(world, motor)!;
  world.tick = 6;
  const both = precomputePersonasParallel(world, motor)!;
  assert.equal(both.diagnostico.despachos, before.diagnostico.despachos + 1, 'una sola barrera para ambos BFS');
  const p = world.people[0]!, oldX = p.x, oldY = p.y;
  p.x++;
  assert.equal(precomputedRouteLookup(p, both, 0), undefined);
  p.x = oldX; p.y++;
  assert.equal(precomputedRouteLookup(p, both, 0), undefined);
  p.y = oldY;
  assert.equal(typeof precomputedRouteLookup(p, both, 0), 'function');
  assert.equal(precomputedRouteLookup(p, both), undefined);
  assert.equal(precomputedRouteLookup(p, both, -1), undefined);
  assert.equal(precomputedRouteLookup(p, both, both.count), undefined);
  for (const person of world.people) person.decisionAt = 1_000_000;
  const moveOnly = precomputePersonasParallel(world, motor)!;
  assert.equal(precomputedRouteLookup(p, moveOnly, 0), undefined, 'ninguna ruta vieja puede usarse');
  world.tick = 7;
  for (let i = 0; i < 15; i++) world.people[i]!.decisionAt = 0;
  assert.equal(precomputePersonasParallel(world, motor), undefined, '15 decisiones no despachan');
  world.people[15]!.decisionAt = 0;
  const routesOnly = precomputePersonasParallel(world, motor)!;
  assert.equal(precomputedRouteLookup(world.people[16]!, routesOnly, 16), undefined, 'decisión imprevista usa BFS serial');
  assert.equal(typeof precomputedRouteLookup(p, routesOnly, 0), 'function');
  // Las acciones de recurso se anticipan aunque la fuente se agote por un actor anterior.
  for (const person of world.people) { person.decisionAt = 1_000_000; person.action = 'eat'; }
  const depletion = precomputePersonasParallel(world, motor)!;
  assert.ok(world.people.every((person, slot) => !!precomputedRouteLookup(person, depletion, slot)));
  world.people[0]!.x += 0.5;
  const fractional = precomputePersonasParallel(world, motor)!;
  assert.equal(precomputedRouteLookup(world.people[0]!, fractional, 0), undefined);
  assert.equal(precomputedRouteLookup(p, precomputeMovesParallel(world, motor), 0), undefined, 'API previa sigue siendo solo movimiento');
});

const V12 = 'poblacion.natalidadVecindad=true,poblacion.radioVecindadNatalidad=16,social.radioConvivencia=12,social.disolucion=1,social.maxComunidades=0,conducta.aptitud=0.35,conducta.politicaPeso=0.35,tecnologia.evitarNoOp=true,tecnologia.dosisCuanto=50,tecnologia.enfriamiento=240';

/** Solo se normalizan opciones de ejecución; la simulación y el digesto no se alteran. */
function digest(world: World): string {
  const params = paramsOf(world), serial = structuredClone(params);
  Object.assign(serial.motor, { hilos: 1, orden: 'natural', gpu: [], soaTerreno: false, particionarPersonas: false });
  setParams(world, serial);
  try { return digestoCanonico(world); } finally { setParams(world, params); }
}

for (const laws of ['', V12]) for (const seed of [7, 42, 51926]) {
  test(`choose: digesto idéntico durante 600 ticks seed=${seed} ${laws ? 'V12 abierto' : 'V11 defaults'}`, { timeout: 600_000 }, t => {
    const checkpoints: string[] = [];
    const variants = [{ hilos: 1, orden: 'natural', parallel: false },
      ...[1, 2, 4, 8, 28].flatMap(hilos => ['inverso', 'adversarial'].map(orden => ({ hilos, orden, parallel: true })))];
    for (const v of variants) {
      const world = createWorld(seed, parseParams([laws, `motor.hilos=${v.hilos},motor.orden=${v.orden},motor.particionarPersonas=${v.parallel}`].filter(Boolean).join(',')));
      let dispatches = 0, perceptionOnly = 0;
      for (let tick = 1; tick <= 600; tick++) {
        stepWorld(world, [], { personasExecution: { onStep: () => { dispatches++; if (tick % 6 !== 0) perceptionOnly++; } } });
        if (tick % 100 === 0) {
          const d = digest(world), checkpoint = tick / 100 - 1;
          if (!v.parallel) checkpoints.push(d);
          else assert.equal(d, checkpoints[checkpoint], `tick=${tick} hilos=${v.hilos} orden=${v.orden}`);
        }
      }
      if (v.parallel) {
        assert.ok(dispatches >= 100, 'movimiento integrado');
        assert.ok(perceptionOnly > 0, 'percepción integrada también fuera de los ticks de movimiento');
      } else assert.equal(dispatches, 0);
    }
    t.diagnostic(`seed=${seed} ${laws ? 'V12' : 'V11'}: 10 variantes × 6 checkpoints = 60 digestos idénticos; tick600=${checkpoints[5]}`);
  });
}

test('choose: benchmark P=1000/4000, solo percepción, caché caliente y coste completo de empaquetado+barrera', { timeout: 120_000 }, async t => {
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  for (const count of [1000, 4000]) {
    const world = fixture(count, false), mask = new Uint8Array(count).fill(1);
    const state = new EstadoPersonasCompartido(), results: { hilos: number; kernel: number; total: number }[] = [];
    let expected: Int16Array | undefined;
    for (const hilos of [1, 28]) {
      const pool = new PersonasParallelPool({ hilos });
      try {
        const kernels: number[] = [], totals: number[] = [];
        for (let iteration = 0; iteration < 61; iteration++) {
          const start = performance.now();
          state.empaquetarSoloMovimiento(world, { decisiones: mask, movimiento: false });
          const packed = performance.now();
          pool.stepPhaseB(state);
          const end = performance.now();
          if (iteration >= 40) { kernels.push(end - packed); totals.push(end - start); }
        }
        const output = state.vista().rutas.slice(0, count * CELDAS_PERCEPCION);
        if (!expected) expected = output;
        else assert.deepEqual(output, expected, 'misma carga y salida en ambos benchmarks');
        results.push({ hilos, kernel: median(kernels), total: median(totals) });
      } finally { await pool.close(); }
    }
    const serial = results[0]!, parallel = results[1]!;
    t.diagnostic(`P=${count}: 1 hilo kernel=${serial.kernel.toFixed(3)}ms total=${serial.total.toFixed(3)}ms; 28 workers kernel=${parallel.kernel.toFixed(3)}ms total=${parallel.total.toFixed(3)}ms; speedup kernel=${(serial.kernel / parallel.kernel).toFixed(2)}x total=${(serial.total / parallel.total).toFixed(2)}x (medianas de 21, 40 warmups; 0 diferencias)`);
  }
});
