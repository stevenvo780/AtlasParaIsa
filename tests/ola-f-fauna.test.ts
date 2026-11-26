import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ETA, VIDA_EXPONENTE, VIDA_L0 } from '../src/shared/naturaleza.js';
import {
  AREA_CELDA, DISTANCIA_CRUCE, GEN, GENES_FAUNA, decisionVacia, distanciaGenetica, elegirFaunaV23, habituar, huella, miedoDe,
  rendimientoPresa, velocidadDe, vidaMaxima, type AgenteVisto, type CeldaVista, type PercepcionFaunaV23, type YoFauna,
} from '../src/world/decision/fauna.js';
import { balanceConservacion, paramsDeEncender } from '../scripts/lab/encender.mjs';
import { extraerDeAnimal } from '../src/world/actuar/caza.js';
import { TICKS_PER_DAY, createWorld, stepWorld } from '../src/world/index.js';
import { FUNDADORES, genomaFundador, golpearAnimal, leyFauna, matarAnimal } from '../src/world/ley-fauna.js';
import { basalJ, concebir, costeGestacionJ, gestar, masaDe, plantillaDe, reservaJ } from '../src/world/materia/cuerpo.js';
import { sustanciasDe } from '../src/world/materia/ley-mundo.js';
import { Parte, Rol } from '../src/world/materia/tipos.js';
import { alarmaEn, alarmaPorAtaque, subirAlarma, TAU_ALARMA } from '../src/world/soa/alarma.js';
import { ctxMateriaDe, type CtxLey } from '../src/world/motor/acceso.js';
import { conductorDe } from '../src/world/motor/contexto.js';
import { DATO_GOLPEAR, DATO_MATERIA, REF_NULA, TipoIntento, slotDe, type Intento } from '../src/world/motor/contratos.js';

const azarFijo = (): (() => number) => { let s = 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; };

const agente = (o: Partial<AgenteVisto>): AgenteVisto => ({ ref: 1, uid: 2, persona: false, x: 0, y: 0, d: 1, masa: 1,
  carnivoria: 0, velocidad: 0.3, defensa: 0, pareja: false, ...o });
const celda = (o: Partial<CeldaVista>): CeldaVista => ({ celda: 0, x: 0, y: 0, d: 0, comida: 0, agua: 0, habitable: true,
  libre: AREA_CELDA, ...o });
const percepcion = (agentes: AgenteVisto[], celdas: CeldaVista[], o: Partial<PercepcionFaunaV23> = {}): PercepcionFaunaV23 =>
  ({ agentes, nAgentes: agentes.length, celdas, nCeldas: celdas.length, alarma: 0, jPorComida: 1e5, carronaJ: 0, ...o });
const yo = (k: number, o: Partial<YoFauna> = {}): YoFauna => ({ uid: 1, x: 0, y: 0, masa: FUNDADORES[k]!.masa,
  genoma: genomaFundador(k), hambre: 0.5, sed: 0.1, reservaRel: 0.5, reservaJ: 1e6, habituacion: 0, sobresalto: 0,
  fertil: false, jPorKgCarne: 5e6, ...o });
const vecinas = (): CeldaVista[] => [celda({}), celda({ x: 1, d: 1, celda: 1 }), celda({ x: -1, d: 1, celda: 2 }),
  celda({ y: 1, d: 1, celda: 3 }), celda({ y: -1, d: 1, celda: 4 })];

test('vida máxima por alometría y huella y velocidad crecen con la masa', () => {
  assert.equal(vidaMaxima(16), VIDA_L0 * 16 ** VIDA_EXPONENTE);
  assert.ok(vidaMaxima(80) > vidaMaxima(2.5));
  assert.ok(huella(80) > huella(2.5) && Math.abs(huella(8) - 4) < 1e-12);
  assert.ok(velocidadDe(80, 0.5) > velocidadDe(2.5, 0.5));
});

test('genoma de los fundadores: ancho, masa en ln y cruce imposible entre linajes', () => {
  for (let k = 0; k < FUNDADORES.length; k++) {
    const g = genomaFundador(k);
    assert.equal(g.length, GENES_FAUNA);
    assert.ok(Math.abs(Math.exp(g[GEN.lnMasa]!) - FUNDADORES[k]!.masa) < 1e-9);
    for (let j = k + 1; j < FUNDADORES.length; j++) assert.ok(distanciaGenetica(g, genomaFundador(j)) > DISTANCIA_CRUCE, `${k}-${j}`);
  }
});

test('miedo y habituación siguen leyes-opus §3e', () => {
  assert.equal(miedoDe(0.5, 0, 2, 0), 1);
  assert.equal(miedoDe(0.5, 1, 2, 0.3), 0.3);
  const h = habituar(0, 0.2, true, 0);
  assert.ok(h > 0 && h < 0.01);
  assert.ok(habituar(0.5, 0.2, true, 0.5) < 0.5);
  assert.ok(habituar(0.5, 0.2, false, 0) < 0.5);
  assert.ok(habituar(0.5, 0.9, true, 0) - 0.5 < habituar(0.5, 0.1, true, 0) - 0.5, 'la cautela frena la habituación');
});

test('un herbívoro pequeño huye de un carnívoro grande y no de un herbívoro grande', () => {
  const liebre = yo(0, { reservaRel: 0.3 });
  const lobo = agente({ x: 2, d: 2, masa: 40, carnivoria: 0.96 });
  const d = elegirFaunaV23(liebre, percepcion([lobo], vecinas()), azarFijo(), decisionVacia());
  assert.equal(d.accion, 'flee');
  assert.equal(d.tx, -1);
  const ciervo = agente({ x: 2, d: 2, masa: 80, carnivoria: 0.04 });
  const e = elegirFaunaV23(liebre, percepcion([ciervo], vecinas()), azarFijo(), decisionVacia());
  assert.notEqual(e.accion, 'flee');
});

test('el hambriento arriesga más: con más reserva relativa que miedo no huye', () => {
  const lobo = agente({ x: 3, d: 3, masa: 40, carnivoria: 0.96 });
  const calma = elegirFaunaV23(yo(1, { reservaRel: 0.95 }), percepcion([lobo], vecinas()), azarFijo(), decisionVacia());
  assert.notEqual(calma.accion, 'flee');
});

test('un carnívoro caza la presa de más rendimiento y un herbívoro pasta', () => {
  const lobo = yo(4, { hambre: 0.8 });
  const liebre = agente({ x: 1, d: 1, masa: 2.5, velocidad: 0.3 }), ciervo = agente({ uid: 3, ref: 3, x: 2, d: 2, masa: 80, velocidad: 0.5, defensa: 0.4 });
  assert.ok(rendimientoPresa(lobo, ciervo) > rendimientoPresa(lobo, liebre));
  const d = elegirFaunaV23(lobo, percepcion([liebre, ciervo], vecinas()), azarFijo(), decisionVacia());
  assert.equal(d.accion, 'hunt');
  assert.equal(d.presaUid, 3);
  const pasto = vecinas();
  pasto[1]!.comida = 0.5;
  const h = elegirFaunaV23(yo(1, { hambre: 0.8 }), percepcion([], pasto), azarFijo(), decisionVacia());
  assert.equal(h.accion, 'graze');
  assert.equal(h.tx, 1);
});

test('la sed mayor que el hambre lleva al agua y la huella llena cierra una celda', () => {
  const celdas = vecinas();
  celdas[3]!.agua = 1;
  const d = elegirFaunaV23(yo(1, { sed: 0.9, hambre: 0.2 }), percepcion([], celdas), azarFijo(), decisionVacia());
  assert.equal(d.accion, 'drink');
  assert.equal(d.ty, 1);
  celdas[3]!.libre = 0;
  const e = elegirFaunaV23(yo(1, { sed: 0.9, hambre: 0.2 }), percepcion([], celdas), azarFijo(), decisionVacia());
  assert.notEqual(e.ty, 1);
});

/** Contexto mínimo de un dueño con un chunk y sin campos de alarma en el terreno (alarma local). */
function ctxAlarma(tick: number): CtxLey {
  const mundo = {};
  const terreno = { campos: [] as string[], duenoChunk: Int16Array.of(0), chunkDe: (c: number) => c >> 8,
    celda: (x: number, y: number) => x >= 0 && x < 16 && y >= 0 && y < 16 ? (y << 4) | x : -1 };
  return { mundo, tick, hilo: 0, terreno } as unknown as CtxLey;
}

test('la alarma sube en la celda, cae con la distancia y decae sola', () => {
  const c0 = ctxAlarma(100);
  alarmaPorAtaque(c0, 5, 5, 1);
  const centro = c0.terreno.celda(5, 5), lejos = c0.terreno.celda(7, 5);
  assert.equal(alarmaEn(c0, centro), 1);
  assert.ok(Math.abs(alarmaEn(c0, lejos) - 1 / 5) < 1e-12);
  const c1 = { ...c0, tick: 100 + TAU_ALARMA } as CtxLey;
  assert.ok(Math.abs(alarmaEn(c1, centro) - Math.exp(-1)) < 1e-12);
  subirAlarma(c1, centro, 0.5);
  assert.ok(Math.abs(alarmaEn(c1, centro) - (Math.exp(-1) + 0.5)) < 1e-12);
});

test('F5 aplica un golpe local con intentos apagados y la muerte conserva la materia', () => {
  const mundo = createWorld(7, paramsDeEncender({ regimen: 'abierto', hasta: 'fauna' }));
  stepWorld(mundo);
  const c = ctxMateriaDe(mundo), [presa, otra] = mundo.animals;
  assert.ok(presa?.cuerpo && otra?.cuerpo && presa.uid && mundo.people[0]?.uid);
  const golpe = new Float64Array(5);
  golpe[DATO_GOLPEAR.trabajo] = 1e10;
  golpe[DATO_GOLPEAR.dureza] = 1;
  golpearAnimal(c, c.ref(mundo.people[0].uid), c.ref(presa.uid), golpe);
  leyFauna.F5!(c);
  assert.equal(mundo.animals.includes(presa), false);
  assert.equal(mundo.animalDynamics.humanHunts, 1);

  const masa = Math.round(masaDe(c, otra.cuerpo) * 10) / 10;
  matarAnimal(c, otra, 'senescencia');
  assert.ok(mundo.events.some(e => e.kind === 'animal' && e.actors.includes(otra.id) && e.text.includes(`${masa} kg`)));
  assert.equal(balanceConservacion(mundo)?.ok, true);
});

test('un golpe sobre una presa que cruzó de dueño deja su carne en tránsito', t => {
  const mundo = createWorld(7, paramsDeEncender({ regimen: 'abierto', hasta: 'intentos' }));
  stepWorld(mundo);
  const c = ctxMateriaDe(mundo), [presa] = mundo.animals, [cazador] = mundo.people;
  assert.ok(presa?.uid && cazador?.uid);
  const inicio = c.terreno.chunkDe(c.terreno.celda(presa.x, presa.y));
  const destino = mundo.tiles.find(tile => c.terreno.chunkDe(c.terreno.celda(tile.x, tile.y)) !== inicio);
  assert.ok(destino);
  const celda = c.terreno.celda(destino.x, destino.y), chunk = c.terreno.chunkDe(celda);
  assert.ok(celda >= 0);
  const cadaver = c.materia.nuevo(Rol.Cadaver, celda, 0);
  const envios: { dueno: number; intento: Intento }[] = [];
  t.mock.method(c.buzon, 'enviar', (dueno: number, intento: Intento) => { envios.push({ dueno, intento }); });
  const golpe = new Float64Array(5);
  golpe[DATO_GOLPEAR.trabajo] = 1e10;
  golpe[DATO_GOLPEAR.dureza] = 1;
  // F4 cambió la posición de la presa. Su fila sigue en el dueño de origen hasta F6.
  presa.x = destino.x; presa.y = destino.y;
  c.terreno.duenoChunk[chunk] = 1;
  try {
    assert.equal(leyFauna.aplicar!.Golpear!(c, { tipo: TipoIntento.Golpear, de: c.ref(cazador.uid), a: c.ref(presa.uid),
      celda: REF_NULA, lote: REF_NULA, nonce: c.id('nonce'), materia: null, dato: golpe, bytes: null }), 'hecho');
    assert.equal(c.materia.vista(cadaver).masa, 0);
    assert.equal(envios.length, 1);
    const { dueno, intento } = envios[0]!;
    assert.equal(dueno, 1);
    assert.equal(intento.tipo, TipoIntento.Depositar);
    assert.equal(intento.celda, celda);
    assert.equal(intento.dato?.[DATO_MATERIA.rol], Rol.Cadaver);
    assert.ok(intento.materia?.length);
  } finally { c.terreno.duenoChunk[chunk] = c.hilo; }
  assert.equal(balanceConservacion(mundo)?.ok, true);
});

test('la garantía de esquilar llega al Suelo si el lote caduca y se archiva la página', () => {
  const mundo = createWorld(7, paramsDeEncender({ regimen: 'abierto', hasta: 'intentos' }));
  stepWorld(mundo);
  const d = conductorDe(mundo)!, c = ctxMateriaDe(mundo), [animal] = mundo.animals, [persona] = mundo.people;
  assert.ok(animal?.uid && animal.fauna && persona?.uid);
  animal.fauna.miedo = animal.fauna.sobresalto = 0;
  const celda = c.terreno.celda(persona.x, persona.y);
  assert.ok(celda >= 0);
  const saldo = c.libro.enVuelo.slice();

  d.fase(4);
  const destino = extraerDeAnimal(c, persona, c.ref(animal.uid), 'fibra');
  assert.notEqual(destino, REF_NULA);
  d.fase(5);
  d.aplicar('A');
  const entrega = d.pendientes().find(i => i.tipo === TipoIntento.Concedido && i.lote === destino);
  assert.ok(entrega?.materia?.length);
  assert.equal(entrega.celda, celda);

  const lotes = new Float64Array(1);
  assert.equal(c.materia.lotes(celda, Rol.Suelo, lotes), 1);
  const suelo = lotes[0]!, kg = c.materia.vista(suelo).masa;
  c.materia.liberar(destino);
  d.terrenoPercibido.vaciarPagina(c.terreno.chunkDe(celda));
  assert.equal(c.terreno.celda(persona.x, persona.y), -1);
  d.fase(1);
  d.aplicar('B');
  assert.ok(c.materia.vista(suelo).masa > kg);
  assert.deepEqual(c.libro.enVuelo, saldo);
  assert.equal(balanceConservacion(mundo)?.ok, true);
});

test('un embrión completo nace con su masa y cabe en la huella', () => {
  const mundo = createWorld(7, paramsDeEncender({ regimen: 'abierto', hasta: 'fauna' }));
  stepWorld(mundo);
  const c = ctxMateriaDe(mundo), [madre, otro] = mundo.animals;
  assert.ok(madre?.cuerpo && madre.fauna && otro?.uid);
  const cuerpo = madre.cuerpo, plantilla = plantillaDe(c, cuerpo);
  concebir(c, cuerpo, { genoma: madre.fauna.genoma, otro: otro.uid, inicio: c.tick });
  const embrion = cuerpo.gestacion!.embrion;
  const unidadKg = plantilla.partes.reduce((suma, t) => suma + c.quimica.sustancia(t.id).masa * t.nu, 0) / 1e6;
  const unidades = Math.ceil(plantilla.m0 / unidadKg);
  for (const { id, nu } of plantilla.partes) {
    const cuantos = unidades * nu;
    assert.equal(c.materia.moverParte(cuerpo.tejido, embrion, { parte: Parte.Exacta, esp: id, cuantos, kappa: null }), cuantos);
  }
  stepWorld(mundo);

  const cria = mundo.animals.find(a => a.parents[0] === madre.id);
  assert.ok(cria?.cuerpo);
  assert.ok(masaDe(c, cria.cuerpo) > unidades * unidadKg);
  assert.ok(c.materia.vista(cria.cuerpo.reserva).masa > 0);
  assert.equal(mundo.animalDynamics.births, 1);
  assert.deepEqual(leyFauna.comprobar!(c), []);
  assert.equal(balanceConservacion(mundo)?.ok, true);
});

test('la fertilidad reserva la síntesis y el basal sin cobrar la oxidación de todo el tejido', () => {
  const mundo = createWorld(7, paramsDeEncender({ regimen: 'abierto', hasta: 'intentos' }));
  stepWorld(mundo);
  const c = ctxMateriaDe(mundo), [animal] = mundo.animals;
  assert.ok(animal?.cuerpo && animal.uid);
  const cuerpo = animal.cuerpo, tejido = c.materia.vista(cuerpo.tejido);
  const provision = costeGestacionJ(c, cuerpo) + basalJ(c, cuerpo, TICKS_PER_DAY);
  const oxidacion = plantillaDe(c, cuerpo).m0 * tejido.energia / (ETA * tejido.masa);
  assert.ok(reservaJ(c, cuerpo) < provision && provision < oxidacion);
  assert.equal(c.frente.pareja[slotDe(c.ref(animal.uid))], -1);

  const grasa = sustanciasDe(c).CH2, jPorCuanto = c.quimica.sustancia(grasa).prop.qOxidacion;
  const cuantos = Math.ceil(((provision + oxidacion) / 2 - reservaJ(c, cuerpo)) / jPorCuanto);
  c.materia.fuente(cuerpo.reserva, Float64Array.of(grasa, cuantos), c.libro);
  assert.ok(reservaJ(c, cuerpo) >= provision && reservaJ(c, cuerpo) < oxidacion);
  stepWorld(mundo);
  const frente = ctxMateriaDe(mundo);
  assert.equal(frente.frente.pareja[slotDe(frente.ref(animal.uid))], 0);
  assert.equal(balanceConservacion(mundo)?.ok, true);
});

test('el embrión sigue creciendo aunque consuma el último precursor disponible', () => {
  const mundo = createWorld(7, paramsDeEncender({ regimen: 'abierto', hasta: 'fauna' }));
  stepWorld(mundo);
  const c = ctxMateriaDe(mundo), [madre, otro] = mundo.animals;
  assert.ok(madre?.cuerpo && madre.fauna && otro?.uid);
  const cuerpo = madre.cuerpo;
  concebir(c, cuerpo, { genoma: madre.fauna.genoma, otro: otro.uid, inicio: c.tick });
  for (const { id, nu } of plantillaDe(c, cuerpo).partes) {
    assert.equal(c.materia.moverParte(cuerpo.tejido, cuerpo.digestivo, { parte: Parte.Exacta, esp: id, cuantos: nu, kappa: null }), nu);
  }
  const masa = gestar(c, cuerpo, 1);
  assert.ok(masa > 0);
  assert.equal(cuerpo.gestacion!.bajoBasalDesde, -1);
  assert.equal(gestar(c, cuerpo, 1), masa);
  assert.equal(cuerpo.gestacion!.bajoBasalDesde, c.tick);
  assert.equal(balanceConservacion(mundo)?.ok, true);
});

test('I10: la ley de la fauna no lee especie ni linaje fundador', () => {
  for (const f of ['src/world/ley-fauna.ts', 'src/world/soa/alarma.ts']) {
    const fuente = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(fuente, /\.species\b|linajeFundador/, f);
  }
  const decision = readFileSync(new URL('../src/world/decision/fauna.ts', import.meta.url), 'utf8');
  const v23 = decision.slice(decision.indexOf('// ── V23')).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(v23, /\.species\b|linajeFundador|SPECIES/);
});
