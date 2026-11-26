import assert from 'node:assert/strict';
import test from 'node:test';
import { poblar } from '../scripts/lab/poblacion.mjs';
import { escalon } from '../src/shared/interruptores.js';
import { createWorld } from '../src/world/index.js';
import { pesosInicialesPorPoblacion, repartirPorTramos } from '../src/world/motor/bloques.js';
import type { MotorConfig } from '../src/world/motor/contratos.js';
import { crearMotor } from '../src/world/motor/coordinador.js';
import { parseParams } from '../src/world/params.js';
import { MAX_COORDINATE } from '../src/world/terrain.js';

test('el peso inicial cuenta sólo personas dentro de páginas residentes', () => {
  const claves = ['-2,0', '-1,0', '0,0', '1,0', '0,-1', '0,1', '2,0'];
  const personas = [
    { x: -16.01, y: 0.9 }, { x: -16, y: 15.99 }, { x: -0.01, y: 0 },
    { x: 0, y: 0 }, { x: 15.99, y: 15.99 }, { x: 16, y: 0 },
    { x: 1, y: -0.01 }, { x: 0, y: 16 }, { x: -32.01, y: 0 },
    { x: -Infinity, y: 0 }, { x: MAX_COORDINATE, y: 0 }, { x: 0, y: NaN },
  ];
  const pesos = [2, 3, 3, 2, 2, 2, 1];
  assert.deepEqual([...pesosInicialesPorPoblacion(claves, personas)], pesos);
  assert.deepEqual([...pesosInicialesPorPoblacion([...claves].reverse(), [...personas].reverse())], [...pesos].reverse());
});

async function abrir(hilos: number, repartoInicial?: MotorConfig['repartoInicial'], inverso = false) {
  const params = parseParams({ motor: { hilos }, v23: escalon('duenos') });
  const mundo = createWorld(7, params);
  poblar(mundo, { n: 36, siembra: 7, zona: { x: 0, y: 0, ancho: 16, alto: 16 } });
  if (inverso) {
    mundo.chunks = Object.fromEntries(Object.entries(mundo.chunks).reverse());
    mundo.people.reverse();
  }
  const claves = Object.keys(mundo.chunks);
  const px = claves.map(k => mundo.chunks[k]!.cx), py = claves.map(k => mundo.chunks[k]!.cy);
  const pesos = repartoInicial ? pesosInicialesPorPoblacion(claves, mundo.people) : undefined;
  const duenos = repartirPorTramos(px, py, hilos, pesos);
  const esperadas = px.map((x, i) => [x, py[i]!, duenos[i]!]);
  const ordenar = (paginas: readonly (readonly number[])[]) =>
    [...paginas].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
  const motor = crearMotor(mundo, { hilos, repartoInicial, gpu: [], decisionGpu: 'siempre', verificar: false, semilla: 7 });
  try {
    motor.cargar({ world: mundo, materia: null }, 5);
    const reparto = motor.reparto();
    assert.ok(reparto);
    const paginas = ordenar(reparto.paginas);
    assert.deepEqual(paginas, ordenar(esperadas));
    return paginas;
  } finally { await motor.cerrar(); }
}

test('la opción cambia el reparto de arranque con carga desigual y respeta el orden Morton', async () => {
  const uniforme = await abrir(2), poblacion = await abrir(2, 'poblacion');
  assert.notDeepEqual(poblacion, uniforme);
  assert.deepEqual(await abrir(2, 'poblacion', true), poblacion);
});

test('la opción conserva el reparto de un único dueño', async () => {
  const uniforme = await abrir(1);
  assert.ok(uniforme.every(([, , dueno]) => dueno === 0));
  assert.deepEqual(await abrir(1, 'poblacion'), uniforme);
});
