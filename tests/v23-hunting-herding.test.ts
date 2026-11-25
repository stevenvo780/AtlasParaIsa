import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { AnimalMorphology, AnimalSpecies } from '../src/shared/life.js';
import type { Tile } from '../src/shared/types.js';
import { evaluateMaterialProperties, vectorMass, type CompoundLot } from '../src/shared/chemistry.js';
import { createWorld, stepWorld, cloneWorld, projectWorld, assertWorld, huntWorkDuration, type World } from '../src/world/index.js';
import { materializeAnimals, stepAnimals, syncFauna, harvestAt, assertAnimal, animalBiomass, projectAnimal, type Animal, type AnimalWorld } from '../src/world/animals.js';
import { assertAnimalTraits } from '../src/world/validation.js';
import { assertChemistryState, assertCompoundLots } from '../src/world/chemistry.js';
import { DEFAULT_PARAMS, parseParams, setParams } from '../src/world/params.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { projectCraft } from '../src/world/projection.js';
import { rawMaterial } from '../src/world/technology.js';

// Biological switches enabled by CARTA_OPEN_WORLD, with CPU execution fixed for
// reproducible tests (no hardware probing, public persistence or server services).
const OPEN = 'quimica.emergente=true,fauna.contactoContinuo=true,fauna.reservaReproductiva=true,fauna.encuentroFertil=true,poblacion.natalidadVecindad=true,social.maxComunidades=0,construccion.modular=true,construccion.poliminosYSinergia=true,terreno.caminosFisicos=true';
const morph = (changes: Partial<AnimalMorphology> = {}): AnimalMorphology => ({ caution: 0.3, size: 0.5, coat: 0.5, defense: 0.3, ...changes });

after(async () => { await closeEcosystemWorkers(); });

function scene(species: AnimalSpecies[] = ['deer'], emerging = true, half = 7): AnimalWorld {
  const tiles: Tile[] = [];
  for (let y = -half; y <= half; y++) for (let x = -half; x <= half; x++) tiles.push({
    x, y, terrain: 'meadow', biome: 'grassland', food: 0.2, vegetation: 0.8, growth: 0.8,
    moisture: 0.8, drinkingWater: 0.8, fertility: 0.2, fauna: 0,
  });
  for (const [i, s] of species.entries()) {
    const tile = tiles.find(t => t.x === i && t.y === 0)!;
    tile.species = s; tile.fauna = 1;
  }
  const w: AnimalWorld = { seed: 51926, tick: 0, tiles, animals: materializeAnimals(51926, tiles, 0), animalCounter: 0,
    animalDynamics: { births: 0, deaths: 0, predations: 0, humanHunts: 0, plantConsumed: 0, waterConsumed: 0 },
    reproductionEnabled: false, people: [], structures: [], weather: 'clear' };
  setParams(w, parseParams(`quimica.emergente=${emerging}`));
  return w;
}
function runAnimals(w: AnimalWorld, ticks: number): void { for (let t = 0; t < ticks; t++) { w.tick++; stepAnimals(w); } }

function hunterWorld(emerging = true): { w: World; prey: Animal } {
  const w = createWorld(51926, parseParams(`quimica.emergente=${emerging}`));
  w.people = [w.people[2]!];
  const p = w.people[0]!, prey = w.animals.find(a => a.species === 'boar')!;
  w.animals = [prey]; w.reproductionEnabled = false;
  Object.assign(prey, { energy: 0.04, morphology: emerging ? morph() : undefined, habituation: emerging ? 0 : undefined });
  Object.assign(p, { x: prey.x, y: prey.y, hunger: 0.7, inventory: 0, energy: 0.95, thirst: 0.1, fatigue: 0,
    action: 'hunt', huntingPreyId: emerging ? prey.id : undefined, decisionAt: 1000, target: { x: prey.x, y: prey.y }, work: 0 });
  syncFauna(w.tiles, w.animals);
  return { w, prey };
}

test('V23: calibrated paid hunting yields meat plus conserved C/H/Ca raw biomass; harder tools reduce work', () => {
  const { w, prey } = hunterWorld(), p = w.people[0]!;
  const bare = huntWorkDuration(p, prey);
  const composition = { C: 0.25, H: 0, Ca: 0, S: 0, Si: 0, Fe: 0.75 };
  const tool: CompoundLot = { id: 'test-tool', formulaId: 'test-steel', composition, mass: 1, phase: 'smelted', properties: evaluateMaterialProperties(composition, 'smelted') };
  p.compounds = [tool];
  assert.ok(huntWorkDuration(p, prey) < bare);
  const skilled = huntWorkDuration(p, prey); p.skills.hunt = 1;
  assert.ok(huntWorkDuration(p, prey) < skilled); p.skills.hunt = 0;
  p.compounds = undefined;
  const cuttingTool = rawMaterial('stone');
  Object.assign(cuttingTool.properties, { hardness: 0.95, toughness: 0.95, edge: 0.95 });
  p.technology.items.push(cuttingTool);
  assert.ok(huntWorkDuration(p, prey) < bare, 'carried cutting technology also reduces paid work');
  p.technology.items.pop(); p.compounds = [tool];
  const biomass = animalBiomass(prey), initialHunger = p.hunger;
  for (let i = 0; i < 34 && !w.animalDynamics.humanHunts; i++) stepWorld(w);
  assert.equal(w.animalDynamics.humanHunts, 1);
  assert.ok(p.inventory > 0 && p.hunger < initialHunger);
  const lot = p.compounds!.find(l => l.formulaId.startsWith('bio:'))!;
  assert.equal(lot.phase, 'raw');
  assert.ok(lot.composition.C > 0 && lot.composition.H > 0 && lot.composition.Ca > 0);
  assert.ok(Math.abs(lot.mass - biomass * 0.2) < 1e-12);
  assert.ok(Math.abs(lot.mass + w.totals.foodHarvested! - biomass) < 1e-12);
  assert.equal(lot.mass, vectorMass(lot.composition));
  assertCompoundLots(p.compounds); assertChemistryState(w.chemistry, w.tick);
  assert.equal(w.animals.length, 0);
  const control = hunterWorld(false).w;
  for (let i = 0; i < w.tick; i++) stepWorld(control);
  assert.equal(control.animalDynamics.humanHunts, 0, 'old 45-tick work has not finished at the calibrated completion time');
});

test('V23: seed 51926, 480 natural steps: more hunts despite available wild plants', t => {
  const counts: number[] = [];
  for (const emerging of [false, true]) {
    const w = createWorld(51926, parseParams(`${OPEN},quimica.emergente=${emerging}`));
    for (let i = 0; i < 480; i++) stepWorld(w);
    counts.push(w.animalDynamics.humanHunts);
  }
  t.diagnostic(`seed=51926 ticks=480 control=${counts[0]} V23=${counts[1]}`);
  assert.ok(counts[1]! > counts[0]!, 'paid hunts should occur more often with calibrated work and hunger scoring');
});

test('V23: deterministic morphology, inherited continuous variation, legacy animals unchanged', () => {
  const a = scene(['deer', 'deer']), b = scene(['deer', 'deer']);
  runAnimals(a, 1); runAnimals(b, 1);
  assert.deepEqual(a.animals.map(a => a.morphology), b.animals.map(a => a.morphology));
  const parentA = a.animals[0]!, parentB = a.animals[1]!;
  parentA.morphology = morph({ coat: 0.2, defense: 0.7 }); parentB.morphology = morph({ coat: 0.8, defense: 0.3 });
  for (const p of a.animals) Object.assign(p, { hunger: 0.2, thirst: 0.2, energy: 0.9, health: 1, fatigue: 0.1 });
  a.reproductionEnabled = true; runAnimals(a, 1);
  const child = a.animals.find(a => a.generation === 1)!;
  assert.ok(child); assert.deepEqual(child.parents, [parentA.id, parentB.id].sort());
  for (const key of ['caution', 'size', 'coat', 'defense'] as const) {
    const average = (parentA.morphology![key] + parentB.morphology![key]) / 2;
    assert.ok(Math.abs(child.morphology![key] - average) <= 0.03);
    assert.notEqual(child.morphology![key], average);
    assert.ok(child.morphology![key] >= 0.05 && child.morphology![key] <= 0.95);
  }
  const historical = scene(['deer'], false); runAnimals(historical, 20);
  assert.equal(historical.animals[0]!.morphology, undefined);
  assert.equal(historical.animals[0]!.habituation, undefined);
});

test('V23: cold favors coat and large bodies, desert penalizes coat, size costs food and increases carcass yield', () => {
  const energy = (biome: Tile['biome'], coat: number, size = 0.5): number => {
    const w = scene(); w.animals[0]!.morphology = morph({ coat, size });
    for (const t of w.tiles) t.biome = biome;
    // Same resting bodies and finite resources: compare physical costs over time.
    const a = w.animals[0]!; a.energy = 0.5; a.fatigue = 0.8;
    runAnimals(w, 7); return a.energy;
  };
  assert.ok(energy('mountain', 0.9) > energy('mountain', 0.1));
  assert.ok(energy('desert', 0.9) < energy('desert', 0.1));
  // Isolate surface heat loss from the larger body's metabolic cost.
  assert.ok(energy('grassland', 0.5, 0.9) - energy('mountain', 0.5, 0.9)
    < energy('grassland', 0.5, 0.1) - energy('mountain', 0.5, 0.1));
  const small = scene(), large = scene();
  small.animals[0]!.morphology = morph({ size: 0.1 }); large.animals[0]!.morphology = morph({ size: 0.9 });
  runAnimals(small, 1); runAnimals(large, 1);
  assert.ok(large.animals[0]!.hunger > small.animals[0]!.hunger);
  assert.ok(animalBiomass(large.animals[0]!) > animalBiomass(small.animals[0]!));
  const movement = (size: number): number => {
    const w = scene(), a = w.animals[0]!; a.morphology = morph({ size });
    a.genes.speed = 1; a.genes.perception = 1; a.fatigue = 0; a.thirst = 0.7;
    for (const tile of w.tiles) tile.drinkingWater = tile.x === 4 && tile.y === 0 ? 0.8 : 0;
    runAnimals(w, 7); return a.x;
  };
  assert.ok(movement(0.1) > movement(0.9), 'larger bodies move more slowly');
});

test('V23: climate selects the coat distribution of actual offspring at the reproductive energy boundary', t => {
  const offspringCoat = (biome: Tile['biome']): number => {
    let total = 0, births = 0;
    for (const coat of [0.1, 0.9]) for (const margin of [0.0001, 0.00015, 0.0002, 0.00025, 0.0003, 0.00035]) {
      const w = scene(['deer', 'deer']); w.reproductionEnabled = true;
      for (const tile of w.tiles) tile.biome = biome;
      for (const a of w.animals) Object.assign(a, { energy: 0.65 + margin, hunger: 0.2, thirst: 0.2, health: 1,
        lastMove: 0, morphology: morph({ coat }) });
      runAnimals(w, 1);
      for (const a of w.animals) if (a.generation > 0) { total += a.morphology!.coat; births++; }
    }
    assert.ok(births > 0); return total / births;
  };
  const cold = offspringCoat('mountain'), warm = offspringCoat('desert');
  t.diagnostic(`offspring mean coat mountain=${cold.toFixed(4)} desert=${warm.toFixed(4)}`);
  assert.ok(cold > warm + 0.1, 'thermal costs filter reproduction and transmit the favored heritable trait');
});

test('V23: defensive morphology reduces real predation damage under equal contact', () => {
  const remaining = (defense: number): number => {
    const w = scene(['wolf', 'deer']), predator = w.animals.find(a => a.species === 'wolf')!, prey = w.animals.find(a => a.species === 'deer')!;
    prey.x = predator.x; prey.y = predator.y; syncFauna(w.tiles, w.animals);
    predator.morphology = morph(); prey.morphology = morph({ defense });
    for (let i = 0; i < 32; i++) {
      predator.action = 'hunt'; predator.preyId = prey.id; predator.lastDecision = w.tick + 1;
      predator.target = { x: prey.x, y: prey.y }; predator.lastMove = w.tick + 1;
      prey.action = 'rest'; prey.lastDecision = w.tick + 1; prey.lastMove = w.tick + 1;
      prey.target = { x: prey.x, y: prey.y };
      runAnimals(w, 1);
    }
    return prey.health;
  };
  assert.ok(remaining(0.9) > remaining(0.1));
});

test('V23: low caution habituates near gardens; grazing fertilizes; wolves flee shelters and hearths', () => {
  const w = scene(), a = w.animals[0]!;
  a.morphology = morph({ caution: 0.1 }); a.energy = 0.04;
  w.tiles.find(t => t.x === a.x && t.y === a.y)!.cultivation = 0.8;
  w.people = [{ x: a.x + 2, y: a.y }];
  runAnimals(w, 42);
  assert.ok((a.habituation ?? 0) >= 0.45);
  const wild = scene(); wild.animals[0]!.morphology = morph(); wild.animals[0]!.habituation = 0.8;
  runAnimals(wild, 1); assert.ok(wild.animals[0]!.habituation! < 0.8);
  const tile = w.tiles.find(t => t.x === a.x && t.y === a.y)!;
  a.hunger = 0.7;
  const before = tile.fertility!; w.tick = 47; runAnimals(w, 1);
  assert.ok(tile.fertility! > before);
  const wolves = scene(['wolf']);
  wolves.structures = [{ x: 0, y: 0, condition: 1, components: ['hearth'] }];
  runAnimals(wolves, 1);
  const wolf = wolves.animals[0]!;
  assert.equal(wolf.action, 'flee');
  assert.ok(Math.abs(wolf.x) + Math.abs(wolf.y) > 0);
  const alarm = scene(['deer', 'hare']);
  for (const a of alarm.animals) { a.habituation = 0.6; a.morphology = morph(); }
  harvestAt(alarm, alarm.animals[0]!, 'hunter');
  assert.ok(Math.abs(alarm.animals[0]!.habituation! - 0.45) < 1e-12);
  assert.equal(alarm.animals[0]!.lastHunted, alarm.tick);
  alarm.people = [{ x: alarm.animals[0]!.x + 2, y: alarm.animals[0]!.y }];
  alarm.animals[0]!.morphology = morph({ caution: 0.05 });
  runAnimals(alarm, 1); assert.equal(alarm.animals[0]!.action, 'flee', 'a nearby hunt spikes even a calm animal\'s flight response');
});

test('V23: settlement walls channel roaming into a courtyard without commands', () => {
  const w = scene(), a = w.animals[0]!;
  a.morphology = morph({ caution: 0.05 }); a.habituation = 0.9;
  for (const tile of w.tiles) if (Math.max(Math.abs(tile.x), Math.abs(tile.y)) === 2) tile.terrain = 'shelter';
  for (let i = 0; i < 120; i++) {
    runAnimals(w, 1);
    assert.ok(Math.abs(a.x) < 2 && Math.abs(a.y) < 2);
  }
});

test('V23: tending pays six ticks, transfers renewable food/fiber, preserves the animal, shares its cooldown', () => {
  const { w, prey } = hunterWorld(), p = w.people[0]!;
  Object.assign(prey, { energy: 0.5, hunger: 0.2, fatigue: 0.7, habituation: 0.9, morphology: morph({ caution: 0.05 }) });
  // Adjacent calm animal; the person forages on a tile that still has plants.
  const at = w.tiles.find(t => t.x === prey.x - 1 && t.y === prey.y && t.terrain !== 'water')!;
  assert.ok(at); at.food = 0.8;
  Object.assign(p, { x: at.x, y: at.y, target: { x: at.x, y: at.y }, action: 'forage', inventory: 0, hunger: 0.4 });
  delete p.huntingPreyId;
  const before = prey.hunger;
  for (let i = 0; i < 5; i++) stepWorld(w);
  assert.equal(prey.tends, undefined); assert.equal(p.inventory, 0);
  stepWorld(w);
  assert.equal(prey.tends, 1); assert.ok(w.animals.includes(prey));
  assert.equal(w.animalDynamics.humanHunts, 0); assert.ok(p.inventory >= 0.08);
  assert.ok(prey.hunger > before, 'food/fiber debit the living body');
  assert.ok(prey.habituation! >= 0.9);
  const fiber = p.compounds!.find(l => l.formulaId.startsWith('bio:'))!;
  assert.ok(fiber.composition.C > 0 && fiber.composition.H > 0);
  assert.equal(fiber.composition.Fe, 0); assert.equal(fiber.composition.Si, 0);
  assertCompoundLots(p.compounds);
  for (let i = 0; i < 12; i++) stepWorld(w);
  assert.equal(prey.tends, 1);
});

test('V23: la fauna numerosa reproduce la trayectoria con semilla fija y un hilo', () => {
  for (const enabled of [false, true]) {
    const base = createWorld(51926, parseParams(enabled ? OPEN + ',motor.hilos=1' : 'motor.hilos=1', DEFAULT_PARAMS));
    const template = base.animals[0]!;
    const land = base.tiles.filter(t => t.terrain !== 'water' && t.terrain !== 'shelter' && (t.x + t.y) % 2 === 0);
    base.animals = land.slice(0, 400).map((t, i) => ({ ...structuredClone(template), id: `animal-parity-${String(i).padStart(4, '0')}`, x: t.x, y: t.y,
      target: { x: t.x, y: t.y }, ...(enabled ? { morphology: morph(), habituation: i % 2 ? 0.8 : 0 } : {}) }));
    assert.equal(base.animals.length, 400);
    syncFauna(base.tiles, base.animals);
    const primero = cloneWorld(base), segundo = cloneWorld(base);
    for (let tick = 0; tick < 40; tick++) { stepWorld(primero); stepWorld(segundo); }
    assert.equal(digestoCanonico(primero), digestoCanonico(segundo));
    assert.deepEqual(primero.animals, segundo.animals);
    assertWorld(primero); assertWorld(segundo);
  }
});

test('V23: la fauna con parámetros históricos conserva la morfología opcional', () => {
  for (const seed of [51926, 7]) {
    const w = createWorld(seed);
    for (let i = 0; i < 240; i++) stepWorld(w);
    assert.ok(w.animals.length > 0);
    assert.ok(w.animals.every(a => a.morphology === undefined && a.habituation === undefined && a.tends === undefined));
  }
});

test('V23: projection exposes detached traits and material craft fields; validation rejects malformed traits and accepts legacy', () => {
  const w = createWorld(51926), a = w.animals[0]!, p = w.people[0]!;
  assert.doesNotThrow(() => assertAnimal(a, w.tick));
  a.morphology = morph(); a.habituation = 0.6; a.tends = 2;
  const composition = { C: 0.56, H: 0.34, Ca: 0.06, S: 0.04, Si: 0, Fe: 0 };
  p.compounds = [{ id: 'fiber', formulaId: 'fiber', composition, mass: 1, phase: 'raw', properties: evaluateMaterialProperties(composition, 'raw') }];
  const view = projectWorld(w, { x: -16, y: -16, width: 96, height: 64 });
  const av = view.animals!.find(v => v.id === a.id)!;
  assert.deepEqual(av.morphology, a.morphology); assert.equal(av.habituation, 0.6); assert.equal(av.tends, 2);
  assert.notEqual(av.morphology, a.morphology);
  const pv = view.people.find(v => v.id === p.id)!;
  assert.equal(pv.craftTint, p.compounds[0]!.properties.colorHex); assert.ok(pv.craftFocus);
  const empty = { ...pv }; delete empty.craftTint; delete empty.craftFocus;
  const plain = structuredClone(p); delete plain.compounds;
  projectCraft(plain, empty); assert.equal(empty.craftTint, undefined);
  const item = rawMaterial('stone'); item.materialTint = '#aa4422';
  Object.assign(item.properties, { hardness: 0.95, toughness: 0.95, edge: 0.95 });
  plain.technology.items.push(item);
  projectCraft(plain, empty);
  assert.equal(empty.craftTint, '#aa4422'); assert.equal(empty.craftFocus, 'cutting');
  assert.equal(projectAnimal(a, 0).tends, 2);
  for (const bad of [NaN, Infinity, -0.01, 1.01, '0.5', null]) {
    assert.throws(() => assertAnimalTraits({ morphology: { ...morph(), coat: bad } }, 0));
    assert.throws(() => assertAnimalTraits({ habituation: bad }, 0));
  }
  for (const bad of [-1, 0.5, NaN, Infinity, '1']) assert.throws(() => assertAnimalTraits({ tends: bad }, 0));
  assert.throws(() => assertAnimalTraits({ morphology: null }, 0));
  assert.throws(() => assertAnimalTraits({ morphology: { ...morph(), extra: 0 } }, 0));
  assert.throws(() => assertAnimalTraits({ lastTended: 1 }, 0));
  assert.doesNotThrow(() => assertAnimalTraits({}, 0));
  a.habituation = NaN; assert.throws(() => assertAnimal(a, 0));
});
