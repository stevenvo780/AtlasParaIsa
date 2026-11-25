import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { biologia, confirmar, correrPanel, correrPanelAsync, crearRaiz, leerFilas, leerTexto, temporal } from './v23-panel-ayuda.js';

const base = temporal();
test.after(() => rmSync(base, { recursive: true, force: true }));

const OTRA_DIVERSIDAD = 'export const indiceDiversidad = (mundo: any) => ({ total: mundo.people.length / 20 });\n';

test('un commit en el brazo mientras una corrida espera en la cola no deja en la caché una corrida del árbol nuevo bajo la clave del viejo', async () => {
  const raiz = crearRaiz(base, 'cambiante'), gemela = crearRaiz(base, 'gemela'), cache = join(base, 'cache');
  const panel = correrPanelAsync(['--brazo', raiz, '--semillas', '7,9', '--replicas', '1', '--dias', '120', '--paralelo', '1', '--cache', cache, '--salida', join(base, 'carrera')]);
  const primera = join(base, 'carrera', '1-cambiante-7-1.jsonl'), limite = Date.now() + 120_000;
  while (Date.now() < limite && !(existsSync(primera) && leerTexto(primera).includes('"tipo":"censo"'))) await new Promise(r => setTimeout(r, 50));
  // La semilla 9 aún no arrancó: el árbol del brazo cambia antes de que su proceso cargue el código.
  confirmar(raiz, 'src/world/diversidad.ts', OTRA_DIVERSIDAD);
  const r = await panel;
  assert.equal(r.codigo, 0, r.stderr);
  // Lo que la caché sirva para el árbol original (la gemela, que nunca cambió) tiene que ser lo que ese árbol simula.
  for (const semilla of [7, 9]) {
    const servida = correrPanel(['--brazo', gemela, '--semillas', String(semilla), '--replicas', '1', '--dias', '120', '--paralelo', '1', '--cache', cache, '--salida', join(base, `servida-${semilla}`)]);
    const directa = correrPanel(['--brazo', gemela, '--semillas', String(semilla), '--replicas', '1', '--dias', '120', '--paralelo', '1', '--cache', 'sin', '--salida', join(base, `directa-${semilla}`)]);
    assert.equal(servida.codigo, 0, servida.stderr);
    const filas = (salida: string) => biologia(leerFilas(join(base, salida, `1-gemela-${semilla}-1.jsonl`)));
    assert.deepEqual(filas(`servida-${semilla}`), filas(`directa-${semilla}`), `semilla ${semilla}: la caché devolvió una corrida de otro árbol`);
  }
  const marca = leerFilas(join(base, 'carrera', '1-cambiante-9-1.jsonl'))[0]!.cache;
  assert.equal(marca.estado, 'sin-cache');
  assert.match(marca.motivo, /árbol del brazo cambió/);
});
