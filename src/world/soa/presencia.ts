import { PageArena } from './arena.js';
import { PAGE_CELLS } from './region.js';

/**
 * Máscara de presencia del SoA de terreno (T112). Una celda está en el conjunto activo si y sólo si su
 * sello vale la versión vigente (`Uint32`, +1 en cada carga). Es obligatoria: `buildTopology` da `-1` a
 * todo vecino fuera del conjunto activo, y una página reservada puede tener celdas ausentes (chunks
 * parciales de los mundos antiguos) o valores rancios de su uso anterior; sin la máscara esas ranuras
 * contarían como vecinas vivas y cambiarían `livingNeighbors` en el borde del mundo activo.
 *
 * Con sellos, retirar teselas no cuesta nada (basta con no volver a sellarlas) y una ranura reusada no
 * hereda presencia: sus sellos son de versiones anteriores. Las páginas llevan su propio sello para
 * liberar, en O(páginas), las que una carga no volvió a tocar. Al agotar los 2^32 valores se borran los
 * sellos y se empieza de nuevo.
 */
export class Presence {
  private cells!: Uint32Array;
  private pages!: Uint32Array;
  private generation = -1;
  /** Versión del conjunto activo de celdas; ninguna carga usa el 0. */
  version = 0;

  constructor(private readonly arena: PageArena) { this.refresh(); }

  /** Renueva las referencias tras un crecimiento de la arena. */
  refresh(): void {
    if (this.generation === this.arena.generation) return;
    this.cells = this.arena.field('presence', Uint32Array, PAGE_CELLS);
    this.pages = this.arena.field('pagePresence', Uint32Array, 1);
    this.generation = this.arena.generation;
  }

  /** Abre una carga: todo lo sellado antes deja de estar presente. */
  next(): number {
    if (this.version === 0xffffffff) { this.refresh(); this.cells.fill(0); this.pages.fill(0); this.version = 0; }
    return ++this.version;
  }

  /** Sella la celda; `false` si ya estaba sellada en esta carga (coordenadas duplicadas). */
  mark(cell: number): boolean {
    if (this.cells[cell] === this.version) return false;
    this.cells[cell] = this.version; return true;
  }

  /** Sella la página; `true` sólo la primera vez en esta carga. */
  markPage(slot: number): boolean {
    if (this.pages[slot] === this.version) return false;
    this.pages[slot] = this.version; return true;
  }

  present(cell: number): boolean { return this.cells[cell] === this.version; }
  pagePresent(slot: number): boolean { return this.pages[slot] === this.version; }
  /** Sellos vigentes para el bucle caliente (se comparan con `version`). */
  get stamps(): Uint32Array { return this.cells; }
}
