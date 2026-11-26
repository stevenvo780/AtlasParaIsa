import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import test from 'node:test';
import { ClaseSustancia } from '../src/shared/materia.js';
import { CAPACIDAD_ATOMO } from '../src/shared/naturaleza.js';
import { CanalCompartido, enviarOrden, recibirRespuesta } from '../src/world/gpu/canal.js';
import { crearPasoMateriaGpu, prepararMateriaGpu } from '../src/world/gpu/materia-gpu.js';
import type { CtxPaso } from '../src/world/materia/paso.js';
import type { Reaccion, Sustancia } from '../src/world/materia/tipos.js';

test('G conserva en CUDA las páginas de entrada que no cambian entre despachos', {
  skip: !process.env.COMPUTE_NVRTC && 'Se requiere COMPUTE_NVRTC',
}, () => {
  const reaccion: Reaccion = { a: 9, b: 0, nivelT: 2, dH: -100, ea: 200, catalisis: 3, paresCatalisis: 2,
    entradas: [{ id: 9, nu: 1 }], salidas: [{ id: 13, nu: 1 }] };
  let cuantosPrimero = 20;
  const ctx: CtxPaso = {
    azar: () => 0.25,
    arena: {
      propio: () => true,
      especies(_lote: number, ids: Uint32Array) { ids[0] = 9; return 1; },
      calor: () => 270 * 20 * CAPACIDAD_ATOMO,
      cuantos: (lote: number) => lote === 1 ? cuantosPrimero : 20,
    } as unknown as CtxPaso['arena'],
    quimica: {
      sustancia: () => ({ atomos: Uint16Array.of(1), masa: 10, clase: ClaseSustancia.Molecula,
        prop: { tEbullicion: 300, densidad: 2 } }) as unknown as Sustancia,
      reaccion: (a, b, nivel) => a === 9 && b === 0 && nivel === 2 ? reaccion : null,
      internar() { throw new Error('El despacho GPU no interna sustancias.'); },
    },
  };
  const canal = new CanalCompartido(Number(process.env.CARTA_TEST_MATERIA_GPU_DEVICE ?? 0));
  const paso = crearPasoMateriaGpu(canal), perfil = channel('atlas:materia:gpu');
  const subidas: number[] = [];
  const contar = (dato: unknown) => { subidas.push((dato as { bytesH2D: number }).bytesH2D); };
  perfil.subscribe(contar);
  try {
    prepararMateriaGpu(canal, 30_000);
    const lanzar = (n: number, tick: number) => {
      const lotes = Float64Array.from({ length: n }, (_, i) => i + 1);
      const kappas = Float64Array.from({ length: n * 4 }, (_, i) => i % 4 === 3 ? 100 : 0);
      paso.lanzar(ctx, lotes, kappas, 1, tick);
      return paso.esperar(2_000);
    };
    const n = 128;
    const inicial = lanzar(n, 1);
    assert.equal(inicial.desde[n], 3 * n);
    assert.deepEqual(inicial.tripletas.slice(0, 3), Float64Array.of(9, 0, 20));
    assert.ok(subidas[0]! > 4096);

    canal.escribir(0, Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0));
    enviarOrden(canal, { kind: 'percibir', n: 0, parches: 0, tick: 2, despacho: 2,
      subida: 8, salida: 8, bajada: 0, terrenoBytes: 0, cerebroBytes: 0, organismosBytes: 0 });
    assert.equal(recibirRespuesta<{ ok: boolean }>(canal, 2_000).ok, true);
    const repetida = lanzar(n, 3);
    assert.deepEqual(repetida.tripletas, inicial.tripletas);
    assert.equal(subidas[1], 0);

    cuantosPrimero = 19;
    const cambiada = lanzar(n, 4);
    assert.deepEqual(cambiada.tripletas.slice(0, 3), Float64Array.of(9, 0, 19));
    assert.deepEqual(cambiada.tripletas.slice(3), inicial.tripletas.slice(3));
    assert.equal(subidas[2], 4096);

    const ampliada = lanzar(2 * n, 5);
    assert.equal(ampliada.desde[2 * n], 6 * n);
    assert.deepEqual(ampliada.tripletas.slice(0, 3 * n), cambiada.tripletas);
    assert.deepEqual(ampliada.tripletas.slice(-3), Float64Array.of(9, 0, 20));
    assert.ok(subidas[3]! > subidas[0]!);
  } finally {
    perfil.unsubscribe(contar);
    paso.cerrar();
    canal.cerrar();
  }
});
