/**
 * Arena de páginas del SoA de terreno (T112): un typed array por campo, sobre `SharedArrayBuffer` para
 * que los workers de T115 lean el mismo buffer sin copiarlo, con `perPage` elementos por ranura (256
 * para los campos de celda, 1 o 9 para los de página). Los campos se reservan al primer uso: el kernel
 * de ecología sólo toca presencia y `life`, y no paga el resto. Crecer reasigna y copia con un factor
 * pequeño (×1,25): los bytes medidos son los reservados de verdad, holgura incluida, y nunca pasan de
 * ~1,25 veces los usados. La capacidad no tiene tope: la pone la memoria del anfitrión (FR-013).
 */
export type Elements = Float64Array | Uint32Array | Int32Array | Uint8Array;
type Constructor<T extends Elements> = { new(buffer: SharedArrayBuffer): T; readonly BYTES_PER_ELEMENT: number };
interface Field { readonly make: Constructor<Elements>; readonly perPage: number; readonly fill: number; array: Elements; }

const GROWTH = 1.25;

export class PageArena {
  private readonly fields = new Map<string, Field>();
  private readonly free: number[] = [];
  /** Ranuras entregadas alguna vez (las libres están por debajo). */
  private highWater = 0;
  private pages = 0;
  /** Cambia cada vez que algún array cambia de identidad: quien guarde referencias debe renovarlas. */
  generation = 0;

  get capacity(): number { return this.pages; }
  get used(): number { return this.highWater - this.free.length; }
  get slots(): number { return this.highWater; }

  /** Array vigente del campo; lo reserva con la capacidad actual si es la primera vez. */
  field<T extends Elements>(name: string, make: Constructor<T>, perPage: number, fill = 0): T {
    let field = this.fields.get(name);
    if (!field) {
      field = { make, perPage, fill, array: allocate(make, this.pages * perPage, fill) };
      this.fields.set(name, field); this.generation++;
    } else if (field.make !== make || field.perPage !== perPage) throw new TypeError(`Campo SoA «${name}» redeclarado con otra forma.`);
    return field.array as T;
  }

  /** Una ranura libre; la arena crece si no queda ninguna. Sus valores son los que dejó el último uso:
   * la validez de una celda la decide la presencia, nunca el contenido. */
  reserve(): number {
    const reused = this.free.pop();
    if (reused !== undefined) return reused;
    if (this.highWater === this.pages) this.grow(Math.max(this.pages + 1, Math.ceil(this.pages * GROWTH)));
    return this.highWater++;
  }

  release(slot: number): void { this.free.push(slot); }

  /** Bytes reservados por todos los campos, holgura de crecimiento incluida. */
  get bytes(): number {
    let total = 0;
    for (const field of this.fields.values()) total += field.array.byteLength;
    return total;
  }

  private grow(pages: number): void {
    for (const field of this.fields.values()) {
      const next = allocate(field.make, pages * field.perPage, field.fill);
      next.set(field.array as never); field.array = next;
    }
    this.pages = pages; this.generation++;
  }
}

function allocate<T extends Elements>(make: Constructor<T>, length: number, fill: number): T {
  const array = new make(new SharedArrayBuffer(length * make.BYTES_PER_ELEMENT));
  if (fill !== 0) array.fill(fill);
  return array;
}
