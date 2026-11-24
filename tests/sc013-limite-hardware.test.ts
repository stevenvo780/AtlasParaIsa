/**
 * T166 · SC-013 — prueba literal de «el límite lo pone el hardware».
 *
 * No corre 100 días: reproduce la trayectoria que SC-013 mide (la población crece paso a paso
 * hasta que el p95 toca `gobernador.presupuestoMs` y el gobernador frena) con el coste por paso
 * inyectado, sobre la misma semilla y las mismas leyes (`RULES_VERSION = 11`). Lo que cambia
 * entre «máquinas» es solo el hardware simulado: el presupuesto (`presupuestoMs`) o el coste
 * medido por paso (reloj `monotonicNow` inyectado en el servidor real, `StaticWorkerPool` en el
 * eje de teselas). Ningún parámetro de tope poblacional se toca: si el techo se mueve, lo movió
 * el hardware. Determinista salvo el eje de teselas, donde se comparan medianas de tiempos
 * reales y paridad `Object.is` exacta entre 1 y 4 workers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createApp } from '../src/server/app.js';
import {
  Gobernador, gobernar, ESTADO_GOBERNACION_INICIAL, VENTANAS_VERDES_PARA_SALIR,
  type EstadoGobernacion,
} from '../src/server/governor.js';
import { parseParams, DEFAULT_PARAMS } from '../src/world/params.js';
import { RULES_VERSION, POPULATION_HARD_LIMIT } from '../src/world/index.js';
import { EcosystemKernel, type EcosystemOptions } from '../src/world/ecosystem-kernel.js';
import { TileStore } from '../src/world/soa/terreno.js';
import { StaticWorkerPool } from '../src/world/paralelo/piscina.js';
import type { Tile } from '../src/shared/types.js';

const PRESUPUESTO = 50; // ms, constitución V: el default de `gobernador.presupuestoMs`
const COSTE_MS_POR_HABITANTE = 1; // coste sintético del paso: lineal en la población

// -------------------------------------------------------------------------------------------
// Trayectoria SC-013 a nivel de gobernador: la población crece de 1 en 1 y en cada escalón la
// ventana de 120 pasos se llena con el coste de esa población en la máquina simulada
// (`coste / factorVelocidad`). La primera vez que el gobernador frena queda `techoObservado`.
// -------------------------------------------------------------------------------------------
function simularTechoObservado(presupuestoMs: number, factorVelocidad: number): Gobernador {
  const gobernador = new Gobernador();
  for (let poblacion = 16; poblacion < 100_000; poblacion++) {
    const costeMs = poblacion * COSTE_MS_POR_HABITANTE / factorVelocidad;
    for (let i = 0; i < 120; i++) gobernador.registrar(costeMs);
    gobernador.decidir({ presupuestoMs, politica: 'techo' }, true, poblacion, poblacion * 70, poblacion);
    if (gobernador.techoObservado) return gobernador;
  }
  throw new Error('la trayectoria nunca frenó: el gobernador no puso techo');
}

/** La misma trayectoria con la función pura `gobernar()` (T162), sin la clase. */
function simularTechoPuro(presupuestoMs: number, factorVelocidad: number): number {
  let previo: EstadoGobernacion = ESTADO_GOBERNACION_INICIAL;
  for (let poblacion = 16; poblacion < 100_000; poblacion++) {
    const costeMs = poblacion * COSTE_MS_POR_HABITANTE / factorVelocidad;
    const decision = gobernar(
      { presupuestoMs, politica: 'techo', senales: ['p95'], valores: { p95: costeMs }, actual: true, poblacion },
      previo,
    );
    previo = decision.siguiente;
    if (decision.techo !== null) return decision.techo;
  }
  throw new Error('la trayectoria nunca frenó');
}

test('SC-013: sin topes fijos — doblar el presupuesto o partir el coste por la mitad duplica el techo observado y no extingue', () => {
  // Las leyes son idénticas en las tres máquinas: solo cambia el hardware (presupuesto/velocidad).
  const leyes = (presupuestoMs: number) => parseParams(`gobernador.presupuestoMs=${presupuestoMs},gobernador.politica=techo`);
  assert.equal(RULES_VERSION, 13, 'la prueba corre sobre las leyes vigentes');
  assert.deepEqual(leyes(100).poblacion, leyes(50).poblacion, 'ningún tope poblacional cambia al doblar el presupuesto');
  assert.deepEqual(leyes(100).social, leyes(50).social);
  assert.equal(DEFAULT_PARAMS.poblacion.maxima, POPULATION_HARD_LIMIT, 'el único tope que queda es el anticorrupción');
  assert.equal(POPULATION_HARD_LIMIT, 1_000_000);

  const base = simularTechoObservado(PRESUPUESTO, 1);
  const doblePresupuesto = simularTechoObservado(PRESUPUESTO * 2, 1);
  const dobleVelocidad = simularTechoObservado(PRESUPUESTO, 2);
  const techoBase = base.techoObservado!.poblacion;
  const techoPresupuesto = doblePresupuesto.techoObservado!.poblacion;
  const techoVelocidad = dobleVelocidad.techoObservado!.poblacion;
  assert.equal(techoBase, 51, 'con coste 1 ms/habitante el freno llega al superar 50 ms');
  assert.equal(techoPresupuesto, 101);
  assert.equal(techoVelocidad, 101, 'hardware 2× más rápido ≡ presupuesto 2×: mismo techo');
  assert.ok(techoVelocidad / techoBase > 1.9 && techoVelocidad / techoBase < 2.1,
    `el techo crece proporcionalmente al hardware: ${techoBase} → ${techoVelocidad}`);
  assert.match(dobleVelocidad.techoObservado!.motivo, /frenado por p95 = 50\.5 ms > 50 ms con 101 habitantes/);
  assert.ok(techoBase > 40, 'el techo ya no es el viejo tope fijo de 40 habitantes');

  // Sin techo de software escondido: con el presupuesto máximo del rango el freno llega
  // dos órdenes de magnitud más lejos, siempre por coste, nunca por una constante.
  const techoLejano = simularTechoPuro(5000, 1);
  assert.equal(techoLejano, 5001);
  assert.ok(techoLejano < POPULATION_HARD_LIMIT, 'ni siquiera ahí manda el anticorrupción: manda el presupuesto');

  // No extingue: frenado, una muerte se repone (el techo queda y la reproducción se permite).
  for (let i = 0; i < 120; i++) base.registrar((techoBase - 1) * COSTE_MS_POR_HABITANTE);
  assert.equal(base.decidir({ presupuestoMs: PRESUPUESTO, politica: 'techo' }, false, techoBase - 1, 0, 999), true,
    'por debajo del techo se repone aunque el paso siga caro');
  assert.equal(base.techoObservado!.poblacion, techoBase, 'reponer no borra ni baja el techo observado');
  assert.ok(techoBase > 0, 'el mundo frenado sigue vivo en su techo');
});

test('SC-013: monotonía de hardware — 1×, 2× y 4× sobre la misma trayectoria dan techos no decrecientes con las mismas leyes', () => {
  const techos = [1, 2, 4].map(factor => simularTechoPuro(PRESUPUESTO, factor));
  assert.deepEqual(techos, [51, 101, 201], 'cada duplicación de hardware duplica el techo admitido');
  assert.ok(techos[2]! >= techos[1]! && techos[1]! >= techos[0]!,
    `monotonía: techo(4×)=${techos[2]} ≥ techo(2×)=${techos[1]} ≥ techo(1×)=${techos[0]}`);
  // La clase y la función pura coinciden: el techo no depende de quién mida la ventana.
  assert.equal(simularTechoObservado(PRESUPUESTO, 4).techoObservado!.poblacion, techos[2]);
});

test('SC-013: anti-extinción — ni con rojo grave sostenido (10×) baja el techo ni se impide reponer; 3 ventanas verdes lo levantan', () => {
  const entrada = (p95: number, poblacion: number, actual: boolean) => ({
    presupuestoMs: PRESUPUESTO, politica: 'techo' as const, senales: ['p95', 'max'] as const,
    valores: { p95, max: p95 }, actual, poblacion,
  });
  // Rojo grave sostenido: 60 ventanas a 10× el presupuesto, con una muerte cada 3 ventanas.
  let previo: EstadoGobernacion = ESTADO_GOBERNACION_INICIAL;
  let poblacion = 30;
  let decision = gobernar(entrada(500, poblacion, true), previo);
  previo = decision.siguiente;
  assert.equal(decision.estado, 'rojo'); assert.equal(decision.palancaActiva, 'nacimientos');
  assert.equal(decision.techo, 30, 'el techo se fija en la población del frenazo');
  assert.equal(decision.reproductionEnabled, false, 'en el techo no se crece');
  for (let ventana = 0; ventana < 60; ventana++) {
    if (ventana % 3 === 2) poblacion--; // una muerte real dentro del rojo
    decision = gobernar(entrada(500, poblacion, decision.reproductionEnabled), previo);
    previo = decision.siguiente;
    assert.equal(decision.techo, 30, `el techo jamás baja (ventana ${ventana})`);
    assert.equal(decision.estado, 'rojo');
    if (poblacion < 30) {
      assert.equal(decision.reproductionEnabled, true, 'bajo el techo se repone incluso a 10× el presupuesto');
      poblacion++; // el nacimiento de reposición devuelve la población al techo, no más allá
    } else {
      assert.equal(decision.reproductionEnabled, false, 'en el techo no se crece');
    }
    assert.ok(poblacion >= 29, 'la población nunca se vacía bajo carga externa sostenida');
  }
  assert.equal(poblacion, 30, 'tras 60 ventanas a 10× el mundo sigue en su techo: no se extinguió');

  // La política histórica `apagar`, con la misma carga y una muerte, no repone: es la extinción V7.
  const apagado = gobernar(
    { presupuestoMs: PRESUPUESTO, politica: 'apagar', senales: ['p95', 'max'], valores: { p95: 500, max: 500 }, actual: false, poblacion: 29 },
    ESTADO_GOBERNACION_INICIAL,
  );
  assert.equal(apagado.reproductionEnabled, false, '`apagar` no repone bajo carga: la diferencia es la política, no el hardware');

  // Al retirarse la carga, tres ventanas verdes consecutivas (T162) levantan el freno limpiamente.
  assert.equal(VENTANAS_VERDES_PARA_SALIR, 3);
  let salida = gobernar(entrada(10, 30, false), previo);
  assert.equal(salida.estado, 'rojo'); assert.equal(salida.ventanasVerdesConsecutivas, 1);
  assert.equal(salida.techo, 30, 'una ventana verde aún no levanta el techo');
  previo = salida.siguiente;
  salida = gobernar(entrada(40, 30, false), previo); // amarilla: reinicia la cuenta
  assert.equal(salida.estado, 'rojo'); assert.equal(salida.ventanasVerdesConsecutivas, 0, 'oscilar no sale de rojo');
  previo = salida.siguiente;
  for (let n = 1; n < VENTANAS_VERDES_PARA_SALIR; n++) {
    salida = gobernar(entrada(10, 30, false), previo);
    assert.equal(salida.estado, 'rojo', `la ventana verde ${n} aún no basta`);
    previo = salida.siguiente;
  }
  salida = gobernar(entrada(10, 30, false), previo);
  assert.equal(salida.estado, 'verde'); assert.equal(salida.techo, null, 'a la tercera ventana verde el techo se retira');
  assert.equal(salida.reproductionEnabled, true, 'el crecimiento se reanuda sin tocar parámetros');

  // Y en la clase que usa el servidor: el frenazo a 10× queda publicado y no se borra al reponer.
  const gobernador = new Gobernador();
  for (let i = 0; i < 8; i++) gobernador.registrar(500);
  assert.equal(gobernador.decidir({ presupuestoMs: PRESUPUESTO, politica: 'techo' }, true, 30, 2100, 8), false);
  assert.equal(gobernador.techoObservado!.poblacion, 30);
  assert.equal(gobernador.techoObservado!.p95, 500);
  assert.equal(gobernador.decidir({ presupuestoMs: PRESUPUESTO, politica: 'techo' }, false, 29, 2100, 9), true, 'una muerte se repone a 10×');
  assert.equal(gobernador.techoObservado!.poblacion, 30, 'el techo observado sobrevive a la reposición');
});

// -------------------------------------------------------------------------------------------
// Servidor real con reloj inyectado: misma semilla, mismas leyes; el «hardware» es cuánto
// suma el guardado al reloj monotónico. Mitad de coste ≡ doble presupuesto.
// -------------------------------------------------------------------------------------------
const password = 'synthetic-test-password-only';
function fixtureServidor(t: { after: (f: () => unknown) => void }, presupuestoMs: number, costeGuardadoMs: number) {
  const dir = mkdtempSync(join(tmpdir(), 'carta-sc013-'));
  const store = new Store(join(dir, 'world.sqlite'));
  let clock = 0;
  const app = createApp({
    store, password, origin: 'http://127.0.0.1:3000', manual: true, seed: 42,
    params: parseParams(`gobernador.presupuestoMs=${presupuestoMs}`),
    monotonicNow: () => clock++,
  });
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const save = store.save.bind(store);
  store.save = ((...args: Parameters<Store['save']>) => { clock += costeGuardadoMs; return save(...args); }) as Store['save'];
  return app;
}

test('SC-013: servidor real, misma semilla — mitad de coste inyectado o doble presupuesto retiran el freno sin tocar leyes', t => {
  const lento = fixtureServidor(t, 50, 80); // paso ≈ 85 ms > 50 ms: frena
  const rapido = fixtureServidor(t, 50, 40); // hardware 2×: paso ≈ 45 ms: no frena
  const holgado = fixtureServidor(t, 100, 80); // mismo paso caro, presupuesto 2×: no frena
  for (let i = 0; i < 6; i++) { lento.stepOnce(); rapido.stepOnce(); holgado.stepOnce(); }
  for (const app of [lento, rapido, holgado]) {
    assert.equal(app.world.version, RULES_VERSION, 'las tres máquinas corren las mismas leyes');
    assert.equal(app.failed, false);
    assert.ok(app.world.people.length > 0, 'ninguna máquina extingue el mundo');
  }
  assert.equal(lento.world.people.length, rapido.world.people.length, 'misma semilla, misma población: solo frena el hardware');
  assert.equal(lento.world.people.length, holgado.world.people.length);
  assert.ok(lento.runtime.gobernador!.p95StepMs > 50, 'la máquina lenta supera el presupuesto');
  assert.equal(lento.world.reproductionEnabled, false, 'la máquina lenta frena el crecimiento');
  assert.equal(lento.runtime.gobernador!.techo, lento.world.people.length, 'su techo es la población del frenazo');
  assert.ok(lento.runtime.gobernador!.techoObservado, 'el frenazo queda publicado');
  assert.ok(rapido.runtime.gobernador!.p95StepMs < 50, 'con la mitad de coste el mismo presupuesto ya no se supera');
  assert.equal(rapido.world.reproductionEnabled, true, 'hardware 2× más rápido: el mundo sigue creciendo');
  assert.equal(rapido.runtime.gobernador!.techo, null);
  assert.equal(holgado.world.reproductionEnabled, true, 'doblar el presupuesto equivale a doblar el hardware');
  assert.equal(holgado.runtime.gobernador!.techo, null);
  assert.ok(rapido.runtime.gobernador!.p95StepMs < lento.runtime.gobernador!.p95StepMs,
    'el coste medido, no un parámetro, es lo que separó a las dos máquinas con el mismo presupuesto');
});

// -------------------------------------------------------------------------------------------
// Eje de teselas: StaticWorkerPool real sobre el terreno SoA. Paridad Object.is 1 vs 4 workers
// y stepMs del despacho: más workers ⇒ más teselas dentro del mismo presupuesto fijo.
// -------------------------------------------------------------------------------------------
function celda(x: number, y: number, variante = 0): Tile {
  return {
    x, y, terrain: variante % 11 === 0 ? 'water' : 'meadow',
    biome: variante % 11 === 0 ? 'ocean' : 'forest',
    moisture: [0.14, 0.15, 0.9, 1][variante % 4]!, vegetation: variante % 7 ? 0.7 : -0,
    food: variante % 3 ? 0.5 : -0, feature: 'none',
    life: [0, 0.44, 0.45, 0.46, 0.9, 1][variante % 6]!, fertility: variante % 2 ? 0.9 : 0.4,
    growth: variante % 3 ? 0.9 : 0.65, drinkingWater: variante % 4 ? 0.2 : 0,
    traffic: variante % 2 ? 0.03 : -0, cultivation: variante % 3 ? 0.2 : 0,
    wood: variante % 4 ? 0.999 : 12, fauna: variante % 3, variety: variante % 4,
  };
}
const CAMPOS_KERNEL = ['life', 'fertility', 'growth', 'vegetation', 'traffic', 'cultivation', 'drinkingWater', 'moisture', 'wood', 'feature', 'terrain', 'biome'] as const;
const mediana = (valores: number[]): number => [...valores].sort((a, b) => a - b)[Math.floor(valores.length / 2)]!;

test('SC-013: teselas — 4 workers dan el mismo bit que 1 hilo y meten más teselas en el mismo presupuesto', async t => {
  // Paridad exacta: cuatro bloques en cuatro regiones, mismo tick ecológico, 1 vs 4 workers.
  const base: Tile[] = [];
  for (const [ox, oy] of [[0, 0], [256, 0], [0, 256], [256, 256]] as const)
    for (let dy = 0; dy < 32; dy++) for (let dx = 0; dx < 32; dx++) base.push(celda(ox + dx, oy + dy, base.length));
  const opciones: EcosystemOptions = { soaTerreno: true, seed: 51926, cuencas: 0.4, decaimientoFertilidad: 0.001 };
  const serial = base.map(tile => ({ ...tile })), paralelo = base.map(tile => ({ ...tile }));
  const kernelSerial = new EcosystemKernel(), kernelParalelo = new EcosystemKernel();
  t.after(async () => { await kernelSerial.closeParallelPool(); await kernelParalelo.closeParallelPool(); });
  kernelSerial.step(serial, 10, 'rain', 'day', { ...opciones, hilos: 1 });
  kernelParalelo.step(paralelo, 10, 'rain', 'day', { ...opciones, hilos: 4 });
  assert.equal(kernelParalelo.parallelDiagnostics!.workers, 4, 'el camino paralelo despachó de verdad');
  assert.equal(new Set(kernelParalelo.parallelDiagnostics!.threadIds).size, 4, 'cuatro hilos físicos distintos');
  for (let i = 0; i < serial.length; i++)
    for (const campo of CAMPOS_KERNEL)
      assert.ok(Object.is(serial[i]![campo], paralelo[i]![campo]),
        `paridad Object.is: tesela ${i}, campo ${campo}, ${serial[i]![campo]} != ${paralelo[i]![campo]}`);

  // stepMs real del despacho sobre SoA: rejilla densa 768×768 (9 regiones de 256×256).
  const lado = 768, teselas: Tile[] = [];
  for (let y = 0; y < lado; y++) for (let x = 0; x < lado; x++) teselas.push(celda(x, y, teselas.length));
  const store = new TileStore();
  const terreno = store.prepareParallel(teselas, 256);
  assert.ok(terreno.regions.length >= 4, `regiones=${terreno.regions.length}`);
  const parametros = { tick: 100, weather: 'clear' as const, light: 1, decaimientoFertilidad: 0, seed: 51926, cuencas: 1, version: terreno.version };
  const stepMs: Record<number, number> = {};
  for (const workers of [1, 4]) {
    const pool = new StaticWorkerPool({
      workers, moduleURL: new URL('../src/world/ecosystem-kernel.ts', import.meta.url), exportName: 'runParallelEcosystem',
    });
    t.after(() => pool.close());
    store.beginParallel(); pool.run({ regions: terreno.regions, buffers: terreno.buffers, params: parametros }); store.commitParallel();
    const tiempos: number[] = [];
    for (let r = 0; r < 5; r++) {
      store.beginParallel();
      const inicio = performance.now();
      pool.run({ regions: terreno.regions, buffers: terreno.buffers, params: parametros });
      tiempos.push(performance.now() - inicio);
      store.commitParallel();
    }
    assert.equal(pool.diagnostics().workers, workers);
    if (workers === 4) assert.equal(new Set(pool.diagnostics().threadIds).size, 4);
    stepMs[workers] = mediana(tiempos);
    await pool.close();
  }
  const teselasPorPresupuesto = (workers: number): number => PRESUPUESTO / (stepMs[workers]! / teselas.length);
  console.log(`SC-013 teselas: ${teselas.length} teselas, stepMs(1)=${stepMs[1]!.toFixed(2)} ms, stepMs(4)=${stepMs[4]!.toFixed(2)} ms, `
    + `caben en ${PRESUPUESTO} ms: ${Math.round(teselasPorPresupuesto(1))} (1 worker) vs ${Math.round(teselasPorPresupuesto(4))} (4 workers)`);
  assert.ok(stepMs[4]! < stepMs[1]!, `más hardware, menos paso: ${stepMs[4]!.toFixed(2)} ms < ${stepMs[1]!.toFixed(2)} ms`);
  assert.ok(stepMs[1]! / stepMs[4]! >= 1.8, `aceleración ${(stepMs[1]! / stepMs[4]!).toFixed(2)}× con 4 workers`);
  assert.ok(teselasPorPresupuesto(4) >= 1.8 * teselasPorPresupuesto(1),
    'el mismo presupuesto fijo admite proporcionalmente más teselas con más hardware');
  assert.ok(teselasPorPresupuesto(4) > teselas.length, 'con 4 workers la rejilla entera cabe de sobra en el presupuesto');
});
