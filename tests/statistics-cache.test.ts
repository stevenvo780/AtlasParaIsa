import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, cloneWorld, projectWorld, worldContext } from '../src/world/index.js';
import { ESTADISTICAS_CARAS_CADA_TICKS, worldStatistics } from '../src/world/statistics.js';

/** T041: `projectWorld` corre una vez POR CLIENTE. Las métricas de recursos recorren todas
 * las teselas (y `distanciaMediaAgua` hace una BFS completa): recalcularlas por cliente y
 * por paso costaba ~444 ms de paso con 12 clientes. */
test('worldStatistics devuelve el MISMO objeto dentro del mismo paso (una vez por paso, no por cliente)', () => {
  const world = createWorld(51926);
  const primera = worldStatistics(world), segunda = worldStatistics(world);
  assert.equal(primera, segunda, 'dos llamadas en el mismo paso comparten el resultado memoizado');
  // La vista de dos clientes distintos sobre el mismo mundo reutiliza esa misma memoria.
  const a = projectWorld(world, { x: 0, y: 0, width: 32, height: 32 });
  const b = projectWorld(world, { x: 8, y: 8, width: 16, height: 16 });
  assert.equal(a.stats, b.stats, 'dos clientes del mismo paso comparten las estadísticas');
  world.tick += 1;
  assert.notEqual(worldStatistics(world), primera, 'al avanzar el paso se recalcula');
});

test('las métricas caras se refrescan con cadencia y el clon de cada paso hereda la anterior', () => {
  const world = createWorld(51926);
  const inicial = worldStatistics(world);
  assert.equal(inicial.statsTick, 0, 'la vista declara en qué paso se calcularon las métricas caras');
  // Un paso intermedio (clonado, como hace el servidor) reutiliza el valor y su `statsTick`.
  const intermedio = cloneWorld(world, worldContext(world));
  intermedio.tick = ESTADISTICAS_CARAS_CADA_TICKS - 1;
  const vistaIntermedia = worldStatistics(intermedio);
  assert.equal(vistaIntermedia.statsTick, 0, 'antes de la cadencia se reutiliza el último cálculo');
  assert.equal(vistaIntermedia.distanciaMediaAgua, inicial.distanciaMediaAgua);
  assert.equal(vistaIntermedia.population, intermedio.people.length, 'lo barato sí es del paso actual');
  // Cumplida la cadencia, el clon siguiente recalcula y lo declara.
  const posterior = cloneWorld(intermedio, worldContext(intermedio));
  posterior.tick = ESTADISTICAS_CARAS_CADA_TICKS;
  assert.equal(worldStatistics(posterior).statsTick, ESTADISTICAS_CARAS_CADA_TICKS);
});

test('las métricas caras no cambian de valor por estar cacheadas: el recálculo coincide con el cálculo directo', () => {
  const world = createWorld(4821);
  const vista = worldStatistics(world);
  const gemelo = createWorld(4821); // mismo mundo, caché vacía
  const directa = worldStatistics(gemelo);
  for (const key of ['giniRecursosPorRegion', 'fraccionCeldasConComida', 'distanciaMediaAgua'] as const)
    assert.equal(vista[key], directa[key], `${key} tiene que ser idéntica con y sin caché`);
  assert.deepEqual(vista.diversidad, directa.diversidad);
});
