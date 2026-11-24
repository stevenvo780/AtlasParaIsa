import type { Tile } from '../shared/types.js';

/**
 * Caché espacial LRU de teselas del cliente (V18, capa 2). Sin DOM.
 *
 * El servidor sigue siendo la única verdad: cada `state`/`delta` que llega SOBRESCRIBE lo guardado.
 * La caché sólo evita que el mapa quede en blanco mientras el servidor termina un paso (a 8 000+
 * habitantes, 0,6–3 s) y contesta a la cámara nueva: lo ya visitado se pinta al instante con la
 * última verdad conocida y el servidor lo repone enseguida.
 *
 * Estructura: trozos de 16×16 teselas indexados por `(x >> 4, y >> 4)`. Un `Map` de JavaScript
 * conserva el orden de inserción, de modo que «promover a más reciente» (borrar + insertar) y
 * «expulsar el menos reciente» (`keys().next()`) cuestan O(1).
 */
export const CHUNK_SHIFT = 4;
export const CHUNK_SIZE = 1 << CHUNK_SHIFT;
export const DEFAULT_MAX_CHUNKS = 256; // 256 × 256 = 65 536 teselas

interface CacheChunk {
  cx: number;
  cy: number;
  /** Último `tick` del servidor que tocó este trozo (diagnóstico; el último que llega manda). */
  tick: number;
  tiles: (Tile | undefined)[];
  count: number;
}

export interface ComposedViewport { tiles: Tile[]; coverage: number; }

/** Clave numérica única para (cx, cy); |cx|,|cy| < 2^20 cubre ±16 M de teselas. */
function chunkKey(cx: number, cy: number): number { return (cx + 1_048_576) * 2_097_152 + (cy + 1_048_576); }

export class ClientTileCache {
  private readonly chunks = new Map<number, CacheChunk>();
  /** Teselas guardadas ahora (suma de los trozos vivos). */
  private stored = 0;

  constructor(readonly maxChunks = DEFAULT_MAX_CHUNKS) {
    if (!Number.isInteger(maxChunks) || maxChunks < 1) throw new RangeError('maxChunks debe ser un entero ≥ 1.');
  }

  get chunkCount(): number { return this.chunks.size; }
  get tileCount(): number { return this.stored; }

  /** Claves `cx:cy` del menos al más reciente (para diagnóstico y pruebas). */
  chunkOrder(): string[] { return [...this.chunks.values()].map(chunk => `${chunk.cx}:${chunk.cy}`); }

  has(cx: number, cy: number): boolean { return this.chunks.has(chunkKey(cx, cy)); }

  /** Última tesela conocida en (x, y), sin alterar el orden LRU. */
  peek(x: number, y: number): Tile | undefined {
    const fx = Math.floor(x), fy = Math.floor(y);
    return this.chunks.get(chunkKey(fx >> CHUNK_SHIFT, fy >> CHUNK_SHIFT))?.tiles[(fy & (CHUNK_SIZE - 1)) * CHUNK_SIZE + (fx & (CHUNK_SIZE - 1))];
  }

  /** Guarda la verdad más reciente del servidor. Los trozos tocados pasan a ser los más recientes. */
  ingest(tiles: readonly Tile[], tick: number): void {
    if (!tiles.length) return;
    const touched = new Map<number, CacheChunk>();
    let last: CacheChunk | undefined;
    for (const tile of tiles) {
      const x = Math.floor(tile.x), y = Math.floor(tile.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const cx = x >> CHUNK_SHIFT, cy = y >> CHUNK_SHIFT;
      let chunk = last && last.cx === cx && last.cy === cy ? last : undefined;
      if (!chunk) {
        const key = chunkKey(cx, cy);
        chunk = this.chunks.get(key);
        if (!chunk) { chunk = { cx, cy, tick, tiles: new Array<Tile | undefined>(CHUNK_SIZE * CHUNK_SIZE), count: 0 }; this.chunks.set(key, chunk); }
        touched.set(key, chunk);
        last = chunk;
      }
      const slot = (y & (CHUNK_SIZE - 1)) * CHUNK_SIZE + (x & (CHUNK_SIZE - 1));
      if (!chunk.tiles[slot]) { chunk.count++; this.stored++; }
      chunk.tiles[slot] = tile;
      chunk.tick = tick;
    }
    for (const [key, chunk] of touched) { this.chunks.delete(key); this.chunks.set(key, chunk); }
    this.evict();
  }

  /**
   * Las teselas de la ventana `[originX, originX+width) × [originY, originY+height)` en orden de filas.
   * La verdad recién llegada (`liveTiles`) manda; el resto sale de la caché. `coverage` es la fracción
   * de celdas conocidas (0..1). Los trozos leídos pasan a ser los más recientes: lo que se mira no se expulsa.
   */
  composeViewport(originX: number, originY: number, width: number, height: number, liveTiles?: readonly Tile[]): ComposedViewport {
    const w = Math.max(0, Math.floor(width)), h = Math.max(0, Math.floor(height));
    const x0 = Math.floor(originX), y0 = Math.floor(originY);
    if (!w || !h) return { tiles: [], coverage: 1 };
    let live: Map<number, Tile> | null = null;
    if (liveTiles?.length) {
      live = new Map();
      for (const tile of liveTiles) {
        const x = Math.floor(tile.x) - x0, y = Math.floor(tile.y) - y0;
        if (x >= 0 && y >= 0 && x < w && y < h) live.set(y * w + x, tile);
      }
    }
    const out: Tile[] = [];
    const read = new Map<number, CacheChunk>();
    let last: CacheChunk | undefined;
    for (let y = y0; y < y0 + h; y++) {
      const cy = y >> CHUNK_SHIFT, row = (y & (CHUNK_SIZE - 1)) * CHUNK_SIZE;
      for (let x = x0; x < x0 + w; x++) {
        const fresh = live?.get((y - y0) * w + (x - x0));
        if (fresh) { out.push(fresh); continue; }
        const cx = x >> CHUNK_SHIFT;
        if (!last || last.cx !== cx || last.cy !== cy) {
          const key = chunkKey(cx, cy);
          last = this.chunks.get(key);
          if (last) read.set(key, last);
        }
        const tile = last?.tiles[row + (x & (CHUNK_SIZE - 1))];
        if (tile) out.push(tile);
      }
    }
    for (const [key, chunk] of read) { this.chunks.delete(key); this.chunks.set(key, chunk); }
    return { tiles: out, coverage: out.length / (w * h) };
  }

  /** Cierre de sesión o cambio de mundo: nada de lo guardado vale ya. */
  clear(): void { this.chunks.clear(); this.stored = 0; }

  private evict(): void {
    while (this.chunks.size > this.maxChunks) {
      const oldest = this.chunks.entries().next().value as [number, CacheChunk];
      this.chunks.delete(oldest[0]);
      this.stored -= oldest[1].count;
    }
  }
}
