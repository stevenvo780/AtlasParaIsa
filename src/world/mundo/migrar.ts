import { type WorldContext, type World, RULES_VERSION } from './tipos.js';
import { assertWorld, assertCommon } from './validar.js';
import { seededTraits, initializePerson } from './crear.js';
import { enableChronicleJournal } from '../chronicle-journal.js';
import { catalogueEnabled } from '../technology-catalogue.js';
import { maintainTechnologyMemory, defaultTechnologyState, initialTechnologyKnowledge } from '../technology.js';
import { cloneWorld } from '../clon.js';
import { captureTechnologyCheckpoint } from '../technology-checkpoint.js';
import { setParams, paramsOf } from '../params.js';
import { bindWorldContext } from '../spatial.js';
import { generateChunk, chunkKey, legacyStructures } from '../terrain.js';
import { emptyTotals } from '../statistics.js';
import { initializeEcosystem } from '../ecosystem.js';
import { materializeAnimals } from '../animals.js';
import { defaultBlueprint } from '../inventions.js';
import { initialDemography } from '../demography.js';
import { emptyWaterLedger } from '../technology-water.js';


/** V1/V2 conversion preserves existing fields and initializes only newly introduced mechanisms. */
export function migrateWorld(value: unknown, context: WorldContext = {}): World {
  const world = migrateWorldState(value, context);
  enableChronicleJournal(world);
  return world;
}


function migrateWorldState(value: unknown, context: WorldContext = {}): World {
  const version = (value as { version?: unknown } | null)?.version;
  if (version === RULES_VERSION) {
    assertWorld(value, RULES_VERSION, context);
    if (value.technology.checkpoint !== undefined) {
      if (catalogueEnabled(value.technology)) for (const person of value.people) maintainTechnologyMemory(value, person);
      return value;
    }
    const world = cloneWorld(value, context);
    world.technology.checkpoint = captureTechnologyCheckpoint(world.technology, world.people, world.tick, 'migration');
    if (catalogueEnabled(world.technology)) for (const person of world.people) maintainTechnologyMemory(world, person);
    assertWorld(world); return world;
  }
  if (version === 13) {
    assertWorld(value, 13, context);
    const world = cloneWorld(value, context); upgradeV14(world);
    return migrateWorldState(world, context);
  }
  if (version === 12) {
    // V12 → V13 sólo etiqueta: los interruptores V19 ausentes de sus params cargan apagados
    // (`readSnapshotParams` completa con `HISTORICAL_PARAMS`) y el estado V19 opcional queda ausente.
    assertWorld(value, 12, context);
    const world = cloneWorld(value, context); upgradeV13(world);
    return migrateWorldState(world, context);
  }
  if (version === 11) {
    assertWorld(value, 11, context);
    const world = cloneWorld(value, context); upgradeV12(world);
    return migrateWorldState(world, context);
  }
  if (version === 10) {
    // V10 → V11 sólo cambia la etiqueta; la rama de la versión vigente aplica después la misma
    // normalización de carga que recibía un mundo V10 con el código de reglas 10.
    assertWorld(value, 10, context);
    const world = cloneWorld(value, context); upgradeV11(world);
    return migrateWorldState(world, context);
  }
  if (version === 9) {
    assertWorld(value, 9, context);
    const world = cloneWorld(value, context); upgradeV10(world);
    return migrateWorldState(world, context);
  }
  if (version === 8) {
    assertWorld(value, 8, context);
    const world = cloneWorld(value, context); upgradeV9(world); upgradeV10(world);
    return migrateWorldState(world, context);
  }
  if (version === 7) {
    assertWorld(value, 7, context);
    const world = cloneWorld(value, context); upgradeV8(world);
    return migrateWorldState(world, context);
  }
  if (version === 6) {
    // Recovery tools may read a valid old world without rewriting its history or
    // founders. Published test versions still start a separate world by policy.
    assertWorld(value, 6, context);
    const world = cloneWorld(value, context); upgradeV7(world); upgradeV8(world);
    return migrateWorldState(world, context);
  }
  if (version === 5) {
    assertWorld(value, 5, context);
    const world = cloneWorld(value, context); upgradeV6(world); upgradeV7(world); upgradeV8(world); upgradeV9(world); upgradeV10(world); upgradeV11(world); upgradeV12(world); upgradeV13(world); upgradeV14(world);
    if (world.technology.checkpoint === undefined) world.technology.checkpoint = captureTechnologyCheckpoint(world.technology, world.people, world.tick, 'migration');
    if (catalogueEnabled(world.technology)) for (const person of world.people) maintainTechnologyMemory(world, person);
    assertWorld(world); return world;
  }
  if (version===4) { assertWorld(value,4,context); const world=cloneWorld(value,context); upgradeV5(world); upgradeV6(world); upgradeV7(world); upgradeV8(world); upgradeV9(world); upgradeV10(world); upgradeV11(world); upgradeV12(world); upgradeV13(world); upgradeV14(world); assertWorld(world); return world; }
  if(version===3) {
    assertWorld(value,3,context);
    const world=cloneWorld(value,context); upgradeV4(world); upgradeV5(world); upgradeV6(world); upgradeV7(world); upgradeV8(world); upgradeV9(world); upgradeV10(world); upgradeV11(world); upgradeV12(world); upgradeV13(world); upgradeV14(world); assertWorld(world); return world;
  }
  if (version === 2) {
    assertWorld(value, 2, context);
    const world = cloneWorld(value, context);
    upgradeV3(world); upgradeV4(world); upgradeV5(world); upgradeV6(world); upgradeV7(world); upgradeV8(world); upgradeV9(world); upgradeV10(world); upgradeV11(world); upgradeV12(world); upgradeV13(world); upgradeV14(world); assertWorld(world); return world;
  }
  assertCommon(value, true);
  const world = structuredClone(value);
  // V1 is the one migration that cannot use cloneWorld yet. Preserve its laws
  // before generating any terrain or ecosystem fields; WeakMaps do not clone.
  setParams(world, paramsOf(value));
  bindWorldContext(world, context);
  world.version = RULES_VERSION; world.chunks = {}; world.retiredChunks = [];
  world.discoveredChunks = 6; world.settlementCount = 0;
  world.adaptationEnabled = true; world.noveltyEnabled = true; world.shelterBenefitEnabled = true;
  const originalTiles = new Map(world.tiles.map(t => [`${t.x},${t.y}`, t]));
  world.tiles = [];
  for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 3; cx++) {
    // T035 ronda de arreglo: coherencia con `paramsOf` (equivalente hoy a `DEFAULT_PARAMS.agua
    // .cuencas`, ningún `World` migrado tiene params propios fijados todavía en este punto).
    const chunk = generateChunk(world.seed, cx, cy, paramsOf(world).agua.cuencas);
    const { tiles, ...meta } = chunk;
    meta.discovered = true; meta.lastTick = world.tick;
    meta.places = world.places.filter(p => chunkKey(p.x, p.y) === meta.key);
    world.chunks[meta.key] = meta;
    world.tiles.push(...tiles.map(t => ({ ...t, ...originalTiles.get(`${t.x},${t.y}`) })));
  }
  world.people.forEach((p, index) => {
    p.traits = { ...seededTraits(world.seed, index), curiosity: p.curiosity, sociability: p.sociability, care: p.generosity };
    p.skills = {}; p.values = {}; p.activity = {}; p.materials = { wood: 0, stone: 0 }; p.visited = [];
    p.heading = index * 2.399963229728653; p.command = null; p.work = 0; p.lastOutcome = world.tick; p.intentContext = p.hunger > 0.5 ? 'hungry' : p.fatigue > 0.5 ? 'tired' : 'ready'; p.controlMode = 'auto';
  });
  upgradeV3(world); upgradeV4(world); upgradeV5(world); upgradeV6(world); upgradeV7(world); upgradeV8(world); upgradeV9(world); upgradeV10(world); upgradeV11(world); upgradeV12(world); upgradeV13(world); upgradeV14(world); assertWorld(world); return world;
}

function upgradeV3(world: World): void {
  world.version = 3; world.cooperationEnabled = true; world.reproductionEnabled = true;
  world.communities = []; world.communityCounter = 0; world.birthCounter = 0; world.history = []; world.totals = emptyTotals();
  world.tiles = world.tiles.map(tile => initializeEcosystem(world.seed, tile, paramsOf(world).agua.cuencas));
  world.retiredChunks = world.retiredChunks.map(chunk => ({ ...chunk, tiles: chunk.tiles.map(tile => initializeEcosystem(world.seed, tile, paramsOf(world).agua.cuencas)) }));
  for (const person of world.people) initializePerson(world, person);
}

function upgradeV4(world: World): void {
  world.version=4;
  world.animals=materializeAnimals(world.seed,world.tiles,world.tick); world.animalCounter=0;
  world.animalDynamics={births:0,deaths:0,predations:0,humanHunts:0,waterConsumed:0,plantConsumed:0};
  world.blueprints=[defaultBlueprint()]; world.blueprintCounter=0; world.structureCounter=0;
  world.structures=legacyStructures(world.tiles,world.tick);
  world.inventionDynamics={attempts:0,accepted:0,repairs:0,waterCollected:0,foodStored:0,foodTaken:0};
  world.retiredChunks=world.retiredChunks.map(chunk=>({...chunk,lifeVersion:4,animals:materializeAnimals(world.seed,chunk.tiles,world.tick),structures:legacyStructures(chunk.tiles,world.tick)}));
}

function upgradeV5(world: World): void {
  world.version=5; world.technology=defaultTechnologyState(); world.legacy=[]; world.retiredLegacy=[];
  world.demographyDynamics={deaths:0,causes:{starvation:0,dehydration:0,exposure:0,senescence:0},foodLost:0,woodLost:0,stoneLost:0};
  for (const person of world.people) { person.technology=initialTechnologyKnowledge(); person.demography=initialDemography(world.tick-person.bornAt); }
  world.technology.checkpoint = captureTechnologyCheckpoint(world.technology, world.people, world.tick, 'migration');
}

function upgradeV6(world: World): void {
  world.version = 6; world.technology.water = emptyWaterLedger();
}

function upgradeV7(world: World): void { world.version = 7; }


function upgradeV8(world: World): void { world.version = 8; }

/** V9 changes only local family planning; stored bodies, work and resources remain historical. */
function upgradeV9(world: World): void { world.version = 9; }

/** V10 prepara las leyes nuevas; al migrar sólo cambia la etiqueta, el estado guardado queda intacto. */
function upgradeV10(world: World): void { world.version = 10; }

/** V11 adopta nuevos defaults sólo al crear mundos; al migrar no altera estado ni params. */
function upgradeV11(world: World): void { world.version = 11; }

/** V12 habilita leyes evolutivas y natalidad local opt-in; al migrar no altera estado ni params. */
function upgradeV12(world: World): void { world.version = 12; }

/** V13 (V19 fase 1) añade interruptores opt-in apagados por defecto; al migrar no altera estado ni params. */
function upgradeV13(world: World): void { world.version = 13; }

/** V14 (V20) añade caminos físicos, poliominós/sinergia y química emergente opt-in; al migrar conserva estado y params. */
function upgradeV14(world: World): void { world.version = 14; }
