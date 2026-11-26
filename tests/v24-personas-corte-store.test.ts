import assert from 'node:assert/strict';
import test from 'node:test';
import { preparePackedPerson } from '../src/server/snapshot-packed-people.js';
import type { Store } from '../src/server/store.js';
import { cloneWorld, createWorld, type Person, type World } from '../src/world/index.js';
import { crearCorteGuardado } from '../src/world/motor/corte-sellado.js';
import { vincularPersonasVerificadas } from '../src/world/motor/personas-corte.js';
import { parseParams } from '../src/world/params.js';
import { founderPolicy } from '../src/world/politica.js';
import { researchTechnology } from '../src/world/technology.js';
import { enableTechnologyCatalogue } from '../src/world/technology-catalogue.js';
import { PROGRAMA_FILO, proyectoInvestigacion } from './lib/escenas.js';
import { filaInstantanea, laboratorio } from './lib/store.js';

const params = parseParams('v23.guardadoCompleto=true');
const opciones = { snapshotPackedPeople: true };
const sucias = [4, 8, 10];
const notaCambiada = 'ñ'.repeat(1152 * 1024);

function mundoPaginado(): World {
  const world = createWorld(42, params);
  enableTechnologyCatalogue(world.technology);
  Object.assign(world.people[2]!, { nota: 'a'.repeat(2 * 1024 * 1024) });
  Object.assign(world.people[12]!, { nota: 'b'.repeat(1024 * 1024) });
  Object.assign(world.people[15]!, { nota: 'c'.repeat(768 * 1024) });
  world.people[2]!.inventory = -0;
  for (const i of [5, 10]) world.people[i]!.policy = founderPolicy(world.seed, world.people[i]!.id);
  world.people[5]!.policy!.weights[0] = -0;
  world.people[10]!.policy!.weights[0] = 0;
  return world;
}

function vincular(world: World, rangos: readonly (readonly [number, number])[], modificadas: readonly number[] = []): void {
  vincularPersonasVerificadas(world.people, {
    tramos: rangos.map(([desde, fin]) => ({ desde, filas: world.people.slice(desde, fin).map(
      persona => preparePackedPerson(persona as Person & Record<string, unknown>)) })),
    modificadas: new Set(modificadas.map(i => world.people[i]!)),
  });
}

function editar(world: World): void {
  // Aumenta una fila probada hasta mover el límite de página al interior del primer tramo.
  Object.assign(world.people[4]!, { nota: notaCambiada });
  world.people[8]!.inventory = 0.173;
  world.people[10]!.policy!.weights[0] = -0;
}

function assertMismasPaginas(store: Store, control: Store): void {
  assert.deepEqual(filaInstantanea(store), filaInstantanea(control));
  const sql = 'SELECT digest, typeof(body) AS tipo, hex(CAST(body AS BLOB)) AS bytes FROM snapshot_parts ORDER BY digest';
  const partes = store.db.prepare(sql).all(), esperadas = control.db.prepare(sql).all();
  assert.equal(partes.length, esperadas.length);
  for (const [i, parte] of partes.entries()) {
    assert.equal(parte.digest, esperadas[i]!.digest);
    assert.equal(parte.tipo, esperadas[i]!.tipo);
    assert.ok(parte.bytes === esperadas[i]!.bytes, `Bytes de ${parte.digest}`);
  }
  assert.equal(store.lastSnapshotBytes, control.lastSnapshotBytes);
}

test('el corte sellado conserva todos los bytes WPF1 al repaginar tramos con huecos y filas sucias', t => {
  const { store } = laboratorio(t, 'atlas-personas-selladas-', opciones);
  const { store: control } = laboratorio(t, 'atlas-personas-canonicas-', opciones);
  const world = mundoPaginado(), canonico = cloneWorld(world);
  const rangos = [[2, 8], [10, 15]] as const;
  const sello = crearCorteGuardado(() => {
    vincular(world, rangos, sucias);
    editar(world);
    return { world, materia: null };
  });
  editar(canonico);
  control.guardar({ world: canonico, materia: null });
  const instantanea = store.guardarCorteSellado(sello, [], []);

  assertMismasPaginas(store, control);
  const { snapshotEncoding, people } = JSON.parse(filaInstantanea(store).body);
  assert.equal(snapshotEncoding, 'snapshot-parts-v3');
  assert.deepEqual(people.pages.map(({ count }: { count: number }) => count), [4, 11, 1]);
  const stats = { reused: 9, recoded: 2 };
  assert.deepEqual(store.snapshotPersonasCorteStats, stats);
  assert.throws(() => store.guardarCorteSellado(sello, [], []), /ya consumido/);

  const leido = store.cargarGuardadoCompleto()!.instantanea.world;
  assert.ok(Object.is(leido.people[2]!.inventory, -0));
  for (const i of [5, 10]) assert.ok(Object.is(leido.people[i]!.policy!.weights[0], -0));
  assert.equal(leido.people[8]!.inventory, 0.173);

  const invalido = crearCorteGuardado(() => {
    vincular(world, rangos, [5]);
    world.people[5]!.energy = -1;
    return instantanea;
  });
  assert.throws(() => store.guardarCorteSellado(invalido, [], []), /Estado del mundo inválido/);
  assertMismasPaginas(store, control);

  world.people[5]!.energy = canonico.people[5]!.energy;
  vincular(world, rangos);
  world.people[2]!.inventory = canonico.people[2]!.inventory = 0.157;
  store.guardar(instantanea);
  control.guardar({ world: canonico, materia: null });
  assertMismasPaginas(store, control);
  assert.deepEqual(store.snapshotPersonasCorteStats, stats);
});

test('adoptar un catálogo tecnológico descarta la prueba WPF1 anterior al cambio de memoria', t => {
  const { store } = laboratorio(t, 'atlas-personas-adopcion-', opciones);
  const { store: control } = laboratorio(t, 'atlas-personas-adopcion-canonica-', opciones);
  const world = createWorld(51926, params);
  const artesana = world.people[2]!, vecina = world.people[3]!;
  artesana.materials.stone = 8;
  artesana.energy = 1;
  artesana.fatigue = 0.1;
  artesana.technology.project = proyectoInvestigacion(PROGRAMA_FILO, world.tick);
  for (let n = 0; n < 100 && artesana.technology.project; n++) {
    world.tick++;
    for (const persona of world.people) persona.demography.age++;
    researchTechnology(world, artesana);
  }
  assert.equal(world.technology.catalogue, undefined);
  const receta = world.technology.recipes[0]!.id;
  vecina.technology.competence[receta] = { attempts: 1, successes: 0, work: 1, benefit: 0 };
  const canonico = cloneWorld(world);

  const sello = crearCorteGuardado(() => {
    vincular(world, [[2, 4]]);
    return { world, materia: null };
  });
  control.guardar({ world: canonico, materia: null });
  store.guardarCorteSellado(sello, [], []);

  assertMismasPaginas(store, control);
  assert.equal(vecina.technology.competence[receta], undefined);
  assert.deepEqual(store.snapshotPersonasCorteStats, { reused: 0, recoded: 0 });
});
