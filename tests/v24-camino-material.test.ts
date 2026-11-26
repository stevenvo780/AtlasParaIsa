import assert from 'node:assert/strict';
import test from 'node:test';
import { escalon } from '../src/shared/interruptores.js';
import { codigoForma } from '../src/shared/materia.js';
import { move } from '../src/world/actuar/mover.js';
import { createWorld, tileAt } from '../src/world/index.js';
import { empedrar } from '../src/world/inventions.js';
import { conservacion, sustanciasDe } from '../src/world/materia/ley-mundo.js';
import { calidadEmpedrado, celdaObra, lotesEnObra, trasladarLoteObra } from '../src/world/materia/piezas.js';
import { Rol } from '../src/world/materia/tipos.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { REF_NULA, unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { parseParams } from '../src/world/params.js';
import { personaMovida } from '../src/world/rejilla.js';

test('la ruta local prefiere la piedra colocada y pierde esa preferencia al retirarla', async t => {
  const mundo = createWorld(42, parseParams({ terreno: { caminosFisicos: true }, v23: escalon('obra') }));
  const inicio = { x: 16, y: 12 }, alSur = { x: 16, y: 13 }, alEste = { x: 17, y: 12 }, destino = { x: 22, y: 18 };
  for (let y = 10; y <= 20; y++) for (let x = 16; x <= 24; x++) {
    const tile = tileAt(mundo, { x, y })!;
    Object.assign(tile, { terrain: 'meadow', biome: 'grassland', traffic: 0 });
  }
  const persona = mundo.people[2]!;
  Object.assign(persona, alSur, { action: 'explore', target: destino });
  const motor = crearMotor(mundo, unSoloDueno(42));
  t.after(() => motor.cerrar());
  motor.cargar({ world: mundo, materia: null }, 0);
  const c = ctxMateriaDe(mundo), firme = tileAt(mundo, alSur)!, tierra = tileAt(mundo, alEste)!;

  const forma = codigoForma({ largo: 1, ancho: 1, grueso: 0.2, hueco: 0, filo: 0 });
  const piedra = c.materia.nuevo(Rol.Objeto, REF_NULA, forma);
  c.materia.fuente(piedra, Float64Array.of(sustanciasDe(c).SiO2, 500_000, 0, 2_000_000), c.libro);
  persona.carga!.push(piedra);
  assert.ok(empedrar(c, persona, firme));
  assert.ok(calidadEmpedrado(c, firme) > 0);
  assert.equal(firme.paved, undefined);

  const probarDesdeElCruce = () => {
    Object.assign(persona, inicio);
    personaMovida(mundo, persona);
    firme.traffic = tierra.traffic = 0;
    move(mundo, persona);
    return { x: persona.x, y: persona.y };
  };
  assert.deepEqual(probarDesdeElCruce(), alSur);

  const celda = celdaObra(c, firme);
  const [pieza] = lotesEnObra(c, celda, Rol.Pieza);
  assert.ok(pieza !== undefined);
  trasladarLoteObra(c, pieza, Rol.Objeto, celda, forma);
  assert.equal(calidadEmpedrado(c, firme), 0);
  firme.paved = 1;
  assert.deepEqual(probarDesdeElCruce(), alEste, 'el indicador escalar no sostiene la ruta sin la piedra');
  const { esperado, hallado } = conservacion(c);
  assert.deepEqual(hallado, esperado);
});
