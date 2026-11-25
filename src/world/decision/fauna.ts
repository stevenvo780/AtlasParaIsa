import type { AnimalAction, AnimalSpecies } from '../../shared/life.js';
import {
  MEMORY_TTL, RADIO_PAREJA, RAZON_PAREJA, RAZON_REPOSO_CRIA, SPECIES, hashCerrar, hashParcial, listoParaCriar, listoSalvoEnergia,
  type Animal, type AnimalMemory, type AnimalWorld,
} from '../animals.js';
import { Clase, type Consulta, type ConsultaOrganismo, type Plan, type Ref } from '../motor/contratos.js';
import { ALFA_HABITUACION, C_MOVER, VIDA_EXPONENTE, VIDA_L0 } from '../../shared/naturaleza.js';
import { primero, primerosDos } from '../orden.js';

interface Point { x: number; y: number; }
interface Resource extends Point { food: number; water: number; }
export interface VisibleTile extends Resource {
  /** `growth ?? 0` de la celda: lo único que la decisión mira del crecimiento (el alimento ya lo incluye). */
  brote: number; novelty: number | undefined;
  /** Los animales en la celda al empezar la decisión (`ocupantes(x, y)`). */
  ocupantes: readonly Animal[] | undefined;
}

export interface PercepcionFauna {
  visibles(animal: Animal, plan: PlanFauna): readonly VisibleTile[];
  ocupantes(x: number, y: number): readonly Animal[] | undefined;
  residente(t: Point): boolean;
  visto(dx: number, dy: number): boolean;
  recordar(animal: Animal, tile: Point, tick: number, visited: boolean, food: number, water: number): void;
  resources: Resource[];
  adjacent: VisibleTile[];
  encuentro: boolean;
  reserva: boolean;
}

const distancia = (a: Point, b: Point): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const canonical = (a: Animal, b: Animal): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// Campos del terreno de la fase de fauna. Los dos últimos preservan el umbral estricto de disponibilidad.
const HABITAT = 0, AGUA = 1, ALIMENTO = 2, HAY_AGUA = 3, HAY_ALIMENTO = 4;
const recurso = (campo: number, disponible: number): Consulta => ({
  campos: Int32Array.of(campo), pesos: Float32Array.of(-1), pesoDist: 2, pesoPasos: 0,
  filtros: Float32Array.of(disponible, 1, 1), alcanzable: false,
});
const RECURSOS = [recurso(AGUA, HAY_AGUA), recurso(ALIMENTO, HAY_ALIMENTO)] as const;
const DIETA: Readonly<Partial<Record<AnimalSpecies, readonly AnimalSpecies[]>>> = {
  wolf: ['hare', 'deer', 'boar', 'fox'], fox: ['hare'],
};
export function presaDe(especie: AnimalSpecies, presa: AnimalSpecies): boolean {
  return DIETA[especie]?.includes(presa) ?? false;
}

export interface PlanFauna extends Plan {
  readonly radio: number;
  readonly presas: number;
  readonly pareja: number;
}

function consultaDe(especie: AnimalSpecies, radio: number, columnaEspecie: number): ConsultaOrganismo {
  const codigo = SPECIES.indexOf(especie);
  return { radio, clase: Clase.Animal, filtros: Float32Array.of(columnaEspecie, 0, codigo, codigo),
    criterio: 0, columna: 0, componente: 0 };
}

const planes = new Map<string, PlanFauna>();
export function planFauna(animal: Animal, columnaEspecie: number): PlanFauna {
  const { species, genes } = animal;
  const radio = 2 + Math.floor(genes.perception * 4), radioAmenaza = Math.min(radio, 1 + Math.floor(genes.perception * 5));
  const clave = `${columnaEspecie}:${species}:${radio}:${radioAmenaza}`;
  let plan = planes.get(clave);
  if (!plan) {
    const amenazas = SPECIES.filter(e => presaDe(e, species)).map(e => consultaDe(e, radioAmenaza, columnaEspecie));
    const presas = (DIETA[species] ?? []).map(e => consultaDe(e, radio, columnaEspecie));
    const habitat = species === 'fish' ? 1 : 0;
    plan = { id: planes.size, radio, transitable: Float32Array.of(HABITAT, habitat, habitat), celdas: RECURSOS,
      organismos: [...amenazas, ...presas, consultaDe(species, RADIO_PAREJA, columnaEspecie)], presas: amenazas.length,
      pareja: amenazas.length + presas.length, acciones: 0, w: null };
    planes.set(clave, plan);
  }
  return plan;
}

export function habitableParaPlan(plan: PlanFauna, agua: boolean, refugio: boolean): boolean {
  const habitat = agua ? 1 : refugio ? 2 : 0;
  return habitat >= plan.transitable[1]! && habitat <= plan.transitable[2]!;
}

function coincide(plan: PlanFauna, otro: Animal, distancia: number, desde: number, hasta: number): boolean {
  const codigo = SPECIES.indexOf(otro.species);
  for (let i = desde; i < hasta; i++) {
    const consulta = plan.organismos[i]!;
    if (distancia <= consulta.radio && codigo >= consulta.filtros[2]! && codigo <= consulta.filtros[3]!) return true;
  }
  return false;
}

/** `primero` de los recursos con el comparador de la consulta: distancia por `pesoDist`, luego el valor por su peso y
 * luego la posición. El peso de distancia domina a los valores unitarios; compararlos por separado conserva los
 * desempates en f64. Agua y alimento van por separado para leer el campo sin clave dinámica. */
function mejorAgua(consulta: Consulta, recursos: readonly Resource[], ax: number, ay: number): Resource | undefined {
  const pesoDist = consulta.pesoDist, peso = consulta.pesos[0]!;
  let best: Resource | undefined, bd = 0;
  for (const r of recursos) {
    if (!(r.water > 0.001)) continue;
    const d = Math.abs(r.x - ax) + Math.abs(r.y - ay);
    if (!best || ((d - bd) * pesoDist || (r.water - best.water) * peso || r.y - best.y || r.x - best.x) < 0) { best = r; bd = d; }
  }
  return best;
}
function mejorAlimento(consulta: Consulta, recursos: readonly Resource[], ax: number, ay: number): Resource | undefined {
  const pesoDist = consulta.pesoDist, peso = consulta.pesos[0]!;
  let best: Resource | undefined, bd = 0;
  for (const r of recursos) {
    if (!(r.food > 0.001)) continue;
    const d = Math.abs(r.x - ax) + Math.abs(r.y - ay);
    if (!best || ((d - bd) * pesoDist || (r.food - best.food) * peso || r.y - best.y || r.x - best.x) < 0) { best = r; bd = d; }
  }
  return best;
}

/** Distancia de `p` al depredador más cercano. */
function safety(threats: readonly Animal[], p: Point): number {
  let min = Infinity;
  for (const t of threats) min = Math.min(min, distancia(t, p));
  return min;
}
/** Atractivo de explorar la tesela: función pura de la tesela, calculada una vez (`t.novelty`) y no en cada comparación. */
/** `prefijo` es el estado del hash de `${animal.id}:` con la semilla, común a todas las celdas del animal. */
function novelty(animal: Animal, prefijo: number, tick: number, t: VisibleTile): number {
  let value = t.novelty;
  if (value === undefined) {
    let visit: AnimalMemory | undefined;
    for (const m of animal.memory) if (m.visited && m.x === t.x && m.y === t.y) { visit = m; break; }
    value = (visit ? Math.min(1, (tick - visit.tick) / MEMORY_TTL) : 2)
      + hashCerrar(hashParcial(prefijo, `${t.x},${t.y}:${Math.floor(tick / 60)}`)) / 4294967296 * 0.2;
    t.novelty = value;
  }
  return value;
}
function parejaCercana(animal: Animal, state: PercepcionFauna, plan: PlanFauna): Animal | undefined {
  const consulta = plan.organismos[plan.pareja]!;
  let mate: Animal | undefined, best = Infinity;
  const ax = animal.x, ay = animal.y;
  for (let dy = -consulta.radio; dy <= consulta.radio; dy++) {
    const span = consulta.radio - Math.abs(dy);
    for (let dx = -span; dx <= span; dx++) {
      const here = state.ocupantes(ax + dx, ay + dy);
      if (!here) continue;
      const d = Math.abs(dx) + Math.abs(dy);
      if (d > best) continue;
      for (const other of here) {
        if (other === animal || other.id === animal.id || !(other.health > 0) || !coincide(plan, other, d, plan.pareja, plan.organismos.length)
          || !listoParaCriar(other, state.reserva)) continue;
        if (!mate || d < best || canonical(other, mate) < 0) { mate = other; best = d; }
      }
    }
  }
  return mate;
}
export function decidirFauna(animal: Animal, world: AnimalWorld, state: PercepcionFauna, plan: PlanFauna): void {
  const visible = state.visibles(animal, plan), threats: Animal[] = [];
  const ax = animal.x, ay = animal.y, id = animal.id, carnivoro = animal.genes.carnivory >= 0.6;
  let prey: Animal | undefined, dPrey = 0;
  const [agua, alimento] = plan.celdas;
  for (const t of visible) {
    const aqui = t.ocupantes;
    if (!aqui) continue;
    for (const other of aqui) {
      // Un herbívoro solo mira a los carnívoros (amenazas); las comprobaciones son lecturas puras, en otro orden.
      const amenaza = other.genes.carnivory >= 0.6;
      if (!amenaza && !carnivoro || other.id === id || other.health <= 0) continue;
      const d = Math.abs(other.x - ax) + Math.abs(other.y - ay);
      if (amenaza && coincide(plan, other, d, 0, plan.presas)) threats.push(other);
      if (carnivoro && coincide(plan, other, d, plan.presas, plan.pareja)
        && (!prey || d < dPrey || d === dPrey && canonical(other, prey) < 0)) { prey = other; dPrey = d; }
    }
  }
  const adjacent = state.adjacent;
  adjacent.length = 0;
  for (const t of visible) if (Math.abs(t.x - ax) + Math.abs(t.y - ay) === 1) adjacent.push(t);
  let action: AnimalAction = 'roam', target: Point = animal, reason = 'Explora celdas cercanas y evita recorridos que recuerda.';
  let preyId: string | null = null;
  // Los dos primeros del mismo orden estable, sin ordenar todo lo visible (orden.ts).
  for (const tile of primerosDos(visible, (a, b) => (b.water + b.brote) - (a.water + a.brote)
    || (Math.abs(a.x - ax) + Math.abs(a.y - ay)) - (Math.abs(b.x - ax) + Math.abs(b.y - ay)) || a.y - b.y || a.x - b.x,
    t => t.brote > 0.05 || t.water > 0.005)) state.recordar(animal, tile, world.tick, Math.abs(tile.x - ax) + Math.abs(tile.y - ay) === 0, tile.food, tile.water);
  if (threats.length) {
    const escape = primero(adjacent, (a, b) => safety(threats, b) - safety(threats, a) || a.y - b.y || a.x - b.x);
    action = 'flee'; target = escape && safety(threats, escape) > safety(threats, animal) ? escape : animal;
    reason = 'Percibe un depredador cercano y se aleja físicamente de su alcance.';
  } else {
    // Mismo orden: rombo visible, seguido de recuerdos válidos que no están en el rombo. Solo se reúnen, y solo se
    // busca el agua o el alimento, cuando la sed o el hambre los van a mirar: son lecturas puras.
    const resources = state.resources;
    const sed = animal.thirst > 0.42, hambre = animal.hunger > 0.38, pasta = hambre && !prey && animal.genes.carnivory < 0.6;
    if (sed || pasta) {
      resources.length = 0;
      for (const t of visible) resources.push(t);
      for (const m of animal.memory) {
        if (world.tick - m.tick > MEMORY_TTL || !state.residente(m)) continue;
        if (!state.visto(m.x - ax, m.y - ay)) resources.push(m);
      }
    }
    const water = sed ? mejorAgua(agua!, resources, ax, ay) : undefined;
    const food = pasta && !water ? mejorAlimento(alimento!, resources, ax, ay) : undefined;
    if (sed && water) { action = 'drink'; target = water; reason = 'La sed orienta su camino hacia agua percibida o recordada.'; }
    else if (hambre && prey) { action = 'hunt'; target = prey; preyId = prey.id; reason = 'Persigue una presa individual visible; alimentarse exige alcanzarla.'; }
    else if (pasta && food) { action = 'graze'; target = food; reason = 'El hambre orienta su camino hacia crecimiento vegetal finito.'; }
    else if (animal.energy < 0.4 || animal.fatigue > 0.55) { action = 'rest'; reason = 'El agotamiento requiere una pausa; descansar no elimina hambre ni sed.'; }
    // Si solo le faltan fuerzas para criar, descansa. El hambre y la sed siguen subiendo durante la recuperación.
    else if (state.encuentro && listoSalvoEnergia(animal, state.reserva)) { action = 'rest'; reason = RAZON_REPOSO_CRIA; }
    else {
      // V19/M: sin amenaza ni necesidad urgente, un animal listo para criar se acerca a la pareja conespecífica
      // lista más cercana (desempate canónico) que detecta por olor o llamada a ≤ `RADIO_PAREJA` celdas: incluye a
      // todas las que ve (su vista es ≤ 6). Es el movimiento pagado de siempre; nadie se traslada ni aparece.
      const mate = state.encuentro && listoParaCriar(animal, state.reserva) ? parejaCercana(animal, state, plan) : undefined;
      if (mate) { target = mate; reason = RAZON_PAREJA; }
      else {
        const prefijo = hashParcial(world.seed >>> 0, `${id}:`), tick = world.tick;
        target = primero(adjacent, (a, b) => novelty(animal, prefijo, tick, b) - novelty(animal, prefijo, tick, a) || a.y - b.y || a.x - b.x) ?? animal;
      }
    }
  }
  if (animal.action !== action || animal.preyId !== preyId) animal.work = 0;
  animal.action = action; animal.target = { x: target.x, y: target.y }; animal.reason = reason; animal.preyId = preyId; animal.lastDecision = world.tick;
}

// ── V23 (`v23.fauna`): decidir sin especies ─────────────────────────────────────────────────────────────────
//
// Todo lo que sigue es una función pura de (genes y cuerpo del animal, lo que percibió en F2, azar del dueño). No lee
// especie ni linaje: carnívoro, presa, amenaza y pareja salen de la masa, la carnivoría, la defensa, la velocidad y la
// distancia genética. Lo arma y lo ejecuta `ley-fauna.ts`.

/** Genes continuos de la fauna en `Gestacion.genoma` y en la columna `genoma` del frente (≤ GENOMA_ANCHO). Todos en
 * [0, 1] salvo `lnMasa` (ln de la masa adulta en kg, sin cota) y `acuatico` (0 o 1: tierra o agua). */
export const GEN = {
  velocidad: 0, percepcion: 1, metabolismo: 2, carnivoria: 3, eficienciaAgua: 4, camuflaje: 5,
  cautela: 6, lnMasa: 7, pelaje: 8, defensa: 9, acuatico: 10,
} as const;
export const GENES_FAUNA = 11;

// ── Constantes físicas (para `shared/naturaleza.ts`) ──────────────────────────────────────────────────────
/** m²·kg^(−2/3): huella = HUELLA_FORMA·masa^(2/3) (sección de un cuerpo de densidad ≈ agua, tumbado o de pie). */
export const HUELLA_FORMA = 1;
/** m²: superficie de una celda para la huella (10 m × 10 m). El mundo no fija metros por tesela; solo la fauna los
 * necesita, y solo como cociente huella/área. */
export const AREA_CELDA = 100;
/** celdas/(tick·kg^VELOCIDAD_EXPONENTE): velocidad de crucero v = VELOCIDAD_L0·masa^VELOCIDAD_EXPONENTE·(½ + gen). */
export const VELOCIDAD_L0 = 0.25;
/** Exponente alométrico de la velocidad máxima de carrera (≈ 0,17 en mamíferos terrestres). */
export const VELOCIDAD_EXPONENTE = 0.17;
/** celdas: radio de visión r = RADIO_VISTA_MIN + RADIO_VISTA_GEN·percepción (2–6, como hoy). */
export const RADIO_VISTA_MIN = 2;
export const RADIO_VISTA_GEN = 4;
/** Alarma por debajo de la cual una celda cuenta como tranquila para habituarse (leyes-opus §3e «alarma ≈ 0»). */
export const ALARMA_CALMA = 0.01;
/** 1/tick: olvido de la habituación sin agentes grandes cerca, h −= OLVIDO_HABITUACION·h (vida media ≈ 3 días). */
export const OLVIDO_HABITUACION = 1 / 10000;
/** Distancia genética máxima para que dos animales críen (Σ |Δgen| en [0, 1] + |Δ ln masa| + 2·|Δ acuático|): dos
 * fundadores distintos quedan siempre por encima, dos hermanos muy por debajo. */
export const DISTANCIA_CRUCE = 1;

const sat01 = (n: number): number => n < 0 ? 0 : n > 1 ? 1 : n;

/** Vida máxima en ticks por alometría: L = VIDA_L0·masa^VIDA_EXPONENTE. */
export const vidaMaxima = (masaAdultaKg: number): number => VIDA_L0 * Math.max(masaAdultaKg, 0) ** VIDA_EXPONENTE;
/** m² que ocupa un cuerpo de `masaKg`. */
export const huella = (masaKg: number): number => HUELLA_FORMA * Math.max(masaKg, 0) ** (2 / 3);
/** celdas/tick de un cuerpo de `masaKg` con el gen de velocidad `gen`. */
export const velocidadDe = (masaKg: number, gen: number): number =>
  VELOCIDAD_L0 * Math.max(masaKg, 1e-3) ** VELOCIDAD_EXPONENTE * (0.5 + sat01(gen));
/** celdas de radio de visión. */
export const radioVista = (percepcion: number): number => RADIO_VISTA_MIN + RADIO_VISTA_GEN * sat01(percepcion);

/** Distancia genética entre dos genomas de fauna (ver DISTANCIA_CRUCE). */
export function distanciaGenetica(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0;
  for (let k = 0; k < GENES_FAUNA; k++) {
    const x = a[k] ?? 0, y = b[k] ?? 0;
    d += k === GEN.lnMasa ? Math.abs(x - y) : k === GEN.acuatico ? 2 * Math.abs(x - y) : Math.abs(x - y);
  }
  return d;
}

/** Miedo = cautela·(1 − habituación)·amenaza + alarma de la celda + sobresalto (extracciones y golpes recientes). */
export const miedoDe = (cautela: number, habituacion: number, amenaza: number, alarma: number, sobresalto = 0): number =>
  sat01(cautela) * (1 - sat01(habituacion)) * Math.max(0, amenaza) + Math.max(0, alarma) + Math.max(0, sobresalto);

/** Habituación tras un tick: sube junto a agentes más grandes si la celda está tranquila, baja con la alarma y se olvida
 * despacio sin contacto (leyes-opus §3e, ley 2). */
export function habituar(h: number, cautela: number, hayGrande: boolean, alarma: number): number {
  let n = sat01(h);
  if (alarma > ALARMA_CALMA) n -= n * Math.min(1, alarma);
  else if (hayGrande) n += ALFA_HABITUACION * (1 - sat01(cautela)) * (1 - n);
  else n -= OLVIDO_HABITUACION * n;
  return sat01(n);
}

/** Otro organismo tal como lo ve un animal en F2 (lectura del frente). */
export interface AgenteVisto {
  ref: Ref; uid: number; persona: boolean;
  x: number; y: number; d: number;
  masa: number; carnivoria: number; velocidad: number; defensa: number;
  /** ¿Consiente criar (columna `pareja` = 0) y está a distancia genética ≤ DISTANCIA_CRUCE? */
  pareja: boolean;
}
/** Una celda del rombo de visión (lectura de `c.terreno`). */
export interface CeldaVista {
  celda: number; x: number; y: number; d: number;
  comida: number;     // campo `comida` (unidades de la vista heredada)
  agua: number;       // agua que se puede beber estando en esta celda (la suya o la de una vecina de agua)
  habitable: boolean; // terreno de su medio (tierra o agua)
  libre: number;      // m² libres para la huella (AREA_CELDA − Σ huellas de quien estaba en ella)
}
/** Lo que un animal percibió en F2. Los arrays se reutilizan entre ticks: valen `nAgentes` y `nCeldas` primeros. */
export interface PercepcionFaunaV23 {
  agentes: AgenteVisto[]; nAgentes: number;
  celdas: CeldaVista[]; nCeldas: number;
  alarma: number;
  /** J digeribles con su κ por unidad del campo `comida` (lo mide el dueño en las celdas propias donde come). */
  jPorComida: number;
  /** J digeribles en carne y cadáveres de su celda (solo celdas propias). */
  carronaJ: number;
}
/** El animal que decide, leído de su cuerpo y su estado. */
export interface YoFauna {
  uid: number; x: number; y: number;
  masa: number; genoma: ArrayLike<number>;
  hambre: number; sed: number; reservaRel: number; reservaJ: number;
  habituacion: number; sobresalto: number;
  fertil: boolean;
  /** J/kg digeribles de la carne para su κ (los de su propio tejido: todos los cuerpos son de la misma química). */
  jPorKgCarne: number;
}
/** La decisión de un tick. `accion` es la de la lista `ACTIONS` (columna `accion`, el cliente la pinta). */
export interface DecisionFaunaV23 {
  accion: AnimalAction; tx: number; ty: number; razon: string;
  presa: Ref; presaUid: number;  // REF_NULA / 0 si no caza
  pareja: number;                // uid de la pareja a la que se acerca o con la que concibe; 0 si ninguna
  huyeDe: number;                // uid de la mayor amenaza; 0 si ninguna
  miedo: number; habituacion: number;
}
export const decisionVacia = (): DecisionFaunaV23 => ({
  accion: 'rest', tx: 0, ty: 0, razon: '', presa: -1, presaUid: 0, pareja: 0, huyeDe: 0, miedo: 0, habituacion: 0,
});

/** J esperados de cazar a `p`: energía digerible de su masa para el κ propio − coste de perseguirla − riesgo
 * (leyes-opus §3e, ley 3). La persecución cuesta C_MOVER·masa·d, más cuanto más rápida sea la presa. */
export function rendimientoPresa(yo: YoFauna, p: AgenteVisto): number {
  const carn = sat01(yo.genoma[GEN.carnivoria] ?? 0);
  const vYo = velocidadDe(yo.masa, yo.genoma[GEN.velocidad] ?? 0.5);
  const persecucion = C_MOVER * yo.masa * p.d * Math.max(1, p.velocidad / Math.max(vYo, 1e-9));
  const riesgo = sat01(p.defensa) * (p.masa / Math.max(yo.masa, 1e-9)) * yo.reservaJ;
  return p.masa * yo.jPorKgCarne * carn - persecucion - riesgo;
}

/**
 * Decide qué hace el animal este tick. Orden: huir si el miedo supera la reserva relativa (el hambriento arriesga más);
 * si no, atender la necesidad mayor (beber, comer: pastar, carroñear o cazar, lo que más rinda en J) o, si es fértil y
 * ve pareja, acercarse; sin nada que hacer, descansar o explorar.
 */
export function elegirFaunaV23(yo: YoFauna, p: PercepcionFaunaV23, azar: () => number, out: DecisionFaunaV23): DecisionFaunaV23 {
  const g = yo.genoma, cautela = g[GEN.cautela] ?? 0.5, carn = sat01(g[GEN.carnivoria] ?? 0);
  const miHuella = huella(yo.masa);
  out.presa = -1; out.presaUid = 0; out.pareja = 0; out.huyeDe = 0; out.tx = yo.x; out.ty = yo.y;
  // Amenaza: Σ (masa del otro / masa propia)·cercanía, con el peso de lo que el otro come: un herbívoro grande no asusta,
  // una persona sí (las personas entran solo como masa, igual que un depredador).
  let amenaza = 0, mayor = 0, cx = 0, cy = 0, hayGrande = false;
  for (let i = 0; i < p.nAgentes; i++) {
    const a = p.agentes[i]!;
    if (a.masa > yo.masa) hayGrande = true;
    const peso = (a.persona ? 1 : sat01(a.carnivoria)) * (a.masa / Math.max(yo.masa, 1e-9)) / (1 + a.d);
    if (!(peso > 0)) continue;
    amenaza += peso; cx += peso * a.x; cy += peso * a.y;
    if (peso > mayor) { mayor = peso; out.huyeDe = a.uid; }
  }
  out.habituacion = habituar(yo.habituacion, cautela, hayGrande, p.alarma);
  out.miedo = miedoDe(cautela, out.habituacion, amenaza, p.alarma, yo.sobresalto);

  if (out.miedo > yo.reservaRel && amenaza > 0) {
    // Huye a la celda vecina habitable que más se aleja del centro de las amenazas.
    const ax = cx / amenaza, ay = cy / amenaza;
    let mejor = -1, lejos = Math.hypot(yo.x - ax, yo.y - ay);
    for (let i = 0; i < p.nCeldas; i++) {
      const cv = p.celdas[i]!;
      if (cv.d !== 1 || !cv.habitable || cv.libre < miHuella) continue;
      const l = Math.hypot(cv.x - ax, cv.y - ay);
      if (l > lejos) { lejos = l; mejor = i; }
    }
    out.accion = 'flee';
    if (mejor >= 0) { out.tx = p.celdas[mejor]!.x; out.ty = p.celdas[mejor]!.y; }
    out.razon = 'Su miedo supera lo que tiene de reserva y se aleja de lo que lo amenaza.';
    return out;
  }
  out.huyeDe = 0;

  // Beber: la celda con agua más cercana (a igualdad, la de más agua).
  let agua = -1;
  for (let i = 0; i < p.nCeldas; i++) {
    const cv = p.celdas[i]!;
    if (!cv.habitable || !(cv.agua > 0) || cv.d > 0 && cv.libre < miHuella) continue;
    const m = agua >= 0 ? p.celdas[agua]! : undefined;
    if (!m || cv.d < m.d || cv.d === m.d && cv.agua > m.agua) agua = i;
  }
  // Comer: pasto (J de la celda para su κ − mover), carroña de su celda o la presa de más rendimiento.
  let pasto = -1, jPasto = 0;
  for (let i = 0; i < p.nCeldas; i++) {
    const cv = p.celdas[i]!;
    if (!cv.habitable || !(cv.comida > 0) || cv.d > 0 && cv.libre < miHuella) continue;
    const j = cv.comida * p.jPorComida * (1 - carn) - C_MOVER * yo.masa * cv.d;
    if (j > jPasto || j === jPasto && pasto >= 0 && azar() < 0.5) { jPasto = j; pasto = i; }
  }
  const jCarrona = p.carronaJ * carn;
  let presa = -1, jPresa = 0;
  for (let i = 0; i < p.nAgentes; i++) {
    const a = p.agentes[i]!;
    if (a.persona) continue;
    const j = rendimientoPresa(yo, a);
    if (j > jPresa) { jPresa = j; presa = i; }
  }
  // Pareja: la más cercana que consiente y es compatible (empates al azar).
  let pareja = -1;
  if (yo.fertil) for (let i = 0; i < p.nAgentes; i++) {
    const a = p.agentes[i]!;
    if (!a.pareja || a.persona) continue;
    if (pareja < 0 || a.d < p.agentes[pareja]!.d || a.d === p.agentes[pareja]!.d && azar() < 0.5) pareja = i;
  }

  const vBeber = agua >= 0 ? yo.sed : -1;
  const vComer = pasto >= 0 || presa >= 0 || jCarrona > 0 ? yo.hambre : -1;
  const vCriar = pareja >= 0 ? yo.reservaRel - Math.max(yo.hambre, yo.sed) : -1;
  if (vBeber > 0 && vBeber >= vComer && vBeber >= vCriar) {
    const cv = p.celdas[agua]!;
    out.accion = 'drink'; out.tx = cv.x; out.ty = cv.y;
    out.razon = 'La sed lo lleva al agua que percibe.';
  } else if (vComer > 0 && vComer >= vCriar) {
    if (jCarrona >= jPasto && jCarrona >= jPresa && jCarrona > 0) {
      out.accion = 'graze';
      out.razon = 'Come la carne que hay donde está.';
    } else if (presa >= 0 && jPresa > jPasto) {
      const a = p.agentes[presa]!;
      out.accion = 'hunt'; out.tx = a.x; out.ty = a.y; out.presa = a.ref; out.presaUid = a.uid;
      out.razon = 'Persigue a la presa que más energía le rinde, descontado lo que cuesta alcanzarla y el riesgo.';
    } else if (pasto >= 0) {
      const cv = p.celdas[pasto]!;
      out.accion = 'graze'; out.tx = cv.x; out.ty = cv.y;
      out.razon = 'El hambre lo lleva a la vegetación que más le rinde.';
    } else explorar(yo, p, miHuella, azar, out);
  } else if (vCriar > 0) {
    const a = p.agentes[pareja]!;
    out.pareja = a.uid; out.tx = a.x; out.ty = a.y;
    out.accion = a.d <= 1.5 ? 'rest' : 'roam';
    out.razon = RAZON_PAREJA;
  } else if (yo.hambre <= 0 && yo.sed <= 0) {
    out.accion = 'rest'; out.razon = 'Saciado, descansa.';
  } else explorar(yo, p, miHuella, azar, out);
  return out;
}

function explorar(yo: YoFauna, p: PercepcionFaunaV23, miHuella: number, azar: () => number, out: DecisionFaunaV23): void {
  let n = 0;
  for (let i = 0; i < p.nCeldas; i++) {
    const cv = p.celdas[i]!;
    if (cv.d !== 1 || !cv.habitable || cv.libre < miHuella) continue;
    // Muestreo de reservorio: una vecina al azar con la misma probabilidad para todas.
    if (azar() * ++n < 1) { out.tx = cv.x; out.ty = cv.y; }
  }
  out.accion = 'roam';
  out.razon = 'Explora las celdas vecinas.';
}

/**
 * Plan de percepción de la fauna V23 para el percibidor del motor (CPU en lote o GPU): mejor pasto y mejor agua de la
 * ventana, y el organismo más cercano de cualquier clase. Es el contrato del despacho; la ley calcula hoy lo mismo en
 * CPU (`ley-fauna.ts`, F2) con las amenazas completas, y lo cambiará por este lote cuando el despacho lo acepte.
 * `campos` son los nombres de `Terreno.campos` de quien percibe.
 */
export function planFaunaV23(campos: readonly string[], id: number, acuatico: boolean): Plan {
  const i = (n: string): number => campos.indexOf(n);
  const terreno = i('terreno'), comida = i('comida'), agua = i('aguaPotable');
  // Códigos de `terreno`: 1 agua, 2 suelo, 3 pradera, 4 refugio (`decision/planes.ts`).
  const medio = acuatico ? Float32Array.of(terreno, 1, 1) : Float32Array.of(terreno, 2, 3);
  const celda = (campo: number): Consulta => ({ campos: Int32Array.of(campo), pesos: Float32Array.of(-1), pesoDist: 0,
    pesoPasos: 0, filtros: Float32Array.of(campo, 0, Infinity), alcanzable: true });
  const organismo: ConsultaOrganismo = { radio: RADIO_VISTA_MIN + RADIO_VISTA_GEN, clase: 0, filtros: new Float32Array(0),
    criterio: 0, columna: 0, componente: 0 };
  return { id, transitable: terreno < 0 ? new Float32Array(0) : medio,
    celdas: comida < 0 || agua < 0 ? [] : [celda(comida), celda(agua)], organismos: [organismo], acciones: 0, w: null };
}
