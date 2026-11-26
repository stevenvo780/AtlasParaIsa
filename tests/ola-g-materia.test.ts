import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaseSustancia } from '../src/shared/materia.js';
import { CAPACIDAD_ATOMO } from '../src/shared/naturaleza.js';
import { CanalCompartido } from '../src/world/gpu/canal.js';
import { aplicarVecesGpu, crearPasoMateriaGpu, empaquetarMateriaGpu, prepararMateriaGpu } from '../src/world/gpu/materia-gpu.js';
import { ServicioQuimicoImpl } from '../src/world/materia/servicio.js';
import type { CtxPaso } from '../src/world/materia/paso.js';
import type { Reaccion, Sustancia } from '../src/world/materia/tipos.js';
import { ErrorDispositivo, type CanalGpu } from '../src/world/motor/contratos.js';

function reaccion(a: number, b: number, producto: number, dH: number, ea: number): Reaccion {
  return { a, b, nivelT: 2, dH, ea, catalisis: 3, paresCatalisis: 2,
    entradas: b > 0 ? [{ id: a, nu: 2 }, { id: b, nu: 1 }] : [{ id: a, nu: 1 }],
    salidas: [{ id: producto, nu: 1 }] };
}

function fixture() {
  const reacciones = [reaccion(9, 0, 13, -100, 200), reaccion(13, 11, 16, -100, 200),
    reaccion(16, 0, 17, 10, 200)];
  // La pareja llega ordenada por id. La reacción conserva sus coeficientes independientemente del orden de sus términos.
  reacciones[1] = { ...reacciones[1]!, a: 11, b: 13 };
  const cantidades = new Map([[9, 20], [11, 20]]);
  const consultas: [number, number, number][] = [];
  const aplicaciones: [number, Reaccion, number][] = [];
  const quimica = {
    sustancia(id: number) {
      return { atomos: Uint16Array.of(id === 16 || id === 17 ? 3 : 1), masa: 10, clase: ClaseSustancia.Molecula,
        prop: { tEbullicion: id === 16 ? 100 : 300, densidad: 2 } } as unknown as Sustancia;
    },
    reaccion(a: number, b: number, nivel: number) {
      consultas.push([a, b, nivel]);
      return reacciones.find(r => r.a === a && r.b === b && r.nivelT === nivel) ?? null;
    },
    internar() { throw new Error('El despacho no interna sustancias.'); },
  };
  const arena = {
    propio: (id: number) => id === 1 || id === 2,
    vivo: (id: number) => id !== 3,
    calor: () => 270 * 40 * CAPACIDAD_ATOMO,
    especies(_id: number, salida: Uint32Array) { salida.set([11, 9]); return 2; },
    cuantos: (_id: number, especie: number) => cantidades.get(especie)!,
    aplicar(lote: number, reaccion: Reaccion, veces: number) {
      aplicaciones.push([lote, reaccion, veces]);
      return veces;
    },
  } as unknown as CtxPaso['arena'];
  const ctx: CtxPaso = { arena, quimica, azar: () => 0.25 };
  const kappa = [0, 0, 0, 100];
  return { ctx, consultas, aplicaciones, reacciones, kappa };
}

test('G empaqueta composición, catálisis, nivel y tabla compartida con productos encadenados', () => {
  const { ctx, consultas, reacciones, kappa } = fixture();
  const { binario, maxTripletas, limites, nEspecies, nCanales } =
    empaquetarMateriaGpu(ctx, [1, 3, 2], [...kappa, 0, 0, 0, 0, ...kappa], 0.5);
  const d = new DataView(binario);
  const u = (off: number) => d.getUint32(off, true);
  const f = (off: number) => d.getFloat64(off, true);
  const lote = 72, nivel = lote + 56;
  assert.equal(f(0), 0.5);
  assert.equal(f(lote), ctx.arena.calor(1));
  assert.deepEqual(kappa.map((_, i) => f(lote + 8 + 8 * i)), kappa);
  assert.equal(u(nivel), 2);
  assert.equal(u(nivel + 4), 2 ** 30);
  assert.equal(u(lote + 64 + 44), 0);
  assert.equal(u(lote + 64 + 52), 0);
  assert.deepEqual([...limites], [27, 0, 27]);
  assert.equal(nEspecies, 10);
  assert.equal(nCanales, 6);
  assert.equal(maxTripletas, 54);
  assert.equal(consultas.length, new Set(consultas.map(x => x.join(':'))).size);

  const leerId = (indice: number) => u(u(56) + 32 * indice + 24);
  const composicion = (off: number) => Array.from({ length: u(off + 44) }, (_, i) => {
    const s = u(off + 40) + 16 * i;
    return [leerId(u(s + 8)), f(s)];
  });
  assert.deepEqual(composicion(lote), [[9, 20], [11, 20], [13, 0], [16, 0], [17, 0]]);
  assert.deepEqual(composicion(lote + 128), composicion(lote));
  const tabla = u(60), terminos = u(64);
  for (const [i, r] of reacciones.entries()) {
    const off = tabla + 48 * i;
    assert.deepEqual([f(off), f(off + 8), u(off + 16), u(off + 20), u(off + 24)], [r.dH, r.ea, r.a, r.b, 2]);
    assert.deepEqual([d.getInt32(off + 28, true), u(off + 32)], [3, 2]);
    const entradas = u(off + 40), salidas = u(off + 44);
    assert.equal(entradas, r.entradas.length);
    assert.equal(salidas, r.salidas.length);
    const ini = terminos + 8 * u(off + 36);
    assert.deepEqual(Array.from({ length: entradas + salidas }, (_, k) => ({
      id: leerId(u(ini + 8 * k)), nu: u(ini + 8 * k + 4),
    })), [...r.entradas, ...r.salidas]);
  }
  const propiedades16 = u(56) + 3 * 32;
  assert.deepEqual([f(propiedades16), f(propiedades16 + 8), f(propiedades16 + 16), u(propiedades16 + 28)],
    [3, 100, 5e-6, 1]);
});

test('G rechaza el lote vivo de otro dueño y conserva los offsets del lote vacío', () => {
  const { ctx, kappa } = fixture();
  assert.throws(() => empaquetarMateriaGpu(ctx, [4], kappa, 1), /otro dueño/);
  const paso = crearPasoMateriaGpu({ dispositivo: 0 } as CanalGpu);
  paso.lanzar(ctx, [3], kappa, 1, 2);
  const r = paso.esperar(100);
  assert.deepEqual([...r.desde], [0, 0]);
  assert.equal(r.tripletas.length, 0);
});

class CanalMemoria implements CanalGpu {
  dispositivo = 0;
  memoria = new Uint8Array();
  orden!: { tick: number; despacho: number; salida: number; cabecera: number };
  cerrado = false;
  ecoRancio = false;
  offsetMalo = false;
  fallo?: ErrorDispositivo;
  get bytes() { return this.memoria.length; }
  crecer(bytes: number) { this.memoria = new Uint8Array(bytes); }
  escribir(desde: number, datos: ArrayBufferView) {
    this.memoria.set(new Uint8Array(datos.buffer, datos.byteOffset, datos.byteLength), desde);
  }
  leer(desde: number, destino: ArrayBufferView) {
    new Uint8Array(destino.buffer, destino.byteOffset, destino.byteLength).set(this.memoria.subarray(desde, desde + destino.byteLength));
  }
  enviar(orden: Uint8Array) { this.orden = JSON.parse(Buffer.from(orden).toString()); }
  recibir() {
    if (this.fallo) throw this.fallo;
    const { tick, despacho, salida, cabecera } = this.orden;
    this.escribir(salida, Int32Array.of(0, this.offsetMalo ? 4 : 3));
    this.escribir(salida + cabecera, Float64Array.of(9, 0, 20));
    return Buffer.from(JSON.stringify({ ok: true, tick, despacho: despacho - Number(this.ecoRancio), tripletas: 1 }));
  }
  cerrar() { this.cerrado = true; }
}

test('G material comparte el tramo SHM, comprueba ambos ecos y rechaza offsets dañados', () => {
  const { ctx, kappa } = fixture();
  const canal = new CanalMemoria();
  const a = crearPasoMateriaGpu(canal), b = crearPasoMateriaGpu(canal);
  a.lanzar(ctx, [1], kappa, 1, 7);
  assert.throws(() => b.lanzar(ctx, [1], kappa, 1, 7), ErrorDispositivo);
  assert.equal(canal.cerrado, false);
  const r = a.esperar(100);
  assert.deepEqual([...r.desde], [0, 3]);
  assert.deepEqual([...r.tripletas], [9, 0, 20]);
  b.lanzar(ctx, [1], kappa, 1, 7);
  canal.ecoRancio = true;
  assert.throws(() => b.esperar(100), ErrorDispositivo);
  assert.ok(canal.cerrado);

  const dañado = new CanalMemoria(), paso = crearPasoMateriaGpu(dañado);
  dañado.offsetMalo = true;
  paso.lanzar(ctx, [1], kappa, 1, 8);
  assert.throws(() => paso.esperar(100), /Offsets inválidos/);
});

test('G confirma el nivel de todas las tripletas antes de aplicar con la arena del dueño', () => {
  const { ctx, kappa, reacciones, aplicaciones } = fixture();
  const desde = Int32Array.of(0, 6, 6);
  const kappas = [...kappa, 0, 0, 0, 0];
  const tripletas = Float64Array.of(9, 0, 20, 11, 17, 10);
  assert.throws(() => aplicarVecesGpu(ctx, [1, 3], kappas, { desde, tripletas }, 1), /en el nivel 2/);
  assert.deepEqual(aplicaciones, []);
  tripletas[4] = 13;
  assert.equal(aplicarVecesGpu(ctx, [1, 3], kappas, { desde, tripletas }, 1), 30);
  assert.deepEqual(aplicaciones, [[1, reacciones[0], 20], [1, reacciones[1], 10]]);
});

test('G invalida el cliente al vencer o caer el dispositivo durante la espera', () => {
  const { ctx, kappa } = fixture();
  for (const motivo of ['Venció el plazo', 'El servidor se cerró']) {
    const canal = new CanalMemoria(), paso = crearPasoMateriaGpu(canal);
    const fallo = canal.fallo = new ErrorDispositivo('gpu0', motivo);
    paso.lanzar(ctx, [1], kappa, 1, 7);
    assert.throws(() => paso.esperar(100), fallo);
    assert.ok(canal.cerrado);
    assert.throws(() => paso.lanzar(ctx, [1], kappa, 1, 8), fallo);
  }
});

const dispositivo = Number(process.env.CARTA_TEST_MATERIA_GPU_DEVICE ?? 0);

test('G CUDA real aplica catálisis por par, encadena con composición nueva y veta por fase a 270 K', {
  skip: !process.env.COMPUTE_NVRTC && 'Se requiere COMPUTE_NVRTC',
}, () => {
  const { ctx, kappa } = fixture();
  const canal = new CanalCompartido(dispositivo);
  try {
    prepararMateriaGpu(canal, 30_000);
    const paso = crearPasoMateriaGpu(canal);
    paso.lanzar(ctx, [1, 3], [...kappa, 0, 0, 0, 0], 1, 1);
    const r = paso.esperar(2_000);
    assert.deepEqual([...r.desde], [0, 6, 6]);
    assert.deepEqual([...r.tripletas], [9, 0, 20, 11, 13, 10]);
  } finally { canal.cerrar(); }
});

test('G CUDA solo devuelve a CPU los lotes que alcanzan una reacción sin resolver', {
  skip: !process.env.COMPUTE_NVRTC && 'Se requiere COMPUTE_NVRTC',
}, () => {
  const { ctx, consultas, kappa, reacciones, aplicaciones } = fixture();
  const quimica = Object.assign(new ServicioQuimicoImpl({ modo: 'inmediato' }), ctx.quimica);
  const real = { ...ctx, quimica };
  const canal = new CanalCompartido(dispositivo);
  try {
    prepararMateriaGpu(canal, 30_000);
    const paso = crearPasoMateriaGpu(canal);
    paso.lanzar(real, [1], kappa, 1, 1);
    assert.ok(consultas.length > 0);
    assert.ok(consultas.every(([a, b]) => a !== 13 && b !== 13));
    const pendiente = paso.esperar(2_000);
    assert.deepEqual([...pendiente.desde], [0, 3]);
    assert.deepEqual([...pendiente.tripletas], [0, 0, 0]);
    assert.equal(aplicarVecesGpu(real, [1], kappa, pendiente, 1), 20);
    assert.ok(aplicaciones.length > 0);

    reacciones[0] = { ...reacciones[0]!, dH: 10 };
    paso.lanzar(real, [1], kappa, 1, 2);
    const inerte = paso.esperar(2_000);
    assert.deepEqual([...inerte.desde], [0, 0]);
    assert.equal(inerte.tripletas.length, 0);
  } finally { canal.cerrar(); }
});
