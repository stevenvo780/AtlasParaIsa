import assert from 'node:assert/strict';
import test from 'node:test';
import { registrarSustanciasBase } from '../scripts/lab-materia.mjs';
import { balanceConservacion, paramsDeEncender } from '../scripts/lab/encender.mjs';
import type { StructureView } from '../src/shared/life.js';
import { codigoForma } from '../src/shared/materia.js';
import { move } from '../src/world/actuar/mover.js';
import { choose } from '../src/world/decision/personas.js';
import { bodilyDamage, bodilyShelter } from '../src/world/decision/sentidos.js';
import { createWorld, stepWorld, tileAt } from '../src/world/index.js';
import { advancePopulation } from '../src/world/lineage.js';
import { celdaObra, colocarPieza, trasladarLoteObra, type EstadoObra } from '../src/world/materia/piezas.js';
import type { ServicioQuimicoImpl } from '../src/world/materia/servicio.js';
import { Parte, Rol } from '../src/world/materia/tipos.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
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
