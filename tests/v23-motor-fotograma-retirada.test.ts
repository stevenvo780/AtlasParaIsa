import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTROL_ENLACE_BYTES, enlaceCinta, fotogramaDe } from '../src/shared/fotograma.js';
import { ORDEN, duenoSi } from '../src/world/motor/contexto.js';
import { unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { createWorld } from '../src/world/mundo/crear.js';
import { DEFAULT_PARAMS } from '../src/world/params.js';
import { crearSAB } from '../src/world/soa/arena.js';
import { chunkKey } from '../src/world/terrain.js';

test('el fotograma de dos dueños excluye una página y su fauna al archivarlas', async () => {
  const semilla = 7;
  const mundo = createWorld(semilla, {
    ...DEFAULT_PARAMS,
    v23: { ...DEFAULT_PARAMS.v23, duenos: true, fotograma: true },
  });
  const motor = crearMotor(mundo, { ...unSoloDueno(semilla), hilos: 2 });
  const descriptor = { control: new SharedArrayBuffer(CONTROL_ENLACE_BYTES),
    ranuras: [crearSAB(0, 4 * 1024 * 1024)], versiones: crearSAB(0, 4096), sucesos: new SharedArrayBuffer(1024) };
  const enlace = enlaceCinta(descriptor);
  const serie = { poblacion: 0, nacimientos: 0, muertes: 0, fauna: 0, estructuras: 0, sustancias: 0, hz: 0 };
  try {
    motor.enlazar(descriptor, {
      corte(_c, f, paginas, reunido) {
        assert.ok(reunido);
        const claves = new Set<string>();
        for (let i = 0; i < paginas.length; i += 2) claves.add(`${paginas[i]},${paginas[i + 1]}`);
        assert.deepEqual(claves, new Set(Object.keys(reunido.chunks)));
        assert.equal(fotogramaDe(f.ranura).n, reunido.people.length + reunido.animals.length);
        return { serie, sucesos: [] };
      }, confirmar() {},
    });
    motor.paso([]);
    const { world } = motor.instantanea();
    const ocupadas = new Set(world.people.map(p => chunkKey(p.x, p.y)));
    const animal = world.animals.find(a => !ocupadas.has(chunkKey(a.x, a.y)));
    assert.ok(animal);
    const d = duenoSi(mundo)!, t = d.terreno;
    const chunk = t.chunkDe(t.celda(animal.x, animal.y));
    d.ordenar(t.duenoChunk[chunk]!, [ORDEN.ceder, chunk, -1]);
    Atomics.store(enlace.creditos, 0, 1);
    motor.paso([]);
    assert.equal(Atomics.load(enlace.entregados, 0), 1n);
    const archivado = motor.instantanea().world.retiredChunks.find(c => c.key === chunkKey(animal.x, animal.y));
    assert.ok(archivado?.animals?.some(a => a.uid === animal.uid));
  } finally {
    await motor.cerrar();
  }
});
