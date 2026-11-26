import assert from 'node:assert/strict';
import test from 'node:test';
import { serialize } from 'node:v8';
import { estadoVista, fotogramaAVista, leerFotograma } from '../src/server/cinta/vista.js';
import { CONTROL_ENLACE_BYTES, disposicion, enlaceCinta, ESQUEMA_CELDA, type EnlaceCinta } from '../src/shared/fotograma.js';
import type { ChronicleEvent } from '../src/shared/types.js';
import type { CtxF0 } from '../src/world/motor/acceso.js';
import { CAMPOS_CUERPO, Clase, CUERPO_ANCHO } from '../src/world/motor/contratos.js';
import {
  abrirFotograma, cerrarFotograma, enlazarFuenteFotograma, escribirFotograma, type SucesoFotograma,
  type VistaPaginaFotograma,
} from '../src/world/motor/fotograma.js';
import { DEFAULT_PARAMS, setParams } from '../src/world/params.js';
import { crearSAB } from '../src/world/soa/arena.js';
import { PAGE_CELLS } from '../src/world/soa/region.js';

const serie = { poblacion: 1, nacimientos: 3, muertes: 2, fauna: 1, estructuras: 0, sustancias: 0, hz: 17 };
function enlace(bytes: number, ranuras = 1): EnlaceCinta {
  return enlaceCinta({ control: new SharedArrayBuffer(CONTROL_ENLACE_BYTES),
    ranuras: Array.from({ length: ranuras }, () => crearSAB(0, 64 * 1024)), sucesos: new SharedArrayBuffer(bytes) });
}

function contextos() {
  const cuerpo = new Float32Array(2 * CUERPO_ANCHO);
  cuerpo[CAMPOS_CUERPO.hambre] = 0.2;
  cuerpo[CAMPOS_CUERPO.sed] = 0.4;
  cuerpo[CAMPOS_CUERPO.energia] = 0.8;
  cuerpo[CAMPOS_CUERPO.salud] = 1;
  cuerpo[CAMPOS_CUERPO.masa] = 32.25;
  const campos = {
    vivo: Uint8Array.of(1, 1), dueno: Int32Array.of(0, 1), clase: Uint8Array.of(Clase.Persona, Clase.Animal),
    chunk: Int32Array.of(0, -1),
    uid: Float64Array.of(2 ** 40 + 1, 2 ** 40 + 2), x: Float32Array.of(8, -3), y: Float32Array.of(-9, 11),
    accion: Uint8Array.of(5, 1), cuerpo, principal: Int32Array.of(12, 0),
  };
  const columna = (nombre: keyof typeof campos) => campos[nombre];
  const escritura = { u8: columna, i32: columna, f64: columna, f32: columna };
  const terreno = {
    paginas: 1, paginaX: Int32Array.of(-1), paginaY: Int32Array.of(2),
    duenoChunk: Int16Array.of(0), versionVisible: Uint32Array.of(1),
    celda: (x: number, y: number) => x === -16 && y === 32 ? 0 : -1, chunkDe: () => 0,
  };
  const comun = { mundo: {}, tick: 10, frente: { alta: 2, columnas: ['principal'] }, terreno, escritura, retiraChunk: () => false };
  return { campos, terreno, coordinador: { ...comun, hilo: 0, chunks: Int32Array.of(0) },
    otro: { ...comun, hilo: 1, chunks: new Int32Array(0) } };
}

const evento: ChronicleEvent = { id: 'e7', tick: 11, kind: 'birth', actors: ['vecina'], text: 'Nació una vecina', cause: 'nacer', source: 'simulation' };
const pagina: VistaPaginaFotograma = Array<VistaPaginaFotograma[number]>(PAGE_CELLS).fill({ terrain: 'soil', moisture: 0.4, vegetation: 0.1, food: 0.3 });
const uidPersona = 2 ** 40 + 1, uidAnimal = 2 ** 40 + 2;
const ficha = { id: 'vecina', role: 'neighbor' as const, fatigue: 0.416,
  cuerpoVisto: { masa: 32, masaAdulta: 45, reserva: 0.5, agua: 0.5, digestivo: 0, carga: 0, T: 300, principal: 12 },
  crianza: { cuidadores: ['S'], madurez: 0.6 }, experiences: [{ tick: 0, text: 'Ficha', causeId: 'prueba' }], trust: [] };
const metadatos: SucesoFotograma[] = [
  { tipo: 'mundo', id: '', vista: { width: 40, height: 28, instanceId: 'prueba', lotes: [{ x: 2, y: 1, rol: 'fuego', forma: 0, principal: 3, masa: 2, T: 450 }] } },
  { tipo: 'clima', id: '', vista: 'rain' },
  { tipo: 'pagina', id: '-1,2', vista: pagina },
  { tipo: 'persona', id: String(uidPersona), vista: ficha },
  { tipo: 'animal', id: String(uidAnimal), vista: { id: 'animal-a', species: 'hare', fatigue: 0.012, generation: 0,
    parents: [], genes: { speed: 1, perception: 1, metabolism: 1, carnivory: 0, waterEfficiency: 1, camouflage: 1 }, age: 57,
    v23: { miedo: 0.5, linaje: 4 } } },
  ...Object.entries({ name: 'Ada', color: '#abc', reason: 'Descansa', need: 'sueño', recentMemory: 'Ayer' }).map(([campo, valor]): SucesoFotograma =>
    ({ tipo: 'texto', uid: uidPersona, campo, valor })),
  { tipo: 'texto', uid: uidAnimal, campo: 'reason', valor: 'come' },
];

test('los créditos, la cadencia, las páginas sucias y los sucesos sobreviven a los saltos', () => {
  const link = enlace(8192);
  const { campos, terreno, coordinador, otro } = contextos();
  const c = coordinador as unknown as CtxF0, segundo = otro as unknown as CtxF0;
  const vista = estadoVista(1);
  assert.equal(abrirFotograma(c, link, 1), null);
  setParams(c.mundo, { ...DEFAULT_PARAMS, v23: { ...DEFAULT_PARAMS.v23, fotograma: true } });
  Atomics.store(link.cadencia, 0, 2);
  Atomics.store(link.sucesosEscritos, 0, 8190n);
  Atomics.store(link.sucesosLeidos, 0, 8190n);
  Atomics.store(link.pedirCompleto, 0, 1);
  let pendientes: SucesoFotograma[] = [{ tipo: 'cronica', evento }, ...metadatos];
  let confirmados = 0;
  enlazarFuenteFotograma(link, {
    corte: () => ({ serie, sucesos: pendientes }),
    confirmar() { confirmados++; pendientes = []; },
  });

  assert.equal(abrirFotograma(c, link, 1), null);
  assert.equal(Atomics.load(link.pedirCompleto, 0), 1);
  Atomics.store(link.creditos, 0, 1);
  coordinador.tick = 11;
  assert.equal(abrirFotograma(c, link, 1), null);
  coordinador.tick = 12;
  const primero = abrirFotograma(c, link, 1)!;
  assert.equal(Atomics.load(link.creditos, 0), 0);
  assert.ok(escribirFotograma(c, structuredClone(primero), [0]));
  assert.ok(escribirFotograma(segundo, structuredClone(primero), [1]));
  assert.equal(leerFotograma(link, 0n, () => assert.fail()), false);
  cerrarFotograma(c, link, primero, true);
  assert.equal(abrirFotograma(c, link, 1), null);
  assert.ok(leerFotograma(link, 0n, (f, s) => {
    assert.equal(f.saltados, 1);
    assert.deepEqual([...f.reparto!], [0]);
    assert.equal(f.sucesos[0], 8190);
    assert.equal(Atomics.load(link.sucesosLeidos, 0), BigInt(f.sucesos[1]));
    assert.equal(Atomics.load(link.creditos, 0), 0);
    const corte = fotogramaAVista(vista, f, s, 5);
    assert.deepEqual([corte.t, corte.vista.tick, corte.vista.sequence, corte.seq], [12, 12, 12, 5]);
    assert.deepEqual(corte.serie, serie);
    assert.deepEqual(corte.hitos, [{ tipo: 'suceso', t: 11, importancia: 1, suceso: evento }]);
    assert.deepEqual(corte.vista.tiles[0], { ...pagina[0], x: -16, y: 32 });
    assert.equal(corte.tilesCambiadas, 'todas');
    const p = corte.vista.people[0];
    assert.deepEqual([p.id, p.name, p.action, p.hunger, p.thirst, p.energy, p.fatigue, p.recentMemory], ['vecina', 'Ada', 'rest', 0.2, 0.4, 0.8, 0.42, 'Ayer']);
    assert.equal(p.cuerpoVisto?.masa, 32.25);
    assert.equal(p.crianza?.madurez, 0.6);
    assert.ok(!Object.hasOwn(p, 'experiences') && !Object.hasOwn(p, 'trust'));
    assert.equal(corte.vista.animals?.[0].age, 40);
    assert.equal(corte.vista.animals?.[0].v23?.linaje, 4);
    assert.equal(corte.vista.lotes?.[0].T, 450);
  }));
  assert.equal(Atomics.load(link.creditos, 0), 1);

  // Un aborto en F6 no consume sucesos ni marca las versiones de página como entregadas.
  pendientes = [{ tipo: 'texto', uid: uidPersona, campo: 'recentMemory', valor: null }];
  coordinador.tick = 14;
  terreno.versionVisible[0]++;
  const abortado = abrirFotograma(c, link, 1)!;
  const vivo = campos.vivo, dueno = campos.dueno;
  campos.vivo = new Uint8Array(5).fill(1);
  campos.dueno = new Int32Array(5);
  assert.equal(escribirFotograma(c, abortado, [0, 1, 2, 3, 4]), false);
  cerrarFotograma(c, link, abortado, true);
  campos.vivo = vivo;
  campos.dueno = dueno;
  assert.equal(confirmados, 1);
  assert.equal(Atomics.load(link.entregados, 0), 1n);
  assert.equal(Atomics.load(link.creditos, 0), 1);

  coordinador.tick = 16;
  terreno.duenoChunk[0] = 1;
  otro.chunks = Int32Array.of(0);
  const delta = abrirFotograma(c, link, 1)!;
  assert.ok(escribirFotograma(c, delta, [0]));
  assert.ok(escribirFotograma(segundo, delta, [1]));
  cerrarFotograma(c, link, delta, true);
  leerFotograma(link, 1n, (f, s) => {
    assert.equal(f.saltados, 1);
    assert.deepEqual([...f.paginas], [-1, 2]);
    const corte = fotogramaAVista(vista, f, s, 6);
    assert.equal(corte.vista.people[0].recentMemory, null);
    assert.equal(corte.vista.tiles.length, 0);
    assert.ok(Array.isArray(corte.tilesCambiadas) && corte.tilesCambiadas.length === PAGE_CELLS);
  });

  coordinador.tick = 18;
  terreno.duenoChunk[0] = 0;
  const sinCambio = abrirFotograma(c, link, 1)!;
  assert.ok(escribirFotograma(c, sinCambio, [0]));
  assert.ok(escribirFotograma(segundo, sinCambio, [1]));
  cerrarFotograma(c, link, sinCambio, true);
  leerFotograma(link, 2n, (f, s) => {
    assert.deepEqual([...f.paginas], []);
    assert.equal(s.length, 0);
    assert.equal(f.saltados, 0);
  });

  Atomics.store(link.pedirCompleto, 0, 1);
  coordinador.tick = 20;
  const completoAbortado = abrirFotograma(c, link, 1)!;
  cerrarFotograma(c, link, completoAbortado, false);
  assert.equal(Atomics.load(link.pedirCompleto, 0), 1);
  coordinador.tick = 22;
  pendientes = metadatos.filter(s => s.tipo !== 'texto' || s.campo !== 'recentMemory');
  const completo = abrirFotograma(c, link, 1)!;
  assert.ok(escribirFotograma(c, completo, [0]));
  assert.ok(escribirFotograma(segundo, completo, [1]));
  cerrarFotograma(c, link, completo, true);
  leerFotograma(link, 3n, (f, s) => {
    // Una celda material sintética comprueba la lectura sin ejecutar la ley W.
    const { desde } = disposicion(ESQUEMA_CELDA), celdas = new DataView(f.celdas.buffer, f.celdas.byteOffset, f.celdas.byteLength);
    celdas.setFloat32(desde.T, 295.25, true);
    celdas.setUint32(desde.mat0, 9, true);
    celdas.setUint8(desde.fr0, 128);
    const corte = fotogramaAVista(vista, f, s, 8);
    assert.deepEqual(corte.vista.tiles[0].mat, [[9, 128 / 255]]);
    assert.equal(corte.vista.tiles[0].T, 295.25);
    assert.equal(corte.vista.people[0].recentMemory, null);
    assert.ok(Array.isArray(corte.tilesCambiadas));
  });
});

test('una fila cedida en F6 se graba una vez y el destino la graba tras adoptarla', () => {
  const link = enlace(8192);
  const { campos, coordinador, otro } = contextos();
  const origen = coordinador as unknown as CtxF0, destino = otro as unknown as CtxF0;
  const vista = estadoVista(1);
  setParams(origen.mundo, { ...DEFAULT_PARAMS, v23: { ...DEFAULT_PARAMS.v23, fotograma: true } });
  Atomics.store(link.creditos, 0, 1);
  enlazarFuenteFotograma(link, { corte: () => ({ serie, sucesos: metadatos }), confirmar() {} });

  const antes = abrirFotograma(origen, link, 1)!;
  assert.ok(escribirFotograma(origen, antes, [0]));
  // La cesión cambia el frente escrito, pero el destino todavía no tiene a la persona en su heap.
  campos.dueno[0] = 1;
  assert.ok(escribirFotograma(destino, antes, [1]));
  assert.ok(cerrarFotograma(origen, link, antes, true));
  assert.ok(leerFotograma(link, 0n, (f, sucesos) => {
    assert.equal(f.n, 2);
    assert.deepEqual(fotogramaAVista(vista, f, sucesos, 1).vista.people.map(p => p.id), ['vecina']);
  }));

  coordinador.tick++;
  const despues = abrirFotograma(origen, link, 1)!;
  assert.ok(escribirFotograma(origen, despues, []));
  assert.ok(escribirFotograma(destino, despues, [0, 1]));
  assert.ok(cerrarFotograma(origen, link, despues, true));
  assert.ok(leerFotograma(link, 1n, (f, sucesos) => {
    assert.equal(f.n, 2);
    assert.deepEqual(fotogramaAVista(vista, f, sucesos, 2).vista.people.map(p => p.id), ['vecina']);
  }));
});

test('si el anillo se llena, el motor entrega el crédito sin esperar ni adelantar el cursor', t => {
  const s: SucesoFotograma = { tipo: 'cronica', evento };
  const link = enlace(serialize(s).length + 4, 2);
  const c = contextos().coordinador;
  const ctx = c as unknown as CtxF0;
  setParams(ctx.mundo, { ...DEFAULT_PARAMS, v23: { ...DEFAULT_PARAMS.v23, fotograma: true } });
  Atomics.store(link.creditos, 0, 2);
  enlazarFuenteFotograma(link, { corte: () => ({ serie, sucesos: [s] }), confirmar() {} });
  cerrarFotograma(ctx, link, abrirFotograma(ctx, link, 1)!, true);
  const frontera = Atomics.load(link.sucesosEscritos, 0);
  const wait = t.mock.method(Atomics, 'wait', () => assert.fail('el productor esperó al consumidor'));
  c.tick++;
  assert.equal(cerrarFotograma(ctx, link, abrirFotograma(ctx, link, 2)!, true), false);
  assert.equal(wait.mock.callCount(), 0);
  assert.equal(Atomics.load(link.saturado, 0), 1);
  assert.equal(Atomics.load(link.entregados, 0), 1n);
  assert.equal(Atomics.load(link.sucesosEscritos, 0), frontera);
  assert.ok(leerFotograma(link, 0n, (f, sucesos) => {
    assert.equal(BigInt(f.sucesos[1]), frontera);
    assert.deepEqual(sucesos, [s]);
  }));
  assert.equal(Atomics.load(link.creditos, 0), 2);
});

test('un lote mayor que el anillo falla con diagnóstico y no confirma ni publica', () => {
  const link = enlace(8);
  const datos = contextos().coordinador, c = datos as unknown as CtxF0;
  setParams(c.mundo, { ...DEFAULT_PARAMS, v23: { ...DEFAULT_PARAMS.v23, fotograma: true } });
  Atomics.store(link.creditos, 0, 1);
  const sucesos: SucesoFotograma[] = [{ tipo: 'cronica', evento }];
  let confirmados = 0;
  enlazarFuenteFotograma(link, { corte: () => ({ serie, sucesos }), confirmar() { confirmados++; } });
  const f = abrirFotograma(c, link, 1)!;
  assert.equal(cerrarFotograma(c, link, f, true), false);
  assert.equal(confirmados, 0);
  assert.equal(Atomics.load(link.entregados, 0), 0n);
  assert.equal(Atomics.load(link.sucesosEscritos, 0), 0n);
  assert.equal(Atomics.load(link.creditos, 0), 1);

  datos.tick++;
  assert.equal(abrirFotograma(c, link, 1), null);
  const reemplazo = enlace(8);
  Atomics.store(reemplazo.creditos, 0, 1);
  enlazarFuenteFotograma(reemplazo, { corte: () => ({ serie, sucesos: [] }), confirmar() {} });
  assert.equal(cerrarFotograma(c, reemplazo, abrirFotograma(c, reemplazo, 2)!, true), true);
  assert.throws(() => leerFotograma(reemplazo, 0n, f => {
    assert.equal(f.completo, true);
    throw new Error('Falló el consumidor');
  }), /Falló el consumidor/);
  assert.equal(Atomics.load(reemplazo.creditos, 0), 1);
});
