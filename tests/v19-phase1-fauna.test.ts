// V19 fase 1 — fauna: F (`fauna.contactoContinuo`), R (`fauna.reservaReproductiva`), M (`fauna.encuentroFertil`).
//
// · Apagados (histórico): la fauna es V18 bit a bit. Las huellas de referencia se generaron ejecutando el MISMO
//   fixture (`v19-phase1-fauna-fixture.ts`) sobre el commit V18 (HEAD de la rama antes de V19): si cambia un solo
//   bit de la aritmética o del consumo de azar de la fauna con los interruptores apagados, fallan.
// · Cada ley, aislada, con un escenario mínimo y verificable.
// · Hábitat productivo de depredadores (zorro y lobo) con las tres leyes: caza real, acumulación de reserva,
//   aproximación a pareja y nacimientos G1+; la deuda de reserva es exactamente 0,06 por cría.
// · Paridad 0 ULP entre `motor.hilos = 1` (serie) y `motor.hilos = 4` (workers, ≥ 384 decisiones por paso).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { RAZON_PAREJA, RESERVA_MAXIMA, RESERVA_POR_PROGENITOR, assertAnimal, type Animal } from '../src/world/animals.js';
import { closeFaunaParallelPools, despachosFaunaParalelos } from '../src/world/paralelo/fauna-motor.js';
import { RAZON_PAREJA_FAUNA } from '../src/world/paralelo/fauna-worker.js';
import { fundador, huella, mundo, parches, paso, tile } from './v19-phase1-fauna-fixture.js';

after(async () => { await closeFaunaParallelPools(); });

const TODAS = 'fauna.contactoContinuo=true,fauna.reservaReproductiva=true,fauna.encuentroFertil=true';
/** Huellas del fixture `parches()` con params por defecto, calculadas sobre V18 (commit anterior a V19). */
const V18 = { 60: '39cad6dac11517f8020da5863608640d68c34222bd6507eb347e6f69e3a58e5f',
  300: 'dbc1be7b2bbf0886736750788ae609c4ca77400cdc8f02fa15c6f7d703a305ce' } as const;

/** Un paso sin decisiones: el animal conserva su acción y destino salvo lo que el paso físico escribe. */
function quieto(a: Animal, x = a.x, y = a.y): Animal {
  a.lastDecision = 0; a.lastMove = 0; a.target = { x, y }; return a;
}
const cuadricula = (lado: number, o: Parameters<typeof tile>[2] = {}) =>
  Array.from({ length: lado * lado }, (_, i) => tile(i % lado, Math.floor(i / lado), o));

test('V19 fauna: con F, R y M apagados la fauna es V18 bit a bit (huellas del commit anterior), también con workers', () => {
  const serie = parches(), w = mundo(serie.tiles, serie.animals);
  for (let n = 1; n <= 300; n++) { paso(w); if (n === 60 || n === 300) assert.equal(huella(w), V18[n], `serie, paso ${n}`); }
  // Las constantes asociadas a un interruptor apagado son inertes: no mueven un solo bit.
  const inerte = parches(), wi = mundo(inerte.tiles, inerte.animals, 'fauna.fraccionReservaCria=0.9');
  for (let n = 1; n <= 60; n++) paso(wi);
  assert.equal(huella(wi), V18[60], 'fraccionReservaCria sin R es inerte');
  // Con workers (hilos 4, ≥ 384 decisiones en el primer paso) el despacho apagado tampoco cambia nada.
  const antes = despachosFaunaParalelos(), par = parches(), wp = mundo(par.tiles, par.animals, 'motor.hilos=4,motor.orden=adversarial');
  for (let n = 1; n <= 60; n++) paso(wp);
  assert.ok(despachosFaunaParalelos() > antes, 'la decisión se despachó realmente a la piscina');
  assert.equal(huella(wp), V18[60], 'workers apagados = V18');
});

test('V19/F: la preparación del ataque decae poco a poco al separarse y el alcance (≤ 1) resuelve el contacto con esfuerzo pagado', () => {
  const montar = (gap: [number, number], params: string) => {
    const fox = quieto(fundador('fox', 0, 0, 'fox')), hare = quieto(fundador('hare', gap[0], gap[1], 'hare'));
    fox.action = 'hunt'; fox.preyId = hare.id; fox.hunger = 0.5; hare.health = 1; fox.work = 3;
    return { fox, hare, w: mundo(cuadricula(3), [fox, hare], params, false) };
  };
  // Separación breve (2 celdas): con F resta un paso (3 → 2); histórico lo borra (3 → 0).
  const sep = montar([2, 0], 'fauna.contactoContinuo=true'); paso(sep.w);
  assert.equal(sep.fox.work, 2); assert.equal(sep.hare.health, 1, 'sin alcance no hay daño');
  const historico = montar([2, 0], ''); paso(historico.w); assert.equal(historico.fox.work, 0);
  // Diagonal (Manhattan 2) tampoco es alcance.
  const diagonal = montar([1, 1], 'fauna.contactoContinuo=true'); paso(diagonal.w); assert.equal(diagonal.fox.work, 2);
  // Adyacente: con F acumula cuatro pasos pagados y hiere; histórico (exige misma celda) nunca.
  const f = montar([1, 0], 'fauna.contactoContinuo=true'), h = montar([1, 0], ''), control = montar([2, 0], 'fauna.contactoContinuo=true');
  f.fox.work = 0; h.fox.work = 0; control.fox.work = 0;
  for (let n = 0; n < 4; n++) { paso(f.w); paso(h.w); paso(control.w); }
  assert.ok(f.hare.health < 1, 'el contacto adyacente prolongado hiere'); assert.equal(f.fox.work, 0, 'el golpe reinicia la preparación');
  assert.equal(h.hare.health, 1); assert.equal(control.hare.health, 1);
  assert.ok(control.fox.energy - f.fox.energy > 0.0025, 'preparar el golpe cuesta energía real (4 × 0,0008)');
  // El daño es finito: una presa sana no muere de un golpe.
  assert.ok(f.hare.health > 0.5);
});

test('V19/R: parte de lo realmente consumido se aparta como reserva (sin bajar el hambre) y la cría cuesta 0,03 de cada progenitor', () => {
  // Acumulación al pastar: reserva = fracción × biomasa consumida; el hambre baja sólo con el resto.
  const pastar = (params: string) => {
    const hare = fundador('hare', 1, 1, 'hare'); hare.hunger = 0.6;
    const w = mundo(cuadricula(3), [hare], params, false);
    for (let n = 0; n < 30; n++) paso(w);
    return { hare, w };
  };
  const on = pastar('fauna.reservaReproductiva=true'), off = pastar('');
  assert.ok(on.w.animalDynamics.plantConsumed > 0 && on.w.animalDynamics.plantConsumed === off.w.animalDynamics.plantConsumed,
    'la planta consumida es la misma: lo apartado sale de lo consumido, no se crea');
  // Calibración fase 2: herbívoros apartan min(1, 4 × fraccionReservaCria) = 0,60 de cada bocado pequeño de pasto.
  assert.ok(Math.abs(on.hare.reproReserve! - Math.min(1, 0.15 * 4) * on.w.animalDynamics.plantConsumed) < 1e-12);
  assert.ok(on.hare.hunger > off.hare.hunger, 'lo apartado no sacia');
  assert.equal(off.hare.reproReserve, undefined);
  // Predación: un zorro que mata una liebre aparta 0,15 × 0,12.
  const zorro = quieto(fundador('fox', 1, 1, 'fox')), liebre = quieto(fundador('hare', 1, 1, 'hare'));
  zorro.action = 'hunt'; zorro.preyId = liebre.id; zorro.work = 3; liebre.health = 0.05;
  const w = mundo(cuadricula(3), [zorro, liebre], 'fauna.reservaReproductiva=true', false); paso(w);
  assert.equal(w.animalDynamics.predations, 1);
  assert.ok(Math.abs(zorro.reproReserve! - 0.12 * 0.15) < 1e-15);
  // Nacimiento: la biomasa de la cría sale de las reservas (0,03 + 0,03), no de la celda; con ≥ 0,03 en ambas
  // hay cría aunque la celda no tenga los 0,08 de crecimiento que exige la ley histórica.
  for (const species of ['hare', 'fox', 'wolf'] as const) {
    const nacer = (reservaA: number, reservaB: number, params: string) => {
      const a = quieto(fundador(species, 1, 1, `a-${species}`)), b = quieto(fundador(species, 1, 1, `b-${species}`));
      a.reproReserve = reservaA; b.reproReserve = reservaB;
      const tiles = cuadricula(3, { growth: 0.05 }), w = mundo(tiles, [a, b], params);
      paso(w);
      return { a, b, w, tiles };
    };
    const ok = nacer(0.05, 0.04, 'fauna.reservaReproductiva=true');
    assert.equal(ok.w.animalDynamics.births, 1, `${species}: nace una cría`);
    assert.equal(ok.w.animals.length, 3); assert.ok(ok.w.animals.some(x => x.generation === 1 && x.reproReserve === undefined));
    assert.ok(Math.abs((0.05 + 0.04) - (ok.a.reproReserve! + ok.b.reproReserve!) - 0.06) < 1e-15, 'se conserva la biomasa: 0,06 en total');
    assert.ok(Math.abs(ok.a.reproReserve! - 0.02) < 1e-15 && Math.abs(ok.b.reproReserve! - 0.01) < 1e-15);
    assert.ok(ok.tiles.every(t => t.growth === 0.05) && ok.w.animalDynamics.plantConsumed === 0, 'la celda natal no paga biomasa');
    assert.ok(ok.w.animalDynamics.waterConsumed > 0, 'el agua natal se sigue pagando');
    assert.equal(nacer(0.05, 0.029, 'fauna.reservaReproductiva=true').w.animalDynamics.births, 0, 'sin 0,03 en uno de los dos no hay cría');
    assert.equal(nacer(0.05, 0.05, '').w.animalDynamics.births, 0, 'histórico: la celda con 0,05 < 0,08 de crecimiento lo impide');
  }
});

test('V19/R: reproReserve es un campo opcional validado (finito, 0 ≤ r ≤ 0,12)', () => {
  const a = fundador('fox', 0, 0, 'fox');
  assertAnimal(a, 0);
  for (const bueno of [0, 0.03, RESERVA_MAXIMA]) { a.reproReserve = bueno; assertAnimal(a, 0); }
  for (const malo of [-0.001, RESERVA_MAXIMA + 0.001, Number.NaN, Infinity, '0.05' as unknown as number]) {
    a.reproReserve = malo; assert.throws(() => assertAnimal(a, 0), /Animal individual inválido/);
  }
  assert.equal(RESERVA_POR_PROGENITOR * 2, 0.06);
});

test('V19/M: un animal listo se acerca con pasos pagados a una pareja conespecífica lista; nadie la teletransporta', () => {
  const montar = (params: string, reserva: number) => {
    const a = fundador('hare', 1, 0, 'a-hare'), b = fundador('hare', 5, 0, 'b-hare');
    a.reproReserve = reserva; b.reproReserve = reserva;
    const tiles = Array.from({ length: 7 }, (_, x) => tile(x, 0));
    return { a, b, w: mundo(tiles, [a, b], params) };
  };
  const enfoque = (m: ReturnType<typeof montar>) => {
    const razones = new Set<string>(); let minimo = 4, nacio = -1;
    for (let n = 1; n <= 80; n++) {
      paso(m.w);
      for (const x of [m.a, m.b]) razones.add(x.reason);
      minimo = Math.min(minimo, Math.abs(m.a.x - m.b.x));
      if (nacio < 0 && m.w.animalDynamics.births > 0) nacio = n;
    }
    return { razones, minimo, nacio };
  };
  const con = montar(TODAS, 0.05), r = enfoque(con);
  assert.ok(r.razones.has(RAZON_PAREJA), 'decidieron acercarse a la pareja');
  assert.equal(r.minimo <= 1, true); assert.ok(r.nacio > 0, 'el encuentro termina en cría');
  assert.ok(con.a.energy < 0.8 && con.b.energy < 0.8, 'caminar y criar cuestan energía');
  // Sin reserva (R exige ≥ 0,03 en cada uno) o sin M, nadie busca pareja.
  assert.ok(!enfoque(montar(TODAS, 0)).razones.has(RAZON_PAREJA), 'sin reserva no están listos');
  assert.ok(!enfoque(montar('fauna.reservaReproductiva=true,fauna.contactoContinuo=true', 0.05)).razones.has(RAZON_PAREJA), 'sin M no hay búsqueda');
  assert.equal(RAZON_PAREJA, RAZON_PAREJA_FAUNA, 'serie y workers escriben la misma razón');
});

test('V19 F+R+M: en un hábitat productivo zorros y lobos cazan, acumulan reserva, se buscan y crían G1+; deuda exacta 0,06 por cría', () => {
  const { tiles, animals } = parches(), w = mundo(tiles, animals, TODAS);
  const especie = new Map(animals.map(a => [a.id, a.species])), padres = new Map<string, string[]>();
  const cazas: Record<string, number> = {}, crias: Record<string, number> = {};
  const previa = new Map<string, number>(), buscando = new Map<string, number>(), nacio = new Set<string>();
  let aprox = 0, pagado = 0, maximo = 0, listos = 0;
  for (let n = 1; n <= 3000; n++) {
    nacio.clear();
    paso(w, e => {
      if (e.text.includes('muere por depredación')) { const s = especie.get(e.actors[0]!)!; cazas[s] = (cazas[s] ?? 0) + 1; }
      if (e.text.startsWith('Nace')) { padres.set(e.actors[2]!, [e.actors[0]!, e.actors[1]!]); nacio.add(e.actors[0]!); nacio.add(e.actors[1]!); }
    });
    const ahora = new Map<string, number>();
    for (const a of w.animals) {
      if (!especie.has(a.id)) { especie.set(a.id, a.species); crias[a.species] = (crias[a.species] ?? 0) + 1; }
      const r = a.reproReserve ?? 0; ahora.set(a.id, r); maximo = Math.max(maximo, r);
      assert.ok(r >= 0 && r <= RESERVA_MAXIMA, 'la reserva nunca se sale de [0, 0,12]');
      const antes = previa.get(a.id); if (antes !== undefined && r < antes) pagado += antes - r;
      if (antes !== undefined && nacio.has(a.id)) { const cuota = antes - r, ganancia = a.genes.carnivory < 0.6 ? Math.min(1, 0.15 * 4) * 0.0015 : 0.15 * 0.25; assert.ok(cuota <= RESERVA_POR_PROGENITOR + 1e-12 && cuota >= RESERVA_POR_PROGENITOR - ganancia - 1e-12, `cuota ${cuota}`); }
      if (a.reason === RAZON_PAREJA) {
        const d = Math.abs(a.x - a.target.x) + Math.abs(a.y - a.target.y);
        const visto = buscando.get(a.id);
        if (visto === undefined) buscando.set(a.id, d); else if (d < visto) { aprox++; buscando.set(a.id, -1); }
      }
    }
    previa.clear(); for (const [k, v] of ahora) previa.set(k, v);
  }
  for (const a of w.animals) if (a.reproReserve !== undefined && a.reproReserve >= RESERVA_POR_PROGENITOR) listos++;
  assert.ok((cazas.fox ?? 0) >= 5 && (cazas.wolf ?? 0) >= 5, `caza real de zorro y lobo: ${JSON.stringify(cazas)}`);
  assert.ok(maximo >= RESERVA_POR_PROGENITOR, 'la reserva llegó a la puerta de cría'); assert.ok(listos > 0);
  assert.ok(aprox >= 3, `animales listos que se acercaron a su pareja: ${aprox}`);
  assert.ok((crias.fox ?? 0) >= 1 && (crias.wolf ?? 0) >= 1, `crías G1+ de zorro y lobo: ${JSON.stringify(crias)}`);
  for (const [hijo, [p, q]] of padres) {
    const cria = w.animals.find(a => a.id === hijo);
    if (cria) { assert.ok(cria.generation >= 1); assert.equal(especie.get(p), especie.get(q)); assert.equal(especie.get(p), cria.species); }
  }
  // Conservación: lo único que baja una reserva es una cría; cada progenitor paga 0,03 (neto de lo que comió ese
  // mismo paso, de ahí la cota por paso arriba) y nunca se paga más de 0,06 por cría. La igualdad exacta
  // (0,03 + 0,03 y celda intacta) está en la prueba unitaria de R.
  const nacimientos = w.animalDynamics.births;
  assert.equal(nacimientos, Object.values(crias).reduce((s, n) => s + n, 0));
  assert.ok(pagado <= nacimientos * 0.06 + 1e-9 && pagado > 0, `reserva pagada ${pagado} ≤ 0,06 × ${nacimientos}`);
});

test('V19 F+R+M: serie (hilos 1) y workers (hilos 4, orden adversarial) dan el mismo mundo, 0 ULP, con M y R activos', () => {
  const correr = (params: string) => {
    const { tiles, animals } = parches();
    // Condición inicial: la mitad de los fundadores trae reserva (como si ya hubieran comido), para que M y R
    // actúen desde el primer paso en el rato corto de la prueba. No altera ninguna ley.
    animals.forEach((a, i) => { if (i % 2 === 0) a.reproReserve = 0.05; });
    const w = mundo(tiles, animals, `${TODAS},${params}`), razones = new Set<string>();
    for (let n = 1; n <= 200; n++) { paso(w); for (const a of w.animals) razones.add(a.reason); }
    return { w, razones };
  };
  const serie = correr('motor.hilos=1');
  const antes = despachosFaunaParalelos();
  const workers = correr('motor.hilos=4,motor.orden=adversarial');
  assert.ok(despachosFaunaParalelos() > antes, 'la decisión corrió en la piscina de workers');
  assert.ok(serie.razones.has(RAZON_PAREJA) && workers.razones.has(RAZON_PAREJA), 'M actuó en ambos');
  assert.ok(serie.w.animalDynamics.births > 0 && serie.w.animalDynamics.predations > 0);
  assert.equal(huella(workers.w), huella(serie.w));
  assert.deepStrictEqual(workers.w.animals, serie.w.animals); // distingue −0 y NaN
  assert.deepStrictEqual(workers.w.tiles, serie.w.tiles);
  assert.deepStrictEqual(workers.w.animalDynamics, serie.w.animalDynamics);
});
