import type { Tile } from '../../shared/types.js';

/** Certificados emitidos por interceptores, nunca por identidad/longitud solas. */
export interface ResidentTopologyToken { readonly array: object; readonly coordinates: object; }
export interface ResidentMutationObserver {
  before(): void;
  after(key: PropertyKey, descriptorChanged?: boolean): void;
}
interface ObservedTile {
  owner: ResidentTopologyOwner;
  observer?: ResidentMutationObserver;
  maintenance: number;
  opaque: Set<PropertyKey>;
  /** Escrituras lógicas observadas de ESTA tesela; monotónica y nunca drenada (v18). A diferencia de
   * `changedTiles`/`drainChangedTiles` —un canal con un solo consumidor que vacía al leer—, esta revisión
   * la pueden cotejar varios consumidores sin robarse eventos: cada uno recuerda la última que confirmó. */
  revision: number;
}
interface ObservedArray {
  owner: ResidentTopologyOwner;
  /** Backing plano privado del Proxy: solo para lecturas internas de solo lectura (`residentBackingArray`). */
  readonly target: readonly Tile[];
  revision: object;
  /** Cambia solo cuando se muta o borra una posición `< oldLength` (un `push` puro al final no la mueve). */
  inPlaceRevision: object;
  unsafe: Set<number>;
  length: number;
  observer?: () => void;
}
const observedTiles = new WeakMap<Tile, ObservedTile>();
const observedArrays = new WeakMap<Tile[], ObservedArray>();
const indexOf = (key: PropertyKey): number | null => {
  if (typeof key !== 'string' || key === '') return null;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 0xffffffff && String(index) === key ? index : null;
};
const sameDescriptor = (a: PropertyDescriptor | undefined, b: PropertyDescriptor | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  if (a.configurable !== b.configurable || a.enumerable !== b.enumerable) return false;
  if ('value' in a || 'value' in b) return 'value' in a && 'value' in b
    && Object.is(a.value, b.value) && a.writable === b.writable;
  return a.get === b.get && a.set === b.set;
};

/**
 * Constructor del anfitrión. Crea objetos NUEVOS antes de exponerlos: no cambia silenciosamente la
 * identidad de una tesela/array que ya pertenecía a un mundo. La identidad del resultado, sus claves,
 * su orden y sus valores (incluidos undefined y -0) se conservan durante toda su vida.
 *
 * El backing de cada Proxy se copia y queda privado. Así tampoco hay una referencia ordinaria que
 * pueda eludir defineProperty/delete/set. Una tesela ordinaria añadida al array mantiene SU identidad
 * y revoca el certificado: el consumidor vuelve al barrido genérico seguro. Los getters definidos
 * por terceros también lo revocan, pues sus valores pueden cambiar sin una escritura observable.
 * JSON/Object.keys/spread conservan la foto plana. structuredClone rechaza Proxy: las fronteras
 * durables/archivadas deben materializar { ...tile } y un array plano antes de clonarlo.
 *
 * Costes: tile O(campos), tiles O(teselas) al construir; mutación puntual O(1), reducción de length
 * O(índices retirados). El token estable es O(1). Esto no hace incremental la reconstrucción del SoA.
 */
export class ResidentTopologyOwner {
  private coordinates: object = {};
  private terrainRevision: object = {};
  private opaqueTiles = 0;
  /** Proxies con escrituras lógicas desde el último drenaje; Set conserva identidad, orden y O(tocados). */
  private readonly changedTiles = new Set<Tile>();

  tile(source: Tile): Tile {
    const target = { ...source }, state: ObservedTile = { owner: this, maintenance: 0, opaque: new Set(), revision: 0 };
    const owner = this;
    // Los traps no pueden ejecutarse durante `new Proxy`; después siempre registran la identidad pública.
    let tile!: Tile;
    const changed = (key: PropertyKey, reflection = false, descriptorChanged = reflection): void => {
      if (state.maintenance) return;
      if (key === 'x' || key === 'y') this.coordinates = {};
      if (key === 'terrain') this.terrainRevision = {};
      if (reflection) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key), wasOpaque = state.opaque.size > 0;
        if (descriptor && ('get' in descriptor || 'set' in descriptor)) state.opaque.add(key);
        else state.opaque.delete(key);
        const isOpaque = state.opaque.size > 0;
        if (isOpaque !== wasOpaque) this.opaqueTiles += isOpaque ? 1 : -1;
      }
      owner.changedTiles.add(tile);
      state.revision++;
      state.observer?.after(key, descriptorChanged);
    };
    const before = (): void => { if (!state.maintenance) state.observer?.before(); };
    tile = new Proxy(target, {
      set(object, key, value, receiver) {
        const previous = Reflect.getOwnPropertyDescriptor(object, key);
        before();
        // Los accessors SoA necesitan el Proxy como this (es la identidad pública del Tile).
        const accepted = Reflect.set(object, key, value, receiver);
        const current = Reflect.getOwnPropertyDescriptor(object, key);
        // Un accessor puede escribir su valor fuera del descriptor (los residentes lo hacen en SAB).
        // Si ambos descriptores faltan, un setter heredado puede haber hecho lo mismo.
        const descChanged = !sameDescriptor(previous, current);
        const externalSetter = accepted && (previous !== undefined && 'set' in previous && previous.set !== undefined
          || previous === undefined && current === undefined);
        if (accepted && (descChanged || externalSetter)) changed(key, false, descChanged || previous === undefined);
        return accepted;
      },
      defineProperty(object, key, descriptor) {
        const previous = Reflect.getOwnPropertyDescriptor(object, key);
        before(); const accepted = Reflect.defineProperty(object, key, descriptor);
        const current = Reflect.getOwnPropertyDescriptor(object, key);
        if (accepted && !sameDescriptor(previous, current)) changed(key, true, true);
        return accepted;
      },
      deleteProperty(object, key) {
        const previous = Reflect.getOwnPropertyDescriptor(object, key);
        before(); const accepted = Reflect.deleteProperty(object, key);
        if (accepted && previous !== undefined && Reflect.getOwnPropertyDescriptor(object, key) === undefined) changed(key, true, true);
        return accepted;
      },
      setPrototypeOf(object, prototype) {
        const previous = Reflect.getPrototypeOf(object);
        before(); const accepted = Reflect.setPrototypeOf(object, prototype);
        if (accepted && previous !== Reflect.getPrototypeOf(object)) {
          owner.invalidate(); owner.changedTiles.add(tile); state.revision++; state.observer?.after('x', true);
        }
        return accepted;
      },
      preventExtensions(object) {
        const previous = Reflect.isExtensible(object);
        before(); const accepted = Reflect.preventExtensions(object);
        if (accepted && previous && !Reflect.isExtensible(object)) { owner.changedTiles.add(tile); state.revision++; }
        return accepted;
      },
    });
    observedTiles.set(tile, state);
    return tile;
  }

  /** Cambios lógicos deduplicados desde la consulta anterior. No recorre el mundo. */
  drainChangedTiles(): Tile[] {
    const changed = [...this.changedTiles];
    this.changedTiles.clear();
    return changed;
  }

  tiles(source: readonly Tile[]): Tile[] {
    // No llama métodos sustituibles de source: el backing no puede escapar por un slice ajeno.
    const len = source.length;
    const target: Tile[] = new Array(len);
    const unsafe = new Set<number>();
    const prev = observedArrays.get(source as Tile[]);
    if (prev?.owner === this && prev.unsafe.size === 0) {
      const src = prev.target;
      for (let i = 0; i < len; i++) target[i] = src[i]!;
      return this.wrapArray(target, unsafe);
    }
    for (let i = 0; i < len; i++) {
      if (Object.hasOwn(source, i)) {
        const tile = source[i]!;
        target[i] = tile;
        if (observedTiles.get(tile)?.owner !== this) unsafe.add(i);
      } else {
        unsafe.add(i);
      }
    }
    return this.wrapArray(target, unsafe);
  }

  /** Subconjunto denso de bloques de `source` (p. ej. tras retirar chunks en `maintainRegions`):
   * si `source` pertenece a este owner sin huecos/inseguros, copia directo desde su backing privado
   * sin revalidar 440k `WeakMap.get`/`Object.hasOwn`, manteniendo 100 % la garantía fail-closed. */
  subsetBlocks(source: readonly Tile[], keptBases: readonly number[], blockLen: number): Tile[] {
    const prev = observedArrays.get(source as Tile[]);
    if (prev?.owner === this && prev.unsafe.size === 0 && Number.isInteger(blockLen) && blockLen > 0) {
      const src = prev.target, srcLen = src.length;
      const total = keptBases.length * blockLen;
      const target: Tile[] = new Array(total);
      let out = 0, valid = true;
      for (let b = 0; b < keptBases.length; b++) {
        const base = keptBases[b]!;
        if (!Number.isInteger(base) || base < 0 || base + blockLen > srcLen) { valid = false; break; }
        for (let i = 0; i < blockLen; i++) target[out++] = src[base + i]!;
      }
      if (valid) return this.wrapArray(target, new Set());
    }
    const flat: Tile[] = [];
    for (let b = 0; b < keptBases.length; b++) {
      const base = keptBases[b]!;
      for (let i = 0; i < blockLen; i++) flat.push(source[base + i]!);
    }
    return this.tiles(flat);
  }

  private wrapArray(target: Tile[], unsafe: Set<number>): Tile[] {
    const state: ObservedArray = {
      owner: this, target, revision: {}, inPlaceRevision: {}, unsafe, length: target.length,
    };
    const inspect = (index: number): void => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, String(index));
      if (descriptor && 'value' in descriptor && observedTiles.get(descriptor.value as Tile)?.owner === this)
        state.unsafe.delete(index);
      else state.unsafe.add(index);
    };
    const changed = (key: PropertyKey, oldLength: number): void => {
      if (key === 'length') {
        if (target.length < oldLength) state.inPlaceRevision = {};
        for (let i = target.length; i < oldLength; i++) state.unsafe.delete(i);
        for (let i = oldLength; i < target.length; i++) inspect(i);
      } else {
        const index = indexOf(key);
        if (index === null) return;
        if (index < oldLength) state.inPlaceRevision = {};
        for (let i = oldLength; i < target.length; i++) if (i !== index) inspect(i);
        inspect(index);
      }
      state.length = target.length; state.revision = {};
    };
    const owner = this;
    const tiles = new Proxy(target, {
      set(object, key, value, receiver) {
        state.observer?.(); const length = object.length;
        // Un setter ajeno debe recibir el Proxy, nunca el backing privado que eludiría sus traps.
        const accepted = Reflect.set(object, key, value, receiver);
        if (accepted) changed(key, length);
        return accepted;
      },
      defineProperty(object, key, descriptor) {
        state.observer?.(); const length = object.length;
        const accepted = Reflect.defineProperty(object, key, descriptor);
        if (accepted) changed(key, length);
        return accepted;
      },
      deleteProperty(object, key) {
        state.observer?.(); const length = object.length;
        const accepted = Reflect.deleteProperty(object, key);
        if (accepted) changed(key, length);
        return accepted;
      },
      setPrototypeOf(object, prototype) {
        state.observer?.(); const accepted = Reflect.setPrototypeOf(object, prototype);
        if (accepted) { owner.invalidate(); state.revision = {}; state.inPlaceRevision = {}; }
        return accepted;
      },
      preventExtensions(object) { state.observer?.(); return Reflect.preventExtensions(object); },
    });
    observedArrays.set(tiles, state);
    return tiles;
  }

  /** Réflexion/prototipo que no puede justificarse por interceptores: revoca permanentemente. */
  private invalidate(): void { this.opaqueTiles++; this.coordinates = {}; this.terrainRevision = {}; }
  /** Sólo la registry puede emitir un token; no acepta un booleano aportado por el consumidor. */
  token(state: ObservedArray): ResidentTopologyToken | undefined {
    return this.opaqueTiles === 0 && state.unsafe.size === 0
      ? { array: state.revision, coordinates: this.coordinates } : undefined;
  }
  /** Revisión de `terrain` bajo este owner; cambia ante cualquier escritura/reflexión sobre `terrain`. */
  terrainToken(): object { return this.terrainRevision; }
}

export function residentTopologyToken(tiles: Tile[]): ResidentTopologyToken | undefined {
  const state = observedArrays.get(tiles);
  return state?.owner.token(state);
}
export function residentTerrainRevision(tiles: Tile[]): object | undefined {
  const state = observedArrays.get(tiles);
  return state?.owner.token(state) ? state.owner.terrainToken() : undefined;
}
/** Revisión de escrituras/borrados en posiciones existentes (`< oldLength`); un `push` puro al final no la cambia. */
export function residentInPlaceRevision(tiles: Tile[]): object | undefined {
  const state = observedArrays.get(tiles);
  return state?.owner.token(state) ? state.inPlaceRevision : undefined;
}
/** Asociación emitida por registry; el contexto del mundo puede preceder a un reemplazo del array. */
export function residentTopologyOwner(tiles: Tile[]): ResidentTopologyOwner | undefined {
  return observedArrays.get(tiles)?.owner;
}
/** Backing plano de SOLO LECTURA de un array observado por `ResidentTopologyOwner` (el Proxy no tiene trap `get`,
 * así que `arr[i]` es semánticamente idéntico pero evita entrar en `ProxyGetProperty` de V8). NUNCA mutar el resultado. */
export function residentBackingArray(tiles: readonly Tile[]): readonly Tile[] {
  return observedArrays.get(tiles as Tile[])?.target ?? tiles;
}
/** Revisión monotónica de escrituras lógicas de una tesela observada (`undefined` si ningún owner la emitió).
 * Solo certifica «sin escrituras desde la revisión recordada» junto a un `ResidentTopologyToken` vigente del
 * array: sin token puede haber teselas opacas (getters ajenos) cuyos valores cambian sin escritura alguna.
 * No drena nada: `drainChangedTiles` conserva su único consumidor. Las operaciones de mantenimiento del SoA
 * residente (`maintainResidentTile`: ligar/desligar accesores materializando el MISMO valor) no la mueven;
 * el alta de una clave ausente al confirmar un paso paralelo la cubre el sello paralelo de `TileStore`. */
export function residentTileRevision(tile: Tile): number | undefined {
  return observedTiles.get(tile)?.revision;
}
export const sameResidentTopology = (a: ResidentTopologyToken | undefined, b: ResidentTopologyToken | undefined): boolean =>
  a !== undefined && b !== undefined && a.array === b.array && a.coordinates === b.coordinates;

/** Ganchos internos del SoA: interceptar reflexión/altas y mantener la exclusión de escritores. */
export function observeResidentTile(tile: Tile, observer: ResidentMutationObserver | undefined): void {
  const state = observedTiles.get(tile);
  if (state) state.observer = observer;
}
export function observeResidentArray(tiles: Tile[], before: (() => void) | undefined): void {
  const state = observedArrays.get(tiles);
  if (state) state.observer = before;
}
export function maintainResidentTile<T>(tile: Tile, operation: () => T): T {
  const state = observedTiles.get(tile);
  if (!state) return operation();
  state.maintenance++;
  try { return operation(); } finally { state.maintenance--; }
}
