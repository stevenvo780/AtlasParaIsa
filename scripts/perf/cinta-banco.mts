import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { rmSync, statSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { setTimeout as esperar } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { CatalogoCinta, MAX_SEGMENTO, NIVELES, rutaSegmento, type SegmentoCinta } from '../../src/server/cinta/catalogo.js';
import { EscritorCinta } from '../../src/server/cinta/escritor.js';
import { clientDelta, codificarBloque, prepararBloque } from '../../src/server/cinta/formato.js';
import { LectorCinta } from '../../src/server/cinta/lector.js';
import { RESERVA_DISCO } from '../../src/server/cinta/poda.js';
import { reducir, reducirTesela } from '../../src/server/cinta/reducir.js';
import { crearEnlaceCortes, type TapeWorkerMessage, type TapeWorkerRequest } from '../../src/server/tape-worker.js';
import { CINTA, type Apertura, type ChunkResp, type Nivel } from '../../src/shared/cinta.js';
import { enlaceCinta } from '../../src/shared/fotograma.js';
import type { TapeClientDelta } from '../../src/shared/tape-delta.js';
import { TICKS_PER_DAY } from '../../src/world/mundo/tipos.js';
import { azarCinta, directorioBanco, escenaCinta, natural } from './cinta-sintetica.mjs';

const POR_BLOQUE = 32;
const CAMARA = { x: 0, y: 0, w: 96, h: 64 };
const APERTURA: Apertura = { instanciaId: 'banco-cinta', epoca: 0, tMundo: 0, motivo: 'reinicio' };
const { positionals: [modo, base, ...sobran], values } = parseArgs({ allowPositionals: true,
  options: { bytes: { type: 'string' }, hz: { type: 'string' }, segundos: { type: 'string' }, muestras: { type: 'string' } } });

if (!base || sobran.length || !['volumen', 'rafaga', 'entidades', 'vaciados'].includes(modo ?? '')) {
  throw new Error('Uso: cinta-banco.mts <volumen|rafaga|entidades|vaciados> <directorio> [--bytes N] [--hz N] [--segundos N] [--muestras N]');
}
const objetivo = natural(values.bytes, '--bytes', modo === 'volumen' ? CINTA.topeBytes : 2e9);
if (objetivo > CINTA.topeBytes) throw new Error(`El banco admite hasta ${CINTA.topeBytes} bytes.`);
const hz = natural(values.hz, '--hz', 300);
const segundos = natural(values.segundos, '--segundos', 60);
const muestras = natural(values.muestras, '--muestras', modo === 'entidades' ? 30 : 1000);
const reserva = modo === 'vaciados' ? 2 * objetivo : objetivo;
const raiz = directorioBanco(base, reserva + RESERVA_DISCO, 'banco-cinta-');

function resumen(ms: number[]) {
  assert.ok(ms.length);
  ms.sort((a, b) => a - b);
  return { p50: ms[Math.ceil(ms.length * .50) - 1], p95: ms[Math.ceil(ms.length * .95) - 1], max: ms.at(-1) };
}

function discoFrio(cinta: string, segmento: SegmentoCinta): void {
  const r = spawnSync('dd', [`if=${rutaSegmento(cinta, segmento.nivel, segmento.id)}`, 'iflag=nocache', 'count=0', 'status=none']);
  assert.equal(r.status, 0, String(r.error ?? r.stderr));
}

function saltos(cinta: string, segmentos: readonly SegmentoCinta[], niveles: readonly Nivel[], soloCamara = false) {
  const lector = new LectorCinta(cinta, 0);
  try {
    const meta = lector.meta();
    return niveles.flatMap(nivel => {
      const pista = segmentos.filter(s => s.nivel === nivel), n = meta.niveles.find(n => n.nivel === nivel)!;
      assert.ok(pista.length && n);
      const azar = azarCinta();
      const ticks = Array.from({ length: muestras }, () => n.t0 + Math.floor(azar() * (n.t1 - n.t0 + 1)));
      return (soloCamara ? [true] : [true, false]).map(conCamara => {
        const pared: number[] = [], cpu: number[] = [];
        for (const t of ticks) {
          let i = pista.length - 1;
          while (pista[i]!.t0 > t) i--;
          const segmento = pista[i]!;
          discoFrio(cinta, segmento);
          const inicio = performance.now(), coste = process.threadCpuUsage();
          const json = lector.chunk({ t, n: 1, nivel, ...(conCamara ? CAMARA : {}) });
          const gasto = process.threadCpuUsage(coste);
          pared.push(performance.now() - inicio);
          cpu.push((gasto.user + gasto.system) / 1000);
          const r = JSON.parse(json) as ChunkResp;
          assert.equal(r.nivel, nivel);
          assert.equal(r.baseFrame?.tick, Math.floor(t / n.paso) * n.paso);
          assert.equal(r.t0, r.t1);
          assert.equal(r.deltas.length, 0);
        }
        return { nivel, conCamara, muestras, bytes: n.bytes, paredMs: resumen(pared), cpuHiloMs: resumen(cpu) };
      });
    });
  } finally { lector.close(); }
}

function prepararEscena(escena: ReturnType<typeof escenaCinta>, nivel: Nivel) {
  const base = reducir(nivel, escena(0, 0, hz, true).vista);
  let previa = { ...base, tiles: [] as typeof base.tiles };
  const deltas: TapeClientDelta[] = [];
  for (let i = 1; i < POR_BLOQUE; i++) {
    const c = escena(i * CINTA.pasos[nivel], i, hz, false);
    const actual = reducir(nivel, { ...c.vista, tiles: [] });
    const delta = clientDelta(previa, actual);
    if (nivel <= 2 && c.vista.tiles.length) delta.tilesPatch = c.vista.tiles.map(t => reducirTesela(nivel, t)!);
    deltas.push(delta);
    previa = actual;
  }
  return { base, deltas };
}

function volumen() {
  const cinta = join(raiz, 'cinta'), escena = escenaCinta(700, 3000, 128);
  const plantillas = NIVELES.map(nivel => {
    const { base, deltas } = prepararEscena(escena, nivel);
    const fabricar = prepararBloque(nivel, base, deltas);
    return { fabricar, bytes: fabricar().length, ticks: POR_BLOQUE * CINTA.pasos[nivel] };
  });
  const baseBytes = plantillas.reduce((s, b) => s + b.bytes, 0);
  const porTick = plantillas.reduce((s, b) => s + b.bytes / b.ticks, 0);
  assert.ok(baseBytes < objetivo * .99, 'El presupuesto debe admitir un bloque por nivel.');
  const fin = Math.floor((objetivo * .99 - baseBytes) / porTick);
  const catalogo = new CatalogoCinta(cinta);
  let segmentos: SegmentoCinta[], escritos = 0, fisicos = 0;
  const inicio = performance.now();
  try {
    const epoca = catalogo.abrir(APERTURA);
    for (const nivel of NIVELES) {
      const { fabricar, ticks, bytes } = plantillas[nivel]!;
      let segmento: SegmentoCinta | undefined;
      for (let t = 0; t <= fin; t += ticks) {
        const anexar: SegmentoCinta | undefined = segmento && segmento.bytes + bytes <= MAX_SEGMENTO ? segmento : undefined;
        catalogo.escribirBloque(epoca, fabricar(t), anexar);
        if (anexar) anexar.bytes += bytes;
        else segmento = catalogo.segmentos().at(-1)!;
        escritos += bytes;
      }
    }
    segmentos = catalogo.segmentos();
    fisicos = segmentos.reduce((s, v) => s + statSync(rutaSegmento(cinta, v.nivel, v.id)).blocks * 512, catalogo.bytesIndice());
  } finally { catalogo.db.close(); }
  const escrituraMs = performance.now() - inicio;
  const lecturas = saltos(cinta, segmentos, NIVELES);
  console.log(JSON.stringify({ escenario: 'volumen', objetivo, escritos, fisicos, escrituraMs, lecturas, carga: loadavg() }, null, 2));
  assert.ok(fisicos <= objetivo * 1.02, 'I4: el volumen físico excede la holgura del objetivo.');
  assert.ok(lecturas.every(l => l.paredMs.p95! < 100), 'I5: algún p95 es ≥ 100 ms.');
}

function entidades() {
  const cinta = join(raiz, 'entidades'), escena = escenaCinta(12_000, 38_000, 512);
  const { base, deltas } = prepararEscena(escena, 0);
  const catalogo = new CatalogoCinta(cinta);
  try {
    const epoca = catalogo.abrir(APERTURA);
    const cpu = process.threadCpuUsage(), inicio = performance.now();
    const datos = codificarBloque(0, base, deltas);
    catalogo.escribirBloque(epoca, datos, undefined);
    const paredMs = performance.now() - inicio, coste = process.threadCpuUsage(cpu);
    const lecturas = saltos(cinta, catalogo.segmentos(), [0], true);
    console.log(JSON.stringify({ escenario: 'entidades', entidades: 50_000, ladoTeselas: 512, hz,
      cierre: { paredMs, cpuHiloMs: (coste.user + coste.system) / 1000, nivel0Bytes: datos.length },
      lecturas, carga: loadavg() }, null, 2));
  } finally { catalogo.db.close(); }
}

function vaciados() {
  const medir = (intervaloTicks: number) => {
    const cinta = join(raiz, intervaloTicks ? 'cada-segundo' : 'bloques-llenos'), escena = escenaCinta(700, 3000, 128);
    const escritor = new EscritorCinta({ directorio: cinta, topeBytes: objetivo });
    escritor.abrir(APERTURA);
    let proximo = intervaloTicks;
    try {
      for (let t = 0, i = 0; t < hz * segundos; t += CINTA.pasos[0], i++) {
        if (intervaloTicks && t >= proximo) {
          escritor.flush();
          proximo = (Math.floor(t / intervaloTicks) + 1) * intervaloTicks;
        }
        escritor.registrar(escena(t, i, hz, i === 0));
      }
    } finally { escritor.close(); }
    const catalogo = new CatalogoCinta(cinta);
    try {
      const medida = catalogo.db.prepare('SELECT count(*) AS bloques,sum(bytes) AS bytes,sum(fotogramas) AS fotogramas FROM bloques WHERE nivel=?');
      return ([1, 2] as const).map(nivel => {
        const fila = medida.get(nivel)!;
        return { nivel, bloques: Number(fila.bloques), bytes: Number(fila.bytes), fotogramas: Number(fila.fotogramas) };
      });
    } finally { catalogo.db.close(); }
  };
  const base = medir(0), porSegundo = medir(hz);
  const niveles = base.map((b, i) => {
    const actual = porSegundo[i]!;
    assert.equal(actual.fotogramas, b.fotogramas, 'Las dos pasadas deben retener los mismos fotogramas.');
    return { nivel: b.nivel, base: b, porSegundo: actual, factorBytes: actual.bytes / b.bytes,
      diasConCuota: objetivo * CINTA.cuotas[b.nivel] * hz * segundos / actual.bytes / TICKS_PER_DAY };
  });
  console.log(JSON.stringify({ escenario: 'vaciados', hz, segundos, niveles, carga: loadavg() }, null, 2));
}

async function rafaga() {
  const directorio = join(raiz, 'rafaga'), escena = escenaCinta(700, 3000, 128);
  const descriptor = crearEnlaceCortes(), enlace = enlaceCinta(descriptor);
  const hilo = new Worker(`
    const { workerData } = require('node:worker_threads');
    (async () => {
      (await import(workerData.loader)).register();
      await import(workerData.modulo);
    })().catch(error => setImmediate(() => { throw error; }));
  `, { eval: true, execArgv: [], workerData: { role: 'carta-tape', descriptor, options: { directorio, topeBytes: objetivo },
    loader: import.meta.resolve('tsx/esm/api'), modulo: new URL('../../src/server/tape-worker.ts', import.meta.url).href } });
  let error: string | undefined;
  hilo.on('error', e => { error = e.message; });
  hilo.on('message', (m: TapeWorkerMessage) => { if (m.type === 'estado' && m.estado === 'error') error = m.motivo; });
  const enviar = (m: TapeWorkerRequest) => hilo.postMessage(m);
  try {
    const abrio = once(hilo, 'message');
    enviar({ type: 'abrir', apertura: APERTURA, hitosPrevios: [] });
    assert.equal((await abrio)[0].estado, 'ok', error);
    const entradaHz = 2 * hz, inicio = performance.now();
    let tick = 0, ultimo = -Infinity, enviados = 0, saltados = 0;
    let pasoMax: number = CINTA.pasos[0];
    for (;;) {
      if (error) throw new Error(error);
      const paredMs = performance.now() - inicio;
      if (paredMs >= segundos * 1000) break;
      const hasta = Math.floor(paredMs * entradaHz / 1000);
      while (tick <= hasta) {
        const paso = Atomics.load(enlace.cadencia, 0);
        pasoMax = Math.max(pasoMax, paso);
        if (tick >= ultimo + paso) {
          if (Atomics.load(enlace.creditos, 0) > 0) {
            const corte = escena(tick, enviados, entradaHz, enviados === 0);
            Atomics.sub(enlace.creditos, 0, 1);
            Atomics.add(enlace.entregados, 0, 1n);
            enviar({ type: 'corte', corte });
            ultimo = tick;
            enviados++;
          } else saltados++;
        }
        tick++;
      }
      await esperar(2);
    }
    const duracionMs = performance.now() - inicio;
    const vacio = once(hilo, 'message');
    enviar({ type: 'flush', id: 1 });
    assert.equal((await vacio)[0].id, 1, error);
    const descanso = performance.now();
    while (!error && performance.now() - descanso < 15_000 && Atomics.load(enlace.cadencia, 0) > CINTA.pasos[0]) await esperar(50);
    const pasoEnReposo = Atomics.load(enlace.cadencia, 0);
    const cierre = once(hilo, 'exit');
    enviar({ type: 'close', id: 2 });
    assert.deepEqual(await cierre, [0]);
    assert.equal(error, undefined);
    const lector = new LectorCinta(directorio);
    try {
      const bytes = lector.meta().bytes;
      console.log(JSON.stringify({ escenario: 'rafaga', hzReferencia: hz, entradaHz, hzProductor: 1000 * tick / duracionMs,
        ticks: tick, enviados, saltadosSinCredito: saltados, pasoMax, pasoEnReposo, bytes, topeBytes: objetivo, carga: loadavg() }, null, 2));
      assert.ok(bytes <= objetivo * 1.02);
      assert.ok(pasoMax > CINTA.pasos[0] && pasoEnReposo === CINTA.pasos[0], 'I4: la cadencia debe subir con el atraso y volver en reposo.');
    } finally { lector.close(); }
  } finally { await hilo.terminate(); }
}

console.error(JSON.stringify({ escenario: modo, temporal: raiz, cargaInicio: loadavg() }));
try {
  if (modo === 'volumen') volumen();
  else if (modo === 'entidades') entidades();
  else if (modo === 'vaciados') vaciados();
  else await rafaga();
} finally { rmSync(raiz, { recursive: true, force: true }); }
