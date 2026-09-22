import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createWorld } from '../src/world/index.js';
import { durableActivityMetrics } from '../scripts/lab/metrics.js';

test('lab counts observed beneficial use, excluding inventions, manufacturing, water and old history', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // A reporting-only fixture: the receipt validator is tested in the archive suites.
    db.exec('CREATE TABLE technology_definitions(id TEXT, body TEXT); CREATE TABLE technology_executions(serial INTEGER, tick INTEGER, body TEXT)');
    const world = createWorld(51926); world.tick = 4800;
    const insert = db.prepare('INSERT INTO technology_executions VALUES(?,?,?)');
    db.prepare('INSERT INTO technology_definitions VALUES(?,?)').run('recipe-1', JSON.stringify({ inventorId: 'neighbor-1' }));
    db.prepare('INSERT INTO technology_definitions VALUES(?,?)').run('recipe-2', JSON.stringify({ inventorId: 'neighbor-2' }));
    const rows = [
      { tick: 2400, kind: 'use', recipeId: 'recipe-2', benefit: 1 },
      { tick: 2401, kind: 'research', recipeId: 'recipe-2', benefit: 1 },
      { tick: 2402, kind: 'craft', recipeId: 'recipe-2', benefit: 0 },
      { tick: 2403, kind: 'water', recipeId: 'recipe-2', benefit: 1 },
      { tick: 2404, kind: 'use', recipeId: 'recipe-2', benefit: 0 },
      { tick: 2405, kind: 'use', recipeId: 'recipe-1', benefit: 0.5 },
      { tick: 2406, kind: 'use', recipeId: 'recipe-1', benefit: 0.5 },
      { tick: 2407, kind: 'use', recipeId: 'recipe-unknown', benefit: 1 },
      { tick: 4801, kind: 'use', recipeId: 'recipe-2', benefit: 1 },
    ];
    rows.forEach((row, i) => insert.run(i + 1, row.tick, JSON.stringify({ ...row, success: true, actorId: 'neighbor-2' })));
    const value = durableActivityMetrics(world, db, 2400);
    assert.equal(value.recetasDistintasEnUso, 2);
    assert.equal(value.recetasDistintasFabricadas, 1);
    assert.equal(value.usosUtiles, 3);
    assert.equal(value.usosDeInventorAjeno, 2);
    assert.equal(value.usosSinAutorResuelto, 1);
    assert.equal(value.fraccionUsoAjeno, 1);
    assert.equal(value.beneficioUso, 2);
    assert.equal(value.vecinosMortales, 14);
    assert.equal(value.fundadoresMortalesVivos, 14);
    assert.deepEqual(value.generacionesMortalesVivas, [0]);
    assert.equal(durableActivityMetrics(world, db, 4800).fraccionUsoAjeno, null);
  } finally { db.close(); }
});
