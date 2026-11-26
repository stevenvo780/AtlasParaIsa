import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { clientDelta, codificarBloque, codificarBloquePorPartes, cotaIndiceBloque, decodificarBloque, leerIndiceBloque, leerMarcoJson, sectoresVisibles, verificarBloque } from '../src/server/cinta/formato.js';
import { projectTapeFrame } from '../src/server/sim-worker.js';
import { applyClientTapeDelta, indexTiles } from '../src/shared/tape-delta.js';
import type { PersonView, RuntimeStats, Tile, WorldView } from '../src/shared/types.js';
import { createWorld } from '../src/world/index.js';
import { parseParams } from '../src/world/params.js';

const runtime: RuntimeStats = {
  stepMs: 0, p95StepMs: 0, saveMs: 0, projectionMs: 0, snapshotBytes: 0, activeTiles: 16, processRssMiB: 0, tickHz: 0,
  fraccionSerial: 0,
  fases: {
    maintainRegions: 0, ecologia: 0, kernel: 0, fauna: 0, personas: 0, encuentros: 0, demografia: 0,
    comunidades: 0, reproduccion: 0, checkpoint: 0, muestreo: 0, save: 0, broadcast: 0,
  },
};
const alCable = (v: WorldView): WorldView => JSON.parse(JSON.stringify(v));
const tesela = (x: number): Tile => ({ x, y: 0, terrain: 'meadow', moisture: 0.4, vegetation: 0.7, food: 0.3 });

test('I1: un bloque CNT2 reconstruye los cortes cuantizados con el aplicador compartido', () => {
  const mundo = createWorld(74033, parseParams('motor.hilos=1'));
  const base = projectTapeFrame(mundo, runtime, 'cinta-prueba', [tesela(0), tesela(1), tesela(2), tesela(3)]);
  const siguiente: WorldView = {
    ...base, tick: 4, sequence: 9,
    tiles: [base.tiles[0]!, { ...base.tiles[2]!, paved: 1 }, base.tiles[3]!, tesela(4)],
    people: [...base.people].reverse().map(p => ({ ...p, x: p.x + 0.01, health: undefined })),
    performance: undefined, animals: [],
    technology: { ...base.technology!, knowledge: undefined },
    stats: { ...base.stats!, census: undefined },
    events: [...base.events, { id: 'prueba', tick: 4, kind: 'pause', actors: [], text: 'Pausa', cause: 'prueba', source: 'simulation' }],
  };
  const ultimo: WorldView = {
    ...siguiente, tick: 8, sequence: 10,
    tiles: [siguiente.tiles[0]!, siguiente.tiles[2]!, siguiente.tiles[1]!, siguiente.tiles[3]!],
    events: siguiente.events.slice(-1).map(e => ({ ...e, text: 'Modificado' })),
    technology: undefined, stats: undefined, animals: undefined,
  };
  const deltas = [clientDelta(base, siguiente), clientDelta(siguiente, ultimo)];
  assert.deepEqual(deltas[0]!.removedTiles, ['1,0']);
  assert.deepEqual(deltas[0]!.tilesPatch?.map(t => t.x), [2, 4]);
  assert.deepEqual(deltas[1]!.removedTiles, ['2,0', '4,0']);
  const bytes = codificarBloque(0, base, deltas);
  const datos = decodificarBloque(bytes);
  assert.deepEqual(verificarBloque(bytes), { nivel: 0, t0: 0, t1: 8, fotogramas: 3, crc: datos.crc });
  const indice = indexTiles(datos.baseFrame.tiles);
  let frame = datos.baseFrame;
  assert.deepEqual(frame, alCable(base));
  for (const [i, delta] of datos.deltas.entries()) {
    frame = applyClientTapeDelta(frame, delta, indice).frame;
    assert.deepEqual(frame, alCable([siguiente, ultimo][i]!));
  }
});

test('I6: CNT2 detecta cabeceras y datos alterados, truncamientos y ticks repetidos', () => {
  const base: WorldView = {
    version: 10, tick: 2 ** 33, sequence: 9, day: 1, phase: 'day', weather: 'clear',
    width: 1, height: 1, tiles: [], people: [], places: [], events: [], memories: [],
  };
  const delta = clientDelta(base, { ...base, tick: base.tick + 4, sequence: 10 });
  const bytes = codificarBloque(4, base, [delta]);
  assert.deepEqual(decodificarBloque(codificarBloque(1, base, [])).baseFrame, base);
  assert.equal(verificarBloque(bytes).t1, base.tick + 4);
  assert.throws(() => codificarBloque(0, base, [clientDelta(base, base)]), /orden/);
  for (const offset of [4, 25, 37, bytes.length - 1]) {
    const corrupto = Buffer.from(bytes);
    corrupto[offset] = corrupto[offset]! ^ 1;
    // El nivel cambia de 4 a 5. Usa otro nivel válido para distinguir corrupción de validación semántica.
    if (offset === 4) corrupto[offset] = 3;
    assert.throws(() => verificarBloque(corrupto), /CRC32/);
  }
  for (const largo of [0, 10, bytes.length - 1]) {
    assert.throws(() => verificarBloque(bytes.subarray(0, largo)), /CNT2/);
  }
});

test('CNT2 acota la salida de Zstd aun con CRC válidos e índice incoherente', () => {
  const base: WorldView = {
    version: 10, tick: 0, sequence: 0, day: 1, phase: 'day', weather: 'clear',
    width: 1, height: 1, tiles: [], people: [], places: [], events: [], memories: [],
    pauseReason: 'Prueba de compresión '.repeat(100_000),
  };
  const datos = codificarBloque(0, base, []);
  const indice = leerIndiceBloque((o, n) => datos.subarray(o, o + n), datos.length);
  const parte = indice.marcos[0]!.partes[0]!;
  assert.ok(parte.bytes < 4096 && parte.crudos > 1_000_000);
  // Índice con CRC correcto y tamaño declarado menor que el del contenido.
  datos.writeUInt32LE(4096, 33 + 4 + 16 + 8);
  datos.writeUInt32LE(crc32(datos.subarray(29, indice.bytesIndice), crc32(datos.subarray(0, 25))), 25);
  assert.equal(verificarBloque(datos).fotogramas, 1);
  assert.throws(() => decodificarBloque(datos), { code: 'ERR_BUFFER_TOO_LARGE' });
});

const vacia = (tick: number): WorldView => ({
  version: 10, tick, sequence: tick, day: 1, phase: 'day', weather: 'clear',
  width: 1, height: 1, tiles: [], people: [], places: [], events: [], memories: [],
});
const lector = (datos: Buffer) => (o: number, n: number) => datos.subarray(o, o + n);
const persona = (id: string, x: number, y: number): PersonView => ({ id, name: id, role: 'neighbor', x, y, color: '#fff',
  action: 'rest', reason: 'r', energy: 1, hunger: 0, fatigue: 0, need: 'n', recentMemory: null });

test('CNT2: cada bit del bloque está cubierto por una suma de comprobación, también en el salto que solo lee partes', () => {
  const base: WorldView = { ...vacia(0), pauseReason: 'comprimible '.repeat(600),
    tiles: [tesela(0), { ...tesela(0), x: 40, y: 3 }, { ...tesela(0), x: -300, y: 9 }], people: [persona('p', 1, 1)] };
  const medio = { ...base, tick: 4, tiles: [{ ...base.tiles[0]!, food: 0.9 }, ...base.tiles.slice(1)] };
  const fin = { ...medio, tick: 8, people: [{ ...medio.people[0]!, x: 41 }] };
  const deltas = [clientDelta(base, medio), clientDelta(medio, fin)];
  const datos = codificarBloque(0, base, deltas);
  const indice = leerIndiceBloque(lector(datos), datos.length);
  const partes = indice.marcos.flatMap((m, i) => m.partes.map(p => ({ ...p, marco: i })));
  assert.ok(partes.some(p => p.bytes < p.crudos) && partes.some(p => p.bytes === p.crudos), 'hay partes comprimidas y crudas');
  const emitidas: Buffer[] = [];
  const { indice: cabecera, bytes } = codificarBloquePorPartes(0, base, deltas, parte => { emitidas.push(parte); });
  assert.equal(bytes, datos.length);
  assert.deepEqual(cabecera, datos.subarray(0, indice.bytesIndice));
  assert.deepEqual(emitidas, partes.map(p => datos.subarray(p.offset, p.offset + p.bytes)));
  for (let byte = 0; byte < datos.length; byte++) for (let bit = 0; bit < 8; bit++) {
    const corrupto = Buffer.from(datos);
    corrupto[byte] = corrupto[byte]! ^ (1 << bit);
    assert.throws(() => verificarBloque(corrupto), /CNT2 inválido/, `byte ${byte}, bit ${bit}`);
    // Con el índice ya en la caché del lector, la parte alterada se rechaza al leerla.
    const parte = partes.find(p => byte >= p.offset && byte < p.offset + p.bytes);
    if (parte) assert.throws(() => leerMarcoJson(indice, parte.marco, lector(corrupto)), /CRC32/, `parte, byte ${byte}`);
  }
});

test('CNT2 guarda en la parte global lo que no tiene una posición finita, sin dejar el bloque ilegible', () => {
  const gente = (x: number, y: number, id: string) => persona(id, x, y);
  const base: WorldView = { ...vacia(0), tiles: [tesela(0)],
    people: [gente(Number.NaN, 0, 'nan'), gente(3, 4, 'normal'), gente(Infinity, 2 ** 60, 'lejos')],
    structures: [{ id: 's', x: 1, y: 1, cells: [{ x: Number.NaN, y: 1 }, { x: 2, y: 1 }] } as unknown as NonNullable<WorldView['structures']>[number]] };
  const siguiente = { ...base, tick: 4, people: [gente(5, Number.NaN, 'normal'), gente(Number.NaN, 1, 'nan'), gente(7, 7, 'lejos')] };
  const datos = codificarBloque(0, base, [clientDelta(base, siguiente)]);
  assert.equal(verificarBloque(datos).fotogramas, 2);
  const { baseFrame, deltas } = decodificarBloque(datos);
  assert.deepEqual(baseFrame, alCable(base));
  assert.deepEqual(applyClientTapeDelta(baseFrame, deltas[0]!).frame, alCable(siguiente));
  const indice = leerIndiceBloque(lector(datos), datos.length);
  const camara = sectoresVisibles(indice, { x: 0, y: 0, width: 8, height: 8 });
  assert.ok(JSON.parse(leerMarcoJson(indice, 1, lector(datos), camara)).peoplePatch.upserts.length > 0);
});

test('CNT2 acota lo que descomprime cada lectura, no la suma del bloque: un mundo grande sigue grabando', () => {
  const MiB = 1024 ** 2, relleno = 'x'.repeat(24 * MiB);
  const marcos = Array.from({ length: 24 }, (_, i) => ({ ...vacia(i * 4), pauseReason: relleno + i }));
  const datos = codificarBloque(0, marcos[0]!, marcos.slice(1).map((m, i) => clientDelta(marcos[i]!, m)));
  const indice = leerIndiceBloque(lector(datos), datos.length);
  const crudos = indice.marcos.reduce((s, m) => s + m.partes.reduce((a, p) => a + p.crudos, 0), 0);
  assert.ok(crudos > 512 * MiB, `${crudos} bytes descomprimidos en el bloque`);
  assert.equal(verificarBloque(datos).fotogramas, 24);
  assert.equal(JSON.parse(leerMarcoJson(indice, 23, lector(datos))).pauseReason, relleno + 23);

  // Dos partes que declaran 300 MiB cada una: la lectura se niega antes de descomprimir nada.
  const chico = codificarBloque(0, { ...vacia(0), tiles: [tesela(0)] }, []);
  const descriptor = leerIndiceBloque(lector(chico), chico.length);
  assert.equal(descriptor.marcos[0]!.partes.length, 2);
  const entradas = 33 + 4 + 33 * descriptor.sectores.length + 16;
  for (let j = 0; j < 2; j++) chico.writeUInt32LE(300 * MiB, entradas + 16 * j + 8);
  chico.writeUInt32LE(crc32(chico.subarray(29, descriptor.bytesIndice), crc32(chico.subarray(0, 25))), 25);
  const inflado = leerIndiceBloque(lector(chico), chico.length);
  assert.throws(() => leerMarcoJson(inflado, 0, lector(chico)), /Tamaño descomprimido/);
});

test('la cota del índice sella antes de añadir un fotograma disperso que la rebasaría', () => {
  const tiles = Array.from({ length: 40_000 }, (_, i) => ({
    x: i * 64, y: 0, terrain: 'soil' as const, moisture: 0, food: 0, vegetation: 0,
  }));
  const cabecera = { sequence: 0, tick: 0, day: 1, phase: 'dawn', weather: 'clear' } as const;
  const base: WorldView = { ...cabecera, version: 10, width: 1, height: 1, tiles,
    people: [], places: [], events: [], memories: [] };
  const cabe = cotaIndiceBloque(base);
  let admitidos = 0;
  for (let i = 1; i < 32; i++) {
    if (!cabe({ ...cabecera, tick: i, tilesPatch: tiles })) break;
    admitidos++;
  }
  assert.ok(admitidos > 1 && admitidos < 31);
  const disperso = cotaIndiceBloque(base);
  for (let i = 1; i < 32; i++) assert.ok(disperso({ ...cabecera, tick: i }));
});
