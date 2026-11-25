import { ACTIONS, animalBiomass, SPECIES, type Animal } from '../animals.js';
import { CAMPOS_CUERPO, Clase, CUERPO_ANCHO, GENOMA_ANCHO, REF_NULA, slotDe, type FrenteEscritura, type FrentePublico, type Ref } from '../motor/contratos.js';
import type { VistaCuerpo } from '../materia/tipos.js';
import { TablaOrganismosSoA } from './organismos.js';

const ESPECIE = 'especie';

interface Fila { readonly slot: number; readonly ref: Ref; readonly uid: number; readonly animal: Animal }

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
  private readonly residentes = new Map<number, Fila>();
  readonly columnaEspecie: number;

  constructor(readonly tabla = new TablaOrganismosSoA(), private readonly uids: Uids = uidsLocales()) {
    this.tabla.columna(ESPECIE, 'u8', 1);
    this.columnaEspecie = this.tabla.lectura().columnas.indexOf(ESPECIE);
  }

  ref(animal: Animal): Ref { return this.filas.get(animal)?.ref ?? REF_NULA; }

  animal(slot: number): Animal | undefined { return this.residentes.get(slot)?.animal; }

  sincronizar(animales: readonly Animal[]): void {
    if (this.residentes.size === animales.length && animales.every(animal => this.filas.has(animal))) return;
    const vigentes = new Set(animales);
    for (const [slot, fila] of this.residentes) {
      if (vigentes.has(fila.animal)) continue;
      this.tabla.baja(0, fila.ref);
      this.filas.delete(fila.animal);
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
    const hambre = CAMPOS_CUERPO.hambre, sed = CAMPOS_CUERPO.sed, energia = CAMPOS_CUERPO.energia, salud = CAMPOS_CUERPO.salud;
    const masa = CAMPOS_CUERPO.masa;
    for (const fila of this.residentes.values()) {
      const slot = fila.slot, animal = fila.animal;
      w.fila(slot);
      uid[slot] = fila.uid;
      x[slot] = animal.x; y[slot] = animal.y;
      const actual = celda?.(animal.x, animal.y) ?? -1;
      chunk[slot] = actual < 0 ? -1 : chunkDe?.(actual) ?? -1;
      objetivo[slot] = celda?.(animal.target.x, animal.target.y) ?? -1;
      accion[slot] = ACTIONS.indexOf(animal.action);
      especie[slot] = SPECIES.indexOf(animal.species);
      decideEn[slot] = tick + 1;
      pareja[slot] = fertil?.(animal) ? 0 : -1;
      const base = slot * CUERPO_ANCHO;
      cuerpo[base + hambre] = animal.hunger;
      cuerpo[base + sed] = animal.thirst;
      cuerpo[base + energia] = animal.energy;
      cuerpo[base + salud] = animal.health;
      cuerpo[base + masa] = animalBiomass(animal);
      // Genoma: los seis genes y la morfología (o ceros), campo a campo, sin claves dinámicas por animal.
      const gen = slot * GENOMA_ANCHO, genes = animal.genes, morfologia = animal.morphology;
      genoma[gen] = genes.speed; genoma[gen + 1] = genes.perception; genoma[gen + 2] = genes.metabolism;
      genoma[gen + 3] = genes.carnivory; genoma[gen + 4] = genes.waterEfficiency; genoma[gen + 5] = genes.camouflage;
      genoma[gen + 6] = morfologia ? morfologia.caution : 0; genoma[gen + 7] = morfologia ? morfologia.size : 0;
      genoma[gen + 8] = morfologia ? morfologia.coat : 0; genoma[gen + 9] = morfologia ? morfologia.defense : 0;
    }
  }

  /** Con la tabla en verificación, cada publicación exige que el dueño selle todas sus filas vivas. */
  sellar(w: FrenteEscritura): void {
    for (const slot of this.residentes.keys()) w.fila(slot);
  }

  private alta(animal: Animal): void {
    const uid = animal.uid ??= this.uids();
    // `slotDe` divide un double: `| 0` deja la misma ranura como entero pequeño, y así las claves del mapa y los
    // índices de las columnas no hacen que V8 desoptimice cada escritura del frente.
    const ref = this.tabla.alta(0, Clase.Animal), s = slotDe(ref), slot = s <= 0x3fffffff ? s | 0 : s;
    const fila = { slot, ref, uid, animal };
    this.filas.set(animal, fila);
    this.residentes.set(slot, fila);
  }
}

// ── V23 (`v23.fauna`): filas de la fauna con cuerpo en el frente del motor ────────────────────────────────────

/** Columna que la ley de la fauna registra (`leyFauna.columnas`): lo que los demás leen de un animal para cazarlo,
 * ordeñarlo o evitarlo, además de las fijas. Sin columna de especie: la fauna V23 no la registra. */
export const COLUMNA_FAUNA = 'fauna';
export const CAMPOS_FAUNA = { miedo: 0, habituacion: 1, huella: 2, velocidad: 3 } as const;
export const FAUNA_ANCHO = 4;

export interface FilaFaunaV23 {
  slot: number; uid: number; x: number; y: number; chunk: number; objetivo: number; accion: number; tick: number;
  fertil: boolean; vista: VistaCuerpo; genoma: readonly number[];
  miedo: number; habituacion: number; huella: number; velocidad: number;
}

/** Escribe en F6 la fila de un animal propio en el frente t+1. Todos deciden en cada tick: `decideEn` = tick + 1.
 * `pareja` = 0 si es fértil (consiente con cualquiera compatible), −1 si no. */
export function escribirFilaFaunaV23(w: FrenteEscritura, f: FilaFaunaV23): void {
  const s = f.slot;
  w.fila(s);
  w.f64('uid')[s] = f.uid;
  w.f32('x')[s] = f.x; w.f32('y')[s] = f.y;
  w.i32('chunk')[s] = f.chunk; w.i32('objetivo')[s] = f.objetivo;
  w.u8('accion')[s] = f.accion < 0 ? 0 : f.accion;
  w.f64('decideEn')[s] = f.tick + 1;
  w.f64('pareja')[s] = f.fertil ? 0 : -1;
  const cuerpo = w.f32('cuerpo'), b = s * CUERPO_ANCHO, v = f.vista;
  cuerpo[b + CAMPOS_CUERPO.hambre] = v.hambre; cuerpo[b + CAMPOS_CUERPO.sed] = v.sed;
  cuerpo[b + CAMPOS_CUERPO.energia] = v.energia; cuerpo[b + CAMPOS_CUERPO.salud] = v.salud;
  cuerpo[b + CAMPOS_CUERPO.masa] = v.masa; cuerpo[b + CAMPOS_CUERPO.carga] = v.carga; cuerpo[b + CAMPOS_CUERPO.T] = v.T;
  const genoma = w.f32('genoma'), g = s * GENOMA_ANCHO;
  for (let k = 0; k < GENOMA_ANCHO; k++) genoma[g + k] = f.genoma[k] ?? 0;
  const fauna = w.f32(COLUMNA_FAUNA), q = s * FAUNA_ANCHO;
  fauna[q + CAMPOS_FAUNA.miedo] = f.miedo; fauna[q + CAMPOS_FAUNA.habituacion] = f.habituacion;
  fauna[q + CAMPOS_FAUNA.huella] = f.huella; fauna[q + CAMPOS_FAUNA.velocidad] = f.velocidad;
}
