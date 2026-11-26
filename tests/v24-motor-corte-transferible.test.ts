import assert from 'node:assert/strict';
import test from 'node:test';
import { deserialize, serialize } from 'node:v8';
import { Store } from '../src/server/store.js';
import { stringifyExact } from '../src/shared/exact-json.js';
import { escalon } from '../src/shared/interruptores.js';
import { materializeAnimals, type Animal } from '../src/world/animals.js';
import { enableChronicleJournal } from '../src/world/chronicle-journal.js';
import { demographicTraits } from '../src/world/demography.js';
import { codificarCheckpoint } from '../src/world/materia/checkpoint.js';
import { repartirPorTramos } from '../src/world/motor/bloques.js';
import { Buzones } from '../src/world/motor/buzon.js';
import { AVISO, duenoSi } from '../src/world/motor/contexto.js';
import { unSoloDueno, type Instantanea } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { faunaCorteDe } from '../src/world/motor/fauna-corte.js';
import { CanalesCorte, enviarParteCorte } from '../src/world/motor/mensajes-corte.js';
import { createWorld } from '../src/world/mundo/crear.js';
import type { World } from '../src/world/mundo/tipos.js';
import { Piscina } from '../src/world/paralelo/piscina.js';
import { DEFAULT_PARAMS, parseParams } from '../src/world/params.js';
import { TablaOrganismosSoA } from '../src/world/soa/organismos.js';
import { activate } from '../src/world/spatial.js';
import { enableTechnologyCatalogue } from '../src/world/technology-catalogue.js';
import { enableTechnologyJournal } from '../src/world/technology-journal.js';
import { generateChunk } from '../src/world/terrain.js';
import { filaInstantanea, sha256 } from './lib/store.js';

const semilla = 7, hilos = 2;
const config = { ...unSoloDueno(semilla), hilos, verificar: false };
const parametros = parseParams({ ...DEFAULT_PARAMS, v23: escalon('duenos'), motor: { hilos },
  conducta: { ...DEFAULT_PARAMS.conducta, politicaPeso: 0.8 } });

test('los mensajes llegan por dueño con los campos del corte y conservan los pesos exactos', () => {
  const canales = CanalesCorte.abrir(2);
  assert.ok(canales);
  try {
    const partes = [createWorld(7, parametros), createWorld(11, parametros)] as const;
    for (const [i, parte] of partes.entries()) {
      parte.tick = 6;
      parte.people[0]!.policy!.weights.splice(0, 2, -0, Math.PI + i);
      parte.retiredChunks.push(generateChunk(parte.seed, 4, 4));
      enableChronicleJournal(parte);
      enableTechnologyJournal(parte.technology);
      enableTechnologyCatalogue(parte.technology);
    }
    const solicitud = canales.pedir();
    enviarParteCorte(canales.puertosRemotos[1]!, canales.solicitud, 3, 2, partes[1]);
    enviarParteCorte(canales.puertosRemotos[0]!, canales.solicitud, 3, 1, partes[0]);
    const recibidas = canales.recibir(solicitud, 3, 6);
    assert.equal(recibidas.length, partes.length);
    for (const [i, parte] of recibidas.entries()) {
      const original = partes[i]!;
      for (const campo of ['communities', 'events', 'history', 'chronicleJournal', 'seed', 'rng']) {
        assert.equal(Object.hasOwn(parte, campo), false, campo);
      }
      const { checkpoint, ...tecnologia } = original.technology;
      assert.ok(checkpoint);
      assert.deepEqual(parte.technology, tecnologia);
      assert.deepEqual(parte.people, original.people);
      assert.deepEqual(parte.retiredChunks, original.retiredChunks);
      assert.ok(serialize(parte).byteLength < serialize(original).byteLength);
    }
    assert.throws(() => canales.recibir(solicitud, 3, 6), /incompleta.*dueño 1/);
  } finally { canales.cerrar(); }
});

test('un dueño transfiere filas exactas de fauna solo en los cortes solicitados', () => {
  const canales = CanalesCorte.abrir(1);
  assert.ok(canales);
  try {
    const mundo = createWorld(semilla, parametros);
    const [animal] = materializeAnimals(mundo.seed, [{ ...mundo.tiles[0]!, fauna: 1, species: 'hare' }], mundo.tick);
    assert.ok(animal);
    const pequena = { ...animal, reason: 'Río 🐇\nRefugio', work: -0 };
    const grande = { ...animal, id: 'grande', reason: '🐇'.repeat(1024 * 1024) };
    mundo.animals = [pequena, grande, { ...pequena, id: 'final' }];
    const recibir = (conFauna: boolean) => {
      const solicitud = canales.pedir(conFauna);
      enviarParteCorte(canales.puertosRemotos[0]!, canales.solicitud, 3, 1, mundo);
      return canales.recibir(solicitud, 3, mundo.tick)[0]!.animals;
    };
    const animales = recibir(true);
    const tramos = faunaCorteDe(animales);
    assert.equal(tramos?.length, 1);
    const { desde, bloques } = tramos![0]!;
    assert.equal(desde, 0);
    assert.deepEqual(bloques.map(b => b.filas), [1, 1, 1]);
    const utf8 = new TextDecoder();
    for (const [i, bloque] of bloques.entries()) {
      const fila = utf8.decode(bloque.cuerpo);
      assert.equal(fila === stringifyExact(animales[i]), true);
      assert.equal(fila.includes('\n'), false);
      assert.equal(bloque.cuerpo.buffer.byteLength, bloque.cuerpo.byteLength);
    }
    assert.ok(bloques[1]!.cuerpo.byteLength > 4 * 1024 * 1024);
    assert.ok(Object.is(JSON.parse(utf8.decode(bloques[0]!.cuerpo)).work, -0));
    assert.equal(faunaCorteDe(recibir(false)), undefined);

    const bytes = serialize({ tick: mundo.tick, animals: [animal] });
    for (const fauna of [undefined, [{ filas: 1, cuerpo: 'inválido' }], [{ filas: 2, cuerpo: bloques[0]!.cuerpo }]]) {
      const solicitud = canales.pedir(true);
      canales.puertosRemotos[0]!.postMessage({ solicitud, epoca: 3, tick: mundo.tick, dueno: 1, bytes, fauna });
      const canonicos: Animal[] = canales.recibir(solicitud, 3, mundo.tick)[0]!.animals;
      assert.deepEqual(canonicos, [animal]);
      assert.equal(faunaCorteDe(canonicos), undefined);
    }
  } finally { canales.cerrar(); }
});

test('un mensaje duplicado, tardío, ajeno o con bytes incoherentes invalida el corte', () => {
  const datos = { solicitud: 1n, epoca: 3, tick: 6, dueno: 1, bytes: serialize({ tick: 6 }) };
  for (const cambios of [{}, { solicitud: 0n }, { epoca: 2 }, { tick: 7 }, { dueno: 2 },
    { bytes: new Uint8Array() }, { bytes: serialize({ tick: 7 }) }]) {
    const canales = CanalesCorte.abrir(1);
    assert.ok(canales);
    try {
      const solicitud = canales.pedir();
      const puerto = canales.puertosRemotos[0]!;
      puerto.postMessage({ ...datos, ...cambios });
      if (Object.keys(cambios).length === 0) puerto.postMessage(datos);
      assert.throws(() => canales.recibir(solicitud, 3, 6), /incoherente|no pertenece al tick/);
    } finally { canales.cerrar(); }
  }
});

test('el motor conserva el mundo, el orden y VMAT al cortar y reabrir otra época', async t => {
  let f0: NonNullable<Buzones['memoria']>['f0'] | undefined;
  const dueno = Buzones.prototype.dueno;
  t.mock.method(Buzones.prototype, 'dueno', function (this: Buzones, hilo: number, azar: () => number) {
    if (hilo === 0) f0 = this.memoria!.f0;
    return dueno.call(this, hilo, azar);
  });
  const recibir = t.mock.method(CanalesCorte.prototype, 'recibir');
  const vivo = createWorld(semilla, parametros);
  const paginas = Object.values(vivo.chunks);
  const reparto = repartirPorTramos(paginas.map(p => p.cx), paginas.map(p => p.cy), hilos);
  for (const [hilo, persona] of vivo.people.slice(0, hilos).entries()) {
    const tile = vivo.tiles.find(t => t.terrain !== 'water' && (t.x & 15) > 1 && (t.x & 15) < 14 && (t.y & 15) > 1 && (t.y & 15) < 14 &&
      paginas.some((p, i) => reparto[i] === hilo && p.cx === t.x >> 4 && p.cy === t.y >> 4));
    assert.ok(tile);
    persona.x = tile.x; persona.y = tile.y; persona.target = { x: tile.x, y: tile.y };
  }
  const motor = crearMotor(vivo, { ...config, instantaneaTransferible: true, faunaCortePreparada: true });
  const store = new Store(':memory:', { snapshotPackedPeople: true, snapshotMatterPartBytes: 4096 });
  try {
    assert.equal(motor.vista().tick, 0);
    assert.equal(recibir.mock.callCount(), 0);
    assert.equal(motor.paso([]).tick, 1);
    const capacidad = f0!.datos.byteLength;
    const vista = motor.vista();
    const corte = motor.instantanea();
    assert.equal(recibir.mock.callCount(), 2);
    assert.equal(f0!.datos.byteLength, capacidad);
    assert.deepEqual(corte.world.people, vista.people);
    assert.deepEqual(corte.world.animals, vista.animals);
    assert.equal(faunaCorteDe(corte.world.animals), undefined);
    const [parte] = recibir.mock.calls.at(-1)!.result!;
    assert.ok(parte?.tiles.length && parte.people.length && vivo.people.length);
    for (const campo of ['tiles', 'people', 'animals', 'structures'] as const) {
      assert.notEqual(corte.world[campo], vivo[campo]);
      assert.notEqual(corte.world[campo], parte[campo]);
      const locales = vivo[campo].length;
      if (locales) assert.notEqual(corte.world[campo][0], vivo[campo][0]);
      parte[campo].forEach((fila, i) => assert.equal(corte.world[campo][locales + i], fila));
    }
    assert.notEqual(corte.world.people[0]!.genome.alleles, vivo.people[0]!.genome.alleles);
    assert.ok(corte.world.people.every(p => Number.isSafeInteger(p.uid)));
    assert.ok(corte.materia);
    const vmat = codificarCheckpoint(corte.materia);
    const preparado = motor.instantanea(true);
    assert.deepEqual(preparado.world.animals, corte.world.animals);
    const [tramo] = faunaCorteDe(preparado.world.animals) ?? [];
    assert.ok(tramo && parte.animals.length && vivo.animals.length);
    assert.equal(tramo.desde, vivo.animals.length);
    const filas = tramo.bloques.flatMap(b => new TextDecoder().decode(b.cuerpo).split('\n'));
    assert.equal(filas.length, parte.animals.length);
    assert.deepEqual(filas, parte.animals.map(a => stringifyExact(a)));
    store.guardar(preparado);
    const leido = store.cargarGuardadoCompleto();
    assert.ok(leido?.instantanea.materia);
    assert.deepEqual(codificarCheckpoint(leido.instantanea.materia), vmat);
    assert.ok(corte.world.people.every(p => p.policy?.weights.length === 212));
    assert.ok(stringifyExact(leido.instantanea.world.people) === stringifyExact(corte.world.people));
    assert.ok(stringifyExact(leido.instantanea.world.animals) === stringifyExact(corte.world.animals));
    motor.cargar(leido.instantanea, leido.epoca);
    const recargado = motor.instantanea();
    assert.equal(recargado.world.tick, 1);
    assert.equal(recargado.materia?.epoca, leido.epoca);
    assert.deepEqual(recibir.mock.calls.at(-1)?.arguments, [1n, leido.epoca, 1]);
    assert.equal(motor.paso([]).tick, 2);
  } finally { store.close(); await motor.cerrar(); }
});

test('el mismo corte guarda los mismos bytes con la parte F0 y con su proyección transferible', async () => {
  const mundo = createWorld(semilla, parametros);
  const claveRetirada = '4,4';
  activate(mundo, 66, 66);
  const paginas = Object.values(mundo.chunks);
  const reparto = repartirPorTramos(paginas.map(p => p.cx), paginas.map(p => p.cy), hilos);
  const tile = mundo.tiles.find(t => t.terrain !== 'water' && paginas.some((p, i) =>
    reparto[i] === 1 && p.key !== claveRetirada && p.cx === (t.x >> 4) && p.cy === (t.y >> 4)));
  const victima = mundo.people.find(p => p.role === 'neighbor');
  assert.ok(tile && victima);
  victima.x = tile.x; victima.y = tile.y; victima.target = { x: tile.x, y: tile.y };
  const edad = demographicTraits(victima.genome, parametros.cuerpo);
  victima.demography.age = Math.floor((edad.senescenceStart + edad.maximumAge) / 2);
  victima.bornAt = -victima.demography.age;
  victima.demography.health = Number.MIN_VALUE;
  enableChronicleJournal(mundo);
  enableTechnologyJournal(mundo.technology);
  enableTechnologyCatalogue(mundo.technology);
  const canales = CanalesCorte.abrir(hilos - 1);
  assert.ok(canales);
  const motor = crearMotor(mundo, config);
  const guardar = (corte: Instantanea) => {
    const store = new Store(':memory:', { snapshotPackedPeople: true, snapshotMatterPartBytes: 4096 });
    try {
      assert.ok(corte.world.retiredChunks.some(c => c.key === claveRetirada));
      assert.ok(corte.world.chronicleJournal?.pending.some(e => e.kind === 'death' && e.actors.includes(victima.id)));
      assert.ok(corte.materia);
      const vmat = sha256(codificarCheckpoint(corte.materia));
      store.guardar(corte);
      const legado = store.loadLegacy(victima.id);
      const chunk = store.loadChunk(claveRetirada, corte.world.tick, parametros.v23);
      assert.ok(legado && chunk);
      const cronica = store.db.prepare('SELECT * FROM events ORDER BY id').all();
      return {
        manifiesto: filaInstantanea(store).digest, vmat,
        archivo: sha256(stringifyExact({ legado, chunk, cronica })),
      };
    } finally { store.close(); }
  };
  try {
    for (let i = 0; i < 3; i++) motor.paso([]);
    const f0 = motor.instantanea();
    const coordinador = duenoSi(mundo);
    assert.ok(coordinador?.avisar);
    const avisar = coordinador.avisar;
    // Compara dos reuniones del mismo tick: dos corridas paralelas pueden numerar los sucesos de forma distinta.
    coordinador.avisar = (clase, intento) => {
      if (clase !== AVISO.parte) return avisar(clase, intento);
      const remota = deserialize(intento.bytes!) as World;
      const solicitud = canales.pedir();
      enviarParteCorte(canales.puertosRemotos[0]!, canales.solicitud, coordinador.epoca, 1, remota);
      const [parte] = canales.recibir(solicitud, coordinador.epoca, remota.tick);
      assert.ok(parte?.legacy.some(p => p.id === victima.id));
      assert.ok(parte.retiredLegacy.some(p => p.id === victima.id));
      avisar(clase, { ...intento, bytes: serialize(parte) });
    };
    const proyectada = motor.instantanea();
    assert.deepEqual(guardar(proyectada), guardar(f0));
  } finally {
    canales.cerrar();
    await motor.cerrar();
  }
});

test('la ruta F0 se elige si no se pide el canal o si no se puede abrir', async t => {
  const abrir = t.mock.method(CanalesCorte, 'abrir', () => undefined);
  for (const instantaneaTransferible of [undefined, true]) {
    const motor = crearMotor(createWorld(semilla, parametros), { ...config, instantaneaTransferible, faunaCortePreparada: true });
    try {
      motor.paso([]);
      const corte = motor.instantanea(true);
      assert.equal(corte.world.tick, 1);
      assert.ok(corte.world.people.length > 0 && corte.materia);
      assert.equal(faunaCorteDe(corte.world.animals), undefined);
    } finally { await motor.cerrar(); }
    assert.equal(abrir.mock.callCount(), instantaneaTransferible ? 1 : 0);
  }
});

test('un fallo tras el envío conserva el último corte durable y permite abrir desde él', async t => {
  const motor = crearMotor(createWorld(semilla, parametros), { ...config, instantaneaTransferible: true });
  const store = new Store(':memory:', { snapshotPackedPeople: true });
  try {
    motor.paso([]);
    store.guardar(motor.instantanea());
    const consultar = store.db.prepare('SELECT digest FROM snapshots WHERE slot=0');
    const durable = consultar.get();
    motor.paso([]);
    const recibir = CanalesCorte.prototype.recibir;
    const fallar = t.mock.method(CanalesCorte.prototype, 'recibir', function (this: CanalesCorte, solicitud: bigint, epoca: number, tick: number) {
      return recibir.call(this, solicitud, epoca + 1, tick);
    });
    assert.throws(() => store.guardar(motor.instantanea()), /Instantánea incompleta o incoherente/);
    assert.throws(() => motor.instantanea(), /Instantánea incompleta o incoherente/);
    assert.equal(fallar.mock.callCount(), 1);
    assert.deepEqual(consultar.get(), durable);
    fallar.mock.restore();
    const cargado = store.cargarGuardadoCompleto();
    assert.ok(cargado);
    motor.cargar(cargado.instantanea, cargado.epoca);
    assert.equal(motor.instantanea().world.tick, 1);
  } finally { store.close(); await motor.cerrar(); }
});

test('se cierran los canales si el constructor de la piscina falla', async t => {
  const abrir = CanalesCorte.abrir;
  t.mock.method(CanalesCorte, 'abrir', function (remotos: number) {
    const canal = abrir(remotos);
    assert.ok(canal);
    canal.puertosRemotos.push(canal.puertosRemotos[0]!);
    return canal;
  });
  const cerrar = t.mock.method(CanalesCorte.prototype, 'cerrar');
  const motor = crearMotor(createWorld(semilla, parametros), { ...config, instantaneaTransferible: true });
  try {
    assert.throws(() => motor.paso([]), /Falta un puerto por hilo remoto/);
    assert.equal(cerrar.mock.callCount(), 1);
  } finally { await motor.cerrar(); }
  assert.equal(cerrar.mock.callCount(), 1);
});

test('cerrar espera a la piscina retirada si falla la publicación durante la apertura', async t => {
  t.mock.method(TablaOrganismosSoA.prototype, 'publicar', () => { throw new Error('fallo de publicación en apertura'); });
  const canalesCerrados = t.mock.method(CanalesCorte.prototype, 'cerrar');
  const cerrar = Piscina.prototype.cerrar;
  let liberar!: () => void;
  const pausa = new Promise<void>(resolve => { liberar = resolve; });
  t.mock.method(Piscina.prototype, 'cerrar', async function (this: Piscina) {
    await cerrar.call(this);
    await pausa;
  });
  const motor = crearMotor(createWorld(semilla, parametros), { ...config, instantaneaTransferible: true });
  let terminado = false;
  let cierre: Promise<void> | undefined;
  try {
    assert.throws(() => motor.paso([]), /fallo de publicación en apertura/);
    assert.equal(canalesCerrados.mock.callCount(), 1);
    cierre = motor.cerrar().then(() => { terminado = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(terminado, false);
  } finally {
    liberar();
    await (cierre ?? motor.cerrar());
  }
  assert.equal(terminado, true);
});
