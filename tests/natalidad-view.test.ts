import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, projectWorld, stepWorld } from '../src/world/index.js';
import { resumenVivo } from '../src/server/resumen-vivo.js';
import { enriquecerPersona } from '../src/server/persona-extra.js';
import { fertilidadFicha, nacimientosPorIntervalo, notaAcercamientos, seccionNacimientos } from '../src/client/natalidad-view.js';
import type { RuntimeStats, WorldView } from '../src/shared/types.js';

function vista(ticks = 120): { view: WorldView; world: ReturnType<typeof createWorld> } {
  const world = createWorld(51926);
  for (let i = 0; i < ticks; i++) stepWorld(world);
  const view = projectWorld(world);
  const gobernador: NonNullable<RuntimeStats['gobernador']> = { activo: world.reproductionEnabled, presupuestoMs: 50, p95StepMs: 20, manual: null, politica: 'techo', techo: null, techoObservado: null };
  view.performance = { stepMs: 1, p95StepMs: 20, saveMs: 0, projectionMs: 1, snapshotBytes: 1, activeTiles: 1, processRssMiB: 1, tickHz: 10, fases: {} as RuntimeStats['fases'], fraccionSerial: 0, gobernador, ...resumenVivo(world) };
  return { view, world };
}

test('M4: la escalera usa el censo, el resumen del servidor y la ley de este mundo en números', () => {
  const { view } = vista();
  const n = view.performance!.natalidad!;
  const html = seccionNacimientos(view);
  assert.match(html, new RegExp(`En edad de criar: ${view.stats!.census!.lifeStage.adult}<`));
  assert.match(html, new RegExp(`Fértiles ahora: ${n.fertiles}<`));
  assert.match(html, new RegExp(`Buscando a su pareja: ${n.cortejando} · preparando reservas: ${n.preparando} · reuniéndose para criar: ${n.reuniendose}`));
  assert.match(html, new RegExp(`a ${n.ley.radioPareja} casillas o menos uno del otro y a ${n.ley.radioLugar} o menos de un lugar`));
  assert.match(html, new RegExp(`hasta ${n.ley.radioCortejo} casillas`));
  assert.match(html, new RegExp(`medido en el paso ${n.tick}`));
  assert.doesNotMatch(html, /data-natality-step="gobernador"/, 'con el crecimiento libre no hay escalón del gobernador');
});

test('M4: con el techo lleno, el primer escalón dice que nadie corteja; sin resumen se dice', () => {
  const { view } = vista();
  const g = view.performance!.gobernador!;
  Object.assign(g, { activo: false, p95StepMs: 60, techo: view.stats!.population });
  const html = seccionNacimientos(view);
  assert.match(html, /data-natality-step="gobernador" class="is-blocked"><strong>Crecimiento en pausa/);
  assert.match(html, /nadie corteja ni prepara una crianza/);
  delete view.performance!.natalidad;
  assert.match(seccionNacimientos(view), /todavía no envió el resumen de fertilidad/);
  assert.match(seccionNacimientos(view), /La ley de natalidad de este mundo no llegó/);
});

test('M4: nacimientos por intervalo salen de las diferencias del acumulado del historial', () => {
  const history = [{ tick: 60, births: 2 }, { tick: 120, births: 2 }, { tick: 180, births: 5 }, { tick: 240, births: 6 }];
  assert.deepEqual(nacimientosPorIntervalo(history), [{ tick: 120, value: 0 }, { tick: 180, value: 3 }, { tick: 240, value: 1 }]);
});

test('M4: la ficha dice si puede criar ahora y, si no, por qué; nunca afirma sin dato', () => {
  const { view, world } = vista();
  const s = enriquecerPersona(world, 's')!;
  assert.match(fertilidadFicha(s, view), /S e I no crían/);
  assert.equal(fertilidadFicha(undefined, view), '', 'si no se pidió, no se dibuja');
  assert.match(fertilidadFicha(null, view), /Comprobando si puede criar/);
  const base = { reserva: 0.05, necesita: 0.1 };
  assert.match(fertilidadFicha({ fertil: { ahora: false, bloqueo: 'enfriamiento', faltanPasos: 960, ...base } }, view), /descansa tras su última cría \(faltan 0,4 días\)/);
  assert.match(fertilidadFicha({ fertil: { ahora: false, bloqueo: 'joven', faltanPasos: 2400, ...base } }, view), /aún joven \(madura en 1 día\)/);
  assert.match(fertilidadFicha({ fertil: { ahora: false, bloqueo: 'cuerpo', cuerpo: ['hambre', 'sed'], ...base } }, view), /su cuerpo no está listo \(hambre, sed\)/);
  assert.match(fertilidadFicha({ fertil: { ahora: false, bloqueo: 'reserva', ...base } }, view), /reserva de alimento \(0,05 de 0,1\)/);
  assert.match(fertilidadFicha({ fertil: { ahora: false, bloqueo: 'techo', ...base } }, view), /crecimiento está en pausa por el servidor/);
  assert.match(fertilidadFicha({ fertil: { ahora: true, bloqueo: null, ...base } }, view), /data-person-fertility="si"/);
  const other = view.people.find(p => p.role === 'neighbor')!;
  assert.match(fertilidadFicha({ fertil: { ahora: true, bloqueo: null, ...base }, busca: { id: other.id, name: other.name, motivo: 'cortejo' } }, view), new RegExp(`Busca a su pareja: <button class="entity-link" data-person-link="${other.id}">${other.name}</button>`));
});

test('M4: «Acercándose» se desglosa solo con el resumen medido y dice en qué paso', () => {
  const { view } = vista();
  view.stats!.actions.approach = 5;
  assert.match(notaAcercamientos(view), new RegExp(`en el paso ${view.performance!.natalidad!.tick}`));
  delete view.performance!.natalidad;
  assert.equal(notaAcercamientos(view), '');
});
