import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, cloneWorld, stepWorld } from '../src/world/index.js';
import { DEFAULT_PARAMS, PARAM_RANGES, parseParams, paramsOf, setParams, type WorldParams } from '../src/world/params.js';

test('parseParams(undefined) devuelve DEFAULT_PARAMS por identidad', () => {
  assert.strictEqual(parseParams(undefined), DEFAULT_PARAMS);
});

test('DEFAULT_PARAMS está congelado en profundidad', () => {
  assert.ok(Object.isFrozen(DEFAULT_PARAMS));
  assert.ok(Object.isFrozen(DEFAULT_PARAMS.cuerpo));
  assert.throws(() => { (DEFAULT_PARAMS.cuerpo as { longevidadBaseDias: number }).longevidadBaseDias = 99; }, TypeError);
});

test('parseParams acepta "a.b=1,c.d=2" y devuelve un clon nuevo con overrides', () => {
  const params = parseParams('cuerpo.longevidadBaseDias=14,genes.varianzaFundadores=0.15');
  assert.notStrictEqual(params, DEFAULT_PARAMS);
  assert.equal(params.cuerpo.longevidadBaseDias, 14);
  assert.equal(params.genes.varianzaFundadores, 0.15);
  // El resto de las claves conserva los defaults.
  assert.equal(params.cuerpo.longevidadPorResiliencia, DEFAULT_PARAMS.cuerpo.longevidadPorResiliencia);
  assert.equal(params.poblacion.maxima, DEFAULT_PARAMS.poblacion.maxima);
});

test('parseParams acepta JSON anidado', () => {
  const params = parseParams('{"poblacion":{"maxima":40},"recursos":{"velocidadRegeneracion":2}}');
  assert.equal(params.poblacion.maxima, 40);
  assert.equal(params.recursos.velocidadRegeneracion, 2);
  assert.equal(params.poblacion.intervaloComprobacionTicks, DEFAULT_PARAMS.poblacion.intervaloComprobacionTicks);
});

test('parseParams acepta JSON plano (claves punteadas)', () => {
  const params = parseParams('{"poblacion.maxima": 50, "persistencia.cadaTicks": 5}');
  assert.equal(params.poblacion.maxima, 50);
  assert.equal(params.persistencia.cadaTicks, 5);
});

test('parseParams acepta Record<string,string>', () => {
  const params = parseParams({ 'cuerpo.riesgoSenescenciaDiario': '0.05', 'genes.tasaMutacion': '2' });
  assert.equal(params.cuerpo.riesgoSenescenciaDiario, 0.05);
  assert.equal(params.genes.tasaMutacion, 2);
});

test('parseParams devuelve un objeto congelado en profundidad', () => {
  const params = parseParams('poblacion.maxima=40');
  assert.ok(Object.isFrozen(params));
  assert.ok(Object.isFrozen(params.poblacion));
});

test('parseParams rechaza clave desconocida', () => {
  assert.throws(() => parseParams('cuerpo.inexistente=1'), /desconocid/i);
  assert.throws(() => parseParams({ 'no.existe': '1' }), /desconocid/i);
});

test('parseParams rechaza valor fuera de rango', () => {
  const [, max] = PARAM_RANGES['cuerpo.senescenciaInicioFraccion']!;
  assert.throws(() => parseParams(`cuerpo.senescenciaInicioFraccion=${max + 1}`), /rango/i);
  assert.throws(() => parseParams('poblacion.maxima=0'), /rango/i);
});

test('parseParams rechaza valor no numérico', () => {
  assert.throws(() => parseParams('poblacion.maxima=treinta'), /num[ée]ric/i);
  assert.throws(() => parseParams({ 'poblacion.maxima': '' }), /num[ée]ric/i);
});

test('parseParams rechaza formato de cadena inválido (sin "=")', () => {
  assert.throws(() => parseParams('poblacion.maxima'), /formato/i);
});

test('paramsOf de un mundo nuevo es DEFAULT_PARAMS (identidad y valor)', () => {
  const world = createWorld(4821);
  assert.strictEqual(paramsOf(world), DEFAULT_PARAMS);
  assert.deepEqual(paramsOf(world), DEFAULT_PARAMS);
});

test('paramsOf de un objeto sin params fijados devuelve DEFAULT_PARAMS', () => {
  assert.strictEqual(paramsOf({}), DEFAULT_PARAMS);
});

test('createWorld con params explícitos los deja consultables vía paramsOf', () => {
  const custom = parseParams('poblacion.maxima=40,cuerpo.longevidadBaseDias=20');
  const world = createWorld(4821, custom);
  assert.strictEqual(paramsOf(world), custom);
  assert.equal(paramsOf(world).poblacion.maxima, 40);
});

test('cloneWorld conserva los params custom del mundo original', () => {
  const custom = parseParams('recursos.decaimientoFertilidad=0.01');
  const world = createWorld(4821, custom);
  const clone = cloneWorld(world);
  assert.strictEqual(paramsOf(clone), custom);
  assert.deepEqual(paramsOf(clone), custom);
});

test('cloneWorld de un mundo sin params custom conserva DEFAULT_PARAMS', () => {
  const world = createWorld(4821);
  const clone = cloneWorld(world);
  assert.strictEqual(paramsOf(clone), DEFAULT_PARAMS);
});

test('setParams/paramsOf: identidad por mundo, no compartida entre mundos', () => {
  const a = createWorld(1), b = createWorld(2);
  const paramsA: WorldParams = parseParams('poblacion.maxima=10');
  setParams(a, paramsA);
  assert.strictEqual(paramsOf(a), paramsA);
  assert.strictEqual(paramsOf(b), DEFAULT_PARAMS);
});

test('control: 200 stepWorld con y sin params explícitos (DEFAULT_PARAMS) da el mismo JSON', () => {
  const implicit = createWorld(4821);
  const explicit = createWorld(4821, DEFAULT_PARAMS);
  for (let n = 0; n < 200; n++) { stepWorld(implicit); stepWorld(explicit); }
  assert.equal(JSON.stringify(implicit), JSON.stringify(explicit));
});
