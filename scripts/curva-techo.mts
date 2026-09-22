/**
 * T109 — el instrumento que mide el techo.
 *
 * Hace crecer la escala del mundo (`--escala habitantes|teselas`) hasta que el p95 del paso,
 * medido sobre una ventana de `GOBERNADOR_WINDOW_STEPS` (120) pasos — la MISMA ventana y el
 * MISMO percentil que usa el gobernador de producción (`src/server/governor.ts`, cuyo
 * comentario dice explícitamente que `RollingStepPerformance` está para compartirse con
 * experimentos) — toca `gobernador.presupuestoMs`. Escribe un fichero JSON por punto y un
 * resumen `curva.json`. Cierra SC-003, SC-004 y SC-013 en todas las etapas (T109).
 *
 * Args: `--seed S --hilos N --gpu "0,1" --escala habitantes|teselas --hasta N --salida <dir>`.
 *
 * Por qué SIEMPRE hay un `Store` (igual que `scripts/lab/replica.ts`, P3 de
 * `docs/REVISION-2026-09-19.md`): sin `Store` la catalogación de tecnología es OTRA física
 * (`registerTechnologyRecipe` revienta al llegar a `budgets.maxRecipes` en vez de podar), y
 * `persistencia.cadaTicks` (por defecto 1, GUARDA EN CADA PASO en producción, ver
 * `scripts/lab/README.md` §Rendimiento) es justo lo que hace que "el paso" que mide el
 * gobernador (`runtime.stepMs` en `src/server/app.ts:stepOnce`) incluya clon + simulación +
 * guardado, no solo el cálculo del mundo. Medir sin ese coste sería medir un servidor que no
 * existe. Por eso este instrumento reproduce el mismo trío clon→paso→guardado (condicionado a
 * `tick % persistencia.cadaTicks === 0`, igual que `app.ts`) en vez de llamar `stepWorld` a
 * secas.
 *
 * `--hilos`/`--gpu` se ACEPTAN y se REGISTRAN en `motor.hilos`/`motor.gpu` (T102, reservados
 * desde hoy) y en el punto/`curva.json`, pero ningún backend paralelo ni de GPU existe todavía
 * en `stepWorld`: el paso corre 100 % serial sea cual sea el valor pedido. `fraccionSerial` es
 * por eso `1` en cada punto — no una medición de fases (esa la trae T107 con
 * `runtime.fases`/`performance.fases`, que este árbol —partido de `694f6b6`— aún no tiene
 * integrado); cuando T107 aterrice en el Gate A y, más adelante, un backend paralelo real
 * exista, este campo debe leer esa instrumentación en vez de la constante de hoy.
 *
 * Escala de habitantes: los sintéticos son CLONES ESTRUCTURALES de un fundador vivo
 * (generación 0, sin padres) del propio `createWorld` — la «misma vía que usa createWorld»
 * que puede reutilizarse desde fuera de `src/world` sin exportar una fábrica nueva de
 * personas: se reutiliza un `Person` que YA construyó `createWorld` con sus leyes reales
 * (genoma, cultura, tecnología, demografía) y solo se le cambian identidad y posición.
 * Colocados exactamente sobre las posiciones de los 14 fundadores «neighbor» (walkable por
 * construcción, ya las validó `createWorld`; nada exige exclusividad de tesela entre
 * personas), nunca en coordenadas propias: una posición inventada podría caer en agua
 * (`assertCommon` exige `walkable`, no solo pertenecer a un chunk activo) y, al no activar
 * chunks nuevos, mantiene aislado el eje de escala de habitantes del de teselas.
 * `world.reproductionEnabled = false` desde el arranque: el instrumento
 * decide la escala explícitamente, la reproducción orgánica (que sí mide
 * `scripts/curva-poblacion.mts`) solo metería ruido de emparejamiento no determinista.
 *
 * Escala de teselas: los sintéticos son «anclas» del mismo tipo, separadas 3 chunks entre sí
 * y centradas en su chunk, para que el bloque de hasta 3×3 chunks que `maintainRegions`
 * mantiene vivo alrededor de cada persona (T111 lo llama «activación», radio compuesto ~13)
 * no se solape con el de la vecina. Activar chunks sin una persona cerca no sirve: el mismo
 * `maintainRegions` los retira en el siguiente paso si no hay nadie a menos de 8 teselas.
 * El «calentamiento» de cada ancla llama a `maintainRegions` DIRECTAMENTE (no
 * `cloneWorld`+`stepWorld`, hallazgo de revisión adversarial, confirmado): es una función pura
 * de `world.people` que solo activa/retira chunks — no toca `world.tick` ni corre ecología,
 * fauna, hambre o senescencia — así que activar cientos de anclas para llegar a 65536 teselas
 * no envejece ni un tick a los fundadores reales ('S'/'I') ni a las anclas ya puestas.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/server/store.js';
import { GOVERNOR_WINDOW_STEPS, RollingStepPerformance } from '../src/server/governor.js';
import { cloneWorld, createWorld, stepWorld, tileAt, type Person, type World } from '../src/world/index.js';
import { paramsOf, DEFAULT_PARAMS, type WorldParams } from '../src/world/params.js';
import { maintainRegions, type WorldContext } from '../src/world/spatial.js';

/** Hoy no hay ninguna fase paralelizable implementada (T102 es config reservada): el paso
 * entero corre en un solo hilo. Ver la nota de cabecera sobre T107. */
const FRACCION_SERIAL_HOY = 1;
/** Chunks entre el centro de un ancla y el de la siguiente (escala de teselas): 3 evita que
 * los bloques 3×3 que cada una mantiene viva se solapen. */
const SEPARACION_ANCLAS_CHUNKS = 3;
const COLUMNAS_ANCLAS = 64; // ancho de la cuadrícula de anclas; solo importa que quepa en MAX_COORDINATE

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Igual fórmula que `scripts/lab/replica.ts`: p50/p95 de una ventana de muestras reales. */
function distribution(samples: readonly number[]): { p50: number; p95: number } {
  if (!samples.length) return { p50: 0, p95: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return { p50: sorted[Math.floor(sorted.length * 0.5)]!, p95: sorted[Math.floor(sorted.length * 0.95)]! };
}

/** sha256 de los `.ts` de `src/world` (nombre + contenido, ordenados) — igual que replica.ts. */
function worldSourceDigest(): string {
  const dir = 'src/world', hash = createHash('sha256');
  for (const name of readdirSync(dir).filter(f => f.endsWith('.ts')).sort()) hash.update(name).update('\0').update(readFileSync(join(dir, name)));
  return hash.digest('hex');
}

/** `role: 'neighbor'` explícito: `world.people[0]`/`[1]` ('S'/'I') también son generación 0,
 * pero `assertCommon` exige EXACTAMENTE una persona con cada rol — clonarlos duplicaría 'S'/'I'. */
function founderTemplate(world: World): Person {
  const founder = world.people.find(p => p.genome.generation === 0 && p.role === 'neighbor');
  if (!founder) throw new Error('No hay ningún fundador vecino (generación 0, rol "neighbor") del que clonar sintéticos.');
  return founder;
}

/** Deja `persona` sin vínculos ni historia propia: un clon estructural, no un miembro social. */
function desvincular(persona: Person, x: number, y: number): void {
  persona.x = x; persona.y = y; persona.target = { x, y };
  persona.bonds = {}; persona.communityId = null;
  persona.experiences = []; persona.habits = []; persona.visited = [];
}

/** Añade clones hasta llegar a `objetivo` habitantes, todos sobre posiciones YA ocupadas por
 * fundadores reales (walkable por construcción: `createWorld` las generó y las validó al
 * nacer) — evita generar coordenadas propias que podrían caer en agua (`assertCommon` exige
 * `walkable(world, persona)`, no solo una tesela dentro de la región) y no activa chunks
 * nuevos: aísla el eje «habitantes» del eje «teselas». Varias personas comparten tesela sin
 * problema: nada en las reglas exige exclusividad de casilla. */
function agregarHabitantesSinteticos(world: World, objetivo: number, contador: { n: number }): void {
  if (world.people.length >= objetivo) return;
  const plantilla = founderTemplate(world);
  const posiciones = world.people.filter(p => p.genome.generation === 0).map(p => ({ x: p.x, y: p.y }));
  while (world.people.length < objetivo) {
    const n = contador.n++;
    const persona = structuredClone(plantilla);
    persona.id = `synthetic-${n}`;
    const destino = posiciones[n % posiciones.length]!;
    desvincular(persona, destino.x, destino.y);
    world.people.push(persona);
  }
}

function coordenadaAncla(indice: number): { x: number; y: number } {
  const cx = (indice % COLUMNAS_ANCLAS) * SEPARACION_ANCLAS_CHUNKS, cy = Math.floor(indice / COLUMNAS_ANCLAS) * SEPARACION_ANCLAS_CHUNKS;
  return { x: cx * 16 + 8, y: cy * 16 + 8 }; // +8: centro del chunk, para que el muestreo ±8 de maintainRegions caiga en el bloque 3×3 propio
}

/** Primera tesela transitable (`terrain !== 'water'`) en anillos crecientes alrededor de
 * `(cx,cy)` — el chunk ya está activo (se llama tras el calentamiento), así que sus 256
 * teselas existen; solo su terreno procedural puede no ser tierra en el centro exacto. */
function buscarTeselaCaminable(world: World, cx: number, cy: number): { x: number; y: number } {
  for (let r = 0; r <= 11; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    const x = cx + dx, y = cy + dy, tile = tileAt(world, { x, y });
    if (tile && tile.terrain !== 'water') return { x, y };
  }
  throw new Error(`No se encontró tesela transitable cerca de (${cx},${cy}) tras activar su chunk.`);
}

/** Añade anclas hasta que `world.tiles.length` (teselasActivas) llegue a `objetivo`; cada
 * ancla necesita un «calentamiento» para que `maintainRegions` active su bloque — a diferencia
 * de la escala de habitantes, aquí SÍ es el efecto que se busca. El calentamiento llama a
 * `maintainRegions(world, context)` directamente (no `cloneWorld`+`stepWorld`): es la misma
 * función que usa `stepWorld` internamente, pero sola no avanza `world.tick` ni corre ecología,
 * fauna, hambre o senescencia — así que ninguna ancla ni fundador envejece un solo tick por el
 * calentamiento, sea cual sea la escala alcanzada. Como no hay clon, `actual` se muta en el
 * sitio (igual que ya hace `agregarHabitantesSinteticos` con `world.people`) y el objeto
 * `ancla` sigue siendo la misma referencia tras activarse, sin falta de buscarla por id. Tras
 * activar su bloque, la ancla se reubica a la primera tesela transitable del propio bloque (su
 * centro exacto puede haber caído en agua). Devuelve el mundo vigente (el mismo `world`, mutado). */
function agregarAnclasSinteticas(world: World, objetivo: number, contador: { n: number }, context: WorldContext): World {
  let guardia = 0;
  const TOPE_GUARDIA = 20_000; // una ancla activa hasta 9 chunks (2304 teselas): de sobra para 65536
  while (world.tiles.length < objetivo) {
    if (++guardia > TOPE_GUARDIA) throw new Error(`No se alcanzaron ${objetivo} teselas tras ${TOPE_GUARDIA} anclas; revisar la geometría de activación.`);
    const plantilla = founderTemplate(world);
    const n = contador.n++;
    const { x, y } = coordenadaAncla(n);
    const ancla = structuredClone(plantilla);
    ancla.id = `ancla-${n}`;
    desvincular(ancla, x, y);
    world.people.push(ancla);
    maintainRegions(world, context);
    const destino = buscarTeselaCaminable(world, x, y);
    if (destino.x !== ancla.x || destino.y !== ancla.y) desvincular(ancla, destino.x, destino.y);
  }
  return world;
}

/**
 * ---------------------------------------------------------------------------------------------
 * Reutilizable por tests (hallazgo medio de la revisión adversarial T109, `tasks.md:121-127`):
 * «Falta un test ejecutable del control: el punto de partida de la curva coincide con el p95
 * medido por el laboratorio para la misma escena». `crearEscenaBase` + `medirVentana` son
 * EXACTAMENTE los dos bloques que arma `main()` para el primer escalón de `--escala habitantes`
 * (sin ningún habitante sintético añadido todavía: `agregarHabitantesSinteticos` no hace nada
 * cuando `objetivo` ya es `world.people.length`, o sea que la escena de partida ES la población
 * inicial de `createWorld`). Exportarlos evita que un test que quiera comparar «el punto de
 * partida de la curva» contra «lo que mide el laboratorio para la misma escena» tenga que
 * reconstruir la escena por su cuenta y arriesgarse a divergir de `main()` con el tiempo.
 * ---------------------------------------------------------------------------------------------
 */

export interface EscenaBase { world: World; store: Store; context: WorldContext; dataDir: string; }

/** Misma construcción que hace `main()` antes de la corrida: `Store` SQLite temporal (P3, ver
 * cabecera del fichero), `createWorld(seed, params)` con `motor.hilos`/`motor.gpu` fijados,
 * reproducción desactivada (la decide el instrumento/quien mida, no el emparejamiento orgánico) y
 * un primer `store.save(world)` que fija la catalogación de tecnología y liga el `WorldContext` —
 * es la escena EXACTA del primer punto de la curva de `--escala habitantes`. Llamar a
 * `cerrarEscena` cuando termine. */
export function crearEscenaBase(seed: number, hilos = 1, gpu: number[] = []): EscenaBase {
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-techo-'));
  process.env.CARTA_DATA_DIR = dataDir;
  const store = new Store(join(dataDir, 'world.sqlite'));
  const params: WorldParams = { ...DEFAULT_PARAMS, motor: { ...DEFAULT_PARAMS.motor, hilos, gpu } };
  const world = createWorld(seed, params);
  world.reproductionEnabled = false;
  store.save(world);
  return { world, store, context: store.context, dataDir };
}

/** Cierra el `Store` y borra el directorio temporal de `crearEscenaBase`. */
export function cerrarEscena(escena: EscenaBase): void {
  escena.store.close();
  rmSync(escena.dataDir, { recursive: true, force: true });
}

export interface VentanaMedida { world: World; p50: number; p95: number; pasos: number; }

/** Mide `pasos` pasos con el MISMO trío clon→paso→guardado condicionado a `persistencia.cadaTicks`
 * que usa el bucle interno de `main()` (y que reproduce `stepOnce` de `src/server/app.ts`: «el
 * paso» que el gobernador mide incluye clon + simulación + guardado, no solo el cálculo del
 * mundo — ver cabecera del fichero), acumulando en una `RollingStepPerformance` NUEVA e
 * independiente (`src/server/governor.ts`, compartida a propósito entre servidor y experimentos).
 * Con `pasos === GOVERNOR_WINDOW_STEPS` el `p95` devuelto es exactamente el que calcularía un
 * escalón de la curva sobre la misma escena: la ventana rodante tiene ese mismo tamaño, así que
 * `pasos` medidas frescas la llenan por completo sin depender de ninguna historia previa. */
export function medirVentana(world: World, context: WorldContext, store: Store, pasos: number): VentanaMedida {
  const rolling = new RollingStepPerformance();
  let actual = world, p95 = 0;
  const tiempos: number[] = [];
  for (let i = 0; i < pasos; i++) {
    const started = performance.now();
    const draft = cloneWorld(actual, context);
    stepWorld(draft, [], context);
    if (draft.tick % paramsOf(draft).persistencia.cadaTicks === 0) store.save(draft);
    actual = draft;
    const stepMs = performance.now() - started;
    tiempos.push(stepMs);
    p95 = rolling.record(stepMs);
  }
  const { p50 } = distribution(tiempos);
  return { world: actual, p50: Math.round(p50 * 100) / 100, p95: Math.round(p95 * 100) / 100, pasos: rolling.count };
}

interface Punto {
  escala: number; habitantes: number; teselasActivas: number; teselasPorHabitante: number;
  p50: number; p95: number; tickHz: number; rss: number; fraccionSerial: number;
  presupuestoMs: number; hilosSolicitados: number; gpuSolicitada: number[]; tick: number;
}

async function main(): Promise<void> {
  const seed = Number(arg('--seed') ?? 51926);
  const hilos = Number(arg('--hilos') ?? 1);
  const gpuArg = arg('--gpu');
  const escala = arg('--escala');
  const hastaArg = arg('--hasta');
  const salida = arg('--salida');
  const uso = 'Uso: --seed N --hilos N --gpu "0,1" --escala habitantes|teselas --hasta N --salida <dir>.';
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`${uso} (seed entero ≥ 0).`);
  if (!Number.isInteger(hilos) || hilos < 1 || hilos > 512) throw new Error(`${uso} (hilos entero en [1,512]; motor.hilos, T102, no tiene backend todavía).`);
  const gpu = gpuArg ? gpuArg.split(',').map(s => {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n < 0) throw new Error(`${uso} (--gpu es una lista de índices enteros ≥ 0 separados por comas).`);
    return n;
  }) : [];
  if (escala !== 'habitantes' && escala !== 'teselas') throw new Error(`${uso} (--escala es "habitantes" o "teselas").`);
  const hasta = hastaArg === undefined ? undefined : Number(hastaArg);
  if (hasta !== undefined && (!Number.isInteger(hasta) || hasta < 1)) throw new Error(`${uso} (--hasta es un entero ≥ 1).`);
  if (!salida) throw new Error(`${uso} (falta --salida).`);
  if (hilos > 1 || gpu.length > 0) console.warn(`AVISO: --hilos ${hilos} / --gpu [${gpu.join(',')}] se registran en motor.hilos/motor.gpu (T102) pero HOY no existe ningún backend paralelo ni de GPU: el paso corre 100 % serial en 1 hilo.`);
  mkdirSync(salida, { recursive: true });

  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-techo-'));
  process.env.CARTA_DATA_DIR = dataDir;
  const store = new Store(join(dataDir, 'world.sqlite'));
  try {
    const params: WorldParams = { ...DEFAULT_PARAMS, motor: { ...DEFAULT_PARAMS.motor, hilos, gpu } };
    let world = createWorld(seed, params);
    world.reproductionEnabled = false; // la escala la decide el instrumento, no el emparejamiento orgánico (ver cabecera)
    // P3 (igual que replica.ts): guardar ANTES de simular fija la catalogación de producción y
    // ata el WorldContext (loadChunk/catalogueReader) al mundo.
    store.save(world);
    const context = store.context;

    const contador = { n: 0 };
    const rolling = new RollingStepPerformance();
    const puntos: Punto[] = [];
    let objetivo = escala === 'habitantes' ? world.people.length : world.tiles.length;
    const topeSeguridad = escala === 'habitantes' ? 2_000_000 : DEFAULT_PARAMS.limites.teselasActivas;
    let motivoParada = '';

    for (;;) {
      if (escala === 'habitantes') agregarHabitantesSinteticos(world, objetivo, contador);
      else world = agregarAnclasSinteticas(world, objetivo, contador, context);

      const tiempos: number[] = [], beats: number[] = [];
      let p95 = 0;
      for (let i = 0; i < GOVERNOR_WINDOW_STEPS; i++) {
        const started = performance.now();
        beats.push(started); if (beats.length > GOVERNOR_WINDOW_STEPS) beats.shift();
        // Mismo trío que `stepOnce` en `src/server/app.ts`: clon, paso, guardado condicionado a
        // la cadencia — «el paso» que el gobernador mide incluye los tres, no solo el cálculo.
        const draft = cloneWorld(world, context);
        stepWorld(draft, [], context);
        if (draft.tick % paramsOf(draft).persistencia.cadaTicks === 0) store.save(draft);
        world = draft;
        const stepMs = performance.now() - started;
        tiempos.push(stepMs);
        p95 = rolling.record(stepMs);
      }
      const { p50 } = distribution(tiempos);
      // `span` es el tiempo de pared para completar los `beats.length` pasos enteros: desde el
      // arranque del primero hasta el FIN del último (arranque + su propia duración), no hasta
      // el arranque del último — eso dejaría fuera la duración del paso más reciente y sesgaría
      // `tickHz` al alza (hallazgo de revisión adversarial, confirmado: ~0,8 % en una ventana de
      // 120 pasos de ~30 ms). `tickHz` es entonces pasos / tiempo-de-pared-total de esos pasos.
      const span = beats.length > 0 ? beats[beats.length - 1]! + tiempos[tiempos.length - 1]! - beats[0]! : 0;
      const tickHz = span > 0 ? beats.length * 1000 / span : 0;
      const presupuestoMs = paramsOf(world).gobernador.presupuestoMs;
      const habitantes = world.people.length, teselasActivas = world.tiles.length;
      const punto: Punto = {
        escala: escala === 'habitantes' ? habitantes : teselasActivas,
        habitantes, teselasActivas, teselasPorHabitante: teselasActivas / Math.max(1, habitantes),
        p50: Math.round(p50 * 100) / 100, p95: Math.round(p95 * 100) / 100, tickHz: Math.round(tickHz * 100) / 100,
        rss: process.memoryUsage().rss, fraccionSerial: FRACCION_SERIAL_HOY,
        presupuestoMs, hilosSolicitados: hilos, gpuSolicitada: gpu, tick: world.tick,
      };
      puntos.push(punto);
      writeFileSync(join(salida, `punto-${String(puntos.length - 1).padStart(3, '0')}.json`), JSON.stringify(punto, null, 2) + '\n');
      console.log(`escala=${punto.escala} habitantes=${habitantes} teselas=${teselasActivas} p50=${punto.p50}ms p95=${punto.p95}ms presupuesto=${presupuestoMs}ms tesela/hab=${punto.teselasPorHabitante.toFixed(2)}`);

      if (p95 >= presupuestoMs) { motivoParada = 'presupuesto'; break; }
      const siguiente = objetivo * 2;
      if (hasta !== undefined && objetivo >= hasta) { motivoParada = 'hasta'; break; }
      if (siguiente > topeSeguridad) { motivoParada = 'limite-seguridad'; break; }
      objetivo = hasta !== undefined ? Math.min(siguiente, hasta) : siguiente;
    }
    store.save(world);

    const curva = {
      seed, escala, hilosSolicitados: hilos, gpuSolicitada: gpu,
      presupuestoMs: paramsOf(world).gobernador.presupuestoMs, motivoParada,
      sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      digest: worldSourceDigest(), puntos,
    };
    writeFileSync(join(salida, 'curva.json'), JSON.stringify(curva, null, 2) + '\n');
    console.log(`Curva completa (${motivoParada}): ${puntos.length} punto(s). Salida: ${salida}`);
  } finally { store.close(); rmSync(dataDir, { recursive: true, force: true }); }
}

// Guarda de "ejecutado directamente" (hallazgo de la revisión adversarial T109, al exportar
// `crearEscenaBase`/`medirVentana`/`cerrarEscena` para `tests/curva-techo.test.ts`): sin esto,
// el simple `import` del módulo desde un test ejecutaría TAMBIÉN `main()` contra el `argv` del
// proceso de test (que no trae `--escala`/`--salida`), imprimiendo el mensaje de uso y dejando
// `process.exitCode = 1` aunque todos los tests declarados pasen. `realpathSync` normaliza
// symlinks/relativos de `process.argv[1]` (p.ej. `scripts/curva-techo.mts` al invocarse con
// `--import tsx scripts/curva-techo.mts ...`, como hacen los tests de este fichero) antes de
// comparar con la URL de este propio módulo.
const invocadoDirectamente = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invocadoDirectamente) main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
