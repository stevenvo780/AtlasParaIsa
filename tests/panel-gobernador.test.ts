import test from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeStats, WorldView } from '../src/shared/types.js';
import { formatearPanelGobernador, renderPanelGobernador } from '../src/client/gobernador-view.js';
import { worldShell } from '../src/client/world-shell.js';

function runtimeCon(gobernador: NonNullable<RuntimeStats['gobernador']>): RuntimeStats {
  return {
    stepMs: 10, p95StepMs: gobernador.p95StepMs, saveMs: 1, projectionMs: 1, snapshotBytes: 1024,
    activeTiles: gobernador.teselasActivas ?? 1000, processRssMiB: 100, tickHz: 10,
    fases: { maintainRegions: 0, ecologia: 0, kernel: 0, fauna: 0, personas: 0, encuentros: 0, demografia: 0, comunidades: 0, reproduccion: 0, checkpoint: 0, muestreo: 0, save: 0, broadcast: 0 },
    fraccionSerial: 0, gobernador,
  };
}

function stateCon(gobernador: NonNullable<RuntimeStats['gobernador']>, population: number): WorldView {
  return {
    version: 10, sequence: 1, tick: 2400, day: 2, phase: 'day', weather: 'clear', width: 40, height: 28,
    tiles: [], people: [], places: [], events: [], memories: [],
    stats: { population, meanEnergy: 0, meanHunger: 0, meanFatigue: 0, meanThirst: 0, materials: { wood: 0, stone: 0 }, actions: {}, biomes: {}, features: {}, totals: {}, generations: {}, history: [], scope: 'active-regions', wildlife: {}, freshWater: 0, cultivatedTiles: 0, trailTiles: 0 },
    performance: runtimeCon(gobernador),
  } as WorldView;
}

const frenazo = {
  p95: 52, poblacion: 23, teselasActivas: 1000, teselasPorHabitante: 1000 / 23, senal: 'p95', tick: 2400,
  motivo: 'frenado por p95 = 52 ms > 50 ms con 23 habitantes y 1000 teselas activas',
};

test('el panel muestra estado, señal, pico, teselas por habitante y techo observado a partir del state', () => {
  const state = stateCon({
    activo: false, presupuestoMs: 50, p95StepMs: 52, manual: null, politica: 'techo', techo: 23,
    estado: 'rojo', p95Ms: 52, maxMs: 120, faseMax: 'comunidades', senal: 'p95',
    teselasActivas: 1000, teselasPorHabitante: 1000 / 23, techoPoblacion: 23, techoObservado: frenazo,
  }, 23);
  const panel = formatearPanelGobernador(state);
  assert.ok(panel);
  assert.equal(panel.estado, 'rojo');
  assert.equal(panel.senal, 'p95');
  assert.match(panel.texto, /Estado del gobernador: rojo/);
  assert.match(panel.texto, /Señal disparadora: p95/);
  assert.match(panel.texto, /paso p95 52 ms frente a 50 ms de presupuesto/);
  assert.match(panel.texto, /margen -2 ms/);
  assert.match(panel.texto, /Pico máximo de la ventana: 120 ms en la fase comunidades/);
  assert.match(panel.texto, /Teselas activas por habitante:/);
  assert.match(panel.texto, /1\.000 teselas activas \/ 23 habitantes/);
  assert.match(panel.texto, /Techo de población: 23 habitantes/);
  assert.match(panel.texto, /Techo observado: frenado por p95 = 52 ms/);
  assert.match(panel.html, /data-panel-gobernador/);
  assert.match(panel.html, /data-estado="rojo"/);
  assert.match(renderPanelGobernador(state), /Panel del gobernador/);
});

test('el techo observado se conserva visible aunque el estado actual vuelva a verde', () => {
  const state = stateCon({
    activo: true, presupuestoMs: 50, p95StepMs: 20, manual: null, politica: 'techo', techo: null,
    estado: 'verde', p95Ms: 20, senal: 'p95', teselasActivas: 1000, techoObservado: frenazo,
  }, 23);
  const panel = formatearPanelGobernador(state)!;
  assert.equal(panel.estado, 'verde');
  assert.match(panel.texto, /Estado del gobernador: verde/);
  assert.match(panel.texto, /Techo observado: frenado por p95 = 52 ms/);
  assert.match(panel.texto, /En el último frenazo:/);
  assert.ok(panel.techoObservado, 'el registro del frenazo no se borra al volver a verde');
});

test('sin motivo legible, el techo observado se compone desde sus cifras', () => {
  const panel = formatearPanelGobernador({
    activo: false, presupuestoMs: 50, p95StepMs: 60, manual: null, politica: 'techo', teselasPorHabitante: 50,
    techoObservado: { p95: 60, poblacion: 10, teselasActivas: 500, teselasPorHabitante: 50, senal: 'p95', tick: 120, motivo: '' },
  }, 10)!;
  assert.match(panel.texto, /Estado del gobernador: rojo/);
  assert.match(panel.texto, /Teselas activas por habitante: 50/);
  assert.match(panel.texto, /Techo observado: frenado por p95 = 60 ms con 10 habitantes y 500 teselas activas/);
});

test('cuando el gobernador está en modo manual lo indica explícitamente', () => {
  const porOrden = formatearPanelGobernador(runtimeCon({
    activo: false, presupuestoMs: 50, p95StepMs: 20, manual: false, politica: 'techo', techo: null, techoObservado: null,
  }), 23)!;
  assert.equal(porOrden.estado, 'manual');
  assert.equal(porOrden.manual, true);
  assert.match(porOrden.texto, /Estado del gobernador: manual/);
  assert.match(porOrden.texto, /Gobernador en modo manual/);
  assert.match(porOrden.texto, /por orden manual/);
  assert.match(porOrden.html, /data-manual="true"/);

  const porEstado = formatearPanelGobernador({
    estado: 'manual', politica: 'techo', presupuestoMs: 50, p95Ms: 20, reproductionEnabled: false,
    teselasPorHabitante: 4, techoObservado: null,
  })!;
  assert.equal(porEstado.estado, 'manual');
  assert.match(porEstado.texto, /Gobernador en modo manual/);
  assert.match(porEstado.texto, /reproductionEnabled fijado manualmente/);
});

test('teselas por habitante derivadas, cero habitantes y ausencia de gobernador', () => {
  const derivado = formatearPanelGobernador(runtimeCon({
    activo: true, presupuestoMs: 50, p95StepMs: 20, manual: null, politica: 'techo', teselasActivas: 1000, techoObservado: null,
  }), 20)!;
  assert.equal(derivado.teselasPorHabitante, 50);
  assert.match(derivado.texto, /Teselas activas por habitante: 50/);

  const sinHabitantes = formatearPanelGobernador(runtimeCon({
    activo: true, presupuestoMs: 50, p95StepMs: 20, manual: null, teselasActivas: 100, techoObservado: null,
  }), 0)!;
  assert.match(sinHabitantes.texto, /sin habitantes/);

  assert.equal(formatearPanelGobernador(undefined), null);
  assert.equal(formatearPanelGobernador(runtimeCon({ activo: true, presupuestoMs: 50, p95StepMs: 10, manual: null }))!.estado, 'verde');
  assert.equal(renderPanelGobernador(undefined), '');
});

test('el shell del mundo reserva el contenedor del panel (escritorio y observador comparten shell)', () => {
  const shell = worldShell();
  assert.match(shell, /id="panel-gobernador"/);
  assert.match(shell, /data-panel-gobernador-contenedor/);
  assert.match(shell, /id="stats-drawer"/);
});
