import assert from 'node:assert/strict';
import test from 'node:test';
import { recogerACuestas } from '../src/world/actuar/recursos.js';
import { codificarPaginas, decodificarPaginas } from '../src/world/materia/checkpoint.js';
import { rocaDe, sustanciasDe } from '../src/world/materia/ley-mundo.js';
import type { CtxLeyMateria } from '../src/world/motor/acceso.js';
import { ORDEN, duenoSi } from '../src/world/motor/contexto.js';
import { REF_NULA, unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { DEFAULT_PARAMS } from '../src/world/params.js';

test('la roca a cuestas cambia de dueño con la persona y se recupera de un guardado previo', async () => {
  const semilla = 7, hilos = 2;
  const mundo = createWorld(semilla, {
    ...DEFAULT_PARAMS,
    motor: { ...DEFAULT_PARAMS.motor, hilos },
    v23: { ...DEFAULT_PARAMS.v23, materia: true, cuerpos: true, duenos: true },
  });
  const persona = mundo.people.find(p => p.role === 'neighbor');
  assert.ok(persona);
  const tesela = mundo.tiles.find(t => t.x === persona.x && t.y === persona.y);
  assert.ok(tesela);
  tesela.vegetation = 0; tesela.wood = 0; tesela.food = 0; tesela.stone = 4;

  const motor = crearMotor(mundo, { ...unSoloDueno(semilla), hilos });
  try {
    motor.paso([]);
    const d = duenoSi(mundo);
    assert.ok(d?.materia && persona.cuerpo && mundo.people.includes(persona));
    const c = d as CtxLeyMateria, terreno = d.terrenoPercibido;
    const celda = terreno.celda(tesela.x, tesela.y), chunk = terreno.chunkDe(celda);
    assert.equal(terreno.duenoChunk[chunk], 0);
    const rocaEnSuelo = rocaDe(c, celda, 1);
    assert.notEqual(rocaEnSuelo, REF_NULA);
    assert.ok(recogerACuestas(mundo, persona, persona.cuerpo, tesela));
    assert.equal(persona.carga?.length, 1);
    const rocaACuestas = persona.carga![0]!;
    assert.ok(d.materia.cuantos(rocaACuestas, sustanciasDe(c).SiO2) > 0);

    const antes = motor.instantanea();
    assert.ok(antes.materia);
    const { lotes, libres } = decodificarPaginas(antes.materia.epoca, antes.materia.paginas);
    const suelo = lotes.find(l => l.ref === rocaEnSuelo), carga = lotes.find(l => l.ref === rocaACuestas);
    assert.ok(suelo && suelo.celda >= 0 && carga);
    assert.equal(carga.celda, REF_NULA);

    // Se cede la página sin depender del tiempo de los hilos.
    d.ordenar(0, [ORDEN.ceder, chunk, 1]);
    terreno.duenoSiguiente[chunk] = 1;
    motor.paso([]);
    terreno.asignar(chunk, 1);
    terreno.duenoSiguiente[chunk] = -1;
    motor.paso([]);
    const despues = motor.instantanea();
    assert.ok(despues.materia);
    const viajero = despues.world.people.find(p => p.id === persona.id);
    assert.deepEqual(viajero?.carga, [rocaACuestas]);
    const loteMigrado = decodificarPaginas(despues.materia.epoca, despues.materia.paginas).lotes.find(l => l.ref === rocaACuestas);
    assert.deepEqual(loteMigrado, { ...carga, dueno: 1 });

    // Antes del arreglo, también se grababa una celda para la roca que ya llevaba la persona.
    const paginas = codificarPaginas(antes.materia.epoca,
      lotes.map(l => l.ref === rocaACuestas ? { ...l, celda: suelo.celda } : l), libres);
    motor.cargar({ world: antes.world, materia: { ...antes.materia, paginas } }, 2);
    const restaurado = motor.instantanea();
    const pagina = motor.reparto()?.paginas.find(([px, py]) => px === (tesela.x >> 4) && py === (tesela.y >> 4));
    assert.ok(restaurado.materia && pagina);
    const repuestos = decodificarPaginas(restaurado.materia.epoca, restaurado.materia.paginas).lotes;
    assert.deepEqual(repuestos.find(l => l.ref === rocaACuestas), { ...carga, dueno: pagina[2] });
    assert.deepEqual(repuestos.find(l => l.ref === rocaEnSuelo), { ...suelo, dueno: pagina[2] });
  } finally { await motor.cerrar(); }
});
