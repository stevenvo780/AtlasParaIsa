import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLELE_COUNT, assertGenome, ESCUCHA_LOCUS, escuchaDe, expressGenome, founderGenome, GENE_COUNT, inheritGenome, localRandom, type Genome } from '../src/world/genetics.js';
import {
  ALCANCE_VOZ, audibilidad, calma, enqueueWhisper, FULFIL_DEADLINE_TICKS, OIDO_POR_TICK, OLVIDO_POR_TICK, probabilidadDeOir, riesgoDeOlvido,
  stepWhispers, WHISPER_CHECK_TICKS, WHISPER_LIFETIME_TICKS, type WhisperPersonLike, type WhisperRecord,
} from '../src/world/whispers.js';
import { pearson, rangos, regresion, spearman } from '../scripts/lab/escucha.mjs';

const RASGOS = { curiosity: 0.5, sociability: 0.5, industriousness: 0.5, care: 0.5, resilience: 0.5 };

function persona(id: string, escucha: number, extra: Partial<WhisperPersonLike> = {}): WhisperPersonLike {
  return { id, name: id, x: 0, y: 0, hunger: 0.2, thirst: 0.2, fatigue: 0.2, genome: { alleles: [...Array<number>(ESCUCHA_LOCUS * 2).fill(0.5), escucha, escucha] }, ...extra };
}
const mediana = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };

/** Un mensaje dirigido a cada persona, cada uno en su propia cola (la cola real admite pocos activos a la vez), dejado en el
 * paso 0 y avanzado cada `WHISPER_CHECK_TICKS` hasta el plazo. Devuelve el paso en que cada una lo oyó (null si no). */
function latenciasIndependientes(people: WhisperPersonLike[], seed: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (const p of people) {
    const whispers: WhisperRecord[] = [];
    enqueueWhisper(whispers, { personId: p.id, intent: 'explore', x: 9, y: 9 }, 0, 1, p.name);
    let oido: number | null = null;
    for (let t = WHISPER_CHECK_TICKS; t < WHISPER_LIFETIME_TICKS && oido === null; t += WHISPER_CHECK_TICKS)
      if (stepWhispers(whispers, [p], t, seed).heard.length) oido = t;
    out.push(oido);
  }
  return out;
}

// ── El gen ───────────────────────────────────────────────────────────────────────────────────────────────────

test('el genoma tiene ocho loci y el octavo es la escucha', () => {
  assert.equal(GENE_COUNT, 8);
  assert.equal(ALLELE_COUNT, 16);
  assert.equal(ESCUCHA_LOCUS, 7);
  const g = founderGenome(11, 'x', RASGOS, 0.15);
  assert.equal(g.alleles.length, 16);
  assert.equal(escuchaDe(g), (g.alleles[14]! + g.alleles[15]!) / 2);
  assert.deepEqual(Object.keys(expressGenome(g)).sort(), ['care', 'curiosity', 'industriousness', 'resilience', 'sociability'], 'los cinco rasgos de siempre; la escucha se lee con escuchaDe');
});

test('los siete loci anteriores conservan sus alelos de siempre; la escucha sale de su propia tirada', () => {
  for (const id of ['s', 'i', 'vecino-3', 'vecino-9']) for (const varianza of [0, 0.15]) {
    const g = founderGenome(12345, id, RASGOS, varianza);
    const random = localRandom(12345, `genome:${id}`);
    const fenotipo = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.2 + random() * 0.65];
    if (varianza === 0) assert.deepEqual(g.alleles.slice(0, 14), fenotipo.flatMap(v => [v, v]));
    else for (let i = 0; i < 14; i++) assert.ok(Math.abs(g.alleles[i]! - fenotipo[i >> 1]!) < 1, 'cerca de su fenotipo');
    // Cambiar la varianza no mueve la tirada de la escucha (cuando es 0, ambos alelos son su fenotipo).
    if (varianza === 0) assert.equal(g.alleles[14], g.alleles[15]);
  }
  const sinVarianza = founderGenome(12345, 's', RASGOS, 0), otraSemilla = founderGenome(12346, 's', RASGOS, 0);
  assert.notEqual(escuchaDe(sinVarianza), escuchaDe(otraSemilla));
});

test('la escucha de los fundadores cubre [0,2; 0,8] y es heterocigota con varianza', () => {
  const sin = Array.from({ length: 400 }, (_, i) => escuchaDe(founderGenome(7, `f${i}`, RASGOS, 0)));
  assert.ok(Math.min(...sin) >= 0.2 && Math.max(...sin) <= 0.8);
  assert.ok(Math.min(...sin) < 0.25 && Math.max(...sin) > 0.75, 'la tirada recorre el intervalo');
  const con = Array.from({ length: 400 }, (_, i) => founderGenome(7, `f${i}`, RASGOS, 0.15));
  assert.ok(con.every(g => g.alleles.every(a => a >= 0 && a <= 1)));
  const heterocigosis = con.reduce((s, g) => s + Math.abs(g.alleles[14]! - g.alleles[15]!), 0) / con.length;
  assert.ok(heterocigosis > 0.05, `los dos alelos de la escucha difieren (${heterocigosis.toFixed(3)})`);
});

test('el hijo recibe un alelo de la escucha de cada progenitor, y la mutación está acotada', () => {
  const a = { id: 'a', genome: founderGenome(5, 'a', RASGOS, 0.2) }, b = { id: 'b', genome: founderGenome(5, 'b', RASGOS, 0.2) };
  for (let k = 0; k < 50; k++) {
    const hijo = inheritGenome(5, `h${k}`, [a, b], 0);
    assert.equal(hijo.alleles.length, ALLELE_COUNT);
    assert.ok(a.genome.alleles.slice(14, 16).includes(hijo.alleles[14]!));
    assert.ok(b.genome.alleles.slice(14, 16).includes(hijo.alleles[15]!));
  }
  const mutado = inheritGenome(5, 'm', [a, b], 1);
  assert.equal(mutado.mutations, ALLELE_COUNT);
  assert.ok(mutado.alleles.every(x => x >= 0 && x <= 1));
  assert.doesNotThrow(() => assertGenome(mutado));
});

test('herencia de la escucha: pendiente hijo ~ media de los padres cerca de 1 en una población de parejas al azar', () => {
  const azar = localRandom(99, 'parejas');
  const fundadores = Array.from({ length: 600 }, (_, i) => ({ id: `p${i}`, genome: founderGenome(3, `p${i}`, RASGOS, 0.15) }));
  const x: number[] = [], y: number[] = [];
  for (let i = 0; i < 1500; i++) {
    const m = fundadores[Math.floor(azar() * fundadores.length)]!;
    let p = fundadores[Math.floor(azar() * fundadores.length)]!;
    while (p === m) p = fundadores[Math.floor(azar() * fundadores.length)]!;
    const hijo = inheritGenome(3, `h${i}`, [m, p]);
    x.push((escuchaDe(m.genome) + escuchaDe(p.genome)) / 2); y.push(escuchaDe(hijo));
  }
  const { pendiente, r } = regresion(x, y);
  assert.ok(pendiente > 0.85 && pendiente < 1.1, `pendiente ${pendiente.toFixed(3)} (r ${r.toFixed(3)})`);
});

test('un genoma de siete genes (mundo anterior a la V23) se rechaza con un mensaje claro y no se lee como basura', () => {
  const viejo: Genome = { ...founderGenome(1, 'v', RASGOS, 0.1) };
  viejo.alleles = viejo.alleles.slice(0, 14);
  assert.throws(() => assertGenome(viejo), /7 genes.*anterior a la V23.*8 genes.*mundo nuevo/);
  for (const largo of [0, 13, 15, 17, 32]) {
    const raro = { ...viejo, alleles: Array<number>(largo).fill(0.5) };
    assert.throws(() => assertGenome(raro), /Genoma de simulación inválido/);
  }
  const completo = founderGenome(1, 'v', RASGOS, 0.1);
  assert.doesNotThrow(() => assertGenome(completo));
  assert.throws(() => assertGenome({ ...completo, mutations: ALLELE_COUNT + 1 }), /inválido/);
  assert.doesNotThrow(() => assertGenome({ ...completo, mutations: ALLELE_COUNT }));
});

// ── La ley de oír ────────────────────────────────────────────────────────────────────────────────────────────

test('probabilidad de oír: proporcional a escucha², a la calma y a la audibilidad, sin umbrales', () => {
  const p = (e: number, c = 1, a = 1) => probabilidadDeOir(e, c, a);
  assert.equal(p(1), OIDO_POR_TICK);
  assert.ok(Math.abs(p(0.8) / p(0.4) - 4) < 1e-12, 'duplicar la escucha cuadruplica la probabilidad');
  assert.ok(Math.abs(p(0.5, 0.5) / p(0.5, 1) - 0.5) < 1e-12 && Math.abs(p(0.5, 1, 0.25) / p(0.5, 1, 1) - 0.25) < 1e-12);
  assert.equal(p(0), 0);
  assert.ok(p(0.01) > 0 && p(0.001) > 0, 'ninguna escucha positiva se queda sin probabilidad: no hay umbral');
  assert.ok(p(0.1, 0.01) > 0);
});

test('calma: producto de lo libre que está cada necesidad; 0 si alguna es total', () => {
  assert.equal(calma({ hunger: 0, thirst: 0, fatigue: 0 }), 1);
  assert.ok(Math.abs(calma({ hunger: 0.5, thirst: 0.5, fatigue: 0.5 }) - 0.125) < 1e-12);
  assert.equal(calma({ hunger: 1, thirst: 0, fatigue: 0 }), 0);
  assert.equal(calma({ hunger: 0, thirst: 1, fatigue: 0.3 }), 0);
  assert.equal(calma({ hunger: 2, thirst: -1, fatigue: 0 }), 0, 'se acota a [0, 1]');
});

test('audibilidad: 1 en el sitio, 1/2 a ALCANCE_VOZ, decreciente', () => {
  assert.equal(audibilidad(0), 1);
  assert.ok(Math.abs(audibilidad(ALCANCE_VOZ) - 0.5) < 1e-12);
  assert.ok(audibilidad(1) > audibilidad(5) && audibilidad(5) > audibilidad(50) && audibilidad(50) > 0);
});

test('riesgo de olvido: (1 − escucha) · OLVIDO_POR_TICK', () => {
  assert.equal(riesgoDeOlvido(1), 0);
  assert.equal(riesgoDeOlvido(0), OLVIDO_POR_TICK);
  assert.ok(Math.abs(riesgoDeOlvido(0.25) - 0.75 * OLVIDO_POR_TICK) < 1e-15);
});

test('latencia: la mediana cae como 1/escucha² y nadie con escucha 0 oye jamás', () => {
  const grupo = (e: number) => Array.from({ length: 1500 }, (_, i) => persona(`g${e}-${i}`, e));
  const medido = (e: number) => { const l = latenciasIndependientes(grupo(e), 77); return { oidos: l.filter(x => x !== null).length, mediana: mediana(l.map(x => x ?? WHISPER_LIFETIME_TICKS)) }; };
  const alta = medido(0.8), media = medido(0.4), baja = medido(0.2);
  // Mediana esperada con las comprobaciones cada 10 pasos y la calma de las personas de la prueba, (1 − 0,2)³.
  const teorica = (e: number) => { const p = OIDO_POR_TICK * e * e * (1 - 0.2) ** 3; return WHISPER_CHECK_TICKS * Math.ceil(Math.LN2 / -Math.log1p(-(1 - (1 - p) ** WHISPER_CHECK_TICKS))); };
  for (const [e, m] of [[0.8, alta], [0.4, media], [0.2, baja]] as const)
    assert.ok(Math.abs(m.mediana / teorica(e) - 1) < 0.15, `escucha ${e}: mediana ${m.mediana} frente a ${teorica(e)} esperada`);
  assert.ok(media.mediana / alta.mediana > 3.2 && media.mediana / alta.mediana < 4.8, `0,4 frente a 0,8: ×${(media.mediana / alta.mediana).toFixed(2)}`);
  assert.ok(baja.mediana / media.mediana > 3.2 && baja.mediana / media.mediana < 4.8, `0,2 frente a 0,4: ×${(baja.mediana / media.mediana).toFixed(2)}`);
  assert.ok(alta.oidos > 1495 && baja.oidos < alta.oidos);
  const sorda = latenciasIndependientes(Array.from({ length: 200 }, (_, i) => persona(`s${i}`, 0)), 5);
  assert.ok(sorda.every(x => x === null), 'escucha 0: ningún mensaje se oye');
});

test('latencia y escucha: Spearman negativo y la mayoría de los poco atentos no oye antes del plazo', () => {
  const azar = localRandom(31, 'cohorte');
  const personas = Array.from({ length: 600 }, (_, i) => persona(`c${i}`, 0.05 + azar() * 0.95));
  const l = latenciasIndependientes(personas, 3);
  const escucha = personas.map(p => escuchaDe(p.genome)), latencia = l.map(x => x ?? WHISPER_LIFETIME_TICKS);
  const rho = spearman(escucha, latencia);
  assert.ok(rho < -0.6, `rho ${rho.toFixed(3)}`);
  const poco = l.filter((_, i) => escucha[i]! < 0.15), muchos = l.filter((_, i) => escucha[i]! > 0.8);
  assert.ok(poco.filter(x => x === null).length / poco.length > 0.5, '«casi nunca» oyen quienes casi no escuchan');
  assert.ok(muchos.filter(x => x !== null).length / muchos.length > 0.99, 'quienes escuchan mucho oyen siempre');
});

test('un mensaje recién dejado no se oye en el mismo paso; un cuerpo agotado no oye; el plazo lo desvanece', () => {
  const whispers: WhisperRecord[] = [];
  const w = enqueueWhisper(whispers, { personId: 'a', intent: 'travel', x: 5, y: 5 }, 100, 1, 'a');
  assert.equal(stepWhispers(whispers, [persona('a', 1)], 100, 1).heard.length, 0, 'sin pasos transcurridos no hay probabilidad');
  const sediento = persona('a', 1, { thirst: 1 });
  for (let t = 110; t < 100 + WHISPER_LIFETIME_TICKS; t += 10) assert.equal(stepWhispers(whispers, [sediento], t, 1).heard.length, 0);
  assert.equal(w.status, 'latent');
  const fin = stepWhispers(whispers, [sediento], 100 + WHISPER_LIFETIME_TICKS, 1);
  assert.equal(w.status, 'faded'); assert.equal(fin.faded[0]!.reason, 'unheard');
});

test('mensaje regional: lo oye quien está cerca, con independencia del orden de la lista', () => {
  const cerca = persona('cerca', 0.7, { x: 20, y: 20 }), lejos = persona('lejos', 0.7, { x: 20 + 10 * ALCANCE_VOZ, y: 20 }), mediano = persona('mediano', 0.7, { x: 20 + 3 * ALCANCE_VOZ, y: 20 });
  const quienOye = (lista: WhisperPersonLike[], i: number) => {
    const whispers: WhisperRecord[] = [];
    enqueueWhisper(whispers, { personId: null, intent: 'explore', x: 20, y: 20 }, i * 7919, 1);
    for (let t = i * 7919 + 10; t < i * 7919 + WHISPER_LIFETIME_TICKS; t += 10) { const o = stepWhispers(whispers, lista, t, 17); if (o.heard.length) return o.heard[0]!.person.id; }
    return null;
  };
  const cuentas: Record<string, number> = { cerca: 0, mediano: 0, lejos: 0, nadie: 0 };
  for (let i = 0; i < 300; i++) {
    const a = quienOye([cerca, mediano, lejos], i), b = quienOye([lejos, mediano, cerca], i);
    assert.equal(a, b, 'el orden de la lista no decide quién lo oye');
    cuentas[a ?? 'nadie']!++;
  }
  assert.ok(cuentas.cerca! > 250, `cerca ${cuentas.cerca}, mediano ${cuentas.mediano}, lejos ${cuentas.lejos}`);
  assert.ok(cuentas.cerca! > cuentas.mediano! && cuentas.mediano! >= cuentas.lejos!);
});

test('la ley es determinista: misma semilla y mismas personas dan los mismos pasos de oído', () => {
  const personas = Array.from({ length: 80 }, (_, i) => persona(`d${i}`, 0.2 + (i % 8) / 10));
  assert.deepEqual(latenciasIndependientes(personas, 9), latenciasIndependientes(personas, 9));
  assert.notDeepEqual(latenciasIndependientes(personas, 9), latenciasIndependientes(personas, 10));
});

test('olvido: cuanto menos escucha, más probable olvidar el mensaje por el camino; con escucha 1 nunca', () => {
  const olvida = (escucha: number, semilla: number) => {
    const whispers: WhisperRecord[] = [];
    const w: WhisperRecord = enqueueWhisper(whispers, { personId: 'a', intent: 'travel', x: 50, y: 0 }, 0, 1, 'a');
    const a = persona('a', escucha, { action: 'explore', target: { x: 50, y: 0 } });
    w.status = 'heard'; w.heardTick = 0; w.heardById = 'a'; w.heardByName = 'a'; w.bestDistance = 50; w.stalledChecks = 0;
    for (let t = 10; t < FULFIL_DEADLINE_TICKS; t += 10) {
      a.x = t / 150; // se acerca despacio sin llegar: nunca está atascada
      const o = stepWhispers(whispers, [a], t, semilla);
      if (o.faded.length) return o.faded[0]!.reason === 'forgotten';
    }
    return false;
  };
  const fraccion = (escucha: number) => Array.from({ length: 200 }, (_, s) => olvida(escucha, s)).filter(Boolean).length / 200;
  const [f0, f5, f9, f10] = [fraccion(0), fraccion(0.5), fraccion(0.9), fraccion(1)];
  // 1 − exp(−riesgo · plazo): ≈ 1 con escucha 0, 0,97 con 0,5, 0,51 con 0,9 y 0 con 1
  assert.ok(f0 > 0.97, `escucha 0: ${f0}`);
  assert.ok(Math.abs(f5 - (1 - Math.exp(-0.0005 * FULFIL_DEADLINE_TICKS))) < 0.06, `escucha 0,5: ${f5}`);
  assert.ok(Math.abs(f9 - (1 - Math.exp(-0.0001 * FULFIL_DEADLINE_TICKS))) < 0.1, `escucha 0,9: ${f9}`);
  assert.equal(f10, 0);
});

// ── Los números del laboratorio ──────────────────────────────────────────────────────────────────────────────

test('estadística del laboratorio: rangos con empates, Spearman y regresión', () => {
  assert.deepEqual(rangos([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [5, 6, 7, 8, 7]) - 0.8208) < 1e-3);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  const r = regresion([0, 1, 2, 3], [1, 3, 5, 7]);
  assert.ok(Math.abs(r.pendiente - 2) < 1e-12 && Math.abs(r.ordenada - 1) < 1e-12 && Math.abs(r.r - 1) < 1e-12);
  assert.ok(Math.abs(pearson([1, 2, 3], [2, 4, 7]) - 0.9934) < 1e-3);
});
