import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/server/store.js';
import { escalon } from '../src/shared/interruptores.js';
import { KG_POR_UNIDAD_MATERIAL } from '../src/shared/naturaleza.js';
import { vistaMateriales } from '../src/world/actuar/recursos.js';
import { cargaKg } from '../src/world/materia/cuerpo.js';
import { sustanciasDe } from '../src/world/materia/ley-mundo.js';
import { Rol } from '../src/world/materia/tipos.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { REF_NULA, unSoloDueno } from '../src/world/motor/contratos.js';
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

test('la carga escalar sin cuerpo sigue limitada a 12 de madera y 8 de piedra', () => {
  for (const mundo of [createWorld(7), createWorld(7, parseParams({ v23: escalon('cuerpos') }))]) {
    const persona = mundo.people[0]!;
    assert.equal(persona.cuerpo, undefined);
    persona.materials = { wood: 12, stone: 8 };
    assertWorld(mundo);
    for (const recurso of ['wood', 'stone'] as const) {
      persona.materials[recurso]++;
      assert.throws(() => assertWorld(mundo), /Materiales transportados inválidos/);
      persona.materials[recurso]--;
    }
  }
});
