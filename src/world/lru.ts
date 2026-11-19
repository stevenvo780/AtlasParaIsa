import type { Chunk } from './terrain.js';

/** Caché LRU acotada de terreno dormido (T163). Guarda la referencia recibida; quien
 * reanima (`activate`) clona antes de exponerla, así que la copia cacheada no se muta. */
export const DEFAULT_CHUNK_LRU_CAPACITY = 32;

export class ChunkLruCache {
  private readonly entries = new Map<string, Chunk>();
  constructor(readonly capacity: number = DEFAULT_CHUNK_LRU_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity < 0) throw new RangeError('Capacidad LRU de chunks inválida.');
  }
  get size(): number { return this.entries.size; }
  get(key: string): Chunk | undefined {
    const chunk = this.entries.get(key);
    if (chunk === undefined) return undefined;
    this.entries.delete(key); this.entries.set(key, chunk);
    return chunk;
  }
  set(chunk: Chunk): void {
    if (this.capacity === 0) return;
    this.entries.delete(chunk.key); this.entries.set(chunk.key, chunk);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }
  delete(key: string): boolean { return this.entries.delete(key); }
  clear(): void { this.entries.clear(); }
  /** Claves de menos a más recientemente usada. */
  keys(): string[] { return [...this.entries.keys()]; }
}

const caches = new WeakMap<object, ChunkLruCache>();
/** Una caché por mundo: una clave de chunk solo es inequívoca dentro de su mundo. */
export function chunkLruFor(owner: object, capacity = DEFAULT_CHUNK_LRU_CAPACITY): ChunkLruCache {
  let cache = caches.get(owner);
  if (!cache) { cache = new ChunkLruCache(capacity); caches.set(owner, cache); }
  return cache;
}
