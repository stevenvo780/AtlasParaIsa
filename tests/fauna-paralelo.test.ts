// Motor paralelo de la decisión de fauna (`choose` de animals.ts) sobre SharedArrayBuffer.
//
// El oráculo es el `choose` REAL, sin copias del algoritmo: se ejecuta `stepAnimals` sobre una copia
// del mundo con dos ganchos de solo observación.
//  · `world.animals` como accessor: la primera reasignación dentro de `stepAnimals` (línea del
//    `filter` de vivos) ocurre después de la fisiología y de llenar `state.occupants`/`counts`, y antes
//    del primer `choose`: ahí se fotografía el estado de entrada (teselas, animales, lista `due`).
//  · `lastDecision` de cada animal debido como accessor: `choose` lo escribe el último (= tick); en
//    ese instante el animal tiene ya `memory`, `work`, `action`, `target`, `reason` y `preyId` de su
//    `choose` y nada posterior (los `move` van después de todas las decisiones).
// Sobre la fotografía se reconstruye `state` como lo hace `stepAnimals` y se comparan con
// `deepStrictEqual` (distingue −0, NaN y el orden de la memoria) las escrituras de
// `stepChooseParallel` + `applyFaunaChooseOutputs` con 1, 2, 4, 8 y 28 hilos y órdenes
// natural / inverso / adversarial.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { Tile } from '../src/shared/types.js';
import type { AnimalSpecies } from '../src/shared/life.js';
import {
  MAX_ANIMAL_DECISIONS_PER_TICK, MAX_ANIMAL_MEMORY, MAX_ANIMALS_PER_TILE, mascaraFauna, materializeAnimals, stepAnimals, syncFauna,
  type Animal, type AnimalWorld,
} from '../src/world/animals.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { createWorld, stepWorld } from '../src/world/index.js';
import { MAX_COORDINATE } from '../src/world/terrain.js';
import { tileLookup } from '../src/world/tile-index.js';
import {
  EstadoFaunaCompartido, FaunaParallelPool, applyFaunaChooseOutputs, closeFaunaParallelPools, stepChooseParallel,
  type EstadoLocalFauna, type MundoFauna,
} from '../src/world/paralelo/fauna-motor.js';
import { ESPECIES as ESPECIES_FAUNA, MAX_ANIMALES_POR_CELDA, MAX_MEMORIA_ANIMAL, NSO, codigoEspecie } from '../src/world/paralelo/fauna-worker.js';

after(async () => { await closeFaunaParallelPools(); await closeEcosystemWorkers(); });

// ── Utilidades deterministas ────────────────────────────────────────────────────────────

function lcg(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** Copia profunda que atraviesa Proxies y accessors (lee por [[Get]]) y conserva −0, NaN y `undefined`. */
function clonar<T>(valor: T): T {
  if (Array.isArray(valor)) return valor.map(v => clonar(v)) as T;
  if (valor && typeof valor === 'object') {
    const copia: Record<string, unknown> = {};
    for (const clave of Object.keys(valor)) copia[clave] = clonar((valor as Record<string, unknown>)[clave]);
    return copia as T;
  }
  return valor;
}

const canonical = (a: { id: string }, b: { id: string }): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const cellXY = (x: number, y: number): number | string => Number.isInteger(x) && Number.isInteger(y) && x >= -MAX_COORDINATE && x < MAX_COORDINATE
  && y >= -MAX_COORDINATE && y < MAX_COORDINATE ? (x + MAX_COORDINATE) * 2 * MAX_COORDINATE + (y + MAX_COORDINATE) : `${x},${y}`;

/** `state` de `stepAnimals` tras su primer bucle (los animales ya filtrados a vivos, en su orden). */
function estadoLocal(world: MundoFauna): EstadoLocalFauna {
  const occupants = new Map<number | string, Animal[]>(), counts = new Map<number | string, number>();
  for (const animal of world.animals) {
    if (animal.health <= 0) continue;
    const p = cellXY(animal.x, animal.y), here = occupants.get(p);
    if (here) here.push(animal); else occupants.set(p, [animal]);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return { tile: tileLookup(world.tiles), occupants, counts };
}

interface Decision {
  action: Animal['action']; target: { x: number; y: number }; reason: string; preyId: string | null;
  work: number; lastDecision: number; memory: Animal['memory'];
}
const decisionDe = (a: Animal): Decision => clonar({ action: a.action, target: a.target, reason: a.reason, preyId: a.preyId,
  work: a.work, lastDecision: a.lastDecision, memory: a.memory });

interface Captura {
  seed: number; tick: number; tiles: Tile[]; animals: Animal[]; dueIds: string[];
  oraculo: Map<string, Decision>;
}

/** Ejecuta el `stepAnimals` real sobre una copia de `origen` y captura entrada y salida de cada `choose`.
 * `tick` es el de la fase de fauna: `stepWorld` incrementa el tick antes de ella, así que para un mundo
 * vivo entre pasos es `world.tick + 1`. */
function capturar(origen: AnimalWorld, tick = origen.tick): Captura {
  const copia: AnimalWorld = {
    seed: origen.seed, tick, tiles: clonar(origen.tiles), animals: clonar(origen.animals),
    animalCounter: origen.animalCounter, animalDynamics: clonar(origen.animalDynamics), reproductionEnabled: origen.reproductionEnabled,
  };
  const mascara = mascaraFauna(copia);
  let actual = copia.animals, entrada: Omit<Captura, 'oraculo' | 'seed' | 'tick'> | null = null;
  const oraculo = new Map<string, Decision>();
  Object.defineProperty(copia, 'animals', {
    configurable: true, enumerable: true, get: () => actual,
    set: (v: Animal[]) => {
      actual = v;
      if (entrada) return;
      // Primera reasignación: fisiología y ocupación hechas, ningún `choose` todavía.
      const due = mascara.seleccion.filter(a => a.health > 0).filter(a => copia.tick - a.lastDecision >= 8)
        .sort((a, b) => a.lastDecision - b.lastDecision || canonical(a, b)).slice(0, MAX_ANIMAL_DECISIONS_PER_TICK);
      entrada = { tiles: clonar(copia.tiles), animals: clonar(v), dueIds: due.map(a => a.id) };
      for (const animal of due) {
        let valor = animal.lastDecision;
        Object.defineProperty(animal, 'lastDecision', {
          configurable: true, enumerable: true, get: () => valor,
          set: (n: number) => { valor = n; if (n === copia.tick && !oraculo.has(animal.id)) oraculo.set(animal.id, decisionDe(animal)); },
        });
      }
    },
  });
  stepAnimals(copia, undefined, mascara);
  assert.ok(entrada, 'stepAnimals reasigna world.animals antes de decidir');
  const e = entrada as Omit<Captura, 'oraculo' | 'seed' | 'tick'>;
  assert.equal(oraculo.size, e.dueIds.length, 'cada animal debido decidió exactamente una vez');
  return { seed: copia.seed, tick: copia.tick, ...e, oraculo };
}

/** Duración (ms) del bucle `for (const animal of due) choose(…)` real de `stepAnimals` sobre una copia:
 * desde la reasignación previa a las decisiones hasta la escritura de `lastDecision` del último debido. */
function medirChooseReal(origen: AnimalWorld): { ms: number; decisiones: number } {
  const copia: AnimalWorld = { ...origen, tiles: clonar(origen.tiles), animals: clonar(origen.animals), animalDynamics: clonar(origen.animalDynamics) };
  const mascara = mascaraFauna(copia);
  let actual = copia.animals, inicio = -1, fin = -1, decisiones = 0;
  Object.defineProperty(copia, 'animals', {
    configurable: true, enumerable: true, get: () => actual,
    set: (v: Animal[]) => {
      actual = v;
      if (inicio >= 0) return;
      const due = mascara.seleccion.filter(a => a.health > 0).filter(a => copia.tick - a.lastDecision >= 8)
        .sort((a, b) => a.lastDecision - b.lastDecision || canonical(a, b)).slice(0, MAX_ANIMAL_DECISIONS_PER_TICK);
      for (const animal of due) {
        let valor = animal.lastDecision;
        Object.defineProperty(animal, 'lastDecision', { configurable: true, enumerable: true, get: () => valor,
          set: (n: number) => { valor = n; if (n === copia.tick) { fin = performance.now(); decisiones++; } } });
      }
      inicio = performance.now();
    },
  });
  stepAnimals(copia, undefined, mascara);
  return { ms: fin - inicio, decisiones };
}

interface Cobertura {
  decisiones: number; acciones: Map<string, number>; especies: Map<string, number>; especieAccion: Set<string>;
  negativas: number; desierto: number; oceano: number; desalojos: number; trabajoReiniciado: number;
  destinoRecuerdo: number; destinoPresa: number; sinCrecimiento: number;
}
const coberturaVacia = (): Cobertura => ({ decisiones: 0, acciones: new Map(), especies: new Map(), especieAccion: new Set(),
  negativas: 0, desierto: 0, oceano: 0, desalojos: 0, trabajoReiniciado: 0, destinoRecuerdo: 0, destinoPresa: 0, sinCrecimiento: 0 });
const sumar = (m: Map<string, number>, k: string): void => { m.set(k, (m.get(k) ?? 0) + 1); };

/** Compara el motor con el oráculo para cada configuración; devuelve la cobertura de la captura. */
function verificar(c: Captura, configuraciones: readonly (readonly [number, 'natural' | 'inverso' | 'adversarial'])[], cobertura?: Cobertura): void {
  for (const [hilos, orden] of configuraciones) {
    const w: MundoFauna = { seed: c.seed, tick: c.tick, tiles: clonar(c.tiles), animals: clonar(c.animals) };
    const porId = new Map(w.animals.map(a => [a.id, a]));
    const due = c.dueIds.map(id => porId.get(id)!);
    const antes = clonar(w.animals);
    const salidas = stepChooseParallel(w, due, estadoLocal(w), hilos, orden);
    assert.deepStrictEqual(w.animals, antes, 'stepChooseParallel no escribe en ningún animal');
    applyFaunaChooseOutputs(due, w, salidas);
    for (const animal of due) {
      assert.deepStrictEqual(decisionDe(animal), c.oraculo.get(animal.id), `tick ${c.tick} hilos=${hilos} orden=${orden}: ${animal.id}`);
    }
  }
  if (!cobertura) return;
  const teselas = tileLookup(c.tiles), previos = new Map(c.animals.map(a => [a.id, a]));
  for (const id of c.dueIds) {
    const d = c.oraculo.get(id)!, a = previos.get(id)!, tile = teselas(a.x, a.y)!;
    cobertura.decisiones++;
    sumar(cobertura.acciones, d.action); sumar(cobertura.especies, a.species); cobertura.especieAccion.add(`${a.species}:${d.action}`);
    if (a.x < 0 || a.y < 0) cobertura.negativas++;
    if (tile.biome === 'desert') cobertura.desierto++;
    if (tile.biome === 'ocean') cobertura.oceano++;
    if (a.memory.length === MAX_ANIMAL_MEMORY && d.memory.length === MAX_ANIMAL_MEMORY
      && a.memory.some(m => !d.memory.some(n => n.x === m.x && n.y === m.y))) cobertura.desalojos++;
    if (a.work !== d.work) cobertura.trabajoReiniciado++;
    // Fuera del rombo de percepción sólo puede apuntar a un recuerdo.
    if ((d.action === 'drink' || d.action === 'graze') && Math.abs(d.target.x - a.x) + Math.abs(d.target.y - a.y) > 2 + Math.floor(a.genes.perception * 4)) cobertura.destinoRecuerdo++;
    if (d.preyId) cobertura.destinoPresa++;
    if (tile.growth === undefined) cobertura.sinCrecimiento++;
  }
}

const TODAS: readonly (readonly [number, 'natural' | 'inverso' | 'adversarial'])[] = [
  [1, 'natural'], [2, 'natural'], [4, 'natural'], [8, 'natural'], [28, 'natural'], [4, 'inverso'], [8, 'adversarial'], [28, 'adversarial'],
];

// ── Mundo sintético con las 6 especies, océano, desierto, refugios y coordenadas negativas ──

const ESPECIES: AnimalSpecies[] = ['hare', 'deer', 'boar', 'fish', 'wolf', 'fox'];

function zoologico(ancho: number, alto: number, semilla: number, objetivo: number, tick = 2000): AnimalWorld {
  const rnd = lcg(semilla), x0 = -Math.floor(ancho / 2), y0 = -Math.floor(alto / 2);
  const tiles: Tile[] = [];
  for (let y = y0; y < y0 + alto; y++) for (let x = x0; x < x0 + ancho; x++) {
    const franja = (x - x0) / ancho, r = rnd();
    const oceano = franja < 0.12, lago = !oceano && ((x % 23 + 23) % 23 < 3) && ((y % 17 + 17) % 17 < 4);
    const desierto = franja > 0.8;
    const agua = oceano || lago;
    const tile: Tile = {
      x, y, terrain: agua ? 'water' : r < 0.04 ? 'shelter' : r < 0.5 ? 'soil' : 'meadow',
      biome: oceano ? 'ocean' : desierto ? 'desert' : rnd() < 0.5 ? 'grassland' : 'forest',
      moisture: rnd(), vegetation: rnd() < 0.3 ? 0 : rnd(), food: rnd() * 0.3, fauna: 0,
    };
    // El desierto es seco: allí la sed y el hambre dependen de lo recordado fuera de la vista.
    if (rnd() < 0.85) tile.growth = desierto ? (rnd() < 0.9 ? 0 : 0.01) : rnd() < 0.2 ? 0.01 : rnd();
    if (rnd() < 0.7) tile.drinkingWater = desierto || rnd() < 0.5 ? 0 : rnd() * 0.05;
    if (desierto) tile.vegetation = 0;
    tiles.push(tile);
  }
  // Manadas: grupos de celdas vecinas con especies mezcladas, para que haya depredadores y presas cerca.
  let colocados = 0;
  const tierra = tiles.filter(t => t.terrain !== 'water' && t.terrain !== 'shelter'), aguas = tiles.filter(t => t.terrain === 'water');
  while (colocados < objetivo) {
    const pez = rnd() < 0.12, origen = (pez ? aguas : tierra)[Math.floor(rnd() * (pez ? aguas : tierra).length)]!;
    for (let k = 0; k < 6 && colocados < objetivo; k++) {
      const t = tileLookup(tiles)(origen.x + Math.floor(rnd() * 5) - 2, origen.y + Math.floor(rnd() * 5) - 2);
      if (!t || (t.terrain === 'water') !== pez || t.terrain === 'shelter' || t.fauna) continue;
      t.species = pez ? 'fish' : ESPECIES.filter(s => s !== 'fish')[Math.floor(rnd() * 5)]!;
      t.fauna = Math.min(objetivo - colocados, 1 + Math.floor(rnd() * MAX_ANIMALS_PER_TILE));
      colocados += t.fauna;
    }
  }
  const animals = materializeAnimals(semilla, tiles, tick);
  const porCelda = tileLookup(tiles);
  for (const a of animals) {
    a.hunger = rnd(); a.thirst = rnd(); a.energy = rnd(); a.fatigue = rnd() * 0.8;
    a.lastDecision = tick - 8 - Math.floor(rnd() * 40);
    a.work = Math.floor(rnd() * 4); a.preyId = null;
    a.action = (['roam', 'graze', 'drink', 'rest', 'hunt', 'flee'] as const)[Math.floor(rnd() * 6)]!;
    // Memoria variada: llena (desalojo), caducada, visitada, sobre teselas existentes o no.
    const n = rnd() < 0.35 ? MAX_ANIMAL_MEMORY : Math.floor(rnd() * MAX_ANIMAL_MEMORY);
    const vistos = new Set<string>();
    for (let k = 0; k < n; k++) {
      const x = a.x + Math.floor(rnd() * 21) - 10, y = a.y + Math.floor(rnd() * 21) - 10;
      if (vistos.has(`${x},${y}`) || !porCelda(x, y) && rnd() < 0.7) continue;
      vistos.add(`${x},${y}`);
      a.memory.push({ x, y, tick: tick - Math.floor(rnd() * 700), food: rnd(), water: rnd() * 0.05, visited: rnd() < 0.5 });
    }
  }
  syncFauna(tiles, animals);
  return { seed: semilla, tick, tiles, animals, animalCounter: animals.length,
    animalDynamics: { births: 0, deaths: 0, predations: 0, humanHunts: 0, waterConsumed: 0, plantConsumed: 0 } };
}

// ── Pruebas ────────────────────────────────────────────────────────────────────────────

test('constantes copiadas de animals.ts', () => {
  assert.equal(MAX_MEMORIA_ANIMAL, MAX_ANIMAL_MEMORY);
  assert.equal(MAX_ANIMALES_POR_CELDA, MAX_ANIMALS_PER_TILE);
  ESPECIES_FAUNA.forEach((especie, i) => assert.equal(codigoEspecie(especie), i));
  assert.equal(codigoEspecie('toString'), 255);
});

test('mundos vivos (semillas 7, 42, 51926 tras 600 pasos): choose paralelo ≡ choose real con 1/2/4/8/28 hilos', { timeout: 600_000 }, t => {
  const total = coberturaVacia();
  for (const seed of [7, 42, 51926]) {
    const world = createWorld(seed);
    for (let i = 0; i < 600; i++) stepWorld(world);
    let decisiones = 0;
    for (let paso = 0; paso < 64; paso++) {
      const captura = capturar(world, world.tick + 1);
      verificar(captura, paso % 8 === 0 ? TODAS : [[1, 'natural'], [8, 'natural'], [28, 'adversarial']], total);
      decisiones += captura.dueIds.length;
      stepWorld(world);
    }
    t.diagnostic(`semilla ${seed}: ${decisiones} decisiones verificadas (fauna ${world.animals.length})`);
    assert.ok(decisiones > 50, `semilla ${seed}: decisiones ${decisiones}`);
  }
  const linea = `mundos vivos: ${total.decisiones} decisiones; acciones ${JSON.stringify(Object.fromEntries(total.acciones))}; `
    + `especies ${JSON.stringify(Object.fromEntries(total.especies))}; negativas ${total.negativas}; desierto ${total.desierto}; desalojos ${total.desalojos}`;
  t.diagnostic(linea); console.log(linea);
  for (const accion of ['roam', 'drink', 'rest']) assert.ok((total.acciones.get(accion) ?? 0) > 0, `mundos vivos: acción ${accion}`);
  assert.ok(total.negativas > 0 && total.desierto > 0, 'coordenadas negativas y desierto en mundos vivos');
});

test('zoológico sintético: 6 especies, todas las acciones, océano/desierto, desalojo de memoria, varios pasos', { timeout: 600_000 }, t => {
  const total = coberturaVacia();
  const world = zoologico(72, 56, 51926, 1400);
  for (let paso = 0; paso < 24; paso++) {
    const captura = capturar(world);
    verificar(captura, paso < 3 ? TODAS : [[1, 'natural'], [4, 'inverso'], [28, 'adversarial']], total);
    stepAnimals(world);
    world.tick++;
  }
  const linea = `zoológico: ${total.decisiones} decisiones; acciones ${JSON.stringify(Object.fromEntries(total.acciones))}; `
    + `especies ${JSON.stringify(Object.fromEntries(total.especies))}; combinaciones especie:acción ${total.especieAccion.size}; `
    + `negativas ${total.negativas}; desierto ${total.desierto}; océano ${total.oceano}; desalojos ${total.desalojos}; `
    + `work reiniciado ${total.trabajoReiniciado}; destino en recuerdo ${total.destinoRecuerdo}; presas ${total.destinoPresa}; sin growth ${total.sinCrecimiento}`;
  t.diagnostic(linea); console.log(linea);
  for (const s of ESPECIES) assert.ok((total.especies.get(s) ?? 0) > 0, `especie ${s}`);
  for (const a of ['roam', 'graze', 'drink', 'rest', 'hunt', 'flee']) assert.ok((total.acciones.get(a) ?? 0) > 0, `acción ${a}`);
  for (const s of ['hare', 'deer', 'boar', 'fox']) assert.ok(total.especieAccion.has(`${s}:flee`), `${s} huye`);
  assert.ok(total.especieAccion.has('wolf:hunt') && total.especieAccion.has('fox:hunt'), 'lobos y zorros cazan');
  assert.ok(total.especieAccion.has('fish:drink') || total.especieAccion.has('fish:roam'), 'los peces deciden en el agua');
  assert.ok(total.negativas > 0 && total.desierto > 0 && total.oceano > 0, 'negativas, desierto y océano');
  assert.ok(total.desalojos > 0 && total.trabajoReiniciado > 0 && total.destinoRecuerdo > 0 && total.sinCrecimiento > 0,
    'desalojo de memoria, work reiniciado, destino recordado y teselas sin growth');
});

test('SAB reutilizados, caché de terreno y salidas sucias reescritas; ids repetidos y desorden canónico', { timeout: 120_000 }, async () => {
  const world = zoologico(48, 40, 7, 600);
  const captura = capturar(world);
  const estado = new EstadoFaunaCompartido();
  const w: MundoFauna = { seed: captura.seed, tick: captura.tick, tiles: clonar(captura.tiles), animals: clonar(captura.animals) };
  const porId = new Map(w.animals.map(a => [a.id, a]));
  const due = captura.dueIds.map(id => porId.get(id)!);
  const pool = new FaunaParallelPool({ hilos: 8, orden: 'adversarial', retardoMs: 0.25 });
  try {
    let referencia: Int32Array | null = null, reasignaciones = 0;
    for (let vuelta = 0; vuelta < 4; vuelta++) {
      estado.empaquetar(w, due, estadoLocal(w));
      if (vuelta === 0) reasignaciones = estado.reasignaciones;
      new Int32Array(estado.buffers.salidaI32).fill(-7);
      pool.stepChoose(estado);
      const so = estado.salidas().so.slice(0, due.length * NSO);
      assert.ok(!so.includes(-7), 'cada fila de salida se escribió');
      if (referencia) assert.deepStrictEqual(so, referencia); else referencia = so;
    }
    assert.equal(estado.reasignaciones, reasignaciones, 'sin reasignar SAB en régimen estacionario');
    assert.equal(estado.reconstruccionesTerreno, 1, 'la disposición del terreno se reutiliza');
    // Una tesela releída (bajo un animal debido) que cambia de coordenadas invalida la caché sin cambiar
    // de arreglo ni de longitud; un arreglo nuevo también.
    const i = w.tiles.findIndex(t => t.x === due[0]!.x && t.y === due[0]!.y), original = w.tiles[i]!;
    w.tiles[i] = { ...original, x: original.x + 1000 };
    estado.empaquetar(w, due, estadoLocal(w));
    assert.equal(estado.reconstruccionesTerreno, 2);
    w.tiles[i] = original;
    w.tiles = [...w.tiles];
    estado.empaquetar(w, due, estadoLocal(w));
    assert.equal(estado.reconstruccionesTerreno, 3);
    assert.ok(estado.paginasReleidas > 0 && estado.paginasReleidas <= estado.paginas);
  } finally { await pool.close(); }

  // `world.animals` sin orden canónico (vía general de rangos): mismo resultado que el oráculo.
  const desordenado: MundoFauna = { seed: captura.seed, tick: captura.tick, tiles: clonar(captura.tiles), animals: clonar(captura.animals).reverse() };
  const porId2 = new Map(desordenado.animals.map(a => [a.id, a]));
  const due2 = captura.dueIds.map(id => porId2.get(id)!);
  const ocupantes = estadoLocal({ ...desordenado, animals: [...desordenado.animals].reverse() });
  applyFaunaChooseOutputs(due2, desordenado, stepChooseParallel(desordenado, due2, ocupantes, 4, 'natural'));
  for (const a of due2) assert.deepStrictEqual(decisionDe(a), captura.oraculo.get(a.id), `orden no canónico: ${a.id}`);
  assert.throws(() => stepChooseParallel(desordenado, [due2[0]!, due2[0]!], ocupantes, 1), /repetido/);
});

test('benchmark A = 4 000 animales / 1 024 decisiones: 1 hilo frente a 8 y 28 workers, salida idéntica al choose real', { timeout: 600_000 }, async t => {
  const world = zoologico(200, 150, 4000, 4000);
  assert.equal(world.animals.length, 4000);
  const captura = capturar(world);
  assert.equal(captura.dueIds.length, MAX_ANIMAL_DECISIONS_PER_TICK);
  verificar(captura, [[1, 'natural'], [8, 'natural'], [28, 'natural']]);

  const w: MundoFauna = { seed: captura.seed, tick: captura.tick, tiles: clonar(captura.tiles), animals: clonar(captura.animals) };
  const porId = new Map(w.animals.map(a => [a.id, a]));
  const due = captura.dueIds.map(id => porId.get(id)!);
  const state = estadoLocal(w);
  const estado = new EstadoFaunaCompartido();
  const mediana = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  // Empaquetado (serie, en el coordinador): primera vez construye la disposición; después la reutiliza.
  let inicio = performance.now();
  estado.empaquetar(w, due, state);
  const primerEmpaquetadoMs = performance.now() - inicio;
  const empaquetados: number[] = [];
  for (let i = 0; i < 200; i++) estado.empaquetar(w, due, state);
  for (let i = 0; i < 41; i++) { inicio = performance.now(); estado.empaquetar(w, due, state); empaquetados.push(performance.now() - inicio); }
  // Régimen estacionario de una piscina persistente: el JIT de cada worker necesita cientos de despachos.
  const calentar = 200, repetir = 41;
  const resultados: { hilos: number; medianaMs: number; ocupacion: number; barreraMs: number; so: Int32Array }[] = [];
  for (const hilos of [1, 8, 28]) {
    const pool = new FaunaParallelPool({ hilos, reloj: () => performance.now() });
    try {
      for (let i = 0; i < calentar; i++) pool.stepChoose(estado);
      const tiempos: number[] = [], ocupaciones: number[] = [], barreras: number[] = [];
      for (let i = 0; i < repetir; i++) {
        new Int32Array(estado.buffers.salidaI32).fill(-7);
        const t0 = performance.now();
        pool.stepChoose(estado);
        tiempos.push(performance.now() - t0);
        const d = pool.diagnostics();
        ocupaciones.push(d.ocupacionWorkers); barreras.push(d.tiempoBarreraMs);
      }
      resultados.push({ hilos, medianaMs: mediana(tiempos), ocupacion: mediana(ocupaciones), barreraMs: mediana(barreras),
        so: estado.salidas().so.slice(0, due.length * NSO) });
    } finally { await pool.close(); }
  }
  // Aplicación (serie) sobre una copia: lo que costaría devolver los resultados al mundo.
  const aplicar: number[] = [];
  for (let i = 0; i < 21; i++) {
    const wc: MundoFauna = { ...w, animals: clonar(w.animals) };
    const pc = new Map(wc.animals.map(a => [a.id, a]));
    const dc = captura.dueIds.map(id => pc.get(id)!);
    estado.empaquetar(wc, dc, estadoLocal(wc));
    const p1 = new FaunaParallelPool({ hilos: 1 }); p1.stepChoose(estado); void p1.close();
    const s = estado.salidas();
    inicio = performance.now(); applyFaunaChooseOutputs(dc, wc, s); aplicar.push(performance.now() - inicio);
  }
  // El `choose` real, en serie, dentro de `stepAnimals` (misma entrada; 30 pasos de calentamiento del JIT).
  const reales: number[] = [];
  for (let i = 0; i < 45; i++) {
    const r = medirChooseReal(world);
    assert.equal(r.decisiones, MAX_ANIMAL_DECISIONS_PER_TICK);
    if (i >= 30) reales.push(r.ms);
  }
  const realMs = mediana(reales), empaquetarMs = mediana(empaquetados), aplicarMs = mediana(aplicar);
  const serie = resultados[0]!;
  for (const r of resultados) {
    assert.deepStrictEqual(r.so, serie.so, `A=4000: salida con ${r.hilos} hilos idéntica a 1 hilo`);
    assert.ok(r.ocupacion >= 0 && r.ocupacion <= 1);
    const linea = `A=4000 due=1024 hilos=${r.hilos}: choose ${r.medianaMs.toFixed(3)} ms (mediana de ${repetir}), aceleración ${(serie.medianaMs / r.medianaMs).toFixed(2)}×, `
      + `ocupación ${(r.ocupacion * 100).toFixed(1)} %, barrera ${r.barreraMs.toFixed(3)} ms`;
    t.diagnostic(linea); console.log(linea);
  }
  const linea = `A=4000: ${w.tiles.length} teselas, ${estado.paginas} páginas (${estado.paginasReleidas} releídas); empaquetado ${primerEmpaquetadoMs.toFixed(2)} ms la primera vez, `
    + `${empaquetarMs.toFixed(3)} ms con la disposición en caché (reconstrucciones ${estado.reconstruccionesTerreno}); aplicar ${aplicarMs.toFixed(3)} ms; ${estado.regiones.length} bloques`;
  t.diagnostic(linea); console.log(linea);
  for (const r of resultados) {
    const total = empaquetarMs + r.medianaMs + aplicarMs;
    const l = `A=4000 extremo a extremo hilos=${r.hilos}: empaquetar + choose + aplicar = ${total.toFixed(3)} ms frente a ${realMs.toFixed(3)} ms del choose real en serie `
      + `(${(realMs / total).toFixed(2)}×)`;
    t.diagnostic(l); console.log(l);
  }
});
