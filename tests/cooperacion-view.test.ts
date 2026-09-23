import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, projectWorld } from '../src/world/index.js';
import type { ChronicleEvent } from '../src/shared/types.js';
import { comidaCompartida, resumenVivo } from '../src/server/resumen-vivo.js';
import { desglose, seccionDesacuerdos, seccionJuntos } from '../src/client/cooperacion-view.js';

test('M7: el desglose de la cooperación coincide con los episodios reales de un mundo sembrado', () => {
  const world = createWorld(51926), vistos = new Map<string, ChronicleEvent>();
  const gatheringsIniciales = comidaCompartida(world);
  for (let i = 0; i < 800; i++) { stepWorld(world); for (const e of world.events) vistos.set(e.id, e as ChronicleEvent); }
  const eventos = [...vistos.values()];
  const coop = eventos.filter(e => e.kind === 'cooperation');
  const cuenta = (re: RegExp) => coop.filter(e => re.test(e.text)).length;
  const d = desglose(projectWorld(world))!;
  assert.ok(d.cooperacion > 0, `hubo cooperación: ${d.cooperacion}`);
  assert.equal(d.cooperacion, coop.length, 'cada cooperación deja un episodio');
  assert.equal(d.ensenanzas, cuenta(/\. Mostró (las operaciones practicadas|una técnica practicada)/));
  assert.equal(d.trueques, cuenta(/\. (Intercambiaron|Entregó el objeto) /));
  assert.equal(d.ayudas, cuenta(/ unidades de trabajo a (la obra|la caza) /));
  assert.equal(d.aportesYTurnos, cuenta(/\. Aportó una unidad de | acordaron turnarse /), 'identidad de society.ts: el resto son aportes y turnos');
  // Comida compartida en lugares vivos = episodios de cuidado (cada uno suma un encuentro en su lugar).
  assert.equal(comidaCompartida(world) - gatheringsIniciales, eventos.filter(e => e.kind === 'care').length);
  assert.equal(resumenVivo(world).comidaCompartida, comidaCompartida(world));
});

test('M7: una resta negativa (contadores de un mundo migrado) no se dibuja', () => {
  const view = projectWorld(createWorld(51926));
  view.stats!.totals = { ...view.stats!.totals, cooperation: 3, teaching: 5, trade: 0, constructionHelp: 0 };
  assert.equal(desglose(view)!.aportesYTurnos, null);
  const html = seccionJuntos(view, []);
  assert.doesNotMatch(html, /Aportes de material y turnos/);
  assert.match(html, /Enseñanzas/);
  assert.match(html, /Comida compartida que vio este navegador<strong>0</);
});

test('M7: los desacuerdos explican la ley y dicen quién cedió en los que vio este navegador', () => {
  const view = projectWorld(createWorld(51926));
  const [a, b] = view.people.filter(p => p.role === 'neighbor');
  const html = seccionDesacuerdos(view, [{ id: 'e9', tick: 2500, kind: 'conflict', actors: [a!.id, b!.id], text: `${a!.name} y ${b!.name} disputaron una fuente escasa.`, cause: 'x', source: 'simulation' }]);
  assert.match(html, /quien no tiene comunidad nunca disputa/);
  assert.match(html, new RegExp(`Cedió <button class="entity-link" data-person-link="${a!.id}">${a!.name}</button>: cede el intento`));
  assert.match(html, /DÍA 2 · PASO 2\.500 · DESACUERDO/);
  assert.match(seccionDesacuerdos(view, []), /no ha visto desacuerdos ni turnos/);
});
