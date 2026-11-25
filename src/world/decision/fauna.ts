import type { AnimalAction, AnimalSpecies } from '../../shared/life.js';
import {
  MEMORY_TTL, RADIO_PAREJA, RAZON_PAREJA, RAZON_REPOSO_CRIA, SPECIES, hashCerrar, hashParcial, listoParaCriar, listoSalvoEnergia,
  type Animal, type AnimalMemory, type AnimalWorld,
} from '../animals.js';
import { Clase, type Consulta, type ConsultaOrganismo, type Plan } from '../motor/contratos.js';
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
      if (other.id === id || other.health <= 0) continue;
      const d = Math.abs(other.x - ax) + Math.abs(other.y - ay);
      if (other.genes.carnivory >= 0.6 && coincide(plan, other, d, 0, plan.presas)) threats.push(other);
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
