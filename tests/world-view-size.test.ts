import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, projectWorld, personDetail, VIEW_EVENTS, VIEW_MEMORIES } from '../src/world/index.js';
import type { Viewport } from '../src/shared/types.js';
import { projectTechnology, technologyRecipeDetail } from '../src/world/technology.js';
import type { TechnologyRecipe } from '../src/shared/technology.js';

const KIB = 1024;
const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
/** Without a Store the catalogue is absent and the resident definitions reach `maxRecipes` (256):
 * the heaviest snapshot this world can produce, which is the one the measurement must survive. */
function grownWorld(ticks: number): ReturnType<typeof createWorld> {
  const world = createWorld(51926);
  for (let i = 0; i < ticks; i++) stepWorld(world);
  return world;
}

test('a snapshot carries procedure summaries, never their programs, and the saving is measurable', t => {
  const world = grownWorld(8000);
  assert.equal(world.tick, 8000);
  // MEDIDO 2026-09-19 tras la integración de T010-T036 y la calibración ab4d9fb: 28 habitantes
  // (antes 32). Fijar los params viejos NO devuelve 32 — la diferencia la producen las leyes nuevas
  // (senescencia cableada en advancePopulation, genoma de T011, parentesco de T012), no los params.
  // Esta prueba mide el TAMAÑO de la instantánea del mundo tal como se envía hoy, así que se enuncia
  // sobre la población real de hoy y sigue siendo refutable: si cambia, la medición debe rehacerse.
  // Re-measured after the declared V7 behavior corrections: 29 people.
  // All payload ceilings and the reduction ratio below remain unchanged.
  assert.equal(world.people.length, 29, 'the measurement is stated for 29 inhabitants');
  assert.ok(world.technology.recipes.length >= 200, `resident definitions: ${world.technology.recipes.length}`);
  const view = projectWorld(world), technology = view.technology!;
  assert.equal(technology.recipes.length, world.technology.recipes.length);
  for (const recipe of technology.recipes) {
    assert.deepEqual(Object.keys(recipe).sort(), ['capacities', 'generation', 'id', 'name'], 'the summary is exactly id, name, generation and capacities');
    for (const value of Object.values(recipe.capacities)) assert.equal(value, Math.round(value * 1000) / 1000, 'a drawn capacity travels rounded');
  }
  assert.equal(JSON.stringify(technology.recipes).includes('"program"'), false);
  assert.equal(JSON.stringify(view).includes('"steps"'), false, 'no program crosses the wire inside the snapshot');
  const bytes = encodedBytes(view);
  const before = encodedBytes({ ...view, technology: { ...technology, recipes: world.technology.recipes } });
  const summaryBytes = encodedBytes(technology.recipes);
  t.diagnostic(`t=8000 · ${world.people.length} hab. · ${world.technology.recipes.length} recetas · state ${(bytes / KIB).toFixed(1)} KiB (con programas ${(before / KIB).toFixed(1)} KiB) · recetas ${(summaryBytes / KIB).toFixed(1)} KiB · tiles ${(encodedBytes(view.tiles) / KIB).toFixed(1)} KiB · people ${(encodedBytes(view.people) / KIB).toFixed(1)} KiB`);
  assert.ok(summaryBytes < 64 * KIB, `summaries at ${(summaryBytes / KIB).toFixed(1)} KiB`);
  // Different physical laws discover different programs. The historical 140 KiB
  // also counted signatures/statistics, so it was not a fixed cost of omitting
  // programs. Compare these same definitions with only their program fields removed.
  const withoutPrograms = world.technology.recipes.map(({ program: _program, ...definition }) => definition);
  const programBytes = encodedBytes(world.technology.recipes) - encodedBytes(withoutPrograms);
  assert.ok(programBytes > 0 && before - bytes >= programBytes,
    `saving ${before - bytes} bytes must cover ${programBytes} bytes of omitted program fields`);
  t.diagnostic(`UTF-8 state: ${bytes} bytes; with full definitions: ${before} bytes; saving: ${before - bytes} bytes; program fields alone: ${programBytes} bytes`);
  assert.ok(bytes < before * 0.83, `the snapshot keeps ${(100 * bytes / before).toFixed(1)} % of its size with programs`);
  // PROVISIONAL CEILING OF THIS PHASE, NOT THE BRIEF'S TARGET. T020 asked for `state` < 120 KiB; what
  // this fix alone reaches is measured above and stated here without dressing it up: `tiles` (≈292 KiB)
  // and `people` (≈83 KiB) still travel whole every tick, so even deleting `technology` entirely would
  // leave ≈487 KiB. The 120 KiB target belongs to the tiles delta / dirty-page work (cause (a) of the
  // C4 critical), which is outside this task's files; this bound only forbids a regression from here.
  assert.ok(bytes < 640 * KIB, `state at ${(bytes / KIB).toFixed(1)} KiB — provisional ceiling of this phase, not the brief's 120 KiB`);
});

/** T036(h): la dieta del `state`, medida con las dos cámaras que la evidencia de T020 midió
 * (docs/evidencia-2026-09-19/state-desglose-t020.md). Las cotas son las MEDIDAS de hoy, no las del
 * encargo: prohíben una regresión y dicen sin adornos a cuánto llegó esta fase. Lo que queda para
 * bajar de 120/250 KiB está fuera de estos ficheros y consta en el desglose que imprime la prueba. */
test('la dieta del `state` se mide con las dos cámaras de la evidencia', t => {
  const world = grownWorld(8000);
  const medida = (label: string, viewport: Viewport): number => {
    const view = projectWorld(world, viewport), bytes = encodedBytes(view);
    const partes = Object.entries(view).map(([key, value]) => [key, value === undefined ? 0 : encodedBytes(value)] as const)
      .sort((a, b) => b[1] - a[1]).slice(0, 6).map(([key, size]) => `${key} ${(size / KIB).toFixed(1)}K`);
    t.diagnostic(`cámara ${label} · state ${(bytes / KIB).toFixed(1)} KiB (${bytes} UTF-8 bytes) · ${partes.join(' · ')}`);
    return bytes;
  };
  const movil = medida('12x8', { x: 0, y: 0, width: 12, height: 8 });
  const completa = medida('40x28', { x: 0, y: 0, width: 40, height: 28 });
  // Antes de T036(h): 295.3 KiB y 591.9 KiB con este mismo mundo y semilla.
  assert.ok(movil < 200 * KIB, `cámara 12x8 a ${(movil / KIB).toFixed(1)} KiB (antes 295.3 KiB)`);
  assert.ok(completa < 420 * KIB, `cámara 40x28 a ${(completa / KIB).toFixed(1)} KiB (antes 591.9 KiB)`);
  assert.ok(movil < 295 * KIB && completa < 592 * KIB, 'la dieta no puede deshacerse en silencio');
  // Lo que la dieta quitó del cable, comprobado en el propio mensaje y no sólo en su tamaño.
  const view = projectWorld(world, { x: 0, y: 0, width: 40, height: 28 });
  for (const person of view.people) {
    assert.equal(person.experiences, undefined, 'las experiencias se piden con `{type:\'persona\'}`');
    assert.equal(person.trust, undefined, 'los vínculos se piden con `{type:\'persona\'}`');
  }
  assert.equal(view.technology!.knowledge, undefined, 'el repertorio por actor se pide por habitante');
  assert.equal((view.organization as { resources?: unknown }).resources, undefined, 'el balance por recurso no lo dibuja nadie');
  assert.ok(view.events.length <= 40, `ventana de crónica: ${view.events.length}`);
  assert.equal(VIEW_EVENTS, 40);
  // Una cantidad que vale cero no viaja; una que describe el terreno sí, aunque valga cero.
  assert.ok(view.tiles.some(tile => tile.wood === undefined), 'una tesela sin madera no lleva `wood: 0`');
  assert.ok(view.tiles.every(tile => typeof tile.moisture === 'number' && typeof tile.food === 'number'),
    'humedad y alimento viajan siempre: ahí un cero es un dato');
  for (const tile of view.tiles) for (const value of [tile.elevation, tile.moisture, tile.food, tile.vegetation, tile.wood, tile.stone, tile.growth, tile.fertility, tile.cultivation, tile.traffic, tile.drinkingWater, tile.fauna, tile.life]) {
    if (value !== undefined) assert.equal(value, Math.round(value * 1000) / 1000, 'una tesela viaja en milésimas');
  }
});

/** La biografía que salió del `state` se sirve entera por habitante y leerla no toca el mundo. */
test('la biografía de un habitante se sirve a petición y no altera el mundo', () => {
  const world = grownWorld(600), person = world.people[0]!, before = structuredClone(world);
  const detail = personDetail(world, person.id)!;
  assert.equal(detail.id, person.id);
  assert.deepEqual(detail.experiences, person.experiences.map(e => ({ tick: e.tick, text: e.text, causeId: e.causeId })));
  assert.deepEqual(detail.trust.map(t => t.id).sort(), Object.keys(person.bonds).sort());
  assert.deepEqual(detail.recipeIds, [...person.technology.knownRecipes]);
  assert.deepEqual(world, before, 'una consulta no es una transacción');
  for (const invalid of ['', 'no-existe', '../persona', 'x'.repeat(51)]) assert.equal(personDetail(world, invalid), undefined, `rechazado: ${invalid}`);
});

test('the chronicle and the letter reach the snapshot through a declared window', () => {
  const lived = projectWorld(grownWorld(600));
  assert.ok(lived.events.length > 0 && lived.events.length <= VIEW_EVENTS, `lived chronicle: ${lived.events.length}`);
  assert.ok(lived.memories.length > 0 && lived.memories.length <= VIEW_MEMORIES);
  // A running world never reaches the window (MAX_EVENTS = 120 trims the chronicle, `assertWorld` caps
  // memories at 10), so only a world that exceeds it can refute the projection: `projectWorld` does not
  // validate, and without its two slices this snapshot would carry 260 events and 120 memories.
  const world = createWorld(51926), seed = world.memories[0]!;
  const surplus = 60, extraMemories = 20;
  world.events = Array.from({ length: VIEW_EVENTS + surplus }, (_, i) => ({ id: `synthetic-event-${i}`, tick: i,
    kind: 'memory' as const, actors: [], text: 'Crónica sintética de prueba.', cause: 'Prueba de la ventana.', source: 'sample' as const }));
  world.memories = Array.from({ length: VIEW_MEMORIES + extraMemories }, (_, i) => ({ ...seed, id: `synthetic-memory-${i}` }));
  const view = projectWorld(world);
  assert.equal(view.events.length, VIEW_EVENTS, 'the chronicle crosses the wire bounded');
  assert.equal(view.events[0]!.id, `synthetic-event-${surplus}`, 'the window keeps the newest; the oldest stay out');
  assert.equal(view.events.at(-1)!.id, `synthetic-event-${VIEW_EVENTS + surplus - 1}`);
  assert.equal(view.memories.length, VIEW_MEMORIES);
  assert.equal(view.memories[0]!.id, `synthetic-memory-${extraMemories}`);
  assert.equal(view.memories.at(-1)!.id, `synthetic-memory-${VIEW_MEMORIES + extraMemories - 1}`);
});

test('a program is served one at a time and reading it never touches the world', () => {
  const world = grownWorld(600);
  const id = world.technology.recipes[0]!.id, before = structuredClone(world);
  const detail = technologyRecipeDetail(world, id) as TechnologyRecipe;
  assert.equal(detail.id, id);
  assert.ok(detail.program.steps.length > 0 && typeof detail.signature === 'string');
  assert.deepEqual(world, before, 'a query is not a transaction: the world is untouched');
  for (const invalid of ['', 'recipe-0', 'recipe-x', 'receta-1', 'recipe-01', '../recipe-1', 'recipe-99999999999999']) {
    assert.equal(technologyRecipeDetail(world, invalid), undefined, `rejected: ${invalid}`);
  }
  assert.equal(technologyRecipeDetail(world, `recipe-${world.technology.recipeCounter + 1}`), undefined, 'an unknown definition is absent, not invented');
  assert.equal(projectTechnology(world).recipes.some(recipe => 'program' in recipe), false);
});
