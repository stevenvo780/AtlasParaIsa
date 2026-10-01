import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { assertWorld, createWorld, stepWorld, type World } from '../src/world/index.js';
import { createMaterialObserver } from '../src/world/material-observer.js';
import { desgasteQ } from '../src/world/desgaste.js';
import { DESGASTE_Q } from '../src/shared/life.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, parseParams } from '../src/world/params.js';
import { InstrumentoCribadoDesgaste } from '../scripts/lab/instrumento-desg-d.js';

/**
 * Puerta de identidad de la rama de laboratorio DESG-D (preregistro
 * `datos-lab/desg-d-cribado/PRERREGISTRO.md`): el observador material A + censo con
 * proyección son de solo lectura con la ley a 0 y a 1. Semillas 18301–18306 nuevas
 * (0 refs en md/replica/manifest/preregistros el 01-10).
 */

const LEY1 = parseParams('material.desgasteDormido=1', DEFAULT_PARAMS);

function corre(seed: number, ley1: boolean, instrumentado: boolean): World {
  const world = createWorld(seed, ley1 ? LEY1 : DEFAULT_PARAMS);
  const observer = instrumentado ? createMaterialObserver() : null;
  observer?.ingest(world);
  for (let n = 1; n <= 1200; n++) { stepWorld(world); observer?.ingest(world); }
  if (observer) { observer.exportRows(); observer.exportDesgaste(); }
  return world;
}

test('(L0) identidad: con/sin instrumentos el mundo es idéntico, ley 0 y 1, 6 semillas × 1200', { timeout: 600_000 }, () => {
  for (const seed of [18301, 18302, 18303, 18304, 18305, 18306]) {
    for (const ley1 of [false, true]) {
      const sin = corre(seed, ley1, false), con = corre(seed, ley1, true);
      assert.equal(digestoCanonico(con), digestoCanonico(sin), `semilla ${seed} ley=${ley1 ? 1 : 0}`);
    }
  }
  assertWorld(corre(18301, true, true));
});

test('(L1) proyección: el despertar registra ancla + f(ancla,N,R) exactos', { timeout: 120_000 }, () => {
  const world = createWorld(18311, LEY1);
  const observer = createMaterialObserver();
  observer.ingest(world);
  const id = world.structures[0]!.id;
  const ancla = { ...world.structures[0]!.anclaDesgaste! };
  const sx = world.structures[0]!.x, sy = world.structures[0]!.y;
  for (let t = 1; t <= 599; t++) { stepWorld(world); observer.ingest(world); }
  for (const p of world.people) { p.x = 1000; p.y = 1000; p.target = { x: 1000, y: 1000 }; }
  stepWorld(world); observer.ingest(world); // retirada en el 600
  assert.ok(!world.structures.some(s => s.id === id));
  for (let t = 601; t <= 609; t++) { stepWorld(world); observer.ingest(world); }
  for (const p of world.people) { p.x = sx; p.y = sy; p.target = { x: sx, y: sy }; }
  stepWorld(world); observer.ingest(world); // reactivación en el 610
  const N = world.revisionesObra!, R = world.revisionesLluvia!;
  const reg = observer.exportDesgaste().activaciones.filter(a => a.structureId === id && a.dormidaTicksPrevios > 0);
  assert.equal(reg.length, 1, 'un despertar tras retirada');
  // El despertar se etiqueta con el horizonte vigente EN maintainRegions (N=60: la revisión
  // 610 aún no corrió); el registro es autoconsistente con su propio N/R.
  assert.equal(reg[0]!.N, 60);
  assert.equal(N, 61, 'tras el paso 610 la revisión ya avanzó N');
  const esperada = desgasteQ(ancla.q0, ancla.n0, ancla.r0, reg[0]!.N, reg[0]!.R, 1) / DESGASTE_Q;
  assert.equal(reg[0]!.conditionAlDespertar, esperada);
  assert.equal(reg[0]!.proyectada, esperada, 'proyección = observada = f(ancla,N,R)');
  assert.deepEqual(reg[0]!.ancla, ancla);
  assert.equal(reg[0]!.dormidaTicksPrevios, 10, 'dormida los ticks [600,610)');
});

test('(L2) censo: residentes + pendientes + SQLite sin duplicar, con proyección', { timeout: 120_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-desg-lab-'));
  const store = new Store(join(directory, 'world.sqlite'));
  try {
    const world = createWorld(18312, LEY1);
    store.save(world);
    const instr = new InstrumentoCribadoDesgaste();
    instr.alEmpezar(world);
    const id = world.structures[0]!.id;
    for (let t = 1; t <= 300; t++) { stepWorld(world); instr.trasPaso(world); if (world.tick % 300 === 0) store.save(world); }
    for (const p of world.people) { p.x = 1000; p.y = 1000; p.target = { x: 1000, y: 1000 }; }
    for (let t = 301; t <= 600; t++) { stepWorld(world); instr.trasPaso(world); if (world.tick % 300 === 0) store.save(world); }
    assert.ok(!world.structures.some(s => s.id === id), 'la obra se retiró');
    assert.equal(world.retiredChunks.length, 0, 'el guardado vació los pendientes a SQLite');
    const dia = instr.metricasDia(world, store);
    assert.equal(dia.ley, 1);
    assert.ok(dia.obrasTotales >= 1 && dia.obrasDormidas >= 1, 'el censo ve la obra solo-en-SQLite');
    assert.ok(dia.fraccionRotasProyectada === null || (dia.fraccionRotasProyectada >= 0 && dia.fraccionRotasProyectada <= 1));
    assert.ok(dia.mortales > 0 && Number.isInteger(dia.reparacionesDia) && dia.maderaReparacionDia === dia.reparacionesDia);
    const fin = instr.exportFinal();
    assert.equal(fin.version, 1);
    assert.ok(fin.observador && fin.observador.structures.length >= 1);
    assert.ok(fin.desg && Array.isArray(fin.desg.activaciones));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('(L3) replica.ts escribe desgD diario + material.json (humo de cableado)', { timeout: 300_000 }, () => {
  const salida = mkdtempSync(join(tmpdir(), 'atlas-desg-smoke-'));
  try {
    execFileSync('./node_modules/.bin/tsx', ['scripts/lab/replica.ts', '--seed', '18311', '--dias', '1',
      '--params', 'persistencia.cadaTicks=300,material.desgasteDormido=1', '--salida', salida, '--gobernador', 'no'],
      { cwd: new URL('..', import.meta.url).pathname, timeout: 240_000 });
    const dia = JSON.parse(readFileSync(join(salida, 'dia-001.json'), 'utf8')) as Record<string, unknown>;
    const desgD = dia.desgD as Record<string, unknown>;
    assert.ok(desgD, 'dia-001.json trae desgD');
    for (const k of ['ley', 'N', 'R', 'mortales', 'maderaCorporal', 'obrasConstruidasDia', 'reparacionesDia',
      'maderaReparacionDia', 'obrasTotales', 'obrasDormidas', 'rotasProyectadas', 'fraccionRotasProyectada']) assert.ok(k in desgD, `desgD.${k}`);
    assert.equal(desgD.ley, 1);
    const mat = JSON.parse(readFileSync(join(salida, 'material.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(mat.version, 1);
    assert.ok((mat.observador as Record<string, unknown>).structures !== undefined);
    assert.ok(Array.isArray((mat.desg as Record<string, unknown>).activaciones));
  } finally { rmSync(salida, { recursive: true, force: true }); }
});
