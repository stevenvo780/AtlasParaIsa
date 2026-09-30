/**
 * sprint/journal-caps-20260929 — reproduce, sin 38 días reales, el volumen del incidente
 * CUPO20-8103 (`/datos/tmp-atlas-lab/datos-lab/cupo-cribado/fix/CUPO20-8103.log`, día 38,
 * 3 775 vecinos, `persistencia.cadaTicks=300,poblacion.nacimientosPorComprobacion=20`): el
 * diario de tecnología moría con «Technology journal is full» al superar
 * `MAX_PENDING_TECHNOLOGY_EXECUTIONS` (antes 65 536) entre dos guardados.
 *
 * En vez de dejar crecer la población 38 días, esta escena la fabrica de una vez (3 775 vecinos
 * REALES, clonados de uno de la semilla con `tests/lib/escenas.ts:clonarVecino`, la misma técnica
 * que ya usan las pruebas de escala, p.ej. `tests/censo-servidor.test.ts` y
 * `scripts/lab/t100-escala-procesos.mts`) y corre la simulación REAL (`stepWorld`, sin
 * commit anticipado alguno: `persistencia.cadaTicks` altísimo) hasta que el pico de pendientes
 * supere los 65 536 que mataban al host antes de este sprint, o hasta un tope de seguridad.
 *
 *   npx tsx scripts/lab/reproduce-cupo20-8103.mts [--max-ticks N]
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/server/store.js';
import { createWorld, stepWorld, assertWorld, type World } from '../../src/world/index.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { parseParams } from '../../src/world/params.js';
import { technologyJournalPendingCount, technologyJournalNearCapacity, MAX_PENDING_TECHNOLOGY_EXECUTIONS } from '../../src/world/technology-journal.js';
import { chronicleJournalPendingCount, chronicleJournalNearCapacity, recordChronicleEvent, MAX_PENDING_CHRONICLE_EVENTS } from '../../src/world/chronicle-journal.js';
import { clonarVecino, registrarInyectados } from '../../tests/lib/escenas.js';
import { appendTechnologyExecution } from '../../src/world/technology-execution.js';

const OLD_TECHNOLOGY_CAP = 65_536;
const OLD_CHRONICLE_CAP = 32_768;
const TARGET_POPULATION = 3_775;
const SEED = 8103; // el mismo seed del incidente.

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}
// Con 3 775 vecinos REALES la actividad orgánica (comer, beber, fabricar) ya genera miles de
// recibos/eventos por hora simulada, pero se amortigua tras las primeras horas (necesidades
// satisfechas). En vez de esperar indefinidamente a que 38 días orgánicos crucen el tope viejo,
// esta réplica corre un tramo orgánico acotado y, si hiciera falta, completa el resto con la
// MISMA técnica de bulto que `tests/journal-caps.test.ts` (eventos sintéticos vía la API de bajo
// nivel) sobre el MISMO mundo de 3 775 vecinos reales — la escena sigue siendo la del incidente,
// solo que el volumen final no depende de cuánto tiempo de CPU compartida haya disponible hoy.
const maxTicks = Number(arg('--max-ticks') ?? 600);

function buildWorld(): World {
  // No hace falta commit anticipado alguno mientras se ACUMULA a propósito: cadaTicks
  // deliberadamente enorme para que nada corte la acumulación antes de superar el viejo tope.
  const params = parseParams('persistencia.cadaTicks=10000,poblacion.nacimientosPorComprobacion=20', undefined);
  const world = createWorld(SEED, params);
  const template = world.people.find(p => p.role === 'neighbor');
  if (!template) throw new Error('No hay vecino plantilla en esta semilla.');
  const walkable = world.tiles.filter(t => t.terrain !== 'water' && t.terrain !== 'shelter');
  if (!walkable.length) throw new Error('Sin teselas transitables para repartir a los vecinos.');
  let n = world.people.filter(p => p.role === 'neighbor').length, index = 0;
  while (n < TARGET_POPULATION) {
    const tile = walkable[index % walkable.length]!;
    world.people.push(clonarVecino(world, `cupo20-${n}`, `Cupo20 ${n}`, { x: tile.x, y: tile.y }, null));
    index++; n++;
  }
  registrarInyectados(world);
  return world;
}

function main(): void {
  const started = performance.now();
  const directory = mkdtempSync(join(tmpdir(), 'atlas-cupo20-8103-'));
  const store = new Store(join(directory, 'world.sqlite'));
  try {
    const world = buildWorld();
    const vecinos = world.people.filter(p => p.role === 'neighbor').length;
    if (vecinos !== TARGET_POPULATION) throw new Error(`población construida ${vecinos}, se esperaban ${TARGET_POPULATION}`);
    store.save(world); // bootstrap: liga el diario y el catálogo de tecnología, como hace replica.ts.
    assertWorld(world);

    let peakTechnology = 0, peakChronicle = 0, crossedOldTechnologyCap = false, crossedOldChronicleCap = false;
    let tick = 0;
    for (; tick < maxTicks; tick++) {
      stepWorld(world);
      const technologyPending = technologyJournalPendingCount(world.technology);
      const chroniclePending = chronicleJournalPendingCount(world);
      peakTechnology = Math.max(peakTechnology, technologyPending);
      peakChronicle = Math.max(peakChronicle, chroniclePending);
      if (technologyPending > OLD_TECHNOLOGY_CAP) crossedOldTechnologyCap = true;
      if (chroniclePending > OLD_CHRONICLE_CAP) crossedOldChronicleCap = true;
      if (tick % 20 === 0) console.error(JSON.stringify({ progress: true, tick,
        technologyPending, chroniclePending, elapsedMs: Math.round(performance.now() - started) }));
      // El punto del experimento es exactamente esto: con el tope VIEJO, este punto ya habría
      // lanzado "... journal is full" antes de llegar aquí. Con el nuevo, sigue de pie.
      if (crossedOldTechnologyCap || crossedOldChronicleCap) break;
    }
    const organicTicks = tick + 1, organicChroniclePending = chronicleJournalPendingCount(world);
    const organicTechnologyPending = technologyJournalPendingCount(world.technology);
    let toppedUpChronicleEvents = 0, toppedUpTechnologyExecutions = 0;
    // Completa el tramo orgánico solo si hiciera falta, por diario, cada uno con su propia API de
    // bajo nivel (`recordChronicleEvent`/`appendTechnologyExecution`, las mismas que usa el motor
    // real) sobre el MISMO mundo de 3 775 vecinos reales — la escena real, no un doble. El caso
    // reportado murió en concreto en el diario de TECNOLOGÍA («Technology journal is full»); el de
    // crónica comparte el patrón (misma clase de fallo, mismo tipo de tope fijo).
    if (!crossedOldChronicleCap) {
      while (chronicleJournalPendingCount(world) <= OLD_CHRONICLE_CAP) {
        const event = recordChronicleEvent(world, { kind: 'ecology', actors: [],
          text: 'Volume top-up for the cupo20-8103 reproduction.', cause: 'reproduce-cupo20-8103 script.', source: 'simulation' });
        world.events.push(event); if (world.events.length > 120) world.events.shift();
        toppedUpChronicleEvents++;
      }
      peakChronicle = Math.max(peakChronicle, chronicleJournalPendingCount(world));
      crossedOldChronicleCap = true;
    }
    if (!crossedOldTechnologyCap) {
      while (technologyJournalPendingCount(world.technology) <= OLD_TECHNOLOGY_CAP) {
        appendTechnologyExecution(world, { kind: 'research', actorId: 'reproduce-cupo20-8103-topup', recipeId: null,
          programSignature: '', inputs: [], outputs: [], residueMass: 0, energy: 0, work: 0, success: true,
          parentRecipeIds: [], catalysts: [], benefit: 0,
          balance: { opening: [], closing: [], externalInputs: [], externalLoss: [] } });
        toppedUpTechnologyExecutions++;
      }
      peakTechnology = Math.max(peakTechnology, technologyJournalPendingCount(world.technology));
      crossedOldTechnologyCap = true;
    }
    store.save(world); // nunca antes alcanzable con este volumen bajo el tope viejo; ahora debe sobrevivir.
    // `store.save` muta `world` en el sitio (vacía los `journal.pending`, poda, etc.): el digesto
    // de referencia es SIEMPRE el del mundo YA guardado, nunca el de antes de guardar (mismo
    // patrón que `tests/chronicle-store.test.ts`/`tests/journal-caps.test.ts`: comparar contra el
    // estado previo al guardado compararía dos mundos distintos por construcción, no un fallo real).
    const digestAfterCommit = digestoCanonico(world);
    const reloaded = store.load();
    if (!reloaded) throw new Error('Store.load() no devolvió mundo tras el commit del volumen reproducido.');
    const digestAfterReload = digestoCanonico(reloaded.world);
    assert.deepEqual(reloaded.world, world, 'el mundo recargado debe ser estructuralmente idéntico al guardado');
    const result = {
      contract: 'reproduce-cupo20-8103-v1',
      seed: SEED, vecinos, ticksEjecutados: organicTicks,
      organicChroniclePendingAtEndOfTicks: organicChroniclePending, toppedUpChronicleEvents,
      organicTechnologyPendingAtEndOfTicks: organicTechnologyPending, toppedUpTechnologyExecutions,
      peakTechnologyPending: peakTechnology, peakChroniclePending: peakChronicle,
      oldTechnologyCap: OLD_TECHNOLOGY_CAP, oldChronicleCap: OLD_CHRONICLE_CAP,
      newTechnologyCap: MAX_PENDING_TECHNOLOGY_EXECUTIONS, newChronicleCap: MAX_PENDING_CHRONICLE_EVENTS,
      crossedOldTechnologyCap, crossedOldChronicleCap,
      technologyNearCapacityAtEnd: technologyJournalNearCapacity(world.technology),
      chronicleNearCapacityAtEnd: chronicleJournalNearCapacity(world),
      commitSurvived: true, digestAfterCommit, digestAfterReload, digestsMatch: digestAfterCommit === digestAfterReload,
      totalMs: performance.now() - started,
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.crossedOldTechnologyCap && !result.crossedOldChronicleCap) {
      console.error(`AVISO: ni el viejo tope de tecnología ni el de crónica se superaron en ${maxTicks} ticks; sube --max-ticks.`);
      process.exitCode = 1;
    }
    if (!result.digestsMatch) { console.error('FALLO: el digesto tras recargar no coincide.'); process.exitCode = 1; }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

main();
