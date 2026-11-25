import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { biologia, correrPanel, correrPanelAsync, crearRaiz, leerFilas, leerTexto, PANEL, temporal } from './v23-panel-ayuda.js';

const base = temporal();
test.after(() => rmSync(base, { recursive: true, force: true }));

test('otra versión de panel.ts no acierta en las entradas que guardó la anterior', () => {
  const raiz = crearRaiz(base, 'raiz'), cache = join(base, 'cache');
  // Una copia del panel con una línea más, en un árbol propio con node_modules (para resolver tsx) y módulos ES como el repositorio.
  const copia = join(base, 'copia'), modulos = fileURLToPath(new URL('../node_modules', import.meta.url));
  mkdirSync(join(copia, 'scripts/lab'), { recursive: true });
  writeFileSync(join(copia, 'scripts/lab/panel.ts'), `${readFileSync(PANEL, 'utf8')}\n// otra versión\n`);
  symlinkSync(modulos, join(copia, 'node_modules'));
  writeFileSync(join(copia, 'package.json'), '{ "type": "module" }\n');
  const pedir = (panel: string, n: string) => {
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), panel, '--brazo', raiz, '--semillas', '7', '--replicas', '1', '--dias', '3', '--paralelo', '1', '--cache', cache, '--salida', join(base, n)],
      { encoding: 'utf8', env: { ...process.env, CARTA_PANEL_CACHE: '' } });
    assert.equal(r.status, 0, r.stderr);
    return leerFilas(join(base, n, '1-raiz-7-1.jsonl'))[0]!.cache;
  };
  const original = pedir(PANEL, 'original');
  assert.equal(original.estado, 'fallo');
  assert.equal(pedir(PANEL, 'original-otra-vez').estado, 'acierto', 'control: el mismo panel acierta');
  const otra = pedir(join(copia, 'scripts/lab/panel.ts'), 'copia');
  assert.equal(otra.estado, 'fallo');
  assert.notEqual(otra.clave, original.clave);
});

test('si el fichero de --params cambia mientras una corrida espera en la cola, lo simulado con él no queda bajo la clave de los parámetros viejos', async () => {
  const raiz = crearRaiz(base, 'params-cambiantes'), cache = join(base, 'cache-params'), ruta = join(base, 'params.json');
  writeFileSync(ruta, JSON.stringify({ mundo: { natalidad: 2 } }));
  const panel = correrPanelAsync(['--brazo', raiz, '--semillas', '7,9', '--replicas', '1', '--dias', '120', '--paralelo', '1', '--params', ruta, '--cache', cache, '--salida', join(base, 'carrera-params')]);
  const primera = join(base, 'carrera-params', '1-params-cambiantes-7-1.jsonl'), limite = Date.now() + 120_000;
  while (Date.now() < limite && !(existsSync(primera) && leerTexto(primera).includes('"tipo":"censo"'))) await new Promise(r => setTimeout(r, 50));
  writeFileSync(ruta, JSON.stringify({ mundo: { natalidad: 5 } }));
  await panel;
  writeFileSync(ruta, JSON.stringify({ mundo: { natalidad: 2 } }));
  const servida = correrPanel(['--brazo', raiz, '--semillas', '9', '--replicas', '1', '--dias', '120', '--paralelo', '1', '--params', ruta, '--cache', cache, '--salida', join(base, 'servida-params')]);
  const directa = correrPanel(['--brazo', raiz, '--semillas', '9', '--replicas', '1', '--dias', '120', '--paralelo', '1', '--params', ruta, '--cache', 'sin', '--salida', join(base, 'directa-params')]);
  assert.equal(servida.codigo, 0, servida.stderr);
  const filas = (n: string) => biologia(leerFilas(join(base, n, '1-params-cambiantes-9-1.jsonl')));
  assert.deepEqual(filas('servida-params'), filas('directa-params'), 'la caché devolvió una corrida con otros parámetros');
  assert.ok(readdirSync(cache).length >= 1);
});
