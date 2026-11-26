import type { World, WorldContext } from './tipos.js';
import { applyGesture, advanceWhispers } from '../actuar/gestos.js';
import { ecology } from './ecologia.js';
import { phaseAt, addEvent, remember, deathContext } from './crear.js';
import { decideConCerebro, prepararCerebros, puntuacionesPercibidas } from '../decision/politica-persona.js';
import { percepcionDe, type Vencidos } from '../decision/percepcion.js';
import { PLAN } from '../decision/planes.js';
import { bodyAndAction } from '../actuar/cuerpo.js';
import { encounters } from '../actuar/interacciones.js';
import { transferEstate } from '../demografia/morir.js';
import { reproduce } from '../demografia/nacer.js';
import type { FaseNombre, Gesture, GestureResult } from '../../shared/types.js';
import { worldContext, bindWorldContext, maintainRegions } from '../spatial.js';
import { captureTechnologyCheckpoint, advanceTechnologyCheckpoint } from '../technology-checkpoint.js';
import { withArchiveReadBatch, withRecipeSession, catalogueEnabled } from '../technology-catalogue.js';
import { conRejilla } from '../rejilla.js';
import { conRejillaFauna, stepAnimals } from '../animals.js';
import { INTERVALO_ECOLOGIA_TICKS } from '../ecologia-constantes.js';
import { paramsOf } from '../params.js';
import { gpuNvrtcAvailable } from '../gpu/puente.js';
import { stepEcosystem } from '../ecosystem.js';
import { stepStructures } from '../inventions.js';
import { tileLookup } from '../tile-index.js';
import { residentFastAccess } from '../soa/terreno.js';
import { chunkKey, proceduralPlaceName } from '../terrain.js';
import { convivir, updateCommunities } from '../society.js';
import { advancePopulation } from '../lineage.js';
import { maintainTechnologyMemory } from '../technology.js';
import { recordSample } from '../statistics.js';
import { conductorDe, type Dueno } from '../motor/contexto.js';
import { sustituido } from '../motor/leyes.js';


/** One fixed 100 ms step. Browser presence and wall-clock time are never inputs. */
/**
 * T107 (perfil por fase y fracción serial): reloj inyectado por el llamador —nunca
 * `performance.now()`/`Date.now()` aquí, regla 3— y el registro mutable donde se acumulan los
 * milisegundos por fase de este paso. Sin instrumentación (`medicion` ausente) el coste es un
 * único `if`; con ella, dos lecturas de reloj por fase.
 */
type FaseV23 = 'epoca' | 'F0' | 'F1' | 'eco' | 'F2-F4' | 'F5' | 'F6';
export interface FaseMedicion {
  clock: () => number;
  fases: Partial<Record<FaseNombre, number>>;
  v23?: Partial<Record<FaseV23, number>>;
}

function medirFase<T>(medicion: FaseMedicion | undefined, nombre: FaseNombre, fn: () => T): T {
  if (!medicion) return fn();
  const start = medicion.clock();
  const value = fn();
  medicion.fases[nombre] = (medicion.fases[nombre] ?? 0) + (medicion.clock() - start);
  return value;
}

function medirFasesV23(clock: () => number, fases: NonNullable<FaseMedicion['v23']>): (fase: FaseV23) => void {
  let inicio = clock();
  return fase => {
    const fin = clock();
    fases[fase] = (fases[fase] ?? 0) + (fin - inicio);
    inicio = fin;
  };
}

/**
 * T107/FR-021: qué fases son serie **por diseño** hoy, según la tabla de fases de `plan.md`
 * (0 · Coordinador y D/E · Global y barrera) y la lista irreducible de `research.md` D21
 * (nacimientos, muertes, comunidades, checkpoint tecnológico, muestreo, `Store.save`). El resto
 * son las que la etapa B/C planean mover a workers (percepción/decisión por región). No incluye
 * el clon del paso (`cloneMs`): esa fase no está en la lista de `FaseNombre` de esta tarea.
 */
export const FASES_SERIALES: ReadonlySet<FaseNombre> = new Set(['maintainRegions', 'demografia', 'comunidades', 'reproduccion', 'checkpoint', 'muestreo', 'save', 'broadcast']);

/** T107: fracción de la suma de fases nombradas que es serie por diseño; 0 con suma cero para no dividir por cero ni devolver fuera de [0,1]. */
export function fraccionSerial(fases: Partial<Record<FaseNombre, number>>): number {
  let serie = 0, total = 0;
  for (const [nombre, ms] of Object.entries(fases) as [FaseNombre, number][]) { total += ms; if (FASES_SERIALES.has(nombre)) serie += ms; }
  return total > 0 ? serie / total : 0;
}

export function stepWorld(world: World, inputs: Gesture[] = [], context: WorldContext = worldContext(world), medicion?: FaseMedicion): GestureResult[] {
  bindWorldContext(world, context);
  const boundContext = worldContext(world) as WorldContext;
  if (world.technology.checkpoint === undefined) world.technology.checkpoint = captureTechnologyCheckpoint(world.technology, world.people, world.tick, 'migration');
  world.tick++;
  // Sprint noche-perf2 2026-09-22: el paso sólo LEE el archivo de recetas (nunca escribe en él: eso es
  // del guardado, fuera del paso), así que sus lecturas a fecha de este tick van como un lote del
  // anfitrión, con un solo sello de la memoria de lecturas del Store en vez de uno por lectura (~900 por
  // paso con ~230 habitantes). El mundo resultante es el mismo; ver `readBatch` en store.ts.
  return withArchiveReadBatch(world, () => conRejilla(world, () => conRejillaFauna(world, () => advanceTick(world, inputs, boundContext, medicion))));
}

/**
 * Un tick en las fases de ARQ-motor §3.1 con un solo dueño (el hilo de simulación):
 * F0 coordinador: regiones, gestos, caducidad de invitaciones y avisos, y el entorno (ecología, kernel, fauna y
 *    estructuras), que hoy corre aquí entero porque no tiene dueños por chunk;
 * F1 adoptar migrantes y vaciar el buzón B: no hay con un dueño;
 * F2 percibir: el lote de personas que pueden decidir, sobre el estado al empezar la fase (`percibirPersonas`);
 * F3–F4 elegir y actuar, persona a persona y en el orden de `world.people`: `bodyAndAction` avanza el cuerpo,
 *    decide si toca (`choose` lee su fila de F2), mueve y trabaja, así que la elección de cada cual ve lo que
 *    hicieron antes en este tick quienes la preceden, salvo lo percibido en F2, que ve el estado de antes de todos;
 * F5 aplicar lo que cruza personas: descubrimientos, susurros, encuentros y convivencia, muertes, comunidades y
 *    crianza, en el orden de siempre;
 * F6 publicar: memoria técnica, checkpoint y muestra.
 */
function advanceTick(world: World, inputs: Gesture[], context: WorldContext, medicion: FaseMedicion | undefined): GestureResult[] {
  // V23: con alguna ley encendida (o una cinta enlazada) el tick lo conduce el dueño único, con ganchos.
  const dueno = conductorDe(world);
  if (dueno) return tickConLeyes(dueno, world, inputs, context, medicion);
  // F0
  medirFase(medicion, 'maintainRegions', () => maintainRegions(world, context));
  const results = inputs.map((gesture, order) => applyGesture(world, gesture, order));
  world.invitations = world.invitations.filter(invitation => invitation.until > world.tick);
  world.reminders = world.reminders.filter(reminder => reminder.until > world.tick);
  pasoEcologia(world, context, medicion);
  pasoKernel(world, context, medicion);
  medirFase(medicion, 'fauna', () => { stepAnimals(world,event=>addEvent(world,event)); stepStructures(world,event=>addEvent(world,event)); });
  pasoPersonas(world, medicion);
  // V24: sin mensajes, ni una lectura más (0 ULP en todo mundo histórico).
  if (world.whispers?.length) advanceWhispers(world);
  medirFase(medicion, 'encuentros', () => { encounters(world); convivir(world); });
  medirFase(medicion, 'demografia', () => advancePopulation(world,{emit:event=>addEvent(world,event.kind==='death'?deathContext(world,event):event),beforeDeath:transferEstate}));
  medirFase(medicion, 'comunidades', () => updateCommunities(world, event => addEvent(world, event)));
  medirFase(medicion, 'reproduccion', () => reproduce(world));
  // F6
  medirFase(medicion, 'checkpoint', () => {
    if (catalogueEnabled(world.technology)) for (const person of world.people) maintainTechnologyMemory(world, person);
    advanceTechnologyCheckpoint(world.technology, world.people, world.tick);
  });
  medirFase(medicion, 'muestreo', () => recordSample(world));
  return results;
}

/**
 * El mismo tick con leyes de la V23 encendidas y un solo dueño (`motor/contexto.ts`): cada paso heredado que una ley
 * encendida sustituye (`sustituido`) no se llama, y los ganchos de las leyes corren en su fase, en el orden de `LEYES`.
 * Con varios dueños este mismo orden lo sigue cada worker sobre su parte (`motor/dueno-worker.ts`), sin pasos heredados.
 */
function tickConLeyes(d: Dueno, world: World, inputs: Gesture[], context: WorldContext, medicion: FaseMedicion | undefined): GestureResult[] {
  const cerrarFase = medicion?.v23 && medirFasesV23(medicion.clock, medicion.v23);
  d.abrirEpoca();
  cerrarFase?.('epoca');
  const v = paramsOf(world).v23, queda = (paso: Parameters<typeof sustituido>[1]): boolean => !sustituido(v, paso);
  // F0: regiones (con alActivar y alRetirar), gestos, caducidades y lo global.
  d.fase(0);
  medirFase(medicion, 'maintainRegions', () => d.regiones(context));
  const results = inputs.map((gesture, order) => applyGesture(world, gesture, order));
  world.invitations = world.invitations.filter(invitation => invitation.until > world.tick);
  world.reminders = world.reminders.filter(reminder => reminder.until > world.tick);
  d.F0();
  cerrarFase?.('F0');
  // F1: migrantes y respuestas del tick anterior.
  d.fase(1);
  d.aplicar('M'); d.aplicar('B');
  d.gancho('F1');
  cerrarFase?.('F1');
  // eco: el entorno, antes de que nadie perciba.
  if (queda('ecologia')) pasoEcologia(world, context, medicion);
  if (queda('kernel')) pasoKernel(world, context, medicion);
  d.gancho('eco');
  medirFase(medicion, 'fauna', () => {
    if (queda('fauna')) stepAnimals(world, event => addEvent(world, event));
    if (queda('estructuras')) stepStructures(world, event => addEvent(world, event));
  });
  cerrarFase?.('eco');
  // F2–F4: preparar, elegir y actuar.
  d.fase(2); d.gancho('F2');
  d.fase(3); d.gancho('F3');
  d.fase(4); d.gancho('F4');
  if (queda('personas')) pasoPersonas(world, medicion);
  if (queda('susurros') && world.whispers?.length) advanceWhispers(world);
  cerrarFase?.('F2-F4');
  // F5: lo que cruza organismos.
  d.fase(5);
  d.aplicar('A');
  medirFase(medicion, 'encuentros', () => { if (queda('encuentros')) encounters(world); if (queda('convivir')) convivir(world); });
  if (queda('demografia')) medirFase(medicion, 'demografia', () => advancePopulation(world,{emit:event=>addEvent(world,event.kind==='death'?deathContext(world,event):event),beforeDeath:transferEstate}));
  if (queda('comunidades')) medirFase(medicion, 'comunidades', () => updateCommunities(world, event => addEvent(world, event)));
  if (queda('reproduccion')) medirFase(medicion, 'reproduccion', () => reproduce(world));
  d.gancho('F5');
  cerrarFase?.('F5');
  // F6: publicar.
  d.fase(6);
  medirFase(medicion, 'checkpoint', () => {
    if (queda('memoriaTecnica') && catalogueEnabled(world.technology)) for (const person of world.people) maintainTechnologyMemory(world, person);
    advanceTechnologyCheckpoint(world.technology, world.people, world.tick);
  });
  d.publicarFilas();
  d.gancho('F6');
  d.escribirFoto();
  d.publicarFrente();
  d.cerrarFoto();
  medirFase(medicion, 'muestreo', () => recordSample(world));
  cerrarFase?.('F6');
  return results;
}

function pasoEcologia(world: World, context: WorldContext, medicion: FaseMedicion | undefined): void {
  medirFase(medicion, 'ecologia', () => ecology(world, context.ecologyExecution));
  if (world.tick % INTERVALO_ECOLOGIA_TICKS === 0 && paramsOf(world).motor.hilos === 1 && (paramsOf(world).motor.gpu.length === 0 || !gpuNvrtcAvailable())) context.ecologyExecution?.onBarrier?.({
    tick: world.tick, phase: 'ecologia', regionSide: context.ecologyExecution.regionSide ?? 256,
    orden: paramsOf(world).motor.orden, workers: 1, dirtyPages: undefined, diagnostics: null, topologyCertificate: undefined,
  });
}

function pasoKernel(world: World, context: WorldContext, medicion: FaseMedicion | undefined): void {
  // T013 (decaimiento de fertilidad) + T035 (gateo de cuenca duradero: la lluvia no rellena
  // una tesela fuera de cuenca) viajan juntos en las mismas opciones de ecología.
  medirFase(medicion, 'kernel', () => stepEcosystem(world.tiles, world.tick, world.weather, phaseAt(world.tick), false,
    { decaimientoFertilidad: paramsOf(world).recursos.decaimientoFertilidad, seed: world.seed, cuencas: paramsOf(world).agua.cuencas, soaTerreno: paramsOf(world).motor.soaTerreno, hilos: paramsOf(world).motor.hilos,
      gpu: paramsOf(world).motor.gpu, orden: paramsOf(world).motor.orden, caminosFisicos: paramsOf(world).terreno.caminosFisicos, ...context.ecologyExecution }));
}

/** El paso heredado de las personas: percibir (F2), `bodyAndAction` de cada una (F3–F4) y descubrimientos. */
function pasoPersonas(world: World, medicion: FaseMedicion | undefined): void {
  medirFase(medicion, 'personas', () => withRecipeSession(world, () => {
    const tileIn = tileLookup(world.tiles);
    const fast = residentFastAccess(world.tiles) ?? null;
    // F2
    const percepcion = percepcionDe(world), lote = lotePersonas(world);
    const salida = percepcion.percibir(world.people, world.tick, lote, tileIn, fast ?? undefined, (vista, despacho) => prepararCerebros(world, vista, despacho, tileIn));
    const policyScores = puntuacionesPercibidas(world, lote, salida);
    // F3–F4
    try {
      for (let slot = 0; slot < world.people.length; slot++) bodyAndAction(world, world.people[slot]!, policyScores, tileIn, fast);
    } finally { percepcion.cerrar(); }
    // F5
    for (const person of world.people) {
      const chunk = world.chunks[chunkKey(person.x, person.y)]!;
      if (!chunk.discovered) {
        chunk.discovered = true; world.discoveredChunks++;
        const event = addEvent(world, { kind: 'discovery', actors: [person.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} descubrió ${proceduralPlaceName(world.seed, chunk.cx * 16, chunk.cy * 16)}.`, cause: 'Entró físicamente en una región que ningún habitante había recorrido; mirar con la cámara no cuenta como exploración.' });
        remember(person, world, 'Un nuevo territorio amplió los caminos posibles.', event.id);
      }
    }
  }));
}

/**
 * F2: quienes pueden decidir en este tick: su decisión vence, o la urgencia corporal de `bodyAndAction` (hambre o sed
 * > 0,9 sin estar comiendo o bebiendo) puede dispararse tras avanzar el cuerpo; el margen 0,01 cubre de sobra el
 * avance de un tick (≈ 0,0003 en reposo). Quien decide sin estar aquí (su objetivo se agotó en este tick, o el margen
 * no bastó) se percibe en el momento (`PercepcionDelPaso.filaDe`), sobre el estado de ese momento.
 */
function lotePersonas(world: World): Vencidos {
  const slots: number[] = [], plan: number[] = [];
  for (let slot = 0; slot < world.people.length; slot++) {
    const p = world.people[slot]!;
    const urgente = (p.hunger > 0.89 && p.action !== 'eat' && p.action !== 'hunt') || (p.thirst > 0.89 && p.action !== 'drink');
    if (world.tick < p.decisionAt && !urgente) continue;
    slots.push(slot); plan.push(decideConCerebro(world, p) ? PLAN.conCerebro : PLAN.sinCerebro);
  }
  return { tick: world.tick, slots: Int32Array.from(slots), plan: Uint16Array.from(plan) };
}
