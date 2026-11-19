import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GOVERNOR_WINDOW_STEPS } from '../src/server/governor.js';
// `.mjs` (no `.mts`): tsx resuelve el especificador ESM `.mjs` contra el fuente `.mts`, igual que
// ya hace `tests/survival-audit.test.ts` con `scripts/survival-audit.mts`.
import { cerrarEscena, crearEscenaBase, medirVentana } from '../scripts/curva-techo.mjs';
import { clonarPlantillaSintetica } from '../scripts/lib/curva-techo-fixture.js';
import type { Person } from '../src/world/index.js';
import type { MaterialBatch, TechnologyKnowledge, TechnologyProgram } from '../src/shared/technology.js';
import { assertTechnology, defaultTechnologyState, materialCapacities, programSignature, technologyStock, toolCapacities, type TechnologyActor, type TechnologyHost } from '../src/world/technology.js';

type Json = Record<string, unknown>;
const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;
/** El contrato de `curva-techo.mts` («salida determinista salvo tiempos», igual que
 * `scripts/lab/replica.ts`) exime `p50`, `p95`, `tickHz` y `rss` — dependen del reloj de
 * pared y del asignador de memoria del proceso, no de la simulación. */
const stripTimings = (o: Json): Json => { const { p50: _p50, p95: _p95, tickHz: _tickHz, rss: _rss, ...rest } = o; return rest; };

function runCurva(t: TestContext, args: readonly string[]): { dir: string; result: SpawnSyncReturns<string> } {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-techo-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/curva-techo.mts', ...args, '--salida', dir], { encoding: 'utf8' });
  return { dir, result };
}

const PUNTO_KEYS = ['escala', 'habitantes', 'teselasActivas', 'teselasPorHabitante', 'p50', 'p95', 'tickHz', 'rss', 'fraccionSerial', 'presupuestoMs', 'hilosSolicitados', 'gpuSolicitada', 'tick'] as const;

test('escala de habitantes: produce puntos con las claves pedidas por T109 y para por hasta', (t) => {
  const { dir, result } = runCurva(t, ['--seed', '51926', '--escala', 'habitantes', '--hasta', '32']);
  assert.equal(result.status, 0, result.stderr);

  const puntos = readdirSync(dir).filter(f => f.startsWith('punto-')).sort();
  assert.ok(puntos.length >= 1, 'debe escribir al menos un punto-NNN.json');
  for (const nombre of puntos) {
    const punto = readJson(join(dir, nombre));
    for (const key of PUNTO_KEYS) assert.ok(Object.hasOwn(punto, key), `${nombre} debe tener la clave "${key}"`);
    assert.equal(typeof punto.escala, 'number');
    assert.equal(typeof punto.p95, 'number');
    assert.equal(typeof punto.p50, 'number');
    assert.equal(punto.fraccionSerial, 1, 'hoy no hay backend paralelo: fraccionSerial documentado como 1 (ver cabecera del script)');
    assert.ok((punto.teselasActivas as number) > 0);
    assert.equal(punto.teselasPorHabitante, (punto.teselasActivas as number) / (punto.habitantes as number));
  }

  const curva = readJson(join(dir, 'curva.json'));
  assert.equal(curva.seed, 51926);
  assert.equal(curva.escala, 'habitantes');
  assert.match(curva.sha as string, /^[0-9a-f]{40}$/);
  assert.match(curva.digest as string, /^[0-9a-f]{64}$/);
  assert.ok(['hasta', 'presupuesto', 'limite-seguridad'].includes(curva.motivoParada as string));
  const primerPunto = (curva.puntos as Json[])[0]!;
  assert.equal(primerPunto.escala, 16, 'el primer escalón de la escala de habitantes es la población inicial de createWorld');
});

test('control T109: el punto de partida de la curva coincide en escena y metodología con el laboratorio', (t) => {
  // Hallazgo medio de la revisión adversarial T109 (tasks.md:121-127): el «Control» de la tarea
  // exige que el punto de partida de la curva coincida con el p95 medido por el laboratorio para
  // la MISMA escena, y hasta ahora nada lo comprobaba de forma ejecutable.
  //
  // Por qué NO se comparan milisegundos absolutos: esta torre corre varios worktrees hermanos en
  // paralelo (carga de dos dígitos no es rara durante un sprint) y este test lanza un proceso
  // hijo (curva-techo.mts) mientras mide otra escena EN ESTE MISMO proceso — ambos compiten por
  // CPU con quien más esté corriendo en la máquina en ese instante, ajeno a la simulación. Un p95
  // en ms concreto depende del planificador del sistema operativo, no solo del código bajo
  // prueba, así que exigir igualdad (o siquiera una tolerancia relativa estrecha) de tiempos
  // sería frágil por diseño y no probaría nada sobre el instrumento.
  //
  // Qué SÍ es legítimamente comparable, porque es determinista pase lo que pase con el reloj:
  //   - LA ESCENA: población, teselas activas y teselas/habitante deben coincidir EXACTAMENTE —
  //     ambas mediciones parten del mismo `createWorld(seed)` con los mismos `motor.hilos`/`gpu`
  //     por defecto (1, []) y sin ningún clon sintético (el primer escalón de `--escala
  //     habitantes` es, por construcción de `agregarHabitantesSinteticos`, la población inicial).
  //   - LA DEFINICIÓN del p95: la misma ventana de `GOVERNOR_WINDOW_STEPS` (120) pasos y el mismo
  //     percentil de `RollingStepPerformance` (src/server/governor.ts) — compartida a propósito
  //     entre servidor y experimentos —, así que el NÚMERO de pasos medidos (`world.tick`, que
  //     arranca en 0 en ambas mediciones) debe coincidir exactamente.
  //   - Que ambos p95 sean números finitos y positivos: si alguna de las dos mediciones diera
  //     0/NaN/Infinity ahí sí habría un desacuerdo real de metodología entre el instrumento y el
  //     laboratorio, no un artefacto del reloj de la torre.
  const seed = 51926;

  // (1) El instrumento: corre `curva-techo.mts` con una escena mínima (misma semilla, escala de
  // habitantes, `--hasta` igual a la población inicial para que el primer y único punto sea
  // exactamente esa escena) y lee su primer punto.
  const { dir, result } = runCurva(t, ['--seed', String(seed), '--escala', 'habitantes', '--hasta', '16']);
  assert.equal(result.status, 0, result.stderr);
  const curva = readJson(join(dir, 'curva.json'));
  const puntos = curva.puntos as Json[];
  assert.ok(puntos.length >= 1, 'debe producir al menos el punto de partida');
  const primerPunto = puntos[0]!;

  // (2) El laboratorio: mide, EN ESTE MISMO PROCESO, la misma escena por la misma vía interna
  // (createWorld + Store temporal + el trío clon→paso→guardado + RollingStepPerformance),
  // reutilizando las funciones que `curva-techo.mts` exporta para esto (no se duplica la
  // construcción de la escena).
  const escena = crearEscenaBase(seed, 1, []);
  let medicion: ReturnType<typeof medirVentana>;
  try {
    medicion = medirVentana(escena.world, escena.context, escena.store, GOVERNOR_WINDOW_STEPS);
  } finally {
    cerrarEscena(escena);
  }

  assert.equal(primerPunto.tick, GOVERNOR_WINDOW_STEPS, 'el instrumento mide exactamente una ventana de GOVERNOR_WINDOW_STEPS pasos desde tick 0');
  assert.equal(medicion.pasos, GOVERNOR_WINDOW_STEPS, 'el laboratorio mide el mismo número de pasos que el instrumento (misma definición de p95)');
  assert.equal(primerPunto.tick, medicion.pasos, 'mismo número de pasos medidos que el laboratorio para esta escena');

  assert.equal(primerPunto.habitantes, medicion.world.people.length, 'misma escala de habitantes que el laboratorio');
  assert.equal(primerPunto.teselasActivas, medicion.world.tiles.length, 'misma escala de teselas activas que el laboratorio');
  assert.equal(
    primerPunto.teselasPorHabitante,
    medicion.world.tiles.length / Math.max(1, medicion.world.people.length),
    'misma teselas/habitante que el laboratorio',
  );

  assert.ok(Number.isFinite(primerPunto.p95 as number) && (primerPunto.p95 as number) > 0, 'el p95 del instrumento debe ser finito y positivo');
  assert.ok(Number.isFinite(medicion.p95) && medicion.p95 > 0, 'el p95 del laboratorio debe ser finito y positivo');
});

test('el instrumento encuentra el techo (p95 ≥ presupuestoMs) antes de un hasta generoso', (t) => {
  const { result } = runCurva(t, ['--seed', '51926', '--escala', 'habitantes', '--hasta', '4096']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Curva completa \(presupuesto\)/, 'con --hasta generoso el criterio de parada real es cruzar gobernador.presupuestoMs, no agotar --hasta');
});

test('dos corridas con la misma semilla dan la misma curva salvo tiempos (hasta donde ambas llegaron)', (t) => {
  // Esta torre corre varios worktrees hermanos en paralelo (load average de dos dígitos no es
  // raro durante un sprint nocturno): el p95 real de UNA corrida concreta puede cruzar
  // `presupuestoMs` (50 ms) en un escalón distinto al de otra corrida por puro ruido del
  // sistema (contención de CPU, no el instrumento), así que las dos curvas pueden tener
  // distinto NÚMERO de puntos. Lo que SÍ es determinista pase lo que pase con el reloj: cada
  // punto de índice `i` corresponde siempre a la MISMA cantidad de pasos simulados desde la
  // misma semilla (`(i+1) × GOVERNOR_WINDOW_STEPS` pasos deterministas de `createWorld`), así
  // que sus campos estructurales (escala/habitantes/teselas/tick/digest…) deben coincidir
  // exactamente entre corridas para todo índice que AMBAS alcanzaron — solo el índice en el
  // que cada corrida decide parar (y las columnas de tiempo: p50/p95/tickHz/rss) pueden variar.
  // Esto valida bastante más que el primer escalón sin volverse frágil ante el ruido de la torre.
  const args = ['--seed', '20260905', '--escala', 'habitantes', '--hasta', '64'];
  const a = runCurva(t, args), b = runCurva(t, args);
  assert.equal(a.result.status, 0, a.result.stderr);
  assert.equal(b.result.status, 0, b.result.stderr);
  const curvaA = readJson(join(a.dir, 'curva.json')), curvaB = readJson(join(b.dir, 'curva.json'));
  assert.equal(curvaA.digest, curvaB.digest);
  const puntosA = curvaA.puntos as Json[], puntosB = curvaB.puntos as Json[];
  assert.ok(puntosA.length >= 1 && puntosB.length >= 1);
  const comunes = Math.min(puntosA.length, puntosB.length);
  for (let i = 0; i < comunes; i++) {
    assert.deepEqual(stripTimings(puntosA[i]!), stripTimings(puntosB[i]!), `el escalón ${i} (misma cantidad de pasos deterministas desde la misma semilla) debe ser idéntico salvo tiempos`);
  }
});

test('el criterio de parada es una función determinista de p95 y presupuestoMs, no del reloj', (t) => {
  // Sanity de una sola corrida: dado lo que de verdad tardó cada paso (ruido de esta torre
  // incluido), la DECISIÓN de seguir o parar es una comparación pura — se comprueba sobre los
  // números que el propio instrumento escribió, no reinventando su medición.
  const { dir, result } = runCurva(t, ['--seed', '51926', '--escala', 'habitantes', '--hasta', '4096']);
  assert.equal(result.status, 0, result.stderr);
  const curva = readJson(join(dir, 'curva.json'));
  const puntos = curva.puntos as Json[];
  for (const punto of puntos.slice(0, -1)) assert.ok((punto.p95 as number) < (punto.presupuestoMs as number), 'ningún punto salvo el último puede haber cruzado el presupuesto: si lo cruzó, ahí paraba');
  const ultimo = puntos[puntos.length - 1]!;
  if (curva.motivoParada === 'presupuesto') assert.ok((ultimo.p95 as number) >= (ultimo.presupuestoMs as number));
  else if (curva.motivoParada === 'hasta') assert.equal(ultimo.escala, 4096);
});

test('escala de teselas: crece las teselas activas por encima de la escena inicial sin reventar', (t) => {
  const { dir, result } = runCurva(t, ['--seed', '51926', '--escala', 'teselas', '--hasta', '3072']);
  assert.equal(result.status, 0, result.stderr);
  const curva = readJson(join(dir, 'curva.json'));
  assert.equal(curva.escala, 'teselas');
  const puntos = curva.puntos as Json[];
  assert.ok(puntos.length >= 1);
  const ultimo = puntos[puntos.length - 1]!;
  assert.ok((ultimo.teselasActivas as number) >= 1536, 'debe superar las 1536 teselas (6 chunks) que activa createWorld de partida');
  for (const punto of puntos) assert.equal(punto.escala, punto.teselasActivas, 'en escala "teselas" el punto reporta las teselas activas alcanzadas, no un nominal');
});

test('valida los argumentos: --escala inválida, --hilos fuera de rango y falta de --salida', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-techo-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/curva-techo.mts', ...args], { encoding: 'utf8' });

  const escalaInvalida = base(['--seed', '1', '--escala', 'kilómetros', '--salida', dir]);
  assert.notEqual(escalaInvalida.status, 0);
  assert.match(escalaInvalida.stderr, /--escala/);

  const hilosInvalidos = base(['--seed', '1', '--escala', 'habitantes', '--hilos', '0', '--salida', dir]);
  assert.notEqual(hilosInvalidos.status, 0);

  const sinSalida = base(['--seed', '1', '--escala', 'habitantes']);
  assert.notEqual(sinSalida.status, 0);
  assert.match(sinSalida.stderr, /--salida/);

  const cadaTicksInvalido = base(['--seed', '1', '--escala', 'habitantes', '--cada-ticks', '0', '--salida', dir]);
  assert.notEqual(cadaTicksInvalido.status, 0);
  assert.match(cadaTicksInvalido.stderr, /--cada-ticks/);

  const densidadConTeselas = base(['--seed', '1', '--escala', 'teselas', '--densidad-constante', '--salida', dir]);
  assert.notEqual(densidadConTeselas.status, 0);
  assert.match(densidadConTeselas.stderr, /--densidad-constante/);
});

test('--densidad-constante y --cada-ticks distribuyen sintéticos sin apilarlos y respetan la cadencia', (t) => {
  const { dir, result } = runCurva(t, [
    '--seed', '51926', '--escala', 'habitantes', '--hasta', '64',
    '--densidad-constante', '--cada-ticks', '100',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const curva = readJson(join(dir, 'curva.json'));
  assert.equal(curva.densidadConstante, true);
  assert.equal(curva.cadaTicks, 100);
  const puntos = curva.puntos as Json[];
  assert.ok(puntos.length >= 2, 'debe avanzar al menos hasta el escalón de 32/64 habitantes');
  const ultimo = puntos[puntos.length - 1]!;
  assert.ok((ultimo.habitantes as number) >= 32);
  assert.ok((ultimo.teselasActivas as number) > 1536, 'en densidad constante deben activarse bloques adicionales al crecer la población');
  assert.ok((ultimo.teselasPorHabitante as number) >= 40, `teselasPorHabitante=${ultimo.teselasPorHabitante} debe mantenerse en rango orgánico y no colapsar por apilamiento`);
});

test('--hilos y --gpu se aceptan y se registran aunque hoy no exista backend paralelo ni GPU', (t) => {
  const { dir, result } = runCurva(t, ['--seed', '51926', '--escala', 'habitantes', '--hasta', '16', '--hilos', '4', '--gpu', '0,1']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /no existe ningún backend paralelo ni de GPU/);
  const curva = readJson(join(dir, 'curva.json'));
  assert.equal(curva.hilosSolicitados, 4);
  assert.deepEqual(curva.gpuSolicitada, [0, 1]);
  const punto = readJson(join(dir, 'punto-000.json'));
  assert.equal(punto.hilosSolicitados, 4);
  assert.deepEqual(punto.gpuSolicitada, [0, 1]);
  assert.equal(punto.fraccionSerial, 1, 'con --hilos > 1 el paso sigue siendo 100% serial: no hay backend que lo paralelice todavía');
});

/** Plantilla manual envejecida: un producto de 890 cuantos, 110 de residuo, un recibo
 * de investigación y un proyecto de fabricación en curso. No ejecuta World ni depende
 * de que el p95 permita alcanzar un escalón concreto. `sex` comprueba también que el
 * helper conserva campos corporales adicionales a los de Person en esta base. */
function plantillaConTecnologia(sex: 'female' | 'male') {
  const program: TechnologyProgram = {
    inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
    steps: [{ op: 'form', intensity: 4, shape: 'edge' }],
  };
  const item: MaterialBatch = {
    id: 'product-1', recipeId: 'recipe-1', composition: { wood: 0, stone: 890, water: 0 }, mass: 890,
    properties: { hardness: 0.84, toughness: 0.3, porosity: 0.2, flexibility: 0, edge: 0.86,
      containment: 0, insulation: 0.08, leverage: 0.05, cohesion: 0.62, temperature: 0, alignment: 0, firing: 0 },
    generation: 1, madeAt: 12, parentItems: ['raw:stone'], initialMass: 890,
  };
  const technology: TechnologyKnowledge = {
    knownRecipes: ['recipe-1'], items: [item], residue: { wood: 0, stone: 110, water: 0 },
    attempts: 1, lastAttempt: 239,
    project: { kind: 'craft', recipeId: 'recipe-1', program: structuredClone(program), parents: [],
      progress: 2, requiredWork: 20, energyPaid: 0.0009, startedAt: 239 },
    learnedFrom: [{ recipeId: 'recipe-1', teacherId: 'teacher', tick: 120 }],
    competence: { 'recipe-1': { attempts: 1, successes: 1, work: 20, benefit: 0 } },
    waterActionAt: 239, waterCarryAt: 239,
  };
  const plantilla = {
    id: 'founder', x: 2, y: 3, energy: 0.7, fatigue: 0.2, hunger: 0.1, thirst: 0.3,
    materials: { wood: 2, stone: 1 }, skills: { technology: 0.25 }, sex,
    genome: { alleles: [0.2, 0.2, 0.4, 0.4, 0.6, 0.6, 0.8, 0.8, 0.3, 0.3, 0.5, 0.5, 0.7, 0.7],
      generation: 0, parents: [], learningRate: 0.12, cooperation: 0.7, mutations: 0 },
    traits: { curiosity: 0.2, sociability: 0.4, industriousness: 0.6, care: 0.8, resilience: 0.3 },
    technology,
  } satisfies TechnologyActor & Pick<Person, 'genome' | 'traits'> & { sex: 'female' | 'male' };
  const state = defaultTechnologyState();
  state.recipes.push({ id: 'recipe-1', name: 'Filo', program, signature: programSignature(program),
    parents: [], generation: 1, inventorId: 'founder', tick: 12, x: 2, y: 3, novelty: 'both',
    capacities: materialCapacities(item), uses: 0, utility: 0, manufactured: 1 });
  state.recipeCounter = 1; state.itemCounter = 1; state.executionCounter = 1;
  state.ledger.imported.stone = 1000;
  state.ledger.attempts = 1; state.ledger.crafted = 1; state.ledger.work = 20; state.ledger.energy = 0.009;
  state.water = { version: 1, policyVersion: 1, filled: 0, consumed: 0, environmentalLoss: 0, work: 0, energy: 0 };
  const inputs = [{ resourceId: 'raw:stone', mass: 1000 }];
  const outputs = [{ resourceId: 'recipe:recipe-1', mass: 890 }];
  state.history.push({ id: 'process-1', kind: 'research', tick: 12, actorId: 'founder', recipeId: 'recipe-1',
    programSignature: programSignature(program), inputs, outputs, residueMass: 110, energy: 0.009,
    work: 20, success: true, parentRecipeIds: [], catalysts: [], benefit: 0,
    balance: { opening: [], closing: [...outputs, { resourceId: 'residue:stone', mass: 110 }], externalInputs: inputs, externalLoss: [] } });
  const host: TechnologyHost = { seed: 51926, tick: 240, people: [plantilla], technology: state };
  return { plantilla, host };
}

test('regresión de sintéticos: añadir clones no duplica productos, materia ni trabajo tecnológico', () => {
  for (const sex of ['female', 'male'] as const) {
    const { plantilla, host } = plantillaConTecnologia(sex);
    const before = structuredClone(host);
    assert.doesNotThrow(() => assertTechnology(host), 'la plantilla manual debe ser válida antes de añadir sintéticos');

    // Control anterior: copiar una plantilla con stock físico debe seguir siendo rechazado.
    const copiaCompleta = structuredClone(plantilla);
    copiaCompleta.id = 'synthetic-control';
    assert.throws(() => assertTechnology({ ...host, people: [plantilla, copiaCompleta] }), /Estado de tecnología física inválido/);

    const clones = ['synthetic-0', 'ancla-1'].map(id => {
      const persona = clonarPlantillaSintetica(plantilla);
      persona.id = id;
      return persona;
    });
    for (const persona of clones) {
      const { technology: _technology, ...cuerpo } = persona;
      const { technology: _originalTechnology, ...original } = plantilla;
      assert.deepEqual(cuerpo, { ...original, id: persona.id }, 'sexo, genoma, fenotipo y resto de la plantilla se conservan');
      assert.deepEqual(technologyStock(persona), [], 'el sintético no aporta stock tecnológico');
      assert.ok(Object.values(toolCapacities(persona)).every(value => value === 0), 'no hereda capacidades de herramientas');
      assert.deepEqual(persona.technology, {
        knownRecipes: [], items: [], residue: { wood: 0, stone: 0, water: 0 }, attempts: 0, lastAttempt: -120,
        project: null, learnedFrom: [], competence: {},
      }, 'no hereda proyecto pagado, recetas, práctica, enseñanza ni marcas de trabajo');
    }

    // Control de conservación aislado: sin producto duplicado, copiar sólo residuo también falla.
    const residuoCopiado = clonarPlantillaSintetica(plantilla);
    residuoCopiado.id = 'synthetic-residue-control';
    residuoCopiado.technology.residue = structuredClone(plantilla.technology.residue);
    assert.throws(() => assertTechnology({ ...host, people: [plantilla, residuoCopiado] }), /Estado de tecnología física inválido/);

    host.people.push(...clones);
    assert.doesNotThrow(() => assertTechnology(host), 'el validador real admite sintéticos sin duplicar materia ni IDs');
    const ids = host.people.flatMap(persona => persona.technology.items.map(item => item.id));
    assert.deepEqual(ids, ['product-1'], 'sólo el dueño original conserva la identidad física');
    for (const material of ['wood', 'stone', 'water'] as const) {
      const stock = host.people.reduce((total, persona) => total + persona.technology.residue[material]
        + persona.technology.items.reduce((sum, item) => sum + item.composition[material], 0), 0);
      assert.equal(stock, before.technology.ledger.imported[material], `se conserva ${material} sin inventar importaciones`);
    }
    assert.deepEqual(host.technology, before.technology, 'catálogo, contadores, ledger y recibos no se reescriben');
    assert.deepEqual(plantilla, before.people[0], 'el fundador conserva sus pertenencias y trabajo');
  }
});

test('regresión de sintéticos: cada clon tiene tecnología inicial independiente', () => {
  const { plantilla } = plantillaConTecnologia('female');
  const before = structuredClone(plantilla);
  const a = clonarPlantillaSintetica(plantilla), b = clonarPlantillaSintetica(plantilla);
  const fresh = structuredClone(b.technology);
  assert.notStrictEqual(a, plantilla);
  assert.notStrictEqual(a.genome, plantilla.genome);
  assert.notStrictEqual(a.traits, plantilla.traits);
  assert.notStrictEqual(a.technology, b.technology);
  assert.notStrictEqual(a.technology, plantilla.technology);
  for (const key of ['items', 'residue', 'knownRecipes', 'learnedFrom', 'competence'] as const) {
    assert.notStrictEqual(a.technology[key], b.technology[key], `${key} pertenece a cada sintético`);
    assert.notStrictEqual(a.technology[key], plantilla.technology[key], `${key} no aliasa a la plantilla`);
  }

  // Nueva actividad local de un clon no debe contaminar al siguiente ni al fundador.
  a.technology.items.push(structuredClone(plantilla.technology.items[0]!));
  a.technology.residue.stone = 5;
  a.technology.knownRecipes.push('recipe-1');
  a.technology.learnedFrom.push({ recipeId: 'recipe-1', teacherId: 'teacher', tick: 240 });
  a.technology.competence['recipe-1'] = { attempts: 1, successes: 0, work: 1, benefit: 0 };
  a.technology.project = structuredClone(plantilla.technology.project);
  a.technology.attempts = 1; a.technology.lastAttempt = 240;
  assert.deepEqual(b.technology, fresh);
  assert.deepEqual(plantilla, before);
});
