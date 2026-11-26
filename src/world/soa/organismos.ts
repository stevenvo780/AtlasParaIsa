import { crc32 } from 'node:zlib';
import { conCerrojo, ErrorFatalMotor } from '../paralelo/barrera.js';
import {
  COLUMNAS_FIJAS, REF_NULA, genDe, refDe, slotDe,
  type Clase, type Col, type FrenteEscritura, type FrentePublico, type Hilo, type Ref, type Slot,
  type TablaOrganismos, type TipoColumna,
} from '../motor/contratos.js';
import { IndiceUid, MAX_FILAS_INDICE_UID } from './indice-uid.js';

const MAX_GENERACION = 2 ** 21 - 1;
const RANURAS_REF = 2 ** 32;
const RESERVA_INICIAL = 16_384;
type Vectores = {
  f32: Float32Array<SharedArrayBuffer>; f64: Float64Array<SharedArrayBuffer>;
  i32: Int32Array<SharedArrayBuffer>; u16: Uint16Array<SharedArrayBuffer>; u8: Uint8Array<SharedArrayBuffer>;
};
type Vector<T extends TipoColumna = TipoColumna> = Vectores[T];
const VECTORES: { [T in TipoColumna]: {
  new (buffer: SharedArrayBuffer): Vector<T>; readonly BYTES_PER_ELEMENT: number;
} } = { f32: Float32Array, f64: Float64Array, i32: Int32Array, u16: Uint16Array, u8: Uint8Array };
interface SABCrece extends SharedArrayBuffer { readonly maxByteLength: number; grow(bytes: number): void }
const SAB = SharedArrayBuffer as unknown as new (bytes: number, opciones: { maxByteLength: number }) => SABCrece;

function reservarColumna<T extends TipoColumna>(tipo: T, ancho: number, filas = 0, reserva = RESERVA_INICIAL): Vector<T> {
  const Vector = VECTORES[tipo];
  const longitud = Math.min(RANURAS_REF, Math.max(reserva, filas * 2)) * ancho;
  return new Vector(new SAB(filas * ancho * Vector.BYTES_PER_ELEMENT, { maxByteLength: longitud * Vector.BYTES_PER_ELEMENT }));
}

function crecerColumna<T extends TipoColumna>(columna: Vector<T>, tipo: T, ancho: number, filas: number): Vector<T> {
  const buffer = columna.buffer as SABCrece, bytes = filas * ancho * columna.BYTES_PER_ELEMENT;
  if (buffer.byteLength >= bytes) return columna;
  if (bytes <= buffer.maxByteLength) { buffer.grow(bytes); return columna; }
  // Si se agotó la reserva virtual, se amplía el lado que ya tiene el escritor.
  const nueva = reservarColumna(tipo, ancho, filas);
  nueva.set(columna);
  return nueva;
}

type Lado = 0 | 1;

/** Para los hilos de cálculo: las columnas de los dos lados sobre SAB y el estado del frente publicado. Una columna que
 * agota su reserva virtual cambia de SAB, y el descriptor con ella (`TablaOrganismosSoA.compartir`). */
export interface FrenteCompartido {
  /** f64: [lado publicado, tick, alta]. */
  estado: SharedArrayBuffer;
  columnas: { nombre: string; tipo: TipoColumna; lados: [SharedArrayBuffer, SharedArrayBuffer] }[];
}
const ESTADO_LADO = 0, ESTADO_TICK = 1, ESTADO_ALTA = 2;

/** Filas de reserva virtual por columna cuando la tabla la escriben varios dueños. Un SAB no puede cambiarse por otro
 * con los workers en marcha (no viaja por un buzón), así que la reserva se fija al abrir la época: agotarla es fatal y la
 * recarga abre otra mayor (`motor/coordinador.ts` la dimensiona con el mundo que carga). No es memoria usada. */
export const RESERVA_FILAS_DUENOS = 2 ** 22;

/** La tabla entera para otro dueño: además del frente, el reparto de ranuras (altas, pila de libres y bajas del tick),
 * que con varios dueños vive en memoria compartida bajo un cerrojo. */
export interface TablaCompartida {
  frente: FrenteCompartido;
  formas: { ancho: number; unLado: boolean }[];
  control: SharedArrayBuffer;
  libres: SharedArrayBuffer;
  bajas: SharedArrayBuffer;
  indiceUid?: SharedArrayBuffer;
  sellos: SharedArrayBuffer | null;
  verificar: boolean;
}
const C_CERROJO = 0, C_ALTAS = 1, C_CAPACIDAD = 2, C_LIBRES = 3, C_BAJAS = 4, C_CELDAS = 5;
const pilaCompartida = (filas: number): SharedArrayBuffer => new SAB(0, { maxByteLength: filas * Int32Array.BYTES_PER_ELEMENT });
function apilar(pila: Int32Array, control: Int32Array, celda: number, valor: number): void {
  const n = control[celda]!;
  if (n >= pila.length) {
    const memoria = pila.buffer as SABCrece, bytes = Math.max(1024, 2 * n) * Int32Array.BYTES_PER_ELEMENT;
    if (bytes > memoria.maxByteLength && (n + 1) * 4 > memoria.maxByteLength) throw new ErrorFatalMotor('Tabla de organismos sin reserva de ranuras.');
    memoria.grow(Math.min(memoria.maxByteLength, bytes));
  }
  pila[n] = valor;
  control[celda] = n + 1;
}

function armarFrente(col: (nombre: string) => Col, columnas: readonly string[], tick: number, alta: number): FrentePublico {
  return Object.freeze({
    tick, alta, columnas, col,
    gen: col('gen'), vivo: col('vivo'), clase: col('clase'), uid: col('uid'), dueno: col('dueno'),
    x: col('x'), y: col('y'), chunk: col('chunk'), accion: col('accion'), objetivo: col('objetivo'),
    decideEn: col('decideEn'), cuerpo: col('cuerpo'), rasgos: col('rasgos'), genoma: col('genoma'), pareja: col('pareja'),
  });
}

function igualesHasta(a: Col, b: Col, filas: number): boolean {
  const bytes = filas * a.BYTES_PER_ELEMENT;
  return Buffer.from(a.buffer, a.byteOffset, bytes).equals(Buffer.from(b.buffer, b.byteOffset, bytes));
}

/** El frente publicado ahora mismo, leído desde otro hilo: `leer()` arma el del lado y el tick del estado compartido. */
export function conectarFrente(d: FrenteCompartido): { leer(): FrentePublico } {
  const estado = new Float64Array(d.estado), columnas = Object.freeze(d.columnas.map(c => c.nombre));
  const lados = [0, 1].map(lado => new Map(d.columnas.map(c => [c.nombre, new VECTORES[c.tipo](c.lados[lado as Lado]) as Col])));
  let ultimo: FrentePublico | undefined;
  return {
    leer() {
      const lado = estado[ESTADO_LADO]!, tick = estado[ESTADO_TICK]!, alta = estado[ESTADO_ALTA]!;
      if (ultimo && ultimo.tick === tick && ultimo.alta === alta && ultimo.gen === lados[lado]!.get('gen')) return ultimo;
      const col = (nombre: string): Col => {
        const c = lados[lado]!.get(nombre);
        if (!c) throw new Error(`Columna de organismos desconocida: ${nombre}.`);
        return c;
      };
      return ultimo = armarFrente(col, columnas, tick, alta);
    },
  };
}
/** `unLado`: un solo vector para los dos frentes (`lados[0] === lados[1]`). */
interface Campo { ancho: number; tipo: TipoColumna; lados: [Vector, Vector]; unLado: boolean }

/** El coordinador intercambia los frentes en F6, tras publicar todos sus dueños. Con un dueño, el reparto de ranuras
 * vive en este heap; con varios (`reservaFilas` al crearla, `conectar` en los demás), en memoria compartida. */
export class TablaOrganismosSoA implements TablaOrganismos {
  private readonly campos = new Map<string, Campo>();
  private altasLocal = 0;
  private capacidad: [number, number] = [0, 0];
  private lecturaActual: FrentePublico;
  private iniciado = false;
  private crc = 0;
  private readonly bajas: Slot[] = [];
  private readonly cuarentena: { tick: number; slot: Slot }[] = [];
  private primerRetiro = 0;
  private readonly libres: Slot[] = [];
  private escritoPor: Int32Array = new Int32Array(0);
  private readonly estado: Float64Array;
  /** Con varios dueños: control del reparto, pila de ranuras libres y bajas del tick. */
  private readonly ctl: Int32Array | null = null;
  private readonly pilaLibres: Int32Array | null = null;
  private readonly colaBajas: Int32Array | null = null;
  private readonly indiceUid?: IndiceUid;
  private refsLocales?: { frente: FrentePublico; refs: Map<number, Ref> };
  private readonly reserva: number;
  /** Hilo de esta copia de la tabla: 0 en el coordinador (y con un solo dueño), el del worker en las conectadas. */
  readonly hilo: Hilo;
  readonly verificar: boolean;

  constructor(verificar = false,
    opciones: { reservaFilas?: number; indiceUidCompartido?: boolean; compartida?: TablaCompartida; hilo?: Hilo } = {}) {
    const { compartida, indiceUidCompartido, reservaFilas } = opciones;
    this.verificar = compartida?.verificar ?? verificar;
    this.hilo = compartida ? opciones.hilo ?? 0 : 0;
    this.reserva = reservaFilas ?? RESERVA_INICIAL;
    if (compartida) {
      this.estado = new Float64Array(compartida.frente.estado);
      this.ctl = new Int32Array(compartida.control);
      this.pilaLibres = new Int32Array(compartida.libres);
      this.colaBajas = new Int32Array(compartida.bajas);
      if (compartida.indiceUid) this.indiceUid = new IndiceUid(compartida.indiceUid);
      if (compartida.sellos) this.escritoPor = new Int32Array(compartida.sellos);
      compartida.frente.columnas.forEach((c, i) => {
        const { ancho, unLado } = compartida.formas[i]!;
        this.campos.set(c.nombre, { ancho, tipo: c.tipo, unLado, lados: [new VECTORES[c.tipo](c.lados[0]), new VECTORES[c.tipo](c.lados[1])] });
      });
      this.iniciado = true;
    } else {
      this.estado = new Float64Array(new SharedArrayBuffer(3 * Float64Array.BYTES_PER_ELEMENT));
      if (reservaFilas !== undefined) {
        this.ctl = new Int32Array(new SharedArrayBuffer(C_CELDAS * Int32Array.BYTES_PER_ELEMENT));
        this.pilaLibres = new Int32Array(pilaCompartida(reservaFilas));
        this.colaBajas = new Int32Array(pilaCompartida(reservaFilas));
        if (indiceUidCompartido && Number.isSafeInteger(reservaFilas) && reservaFilas > 0 && reservaFilas <= MAX_FILAS_INDICE_UID)
          this.indiceUid = new IndiceUid(reservaFilas);
        if (this.verificar) this.escritoPor = new Int32Array(pilaCompartida(reservaFilas));
      }
      for (const [nombre, tipo, ancho] of COLUMNAS_FIJAS) this.declarar(nombre, tipo, ancho);
    }
    this.lecturaActual = this.frente(this.estado[ESTADO_TICK]!, this.estado[ESTADO_ALTA]!);
  }

  /** La misma tabla vista por el dueño `hilo` (un worker): escribe sus filas y da altas y bajas con su hilo. */
  static conectar(compartida: TablaCompartida, hilo: Hilo): TablaOrganismosSoA {
    return new TablaOrganismosSoA(compartida.verificar, { compartida, hilo });
  }

  /** ¿La escriben varios dueños? */
  get deDuenos(): boolean { return this.ctl !== null; }
  private get conectada(): boolean { return this.ctl !== null && this.hilo !== 0; }
  private get lado(): Lado { return this.estado[ESTADO_LADO] as Lado; }
  private get altas(): number { return this.ctl ? Atomics.load(this.ctl, C_ALTAS) : this.altasLocal; }

  /** El frente vigente; una copia conectada lo rearma cuando el coordinador publicó otro. */
  private get actual(): FrentePublico {
    const f = this.lecturaActual;
    if (this.conectada && (f.tick !== this.estado[ESTADO_TICK] || f.alta !== this.estado[ESTADO_ALTA]
      || f.gen !== this.campos.get('gen')!.lados[this.lado])) {
      this.lecturaActual = armarFrente(nombre => this.campo(nombre).lados[this.lado], Object.freeze([...this.campos.keys()]),
        this.estado[ESTADO_TICK]!, this.estado[ESTADO_ALTA]!);
    }
    return this.lecturaActual;
  }

  /**
   * Con `unLado`, la columna no tiene doble búfer: es una entrada del despacho que el dueño escribe en F2 y que solo leen
   * los percibidores dentro de ese despacho (el cerebro). Copiarla al publicar costaría su ancho por cada fila de la
   * tabla, también las de la fauna, y el sello CRC del frente no la cubre.
   */
  columna(nombre: string, tipo: TipoColumna, ancho: number, unLado = false): void {
    // Declarar otra vez la misma columna no cambia nada: así cada dueño arma sus piezas sobre la tabla que recibe.
    const previa = this.campos.get(nombre);
    if (previa && previa.tipo === tipo && previa.ancho === ancho && previa.unLado === unLado) return;
    if (this.iniciado || this.altas) throw new Error('Las columnas se declaran antes de arrancar la tabla de organismos.');
    this.declarar(nombre, tipo, ancho, unLado);
    this.lecturaActual = this.frente(this.lecturaActual.tick, 0);
  }

  lectura(): FrentePublico { return this.actual; }

  /** Identidad viva del frente publicado, aunque el dueño ya haya empezado a escribir el siguiente. */
  refPublicada(uid: number): Ref {
    const frente = this.actual;
    if (this.indiceUid) {
      const slot = this.indiceUid.ranuraDe(uid, frente.uid);
      return slot < 0 ? REF_NULA : refDe(slot, frente.gen[slot]!);
    }
    if (this.refsLocales?.frente !== frente) {
      const refs = new Map<number, Ref>(), { uid: uids, vivo, gen, alta } = frente;
      for (let slot = 0; slot < alta; slot++) if (vivo[slot]) refs.set(uids[slot]!, refDe(slot, gen[slot]!));
      this.refsLocales = { frente, refs };
    }
    return this.refsLocales.refs.get(uid) ?? REF_NULA;
  }

  /** Para repartirla entre dueños (solo si se creó con `reservaFilas`). */
  compartirTabla(): TablaCompartida {
    if (!this.ctl || this.conectada) throw new Error('Solo el coordinador comparte una tabla de varios dueños.');
    this.iniciado = true;
    return {
      frente: this.compartir(), formas: [...this.campos.values()].map(({ ancho, unLado }) => ({ ancho, unLado })),
      control: this.ctl.buffer as SharedArrayBuffer, libres: this.pilaLibres!.buffer as SharedArrayBuffer,
      bajas: this.colaBajas!.buffer as SharedArrayBuffer, indiceUid: this.indiceUid?.memoria,
      sellos: this.verificar ? this.escritoPor.buffer as SharedArrayBuffer : null, verificar: this.verificar,
    };
  }

  compartir(): FrenteCompartido {
    return { estado: this.estado.buffer as SharedArrayBuffer, columnas: [...this.campos].map(([nombre, { tipo, lados }]) =>
      ({ nombre, tipo, lados: [lados[0].buffer as SharedArrayBuffer, lados[1].buffer as SharedArrayBuffer] })) };
  }

  escritura(hilo: Hilo): FrenteEscritura {
    const lectura = this.actual, lado = this.siguiente;
    const vigente = (): void => {
      if (this.actual !== lectura) throw new Error('Escritura de otro tick del frente de organismos.');
    };
    const vector = <T extends TipoColumna>(nombre: string, tipo: T): Vector<T> => {
      vigente();
      return this.vector(nombre, lado, tipo);
    };
    return {
      fila: slot => {
        vigente();
        this.validarDueño(hilo, slot);
        if (this.verificar) this.escritoPor[slot] = hilo;
      },
      f32: nombre => vector(nombre, 'f32'),
      f64: nombre => vector(nombre, 'f64'),
      i32: nombre => vector(nombre, 'i32'),
      u16: nombre => vector(nombre, 'u16'),
      u8: nombre => vector(nombre, 'u8'),
    };
  }

  alta(hilo: Hilo, clase: Clase): Ref {
    if (!Number.isInteger(hilo) || hilo < 0 || hilo > 0x7fffffff) throw new RangeError('Hilo de alta inválido.');
    // Una copia conectada es de un solo dueño: quien la usa sin saber de hilos (la fauna) da de alta con el suyo.
    if (this.conectada) hilo = this.hilo;
    const lado = this.siguiente;
    const slot = this.ctl ? this.reservarCompartida() : this.reservarLocal(lado);
    const gen = this.vector('gen', lado, 'i32');
    const generacion = gen[slot] || 1;
    for (const { ancho, lados } of this.campos.values()) lados[lado].fill(0, slot * ancho, (slot + 1) * ancho);
    gen[slot] = generacion;
    this.vector('vivo', lado, 'u8')[slot] = 1;
    this.vector('clase', lado, 'u8')[slot] = clase;
    this.vector('dueno', lado, 'i32')[slot] = hilo;
    this.vector('chunk', lado, 'i32')[slot] = -1;
    this.vector('objetivo', lado, 'i32')[slot] = -1;
    this.vector('pareja', lado, 'f64')[slot] = -1;
    return refDe(slot, generacion);
  }

  private reservarLocal(lado: Lado): Slot {
    this.liberarCuarentena();
    const slot = this.libres.pop() ?? this.altasLocal;
    if (slot === this.altasLocal) {
      if (slot === RANURAS_REF) throw new RangeError('No quedan ranuras representables por Ref.');
      this.crecer(lado, slot + 1);
      this.altasLocal++;
      if (this.verificar && slot === this.escritoPor.length) {
        const sellos = new Int32Array(this.capacidad[lado]).fill(-1);
        sellos.set(this.escritoPor);
        this.escritoPor = sellos;
      }
    }
    return slot;
  }

  /** Con varios dueños: una ranura libre de la pila (las libera el coordinador al publicar) o una nueva, bajo cerrojo.
   * Los dos lados crecen a la vez y dentro de su reserva virtual, así que las vistas de los demás hilos siguen valiendo. */
  private reservarCompartida(): Slot {
    const ctl = this.ctl!;
    return conCerrojo(ctl, C_CERROJO, 'la tabla de organismos', () => {
      const libres = ctl[C_LIBRES]!;
      if (libres > 0) { ctl[C_LIBRES] = libres - 1; return this.pilaLibres![libres - 1]!; }
      const slot = ctl[C_ALTAS]!;
      this.crecerCompartida(slot + 1);
      Atomics.store(ctl, C_ALTAS, slot + 1);
      return slot;
    });
  }

  private crecerCompartida(filas: number): void {
    const ctl = this.ctl!, anterior = ctl[C_CAPACIDAD]!;
    if (filas <= anterior) return;
    if (filas > this.reservaCompartida()) throw new ErrorFatalMotor('Tabla de organismos sin reserva: la recarga abre una mayor.');
    const capacidad = Math.min(this.reservaCompartida(), Math.max(filas, 1024, Math.ceil(anterior * 1.25)));
    const crecer = (memoria: SABCrece, bytes: number): void => { if (memoria.byteLength < bytes) memoria.grow(bytes); };
    for (const { ancho, lados } of this.campos.values()) {
      for (const lado of lados) crecer(lado.buffer as SABCrece, capacidad * ancho * lado.BYTES_PER_ELEMENT);
    }
    if (this.verificar) {
      const antes = this.escritoPor.length;
      crecer(this.escritoPor.buffer as SABCrece, capacidad * Int32Array.BYTES_PER_ELEMENT);
      this.escritoPor.fill(-1, antes);
    }
    ctl[C_CAPACIDAD] = capacidad;
  }

  /** Filas que caben en la reserva virtual de la columna más estrecha (todas se reservaron con las mismas filas). */
  private reservaCompartida(): number {
    const gen = this.campos.get('gen')!.lados[0];
    return (gen.buffer as SABCrece).maxByteLength / gen.BYTES_PER_ELEMENT;
  }

  baja(hilo: Hilo, ref: Ref): void {
    if (this.conectada) hilo = this.hilo;
    const slot = slotDe(ref), lado = this.siguiente;
    this.validarDueño(hilo, slot);
    const gen = this.vector('gen', lado, 'i32'), vivo = this.vector('vivo', lado, 'u8');
    if (vivo[slot] !== 1 || gen[slot] !== genDe(ref)) throw new Error('Ref caducada al dar de baja un organismo.');
    vivo[slot] = 0;
    gen[slot] = Math.min(MAX_GENERACION, gen[slot]! + 1);
    if (this.ctl) conCerrojo(this.ctl, C_CERROJO, 'la tabla de organismos', () => apilar(this.colaBajas!, this.ctl!, C_BAJAS, slot));
    else this.bajas.push(slot);
    if (this.verificar) this.escritoPor[slot] = hilo;
  }

  /** Un organismo vivo cambia de dueño (migración): lo escribe quien lo cede, en F6, en el frente que se va a publicar.
   * El que lo recibe lo encuentra ya suyo en F1. */
  ceder(hilo: Hilo, ref: Ref, destino: Hilo): void {
    const slot = slotDe(ref), lado = this.siguiente;
    this.validarDueño(hilo, slot);
    if (this.vector('vivo', lado, 'u8')[slot] !== 1 || this.vector('gen', lado, 'i32')[slot] !== genDe(ref)) throw new Error('Ref caducada al ceder un organismo.');
    this.vector('dueno', lado, 'i32')[slot] = destino;
  }

  verificarFrente(): void {
    if (this.verificar && this.crc !== this.sello(this.lecturaActual)) {
      throw new Error('CRC32 del frente público de organismos cambió durante el tick.');
    }
  }

  publicar(tick: number): FrentePublico {
    if (this.conectada) throw new Error('Solo el coordinador publica el frente de organismos.');
    if (!Number.isSafeInteger(tick) || tick < this.lecturaActual.tick) throw new RangeError('Tick de frente inválido.');
    this.verificarFrente();
    const altas = this.altas;
    if (this.verificar) {
      const vivo = this.vector('vivo', this.siguiente, 'u8');
      for (let slot = 0; slot < altas; slot++) {
        if (vivo[slot] && this.escritoPor[slot] !== this.dueñoVigente(slot)) {
          throw new Error(`El dueño no selló la fila ${slot} al publicar el frente.`);
        }
      }
    }
    if (this.indiceUid) {
      // Los dueños están detenidos en la barrera. El índice describe el lado que se publica a continuación.
      const previo = this.lecturaActual, vivo = this.vector('vivo', this.siguiente, 'u8'), uid = this.vector('uid', this.siguiente, 'f64');
      if (altas !== previo.alta || !igualesHasta(previo.vivo, vivo, altas) || !igualesHasta(previo.uid, uid, altas)) {
        this.indiceUid.reconstruir(vivo, uid, altas);
      }
    }
    this.iniciado = true;
    const publicado = this.lecturaActual = this.frente(tick, altas, this.siguiente);
    if (this.verificar) {
      this.crc = this.sello(publicado);
      this.escritoPor.fill(-1);
    }
    if (this.ctl) {
      // Con todos los dueños detenidos en la barrera: sus bajas pasan a la cuarentena y lo cumplido, a la pila de libres.
      const ctl = this.ctl, n = ctl[C_BAJAS]!;
      for (let i = 0; i < n; i++) this.cuarentena.push({ tick: tick + 2, slot: this.colaBajas![i]! });
      ctl[C_BAJAS] = 0;
      this.liberarCuarentena();
      for (const slot of this.libres) apilar(this.pilaLibres!, ctl, C_LIBRES, slot);
      this.libres.length = 0;
    } else {
      for (const slot of this.bajas) this.cuarentena.push({ tick: tick + 2, slot });
      this.bajas.length = 0;
      this.crecer(this.siguiente, altas);
    }
    for (const { ancho, lados, unLado } of this.campos.values()) {
      if (!unLado) lados[this.siguiente].set(lados[this.lado].subarray(0, altas * ancho));
    }
    return publicado;
  }

  private get siguiente(): Lado { return this.lado === 0 ? 1 : 0; }

  private dueñoVigente(slot: Slot): Hilo {
    const actual = this.actual;
    return actual.vivo[slot] ? actual.dueno[slot]! : this.vector('dueno', this.siguiente, 'i32')[slot]!;
  }

  private validarDueño(hilo: Hilo, slot: Slot): void {
    // Una ranura que llega de `slotDe` es un double; como entero pequeño las lecturas de columna no desoptimizan.
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.altas || this.dueñoVigente(slot <= 0x3fffffff ? slot | 0 : slot) !== hilo) {
      throw new Error(`El hilo ${hilo} no es dueño de la fila ${slot}.`);
    }
  }

  private liberarCuarentena(): void {
    const gen = this.lecturaActual.gen, bajas = this.cuarentena;
    while (this.primerRetiro < bajas.length && bajas[this.primerRetiro]!.tick <= this.lecturaActual.tick) {
      const { slot } = bajas[this.primerRetiro++]!;
      if (gen[slot]! < MAX_GENERACION) this.libres.push(slot);
    }
    if (this.primerRetiro === bajas.length) {
      bajas.length = 0;
      this.primerRetiro = 0;
    } else if (this.primerRetiro > bajas.length / 2) {
      bajas.splice(0, this.primerRetiro);
      this.primerRetiro = 0;
    }
  }

  private declarar(nombre: string, tipo: TipoColumna, ancho: number, unLado = false): void {
    if (this.campos.has(nombre) || !Number.isSafeInteger(ancho) || ancho < 1) {
      throw new Error(`Columna de organismos inválida o duplicada: ${nombre}.`);
    }
    const primero = reservarColumna(tipo, ancho, 0, this.reserva);
    this.campos.set(nombre, { ancho, tipo, lados: [primero, unLado ? primero : reservarColumna(tipo, ancho, 0, this.reserva)], unLado });
  }

  private crecer(lado: Lado, filas: number): void {
    const anterior = this.capacidad[lado];
    if (filas <= anterior) return;
    const capacidad = Math.min(RANURAS_REF, Math.max(filas, Math.ceil(anterior * 1.25)));
    for (const campo of this.campos.values()) {
      const { ancho, lados, tipo } = campo;
      lados[lado] = crecerColumna(lados[lado], tipo, ancho, capacidad);
      if (campo.unLado) lados[lado === 0 ? 1 : 0] = lados[lado];
    }
    this.capacidad[lado] = capacidad;
  }

  private campo(nombre: string): Campo {
    const campo = this.campos.get(nombre);
    if (!campo) throw new Error(`Columna de organismos desconocida: ${nombre}.`);
    return campo;
  }

  private vector<T extends TipoColumna>(nombre: string, lado: Lado, tipo: T): Vector<T> {
    const campo = this.campo(nombre);
    if (campo.tipo !== tipo) throw new TypeError(`La columna ${nombre} es de tipo ${campo.tipo} y no de tipo ${tipo}.`);
    return campo.lados[lado] as Vector<T>;
  }

  private frente(tick: number, alta: number, lado: Lado = this.lado): FrentePublico {
    const col = (nombre: string): Col => this.campo(nombre).lados[lado];
    if (!this.conectada) { this.estado[ESTADO_LADO] = lado; this.estado[ESTADO_TICK] = tick; this.estado[ESTADO_ALTA] = alta; }
    return armarFrente(col, Object.freeze([...this.campos.keys()]), tick, alta);
  }

  private sello(frente: FrentePublico): number {
    let crc = 0;
    for (const [nombre, { ancho, unLado }] of this.campos) {
      if (unLado) continue;
      const col = frente.col(nombre);
      crc = crc32(new Uint8Array(col.buffer, col.byteOffset, frente.alta * ancho * col.BYTES_PER_ELEMENT), crc);
    }
    return crc;
  }
}
