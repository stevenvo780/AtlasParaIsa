import assert from 'node:assert/strict';
import test from 'node:test';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import { Store } from '../src/server/store.js';
import { escalon } from '../src/shared/interruptores.js';
import { extraerDeAnimal } from '../src/world/actuar/caza.js';
import { pruneBonds } from '../src/world/lineage.js';
import { codificarEnVuelo, decodificarEnVuelo } from '../src/world/materia/checkpoint.js';
import { celdaDeMuerte, morir } from '../src/world/materia/cuerpo.js';
import { lotesDeCelda, sustanciasDe } from '../src/world/materia/ley-mundo.js';
import { Parte, Rol } from '../src/world/materia/tipos.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { repartirPorTramos } from '../src/world/motor/bloques.js';
import { duenoSi } from '../src/world/motor/contexto.js';
import { REF_NULA, TipoIntento, slotDe, unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { createWorld } from '../src/world/mundo/crear.js';
import type { Person, World } from '../src/world/mundo/tipos.js';
import { parseParams } from '../src/world/params.js';

const SEMILLA = 7;
const params = parseParams({ v23: escalon('duenos') }, hostOpenWorldParams());

function retirar(mundo: World, persona: Person): void {
  const d = duenoSi(mundo)!;
  const c = ctxMateriaDe(mundo);
  morir(c, persona.cuerpo!, celdaDeMuerte(c, persona.x, persona.y));
  mundo.people = mundo.people.filter(p => p !== persona);
  pruneBonds(mundo.people, [persona]);
  d.publicarFilas();
  d.organismos.tabla.publicar(mundo.tick);
}

function saldar(mundo: World): void {
  const d = duenoSi(mundo)!;
  d.fase(1);
  d.aplicar('B');
  assert.equal(d.pendientes().filter(i => i.materia?.length).length, 0);
  const saldo = d.balanceMateria();
  assert.deepEqual(saldo.hallado, saldo.esperado);
}

test('guardado nuevo reencamina por UID, preserva los depósitos y no repite una entrega', async t => {
  const mundo = createWorld(SEMILLA, params);
  const store = new Store(':memory:');
  const motor = crearMotor(mundo, unSoloDueno(SEMILLA));
  t.after(async () => { await motor.cerrar(); store.close(); });
  motor.cargar({ world: mundo, materia: null }, 0);
  const [baja, receptor, ocupante, donante, difunto] = mundo.people.filter(p => p.role === 'neighbor');
  assert.ok(baja && receptor?.uid && ocupante?.uid && donante?.uid && difunto?.uid);
  const d = duenoSi(mundo)!, c = ctxMateriaDe(mundo);
  const refVieja = d.ref(receptor.uid);
  retirar(mundo, baja);

  const { H2O } = sustanciasDe(c);
  const garantizar = (cuantos: number): Float64Array => {
    const garantia = c.materia.garantizar(donante.cuerpo!.reserva, { parte: Parte.Exacta, esp: H2O, cuantos, kappa: null }, c.libro);
    assert.equal(garantia[1], cuantos);
    return garantia;
  };
  d.fase(5);
  for (const persona of [receptor, difunto]) {
    c.buzon.enviar(0, { tipo: TipoIntento.Dar, a: d.ref(persona.uid!), de: d.ref(donante.uid),
      celda: c.terreno.celda(persona.x, persona.y), lote: REF_NULA, nonce: c.id('nonce'),
      materia: garantizar(12), dato: Float64Array.of(Rol.Digestivo, 0), bytes: null });
  }
  c.buzon.enviar(0, { tipo: TipoIntento.Depositar, a: REF_NULA, de: REF_NULA,
    celda: c.terreno.celda(donante.x, donante.y), lote: REF_NULA, nonce: c.id('nonce'),
    materia: garantizar(15), dato: Float64Array.of(Rol.Objeto, 29), bytes: null });
  retirar(mundo, difunto);
  const corte = motor.instantanea();
  assert.ok(corte.materia);
  const enVuelo = decodificarEnVuelo(corte.materia.enVuelo);
  assert.deepEqual(enVuelo.map(i => i.uidDestino), [receptor.uid, 0, REF_NULA]);
  assert.ok(enVuelo.every(i => i.a === REF_NULA && i.de === REF_NULA));
  assert.throws(() => codificarEnVuelo([{ ...enVuelo[0]!, uidDestino: 2 ** 53 }]), /Entero inválido/);
  assert.throws(() => codificarEnVuelo([enVuelo[0]!, enVuelo[0]!]), /Nonce de garantía duplicado/);
  store.guardar(corte);

  const abrir = (): World => {
    const copia = store.cargarInstantanea();
    assert.ok(copia);
    motor.cargar(copia.instantanea, copia.epoca);
    return copia.instantanea.world;
  };
  const primera = abrir();
  assert.equal(duenoSi(primera)!.ref(ocupante.uid), refVieja, 'la ranura anterior pertenece ahora a otro UID');
  store.guardar(motor.instantanea());
  const segunda = abrir(), c2 = ctxMateriaDe(segunda);
  const receptor2 = segunda.people.find(p => p.uid === receptor.uid)!;
  const ocupante2 = segunda.people.find(p => p.uid === ocupante.uid)!;
  const leer = (p: Person) => c2.materia.cuantos(p.cuerpo!.digestivo, H2O);
  const receptorAntes = leer(receptor2), ocupanteAntes = leer(ocupante2);
  const { suelo } = lotesDeCelda(c2, c2.terreno.celda(difunto.x, difunto.y), { suelo: REF_NULA, agua: REF_NULA, vida: REF_NULA, aire: REF_NULA });
  const enSuelo = c2.materia.cuantos(suelo, H2O);
  saldar(segunda);
  assert.equal(leer(receptor2), receptorAntes + 12);
  assert.equal(leer(ocupante2), ocupanteAntes);
  assert.equal(c2.materia.cuantos(suelo, H2O), enSuelo + 12);
  const objetos = new Float64Array(16);
  const n = c2.materia.lotes(c2.terreno.celda(donante.x, donante.y), Rol.Objeto, objetos);
  const objeto = objetos.subarray(0, n).find(lote => c2.materia.vista(lote).forma === 29);
  assert.ok(objeto !== undefined);
  assert.equal(c2.materia.cuantos(objeto, H2O), 15);
  saldar(segunda);
  assert.equal(leer(receptor2), receptorAntes + 12);
  assert.equal(c2.materia.cuantos(suelo, H2O), enSuelo + 12);
  assert.equal(c2.materia.cuantos(objeto, H2O), 15);
});

test('una esquila en vuelo de VMAT v1 vuelve al lote vivo de su único portador', async t => {
  const mundo = createWorld(SEMILLA, params), store = new Store(':memory:');
  const motor = crearMotor(mundo, unSoloDueno(SEMILLA));
  t.after(async () => { await motor.cerrar(); store.close(); });
  motor.cargar({ world: mundo, materia: null }, 0);
  motor.paso([]);
  const d = duenoSi(mundo)!, c = ctxMateriaDe(mundo);
  const [baja] = mundo.people.filter(p => p.role === 'neighbor');
  const extractor = mundo.people.at(-1), animal = mundo.animals[0];
  assert.ok(baja && extractor?.uid && animal?.uid && animal.fauna);
  retirar(mundo, baja);

  animal.fauna.miedo = animal.fauna.sobresalto = 0;
  d.fase(4);
  const lote = extraerDeAnimal(c, extractor, d.ref(animal.uid), 'fibra');
  assert.notEqual(lote, REF_NULA);
  d.fase(5);
  d.aplicar('A');
  const entrega = d.pendientes().find(i => i.tipo === TipoIntento.Concedido && i.lote === lote);
  assert.ok(entrega?.materia?.length);
  const [esp, cuantos] = entrega.materia;
  assert.ok(cuantos! > 0);

  const corte = motor.instantanea();
  assert.ok(corte.materia);
  const [durable] = decodificarEnVuelo(corte.materia.enVuelo);
  assert.equal(durable?.nonce, entrega.nonce);
  const enVuelo = codificarEnVuelo([{ ...entrega, celda: durable!.celda }]);
  assert.equal(decodificarEnVuelo(enVuelo)[0]?.uidDestino, undefined);
  store.guardar({ world: corte.world, materia: { ...corte.materia, enVuelo } });

  const copia = store.cargarInstantanea();
  assert.ok(copia);
  motor.cargar(copia.instantanea, copia.epoca);
  const restaurado = copia.instantanea.world, c2 = ctxMateriaDe(restaurado);
  assert.notEqual(duenoSi(restaurado)!.ref(extractor.uid), entrega.a);
  assert.ok(restaurado.people.find(p => p.uid === extractor.uid)?.carga?.includes(lote));
  assert.equal(c2.materia.cuantos(lote, esp!), 0);
  saldar(restaurado);
  assert.equal(c2.materia.cuantos(lote, esp!), cuantos);
});

test('una garantía v1 sin lote de un portador cae en la celda guardada aunque el Ref coincida', async t => {
  const mundo = createWorld(SEMILLA, params), store = new Store(':memory:');
  const motor = crearMotor(mundo, unSoloDueno(SEMILLA));
  t.after(async () => { await motor.cerrar(); store.close(); });
  motor.cargar({ world: mundo, materia: null }, 0);
  const [baja, receptor, ocupante] = mundo.people.filter(p => p.role === 'neighbor');
  assert.ok(baja && receptor?.uid && ocupante?.uid && ocupante.cuerpo);
  const d = duenoSi(mundo)!, c = ctxMateriaDe(mundo), refVieja = d.ref(receptor.uid);
  retirar(mundo, baja);
  const { H2O } = sustanciasDe(c);
  d.fase(5);
  c.buzon.enviar(0, { tipo: TipoIntento.Dar, a: refVieja, de: d.ref(ocupante.uid), celda: c.terreno.celda(receptor.x, receptor.y),
    lote: REF_NULA, nonce: d.id('nonce'), dato: Float64Array.of(Rol.Digestivo, 0), bytes: null,
    materia: c.materia.garantizar(ocupante.cuerpo.reserva, { parte: Parte.Exacta, esp: H2O, cuantos: 19, kappa: null }, c.libro) });
  const corte = motor.instantanea();
  assert.ok(corte.materia);
  const [durable] = decodificarEnVuelo(corte.materia.enVuelo);
  const enVuelo = codificarEnVuelo([{ ...d.pendientes()[0]!, celda: durable!.celda }]);
  store.guardar({ world: corte.world, materia: { ...corte.materia, enVuelo } });

  const guardado = store.cargarInstantanea();
  assert.ok(guardado);
  motor.cargar(guardado.instantanea, guardado.epoca);
  const restaurado = guardado.instantanea.world, c2 = ctxMateriaDe(restaurado);
  assert.equal(duenoSi(restaurado)!.ref(ocupante.uid), refVieja);
  const { suelo } = lotesDeCelda(c2, c2.terreno.celda(receptor.x, receptor.y), { suelo: REF_NULA, agua: REF_NULA, vida: REF_NULA, aire: REF_NULA });
  const aguaSuelo = c2.materia.cuantos(suelo, H2O), aguaOcupante = c2.materia.cuantos(ocupante.cuerpo.digestivo, H2O);
  saldar(restaurado);
  assert.equal(c2.materia.cuantos(suelo, H2O), aguaSuelo + 19);
  assert.equal(c2.materia.cuantos(ocupante.cuerpo.digestivo, H2O), aguaOcupante);
});

test('varios dueños restauran un destino fauna en el frente inicial y liquidan la garantía', async t => {
  const mundo = createWorld(SEMILLA, params), store = new Store(':memory:');
  const simple = crearMotor(mundo, unSoloDueno(SEMILLA));
  const repartido = crearMotor(mundo, { ...unSoloDueno(SEMILLA), hilos: 2, indiceUidCompartido: true, instantaneaTransferible: true });
  t.after(async () => { await repartido.cerrar(); await simple.cerrar(); store.close(); });
  simple.cargar({ world: mundo, materia: null }, 0);
  const d = duenoSi(mundo)!, c = ctxMateriaDe(mundo);
  const chunks = Object.values(mundo.chunks);
  const reparto = repartirPorTramos(Int32Array.from(chunks, p => p.cx), Int32Array.from(chunks, p => p.cy), 2);
  const animal = mundo.animals.find(a => reparto[chunks.findIndex(p => p.cx === (a.x >> 4) && p.cy === (a.y >> 4))] === 1);
  assert.ok(animal?.uid && animal.cuerpo);
  d.publicarFilas();
  d.gancho('F6');
  d.organismos.tabla.publicar(mundo.tick);
  assert.notEqual(d.ref(animal.uid), REF_NULA);
  const celda = c.terreno.celda(animal.x, animal.y);
  const { SiO2 } = sustanciasDe(c);
  const grava = c.materia.nuevo(Rol.Objeto, celda, 29);
  c.materia.fuente(grava, Float64Array.of(SiO2, 9500), c.libro);
  const materia = c.materia.garantizar(grava, { parte: Parte.Todo, esp: 0, cuantos: 0, kappa: null }, c.libro);
  d.fase(5);
  d.buzon.enviar(0, { tipo: TipoIntento.Dar, a: d.ref(animal.uid), de: REF_NULA, celda, lote: REF_NULA,
    nonce: d.id('nonce'), materia, dato: Float64Array.of(Rol.Digestivo, 0), bytes: null });
  const corte = simple.instantanea();
  assert.ok(corte.materia);
  const [enVuelo] = decodificarEnVuelo(corte.materia.enVuelo);
  assert.equal(enVuelo?.uidDestino, animal.uid);
  store.guardar(corte);

  const copia = store.cargarInstantanea();
  assert.ok(copia);
  repartido.cargar(copia.instantanea, copia.epoca);
  const origen = duenoSi(copia.instantanea.world)!;
  const actualRef = origen.ref(animal.uid);
  assert.notEqual(actualRef, REF_NULA);
  assert.equal(origen.frente.dueno[slotDe(actualRef)], 1);
  assert.equal(origen.pendientes().find(i => i.materia?.length)?.a, actualRef);
  repartido.paso([]);
  assert.equal(origen.pendientes().filter(i => i.nonce === enVuelo.nonce).length, 0);
  const saldo = origen.balanceMateria();
  assert.deepEqual(saldo.hallado, saldo.esperado);
  const carne = repartido.instantanea().world.animals.find(a => a.uid === animal.uid);
  assert.ok(carne?.cuerpo && ctxMateriaDe(copia.instantanea.world).materia.cuantos(carne.cuerpo.digestivo, SiO2) > 0);
});
