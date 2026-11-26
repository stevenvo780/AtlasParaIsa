import assert from 'node:assert/strict';
import test from 'node:test';
import { deserialize } from 'node:v8';
import { Store } from '../src/server/store.js';
import { stringifyExact } from '../src/shared/exact-json.js';
import { escalon } from '../src/shared/interruptores.js';
import { codificarCheckpoint } from '../src/world/materia/checkpoint.js';
import { ORDEN, duenoSi, type Migrante } from '../src/world/motor/contexto.js';
import { TipoIntento, unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { recibirFaunaDirecta } from '../src/world/motor/fauna-corte.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { parseParams } from '../src/world/params.js';
import { filaInstantanea } from './lib/store.js';

test('la recepción directa rechaza una clave repetida aunque venga escapada', () => {
  const cuerpo = new TextEncoder().encode('{"x":0,"\\u0078":1}');
  assert.throws(() => recibirFaunaDirecta([{ filas: 1, cuerpo }], 1), /claves repetidas/);
});

test('el corte sellado conserva fauna de dos dueños y una cesión en vuelo byte a byte', async t => {
  const mundo = createWorld(42, parseParams({ v23: { ...escalon('duenos'), guardadoCompleto: true } }));
  const motor = crearMotor(mundo, { ...unSoloDueno(42), hilos: 2,
    instantaneaTransferible: true, faunaCorteDirecta: true });
  const anterior = new Store(':memory:', { snapshotPackedPeople: true });
  const directa = new Store(':memory:', { snapshotPackedPeople: true });
  t.after(async () => { await motor.cerrar(); anterior.close(); directa.close(); });

  motor.cargar({ world: mundo, materia: null }, 0);
  motor.paso([]);
  const d = duenoSi(mundo)!;
  assert.ok(mundo.animals.length > 0);
  const elegido = mundo.animals[0]!, terreno = d.terreno;
  const chunk = terreno.chunkDe(terreno.celda(elegido.x, elegido.y));
  assert.equal(terreno.duenoChunk[chunk], 0);
  const clave = `${terreno.paginaX[chunk]},${terreno.paginaY[chunk]}`;
  d.ordenar(0, [ORDEN.ceder, chunk, 1]);
  terreno.duenoSiguiente[chunk] = 1;
  motor.paso([]);
  const migrante = d.pendientes().filter(i => i.tipo === TipoIntento.Migrante)
    .map(i => deserialize(i.bytes!) as Migrante).find(m => m.tipo === 'chunk' && m.key === clave);
  assert.ok(migrante?.tipo === 'chunk' && migrante.animals.length > 0);

  anterior.guardar(motor.instantanea());
  const sello = motor.corteGuardadoSellado?.();
  assert.ok(sello);
  const guardado = directa.guardarCorteSellado(sello, [], []);
  assert.deepEqual(filaInstantanea(directa), filaInstantanea(anterior));
  assert.ok(directa.snapshotFaunaCorteStats.reused > 0);
  assert.equal(directa.snapshotFaunaCorteStats.compared, 0);
  const almacen = (store: Store) => store.db.prepare('SELECT digest, body FROM snapshot_parts ORDER BY digest').all();
  assert.deepEqual(almacen(directa), almacen(anterior));
  for (const a of migrante.animals) assert.ok(guardado.world.animals.some(fila => fila.uid === a.uid));
  assert.throws(() => directa.guardarCorteSellado(sello, [], []), /ya consumido/);

  const leido = directa.cargarGuardadoCompleto();
  assert.ok(leido?.instantanea.materia && guardado.materia);
  assert.equal(stringifyExact(leido.instantanea.world.animals), stringifyExact(guardado.world.animals));
  assert.deepEqual(codificarCheckpoint(leido.instantanea.materia), codificarCheckpoint(guardado.materia));

  const vencido = motor.corteGuardadoSellado?.();
  assert.ok(vencido);
  motor.paso([]);
  assert.throws(() => directa.guardarCorteSellado(vencido, [], []), /paso anterior/);
  const tickGuardado = guardado.world.tick;
  motor.cargar(guardado, 0);
  const siguiente = motor.paso([]);
  assert.equal(siguiente.tick, tickGuardado + 1);
});
