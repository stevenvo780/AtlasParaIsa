import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { createWorld, stepWorld, type Person, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { indiceDiversidad } from '../src/world/diversidad.js';
import { cooperationOpportunity } from '../src/world/society.js';
import { researchTechnology, technologyWorkCost, type TechnologyProgram } from '../src/world/technology.js';
import { resolveTechnologyRecipe } from '../src/world/technology-catalogue.js';
import { DEFAULT_PARAMS, PARAM_RANGES, paramsOf, parseParams, setParams, type WorldParams } from '../src/world/params.js';

/**
 * Noche de ciencia 2026-09-22 — cuatro leyes CANDIDATAS declaradas como parámetros.
 * `docs/ANALISIS-DINAMICAS-2026-09-21.md` mide tres cierres del mundo vigente: la elección
 * de acción se traba en cooperar (97 % de la cooperación es enseñanza), las disputas por
 * recursos no ocurren jamás (conflictos y turnos = 0) y la pertenencia a una comunidad se
 * decide el día 1 y no vuelve a revisarse. Las siete claves nuevas abren esos cerrojos sin
 * decidir por ellos: sus defaults son las constantes que hoy están escritas en el código.
 *
 * Las cifras literales de este fichero se midieron con un script equivalente a `replica()`
 * (Store temporal adjunto y guardado ANTES del primer paso, como `scripts/lab/replica.ts`,
 * para que rijan las leyes de tecnología de producción y no las del catálogo aislado).
 */

/** Réplica mínima de laboratorio: semilla 51926, Store temporal, `save` antes de simular. */
function replica(t: { after(callback: () => void): void }, pasos: number, params?: string): World {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-leyes-'));
  const store = new Store(join(directory, 'world.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const world = createWorld(51926, parseParams(params));
  store.save(world);
  for (let tick = 1; tick <= pasos; tick++) stepWorld(world);
  return world;
}

/**
 * Digesto del mismo mundo medido con la FORMA de params de `main` (sin las siete claves
 * nuevas). `digestoCanonico` hashea `{world, params}` (T101/T102, docs/REGLAS.md: «añadir
 * configuración cambia su hash aunque el estado físico sea igual»), así que declarar las
 * leyes candidatas mueve el hash completo aunque ninguna actúe. Quitarlas del objeto de
 * params reproduce byte a byte el digesto de `main`: es el control de que el mundo físico
 * no se movió ni un bit.
 */
function digestoConParamsDeMain(world: World): string {
  const vigentes = paramsOf(world);
  const comoMain = structuredClone(DEFAULT_PARAMS) as unknown as Record<string, unknown>;
  delete comoMain.conducta; delete comoMain.social;
  setParams(world, comoMain as unknown as WorldParams);
  try { return digestoCanonico(world); } finally { setParams(world, vigentes); }
}

// Medidos en `main` @694f6b6 ANTES de tocar nada, con la réplica de arriba (seed 51926,
// Store temporal, sin guardados periódicos): 1200 pasos → b194b09…, 2400 → ee6fb78….
const DIGESTO_MAIN_1200 = 'b194b096c0dd4c555ca9ebf4e560bb293809b97947109f116833cf79ebbf60cf';
const DIGESTO_MAIN_2400 = 'ee6fb78c55d2a43effebe696314ca5f5eecefbc1b8b03150f61bb381ab1779e8';
// Los mismos mundos con las siete claves ya declaradas: sólo cambia el hash, no el estado.
const DIGESTO_LEYES_1200 = 'bd121f4f39ee7bdfe3c8e33a4d3890a557501ae28a0e62477c572d5bf6ec888c';
const DIGESTO_LEYES_2400 = '17336c1b8f06771edff2eae332b011750d26b8bc4a939265ffb3e8c0d20669d9';

test('(i) con los defaults las leyes candidatas no mueven el mundo: el digesto físico es el de main', { timeout: 300000 }, t => {
  const world = replica(t, 1200);
  assert.equal(digestoConParamsDeMain(world), DIGESTO_MAIN_1200,
    'el estado del mundo tras 1200 pasos es bit a bit el de main: ninguna ley candidata actúa con su default');
  assert.equal(digestoCanonico(world), DIGESTO_LEYES_1200,
    'el digesto completo sí cambia, y sólo por declarar configuración nueva (T102)');
  assert.notEqual(DIGESTO_LEYES_1200, DIGESTO_MAIN_1200);
  assert.deepEqual(DEFAULT_PARAMS.conducta, { habituacion: 0 });
  assert.deepEqual(DEFAULT_PARAMS.social, { disputaNecesidad: 0.65, disputaEscasez: 1, disputaRadio: 2,
    ensenanzaRareza: 0, confianzaSalida: 0.35, distanciaAlternativa: 0.2 }, 'cada default es la constante que había en el código');
});

test('(ii) conducta.habituacion=0.35 cambia el mundo y no reduce la diversidad de conducta', { timeout: 600000 }, t => {
  const sin = replica(t, 2400), con = replica(t, 2400, 'conducta.habituacion=0.35');
  assert.equal(digestoConParamsDeMain(sin), DIGESTO_MAIN_2400, 'control: con 0 el mundo sigue siendo el de main a 2400 pasos');
  assert.equal(digestoCanonico(sin), DIGESTO_LEYES_2400);
  assert.notEqual(digestoCanonico(con), digestoCanonico(sin), 'con 0,35 la saciedad sí elige distinto');

  // Medido (2400 pasos, seed 51926): total 0,3506 → 0,3985 (oficios 0,2742 → 0,4452;
  // conducta 0,4271 → 0,3517). La entropía de oficios sube mucho más de lo que baja la
  // distancia media entre vectores: se reparten más oficios distintos y, por eso mismo,
  // los repertorios se parecen algo más entre sí. Cooperaciones 58 → 90, enseñanzas 49 → 82.
  const base = indiceDiversidad(sin), abierto = indiceDiversidad(con);
  assert.ok(abierto.total >= base.total, `diversidad total ${abierto.total} < ${base.total} con habituacion=0.35`);
  assert.ok(abierto.oficios > base.oficios, `entropía de oficios ${abierto.oficios} <= ${base.oficios}`);
});

test('(iii) abrir el umbral de disputa produce disputas donde antes había cero', { timeout: 600000 }, t => {
  const world = replica(t, 2400, 'social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3');
  const turnos = world.events.filter(event => event.text.includes('acordaron turnarse')).length;
  const conflictos = world.totals.conflicts ?? 0;
  // Medido: 1 conflicto y 0 turnos en 2400 pasos, frente a 0 y 0 con los defaults. La
  // cooperación sube de 58 a 63 (la disputa también consume el intento de quien cede).
  assert.ok(conflictos + turnos > 0, `sigue en cero: conflictos=${conflictos}, turnos=${turnos}`);
});

const edge: TechnologyProgram = { inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
  steps: [{ op: 'form', intensity: 4, shape: 'edge' }, { op: 'compress', intensity: 2 }] };

/** Escena local de dos personas (mismo molde que `tests/cultural-transmission.test.ts`). */
function aula() {
  const world = createWorld(51926), teacher = world.people[2]!, learner = world.people[3]!;
  for (const person of world.people) {
    person.x = 10; person.y = 20; person.target = { x: 10, y: 20 }; person.action = 'rest';
    person.skills = {}; person.materials = { wood: 0, stone: 0 }; person.lastSocial = -30;
    person.energy = 1; person.fatigue = person.hunger = person.thirst = 0; person.decisionAt = 1_000_000;
  }
  for (const person of [teacher, learner]) { person.x = 36; person.y = 12; person.target = { x: 36, y: 12 }; }
  teacher.materials = { wood: 12, stone: 8 };
  const discover = (person: Person, program = edge) => {
    person.technology.project = { kind: 'research', program: structuredClone(program), parents: [], recipeId: null,
      progress: 0, requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt: world.tick };
    while (person.technology.project) { world.tick++; researchTechnology(world, person); }
    return world.technology.recipes.at(-1)!;
  };
  return { world, teacher, learner, discover };
}

test('(iv) social.ensenanzaRareza ordena por difusión cuando el gain empata', t => {
  const { world, teacher, learner, discover } = aula();
  const difundida = discover(teacher);
  const variante = structuredClone(edge); variante.steps[1]!.intensity = 3;
  const rara = discover(teacher, variante);
  // Fixture sintético: mismas capacidades ⇒ el MISMO `gain` (el aprendiz no recuerda nada,
  // así que `powers` es 0 y `gain` es el máximo de las capacidades). Sólo difieren en id y
  // en cuánta gente las conoce; el filtro `gain > 0.12` y los desempates no se tocan.
  Object.assign(resolveTechnologyRecipe(world, rara.id)!.capacities, difundida.capacities);
  world.tick += 30;
  assert.deepEqual(learner.technology.knownRecipes, [], 'el aprendiz no recuerda ninguna de las dos');

  assert.equal(cooperationOpportunity(world, teacher)?.recipeId, difundida.id,
    'con el default 0 el empate lo rompe el beneficio del maestro y luego el id, como siempre');
  for (const person of world.people) if (person !== teacher && person !== learner) person.technology.knownRecipes.push(difundida.id);
  assert.equal(world.people.filter(p => p.technology.knownRecipes.includes(difundida.id)).length, 15);
  assert.equal(world.people.filter(p => p.technology.knownRecipes.includes(rara.id)).length, 1);
  assert.equal(cooperationOpportunity(world, teacher)?.recipeId, difundida.id,
    'la difusión por sí sola no cambia el orden mientras la rareza valga 0');

  setParams(world, parseParams('social.ensenanzaRareza=0.5'));
  assert.equal(cooperationOpportunity(world, teacher)?.recipeId, rara.id,
    'con 0,5 la receta que sólo recuerda el maestro adelanta a la que ya conocen 15 de 16');
});

test('(v) parseParams acota las siete claves nuevas y rechaza lo que cae fuera de rango', () => {
  const claves = ['conducta.habituacion', 'social.disputaNecesidad', 'social.disputaEscasez',
    'social.disputaRadio', 'social.ensenanzaRareza', 'social.confianzaSalida', 'social.distanciaAlternativa'] as const;
  assert.deepEqual(claves.map(clave => PARAM_RANGES[clave]),
    [[0, 2], [0.1, 1], [0.1, 20], [1, 8], [0, 5], [0, 1], [0, 1]]);
  for (const clave of claves) {
    const [min, max] = PARAM_RANGES[clave]!;
    assert.throws(() => parseParams(`${clave}=${min - 0.05}`), /rango/i, `${clave} por debajo del mínimo`);
    assert.throws(() => parseParams(`${clave}=${max + 0.05}`), /rango/i, `${clave} por encima del máximo`);
    assert.throws(() => parseParams(`${clave}=mucho`), /num[ée]ric/i, `${clave} no numérico`);
    // Los extremos sí son legales.
    assert.equal(valor(parseParams(`${clave}=${min}`), clave), min, `${clave} en su mínimo`);
    assert.equal(valor(parseParams(`${clave}=${max}`), clave), max, `${clave} en su máximo`);
  }
  assert.throws(() => parseParams('conducta.inexistente=1'), /desconocid/i);
  assert.throws(() => parseParams('social.disputa=1'), /desconocid/i);
  assert.equal(parseParams('social.disputaRadio=8,conducta.habituacion=2').social.disputaRadio, 8);
});

test('(vi) una instantánea anterior a estas leyes las completa con sus defaults (patrón T102)', t => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-leyes-snapshot-'));
  const path = join(directory, 'world.sqlite'), store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.save(createWorld(51926, parseParams('agua.cuencas=0.8,social.disputaRadio=4')));
  const saved = JSON.parse((store.db.prepare('SELECT body FROM snapshots WHERE slot=0').get() as { body: string }).body);
  assert.equal(saved.params.social.disputaRadio, 4, 'las claves nuevas viajan en la instantánea como cualquier otra');
  delete saved.params.conducta; delete saved.params.social; // Instantánea escrita antes de esta ley.
  const body = JSON.stringify(saved);
  store.db.prepare('UPDATE snapshots SET body=?,digest=? WHERE slot=0').run(body, createHash('sha256').update(body).digest('hex'));

  const reopened = new Store(path);
  t.after(() => reopened.close());
  const vigentes = paramsOf(reopened.load()!.world);
  assert.deepEqual(vigentes.conducta, DEFAULT_PARAMS.conducta);
  assert.deepEqual(vigentes.social, DEFAULT_PARAMS.social, 'sin campo se rellena con el comportamiento de siempre');
  assert.equal(vigentes.agua.cuencas, 0.8, 'y los overrides históricos sobreviven intactos');
});

function valor(params: WorldParams, clave: string): number {
  const [seccion, hoja] = clave.split('.') as ['conducta' | 'social', string];
  return (params[seccion] as unknown as Record<string, number>)[hoja]!;
}
