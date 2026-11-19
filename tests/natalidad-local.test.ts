import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, tileAt, type Person, type World } from '../src/world/index.js';
import { closeKin, pairAffinity, pairTie } from '../src/world/family.js';
import { activate } from '../src/world/spatial.js';
import {
  ALIMENTO_MEDIO_MINIMO_NATALIDAD, effectiveCommunityCap, localForageSupport, localRecentBirths,
  RADIO_MUESTREO_FORRAJEO_DEFAULT, RADIO_VECINDAD_NATALIDAD_DEFAULT, selectLocalBirthPairs,
  type LocalBirthConfig, type LocalBirthPair,
} from '../src/world/natalidad-local.js';

const FERTIL = (person: Person): boolean => person.role === 'neighbor';

function configDe(extra: Partial<LocalBirthConfig> = {}): LocalBirthConfig {
  return {
    radioVecindad: RADIO_VECINDAD_NATALIDAD_DEFAULT,
    cupoLocalPorVentana: 2,
    ventanaTicks: 120,
    alimentoMedioMinimo: ALIMENTO_MEDIO_MINIMO_NATALIDAD,
    radioPareja: 3,
    radioLugar: 4,
    exigeComunidad: false,
    maximaPoblacion: 1_000_000,
    ...extra,
  };
}

function mundo(): { world: World; plantilla: Person } {
  const world = createWorld(1);
  const plantilla = structuredClone(world.people.find(person => person.role === 'neighbor')!);
  world.people = [];
  world.places = [];
  world.tick = 10_000;
  world.reproductionEnabled = true;
  return { world, plantilla };
}

function activarVentana(world: World, x0: number, y0: number, x1: number, y1: number): void {
  for (let x = x0; x <= x1; x += 16) for (let y = y0; y <= y1; y += 16) activate(world, x, y);
}

/** Tierra uniforme en el cuadrado de forrajeo. El agua potable queda en el valor pedido y no entra en la media. */
function fijarSuelo(world: World, x: number, y: number, food: number, drinkingWater: number, terrain: 'soil' | 'water' = 'soil'): void {
  const radio = RADIO_MUESTREO_FORRAJEO_DEFAULT;
  for (let dy = -radio; dy <= radio; dy++) for (let dx = -radio; dx <= radio; dx++) {
    const tile = tileAt(world, { x: x + dx, y: y + dy });
    if (!tile) throw new Error(`sin tesela en ${x + dx},${y + dy}`);
    tile.terrain = terrain;
    tile.food = food;
    tile.drinkingWater = drinkingWater;
  }
}

function habitante(plantilla: Person, id: string, x: number, y: number, bornAt: number): Person {
  const person = structuredClone(plantilla);
  person.id = id;
  person.name = id;
  person.role = 'neighbor';
  person.x = x;
  person.y = y;
  person.target = { x, y };
  person.bornAt = bornAt;
  person.communityId = null;
  person.bonds = {};
  person.genome = { ...person.genome, parents: [], generation: 0 };
  return person;
}

function vincular(grupo: readonly Person[]): void {
  for (const a of grupo) for (const b of grupo) if (a !== b) a.bonds[b.id] = 0.6;
}

function elegir(world: World, config: LocalBirthConfig = configDe()): LocalBirthPair[] {
  return selectLocalBirthPairs(world, config, FERTIL, closeKin, pairAffinity, pairTie);
}

function idsDe(pares: readonly LocalBirthPair[]): string[] {
  return pares.map(par => [par.a.id, par.b.id].sort().join('+'));
}

/** 24 personas en las cuatro esquinas de un disco de radio 16. Las esquinas opuestas no se ven (≈16,97 > 16). */
function aldeaEnDisco(recientes: number): { world: World; x: number; y: number } {
  const { world, plantilla } = mundo();
  const x = 200, y = 200;
  activarVentana(world, 176, 176, 224, 224);
  const esquinas = [[-6, -6], [-6, 6], [6, -6], [6, 6]] as const;
  for (const [dx, dy] of esquinas) fijarSuelo(world, x + dx, y + dy, 0.5, 0);
  fijarSuelo(world, x, y, 0.5, 0);
  const grupo: Person[] = [];
  let nacimiento = 0;
  for (const [dx, dy] of esquinas) for (let k = 0; k < 6; k++) {
    const reciente = nacimiento < recientes;
    nacimiento++;
    grupo.push(habitante(plantilla, `disco-${dx}-${dy}-${k}`, x + dx, y + dy, reciente ? world.tick - 1 : -4800));
  }
  vincular(grupo);
  world.people.push(...grupo);
  world.places.push({ id: 'lugar-disco', name: 'Disco', x, y, description: 'Aldea de prueba.', gatherings: 0 });
  return { world, x, y };
}

function aldeaCompacta(world: World, plantilla: Person, nombre: string, x: number, y: number, personas: number, food: number, drinkingWater: number): void {
  const radio = RADIO_MUESTREO_FORRAJEO_DEFAULT;
  const x0 = Math.floor((x - radio) / 16), x1 = Math.floor((x + radio) / 16);
  const y0 = Math.floor((y - radio) / 16), y1 = Math.floor((y + radio) / 16);
  for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) activate(world, cx * 16, cy * 16);
  fijarSuelo(world, x, y, food, drinkingWater);
  const grupo: Person[] = [];
  for (let k = 0; k < personas; k++) grupo.push(habitante(plantilla, `${nombre}-${k}`, x, y, -4800));
  vincular(grupo);
  world.people.push(...grupo);
  world.places.push({ id: `lugar-${nombre}`, name: nombre, x, y, description: 'Aldea de prueba.', gatherings: 0 });
}

test('una aldea dentro del radio 16 no supera el cupo local de la ventana', () => {
  const sinRecientes = aldeaEnDisco(0);
  assert.ok(sinRecientes.world.people.length >= 16 && sinRecientes.world.people.length <= 30);
  for (const person of sinRecientes.world.people) {
    assert.ok(Math.hypot(person.x - sinRecientes.x, person.y - sinRecientes.y) <= RADIO_VECINDAD_NATALIDAD_DEFAULT);
  }
  const config = configDe({ radioLugar: 12 });
  const pares = elegir(sinRecientes.world, config);
  assert.equal(pares.length, config.cupoLocalPorVentana);
  assert.equal(new Set(pares.flatMap(par => [par.a.id, par.b.id])).size, pares.length * 2);
  for (const par of pares) assert.equal(par.place.id, 'lugar-disco');
  // Un nacimiento en la esquina opuesta no cabe en la misma ventana: el disco comparte el cupo.
  assert.equal(localRecentBirths(sinRecientes.world, { x: sinRecientes.x, y: sinRecientes.y }, 16, 120), 0);

  const uno = aldeaEnDisco(1);
  assert.equal(localRecentBirths(uno.world, { x: uno.x, y: uno.y }, 16, 120), 1);
  assert.equal(elegir(uno.world, config).length, 1);

  const dos = aldeaEnDisco(2);
  assert.equal(localRecentBirths(dos.world, { x: dos.x, y: dos.y }, 16, 120), 2);
  assert.equal(elegir(dos.world, config).length, 0);

  // La frontera de la ventana es la misma que la del cupo global: bornAt == tick - ventana no cuenta.
  const frontera = dos.world.people.find(person => person.bornAt === dos.world.tick - 1)!;
  const nacido = frontera.bornAt;
  frontera.bornAt = dos.world.tick - 120;
  assert.equal(localRecentBirths(dos.world, { x: dos.x, y: dos.y }, 16, 120), 1);
  frontera.bornAt = dos.world.tick - 119;
  assert.equal(localRecentBirths(dos.world, { x: dos.x, y: dos.y }, 16, 120), 2);
  frontera.role = 'S';
  assert.equal(localRecentBirths(dos.world, { x: dos.x, y: dos.y }, 16, 120), 1);
  frontera.role = 'neighbor';
  frontera.bornAt = nacido;

  // Alguien nacido lejos no gasta el cupo de esta aldea.
  const { plantilla } = mundo();
  dos.world.people.push(habitante(plantilla, 'forastero', dos.x + 40, dos.y, dos.world.tick - 1));
  assert.equal(localRecentBirths(dos.world, { x: dos.x, y: dos.y }, 16, 120), 2);
  assert.equal(localRecentBirths(dos.world, { x: dos.x + 40, y: dos.y }, 16, 120), 1);
});

test('diez aldeas separadas por más de 32 celdas conciben cada una su propio cupo', () => {
  const { world, plantilla } = mundo();
  const cupo = 2;
  for (let i = 0; i < 10; i++) aldeaCompacta(world, plantilla, `aldea-${i}`, 8 + i * 80, 8, 16, 0.5, 0);
  for (let i = 1; i < 10; i++) {
    const previa = world.places.find(place => place.id === `lugar-aldea-${i - 1}`)!;
    const actual = world.places.find(place => place.id === `lugar-aldea-${i}`)!;
    assert.ok(Math.hypot(actual.x - previa.x, actual.y - previa.y) > 32);
  }
  const pares = elegir(world, configDe({ cupoLocalPorVentana: cupo }));
  assert.equal(pares.length, 10 * cupo);
  assert.ok(pares.length > cupo, 'el cupo global de una sola ventana era 2; diez aldeas lo superan en el mismo paso');
  const porAldea = new Map<number, number>();
  for (const par of pares) {
    assert.equal(par.a.x, par.b.x);
    assert.ok(Math.abs(par.a.x - par.b.x) <= RADIO_VECINDAD_NATALIDAD_DEFAULT);
    porAldea.set(par.a.x, (porAldea.get(par.a.x) ?? 0) + 1);
  }
  assert.equal(porAldea.size, 10);
  for (const cuenta of porAldea.values()) assert.equal(cuenta, cupo);
  const padres = pares.flatMap(par => [par.a.id, par.b.id]);
  assert.equal(new Set(padres).size, padres.length);
});

test('la tierra agotada frena solo a esa aldea y el agua en cero no singulariza', () => {
  const { world, plantilla } = mundo();
  for (let i = 0; i < 10; i++) {
    const agotada = i === 0;
    aldeaCompacta(world, plantilla, `suelo-${i}`, 8 + i * 80, 24, 16, agotada ? 0.02 : 0.5, 0);
  }
  const agotado = localForageSupport(world, { x: 8, y: 24 });
  const fertil = localForageSupport(world, { x: 88, y: 24 });
  assert.equal(agotado.landTiles, 81);
  assert.ok(agotado.meanFood < ALIMENTO_MEDIO_MINIMO_NATALIDAD);
  assert.ok(Math.abs(agotado.meanFood - 0.02) < 1e-12);
  assert.equal(Object.is(agotado.meanFood, Infinity), false);
  assert.ok(fertil.meanFood >= ALIMENTO_MEDIO_MINIMO_NATALIDAD);
  assert.equal(fertil.landTiles, 81);
  const tileSeca = tileAt(world, { x: 88, y: 24 })!;
  assert.equal(tileSeca.drinkingWater, 0);

  const pares = elegir(world);
  assert.equal(pares.length, 9 * 2);
  assert.ok(pares.every(par => par.a.x !== 8 && par.b.x !== 8));
  const porX = new Set(pares.map(par => par.a.x));
  assert.equal(porX.size, 9);
  for (const par of pares) assert.equal(Number.isFinite(par.affinity), true);

  // Umbral exacto, con alimento binario: igual al mínimo se concibe; por debajo, no.
  const justo = mundo();
  aldeaCompacta(justo.world, justo.plantilla, 'justo', 40, 40, 8, 0.25, 0);
  assert.equal(localForageSupport(justo.world, { x: 40, y: 40 }).meanFood, 0.25);
  assert.equal(elegir(justo.world, configDe({ alimentoMedioMinimo: 0.25 })).length, 2);
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) tileAt(justo.world, { x: 40 + dx, y: 40 + dy })!.food = 0.125;
  assert.equal(elegir(justo.world, configDe({ alimentoMedioMinimo: 0.25 })).length, 0);

  // Mar de drinkingWater 0: cero teselas de tierra, media 0, sin infinito.
  fijarSuelo(justo.world, 40, 40, 0, 0, 'water');
  const mar = localForageSupport(justo.world, { x: 40, y: 40 });
  assert.deepEqual(mar, { meanFood: 0, landTiles: 0 });
  assert.equal(Number.isFinite(mar.meanFood), true);
  const centro = tileAt(justo.world, { x: 40, y: 40 })!;
  centro.terrain = 'soil';
  centro.food = 0.5;
  centro.drinkingWater = 0;
  const una = localForageSupport(justo.world, { x: 40, y: 40 });
  assert.equal(una.landTiles, 1);
  assert.equal(una.meanFood, 0.5);
});

test('la selección es determinista y maxComunidades 0 solo conserva la admisión', () => {
  assert.equal(effectiveCommunityCap(0, 1_000_000), 1_000_000);
  assert.equal(effectiveCommunityCap(64, 1_000_000), 64);
  assert.equal(effectiveCommunityCap(100, 40), 40);

  const { world, plantilla } = mundo();
  for (let i = 0; i < 10; i++) aldeaCompacta(world, plantilla, `det-${i}`, 16 + i * 80, 48, 12, 0.5, 0);
  const antes = structuredClone(world);
  const firmas: string[][] = [];
  for (let vez = 0; vez < 5; vez++) firmas.push(idsDe(elegir(world)));
  for (const firma of firmas) assert.deepEqual(firma, firmas[0]);
  assert.deepEqual(world, antes);

  const invertido = structuredClone(world);
  invertido.people.reverse();
  const firmaInvertida = idsDe(elegir(invertido)).sort();
  assert.deepEqual(firmaInvertida, [...firmas[0]!].sort());

  world.reproductionEnabled = false;
  assert.deepEqual(elegir(world), []);
  world.reproductionEnabled = true;
  const tope = world.people.length + 1;
  const uno = elegir(world, configDe({ maximaPoblacion: tope }));
  assert.equal(uno.length, 1);
  assert.equal(elegir(world, configDe({ maximaPoblacion: world.people.length })).length, 0);

  world.places = [];
  assert.equal(elegir(world).length, 0);
});
