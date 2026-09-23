import type { TechnologyProgram, TechnologyProject } from '../../src/shared/technology.js';
import { createWorld, type Person, type World } from '../../src/world/index.js';
import { HISTORICAL_PARAMS, type WorldParams } from '../../src/world/params.js';
import { initialDemography } from '../../src/world/demography.js';
import { captureTechnologyCheckpoint } from '../../src/world/technology-checkpoint.js';
import { technologyWorkCost } from '../../src/world/technology.js';

/** El programa de investigación más usado por las pruebas: una piedra con filo, comprimida. Es un
 * objeto compartido: quien necesite uno propio (por ejemplo, para mutarlo) usa `structuredClone`. */
export const PROGRAMA_FILO: TechnologyProgram = {
  inputs: [{ source: 'raw', material: 'stone', mass: 1000 }],
  steps: [{ op: 'form', intensity: 4, shape: 'edge' }, { op: 'compress', intensity: 2 }],
};

/** Proyecto de investigación recién empezado, con el trabajo que exige la ley (`technologyWorkCost`). */
export function proyectoInvestigacion(program: TechnologyProgram, startedAt: number, parents: string[] = []): TechnologyProject {
  return { kind: 'research', program, parents, recipeId: null, progress: 0, requiredWork: technologyWorkCost(program), energyPaid: 0, startedAt };
}

export interface OpcionesAula {
  /** Leyes del mundo; sin ellas, los defaults de `createWorld`. */
  params?: WorldParams;
  /** Estado corporal que se fija a todos los habitantes. */
  cuerpo: Pick<Person, 'energy' | 'fatigue' | 'hunger' | 'thirst'>;
  /** Si se da, aplaza la próxima decisión de todos hasta ese tick. */
  decisionAt?: number;
  /** Vacía los materiales de todos (por defecto sí). */
  vaciarMateriales?: boolean;
  /** Pone `lastSocial = -30`, para que nadie arrastre un encuentro reciente (por defecto sí). */
  sinEncuentroReciente?: boolean;
}

/**
 * La escena de maestro y aprendiz de la semilla 51926: todos descansan en (10,20) sin competencias
 * y los habitantes 2 y 3 quedan juntos, aparte, en (36,12). Cada prueba fija después lo suyo
 * (materiales del maestro, programas, etc.).
 */
export function aula({ params, cuerpo, decisionAt, vaciarMateriales = true, sinEncuentroReciente = true }: OpcionesAula): { world: World; maestro: Person; aprendiz: Person } {
  const world = params ? createWorld(51926, params) : createWorld(51926);
  const maestro = world.people[2]!, aprendiz = world.people[3]!;
  for (const person of world.people) {
    person.x = 10; person.y = 20; person.target = { x: 10, y: 20 }; person.action = 'rest';
    person.skills = {};
    if (vaciarMateriales) person.materials = { wood: 0, stone: 0 };
    if (sinEncuentroReciente) person.lastSocial = -30;
    person.energy = cuerpo.energy; person.fatigue = cuerpo.fatigue; person.hunger = cuerpo.hunger; person.thirst = cuerpo.thirst;
    if (decisionAt !== undefined) person.decisionAt = decisionAt;
  }
  for (const person of [maestro, aprendiz]) { person.x = 36; person.y = 12; person.target = { x: 36, y: 12 }; }
  return { world, maestro, aprendiz };
}

/**
 * Escena familiar seca de las pruebas de forrajeo: leyes históricas, tick 1000, cielo claro, sin
 * fauna ni recursos en el suelo, y todos los habitantes descansando sin comunidad ni vínculos, con
 * la demografía reiniciada a su edad. Es un montaje finito, no una población alcanzada.
 */
export function escenaFamiliaSeca(seed: number): World {
  const world = createWorld(seed, HISTORICAL_PARAMS); world.tick = 1000; world.weather = 'clear'; world.animals = [];
  for (const tile of world.tiles) { tile.food = tile.vegetation = tile.moisture = tile.fertility = tile.fauna = 0; }
  for (const person of world.people) {
    person.hunger = person.thirst = person.fatigue = .1; person.energy = .9; person.inventory = 0;
    person.action = 'rest'; person.target = { x: person.x, y: person.y }; person.decisionAt = 100000;
    person.communityId = null; person.bonds = {}; person.demography = initialDemography(world.tick - person.bornAt);
  }
  return world;
}

/** Un habitante sintético clonado de un vecino real: forma válida completa (genoma, tecnología,
 * demografía…) sin recalcular genética, para pruebas de escala que solo miran tamaño y visibilidad. */
export function clonarVecino(world: World, id: string, name: string, lugar: { x: number; y: number }, communityId: string | null): Person {
  const clone = structuredClone(world.people.find(p => p.role === 'neighbor')!);
  clone.id = id; clone.name = name; clone.role = 'neighbor'; clone.communityId = communityId;
  clone.x = lugar.x; clone.y = lugar.y; clone.target = { x: lugar.x, y: lugar.y };
  return clone;
}

/**
 * Tras inyectar habitantes sin nacimiento, el checkpoint tecnológico tiene que conocerlos, como hace
 * `stepWorld` en cada paso (`advanceTechnologyCheckpoint`). Si no, `analyzeTechnologyOrganization`
 * (que llama `projectWorld`) trata cada id inyectado como nunca registrado y llena `organization`
 * de diagnósticos: un artefacto de saltarse el nacimiento, no una conducta real.
 */
export function registrarInyectados(world: World): void {
  world.technology.checkpoint = captureTechnologyCheckpoint(world.technology, world.people, world.tick, 'migration');
}
