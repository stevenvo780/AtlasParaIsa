import assert from 'node:assert/strict';
import test from 'node:test';
import { deserialize, serialize } from 'node:v8';
import { encodeSnapshotTileRows } from '../src/server/snapshot.js';
import type { Tile } from '../src/shared/types.js';
import type { ParteMundo } from '../src/world/motor/reunir.js';
import { prepararTeselasDirectas, recibirTeselasDirectas, teselasVerificadasDe, tomarTeselasVerificadas,
  type BloqueTeselasCorte } from '../src/world/motor/teselas-corte.js';

const tesela = (x = 0): Tile => ({ x, y: -1, terrain: 'meadow', moisture: 0.7, vegetation: 0.1, food: 0 });
const parte = (tiles: Tile[], campos: Record<string, unknown> = {}): ParteMundo => ({ tiles, ...campos } as ParteMundo);
const bloque = (texto: string, filas = 1): BloqueTeselasCorte => ({ filas, cuerpo: new TextEncoder().encode(texto) });

test('las filas directas conservan el orden y los bytes WPG3, incluida fauna previa a la proyección y roca latente', () => {
  const originales = Array.from({ length: 4097 }, (_, x) => tesela(x));
  Object.assign(originales[0]!, { species: 'deer', fauna: 3, rocaLatente: 16_000 });
  Object.assign(originales[4096]!, { species: undefined, paved: undefined, rocaLatente: undefined });
  const directas = prepararTeselasDirectas(parte(originales));
  assert.ok(directas);
  assert.deepEqual(directas.map(b => b.filas), [4096, 1]);
  const tileRows = encodeSnapshotTileRows(originales, 0, originales.length, true);
  const esperadas = tileRows.map(fila => JSON.stringify(fila));
  for (const [i, b] of directas.entries()) {
    assert.equal(b.cuerpo.byteLength, b.cuerpo.buffer.byteLength);
    assert.equal(b.cuerpo.byteOffset, 0);
    assert.equal(new TextDecoder().decode(b.cuerpo), esperadas.slice(i * 4096, i * 4096 + b.filas).join('\n'));
  }
  const tiles = recibirTeselasDirectas(directas, originales.length);
  assert.deepEqual(tiles, originales);
  assert.equal(Object.hasOwn(tiles[4096]!, 'species'), true);
  assert.equal(Object.hasOwn(tiles[4095]!, 'species'), false);
  assert.equal(tiles[0]!.fauna, 3);
  assert.equal(tiles[0]!.species, 'deer');
  assert.equal(tiles[0]!.rocaLatente, 16_000);
  const datos = teselasVerificadasDe(tiles);
  assert.deepEqual(datos?.tramos.map(t => t.desde), [0, 4096]);
  assert.deepEqual(datos?.tramos.flatMap(t => t.filas), esperadas);
  assert.equal(datos?.modificadas.size, 0);
  assert.equal(tomarTeselasVerificadas(tiles), datos);
  assert.equal(tomarTeselasVerificadas(tiles), undefined);
});

test('las formas opacas o con pérdida salen por V8 sin leer accesores', () => {
  const acceso = Object.defineProperty(tesela(), 'food', { get: () => assert.fail('getter ejecutado') });
  const proxy = new Proxy(tesela(), { ownKeys: () => assert.fail('proxy leído') });
  const opaca = Object.assign(Object.setPrototypeOf(new Map(), Object.prototype), tesela());
  const fija = Object.defineProperty(tesela(), 'species', { value: 'hare', enumerable: false });
  for (const tile of [acceso, proxy, opaca, fija, { ...tesela(), toJSON: () => assert.fail('toJSON ejecutado') },
    { ...tesela(), desconocido: undefined }, { ...tesela(), [Symbol('extra')]: 1 },
    { ...tesela(), x: -0 }, { ...tesela(), food: NaN }, { ...tesela(), life: Infinity },
    { ...tesela(), wood: null }, { ...tesela(), moisture: undefined }, { ...tesela(), species: 'inédita' },
    { ...tesela(), rocaLatente: 0.5 }]) {
    assert.equal(prepararTeselasDirectas(parte([tile as Tile])), undefined);
  }
  const a = tesela();
  const invalida = Object.defineProperty([a], 0, { get: () => assert.fail('getter del vector ejecutado') });
  assert.equal(prepararTeselasDirectas(parte(invalida)), undefined);
  assert.equal(prepararTeselasDirectas(parte(new Array<Tile>(1))), undefined);
  assert.equal(prepararTeselasDirectas(parte([a, a])), undefined);
  const conAlias = parte([a], { retiredChunks: [{ tiles: [a] }] });
  assert.equal(prepararTeselasDirectas(conAlias), undefined);
  const canonica = deserialize(serialize(conAlias)) as ParteMundo;
  assert.equal(canonica.retiredChunks[0]!.tiles[0], canonica.tiles[0]);
  assert.ok(prepararTeselasDirectas(parte([a], { retiredChunks: [{ tiles: [{ ...a }] }] })));
});

test('el receptor rechaza bytes, recuentos y tuplas inválidos', () => {
  const fila = encodeSnapshotTileRows([tesela()], 0, 1, true)[0]!;
  const canonica = JSON.stringify(fila);
  const reemplazo = (campo: number, valor: unknown) => JSON.stringify(fila.map((original, i) => i === campo ? valor : original));
  for (const texto of [`${canonica}\n`, `${canonica}\r`, `\ufeff${canonica}`, `${canonica},${canonica}`,
    JSON.stringify(fila.slice(0, -1)), reemplazo(0, null), reemplazo(1, '-1'), reemplazo(2, 'inválido'),
    reemplazo(17, true), JSON.stringify([...fila, null]), canonica.replace('[0,', '[-0,'), canonica.replace('[0,', '[1e400,')]) {
    assert.throws(() => recibirTeselasDirectas([bloque(texto)], 1));
  }
  assert.throws(() => recibirTeselasDirectas([{ filas: 1, cuerpo: Uint8Array.of(0xc3, 0x28) }], 1));
  const parcial = bloque(` ${canonica}`).cuerpo.subarray(1);
  assert.throws(() => recibirTeselasDirectas([{ filas: 1, cuerpo: parcial }], 1));
  assert.throws(() => recibirTeselasDirectas([bloque(canonica, 2)], 2));
  assert.throws(() => recibirTeselasDirectas([bloque(canonica)], 2));
  assert.throws(() => recibirTeselasDirectas([bloque(canonica)], 0));
  for (const ausenciasPropias of [[], [-1], [1.5], [1, 2], [0], [65537]]) {
    assert.throws(() => recibirTeselasDirectas([{ ...bloque(canonica), ausenciasPropias }], 1));
  }
  assert.throws(() => recibirTeselasDirectas([{ ...bloque(reemplazo(6, 'forest')), ausenciasPropias: [1] }], 1));
  assert.deepEqual(recibirTeselasDirectas([], 0), []);
});
