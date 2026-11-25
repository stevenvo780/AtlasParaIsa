import test from 'node:test';
import assert from 'node:assert/strict';
import { actualizarLado, armarComunidades, codificarRegistros, componentes, decodificarRegistros, ladoDeRecienNacido, RETENCION_TICK,
  type RegistroPersona } from '../src/world/comunidades.js';
import { aplicarEfectoSocial, datoAEfecto, efectoADato } from '../src/world/society.js';
import { createWorld, TICKS_PER_DAY } from '../src/world/index.js';
import { TAU_VINCULO, VINCULO_MINIMO } from '../src/shared/naturaleza.js';
import type { CommunityView } from '../src/shared/types.js';

/** Registros de `n` personas (uid 1..n, id `p1`..`pn`) con los vínculos mutuos fuertes de `aristas`. */
function red(n: number, aristas: readonly (readonly [number, number])[], mortal = (_uid: number) => true): RegistroPersona[] {
  const fuertes = Array.from({ length: n + 1 }, () => [] as number[]);
  for (const [a, b] of aristas) { fuertes[a]!.push(b); fuertes[b]!.push(a); }
  return Array.from({ length: n }, (_, k) => ({ uid: k + 1, id: `p${k + 1}`, nombre: `P${k + 1}`, mortal: mortal(k + 1), x: 2 * k, y: 0,
    cultura: [0.5, 0.5, 0.5] as const, fuertes: fuertes[k + 1]! }));
}
/** Tira de triángulos 1-2-3, 2-3-4, …: cada vínculo está cerrado por un tercero. */
const tira = (desde: number, hasta: number) => {
  const aristas: [number, number][] = [];
  for (let i = desde; i < hasta; i++) { aristas.push([i, i + 1]); if (i + 2 <= hasta) aristas.push([i, i + 2]); }
  return aristas;
};
const contador = () => { let n = 0; return () => ++n; };
const tamanos = (cs: readonly CommunityView[]) => cs.map(c => c.members.length).sort((a, b) => a - b);

test('una tira de tríadas es una comunidad; una cadena suelta de vínculos no lo es', () => {
  assert.deepEqual(componentes(red(6, tira(1, 6))).map(c => c.miembros.length), [6]);
  const cadena = [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6]] as const;
  assert.equal(componentes(red(6, cadena)).length, 0, 'sin tercero común no hay comunidad');
});

test('hace falta reciprocidad y hacen falta tres mortales', () => {
  const registros = red(3, [[1, 2], [2, 3], [1, 3]]);
  assert.equal(componentes(registros).length, 1);
  const unilateral = registros.map(r => r.uid === 3 ? { ...r, fuertes: [] } : r);
  assert.equal(componentes(unilateral).length, 0);
  assert.equal(componentes(red(3, [[1, 2], [2, 3], [1, 3]], uid => uid !== 3)).length, 0);
});

test('un grafo que se corta se parte: la mayor conserva identidad e historia, la otra nace separada con causa y actores', () => {
  const nuevo = contador();
  const antes = armarComunidades(red(10, tira(1, 10)), [], 0, nuevo);
  assert.equal(antes.comunidades.length, 1);
  const original = antes.comunidades[0]!;
  original.cooperation = 7;
  const corte = [...tira(1, 7), ...tira(8, 10)];
  const despues = armarComunidades(red(10, corte), antes.comunidades, 1, nuevo);
  assert.deepEqual(tamanos(despues.comunidades), [3, 7]);
  const grande = despues.comunidades.find(c => c.members.length === 7)!, pequena = despues.comunidades.find(c => c.members.length === 3)!;
  assert.equal(grande, original);
  assert.equal(grande.cooperation, 7);
  assert.equal(pequena.formedAt, 1);
  const suceso = despues.sucesos.at(-1)!;
  assert.match(suceso.text, /se separó de/);
  assert.match(suceso.cause, /Se cortó la red de vínculos entre/);
  assert.ok(suceso.actors.length >= 2);
  assert.equal(despues.asignacion.get('p9'), pequena.id);
});

test('dos comunidades que se cierran entre sí se funden y suman sus contadores', () => {
  const nuevo = contador();
  const a = armarComunidades(red(8, [...tira(1, 4), ...tira(5, 8)]), [], 0, nuevo);
  assert.equal(a.comunidades.length, 2);
  a.comunidades.forEach(c => { c.cooperation = 2; c.disputes = 1; });
  const b = armarComunidades(red(8, [...tira(1, 4), ...tira(5, 8), [4, 5], [3, 5]]), a.comunidades, 1, nuevo);
  assert.equal(b.comunidades.length, 1);
  assert.equal(b.comunidades[0]!.cooperation, 4);
  assert.equal(b.comunidades[0]!.disputes, 2);
  const fusion = b.sucesos.find(s => /se fundió/.test(s.text))!;
  assert.ok(fusion.actors.length >= 2);
});

test('una comunidad que pierde sus vínculos se disuelve con al menos dos actores', () => {
  const a = armarComunidades(red(4, tira(1, 4)), [], 0, contador());
  const b = armarComunidades(red(4, []), a.comunidades, 1, contador());
  assert.equal(b.comunidades.length, 0);
  const disuelta = b.sucesos.find(s => /se disolvió/.test(s.text))!;
  assert.ok(disuelta.actors.length >= 2);
  assert.equal(b.asignacion.size, 0);
});

test('sin cambios en la red la comunidad es la misma y no hay sucesos', () => {
  const a = armarComunidades(red(5, tira(1, 5)), [], 0, contador());
  const miembros = a.comunidades[0]!.members;
  const b = armarComunidades(red(5, tira(1, 5)), a.comunidades, 1, contador());
  assert.equal(b.comunidades[0], a.comunidades[0]);
  assert.equal(b.comunidades[0]!.members, miembros, 'la lista no se rehace si no cambió');
  assert.equal(b.sucesos.length, 0);
});

test('el orden en que llegan los registros no cambia las comunidades', () => {
  const registros = red(9, [...tira(1, 4), ...tira(5, 9)]);
  const ida = armarComunidades(registros, [], 0, contador()), vuelta = armarComunidades([...registros].reverse(), [], 0, contador());
  assert.deepEqual(ida.comunidades.map(c => [...c.members].sort()).sort(), vuelta.comunidades.map(c => [...c.members].sort()).sort());
});

test('registros: ida y vuelta por bytes', () => {
  const registros = red(5, tira(1, 5));
  assert.deepEqual(decodificarRegistros(codificarRegistros(registros)), registros.map(r => ({ ...r, cultura: [...r.cultura], fuertes: [...r.fuertes] })));
  assert.deepEqual(decodificarRegistros(codificarRegistros([])), []);
});

test('un lado decae como e^(−t/τ) y se borra por debajo del mínimo solo sin contacto', () => {
  const bonds: Record<string, number> = { b: 1 };
  for (let t = 0; t < TICKS_PER_DAY; t++) actualizarLado(bonds, new Set());
  assert.ok(Math.abs(bonds.b! - Math.exp(-1 / TAU_VINCULO)) < 1e-9);
  const cerca = new Set(['c']);
  actualizarLado(bonds, cerca);
  assert.ok(Math.abs(bonds.c! - (1 - RETENCION_TICK)) < 1e-15, 'un tick cerca suma 1 − e^(−1/(τ·2400))');
  actualizarLado(bonds, new Set());
  assert.equal(bonds.c, undefined, 'sin contacto, por debajo del mínimo se borra');
  bonds.d = VINCULO_MINIMO / 2;
  actualizarLado(bonds, new Set(['d']));
  assert.ok(bonds.d! > 0, 'con contacto no se borra');
  const siempre: Record<string, number> = {};
  for (let t = 0; t < 20 * TICKS_PER_DAY; t++) actualizarLado(siempre, cerca);
  assert.ok(siempre.c! > 0.99 && siempre.c! <= 1, 'convivir siempre tiende a 1');
});

test('un recién nacido arranca con el lado de quien lo gestó', () => {
  const lado = ladoDeRecienNacido({ id: 'm', bonds: { a: 0.6, b: VINCULO_MINIMO / 2, h: 0.4 } }, 'm', 'h');
  assert.deepEqual(lado, { a: 0.6, m: 1 });
  assert.deepEqual(ladoDeRecienNacido(undefined, 'm', 'h'), { m: 1 });
});

test('Vincular: viaja por dato y bytes y sube solo el lado del receptor', () => {
  const world = createWorld(51926), [a, b] = world.people as [typeof world.people[0], typeof world.people[0]];
  a.bonds = {}; b.bonds = { [a.id]: 0.5, x: 0.7 };
  const { dato, bytes } = efectoADato({ vinculo: 0.1, disputa: true, fuente: { x: 3, y: 4 }, memoria: true, experiencia: { texto: 'algo', causa: 'e1' } });
  const efecto = datoAEfecto(dato, bytes);
  aplicarEfectoSocial(world, b, a.id, efecto, 77);
  assert.ok(Math.abs(b.bonds[a.id]! - 0.6) < 1e-12);
  assert.equal(b.lastDispute, 77);
  assert.deepEqual(b.conflictMemory, { x: 3, y: 4, tick: 77 });
  assert.equal(b.recentMemory, 'algo');
  assert.deepEqual(a.bonds, {}, 'el emisor no cambia');
  aplicarEfectoSocial(world, b, 'nuevo', datoAEfecto(...Object.values(efectoADato({ copia: 'x' })) as [Float64Array, Uint8Array]), 78);
  assert.equal(b.bonds.nuevo, 0.7, 'copia: su tiempo con el embrión fue su tiempo con quien lo gestaba');
  aplicarEfectoSocial(world, b, 'cria', { copia: b.id }, 79);
  assert.equal(b.bonds.cria, 1);
});
