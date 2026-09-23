import test from 'node:test';
import assert from 'node:assert/strict';
import { digestosControl, LEYES_CANDIDATAS } from '../scripts/lab/rendimiento.js';
import { createWorld, stepWorld, type Person, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, PARAM_RANGES, paramsOf, parseParams } from '../src/world/params.js';
import { CLAVES_POSTERIORES, recargar } from './lib/claves-posteriores.js';

/**
 * Búsqueda del agua en rebaño, `agua.rebano` (hipótesis H1 del diagnóstico de semillas). En las semillas
 * que arrancan en desierto sin agua a la vista (303, 17) todos empiezan con la misma sed y hacia el medio
 * día casi todos pasan de 0,6 a la vez; cada cual explora siguiendo su propio rumbo, que en los fundadores
 * es n·ángulo áureo, así que el grupo estalla en abanico y cada pareja posible acaba junto a una fuente
 * distinta. La ley: quien busca agua sin verla y ve a otros que también la buscan toma la media circular
 * de sus rumbos. Default 0 = hoy.
 */

/** Digestos de `digestosControl` (Store temporal, guardado antes del primer paso y cada 300) medidos en el
 * árbol anterior a esta ley (3a0e6bb, exportado con `git archive`), con `LEYES_CANDIDATAS` y sin las claves
 * que ese árbol ya declaraba de `CLAVES_POSTERIORES` (`social.memoriaDisputa`). */
const BASE: Record<number, Record<'1200' | '2400', string>> = {
  303: { 1200: '653792820e18998ddfcb3dfc433a83116267b08b1edcbebfe813e06cda574fcd',
    2400: 'ff74b71d6ae80b7ccfa0c6eecc7b192c8db800941039d37bfdfaed0968926143' },
  17: { 1200: '2b77ea048b9f5f707d2cd180ebe5edc3de5fa4297bc171ffb73ab856448ef4c2',
    2400: 'e62d32aa23c8e5b1049fc4ee54d7275b488d6c67aadcfd0304d2c24cce613365' },
};

test('(i) con agua.rebano=0 el mundo es bit a bit el de antes en dos semillas de desierto seco', { timeout: 1_800_000 }, () => {
  assert.equal(DEFAULT_PARAMS.agua.rebano, 0);
  assert.equal(HISTORICAL_PARAMS.agua.rebano, 0);
  assert.ok(CLAVES_POSTERIORES.includes('agua.rebano'));
  for (const seed of [303, 17]) {
    assert.deepEqual(digestosControl(seed, LEYES_CANDIDATAS, [1200, 2400], CLAVES_POSTERIORES), BASE[seed], `semilla ${seed}`);
  }
  // El control tiene dientes: en esos 2400 pasos hay buscadores de agua que se ven, y la ley los mueve.
  const conLey = digestosControl(303, `${LEYES_CANDIDATAS},agua.rebano=1`, [2400], CLAVES_POSTERIORES);
  assert.notEqual(conLey['2400'], BASE[303]!['2400'], 'con agua.rebano=1 la semilla 303 toma otro camino');
});

/** Media circular de rumbos sumada en orden de id, como la ley. */
function mediaCircular(personas: readonly Pick<Person, 'id' | 'heading'>[]): number {
  let sin = 0, cos = 0;
  for (const p of [...personas].sort((a, b) => a.id < b.id ? -1 : 1)) { sin += Math.sin(p.heading); cos += Math.cos(p.heading); }
  return Math.atan2(sin, cos);
}
/** Diferencia angular en (−π, π]. */
const giro = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/**
 * Escena: la semilla 303 arranca en desierto, sin agua en ningún sitio que se vea. Quedan tres vecinos a
 * tres celdas entre sí: `a` y `b` con sed 0,95 (buscan agua y, con sed > 0,9, vuelven a elegir cada paso) y
 * rumbos 0 y π/2; `c` sin sed, con rumbo π. Nadie lleva agua ni hay estructuras. Cielo despejado hasta el
 * paso 600, cuando el tiempo vuelve a sortearse.
 */
function escena(params: string): { world: World; a: Person; b: Person; c: Person } {
  const world = createWorld(303, parseParams(params)); world.weather = 'clear'; world.structures = [];
  for (const tile of world.tiles) tile.drinkingWater = 0;
  world.people = world.people.filter(p => p.role === 'neighbor').slice(0, 3);
  const [a, b, c] = world.people as [Person, Person, Person];
  const origen = { x: a.x, y: a.y };
  for (const [p, dx, sed, rumbo] of [[a, 0, 0.95, 0], [b, 3, 0.95, Math.PI / 2], [c, -3, 0.2, Math.PI]] as const) {
    Object.assign(p, { x: origen.x + dx, y: origen.y, target: { x: origen.x + dx, y: origen.y }, action: 'rest', decisionAt: 0,
      thirst: sed, hunger: 0.1, fatigue: 0.1, energy: 0.9, heading: rumbo, command: null });
  }
  return { world, a, b, c };
}

const PASOS = 48;
const separacion = (p: Person, q: Person) => Math.hypot(p.x - q.x, p.y - q.y);

test('(ii) dos buscadores de agua que se ven acaban con el mismo rumbo y viajan juntos; quien no busca agua no cuenta', () => {
  const hoy = escena('agua.rebano=0');
  for (let paso = 0; paso < PASOS; paso++) stepWorld(hoy.world);
  assert.ok(Math.abs(Math.abs(giro(hoy.a.heading, hoy.b.heading)) - Math.PI / 2) < 1e-12, 'sin la ley cada cual conserva su rumbo');
  assert.ok(separacion(hoy.a, hoy.b) > 6, `sin la ley se separan: ${separacion(hoy.a, hoy.b)}`);

  const { world, a, b, c } = escena('agua.rebano=1');
  const [ha, hb] = [a.heading, b.heading];
  stepWorld(world);
  // `a` elige primero: la media de su rumbo y el de `b`; `c`, sin sed, no entra en la cuenta.
  const mediaA = mediaCircular([{ id: a.id, heading: ha }, { id: b.id, heading: hb }]);
  assert.equal(a.heading, mediaA);
  const mediaB = mediaCircular([{ id: a.id, heading: mediaA }, { id: b.id, heading: hb }]);
  assert.equal(b.heading, mediaB, '`b` elige después y promedia con el rumbo nuevo de `a`');
  assert.equal(c.heading, Math.PI, 'quien no busca agua conserva su rumbo');
  for (let paso = 1; paso < PASOS; paso++) stepWorld(world);
  assert.equal(world.people.length, 3, 'la escena no llega a la muerte por sed');
  assert.ok(Math.abs(giro(a.heading, b.heading)) < 1e-9, `rumbos alineados: ${a.heading} y ${b.heading}`);
  assert.ok(a.action === 'explore' && b.action === 'explore' && separacion(a, b) <= 3.5, `viajan juntos: ${separacion(a, b)}`);
});

test('(iii) un valor intermedio mezcla circularmente el rumbo propio con la media', () => {
  const { world, a } = escena('agua.rebano=0.5');
  stepWorld(world);
  // Rumbos 0 y π/2: la media es π/4 y la mezcla a partes iguales con el propio (0) apunta a π/8.
  assert.ok(Math.abs(a.heading - Math.PI / 8) < 1e-12, `rumbo ${a.heading}`);
});

test('(iv) PARAM_RANGES acota agua.rebano a [0, 1]', () => {
  assert.deepEqual(PARAM_RANGES['agua.rebano'], [0, 1]);
  assert.equal(parseParams('agua.rebano=0.25').agua.rebano, 0.25);
  assert.throws(() => parseParams('agua.rebano=1.01'), /fuera de rango/);
  assert.throws(() => parseParams('agua.rebano=-0.1'), /fuera de rango/);
});

test('(v) una instantánea sin agua.rebano carga con 0 y sigue la misma trayectoria', { timeout: 600_000 }, t => {
  const avanzado = (params: string) => {
    const world = createWorld(303, parseParams(params));
    for (let paso = 0; paso < 240; paso++) stepWorld(world);
    return world;
  };
  const cargado = recargar(t, avanzado(LEYES_CANDIDATAS), 'agua.rebano'), referencia = recargar(t, avanzado(LEYES_CANDIDATAS));
  assert.equal(paramsOf(cargado).agua.rebano, 0, 'la clave ausente se completa con el valor histórico');
  assert.deepEqual(paramsOf(cargado), paramsOf(referencia));
  assert.equal(digestoCanonico(cargado), digestoCanonico(referencia));
  for (let paso = 0; paso < 1200; paso++) { stepWorld(cargado); stepWorld(referencia); }
  assert.equal(digestoCanonico(cargado), digestoCanonico(referencia));
  // Una instantánea que la declara la conserva.
  assert.equal(paramsOf(recargar(t, createWorld(303, parseParams('agua.rebano=0.5')))).agua.rebano, 0.5);
});
