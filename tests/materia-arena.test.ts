import assert from 'node:assert/strict';
import { setTimeout as esperar } from 'node:timers/promises';
import test from 'node:test';
import { isMainThread, parentPort, threadId, Worker, workerData } from 'node:worker_threads';
import { ClaseSustancia, TIPOS } from '../src/shared/materia.js';
import { NE, TABLA } from '../src/shared/naturaleza.js';
import { ArenaLotes, desbordeDeEspecies, LOTES_POR_BLOQUE, ranurasDesborde, type MemoriaMateria } from '../src/world/materia/arena.js';
import {
  codificarCheckpoint, codificarEnVuelo, codificarPaginas, decodificarCheckpoint, decodificarEnVuelo, decodificarPaginas,
  indexarPaginas, saldoEnVuelo,
} from '../src/world/materia/checkpoint.js';
import { comprobarConservacion, plegarLibros, registrarConservacion, sumarEnVuelo, type TotalesMateria } from '../src/world/materia/libro.js';
import { REF_NULA, TipoIntento, genDe, refDe, slotDe, type Intento } from '../src/world/motor/contratos.js';
import type { World } from '../src/world/mundo/tipos.js';
import type { Elements } from '../src/world/soa/arena.js';
import { Parte, Rol, libroVacio, type Libro, type LoteRef, type ServicioQuimico, type Sustancia } from '../src/world/materia/tipos.js';

const HILOS = 32;
const RONDAS = 10;
const UNICOS = 5_000;
const STOCK = 8_000;
const CALOR = 720_000;

const paresPrueba = TIPOS.filter(t => t.k === 1).slice(0, 12);
const sustancias: Sustancia[] = paresPrueba.map(({ e, f, d }, i) => {
  const atomos = new Uint8Array(NE);
  atomos[e]++;
  atomos[f]++;
  return {
    id: i + 1,
    clase: ClaseSustancia.Molecula,
    enlaces: Uint16Array.of(TIPOS.indexOf(paresPrueba[i]), 1),
    atomos,
    masa: TABLA[e].masa + TABLA[f].masa,
    energia: -d,
    prop: {
      r: 1, dMedia: d, tFusion: 273, tEbullicion: 373, qOxidacion: 0, dureza: 0,
      tenacidad: 0, flexibilidad: 0, polaridad: 0, densidad: 1, color: 0x888888,
    },
  };
});
const quimica: ServicioQuimico = {
  internar: () => { throw new Error('El doble solo lee sustancias'); },
  sustancia(id) {
    const s = sustancias[id - 1];
    assert.ok(s, `Sustancia de prueba desconocida: ${id}`);
    return s;
  },
  reaccion: () => null,
};

function azarDe(semilla: number): () => number {
  return () => {
    semilla ^= semilla << 13;
    semilla ^= semilla >>> 17;
    semilla ^= semilla << 5;
    return semilla >>> 0;
  };
}

function mezclar<T>(datos: T[], azar: () => number): void {
  for (let i = datos.length - 1; i > 0; i--) {
    const j = azar() % (i + 1);
    [datos[i], datos[j]] = [datos[j], datos[i]];
  }
}

type Cantidades = readonly number[];

function acumularPares(cuenta: number[], pares: Float64Array): void {
  assert.equal(pares.length % 2, 0);
  for (let i = 0; i < pares.length; i += 2) {
    const id = pares[i], cantidad = pares[i + 1];
    assert.ok(Number.isSafeInteger(id) && id >= 0 && id < cuenta.length);
    assert.ok(Number.isSafeInteger(cantidad) && cantidad >= 0);
    cuenta[id] += cantidad;
  }
}

// Oráculo independiente del libro: [calor, cantidad por sustancia].
function saldo(cantidades: Cantidades): bigint[] {
  const cuenta = Array<bigint>(NE + 1).fill(0n);
  cuenta[NE] = BigInt(cantidades[0]);
  for (const s of sustancias) {
    const q = BigInt(cantidades[s.id]);
    for (let e = 0; e < NE; e++) cuenta[e] += q * BigInt(s.atomos[e]);
    cuenta[NE] += q * BigInt(s.energia);
  }
  return cuenta;
}

const cantidadesVacias = (): number[] => Array<number>(sustancias.length + 1).fill(0);

function pedir<T>(worker: Worker, orden?: Orden): Promise<T> {
  return new Promise((resolve, reject) => {
    const liberar = () => {
      worker.off('message', recibir);
      worker.off('error', fallar);
      worker.off('exit', salir);
    };
    const recibir = (respuesta: T) => { liberar(); resolve(respuesta); };
    const fallar = (error: Error) => { liberar(); reject(error); };
    const salir = (codigo: number) => fallar(new Error(`El trabajador terminó con código ${codigo}.`));
    worker.once('message', recibir);
    worker.once('error', fallar);
    worker.once('exit', salir);
    if (orden) worker.postMessage(orden);
  });
}

const CAPACIDAD_PRUEBA = 4096;
type SAB = SharedArrayBuffer & { grow(bytes: number): void };
const SAB = SharedArrayBuffer as unknown as new(bytes: number, opciones: { maxByteLength: number }) => SAB;
type Columna = { memoria: SAB; ancho: number; fill: number };
type ConstructorColumna<T extends Elements> = { new (buffer: SharedArrayBuffer): T; readonly BYTES_PER_ELEMENT: number };
type DescriptorMemoria = { control: Int32Array; libres: Int32Array; columnas: Map<string, Columna> };

function enteros(cantidad: number): Int32Array {
  return new Int32Array(new SharedArrayBuffer(cantidad * Int32Array.BYTES_PER_ELEMENT));
}

class MemoriaPrueba implements MemoriaMateria {
  constructor(readonly descriptor: DescriptorMemoria = { control: enteros(3), libres: enteros(CAPACIDAD_PRUEBA), columnas: new Map() }) {}

  field<T extends Elements>(nombre: string, Tipo: ConstructorColumna<T>, perPage: number, fill = 0): T {
    assert.equal(fill, 0, 'el doble solo amplía columnas inicializadas a cero');
    const { columnas, control } = this.descriptor, ancho = Tipo.BYTES_PER_ELEMENT * perPage;
    let columna = columnas.get(nombre);
    if (!columna) {
      const memoria = new SAB(Atomics.load(control, 2) * ancho, { maxByteLength: CAPACIDAD_PRUEBA * ancho });
      columna = { memoria, ancho, fill };
      columnas.set(nombre, columna);
    }
    assert.equal(columna.ancho, ancho);
    assert.equal(columna.fill, fill);
    return new Tipo(columna.memoria);
  }

  get slots(): number { return Atomics.load(this.descriptor.control, 0); }

  reserve(): number {
    const { control, libres } = this.descriptor;
    for (;;) {
      const disponibles = Atomics.load(control, 1);
      if (disponibles === 0) break;
      if (Atomics.compareExchange(control, 1, disponibles, disponibles - 1) === disponibles) return libres[disponibles - 1];
    }
    const slot = Atomics.add(control, 0, 1);
    assert.ok(slot < Atomics.load(control, 2), 'el coordinador reserva capacidad en barrera');
    return slot;
  }

  release(slot: number): void {
    const { control, libres } = this.descriptor;
    libres[Atomics.add(control, 1, 1)] = slot;
  }

  crecer(capacidad: number): void {
    const { columnas, control } = this.descriptor;
    for (const { memoria, ancho } of columnas.values()) memoria.grow(capacidad * ancho);
    Atomics.store(control, 2, capacidad);
  }
}

function memoriaDe(n: number, capacidad: number) {
  const lotes = new MemoriaPrueba(), desborde = new MemoriaPrueba(), paginas = new MemoriaPrueba();
  lotes.crecer(Math.ceil(capacidad / LOTES_POR_BLOQUE) * LOTES_POR_BLOQUE);
  desborde.crecer(capacidad * 4);
  paginas.crecer(n);
  const duenoChunk = new Int16Array(new SharedArrayBuffer(n * Int16Array.BYTES_PER_ELEMENT));
  for (let i = 0; i < n; i++) duenoChunk[paginas.reserve()] = i;
  return { lotes, desborde, paginas, duenoChunk };
}

type MemoriaArena = { lotes: MemoriaMateria; desborde: MemoriaMateria; paginas: MemoriaMateria; duenoChunk: Int16Array };

function arenaDe({ lotes, desborde, paginas, duenoChunk }: MemoriaArena, hilo: number): ArenaLotes {
  return new ArenaLotes({
    lotes, desborde, paginas, hilo, quimica,
    terreno: { chunkDe: celda => Math.floor(celda / 256), duenoChunk },
    agua: 1,
    digerible: s => s.id === 2 ? 5 : 0,
  });
}

function libroCompartido(): Libro {
  const cuenta = () => new Float64Array(new SharedArrayBuffer((NE + 1) * Float64Array.BYTES_PER_ELEMENT));
  return { enVuelo: cuenta(), fuentes: cuenta(), sumideros: cuenta() };
}

type Deposito = { nonce: number; destino: number; muerto: boolean; pares: Float64Array };
type Entrega = Deposito & { lote: LoteRef };
type Orden = { tipo: 'leer'; viejo: LoteRef; puerta: Int32Array; nuevo: Float64Array }
  | { tipo: 'iniciar' }
  | { tipo: 'barrera' }
  | { tipo: 'enviar'; ronda: number }
  | { tipo: 'recibir'; mensajes: Entrega[] };

interface DatosObrero {
  id: number;
  lotes: DescriptorMemoria;
  desborde: DescriptorMemoria;
  paginas: DescriptorMemoria;
  duenoChunk: Int16Array<SharedArrayBuffer>;
  libro: Libro;
}

function obrero(datos: DatosObrero): void {
  const hilo = datos.id, libro = datos.libro;
  const arena = arenaDe({
    lotes: new MemoriaPrueba(datos.lotes), desborde: new MemoriaPrueba(datos.desborde),
    paginas: new MemoriaPrueba(datos.paginas), duenoChunk: datos.duenoChunk,
  }, hilo);
  let origen: LoteRef, vivo: LoteRef, muerto: LoteRef, suelo: LoteRef;
  const remanente = [CALOR, ...sustancias.map(() => STOCK)];
  const recibidos = cantidadesVacias(), retornados = cantidadesVacias();
  const comparar = (lote: LoteRef, cantidades: Cantidades) => {
    assert.equal(arena.calor(lote), cantidades[0]);
    for (const s of sustancias) assert.equal(arena.cuantos(lote, s.id), cantidades[s.id]);
  };
  parentPort!.on('message', async (orden: Orden) => {
    if (orden.tipo === 'leer') {
      const { viejo, puerta, nuevo } = orden;
      assert.ok(arena.vivo(viejo));
      Atomics.store(puerta, 0, 1);
      while (Atomics.load(puerta, 1) === 0) {
        assert.ok(arena.vivo(viejo));
        Atomics.wait(puerta, 1, 0, 1);
      }
      assert.ok(arena.vivo(nuevo[0]));
      assert.equal(arena.calor(nuevo[0]), 0);
      parentPort!.postMessage(true);
      return;
    }
    if (orden.tipo === 'iniciar') {
      const celda = hilo * 256;
      origen = arena.nuevo(Rol.Reserva, -1, 0);
      vivo = arena.nuevo(Rol.Tejido, -1, 0);
      muerto = arena.nuevo(Rol.Digestivo, -1, 0);
      suelo = arena.nuevo(Rol.Suelo, celda, 0);
      assert.ok(arena.propio(origen));
      arena.fuente(origen, Float64Array.from(remanente.flatMap((q, id) => [id, q])), libro);
      parentPort!.postMessage({ threadId, vivo, muerto });
      return;
    }
    if (orden.tipo === 'enviar') {
      const ronda = orden.ronda, azar = azarDe(0x6d2b79f5 + ronda * 32 + hilo);
      const base = Math.floor(UNICOS / HILOS), extra = UNICOS % HILOS;
      const inicio = ronda * UNICOS + hilo * base + Math.min(hilo, extra) + 1;
      const pedidos = Array.from({ length: base + Number(hilo < extra) }, (_, i) => ({
        nonce: inicio + i, destino: (hilo + 1 + azar() % (HILOS - 1)) % HILOS, muerto: azar() % 3 === 0,
        pedido: { parte: Parte.Exacta, esp: 1 + azar() % sustancias.length, cuantos: 1 + azar() % 7, kappa: null },
      }));
      const vistos = new Set<number>(), depositos: Deposito[] = [];
      const intentos = [...pedidos, ...pedidos];
      mezclar(intentos, azar);
      await esperar(azar() % 5);
      for (const { nonce, destino, muerto, pedido } of intentos) {
        const pares = arena.garantizarUna(nonce, origen, pedido, libro);
        if (vistos.has(nonce)) {
          assert.equal(pares, null, `nonce ${nonce}: débito repetido`);
          continue;
        }
        assert.ok(pares);
        vistos.add(nonce);
        const cantidades = cantidadesVacias();
        acumularPares(cantidades, pares);
        assert.equal(cantidades[pedido.esp], pedido.cuantos);
        for (let id = 1; id < cantidades.length; id++) if (id !== pedido.esp) assert.equal(cantidades[id], 0);
        for (let id = 0; id < cantidades.length; id++) remanente[id] -= cantidades[id];
        depositos.push({ nonce, destino, muerto, pares });
      }
      comparar(origen, remanente);
      parentPort!.postMessage({ depositos, intentos: intentos.length });
      return;
    }
    if (orden.tipo === 'barrera') {
      arena.barrera();
      parentPort!.postMessage(true);
      return;
    }
    if (arena.vivo(muerto)) arena.liberar(muerto);
    const vistos = new Set<number>();
    let abonados = 0, devueltos = 0;
    await esperar(azarDe(0x1b873593 + hilo + orden.mensajes[0].nonce)() % 5);
    for (const entrega of orden.mensajes) {
      const { nonce, lote, pares } = entrega, destino = arena.vivo(lote) ? lote : suelo;
      const aceptado = arena.abonarUna(nonce, destino, pares, libro);
      assert.equal(aceptado, !vistos.has(nonce), `nonce ${nonce}: abono repetido o perdido`);
      if (!aceptado) continue;
      assert.equal(destino === suelo, entrega.muerto);
      vistos.add(nonce);
      if (destino === suelo) { devueltos++; acumularPares(retornados, pares); }
      else { abonados++; acumularPares(recibidos, pares); }
    }
    comparar(vivo, recibidos);
    comparar(suelo, retornados);
    parentPort!.postMessage({ abonados, devueltos });
  });
  parentPort!.postMessage('listo');
}

const marcado = workerData?.materiaArena === true;
if (!isMainThread && marcado) obrero(workerData);

if (isMainThread) test('I1, I3 e I7: 32 hilos, 100.000 intentos, nonces repetidos y destinos muertos', async t => {
  const memoria = memoriaDe(HILOS, 1), arena = arenaDe(memoria, 0);
  const viejo = arena.nuevo(Rol.Objeto, -1, 0);
  for (let i = 1; i < LOTES_POR_BLOQUE; i++) arena.nuevo(Rol.Objeto, -1, 0);
  const libros = Array.from({ length: HILOS }, libroCompartido);
  const workers = libros.map((libro, id) => new Worker(new URL(import.meta.url), { workerData: {
    materiaArena: true, id, libro, lotes: memoria.lotes.descriptor, desborde: memoria.desborde.descriptor,
    paginas: memoria.paginas.descriptor, duenoChunk: memoria.duenoChunk,
  } }));
  t.after(() => Promise.all(workers.map(worker => worker.terminate())).then(() => {}));
  assert.deepEqual(await Promise.all(workers.map(worker => pedir(worker))), Array(HILOS).fill('listo'));

  const puerta = enteros(2), nuevo = new Float64Array(new SharedArrayBuffer(8));
  const lectura = pedir(workers[1], { tipo: 'leer', viejo, puerta, nuevo });
  try {
    await Promise.race([
      lectura,
      (async () => {
        while (Atomics.load(puerta, 0) === 0) await esperar(1, undefined, { ref: false });
      })(),
    ]);
    memoria.lotes.crecer(2 * LOTES_POR_BLOQUE);
    memoria.desborde.crecer(1024);
    nuevo[0] = arena.nuevo(Rol.Objeto, -1, 0);
  } finally {
    Atomics.store(puerta, 1, 1);
    Atomics.notify(puerta, 1);
  }
  assert.equal(await lectura, true);

  const refs = await Promise.all(workers.map(worker => pedir<{ threadId: number; vivo: LoteRef; muerto: LoteRef }>(worker, { tipo: 'iniciar' })));
  assert.equal(new Set(refs.map(ref => ref.threadId)).size, HILOS);
  assert.ok(refs.every(ref => ref.threadId > 0));
  const cero = saldo(cantidadesVacias());
  const inicial: TotalesMateria = { inicial: cero, fuentes: cero, sumideros: cero };
  let totales = plegarLibros(libros, inicial);
  const fuentes = saldo([CALOR * HILOS, ...sustancias.map(() => STOCK * HILOS)]);
  assert.deepEqual(totales.fuentes, fuentes);
  assert.deepEqual(arena.saldo(), fuentes);
  comprobarConservacion(totales, arena.saldo(), sumarEnVuelo(libros));

  const azar = azarDe(0x85ebca6b);
  let intentos = 0, netos = 0, depositados = 0, devueltos = 0, calorTransportado = 0;
  for (let ronda = 0; ronda < RONDAS; ronda++) {
    const salidas = await Promise.all(workers.map(worker => pedir<{ depositos: Deposito[]; intentos: number }>(worker, { tipo: 'enviar', ronda })));
    const depositos = salidas.flatMap(salida => salida.depositos);
    assert.equal(depositos.length, UNICOS);
    assert.equal(new Set(depositos.map(d => d.nonce)).size, UNICOS);
    const cuentasVuelo = cantidadesVacias(), entradas: Entrega[][] = workers.map(() => []);
    for (const deposito of depositos) {
      acumularPares(cuentasVuelo, deposito.pares);
      const ref = refs[deposito.destino];
      const entrega = { ...deposito, lote: deposito.muerto ? ref.muerto : ref.vivo };
      entradas[deposito.destino].push(entrega, { ...entrega, pares: entrega.pares.slice() });
    }
    for (const entrada of entradas) mezclar(entrada, azar);
    assert.equal(entradas.reduce((n, entrada) => n + entrada.length, 0), 2 * UNICOS);
    intentos += salidas.reduce((n, salida) => n + salida.intentos, 0);
    netos += depositos.length;
    calorTransportado += cuentasVuelo[0];

    const enVuelo = saldo(cuentasVuelo);
    assert.deepEqual(sumarEnVuelo(libros), enVuelo);
    totales = plegarLibros(libros, totales);
    assert.deepEqual(Array.from(libros[0].enVuelo, BigInt), enVuelo);
    assert.ok(libros.slice(1).every(libro => libro.enVuelo.every(v => v === 0)));
    comprobarConservacion(totales, arena.saldo(), enVuelo);

    const llegadas = await Promise.all(workers.map((worker, id) => pedir<{ abonados: number; devueltos: number }>(worker,
      { tipo: 'recibir', mensajes: entradas[id] })));
    await Promise.all(workers.map(worker => pedir(worker, { tipo: 'barrera' })));
    const muertos = depositos.filter(d => d.muerto).length;
    assert.equal(llegadas.reduce((n, l) => n + l.devueltos, 0), muertos);
    assert.equal(llegadas.reduce((n, l) => n + l.abonados, 0), UNICOS - muertos);
    assert.ok(refs.every(ref => !arena.vivo(ref.muerto)));
    depositados += UNICOS - muertos;
    devueltos += muertos;
    totales = plegarLibros(libros, totales);
    assert.deepEqual(sumarEnVuelo(libros), cero);
    assert.deepEqual(arena.saldo(), fuentes);
    comprobarConservacion(totales, arena.saldo(), cero);
  }
  assert.equal(intentos, 100_000);
  assert.equal(netos, depositados + devueltos);
  assert.ok(depositados > 0 && devueltos > 0 && calorTransportado > 0);
  t.diagnostic(`${netos} garantías únicas, ${depositados} abonadas, ${devueltos} devueltas a Suelo, ${calorTransportado} J transportados.`);
});

if (isMainThread) test('I3: rechaza cantidades y asientos inexactos antes de escribir', () => {
  const arena = arenaDe(memoriaDe(1, 8), 0), libro = libroVacio();
  const origen = arena.nuevo(Rol.Tejido, -1, 0), destino = arena.nuevo(Rol.Reserva, -1, 0);
  arena.fuente(origen, Float64Array.of(1, 10, 0, 100), libro);
  for (const invalido of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => arena.fuente(origen, Float64Array.of(1, 4, 0, invalido), libro));
    assert.throws(() => arena.mover({ de: origen, a: destino, esp: 1, cuantos: invalido }));
    assert.throws(() => arena.moverCalor(origen, destino, invalido));
    assert.throws(() => arena.garantizar(origen, { parte: Parte.Exacta, esp: 1, cuantos: invalido, kappa: null }, libro));
  }
  assert.throws(() => arena.fuente(destino, Float64Array.of(1, Number.MAX_SAFE_INTEGER), libro));
  assert.equal(arena.cuantos(origen, 1), 10);
  assert.equal(arena.calor(origen), 100);
  assert.equal(arena.cuantos(destino, 1), 0);
  assert.equal(arena.calor(destino), 0);
  assert.deepEqual(Array.from(libro.fuentes, BigInt), arena.saldo());
  assert.throws(() => arena.liberar(origen));
  assert.ok(arena.vivo(origen));
});

if (isMainThread) test('la arena rechaza columnas que no crecen con la memoria', () => {
  const memoria = memoriaDe(1, 8);
  const fija: MemoriaMateria = {
    field: (_nombre, Tipo, porPagina) => new Tipo(new SharedArrayBuffer(64 * porPagina * Tipo.BYTES_PER_ELEMENT)),
    reserve: () => 0, release: () => {}, slots: 0,
  };
  assert.throws(() => arenaDe({ ...memoria, desborde: fija }, 0), /crecible/);
  assert.throws(() => arenaDe({ ...memoria, paginas: fija }, 0), /crecible/);
});

if (isMainThread) test('una ranura vacía caduca al liberar y vuelve en barrera con otra generación', () => {
  const memoria = memoriaDe(2, 8), arena = arenaDe(memoria, 0), otro = arenaDe(memoria, 1);
  const viejo = arena.nuevo(Rol.Tejido, -1, 0);
  const celda = arena.nuevo(Rol.Suelo, 0, 123);
  assert.ok(arena.propio(viejo));
  assert.equal(otro.propio(viejo), false);
  assert.throws(() => otro.adoptar(celda));
  otro.adoptar(viejo);
  assert.equal(arena.propio(viejo), false);
  assert.ok(otro.propio(viejo));
  assert.throws(() => arena.formar(viejo, 7));
  otro.liberar(viejo);
  assert.equal(arena.vivo(viejo), false);
  assert.equal(otro.vivo(viejo), false);
  const antes = arena.nuevo(Rol.Objeto, -1, 0);
  assert.equal(memoria.lotes.slots, 3);
  otro.barrera();
  const despues = arena.nuevo(Rol.Objeto, -1, 0);
  assert.equal(memoria.lotes.slots, 3);
  assert.notEqual(despues, viejo);
  assert.notEqual(despues, antes);
  assert.equal(arena.vivo(viejo), false);
  assert.ok(arena.vivo(despues));
  const pequeño = new Float64Array(0), salida = new Float64Array(1);
  assert.equal(arena.lotes(0, Rol.Suelo, pequeño), 1);
  assert.equal(otro.lotes(0, Rol.Suelo, salida), 1);
  assert.equal(salida[0], celda);
});

if (isMainThread) test('desborde y moverParte conservan composición y calor para toda selección', () => {
  const arena = arenaDe(memoriaDe(1, 16), 0), libro = libroVacio();
  const origen = arena.nuevo(Rol.Tejido, -1, 0), destino = arena.nuevo(Rol.Reserva, -1, 0);
  arena.fuente(origen, Float64Array.from([0, 1200, ...sustancias.flatMap(({ id }) => [id, 10])]), libro);
  const ids = new Uint32Array(12), corta = new Uint32Array(2);
  assert.equal(arena.especies(origen, corta), sustancias.length);
  assert.ok(corta.every((id, i) => id > 0 && corta.indexOf(id) === i));
  assert.equal(arena.especies(origen, ids), sustancias.length);
  assert.deepEqual(Array.from(ids).sort((a, b) => a - b), sustancias.map(({ id }) => id));

  const pedidoAgua = { parte: Parte.Agua, esp: 0, cuantos: 5, kappa: null };
  assert.equal(arena.moverParte(origen, destino, pedidoAgua), 5);
  assert.equal(arena.cuantos(destino, 1), 5);
  assert.equal(arena.calor(destino), 50);
  const pedidoDigerible = { parte: Parte.Digerible, esp: 0, cuantos: 4, kappa: null };
  assert.equal(arena.moverParte(origen, destino, pedidoDigerible), 4);
  assert.equal(arena.cuantos(destino, 2), 4);
  assert.equal(arena.calor(destino), 90);
  assert.equal(arena.moverParte(origen, destino, { parte: Parte.Todo, esp: 0, cuantos: 0, kappa: null }), 111);
  assert.equal(arena.calor(origen), 0);
  assert.equal(arena.calor(destino), 1200);
  assert.equal(arena.especies(origen, ids), 0);
  for (const { id } of sustancias) assert.equal(arena.cuantos(destino, id), 10);
  const totales = plegarLibros([libro], { inicial: saldo(cantidadesVacias()), fuentes: saldo(cantidadesVacias()), sumideros: saldo(cantidadesVacias()) });
  comprobarConservacion(totales, arena.saldo(), sumarEnVuelo([libro]));
  arena.liberar(origen);
});

if (isMainThread) test('especies lee cantidades en orden incluso en el desborde y con un destino corto', () => {
  const arena = arenaDe(memoriaDe(1, 16), 0), lote = arena.nuevo(Rol.Tejido, -1, 0);
  const orden = sustancias.map(({ id }) => id).reverse();
  arena.fuente(lote, Float64Array.from([0, 42, ...orden.flatMap(id => [id, 3 * id])]), libroVacio());
  const ids = new Uint32Array(orden.length), cantidades = new Float64Array(orden.length);
  assert.equal(arena.especies(lote, ids, cantidades.subarray(0, 9)), orden.length);
  assert.deepEqual(Array.from(ids.slice(0, 9)), orden.slice(0, 9));
  assert.equal(ids[9], 0);
  assert.deepEqual(Array.from(cantidades.slice(0, 9)), orden.slice(0, 9).map(id => 3 * id));
  assert.equal(arena.especies(lote, ids, cantidades), orden.length);
  assert.deepEqual(Array.from(ids), orden);
  assert.deepEqual(Array.from(cantidades), orden.map(id => arena.cuantos(lote, id)));
});

if (isMainThread) test('el sumidero recorta a existencias y asienta solo lo que salió', () => {
  const arena = arenaDe(memoriaDe(1, 8), 0), libro = libroVacio();
  const lote = arena.nuevo(Rol.Aire, 17, 0);
  arena.fuente(lote, Float64Array.of(1, 10, 2, 3, 0, 400), libro);
  const salida = arena.sumidero(lote, Float64Array.of(1, 4, 2, 9, 5, 2, 0, 1000), libro);
  const cantidades = cantidadesVacias();
  acumularPares(cantidades, salida);
  assert.deepEqual(cantidades, [400, 4, 3, ...Array(sustancias.length - 2).fill(0)]);
  assert.equal(arena.cuantos(lote, 1), 6);
  assert.equal(arena.cuantos(lote, 2), 0);
  assert.equal(arena.calor(lote), 0);
  assert.deepEqual(Array.from(libro.sumideros, BigInt), saldo(cantidades));
  const cero = saldo(cantidadesVacias());
  comprobarConservacion(plegarLibros([libro], { inicial: cero, fuentes: cero, sumideros: cero }), arena.saldo(), cero);
});

if (isMainThread) test('un nonce repetido no tiene efecto durante los dos ticks de I-B', () => {
  const arena = arenaDe(memoriaDe(1, 8), 0), libro = libroVacio();
  const origen = arena.nuevo(Rol.Reserva, -1, 0), destino = arena.nuevo(Rol.Tejido, -1, 0);
  arena.fuente(origen, Float64Array.of(1, 100), libro);
  const pedido = { parte: Parte.Exacta, esp: 1, cuantos: 1, kappa: null };
  const garantia = arena.garantizarUna(9, origen, pedido, libro)!;
  assert.ok(arena.abonarUna(9, destino, garantia, libro));
  for (let tick = 0; tick < 2; tick++) {
    arena.barrera();
    assert.equal(arena.garantizarUna(9, origen, pedido, libro), null);
    assert.equal(arena.abonarUna(9, destino, garantia, libro), false);
  }
  assert.equal(arena.cuantos(origen, 1), 99);
  assert.equal(arena.cuantos(destino, 1), 1);
  assert.ok(libro.enVuelo.every(v => v === 0));
});

if (isMainThread) test('sin desborde libre no se escribe ningún lote ni el libro', () => {
  // Capacidad de 8 entradas de desborde: dos lotes con las 12 sustancias la agotan.
  const arena = arenaDe(memoriaDe(1, 2), 0), libro = libroVacio();
  const todas = Float64Array.from(sustancias.flatMap(({ id }) => [id, 10]));
  const [a, b, c] = [Rol.Tejido, Rol.Reserva, Rol.Digestivo].map(rol => arena.nuevo(rol, -1, 0));
  arena.fuente(a, todas, libro);
  arena.fuente(b, todas, libro);
  arena.fuente(c, todas.subarray(0, 16), libro);
  const antes = arena.saldo(), fuentes = libro.fuentes.slice(), enVuelo = libro.enVuelo.slice();
  const composicion = (l: LoteRef) => sustancias.map(({ id }) => arena.cuantos(l, id));
  const lotes = [a, b, c].map(composicion);
  assert.throws(() => arena.mover({ de: a, a: c, esp: 9, cuantos: 10 }));
  assert.throws(() => arena.fuente(c, Float64Array.of(9, 1), libro));
  assert.throws(() => arena.abonar(c, Float64Array.of(10, 1, 11, 1), libro));
  assert.deepEqual([a, b, c].map(composicion), lotes);
  assert.deepEqual(arena.saldo(), antes);
  assert.deepEqual(libro.fuentes, fuentes);
  assert.deepEqual(libro.enVuelo, enVuelo);
  // El desborde que suelta un lote vaciado vuelve en barrera, y entonces el traslado cabe.
  assert.equal(arena.moverParte(b, a, { parte: Parte.Todo, esp: 0, cuantos: 0, kappa: null }), 120);
  assert.throws(() => arena.mover({ de: a, a: c, esp: 9, cuantos: 10 }));
  arena.barrera();
  assert.equal(arena.mover({ de: a, a: c, esp: 9, cuantos: 20 }), 20);
  assert.equal(arena.cuantos(c, 9), 20);
  assert.deepEqual(arena.saldo(), antes);
});

if (isMainThread) test('una reacción balanceada recorta a existencias y conserva los átomos y la energía', () => {
  const arena = arenaDe(memoriaDe(1, 8), 0), libro = libroVacio();
  const lote = arena.nuevo(Rol.Agua, 0, 0);
  const [h2, hc, c2] = [sustancias[0], sustancias[1], sustancias[8]];
  arena.fuente(lote, Float64Array.of(h2.id, 6, c2.id, 10, 0, 500), libro);
  const antes = arena.saldo();
  const dH = 2 * hc.energia - h2.energia - c2.energia;
  const e = { entradas: [{ id: h2.id, nu: 1 }, { id: c2.id, nu: 1 }], salidas: [{ id: hc.id, nu: 2 }], dH };
  assert.throws(() => arena.aplicar(lote, { ...e, dH: dH + 1 }, 8));
  assert.throws(() => arena.aplicar(lote, { ...e, salidas: [] }, 8));
  assert.deepEqual(arena.saldo(), antes);
  assert.equal(arena.aplicar(lote, e, 8), 6);
  assert.equal(arena.cuantos(lote, h2.id), 0);
  assert.equal(arena.cuantos(lote, c2.id), 4);
  assert.equal(arena.cuantos(lote, hc.id), 12);
  assert.equal(arena.calor(lote), 500 - 6 * dH);
  assert.deepEqual(arena.saldo(), antes);
});

if (isMainThread) test('el punto de control restaura lotes, generaciones, depósitos y cuentas bigint', () => {
  const arena = arenaDe(memoriaDe(1, 16), 0), libro = libroVacio();
  const suelo = arena.nuevo(Rol.Suelo, 21, 0);
  const transportado = arena.nuevo(Rol.Objeto, -1, 827);
  const caducado = arena.nuevo(Rol.Pieza, 21, 10);
  arena.liberar(caducado);
  arena.barrera();
  arena.fuente(suelo, Float64Array.from([0, 1200, ...sustancias.flatMap(({ id }) => [id, 10])]), libro);
  arena.fuente(transportado, Float64Array.of(2, 101, 0, 123), libro);
  const garantia = arena.garantizarUna(557, transportado, { parte: Parte.Todo, esp: 0, cuantos: 0, kappa: null }, libro)!;
  const intento: Intento = {
    tipo: TipoIntento.Depositar, nonce: 557, de: REF_NULA, a: REF_NULA,
    celda: 21, lote: suelo, materia: garantia, dato: Float64Array.of(Rol.Suelo, 0), bytes: null,
  };
  const base = Array<bigint>(NE + 1).fill(0n);
  base[0] = 2n ** 85n + 51n;
  base[NE] = -(2n ** 87n) + 37n;
  const totales = plegarLibros([libro], { inicial: base, fuentes: saldo(cantidadesVacias()), sumideros: base.slice() });
  const vuelo = sumarEnVuelo([libro]);
  comprobarConservacion(totales, arena.saldo(), vuelo);
  const epoca = 17;
  const checkpoint = {
    epoca, tick: 2400, sustancias: Uint8Array.of(3, 2, 1), registro: Uint8Array.of(9, 8, 7),
    paginas: codificarPaginas(epoca, arena.muestras(), arena.libres()),
    enVuelo: codificarEnVuelo([intento]), ...totales,
  };
  const bytes = codificarCheckpoint(checkpoint);
  const leido = decodificarCheckpoint(bytes, (id, registro) => {
    assert.deepEqual(registro, checkpoint.sustancias);
    return quimica.sustancia(id);
  });
  assert.deepEqual(leido, checkpoint);
  const pendientes = decodificarEnVuelo(leido.enVuelo);
  assert.deepEqual(pendientes, [intento]);
  const { lotes, libres } = decodificarPaginas(leido.epoca, leido.paginas);
  const restaurada = arenaDe(memoriaDe(1, 16), 0);
  restaurada.cargar(lotes, libres);
  assert.deepEqual([...restaurada.muestras()], [...arena.muestras()]);
  assert.deepEqual(restaurada.saldo(), arena.saldo());
  assert.ok(!restaurada.vivo(caducado));
  const nuevo = restaurada.nuevo(Rol.Pieza, 21, 0);
  assert.equal(slotDe(nuevo), slotDe(caducado));
  assert.notEqual(nuevo, caducado);
  assert.ok(!restaurada.vivo(caducado));
  const libroRestaurado = libroVacio();
  const vueloGuardado = saldoEnVuelo(leido.enVuelo, quimica.sustancia);
  assert.deepEqual(vueloGuardado, vuelo);
  libroRestaurado.enVuelo.set(vueloGuardado.map(Number));
  assert.ok(restaurada.abonarUna(pendientes[0].nonce, suelo, pendientes[0].materia!, libroRestaurado));
  assert.equal(restaurada.cuantos(suelo, 2), 111);
  comprobarConservacion(leido, restaurada.saldo(), sumarEnVuelo([libroRestaurado]));

  const malSellada = leido.paginas.slice();
  new DataView(malSellada.buffer).setFloat64(24, epoca - 1, true);
  assert.throws(() => codificarCheckpoint({ ...leido, paginas: malSellada }), /[Ss]ello de época/);
  assert.throws(() => decodificarCheckpoint(bytes.subarray(0, -1), quimica.sustancia), /truncado/);
  assert.throws(() => codificarEnVuelo([intento, intento]), /[Nn]once/);
  const sinDeposito = codificarCheckpoint({ ...checkpoint, enVuelo: codificarEnVuelo([]) });
  assert.throws(() => decodificarCheckpoint(sinDeposito, quimica.sustancia), /No se conserva/);
  const otraVersion = bytes.slice();
  new DataView(otraVersion.buffer).setUint32(4, 2, true);
  assert.throws(() => decodificarCheckpoint(otraVersion, quimica.sustancia), /desconocido/);
});

if (isMainThread) test('el punto de control detecta la corrupción de cualquier bit', () => {
  const arena = arenaDe(memoriaDe(1, 8), 0), libro = libroVacio();
  const suelo = arena.nuevo(Rol.Suelo, 3, 7);
  arena.fuente(suelo, Float64Array.of(1, 10, 2, 4, 0, 5), libro);
  const garantia = arena.garantizar(suelo, { parte: Parte.Exacta, esp: 2, cuantos: 1, kappa: null }, libro);
  const intento: Intento = {
    tipo: TipoIntento.Dar, nonce: 4, de: 1, a: 2, celda: 3, lote: REF_NULA, materia: garantia,
    dato: Float64Array.of(Rol.Suelo, 0), bytes: Uint8Array.of(1, 2),
  };
  const cero = saldo(cantidadesVacias());
  const bytes = codificarCheckpoint({
    epoca: 2, tick: 9, sustancias: Uint8Array.of(1, 2, 3), registro: Uint8Array.of(4),
    paginas: codificarPaginas(2, arena.muestras(), arena.libres()), enVuelo: codificarEnVuelo([intento]),
    ...plegarLibros([libro], { inicial: cero, fuentes: cero, sumideros: cero }),
  });
  decodificarCheckpoint(bytes, quimica.sustancia);
  let aceptados = 0;
  for (let i = 0; i < bytes.length; i++) for (let bit = 0; bit < 8; bit++) {
    const corrupto = bytes.slice();
    corrupto[i] ^= 1 << bit;
    try {
      decodificarCheckpoint(corrupto, quimica.sustancia);
      aceptados++;
    } catch { /* detectada */ }
  }
  assert.equal(aceptados, 0, `${aceptados} de ${bytes.length * 8} bits cambiados pasaron por buenos`);
});

if (isMainThread) test('el índice VMAT conserva el orden de ranuras y de reutilización con las páginas intercaladas', () => {
  const genMax = genDe(Number.MAX_SAFE_INTEGER);
  const lotes = [
    { ref: refDe(2, 7), celda: 5, rol: Rol.Pieza, forma: 23, dueno: 0, pares: Float64Array.of(0, 17, 1, 3) },
    { ref: refDe(3, 4), celda: 256, rol: Rol.Aire, forma: 0, dueno: 1, pares: Float64Array.of(0, 0, 1, 2) },
    { ref: refDe(0, 1), celda: 5, rol: Rol.Pieza, forma: 13, dueno: 0,
      pares: Float64Array.from([0, 358, ...sustancias.flatMap(({ id }) => [id, id === 2 ? 0 : 1])]) },
    { ref: refDe(6, 9), celda: REF_NULA, rol: Rol.Objeto, forma: 53, dueno: 1, pares: new Float64Array() },
  ];
  const libres = [refDe(5, 3), refDe(4, genMax), refDe(1, 17)];
  const bytes = codificarPaginas(1, lotes, libres);
  let desborde = 0;
  const visitas: number[] = [];
  const indice = indexarPaginas(1, bytes, (lote, especies) => {
    visitas.push(slotDe(lote.ref));
    desborde += desbordeDeEspecies(especies);
  });
  assert.deepEqual(visitas, [2, 0, 3, 6]);
  assert.equal(desborde, ranurasDesborde(lotes));
  assert.equal(indice.ranuras, lotes.length + libres.length);
  assert.equal(indice.leer(indice.ranuras), undefined);
  assert.deepEqual(indice.leer(1), libres[2]);

  const porArray = arenaDe(memoriaDe(2, 7), 0), porIndice = arenaDe(memoriaDe(2, 7), 0);
  porArray.cargar(lotes, libres);
  porIndice.cargarPorRanura(indice.ranuras, indice.leer);
  assert.deepEqual([...porIndice.muestras()], [...porArray.muestras()]);
  assert.deepEqual([...porIndice.libres()], [...porArray.libres()]);
  assert.deepEqual(porIndice.saldo(), porArray.saldo());
  assert.equal(porIndice.propio(lotes[3].ref), false);
  const enCelda = new Float64Array(2);
  assert.equal(porIndice.lotes(5, Rol.Pieza, enCelda), 2);
  assert.deepEqual(Array.from(enCelda), [lotes[0].ref, lotes[2].ref]);
  assert.deepEqual(codificarPaginas(1, porIndice.muestras(), porIndice.libres()),
    codificarPaginas(1, porArray.muestras(), porArray.libres()));
  for (const ref of [refDe(5, 4), refDe(1, 18), refDe(7, 0)]) {
    assert.equal(porIndice.nuevo(Rol.Pieza, 5, 0), ref);
    assert.equal(porArray.nuevo(Rol.Pieza, 5, 0), ref);
  }

  const corrupto = bytes.slice();
  const vista = new DataView(corrupto.buffer);
  const primerLote = 40;
  for (const ranura of [0, 7, 0xffff_fffe]) {
    vista.setFloat64(primerLote, ranura, true);
    assert.throws(() => indexarPaginas(1, corrupto), /Ranura de materia duplicada|Ranuras de materia no consecutivas/);
  }
  assert.throws(() => indexarPaginas(1, bytes.subarray(0, bytes.length - 1)), /truncado/);
});

if (isMainThread) test('el registro comprueba el balance global a los 2.400 ticks, incluso con asientos sin plegar', async () => {
  const { registrar, comprobarInvariantes } = await import('../src/world/invariantes.js');
  const arena = arenaDe(memoriaDe(1, 4), 0), libro = libroVacio();
  const lote = arena.nuevo(Rol.Suelo, 0, 0);
  const cero = saldo(cantidadesVacias());
  const totales = { inicial: cero, fuentes: cero, sumideros: cero };
  const retirar = registrarConservacion(registrar, () => ({ totales, lotes: arena.saldo(), libros: [libro] }));
  const comprobar = (tick: number) => comprobarInvariantes({ tick } as World, { ids: ['materia.conservacion'], cadencia: true });
  try {
    arena.fuente(lote, Float64Array.of(1, 8, 0, 80), libro);
    assert.deepEqual(comprobar(2400), []);
    libro.fuentes[NE]++;
    assert.deepEqual(comprobar(2399), []);
    const [fallo] = comprobar(2400);
    assert.equal(fallo.id, 'materia.conservacion');
    assert.equal(fallo.gravedad, 'dura');
    assert.equal(fallo.contexto?.magnitud, 'energía');
    assert.equal(BigInt(fallo.contexto?.esperado as string) - BigInt(fallo.contexto?.observado as string), 1n);
  } finally {
    retirar();
  }
});
