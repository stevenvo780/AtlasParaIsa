/**
 * La percepción de F2 repartida por el proceso, probada por la entrada real (`createWorld` + `stepWorld` con
 * `motor.hilos` y `motor.gpu`): la piscina de M1 da el mismo mundo que un hilo, una ranura que cambia de ocupante no
 * le pasa nada del anterior, y con las tarjetas de M3 las filas casan con las de CPU por estadística (no por paridad) y
 * un servidor CUDA que muere a media fase no pierde el tick.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, stepWorld, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { DEFAULT_PARAMS, paramsOf, parseParams, setParams, type WorldParams } from '../src/world/params.js';
import { hostOpenWorldParams } from '../src/server/hardware-limits.js';
import { comprobarInvariantes } from '../src/world/invariantes.js';
import { closeEcosystemWorkers } from '../src/world/ecosystem.js';
import { founderPolicy } from '../src/world/politica.js';
import { COLUMNAS_CEREBRO, REF_NULA, slotDe, type LotePercepcion, type Plan } from '../src/world/motor/contratos.js';
import { organismosDe } from '../src/world/soa/organismos-mundo.js';
import { PercibidorCpu, percepcionDe, registrarPercibidores, type PercepcionCpu, type PercibidorCompartido, type VistaMundo } from '../src/world/decision/percepcion.js';
import { cerrarPercibidores, cpuDelProceso, percibidorDelProceso, PercibidorPiscina, PercibidorTarjetas } from '../src/world/decision/despacho.js';
import type { LoteGpuMedido } from '../src/world/gpu/puente.js';

const ABIERTO = parseParams({ motor: { ...hostOpenWorldParams().motor, hilos: 1, gpu: [] } }, hostOpenWorldParams());
const conMotor = (p: WorldParams, motor: Partial<WorldParams['motor']>) => parseParams({ motor: { ...p.motor, ...motor } }, p);
const sinGpu = !process.env.COMPUTE_NVRTC && 'Se requiere COMPUTE_NVRTC y dos tarjetas CUDA';

/** `motor.hilos` y `motor.gpu` entran en el digesto; el estado del mundo no debe depender de ellos. */
function digestoComo(world: World, referencia: World): string {
  const propios = paramsOf(world);
  setParams(world, paramsOf(referencia));
  try { return digestoCanonico(world); } finally { setParams(world, propios); }
}

function correr(seed: number, params: WorldParams, pasos: number, percibidores = true): World {
  registrarPercibidores(percibidores ? percibidorDelProceso : undefined);
  try {
    const world = createWorld(seed, params);
    for (let i = 0; i < pasos; i++) stepWorld(world);
    return world;
  } finally { registrarPercibidores(percibidorDelProceso); }
}

test.after(async () => { await cerrarPercibidores(); await closeEcosystemWorkers(); });

test('por la entrada real, 32 hilos en tandas de una fila acaban en el mismo mundo que un hilo', () => {
  const piscina = cpuDelProceso(32) as PercibidorPiscina;
  piscina.tanda = 1;
  try {
    for (const [seed, base, pasos] of [[7, DEFAULT_PARAMS, 1200], [51926, ABIERTO, 1200]] as const) {
      const uno = correr(seed, base, pasos, false);
      piscina.medidas();
      const antes = Array.from(piscina.filas);
      const world = correr(seed, conMotor(base, { hilos: 32 }), pasos);
      assert.equal(percepcionDe(world).percibidor, piscina);
      assert.equal(percepcionDe(world).respaldos, 0);
      const m = piscina.medidas(), filas = Array.from(piscina.filas, (f, i) => f - antes[i]!);
      assert.ok(m.enPiscina > 0 && filas.filter(f => f > 0).length > 1, `semilla ${seed}: ${m.enPiscina} despachos en la piscina, filas por hilo ${filas.join(' ')}`);
      assert.equal(digestoComo(world, uno), digestoCanonico(uno), `semilla ${seed}`);
    }
  } finally { piscina.tanda = 64; }
});

test('una persona que recibe la ranura de otro organismo no hereda su uid, su gen ni su cerebro', () => {
  registrarPercibidores(percibidorDelProceso);
  const world = createWorld(51926, conMotor(ABIERTO, { hilos: 8 }));
  const { personas, fauna, tabla } = organismosDe(world);
  // Personas y fauna comparten ranuras: la de una persona que muere suele tomarla un animal, y la de un animal, una cría.
  const ocupante = new Map<number, { organismo: object; uid: number | undefined; gen: number }>();
  let reusos = 0, conPesos = 0;
  for (let i = 0; i < 6000 && (reusos < 3 || conPesos < 1); i++) {
    stepWorld(world);
    const frente = tabla.lectura(), politica = frente.col('politica');
    for (const persona of world.people) {
      const s = personas.slot(persona), previo = s >= 0 ? ocupante.get(s) : undefined;
      if (!previo || previo.organismo === persona) continue;
      reusos++;
      assert.equal(frente.uid[s], persona.uid);
      assert.notEqual(persona.uid, previo.uid);
      assert.ok(frente.gen[s]! > previo.gen, 'la ranura cambió de gen');
      if (personas.pesosGen[s] !== frente.gen[s]) continue;
      conPesos++;
      const propios = (persona.policy ?? founderPolicy(world.seed, persona.id)).weights;
      for (let k = 0; k < COLUMNAS_CEREBRO.politica; k++) assert.equal(politica[s * COLUMNAS_CEREBRO.politica + k], propios[k], `peso ${k}`);
    }
    const anotar = (organismo: { uid?: number }, s: number) => { if (s >= 0) ocupante.set(s, { organismo, uid: organismo.uid, gen: frente.gen[s]! }); };
    for (const persona of world.people) anotar(persona, personas.slot(persona));
    for (const animal of world.animals) { const ref = fauna.ref(animal); if (ref !== REF_NULA) anotar(animal, slotDe(ref)); }
  }
  assert.ok(reusos > 0, 'alguna persona recibió la ranura de otro organismo');
  assert.ok(conPesos > 0, 'y se le escribieron sus pesos');
});

/** Percibe cada lote con `tarjetas` y, a la sombra, en CPU sobre la misma vista; acumula cuánto difieren. */
class Comparador implements PercibidorCompartido {
  readonly dispositivo = 'gpu0' as const;
  filas = 0; consultas = 0; celdasDistintas = 0; presenciaDistinta = 0; valorFuera = 0; utilidadMaxima = 0; filasIdenticas = 0;
  #sombra: PercibidorCpu | undefined; #vista: VistaMundo | undefined; #lote: LotePercepcion | undefined; #planes: readonly Plan[] | undefined;
  constructor(readonly tarjetas: PercibidorTarjetas) {}
  fuentes(vista: VistaMundo): void {
    this.tarjetas.fuentes(vista);
    if (vista !== this.#vista) { this.#vista = vista; this.#sombra = new PercibidorCpu(vista); }
  }
  lanzar(lote: LotePercepcion, planes: readonly Plan[]): void {
    this.#lote = lote; this.#planes = planes;
    this.tarjetas.lanzar(lote, planes);
  }
  esperar(plazoMs: number): PercepcionCpu {
    const gpu = this.tarjetas.esperar(plazoMs), lote = this.#lote!, planes = this.#planes!;
    this.#sombra!.lanzar(lote, planes);
    const cpu = this.#sombra!.esperar();
    for (let i = 0; i < lote.slots.length; i++) {
      this.filas++;
      let identica = true;
      for (let j = 0; j < cpu.q; j++) {
        const r = i * cpu.q + j;
        this.consultas++;
        if (gpu.celda[r] !== cpu.celda[r]) { this.celdasDistintas++; identica = false; }
        if ((gpu.celda[r] === -1) !== (cpu.celda[r] === -1)) this.presenciaDistinta++;
        else if (cpu.celda[r] !== -1 && !(Math.abs(gpu.valor[r]! - cpu.valor[r]!) <= 1e-5 * (1 + Math.abs(cpu.valor[r]!)))) this.valorFuera++;
      }
      if (planes[lote.plan[i]!]!.acciones) for (let k = 0; k < cpu.a; k++) {
        const e = Math.abs(gpu.utilidad[i * cpu.a + k]! - cpu.utilidad[i * cpu.a + k]!);
        this.utilidadMaxima = Math.max(this.utilidadMaxima, e);
        if (e) identica = false;
      }
      if (identica) this.filasIdenticas++;
    }
    return gpu;
  }
}

test('M3 CUDA real: con las tarjetas, las filas del mundo casan con las de CPU por estadística', { skip: sinGpu }, t => {
  const world = createWorld(51926, conMotor(ABIERTO, { hilos: 8, gpu: [0, 1] })), percepcion = percepcionDe(world);
  assert.ok(percepcion.percibidor instanceof PercibidorTarjetas, 'motor.gpu elige las tarjetas');
  const comparador = new Comparador(new PercibidorTarjetas([0, 1], cpuDelProceso(8)));
  percepcion.percibidor = comparador;
  try {
    for (let i = 0; i < 1200; i++) stepWorld(world);
    const c = comparador;
    t.diagnostic(JSON.stringify({ filas: c.filas, filasIdenticas: c.filasIdenticas, consultas: c.consultas, celdasDistintas: c.celdasDistintas,
      presenciaDistinta: c.presenciaDistinta, valorFuera: c.valorFuera, utilidadMaxima: c.utilidadMaxima, tramosEnCpu: c.tarjetas.tramosEnCpu,
      respaldos: percepcion.respaldos }));
    assert.equal(c.tarjetas.tarjetas, 2, 'las dos tarjetas siguen activas');
    assert.equal(percepcion.respaldos, 0);
    assert.ok(c.filas > 500, `${c.filas} filas comparadas`);
    // Los criterios de M3 (gpu-percibir): misma presencia, el mínimo salvo FP32 y la utilidad a ≤ 2e-5; el desempate
    // entre celdas de igual clave no es contractual, pero en un mundo real casi no ocurre.
    assert.equal(c.presenciaDistinta, 0);
    assert.equal(c.valorFuera, 0);
    assert.ok(c.utilidadMaxima <= 2e-5, `utilidad: ${c.utilidadMaxima}`);
    assert.ok(c.celdasDistintas <= 0.02 * c.consultas, `${c.celdasDistintas} de ${c.consultas} celdas distintas`);
  } finally { comparador.tarjetas.cerrar(); }
});

test('V24 CUDA real: la percepción residente usa las ventanas del despacho en el mismo tick', {
  skip: !process.env.COMPUTE_NVRTC && 'Se requiere COMPUTE_NVRTC',
}, async t => {
  const anterior = process.env.CARTA_PERCEPCION_RESIDENTE;
  process.env.CARTA_PERCEPCION_RESIDENTE = '1';
  const cpu = cpuDelProceso(1);
  const ventanasCpu = t.mock.method(cpu, 'ventanas');
  try {
    const world = createWorld(51926, conMotor(ABIERTO, { hilos: 1, gpu: [0] }));
    const percepcion = percepcionDe(world);
    const tarjetas = percepcion.percibidor;
    assert.ok(tarjetas instanceof PercibidorTarjetas && tarjetas.ventanasGpu);
    let filasGpu = 0;
    for (let i = 0; i < 8; i++) {
      stepWorld(world);
      filasGpu += tarjetas.ultimosLotes.filter(l => l.dispositivo === 'gpu0').reduce((total, l) => total + l.actores, 0);
    }
    assert.ok(filasGpu > 0);
    assert.equal(world.tick, 8);
    assert.equal(percepcion.respaldos, 0);
    assert.equal(ventanasCpu.mock.callCount(), 0);
  } finally {
    if (anterior === undefined) delete process.env.CARTA_PERCEPCION_RESIDENTE;
    else process.env.CARTA_PERCEPCION_RESIDENTE = anterior;
    await cerrarPercibidores();
  }
});

test('M3 CUDA real: matar el servidor de una tarjeta a media fase no pierde el tick', { skip: sinGpu }, () => {
  const world = createWorld(51926, conMotor(ABIERTO, { hilos: 8, gpu: [0, 1] })), percepcion = percepcionDe(world);
  const tarjetas = new PercibidorTarjetas([0, 1], cpuDelProceso(8));
  percepcion.percibidor = tarjetas;
  try {
    for (let i = 0; i < 100; i++) stepWorld(world);
    assert.equal(tarjetas.tarjetas, 2);
    const lanzar = tarjetas.lanzar.bind(tarjetas);
    let victima: string | undefined;
    tarjetas.lanzar = (lote, planes) => {
      // En el primer lote con alguien que decidir, la tarjeta que percibió más filas del anterior. Parada antes de la
      // orden, no puede contestar antes de morir.
      const ultima = [...tarjetas.ultimosLotes].filter(l => l.dispositivo !== 'cpu').sort((a, b) => b.actores - a.actores)[0];
      const servidor = ultima && tarjetas.pids().find(p => `gpu${p.dispositivo}` === ultima.dispositivo);
      const matar = !victima && lote.slots.length > 0 && servidor;
      if (matar) process.kill(servidor.pid, 'SIGSTOP');
      lanzar(lote, planes);
      if (matar) { process.kill(servidor.pid, 'SIGKILL'); victima = ultima.dispositivo; }
    };
    // Desde la caída, cada tick se completa; en el primero en que la tarjeta caída tenía filas (lo normal: el mismo), su
    // tramo se percibe en CPU dentro del tick y la tarjeta queda apagada para el resto del proceso.
    const antes = tarjetas.tramosEnCpu;
    let lotes: readonly LoteGpuMedido[] = [];
    for (let i = 0; i < 600 && (!victima || tarjetas.tarjetas === 2); i++) {
      const tick = world.tick;
      stepWorld(world);
      assert.equal(world.tick, tick + 1, 'el tick se completó');
      if (victima && !lotes.length) lotes = tarjetas.ultimosLotes;
    }
    assert.ok(victima, 'algún lote tuvo a alguien que decidir');
    assert.equal(tarjetas.tarjetas, 1, `la tarjeta caída (${victima}) queda apagada`);
    assert.ok(tarjetas.tramosEnCpu > antes, 'su tramo se percibió en CPU');
    assert.ok(lotes.some(l => l.dispositivo === 'cpu' && l.actores > 0) && !lotes.some(l => l.dispositivo === victima),
      `en el tick de la caída: ${JSON.stringify(lotes)}`);
    for (let i = 0; i < 100; i++) stepWorld(world);
    assert.equal(percepcion.respaldos, 0);
    assert.deepEqual(comprobarInvariantes(world), []);
  } finally { tarjetas.cerrar(); }
});
