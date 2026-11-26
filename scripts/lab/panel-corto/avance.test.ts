/**
 * Prueba focal del avance pasivo. No arranca un mundo.
 *   node --import tsx --test scripts/lab/panel-corto/avance.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  crearAvance, panelAvanceActivo, INTERVALO_AVANCE_MS, type MarcaAvance,
} from './avance.js';

function banco(intervaloMs = INTERVALO_AVANCE_MS) {
  const lineas: string[] = [];
  let reloj = 0;
  const avance = crearAvance({
    intervaloMs,
    ahora: () => reloj,
    escribir: linea => { lineas.push(linea); },
  });
  const marcas = (): MarcaAvance[] => lineas.map(linea => JSON.parse(linea) as MarcaAvance);
  return {
    avance, lineas, marcas,
    set(t: number) { reloj = t; },
  };
}

function assertMonotono(marcas: readonly MarcaAvance[]): void {
  let piso = Number.NEGATIVE_INFINITY;
  for (const marca of marcas) {
    assert.equal(marca.tipo, 'avance');
    assert.ok(marca.tick >= piso, JSON.stringify(marca));
    piso = marca.tick;
    if (marca.borde === 'fin') {
      assert.equal(typeof marca.tickInicio, 'number');
      assert.ok(marca.tickInicio! <= marca.tick);
      assert.equal(typeof marca.dtMs, 'number');
      assert.ok(marca.dtMs! >= 0);
    } else {
      assert.equal(marca.borde, 'inicio');
      assert.equal(marca.tickInicio, undefined);
      assert.equal(marca.dtMs, undefined);
    }
  }
}

test('CARTA_PANEL_AVANCE solo se enciende con 1', () => {
  assert.equal(panelAvanceActivo({ CARTA_PANEL_AVANCE: '1' }), true);
  assert.equal(panelAvanceActivo({ CARTA_PANEL_AVANCE: '0' }), false);
  assert.equal(panelAvanceActivo({ CARTA_PANEL_AVANCE: 'true' }), false);
  assert.equal(panelAvanceActivo({}), false);
});

test('activo false no lee el reloj ni escribe', () => {
  const avance = crearAvance({
    activo: false,
    ahora: () => { throw new Error('reloj'); },
    escribir: () => { throw new Error('escribe'); },
  });
  avance.entrar('paso', 0);
  avance.salir('paso', 1);
  avance.cerrar(1);
});

test('el camino sano no escribe por tick y renueva al vencer el reloj', () => {
  const { avance, lineas, marcas, set } = banco();
  const n = 5_000;
  for (let i = 0; i < n; i++) {
    avance.entrar('paso', i);
    avance.salir('paso', i + 1);
  }
  assert.equal(lineas.length, 1);
  assert.equal(marcas()[0]!.borde, 'inicio');
  assert.equal(marcas()[0]!.tick, 0);
  set(INTERVALO_AVANCE_MS - 1);
  avance.entrar('paso', n);
  assert.equal(lineas.length, 1);
  set(INTERVALO_AVANCE_MS);
  avance.entrar('paso', n);
  assert.equal(lineas.length, 3);
  const fin = marcas()[1]!, inicio = marcas()[2]!;
  assert.equal(fin.borde, 'fin');
  assert.equal(fin.fase, 'paso');
  assert.equal(fin.tickInicio, 0);
  assert.equal(fin.tick, n);
  assert.equal(fin.dtMs, INTERVALO_AVANCE_MS);
  assert.equal(inicio.borde, 'inicio');
  assert.equal(inicio.tick, n);
  assert.ok(fin.tick <= inicio.tick);
  assertMonotono(marcas());
  for (const linea of lineas) assert.equal(linea.endsWith('\n') && !linea.slice(0, -1).includes('\n'), true);
});

test('un bloqueo de CPU deja el inicio visible y el fin al volver, de un solo paso', () => {
  const { avance, lineas, marcas, set } = banco();
  avance.entrar('paso', 57_600);
  assert.equal(lineas.length, 1);
  assert.deepEqual(marcas()[0], { tipo: 'avance', fase: 'paso', borde: 'inicio', tick: 57_600 });
  set(44 * 60 * 1_000);
  avance.salir('paso', 57_601);
  const fin = marcas()[1]!;
  assert.equal(fin.borde, 'fin');
  assert.equal(fin.fase, 'paso');
  assert.equal(fin.tickInicio, 57_600);
  assert.equal(fin.tick, 57_601);
  assert.equal(fin.dtMs, 44 * 60 * 1_000);
  assert.equal(fin.tick - fin.tickInicio!, 1);
});

test('un bloqueo en una segunda etapa periódica dentro de los 2 s deja su inicio visible', () => {
  for (const fase of ['reunion', 'verificacion', 'archivo', 'censo', 'digesto'] as const) {
    const { avance, marcas, set } = banco();
    avance.entrar(fase, 120);
    set(10);
    avance.salir(fase, 120);
    assert.deepEqual(marcas().at(-1), { tipo: 'avance', fase, borde: 'fin', tick: 120, tickInicio: 120, dtMs: 10 });
    avance.entrar('paso', 120);
    assert.deepEqual(marcas().at(-1), { tipo: 'avance', fase: 'paso', borde: 'inicio', tick: 120 });
    for (let tick = 120; tick < 240; tick++) {
      avance.entrar('paso', tick);
      avance.salir('paso', tick + 1);
    }
    set(INTERVALO_AVANCE_MS - 1);
    avance.entrar(fase, 240);
    // La llamada a la etapa todavía no ha devuelto el control.
    assert.deepEqual(marcas().at(-1), { tipo: 'avance', fase, borde: 'inicio', tick: 240 });
    assertMonotono(marcas());
  }
});

test('la frontera de tick no retrocede', () => {
  const { avance, marcas, set } = banco();
  avance.entrar('paso', 50);
  avance.salir('paso', 52);
  set(INTERVALO_AVANCE_MS);
  avance.entrar('paso', 40);
  avance.entrar('reunion', 30);
  const ticks = marcas().map(marca => marca.tick);
  assert.deepEqual(ticks, [...ticks].sort((a, b) => a - b));
  assert.ok(ticks.every(tick => tick >= 50));
  for (const marca of marcas()) {
    if (marca.borde === 'fin') assert.ok(marca.tickInicio! <= marca.tick);
  }
});

test('el archivo cierra al salir y no absorbe el tiempo posterior', () => {
  const { avance, marcas, set } = banco();
  avance.entrar('archivo', 2_400);
  set(3);
  avance.salir('archivo', 2_400);
  set(3_000);
  avance.cerrar(2_400);
  const fines = marcas().filter(marca => marca.fase === 'archivo' && marca.borde === 'fin');
  assert.equal(fines.length, 1);
  assert.equal(fines[0]!.dtMs, 3);
  assert.equal(fines[0]!.tick, 2_400);
});

test('cerrar escribe el fin del tramo abierto y un stderr roto no se reintenta', () => {
  const { avance, marcas, set } = banco();
  avance.entrar('archivo', 60_000);
  set(10);
  avance.cerrar(60_000);
  avance.cerrar(60_000);
  assert.equal(marcas().length, 2);
  assert.equal(marcas()[1]!.borde, 'fin');
  assert.equal(marcas()[1]!.fase, 'archivo');
  assert.equal(marcas()[1]!.tick, 60_000);
  assert.equal(marcas()[1]!.dtMs, 10);

  let intentos = 0;
  const roto = crearAvance({
    ahora: () => 0,
    escribir: () => { intentos++; throw new Error('stderr cerrado'); },
  });
  assert.doesNotThrow(() => {
    roto.entrar('paso', 1);
    roto.entrar('verificacion', 1);
    roto.salir('verificacion', 1);
  });
  assert.equal(intentos, 1);
});

test('overhead estructural del camino sano: sin escritura por tick', (t) => {
  const { avance, lineas } = banco();
  const quieto = crearAvance({ activo: false });
  const n = 100_000;
  avance.entrar('paso', 0);
  avance.salir('paso', 1);
  const antes = lineas.length;
  const t0 = performance.now();
  for (let i = 1; i < n; i++) {
    avance.entrar('paso', i);
    avance.salir('paso', i + 1);
  }
  const dtInyectado = performance.now() - t0;
  assert.equal(lineas.length, antes);

  let marcas = 0;
  const real = crearAvance({ escribir: () => { marcas++; } });
  const t1 = performance.now();
  for (let i = 0; i < n; i++) {
    real.entrar('paso', i);
    real.salir('paso', i + 1);
  }
  const dtReal = performance.now() - t1;
  real.cerrar(n);
  const t2 = performance.now();
  for (let i = 0; i < n; i++) {
    quieto.entrar('paso', i);
    quieto.salir('paso', i + 1);
  }
  const dtQuieto = performance.now() - t2;
  const us = (ms: number, llamadas: number) => ms * 1_000 / llamadas;
  t.diagnostic([
    `reloj inyectado ${us(dtInyectado, (n - 1) * 2).toFixed(3)} µs/llamada`,
    `performance.now ${us(dtReal, n * 2).toFixed(3)} µs/llamada en ${dtReal.toFixed(2)} ms, marcas ${marcas}`,
    `apagado ${us(dtQuieto, n * 2).toFixed(3)} µs/llamada`,
  ].join('; '));
  assert.ok(us(dtReal, n * 2) < 20, `overhead ${us(dtReal, n * 2)} µs`);
  assert.ok(marcas < n / 10, `demasiadas marcas en el camino sano: ${marcas}`);
});
