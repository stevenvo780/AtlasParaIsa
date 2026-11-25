import assert from 'node:assert/strict';
import test from 'node:test';
import { calcularVentana } from '../src/world/decision/percepcion.js';
import { CanalCompartido } from '../src/world/gpu/canal.js';
import { CELDAS_VENTANA_GPU, PercibidorGpu, tieneVentanas } from '../src/world/gpu/percibir-gpu.js';
import { PuentePercepcion } from '../src/world/gpu/puente.js';
import { ErrorDispositivo, type CanalGpu, type LotePercepcion, type Percibidor, type Plan } from '../src/world/motor/contratos.js';
import { crearFixtureGpu } from './fixtures/gpu-percibir.js';

const CENTRO = 112;

class CanalVentana implements CanalGpu {
  dispositivo = 0;
  memoria = new Uint8Array();
  orden!: { tick: number; despacho: number; salida: number; bajada: number };
  parchesTerreno: number[] = [];
  ventana = new Uint8Array(CELDAS_VENTANA_GPU).fill(255);
  get bytes() { return this.memoria.length; }
  crecer(n: number) { this.memoria = new Uint8Array(n); }
  escribir(offset: number, v: ArrayBufferView) { this.memoria.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), offset); }
  leer(offset: number, v: ArrayBufferView) {
    new Uint8Array(v.buffer, v.byteOffset, v.byteLength).set(this.memoria.subarray(offset, offset + v.byteLength));
  }
  enviar(datos: Uint8Array) {
    this.orden = JSON.parse(Buffer.from(datos).toString());
    const d = new DataView(this.memoria.buffer);
    this.parchesTerreno = [];
    for (let i = 0; i < d.getUint32(52, true); i++) {
      const parche = d.getUint32(48, true) + 16 * i;
      if (d.getUint32(parche, true) === 0) this.parchesTerreno.push(d.getUint32(parche + 4, true));
    }
    assert.equal(d.getUint32(56, true), 1);
  }
  recibir() {
    const { tick, despacho, salida, bajada } = this.orden;
    this.memoria.set(this.ventana, salida + bajada - this.ventana.length);
    return Buffer.from(JSON.stringify({ ok: true, ms: 1, tick, despacho }));
  }
  cerrar() {}
}

test('G recibe rutas y transitabilidad de la tarjeta, incluidos centro bloqueado y salto de página', () => {
  const { frente, terreno } = crearFixtureGpu();
  const canal = new CanalVentana(), gpu = new PercibidorGpu(canal, frente, terreno, true);
  const p: Plan = { id: 0, transitable: new Float32Array(), celdas: [], organismos: [], acciones: 0, w: null };
  const lote = { tick: 7, despacho: 20, slots: Int32Array.of(0), plan: Uint16Array.of(0) };
  (frente.x as Float32Array)[0] = -1;
  (frente.y as Float32Array)[0] = 0;
  canal.ventana[CENTRO] = 253;
  canal.ventana[CENTRO + 1] = 1;
  canal.ventana[CENTRO + 2] = 254;
  gpu.lanzar(lote, [p]);
  const r = gpu.esperar(100);
  assert.ok(tieneVentanas(r));
  assert.equal(canal.orden.bajada, CELDAS_VENTANA_GPU);
  assert.deepEqual([...r.ventana.slice(CENTRO - 1, CENTRO + 3)], [-2, 0, 1, -1]);
  assert.deepEqual([...r.ventanaCelda.slice(CENTRO - 1, CENTRO + 3)], [-1, -1, terreno.celda(0, 0), terreno.celda(1, 0)]);
  canal.ventana[CENTRO] = 255;
  gpu.lanzar(lote, [p]);
  assert.throws(() => gpu.esperar(100), ErrorDispositivo);
});

test('G una página marcada vuelve a subir solo las columnas que cambiaron', () => {
  const { frente, terreno } = crearFixtureGpu();
  (frente.x as Float32Array)[0] = 7;
  (frente.y as Float32Array)[0] = 7;
  const celda = terreno.celda(7, 7);
  assert.ok(celda >= 0);
  const pagina = terreno.chunkDe(celda);
  assert.equal(terreno.chunkDe(terreno.celda(0, 0)), pagina);
  const p: Plan = { id: 0, transitable: Float32Array.of(0, 0, 1, 1, 0, 1), celdas: [], organismos: [], acciones: 0, w: null };
  const canal = new CanalVentana(), gpu = new PercibidorGpu(canal, frente, terreno, true);
  canal.ventana[CENTRO] = 0;
  const lote = { tick: 7, despacho: 20, slots: Int32Array.of(0), plan: Uint16Array.of(0) };
  const verificar = (columnas: number[]) => {
    gpu.lanzar(lote, [p]);
    assert.deepEqual(canal.parchesTerreno, columnas.map(i => (pagina * 2 + i) * 256 * 8));
    gpu.esperar(100);
  };
  verificar([0, 1]);
  terreno.versionPagina[pagina]++;
  verificar([]);
  (terreno.campo('comida') as Float32Array)[celda] = -1;
  terreno.versionPagina[pagina]++;
  verificar([1]);
});

function tarjeta(dispositivo: Percibidor['dispositivo'], multiprocesadores: number, ampliar = 0) {
  let lote: LotePercepcion;
  const percibidor = {
    dispositivo, ultimasTransferencias: { subidos: 0, bajados: 0, ms: dispositivo === 'gpu0' ? 1 : 4 },
    lanzar(l: LotePercepcion) { lote = l; },
    esperar() {
      const n = lote.slots.length + ampliar;
      const ventana = new Int16Array(n * CELDAS_VENTANA_GPU).fill(-2);
      const ventanaCelda = new Int32Array(ventana.length).fill(-1);
      for (let i = 0; i < lote.slots.length; i++) ventanaCelda[i * CELDAS_VENTANA_GPU + CENTRO] = lote.slots[i];
      return { q: 1, v: 0, a: 0, tick: lote.tick, despacho: lote.despacho,
        celda: new Int32Array(n), pasos: new Int16Array(n), valor: new Float32Array(n),
        organismo: new Float64Array(), utilidad: new Float32Array(), ventana, ventanaCelda };
    },
  };
  return { percibidor, multiprocesadores, cerrar() {} };
}

test('G conserva el orden de las ventanas y evita una tanda menor que los SM de la tarjeta lenta', () => {
  const rapida = tarjeta('gpu0', 16), lenta = tarjeta('gpu1', 8), cpu = tarjeta('cpu', 0, 16);
  const puente = new PuentePercepcion(cpu.percibidor, [rapida, lenta], true);
  const lanzar = (n: number) => {
    const slots = Int32Array.from({ length: n }, (_, i) => n - i);
    puente.lanzar({ tick: 2, despacho: 3, slots, plan: new Uint16Array(n) }, []);
    const r = puente.esperar(1_000);
    assert.ok(tieneVentanas(r));
    assert.deepEqual(Array.from(slots, (_, i) => r.ventanaCelda[i * CELDAS_VENTANA_GPU + CENTRO]), [...slots]);
  };
  lanzar(32);
  assert.deepEqual(puente.ultimosLotes.map(l => l.dispositivo), ['gpu0']);
  lanzar(1_024);
  assert.deepEqual(puente.ultimosLotes.map(l => l.dispositivo), ['gpu0', 'gpu1']);
  lenta.percibidor.esperar = () => { throw new ErrorDispositivo('gpu1', 'caída de prueba'); };
  lanzar(1_024);
  assert.deepEqual(puente.ultimosLotes.map(l => l.dispositivo), ['gpu0', 'cpu']);
});

test('G CUDA real devuelve el BFS completo en un plan sin consultas de celdas', {
  skip: !process.env.COMPUTE_NVRTC && 'Se requiere COMPUTE_NVRTC',
}, () => {
  const { frente, terreno } = crearFixtureGpu();
  (frente.x as Float32Array)[0] = -1;
  (frente.y as Float32Array)[0] = 0;
  const p: Plan = { id: 0, transitable: Float32Array.of(0, 0, 0.2), celdas: [], organismos: [], acciones: 0, w: null };
  const lote = { tick: 7, despacho: 20, slots: Int32Array.of(0), plan: Uint16Array.of(0) };
  const pasos = new Int16Array(CELDAS_VENTANA_GPU), celdas = new Int32Array(CELDAS_VENTANA_GPU);
  calcularVentana(terreno, -1, 0, p.transitable, pasos, celdas, 0);
  const canal = new CanalCompartido(0);
  try {
    canal.iniciar(30_000);
    const gpu = new PercibidorGpu(canal, frente, terreno, true);
    gpu.lanzar(lote, [p]);
    const r = gpu.esperar(2_000);
    assert.ok(tieneVentanas(r));
    assert.deepEqual(r.ventana, pasos);
    assert.deepEqual(r.ventanaCelda, celdas);
  } finally { canal.cerrar(); }
});
