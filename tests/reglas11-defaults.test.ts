import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, RULES_10_ADOPTED, RULES_11_ADOPTED, paramsOf, parseParams } from '../src/world/params.js';

const PAQUETE_B = 'social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3,social.memoriaDisputa=8';

test('reglas 11 adopta sólo las cuatro claves sociales de B sobre los defaults de reglas 10', () => {
  assert.deepEqual(RULES_11_ADOPTED, {
    social: { disputaNecesidad: 0.45, disputaEscasez: 3, disputaRadio: 3, memoriaDisputa: 8 },
  });
  assert.ok(Object.isFrozen(RULES_11_ADOPTED) && Object.isFrozen(RULES_11_ADOPTED.social));
  const reglas10 = structuredClone(HISTORICAL_PARAMS);
  Object.assign(reglas10.poblacion, RULES_10_ADOPTED.poblacion);
  Object.assign(reglas10.conducta, RULES_10_ADOPTED.conducta);
  for (const [seccion, claves] of Object.entries(reglas10)) {
    const actual = DEFAULT_PARAMS[seccion as keyof typeof DEFAULT_PARAMS] as unknown as Record<string, unknown>;
    for (const [clave, valor] of Object.entries(claves)) {
      assert.deepEqual(actual[clave], seccion === 'social' && clave in RULES_11_ADOPTED.social
        ? RULES_11_ADOPTED.social[clave as keyof typeof RULES_11_ADOPTED.social] : valor, `${seccion}.${clave}`);
    }
    assert.deepEqual(Object.keys(actual), Object.keys(claves), `${seccion}: mismas claves y orden`);
  }
  assert.equal(DEFAULT_PARAMS.agua.memoria, 1);
  assert.deepEqual(HISTORICAL_PARAMS.social, { ...reglas10.social });
  assert.deepEqual({ disputaNecesidad: HISTORICAL_PARAMS.social.disputaNecesidad,
    disputaEscasez: HISTORICAL_PARAMS.social.disputaEscasez,
    disputaRadio: HISTORICAL_PARAMS.social.disputaRadio,
    memoriaDisputa: HISTORICAL_PARAMS.social.memoriaDisputa },
  { disputaNecesidad: 0.65, disputaEscasez: 1, disputaRadio: 2, memoriaDisputa: 0 });
});

for (const seed of [404, 51926]) test(`semilla ${seed}: defaults B y overrides explícitos dan el mismo digesto a 1200 pasos`, { timeout: 600000 }, () => {
  const defecto = createWorld(seed);
  const explicito = createWorld(seed, parseParams(PAQUETE_B));
  assert.deepEqual(paramsOf(defecto), paramsOf(explicito));
  for (let n = 0; n < 1200; n++) { stepWorld(defecto); stepWorld(explicito); }
  assert.equal(digestoCanonico(defecto), digestoCanonico(explicito));
  if (seed === 404) assert.ok((defecto.totals.conflicts ?? 0) > 0 || defecto.people.some(p => p.conflictMemory),
    'la semilla 404 ejerce una disputa o su memoria dentro de 1200 pasos');
});
