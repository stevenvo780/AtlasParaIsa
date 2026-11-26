import type { World, Person } from '../mundo/tipos.js';
import { type TileLookup, distance, type Point } from '../mundo/geometria.js';
import { outcome } from '../decision/personas.js';
import { addEvent } from '../mundo/crear.js';
import { type ResidentTileReader, residentTileReader } from '../soa/terreno.js';
import { paramsOf } from '../params.js';
import type { Tile } from '../../shared/types.js';
import { tileLookup } from '../tile-index.js';
import { cellIntKey } from '../politica-obs.js';
import { payContainedWaterCarry, spillContainedWater } from '../technology-water.js';
import { personaMovida } from '../rejilla.js';
import { trampleTile } from '../ecosystem.js';
import { exertBody } from '../body.js';
import { count } from '../statistics.js';
import { ley } from '../params.js';
import { C_MOVER } from '../../shared/naturaleza.js';
import { ctxMateriaDe, type CtxLeyMateria } from '../motor/acceso.js';
import { cargaKg, masaDe, pagar } from '../materia/cuerpo.js';
import type { Cuerpo } from '../materia/tipos.js';
import { calidadEmpedrado, desgastarEmpedrado } from '../materia/piezas.js';
import { empedrar } from '../inventions.js';


/** Physical relief from the material state of the single cell underfoot. */
export function roadEffortFactor(tile: { traffic?: number; paved?: number } | undefined): number {
  return 1 - Math.min(0.55, Math.max(0, tile?.traffic ?? 0) * 0.45 + Math.max(0, tile?.paved ?? 0) * 0.15);
}

const ROUTE_RADIUS = 24;
const ROUTE_MAX_NODES = 2048;
const ROUTE_SIDE = 2 * ROUTE_RADIUS + 1;
const ROUTE_CELLS = ROUTE_SIDE * ROUTE_SIDE;
const ROUTE_CENTER = ROUTE_RADIUS * (ROUTE_SIDE + 1);
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
const ROUTE_NEIGHBORS = [1, ROUTE_SIDE, -1, -ROUTE_SIDE];

const routeQueue = new Uint16Array(ROUTE_CELLS);
const routeFirstSteps = new Uint16Array(ROUTE_CELLS);
const routeVisited = new Uint16Array(ROUTE_CELLS);
let routeGeneration = 0;
let routeInUse = false;

type Walkable = (x: number, y: number, fromStart: boolean) => boolean;

function routeCoordinate(n: number): boolean {
  return Number.isSafeInteger(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER - ROUTE_RADIUS - 1 && !Object.is(n, -0);
}

/** El índice está acotado al cuadrado local. Cada celda descubierta guarda el primer paso de su ruta. */
function gridFirstStep(start: Point, person: Person, world: World, coast: boolean, walkable: Walkable): Point | null {
  if (++routeGeneration > 0xffff) { routeVisited.fill(0); routeGeneration = 1; }
  const generation = routeGeneration;
  routeQueue[0] = ROUTE_CENTER;
  routeVisited[ROUTE_CENTER] = generation;
  const point = { ...start };
  let best = ROUTE_CENTER, bestDist = distance(start, person.target), end = 1;
  for (let head = 0; head < end && head < ROUTE_MAX_NODES; head++) {
    const cell = routeQueue[head]!;
    const dx = cell % ROUTE_SIDE - ROUTE_RADIUS, dy = Math.floor(cell / ROUTE_SIDE) - ROUTE_RADIUS;
    const x = point.x = start.x + dx, y = point.y = start.y + dy;
    const currentDist = distance(point, person.target);
    if (currentDist < bestDist) { best = cell; bestDist = currentDist; }
    if (currentDist < 0.5) { best = cell; break; }
    for (let direction = 0; direction < DX.length; direction++) {
      const stepX = DX[direction]!, stepY = DY[direction]!;
      if (Math.abs(dx + stepX) > ROUTE_RADIUS || Math.abs(dy + stepY) > ROUTE_RADIUS) continue;
      if (!walkable(x + stepX, y + stepY, cell === ROUTE_CENTER)) continue;
      const next = cell + ROUTE_NEIGHBORS[direction]!;
      if (routeVisited[next] === generation) continue;
      routeVisited[next] = generation;
      routeFirstSteps[next] = cell === ROUTE_CENTER ? next : routeFirstSteps[cell]!;
      routeQueue[end++] = next;
    }
  }
  if (coast && end > 1) {
    point.x = start.x + (best % ROUTE_SIDE - ROUTE_RADIUS);
    point.y = start.y + (Math.floor(best / ROUTE_SIDE) - ROUTE_RADIUS);
    if (distance(start, person.target) - distance(point, person.target) < 1.5) {
      const side = Math.floor(world.tick / 360) % 2 === 0 ? Math.PI / 2 : -Math.PI / 2;
      const angle = Math.atan2(person.target.y - start.y, person.target.x - start.x) + side;
      const tx = Math.cos(angle), ty = Math.sin(angle);
      let bestDot = -Infinity;
      for (let i = 1; i < end; i++) {
        const cell = routeQueue[i]!;
        const dot = (cell % ROUTE_SIDE - ROUTE_RADIUS) * tx + (Math.floor(cell / ROUTE_SIDE) - ROUTE_RADIUS) * ty;
        if (dot > bestDot) { bestDot = dot; best = cell; }
      }
    }
  }
  if (best === ROUTE_CENTER) return null;
  const step = routeFirstSteps[best]!;
  return { x: start.x + (step % ROUTE_SIDE - ROUTE_RADIUS), y: start.y + (Math.floor(step / ROUTE_SIDE) - ROUTE_RADIUS) };
}

/** Conserva el recorrido por coordenadas cuando el origen no se puede representar por desplazamientos enteros exactos. */
function coordinateFirstStep(start: Point, person: Person, world: World, coast: boolean, walkable: Walkable): Point | null {
  const routeKey = (x: number, y: number) => cellIntKey(x, y) ?? `${x},${y}`;
  const queue: Point[] = [start], previous = new Map<number | string, Point | null>([[routeKey(start.x, start.y), null]]);
  let best = start, bestDist = distance(start, person.target);
  for (let head = 0; head < queue.length && head < ROUTE_MAX_NODES; head++) {
    const current = queue[head]!, currentDist = distance(current, person.target);
    if (currentDist < bestDist) { best = current; bestDist = currentDist; }
    if (currentDist < 0.5) { best = current; break; }
    for (let direction = 0; direction < DX.length; direction++) {
      const x = direction === 0 ? current.x + 1 : direction === 2 ? current.x - 1 : current.x;
      const y = direction === 1 ? current.y + 1 : direction === 3 ? current.y - 1 : current.y;
      if (Math.max(Math.abs(x - start.x), Math.abs(y - start.y)) > ROUTE_RADIUS) continue;
      if (!walkable(x, y, current === start)) continue;
      const nextKey = routeKey(x, y);
      if (previous.has(nextKey)) continue;
      const next = { x, y };
      previous.set(nextKey, current);
      queue.push(next);
    }
  }
  if (coast && queue.length > 1 && distance(start, person.target) - distance(best, person.target) < 1.5) {
    const side = Math.floor(world.tick / 360) % 2 === 0 ? Math.PI / 2 : -Math.PI / 2;
    const angle = Math.atan2(person.target.y - start.y, person.target.x - start.x) + side;
    const tx = Math.cos(angle), ty = Math.sin(angle);
    let bestDot = -Infinity;
    for (let i = 1; i < queue.length; i++) {
      const node = queue[i]!;
      const dot = (node.x - start.x) * tx + (node.y - start.y) * ty;
      if (dot > bestDot) { bestDot = dot; best = node; }
    }
  }
  if (best === start) return null;
  while (previous.get(routeKey(best.x, best.y)) !== start) best = previous.get(routeKey(best.x, best.y))!;
  return best;
}

function firstStep(start: Point, person: Person, world: World, coast: boolean, walkable: Walkable): Point | null {
  if (routeInUse || !routeCoordinate(start.x) || !routeCoordinate(start.y)) return coordinateFirstStep(start, person, world, coast, walkable);
  routeInUse = true;
  try { return gridFirstStep(start, person, world, coast, walkable); }
  finally { routeInUse = false; }
}


/** Breadth-first movement takes one adjacent land cell. It never crosses water or teleports. */
export function move(world: World, person: Person, tileInArg?: TileLookup, readerArg?: ResidentTileReader | null): void {
  if (distance(person, person.target) < 0.5) return;
  const key = (p: Point) => `${p.x},${p.y}`;
  const start = { x: person.x, y: person.y };
  const physicalRoads = paramsOf(world).terreno.caminosFisicos;
  const obraCamino = physicalRoads && ley(world, 'obra') ? ctxMateriaDe(world) : undefined;
  const roadTieScore = (dist: number, tile: Tile | undefined): number => {
    const paved = tile ? (obraCamino ? calidadEmpedrado(obraCamino, tile) : tile.paved ?? 0) : 0;
    return dist - 0.18 * ((tile?.traffic ?? 0) + paved * 0.5);
  };
  const startDistance = physicalRoads ? distance(start, person.target) : 0;
  let roadStep: Point | null = null, roadDistance = Infinity, roadBestDistance = Infinity, roadScore = Infinity;
  // At most two cardinal neighbors can reduce Euclidean distance. Compare those in one pass;
  // the road bonus cannot admit a step more than 0.15 farther than the best reducing neighbor.
  const considerRoad = (x: number, y: number, tile: Tile | undefined): void => {
    if (!tile || tile.terrain === 'water') return;
    const d = distance({ x, y }, person.target);
    if (d >= startDistance) return;
    roadBestDistance = Math.min(roadBestDistance, d);
    const score = roadTieScore(d, tile);
    if (d <= roadBestDistance + 0.15 && (roadDistance > roadBestDistance + 0.15 || score < roadScore)) {
      roadStep = { x, y }; roadDistance = d; roadScore = score;
    }
  };
  const allowCoastalDetour = paramsOf(world).social.vinculoEncuentro > 0
    && person.action === 'approach' && !person.command && distance(start, person.target) > 12;
  const tileIn = tileInArg ?? tileLookup(world.tiles);
  const reader = readerArg === undefined ? residentTileReader(world.tiles) : readerArg ?? undefined;
  const walkable: Walkable = (x, y, fromStart) => {
    if (reader) {
      const cell = reader.cellAt(x, y);
      if (cell < 0 || reader.terrainCode(cell) === reader.TERRAIN_WATER) return false;
      if (physicalRoads && fromStart) considerRoad(x, y, tileIn(x, y));
    } else {
      const tile = tileIn(x, y);
      if (!tile || tile.terrain === 'water') return false;
      if (physicalRoads && fromStart) considerRoad(x, y, tile);
    }
    return true;
  };
  let nextStep = firstStep(start, person, world, allowCoastalDetour, walkable);
  // Keep route-selected detours around water/obstacles; roads only break local progress ties.
  if (physicalRoads && roadStep && nextStep && !allowCoastalDetour) {
    const baselineDistance = distance(nextStep, person.target);
    if (baselineDistance < startDistance && baselineDistance <= roadBestDistance + 0.15) {
      const tile = tileIn(nextStep.x, nextStep.y);
      const baselineScore = roadTieScore(baselineDistance, tile);
      if (roadScore < baselineScore) nextStep = roadStep;
    }
  }
  if (!nextStep) {
    person.heading += 1.3; person.decisionAt = world.tick + 1;
    if (world.tick - person.lastOutcome >= 30) outcome(world, person, person.action, -0.15, false);
    person.reason = 'El terreno bloquea el paso; busca una ruta local posible.';
    if (person.command) {
      person.command = null; person.controlMode = 'auto'; person.action = 'rest'; person.target = { ...start }; person.decisionAt = world.tick + 30;
      person.reason = 'Tarea interrumpida: no encontró una ruta en el terreno cercano. Prueba un destino intermedio.';
      addEvent(world, { kind: 'gesture', actors: [person.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} interrumpió una tarea por un camino bloqueado.`, cause: 'Búsqueda local acotada sin ruta de avance; vuelve a autonomía y conserva el lugar físico.' });
    }
    return;
  }
  const conCuerpo = person.cuerpo && ley(world, 'cuerpos') ? obraCamino ?? ctxMateriaDe(world) : undefined;
  if (conCuerpo && person.cuerpo) {
    const pagado = pagarPaso(conCuerpo, world, person, person.cuerpo, tileIn(start.x, start.y));
    if (pagado < 0) return;
    darPaso(world, person, nextStep, tileIn, physicalRoads, conCuerpo, pagado);
    return;
  }
  const carryFatigue = physicalRoads ? person.fatigue : 0;
  if (!payContainedWaterCarry(world, person)) {
    const desperateCarry = paramsOf(world).social.vinculoEncuentro > 0
      && (person.hunger > 0.85 || person.thirst > 0.85) && (person.energy < 0.01 || person.fatigue > 0.98);
    if (!desperateCarry || spillContainedWater(world, person) === 0 || !payContainedWaterCarry(world, person)) {
      person.reason = 'La carga de agua requiere más esfuerzo del que puede hacer ahora.';
      return;
    }
  }
  if (physicalRoads && person.fatigue > carryFatigue) {
    // Water policy v1 receipts require the exact historical energy debit. Relieve only the
    // bodily fatigue of carrying: liquid, work, energy ledger and admissibility stay conserved.
    person.fatigue = carryFatigue + (person.fatigue - carryFatigue) * roadEffortFactor(tileIn(start.x, start.y));
  }
  person.x = nextStep.x; person.y = nextStep.y;
  personaMovida(world, person);
  const steppedTile = tileIn(person.x, person.y)!;
  const effort = physicalRoads ? roadEffortFactor(steppedTile) : 1;
  trampleTile(steppedTile);
  exertBody(person, { energy: 0.0008 * effort, fatigue: 0.0007 * (1.2 - person.traits.resilience * 0.4) * effort });
  if (physicalRoads && steppedTile.terrain !== 'water' && steppedTile.terrain !== 'shelter'
    && (steppedTile.traffic ?? 0) >= 0.72 && (steppedTile.paved ?? 0) < 0.9
    && person.materials.stone >= 4 && person.energy > 0.35) {
    person.materials.stone -= 1;
    exertBody(person, { energy: 0.004, fatigue: 0.004 });
    steppedTile.paved = 1;
    count(world, 'roadsPaved');
  }
  const visitedKey = key(person);
  if (!person.visited.includes(visitedKey)) {
    person.visited.push(visitedKey); person.visited = person.visited.slice(-192);
    if (person.action === 'explore') outcome(world, person, 'explore', 0.05);
  }
  if (person.command?.order === 'move' && distance(person, person.command) < 0.5) {
    person.command = null; person.controlMode = 'auto'; person.decisionAt = world.tick + 1;
    person.reason = 'Llegó al destino solicitado; retoma sus decisiones.';
  }
}


// ── V23: andar con un cuerpo de átomos ───────────────────────────────────────────────────────────────────

/** J ya pagados de un paso que aún no se dio: quien no alcanza a pagar uno entero lo completa en los siguientes. */
const pagoPendiente = new WeakMap<Person, number>();

/** Alivio del camino con obra: el tráfico apisona y el empedrado es una pieza de piedra en la celda (t2). */
function alivioCamino(c: CtxLeyMateria, tile: Tile | undefined): number {
  if (!tile) return 1;
  return 1 - Math.min(0.55, Math.max(0, tile.traffic ?? 0) * 0.45 + calidadEmpedrado(c, tile) * 0.15);
}

/** Paga un paso de una celda: C_MOVER·(masa + carga) J por celda, con el alivio del camino donde empieza. Devuelve los
 * J pagados en este tick, o −1 si el paso aún no está pagado entero (lo pagado queda a cuenta). */
function pagarPaso(c: CtxLeyMateria, world: World, person: Person, cuerpo: Cuerpo, desde: Tile | undefined): number {
  const alivio = paramsOf(world).terreno.caminosFisicos ? (ley(world, 'obra') ? alivioCamino(c, desde) : roadEffortFactor(desde)) : 1;
  const coste = C_MOVER * (masaDe(c, cuerpo) + cargaKg(c, person.carga ?? [])) * alivio;
  const previo = pagoPendiente.get(person) ?? 0;
  const pagado = pagar(c, cuerpo, coste - previo);
  if (previo + pagado < coste) {
    pagoPendiente.set(person, previo + pagado);
    person.decisionAt = Math.min(person.decisionAt, world.tick + 1);
    person.reason = 'Lo que lleva a cuestas pesa más de lo que su reserva puede pagar ahora: avanza muy despacio.';
    return -1;
  }
  pagoPendiente.delete(person);
  return pagado;
}

/** El paso ya pagado: posición, pisada, fatiga, empedrado con obra, lugares visitados y orden cumplida. */
function darPaso(world: World, person: Person, nextStep: Point, tileIn: TileLookup, physicalRoads: boolean,
  c: CtxLeyMateria, pagadoJ: number): void {
  person.x = nextStep.x; person.y = nextStep.y;
  personaMovida(world, person);
  const steppedTile = tileIn(person.x, person.y)!;
  trampleTile(steppedTile);
  const alivio = physicalRoads ? (ley(world, 'obra') ? alivioCamino(c, steppedTile) : roadEffortFactor(steppedTile)) : 1;
  exertBody(person, { energy: 0, fatigue: 0.0007 * (1.2 - person.traits.resilience * 0.4) * alivio });
  if (physicalRoads && ley(world, 'obra')) {
    desgastarEmpedrado(c, steppedTile, pagadoJ);
    if ((steppedTile.traffic ?? 0) >= 0.72 && empedrar(c, person, steppedTile)) count(world, 'roadsPaved');
  }
  const visitedKey = `${person.x},${person.y}`;
  if (!person.visited.includes(visitedKey)) {
    person.visited.push(visitedKey); person.visited = person.visited.slice(-192);
    if (person.action === 'explore') outcome(world, person, 'explore', 0.05);
  }
  if (person.command?.order === 'move' && distance(person, person.command) < 0.5) {
    person.command = null; person.controlMode = 'auto'; person.decisionAt = world.tick + 1;
    person.reason = 'Llegó al destino solicitado; retoma sus decisiones.';
  }
}
