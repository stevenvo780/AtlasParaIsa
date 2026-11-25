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


/** Physical relief from the material state of the single cell underfoot. */
export function roadEffortFactor(tile: { traffic?: number; paved?: number } | undefined): number {
  return 1 - Math.min(0.55, Math.max(0, tile?.traffic ?? 0) * 0.45 + Math.max(0, tile?.paved ?? 0) * 0.15);
}


/** Breadth-first movement takes one adjacent land cell. It never crosses water or teleports. */
export function move(world: World, person: Person, tileInArg?: TileLookup, readerArg?: ResidentTileReader | null): void {
  if (distance(person, person.target) < 0.5) return;
  const key = (p: Point) => `${p.x},${p.y}`;
  const start = { x: person.x, y: person.y };
  let nextStep: Point | null = null;
  let blocked = false;
  const physicalRoads = paramsOf(world).terreno.caminosFisicos;
  const startDistance = physicalRoads ? distance(start, person.target) : 0;
  let roadStep: Point | null = null, roadDistance = Infinity, roadBestDistance = Infinity, roadScore = Infinity;
  // At most two cardinal neighbors can reduce Euclidean distance. Compare those in one pass;
  // the road bonus cannot admit a step more than 0.15 farther than the best reducing neighbor.
  const considerRoad = (x: number, y: number, tile: Tile | undefined): void => {
    if (!tile || tile.terrain === 'water') return;
    const d = distance({ x, y }, person.target);
    if (d >= startDistance) return;
    roadBestDistance = Math.min(roadBestDistance, d);
    const score = d - 0.18 * ((tile.traffic ?? 0) + (tile.paved ?? 0) * 0.5);
    if (d <= roadBestDistance + 0.15 && (roadDistance > roadBestDistance + 0.15 || score < roadScore)) {
      roadStep = { x, y }; roadDistance = d; roadScore = score;
    }
  };
  const allowCoastalDetour = paramsOf(world).social.vinculoEncuentro > 0
    && person.action === 'approach' && !person.command && distance(start, person.target) > 12;
  const tileIn = tileInArg ?? tileLookup(world.tiles);
  if ((!blocked && nextStep === null) || allowCoastalDetour) {
    const routeKey = (x: number, y: number) => cellIntKey(x, y) ?? `${x},${y}`;
    const reader = readerArg === undefined ? residentTileReader(world.tiles) : readerArg ?? undefined;
    const queue: Point[] = [start], previous = new Map<number | string, Point | null>([[routeKey(start.x, start.y), null]]);
    let best = start, bestDist = distance(start, person.target), head = 0;
    // Bounded local BFS takes one physical step toward even a distant order.
    while (head < queue.length && head < 2048) {
      const current = queue[head++]!, dCurrent = distance(current, person.target);
      if (dCurrent < bestDist) { best = current; bestDist = dCurrent; }
      if (dCurrent < 0.5) { best = current; break; }
      for (let direction = 0; direction < 4; direction++) {
        const x = direction === 0 ? current.x + 1 : direction === 2 ? current.x - 1 : current.x;
        const y = direction === 1 ? current.y + 1 : direction === 3 ? current.y - 1 : current.y;
        if (Math.max(Math.abs(x - start.x), Math.abs(y - start.y)) > 24) continue;
        if (reader) {
          const cell = reader.cellAt(x, y);
          if (cell < 0 || reader.terrainCode(cell) === reader.TERRAIN_WATER) continue;
        } else {
          const tile = tileIn(x, y);
          if (!tile || tile.terrain === 'water') continue;
          if (physicalRoads && current === start) considerRoad(x, y, tile);
        }
        if (physicalRoads && reader && current === start) considerRoad(x, y, tileIn(x, y));
        const nextKey = routeKey(x, y);
        if (previous.has(nextKey)) continue;
        const next = { x, y };
        previous.set(nextKey, current); queue.push(next);
      }
    }
    if (allowCoastalDetour && queue.length > 1 && distance(start, person.target) - distance(best, person.target) < 1.5) {
      const side = Math.floor(world.tick / 360) % 2 === 0 ? Math.PI / 2 : -Math.PI / 2;
      const angle = Math.atan2(person.target.y - start.y, person.target.x - start.x) + side;
      const tx = Math.cos(angle), ty = Math.sin(angle);
      let bestDetour = start, bestDot = -Infinity;
      for (let idx = 1; idx < queue.length; idx++) {
        const node = queue[idx]!;
        const dot = (node.x - start.x) * tx + (node.y - start.y) * ty;
        if (dot > bestDot) { bestDot = dot; bestDetour = node; }
      }
      if (bestDetour !== start) best = bestDetour;
    }
    if (best === start) blocked = true;
    else {
      while (previous.get(routeKey(best.x, best.y)) !== start) best = previous.get(routeKey(best.x, best.y))!;
      nextStep = best;
      blocked = false;
    }
  } else if (physicalRoads && nextStep && distance(nextStep, person.target) < startDistance) {
    // The worker already chose a route. Only its four-cell local stencil is consulted here;
    // no route search, halo extension, or world scan is introduced by the road preference.
    considerRoad(start.x + 1, start.y, tileIn(start.x + 1, start.y));
    considerRoad(start.x, start.y + 1, tileIn(start.x, start.y + 1));
    considerRoad(start.x - 1, start.y, tileIn(start.x - 1, start.y));
    considerRoad(start.x, start.y - 1, tileIn(start.x, start.y - 1));
  }
  // Keep route-selected detours around water/obstacles; roads only break local progress ties.
  if (physicalRoads && roadStep && nextStep && !allowCoastalDetour) {
    const baselineDistance = distance(nextStep, person.target);
    if (baselineDistance < startDistance && baselineDistance <= roadBestDistance + 0.15) {
      const tile = tileIn(nextStep.x, nextStep.y);
      const baselineScore = baselineDistance - 0.18 * ((tile?.traffic ?? 0) + (tile?.paved ?? 0) * 0.5);
      if (roadScore < baselineScore) nextStep = roadStep;
    }
  }
  if (blocked || !nextStep) {
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
