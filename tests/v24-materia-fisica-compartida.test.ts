import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../src/server/store.js';
import { stringifyExact } from '../src/shared/exact-json.js';
import { escalon } from '../src/shared/interruptores.js';
import { cloneWorld } from '../src/world/clon.js';
import { ArchivoMateriaFria } from '../src/world/materia/archivo-frio.js';
import { ArenaLotes, LOTES_POR_BLOQUE } from '../src/world/materia/arena.js';
import { codificarCheckpoint } from '../src/world/materia/checkpoint.js';
import { sustanciasMundo } from '../src/world/materia/mundo.js';
import { crearServicioQuimico } from '../src/world/materia/servicio.js';
import { Parte, Rol, libroVacio } from '../src/world/materia/tipos.js';
import { duenoSi } from '../src/world/motor/contexto.js';
import { unSoloDueno } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { crearArenasMateria } from '../src/world/motor/reserva-materia.js';
import { createWorld } from '../src/world/mundo/crear.js';
import type { World } from '../src/world/mundo/tipos.js';
import { parseParams } from '../src/world/params.js';
import { PageArena } from '../src/world/soa/arena.js';

test('la reserva física compartida conserva referencias, vapor y saldo al reponer antes de ceder', t => {
  const raiz = mkdtempSync(join(tmpdir(), 'atlas-fisica-compartida-'));
  const { lotes, desborde, contenido } = crearArenasMateria(undefined, true);
  assert.ok(contenido);
  const archivo = new ArchivoMateriaFria(raiz, contenido, desborde);
  t.after(() => { archivo.cerrar(); rmSync(raiz, { recursive: true, force: true }); });
  const paginas = new PageArena(2);
  const quimica = crearServicioQuimico({ modo: 'inmediato' });
  const { H2O: agua } = sustanciasMundo(quimica);
  const duenoChunk = new Int16Array(new SharedArrayBuffer(4));
  duenoChunk[1] = 1;
  const comunes = { quimica, agua, digerible: () => 0, terreno: { duenoChunk, chunkDe: (celda: number) => celda >> 8 } };
  const coordinador = new ArenaLotes({ ...comunes, lotes, desborde, paginas, contenido, hilo: 0,
    leerFrio: (ref, celda) => archivo.leer(ref, celda) });
  const conectar = (arena: PageArena) => PageArena.conectar(arena.compartir());
  const remoto = new ArenaLotes({ ...comunes, lotes: conectar(lotes), desborde: conectar(desborde),
    paginas: conectar(paginas), contenido: conectar(contenido), hilo: 1 });

  lotes.prepararF0(4, LOTES_POR_BLOQUE);
  contenido.prepararF0(4, LOTES_POR_BLOQUE);
  desborde.prepararF0(32);
  paginas.prepararF0(2);
  paginas.reserve(); paginas.reserve();
  const libro = libroVacio();
  const suelo = coordinador.nuevo(Rol.Suelo, 3, 0);
  const aire = coordinador.nuevo(Rol.Aire, 0, 0);
  const frontera = remoto.nuevo(Rol.Aire, 256, 0);
  coordinador.fuente(suelo, Float64Array.of(agua, 9, 0, 1000), libro);
  remoto.fuente(frontera, Float64Array.of(agua, 100, 0, 2000), libro);
  assert.equal(coordinador.cuantos(frontera, agua), 100);
  const muestra = coordinador.muestra(suelo), saldo = coordinador.saldo();

  archivo.enfriar(coordinador, 0, [suelo]);
  assert.equal(contenido.used, 2);
  assert.equal(lotes.used, 3);
  assert.ok(remoto.vivo(suelo) && !remoto.propio(suelo));
  assert.throws(() => remoto.muestra(suelo), /Falta el lector/);
  assert.deepEqual(coordinador.saldo(), saldo);
  const vapor = remoto.garantizar(frontera, { parte: Parte.Exacta, esp: agua, cuantos: 7, kappa: null }, libro);
  coordinador.abonar(aire, vapor, libro);
  assert.equal(remoto.cuantos(aire, agua), 7);
  assert.ok(coordinador.estaAparcado(suelo));
  assert.ok(libro.enVuelo.every(n => n === 0));
  assert.deepEqual(coordinador.saldo(), saldo);

  archivo.calentar(coordinador, 0);
  duenoChunk[0] = 1;
  assert.ok(remoto.propio(suelo) && !coordinador.propio(suelo));
  assert.deepEqual(remoto.muestra(suelo), { ...muestra, dueno: 1 });
  assert.deepEqual(remoto.saldoPropio(), saldo);
  assert.equal(contenido.used, 3);
});

test('el guardado compartido reabre con ambos layouts y conserva VMAT, organismos y balance', async () => {
  const hilos = 2, semilla = 7;
  const config = { ...unSoloDueno(semilla), hilos, verificar: false };
  const mundo = createWorld(semilla, parseParams({ v23: escalon('duenos'), motor: { hilos } }));
  const store = new Store(':memory:', { snapshotPackedPeople: true, snapshotMatterPartBytes: 4 * 1024 });
  const escritor = crearMotor(mundo, { ...config, materiaFisicaSeparada: true });
  try {
    assert.equal(escritor.paso([]).tick, 1);
    const inicial = duenoSi(mundo)!;
    const medida = inicial.muestraMemoriaMateria();
    assert.ok(medida?.limiteLotesFisicos && medida.limiteLotesFisicos === medida.limiteLotes);
    assert.equal(medida.estadoFrio, undefined);
    const corte = escritor.instantanea();
    assert.ok(corte.materia);
    const vmat = codificarCheckpoint(corte.materia);
    store.guardar(corte);
    await escritor.cerrar();
    const leido = store.cargarGuardadoCompleto();
    assert.ok(leido?.instantanea.materia);
    assert.equal(Buffer.compare(codificarCheckpoint(leido.instantanea.materia), vmat), 0);
    let oraculo: { vmat: Uint8Array; personas: string; animales: string } | undefined;
    for (const materiaFisicaSeparada of [false, true]) {
      const apertura: World = cloneWorld(leido.instantanea.world);
      const motor = crearMotor(apertura, { ...config, materiaFisicaSeparada });
      try {
        motor.cargar({ world: apertura, materia: leido.instantanea.materia }, leido.epoca);
        const recuperado = motor.instantanea();
        assert.ok(recuperado.materia);
        const contenido = { vmat: codificarCheckpoint(recuperado.materia), personas: stringifyExact(recuperado.world.people),
          animales: stringifyExact(recuperado.world.animals) };
        if (oraculo) {
          assert.equal(Buffer.compare(contenido.vmat, oraculo.vmat), 0);
          assert.ok(contenido.personas === oraculo.personas && contenido.animales === oraculo.animales);
        }
        else oraculo = contenido;
        assert.deepEqual(new Set(motor.reparto()?.paginas.map(p => p[2])), new Set([0, 1]));
        assert.equal(motor.paso([]).tick, 2);
        const { esperado, hallado }: { esperado: bigint[]; hallado: bigint[] } = duenoSi(apertura)!.balanceMateria();
        assert.deepEqual(hallado, esperado);
      } finally { await motor.cerrar(); }
    }
  } finally { store.close(); await escritor.cerrar(); }
});
