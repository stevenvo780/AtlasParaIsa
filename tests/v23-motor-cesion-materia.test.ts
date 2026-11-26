import assert from 'node:assert/strict';
import test from 'node:test';
import { CAPACIDAD_ATOMO } from '../src/shared/naturaleza.js';
import { aportarEscalar, encender, extraerEscalar, fuegoEn, lotesDeCelda, sustanciasDe } from '../src/world/materia/ley-mundo.js';
import { Rol } from '../src/world/materia/tipos.js';
import type { CtxLeyMateria } from '../src/world/motor/acceso.js';
import { repartirPorTramos } from '../src/world/motor/bloques.js';
import { ORDEN, duenoSi } from '../src/world/motor/contexto.js';
import { unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { DEFAULT_PARAMS } from '../src/world/params.js';

test('una página que vuelve a su dueño conserva la roca que queda y continúa ardiendo', async prueba => {
  const semilla = 7, hilos = 2;
  const mundo = createWorld(semilla, {
    ...DEFAULT_PARAMS,
    motor: { ...DEFAULT_PARAMS.motor, hilos },
    v23: { ...DEFAULT_PARAMS.v23, materia: true, duenos: true },
  });
  const paginas = Object.values(mundo.chunks);
  const repartidas = repartirPorTramos(paginas.map(p => p.cx), paginas.map(p => p.cy), hilos);
  const pagina = paginas[repartidas.indexOf(1)];
  const persona = mundo.people.find(p => p.role === 'neighbor');
  assert.ok(pagina && persona);
  const x = pagina.cx * 16 + 8, y = pagina.cy * 16 + 8;
  persona.x = x; persona.y = y; persona.target = { x, y };
  const tesela = mundo.tiles.find(t => t.x === x && t.y === y);
  assert.ok(tesela);
  tesela.stone = 4;

  const motor = crearMotor(mundo, { ...unSoloDueno(semilla), hilos });
  try {
    motor.paso([]);
    const d = duenoSi(mundo);
    assert.ok(d?.materia && d.quimica);
    const c = d as CtxLeyMateria, t = d.terrenoPercibido;
    const celda = t.celda(x, y), chunk = t.chunkDe(celda);
    assert.equal(t.duenoChunk[chunk], 1);

    // La cesión cruza las mismas barreras que una decisión de rebalanceo, sin depender del tiempo de los hilos.
    const ceder = (origen: number, destino: number): void => {
      d.ordenar(origen, [ORDEN.ceder, chunk, destino]);
      t.duenoSiguiente[chunk] = destino;
      motor.paso([]);
      t.asignar(chunk, destino);
      t.duenoSiguiente[chunk] = -1;
    };
    ceder(1, 0);
    motor.paso([]);
    const { suelo } = lotesDeCelda(c, celda, { suelo: -1, agua: -1, vida: -1, aire: -1 });
    assert.ok(d.materia.propio(suelo));
    assert.equal(extraerEscalar(c, celda, 'piedra', 1), 1);

    const madera = sustanciasDe(c).madera, cuantos = 100_000;
    const atomos = d.quimica.sustancia(madera).atomos.reduce((suma, n) => suma + n, 0) * cuantos;
    const fuego = d.materia.nuevo(Rol.Objeto, celda, 0);
    d.materia.fuente(fuego, Float64Array.of(madera, cuantos), d.libro);
    assert.ok(encender(c, celda, fuego, CAPACIDAD_ATOMO * atomos * 1_100));

    ceder(0, 1);
    const combustibleEnVuelo = d.materia.cuantos(fuego, madera);
    assert.ok(combustibleEnVuelo > 0);
    motor.paso([]);
    assert.ok(d.materia.cuantos(fuego, madera) < combustibleEnVuelo, 'el fuego sigue consumiendo madera en el dueño original');
    assert.equal(aportarEscalar(c, celda, 'agua', 1), 0);
    const ajenos = lotesDeCelda(c, celda, { suelo, agua: -1, vida: -1, aire: -1 });
    assert.deepEqual(ajenos, { suelo: -1, agua: -1, vida: -1, aire: -1 });
    assert.equal(fuegoEn(c, celda), -1);
    for (let i = 0; i < DEFAULT_PARAMS.v23.cadenciaMateria; i++) motor.paso([]);
    const codificarMateria = prueba.mock.method(d, 'instantaneaMateria');
    const vista = motor.vista();
    assert.equal(codificarMateria.mock.callCount(), 0);
    const durable = motor.instantanea();
    assert.ok(durable.materia);
    assert.equal(codificarMateria.mock.callCount(), 1);
    assert.deepEqual(vista, durable.world);
    assert.equal(vista.tiles.find(t => t.x === x && t.y === y)?.stone, 3);
    const lotes = new Float64Array(1);
    assert.equal(d.materia.lotes(celda, Rol.Suelo, lotes), 1);
    assert.equal(lotes[0], suelo);
    assert.equal(d.materia.propio(suelo), false);
  } finally { await motor.cerrar(); }
});
