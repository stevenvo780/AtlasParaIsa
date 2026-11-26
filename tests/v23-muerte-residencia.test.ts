import assert from 'node:assert/strict';
import { test } from 'node:test';
import { balanceConservacion, paramsDeEncender } from '../scripts/lab/encender.mjs';
import { dejarCadaver } from '../src/world/demografia/morir.js';
import { createWorld, stepWorld } from '../src/world/index.js';
import { matarAnimal } from '../src/world/ley-fauna.js';
import { herir, lotesDe, masaDe, masaLote } from '../src/world/materia/cuerpo.js';
import { Rol } from '../src/world/materia/tipos.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { conductorDe } from '../src/world/motor/contexto.js';
import { DATO_GOLPEAR, REF_NULA } from '../src/world/motor/contratos.js';

test('la defunción conserva el cadáver y la carga en la celda material aunque la percepción esté vacía', () => {
  const mundo = createWorld(19106, paramsDeEncender({ regimen: 'abierto', hasta: 'intentos' }));
  stepWorld(mundo);
  const c = ctxMateriaDe(mundo), persona = mundo.people.find(p => p.role === 'neighbor');
  assert.ok(persona?.cuerpo);
  const celda = c.terreno.celda(persona.x, persona.y);
  assert.ok(celda >= 0);

  const golpe = new Float64Array(5);
  golpe[DATO_GOLPEAR.trabajo] = 2e6;
  golpe[DATO_GOLPEAR.filo] = golpe[DATO_GOLPEAR.dureza] = 1;
  const carga = herir(c, persona.cuerpo, golpe);
  assert.notEqual(carga, REF_NULA);
  persona.carga = [carga];
  const masaCarga = masaLote(c, carga), masaCuerpo = masaDe(c, persona.cuerpo);
  const lotesCuerpo = lotesDe(persona.cuerpo, []);
  assert.equal(balanceConservacion(mundo)?.ok, true);

  conductorDe(mundo)!.terrenoPercibido.vaciarPagina(c.terreno.chunkDe(celda));
  assert.equal(c.terreno.celda(persona.x, persona.y), -1);
  dejarCadaver(mundo, persona);

  const lotes = new Float64Array(1);
  assert.equal(c.materia.lotes(celda, Rol.Cadaver, lotes), 1);
  assert.ok(Math.abs(masaLote(c, lotes[0]!) - masaCuerpo) < 1e-6);
  assert.equal(c.materia.lotes(celda, Rol.Objeto, lotes), 1);
  assert.equal(masaLote(c, lotes[0]!), masaCarga);
  assert.equal(persona.cuerpo, undefined);
  assert.deepEqual(persona.carga, []);
  assert.ok(!c.materia.vivo(carga) && lotesCuerpo.every(l => !c.materia.vivo(l)));
  assert.equal(balanceConservacion(mundo)?.ok, true);
});

test('la muerte de fauna deja el cadáver en la página material retirada de la percepción', () => {
  const mundo = createWorld(19106, paramsDeEncender({ regimen: 'abierto', hasta: 'obra' }));
  stepWorld(mundo);
  const c = ctxMateriaDe(mundo), animal = mundo.animals.find(a => a.cuerpo);
  assert.ok(animal?.cuerpo);
  const celda = c.terreno.celda(animal.x, animal.y), masa = masaDe(c, animal.cuerpo);
  assert.ok(celda >= 0);

  conductorDe(mundo)!.terrenoPercibido.vaciarPagina(c.terreno.chunkDe(celda));
  assert.equal(c.terreno.celda(animal.x, animal.y), -1);
  matarAnimal(c, animal, 'senescencia');

  const lotes = new Float64Array(1);
  assert.equal(c.materia.lotes(celda, Rol.Cadaver, lotes), 1);
  assert.ok(Math.abs(masaLote(c, lotes[0]!) - masa) < 1e-6);
  assert.ok(!mundo.animals.includes(animal));
  assert.equal(balanceConservacion(mundo)?.ok, true);
});
