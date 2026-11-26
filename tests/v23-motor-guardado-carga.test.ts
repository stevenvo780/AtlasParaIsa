import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/server/store.js';
import { escalon } from '../src/shared/interruptores.js';
import { KG_POR_UNIDAD_MATERIAL } from '../src/shared/naturaleza.js';
import { vistaMateriales } from '../src/world/actuar/recursos.js';
import { cloneWorld } from '../src/world/clon.js';
import { codificarEnVuelo, decodificarEnVuelo } from '../src/world/materia/checkpoint.js';
import { cargaKg } from '../src/world/materia/cuerpo.js';
import { conservacion, sustanciasDe } from '../src/world/materia/ley-mundo.js';
import { Parte, Rol } from '../src/world/materia/tipos.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { duenoDe, duenoSi } from '../src/world/motor/contexto.js';
import { REF_NULA, TipoIntento, genDe, refDe, slotDe, unSoloDueno, type Intento } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { assertWorld } from '../src/world/mundo/validar.js';
import { parseParams } from '../src/world/params.js';

test('el guardado completo repone los lotes a cuestas por encima del tope escalar', prueba => {
  const mundo = createWorld(7, parseParams({ v23: escalon('obra') }));
  const motor = crearMotor(mundo, unSoloDueno(7)), store = new Store(':memory:');
  prueba.after(async () => { store.close(); await motor.cerrar(); });
  motor.cargar({ world: mundo, materia: null }, 0);
  const c = ctxMateriaDe(mundo);
  const persona = mundo.people.find(p => p.role === 'I');
  assert.ok(persona?.cuerpo && persona.carga);
  const { SiO2 } = sustanciasDe(c);
  for (const cuantos of [500_000, 600_000]) {
    const lote = c.materia.nuevo(Rol.Objeto, REF_NULA, 0);
    c.materia.fuente(lote, Float64Array.of(SiO2, cuantos), c.libro);
    persona.carga.push(lote);
  }
  vistaMateriales(c, persona);
  const masa = cargaKg(c, persona.carga), unidades = masa / KG_POR_UNIDAD_MATERIAL;
  assert.ok(unidades > 8);
  assert.equal(persona.materials.stone, unidades);

  store.guardar(motor.instantanea());
  const guardado = store.cargarInstantanea();
  assert.ok(guardado?.instantanea.materia);
  const restaurado = guardado.instantanea.world;
  const viajera = restaurado.people.find(p => p.id === persona.id);
  assert.ok(viajera?.carga);
  assert.deepEqual(viajera.carga, persona.carga);
  assert.equal(viajera.materials.stone, unidades);
  motor.cargar(guardado.instantanea, guardado.epoca);
  assert.equal(cargaKg(ctxMateriaDe(restaurado), viajera.carga), masa);

  for (const invalido of [-1, NaN, Infinity]) {
    viajera.materials.stone = invalido;
    assert.throws(() => assertWorld(restaurado), /Materiales transportados inválidos/);
  }
  viajera.materials.stone = unidades;
  viajera.carga = undefined;
  assert.throws(() => assertWorld(restaurado), /Materiales transportados inválidos/);
});

test('al reabrir se asientan las garantías sin atribuir la referencia antigua a un actor', prueba => {
  const mundo = createWorld(7, parseParams({ v23: escalon('duenos') }));
  const motor = crearMotor(mundo, unSoloDueno(7)), store = new Store(':memory:');
  const motores = [motor];
  prueba.after(async () => {
    store.close();
    for (const m of motores) await m.cerrar();
  });
  motor.cargar({ world: mundo, materia: null }, 0);
  const c = ctxMateriaDe(mundo), d = duenoSi(mundo)!;
  const persona = mundo.people.find(p => p.role === 'I')!;
  const refAnterior = c.ref(persona.uid!);
  assert.notEqual(refAnterior, REF_NULA);
  const celdaPortador = c.terreno.celda(persona.x, persona.y);
  const celdaGuardada = c.terreno.celda(mundo.tiles[0]!.x, mundo.tiles[0]!.y);
  assert.ok(celdaGuardada >= 0 && celdaPortador >= 0 && celdaGuardada !== celdaPortador);
  const celdaLote = (celda: number, rol: Rol) => {
    const l = new Float64Array(1);
    assert.equal(c.materia.lotes(celda, rol, l), 1);
    return l[0]!;
  };
  const suelo = celdaLote(celdaGuardada, Rol.Suelo), sueloPortador = celdaLote(celdaPortador, Rol.Suelo);
  const objeto = c.materia.nuevo(Rol.Objeto, celdaGuardada, 0);
  const carga = c.materia.nuevo(Rol.Objeto, REF_NULA, 0);
  (persona.carga ??= []).push(carga);
  const origen = c.materia.nuevo(Rol.Objeto, REF_NULA, 0), { SiO2 } = sustanciasDe(c);
  const estadoLote = (contexto: typeof c, lote: number) =>
    [contexto.materia.cuantos(lote, SiO2), contexto.materia.calor(lote)];
  const antes = [estadoLote(c, suelo), estadoLote(c, sueloPortador), estadoLote(c, objeto)];
  c.materia.fuente(origen, Float64Array.of(SiO2, 14, 0, 28), c.libro);
  const concedido: Intento = { tipo: TipoIntento.Concedido, de: refAnterior, a: refAnterior,
    celda: celdaGuardada, lote: carga, nonce: 1, materia: null, dato: Float64Array.of(Rol.Objeto, 0), bytes: null };
  d.fase(5);
  function enviar(cuantos: number, cambio: Partial<Intento>): void {
    const materia = c.materia.garantizar(origen, { parte: Parte.Exacta, esp: SiO2, cuantos, kappa: null }, c.libro);
    c.buzon.enviar(0, { ...concedido, ...cambio, materia });
  }
  enviar(2, {});
  enviar(3, { nonce: 2, celda: REF_NULA });
  enviar(4, { nonce: 3, tipo: TipoIntento.Depositar, a: REF_NULA, lote: objeto, celda: REF_NULA });
  enviar(5, { nonce: 4, tipo: TipoIntento.Depositar, a: REF_NULA, lote: REF_NULA });
  store.guardar(motor.instantanea());
  const guardado = store.cargarInstantanea()!, cp = guardado.instantanea.materia!;
  const intentos = decodificarEnVuelo(cp.enVuelo);
  assert.equal(intentos.length, 4);

  const copiaRechazada = cloneWorld(guardado.instantanea.world);
  const lector = duenoDe(copiaRechazada, cp.sustancias);
  lector.prepararEpoca();
  const memoria = lector.muestraMemoriaMateria();
  const invalidos = intentos.map(i => i.nonce === 2 ? { ...i, lote: refDe(slotDe(carga), genDe(carga) + 1) } : i);
  assert.throws(() => lector.cargarMateria({ ...cp, enVuelo: codificarEnVuelo(invalidos) }),
    /Garantía guardada 2 sin celda ni destino material demostrable/);
  assert.deepEqual(lector.muestraMemoriaMateria(), memoria);
  assert.ok(lector.libro.enVuelo.every(n => n === 0));

  const restaurado = guardado.instantanea.world, recargado = crearMotor(restaurado, unSoloDueno(7));
  motores.push(recargado);
  recargado.cargar(guardado.instantanea, guardado.epoca);
  const re = ctxMateriaDe(restaurado), lectorReal = duenoSi(restaurado)!;
  assert.ok(re.frente.vivo[slotDe(refAnterior)] && re.frente.gen[slotDe(refAnterior)] === genDe(refAnterior));
  const repuestos = lectorReal.pendientes();
  assert.equal(repuestos.length, 4);
  assert.ok(repuestos.every(i => i.a === REF_NULA && i.de === REF_NULA));
  lectorReal.fase(1);
  lectorReal.aplicar('B');
  assert.deepEqual(estadoLote(re, suelo), [antes[0]![0]! + 2, antes[0]![1]! + 4]);
  assert.deepEqual(estadoLote(re, sueloPortador), [antes[1]![0]! + 3, antes[1]![1]! + 6]);
  assert.deepEqual(estadoLote(re, objeto), [antes[2]![0]! + 9, antes[2]![1]! + 18]);
  assert.deepEqual(estadoLote(re, carga), [0, 0]);
  assert.ok(re.libro.enVuelo.every(n => n === 0));
  assert.equal(lectorReal.pendientes().length, 0);
  const saldo = conservacion(re);
  assert.deepEqual(saldo.hallado, saldo.esperado);

  const segundo = store.cargarInstantanea()!;
  const repartido = crearMotor(segundo.instantanea.world, { ...unSoloDueno(7), hilos: 2 });
  motores.push(repartido);
  repartido.cargar(segundo.instantanea, segundo.epoca);
  const tick = segundo.instantanea.world.tick;
  assert.equal(repartido.paso([]).tick, tick + 1);
  const corte = repartido.instantanea();
  assert.ok(decodificarEnVuelo(corte.materia!.enVuelo).every(i => i.nonce > 4));
  store.guardar(corte);
  assert.equal(store.cargarInstantanea()!.instantanea.world.tick, tick + 1);
});

test('la carga del inventario escalar heredado sigue limitada a 12 de madera y 8 de piedra', () => {
  const mundo = createWorld(7);
  const persona = mundo.people[0]!;
  persona.materials = { wood: 12, stone: 8 };
  assertWorld(mundo);
  for (const recurso of ['wood', 'stone'] as const) {
    persona.materials[recurso]++;
    assert.throws(() => assertWorld(mundo), /Materiales transportados inválidos/);
    persona.materials[recurso]--;
  }
});
