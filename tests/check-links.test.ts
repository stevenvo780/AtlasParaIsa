import assert from 'node:assert/strict';
import test from 'node:test';
import { enListaBlanca, enlacesRelativos, rutasVersionadas } from '../scripts/check-links.js';

test('relative links are resolved from the document and external links, anchors and code are ignored', () => {
  const texto = [
    'Ver [plan](../PLAN.md#estado-actual), [web](https://example.org) y [sección](#abajo).',
    'En código no cuenta: `[x](no/existe.md)`, y ![imagen](img/a%20b.png "título") sí.',
    '```',
    '[dentro](de/un/bloque.md)',
    '```',
    '[`símbolo`](evidencia/x.json)',
  ].join('\n');
  assert.deepEqual(enlacesRelativos('docs/NOTA.md', texto).map(({ linea, resuelto }) => [linea, resuelto]), [
    [1, 'PLAN.md'],
    [2, 'docs/img/a b.png'],
    [6, 'docs/evidencia/x.json'],
  ]);
});

test('only versioned files and their directories are valid destinations', () => {
  const rutas = rutasVersionadas(['docs/evidencia-2026-09-22/smoke.json', 'README.md']);
  assert.ok(rutas.has('docs/evidencia-2026-09-22/smoke.json'));
  assert.ok(rutas.has('docs/evidencia-2026-09-22'));
  assert.ok(rutas.has('docs'));
  assert.ok(!rutas.has('artifacts/smoke.json'));
});

test('the historical allow-list is scoped to one document and one prefix', () => {
  const enlace = (fichero: string, resuelto: string) => ({ fichero, linea: 1, destino: resuelto, resuelto });
  assert.equal(enListaBlanca(enlace('docs/EVIDENCIA.md', 'artifacts/lab/x.json')), true);
  assert.equal(enListaBlanca(enlace('docs/REGLAS.md', 'artifacts/lab/x.json')), false);
  assert.equal(enListaBlanca(enlace('docs/EVIDENCIA.md', '.superpowers/x.md')), false);
});
