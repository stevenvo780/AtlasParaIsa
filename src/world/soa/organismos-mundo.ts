import type { Animal } from '../animals.js';
import type { FrentePublico } from '../motor/contratos.js';
import { paramsOf } from '../params.js';
import { FaunaSoA, type Uids } from './fauna.js';
import { TablaOrganismosSoA } from './organismos.js';
import { PersonasSoA, type PersonaFrente } from './personas.js';

/** Lo que el registro necesita del mundo: su contador durable de uids y sus parámetros. */
export interface MundoOrganismos { siguienteUid?: number; params?: unknown }

/** Cómo escribir las filas de la fauna al publicar (las lee de la vista residente del terreno). */
export interface EscrituraFauna {
  celda?: (x: number, y: number) => number;
  chunkDe?: (celda: number) => number;
  fertil?: (animal: Animal) => boolean;
}

/**
 * La tabla común de organismos de un mundo: personas y fauna en las mismas ranuras, con un solo contador durable de uid
 * (`World.siguienteUid`, que se guarda con el mundo). Un clon o una carga reconstruyen la tabla, no los uid.
 */
export class OrganismosMundo {
  readonly tabla: TablaOrganismosSoA;
  readonly fauna: FaunaSoA;
  readonly personas: PersonasSoA;

  /** Con varios dueños, cada uno arma la suya sobre la tabla compartida que recibe (`tabla.hilo` es el suyo). */
  constructor(depuracion: boolean, uids: Uids, tabla = new TablaOrganismosSoA(depuracion)) {
    this.tabla = tabla;
    this.fauna = new FaunaSoA(this.tabla, uids);
    this.personas = new PersonasSoA(this.tabla, uids, tabla.hilo);
  }

  /** Las filas de este dueño en el frente que se va a publicar. Las de la clase que no se reescribe solo se sellan (modo
   * verificación). */
  escribir(tick: number, fauna?: EscrituraFauna, personas?: readonly PersonaFrente[]): void {
    const w = this.tabla.escritura(this.tabla.hilo);
    if (fauna) this.fauna.escribir(w, tick, fauna.celda, fauna.chunkDe, fauna.fertil);
    else if (this.tabla.verificar) this.fauna.sellar(w);
    if (personas) { this.personas.sincronizar(personas); this.personas.escribir(w); }
    else if (this.tabla.verificar) this.personas.sellar(w);
  }

  /** Publica el frente del tick (un solo dueño, o el coordinador cuando todos escribieron). */
  publicar(tick: number, fauna?: EscrituraFauna, personas?: readonly PersonaFrente[]): FrentePublico {
    this.escribir(tick, fauna, personas);
    return this.tabla.publicar(tick);
  }
}

const registros = new WeakMap<object, OrganismosMundo>();

export function organismosRegistrados(mundo: object): OrganismosMundo | undefined { return registros.get(mundo); }

export function organismosDe(mundo: MundoOrganismos): OrganismosMundo {
  let registro = registros.get(mundo);
  if (!registro) {
    registro = new OrganismosMundo(paramsOf(mundo as never).motor.depuracion, () => {
      const uid = mundo.siguienteUid ?? 1;
      mundo.siguienteUid = uid + 1;
      return uid;
    });
    registros.set(mundo, registro);
  }
  return registro;
}

/** El motor de dueños liga a la parte del mundo de cada dueño su tabla (la compartida, con su hilo). */
export function registrarOrganismos(mundo: object, registro: OrganismosMundo): void { registros.set(mundo, registro); }

/** Olvida la tabla del mundo: la siguiente se arma de cero (época nueva o columnas nuevas de una ley). Los uid no se
 * pierden: viven en cada persona y cada animal. */
export function olvidarOrganismos(mundo: object): void { registros.delete(mundo); }

export const faunaDe = (mundo: MundoOrganismos): FaunaSoA => organismosDe(mundo).fauna;
export const faunaRegistrada = (mundo: object): FaunaSoA | undefined => registros.get(mundo)?.fauna;
