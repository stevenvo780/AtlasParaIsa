import test from 'node:test';
import assert from 'node:assert/strict';
import type { AnimalView, PersonView, StructureView, WorldStats, WorldView } from '../src/shared/types.js';
import type { ChemicalFormulaView } from '../src/shared/chemistry.js';
import type { WorldDirectoryResponse } from '../src/shared/worldmap.js';
import type { OrganizationSummary } from '../src/shared/organization.js';
import { renderMundoDeepStats, summarizeMundo, type MundoTab } from '../src/client/mundo-dashboard.js';

const tabs: MundoTab[] = ['life', 'land', 'communities', 'technology', 'performance'];

function person(id = 'p'): PersonView {
  return { id, name: `Persona ${id}`, role: 'neighbor', x: 2, y: -3, color: '#abc', action: 'craft', reason: 'Trabaja',
    energy: .8, hunger: .2, fatigue: .1, need: '', recentMemory: null, communityId: null, craftFocus: 'Cerámica',
    genome: { generation: 3, parents: [], learningRate: .5, cooperation: .5, mutations: 1 } };
}

function animal(id: string, extra: Partial<AnimalView> = {}): AnimalView {
  return { id, species: 'deer', x: 1, y: 2, action: 'graze', reason: '', hunger: .1, thirst: .1, energy: .8,
    fatigue: .1, health: 1, generation: 2, parents: [], age: 400,
    genes: { speed: .5, perception: .5, metabolism: .5, carnivory: 0, waterEfficiency: .5, camouflage: .5 },
    morphology: { coat: .2, size: .4, defense: .6, caution: .8 }, habituation: .45, tends: 3, ...extra };
}

function structure(id = 'hall'): StructureView {
  return { id, name: `Obra ${id}`, x: -10, y: 7, blueprintId: 'b', components: ['frame', 'hearth'], condition: .83,
    water: 0, food: 0, uses: 4, builtAt: 100, builderId: null,
    cells: [{ x: -10, y: 7 }, { x: -9, y: 7 }, { x: -8, y: 7 }],
    materialProfile: { tint: '#bada55', strength: .8, insulation: .7, seal: .5 },
    synergy: { sharedEdges: 2, heated: true, irrigated: false, workshopBonus: .2, kilnTier: 2 } };
}

function formula(index = 0): ChemicalFormulaView {
  return { id: `formula-${index}`, signature: `sig-${index}`, name: `Fórmula ${index}`, phase: 'smelted', temperatureTier: 2,
    operator: 'heat', discoveredAt: 120, discovererId: 'p', uses: index + 1,
    composition: { C: .1, Si: .2, Ca: .3, Fe: .15, S: .05, H: .2 },
    properties: { colorHex: '#c0ffee', hardness: .91, toughness: .82, seal: .73, insulation: .64, fuelPower: .55, fertility: .46, lightness: .37 } };
}

function stats(): WorldStats {
  return { population: 123, meanEnergy: .8, meanHunger: .2, meanFatigue: .1, meanThirst: .3, materials: { wood: 10, stone: 3 },
    actions: {}, biomes: {}, features: {}, totals: { births: 40 }, generations: { '0': 5, '8': 118, '999': 0 }, history: [],
    scope: 'active-regions', wildlife: { deer: 100 }, freshWater: 12.5, cultivatedTiles: 30, trailTiles: 40,
    pavedTiles: 20, polyominoStructures: 5, synergyLinks: 7, distanciaMediaAgua: 2.75, regionesSinAgua: .25,
    fraccionCeldasConComida: .6, giniRecursosPorRegion: .321, diversidad: { conducta: .61, oficios: .42, total: .53 },
    census: { neighbors: 121, identities: 2, protectedCount: 2, lifeStage: { juvenile: 20, adult: 90, senescent: 10, unknown: 1 } },
    animalDynamics: { births: 10, deaths: 6, humanHunts: 2, predations: 4, plantConsumed: 3, waterConsumed: 2 } };
}

function organization(): OrganizationSummary {
  return { window: { startTick: 4000, endTick: 4800, complete: true }, boundary: 'not-modeled', autopoiesisEstablished: false,
    foodClosure: [], maximalRaf: [], constructibleFromFood: [],
    processes: [{ id: 'Proceso alfa', executions: 10, fluxPerTick: .0125, foodGenerated: false, structuralRaf: false,
      constructibleFromFood: false, viableNow: false, maintained: false, blockers: [], ancestorDepth: 0 }],
    structuralDependencies: [], observedDependencies: [], structuralComponents: [], observedComponents: [], maintainedComponents: [],
    evidence: { executed: 12, successful: 10, rejected: [], ignoredOutsideWindow: 0, balanced: true, failures: [] },
    maintenance: { requiredResources: [], depletedResources: [], externallySuppliedNonFood: [], unproducedCatalysts: [],
      catalystReplacementCoverage: null, catalystsWithCompleteTurnover: [] },
    diversity: { activeProcesses: 2, effectiveProcesses: 1.5, activeActors: 3, maxAncestorDepth: 0, unresolvedLineage: [] },
    actorActivity: [], actorRoles: [] };
}

function legacy(): WorldView {
  return { version: 10, sequence: 0, tick: 4800, day: 3, phase: 'day', weather: 'clear', width: 2, height: 2,
    tiles: [], people: [], places: [], events: [], memories: [] };
}

function rich(): WorldView {
  const capacities = { cutting: .7, storage: .3, insulation: .2, cultivation: .1, binding: .4, abrasion: .5 };
  return { ...legacy(), people: [person(), person('q')], stats: stats(), discoveredChunks: 400, activeChunks: 25, settlementCount: 17,
    animals: [animal('a'), animal('b', { habituation: .8, tends: 7, morphology: { coat: .6, size: .8, defense: .2, caution: .4 } }),
      animal('c', { species: 'wolf', habituation: .449, tends: 2, morphology: { coat: .9, size: .1, defense: .3, caution: .7 } }),
      animal('legacy-animal', { morphology: undefined, habituation: 0, tends: 1 })],
    demography: { deaths: 11, causes: { starvation: 8, dehydration: 3 }, recent: [] },
    structures: [structure()],
    communities: [
      { id: 'small', name: 'Clan pequeño', x: 1, y: 2, color: '#abc', members: ['p', 'q'], memberCount: 9, formedAt: 2400,
        cooperation: 10, disputes: 2, culture: { sharing: .9, stewardship: .5, openness: .2 } },
      { id: 'large', name: 'Clan grande', x: -4, y: 6, color: '#fed', members: [], memberCount: 80, formedAt: 0,
        cooperation: 12, disputes: 3, culture: { sharing: .2, stewardship: .8, openness: .4 } },
    ],
    chemistry: { formulas: Array.from({ length: 10 }, (_, i) => formula(i)), totalFormulas: 99, totalLots: 34, maxTemperatureTier: 2,
      byOperator: { grind: 10, wash: 20, heat: 30, bind: 40 } },
    technology: {
      recipes: [], items: [
        { id: 'tool-a', ownerId: 'p', x: 0, y: 0, recipeId: null, mass: 10, generation: 1, capacities, materialTint: '#abc' },
        { id: 'tool-b', ownerId: 'q', x: 0, y: 0, recipeId: null, mass: 20, generation: 2, capacities, materialTint: '#def' },
        { id: 'plain', ownerId: 'p', x: 0, y: 0, recipeId: null, mass: 30, generation: 0, capacities },
      ],
      dynamics: { attempts: 100, failures: 9, recipes: 27, products: 58, generations: 3, toolUses: 87, observedUtility: .4,
        shared: 33, importedMass: 100, productMass: 80, residueMass: 20, massError: 0, work: 40, energy: 30,
        programDiversity: .3, functionalDiversity: .2, reusedProducts: 5, historyDropped: 0, estateLostMass: 0 },
      budgets: { maxRecipes: 100, maxSteps: 8, maxInputs: 4, maxItems: 100, maxHistory: 100, maxGeneration: 20, maxMassPerInput: 100 },
    },
    organization: organization(),
    whispers: [
      { id: 'w0', createdTick: 1, createdDay: 1, personId: 'p', personName: 'Persona p', intent: 'tend', x: -7, y: 8, note: 'Cuida el rebaño', status: 'latent' },
      { id: 'w1', createdTick: 2, createdDay: 1, personId: null, intent: 'explore', x: 9, y: -10, note: 'Mira el valle', status: 'heard', heardByName: 'Persona q' },
      { id: 'w2', createdTick: 3, createdDay: 1, personId: null, intent: 'build', x: 11, y: 12, note: 'Ya ocurrió', status: 'fulfilled' },
      { id: 'w3', createdTick: 4, createdDay: 1, personId: null, intent: 'craft', x: 13, y: 14, note: 'Se desvaneció', status: 'faded' },
    ],
    performance: { stepMs: 12.25, p95StepMs: 18, saveMs: 1.1, projectionMs: .6, snapshotBytes: 4096, activeTiles: 6400,
      processRssMiB: 321.5, tickHz: 81.63, tickHzObjetivo: 100, cloneMs: .9, simulationMs: 10.25,
      fraccionSerial: .4, fraccionSerialReal: .25, ocupacionWorkers: .75, tiempoParaleloMs: 8.1, tiempoBarreraMs: .15,
      fases: { maintainRegions: 0, ecologia: 1, kernel: 0, fauna: 0, personas: 0, encuentros: 0, demografia: 0,
        comunidades: 0, reproduccion: 0, checkpoint: 0, muestreo: 0, save: 0, broadcast: 0 },
      gobernador: { activo: true, presupuestoMs: 50, p95StepMs: 18, manual: null, p50Ms: 12, p95Ms: 18, p99Ms: 21,
        maxMs: 24, faseMax: 'personas', teselasPorHabitante: 52.033,
        fasesP95: { ecologia: 2.25, kernel: 1.15, fauna: 3.75, personas: 7.5, encuentros: .95, demografia: .45, save: 1.25 } },
    },
  };
}

function directory(world = rich()): WorldDirectoryResponse {
  return { tick: world.tick, day: world.day, totalPeople: 999, totalAnimals: 100, totalTameAnimals: 40,
    totalStructures: 20, totalPolyominoes: 5,
    people: [...world.people, { ...person('outside'), communityId: 'large' }].map(p => ({
      id: p.id, name: p.name, role: p.role, x: p.x, y: p.y, action: p.action, age: 300, generation: p.genome?.generation ?? 0,
      communityId: p.communityId ?? null, hunger: p.hunger, energy: p.energy,
    })),
    communities: world.communities!.map(c => ({ id: c.id, name: c.name, x: c.x, y: c.y, color: c.color,
      memberCount: c.memberCount!, cooperation: c.cooperation, disputes: c.disputes })),
    structures: [{ id: 'directory-hall', name: 'Salón lejano', x: 80, y: -90, cells: 6, kilnTier: 2, condition: .94, tint: '#12345678' }], herds: [] };
}

// Assert the displayed value, rather than merely finding its digits somewhere in the HTML.
function card(html: string, label: string, value: string): void {
  assert.ok(html.includes(`<span>${label}</span><strong>${value}</strong>`), `${label}: expected ${value}`);
}
function fact(html: string, label: string, value: string): void {
  const plain = `<span>${label}<strong>${value}</strong></span>`;
  const wrapping = `<span style="flex-wrap:wrap">${label}<strong style="white-space:normal;overflow-wrap:anywhere">${value}</strong></span>`;
  assert.ok(html.includes(plain) || html.includes(wrapping), `${label}: expected ${value}`);
}
function clean(html: string): void {
  assert.doesNotMatch(html, /\b(?:undefined|NaN|Infinity)\b/);
  assert.doesNotMatch(html, /<script|<img|<svg|<iframe/i);
  // An escaped attack inside a quoted data attribute is text, not an event handler.
  for (const tag of html.match(/<\/?[a-z][^<>]*>/gi) ?? []) {
    assert.doesNotMatch(tag.replace(/"[^"]*"|'[^']*'/g, ''), /\son\w+\s*=/i);
  }
}

test('summary counts exactly the received population, habituated fauna, tending, tints and whisper states', () => {
  const w = rich(), d = directory(w);
  assert.deepEqual(summarizeMundo(w, d), { livingCount: 123, tameCount: 2, totalTends: 13, forgedTools: 2,
    activeWhispers: 2, heardWhispers: 1, fulfilledWhispers: 1 });
  delete w.stats;
  assert.equal(summarizeMundo(w, d).livingCount, 3, 'use directory.people.length, not totalPeople or camera length');
  assert.equal(summarizeMundo(w, null).livingCount, 2);
  assert.equal(summarizeMundo({ ...w, stats: { ...stats(), population: 0 } }, d).livingCount, 0);
  assert.deepEqual(summarizeMundo(legacy()), { livingCount: 0, tameCount: 0, totalTends: 0, forgedTools: 0,
    activeWhispers: 0, heardWhispers: 0, fulfilledWhispers: 0 });
});

test('life renders global census, exact species means and only active whisper coordinate links', () => {
  const w = rich(), html = renderMundoDeepStats(w, 'life', directory(w));
  clean(html);
  for (const [label, value] of [['Vivos', '123'], ['S/I protegidos', '2'], ['Vecinos', '121'], ['Jóvenes', '20'],
    ['Adultos', '90'], ['Mayores', '10'], ['Sin etapa registrada', '1'], ['Nacimientos', '40'], ['Muertes', '11'],
    ['Generación más alta · censo', '8'], ['Diversidad · conducta', '61%'], ['Diversidad · oficios', '42%'], ['Diversidad · total', '53%'],
    ['Latentes', '1'], ['Escuchados', '1'], ['Cumplidos', '1'], ['Desvanecidos', '1']]) card(html, label, value);
  const deer = html.slice(html.indexOf('Venados'), html.indexOf('Lobos'));
  for (const [label, value] of [['Pelaje medio', '40%'], ['Talla media', '60%'], ['Defensa media', '40%'], ['Cautela media', '60%']]) fact(deer, label, value);
  fact(html, 'Habituados / mansos en vista (≥ 0,45)', '2'); fact(html, 'Cuidados no letales en vista', '13');
  fact(html, 'Caza humana acumulada', '2'); fact(html, 'Depredaciones acumuladas', '4');
  assert.match(html, /Falta de alimento.*8/); assert.match(html, /Falta de agua.*3/);
  assert.match(html, /data-place-x="-7" data-place-y="8"/); assert.match(html, /data-place-x="9" data-place-y="-10"/);
  assert.doesNotMatch(html, /data-place-x="11"|data-place-x="13"/);
  assert.match(html, /Cuida el rebaño/); assert.equal((html.match(/data-whisper=/g) ?? []).length, 2);
});

test('land uses received infrastructure, honest water sentinel, and global or visible structure catalogues', () => {
  const w = rich(), html = renderMundoDeepStats(w, 'land', directory(w));
  clean(html);
  for (const [label, value] of [['Calzadas pavimentadas', '20'], ['Senderos', '40'], ['Cultivos', '30'], ['Salones poliominó', '5'],
    ['Sinergias entre obras', '7'], ['Regiones descubiertas', '400'], ['Regiones activas', '25']]) card(html, label, value);
  fact(html, 'Agua dulce', '12,5'); fact(html, 'Distancia media al agua potable', '2,75 celdas');
  fact(html, 'Regiones sin agua', '25%'); fact(html, 'Celdas con comida', '60%'); fact(html, 'Gini de recursos por región', '0,321');
  fact(html, 'Celdas', '6'); fact(html, 'Condición', '94%'); assert.match(html, /background:#12345678/);
  assert.match(html, /Salón lejano/); assert.doesNotMatch(html, /Obra hall/); assert.match(html, /data-place-x="80" data-place-y="-90"/);
  const visible = renderMundoDeepStats(w, 'land');
  assert.match(visible, /Obra hall/); fact(visible, 'Celdas', '3'); fact(visible, 'Condición', '83%');
  w.stats!.distanciaMediaAgua = -1;
  fact(renderMundoDeepStats(w, 'land'), 'Distancia media al agua potable', 'Sin fuente potable en las celdas cargadas');
  delete w.stats!.distanciaMediaAgua;
  fact(renderMundoDeepStats(w, 'land'), 'Distancia media al agua potable', '—');
});

test('community comparison ranks by global members, computes age and ratios, and preserves unknown culture', () => {
  const w = rich(), d = directory(w), html = renderMundoDeepStats(w, 'communities', d);
  clean(html);
  assert.ok(html.indexOf('Clan grande') < html.indexOf('Clan pequeño'));
  card(html, 'Asentamientos globales', '17'); card(html, 'Comunidades recibidas', '2');
  card(html, 'Sin comunidad · directorio global', '2'); card(html, 'Cooperaciones agregadas', '22'); card(html, 'Disputas agregadas', '5');
  fact(html, 'Miembros', '80'); fact(html, 'Miembros', '9'); fact(html, 'Edad', '2 días'); fact(html, 'Edad', '1 día');
  fact(html, 'Eje cultural dominante', 'Cuidado (80%)'); fact(html, 'Eje cultural dominante', 'Compartir (90%)');
  fact(html, 'Cooperación / disputa', '4'); fact(html, 'Cooperación / disputa', '5');
  assert.match(html, /data-place-x="-4" data-place-y="6"/);
  delete w.communities;
  const unknown = renderMundoDeepStats(w, 'communities', d);
  fact(unknown, 'Eje cultural dominante', '—'); fact(unknown, 'Edad', '—');
  d.communities[0].disputes = 0; fact(renderMundoDeepStats(w, 'communities', d), 'Cooperación / disputa', '—');
});

test('chemistry renders eight ranked swatches, all six elements and seven properties, craft and observed flux', () => {
  const w = rich(), html = renderMundoDeepStats(w, 'technology', directory(w));
  clean(html);
  card(html, 'Fórmulas descubiertas', '99'); card(html, 'Lotes activos', '34'); card(html, 'Mayor nivel de horno', 'T2 horno');
  for (const label of ['Molienda', 'Lavado', 'Cocción', 'Mezcla']) assert.ok(html.includes(label));
  assert.equal((html.match(/data-formula=/g) ?? []).length, 8);
  assert.ok(html.indexOf('Fórmula 9') < html.indexOf('Fórmula 8'));
  assert.doesNotMatch(html, /data-formula="formula-[01]"/); assert.match(html, /background:#c0ffee/);
  const f = html.slice(html.indexOf('data-formula="formula-9"'), html.indexOf('data-formula="formula-8"'));
  fact(f, 'Fase térmica', 'Fundido'); fact(f, 'Usos', '10');
  for (const [label, value] of [['C', '10%'], ['Si', '20%'], ['Ca', '30%'], ['Fe', '15%'], ['S', '5%'], ['H', '20%'],
    ['Dureza', '91%'], ['Tenacidad', '82%'], ['Sellado', '73%'], ['Aislamiento', '64%'], ['Combustible', '55%'], ['Fertilidad', '46%'], ['Ligereza', '37%']]) fact(f, label, value);
  card(html, 'Objetos químicos con tinte recibido', '2'); card(html, 'Recetas registradas', '27'); card(html, 'Productos fabricados', '58');
  assert.match(html, /Cerámica/); assert.match(html, /Persona p/);
  fact(html, 'Ejecuciones observadas', '12'); fact(html, 'Ejecuciones exitosas', '10');
  assert.match(html, /Proceso alfa/); assert.match(html, /0,0125/); assert.match(html, /ejecuciones\/paso/);
});

test('performance exposes every hardware measurement and descending p95 phases with exact decimals', () => {
  const w = rich();
  w.performance!.gobernador!.fasesP95!.checkpoint = .123456789;
  const html = renderMundoDeepStats(w, 'performance');
  clean(html);
  for (const [label, value] of [['Frecuencia real', '81,63 Hz'], ['Frecuencia objetivo', '100 Hz'], ['Paso actual', '12,25 ms'],
    ['p50', '12 ms'], ['p95', '18 ms'], ['p99', '21 ms'], ['Máximo', '24 ms'], ['Fase del máximo', 'personas'],
    ['Ocupación de workers', '75%'], ['Fracción serial real', '25%'], ['Tiempo paralelo', '8,1 ms'], ['Tiempo de barrera', '0,15 ms'],
    ['Clon', '0,9 ms'], ['Simulación', '10,25 ms'], ['Guardado', '1,1 ms'], ['Proyección', '0,6 ms'],
    ['Memoria RSS', '321,5 MiB'], ['Instantánea', '4 KiB'], ['Teselas activas', '6.400'], ['Teselas por habitante', '52,033']]) card(html, label, value);
  const phases = html.slice(html.indexOf('Desglose por fase'));
  assert.match(phases, /p95 ms/); assert.match(phases, /0,123456789/);
  assert.ok(phases.indexOf('personas') < phases.indexOf('fauna'));
  assert.ok(phases.indexOf('fauna') < phases.indexOf('ecologia'));
  assert.ok(phases.indexOf('ecologia') < phases.indexOf('save'));
  assert.match(phases, /width:100\.0000%/);
  delete w.performance!.gobernador!.fasesP95;
  const fallback = renderMundoDeepStats(w, 'performance');
  assert.match(fallback, /Desglose por fase \(último paso, ms\)/);
  assert.match(fallback, /no envió p95 por fase/);
  assert.doesNotMatch(fallback, /Desglose por fase \(p95 ms\)/);
});

test('all five tabs handle empty/legacy data with explicit unknowns, without fabricated measurements', () => {
  const w = legacy();
  for (const tab of tabs) for (const d of [undefined, null]) {
    const html = renderMundoDeepStats(w, tab, d);
    clean(html); assert.match(html, /—/); assert.match(html, /stats-section-heading/);
  }
  const life = renderMundoDeepStats(w, 'life');
  card(life, 'Vivos', '0'); card(life, 'Latentes', '—'); card(life, 'Nacimientos', '—');
  assert.match(life, /Todavía no llegaron animales con morfología/);
  assert.doesNotMatch(life, /Pelaje medio|Defensa media/);
  fact(life, 'Cuidados no letales en vista', '—');
  w.animals = [animal('old', { morphology: undefined, habituation: undefined, tends: undefined })];
  const oldAnimals = renderMundoDeepStats(w, 'life');
  fact(oldAnimals, 'Habituados / mansos en vista (≥ 0,45)', '—'); fact(oldAnimals, 'Cuidados no letales en vista', '—');
  const tech = renderMundoDeepStats(w, 'technology');
  assert.match(tech, /Química no recibida/); card(tech, 'Fórmulas descubiertas', '—'); card(tech, 'Objetos químicos con tinte recibido', '—');
  card(renderMundoDeepStats(w, 'performance'), 'Paso actual', '—');
});

test('known empty collections and real zeros stay distinguishable from missing telemetry', () => {
  const w = legacy();
  w.whispers = []; w.animals = []; w.communities = []; w.structures = [];
  const life = renderMundoDeepStats(w, 'life'); card(life, 'Latentes', '0'); fact(life, 'Cuidados no letales en vista', '0');
  card(renderMundoDeepStats(w, 'communities'), 'Cooperaciones agregadas', '0');
  assert.match(renderMundoDeepStats(w, 'land'), /No hay grandes obras identificables/);
  const full = rich(); full.chemistry!.formulas = []; full.chemistry!.totalFormulas = 0;
  full.chemistry!.maxTemperatureTier = 0; full.chemistry!.byOperator = { grind: 0, wash: 0, heat: 0, bind: 0 };
  const tech = renderMundoDeepStats(full, 'technology');
  card(tech, 'Fórmulas descubiertas', '0'); card(tech, 'Mayor nivel de horno', 'T0 frío');
  assert.match(tech, /width:0\.0000%/);
});

test('partial chemistry keeps absent V23 properties unknown and handles every kiln tier', () => {
  const w = rich(); w.chemistry!.formulas = [formula()];
  delete w.chemistry!.formulas[0].properties.fertility; delete w.chemistry!.formulas[0].properties.lightness;
  const html = renderMundoDeepStats(w, 'technology');
  fact(html, 'Fertilidad', '—'); fact(html, 'Ligereza', '—');
  w.chemistry!.maxTemperatureTier = 1;
  card(renderMundoDeepStats(w, 'technology'), 'Mayor nivel de horno', 'T1 hoguera');
});

test('legacy member counts, unknown affiliation and missing footprint do not invent global facts', () => {
  const w = rich(); delete w.communities![0].memberCount;
  delete w.people[0].communityId; delete w.structures![0].cells;
  const html = renderMundoDeepStats(w, 'communities');
  fact(html, 'Miembros', '2'); card(html, 'Sin comunidad · en vista', '—');
  const land = renderMundoDeepStats(w, 'land'); fact(land, 'Celdas', '—');
  w.structures![0].footprint = { width: 2, height: 2 };
  fact(renderMundoDeepStats(w, 'land'), 'Celdas', '4');
});

const attack = `<img src=x onerror="alert('x')">&</script><script>alert(1)</script>`;
const escapedAttack = '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;';

test('XSS is escaped in formula names/IDs, person names, craft focuses, causes and organization IDs', () => {
  const w = rich();
  w.chemistry!.formulas = [{ ...formula(), id: attack, name: attack, properties: { ...formula().properties, colorHex: `#abc\" onmouseover=\"alert(1)` } }];
  w.people[0].name = attack; w.people[0].craftFocus = attack;
  w.demography!.causes = { [attack]: 3 }; w.organization!.processes[0].id = attack;
  const html = renderMundoDeepStats(w, 'technology');
  clean(html); assert.ok(html.includes(escapedAttack));
  assert.ok(html.includes(`data-formula="${escapedAttack}"`));
  assert.ok(html.includes(`>${escapedAttack}</button>`), 'person name is escaped in a real rendered link');
  assert.match(html, /background:#7a8c67/); assert.doesNotMatch(html, /onmouseover/);
  const life = renderMundoDeepStats(w, 'life'); clean(life); assert.ok(life.includes(escapedAttack));
});

test('XSS is escaped in whisper texts, names and IDs, community names and directory structure names', () => {
  const w = rich(), d = directory(w);
  Object.assign(w.whispers![0], { id: attack, note: attack, personName: attack, heardByName: attack });
  const life = renderMundoDeepStats(w, 'life', d); clean(life);
  assert.ok(life.includes(`data-whisper="${escapedAttack}"`)); assert.ok(life.includes(`Para ${escapedAttack}`));
  assert.ok(life.includes(`Escuchado por ${escapedAttack}`));
  Object.assign(w.communities![0], { id: attack, name: attack, color: attack });
  const community = renderMundoDeepStats(w, 'communities'); clean(community); assert.ok(community.includes(escapedAttack));
  assert.match(community, /background:#7a8c67/);
  Object.assign(d.communities[0], { id: attack, name: attack, color: attack });
  Object.assign(d.structures[0], { id: attack, name: attack, tint: attack });
  for (const tab of ['land', 'communities'] as const) {
    const html = renderMundoDeepStats(w, tab, d); clean(html); assert.ok(html.includes(escapedAttack));
    assert.match(html, /background:#7a8c67/);
  }
});

test('hex validation rejects CSS/attribute escapes and permits only the specified hex pattern', () => {
  const w = rich(); w.chemistry!.formulas = [formula()];
  for (const color of ['red', '#ab', '#abcdefghi', '#abc;position:fixed', '#abc" onclick="bad', '#abc\n', 'url(javascript:alert(1))', attack]) {
    w.chemistry!.formulas[0].properties.colorHex = color;
    const html = renderMundoDeepStats(w, 'technology'); clean(html);
    assert.match(html, /background:#7a8c67/); assert.doesNotMatch(html, /background:#abc[;"\n]/);
  }
  for (const color of ['#abc', '#AbCd', '#abcde', '#C0ffEE', '#1234567', '#12345678']) {
    w.chemistry!.formulas[0].properties.colorHex = color;
    assert.ok(renderMundoDeepStats(w, 'technology').includes(`background:${color}"`));
  }
});

test('all tabs and summary leave received world and directory unchanged', () => {
  const w = rich(), d = directory(w), before = structuredClone({ w, d });
  for (const tab of tabs) renderMundoDeepStats(w, tab, d);
  summarizeMundo(w, d); assert.deepEqual({ w, d }, before);
});

test('community age pluralizes by the rounded displayed value, not by exact tick equality', () => {
  const w = rich(), c = w.communities![0];
  c.formedAt = 0; w.tick = 2401;
  fact(renderMundoDeepStats(w, 'communities'), 'Edad', '1 día');
  w.tick = 4800;
  fact(renderMundoDeepStats(w, 'communities'), 'Edad', '2 días');
});
