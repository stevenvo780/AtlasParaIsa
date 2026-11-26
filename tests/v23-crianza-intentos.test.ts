import assert from 'node:assert/strict';
import { test } from 'node:test';
import { balanceConservacion, paramsDeEncender } from '../scripts/lab/encender.mjs';
import { share } from '../src/world/actuar/interacciones.js';
import { beberConCuerpo } from '../src/world/actuar/recursos.js';
import { createWorld, stepWorld } from '../src/world/index.js';
import { waterAvailable } from '../src/world/inventions.js';
import { aguaParaTejido, entorno, fundarCuerpo, masaLote, morir } from '../src/world/materia/cuerpo.js';
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

test('una cría hidratada bebe de la celda hasta cubrir el agua que puede convertir en tejido', () => {
  const mundo = createWorld(7, paramsDeEncender({ regimen: 'abierto', hasta: 'intentos' }));
  stepWorld(mundo);
  const c = ctxMateriaDe(mundo), cria = mundo.people.find(p => p.role === 'neighbor');
  assert.ok(cria?.cuerpo);
  const tesela = mundo.tiles.find(t => waterAvailable(mundo, t) > 1);
  assert.ok(tesela);
  morir(c, cria.cuerpo, c.terreno.celda(cria.x, cria.y));
  const cuerpo = cria.cuerpo = fundarCuerpo(c, cria.cuerpo.plantilla, 3, 1, 1);
  cria.x = tesela.x;
  cria.y = tesela.y;
  cria.action = 'drink';
  cria.target = { x: tesela.x, y: tesela.y };
  cria.thirst = 0;
  const d = conductorDe(mundo)!;
  d.publicarFilas();
  d.organismos.tabla.publicar(mundo.tick);
  assert.equal(aguaParaTejido(c, cuerpo), 0);

  const { CH2, proteina, orgP } = entorno.sustancias(c);
  c.materia.fuente(cuerpo.digestivo, Float64Array.of(CH2, 6000, proteina, 3500, orgP, 500), c.libro);
  const falta = aguaParaTejido(c, cuerpo), antes = waterAvailable(mundo, tesela);
  assert.ok(falta > 0);
  assert.ok(beberConCuerpo(mundo, cria, cuerpo, tesela) > 0);
  assert.ok(aguaParaTejido(c, cuerpo) < falta);
  while (aguaParaTejido(c, cuerpo) > 0) assert.ok(beberConCuerpo(mundo, cria, cuerpo, tesela) > 0);
  assert.equal(beberConCuerpo(mundo, cria, cuerpo, tesela), 0);
  assert.ok(Math.abs(antes - waterAvailable(mundo, tesela) - falta) < 0.001);
  assert.equal(balanceConservacion(mundo)?.ok, true);
});
