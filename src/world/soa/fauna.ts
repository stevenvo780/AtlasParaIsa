import { ACTIONS, animalBiomass, SPECIES, type Animal } from '../animals.js';
import { CAMPOS_CUERPO, Clase, CUERPO_ANCHO, GENOMA_ANCHO, REF_NULA, slotDe, type FrenteEscritura, type FrentePublico, type Ref } from '../motor/contratos.js';
import { TablaOrganismosSoA } from './organismos.js';

const ESPECIE = 'especie';
const GENES = ['speed', 'perception', 'metabolism', 'carnivory', 'waterEfficiency', 'camouflage'] as const;
const MORFOLOGIA = ['caution', 'size', 'coat', 'defense'] as const;

interface Fila { readonly slot: number; readonly ref: Ref; readonly uid: number }

/** El siguiente uid durable del mundo (`World.siguienteUid`): nunca se repite, tampoco tras guardar y cargar. */
export type Uids = () => number;
const uidsLocales = (): Uids => { let siguiente = 1; return () => siguiente++; };

/**
 * Fila de cada animal en la tabla de organismos. Con un solo dueño, el estado sigue en el objeto del animal y lo que
 * leen los demás es el frente que se publica al cerrar el tick. Enlazar las propiedades del objeto a columnas con
 * accesores pasaba los objetos de V8 a modo diccionario y triplicaba el coste de la fase de fauna, sin que nadie
 * leyera esas columnas. El uid vive en el animal (`Animal.uid`): vuelve con él del archivo, de un paso deshecho, de
 * un clon y de una carga, que reconstruyen la tabla.
 */
export class FaunaSoA {
  private readonly filas = new WeakMap<Animal, Fila>();
  private readonly residentes = new Map<number, Animal>();
  readonly columnaEspecie: number;

  constructor(readonly tabla = new TablaOrganismosSoA(), private readonly uids: Uids = uidsLocales()) {
    this.tabla.columna(ESPECIE, 'u8', 1);
    this.columnaEspecie = this.tabla.lectura().columnas.indexOf(ESPECIE);
  }

  ref(animal: Animal): Ref { return this.filas.get(animal)?.ref ?? REF_NULA; }

  animal(slot: number): Animal | undefined { return this.residentes.get(slot); }

  sincronizar(animales: readonly Animal[]): void {
    if (this.residentes.size === animales.length && animales.every(animal => this.filas.has(animal))) return;
    const vigentes = new Set(animales);
    for (const [slot, animal] of this.residentes) {
      if (vigentes.has(animal)) continue;
      this.tabla.baja(0, this.filas.get(animal)!.ref);
      this.filas.delete(animal);
      this.residentes.delete(slot);
    }
    for (const animal of animales) if (!this.filas.has(animal)) this.alta(animal);
  }

  publicar(tick: number, celda?: (x: number, y: number) => number, chunkDe?: (celda: number) => number,
    fertil?: (animal: Animal) => boolean): FrentePublico {
    this.escribir(this.tabla.escritura(0), tick, celda, chunkDe, fertil);
    return this.tabla.publicar(tick);
  }

  /** Las filas de la fauna en el frente que se va a publicar. */
  escribir(w: FrenteEscritura, tick: number, celda?: (x: number, y: number) => number, chunkDe?: (celda: number) => number,
    fertil?: (animal: Animal) => boolean): void {
    const uid = w.f64('uid'), x = w.f32('x'), y = w.f32('y'), chunk = w.i32('chunk'), objetivo = w.i32('objetivo');
    const cuerpo = w.f32('cuerpo'), genoma = w.f32('genoma'), accion = w.u8('accion'), especie = w.u8(ESPECIE);
    const decideEn = w.f64('decideEn'), pareja = w.f64('pareja');
    for (const [slot, animal] of this.residentes) {
      w.fila(slot);
      uid[slot] = this.filas.get(animal)!.uid;
      x[slot] = animal.x; y[slot] = animal.y;
      const actual = celda?.(animal.x, animal.y) ?? -1;
      chunk[slot] = actual < 0 ? -1 : chunkDe?.(actual) ?? -1;
      objetivo[slot] = celda?.(animal.target.x, animal.target.y) ?? -1;
      accion[slot] = ACTIONS.indexOf(animal.action);
      especie[slot] = SPECIES.indexOf(animal.species);
      decideEn[slot] = tick + 1;
      pareja[slot] = fertil?.(animal) ? 0 : -1;
      const base = slot * CUERPO_ANCHO;
      cuerpo[base + CAMPOS_CUERPO.hambre] = animal.hunger;
      cuerpo[base + CAMPOS_CUERPO.sed] = animal.thirst;
      cuerpo[base + CAMPOS_CUERPO.energia] = animal.energy;
      cuerpo[base + CAMPOS_CUERPO.salud] = animal.health;
      cuerpo[base + CAMPOS_CUERPO.masa] = animalBiomass(animal);
      let gen = slot * GENOMA_ANCHO;
      for (const campo of GENES) genoma[gen++] = animal.genes[campo];
      const morfologia = animal.morphology;
      for (const campo of MORFOLOGIA) genoma[gen++] = morfologia ? morfologia[campo] : 0;
    }
  }

  /** Con la tabla en verificación, cada publicación exige que el dueño selle todas sus filas vivas. */
  sellar(w: FrenteEscritura): void {
    for (const slot of this.residentes.keys()) w.fila(slot);
  }

  private alta(animal: Animal): void {
    const uid = animal.uid ??= this.uids();
    const ref = this.tabla.alta(0, Clase.Animal), slot = slotDe(ref);
    this.filas.set(animal, { slot, ref, uid });
    this.residentes.set(slot, animal);
  }
}
