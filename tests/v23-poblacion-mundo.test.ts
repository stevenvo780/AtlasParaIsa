import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertWorld, createWorld, stepWorld } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { paramsOf } from '../src/world/params.js';
import { crearComprobador } from '../src/world/invariantes.js';
import { archivoDeChunks, cargarPunto, guardarPunto, medir, paramsDeCorrida, poblar, type Registro, type Zona } from '../scripts/lab/poblacion.mjs';

// Pruebas con el mundo de verdad (régimen abierto del panel, un hilo, sin tarjeta). Sondas cortas: la torre va cargada.
const ZONA: Zona = { x: 0, y: 0, ancho: 48, alto: 32 };
const abierto = () => paramsDeCorrida({ regimen: 'abierto', hilos: 1, gpu: [] });
const sembrado = (semilla: number, n: number, siembra = semilla) => {
  const mundo = createWorld(semilla, abierto());
  return { mundo, ...poblar(mundo, { n, zona: ZONA, siembra }) };
};

const sinTiempos = (r: Registro) => JSON.stringify({ ...r, dias: r.dias.map(({ msPared, ticksPorSegundo, carga, ...d }) => d) });

test('(a) poblar y medir es reproducible con un hilo y semilla, y cada sembrado pasa las validaciones del mundo', { timeout: 1_200_000 }, () => {
  const correrSonda = () => {
    const { mundo, sembrados, caminables } = sembrado(7, 40);
    assert.equal(sembrados.length, 40);
    assert.equal(mundo.people.filter(p => p.role === 'neighbor').length, 40, 'los vecinos fundadores se sustituyen');
    assertWorld(mundo);
    assert.deepEqual(crearComprobador()(mundo).filter(v => v.gravedad === 'dura'), []);
    const inicial = digestoCanonico(mundo), totales = { ...mundo.totals }, muertes = { ...mundo.demographyDynamics.causes };
    const { archivar } = archivoDeChunks(mundo);
    const registro = medir(mundo, { dias: 1, ticks: 600, zona: ZONA, caminables, archivar, cadaInvariantes: 300 });
    assertWorld(mundo);
    assert.equal(registro.violaciones.duras, 0);
    // El registro cuadra con la contabilidad del propio mundo.
    const nacidos = registro.individuos.filter(i => i.origen === 'nacido');
    assert.equal(nacidos.length, (mundo.totals.births ?? 0) - (totales.births ?? 0));
    for (const causa of ['starvation', 'dehydration', 'exposure', 'senescence'] as const)
      assert.equal(registro.individuos.filter(i => i.causa === causa).length, mundo.demographyDynamics.causes[causa] - muertes[causa]);
    assert.equal(registro.individuos.filter(i => i.hasta === null).length, mundo.people.filter(p => p.role === 'neighbor').length);
    assert.equal(registro.individuos.reduce((s, i) => s + i.hijos.length, 0), 2 * nacidos.length);
    return { inicial, final: digestoCanonico(mundo), registro };
  };
  const a = correrSonda(), b = correrSonda();
  assert.equal(a.inicial, b.inicial, 'misma siembra: mismo mundo poblado');
  assert.equal(a.final, b.final, 'mismo mundo tras 600 pasos');
  assert.equal(sinTiempos(a.registro), sinTiempos(b.registro), 'mismo registro');
  const otra = createWorld(7, abierto());
  poblar(otra, { n: 40, zona: ZONA, siembra: 8 });
  assert.notEqual(digestoCanonico(otra), a.inicial, 'otra siembra: otra población');
});

test('un punto guardado sigue igual que el mundo que no se detuvo', { timeout: 600_000 }, () => {
  mkdirSync('/tmp/atlas-v23-pob', { recursive: true });
  const dir = mkdtempSync('/tmp/atlas-v23-pob/test-'), ruta = join(dir, 'punto.v8');
  try {
    const continuo = sembrado(51926, 30).mundo, partido = sembrado(51926, 30).mundo;
    const archivoContinuo = archivoDeChunks(continuo), archivoPartido = archivoDeChunks(partido);
    for (let t = 0; t < 150; t++) { stepWorld(continuo); stepWorld(partido); }
    archivoContinuo.archivar(); archivoPartido.archivar();
    guardarPunto(ruta, partido, archivoPartido.archivo);
    const { mundo: cargado, archivo } = cargarPunto(ruta);
    archivoDeChunks(cargado, archivo);
    assertWorld(cargado);
    assert.deepEqual(paramsOf(cargado), paramsOf(continuo));
    for (let t = 0; t < 150; t++) { stepWorld(continuo); stepWorld(cargado); }
    assert.equal(digestoCanonico(cargado), digestoCanonico(continuo));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

