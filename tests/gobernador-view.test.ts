import test from 'node:test';
import assert from 'node:assert/strict';
import { Gobernador } from '../src/server/governor.js';
import type { RuntimeStats } from '../src/shared/types.js';
import { estadoCrecimiento, ritmo, ultimoFrenazo, type Gobernador as GobernadorVista } from '../src/client/gobernador-view.js';

/** El mismo cableado que `governReproduction` (app.ts): lo que el servidor publica tras decidir. */
function publicar(g: Gobernador, politica: 'apagar' | 'techo', presupuestoMs: number, actual: boolean, poblacion: number, tick: number): { vista: GobernadorVista; activo: boolean } {
  const activo = g.decidir({ presupuestoMs, politica }, actual, poblacion, 1000, tick);
  const vista: NonNullable<RuntimeStats['gobernador']> = { activo, presupuestoMs, p95StepMs: g.p95StepMs, manual: null, politica, techo: g.estado.techo, techoObservado: g.techoObservado };
  return { vista, activo };
}
const medir = (g: Gobernador, ms: number, veces = 130): void => { for (let i = 0; i < veces; i++) g.registrar(ms); };

test('tabla de estados del crecimiento con la política techo, paso a paso como governor.ts', () => {
  const g = new Gobernador();
  medir(g, 20);
  let r = publicar(g, 'techo', 50, true, 23, 100);
  assert.equal(estadoCrecimiento(r.vista, 23)!.estado, 'libre', 'verde: sin techo');
  assert.equal(estadoCrecimiento(r.vista, 23)!.chip, null);

  medir(g, 53.6);
  r = publicar(g, 'techo', 50, r.activo, 23, 2400);
  assert.equal(r.vista.techo, 23, 'rojo: el techo se fija en la población de ese momento');
  assert.equal(r.activo, false, 'en el techo no puede nacer nadie');
  let e = estadoCrecimiento(r.vista, 23)!;
  assert.equal(e.estado, 'en-techo');
  assert.equal(e.chip, 'Crecimiento en pausa');
  assert.match(e.detalle, /el servidor va lento \(paso p95 53,6 ms > 50 ms de presupuesto\)/);
  assert.match(e.detalle, /se queda en 23 vidas/);
  assert.match(e.detalle, /Solo nacerá alguien si muere otra persona/);
  assert.match(e.detalle, /baje de 35 ms/);
  assert.doesNotMatch(e.detalle, /reponiendo/i, 'en el techo no se dice «reponiendo»');

  // Muere alguien: 21 < 23, se puede reponer (no crecer).
  r = publicar(g, 'techo', 50, r.activo, 21, 2500);
  assert.equal(r.activo, true);
  e = estadoCrecimiento(r.vista, 21)!;
  assert.equal(e.estado, 'reponiendo');
  assert.equal(e.chip, 'Reponiendo 21 de 23');
  assert.match(e.detalle, /solo nace alguien para reponer a quien murió/);

  // Banda muerta: el techo se conserva y la causa ya no dice «lento».
  medir(g, 40);
  r = publicar(g, 'techo', 50, r.activo, 23, 2600);
  assert.equal(r.vista.techo, 23);
  e = estadoCrecimiento(r.vista, 23)!;
  assert.equal(e.estado, 'en-techo');
  assert.match(e.detalle, /cerca del límite \(p95 40 ms; el freno se retira por debajo de 35 ms\)/);
  const frenazo = ultimoFrenazo(r.vista)!;
  assert.equal(frenazo.vigente, true);
  assert.match(frenazo.texto, /^Día 2 \(paso 2\.400\): paso p95 53,6 ms > 50 ms con 23 habitantes y 1\.000 casillas activas\.$/);

  // Verde de nuevo: se retira el techo; el frenazo queda como historia.
  medir(g, 20);
  r = publicar(g, 'techo', 50, r.activo, 23, 2700);
  assert.equal(r.vista.techo, null);
  assert.equal(estadoCrecimiento(r.vista, 23)!.estado, 'libre');
  assert.equal(ultimoFrenazo(r.vista)!.vigente, false);
});

test('política apagar, órdenes manuales y ausencia de datos', () => {
  const g = new Gobernador();
  medir(g, 80);
  const r = publicar(g, 'apagar', 50, true, 30, 10);
  assert.equal(r.activo, false);
  const e = estadoCrecimiento(r.vista, 30)!;
  assert.equal(e.estado, 'apagado');
  assert.equal(e.chip, 'Nacimientos en pausa');
  assert.match(e.detalle, /Vuelven cuando el paso p95 baje de 35 ms/);
  assert.equal(ultimoFrenazo(r.vista)!.vigente, true);
  assert.equal(estadoCrecimiento({ ...r.vista, manual: false }, 30)!.chip, 'Nacimientos detenidos a mano');
  assert.equal(estadoCrecimiento({ ...r.vista, manual: true }, 30)!.estado, 'manual');
  assert.equal(ultimoFrenazo({ ...r.vista, manual: true })!.vigente, false, 'con orden manual el freno automático no rige');
  assert.equal(estadoCrecimiento(undefined, 30), null, 'sin gobernador publicado no se afirma nada');
  assert.equal(ultimoFrenazo({ ...r.vista, techoObservado: null }), null);
});

test('ritmo real: pasos por segundo, duración de un día y lentitud solo frente al ritmo pedido', () => {
  const normal = ritmo(9.8, 10)!;
  assert.equal(normal.pasosPorSegundo, '9,8 pasos/s');
  assert.equal(normal.diaDura, '4 min');
  assert.equal(normal.lento, false);
  const lento = ritmo(6.1, 10)!;
  assert.equal(lento.lento, true);
  assert.equal(lento.pasosPorSegundo, '6,1 pasos/s');
  assert.equal(ritmo(6.1, undefined)!.lento, false, 'sin ritmo pedido no se afirma lentitud');
  assert.equal(ritmo(0, 10), null);
  assert.equal(ritmo(undefined, 10), null);
  assert.equal(ritmo(100, 100)!.diaDura, '24 s');
});
