import assert from 'node:assert/strict';
import test from 'node:test';
import { encodePackedPeoplePage, preparePackedPerson } from '../src/server/snapshot-packed-people.js';
import { escalon } from '../src/shared/interruptores.js';
import { materializeAnimals } from '../src/world/animals.js';
import { CanalesCorte, decodificarCorteRemoto, enviarParteCorte, transferiblesCorteRemoto } from '../src/world/motor/mensajes-corte.js';
import { personasVerificadasDe } from '../src/world/motor/personas-corte.js';
import { parteCorteDe } from '../src/world/motor/reunir.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { parseParams } from '../src/world/params.js';

test('el corte retirado transfiere sus buffers y conserva las filas verificadas en el orden de los dueños', () => {
  const canales = CanalesCorte.abrir(2);
  assert.ok(canales);
  const tick = 6, epoca = 3;
  const parametros = parseParams({ v23: escalon('duenos'), conducta: { politicaPeso: 1 } });
  try {
    const mundos = [7, 11].map((semilla, i) => {
      const mundo = createWorld(semilla, parametros);
      mundo.tick = tick;
      mundo.people = mundo.people.slice(2 * i, 2 * i + 2).reverse();
      mundo.people[0]!.policy!.weights[0] = -0;
      mundo.people[0]!.policy!.weights[1] = Number.MIN_VALUE;
      delete mundo.people[1]!.policy;
      mundo.tiles = [{ x: i, y: 0, terrain: 'meadow', moisture: 0.7, vegetation: 0.1, food: 0, fauna: 1, species: 'hare' }];
      mundo.animals = materializeAnimals(semilla, mundo.tiles, tick);
      return mundo;
    });
    const solicitud = canales.pedir('directa', true, true);
    enviarParteCorte(canales.puertosRemotos[1]!, canales.solicitud, epoca, 2, mundos[1]!);
    enviarParteCorte(canales.puertosRemotos[0]!, canales.solicitud, epoca, 1, mundos[0]!);
    const retirado = canales.retirarCorte(solicitud, epoca, tick);
    assert.deepEqual(retirado.sobres.map(sobre => sobre.dueno), [1, 2]);
    const cuerpos = retirado.sobres.flatMap(sobre => {
      assert.ok(sobre.fauna?.length && sobre.teselas?.length && sobre.personas?.length);
      return [sobre.bytes, ...sobre.fauna.map(bloque => bloque.cuerpo), ...sobre.teselas.map(bloque => bloque.cuerpo),
        ...sobre.personas.flatMap(bloque => [bloque.cuerpo, bloque.pesos])];
    });
    assert.ok(cuerpos.every(cuerpo => cuerpo.byteLength > 0));
    const transfer = transferiblesCorteRemoto(retirado);
    assert.equal(transfer.length, cuerpos.length);
    const movido = structuredClone(retirado, { transfer });
    assert.ok(cuerpos.every(cuerpo => cuerpo.buffer.byteLength === 0));

    // El coordinador puede pedir el siguiente corte con otro modo mientras el receptor decodifica el anterior.
    canales.pedir();
    const { partes } = decodificarCorteRemoto(movido);
    assert.deepEqual(partes, mundos.map(parteCorteDe));
    for (const parte of partes) {
      assert.ok(Object.is(parte.people[0]!.policy!.weights[0], -0));
      const verificadas = personasVerificadasDe(parte.people);
      assert.ok(verificadas);
      const filas = verificadas.tramos.flatMap(tramo => tramo.filas);
      const canonicas = parte.people.map(persona => preparePackedPerson(persona as typeof persona & Record<string, unknown>));
      assert.deepEqual(encodePackedPeoplePage(filas), encodePackedPeoplePage(canonicas));
    }
  } finally { canales.cerrar(); }
});
