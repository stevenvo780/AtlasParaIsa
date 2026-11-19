import assert from 'node:assert/strict';
import test from 'node:test';
import type { StructureView } from '../src/shared/life.js';
import type { TechnologyExecution, TechnologyRecipe } from '../src/shared/technology.js';
import type { Chunk } from '../src/world/terrain.js';
import { createWorld, stepWorld } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { identityBaseFromArchive } from '../src/world/inventions.js';
import {
  asignarIdentidades, asignarTransaccionesEjecucion, formatearIdIdentidad, serialDeIdIdentidad,
  type CandidatoIdentidad, type ContadoresIdentidad,
} from '../src/world/paralelo/identidades.js';
import {
  assertTechnology, defaultTechnologyState, initialTechnologyKnowledge, renumberTechnologyTransactionBlocks,
  researchTechnology, type TechnologyActor, type TechnologyHost, type TechnologyProgram,
} from '../src/world/technology.js';
import { renumberTechnologyExecutionBlock, technologyExecutionSerial } from '../src/world/technology-execution.js';
import { assertTechnologyJournal, enableTechnologyJournal } from '../src/world/technology-journal.js';
import { renumberTechnologyRecipes } from '../src/world/technology-catalogue.js';
import { PROGRAMA_FILO as filo, proyectoInvestigacion } from './lib/escenas.js';

const CEROS: ContadoresIdentidad = {
  birthCounter: 0, communityCounter: 0, eventCounter: 0, discoveredChunks: 0, executionCounter: 0,
  itemCounter: 0, recipeCounter: 0, blueprintCounter: 0, structureCounter: 0,
};
const clave = (regionMorton: number, actorSlot: number, secuenciaLocal = 0, tick = 50, fase = 2) =>
  ({ tick, fase, regionMorton, actorSlot, secuenciaLocal });
/** Órdenes de llegada que simulan la entrega de 1, 8 y 28 workers y un adversario. */
const LLEGADAS: Readonly<Record<string, readonly number[]>> = {
  '1 worker (orden total)': [0, 1, 2, 3, 4],
  '8 workers (intercalado)': [2, 4, 1, 3, 0],
  '28 workers (inverso)': [4, 3, 2, 1, 0],
  adversarial: [3, 0, 4, 1, 2],
};
const porReferencia = (candidatos: readonly CandidatoIdentidad[], orden: readonly number[], confirmados: ContadoresIdentidad) => {
  const llegada = orden.map(i => candidatos[i]!);
  const { asignaciones, contadores } = asignarIdentidades(llegada, confirmados);
  return {
    ids: Object.fromEntries(asignaciones.map(a => [a.candidato.referencia, a.id])),
    seriales: Object.fromEntries(asignaciones.map(a => [a.candidato.referencia, a.serial])),
    contadores,
  };
};

test('5 nacimientos simultáneos en 3 regiones dan la misma secuencia exacta con 1, 8, 28 workers y orden adversarial', () => {
  const confirmados = { ...CEROS, birthCounter: 10 };
  const candidatos: CandidatoIdentidad[] = [
    { contador: 'birth', clave: clave(30, 4), referencia: 'este' },
    { contador: 'birth', clave: clave(10, 9), referencia: 'oeste-9' },
    { contador: 'birth', clave: clave(10, 2), referencia: 'oeste-2' },
    { contador: 'birth', clave: clave(20, 1), referencia: 'centro' },
    { contador: 'birth', clave: clave(10, 9, 1), referencia: 'oeste-9-segundo' },
  ];
  const esperado = {
    'oeste-2': 'descendant-11', 'oeste-9': 'descendant-12', 'oeste-9-segundo': 'descendant-13',
    centro: 'descendant-14', este: 'descendant-15',
  };
  for (const [nombre, orden] of Object.entries(LLEGADAS)) {
    const resultado = porReferencia(candidatos, orden, confirmados);
    assert.deepEqual(resultado.ids, esperado, nombre);
    assert.equal(resultado.contadores.birthCounter, 15, nombre);
  }
});

test('los nueve contadores asignan su formato legible desde el valor confirmado', () => {
  const confirmados: ContadoresIdentidad = {
    birthCounter: 10, communityCounter: 3, eventCounter: 40, discoveredChunks: 5, executionCounter: 20,
    itemCounter: 7, recipeCounter: 4, blueprintCounter: 2, structureCounter: 1,
  };
  const candidatos: CandidatoIdentidad[] = [
    { contador: 'structure', clave: clave(1, 1), referencia: 'structure' },
    { contador: 'blueprint', clave: clave(1, 1), referencia: 'blueprint' },
    { contador: 'recipe', clave: clave(1, 1), referencia: 'recipe' },
    { contador: 'item', clave: clave(1, 1), referencia: 'item' },
    { contador: 'execution', clave: clave(1, 1), referencia: 'execution' },
    { contador: 'discovered', clave: clave(1, 1), chunkKey: '9,9', referencia: 'discovered' },
    { contador: 'event', clave: clave(1, 1), referencia: 'event' },
    { contador: 'community', clave: clave(1, 1), referencia: 'community' },
    { contador: 'birth', clave: clave(1, 1), referencia: 'birth' },
  ];
  const { asignaciones, contadores } = asignarIdentidades(candidatos, confirmados);
  const porRef = Object.fromEntries(asignaciones.map(a => [a.candidato.referencia, a]));
  assert.equal(porRef.birth!.id, 'descendant-11');
  assert.equal(porRef.community!.id, 'community-4');
  assert.equal(porRef.event!.id, 'e41');
  assert.equal(porRef.execution!.id, 'process-21');
  assert.equal(porRef.item!.id, 'product-8');
  assert.equal(porRef.recipe!.id, 'recipe-5');
  assert.equal(porRef.blueprint!.id, 'blueprint-3');
  assert.equal(porRef.structure!.id, 'structure-2');
  assert.deepEqual(
    { id: porRef.discovered!.id, serial: porRef.discovered!.serial, nuevo: porRef.discovered!.descubrimientoNuevo },
    { id: null, serial: 6, nuevo: true });
  assert.deepEqual(contadores, {
    birthCounter: 11, communityCounter: 4, eventCounter: 41, discoveredChunks: 6, executionCounter: 21,
    itemCounter: 8, recipeCounter: 5, blueprintCounter: 3, structureCounter: 2,
  });
  for (const contador of ['birth', 'community', 'event', 'execution', 'item', 'recipe', 'blueprint', 'structure'] as const) {
    const asignacion = asignaciones.find(a => a.contador === contador)!;
    assert.equal(serialDeIdIdentidad(contador, asignacion.id!), asignacion.serial);
    assert.equal(formatearIdIdentidad(contador, asignacion.serial!), asignacion.id);
  }
  assert.equal(formatearIdIdentidad('discovered', 9), null);
  assert.equal(serialDeIdIdentidad('birth', 'community-11'), null);
});

test('una clave exacta repetida en un contador lanza: ningún desempate es por llegada', () => {
  const candidatos: CandidatoIdentidad[] = [
    { contador: 'birth', clave: clave(1, 1), referencia: 'a' },
    { contador: 'birth', clave: clave(1, 1), referencia: 'b' },
  ];
  assert.throws(() => asignarIdentidades(candidatos, CEROS), /Clave de identidad repetida en birth/);
  assert.throws(() => asignarIdentidades([{ contador: 'discovered', clave: clave(1, 1) }], CEROS), /chunkKey/);
  assert.throws(() => asignarIdentidades([{ contador: 'birth', clave: clave(-1, 1) }], CEROS), /regionMorton/);
});

test('discoveredChunks deduplica por chunkKey y solo suma transiciones false→true, en cualquier llegada', () => {
  const candidatos: CandidatoIdentidad[] = [
    { contador: 'discovered', clave: clave(40, 4), chunkKey: '3,3', referencia: 'nuevo-3' },
    { contador: 'discovered', clave: clave(20, 3), chunkKey: '2,2', referencia: 'duplicado-2' },
    { contador: 'discovered', clave: clave(10, 1), chunkKey: '2,2', referencia: 'nuevo-2' },
    { contador: 'discovered', clave: clave(30, 0), chunkKey: '0,0', referencia: 'ya-conocido' },
    { contador: 'discovered', clave: clave(10, 2), chunkKey: '1,1', referencia: 'nuevo-1' },
  ];
  const esperadoSeriales: Record<string, number | null> = {
    'nuevo-2': 6, 'nuevo-1': 7, 'duplicado-2': null, 'ya-conocido': null, 'nuevo-3': 8,
  };
  for (const [nombre, orden] of Object.entries(LLEGADAS)) {
    const llegada = orden.map(i => candidatos[i]!);
    const { asignaciones, contadores } = asignarIdentidades(llegada, { ...CEROS, discoveredChunks: 5 }, { descubiertosPrevios: new Set(['0,0']) });
    assert.deepEqual(Object.fromEntries(asignaciones.map(a => [a.candidato.referencia, a.serial])), esperadoSeriales, nombre);
    assert.deepEqual(Object.fromEntries(asignaciones.map(a => [a.candidato.referencia, a.descubrimientoNuevo])), {
      'nuevo-2': true, 'nuevo-1': true, 'duplicado-2': false, 'ya-conocido': false, 'nuevo-3': true,
    }, nombre);
    assert.equal(contadores.discoveredChunks, 8, nombre);
  }
});

const estructura = (id: string, blueprintId: string): StructureView => ({
  id, blueprintId, x: 0, y: 0, name: 'Refugio', components: ['frame', 'roof'], condition: 1,
  water: 0, food: 0, uses: 0, builtAt: 0, builderId: null,
});
const chunkRetirado = (structures: StructureView[]): Chunk => ({
  key: '99,99', cx: 99, cy: 99, tiles: [], discovered: true, places: [], lastTick: 0, structures,
});

test('compatibilidad: ids previos y techoDelArchivo fijan la base de blueprint/structure sin reutilizar ninguno', () => {
  const world = createWorld(123);
  world.blueprintCounter = 4; world.structureCounter = 2;
  world.retiredChunks.push(chunkRetirado([estructura('structure-41', 'blueprint-37')]));
  assert.equal(identityBaseFromArchive(world, 'blueprint'), 37, 'blueprint-base no cuenta; manda el archivo');
  assert.equal(identityBaseFromArchive(world, 'structure'), 41);
  const { asignaciones } = asignarIdentidades([
    { contador: 'blueprint', clave: clave(1, 1), referencia: 'plano' },
    { contador: 'structure', clave: clave(1, 1), referencia: 'obra' },
  ], { ...CEROS, blueprintCounter: identityBaseFromArchive(world, 'blueprint')!, structureCounter: identityBaseFromArchive(world, 'structure')! });
  assert.deepEqual(asignaciones.map(a => a.id).sort(), ['blueprint-38', 'structure-42']);
  // Un mundo con ids viejos conserva sus contadores: el siguiente nacimiento no pisa a los fundadores.
  assert.equal(world.birthCounter, 0);
  const nacimiento = asignarIdentidades([{ contador: 'birth', clave: clave(1, 1) }], { ...CEROS, birthCounter: world.birthCounter });
  assert.equal(nacimiento.asignaciones[0]!.id, 'descendant-1');
  const corrupto = createWorld(123);
  corrupto.retiredChunks.push(chunkRetirado([estructura('structure-41', `blueprint-${'9'.repeat(40)}`)]));
  assert.equal(identityBaseFromArchive(corrupto, 'blueprint'), undefined);
  assert.equal(identityBaseFromArchive(corrupto, 'structure'), 41);
});

test('renumberTechnologyRecipes renumera un bloque contiguo, remapea parents y no toca el original', () => {
  const receta = (id: string, parents: string[]): TechnologyRecipe => ({
    id, name: `form·compress ${id.slice(7)}`, program: structuredClone(filo), signature: `sig-${id}`,
    parents, generation: parents.length + 1, inventorId: 'a', tick: 1, x: 0, y: 0, novelty: 'program',
    capacities: { cutting: 0.5, storage: 0, insulation: 0, cultivation: 0, binding: 0, abrasion: 0 },
    uses: 0, utility: 0, manufactured: 0,
  });
  const originales = [receta('recipe-1', []), receta('recipe-2', ['recipe-1'])];
  const { recipes, map } = renumberTechnologyRecipes(originales, 7);
  assert.deepEqual(recipes.map(r => r.id), ['recipe-7', 'recipe-8']);
  assert.deepEqual(recipes[1]!.parents, ['recipe-7']);
  assert.deepEqual(recipes.map(r => r.name), ['form·compress 7', 'form·compress 8']);
  assert.deepEqual(originales.map(r => r.id), ['recipe-1', 'recipe-2'], 'el camino por defecto no se muta');
  assert.equal(map.get('recipe-2'), 'recipe-8');
  assert.throws(() => renumberTechnologyRecipes([receta('recipe-1', []), receta('recipe-3', [])], 7), /contiguous|sequence|gap|contiguous block/);
});

test('renumberTechnologyExecutionBlock exige contigüidad y renumera el bloque', () => {
  const ejecucion = (id: string): TechnologyExecution => ({
    id, kind: 'use', tick: 3, actorId: 'a', recipeId: null, programSignature: '', inputs: [], outputs: [],
    residueMass: 0, energy: 0, work: 0, success: true, parentRecipeIds: [], catalysts: [], benefit: 0,
    balance: { opening: [], closing: [], externalInputs: [], externalLoss: [] },
  });
  const bloque = [ejecucion('process-3'), ejecucion('process-4')];
  const mapa = renumberTechnologyExecutionBlock(bloque, 10);
  assert.deepEqual(bloque.map(e => e.id), ['process-10', 'process-11']);
  assert.equal(mapa.get(3), 10); assert.equal(technologyExecutionSerial('process-11'), 11);
  assert.equal(technologyExecutionSerial('product-11'), null);
  assert.throws(() => renumberTechnologyExecutionBlock([ejecucion('process-3'), ejecucion('process-5')], 20), /contiguas/);
});

// --- Dos crafteos anidados simultáneos: la transacción es la unidad atómica ---

const fibra: TechnologyProgram = {
  inputs: [{ source: 'raw', material: 'wood', mass: 1000 }],
  steps: [{ op: 'weave', intensity: 4 }, { op: 'form', intensity: 2, shape: 'sheet' }],
};
const avanzado: TechnologyProgram = {
  inputs: [{ source: 'raw', material: 'wood', mass: 1000 }, { source: 'raw', material: 'stone', mass: 1000 }],
  steps: [{ op: 'combine', intensity: 3, requiredCatalyst: 'binding' }, { op: 'form', shape: 'rod', intensity: 3 }],
};

function transaccionAislada() {
  const actor: TechnologyActor = {
    id: 'a', x: 0, y: 0, energy: 1, fatigue: 0, hunger: 0.1, thirst: 0.1, curiosity: 0.9,
    materials: { wood: 12, stone: 8 }, skills: {}, technology: initialTechnologyKnowledge(),
  };
  const host: TechnologyHost = { seed: 51926, tick: 0, people: [actor], technology: defaultTechnologyState(), tiles: [{ x: 0, y: 0, drinkingWater: 0.2 }] };
  enableTechnologyJournal(host.technology);
  const ejecutar = (program: TechnologyProgram, parents: string[] = []): boolean => {
    actor.technology.project = proyectoInvestigacion(structuredClone(program), host.tick, parents);
    let resultado = false;
    for (let n = 0; actor.technology.project && n < 250; n++) { host.tick++; resultado = researchTechnology(host, actor); }
    return resultado;
  };
  assert.equal(ejecutar(fibra), true);
  const herramienta = actor.technology.items[0]!;
  const inicio = host.technology.executionCounter, enHistoria = host.technology.history.length;
  assert.equal(ejecutar(avanzado, [herramienta.recipeId!]), true);
  const ejecuciones = host.technology.history.slice(enHistoria);
  assert.equal(ejecuciones.length, 2, 'uso anidado del catalizador + ejecución de cierre');
  const cierre = ejecuciones.at(-1)!;
  assert.deepEqual(cierre.nestedExecutionIds, [ejecuciones[0]!.id]);
  assert.equal(cierre.catalysts[0]!.executionId, ejecuciones[0]!.id);
  return { host, ejecuciones, contadorPrevio: inicio };
}

function fusionar(llegada: readonly ('A' | 'B')[]) {
  const a = transaccionAislada(), b = transaccionAislada();
  assert.equal(a.contadorPrevio, b.contadorPrevio, 'ambos workers partieron del mismo contador confirmado');
  const candidatos = [
    { clave: { tick: a.ejecuciones[0]!.tick, fase: 4, regionMorton: 300, actorSlot: 7, secuenciaLocal: 0 }, cantidadEjecuciones: a.ejecuciones.length, referencia: 'A' },
    { clave: { tick: b.ejecuciones[0]!.tick, fase: 4, regionMorton: 100, actorSlot: 3, secuenciaLocal: 0 }, cantidadEjecuciones: b.ejecuciones.length, referencia: 'B' },
  ];
  const ordenadas = llegada.map(nombre => candidatos.find(c => c.referencia === nombre)!);
  const { asignaciones, executionCounter } = asignarTransaccionesEjecucion(ordenadas, a.contadorPrevio);
  const inicioPorRef = Object.fromEntries(asignaciones.map(x => [x.candidato.referencia, x.inicioSerial]));
  // B (regionMorton 100) precede a A (300) en el orden total, llegue como llegue.
  assert.ok(inicioPorRef.B! < inicioPorRef.A!);
  assert.equal(executionCounter, a.contadorPrevio + 4);
  renumberTechnologyTransactionBlocks(a.host.technology, [
    { executions: a.ejecuciones, firstSerial: inicioPorRef.A! },
    { executions: b.ejecuciones, firstSerial: inicioPorRef.B! },
  ]);
  assert.equal(a.host.technology.executionCounter, executionCounter);
  assertTechnology(a.host);
  assertTechnologyJournal(a.host.technology, a.host.tick);
  return a.host.technology.history.map(e => ({
    id: e.id, nested: e.nestedExecutionIds ?? [], catalysts: e.catalysts.map(c => c.executionId),
  }));
}

test('dos crafteos anidados simultáneos en regiones distintas se renumeran en bloque y pasan los dos asertos, llegue quien llegue primero', () => {
  const primera = fusionar(['A', 'B']);
  const segunda = fusionar(['B', 'A']);
  assert.deepEqual(primera, segunda);
  const transacciones = primera.slice(-4);
  // Bloques contiguos y sin huecos: serial === previousSerial + 1 en toda la cola.
  const seriales = primera.map(e => Number(e.id.slice(8)));
  for (let i = 1; i < seriales.length; i++) assert.equal(seriales[i], seriales[i - 1]! + 1);
  for (const cierre of transacciones.filter(e => e.nested.length)) {
    assert.deepEqual(cierre.nested, cierre.catalysts, 'nestedExecutionIds y catalysts apuntan a la misma ejecución renumerada');
    assert.ok(transacciones.some(e => e.id === cierre.nested[0]), 'la ejecución anidada existe en el bloque');
    assert.ok(Number(cierre.nested[0]!.slice(8)) < Number(cierre.id.slice(8)));
  }
});

test('asignarTransaccionesEjecucion hace prefix-sum sobre cantidades, no sobre ejecuciones sueltas', () => {
  const { asignaciones, executionCounter } = asignarTransaccionesEjecucion([
    { clave: clave(300, 7, 0, 9, 4), cantidadEjecuciones: 2, referencia: 'tarde' },
    { clave: clave(100, 3, 0, 9, 4), cantidadEjecuciones: 3, referencia: 'pronto' },
  ], 20);
  const porRef = Object.fromEntries(asignaciones.map(a => [a.candidato.referencia, a]));
  assert.deepEqual(porRef.pronto!.ids, ['process-21', 'process-22', 'process-23']);
  assert.deepEqual(porRef.tarde!.ids, ['process-24', 'process-25']);
  assert.equal(executionCounter, 25);
});

test('con motor.hilos=1, 1 200 pasos conservan el digestoCanonico baseline y los nueve contadores de hoy', () => {
  const world = createWorld(51926);
  for (let i = 0; i < 1200; i++) stepWorld(world);
  assert.equal(world.tick, 1200);
  assert.deepEqual({
    birthCounter: world.birthCounter, communityCounter: world.communityCounter, eventCounter: world.eventCounter,
    discoveredChunks: world.discoveredChunks, executionCounter: world.technology.executionCounter,
    itemCounter: world.technology.itemCounter, recipeCounter: world.technology.recipeCounter,
    blueprintCounter: world.blueprintCounter, structureCounter: world.structureCounter,
  }, {
    birthCounter: 7, communityCounter: 3, eventCounter: 370, discoveredChunks: 5, executionCounter: 227,
    itemCounter: 106, recipeCounter: 85, blueprintCounter: 3, structureCounter: 0,
  });
  assert.equal(digestoCanonico(world), '95c577d0c6690a3cedd0027da3b8130a4d05a88c2e1b9837720f24339a6bdc61');
});
