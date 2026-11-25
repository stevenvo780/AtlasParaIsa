import { ROUTE_CELLS, needRatesScratch, type Candidate, ventajaComparativa, copyBody, bodilyShelter, bodilyDamage, immediateMeal, avoidedDamageScore, needRates, tileIsDesert, tileIsExposed, personById, canRecoverWaterHandling, soaCell, placeById, drinkingBody, RASGO_DEL_OFICIO, foodStock } from './sentidos.js';
import { type Person, type World, RADIUS, TICKS_PER_DAY } from '../mundo/tipos.js';
import { type Point, type TileLookup, distance, clamp } from '../mundo/geometria.js';
import { creditCausalOutcome, ensurePersonPolicy, localPolicyObservation } from './politica-persona.js';
import { MIN_FORAGE_STOCK, FORAGE_AMOUNT } from '../actuar/recursos.js';
import { forageDuration } from '../actuar/trabajo.js';
import { canTend, huntable, huntWorkDuration } from '../actuar/caza.js';
import { phaseAt, addEvent, remember } from '../mundo/crear.js';
import { WHISPER_INTENT_LABEL } from '../actuar/gestos.js';
import type { Tile, Action } from '../../shared/types.js';
import { type BodyState, type BodyRates, assimilateFood, exertBody, hydrateBody, restBody } from '../body.js';
import { CELDAS_VENTANA, DISTANCIA_VENTANA, LADO_VENTANA, percepcionDe } from './percepcion.js';
import { CONSULTA, UMBRAL } from './planes.js';
import { type ResidentFastAccess, residentFastAccess } from '../soa/terreno.js';
import { tileLookup } from '../tile-index.js';
import { paramsOf } from '../params.js';
import { containedWaterQuanta, canHandleContainedWater } from '../technology-water.js';
import { vecinos } from '../rejilla.js';
import { settlementOpportunity, cooperationOpportunity, updateCulturalNormsOnOutcome } from '../society.js';
import { foodAvailable, waterAvailable, REST_FATIGUE_RATE, REST_ENERGY_RATE, constructionCost, constructionOpportunity, modularBuildReady, inventionOpportunity, repairOpportunity } from '../inventions.js';
import { HAMBRE_POR_UNIDAD } from '../ecologia-constantes.js';
import { familyOpportunity, observedForagersByCell, earlierForagerExhausts, reproductiveReadiness, closeKin, availableToShare } from '../family.js';
import { filtrarCerca, algunoCerca, primeroCerca } from '../indice-puntos.js';
import { demographicTraits, updateDemography } from '../demography.js';
import { advanceNeeds } from '../needs.js';
import { WATER_QUANTA_PER_UNIT } from '../material-affordances.js';
import { type Animal, animalesVivosEnCelda, animalBiomass } from '../animals.js';
import { technologyOpportunity } from '../technology.js';
import { FOOD_PER_ANIMAL } from '../ecosystem.js';
import { evaluatePolicySingle, policyActionBias, updatePolicyPlasticity } from '../politica.js';
import { activeWhisperForPerson } from '../whispers.js';


const chooseNearby: Tile[] = [], chooseNearbyCells: number[] = [], chooseReachable: Tile[] = [], chooseReachableCells: number[] = [];

const chooseHuntOrder = new Int16Array(256);

const chooseNearbySteps = new Int16Array(ROUTE_CELLS), chooseNearbyDist = new Float64Array(ROUTE_CELLS);

const chooseReachableSteps = new Int16Array(ROUTE_CELLS), chooseReachableDist = new Float64Array(ROUTE_CELLS);

const choosePeople: Person[] = [];

const chooseBody: BodyState = { hunger: 0, thirst: 0, fatigue: 0, energy: 0 };

const chooseForecast: BodyState = { hunger: 0, thirst: 0, fatigue: 0, energy: 0 };

const choosePaid: BodyState = { hunger: 0, thirst: 0, fatigue: 0, energy: 0 };

const chooseWorst: BodyRates = { ...needRatesScratch };

function planAffordable(person: Person, payload: number, steps: number, work: number): boolean {
  return person.energy >= steps * (.0008 + payload * .0008) + work * .0003
    && person.fatigue + steps * (.0007 * (1.2 - person.traits.resilience * .4) + payload * .0007) + work * .00025 * (1.2 - person.traits.resilience * .4) < 1;
}

let chooseDepth = 0;

/**
 * Decide la siguiente acción y objetivo de `person` (F3 de ARQ-motor). Lo regular de su ventana r = 7 (pasos BFS, la
 * mejor celda de cada consulta y las utilidades del cerebro) llega ya percibido en F2 (`percepcion.ts`) sobre el estado
 * al empezar la fase de personas; aquí quedan los candidatos fríos, que leen el estado privado, y la elección.
 * Lo percibido se acepta solo si sigue valiendo ahora: si alguien cambió su disco antes en este tick, la fila se percibe
 * de nuevo sobre el estado vivo (`filaDe`), y una celda ganadora que no cumple la ley exacta o las condiciones propias
 * de la persona (esfuerzo asumible, fuente disputada, cisternas, lugares cercanos) se busca otra vez como siempre.
 * La pareja y quien tiene hambre salen de la lista viva de cercanos, como siempre.
 */
export function choose(world: World, person: Person, policyScores?: Map<string, Float64Array>, slot?: number, tileInArg?: TileLookup, fastArg?: ResidentFastAccess | null): void {
  const depth = ++chooseDepth;
  try {
  const own = depth === 1;
  if (own) { chooseNearby.length = 0; chooseNearbyCells.length = 0; chooseReachable.length = 0; chooseReachableCells.length = 0; }
  const nearbyTiles = own ? chooseNearby : [];
  const nearbyCells = own ? chooseNearbyCells : [];
  const tileIn = tileInArg ?? tileLookup(world.tiles);
  const fast = fastArg === undefined ? residentFastAccess(world.tiles) : fastArg ?? undefined;
  const params = paramsOf(world);
  // V19/L: un tramo de descanso se acredita con lo que el cuerpo recuperó DE VERDAD hasta esta nueva decisión.
  if (own && person.action === 'rest' && params.conducta.aprendizajeCausal && params.conducta.politicaPeso > 0 && world.adaptationEnabled) creditCausalOutcome(world, person, 'rest');
  const { salida, fila, terreno } = percepcionDe(world).filaDe(world.people, world.tick, person, slot, tileIn, fast, own);
  const ventana = salida.ventana, ventanaCelda = salida.ventanaCelda, base = fila * CELDAS_VENTANA;
  const celdaPercibida = (consulta: number): number => salida.celda[fila * salida.q + consulta]!;
  const percibida = (consulta: number): Tile | undefined => {
    const c = celdaPercibida(consulta);
    return c >= 0 ? terreno.teselas[c] : undefined;
  };
  /** Celda del SoA residente de lo percibido en `consulta` (−1 sin SoA): para leer en vivo el campo que la ley mira. */
  const soaPercibida = (consulta: number): number => fast ? terreno.soa[celdaPercibida(consulta)]! : -1;
  const pasosPercibidos = (consulta: number): number => salida.pasos[fila * salida.q + consulta]!;
  /** Pasos BFS hasta `point` dentro de la ventana (undefined fuera de ella, en agua o sin ruta), como `perceivedRoutes`. */
  const stepsTo = (point: Point): number | undefined => {
    const dx = point.x - person.x, dy = point.y - person.y;
    if (!(dx >= -RADIUS && dx <= RADIUS && dy >= -RADIUS && dy <= RADIUS) || (dx | 0) !== dx || (dy | 0) !== dy) return undefined;
    const st = ventana[base + (dy + RADIUS) * LADO_VENTANA + dx + RADIUS]!;
    return st >= 0 ? st : undefined;
  };
  const reachableTiles = own ? chooseReachable : [];
  const reachableCells = own ? chooseReachableCells : [];
  // Las teselas de tierra del disco, en el orden de filas de la ventana, con sus pasos (-1: sin ruta) y distancias.
  const nearbySteps = own ? chooseNearbySteps : new Int16Array(ROUTE_CELLS), nearbyDist = own ? chooseNearbyDist : new Float64Array(ROUTE_CELLS);
  const reachableSteps = own ? chooseReachableSteps : new Int16Array(ROUTE_CELLS), reachableDist = own ? chooseReachableDist : new Float64Array(ROUTE_CELLS);
  for (let k = 0; k < CELDAS_VENTANA; k++) {
    const c = ventanaCelda[base + k]!;
    if (c < 0) continue;
    const t = terreno.teselas[c]!, st = ventana[base + k]!, d = DISTANCIA_VENTANA[k]!, cell = fast ? terreno.soa[c]! : -1;
    const i = nearbyTiles.length;
    nearbyTiles.push(t); nearbyCells.push(cell); nearbySteps[i] = st; nearbyDist[i] = d;
    if (st >= 0) { const ri = reachableTiles.length; reachableTiles.push(t); reachableCells.push(cell); reachableSteps[ri] = st; reachableDist[ri] = d; }
  }
  const payload = containedWaterQuanta(person) / 1000;
  const foodArr = fast?.foodArr, dwArr = fast?.drinkingWaterArr;
  const moistureArr = fast?.moistureArr, vegArr = fast?.vegetationArr, terrainArr = fast?.terrainArr, biomeArr = fast?.biomeArr;
  const SHELTER_CODE = fast?.TERRAIN_SHELTER ?? -1;
  const foodOf = (tile: Tile, cell: number): number => {
    if (cell >= 0 && foodArr) { const v = foodArr[cell]!; return v === v ? v : 0; }
    return tile.food;
  };
  const dwOf = (tile: Tile, cell: number): number => {
    if (cell >= 0 && dwArr) { const v = dwArr[cell]!; return v === v ? v : 0; }
    return tile.drinkingWater ?? 0;
  };
  const moistureOf = (tile: Tile, cell: number): number => {
    if (cell >= 0 && moistureArr) { const v = moistureArr[cell]!; return v === v ? v : 0; }
    return tile.moisture;
  };
  const vegetationOf = (tile: Tile, cell: number): number => {
    if (cell >= 0 && vegArr) { const v = vegArr[cell]!; return v === v ? v : 0; }
    return tile.vegetation;
  };
  const isShelterOf = (tile: Tile, cell: number): boolean => (cell >= 0 && terrainArr ? terrainArr[cell] === SHELTER_CODE : tile.terrain === 'shelter');
  // A nominal effort budget for planning; the bodily law itself still saturates
  // readiness at zero. It is not a new physical prohibition or a future guarantee.
  const plannedEffort = (steps: number, work: number) => ({
    energy: steps * (.0008 + payload * .0008) + work * .0003,
    fatigue: steps * (.0007 * (1.2 - person.traits.resilience * .4) + payload * .0007) + work * .00025 * (1.2 - person.traits.resilience * .4),
  });
  const nearbyPeople = vecinos(world, person, RADIUS + 1, other => other.id !== person.id && distance(person, other) <= RADIUS, 'choose', own ? choosePeople : undefined);
  const partner = nearbyPeople.find(other => person.role !== 'neighbor' && other.role !== 'neighbor');
  const candidates: Candidate[] = [{ action: 'explore', target: person.target, score: 0.33 + person.curiosity * 0.18, reason: 'Tiene energía y curiosidad por lo que hay cerca.' }];
  // Ley DIV (`conducta.aptitud`): la especialización es para quien no tiene urgencias. Sólo actúa
  // en el contexto `ready` de `valueKey` (sed, hambre y cansancio ≤ 0,5); por encima, beber, comer
  // y descansar compiten exactamente como hoy (medido: sin esta guarda, con aptitud=2 un oficio
  // aplazaba la bebida y la semilla 42 perdía 4 personas por sed en 2 días; la base, 1). Y entra en
  // el apetito de explorar AQUÍ, antes de que la lluvia lo convierta en una búsqueda de techo con
  // `Math.max`: ordena el ocio, nunca frena una búsqueda corporal.
  const aptitud = person.thirst <= 0.5 && person.hunger <= 0.5 && person.fatigue <= 0.5 ? params.conducta.aptitud : 0;
  if (aptitud > 0) candidates[0]!.score += aptitud * ventajaComparativa(person.traits, 'explore');
  const home = settlementOpportunity(world,person);
  const homeCandidate: Candidate | undefined = home ? {action:'approach',...home} : undefined;
  if (homeCandidate) candidates.push(homeCandidate);
  // Conflicto legible (`social.memoriaDisputa`, CONFL, default 0 = hoy): quien cedió una disputa recuerda un
  // día la fuente; al elegir dónde comer, beber o cazar esa fuente (la celda y las que la disputa llama «el
  // mismo destino») le parece `memoriaDisputa` celdas más lejos. Sólo reordena las fuentes que ya percibe: si
  // no hay otra, vuelve; no prohíbe nada, no revela nada lejano y el camino se paga igual.
  const { memoriaDisputa, disputaDestino, vinculoEncuentro } = params.social;
  // Con energía agotada o fatiga saturada y privación severa, descansar ya no recupera energía (`restBody`), pero
  // `move()` sigue desplazándose saturando energía en 0: impedir buscar/elegir alimento o agua bloqueaba en bucle.
  const desperateSubsistence = vinculoEncuentro > 0 && (person.hunger > 0.85 || person.thirst > 0.85) && (person.energy < 0.01 || person.fatigue > 0.98);
  if (memoriaDisputa > 0 && person.conflictMemory && world.tick - person.conflictMemory.tick >= TICKS_PER_DAY) delete person.conflictMemory;
  const disputada = memoriaDisputa > 0 ? person.conflictMemory : undefined;
  const recelo = (tile: Point) => disputada && distance(tile, disputada) < disputaDestino ? memoriaDisputa : 0;
  // Sprint noche-perf: `primero*` (orden.ts) da el mismo elemento que `filter(…).sort(…)[0]` sin ordenar. Con
  // `recelo` el comparador sigue siendo diferencia de una clave finita por celda (preorden total), así que la
  // fusión CONFL + perf elige exactamente la misma celda que el `filter().sort()[0]` de la rama CONFL.
  // Lo percibido es la mejor celda de un filtro f32 algo más ancho que la ley (planes.ts): si cumple la ley y las
  // condiciones propias, es también la mejor de las que las cumplen; si no, se busca como siempre.
  let food = percibida(CONSULTA.comida);
  if (food && (disputada || !(foodOf(food, soaPercibida(CONSULTA.comida)) > UMBRAL.comida)
    || !(desperateSubsistence || planAffordable(person, payload, pasosPercibidos(CONSULTA.comida), 0)))) {
    food = undefined;
    let foodKey = 0;
    for (let i = 0; i < reachableTiles.length; i++) {
      const tile = reachableTiles[i]!, f = foodOf(tile, reachableCells[i]!);
      if (!(f > UMBRAL.comida && (desperateSubsistence || planAffordable(person, payload, reachableSteps[i]!, 0)))) continue;
      const key = disputada ? reachableDist[i]! - f * 2 + recelo(tile) : reachableDist[i]! - f * 2;
      if (!food || key < foodKey) { food = tile; foodKey = key; }
    }
  }
  if (food || person.inventory > 0.01 || foodAvailable(world,person)>0) candidates.push({ action: 'eat', target: food ?? person, score: Math.max(0, person.hunger - 0.22) * 2.5 - (food ? distance(person, food) * 0.02 : 0), reason: 'El hambre orienta su camino hacia alimento que puede percibir.' });
  const body = copyBody(person, own ? chooseBody : { hunger: 0, thirst: 0, fatigue: 0, energy: 0 });
  const forecastBody = own ? chooseForecast : { hunger: 0, thirst: 0, fatigue: 0, energy: 0 };
  const protection = bodilyShelter(world, person, tileIn, fast), damage = bodilyDamage(world, person, body, protection), meal = immediateMeal(world, person, tileIn, fast);
  if (meal > 0) {
    const fed = copyBody(body, forecastBody); assimilateFood(fed, meal, { hungerPerUnit: HAMBRE_POR_UNIDAD, energyPerUnit: 1.2 });
    const relief = avoidedDamageScore(person, damage, bodilyDamage(world, person, fed, protection));
    if (relief > 0) candidates.push({ action: 'eat', target: person, score: Math.max(0, person.hunger - 0.22) * 2.5,
      reason: 'Puede comer una reserva local ahora; aliviar el daño corporal no requiere esperar una caza.' });
  }
  const family = familyOpportunity(world, person);
  const familyPlace = family ? filtrarCerca(world.places, person, RADIUS + 1, place => distance(person,place)<=RADIUS && distance(family.partner,place)<=RADIUS)
    .sort((a,b) => (distance(person,a)+distance(family.partner,a))-(distance(person,b)+distance(family.partner,b)) || a.id.localeCompare(b.id))[0] : undefined;
  // A small local harvest may improve a viable family reserve below the meal-search
  // filter. Preview finite observed biomass; no future regeneration is promised.
  let familyFood: Tile | undefined;
  familyForecast: {
    if (!family || person.inventory >= family.reserveTarget) break familyForecast;
    const sources: number[] = [];
    for (let i = 0; i < reachableTiles.length; i++) {
      const tile = reachableTiles[i]!;
      if (foodOf(tile, reachableCells[i]!) >= MIN_FORAGE_STOCK && distance(tile, family.partner) <= RADIUS) sources.push(i);
    }
    if (!sources.length) break familyForecast;
    const foragers = observedForagersByCell(nearbyPeople);
    const physiology = demographicTraits(person.genome, params.cuerpo);
    // The exact future route climate is unknown. The largest perceived basal
    // rates give a conservative desert/rain forecast without reading remote land.
    // `bodilyNeedRates` only depends on the tile through (desert?, shelter?), so with the
    // resident arrays one representative per combination gives the same componentwise max.
    const firstCell = fast ? reachableCells[0]! : -1;
    const worst = needRates(world, tileIsDesert(reachableTiles[0]!, firstCell, fast), tileIsExposed(reachableTiles[0]!, firstCell, fast), physiology, own ? chooseWorst : { ...needRatesScratch });
    let seenCombos = 0;
    for (let i = 0; i < reachableTiles.length; i++) {
      const tile = reachableTiles[i]!, cell = reachableCells[i]!;
      if (fast && cell >= 0 && biomeArr && terrainArr) {
        const combo = (biomeArr[cell] === fast.BIOME_DESERT ? 1 : 0) | (terrainArr[cell] === SHELTER_CODE ? 2 : 0);
        if (seenCombos & (1 << combo)) continue;
        seenCombos |= 1 << combo;
      }
      const rates = needRates(world, tileIsDesert(tile, cell, fast), tileIsExposed(tile, cell, fast), physiology);
      worst.hunger = Math.max(worst.hunger, rates.hunger); worst.thirst = Math.max(worst.thirst, rates.thirst);
      worst.energy = Math.max(worst.energy, rates.energy); worst.stressEnergy = Math.max(worst.stressEnergy, rates.stressEnergy);
      worst.fatigue = Math.max(worst.fatigue, rates.fatigue);
    }
    let best: { tile: Tile; value: number; distance: number } | undefined;
    for (const sourceIndex of sources) {
      const tile = reachableTiles[sourceIndex]!;
      const steps = reachableSteps[sourceIndex]!;
      const work = Math.max(1, forageDuration(person)
        - (person.action === 'forage' && distance(person.target, tile) === 0 ? person.work : 0));
      if (!planAffordable(person, payload, steps, work)) continue;
      const workers = foragers.get(`${tile.x},${tile.y}`);
      if (workers && earlierForagerExhausts(person, tile, workers, work, {
        tick: world.tick, radius: RADIUS, duration: other => forageDuration(other),
        capacity: other => Math.min(FORAGE_AMOUNT, Math.max(0, 0.25 - other.inventory)),
        continues: (other, ticks) => {
          const body = copyBody(other, own ? choosePaid : { hunger: 0, thirst: 0, fatigue: 0, energy: 0 });
          const otherCell = reachableCells[sourceIndex]!;
          advanceNeeds(body, needRates(world, tileIsDesert(tile, otherCell, fast), tileIsExposed(tile, otherCell, fast), demographicTraits(other.genome, params.cuerpo)), ticks);
          return body.hunger <= 0.9 && body.thirst <= 0.9;
        },
      })) continue;
      const delay = steps * 6 + work;
      const decay = (Math.floor((world.tick + delay) / 10) - Math.floor(world.tick / 10)) * params.recursos.decaimientoComida;
      const available = Math.max(0, foodOf(tile, reachableCells[sourceIndex]!) - decay);
      if (available < MIN_FORAGE_STOCK) continue;
      const harvest = Math.min(available, FORAGE_AMOUNT, 0.25 - person.inventory);
      if (harvest <= 0) continue;
      const paid = copyBody(body, own ? choosePaid : { hunger: 0, thirst: 0, fatigue: 0, energy: 0 });
      advanceNeeds(paid, worst, delay);
      exertBody(paid, plannedEffort(steps, work));
      const eligibility = updateDemography({ state: { ...person.demography, age: person.demography.age + delay },
        traits: physiology, ...paid }, { exposure: 0, shelter: 0, protected: false }, 0);
      if (!eligibility.offspringEligible) continue;
      // Consumption equivalent discriminates effort from potential usefulness.
      // The real action stores biomass; this private preview grants no energy.
      // Use an empty readiness probe so a currently rested body does not mask
      // the reserve's future yield through the energy ceiling.
      const fed = copyBody(paid, forecastBody); fed.energy = 0; assimilateFood(fed, harvest, { hungerPerUnit: HAMBRE_POR_UNIDAD, energyPerUnit: 1.2 });
      const benefit = fed.energy - (body.energy - paid.energy);
      if (benefit <= 0) continue;
      const value = benefit / Math.max(1, delay), away = reachableDist[sourceIndex]!;
      if (!best || value > best.value || (value === best.value && (away < best.distance
        || (away === best.distance && (tile.x < best.tile.x || (tile.x === best.tile.x && tile.y < best.tile.y))))))
        best = { tile, value, distance: away };
    }
    familyFood = best?.tile;
  }
  const familyForage: Candidate | undefined = family && person.inventory < family.reserveTarget && familyFood ? {
    action: 'forage', target: familyFood,
    score: 0.85 + person.traits.care * 0.2 + (family.reserveTarget - person.inventory) / family.reserveTarget * 0.4 - distance(person, familyFood) * 0.02,
    reason: `Prepara alimento para una posible crianza con ${family.partner.name}; debe recogerlo del entorno y conservar una reserva.`,
  } : undefined;
  if (familyForage) candidates.push(familyForage);
  if (family && person.inventory >= family.reserveTarget && family.partner.inventory >= 0.1) candidates.push({
    action: 'approach', target: familyPlace ?? family.partner, score: 0.85 + person.traits.care * 0.2,
    reason: `Tiene reservas y busca ${familyPlace ? `reunirse con ${family.partner.name} en ${familyPlace.name}` : `acercarse a ${family.partner.name}`}; el vínculo y el cuidado corporal permiten intentar una crianza.`,
  });
  // Cortejo (2026-09-22, `poblacion.cortejo`; histórico 0 = apagado, reglas 10 lo adopta con 2 y radio 128
  // para mundos nuevos). Diagnóstico: en la semilla 7
  // hay adultos fértiles con vínculo mutuo, pero la pareja válida más cercana de toda la corrida está a
  // 18 celdas; nadie la busca y el mundo se extingue sin nacer nadie. Ley local: quien está en edad fértil
  // y recuerda un vínculo mutuo con otra persona fértil no emparentada, fuera de `radioPareja` pero dentro
  // de `radioCortejo`, puede ir hacia ella. Cuesta el mismo movimiento que cualquier desplazamiento, no
  // crea recursos ni garantiza un nacimiento; hambre, sed y descanso siguen ganando cuando urgen.
  let cortejoCandidate: Candidate | undefined;
  const leyPoblacion = params.poblacion;
  if (leyPoblacion.cortejo > 0 && !family && world.reproductionEnabled && person.role === 'neighbor' && reproductiveReadiness(world, person)) {
    let cortejado: Person | undefined, vinculo = 0;
    for (const [id, strength] of Object.entries(person.bonds)) {
      if (strength < 0.3) continue;
      const other = personById(world, id);
      if (!other || other.role !== 'neighbor' || (other.bonds[person.id] ?? 0) < 0.3 || closeKin(person, other)) continue;
      const away = distance(person, other);
      if (away <= leyPoblacion.radioPareja || away > leyPoblacion.radioCortejo || !reproductiveReadiness(world, other)) continue;
      if (!cortejado || away < distance(person, cortejado) || (away === distance(person, cortejado) && other.id < cortejado.id)) {
        cortejado = other; vinculo = (strength + (other.bonds[person.id] ?? 0)) / 2;
      }
    }
    if (cortejado) {
      cortejoCandidate = { action: 'approach', target: { x: cortejado.x, y: cortejado.y }, score: leyPoblacion.cortejo * (0.5 + vinculo * 0.5),
        reason: `Recuerda el vínculo con ${cortejado.name} y lo busca; ambos están en edad de criar y la cercanía hace posible una familia.` };
      candidates.push(cortejoCandidate);
    }
  }
  // La consulta percibida solo ve el agua del suelo: con una cisterna cerca, o si su celda no sirve, se busca como siempre.
  let water = percibida(CONSULTA.agua);
  const cisterna = algunoCerca(world.structures, person, RADIUS + 2, structure => structure.components.includes('cistern'));
  if (cisterna || (water && (disputada || !(dwOf(water, soaPercibida(CONSULTA.agua)) > UMBRAL.agua)
    || !(desperateSubsistence || planAffordable(person, payload, pasosPercibidos(CONSULTA.agua), 0))))) {
    water = undefined;
    let waterKey = 0;
    for (let i = 0; i < reachableTiles.length; i++) {
      const tile = reachableTiles[i]!;
      const key = disputada ? reachableDist[i]! + recelo(tile) : reachableDist[i]!;
      if (water && !(key < waterKey)) continue;
      const ambient = dwOf(tile, reachableCells[i]!);
      if ((ambient > UMBRAL.agua || waterAvailable(world, tile) > UMBRAL.agua)
        && (desperateSubsistence || planAffordable(person, payload, reachableSteps[i]!, 0))) {
        water = tile; waterKey = key;
      }
    }
  }
  const carriedWater = containedWaterQuanta(person) > 0;
  const portableWater = carriedWater && canHandleContainedWater(person, world.tick);
  const localWater = waterAvailable(world, person) > 0;
  const recoverWater = carriedWater && !portableWater && !localWater && canRecoverWaterHandling(world, person, tileIn, fast);
  const seekingWater = !water && !portableWater && !localWater && !recoverWater && person.thirst > 0.6;
  // Memoria del agua (2026-09-22, `agua.memoria`, default 1 = conducta de hoy). Diagnóstico en la
  // semilla 42 (base del laboratorio de la noche): quien muere de sed lleva 850–1100 pasos con sed > 0,7
  // EXPLORANDO, a 117–186 celdas de donde bebió por última vez y a 130 del agua más cercana: la búsqueda
  // de hoy elige celdas nuevas y aleja a la gente de la cuenca. Recordar sólo dónde se bebió no basta
  // (medido: el recuerdo se pierde en cuanto esa charca se agota y 3 de 4 muertos no tenían ninguno).
  // Ley local: cada cual recuerda la última celda con agua que VIO (o donde bebió); la olvida si la ve
  // seca; y sin agua a la vista, cuando la sed prevista AL LLEGAR allí —la de ahora, menos la que cubre el
  // agua que lleva, más la del camino a 6 pasos por celda— supera el umbral, emprende la vuelta. No revela
  // agua lejana (el recuerdo puede estar agotado), no hidrata ni ahorra el camino, que se paga igual.
  const umbralMemoria = params.agua.memoria;
  let aguaRecordada: Point | undefined, sedAlLlegar = 0;
  if (umbralMemoria < 1) {
    if (water) person.waterMemory = { x: water.x, y: water.y };
    const recuerdo = person.waterMemory;
    if (recuerdo && distance(person, recuerdo) <= RADIUS && waterAvailable(world, recuerdo) <= 0.005) delete person.waterMemory;
    else if (recuerdo && !water && !localWater && distance(person, recuerdo) >= 0.5) {
      const here = tileIn(person.x, person.y)!;
      const hereCell = soaCell(fast, person.x, person.y, here);
      const sedPorPaso = needRates(world, tileIsDesert(here, hereCell, fast), tileIsExposed(here, hereCell, fast), demographicTraits(person.genome, params.cuerpo)).thirst;
      sedAlLlegar = person.thirst - containedWaterQuanta(person) / WATER_QUANTA_PER_UNIT * 3 + distance(person, recuerdo) * 6 * sedPorPaso;
      if (sedAlLlegar > umbralMemoria) aguaRecordada = { x: recuerdo.x, y: recuerdo.y };
    }
  }
  let volverAlAgua: Candidate | undefined;
  if (portableWater) candidates.push({ action: 'drink', target: { x: person.x, y: person.y }, score: Math.max(0, person.thirst - 0.18) * 3.1,
    reason: 'Lleva agua en un objeto y puede beber su contenido finito aquí.' });
  if (water) candidates.push({ action: 'drink', target: water, score: Math.max(0, person.thirst - 0.18) * 3.1 - distance(person, water) * 0.015, reason: 'La sed orienta su camino hacia una reserva finita de agua dulce.' });
  else if (seekingWater) {
    // An empty perceptual neighborhood does not remove the bodily motive. Searching
    // uses the existing local exploration and movement costs; it reveals no distant
    // water and provides no thirst relief until a real reserve is reached and debited.
    const soughtWater = copyBody(body, forecastBody); hydrateBody(soughtWater, .006);
    const motive = (person.thirst - 0.18) * 3.1 + avoidedDamageScore(person, damage, bodilyDamage(world, person, soughtWater, protection));
    if (aguaRecordada) volverAlAgua = { action: 'explore', target: aguaRecordada, score: motive,
      reason: 'La sed persiste y no ve agua; vuelve hacia el último lugar donde vio agua, aunque no sabe si sigue ahí.' };
    else {
      candidates[0]!.score = Math.max(candidates[0]!.score, motive);
      candidates[0]!.reason = 'La sed persiste y no encuentra una reserva accesible; recorre el entorno cercano para buscar agua.';
    }
  }
  if (aguaRecordada && !volverAlAgua) volverAlAgua = { action: 'explore', target: aguaRecordada, score: Math.max(0, sedAlLlegar - 0.18) * 3.1,
    reason: 'Calcula que, si se aleja más, llegaría con demasiada sed al último lugar donde vio agua; vuelve antes de que la sed apriete.' };
  if (volverAlAgua) candidates.push(volverAlAgua);
  if (localWater && damage > 0) candidates.push({ action: 'drink', target: person,
    score: Math.max(0, person.thirst - .18) * 3.1, reason: 'Puede beber una reserva local ahora para aliviar la privación corporal.' });
  let huntPlan: { tile: Tile; victim: Animal; work: number } | undefined;
  let herdPlan: Animal | undefined;
  huntForecast: {
    let huntCount = 0;
    const huntOrder = reachableTiles.length <= chooseHuntOrder.length && own ? chooseHuntOrder : new Int16Array(reachableTiles.length);
    for (let i = 0; i < reachableTiles.length; i++) if ((reachableTiles[i]!.fauna ?? 0) >= 1) huntOrder[huntCount++] = i;
    for (let i = 1; i < huntCount; i++) {
      const idx = huntOrder[i]!, key = disputada ? reachableDist[idx]! + recelo(reachableTiles[idx]!) : reachableDist[idx]!;
      let j = i;
      while (j > 0) {
        const prev = huntOrder[j - 1]!;
        const prevKey = disputada ? reachableDist[prev]! + recelo(reachableTiles[prev]!) : reachableDist[prev]!;
        if (!(prevKey > key)) break;
        huntOrder[j] = prev;
        j--;
      }
      huntOrder[j] = idx;
    }
    for (let h = 0; h < huntCount; h++) {
      const tile = reachableTiles[huntOrder[h]!]!;
      let victim: Animal | undefined;
      const enCelda = animalesVivosEnCelda(world, tile.x, tile.y);
      if (enCelda) {
          // La rejilla devuelve el orden de slot; el menor id con desempate por slot es la
          // víctima del `filter(...).sort(...)` de siempre, sin ordenar la celda entera.
        for (const animal of enCelda) {
          if (params.quimica.emergente && canTend(animal, person, world.tick) && (!herdPlan || animal.id < herdPlan.id)) herdPlan = animal;
          if (params.quimica.emergente && !huntable(animal, person.hunger)) continue;
          if (!victim || animal.id < victim.id) victim = animal;
        }
      } else {
        for (const animal of world.animals) {
          if (animal.x !== tile.x || animal.y !== tile.y || !(animal.health > 0)) continue;
          if (params.quimica.emergente && canTend(animal, person, world.tick) && (!herdPlan || animal.id < herdPlan.id)) herdPlan = animal;
          if (params.quimica.emergente && !huntable(animal, person.hunger)) continue;
          if (!victim || animal.id < victim.id) victim = animal;
        }
      }
      const work = Math.max(0, (params.quimica.emergente && victim ? huntWorkDuration(person, victim) : Math.ceil(45 * (1 - (person.skills.hunt ?? 0) * .25)))
        - (person.action === 'hunt' && distance(person.target, tile) === 0 ? person.work : 0));
      if (victim && !huntPlan && planAffordable(person, payload, reachableSteps[huntOrder[h]!]!, work)) {
        huntPlan = { tile, victim, work };
        if (!params.quimica.emergente) break huntForecast;
      }
    }
  }
  const prey = huntPlan?.tile;
  if (herdPlan && (person.hunger > 0.15 || !(person.compounds?.length))) candidates.push({ action: 'forage', target: herdPlan,
    score: Math.max(0, person.hunger - 0.1) * 2 + 0.35, reason: 'Percibe un animal habituado; recoge alimento y fibra sin matarlo, pagando tiempo y biomasa.' });
  if (prey && person.inventory < 0.18) candidates.push({ action: 'hunt', target: prey, score: Math.max(0, person.hunger - 0.18) * 2 + person.traits.industriousness * 0.18 + (food && foodOf(food, fast ? soaCell(fast, food.x, food.y, food) : -1) > 0.2 ? 0 : 0.2) - (person.hunger < 0.8 && (prey.fauna ?? 0) <= 1 ? person.culture.stewardship * 0.15 : 0), reason: 'Percibe fauna; cazar cuesta trabajo, retira un animal y proporciona alimento limitado.' });
  const seekingFood = !food && !prey && meal === 0 && person.hunger > .6;
  if (seekingFood) {
    // Like thirst, deprivation still motivates a paid search when perception is
    // empty. This potential small meal is a need score, never a stock or reward.
    const soughtFood = copyBody(body, forecastBody); assimilateFood(soughtFood, .002, { hungerPerUnit: HAMBRE_POR_UNIDAD, energyPerUnit: 1.2 });
    const motive = (person.hunger - .22) * 2.5 + avoidedDamageScore(person, damage, bodilyDamage(world, person, soughtFood, protection));
    if (motive > candidates[0]!.score) {
      candidates[0]!.score = motive;
      candidates[0]!.reason = 'El hambre persiste sin una comida accesible ni un plan viable de caza; busca alimento por terreno cercano.';
    }
  }
  const help = cooperationOpportunity(world, person);
  if (help) candidates.push({ action: 'cooperate', target: help.person, score: help.score, reason: `Puede ${help.kind === 'teach' ? 'enseñar una técnica practicada' : help.kind === 'tools' ? 'intercambiar un objeto útil por materia disponible' : help.kind === 'trade' ? 'intercambiar materiales complementarios' : help.kind === 'assist' ? 'colaborar en una tarea' : 'aportar materiales'} con ${help.person.name}.` });
  let shelter: Tile | undefined, shelterBestScore = 0;
  if (world.shelterBenefitEnabled) {
    for (let i = 0; i < nearbyTiles.length; i++) {
      const tile = nearbyTiles[i]!;
      if (!isShelterOf(tile, fast ? nearbyCells[i]! : -1)) continue;
      const steps = nearbySteps[i]!;
      if (steps < 0) continue;
      const sh = bodilyShelter(world, tile, tileIn, fast);
      if (!(sh > 0)) continue;
      const sc = sh * (TICKS_PER_DAY - steps * 6);
      if (!shelter || sc > shelterBestScore) { shelter = tile; shelterBestScore = sc; }
    }
  }
  // Ask the actual bodily law whether rest can restore readiness. Unit quality
  // isolates nutrition/hydration limits without duplicating their thresholds.
  const rested = copyBody(person, forecastBody);
  restBody(rested, { fatigue: REST_FATIGUE_RATE, energy: REST_ENERGY_RATE });
  const readinessRecovery = clamp((rested.energy - person.energy) / REST_ENERGY_RATE);
  // V19/L: la noche hace más reparadora una pausa sólo en proporción a lo que queda por recuperar
  // (`recoveryDemand`); con el cuerpo ya descansado no añade una ventaja fija a no hacer nada.
  const recoveryDemand = clamp(person.fatigue + (1 - person.energy));
  const nightRest = phaseAt(world.tick) === 'night' ? (params.conducta.aprendizajeCausal ? 0.1 * recoveryDemand : 0.1) : 0;
  const restHeuristic = person.fatigue * 1.75 + (1 - person.energy) * 1.2 * readinessRecovery + nightRest;
  const restCandidate: Candidate = { action: 'rest', target: recoverWater ? person : shelter ?? person,
    score: Math.max(restHeuristic, recoverWater ? Math.max(0, person.thirst - 0.18) * 3.1 : 0),
    reason: recoverWater ? 'Lleva agua pero necesita recuperar aquí el esfuerzo para manipularla; descansa antes de volver a intentar beber.'
      : shelter ? 'El cansancio hace valiosa una pausa bajo techo.' : 'Necesita una pausa; no percibe un refugio cercano.' };
  candidates.push(restCandidate);
  const cost = constructionCost(world,person);
  const modularWorks = params.construccion.modular;
  const needWood = person.materials.wood < 12, needStone = person.materials.stone < 8, preferWood = person.materials.wood < 6;
  // V20 modular: the autonomous trip gathers only the material it still lacks. Extra wood while stone
  // is the shortfall was banked by the nearest warehouse and sent its carrier straight back out.
  const tripWood = modularWorks && person.materials.wood < Math.min(12, cost.wood), tripStone = modularWorks && person.materials.stone < Math.min(8, cost.stone);
  const tripPrefersWood = tripWood && (!tripStone || preferWood);
  // La celda más cercana con el material que falta, y si hay de los dos, la del preferido: el «+20» de la clave de
  // siempre supera cualquier distancia del disco (≤ 7√2), así que nunca empata entre clases.
  const madera = percibida(CONSULTA.madera), piedra = percibida(CONSULTA.piedra), ambas = percibida(CONSULTA.maderaYPiedra);
  const materialCercano = (quiereMadera: boolean, quierePiedra: boolean, prefiereMadera: boolean): Tile | undefined =>
    quiereMadera && quierePiedra ? (prefiereMadera ? madera ?? piedra : piedra ?? madera)
      : quiereMadera ? (prefiereMadera ? madera : ambas ?? madera)
      : quierePiedra ? (prefiereMadera ? ambas ?? piedra : piedra) : undefined;
  const resource = materialCercano(needWood, needStone, preferWood);
  const tripResource = materialCercano(tripWood, tripStone, tripPrefersWood);
  const workBias = person.traits.industriousness;
  /** La tierra más cercana del disco que cumple `sirve` (la primera en orden de filas si empatan), como las búsquedas de siempre. */
  const masCercana = (sirve: (tile: Tile, cell: number) => boolean): Tile | undefined => {
    let mejor: Tile | undefined, clave = 0;
    for (let i = 0; i < nearbyTiles.length; i++) {
      if (mejor && !(nearbyDist[i]! < clave)) continue;
      if (sirve(nearbyTiles[i]!, fast ? nearbyCells[i]! : -1)) { mejor = nearbyTiles[i]; clave = nearbyDist[i]!; }
    }
    return mejor;
  };
  const lugarCerca = (tile: Tile) => algunoCerca(world.places, tile, 6, p => distance(p, tile) < 5);
  // La tierra que se percibe es siempre suelo, pradera o techo: sin techo es suelo o pradera.
  const obraValida = (tile: Tile, cell: number) => !isShelterOf(tile, cell) && moistureOf(tile, cell) > UMBRAL.humedadObra && vegetationOf(tile, cell) > UMBRAL.vegetacionObra;
  let buildable = percibida(CONSULTA.obra);
  if (buildable && (lugarCerca(buildable) || !obraValida(buildable, soaPercibida(CONSULTA.obra))))
    buildable = masCercana((tile, cell) => obraValida(tile, cell) && !lugarCerca(tile));
  const gatherAt = modularWorks ? tripResource : resource;
  if (gatherAt && (person.materials.wood < cost.wood || person.materials.stone < cost.stone)) candidates.push({ action: 'gather', target: gatherAt, score: 0.15 + workBias * 0.4 + (!shelter ? 0.2 : 0), reason: 'Percibe materiales útiles para cultivar y levantar refugios.' });
  // V20 modular: an active site or extension supplies its own target, so free ground is not required to
  // continue it, and partial loads (or paid work) are accepted deliveries rather than a full backpack.
  const construction = buildable ? constructionOpportunity(world, person) : modularWorks ? constructionOpportunity(world, person, false) : undefined;
  if (modularWorks) {
    const target = construction?.target ?? buildable;
    if (construction && target && modularBuildReady(person, construction, cost, !!tripResource))
      candidates.push({ action: 'build', target, score: construction.score, reason: construction.reason });
  } else if (buildable && construction && person.materials.wood >= cost.wood && person.materials.stone >= cost.stone) candidates.push({ action: 'build', target: buildable, ...construction });
  const invention = inventionOpportunity(world,person);
  if(invention) candidates.push({action:'invent',...invention});
  const technology = technologyOpportunity(world,person);
  if (technology) candidates.push({ action: technology.kind, target: person, score: technology.score, reason: technology.reason });
  const damaged = repairOpportunity(world,person);
  if(damaged) candidates.push({action:'repair',target:damaged,score:0.5+(1-damaged.condition)*0.35+workBias*0.12,reason:'Reparar una instalación que percibe recupera una función útil; exige material y trabajo.'});
  const cultivoValido = (tile: Tile, cell: number) => !isShelterOf(tile, cell) && moistureOf(tile, cell) > UMBRAL.humedadCultivo && vegetationOf(tile, cell) < UMBRAL.vegetacionCultivo;
  let farmland = person.materials.wood >= 1 ? percibida(CONSULTA.cultivo) : undefined;
  if (farmland && !cultivoValido(farmland, soaPercibida(CONSULTA.cultivo))) farmland = masCercana(cultivoValido);
  if (farmland) candidates.push({ action: 'farm', target: farmland, score: 0.12 + workBias * 0.3 + person.culture.stewardship * 0.12 + (food && foodOf(food, fast ? soaCell(fast, food.x, food.y, food) : -1) < 0.2 ? 0.2 : 0), reason: 'Puede preparar tierra húmeda; el alimento llegará después con agua y luz.' });
  let reunionCandidate: Candidate | undefined;
  if (partner) {
    if (vinculoEncuentro > 0) person.partnerMemory = { x: partner.x, y: partner.y, tick: world.tick };
    if (person.socialLoad > 0.7 || partner.socialLoad > 0.8) {
      let space: Tile | undefined, spaceDist = -Infinity;
      for (let i = 0; i < nearbyTiles.length; i++) {
        const tile = nearbyTiles[i]!;
        if (!(nearbyDist[i]! <= 4)) continue;
        const away = distance(partner, tile);
        if (!space || away > spaceDist) { space = tile; spaceDist = away; }
      }
      candidates.push({ action: 'retreat', target: space!, score: 1.1 + person.socialLoad, reason: 'Después de compartir tiempo, busca espacio para recuperar su ritmo.' });
    } else {
      candidates.push({ action: 'approach', target: partner, score: person.closeness * (0.65 + person.sociability * 0.45), reason: 'Le apetece acercarse; puede ver al otro en las cercanías.' });
      candidates.push({ action: 'accompany', target: partner, score: 0.18 + person.sociability * 0.1 + (partner.action === 'rest' ? 0.1 : 0), reason: 'Elige compartir una pausa con quien está cerca.' });
    }
  } else if (vinculoEncuentro > 0 && person.role !== 'neighbor' && person.partnerMemory
    && distance(person, person.partnerMemory) >= 2) {
    const daysApart = Math.max(0, (world.tick - person.lastMeeting) / TICKS_PER_DAY);
    const longSeparation = daysApart >= 1.5 && distance(person, person.partnerMemory) > 12;
    const canTravel = longSeparation
      ? person.hunger < 0.76 && person.thirst < 0.76 && person.fatigue < 0.84 && person.socialLoad < 0.75 && person.closeness > 0.32
      : person.hunger < 0.65 && person.thirst < 0.65 && person.fatigue < 0.72 && person.socialLoad < 0.65 && person.closeness > 0.42;
    if (canTravel) {
      const reunionUrgency = longSeparation
        ? Math.min(1.15, daysApart * 0.25)
        : (world.tick - person.lastMeeting > TICKS_PER_DAY ? 0.35 : 0);
      reunionCandidate = {
        action: 'approach',
        target: { x: person.partnerMemory.x, y: person.partnerMemory.y },
        score: vinculoEncuentro * (0.48 + person.closeness * 0.55 + reunionUrgency),
        reason: 'Recuerda el último lugar compartido y emprende el camino de regreso para reencontrarse; conserva sus necesidades.',
      };
      candidates.push(reunionCandidate);
    }
  }
  for (const invitation of world.invitations) {
    if (distance(person, invitation) <= RADIUS && person.hunger < 0.65 && person.fatigue < 0.7 && person.socialLoad < 0.7) candidates.push({ action: 'approach', target: invitation, score: 0.67 + person.sociability * 0.15, reason: 'Percibe una invitación y sus necesidades le permiten acercarse.' });
  }
  const place = primeroCerca(world.places, person, 4, p => distance(person, p) <= 3);
  // Con el hambre de ahora, como siempre: `share` vuelve a buscar receptor con ella al ejecutarse.
  let hungry: Person | undefined;
  for (const other of nearbyPeople) if (distance(person, other) <= UMBRAL.radioCompartir && other.hunger > UMBRAL.hambreAjena && (!hungry || other.hunger > hungry.hunger)) hungry = other;
  const learned = place ? person.habits.find(habit => habit.placeId === place.id && habit.strength >= 0.5) : undefined;
  if (place && hungry && availableToShare(world, person, hungry) && person.hunger < 0.5 && world.tick - person.lastShared >= 30) candidates.push({
    action: 'share', target: hungry, score: 0.22 + person.generosity * (1 + person.culture.sharing * 0.5) + (learned ? learned.strength : 0),
    reason: learned ? `Repite en ${place.name} el cuidado que observó de otra persona.` : 'Puede compartir parte de lo que recogió con alguien que tiene hambre.',
  });
  // Learning also makes a locally known meeting place attractive; it cannot reveal distant places.
  for (const habit of person.habits) {
    const knownPlace = placeById(world, habit.placeId);
    const usefulVisit = knownPlace && person.inventory >= 0.025 && nearbyPeople.some(p => distance(p, knownPlace) <= 3 && p.hunger > 0.27);
    if (habit.strength >= 0.5 && knownPlace && usefulVisit && distance(person, knownPlace) <= RADIUS && person.hunger < 0.5) candidates.push({ action: 'approach', target: knownPlace, score: 0.43 + habit.strength * 0.3, reason: `Recuerda el cuidado compartido en ${knownPlace.name} y vuelve por decisión propia.` });
  }
  for (const memory of world.memories) {
    if (person.role === 'neighbor' || !memory.roles.includes(person.role)) continue;
    const memoryPlace = placeById(world, memory.placeId);
    if (!memoryPlace || distance(person, memoryPlace) > 4) continue;
    const relevant = memory.context === 'partner-tired' ? !!partner && partner.fatigue > 0.45 && person.socialLoad < 0.7
      : memory.context === 'shelter-tired' ? person.fatigue > 0.4
      : memory.context === 'food-hungry' ? person.hunger > 0.4
      : memory.context === 'rain-shelter' ? world.weather === 'rain' && person.fatigue > 0.2 : false;
    if (!relevant) continue;
    for (const candidate of candidates) if (candidate.action === memory.action) {
      candidate.score += memory.weight + (world.reminders.some(reminder => reminder.memoryId === memory.id) ? 0.1 : 0);
      candidate.memory = memory;
    }
  }
  // A roof protects the body during any action at that cell, including useful
  // indoor work. Compare with being outdoors, so staying under cover retains its
  // value instead of losing the motive as soon as the actor arrives.
  const exposed = world.weather === 'rain' && world.shelterBenefitEnabled;
  const outdoorDamage = exposed ? bodilyDamage(world, person, body, 0) : damage;
  let coverGather: Candidate | undefined, gatherWork = 0, gatherSteps = 0;
  if (exposed && !shelter && construction && buildable && stepsTo(buildable) !== undefined && cost.wood <= 12 && cost.stone <= 8) {
    const missing = { wood: Math.max(0, Math.ceil(cost.wood - person.materials.wood)), stone: Math.max(0, Math.ceil(cost.stone - person.materials.stone)) };
    // The existing gather action chooses its preferred material first. Only
    // motivate a first collection that actually pays part of the missing bill.
    const preferred = person.materials.wood < 6 ? 'wood' : 'stone';
    const useful = nearbyTiles.filter(t => {
      if (stepsTo(t) === undefined) return false;
      const first = (t[preferred] ?? 0) >= 1 && person.materials[preferred] < (preferred === 'wood' ? 12 : 8)
        ? preferred : preferred === 'wood' ? 'stone' : 'wood';
      return missing[first] > 0 && (t[first] ?? 0) >= 1;
    }).sort((a, b) => stepsTo(a)! - stepsTo(b)!)[0];
    let supplied = true;
    gatherSteps = stepsTo(buildable)!;
    for (const material of ['wood', 'stone'] as const) {
      let need = missing[material];
      for (const tile of nearbyTiles.filter(t => stepsTo(t) !== undefined).sort((a, b) => stepsTo(a)! - stepsTo(b)!)) {
        const units = Math.min(need, Math.floor(tile[material] ?? 0));
        need -= units; gatherSteps += units * stepsTo(tile)! * 2;
      }
      supplied &&= need === 0;
    }
    gatherWork = cost.work + (missing.wood + missing.stone) * 18;
    if (useful && supplied && planAffordable(person, payload, gatherSteps, gatherWork)) {
      coverGather = { action: 'gather', target: useful, score: .15 + workBias * .4 + .2,
        reason: 'Percibe materiales alcanzables y una obra admitida para obtener protección; primero debe reunirlos y pagar todo el trabajo.' };
      candidates.push(coverGather);
    }
  }
  let protectionPlan = false;
  for (const candidate of candidates) {
    if (candidate.action === 'explore') continue; // Its destination is selected later; no fictional roof there.
    const steps = stepsTo(candidate.target);
    const bypassEffort = desperateSubsistence && (candidate.action === 'eat' || candidate.action === 'drink');
    if (steps === undefined || (!bypassEffort && !planAffordable(person, payload, steps, 0))) continue;
    let cover = exposed && !(candidate.target.x === person.x && candidate.target.y === person.y)
      ? bodilyShelter(world, candidate.target, tileIn, fast) : protection, work = 0, travel = steps;
    // Accompany stops within 1.5 cells: another person's roof is not the follower's roof.
    if (candidate.action === 'accompany' && steps > 0) cover = 0;
    if (exposed && candidate.action === 'repair' && damaged?.components.includes('roof')) {
      work = Math.max(0, 30 - (person.action === 'repair' && distance(person.target, damaged) === 0 ? person.work : 0));
      if (planAffordable(person, payload, steps, work)) cover = Math.min(1, damaged.condition + .4);
    }
    if (exposed && !shelter && candidate.action === 'build' && construction) {
      work = Math.max(0, cost.work - (person.action === 'build' && distance(person.target, candidate.target) === 0 ? person.work : 0));
      if (planAffordable(person, payload, steps, work)) cover = 1;
    }
    if (candidate === coverGather) { cover = 1; work = gatherWork; travel = gatherSteps; }
    if (cover > 0 && exposed) protectionPlan = true;
    let forecast = copyBody(body, forecastBody);
    if (candidate.action === 'eat') {
      const over = candidate.target as Partial<Person>;
      assimilateFood(forecast, immediateMeal(world, {
        x: candidate.target.x, y: candidate.target.y,
        inventory: over.inventory ?? person.inventory, hunger: over.hunger ?? person.hunger,
      }, tileIn, fast), { hungerPerUnit: HAMBRE_POR_UNIDAD, energyPerUnit: 1.2 });
    }
    if (candidate.action === 'drink') forecast = drinkingBody(world, person, candidate.target, forecastBody);
    // Historical worlds defer to an immediate plant meal; V23 compares paid yield.
    if (candidate.action === 'hunt' && huntPlan && (params.quimica.emergente
      ? person.hunger > 0.28 || animalBiomass(huntPlan.victim) * 0.8 / Math.max(1, huntPlan.work) > Math.min(FORAGE_AMOUNT, food?.food ?? 0) / forageDuration(person)
      : !food && meal === 0)) {
      // Conditional on that visible animal remaining until the paid hunt ends.
      // The real action must still remove its identity before feeding the body.
      const meat = params.quimica.emergente ? animalBiomass(huntPlan.victim) * 0.8 : FOOD_PER_ANIMAL[huntPlan.victim.species], saved = Math.min(.25 - person.inventory, meat * .5);
      assimilateFood(forecast, meat - saved, { hungerPerUnit: HAMBRE_POR_UNIDAD, energyPerUnit: 0 }); work = huntPlan.work;
      if (params.quimica.emergente) candidate.score += (Math.min(person.hunger, (meat - saved) * HAMBRE_POR_UNIDAD) + saved * 2) / (1 + (travel * 6 + work) / 24);
    }
    const relief = avoidedDamageScore(person, outdoorDamage, bodilyDamage(world, person, forecast, cover), travel * 6 + work);
    candidate.score += relief;
    if (exposed && cover > 0 && relief > 0) candidate.reason += candidate.action === 'repair' || candidate.action === 'build' || candidate === coverGather
      ? ' Completar el trabajo pagado puede reducir el daño que le causa la lluvia.'
      : ' El techo funcional que percibe reduce el daño corporal de la lluvia.';
  }
  if (exposed && !protectionPlan && protection === 0) {
    // This is a search motive, not an observed benefit or a promise of cover.
    candidates[0]!.score = Math.max(candidates[0]!.score, avoidedDamageScore(person, outdoorDamage, bodilyDamage(world, person, body, 1)));
    candidates[0]!.reason += ' La lluvia daña su cuerpo; busca protección por terreno cercano sin una solución local viable.';
  }
  for (const candidate of candidates) candidate.score += person.values[valueKey(person, candidate.action)] ?? 0;
  // Ley candidata `conducta.habituacion` (noche de ciencia 2026-09-22): el refuerzo de
  // `values` premia al ganador y la elección se traba en una sola acción. La saciedad la
  // descuenta: cuanto mayor es la fracción vitalicia de una acción en `activity`, menos
  // vale repetirla, modulada por `curiosity` —un rasgo heredable, así que la selección
  // puede actuar sobre la ley—. Con el default 0 no se resta nada y el orden es el de
  // siempre; el desempate del `sort` tampoco cambia.
  const habituacion = params.conducta.habituacion;
  if (habituacion > 0) {
    let acted = 0;
    for (const done of Object.values(person.activity)) acted += done;
    const lifetime = Math.max(1, acted);
    for (const candidate of candidates) candidate.score -= habituacion * (0.5 + person.curiosity) * ((person.activity[candidate.action] ?? 0) / lifetime);
  }
  // Ley candidata DIV, ventaja comparativa heredable (`conducta.aptitud`, 2026-09-22). La
  // habituación sube la riqueza de oficios pero iguala los repertorios: cada cual rota por todo y
  // los vectores de conducta se parecen más (SC-003 se queda en 0,3–0,5). Aquí cada OFICIO vale
  // más para quien tiene su rasgo por encima de la media de SUS cinco rasgos y menos para quien lo
  // tiene por debajo (`ventajaComparativa`): sólo reparte la atención de cada persona entre
  // oficios —comer, beber, descansar, los actos de vínculo y la provisión para una crianza no se
  // tocan—, no crea recursos ni revela nada lejano, y sólo sin urgencias corporales (arriba).
  // Explorar ya la recibió al nacer el candidato; los demás oficios no llevan búsquedas con
  // `Math.max`: su alivio corporal es un sumando, y la ley también. Con el default 0 no se suma
  // nada y el orden es el de siempre.
  if (aptitud > 0) {
    for (const candidate of candidates) {
      if (candidate === candidates[0] || !RASGO_DEL_OFICIO[candidate.action]) continue;
      candidate.score += aptitud * ventajaComparativa(person.traits, candidate.action);
    }
  }
  // Ley evolutiva V12 (`conducta.politicaPeso`) + autonomía V16 (`conducta.politicaAutonomia`):
  // red local 12→8→12 heredable + plasticidad Baldwin adquirida en vida (nunca heredada). Nunca sobrepone
  // urgencias corporales severas (> 0,75) ni búsquedas de emergencia por sed o lluvia. Con default 0 no ejecuta nada.
  const { politicaPeso: pesoBase, politicaAutonomia, aprendizajeCausal } = params.conducta;
  const politicaPeso = person.thirst <= 0.75 && person.hunger <= 0.75 ? pesoBase : 0;
  let heuristicWinnerAction: Action | undefined;
  if (politicaPeso > 0) {
    let scores = policyScores?.get(person.id);
    if (!scores) {
      const { genome, plasticity } = ensurePersonPolicy(world, person);
      scores = evaluatePolicySingle(localPolicyObservation(world, person, tileIn, fast, undefined, 0, nearbyPeople), genome.weights, plasticity.bias);
    }
    const emergencyExplore = seekingWater || (exposed && !protectionPlan && protection === 0);
    const softenHeuristics = politicaAutonomia > 0 && !emergencyExplore
      && person.thirst <= 0.72 && person.hunger <= 0.72 && person.fatigue <= 0.8;
    const heuristicScale = softenHeuristics ? 1 - politicaAutonomia * 0.55 : 1;
    let bestPre = -Infinity;
    for (const candidate of candidates) {
      const protectedBond = candidate === cortejoCandidate || candidate === reunionCandidate || candidate === familyForage || !!candidate.memory;
      const essentialShelter = candidate.action === 'build' && !shelter;
      const strategic = candidate === homeCandidate || (!protectedBond && !essentialShelter
        && (candidate.action === 'explore' || candidate.action === 'gather' || candidate.action === 'farm'
          || candidate.action === 'hunt' || candidate.action === 'build' || candidate.action === 'cooperate'
          || candidate.action === 'research' || candidate.action === 'craft' || candidate.action === 'share'
          || candidate.action === 'invent' || candidate.action === 'repair'));
      if (softenHeuristics && strategic) candidate.score *= heuristicScale;
      // V19/L: la parte de `rest` que no es recuperación pendiente es tan discrecional como una estrategia. Su
      // heurística corporal se atenúa como las estratégicas en la fracción `1 − recoveryDemand`: cansado, descansar
      // conserva todo su peso; descansado, no lleva ventaja sin escalar. El alivio físico (techo bajo lluvia, agua)
      // no se toca: es daño corporal evitado, no preferencia.
      else if (softenHeuristics && aprendizajeCausal && candidate === restCandidate && !recoverWater && !protectedBond)
        candidate.score -= restHeuristic * politicaAutonomia * 0.55 * (1 - recoveryDemand);
      candidate.prePolicyScore = candidate.score;
      if (candidate.score > bestPre) { bestPre = candidate.score; heuristicWinnerAction = candidate.action; }
      if ((candidate === candidates[0] && emergencyExplore) || (politicaAutonomia > 0 && protectedBond)) continue;
      let delta = policyActionBias(scores, candidate.action, politicaPeso);
      // V19/L: la preferencia aprendida por descansar no puede dominar cuando no queda nada que recuperar.
      if (aprendizajeCausal && candidate.action === 'rest') delta *= clamp(person.fatigue + (1 - person.energy));
      candidate.score += delta;
      candidate.policyDelta = delta;
    }
  }
  // V24 Mensajes Divinos: un mensaje OÍDO es una prioridad fuerte y persistente, no un sesgo. Sólo cede ante
  // una necesidad corporal aguda (entonces el candidato ni se ofrece y comer, beber o descansar deciden), y se
  // cumple caminando paso a paso por tierra: nunca teletransporte. Una orden directa (fuera del modo observador)
  // conserva su prioridad. Sin mensajes, ni una lectura más.
  let whisperCandidate: Candidate | undefined;
  const whisper = world.whispers?.length && !person.command ? activeWhisperForPerson(world.whispers, person.id) : undefined;
  if (whisper && person.hunger < 0.72 && person.thirst < 0.72 && person.fatigue < 0.78 && person.energy > 0.22) {
    whisperCandidate = { action: 'explore', target: { x: whisper.x, y: whisper.y }, score: 4,
      reason: `Un susurro le llama a ${WHISPER_INTENT_LABEL[whisper.intent]}; va a su ritmo y atiende antes su cuerpo.` };
    candidates.push(whisperCandidate);
  }
  if (person.command && person.hunger < 0.85 && person.thirst < 0.85 && person.fatigue < 0.88 && person.energy > 0.15) {
    const command = person.command;
    const directed: Candidate = { action: command.order === 'move' ? 'explore' : command.order, target: { x: command.x, y: command.y }, score: 5, directed: true, reason: `Tarea solicitada: ${command.order === 'move' ? 'ir al destino' : actionLabel(command.order)}. Conserva sus necesidades corporales.` };
    if (command.order === 'explore') directed.target = explorationTarget(world, person, reachableTiles, reachableCells, fast);
    if (command.order === 'gather' && distance(person, command) <= RADIUS && resource) directed.target = resource;
    if (command.order === 'forage' && distance(person, command) <= RADIUS && food) directed.target = food;
    if (command.order === 'drink' && (portableWater || water)) directed.target = portableWater ? { x: person.x, y: person.y } : water!;
    if (command.order === 'hunt' && prey) directed.target = prey;
    if (command.order === 'cooperate' && help) directed.target = help.person;
    if (command.order === 'repair' && damaged) directed.target = damaged;
    candidates.push(directed);
  }
  candidates.sort((a, b) => b.score - a.score);
  const selected = candidates[0]!;
  if (selected.action === 'explore' && !selected.directed && selected !== volverAlAgua && selected !== whisperCandidate) {
    // Urgent thirst reconsiders every tick. Replacing a still viable waypoint
    // each time can reverse the route before either endpoint is ever visited.
    // Keep the paid local search leg; visible water and bodily recovery still
    // compete on every choice, and blocked/reached targets must be replaced.
    const remaining = stepsTo(person.target);
    const urgentSearch = seekingWater || (vinculoEncuentro > 0 && seekingFood);
    const continuingSearch = urgentSearch && person.action === 'explore' && remaining !== undefined
      && remaining > 0 && (desperateSubsistence || planAffordable(person, payload, remaining, 0));
    if (vinculoEncuentro > 0 && urgentSearch && !continuingSearch) {
      // Si S o I buscan agua/alimento lejos de su punto compartido (> 48 celdas), orientan el primer intento
      // hacia su propio recuerdo local antes de rebotar por la costa, evitando derivar cientos de celdas lejos.
      if (person.role !== 'neighbor' && person.partnerMemory && distance(person, person.partnerMemory) > 48) {
        const toward = Math.atan2(person.partnerMemory.y - person.y, person.partnerMemory.x - person.x);
        const hx0 = Math.cos(toward), hy0 = Math.sin(toward);
        if (reachableTiles.some(t => {
          const ox = t.x - person.x, oy = t.y - person.y, d2 = ox * ox + oy * oy;
          return d2 >= 9 && d2 <= 36 && ox * hx0 + oy * hy0 >= 2.5;
        })) person.heading = toward;
      }
      for (let tries = 0; tries < 4; tries++) {
        const hx = Math.cos(person.heading), hy = Math.sin(person.heading);
        const canAdvance = reachableTiles.some(t => {
          const ox = t.x - person.x, oy = t.y - person.y;
          const d2 = ox * ox + oy * oy;
          return d2 >= 9 && d2 <= 36 && ox * hx + oy * hy >= 2.5;
        });
        if (canAdvance) break;
        person.heading += 1.3;
      }
    }
    selected.target = continuingSearch ? person.target : explorationTarget(world, person, reachableTiles, reachableCells, fast);
  }
  // A viable work site retains accumulated work while the same action is selected.
  // A protective forecast in rain cannot be redirected to a different old site
  // after its route, function and cost have already been evaluated.
  if (selected.action===person.action && (selected.action==='build' || selected.action==='invent' || selected.action==='repair' || selected.action==='farm' || selected.action==='forage') && person.work>0
    && (!exposed || distance(person.target, selected.target) === 0)
    && (selected !== familyForage || distance(person.target, selected.target) === 0)
    && (selected.action!=='forage' || foodStock(tileIn(person.target.x, person.target.y), soaCell(fast, person.target.x, person.target.y, tileIn(person.target.x, person.target.y)), fast)>=MIN_FORAGE_STOCK)) selected.target=person.target;
  if (person.action !== selected.action || distance(person.target, selected.target) > 0
    && !(params.quimica.emergente && selected.action === 'hunt' && huntPlan && person.huntingPreyId === huntPlan.victim.id)) person.work = 0;
  if (params.quimica.emergente) {
    if (selected.action === 'hunt' && huntPlan) person.huntingPreyId = huntPlan.victim.id;
    else delete person.huntingPreyId;
  }
  person.action = selected.action;
  if (selected.action !== 'drink') delete person.technology.waterPreparation;
  person.intentContext = person.thirst > 0.5 ? 'thirsty' : person.hunger > 0.5 ? 'hungry' : person.fatigue > 0.5 ? 'tired' : 'ready';
  person.target = { x: selected.target.x, y: selected.target.y };
  const policyDriven = politicaAutonomia > 0 && !selected.directed && (selected.policyDelta ?? 0) > 0.12
    && heuristicWinnerAction !== undefined && selected.action !== heuristicWinnerAction;
  const baseReason = selected.memory ? `${selected.reason} Influye «${selected.memory.title}», ${selected.memory.source === 'sample' ? 'material de prueba' : 'recuerdo aprobado'}.` : selected.reason;
  person.reason = policyDriven ? `${baseReason} Su política neuronal aprendida inclinó esta estrategia.` : baseReason;
  person.decisionAt = world.tick + (selected === restCandidate && recoverWater ? 1 : 30);
  if (selected.memory && person.recentMemory !== selected.memory.text) {
    const event = addEvent(world, { kind: 'memory', actors: [person.id], text: `${person.name} eligió ${actionLabel(selected.action)} al recordar «${selected.memory.title}».`, cause: `Contexto ${selected.memory.context}; recuerdo ${selected.memory.id}; aumenta la preferencia por ${selected.action}.`, x: person.x, y: person.y, source: selected.memory.source });
    remember(person, world, selected.memory.text, event.id, selected.memory.placeId);
  }
  } finally {
    chooseDepth--;
  }
}


function actionLabel(action: Action): string {
  return ({ explore: 'explorar', eat: 'buscar alimento', forage: 'cosechar alimento', drink: 'beber', hunt: 'cazar', rest: 'descansar', approach: 'acercarse', accompany: 'acompañar', retreat: 'tomar espacio', share: 'compartir alimento', gather: 'recolectar', farm: 'cultivar', build: 'construir', cooperate: 'cooperar', invent:'ensayar un diseño', repair:'reparar', research:'investigar materiales', craft:'fabricar una técnica aprendida' })[action];
}


function explorationTarget(world: World, person: Person, tiles: Tile[], cells?: readonly number[], fast?: ResidentFastAccess): Point {
  const headingX = Math.cos(person.heading), headingY = Math.sin(person.heading);
  const companions = world.cooperationEnabled ? vecinos(world, person, 8, p => p.id !== person.id && distance(person, p) <= 7 && (person.bonds[p.id] ?? 0) > 0.3, 'explorationTarget') : [];
  const desperate = paramsOf(world).social.vinculoEncuentro > 0 && (person.thirst > 0.85 || person.hunger > 0.85);
  const comp0 = !desperate && companions.length ? companions[0]! : undefined;
  const compDist = comp0 ? distance(person, comp0) : 0;
  const compWeight = person.sociability * (1 - person.curiosity) * 0.18;
  const headingWeight = desperate ? 0.65 : 0.2;
  const visited = person.visited, novelty = world.noveltyEnabled;
  let best: Tile | undefined, bestScore = 0, visitedSet: Set<string> | undefined;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i]!;
    const away = distance(person, t);
    if (away < 3 || away > 6) continue;
    const cell = cells ? cells[i]! : -1;
    const rawTraffic = fast && cell >= 0 ? fast.trafficArr[cell]! : undefined;
    const traffic = fast && cell >= 0 ? (rawTraffic === rawTraffic ? rawTraffic! : 0) : (t.traffic ?? 0);
    const s = ((t.x - person.x) * headingX + (t.y - person.y) * headingY) * headingWeight
      + (novelty && !(visitedSet ??= new Set(visited)).has(`${t.x},${t.y}`) ? 2 : 0)
      + traffic * 0.1
      + (comp0 ? (compDist - distance(t, comp0)) * compWeight : 0);
    if (!best || s > bestScore || (s === bestScore && (t.x < best.x || (t.x === best.x && t.y < best.y)))) {
      best = t; bestScore = s;
    }
  }
  return best ?? person;
}

function valueKey(person: Person, action: Action): string { return `${person.thirst > 0.5 ? 'thirsty' : person.hunger > 0.5 ? 'hungry' : person.fatigue > 0.5 ? 'tired' : 'ready'}:${action}`; }

/** Update only after an observed outcome, including failed work. Skills require useful production. */
export function outcome(world: World, person: Person, action: Action, benefit: number, useful = true): void {
  const key = `${person.intentContext}:${action}`;
  if (world.adaptationEnabled) person.values[key] = Math.max(-0.3, Math.min(0.3, (person.values[key] ?? 0) + person.genome.learningRate * (benefit - (person.values[key] ?? 0))));
  if (world.adaptationEnabled && paramsOf(world).conducta.politicaPeso > 0) {
    if (paramsOf(world).conducta.aprendizajeCausal) {
      // Only a delivered local service enters the causal return; failed attempts contribute negative evidence.
      const witnessed = useful && ['share', 'cooperate', 'build', 'repair', 'craft'].includes(action)
        ? Math.max(0, Math.min(0.25, benefit)) : !useful ? Math.max(-0.25, Math.min(0, benefit)) : 0;
      creditCausalOutcome(world, person, action, witnessed);
    }
    else {
      const { plasticity } = ensurePersonPolicy(world, person);
      const step = paramsOf(world).conducta.politicaAutonomia > 0 ? 0.4 : 0.25;
      updatePolicyPlasticity(plasticity, action, benefit, person.genome.learningRate * step);
    }
  }
  if (world.adaptationEnabled && world.cooperationEnabled) {
    // Acquired norms react to consequences, independently from inherited alleles.
    updateCulturalNormsOnOutcome(world, person, action, useful);
  }
  person.lastOutcome = world.tick;
  if (world.adaptationEnabled && world.tick - person.lastPracticeMemory >= 300 && ['gather','hunt','farm','build','drink','cooperate','forage'].includes(action)) {
    person.lastPracticeMemory = world.tick;
    const event = addEvent(world, { kind: 'adaptation', actors: [person.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} recuerda ${useful ? 'un resultado útil' : 'un intento fallido'} al ${actionLabel(action)}.`, cause: `Consecuencia observada ${benefit.toFixed(3)} en contexto ${person.intentContext}; plasticidad heredable ${person.genome.learningRate.toFixed(3)} modifica la preferencia, sin cambiar el genoma.` });
    remember(person, world, `${useful ? 'Funcionó' : 'No funcionó'} ${actionLabel(action)} en (${person.x}, ${person.y}); tendrá en cuenta esa consecuencia.`, event.id);
  }
  if (!useful) return;
  person.skills[action] = clamp((person.skills[action] ?? 0) + 0.008);
  person.activity[action] = Math.min(1_000_000, (person.activity[action] ?? 0) + 1);
}
