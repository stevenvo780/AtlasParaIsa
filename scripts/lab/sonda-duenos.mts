/** Enciende el motor real de dueños y mide los invariantes en barrera.
 * Uso: node --import tsx scripts/lab/sonda-duenos.mts <semilla> <hilos> <ticks> [duenos|rebalanceo]
 */
import assert from 'node:assert/strict';
import { createWorld, TICKS_PER_DAY } from '../../src/world/index.js';
import { NE } from '../../src/shared/naturaleza.js';
import { comprobarLeyes, crearComprobador } from '../../src/world/invariantes.js';
import { decodificarPaginas, saldoEnVuelo } from '../../src/world/materia/checkpoint.js';
import { balancePares, comprobarConservacion } from '../../src/world/materia/libro.js';
import { enlazarCtx } from '../../src/world/motor/acceso.js';
import { duenoSi } from '../../src/world/motor/contexto.js';
import { crearMotor } from '../../src/world/motor/coordinador.js';
import { assertWorld } from '../../src/world/mundo/validar.js';
import { parseParams } from '../../src/world/params.js';
import { paramsDeEncender } from './encender.mjs';

const [semilla, hilos, pasos] = process.argv.slice(2, 5).map(Number);
const hasta = process.argv[5] ?? 'duenos';
assert.ok(hasta === 'duenos' || hasta === 'rebalanceo');
assert.ok(Number.isSafeInteger(semilla) && semilla >= 0 && Number.isSafeInteger(hilos) && hilos > 0 && Number.isSafeInteger(pasos) && pasos > 0);

const base = paramsDeEncender({ regimen: 'abierto', hasta });
const params = parseParams({ motor: { ...base.motor, hilos, gpu: [] } }, base);
const mundo = createWorld(semilla, params);
const motor = crearMotor(mundo, { hilos, gpu: [], decisionGpu: 'siempre', verificar: true, semilla });
const revisar = crearComprobador({ cadencia: false });
const inicio = performance.now();
const propietarios = new Map<number, number>();
let msMotor = 0, muestras = 0, guardadosInvalidos = 0, chunksCedidos = 0;
try {
  for (let i = 1; i <= pasos; i++) {
    const antes = performance.now();
    assert.equal(motor.paso([]).tick, i);
    msMotor += performance.now() - antes;
    const d = duenoSi(mundo);
    assert.ok(d?.quimica && d.materia);
    const intentos = d.balanceIntentos();
    assert.equal(intentos.enviados, intentos.recibidos + intentos.pendientes, `saldo de intentos en tick ${i}`);
    let cedidos = 0;
    if (hasta === 'rebalanceo') {
      const t = d.terreno;
      for (let p = 0; p < t.paginas; p++) {
        if (t.celda(t.paginaX[p] * 16, t.paginaY[p] * 16) < 0) { propietarios.delete(p); continue; }
        const anterior = propietarios.get(p), nuevo = t.duenoChunk[p];
        if (anterior !== undefined && anterior !== nuevo) cedidos++;
        propietarios.set(p, nuevo);
      }
      chunksCedidos += cedidos;
    }
    if (!cedidos && i !== 1 && i % 120 !== 0 && i !== pasos) continue;
    const { world, materia } = motor.instantanea();
    assert.ok(materia);
    try { assertWorld(world); }
    catch (error) {
      if (++guardadosInvalidos === 1) console.error(`Instantánea rechazada en tick ${i}:`, error);
    }
    const saldos = Array.from({ length: hilos }, () => Array<bigint>(NE + 1).fill(0n));
    const { lotes } = decodificarPaginas(materia.epoca, materia.paginas);
    const sustancia = (id: number) => d.quimica!.sustancia(id);
    for (const lote of lotes) {
      const saldo = saldos[lote.dueno];
      assert.ok(saldo, `dueño inválido de lote en tick ${i}`);
      const pares = Array.from({ length: lote.pares.length / 2 }, (_, k) => [lote.pares[k * 2], lote.pares[k * 2 + 1]] as const);
      balancePares(pares, sustancia).forEach((n, k) => { saldo[k] += n; });
    }
    assert.deepEqual(saldos[0], d.materia.saldoPropio());
    const vuelo = saldoEnVuelo(materia.enVuelo, sustancia);
    assert.deepEqual(vuelo, Array.from(d.libro.enVuelo, BigInt));
    const total = saldos[0].map((_, k) => saldos.reduce((s, saldo) => s + saldo[k], 0n));
    comprobarConservacion(materia, total, vuelo);
    const frente = d.frente;
    const vivos: number[] = [];
    for (let s = 0; s < frente.alta; s++) if (frente.vivo[s] === 1) vivos.push(frente.uid[s]);
    const uids = [...world.people, ...world.animals].map(o => o.uid);
    assert.equal(new Set(uids).size, uids.length, `UID duplicado en tick ${i}`);
    assert.deepEqual(vivos.sort((a, b) => a - b), uids.sort((a, b) => a! - b!), `frente e instantánea en tick ${i}`);
    const locales = comprobarLeyes(mundo, d.leyes);
    if (world !== mundo) enlazarCtx(world, d);
    const violaciones = [...revisar(world), ...locales];
    if (violaciones.length) console.error(JSON.stringify({ tick: i, violaciones }));
    assert.equal(violaciones.length, 0, `invariantes en tick ${i}`);
    muestras++;
    if (i % TICKS_PER_DAY === 0 || i === pasos) {
      const { faseMs, esperaBarreraMs, migraciones, desequilibrio } = motor.telemetria();
      console.log(JSON.stringify({ hasta, semilla, hilos, tick: i, dias: i / TICKS_PER_DAY,
        poblacion: world.people.filter(p => p.role === 'neighbor').length, nacimientos: world.totals.births ?? 0,
        muertes: world.demographyDynamics.deaths, fauna: world.animals.length, violaciones: 0, muestras, guardadosInvalidos,
        conservacion: true, saldos: saldos.map(s => s.map(String)), intentos,
        migraciones, chunksCedidos, desequilibrio, hz: i * 1000 / msMotor, faseMs, esperaBarreraMs, segundos: (performance.now() - inicio) / 1000 }));
    }
  }
  if (guardadosInvalidos > 0) process.exitCode = 2;
} catch (error) {
  console.error(`Fallo de ${hasta}: semilla ${semilla}, ${hilos} hilos, tick ${mundo.tick}.`);
  throw error;
} finally { await motor.cerrar(); }
