/**
 * V23 · V1 — lógica de la pantalla sin navegador: lectura de la telemetría del motor, luces de salud, red de
 * comunidades (aristas, coste con cientos de personas) e histograma, y la ficha de escucha.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { leerTelemetria, luzMotor, renderPanelMotor, firmaMotor, vistaMotor, type TelemetriaRecibida } from '../src/client/panel-motor.js';
import { aristasConocidas, datosGrafo, grafoComunidades, histogramaTamanos, luzMundo } from '../src/client/telemetry-hud.js';
import { escuchaFicha } from '../src/client/inspector-view.js';
import { createWorld, projectWorld } from '../src/world/index.js';
import type { RuntimeStats, WorldView } from '../src/shared/types.js';
import type { SaludVisible } from '../src/client/salud-view.js';
import type { WorldDirectoryResponse } from '../src/shared/worldmap.js';

const telemetria = (cambios: Partial<TelemetriaRecibida> = {}): TelemetriaRecibida => ({
  tick: 9600, hz: 300, diasPorMinuto: 7.5, hilos: 4, desequilibrio: .1, esperaBarreraMs: .3,
  faseMs: { F0: .2, eco: .6, percibir: 1, actuar: .8, aplicar: .4 }, ocupacion: [.9, .5, .52, .48],
  gpuMs: [.9], gpuBytes: [2 * 1048576], gpuEstado: ['ok'], intentos: 1000, rechazados: 20, migraciones: 3, fotogramasSaltados: 0, ...cambios,
});
const salud = (cambios: Partial<SaludVisible> = {}): SaludVisible => ({ estado: 'ok', tick: 9600, ticksPorSegundo: 300, gpu: [{ dispositivo: 1, estado: 'ok' }], recargas: 0, ...cambios });

test('leerTelemetria acepta la forma del contrato y rechaza la incompleta o incoherente', () => {
  assert.ok(leerTelemetria(telemetria()));
  assert.equal(leerTelemetria(null), null);
  assert.equal(leerTelemetria({ ...telemetria(), hz: -1 }), null);
  assert.equal(leerTelemetria({ ...telemetria(), faseMs: { F0: 1 } }), null);
  assert.equal(leerTelemetria({ ...telemetria(), gpuEstado: ['ok', 'cpu'] }), null, 'una tarjeta por posición en las tres listas');
  assert.equal(leerTelemetria({ ...telemetria(), gpuEstado: ['quemada'] }), null);
  const { intentos: _, ...sinIntentos } = telemetria();
  assert.equal(leerTelemetria(sinIntentos), null);
});

test('vistaMotor usa la telemetría si llega; si no, el paso y /health, con null («sin dato») en lo que falta', () => {
  const v = vistaMotor(telemetria(), salud(), undefined);
  assert.equal(v.fuente, 'motor');
  assert.equal(v.ocupacionMedia, (.9 + .5 + .52 + .48) / 4);
  assert.deepEqual(v.tarjetas, [{ dispositivo: 1, estado: 'ok', ms: .9, mib: 2 }], 'la tarjeta toma su índice CUDA de /health');
  assert.deepEqual(v.fases.map(f => f.clave), ['F0', 'eco', 'percibir', 'actuar', 'aplicar']);

  const paso = { tickHz: 120, tickHzObjetivo: 300, ocupacionWorkers: .6, tiempoBarreraMs: .5, fases: { ecologia: 2, personas: 3, save: 0 } } as unknown as RuntimeStats;
  const p = vistaMotor(null, salud({ gpu: [{ dispositivo: 0, estado: 'cpu' }] }), paso);
  assert.equal(p.fuente, 'paso');
  assert.equal(p.hz, 120); assert.equal(p.diasPorMinuto, 3);
  assert.equal(p.ocupacion, null); assert.equal(p.ocupacionMedia, .6);
  assert.equal(p.intentos, null); assert.equal(p.saltados, null);
  assert.deepEqual(p.tarjetas, [{ dispositivo: 0, estado: 'cpu', ms: null, mib: null }]);
  const html = renderPanelMotor(p, luzMotor(p));
  assert.match(html, /data-motor-hilos="media"/);
  assert.match(html, /data-motor-colas>[^<]*<strong><em class="sin-dato">sin dato<\/em>/);
  assert.doesNotMatch(html, /Intentos entre dueños<strong>0</, 'lo que no llega no se dibuja como cero');

  const nada = vistaMotor(null, null, undefined);
  assert.equal(nada.fuente, 'nada');
  assert.equal(luzMotor(nada).estado, 'sin-dato');
});

test('luzMotor: sano, atención (tarjeta en CPU, saltos nuevos, ritmo bajo, degradado) y grave (parado o quieto)', () => {
  assert.equal(luzMotor(vistaMotor(telemetria(), salud(), undefined)).estado, 'sano');
  const cpu = luzMotor(vistaMotor(telemetria({ gpuEstado: ['cpu'] }), salud(), undefined));
  assert.equal(cpu.estado, 'atencion'); assert.match(cpu.motivo, /1 tarjeta cayó a CPU/);
  const saltos = vistaMotor(telemetria({ fotogramasSaltados: 7 }), salud(), undefined);
  assert.equal(luzMotor(saltos, 7).estado, 'sano', 'los saltos ya vistos no vuelven a avisar');
  assert.match(luzMotor(saltos, 2).motivo, /saltó 5 fotogramas/);
  const lento = vistaMotor(telemetria({ hz: 200 }), salud(), { tickHzObjetivo: 300 } as RuntimeStats);
  assert.match(luzMotor(lento).motivo, /de 300 Hz pedidos/);
  assert.equal(luzMotor(vistaMotor(telemetria(), salud({ estado: 'degradado' }), undefined)).estado, 'atencion');
  assert.equal(luzMotor(vistaMotor(telemetria(), salud({ estado: 'parado' }), undefined)).estado, 'grave');
  assert.equal(luzMotor(vistaMotor(telemetria({ hz: 0 }), salud(), undefined)).estado, 'grave');
});

test('firmaMotor no cambia con ruido dentro de un escalón de ocupación y sí con un dato visible', () => {
  const firma = (t: TelemetriaRecibida) => { const v = vistaMotor(t, salud(), undefined); return firmaMotor(v, luzMotor(v)); };
  const base = firma(telemetria());
  assert.equal(firma(telemetria({ ocupacion: [.91, .5, .52, .48], esperaBarreraMs: .301 })), base, 'ruido por debajo de lo que se dibuja');
  assert.notEqual(firma(telemetria({ ocupacion: [.4, .5, .52, .48] })), base);
  assert.notEqual(firma(telemetria({ fotogramasSaltados: 1 })), base);
});

test('luzMundo: población y tendencia del último día; caída del 10 % pide atención, del 40 % es grave', () => {
  assert.equal(luzMundo(null).estado, 'sin-dato');
  const mundo = (inicial: number, final: number): WorldView => ({
    stats: { population: final, history: [{ tick: 1000, population: inicial }, { tick: 2200, population: (inicial + final) / 2 }, { tick: 3400, population: final }] },
  }) as unknown as WorldView;
  assert.deepEqual([luzMundo(mundo(100, 104)).estado, luzMundo(mundo(100, 104)).valor], ['sano', '104 ↑']);
  assert.equal(luzMundo(mundo(100, 88)).estado, 'atencion');
  assert.equal(luzMundo(mundo(100, 55)).estado, 'grave');
  assert.equal(luzMundo(mundo(100, 0)).estado, 'grave');
});

test('aristasConocidas: mutua con el menor de los dos sentidos; un solo sentido queda marcado', () => {
  const aristas = aristasConocidas([
    { id: 'a', trust: [{ id: 'b', value: .8 }, { id: 'c', value: .3 }, { id: 'a', value: 1 }, { id: 'd', value: 0 }] },
    { id: 'b', trust: [{ id: 'a', value: .6 }] },
  ]);
  assert.deepEqual(aristas.sort((x, y) => x.b.localeCompare(y.b)), [{ a: 'a', b: 'b', peso: .6, mutua: true }, { a: 'a', b: 'c', peso: .3, mutua: false }]);
});

test('grafoComunidades con 800 personas: los elementos dependen de las comunidades, no de las personas, y es barato', () => {
  const comunidades = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, x: i * 30, y: i * 10, color: `#${(0x405060 + i * 0x0a0a0a).toString(16)}`, memberCount: 72, cooperation: 0, disputes: 0 }));
  const people = Array.from({ length: 800 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, role: 'neighbor', x: (i * 37) % 400, y: (i * 53) % 200, action: 'rest', age: 0, generation: 1, communityId: i % 10 === 9 ? null : `c${i % 9}`, hunger: 0, energy: 1 }));
  const directorio = { people, communities: comunidades } as unknown as WorldDirectoryResponse;
  const fichas = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, trust: Array.from({ length: 12 }, (_, k) => ({ id: `p${(i * 7 + k * 13) % 800}`, value: ((k + 1) % 10) / 10 })) }));
  const t0 = performance.now();
  const g = grafoComunidades(datosGrafo({ people: [], communities: [] } as unknown as WorldView, directorio, fichas, 'p0'));
  const ms = performance.now() - t0;
  assert.equal(g.nodos.length, 800);
  const elementos = (g.html.match(/<(path|circle|rect)\b/g) ?? []).length;
  // 10 halos + ≤ 11 colores de nodos + grupos de aristas (2 colores × 4 grosores × 2 trazos × 2) + la selección
  assert.ok(elementos <= 10 + 11 + 32 + 1, `elementos: ${elementos}`);
  assert.match(g.html, /data-nodos="800"/);
  assert.match(g.html, /class="grafo-seleccion"/);
  assert.ok(ms < 100, `armar el grafo tardó ${ms.toFixed(1)} ms`);
  assert.match(grafoComunidades(datosGrafo({ people: [], communities: [] } as unknown as WorldView, null, [], null)).html, /data-grafo-vacio/);
});

test('histogramaTamanos: clases que se doblan hasta la mayor comunidad, con mediana, p90 y máximo', () => {
  const html = histogramaTamanos([1, 2, 3, 5, 9, 17, 70].map((miembros, i) => ({ id: `c${i}`, nombre: `C${i}`, color: '#000', miembros })));
  assert.deepEqual([...html.matchAll(/data-clase="([\d-]+)"/g)].map(m => m[1]), ['1-2', '3-4', '5-8', '9-16', '17-32', '33-64', '65-128']);
  assert.match(html, /mediana 5 · p90 70 · mayor 70/);
  assert.match(histogramaTamanos([]), /data-histograma-vacio/);
});

test('escuchaFicha: barra propia junto a la de sus progenitores, «sin dato» si el mundo no trae la escucha', () => {
  const view = projectWorld(createWorld(51926));
  const [s, i, hija] = [view.people.find(p => p.id === 's')!, view.people.find(p => p.id === 'i')!, view.people.find(p => p.id === 'neighbor-3')!];
  assert.match(escuchaFicha(hija, view), /data-escucha="sin-dato"/);
  Object.assign(s.traits as object, { escucha: .8 }); Object.assign(i.traits as object, { escucha: .4 }); Object.assign(hija.traits as object, { escucha: .6 });
  hija.genome = { ...hija.genome!, generation: 1, parents: ['s', 'i'] };
  const html = escuchaFicha(hija, view);
  assert.match(html, /data-escucha="0.60"/);
  assert.equal((html.match(/escucha-fila escucha-padre/g) ?? []).length, 2);
  assert.match(html, /aria-valuenow="0.80"/);
  assert.match(html, /data-escucha-ahora/);
  hija.genome = { ...hija.genome, parents: ['s', 'alguien-lejos'] };
  assert.match(escuchaFicha(hija, view), /fuera de esta vista/);
});
