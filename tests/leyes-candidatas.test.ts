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
import { DEFAULT_PARAMS, PARAM_DESCRIPTORS, PARAM_RANGES, paramsOf, parseParams, setParams, type WorldParams } from '../src/world/params.js';

/**
 * Noche de ciencia 2026-09-22 — cuatro leyes CANDIDATAS declaradas como parámetros.
 * `docs/ANALISIS-DINAMICAS-2026-09-21.md` mide tres cierres del mundo vigente: la elección
 * de acción se traba en cooperar (97 % de la cooperación es enseñanza), las disputas por
 * recursos no ocurren jamás (conflictos y turnos = 0) y la pertenencia a una comunidad se
 * decide el día 1 y no vuelve a revisarse. Las trece claves nuevas abren esos cerrojos sin
 * decidir por ellos: sus defaults son las constantes que hoy están escritas en el código.
 *
 * Las cifras literales de este fichero se midieron con un script equivalente a `replica()`
 * (Store temporal adjunto y guardado ANTES del primer paso, como `scripts/lab/replica.ts`,
 * para que rijan las leyes de tecnología de producción y no las del catálogo aislado).
 */

/** Réplica mínima de laboratorio: Store temporal y `save` antes de simular (como
 * `scripts/lab/replica.ts`). Devuelve el mundo y el tick de CADA nacimiento. */
function replicaDetallada(t: { after(callback: () => void): void }, pasos: number, params?: string, seed = 51926, version?: number): { world: World; nacimientos: number[] } {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-leyes-'));
  const store = new Store(join(directory, 'world.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const world = createWorld(seed, parseParams(params));
  // Reglas 10 corrige el alias del evento `community`; los controles contra `main` corren
  // el mismo mundo etiquetado V9 para comprobar que la historia V9 se reproduce byte a byte.
  if (version !== undefined) world.version = version;
  store.save(world);
  const nacimientos: number[] = [];
  for (let tick = 1; tick <= pasos; tick++) {
    const antes = world.birthCounter;
    stepWorld(world);
    for (let n = antes; n < world.birthCounter; n++) nacimientos.push(world.tick);
  }
  return { world, nacimientos };
}
function replica(t: { after(callback: () => void): void }, pasos: number, params?: string, version?: number): World {
  return replicaDetallada(t, pasos, params, 51926, version).world;
}
/** Como la réplica, pero archivando CADA paso, igual que el servidor: sólo así se oye si
 * una ley reescribe un evento que ya es durable (`Store.save` exige inmutabilidad). */
function replicaConGuardado(t: { after(callback: () => void): void }, pasos: number, params?: string, seed = 51926): { world: World } {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-leyes-durable-'));
  const store = new Store(join(directory, 'world.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const world = createWorld(seed, parseParams(params));
  store.save(world);
  for (let tick = 1; tick <= pasos; tick++) { stepWorld(world); store.save(world); }
  return { world };
}

/**
 * Digesto del mismo mundo medido con la FORMA de params de `main` (sin las trece claves
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
  // Claves nuevas de la integración de la noche (gobernador techo, cortejo, maxComunidades):
  // tampoco existen en `main`, y con su default tampoco actúan.
  delete (comoMain.gobernador as Record<string, unknown>).politica;
  const poblacion = comoMain.poblacion as Record<string, unknown>;
  for (const clave of ['exigeComunidad', 'radioPareja', 'radioLugar', 'comprobacionContinua', 'cortejo', 'radioCortejo']) delete poblacion[clave];
  delete (comoMain.agua as Record<string, unknown>).memoria;
  for (const clave of ['edadFundadoresMinDias', 'edadFundadoresMaxDias']) delete (comoMain.genes as Record<string, unknown>)[clave];
  setParams(world, comoMain as unknown as WorldParams);
  try { return digestoCanonico(world); } finally { setParams(world, vigentes); }
}

// Medidos en `main` @694f6b6 (reglas 9) ANTES de tocar nada, con la réplica de arriba (seed 51926,
// Store temporal, sin guardados periódicos): 1200 pasos → b194b09…, 2400 → ee6fb78….
const DIGESTO_MAIN_1200 = 'b194b096c0dd4c555ca9ebf4e560bb293809b97947109f116833cf79ebbf60cf';
const DIGESTO_MAIN_2400 = 'ee6fb78c55d2a43effebe696314ca5f5eecefbc1b8b03150f61bb381ab1779e8';

test('(i) con los defaults las leyes candidatas no mueven el mundo: el digesto físico es el de main', { timeout: 900000 }, t => {
  const world = replica(t, 1200, undefined, 9);
  assert.equal(digestoConParamsDeMain(world), DIGESTO_MAIN_1200,
    'el estado del mundo tras 1200 pasos es bit a bit el de main: ninguna ley candidata actúa con su default');
  assert.notEqual(digestoCanonico(world), DIGESTO_MAIN_1200,
    'el digesto completo sí cambia, y sólo por declarar configuración nueva (T102)');
  // Sólo las claves originales de cada ley: las hipótesis posteriores añaden claves a los mismos
  // grupos y comparar el objeto entero rompía el test con cada una sin que nada cambiara.
  assert.equal(DEFAULT_PARAMS.conducta.habituacion, 0);
  const social = DEFAULT_PARAMS.social as unknown as Record<string, unknown>;
  for (const [clave, valor] of Object.entries({ maxComunidades: 8, disputaNecesidad: 0.65, disputaEscasez: 1, disputaRadio: 2, disputaDestino: 0.5,
    disputaEspera: 180, ensenanzaRareza: 0, confianzaSalida: 0.35, distanciaAlternativa: 0.2 })) assert.equal(social[clave], valor, `default de social.${clave}`);
  const poblacion = DEFAULT_PARAMS.poblacion as unknown as Record<string, unknown>;
  for (const [clave, valor] of Object.entries({ maxima: 1_000_000, intervaloComprobacionTicks: 120, nacimientosPorComprobacion: 2,
    exigeComunidad: true, radioPareja: 3, radioLugar: 4, comprobacionContinua: false, cortejo: 0, radioCortejo: 24 })) assert.equal(poblacion[clave], valor, `default de poblacion.${clave}`);
});

test('(ii) conducta.habituacion=0.35 cambia el mundo y no reduce la diversidad de conducta', { timeout: 600000 }, t => {
  const sin = replica(t, 2400, undefined, 9), con = replica(t, 2400, 'conducta.habituacion=0.35', 9);
  assert.equal(digestoConParamsDeMain(sin), DIGESTO_MAIN_2400, 'control: con 0 el mundo sigue siendo el de main a 2400 pasos');
  assert.notEqual(digestoCanonico(sin), DIGESTO_MAIN_2400, 'el hash completo sólo cambia por declarar configuración');
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
  const { conflictos, turnos } = disputas(replica(t, 2400, 'social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3'));
  // Medido: 1 conflicto y 0 turnos en 2400 pasos, frente a 0 y 0 con los defaults. La
  // cooperación sube de 58 a 63 (la disputa también consume el intento de quien cede).
  assert.ok(conflictos + turnos > 0, `sigue en cero: conflictos=${conflictos}, turnos=${turnos}`);
});

/** Ninguna ventana de `intervalo` pasos consecutivos supera el techo por ventana. Basta
 * mirar las ventanas que ARRANCAN en un nacimiento: cualquier otra está contenida en una
 * de ésas o tiene menos nacimientos. */
function techoPorVentana(nacimientos: readonly number[], intervalo = DEFAULT_PARAMS.poblacion.intervaloComprobacionTicks): number {
  return Math.max(0, ...nacimientos.map(inicio => nacimientos.filter(tick => tick >= inicio && tick < inicio + intervalo).length));
}

const DIA = 2400;

test('(viii) abrir el embudo de natalidad hace nacer a alguien en la semilla 7 sin levantar el calendario', { timeout: 900000 }, t => {
  // Diagnóstico 2026-09-22 (`scripts/lab/diagnostico-natalidad.ts`): en la semilla 7 hay
  // ~9 fértiles de 14 mortales, pero sólo 6 tienen comunidad y ninguno encuentra pareja.
  // Medido con el radio real de la ley, mirando los 7200 pasos y no sólo las comprobaciones:
  // el par fértil, no consanguíneo y con vínculo mutuo ≥ 0,3 MÁS CERCANO de toda la corrida
  // está a 18,38 celdas. Por eso `radioPareja=6` (ni 12) abre nada y hace falta 20.
  const hoy = replicaDetallada(t, 3 * DIA, undefined, 7);
  assert.equal(hoy.world.birthCounter, 0, 'con las leyes de hoy la semilla 7 no pare a nadie en 3 días');
  assert.equal(replicaDetallada(t, 3 * DIA,
    'poblacion.exigeComunidad=false,poblacion.radioPareja=6,poblacion.radioLugar=8,poblacion.comprobacionContinua=true', 7).world.birthCounter,
    0, 'con radioPareja=6 la semilla 7 SIGUE sin parir: el cerrojo no eran 3 celdas, eran 18');

  const abierto = replicaDetallada(t, 3 * DIA,
    'poblacion.exigeComunidad=false,poblacion.radioPareja=20,poblacion.radioLugar=8,poblacion.comprobacionContinua=true', 7);
  assert.ok(abierto.world.birthCounter > 0, `sigue sin nacer nadie: ${JSON.stringify(abierto.nacimientos)}`);
  assert.equal(abierto.world.birthCounter, abierto.nacimientos.length);
  assert.ok(techoPorVentana(abierto.nacimientos) <= DEFAULT_PARAMS.poblacion.nacimientosPorComprobacion,
    `alguna ventana de 120 pasos supera el techo: ${JSON.stringify(abierto.nacimientos)}`);
});

test('(x) comprobacionContinua no reescribe un evento ya archivado al meter al recién nacido en el censo', { timeout: 900000 }, t => {
  // El evento de fundación de una comunidad comparte el arreglo con `group.members`
  // (society.ts). Con la comprobación periódica el nacimiento cae en el MISMO paso y la
  // extensión viaja con el evento; con `comprobacionContinua` cae 1..119 pasos después y
  // empujar reescribiría un evento ya durable: `Store.save` lo rechaza. La semilla 42 lo
  // reproducía en el paso 167. El censo del grupo tiene que seguir incluyendo a la cría.
  const { world } = replicaConGuardado(t, 400, 'poblacion.comprobacionContinua=true', 42);
  assert.ok(world.birthCounter > 0, 'la semilla 42 tiene que parir dentro de los 400 pasos');
  const censados = world.communities.flatMap(group => group.members);
  for (const person of world.people) if (person.communityId) assert.ok(censados.includes(person.id), `${person.id} no figura en su comunidad`);
});

test('(ix) comprobacionContinua sola cambia el muestreo, no el calendario máximo', { timeout: 900000 }, t => {
  const continua = replicaDetallada(t, DIA, 'poblacion.comprobacionContinua=true');
  // Techo del calendario en 2400 pasos: 2400/120 × 2 = 40. Hoy la semilla 51926 pare 6.
  assert.ok(continua.world.birthCounter <= DIA / DEFAULT_PARAMS.poblacion.intervaloComprobacionTicks * DEFAULT_PARAMS.poblacion.nacimientosPorComprobacion,
    `${continua.world.birthCounter} nacimientos superan el techo de 40`);
  assert.ok(continua.world.birthCounter >= 6, `muestrear cada paso no puede parir menos que hoy: ${continua.world.birthCounter} < 6`);
  assert.ok(techoPorVentana(continua.nacimientos) <= DEFAULT_PARAMS.poblacion.nacimientosPorComprobacion,
    `alguna ventana de 120 pasos supera el techo: ${JSON.stringify(continua.nacimientos)}`);
});

/** Conflictos contados + turnos acordados en la crónica del mundo. */
function disputas(world: World): { conflictos: number; turnos: number; cooperaciones: number } {
  return { conflictos: world.totals.conflicts ?? 0, cooperaciones: world.totals.cooperation ?? 0,
    turnos: world.events.filter(event => event.text.includes('acordaron turnarse')).length };
}

test('(vii) abrir también la coincidencia de destino y la espera sigue produciendo más disputas que los defaults', { timeout: 900000 }, t => {
  const defecto = disputas(replica(t, 2400));
  const abierto = disputas(replica(t, 2400,
    'social.disputaNecesidad=0.45,social.disputaEscasez=3,social.disputaRadio=3,social.disputaDestino=1.5,social.disputaEspera=60'));
  assert.deepEqual(defecto, { conflictos: 0, turnos: 0, cooperaciones: 58 }, 'con los defaults la disputa sigue sin ocurrir jamás');
  assert.ok(abierto.conflictos + abierto.turnos > defecto.conflictos + defecto.turnos,
    `abierto=${JSON.stringify(abierto)} no supera a defecto=${JSON.stringify(defecto)}`);
  // Medido: 1 conflicto, 0 turnos y 63 cooperaciones, EXACTAMENTE lo mismo que con
  // `disputaNecesidad/Escasez/Radio` solos (test iii) — y con el mismo estado físico
  // (digesto sin params `5dc8528c…` en los dos). En esta trayectoria la coincidencia de
  // destino y la espera de 180 ticks no eran el cerrojo: la única disputa que ocurre ya
  // cumplía < 0,5 y ≥ 180, y aflojarlas a 1,5 y 60 no abre ninguna más.
  assert.deepEqual(abierto, { conflictos: 1, turnos: 0, cooperaciones: 63 });
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

test('(v) parseParams acota las trece claves nuevas y rechaza lo que cae fuera de rango', () => {
  const claves = ['conducta.habituacion', 'social.disputaNecesidad', 'social.disputaEscasez',
    'social.disputaRadio', 'social.disputaDestino', 'social.disputaEspera',
    'social.ensenanzaRareza', 'social.confianzaSalida', 'social.distanciaAlternativa',
    'poblacion.radioPareja', 'poblacion.radioLugar'] as const;
  assert.deepEqual(claves.map(clave => PARAM_RANGES[clave]),
    [[0, 2], [0.1, 1], [0.1, 20], [1, 8], [0.1, 8], [1, 10000], [0, 5], [0, 1], [0, 1], [1, 32], [1, 64]]);
  for (const clave of claves) {
    const [min, max] = PARAM_RANGES[clave]!;
    assert.throws(() => parseParams(`${clave}=${min - 0.05}`), /rango/i, `${clave} por debajo del mínimo`);
    assert.throws(() => parseParams(`${clave}=${max + 0.05}`), /rango/i, `${clave} por encima del máximo`);
    assert.throws(() => parseParams(`${clave}=mucho`), /num[ée]ric/i, `${clave} no numérico`);
    // Los extremos sí son legales.
    assert.equal(valor(parseParams(`${clave}=${min}`), clave), min, `${clave} en su mínimo`);
    assert.equal(valor(parseParams(`${clave}=${max}`), clave), max, `${clave} en su máximo`);
  }
  // La espera se compara con `world.tick`: es entera, y un decimal se rechaza al parsear.
  assert.throws(() => parseParams('social.disputaEspera=1.5'), /entero/i);
  assert.equal(parseParams('social.disputaEspera=60').social.disputaEspera, 60);
  assert.equal(parseParams('social.disputaDestino=1.5').social.disputaDestino, 1.5);
  // Los dos interruptores del embudo son booleanos estrictos: nada de 0/1 ni 'False'.
  for (const clave of ['poblacion.exigeComunidad', 'poblacion.comprobacionContinua'] as const) {
    assert.equal(PARAM_DESCRIPTORS[clave]!.kind, 'boolean');
    for (const malo of ['0', '1', 'False', 'si', '']) assert.throws(() => parseParams(`${clave}=${malo}`), /true o false/, `${clave}=${malo}`);
    assert.equal(valorBooleano(parseParams(`${clave}=false`), clave), false);
    assert.equal(valorBooleano(parseParams(`${clave}=true`), clave), true);
  }
  assert.throws(() => parseParams('conducta.inexistente=1'), /desconocid/i);
  assert.throws(() => parseParams('poblacion.inexistente=1'), /desconocid/i);
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
  const [seccion, hoja] = clave.split('.') as ['conducta' | 'social' | 'poblacion', string];
  return (params[seccion] as unknown as Record<string, number>)[hoja]!;
}
function valorBooleano(params: WorldParams, clave: string): boolean {
  return (params.poblacion as unknown as Record<string, boolean>)[clave.split('.')[1]!]!;
}
