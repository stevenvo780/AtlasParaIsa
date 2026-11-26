import assert from 'node:assert/strict';
import test from 'node:test';
import { deserialize, serialize } from 'node:v8';
import { preparePackedPerson, WPF1_WEIGHT_BYTES } from '../src/server/snapshot-packed-people.js';
import { escalon } from '../src/shared/interruptores.js';
import {
  personasVerificadasDe, prepararPersonasDirectas, recibirPersonasDirectas, tomarPersonasVerificadas,
  type BloquePersonasCorte,
} from '../src/world/motor/personas-corte.js';
import { parteCorteDe } from '../src/world/motor/reunir.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { parseParams } from '../src/world/params.js';

function mundoConPolitica() {
  return createWorld(42, parseParams({
    v23: { ...escalon('duenos'), guardadoCompleto: true }, conducta: { politicaPeso: 1 },
  }));
}

test('el corte directo recupera la forma V8 y prepara las mismas filas WPF1 de un mundo real', () => {
  const parte = parteCorteDe(mundoConPolitica());
  const persona = parte.people[0]!;
  const detalles = { 1: undefined, 2: 0, antes: undefined, dentro: [{ propia: undefined, valor: -0 }], despues: undefined };
  Object.assign(persona, { detalles, finalmente: undefined });
  persona.x = -0;
  persona.reason = 'Ñ 🧮\n\t\r\ud800';
  persona.policy!.weights[0] = -0;
  persona.policy!.weights[1] = Number.MIN_VALUE;
  delete parte.people[1]!.policy;
  assert.ok(Object.hasOwn(persona, 'partnerMemory') && Object.hasOwn(persona.technology, 'waterPreparation'));

  const bloques = prepararPersonasDirectas(parte);
  assert.ok(bloques);
  assert.equal(bloques.reduce((total, bloque) => total + bloque.pesos.byteLength, 0), (parte.people.length - 1) * WPF1_WEIGHT_BYTES);
  const transfer = bloques.flatMap(bloque => [bloque.cuerpo, bloque.pesos])
    .filter(bytes => bytes.byteLength).map(bytes => {
      assert.equal(bytes.byteOffset, 0);
      assert.equal(bytes.byteLength, bytes.buffer.byteLength);
      assert.ok(bytes.buffer instanceof ArrayBuffer);
      return bytes.buffer;
    });
  assert.equal(new Set(transfer).size, transfer.length);
  const movidos = structuredClone(bloques, { transfer });
  assert.ok(transfer.every(buffer => buffer.byteLength === 0));

  const personas = recibirPersonasDirectas(movidos, parte.people.length);
  assert.deepEqual(personas, deserialize(serialize(parte.people)));
  const restaurada = personas[0]! as typeof persona & { detalles: typeof detalles };
  assert.deepEqual(Object.keys(restaurada), Object.keys(persona));
  assert.deepEqual(Object.keys(restaurada.detalles), Object.keys(detalles));
  assert.deepEqual(Object.keys(restaurada.detalles.dentro[0]!), Object.keys(detalles.dentro[0]!));
  assert.ok(Array.isArray(restaurada.policy!.weights));
  assert.ok(Object.is(restaurada.x, -0) && Object.is(restaurada.policy!.weights[0], -0));

  const verificado = personasVerificadasDe(personas);
  assert.ok(verificado);
  const filas = verificado.tramos.flatMap(tramo => tramo.filas);
  assert.deepEqual(filas, parte.people.map(p => preparePackedPerson(p as unknown as Record<string, unknown>)));
  assert.ok(Object.isFrozen(filas[0]) && Object.isFrozen(filas[0]!.weights));
  assert.equal(verificado.modificadas.size, 0);
  restaurada.policy!.weights[0] = 1;
  assert.ok(Object.is(filas[0]!.weights![0], -0));
  assert.equal(tomarPersonasVerificadas(personas), verificado);
  assert.equal(personasVerificadasDe(personas), undefined);
});

test('se acotan los bloques sin cambiar el orden y se admite un dueño sin personas', () => {
  const parte = parteCorteDe(createWorld(42));
  parte.people = parte.people.slice(0, 2);
  for (const persona of parte.people) persona.reason = 'a'.repeat(2 * 1024 * 1024);
  const bloques = prepararPersonasDirectas(parte);
  assert.ok(bloques && bloques.length === 2);
  assert.ok(bloques.every(bloque => bloque.filas === 1 && bloque.pesos.byteLength === 0));
  const recibidas = recibirPersonasDirectas(bloques, 2);
  assert.deepEqual(recibidas, parte.people);
  assert.deepEqual(personasVerificadasDe(recibidas)?.tramos.map(tramo => tramo.desde), [0, 1]);

  parte.people[0]!.reason += 'a'.repeat(2 * 1024 * 1024);
  assert.equal(prepararPersonasDirectas(parte), undefined);
  parte.people = [];
  assert.deepEqual(prepararPersonasDirectas(parte), []);
  assert.deepEqual(recibirPersonasDirectas([], 0), []);
});

test('el dueño conserva V8 para alias, huecos, prototipos especiales y accesores', () => {
  const casos = [
    (parte: ReturnType<typeof parteCorteDe>) => {
      const plastica = parte.people[0]!.policyPlasticity!;
      plastica.bias = plastica.trace;
    },
    (parte: ReturnType<typeof parteCorteDe>) => {
      Object.assign(parte.technology, { interna: [{ objetivo: parte.people[0]!.target }] });
    },
    (parte: ReturnType<typeof parteCorteDe>) => { delete parte.people[0]!.policy!.weights[2]; },
    (parte: ReturnType<typeof parteCorteDe>) => { parte.people[0]!.policy!.weights[2] = Infinity; },
    (parte: ReturnType<typeof parteCorteDe>) => {
      const mapa = Object.setPrototypeOf(new Map(), Object.prototype);
      Object.assign(parte.people[0]!, { mapa });
    },
  ];
  for (const modificar of casos) {
    const parte = parteCorteDe(mundoConPolitica());
    modificar(parte);
    assert.equal(prepararPersonasDirectas(parte), undefined);
  }
  const parte = parteCorteDe(mundoConPolitica());
  let lecturas = 0;
  Object.defineProperty(parte.people[0]!.traits, 'resilience', { get() { lecturas++; return 1; } });
  assert.equal(prepararPersonasDirectas(parte), undefined);
  assert.equal(lecturas, 0);
});

function bloqueManual(texto: string, mascara = 0, pesos = new Uint8Array()): BloquePersonasCorte {
  const bytes = new TextEncoder().encode(texto);
  const cuerpo = new Uint8Array(bytes.length + 1);
  cuerpo[0] = mascara;
  cuerpo.set(bytes, 1);
  return { filas: 1, cuerpo, pesos };
}

test('el receptor rechaza bytes, pesos, recuentos y formas incoherentes', () => {
  const valida = '{"id":"i","x":0,"y":0}', bloque = bloqueManual(valida);
  const pesos = new Uint8Array(WPF1_WEIGHT_BYTES);
  new DataView(pesos.buffer).setFloat64(0, NaN, true);
  assert.throws(() => recibirPersonasDirectas([bloqueManual('{"id":"i","x":0,"\\u0078":1,"y":0}')], 1), /claves repetidas/);
  assert.throws(() => recibirPersonasDirectas([bloqueManual('{"id":"i","x":0,"y":0,"extra":1e999}')], 1), /no finito/);
  assert.throws(() => recibirPersonasDirectas([bloqueManual('{}')], 1), /Fila/);
  assert.throws(() => recibirPersonasDirectas([bloqueManual(valida, 2)], 1), /Máscara/);
  assert.throws(() => recibirPersonasDirectas([bloqueManual(valida, 1)], 1), /Longitud/);
  assert.throws(() => recibirPersonasDirectas([bloqueManual(valida, 1, pesos)], 1), /Marcador/);
  assert.throws(() => recibirPersonasDirectas([bloqueManual('{"id":"i","x":0,"y":0,"policy":{"weights":[]}}', 1, pesos)], 1), /Peso/);
  assert.throws(() => recibirPersonasDirectas([bloqueManual(`[${valida},\t[[0,0,"id"]]]`)], 1), /Claves de ausencia/);
  assert.throws(() => recibirPersonasDirectas([bloqueManual(`[${valida},\t[[3,0,"extra"]]]`)], 1), /Objeto de ausencia/);
  assert.throws(() => recibirPersonasDirectas([bloqueManual(`${valida}\n${valida}`)], 1), /Cantidad/);
  assert.throws(() => recibirPersonasDirectas([bloque, bloque], 2), /Buffer repetido/);
  assert.throws(() => recibirPersonasDirectas([bloque], 2), /Cantidad/);
  assert.throws(() => recibirPersonasDirectas([{ ...bloque, cuerpo: bloque.cuerpo.subarray(0, -1) }], 1), /Bloque/);
  bloque.cuerpo[2] = 0xff;
  assert.throws(() => recibirPersonasDirectas([bloque], 1), /utf-8/i);
});
