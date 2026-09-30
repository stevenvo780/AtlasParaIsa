import type { Tile } from '../../shared/types.js';

/** Certificados emitidos por interceptores, nunca por identidad/longitud solas. */
export interface ResidentTopologyToken { readonly array: object; readonly coordinates: object; }
export interface ResidentMutationObserver {
  before(): void;
  after(key: PropertyKey): void;
}
interface ObservedTile {
  owner: ResidentTopologyOwner;
  observer?: ResidentMutationObserver;
  maintenance: number;
  opaque: Set<PropertyKey>;
}
interface ObservedArray {
  owner: ResidentTopologyOwner;
  revision: object;
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
  private opaqueTiles = 0;

  tile(source: Tile): Tile {
    const target = { ...source }, state: ObservedTile = { owner: this, maintenance: 0, opaque: new Set() };
    const changed = (key: PropertyKey, reflection = false): void => {
      if (state.maintenance) return;
      if (key === 'x' || key === 'y') this.coordinates = {};
      if (reflection) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key), wasOpaque = state.opaque.size > 0;
        if (descriptor && ('get' in descriptor || 'set' in descriptor)) state.opaque.add(key);
        else state.opaque.delete(key);
        const isOpaque = state.opaque.size > 0;
        if (isOpaque !== wasOpaque) this.opaqueTiles += isOpaque ? 1 : -1;
      }
      state.observer?.after(key);
    };
    const before = (): void => { if (!state.maintenance) state.observer?.before(); };
    const owner = this;
    const tile = new Proxy(target, {
      set(object, key, value, receiver) {
        before();
        // Los accessors SoA necesitan el Proxy como this (es la identidad pública del Tile).
        const accepted = Reflect.set(object, key, value, receiver);
        if (accepted) changed(key);
        return accepted;
      },
      defineProperty(object, key, descriptor) {
        before(); const accepted = Reflect.defineProperty(object, key, descriptor);
        if (accepted) changed(key, true);
        return accepted;
      },
      deleteProperty(object, key) {
        before(); const accepted = Reflect.deleteProperty(object, key);
        if (accepted) changed(key, true);
        return accepted;
      },
      setPrototypeOf(object, prototype) {
        before(); const accepted = Reflect.setPrototypeOf(object, prototype);
        if (accepted) { owner.invalidate(); state.observer?.after('x'); }
        return accepted;
      },
      preventExtensions(object) { before(); return Reflect.preventExtensions(object); },
    });
    observedTiles.set(tile, state);
    return tile;
  }

  tiles(source: readonly Tile[]): Tile[] {
    // No llama métodos sustituibles de source: el backing no puede escapar por un slice ajeno.
    const target: Tile[] = new Array(source.length);
    for (let i = 0; i < source.length; i++) if (Object.hasOwn(source, i)) target[i] = source[i]!;
    const state: ObservedArray = {
      owner: this, revision: {}, unsafe: new Set(), length: target.length,
    };
    const inspect = (index: number): void => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, String(index));
      if (descriptor && 'value' in descriptor && observedTiles.get(descriptor.value as Tile)?.owner === this)
        state.unsafe.delete(index);
      else state.unsafe.add(index);
    };
    for (let i = 0; i < target.length; i++) inspect(i);
    const changed = (key: PropertyKey, oldLength: number): void => {
      if (key === 'length') {
        for (let i = target.length; i < oldLength; i++) state.unsafe.delete(i);
        for (let i = oldLength; i < target.length; i++) inspect(i);
      } else {
        const index = indexOf(key);
        if (index === null) return;
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
        if (accepted) { owner.invalidate(); state.revision = {}; }
        return accepted;
      },
      preventExtensions(object) { state.observer?.(); return Reflect.preventExtensions(object); },
    });
    observedArrays.set(tiles, state);
    return tiles;
  }

  /** Réflexion/prototipo que no puede justificarse por interceptores: revoca permanentemente. */
  private invalidate(): void { this.opaqueTiles++; this.coordinates = {}; }
  /** Sólo la registry puede emitir un token; no acepta un booleano aportado por el consumidor. */
  token(state: ObservedArray): ResidentTopologyToken | undefined {
    return this.opaqueTiles === 0 && state.unsafe.size === 0
      ? { array: state.revision, coordinates: this.coordinates } : undefined;
  }
}

export function residentTopologyToken(tiles: Tile[]): ResidentTopologyToken | undefined {
  const state = observedArrays.get(tiles);
  return state?.owner.token(state);
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
