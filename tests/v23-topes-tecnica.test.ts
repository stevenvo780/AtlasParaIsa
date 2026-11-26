import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/server/store.js';
import { evaluateMaterialProperties } from '../src/shared/chemistry.js';
import { escalon } from '../src/shared/interruptores.js';
import type { TechnologyRecipe } from '../src/shared/technology.js';
import { defaultChemistryState, formulaSignature } from '../src/world/chemistry.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { leerReceta, registrarReceta } from '../src/world/materia/proceso.js';
import type { Paso } from '../src/world/materia/tipos.js';
import { assertWorld, createWorld } from '../src/world/index.js';
import { parseParams, setParams } from '../src/world/params.js';
import { materialCapacities, programSignature, rawMaterial } from '../src/world/technology.js';

test('la técnica activa conserva 300 recetas y 300 recuerdos al guardar y cargar', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const params = parseParams({ v23: escalon('tecnica') });
  const world = createWorld(7, params), p = world.people[0]!;
  const recipes: TechnologyRecipe[] = Array.from({ length: 300 }, (_, i) => {
    const program: TechnologyRecipe['program'] = {
      inputs: [{ source: 'raw', material: 'water', mass: 30 + i }],
      steps: [{ op: 'cool', intensity: 1 }],
    };
    return { id: `recipe-${i + 1}`, name: `Receta ${i + 1}`, generation: 1, inventorId: p.id, tick: 0, x: p.x, y: p.y,
      program, signature: programSignature(program), parents: [], novelty: i === 0 ? 'both' : 'program',
      uses: 0, utility: 0, manufactured: 0, capacities: materialCapacities(rawMaterial('water', 30 + i)) };
  });
  world.technology.recipes = recipes;
  world.technology.recipeCounter = recipes.length;
  p.technology.knownRecipes = recipes.map(r => r.id);
  store.guardar({ world, materia: null });
  const loaded = store.cargarInstantanea()!.instantanea.world;
  assert.deepEqual(loaded.technology.recipes, recipes);
  assert.deepEqual(loaded.people[0]!.technology.knownRecipes, p.technology.knownRecipes);
  assert.equal(loaded.people[0]!.technology.knownRecipes.length, 300);
  loaded.people[0]!.technology.knownRecipes.push('recipe-301');
  assert.throws(() => assertWorld(loaded), /tecnología física inválido/);
  setParams(world, parseParams({ v23: { tecnica: false } }, params));
  assert.throws(() => assertWorld(world), /tecnología física inválido/);
});

test('la técnica activa conserva 600 fórmulas químicas y rechaza composiciones negativas', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const params = parseParams({ v23: escalon('tecnica') });
  const world = createWorld(7, params);
  const estado = world.chemistry = defaultChemistryState();
  for (let fe = 0; fe <= 20 && estado.formulas.length < 600; fe++) {
    for (let ca = 0; fe + ca <= 20 && estado.formulas.length < 600; ca++) {
      for (let si = 0; fe + ca + si <= 20 && estado.formulas.length < 600; si++) {
        const composition = { C: (20 - fe - ca - si) / 20, Fe: fe / 20, Ca: ca / 20, Si: si / 20, S: 0, H: 0 };
        const phase = 'ground', id = `F${++estado.formulaCounter}`;
        estado.formulas.push({ id, name: id, phase, signature: formulaSignature(phase, composition), composition,
          properties: evaluateMaterialProperties(composition, phase), temperatureTier: 0, operator: 'grind',
          discoveredAt: 0, discovererId: null, uses: 0 });
      }
    }
  }
  store.guardar({ world, materia: null });
  const loaded = store.cargarInstantanea()!.instantanea.world;
  assert.equal(loaded.chemistry!.formulas.length, 600);
  assert.deepEqual(loaded.chemistry, estado);
  loaded.chemistry!.formulas[0]!.composition.C = -1;
  assert.throws(() => assertWorld(loaded), /finito y no negativo/);
  setParams(world, parseParams({ v23: { tecnica: false } }, params));
  assert.throws(() => assertWorld(world), /chemistry.formulas/);
});

test('el registro material recarga 300 recetas de trece pasos sin pasar por los presupuestos del catálogo anterior', async t => {
  const world = createWorld(7, parseParams({ v23: escalon('tecnica') }));
  const motor = crearMotor(world, { hilos: 1, gpu: [], decisionGpu: 'siempre', verificar: false, semilla: 7 });
  t.after(() => motor.cerrar());
  motor.cargar({ world, materia: null }, 0);
  const registro = ctxMateriaDe(world).globales.registro;
  const recetas = Array.from({ length: 300 }, (_, i) => {
    const pasos: Paso[] = Array.from({ length: 13 }, (_, j) => ({ op: 'mojar', hasta: { ticks: i + j + 1 } }));
    return { id: registrarReceta(registro, pasos), pasos };
  });
  assert.equal(new Set(recetas.map(r => r.id)).size, 300);

  const store = new Store(':memory:');
  t.after(() => store.close());
  store.guardar(motor.instantanea());
  const carga = store.cargarInstantanea()!;
  motor.cargar(carga.instantanea, carga.epoca);
  const nuevo = ctxMateriaDe(carga.instantanea.world).globales.registro;
  for (const { id, pasos } of recetas) assert.deepEqual(leerReceta(nuevo, id), pasos);
});
