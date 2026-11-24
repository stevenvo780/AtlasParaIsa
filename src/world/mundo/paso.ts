import type { World, WorldContext } from './tipos.js';
import { applyGesture, advanceWhispers } from '../actuar/gestos.js';
import { ecology } from './ecologia.js';
import { phaseAt, addEvent, remember, deathContext } from './crear.js';
import { precomputePolicyScores } from '../decision/politica-persona.js';
import { bodyAndAction } from '../actuar/cuerpo.js';
import { encounters } from '../actuar/interacciones.js';
import { transferEstate } from '../demografia/morir.js';
import { reproduce } from '../demografia/nacer.js';
import type { FaseNombre, Gesture, GestureResult } from '../../shared/types.js';
import { worldContext, bindWorldContext, maintainRegions } from '../spatial.js';
import { captureTechnologyCheckpoint, advanceTechnologyCheckpoint } from '../technology-checkpoint.js';
import { withArchiveReadBatch, withRecipeSession, catalogueEnabled } from '../technology-catalogue.js';
import { conRejilla } from '../rejilla.js';
import { conRejillaFauna, stepAnimals } from '../animals.js';
import { INTERVALO_ECOLOGIA_TICKS } from '../ecologia-constantes.js';
import { paramsOf } from '../params.js';
import { gpuNvrtcAvailable } from '../gpu/puente.js';
import { stepEcosystem } from '../ecosystem.js';
import { stepStructures } from '../inventions.js';
import { precomputePersonasParallel } from '../paralelo/personas-motor.js';
import { tileLookup } from '../tile-index.js';
import { residentFastAccess } from '../soa/terreno.js';
import { chunkKey, proceduralPlaceName } from '../terrain.js';
import { convivir, updateCommunities } from '../society.js';
import { advancePopulation } from '../lineage.js';
import { maintainTechnologyMemory } from '../technology.js';
import { recordSample } from '../statistics.js';


/** One fixed 100 ms step. Browser presence and wall-clock time are never inputs. */
/**
 * T107 (perfil por fase y fracción serial): reloj inyectado por el llamador —nunca
 * `performance.now()`/`Date.now()` aquí, regla 3— y el registro mutable donde se acumulan los
 * milisegundos por fase de este paso. Sin instrumentación (`medicion` ausente) el coste es un
 * único `if`; con ella, dos lecturas de reloj por fase.
 */
export interface FaseMedicion { clock: () => number; fases: Partial<Record<FaseNombre, number>>; }

function medirFase<T>(medicion: FaseMedicion | undefined, nombre: FaseNombre, fn: () => T): T {
  if (!medicion) return fn();
  const start = medicion.clock();
  const value = fn();
  medicion.fases[nombre] = (medicion.fases[nombre] ?? 0) + (medicion.clock() - start);
  return value;
}

/**
 * T107/FR-021: qué fases son serie **por diseño** hoy, según la tabla de fases de `plan.md`
 * (0 · Coordinador y D/E · Global y barrera) y la lista irreducible de `research.md` D21
 * (nacimientos, muertes, comunidades, checkpoint tecnológico, muestreo, `Store.save`). El resto
 * son las que la etapa B/C planean mover a workers (percepción/decisión por región). No incluye
 * el clon del paso (`cloneMs`): esa fase no está en la lista de `FaseNombre` de esta tarea.
 */
export const FASES_SERIALES: ReadonlySet<FaseNombre> = new Set(['maintainRegions', 'demografia', 'comunidades', 'reproduccion', 'checkpoint', 'muestreo', 'save', 'broadcast']);

/** T107: fracción de la suma de fases nombradas que es serie por diseño; 0 con suma cero para no dividir por cero ni devolver fuera de [0,1]. */
export function fraccionSerial(fases: Partial<Record<FaseNombre, number>>): number {
  let serie = 0, total = 0;
  for (const [nombre, ms] of Object.entries(fases) as [FaseNombre, number][]) { total += ms; if (FASES_SERIALES.has(nombre)) serie += ms; }
  return total > 0 ? serie / total : 0;
}

export function stepWorld(world: World, inputs: Gesture[] = [], context: WorldContext = worldContext(world), medicion?: FaseMedicion): GestureResult[] {
  bindWorldContext(world, context);
  const boundContext = worldContext(world) as WorldContext;
  if (world.technology.checkpoint === undefined) world.technology.checkpoint = captureTechnologyCheckpoint(world.technology, world.people, world.tick, 'migration');
  world.tick++;
  // Sprint noche-perf2 2026-09-22: el paso sólo LEE el archivo de recetas (nunca escribe en él: eso es
  // del guardado, fuera del paso), así que sus lecturas a fecha de este tick van como un lote del
  // anfitrión, con un solo sello de la memoria de lecturas del Store en vez de uno por lectura (~900 por
  // paso con ~230 habitantes). El mundo resultante es el mismo; ver `readBatch` en store.ts.
  return withArchiveReadBatch(world, () => conRejilla(world, () => conRejillaFauna(world, () => advanceTick(world, inputs, boundContext, medicion))));
}

function advanceTick(world: World, inputs: Gesture[], context: WorldContext, medicion: FaseMedicion | undefined): GestureResult[] {
  medirFase(medicion, 'maintainRegions', () => maintainRegions(world, context));
  const results = inputs.map((gesture, order) => applyGesture(world, gesture, order));
  world.invitations = world.invitations.filter(invitation => invitation.until > world.tick);
  world.reminders = world.reminders.filter(reminder => reminder.until > world.tick);
  medirFase(medicion, 'ecologia', () => ecology(world, context.ecologyExecution));
  if (world.tick % INTERVALO_ECOLOGIA_TICKS === 0 && paramsOf(world).motor.hilos === 1 && (paramsOf(world).motor.gpu.length === 0 || !gpuNvrtcAvailable())) context.ecologyExecution?.onBarrier?.({
    tick: world.tick, phase: 'ecologia', regionSide: context.ecologyExecution.regionSide ?? 256,
    orden: paramsOf(world).motor.orden, workers: 1, dirtyPages: undefined, diagnostics: null, topologyCertificate: undefined,
  });
  // T013 (decaimiento de fertilidad) + T035 (gateo de cuenca duradero: la lluvia no rellena
  // una tesela fuera de cuenca) viajan juntos en las mismas opciones de ecología.
  medirFase(medicion, 'kernel', () => stepEcosystem(world.tiles, world.tick, world.weather, phaseAt(world.tick), false,
    { decaimientoFertilidad: paramsOf(world).recursos.decaimientoFertilidad, seed: world.seed, cuencas: paramsOf(world).agua.cuencas, soaTerreno: paramsOf(world).motor.soaTerreno, hilos: paramsOf(world).motor.hilos,
      gpu: paramsOf(world).motor.gpu, orden: paramsOf(world).motor.orden, caminosFisicos: paramsOf(world).terreno.caminosFisicos, ...context.ecologyExecution }));
  medirFase(medicion, 'fauna', () => { stepAnimals(world,event=>addEvent(world,event)); stepStructures(world,event=>addEvent(world,event)); });
  medirFase(medicion, 'personas', () => withRecipeSession(world, () => {
    const motor = paramsOf(world).motor;
    const collectPolicyScores = precomputePolicyScores(world);
    const precomputedMoves = motor.particionarPersonas
      ? precomputePersonasParallel(world, motor, context.personasExecution)
      : undefined;
    const policyScores = collectPolicyScores?.();
    const tileIn = tileLookup(world.tiles);
    const fast = residentFastAccess(world.tiles) ?? null;
    for (let slot = 0; slot < world.people.length; slot++) bodyAndAction(world, world.people[slot]!, precomputedMoves, slot, policyScores, tileIn, fast);
    for (const person of world.people) {
      const chunk = world.chunks[chunkKey(person.x, person.y)]!;
      if (!chunk.discovered) {
        chunk.discovered = true; world.discoveredChunks++;
        const event = addEvent(world, { kind: 'discovery', actors: [person.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} descubrió ${proceduralPlaceName(world.seed, chunk.cx * 16, chunk.cy * 16)}.`, cause: 'Entró físicamente en una región que ningún habitante había recorrido; mirar con la cámara no cuenta como exploración.' });
        remember(person, world, 'Un nuevo territorio amplió los caminos posibles.', event.id);
      }
    }
  }));
  // V24: sin mensajes, ni una lectura más (0 ULP en todo mundo histórico).
  if (world.whispers?.length) advanceWhispers(world);
  medirFase(medicion, 'encuentros', () => { encounters(world); convivir(world); });
  medirFase(medicion, 'demografia', () => advancePopulation(world,{emit:event=>addEvent(world,event.kind==='death'?deathContext(world,event):event),beforeDeath:transferEstate}));
  medirFase(medicion, 'comunidades', () => updateCommunities(world, event => addEvent(world, event)));
  medirFase(medicion, 'reproduccion', () => reproduce(world));
  medirFase(medicion, 'checkpoint', () => {
    if (catalogueEnabled(world.technology)) for (const person of world.people) maintainTechnologyMemory(world, person);
    advanceTechnologyCheckpoint(world.technology, world.people, world.tick);
  });
  medirFase(medicion, 'muestreo', () => recordSample(world));
  return results;
}
