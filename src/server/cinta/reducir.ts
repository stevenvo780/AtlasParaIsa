import type { Nivel } from '../../shared/cinta.js';
import type { AnimalView, PersonView, Species, Tile, WorldView } from '../../shared/types.js';
import { CHUNK_SIZE } from '../../world/terrain.js';

/** Cada fila cuenta organismos sobre las mismas 256 teselas. Una fila ausente representa un chunk vacío. */
export interface DensidadCinta {
  chunkX: number;
  chunkY: number;
  personas?: number;
  fauna?: Partial<Record<Species, number>>;
}

type Reducible<T, K extends keyof T> = Pick<T, K> & Partial<T>;

/** Vista decodificada. Los niveles gruesos pueden omitir telemetría y añadir la cabecera de densidades. */
export type VistaCinta = Omit<WorldView, 'people' | 'animals' | 'tiles'> & {
  people: Reducible<PersonView, 'id' | 'x' | 'y' | 'name' | 'role' | 'color' | 'action'>[];
  animals?: Reducible<AnimalView, 'id' | 'x' | 'y' | 'species' | 'action'>[];
  tiles: Reducible<Tile, 'x' | 'y' | 'terrain'>[];
  densidades?: DensidadCinta[];
};

function sinAusentes<T extends object>(registro: T): T {
  for (const clave of Object.keys(registro) as (keyof T)[]) {
    if (registro[clave] === undefined) delete registro[clave];
  }
  return registro;
}

// El contrato congelado de bloques y deltas usa WorldView también para las vistas reducidas.
function enContrato(vista: VistaCinta): WorldView & VistaCinta {
  return sinAusentes(vista) as WorldView & VistaCinta;
}

// Ancho de banda en centésimas, según los cambios significativos de la cinta anterior.
const BANDAS = { cultivation: 4, traffic: 5, food: 12, drinkingWater: 12, vegetation: 12, moisture: 15, growth: 12, fertility: 12 } as const;
const camposBandeados = Object.keys(BANDAS) as (keyof typeof BANDAS)[];

function teselaBandeada(tesela: Tile): Tile {
  const reducida = { ...tesela };
  for (const campo of camposBandeados) {
    const valor = tesela[campo];
    if (valor === undefined) continue;
    const ancho = BANDAS[campo];
    const banda = Math.round(valor * 100 / ancho) * ancho / 100;
    reducida[campo] = valor <= 1 ? Math.min(1, banda) : banda;
  }
  return reducida;
}

function estadoPersona({ id, x, y, name, role, color, action, communityId, lifeStage }: PersonView) {
  return { id, x, y, name, role, color, action,
    ...(communityId === undefined ? {} : { communityId }), ...(lifeStage === undefined ? {} : { lifeStage }) };
}

function personaSinTelemetria(persona: PersonView) {
  const { reason, need, recentMemory, specialty, controlMode, blueprintId, working, target, craftTint, craftFocus } = persona;
  return sinAusentes({ ...estadoPersona(persona), reason, need, recentMemory, specialty,
    controlMode, blueprintId, working, target, craftTint, craftFocus });
}

function animalSinTelemetria({ id, species, x, y, action, reason, generation, parents, genes, morphology }: AnimalView) {
  return sinAusentes({ id, species, x, y, action, reason, generation, parents, genes, morphology });
}

function terreno({ x, y, terrain, biome }: Tile) {
  return biome === undefined ? { x, y, terrain } : { x, y, terrain, biome };
}

function densidades(personas: readonly PersonView[], fauna: readonly AnimalView[]): DensidadCinta[] {
  const celdas = new Map<string, DensidadCinta>();
  function celda({ x, y }: { x: number; y: number }): DensidadCinta {
    const chunkX = Math.floor(x / CHUNK_SIZE), chunkY = Math.floor(y / CHUNK_SIZE);
    const clave = `${chunkX},${chunkY}`;
    const anterior = celdas.get(clave);
    if (anterior) return anterior;
    const nueva = { chunkX, chunkY };
    celdas.set(clave, nueva);
    return nueva;
  }
  for (const persona of personas) {
    const fila = celda(persona);
    fila.personas = (fila.personas ?? 0) + 1;
  }
  for (const animal of fauna) {
    const fila = celda(animal);
    const especies = fila.fauna ??= {};
    especies[animal.species] = (especies[animal.species] ?? 0) + 1;
  }
  return [...celdas.values()].sort((a, b) => a.chunkY - b.chunkY || a.chunkX - b.chunkX);
}

/** Los niveles reducidos omiten campos obligatorios de la vista en vivo. El lector debe respetar su escala. */
export function reducir(nivel: Nivel, vista: WorldView, notables?: ReadonlySet<string>): WorldView & VistaCinta {
  if (nivel === 0) return vista;
  if (nivel === 1) {
    return enContrato({ ...vista, people: vista.people.map(personaSinTelemetria), animals: vista.animals?.map(animalSinTelemetria),
      tiles: vista.tiles.map(teselaBandeada) });
  }

  const { version, sequence, tick, day, phase, weather, width, height, originX, originY, infinite, geologyKey, instanceId,
    activeChunks, discoveredChunks, settlementCount, structures, communities } = vista;
  const base = { version, sequence, tick, day, phase, weather, width, height, originX, originY, infinite, geologyKey, instanceId,
    activeChunks, discoveredChunks, settlementCount, structures, places: [], events: [], memories: [] };
  if (nivel === 2) {
    return enContrato({ ...base, communities, tiles: vista.tiles.map(terreno), people: vista.people.map(estadoPersona),
      densidades: densidades([], vista.animals ?? []) });
  }

  return enContrato({
    ...base,
    communities: communities?.map(c => ({ ...c, members: [], memberCount: c.memberCount ?? c.members.length })),
    tiles: [],
    people: nivel === 3 ? vista.people.filter(p => notables?.has(p.id)).map(estadoPersona) : [],
    densidades: densidades(vista.people, nivel === 4 ? vista.animals ?? [] : []),
  });
}
