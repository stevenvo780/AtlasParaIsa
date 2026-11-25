import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { clientDelta, codificarBloque, decodificarBloque, leerIndiceBloque, verificarBloque } from '../src/server/cinta/formato.js';
import { projectTapeFrame } from '../src/server/sim-worker.js';
import { applyClientTapeDelta, indexTiles } from '../src/shared/tape-delta.js';
import type { RuntimeStats, Tile, WorldView } from '../src/shared/types.js';
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
