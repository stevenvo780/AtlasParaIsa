import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, TICKS_PER_DAY, type Person } from '../src/world/index.js';
import { parseParams } from '../src/world/params.js';
import { DIAS_ABORTO, ETA, M0 } from '../src/shared/naturaleza.js';
import { HAMBRE_POR_UNIDAD } from '../src/world/ecologia-constantes.js';
import {
  MASA_ADULTA_UA, T_GESTACION_MIN, balanceEscalar, candidatoCuidar, causaNoAporta, causaNoCria, claveDeId, estadoCria,
  fertil, idDeCria, porQueNoCria, provisionCrianza, type EstadoCria,
} from '../src/world/natalidad.js';
import { crearCria } from '../src/world/demografia/nacer.js';
import { familyOpportunity, availableToShare } from '../src/world/family.js';

// Pruebas de funciones puras de la ley: no avanzan el mundo ni miden nada.

const fertilDeLibro: EstadoCria = { mortal: true, edad: 6000, madurez: 4800, vejez: 20000, salud: 0.9, gestando: false,
  desdeParto: 5000, enfriamiento: 2400, reserva: 1, coste: 0.5 };

const mundoConLey = () => createWorld(7, parseParams({ v23: { natalidad: true } }));
const mortal = (world: ReturnType<typeof createWorld>): Person => world.people.find(p => p.role === 'neighbor')!;

test('n: la primera causa sigue el orden de la ley', () => {
  assert.equal(causaNoCria(fertilDeLibro), null);
  assert.equal(causaNoCria({ ...fertilDeLibro, mortal: false, salud: 0 }), 'rol');
  assert.equal(causaNoCria({ ...fertilDeLibro, edad: 100, salud: 0 }), 'inmadura');
  assert.equal(causaNoCria({ ...fertilDeLibro, edad: 20000 }), 'vejez');
  assert.equal(causaNoCria({ ...fertilDeLibro, salud: 0.5, gestando: true }), 'salud');
  assert.equal(causaNoCria({ ...fertilDeLibro, gestando: true, reserva: 0 }), 'gestando');
  assert.equal(causaNoCria({ ...fertilDeLibro, desdeParto: 100, reserva: 0 }), 'enfriamiento');
  assert.equal(causaNoCria({ ...fertilDeLibro, reserva: 0.49 }), 'reserva');
  // Quien gesta o se recupera sigue pudiendo dar su genoma.
  assert.equal(causaNoAporta({ ...fertilDeLibro, gestando: true, desdeParto: 0, reserva: 0 }), null);
});

test('n: la clave de un id es estable, entera segura y nunca 0', () => {
  const ids = ['S', 'I', 'founder-1', 'founder-2', 'descendant-1', 'descendant-2', idDeCria(1), idDeCria(2), idDeCria(123456789)];
  const claves = ids.map(claveDeId);
  assert.equal(new Set(claves).size, ids.length);
  for (const clave of claves) assert.ok(Number.isSafeInteger(clave) && clave > 0);
  assert.equal(claveDeId('founder-1'), claves[2]);
  assert.ok(claveDeId('') > 0);
});

test('n: el balance escalar paga la cría entera, a su ritmo, y lo abortado vuelve', () => {
  const world = createWorld(7), b = balanceEscalar(world), madre = mortal(world);
  const m0 = M0 * MASA_ADULTA_UA, minimo = T_GESTACION_MIN * TICKS_PER_DAY;
  madre.inventory = 0.25; madre.hunger = 0.1;
  const antes = b.reserva(madre);
  assert.equal(b.coste(madre), m0 / ETA);
  b.concebir(madre, { otro: 9, genoma: [], inicio: 0 });
  let masa = 0, ticks = 0;
  while (masa < m0 * (1 - 1e-9) && ticks < 10 * minimo) { masa = b.gestar(madre, 1, ticks); ticks++; }
  // Ni más deprisa que el periodo mínimo ni más masa que m0.
  assert.ok(ticks >= minimo - 1 && ticks <= minimo + 1, `gestó en ${ticks} ticks`);
  assert.ok(Math.abs(masa - m0) < 1e-9);
  // De lo pagado, η quedó en el embrión: la reserva bajó m0/η.
  assert.ok(Math.abs(antes - b.reserva(madre) - m0 / ETA) < 1e-9);
  assert.ok(Math.abs(madre.hunger - 0.1) < 1e-12 || madre.inventory === 0);
  // El aborto devuelve lo gestado (el calor no).
  const conEmbrion = b.reserva(madre);
  b.abortar(madre);
  assert.equal(b.enCurso(madre), undefined);
  assert.ok(Math.abs(b.reserva(madre) - conEmbrion - m0) < 1e-9);
});

test('n: sin sobrante no se gesta y se anota desde cuándo; el parto entrega lo gestado', () => {
  const world = createWorld(7), b = balanceEscalar(world), madre = mortal(world);
  madre.inventory = 0; madre.hunger = 0.9;
  b.concebir(madre, { otro: 9, genoma: [], inicio: 0 });
  assert.ok(b.reserva(madre) < b.basal(madre, TICKS_PER_DAY));
  assert.equal(b.gestar(madre, 1, 40), 0);
  assert.equal(b.gestar(madre, 1, 41), 0);
  assert.equal(b.enCurso(madre)!.bajoBasalDesde, 40);
  assert.equal(madre.hunger, 0.9);
  assert.ok(DIAS_ABORTO > 0);
  // Come: vuelve a gestar y el contador se limpia.
  madre.inventory = 0.25; madre.hunger = 0.1;
  const masa = b.gestar(madre, 1, 42);
  assert.ok(masa > 0);
  assert.equal(b.enCurso(madre)!.bajoBasalDesde, -1);
  assert.equal(b.parir(madre).inventario, masa);
  assert.equal(b.enCurso(madre), undefined);
});

test('n: el hambre paga cuando no lleva nada, sin pasar del día de basal', () => {
  const world = createWorld(7), b = balanceEscalar(world), madre = mortal(world);
  madre.inventory = 0; madre.hunger = 0;
  b.concebir(madre, { otro: 9, genoma: [], inicio: 0 });
  for (let t = 0; t < TICKS_PER_DAY; t++) b.gestar(madre, 1, t);
  assert.ok(madre.hunger > 0);
  assert.ok(b.reserva(madre) >= b.basal(madre, TICKS_PER_DAY) - 1e-9);
  assert.ok(madre.hunger <= 1 - b.basal(madre, TICKS_PER_DAY) * HAMBRE_POR_UNIDAD + 1e-9);
});

test('n: fértil si el cuerpo puede pagar; la provisión pide lo que falta', () => {
  const world = mundoConLey(), madre = mortal(world), b = balanceEscalar(world);
  const e = estadoCria(world, madre, b);
  madre.demography.age = (e.madurez + e.vejez) / 2; madre.demography.health = 1; madre.lastBirth = world.tick - e.enfriamiento;
  madre.inventory = 0; madre.hunger = 0.5;
  assert.equal(porQueNoCria(world, madre), 'reserva');
  assert.equal(fertil(world, madre), false);
  const provision = provisionCrianza(world, madre)!;
  assert.equal(provision.comer, false);
  assert.ok(provision.reserveTarget > 0 && provision.apremio > 0 && provision.apremio <= 1);
  madre.inventory = provision.reserveTarget;
  assert.equal(fertil(world, madre), true);
  assert.equal(provisionCrianza(world, madre), null);
  const inmortal = world.people.find(p => p.role !== 'neighbor')!;
  assert.equal(porQueNoCria(world, inmortal), 'rol');
});

test('n: con la ley, la pareja pactada heredada no existe', () => {
  const world = mundoConLey();
  for (const p of world.people) assert.equal(familyOpportunity(world, p), null);
});

test('n: la cría nace con lo gestado, hogar, cuidadores y sin lo aprendido por su madre', () => {
  const world = mundoConLey(), madre = mortal(world);
  madre.experiences.push({ tick: 0, text: 'x', causeId: 'e', placeId: '' });
  madre.waterMemory = { x: 3, y: 4 };
  const uid = 4242;
  const cria = crearCria(world, madre, { uid, id: idDeCria(uid), genome: { ...madre.genome, alleles: [...madre.genome.alleles], parents: [madre.id, 'otro'] },
    policy: undefined, cuidadores: [madre.id, 'otro'], apego: 1, madurez: M0, inventario: 0.1 });
  assert.equal(cria.id, 'nacido-4242');
  assert.equal(cria.uid, uid);
  assert.equal(cria.inventory, 0.1);
  assert.deepEqual(cria.crianza, { cuidadores: [madre.id, 'otro'], madurez: M0 });
  assert.deepEqual(cria.bonds, { [madre.id]: 1, otro: 1 });
  assert.equal(cria.home!.x, madre.x);
  assert.deepEqual(cria.waterMemory, { x: 3, y: 4 });
  assert.notEqual(cria.waterMemory, madre.waterMemory);
  assert.equal(cria.experiences.length, 0);
  assert.equal(cria.demography.age, 0);
  assert.equal(cria.cuerpo, undefined);
  // Su cuidador le da de lo que lleva y la busca cuando tiene más hambre que él.
  madre.inventory = 0.1; madre.hunger = 0.1; cria.hunger = 0.6;
  assert.equal(availableToShare(world, madre, cria), true);
  const cuidar = candidatoCuidar(world, madre, [cria])!;
  assert.equal(cuidar.action, 'share');
  assert.ok(cuidar.score > 0);
  assert.equal(candidatoCuidar(world, cria, [madre]), undefined);
});
