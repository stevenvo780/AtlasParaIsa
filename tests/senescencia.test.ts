import test from 'node:test';
import assert from 'node:assert/strict';
import type { DemographicActor, DemographicTraits, DemographicTransition, LongevityLaw, SenescenceLaw } from '../src/shared/demography.js';
import { demographicTraits, DEMOGRAPHY_TICKS_PER_DAY as DAY, initialDemography,
  PROTECTED_HEALTH_FLOOR, PROTECTED_VITALITY_FLOOR, SENESCENCE_WEAR_PER_DAY, updateDemography } from '../src/world/demography.js';
import { localRandom } from '../src/world/genetics.js';
import { DEFAULT_PARAMS } from '../src/world/params.js';

const traits = demographicTraits({ alleles: Array<number>(14).fill(0.5) });
/** Ley de referencia de T001 (0,02 · 6 · 0,6). Las métricas miden la LEY, no los defaults del sprint:
 * si T016–T018 recalibra `cuerpo.*`, estas cifras siguen midiendo lo mismo. */
const LEGACY_LAW: SenescenceLaw = { ...DEFAULT_PARAMS.cuerpo, riesgoSenescenciaDiario: 0.02, riesgoSenescenciaPendiente: 6, cuidadoReduceRiesgo: 0.6 };
const NO_HAZARD: SenescenceLaw = { ...LEGACY_LAW, riesgoSenescenciaDiario: 0 };
const safe = { exposure: 0, shelter: 0, protected: false, seed: 0, tick: 0, senescence: LEGACY_LAW } as const;
function body(age: number, health = 1, vitality = 1, id = 'subject', bodyTraits: DemographicTraits = traits): DemographicActor {
  return { id, state: { ...initialDemography(age), health, vitality }, traits: bodyTraits, hunger: 0.1, thirst: 0.1, energy: 0.85, fatigue: 0.1 };
}
/** Salud y vitalidad se mantienen fijas a propósito: este arnés aísla el RIESGO del desgaste, que se
 * mide aparte. Devuelve la edad de muerte o null si el cuerpo llega al tope sin morir. */
function deathAge(seed: number, health: number, vitality: number, dt: number,
  law: SenescenceLaw = LEGACY_LAW, capMultiple = 2, bodyTraits: DemographicTraits = traits): number | null {
  let age = bodyTraits.senescenceStart;
  const cap = bodyTraits.maximumAge * capMultiple;
  while (age < cap) {
    const result = updateDemography(body(age, health, vitality, `subject-${seed}`, bodyTraits),
      { ...safe, seed, tick: age, senescence: law }, Math.min(dt, cap - age));
    if (result.death) { assert.equal(result.death, 'senescence'); return result.state.age; }
    age = result.state.age;
  }
  return null;
}
function cohort(dt: number, health: number, vitality: number, capMultiple = 2): number[] {
  return Array.from({ length: 2000 }, (_, seed) => deathAge(seed, health, vitality, dt, LEGACY_LAW, capMultiple))
    .filter((age): age is number => age !== null);
}
function dispersion(values: readonly number[]): { mean: number; sd: number; cv: number } {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  return { mean, sd, cv: sd / mean };
}
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

test('maximum age is a risk threshold rather than a death decree', context => {
  let risk = 0, deaths = 0;
  for (let seed = 0; seed < 2000; seed++) {
    const result = updateDemography(body(traits.maximumAge), { ...safe, seed, tick: traits.maximumAge }, 1);
    risk = result.senescenceRisk; if (result.death) deaths++;
  }
  assert.ok(risk > 0); assert.equal(deaths, 0);
  context.diagnostic(JSON.stringify({ seeds: 2000, age: traits.maximumAge, dt: 1, senescenceRisk: risk, deaths }));
});

/** Obligatorio (research.md §«Modelo de senescencia»): `updateDemography` se llama ~9 veces por persona
 * y tick —1 real en `lineage.ts` y 8 previsiones en `index.ts`/`family.ts` con cuerpos hipotéticos—, así
 * que la decisión de senescencia debe ser PURA en (semilla, id, tick): el cuidado se lee del cuerpo
 * guardado, no del hipotético, y el dado sale del salt `senescence:id:tick`. */
test('the nine calls of one tick reach the same senescence verdict for any hypothetical body', context => {
  const variants: Partial<DemographicActor>[] = [{}, { hunger: 1 }, { thirst: 1 }, { hunger: 0.9, thirst: 0.9 },
    { energy: 0 }, { fatigue: 1 }, { hunger: 0.8, fatigue: 0.9 }, { thirst: 0.8, energy: 0.1 }, { hunger: 1, thirst: 1, energy: 0, fatigue: 1 }];
  const surroundings = [{}, { exposure: 1 }, { exposure: 1, shelter: 1 }, { shelter: 0.5 }];
  let deaths = 0, survivals = 0, checks = 0;
  for (let seed = 0; seed < 300; seed++) for (const multiple of [1, 1.5, 2.5, 3.2]) {
    const age = Math.round(traits.maximumAge * multiple), stored = body(age, 0.6, 0.6, `nine-${seed}`);
    const decisions = variants.map((variant, index) => updateDemography({ ...stored, ...variant },
      { ...safe, ...surroundings[index % surroundings.length]!, seed, tick: age }, 1));
    const first = decisions[0]!;
    for (const decision of decisions) {
      assert.equal(decision.senescenceRisk, first.senescenceRisk, `riesgo distinto entre previsiones del mismo tick (semilla ${seed}, edad ${age})`);
      assert.equal(decision.death === 'senescence', first.death === 'senescence', `veredicto distinto entre previsiones del mismo tick (semilla ${seed}, edad ${age})`);
      assert.ok(decision.death === null || decision.death === 'senescence', 'un tick de daño no puede matar por recursos en este arnés: sólo se compara la senescencia');
      checks++;
    }
    if (first.death) deaths++; else survivals++;
  }
  assert.ok(deaths > 0 && survivals > 0, `el arnés debe ver ambos desenlaces: ${deaths} muertes, ${survivals} supervivencias`);
  context.diagnostic(JSON.stringify({ calls: checks, seeds: 300, ages: 4, variants: variants.length, deaths, survivals }));
});

test('care separates cumulative mortality without making healthy elders immortal', context => {
  const neglected = cohort(240, 0.2, 0.2), full = cohort(240, 1, 1);
  const neglectedFraction = neglected.length / 2000, fullFraction = full.length / 2000;
  assert.ok(neglectedFraction > 0.95); assert.ok(fullFraction > 0.05 && fullFraction < 0.5); assert.ok(fullFraction < neglectedFraction);
  context.diagnostic(JSON.stringify({ seeds: 2000, dt: 240, neglectedFraction, fullFraction,
    neglectedMedianDeathAge: median(neglected), fullMedianDeathAge: median(full) }));
});

/** Métrica de refutación del brief: `edadMuerte.cv` = 0,081 con el corte de edad; con riesgo real debe
 * ser ≥ 0,12. Se mide sobre la MISMA heterogeneidad que produce ese 0,081 en el mundo (genomas y
 * cuidados distintos), y se compara contra el decreto —cv de `maximumAge` sobre esos mismos genomas—.
 * Para una cohorte homogénea y bien cuidada el 0,12 es inalcanzable por construcción y el test lo
 * demuestra: con la mediana más allá de 2×maximumAge (lo exige el propio brief) la anchura Gompertz
 * π/(√6·pendiente) deja el cv por debajo de 0,11 con pendiente 6. */
test('the age of death disperses far beyond the age decree (cv)', context => {
  const deathAges: number[] = [], decree: number[] = [];
  for (let seed = 0; seed < 2000; seed++) {
    const random = localRandom(seed, 'cohorte-heterogenea');
    const drawn = demographicTraits({ alleles: Array.from({ length: 14 }, () => random()) });
    const health = 0.2 + random() * 0.8, vitality = 0.2 + random() * 0.8;
    const age = deathAge(seed, health, vitality, 240, LEGACY_LAW, 6, drawn);
    decree.push(drawn.maximumAge);
    assert.notEqual(age, null, `la cohorte no puede quedar censurada: la semilla ${seed} llegó a 6×maximumAge viva`);
    deathAges.push(age!);
  }
  const world = dispersion(deathAges), decreed = dispersion(decree);
  assert.ok(world.cv >= 0.12, `cv ${world.cv} < 0,12`);
  assert.ok(world.cv > decreed.cv * 2, `cv ${world.cv} no dispersa más que el decreto ${decreed.cv}`);

  const full = cohort(240, 1, 1, 6), cared = dispersion(full);
  assert.equal(full.length, 2000);
  const ceiling = (Math.PI / Math.sqrt(6)) / (LEGACY_LAW.riesgoSenescenciaPendiente * cared.mean / traits.maximumAge);
  assert.ok(cared.mean > traits.maximumAge * 2, 'el brief exige que el cuerpo pleno pase de 2×maximumAge');
  assert.ok(ceiling < 0.12, `si la mediana supera 2×maximumAge, la pendiente ${LEGACY_LAW.riesgoSenescenciaPendiente} no deja llegar a 0,12 (techo ${ceiling})`);
  assert.ok(cared.cv > ceiling * 0.9 && cared.cv < ceiling * 1.05, `cv ${cared.cv} fuera del techo Gompertz ${ceiling}`);
  assert.ok(cared.cv > 0.081, `ni la cohorte más cuidada baja del cv del decreto: ${cared.cv}`);
  context.diagnostic(JSON.stringify({ seeds: 2000, dt: 240, cap: '6×maximumAge',
    mixedCv: world.cv, mixedMeanDays: world.mean / DAY, decreeCv: decreed.cv, decreeMeanDays: decreed.mean / DAY,
    caredHomogeneousCv: cared.cv, caredMeanDays: cared.mean / DAY, gompertzCeiling: ceiling, briefTarget: 0.12, briefBaseline: 0.081 }));
});

test('senescence draws are deterministic, identity-scoped, seed-scoped and independent of wall clock', () => {
  const person = body(traits.maximumAge * 2, 1, 1, 'same'), environment = { ...safe, seed: 431, tick: 99 };
  const first = updateDemography(person, environment, DAY), second = updateDemography(person, environment, DAY);
  assert.deepEqual(first, second);
  const originalNow = Date.now;
  try { Date.now = () => { throw new Error('wall clock used'); }; assert.deepEqual(updateDemography(person, environment, DAY), first); }
  finally { Date.now = originalNow; }
  let identityScoped = false, seedScoped = false;
  for (let seed = 0; seed < 200 && !(identityScoped && seedScoped); seed++) {
    const a = updateDemography(body(traits.maximumAge * 2, 1, 1, 'a'), { ...safe, seed, tick: 99 }, DAY);
    const b = updateDemography(body(traits.maximumAge * 2, 1, 1, 'b'), { ...safe, seed, tick: 99 }, DAY);
    // Dos habitantes con la MISMA edad y el MISMO maximumAge: el dado debe separarlos por id.
    identityScoped ||= a.death !== b.death;
    // Dos mundos con semillas distintas no pueden compartir el patrón de mortalidad.
    seedScoped ||= a.death !== updateDemography(body(traits.maximumAge * 2, 1, 1, 'a'), { ...safe, seed: seed + 7919, tick: 99 }, DAY).death;
  }
  assert.equal(identityScoped, true); assert.equal(seedScoped, true);
});

test('exact integrated hazard is stable across step sizes', context => {
  const fine = cohort(240, 1, 1).length / 2000, coarse = cohort(480, 1, 1).length / 2000;
  assert.ok(Math.abs(fine - coarse) < 0.05);
  context.diagnostic(JSON.stringify({ seeds: 2000, fineDt: 240, coarseDt: 480, fine, coarse, difference: Math.abs(fine - coarse) }));
});

test('external continuity protection still preserves S and I bodies', () => {
  for (const id of ['S', 'I']) {
    const result = updateDemography(body(traits.maximumAge * 8, 0.00001, 0.01, id),
      { ...safe, protected: true, seed: 17, tick: traits.maximumAge * 8 }, 1);
    assert.equal(result.senescenceRisk, 1);
    assert.equal(result.death, null); assert.equal(result.preventedDeath, 'senescence'); assert.equal(result.state.deathCause, null);
    assert.equal(result.state.health, PROTECTED_HEALTH_FLOOR); assert.equal(result.state.vitality, PROTECTED_VITALITY_FLOOR);
  }
});

/** El hazard SUSTITUYE el corte de edad, no se apila sobre él: el desgaste sigue siendo el de la ley
 * vigente (×1,00, el brief sólo autorizaba ×1,09 como tope) para que la vejez siga siendo legible. Este
 * test lo acota por ARRIBA y por ABAJO: la constante no puede derivar hacia 0 sin que algo falle. */
test('old-age wear is the standing law: gradual, unmodulated by care and bounded below', context => {
  assert.equal(SENESCENCE_WEAR_PER_DAY, 0.8);
  let state = initialDemography(traits.senescenceStart), integral = 0, previous = -1;
  for (let age = traits.senescenceStart; age < traits.maximumAge; age += 240) {
    const dt = Math.min(240, traits.maximumAge - age);
    const step = updateDemography({ ...body(0), id: 'wear', state }, { ...safe, seed: 5, tick: age, senescence: NO_HAZARD }, dt);
    if (dt === 240) {
      assert.ok(step.damage.senescence > previous, 'la presión de vejez crece con la edad dentro de [senescenceStart, maximumAge]');
      previous = step.damage.senescence;
    }
    integral += step.damage.senescence; state = step.state;
  }
  const analytic = SENESCENCE_WEAR_PER_DAY * (traits.maximumAge - traits.senescenceStart) / (3 * DAY);
  assert.ok(Math.abs(integral - analytic) < 1e-9, `desgaste integrado ${integral} != ${analytic}`);
  assert.ok(integral > 0.8 && state.health < 0.3, `la vejez debe ser visible: integral ${integral}, salud ${state.health}`);
  // El cuidado alarga la vida (riesgo), pero no borra los años ya gastados.
  const middle = Math.round((traits.senescenceStart + traits.maximumAge) / 2);
  const cared = updateDemography(body(middle, 1, 1), { ...safe, seed: 5, tick: middle, senescence: NO_HAZARD }, 240);
  const neglected = updateDemography(body(middle, 0.3, 0.3), { ...safe, seed: 5, tick: middle, senescence: NO_HAZARD }, 240);
  assert.equal(cared.damage.senescence, neglected.damage.senescence);
  context.diagnostic(JSON.stringify({ wearPerDay: SENESCENCE_WEAR_PER_DAY, integral, analytic, healthAtMaximumAge: state.health }));
});

/** Obligatorio (research.md): si el desgaste añadido superase ×1,09 el actual, la salud llegaría a 0
 * antes de `maximumAge` y el decreto volvería disfrazado. Con riesgo 0 el cuerpo debe seguir vivo. */
test('a healthy body at 1,2x maximum age with zero risk keeps its health above zero', context => {
  const trajectory = (hunger: number, thirst: number, energy: number, fatigue: number) => {
    let state = initialDemography(traits.senescenceStart);
    for (let age = traits.senescenceStart; age < traits.maximumAge * 1.2; age += 240) {
      const step = updateDemography({ ...body(0), id: 'elder', state, hunger, thirst, energy, fatigue },
        { ...safe, seed: 3, tick: age, senescence: NO_HAZARD }, 240);
      assert.equal(step.death, null); state = step.state;
    }
    return state.health;
  };
  const tended = trajectory(0.1, 0.1, 0.85, 0.1), scraping = trajectory(0.6, 0.55, 0.4, 0.5);
  for (const health of [tended, scraping]) assert.ok(health > 0 && health < 0.3, `salud ${health} fuera de (0, 0,3)`);
  context.diagnostic(JSON.stringify({ age: traits.maximumAge * 1.2, tended, scraping }));
});

test('neglected old bodies still die from senescence without rescue', () => {
  for (let seed = 0; seed < 20; seed++) {
    let person = { ...body(traits.senescenceStart, 0.2, 0.2, `neglected-${seed}`), hunger: 0.7, thirst: 0.65, energy: 0.2, fatigue: 0.8 };
    let result: DemographicTransition = updateDemography(person, { ...safe, seed, tick: person.state.age }, 0);
    while (!result.death && person.state.age < traits.maximumAge * 3) {
      result = updateDemography(person, { ...safe, seed, tick: person.state.age }, Math.min(240, traits.maximumAge * 3 - person.state.age));
      person = { ...person, state: result.state };
    }
    assert.equal(result.death, 'senescence'); assert.ok(result.state.age < traits.maximumAge * 3);
  }
});

test('an unbounded age saturates the risk at certainty and never loops back into immunity', () => {
  for (const multiple of [2, 15, 200, 5000]) {
    const result = updateDemography(body(traits.maximumAge * multiple), { ...safe, seed: 7, tick: 7 }, 1);
    assert.ok(result.senescenceRisk > 0, `edad ${multiple}× maximumAge no puede tener riesgo nulo`);
  }
  assert.equal(updateDemography(body(traits.maximumAge * 200), { ...safe, seed: 7, tick: 7 }, 1).senescenceRisk, 1);
});

/** El fallback silencioso (`seed ?? 0`, `id ?? maximumAge`, `senescence ?? DEFAULT`) sincronizaba las
 * muertes y dejaba `cuerpo.*` fuera de `parseParams`. Avanzar un cuerpo sin esos datos es un error. */
test('advancing a body without identity, seed, tick or law is an error, not a default', () => {
  const full = { ...safe, seed: 11, tick: 23 };
  assert.throws(() => updateDemography({ ...body(traits.maximumAge), id: undefined }, full, 1), RangeError);
  assert.throws(() => updateDemography(body(traits.maximumAge), { ...full, seed: undefined }, 1), RangeError);
  assert.throws(() => updateDemography(body(traits.maximumAge), { ...full, tick: undefined }, 1), RangeError);
  assert.throws(() => updateDemography(body(traits.maximumAge), { ...full, senescence: undefined }, 1), RangeError);
  // dt = 0 (la consulta de fertilidad de family.ts) no tira ningún dado y sigue siendo legal.
  const query = updateDemography({ ...body(traits.maturityAge), id: undefined }, { exposure: 0, shelter: 0, protected: false }, 0);
  assert.equal(query.offspringEligible, true); assert.equal(query.senescenceRisk, 0);
});

test('optional deterministic hazard inputs reject invalid values', () => {
  const invalidId = { ...body(0), id: 42 } as unknown as DemographicActor;
  assert.throws(() => updateDemography(invalidId, safe), RangeError);
  assert.throws(() => updateDemography({ ...body(0), id: '' }, safe), RangeError);
  assert.throws(() => updateDemography(body(0), { ...safe, seed: 1.5 }), RangeError);
  assert.throws(() => updateDemography(body(0), { ...safe, tick: Number.POSITIVE_INFINITY }), RangeError);
  assert.throws(() => updateDemography(body(0), { ...safe, senescence: { ...LEGACY_LAW, riesgoSenescenciaDiario: -1 } }), RangeError);
  assert.throws(() => updateDemography(body(0), { ...safe, senescence: { ...LEGACY_LAW, cuidadoReduceRiesgo: 2 } }), RangeError);
});

// ── R3: los cuatro parámetros de longevidad (`cuerpo.longevidad*` y `cuerpo.senescenciaInicioFraccion`).
// T010 declaró la ley «edad máxima = base + resiliencia·gen − actividad·hábito; inicio = fracción» pero
// la escribió con los literales 11/4/1/0,75, así que las cuatro claves de `params.ts` no las leía nadie
// (hallazgo R3 de t041-residuales.md). Estos tests fijan (a) que los DEFAULTS reproducen esos literales
// bit a bit y (b) que cambiar cada clave mueve de verdad la ley.

/** Genomas variados y reproducibles para medir la ley sobre toda la anchura de alelos. */
function genomes(count: number, salt: string): { alleles: number[] }[] {
  return Array.from({ length: count }, (_, seed) => {
    const random = localRandom(seed, salt);
    return { alleles: Array.from({ length: 14 }, () => random()) };
  });
}

/** Edades de muerte de una cohorte bajo una ley de longevidad dada. Mismos dados y misma ley de
 * riesgo en todas las variantes: lo único que cambia es `cuerpo.longevidad*`. */
function longevityCohort(law: LongevityLaw, sample: readonly { alleles: number[] }[], size = 300): number[] {
  return Array.from({ length: size }, (_, seed) => deathAge(seed, 1, 1, 240, LEGACY_LAW, 6,
    demographicTraits(sample[seed % sample.length]!, law))).filter((age): age is number => age !== null);
}

test('R3: con los defaults la ley de longevidad reproduce los literales de T010 bit a bit', () => {
  for (const genome of [{ alleles: Array<number>(14).fill(0.5) }, { alleles: Array<number>(14).fill(0) },
    { alleles: Array<number>(14).fill(1) }, ...genomes(64, 'ley-longevidad')]) {
    const implicit = demographicTraits(genome), explicit = demographicTraits(genome, DEFAULT_PARAMS.cuerpo);
    assert.deepEqual(implicit, explicit, 'omitir la ley debe ser exactamente pasarle los defaults');
    const resilience = (genome.alleles[8]! + genome.alleles[9]!) / 2, activity = (genome.alleles[4]! + genome.alleles[5]!) / 2;
    const literal = Math.round((11 + resilience * 4 - activity) * DAY);
    assert.equal(implicit.maximumAge, literal, 'la edad máxima con defaults no es la de los literales de T010');
    assert.equal(implicit.senescenceStart, Math.round(literal * 0.75), 'el inicio de senescencia con defaults no es 0,75·máxima');
  }
});

test('R3: longevidadBaseDias=6 acorta la vida y adelanta la muerte por edad', context => {
  const short: LongevityLaw = { ...DEFAULT_PARAMS.cuerpo, longevidadBaseDias: 6 };
  const sample = genomes(64, 'base-6');
  for (const genome of sample) {
    assert.equal(demographicTraits(genome, short).maximumAge, demographicTraits(genome).maximumAge - 5 * DAY,
      'bajar la base 5 días debe bajar la edad máxima exactamente 5 días');
    assert.ok(demographicTraits(genome, short).senescenceStart < demographicTraits(genome).senescenceStart);
  }
  const base11 = longevityCohort(DEFAULT_PARAMS.cuerpo, sample), base6 = longevityCohort(short, sample);
  assert.equal(base11.length, 300); assert.equal(base6.length, 300);
  assert.ok(median(base6)! < median(base11)!, `la mediana de edad de muerte no bajó: ${median(base6)} vs ${median(base11)}`);
  assert.ok(Math.min(...base6) < Math.min(...base11), 'la primera muerte de la cohorte no se adelantó');
  context.diagnostic(JSON.stringify({ cohorte: 300, base11MedianaDias: median(base11)! / DAY, base6MedianaDias: median(base6)! / DAY }));
});

/** Trayectoria real: el cuerpo CONSERVA su estado, así que el desgaste de vejez se acumula desde
 * `senescenceStart`. Ése es el canal por el que `senescenciaInicioFraccion` mueve la vida — el hazard
 * de `mortalityRisk` se integra contra `maximumAge` y telescopa, así que adelantar sólo el inicio casi
 * no lo toca. Devuelve la edad de muerte, o null si el cuerpo llega a 3×maximumAge vivo. */
function trajectoryDeathAge(seed: number, bodyTraits: DemographicTraits, law: SenescenceLaw = LEGACY_LAW): number | null {
  let state = initialDemography(bodyTraits.maturityAge);
  const cap = bodyTraits.maximumAge * 3;
  while (state.age < cap) {
    const step = updateDemography({ ...body(0, state.health, state.vitality, `trayectoria-${seed}`, bodyTraits), state },
      { ...safe, seed, tick: state.age, senescence: law }, Math.min(240, cap - state.age));
    state = step.state;
    if (step.death) { assert.equal(step.death, 'senescence'); return state.age; }
  }
  return null;
}

test('R3: senescenciaInicioFraccion=0.5 adelanta el inicio de la vejez y la muerte por edad', context => {
  const early: LongevityLaw = { ...DEFAULT_PARAMS.cuerpo, senescenciaInicioFraccion: 0.5 };
  const sample = genomes(64, 'fraccion-0.5');
  for (const genome of sample) {
    const law = demographicTraits(genome, early), reference = demographicTraits(genome);
    assert.equal(law.maximumAge, reference.maximumAge, 'la fracción no debe tocar la edad máxima');
    assert.equal(law.senescenceStart, Math.round(law.maximumAge * 0.5));
    assert.ok(law.senescenceStart < reference.senescenceStart);
  }
  // Claim determinista, sin dados: a 0,6×edad máxima la vejez ya pesa con 0,5 y todavía no existe con 0,75.
  const reference = demographicTraits(sample[0]!), shifted = demographicTraits(sample[0]!, early);
  const age = Math.round(reference.maximumAge * 0.6);
  const wear = (bodyTraits: DemographicTraits) => updateDemography(body(age, 1, 1, 'vejez', bodyTraits),
    { ...safe, seed: 3, tick: age, senescence: NO_HAZARD }, 240).damage.senescence;
  assert.equal(wear(reference), 0, 'con 0,75 la vejez aún no ha empezado a 0,6×edad máxima');
  assert.ok(wear(shifted) > 0, 'con 0,5 la vejez ya debe pesar a 0,6×edad máxima');
  // Y la vida medida sobre trayectorias reales (el desgaste se acumula) se acorta.
  const deaths = (longevity: LongevityLaw) => Array.from({ length: 120 }, (_, seed) =>
    trajectoryDeathAge(seed, demographicTraits(sample[seed % sample.length]!, longevity)))
    .filter((value): value is number => value !== null);
  const normal = deaths(DEFAULT_PARAMS.cuerpo), adelantada = deaths(early);
  assert.equal(normal.length, 120); assert.equal(adelantada.length, 120);
  assert.ok(median(adelantada)! < median(normal)!, `la mediana de edad de muerte no bajó: ${median(adelantada)} vs ${median(normal)}`);
  context.diagnostic(JSON.stringify({ cohorte: 120, desgasteRef: wear(reference), desgasteAdelantado: wear(shifted),
    normalMedianaDias: median(normal)! / DAY, adelantadaMedianaDias: median(adelantada)! / DAY }));
});

test('R3: longevidadPorResiliencia y longevidadPorActividad son las pendientes de la ley', () => {
  const genome = { alleles: Array<number>(14).fill(0.5) }, resilience = 0.5, activity = 0.5;
  assert.equal(demographicTraits(genome, { ...DEFAULT_PARAMS.cuerpo, longevidadPorResiliencia: 0 }).maximumAge,
    Math.round((11 - activity) * DAY));
  assert.equal(demographicTraits(genome, { ...DEFAULT_PARAMS.cuerpo, longevidadPorActividad: 0 }).maximumAge,
    Math.round((11 + resilience * 4) * DAY));
  assert.equal(demographicTraits(genome, { ...DEFAULT_PARAMS.cuerpo, longevidadPorResiliencia: 8 }).maximumAge,
    Math.round((11 + resilience * 8 - activity) * DAY));
});

/** `updateDemography` exige madurez < inicio de senescencia < edad máxima. `PARAM_RANGES` admite
 * combinaciones que rompen ese orden (base 1 con pendiente de actividad 20): el mundo debe oírse
 * romper nombrando la ley, no caerse más tarde con un «estado demográfico inválido». */
test('R3: una ley de longevidad degenerada se oye romper y nombra su causa', () => {
  const genome = { alleles: Array<number>(14).fill(0.5) };
  assert.throws(() => demographicTraits(genome, { ...DEFAULT_PARAMS.cuerpo, longevidadBaseDias: 1, longevidadPorResiliencia: 0, longevidadPorActividad: 20 }),
    /Ley de longevidad degenerada/);
  assert.throws(() => demographicTraits(genome, { ...DEFAULT_PARAMS.cuerpo, senescenciaInicioFraccion: 0 }), /Ley de longevidad degenerada/);
  assert.throws(() => demographicTraits(genome, { ...DEFAULT_PARAMS.cuerpo, senescenciaInicioFraccion: 1 }), /Ley de longevidad degenerada/);
  assert.throws(() => demographicTraits(genome, { ...DEFAULT_PARAMS.cuerpo, longevidadBaseDias: Number.NaN }), /Ley de longevidad inválida/);
});
