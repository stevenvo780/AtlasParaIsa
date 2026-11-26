import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import { LectorCinta } from '../src/server/cinta/lector.js';
import { projectTapeFrame } from '../src/server/sim-worker.js';
import { Store } from '../src/server/store.js';
import { escalon } from '../src/shared/interruptores.js';
import type { RuntimeStats, WorldView } from '../src/shared/types.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { createWorld } from '../src/world/index.js';
import { parseParams } from '../src/world/params.js';
import { projectWorld } from '../src/world/proyeccion.js';

function carpeta(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'v23-fotograma-servidor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('la vista de una obra funciona sobre una instantánea sin contexto de dueño', () => {
  const mundo = createWorld(7, parseParams({ v23: escalon('obra') }));
  const persona = mundo.people[0]!;
  persona.action = 'build';
  persona.work = 1;
  assert.equal(projectWorld(mundo).people.find(p => p.id === persona.id)?.workProgress, 1);
  assert.equal(projectTapeFrame(mundo, {} as RuntimeStats, undefined, []).people.find(p => p.id === persona.id)?.workProgress, 1);
});

test('la cinta binaria graba y el guardado completo sigue los ticks sin cambiar el digesto', async t => {
  const dir = carpeta(t), resultados: string[] = [];
  const params = parseParams({ v23: escalon('fotograma'), persistencia: { cadaTicks: 20 } });
  for (const tape of [false, true]) {
    const store = new Store(join(dir, tape ? 'mundo.sqlite' : 'control.sqlite'));
    const app = createApp({ store, params, seed: 7, origin: 'http://127.0.0.1', manual: true, tape, turbo: true,
      turboSaveIntervalMs: 300_000, password: 'fotograma-laboratorio' });
    try {
      for (let i = 0; i < 40; i++) {
        app.stepOnce();
        if (i % 5 === 0) await setImmediate();
      }
      assert.equal(app.world.tick, 40);
      assert.equal(app.guardado.ultimoTickGuardado, 40);
      assert.equal(app.salud().recargas, 0);
      resultados.push(digestoCanonico(app.world));
      if (tape) {
        const estado = await app.flushTape();
        assert.ok(estado.frames > 0);
        const lector = new LectorCinta(join(dir, 'cinta'));
        try {
          const { baseFrame } = JSON.parse(lector.chunk({ t: estado.latestTick, n: 1 })) as { baseFrame: WorldView };
          assert.ok(baseFrame.reparto?.paginas.length);
          assert.ok(baseFrame.reparto.paginas.every(p => p[2] === 0));
          assert.ok(baseFrame.tiles.length > 0);
        } finally { lector.close(); }
      }
    } finally {
      try { await app.close(); } finally { store.close(); }
    }
  }
  assert.equal(resultados[0], resultados[1]);
});

test('el guardado con cuerpos conserva el trabajo parcial y la serie cuenta las sustancias internadas', async t => {
  const dir = carpeta(t), path = join(dir, 'mundo.sqlite');
  const params = parseParams({ v23: escalon('fauna') });
  for (const epoca of [0, 1]) {
    const store = new Store(path);
    const app = createApp({ store, params, seed: 51926, origin: 'http://127.0.0.1', manual: true, tape: true, password: 'fotograma-laboratorio' });
    try {
      assert.equal(app.guardado.epoca, epoca);
      assert.equal(app.world.tick, 0);
      assert.ok(app.world.people.every(p => p.cuerpo));
      if (epoca === 0) app.world.people[0]!.work = 0.5;
      else assert.equal(app.world.people[0]!.work, 0.5);
      assert.ok(store.db.prepare('SELECT length(body) AS n FROM snapshot_matter WHERE slot=0').get()?.n);
      assert.ok(app.world.animals.every(a => a.cuerpo));
      await app.flushTape();
    } finally {
      try { await app.close(); } finally { store.close(); }
    }
  }
  const store = new Store(path, { readOnly: true });
  try { assert.equal(store.verificarGuardado()?.world.tick, 0); }
  finally { store.close(); }
  const lector = new LectorCinta(join(dir, 'cinta'));
  try { assert.ok(lector.meta().serie.some(p => p.sustancias > 0)); }
  finally { lector.close(); }
});
