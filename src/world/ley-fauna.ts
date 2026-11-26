/**
 * Ley de la fauna sobre átomos (carril f, interruptor `v23.fauna`): sustituye al paso heredado `fauna` (`stepAnimals`).
 *
 * Cada animal tiene el mismo `Cuerpo` que una persona (`materia/cuerpo.ts`): come y bebe moviendo lotes al digestivo,
 * paga moverse y morder quemando reserva, cría con `concebir`/`gestar`/`parir` y al morir deja un cadáver. Las reglas no
 * leen especie: presa, amenaza, pareja y dieta salen de la masa y de genes continuos (`decision/fauna.ts`, `GEN`); la
 * especie (`Animal.species`) es solo el linaje fundador con que se pinta. Sin topes: la densidad la acotan el alimento,
 * el coste de moverse y la huella de cada cuerpo en su celda; la vida máxima sale por alometría de la masa adulta.
 *
 * Fases: F1 adopta lo nuevo (cuerpo para quien no lo tenga); F2 percibe (solo lectura: frente, terreno y sus celdas);
 * F3 elige (función pura); F4 actúa (metabolismo, gestación, morder, concebir, moverse por huella, comer y beber);
 * F5 muertes y partos; F6 publica sus filas. A los demás se les escribe por intento (`Golpear`, `Tomar`).
 */
import type { AnimalView } from '../shared/life.js';
import { C_MOVER, DIAS_ABORTO, KAPPA0, KAPPA_HUMANA, M0, SALUD_FERTIL } from '../shared/naturaleza.js';
import { ACTIONS, SPECIES, syncFauna, type Animal, type EstadoFauna } from './animals.js';
import {
  AREA_CELDA, DISTANCIA_CRUCE, GEN, GENES_FAUNA, HUELLA_FORMA, decisionVacia, elegirFaunaV23, huella, radioVista, velocidadDe,
  vidaMaxima, type AgenteVisto, type CeldaVista, type DecisionFaunaV23, type PercepcionFaunaV23, type YoFauna,
} from './decision/fauna.js';
import type { Violacion } from './invariantes.js';
import { crearPlantilla } from './materia/copiar.js';
import {
  abortar, basalJ, beber, celdaDeMuerte, concebir, costeGestacionJ, crearCuerpo, crecer, depositar, extraer, gestar,
  herir, ingerirSelecto, lotesDe, masaDe, metabolizar, morir, pagar, parir, plantillaDe, reservaJ, vistaCuerpo,
} from './materia/cuerpo.js';
import { lotesDeCelda, sustanciasDe, type LotesCelda } from './materia/ley-mundo.js';
import { Parte, Rol, type Cuerpo, type Kappa, type LoteRef, type Plantilla, type VistaCuerpo } from './materia/tipos.js';
import { ctxMateriaDe, type Aplicado, type CtxLey, type CtxLeyMateria, type Ley } from './motor/acceso.js';
import {
  CAMPOS_CUERPO, Clase, CUERPO_ANCHO, DATO_GOLPEAR, DATO_MATERIA, DATO_TOMAR, GENOMA_ANCHO, REF_NULA, TipoIntento,
  genDe, refDe, slotDe, type Col, type Intento, type Ref,
} from './motor/contratos.js';
import { cercanos } from './motor/vecinos.js';
import { TICKS_PER_DAY, type World } from './mundo/tipos.js';
import { alarmaEn, alarmaPorAtaque, podarAlarmaLocal, subirAlarma, TAU_ALARMA } from './soa/alarma.js';
import { COLUMNA_FAUNA, escribirFilaFaunaV23, FAUNA_ANCHO } from './soa/fauna-v23.js';
import { faunaRegistrada } from './soa/organismos-mundo.js';

// ── Constantes físicas: viven en shared/naturaleza.ts (integrador) y se reexportan aquí ─────────────────────
import { TASA_INGESTA, TASA_BEBER, CAPACIDAD_DIGESTIVO, AGUA_CORPORAL, TRABAJO_MORDISCO, MADUREZ_MASA, MUTACION_GEN, MUTACION_LNMASA, PASO_LNMASA, PASO_CARNIVORIA } from '../shared/naturaleza.js';
export { TASA_INGESTA, TASA_BEBER, CAPACIDAD_DIGESTIVO, AGUA_CORPORAL, TRABAJO_MORDISCO, MADUREZ_MASA, MUTACION_GEN, MUTACION_LNMASA, PASO_LNMASA, PASO_CARNIVORIA };

/** Las seis plantillas fundadoras: genes de partida y masa adulta en kg. El índice es el linaje (`Plantilla.linaje`), en
 * el orden de `SPECIES`, con que el cliente las pinta; ninguna regla lo lee. Los genes son los de hoy (`animals.ts`). */
interface Fundador { masa: number; genes: readonly number[] }
//                       vel   perc  met   carn  agua  camu  caut  lnM  pelo  def   acuat
const fundador = (masa: number, g: readonly number[]): Fundador => ({ masa, genes: g });
export const FUNDADORES: readonly Fundador[] = [
  fundador(2.5, [0.8, 0.55, 0.5, 0.04, 0.5, 0.65, 0.57, 0, 0.5, 0.15, 0]),   // liebre
  fundador(80, [0.5, 0.55, 0.5, 0.04, 0.5, 0.4, 0.62, 0, 0.45, 0.4, 0]),     // ciervo
  fundador(90, [0.5, 0.55, 0.5, 0.22, 0.5, 0.4, 0.5, 0, 0.4, 0.55, 0]),      // jabalí
  fundador(1.5, [0.5, 0.55, 0.5, 0.04, 0.5, 0.4, 0.5, 0, 0.1, 0.2, 1]),      // pez
  fundador(40, [0.72, 0.7, 0.5, 0.96, 0.5, 0.4, 0.68, 0, 0.6, 0.65, 0]),     // lobo
  fundador(6, [0.68, 0.7, 0.5, 0.85, 0.5, 0.65, 0.58, 0, 0.55, 0.3, 0]),     // zorro
];

const sat01 = (n: number): number => n < 0 ? 0 : n > 1 ? 1 : n;
// Códigos del campo `terreno` (posición en `TERRENOS` de `decision/planes.ts` + 1).
const T_AGUA = 1, T_SUELO = 2, T_PRADERA = 3;
const habitableEn = (codigo: number, acuatico: boolean): boolean => acuatico ? codigo === T_AGUA : codigo === T_SUELO || codigo === T_PRADERA;
const ID_ANIMAL = /^animal-[a-zA-Z0-9-]{1,110}$/;
/** Fracción de enlaces del fragmento que se cortan al desgarrar tejido. Pagar todos costaba ≈20 MJ/kg de tejido
 * efectivo (1,7 g por mordisco de lobo); se calibra la superficie de la rotura en ≈20 kJ/kg. */
const FRACTURA_TEJIDO = 1e-3;

// ── Estado del dueño ───────────────────────────────────────────────────────────────────────────────────────

interface Fila {
  animal: Animal; ref: Ref;
  vista: VistaCuerpo; percepcion: PercepcionFaunaV23; yo: YoFauna; decision: DecisionFaunaV23;
  /** Celda al empezar F4 y celda propuesta para el movimiento (−1 = se queda). */
  celda: number; destino: number; dx: number; dy: number;
  fertil: boolean;
  /** m² con que este animal cuenta ahora en `Estado.ocupacion` de su celda (la de su masa en F2, o la de después de comer). */
  huellaContada: number;
}
interface Campos { terreno: Col | null; comida: Col | null; agua: Col | null }
interface Estado {
  filas: Map<Animal, Fila>;
  porSlot: Map<number, Fila>;
  plantillas: Map<string, Plantilla>;
  /** J de oxidación por unidad del campo `comida`, medidos en las celdas propias donde hay fauna (media del último F2). */
  jPorComida: number;
  /** m² ocupados por celda propia (Σ huellas de los animales de este dueño). */
  ocupacion: Map<number, number>;
  /** Agua bebible desde una celda de tierra por tener una vecina de agua, por tick. */
  aguaVecina: Map<number, number>;
  partos: Fila[];
  mordiscos: Intento[];
  cruces: { de: Ref; celda: number; nonce: number; huella: number }[];
  orden: Fila[];
  lotes: LotesCelda;
  buf: Float64Array;
  campos: Campos | null;
}
const estados = new WeakMap<World, Estado>();
function estado(c: CtxLey): Estado {
  let e = estados.get(c.mundo);
  if (!e) estados.set(c.mundo, e = {
    filas: new Map(), porSlot: new Map(), plantillas: new Map(), jPorComida: 0, ocupacion: new Map(), aguaVecina: new Map(),
    partos: [], mordiscos: [], cruces: [], orden: [], lotes: { suelo: REF_NULA, agua: REF_NULA, vida: REF_NULA, aire: REF_NULA },
    buf: new Float64Array(16), campos: null,
  });
  return e;
}
function campos(c: CtxLey, e: Estado): Campos {
  const nombres = c.terreno.campos;
  const col = (n: string): Col | null => nombres.includes(n) ? c.terreno.campo(n) : null;
  // Los campos del terreno pueden registrarse tarde (al encender una ley): se resuelven de nuevo si cambió su número.
  if (!e.campos || (e.campos.terreno === null && nombres.includes('terreno'))) e.campos = { terreno: col('terreno'), comida: col('comida'), agua: col('aguaPotable') };
  return e.campos;
}
const propia = (c: CtxLey, celda: number): boolean => celda >= 0 && c.terreno.duenoChunk[c.terreno.chunkDe(celda)] === c.hilo;
const vistaVacia = (): VistaCuerpo => ({ hambre: 0, sed: 0, energia: 0, salud: 0, masa: 0, carga: 0, T: 0 });
const percepcionVacia = (): PercepcionFaunaV23 => ({ agentes: [], nAgentes: 0, celdas: [], nCeldas: 0, alarma: 0, jPorComida: 0, carronaJ: 0 });
const yoVacio = (): YoFauna => ({ uid: 0, x: 0, y: 0, masa: 0, genoma: [], hambre: 0, sed: 0, reservaRel: 0, reservaJ: 0,
  habituacion: 0, sobresalto: 0, fertil: false, jPorKgCarne: 0 });
const sobresaltoActual = (f: EstadoFauna, tick: number): number =>
  f.sobresalto > 0 ? f.sobresalto * Math.exp(-Math.max(0, tick - f.sobresaltoDesde) / TAU_ALARMA) : 0;

// ── Genes, plantillas y animales nuevos ────────────────────────────────────────────────────────────────────

/** Genoma de un fundador del linaje `k` (con su masa en el gen `lnMasa`). */
export function genomaFundador(k: number): number[] {
  const f = FUNDADORES[k]!, g = f.genes.slice();
  g[GEN.lnMasa] = Math.log(f.masa);
  return g;
}

/** Plantilla de un genoma: tejido de la misma química para toda la fauna, masa adulta del gen `lnMasa` y κ del gen de
 * carnivoría. La κ reparte un mismo presupuesto catalítico entre C–O (celulosa, la hierba) y C–N (proteína, la carne):
 * κ_CO = 2κ₀(1 − carnivoría), κ_CN = 2κ₀·carnivoría. C–C/C–H es la del tubo humano (`KAPPA_HUMANA`) y H–H queda en κ₀.
 * Abrir C–O o C–N no basta para comer: en el tubo la celulosa y la proteína se carbonizan antes de oxidarse (barrera
 * γ·D(C–H) − κ frente a γ·D(O=O) − κ, `materia/cuerpo.ts`), y lo que la reserva recibe es carbono y grasa, que solo se
 * absorben con C–C/C–H abierta. Con κ₀ ahí (9·10⁻¹¹ por tick) un herbívoro convertía su pasto en carbón y lo excretaba. */
export function plantillaFauna(c: CtxLeyMateria, genoma: readonly number[], linaje: number): Plantilla {
  const e = estado(c);
  const qm = Math.round((genoma[GEN.lnMasa] ?? 0) / PASO_LNMASA), qc = Math.round(sat01(genoma[GEN.carnivoria] ?? 0) / PASO_CARNIVORIA);
  const clave = `${linaje}:${qm}:${qc}`;
  const hecha = e.plantillas.get(clave);
  if (hecha) return hecha;
  const S = sustanciasDe(c), carn = qc * PASO_CARNIVORIA, masaAdulta = Math.exp(qm * PASO_LNMASA);
  const kappa: Kappa = [Math.round(2 * KAPPA0 * (1 - carn)), Math.round(2 * KAPPA0 * carn), KAPPA_HUMANA[2], KAPPA0];
  // Tejido animal: proteína (músculo, pelo), grasa (CH₂), agua y hueso (CaHPO₄). Se sintetiza de lo mismo que hay en el
  // tubo, y el N y el P sobrantes vuelven como NH₃ y H₃PO₄. En masa: agua 61 %, proteína 20 %, grasa 10 %, mineral 9 %
  // (un mamífero: 60/18/15/5). Con 3:2:10:1 el mineral era el 31 % y el calcio de la hoja no alcanzaba para un embrión.
  const p = crearPlantilla(c.quimica, c.globales.registro, {
    partes: [{ id: S.proteina, nu: 10 }, { id: S.CH2, nu: 10 }, { id: S.H2O, nu: 50 }, { id: S.CaHPO4, nu: 1 }],
    entradas: [S.proteina, S.CH2, S.H2O, S.CaHPO4, S.madera, S.NH3, S.H3PO4],
    subproductos: [S.CO2, S.O2],
    kappa, captura: 0, masaAdulta, m0: M0 * masaAdulta, linaje,
  });
  if (!p) throw new Error('f: la plantilla del tejido animal no balancea con las sustancias del mundo.');
  e.plantillas.set(clave, p);
  return p;
}

/** Fenotipo de hoy (genes y morfología) desde los genes continuos: lo siguen leyendo el cliente y la caza heredada. */
const genesDe = (g: readonly number[]): Animal['genes'] => ({ speed: sat01(g[GEN.velocidad]!), perception: sat01(g[GEN.percepcion]!),
  metabolism: sat01(g[GEN.metabolismo]!), carnivory: sat01(g[GEN.carnivoria]!), waterEfficiency: sat01(g[GEN.eficienciaAgua]!),
  camouflage: sat01(g[GEN.camuflaje]!) });
const morfologiaDe = (g: readonly number[]): NonNullable<Animal['morphology']> => ({ caution: sat01(g[GEN.cautela]!),
  // `size` es la escala de dibujo: ln(masa) de 0,5 kg a 150 kg en [0, 1].
  size: sat01((g[GEN.lnMasa]! - Math.log(0.5)) / Math.log(300)), coat: sat01(g[GEN.pelaje]!), defense: sat01(g[GEN.defensa]!) });

const estadoNuevo = (genoma: number[], habituacion: number): EstadoFauna => ({
  genoma, habituacion, miedo: 0, sobresalto: 0, sobresaltoDesde: 0, avance: 0, persigue: 0, huyeDe: 0, pareja: 0,
  heridoPor: 0, heridoEn: -1, extraido: null,
});

/** El fundador cuyos genes se parecen más a los de un animal heredado (y que vive en su mismo medio). Sin leer especie. */
function fundadorMasCercano(a: Animal, acuatico: boolean): number {
  let mejor = 0, dMejor = Infinity;
  const g = a.genes, m = a.morphology;
  for (let k = 0; k < FUNDADORES.length; k++) {
    const f = FUNDADORES[k]!.genes;
    if ((f[GEN.acuatico]! > 0.5) !== acuatico) continue;
    const d = Math.abs(g.speed - f[GEN.velocidad]!) + Math.abs(g.perception - f[GEN.percepcion]!)
      + Math.abs(g.carnivory - f[GEN.carnivoria]!) + Math.abs(g.camouflage - f[GEN.camuflaje]!)
      + (m ? Math.abs(m.coat - f[GEN.pelaje]!) + Math.abs(m.defense - f[GEN.defensa]!) : 0);
    if (d < dMejor) { dMejor = d; mejor = k; }
  }
  return mejor;
}

/**
 * Un animal heredado (sin cuerpo) pasa a la V23: materializa su cuerpo como fuente declarada («fauna que se materializa
 * con su chunk»), con el genoma de su fundador más cercano y sus propios genes de hoy. Devuelve un objeto NUEVO con todas
 * sus propiedades (regla h: nada se añade a un objeto ya creado); quien llama lo pone en su lugar.
 */
function convertir(c: CtxLeyMateria, a: Animal): void {
  const e = estado(c), cols = campos(c, e), celda = c.terreno.celda(a.x, a.y);
  const acuatico = celda >= 0 && cols.terreno !== null && cols.terreno[celda] === T_AGUA;
  const k = fundadorMasCercano(a, acuatico), genoma = genomaFundador(k);
  genoma[GEN.velocidad] = a.genes.speed; genoma[GEN.percepcion] = a.genes.perception; genoma[GEN.metabolismo] = a.genes.metabolism;
  genoma[GEN.carnivoria] = a.genes.carnivory; genoma[GEN.eficienciaAgua] = a.genes.waterEfficiency; genoma[GEN.camuflaje] = a.genes.camouflage;
  if (a.morphology) {
    genoma[GEN.cautela] = a.morphology.caution; genoma[GEN.pelaje] = a.morphology.coat; genoma[GEN.defensa] = a.morphology.defense;
  }
  genoma[GEN.acuatico] = acuatico ? 1 : 0;
  const plantilla = plantillaFauna(c, genoma, k);
  const cuerpo = crearCuerpo(c, plantilla.id, plantilla.masaAdulta);
  const habituacion = a.habituation ?? 0;
  // En el mismo objeto: la tabla de la fauna (`FaunaSoA`) lleva la ranura del animal por identidad; un objeto nuevo
  // la perdía (baja de la vieja y alta de otra en F6) y la fila de esta ley quedaba apuntando a una ranura muerta.
  Object.assign(a, { target: { x: a.target.x, y: a.target.y }, memory: [], parents: [...a.parents], uid: a.uid ?? c.id('uid'),
    genes: genesDe(genoma), morphology: morfologiaDe(genoma), habituation: habituacion, tends: a.tends ?? 0,
    species: SPECIES[k]!, work: 0, preyId: null, cuerpo, fauna: estadoNuevo(genoma, habituacion) });
}

/** Animal nuevo con todas sus propiedades (cría o fundador). `linaje` solo decide cómo se pinta. */
function animalNuevo(c: CtxLey, d: { uid: number; x: number; y: number; genoma: number[]; cuerpo: Cuerpo; linaje: number;
  generation: number; parents: string[] }): Animal {
  const t = c.tick;
  return {
    id: `animal-v${d.uid}`, species: SPECIES[d.linaje] ?? SPECIES[0]!, x: d.x, y: d.y, action: 'rest',
    reason: 'Acaba de nacer junto a su madre.', hunger: 0, thirst: 0, energy: 0, fatigue: 0, health: 1,
    generation: d.generation, parents: d.parents, genes: genesDe(d.genoma), age: 0,
    morphology: morfologiaDe(d.genoma), habituation: 0, tends: 0,
    bornAt: t, lastBirth: t, lastBirthAge: 0, lastDecision: t, lastMove: t, target: { x: d.x, y: d.y }, memory: [], work: 0,
    preyId: null, uid: d.uid, cuerpo: d.cuerpo, fauna: estadoNuevo(d.genoma, 0),
  };
}

/** Genes de la cría: media de los dos progenitores más una mutación uniforme (la del hijo, sorteada al concebir). */
function cruzar(c: CtxLey, madre: readonly number[], genoma: Col, base: number): number[] {
  const hijo = new Array<number>(GENES_FAUNA);
  for (let k = 0; k < GENES_FAUNA; k++) {
    const m = madre[k] ?? 0, p = genoma[base + k] ?? m, media = (m + p) / 2;
    if (k === GEN.acuatico) hijo[k] = c.azar() < 0.5 ? m : p;
    else if (k === GEN.lnMasa) hijo[k] = media + (c.azar() - 0.5) * MUTACION_LNMASA;
    else hijo[k] = sat01(media + (c.azar() - 0.5) * MUTACION_GEN);
  }
  return hijo;
}

// ── Filas ─────────────────────────────────────────────────────────────────────────────────────────────────

function nuevaFila(e: Estado, animal: Animal, ref: Ref): Fila {
  const f: Fila = { animal, ref, vista: vistaVacia(), percepcion: percepcionVacia(), yo: yoVacio(), decision: decisionVacia(),
    celda: -1, destino: -1, dx: 0, dy: 0, fertil: false, huellaContada: 0 };
  e.filas.set(animal, f);
  e.porSlot.set(slotDe(ref), f);
  return f;
}
function olvidar(e: Estado, f: Fila): void {
  e.filas.delete(f.animal);
  if (e.porSlot.get(slotDe(f.ref)) === f) e.porSlot.delete(slotDe(f.ref));
}
function filaDeRef(e: Estado, r: Ref): Fila | undefined {
  const f = e.porSlot.get(slotDe(r));
  return f && f.ref === r ? f : undefined;
}

/** Pone al día las filas con `c.mundo.animals`: cuerpo a quien no lo tenga, fila a quien tenga ranura y olvida a quien
 * ya no es de este dueño (migró o murió fuera de esta ley). La ranura de un animal la da UNA sola tabla, la de la fauna
 * (`FaunaSoA`, que `CtxDueno.publicarFilas` sincroniza en F6 antes de `Ley.F6`): la fila toma su `ref` de ella y la
 * sigue si cambia (tabla rehecha en una época nueva). Quien aún no tiene ranura (una cría de este tick, un chunk que
 * vuelve del archivo) recibe la fila en el F6 en que la tabla le da el alta; hasta entonces no actúa. */
function sincronizar(c: CtxLeyMateria): void {
  const e = estado(c), animales = c.mundo.animals, tabla = faunaRegistrada(c.mundo);
  let conFila = 0;
  for (let i = 0; i < animales.length; i++) {
    const a = animales[i]!;
    if (!a.cuerpo || !a.fauna) convertir(c, a);
    const ref = tabla?.ref(a) ?? REF_NULA, f = e.filas.get(a);
    if (ref !== REF_NULA) conFila++;
    if (f && f.ref === ref) continue;
    if (f && ref !== REF_NULA) {
      if (e.porSlot.get(slotDe(f.ref)) === f) e.porSlot.delete(slotDe(f.ref));
      f.ref = ref;
      e.porSlot.set(slotDe(ref), f);
    } else if (f) olvidar(e, f);
    else if (ref !== REF_NULA) nuevaFila(e, a, ref);
  }
  if (e.filas.size !== conFila) {
    const vigentes = new Set(animales);
    for (const f of [...e.filas.values()]) if (!vigentes.has(f.animal)) olvidar(e, f);
  }
}

// ── F2: percibir ──────────────────────────────────────────────────────────────────────────────────────────

function distanciaGeneticaCol(g: readonly number[], col: Col, base: number): number {
  let d = 0;
  for (let k = 0; k < GENES_FAUNA; k++) {
    const x = g[k] ?? 0, y = col[base + k] ?? 0;
    d += k === GEN.acuatico ? 2 * Math.abs(x - y) : Math.abs(x - y);
  }
  return d;
}

/** Agua que se bebe desde una celda de tierra por tener vecinas de agua (lagos, ríos): la mayor de las vecinas. */
function aguaVecina(c: CtxLey, e: Estado, cols: Campos, x: number, y: number, celda: number): number {
  const hecha = e.aguaVecina.get(celda);
  if (hecha !== undefined) return hecha;
  let agua = 0;
  if (cols.terreno) for (const [dx, dy] of VECINAS) {
    const v = c.terreno.celda(x + dx, y + dy);
    if (v >= 0 && cols.terreno[v] === T_AGUA) agua = Math.max(agua, cols.agua?.[v] || 1);
  }
  e.aguaVecina.set(celda, agua);
  return agua;
}
const VECINAS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function percibir(c: CtxLeyMateria, e: Estado, f: Fila): void {
  const a = f.animal, g = a.fauna!.genoma, p = f.percepcion, fr = c.frente, cols = campos(c, e);
  const acuatico = (g[GEN.acuatico] ?? 0) > 0.5, r = radioVista(g[GEN.percepcion] ?? 0.5), miSlot = slotDe(f.ref);
  const miCelda = c.terreno.celda(a.x, a.y), miHuella = huella(f.vista.masa);
  p.nAgentes = 0;
  cercanos(c, a.x, a.y, r, 0, (slot, d2) => {
    if (slot === miSlot) return;
    const ag = p.agentes[p.nAgentes] ?? (p.agentes[p.nAgentes] = agenteVacio());
    p.nAgentes++;
    const persona = fr.clase[slot] === Clase.Persona, gb = slot * GENOMA_ANCHO;
    ag.ref = refDe(slot, fr.gen[slot]!); ag.uid = fr.uid[slot]!; ag.persona = persona;
    ag.x = fr.x[slot]!; ag.y = fr.y[slot]!; ag.d = Math.sqrt(d2);
    ag.masa = fr.cuerpo[slot * CUERPO_ANCHO + CAMPOS_CUERPO.masa]!;
    ag.carnivoria = persona ? 0 : fr.genoma[gb + GEN.carnivoria]!;
    ag.velocidad = velocidadDe(ag.masa, persona ? 0.5 : fr.genoma[gb + GEN.velocidad]!);
    ag.defensa = persona ? 0 : fr.genoma[gb + GEN.defensa]!;
    ag.pareja = !persona && fr.pareja[slot] === 0 && distanciaGeneticaCol(g, fr.genoma, gb) <= DISTANCIA_CRUCE;
  });
  p.nCeldas = 0;
  const ri = Math.floor(r), r2 = r * r;
  for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) {
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    const x = a.x + dx, y = a.y + dy, celda = c.terreno.celda(x, y);
    if (celda < 0) continue;
    const codigo = cols.terreno?.[celda] ?? 0;
    const cv = p.celdas[p.nCeldas] ?? (p.celdas[p.nCeldas] = celdaVacia());
    p.nCeldas++;
    cv.celda = celda; cv.x = x; cv.y = y; cv.d = Math.sqrt(d2);
    cv.habitable = habitableEn(codigo, acuatico);
    cv.comida = cols.comida?.[celda] ?? 0;
    cv.agua = acuatico ? (codigo === T_AGUA ? 1 : 0) : Math.max(cols.agua?.[celda] ?? 0, aguaVecina(c, e, cols, x, y, celda));
    cv.libre = AREA_CELDA - (e.ocupacion.get(celda) ?? 0) + (celda === miCelda ? miHuella : 0);
  }
  p.alarma = alarmaEn(c, miCelda);
  p.jPorComida = e.jPorComida;
  p.carronaJ = 0;
  if (propia(c, miCelda)) {
    const n = c.materia.lotes(miCelda, Rol.Cadaver, e.buf);
    for (let i = 0; i < Math.min(n, e.buf.length); i++) p.carronaJ += c.materia.vista(e.buf[i]!).energia;
  }
}
const agenteVacio = (): AgenteVisto => ({ ref: REF_NULA, uid: 0, persona: false, x: 0, y: 0, d: 0, masa: 0, carnivoria: 0,
  velocidad: 0, defensa: 0, pareja: false });
const celdaVacia = (): CeldaVista => ({ celda: -1, x: 0, y: 0, d: 0, comida: 0, agua: 0, habitable: false, libre: 0 });

/** J de oxidación por unidad de `comida`. `digerible` usa κ₀, que deja la carne en ≈ 1 J/kg antes de ponderar la dieta
 * y hace que perseguir incluso a una presa contigua cueste más que comerla. */
function medirPasto(c: CtxLeyMateria, e: Estado): void {
  const cols = campos(c, e);
  if (!cols.comida) return;
  let j = 0, comida = 0;
  const vistas = new Set<number>();
  for (const f of e.filas.values()) {
    const celda = c.terreno.celda(f.animal.x, f.animal.y);
    if (vistas.has(celda) || !propia(c, celda)) continue;
    vistas.add(celda);
    const q = cols.comida[celda] ?? 0;
    if (!(q > 0)) continue;
    const vida = lotesDeCelda(c, celda, e.lotes).vida;
    if (vida === REF_NULA || !c.materia.vivo(vida)) continue;
    j += c.materia.vista(vida).energia; comida += q;
  }
  if (comida > 0) e.jPorComida = j / comida;
}

// ── F3: elegir ────────────────────────────────────────────────────────────────────────────────────────────

function prepararYo(c: CtxLeyMateria, f: Fila): void {
  const a = f.animal, fa = a.fauna!, cu = a.cuerpo!, yo = f.yo, v = f.vista;
  vistaCuerpo(c, cu, v);
  yo.uid = a.uid ?? 0; yo.x = a.x; yo.y = a.y; yo.masa = v.masa; yo.genoma = fa.genoma;
  yo.hambre = v.hambre; yo.sed = v.sed; yo.reservaRel = v.energia; yo.reservaJ = reservaJ(c, cu);
  yo.habituacion = fa.habituacion; yo.sobresalto = sobresaltoActual(fa, c.tick);
  const vt = c.materia.vista(cu.tejido);
  yo.jPorKgCarne = vt.masa > 0 ? vt.energia / vt.masa : 0;
  const pl = plantillaDe(c, cu), g = cu.gestacion;
  f.fertil = false;
  if (g || (v.salud >= SALUD_FERTIL && v.masa >= MADUREZ_MASA * pl.masaAdulta)) {
    const pendiente = g ? sat01(1 - c.materia.vista(g.embrion).masa / pl.m0) : 1;
    // La proteína y el hueso llegan del digestivo. La reserva solo cubre su parte de la síntesis y el basal que exige gestar.
    const provision = pendiente * costeGestacionJ(c, cu) + basalJ(c, cu, TICKS_PER_DAY);
    f.fertil = !g && provision > 0 && yo.reservaJ >= provision;
    if (provision > 0) yo.hambre = Math.max(yo.hambre, 1 - yo.reservaJ / provision);
    if (g) yo.hambre = Math.max(yo.hambre, pendiente);
  }
  yo.fertil = f.fertil;
}

// ── F4: actuar ────────────────────────────────────────────────────────────────────────────────────────────

function enviar(c: CtxLey, a: Ref, i: Omit<Intento, 'a'>): void {
  const f = c.frente, s = slotDe(a);
  const vigente = a !== REF_NULA && s < f.alta && f.vivo[s] === 1 && f.gen[s] === genDe(a);
  const celdaActual = vigente ? c.terreno.celda(f.x[s]!, f.y[s]!) : -1;
  // La dirección material sigue sirviendo si el solicitante o su página se retiran antes del cobro.
  const celda = celdaActual >= 0 ? celdaActual : i.celda;
  const dueno = vigente ? f.dueno[s]! : celda >= 0 ? c.terreno.duenoChunk[c.terreno.chunkDe(celda)] ?? -1 : -1;
  c.buzon.enviar(dueno >= 0 ? dueno : c.hilo, { ...i, a, celda });
}

export function golpearAnimal(c: CtxLeyMateria, de: Ref, presa: Ref, golpe: Float64Array): void {
  const i: Intento = { tipo: TipoIntento.Golpear, de, a: presa, celda: -1, lote: REF_NULA,
    nonce: c.id('nonce'), materia: null, dato: golpe, bytes: null };
  const dueno = c.frente.dueno[slotDe(presa)]!;
  if (c.params.v23.intentos) c.buzon.enviar(dueno, i);
  else if (dueno === c.hilo) estado(c).mordiscos.push(i);
}

/** Un mordisco de un tick de contacto: trabajo pagado con la reserva, filo y esbeltez de dientes y garras según la
 * carnivoría, tenacidad y dureza las de su propio tejido (el hueso de la mandíbula). */
function morder(c: CtxLeyMateria, f: Fila, presa: Ref): void {
  const cu = f.animal.cuerpo!, carn = sat01(f.animal.fauna!.genoma[GEN.carnivoria] ?? 0);
  const trabajo = pagar(c, cu, TRABAJO_MORDISCO * f.vista.masa * carn);
  if (!(trabajo > 0)) return;
  const vt = c.materia.vista(cu.tejido), golpe = new Float64Array(5);
  golpe[DATO_GOLPEAR.trabajo] = trabajo; golpe[DATO_GOLPEAR.filo] = carn; golpe[DATO_GOLPEAR.tenacidad] = vt.tenacidad;
  golpe[DATO_GOLPEAR.esbeltez] = carn; golpe[DATO_GOLPEAR.dureza] = Math.max(vt.dureza, carn);
  golpearAnimal(c, f.ref, presa, golpe);
}

/** Come de los lotes `rol` de su celda propia lo que quepa en el tubo, deje pasar la boca en un tick y no pase de `tope`
 * kg (el área libre de la celda). Devuelve los kg comidos. */
function comer(c: CtxLeyMateria, e: Estado, f: Fila, celda: number, rol: Rol, tope: number): number {
  const cu = f.animal.cuerpo!, masa = f.vista.masa;
  let libre = Math.min(tope, CAPACIDAD_DIGESTIVO * masa - c.materia.vista(cu.digestivo).masa);
  let boca = TASA_INGESTA * masa ** 0.75;
  if (!(libre > 0)) return 0;
  if (rol === Rol.Vida) {
    const vida = lotesDeCelda(c, celda, e.lotes).vida;
    return vida !== REF_NULA ? ingerirSelecto(c, cu, vida, Math.min(libre, boca)) : 0;
  }
  const n = Math.min(c.materia.lotes(celda, rol, e.buf), e.buf.length);
  let comido = 0;
  for (let i = 0; i < n && libre > 0 && boca > 0; i++) {
    const kg = ingerirSelecto(c, cu, e.buf[i]!, Math.min(libre, boca));
    libre -= kg; boca -= kg; comido += kg;
  }
  return comido;
}

/** Bebe del agua de su celda o, en tierra, de la de una vecina propia (orilla). */
function beberAqui(c: CtxLeyMateria, e: Estado, f: Fila, celda: number, tope: number): void {
  const cu = f.animal.cuerpo!, masa = f.vista.masa;
  const kg = Math.min(tope, TASA_BEBER * masa ** 0.75, f.vista.sed * masa * AGUA_CORPORAL);
  if (!(kg > 0)) return;
  const aqui = lotesDeCelda(c, celda, e.lotes).agua;
  let bebido = aqui !== REF_NULA ? beber(c, cu, aqui, kg) : 0;
  for (const [dx, dy] of VECINAS) {
    if (bebido >= kg) break;
    const v = c.terreno.celda(f.animal.x + dx, f.animal.y + dy);
    if (!propia(c, v)) continue;
    const agua = lotesDeCelda(c, v, e.lotes).agua;
    if (agua !== REF_NULA) bebido += beber(c, cu, agua, kg - bebido);
  }
}

/** Paso propuesto: hasta `pasos` celdas hacia (tx, ty) por el eje más largo, sin salir de su medio. */
function proponer(c: CtxLeyMateria, e: Estado, f: Fila, pasos: number): void {
  const a = f.animal, d = f.decision, cols = campos(c, e), acuatico = (a.fauna!.genoma[GEN.acuatico] ?? 0) > 0.5;
  let x = a.x, y = a.y;
  for (let k = 0; k < pasos && (x !== d.tx || y !== d.ty); k++) {
    const ddx = d.tx - x, ddy = d.ty - y;
    const nx = Math.abs(ddx) >= Math.abs(ddy) ? x + Math.sign(ddx) : x, ny = Math.abs(ddx) >= Math.abs(ddy) ? y : y + Math.sign(ddy);
    const celda = c.terreno.celda(nx, ny);
    if (celda < 0 || !habitableEn(cols.terreno?.[celda] ?? 0, acuatico)) break;
    x = nx; y = ny;
  }
  f.dx = x; f.dy = y;
  f.destino = x === a.x && y === a.y ? -1 : c.terreno.celda(x, y);
}

/** Segunda pasada del movimiento, en orden al azar: cada propuesta entra si su huella cabe en el área libre de la celda
 * de destino y si paga C_MOVER·masa·distancia con su reserva. */
function moverse(c: CtxLeyMateria, e: Estado, f: Fila): void {
  if (!propia(c, f.destino)) return;
  const h = f.huellaContada, ocupado = e.ocupacion.get(f.destino) ?? 0;
  if (ocupado + h > AREA_CELDA || !pagarMovimiento(c, f)) return;
  e.ocupacion.set(f.celda, Math.max(0, (e.ocupacion.get(f.celda) ?? 0) - h));
  e.ocupacion.set(f.destino, ocupado + h);
}

function pagarMovimiento(c: CtxLeyMateria, f: Fila): boolean {
  const a = f.animal, fa = a.fauna!;
  const dist = Math.abs(f.dx - a.x) + Math.abs(f.dy - a.y), coste = C_MOVER * (f.yo.masa + f.vista.carga) * dist;
  if (f.yo.reservaJ < coste || pagar(c, a.cuerpo!, coste) < coste) { fa.avance = 0; return false; }
  a.x = f.dx; a.y = f.dy; a.lastMove = c.tick;
  fa.avance = Math.max(0, fa.avance - dist);
  return true;
}

/** En la frontera el animal sigue en origen mientras el destino resuelve la admisión. */
function solicitarCruce(c: CtxLey, f: Fila): void {
  if (f.destino < 0 || propia(c, f.destino)) return;
  const dueno = c.terreno.duenoChunk[c.terreno.chunkDe(f.destino)]!;
  if (dueno < 0) return;
  c.buzon.enviar(dueno, { tipo: TipoIntento.Cruzar, de: f.ref, a: REF_NULA, celda: f.destino, lote: REF_NULA,
    nonce: c.id('nonce'), materia: null, dato: Float64Array.of(huella(f.vista.masa)), bytes: null });
}

function aplicarCruzar(c: CtxLey, i: Intento): Aplicado {
  estado(c).cruces.push({ de: i.de, celda: i.celda, nonce: i.nonce, huella: i.dato![0]! });
  return 'hecho';
}

/** Tras los partos y las muertes, el dueño de la celda reserva espacio para cada cruce admitido. */
function admitirCruces(c: CtxLeyMateria, e: Estado): void {
  if (!e.cruces.length) return;
  e.ocupacion.clear();
  for (const i of e.cruces) e.ocupacion.set(i.celda, 0);
  for (const a of c.mundo.animals) {
    const celda = c.terreno.celda(a.x, a.y);
    const ocupada = e.ocupacion.get(celda);
    if (ocupada !== undefined && a.cuerpo) e.ocupacion.set(celda, ocupada + huella(masaDe(c, a.cuerpo)));
  }
  for (const i of e.cruces) {
    const total = (e.ocupacion.get(i.celda) ?? 0) + i.huella;
    if (total > AREA_CELDA || c.retiraChunk(c.terreno.chunkDe(i.celda))) continue;
    e.ocupacion.set(i.celda, total);
    const dueno = c.frente.dueno[slotDe(i.de)]!;
    c.buzon.enviar(dueno, { tipo: TipoIntento.Admitido, de: REF_NULA, a: i.de, celda: i.celda, lote: REF_NULA,
      nonce: i.nonce, materia: null, dato: Float64Array.of(i.huella), bytes: null });
  }
  e.cruces.length = 0;
}

function aplicarAdmitido(cl: CtxLey, i: Intento): Aplicado {
  const c = ctxMateriaDe(cl.mundo), f = filaDeRef(estado(c), i.a);
  if (!f || f.destino !== i.celda || huella(f.vista.masa) > i.dato![0]!) return 'hecho';
  if (pagarMovimiento(c, f)) { vistaCuerpo(c, f.animal.cuerpo!, f.vista); reflejar(c, f); }
  return 'hecho';
}

function actuar(c: CtxLeyMateria, e: Estado, f: Fila): void {
  const a = f.animal, fa = a.fauna!, cu = a.cuerpo!, d = f.decision, fr = c.frente;
  f.celda = c.terreno.celda(a.x, a.y); f.destino = -1;
  metabolizar(c, cu, f.celda, 1);
  if (cu.gestacion) {
    const masa = gestar(c, cu, 1), g = cu.gestacion;
    if (g && masa >= plantillaDe(c, cu).m0) e.partos.push(f);
    // El aborto devuelve el embrión al digestivo de la madre: espera a que su masa quepa en la celda.
    else if (g && g.bajoBasalDesde >= 0 && c.tick - g.bajoBasalDesde >= DIAS_ABORTO * TICKS_PER_DAY
      && c.materia.vista(g.embrion).masa <= margenKg(c, e, f, f.celda)) { abortar(c, cu); contarHuella(e, f, f.celda, masaDe(c, cu)); }
  }
  // El mantenimiento ya se pagó. Si el tejido adulto sintetiza primero, puede acaparar toda la proteína del tubo.
  crecer(c, cu, 1, false);
  fa.miedo = d.miedo; fa.habituacion = d.habituacion; fa.huyeDe = d.huyeDe; fa.persigue = d.presaUid; fa.pareja = d.pareja;
  // Contacto con la presa (posiciones del frente): muerde y no se mueve este tick.
  if (d.accion === 'hunt' && d.presa !== REF_NULA) {
    const s = slotDe(d.presa);
    if (fr.vivo[s] === 1 && fr.gen[s] === genDe(d.presa) && Math.hypot(fr.x[s]! - a.x, fr.y[s]! - a.y) <= 1.5) {
      morder(c, f, d.presa);
      return;
    }
  }
  // Concebir con una pareja adyacente que consiente; la madre es quien concibe (las dos pueden, si las dos lo deciden).
  if (d.pareja > 0 && f.fertil && !cu.gestacion) {
    const pr = c.ref(d.pareja), s = pr === REF_NULA ? -1 : slotDe(pr);
    if (s >= 0 && fr.pareja[s] === 0 && Math.hypot(fr.x[s]! - a.x, fr.y[s]! - a.y) <= 1.5) {
      concebir(c, cu, { otro: d.pareja, genoma: cruzar(c, fa.genoma, fr.genoma, s * GENOMA_ANCHO), inicio: c.tick });
      a.lastBirth = c.tick;
    }
  }
  if (d.tx === a.x && d.ty === a.y) { fa.avance = 0; return; }
  fa.avance += velocidadDe(f.vista.masa, fa.genoma[GEN.velocidad] ?? 0.5);
  const pasos = Math.floor(fa.avance);
  if (pasos > 0) proponer(c, e, f, pasos);
}

/** kg que el cuerpo puede ganar (comer, beber, recibir el embrión de un aborto) sin que la huella de su celda pase del
 * área: lo que queda libre más lo que ya cuenta él, menos un gramo por el redondeo a cuantos. */
function margenKg(c: CtxLeyMateria, e: Estado, f: Fila, celda: number): number {
  const libre = AREA_CELDA - (e.ocupacion.get(celda) ?? 0) + f.huellaContada;
  return libre > 0 ? Math.max(0, (libre / HUELLA_FORMA) ** 1.5 - masaDe(c, f.animal.cuerpo!) - 1e-3) : 0;
}
/** Pone en `Estado.ocupacion` la huella de la masa `masa` del animal en su celda en lugar de la que contaba. */
function contarHuella(e: Estado, f: Fila, celda: number, masa: number): void {
  const h = huella(masa);
  e.ocupacion.set(celda, (e.ocupacion.get(celda) ?? 0) - f.huellaContada + h);
  f.huellaContada = h;
}

/** Tras moverse: come o bebe en la celda donde quedó, si es lo que decidió, sin pasar del área libre de la celda; la
 * huella que gana queda contada para quien coma después en la misma celda. */
function alimentarse(c: CtxLeyMateria, e: Estado, f: Fila): void {
  const a = f.animal, d = f.decision, celda = c.terreno.celda(a.x, a.y);
  if (!propia(c, celda)) return;
  const tope = margenKg(c, e, f, celda);
  if (!(tope > 0)) return;
  if (d.accion === 'drink') beberAqui(c, e, f, celda, tope);
  else if (d.accion === 'graze' || d.accion === 'hunt') {
    const carn = sat01(a.fauna!.genoma[GEN.carnivoria] ?? 0);
    // Carne primero si la hay y la digiere mejor que la hierba; si no, la vegetación de la celda.
    let queda = tope;
    if (carn > 0 && c.materia.lotes(celda, Rol.Cadaver, e.buf) > 0) queda -= comer(c, e, f, celda, Rol.Cadaver, queda);
    if (d.accion === 'graze' && carn < 1 && queda > 0) comer(c, e, f, celda, Rol.Vida, queda);
  } else return;
  contarHuella(e, f, celda, masaDe(c, a.cuerpo!));
}

/** Copia a los campos de hoy lo que el cliente y las leyes heredadas aún leen del animal. */
function reflejar(c: CtxLey, f: Fila): void {
  const a = f.animal, v = f.vista, d = f.decision;
  a.hunger = sat01(v.hambre); a.thirst = sat01(v.sed); a.energy = sat01(v.energia); a.health = sat01(v.salud);
  a.fatigue = 0; a.age = Math.max(0, c.tick - a.bornAt); a.habituation = a.fauna!.habituacion;
  a.action = d.accion; a.reason = d.razon; a.target.x = d.tx; a.target.y = d.ty; a.lastDecision = c.tick; a.work = 0;
  const id = d.presaUid > 0 ? c.idDe(d.presaUid) : undefined;
  a.preyId = id !== undefined && id !== a.id && ID_ANIMAL.test(id) ? id : null;
}

// ── F5: morir y nacer ─────────────────────────────────────────────────────────────────────────────────────

/** Muerte de un animal propio: su cuerpo pasa a un cadáver en su celda, la tabla lo da de baja y, si fue violenta, la
 * alarma sube alrededor. `por` es el id de quien lo mató, si lo hubo. Lo usa también la caza heredada (`harvestAt`). */
export function matarAnimal(c: CtxLeyMateria, animal: Animal, causa: string, por?: string): void {
  const e = estado(c), f = e.filas.get(animal), cu = animal.cuerpo;
  if (!cu || !f) return;
  const celda = celdaDeMuerte(c, animal.x, animal.y);
  const masa = masaDe(c, cu);
  morir(c, cu, celda);
  const violenta = por !== undefined || (animal.fauna !== undefined && c.tick - animal.fauna.heridoEn <= 2);
  if (violenta && propia(c, celda)) alarmaPorAtaque(c, animal.x, animal.y, 1);
  c.baja(f.ref);
  olvidar(e, f);
  animal.health = 0;
  const dyn = c.mundo.animalDynamics;
  dyn.deaths++;
  if (causa === 'caza humana') dyn.humanHunts++;
  else if (causa === 'depredación') dyn.predations++;
  const actores = por ? [por, animal.id] : [animal.id];
  c.suceso({ kind: 'animal', actors: actores, x: animal.x, y: animal.y, text: `Muere un animal de ${Math.round(masa * 10) / 10} kg por ${causa}.`,
    cause: causa, source: 'simulation' });
  c.mundo.animals = c.mundo.animals.filter(x => x !== animal);
}

function causaDeMuerte(c: CtxLeyMateria, f: Fila): string {
  const a = f.animal, cu = a.cuerpo!;
  vistaCuerpo(c, cu, f.vista);
  if (f.vista.salud <= 0) {
    if (c.tick - a.fauna!.heridoEn <= 2) {
      const s = slotDe(c.ref(a.fauna!.heridoPor));
      return a.fauna!.heridoPor > 0 && c.frente.clase[s] === Clase.Persona ? 'caza humana' : 'depredación';
    }
    return f.vista.sed >= f.vista.hambre ? 'deshidratación' : 'inanición';
  }
  return c.tick - a.bornAt > vidaMaxima(plantillaDe(c, cu).masaAdulta) ? 'senescencia' : '';
}

const AQUI_Y_VECINAS: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];

/** Parto: la cría nace en la celda de la madre o en una vecina donde quepa su huella; si no cabe en ninguna, el parto
 * espera (el embrión ya no crece y `gestar` lo vuelve a dar por listo en el tick siguiente). */
function nacer(c: CtxLeyMateria, e: Estado, f: Fila): void {
  const madre = f.animal, cu = madre.cuerpo!, g = cu.gestacion;
  if (!g) return;
  const acuaticoCria = (g.genoma[GEN.acuatico] ?? 0) > 0.5;
  const masaEmbrion = c.materia.vista(g.embrion).masa;
  // El parto transfiere también parte de la reserva. La fracción sin redondear acota la masa por arriba.
  const fraccion = masaEmbrion / (masaEmbrion + c.materia.vista(cu.tejido).masa);
  const hCria = huella(masaEmbrion + fraccion * c.materia.vista(cu.reserva).masa);
  const cols = campos(c, e);
  let donde = -1, x = madre.x, y = madre.y;
  for (const [dx, dy] of AQUI_Y_VECINAS) {
    const celda = c.terreno.celda(madre.x + dx, madre.y + dy);
    if (!propia(c, celda) || !habitableEn(cols.terreno?.[celda] ?? 0, acuaticoCria)) continue;
    if ((e.ocupacion.get(celda) ?? 0) + hCria > AREA_CELDA) continue;
    donde = celda; x = madre.x + dx; y = madre.y + dy;
    break;
  }
  if (donde < 0) return;
  const genoma = g.genoma.slice(), otro = g.otro, linaje = plantillaDe(c, cu).linaje;
  const cria = parir(c, cu);
  contarHuella(e, f, c.terreno.celda(madre.x, madre.y), masaDe(c, cu));
  e.ocupacion.set(donde, (e.ocupacion.get(donde) ?? 0) + huella(masaDe(c, cria)));
  // El embrión se sintetizó con la plantilla de la madre (el mismo tejido para toda la fauna); su masa adulta y su κ
  // son las de su propio genoma.
  cria.plantilla = plantillaFauna(c, genoma, linaje).id;
  const uid = c.id('uid');
  const padre = c.idDe(otro);
  const parents = [madre.id, padre !== undefined && padre !== madre.id && ID_ANIMAL.test(padre) ? padre : `animal-u${otro}`];
  const hijo = animalNuevo(c, { uid, x, y, genoma, cuerpo: cria, linaje, generation: madre.generation + 1, parents });
  madre.lastBirth = c.tick; madre.lastBirthAge = Math.max(0, c.tick - madre.bornAt);
  c.mundo.animals.push(hijo);
  c.mundo.animalDynamics.births++;
  c.suceso({ kind: 'animal', actors: [...parents, hijo.id], x: hijo.x, y: hijo.y,
    text: `Nace una cría de generación ${hijo.generation}.`, cause: 'gestación pagada con la reserva de la madre', source: 'simulation' });
}

// ── Intentos recibidos ────────────────────────────────────────────────────────────────────────────────────

const datoMateria = (rol: Rol): Float64Array => {
  const d = new Float64Array(2);
  d[DATO_MATERIA.rol] = rol; d[DATO_MATERIA.forma] = 0;
  return d;
};
const masaPares = (c: CtxLeyMateria, pares: Float64Array): number => {
  let mg = 0;
  for (let i = 0; i + 1 < pares.length; i += 2) if (pares[i]! > 0) mg += pares[i + 1]! * c.quimica.sustancia(pares[i]!).masa;
  return mg / 1e6;
};

function aplicarGolpear(cl: CtxLey, i: Intento): Aplicado {
  const c = ctxMateriaDe(cl.mundo), e = estado(c), f = filaDeRef(e, i.a);
  if (!f || !i.dato) return 'paso';
  const a = f.animal, cu = a.cuerpo!, fa = a.fauna!;
  // La defensa (cuernos, colmillos, cuero) reparte el golpe: llega trabajo/(1 + defensa).
  const golpe = Float64Array.from(i.dato);
  golpe[DATO_GOLPEAR.trabajo] = golpe[DATO_GOLPEAR.trabajo]! / (1 + sat01(fa.genoma[GEN.defensa] ?? 0));
  const masa = masaDe(c, cu), celda = c.terreno.celda(a.x, a.y);
  const carne = herir(c, cu, golpe, FRACTURA_TEJIDO);
  let arrancado = 0;
  if (carne !== REF_NULA && c.materia.vivo(carne)) {
    arrancado = c.materia.vista(carne).masa;
    // La carne arrancada cae a su celda como un trozo de cadáver.
    if (celda >= 0) {
      const todo = { parte: Parte.Todo, esp: 0, cuantos: 0, kappa: null };
      if (propia(c, celda)) {
        const trozo = c.materia.lotes(celda, Rol.Cadaver, e.buf) > 0 ? e.buf[0]! : c.materia.nuevo(Rol.Cadaver, celda, 0);
        c.materia.moverParte(carne, trozo, todo);
      } else depositar(c, celda, Rol.Cadaver, 0, Float64Array.from(c.materia.garantizar(carne, todo, c.libro)));
      c.materia.liberar(carne);
    }
  }
  fa.heridoPor = c.frente.uid[slotDe(i.de)] ?? 0; fa.heridoEn = c.tick;
  const susto = masa > 0 ? arrancado / masa : 0;
  fa.sobresalto = sobresaltoActual(fa, c.tick) + susto; fa.sobresaltoDesde = c.tick;
  if (propia(c, celda)) subirAlarma(c, celda, susto);
  return 'hecho';
}

/** Extracción no letal: un `Tomar` dirigido a un animal propio, con `DATO_TOMAR.rol` = Reserva («ordeñar») o Tejido
 * («esquilar»: la fibra) y los gramos pedidos en `DATO_TOMAR.cuantos` (con `esp` = 0). La consiente si su miedo es menor
 * que su reserva relativa; cada extracción le sube el sobresalto en Δmasa/masa. Se contesta siempre con `Concedido`. */
function aplicarTomar(cl: CtxLey, i: Intento): Aplicado {
  const c = ctxMateriaDe(cl.mundo), e = estado(c), f = filaDeRef(e, i.a);
  if (!f || !i.dato) return 'paso';
  const rol = i.dato[DATO_TOMAR.rol], parte = rol === Rol.Reserva ? 'reserva' : rol === Rol.Tejido ? 'fibra' : null;
  if (parte === null) return 'paso';
  const a = f.animal, cu = a.cuerpo!, fa = a.fauna!;
  vistaCuerpo(c, cu, f.vista);
  const miedo = fa.miedo + sobresaltoActual(fa, c.tick);
  const kg = Math.max(0, (i.dato[DATO_TOMAR.cuantos] ?? 0) / 1000);
  const garantia = miedo < f.vista.energia && kg > 0 ? extraer(c, cu, parte, kg) : new Float64Array(0);
  const masa = f.vista.masa, sacado = masaPares(c, garantia);
  fa.sobresalto = sobresaltoActual(fa, c.tick) + (masa > 0 ? sacado / masa : 0);
  fa.sobresaltoDesde = c.tick;
  const por = c.frente.uid[slotDe(i.de)] ?? 0;
  if (sacado > 0) { fa.extraido = { que: parte, tick: c.tick, por }; a.tends = (a.tends ?? 0) + 1; a.lastTended = c.tick; }
  const destino = i.dato[DATO_TOMAR.loteDestino] ?? REF_NULA;
  if (c.params.v23.intentos) enviar(c, i.de, { tipo: TipoIntento.Concedido, de: f.ref, celda: i.celda, lote: destino,
    nonce: i.nonce, materia: garantia, dato: datoMateria(Rol.Objeto), bytes: null });
  else if (garantia.length) c.materia.abonar(destino, garantia, c.libro);
  return 'hecho';
}

// ── Proyección e invariantes ──────────────────────────────────────────────────────────────────────────────

function proyectarAnimal(cl: CtxLey, animal: Animal, vista: AnimalView): void {
  const cu = animal.cuerpo, fa = animal.fauna;
  if (!cu || !fa) return;
  const c = ctxMateriaDe(cl.mundo), v = vistaCuerpo(c, cu, vistaVacia()), pl = plantillaDe(c, cu);
  const tejido = c.materia.vista(cu.tejido);
  vista.cuerpoVisto = {
    masa: v.masa, masaAdulta: pl.masaAdulta, reserva: v.energia, agua: sat01(1 - v.sed),
    digestivo: c.materia.vista(cu.digestivo).masa, carga: v.carga, T: v.T, principal: tejido.principal,
    ...(cu.gestacion ? { embrion: { masa: c.materia.vista(cu.gestacion.embrion).masa, m0: pl.m0, otro: cu.gestacion.otro } } : {}),
  };
  vista.v23 = {
    miedo: sat01(fa.miedo), linaje: pl.linaje,
    ...(fa.persigue > 0 ? { persigue: fa.persigue } : {}),
    ...(fa.huyeDe > 0 ? { huyeDe: fa.huyeDe } : {}),
    ...(fa.extraido ? { extraido: { ...fa.extraido } } : {}),
  };
}

function comprobarFauna(cl: CtxLey): Violacion[] {
  const fuera: Violacion[] = [];
  const c = ctxMateriaDe(cl.mundo), ocupacion = new Map<number, number>(), lotes: LoteRef[] = [];
  const falla = (id: string, detalle: string, muestra?: unknown): void => { fuera.push({ id, gravedad: 'dura', tick: c.tick, detalle, muestra }); };
  for (const a of c.mundo.animals) {
    if (!a.cuerpo || !a.fauna) { falla('F-cuerpo', 'Animal sin cuerpo con v23.fauna encendida.', a.id); continue; }
    lotes.length = 0;
    for (const l of lotesDe(a.cuerpo, lotes)) if (!c.materia.vivo(l)) falla('F-lote', 'Lote de un cuerpo animal caducado.', { id: a.id, lote: l });
    if (a.fauna.genoma.length !== GENES_FAUNA || a.fauna.genoma.some(g => !Number.isFinite(g))) falla('F-genoma', 'Genoma de fauna inválido.', a.id);
    const celda = c.terreno.celda(a.x, a.y);
    if (celda < 0) { falla('F-celda', 'Animal fuera de las celdas residentes.', a.id); continue; }
    ocupacion.set(celda, (ocupacion.get(celda) ?? 0) + huella(masaDe(c, a.cuerpo)));
  }
  for (const [celda, m2] of ocupacion) if (m2 > AREA_CELDA * (1 + 1e-9)) {
    fuera.push({ id: 'F-huella', gravedad: 'dura', tick: c.tick, detalle: 'La huella de la fauna de una celda supera su área.',
      esperado: AREA_CELDA, observado: m2, muestra: celda });
  }
  return fuera;
}

// ── La ley ────────────────────────────────────────────────────────────────────────────────────────────────

function barajar<T>(c: CtxLey, v: T[]): void {
  for (let i = v.length - 1; i > 0; i--) {
    const j = Math.floor(c.azar() * (i + 1)), t = v[i]!;
    v[i] = v[j]!; v[j] = t;
  }
}

export const leyFauna: Ley = {
  id: 'f', interruptor: 'fauna', sustituye: ['fauna'],
  columnas: [[COLUMNA_FAUNA, 'f32', FAUNA_ANCHO]],
  camposTerreno: [['alarma', 'f64', 0], ['alarmaDesde', 'f64', 0]],
  iniciar(cl) { sincronizar(ctxMateriaDe(cl.mundo)); },
  alAdoptar(cl, o) {
    if (!('fauna' in o) || !o.cuerpo) return;
    const c = ctxMateriaDe(cl.mundo);
    for (const l of lotesDe(o.cuerpo, [])) c.materia.adoptar(l);
  },
  F1(cl) {
    const c = ctxMateriaDe(cl.mundo);
    sincronizar(c);
    if (c.tick % TAU_ALARMA === 0) podarAlarmaLocal(c);
  },
  F2(cl) {
    const c = ctxMateriaDe(cl.mundo), e = estado(c);
    e.ocupacion.clear(); e.aguaVecina.clear();
    for (const f of e.filas.values()) {
      vistaCuerpo(c, f.animal.cuerpo!, f.vista);
      const celda = c.terreno.celda(f.animal.x, f.animal.y);
      f.huellaContada = celda >= 0 ? huella(f.vista.masa) : 0;
      if (celda >= 0) e.ocupacion.set(celda, (e.ocupacion.get(celda) ?? 0) + f.huellaContada);
    }
    // Quien aún no tiene fila (un chunk que vuelve del archivo: el alta llega en F4) ya ocupa su celda: si no contara,
    // otro podría entrar en ella este tick y la huella pasaría del área.
    if (e.filas.size !== c.mundo.animals.length) for (const a of c.mundo.animals) {
      if (!a.cuerpo || e.filas.has(a)) continue;
      const celda = c.terreno.celda(a.x, a.y);
      if (celda >= 0) e.ocupacion.set(celda, (e.ocupacion.get(celda) ?? 0) + huella(masaDe(c, a.cuerpo)));
    }
    medirPasto(c, e);
    for (const f of e.filas.values()) percibir(c, e, f);
  },
  F3(cl) {
    const c = ctxMateriaDe(cl.mundo), e = estado(c), azar = (): number => c.azar();
    for (const f of e.filas.values()) { prepararYo(c, f); elegirFaunaV23(f.yo, f.percepcion, azar, f.decision); }
  },
  F4(cl) {
    const c = ctxMateriaDe(cl.mundo), e = estado(c), orden = e.orden;
    orden.length = 0;
    for (const f of e.filas.values()) orden.push(f);
    barajar(c, orden);
    e.partos.length = 0;
    for (const f of orden) actuar(c, e, f);
    barajar(c, orden);
    for (const f of orden) moverse(c, e, f);
    for (const f of orden) {
      alimentarse(c, e, f);
      vistaCuerpo(c, f.animal.cuerpo!, f.vista);
      reflejar(c, f);
      solicitarCruce(c, f);
    }
  },
  F5(cl) {
    const c = ctxMateriaDe(cl.mundo), e = estado(c);
    // Antes de encender intentos, F5 resuelve los mordiscos locales que no pasan por la cola A.
    for (const i of e.mordiscos) aplicarGolpear(c, i);
    e.mordiscos.length = 0;
    for (const f of [...e.filas.values()]) {
      const causa = causaDeMuerte(c, f);
      if (!causa) continue;
      const por = causa === 'caza humana' || causa === 'depredación' ? c.idDe(f.animal.fauna!.heridoPor) : undefined;
      matarAnimal(c, f.animal, causa, por);
    }
    for (const f of e.partos) if (e.filas.get(f.animal) === f) nacer(c, e, f);
    e.partos.length = 0;
    admitirCruces(c, e);
    syncFauna(c.mundo.tiles, c.mundo.animals);
  },
  F6(cl) {
    const c = ctxMateriaDe(cl.mundo), e = estado(c), w = c.escritura;
    sincronizar(c);
    for (const f of e.filas.values()) {
      const a = f.animal, fa = a.fauna!, celda = c.terreno.celda(a.x, a.y);
      vistaCuerpo(c, a.cuerpo!, f.vista);
      escribirFilaFaunaV23(w, {
        slot: slotDe(f.ref), uid: a.uid ?? 0, x: a.x, y: a.y, chunk: celda < 0 ? -1 : c.terreno.chunkDe(celda),
        objetivo: c.terreno.celda(a.target.x, a.target.y), accion: ACTIONS.indexOf(a.action), tick: c.tick,
        fertil: f.fertil, vista: f.vista, genoma: fa.genoma, miedo: fa.miedo, habituacion: fa.habituacion,
        huella: huella(f.vista.masa), velocidad: velocidadDe(f.vista.masa, fa.genoma[GEN.velocidad] ?? 0.5),
      });
    }
  },
  aplicar: { Golpear: aplicarGolpear, Tomar: aplicarTomar, Cruzar: aplicarCruzar, Admitido: aplicarAdmitido },
  proyectar: { animal: proyectarAnimal },
  comprobar: comprobarFauna,
};
