import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, projectWorld, type World } from '../src/world/index.js';
import type { Viewport } from '../src/shared/types.js';
import { demographicTraits } from '../src/world/demography.js';
import { paramsOf } from '../src/world/params.js';
import { captureTechnologyCheckpoint } from '../src/world/technology-checkpoint.js';

const KIB = 1024;
const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Clones a real neighbor as a template so every injected synthetic person carries a valid,
 * fully-shaped `Person` (genome, technology, demography…) without recomputing genetics for a
 * scale test that only cares about wire size and visibility, not biology. */
function injectNeighbors(world: World, count: number, at: { x: number; y: number }, communityId: string | null, prefix: string): void {
  const template = world.people.find(p => p.role === 'neighbor')!;
  for (let i = 0; i < count; i++) {
    const clone = structuredClone(template);
    clone.id = `${prefix}-${i}`; clone.name = `Sintético ${prefix} ${i}`;
    clone.x = at.x; clone.y = at.y; clone.target = { x: at.x, y: at.y };
    clone.communityId = communityId; clone.role = 'neighbor';
    world.people.push(clone);
    if (communityId) world.communities.find(c => c.id === communityId)?.members.push(clone.id);
  }
  // `stepWorld` keeps the technology checkpoint's roster current (`advanceTechnologyCheckpoint`);
  // a direct injection must do the same, or `analyzeTechnologyOrganization` (unrelated to T134,
  // still called by `projectWorld`) treats every injected id as never-checkpointed and floods
  // `organization` with one diagnostic string per id — an artifact of skipping birth, not real.
  world.technology.checkpoint = captureTechnologyCheckpoint(world.technology, world.people, world.tick, 'migration');
}

/** The formula `demographicSummary` (`game.ts:419-437`) used to run per client over the WHOLE
 * `people` it received (before T134's viewport filter existed), before T134 moved the aggregate
 * to `stats.census` computed once on the server. Built directly from `World.people` — never from
 * a projected, viewport-trimmed view — so this is independent of any camera the test happens to use. */
function clientSideCensus(world: World) {
  const cuerpo = paramsOf(world).cuerpo;
  const neighbors = world.people.filter(p => p.role === 'neighbor');
  const identities = world.people.filter(p => p.role !== 'neighbor');
  const stages = { juvenile: 0, adult: 0, senescent: 0 };
  for (const p of neighbors) {
    const traits = demographicTraits(p.genome, cuerpo);
    if (p.demography.age < traits.maturityAge) stages.juvenile++; else if (p.demography.age < traits.senescenceStart) stages.adult++; else stages.senescent++;
  }
  return { neighbors: neighbors.length, identities: identities.length, protectedCount: identities.length, lifeStage: { ...stages, unknown: 0 } };
}

test('projectWorld recorta `people` a la cámara con el mismo margen de una celda que las teselas', () => {
  const world = createWorld(51926);
  const person = world.people.find(p => p.role === 'neighbor')!;
  person.x = 20; person.y = 10; person.target = { x: 20, y: 10 };
  const viewport: Viewport = { x: 0, y: 0, width: 10, height: 10 };
  // Fuera del margen: 2 celdas más allá del borde derecho.
  person.x = viewport.x + viewport.width + 1;
  assert.equal(projectWorld(world, viewport).people.some(p => p.id === person.id), false, 'a 2 celdas del borde no es visible');
  // Dentro del margen de una celda: justo la celda siguiente al borde.
  person.x = viewport.x + viewport.width;
  assert.equal(projectWorld(world, viewport).people.some(p => p.id === person.id), true, 'el margen de una celda debe incluirla');
  // Dentro de la cámara.
  person.x = viewport.x + 1;
  assert.equal(projectWorld(world, viewport).people.some(p => p.id === person.id), true);
  // Lejos por el lado negativo, también con margen.
  person.x = viewport.x - 1;
  assert.equal(projectWorld(world, viewport).people.some(p => p.id === person.id), true, 'el margen aplica también por el lado negativo');
  person.x = viewport.x - 2;
  assert.equal(projectWorld(world, viewport).people.some(p => p.id === person.id), false);
});

test('el censo del servidor (stats.census) no depende del viewport y coincide con lo que el cliente calculaba', () => {
  const world = createWorld(51926);
  for (let i = 0; i < 400; i++) stepWorld(world);
  const expected = clientSideCensus(world);
  assert.ok(expected.neighbors > 0, 'el mundo de prueba trae vecinos vivos');
  const full = projectWorld(world, { x: 0, y: 0, width: 40, height: 28 });
  assert.deepEqual(full.stats!.census, expected, 'la vista completa debe reproducir el cálculo que hacía el cliente sobre TODA la población');
  // Una cámara estrecha que deja fuera a casi todos: el censo (calculado sobre TODA la
  // población) debe ser IDÉNTICO, aunque `people` en la vista ahora sea mucho más corto.
  const narrow = projectWorld(world, { x: 0, y: 0, width: 2, height: 2 });
  assert.ok(narrow.people.length < world.people.length, 'la cámara estrecha recorta `people`');
  assert.deepEqual(narrow.stats!.census, expected, 'el censo del servidor es ajeno al viewport');
});

test('las comunidades viajan con `memberCount` y solo los miembros visibles; los planos solo los referenciados por estructuras visibles', () => {
  const world = createWorld(51926);
  const communityId = 'community-test-1';
  world.communities.push({ id: communityId, name: 'Comunidad de prueba', x: 5, y: 5, color: '#abcdef', members: [], culture: { sharing: 0.5, stewardship: 0.5, openness: 0.5 }, formedAt: 0, cooperation: 0, disputes: 0 });
  injectNeighbors(world, 12, { x: 5, y: 5 }, communityId, 'miembro-visible');
  injectNeighbors(world, 20, { x: 35, y: 25 }, communityId, 'miembro-lejano');
  const viewport: Viewport = { x: 0, y: 0, width: 10, height: 10 };
  const view = projectWorld(world, viewport);
  const community = view.communities!.find(c => c.id === communityId)!;
  assert.equal(community.memberCount, 32, 'memberCount cuenta a TODOS los miembros, visibles o no');
  assert.ok(community.members.length < community.memberCount, 'la lista de miembros no viaja completa');
  assert.ok(community.members.every(id => view.people.some(p => p.id === id)), 'todo miembro listado está también en `people` de esta misma vista');
  assert.equal(community.members.length, view.people.filter(p => p.communityId === communityId).length);

  // Blueprints: solo referenciados por estructuras visibles.
  world.blueprints.push({ id: 'blueprint-visible', name: 'Cabaña visible', components: ['wall'], generation: 0, parents: [], inventorId: null, tick: 0, uses: 0, usefulness: 0, cost: { wood: 1, stone: 1, work: 1 } } as never);
  world.blueprints.push({ id: 'blueprint-lejano', name: 'Cabaña lejana', components: ['wall'], generation: 0, parents: [], inventorId: null, tick: 0, uses: 0, usefulness: 0, cost: { wood: 1, stone: 1, work: 1 } } as never);
  world.structures.push({ id: 'structure-visible', x: 5, y: 5, blueprintId: 'blueprint-visible', name: 'Cabaña', components: ['wall'], condition: 1, water: 0, food: 0, uses: 0, builtAt: 0, builderId: null } as never);
  world.structures.push({ id: 'structure-lejano', x: 35, y: 25, blueprintId: 'blueprint-lejano', name: 'Cabaña', components: ['wall'], condition: 1, water: 0, food: 0, uses: 0, builtAt: 0, builderId: null } as never);
  const withStructures = projectWorld(world, viewport);
  const blueprintIds = withStructures.blueprints!.map(b => b.id);
  assert.ok(blueprintIds.includes('blueprint-visible'), 'el plano de una estructura visible viaja');
  assert.equal(blueprintIds.includes('blueprint-lejano'), false, 'el plano de una estructura fuera de cámara no viaja');
});

test('FR-026: con 10 000 habitantes inyectados y 40 en cámara, `state` lleva ~40 personas y ninguna lista `members` completa', t => {
  const world = createWorld(51926);
  const communityId = 'community-masiva';
  world.communities.push({ id: communityId, name: 'Comunidad masiva', x: 5, y: 5, color: '#abcdef', members: [], culture: { sharing: 0.5, stewardship: 0.5, openness: 0.5 }, formedAt: 0, cooperation: 0, disputes: 0 });
  injectNeighbors(world, 40, { x: 5, y: 5 }, communityId, 'camara');
  injectNeighbors(world, 9960, { x: 35, y: 25 }, communityId, 'lejos');
  assert.equal(world.people.length, 10000 + 16, 'los 16 fundadores más los 10 000 inyectados');
  const viewport: Viewport = { x: 0, y: 0, width: 10, height: 10 };
  const view = projectWorld(world, viewport);
  t.diagnostic(`10 000 habitantes · viewport 10x10 · people en vista ${view.people.length} · memberCount ${view.communities!.find(c=>c.id===communityId)!.memberCount} · members en vista ${view.communities!.find(c=>c.id===communityId)!.members.length}`);
  assert.ok(view.people.length < 100, `la cámara mantiene la vista de personas acotada (${view.people.length})`);
  const community = view.communities!.find(c => c.id === communityId)!;
  assert.equal(community.memberCount, 10000, 'el total real de la comunidad, íntegro');
  assert.ok(community.members.length < 100, 'la lista de miembros nunca es la comunidad completa');
  assert.equal(JSON.stringify(view).includes('"lejos-'), false, 'ningún id de un miembro fuera de cámara aparece en el cable');
  const bytes = encodedBytes(view);
  t.diagnostic(`state con 10 000 habitantes, viewport 10x10: ${(bytes / KIB).toFixed(1)} KiB`);
});
