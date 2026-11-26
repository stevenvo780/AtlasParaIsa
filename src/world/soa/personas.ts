import { CAMPOS_CUERPO, COLUMNAS_CEREBRO, CUERPO_ANCHO, Clase, REF_NULA, TIPO_CEREBRO, genDe, slotDe, type FrenteEscritura, type Ref } from '../motor/contratos.js';
import type { Uids } from './fauna.js';
import type { TablaOrganismosSoA } from './organismos.js';

/** Lo que el frente lleva de una persona. */
export interface PersonaFrente {
  readonly id: string; readonly x: number; readonly y: number;
  readonly hunger: number; readonly thirst: number; readonly energy: number; readonly decisionAt: number;
  uid?: number;
}

interface Fila { readonly ref: Ref; readonly uid: number }

/** Columnas del cerebro (contrato §3.4): entradas del despacho de F2, sin doble búfer. */
export const COLUMNAS_CEREBRO_FRENTE = [
  ['observacion', COLUMNAS_CEREBRO.observacion], ['politica', COLUMNAS_CEREBRO.politica], ['sesgo', COLUMNAS_CEREBRO.sesgo],
] as const;

/**
 * Fila de cada persona en la tabla común de organismos, como `FaunaSoA` con los animales: el estado sigue en el objeto
 * y el frente lleva lo que leen los percibidores. Una persona que sale del mundo da de baja su fila (su `gen` sube y la
 * ranura pasa la cuarentena de la tabla), así que la ranura que reciba otra persona o un animal nunca conserva su `Ref`,
 * su cerebro ni su percepción. `pesosGen` guarda en qué `gen` se escribieron los pesos de cada ranura.
 */
export class PersonasSoA<P extends PersonaFrente = PersonaFrente> {
  private readonly filas = new WeakMap<P, Fila>();
  private readonly residentes = new Map<number, P>();
  private pendientesPesos?: Set<number>;
  private pesosGen = new Int32Array(0);

  /** `hilo`: el dueño que escribe estas filas (0 con un solo dueño). */
  constructor(readonly tabla: TablaOrganismosSoA, private readonly uids: Uids, private readonly hilo = 0) {
    for (const [nombre, ancho] of COLUMNAS_CEREBRO_FRENTE) tabla.columna(nombre, TIPO_CEREBRO, ancho, true);
    tabla.columna('revisionPolitica', 'i32', 1, true);
  }

  slot(persona: P): number { const fila = this.filas.get(persona); return fila ? slotDe(fila.ref) : -1; }
  ref(persona: P): Ref { return this.filas.get(persona)?.ref ?? REF_NULA; }
  persona(slot: number): P | undefined { return this.residentes.get(slot); }
  get ranuras(): IterableIterator<number> { return this.residentes.keys(); }
  get ranurasSinPesos(): IterableIterator<number> {
    // La primera petición llega al activar la política. Los mundos sin ella no mantienen la cola.
    if (!this.pendientesPesos) {
      const { gen } = this.tabla.lectura();
      this.pendientesPesos = new Set();
      for (const slot of this.residentes.keys()) {
        if (!this.pesosAlDia(slot, gen[slot]!)) this.pendientesPesos.add(slot);
      }
    }
    return this.pendientesPesos.values();
  }
  /** Las personas de este dueño por ranura (`CtxDueno.personas`). */
  get mapa(): ReadonlyMap<number, P> { return this.residentes; }

  pesosAlDia(slot: number, gen: number): boolean { return this.pesosGen[slot] === gen; }

  marcarPesosPublicados(slot: number, gen: number): void {
    this.pesosGen[slot] = gen;
    this.pendientesPesos?.delete(slot);
  }

  private prepararPublicacionPesos(slot: number): void {
    if (slot >= this.pesosGen.length) {
      const pesos = new Int32Array(Math.max(16, 2 * slot));
      pesos.set(this.pesosGen);
      this.pesosGen = pesos;
    }
    this.pesosGen[slot] = 0;
    this.pendientesPesos?.add(slot);
  }

  /** Alta de una persona en el momento (una cría, en F4–F5): su fila existe desde ya y `sincronizar` no la repite. */
  registrar(persona: P): Ref {
    const previa = this.filas.get(persona);
    if (previa) return previa.ref;
    const uid = persona.uid ??= this.uids();
    const ref = this.tabla.alta(this.hilo, Clase.Persona), slot = slotDe(ref);
    this.filas.set(persona, { ref, uid });
    this.residentes.set(slot, persona);
    this.prepararPublicacionPesos(slot);
    return ref;
  }

  /** Baja en el momento de la persona de `ref` (murió): devuelve si era de aquí. */
  retirar(ref: Ref): boolean {
    const slot = slotDe(ref), persona = this.residentes.get(slot);
    if (!persona || this.filas.get(persona)!.ref !== ref) return false;
    this.tabla.baja(this.hilo, ref);
    this.filas.delete(persona);
    this.residentes.delete(slot);
    this.pendientesPesos?.delete(slot);
    return true;
  }

  /** Migración: la persona deja este dueño sin dejar de vivir (su fila sigue; `TablaOrganismosSoA.ceder` cambia el dueño). */
  soltar(persona: P): Ref {
    const fila = this.filas.get(persona);
    if (!fila) return REF_NULA;
    this.filas.delete(persona);
    const slot = slotDe(fila.ref);
    this.residentes.delete(slot);
    this.pendientesPesos?.delete(slot);
    return fila.ref;
  }

  /** Migración: la persona llega con la fila que ya tenía. Los pesos del cerebro se reescriben (otra copia de la tabla). */
  adoptar(persona: P, ref: Ref): void {
    const slot = slotDe(ref);
    this.filas.set(persona, { ref, uid: persona.uid ??= this.uids() });
    this.residentes.set(slot, persona);
    this.prepararPublicacionPesos(slot);
  }

  /** Altas y bajas para que la tabla lleve exactamente a `personas`. Devuelve si hubo alguna. */
  sincronizar(personas: readonly P[]): boolean {
    if (this.residentes.size === personas.length && personas.every(p => this.filas.has(p))) return false;
    const vigentes = new Set(personas);
    for (const [slot, persona] of this.residentes) {
      if (vigentes.has(persona)) continue;
      this.tabla.baja(this.hilo, this.filas.get(persona)!.ref);
      this.filas.delete(persona);
      this.residentes.delete(slot);
      this.pendientesPesos?.delete(slot);
    }
    for (const persona of personas) this.registrar(persona);
    return true;
  }

  /** ¿Lleva ya el frente publicado a cada persona donde está ahora? */
  alDia(personas: readonly P[]): boolean {
    const frente = this.tabla.lectura();
    if (this.residentes.size !== personas.length) return false;
    for (const p of personas) {
      const fila = this.filas.get(p);
      if (!fila) return false;
      const s = slotDe(fila.ref);
      if (s >= frente.alta || frente.gen[s] !== genDe(fila.ref) || frente.x[s] !== p.x || frente.y[s] !== p.y) return false;
    }
    return true;
  }

  escribir(w: FrenteEscritura): void {
    const uid = w.f64('uid'), x = w.f32('x'), y = w.f32('y'), cuerpo = w.f32('cuerpo'), decideEn = w.f64('decideEn');
    for (const [slot, p] of this.residentes) {
      w.fila(slot);
      uid[slot] = this.filas.get(p)!.uid;
      x[slot] = p.x; y[slot] = p.y;
      const base = slot * CUERPO_ANCHO;
      cuerpo[base + CAMPOS_CUERPO.hambre] = p.hunger; cuerpo[base + CAMPOS_CUERPO.sed] = p.thirst;
      cuerpo[base + CAMPOS_CUERPO.energia] = p.energy;
      decideEn[slot] = p.decisionAt;
    }
  }

  sellar(w: FrenteEscritura): void {
    for (const slot of this.residentes.keys()) w.fila(slot);
  }
}
