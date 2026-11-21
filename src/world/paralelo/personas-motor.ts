/**
 * T145 + T151 + T153 — Motor paralelo de la fase `personas`: Fase B en workers, Fase C ordenada.
 *
 * Flujo de un paso:
 *  1. `EstadoPersonasCompartido.empaquetar(escena)` vuelca terreno y personas en `SharedArrayBuffer`
 *     reutilizables (solo crecen; nunca se recrean si caben) y reparte los `actorSlot` por regiones
 *     Morton de lado `regionSide` (256 | 512), troceadas en bloques fijos de `BLOQUE_ACTORES` actores.
 *  2. `PersonasParallelPool.stepPhaseB(estado)` ejecuta la Fase B pura (`personas-worker.ts`) sobre
 *     una `StaticWorkerPool` persistente (con `hilos = 1`, en el propio hilo y sin workers). Cada
 *     actor escribe solo su fila de salida: no hay carreras ni `Atomics`.
 *  3. `confirmarFaseCPersonas(estado)` recoge los `Intent` de los buffers por `actorSlot`, los
 *     confirma con `confirmarIntentos` (orden canónico `(celdaX, celdaY, actorSlot, secuenciaLocal)`)
 *     sobre los stocks finitos del snapshot y reduce los acumuladores con `reduceAggregates`
 *     (`agregados.ts`, orden `(actorSlot, secuenciaLocal)`).
 *
 * Determinismo: la salida de cada actor es función solo del snapshot; la partición (hilos, orden,
 * `regionSide`, bloque) decide QUIÉN calcula, nunca QUÉ sale. La Fase C ordena por contenido.
 * T171: aquí no hay relojes, ni consulta de la máquina, ni azar del proceso. Las medidas de tiempo
 * las toma `piscina.ts`; con `hilos = 1` solo se mide si quien llama inyecta `reloj`.
 *
 * El bucle real usa el despacho ligero de rutas y movimiento; las decisiones y los débitos de
 * recursos siguen en la cadena serial de `bodyAndAction`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Tile } from '../../shared/types.js';
import { mortonCode } from '../gpu/reparto.js';
import { TICKS_PER_DAY, type Person, type World } from '../index.js';
import { demographicTraits } from '../demography.js';
import { waterAvailable } from '../inventions.js';
import { paramsOf } from '../params.js';
import { residentTerrainRevision, residentTopologyToken, sameResidentTopology, type ResidentTopologyToken } from '../soa/topologia.js';
import { containedWaterQuanta } from '../technology-water.js';
import { emptyAggregateBooks, reduceAggregates, type AggregateBooks, type Intent as IntentAgregado, type ReductionCost } from './agregados.js';
import { partitionRegions, type StaticRegion, type StaticRegionOrder } from './particion.js';
import { calcularOcupacionWorkers, StaticWorkerPool, type StaticWorkerDiagnostics } from './piscina.js';
import { confirmarIntentos, type Intent, type ResultadoConfirmacion } from './reduccion.js';
import {
  ACCION, BIOMAS, CELDAS_PERCEPCION, LADO_PERCEPCION, RADIO_PERCEPCION,
  CELDAS_POR_PAGINA, CELDA_CAMINABLE, CELDA_DESIERTO, CELDA_PRESENTE, CELDA_REFUGIO,
  INTENTO_BEBER, INTENTO_COMER, INTENTO_COSECHAR, INTENTO_MADERA, INTENTO_NINGUNO, INTENTO_PIEDRA,
  NPF, NPI, NSF, NSI, PF, PI, SF, SI, TERRENOS, celdaDe, crearVista, ejecutarRegionesPersonas, hashPagina,
  type BuffersPersonas, type ParamsFaseBPersonas, type VistaPersonas,
} from './personas-worker.js';

export type RegionSidePersonas = 256 | 512;

/** Actores por bloque de región: fijo (no depende de `hilos`), para que 28 workers se repartan
 * colas parejas aunque toda la población viva en pocas regiones Morton. */
export const BLOQUE_ACTORES = 16;

/** Lo que la Fase B lee de una tesela (un `Tile` real lo cumple). */
export interface TeselaEntrada {
  x: number; y: number; terrain: string; biome?: string;
  food: number; drinkingWater?: number; wood?: number; stone?: number;
}

/** Lo que la Fase B lee de una persona al inicio del paso. */
export interface PersonaEntrada {
  x: number; y: number; targetX: number; targetY: number;
  hunger: number; thirst: number; fatigue: number; energy: number;
  inventory: number; wood: number; stone: number;
  traits: { curiosity: number; sociability: number; industriousness: number; care: number; resilience: number };
  heading: number;
  action: keyof typeof ACCION;
  needsDecision: boolean;
  shouldMove: boolean;
  /** `containedWaterQuanta / 1000` (carga de agua para `planAffordable`). */
  payload?: number;
  /** `demographicTraits(genome).foodDemand / waterDemand` (1 por defecto). */
  foodDemand?: number;
  waterDemand?: number;
  /** Memoria de disputa vigente (ley CONFL); `null`/ausente = sin recelo. */
  disputa?: { x: number; y: number } | null;
  /** Trabajo acumulado y duración de la tarea en curso (`performWork`). */
  work?: number;
  workDuration?: number;
}

export interface EscenaPersonas {
  tiles: readonly TeselaEntrada[];
  personas: readonly PersonaEntrada[];
  lluvia?: boolean;
  memoriaDisputa?: number;
  disputaDestino?: number;
  /** Agua percibida (`waterAvailable`); por defecto `drinkingWater ?? 0`. */
  aguaPercibida?: (tile: TeselaEntrada) => number;
}

const siguientePotencia = (n: number): number => { let p = 1; while (p < n) p *= 2; return p; };
const clavePagina = (px: number, py: number): number => (px + 0x100000) * 0x200000 + (py + 0x100000);

/**
 * Estado empaquetado reutilizable entre pasos. Los SAB solo se reasignan cuando la escena no cabe
 * (crecimiento geométrico); en régimen estacionario `empaquetar` escribe sobre los mismos buffers.
 */
export class EstadoPersonasCompartido {
  #buffers!: BuffersPersonas;
  #capPaginas = 0;
  #capHash = 0;
  #capPersonas = 0;
  #paginas = 0;
  #personas = 0;
  #params!: ParamsFaseBPersonas;
  #regiones: StaticRegion[] = [];
  #regionesMorton = 0;
  #reasignaciones = 0;
  #regionSide: RegionSidePersonas = 256;
  #walkCache: { tiles: Tile[]; length: number; token: ResidentTopologyToken; terrainRev: object; paginas: number; capHash: number } | null = null;

  constructor() { this.#asignar(1, 2, 1); }

  get buffers(): BuffersPersonas { return this.#buffers; }
  get params(): ParamsFaseBPersonas { return this.#params; }
  get regiones(): readonly StaticRegion[] { return this.#regiones; }
  get personas(): number { return this.#personas; }
  get paginas(): number { return this.#paginas; }
  get regionSide(): RegionSidePersonas { return this.#regionSide; }
  /** Regiones Morton distintas con al menos un actor (antes de trocear en bloques). */
  get regionesMorton(): number { return this.#regionesMorton; }
  /** Veces que hubo que crear SAB nuevos (diagnóstico de reutilización). */
  get reasignaciones(): number { return this.#reasignaciones; }

  vista(): VistaPersonas { return crearVista(this.#buffers, this.#params); }

  #asignar(capPaginas: number, capHash: number, capPersonas: number): void {
    const sab = (bytes: number): SharedArrayBuffer => new SharedArrayBuffer(Math.max(8, bytes));
    const celdas = capPaginas * CELDAS_POR_PAGINA;
    this.#buffers = {
      paginasX: sab(capHash * 4), paginasY: sab(capHash * 4), paginasSlot: sab(capHash * 4),
      celdaFlags: sab(celdas), celdaComida: sab(celdas * 8), celdaAgua: sab(celdas * 8), celdaAguaPotable: sab(celdas * 8),
      celdaMadera: sab(celdas * 8), celdaPiedra: sab(celdas * 8), celdaTerreno: sab(celdas), celdaBioma: sab(celdas),
      personasF64: sab(capPersonas * NPF * 8), personasI32: sab(capPersonas * NPI * 4), ordenSlots: sab(capPersonas * 4),
      salidaI32: sab(capPersonas * NSI * 4), salidaF64: sab(capPersonas * NSF * 8),
      salidaRutas: sab(capPersonas * CELDAS_PERCEPCION * 2),
    };
    this.#capPaginas = capPaginas; this.#capHash = capHash; this.#capPersonas = capPersonas;
    this.#reasignaciones++;
    this.#walkCache = null;
  }

  /** Vuelca la escena en los SAB y reparte los actores por regiones Morton. */
  empaquetar(escena: EscenaPersonas, opciones: { regionSide?: RegionSidePersonas; bloque?: number } = {}): void {
    this.#walkCache = null;
    const regionSide = opciones.regionSide ?? 256, bloque = opciones.bloque ?? BLOQUE_ACTORES;
    if (regionSide !== 256 && regionSide !== 512) throw new RangeError('regionSide debe ser 256 o 512.');
    if (!Number.isSafeInteger(bloque) || bloque < 1) throw new RangeError('bloque debe ser un entero positivo.');
    const { tiles, personas } = escena;

    // Páginas en orden de primera aparición (determinista).
    const paginaDe = new Map<number, number>();
    const pagX: number[] = [], pagY: number[] = [];
    for (const tile of tiles) {
      if (!Number.isSafeInteger(tile.x) || !Number.isSafeInteger(tile.y)) throw new TypeError('Tesela con coordenadas no enteras.');
      const px = tile.x >> 4, py = tile.y >> 4, clave = clavePagina(px, py);
      if (!paginaDe.has(clave)) { paginaDe.set(clave, pagX.length); pagX.push(px); pagY.push(py); }
    }
    const paginas = pagX.length, capHash = siguientePotencia(Math.max(2, paginas * 2));
    if (paginas > this.#capPaginas || capHash > this.#capHash || personas.length > this.#capPersonas) {
      const crecer = (actual: number, necesario: number): number => necesario > actual ? Math.max(necesario, actual * 2) : actual;
      this.#asignar(crecer(this.#capPaginas, paginas), Math.max(capHash, this.#capHash), crecer(this.#capPersonas, personas.length));
    }
    const vista = crearVista(this.#buffers, {
      capPersonas: this.#capPersonas, personas: personas.length, hashMask: capHash - 1,
      lluvia: escena.lluvia ?? false, memoriaDisputa: escena.memoriaDisputa ?? 0, disputaDestino: escena.disputaDestino ?? 0,
    });

    // Tabla hash de páginas.
    vista.paginasSlot.fill(-1, 0, capHash);
    for (let slot = 0; slot < paginas; slot++) {
      let h = hashPagina(pagX[slot]!, pagY[slot]!, capHash - 1);
      while (vista.paginasSlot[h]! >= 0) h = (h + 1) & (capHash - 1);
      vista.paginasX[h] = pagX[slot]!; vista.paginasY[h] = pagY[slot]!; vista.paginasSlot[h] = slot;
    }

    // Celdas: la última tesela de una coordenada gana, como `tileAt`/`lastTileAt`.
    const celdas = paginas * CELDAS_POR_PAGINA;
    vista.flags.fill(0, 0, celdas);
    const percibida = escena.aguaPercibida;
    for (const tile of tiles) {
      const slot = paginaDe.get(clavePagina(tile.x >> 4, tile.y >> 4))!;
      const celda = slot * CELDAS_POR_PAGINA + ((tile.y & 15) << 4) + (tile.x & 15);
      const terreno = TERRENOS.indexOf(tile.terrain as typeof TERRENOS[number]);
      const bioma = tile.biome === undefined ? -1 : BIOMAS.indexOf(tile.biome as typeof BIOMAS[number]);
      vista.flags[celda] = CELDA_PRESENTE | (tile.terrain !== 'water' ? CELDA_CAMINABLE : 0)
        | (tile.terrain === 'shelter' ? CELDA_REFUGIO : 0) | (tile.biome === 'desert' ? CELDA_DESIERTO : 0);
      vista.terreno[celda] = terreno < 0 ? 255 : terreno;
      vista.bioma[celda] = bioma < 0 ? 255 : bioma;
      vista.comida[celda] = tile.food;
      vista.aguaPotable[celda] = tile.drinkingWater ?? 0;
      vista.agua[celda] = percibida ? percibida(tile) : tile.drinkingWater ?? 0;
      vista.madera[celda] = tile.wood ?? 0;
      vista.piedra[celda] = tile.stone ?? 0;
    }

    // Personas (columnas de stride `capPersonas`).
    const cap = this.#capPersonas;
    for (let slot = 0; slot < personas.length; slot++) {
      const p = personas[slot]!;
      const codigo = ACCION[p.action];
      if (codigo === undefined) throw new TypeError(`Acción desconocida: ${String(p.action)}`);
      if (!Number.isSafeInteger(p.x) || !Number.isSafeInteger(p.y)) throw new TypeError(`Persona ${slot} con posición no entera.`);
      const f = (campo: number, valor: number): void => { vista.pf[campo * cap + slot] = valor; };
      f(PF.x, p.x); f(PF.y, p.y); f(PF.targetX, p.targetX); f(PF.targetY, p.targetY);
      f(PF.hunger, p.hunger); f(PF.thirst, p.thirst); f(PF.fatigue, p.fatigue); f(PF.energy, p.energy);
      f(PF.inventory, p.inventory); f(PF.wood, p.wood); f(PF.stone, p.stone);
      f(PF.curiosity, p.traits.curiosity); f(PF.sociability, p.traits.sociability); f(PF.industriousness, p.traits.industriousness);
      f(PF.care, p.traits.care); f(PF.resilience, p.traits.resilience); f(PF.heading, p.heading);
      f(PF.payload, p.payload ?? 0); f(PF.foodDemand, p.foodDemand ?? 1); f(PF.waterDemand, p.waterDemand ?? 1);
      f(PF.disputaX, p.disputa?.x ?? 0); f(PF.disputaY, p.disputa?.y ?? 0);
      f(PF.work, p.work ?? 0); f(PF.workDuration, p.workDuration ?? 1);
      vista.pi[PI.actionCode * cap + slot] = codigo;
      vista.pi[PI.needsDecision * cap + slot] = p.needsDecision ? 1 : 0;
      vista.pi[PI.shouldMove * cap + slot] = p.shouldMove ? 1 : 0;
      vista.pi[PI.disputaActiva * cap + slot] = p.disputa ? 1 : 0;
    }

    // Partición Morton: actores ordenados por (morton de su región, actorSlot); cada región se
    // trocea en bloques de `bloque` actores. Los ids de bloque son ordinales: `partitionRegions`
    // reparte colas contiguas en orden Morton, sin robo de trabajo.
    const mortonDe = new Map<number, bigint>();
    const claves: { morton: bigint; slot: number }[] = new Array(personas.length);
    for (let slot = 0; slot < personas.length; slot++) {
      const p = personas[slot]!;
      const rx = Math.floor(p.x / regionSide), ry = Math.floor(p.y / regionSide), clave = clavePagina(rx, ry);
      let morton = mortonDe.get(clave);
      if (morton === undefined) { morton = mortonCode(rx, ry); mortonDe.set(clave, morton); }
      claves[slot] = { morton, slot };
    }
    claves.sort((a, b) => a.morton < b.morton ? -1 : a.morton > b.morton ? 1 : a.slot - b.slot);
    const regiones: StaticRegion[] = [];
    let regionMorton = -1, inicio = 0;
    for (let i = 0; i <= claves.length; i++) {
      const nueva = i === claves.length || i === 0 || claves[i]!.morton !== claves[i - 1]!.morton;
      if (i > 0 && (nueva || i - inicio === bloque)) { regiones.push({ id: regiones.length, begin: inicio, end: i }); inicio = i; }
      if (i === claves.length) break;
      if (nueva) regionMorton++;
      vista.orden[i] = claves[i]!.slot;
      vista.pi[PI.regionId * cap + claves[i]!.slot] = regionMorton;
    }

    this.#paginas = paginas; this.#personas = personas.length; this.#regiones = regiones;
    this.#regionesMorton = regionMorton + 1; this.#regionSide = regionSide;
    this.#params = vista.params;
  }

  /**
   * Empaquetado ligero para movimiento (`move` BFS 2048 nodos) y rutas percibidas de `choose`:
   * solo copia la caminabilidad de las teselas y las coordenadas/destinos de las personas, evitando
   * copiar stocks o calcular decisiones durante el despacho. La caminabilidad
   * (`terrain !== 'water'`) es invariante durante toda la fase `personas`, por lo que el primer paso
   * calculado en workers es bit a bit idéntico al BFS en serie para todo actor cuyo destino no cambie.
   */
  empaquetarSoloMovimiento(world: World, opciones: {
    regionSide?: RegionSidePersonas; bloque?: number; movimiento?: boolean; decisiones?: Uint8Array;
  } = {}): void {
    const regionSide = opciones.regionSide ?? 256, bloque = opciones.bloque ?? BLOQUE_ACTORES;
    if (regionSide !== 256 && regionSide !== 512) throw new RangeError('regionSide debe ser 256 o 512.');
    if (!Number.isSafeInteger(bloque) || bloque < 1) throw new RangeError('bloque debe ser un entero positivo.');
    const tiles = world.tiles, personas = world.people;
    const token = residentTopologyToken(tiles);
    const terrainRev = token ? residentTerrainRevision(tiles) : undefined;
    const cache = this.#walkCache;
    let paginas: number, capHash: number, vista: VistaPersonas;
    if (cache && cache.tiles === tiles && cache.length === tiles.length
      && sameResidentTopology(cache.token, token) && cache.terrainRev === terrainRev
      && personas.length <= this.#capPersonas) {
      paginas = cache.paginas;
      capHash = cache.capHash;
      vista = crearVista(this.#buffers, {
        capPersonas: this.#capPersonas, personas: personas.length, hashMask: capHash - 1,
        lluvia: false, memoriaDisputa: 0, disputaDestino: 0,
      });
    } else {
      const paginaDe = new Map<number, number>();
      const pagX: number[] = [], pagY: number[] = [];
      for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i]!;
        const px = tile.x >> 4, py = tile.y >> 4, clave = clavePagina(px, py);
        if (!paginaDe.has(clave)) { paginaDe.set(clave, pagX.length); pagX.push(px); pagY.push(py); }
      }
      paginas = pagX.length;
      capHash = siguientePotencia(Math.max(2, paginas * 2));
      if (paginas > this.#capPaginas || capHash > this.#capHash || personas.length > this.#capPersonas) {
        const crecer = (actual: number, necesario: number): number => necesario > actual ? Math.max(necesario, actual * 2) : actual;
        this.#asignar(crecer(this.#capPaginas, paginas), Math.max(capHash, this.#capHash), crecer(this.#capPersonas, personas.length));
      }
      vista = crearVista(this.#buffers, {
        capPersonas: this.#capPersonas, personas: personas.length, hashMask: capHash - 1,
        lluvia: false, memoriaDisputa: 0, disputaDestino: 0,
      });
      vista.paginasSlot.fill(-1, 0, capHash);
      for (let slot = 0; slot < paginas; slot++) {
        let h = hashPagina(pagX[slot]!, pagY[slot]!, capHash - 1);
        while (vista.paginasSlot[h]! >= 0) h = (h + 1) & (capHash - 1);
        vista.paginasX[h] = pagX[slot]!; vista.paginasY[h] = pagY[slot]!; vista.paginasSlot[h] = slot;
      }
      const celdas = paginas * CELDAS_POR_PAGINA;
      vista.flags.fill(0, 0, celdas);
      for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i]!;
        const slot = paginaDe.get(clavePagina(tile.x >> 4, tile.y >> 4))!;
        const celda = slot * CELDAS_POR_PAGINA + ((tile.y & 15) << 4) + (tile.x & 15);
        vista.flags[celda] = CELDA_PRESENTE | (tile.terrain !== 'water' ? CELDA_CAMINABLE : 0);
      }
      this.#walkCache = token && terrainRev ? { tiles, length: tiles.length, token, terrainRev, paginas, capHash } : null;
    }
    const cap = this.#capPersonas;
    vista.params.soloRutasYMovimiento = true;
    const mortonDe = new Map<number, bigint>();
    const claves: { morton: bigint; slot: number }[] = new Array(personas.length);
    for (let slot = 0; slot < personas.length; slot++) {
      const p = personas[slot]!;
      vista.pf[PF.x * cap + slot] = p.x;
      vista.pf[PF.y * cap + slot] = p.y;
      vista.pf[PF.targetX * cap + slot] = p.target.x;
      vista.pf[PF.targetY * cap + slot] = p.target.y;
      vista.pf[PF.hunger * cap + slot] = p.hunger;
      vista.pf[PF.thirst * cap + slot] = p.thirst;
      vista.pf[PF.fatigue * cap + slot] = p.fatigue;
      vista.pf[PF.energy * cap + slot] = p.energy;
      vista.pf[PF.foodDemand * cap + slot] = 1;
      vista.pf[PF.waterDemand * cap + slot] = 1;
      vista.pi[PI.actionCode * cap + slot] = 0;
      // Coordenadas no enteras conservan el fallback histórico de perceivedRoutes.
      vista.pi[PI.needsDecision * cap + slot] = Number.isInteger(p.x) && Number.isInteger(p.y) ? opciones.decisiones?.[slot] ?? 0 : 0;
      vista.pi[PI.shouldMove * cap + slot] = opciones.movimiento !== false
        && !(p.action === 'accompany' && Math.hypot(p.x - p.target.x, p.y - p.target.y) <= 1.5) ? 1 : 0;
      vista.pi[PI.disputaActiva * cap + slot] = 0;
      const rx = Math.floor(p.x / regionSide), ry = Math.floor(p.y / regionSide), clave = clavePagina(rx, ry);
      let morton = mortonDe.get(clave);
      if (morton === undefined) { morton = mortonCode(rx, ry); mortonDe.set(clave, morton); }
      claves[slot] = { morton, slot };
    }
    claves.sort((a, b) => a.morton < b.morton ? -1 : a.morton > b.morton ? 1 : a.slot - b.slot);
    const regiones: StaticRegion[] = [];
    let regionMorton = -1, inicio = 0;
    for (let i = 0; i <= claves.length; i++) {
      const nueva = i === claves.length || i === 0 || claves[i]!.morton !== claves[i - 1]!.morton;
      if (i > 0 && (nueva || i - inicio === bloque)) { regiones.push({ id: regiones.length, begin: inicio, end: i }); inicio = i; }
      if (i === claves.length) break;
      if (nueva) regionMorton++;
      vista.orden[i] = claves[i]!.slot;
      vista.pi[PI.regionId * cap + claves[i]!.slot] = regionMorton;
    }
    this.#paginas = paginas; this.#personas = personas.length; this.#regiones = regiones;
    this.#regionesMorton = regionMorton + 1; this.#regionSide = regionSide;
    this.#params = vista.params;
  }
}

/** Escena de la fase `personas` a partir de un mundo real (solo lectura). */
export function escenaDesdeMundo(world: World): EscenaPersonas {
  const params = paramsOf(world);
  const { memoriaDisputa, disputaDestino } = params.social;
  // `waterAvailable` suma cisternas funcionales a ≤ 0,5 celdas: solo difiere de `drinkingWater`
  // donde hay estructuras; allí se usa la ley real, en el resto la lectura directa.
  const conEstructura = new Set(world.structures.map(s => `${s.x},${s.y}`));
  const personas = world.people.map((person: Person): PersonaEntrada => {
    const physiology = demographicTraits(person.genome, params.cuerpo);
    const memoria = memoriaDisputa > 0 && person.conflictMemory && world.tick - person.conflictMemory.tick < TICKS_PER_DAY
      ? person.conflictMemory : null;
    const skill = person.skills[person.action] ?? 0;
    return {
      x: person.x, y: person.y, targetX: person.target.x, targetY: person.target.y,
      hunger: person.hunger, thirst: person.thirst, fatigue: person.fatigue, energy: person.energy,
      inventory: person.inventory, wood: person.materials.wood, stone: person.materials.stone,
      traits: person.traits, heading: person.heading, action: person.action,
      needsDecision: world.tick >= person.decisionAt || person.hunger > 0.9 || person.thirst > 0.9,
      shouldMove: world.tick % 6 === 0 && !(person.action === 'accompany' && Math.hypot(person.x - person.target.x, person.y - person.target.y) <= 1.5),
      payload: containedWaterQuanta(person) / 1000,
      foodDemand: physiology.foodDemand, waterDemand: physiology.waterDemand,
      disputa: memoria ? { x: memoria.x, y: memoria.y } : null,
      // `workDuration` de `index.ts` para forage/gather (las dos tareas con intento de recurso aquí).
      work: person.work, workDuration: Math.ceil(18 * (1 - skill * 0.25)),
    };
  });
  return {
    tiles: world.tiles, personas, lluvia: world.weather === 'rain', memoriaDisputa, disputaDestino,
    aguaPercibida: conEstructura.size === 0 ? undefined : tile => {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (conEstructura.has(`${tile.x + dx},${tile.y + dy}`)) return waterAvailable(world, tile as Tile);
      }
      return tile.drinkingWater ?? 0;
    },
  };
}

// ── Piscina persistente ────────────────────────────────────────────────────────────────

export interface OpcionesPersonasPool {
  hilos: number;
  orden?: StaticRegionOrder;
  /** Espera física entre regiones en `adversarial` (ms). Por defecto 0. */
  retardoMs?: number;
  /** Reloj inyectado para medir la ruta de 1 hilo (este módulo no lee relojes). */
  reloj?: () => number;
  /** Fábrica de piscina (pruebas). */
  crearPool?: (workers: number) => StaticWorkerPool;
}

export interface DiagnosticoPersonas {
  hilos: number;
  orden: StaticRegionOrder;
  despachos: number;
  regiones: number;
  actores: number;
  ocupacionWorkers: number;
  tiempoParaleloMs: number;
  tiempoBarreraMs: number;
  tiempoActivoWorkersMs: number[];
  piscina: StaticWorkerDiagnostics | null;
}

function urlWorker(): URL {
  const js = new URL('./personas-worker.js', import.meta.url);
  return js.protocol === 'file:' && existsSync(fileURLToPath(js)) ? js : new URL('./personas-worker.ts', import.meta.url);
}

/**
 * Piscina persistente de la fase `personas`: los workers se crean una vez y se reutilizan en cada
 * `stepPhaseB`. Con `hilos = 1` no hay workers: la misma función corre en el hilo que llama.
 */
export class PersonasParallelPool {
  readonly #hilos: number;
  readonly #orden: StaticRegionOrder;
  readonly #retardoMs: number;
  readonly #reloj: (() => number) | undefined;
  readonly #pool: StaticWorkerPool | null;
  #despachos = 0;
  #regiones = 0;
  #actores = 0;
  #tiempoLocalMs = 0;
  #cerrada = false;

  constructor(opciones: OpcionesPersonasPool) {
    if (!Number.isSafeInteger(opciones.hilos) || opciones.hilos < 1) throw new RangeError('hilos debe ser un entero positivo.');
    this.#hilos = opciones.hilos;
    this.#orden = opciones.orden ?? 'natural';
    this.#retardoMs = opciones.retardoMs ?? 0;
    this.#reloj = opciones.reloj;
    this.#pool = this.#hilos === 1 ? null : (opciones.crearPool ?? (workers => new StaticWorkerPool({
      workers, moduleURL: urlWorker(), exportName: 'faseBPersonasWorker',
    })))(this.#hilos);
  }

  get hilos(): number { return this.#hilos; }

  /** Fase B del paso: escribe los buffers de salida de `estado`. Síncrono. */
  stepPhaseB(estado: EstadoPersonasCompartido): void {
    if (this.#cerrada) throw new Error('PersonasParallelPool cerrada.');
    const regiones = estado.regiones;
    this.#despachos++; this.#regiones = regiones.length; this.#actores = estado.personas;
    if (!this.#pool) {
      // Misma función, mismo recorrido de colas que una piscina de 1 worker, sin hilos ni copia.
      const inicio = this.#reloj?.() ?? 0;
      ejecutarRegionesPersonas(estado.vista(), partitionRegions(regiones, 1, this.#orden)[0]!);
      this.#tiempoLocalMs = this.#reloj ? Math.max(0, this.#reloj() - inicio) : 0;
      return;
    }
    this.#pool.run({ regions: regiones, buffers: estado.buffers, params: estado.params, orden: this.#orden, retardoMs: this.#retardoMs });
  }

  diagnostics(): DiagnosticoPersonas {
    const base = { hilos: this.#hilos, orden: this.#orden, despachos: this.#despachos, regiones: this.#regiones, actores: this.#actores };
    if (!this.#pool) {
      const t = this.#tiempoLocalMs;
      return { ...base, ocupacionWorkers: calcularOcupacionWorkers([t], t), tiempoParaleloMs: t, tiempoBarreraMs: 0,
        tiempoActivoWorkersMs: [t], piscina: null };
    }
    const d = this.#pool.diagnostics();
    return { ...base, ocupacionWorkers: d.ocupacionWorkers, tiempoParaleloMs: d.tiempoParaleloMs, tiempoBarreraMs: d.tiempoBarreraMs,
      tiempoActivoWorkersMs: d.tiempoActivoWorkersMs, piscina: d };
  }

  close(): Promise<void> {
    this.#cerrada = true;
    return this.#pool ? this.#pool.close() : Promise.resolve();
  }
}

// ── Fase C ─────────────────────────────────────────────────────────────────────────────

const TIPO_DE_INTENTO: Readonly<Record<number, { tipo: string; prefijo: string; total: string }>> = {
  [INTENTO_COMER]: { tipo: 'cosecha', prefijo: 'comida', total: 'foodHarvested' },
  [INTENTO_COSECHAR]: { tipo: 'cosecha', prefijo: 'comida', total: 'foodHarvested' },
  [INTENTO_BEBER]: { tipo: 'agua', prefijo: 'agua', total: 'waterConsumed' },
  [INTENTO_MADERA]: { tipo: 'recoleccion', prefijo: 'madera', total: 'woodGathered' },
  [INTENTO_PIEDRA]: { tipo: 'recoleccion', prefijo: 'piedra', total: 'stoneGathered' },
};

export interface ResultadoFaseCPersonas {
  confirmacion: ResultadoConfirmacion;
  /** Cantidad concedida por `actorSlot` (0 sin intento o sin stock). */
  concedido: Float64Array;
  /** Stocks finales por `recursoId`, en orden de clave (comparables con `deepStrictEqual`). */
  stocksFinales: [string, number][];
  libros: AggregateBooks;
  coste: ReductionCost;
}

/**
 * Fase C determinista: lee los intentos de los buffers en orden de `actorSlot`, los confirma en
 * orden canónico sobre los stocks del snapshot y reduce los acumuladores en orden
 * `(actorSlot, secuenciaLocal)`. Con `aplicarStocks` escribe los stocks finales en el terreno
 * empaquetado (para encadenar pasos sobre el mismo estado).
 */
export function confirmarFaseCPersonas(
  estado: EstadoPersonasCompartido,
  opciones: { libros?: AggregateBooks; reloj?: () => number; aplicarStocks?: boolean } = {},
): ResultadoFaseCPersonas {
  const vista = estado.vista(), cap = vista.params.capPersonas, n = estado.personas;
  const intentos: Intent[] = [];
  const stocks = new Map<string, number>(), celdaDeRecurso = new Map<string, number>();
  for (let slot = 0; slot < n; slot++) {
    const kind = vista.si[SI.intentKind * cap + slot]!;
    if (kind === INTENTO_NINGUNO) continue;
    const tipo = TIPO_DE_INTENTO[kind];
    if (!tipo) throw new RangeError(`intentKind desconocido ${kind} en actorSlot ${slot}.`);
    const celdaX = vista.si[SI.intentCellX * cap + slot]!, celdaY = vista.si[SI.intentCellY * cap + slot]!;
    const recursoId = `${tipo.prefijo}:${celdaX},${celdaY}`;
    if (!stocks.has(recursoId)) {
      const celda = celdaDe(vista, celdaX, celdaY);
      if (celda < 0) throw new RangeError(`Intento sobre una tesela inexistente (${celdaX}, ${celdaY}).`);
      const columna = kind === INTENTO_BEBER ? vista.aguaPotable : kind === INTENTO_MADERA ? vista.madera
        : kind === INTENTO_PIEDRA ? vista.piedra : vista.comida;
      stocks.set(recursoId, columna[celda]!); celdaDeRecurso.set(recursoId, celda);
    }
    intentos.push({ fase: 'personas', tipoRecurso: tipo.tipo, recursoId, celdaX, celdaY, actorSlot: slot, secuenciaLocal: 0,
      cantidad: vista.sf[SF.intentAmount * cap + slot]! });
  }
  const confirmacion = confirmarIntentos(intentos, stocks);
  const concedido = new Float64Array(n);
  const contribuciones: IntentAgregado[] = [];
  for (const resultado of confirmacion.resultados) {
    if (resultado.duplicado) continue;
    concedido[resultado.intent.actorSlot] = resultado.concedido;
    if (resultado.concedido <= 0) continue;
    const total = TIPO_DE_INTENTO[vista.si[SI.intentKind * cap + resultado.intent.actorSlot]!]!.total;
    contribuciones.push({ fase: 'agregado', tipoRecurso: 'totals', recursoId: total, actorSlot: resultado.intent.actorSlot,
      secuenciaLocal: resultado.intent.secuenciaLocal, cantidad: resultado.concedido });
  }
  const libros = opciones.libros ?? emptyAggregateBooks();
  const coste = reduceAggregates(libros, contribuciones, opciones.reloj);
  const stocksFinales = [...confirmacion.stocksFinales.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (opciones.aplicarStocks) {
    for (const [recursoId, valor] of stocksFinales) {
      const celda = celdaDeRecurso.get(recursoId)!;
      const columna = recursoId.startsWith('agua:') ? vista.aguaPotable : recursoId.startsWith('madera:') ? vista.madera
        : recursoId.startsWith('piedra:') ? vista.piedra : vista.comida;
      columna[celda] = valor;
    }
  }
  return { confirmacion, concedido, stocksFinales, libros, coste };
}

/** Copia comparable de los buffers de salida (solo los `personas` actores en uso). */
export function copiarSalidas(estado: EstadoPersonasCompartido): Record<string, number[]> {
  const vista = estado.vista(), cap = vista.params.capPersonas, n = estado.personas;
  const salida: Record<string, number[]> = {};
  for (const [nombre, columna] of Object.entries(SI)) salida[nombre] = Array.from(vista.si.subarray(columna * cap, columna * cap + n));
  for (const [nombre, columna] of Object.entries(SF)) salida[nombre] = Array.from(vista.sf.subarray(columna * cap, columna * cap + n));
  return salida;
}

// ── Despacho residente para el bucle real de `stepWorld` ──────────────────────────────

export { MOVE_AVANZA, MOVE_BLOQUEADO, MOVE_EN_DESTINO, MOVE_SIN_EVALUAR, SI } from './personas-worker.js';

export interface PrecomputedMoves {
  si: Int32Array;
  cap: number;
  targetX: Int32Array;
  targetY: Int32Array;
  count: number;
  diagnostico: DiagnosticoPersonas;
  /** Válido solo durante esta fase personas, como las salidas de movimiento reutilizables. */
  rutas?: { pasos: Int16Array; x: Float64Array; y: Float64Array; listas: Int32Array };
}

export interface PersonasExecution {
  regionSide?: RegionSidePersonas;
  onStep?: (diagnostico: DiagnosticoPersonas) => void;
}

const poolsPersonas = new Map<string, PersonasParallelPool>();
let estadoMovimientoCompartido: EstadoPersonasCompartido | null = null;
let snapTargetX = new Int32Array(0);
let snapTargetY = new Int32Array(0);
let decisiones = new Uint8Array(0);

/** Lookup sin Map. Una fila ausente o una posición cambiada obliga al BFS serial de choose. */
export function precomputedRouteLookup(
  person: { x: number; y: number }, precomputed?: PrecomputedMoves, slot?: number,
): ((point: { x: number; y: number }) => number | undefined) | undefined {
  const rutas = precomputed?.rutas;
  if (!precomputed || !rutas || slot === undefined || slot < 0 || slot >= precomputed.count || !rutas.listas[slot]
    || person.x !== rutas.x[slot] || person.y !== rutas.y[slot]) return undefined;
  const x = person.x, y = person.y, inicio = slot * CELDAS_PERCEPCION;
  return point => {
    const dx = point.x - x + RADIO_PERCEPCION, dy = point.y - y + RADIO_PERCEPCION;
    if (!Number.isInteger(dx) || !Number.isInteger(dy) || dx < 0 || dy < 0 || dx >= LADO_PERCEPCION || dy >= LADO_PERCEPCION) return undefined;
    const pasos = rutas.pasos[inicio + dy * LADO_PERCEPCION + dx]!;
    return pasos < 0 ? undefined : pasos;
  };
}

/**
 * Selección conservadora sin consultar teselas: eat/forage/drink pueden agotar su destino antes
 * de su turno; la preparación de agua puede adelantar decisionAt. Los umbrales anticipan las
 * necesidades basales (como el lote de políticas). Una decisión imprevista conserva el fallback.
 * El movimiento y la percepción comparten un único despacho/barrera cuando coinciden.
 */
export function precomputePersonasParallel(
  world: World, motor: { hilos: number; orden: StaticRegionOrder }, execution?: PersonasExecution,
): PrecomputedMoves | undefined {
  const n = world.people.length;
  if (n < 16) return undefined;
  if (decisiones.length < n) decisiones = new Uint8Array(siguientePotencia(n));
  let decidingCount = 0;
  for (let slot = 0; slot < n; slot++) {
    const p = world.people[slot]!;
    const due = world.tick >= p.decisionAt || p.hunger > 0.85 || p.thirst > 0.85
      || p.action === 'eat' || p.action === 'forage' || p.action === 'drink' || !!p.technology.waterPreparation;
    decisiones[slot] = due ? 1 : 0;
    if (due) decidingCount++;
  }
  const movimiento = world.tick % 6 === 0;
  if (!movimiento && decidingCount < 16) return undefined;
  return despacharRutasYMovimiento(world, motor, execution, movimiento, decidingCount >= 16 ? decisiones : undefined);
}

/**
 * Precomputa en paralelo (sobre `PersonasParallelPool` persistente y SAB reutilizables) el primer
 * paso BFS de `move()` para toda la población del paso actual. Solo empaqueta caminabilidad y
 * posiciones/destinos; el resultado para cualquier actor cuyo destino no cambie es bit a bit
 * idéntico al BFS en serie de `move()`.
 */
export function precomputeMovesParallel(
  world: World,
  motor: { hilos: number; orden: StaticRegionOrder },
  execution?: PersonasExecution,
): PrecomputedMoves {
  return despacharRutasYMovimiento(world, motor, execution, true);
}

function despacharRutasYMovimiento(
  world: World, motor: { hilos: number; orden: StaticRegionOrder }, execution: PersonasExecution | undefined,
  movimiento: boolean, decisiones?: Uint8Array,
): PrecomputedMoves {
  const n = world.people.length;
  const key = `${motor.hilos}:${motor.orden}`;
  let pool = poolsPersonas.get(key);
  if (!pool) {
    pool = new PersonasParallelPool({ hilos: motor.hilos, orden: motor.orden });
    poolsPersonas.set(key, pool);
  }
  const estado = estadoMovimientoCompartido ??= new EstadoPersonasCompartido();
  if (snapTargetX.length < n) {
    const cap = siguientePotencia(Math.max(32, n));
    snapTargetX = new Int32Array(cap);
    snapTargetY = new Int32Array(cap);
  }
  for (let i = 0; i < n; i++) {
    const p = world.people[i]!;
    snapTargetX[i] = p.target.x;
    snapTargetY[i] = p.target.y;
  }
  estado.empaquetarSoloMovimiento(world, { regionSide: execution?.regionSide ?? 256, movimiento, decisiones });
  pool.stepPhaseB(estado);
  const diagnostico = pool.diagnostics();
  execution?.onStep?.(diagnostico);
  const vista = estado.vista();
  const cap = vista.params.capPersonas;
  return { si: vista.si, cap, targetX: snapTargetX, targetY: snapTargetY, count: n, diagnostico,
    rutas: decisiones ? { pasos: vista.rutas, x: vista.pf.subarray(PF.x * cap, PF.x * cap + n),
      y: vista.pf.subarray(PF.y * cap, PF.y * cap + n), listas: vista.pi.subarray(PI.needsDecision * cap, PI.needsDecision * cap + n) } : undefined };
}

/** Cierra todas las piscinas persistentes de la fase `personas` (tests y apagado del servidor). */
export async function closePersonasParallelPools(): Promise<void> {
  const pools = [...poolsPersonas.values()];
  poolsPersonas.clear();
  await Promise.all(pools.map(pool => pool.close()));
}

