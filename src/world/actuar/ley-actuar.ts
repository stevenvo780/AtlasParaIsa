/**
 * Ley de actuar (carril act, interruptor `v23.intentos`): el tick de las personas sustituye los pasos heredados
 * `personas` y `susurros`. Con un dueño y con muchos hace lo mismo sobre las personas propias del dueño (`c.mundo.people`):
 *  - F2 percibe el lote de quienes deciden en este tick (la misma percepción que el paso heredado);
 *  - F3 elige (`elegirPersona`: el cuerpo del tick y `choose`, de n);
 *  - F4 actúa (`actuarPersona`): anda, come, bebe, trabaja y caza escribiendo solo su estado y las celdas del chunk donde
 *    empezó el tick; lo que hace en otro chunk tras moverse espera al tick siguiente, cuando ya es suyo. A los demás les
 *    escribe por intento (m5 reparte, s vincula, t1 enseña, f recibe golpes y extracciones, gestos de aquí).
 *    Al final de F4 descubre los chunks que pisa por primera vez y deja los contadores del laboratorio;
 *  - F0 (coordinador) avanza los susurros leyendo a las personas por el frente, con índice espacial para los regionales;
 *  - F6 publica la columna `act.oido` que esos susurros leen;
 *  - `aplicar.Gesto` aplica órdenes, despertares y susurros que llegan a una persona propia.
 */
import { proceduralPlaceName, chunkKey } from '../terrain.js';
import { remember } from '../mundo/crear.js';
import type { Person, World } from '../mundo/tipos.js';
import type { CtxLey, Ley } from '../motor/acceso.js';
import { ctxMateriaDe } from '../motor/acceso.js';
import { percepcionDe, type PercepcionDelPaso, type Vencidos } from '../decision/percepcion.js';
import { decideConCerebro, prepararCerebros, puntuacionesPercibidas } from '../decision/politica-persona.js';
import { PLAN } from '../decision/planes.js';
import { tileLookup } from '../tile-index.js';
import { residentFastAccess, type ResidentFastAccess } from '../soa/terreno.js';
import type { TileLookup } from '../mundo/geometria.js';
import { withRecipeSession } from '../technology-catalogue.js';
import { escuchaDe } from '../genetics.js';
import { ley } from '../params.js';
import { cargaKg, masaDe } from '../materia/cuerpo.js';
import { actuarPersona, elegirPersona, prepararPaso, type PasoPersona } from './cuerpo.js';
import { aplicarGestoAct, CAMPOS_OIDO, COLUMNA_OIDO, OIDO_ANCHO, susurrosPorFrente } from './gestos.js';
import { contar, TOTAL_CARGA_KG_TICK, TOTAL_MASA_KG_TICK, vistaMateriales } from './recursos.js';

/** Lo que F2, F3 y F4 de un dueño comparten dentro de un tick. */
interface EstadoTick {
  tick: number;
  tileIn: TileLookup;
  fast: ResidentFastAccess | undefined;
  percepcion: PercepcionDelPaso;
  policyScores: Map<string, Float64Array>;
  /** Quienes eligieron en F3 y actúan en F4, con dónde estaban al empezar. */
  pasos: Map<Person, PasoPersona>;
}
const estados = new WeakMap<World, EstadoTick>();

/** Quienes deciden en este tick: su decisión vence o su cuerpo urge (el mismo criterio que el paso heredado). El margen
 * 0,01 sobre el umbral de 0,9 cubre el avance de un tick; quien urja sin estar aquí se percibe en el momento. */
function vencidos(world: World): Vencidos {
  const slots: number[] = [], plan: number[] = [];
  for (let slot = 0; slot < world.people.length; slot++) {
    const p = world.people[slot]!;
    const urgente = (p.hunger > 0.89 && p.action !== 'eat' && p.action !== 'hunt') || (p.thirst > 0.89 && p.action !== 'drink');
    if (world.tick < p.decisionAt && !urgente) continue;
    slots.push(slot); plan.push(decideConCerebro(world, p) ? PLAN.conCerebro : PLAN.sinCerebro);
  }
  return { tick: world.tick, slots: Int32Array.from(slots), plan: Uint16Array.from(plan) };
}

function cerrar(world: World): void {
  const e = estados.get(world);
  if (!e) return;
  estados.delete(world);
  e.percepcion.cerrar();
}

function F2(c: CtxLey): void {
  const world = c.mundo;
  cerrar(world);
  const tileIn = tileLookup(world.tiles), fast = residentFastAccess(world.tiles) ?? undefined;
  const percepcion = percepcionDe(world), lote = vencidos(world);
  const salida = percepcion.percibir(world.people, world.tick, lote, tileIn, fast,
    (vista, despacho) => prepararCerebros(world, vista, despacho, tileIn));
  estados.set(world, { tick: world.tick, tileIn, fast, percepcion, policyScores: puntuacionesPercibidas(world, lote, salida), pasos: new Map() });
}

/** Chunk de la celda donde está la persona al empezar a actuar (−1 si su celda no es residente). */
function chunkDe(c: CtxLey, p: Person): number {
  const celda = c.terreno.celda(p.x, p.y);
  return celda < 0 ? -1 : c.terreno.chunkDe(celda);
}

function F3(c: CtxLey): void {
  const world = c.mundo, e = estados.get(world);
  if (!e || e.tick !== world.tick) return;
  try {
    withRecipeSession(world, () => {
      for (const person of world.people.slice()) {
        const paso = prepararPaso(world, person, e.tileIn, e.fast ?? null, chunkDe(c, person));
        if (elegirPersona(world, person, paso, e.policyScores)) e.pasos.set(person, paso);
      }
    });
  } catch (error) { cerrar(world); throw error; }
}

function F4(c: CtxLey): void {
  const world = c.mundo, e = estados.get(world);
  if (!e || e.tick !== world.tick) return;
  try {
    withRecipeSession(world, () => {
      for (const [person, paso] of e.pasos) actuarPersona(world, person, paso);
    });
    descubrir(c);
    contadores(c);
  } finally { cerrar(world); }
}

/** Entrar físicamente en un chunk que nadie había recorrido lo descubre (mirar con la cámara no cuenta). El chunk donde
 * está una persona propia es de este dueño, así que se escribe directo. */
function descubrir(c: CtxLey): void {
  const world = c.mundo;
  for (const person of world.people) {
    const chunk = world.chunks[chunkKey(person.x, person.y)];
    if (!chunk || chunk.discovered) continue;
    chunk.discovered = true; world.discoveredChunks++;
    const id = c.suceso({ kind: 'discovery', actors: [person.id], x: person.x, y: person.y, source: 'simulation', text: `${person.name} descubrió ${proceduralPlaceName(world.seed, chunk.cx * 16, chunk.cy * 16)}.`, cause: 'Entró físicamente en una región que ningún habitante había recorrido; mirar con la cámara no cuenta como exploración.' });
    remember(person, world, 'Un nuevo territorio amplió los caminos posibles.', id);
  }
}

/** Contadores del laboratorio (lab): carga a cuestas y masa corporal, Σ por persona y tick; con obra, la vista de
 * `Person.materials` al día con lo que de verdad lleva (t1 y t2 también cambian la carga). */
function contadores(c: CtxLey): void {
  const world = c.mundo;
  if (!ley(world, 'cuerpos')) return;
  const m = ctxMateriaDe(world), obra = ley(world, 'obra');
  let carga = 0, masa = 0;
  for (const person of world.people) {
    if (!person.cuerpo) continue;
    masa += masaDe(m, person.cuerpo);
    if (person.carga?.length) carga += cargaKg(m, person.carga);
    if (obra) vistaMateriales(m, person);
  }
  contar(world, TOTAL_CARGA_KG_TICK, carga);
  contar(world, TOTAL_MASA_KG_TICK, masa);
}

/** F6: lo que los susurros leen de cada persona propia en el frente t+1. */
function F6(c: CtxLey): void {
  const w = c.escritura, col = w.f32(COLUMNA_OIDO);
  for (const [slot, p] of c.personas) {
    w.fila(slot);
    const b = slot * OIDO_ANCHO;
    col[b + CAMPOS_OIDO.escucha] = escuchaDe(p.genome);
    col[b + CAMPOS_OIDO.fatiga] = p.fatigue;
    col[b + CAMPOS_OIDO.explora] = p.action === 'explore' ? 1 : 0;
    col[b + CAMPOS_OIDO.objetivoX] = p.target.x;
    col[b + CAMPOS_OIDO.objetivoY] = p.target.y;
  }
}

export const leyActuar: Ley = {
  id: 'act', interruptor: 'intentos', sustituye: ['personas', 'susurros'],
  columnas: [[COLUMNA_OIDO, 'f32', OIDO_ANCHO]],
  F0: susurrosPorFrente,
  F2, F3, F4, F6,
  aplicar: { Gesto: aplicarGestoAct },
};
