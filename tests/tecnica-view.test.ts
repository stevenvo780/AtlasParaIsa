import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, projectWorld, stepWorld } from '../src/world/index.js';
import { etiquetaEnDosLineas, origenReceta, technologyPane } from '../src/client/technology-art.js';
import { resumenVivo } from '../src/server/resumen-vivo.js';
import { paramsOf } from '../src/world/params.js';

test('M9: las etiquetas del grafo van en dos líneas sin cortar palabras', () => {
  assert.deepEqual(etiquetaEnDosLineas('Dar forma · Entrelazar · Comprimir 1733'), ['Dar forma · Entrelazar', 'Comprimir 1733']);
  assert.deepEqual(etiquetaEnDosLineas('Usar · Desgastar · Unir · Calentar · Enfriar · Enfriar · Dar forma 2058'), ['Usar · Desgastar · Unir', 'Calentar … 2058'], 'el número que identifica el procedimiento no se pierde');
  for (const texto of ['Usar · Desgastar · Unir · Calentar · Enfriar · Enfriar · Dar forma 2058', 'Reciclar · Entrelazar 12', 'Procedimiento fuera de esta vista']) {
    const lineas = etiquetaEnDosLineas(texto);
    assert.ok(lineas.length <= 2);
    const palabras = new Set(texto.split(/\s+/));
    for (const linea of lineas) for (const palabra of linea.split(' ')) assert.ok(palabra === '…' || palabras.has(palabra), `«${palabra}» es una palabra entera de «${texto}»`);
    assert.ok(lineas.every(linea => linea.length <= 24 || !linea.includes(' ')));
  }
});

test('M9: Oficios muestra la transmisión, la diversidad con su paso y nunca «Proceso N»', () => {
  const world = createWorld(51926);
  for (let i = 0; i < 400; i++) stepWorld(world);
  const view = projectWorld(world);
  const html = technologyPane(view.technology, view.organization, new Map(), view.stats);
  assert.match(html, /Recetas enseñadas<\/span><strong>\d+/);
  assert.match(html, /Productos reutilizados<\/span><strong>\d+/);
  const paso = view.stats!.statsTick!.toLocaleString('es-CO');
  const nota = `Diversidad de oficios</span><strong>\\d+ %</strong><small>Reparto de los oficios dominantes[^<]*medido en el paso ${paso}`;
  if (view.stats!.diversidad) assert.match(html, new RegExp(nota));
  // La habituación solo se afirma si el mundo mostrado la aplica (el dato llega en RuntimeStats.conducta).
  assert.doesNotMatch(html, /habituación/i, 'sin el dato no se afirma la ley');
  const con = technologyPane(view.technology, view.organization, new Map(), view.stats, resumenVivo(world).conducta);
  assert.equal(paramsOf(world).conducta.habituacion, 0.35, 'reglas 10: los mundos nuevos la aplican');
  if (view.stats!.diversidad) assert.match(con, /Con habituación: lo que alguien ya practicó mucho le atrae menos/);
  assert.doesNotMatch(technologyPane(view.technology, view.organization, new Map(), view.stats, { habituacion: 0 }), /habituación/i);
  assert.doesNotMatch(html, /tiende a lo que practica/, 'la habituación hace lo contrario: resta valor a repetir');
  assert.doesNotMatch(html, /Proceso \d/);
  assert.doesNotMatch(html, /1 ejecuciones/);
  assert.match(origenReceta({ inventorId: 'neighbor-desconocido', tick: 2500 }), /^Inventada por un habitante que este navegador no ha visto el día 2\.$/);
  assert.equal(origenReceta({}), '', 'sin autor no se dice nada');
  assert.equal(origenReceta({ inventorId: 'neighbor-x' }), 'Inventada por un habitante que este navegador no ha visto.', 'sin paso no se inventa un día');
});
