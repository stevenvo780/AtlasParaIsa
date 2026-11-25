// La escucha en un mundo entero: genoma de ocho genes, carga de un mundo viejo, proyección al cliente y oír un mensaje de verdad.
// Estas pruebas crean mundos, así que necesitan los cambios de la V23 fuera del carril E (docs de integración): `demography.ts`
// espera 16 alelos y `proyeccion.ts` lleva `escucha` al cliente.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorld, createWorld, projectWorld, stepWorld, submitWhisper, TICKS_PER_DAY, type World } from '../src/world/index.js';
import { ALLELE_COUNT, ESCUCHA_LOCUS, escuchaDe } from '../src/world/genetics.js';
import { DEFAULT_PARAMS, paramsOf } from '../src/world/params.js';

const fijarEscucha = (person: { genome: { alleles: number[] } }, valor: number) => { person.genome.alleles[ESCUCHA_LOCUS * 2] = valor; person.genome.alleles[ESCUCHA_LOCUS * 2 + 1] = valor; };
const vecino = (world: World) => world.people.find(p => p.role === 'neighbor')!;
function tierraCerca(world: World, person: { x: number; y: number }) {
  const t = world.tiles.find(tile => tile.terrain !== 'water' && tile.terrain !== 'shelter' && Math.hypot(tile.x - person.x, tile.y - person.y) >= 5 && Math.hypot(tile.x - person.x, tile.y - person.y) <= 8);
  assert.ok(t, 'un destino de tierra cerca');
  return { x: t.x, y: t.y };
}

test('todo el mundo nace con ocho genes y los fundadores tienen escuchas distintas en [0, 1]', () => {
  for (const seed of [7, 51926]) {
    const world = createWorld(seed, DEFAULT_PARAMS);
    assert.ok(world.people.every(p => p.genome.alleles.length === ALLELE_COUNT));
    const escuchas = world.people.map(p => escuchaDe(p.genome));
    assert.ok(escuchas.every(e => e >= 0 && e <= 1));
    assert.ok(new Set(escuchas.map(e => e.toFixed(4))).size > escuchas.length / 2, 'cada fundador tiene la suya');
    const media = escuchas.reduce((a, b) => a + b, 0) / escuchas.length;
    assert.ok(Math.sqrt(escuchas.reduce((a, e) => a + (e - media) ** 2, 0) / escuchas.length) > 0.1, `hay escuchas distintas: ${escuchas.map(e => e.toFixed(2)).join(' ')}`);
    assert.doesNotThrow(() => assertWorld(world));
  }
});

test('un mundo guardado con genomas de siete genes no se carga: error claro, nada de leer basura', () => {
  const world = createWorld(7, DEFAULT_PARAMS);
  const viejo = structuredClone(world);
  for (const p of viejo.people) p.genome.alleles = p.genome.alleles.slice(0, ALLELE_COUNT - 2);
  assert.throws(() => assertWorld(viejo), /Genoma de 7 genes \(mundo anterior a la V23\).*mundo nuevo/);
  const raro = structuredClone(world);
  raro.people[0]!.genome.alleles.push(0.5);
  assert.throws(() => assertWorld(raro), /inválido/);
});

test('la escucha llega al cliente en la proyección de cada persona y es la del genoma', () => {
  const world = createWorld(7, DEFAULT_PARAMS);
  const vista = projectWorld(world);
  assert.equal(vista.people.length, world.people.length);
  for (const p of vista.people) {
    const viva = world.people.find(q => q.id === p.id)!;
    assert.equal(p.escucha, escuchaDe(viva.genome));
    assert.ok(p.escucha! >= 0 && p.escucha! <= 1);
  }
  assert.equal(Object.hasOwn(vista.people[0]!.genome!, 'alleles'), false, 'los alelos siguen sin salir del mundo');
});

test('un mensaje a quien escucha del todo se oye pronto y a quien no escucha no se oye; el suceso lo cuenta', { timeout: 600_000 }, () => {
  const a = createWorld(7, DEFAULT_PARAMS), b = createWorld(7, DEFAULT_PARAMS);
  assert.equal(paramsOf(a).motor.hilos, 1);
  for (let i = 0; i < 30; i++) { stepWorld(a); stepWorld(b); }
  const atenta = vecino(a), sorda = vecino(b);
  fijarEscucha(atenta, 1); fijarEscucha(sorda, 0);
  const rng = a.rng;
  const oido = submitWhisper(a, { personId: atenta.id, intent: 'travel', ...tierraCerca(a, atenta), note: '' });
  assert.equal(a.rng, rng, 'dejar un mensaje no consume el generador del mundo');
  const callado = submitWhisper(b, { personId: sorda.id, intent: 'travel', ...tierraCerca(b, sorda), note: '' });
  let heard: number | undefined, suceso: World['events'][number] | undefined;
  for (let i = 0; i < 600; i++) {
    stepWorld(a); stepWorld(b);
    if (heard === undefined && oido.status === 'heard') {
      heard = a.tick - oido.createdTick;
      suceso = a.events.find(e => e.text.includes('oyó un susurro') && e.actors.includes(atenta.id));
    }
  }
  assert.ok(heard !== undefined && heard > 0 && heard < 600, `la persona atenta lo oyó tras ${heard} pasos, no en el mismo`);
  assert.equal(callado.status, 'latent', 'con escucha 0 no oye nada en 600 pasos');
  assert.ok(suceso, 'la crónica cuenta que lo oyó');
  assert.match(suceso.cause, /escucha heredada \(1\.00\)/);
  assert.ok(!b.events.some(e => e.text.includes('oyó un susurro')));
});

test('con un hilo y semilla el oído es reproducible: dos mundos iguales oyen el mismo mensaje en el mismo paso', { timeout: 600_000 }, () => {
  const heardAt = (): number | undefined => {
    const world = createWorld(51926, DEFAULT_PARAMS);
    for (let i = 0; i < 20; i++) stepWorld(world);
    const persona = vecino(world);
    fijarEscucha(persona, 0.8);
    const m = submitWhisper(world, { personId: persona.id, intent: 'explore', ...tierraCerca(world, persona), note: '' });
    for (let i = 0; i < TICKS_PER_DAY / 4 && m.status === 'latent'; i++) stepWorld(world);
    return m.heardTick;
  };
  const primero = heardAt(), segundo = heardAt();
  assert.ok(primero !== undefined, 'lo oyó dentro de un cuarto de día');
  assert.equal(primero, segundo);
});
