import assert from 'node:assert/strict';
import test from 'node:test';
import { duenoDe, type Migrante } from '../src/world/motor/contexto.js';
import { createWorld } from '../src/world/mundo/crear.js';

test('el reparto de apertura conserva mensajes, orden por colección y fronteras', t => {
  const mundo = createWorld(7), d = duenoDe(mundo);
  const terreno = d.terrenoPercibido, meta = Object.values(mundo.chunks)[0]!;
  const derecha = terreno.asegurarPagina(1, 0, 1);
  const izquierda = terreno.asegurarPagina(-1, 0, 2);
  const centro = terreno.asegurarPagina(0, 0, 0);
  mundo.chunks = {
    '1,0': { ...meta, cx: 1, cy: 0 }, '0,0': { ...meta, cx: 0, cy: 0 }, '-1,0': { ...meta, cx: -1, cy: 0 },
  };
  d.tenerChunk(derecha, '1,0');
  d.tenerChunk(centro, '0,0');
  d.tenerChunk(izquierda, '-1,0');

  const puntos = [[-16.25, 1], [16, 2], [-0.25, 3], [80, 4], [-1, 5], [31.9, 6], [15.9, 7]] as const;
  const ubicar = <T extends object>(modelo: T) => puntos.map(([x, y], index) => ({ ...modelo, x, y, id: 'r' + index }));
  const [personas, fauna, estructuras] = [ubicar(mundo.people[0]!), ubicar(mundo.animals[0]!), ubicar(mundo.structures[0]!)];
  // Las teselas siguen siendo enteras y el orden espacial de la entrada es intercalado.
  const tiles = puntos.map(([x, y]) => ({ ...mundo.tiles[0]!, x: x | 0, y }));
  mundo.tiles = tiles;
  mundo.people = personas;
  mundo.animals = fauna;
  mundo.structures = estructuras;
  const ref = d.organismos.personas.registrar(personas[0]!);

  const enviados: { destino: number; migrante: Migrante }[] = [];
  t.mock.method(d, 'enviarMigrante', (destino: number, migrante: Migrante) => { enviados.push({ destino, migrante }); });
  d.repartirChunksIniciales(Int32Array.of(derecha, centro, izquierda), Int16Array.of(1, 0, 2));

  assert.deepEqual(enviados.map(({ destino, migrante }) => [destino, migrante.tipo]), [[1, 'chunk'], [2, 'chunk']]);
  for (const [indice, posiciones] of [[0, [1, 5]], [1, [0, 4]]] as const) {
    const { migrante } = enviados[indice]!;
    assert.ok(migrante.tipo === 'chunk');
    assert.equal(migrante.inicial, true);
    assert.deepEqual(migrante.tiles, posiciones.map(i => tiles[i]));
    assert.notEqual(migrante.tiles[0], tiles[posiciones[0]]);
    assert.deepEqual(migrante.animals, posiciones.map(i => fauna[i]));
    assert.deepEqual(migrante.structures, posiciones.map(i => estructuras[i]));
    assert.deepEqual(migrante.personas.map(p => p.persona), posiciones.map(i => personas[i]));
    if (indice === 1) assert.equal(migrante.personas[0]!.ref, ref);
  }
  assert.deepEqual(mundo.tiles, [tiles[2], tiles[3], tiles[6]]);
  assert.deepEqual(mundo.people, [personas[2], personas[3], personas[6]]);
  assert.deepEqual(mundo.animals, [fauna[2], fauna[3], fauna[6]]);
  assert.deepEqual(mundo.structures, [estructuras[2], estructuras[3], estructuras[6]]);
  assert.deepEqual(Object.keys(mundo.chunks), ['0,0']);
  assert.deepEqual([...d.chunks], [centro]);
});
