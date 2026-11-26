import assert from 'node:assert/strict';
import test from 'node:test';
import { AgendaTerritorial, type EventoTerritorial } from '../src/world/territorio/agenda.js';

test('deduplica el mismo vencimiento y sólo invalida su generación vigente', () => {
  const agenda = new AgendaTerritorial(2);
  const anterior = agenda.programar('-1,0', 'reactivar', 5);
  assert.equal(agenda.programar('-1,0', 'reactivar', 5), anterior);
  const siguiente = agenda.programar('-1,0', 'reactivar', 7);
  assert.ok(siguiente.generacion > anterior.generacion);
  assert.equal(agenda.invalidar(anterior), false);
  assert.deepEqual(agenda.extraerHasta(5), []);
  assert.deepEqual(agenda.extraerHasta(7), [siguiente]);
  assert.deepEqual(agenda.extraerHasta(7), []);
  const cancelado = agenda.programar('-1,0', 'reactivar', 8);
  assert.equal(agenda.invalidar(cancelado), true);
  assert.equal(agenda.invalidar(cancelado), false);
  assert.deepEqual(agenda.extraerHasta(8), []);
  assert.throws(() => agenda.extraerHasta(7), RangeError);
  assert.throws(() => agenda.programar('-1,0', 'reactivar', 8), RangeError);
});

test('ordena por tick, región y evento sin depender del orden de alta', () => {
  const agenda = new AgendaTerritorial();
  const b = agenda.programar('1,0', 'aplicar', 5);
  const a2 = agenda.programar('0,0', 'reactivar', 5);
  const a1 = agenda.programar('0,0', 'aplicar', 5);
  const primero = agenda.programar('1,0', 'reactivar', 2);
  const c = agenda.programar('1,0', 'reactivar', 6);
  assert.equal(agenda.invalidar(primero), false);
  assert.deepEqual(agenda.extraerHasta(8), [a1, a2, b, c]);
});

test('repite una reactivación desde el último corte y evita volver a aplicarla tras confirmarla', () => {
  const region = '-8,4', epoca = 3;
  const caliente = new AgendaTerritorial(2);
  const primero = caliente.programar(region, 'reactivar', 6);
  const retiro = caliente.programar(region, 'reactivar', 9);
  caliente.extraerHasta(4);
  const frio = JSON.stringify({ tick: 4, activo: false, agenda: caliente.corte(epoca) });

  function reactivar(copia: string) {
    const corte = JSON.parse(copia);
    const agenda = AgendaTerritorial.restaurar(corte.agenda, epoca, corte.tick);
    assert.equal(agenda.invalidar(primero), false);
    const efectos = agenda.extraerHasta(9);
    assert.deepEqual(efectos, [retiro]);
    return JSON.stringify({ tick: 9, activo: efectos.length === 1, agenda: agenda.corte(epoca) });
  }

  const confirmado = reactivar(frio);
  assert.equal(reactivar(frio), confirmado, 'reintentar antes de confirmar aplica exactamente la misma secuencia');
  const durable = JSON.parse(confirmado);
  const restaurado = AgendaTerritorial.restaurar(durable.agenda, epoca, durable.tick);
  assert.equal(durable.activo, true);
  assert.deepEqual(restaurado.extraerHasta(9), []);
  const nuevo = restaurado.programar(region, 'reactivar', 14);
  assert.ok(nuevo.generacion > retiro.generacion);
  assert.equal(restaurado.invalidar(retiro), false);
  assert.deepEqual(restaurado.extraerHasta(14), [nuevo]);
});

test('rechaza cortes corruptos, duplicados o de otro mundo lógico', () => {
  const agenda = new AgendaTerritorial(5);
  agenda.programar('0,0', 'suelo', 10);
  const corte = agenda.corte(3), evento = corte.pendientes[0]!;
  assert.throws(() => AgendaTerritorial.restaurar(corte, 4, 5), TypeError);
  assert.throws(() => AgendaTerritorial.restaurar(corte, 3, 6), TypeError);
  for (const pendientes of [
    [{ ...evento, tick: 5 }], [{ ...evento, tick: 10.5 }], [{ ...evento, evento: '' }],
    [{ ...evento, generacion: 0 }], [{ ...evento, generacion: corte.ultimaGeneracion + 1 }],
    [evento, { ...evento, region: '0,1' }], [evento, { ...evento, tick: 11 }],
  ]) assert.throws(() => AgendaTerritorial.restaurar({ ...corte, pendientes }, 3, 5), TypeError);
  assert.deepEqual(AgendaTerritorial.restaurar(corte, 3, 5).corte(3), corte);
});

test('las bajas y reemplazos mantienen el orden de un modelo por lista', () => {
  let agenda = new AgendaTerritorial(), tick = 0;
  const pendientes = new Map<string, EventoTerritorial>();
  let semilla = 51926;
  const azar = () => semilla = (Math.imul(semilla, 1664525) + 1013904223) >>> 0;
  for (let paso = 0; paso < 200; paso++) {
    const region = `${azar() % 5},0`, evento = `evento-${azar() % 9}`, clave = `${region}/${evento}`;
    switch (azar() % 5) {
      case 0: {
        const anterior = pendientes.get(clave);
        if (anterior) assert.equal(agenda.invalidar(anterior), pendientes.delete(clave));
        break;
      }
      case 1: {
        tick += azar() % 4;
        const esperados = [...pendientes.values()].filter(e => e.tick <= tick).sort((a, b) => a.tick - b.tick
          || a.region.localeCompare(b.region) || a.evento.localeCompare(b.evento));
        assert.deepEqual(agenda.extraerHasta(tick), esperados);
        for (const vencido of esperados) pendientes.delete(`${vencido.region}/${vencido.evento}`);
        break;
      }
      case 2: agenda = AgendaTerritorial.restaurar(JSON.parse(JSON.stringify(agenda.corte(0))), 0, tick); break;
      default: pendientes.set(clave, agenda.programar(region, evento, tick + 1 + azar() % 20));
    }
    assert.equal(agenda.corte(0).pendientes.length, pendientes.size);
  }
  assert.equal(agenda.extraerHasta(tick + 20).length, pendientes.size);
});
