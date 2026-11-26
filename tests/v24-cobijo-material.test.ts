import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import test from 'node:test';
import { registrarSustanciasBase } from '../scripts/lab-materia.mjs';
import { balanceConservacion, paramsDeEncender } from '../scripts/lab/encender.mjs';
import type { StructureView } from '../src/shared/life.js';
import { codigoForma } from '../src/shared/materia.js';
import { move } from '../src/world/actuar/mover.js';
import { choose } from '../src/world/decision/personas.js';
import { bodilyDamage, bodilyShelter } from '../src/world/decision/sentidos.js';
import { demographicTraits } from '../src/world/demography.js';
import { transferEstate } from '../src/world/demografia/morir.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { createWorld, stepWorld, tileAt } from '../src/world/index.js';
import { advancePopulation, CANAL_EXPOSICION, type MuestraExposicion } from '../src/world/lineage.js';
import { codificarCheckpoint } from '../src/world/materia/checkpoint.js';
import { celdaObra, colocarPieza, estadoObra, trasladarLoteObra, type EstadoObra } from '../src/world/materia/piezas.js';
import type { ServicioQuimicoImpl } from '../src/world/materia/servicio.js';
import { Parte, Rol } from '../src/world/materia/tipos.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { duenoSi } from '../src/world/motor/contexto.js';
import { paramsOf, parseParams } from '../src/world/params.js';
import { personaMovida } from '../src/world/rejilla.js';
import { chunkKey } from '../src/world/terrain.js';

function escena(estado: 'intacta' | 'desgastada' | 'desmontada' | 'sinPieza') {
  const mundo = createWorld(7, paramsDeEncender({ regimen: 'abierto', hasta: 'obra' }));
  stepWorld(mundo);
  const c = ctxMateriaDe(mundo), persona = mundo.people.find(p => p.role === 'neighbor')!;
  const sitio = tileAt(mundo, persona)!;
  assert.notEqual(sitio.terrain, 'shelter');
  const punto = { x: sitio.x, y: sitio.y };
  const contigua = [{ x: sitio.x + 1, y: sitio.y }, { x: sitio.x - 1, y: sitio.y }].find(p => {
    const tile = tileAt(mundo, p);
    return tile && tile.terrain !== 'water' && chunkKey(p.x, p.y) === chunkKey(punto.x, punto.y) && celdaObra(c, p) >= 0;
  });
  assert.ok(contigua);
  const plano = mundo.blueprints[0]!;
  const obra: EstadoObra = { piezas: [], pendiente: null, agua: -1, comida: -1, terminada: true };
  const s: StructureView & { obraMaterial: EstadoObra } = { ...contigua, id: `structure-${++mundo.structureCounter}`,
    name: plano.name, blueprintId: plano.id, cells: [contigua, punto], components: [...plano.components],
    condition: 1, water: 0, food: 0, uses: 0, builtAt: mundo.tick, builderId: persona.id, obraMaterial: obra };
  mundo.structures.push(s);
  if (estado !== 'sinPieza') {
    const celda = celdaObra(c, punto), { SiO2 } = registrarSustanciasBase(c.quimica as ServicioQuimicoImpl);
    const forma = codigoForma({ largo: 1, ancho: 1, grueso: 0.2, hueco: 0, filo: 0 });
    const lote = c.materia.nuevo(Rol.Objeto, celda, forma);
    // Stock preparado del laboratorio. La fuente queda asentada en el libro material.
    c.materia.fuente(lote, Float64Array.of(SiO2, 500_000, 0, 2_000_000), c.libro);
    colocarPieza(c, s.id, lote, celda);
    if (estado === 'desgastada') {
      const residuo = c.materia.nuevo(Rol.Objeto, celda, 0);
      c.materia.moverParte(obra.piezas[0]!.lote, residuo, { parte: Parte.Exacta, esp: SiO2, cuantos: 480_000, kappa: null });
    } else if (estado === 'desmontada') {
      trasladarLoteObra(c, obra.piezas.pop()!.lote, Rol.Objeto, celda, forma);
    }
  }
  mundo.weather = 'rain';
  return { mundo, persona, punto, contigua };
}

test('las piezas sobre la celda reducen el daño de lluvia y el desgaste o desmontaje retiran el beneficio', t => {
  function brazo(estado: Parameters<typeof escena>[0]) {
    const { mundo, persona, contigua } = escena(estado);
    const cobijo = bodilyShelter(mundo, persona);
    assert.equal(bodilyShelter(mundo, contigua), 0);
    const previsto = bodilyDamage(mundo, persona, persona, cobijo);
    const salud = persona.demography.health;
    advancePopulation(mundo, { emit: () => { throw new Error('La escena corta debe conservar a sus habitantes.'); } });
    assert.equal(balanceConservacion(mundo)?.ok, true);
    return { cobijo, previsto, observado: salud - persona.demography.health };
  }

  const control = brazo('sinPieza'), intacta = brazo('intacta'), desgastada = brazo('desgastada'), desmontada = brazo('desmontada');
  assert.equal(control.cobijo, 0);
  assert.ok(intacta.cobijo > 0);
  assert.ok(intacta.previsto < control.previsto);
  assert.ok(intacta.observado < control.observado);
  assert.deepEqual(desgastada, control);
  assert.deepEqual(desmontada, control);
  t.diagnostic(JSON.stringify({ semilla: 7, control, intacta, desgastada, desmontada, balanceExacto: true }));
});

test('bajo lluvia la persona elige y alcanza la pieza protectora desde la celda contigua', t => {
  function brazo(estado: 'intacta' | 'desmontada') {
    const { mundo, persona, punto, contigua } = escena(estado);
    Object.assign(persona, contigua);
    personaMovida(mundo, persona);
    persona.target = contigua;
    persona.action = 'rest';
    persona.fatigue = 0.95;
    persona.hunger = persona.thirst = 0.05;
    assert.equal(bodilyShelter(mundo, persona), 0);
    choose(mundo, persona);
    const seleccion = { action: persona.action, x: persona.target.x, y: persona.target.y };
    move(mundo, persona);
    assert.equal(balanceConservacion(mundo)?.ok, true);
    return { punto, seleccion, llegada: { x: persona.x, y: persona.y }, cobijo: bodilyShelter(mundo, persona) };
  }

  const intacta = brazo('intacta'), desmontada = brazo('desmontada');
  t.diagnostic(JSON.stringify({ semilla: 7, intacta, desmontada }));
  assert.deepEqual(intacta.seleccion, { action: 'rest', ...intacta.punto });
  assert.deepEqual(intacta.llegada, intacta.punto);
  assert.ok(intacta.cobijo > 0);
  assert.notDeepEqual(desmontada.seleccion, { action: 'rest', ...desmontada.punto });
  assert.equal(desmontada.cobijo, 0);
});

test('la sonda observa el daño posacción y el techo material sin alterar el balance ni la trayectoria', () => {
  const sonda = channel(CANAL_EXPOSICION);
  function brazo(estado: 'intacta' | 'sinPieza', medir: boolean) {
    const { mundo, persona } = escena(estado);
    const muestras: MuestraExposicion[] = [], observar = (valor: unknown) => { muestras.push(valor as MuestraExposicion); };
    if (medir) sonda.subscribe(observar);
    try {
      bodilyDamage(mundo, persona, persona, bodilyShelter(mundo, persona));
      assert.equal(muestras.length, 0);
      const n = mundo.people.length;
      advancePopulation(mundo, { emit: () => { throw new Error('La escena corta debe conservar a sus habitantes.'); } });
      assert.equal(muestras.length, medir ? n : 0);
      const muestra = muestras.find(m => m.id === persona.id);
      if (muestra) assert.deepEqual(muestra.despues, persona.demography);
      return { muestra, digesto: digestoCanonico(mundo), balance: balanceConservacion(mundo) };
    } finally { if (medir) sonda.unsubscribe(observar); }
  }
  const intacta = brazo('intacta', true), control = brazo('intacta', false), sinTecho = brazo('sinPieza', true);
  assert.equal(intacta.digesto, control.digesto);
  assert.deepEqual(intacta.balance, control.balance);
  assert.ok(intacta.balance?.ok);
  const cubierta = intacta.muestra!, expuesta = sinTecho.muestra!;
  assert.ok(cubierta.lluvia && cubierta.cuerpo && cubierta.cuerpo.masaKg > 0 && cubierta.cuerpo.aguaReservaKg >= 0);
  assert.equal(cubierta.tipoTecho, 'material');
  assert.equal(expuesta.tipoTecho, 'ninguno');
  assert.equal(cubierta.exposicionSinTechoNiPrenda, expuesta.dano.exposure);
  assert.equal(cubierta.exposicionSoloTecho, cubierta.dano.exposure);
  assert.ok(cubierta.dano.exposure < expuesta.dano.exposure);
  assert.equal(expuesta.causaTerminal, null);
  assert.equal(expuesta.golpeSorteoSenescencia, 0);
});

test('en seco el techo queda sin evaluar y la sonda conserva el checkpoint material', () => {
  const sonda = channel(CANAL_EXPOSICION);
  function brazo(medir: boolean) {
    const { mundo, persona } = escena('intacta');
    mundo.weather = 'clear';
    const lote = estadoObra(mundo.structures.at(-1)!)!.piezas[0]!.lote;
    const { materia } = ctxMateriaDe(mundo), vista = materia.vista;
    let lecturasDelTecho = 0;
    materia.vista = function (ref) {
      if (ref === lote) lecturasDelTecho++;
      return vista.call(this, ref);
    };
    const muestras: MuestraExposicion[] = [], observar = (valor: unknown) => { muestras.push(valor as MuestraExposicion); };
    if (medir) sonda.subscribe(observar);
    try { advancePopulation(mundo, { emit: () => { throw new Error('La escena corta debe conservar a sus habitantes.'); } }); }
    finally { if (medir) sonda.unsubscribe(observar); materia.vista = vista; }
    assert.equal(lecturasDelTecho, 0);
    const muestra = muestras.find(m => m.id === persona.id);
    if (medir) {
      assert.ok(muestra);
      assert.equal(muestra.lluvia, false);
      assert.equal(muestra.techo, null);
      assert.equal(muestra.tipoTecho, 'no-evaluado');
      assert.equal(muestra.dano.exposure, 0);
    } else assert.equal(muestras.length, 0);
    const dueno = duenoSi(mundo)!;
    const checkpoint = dueno.instantaneaMateria(dueno.pendientes());
    assert.ok(checkpoint);
    return { digesto: digestoCanonico(mundo), checkpoint: codificarCheckpoint(checkpoint) };
  }
  assert.deepEqual(brazo(true), brazo(false));
});

test('la sonda distingue una lesión terminal por lluvia de la tirada terminal de vejez', () => {
  const sonda = channel(CANAL_EXPOSICION);
  function terminal(vejez: boolean): MuestraExposicion {
    const mundo = createWorld(7, parseParams({ cuerpo: { riesgoSenescenciaDiario: 1, riesgoSenescenciaPendiente: 50 } }));
    mundo.tick = 100;
    mundo.weather = 'rain';
    mundo.shelterBenefitEnabled = false;
    const persona = mundo.people.find(p => p.role === 'neighbor')!;
    const edad = vejez ? 2 * demographicTraits(persona.genome, paramsOf(mundo).cuerpo).maximumAge : 100;
    Object.assign(persona, { bornAt: mundo.tick - edad, hunger: 0, thirst: 0, energy: 1, fatigue: 0 });
    Object.assign(persona.demography, { age: edad, health: vejez ? 0.7 : 1e-7, vitality: 0.75 });
    const muestras: MuestraExposicion[] = [], observar = (valor: unknown) => { muestras.push(valor as MuestraExposicion); };
    sonda.subscribe(observar);
    try { advancePopulation(mundo, { emit: () => {}, beforeDeath: transferEstate }); }
    finally { sonda.unsubscribe(observar); }
    const muestra = muestras.find(m => m.id === persona.id);
    assert.ok(muestra);
    assert.equal(mundo.legacy.find(p => p.id === persona.id)?.cause, muestra.causaTerminal);
    return muestra;
  }
  const lluvia = terminal(false), vejez = terminal(true);
  assert.equal(lluvia.causaTerminal, 'exposure');
  assert.equal(lluvia.golpeSorteoSenescencia, 0);
  assert.ok(lluvia.dano.exposure > lluvia.antes.health);
  assert.equal(vejez.causaTerminal, 'senescence');
  assert.ok(vejez.golpeSorteoSenescencia > 0 && vejez.dano.exposure > 0);
  assert.equal(vejez.dano.senescence, vejez.desgasteEdad + vejez.golpeSorteoSenescencia);
});
