import assert from 'node:assert/strict';
import test from 'node:test';
import { serialize } from 'node:v8';
import { Store } from '../src/server/store.js';
import { stringifyExact } from '../src/shared/exact-json.js';
import { escalon } from '../src/shared/interruptores.js';
import { codificarCheckpoint } from '../src/world/materia/checkpoint.js';
import { repartirPorTramos } from '../src/world/motor/bloques.js';
import { Buzones } from '../src/world/motor/buzon.js';
import { unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { CanalesCorte, enviarParteCorte } from '../src/world/motor/mensajes-corte.js';
import { createWorld } from '../src/world/mundo/crear.js';
import type { World } from '../src/world/mundo/tipos.js';
import { Piscina } from '../src/world/paralelo/piscina.js';
import { DEFAULT_PARAMS, parseParams } from '../src/world/params.js';
import { TablaOrganismosSoA } from '../src/world/soa/organismos.js';

const semilla = 7, hilos = 2;
const config = { ...unSoloDueno(semilla), hilos, verificar: false };
const parametros = parseParams({ ...DEFAULT_PARAMS, v23: escalon('duenos'), motor: { hilos },
  conducta: { ...DEFAULT_PARAMS.conducta, politicaPeso: 0.8 } });

test('los mensajes se reciben por dueño y preservan el bloque V8', () => {
  const canales = CanalesCorte.abrir(2);
  assert.ok(canales);
  try {
    const partes = [
      { tick: 6, people: [{ uid: 50, policy: { weights: [-0, Math.PI] } }] },
      { tick: 6, people: [{ uid: 23, policy: { weights: [Math.PI, -0] } }] },
    ] as World[];
    const solicitud = canales.pedir();
    enviarParteCorte(canales.puertosRemotos[1]!, canales.solicitud, 3, 2, partes[1]!);
    enviarParteCorte(canales.puertosRemotos[0]!, canales.solicitud, 3, 1, partes[0]!);
    assert.deepEqual(canales.recibir(solicitud, 3, 6), partes);
    assert.throws(() => canales.recibir(solicitud, 3, 6), /incompleta.*dueño 1/);
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
  const motor = crearMotor(vivo, { ...config, instantaneaTransferible: true });
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
    store.guardar(corte);
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

test('la ruta F0 se elige si no se pide el canal o si no se puede abrir', async t => {
  const abrir = t.mock.method(CanalesCorte, 'abrir', () => undefined);
  for (const instantaneaTransferible of [undefined, true]) {
    const motor = crearMotor(createWorld(semilla, parametros), { ...config, instantaneaTransferible });
    try {
      motor.paso([]);
      const corte = motor.instantanea();
      assert.equal(corte.world.tick, 1);
      assert.ok(corte.world.people.length > 0 && corte.materia);
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
