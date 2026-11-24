/**
 * Motor paralelo de la fase de decisión de la fauna (`choose` de `src/world/animals.ts`).
 *
 * Flujo, en el punto exacto de `stepAnimals` donde hoy corre `for (const animal of due) choose(…)`:
 *  1. `EstadoFaunaCompartido.empaquetar(world, due, state)` vuelca en `SharedArrayBuffer`
 *     reutilizables (solo crecen, geométricamente) el terreno por páginas 16 × 16 (mismo hash que
 *     `personas-worker.ts`), los ocupantes de `state.occupants` en CSR por celda, `state.counts`, una
 *     tabla compacta de los animales vivos y las entradas de cada animal debido (cuerpo, genes,
 *     memoria e id en UTF-16). Reparte los animales debidos en bloques fijos de `BLOQUE_FAUNA`.
 *  2. `FaunaParallelPool.stepChoose(estado)` ejecuta `choose` (fauna-worker.ts) sobre una
 *     `StaticWorkerPool` persistente (con `hilos = 1`, en el propio hilo y sin workers). Cada animal
 *     escribe sólo su fila de salida: no hay carreras ni `Atomics`.
 *  3. `applyFaunaChooseOutputs(due, world, salidas)` aplica en serie, en el orden de `due`, lo que
 *     `choose` escribe: los `remember` (con la tesela real), `work`, `action`, `target`, `reason`,
 *     `preyId` y `lastDecision`.
 *
 * Por qué es exacto: `choose` sólo lee el terreno, los ocupantes y los campos de los demás animales
 * que `choose` no escribe (`x`, `y`, `species`, `genes.carnivory`, `health`, `id`); lo único que lee
 * de lo que escribe es la memoria del propio animal. Así que todas las decisiones de un paso son
 * funciones del mismo estado y el orden de cálculo no cambia ningún resultado; la partición (hilos,
 * orden, bloque) decide QUIÉN calcula, nunca QUÉ sale.
 *
 * Terreno: `state.tile` es `tileLookup(world.tiles)` (la última tesela con esas coordenadas), y eso es
 * lo que se empaqueta, desde `world.tiles`. La disposición de páginas (qué celda ocupa cada tesela, qué
 * celdas tienen tesela) se guarda entre pasos con la misma invalidación que `tile-index.ts` —identidad y
 * longitud del arreglo— más el certificado de topología residente (`residentTopologyToken`) cuando el
 * arreglo es residente. En cada paso sólo se releen `terrain`, `biome`, `growth`, `vegetation`,
 * `moisture` y `drinkingWater` (los cambian la ecología, la alimentación y las obras) de las páginas que
 * toca la ventana de percepción de algún animal debido: fuera de ellas `choose` sólo pregunta si hay
 * tesela (recuerdos lejanos) y ni las ve ni lee sus ocupantes. Cada tesela releída comprueba que
 * conserva sus coordenadas; si no, se reconstruye la disposición. Precondición de mundo válido:
 * coordenadas enteras (las teselas no enteras o fuera de ±2^25 nunca coinciden con una consulta de
 * fauna y se omiten) y genes en [0, 1].
 *
 * T171: aquí no hay relojes, ni consulta de la máquina, ni azar del proceso. Las medidas de tiempo
 * las toma `piscina.ts`; con `hilos = 1` sólo se mide si quien llama inyecta `reloj`.
 *
 * Cableado en `stepAnimals` (`animals.ts`) a partir del umbral de animales debidos de allí.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Tile } from '../../shared/types.js';
import { listoParaCriar, listoSalvoEnergia, type Animal, type AnimalMemory } from '../animals.js';
import { paramsOf } from '../params.js';
import {
  residentBackingArray, residentInPlaceRevision, residentTopologyToken, sameResidentTopology,
  type ResidentTopologyToken,
} from '../soa/topologia.js';
import {
  copyResidentFaunaTile, residentFastAccess, residentSnapshotGate, residentTileReader,
  type ResidentFastAccess, type ResidentTileReader,
} from '../soa/terreno.js';
import { verifiedChunkBlocks } from '../tile-index.js';
import { MAX_COORDINATE } from '../terrain.js';
import { partitionRegions, type StaticRegion, type StaticRegionOrder } from './particion.js';
import {
  buscarPagina, CELDAS_POR_PAGINA, clavePagina, crecerCapacidad, llenarTablaPaginas, llenarTablaPaginasConSlots,
  siguientePotencia,
} from './paginas.js';
import { calcularOcupacionWorkers, StaticWorkerPool, type StaticWorkerDiagnostics } from './piscina.js';
import {
  ACCIONES_FAUNA, CELDA_AGUA, CELDA_CRECIMIENTO, CELDA_OCEANO, CELDA_PRESENTE, CELDA_REFUGIO,
  DESTINO_PAREJA, DESTINO_PRESA, DESTINO_PROPIO, DESTINO_RECUERDO, DESTINO_REPOSO, DESTINO_TESELA, DF, DI, RADIO_PAREJA_FAUNA, RAZON_PAREJA_FAUNA,
  RAZON_REPOSO_CRIA_FAUNA,
  MAX_MEMORIA_ANIMAL, MEMORIA_TTL, MF, NDF, NDI, NMF, NSO, NTF, NTI, RAZONES_FAUNA, SO, TF, TI,
  celdaDe, codigoEspecie, crearVistaFauna, ejecutarRegionesFauna, paginable,
  type BuffersFauna, type ParamsFauna, type VistaFauna,
} from './fauna-worker.js';

/** Animales debidos por bloque de región: fijo (no depende de `hilos`); 1 024 decisiones dan 128
 * bloques, colas parejas para 28 workers. */
export const BLOQUE_FAUNA = 8;
/** Radio de percepción admitido (`2 + ⌊percepción·4⌋` = 6 con genes en [0, 1]); uno mayor es un genoma inválido. */
const RADIO_MAXIMO = 64;

/** Lo que `choose` recibe como `state` en `stepAnimals` (`LocalState`, no exportado allí). */
export interface EstadoLocalFauna {
  /** `tileLookup(world.tiles)`; el motor empaqueta `world.tiles`, que es lo mismo (ver cabecera). */
  tile?: (x: number, y: number) => Tile | undefined;
  occupants: ReadonlyMap<number | string, readonly Animal[]>;
  counts: ReadonlyMap<number | string, number>;
}
/** Lo que el motor lee del mundo. */
export interface MundoFauna { seed: number; tick: number; tiles: Tile[]; animals: readonly Animal[] }

/** Salidas de un despacho. Las vistas se reutilizan: válidas hasta el siguiente `empaquetar`. */
export interface SalidasFauna {
  readonly tick: number;
  readonly due: number;
  readonly so: Int32Array;
  /** Animal de cada fila de la tabla (para `preyId` y el destino de caza). */
  readonly tabla: readonly Animal[];
  readonly tiles: readonly Tile[];
}

const sab = (bytes: number): SharedArrayBuffer => new SharedArrayBuffer(Math.max(8, bytes));

/** Clave de celda de `animals.ts` (`cellXY`): entero único dentro del dominio, cadena `"x,y"` fuera. */
const CELL_SPAN = 2 * MAX_COORDINATE;
const cellXY = (x: number, y: number): number | string => Number.isInteger(x) && Number.isInteger(y) && x >= -MAX_COORDINATE && x < MAX_COORDINATE
  && y >= -MAX_COORDINATE && y < MAX_COORDINATE ? (x + MAX_COORDINATE) * CELL_SPAN + (y + MAX_COORDINATE) : `${x},${y}`;
/** Coordenadas de una clave de `state.occupants`/`state.counts` (inversa de `cellXY`); `false` si no es una clave válida. */
function coordenadasDeClave(clave: number | string, salida: { x: number; y: number }): boolean {
  if (typeof clave === 'number') {
    if (!Number.isSafeInteger(clave) || clave < 0) return false;
    const ix = Math.floor(clave / CELL_SPAN);
    salida.x = ix - MAX_COORDINATE; salida.y = clave - ix * CELL_SPAN - MAX_COORDINATE;
    return true;
  }
  if (typeof clave !== 'string') return false;
  const coma = clave.indexOf(',');
  if (coma < 0) return false;
  salida.x = Number(clave.slice(0, coma)); salida.y = Number(clave.slice(coma + 1));
  return `${salida.x},${salida.y}` === clave;
}

interface DisposicionTerreno {
  /** Proxy observado para certificados SoA; `tiles` es el backing de solo lectura. */
  accessTiles: Tile[];
  tiles: Tile[];
  length: number;
  /** Certificado de topología residente con el que se construyó (`undefined` si el arreglo no es residente). */
  token: ResidentTopologyToken | undefined;
  /** Coordenadas de cada tesela al construirla: se comprueban en cada tesela que se relee (sin token residente). */
  xs: Float64Array;
  ys: Float64Array;
  /** Coordenadas de página `(px, py)` por ranura `slot`, para consultas por bloque O(1) en `#releerPagina`. */
  pagX: Int32Array;
  pagY: Int32Array;
  paginas: number;
  capHash: number;
}

/**
 * Estado empaquetado reutilizable entre pasos. Los SAB sólo se reasignan cuando el paso no cabe
 * (crecimiento geométrico); el terreno y los animales crecen por separado, así que una tabla de
 * animales más grande no obliga a reconstruir la disposición del terreno.
 */
export class EstadoFaunaCompartido {
  #buffers: BuffersFauna;
  #capPaginas = 0;
  #capHash = 0;
  #capTabla = 0;
  #capDue = 0;
  #capMemoria = 0;
  #capId = 0;
  #params: ParamsFauna;
  #regiones: StaticRegion[] = [];
  #tabla: Animal[] = [];
  #tiles: readonly Tile[] = [];
  #due = 0;
  #reasignaciones = 0;
  #reconstrucciones = 0;
  #disposicion: DisposicionTerreno | null = null;
  /** Sello por página: `#generacion` si sus valores se releyeron en este empaquetado. */
  #sello = new Int32Array(0);
  #generacion = 0;
  #paginasReleidas = 0;
  #xsBuf = new Float64Array(0);
  #ysBuf = new Float64Array(0);

  constructor() {
    this.#buffers = {} as BuffersFauna;
    this.#asignarTerreno(1, 2);
    this.#asignarAnimales(1, 1, MAX_MEMORIA_ANIMAL, 1);
    this.#params = { capTabla: this.#capTabla, capDue: this.#capDue, due: 0, capMemoria: this.#capMemoria, hashMask: 1, seed: 0, tick: 0 };
  }

  get buffers(): BuffersFauna { return this.#buffers; }
  get params(): ParamsFauna { return this.#params; }
  get regiones(): readonly StaticRegion[] { return this.#regiones; }
  get due(): number { return this.#due; }
  /** Veces que hubo que crear SAB nuevos (diagnóstico de reutilización). */
  get reasignaciones(): number { return this.#reasignaciones; }
  /** Veces que se recalculó la disposición de páginas del terreno (diagnóstico de la caché). */
  get reconstruccionesTerreno(): number { return this.#reconstrucciones; }
  /** Páginas de terreno releídas en el último empaquetado (las que tocan las ventanas de percepción). */
  get paginasReleidas(): number { return this.#paginasReleidas; }
  /** Páginas de la disposición vigente. */
  get paginas(): number { return this.#disposicion?.paginas ?? 0; }

  vista(): VistaFauna { return crearVistaFauna(this.#buffers, this.#params); }

  salidas(): SalidasFauna {
    return { tick: this.#params.tick, due: this.#due, so: new Int32Array(this.#buffers.salidaI32), tabla: this.#tabla, tiles: this.#tiles };
  }

  #asignarTerreno(capPaginas: number, capHash: number): void {
    const celdas = capPaginas * CELDAS_POR_PAGINA, b = this.#buffers;
    b.paginasX = sab(capHash * 4); b.paginasY = sab(capHash * 4); b.paginasSlot = sab(capHash * 4);
    b.celdaFlags = sab(celdas); b.celdaCrecimiento = sab(celdas * 8); b.celdaVegetacion = sab(celdas * 8);
    b.celdaHumedad = sab(celdas * 8); b.celdaAguaPotable = sab(celdas * 8); b.celdaTesela = sab(celdas * 4);
    b.celdaInicio = sab(celdas * 4); b.celdaCuenta = sab(celdas * 4); b.celdaOcupados = sab(celdas * 4);
    this.#capPaginas = capPaginas; this.#capHash = capHash;
    this.#sello = new Int32Array(capPaginas); this.#generacion = 0;
    this.#reasignaciones++;
    this.#disposicion = null;
  }

  #asignarAnimales(capTabla: number, capDue: number, capMemoria: number, capId: number): void {
    const b = this.#buffers;
    b.ocupantes = sab(capTabla * 4); b.tablaF64 = sab(capTabla * NTF * 8); b.tablaI32 = sab(capTabla * NTI * 4);
    b.dueF64 = sab(capDue * NDF * 8); b.dueI32 = sab(capDue * NDI * 4);
    b.memoriaF64 = sab(capDue * capMemoria * NMF * 8); b.memoriaVisitado = sab(capDue * capMemoria);
    b.idCaracteres = sab(capId * 2); b.salidaI32 = sab(capDue * NSO * 4);
    this.#capTabla = capTabla; this.#capDue = capDue; this.#capMemoria = capMemoria; this.#capId = capId;
    this.#reasignaciones++;
  }

  /** Disposición de páginas de `tiles` (orden de primera aparición, determinista): qué celda ocupa cada
   * tesela, la presencia de cada celda y la tesela de cada celda (la última con esas coordenadas). */
  #disponer(accessTiles: Tile[], token: ResidentTopologyToken | undefined): DisposicionTerreno {
    this.#reconstrucciones++;
    const tiles = residentBackingArray(accessTiles) as Tile[];
    const n = tiles.length;
    if (this.#xsBuf.length < n) {
      const cap = crecerCapacidad(this.#xsBuf.length, Math.max(256, n));
      this.#xsBuf = new Float64Array(cap);
      this.#ysBuf = new Float64Array(cap);
    }
    const xs = this.#xsBuf, ys = this.#ysBuf;
    const chunkInfo = token !== undefined ? verifiedChunkBlocks(accessTiles) : null;
    if (chunkInfo) {
      const paginas = chunkInfo.bases.size, capHash = siguientePotencia(Math.max(2, paginas * 2));
      if (paginas > this.#capPaginas || capHash > this.#capHash) this.#asignarTerreno(crecerCapacidad(this.#capPaginas, paginas), Math.max(capHash, this.#capHash));
      const b = this.#buffers;
      const flags = new Uint8Array(b.celdaFlags), tesela = new Int32Array(b.celdaTesela);
      const pagXArr = new Int32Array(paginas), pagYArr = new Int32Array(paginas);
      const pagXList: number[] = new Array(paginas), pagYList: number[] = new Array(paginas);
      let slot = 0;
      for (const base of chunkInfo.bases.values()) {
        const first = tiles[base]!, x0 = first.x, y0 = first.y, px = x0 >> 4, py = y0 >> 4;
        pagXArr[slot] = px; pagYArr[slot] = py;
        pagXList[slot] = px; pagYList[slot] = py;
        const dst = slot * CELDAS_POR_PAGINA;
        for (let k = 0; k < CELDAS_POR_PAGINA; k++) {
          const i = base + k;
          xs[i] = x0 + (k & 15);
          ys[i] = y0 + (k >> 4);
          tesela[dst + k] = i;
          flags[dst + k] = CELDA_PRESENTE;
        }
        slot++;
      }
      llenarTablaPaginas({ paginasSlot: new Int32Array(b.paginasSlot), paginasX: new Int32Array(b.paginasX), paginasY: new Int32Array(b.paginasY) }, pagXList, pagYList, capHash);
      this.#sello.fill(0); this.#generacion = 0;
      return { accessTiles, tiles, length: n, token, xs, ys, pagX: pagXArr, pagY: pagYArr, paginas, capHash };
    }
    const celdas = new Int32Array(n);
    const paginaDe = new Map<number, number>(), pagX: number[] = [], pagY: number[] = [];
    for (let i = 0; i < n; i++) {
      const tile = tiles[i];
      if (!tile || typeof tile !== 'object' || typeof tile.x !== 'number' || typeof tile.y !== 'number') throw new TypeError('Tesela inválida para el motor de fauna.');
      xs[i] = tile.x; ys[i] = tile.y;
      if (!paginable(tile.x) || !paginable(tile.y)) { celdas[i] = -1; continue; }
      const px = tile.x >> 4, py = tile.y >> 4, clave = clavePagina(px, py);
      let slot = paginaDe.get(clave);
      if (slot === undefined) { slot = pagX.length; paginaDe.set(clave, slot); pagX.push(px); pagY.push(py); }
      celdas[i] = slot * CELDAS_POR_PAGINA + ((tile.y & 15) << 4) + (tile.x & 15);
    }
    const paginas = pagX.length, capHash = siguientePotencia(Math.max(2, paginas * 2));
    if (paginas > this.#capPaginas || capHash > this.#capHash) this.#asignarTerreno(crecerCapacidad(this.#capPaginas, paginas), Math.max(capHash, this.#capHash));
    const b = this.#buffers;
    llenarTablaPaginas({ paginasSlot: new Int32Array(b.paginasSlot), paginasX: new Int32Array(b.paginasX), paginasY: new Int32Array(b.paginasY) }, pagX, pagY, capHash);
    const flags = new Uint8Array(b.celdaFlags), tesela = new Int32Array(b.celdaTesela);
    flags.fill(0, 0, paginas * CELDAS_POR_PAGINA); tesela.fill(-1, 0, paginas * CELDAS_POR_PAGINA);
    // La última tesela con esas coordenadas gana, como `tileLookup`.
    for (let i = 0; i < n; i++) { const celda = celdas[i]!; if (celda >= 0) { tesela[celda] = i; flags[celda] = CELDA_PRESENTE; } }
    this.#sello.fill(0); this.#generacion = 0;
    return { accessTiles, tiles, length: n, token, xs, ys, pagX: Int32Array.from(pagX), pagY: Int32Array.from(pagY), paginas, capHash };
  }

  /** Relee los valores de las teselas de la página `slot`. `false` si una cambió de coordenadas. */
  #releerPagina(
    d: DisposicionTerreno, vista: VistaFauna, slot: number,
    reader?: ResidentTileReader, fast?: ResidentFastAccess, trustedCoords = false, trustedResident = false,
  ): boolean {
    const tiles = d.tiles, { flags, crecimiento, vegetacion, humedad, aguaPotable, tesela } = vista;
    const baseCelda = slot * CELDAS_POR_PAGINA;
    if (reader && trustedCoords) {
      const rbase = reader.pageBase(d.pagX[slot]!, d.pagY[slot]!);
      if (rbase >= 0) {
        const stamps = reader.stampsArr, ver = reader.versionStamp;
        const tArr = reader.terrainArr, bArr = reader.biomeArr, gArr = reader.growthArr;
        const vArr = reader.vegetationArr, mArr = reader.moistureArr, dwArr = reader.drinkingWaterArr;
        const WATER = reader.TERRAIN_WATER, SHELTER = reader.TERRAIN_SHELTER, OCEAN = reader.BIOME_OCEAN;
        for (let off = 0; off < CELDAS_POR_PAGINA; off++) {
          const celda = baseCelda + off;
          const i = tesela[celda]!;
          if (i < 0) continue;
          const rcell = rbase + off;
          if (stamps[rcell] === ver) {
            const g = gArr[rcell]!, hasG = g === g, tc = tArr[rcell]!;
            flags[celda] = CELDA_PRESENTE | (tc === WATER ? CELDA_AGUA : 0) | (tc === SHELTER ? CELDA_REFUGIO : 0)
              | (bArr[rcell] === OCEAN ? CELDA_OCEANO : 0) | (hasG ? CELDA_CRECIMIENTO : 0);
            crecimiento[celda] = hasG ? g : 0;
            vegetacion[celda] = vArr[rcell]!;
            humedad[celda] = mArr[rcell]!;
            const dw = dwArr[rcell]!;
            aguaPotable[celda] = dw === dw ? dw : 0;
          } else {
            const tile = tiles[i];
            if (!tile) return false;
            const growth = tile.growth, conCrecimiento = growth !== undefined && growth !== null, terrain = tile.terrain;
            flags[celda] = CELDA_PRESENTE | (terrain === 'water' ? CELDA_AGUA : 0) | (terrain === 'shelter' ? CELDA_REFUGIO : 0)
              | (tile.biome === 'ocean' ? CELDA_OCEANO : 0) | (conCrecimiento ? CELDA_CRECIMIENTO : 0);
            crecimiento[celda] = conCrecimiento ? growth : 0;
            vegetacion[celda] = tile.vegetation;
            humedad[celda] = tile.moisture;
            aguaPotable[celda] = tile.drinkingWater ?? 0;
          }
        }
        return true;
      }
    }
    if (fast && trustedCoords) {
      const tArr = fast.terrainArr, bArr = fast.biomeArr, gArr = fast.growthArr;
      const vArr = fast.vegetationArr, mArr = fast.moistureArr, dwArr = fast.drinkingWaterArr;
      const WATER = fast.TERRAIN_WATER, SHELTER = fast.TERRAIN_SHELTER, OCEAN = fast.BIOME_OCEAN;
      for (let celda = baseCelda, fin = baseCelda + CELDAS_POR_PAGINA; celda < fin; celda++) {
        const i = tesela[celda]!;
        if (i < 0) continue;
        const tile = tiles[i];
        if (!tile) return false;
        const rcell = fast.cellOf(tile);
        if (rcell >= 0) {
          const g = gArr[rcell]!, hasG = g === g, tc = tArr[rcell]!;
          flags[celda] = CELDA_PRESENTE | (tc === WATER ? CELDA_AGUA : 0) | (tc === SHELTER ? CELDA_REFUGIO : 0)
            | (bArr[rcell] === OCEAN ? CELDA_OCEANO : 0) | (hasG ? CELDA_CRECIMIENTO : 0);
          crecimiento[celda] = hasG ? g : 0;
          vegetacion[celda] = vArr[rcell]!;
          humedad[celda] = mArr[rcell]!;
          const dw = dwArr[rcell]!;
          aguaPotable[celda] = dw === dw ? dw : 0;
        } else {
          const growth = tile.growth, conCrecimiento = growth !== undefined && growth !== null, terrain = tile.terrain;
          flags[celda] = CELDA_PRESENTE | (terrain === 'water' ? CELDA_AGUA : 0) | (terrain === 'shelter' ? CELDA_REFUGIO : 0)
            | (tile.biome === 'ocean' ? CELDA_OCEANO : 0) | (conCrecimiento ? CELDA_CRECIMIENTO : 0);
          crecimiento[celda] = conCrecimiento ? growth : 0;
          vegetacion[celda] = tile.vegetation;
          humedad[celda] = tile.moisture;
          aguaPotable[celda] = tile.drinkingWater ?? 0;
        }
      }
      return true;
    }
    for (let celda = baseCelda, fin = baseCelda + CELDAS_POR_PAGINA; celda < fin; celda++) {
      const i = tesela[celda]!;
      if (i < 0) continue;
      const tile = tiles[i];
      if (!tile || (!trustedCoords && (!Object.is(tile.x, d.xs[i]) || !Object.is(tile.y, d.ys[i])))) return false;
      const rcell = reader ? reader.cellAt(d.xs[i]!, d.ys[i]!) : -1;
      if (rcell >= 0 && reader) {
        const growth = reader.growth(rcell), conCrecimiento = growth !== undefined, tcode = reader.terrainCode(rcell);
        flags[celda] = CELDA_PRESENTE | (tcode === reader.TERRAIN_WATER ? CELDA_AGUA : 0) | (tcode === reader.TERRAIN_SHELTER ? CELDA_REFUGIO : 0)
          | (reader.biomeCode(rcell) === reader.BIOME_OCEAN ? CELDA_OCEANO : 0) | (conCrecimiento ? CELDA_CRECIMIENTO : 0);
        crecimiento[celda] = conCrecimiento ? growth : 0;
        vegetacion[celda] = reader.vegetation(rcell)!;
        humedad[celda] = reader.moisture(rcell)!;
        aguaPotable[celda] = reader.drinkingWater(rcell) ?? 0;
      } else if (!trustedResident || !copyResidentFaunaTile(
        tile, celda, flags, crecimiento, vegetacion, humedad, aguaPotable,
        CELDA_PRESENTE, CELDA_AGUA, CELDA_REFUGIO, CELDA_OCEANO, CELDA_CRECIMIENTO,
      )) {
        const growth = tile.growth, conCrecimiento = growth !== undefined && growth !== null, terrain = tile.terrain;
        flags[celda] = CELDA_PRESENTE | (terrain === 'water' ? CELDA_AGUA : 0) | (terrain === 'shelter' ? CELDA_REFUGIO : 0)
          | (tile.biome === 'ocean' ? CELDA_OCEANO : 0) | (conCrecimiento ? CELDA_CRECIMIENTO : 0);
        crecimiento[celda] = conCrecimiento ? growth : 0;
        vegetacion[celda] = tile.vegetation;
        humedad[celda] = tile.moisture;
        aguaPotable[celda] = tile.drinkingWater ?? 0;
      }
    }
    return true;
  }

  /** Sella y relee las páginas que toca la ventana de percepción de algún animal debido. V19/M: la de un animal
   * listo para criar se amplía al rombo del olor de pareja (`RADIO_PAREJA_FAUNA`), cuyos ocupantes también lee. */
  #releerVentanas(d: DisposicionTerreno, vista: VistaFauna, due: readonly Animal[], token: ResidentTopologyToken | undefined, listos?: ReadonlySet<Animal>): boolean {
    if (++this.#generacion === 0x7fffffff) { this.#sello.fill(0); this.#generacion = 1; }
    const sello = this.#sello, generacion = this.#generacion;
    const trustedCoords = d.token !== undefined && sameResidentTopology(d.token, token);
    const fast = token !== undefined ? residentFastAccess(d.accessTiles) : undefined;
    const reader = fast?.exact ?? residentTileReader(d.accessTiles);
    const trustedResident = !reader && !fast && token !== undefined;
    let releidas = 0;
    for (const a of due) {
      const ax = a.x, ay = a.y;
      if (!paginable(ax) || !paginable(ay)) throw new RangeError(`Animal ${a.id} con coordenadas no enteras.`);
      const vision = 2 + Math.floor(a.genes.perception * 4);
      const radio = listos?.has(a) && !(vision >= RADIO_PAREJA_FAUNA) ? RADIO_PAREJA_FAUNA : vision;
      // Radio no positivo o NaN: `localTiles` no ve nada (sólo puede recordar celdas lejanas, que no leen valores).
      if (!(radio >= 0)) continue;
      if (radio > RADIO_MAXIMO) throw new RangeError(`Animal ${a.id} con percepción fuera de rango.`);
      for (let py = (ay - radio) >> 4, py1 = (ay + radio) >> 4; py <= py1; py++) for (let px = (ax - radio) >> 4, px1 = (ax + radio) >> 4; px <= px1; px++) {
        const slot = buscarPagina(vista, px, py);
        if (slot < 0 || sello[slot] === generacion) continue;
        sello[slot] = generacion; releidas++;
        if (!this.#releerPagina(d, vista, slot, reader, fast, trustedCoords, trustedResident)) return false;
      }
    }
    this.#paginasReleidas = releidas;
    return true;
  }

  /** Rango canónico (orden de `id`, iguales con igual rango) de cada animal de `objetos`. */
  #rangos(mundo: readonly Animal[], objetos: readonly Animal[], rangos: Int32Array): void {
    // Vía rápida: `world.animals` en orden canónico estricto (lo deja así `mascaraFauna`), rango = posición.
    let ordenado = true;
    for (let i = 1; i < mundo.length; i++) if (!(mundo[i - 1]!.id < mundo[i]!.id)) { ordenado = false; break; }
    if (ordenado) {
      const posicion = new Map<Animal, number>();
      for (let i = 0; i < mundo.length; i++) posicion.set(mundo[i]!, i);
      let completo = true;
      for (let i = 0; i < objetos.length; i++) {
        const p = posicion.get(objetos[i]!);
        if (p === undefined) { completo = false; break; }
        rangos[i] = p;
      }
      if (completo) return;
    }
    // Vía general: rango denso por id (el `sort` por defecto compara unidades UTF-16, como `<`).
    const ids = [...new Set(objetos.map(a => a.id))].sort();
    const rango = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) rango.set(ids[i]!, i);
    for (let i = 0; i < objetos.length; i++) rangos[i] = rango.get(objetos[i]!.id)!;
  }

  /** Vuelca el paso en los SAB y reparte los animales debidos en bloques. */
  empaquetar(world: MundoFauna, due: readonly Animal[], state: EstadoLocalFauna, opciones: { bloque?: number } = {}): void {
    const bloque = opciones.bloque ?? BLOQUE_FAUNA;
    if (!Number.isSafeInteger(bloque) || bloque < 1) throw new RangeError('bloque debe ser un entero positivo.');
    if (new Set(due).size !== due.length) throw new Error('Animal repetido en la lista de decisiones.');

    // 1. Terreno: disposición en caché, con la invalidación de `tileLookup` (identidad y longitud del
    //    arreglo) más el certificado residente si lo hay; valores releídos sólo en las páginas que toca
    //    alguna ventana de percepción (fuera de ellas `choose` sólo pregunta si hay tesela).
    const tiles = world.tiles, token = residentTopologyToken(tiles);
    let d = this.#disposicion;
    if (!d || d.accessTiles !== tiles || d.length !== tiles.length || (d.token === undefined ? token !== undefined : !sameResidentTopology(d.token, token))) {
      d = this.#disposicion = this.#disponer(tiles, token);
    }
    // V19: con `encuentroFertil` la decisión lee, de cada vecino, si está listo para criar (sin leer su acción), y un
    // animal debido listo busca pareja en el rombo de `RADIO_PAREJA_FAUNA`.
    const leyes = paramsOf(world).fauna, encuentro = leyes?.encuentroFertil === true, reserva = leyes?.reservaReproductiva === true;
    const listos = encuentro ? new Set(due.filter(a => listoParaCriar(a, reserva))) : undefined;
    let vista = crearVistaFauna(this.#buffers, { ...this.#params, hashMask: d.capHash - 1 });
    if (!this.#releerVentanas(d, vista, due, token, listos)) {
      d = this.#disposicion = this.#disponer(tiles, token);
      vista = crearVistaFauna(this.#buffers, { ...this.#params, hashMask: d.capHash - 1 });
      if (!this.#releerVentanas(d, vista, due, token, listos)) throw new Error('Teselas mutadas durante el empaquetado de fauna.');
    }
    const celdasActivas = d.paginas * CELDAS_POR_PAGINA, sello = this.#sello, generacion = this.#generacion;
    /** La celda está en una página releída: sólo ahí puede haber celdas visibles. */
    const enVentana = (celda: number): boolean => celda >= 0 && sello[(celda / CELDAS_POR_PAGINA) | 0] === generacion;

    // 2. Ocupantes en CSR, tabla de animales y `counts`.
    let filas = 0;
    for (const lista of state.occupants.values()) filas += lista.length;
    let memoriaMax = MAX_MEMORIA_ANIMAL, caracteres = 0;
    for (const a of due) { if (a.memory.length > memoriaMax) memoriaMax = a.memory.length; caracteres += a.id.length; }
    if (filas > this.#capTabla || due.length > this.#capDue || memoriaMax > this.#capMemoria || caracteres > this.#capId) {
      this.#asignarAnimales(crecerCapacidad(this.#capTabla, filas), crecerCapacidad(this.#capDue, due.length),
        crecerCapacidad(this.#capMemoria, memoriaMax), crecerCapacidad(this.#capId, caracteres));
    }
    this.#params = {
      capTabla: this.#capTabla, capDue: this.#capDue, due: due.length, capMemoria: this.#capMemoria,
      hashMask: d.capHash - 1, seed: world.seed, tick: world.tick, ...(encuentro ? { encuentro: true } : {}),
    };
    vista = crearVistaFauna(this.#buffers, this.#params);
    vista.cuenta.fill(0, 0, celdasActivas); vista.ocupados.fill(0, 0, celdasActivas);
    const tabla = this.#tabla;
    tabla.length = filas;
    const capT = this.#capTabla, { tf, ti } = vista, xy = { x: 0, y: 0 };
    let fila = 0;
    for (const [clave, lista] of state.occupants) {
      // Una celda sin tesela, o fuera de toda ventana, nunca es visible: sus ocupantes no entran en `near`.
      const celda = coordenadasDeClave(clave, xy) ? celdaDe(vista, xy.x, xy.y) : -1;
      if (!enVentana(celda)) continue;
      vista.inicio[celda] = fila; vista.cuenta[celda] = lista.length;
      for (const a of lista) {
        tabla[fila] = a; vista.ocupantes[fila] = fila;
        tf[TF.x * capT + fila] = a.x; tf[TF.y * capT + fila] = a.y;
        tf[TF.carnivory * capT + fila] = a.genes.carnivory; tf[TF.health * capT + fila] = a.health;
        ti[TI.especie * capT + fila] = codigoEspecie(a.species);
        ti[TI.listo * capT + fila] = encuentro && listoParaCriar(a, reserva) ? 1 : 0;
        fila++;
      }
    }
    for (const [clave, n] of state.counts) {
      if (!coordenadasDeClave(clave, xy)) continue;
      const celda = celdaDe(vista, xy.x, xy.y);
      if (enVentana(celda)) vista.ocupados[celda] = n;
    }
    filas = fila; tabla.length = filas;

    // 3. Rangos canónicos de la tabla y de los animales debidos.
    const universo = filas + due.length, rangos = new Int32Array(universo), objetos = new Array<Animal>(universo);
    for (let i = 0; i < filas; i++) objetos[i] = tabla[i]!;
    for (let i = 0; i < due.length; i++) objetos[filas + i] = due[i]!;
    this.#rangos(world.animals, objetos, rangos);
    for (let i = 0; i < filas; i++) ti[TI.rango * capT + i] = rangos[i]!;

    // 4. Entradas de los animales debidos.
    const cap = this.#capDue, capM = this.#capMemoria, { df, di, mf, mv, id } = vista;
    let caracter = 0;
    for (let slot = 0; slot < due.length; slot++) {
      const a = due[slot]!;
      df[DF.x * cap + slot] = a.x; df[DF.y * cap + slot] = a.y;
      df[DF.hunger * cap + slot] = a.hunger; df[DF.thirst * cap + slot] = a.thirst;
      df[DF.energy * cap + slot] = a.energy; df[DF.fatigue * cap + slot] = a.fatigue;
      df[DF.perception * cap + slot] = a.genes.perception; df[DF.carnivory * cap + slot] = a.genes.carnivory;
      di[DI.especie * cap + slot] = codigoEspecie(a.species);
      di[DI.rango * cap + slot] = rangos[filas + slot]!;
      di[DI.listo * cap + slot] = encuentro && listoParaCriar(a, reserva) ? 1 : 0;
      di[DI.reposo * cap + slot] = encuentro && listoSalvoEnergia(a, reserva) ? 1 : 0;
      di[DI.memorias * cap + slot] = a.memory.length;
      di[DI.idInicio * cap + slot] = caracter; di[DI.idLongitud * cap + slot] = a.id.length;
      for (let k = 0; k < a.id.length; k++) id[caracter++] = a.id.charCodeAt(k);
      for (let k = 0; k < a.memory.length; k++) {
        const m = a.memory[k]!, o = (slot * capM + k) * NMF;
        mf[o + MF.x] = m.x; mf[o + MF.y] = m.y; mf[o + MF.tick] = m.tick; mf[o + MF.food] = m.food; mf[o + MF.water] = m.water;
        mv[slot * capM + k] = m.visited ? 1 : 0;
      }
    }

    const regiones: StaticRegion[] = [];
    for (let inicio = 0; inicio < due.length; inicio += bloque) regiones.push({ id: regiones.length, begin: inicio, end: Math.min(due.length, inicio + bloque) });
    this.#regiones = regiones;
    this.#due = due.length;
    this.#tiles = tiles;
  }
}

// ── Aplicación (serie, en el orden de `due`) ────────────────────────────────────────────

/** `waterAt` de `animals.ts`, literal. */
const aguaReal = (animal: Animal, tile: Tile): number => animal.species === 'fish' ? tile.moisture : tile.biome === 'ocean' ? 0 : tile.drinkingWater ?? 0;
/** `remember` de `animals.ts`, literal. */
function recordar(animal: Animal, tile: Tile, tick: number, visited: boolean): void {
  const existing = animal.memory.find(m => m.x === tile.x && m.y === tile.y);
  const here = cellXY(tile.x, tile.y);
  animal.memory = animal.memory.filter(m => cellXY(m.x, m.y) !== here && tick - m.tick <= MEMORIA_TTL);
  animal.memory.push({ x: tile.x, y: tile.y, tick, food: tile.growth ?? tile.vegetation, water: aguaReal(animal, tile), visited: visited || !!existing?.visited });
  if (animal.memory.length > MAX_MEMORIA_ANIMAL) animal.memory.shift();
}

/** Escribe en cada animal de `due` lo que `choose` le habría escrito, en el mismo orden de escritura. */
export function applyFaunaChooseOutputs(due: readonly Animal[], world: { tick: number; tiles: readonly Tile[] }, salidas: SalidasFauna): void {
  if (due.length !== salidas.due) throw new Error('Salidas de fauna de otro reparto.');
  if (world.tick !== salidas.tick || world.tiles !== salidas.tiles) throw new Error('Salidas de fauna de otro paso.');
  const { so, tabla, tiles, tick } = salidas;
  for (let slot = 0; slot < due.length; slot++) {
    const animal = due[slot]!, o = slot * NSO;
    const recuerdos = so[o + SO.recuerdos]!;
    if (recuerdos >= 1) recordar(animal, tiles[so[o + SO.recuerdo0Tesela]!]!, tick, so[o + SO.recuerdo0Visitado] === 1);
    if (recuerdos >= 2) recordar(animal, tiles[so[o + SO.recuerdo1Tesela]!]!, tick, so[o + SO.recuerdo1Visitado] === 1);
    const codigo = so[o + SO.accion]!, action = ACCIONES_FAUNA[codigo]!, tipo = so[o + SO.destinoTipo]!, ref = so[o + SO.destinoRef]!;
    const target: { x: number; y: number } = tipo === DESTINO_PROPIO || tipo === DESTINO_REPOSO ? animal : tipo === DESTINO_TESELA ? tiles[ref]!
      : tipo === DESTINO_RECUERDO ? animal.memory[ref] as AnimalMemory : tipo === DESTINO_PRESA || tipo === DESTINO_PAREJA ? tabla[ref]! : animal;
    const presa = so[o + SO.presa]!, preyId = presa >= 0 ? tabla[presa]!.id : null;
    if (animal.action !== action || animal.preyId !== preyId) animal.work = 0;
    animal.action = action; animal.target = { x: target.x, y: target.y }; animal.reason = tipo === DESTINO_PAREJA ? RAZON_PAREJA_FAUNA : tipo === DESTINO_REPOSO ? RAZON_REPOSO_CRIA_FAUNA : RAZONES_FAUNA[codigo]!; animal.preyId = preyId; animal.lastDecision = tick;
  }
}

// ── Piscina persistente ────────────────────────────────────────────────────────────────

export interface OpcionesFaunaPool {
  hilos: number;
  orden?: StaticRegionOrder;
  /** Espera física entre regiones en `adversarial` (ms). Por defecto 0. */
  retardoMs?: number;
  /** Reloj inyectado para medir la ruta de 1 hilo (este módulo no lee relojes). */
  reloj?: () => number;
  /** Fábrica de piscina (pruebas). */
  crearPool?: (workers: number) => StaticWorkerPool;
}

export interface DiagnosticoFauna {
  hilos: number;
  orden: StaticRegionOrder;
  despachos: number;
  regiones: number;
  decisiones: number;
  ocupacionWorkers: number;
  tiempoParaleloMs: number;
  tiempoBarreraMs: number;
  tiempoActivoWorkersMs: number[];
  piscina: StaticWorkerDiagnostics | null;
}

function urlWorker(): URL {
  const js = new URL('./fauna-worker.js', import.meta.url);
  return js.protocol === 'file:' && existsSync(fileURLToPath(js)) ? js : new URL('./fauna-worker.ts', import.meta.url);
}

/**
 * Piscina persistente de la decisión de fauna: los workers se crean una vez y se reutilizan en cada
 * `stepChoose`. Con `hilos = 1` no hay workers: la misma función corre en el hilo que llama.
 */
export class FaunaParallelPool {
  readonly #hilos: number;
  readonly #orden: StaticRegionOrder;
  readonly #retardoMs: number;
  readonly #reloj: (() => number) | undefined;
  readonly #pool: StaticWorkerPool | null;
  #despachos = 0;
  #regiones = 0;
  #decisiones = 0;
  #tiempoLocalMs = 0;
  #cerrada = false;

  constructor(opciones: OpcionesFaunaPool) {
    if (!Number.isSafeInteger(opciones.hilos) || opciones.hilos < 1) throw new RangeError('hilos debe ser un entero positivo.');
    this.#hilos = opciones.hilos;
    this.#orden = opciones.orden ?? 'natural';
    this.#retardoMs = opciones.retardoMs ?? 0;
    this.#reloj = opciones.reloj;
    this.#pool = this.#hilos === 1 ? null : (opciones.crearPool ?? (workers => new StaticWorkerPool({
      workers, moduleURL: urlWorker(), exportName: 'faunaChooseWorker',
    })))(this.#hilos);
  }

  get hilos(): number { return this.#hilos; }
  get orden(): StaticRegionOrder { return this.#orden; }

  /** `choose` de todos los animales debidos: escribe los buffers de salida de `estado`. Síncrono. */
  stepChoose(estado: EstadoFaunaCompartido): void {
    if (this.#cerrada) throw new Error('FaunaParallelPool cerrada.');
    const regiones = estado.regiones;
    this.#despachos++; this.#regiones = regiones.length; this.#decisiones = estado.due;
    if (!this.#pool) {
      // Misma función, mismo recorrido de colas que una piscina de 1 worker, sin hilos ni copia.
      const inicio = this.#reloj?.() ?? 0;
      ejecutarRegionesFauna(estado.vista(), partitionRegions(regiones, 1, this.#orden)[0]!);
      this.#tiempoLocalMs = this.#reloj ? Math.max(0, this.#reloj() - inicio) : 0;
      return;
    }
    if (!regiones.length) return;
    this.#pool.run({ regions: regiones, buffers: estado.buffers, params: estado.params, orden: this.#orden, retardoMs: this.#retardoMs });
  }

  diagnostics(): DiagnosticoFauna {
    const base = { hilos: this.#hilos, orden: this.#orden, despachos: this.#despachos, regiones: this.#regiones, decisiones: this.#decisiones };
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

const poolsFauna = new Map<string, FaunaParallelPool>();
let estadoFauna: EstadoFaunaCompartido | null = null;

/**
 * `for (const animal of due) choose(animal, world, state)` calculado en `hilos` workers: devuelve las
 * salidas sin tocar ningún animal; `applyFaunaChooseOutputs` las escribe. Piscina persistente por
 * `(hilos, orden)` y SAB compartidos entre llamadas.
 */
export function stepChooseParallel(world: MundoFauna, due: readonly Animal[], state: EstadoLocalFauna,
  hilos = 1, orden: StaticRegionOrder = 'natural'): SalidasFauna {
  const clave = `${hilos}:${orden}`;
  let pool = poolsFauna.get(clave);
  if (!pool) { pool = new FaunaParallelPool({ hilos, orden }); poolsFauna.set(clave, pool); }
  const estado = estadoFauna ??= new EstadoFaunaCompartido();
  estado.empaquetar(world, due, state);
  pool.stepChoose(estado);
  return estado.salidas();
}

/** Diagnóstico (pruebas): despachos a piscinas de fauna realizados desde que se crearon; 0 = nunca se usó la ruta paralela. */
export function despachosFaunaParalelos(): number {
  let total = 0;
  for (const pool of poolsFauna.values()) total += pool.diagnostics().despachos;
  return total;
}

/** Cierra todas las piscinas persistentes de la decisión de fauna (pruebas y apagado del servidor). */
export async function closeFaunaParallelPools(): Promise<void> {
  const pools = [...poolsFauna.values()];
  poolsFauna.clear();
  estadoFauna = null;
  await Promise.all(pools.map(pool => pool.close()));
}
