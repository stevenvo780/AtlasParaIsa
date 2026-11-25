import test from 'node:test';
import assert from 'node:assert/strict';
import { codigoForma } from '../src/shared/materia.js';
import { alturaLlama, claveLote, figuraDeLote, humoDeFuego, paintFuego, paintLote, PIXELES_POR_METRO } from '../src/client/structure-art.js';
import {
  escalaDeCuerpo, escalaDeFauna, extraccionVisible, fraccionGestacion, madurezDeFauna, nombreDeFauna, pelajeDeLinaje, planDeFauna,
  ESCALA_CUERPO_MAX, ESCALA_CUERPO_MIN, MARCA_EXTRACCION_TICKS, MASA_SPRITE_JUVENIL,
} from '../src/client/life-art.js';
import { animalSpriteKey, animalVisualTraits } from '../src/client/landscape.js';
import type { LoteVisible, CuerpoVisible } from '../src/shared/vistas-v23.js';
import type { AnimalView } from '../src/shared/life.js';

const lote = (extra: Partial<LoteVisible>): LoteVisible => ({ x: 2, y: 3, rol: 'objeto', forma: 0, principal: 1, masa: 1, T: 290, ...extra });
const cuerpo = (extra: Partial<CuerpoVisible>): CuerpoVisible => ({ masa: 60, masaAdulta: 60, reserva: 1, agua: 1, digestivo: 0, carga: 0, T: 310, principal: 1, ...extra });
const animal = (extra: Partial<AnimalView>): AnimalView => ({
  id: 'a1', species: 'deer', x: 0, y: 0, action: 'roam', reason: '', hunger: 0, thirst: 0, energy: 1, fatigue: 0, health: 1,
  generation: 0, parents: [], genes: { speed: .5, perception: .5, metabolism: .5, carnivory: .1, waterEfficiency: .5, camouflage: .5 }, age: 2000, ...extra,
});
const recorder = () => {
  const rects: { x: number; y: number; w: number; h: number; color: string }[] = [];
  const g = { fillStyle: '', fillRect(this: { fillStyle: unknown }, x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h, color: String(this.fillStyle) }); } } as unknown as CanvasRenderingContext2D;
  return { g, rects };
};

test('figura de un lote con forma: medidas en píxeles desde la forma empaquetada, filo y hueco visibles', () => {
  const hacha = figuraDeLote(lote({ forma: codigoForma({ largo: .5, ancho: .1, grueso: .05, hueco: 0, filo: .9 }) }));
  assert.equal(hacha.largo, Math.round(.5 * PIXELES_POR_METRO));
  assert.ok(hacha.filo && !hacha.hueco && !hacha.monton);
  const vasija = figuraDeLote(lote({ forma: codigoForma({ largo: .3, ancho: .3, grueso: .4, hueco: .7, filo: 0 }) }));
  assert.ok(vasija.hueco && vasija.alto >= 3);
  const enorme = figuraDeLote(lote({ forma: codigoForma({ largo: 40, ancho: 40, grueso: 40, hueco: 0, filo: 0 }) }));
  assert.ok(enorme.largo <= 28 && enorme.alto <= 28, 'cabe en su sprite');
});

test('montón sin forma: crece con la masa y encoge con la densidad; un grano sigue siendo un píxel', () => {
  const poco = figuraDeLote(lote({ masa: 2 }), 1.5), mucho = figuraDeLote(lote({ masa: 200 }), 1.5);
  assert.ok(poco.monton && mucho.monton);
  assert.ok(mucho.largo > poco.largo);
  assert.ok(figuraDeLote(lote({ masa: 200 }), 8).largo < mucho.largo, 'lo denso abulta menos');
  assert.equal(figuraDeLote(lote({ masa: 1e-6 })).largo, 1);
  assert.deepEqual(figuraDeLote(lote({ masa: 10 })), figuraDeLote(lote({ masa: 10 }), 1), 'sin ficha, la densidad del agua');
});

test('cadáver: yace (más largo que alto) y se consume con la masa', () => {
  const forma = codigoForma({ largo: 1.6, ancho: .4, grueso: .3, hueco: 0, filo: 0 });
  const c = figuraDeLote(lote({ rol: 'cadaver', forma }));
  assert.ok(c.largo > c.alto);
  assert.ok(figuraDeLote(lote({ rol: 'cadaver', masa: 5 })).largo < figuraDeLote(lote({ rol: 'cadaver', masa: 60 })).largo);
});

test('fuego: llama por el tamaño de la pila, humo que crece con la masa y sube con el tiempo', () => {
  assert.ok(alturaLlama(8) > alturaLlama(1));
  assert.ok(humoDeFuego(lote({ masa: 64 }), 0).length > humoDeFuego(lote({ masa: 1 }), 0).length);
  const a = humoDeFuego(lote({ masa: 8 }), 0), b = humoDeFuego(lote({ masa: 8 }), 0.5);
  assert.equal(a.length, b.length);
  assert.notDeepEqual(a, b);
  for (const h of a) { assert.ok(h.dy < 0, 'sube'); assert.ok(h.alfa >= 0 && h.alfa <= .45); }
});

test('claves de caché: mismo dibujo, misma clave; el calor y la pose del fuego la cambian', () => {
  const l = lote({ forma: codigoForma({ largo: .5, ancho: .2, grueso: .2, hueco: 0, filo: 0 }) }), f = figuraDeLote(l);
  assert.equal(claveLote(l, f, [10, 20, 30], 0), claveLote({ ...l, x: 99 }, f, [10, 20, 30], 3), 'la pose no cuenta fuera del fuego');
  assert.notEqual(claveLote(l, f, [10, 20, 30], 0), claveLote({ ...l, T: 1500 }, f, [10, 20, 30], 0));
  const fuego = lote({ rol: 'fuego', masa: 4, T: 1100 });
  assert.notEqual(claveLote(fuego, f, [10, 20, 30], 0), claveLote(fuego, f, [10, 20, 30], 1));
});

test('pintar lotes: lo caliente lleva resplandor; un horno al rojo enciende su boca', () => {
  const forma = codigoForma({ largo: 1, ancho: 1, grueso: 1, hueco: .8, filo: 0 });
  const frio = recorder(); paintLote(frio.g, lote({ rol: 'pieza', forma }), figuraDeLote(lote({ forma })), [120, 110, 100], 16, 30);
  const horno = recorder(); paintLote(horno.g, lote({ rol: 'pieza', forma, T: 1300 }), figuraDeLote(lote({ forma })), [120, 110, 100], 16, 30);
  assert.ok(frio.rects.length > 0);
  assert.ok(horno.rects.some(r => r.color.startsWith('rgba(255,')), 'resplandor de cuerpo negro');
  assert.ok(!frio.rects.some(r => r.color.startsWith('rgba(255,')));
  const llama = recorder(); paintFuego(llama.g, lote({ rol: 'fuego', masa: 3, T: 1200 }), [90, 60, 30], 16, 30, 0);
  assert.ok(llama.rects.length > 4);
});

test('cuerpo de persona: la talla sigue la masa sobre la adulta, cuantizada y acotada; sin cuerpo, 1', () => {
  assert.equal(escalaDeCuerpo(undefined), 1);
  assert.equal(escalaDeCuerpo(cuerpo({})), 1);
  assert.ok(escalaDeCuerpo(cuerpo({ masa: 40 })) < 1);
  assert.equal(escalaDeCuerpo(cuerpo({ masa: 60 * MASA_SPRITE_JUVENIL }), 'juvenile'), 1, 'el juvenil ya se pinta pequeño');
  assert.equal(escalaDeCuerpo(cuerpo({ masa: 1 })), ESCALA_CUERPO_MIN);
  assert.equal(escalaDeCuerpo(cuerpo({ masa: 1e4 })), ESCALA_CUERPO_MAX);
  assert.equal((escalaDeCuerpo(cuerpo({ masa: 50 })) * 16) % 1, 0);
});

test('gestación: fracción del embrión sobre su masa al nacer; sin embarazo, null', () => {
  assert.equal(fraccionGestacion(cuerpo({})), null);
  assert.equal(fraccionGestacion(cuerpo({ embrion: { masa: 1, m0: 4, otro: 9 } })), .25);
  assert.equal(fraccionGestacion(cuerpo({ embrion: { masa: 9, m0: 4, otro: 9 } })), 1);
});

test('fauna sin especie: el cuerpo dibujado sale de la masa, la carnivoría y el agua; sin v23, como hoy', () => {
  const v23 = { miedo: 0, linaje: 5 };
  assert.equal(planDeFauna(animal({ species: 'wolf' })), 'wolf');
  assert.equal(planDeFauna(animal({ v23, cuerpoVisto: cuerpo({ masa: 3, masaAdulta: 3 }) })), 'hare');
  assert.equal(planDeFauna(animal({ v23, cuerpoVisto: cuerpo({ masa: 70, masaAdulta: 70 }) })), 'deer');
  const carnivoro = { speed: .5, perception: .5, metabolism: .5, carnivory: .8, waterEfficiency: .5, camouflage: .5 };
  assert.equal(planDeFauna(animal({ v23, genes: carnivoro, cuerpoVisto: cuerpo({ masa: 5, masaAdulta: 5 }) })), 'fox');
  assert.equal(planDeFauna(animal({ v23, genes: carnivoro, cuerpoVisto: cuerpo({ masa: 40, masaAdulta: 40 }) })), 'wolf');
  assert.equal(planDeFauna(animal({ v23, genes: { ...carnivoro, carnivory: .4 }, cuerpoVisto: cuerpo({ masa: 90, masaAdulta: 90 }) })), 'boar');
  assert.equal(planDeFauna(animal({ v23 }), true), 'fish');
  const cria = animal({ v23, cuerpoVisto: cuerpo({ masa: 10, masaAdulta: 70 }) });
  assert.equal(planDeFauna(cria), 'deer', 'una cría tiene el cuerpo de su linaje');
  assert.equal(madurezDeFauna(cria), 0);
  assert.ok(escalaDeFauna(cria, 'deer') < 1);
  assert.equal(escalaDeFauna(animal({}), 'deer'), 1);
});

test('pelaje por linaje y clave de sprite: misma estirpe, mismo pelaje; el sprite no depende de la especie heredada', () => {
  assert.equal(pelajeDeLinaje(12), pelajeDeLinaje(12));
  assert.match(pelajeDeLinaje(-3), /^#[0-9a-f]{6}$/);
  const v = animal({ species: 'boar', v23: { miedo: 0, linaje: 12 }, cuerpoVisto: cuerpo({ masa: 70, masaAdulta: 70 }) });
  const traits = animalVisualTraits(v);
  assert.equal(traits.pelaje, pelajeDeLinaje(12));
  assert.equal(animalSpriteKey(v, 0, traits, 'deer'), animalSpriteKey({ ...v, species: 'wolf' }, 0, traits, 'deer'));
  assert.equal(animalVisualTraits(animal({})).pelaje, undefined, 'sin v23 no cambia nada');
});

test('nombre y marca de extracción: «Animal de N kg» con v23; la marca dura un día', () => {
  assert.equal(nombreDeFauna(animal({})), 'Venado');
  assert.equal(nombreDeFauna(animal({ v23: { miedo: 0, linaje: 1 }, cuerpoVisto: cuerpo({ masa: 34.4 }) })), 'Animal de 34 kg');
  const v = animal({ v23: { miedo: 0, linaje: 1, extraido: { que: 'fibra', tick: 100, por: 3 } } });
  assert.equal(extraccionVisible(v, 100), 'fibra');
  assert.equal(extraccionVisible(v, 100 + MARCA_EXTRACCION_TICKS), null);
  assert.equal(extraccionVisible(v, 50), null);
  assert.equal(extraccionVisible(animal({}), 100), null);
});
