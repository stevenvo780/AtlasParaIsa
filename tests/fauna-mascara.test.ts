import test from 'node:test';
import assert from 'node:assert/strict';
import type { Tile, ChronicleEvent } from '../src/shared/types.js';
import { MAX_ACTIVE_ANIMALS, mascaraFauna, materializeAnimals, seleccionDe, stepAnimals, syncFauna, type Animal, type AnimalWorld, type MascaraFauna } from '../src/world/animals.js';

function tile(x = 0, y = 0, overrides: Partial<Tile> = {}): Tile {
  return { x, y, terrain: 'meadow', biome: 'grassland', moisture: 0.8, vegetation: 0.8, growth: 0.8,
    food: 0.2, fauna: 0, drinkingWater: 0.8, fertility: 0.6, ...overrides };
}
function world(tiles: Tile[], animals: Animal[]): AnimalWorld {
  syncFauna(tiles, animals);
  return { seed: 42, tick: 0, tiles, animals, animalCounter: 0, reproductionEnabled: false,
    animalDynamics: { births: 0, deaths: 0, predations: 0, humanHunts: 0, waterConsumed: 0, plantConsumed: 0 } };
}
function herd(count: number): AnimalWorld {
  const tiles = Array.from({ length: count }, (_, x) => tile(x, 0, { fauna: 1, species: 'hare' }));
  return world(tiles, materializeAnimals(42, tiles, 0));
}
const canonicalId = (a: { id: string }, b: { id: string }): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
function ventanaDeHoy(animals: readonly Animal[], tick: number): string[] {
  const sorted = [...animals].sort(canonicalId);
  const population = sorted.length;
  const offset = population ? ((tick % population) * MAX_ACTIVE_ANIMALS) % population : 0;
  const selected = population <= MAX_ACTIVE_ANIMALS ? [...sorted]
    : [...sorted.slice(offset, offset + MAX_ACTIVE_ANIMALS), ...sorted.slice(0, Math.max(0, offset + MAX_ACTIVE_ANIMALS - population))].sort(canonicalId);
  return selected.map(a => a.id);
}
function regiones(animals: readonly Animal[], P: number): Animal[][] {
  const groups: Animal[][] = Array.from({ length: P }, () => []);
  for (const a of animals) groups[Math.floor(a.x / 64) % P]!.push(a);
  return groups;
}

test('la máscara coincide con la ventana de hoy', () => {
  for (const count of [5000, MAX_ACTIVE_ANIMALS + 1, 3 * MAX_ACTIVE_ANIMALS + 7]) {
    const w = herd(count);
    w.animals.reverse();
    const snapshot = [...w.animals];
    for (let tick = 0; tick < 1000; tick++) {
      w.tick = tick;
      const m = mascaraFauna(w);
      assert.deepEqual([...m.seleccion].map(a => a.id), ventanaDeHoy(snapshot, tick));
      assert.deepEqual([...m.ids], [...m.seleccion].map(a => a.id));
      assert.equal(m.tick, tick); assert.equal(m.animales, w.animals); assert.equal(m.poblacion, count);
      if (tick === 0) {
        assert.ok(Object.isFrozen(m)); assert.ok(Object.isFrozen(m.seleccion));
      }
    }
  }
});

test('repartida entre 1 y 8 particiones da la misma selección', () => {
  const w = herd(3 * MAX_ACTIVE_ANIMALS + 7);
  w.tick = 17;
  const m = mascaraFauna(w);
  const byP: Set<string>[] = [];
  let offsetPorRegionDistinto = false;
  for (let P = 1; P <= 8; P++) {
    const groups = regiones(w.animals, P);
    const seen = new Set<string>();
    for (const region of groups) for (const a of region) {
      assert.ok(!seen.has(a.id)); seen.add(a.id);
    }
    assert.equal(seen.size, w.animals.length);
    const union = groups.flatMap(region => seleccionDe(m, region)).sort(canonicalId);
    assert.equal(union.length, m.seleccion.length);
    assert.ok(union.every((a, i) => a === m.seleccion[i]));
    byP.push(new Set(union.map(a => a.id)));
    const wrong = groups.flatMap(region => {
      const sorted = [...region].sort(canonicalId);
      const population = sorted.length;
      const offset = population ? ((w.tick % population) * MAX_ACTIVE_ANIMALS) % population : 0;
      return population <= MAX_ACTIVE_ANIMALS ? [...sorted]
        : [...sorted.slice(offset, offset + MAX_ACTIVE_ANIMALS), ...sorted.slice(0, Math.max(0, offset + MAX_ACTIVE_ANIMALS - population))].sort(canonicalId);
    }).sort(canonicalId);
    if (wrong.length !== m.seleccion.length || wrong.some((a, i) => a !== m.seleccion[i])) offsetPorRegionDistinto = true;
  }
  for (let P = 2; P <= 8; P++) {
    assert.equal(byP[P - 1]!.size, byP[0]!.size);
    for (const id of byP[0]!) assert.ok(byP[P - 1]!.has(id));
  }
  for (const a of w.animals) {
    const selected = m.ids.has(a.id);
    for (let P = 1; P <= 8; P++) assert.equal(byP[P - 1]!.has(a.id), selected);
  }
  assert.ok(offsetPorRegionDistinto, 'una ventana con offset por región debe diferir de la máscara global');
});

function mundoVivo(): AnimalWorld {
  const count = MAX_ACTIVE_ANIMALS + 1;
  const tiles = Array.from({ length: count }, (_, x) => tile(x, 0, { fauna: 1, species: 'hare' }));
  const animals = materializeAnimals(42, tiles, 0);
  const prey = animals[0]!, wolf = animals[1]!, fox = animals[2]!, mateA = animals[3]!, mateB = animals[4]!;
  prey.energy = 0.05; // exhausta: no puede huir, así la caza termina en depredación
  wolf.species = 'wolf'; wolf.genes.carnivory = 0.96; wolf.hunger = 0.85;
  wolf.x = prey.x; wolf.y = prey.y; wolf.target = { x: prey.x, y: prey.y };
  fox.species = 'fox'; fox.genes.carnivory = 0.85; fox.hunger = 0.85;
  fox.x = prey.x + 1; fox.y = prey.y; fox.target = { x: prey.x + 1, y: prey.y };
  mateA.species = 'deer'; mateB.species = 'deer';
  mateB.x = mateA.x; mateB.y = mateA.y; mateB.target = { x: mateA.x, y: mateA.y };
  // Cuerpos al borde de la muerte repartidos por el orden canónico: mueren sólo en el tick en que la
  // ventana los selecciona, así que el gateo de `physiology` decide cuándo.
  for (let i = 100; i < count; i += 1637) { animals[i]!.thirst = 0.99; animals[i]!.health = 0.0005; }
  const w = world(tiles, animals); w.reproductionEnabled = true;
  return w;
}

test('el gateo de fisiología sigue a la máscara: el excluido del tick no muere en ese tick', () => {
  const w = mundoVivo(); w.tick = 1;
  const excluido = w.animals.find(a => !mascaraFauna(w).ids.has(a.id))!, elegido = w.animals.find(a => a.health > 0.5 && a !== excluido)!;
  assert.equal(w.animals.length - mascaraFauna(w).seleccion.length, 1);
  for (const a of [excluido, elegido]) { a.thirst = 0.99; a.health = 0.0005; }
  stepAnimals(w);
  assert.ok(excluido.health > 0 && w.animals.includes(excluido), 'fuera de la ventana no avanza su fisiología');
  assert.equal(elegido.health, 0); assert.ok(!w.animals.includes(elegido));
});

test('el paso con la máscara del coordinador repartida entre 1 y 8 particiones es idéntico', () => {
  const w = mundoVivo(), w2 = structuredClone(w);
  const events: Omit<ChronicleEvent, 'id' | 'tick'>[] = [], events2: Omit<ChronicleEvent, 'id' | 'tick'>[] = [];
  for (let n = 0; n < 60; n++) {
    w.tick++; w2.tick++;
    stepAnimals(w, e => events.push(e));
    const m = mascaraFauna(w2), P = 1 + (w2.tick % 8);
    const seleccion = regiones(w2.animals, P).flatMap(region => seleccionDe(m, region)).sort(canonicalId);
    assert.equal(seleccion.length, m.seleccion.length);
    assert.ok(seleccion.every((a, i) => a === m.seleccion[i]));
    const reconstruida: MascaraFauna = { tick: m.tick, animales: m.animales, poblacion: m.poblacion, orden: m.orden, seleccion, ids: new Set(seleccion.map(a => a.id)) };
    stepAnimals(w2, e => events2.push(e), reconstruida);
    const canonica = [...w.animals].sort(canonicalId); // lo que dejaba el `sort` de cierre de antes
    assert.ok(w.animals.every((a, i) => a === canonica[i]));
  }
  // El escenario ejerce muertes por fisiología, depredación y nacimientos con la ventana rotando.
  assert.ok(w.animalDynamics.deaths > w.animalDynamics.predations && w.animalDynamics.predations > 0 && w.animalDynamics.births > 0,
    JSON.stringify(w.animalDynamics));
  assert.equal(JSON.stringify(w), JSON.stringify(w2));
  assert.equal(JSON.stringify(events), JSON.stringify(events2));
});

test('el orden canónico rápido da el mismo arreglo que ordenar: ordenado, invertido, casi ordenado e ids repetidos', () => {
  const base = herd(40).animals;
  const repetido = base.map(a => ({ ...a }));
  repetido[7]!.id = repetido[8]!.id; repetido[20]!.id = repetido[3]!.id; // corrupto a propósito: la estabilidad manda
  const casos = [[...base], [...base].reverse(), [...base.slice(1), base[0]!], repetido, [...repetido].reverse(), [repetido[8]!, repetido[7]!]];
  for (const caso of casos) {
    const w = world([], caso), esperado = [...caso].sort(canonicalId);
    mascaraFauna(w);
    assert.equal(w.animals, caso);
    assert.ok(w.animals.length === esperado.length && w.animals.every((a, i) => a === esperado[i]));
  }
});

/** Generador determinista para los tests de propiedades (nada de azar real en la suite). */
function lcg(seed: number): (n: number) => number {
  let x = seed >>> 0;
  return n => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x % n; };
}
/** Copia profunda que comparte las cadenas, como `cloneState` de `cloneWorld` (motor.clonPorPaso). */
function clonar<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clonar) as T;
  const copia: Record<string, unknown> = {};
  for (const k in v) copia[k] = clonar((v as Record<string, unknown>)[k]);
  return copia as T;
}
const mismoArreglo = (a: readonly Animal[], b: readonly Animal[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

test('entre pasos, quitar, añadir, reordenar, clonar o repetir ids deja el mismo orden que sort', () => {
  const r = lcg(20260923);
  const w = herd(400);
  let nuevos = 0;
  const nacido = (id?: string): Animal => ({ ...w.animals[r(w.animals.length)]!, id: id ?? `animal-born-42-${r(40)}-${++nuevos}` });
  const mutaciones: ((xs: Animal[]) => Animal[])[] = [
    xs => xs.filter(() => r(9) > 0),                                              // caza o chunk retirado
    xs => { for (let n = r(30); n > 0; n--) xs.push(nacido()); return xs; },        // chunk activado: cola al final
    xs => { for (let n = 1 + r(5); n > 0; n--) xs.push(nacido(xs[r(xs.length)]!.id)); return xs; }, // ids repetidos
    xs => { const a = r(xs.length), b = r(xs.length); [xs[a], xs[b]] = [xs[b]!, xs[a]!]; return xs; },
    xs => xs.reverse(),
    xs => xs.map(a => ({ ...a })),                                                  // clon: objetos nuevos, mismas cadenas
    xs => structuredClone(xs),                                                      // clon con cadenas nuevas
    xs => { const a = r(xs.length); xs.splice(a, 0, ...xs.splice(a, 1 + r(20)).reverse()); return xs; },
    xs => xs,                                                                       // nada: el certificado basta
  ];
  for (let ronda = 0; ronda < 600; ronda++) {
    const cuantas = 1 + r(3);
    for (let n = 0; n < cuantas; n++) w.animals = mutaciones[r(mutaciones.length)]!(w.animals);
    const antes = [...w.animals], esperado = [...antes].sort(canonicalId);
    w.tick = ronda;
    const m = mascaraFauna(w);
    assert.ok(mismoArreglo(w.animals, esperado), `ronda ${ronda}`);
    assert.ok(mismoArreglo(m.orden, w.animals));
    if (w.animals.length > 300) w.animals = w.animals.filter(() => r(3) > 0);
  }
});

test('la ventana que da la vuelta con ids repetidos entre sus dos tramos es la de hoy, objeto a objeto', () => {
  const w = herd(MAX_ACTIVE_ANIMALS + 1);
  for (const a of w.animals) a.id = 'animal-mismo';
  const snapshot = [...w.animals];
  for (let tick = 0; tick < 12; tick++) {
    w.tick = tick;
    const sorted = [...snapshot].sort(canonicalId), population = sorted.length;
    const offset = ((tick % population) * MAX_ACTIVE_ANIMALS) % population;
    const hoy = [...sorted.slice(offset, offset + MAX_ACTIVE_ANIMALS), ...sorted.slice(0, Math.max(0, offset + MAX_ACTIVE_ANIMALS - population))].sort(canonicalId);
    assert.ok(mismoArreglo(mascaraFauna(w).seleccion, hoy), `tick ${tick}`);
  }
});

test('clonar el mundo en cada paso (motor.clonPorPaso) o alternar dos mundos da el mismo resultado', () => {
  const pasos = 40, correr = (w: AnimalWorld, clonarCadaPaso: boolean, entre?: () => void): { w: AnimalWorld; eventos: unknown[] } => {
    const eventos: unknown[] = [];
    for (let n = 0; n < pasos; n++) {
      if (clonarCadaPaso) w = clonar(w);
      w.tick++; stepAnimals(w, e => eventos.push(e));
      assert.ok(mismoArreglo(w.animals, [...w.animals].sort(canonicalId)));
      entre?.();
    }
    return { w, eventos };
  };
  const persistente = correr(mundoVivo(), false);
  assert.ok(persistente.w.animalDynamics.births > 0 && persistente.w.animalDynamics.deaths > 0, JSON.stringify(persistente.w.animalDynamics));
  const huella = JSON.stringify(persistente.w), eventos = JSON.stringify(persistente.eventos);
  // Solo, con el mundo clonado en cada paso: el certificado reconoce la fauna por sus ids.
  const clonado = correr(mundoVivo(), true);
  assert.equal(JSON.stringify(clonado.w), huella); assert.equal(JSON.stringify(clonado.eventos), eventos);
  // Alternando con otro mundo, que ocupa el único hueco del certificado entre paso y paso.
  const otro = mundoVivo();
  otro.seed = 7; for (const a of otro.animals) a.id = a.id.replace('animal-42', 'animal-7');
  for (const clonarCadaPaso of [false, true]) {
    const alterno = correr(mundoVivo(), clonarCadaPaso, () => { otro.tick++; stepAnimals(otro); });
    assert.equal(JSON.stringify(alterno.w), huella); assert.equal(JSON.stringify(alterno.eventos), eventos);
  }
});

test('una fauna reordenada en sitio entre pasos no pasa por ordenada', () => {
  const w = mundoVivo();
  for (let n = 0; n < 3; n++) { w.tick++; stepAnimals(w); }
  const mutaciones: ((xs: Animal[]) => void)[] = [xs => xs.reverse(), xs => { [xs[10], xs[20]] = [xs[20]!, xs[10]!]; }, xs => { xs[5] = xs.pop()!; xs.push(xs[6]!); xs[6] = xs[xs.length - 2]!; }];
  for (const mutar of mutaciones) {
    const control = structuredClone(w), eventos: unknown[] = [], eventosControl: unknown[] = [];
    mutar(w.animals); mutar(control.animals);
    control.animals.sort(canonicalId); // lo que hacía el `sort` de antes al empezar el paso
    assert.equal(w.animals.length, control.animals.length);
    w.tick++; control.tick++;
    stepAnimals(w, e => eventos.push(e)); stepAnimals(control, e => eventosControl.push(e));
    assert.equal(JSON.stringify(w), JSON.stringify(control)); assert.equal(JSON.stringify(eventos), JSON.stringify(eventosControl));
  }
});

test('rechaza una máscara de otro paso', () => {
  const w = herd(12);
  const porTick = mascaraFauna(w);
  w.tick++;
  assert.throws(() => stepAnimals(w, undefined, porTick), { message: 'Máscara de fauna de otro paso.' });
  w.tick--;
  const porIdentidad = mascaraFauna(w);
  w.animals = [...w.animals];
  assert.throws(() => stepAnimals(w, undefined, porIdentidad), { message: 'Máscara de fauna de otro paso.' });
  const porOrden = mascaraFauna(w);
  w.animals.reverse();
  assert.throws(() => stepAnimals(w, undefined, porOrden), { message: 'Máscara de fauna de otro paso.' });
});

test('el orden de la máscara es una copia congelada: tocarlo no engaña al certificado ni a la validación', () => {
  const w = herd(12);
  w.animals.reverse();
  const m = mascaraFauna(w);
  assert.ok(Object.isFrozen(m.orden) && mismoArreglo(m.orden, w.animals));
  assert.throws(() => Array.prototype.reverse.call(m.orden), TypeError);
  w.animals.reverse();
  assert.throws(() => stepAnimals(w, undefined, m), { message: 'Máscara de fauna de otro paso.' });
  const invertida = [...w.animals];
  mascaraFauna(w);
  assert.ok(mismoArreglo(w.animals, [...invertida].sort(canonicalId)));
});
