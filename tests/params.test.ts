import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, cloneWorld, stepWorld } from '../src/world/index.js';
import { DEFAULT_PARAMS, PARAM_RANGES, PARAM_DESCRIPTORS, parseParams, paramsOf, setParams, type WorldParams } from '../src/world/params.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { splitParamList } from '../src/shared/param-syntax.js';

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

test('T102: defaults deterministas y opciones reservadas sin activar nuevas etapas', () => {
  assert.deepEqual(DEFAULT_PARAMS.motor, { clonPorPaso: true, hilos: 1, soaTerreno: false, particionarPersonas: false, gpu: [], orden: 'natural' });
  assert.deepEqual(DEFAULT_PARAMS.limites, { teselasActivas: 65536, chunks: 256, comunidades: 8, fauna: 393216, aplicacion: 'parametros' });
  assert.equal(DEFAULT_PARAMS.persistencia.paginasSucias, false);
  assert.equal(DEFAULT_PARAMS.red.deltas, false);
  assert.deepEqual(DEFAULT_PARAMS.gobernador.senales, ['p95']);
  assert.deepEqual(PARAM_RANGES['motor.hilos'], [1, 512]);
  assert.equal(PARAM_DESCRIPTORS['motor.clonPorPaso']!.kind, 'boolean');
  for (const range of Object.values(PARAM_RANGES)) assert.ok(range.every(Number.isFinite));

  const normal = createWorld(4821), reserved = createWorld(4821, parseParams('motor.hilos=8,motor.gpu=[1,0],motor.clonPorPaso=false,motor.soaTerreno=true,motor.particionarPersonas=true,motor.orden=adversarial,persistencia.paginasSucias=true,red.deltas=true,limites.comunidades=12'));
  for (let tick = 0; tick < 200; tick++) { stepWorld(normal); stepWorld(reserved); }
  assert.deepEqual(reserved, normal, 'T102 sólo declara opciones; no cambia la física ni levanta topes');
  assert.notEqual(digestoCanonico(reserved), digestoCanonico(normal), 'el digesto completo sigue incluyendo la configuración');
});

test('T102: cadena, JSON plano/anidado y diccionario dan parámetros tipados equivalentes', () => {
  const expected = parseParams('motor.hilos=8,motor.gpu=[1,0],motor.clonPorPaso=false,motor.orden="inverso",gobernador.senales=["p95"]');
  for (const input of [
    '{"motor":{"hilos":8,"gpu":[1,0],"clonPorPaso":false,"orden":"inverso"},"gobernador":{"senales":["p95"]}}',
    '{"motor.hilos":8,"motor.gpu":[1,0],"motor.clonPorPaso":false,"motor.orden":"inverso","gobernador.senales":["p95"]}',
    { 'motor.hilos': '8', 'motor.gpu': '[1,0]', 'motor.clonPorPaso': 'false', 'motor.orden': 'inverso', 'gobernador.senales': '["p95"]' },
    { motor: { hilos: 8, gpu: [1, 0], clonPorPaso: false, orden: 'inverso' }, gobernador: { senales: ['p95'] } },
  ]) assert.deepEqual(parseParams(input), expected);
  assert.deepEqual(parseParams('motor.gpu=[]').motor.gpu, []);
  assert.equal(parseParams('motor.hilos=512').motor.hilos, 512);
  assert.deepEqual(parseParams(`motor.gpu=[${Number.MAX_SAFE_INTEGER}]`).motor.gpu, [Number.MAX_SAFE_INTEGER], 'no depende del inventario GPU del host');
});

test('T102: arrays propios, congelados, ordenados como la entrada y conservados en el clon', () => {
  const gpu = [1, 0], senales = ['p95'];
  const original = parseParams({ motor: { gpu }, gobernador: { senales } });
  gpu.reverse(); senales.push('invalida');
  assert.deepEqual(original.motor.gpu, [1, 0]); assert.deepEqual(original.gobernador.senales, ['p95']);
  for (const array of [DEFAULT_PARAMS.motor.gpu, DEFAULT_PARAMS.gobernador.senales, original.motor.gpu, original.gobernador.senales]) {
    assert.ok(Object.isFrozen(array)); assert.throws(() => (array as unknown[]).push(9), TypeError);
  }
  const override = parseParams('motor.hilos=8,motor.hilos=16', original);
  assert.equal(override.motor.hilos, 16); assert.equal(original.motor.hilos, 1);
  assert.deepEqual(override.motor.gpu, [1, 0]); assert.notEqual(override.motor.gpu, original.motor.gpu);
  assert.equal(parseParams(undefined, original), original);
  assert.equal(paramsOf(cloneWorld(createWorld(4821, original))), original);
});

test('T102: rechaza tipos, rangos, arrays, señales y claves inválidos sin coerción accidental', () => {
  for (const input of [
    'motor.hilos=0', 'motor.hilos=513', 'motor.hilos=1.5', 'motor.hilos=Infinity',
    'motor.clonPorPaso=0', 'motor.clonPorPaso=False', 'motor.clonPorPaso=',
    'motor.orden=aleatorio', 'motor.gpu=0', 'motor.gpu=[0,0]', 'motor.gpu=[-1]',
    'motor.gpu=[0.5]', 'motor.gpu=[9007199254740992]', 'motor.gpu=["0"]', 'motor.gpu=[true]',
    'motor.gpu=[null]', 'motor.gpu=[[0]]', 'motor.gpu=[0,]', 'motor.gpu=[0,1',
    'motor.gpu=[0,1}', 'motor.gpu=[0],motor.orden="natural',
    'gobernador.senales=[]', 'gobernador.senales=["p95","p95"]', 'gobernador.senales=[0]',
    'limites.fauna=0', 'limites.chunks=0.5', 'limites.comunidades=Infinity',
    '{"motor":{"desconocido":{}}}', '{"desconocido":{}}', '{"":{}}', '{"constructor":{}}',
    '{"__proto__":{"motor":{"hilos":8}}}', 'motor.__proto__=1', '[]', 'null',
    { 'poblacion.maxima': [32] }, { 'motor.hilos': true }, { 'motor.gpu': [NaN] },
    { 'motor.gpu': [Infinity] }, { 'motor.gpu': Array(1) }, { 'motor.gpu': null },
  ]) assert.throws(() => parseParams(input), Error, JSON.stringify(input));
  assert.throws(() => parseParams('gobernador.senales=["rss"]'), /T161/);
  assert.equal(Object.hasOwn(Object.prototype, 'motor'), false);
  assert.equal(parseParams('poblacion.maxima=3.2e1,persistencia.cadaTicks=20').poblacion.maxima, 32);
});

test('el lexer conserva comas y escapes dentro de valores JSON', () => {
  assert.deepEqual(splitParamList('motor.gpu=[],[0],[0,1]'), ['motor.gpu=[]', '[0]', '[0,1]']);
  assert.deepEqual(splitParamList('a=["x,y","quote\\\"comma,",{"z":[1,2]}],b=2'), ['a=["x,y","quote\\\"comma,",{"z":[1,2]}]', 'b=2']);
  for (const input of ['a=[1,2', 'a=[1,2}', 'a="x\\"', 'a=]']) assert.throws(() => splitParamList(input), /Formato/);
});

test('T102: valida los índices del array, sin ejecutar iteradores ni conversores de entrada', () => {
  const senales = ['p95'], gpu = [1, 0], invalid = [NaN];
  senales[Symbol.iterator] = () => [][Symbol.iterator]();
  gpu[Symbol.iterator] = () => [0, 1][Symbol.iterator]();
  invalid[Symbol.iterator] = () => [0][Symbol.iterator]();
  const result = parseParams({ motor: { gpu }, gobernador: { senales } });
  assert.deepEqual(result.motor.gpu, [1, 0]); assert.deepEqual(result.gobernador.senales, ['p95']);
  assert.throws(() => parseParams({ 'motor.gpu': invalid }), /no numérico/);
  assert.throws(() => parseParams('{"motor":{"hilos":{"toString":0}}}'), /Valor no numérico/);
});
