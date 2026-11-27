import test from 'node:test';
import assert from 'node:assert/strict';
import type { AnimalView, CommunityView, PersonView, StructureView, WorldStats, WorldView } from '../src/shared/types.js';
import { activitySplit, communitySummary, cropCounts, cropStage, renderAnimalTelemetry, renderCommunityTelemetry, renderLandTelemetry, renderLifeTelemetry, renderPersonTelemetry, renderTelemetry, renderTileTelemetry, structureRollup, telemetryKpis, viewportCensus, viewportCensusText, type StructureTelemetry } from '../src/client/telemetry-hud.js';
import { worldShell } from '../src/client/world-shell.js';

function statsFixture(): WorldStats {
  return { population: 8210, meanEnergy: .7, meanHunger: .2, meanFatigue: .3, meanThirst: .1, materials: { wood: 10, stone: 8 },
    actions: { farm: 10, build: 5, gather: 5, rest: 40, explore: 20, eat: 10, drink: 10 }, biomes: {}, features: {}, totals: {},
    generations: { '1': 100, '12': 8110, '99': 0 }, history: [], scope: 'active-regions', wildlife: { hare: 20, deer: 8, wolf: 3, fox: 2 },
    freshWater: 8, cultivatedTiles: 91, trailTiles: 3, blueprints: 17,
    diversidad: { conducta: .61, oficios: .42, total: .53 }, giniRecursosPorRegion: .321, fraccionCeldasConComida: .74, distanciaMediaAgua: 4.5, regionesSinAgua: .22,
    census: { neighbors: 8208, identities: 2, protectedCount: 2, lifeStage: { juvenile: 2000, adult: 6000, senescent: 208, unknown: 0 } }, statsTick: 200 };
}
const communities: CommunityView[] = [
  { id: 'a', name: 'A', x: 0, y: 0, color: '#abc', members: [], culture: { sharing: .2, stewardship: .3, openness: .4 }, formedAt: 0, cooperation: 12, disputes: 3 },
  { id: 'b', name: 'B', x: 1, y: 1, color: '#abc', members: [], culture: { sharing: .8, stewardship: .7, openness: .8 }, formedAt: 0, cooperation: 8, disputes: 4 },
];
function worldFixture(): WorldView {
  return { version: 10, sequence: 0, tick: 250, day: 1, phase: 'day', weather: 'clear', width: 5, height: 1,
    tiles: [0, .1, .35, .62, .85].map((cultivation, x) => ({ x, y: 0, cultivation, terrain: 'soil', moisture: .6, food: .3, vegetation: .4 })),
    people: [], animals: [], structures: [], places: [], memories: [], events: [], stats: statsFixture(), communities: structuredClone(communities),
    performance: { stepMs: 20, p95StepMs: 30, saveMs: 1, projectionMs: 1, snapshotBytes: 100, activeTiles: 5, processRssMiB: 20, tickHz: 9.5, fraccionSerial: 1, fases: { maintainRegions: 0, ecologia: 0, kernel: 0, fauna: 0, personas: 0, encuentros: 0, demografia: 0, comunidades: 0, reproduccion: 0, checkpoint: 0, muestreo: 0, save: 0, broadcast: 0 } } };
}
function personFixture(): PersonView {
  return { id: 'p', name: 'P', role: 'neighbor', x: 0, y: 0, color: '#abc', action: 'farm', reason: 'Cultiva', energy: .6, hunger: .2, fatigue: .1, need: 'Agua', recentMemory: null,
    genome: { generation: 12, parents: [], learningRate: .5, cooperation: .4, mutations: 2 }, working: true, workProgress: .42, health: .9, vitality: .8, lifeStage: 'adult', age: 123, foodReserve: 2, foodReserveCapacity: 5, materials: { wood: 3, stone: 4 },
    skills: { farm: .8, hunt: .1, build: .9, share: .7 }, culture: { sharing: .4, stewardship: .5, openness: .6 } };
}
function animalFixture(): AnimalView {
  return { id: 'wolf-1', species: 'wolf', x: 0, y: 0, action: 'hunt', reason: '', hunger: .1, thirst: .2, energy: .8, fatigue: .2, health: .9, generation: 3, age: 1234, parents: ['a', '<b>'],
    genes: { speed: .7, perception: .6, metabolism: .5, carnivory: .9, waterEfficiency: .4, camouflage: .3 } };
}
function structureFixture(): StructureView {
  return { id: 's', x: 0, y: 0, blueprintId: 'b', name: 'Granero', components: ['granary'], condition: .8, water: 2, food: 7, uses: 4, builtAt: 0, builderId: null };
}

test('KPI pills use the global census and generations, actions, society, wildlife and technology', () => {
  const world = worldFixture();
  const kpis = telemetryKpis(world), kpi = (nav: string) => kpis.find(p => p.nav === nav)!;
  assert.equal(kpis.length, 7);
  assert.match(kpi('people').value, /8[.,]210 · G12/);
  assert.match(kpi('people').detail, /8[.,]208 vecinos.*J\/A\/M: 2[.,]000\/6[.,]000\/208/);
  assert.equal(kpi('life').value, '20% / 40%'); assert.match(kpi('life').detail, /61%/);
  assert.equal(kpi('communities').value, '2 · 20/7'); assert.match(kpi('communities').detail, /20 cooperaciones.*7 desacuerdos.*60%/);
  assert.equal(kpi('animals').value, '33 · 5 dep.'); assert.equal(kpi('land').value, '91 · 17');
  assert.match(kpi('performance').value, /30 ms · 9[.,]5 Hz/);
  const html = renderTelemetry(world);
  for (const nav of ['people', 'life', 'communities', 'animals', 'land', 'technology', 'performance']) assert.match(html, new RegExp(`<button[^>]+data-hud-nav="${nav}"`));
  assert.equal((html.match(/aria-label=/g) ?? []).length, 7);
  assert.match(renderTelemetry(null), /—/); assert.doesNotMatch(renderTelemetry(null), /NaN|undefined|Infinity/);
  delete world.stats; assert.match(telemetryKpis(world)[0]!.value, /—/); // Never count the camera as the world.
});

test('technology KPI uses catalogue recipe totals rather than the sampled definitions', async () => {
  const { createWorld, projectWorld } = await import('../src/world/index.js');
  const world = projectWorld(createWorld(51926));
  assert.ok(world.technology);
  world.technology.dynamics.recipes = 321;
  world.stats!.blueprints = 45;
  const kpi = telemetryKpis(world).find(p => p.nav === 'technology')!;
  assert.match(kpi.value, /^321 ·/); assert.match(kpi.detail, /45 planos/);
  assert.deepEqual(telemetryKpis(world, true).find(p => p.nav === 'technology'), kpi);
});

test('Oficios cuenta habitantes con recetas de la cinta en la cámara', () => {
  const world = worldFixture();
  const oficio = () => telemetryKpis(world, true).find(kpi => kpi.nav === 'technology')!;
  assert.equal(oficio().value, 'Sin fichas');
  world.reaccionObservada = { tick: 230, a: 1, b: 0, nivel: 1, lote: 2, veces: 1 };
  assert.equal(oficio().summary, 'En esta vista · reacción observada');
  const ficha = { recetas: [], omitidas: 0, proceso: null, intentos: 0 };
  world.people = [{ ...personFixture(), tecnicaVista: ficha }];
  assert.equal(oficio().value, '0 hab. con recetas');
  world.people.push({ ...personFixture(), id: 'p-2', tecnicaVista: { ...ficha, omitidas: 2 } });
  world.people.push({ ...personFixture(), id: 'p-3', tecnicaVista: { ...ficha, recetas: [{ id: 8, generacion: 1, usada: 220, padres: [] }] } });
  assert.equal(oficio().value, '2 hab. con recetas');
  assert.match(oficio().detail, /3 fichas de técnica/);
});

test('activity fractions include every work action and keep movement and survival separate', () => {
  const actions = Object.fromEntries(['farm', 'build', 'gather', 'forage', 'hunt', 'craft', 'research', 'invent', 'repair', 'cooperate', 'share'].map(key => [key, 1]));
  const a = activitySplit({ ...actions, rest: 4, move: 1, explore: 1, approach: 1, accompany: 1, retreat: 1, eat: 2, drink: 2, unknown: 1 });
  assert.equal(a.total, 25); assert.equal(a.working, 11 / 25); assert.equal(a.resting, 4 / 25); assert.equal(a.moving, 5 / 25); assert.equal(a.survival, 4 / 25); assert.equal(a.other, 1 / 25);
  assert.equal(activitySplit({ rest: 0, farm: NaN, drink: -2 }).working, undefined);
  assert.equal(activitySplit().total, 0);
});

test('performance KPI shows the measured pace and p95 from the received state', () => {
  const world = worldFixture();
  world.performance!.p95StepMs = 101;
  const kpi = telemetryKpis(world).find(kpi => kpi.nav === 'performance')!;
  assert.match(kpi.detail, /Paso p95 101 ms · 9,5 Hz en el estado recibido/);
});

test('life telemetry renders hidden diversity and resource access metrics including the no-water sentinel', () => {
  const stats = statsFixture(), html = renderLifeTelemetry(stats);
  for (const text of ['Actividad vs descanso', 'Faena', '20%', '40%', 'Movimiento / exploración', 'Supervivencia', 'Diversidad de conducta', '61%', 'Diversidad de oficios', '42%', 'Diversidad total', '53%', 'Gini', 'Terreno con alimento', '74%', 'Regiones secas', '22%', 'paso 200']) assert.ok(html.includes(text), text);
  assert.match(html, /4[.,]5 celdas/); assert.match(html, /0[.,]321/);
  stats.distanciaMediaAgua = -1; assert.match(renderLifeTelemetry(stats), /Sin fuente potable/); assert.doesNotMatch(renderLifeTelemetry(stats), /-1 celdas/);
  delete stats.diversidad; delete stats.distanciaMediaAgua; assert.doesNotThrow(() => renderLifeTelemetry(stats));
});

test('crop stages and camera census reflect the received view without using global counts', () => {
  assert.deepEqual([0, .1, .35, .62, .85].map(cropStage), ['unplowed', 'plowed', 'sprout', 'growing', 'ripe']);
  assert.deepEqual([.24, .25, .49, .5, .74, .75].map(cropStage), ['plowed', 'sprout', 'sprout', 'growing', 'growing', 'ripe']);
  const world = worldFixture(); world.people = [personFixture()]; world.animals = [animalFixture()]; world.structures = [structureFixture()];
  assert.deepEqual(cropCounts(world.tiles), { unplowed: 1, plowed: 1, sprout: 1, growing: 1, ripe: 1 });
  assert.deepEqual(viewportCensus(world), { people: 1, animals: 1, structures: 1, crops: 4 });
  assert.equal(viewportCensusText(world), 'En vista: 1 hab · 1 fauna · 1 obras · 4 cultivos');
  for (const label of ['Sin arar', 'Arado', 'Brote', 'En crecimiento', 'Cosecha madura']) assert.ok(renderLandTelemetry(world).includes(label));
  assert.match(renderTileTelemetry(world.tiles[4]!), /Estado del cultivo.*Cosecha madura/);
  delete world.animals; assert.match(viewportCensusText(world), /— fauna/);
});

test('structure rollups accept absent and optional V19 fields and prefer storedFood over legacy food', () => {
  const base = structureFixture();
  assert.deepEqual(structureRollup([base]), { total: 1, food: 7, wood: undefined, stone: undefined, sites: undefined, installed: undefined, multiTile: undefined, footprintTiles: undefined });
  const extra: StructureView = { ...base, food: 11, storedWood: 3, storedStone: 2,
    site: { requiredWood: 6, requiredStone: 4, depositedWood: 3, depositedStone: 2, requiredWork: 10, completedWork: 4 },
    installed: [
      { id: 'i1', recipeId: null, mass: 1, containment: 1, insulation: 0, cohesion: 1, binding: 0, condition: 1 },
      { id: 'i2', recipeId: null, mass: 1, containment: 0, insulation: 1, cohesion: 1, binding: 0, condition: 1 },
    ],
    footprint: { width: 2, height: 1 } };
  assert.deepEqual(structureRollup([base, extra]), { total: 2, food: 18, wood: 3, stone: 2, sites: 1, installed: 2, multiTile: 1, footprintTiles: 3 });
  assert.equal(structureRollup([{ ...extra, site: { progress: 1 } } as StructureTelemetry]).sites, 0);
  assert.equal(structureRollup([{ ...extra, storedFood: 0 } as StructureTelemetry]).food, 0);
  const world = worldFixture(); world.structures = [extra];
  assert.match(renderLandTelemetry(world), /Alimento almacenado<strong>11/);
  assert.match(renderLandTelemetry(world), /Tecnología instalada<strong>2/);
  delete world.structures; assert.doesNotThrow(() => renderLandTelemetry(world));
});

test('fauna shows species, carnivores and accumulated birth, predation and hunting ratios', () => {
  const world = worldFixture(); world.stats!.animalDynamics = { births: 20, deaths: 10, predations: 4, humanHunts: 2, plantConsumed: 3, waterConsumed: 4 };
  const html = renderLandTelemetry(world);
  assert.match(html, /Carnívoros · zorros y lobos<strong>5/); assert.match(html, /Liebres<strong>20/);
  assert.match(html, /Nacimientos \/ muertes<strong>2/); assert.match(html, /Depredación \/ muertes<strong>40%/); assert.match(html, /Caza humana \/ muertes<strong>20%/);
  world.stats!.animalDynamics.deaths = 0; assert.doesNotMatch(renderLandTelemetry(world), /Infinity|NaN/);
});

test('community summary exposes sums, means and cultural spread for every community', () => {
  const c = communitySummary(communities); assert.equal(c.total, 2); assert.equal(c.cooperation, 20); assert.equal(c.disputes, 7);
  const sharing = c.cultures.find(c => c.axis === 'sharing')!; assert.equal(sharing.mean, .5); assert.equal(sharing.min, .2); assert.equal(sharing.max, .8);
  assert.match(renderCommunityTelemetry(communities), /Compartir<strong>50% · 20%–80%/);
  assert.equal(communitySummary([]).total, 0); assert.equal(communitySummary().total, undefined);
});

test('Ahora exposes person work, vital state, top three practiced skills and personal culture', () => {
  const p = personFixture(), html = renderPersonTelemetry(p);
  for (const label of ['Trabajo en curso', 'Salud', 'Vitalidad', 'Etapa', 'Adulto', 'Edad', '123 pasos', 'Gen', 'G12', 'Reserva', 'Madera', 'Piedra', 'Construcción', 'Cultivo', 'Compartir', 'Cuidado', 'Apertura']) assert.ok(html.includes(label), label);
  assert.match(html, /<meter[^>]+value="42"/); assert.doesNotMatch(html, /Caza/);
  assert.match(renderPersonTelemetry({ ...p, working: false }), /<meter/);
  assert.doesNotMatch(renderPersonTelemetry({ ...p, working: false, workProgress: 0 }), /<meter/);
  assert.doesNotThrow(() => renderPersonTelemetry({ ...p, health: undefined, vitality: undefined, culture: undefined, materials: undefined, skills: undefined }));
});

test('animal genetics and optional reserve render directly, escaped, without collapsed details', () => {
  const animal = animalFixture(), html = renderAnimalTelemetry(animal);
  for (const label of ['Genética y estado', 'Velocidad', 'Percepción', 'Metabolismo', 'Carnivoría', 'Agua', 'Camuflaje', 'Edad', '1.234 pasos', 'Generación', 'G3', 'Progenitores']) assert.ok(html.includes(label), label);
  assert.match(html, /&lt;b&gt;/); assert.doesNotMatch(html, /<details|Reserva reproductiva/);
  assert.match(renderAnimalTelemetry({ ...animal, reproductiveReserve: .25 }), /Reserva reproductiva/);
});

test('shell keeps the functional HUD, camera census and every notebook hook without the dead banner', () => {
  const html = worldShell();
  assert.match(html, /<section id="hud-telemetry" class="hud-telemetry hud-surface" aria-label="Pulso del mundo">/);
  assert.doesNotMatch(html, /UN MUNDO PARA VOLVER|class="game-brand/);
  for (const id of ['world-day', 'world-phase', 'connection-label', 'world-rhythm', 'salud-chip', 'panel-salud', 'stats-drawer', 'population-drawer', 'inspector-drawer', 'layers-popover', 'settings-drawer', 'whisper-drawer', 'landscape', 'camera-coordinates', 'world-extent', 'viewport-census', 'letter-button', 'letter-dialog', 'population-list', 'inspector-tabs', 'inhabitant-card', 'stats-content']) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length, 1, id);
});

test('telemetry helpers leave the received world untouched', () => {
  const world = worldFixture(); world.people = [personFixture()]; world.animals = [animalFixture()]; world.structures = [structureFixture()];
  const original = structuredClone(world);
  renderTelemetry(world); renderLifeTelemetry(world.stats!); renderLandTelemetry(world); renderCommunityTelemetry(world.communities);
  viewportCensusText(world); renderPersonTelemetry(world.people[0]!); renderAnimalTelemetry(world.animals[0]!);
  assert.deepEqual(world, original);
});
