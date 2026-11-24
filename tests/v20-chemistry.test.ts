import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ELEMENTS, emptyVector, normalizeVector, vectorMass,
} from '../src/shared/chemistry.js';
import type { CompoundLot, ElementVector } from '../src/shared/chemistry.js';
import {
  MAX_FORMULAS, MAX_PERSON_COMPOUNDS, applyChemOperator, assertChemistryState, assertCompoundLots, availableKilnTier,
  blendMaterialProfile, compoundToolBonus, defaultChemistryState, ensureChemistryState, extractGeologyLot,
  formulaSignature, performChemistryExperiment, projectChemistry,
} from '../src/world/chemistry.js';
import type { ChemistryState } from '../src/world/chemistry.js';

const SEED = 4821;
const EPS = 1e-9;

function massOf(v: ElementVector | undefined): number { return v ? vectorMass(v) : 0; }

/** Conservación elemento a elemento: entrada = producto + byproduct (+ H evaporado en H). */
function assertConserved(inputs: CompoundLot[], result: { product: CompoundLot; byproduct?: ElementVector; evaporatedH: number }): void {
  const input = emptyVector();
  for (const lot of inputs) for (const e of ELEMENTS) input[e] += lot.composition[e];
  for (const e of ELEMENTS) {
    const out = result.product.composition[e] + (result.byproduct?.[e] ?? 0) + (e === 'H' ? result.evaporatedH : 0);
    assert.ok(Math.abs(input[e] - out) <= EPS, `elemento ${e}: entrada ${input[e]} ≠ salida ${out}`);
  }
  const total = inputs.reduce((s, lot) => s + lot.mass, 0);
  assert.ok(Math.abs(total - (result.product.mass + massOf(result.byproduct) + result.evaporatedH)) <= EPS);
  assert.ok(Math.abs(result.product.mass - vectorMass(result.product.composition)) <= EPS);
  for (const e of ELEMENTS) {
    assert.ok(result.product.composition[e] >= 0);
    assert.ok((result.byproduct?.[e] ?? 0) >= 0);
  }
}

function hex(color: string): [number, number, number] {
  return [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)];
}

const insulatedKiln = { components: ['frame', 'frame', 'roof', 'hearth'], condition: 0.9, water: 0 };
const simpleHearth = { components: ['hearth'], condition: 0.9, water: 0 };

test('V20 química: los 4 operadores conservan la masa elemental exacta', () => {
  const st = defaultChemistryState();
  const wood = extractGeologyLot(SEED, 0, 0, 'forest', 'tree', 1, st);
  const rock = extractGeologyLot(SEED, 4, 9, 'mountain', 'rock', 1, st);
  const clay = extractGeologyLot(SEED, 3, 3, 'wetland', 'clay', 1, st);
  const sand = extractGeologyLot(SEED, 5, 5, 'desert', undefined, 1, st);
  assert.ok(Math.abs(wood.mass - 1) <= EPS && wood.phase === 'raw');

  const ground = applyChemOperator('grind', rock, { temperatureTier: 0 }, st);
  assertConserved([rock], ground);
  assert.equal(ground.product.phase, 'ground');
  assert.deepEqual(ground.product.composition, rock.composition);
  assert.equal(ground.byproduct, undefined);
  assert.equal(ground.evaporatedH, 0);

  const washed = applyChemOperator('wash', clay, { temperatureTier: 0, waterAvailable: 0.5 }, st);
  assertConserved([clay], washed);
  assert.equal(washed.product.phase, 'washed');
  assert.equal(washed.waterConsumed, 0.02);
  assert.ok(Math.abs(washed.byproduct!.S - clay.composition.S * 0.65) <= EPS);
  assert.ok(Math.abs(washed.byproduct!.H - clay.composition.H * 0.5) <= EPS);
  const nClay = normalizeVector(clay.composition), nWashed = normalizeVector(washed.product.composition);
  for (const e of ['Fe', 'Si', 'Ca'] as const) assert.ok(nWashed[e] > nClay[e], `${e} se concentra al lavar`);
  assert.throws(() => applyChemOperator('wash', clay, { temperatureTier: 0, waterAvailable: 0.01 }, st), /agua/);
  assert.throws(() => applyChemOperator('wash', clay, { temperatureTier: 0 }, st), /agua/);

  const t1 = applyChemOperator('heat', wood, { temperatureTier: 1 }, st);
  assertConserved([wood], t1);
  assert.ok(Math.abs(t1.evaporatedH - wood.composition.H * 0.85) <= EPS);
  assert.throws(() => applyChemOperator('heat', wood, { temperatureTier: 0 }, st), /temperatureTier/);

  const t2 = applyChemOperator('heat', rock, { b: t1.product, temperatureTier: 2 }, st);
  assertConserved([rock, t1.product], t2);
  assert.equal(t2.product.phase, 'smelted');
  assert.ok(t2.byproduct!.Si > 0 && t2.byproduct!.C > 0);

  const t2Glass = applyChemOperator('heat', sand, { temperatureTier: 2 }, st);
  assertConserved([sand], t2Glass);
  assert.ok(Math.abs(t2Glass.evaporatedH - sand.composition.H * 0.98) <= EPS);

  const bound = applyChemOperator('bind', t2.product, { b: t2Glass.product, temperatureTier: 0 }, st);
  assertConserved([t2.product, t2Glass.product], bound);
  for (const e of ELEMENTS) assert.equal(bound.product.composition[e], t2.product.composition[e] + t2Glass.product.composition[e]);
  assert.equal(bound.product.phase, 'smelted', 'la fase es la del padre más procesado');
  assert.throws(() => applyChemOperator('bind', rock, { temperatureTier: 0 }, st), /segundo lote/);
  assert.throws(() => applyChemOperator('bind', rock, { b: rock, temperatureTier: 0 }, st), /consigo mismo/);

  assert.deepEqual(st.byOperator, { grind: 1, wash: 1, heat: 3, bind: 1 });
  assert.equal(st.maxTemperatureTier, 2);
  assertChemistryState(st, 0);
  assertCompoundLots([wood, rock, clay, sand, ground.product, washed.product, t1.product, t2.product, t2Glass.product, bound.product]);
});

test('V20 química: cadena emergente madera → carbón → horno T2 → compuesto metálico fundido', () => {
  const st = defaultChemistryState();
  const wood = extractGeologyLot(SEED, 0, 0, 'forest', 'tree', 1, st);
  assert.ok(normalizeVector(wood.composition).C >= 0.45, 'la madera del bosque es carbono dominante');

  // Sin combustible denso, el mejor horno aislado sólo llega a T1.
  assert.equal(availableKilnTier({}, []), 0);
  assert.equal(availableKilnTier({ compounds: [wood] }, [insulatedKiln]), 1);
  assert.equal(availableKilnTier({}, [{ ...insulatedKiln, condition: 0.05 }]), 0, 'un hogar roto no calienta');

  const charcoal = applyChemOperator('heat', wood, { temperatureTier: 1, tick: 10, actorId: 'p1' }, st);
  assert.equal(charcoal.product.phase, 'fired');
  assert.ok(charcoal.product.properties.fuelPower >= 0.65, `poder calorífico ${charcoal.product.properties.fuelPower}`);
  assert.ok(charcoal.formula.name.startsWith('Carbón'), charcoal.formula.name);
  assert.equal(charcoal.formula.discovererId, 'p1');
  assert.equal(charcoal.formula.discoveredAt, 10);
  assert.equal(charcoal.temperatureTier, 1);

  // El carbón habilita T2 en un horno aislado (techo + 2 armazones), en uno con aislamiento instalado
  // o con dos hogares; un hogar simple sin techo sigue en T1.
  assert.equal(availableKilnTier({ compounds: [charcoal.product] }, [insulatedKiln]), 2);
  assert.equal(availableKilnTier({}, [{ ...insulatedKiln, storedCompounds: [charcoal.product] }]), 2);
  assert.equal(availableKilnTier({ compounds: [charcoal.product] }, [{ components: ['roof', 'hearth'], condition: 1, installed: [{ insulation: 0.2 }, { insulation: 0.2 }] }]), 2);
  assert.equal(availableKilnTier({ compounds: [charcoal.product] }, [{ components: ['roof', 'hearth'], condition: 1, installed: [{ insulation: 0.2 }] }]), 1);
  assert.equal(availableKilnTier({ compounds: [charcoal.product] }, [{ components: ['roof', 'hearth', 'hearth'], condition: 1 }]), 2);
  assert.equal(availableKilnTier({ compounds: [charcoal.product] }, [simpleHearth]), 1);

  const rock = extractGeologyLot(SEED, 4, 9, 'mountain', 'rock', 1, st);
  const nRock = normalizeVector(rock.composition);
  assert.ok(nRock.Fe >= 0.22 && nRock.Si >= 0.3, 'roca de montaña: sílice + hierro');
  // La roca sola en T2 (sin carbono) no se reduce.
  assert.equal(applyChemOperator('heat', rock, { temperatureTier: 2 }, st).product.phase, 'fired');

  const metal = applyChemOperator('heat', rock, { b: charcoal.product, temperatureTier: 2 }, st);
  assert.equal(metal.product.phase, 'smelted');
  assert.ok(metal.product.properties.hardness >= 0.70, `dureza ${metal.product.properties.hardness}`);
  assert.ok(metal.product.properties.toughness >= 0.65, `tenacidad ${metal.product.properties.toughness}`);
  assert.ok(normalizeVector(metal.product.composition).Fe > normalizeVector(addLots(rock, charcoal.product)).Fe, 'el Fe se concentra');
  assert.match(metal.formula.name, /fundido$/);
  assert.equal(metal.temperatureTier, 2);
  assert.equal(st.maxTemperatureTier, 2);
});

function addLots(a: CompoundLot, b: CompoundLot): ElementVector {
  const v = emptyVector();
  for (const e of ELEMENTS) v[e] = a.composition[e] + b.composition[e];
  return v;
}

test('V20 química: arcilla de humedal → cerámica sellante; sílice salina del desierto → vítreo', () => {
  const st = defaultChemistryState();
  const clay = extractGeologyLot(SEED, 3, 3, 'wetland', 'clay', 1, st);
  const n = normalizeVector(clay.composition);
  assert.ok(n.Ca + n.Si >= 0.45 && n.H >= 0.15, 'arcilla: Ca + Si + H');
  const ceramic = applyChemOperator('heat', clay, { temperatureTier: 1 }, st);
  assert.equal(ceramic.product.phase, 'fired');
  assert.ok(ceramic.product.properties.seal >= 0.6, `sello ${ceramic.product.properties.seal}`);
  assert.ok(ceramic.product.properties.insulation >= 0.45, `aislamiento ${ceramic.product.properties.insulation}`);
  assert.ok(ceramic.product.properties.seal > clay.properties.seal);
  const [r, g, b] = hex(ceramic.product.properties.colorHex);
  assert.ok(r > g && g > b && r - b >= 60, `tinte terracota ${ceramic.product.properties.colorHex}`);

  const sand = extractGeologyLot(SEED, 5, 5, 'desert', undefined, 1, st);
  const ns = normalizeVector(sand.composition);
  assert.ok(ns.Si >= 0.35 && ns.S >= 0.16);
  assert.equal(applyChemOperator('heat', sand, { temperatureTier: 1 }, st).product.phase, 'fired', 'en T1 la sílice no vitrifica');
  const glass = applyChemOperator('heat', sand, { temperatureTier: 2 }, st);
  assert.equal(glass.product.phase, 'vitrified');
  assert.ok(glass.product.properties.seal >= 0.75, `sello ${glass.product.properties.seal}`);
  assert.ok(glass.product.properties.hardness >= 0.6);
  assert.match(glass.formula.name, /vítreo/);
});

test('V20 química: firmas cuantizadas reutilizan fórmulas, nombres sin lista fija y tope acotado', () => {
  const st = defaultChemistryState();
  const a = extractGeologyLot(SEED, 0, 0, 'forest', 'tree', 1, st);
  const b = extractGeologyLot(SEED, 0, 0, 'forest', 'tree', 2, st); // misma mezcla, otra masa
  const first = applyChemOperator('heat', a, { temperatureTier: 1 }, st);
  const second = applyChemOperator('heat', b, { temperatureTier: 1 }, st);
  assert.equal(first.isNew, true);
  assert.equal(second.isNew, false);
  assert.equal(second.formula.id, first.formula.id);
  assert.equal(first.formula.uses, 2);
  assert.equal(formulaSignature('fired', first.product.composition), formulaSignature('fired', second.product.composition));
  // Misma composición, otra fase → otra fórmula.
  const ground = applyChemOperator('grind', a, { temperatureTier: 0 }, st);
  assert.equal(ground.isNew, true);
  assert.notEqual(ground.formula.id, first.formula.id);
  for (const f of st.formulas) assert.doesNotMatch(f.name.toLowerCase(), /hierro|ladrillo|vidrio|bronce|acero|cal viva/);
  // (comprobado abajo, con el registro lleno) los nombres son únicos por fórmula.

  // Tope: más mezclas que MAX_FORMULAS nunca hinchan el registro.
  const biomes = ['forest', 'mountain', 'wetland', 'desert', 'grassland', 'ocean'];
  const features = [undefined, 'rock', 'clay', 'tree', 'spring', 'reeds', 'cactus'];
  let lot: CompoundLot | undefined;
  outer: for (let x = 0; x < 400; x += 7) for (const biome of biomes) for (const feature of features) {
    const raw = extractGeologyLot(SEED, x, x * 3, biome, feature, 1, st);
    const fired = applyChemOperator('heat', raw, { temperatureTier: 1 }, st).product;
    lot = lot ? applyChemOperator('bind', lot, { b: fired, temperatureTier: 0 }, st).product : fired;
    applyChemOperator('wash', raw, { temperatureTier: 0, waterAvailable: 1 }, st);
    if (st.formulas.length >= MAX_FORMULAS && x > 300) break outer;
  }
  assert.equal(st.formulas.length, MAX_FORMULAS);
  assertChemistryState(st, 0);
  assert.equal(new Set(st.formulas.map(f => f.name)).size, st.formulas.length, 'nombres únicos (variantes numeradas)');
  for (const f of st.formulas) assert.doesNotMatch(f.name.toLowerCase(), /hierro|ladrillo|vidrio|bronce|acero/);
  const beyond = applyChemOperator('heat', extractGeologyLot(SEED, 999, 13, 'ocean', 'spring', 1, st), { temperatureTier: 2 }, st);
  assert.equal(beyond.isNew, false);
  assert.equal(st.formulas.length, MAX_FORMULAS);
  assert.ok(st.formulas.some(f => f.id === beyond.formula.id));
});

test('V20 química: ensureChemistryState solo crea estado con quimica.emergente', () => {
  const off: { chemistry?: ChemistryState; params: { quimica: { emergente: boolean } } } = { params: { quimica: { emergente: false } } };
  const loose = ensureChemistryState(off);
  assert.deepEqual(loose, defaultChemistryState());
  assert.equal('chemistry' in off, false, 'un mundo apagado no gana campos');
  const legacy: { chemistry?: ChemistryState } = {};
  ensureChemistryState(legacy);
  assert.equal('chemistry' in legacy, false);
  const on: { chemistry?: ChemistryState; params: { quimica: { emergente: boolean } } } = { params: { quimica: { emergente: true } } };
  const state = ensureChemistryState(on);
  assert.equal(on.chemistry, state);
  assert.equal(ensureChemistryState(on), state);
  // Experimento en mundo apagado: nulo y sin estado.
  const world = { seed: SEED, tick: 5, rng: 77, params: { quimica: { emergente: false } } } as { seed: number; tick: number; rng: number; chemistry?: ChemistryState; params: { quimica: { emergente: boolean } } };
  const person = { id: 'p1', x: 0, y: 0, materials: { wood: 3, stone: 3 } };
  assert.equal(performChemistryExperiment(world, person, { x: 0, y: 0, biome: 'forest', feature: 'tree' }, []), null);
  assert.equal('chemistry' in world, false);
  assert.deepEqual(person.materials, { wood: 3, stone: 3 });
});

function runColony(seed: number, ticks: number) {
  const world: { seed: number; tick: number; rng: number; chemistry?: ChemistryState; params: { quimica: { emergente: boolean } } } = { seed, tick: 0, rng: 123456789, params: { quimica: { emergente: true } } };
  const kiln = { components: ['frame', 'frame', 'roof', 'hearth', 'cistern'] as string[], condition: 0.95, water: 0.6 };
  const people = [
    { id: 'h1', x: 0, y: 0, materials: { wood: 30, stone: 0 }, compounds: undefined as CompoundLot[] | undefined, skills: { craft: 0.5 } },
    { id: 'h2', x: 0, y: 0, materials: { wood: 10, stone: 30 }, compounds: undefined as CompoundLot[] | undefined },
  ];
  const tiles = [
    { x: 0, y: 0, biome: 'forest', feature: 'tree', drinkingWater: 0.3 },
    { x: 4, y: 9, biome: 'mountain', feature: 'rock', stone: 1, drinkingWater: 0 },
  ];
  let extracted = 0, lost = 0, water = 0, results = 0;
  const log: string[] = [];
  for (; world.tick < ticks; world.tick++) {
    for (let i = 0; i < people.length; i++) {
      const r = performChemistryExperiment(world, people[i]!, tiles[i]!, [kiln]);
      if (!r) continue;
      results++;
      extracted += r.extractedMass;
      lost += massOf(r.byproduct) + r.evaporatedH;
      water += r.waterUsed;
      log.push(`${world.tick}:${people[i]!.id}:${r.operator}:${r.temperatureTier}:${r.formula.id}:${r.lot.id}`);
    }
    // Intercambio (fuera del motor, conserva la masa): el carbonero pasa un lote de combustible al minero.
    const [h1, h2] = people as [typeof people[0], typeof people[0]];
    const fuel = h1.compounds?.find(l => l.properties.fuelPower >= 0.65);
    if (fuel && !(h2.compounds ?? []).some(l => l.properties.fuelPower >= 0.6) && (h2.compounds?.length ?? 0) < MAX_PERSON_COMPOUNDS) {
      h1.compounds = h1.compounds!.filter(l => l !== fuel);
      (h2.compounds ??= []).push(fuel);
    }
  }
  return { world, people, tiles, kiln, extracted, lost, water, results, log };
}

test('V20 química: experimentos autónomos deterministas, conservativos, acotados y sin tocar world.rng', () => {
  const a = runColony(SEED, 120);
  const b = runColony(SEED, 120);
  assert.deepEqual(a.log, b.log, 'misma semilla → misma secuencia');
  assert.deepEqual(a.world.chemistry, b.world.chemistry);
  assert.equal(a.world.rng, 123456789, 'world.rng intacto');
  assert.ok(a.results > 0);

  // Balance global: masa extraída = masa en inventarios + masa expulsada (escoria, gas, lavado, H).
  const carried = a.people.reduce((s, p) => s + (p.compounds ?? []).reduce((t, lot) => t + lot.mass, 0), 0);
  assert.ok(Math.abs(a.extracted - (carried + a.lost)) <= 1e-9, `extraído ${a.extracted} ≠ ${carried} + ${a.lost}`);
  // Cada extracción pagó una unidad real de madera o piedra.
  const debited = (30 - a.people[0]!.materials.wood) + (10 - a.people[1]!.materials.wood) + (30 - a.people[1]!.materials.stone);
  assert.ok(Math.abs(debited - a.extracted) <= 1e-9);
  // El agua de lavado sale de la cisterna o de la tesela.
  assert.ok(Math.abs((0.6 - a.kiln.water) + (0.3 - a.tiles[0]!.drinkingWater) + (0 - a.tiles[1]!.drinkingWater) - a.water) <= 1e-9);

  for (const p of a.people) {
    assert.ok((p.compounds?.length ?? 0) <= MAX_PERSON_COMPOUNDS);
    assertCompoundLots(p.compounds);
  }
  assertChemistryState(a.world.chemistry, a.world.tick);
  const st = a.world.chemistry!;
  assert.ok(st.byOperator.heat > 0 && st.byOperator.grind > 0);
  // La colonia descubre por sí sola el carbón y, con él, el horno T2 y los compuestos fundidos.
  assert.equal(st.maxTemperatureTier, 2);
  assert.ok(st.formulas.some(f => f.phase === 'smelted'), 'fundición emergente');
  assert.ok(st.formulas.some(f => f.properties.fuelPower >= 0.65), 'combustible emergente');

  const c = runColony(SEED + 1, 120);
  assert.notDeepEqual(c.log, a.log, 'otra semilla → otra historia');
});

test('V20 química: el inventario desbordado se aglomera sin perder masa', () => {
  const world: { seed: number; tick: number; chemistry?: ChemistryState } = { seed: SEED, tick: 3 };
  const st = (world.chemistry = defaultChemistryState());
  const compounds: CompoundLot[] = [];
  for (let i = 0; i < MAX_PERSON_COMPOUNDS + 2; i++) {
    const raw = extractGeologyLot(SEED, i, 2 * i, i % 2 ? 'desert' : 'grassland', undefined, 1, st);
    compounds.push(applyChemOperator('heat', raw, { temperatureTier: 1 }, st).product);
  }
  const before = compounds.reduce((t, lot) => t + lot.mass, 0);
  const person = { id: 'p9', x: 0, y: 0, materials: { wood: 0, stone: 0 }, compounds };
  const bindsBefore = st.byOperator.bind;
  const r = performChemistryExperiment(world, person, { x: 0, y: 0, biome: 'grassland' }, [simpleHearth])!;
  assert.ok(r);
  assert.equal(person.compounds.length, MAX_PERSON_COMPOUNDS);
  assert.ok(person.compounds.includes(r.lot), 'el producto del experimento se conserva');
  const after = person.compounds.reduce((t, lot) => t + lot.mass, 0);
  assert.ok(Math.abs(before - (after + massOf(r.byproduct) + r.evaporatedH)) <= 1e-9);
  assert.ok(st.byOperator.bind > bindsBefore);
  assertCompoundLots(person.compounds);
});

test('V20 química: assertChemistryState / assertCompoundLots rechazan cargas corruptas', () => {
  const st = defaultChemistryState();
  const wood = extractGeologyLot(SEED, 0, 0, 'forest', 'tree', 1, st);
  const fired = applyChemOperator('heat', wood, { temperatureTier: 1, tick: 7 }, st);
  assertChemistryState(st, 7);
  assertCompoundLots([wood, fired.product]);
  assertCompoundLots(undefined);
  assert.throws(() => assertChemistryState(st, 6), /discoveredAt/);

  const bad = (mutate: (s: ChemistryState) => void): void => {
    const copy = structuredClone(st); mutate(copy);
    assert.throws(() => assertChemistryState(copy, 100));
  };
  bad(s => { s.formulaCounter = Number.NaN; });
  bad(s => { s.lotCounter = -1; });
  bad(s => { s.byOperator.heat = 1.5; });
  bad(s => { (s.byOperator as Record<string, number>).melt = 0; });
  bad(s => { s.maxTemperatureTier = 3 as 2; });
  bad(s => { s.formulas[0]!.composition.Fe = -0.1; });
  bad(s => { s.formulas[0]!.composition.C = Number.NaN; });
  bad(s => { s.formulas[0]!.properties.seal = 1.2; });
  bad(s => { s.formulas[0]!.phase = 'plasma' as 'raw'; });
  bad(s => { s.formulas[0]!.operator = 'melt' as 'heat'; });
  bad(s => { s.formulas.push({ ...s.formulas[0]!, id: 'F99' }); s.formulaCounter = 99; });
  bad(s => { s.formulaCounter = 0; });
  assert.throws(() => assertChemistryState(null, 0));
  assert.throws(() => assertChemistryState({ ...st, formulas: 'x' }, 0));

  const badLot = (mutate: (l: CompoundLot) => void): void => {
    const copy = structuredClone(fired.product); mutate(copy);
    assert.throws(() => assertCompoundLots([copy]));
  };
  badLot(l => { l.mass = Number.NaN; });
  badLot(l => { l.mass = -1; });
  badLot(l => { l.mass += 0.5; });
  badLot(l => { l.composition.S = -0.01; });
  badLot(l => { l.composition.H = Number.POSITIVE_INFINITY; });
  badLot(l => { delete (l.composition as Partial<ElementVector>).Ca; });
  badLot(l => { l.properties.hardness = Number.NaN; });
  badLot(l => { l.properties.colorHex = 'red'; });
  badLot(l => { l.id = ''; });
  badLot(l => { l.phase = 'gas' as 'raw'; });
  assert.throws(() => assertCompoundLots([wood, wood]), /duplicado/);
  assert.throws(() => assertCompoundLots({}));
  assert.throws(() => extractGeologyLot(SEED, 0, 0, 'forest', 'tree', Number.NaN, st));
  assert.throws(() => extractGeologyLot(SEED, 0, 0, 'forest', 'tree', -1, st));
});

test('V20 química: perfil material, bono de herramienta y proyección', () => {
  const st = defaultChemistryState();
  const wood = extractGeologyLot(SEED, 0, 0, 'forest', 'tree', 1, st);
  const charcoal = applyChemOperator('heat', wood, { temperatureTier: 1 }, st).product;
  const rock = extractGeologyLot(SEED, 4, 9, 'mountain', 'rock', 1, st);
  const metal = applyChemOperator('heat', rock, { b: charcoal, temperatureTier: 2 }, st).product;
  const clay = extractGeologyLot(SEED, 3, 3, 'wetland', 'clay', 1, st);
  const ceramic = applyChemOperator('heat', clay, { temperatureTier: 1 }, st).product;

  const first = blendMaterialProfile(undefined, ceramic);
  assert.equal(first.tint, ceramic.properties.colorHex);
  assert.equal(first.seal, ceramic.properties.seal);
  assert.ok(Math.abs(first.strength - (ceramic.properties.hardness + ceramic.properties.toughness) / 2) <= 1e-3);
  const blended = blendMaterialProfile(first, metal, 0.5);
  const metalStrength = (metal.properties.hardness + metal.properties.toughness) / 2;
  assert.ok(Math.abs(blended.strength - (first.strength + metalStrength) / 2) <= 1e-3);
  const [r0, g0, b0] = hex(first.tint), [r1, g1, b1] = hex(metal.properties.colorHex), [rm, gm, bm] = hex(blended.tint);
  assert.ok(Math.abs(rm - (r0 + r1) / 2) <= 1 && Math.abs(gm - (g0 + g1) / 2) <= 1 && Math.abs(bm - (b0 + b1) / 2) <= 1, 'tinte mezclado suave');
  assert.deepEqual(blendMaterialProfile(first, metal, 0), first);
  const light = blendMaterialProfile(first, metal);
  assert.ok(light.strength > first.strength && light.strength < blended.strength, 'peso por defecto parcial');

  assert.equal(compoundToolBonus(undefined, 'cutting'), 0);
  assert.equal(compoundToolBonus([], 'containment'), 0);
  for (const cap of ['cutting', 'abrasion', 'containment', 'insulation'] as const) {
    const v = compoundToolBonus([wood, charcoal, rock, metal, clay, ceramic], cap);
    assert.ok(v >= 0 && v <= 0.45, `${cap} = ${v}`);
  }
  assert.ok(compoundToolBonus([metal], 'cutting') > compoundToolBonus([rock], 'cutting'), 'el metal corta mejor que la roca cruda');
  assert.ok(compoundToolBonus([metal], 'cutting') >= 0.3);
  assert.ok(compoundToolBonus([ceramic], 'containment') > compoundToolBonus([clay], 'containment'));
  assert.ok(compoundToolBonus([ceramic], 'insulation') > 0);
  assert.equal(compoundToolBonus([{ ...metal, mass: 0.01 }], 'cutting'), 0, 'una mota no es herramienta');

  assert.equal(projectChemistry(undefined, [], []), undefined);
  const view = projectChemistry(st, [{ compounds: [metal, ceramic] }, {}], [{ storedCompounds: [charcoal] }, {}])!;
  assert.equal(view.totalFormulas, st.formulas.length);
  assert.equal(view.totalLots, 3);
  assert.equal(view.maxTemperatureTier, 2);
  assert.deepEqual(view.byOperator, st.byOperator);
  assert.equal(view.formulas[0]!.phase, 'smelted', 'lo más avanzado primero');
  view.formulas[0]!.uses = 999; view.byOperator.heat = 999;
  assert.notEqual(st.formulas.find(f => f.id === view.formulas[0]!.id)!.uses, 999, 'la proyección es una copia');
  assert.notEqual(st.byOperator.heat, 999);
});
