import assert from 'node:assert/strict';
import test from 'node:test';
import { escalon } from '../src/shared/interruptores.js';
import { codigoForma } from '../src/shared/materia.js';
import { C_MOVER } from '../src/shared/naturaleza.js';
import { move } from '../src/world/actuar/mover.js';
import { createWorld, tileAt } from '../src/world/index.js';
import { empedrar } from '../src/world/inventions.js';
import { cargaKg, masaDe, reservaJ } from '../src/world/materia/cuerpo.js';
import { conservacion, sustanciasDe } from '../src/world/materia/ley-mundo.js';
import { calidadEmpedrado, celdaObra, lotesEnObra, trasladarLoteObra } from '../src/world/materia/piezas.js';
import { Rol } from '../src/world/materia/tipos.js';
import { ctxMateriaDe } from '../src/world/motor/acceso.js';
import { REF_NULA, unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { parseParams } from '../src/world/params.js';
import { personaMovida } from '../src/world/rejilla.js';

test('la piedra colocada cambia la ruta y reduce el trabajo corporal del mismo paso', t => {
  const inicio = { x: 16, y: 12 }, alSur = { x: 16, y: 13 }, alEste = { x: 17, y: 12 }, destino = { x: 22, y: 18 };
  const pasoDesdeElFirme = { x: 16, y: 14 };

  // Ambas copias instalan la piedra. Solo el control la retira sin volver a cargarla.
  const probar = (retirarPiedra: boolean) => {
    const mundo = createWorld(42, parseParams({ terreno: { caminosFisicos: true }, v23: escalon('obra') }));
    for (let y = 10; y <= 20; y++) for (let x = 16; x <= 24; x++) {
      const tile = tileAt(mundo, { x, y })!;
      Object.assign(tile, { terrain: 'meadow', biome: 'grassland', traffic: 0 });
    }
    const persona = mundo.people[2]!;
    Object.assign(persona, alSur, { action: 'explore', target: pasoDesdeElFirme });
    const motor = crearMotor(mundo, unSoloDueno(42));
    t.after(() => motor.cerrar());
    motor.cargar({ world: mundo, materia: null }, 0);
    const c = ctxMateriaDe(mundo), firme = tileAt(mundo, alSur)!, tierra = tileAt(mundo, alEste)!;
    const { O2, SiO2 } = sustanciasDe(c);

    const forma = codigoForma({ largo: 1, ancho: 1, grueso: 0.2, hueco: 0, filo: 0 });
    const piedra = c.materia.nuevo(Rol.Objeto, REF_NULA, forma);
    c.materia.fuente(piedra, Float64Array.of(SiO2, 500_000, 0, 2_000_000), c.libro);
    persona.carga!.push(piedra);
    assert.ok(empedrar(c, persona, firme));
    assert.ok(calidadEmpedrado(c, firme) > 0);
    assert.equal(firme.paved, undefined);
    if (retirarPiedra) {
      const celda = celdaObra(c, firme);
      const [pieza] = lotesEnObra(c, celda, Rol.Pieza);
      assert.ok(pieza !== undefined);
      trasladarLoteObra(c, pieza, Rol.Objeto, celda, forma);
      assert.equal(calidadEmpedrado(c, firme), 0);
    }

    const cuerpo = persona.cuerpo;
    assert.ok(cuerpo);
    const estadoInicial = {
      masa: masaDe(c, cuerpo),
      carga: cargaKg(c, persona.carga!),
      reservaJ: reservaJ(c, cuerpo),
      oxigeno: c.materia.cuantos(cuerpo.reserva, O2),
      calorJ: c.materia.calor(cuerpo.reserva),
    };
    // En este paso aislado la oxidación para caminar deja sus julios en la reserva.
    move(mundo, persona);
    assert.deepEqual({ x: persona.x, y: persona.y }, pasoDesdeElFirme);
    const juliosLiberados = c.materia.calor(cuerpo.reserva) - estadoInicial.calorJ;

    Object.assign(persona, inicio, { target: destino });
    personaMovida(mundo, persona);
    firme.traffic = tierra.traffic = 0;
    if (retirarPiedra) firme.paved = 1;
    move(mundo, persona);
    const { esperado, hallado } = conservacion(c);
    assert.deepEqual(hallado, esperado);
    return { estadoInicial, juliosLiberados, ruta: { x: persona.x, y: persona.y } };
  };

  const conPiedra = probar(false), sinPiedra = probar(true);
  assert.deepEqual(conPiedra.estadoInicial, sinPiedra.estadoInicial);
  assert.deepEqual(conPiedra.ruta, alSur);
  assert.deepEqual(sinPiedra.ruta, alEste, 'el indicador escalar no sostiene la ruta sin la piedra');
  const { masa, carga } = sinPiedra.estadoInicial;
  assert.ok(sinPiedra.juliosLiberados >= C_MOVER * (masa + carga));
  assert.ok(conPiedra.juliosLiberados > 0 && conPiedra.juliosLiberados < sinPiedra.juliosLiberados,
    `oxidación para el mismo paso: ${conPiedra.juliosLiberados} J con piedra y ${sinPiedra.juliosLiberados} J sin ella`);
});
