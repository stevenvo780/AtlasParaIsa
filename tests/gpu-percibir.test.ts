import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CanalCompartido, enviarOrden, recibirRespuesta } from '../src/world/gpu/canal.js';
import { observarPercepcionGpu } from '../src/world/gpu/invariantes.js';
import { PercibidorGpu } from '../src/world/gpu/percibir-gpu.js';
import { crearPuentePercepcion, PuentePercepcion, type LoteGpuMedido } from '../src/world/gpu/puente.js';
import { comprobarInvariantes } from '../src/world/invariantes.js';
import type { World } from '../src/world/mundo/tipos.js';
import {
  CEREBRO, Clase, ErrorDispositivo, RASGOS_ANCHO, REF_NULA, genDe, refDe, slotDe,
  type Dispositivo, type LotePercepcion, type Percibidor, type Percepcion, type Plan,
} from '../src/world/motor/contratos.js';
import { evaluatePolicySingle, POLICY_ACTIONS, POLICY_WEIGHTS } from '../src/world/politica.js';
import { crearFixtureGpu, type OpcionesFixture } from './fixtures/gpu-percibir.js';
import { PercibidorCpu } from './fixtures/percibir-cpu.js';

const SERVIDOR_PRUEBA = fileURLToPath(new URL('./fixtures/fallo-gpu-percibir.py', import.meta.url));
const PLAZO_MS = 2_000;
const LIMITE_MS = 3;
const LIMITE_BYTES = 2_000_000;
type Fixture = ReturnType<typeof crearFixtureGpu>;

function canalDePrueba(fase: string, ejecutar: (canal: CanalCompartido, marca: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-prueba-m3-'));
  const marca = join(dir, 'fase');
  let canal: CanalCompartido | undefined;
  try {
    canal = new CanalCompartido(0, {
      script: SERVIDOR_PRUEBA,
      entorno: { CARTA_GPU_PRUEBA_FASE: fase, CARTA_GPU_PRUEBA_MARCA: marca },
    });
    ejecutar(canal, marca);
  } finally {
    canal?.cerrar();
    rmSync(dir, { recursive: true, force: true });
  }
}

const segmentosM3 = () => readdirSync('/dev/shm').filter(nombre => nombre.startsWith('atlas-m3-'));

/** Un zombi ya no es un proceso vivo: su padre murió o aún no lo recogió. */
function vivo(pid: number): boolean {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z'; }
  catch { return false; }
}

async function esperarMuerte(pid: number, plazoMs = 10_000): Promise<void> {
  const fin = performance.now() + plazoMs;
  while (vivo(pid) && performance.now() < fin) await new Promise(r => setTimeout(r, 20));
  assert.equal(vivo(pid), false, `el servidor ${pid} sigue vivo`);
}

function percibir(p: Percibidor, lote: LotePercepcion, planes: readonly Plan[], plazo = PLAZO_MS): Percepcion {
  p.lanzar(lote, planes);
  return p.esperar(plazo);
}

test('M3 canal SHM por descriptor: subvista, FIFO y crecimiento entre órdenes', () => {
  canalDePrueba('canal', canal => {
    canal.iniciar(PLAZO_MS);
    canal.crecer(16);
    canal.escribir(4, Uint32Array.of(91, 52, 24).subarray(1));
    enviarOrden(canal, { desde: 4 });
    enviarOrden(canal, { desde: 8 });
    assert.deepEqual(recibirRespuesta(canal, PLAZO_MS), { valor: 52 });
    assert.deepEqual(recibirRespuesta(canal, PLAZO_MS), { valor: 24 });
    const destino = new Uint32Array(3).fill(999);
    canal.leer(4, destino.subarray(1));
    assert.deepEqual([...destino], [999, 53, 25]);

    canal.crecer(2 ** 20 + 4);
    canal.escribir(2 ** 20, Uint32Array.of(12));
    enviarOrden(canal, { desde: 2 ** 20 });
    assert.deepEqual(recibirRespuesta(canal, PLAZO_MS), { valor: 12 });
    assert.throws(() => canal.leer(canal.bytes - 3, Uint32Array.of(0)), RangeError);
    canal.cerrar();
    assert.throws(() => canal.enviar(new Uint8Array()), ErrorDispositivo);
  });
});

test('M3 cerrar, matar el servidor o matar el motor no deja procesos de Python ni segmentos en /dev/shm', async () => {
  const antes = segmentosM3();
  const entorno = { CARTA_GPU_PRUEBA_FASE: 'canal', CARTA_GPU_PRUEBA_MARCA: '/dev/null' };
  const abierto = new CanalCompartido(0, { script: SERVIDOR_PRUEBA, entorno });
  abierto.iniciar(PLAZO_MS);
  assert.deepEqual(segmentosM3(), antes, 'los nombres del canal se borran al abrirlo');
  const pid = abierto.pid!;
  abierto.cerrar();
  await esperarMuerte(pid);

  // Cerrar antes de que el worker arranque al servidor también lo mata en cuanto existe.
  const prematuro = new CanalCompartido(0, { script: SERVIDOR_PRUEBA, entorno });
  prematuro.cerrar();
  const fin = performance.now() + 10_000;
  while (!prematuro.pid && performance.now() < fin) await new Promise(r => setTimeout(r, 20));
  if (prematuro.pid) await esperarMuerte(prematuro.pid);

  const caido = new CanalCompartido(0, { script: SERVIDOR_PRUEBA, entorno });
  caido.iniciar(PLAZO_MS);
  process.kill(caido.pid!, 'SIGKILL');
  await esperarMuerte(caido.pid!);
  assert.throws(() => enviarOrden(caido, { desde: 0 }), ErrorDispositivo);
  assert.throws(() => caido.recibir(PLAZO_MS), ErrorDispositivo);
  caido.cerrar();

  // Un motor que muere sin cerrar: el servidor ve EOF en sus órdenes y termina solo.
  const motor = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/canal-huerfano.ts', import.meta.url))],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 60_000 });
  assert.equal(motor.signal, 'SIGKILL');
  const huerfano = Number(motor.stdout.trim());
  assert.ok(Number.isSafeInteger(huerfano) && huerfano > 0, `pid del servidor huérfano: ${motor.stdout}`);
  await esperarMuerte(huerfano);
  assert.deepEqual(segmentosM3(), antes);
});

test('M3 CPU distingue ruta, visibilidad, criterio de organismos, generación, red (con la plasticidad dentro) y W·rasgos', () => {
  const { frente, terreno, planes } = crearFixtureGpu();
  const agua = terreno.campo('agua') as Float32Array;
  const comida = terreno.campo('comida') as Float32Array;
  agua.fill(1);
  comida.fill(0);
  for (const [x, y] of [[0, 0], [0, 1], [1, 1], [2, 1], [2, 0], [4, 0]]) agua[terreno.celda(x, y)] = 0;
  const cerca = terreno.celda(2, 0), lejos = terreno.celda(4, 0);
  comida[cerca] = 0.65;
  comida[lejos] = 0.98;
  (frente.vivo as Uint8Array).fill(0);
  (frente.x as Float32Array).set([0, -2, 3]);
  (frente.y as Float32Array).fill(0, 0, 3);
  (frente.chunk as Int32Array).set([terreno.chunkDe(terreno.celda(0, 0)), terreno.chunkDe(terreno.celda(-2, 0)), terreno.chunkDe(terreno.celda(3, 0))]);
  (frente.vivo as Uint8Array).set([1, 1, 1]);
  (frente.clase as Uint8Array).set([Clase.Persona, Clase.Animal, Clase.Animal]);
  (frente.gen as Int32Array)[2] = (2 ** 21) - 1;
  (frente.cuerpo as Float32Array).fill(0.2, 0, 14);
  (frente.cuerpo as Float32Array).fill(0.9, 14, 21);
  const base = planes[0];
  const consulta = { ...base.celdas[0], pesoDist: 0, pesoPasos: 0 };
  const queridas: Plan = {
    ...base,
    celdas: [consulta, { ...consulta, alcanzable: false }],
    organismos: [base.organismos[0], { ...base.organismos[1], clase: Clase.Animal }],
  };
  // El segundo plan es el de las personas de M2b: cerebro sin cabeza lineal (w = null).
  const lote = { tick: 100, despacho: 7, slots: Int32Array.of(0, 0), plan: Uint16Array.of(0, 1) };
  const resultado = percibir(new PercibidorCpu(frente, terreno), lote, [queridas, { ...queridas, id: 1, w: null }]);
  assert.deepEqual([resultado.tick, resultado.despacho], [100, 7], 'eco del lote');
  assert.deepEqual([...resultado.celda.subarray(0, 2)], [cerca, lejos]);
  assert.deepEqual([...resultado.pasos.subarray(0, 2)], [4, -1]);
  assert.deepEqual([...resultado.organismo.subarray(0, 2)], [refDe(1, frente.gen[1]), refDe(2, frente.gen[2])]);
  const red = evaluatePolicySingle(
    Float64Array.from(Array.from({ length: CEREBRO.entradas }, (_, j) => frente.col('observacion')[j])),
    Float64Array.from(Array.from({ length: POLICY_WEIGHTS }, (_, j) => frente.col('politica')[j])),
    Array.from({ length: CEREBRO.acciones }, (_, j) => frente.col('sesgo')[j]),
  );
  for (let a = 0; a < CEREBRO.acciones; a++) {
    let utilidad = red[a];
    for (let r = 0; r < RASGOS_ANCHO; r++) utilidad += base.w![a * RASGOS_ANCHO + r] * frente.rasgos[r];
    assert.ok(Math.abs(resultado.utilidad[a] - utilidad) <= 2e-6, `utilidad ${POLICY_ACTIONS[a]}`);
    assert.ok(Math.abs(resultado.utilidad[CEREBRO.acciones + a] - red[a]) <= 2e-6, `utilidad sin W ${POLICY_ACTIONS[a]}`);
  }
});

function rastrear(base: Percibidor, dispositivo: Dispositivo) {
  const lotes: LotePercepcion[] = [];
  return {
    dispositivo, lotes,
    lanzar(lote: LotePercepcion, planes: readonly Plan[]) { lotes.push(lote); base.lanzar(lote, planes); },
    esperar(plazoMs: number) {
      if (dispositivo === 'cpu') assert.equal(plazoMs, Infinity, 'la recomputación completa el mismo tick sin plazo de GPU');
      return base.esperar(plazoMs);
    },
  };
}

/** Tarjeta simulada: tarda `fijo + porActor·n` ms de trabajo de tarjeta, con un ruido determinista de ±ruido. */
function tarjetaModelo(dispositivo: Dispositivo, modelo: { fijo: number; porActor: number; ruido: number }) {
  let pendiente = 0, k = 0;
  const ultimasTransferencias = { subidos: 1, bajados: 1, ms: 0 };
  let eco = { tick: -1, despacho: -1 };
  const percibidor = {
    dispositivo, ultimasTransferencias,
    lanzar(lote: LotePercepcion) { pendiente = lote.slots.length; eco = { tick: lote.tick, despacho: lote.despacho }; },
    esperar(): Percepcion {
      const ruido = 1 + modelo.ruido * Math.sin(++k * 2.3);
      ultimasTransferencias.ms = (modelo.fijo + modelo.porActor * pendiente) * ruido;
      return { q: 0, v: 0, a: 0, ...eco, celda: new Int32Array(), pasos: new Int16Array(), valor: new Float32Array(),
        organismo: new Float64Array(), utilidad: new Float32Array() };
    },
  };
  return { percibidor, cerrar() {}, modelo };
}

test('M3 el reparto entre tarjetas converge al punto de igual tiempo de tarjeta, sin oscilar, y sigue un cambio de velocidad', () => {
  const rapida = tarjetaModelo('gpu0', { fijo: 0.05, porActor: 0.0001, ruido: 0.2 });
  const lenta = tarjetaModelo('gpu1', { fijo: 0.05, porActor: 0.00035, ruido: 0.2 });
  const cpu = { dispositivo: 'cpu' as const, lanzar() { throw new Error('ninguna tarjeta falló'); }, esperar(): Percepcion { throw new Error(); } };
  const puente = new PuentePercepcion(cpu, [rapida, lenta]);
  const n = 4000, lote = { tick: 1, despacho: 1, slots: new Int32Array(n), plan: new Uint16Array(n) };
  const reparto = (ultimos: readonly LoteGpuMedido[]) => ultimos.find(l => l.dispositivo === 'gpu0')?.actores ?? 0;
  const serie: number[] = [];
  for (let i = 0; i < 80; i++) {
    if (i === 40) lenta.modelo.porActor *= 4;
    percibir(puente, lote, []);
    serie.push(reparto(puente.ultimosLotes));
  }
  // Con igual tiempo de tarjeta, fijo + k₀·n₀ = fijo + k₁·(n − n₀).
  const equilibrio = (k0: number, k1: number) => n * k1 / (k0 + k1);
  const banda = (desde: number, hasta: number) => serie.slice(desde, hasta);
  for (const [desde, hasta, k1] of [[25, 40, 0.00035], [65, 80, 0.0014]] as const) {
    const tramo = banda(desde, hasta), objetivo = equilibrio(0.0001, k1);
    for (const n0 of tramo) assert.ok(Math.abs(n0 - objetivo) <= 0.08 * n, `${n0} lejos del equilibrio ${objetivo}`);
    // Sin oscilación creciente: la amplitud del final no supera la del principio del tramo.
    const amplitud = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    assert.ok(amplitud(tramo.slice(-7)) <= amplitud(tramo.slice(0, 8)) + 0.02 * n, `oscila: ${tramo.join(',')}`);
  }
  assert.ok(serie[79]! > serie[39]!, 'la tarjeta lenta pierde trabajo cuando se vuelve más lenta');
});

test('M3 publica un invariante para detectar una recepción dañada en el tick correspondiente', () => {
  const fixture = crearFixtureGpu();
  const lote = fixture.lote();
  const resultado = percibir(new PercibidorCpu(fixture.frente, fixture.terreno), lote, fixture.planes);
  const mundo = { tick: lote.tick } as World;
  observarPercepcionGpu(mundo, lote, resultado);
  const opciones = { ids: ['m3.percepcion'] };
  assert.deepEqual(comprobarInvariantes(mundo, opciones), []);
  resultado.utilidad[0] = NaN;
  assert.equal(comprobarInvariantes(mundo, opciones)[0]?.detalle, 'Utilidad de percepción no finita.');
  mundo.tick++;
  assert.deepEqual(comprobarInvariantes(mundo, opciones), []);
});

// `eco`: el servidor confirma una salida completa con el despacho de otro lote.
for (const fase of ['arranque', 'antes-de-leer', 'entrada-leida', 'salida-parcial', 'antes-de-confirmar', 'plazo', 'eco']) {
  test(`M3 ${fase}: la misma recepción conserva slots y tick aunque falle una tarjeta`, () => {
    canalDePrueba(fase, (canal, marca) => {
      if (fase !== 'arranque') canal.iniciar(PLAZO_MS);
      const { frente, terreno, planes, lote } = crearFixtureGpu();
      const actual = lote();
      const esperado = percibir(new PercibidorCpu(frente, terreno), actual, planes);
      const cpu = rastrear(new PercibidorCpu(frente, terreno), 'cpu');
      const otraTarjeta = {
        ...rastrear(new PercibidorCpu(frente, terreno), 'gpu1'),
        ultimasTransferencias: { subidos: 0, bajados: 0, ms: 1 },
      };
      const puente = new PuentePercepcion(cpu, [
        { percibidor: new PercibidorGpu(canal, frente, terreno), cerrar: () => canal.cerrar() },
        { percibidor: otraTarjeta, cerrar() {} },
      ]);
      try {
        const resultado = percibir(puente, actual, planes, fase === 'plazo' ? 100 : PLAZO_MS);
        assert.equal(readFileSync(marca, 'utf8'), fase, 'el hijo alcanzó la fase inyectada');
        assert.deepEqual(resultado, esperado, 'la recepción se completa con cálculo CPU del mismo tick');
        assert.equal(cpu.lotes.length, 1);
        assert.equal(otraTarjeta.lotes.length, 1);
        assert.equal(cpu.lotes[0].tick, actual.tick);
        assert.equal(otraTarjeta.lotes[0].tick, actual.tick);
        assert.ok(cpu.lotes[0].slots.length > 0 && otraTarjeta.lotes[0].slots.length > 0);
        const combinados = [...cpu.lotes[0].slots, ...otraTarjeta.lotes[0].slots];
        assert.deepEqual(combinados.sort((a, b) => a - b), [...actual.slots].sort((a, b) => a - b));
        assert.deepEqual(puente.ultimosLotes.map(item => item.dispositivo).sort(), ['cpu', 'gpu1']);
      } finally {
        puente.cerrar();
      }
    });
  });
}

function agregar(histogramas: Map<string, Map<number, number>>, nombre: string, valor: number): void {
  let h = histogramas.get(nombre);
  if (!h) histogramas.set(nombre, h = new Map());
  h.set(valor, (h.get(valor) ?? 0) + 1);
}

function resumirResultados(fixture: Fixture, lote: LotePercepcion, p: Percepcion) {
  const { frente, terreno, planes } = fixture;
  const h = new Map<string, Map<number, number>>();
  assert.deepEqual([p.q, p.v, p.a], [10, 3, 12]);
  assert.deepEqual([p.celda.length, p.pasos.length, p.valor.length, p.organismo.length, p.utilidad.length],
    [lote.slots.length * p.q, lote.slots.length * p.q, lote.slots.length * p.q, lote.slots.length * p.v, lote.slots.length * p.a]);
  let celdas = 0, organismos = 0;
  for (let i = 0; i < lote.slots.length; i++) {
    const slot = lote.slots[i], plan = planes[lote.plan[i]], ox = frente.x[slot], oy = frente.y[slot];
    const cx = Math.floor(ox), cy = Math.floor(oy);
    for (let j = 0; j < p.q; j++) {
      const k = i * p.q + j, celda = p.celda[k], pasos = p.pasos[k];
      let distancia = -1;
      if (j >= plan.celdas.length) assert.equal(celda, -1);
      if (celda === -1) {
        assert.equal(pasos, -1);
        assert.equal(p.valor[k], Infinity);
      } else {
        const pagina = terreno.chunkDe(celda);
        const x = terreno.paginaX[pagina] * 16 + (celda & 15);
        const y = terreno.paginaY[pagina] * 16 + ((celda & 255) >> 4);
        distancia = Math.hypot(x - ox, y - oy);
        assert.equal(terreno.celda(x, y), celda);
        // La ventana BFS se centra en la celda del actor, no en su posición fraccionaria.
        assert.ok(Math.hypot(x - cx, y - cy) <= 7 && Number.isFinite(p.valor[k]));
        if (plan.celdas[j].alcanzable) assert.ok(pasos >= Math.abs(x - cx) + Math.abs(y - cy));
        celdas++;
      }
      if (j < plan.celdas.length) {
        agregar(h, `celda ${plan.id}/${j}`, Math.ceil(distancia));
        agregar(h, `pasos ${plan.id}/${j}`, pasos);
      }
    }
    for (let j = 0; j < p.v; j++) {
      const ref = p.organismo[i * p.v + j], consulta = plan.organismos[j];
      if (!consulta) assert.equal(ref, REF_NULA);
      else if (ref === REF_NULA) agregar(h, `organismo ${plan.id}/${j}`, -1);
      else {
        const otro = slotDe(ref);
        const distancia = Math.hypot(frente.x[otro] - ox, frente.y[otro] - oy);
        assert.ok(Number.isSafeInteger(ref) && genDe(ref) === frente.gen[otro]);
        assert.ok(otro !== slot && frente.vivo[otro] === 1 && distancia <= consulta.radio);
        if (consulta.clase !== 0) assert.equal(frente.clase[otro], consulta.clase);
        agregar(h, `organismo ${plan.id}/${j}`, Math.ceil(distancia));
        organismos++;
      }
    }
    if (plan.acciones) {
      let mejor = 0;
      const base = i * p.a;
      for (let a = 0; a < plan.acciones; a++) {
        assert.ok(Number.isFinite(p.utilidad[base + a]));
        if (p.utilidad[base + a] > p.utilidad[base + mejor]) mejor = a;
      }
      agregar(h, 'acciones', mejor);
    }
  }
  assert.ok(celdas > lote.slots.length && organismos > lote.slots.length / 2);
  assert.equal(h.get('acciones')?.size, CEREBRO.acciones);
  return h;
}

function compararDistribuciones(t: TestContext, fixture: Fixture, lote: LotePercepcion, cpu: Percepcion, gpu: Percepcion): void {
  const control = resumirResultados(fixture, lote, cpu), medido = resumirResultados(fixture, lote, gpu);
  const maximos = { celdas: 0, pasos: 0, organismos: 0, acciones: 0 };
  for (const [grupo, esperadas] of control) {
    const observadas = medido.get(grupo)!;
    const total = [...esperadas.values()].reduce((a, b) => a + b, 0);
    assert.equal([...observadas.values()].reduce((a, b) => a + b, 0), total, grupo);
    let diferencia = 0;
    for (const i of new Set([...esperadas.keys(), ...observadas.keys()]))
      diferencia += Math.abs((esperadas.get(i) ?? 0) - (observadas.get(i) ?? 0));
    const tv = diferencia / (2 * total);
    if (grupo.startsWith('celda')) maximos.celdas = Math.max(maximos.celdas, tv);
    else if (grupo.startsWith('pasos')) maximos.pasos = Math.max(maximos.pasos, tv);
    else if (grupo.startsWith('organismo')) maximos.organismos = Math.max(maximos.organismos, tv);
    else maximos.acciones = tv;
  }
  const acciones = (h: Map<string, Map<number, number>>) =>
    Object.fromEntries(POLICY_ACTIONS.map((accion, i) => [accion, h.get('acciones')?.get(i) ?? 0]));
  t.diagnostic(JSON.stringify({ distanciaVariacionTotal: maximos, accionesCpu: acciones(control), accionesGpu: acciones(medido) }));
  for (const [grupo, tv] of Object.entries(maximos)) assert.ok(tv <= 0.02, `${grupo}: TV ${tv} > 0.02`);
  let errorMaximo = 0;
  for (let i = 0; i < cpu.utilidad.length; i++) if (fixture.planes[lote.plan[Math.floor(i / cpu.a)]].acciones)
    errorMaximo = Math.max(errorMaximo, Math.abs(cpu.utilidad[i] - gpu.utilidad[i]));
  t.diagnostic(`Máximo error absoluto de utilidad FP32: ${errorMaximo}`);
  assert.ok(errorMaximo <= 2e-5);
  // El desempate entre celdas no es contractual, pero el mínimo sí: misma presencia y mismo valor salvo FP32.
  for (let i = 0; i < cpu.valor.length; i++) {
    assert.equal(gpu.celda[i] === -1, cpu.celda[i] === -1, `presencia de la consulta ${i}`);
    if (cpu.celda[i] !== -1) assert.ok(Math.abs(gpu.valor[i] - cpu.valor[i]) <= 1e-5 * (1 + Math.abs(cpu.valor[i])), `mínimo de la consulta ${i}`);
  }
}

const ESCENARIOS: readonly [string, OpcionesFixture][] = [
  ['semilla 11', { grande: true, semilla: 11 }],
  ['semilla 29', { grande: true, semilla: 29 }],
  ['empates en el mínimo', { grande: true, semilla: 5, empates: true }],
  ['borde de página, fracción y páginas ausentes', { grande: true, semilla: 7, borde: true }],
  ['mitad de la fauna en el agua', { grande: true, semilla: 13, peces: true }],
];

test('M3 CUDA real: GPU y CPU coinciden por estadística en varios mundos y en las dos tarjetas', {
  skip: !process.env.COMPUTE_NVRTC && 'Se requiere COMPUTE_NVRTC y dos tarjetas CUDA',
}, async t => {
  const canales = [0, 1].map(dispositivo => new CanalCompartido(dispositivo));
  try {
    for (const canal of canales) canal.iniciar(20_000);
    for (const [nombre, opciones] of ESCENARIOS) {
      await t.test(nombre, t => {
        const fixture = crearFixtureGpu(opciones);
        const lote = fixture.lote();
        const esperado = percibir(new PercibidorCpu(fixture.frente, fixture.terreno), lote, fixture.planes);
        for (const canal of canales) {
          const gpu = percibir(new PercibidorGpu(canal, fixture.frente, fixture.terreno), lote, fixture.planes);
          let iguales = 0;
          for (let i = 0; i < esperado.celda.length; i++) if (esperado.celda[i] === gpu.celda[i]) iguales++;
          t.diagnostic(`gpu${canal.dispositivo}: ${iguales}/${esperado.celda.length} celdas idénticas`);
          compararDistribuciones(t, fixture, lote, esperado, gpu);
          assert.deepEqual(gpu.organismo, esperado.organismo, 'las consultas de organismo son exactas en f64');
          assert.deepEqual([gpu.tick, gpu.despacho], [lote.tick, lote.despacho], 'eco del servidor');
        }
        // El plan de las personas de M2b: cerebro sin cabeza lineal (w = null).
        const sinW = fixture.planes.map(p => p.acciones ? { ...p, w: null } : p);
        const cpuSinW = percibir(new PercibidorCpu(fixture.frente, fixture.terreno), lote, sinW);
        const gpuSinW = percibir(new PercibidorGpu(canales[0], fixture.frente, fixture.terreno), lote, sinW);
        compararDistribuciones(t, fixture, lote, cpuSinW, gpuSinW);
      });
    }
  } finally {
    for (const canal of canales) canal.cerrar();
  }
});

test('M3 CUDA real: los espejos incrementales de las dos tarjetas siguen al frente tick a tick', {
  skip: !process.env.COMPUTE_NVRTC && 'Se requiere COMPUTE_NVRTC y dos tarjetas CUDA',
}, t => {
  const fixture = crearFixtureGpu({ grande: true, semilla: 41, borde: true });
  const { terreno, planes } = fixture;
  const canales = [0, 1].map(dispositivo => new CanalCompartido(dispositivo));
  const cpu = new PercibidorCpu(fixture.frente, terreno);
  try {
    const tarjetas = canales.map(canal => {
      canal.iniciar(20_000);
      return { percibidor: new PercibidorGpu(canal, fixture.frente, terreno), cerrar: () => canal.cerrar() };
    });
    const puente = new PuentePercepcion(cpu, tarjetas);
    try {
      for (let tick = 0; tick < 6; tick++) {
        // Tras el primer lote completo, cada tick sube solo las páginas, filas y cerebros cambiados.
        const frente = tick ? fixture.siguiente() : fixture.frente;
        for (const { percibidor } of tarjetas) percibidor.fuentes(frente, terreno);
        cpu.fuentes(frente, terreno);
        const lote = fixture.lote();
        const gpu = percibir(puente, lote, planes);
        assert.deepEqual(puente.ultimosLotes.map(l => l.dispositivo).sort(), ['gpu0', 'gpu1']);
        const esperado = percibir(cpu, lote, planes);
        assert.deepEqual(gpu.organismo, esperado.organismo, `organismos del tick ${frente.tick}`);
        compararDistribuciones(t, fixture, lote, esperado, gpu);
      }
    } finally {
      puente.cerrar();
    }
  } finally {
    for (const canal of canales) canal.cerrar();
  }
});

test('M3 CUDA real: crearPuentePercepcion arranca las dos tarjetas fuera del plazo del tick y las cierra', {
  skip: !process.env.COMPUTE_NVRTC && 'Se requiere COMPUTE_NVRTC y dos tarjetas CUDA',
}, () => {
  const fixture = crearFixtureGpu();
  const cpu = new PercibidorCpu(fixture.frente, fixture.terreno);
  const { puente, fuentes } = crearPuentePercepcion([0, 1], fixture.frente, fixture.terreno, cpu);
  try {
    const lote = fixture.lote();
    // Un plazo corto basta porque el arranque ya ocurrió al crear el puente.
    const resultado = percibir(puente, lote, fixture.planes, 500);
    assert.deepEqual(puente.ultimosLotes.map(l => l.dispositivo).sort(), ['gpu0', 'gpu1']);
    assert.deepEqual(resultado.organismo, percibir(cpu, lote, fixture.planes).organismo);
    fuentes(fixture.siguiente(), fixture.terreno);
    cpu.fuentes(fixture.frente, fixture.terreno);
    percibir(puente, fixture.lote(), fixture.planes, 500);
    assert.deepEqual(puente.ultimosLotes.map(l => l.dispositivo).sort(), ['gpu0', 'gpu1']);
  } finally {
    puente.cerrar();
  }
});

function percentiles(serie: number[]) {
  const ordenada = [...serie].sort((a, b) => a - b);
  return { p50: ordenada[Math.ceil(serie.length * 0.5) - 1], p95: ordenada[Math.ceil(serie.length * 0.95) - 1], max: ordenada.at(-1)! };
}

test('M3 CUDA real: 4.000 vencidos, volumen por tick y estadística frente a CPU', {
  skip: (process.env.CARTA_TEST_GPU_PERCIBIR !== '1' || !process.env.COMPUTE_NVRTC)
    && 'Se requiere CARTA_TEST_GPU_PERCIBIR=1, COMPUTE_NVRTC y dos tarjetas CUDA',
}, async t => {
  for (const dispositivos of [[0], [1], [0, 1]]) {
    await t.test(`GPU [${dispositivos}]`, t => {
      const fixture = crearFixtureGpu(true);
      const { frente, terreno, planes } = fixture;
      const canales: CanalCompartido[] = [];
      const cpu = new PercibidorCpu(frente, terreno);
      try {
        const tarjetas = dispositivos.map(dispositivo => {
          const canal = new CanalCompartido(dispositivo);
          canales.push(canal);
          canal.iniciar(10_000);
          const percibidor = new PercibidorGpu(canal, frente, terreno);
          return { percibidor, cerrar: () => canal.cerrar() };
        });
        const puente = new PuentePercepcion(cpu, tarjetas);
        try {
          let lote = fixture.lote(), resultado = percibir(puente, lote, planes);
          assert.deepEqual(puente.ultimosLotes.map(item => item.dispositivo).sort(), dispositivos.map(i => `gpu${i}`));
          const pcieInicialBytes = puente.ultimosLotes.reduce((n, item) => n + item.subidos + item.bajados, 0);
          const pared: number[] = [], envio: number[] = [], transferidos: number[] = [];
          const porGpu = new Map(dispositivos.map(i => [`gpu${i}`, { actores: [] as number[], ms: [] as number[] }]));
          const medir = (calentar: boolean) => {
            const siguiente = fixture.siguiente();
            for (const { percibidor } of tarjetas) percibidor.fuentes(siguiente, terreno);
            lote = fixture.lote();
            const inicio = performance.now();
            puente.lanzar(lote, planes);
            const envioMs = performance.now() - inicio;
            resultado = puente.esperar(PLAZO_MS);
            const ms = performance.now() - inicio;
            assert.equal(lote.slots.length, 4000);
            assert.deepEqual(puente.ultimosLotes.map(item => item.dispositivo).sort(), dispositivos.map(i => `gpu${i}`));
            assert.equal(puente.ultimosLotes.reduce((n, item) => n + item.actores, 0), 4000);
            if (calentar) return;
            pared.push(ms);
            envio.push(envioMs);
            transferidos.push(puente.ultimosLotes.reduce((n, item) => n + item.subidos + item.bajados, 0));
            for (const item of puente.ultimosLotes) {
              assert.ok(item.actores > 0 && item.subidos > 0 && item.bajados > 0 && item.ms > 0);
              const gpu = porGpu.get(item.dispositivo)!;
              gpu.actores.push(item.actores);
              gpu.ms.push(item.ms);
            }
          };
          for (let i = 0; i < 10; i++) medir(true);
          for (let i = 0; i < 24; i++) medir(false);
          const ms = percentiles(pared), bytes = percentiles(transferidos);
          t.diagnostic(JSON.stringify({
            dispositivos, vencidos: lote.slots.length, calentamiento: 10, muestras: pared.length,
            paredMs: ms, envioMs: percentiles(envio), pcieBytes: bytes, pcieInicialBytes, lotesSobre3Ms: pared.filter(m => m > LIMITE_MS).length,
            tarjetas: Object.fromEntries([...porGpu].map(([gpu, datos]) => [gpu, { actores: percentiles(datos.actores), pcieYKernelMs: percentiles(datos.ms) }])),
          }));
          cpu.fuentes(fixture.frente, terreno);
          const esperado = percibir(cpu, lote, planes);
          compararDistribuciones(t, fixture, lote, esperado, resultado);
          assert.ok(bytes.max <= LIMITE_BYTES, `${bytes.max} bytes > ${LIMITE_BYTES} bytes por tick`);
          if (dispositivos.length === 2) {
            const fallos: string[] = [];
            if (ms.max > LIMITE_MS) fallos.push(`${ms.max} ms de pared > ${LIMITE_MS} ms para 4.000 vencidos`);
            if (pcieInicialBytes > LIMITE_BYTES) fallos.push(`${pcieInicialBytes} bytes iniciales > ${LIMITE_BYTES} bytes por tick`);
            assert.equal(fallos.length, 0, fallos.join(' | '));
          }
        } finally {
          puente.cerrar();
        }
      } finally {
        for (const canal of canales) canal.cerrar();
      }
    });
  }

  await t.test('SIGKILL de la RTX en F0–B2 conserva el fragmento de la otra tarjeta y completa el tick', t => {
    const { frente, terreno, planes, lote } = crearFixtureGpu();
    const cpu = rastrear(new PercibidorCpu(frente, terreno), 'cpu');
    const canales: CanalCompartido[] = [];
    try {
      const tarjetas = [0, 1].map(indice => {
        const canal = new CanalCompartido(indice);
        canales.push(canal);
        canal.iniciar(10_000);
        return { percibidor: new PercibidorGpu(canal, frente, terreno), cerrar: () => canal.cerrar() };
      });
      const puente = new PuentePercepcion(cpu, tarjetas);
      try {
        const actual = lote();
        percibir(puente, actual, planes);
        assert.deepEqual(puente.ultimosLotes.map(item => item.dispositivo).sort(), ['gpu0', 'gpu1']);
        const pid = canales[0].pid;
        assert.ok(pid, 'el canal tiene su propio servidor CUDA');
        process.kill(pid, 'SIGSTOP'); // impide que esta orden llegue a confirmar antes del SIGKILL
        puente.lanzar(actual, planes);
        process.kill(pid, 'SIGKILL');
        const recibido = puente.esperar(PLAZO_MS);
        const esperado = percibir(new PercibidorCpu(frente, terreno), actual, planes);
        const [fallado, conservado] = puente.ultimosLotes;
        assert.equal(fallado.dispositivo, 'cpu');
        assert.equal(conservado.dispositivo, 'gpu1');
        assert.ok(fallado.actores > 0 && conservado.actores > 0 && conservado.bajados > 0);
        assert.equal(fallado.actores + conservado.actores, actual.slots.length);
        assert.equal(cpu.lotes.length, 1);
        assert.equal(cpu.lotes[0].tick, actual.tick);
        assert.deepEqual(cpu.lotes[0].slots, actual.slots.subarray(0, fallado.actores));
        const c = fallado.actores * recibido.q, v = fallado.actores * recibido.v, a = fallado.actores * recibido.a;
        assert.deepEqual(recibido.celda.subarray(0, c), esperado.celda.subarray(0, c));
        assert.deepEqual(recibido.pasos.subarray(0, c), esperado.pasos.subarray(0, c));
        assert.deepEqual(recibido.valor.subarray(0, c), esperado.valor.subarray(0, c));
        assert.deepEqual(recibido.organismo.subarray(0, v), esperado.organismo.subarray(0, v));
        assert.deepEqual(recibido.utilidad.subarray(0, a), esperado.utilidad.subarray(0, a));
        const seleccion = { tick: actual.tick, despacho: actual.despacho, slots: actual.slots.subarray(fallado.actores), plan: actual.plan.subarray(fallado.actores) };
        const resto = percibir(tarjetas[1].percibidor, seleccion, planes);
        assert.deepEqual(recibido.celda.subarray(c), resto.celda);
        assert.deepEqual(recibido.pasos.subarray(c), resto.pasos);
        assert.deepEqual(recibido.valor.subarray(c), resto.valor);
        assert.deepEqual(recibido.organismo.subarray(v), resto.organismo);
        assert.deepEqual(recibido.utilidad.subarray(a), resto.utilidad);
        t.diagnostic(`SIGKILL CUDA: ${fallado.actores} slots CPU y ${conservado.actores} slots en gpu1 para tick ${actual.tick}`);
      } finally {
        puente.cerrar();
      }
    } finally {
      for (const canal of canales) canal.cerrar();
    }
  });
});
