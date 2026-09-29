import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneWorld, createWorld, stepWorld, type Person, type World } from '../src/world/index.js';
import type { PlaceView } from '../src/shared/types.js';
import { depositoRecargable } from '../src/world/agua.js';
import { demographicTraits } from '../src/world/demography.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { familyOpportunity, reproductiveReadiness } from '../src/world/family.js';
import { DEFAULT_PARAMS, HISTORICAL_PARAMS, PARAM_RANGES, parseParams, paramsOf, setParams, type WorldParams } from '../src/world/params.js';
import { REPRO_LOCAL_RADIO, inicioRotado, llenadoLugar, multiplicadorLugar, vaciarCacheReproLocal } from '../src/world/repro-local.js';
import { tileAt } from '../src/world/spatial.js';

/**
 * REPRO-LOCAL v2 (D2', `poblacion.reproLocal`): freno local de la natalidad por llenado
 * de los depositos de agua a la vista, sin casamentero global. Regla corregida de
 * `critica-d2-20260928.md`. Cada escena usa semilla propia y vacia la cache (es por
 * ventana y modulo, y los tests comparten proceso).
 */
const PHI = 0.5, VENTANA = 120;
const distancia = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
function mundoLey(seed: number, extra = ''): World {
  vaciarCacheReproLocal();
  return createWorld(seed, parseParams(`poblacion.reproLocal=${PHI}${extra}`));
}
/** Teselas activas del disco de radio 12 del lugar. */
function teselasDisco(world: World, place: Pick<PlaceView, 'x' | 'y'>) {
  const teselas = [];
  for (let dy = -REPRO_LOCAL_RADIO; dy <= REPRO_LOCAL_RADIO; dy++) for (let dx = -REPRO_LOCAL_RADIO; dx <= REPRO_LOCAL_RADIO; dx++) {
    if (dx * dx + dy * dy > REPRO_LOCAL_RADIO * REPRO_LOCAL_RADIO) continue;
    const tile = tileAt(world, { x: place.x + dx, y: place.y + dy });
    if (tile) teselas.push(tile);
  }
  return teselas;
}
/** Disco sin informacion: ningun deposito, ninguna cisterna, sed 0 (s_L = 0). */
function discoVacio(world: World, place: Pick<PlaceView, 'x' | 'y'>): void {
  for (const tile of teselasDisco(world, place)) {
    tile.feature = 'none';
    if (tile.terrain === 'water') tile.terrain = 'soil';
    if (tile.biome === 'ocean' || tile.biome === 'wetland') tile.biome = 'grassland';
    tile.drinkingWater = 0;
  }
  world.structures = world.structures.filter(st => distancia(place, st) > REPRO_LOCAL_RADIO);
  for (const person of world.people) person.thirst = 0;
}

test('D2 parametros: default e historico 0 (apagada), rango [0,1]', () => {
  assert.equal(DEFAULT_PARAMS.poblacion.reproLocal, 0);
  assert.equal(HISTORICAL_PARAMS.poblacion.reproLocal, 0);
  assert.deepEqual(PARAM_RANGES['poblacion.reproLocal'], [0, 1]);
  assert.equal(parseParams('poblacion.reproLocal=0.5').poblacion.reproLocal, 0.5);
  assert.equal(parseParams('poblacion.reproLocal=1').poblacion.reproLocal, 1);
  assert.throws(() => parseParams('poblacion.reproLocal=-0.1'));
  assert.throws(() => parseParams('poblacion.reproLocal=1.1'));
});

test('D2 neutra sin informacion: C=0 => m=1, y solo frena el cuerpo', () => {
  const world = mundoLey(9231), place = world.places[0]!;
  discoVacio(world, place);
  const vacio = llenadoLugar(world, place);
  assert.equal(vacio.c, 0);
  assert.equal(vacio.phi, null);
  assert.equal(multiplicadorLugar(world, place, PHI, VENTANA), 1);
  // Anticipacion corporal: un sediento en el disco, resto sin sed.
  const cuerpo = paramsOf(world).cuerpo;
  const esAdulto = (p: Person): boolean => p.role === 'neighbor' && p.demography.age >= demographicTraits(p.genome, cuerpo).maturityAge;
  const dentro = world.people.filter(p => esAdulto(p) && distancia(place, p) <= REPRO_LOCAL_RADIO);
  assert.ok(dentro.length >= 1, 'hay al menos un adulto en el disco');
  dentro[0]!.thirst = 0.9;
  vaciarCacheReproLocal();
  const lleno = llenadoLugar(world, place);
  assert.equal(lleno.c, 0);
  assert.equal(lleno.sedientos, 1);
  const sL = lleno.sedientos / lleno.adultos;
  assert.equal(multiplicadorLugar(world, place, PHI, VENTANA), 1 + 4 * sL);
});

test('D2 freno monotono con el llenado (valores exactos) y tope 8', () => {
  const world = mundoLey(9232, ',agua.cuencas=1'), place = world.places[0]!; // cuencas=1: toda charca es deposito
  discoVacio(world, place);
  assert.equal(llenadoLugar(world, place).c, 0);
  // 5 depositos propios (charca en cuenca: con cuencas=1 toda tesela es cuenca).
  const candidatas = teselasDisco(world, place).slice(0, 5);
  assert.equal(candidatas.length, 5);
  for (const tile of candidatas) { tile.feature = 'pool'; tile.biome = 'grassland'; if (tile.terrain === 'water') tile.terrain = 'soil'; }
  const probar = (nivel: number, sEsperada: number, mEsperado: number): void => {
    for (const tile of candidatas) tile.drinkingWater = nivel;
    vaciarCacheReproLocal();
    const llenado = llenadoLugar(world, place);
    assert.equal(llenado.c, 5);
    assert.equal(llenado.s, sEsperada);
    assert.equal(multiplicadorLugar(world, place, PHI, VENTANA), mEsperado);
  };
  probar(0, 0, 8);       // seco: tope finito, sin infinito de NAT-L
  probar(0.5, 2.5, 2);   // phi = phiref: 1 + 1
  probar(1, 5, 1.25);    // lleno: 1 + (0,5)^2
  // Termino corporal multiplica despues del tope: phi=1, s=1/2 => 1,25 x 3.
  for (const person of world.people) if (person.role === 'neighbor') { person.x = place.x + 25; person.y = place.y + 25; }
  const cuerpo3 = paramsOf(world).cuerpo;
  const pareja = world.people.filter(p => p.role === 'neighbor' && p.demography.age >= demographicTraits(p.genome, cuerpo3).maturityAge).slice(0, 2);
  assert.equal(pareja.length, 2);
  for (const person of pareja) { person.x = place.x; person.y = place.y; person.thirst = 0; }
  pareja[0]!.thirst = 0.9;
  vaciarCacheReproLocal();
  const combinado = llenadoLugar(world, place);
  assert.deepEqual([combinado.adultos, combinado.sedientos], [2, 1]);
  assert.equal(multiplicadorLugar(world, place, PHI, VENTANA), 3.75);
});

test('D2 sin ranking mundial: con la ley activa crian 3 parejas en un paso', { timeout: 300000 }, () => {
  const escena = (ley: boolean): { nacidos: number; movidos: number } => {
    const world = ley ? mundoLey(9202) : createWorld(9202);
    if (!ley) vaciarCacheReproLocal();
    const place = world.places[0]!;
    for (const tile of world.tiles) tile.drinkingWater = 1; // freno ~1: el ensayo es del casamentero, no del freno
    const cuerpo = paramsOf(world).cuerpo;
    const aptos = world.people.filter(p => p.role === 'neighbor'
      && p.demography.age >= demographicTraits(p.genome, cuerpo).maturityAge
      && p.demography.age < demographicTraits(p.genome, cuerpo).senescenceStart);
    assert.ok(aptos.length >= 6, `adultos fertiles por edad: ${aptos.length}`);
    const parejas = [aptos.slice(0, 2), aptos.slice(2, 4), aptos.slice(4, 6)];
    const enPareja = new Set(parejas.flat().map(p => p.id));
    parejas.forEach(([a, b], i) => {
      for (const [persona, dx] of [[a, 0], [b, 1]] as const) {
        persona!.x = place.x + dx; persona!.y = place.y + (i === 0 ? 0 : i === 1 ? 2 : -2);
        persona!.target = { x: persona!.x, y: persona!.y };
        persona!.action = 'rest'; persona!.decisionAt = world.tick + 1000;
        persona!.inventory = 0.14; persona!.thirst = 0; persona!.hunger = 0.2;
        persona!.lastBirth = world.tick - 10000;
      }
      a!.bonds[b!.id] = 0.5; b!.bonds[a!.id] = 0.5;
    });
    for (const person of world.people) {
      if (person.role === 'neighbor' && !enPareja.has(person.id)) { person.inventory = 0; person.thirst = 0; }
    }
    const antes = new Map(world.people.map(p => [p.id, [p.x, p.y] as const]));
    const nacidosAntes = world.birthCounter;
    stepWorld(world);
    let movidos = 0;
    for (const persona of parejas.flat()) {
      const [x, y] = antes.get(persona!.id)!;
      if (persona!.x !== x || persona!.y !== y) movidos++;
    }
    return { nacidos: world.birthCounter - nacidosAntes, movidos };
  };
  const conLey = escena(true);
  assert.equal(conLey.movidos, 0);
  assert.equal(conLey.nacidos, 3);
  const sinLey = escena(false);
  assert.equal(sinLey.movidos, 0);
  assert.equal(sinLey.nacidos, 2);
});

test('D2 el freno vive en la disponibilidad: familyOpportunity lo ve', () => {
  const mundo = (): World => mundoLey(9233, ',agua.cuencas=1');
  const preparar = (world: World, nivel: number): { persona: Person; cd: number } => {
    const place = world.places[0]!;
    discoVacio(world, place);
    for (const tile of teselasDisco(world, place).slice(0, 5)) { tile.feature = 'pool'; tile.drinkingWater = nivel; }
    const cuerpo = paramsOf(world).cuerpo;
    const [a, b] = world.people.filter(p => p.role === 'neighbor'
      && p.demography.age >= demographicTraits(p.genome, cuerpo).maturityAge) as [Person, Person];
    for (const persona of [a, b]) {
      persona.x = place.x; persona.y = place.y;
      persona.communityId = 'c1'; persona.inventory = 0.14;
      persona.thirst = 0; persona.hunger = 0.2; persona.energy = 0.8; persona.fatigue = 0.1;
    }
    a.bonds[b.id] = 0.5; b.bonds[a.id] = 0.5;
    const cd = demographicTraits(a.genome, cuerpo).fertilityCooldown;
    a.lastBirth = world.tick - 2 * cd;
    b.lastBirth = world.tick - 2 * demographicTraits(b.genome, cuerpo).fertilityCooldown;
    vaciarCacheReproLocal();
    return { persona: a, cd };
  };
  // Seco (m=8): lista por cuerpo pero frenada => sin oportunidad de familia.
  const seco = mundo();
  const { persona: pSeco, cd: cdSeco } = preparar(seco, 0);
  assert.equal(seco.tick - pSeco.lastBirth < 8 * cdSeco, true);
  assert.equal(reproductiveReadiness(seco, pSeco), false);
  assert.equal(familyOpportunity(seco, pSeco), null);
  // Lleno (m~1): la misma escena si la ve.
  const lleno = mundo();
  const { persona: pLleno } = preparar(lleno, 1);
  assert.equal(reproductiveReadiness(lleno, pLleno), true);
  assert.ok(familyOpportunity(lleno, pLleno), 'con agua a la vista hay oportunidad');
});

test('D2 cache por ventana: fija el valor y recalcula en la ventana siguiente', () => {
  const world = mundoLey(9234, ',agua.cuencas=1'), place = world.places[0]!;
  discoVacio(world, place);
  const candidatas = teselasDisco(world, place).slice(0, 5);
  for (const tile of candidatas) { tile.feature = 'pool'; tile.drinkingWater = 1; }
  assert.equal(multiplicadorLugar(world, place, PHI, VENTANA), 1.25);
  for (const tile of candidatas) tile.drinkingWater = 0;
  assert.equal(multiplicadorLugar(world, place, PHI, VENTANA), 1.25);
  world.tick = VENTANA;
  assert.equal(multiplicadorLugar(world, place, PHI, VENTANA), 8);
});

test('D2 rotacion determinista del recorrido', () => {
  assert.equal(inicioRotado(0, 9202, 7), 0);
  const primero = inicioRotado(17, 9202, 7);
  assert.equal(inicioRotado(17, 9202, 7), primero);
  assert.ok(primero >= 0 && primero < 17);
  assert.notEqual(inicioRotado(17, 9202, 8) === primero && inicioRotado(17, 9203, 7) === primero, true);
});

test('D2 depositos: el oceano no es deposito; la cisterna casi vacia no cuenta', () => {
  assert.equal(depositoRecargable(7, 0, 0, { terrain: 'water', biome: 'ocean', feature: 'none' }, 1), false);
  assert.equal(depositoRecargable(7, 0, 0, { terrain: 'soil', biome: 'grassland', feature: 'pool' }, 1), true);
  assert.equal(depositoRecargable(7, 0, 0, { terrain: 'water', biome: 'grassland', feature: 'none' }, 1), true);
  const world = mundoLey(9235), place = world.places[0]!;
  discoVacio(world, place);
  const baldosa = tileAt(world, place)!;
  baldosa.terrain = 'shelter';
  world.structures.push({ id: 'cist-1', x: place.x, y: place.y, blueprintId: 'b', name: 'cisterna', components: ['frame', 'cistern'], condition: 0.5, water: 0.05, food: 0, uses: 0, builtAt: 0, builderId: null });
  vaciarCacheReproLocal();
  assert.equal(llenadoLugar(world, place).c, 0);
  world.structures[world.structures.length - 1]!.water = 0.5;
  const conAgua = llenadoLugar(world, place);
  assert.equal(conAgua.c, 0.6);
  assert.equal(conAgua.s, 0.5);
});

// Medidos en el arbol pristino 005b877 (auditoria-muse/digestos-d2-pre.json), antes de declarar la ley.
const DIGESTOS_PRE_1200: Record<number, string> = {
  9201: '44502937d4814bca9552065ce074ff3607c1dfe27e692f90826523b33a6995e4',
  9202: '5b0eebf47736b8ad860c3dc22bff166268408cf2b25d26019302eb562262a603',
  9203: '3c682a12c820f29021e171eff87fb47efd7feaedc5212bceeceeea908ba0f253',
  9204: '1431874608404605258d780703724dcaed12eb50f8a7c25aab9e0c567caa0426',
  9205: '48a682ef6c6b1b120a45e93eec2e76227e44bc555100770d8873eeb5cb45291e',
  9206: 'ce4185a24fc4c23eb867dc8e7911a15ed785920879ef7959759117dbd49a640d',
};

test('D2 identidad: apagada, 6 semillas x 1200 pasos bit a bit iguales al arbol pristino', { timeout: 600000 }, () => {
  for (const seed of [9201, 9202, 9203, 9204, 9205, 9206]) {
    const world = createWorld(seed);
    for (let n = 1; n <= 1200; n++) stepWorld(world);
    const vigentes = paramsOf(world);
    const forma = structuredClone(vigentes) as unknown as Record<string, Record<string, unknown>>;
    assert.equal(forma.poblacion!.reproLocal, 0);
    delete forma.poblacion!.reproLocal;
    setParams(world, forma as unknown as WorldParams);
    try {
      assert.equal(digestoCanonico(world), DIGESTOS_PRE_1200[seed], `semilla ${seed}`);
    } finally {
      setParams(world, vigentes);
    }
  }
});

test('D2 determinismo con la ley activa: dos carriles y clonar-y-seguir coinciden', { timeout: 600000 }, () => {
  const correr = (seed: number, pasos: number): string => {
    const world = createWorld(seed, parseParams(`poblacion.reproLocal=${PHI}`));
    for (let n = 1; n <= pasos; n++) stepWorld(world);
    return digestoCanonico(world);
  };
  vaciarCacheReproLocal();
  const a = correr(9201, 600);
  vaciarCacheReproLocal();
  const b = correr(9201, 600);
  assert.equal(a, b);
  vaciarCacheReproLocal();
  const mundo = createWorld(9201, parseParams(`poblacion.reproLocal=${PHI}`));
  for (let n = 1; n <= 300; n++) stepWorld(mundo);
  const clon = cloneWorld(mundo);
  for (let n = 301; n <= 600; n++) stepWorld(clon);
  assert.equal(digestoCanonico(clon), a);
});
