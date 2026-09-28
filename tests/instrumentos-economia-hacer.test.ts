import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, tileAt, TICKS_PER_DAY, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, paramsOf } from '../src/world/params.js';
import { InstrumentosConducta } from '../scripts/lab/instrumentos.js';
import type { CommunityView } from '../src/shared/types.js';
import type { MaterialBatch } from '../src/shared/technology.js';

/**
 * Instrumentos T5 de la economía de hacer (H1–H4): solo lectura. Con y sin observadores el mundo
 * es bit a bit el mismo; cada clave nueva mide lo que su hipótesis pide y nada más.
 */

const OFRECIDOS_VALIDOS = new Set(['gather', 'build', 'approach:hogar', 'approach:reunion',
  'approach:cortejo', 'approach:social', 'approach:invitacion', 'approach:memoria']);

function mundoConInstrumentos(seed: number): { world: World; instrumentos: InstrumentosConducta } {
  const world = createWorld(seed, structuredClone(DEFAULT_PARAMS));
  const instrumentos = new InstrumentosConducta(world);
  return { world, instrumentos };
}

function avanzaDia(world: World, instrumentos: InstrumentosConducta): void {
  const fin = world.tick + TICKS_PER_DAY;
  while (world.tick < fin) { instrumentos.antesDelPaso(world); stepWorld(world); instrumentos.despuesDelPaso(world); }
}

test('T5: demanda y construcción cuentan decisiones y evaluaciones con motivos', () => {
  const { world, instrumentos } = mundoConInstrumentos(51926);
  avanzaDia(world, instrumentos);
  const dia = instrumentos.metricasDia(world);
  assert.ok(dia.ecoHacerDemanda.decisiones > 0, 'un día tiene decisiones');
  assert.equal(Object.values(dia.ecoHacerDemanda.elegidos).reduce((a, b) => a + b, 0), dia.ecoHacerDemanda.decisiones);
  for (const clave of Object.keys(dia.ecoHacerDemanda.ofrecidos)) assert.ok(OFRECIDOS_VALIDOS.has(clave), clave);
  const c = dia.ecoHacerConstruccion;
  assert.equal(c.evaluaciones, c.admitidas + c.rechazos.cupo + c.rechazos.materiales + c.rechazos.ganancia + c.rechazos.reparacion);
  assert.equal(c.gananciaMedia === null, c.evaluaciones - c.rechazos.cupo - c.rechazos.materiales === 0);
  instrumentos.cerrar();
});

test('T5: stock agrega por comunidad lo mismo que un recorrido independiente', () => {
  const { world, instrumentos } = mundoConInstrumentos(42);
  const vecinos = world.people.filter(p => p.role === 'neighbor');
  const centro = vecinos[0]!;
  const comunidad: CommunityView = { id: 'c-test', name: 'Prueba', x: centro.x, y: centro.y, color: 'red',
    members: [vecinos[0]!.id, vecinos[1]!.id, 'fantasma'], culture: { sharing: 0.5, stewardship: 0.5, openness: 0.5 },
    formedAt: 0, cooperation: 0, disputes: 0 };
  world.communities.push(comunidad);
  const dia = instrumentos.metricasDia(world);
  assert.equal(dia.ecoHacerStock.radio, 7);
  const fila = dia.ecoHacerStock.comunidades.find(c => c.id === 'c-test')!;
  let madera = 0, piedra = 0, activas = 0;
  for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
    if (dx * dx + dy * dy > 49) continue;
    const tile = tileAt(world, { x: Math.round(centro.x) + dx, y: Math.round(centro.y) + dy });
    if (!tile) continue;
    activas++;
    if (tile.terrain !== 'water') { madera += Math.floor(tile.wood ?? 0); piedra += Math.floor(tile.stone ?? 0); }
  }
  assert.equal(fila.miembros, 3);
  assert.equal(fila.miembrosVivos, 2);
  assert.equal(fila.madera, madera);
  assert.equal(fila.piedra, piedra);
  assert.equal(fila.cobertura, activas / 149);
  instrumentos.cerrar();
});

test('T5: herramientas miden capacidad, desgaste y reposición por adulto', () => {
  const { world, instrumentos } = mundoConInstrumentos(51926);
  const adulto = world.people.find(p => p.role === 'neighbor')!;
  adulto.bornAt = world.tick - 5 * TICKS_PER_DAY - 1;
  const pieza: MaterialBatch = { id: 'pieza-test', recipeId: null, composition: { wood: 500, stone: 300, water: 0 },
    mass: 800, properties: { hardness: 0.5, toughness: 0.5, porosity: 0.1, flexibility: 0.5, edge: 0.8, containment: 0.2,
      insulation: 0.2, leverage: 0.5, cohesion: 0.9, temperature: 0, alignment: 0.5, firing: 0 },
    generation: 1, madeAt: world.tick, parentItems: [], initialMass: 1000 };
  adulto.technology.items.push(pieza);
  const dia = instrumentos.metricasDia(world);
  assert.ok(dia.ecoHacerHerramientas.adultos > 0);
  assert.ok(dia.ecoHacerHerramientas.items >= 1);
  assert.ok(dia.ecoHacerHerramientas.desgasteMedio !== null && dia.ecoHacerHerramientas.desgasteMedio >= 0
    && dia.ecoHacerHerramientas.desgasteMedio <= 1);
  assert.ok(dia.ecoHacerHerramientas.reposicion >= 1, 'la pieza nueva cuenta como reposición');
  assert.ok(dia.ecoHacerHerramientas.capacidadMedia !== null && dia.ecoHacerHerramientas.capacidadMedia >= 0);
  instrumentos.cerrar();
});

test('T5: cupo informa nacimientos, ventana y fracción', () => {
  const { world, instrumentos } = mundoConInstrumentos(42);
  const vecino = world.people.find(p => p.role === 'neighbor')!;
  vecino.bornAt = world.tick - 10;
  const dia = instrumentos.metricasDia(world);
  const pop = paramsOf(world).poblacion;
  assert.equal(dia.ecoHacerCupo.cupo, pop.nacimientosPorComprobacion);
  assert.ok(dia.ecoHacerCupo.recientes >= 1);
  assert.equal(dia.ecoHacerCupo.fraccion, dia.ecoHacerCupo.recientes / dia.ecoHacerCupo.cupo);
  instrumentos.cerrar();
});

test('T5: con instrumentos activos el mundo es bit a bit el mismo', () => {
  const a = createWorld(51926, structuredClone(DEFAULT_PARAMS));
  const b = createWorld(51926, structuredClone(DEFAULT_PARAMS));
  const instrumentos = new InstrumentosConducta(a);
  for (let n = 0; n < 600; n++) {
    instrumentos.antesDelPaso(a); stepWorld(a); instrumentos.despuesDelPaso(a);
    stepWorld(b);
  }
  instrumentos.metricasDia(a);
  assert.equal(digestoCanonico(a), digestoCanonico(b));
  instrumentos.cerrar();
});
