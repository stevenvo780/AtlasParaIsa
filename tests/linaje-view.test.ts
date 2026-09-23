import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, projectWorld } from '../src/world/index.js';
import { edadFicha, generacionMaxima, genealogiaFicha, sinComunidad, vidasQueTerminaron } from '../src/client/linaje-view.js';

test('M8: «Vidas que terminaron» lista los difuntos recientes con causa, días y progenitores, y las causas en barras visibles', () => {
  const view = projectWorld(createWorld(51926));
  const padre = view.people.find(p => p.role === 'neighbor')!;
  view.demography = { deaths: 2, causes: { dehydration: 1, senescence: 1 }, recent: [
    { id: 'descendant-3', name: 'Olmo 3', generation: 1, parents: [padre.id], bornAt: 2400, diedAt: 7200, cause: 'dehydration' },
    { id: 'neighbor-9', name: 'Duna', generation: 0, parents: [], bornAt: -4800, diedAt: 9000, cause: 'senescence' },
  ] };
  const html = vidasQueTerminaron(view);
  assert.match(html, /<details class="person-detail" data-detail="human-death-causes" open>/, 'las causas no quedan plegadas');
  assert.match(html, /Falta prolongada de agua\./);
  assert.match(html, /data-person-link="descendant-3">Olmo 3/);
  assert.match(html, new RegExp(`G1 · falta prolongada de agua · día 2 → día 4 \\(vivió 2 días\\) · de ${padre.name}`));
  assert.match(html, /población inicial/);
  delete view.demography;
  assert.match(vidasQueTerminaron(view), /no envió el registro de muertes/);
});

test('M8: generación más alta, vidas sin comunidad y edad en días, del estado real', () => {
  const view = projectWorld(createWorld(51926));
  view.stats!.generations = { '0': 10, '3': 2, '4': 0 };
  assert.equal(generacionMaxima(view), 3);
  const total = view.stats!.census!.neighbors + view.stats!.census!.identities;
  view.communities = [{ id: 'c', name: 'C', x: 0, y: 0, color: '#888888', members: [], memberCount: 5, culture: { sharing: 0, stewardship: 0, openness: 0 }, formedAt: 0, cooperation: 0, disputes: 0 }];
  assert.equal(sinComunidad(view), total - 5);
  const p = view.people[2]!;
  assert.match(edadFicha(p, { edades: { edad: 6240, madurez: 4560, vejez: 29760, maxima: 40000 } }), /Edad: 2,6 días del mundo · madura a los 1,9 días · vejez desde los 12,4 días/);
  assert.match(edadFicha({ ...p, age: 2400 }, undefined), /Edad: 1 día del mundo/);
  const g = genealogiaFicha(p, view, { familia: { progenitores: [{ id: 'a', nombre: 'Lino', vivo: true, generacion: 0 }, { id: 'b', nombre: 'Vera', vivo: false, generacion: 0 }], hijos: [{ id: 'c', nombre: 'Olmo 7', vivo: true, generacion: 2 }], totalHijos: 3, hijosVivos: 2 } });
  assert.match(g.progenitores, /Lino · G0 · fuera de esta vista/);
  assert.match(g.progenitores, /Vera · G0 · murió/);
  assert.match(g.descendencia, /3 conocidos · 2 viven/, 'los difuntos se archivan: es lo que el mundo aún registra, no un total');
  assert.doesNotMatch(g.descendencia, /en total/);
  assert.match(g.descendencia, /y 2 más/);
});
