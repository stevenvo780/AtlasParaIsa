import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, TICKS_PER_DAY, type Person } from '../src/world/index.js';
import { TAU_VINCULO } from '../src/shared/naturaleza.js';
import {
  ALCANCE_SENAL, RADIO_QUERENCIA, SED_QUE_BUSCA, anclaExploracion, candidatosCohesion, costeCamino, cuidadoresDe, madurezDe,
  soledad, tiron, umbralMemoriaAgua,
} from '../src/world/cohesion.js';

// Pruebas de las piezas puras de la cohesión sobre un mundo recién creado, sin motor y sin avanzar un tick.

const mortal = (world: ReturnType<typeof createWorld>): Person => world.people.find(p => p.role === 'neighbor')!;

test('n-cohesion: el tirón crece con la distancia y satura', () => {
  assert.equal(tiron(0, RADIO_QUERENCIA), 0);
  assert.equal(tiron(RADIO_QUERENCIA, RADIO_QUERENCIA), 1);
  assert.ok(tiron(4, RADIO_QUERENCIA) < tiron(8, RADIO_QUERENCIA));
  assert.ok(tiron(1e6, RADIO_QUERENCIA) < 2);
});

test('n-cohesion: la soledad crece con τ y la memoria del agua nunca queda por encima de la sed que busca', () => {
  assert.equal(soledad(0), 0);
  assert.equal(soledad(-5), 0);
  assert.ok(Math.abs(soledad(TAU_VINCULO * TICKS_PER_DAY) - (1 - Math.exp(-1))) < 1e-12);
  assert.ok(soledad(1e9) <= 1);
  assert.equal(umbralMemoriaAgua(1), SED_QUE_BUSCA);
  assert.equal(umbralMemoriaAgua(0.5), 0.5);
});

test('n-cohesion: lejos del hogar aparece el candidato de volver, y pesa más cuanto más lejos', () => {
  const world = createWorld(7), p = mortal(world);
  p.action = 'explore';
  p.home = { x: p.x + 1, y: p.y, quality: 0.8, observedAt: 0 };
  const alHogar = (c: { target: { x: number; y: number } }) => c.target.x === p.home!.x && c.target.y === p.home!.y;
  assert.equal(candidatosCohesion(world, p, { genteCerca: 3 }).some(alHogar), false);
  p.home = { x: p.x + 10, y: p.y, quality: 0.8, observedAt: 0 };
  const cerca = candidatosCohesion(world, p, { genteCerca: 3 }).find(alHogar)!;
  p.home = { x: p.x + 40, y: p.y, quality: 0.8, observedAt: 0 };
  const lejos = candidatosCohesion(world, p, { genteCerca: 3 }).find(alHogar)!;
  assert.equal(cerca.action, 'approach');
  assert.ok(lejos.score > cerca.score);
  // El camino se descuenta: nunca vale más que el tirón sin coste.
  assert.ok(costeCamino(world, p, 40) > costeCamino(world, p, 10));
  const ancla = anclaExploracion(world, p)!;
  assert.equal(ancla.x, p.home.x);
  assert.ok(ancla.peso > 0);
});

test('n-cohesion: quien descansa bien sin hogar lo fija; no lo mueve si ya tiene', () => {
  const world = createWorld(7), p = mortal(world);
  p.home = undefined; p.action = 'rest'; p.hunger = 0.2; p.thirst = 0.1; p.fatigue = 0.3;
  candidatosCohesion(world, p, { genteCerca: 1 });
  assert.deepEqual(p.home, { x: p.x, y: p.y, quality: 0.7, observedAt: world.tick });
  const hogar = p.home;
  p.x += 5;
  candidatosCohesion(world, p, { genteCerca: 1 });
  assert.equal(p.home, hogar);
});

test('n-cohesion: quien lleva tiempo solo busca a la persona más cercana que percibe', () => {
  const world = createWorld(7), p = mortal(world), otro = world.people.find(o => o !== p)!;
  p.home = undefined; p.action = 'explore'; p.lastSocial = world.tick - 3 * TICKS_PER_DAY;
  for (const o of world.people) if (o !== p) { o.x = p.x + 2 * ALCANCE_SENAL; o.y = p.y; }
  assert.equal(candidatosCohesion(world, p, { genteCerca: 0 }).length, 0);
  otro.x = p.x + ALCANCE_SENAL - 8;
  const [compania] = candidatosCohesion(world, p, { genteCerca: 0 });
  assert.deepEqual(compania!.target, { x: otro.x, y: otro.y });
  assert.ok(compania!.score > 0);
  // Con gente a la vista no hay soledad que atender, y el reloj se pone al día.
  assert.equal(candidatosCohesion(world, p, { genteCerca: 2 }).length, 0);
  assert.equal(candidatosCohesion(world, p, { genteCerca: 0 }).length, 0);
});

test('n-cohesion: la cría vuelve con quien la cuida y el tirón se apaga al madurar', () => {
  const world = createWorld(7), cuidador = mortal(world), cria = world.people.find(o => o !== cuidador && o.role === 'neighbor')!;
  cria.home = undefined; cria.action = 'explore';
  cria.crianza = { cuidadores: [cuidador.id], madurez: 0.1 };
  cria.x = cuidador.x + 6; cria.y = cuidador.y;
  assert.deepEqual(cuidadoresDe(cria), [cuidador.id]);
  assert.equal(madurezDe(world, cria), 0.1);
  const joven = candidatosCohesion(world, cria, { genteCerca: 1 })[0]!;
  assert.deepEqual(joven.target, { x: cuidador.x, y: cuidador.y });
  const ancla = anclaExploracion(world, cria)!;
  assert.deepEqual([ancla.x, ancla.y], [cuidador.x, cuidador.y]);
  cria.crianza.madurez = 0.9;
  const mayor = candidatosCohesion(world, cria, { genteCerca: 1 })[0]!;
  assert.ok(mayor.score < joven.score);
});
