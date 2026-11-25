import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CatalogoCinta } from '../src/server/cinta/catalogo.js';
import { abrirMarcadores, leerMarcador, segmentoFijado } from '../src/server/cinta/marcadores.js';
import { TICKS_PER_DAY } from '../src/world/mundo/tipos.js';

const PERFIL = 'b2de73dd-8efd-434d-b876-d8ec6084ae46';
const DIA_MS = 86400_000;
const AHORA = 20 * DIA_MS;
const BASE = { perfil: PERFIL, epoca: 0, t: 123, nivel: 2, velocidad: 1, en: AHORA };

test('valida la forma del marcador de navegador', () => {
  assert.deepEqual(leerMarcador({ ...BASE, sobra: true }), BASE);
  for (const cambio of [{ perfil: 'a/b' }, { nombre: null }, { epoca: -1 }, { t: 0.5 },
    { nivel: 5 }, { velocidad: 3 }, { en: Infinity }]) {
    assert.throws(() => leerMarcador({ ...BASE, ...cambio }), /marcador/i);
  }
});

test('retiene cinco por perfil y fija solo sus intervalos vigentes de L0', t => {
  const raiz = '/tmp/atlas-v23-o-cinta';
  mkdirSync(raiz, { recursive: true });
  const ruta = mkdtempSync(join(raiz, 'marcadores-'));
  t.after(() => rmSync(ruta, { recursive: true, force: true }));
  const catalogo = new CatalogoCinta(ruta);
  t.after(() => catalogo.db.close());
  catalogo.abrir({ instanciaId: 'marcadores', epoca: 0, tMundo: 0, motivo: 'reinicio' });
  const guardar = abrirMarcadores(ruta);
  const en = AHORA - 14 * DIA_MS;
  for (const i of [5, 4, 3, 2, 1, 0]) guardar.guardar(leerMarcador({ ...BASE, en: en + i, t: BASE.t + i }));
  guardar.guardar(leerMarcador({ ...BASE, en: en + 5, t: BASE.t + 5, nombre: 'Isa' }));
  guardar.cerrar();

  const leer = abrirMarcadores(ruta);
  t.after(() => leer.cerrar());
  assert.deepEqual(leer.leer(PERFIL).map(m => [m.en - en, m.nombre]), [[5, 'Isa'], [4, undefined], [3, undefined],
    [2, undefined], [1, undefined]]);
  assert.deepEqual(leer.fijados(AHORA + 5), [{ epoca: 0, t0: BASE.t + 5, t1: BASE.t + 5 + 14 * TICKS_PER_DAY }]);
  assert.deepEqual(leer.fijados(AHORA + 6), []);
  const tick = BASE.t + 5 + 14 * TICKS_PER_DAY;
  const segmento = { id: 1, epoca: 0, t0: tick, t1: tick, bytes: 1, visibleHasta: null };
  assert.equal(segmentoFijado(catalogo.db, { ...segmento, nivel: 0 }, AHORA + 5), true);
  assert.equal(segmentoFijado(catalogo.db, { ...segmento, nivel: 0 }, AHORA + 6), false);
  assert.equal(segmentoFijado(catalogo.db, { ...segmento, nivel: 1 }, AHORA + 5), false);
});
