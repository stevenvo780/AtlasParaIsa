import assert from 'node:assert/strict';
import { test } from 'node:test';
import { balanceConservacion, paramsDeEncender } from '../scripts/lab/encender.mjs';
import { share } from '../src/world/actuar/interacciones.js';
import { createWorld, stepWorld } from '../src/world/index.js';
import { masaLote } from '../src/world/materia/cuerpo.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { conductorDe } from '../src/world/motor/contexto.js';
import { TipoIntento } from '../src/world/motor/contratos.js';
import { candidatoCuidar } from '../src/world/natalidad.js';

test('la ración llega por Dar a la cría elegida aunque falte un lugar de reunión', () => {
  const mundo = createWorld(7, paramsDeEncender({ regimen: 'abierto', hasta: 'intentos' }));
  const [donante, cria, otro] = mundo.people.filter(p => p.role === 'neighbor');
  assert.ok(donante && cria && otro);
  stepWorld(mundo);
  const c = ctxMateriaDe(mundo), d = conductorDe(mundo)!;
  assert.ok(cria.cuerpo && otro.cuerpo);
  mundo.places = [];
  for (const p of [cria, otro]) { p.x = donante.x; p.y = donante.y; }
  donante.hunger = 0.1;
  cria.hunger = 0.2;
  otro.hunger = 1;
  cria.crianza = { cuidadores: [donante.id], madurez: 0.1 };
  donante.action = 'share';
  const cuidar = candidatoCuidar(mundo, donante, [cria, otro]);
  assert.ok(cuidar);
  assert.equal(cuidar.target, cria);
  donante.target = { x: cuidar.target.x, y: cuidar.target.y };
  const digestivoCria = cria.cuerpo.digestivo, digestivoOtro = otro.cuerpo.digestivo;
  const kgCria = masaLote(c, digestivoCria), kgOtro = masaLote(c, digestivoOtro);
  const enVuelo = c.libro.enVuelo.slice();

  d.fase(4);
  share(mundo, donante);
  const enviados = d.pendientes().filter(i => i.tipo === TipoIntento.Dar);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0]!.a, c.ref(cria.uid!));

  d.fase(5);
  d.aplicar('A');
  assert.ok(masaLote(c, digestivoCria) > kgCria);
  assert.equal(masaLote(c, digestivoOtro), kgOtro);
  assert.deepEqual(c.libro.enVuelo, enVuelo);
  assert.equal(balanceConservacion(mundo)?.ok, true);
});
