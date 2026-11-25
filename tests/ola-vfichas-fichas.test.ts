/** V23 · vfichas — funciones puras de las fichas (cuerpo, crianza, fauna, sustancia), natalidad y panel Motor. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaseSustancia, type SustanciaVista } from '../src/shared/materia.js';
import type { CuerpoVisible } from '../src/shared/vistas-v23.js';
import { barraAtomos, crianzaFicha, cuerpoFicha, escuchaDe, faseA, faunaFicha, formulaDe, gestacionFicha, lotesDeCelda, lotesFicha, materiaTeselaFicha, nombreDerivado, nombreEnlace, sustanciaFicha, temperaturaTexto } from '../src/client/inspector-view.js';
import { cuerposDeCriar, esMundoV23, leyPagadaTexto } from '../src/client/natalidad-view.js';
import { lecturaReparto } from '../src/client/panel-motor.js';
import type { WorldView } from '../src/shared/types.js';

// ELEMENTOS = H C N O P Si Ca Fe
const agua: SustanciaVista = { id: 7, clase: ClaseSustancia.Molecula, atomos: [2, 0, 0, 1, 0, 0, 0, 0], enlaces: [0, 2], masa: 18, prop: { r: 1, dMedia: 400, tFusion: 273, tEbullicion: 373, qOxidacion: 0, dureza: 0, tenacidad: 0, flexibilidad: .9, polaridad: .8, densidad: 1, color: 0x3f6f8a } };
const cuerpo: CuerpoVisible = { masa: 60, masaAdulta: 70, reserva: .5, agua: .9, digestivo: .4, carga: 6, T: 310, principal: 7 };
const mundo = (extra: Partial<WorldView>): WorldView => ({ people: [], ...extra }) as unknown as WorldView;

test('fórmula en orden de Hill y nombre del enlace', () => {
  assert.equal(formulaDe([2, 0, 0, 1, 0, 0, 0, 0]), 'H₂O');
  assert.equal(formulaDe([4, 1, 0, 0, 0, 0, 0, 0]), 'CH₄');
  assert.equal(formulaDe([0, 0, 0, 2, 0, 1, 0, 0]), 'O₂Si');
  assert.equal(formulaDe([0, 0, 0, 0, 0, 0, 0, 0]), '—');
  assert.match(nombreEnlace(0), /^[A-Za-z]+[–=≡][A-Za-z]+$/);
});

test('fase y nombre derivado de una sustancia', () => {
  assert.equal(faseA(agua.prop, 250), 'sólido'); assert.equal(faseA(agua.prop, 300), 'líquido'); assert.equal(faseA(agua.prop, 400), 'gas');
  assert.match(nombreDerivado(agua), /^molécula/);
});

test('barra de átomos reparte exactamente 16 píxeles', () => {
  const html = barraAtomos(agua.atomos);
  const flex = [...html.matchAll(/flex:(\d+) 1 0/g)].map(m => Number(m[1]));
  assert.equal(flex.reduce((a, b) => a + b, 0), 16);
  assert.equal(barraAtomos([0, 0, 0, 0, 0, 0, 0, 0]), '');
});

test('ficha de sustancia: con dato y sin dato', () => {
  assert.match(sustanciaFicha(agua, 7, 300), /H₂O/);
  assert.match(sustanciaFicha(agua, 7, 300), /líquido a 300 K/);
  assert.match(sustanciaFicha(undefined, 9), /sin dato/);
});

test('ficha de tesela y de lotes', () => {
  assert.equal(materiaTeselaFicha({}, undefined), '');
  assert.match(materiaTeselaFicha({ mat: [[7, 1]], T: 290 }, [agua]), /data-materia-tesela/);
  assert.match(materiaTeselaFicha({ mat: [[8, 1]] }, [agua]), /sustancia nº 8/);
  const lotes = [{ x: 1, y: 2, rol: 'fuego' as const, forma: 0, principal: 7, masa: 2, T: 900 }];
  assert.equal(lotesDeCelda(lotes, 0, 0).length, 0);
  assert.match(lotesFicha(lotes, [agua], 1, 2), /Fuego/);
  assert.equal(lotesFicha(lotes, [agua], 0, 0), '');
});

test('cuerpo: «sin dato» si falta y campos ausentes no son cero', () => {
  assert.match(cuerpoFicha(undefined), /data-cuerpo-ficha="sin-dato"/);
  const html = cuerpoFicha(cuerpo, [agua]);
  assert.match(html, /60 kg/); assert.match(html, /Tejido principal/);
  assert.match(cuerpoFicha({ ...cuerpo, T: NaN }), /sin dato/);
  assert.match(temperaturaTexto(310)!, /36,9 °C/); assert.equal(temperaturaTexto(undefined), null);
});

test('gestación, crianza y fauna', () => {
  assert.match(gestacionFicha({ masa: 1, m0: 3, otro: 12 }), /33 %/);
  assert.equal(crianzaFicha(undefined, mundo({})), '');
  assert.match(crianzaFicha({ cuidadores: [], madurez: .3 }, mundo({})), /Nadie la cuida/);
  assert.match(faunaFicha({}, mundo({})), /sin-dato/);
  const a = { v23: { miedo: .4, linaje: 3, extraido: { que: 'fibra' as const, tick: 4800, por: 9 } }, habituation: .5 };
  const html = faunaFicha(a, mundo({}));
  assert.match(html, /esquilado/); assert.match(html, /Miedo/);
  assert.match(faunaFicha({ v23: { miedo: .1, linaje: 1 } }, mundo({})), /ninguna registrada/);
});

test('escucha: lee PersonView.escucha antes que traits', () => {
  assert.equal(escuchaDe({ escucha: .4 }), .4);
  assert.equal(escuchaDe({ traits: { escucha: .7 } as never }), .7);
  assert.equal(escuchaDe({}), null);
});

test('natalidad pagada: sin cupo ni ventana solo en mundo V23', () => {
  assert.equal(esMundoV23(mundo({})), false);
  assert.equal(leyPagadaTexto(undefined, mundo({})), '');
  const v23 = mundo({ people: [{ cuerpoVisto: cuerpo, lifeStage: 'adult' } as never] });
  assert.match(leyPagadaTexto({ radioPareja: 1, radioLugar: 1, radioCortejo: 0, exigeComunidad: false, reserva: 1 }, v23), /no tiene cupo/);
  assert.doesNotMatch(leyPagadaTexto({ radioPareja: 1, radioLugar: 1, radioCortejo: 0, exigeComunidad: false, reserva: 1, cupo: 2, ventana: 120 }, v23), /no tiene cupo/);
  const c = cuerposDeCriar([{ cuerpoVisto: { ...cuerpo, reserva: .2, embrion: { masa: 1, m0: 3, otro: 1 } }, lifeStage: 'adult' }, { cuerpoVisto: cuerpo, crianza: { cuidadores: [], madurez: .1 } }, {}]);
  assert.deepEqual([c.conCuerpo, c.gestando, c.crias, c.adultos, c.adultosConPocaReserva], [2, 1, 1, 1, 1]);
});

test('panel Motor: lectura del reparto', () => {
  assert.equal(lecturaReparto({ desequilibrio: null, migraciones: null, intentos: null, rechazados: null }), null);
  assert.match(lecturaReparto({ desequilibrio: .05, migraciones: 3, intentos: 100, rechazados: 5 })!, /5 de 100/);
});
