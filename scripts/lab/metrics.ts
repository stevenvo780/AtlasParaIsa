import type { DatabaseSync } from 'node:sqlite';
import type { World } from '../../src/world/index.js';
import type { TechnologyExecution } from '../../src/shared/technology.js';
import { TECHNOLOGY_EXECUTION_KINDS, technologyPruneSeal,
  type TechnologyExecutionCounts } from '../../src/server/technology-archive.js';

/**
 * El Store puede podar el archivo de recibos (`persistencia.ventanaEventosTicks` > 0, nunca a menos de un día;
 * ver docs/REGLAS.md, «Retención del archivo de recibos»). Un intervalo que empieza antes del último recibo
 * podado mediría de menos sin avisar: falla en voz alta. Sin tabla `metadata` (bases sintéticas de prueba) o
 * sin frontera, no hay nada podado.
 */
export function assertExecutionsRetainedAfter(db: DatabaseSync, afterTick: number): void {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='metadata'").get()) return;
  const row = db.prepare("SELECT value FROM metadata WHERE key='technology-pruned-v1'").get() as { value: string } | undefined;
  if (!row) return;
  let value: Record<string, unknown>;
  try { value = JSON.parse(row.value) as Record<string, unknown>; }
  catch { throw new Error('Execution receipt prune boundary is invalid; metrics refuse an incomplete interval.'); }
  if (value.version === 1)
    throw new Error('Execution receipt prune boundary V1 has no authenticated seal; metrics refuse an incomplete interval.');
  const byKind = value.byKind as TechnologyExecutionCounts | undefined;
  const count = value.count, tick = value.tick;
  const valid = value.version === 2 && typeof value.startsAfter === 'number' && Number.isSafeInteger(value.startsAfter)
    && typeof value.through === 'number' && Number.isSafeInteger(value.through)
    && typeof tick === 'number' && Number.isSafeInteger(tick) && typeof count === 'number' && Number.isSafeInteger(count)
    && typeof value.digest === 'string' && typeof value.seal === 'string' && byKind && typeof byKind === 'object'
    && TECHNOLOGY_EXECUTION_KINDS.every(kind => Number.isSafeInteger(byKind[kind]) && byKind[kind] >= 0)
    && TECHNOLOGY_EXECUTION_KINDS.reduce((sum, kind) => sum + byKind[kind], 0) === count
    && technologyPruneSeal({ startsAfter: value.startsAfter, through: value.through, tick,
      digest: value.digest, count, byKind }) === value.seal;
  if (!valid) throw new Error('Execution receipt prune boundary is invalid; metrics refuse an incomplete interval.');
  if (tick > afterTick)
    throw new Error(`Execution receipts up to tick ${tick} were pruned; the interval after ${afterTick} is incomplete.`);
}

/** Complete committed interval, not the bounded live ring or lifetime catalogue count.
 * Call after store.save(). Empty use and unknown provenance remain explicit.
 */
export function durableActivityMetrics(world: World, db: DatabaseSync, afterTick: number) {
  assertExecutionsRetainedAfter(db, afterTick);
  const used = new Set<string>(), crafted = new Set<string>();
  let uses = 0, benefit = 0, foreignUses = 0, unknownAuthorUses = 0, learnedUses = 0;
  const people = new Map(world.people.map(person => [person.id, person]));
  const rows = db.prepare(`SELECT e.body, json_extract(d.body,'$.inventorId') AS inventor
    FROM technology_executions e LEFT JOIN technology_definitions d
    ON d.id=json_extract(e.body,'$.recipeId') WHERE e.tick>? AND e.tick<=? ORDER BY e.serial`);
  for (const row of rows.iterate(afterTick, world.tick)) {
    const execution = JSON.parse(row.body as string) as TechnologyExecution;
    if (!execution.success || !execution.recipeId) continue;
    if (execution.kind === 'craft') crafted.add(execution.recipeId);
    if (execution.kind !== 'use' || execution.benefit <= 0) continue;
    used.add(execution.recipeId); uses++; benefit += execution.benefit;
    if (row.inventor === null) unknownAuthorUses++;
    else if (row.inventor !== execution.actorId) foreignUses++;
    // A snapshot only proves provenance still remembered at this endpoint, not all teaching.
    if (people.get(execution.actorId)?.technology.learnedFrom.some(lesson => lesson.recipeId === execution.recipeId && lesson.tick <= execution.tick)) learnedUses++;
  }
  const neighbors = world.people.filter(person => person.role === 'neighbor');
  return {
    ventanaActividad: { desdeTickExclusivo: afterTick, hastaTickInclusivo: world.tick },
    vecinosMortales: neighbors.length,
    fundadoresMortalesVivos: neighbors.filter(person => person.genome.generation === 0).length,
    generacionesMortalesVivas: [...new Set(neighbors.map(person => person.genome.generation))].sort((a, b) => a - b),
    recetasDistintasEnUso: used.size, recetasDistintasFabricadas: crafted.size,
    usosUtiles: uses, beneficioUso: benefit, usosDeInventorAjeno: foreignUses,
    usosSinAutorResuelto: unknownAuthorUses,
    fraccionUsoAjeno: uses > unknownAuthorUses ? foreignUses / (uses - unknownAuthorUses) : null,
    usosConEnsenanzaRecordada: learnedUses,
    cooperacionAcumuladaPorTipo: Object.fromEntries(['teaching', 'trade', 'constructionHelp'].map(key => [key, world.totals[key] ?? 0])),
    otrasCooperacionesAcumuladas: (world.totals.cooperation ?? 0) - (world.totals.teaching ?? 0) - (world.totals.trade ?? 0) - (world.totals.constructionHelp ?? 0),
    conflictosAcumulados: world.totals.conflicts ?? 0,
  };
}
