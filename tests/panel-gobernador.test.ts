import test from 'node:test';
import assert from 'node:assert/strict';
import { etiquetaSalud, pedirSalud, renderPanelSalud, type SaludVisible } from '../src/client/salud-view.js';
import { worldShell } from '../src/client/world-shell.js';

const salud: SaludVisible = {
  estado: 'degradado', tick: 12345, ticksPorSegundo: 82.1, recargas: 2,
  gpu: [{ dispositivo: 0, estado: 'ok' }, { dispositivo: 1, estado: 'cpu' }, { dispositivo: 2, estado: 'sin' }],
};

test('salud muestra estado, paso, ritmo, dispositivos y recargas', () => {
  const html = renderPanelSalud(salud);
  assert.equal(etiquetaSalud(salud), 'Servidor · degradado');
  assert.match(html, /data-panel-salud data-estado="degradado"/);
  assert.match(html, /Paso<strong>12\.345<\/strong>/);
  assert.match(html, /Pasos por segundo<strong>82,1<\/strong>/);
  assert.match(html, /GPU 0 · GPU 1 → CPU · GPU 2 no disponible/);
  assert.match(html, /Recargas<strong>2<\/strong>/);
  assert.match(renderPanelSalud({ ...salud, gpu: [] }), /Cómputo<strong>CPU<\/strong>/);
  assert.match(renderPanelSalud({ ...salud, gpu: [{ dispositivo: 0, estado: 'sin' }] }), /GPU 0 no disponible · CPU/);
});

test('el panel de salud tiene su sitio y declara cuándo faltan datos', () => {
  assert.equal(etiquetaSalud(null), 'Servidor · sin datos');
  assert.match(worldShell(), /id="panel-salud"><section[^>]+data-panel-salud data-estado="sin-datos"/);
  assert.match(renderPanelSalud(null), /No hay una medición disponible/);
});

test('GET /health acepta el estado parado con HTTP 503 y rechaza errores sin salud válida', async t => {
  const parada: SaludVisible = { ...salud, estado: 'parado', ticksPorSegundo: 0 };
  const signal = new AbortController().signal;
  const fetch = t.mock.method(globalThis, 'fetch', async (_input: string | Request | URL) => Response.json(parada, { status: 503 }));
  assert.deepEqual(await pedirSalud(signal), parada);
  assert.equal(fetch.mock.calls[0]!.arguments[0], '/health');
  fetch.mock.mockImplementation(async () => Response.json(salud, { status: 503 }));
  await assert.rejects(pedirSalud(signal), /forma inesperada/);
  fetch.mock.mockImplementation(async () => Response.json({ ...salud, gpu: [null] }, { status: 200 }));
  await assert.rejects(pedirSalud(signal), /forma inesperada/);
  fetch.mock.mockImplementation(async () => new Response('Servicio no disponible', { status: 502 }));
  await assert.rejects(pedirSalud(signal), /Salud no disponible/);
});
